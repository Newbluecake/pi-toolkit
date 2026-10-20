import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { FakeClock } from "../../src/core/clock.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { BasicEffectInterpreter, RuntimeRunner, type RunnerDeps } from "../../src/runtime/runner.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import type { Watchdog } from "../../src/runtime/watchdog.js";

/**
 * fabric-cross-session plan §3.3 L1/L4 (W1): the runner seeds `diag.wakeLevel` from the request, `noteWakeLevel`
 * raises it monotonically through the reducer, and the terminal entry carries the FINAL value.
 */
const budget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 10,
  startupMs: 10,
  bindMs: 10,
  totalMs: 1000,
  totalGraceMs: 0,
  abortGraceMs: 5,
  reapMs: 50,
  steerMs: 2,
};
class FakeWatchdog implements Watchdog {
  arm() {}
  disarm() {}
  tick() {}
}
async function drain(ticks = 60) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}
function setup() {
  const clock = new FakeClock();
  let finishPrompt: () => void = () => undefined;
  const handle: SessionHandle = {
    sessionId: "s",
    sessionFile: undefined,
    prompt: () =>
      new Promise<void>((resolve) => {
        finishPrompt = resolve;
      }),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "answer",
    getUsage: () => undefined,
  };
  const driver: SessionDriver = { create: async () => handle, bind: async () => undefined, onLateArrival() {} };
  const deps: RunnerDeps = {
    clock,
    driver,
    pool: new SingleSlotPool(clock, 2),
    store: { put() {}, get: () => undefined, list: () => [], appendOutbox() {} },
    watchdog: new FakeWatchdog(),
    reaper: new EscalatingReaper(clock),
    effects: new BasicEffectInterpreter(),
    emit() {},
    deliver() {},
  };
  return { runner: new RuntimeRunner(deps), finish: () => finishPrompt() };
}

describe("RuntimeRunner causal level (plan §3.3)", () => {
  it("seeds diag.wakeLevel from the request (0 included), raises monotonically, freezes at terminal", async () => {
    const { runner, finish } = setup();
    const p = runner.run({ runId: "r-lvl", prompt: "q", wakeLevel: 0 }, budget);
    await drain();
    expect(runner.getRunState("r-lvl")?.diag.wakeLevel).toBe(0);
    runner.noteWakeLevel("r-lvl", 2);
    expect(runner.getRunState("r-lvl")?.diag.wakeLevel).toBe(2);
    runner.noteWakeLevel("r-lvl", 1); // lower: ignored
    expect(runner.getRunState("r-lvl")?.diag.wakeLevel).toBe(2);
    finish();
    await drain();
    const outcome = await p;
    expect(outcome.status).toBe("completed");
    expect(outcome.diag.wakeLevel).toBe(2); // the terminal entry carries the final effective value
    runner.noteWakeLevel("r-lvl", 9); // after terminal: ignored
    expect(runner.getRunState("r-lvl")?.diag.wakeLevel).toBe(2);
  });

  it("a request without wakeLevel (wake off) leaves diag.wakeLevel absent from start to terminal", async () => {
    const { runner, finish } = setup();
    const p = runner.run({ runId: "r-off", prompt: "q" }, budget);
    await drain();
    expect(runner.getRunState("r-off")?.diag).not.toHaveProperty("wakeLevel");
    finish();
    await drain();
    expect((await p).diag).not.toHaveProperty("wakeLevel");
  });

  it("noteWakeLevel on an unknown run is a silent no-op", () => {
    const { runner } = setup();
    expect(() => runner.noteWakeLevel("r-nope", 3)).not.toThrow();
    expect(runner.getRunState("r-nope")).toBeUndefined();
  });
});
