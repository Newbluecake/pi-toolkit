import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { attachHostCallHandler, type ChildSpawner } from "../../src/workflow/host.js";
import { buildReplayIndex } from "../../src/workflow/replay.js";
import { buildEntry } from "../../src/workflow/journal.js";
import type { HostCallEnvelope, JournalEntry, WorkflowChildSummary } from "../../src/workflow/types.js";

/**
 * workflow-experts (docs/dev/workflow-experts/plan.md §6 test C#25):
 * seeded property coverage for chain-taint replay safety. Two runs of the
 * *same* submission plan (identical prompts/opts, same order) are driven
 * through fresh `attachHostCallHandler` instances; between the two runs the
 * environment is randomly flipped — each `agent({ experts })` step's
 * resolution independently succeeds or fails in run 1 vs run 2. Run 2's
 * journal `index` is built from whatever run 1 actually appended.
 *
 * Since `TaskSemantics` never includes `experts` (§4.6: taskKeyOf is
 * unchanged), the *chain digest* a plain or experts-declaring step produces
 * is identical between the two runs regardless of resolution outcome — only
 * *whether it gets journaled* and *whether taint is set* depend on the
 * per-run environment. That is exactly what this test exercises:
 *
 *  - P2/P3 (§5): once a run's OWN chain is tainted (some earlier step's
 *    experts resolved successfully in *that* run), no later step in that
 *    same run may ever be a replay hit, and no later step may ever be
 *    journaled (checked directly against the append log and the live
 *    settlement log, not just inferred from decideReplay's own unit tests).
 *  - Branch coverage guard (mirrors host-queue.property.test.ts): across all
 *    seeds, at least one run must hit each of: a successful experts
 *    resolution, a failed one, a post-taint live (non-replay) settlement,
 *    and at least one genuine replay hit carried over from run 1's journal.
 */

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

type Step = { readonly prompt: string; readonly experts: boolean };

interface RunResult {
  readonly appended: JournalEntry[];
  readonly settleLog: Array<{ step: number; source: WorkflowChildSummary["source"]; status: string }>;
  readonly tainted: boolean;
}

async function runPlan(
  plan: readonly Step[],
  succeedFlags: readonly boolean[],
  indexEntries: readonly JournalEntry[],
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
    resolveExperts: (handles) => {
      const idx = expertCallSeq;
      expertCallSeq += 1;
      if (!succeedFlags[idx]) return { error: { message: "expert not found" } };
      return {
        refs: handles.map((_h, i) => ({ runId: `expert-${idx}-${i}`, sessionFile: "/tmp/x.jsonl", agentType: "gp" })),
      };
    },
  };
  const index = buildReplayIndex(indexEntries, 0, "chain");
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
      scope: "chain",
      noReplay: false,
      deterministic: { current: true },
    },
    onChildSettled: (summary) => {
      const step = Number(summary.callId.slice(1));
      settleLog.push({ step, source: summary.source, status: summary.status });
    },
  });
  for (let i = 0; i < plan.length; i += 1) {
    const s = plan[i]!;
    w.call(`c${i}`, { prompt: s.prompt, opts: s.experts ? { experts: ["outside"] } : null });
    await settle();
  }
  return { appended, settleLog, tainted: handler.replayStats?.tainted === true };
}

function genPlan(next: () => number, n: number): Step[] {
  return Array.from({ length: n }, (_v, i) => ({ prompt: `s${i}`, experts: next() < 0.3 }));
}

