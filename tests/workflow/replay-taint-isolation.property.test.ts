import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { attachHostCallHandler, type ChildSpawner } from "../../src/workflow/host.js";
import { buildReplayIndex } from "../../src/workflow/replay.js";
import type { HostCallEnvelope, JournalEntry, ReplayScope, WorkflowChildSummary } from "../../src/workflow/types.js";

/**
 * replay-verify-plan v2.1 §6 P2 test 16 / D8: this file is the acceptance
 * addition alongside `replay-taint.property.test.ts` (kept untouched — its
 * own seeded property covers plain experts-taint safety with zero
 * isolation calls in the plan) covering the THREE D8 claims that file never
 * exercises at all:
 *
 *  1. **Chain scope, the isoId-fold/experts-taint interaction**: an accepted
 *     isolated call in chain scope is no longer itself a taint source (D6 —
 *     it folds instead); but once the chain IS tainted by an earlier
 *     *experts* call, a later isolated call still gets `skip:chain_tainted`
 *     (never journaled) and — per D8's "unified I3 rule" — still performs
 *     its F2 fold (harmless, since nothing downstream can be journaled in
 *     this run past the taint point anyway, but it keeps the code on a
 *     single path). A call that declares BOTH `experts` and `isolation`
 *     still taints via the (unchanged) experts rule and still folds once
 *     resolution succeeds — the two mechanisms are independent and both
 *     apply.
 *  2. **Content scope still taints**: D9/D6.4 — off the chain-fold path
 *     entirely, an accepted isolated call in content scope taints exactly
 *     like before D6 ever existed.
 *  3. **Experts rules are unchanged**: the existing seeded property in
 *     `replay-taint.property.test.ts` (P2/P3, C#25) covers taint-then-no-
 *     replay/no-journal safety with plans that never use `isolation`. Here
 *     we re-run the same shape of check with isolation calls interleaved
 *     into the plan and confirm experts-taint semantics (which step taints,
 *     what happens after) are byte-identical to the no-isolation case.
 */

