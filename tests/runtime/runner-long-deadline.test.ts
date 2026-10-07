import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { createSegmentedClock, MAX_TIMER_DELAY_MS, type Clock, type RawTimerClock } from "../../src/core/clock.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { BasicEffectInterpreter, RuntimeRunner, type ResolvedSpawnRequest } from "../../src/runtime/runner.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { Watchdog } from "../../src/runtime/watchdog.js";

/**
 * Z11/T3 (agent-explicit-timeout-extend plan §4/§7): a run whose total budget
 * (30 days) exceeds setTimeout's 2^31−1 ms ceiling must not degenerate the
 * runner's deadline guard into Node's 1ms-fire busy-wait (C16). The runner
 * clock is a segmented clock over an overflow-simulating raw (delays > MAX
 * fire after 1ms, manual virtual-time advance); the watchdog is a no-op
 * because the runner owns the prompt deadline through guardUntil.
 */
const never = <T>() => new Promise<T>(() => undefined);
const DAY = 86_400_000;
const HOUR = 3_600_000;
const request: ResolvedSpawnRequest = { runId: "r", prompt: "hello" };
const budget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 5_000,
  startupMs: 5_000,
  bindMs: 5_000,
  totalMs: 30 * DAY, // > MAX_TIMER_DELAY_MS
  totalGraceMs: 90_000,
  abortGraceMs: 50,
  reapMs: 50,
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
class NoopWatchdog implements Watchdog {
  arm() {
    /* runner owns the prompt deadline via guardUntil */
  }
  disarm() {}
  tick() {}
}
function deps(clock: Clock, driver: SessionDriver) {
  const pool = new SingleSlotPool(clock, 1);
  const store = {
    put() {},
    get() {
      return undefined;
    },
    list() {
      return [];
    },
    appendOutbox() {},
  };
  const reaper = new EscalatingReaper(clock);
  return {
    clock,
    driver,
    pool,
    store,
    watchdog: new NoopWatchdog(),
    reaper,
    effects: new BasicEffectInterpreter(),
    emit() {},
    deliver() {},
  };
}

/** Same overflow-simulating raw world as tests/core/clock.test.ts (shared shape, local copy). */
function overflowWorld() {
  let time = 0;
  let nextId = 1;
  const timers = new Map<number, { due: number; fn: () => void }>();
  const setCalls: number[] = [];
  const raw: RawTimerClock = {
    now: () => time,
    set(ms: number, fn: () => void) {
      setCalls.push(ms);
      const id = nextId++;
      timers.set(id, { due: time + (ms > MAX_TIMER_DELAY_MS ? 1 : Math.max(0, ms)), fn });
      return id;
    },
    clear(t: unknown) {
      timers.delete(t as number);
    },
  };
  const advance = (ms: number) => {
    const target = time + ms;
    for (;;) {
      let best: [number, { due: number; fn: () => void }] | undefined;
      for (const entry of timers) {
        if (entry[1].due > target) continue;
        if (!best || entry[1].due < best[1].due || (entry[1].due === best[1].due && entry[0] < best[0])) best = entry;
      }
      if (!best) break;
      time = best[1].due;
      timers.delete(best[0]);
      best[1].fn();
    }
    time = target;
  };
  return { raw, setCalls, advance };
}

async function drain(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}
async function settleVirtual<T>(p: Promise<T>, world: ReturnType<typeof overflowWorld>, ms: number): Promise<T> {
  for (let i = 0; i < 30; i++) {
    await drain();
    world.advance(ms);
    const done = await Promise.race([
      p.then(
        () => true,
        () => true,
      ),
      Promise.resolve(false),
    ]);
    if (done) return p;
  }
  return p;
}

describe("runner long-deadline guard (Z11/T3)", () => {
  it("segmented clock: bounded raw arms in the first hour, then normal grace + timeout at 30d", async () => {
    const world = overflowWorld();
    const clock = createSegmentedClock(world.raw);
    const driver: SessionDriver = {
      create: async () => handle({ prompt: () => never() }),
      bind: async () => undefined,
      onLateArrival() {},
    };
    const runner = new RuntimeRunner(deps(clock, driver));
    const runPromise = runner.run({ ...request, runId: "r-long" }, budget);
    await drain();
    world.advance(HOUR);
    await drain();
    // 1h window bound. The runner armed exactly its four one-shot guards
    // (queue acquire, create, bind) plus the FIRST MAX-sized segment of the
    // 30-day prompt deadline — no per-ms re-arm loop. Plan §7 T3 wrote
    // "≤ 3"; the actual count is 4 because T3's constant omitted the
    // queue-acquire guard (runner.ts guards acquire/create/bind/prompt).
    // The busy-wait detector is the CONTROL case below.
    expect(world.setCalls.length).toBeLessThanOrEqual(4);
    expect(world.setCalls.every((ms) => ms <= MAX_TIMER_DELAY_MS)).toBe(true);
    expect(world.setCalls.filter((ms) => ms === MAX_TIMER_DELAY_MS).length).toBe(1); // the deadline's first segment

    // Advance to the 30d deadline: segment 1 fires at MAX (~24.8d), re-arms
    // segment 2, which fires exactly at due → deadline_fired → grace entered.
    world.advance(30 * DAY - HOUR);
    await drain();
    expect(runner.getRunState("r-long")?.diag.overtime?.graces).toBe(1);
    // Grace expiry → kill path → abort_grace → reap → timed_out.
    world.advance(90_000);
    const outcome = await settleVirtual(runPromise, world, 200);
    expect(outcome.status).toBe("timed_out");
    expect(outcome.timeoutReason).toBe("total");
  });

  it("CONTROL — same scenario without segmentation: the raw clock busy-waits (≥1000 arms), proving the main case detects it", async () => {
    const world = overflowWorld();
    const unsegmented: Clock = {
      now: () => world.raw.now(),
      setTimer: (ms, fn) => ({ id: world.raw.set(ms, fn) as number }),
      clearTimer: (h) => world.raw.clear(h.id),
    };
    const driver: SessionDriver = {
      create: async () => handle({ prompt: () => never() }),
      bind: async () => undefined,
      onLateArrival() {},
    };
    const runner = new RuntimeRunner(deps(unsegmented, driver));
    const runPromise = runner.run({ ...request, runId: "r-ctrl" }, budget);
    await drain();
    world.advance(2_000);
    // Without segmentation the 30d arm becomes Node's 1ms fire, and
    // guardUntil's re-arm loop runs once per ms — C16's busy-wait. The main
    // case's ≤4 bound would fail here (~2000 arms in 2s virtual).
    expect(world.setCalls.length).toBeGreaterThanOrEqual(1000);
    // Hygiene: settle the control run so nothing dangles.
    await runner.abortRun("r-ctrl", "user_stop");
    const outcome = await settleVirtual(runPromise, world, 200);
    expect(outcome.status).toBe("aborted");
  });
});
