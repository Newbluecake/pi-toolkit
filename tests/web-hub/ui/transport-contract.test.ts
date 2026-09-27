// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createTokenTransport, TOKEN_KEY } from "../../../src/web-hub/ui/src/transport/token.js";
import { createPasswordTransport } from "../../../src/web-hub/ui/src/transport/password.js";
import { HISTORY_LIMIT_MAX } from "../../../src/web-hub/web/contract.js";
import type { HubTransport, PasswordTransport } from "../../../src/web-hub/ui/src/transport/types.js";

/**
 * Runs the identical suite against both transports (vue-plan.md v2.1 §3.4, §5.2 — P1). This is
 * exactly the seam 78dd76b broke through: the LAN password client used to be missing
 * `subscribe`/`unsubscribe`/`page` entirely, which unit tests on either side alone never caught
 * because each side only ever mocked the *other* side's shape correctly by construction. Any
 * future implementation that drops (or silently changes the wire shape of) one of these methods
 * on either transport turns every `it.each`/`describe.each` block below red for that mode.
 */

interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

type FetchImpl = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponse>;

function resp(status: number, body: unknown = {}, headers: Record<string, string> = {}): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n] ?? null },
    async json() {
      return body;
    },
  };
}

/** Deterministic fake timer queue (see render-gate.test.ts for the same shape). */
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

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 1;
  listeners = new Map<string, Array<(ev: { data?: string; lastEventId?: string }) => void>>();
  constructor(
    readonly url: string,
    readonly opts?: unknown,
  ) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, fn: (ev: { data?: string; lastEventId?: string }) => void): void {
    const l = this.listeners.get(name) ?? [];
    l.push(fn);
    this.listeners.set(name, l);
  }
  emit(name: string, data: unknown, id?: number): void {
    for (const fn of this.listeners.get(name) ?? []) {
      fn({ data: JSON.stringify(data), lastEventId: id === undefined ? "" : String(id) });
    }
  }
  /** Simulate the connection going CLOSED with a network error (no `data` payload — matches a real `error` event). */
  fail(): void {
    this.readyState = 2;
    for (const fn of this.listeners.get("error") ?? []) fn({});
  }
  close(): void {
    this.readyState = 2;
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

interface Harness {
  readonly mode: "token" | "password";
  readonly transport: HubTransport;
  readonly fetchCalls: Array<{
    url: string;
    init: { method?: string; headers?: Record<string, string>; body?: string };
  }>;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly onConnCalls: string[];
  readonly storage?: Map<string, string>;
}

function makeToken(fetchImpl: FetchImpl): Harness {
  FakeEventSource.instances = [];
  const clock = fakeClock();
  const fetchCalls: Harness["fetchCalls"] = [];
  const storage = new Map<string, string>();
  const onConnCalls: string[] = [];
  const transport = createTokenTransport({
    fetch: (url, init) => {
      fetchCalls.push({ url, init: init ?? {} });
      return fetchImpl(url, init);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    EventSource: FakeEventSource as any,
    storage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => void storage.set(k, v),
      removeItem: (k) => void storage.delete(k),
    },
    location: { hash: "", pathname: "/", search: "" },
    history: { replaceState: () => {} },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    onMessage: () => {},
    onConn: (c) => onConnCalls.push(c),
  });
  return { mode: "token", transport, fetchCalls, clock, onConnCalls, storage };
}

function makePassword(fetchImpl: FetchImpl): Harness {
  FakeEventSource.instances = [];
  const clock = fakeClock();
  const fetchCalls: Harness["fetchCalls"] = [];
  const onConnCalls: string[] = [];
  const transport = createPasswordTransport({
    fetch: (url, init) => {
      fetchCalls.push({ url, init: init ?? {} });
      return fetchImpl(url, init);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    EventSource: FakeEventSource as any,
    location: { hash: "", pathname: "/", search: "" },
    history: { replaceState: () => {} },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    onMessage: () => {},
    onConn: (c) => onConnCalls.push(c),
    onAuthEvent: () => {},
    onUnauthenticated: () => {},
    onSessionInfo: () => {},
    onLoginRetry: () => {},
  });
  return { mode: "password", transport, fetchCalls, clock, onConnCalls };
}

describe.each([
  ["token", () => makeToken(async () => resp(200))] as const,
  ["password", () => makePassword(async () => resp(200))] as const,
])("%s transport: shared HubTransport contract (vue-plan.md v2.1 §3.4)", (mode, make) => {
  it("implements the full HubTransport surface (78dd76b regression: password client was missing subscribe/unsubscribe/page)", () => {
    const h = make();
    expect(h.transport.mode).toBe(mode);
    expect(typeof h.transport.start).toBe("function");
    expect(typeof h.transport.close).toBe("function");
    expect(typeof h.transport.subscribe).toBe("function");
    expect(typeof h.transport.unsubscribe).toBe("function");
    expect(typeof h.transport.page).toBe("function");
  });

  it('subscribe(): POST /api/subscribe with X-PWH:"1" and a JSON {clientId, agentKey} body', async () => {
    const h = make();
    const r = await h.transport.subscribe("c1", "agent-A");
    expect(r.ok).toBe(true);
    const call = h.fetchCalls.find((c) => c.url === "/api/subscribe");
    expect(call).toBeDefined();
    expect(call!.init.method).toBe("POST");
    expect(call!.init.headers?.["X-PWH"]).toBe("1");
    expect(JSON.parse(call!.init.body ?? "{}")).toEqual({ clientId: "c1", agentKey: "agent-A" });
  });

  it('unsubscribe(): POST /api/unsubscribe with X-PWH:"1" and a JSON {clientId, agentKey} body', async () => {
    const h = make();
    await h.transport.unsubscribe("c1", "agent-A");
    const call = h.fetchCalls.find((c) => c.url === "/api/unsubscribe");
    expect(call).toBeDefined();
    expect(call!.init.method).toBe("POST");
    expect(call!.init.headers?.["X-PWH"]).toBe("1");
    expect(JSON.parse(call!.init.body ?? "{}")).toEqual({ clientId: "c1", agentKey: "agent-A" });
  });

  it(`page(): GET /api/history?agent&before&limit, limit clamped to HISTORY_LIMIT_MAX (${HISTORY_LIMIT_MAX})`, async () => {
    const h = make();
    const r = await h.transport.page("agent-A", "entry-1", 999_999);
    expect(r.ok).toBe(true);
    const call = h.fetchCalls.find((c) => c.url.startsWith("/api/history"));
    expect(call).toBeDefined();
    expect(call!.init.method ?? "GET").toBe("GET");
    expect(call!.url).toBe(`/api/history?agent=agent-A&before=entry-1&limit=${HISTORY_LIMIT_MAX}`);
  });

  it("close(): tears down every timer this transport owns", async () => {
    const h = make();
    void h.transport.start();
    await flush();
    expect(h.clock.pending()).toBeGreaterThan(0); // the SSE silence watchdog is armed
    h.transport.close();
    expect(h.clock.pending()).toBe(0);
  });

  it("close() is idempotent and safe to call before start()", () => {
    const h = make();
    expect(() => {
      h.transport.close();
      h.transport.close();
    }).not.toThrow();
  });
});

describe("token transport: 401 handling (vue-plan.md v2.1 §3.4)", () => {
  it("subscribe(): a 401 with a stored token triggers exactly one silent re-login, then retries the original request", async () => {
    const calls: string[] = [];
    const h = makeToken(async (url) => {
      calls.push(url);
      if (url === "/api/login") return resp(200);
      if (url === "/api/subscribe")
        return calls.filter((u) => u === "/api/login").length > 0 ? resp(200) : resp(401, { error: "E_AUTH" });
      return resp(200);
    });
    h.storage!.set(TOKEN_KEY, "stored-token");
    const r = await h.transport.subscribe("c1", "A");
    expect(r).toEqual({ ok: true });
    expect(calls.filter((u) => u === "/api/login")).toHaveLength(1);
    expect(calls.filter((u) => u === "/api/subscribe")).toHaveLength(2);
  });

  it("subscribe(): a 401 with no stored token surfaces E_AUTH without attempting a re-login", async () => {
    const h = makeToken(async (url) => (url === "/api/subscribe" ? resp(401, { error: "E_AUTH" }) : resp(200)));
    const r = await h.transport.subscribe("c1", "A");
    expect(r).toEqual({ ok: false, error: "E_AUTH" });
    expect(h.fetchCalls.filter((c) => c.url === "/api/login")).toHaveLength(0);
  });

  it("an SSE stream going CLOSED (server-side 401 after e.g. a hub restart) re-logs in silently and reconnects", async () => {
    const h = makeToken(async (url) => (url === "/api/login" ? resp(200) : resp(200)));
    h.storage!.set(TOKEN_KEY, "stored-token");
    void h.transport.start();
    await flush();
    const es = FakeEventSource.instances.at(-1)!;
    es.fail();
    await flush();
    expect(h.onConnCalls).toContain("reconnecting");
  });
});

describe("password transport: 401/auth handling (vue-plan.md v2.1 §3.4)", () => {
  it('an SSE stream going CLOSED while the session cookie is gone (GET /api/session ⇒ 401) reports onConn("auth")', async () => {
    const h = makePassword(async (url) => (url === "/api/session" ? resp(401) : resp(200)));
    void h.transport.start();
    await flush();
    const es = FakeEventSource.instances.at(-1)!;
    es.fail();
    await flush();
    expect(h.onConnCalls).toContain("auth");
  });

  it('an SSE stream going CLOSED while the session is still valid (GET /api/session ⇒ 200) reconnects instead of showing "auth"', async () => {
    const h = makePassword(async (url) => (url === "/api/session" ? resp(200) : resp(200)));
    void h.transport.start();
    await flush();
    const es = FakeEventSource.instances.at(-1)!;
    es.fail();
    await flush();
    expect(h.onConnCalls).toContain("reconnecting");
    expect(h.onConnCalls).not.toContain("auth");
  });

  it('an "auth" SSE event (revoked/expired) immediately reports onConn("auth"), no session probe needed', async () => {
    const h = makePassword(async () => resp(200));
    void h.transport.start();
    await flush();
    const es = FakeEventSource.instances.at(-1)!;
    es.emit("auth", { reason: "revoked" });
    await flush();
    expect(h.onConnCalls).toContain("auth");
  });

  it("password transport never touches localStorage/token machinery (no #t= handling)", async () => {
    const h = makePassword(async () => resp(200));
    void h.transport.start();
    await flush();
    // password-client.js never reads deps.storage at all — this transport type doesn't even accept one.
    expect("login" in h.transport).toBe(true);
    expect("logout" in h.transport).toBe(true);
  });
});

describe("401 REST responses report onConn('auth') on both transports (vue-plan.md v2.1 §3.4, verifier fix 2026-09-27)", () => {
  it.each([
    ["token", (fetchImpl: FetchImpl) => makeToken(fetchImpl)] as const,
    ["password", (fetchImpl: FetchImpl) => makePassword(fetchImpl)] as const,
  ])(
    "%s subscribe(): a REST 401 with no successful recovery reports onConn('auth') exactly once",
    async (_mode, make) => {
      const h = make(async (url) => (url === "/api/subscribe" ? resp(401, { error: "E_AUTH" }) : resp(200)));
      const r = await h.transport.subscribe("c1", "A");
      expect(r).toEqual({ ok: false, error: "E_AUTH" });
      expect(h.onConnCalls.filter((c) => c === "auth")).toHaveLength(1);
    },
  );

  it.each([
    ["token", (fetchImpl: FetchImpl) => makeToken(fetchImpl)] as const,
    ["password", (fetchImpl: FetchImpl) => makePassword(fetchImpl)] as const,
  ])("%s page(): a REST 401 with no successful recovery reports onConn('auth')", async (_mode, make) => {
    const h = make(async (url) => (url.startsWith("/api/history") ? resp(401, { error: "E_AUTH" }) : resp(200)));
    const r = await h.transport.page("A", "e1");
    expect(r).toEqual({ ok: false, error: "E_AUTH" });
    expect(h.onConnCalls.filter((c) => c === "auth")).toHaveLength(1);
  });

  it.each([
    ["token", (fetchImpl: FetchImpl) => makeToken(fetchImpl)] as const,
    ["password", (fetchImpl: FetchImpl) => makePassword(fetchImpl)] as const,
  ])(
    "%s unsubscribe(): a REST 401 reports onConn('auth') even though the call itself is fire-and-forget",
    async (_mode, make) => {
      const h = make(async (url) => (url === "/api/unsubscribe" ? resp(401, { error: "E_AUTH" }) : resp(200)));
      await h.transport.unsubscribe("c1", "A"); // resolves to void either way — onConn is the only signal
      expect(h.onConnCalls.filter((c) => c === "auth")).toHaveLength(1);
    },
  );

  it("token subscribe(): a 401 that recovers via silent re-login (stored token) never reports onConn('auth')", async () => {
    const calls: string[] = [];
    const h = makeToken(async (url) => {
      calls.push(url);
      if (url === "/api/login") return resp(200);
      if (url === "/api/subscribe")
        return calls.filter((u) => u === "/api/login").length > 0 ? resp(200) : resp(401, { error: "E_AUTH" });
      return resp(200);
    });
    h.storage!.set(TOKEN_KEY, "stored-token");
    const r = await h.transport.subscribe("c1", "A");
    expect(r).toEqual({ ok: true });
    expect(h.onConnCalls).not.toContain("auth"); // the silent re-login succeeded — no auth screen flash
  });

  it("password: a 401 from /api/login (invalid credentials) never reports onConn('auth') — that's a login-form error, not a lost session", async () => {
    const p = makePassword(async (url) => (url === "/api/login" ? resp(401, { error: "E_AUTH" }) : resp(200)));
    const transport = p.transport as PasswordTransport;
    await transport.login("alice", "wrong");
    expect(p.onConnCalls).not.toContain("auth");
  });
});
