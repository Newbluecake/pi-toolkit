// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createRenderGate } from "../../../src/web-hub/ui/src/composables/renderGate.js";

/** Deterministic fake timer queue (no real wall-clock waits). */
function fakeClock() {
  let now = 0;
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

/** Fake `doc`/`win` decoupled from the real `document` — `hidden` is settable directly, and
 * `fireDocEvent`/`fireWinEvent` simulate the three "became visible" signals §3.5 flushes on. */
function fakeDocWin(initialHidden: boolean) {
  let hidden = initialHidden;
  const docListeners = new Map<string, Set<() => void>>();
  const winListeners = new Map<string, Set<() => void>>();
  const doc = {
    get hidden() {
      return hidden;
    },
    addEventListener: (t: "visibilitychange", l: () => void): void => {
      const s = docListeners.get(t) ?? new Set();
      s.add(l);
      docListeners.set(t, s);
    },
    removeEventListener: (t: "visibilitychange", l: () => void): void => void docListeners.get(t)?.delete(l),
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
    },
    fireDocEvent: (t: "visibilitychange"): void => {
      for (const l of docListeners.get(t) ?? []) l();
    },
    fireWinEvent: (t: "pageshow" | "focus"): void => {
      for (const l of winListeners.get(t) ?? []) l();
    },
    listenerCount: (): number =>
      [...docListeners.values()].reduce((a, s) => a + s.size, 0) +
      [...winListeners.values()].reduce((a, s) => a + s.size, 0),
  };
}

