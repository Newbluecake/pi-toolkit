/**
 * `composables/useEffectiveDark.ts` (web-hub-mermaid plan §6.1, P2). Pure decision table for
 * the theme precedence + the shared-observer lifecycle (refcount, single observers, teardown on
 * last release, re-init after teardown) driven through injected fakes — no DOM needed.
 */
import { describe, expect, it } from "vitest";
import { effectScope } from "vue";
import {
  computeEffectiveDark,
  useEffectiveDark,
  type EffectiveDarkElement,
  type EffectiveDarkWindow,
  type MutationObserverLike,
} from "../../../src/web-hub/ui/src/composables/useEffectiveDark.js";

class FakeMutationObserver implements MutationObserverLike {
  static instances: FakeMutationObserver[] = [];
  readonly observed: Array<{ target: unknown; options: unknown }> = [];
  disconnected = false;
  constructor(readonly cb: () => void) {
    FakeMutationObserver.instances.push(this);
  }
  observe(target: unknown, options: { attributes: boolean; attributeFilter: string[] }): void {
    this.observed.push({ target, options });
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

/** Live element: `classList.contains` reads the shared mutable state (class flips reflect). */
function liveEl(state: { classes: string[] }): EffectiveDarkElement {
  return { classList: { contains: (c: string) => state.classes.includes(c) } };
}

function fakeWin(classes: readonly string[], mqlMatches: boolean) {
  const state = { classes: [...classes], matches: mqlMatches };
  let changeListener: ((ev: { matches: boolean }) => void) | undefined;
  const win: EffectiveDarkWindow = {
    document: { documentElement: liveEl(state) },
    matchMedia: () => ({
      get matches() {
        return state.matches;
      },
      addEventListener: (_t: "change", l: (ev: { matches: boolean }) => void) => {
        changeListener = l;
      },
      removeEventListener: () => {
        changeListener = undefined;
      },
    }),
    MutationObserver: class extends FakeMutationObserver {},
  };
  return {
    win,
    state,
    fireMql(matches: boolean): void {
      state.matches = matches;
      changeListener?.({ matches });
    },
  };
}

describe("computeEffectiveDark (pure, plan §6.1)", () => {
  it("theme-dark wins; theme-light blocks; otherwise the OS query decides", () => {
    expect(computeEffectiveDark({ classList: { contains: (c) => c === "theme-dark" } }, false)).toBe(true);
    expect(computeEffectiveDark({ classList: { contains: (c) => c === "theme-dark" } }, true)).toBe(true);
    expect(computeEffectiveDark({ classList: { contains: (c) => c === "theme-light" } }, true)).toBe(false);
    expect(computeEffectiveDark({ classList: { contains: () => false } }, true)).toBe(true);
    expect(computeEffectiveDark({ classList: { contains: () => false } }, false)).toBe(false);
    expect(computeEffectiveDark(null, true)).toBe(true); // no document — fall back to the OS query
    expect(computeEffectiveDark({ classList: { contains: () => false } }, undefined)).toBe(false); // fail to light
  });
});

describe("useEffectiveDark (shared observers, refcount)", () => {
  it("multiple consumers share ONE observer set; the class flip resyncs everyone", () => {
    const { win, state } = fakeWin([], false);
    const s1 = effectScope();
    const s2 = effectScope();
    const d1 = s1.run(() => useEffectiveDark(win))!;
    const d2 = s2.run(() => useEffectiveDark(win))!;
    expect(d1).toBe(d2); // the same shared ref
    expect(FakeMutationObserver.instances.length).toBe(1);
    const obs = FakeMutationObserver.instances[0]!;
    expect(obs.observed[0]!.options).toEqual({ attributes: true, attributeFilter: ["class"] });
    expect(d1.value).toBe(false);

    state.classes.push("theme-dark"); // the <html> class flip
    obs.cb();
    expect(d1.value).toBe(true);

    s1.stop(); // first scope out — observers stay alive
    expect(obs.disconnected).toBe(false);
    s2.stop(); // last scope out — released
    expect(obs.disconnected).toBe(true);
  });

  it("re-initializes after full teardown (new observer for the new consumer)", () => {
    const { win } = fakeWin(["theme-dark"], false);
    const before = FakeMutationObserver.instances.length;
    const s = effectScope();
    const d = s.run(() => useEffectiveDark(win))!;
    expect(d.value).toBe(true);
    const first = FakeMutationObserver.instances.at(-1)!;
    s.stop();
    expect(first.disconnected).toBe(true);

    const s2 = effectScope();
    const d2 = s2.run(() => useEffectiveDark(win))!;
    expect(FakeMutationObserver.instances.length).toBe(before + 2);
    expect(d2.value).toBe(true);
    s2.stop();
  });

  it("the OS-query flip (no explicit theme classes) resyncs through the mql listener", () => {
    const { win, fireMql } = fakeWin([], false);
    const s = effectScope();
    const d = s.run(() => useEffectiveDark(win))!;
    expect(d.value).toBe(false);
    fireMql(true);
    expect(d.value).toBe(true);
    fireMql(false);
    expect(d.value).toBe(false);
    s.stop();
  });

  it("is usable without a document: pure mql fallback, no observer installed", () => {
    const win: EffectiveDarkWindow = { matchMedia: () => ({ matches: true }) };
    const s = effectScope();
    const d = s.run(() => useEffectiveDark(win))!;
    expect(d.value).toBe(true);
    expect(FakeMutationObserver.instances.filter((i) => !i.disconnected).length).toBe(0);
    s.stop();
  });
});
