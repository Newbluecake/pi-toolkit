// @vitest-environment happy-dom
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRenderGate, type RenderPriority } from "../../../src/web-hub/ui/src/composables/renderGate.js";

/** Same deterministic fake timer queue as render-gate.test.ts (kept local — see that file for
 * the non-property acceptance tests 1/2/3/5/6). */
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
    pending: () => timers.size,
  };
}

function fakeDocWin(initialHidden: boolean) {
  let hidden = initialHidden;
  const docListeners = new Set<() => void>();
  const winListeners = new Set<() => void>();
  const doc = {
    get hidden() {
      return hidden;
    },
    addEventListener: (_t: "visibilitychange", l: () => void): void => void docListeners.add(l),
    removeEventListener: (_t: "visibilitychange", l: () => void): void => void docListeners.delete(l),
  };
  const win = {
    addEventListener: (_t: "pageshow" | "focus", l: () => void): void => void winListeners.add(l),
    removeEventListener: (_t: "pageshow" | "focus", l: () => void): void => void winListeners.delete(l),
  };
  return {
    doc,
    win,
    setHidden: (v: boolean): void => {
      hidden = v;
    },
    fireVisible: (): void => {
      for (const l of docListeners) l();
      for (const l of winListeners) l();
    },
  };
}

type Action = { kind: "now" } | { kind: "throttle" } | { kind: "toggle" } | { kind: "tick"; ms: number };

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.constant<Action>({ kind: "now" }),
  fc.constant<Action>({ kind: "throttle" }),
  fc.constant<Action>({ kind: "toggle" }),
  fc.record({ kind: fc.constant<"tick">("tick"), ms: fc.integer({ min: 1, max: 300 }) }),
);

describe("renderGate property: no lost updates, never commits while hidden (vue-plan.md v2.1 §3.5 acceptance 4)", () => {
  it("random event/visibility/clock interleavings always converge to the latest counter with zero hidden-time commits", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 0, maxLength: 250 }), (actions) => {
        const clock = fakeClock();
        const { doc, win, setHidden, fireVisible } = fakeDocWin(false);
        let counter = 0;
        let committed = -1;
        let hiddenCommits = 0;

        const gate = createRenderGate({
          commit: () => {
            if (doc.hidden) hiddenCommits++; // must never happen — the one rule §3.5 exists to enforce
            committed = counter;
          },
          setTimeout: clock.setTimeout,
          clearTimeout: clock.clearTimeout,
          now: clock.now,
          doc,
          win,
        });

        for (const action of actions) {
          switch (action.kind) {
            case "now": {
              counter++;
              gate.request("now" satisfies RenderPriority);
              break;
            }
            case "throttle": {
              counter++;
              gate.request("throttle" satisfies RenderPriority);
              break;
            }
            case "toggle":
              setHidden(!doc.hidden);
              break;
            case "tick":
              clock.advance(action.ms);
              break;
          }
        }

        // Force a final visible flush the way a real tab coming back to the foreground would —
        // this is the "no永久停滞" guarantee: whatever happened above, the state converges here.
        setHidden(false);
        fireVisible();
        gate.dispose();

        expect(committed).toBe(counter); // no update was ever lost
        expect(hiddenCommits).toBe(0); // no commit ever happened while hidden
      }),
      { numRuns: 300 },
    );
  });

  it("dispose() after any interleaving leaves zero pending timers, regardless of visibility at teardown", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { minLength: 0, maxLength: 100 }), fc.boolean(), (actions, endHidden) => {
        const clock = fakeClock();
        const { doc, win, setHidden } = fakeDocWin(false);
        const gate = createRenderGate({
          commit: () => {},
          setTimeout: clock.setTimeout,
          clearTimeout: clock.clearTimeout,
          now: clock.now,
          doc,
          win,
        });
        for (const action of actions) {
          switch (action.kind) {
            case "now":
              gate.request("now");
              break;
            case "throttle":
              gate.request("throttle");
              break;
            case "toggle":
              setHidden(!doc.hidden);
              break;
            case "tick":
              clock.advance(action.ms);
              break;
          }
        }
        setHidden(endHidden);
        gate.dispose();
        expect(clock.pending()).toBe(0);
      }),
      { numRuns: 200 },
    );
  });
});
