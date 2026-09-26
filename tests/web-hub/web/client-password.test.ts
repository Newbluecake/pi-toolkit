import { afterEach, describe, expect, it } from "vitest";
import {
  createPasswordClient,
  LOGIN_TIMEOUT_MS,
  BUSY_RETRY_MAX,
  CLOSE_PROBE_MAX,
  CLOSE_PROBE_BACKOFF_MS,
  BACKOFF_MIN_MS,
} from "../../../src/web-hub/web/password-client.js";
import { SILENCE_MS } from "../../../src/web-hub/web/contract.js";

/**
 * Unit tests for the password-mode transport (plan §10, package LF).
 * Chromium-verified assumption baked into the implementation (see the
 * module docstring): a non-200 response to `/api/events` always fails the
 * EventSource connection (readyState CLOSED, no browser auto-retry) — 401
 * and 503 are indistinguishable from `error` alone, so both collapse into
 * the same "show the form" path here. That assumption is exercised by the
 * "CLOSED" tests below (they don't and can't claim to know *why* it closed).
 */

/** Deterministic timer queue (mirrors client.test.ts's clock — no real timers). */
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
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

class FakeES {
  static all: FakeES[] = [];
  readyState = 0;
  closed = false;
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
  fail(closed: boolean) {
    this.readyState = closed ? 2 : 0;
    for (const fn of this.listeners.get("error") ?? []) fn({});
  }
  close() {
    this.closed = true;
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

function env(opts: { fetch?: (url: string, init: any) => Promise<Resp>; hash?: string } = {}) {
  const c = clock();
  const calls: Array<{ url: string; init: any }> = [];
  const messages: any[] = [];
  const conns: string[] = [];
  const authEvents: string[] = [];
  const unauthed: number[] = [];
  const sessionInfos: any[] = [];
  const retries: string[] = [];
  const replaced: string[] = [];
  const location = { hash: opts.hash ?? "", pathname: "/", search: "?x=1" };
  const client = createPasswordClient({
    fetch: (url: string, init: any) => {
      calls.push({ url, init });
      return opts.fetch ? opts.fetch(url, init) : Promise.resolve(resp(200));
    },
    EventSource: FakeES as any,
    location,
    history: {
      replaceState: (_d: unknown, _u: string, url?: string) => {
        replaced.push(String(url));
        location.hash = "";
      },
    },
    setTimeout: c.setTimeout as any,
    clearTimeout: c.clearTimeout as any,
    now: c.now,
    onMessage: (m) => messages.push(m),
    onConn: (s) => conns.push(s),
    onAuthEvent: (r) => authEvents.push(r),
    onUnauthenticated: () => unauthed.push(1),
    onSessionInfo: (info) => sessionInfos.push(info),
    onLoginRetry: (k) => retries.push(k),
  });
  return { c, calls, messages, conns, authEvents, unauthed, sessionInfos, retries, replaced, client, location };
}

afterEach(() => {
  FakeES.all = [];
});

describe("createPasswordClient: startup / #t= / session probe", () => {
  it("never sends the hash token; only clears it via replaceState", async () => {
    const e = env({ hash: "#t=deadbeef" });
    await e.client.start();
    expect(e.replaced).toEqual(["/?x=1"]);
    expect(e.location.hash).toBe("");
    // exactly one call: GET /api/session (the diagnostic probe) — never /api/login
    expect(e.calls.map((c) => c.url)).toEqual(["/api/session"]);
    expect(e.calls.every((c) => JSON.stringify(c.init ?? {}).includes("token") === false)).toBe(true);
    expect(FakeES.all).toHaveLength(1);
    expect(FakeES.all[0]!.url).toBe("/api/events");
    expect(FakeES.all[0]!.opts).toMatchObject({ withCredentials: true });
    e.client.close();
  });

  it("no hash: still probes /api/session and opens the stream", async () => {
    const e = env();
    await e.client.start();
    expect(e.calls.map((c) => c.url)).toEqual(["/api/session"]);
    expect(FakeES.all).toHaveLength(1);
    e.client.close();
  });

  it("/api/session initialPasswordInUse:true is surfaced; a failed probe is swallowed (diagnostic only)", async () => {
    const e = env({ fetch: async () => resp(200, { username: "alice", initialPasswordInUse: true }) });
    await e.client.start();
    await flush();
    expect(e.sessionInfos).toEqual([{ initialPasswordInUse: true }]);
    e.client.close();
  });

  it("/api/session 401 (not signed in yet) reports nothing — never shows an error", async () => {
    const e = env({ fetch: async () => resp(401, { error: "E_AUTH" }) });
    await e.client.start();
    await flush();
    expect(e.sessionInfos).toEqual([]);
    e.client.close();
  });
});

describe("createPasswordClient: SSE lifecycle", () => {
  it("hello ⇒ open; frames forwarded with numeric ids", async () => {
    const e = env();
    await e.client.start();
    const es = FakeES.all[0]!;
    es.emit("hello", { clientId: "c1" }, "5");
    es.emit("ping", {});
    expect(e.messages).toEqual([
      { event: "hello", data: { clientId: "c1" }, id: 5 },
      { event: "ping", data: {} },
    ]);
    expect(e.conns.at(-1)).toBe("open");
    e.client.close();
  });

  it('event: auth {reason:"revoked"} closes the stream and reports the reason (not the generic error path)', async () => {
    const e = env();
    await e.client.start();
    const es = FakeES.all[0]!;
    es.emit("hello", { clientId: "c1" });
    es.emit("auth", { reason: "revoked" });
    expect(e.authEvents).toEqual(["revoked"]);
    expect(e.conns.at(-1)).toBe("auth");
    expect(es.closed).toBe(true);
    // stale-stream frames after the auth event are dropped
    es.emit("ping", {});
    expect(e.messages.some((m) => m.event === "ping")).toBe(false);
    e.client.close();
  });

  it('event: auth {reason:"expired"} is distinguished from "revoked"', async () => {
    const e = env();
    await e.client.start();
    FakeES.all[0]!.emit("auth", { reason: "expired" });
    expect(e.authEvents).toEqual(["expired"]);
    e.client.close();
  });

  it("CLOSED + session probe 401 (genuinely signed out) ⇒ onConn(auth) + onUnauthenticated, no auth-event reason claimed", async () => {
    const e = env({ fetch: async () => resp(401, { error: "E_AUTH" }) });
    await e.client.start();
    await flush();
    FakeES.all[0]!.fail(true);
    await flush();
    expect(e.conns.at(-1)).toBe("auth");
    expect(e.unauthed).toEqual([1]);
    expect(e.authEvents).toEqual([]); // never fabricates a revoked/expired reason for a bare close
    e.client.close();
  });

  it("CLOSED + session probe 200 (still signed in, e.g. hub restarted the SSE layer) ⇒ keeps the page, never shows the login form, reopens on the normal backoff", async () => {
    const e = env({ fetch: async () => resp(200, { username: "alice", initialPasswordInUse: false }) });
    await e.client.start();
    await flush();
    FakeES.all[0]!.fail(true);
    await flush();
    expect(e.unauthed).toEqual([]); // review fix (lan-plan.md §15.9 #8): 503-shaped CLOSED must not be treated as logout
    expect(e.conns.at(-1)).not.toBe("auth");
    expect(FakeES.all).toHaveLength(1); // not reopened yet — waiting on the normal reopen backoff
    await e.c.advance(2_000);
    expect(FakeES.all).toHaveLength(2); // reopened once the session was confirmed still valid
    e.client.close();
  });

  it("CLOSED + session probe 503/network error ⇒ keeps current state (no login form, no auth signal) and re-probes up to CLOSE_PROBE_MAX times before falling back to a stream reopen", async () => {
    const e = env({
      fetch: async (url: string) => (url === "/api/session" ? resp(503, { error: "E_DB" }) : resp(200)),
    });
    await e.client.start();
    await flush();
    const sessionCallsBefore = e.calls.filter((c) => c.url === "/api/session").length;
    FakeES.all[0]!.fail(true);
    await flush();
    for (let i = 0; i < CLOSE_PROBE_MAX - 1; i++) {
      await e.c.advance(CLOSE_PROBE_BACKOFF_MS);
    }
    const sessionCallsAfter = e.calls.filter((c) => c.url === "/api/session").length;
    // exactly CLOSE_PROBE_MAX probe attempts happened, never unbounded, and the page was never
    // treated as signed out or shown any auth-mode change while probing.
    expect(sessionCallsAfter - sessionCallsBefore).toBe(CLOSE_PROBE_MAX);
    expect(e.unauthed).toEqual([]);
    expect(e.conns.at(-1)).not.toBe("auth");
    expect(FakeES.all).toHaveLength(1); // still no reopen yet — falls back to the ordinary reopen schedule next
    await e.c.advance(BACKOFF_MIN_MS);
    expect(FakeES.all).toHaveLength(2); // bounded: gives up re-probing and falls back to reopening the stream
    e.client.close();
  });

  it("transient error (CONNECTING) leaves reconnection to the browser — no onUnauthenticated", async () => {
    const e = env();
    await e.client.start();
    FakeES.all[0]!.fail(false);
    await flush();
    expect(e.conns.at(-1)).toBe("reconnecting");
    expect(e.unauthed).toEqual([]);
    expect(FakeES.all).toHaveLength(1); // browser handles it; the client did not reopen anything itself
    e.client.close();
  });

  it("45s without any frame ⇒ closes and reopens exactly one stream", async () => {
    const e = env();
    await e.client.start();
    const first = FakeES.all[0]!;
    await e.c.advance(SILENCE_MS - 5_000);
    first.emit("ping", {});
    await e.c.advance(SILENCE_MS - 5_000);
    expect(FakeES.all).toHaveLength(1);
    await e.c.advance(10_000);
    expect(FakeES.all).toHaveLength(2);
    e.client.close();
  });

  it("close() stops everything: no reopen after close", async () => {
    const e = env();
    await e.client.start();
    e.client.close();
    FakeES.all[0]!.fail(true);
    await e.c.advance(120_000);
    expect(FakeES.all).toHaveLength(1);
    expect(e.c.pending()).toBe(0);
  });
});

describe("createPasswordClient: login()", () => {
  it("success: body has no token field, credentials same-origin, X-PWH header, then reopens the stream", async () => {
    const e = env({
      fetch: async (url, init) => (url === "/api/login" ? resp(200, { initialPassword: false }) : resp(200)),
    });
    await e.client.start();
    const before = FakeES.all.length;
    const r = await e.client.login("alice", "s3cret");
    expect(r).toEqual({ ok: true, initialPassword: false });
    const loginCall = e.calls.find((c) => c.url === "/api/login")!;
    expect(loginCall.init.method).toBe("POST");
    expect(loginCall.init.credentials).toBe("same-origin");
    expect(loginCall.init.headers).toMatchObject({ "Content-Type": "application/json", "X-PWH": "1" });
    const sentBody = JSON.parse(loginCall.init.body);
    expect(sentBody).toEqual({ username: "alice", password: "s3cret" });
    expect("token" in sentBody).toBe(false);
    expect(FakeES.all.length).toBeGreaterThan(before); // "成功 ⇒ 重开流"
    e.client.close();
  });

  it("initialPassword:true is surfaced on the success result", async () => {
    const e = env({ fetch: async () => resp(200, { initialPassword: true }) });
    await e.client.start();
    expect(await e.client.login("alice", "initial-pw")).toEqual({ ok: true, initialPassword: true });
    e.client.close();
  });

  it("401 ⇒ invalid, single attempt, no retry", async () => {
    let n = 0;
    const e = env({
      fetch: async (url) => {
        if (url === "/api/session") return resp(200);
        n++;
        return resp(401, { error: "E_AUTH" });
      },
    });
    await e.client.start();
    expect(await e.client.login("alice", "wrong")).toEqual({ ok: false, kind: "invalid" });
    expect(n).toBe(1);
    e.client.close();
  });

  it("421 ⇒ not-allowed, single attempt, no retry", async () => {
    const e = env({ fetch: async (url) => (url === "/api/login" ? resp(421) : resp(200)) });
    await e.client.start();
    expect(await e.client.login("alice", "x")).toEqual({ ok: false, kind: "not-allowed" });
    expect(e.calls.filter((c) => c.url === "/api/login")).toHaveLength(1);
    e.client.close();
  });

  it("429 saturated:true ⇒ single attempt, no retry, retryAfterS from the header", async () => {
    const e = env({
      fetch: async (url) => (url === "/api/login" ? resp(429, { error: "E_RATE", saturated: true }, "90") : resp(200)),
    });
    await e.client.start();
    expect(await e.client.login("alice", "x")).toEqual({ ok: false, kind: "saturated", retryAfterS: 90 });
    expect(e.calls.filter((c) => c.url === "/api/login")).toHaveLength(1);
    e.client.close();
  });

  it("429 plain (no saturated, no E_RATE) ⇒ throttled with a countdown, no auto-retry by the client itself", async () => {
    const e = env({ fetch: async (url) => (url === "/api/login" ? resp(429, {}, "12") : resp(200)) });
    await e.client.start();
    const p = e.client.login("alice", "x");
    await e.c.advance(60_000); // even a long wait must not trigger an internal retry for this case
    expect(await p).toEqual({ ok: false, kind: "throttled", retryAfterS: 12 });
    expect(e.calls.filter((c) => c.url === "/api/login")).toHaveLength(1);
    e.client.close();
  });

  it("429 E_RATE (in-flight quota) auto-retries after Retry-After and reports the retry to the caller", async () => {
    let n = 0;
    const e = env({
      fetch: async (url) => {
        if (url !== "/api/login") return resp(200);
        n++;
        return n === 1 ? resp(429, { error: "E_RATE" }, "3") : resp(200, { initialPassword: false });
      },
    });
    await e.client.start();
    const p = e.client.login("alice", "x");
    await flush();
    expect(e.retries).toEqual(["rate"]);
    expect(n).toBe(1); // second attempt is still pending on the Retry-After timer
    await e.c.advance(3_000);
    expect(await p).toEqual({ ok: true, initialPassword: false });
    expect(n).toBe(2);
    e.client.close();
  });

  it("503 retries up to BUSY_RETRY_MAX times then gives up as busy-exhausted", async () => {
    let n = 0;
    const e = env({
      fetch: async (url) => {
        if (url !== "/api/login") return resp(200);
        n++;
        return resp(503, { error: "E_DB" }, "1");
      },
    });
    await e.client.start();
    const p = e.client.login("alice", "x");
    for (let i = 0; i < BUSY_RETRY_MAX + 1; i++) await e.c.advance(1_000);
    expect(await p).toEqual({ ok: false, kind: "busy-exhausted" });
    expect(n).toBe(BUSY_RETRY_MAX + 1); // the first attempt plus BUSY_RETRY_MAX retries
    expect(e.retries.filter((k) => k === "busy")).toHaveLength(BUSY_RETRY_MAX);
    e.client.close();
  });

  it("503 that recovers before the cap resolves ok — cookie/form untouched by 503 itself (no auth-mode side effects)", async () => {
    let n = 0;
    const e = env({
      fetch: async (url) => {
        if (url !== "/api/login") return resp(200);
        n++;
        return n <= 2 ? resp(503, {}, "1") : resp(200, { initialPassword: false });
      },
    });
    await e.client.start();
    const p = e.client.login("alice", "x");
    for (let i = 0; i < 3; i++) await e.c.advance(1_000);
    expect(await p).toEqual({ ok: true, initialPassword: false });
    expect(e.authEvents).toEqual([]);
    expect(e.unauthed).toEqual([]);
    e.client.close();
  });

  it("network error (fetch rejects) ⇒ network, single attempt", async () => {
    const e = env({ fetch: async (url) => (url === "/api/login" ? Promise.reject(new Error("boom")) : resp(200)) });
    await e.client.start();
    expect(await e.client.login("alice", "x")).toEqual({ ok: false, kind: "network" });
    e.client.close();
  });

  it(`login uses a ${LOGIN_TIMEOUT_MS}ms deadline (not the shorter default)`, async () => {
    const e = env({ fetch: async (url) => (url === "/api/login" ? new Promise<any>(() => {}) : resp(200)) });
    await e.client.start();
    const p = e.client.login("alice", "x");
    await e.c.advance(LOGIN_TIMEOUT_MS - 1);
    let settled = false;
    void p.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    await e.c.advance(1);
    expect(await p).toEqual({ ok: false, kind: "network" });
    e.client.close();
  });
});

describe("createPasswordClient: logout()", () => {
  it("posts /api/logout, then closes the stream and reports unauthenticated (best effort even if the request fails)", async () => {
    const e = env({ fetch: async (url) => (url === "/api/logout" ? Promise.reject(new Error("boom")) : resp(200)) });
    await e.client.start();
    await e.client.logout();
    expect(e.calls.some((c) => c.url === "/api/logout" && c.init.method === "POST")).toBe(true);
    expect(e.conns.at(-1)).toBe("auth");
    expect(e.unauthed).toEqual([1]);
    e.client.close();
  });
});
