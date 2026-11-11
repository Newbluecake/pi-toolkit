import { describe, expect, it, vi } from "vitest";
import { createSegmentedClock, MAX_TIMER_DELAY_MS, type RawTimerClock } from "../../../src/core/clock.js";
import { nextEvery } from "../../../src/schedule/core/cron.js";
function backend() {
  let now = 0,
    seq = 0;
  const queue = new Map<number, { at: number; fn(): void }>();
  const delays: number[] = [];
  const raw: RawTimerClock = {
    now: () => now,
    set(ms, fn) {
      delays.push(ms);
      const id = ++seq;
      queue.set(id, { at: now + ms, fn });
      return id;
    },
    clear(id) {
      queue.delete(id as number);
    },
  };
  return {
    raw,
    delays,
    queue,
    step() {
      const [id, t] = [...queue][0]!;
      queue.delete(id);
      now = t.at;
      t.fn();
    },
  };
}
describe("every 365d through the REAL segmented clock and observable raw backend", () => {
  it("every raw delay is positive and Node-safe; one final callback at the original grid time", () => {
    const b = backend(),
      c = createSegmentedClock(b.raw),
      fn = vi.fn();
    const due = nextEvery({ kind: "every", everyMs: 365 * 86_400_000, anchorAt: 0 }, 0)!;
    c.setTimer(due, fn);
    while (b.queue.size > 0) {
      expect(b.queue.size).toBe(1);
      b.step();
      if (c.now() < due) expect(fn).not.toHaveBeenCalled();
    }
    expect(fn).toHaveBeenCalledTimes(1);
    expect(c.now()).toBe(due);
    expect(b.delays).toHaveLength(Math.ceil(due / MAX_TIMER_DELAY_MS));
    expect(b.delays.every((ms) => ms > 0 && ms <= MAX_TIMER_DELAY_MS)).toBe(true);
    expect(b.delays.reduce((sum, ms) => sum + ms, 0)).toBe(due);
  });
  it("cancellation across a raw segment prevents any later callback", () => {
    const b = backend(),
      c = createSegmentedClock(b.raw),
      fn = vi.fn();
    const h = c.setTimer(365 * 86_400_000, fn);
    b.step();
    expect(b.queue.size).toBe(1);
    const racing = [...b.queue.values()][0]!.fn;
    c.clearTimer(h);
    expect(b.queue.size).toBe(0);
    racing();
    expect(fn).not.toHaveBeenCalled();
    expect(b.queue.size).toBe(0);
  });
});
