import { describe, expect, it, vi } from "vitest";
import { parseRouteHash, routeToHash, useHashRoute } from "../../../src/web-hub/ui/src/composables/useHashRoute.js";

/** Minimal fake `Window` — plan §3.7. */
function fakeWindow(initialHash: string) {
  let hash = initialHash;
  const listeners = new Map<string, Set<(ev: Event) => void>>();
  return {
    location: {
      get hash() {
        return hash;
      },
      set hash(v: string) {
        hash = v;
        for (const fn of listeners.get("hashchange") ?? []) fn(new Event("hashchange"));
      },
    },
    history: { replaceState: vi.fn() },
    addEventListener(name: string, fn: (ev: Event) => void) {
      const set = listeners.get(name) ?? new Set();
      set.add(fn);
      listeners.set(name, set);
    },
    removeEventListener(name: string, fn: (ev: Event) => void) {
      listeners.get(name)?.delete(fn);
    },
    _listenerCount: (name: string) => listeners.get(name)?.size ?? 0,
  };
}

describe("parseRouteHash", () => {
  it.each([
    ["#/", { name: "list" }],
    ["", { name: "list" }],
    ["#/agent/", { name: "list" }],
    ["#/agent/abc", { name: "agent", key: "abc" }],
    ["#/agent/a%2Fb", { name: "agent", key: "a/b" }],
    ["#t=some-token", { name: "list" }], // §3.7: a lingering token fragment must never parse as an agent key
    ["#/agent/%", { name: "list" }], // malformed percent-encoding degrades to list, never throws
    ["#unrelated", { name: "list" }],
  ] as const)("%s → %o", (hash, expected) => {
    expect(parseRouteHash(hash)).toEqual(expected);
  });
});

describe("routeToHash", () => {
  it("round-trips through parseRouteHash", () => {
    expect(routeToHash({ name: "list" })).toBe("#/");
    expect(parseRouteHash(routeToHash({ name: "agent", key: "a/b c" }))).toEqual({ name: "agent", key: "a/b c" });
  });
});

describe("useHashRoute", () => {
  it("reflects the initial hash synchronously, before start()", () => {
    const win = fakeWindow("#/agent/x1");
    const handle = useHashRoute(win);
    expect(handle.route.value).toEqual({ name: "agent", key: "x1" });
  });

  it("does not listen for hashchange until start() is called (ordering constraint, plan §3.7)", () => {
    const win = fakeWindow("#/");
    useHashRoute(win);
    expect(win._listenerCount("hashchange")).toBe(0);
  });

  it("start() begins listening and re-parses on hashchange", () => {
    const win = fakeWindow("#/");
    const handle = useHashRoute(win);
    handle.start();
    expect(win._listenerCount("hashchange")).toBe(1);
    win.location.hash = "#/agent/x2";
    expect(handle.route.value).toEqual({ name: "agent", key: "x2" });
  });

  it("navigate() sets location.hash and updates route", () => {
    const win = fakeWindow("#/");
    const handle = useHashRoute(win);
    handle.start();
    handle.navigate({ name: "agent", key: "abc" });
    expect(win.location.hash).toBe("#/agent/abc");
    expect(handle.route.value).toEqual({ name: "agent", key: "abc" });
  });

  it("dispose() removes the hashchange listener", () => {
    const win = fakeWindow("#/");
    const handle = useHashRoute(win);
    handle.start();
    handle.dispose();
    expect(win._listenerCount("hashchange")).toBe(0);
  });
});
