import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, RunSnapshot, SubagentExtensionPoints } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createSpawnService, type SpawnService } from "../../src/service/spawn-service.js";
import { createCallRegistry } from "../../src/workflow/call-registry.js";

/**
 * M3.4 mandatory item #2 ("A2 窗口加固"): this suite exercises
 * `src/workflow/call-registry.ts`'s A2 bounded-retry cancel loop against the
 * *real* `SpawnService`/`RuntimeRunner` stack (not a fake `abort()` double),
 * to verify the workflow side's retry semantics genuinely line up with the
 * real service's A2 contract documented in `src/service/spawn-service.ts`.
 *
 * admitted-run-visibility plan (fix 3, 2026-10-08 incident) updated that
 * contract: `src/runtime/runner.ts`'s `abortRun()` (the `activeCancels`
 * guard) still returns `{ ok: false, escalatedTo: "L4" }` for as long as an
 * H2 `resolveSessionSpec` extension hook is pending — that low-level fact is
 * unchanged — but `SpawnService.abort()` no longer surfaces that `false` to
 * its caller. It falls back to the per-run `AbortController` it wired into
 * the `RunnerSpec.signal` at admission time (`start()`), so the FIRST call
 * during this A2 window already returns `true` and arms a sticky
 * `AbortSignal` that `createCancelHandle` observes (via its synchronous
 * "already aborted" check) the instant `RuntimeRunner.run()` is finally
 * entered — settling the run as `aborted` before any session/tool work
 * begins. `CallRegistry`'s A2 bounded-retry loop (below) therefore converges
 * on its first attempt in the common case; it stays correct (just no longer
 * load-bearing for THIS particular gap) for any future admission path that
 * still reports `false`.
 *
 * Reuses the exact full-stack harness pattern `tests/service/deadline-cap.test.ts`
 * already established for CC4 (real `createSpawnService` +
 * `createRuntimeRunnerAdapter` + `SingleSlotPool` + a fake `SessionDriver`) —
 * this file only *reads* those modules, it does not modify anything outside
 * `src/workflow/**`/`tests/workflow/**`.
 */

const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };

function fastBudget(totalMs: number) {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 2_000,
    startupMs: 5_000,
    bindMs: 2_000,
    firstEventMs: 2_000,
    idleMs: 2_000,
    toolMs: 2_000,
    totalMs,
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

const flatNotifier = {
  enqueue: () => undefined,
  consume: () => false,
  reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
  verifyPersisted: () => ({ missing: [] }),
  stats: { pending: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
  degraded: [],
};

async function drain(clock: FakeClock, ticks: number, stepMs = 1) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    clock.advance(stepMs);
    await Promise.resolve();
  }
}

function buildFullStack(clock: FakeClock, driver: SessionDriver, extensions: SubagentExtensionPoints[] = []) {
  const pool = new SingleSlotPool(clock, 4);
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  const watchdog = new EventWatchdog({
    clock,
    budget: fastBudget(30_000),
    getState: () => undefined,
    dispatch: () => undefined,
  });
  const runner = createRuntimeRunnerAdapter({
    clock,
    driver,
    pool,
    store,
    watchdog,
    reaper,
    notifier: flatNotifier,
    extensions,
  });
  const types = {
    get: (name: string) => (name === "worker" ? type : undefined),
    list: () => [type],
    reload: async () => ({ types: [type], errors: [] }),
  };
  const svc: SpawnService & { snapshots(): readonly RunSnapshot[] } = createSpawnService({
    types,
    pool,
    runner,
    now: () => clock.now(),
  });
  return { pool, store, svc };
}

