import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  // web-hub-spawn SP13（SP11/SP12 移交）：App.vue 把 useHub 的 navigate 选项接到真实 hash 路由。
  // 行为两半已有各自的行为测试：use-new-session.test.ts（「我发起的」live ⇒ navigate(agentKey)
  // 恰一次）与本文件上文（navigate ⇒ location.hash）；这里钉住组合本身——App.vue 必须以闭包把
  // hashRoute.navigate 传给 useHub，且形状为 {name:"agent", key}（live ⇒ #/agent/<key>）。
  it("App.vue wires useHub's navigate option to the real hash router (SP13 composition pin)", () => {
    const src = readFileSync(resolve("src/web-hub/ui/src/App.vue"), "utf8");
    expect(src).toMatch(
      /navigate:\s*\(agentKey\)\s*=>\s*\{\s*hashRoute\?\.navigate\(\{\s*name:\s*"agent",\s*key:\s*agentKey,?\s*\}\);?\s*\}/,
    );
    // the option must reach the useHub call itself (not some dead closure)
    const useHubCall = /hub = useHub\(\{[\s\S]*?\}\);/.exec(src);
    expect(useHubCall).toBeDefined();
    expect(useHubCall![0]).toContain("navigate:");
  });
});
