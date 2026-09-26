import { describe, expect, it } from "vitest";
import { mountAuthApp } from "../../../src/web-hub/web/app.js";
import { fakeDocument, FakeElement } from "./fake-dom.js";

/** Plan §10 row 1: `mountApp` reads `doc.documentElement.dataset.authMode` — three states, no token fallback. */

class FakeES {
  static all: FakeES[] = [];
  readyState = 0;
  listeners = new Map<string, Array<(ev: any) => void>>();
  constructor(
    readonly url: string,
    readonly opts?: any,
  ) {
    FakeES.all.push(this);
  }
  addEventListener(name: string, fn: (ev: any) => void) {
    const l = this.listeners.get(name) ?? [];
    l.push(fn);
    this.listeners.set(name, l);
  }
  emit(name: string, data: unknown, lastEventId = "") {
    for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(data), lastEventId });
  }
  close() {
    this.readyState = 2;
  }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const IDS = [
  "app",
  "conn",
  "hub",
  "agents",
  "banner",
  "session-head",
  "fleet",
  "transcript",
  "auth-mode-error",
  "login-screen",
  "plaintext-notice",
  "login",
  "login-username",
  "login-password",
  "login-submit",
  "login-error",
  "signout",
  "initial-password-banner",
];

function setup(authMode: string | undefined) {
  FakeES.all = [];
  const base = fakeDocument();
  // mirrors index.html's static defaults: everything auth/login-related starts `hidden`.
  const initiallyHidden = new Set([
    "auth-mode-error",
    "login-screen",
    "plaintext-notice",
    "login",
    "signout",
    "initial-password-banner",
  ]);
  const nodes = new Map<string, FakeElement & Record<string, any>>();
  for (const id of IDS) {
    const n = new FakeElement("div") as FakeElement & Record<string, any>;
    n.hidden = initiallyHidden.has(id);
    n.disabled = false;
    n.value = "";
    n.scrollTop = 0;
    n.scrollHeight = 0;
    n.clientHeight = 0;
    nodes.set(id, n);
  }
  const doc = {
    ...base,
    documentElement: { dataset: authMode === undefined ? {} : { authMode } },
    getElementById: (id: string) => nodes.get(id) ?? null,
  };
  const rafs: Array<() => void> = [];
  const fetchCalls: Array<{ url: string; init: any }> = [];
  const storageCalls: Array<{ op: string; key: string; value?: string }> = [];
  const win = {
    fetch: async (url: string, init: any) => {
      fetchCalls.push({ url, init });
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
    },
    EventSource: FakeES,
    localStorage: {
      getItem: (k: string) => {
        storageCalls.push({ op: "get", key: k });
        return null;
      },
      setItem: (k: string, v: string) => {
        storageCalls.push({ op: "set", key: k, value: v });
      },
      removeItem: (k: string) => {
        storageCalls.push({ op: "remove", key: k });
      },
    },
    location: { hash: "", pathname: "/", search: "", protocol: "https:" },
    history: { replaceState: () => {} },
    setTimeout: (fn: () => void) => {
      rafs.push(fn); // never auto-fires; inert unless a test explicitly drains it
      return rafs.length;
    },
    clearTimeout: () => {},
    requestAnimationFrame: (fn: () => void) => rafs.push(fn),
    addEventListener: () => {},
  };
  const paint = () => {
    while (rafs.length) rafs.shift()!();
  };
  return { win, doc: doc as any, nodes, fetchCalls, storageCalls, paint };
}

describe("mountAuthApp: data-auth-mode gate", () => {
  it('authMode="token" delegates to the P1 flow (subscribes over SSE, no login UI touched)', async () => {
    const { win, doc, nodes } = setup("token");
    const app = mountAuthApp(win, doc);
    await flush();
    expect(FakeES.all).toHaveLength(1);
    expect(FakeES.all[0]!.url).toBe("/api/events");
    expect(nodes.get("login-screen")!.hidden).toBe(true);
    expect(nodes.get("auth-mode-error")!.hidden).toBe(true);
    (app as any).client.close();
  });

  it('authMode="password" opens the SSE stream with credentials and shows the login screen while unauthenticated', async () => {
    const { win, doc, nodes } = setup("password");
    const app = mountAuthApp(win, doc);
    await flush();
    expect(FakeES.all).toHaveLength(1);
    expect(FakeES.all[0]!.url).toBe("/api/events");
    expect(FakeES.all[0]!.opts).toMatchObject({ withCredentials: true });
    expect(nodes.get("login-screen")!.hidden).toBe(false);
    expect(nodes.get("app")!.hidden).toBe(true);
    (app as any).client.close();
  });

  for (const bad of [undefined, "", "TOKEN", "Password", "admin"]) {
    it(`authMode=${JSON.stringify(bad)} (missing/invalid) ⇒ error mode: no #t=, no localStorage, no fetch, no SSE`, async () => {
      const { win, doc, nodes, fetchCalls, storageCalls } = setup(bad);
      win.location.hash = "#t=deadbeef";
      mountAuthApp(win, doc);
      await flush();
      expect(nodes.get("auth-mode-error")!.hidden).toBe(false);
      expect(nodes.get("auth-mode-error")!.textContent).toContain("Cannot determine sign-in mode");
      expect(nodes.get("login-screen")!.hidden).toBe(true);
      expect(nodes.get("app")!.hidden).toBe(true);
      expect(FakeES.all).toHaveLength(0);
      expect(fetchCalls).toHaveLength(0);
      expect(storageCalls).toHaveLength(0);
      // the stray hash is left untouched — error mode never reads or clears it
      expect(win.location.hash).toBe("#t=deadbeef");
    });
  }
});
