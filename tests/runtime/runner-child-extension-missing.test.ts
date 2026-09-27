import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { FakeClock } from "../../src/core/clock.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import {
  BasicEffectInterpreter,
  CHILD_EXTENSION_MISSING_WARNING,
  RuntimeRunner,
  type ResolvedSpawnRequest,
  type RunnerDeps,
} from "../../src/runtime/runner.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { DriverEvent, SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";

/**
 * todo #27 (child-extension-missing diagnostic): the runner side of the
 * detection. `PiSessionDriver.bind()` emits `child_extension_missing`
 * exactly once, synchronously, for a run whose child session never
 * activated pi-toolkit at all (see session-driver.ts / activation-signal.ts
 * for how that decision is made) — this suite only exercises what the
 * runner does with that DriverEvent once it arrives: fold it into
 * `outcome.diag.childExtensionMissing` (never affecting the run's own
 * status/effects — same best-effort family as switch_capability etc.,
 * covered structurally in tests/core/context-switch-diag.test.ts) and WARN
 * exactly once per RuntimeRunner instance (deduped), never for a run that
 * never reports the event.
 */

const budget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 10,
  startupMs: 20,
  bindMs: 20,
  totalMs: 200,
  totalGraceMs: 0,
  abortGraceMs: 5,
  reapMs: 5,
  steerMs: 2,
};
const request: ResolvedSpawnRequest = { runId: "r", prompt: "hello" };

function handle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    sessionId: "s",
    sessionFile: undefined,
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "done",
    getUsage: () => undefined,
    ...overrides,
  };
}

/** Same shape as runner-switch-selfcheck.test.ts's driverEmitting: bind() fires the given events synchronously before its own promise resolves. */
function driverEmitting(h: SessionHandle, events: DriverEvent[] = []): SessionDriver {
  return {
    create: async () => h,
    bind: async (_h, onEvent) => {
      for (const e of events) onEvent(e);
    },
    onLateArrival() {},
  };
}

function harness(driver: SessionDriver) {
  const clock = new FakeClock();
  const store = { put() {}, get: () => undefined, list: () => [], appendOutbox() {} };
  const d: RunnerDeps = {
    clock,
    driver,
    pool: new SingleSlotPool(clock, 2),
    store,
    watchdog: { arm() {}, disarm() {}, tick() {} },
    reaper: new EscalatingReaper(clock),
    effects: new BasicEffectInterpreter(),
    emit() {},
    deliver() {},
  };
  return { clock, runner: new RuntimeRunner(d) };
}

describe("todo #27 (child-extension-missing diagnostic): runner folding + WARN dedup", () => {
  it("a run whose driver reports child_extension_missing settles normally with diag.childExtensionMissing:true", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const driver = driverEmitting(handle(), [{ t: "child_extension_missing" }]);
      const { runner } = harness(driver);
      const outcome = await runner.run({ ...request, runId: "r-a" }, budget);
      expect(outcome.status).toBe("completed");
      expect(outcome.diag.childExtensionMissing).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(`[pi-subagent] ${CHILD_EXTENSION_MISSING_WARNING}`);
    } finally {
      warn.mockRestore();
    }
  });

  it("a normal run whose driver never reports the event has no diag.childExtensionMissing and never warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const driver = driverEmitting(handle(), []);
      const { runner } = harness(driver);
      const outcome = await runner.run({ ...request, runId: "r-b" }, budget);
      expect(outcome.status).toBe("completed");
      expect(outcome.diag.childExtensionMissing).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("dedup: two runs on the SAME RuntimeRunner instance both reporting the event only WARN once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const driver = driverEmitting(handle(), [{ t: "child_extension_missing" }]);
      const { runner } = harness(driver);
      const first = await runner.run({ ...request, runId: "r-c1" }, budget);
      const second = await runner.run({ ...request, runId: "r-c2" }, budget);
      expect(first.diag.childExtensionMissing).toBe(true);
      expect(second.diag.childExtensionMissing).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("a fresh RuntimeRunner instance (simulating a post-/reload rebuild) warns again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const driver = driverEmitting(handle(), [{ t: "child_extension_missing" }]);
      const first = harness(driver);
      await first.runner.run({ ...request, runId: "r-d1" }, budget);
      const second = harness(driver);
      await second.runner.run({ ...request, runId: "r-d2" }, budget);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});
