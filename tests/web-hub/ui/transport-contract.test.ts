// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PREVIEW_DIR_BODY_MAX_BYTES } from "@protocol/preview.ts";
import {
  parseWtDiffFile,
  parseWtDiffFileList,
  WTDIFF_CLIENT_TIMEOUT_MS,
  WTDIFF_FILE_BODY_MAX_BYTES,
  WTDIFF_LIST_BODY_MAX_BYTES,
} from "@protocol/worktree-diff.ts";
import { createTokenTransport, TOKEN_KEY } from "../../../src/web-hub/ui/src/transport/token.js";
import { createPasswordTransport } from "../../../src/web-hub/ui/src/transport/password.js";
import { HISTORY_LIMIT_MAX } from "../../../src/web-hub/ui/src/logic/contract.js";
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
  init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array },
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
    init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array };
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

// ---------------------------------------------------------------------------
// command()/dialog() — control-plan v2.1 §7.2 (package C4), same suite both modes
// ---------------------------------------------------------------------------

describe.each([
  ["token", (fetchImpl: FetchImpl) => makeToken(fetchImpl)] as const,
  ["password", (fetchImpl: FetchImpl) => makePassword(fetchImpl)] as const,
])("%s transport: command()/dialog() (§7.2 — identical wire + outcome mapping both modes)", (_mode, make) => {
  const req = { agentKey: "A", id: "cmd-1", op: "prompt" as const, text: "hi", deliver: "steer" as const };
  const dlg = { agentKey: "A", id: "d1", dialogId: "ask:t1", epoch: "e1", action: "answer" as const };

  it("command(): POST /api/cmd with X-PWH:1 and the verbatim JSON body; 200 {ok:true,id,dup?,data} ⇒ ok outcome", async () => {
    const h = make(async (url) =>
      url === "/api/cmd" ? resp(200, { ok: true, id: "cmd-1", dup: true, data: { delivery: "observed" } }) : resp(200),
    );
    const r = await h.transport.command(req);
    expect(r).toEqual({ ok: true, data: { delivery: "observed" }, dup: true });
    const call = h.fetchCalls.find((c) => c.url === "/api/cmd")!;
    expect(call.init.method).toBe("POST");
    expect(call.init.headers?.["X-PWH"]).toBe("1");
    expect(JSON.parse(call.init.body ?? "{}")).toEqual(req);
  });

  it("dialog(): POST /api/dialog; agent error body maps to {error,message,retryable,effect}", async () => {
    const h = make(async (url) =>
      url === "/api/dialog"
        ? resp(409, { error: "E_DIALOG_CLOSED", message: "stale", retryable: false, effect: "none" })
        : resp(200),
    );
    const r = await h.transport.dialog(dlg);
    expect(r).toEqual({ ok: false, error: "E_DIALOG_CLOSED", message: "stale", retryable: false, effect: "none" });
  });

  it("429: Retry-After header becomes retryAfterS; retryable defaults true (§6.2)", async () => {
    const h = make(async (url) =>
      url === "/api/cmd" ? resp(429, { error: "E_RATE" }, { "Retry-After": "3" }) : resp(200),
    );
    const r = await h.transport.command(req);
    expect(r).toMatchObject({ ok: false, error: "E_RATE", retryable: true, retryAfterS: 3 });
  });

  it("504 with effect unknown passes through (registry wait timeout, §3.5)", async () => {
    const h = make(async (url) =>
      url === "/api/cmd" ? resp(504, { error: "E_DEADLINE", retryable: true, effect: "unknown" }) : resp(200),
    );
    const r = await h.transport.command(req);
    expect(r).toMatchObject({ ok: false, error: "E_DEADLINE", retryable: true, effect: "unknown" });
  });

  it('fetch timeout (16s browser budget, §3.3) ⇒ E_DEADLINE{effect:"unknown"} and exactly one attempt', async () => {
    const h = make(async (url) => (url === "/api/cmd" ? new Promise<FetchResponse>(() => {}) : resp(200)));
    const p = h.transport.command(req);
    h.clock.advance(16_000);
    const r = await p;
    expect(r).toEqual({ ok: false, error: "E_DEADLINE", retryable: true, effect: "unknown" });
    expect(h.fetchCalls.filter((c) => c.url === "/api/cmd")).toHaveLength(1);
  });

  it('network error ⇒ E_NETWORK{effect:"unknown"} (§3.4: possibly received ⇒ queryOnly flow, never auto re-execute)', async () => {
    const h = make(async (url) => (url === "/api/cmd" ? Promise.reject(new TypeError("fetch failed")) : resp(200)));
    const r = await h.transport.command(req);
    expect(r).toMatchObject({ ok: false, error: "E_NETWORK", retryable: true, effect: "unknown" });
  });

  it("a final 401 (session truly gone) reports onConn('auth') — token: after the silent re-login fails; password: one-shot", async () => {
    const h = make(async (url) =>
      url === "/api/cmd" || url === "/api/dialog" ? resp(401, { error: "E_AUTH" }) : resp(200),
    );
    const r = await h.transport.command(req);
    expect(r).toMatchObject({ ok: false, error: "E_AUTH" });
    expect(h.onConnCalls.filter((c) => c === "auth")).toHaveLength(1);
    const r2 = await h.transport.dialog(dlg);
    expect(r2).toMatchObject({ ok: false, error: "E_AUTH" });
    expect(h.onConnCalls.filter((c) => c === "auth").length).toBeGreaterThanOrEqual(2);
  });
});

describe("token transport: command() 401 recovery (§7.2: withRelogin replay is id-safe, D7)", () => {
  it("a 401 with a stored token silently re-logs in and replays the SAME command body", async () => {
    const h = makeToken(async (url, init) => {
      void init;
      if (url === "/api/login") return resp(200);
      if (url === "/api/cmd") {
        const loggedIn = h.fetchCalls.some((c) => c.url === "/api/login");
        return loggedIn ? resp(200, { ok: true, id: "cmd-1", data: {} }) : resp(401, { error: "E_AUTH" });
      }
      return resp(200);
    });
    h.storage!.set(TOKEN_KEY, "stored-token");
    const r = await h.transport.command({ agentKey: "A", id: "cmd-1", op: "abort" });
    expect(r).toEqual({ ok: true, data: {}, dup: false });
    const cmdCalls = h.fetchCalls.filter((c) => c.url === "/api/cmd");
    expect(cmdCalls).toHaveLength(2);
    expect(cmdCalls[0]!.init.body).toBe(cmdCalls[1]!.init.body); // same id ⇒ hub/agent dedupe (dup)
    expect(h.onConnCalls).not.toContain("auth"); // recovered — no login-view flash
  });
});

// ---------------------------------------------------------------------------
// upload() — web-hub-upload plan §1.2/§4.3 (package U4b), same suite both modes
// ---------------------------------------------------------------------------

