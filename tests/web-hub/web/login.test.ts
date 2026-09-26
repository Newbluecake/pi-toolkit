import { afterEach, describe, expect, it } from "vitest";
import { mountAuthApp } from "../../../src/web-hub/web/app.js";
import { BUSY_RETRY_MAX } from "../../../src/web-hub/web/password-client.js";
import { fakeDocument, FakeElement } from "./fake-dom.js";

/**
 * Full mountPasswordApp integration tests (plan §10, package LF): the login
 * form, its error copy per status/body, the initial-password banner, the
 * plaintext notice, and sign-out. `client-password.test.ts` covers the
 * lower-level transport in isolation; `auth-mode.test.ts` covers the
 * three-state `data-auth-mode` gate.
 */

function clock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: number) => void timers.delete(id),
    pending: () => timers.size,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

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
  emit(name: string, data: unknown) {
    for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(data), lastEventId: "" });
  }
  close() {
    this.readyState = 2;
  }
}

type Resp = { ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<any> };
const resp = (status: number, body: unknown = {}, retryAfter?: string): Resp => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (n) => (n === "Retry-After" && retryAfter !== undefined ? retryAfter : null) },
  json: async () => body,
});

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
const initiallyHidden = new Set([
  "auth-mode-error",
  "login-screen",
  "plaintext-notice",
  "login",
  "signout",
  "initial-password-banner",
]);

function setup(opts: { protocol?: string; fetch?: (url: string, init: any) => Promise<Resp> } = {}) {
  FakeES.all = [];
  const c = clock();
  const base = fakeDocument();
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
    documentElement: { dataset: { authMode: "password" } },
    getElementById: (id: string) => nodes.get(id) ?? null,
  };
  const rafs: Array<() => void> = [];
  const storageCalls: Array<{ op: string; key: string }> = [];
  const fetchCalls: Array<{ url: string; init: any }> = [];
  const win = {
    fetch: (url: string, init: any) => {
      fetchCalls.push({ url, init });
      return opts.fetch ? opts.fetch(url, init) : Promise.resolve(resp(200));
    },
    EventSource: FakeES,
    localStorage: {
      getItem: (k: string) => {
        storageCalls.push({ op: "get", key: k });
        return null;
      },
      setItem: (k: string, v: string) => {
        storageCalls.push({ op: "set", key: k });
      },
      removeItem: (k: string) => {
        storageCalls.push({ op: "remove", key: k });
      },
    },
    location: { hash: "", pathname: "/", search: "", protocol: opts.protocol ?? "https:" },
    history: { replaceState: () => {} },
    setTimeout: c.setTimeout,
    clearTimeout: c.clearTimeout,
    requestAnimationFrame: (fn: () => void) => rafs.push(fn),
    addEventListener: () => {},
  };
  const paint = () => {
    while (rafs.length) rafs.shift()!();
  };
  const submit = (username: string, password: string) => {
    nodes.get("login-username")!.value = username;
    nodes.get("login-password")!.value = password;
    nodes.get("login")!.dispatch("submit", {});
  };
  return { win, doc: doc as any, nodes, c, paint, submit, storageCalls, fetchCalls };
}

afterEach(() => {
  FakeES.all = [];
});

