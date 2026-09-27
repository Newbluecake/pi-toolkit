/**
 * A hidden-page-aware clock tick (vue-plan.md v2.1 §3.5, §5.2 — P1): backs elapsed-time displays
 * (fleet row `elapsedMs`, status pills' "Xs ago") without ever using `requestAnimationFrame`
 * (banned repo-wide, §3.5) or ticking while the tab is backgrounded. Pauses the repeating timer
 * while `doc.hidden`; `visibilitychange`/`pageshow`/`focus` snap `now` to the true current time
 * immediately (no catch-up drift) and resume ticking.
 *
 * Verifier fix (2026-09-27): §3.5's "hidden ⇒ zero writes" rule has two distinct races, both
 * fixed here. (1) A timer armed while visible can still *fire* after the tab goes hidden mid-
 * interval — `tick()` used to write `now.value` unconditionally and only consult `doc.hidden`
 * afterwards (to decide whether to re-arm), so that single write leaked through. `tick()` now
 * checks `doc.hidden` FIRST and, if hidden, writes nothing and does not re-arm. (2) Nothing used
 * to observe the *hidden* transition itself — only the *visible* one (`onVisible`) — so a timer
 * already in flight when the tab backgrounds just sat there until it fired once more (case 1)
 * before finally going quiet; a long-hidden tab could still schedule (and fire) several more
 * ticks if `arm()` ever raced back in. `onVisibilityChange` now handles both directions: hidden
 * ⇒ clear the pending timer immediately (no more ticks until visible again); visible ⇒ the
 * existing snap-and-resume (`onVisible`).
 */
import { ref, type Ref } from "vue";

export interface TickerDocument {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface TickerWindow {
  addEventListener(type: "pageshow" | "focus", listener: () => void): void;
  removeEventListener(type: "pageshow" | "focus", listener: () => void): void;
}

export interface UseTickerOptions<TTimer = ReturnType<typeof setTimeout>> {
  doc: TickerDocument;
  win: TickerWindow;
  setTimeout(fn: () => void, ms: number): TTimer;
  clearTimeout(handle: TTimer): void;
  now(): number;
  /** Default 1000ms. */
  intervalMs?: number;
}

export interface TickerHandle {
  readonly now: Readonly<Ref<number>>;
  dispose(): void;
}

export function useTicker<TTimer = ReturnType<typeof setTimeout>>(opts: UseTickerOptions<TTimer>): TickerHandle {
  const intervalMs = opts.intervalMs ?? 1000;
  const now = ref(opts.now()) as Ref<number>;
  let timer: TTimer | null = null;
  let disposed = false;

  function tick(): void {
    timer = null;
    if (disposed) return;
    if (opts.doc.hidden) return; // §3.5 “hidden ⇒ zero writes”: never touch `now.value` while hidden
    now.value = opts.now();
    arm();
  }

  function arm(): void {
    if (timer !== null || disposed || opts.doc.hidden) return;
    timer = opts.setTimeout(tick, intervalMs);
  }

  function onVisible(): void {
    if (disposed || opts.doc.hidden) return;
    now.value = opts.now(); // correct immediately, no accumulated drift from the paused interval
    arm();
  }

  /** The other half of `onVisible`: a tab going hidden pauses immediately instead of waiting for
   * an already-armed timer to fire once more (see the file header). */
  function onVisibilityChange(): void {
    if (disposed) return;
    if (opts.doc.hidden) {
      if (timer !== null) {
        opts.clearTimeout(timer);
        timer = null;
      }
      return;
    }
    onVisible();
  }

  arm();
  opts.doc.addEventListener("visibilitychange", onVisibilityChange);
  opts.win.addEventListener("pageshow", onVisible);
  opts.win.addEventListener("focus", onVisible);

  return {
    now: now as Readonly<Ref<number>>,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) opts.clearTimeout(timer);
      opts.doc.removeEventListener("visibilitychange", onVisibilityChange);
      opts.win.removeEventListener("pageshow", onVisible);
      opts.win.removeEventListener("focus", onVisible);
    },
  };
}
