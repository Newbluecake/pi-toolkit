import { describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryOutboxStore, MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, DeadlineBudget, PersistedDelivery } from "../../src/core/types.js";
import { createNotifier as createNotifierImpl, type NotifierOptions } from "../../src/delivery/notifier.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createLiveRunRegistry } from "../../src/service/run-registry.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createSpawnService } from "../../src/service/spawn-service.js";

/**
 * L1 (agent-tool pool-full plan §3): regression for the queue_timeout race
 * that ONLY manifests with REAL timers, never with FakeClock (see the doc
 * comment on the `!acq.value.ok` branch in runtime/runner.ts's run()):
 *
 * `SingleSlotPool.acquire()`'s own `queueWaitMs` setTimeout is armed
 * strictly BEFORE `runner.run()`'s `guard()` wrapper arms its own,
 * later-registered setTimeout for (nominally) the same due time. With real
 * Node timers, the pool's macrotask fires first and its promise-resolution
 * microtask (guard's `p.then(...)`) drains BEFORE the event loop even
 * considers guard's own (later) macrotask — so guard sees "the promise
 * resolved" (`ok: true`) carrying the pool's OWN `{ok:false,
 * reason:"queue_timeout"}` as its *value*, not a guard-level timeout.
 * FakeClock's `advance()` drains same-tick timers synchronously in
 * registration order instead, so guard's own timer "wins" there and the bug
 * never surfaces in the FakeClock-driven timeout-grace-wiring suite (V19).
 *
 * Before the fix this crashed inside spawn-service's `finish(outcome)` with
 * "Cannot read properties of undefined (reading 'runId')" (state.outcome
 * stayed undefined because the illegal `prompt_settled` dispatch — the run
 * was still in phase "queue_wait" — never actually settled the state
 * machine) and start()'s own catch re-synthesized a `durationMs: 0` failure
 * carrying that crash text as the error message.
 */

function createNotifier(
  options: Omit<NotifierOptions, "cancelBuffered"> & Partial<Pick<NotifierOptions, "cancelBuffered">>,
) {
  return createNotifierImpl({ ...options, cancelBuffered: options.cancelBuffered ?? (() => undefined) });
}
const never = <T>() => new Promise<T>(() => undefined);
function realBudget(overrides: Partial<DeadlineBudget> = {}): DeadlineBudget {
  return { ...DEFAULT_BUDGET, queueWaitMs: 40, startupMs: 500, bindMs: 500, totalMs: 60_000, ...overrides };
}
function handle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    sessionId: "s1",
    sessionFile: undefined,
    prompt: () => never(),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "hi",
    getUsage: () => undefined,
    ...overrides,
  };
}
function buildRealStack() {
  const budget = realBudget();
  const pool = new SingleSlotPool(systemClock, 1);
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(systemClock);
  const runnerRef: { current?: ReturnType<typeof createRuntimeRunnerAdapter> } = {};
  const watchdog = new EventWatchdog({
    clock: systemClock,
    budget,
    tickMs: 20,
    getState: (runId, gen) => runnerRef.current?.getRunState?.(runId, gen),
    dispatch: (runId, gen, input) => {
      if (input.kind === "deadline_fired") runnerRef.current?.fireDeadline?.(runId, gen, input);
    },
  });
  const outbox = new MemoryOutboxStore<PersistedDelivery>();
  const sent: PersistedDelivery[] = [];
  const notifier = createNotifier({
    store: outbox,
    clock: systemClock,
    sender: (payload) => sent.push(payload as PersistedDelivery),
  });
  const driver: SessionDriver = {
    create: async () => handle(),
    bind: async () => undefined,
    onLateArrival: () => undefined,
  };
  const runner = createRuntimeRunnerAdapter({ clock: systemClock, driver, pool, store, watchdog, reaper, notifier });
  runnerRef.current = runner;
  const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
  const types = {
    get: (name: string) => (name === "worker" ? type : undefined),
    list: () => [type],
    reload: async () => ({ types: [type], errors: [] }),
  };
  const spawnService = createSpawnService({ types, pool, runner, budget });
  const registry = createLiveRunRegistry(spawnService, store);
  return { pool, spawnService, registry, sent };
}

describe("real-timer queue_timeout race (L1)", () => {
  it("settles a queued run as failed/queue_timeout with a real (non-zero) duration — never an undefined-outcome crash", async () => {
    const stack = buildRealStack();
    const a = await stack.spawnService.spawn({ type: "worker", prompt: "A holds the slot" });
    if ("error" in a) throw new Error(a.error.message);

    // Give A a moment to actually acquire the slot before B queues behind it.
    await new Promise((r) => setTimeout(r, 20));

    const outcome = await stack.spawnService.spawnAndWait({ type: "worker", prompt: "B queues and times out" });

    expect(outcome.status).toBe("failed");
    expect(outcome.timeoutReason ?? outcome.diag.timeoutReason).toBe("queue_timeout");
    // The crash path produced durationMs: 0 and stuffed a JS TypeError message
    // into outcome.error; neither may appear once the race is handled.
    expect(outcome.durationMs).toBeGreaterThan(0);
    // The crash path attached a JS TypeError as outcome.error; a clean
    // queue_timeout carries no error at all (timeoutReason is enough).
    expect(outcome.error).toBeUndefined();
    expect(outcome.runId).toBeDefined();

    await stack.spawnService.abort(a.runId, "user_stop");
  }, 15_000);
});
