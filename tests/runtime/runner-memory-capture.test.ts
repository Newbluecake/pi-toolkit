import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { RuntimeRunner, BasicEffectInterpreter } from "../../src/runtime/runner.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionHandle } from "../../src/runtime/session-driver.js";

const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
describe("memory capture live runner branch identity fence", () => {
  it("reentrant abort during actual getBranchEntries cannot publish old branch", async () => {
    const clock = new FakeClock();
    let finish!: () => void,
      invalidate = false;
    const branch = [{ type: "custom", customType: "old-owner" }];
    let runner: RuntimeRunner;
    const handle: SessionHandle = {
      sessionId: "actual-child",
      sessionFile: undefined,
      prompt: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      steer: async () => {},
      requestAbort: async () => {
        finish?.();
      },
      dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
      killableHandles: new Set(),
      setActiveTools() {},
      getActiveTools: () => [],
      getLastAssistantText: () => "done",
      getUsage: () => undefined,
      getBranchEntries: () => {
        if (invalidate) void runner.abortRun("nested");
        return branch;
      },
    };
    runner = new RuntimeRunner({
      clock,
      driver: { create: async () => handle, bind: async () => {}, onLateArrival() {} },
      pool: new SingleSlotPool(clock, 1),
      store: { put() {}, get: () => undefined, list: () => [], appendOutbox() {} },
      watchdog: { arm() {}, disarm() {}, tick() {} },
      reaper: new EscalatingReaper(clock),
      effects: new BasicEffectInterpreter(),
      emit() {},
      deliver() {},
    });
    const run = runner.run({ runId: "nested", prompt: "held" }, DEFAULT_BUDGET);
    await drain();
    expect(runner.peekRunBranch("nested")).toBe(branch);
    invalidate = true;
    expect(runner.peekRunBranch("nested")).toBeUndefined();
    finish();
    await run;
    await drain();
    expect(runner.peekRunBranch("nested")).toBeUndefined();
  });
});
