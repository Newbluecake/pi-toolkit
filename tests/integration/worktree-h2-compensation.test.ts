import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, SubagentExtensionPoints } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import type { RunnerSpec } from "../../src/service/ports.js";

/**
 * workflow-worktree plan D12 (v2.1 condition 1), P1 test #9: the FULL chain
 * from the adapter's H2 wrapper through the merged registry's ctx/abandon
 * fan-out. Unlike tests/extensions/worktree.test.ts (which drives the
 * worktree extension directly), these exercise it through
 * createRuntimeRunnerAdapter — the same seam index.ts wires — so a
 * regression in the ctx-threading/abandon-dispatch plumbing itself (not just
 * the extension's own compensate()) is caught here.
 */
const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
const never = <T>() => new Promise<T>(() => undefined);

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
  const runner = createRuntimeRunnerAdapter({ clock, driver, pool, store, watchdog, reaper, notifier, extensions });
  return { runner, pool, store };
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

describe("H2 abort signal + abandonSessionSpec end-to-end (createRuntimeRunnerAdapter, D12)", () => {
  it("aborts ctx.signal and fires abandonSessionSpec({reason:'startup_timeout'}) when the hook times out", async () => {
    const clock = new FakeClock();
    const seenSignals: boolean[] = [];
    const abandonCalls: Array<{ runId: string; reason: string }> = [];
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const ext: SubagentExtensionPoints = {
      resolveSessionSpec: (s, _req, ctx) => {
        ctx?.signal.addEventListener("abort", () => seenSignals.push(true));
        return never<typeof s>();
      },
      abandonSessionSpec: (runId, ctx) => {
        abandonCalls.push({ runId, reason: ctx.reason });
      },
    };
    const { runner } = buildAdapter(clock, driver, [ext]);
    const p = runner.run(spec());
    await drain(clock, 60);
    const outcome = await p;
    expect(outcome.status).toBe("failed");
    expect(seenSignals).toEqual([true]);
    await drain(clock, 5); // fire-and-forget: give the microtask queue a turn
    expect(abandonCalls).toEqual([{ runId: "r1", reason: "startup_timeout" }]);
  });

  it("fires abandonSessionSpec({reason:'h2_failed'}) to EVERY extension when a LATER extension in the chain throws", async () => {
    const clock = new FakeClock();
    const abandonCalls: string[] = [];
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const worktreeExt: SubagentExtensionPoints = {
      resolveSessionSpec: (s) => ({ ...s, cwd: "/wt/r1" }), // "succeeds"
      abandonSessionSpec: (runId, ctx) => abandonCalls.push(`worktree:${runId}:${ctx.reason}`),
    };
    const laterExt: SubagentExtensionPoints = {
      resolveSessionSpec: () => {
        throw new Error("later extension blew up");
      },
    };
    const { runner } = buildAdapter(clock, driver, [worktreeExt, laterExt]);
    const p = runner.run(spec());
    await drain(clock, 30);
    const outcome = await p;
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toBe("later extension blew up");
    await drain(clock, 5);
    expect(abandonCalls).toEqual(["worktree:r1:h2_failed"]);
  });

  it("fires abandonSessionSpec({reason:'pre_runner_exit'}) when H2 succeeds but a later synchronous step throws before the runner is entered", async () => {
    const clock = new FakeClock();
    const abandonCalls: string[] = [];
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const worktreeExt: SubagentExtensionPoints = {
      resolveSessionSpec: (s) => ({ ...s, cwd: "/wt/r1" }),
      abandonSessionSpec: (runId, ctx) => abandonCalls.push(`${runId}:${ctx.reason}`),
    };
    const { runner } = buildAdapter(clock, driver, [worktreeExt]);
    // A non-string prompt makes the adapter's OWN displayMeta assembly
    // (`spec.request.prompt.slice(...)`) throw synchronously — AFTER H2 has
    // already succeeded and set `sessionSpec`, but strictly BEFORE
    // `runnerEntered = true`. There is (deliberately) no `catch` around this
    // window today — the throw propagates as a rejection — but the adapter's
    // `finally` still runs and must still fire the abandon fan-out.
    const p = runner.run(spec({ request: { type: "worker", prompt: undefined as unknown as string } }));
    await drain(clock, 30);
    await expect(p).rejects.toThrow();
    await drain(clock, 5);
    expect(abandonCalls).toEqual(["r1:pre_runner_exit"]);
  });

  it("never calls abandonSessionSpec for a run that entered the runner normally", async () => {
    const clock = new FakeClock();
    const abandonCalls: string[] = [];
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const ext: SubagentExtensionPoints = {
      resolveSessionSpec: (s) => ({ ...s, cwd: "/wt/r1" }),
      abandonSessionSpec: (runId) => abandonCalls.push(runId),
    };
    const { runner } = buildAdapter(clock, driver, [ext]);
    const p = runner.run(spec());
    await drain(clock, 30);
    const outcome = await p;
    expect(outcome.status).toBe("completed");
    await drain(clock, 5);
    expect(abandonCalls).toEqual([]);
  });

  it("the already-returned failed(config) outcome is never delayed by a hanging abandonSessionSpec", async () => {
    const clock = new FakeClock();
    let abandonResolved = false;
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const ext: SubagentExtensionPoints = {
      resolveSessionSpec: () => {
        throw new Error("boom");
      },
      abandonSessionSpec: () => never<void>().finally(() => (abandonResolved = true)),
    };
    const { runner } = buildAdapter(clock, driver, [ext]);
    const p = runner.run(spec());
    await drain(clock, 30);
    const outcome = await p; // resolves WITHOUT waiting for the hung abandonSessionSpec
    expect(outcome.status).toBe("failed");
    expect(abandonResolved).toBe(false);
  });
});
