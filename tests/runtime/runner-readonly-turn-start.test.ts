import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { FakeClock } from "../../src/core/clock.js";
import type { DriverEvent } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { BasicEffectInterpreter, RuntimeRunner, type ResolvedSpawnRequest } from "../../src/runtime/runner.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { buildToolScopePolicy, createToolScopeEnforcer } from "../../src/runtime/tool-scope.js";
import type { Watchdog } from "../../src/runtime/watchdog.js";

/**
 * todo #22 memory optimize-plan §10 N11 (P0-r §7.0 point 6b runner wiring):
 * `RuntimeRunner`'s bind callback additionally calls `enforcer.onTurnBoundary`
 * on `turn_start`, but ONLY when the run's policy carries `provenance` — every
 * other run (policy.provenance undefined, or no toolScope at all) must see
 * the exact same call sequence as before this package (regression via the
 * existing runner-x3-x11.test.ts staying green).
 */

const budget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 10,
  startupMs: 10,
  bindMs: 10,
  totalMs: 200,
  abortGraceMs: 5,
  reapMs: 5,
  steerMs: 2,
};

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
    getLastAssistantText: () => undefined,
    getUsage: () => undefined,
    ...overrides,
  };
}

class FakeWatchdog implements Watchdog {
  arm() {}
  disarm() {}
  tick() {}
}

function deps(clock: FakeClock, driver: SessionDriver) {
  const pool = new SingleSlotPool(clock, 1);
  const store = { put() {}, get: () => undefined, list: () => [], appendOutbox() {} };
  const reaper = new EscalatingReaper(clock);
  const effects = new BasicEffectInterpreter();
  return { clock, driver, pool, store, watchdog: new FakeWatchdog(), reaper, effects, emit() {}, deliver() {} };
}

async function drain(clock: FakeClock, ticks: number, stepMs = 1) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    clock.advance(stepMs);
    await Promise.resolve();
  }
}

describe("N11\u2460 policy WITH provenance: onTurnBoundary fires on both turn_start and turn_end, onBind fires once before prompt", () => {
  it("calls onBind exactly once, then onTurnBoundary once per turn_start and once per turn_end", async () => {
    const clock = new FakeClock();
    let onEvent: ((e: DriverEvent) => void) | undefined;
    const h = handle({
      getActiveTools: () => ["read"],
      prompt: async () => {
        onEvent?.({ t: "turn_start" });
        onEvent?.({ t: "turn_end", toolResults: 0 });
      },
    });
    const driver: SessionDriver = {
      create: async () => h,
      bind: async (_h, cb) => {
        onEvent = cb;
      },
      onLateArrival() {},
    };
    const onBind = vi.fn(() => ({ applied: [], blockedNewcomers: [], rejectedShadowed: [], changed: false }));
    const onTurnBoundary = vi.fn(() => ({ applied: [], blockedNewcomers: [], rejectedShadowed: [], changed: false }));
    const policy = buildToolScopePolicy({ tools: ["read"], provenance: new Map([["read", "builtin"]]) });
    const req: ResolvedSpawnRequest = {
      runId: "r",
      prompt: "hi",
      toolScope: { policy, enforcer: { onBind, onTurnBoundary } },
    };
    const runner = new RuntimeRunner(deps(clock, driver));
    const p = runner.run(req, budget);
    await drain(clock, 20);
    const outcome = await p;
    expect(outcome.status).toBe("completed");
    expect(onBind).toHaveBeenCalledTimes(1);
    expect(onTurnBoundary).toHaveBeenCalledTimes(2); // one turn_start + one turn_end
  });
});

