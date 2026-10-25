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

// Rejected experts calls must have no effect on journal identity or taint.
describe("removed experts: seeded replay safety", () => {
  for (let seed = 1; seed <= 24; seed++) {
    it(`seed ${seed}: every plain call journals and replays past rejected experts`, async () => {
      let state = seed;
      const plan: Step[] = Array.from({ length: 12 }, (_, i) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return { prompt: `s${i}`, experts: i === 0 || (i !== 11 && state % 3 === 0) };
      });
      const plain = plan.filter((s) => !s.experts);
      const run1 = await runPlan(plan, []);
      const run2 = await runPlan(plan, run1.appended);
      expect(run1.appended).toHaveLength(plain.length);
      expect(run1.spawns).toEqual(plain.map((s) => s.prompt));
      expect(run2.spawns).toEqual([]);
      expect(run2.settled).toEqual(run1.settled.map((s) => ({ ...s, source: "replay" })));
      expect(run2.appended).toEqual([]);
      for (const run of [run1, run2]) {
        expect(run.stats).not.toHaveProperty("tainted");
        const rejections = run.sent.filter((m) => m.kind === "host_ack" && m.ok === false);
        expect(rejections).toHaveLength(plan.length - plain.length);
        for (const rejected of rejections)
          expect(rejected.error).toMatchObject({
            message: expect.stringContaining("opts.experts is no longer supported"),
          });
      }
      // Inserting rejected calls must not change any plain call's journal identity.
      const withoutRejected = await runPlan(plain, []);
      expect(run1.appended).toEqual(withoutRejected.appended);
    });
  }
});
