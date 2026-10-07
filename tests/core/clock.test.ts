import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeClock,
  MAX_TIMER_DELAY_MS,
  createSegmentedClock,
  systemClock,
  type RawTimerClock,
} from "../../src/core/clock.js";

const DAY = 86_400_000;

/**
 * Raw timer mock reproducing Node's setTimeout overflow behavior (delays
 * > 2^31−1 fire after ~1ms) plus manual virtual-time advance — the world in
 * which C16's 1ms busy-wait actually manifests. `fired` counts RAW timer
 * firings (independent of the wrapped callback), so tests can prove a raw
 * segment was genuinely cleared, not just ignored.
 */
function overflowWorld(startAt = 0) {
  let time = startAt;
  let nextId = 1;
  let fired = 0;
  const timers = new Map<number, { due: number; fn: () => void }>();
  const setCalls: number[] = [];
  const clearCalls: unknown[] = [];
  const raw: RawTimerClock = {
    now: () => time,
    set(ms: number, fn: () => void) {
      setCalls.push(ms);
      const id = nextId++;
      timers.set(id, { due: time + (ms > MAX_TIMER_DELAY_MS ? 1 : Math.max(0, ms)), fn });
      return id;
    },
    clear(t: unknown) {
      clearCalls.push(t);
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
      fired++;
      best[1].fn();
    }
    time = target;
  };
  return {
    raw,
    setCalls,
    clearCalls,
    advance,
    get pending() {
      return timers.size;
    },
    get fired() {
      return fired;
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSegmentedClock (Z11/T1)", () => {
  it("delegates now() to the raw clock", () => {
    const world = overflowWorld(1_234);
    expect(createSegmentedClock(world.raw).now()).toBe(1_234);
  });

  it("≤MAX delay passes through as one raw set and fires once at due (K7 byte-equivalence)", () => {
    const world = overflowWorld();
    const clock = createSegmentedClock(world.raw);
    const firedAt: number[] = [];
    clock.setTimer(150, () => firedAt.push(world.raw.now()));
    expect(world.setCalls).toEqual([150]);
    world.advance(149);
    expect(firedAt).toEqual([]);
    world.advance(1);
    expect(firedAt).toEqual([150]);
    expect(world.setCalls).toEqual([150]); // no re-arm
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it("finite 30d delay: raw set count === ceil(D/MAX) (= 2), every segment ≤ MAX, fires exactly once at due", () => {
    const D = 30 * DAY; // 2_592_000_000 > MAX
    expect(Math.ceil(D / MAX_TIMER_DELAY_MS)).toBe(2);
    const world = overflowWorld();
    const clock = createSegmentedClock(world.raw);
    const firedAt: number[] = [];
    clock.setTimer(D, () => firedAt.push(world.raw.now()));
    expect(world.setCalls).toEqual([MAX_TIMER_DELAY_MS]); // first segment caps at MAX
    world.advance(D);
    // R3 ruling: finite D ⇒ raw set count === ceil(D / MAX) — no +1 slack arm.
    expect(world.setCalls.length).toBe(Math.ceil(D / MAX_TIMER_DELAY_MS));
    expect(world.setCalls.every((ms) => ms <= MAX_TIMER_DELAY_MS)).toBe(true);
    expect(firedAt).toEqual([D]); // fired exactly at the original due
    world.advance(5 * DAY);
    expect(firedAt).toEqual([D]); // never re-fires
    expect(world.setCalls.length).toBe(2); // never re-arms
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it("boundary: delay === MAX is a single segment; MAX + 1 needs exactly two", () => {
    const world = overflowWorld();
    const clock = createSegmentedClock(world.raw);
    let fires = 0;
    clock.setTimer(MAX_TIMER_DELAY_MS, () => fires++);
    world.advance(MAX_TIMER_DELAY_MS);
    expect(fires).toBe(1);
    expect(world.setCalls).toEqual([MAX_TIMER_DELAY_MS]);

    const w2 = overflowWorld();
    const c2 = createSegmentedClock(w2.raw);
    let fires2 = 0;
    c2.setTimer(MAX_TIMER_DELAY_MS + 1, () => fires2++);
    w2.advance(MAX_TIMER_DELAY_MS + 1);
    expect(fires2).toBe(1);
    expect(w2.setCalls).toEqual([MAX_TIMER_DELAY_MS, 1]);
  });

  it("clearTimer between segments cancels: raw segment cleared, callback never fires, no re-arm", () => {
    const D = 30 * DAY;
    const world = overflowWorld();
    const clock = createSegmentedClock(world.raw);
    let fires = 0;
    const h = clock.setTimer(D, () => fires++);
    world.advance(MAX_TIMER_DELAY_MS); // segment 1 fires → segment 2 armed
    expect(world.setCalls.length).toBe(2);
    expect(world.pending).toBe(1); // segment 2 pending in the raw clock
    clock.clearTimer(h);
    expect(world.pending).toBe(0); // raw.clear actually removed the armed segment
    expect(world.clearCalls.length).toBe(1);
    world.advance(D); // way past the original due
    expect(fires).toBe(0);
    expect(world.setCalls.length).toBe(2); // cancelled handle never re-arms
    expect(world.fired).toBe(1); // only segment 1 ever fired
  });

  it("clearTimer after the callback fired is a harmless no-op", () => {
    const world = overflowWorld();
    const clock = createSegmentedClock(world.raw);
    let fires = 0;
    const h = clock.setTimer(10, () => fires++);
    world.advance(10);
    expect(fires).toBe(1);
    clock.clearTimer(h);
    world.advance(100);
    expect(fires).toBe(1);
  });

  it("NaN delay normalizes to 0: raw set(0), fires at the next tick, no warn", () => {
    const world = overflowWorld(500);
    const clock = createSegmentedClock(world.raw);
    const firedAt: number[] = [];
    clock.setTimer(Number.NaN, () => firedAt.push(world.raw.now()));
    expect(world.setCalls).toEqual([0]);
    world.advance(0);
    expect(firedAt).toEqual([500]);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it("+Infinity delay: MAX-sized segments re-arm per window, callback never fires, warn exactly once (R3 ruling)", () => {
    const world = overflowWorld();
    const clock = createSegmentedClock(world.raw);
    let fires = 0;
    clock.setTimer(Number.POSITIVE_INFINITY, () => fires++);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
    const window = 100 * DAY;
    world.advance(window);
    // R3 ruling: no finite-lifetime call-count assertion for +Infinity — assert
    // the ACTUAL segment count for the advanced window: ceil(window / MAX) ≈ 5.
    expect(world.setCalls.length).toBe(Math.ceil(window / MAX_TIMER_DELAY_MS));
    expect(world.setCalls.length).toBe(5);
    expect(world.setCalls.every((ms) => ms === MAX_TIMER_DELAY_MS)).toBe(true);
    expect(fires).toBe(0);
    expect(world.pending).toBe(1); // one live segment stays armed — no busy-wait
    // keep going: same invariants hold and the warn is never repeated
    world.advance(300 * DAY);
    expect(fires).toBe(0);
    expect(world.setCalls.every((ms) => ms === MAX_TIMER_DELAY_MS)).toBe(true);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
  });

  it("wraps a non-overflow raw (FakeClock-backed) with unchanged semantics", () => {
    const fake = new FakeClock();
    const clock = createSegmentedClock({
      now: () => fake.now(),
      set: (ms, fn) => fake.setTimer(ms, fn),
      clear: (t) => fake.clearTimer(t as ReturnType<typeof fake.setTimer>),
    });
    let fires = 0;
    clock.setTimer(1_000, () => fires++);
    fake.advance(999);
    expect(fires).toBe(0);
    fake.advance(1);
    expect(fires).toBe(1);
    expect(fake.pendingTimers).toBe(0);
  });
});

describe("systemClock (T2, real setTimeout)", () => {
  it("≤MAX delay: one setTimeout with the same delay, unref'd; clear goes through clearTimeout", () => {
    const unref = vi.fn();
    const delays: number[] = [];
    let returned: unknown;
    const setSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      void fn;
      returned = { unref };
      return returned as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
    const cleared: unknown[] = [];
    const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((t: unknown) => {
      cleared.push(t);
    }) as unknown as typeof clearTimeout);

    const h = systemClock.setTimer(5_000, () => {});
    expect(setSpy).toHaveBeenCalledTimes(1);
    // Date.now() may tick 1ms between due capture and arm: still one ~5000ms segment.
    const [armed0] = delays;
    expect(armed0).toBeDefined();
    expect((armed0 ?? 0) >= 4_999 && (armed0 ?? 0) <= 5_000).toBe(true);
    expect(unref).toHaveBeenCalledTimes(1);

    systemClock.clearTimer(h);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(cleared[0]).toBe(returned); // the very Timeout object setTimeout returned
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it(">MAX delay: first setTimeout is exactly MAX and unref'd (segmentation engaged, no 1ms clamp)", () => {
    const unref = vi.fn();
    const delays: number[] = [];
    const setSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      void fn;
      return { unref } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);

    const h = systemClock.setTimer(MAX_TIMER_DELAY_MS + 10_000, () => {});
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([MAX_TIMER_DELAY_MS]); // capped segment, never an overflow value
    expect(unref).toHaveBeenCalledTimes(1);
    systemClock.clearTimer(h);
    setSpy.mockRestore();
  });
});
