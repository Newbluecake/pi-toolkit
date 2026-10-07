import type { Millis } from "./types.js";
export type TimerHandle = { readonly id: number };
export interface Clock {
  now(): Millis;
  setTimer(delayMs: Millis, fn: () => void): TimerHandle;
  clearTimer(h: TimerHandle): void;
}

/**
 * Maximum delay setTimeout accepts before Node fires it after ~1ms
 * (2^31 − 1 ms ≈ 24.8 days). Delays beyond this must be split into chained
 * segments, otherwise every "wake up at the deadline" timer degenerates into
 * a 1ms busy-wait re-arm loop (agent-explicit-timeout-extend plan §3.4/P4,
 * C16; Z11).
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Raw timer backend consumed by {@link createSegmentedClock}: a single
 * fire-per-set timer primitive with no overflow protection of its own.
 */
export interface RawTimerClock {
  now(): Millis;
  set(ms: number, fn: () => void): unknown;
  clear(timer: unknown): void;
}

/**
 * createSegmentedClock's TimerHandle: the handle object itself carries the
 * mutable per-timer state (current raw segment + cancelled flag) — NOT a
 * module-level map, per the "no module-scope mutable state" rule (AGENTS.md;
 * survives /reload because all segment state dies with the handle).
 */
interface SegmentedTimerHandle {
  readonly id: number;
  cancelled: boolean;
  raw: unknown;
}

/**
 * Wraps a raw timer clock so `setTimer(delayMs, fn)` works for ANY
 * non-negative delay: delays beyond {@link MAX_TIMER_DELAY_MS} are armed as
 * chained segments of at most MAX each; when a segment fires, the next one is
 * armed from a fresh `now()` read, so the callback still fires at the ORIGINAL
 * due time and the >MAX regime can never become Node's 1ms-fire busy-wait
 * (C16 / agent-explicit-timeout-extend plan §3.4, mandatory per M3/Q3).
 *
 * - finite delay D: exactly ceil(D / MAX) raw `set` calls; `fn` fires once at
 *   `due` (the `now()` captured at setTimer time plus D). D ≤ MAX behaves
 *   byte-equivalently to the raw clock (one raw set — K7).
 * - NaN delay: normalized to 0 — due = now, raw `set(0)`, fires at the next
 *   tick (never a NaN due leaking into raw.set).
 * - +Infinity delay: the callback can never fire; MAX-sized segments re-arm
 *   forever (one raw set per ~24.8 days — live but never busy) and
 *   `console.warn` fires exactly once per handle.
 * - clearTimer between segments clears the current raw segment and marks the
 *   handle cancelled, so a racing segment callback is a no-op.
 */
export function createSegmentedClock(raw: RawTimerClock): Clock {
  let nextId = 1;
  return {
    now: () => raw.now(),
    setTimer: (delayMs: Millis, fn: () => void): TimerHandle => {
      const handle: SegmentedTimerHandle = { id: nextId++, cancelled: false, raw: undefined };
      // NaN ⇒ 0 (never a NaN due); negative ⇒ 0; +Infinity survives and keeps
      // due at +Infinity, handled by the segment loop below.
      const delay = Number.isNaN(delayMs) ? 0 : Math.max(0, delayMs);
      const due = raw.now() + delay;
      if (!Number.isFinite(due)) {
        console.warn("[pi-subagent] clock.setTimer: non-finite delay never fires; arming capped segments only");
      }
      const tick = () => {
        if (handle.cancelled) return;
        if (raw.now() >= due) {
          handle.raw = undefined;
          fn();
          return;
        }
        arm();
      };
      const arm = () => {
        const now = raw.now();
        handle.raw = raw.set(Math.max(0, Math.min(due - now, MAX_TIMER_DELAY_MS)), tick);
      };
      arm();
      return handle;
    },
    clearTimer: (h: TimerHandle): void => {
      const handle = h as SegmentedTimerHandle;
      handle.cancelled = true;
      const timer = handle.raw;
      handle.raw = undefined;
      if (timer !== undefined) raw.clear(timer);
    },
  };
}

/**
 * The real wall-clock Clock implementation: setTimeout behind
 * {@link createSegmentedClock} so arbitrarily long deadlines stay bounded
 * (index.ts wiring; FakeClock is test-only).
 */
export const systemClock: Clock = createSegmentedClock({
  now: () => Date.now(),
  set: (ms, fn) => {
    // unref: extension timers must never keep the host process alive — in
    // `pi -p` (print mode) nothing else holds the event loop after the turn
    // completes, and a ref'd 1s tick (FleetWidgetController) wedges exit
    // indefinitely. Interactive sessions are held open by pi's own UI/stdin,
    // so unref is a no-op there. Every re-armed segment gets the same
    // treatment.
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
});

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
