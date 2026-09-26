import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, SubagentExtensionPoints, WorktreeDisposal } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createSpawnService } from "../../src/service/spawn-service.js";
import type { RunnerSpec } from "../../src/service/ports.js";
import {
  registerDispositionSink,
  releaseDispositionSink,
  type LateWorktreeDisposition,
} from "../../src/adapters/worktree-disposition-sink.js";

/** workflow-worktree plan D13 (v2.1 condition 2), P1 test #12. */
const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };

function fastBudget() {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 200,
    startupMs: 50,
    bindMs: 200,
    firstEventMs: 200,
    idleMs: 200,
    toolMs: 200,
    totalMs: 500,
    abortGraceMs: 20,
    steerMs: 10,
    reapMs: 30,
  };
}
function handle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    sessionId: "s1",
    sessionFile: undefined,
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "hello",
    getUsage: () => undefined,
    ...overrides,
  };
}
function buildAdapter(clock: FakeClock, driver: SessionDriver, extensions: SubagentExtensionPoints[]) {
  const pool = new SingleSlotPool(clock, 1);
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  const watchdog = new EventWatchdog({
    clock,
    budget: fastBudget(),
    getState: () => undefined,
    dispatch: () => undefined,
  });
  const notifier = {
    enqueue: () => undefined,
    consume: () => false,
    reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
    verifyPersisted: () => ({ missing: [] }),
    stats: { pending: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
    degraded: [],
  };
  const worktreeDiag: { current?: (runId: string, disposition: WorktreeDisposal) => void } = {};
  const runner = createRuntimeRunnerAdapter({
    clock,
    driver,
    pool,
    store,
    watchdog,
    reaper,
    notifier,
    extensions,
    worktreeDiag,
  });
  return { runner, pool, store, worktreeDiag };
}
function spec(overrides: Partial<RunnerSpec> = {}): RunnerSpec {
  return { runId: "r1", type, request: { type: "worker", prompt: "hi" }, budget: fastBudget(), ...overrides };
}
async function drain(clock: FakeClock, ticks: number, stepMs = 1) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    clock.advance(stepMs);
    await Promise.resolve();
  }
}

describe("SpawnService.dispose() + Runner.dispose(): late H3 reports after a stack rebuild (D13)", () => {
  it("clears all outstanding waiters/timers and settles them with {kind:'disposed'}", async () => {
    vi.useFakeTimers();
    try {
      const resolvers = new Map<string, (o: unknown) => void>();
      const spawnRunner = { run: (s: RunnerSpec) => new Promise((resolve) => resolvers.set(s.runId, resolve)) };
      const pool = { acquire: async (runId: string) => ({ ok: true as const, ticket: { runId, release() {} } }) };
      const service = createSpawnService({
        types: { get: () => type, list: () => [], reload: async () => ({ types: [type], errors: [] }) },
        pool,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runner: spawnRunner as any,
        now: () => Date.now(),
        budget: { reapMs: 10_000 },
      });
      const started = await service.spawn({ type: "worker", prompt: "x", isolation: "worktree" });
      if ("error" in started) throw new Error(started.error.message);
      resolvers.get(started.runId)?.({
        runId: started.runId,
        status: "completed",
        turns: 1,
        durationMs: 1,
        diag: {
          createdAt: 0,
          phase: "settled",
          phaseEnteredAt: 0,
          pendingTools: 0,
          turns: 0,
          escalation: [],
          orphaned: false,
          generation: 1,
          degraded: [],
          staleInputs: 0,
          unkillable: [],
          worktree: { state: "active" },
        },
      });
      await vi.waitFor(() => expect(service.snapshots().find((s) => s.runId === started.runId)).toBeDefined());
      const before = vi.getTimerCount();
      const settleWaiting = service.waitWorktreeDisposition!(started.runId, { horizon: "settle" });
      const lateWaiting = service.waitWorktreeDisposition!(started.runId, { horizon: "late" });
      expect(vi.getTimerCount()).toBe(before + 2);

      service.dispose!(); // simulates stack.ts's rebuild hand-off / session_shutdown

      expect(vi.getTimerCount()).toBe(before);
      await expect(settleWaiting).resolves.toEqual({ kind: "disposed" });
      await expect(lateWaiting).resolves.toEqual({ kind: "disposed" });
      await expect(service.waitWorktreeDisposition!(started.runId, { horizon: "settle" })).resolves.toEqual({
        kind: "disposed",
      });
      expect(() => service.markWorktreeDisposition!(started.runId, { state: "committed" })).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Runner.dispose() redirects a late setWorktreeDisposition write-back to the CURRENT session's durable sink, never the old store/live-sink", async () => {
    const clock = new FakeClock();
    let releaseBeforeReap!: (d: WorktreeDisposal) => void;
    const beforeReapGate = new Promise<WorktreeDisposal>((resolve) => (releaseBeforeReap = resolve));
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const ext: SubagentExtensionPoints = {
      beforeReap: async (_outcome, ctx) => {
        ctx.setWorktreeDisposition?.(await beforeReapGate);
      },
    };
    const { runner, store, worktreeDiag } = buildAdapter(clock, driver, [ext]);
    const sinkCalls: unknown[] = [];
    worktreeDiag.current = (runId, disposition) => sinkCalls.push({ runId, disposition });
    const p = runner.run(spec({ runId: "r-late", request: { type: "worker", prompt: "hi", isolation: "worktree" } }));
    await drain(clock, 30);
    const outcome = await p;
    expect(outcome.status).toBe("completed");

    runner.dispose!(); // rebuild boundary: the OLD adapter is disposed before its H3 reported

    const received: LateWorktreeDisposition[] = [];
    const token = {};
    registerDispositionSink(token, (e) => received.push(e));
    try {
      releaseBeforeReap({ state: "kept", path: "/tmp/wt/r-late" });
      await drain(clock, 30);
      expect(sinkCalls).toEqual([]); // old live-sink never touched post-dispose
      expect(store.get("r-late")?.diag.worktree).toEqual({ state: "active" }); // unchanged since normal completion, never overwritten by the late 'kept' report
      expect(received).toEqual([{ runId: "r-late", state: "kept", path: "/tmp/wt/r-late", at: expect.any(Number) }]);
    } finally {
      releaseDispositionSink(token);
    }
  });

  it("warns (never throws) when Runner.dispose() has run and no sink is currently registered", async () => {
    const clock = new FakeClock();
    let releaseBeforeReap!: (d: WorktreeDisposal) => void;
    const beforeReapGate = new Promise<WorktreeDisposal>((resolve) => (releaseBeforeReap = resolve));
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const ext: SubagentExtensionPoints = {
      beforeReap: async (_outcome, ctx) => ctx.setWorktreeDisposition?.(await beforeReapGate),
    };
    const { runner } = buildAdapter(clock, driver, [ext]);
    const p = runner.run(spec({ runId: "r-nosink", request: { type: "worker", prompt: "hi", isolation: "worktree" } }));
    await drain(clock, 30);
    await p;
    runner.dispose!();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    releaseBeforeReap({ state: "clean" });
    await drain(clock, 5);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("Runner.dispose() is idempotent", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const { runner } = buildAdapter(clock, driver, []);
    expect(() => {
      runner.dispose!();
      runner.dispose!();
    }).not.toThrow();
  });
});
