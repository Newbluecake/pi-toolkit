import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { FakeClock } from "../../src/core/clock.js";
import { isLiveSessionFile } from "../../src/core/live-session-files.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { BasicEffectInterpreter, RuntimeRunner, type RunnerDeps } from "../../src/runtime/runner.js";
import { EscalatingReaper, type Reaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import type { Watchdog } from "../../src/runtime/watchdog.js";

/**
 * run-persistence plan D8 / §5 P4: the runner marks the child session file
 * live before session_created and releases it once the run is physically
 * reaped — on the normal path AND on the post-create startup-failure path —
 * while an unkillable (L4) orphan keeps its mark (it may still be writing).
 */
const KEY = Symbol.for("pi-subagent:live-session-files");
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[KEY];
});

const budget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 10,
  startupMs: 10,
  bindMs: 10,
  totalMs: 100,
  totalGraceMs: 0,
  abortGraceMs: 5,
  reapMs: 50,
  steerMs: 2,
};

function handle(file: string, overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    sessionId: "s",
    sessionFile: file,
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "answer",
    getUsage: () => undefined,
    ...overrides,
  };
}

class FakeWatchdog implements Watchdog {
  arm() {}
  disarm() {}
  tick() {}
}

async function drain(ticks = 80) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

function harness(driver: SessionDriver) {
  const clock = new FakeClock();
  const real = new EscalatingReaper(clock);
  let releaseReap: () => void = () => undefined;
  const reapGate = new Promise<void>((r) => (releaseReap = r));
  let sessionCreatedLive: boolean | undefined;
  const reaper: Reaper = {
    registry: real.registry,
    abortReap: (runId, gen) => real.abortReap(runId, gen),
    async reap(input) {
      await reapGate;
      return real.reap(input);
    },
    disposeLate: (runId, gen, h) => real.disposeLate(runId, gen, h),
  };
  const d: RunnerDeps = {
    clock,
    driver,
    pool: new SingleSlotPool(clock, 2),
    store: { put() {}, get: () => undefined, list: () => [], appendOutbox() {} },
    watchdog: new FakeWatchdog(),
    reaper,
    effects: new BasicEffectInterpreter({
      // Observe the mark ordering at the exact moment session_created journals.
      journal_snapshot: (e) => {
        if (e.kind === "journal_snapshot") sessionCreatedLive = isLiveSessionFile(e.snapshot.diag.sessionFile!);
      },
    }),
    emit() {},
    deliver() {},
  };
  return { clock, runner: new RuntimeRunner(d), releaseReap: () => releaseReap(), live: () => sessionCreatedLive };
}

describe("RuntimeRunner live session-file marks (run-persistence plan D8)", () => {
  it("normal path: live from session_created until the physical reap finishes", async () => {
    const file = "/tmp/live-normal.jsonl";
    let resolvePrompt!: () => void;
    const h = harness({
      create: async () => handle(file, { prompt: () => new Promise<void>((r) => (resolvePrompt = r)) }),
      bind: async () => undefined,
      onLateArrival() {},
    });
    const p = h.runner.run({ runId: "r1", prompt: "q" }, budget);
    await drain();
    expect(h.live()).toBe(true); // marked BEFORE session_created was dispatched
    expect(isLiveSessionFile(file)).toBe(true);
    resolvePrompt();
    const outcome = await p;
    expect(outcome.status).toBe("completed");
    await drain();
    expect(isLiveSessionFile(file)).toBe(true); // settled, but the reap is still gated
    h.releaseReap();
    await drain();
    expect(isLiveSessionFile(file)).toBe(false);
  });

  it("startup failure after the session was created (bind rejects) still releases after reap", async () => {
    const file = "/tmp/live-bindfail.jsonl";
    const h = harness({
      create: async () => handle(file),
      bind: async () => {
        throw new Error("bind exploded");
      },
      onLateArrival() {},
    });
    const outcome = await h.runner.run({ runId: "r2", prompt: "q" }, budget);
    expect(outcome.status).toBe("failed");
    expect(isLiveSessionFile(file)).toBe(true);
    h.releaseReap();
    await drain();
    expect(isLiveSessionFile(file)).toBe(false);
  });

  it("an unkillable (L4) orphan keeps its live mark", async () => {
    const file = "/tmp/live-unkillable.jsonl";
    const h = harness({
      create: async () =>
        handle(file, { dispose: () => ({ returned: true, killed: 0, unkillable: [{ kind: "process", id: "42" }] }) }),
      bind: async () => undefined,
      onLateArrival() {},
    });
    await h.runner.run({ runId: "r3", prompt: "q" }, budget);
    h.releaseReap();
    await drain();
    expect(isLiveSessionFile(file)).toBe(true);
  });
});
