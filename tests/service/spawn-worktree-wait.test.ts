import { describe, expect, it, vi } from "vitest";
import { createSpawnService } from "../../src/service/spawn-service.js";
import type { AgentTypeConfig, DeadlineBudget, RunOutcome } from "../../src/core/types.js";
import type { Runner, SlotPool } from "../../src/service/ports.js";

const baseOutcome: RunOutcome = {
  runId: "x",
  status: "completed",
  turns: 1,
  durationMs: 2,
  diag: {
    createdAt: 0,
    phase: "settled",
    phaseEnteredAt: 2,
    pendingTools: 0,
    turns: 1,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
  },
};
const activeOutcome = (runId: string): RunOutcome => ({
  ...baseOutcome,
  runId,
  diag: { ...baseOutcome.diag, worktree: { state: "active" } },
});

function makeControllableRunner() {
  const resolvers = new Map<string, (o: RunOutcome) => void>();
  const runner: Runner = {
    run: (spec) => new Promise<RunOutcome>((resolve) => resolvers.set(spec.runId, resolve)),
  };
  return { runner, resolve: (runId: string, outcome: RunOutcome) => resolvers.get(runId)?.(outcome) };
}

function makeDeps(
  runner: Runner,
  opts: { budget?: Partial<DeadlineBudget>; typeBudgetOverride?: Partial<DeadlineBudget> } = {},
) {
  const type: AgentTypeConfig = {
    name: "worker",
    description: "worker",
    systemPrompt: "",
    promptMode: "append",
    ...(opts.typeBudgetOverride ? { budgetOverride: opts.typeBudgetOverride } : {}),
  };
  const pool: SlotPool = { acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }) };
  return {
    types: { get: () => type, list: () => [], reload: async () => ({ types: [type], errors: [] }) },
    pool,
    runner,
    now: () => Date.now(),
    ...(opts.budget ? { budget: opts.budget } : {}),
  };
}

async function spawnIsolated(service: ReturnType<typeof createSpawnService>, label?: string) {
  const started = await service.spawn({
    type: "worker",
    prompt: "x",
    isolation: "worktree",
    ...(label ? { label } : {}),
  });
  if ("error" in started) throw new Error(started.error.message);
  return started.runId;
}