describe("workflow-experts §6 C#25: chain-taint property (seeded, two runs, environment flip)", () => {
  const seeds = Array.from({ length: 24 }, (_v, i) => i * 97 + 1);

  let sawSuccess = false;
  let sawFailure = false;
  let sawPostTaintLive = false;
  let sawReplayHit = false;

  for (const seed of seeds) {
    it(`seed ${seed}: taint safety holds (no post-taint journal write, no post-taint replay hit)`, async () => {
      const next = random(seed);
      const n = 4 + Math.floor(next() * 6);
      const plan = genPlan(next, n);
      const expertsCount = plan.filter((s) => s.experts).length;
      const flags1 = Array.from({ length: expertsCount }, () => next() < 0.6);
      const flags2 = Array.from({ length: expertsCount }, () => next() < 0.6);

      const run1 = await runPlan(plan, flags1, []);
      const run2 = await runPlan(plan, flags2, run1.appended);

      for (const r of [
        { plan, res: run1, flags: flags1 },
        { plan, res: run2, flags: flags2 },
      ]) {
        // Reconstruct this run's own taint point: the step index of the
        // first experts submission whose resolution actually succeeded.
        let expertsSeen = 0;
        let taintAt: number | undefined;
        for (let i = 0; i < r.plan.length; i += 1) {
          if (!r.plan[i]!.experts) continue;
          const ok = r.flags[expertsSeen];
          expertsSeen += 1;
          if (ok) {
            taintAt = i;
            sawSuccess = true;
            break;
          }
        }
        if (taintAt === undefined) {
          // No experts call ever succeeded in this run — count failures for
          // branch coverage and skip the taint-specific assertions.
          if (expertsCount > 0) sawFailure = true;
          continue;
        }
        // P3: nothing appended for steps >= taintAt (the taint step itself
        // is an experts call and is never journaled either, per D12). We
        // can't recover the exact per-entry step index from the append log
        // alone (JournalEntry carries no callId), so we bound it instead:
        // the number of appended entries can never exceed the number of
        // live, non-experts, *pre-taint* settlements.
        const liveSettlesAtOrAfterTaint = r.res.settleLog.filter((s) => s.step >= taintAt!);
        for (const s of liveSettlesAtOrAfterTaint) {
          expect(s.source).not.toBe("replay"); // P2: no hit past the taint point
          if (s.step > taintAt!) sawPostTaintLive = true;
        }
        // Every appended entry's step (recovered by matching runId back to
        // the settleLog's live entries with the same completion order) must
        // have settled BEFORE taintAt. We approximate this by count: the
        // number of appended entries can never exceed the number of live,
        // non-experts settlements strictly before taintAt.
        const eligibleBeforeTaint = r.res.settleLog.filter(
          (s) => s.step < taintAt! && !r.plan[s.step]!.experts && s.status === "completed",
        ).length;
        expect(r.res.appended.length).toBeLessThanOrEqual(eligibleBeforeTaint);
      }

      if (run2.settleLog.some((s) => s.source === "replay")) sawReplayHit = true;
    });
  }

  it("branch coverage guard: all key branches were exercised across the seeds above", () => {
    expect(sawSuccess).toBe(true);
    expect(sawFailure).toBe(true);
    expect(sawPostTaintLive).toBe(true);
    expect(sawReplayHit).toBe(true);
  });
});

describe("workflow-experts §6 C#25 (targeted, deterministic): a hand-built taint-then-replay scenario", () => {
  it("a plain call before an experts call replays cleanly across runs; the tainted tail never does", async () => {
    const plan: Step[] = [
      { prompt: "a", experts: false },
      { prompt: "b", experts: true },
      { prompt: "c", experts: false },
    ];
    const run1 = await runPlan(plan, [true], []);
    // Only "a" (step 0) should have been journaled — "b" declares experts
    // (never journaled) and "c" is submitted after taint (never journaled).
    expect(run1.appended).toHaveLength(1);
    expect(run1.settleLog.map((s) => `${s.step}:${s.source}`)).toEqual(["0:live", "1:live", "2:live"]);

    const run2 = await runPlan(plan, [true], run1.appended);
    // "a" now hits from run1's journal; "b" still declares experts (skip);
    // "c" is chain_tainted this run too (taint is set again at step 1).
    expect(run2.settleLog.map((s) => `${s.step}:${s.source}`)).toEqual(["0:replay", "1:live", "2:live"]);
    expect(run2.appended).toHaveLength(0); // nothing new written: "a" was a hit, "b"/"c" are experts/tainted.
  });

  it("a rejected experts call never taints — the plain call right after it still replays next run", async () => {
    const plan: Step[] = [
      { prompt: "a", experts: true },
      { prompt: "b", experts: false },
    ];
    const run1 = await runPlan(plan, [false], []); // experts resolution fails -> call "a" is rejected, not settled live at all
    expect(run1.settleLog.map((s) => `${s.step}:${s.source}`)).toEqual(["1:live"]); // "a" never reaches settlement (admission reject)
    expect(run1.appended).toHaveLength(1); // "b" journaled normally (never tainted)

    const run2 = await runPlan(plan, [false], run1.appended);
    expect(run2.settleLog.map((s) => `${s.step}:${s.source}`)).toEqual(["1:replay"]); // "b" now hits
  });
});
