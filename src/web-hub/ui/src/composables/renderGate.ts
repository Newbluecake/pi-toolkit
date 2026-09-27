/**
 * Render scheduling gate (vue-plan.md v2.1 §3.5, §5.2 — P1). Throttles/dedupes when `commit()`
 * (a `shallowRef` write that lets Vue's own microtask-based scheduler patch the DOM) actually
 * runs — **never** via `requestAnimationFrame` (banned repo-wide, `tests/web-hub/ui/
 * source-scan.test.ts`): rAF is suspended while a tab is hidden/backgrounded with no guaranteed
 * cadence, which is the #25 root cause (state changes while hidden sat un-rendered forever, with
 * no bounded fallback — `wh2-merge` 1792278's `RENDER_FALLBACK_MS` patch on the old vanilla-JS
 * frontend only ever bounded it to 200ms, not "never while hidden, always on return").
 *
 * **The one rule this file exists to enforce**: `doc.hidden === true` ⇒ no `commit()` call is
 * ever reached, from *any* priority or code path. Every request funnels through `tryCommit()`,
 * which re-checks `doc.hidden` itself — including inside the microtask a `"now"` request queues
 * — so a tab that goes hidden between `request()` and the microtask running still doesn't write
 * DOM. `visibilitychange`→visible, `pageshow` (incl. bfcache restores) and `focus` all flush
 * synchronously; a best-effort 1s poll (`hiddenPollMs`) catches a missed/delayed visibility
 * event. No update is ever lost: `commit()` always reads the latest state (the reducer's `raw`,
 * owned by `useHub.ts`), so N updates while hidden simply collapse into the one commit on return.
 */

export type RenderPriority = "now" | "throttle";

export interface RenderGateDocument {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface RenderGateWindow {
  addEventListener(type: "pageshow" | "focus", listener: () => void): void;
  removeEventListener(type: "pageshow" | "focus", listener: () => void): void;
}

export interface RenderGateOptions<TTimer = ReturnType<typeof setTimeout>> {
  /** Writes the latest state into the reactive ref Vue patches the DOM from. */
  commit(): void;
  /** Trailing-edge throttle window for `request("throttle")`. Default 100ms (≤10 commits/s). */
  intervalMs?: number;
  /** Best-effort poll while hidden, in case a visibility event was missed/delayed. Default 1000ms. */
  hiddenPollMs?: number;
  setTimeout(fn: () => void, ms: number): TTimer;
  clearTimeout(handle: TTimer): void;
  now(): number;
  doc: RenderGateDocument;
  win: RenderGateWindow;
}

export interface RenderGateHandle {
  request(priority: RenderPriority): void;
  dispose(): void;
}

export function createRenderGate<TTimer = ReturnType<typeof setTimeout>>(
  opts: RenderGateOptions<TTimer>,
): RenderGateHandle {
  const intervalMs = opts.intervalMs ?? 100;
  const hiddenPollMs = opts.hiddenPollMs ?? 1000;
  const { commit, setTimeout: schedule, clearTimeout: cancel, now, doc, win } = opts;

  let disposed = false;
  let pending = false;
  let lastCommit = -Infinity;
  let throttleTimer: TTimer | null = null;
  let hiddenPollTimer: TTimer | null = null;
  let microtaskQueued = false;

  function clearThrottleTimer(): void {
    if (throttleTimer !== null) {
      cancel(throttleTimer);
      throttleTimer = null;
    }
  }

  function clearHiddenPoll(): void {
    if (hiddenPollTimer !== null) {
      cancel(hiddenPollTimer);
      hiddenPollTimer = null;
    }
  }

  function armHiddenPoll(): void {
    if (hiddenPollTimer !== null) return; // already armed
    hiddenPollTimer = schedule(onHiddenPollFire, hiddenPollMs);
  }

  function onHiddenPollFire(): void {
    hiddenPollTimer = null;
    if (disposed) return;
    if (!doc.hidden) {
      tryCommit();
      return;
    }
    if (pending) armHiddenPoll(); // still hidden, still something to flush: keep polling
  }

  /** The single funnel every path (now/throttle/visibility/poll) goes through. */
  function tryCommit(): void {
    if (disposed) return;
    if (doc.hidden) {
      pending = true;
      armHiddenPoll();
      return;
    }
    clearThrottleTimer();
    clearHiddenPoll();
    pending = false;
    lastCommit = now();
    commit();
  }

  function requestNow(): void {
    if (disposed) return;
    if (doc.hidden) {
      pending = true;
      armHiddenPoll();
      return;
    }
    if (microtaskQueued) return; // dedup: multiple "now" requests in the same tick ⇒ one commit
    microtaskQueued = true;
    queueMicrotask(() => {
      microtaskQueued = false;
      tryCommit();
    });
  }

  function requestThrottle(): void {
    if (disposed) return;
    if (doc.hidden) {
      pending = true;
      armHiddenPoll();
      return;
    }
    const elapsed = now() - lastCommit;
    if (elapsed >= intervalMs) {
      tryCommit();
      return;
    }
    if (throttleTimer !== null) return; // trailing edge already scheduled
    throttleTimer = schedule(() => {
      throttleTimer = null;
      tryCommit();
    }, intervalMs - elapsed);
  }

  const onVisible = (): void => {
    if (!doc.hidden) tryCommit();
  };

  doc.addEventListener("visibilitychange", onVisible);
  win.addEventListener("pageshow", onVisible);
  win.addEventListener("focus", onVisible);

  return {
    request(priority) {
      if (priority === "now") requestNow();
      else requestThrottle();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearThrottleTimer();
      clearHiddenPoll();
      doc.removeEventListener("visibilitychange", onVisible);
      win.removeEventListener("pageshow", onVisible);
      win.removeEventListener("focus", onVisible);
    },
  };
}