describe("SpawnService: waitWorktreeDisposition (workflow-worktree plan D5/D5a)", () => {
  it("'none': an unknown runId", async () => {
    const { runner } = makeControllableRunner();
    const service = createSpawnService(makeDeps(runner));
    await expect(service.waitWorktreeDisposition!("no-such-run", { horizon: "settle" })).resolves.toEqual({
      kind: "none",
    });
  });

  it("'none': a run that was never isolated", async () => {
    const { runner, resolve } = makeControllableRunner();
    const service = createSpawnService(makeDeps(runner));
    const started = await service.spawn({ type: "worker", prompt: "x" });
    if ("error" in started) throw new Error(started.error.message);
    resolve(started.runId, { ...baseOutcome, runId: started.runId });
    await vi.waitFor(() => expect(service.snapshots().find((s) => s.runId === started.runId)).toBeDefined());
    await expect(service.waitWorktreeDisposition!(started.runId, { horizon: "settle" })).resolves.toEqual({
      kind: "none",
    });
  });

  it("'settled': already-terminal disposition resolves immediately", async () => {
    const { runner, resolve } = makeControllableRunner();
    const service = createSpawnService(makeDeps(runner));
    const runId = await spawnIsolated(service);
    resolve(runId, { ...activeOutcome(runId), diag: { ...baseOutcome.diag, worktree: { state: "clean" } } });
    await vi.waitFor(() => expect(service.snapshots().find((s) => s.runId === runId)).toBeDefined());
    await expect(service.waitWorktreeDisposition!(runId, { horizon: "settle" })).resolves.toEqual({
      kind: "settled",
      disposition: { state: "clean" },
    });
  });

  it("'settled': a mark() call wakes an in-flight waiter", async () => {
    const { runner, resolve } = makeControllableRunner();
    const service = createSpawnService(makeDeps(runner));
    const runId = await spawnIsolated(service);
    resolve(runId, activeOutcome(runId));
    await vi.waitFor(() => expect(service.snapshots().find((s) => s.runId === runId)).toBeDefined());
    const waiting = service.waitWorktreeDisposition!(runId, { horizon: "settle" });
    service.markWorktreeDisposition!(runId, { state: "committed", branch: "pi-agent-x" });
    await expect(waiting).resolves.toEqual({
      kind: "settled",
      disposition: { state: "committed", branch: "pi-agent-x" },
    });
  });

  it("'timeout': no mark() ever arrives within the horizon", async () => {
    vi.useFakeTimers();
    try {
      const { runner, resolve } = makeControllableRunner();
      const service = createSpawnService(makeDeps(runner, { budget: { reapMs: 100 } }));
      const runId = await spawnIsolated(service);
      resolve(runId, activeOutcome(runId));
      await vi.waitFor(() => expect(service.snapshots().find((s) => s.runId === runId)).toBeDefined());
      const waiting = service.waitWorktreeDisposition!(runId, { horizon: "settle" });
      await vi.advanceTimersByTimeAsync(101_000); // way past settle=reapMs+1s=1100ms
      await expect(waiting).resolves.toEqual({ kind: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a waiter unregisters after settling (mark then timeout does not double-resolve, no leaked timer)", async () => {
    vi.useFakeTimers();
    try {
      const { runner, resolve } = makeControllableRunner();
      const service = createSpawnService(makeDeps(runner, { budget: { reapMs: 50 } }));
      const runId = await spawnIsolated(service);
      resolve(runId, activeOutcome(runId));
      await vi.waitFor(() => expect(service.snapshots().find((s) => s.runId === runId)).toBeDefined());
      const waiting = service.waitWorktreeDisposition!(runId, { horizon: "settle" });
      service.markWorktreeDisposition!(runId, { state: "clean" });
      await expect(waiting).resolves.toEqual({ kind: "settled", disposition: { state: "clean" } });
      // the timer registered for this waiter must have been cleared by the mark
      await vi.advanceTimersByTimeAsync(60_000);
      // no crash / no further resolution attempts — a second wait call is fresh and independent:
      await expect(service.waitWorktreeDisposition!(runId, { horizon: "settle" })).resolves.toEqual({
        kind: "settled",
        disposition: { state: "clean" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out with capMs even when the horizon would allow longer", async () => {
    vi.useFakeTimers();
    try {
      const { runner, resolve } = makeControllableRunner();
      const service = createSpawnService(makeDeps(runner, { budget: { reapMs: 100_000 } }));
      const runId = await spawnIsolated(service);
      resolve(runId, activeOutcome(runId));
      await vi.waitFor(() => expect(service.snapshots().find((s) => s.runId === runId)).toBeDefined());
      const waiting = service.waitWorktreeDisposition!(runId, { horizon: "late", capMs: 500 });
      await vi.advanceTimersByTimeAsync(501);
      await expect(waiting).resolves.toEqual({ kind: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the run's ACTUAL effective reapMs (settings.budget.reapMs=2000 ⇒ settle@3000, late@11000)", async () => {
    vi.useFakeTimers();
    try {
      const { runner, resolve } = makeControllableRunner();
      const service = createSpawnService(makeDeps(runner, { budget: { reapMs: 2_000 } }));
      const runId = await spawnIsolated(service);
      resolve(runId, activeOutcome(runId));
      await vi.waitFor(() => expect(service.snapshots().find((s) => s.runId === runId)).toBeDefined());

      const settleWaiting = service.waitWorktreeDisposition!(runId, { horizon: "settle" });
      await vi.advanceTimersByTimeAsync(2_999);
      // not yet timed out
      let settleDone = false;
      settleWaiting.then(() => (settleDone = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settleDone).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await expect(settleWaiting).resolves.toEqual({ kind: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an agent-type budgetOverride.reapMs (larger than the global default) wins", async () => {
    vi.useFakeTimers();
    try {
      const { runner, resolve } = makeControllableRunner();
      const service = createSpawnService(
        makeDeps(runner, { budget: { reapMs: 100 }, typeBudgetOverride: { reapMs: 5_000 } }),
      );
      const runId = await spawnIsolated(service);
      resolve(runId, activeOutcome(runId));
      await vi.waitFor(() => expect(service.snapshots().find((s) => s.runId === runId)).toBeDefined());
      const waiting = service.waitWorktreeDisposition!(runId, { horizon: "settle" });
      // global reapMs (100) would time out at 1100ms — the type override (5000) must win instead
      await vi.advanceTimersByTimeAsync(1_200);
      let done = false;
      waiting.then(() => (done = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(4_900); // total 6100ms > settle(5000ms reapMs)=6000ms
      await expect(waiting).resolves.toEqual({ kind: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("timers are unref'd (does not keep the process alive)", async () => {
    vi.useFakeTimers();
    try {
      const { runner, resolve } = makeControllableRunner();
      const service = createSpawnService(makeDeps(runner, { budget: { reapMs: 50 } }));
      const runId = await spawnIsolated(service);
      resolve(runId, activeOutcome(runId));
      await vi.waitFor(() => expect(service.snapshots().find((s) => s.runId === runId)).toBeDefined());
      const before = vi.getTimerCount();
      const waiting = service.waitWorktreeDisposition!(runId, { horizon: "settle" });
      expect(vi.getTimerCount()).toBe(before + 1);
      service.markWorktreeDisposition!(runId, { state: "clean" });
      await waiting;
      expect(vi.getTimerCount()).toBe(before); // cleared, not leaked
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SpawnService: D5a reapMs table lifecycle", () => {
  it("finish() with no worktree in diag drops any table entry (non-isolated run)", async () => {
    const { runner, resolve } = makeControllableRunner();
    const service = createSpawnService(makeDeps(runner));
    const started = await service.spawn({ type: "worker", prompt: "x" });
    if ("error" in started) throw new Error(started.error.message);
    resolve(started.runId, { ...baseOutcome, runId: started.runId });
    await vi.waitFor(() => expect(service.snapshots().find((s) => s.runId === started.runId)).toBeDefined());
    // no table entry ⇒ falls back to settings.budget.reapMs, observable via "none" (no worktree at all)
    await expect(service.waitWorktreeDisposition!(started.runId, { horizon: "settle" })).resolves.toEqual({
      kind: "none",
    });
  });

  it("mark() deletes the table entry (subsequent wait uses the fallback reapMs, but the run is already settled anyway)", async () => {
    const { runner, resolve } = makeControllableRunner();
    const service = createSpawnService(makeDeps(runner, { budget: { reapMs: 3_000 } }));
    const runId = await spawnIsolated(service);
    resolve(runId, activeOutcome(runId));
    await vi.waitFor(() => expect(service.snapshots().find((s) => s.runId === runId)).toBeDefined());
    service.markWorktreeDisposition!(runId, { state: "clean" });
    // now settled — any further wait call resolves immediately regardless of the table
    await expect(service.waitWorktreeDisposition!(runId, { horizon: "settle" })).resolves.toEqual({
      kind: "settled",
      disposition: { state: "clean" },
    });
  });

  it("a 'late' horizon timing out drops the table entry; a 'settle' timeout keeps it for a later 'late' wait", async () => {
    vi.useFakeTimers();
    try {
      const { runner, resolve } = makeControllableRunner();
      const service = createSpawnService(makeDeps(runner, { budget: { reapMs: 50 } }));
      const runId = await spawnIsolated(service);
      resolve(runId, activeOutcome(runId));
      await vi.waitFor(() => expect(service.snapshots().find((s) => s.runId === runId)).toBeDefined());

      const settleWaiting = service.waitWorktreeDisposition!(runId, { horizon: "settle" });
      await vi.advanceTimersByTimeAsync(101); // settle = reapMs+1s = 1050ms — NOT yet elapsed
      let settleDone = false;
      settleWaiting.then(() => (settleDone = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settleDone).toBe(false);

      // a fresh "late" wait registered now still uses the SAME reapMs (50) from the table
      const lateWaiting = service.waitWorktreeDisposition!(runId, { horizon: "late" });
      await vi.advanceTimersByTimeAsync(60_000); // well past late = 5*50+1000 = 1250ms
      await expect(lateWaiting).resolves.toEqual({ kind: "timeout" });
      await expect(settleWaiting).resolves.toEqual({ kind: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose() settles every outstanding waiter with {kind:'disposed'} and clears their timers", async () => {
    vi.useFakeTimers();
    try {
      const { runner, resolve } = makeControllableRunner();
      const service = createSpawnService(makeDeps(runner, { budget: { reapMs: 10_000 } }));
      const runId = await spawnIsolated(service);
      resolve(runId, activeOutcome(runId));
      await vi.waitFor(() => expect(service.snapshots().find((s) => s.runId === runId)).toBeDefined());
      const before = vi.getTimerCount();
      const settleWaiting = service.waitWorktreeDisposition!(runId, { horizon: "settle" });
      const lateWaiting = service.waitWorktreeDisposition!(runId, { horizon: "late" });
      expect(vi.getTimerCount()).toBe(before + 2);
      service.dispose!();
      expect(vi.getTimerCount()).toBe(before);
      await expect(settleWaiting).resolves.toEqual({ kind: "disposed" });
      await expect(lateWaiting).resolves.toEqual({ kind: "disposed" });
      // after dispose every subsequent call resolves 'disposed' synchronously
      await expect(service.waitWorktreeDisposition!(runId, { horizon: "settle" })).resolves.toEqual({
        kind: "disposed",
      });
      // and markWorktreeDisposition becomes a no-op (never throws)
      expect(() => service.markWorktreeDisposition!(runId, { state: "committed" })).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the table does not write past its 4096-item capacity — new runs beyond it fall back to settings.budget.reapMs", async () => {
    vi.useFakeTimers();
    try {
      const { runner, resolve } = makeControllableRunner();
      const service = createSpawnService(makeDeps(runner, { budget: { reapMs: 7_000 } }));
      // Fill the table with 4096 still-"active" (never finished) isolated runs.
      const fillerIds: string[] = [];
      for (let i = 0; i < 4096; i++) {
        // eslint-disable-next-line no-await-in-loop
        fillerIds.push(await spawnIsolated(service, `filler-${i}`));
      }
      // The over-capacity run carries its OWN reapMs (3000ms) via budgetOverride; if finish()
      // wrongly created a table entry for it, the settle horizon would be 3000+1000ms. The capacity
      // bound means it never gets an entry, so the wait must fall back to settings.budget.reapMs
      // (7000ms) ⇒ settle horizon times out at 8000ms.
      const started = await service.spawn({
        type: "worker",
        prompt: "x",
        isolation: "worktree",
        label: "main",
        budgetOverride: { reapMs: 3_000 },
      });
      if ("error" in started) throw new Error(started.error.message);
      const runId = started.runId;
      resolve(runId, activeOutcome(runId));
      await vi.waitFor(() => expect(service.snapshots().find((s) => s.runId === runId)).toBeDefined());
      const waiting = service.waitWorktreeDisposition!(runId, { horizon: "settle" });
      await vi.advanceTimersByTimeAsync(7_999);
      let done = false;
      waiting.then(() => (done = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await expect(waiting).resolves.toEqual({ kind: "timeout" });
      void fillerIds;
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});