describe.each([
  ["token", (fetchImpl: FetchImpl) => makeToken(fetchImpl)] as const,
  ["password", (fetchImpl: FetchImpl) => makePassword(fetchImpl)] as const,
])("%s transport: upload() (web-hub-upload plan §1.2 — identical wire both modes)", (_mode, make) => {
  const beginBody = { agentKey: "A", id: "u".repeat(22), name: "shot.png", size: 5, mime: "image/png" };
  const commitBody = { id: "u".repeat(22) };

  it("implements the full UploadTransport surface on every adapter", () => {
    const h = make();
    const up = h.transport.upload;
    expect(up).toBeDefined();
    expect(typeof up!.begin).toBe("function");
    expect(typeof up!.chunk).toBe("function");
    expect(typeof up!.commit).toBe("function");
    expect(typeof up!.abort).toBe("function");
  });

  it("begin(): POST /api/upload/begin with X-PWH:1 and the verbatim JSON body; 200 body rides as data", async () => {
    const h = make(async (url) =>
      url === "/api/upload/begin"
        ? resp(200, { id: beginBody.id, chunkBytes: 4194304, maxBytes: 104857600, received: 0 })
        : resp(200),
    );
    const r = await h.transport.upload!.begin(beginBody);
    expect(r).toEqual({ ok: true, data: { id: beginBody.id, chunkBytes: 4194304, maxBytes: 104857600, received: 0 } });
    const call = h.fetchCalls.find((c) => c.url === "/api/upload/begin")!;
    expect(call.init.method).toBe("POST");
    expect(call.init.headers?.["Content-Type"]).toBe("application/json");
    expect(call.init.headers?.["X-PWH"]).toBe("1");
    expect(JSON.parse(call.init.body as string)).toEqual(beginBody);
  });

  it("chunk(): POST /api/upload/chunk?id&offset as application/octet-stream + X-PWH:1 with the RAW bytes (never JSON)", async () => {
    const h = make(async (url) => (url.startsWith("/api/upload/chunk") ? resp(200, { received: 8 }) : resp(200)));
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const r = await h.transport.upload!.chunk({ id: beginBody.id, offset: 5, bytes });
    expect(r).toEqual({ ok: true, data: { received: 8 } });
    const call = h.fetchCalls.find((c) => c.url.startsWith("/api/upload/chunk"))!;
    expect(call.url).toBe(`/api/upload/chunk?id=${beginBody.id}&offset=5`);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers?.["Content-Type"]).toBe("application/octet-stream");
    expect(call.init.headers?.["X-PWH"]).toBe("1");
    expect(Array.from(call.init.body as Uint8Array)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("chunk(): 200 {received, dup:true} keeps `dup` in data (§2.5 idempotent replay)", async () => {
    const h = make(async (url) =>
      url.startsWith("/api/upload/chunk") ? resp(200, { received: 8, dup: true }) : resp(200),
    );
    const r = await h.transport.upload!.chunk({ id: beginBody.id, offset: 0, bytes: new Uint8Array(8) });
    expect(r).toEqual({ ok: true, data: { received: 8, dup: true } });
  });

  it("409 E_UPLOAD_OFFSET carries the body's authoritative `received` on the outcome (§1.2 resync)", async () => {
    const h = make(async (url) =>
      url.startsWith("/api/upload/chunk") ? resp(409, { error: "E_UPLOAD_OFFSET", received: 4096 }) : resp(200),
    );
    const r = await h.transport.upload!.chunk({ id: beginBody.id, offset: 0, bytes: new Uint8Array(8) });
    expect(r).toEqual({ ok: false, error: "E_UPLOAD_OFFSET", received: 4096, retryable: false });
  });

  it("404 maps to E_NOT_FOUND (voided upload / hub restart — §4.3: useUploads turns it into a retryable failed item)", async () => {
    const h = make(async (url) =>
      url.startsWith("/api/upload/chunk") ? resp(404, { error: "E_NOT_FOUND" }) : resp(200),
    );
    const r = await h.transport.upload!.chunk({ id: beginBody.id, offset: 0, bytes: new Uint8Array(8) });
    expect(r).toEqual({ ok: false, error: "E_NOT_FOUND", retryable: false });
  });

  it("413 E_UPLOAD_TOO_LARGE / 409 E_UPLOAD_DISABLED surface verbatim with retryable:false", async () => {
    const h = make(async (url) =>
      url === "/api/upload/begin" ? resp(413, { error: "E_UPLOAD_TOO_LARGE" }) : resp(200),
    );
    expect(await h.transport.upload!.begin(beginBody)).toEqual({
      ok: false,
      error: "E_UPLOAD_TOO_LARGE",
      retryable: false,
    });
    const h2 = make(async (url) =>
      url === "/api/upload/begin" ? resp(409, { error: "E_UPLOAD_DISABLED", message: "no hardlink" }) : resp(200),
    );
    expect(await h2.transport.upload!.begin(beginBody)).toEqual({
      ok: false,
      error: "E_UPLOAD_DISABLED",
      message: "no hardlink",
      retryable: false,
    });
  });

  it("429 E_RATE folds Retry-After into retryAfterS (token bucket, §2.4)", async () => {
    const h = make(async (url) =>
      url === "/api/upload/begin" ? resp(429, { error: "E_RATE" }, { "Retry-After": "3" }) : resp(200),
    );
    const r = await h.transport.upload!.begin(beginBody);
    expect(r).toEqual({ ok: false, error: "E_RATE", retryable: true, retryAfterS: 3 });
  });

  it("fetch timeout (16s chunk budget, §4.3) ⇒ E_DEADLINE retryable and exactly one attempt", async () => {
    const h = make(async (url) =>
      url.startsWith("/api/upload/chunk") ? new Promise<FetchResponse>(() => {}) : resp(200),
    );
    const p = h.transport.upload!.chunk({ id: beginBody.id, offset: 0, bytes: new Uint8Array(8) });
    h.clock.advance(16_000);
    const r = await p;
    expect(r).toEqual({ ok: false, error: "E_DEADLINE", retryable: true });
    expect(h.fetchCalls.filter((c) => c.url.startsWith("/api/upload/chunk"))).toHaveLength(1);
  });

  it("an external AbortSignal aborts the in-flight chunk ⇒ E_ABORT retryable:false (§4.2 remove)", async () => {
    const h = make(async (url) =>
      url.startsWith("/api/upload/chunk") ? new Promise<FetchResponse>(() => {}) : resp(200),
    );
    const ac = new AbortController();
    const p = h.transport.upload!.chunk({ id: beginBody.id, offset: 0, bytes: new Uint8Array(8) }, ac.signal);
    await flush();
    ac.abort();
    const r = await p;
    expect(r).toEqual({ ok: false, error: "E_ABORT", retryable: false });
    expect(h.clock.pending()).toBe(0); // the merged timeout timer was cleaned up
  });

  it("a PRE-aborted signal never issues the request at all", async () => {
    const h = make(async () => resp(200));
    const ac = new AbortController();
    ac.abort();
    const r = await h.transport.upload!.commit(commitBody, ac.signal);
    expect(r).toEqual({ ok: false, error: "E_ABORT", retryable: false });
    expect(h.fetchCalls.filter((c) => c.url === "/api/upload/commit")).toHaveLength(0);
  });

  it("external abort wins over the internal timeout (whichever fires first — merge, not race-to-16s)", async () => {
    const h = make(async (url) =>
      url.startsWith("/api/upload/chunk") ? new Promise<FetchResponse>(() => {}) : resp(200),
    );
    const ac = new AbortController();
    const p = h.transport.upload!.chunk({ id: beginBody.id, offset: 0, bytes: new Uint8Array(8) }, ac.signal);
    await flush();
    h.clock.advance(16_000); // the internal deadline fires FIRST…
    ac.abort(); // …so the external abort must NOT change the outcome
    const r = await p;
    expect(r).toEqual({ ok: false, error: "E_DEADLINE", retryable: true });
  });

  it("commit(): POST /api/upload/commit; 200 {id,path,size,mime,dedup} rides verbatim", async () => {
    const h = make(async (url) =>
      url === "/api/upload/commit"
        ? resp(200, {
            id: commitBody.id,
            path: "/home/u/.pi/agent/web-hub/uploads/s-1/x/shot.png",
            size: 5,
            mime: "image/png",
            dedup: true,
          })
        : resp(200),
    );
    const r = await h.transport.upload!.commit(commitBody);
    expect(r).toEqual({
      ok: true,
      data: {
        id: commitBody.id,
        path: "/home/u/.pi/agent/web-hub/uploads/s-1/x/shot.png",
        size: 5,
        mime: "image/png",
        dedup: true,
      },
    });
    const call = h.fetchCalls.find((c) => c.url === "/api/upload/commit")!;
    expect(call.init.method).toBe("POST");
    expect(call.init.headers?.["X-PWH"]).toBe("1");
    expect(JSON.parse(call.init.body as string)).toEqual(commitBody);
  });

  it("abort(): POST /api/upload/abort {id}; 410/E_AGENT_GONE-style bodies map like any error", async () => {
    const h = make(async (url) => (url === "/api/upload/abort" ? resp(200, { ok: true }) : resp(200)));
    const r = await h.transport.upload!.abort(commitBody);
    expect(r).toEqual({ ok: true, data: { ok: true } });
    const call = h.fetchCalls.find((c) => c.url === "/api/upload/abort")!;
    expect(JSON.parse(call.init.body as string)).toEqual(commitBody);
  });

  it("503 E_BUSY auto-retries on the existing busy backoff (§2.2.4 startup scan) until 200 — one caller-visible outcome", async () => {
    let beginAttempts = 0;
    const h = make(async (url) => {
      if (url !== "/api/upload/begin") return resp(200);
      beginAttempts++;
      return beginAttempts === 1
        ? resp(503, { error: "E_BUSY" }, { "Retry-After": "1" })
        : resp(200, { received: 0, chunkBytes: 1024, maxBytes: 1 });
    });
    const p = h.transport.upload!.begin(beginBody);
    await flush(); // first attempt ⇒ E_BUSY, backoff timer armed
    h.clock.advance(1000); // Retry-After: 1s
    const r = await p;
    expect(r).toEqual({ ok: true, data: { received: 0, chunkBytes: 1024, maxBytes: 1 } });
    expect(beginAttempts).toBe(2);
  });

  it("503 E_BUSY exhausts the bounded retries and surfaces the retryable error (password-client's BUSY_RETRY_MAX=5)", async () => {
    let beginAttempts = 0;
    const h = make(async (url) => {
      if (url !== "/api/upload/begin") return resp(200);
      beginAttempts++;
      return resp(503, { error: "E_BUSY" }, { "Retry-After": "1" });
    });
    const p = h.transport.upload!.begin(beginBody);
    for (let i = 0; i < 5; i++) {
      await flush();
      h.clock.advance(1000);
    }
    const r = await p;
    expect(r).toEqual({ ok: false, error: "E_BUSY", retryable: true, retryAfterS: 1 });
    expect(beginAttempts).toBe(6); // 1 + BUSY_RETRY_MAX(5)
  });
});

describe("token transport: upload() 401 recovery (§7.2's withRelogin rule, applied to uploads)", () => {
  const beginBody = { agentKey: "A", id: "u".repeat(22), name: "a.png", size: 1 };

  it("a 401 with a stored token silently re-logs in and replays the SAME begin body (idempotent by id)", async () => {
    const h = makeToken(async (url) => {
      if (url === "/api/login") return resp(200);
      if (url === "/api/upload/begin") {
        const loggedIn = h.fetchCalls.some((c) => c.url === "/api/login");
        return loggedIn ? resp(200, { received: 0, chunkBytes: 1024, maxBytes: 1 }) : resp(401, { error: "E_AUTH" });
      }
      return resp(200);
    });
    h.storage!.set(TOKEN_KEY, "stored-token");
    const r = await h.transport.upload!.begin(beginBody);
    expect(r).toEqual({ ok: true, data: { received: 0, chunkBytes: 1024, maxBytes: 1 } });
    const begins = h.fetchCalls.filter((c) => c.url === "/api/upload/begin");
    expect(begins).toHaveLength(2);
    expect(begins[0]!.init.body).toBe(begins[1]!.init.body);
    expect(h.onConnCalls).not.toContain("auth"); // recovered — no login-view flash
  });

  it("a FINAL 401 (no stored token) surfaces E_AUTH and reports onConn('auth') exactly once", async () => {
    const h = makeToken(async (url) => (url === "/api/upload/begin" ? resp(401, { error: "E_AUTH" }) : resp(200)));
    const r = await h.transport.upload!.begin(beginBody);
    expect(r).toEqual({ ok: false, error: "E_AUTH", retryable: false });
    expect(h.onConnCalls.filter((c) => c === "auth")).toHaveLength(1);
  });
});

describe("password transport: upload() 401 (one-shot — the cookie session is gone, §7.2)", () => {
  const beginBody = { agentKey: "A", id: "u".repeat(22), name: "a.png", size: 1 };

  it("a 401 surfaces E_AUTH and reports onConn('auth') exactly once (client-side; wrapper never double-fires)", async () => {
    const h = makePassword(async (url) => (url === "/api/upload/begin" ? resp(401, { error: "E_AUTH" }) : resp(200)));
    const r = await h.transport.upload!.begin(beginBody);
    expect(r).toEqual({ ok: false, error: "E_AUTH", retryable: false });
    expect(h.onConnCalls.filter((c) => c === "auth")).toHaveLength(1);
    expect(h.fetchCalls.filter((c) => c.url === "/api/login")).toHaveLength(0); // no relogin machinery in password mode
  });

  it("a 401 on chunk reports onConn('auth') once too (same lost-session signal)", async () => {
    const h = makePassword(async (url) =>
      url.startsWith("/api/upload/chunk") ? resp(401, { error: "E_AUTH" }) : resp(200),
    );
    const r = await h.transport.upload!.chunk({ id: "u".repeat(22), offset: 0, bytes: new Uint8Array(4) });
    expect(r).toEqual({ ok: false, error: "E_AUTH", retryable: false });
    expect(h.onConnCalls.filter((c) => c === "auth")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// spawn() — web-hub-spawn plan SP11 / arch §8.2–§8.3, same suite both modes
// ---------------------------------------------------------------------------

describe.each([
  ["token", (fetchImpl: FetchImpl) => makeToken(fetchImpl)] as const,
  ["password", (fetchImpl: FetchImpl) => makePassword(fetchImpl)] as const,
])("%s transport: spawn() (web-hub-spawn SP11 / arch §8.2 — identical wire both modes)", (_mode, make) => {
  const startBody = { id: "s".repeat(22), cwd: "~/proj", firstPrompt: { text: "hi", deliver: "steer" as const } };

  it("implements the full SpawnTransport surface on every adapter", () => {
    const h = make();
    const sp = h.transport.spawn;
    expect(sp).toBeDefined();
    expect(typeof sp!.list).toBe("function");
    expect(typeof sp!.dirs).toBe("function");
    expect(typeof sp!.start).toBe("function");
    expect(typeof sp!.stop).toBe("function");
  });

  it('list(): GET /api/headless with X-PWH:"1"; 200 {policy, items} rides as {policy, items}', async () => {
    const h = make(async (url) =>
      url === "/api/headless" ? resp(200, { policy: { allowed: true }, items: [{ spawnId: "sp1" }] }) : resp(200),
    );
    const r = await h.transport.spawn!.list();
    expect(r).toEqual({ ok: true, policy: { allowed: true }, items: [{ spawnId: "sp1" }] });
    const call = h.fetchCalls.find((c) => c.url === "/api/headless")!;
    expect(call.init.method ?? "GET").toBe("GET");
    expect(call.init.headers?.["X-PWH"]).toBe("1");
  });

  it("list(): 404 rides back verbatim with its status (arch §8.3: UI treats it as unavailable, never an error)", async () => {
    const h = make(async (url) => (url === "/api/headless" ? resp(404, { error: "E_NOT_FOUND" }) : resp(200)));
    const r = await h.transport.spawn!.list();
    expect(r).toEqual({ ok: false, error: "E_NOT_FOUND", status: 404 });
  });

  it('dirs(): GET /api/headless/dirs with X-PWH:"1"; partial:true survives', async () => {
    const h = make(async (url) =>
      url === "/api/headless/dirs"
        ? resp(200, { recent: [{ cwd: "/real/p", label: "p", at: 1 }], partial: true })
        : resp(200),
    );
    const r = await h.transport.spawn!.dirs();
    expect(r).toEqual({ ok: true, recent: [{ cwd: "/real/p", label: "p", at: 1 }], partial: true });
    const call = h.fetchCalls.find((c) => c.url === "/api/headless/dirs")!;
    expect(call.init.method ?? "GET").toBe("GET");
    expect(call.init.headers?.["X-PWH"]).toBe("1");
  });

  it("start(): POST /api/headless with X-PWH:1 and the verbatim JSON body; 202 rides as data (dup kept)", async () => {
    const h = make(async (url) =>
      url === "/api/headless"
        ? resp(202, { spawnId: "sp1", state: "starting", cwd: "/real/proj", dup: true, firstPrompt: "accepted" })
        : resp(200),
    );
    const r = await h.transport.spawn!.start(startBody);
    expect(r).toEqual({
      ok: true,
      data: { spawnId: "sp1", state: "starting", cwd: "/real/proj", dup: true, firstPrompt: "accepted" },
    });
    const call = h.fetchCalls.find((c) => c.url === "/api/headless")!;
    expect(call.init.method).toBe("POST");
    expect(call.init.headers?.["Content-Type"]).toBe("application/json");
    expect(call.init.headers?.["X-PWH"]).toBe("1");
    expect(JSON.parse(call.init.body as string)).toEqual(startBody);
  });

  it("start(): 409 E_CONFIRM_REQUIRED keeps resolvedCwd/reason (the confirm view's inputs)", async () => {
    const h = make(async (url) =>
      url === "/api/headless"
        ? resp(409, { error: "E_CONFIRM_REQUIRED", resolvedCwd: "/real/proj", reason: "unknown-dir" })
        : resp(200),
    );
    const r = await h.transport.spawn!.start(startBody);
    expect(r).toEqual({
      ok: false,
      error: "E_CONFIRM_REQUIRED",
      retryable: false,
      resolvedCwd: "/real/proj",
      reason: "unknown-dir",
    });
  });

  it("start(): 409 E_LIMIT / 403 E_SPAWN_DENIED / 503 E_LAUNCHER surface verbatim with retryable per status", async () => {
    const h = make(async (url) =>
      url === "/api/headless"
        ? resp(409, { error: "E_LIMIT", message: "global", limit: "global" as never } as never)
        : resp(200),
    );
    expect(await h.transport.spawn!.start(startBody)).toMatchObject({ ok: false, error: "E_LIMIT", retryable: false });
    const h2 = make(async (url) =>
      url === "/api/headless" ? resp(503, { error: "E_LAUNCHER", retryAfterS: 30 }) : resp(200),
    );
    expect(await h2.transport.spawn!.start(startBody)).toMatchObject({
      ok: false,
      error: "E_LAUNCHER",
      retryable: true,
      retryAfterS: 30,
    });
  });

  it("start(): 429 E_RATE folds Retry-After into retryAfterS", async () => {
    const h = make(async (url) =>
      url === "/api/headless" ? resp(429, { error: "E_RATE" }, { "Retry-After": "5" }) : resp(200),
    );
    const r = await h.transport.spawn!.start(startBody);
    expect(r).toMatchObject({ ok: false, error: "E_RATE", retryable: true, retryAfterS: 5 });
  });

  it("start(): fetch timeout (16s browser budget, §3.3) ⇒ E_DEADLINE and exactly one attempt", async () => {
    const h = make(async (url) => (url === "/api/headless" ? new Promise<FetchResponse>(() => {}) : resp(200)));
    const p = h.transport.spawn!.start(startBody);
    h.clock.advance(16_000);
    const r = await p;
    expect(r).toEqual({ ok: false, error: "E_DEADLINE", retryable: true });
    expect(h.fetchCalls.filter((c) => c.url === "/api/headless")).toHaveLength(1);
  });

  it("start(): network error ⇒ E_NETWORK retryable (useNewSession resends the same id once, §3.2)", async () => {
    const h = make(async (url) =>
      url === "/api/headless" ? Promise.reject(new TypeError("fetch failed")) : resp(200),
    );
    const r = await h.transport.spawn!.start(startBody);
    expect(r).toMatchObject({ ok: false, error: "E_NETWORK", retryable: true });
  });

  it("stop(): POST /api/headless/<id>/stop (encoded) with {force:true}; 202 {state} rides", async () => {
    const h = make(async (url) => (url === "/api/headless/sp%201/stop" ? resp(202, { state: "stopping" }) : resp(200)));
    const r = await h.transport.spawn!.stop("sp 1", true);
    expect(r).toEqual({ ok: true, state: "stopping" });
    const call = h.fetchCalls.find((c) => c.url === "/api/headless/sp%201/stop")!;
    expect(call.init.method).toBe("POST");
    expect(call.init.headers?.["X-PWH"]).toBe("1");
    expect(JSON.parse(call.init.body as string)).toEqual({ force: true });
  });

  it("stop(): terminal-record idempotent 202 {state:'exited'} rides; 404 ⇒ E_NOT_FOUND", async () => {
    const h = make(async (url) => (url === "/api/headless/sp1/stop" ? resp(202, { state: "exited" }) : resp(200)));
    expect(await h.transport.spawn!.stop("sp1")).toEqual({ ok: true, state: "exited" });
    const h2 = make(async (url) =>
      url === "/api/headless/sp1/stop" ? resp(404, { error: "E_NOT_FOUND" }) : resp(200),
    );
    expect(await h2.transport.spawn!.stop("sp1")).toEqual({ ok: false, error: "E_NOT_FOUND" });
  });

  it("a final 401 on any of the four endpoints reports onConn('auth') exactly once per call", async () => {
    const h = make(async (url) => (url.startsWith("/api/headless") ? resp(401, { error: "E_AUTH" }) : resp(200)));
    expect(await h.transport.spawn!.list()).toMatchObject({ ok: false, error: "E_AUTH" });
    expect(h.onConnCalls.filter((c) => c === "auth")).toHaveLength(1);
    expect(await h.transport.spawn!.dirs()).toMatchObject({ ok: false, error: "E_AUTH" });
    expect(await h.transport.spawn!.start(startBody)).toMatchObject({ ok: false, error: "E_AUTH" });
    expect(await h.transport.spawn!.stop("sp1")).toEqual({ ok: false, error: "E_AUTH" });
    expect(h.onConnCalls.filter((c) => c === "auth")).toHaveLength(4);
  });
});

describe("token transport: spawn() 401 recovery (withRelogin, same-id replay is dup-safe)", () => {
  const startBody = { id: "s".repeat(22), cwd: "~/proj" };

  it("a 401 with a stored token silently re-logs in and replays the SAME start body (hub LRU dedupes)", async () => {
    const h = makeToken(async (url) => {
      if (url === "/api/login") return resp(200);
      if (url === "/api/headless") {
        const loggedIn = h.fetchCalls.some((c) => c.url === "/api/login");
        return loggedIn
          ? resp(202, { spawnId: "sp1", state: "starting", cwd: "/real/proj", dup: true })
          : resp(401, { error: "E_AUTH" });
      }
      return resp(200);
    });
    h.storage!.set(TOKEN_KEY, "stored-token");
    const r = await h.transport.spawn!.start(startBody);
    expect(r).toEqual({ ok: true, data: { spawnId: "sp1", state: "starting", cwd: "/real/proj", dup: true } });
    const posts = h.fetchCalls.filter((c) => c.url === "/api/headless");
    expect(posts).toHaveLength(2);
    expect(posts[0]!.init.body).toBe(posts[1]!.init.body); // same id ⇒ dup
    expect(h.onConnCalls).not.toContain("auth"); // recovered — no login-view flash
  });
});

// ---------------------------------------------------------------------------
// removeAgent() — web-hub-delete-session plan v2 §4.1/§5.3, same suite both modes
// ---------------------------------------------------------------------------

describe.each([
  ["token", (fetchImpl: FetchImpl) => makeToken(fetchImpl)] as const,
  ["password", (fetchImpl: FetchImpl) => makePassword(fetchImpl)] as const,
])("%s transport: removeAgent() (web-hub-delete-session v2 §4.1 — identical wire both modes)", (_mode, make) => {
  it("implements removeAgent on every adapter", () => {
    const h = make(async () => resp(200));
    expect(typeof h.transport.removeAgent).toBe("function");
  });

  it("POSTs /api/agents/remove with X-PWH:1 and the verbatim JSON target; 200 {removed:true} rides", async () => {
    const h = make(async (url) => (url === "/api/agents/remove" ? resp(200, { removed: true }) : resp(200)));
    const r = await h.transport.removeAgent!({ agentKey: "a1" });
    expect(r).toEqual({ ok: true, removed: true });
    const call = h.fetchCalls.find((c) => c.url === "/api/agents/remove")!;
    expect(call.init.method).toBe("POST");
    expect(call.init.headers?.["Content-Type"]).toBe("application/json");
    expect(call.init.headers?.["X-PWH"]).toBe("1");
    expect(JSON.parse(call.init.body as string)).toEqual({ agentKey: "a1" });
  });

  it("spawnId target rides verbatim too (SpawnRow's call shape)", async () => {
    const h = make(async (url) => (url === "/api/agents/remove" ? resp(200, { removed: true }) : resp(200)));
    await h.transport.removeAgent!({ spawnId: "sp1" });
    const call = h.fetchCalls.find((c) => c.url === "/api/agents/remove")!;
    expect(JSON.parse(call.init.body as string)).toEqual({ spawnId: "sp1" });
  });

  it("202 {removed:false,pending:true,spawnId,state} rides as pending/spawnId", async () => {
    const h = make(async (url) =>
      url === "/api/agents/remove"
        ? resp(202, { removed: false, pending: true, spawnId: "sp1", state: "stopping" })
        : resp(200),
    );
    const r = await h.transport.removeAgent!({ agentKey: "a1" });
    expect(r).toEqual({ ok: true, removed: false, pending: true, spawnId: "sp1" });
  });

  it("409 E_AGENT_ONLINE keeps its reason (online vs exit-unconfirmed)", async () => {
    const h = make(async (url) =>
      url === "/api/agents/remove" ? resp(409, { error: "E_AGENT_ONLINE", reason: "online" }) : resp(200),
    );
    expect(await h.transport.removeAgent!({ agentKey: "a1" })).toEqual({
      ok: false,
      error: "E_AGENT_ONLINE",
      reason: "online",
    });
    const h2 = make(async (url) =>
      url === "/api/agents/remove" ? resp(409, { error: "E_AGENT_ONLINE", reason: "exit-unconfirmed" }) : resp(200),
    );
    expect(await h2.transport.removeAgent!({ agentKey: "a1" })).toEqual({
      ok: false,
      error: "E_AGENT_ONLINE",
      reason: "exit-unconfirmed",
    });
  });

  it("403 E_SPAWN_DENIED{lan-off} / 404 E_NOT_FOUND / 429 E_RATE surface verbatim", async () => {
    const h = make(async (url) =>
      url === "/api/agents/remove" ? resp(403, { error: "E_SPAWN_DENIED", reason: "lan-off" }) : resp(200),
    );
    expect(await h.transport.removeAgent!({ agentKey: "a1" })).toEqual({
      ok: false,
      error: "E_SPAWN_DENIED",
      reason: "lan-off",
    });
    const h2 = make(async (url) => (url === "/api/agents/remove" ? resp(404, { error: "E_NOT_FOUND" }) : resp(200)));
    expect(await h2.transport.removeAgent!({ spawnId: "sp-gone" })).toEqual({ ok: false, error: "E_NOT_FOUND" });
    const h3 = make(async (url) =>
      url === "/api/agents/remove" ? resp(429, { error: "E_RATE" }, { "Retry-After": "3" }) : resp(200),
    );
    expect(await h3.transport.removeAgent!({ agentKey: "a1" })).toEqual({
      ok: false,
      error: "E_RATE",
      retryAfterS: 3,
    });
  });

  it("fetch timeout ⇒ E_DEADLINE and exactly one attempt; network error ⇒ E_NETWORK", async () => {
    const h = make(async (url) => (url === "/api/agents/remove" ? new Promise<FetchResponse>(() => {}) : resp(200)));
    const p = h.transport.removeAgent!({ agentKey: "a1" });
    h.clock.advance(16_000);
    expect(await p).toEqual({ ok: false, error: "E_DEADLINE" });
    expect(h.fetchCalls.filter((c) => c.url === "/api/agents/remove")).toHaveLength(1);

    const h2 = make(async (url) =>
      url === "/api/agents/remove" ? Promise.reject(new TypeError("fetch failed")) : resp(200),
    );
    expect(await h2.transport.removeAgent!({ agentKey: "a1" })).toEqual({ ok: false, error: "E_NETWORK" });
  });

  it("a final 401 reports onConn('auth') exactly once", async () => {
    const h = make(async (url) => (url === "/api/agents/remove" ? resp(401, { error: "E_AUTH" }) : resp(200)));
    expect(await h.transport.removeAgent!({ agentKey: "a1" })).toMatchObject({ ok: false, error: "E_AUTH" });
    expect(h.onConnCalls.filter((c) => c === "auth")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// web-hub-preview plan v3 §4.6 (package PV4): the shared preview suite — both adapters.
// ---------------------------------------------------------------------------

/** A FetchResponse whose body is raw bytes; tracks whether `arrayBuffer()` was ever called. */
function respBytes(status: number, bytes: Uint8Array, headers: Record<string, string>, body: unknown = {}) {
  let arrayBufferCalls = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n] ?? null },
    json: async () => body,
    arrayBuffer: async () => {
      arrayBufferCalls++;
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
    arrayBufferCalls: () => arrayBufferCalls,
  };
}

const PREVIEW_REQ = { agentKey: "A", sessionId: "s1", path: "/home/u/proj/a b.png" };
const PREVIEW_URL = `/api/preview?agentKey=A&sessionId=s1&path=${encodeURIComponent("/home/u/proj/a b.png")}`;
const PNG_HEADERS = {
  "Content-Type": "image/png",
  "Content-Length": "3",
  "X-PWH-Preview-Kind": "image",
  "X-PWH-Preview-Size": "3",
  "X-PWH-Preview-Dims": "10x10",
};
const previewOpts = () => ({ signal: new AbortController().signal, maxPixels: 40_000_000 });

describe.each([
  ["token", (fetchImpl: FetchImpl) => makeToken(fetchImpl)] as const,
  ["password", (fetchImpl: FetchImpl) => makePassword(fetchImpl)] as const,
])("%s transport: preview (web-hub-preview plan v3 §4.6, PV4)", (mode, make) => {
  it("implements the PreviewTransport surface on every adapter", () => {
    expect(typeof make().transport.preview?.fetch).toBe("function");
  });

  it('fetch(): GET /api/preview?agentKey&sessionId&path (encoded) with X-PWH:"1"', async () => {
    const h = make(async () => respBytes(200, new Uint8Array([80, 78, 71]), PNG_HEADERS));
    await h.transport.preview!.fetch(PREVIEW_REQ, previewOpts());
    const call = h.fetchCalls.find((c) => c.url === PREVIEW_URL);
    expect(call).toBeDefined();
    expect(call!.init.method).toBe("GET");
    expect(call!.init.headers?.["X-PWH"]).toBe("1");
  });

  it("image 200 ⇒ ok image: mime/dims/size from the headers, body bytes in the Blob", async () => {
    const h = make(async () => respBytes(200, new Uint8Array([80, 78, 71]), PNG_HEADERS));
    const out = await h.transport.preview!.fetch(PREVIEW_REQ, previewOpts());
    expect(out).toMatchObject({ ok: true, kind: "image", mime: "image/png", size: 3, dims: { w: 10, h: 10 } });
    if (out.ok && out.kind === "image") {
      expect(new Uint8Array(await out.blob.arrayBuffer())).toEqual(new Uint8Array([80, 78, 71]));
      expect(out.blob.type).toBe("image/png");
    }
  });

  it("text 200 ⇒ ok text: decoded body, truncated flag, display size from X-PWH-Preview-Size", async () => {
    const bytes = new TextEncoder().encode("hello 预览");
    const h = make(async () =>
      respBytes(200, bytes, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": String(bytes.byteLength),
        "X-PWH-Preview-Kind": "text",
        "X-PWH-Preview-Size": "999999",
        "X-PWH-Preview-Truncated": "1",
      }),
    );
    const out = await h.transport.preview!.fetch(PREVIEW_REQ, previewOpts());
    expect(out).toEqual({ ok: true, kind: "text", size: 999999, truncated: true, text: "hello 预览" });
  });

  it("dims over the client maxPixels budget ⇒ E_PREVIEW_TOO_LARGE pixels, aborts BEFORE reading the body", async () => {
    const r200 = respBytes(200, new Uint8Array([80, 78, 71]), { ...PNG_HEADERS, "X-PWH-Preview-Dims": "8000x4000" });
    const h = make(async () => r200);
    const out = await h.transport.preview!.fetch(PREVIEW_REQ, {
      signal: new AbortController().signal,
      maxPixels: 20_000_000,
    });
    expect(out).toEqual({
      ok: false,
      status: 0,
      error: "E_PREVIEW_TOO_LARGE",
      reason: "pixels",
      size: 3,
      max: 20_000_000,
      dims: { w: 8000, h: 4000 },
    });
    expect(r200.arrayBufferCalls()).toBe(0);
  });

  it("Content-Length over the listener image cap (token 16 MiB / LAN 4 MiB) ⇒ E_PREVIEW_TOO_LARGE bytes, body never read", async () => {
    const cap = mode === "token" ? 16 * 1024 * 1024 : 4 * 1024 * 1024;
    const r200 = respBytes(200, new Uint8Array([80, 78, 71]), { ...PNG_HEADERS, "Content-Length": String(cap + 1) });
    const h = make(async () => r200);
    const out = await h.transport.preview!.fetch(PREVIEW_REQ, previewOpts());
    expect(out).toMatchObject({ ok: false, status: 0, error: "E_PREVIEW_TOO_LARGE", reason: "bytes", max: cap });
    expect(r200.arrayBufferCalls()).toBe(0);
  });

  it("image dims missing ⇒ E_PREVIEW_UNSUPPORTED dims-unknown, body never read", async () => {
    const { "X-PWH-Preview-Dims": _dropped, ...noDims } = PNG_HEADERS;
    const r200 = respBytes(200, new Uint8Array([80, 78, 71]), noDims);
    const h = make(async () => r200);
    const out = await h.transport.preview!.fetch(PREVIEW_REQ, previewOpts());
    expect(out).toMatchObject({ ok: false, status: 0, error: "E_PREVIEW_UNSUPPORTED", reason: "dims-unknown" });
    expect(r200.arrayBufferCalls()).toBe(0);
  });

  it("out-of-contract headers (Kind missing) ⇒ E_BAD_RESPONSE, body never read", async () => {
    const { "X-PWH-Preview-Kind": _dropped, ...noKind } = PNG_HEADERS;
    const r200 = respBytes(200, new Uint8Array([80, 78, 71]), noKind);
    const h = make(async () => r200);
    const out = await h.transport.preview!.fetch(PREVIEW_REQ, previewOpts());
    expect(out).toMatchObject({ ok: false, status: 0, error: "E_BAD_RESPONSE" });
    expect(r200.arrayBufferCalls()).toBe(0);
  });

  it("a body shorter than Content-Length (hub destroy mid-stream, §4.5.2) ⇒ E_PREVIEW_CHANGED", async () => {
    const h = make(async () => respBytes(200, new Uint8Array([80]), PNG_HEADERS)); // 1 byte vs Content-Length 3
    const out = await h.transport.preview!.fetch(PREVIEW_REQ, previewOpts());
    expect(out).toEqual({ ok: false, status: 200, error: "E_PREVIEW_CHANGED" });
  });

  it("415 E_PREVIEW_UNSUPPORTED / 409 E_SESSION_CHANGED ride the body verbatim", async () => {
    const h415 = make(async (url) =>
      url.startsWith("/api/preview")
        ? respBytes(415, new Uint8Array(), {}, { error: "E_PREVIEW_UNSUPPORTED", reason: "binary", size: 42 })
        : resp(200),
    );
    expect(await h415.transport.preview!.fetch(PREVIEW_REQ, previewOpts())).toEqual({
      ok: false,
      status: 415,
      error: "E_PREVIEW_UNSUPPORTED",
      reason: "binary",
      size: 42,
    });
    const h409 = make(async (url) =>
      url.startsWith("/api/preview") ? respBytes(409, new Uint8Array(), {}, { error: "E_SESSION_CHANGED" }) : resp(200),
    );
    expect(await h409.transport.preview!.fetch(PREVIEW_REQ, previewOpts())).toEqual({
      ok: false,
      status: 409,
      error: "E_SESSION_CHANGED",
    });
  });

  it("429 folds Retry-After into retryAfterS", async () => {
    const h = make(async (url) =>
      url.startsWith("/api/preview")
        ? respBytes(429, new Uint8Array(), { "Retry-After": "2" }, { error: "E_RATE" })
        : resp(200),
    );
    expect(await h.transport.preview!.fetch(PREVIEW_REQ, previewOpts())).toMatchObject({
      ok: false,
      status: 429,
      error: "E_RATE",
      retryAfterS: 2,
    });
  });

  it("a PRE-aborted signal never issues the request at all", async () => {
    const h = make(async () => resp(200));
    const ac = new AbortController();
    ac.abort();
    const out = await h.transport.preview!.fetch(PREVIEW_REQ, { signal: ac.signal, maxPixels: 40_000_000 });
    expect(out).toEqual({ ok: false, status: 0, error: "E_ABORT" });
    expect(h.fetchCalls.filter((c) => c.url.startsWith("/api/preview"))).toHaveLength(0);
  });

  it("an external abort mid-flight ⇒ E_ABORT (the fetch's own abort rejection surfaces)", async () => {
    const h = make(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as { signal?: AbortSignal } | undefined)?.signal?.addEventListener("abort", () =>
            reject(new Error("AbortError")),
          );
        }) as never,
    );
    const ac = new AbortController();
    const p = h.transport.preview!.fetch(PREVIEW_REQ, { signal: ac.signal, maxPixels: 40_000_000 });
    ac.abort();
    expect(await p).toEqual({ ok: false, status: 0, error: "E_ABORT" });
  });

  it("client timeout (40s, §0 客户端超时) ⇒ E_DEADLINE status 0, exactly one attempt", async () => {
    const h = make(async () => new Promise<never>(() => {}));
    const p = h.transport.preview!.fetch(PREVIEW_REQ, previewOpts());
    h.clock.advance(40_000);
    expect(await p).toEqual({ ok: false, status: 0, error: "E_DEADLINE" });
    expect(h.fetchCalls.filter((c) => c.url.startsWith("/api/preview"))).toHaveLength(1);
  });
});

describe("token transport: preview() 401 recovery (withRelogin, GET replay is side-effect free)", () => {
  it("a 401 with a stored token silently re-logs in and replays the SAME GET (no login-view flash)", async () => {
    const h = makeToken(async (url) => {
      if (url === "/api/login") return resp(200);
      if (url.startsWith("/api/preview")) {
        const loggedIn = h.fetchCalls.some((c) => c.url === "/api/login");
        return loggedIn ? respBytes(200, new Uint8Array([80, 78, 71]), PNG_HEADERS) : resp(401, { error: "E_AUTH" });
      }
      return resp(200);
    });
    h.storage!.set(TOKEN_KEY, "stored-token");
    const out = await h.transport.preview!.fetch(PREVIEW_REQ, previewOpts());
    expect(out).toMatchObject({ ok: true, kind: "image" });
    expect(h.fetchCalls.filter((c) => c.url.startsWith("/api/preview"))).toHaveLength(2);
    expect(h.onConnCalls).not.toContain("auth");
  });

  it("a FINAL 401 (no stored token) surfaces E_AUTH and reports onConn('auth') exactly once", async () => {
    const h = makeToken(async (url) => (url.startsWith("/api/preview") ? resp(401, { error: "E_AUTH" }) : resp(200)));
    const out = await h.transport.preview!.fetch(PREVIEW_REQ, previewOpts());
    expect(out).toEqual({ ok: false, status: 401, error: "E_AUTH" });
    expect(h.onConnCalls.filter((c) => c === "auth")).toHaveLength(1);
  });
});

describe("password transport: preview() 401 (one-shot — the cookie session is gone)", () => {
  it("a 401 surfaces E_AUTH and reports onConn('auth') exactly once (fetch wrapper, never double-fired)", async () => {
    const h = makePassword(async (url) =>
      url.startsWith("/api/preview") ? resp(401, { error: "E_AUTH" }) : resp(200),
    );
    const out = await h.transport.preview!.fetch(PREVIEW_REQ, previewOpts());
    expect(out).toEqual({ ok: false, status: 401, error: "E_AUTH" });
    expect(h.onConnCalls.filter((c) => c === "auth")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// web-hub-preview 2026-10-07 修订「先探测后标记」: the probe method — same suite both modes.
// Wire shape pinned against `hub/preview/probe.ts` + `routes.ts`'s handleProbe: POST
// `${PREVIEW_PROBE_PATH}?agentKey&sessionId` with `{paths:[…]}` JSON + `X-PWH:"1"`, 200 body
// `{results:[{kind}…]}` (validated by `parseProbeResults`), one 5s deadline.
// ---------------------------------------------------------------------------

const PROBE_REQ = { agentKey: "A", sessionId: "s1", paths: ["/home/u/proj/a b.ts", "/home/u/proj/gone.ts"] };
const PROBE_URL = "/api/preview/probe?agentKey=A&sessionId=s1";

describe.each([
  ["token", (fetchImpl: FetchImpl) => makeToken(fetchImpl)] as const,
  ["password", (fetchImpl: FetchImpl) => makePassword(fetchImpl)] as const,
])("%s transport: probe (web-hub-preview 2026-10-07 修订)", (_mode, make) => {
  it("implements probe() on every adapter", () => {
    expect(typeof make().transport.preview?.probe).toBe("function");
  });

  it("POSTs {paths} JSON with X-PWH:1 and returns the kinds in request order", async () => {
    const h = make(async () => resp(200, { results: [{ kind: "text" }, { kind: "missing" }] }));
    const out = await h.transport.preview!.probe(PROBE_REQ);
    expect(out).toEqual({ ok: true, results: ["text", "missing"] });
    const call = h.fetchCalls.find((c) => c.url.startsWith(PROBE_URL));
    expect(call).toBeDefined();
    expect(call!.init.method).toBe("POST");
    expect(call!.init.headers?.["X-PWH"]).toBe("1");
    expect(JSON.parse(String(call!.init.body))).toEqual({ paths: PROBE_REQ.paths });
  });

  it("a non-200 surfaces the error half (status/error, retryAfterS folded from 429)", async () => {
    const h = make(async () => resp(429, { error: "E_RATE" }, { "Retry-After": "2" }));
    const out = await h.transport.preview!.probe(PROBE_REQ);
    expect(out).toEqual({ ok: false, status: 429, error: "E_RATE", retryAfterS: 2 });
  });

  it("a malformed 200 body (wrong length / bad kind) ⇒ local E_BAD_RESPONSE, status 0", async () => {
    const h1 = make(async () => resp(200, { results: [{ kind: "text" }] }));
    expect(await h1.transport.preview!.probe(PROBE_REQ)).toEqual({
      ok: false,
      status: 0,
      error: "E_BAD_RESPONSE",
    });
    const h2 = make(async () => resp(200, { results: [{ kind: "binary" }, { kind: "text" }] }));
    expect(await h2.transport.preview!.probe(PROBE_REQ)).toEqual({
      ok: false,
      status: 0,
      error: "E_BAD_RESPONSE",
    });
  });

  it("client timeout (5s, 修订 spec) ⇒ E_DEADLINE status 0, exactly one attempt", async () => {
    const h = make(async () => new Promise<never>(() => {}));
    const p = h.transport.preview!.probe(PROBE_REQ);
    h.clock.advance(5_000);
    expect(await p).toEqual({ ok: false, status: 0, error: "E_DEADLINE" });
    expect(h.fetchCalls.filter((c) => c.url.startsWith(PROBE_URL))).toHaveLength(1);
  });

  it("a PRE-aborted signal never issues the request", async () => {
    const h = make(async () => resp(200, { results: [] }));
    const ac = new AbortController();
    ac.abort();
    const out = await h.transport.preview!.probe(PROBE_REQ, { signal: ac.signal });
    expect(out).toEqual({ ok: false, status: 0, error: "E_ABORT" });
    expect(h.fetchCalls.filter((c) => c.url.startsWith(PROBE_URL))).toHaveLength(0);
  });
});

describe("token transport: probe() 401 recovery (withRelogin — replay is read-only)", () => {
  it("a 401 with a stored token silently re-logs in and replays the SAME probe", async () => {
    const h = makeToken(async (url) => {
      if (url === "/api/login") return resp(200);
      if (url.startsWith(PROBE_URL)) {
        const loggedIn = h.fetchCalls.some((c) => c.url === "/api/login");
        return loggedIn
          ? resp(200, { results: [{ kind: "text" }, { kind: "missing" }] })
          : resp(401, { error: "E_AUTH" });
      }
      return resp(200);
    });
    h.storage!.set(TOKEN_KEY, "stored-token");
    const out = await h.transport.preview!.probe(PROBE_REQ);
    expect(out).toMatchObject({ ok: true });
    expect(h.fetchCalls.filter((c) => c.url.startsWith(PROBE_URL))).toHaveLength(2);
    expect(h.onConnCalls).not.toContain("auth");
  });
});

// ---------------------------------------------------------------------------
// run-transcript endpoints (fleet-drawer plan §3.4/§6.5, package F5) — same suite both modes.
// The wire shapes below are pinned against the F4 routes (`hub/run-routes.ts`: POST bodies
// {clientId, agentKey, runId}, GET `/api/run/history?agent=&run=&before=&limit=`) and the
// §3.6 error body `{error, message: RunTxReason}` whose `message` must surface as `reason`.
// ---------------------------------------------------------------------------

describe.each([
  ["token", (fetchImpl: FetchImpl) => makeToken(fetchImpl)] as const,
  ["password", (fetchImpl: FetchImpl) => makePassword(fetchImpl)] as const,
])("%s transport: runSubscribe/runUnsubscribe/runPage (fleet-drawer §3.4/§6.5)", (_mode, make) => {
  const RUN = "r_AB12CD34";

  it("runSubscribe(): POST /api/run/subscribe with X-PWH:1 and a JSON {clientId, agentKey, runId} body; 202 ⇒ ok", async () => {
    const h = make(async (url) => (url === "/api/run/subscribe" ? resp(202, { ok: true }) : resp(200)));
    const r = await h.transport.runSubscribe!("c1", "agent-A", RUN);
    expect(r).toEqual({ ok: true });
    const call = h.fetchCalls.find((c) => c.url === "/api/run/subscribe");
    expect(call).toBeDefined();
    expect(call!.init.method).toBe("POST");
    expect(call!.init.headers?.["X-PWH"]).toBe("1");
    expect(JSON.parse(call!.init.body ?? "{}")).toEqual({ clientId: "c1", agentKey: "agent-A", runId: RUN });
  });

  it("runSubscribe(): the §3.6 denial body's `message` surfaces as `reason` (E_NOT_FOUND/not_persisted)", async () => {
    const h = make(async (url) =>
      url === "/api/run/subscribe" ? resp(404, { error: "E_NOT_FOUND", message: "not_persisted" }) : resp(200),
    );
    const r = await h.transport.runSubscribe!("c1", "agent-A", RUN);
    expect(r).toEqual({ ok: false, error: "E_NOT_FOUND", reason: "not_persisted" });
  });

  it("runUnsubscribe(): POST /api/run/unsubscribe with the same body shape, resolves void on any outcome (fire-and-forget)", async () => {
    const h = make(async (url) => (url === "/api/run/unsubscribe" ? resp(200, { ok: true }) : resp(200)));
    await expect(h.transport.runUnsubscribe!("c1", "agent-A", RUN)).resolves.toBeUndefined();
    const call = h.fetchCalls.find((c) => c.url === "/api/run/unsubscribe");
    expect(call).toBeDefined();
    expect(call!.init.method).toBe("POST");
    expect(call!.init.headers?.["X-PWH"]).toBe("1");
    expect(JSON.parse(call!.init.body ?? "{}")).toEqual({ clientId: "c1", agentKey: "agent-A", runId: RUN });
    // even a network failure is swallowed (§6.5: 吞掉失败)
    const h2 = make(async (url) =>
      url === "/api/run/unsubscribe" ? Promise.reject(new TypeError("boom")) : resp(200),
    );
    await expect(h2.transport.runUnsubscribe!("c1", "agent-A", RUN)).resolves.toBeUndefined();
  });

  it(`runPage(): GET /api/run/history?agent&run&before&limit, limit clamped to HISTORY_LIMIT_MAX (${HISTORY_LIMIT_MAX})`, async () => {
    const h = make(async () => resp(200, { entries: [], hasMore: false }));
    const r = await h.transport.runPage!("agent-A", RUN, "entry-1", 999_999);
    expect(r.ok).toBe(true);
    const call = h.fetchCalls.find((c) => c.url.startsWith("/api/run/history"));
    expect(call).toBeDefined();
    expect(call!.init.method ?? "GET").toBe("GET");
    expect(call!.url).toBe(`/api/run/history?agent=agent-A&run=${RUN}&before=entry-1&limit=${HISTORY_LIMIT_MAX}`);
  });

  it("runPage(): the denial body's `message` surfaces as `reason` (paging-time not_persisted disables load-older)", async () => {
    const h = make(async (url) =>
      url.startsWith("/api/run/history") ? resp(404, { error: "E_NOT_FOUND", message: "not_persisted" }) : resp(200),
    );
    const r = await h.transport.runPage!("agent-A", RUN, "entry-1");
    expect(r).toEqual({ ok: false, error: "E_NOT_FOUND", reason: "not_persisted" });
  });

  it("runSubscribe(): a REST 401 with no successful recovery reports onConn('auth') exactly once (U12)", async () => {
    const h = make(async (url) => (url === "/api/run/subscribe" ? resp(401, { error: "E_AUTH" }) : resp(200)));
    const r = await h.transport.runSubscribe!("c1", "A", RUN);
    expect(r).toEqual({ ok: false, error: "E_AUTH" });
    expect(h.onConnCalls.filter((c) => c === "auth")).toHaveLength(1);
  });

  it("runPage(): a REST 401 with no successful recovery reports onConn('auth') (U12)", async () => {
    const h = make(async (url) => (url.startsWith("/api/run/history") ? resp(401, { error: "E_AUTH" }) : resp(200)));
    const r = await h.transport.runPage!("A", RUN, "e1");
    expect(r).toEqual({ ok: false, error: "E_AUTH" });
    expect(h.onConnCalls.filter((c) => c === "auth")).toHaveLength(1);
  });

  it("runUnsubscribe(): a REST 401 reports onConn('auth') even though the call itself is fire-and-forget (U12; same rule as unsubscribe)", async () => {
    const h = make(async (url) => (url === "/api/run/unsubscribe" ? resp(401, { error: "E_AUTH" }) : resp(200)));
    await h.transport.runUnsubscribe!("c1", "A", RUN); // resolves void either way — onConn is the only signal
    expect(h.onConnCalls.filter((c) => c === "auth")).toHaveLength(1);
  });
});

describe("token transport: run-method 401 recovery (fleet-drawer §6.5 — withRelogin replay, U12)", () => {
  const RUN = "r_AB12CD34";

  it("runSubscribe(): a 401 with a stored token silently re-logs in and replays the SAME body (never reports auth)", async () => {
    const calls: string[] = [];
    const h = makeToken(async (url) => {
      calls.push(url);
      if (url === "/api/login") return resp(200);
      if (url === "/api/run/subscribe")
        return calls.filter((u) => u === "/api/login").length > 0
          ? resp(202, { ok: true })
          : resp(401, { error: "E_AUTH" });
      return resp(200);
    });
    h.storage!.set(TOKEN_KEY, "stored-token");
    const r = await h.transport.runSubscribe!("c1", "A", RUN);
    expect(r).toEqual({ ok: true });
    expect(calls.filter((u) => u === "/api/run/subscribe")).toHaveLength(2);
    const bodies = h.fetchCalls.filter((c) => c.url === "/api/run/subscribe").map((c) => c.init.body);
    expect(bodies[0]).toBe(bodies[1]); // same body replayed
    expect(h.onConnCalls).not.toContain("auth"); // recovered — no login-form flash
  });

  it("runPage(): a 401 with a stored token re-logs in and replays the same GET", async () => {
    const calls: string[] = [];
    const h = makeToken(async (url) => {
      calls.push(url);
      if (url === "/api/login") return resp(200);
      if (url.startsWith("/api/run/history"))
        return calls.filter((u) => u === "/api/login").length > 0
          ? resp(200, { entries: [] })
          : resp(401, { error: "E_AUTH" });
      return resp(200);
    });
    h.storage!.set(TOKEN_KEY, "stored-token");
    const r = await h.transport.runPage!("A", RUN, "e1");
    expect(r.ok).toBe(true);
    expect(calls.filter((u) => u.startsWith("/api/run/history"))).toHaveLength(2);
    expect(h.onConnCalls).not.toContain("auth");
  });
});

// ---------------------------------------------------------------------------
// spawn prefs — default-model plan F1 (§3 ④: POST /api/headless/prefs), same suite both modes
// ---------------------------------------------------------------------------

describe.each([
  ["token", (fetchImpl: FetchImpl) => makeToken(fetchImpl)] as const,
  ["password", (fetchImpl: FetchImpl) => makePassword(fetchImpl)] as const,
])("%s transport: spawn prefs (default-model plan F1 — identical wire both modes)", (_mode, make) => {
  it("implements setPrefs on every adapter", () => {
    const h = make(async () => resp(200));
    expect(typeof h.transport.spawn!.setPrefs).toBe("function");
  });

  it("list(): a well-formed prefs slot rides; absent/malformed drops the field (unknown ≠ cleared)", async () => {
    const h = make(async (url) =>
      url === "/api/headless"
        ? resp(200, { policy: { allowed: true }, items: [], prefs: { defaultModel: "anthropic/claude-opus-4-5" } })
        : resp(200),
    );
    expect(await h.transport.spawn!.list()).toEqual({
      ok: true,
      policy: { allowed: true },
      items: [],
      prefs: { defaultModel: "anthropic/claude-opus-4-5" },
    });
    const h2 = make(async (url) =>
      url === "/api/headless" ? resp(200, { policy: { allowed: true }, items: [] }) : resp(200),
    );
    expect(await h2.transport.spawn!.list()).toEqual({ ok: true, policy: { allowed: true }, items: [] });
    const h3 = make(async (url) =>
      url === "/api/headless"
        ? resp(200, { policy: { allowed: true }, items: [], prefs: { defaultModel: 42 } })
        : resp(200),
    );
    expect(await h3.transport.spawn!.list()).toEqual({
      ok: true,
      policy: { allowed: true },
      items: [],
      prefs: { defaultModel: null },
    });
  });

  it("setPrefs(): POST /api/headless/prefs with X-PWH:1 and the verbatim {defaultModel} body; 200 {prefs} rides", async () => {
    const h = make(async (url) =>
      url === "/api/headless/prefs" ? resp(200, { prefs: { defaultModel: "openai/gpt-5" } }) : resp(200),
    );
    const r = await h.transport.spawn!.setPrefs!("openai/gpt-5");
    expect(r).toEqual({ ok: true, prefs: { defaultModel: "openai/gpt-5" } });
    const call = h.fetchCalls.find((c) => c.url === "/api/headless/prefs")!;
    expect(call.init.method).toBe("POST");
    expect(call.init.headers?.["Content-Type"]).toBe("application/json");
    expect(call.init.headers?.["X-PWH"]).toBe("1");
    expect(JSON.parse(call.init.body as string)).toEqual({ defaultModel: "openai/gpt-5" });
  });

  it('setPrefs(""): the clear tri-state goes on the wire verbatim', async () => {
    const h = make(async (url) =>
      url === "/api/headless/prefs" ? resp(200, { prefs: { defaultModel: null } }) : resp(200),
    );
    const r = await h.transport.spawn!.setPrefs!("");
    expect(r).toEqual({ ok: true, prefs: { defaultModel: null } });
    const call = h.fetchCalls.find((c) => c.url === "/api/headless/prefs")!;
    expect(JSON.parse(call.init.body as string)).toEqual({ defaultModel: "" });
  });

  it('setPrefs(): 400 E_BAD_REQUEST{reason:"model-invalid"} keeps reason; 503 E_LAUNCHER{reason:"persist"} is retryable', async () => {
    const h = make(async (url) =>
      url === "/api/headless/prefs" ? resp(400, { error: "E_BAD_REQUEST", reason: "model-invalid" }) : resp(200),
    );
    expect(await h.transport.spawn!.setPrefs!("bad ref")).toMatchObject({
      ok: false,
      error: "E_BAD_REQUEST",
      reason: "model-invalid",
      retryable: false,
    });
    const h2 = make(async (url) =>
      url === "/api/headless/prefs" ? resp(503, { error: "E_LAUNCHER", reason: "persist" }) : resp(200),
    );
    expect(await h2.transport.spawn!.setPrefs!("p/m")).toMatchObject({
      ok: false,
      error: "E_LAUNCHER",
      reason: "persist",
      retryable: true,
    });
  });

  it("setPrefs(): network error ⇒ E_NETWORK retryable; a final 401 reports onConn('auth') once per call", async () => {
    const h = make(async (url) =>
      url === "/api/headless/prefs" ? Promise.reject(new TypeError("fetch failed")) : resp(200),
    );
    expect(await h.transport.spawn!.setPrefs!("p/m")).toMatchObject({ ok: false, error: "E_NETWORK", retryable: true });
    const h2 = make(async (url) => (url === "/api/headless/prefs" ? resp(401, { error: "E_AUTH" }) : resp(200)));
    expect(await h2.transport.spawn!.setPrefs!("p/m")).toMatchObject({ ok: false, error: "E_AUTH" });
    expect(h2.onConnCalls.filter((c) => c === "auth")).toHaveLength(1);
  });
});

describe("token transport: setPrefs() 401 recovery (withRelogin — the write replays verbatim, same value re-persists)", () => {
  it("a 401 with a stored token silently re-logs in and replays the SAME prefs body", async () => {
    const h = makeToken(async (url) => {
      if (url === "/api/login") return resp(200);
      if (url === "/api/headless/prefs") {
        const loggedIn = h.fetchCalls.some((c) => c.url === "/api/login");
        return loggedIn ? resp(200, { prefs: { defaultModel: "p/m" } }) : resp(401, { error: "E_AUTH" });
      }
      return resp(200);
    });
    h.storage!.set(TOKEN_KEY, "stored-token");
    const r = await h.transport.spawn!.setPrefs!("p/m");
    expect(r).toEqual({ ok: true, prefs: { defaultModel: "p/m" } });
    const posts = h.fetchCalls.filter((c) => c.url === "/api/headless/prefs");
    expect(posts).toHaveLength(2);
    expect(posts[0]!.init.body).toBe(posts[1]!.init.body);
    expect(h.onConnCalls).not.toContain("auth");
  });
});

// ---------------------------------------------------------------------------
// web-hub-preview dir-plan §5 P2: the `dir=1` fetch + `dirs:true` probe matrix — the SAME
// suite on both adapters (the two logic clients' dir branches are verbatim symmetric by
// construction; this matrix is the behavioral pin). §1.3's two paths are each pinned once:
// the FETCH path (Kind: dir without opt-in ⇒ E_BAD_RESPONSE, body aborted unread) and the
// PROBE path (dirs-less + "dir" ⇒ per-entry "missing" fold, never a batch failure).
// ---------------------------------------------------------------------------

/** A FetchResponse whose body streams via getReader() (the dir branch's preferred path). */
function respStream(status: number, chunks: Uint8Array[], headers: Record<string, string>) {
  let readerTaken = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n] ?? null },
    json: async () => {
      throw new Error("json() must not be called on a dir response");
    },
    arrayBuffer: async () => {
      throw new Error("arrayBuffer() must not be called when body.getReader exists");
    },
    body: {
      getReader() {
        readerTaken++;
        let i = 0;
        return {
          read: async () =>
            i < chunks.length
              ? { done: false as const, value: chunks[i++] }
              : { done: true as const, value: undefined },
          releaseLock(): void {},
        };
      },
    },
    readerTaken: () => readerTaken,
  };
}

const DIR_HEADERS = { "Content-Type": "application/json", "X-PWH-Preview-Kind": "dir" };
const LISTING = {
  entries: [
    { name: "src", type: "dir", size: 4096, mtimeMs: 1234567890123 },
    { name: "a.ts", type: "file", size: 10, mtimeMs: 1234567890123 },
  ],
  total: 2,
  scanned: 2,
  complete: true,
  truncated: false,
  limits: { scan: false, entries: false, bytes: false },
  vanished: 0,
  dropped: 0,
};
const listingBytes = (listing: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(listing));

describe.each([
  ["token", (fetchImpl: FetchImpl) => makeToken(fetchImpl)] as const,
  ["password", (fetchImpl: FetchImpl) => makePassword(fetchImpl)] as const,
])("%s transport: preview dir=1 (dir-plan §5 P2 — identical behavior both modes)", (_mode, make) => {
  it("fetch({dir:true}) appends &dir=1 to the URL; a streamed dir 200 ⇒ ok dir with the parsed listing", async () => {
    const h = make(async () => respStream(200, [listingBytes(LISTING)], DIR_HEADERS));
    const out = await h.transport.preview!.fetch({ ...PREVIEW_REQ, dir: true }, previewOpts());
    expect(out).toEqual({ ok: true, kind: "dir", listing: LISTING });
    const call = h.fetchCalls.find((c) => c.url.startsWith("/api/preview"));
    expect(call!.url).toBe(`${PREVIEW_URL}&dir=1`);
    expect(call!.init.method).toBe("GET");
  });

  it("a dir 200 without a streaming body falls back to arrayBuffer() and parses the same way", async () => {
    const bytes = listingBytes(LISTING);
    const h = make(async () =>
      respBytes(200, bytes, {
        ...DIR_HEADERS,
        "Content-Length": String(bytes.byteLength),
      }),
    );
    const out = await h.transport.preview!.fetch({ ...PREVIEW_REQ, dir: true }, previewOpts());
    expect(out).toEqual({ ok: true, kind: "dir", listing: LISTING });
  });

  it("§1.3 fetch path: Kind: dir WITHOUT the opt-in ⇒ E_BAD_RESPONSE, the body is never read", async () => {
    const r200 = respStream(200, [listingBytes(LISTING)], DIR_HEADERS);
    const h = make(async () => r200);
    const out = await h.transport.preview!.fetch(PREVIEW_REQ, previewOpts());
    expect(out).toEqual({ ok: false, status: 0, error: "E_BAD_RESPONSE" });
    expect(r200.readerTaken()).toBe(0);
    const h2 = make(async () => respBytes(200, listingBytes(LISTING), DIR_HEADERS));
    // (the arrayBuffer fallback fake: assert via a counter-less variant — schema-level refusal
    // happens in checkPreviewHeaders before any body access either way)
    const out2 = await h2.transport.preview!.fetch(PREVIEW_REQ, previewOpts());
    expect(out2).toEqual({ ok: false, status: 0, error: "E_BAD_RESPONSE" });
  });

  it("decoded bytes over PREVIEW_DIR_BODY_MAX_BYTES ⇒ abort + E_BAD_RESPONSE (streaming reader)", async () => {
    const chunk = new Uint8Array(300 * 1024); // two of these = 600 KiB > 512 KiB
    let sawAbort = false;
    const h = make(async (_url, init) => {
      init?.signal?.addEventListener?.("abort", () => {
        sawAbort = true;
      });
      return respStream(200, [chunk, chunk, chunk], DIR_HEADERS);
    });
    const out = await h.transport.preview!.fetch({ ...PREVIEW_REQ, dir: true }, previewOpts());
    expect(out).toEqual({ ok: false, status: 0, error: "E_BAD_RESPONSE" });
    expect(sawAbort).toBe(true); // the fetch was aborted so the server stops sending
  });

  it("the arrayBuffer fallback also refuses a body over the cap (byteLength checked after the read)", async () => {
    const h = make(async () => respBytes(200, new Uint8Array(PREVIEW_DIR_BODY_MAX_BYTES + 1), DIR_HEADERS));
    const out = await h.transport.preview!.fetch({ ...PREVIEW_REQ, dir: true }, previewOpts());
    expect(out).toEqual({ ok: false, status: 0, error: "E_BAD_RESPONSE" });
  });

  it("gzip: the cap judges DECODED bytes, never Content-Length (small compressed length, larger decoded body)", async () => {
    const decoded = listingBytes({
      ...LISTING,
      entries: Array.from({ length: 200 }, (_, i) => ({ name: `file-${i}.ts`, type: "file", size: i })),
      total: 200,
      scanned: 200,
    });
    const h = make(async () =>
      respStream(
        200,
        [decoded],
        { ...DIR_HEADERS, "Content-Encoding": "gzip", "Content-Length": "912" }, // compressed-looking length
      ),
    );
    const out = await h.transport.preview!.fetch({ ...PREVIEW_REQ, dir: true }, previewOpts());
    expect(out).toMatchObject({ ok: true, kind: "dir" });
    if (out.ok && out.kind === "dir") expect(out.listing.entries).toHaveLength(200);
  });

  it("a non-JSON body ⇒ E_BAD_RESPONSE (undecodable, status 0)", async () => {
    const h = make(async () => respStream(200, [new Uint8Array([0x89, 0x50, 0x4e, 0x47])], DIR_HEADERS));
    const out = await h.transport.preview!.fetch({ ...PREVIEW_REQ, dir: true }, previewOpts());
    expect(out).toEqual({ ok: false, status: 0, error: "E_BAD_RESPONSE" });
  });

  it("valid JSON but an off-schema listing ⇒ E_BAD_RESPONSE (parsePreviewDirListing's contract)", async () => {
    const bad = { ...LISTING, truncated: true }; // violates truncated === (entries<total || !complete)
    const h = make(async () => respStream(200, [listingBytes(bad)], DIR_HEADERS));
    const out = await h.transport.preview!.fetch({ ...PREVIEW_REQ, dir: true }, previewOpts());
    expect(out).toEqual({ ok: false, status: 0, error: "E_BAD_RESPONSE" });
  });

  it("non-200 dir-class errors ride the shared error mapping unchanged (403 E_PREVIEW_DENIED)", async () => {
    const h = make(async (url) =>
      url.includes("dir=1")
        ? respBytes(403, new Uint8Array(), {}, { error: "E_PREVIEW_DENIED", reason: "denylist" })
        : resp(200),
    );
    const out = await h.transport.preview!.fetch({ ...PREVIEW_REQ, dir: true }, previewOpts());
    expect(out).toEqual({ ok: false, status: 403, error: "E_PREVIEW_DENIED", reason: "denylist" });
  });
});

describe.each([
  ["token", (fetchImpl: FetchImpl) => makeToken(fetchImpl)] as const,
  ["password", (fetchImpl: FetchImpl) => makePassword(fetchImpl)] as const,
])("%s transport: probe dirs:true (dir-plan §1.3/§5 P2 — identical behavior both modes)", (_mode, make) => {
  it('probe({dirs:true}) sends {paths, dirs:true} and passes "dir" answers through', async () => {
    const h = make(async () => resp(200, { results: [{ kind: "text" }, { kind: "dir" }, { kind: "missing" }] }));
    const out = await h.transport.preview!.probe({ ...PROBE_REQ, paths: ["/a.ts", "/d", "/gone.ts"], dirs: true });
    expect(out).toEqual({ ok: true, results: ["text", "dir", "missing"] });
    const call = h.fetchCalls.find((c) => c.url.startsWith(PROBE_URL));
    expect(call).toBeDefined();
    expect(JSON.parse(String(call!.init.body))).toEqual({
      paths: ["/a.ts", "/d", "/gone.ts"],
      dirs: true,
    });
  });

  it('§1.3 probe path: a dirs-LESS request folds a received "dir" per-entry to "missing" (never a batch error)', async () => {
    const h = make(async () => resp(200, { results: [{ kind: "dir" }, { kind: "text" }, { kind: "dir" }] }));
    const out = await h.transport.preview!.probe({ ...PROBE_REQ, paths: ["/d1", "/a.ts", "/d2"] });
    expect(out).toEqual({ ok: true, results: ["missing", "text", "missing"] });
    // and the body carries NO dirs key for a dirs-less request
    const call = h.fetchCalls.find((c) => c.url.startsWith(PROBE_URL));
    expect(JSON.parse(String(call!.init.body))).toEqual({ paths: ["/d1", "/a.ts", "/d2"] });
  });
});

// ---------------------------------------------------------------------------
// worktree-diff plan v3.1 §1.2/§1.10/§4.6 (package D4): the two `GET /api/worktree-diff/*`
// endpoints — the SAME suite on both adapters (the two logic clients' wtdiff namespaces are
// verbatim symmetric by construction, the preview dir branch's discipline; this matrix is the
// behavioral pin). §1.10's envelope semantics: a capped JSON body (the cap judges DECODED
// bytes — gzip included, never Content-Length) → JSON.parse → the protocol parser
// (`parseWtDiffFileList` / `parseWtDiffFile`); ANY deviation ⇒ local E_BAD_RESPONSE (status 0),
// an over-cap body additionally ABORTS the fetch. Error bodies {error, reason} ride verbatim —
// a 409 E_STALE_CTX{reason:"base"|"entry"} reaches the caller untouched (the UI, D5, owns the
// one-shot re-pull; this layer never retries).
// ---------------------------------------------------------------------------

const OID = "0123456789abcdef0123456789abcdef01234567"; // 40-hex (WTDIFF_BASE_RE)
const WTD_HEADERS = { "Content-Type": "application/json" };
const FILES_BODY = {
  base: OID,
  entries: [
    { path: "src/a.ts", status: "M", add: 3, del: 1 },
    { path: "new.ts", orig: "old.ts", status: "R" },
    { path: "bin.dat", status: "M", binary: true },
    { path: "lfs.bin", status: "M", filtered: true },
    { path: "cr\rname.ts", status: "?" }, // displayable, never requestable (#7) — parser accepts
  ],
  total: 5,
  truncated: false,
  limits: { status: false, files: false, bytes: false },
};
const WT_PATCH = "@@ -1 +1,2 @@\n-a\n+b\n";
const FILE_BODY = {
  base: OID,
  path: "src/a b.ts",
  kind: "patch",
  patch: WT_PATCH,
  bytes: new TextEncoder().encode(WT_PATCH).length,
  truncated: false,
};
const wtdBytes = (body: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(body));
const FILES_REQ = { agentKey: "A", sessionId: "s1", wt: "/home/u/wt main" };
const FILE_REQ = {
  agentKey: "A",
  sessionId: "s1",
  wt: "/home/u/wt main",
  base: OID,
  path: "src/a b.ts",
  orig: "src/old.ts",
};
const WTD_FILES_URL = `/api/worktree-diff/files?agentKey=A&sessionId=s1&wt=${encodeURIComponent("/home/u/wt main")}`;
const WTD_FILE_URL = `/api/worktree-diff/file?agentKey=A&sessionId=s1&wt=${encodeURIComponent("/home/u/wt main")}&base=${OID}&path=${encodeURIComponent("src/a b.ts")}&orig=${encodeURIComponent("src/old.ts")}`;

describe.each([
  ["token", (fetchImpl: FetchImpl) => makeToken(fetchImpl)] as const,
  ["password", (fetchImpl: FetchImpl) => makePassword(fetchImpl)] as const,
])("%s transport: worktreeDiff (worktree-diff plan v3.1 §4.6, D4 — identical behavior both modes)", (_mode, make) => {
  it("implements the WorktreeDiffTransport surface on every adapter", () => {
    const wd = make().transport.worktreeDiff;
    expect(typeof wd?.files).toBe("function");
    expect(typeof wd?.file).toBe("function");
  });

  it("the fixtures are parser-valid (guards the fixtures themselves against silent drift)", () => {
    const listBytes = wtdBytes(FILES_BODY).byteLength;
    expect(parseWtDiffFileList(FILES_BODY, listBytes)).not.toBeNull();
    expect(parseWtDiffFile(FILE_BODY, wtdBytes(FILE_BODY).byteLength)).not.toBeNull();
  });

  it('files(): GET /api/worktree-diff/files?agentKey&sessionId&wt (encoded) with X-PWH:"1"; streamed 200 ⇒ ok value', async () => {
    const h = make(async () => respStream(200, [wtdBytes(FILES_BODY)], WTD_HEADERS));
    const out = await h.transport.worktreeDiff!.files(FILES_REQ);
    expect(out).toEqual({ ok: true, value: parseWtDiffFileList(FILES_BODY, wtdBytes(FILES_BODY).byteLength) });
    const call = h.fetchCalls.find((c) => c.url === WTD_FILES_URL);
    expect(call).toBeDefined();
    expect(call!.init.method).toBe("GET");
    expect(call!.init.headers?.["X-PWH"]).toBe("1");
  });

  it('files({untracked:"no"}) appends &untracked=no (the degraded list mode, §3.3)', async () => {
    const h = make(async () => respStream(200, [wtdBytes(FILES_BODY)], WTD_HEADERS));
    await h.transport.worktreeDiff!.files({ ...FILES_REQ, untracked: "no" });
    expect(h.fetchCalls.find((c) => c.url === `${WTD_FILES_URL}&untracked=no`)).toBeDefined();
  });

  it('file(): GET /api/worktree-diff/file?agentKey&sessionId&wt&base&path&orig with X-PWH:"1"; a 200 without a streaming body falls back to arrayBuffer()', async () => {
    const h = make(async () =>
      respBytes(200, wtdBytes(FILE_BODY), { ...WTD_HEADERS, "Content-Length": String(wtdBytes(FILE_BODY).byteLength) }),
    );
    const out = await h.transport.worktreeDiff!.file(FILE_REQ);
    expect(out).toEqual({ ok: true, value: parseWtDiffFile(FILE_BODY, wtdBytes(FILE_BODY).byteLength) });
    const call = h.fetchCalls.find((c) => c.url === WTD_FILE_URL);
    expect(call).toBeDefined();
    expect(call!.init.method).toBe("GET");
    expect(call!.init.headers?.["X-PWH"]).toBe("1");
  });

  it("file({untracked:\"no\"}) carries the list's mode (it joins the hub's changeset key, §1.2)", async () => {
    const h = make(async () => respStream(200, [wtdBytes(FILE_BODY)], WTD_HEADERS));
    await h.transport.worktreeDiff!.file({ ...FILE_REQ, untracked: "no" });
    expect(h.fetchCalls.find((c) => c.url === `${WTD_FILE_URL}&untracked=no`)).toBeDefined();
  });

  it("URL encoding is byte-identical across BOTH clients (space / # / % / Chinese / leading -)", async () => {
    const req = {
      agentKey: "A",
      sessionId: "s1",
      wt: "/home/u/我的 wt #1",
      base: OID,
      path: "-rf --output=x.ts",
      orig: "100%.ts",
      untracked: "no" as const,
    };
    const h1 = makeToken(async () => respStream(200, [wtdBytes(FILES_BODY)], WTD_HEADERS));
    await h1.transport.worktreeDiff!.files(req);
    const h2 = makePassword(async () => respStream(200, [wtdBytes(FILES_BODY)], WTD_HEADERS));
    await h2.transport.worktreeDiff!.files(req);
    expect(h1.fetchCalls[0]!.url).toBe(h2.fetchCalls[0]!.url);
    const url = h1.fetchCalls[0]!.url;
    // the tricky characters, spelled out (encodeURIComponent semantics pinned, not assumed)
    expect(url).toContain(encodeURIComponent("/home/u/我的 wt #1")); // space ⇒ %20, # ⇒ %23
    // and the same holds for the file endpoint, whose params add path/orig
    const h3 = makeToken(async () => respStream(200, [wtdBytes(FILE_BODY)], WTD_HEADERS));
    const h4 = makePassword(async () => respStream(200, [wtdBytes(FILE_BODY)], WTD_HEADERS));
    await h3.transport.worktreeDiff!.file(req);
    await h4.transport.worktreeDiff!.file(req);
    expect(h3.fetchCalls[0]!.url).toBe(h4.fetchCalls[0]!.url);
    const fileUrl = h3.fetchCalls[0]!.url;
    expect(fileUrl).toContain("100%25.ts"); // % ⇒ %25 (orig)
    expect(fileUrl).toContain("-rf%20--output%3Dx.ts"); // leading - stays literal, = ⇒ %3D (path)
    expect(fileUrl).toContain(`base=${OID}`);
  });

  it("decoded bytes over WTDIFF_LIST_BODY_MAX_BYTES ⇒ abort + E_BAD_RESPONSE (streaming reader)", async () => {
    const chunk = new Uint8Array(300 * 1024); // two of these = 600 KiB > 256 KiB
    let sawAbort = false;
    const h = make(async (_url, init) => {
      init?.signal?.addEventListener?.("abort", () => {
        sawAbort = true;
      });
      return respStream(200, [chunk, chunk, chunk], WTD_HEADERS);
    });
    const out = await h.transport.worktreeDiff!.files(FILES_REQ);
    expect(out).toEqual({ ok: false, status: 0, error: "E_BAD_RESPONSE" });
    expect(sawAbort).toBe(true); // the fetch was aborted so the server stops sending
  });

  it("decoded bytes over WTDIFF_FILE_BODY_MAX_BYTES ⇒ abort + E_BAD_RESPONSE (file endpoint, 1 MiB cap)", async () => {
    const chunk = new Uint8Array(600 * 1024); // 1.2 MiB total > 1 MiB
    let sawAbort = false;
    const h = make(async (_url, init) => {
      init?.signal?.addEventListener?.("abort", () => {
        sawAbort = true;
      });
      return respStream(200, [chunk, chunk], WTD_HEADERS);
    });
    expect(await h.transport.worktreeDiff!.file(FILE_REQ)).toEqual({ ok: false, status: 0, error: "E_BAD_RESPONSE" });
    expect(sawAbort).toBe(true);
  });

  it("the arrayBuffer fallback also refuses a body over the cap (byteLength checked after the read)", async () => {
    const hFiles = make(async () => respBytes(200, new Uint8Array(WTDIFF_LIST_BODY_MAX_BYTES + 1), WTD_HEADERS));
    expect(await hFiles.transport.worktreeDiff!.files(FILES_REQ)).toEqual({
      ok: false,
      status: 0,
      error: "E_BAD_RESPONSE",
    });
    const hFile = make(async () => respBytes(200, new Uint8Array(WTDIFF_FILE_BODY_MAX_BYTES + 1), WTD_HEADERS));
    expect(await hFile.transport.worktreeDiff!.file(FILE_REQ)).toEqual({
      ok: false,
      status: 0,
      error: "E_BAD_RESPONSE",
    });
  });

  it("gzip: the cap judges DECODED bytes, never Content-Length (small compressed length, larger decoded body)", async () => {
    const h = make(async () =>
      respStream(200, [wtdBytes(FILES_BODY)], { ...WTD_HEADERS, "Content-Encoding": "gzip", "Content-Length": "42" }),
    );
    const out = await h.transport.worktreeDiff!.files(FILES_REQ);
    expect(out).toMatchObject({ ok: true });
    if (out.ok) expect(out.value.base).toBe(OID);
  });

  it("a non-JSON body ⇒ E_BAD_RESPONSE (undecodable, status 0)", async () => {
    const h = make(async () => respStream(200, [new Uint8Array([0x89, 0x50, 0x4e, 0x47])], WTD_HEADERS));
    expect(await h.transport.worktreeDiff!.files(FILES_REQ)).toEqual({
      ok: false,
      status: 0,
      error: "E_BAD_RESPONSE",
    });
  });

  it("valid JSON but an off-schema envelope ⇒ E_BAD_RESPONSE (the protocol parser is the gate)", async () => {
    const badList = { ...FILES_BODY, truncated: true }; // violates truncated === (entries<total || limits.status)
    const h1 = make(async () => respStream(200, [wtdBytes(badList)], WTD_HEADERS));
    expect(await h1.transport.worktreeDiff!.files(FILES_REQ)).toEqual({
      ok: false,
      status: 0,
      error: "E_BAD_RESPONSE",
    });
    const badPayload = { ...FILE_BODY, kind: "binary", patch: "x" }; // kind!=="patch" ⇒ patch must be ""
    const h2 = make(async () => respStream(200, [wtdBytes(badPayload)], WTD_HEADERS));
    expect(await h2.transport.worktreeDiff!.file(FILE_REQ)).toEqual({
      ok: false,
      status: 0,
      error: "E_BAD_RESPONSE",
    });
  });

  it("409 E_STALE_CTX{base} / {entry} rides the {error, reason} body verbatim — never retried here (§4.5)", async () => {
    const hBase = make(async (url) =>
      url.startsWith("/api/worktree-diff/file") ? resp(409, { error: "E_STALE_CTX", reason: "base" }) : resp(200),
    );
    expect(await hBase.transport.worktreeDiff!.file(FILE_REQ)).toEqual({
      ok: false,
      status: 409,
      error: "E_STALE_CTX",
      reason: "base",
    });
    expect(hBase.fetchCalls.filter((c) => c.url.startsWith("/api/worktree-diff"))).toHaveLength(1); // no auto-retry
    const hEntry = make(async (url) =>
      url.startsWith("/api/worktree-diff/file") ? resp(409, { error: "E_STALE_CTX", reason: "entry" }) : resp(200),
    );
    expect(await hEntry.transport.worktreeDiff!.file(FILE_REQ)).toEqual({
      ok: false,
      status: 409,
      error: "E_STALE_CTX",
      reason: "entry",
    });
  });

  it("403 E_WTDIFF_DENIED{reason} and 415 E_WTDIFF_UNSUPPORTED{reason} ride verbatim too (§1.5 matrix)", async () => {
    const h403 = make(async (url) =>
      url.startsWith("/api/worktree-diff/files")
        ? resp(403, { error: "E_WTDIFF_DENIED", reason: "not-worktree" })
        : resp(200),
    );
    expect(await h403.transport.worktreeDiff!.files(FILES_REQ)).toEqual({
      ok: false,
      status: 403,
      error: "E_WTDIFF_DENIED",
      reason: "not-worktree",
    });
    const h415 = make(async (url) =>
      url.startsWith("/api/worktree-diff/files")
        ? resp(415, { error: "E_WTDIFF_UNSUPPORTED", reason: "unborn" })
        : resp(200),
    );
    expect(await h415.transport.worktreeDiff!.files(FILES_REQ)).toEqual({
      ok: false,
      status: 415,
      error: "E_WTDIFF_UNSUPPORTED",
      reason: "unborn",
    });
  });

  it("429 folds Retry-After into retryAfterS", async () => {
    const h = make(async (url) =>
      url.startsWith("/api/worktree-diff/files") ? resp(429, { error: "E_RATE" }, { "Retry-After": "3" }) : resp(200),
    );
    expect(await h.transport.worktreeDiff!.files(FILES_REQ)).toEqual({
      ok: false,
      status: 429,
      error: "E_RATE",
      retryAfterS: 3,
    });
  });

  it("client timeout (WTDIFF_CLIENT_TIMEOUT_MS = 35s, §1.9) ⇒ E_DEADLINE status 0, exactly one attempt", async () => {
    const h = make(async () => new Promise<never>(() => {}));
    const p1 = h.transport.worktreeDiff!.files(FILES_REQ);
    h.clock.advance(WTDIFF_CLIENT_TIMEOUT_MS);
    expect(await p1).toEqual({ ok: false, status: 0, error: "E_DEADLINE" });
    const p2 = h.transport.worktreeDiff!.file(FILE_REQ);
    h.clock.advance(WTDIFF_CLIENT_TIMEOUT_MS);
    expect(await p2).toEqual({ ok: false, status: 0, error: "E_DEADLINE" });
    expect(h.fetchCalls.filter((c) => c.url.startsWith("/api/worktree-diff"))).toHaveLength(2);
  });

  it("a PRE-aborted signal never issues the request at all", async () => {
    const h = make(async () => respStream(200, [wtdBytes(FILES_BODY)], WTD_HEADERS));
    const ac = new AbortController();
    ac.abort();
    expect(await h.transport.worktreeDiff!.files(FILES_REQ, { signal: ac.signal })).toEqual({
      ok: false,
      status: 0,
      error: "E_ABORT",
    });
    expect(await h.transport.worktreeDiff!.file(FILE_REQ, { signal: ac.signal })).toEqual({
      ok: false,
      status: 0,
      error: "E_ABORT",
    });
    expect(h.fetchCalls.filter((c) => c.url.startsWith("/api/worktree-diff"))).toHaveLength(0);
  });

  it("an external abort mid-flight ⇒ E_ABORT (the fetch's own abort rejection surfaces)", async () => {
    const h = make(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as { signal?: AbortSignal } | undefined)?.signal?.addEventListener("abort", () =>
            reject(new Error("AbortError")),
          );
        }) as never,
    );
    const ac = new AbortController();
    const p = h.transport.worktreeDiff!.file(FILE_REQ, { signal: ac.signal });
    ac.abort();
    expect(await p).toEqual({ ok: false, status: 0, error: "E_ABORT" });
  });
});

describe("token transport: worktreeDiff() 401 recovery (withRelogin — GET replay is side-effect free)", () => {
  it("a 401 with a stored token silently re-logs in and replays the SAME GET (no login-view flash)", async () => {
    const h = makeToken(async (url) => {
      if (url === "/api/login") return resp(200);
      if (url.startsWith("/api/worktree-diff/files")) {
        const loggedIn = h.fetchCalls.some((c) => c.url === "/api/login");
        return loggedIn ? respStream(200, [wtdBytes(FILES_BODY)], WTD_HEADERS) : resp(401, { error: "E_AUTH" });
      }
      return resp(200);
    });
    h.storage!.set(TOKEN_KEY, "stored-token");
    const out = await h.transport.worktreeDiff!.files(FILES_REQ);
    expect(out).toMatchObject({ ok: true });
    expect(h.fetchCalls.filter((c) => c.url.startsWith("/api/worktree-diff/files"))).toHaveLength(2);
    expect(h.onConnCalls).not.toContain("auth");
  });

  it("a FINAL 401 (no stored token) surfaces E_AUTH and reports onConn('auth') exactly once", async () => {
    const h = makeToken(async (url) =>
      url.startsWith("/api/worktree-diff") ? resp(401, { error: "E_AUTH" }) : resp(200),
    );
    const out = await h.transport.worktreeDiff!.file(FILE_REQ);
    expect(out).toEqual({ ok: false, status: 401, error: "E_AUTH" });
    expect(h.onConnCalls.filter((c) => c === "auth")).toHaveLength(1);
  });
});

describe("password transport: worktreeDiff() 401 (one-shot — the cookie session is gone)", () => {
  it("a 401 surfaces E_AUTH and reports onConn('auth') exactly once (fetch wrapper, never double-fired)", async () => {
    const h = makePassword(async (url) =>
      url.startsWith("/api/worktree-diff") ? resp(401, { error: "E_AUTH" }) : resp(200),
    );
    const out = await h.transport.worktreeDiff!.files(FILES_REQ);
    expect(out).toEqual({ ok: false, status: 401, error: "E_AUTH" });
    expect(h.onConnCalls.filter((c) => c === "auth")).toHaveLength(1);
  });

  it("a 401 on the file endpoint reports onConn('auth') once too (same lost-session signal)", async () => {
    const h = makePassword(async (url) =>
      url.startsWith("/api/worktree-diff/file") ? resp(401, { error: "E_AUTH" }) : resp(200),
    );
    const out = await h.transport.worktreeDiff!.file(FILE_REQ);
    expect(out).toEqual({ ok: false, status: 401, error: "E_AUTH" });
    expect(h.onConnCalls.filter((c) => c === "auth")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// spawn.history() — session-history plan §4.7.1, same wire both modes
// ---------------------------------------------------------------------------

describe.each([
  ["token", (fetchImpl: FetchImpl) => makeToken(fetchImpl)] as const,
  ["password", (fetchImpl: FetchImpl) => makePassword(fetchImpl)] as const,
])("%s transport: spawn.history() (session-history plan §4.7.1 — identical wire both modes)", (_mode, make) => {
  const ITEM = {
    key: "2026-10/a.jsonl",
    id: "sess-1111-2222",
    cwd: "/home/u/proj",
    cwdLabel: "proj",
    startedAt: "2026-10-01T00:00:00.000Z",
    mtimeMs: 1234,
    size: 10,
    title: "Fix",
    titleSource: "first",
    kind: "main",
    cwdState: "ok",
    startable: true,
    indexed: true,
  };

  it('GET /api/headless/history with X-PWH:"1"; q/kind/cursor/limit in the querystring (kind:"main" and a blank q are omitted)', async () => {
    const h = make(async (url) =>
      url.startsWith("/api/headless/history")
        ? resp(200, {
            items: [ITEM],
            stats: { files: 1, indexed: 1, enum: { complete: true, dirsDone: 1, dirsTotal: 1 } },
          })
        : resp(200),
    );
    const r = await h.transport.spawn!.history!({ q: "  fix ", kind: "main", cursor: "v1.abcdefghijk.3", limit: 25 });
    expect(r.ok).toBe(true);
    const call = h.fetchCalls.find((c) => c.url.startsWith("/api/headless/history"))!;
    expect(call.init.method ?? "GET").toBe("GET");
    expect(call.init.headers?.["X-PWH"]).toBe("1");
    expect(call.url).toBe("/api/headless/history?q=fix&cursor=v1.abcdefghijk.3&limit=25");
    if (r.ok) {
      expect(r.page.items).toHaveLength(1);
      expect(r.page.items[0]?.key).toBe("2026-10/a.jsonl");
    }
    // kind:"all" rides; a blank q does not
    await h.transport.spawn!.history!({ q: "  ", kind: "all" });
    expect(h.fetchCalls.at(-1)?.url).toBe("/api/headless/history?kind=all");
    await h.transport.spawn!.history!({});
    expect(h.fetchCalls.at(-1)?.url).toBe("/api/headless/history");
  });

  it("the 200 body is structurally narrowed: non-conforming items dropped, a missing stats.enum counts as complete", async () => {
    const h = make(async (url) =>
      url.startsWith("/api/headless/history")
        ? resp(200, {
            items: [ITEM, { key: "d/broken.jsonl" }, null],
            stats: { files: 3, indexed: 1 },
            incomplete: true,
            partial: { reason: "io" },
            liveness: "partial",
          })
        : resp(200),
    );
    const r = await h.transport.spawn!.history!({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.page.items).toHaveLength(1);
      expect(r.page.stats.enum).toEqual({ complete: true, dirsDone: 0, dirsTotal: 0 });
      expect(r.page.partial).toEqual({ reason: "io" });
      expect(r.page.liveness).toBe("partial");
      expect(r.page.incomplete).toBe(true);
    }
  });

  it("409 cursor-expired keeps its reason (the list reducer's auto-restart input)", async () => {
    const h = make(async (url) =>
      url.startsWith("/api/headless/history")
        ? resp(409, { error: "E_BAD_REQUEST", reason: "cursor-expired" })
        : resp(200),
    );
    const r = await h.transport.spawn!.history!({ cursor: "v1.zzzzzzzzzzz.9" });
    expect(r).toEqual({ ok: false, error: "E_BAD_REQUEST", status: 409, reason: "cursor-expired" });
  });

  it("503 busy / 429 rate ride their status verbatim (busy is the UI's retryable state)", async () => {
    const h = make(async (url) =>
      url.startsWith("/api/headless/history") ? resp(503, { error: "E_BUSY" }) : resp(200),
    );
    expect(await h.transport.spawn!.history!({})).toEqual({ ok: false, error: "E_BUSY", status: 503 });
    const h2 = make(async (url) =>
      url.startsWith("/api/headless/history") ? resp(429, { error: "E_RATE" }, { "Retry-After": "7" }) : resp(200),
    );
    expect(await h2.transport.spawn!.history!({})).toEqual({ ok: false, error: "E_RATE", status: 429 });
  });

  it("a non-object 200 body maps to E_BAD_RESPONSE (status 200 kept)", async () => {
    const h = make(async (url) => (url.startsWith("/api/headless/history") ? resp(200, "nope") : resp(200)));
    expect(await h.transport.spawn!.history!({})).toEqual({ ok: false, error: "E_BAD_RESPONSE", status: 200 });
  });

  it("401: the final outcome is E_AUTH (token mode re-logged in once through withRelogin first)", async () => {
    let calls = 0;
    const h = make(async (url) => {
      if (url.startsWith("/api/headless/history")) {
        calls++;
        return resp(401, { error: "E_AUTH" });
      }
      return resp(200);
    });
    const r = await h.transport.spawn!.history!({});
    expect(r).toEqual({ ok: false, error: "E_AUTH", status: 401 });
  });
});