function fakeWorkerHost() {
  const hostCall: Array<(e: HostCallEnvelope) => void> = [];
  const sent: Array<Record<string, unknown>> = [];
  const workerHost = {
    events: {
      onHostCall: (cb: (e: HostCallEnvelope) => void) => hostCall.push(cb),
      onPhase: () => {},
      onTerminating: () => {},
    },
    send: (m: Record<string, unknown>) => sent.push(m),
  } as unknown as Parameters<typeof attachHostCallHandler>[0]["workerHost"];
  return {
    workerHost,
    sent,
    call: (id: string, args: unknown) => hostCall.forEach((cb) => cb({ id, op: "agent", args })),
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
async function settle(n = 8): Promise<void> {
  for (let i = 0; i < n; i += 1) await tick();
}

type Step = { readonly prompt: string; readonly experts?: boolean; readonly isolation?: "worktree" };

interface RunResult {
  readonly appended: JournalEntry[];
  readonly settleLog: Array<{ step: number; source: WorkflowChildSummary["source"]; status: string }>;
  readonly tainted: boolean;
  readonly freshFolds: number;
  readonly skippedByReason: number;
}

/**
 * Same shape as `replay-taint.property.test.ts`'s own `runPlan`, extended
 * with `scope`/`isolationReplay` so `Step.isolation` actually goes through
 * the D6/D8 fold-vs-taint machinery. Deliberately no `awaitWorktree` port on
 * the spawner: `awaitWorktreeSafe` degrades that to `{state:"none"}`
 * (host.ts:469), which `replayableWorktree` always treats as "never
 * journal" (D3's table) — exactly what this file needs, since it is testing
 * taint/fold bookkeeping, not the worktree-commit replay path itself (that
 * is `host-replay-verify.test.ts`'s job).
 */
async function runPlan(
  plan: readonly Step[],
  succeedFlags: readonly boolean[],
  indexEntries: readonly JournalEntry[],
  scope: ReplayScope = "chain",
): Promise<RunResult> {
  const clock = new FakeClock();
  const w = fakeWorkerHost();
  const appended: JournalEntry[] = [];
  const settleLog: RunResult["settleLog"] = [];
  let expertCallSeq = 0;
  const spawner: ChildSpawner = {
    spawn: async (req) => ({ runId: `r-${req.prompt}` }),
    abort: async () => true,
    waitAll: async ({ runIds }) => ({
      settled: runIds.map((runId) => ({ runId, status: "completed" as const, text: runId })),
      pending: [],
    }),
    configHashOf: () => "hash",
    worktreeAvailable: () => true,
    resolveExperts: (handles) => {
      const idx = expertCallSeq;
      expertCallSeq += 1;
      if (!succeedFlags[idx]) return { error: { message: "expert not found" } };
      return {
        refs: handles.map((_h, i) => ({ runId: `expert-${idx}-${i}`, sessionFile: "/tmp/x.jsonl", agentType: "gp" })),
      };
    },
  };
  const index = buildReplayIndex(indexEntries, 0, scope);
  const handler = attachHostCallHandler({
    clock,
    workerHost: w.workerHost,
    spawner,
    gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
    budget: {
      hostCallMs: 5_000,
      gateMs: 5_000,
      maxParallel: 100,
      maxChildren: 1_000,
      maxBatchItems: 100,
      childBudgetPolicy: "inherit_remaining",
    },
    workflowDeadlineAt: 10_000_000,
    journal: {
      store: { append: (_dir: string, entry: JournalEntry) => appended.push(entry) } as never,
      dir: ".",
      index,
      scope,
      noReplay: false,
      deterministic: { current: true },
      isolationReplay: {
        mode: "verify",
        cwd: "/repo",
        verified: new Set(), // no isolated call is ever a hit in this file (D3.1: `state:"none"` never journals, never verifies)
        nonce: "fixed-nonce",
        stats: { probed: 0, verified: 0, unverified: 0 },
      },
    },
    onChildSettled: (summary) => {
      const step = Number(summary.callId.slice(1));
      settleLog.push({ step, source: summary.source, status: summary.status });
    },
  });
  for (let i = 0; i < plan.length; i += 1) {
    const s = plan[i]!;
    const opts: Record<string, unknown> = {};
    if (s.experts) opts.experts = ["outside"];
    if (s.isolation) opts.isolation = s.isolation;
    w.call(`c${i}`, { prompt: s.prompt, opts: Object.keys(opts).length > 0 ? opts : null });
    await settle();
  }
  const stats = handler.replayStats;
  return {
    appended,
    settleLog,
    tainted: stats?.tainted === true,
    freshFolds: stats?.isolation?.freshFolds ?? 0,
    skippedByReason: stats?.skipped ?? 0,
  };
}

describe("D8 (1/3): chain scope \u2014 the isoId-fold / experts-taint interaction", () => {
  it("an accepted isolated call in chain scope is NOT itself a taint source \u2014 a plain call right after it is unaffected and replays cleanly in run 2", async () => {
    const plan: Step[] = [
      { prompt: "a", isolation: "worktree" }, // accepted, folds, does NOT taint (D6)
      { prompt: "b" }, // plain, right after the isolated call
    ];
    const run1 = await runPlan(plan, [], [], "chain");
    expect(run1.tainted).toBe(false);
    expect(run1.freshFolds).toBe(1); // "a" folded
    // "a" itself is never journaled (worktree state "none"); "b" IS, because
    // the chain was never tainted by "a".
    expect(run1.appended).toHaveLength(1);
    expect(run1.settleLog.map((s) => `${s.step}:${s.source}`)).toEqual(["0:live", "1:live"]);

    const run2 = await runPlan(plan, [], run1.appended, "chain");
    // "a" (isolated, `state:"none"`) can never be a hit; "b" now replays.
    expect(run2.settleLog.map((s) => `${s.step}:${s.source}`)).toEqual(["0:live", "1:replay"]);
    expect(run2.appended).toHaveLength(0); // "b" was a hit, nothing new to write
  });

  it("once the chain IS tainted by an experts call, a LATER isolated call is skip:chain_tainted (never journaled) but still performs its F2 fold", async () => {
    const plan: Step[] = [
      { prompt: "a", experts: true }, // taints (existing, unchanged experts rule)
      { prompt: "b", isolation: "worktree" }, // submitted AFTER taint
    ];
    const run1 = await runPlan(plan, [true], [], "chain");
    expect(run1.tainted).toBe(true);
    // "a" declares experts \u2192 never journaled either way; "b" is
    // chain_tainted \u2192 never journaled. Nothing appended at all.
    expect(run1.appended).toHaveLength(0);
    expect(run1.settleLog.map((s) => `${s.step}:${s.source}`)).toEqual(["0:live", "1:live"]);
    // D8's "unified I3 rule": the fold still fires for "b" even though the
    // chain is already tainted and nothing can ever be journaled under it.
    expect(run1.freshFolds).toBe(1);
  });

  it("a call declaring BOTH experts and isolation: successful resolution taints (unchanged experts rule) AND folds (I3, independent mechanisms)", async () => {
    const plan: Step[] = [{ prompt: "a", experts: true, isolation: "worktree" }];
    const run1 = await runPlan(plan, [true], [], "chain");
    expect(run1.tainted).toBe(true); // experts rule: unchanged
    expect(run1.freshFolds).toBe(1); // isolation rule: still folds once accepted
    expect(run1.appended).toHaveLength(0); // declaresExperts \u2192 never journaled (D8: skip:experts wins)
  });

  it("a call declaring BOTH experts and isolation: a FAILED resolution rejects before ever reaching F2 \u2014 no taint, no fold (I4)", async () => {
    const plan: Step[] = [{ prompt: "a", experts: true, isolation: "worktree" }];
    const run1 = await runPlan(plan, [false], [], "chain");
    expect(run1.tainted).toBe(false);
    expect(run1.freshFolds).toBe(0);
    // Rejected at admission \u2014 never even reaches settlement.
    expect(run1.settleLog).toEqual([]);
  });
});

describe("D8 (2/3): content scope still taints \u2014 D6's fold-instead-of-taint rule is chain-scope only", () => {
  it("an accepted isolated call in content scope taints exactly like a pre-D6 run \u2014 the plain call right after it is chain_tainted", async () => {
    const plan: Step[] = [
      { prompt: "a", isolation: "worktree" }, // content scope: still a taint source
      { prompt: "b" },
    ];
    const run1 = await runPlan(plan, [], [], "content");
    expect(run1.tainted).toBe(true);
    // "a" never journals (worktree state "none"); "b" is chain_tainted \u2192
    // never journaled either, unlike the chain-scope case above.
    expect(run1.appended).toHaveLength(0);
    expect(run1.settleLog.map((s) => `${s.step}:${s.source}`)).toEqual(["0:live", "1:live"]);
    // D8's unified rule is chain-scope only (`foldable` requires
    // `journal.scope === "chain"`) \u2014 content scope never folds.
    expect(run1.freshFolds).toBe(0);

    const run2 = await runPlan(plan, [], run1.appended, "content");
    // Nothing was ever written in run1, so run2 has nothing to hit either.
    expect(run2.settleLog.map((s) => `${s.step}:${s.source}`)).toEqual(["0:live", "1:live"]);
  });
});

describe("D8 (3/3): experts-taint semantics are unchanged by the presence of isolation calls in the plan", () => {
  it("interleaving isolated calls around an experts call doesn't move the taint point or its P2/P3 guarantees", async () => {
    const plan: Step[] = [
      { prompt: "a", isolation: "worktree" }, // pre-taint, folds, not itself a taint source
      { prompt: "b", experts: true }, // the ONLY taint source in this plan
      { prompt: "c", isolation: "worktree" }, // post-taint, chain_tainted, still folds (D8 unified rule)
      { prompt: "d" }, // post-taint, plain \u2014 must never journal or hit
    ];
    const run1 = await runPlan(plan, [true], [], "chain");
    expect(run1.tainted).toBe(true);
    // Only "a" folds without being tainted itself; "c" folds too (D8), but
    // both "a" and "c" are worktree state "none" \u2014 never journaled anyway.
    // "b" declares experts \u2192 never journaled. "d" is chain_tainted \u2192
    // never journaled. Net: NOTHING is appended \u2014 identical to what the
    // no-isolation seeded property (`replay-taint.property.test.ts`) already
    // proves for a bare `[plain, experts, plain]` plan once the experts call
    // succeeds (P3).
    expect(run1.appended).toHaveLength(0);
    expect(run1.freshFolds).toBe(2); // "a" and "c" both folded
    expect(run1.settleLog.map((s) => `${s.step}:${s.source}`)).toEqual(["0:live", "1:live", "2:live", "3:live"]);

    const run2 = await runPlan(plan, [true], run1.appended, "chain");
    // Nothing was ever written, so run2 is identical to run1: no replay hit
    // anywhere, same taint point, same fold count \u2014 the presence of
    // isolation calls changed NOTHING about the experts-taint mechanics.
    expect(run2.tainted).toBe(true);
    expect(run2.appended).toHaveLength(0);
    expect(run2.freshFolds).toBe(2);
    expect(run2.settleLog.map((s) => `${s.step}:${s.source}`)).toEqual(["0:live", "1:live", "2:live", "3:live"]);
  });

  it("a rejected experts call never taints, regardless of an isolated call sitting right next to it \u2014 both replay/fold normally next run", async () => {
    const plan: Step[] = [
      { prompt: "a", experts: true }, // resolution FAILS \u2192 rejected, never taints
      { prompt: "b", isolation: "worktree" }, // untouched by "a"'s failure \u2014 accepted, folds
      { prompt: "c" }, // plain, after the (non-tainting) isolated call
    ];
    const run1 = await runPlan(plan, [false], [], "chain");
    expect(run1.tainted).toBe(false);
    expect(run1.freshFolds).toBe(1); // "b" folded
    expect(run1.appended).toHaveLength(1); // "c" journaled normally (never tainted)
    expect(run1.settleLog.map((s) => `${s.step}:${s.source}`)).toEqual(["1:live", "2:live"]); // "a" never settles (admission reject)

    const run2 = await runPlan(plan, [false], run1.appended, "chain");
    expect(run2.settleLog.map((s) => `${s.step}:${s.source}`)).toEqual(["1:live", "2:replay"]); // "c" now hits
    expect(run2.appended).toHaveLength(0);
  });
});
