import type { Millis } from "./types.js";
export type TimerHandle = { readonly id: number };
export interface Clock {
  now(): Millis;
  setTimer(delayMs: Millis, fn: () => void): TimerHandle;
  clearTimer(h: TimerHandle): void;
}

/** The real wall-clock Clock implementation, backed by setTimeout (index.ts wiring; FakeClock is test-only). */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer: (delayMs, fn) => {
    // unref: extension timers must never keep the host process alive — in
    // `pi -p` (print mode) nothing else holds the event loop after the turn
    // completes, and a ref'd 1s tick (FleetWidgetController) wedges exit
    // indefinitely. Interactive sessions are held open by pi's own UI/stdin,
    // so unref is a no-op there.
    const t = setTimeout(fn, Math.max(0, delayMs));
    (t as { unref?: () => void }).unref?.();
    return { id: t as unknown as number };
  },
  clearTimer: (h) => clearTimeout(h.id as unknown as ReturnType<typeof setTimeout>),
};

type Entry = { due: Millis; fn: () => void; cancelled: boolean };
export class FakeClock implements Clock {
  private time: Millis;
  private nextId = 1;
  private entries = new Map<number, Entry>();
  constructor(startAt = 0) {
    this.time = startAt;
  }
  now(): Millis {
    return this.time;
  }
  setTimer(delayMs: Millis, fn: () => void): TimerHandle {
    const id = this.nextId++;
    this.entries.set(id, { due: this.time + Math.max(0, delayMs), fn, cancelled: false });
    return { id };
  }
  clearTimer(h: TimerHandle): void {
    const e = this.entries.get(h.id);
    if (e) e.cancelled = true;
    this.entries.delete(h.id);
  }
  advance(ms: Millis): void {
    if (ms < 0) throw new RangeError("cannot move fake clock backwards");
    const target = this.time + ms;
    while (true) {
      const due = [...this.entries]
        .filter(([, e]) => !e.cancelled && e.due <= target)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!due) break;
      this.time = due[1].due;
      this.entries.delete(due[0]);
      due[1].fn();
    }
    this.time = target;
  }
  get pendingTimers(): number {
    return this.entries.size;
  }
}

/**
 * Maximum delay setTimeout accepts before Node fires it after ~1ms
 * (2^31 − 1 ms ≈ 24.8 days). Delays beyond this must be split into
 * chained segments (agent-explicit-timeout-extend plan §3.3/P4, C16).
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Wraps a raw Clock so `setTimer(delayMs, fn)` works for ANY non-negative
 * delay: delays beyond {@link MAX_TIMER_DELAY_MS} are armed as chained
 * segments, eliminating the 1ms busy-wait re-arm loop (C16).
 * STUB in batch 0 (agent-explicit-timeout-extend plan §3.1): currently
 * passes through to the raw clock verbatim; the segmented implementation
 * lands in P4.
 */
export function createSegmentedClock(raw: Clock): Clock {
  return raw;
}