describe("N11\u2461 policy WITHOUT provenance: turn_start never calls the enforcer (byte-identical to pre-P0-r)", () => {
  it("calls onTurnBoundary only for turn_end, never for turn_start", async () => {
    const clock = new FakeClock();
    let onEvent: ((e: DriverEvent) => void) | undefined;
    const h = handle({
      getActiveTools: () => ["read"],
      prompt: async () => {
        onEvent?.({ t: "turn_start" });
        onEvent?.({ t: "turn_end", toolResults: 0 });
      },
    });
    const driver: SessionDriver = {
      create: async () => h,
      bind: async (_h, cb) => {
        onEvent = cb;
      },
      onLateArrival() {},
    };
    const onBind = vi.fn(() => ({ applied: [], blockedNewcomers: [], rejectedShadowed: [], changed: false }));
    const onTurnBoundary = vi.fn(() => ({ applied: [], blockedNewcomers: [], rejectedShadowed: [], changed: false }));
    const policy = buildToolScopePolicy({ tools: ["read"] }); // no provenance
    const req: ResolvedSpawnRequest = {
      runId: "r",
      prompt: "hi",
      toolScope: { policy, enforcer: { onBind, onTurnBoundary } },
    };
    const runner = new RuntimeRunner(deps(clock, driver));
    const p = runner.run(req, budget);
    await drain(clock, 20);
    await p;
    expect(onTurnBoundary).toHaveBeenCalledTimes(1); // turn_end only
  });

  it("a run with no toolScope at all never touches the enforcer on turn_start either", async () => {
    const clock = new FakeClock();
    let onEvent: ((e: DriverEvent) => void) | undefined;
    const h = handle({
      getActiveTools: () => ["read"],
      prompt: async () => {
        onEvent?.({ t: "turn_start" });
        onEvent?.({ t: "turn_end", toolResults: 0 });
      },
    });
    const driver: SessionDriver = {
      create: async () => h,
      bind: async (_h, cb) => {
        onEvent = cb;
      },
      onLateArrival() {},
    };
    const req: ResolvedSpawnRequest = { runId: "r", prompt: "hi" }; // no toolScope
    const runner = new RuntimeRunner(deps(clock, driver));
    const p = runner.run(req, budget);
    await drain(clock, 20);
    const outcome = await p;
    expect(outcome.status).toBe("completed"); // did not throw despite dispatching turn_start/turn_end
  });
});

describe("N11\u2462 terminal-status race guard: a turn_start delivered after settle is ignored, same as turn_end", () => {
  it("does not call onTurnBoundary for a turn_start event delivered after the run has already settled", async () => {
    const clock = new FakeClock();
    let onEvent: ((e: DriverEvent) => void) | undefined;
    const h = handle({ getActiveTools: () => ["read"], prompt: async () => undefined });
    const driver: SessionDriver = {
      create: async () => h,
      bind: async (_h, cb) => {
        onEvent = cb;
      },
      onLateArrival() {},
    };
    const onTurnBoundary = vi.fn(() => ({ applied: [], blockedNewcomers: [], rejectedShadowed: [], changed: false }));
    const policy = buildToolScopePolicy({ tools: ["read"], provenance: new Map([["read", "builtin"]]) });
    const req: ResolvedSpawnRequest = {
      runId: "r",
      prompt: "hi",
      toolScope: {
        policy,
        enforcer: {
          onBind: () => ({ applied: [], blockedNewcomers: [], rejectedShadowed: [], changed: false }),
          onTurnBoundary,
        },
      },
    };
    const runner = new RuntimeRunner(deps(clock, driver));
    const p = runner.run(req, budget);
    await drain(clock, 20);
    const outcome = await p;
    expect(outcome.status).toBe("completed");
    onTurnBoundary.mockClear();
    onEvent?.({ t: "turn_start" }); // late/racy delivery after settle
    expect(onTurnBoundary).not.toHaveBeenCalled();
  });
});

describe("N11\u2463 real production enforcer: a shadowed tool is stripped exactly at turn_start, not before", () => {
  it("read shadowed by an extension source is stripped at the first turn_start", async () => {
    const clock = new FakeClock();
    let onEvent: ((e: DriverEvent) => void) | undefined;
    let active = ["read"];
    let source = "builtin";
    const h = handle({
      getActiveTools: () => active,
      setActiveTools: (names) => {
        active = names;
      },
      getToolSources: () => new Map([["read", source]]),
      prompt: async () => {
        // Simulated late shadowing right before this turn starts.
        source = "ext:/late.ts";
        onEvent?.({ t: "turn_start" });
      },
    });
    const driver: SessionDriver = {
      create: async () => h,
      bind: async (_h, cb) => {
        onEvent = cb;
      },
      onLateArrival() {},
    };
    const enforcer = createToolScopeEnforcer();
    const policy = buildToolScopePolicy({ tools: ["read"], provenance: new Map([["read", "builtin"]]) });
    const req: ResolvedSpawnRequest = { runId: "r", prompt: "hi", toolScope: { policy, enforcer } };
    const runner = new RuntimeRunner(deps(clock, driver));
    const p = runner.run(req, budget);
    await drain(clock, 20);
    await p;
    expect(active).toEqual([]); // stripped by the turn_start-triggered onTurnBoundary
  });
});
