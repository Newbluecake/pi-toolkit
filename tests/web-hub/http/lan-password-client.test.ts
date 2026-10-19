/**
 * LC + LF integration (real HTTP route + the actual browser-side password-mode client, plan
 * §11's "LF+LC 联调测试（真实 http 路由 + 前端解析）" requirement — LC review fixes #6/#7,
 * lan-plan.md §15.9): `createPasswordClient` (`src/web-hub/ui/src/logic/password-client.js`) driven
 * against a *real* `createHttpFrontend` LAN listener, through a `fetch` adapter backed by real
 * `node:http` requests (`lanRequest` from `./lan-helpers.js`) rather than a hand-mocked response.
 * This is exactly the seam the two review findings slipped through: unit tests on either side
 * mocked the *other* side's shape correctly by construction, so a real field-name/tag mismatch
 * between them was invisible until both were wired together for real.
 */
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createPasswordClient } from "../../../src/web-hub/ui/src/logic/password-client.js";
import { lanPostJson, lanRequest, seedLanUser, startLan } from "./lan-helpers.js";

interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

/** Adapts `password-client.js`'s `fetch(url, init)` deps to a real LAN HTTP request, the way a
 * real browser's `fetch` would talk to a real hub \u2014 including the `Origin` header a browser
 * sets automatically (the client itself never sets it; CSRF requires it, §2.4). */
