// @vitest-environment node
import { describe, expect, it } from "vitest";
import { useTicker } from "../../../src/web-hub/ui/src/composables/useTicker.js";

/** Deterministic fake timer queue (no real wall-clock waits) — same shape as render-gate.test.ts. */
function fakeClock(start = 0) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number): number => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: number): void => void timers.delete(id),
    pending: () => timers.size,
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

/** Fake `doc`/`win` — `hidden` is settable directly; `fireDocEvent` simulates `visibilitychange`. */
function fakeDocWin(initialHidden: boolean) {
  let hidden = initialHidden;
  const docListeners = new Set<() => void>();
  const winListeners = new Map<string, Set<() => void>>();
  const doc = {
    get hidden() {
      return hidden;
    },
    addEventListener: (_t: "visibilitychange", l: () => void): void => void docListeners.add(l),
    removeEventListener: (_t: "visibilitychange", l: () => void): void => void docListeners.delete(l),
  };
  const win = {
    addEventListener: (t: "pageshow" | "focus", l: () => void): void => {
      const s = winListeners.get(t) ?? new Set();
      s.add(l);
      winListeners.set(t, s);
    },
    removeEventListener: (t: "pageshow" | "focus", l: () => void): void => void winListeners.get(t)?.delete(l),
  };
  return {
    doc,
    win,
    setHidden: (v: boolean): void => {
      hidden = v;
      if (v) for (const l of docListeners) l(); // real `visibilitychange` fires on both transitions
    },
    fireVisibleAgain: (): void => {
      hidden = false;
      for (const l of docListeners) l();
    },
    fireWinEvent: (t: "pageshow" | "focus"): void => {
      for (const l of winListeners.get(t) ?? []) l();
    },
    docListenerCount: (): number => docListeners.size,
  };
}

describe("useTicker (vue-plan.md v2.1 §3.5): hidden-page zero-write rule", () => {
  it("ticks on the normal interval while visible", () => {
    const clock = fakeClock();
    const { doc, win } = fakeDocWin(false);
    const t = useTicker({ doc, win, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now });
    expect(t.now.value).toBe(0);
    clock.advance(1_000);
    expect(t.now.value).toBe(1_000);
    clock.advance(3_000);
    expect(t.now.value).toBe(4_000);
    t.dispose();
  });

  it("verifier fix: a timer already armed while visible must not write `now` once the tab goes hidden mid-interval", () => {
    const clock = fakeClock();
    const { doc, win, setHidden } = fakeDocWin(false);
    const t = useTicker({ doc, win, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now });
    // Go hidden without ever letting the armed 1000ms timer fire naturally — `onVisibilityChange`
    // (the hidden-transition handler, §3.5) must clear it immediately: `clock.pending()` proves no
    // stray timer is left that could still write later.
    setHidden(true);
    expect(clock.pending()).toBe(0);
    const before = t.now.value;
    clock.advance(10_000); // would have ticked 10x while visible; must be a complete no-op while hidden
    expect(t.now.value).toBe(before); // §3.5 "hidden ⇒ zero writes" — never touched while hidden
    t.dispose();
  });

  it("belt-and-suspenders: even if a tick were to fire while hidden, it still must not write `now`", () => {
    // Regression for the exact bug reported: `tick()` used to write `now.value` BEFORE checking
    // `doc.hidden`. Simulate a timer firing while hidden by advancing across the boundary in one
    // jump using a raw setTimeout-driven clock that doesn't proactively clear on hidden — i.e.
    // directly exercise `tick()`'s own internal guard, not just the proactive pause.
    const clock = fakeClock();
    const { doc, win } = fakeDocWin(false);
    let hiddenNow = false;
    const rawDoc = {
      get hidden() {
        return hiddenNow;
      },
      addEventListener: doc.addEventListener,
      removeEventListener: doc.removeEventListener,
    };
    const t = useTicker({
      doc: rawDoc,
      win,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
    });
    const before = t.now.value;
    hiddenNow = true; // flips `doc.hidden` without going through the proactive visibilitychange path
    clock.advance(1_000); // the already-armed timer fires now, with doc.hidden === true
    expect(t.now.value).toBe(before); // tick() itself must refuse to write while hidden
    expect(clock.pending()).toBe(0); // and must not re-arm either
    t.dispose();
  });

  it("resumes and snaps to the true current time (no catch-up drift) on visibilitychange back to visible", () => {
    const clock = fakeClock();
    const { doc, win, setHidden, fireVisibleAgain } = fakeDocWin(false);
    const t = useTicker({ doc, win, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now });
    setHidden(true);
    clock.advance(30_000); // 30s pass while hidden — must not accumulate into a catch-up burst
    expect(t.now.value).toBe(0);
    fireVisibleAgain();
    expect(t.now.value).toBe(30_000); // snapped to "now", not replayed tick-by-tick
    clock.advance(1_000);
    expect(t.now.value).toBe(31_000);
    t.dispose();
  });

  it("pageshow/focus resume ticking the same way as visibilitychange", () => {
    const clock = fakeClock();
    const { doc, win, setHidden, fireWinEvent } = fakeDocWin(false);
    const t = useTicker({ doc, win, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now });
    setHidden(true);
    clock.advance(5_000);
    // `fireWinEvent` alone does not flip `doc.hidden`; in practice `pageshow`/`focus` always fire
    // alongside a hidden→visible flip (a bfcache restore), so simulate that ordering explicitly:
    // flip visible first, then the window event, matching `onVisible`'s own hidden guard.
    setHidden(false);
    fireWinEvent("pageshow");
    fireWinEvent("focus");
    expect(t.now.value).toBe(5_000);
    t.dispose();
  });

  it("dispose() removes all listeners and clears the pending timer", () => {
    const clock = fakeClock();
    const { doc, win, docListenerCount } = fakeDocWin(false);
    const t = useTicker({ doc, win, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now });
    expect(docListenerCount()).toBe(1);
    expect(clock.pending()).toBe(1);
    t.dispose();
    expect(docListenerCount()).toBe(0);
    expect(clock.pending()).toBe(0);
  });
});
