import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { attachHostCallHandler, type ChildSpawner } from "../../src/workflow/host.js";
import type { JournalStore } from "../../src/workflow/journal.js";
import { buildReplayIndex } from "../../src/workflow/replay.js";
import type { HostCallEnvelope, JournalEntry, ReplayScope } from "../../src/workflow/types.js";

type Step = { prompt: string; experts?: boolean; isolation?: "worktree" };

async function runPlan(
  plan: readonly Step[],
  entries: readonly JournalEntry[],
  scope: ReplayScope = "chain",
  verify = false,
) {
  const calls: Array<(e: HostCallEnvelope) => void> = [];
  const sent: Array<Record<string, unknown>> = [];
  const appended: JournalEntry[] = [];
  const settled: Array<{ callId: string; source: string }> = [];
  const spawns: string[] = [];
  const spawner: ChildSpawner = {
    spawn: async (req) => {
      spawns.push(req.prompt);
      return { runId: `r-${req.prompt}` };
    },
    abort: async () => true,
    waitAll: async ({ runIds }) => ({
      settled: runIds.map((runId) => ({ runId, status: "completed" as const, text: runId })),
      pending: [],
    }),
    configHashOf: () => "hash",
    worktreeAvailable: () => true,
    awaitWorktree: async () => ({ state: "clean" }),
    resolveExperts: () => {
      throw new Error("removed resolver must not run");
    },
  };
  const handler = attachHostCallHandler({
    clock: new FakeClock(),
    workerHost: {
      events: { onHostCall: (cb) => calls.push(cb), onPhase: () => {}, onTerminating: () => {} },
      send: (msg) => sent.push(msg),
    } as Parameters<typeof attachHostCallHandler>[0]["workerHost"],
    spawner,
    gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
    budget: {
      hostCallMs: 5000,
      gateMs: 5000,
      maxParallel: 100,
      maxChildren: 1000,
      maxBatchItems: 100,
      childBudgetPolicy: "inherit_remaining",
    },
    workflowDeadlineAt: 10000000,
    journal: {
      store: { append: (_dir, entry) => appended.push(entry) } as JournalStore,
      dir: ".",
      index: buildReplayIndex(entries, 0, scope),
      scope,
      noReplay: false,
      deterministic: { current: true },
      ...(verify
        ? {
            isolationReplay: {
              mode: "verify" as const,
              nonce: "test-nonce",
              cwd: ".",
              verified: new Set<string>(),
              stats: { probed: 0, verified: 0, unverified: 0 },
            },
          }
        : {}),
    },
    onChildSettled: (summary) => settled.push({ callId: summary.callId, source: summary.source }),
  });
  for (const [i, step] of plan.entries()) {
    const opts = {
      ...(step.experts ? { experts: ["main"] } : {}),
      ...(step.isolation ? { isolation: step.isolation } : {}),
    };
    calls.forEach((cb) => cb({ id: `c${i}`, op: "agent", args: { prompt: step.prompt, opts } }));
    for (let tick = 0; tick < 8; tick++) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { appended, settled, sent, spawns, stats: handler.replayStats };
}

// Isolation remains the only taint source; verify+chain uses identity folds instead.
describe("isolation taint and fold after experts removal", () => {
  for (const scope of ["chain", "content"] as const) {
    for (const verify of [false, true]) {
      for (let position = 1; position <= 5; position++) {
        it(`${scope}, verify=${verify}, isolation at ${position}: taint/fold survives rejected experts`, async () => {
          const plan: Step[] = Array.from({ length: 8 }, (_, i) => ({
            prompt: `s${i}`,
            ...(i === position ? { isolation: "worktree" as const } : {}),
          }));
          plan.splice(position, 0, { prompt: "removed", experts: true, isolation: "worktree" });
          const run1 = await runPlan(plan, [], scope, verify);
          const run2 = await runPlan(plan, run1.appended, scope, verify);
          const folding = verify && scope === "chain";
          expect(run1.stats?.tainted === true).toBe(!folding);
          // A verified content-scope isolation hit returns before live admission and does not taint.
          expect(run2.stats?.tainted === true).toBe(!verify);
          expect(run1.appended).toHaveLength(folding ? 8 : position + (verify ? 1 : 0));
          expect(run1.settled).toHaveLength(8);
          expect(run2.settled.filter((s) => s.source === "replay")).toHaveLength(
            folding ? 8 : position + (verify ? 1 : 0),
          );
          expect(run1.stats?.isolation?.freshFolds ?? 0).toBe(folding ? 1 : 0);
          expect(run2.stats?.isolation?.freshFolds ?? 0).toBe(0);
          expect(run1.spawns).not.toContain("removed");
          expect(run2.spawns).not.toContain("removed");
          if (!folding) {
            for (const settlement of run2.settled.filter((s) => Number(s.callId.slice(1)) > position + 1))
              expect(settlement.source).toBe("live");
          }
        });
      }
    }
  }
});