function fetchViaLan(
  port: number,
): (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponse> {
  return async (url, init = {}) => {
    const r = await lanRequest(port, {
      method: init.method ?? "GET",
      path: url,
      headers: { ...(init.headers ?? {}), Origin: `http://127.0.0.1:${port}` },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (name: string) => (r.headers[name.toLowerCase()] as string | undefined) ?? null },
      json: async () => (r.body.length > 0 ? JSON.parse(r.body) : {}),
    };
  };
}

/** Never actually opens an SSE connection \u2014 out of scope for these two field-name/tag checks,
 * which only exercise `POST /api/login`'s real response body. */
class NoopEventSource {
  readyState = 0;
  addEventListener(): void {}
  close(): void {}
}

function client(port: number) {
  return createPasswordClient({
    fetch: fetchViaLan(port),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    EventSource: NoopEventSource as any,
    location: { hash: "", pathname: "/", search: "" },
    history: { replaceState: () => {} },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (t: unknown) => clearTimeout(t as NodeJS.Timeout),
    now: () => Date.now(),
    onMessage: () => {},
    onConn: () => {},
    onAuthEvent: () => {},
    onUnauthenticated: () => {},
  });
}

describe("LC + LF integration: real /api/login response vs. the real frontend parser (lan-plan.md §15.9 #6/#7)", () => {
  it("review fix #6: a successful login with the initial password is surfaced as initialPassword:true (not lost to a field-name mismatch)", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "initial-secret-1", initial: true });
      const c = client(h.port);
      const r = await c.login("alice", "initial-secret-1");
      expect(r).toEqual({ ok: true, initialPassword: true });
    } finally {
      await h.cleanup();
    }
  });

  it("review fix #6: a successful login without the initial password is initialPassword:false", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const c = client(h.port);
      const r = await c.login("alice", "correct-horse-battery");
      expect(r).toEqual({ ok: true, initialPassword: false });
    } finally {
      await h.cleanup();
    }
  });

  it('review fix #7: an ordinary per-IP backoff lockout (not saturated, not the KDF admission queue) is classified "throttled" (countdown, no auto-retry) \u2014 previously indistinguishable E_RATE made this branch unreachable', async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      for (let i = 0; i < 6; i++) {
        await lanPostJson(h.port, "/api/login", { username: "alice", password: "wrong" });
      }
      // the 7th request within the window is now locked out (plan §6.2's 5-free-failures table)
      const raw = await lanPostJson(h.port, "/api/login", { username: "alice", password: "wrong" });
      expect(raw.status).toBe(429);
      expect(JSON.parse(raw.body)).toMatchObject({ error: "E_LOCKED" });

      const c = client(h.port);
      const r = await c.login("alice", "wrong");
      expect(r).toMatchObject({ ok: false, kind: "throttled" });
    } finally {
      await h.cleanup();
    }
  });

  it('review fix #7: the saturated sub-case keeps the plan\u2019s literal {error:"E_RATE", saturated:true} body and classifies "saturated" (no retry)', async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      for (let i = 0; i < 4096; i++) {
        h.limiter.fail(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
      }
      const raw = await lanPostJson(h.port, "/api/login", { username: "alice", password: "wrong" });
      expect(raw.status).toBe(429);
      expect(JSON.parse(raw.body)).toMatchObject({ error: "E_RATE", saturated: true });

      const c = client(h.port);
      const r = await c.login("alice", "wrong");
      expect(r).toMatchObject({ ok: false, kind: "saturated" });
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// LAN security r2 §5.6/§5.9 (package G): second-factor client flows. The hub routes are
// mounted by the integrator (I) after C lands, so these run against a stub node:http server
// implementing the FROZEN wire shapes of `protocol/lan-2fa.ts` — real HTTP, real client
// parser, the same seam discipline as the LC+LF block above.
// ---------------------------------------------------------------------------

interface StubReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface Stub2fa {
  port: number;
  requests: { method: string; path: string; body: string }[];
  polls(): number;
  close(): Promise<void>;
}

async function start2faStub(handlers: {
  login?: () => StubReply;
  submit?: (rawBody: string) => StubReply;
  wait?: (poll: number) => Promise<StubReply> | StubReply;
  cancel?: () => StubReply;
}): Promise<Stub2fa> {
  const requests: Stub2fa["requests"] = [];
  let polls = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const path = req.url ?? "";
        requests.push({ method: req.method ?? "", path, body });
        let reply: StubReply | undefined;
        try {
          if (path === "/api/login" && req.method === "POST") reply = handlers.login?.();
          else if (path === "/api/login/2fa" && req.method === "POST") reply = handlers.submit?.(body);
          else if (path === "/api/login/2fa/wait" && req.method === "GET") reply = await handlers.wait?.(++polls);
          else if (path === "/api/login/2fa/cancel" && req.method === "POST")
            reply = handlers.cancel?.() ?? { status: 200, body: { ok: true } };
        } catch {
          reply = undefined;
        }
        const r = reply ?? { status: 404, body: { error: "E_NO_ROUTE" } };
        res.writeHead(r.status, { "Content-Type": "application/json", ...(r.headers ?? {}) });
        res.end(JSON.stringify(r.body));
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    port,
    requests,
    polls: () => polls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const CHALLENGE = () => ({
  error: "E_2FA",
  methods: ["totp", "feishu"],
  feishu: "sent",
  expiresAt: Date.now() + 300_000,
});

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("LAN security §5.6/§5.9: 2FA client flows against a stub wire server", () => {
  it("login classifies a 401 E_2FA challenge as kind second-factor, carrying the challenge verbatim", async () => {
    const stub = await start2faStub({ login: () => ({ status: 401, body: CHALLENGE() }) });
    try {
      const c = client(stub.port);
      const r = await c.login("alice", "correct-horse-battery");
      expect(r.ok).toBe(false);
      if (r.ok || r.kind !== "second-factor") throw new Error(`unexpected ${JSON.stringify(r)}`);
      expect(r.challenge.error).toBe("E_2FA");
      expect(r.challenge.methods).toEqual(["totp", "feishu"]);
      expect(r.challenge.feishu).toBe("sent");
      expect(typeof r.challenge.expiresAt).toBe("number");
      c.close();
    } finally {
      await stub.close();
    }
  });

  it("a malformed 401 E_2FA body falls back to the plain invalid-password branch", async () => {
    const stub = await start2faStub({
      login: () => ({ status: 401, body: { error: "E_2FA", methods: "totp", feishu: "sent", expiresAt: 1 } }),
    });
    try {
      const c = client(stub.port);
      const r = await c.login("alice", "wrong");
      expect(r).toEqual({ ok: false, kind: "invalid" });
      c.close();
    } finally {
      await stub.close();
    }
  });

  it("submitSecondFactor success opens the stream and reports initialPassword", async () => {
    const stub = await start2faStub({ submit: () => ({ status: 200, body: { ok: true, initialPassword: true } }) });
    try {
      const c = client(stub.port);
      const r = await c.submitSecondFactor({ method: "totp", code: "481027" });
      expect(r).toEqual({ ok: true, initialPassword: true });
      expect(c.stats().open).toBe(true);
      const req = stub.requests.find((q) => q.path === "/api/login/2fa");
      expect(req?.method).toBe("POST");
      expect(JSON.parse(req!.body)).toEqual({ method: "totp", code: "481027" });
      c.close();
    } finally {
      await stub.close();
    }
  });

  it("E_2FA_CODE carries attemptsLeft; E_2FA_EXPIRED/E_2FA_METHOD_LOCKED/E_LOCKED ride error+retryAfterMs", async () => {
    const replies: StubReply[] = [
      { status: 401, body: { error: "E_2FA_CODE", attemptsLeft: 3 } },
      { status: 409, body: { error: "E_2FA_EXPIRED" } },
      { status: 429, body: { error: "E_2FA_METHOD_LOCKED", retryAfterMs: 900_000 } },
      { status: 429, body: { error: "E_LOCKED" }, headers: { "Retry-After": "2" } },
    ];
    const stub = await start2faStub({ submit: () => replies.shift() ?? { status: 500, body: {} } });
    try {
      const c = client(stub.port);
      expect(await c.submitSecondFactor({ method: "totp", code: "000000" })).toEqual({
        ok: false,
        error: "E_2FA_CODE",
        attemptsLeft: 3,
      });
      expect(await c.submitSecondFactor({ method: "totp", code: "000000" })).toEqual({
        ok: false,
        error: "E_2FA_EXPIRED",
      });
      expect(await c.submitSecondFactor({ method: "totp", code: "000000" })).toEqual({
        ok: false,
        error: "E_2FA_METHOD_LOCKED",
        retryAfterMs: 900_000,
      });
      expect(await c.submitSecondFactor({ method: "totp", code: "000000" })).toEqual({
        ok: false,
        error: "E_LOCKED",
        retryAfterMs: 2_000,
      });
      c.close();
    } finally {
      await stub.close();
    }
  });

  it("malformed codes are rejected locally without any HTTP request; recovery codes reach the wire normalized", async () => {
    const stub = await start2faStub({ submit: () => ({ status: 200, body: { ok: true } }) });
    try {
      const c = client(stub.port);
      expect(await c.submitSecondFactor({ method: "totp", code: "48x027" })).toEqual({
        ok: false,
        error: "E_BAD_REQUEST",
      });
      expect(await c.submitSecondFactor({ method: "recovery", code: "nope" })).toEqual({
        ok: false,
        error: "E_BAD_REQUEST",
      });
      expect(stub.requests).toHaveLength(0);
      // Crockford aliases (o→0, i/l→1), case and separators normalize before the request
      const r = await c.submitSecondFactor({ method: "recovery", code: "k7m9-q2fd 4hj0" });
      expect(r).toEqual({ ok: true, initialPassword: false });
      expect(JSON.parse(stub.requests[0]!.body)).toEqual({ method: "recovery", code: "K7M9Q2FD4HJ0" });
      c.close();
    } finally {
      await stub.close();
    }
  });

  it("waitApproval polls serially (one request in flight) until approved, then opens the stream", async () => {
    const stub = await start2faStub({
      wait: async (poll) => {
        if (poll < 3) {
          await sleepMs(50);
          return { status: 200, body: { state: "pending" } };
        }
        return { status: 200, body: { ok: true } };
      },
    });
    try {
      const c = client(stub.port);
      const r = await c.waitApproval(CHALLENGE());
      expect(r).toEqual({ ok: true, initialPassword: false });
      expect(stub.polls()).toBe(3);
      expect(c.stats().open).toBe(true);
      c.close();
    } finally {
      await stub.close();
    }
  }, 15_000);

  it("waitApproval surfaces denied and expired wire states", async () => {
    const stub = await start2faStub({
      wait: async (poll) => {
        if (poll === 1) return { status: 200, body: { state: "denied" } };
        return { status: 200, body: { state: "expired" } };
      },
    });
    try {
      const c = client(stub.port);
      await expect(c.waitApproval(CHALLENGE())).resolves.toEqual({ ok: false, state: "denied" });
      await expect(c.waitApproval(CHALLENGE())).resolves.toEqual({ ok: false, state: "expired" });
      c.close();
    } finally {
      await stub.close();
    }
  });

  it("waitApproval with a past expiresAt returns expired without any request", async () => {
    const stub = await start2faStub({});
    try {
      const c = client(stub.port);
      const r = await c.waitApproval({ ...CHALLENGE(), expiresAt: Date.now() - 1 });
      expect(r).toEqual({ ok: false, state: "expired" });
      expect(stub.requests).toHaveLength(0);
      c.close();
    } finally {
      await stub.close();
    }
  });

  it("a duplicate waitApproval for the same challenge rides the in-flight loop (one server-side waiter)", async () => {
    const stub = await start2faStub({
      wait: async (poll) => {
        if (poll === 1) {
          await sleepMs(50);
          return { status: 200, body: { state: "pending" } };
        }
        return { status: 200, body: { state: "denied" } };
      },
    });
    try {
      const c = client(stub.port);
      const ch = CHALLENGE();
      const p1 = c.waitApproval(ch);
      const p2 = c.waitApproval(ch);
      expect(p2).toBe(p1); // same in-flight loop — no second waiter, no E_2FA_BUSY
      await expect(p1).resolves.toEqual({ ok: false, state: "denied" });
      expect(stub.polls()).toBe(2);
      c.close();
    } finally {
      await stub.close();
    }
  });

  it("cancelSecondFactor aborts the in-flight wait loop (settles cancelled) and posts the cancel", async () => {
    const stub = await start2faStub({
      wait: async () => {
        await sleepMs(1_000);
        return { status: 200, body: { state: "pending" } };
      },
    });
    try {
      const c = client(stub.port);
      const p = c.waitApproval(CHALLENGE());
      await sleepMs(50); // let the first poll leave
      const cr = await c.cancelSecondFactor();
      expect(cr).toEqual({ ok: true });
      await expect(p).resolves.toEqual({ ok: false, state: "cancelled" });
      expect(stub.requests.some((q) => q.path === "/api/login/2fa/cancel" && q.method === "POST")).toBe(true);
      c.close();
    } finally {
      await stub.close();
    }
  });

  it("submitSecondFactor success aborts the in-flight wait loop — a stale /wait answer can never bounce the login back (rework #2)", async () => {
    const stub = await start2faStub({
      submit: () => ({ status: 200, body: { ok: true, initialPassword: false } }),
      wait: async () => {
        await sleepMs(300); // server hold; the denial lands AFTER the submit succeeds
        return { status: 200, body: { state: "denied" } };
      },
    });
    try {
      const c = client(stub.port);
      const p = c.waitApproval(CHALLENGE());
      await sleepMs(50); // first poll is in flight
      const sr = await c.submitSecondFactor({ method: "totp", code: "481027" });
      expect(sr).toEqual({ ok: true, initialPassword: false });
      // the late denial must be discarded: the loop settles cancelled (callers ignore it)
      await expect(p).resolves.toEqual({ ok: false, state: "cancelled" });
      await sleepMs(400); // outlive the stub's hold — no second poll may follow the abort
      expect(stub.polls()).toBe(1);
      c.close();
    } finally {
      await stub.close();
    }
  });

  it("two challenges with the same expiresAt never share a wait loop — identity is the challenge object (rework #5)", async () => {
    const stub = await start2faStub({
      wait: async (poll) => {
        if (poll === 1) {
          await sleepMs(1_000);
          return { status: 200, body: { state: "pending" } };
        }
        return { status: 200, body: { state: "denied" } };
      },
    });
    try {
      const c = client(stub.port);
      const expiresAt = Date.now() + 300_000;
      const p1 = c.waitApproval({ ...CHALLENGE(), expiresAt });
      await sleepMs(50);
      const p2 = c.waitApproval({ ...CHALLENGE(), expiresAt }); // same expiry, DIFFERENT challenge object
      expect(p2).not.toBe(p1); // supersedes instead of riding the other challenge's loop
      await expect(p1).resolves.toEqual({ ok: false, state: "cancelled" });
      await expect(p2).resolves.toEqual({ ok: false, state: "denied" });
      c.close();
    } finally {
      await stub.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Same state machine with a manual clock + scripted fetch: the poll-timeout ⇒ retry rule
// (§5.6 "UI treats any timeout as retry") needs the 30s per-poll deadline to actually fire,
// which real timers would make a 90s test.
// ---------------------------------------------------------------------------

function manualTimers() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: unknown) => {
      timers.delete(id as number);
    },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        let nextId = -1;
        let nextAt = Infinity;
        let nextFn: (() => void) | undefined;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < nextAt) {
            nextId = id;
            nextAt = t.at;
            nextFn = t.fn;
          }
        }
        if (!nextFn) break;
        timers.delete(nextId);
        now = nextAt;
        nextFn();
        await flush();
      }
      now = target;
      await flush();
    },
    flush,
  };
}

describe("LAN security §5.6: waitApproval poll-timeout/expiry state machine (manual clock)", () => {
  function fakeClient(fetchImpl: (url: string, init?: any) => Promise<any>) {
    const tm = manualTimers();
    const c = createPasswordClient({
      fetch: fetchImpl,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      EventSource: NoopEventSource as any,
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState: () => {} },
      setTimeout: tm.setTimeout,
      clearTimeout: tm.clearTimeout,
      now: tm.now,
      onMessage: () => {},
      onConn: () => {},
      onAuthEvent: () => {},
      onUnauthenticated: () => {},
    });
    return { c, tm };
  }

  it("a poll timeout is retried (never terminal) until the challenge expires", async () => {
    let waitCalls = 0;
    const { c, tm } = fakeClient((url) => {
      if (url === "/api/login/2fa/wait") {
        waitCalls++;
        return new Promise(() => {}); // never settles — only the client's 30s deadline ends it
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    });
    const p = c.waitApproval({ error: "E_2FA", methods: ["feishu"], feishu: "sent", expiresAt: 65_000 });
    await tm.flush();
    expect(waitCalls).toBe(1);
    await tm.advance(30_000); // first poll deadline fires → 1s transport-error backoff (rework #4)
    expect(waitCalls).toBe(1);
    await tm.advance(1_000); // t=31_000: backoff over → retry
    expect(waitCalls).toBe(2);
    await tm.advance(30_000); // t=61_000: second deadline → 2s backoff
    expect(waitCalls).toBe(2);
    await tm.advance(2_000); // t=63_000: still < 65_000, retry again
    expect(waitCalls).toBe(3);
    await tm.advance(30_000); // t=93_000: third deadline → 4s backoff nap
    expect(waitCalls).toBe(3);
    await tm.advance(4_000); // nap over; the loop top observes expiry
    await expect(p).resolves.toEqual({ ok: false, state: "expired" });
    c.close();
  });

  it("cancelSecondFactor settles an in-flight wait as cancelled without waiting for any timer", async () => {
    let waitCalls = 0;
    const { c, tm } = fakeClient((url) => {
      if (url === "/api/login/2fa/wait") {
        waitCalls++;
        return new Promise(() => {});
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    });
    const p = c.waitApproval({ error: "E_2FA", methods: ["feishu"], feishu: "sent", expiresAt: 300_000 });
    await tm.flush();
    expect(waitCalls).toBe(1);
    await expect(c.cancelSecondFactor()).resolves.toEqual({ ok: true });
    await expect(p).resolves.toEqual({ ok: false, state: "cancelled" });
    c.close();
  });

  it("consecutive transport errors back off 1s→2s→4s→8s (capped) between poll starts; any response resets (rework #4)", async () => {
    const calls: number[] = [];
    let fail = true;
    const { c, tm } = fakeClient((url: string) => {
      if (url === "/api/login/2fa/wait") {
        calls.push(tm.now());
        if (fail) return Promise.reject(new Error("boom"));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ state: "pending" }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    });
    const p = c.waitApproval({ error: "E_2FA", methods: ["feishu"], feishu: "sent", expiresAt: 120_000 });
    await tm.flush();
    expect(calls).toEqual([0]);
    await tm.advance(1_000); // backoff #1: 1s
    expect(calls).toEqual([0, 1_000]);
    await tm.advance(2_000); // backoff #2: 2s
    expect(calls).toEqual([0, 1_000, 3_000]);
    await tm.advance(4_000); // backoff #3: 4s
    expect(calls).toEqual([0, 1_000, 3_000, 7_000]);
    await tm.advance(8_000); // backoff #4: 8s
    expect(calls).toEqual([0, 1_000, 3_000, 7_000, 15_000]);
    await tm.advance(8_000); // backoff #5: capped at 8s
    expect(calls).toEqual([0, 1_000, 3_000, 7_000, 15_000, 23_000]);
    // any valid response resets the streak — one pending reply, then failures restart at 1s
    fail = false;
    await tm.advance(8_000); // t=31_000: poll answers pending
    expect(calls).toEqual([0, 1_000, 3_000, 7_000, 15_000, 23_000, 31_000]);
    fail = true;
    await tm.advance(1_000); // t=32_000: ≥1s pace floor after the pending reply, fails again
    expect(calls).toEqual([0, 1_000, 3_000, 7_000, 15_000, 23_000, 31_000, 32_000]);
    await tm.advance(1_000); // streak was reset ⇒ first-error backoff is 1s again
    expect(calls).toEqual([0, 1_000, 3_000, 7_000, 15_000, 23_000, 31_000, 32_000, 33_000]);
    c.close();
    await expect(p).resolves.toEqual({ ok: false, state: "cancelled" });
  });

  it("the pacing sleep is abort-aware: cancel during a backoff nap settles cancelled with no clock advance (rework #4)", async () => {
    const { c, tm } = fakeClient((url: string) => {
      if (url === "/api/login/2fa/wait") return Promise.reject(new Error("boom"));
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    });
    const p = c.waitApproval({ error: "E_2FA", methods: ["feishu"], feishu: "sent", expiresAt: 300_000 });
    await tm.flush(); // first poll failed; the loop is now inside its 1s backoff sleep
    await expect(c.cancelSecondFactor()).resolves.toEqual({ ok: true });
    await expect(p).resolves.toEqual({ ok: false, state: "cancelled" });
    c.close();
  });
});