describe("renderGate (vue-plan.md v2.1 §3.5): hidden-page rule + #25 regression guard", () => {
  it("acceptance 1: hidden ⇒ zero DOM mutations for either priority across a 10s advance", () => {
    const clock = fakeClock();
    const { doc, win } = fakeDocWin(true);
    const el = document.createElement("div");
    let mutations = 0;
    const mo = new MutationObserver(() => {
      mutations++;
    });
    mo.observe(el, { childList: true });
    const gate = createRenderGate({
      commit: () => el.appendChild(document.createTextNode("x")),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      doc,
      win,
    });
    gate.request("now");
    gate.request("throttle");
    gate.request("now");
    clock.advance(10_000);
    expect(mutations).toBe(0);
    gate.dispose();
    mo.disconnect();
  });

  it("acceptance 2: visibilitychange ⇒ visible flushes synchronously (no timer advance)", () => {
    const clock = fakeClock();
    const { doc, win, setHidden, fireDocEvent } = fakeDocWin(true);
    let commits = 0;
    const gate = createRenderGate({
      commit: () => commits++,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      doc,
      win,
    });
    gate.request("now");
    expect(commits).toBe(0);
    setHidden(false);
    fireDocEvent("visibilitychange");
    expect(commits).toBe(1);
    gate.dispose();
  });

  it("acceptance 2: pageshow (bfcache restore) also flushes synchronously", () => {
    const clock = fakeClock();
    const { doc, win, setHidden, fireWinEvent } = fakeDocWin(true);
    let commits = 0;
    const gate = createRenderGate({
      commit: () => commits++,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      doc,
      win,
    });
    gate.request("throttle");
    setHidden(false);
    fireWinEvent("pageshow");
    expect(commits).toBe(1);
    gate.dispose();
  });

  it("acceptance 2: focus also flushes synchronously", () => {
    const clock = fakeClock();
    const { doc, win, setHidden, fireWinEvent } = fakeDocWin(true);
    let commits = 0;
    const gate = createRenderGate({
      commit: () => commits++,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      doc,
      win,
    });
    gate.request("now");
    setHidden(false);
    fireWinEvent("focus");
    expect(commits).toBe(1);
    gate.dispose();
  });

  it("acceptance 3: became visible with no event dispatched ⇒ the ≤hiddenPollMs fallback still flushes", () => {
    const clock = fakeClock();
    const { doc, win, setHidden } = fakeDocWin(true);
    let commits = 0;
    const gate = createRenderGate({
      commit: () => commits++,
      hiddenPollMs: 1000,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      doc,
      win,
    });
    gate.request("now");
    expect(commits).toBe(0);
    setHidden(false); // visibility event never fires (simulates a missed/delayed one)
    clock.advance(1000);
    expect(commits).toBe(1);
    gate.dispose();
  });

  it("acceptance 3: staying hidden ⇒ the poll keeps re-arming without ever committing", () => {
    const clock = fakeClock();
    const { doc, win } = fakeDocWin(true);
    let commits = 0;
    const gate = createRenderGate({
      commit: () => commits++,
      hiddenPollMs: 1000,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      doc,
      win,
    });
    gate.request("now");
    clock.advance(5_000);
    expect(commits).toBe(0);
    expect(clock.pending()).toBeGreaterThan(0); // still polling, not abandoned
    gate.dispose();
  });

  it("acceptance 5: throttle caps ~100 updates/s to ≤11 commits/s while visible", () => {
    const clock = fakeClock();
    const { doc, win } = fakeDocWin(false);
    let commits = 0;
    const gate = createRenderGate({
      commit: () => commits++,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      doc,
      win,
    });
    for (let i = 0; i < 100; i++) {
      gate.request("throttle");
      clock.advance(10);
    }
    expect(commits).toBeLessThanOrEqual(11);
    expect(commits).toBeGreaterThan(0);
    gate.dispose();
  });

  it('acceptance 5: discrete ("now") events in the same tick dedupe to one commit', async () => {
    const clock = fakeClock();
    const { doc, win } = fakeDocWin(false);
    let commits = 0;
    const gate = createRenderGate({
      commit: () => commits++,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      doc,
      win,
    });
    gate.request("now");
    gate.request("now");
    gate.request("now");
    expect(commits).toBe(0); // queued as a microtask, not yet run
    await Promise.resolve();
    expect(commits).toBe(1);
    gate.dispose();
  });

  it('"now" while visible commits immediately once the interval has elapsed (no artificial delay)', () => {
    const clock = fakeClock();
    const { doc, win } = fakeDocWin(false);
    let commits = 0;
    const gate = createRenderGate({
      commit: () => commits++,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      doc,
      win,
    });
    gate.request("throttle"); // first call: no prior commit ⇒ commits immediately
    expect(commits).toBe(1);
    gate.dispose();
  });

  it("acceptance 6: dispose() clears every timer and removes every listener", () => {
    const clock = fakeClock();
    const { doc, win, listenerCount } = fakeDocWin(true);
    const gate = createRenderGate({
      commit: () => {},
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      doc,
      win,
    });
    gate.request("now"); // arms the hidden poll timer
    expect(clock.pending()).toBeGreaterThan(0);
    expect(listenerCount()).toBeGreaterThan(0);
    gate.dispose();
    expect(clock.pending()).toBe(0);
    expect(listenerCount()).toBe(0);
  });

  it("after dispose(), further request()s are inert (no commit, no new timers)", () => {
    const clock = fakeClock();
    const { doc, win, setHidden, fireDocEvent } = fakeDocWin(false);
    let commits = 0;
    const gate = createRenderGate({
      commit: () => commits++,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      doc,
      win,
    });
    gate.dispose();
    gate.request("now");
    gate.request("throttle");
    setHidden(true);
    fireDocEvent("visibilitychange");
    expect(commits).toBe(0);
    expect(clock.pending()).toBe(0);
  });

  it("does not use requestAnimationFrame under the hood (no rAF injected, none called)", () => {
    const clock = fakeClock();
    const { doc, win } = fakeDocWin(false);
    let rafCalls = 0;
    const originalRaf = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => {
      rafCalls++;
      return 0;
    };
    try {
      const gate = createRenderGate({
        commit: () => {},
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        now: clock.now,
        doc,
        win,
      });
      gate.request("now");
      gate.request("throttle");
      clock.advance(1000);
      gate.dispose();
      expect(rafCalls).toBe(0);
    } finally {
      (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = originalRaf;
    }
  });
});