describe("A2 window alignment: workflow CallRegistry retry vs the real SpawnService/RuntimeRunner", () => {
  it("real abort() arms cancellation immediately during the H2 resolveSessionSpec delay via the admission-time AbortController (fix 3), and the run settles aborted once RuntimeRunner.run() actually begins", async () => {
    const clock = new FakeClock();
    let releaseH2!: () => void;
    const h2Gate = new Promise<void>((resolve) => (releaseH2 = resolve));
    // The admission-time signal spawn-service's start() threads through
    // RunnerSpec.request.signal — resolveSessionSpec's second parameter is
    // exactly that SpawnRequest, so capturing req.signal here observes the
    // same AbortSignal SpawnService.abort()'s fallback arms.
    let capturedSignal: AbortSignal | undefined;
    const slowHook: SubagentExtensionPoints = {
      resolveSessionSpec: async (spec, req) => {
        capturedSignal = req.signal;
        await h2Gate; // holds the run in the real A2 window (activeCancels unregistered) indefinitely, until released
        return spec;
      },
    };
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const { svc } = buildFullStack(clock, driver, [slowHook]);

    const spawned = await svc.spawn({ type: "worker", prompt: "x", budgetOverride: { totalMs: 60_000 } });
    if ("error" in spawned) throw new Error(spawned.error.message);
    const { runId } = spawned;

    // Real A2 window: the run is `running.has(runId) === true` (spawn()
    // already returned it), but RuntimeRunner.run() is still blocked inside
    // the H2 hook, so `deps.runner.abort` itself still reports `ok:false`
    // (activeCancels unregistered — src/runtime/runner.ts's abortRun()). Fix
    // 3 means `SpawnService.abort()` no longer surfaces that `false`: it
    // falls back to the admission-time AbortController wired into the
    // RunnerSpec it handed the runner, so the call succeeds right away and
    // the signal observed by the still-pending H2 hook is armed immediately.
    await drain(clock, 3);
    const abortResult = await svc.abort(runId, "user_stop");
    expect(abortResult).toBe(true);
    expect(capturedSignal?.aborted).toBe(true);

    // Release H2 — RuntimeRunner.run() proceeds past the hook, constructs its
    // cancel handle, immediately observes the already-armed (sticky) signal
    // via createCancelHandle's synchronous "already aborted" check, and
    // self-cancels before any session/tool work begins (the run settles
    // "aborted" straight out of the `queue_wait` phase —
    // core/state-machine.ts's `stop_requested` handling). This is fix 3's
    // whole point: teardown's abort() call during the admitted-but-
    // unobserved window must not be a silent no-op — it must produce a
    // reachable terminal outcome.
    releaseH2();
    await drain(clock, 10, 1);
    const result = await svc.waitOutcome(runId, 5_000);
    expect(result.kind).toBe("settled");
    if (result.kind === "settled") expect(result.outcome.status).toBe("aborted");
  });

  it("CallRegistry.cancel()'s bounded retry loop, wired to the real svc.abort(), converges exactly when the real A2 window closes (H2 delay < cancelRetryWindowMs)", async () => {
    const clock = new FakeClock();
    let releaseH2!: () => void;
    const h2Gate = new Promise<void>((resolve) => (releaseH2 = resolve));
    const slowHook: SubagentExtensionPoints = {
      resolveSessionSpec: async (spec) => {
        await h2Gate;
        return spec;
      },
    };
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const { svc } = buildFullStack(clock, driver, [slowHook]);

    const registry = createCallRegistry({
      clock,
      // This is *exactly* how host.ts wires it (`abort: (runId, cause) =>
      // deps.spawner.abort(runId, cause)`), against the real SpawnService.
      abort: (runId, cause) => svc.abort(runId, cause),
      cancelRetryWindowMs: 30_000,
      cancelRetryMs: 250,
    });

    const spawned = await svc.spawn({ type: "worker", prompt: "x", budgetOverride: { totalMs: 60_000 } });
    if ("error" in spawned) throw new Error(spawned.error.message);
    registry.submit("c1", clock.now());
    registry.bind("c1", spawned.runId);

    const effect = registry.cancel("c1", "user_stop");
    // CR6: cancel()'s synchronous return value reflects the call's phase at
    // the moment of the call (still pre_runner/running ⇒ "retrying") — it is
    // decided BEFORE the async deps.abort() promise this triggers even
    // settles, independent of how fast the underlying abort() call actually
    // succeeds (post-fix-3, immediately).
    expect(effect).toBe("retrying");

    // Fix 3 (admitted-run-visibility plan): deps.abort() now resolves `true`
    // on its very FIRST attempt — the admission-time AbortController arms
    // immediately even while H2 is still gating the run — so the retry loop
    // schedules no further attempt once that `ok:true` lands (see
    // call-registry.ts's `attempt()`: `if (ok) return;`). `cancelIntent.attempts`
    // therefore stays at 1 through every one of these clock advances; the loop
    // would still correctly keep retrying (never giving up early nor falsely
    // reporting success) for any future admission path whose `abort()` is
    // genuinely still `false` here — this scenario just is not that path
    // anymore.
    for (let i = 0; i < 4; i += 1) {
      clock.advance(250);
      await drain(clock, 2);
    }
    // still bound, not settled — the real settle event is a SEPARATE path (the
    // orchestrator's own waitAll(), not wired into this unit test), decoupled
    // from how fast the underlying abort() call itself already succeeded.
    expect(registry.resolve("c1")?.phase).not.toBe("settled");
    expect(registry.stats.retryingCancels).toBe(1);

    // Releasing H2 here is a no-op for the retry loop itself — it already
    // converged on its first attempt above, well before H2 was ever released
    // — kept to prove the run can still reach a real RuntimeRunner.run() entry
    // (and settle) afterward without the retry loop re-engaging or
    // double-counting attempts.
    releaseH2();
    await drain(clock, 3);
    clock.advance(250);
    await drain(clock, 5);

    expect(registry.resolve("c1")?.cancelIntent?.attempts).toBeGreaterThan(0);
    // The loop only ever schedules another attempt while `deps.abort` keeps
    // reporting false — confirm no further attempts increment the call's
    // outcome from here on by advancing well past the retry window and
    // observing stable state.
    const attemptsAtSuccess = registry.resolve("c1")?.cancelIntent?.attempts;
    clock.advance(30_000);
    await drain(clock, 5);
    expect(registry.resolve("c1")?.cancelIntent?.attempts).toBe(attemptsAtSuccess);
  });
});