describe("mountPasswordApp: login form", () => {
  it("mounts with the form visible and the app shell hidden until authenticated", async () => {
    const { win, doc, nodes } = setup();
    mountAuthApp(win, doc);
    await flush();
    expect(nodes.get("login-screen")!.hidden).toBe(false);
    expect(nodes.get("app")!.hidden).toBe(true);
  });

  it("plaintext notice only follows location.protocol (http: shows it, https: hides it)", async () => {
    for (const [protocol, expectVisible] of [
      ["http:", true],
      ["https:", false],
    ] as const) {
      const { win, doc, nodes } = setup({ protocol });
      mountAuthApp(win, doc);
      await flush();
      expect(nodes.get("plaintext-notice")!.hidden).toBe(!expectVisible);
    }
  });

  it("401 ⇒ Invalid username or password., no localStorage write, submit re-enabled", async () => {
    const { win, doc, nodes, submit, storageCalls } = setup({
      fetch: async (url) => (url === "/api/login" ? resp(401, { error: "E_AUTH" }) : resp(200)),
    });
    mountAuthApp(win, doc);
    await flush();
    submit("alice", "wrong");
    await flush();
    expect(nodes.get("login-error")!.textContent).toBe("Invalid username or password.");
    expect(nodes.get("login-submit")!.disabled).toBe(false);
    expect(nodes.get("app")!.hidden).toBe(true);
    expect(storageCalls).toEqual([]); // never touches localStorage in password mode
  });

  it("success ⇒ password field cleared, form hidden, app shown, fetch(API.login) body never has a token field", async () => {
    const { win, doc, nodes, submit, fetchCalls } = setup({
      fetch: async (url) => (url === "/api/login" ? resp(200, { initialPassword: false }) : resp(200)),
    });
    mountAuthApp(win, doc);
    await flush();
    submit("alice", "s3cret");
    await flush();
    const loginCall = fetchCalls.find((c) => c.url === "/api/login")!;
    const body = JSON.parse(loginCall.init.body);
    expect(body).toEqual({ username: "alice", password: "s3cret" });
    expect("token" in body).toBe(false);
    expect(nodes.get("login-password")!.value).toBe("");
    FakeES.all.at(-1)!.emit("hello", { clientId: "c1" }); // the reopened stream announces itself
    await flush();
    expect(nodes.get("login-screen")!.hidden).toBe(true);
    expect(nodes.get("app")!.hidden).toBe(false);
  });

  it("429 saturated ⇒ unlock hint, no retry, exactly one login POST", async () => {
    const { win, doc, nodes, submit, fetchCalls } = setup({
      fetch: async (url) => (url === "/api/login" ? resp(429, { error: "E_RATE", saturated: true }, "60") : resp(200)),
    });
    mountAuthApp(win, doc);
    await flush();
    submit("alice", "x");
    await flush();
    expect(nodes.get("login-error")!.textContent).toBe(
      'Sign-in from new addresses is temporarily blocked. Ask the host to run "/webhub unlock".',
    );
    expect(nodes.get("login-submit")!.disabled).toBe(false);
    expect(fetchCalls.filter((c) => c.url === "/api/login")).toHaveLength(1);
  });

  it("429 plain ⇒ countdown text ticks down every second, then re-enables the form (no auto-resubmit)", async () => {
    const { win, doc, nodes, submit, fetchCalls, c } = setup({
      fetch: async (url) => (url === "/api/login" ? resp(429, {}, "3") : resp(200)),
    });
    mountAuthApp(win, doc);
    await flush();
    submit("alice", "x");
    await flush();
    expect(nodes.get("login-error")!.textContent).toBe("Too many attempts. Try again in 3s.");
    expect(nodes.get("login-submit")!.disabled).toBe(true);
    await c.advance(1_000);
    expect(nodes.get("login-error")!.textContent).toBe("Too many attempts. Try again in 2s.");
    await c.advance(1_000);
    expect(nodes.get("login-error")!.textContent).toBe("Too many attempts. Try again in 1s.");
    await c.advance(1_000);
    expect(nodes.get("login-error")!.textContent).toBe("");
    expect(nodes.get("login-submit")!.disabled).toBe(false);
    expect(fetchCalls.filter((c2) => c2.url === "/api/login")).toHaveLength(1); // never auto-resubmitted
  });

  it('429 E_RATE ⇒ "retrying…" then auto-succeeds without another click', async () => {
    let n = 0;
    const { win, doc, nodes, submit, fetchCalls, c } = setup({
      fetch: async (url) => {
        if (url !== "/api/login") return resp(200);
        n++;
        return n === 1 ? resp(429, { error: "E_RATE" }, "2") : resp(200, { initialPassword: false });
      },
    });
    mountAuthApp(win, doc);
    await flush();
    submit("alice", "x");
    await flush();
    expect(nodes.get("login-error")!.textContent).toBe("Too many requests, retrying…");
    await c.advance(2_000);
    FakeES.all.at(-1)!.emit("hello", { clientId: "c1" });
    await flush();
    expect(nodes.get("app")!.hidden).toBe(false);
    expect(fetchCalls.filter((c2) => c2.url === "/api/login")).toHaveLength(2);
  });

  it(`503 ⇒ "Hub is busy, retrying…", up to ${BUSY_RETRY_MAX} retries, then a manual-retry message; cookie/form-visibility untouched throughout`, async () => {
    const { win, doc, nodes, submit, fetchCalls, c } = setup({
      fetch: async (url) => (url === "/api/login" ? resp(503, { error: "E_DB" }, "1") : resp(200)),
    });
    mountAuthApp(win, doc);
    await flush();
    submit("alice", "x");
    await flush();
    expect(nodes.get("login-error")!.textContent).toBe("Hub is busy, retrying…");
    expect(nodes.get("login-screen")!.hidden).toBe(false); // never hidden by a 503
    expect(nodes.get("app")!.hidden).toBe(true);
    for (let i = 0; i < BUSY_RETRY_MAX + 1; i++) await c.advance(1_000);
    expect(nodes.get("login-error")!.textContent).toBe("Hub database unavailable — retry");
    expect(nodes.get("login-submit")!.disabled).toBe(false);
    expect(fetchCalls.filter((c2) => c2.url === "/api/login")).toHaveLength(BUSY_RETRY_MAX + 1);
    expect(nodes.get("login-screen")!.hidden).toBe(false);
  });

  it("421 ⇒ allow-list message, no retry", async () => {
    const { win, doc, nodes, submit, fetchCalls } = setup({
      fetch: async (url) => (url === "/api/login" ? resp(421) : resp(200)),
    });
    mountAuthApp(win, doc);
    await flush();
    submit("alice", "x");
    await flush();
    expect(nodes.get("login-error")!.textContent).toBe(
      'This address is not on the hub\'s allow-list. Use one of the addresses shown by "/webhub open".',
    );
    expect(fetchCalls.filter((c) => c.url === "/api/login")).toHaveLength(1);
  });

  it("network error ⇒ Cannot reach hub.", async () => {
    const { win, doc, nodes, submit } = setup({
      fetch: async (url) => (url === "/api/login" ? Promise.reject(new Error("boom")) : resp(200)),
    });
    mountAuthApp(win, doc);
    await flush();
    submit("alice", "x");
    await flush();
    expect(nodes.get("login-error")!.textContent).toBe("Cannot reach hub.");
  });

  it('event: auth {reason:"revoked"} shows the "signed out" message and the form again', async () => {
    const { win, doc, nodes } = setup({
      fetch: async (url) => (url === "/api/login" ? resp(200, { initialPassword: false }) : resp(200)),
    });
    mountAuthApp(win, doc);
    await flush();
    nodes.get("login-username")!.value = "alice";
    nodes.get("login-password")!.value = "s3cret";
    nodes.get("login")!.dispatch("submit", {});
    await flush();
    FakeES.all.at(-1)!.emit("hello", { clientId: "c1" });
    await flush();
    expect(nodes.get("app")!.hidden).toBe(false);
    FakeES.all.at(-1)!.emit("auth", { reason: "revoked" });
    await flush();
    expect(nodes.get("login-error")!.textContent).toBe("Signed out on another tab or by the host.");
    expect(nodes.get("login-screen")!.hidden).toBe(false);
    expect(nodes.get("app")!.hidden).toBe(true);
  });

  it('event: auth {reason:"expired"} shows the session-expired message', async () => {
    const { win, doc, nodes } = setup({
      fetch: async (url) => (url === "/api/login" ? resp(200, { initialPassword: false }) : resp(200)),
    });
    mountAuthApp(win, doc);
    await flush();
    nodes.get("login-username")!.value = "alice";
    nodes.get("login-password")!.value = "s3cret";
    nodes.get("login")!.dispatch("submit", {});
    await flush();
    FakeES.all.at(-1)!.emit("auth", { reason: "expired" });
    await flush();
    expect(nodes.get("login-error")!.textContent).toBe("Session expired — please sign in again.");
  });

  it("initial-password banner shows on login response initialPassword:true, and on /api/session initialPasswordInUse:true", async () => {
    const { win, doc, nodes, submit } = setup({
      fetch: async (url) => (url === "/api/login" ? resp(200, { initialPassword: true }) : resp(200)),
    });
    mountAuthApp(win, doc);
    await flush();
    submit("alice", "initial-pw");
    await flush();
    expect(nodes.get("initial-password-banner")!.hidden).toBe(false);
  });

  it("initial-password banner also follows a fresh /api/session probe on every load", async () => {
    const { win, doc, nodes } = setup({
      fetch: async (url) =>
        url === "/api/session" ? resp(200, { username: "alice", initialPasswordInUse: true }) : resp(200),
    });
    mountAuthApp(win, doc);
    await flush();
    expect(nodes.get("initial-password-banner")!.hidden).toBe(false);
  });

  it("Sign out posts /api/logout and returns to the login form", async () => {
    const { win, doc, nodes } = setup({
      fetch: async (url) => (url === "/api/login" ? resp(200, { initialPassword: false }) : resp(200)),
    });
    mountAuthApp(win, doc);
    await flush();
    nodes.get("login-username")!.value = "alice";
    nodes.get("login-password")!.value = "s3cret";
    nodes.get("login")!.dispatch("submit", {});
    await flush();
    FakeES.all.at(-1)!.emit("hello", { clientId: "c1" });
    await flush();
    expect(nodes.get("app")!.hidden).toBe(false);
    expect(nodes.get("signout")!.hidden).toBe(false);
    nodes.get("signout")!.dispatch("click", {});
    await flush();
    expect(nodes.get("login-screen")!.hidden).toBe(false);
    expect(nodes.get("app")!.hidden).toBe(true);
  });
});
