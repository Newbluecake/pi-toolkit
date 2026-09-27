import { request as httpRequest, type IncomingMessage } from "node:http";
import { createServer as createNetServer } from "node:net";
import { readFileSync } from "node:fs";
import { effectScope } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import { fakeKdf, fakeLanStore } from "../contract/fakes.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { createScope } from "../../../src/web-hub/hub/lifecycle.js";
import { createHostsPort } from "../../../src/web-hub/hub/net-hosts.js";
import { createKdfAdmission } from "../../../src/web-hub/hub/kdf-admission.js";
import { createLoginLimiter } from "../../../src/web-hub/hub/ratelimit.js";
import type { HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import type { HistoryPayload } from "../../../src/web-hub/protocol/http-contract.js";
import { fakeDeps, makeAgent, makeTmp, openSse, type FakeDeps } from "../http/helpers.js";
import { seedLanUser } from "../http/lan-helpers.js";
import { useHub, type UseHubHandle } from "../../../src/web-hub/ui/src/composables/useHub.js";
import {
  usePasswordAuth,
  type UsePasswordAuthHandle,
} from "../../../src/web-hub/ui/src/composables/usePasswordAuth.js";
import { createTokenTransport, TOKEN_KEY } from "../../../src/web-hub/ui/src/transport/token.js";
import type { PasswordTransportDeps } from "../../../src/web-hub/ui/src/transport/password.js";
import type { TokenTransportDeps } from "../../../src/web-hub/ui/src/transport/token.js";

/**
 * Real-HTTP `password-client.js`/`token-client.js` + `useHub` regression suite (vue-plan.md
 * v2.1 §4.2 P1 row). `transport-contract.test.ts` proves method-shape parity with fully faked
 * fetch/EventSource; this file exists because that alone would not have caught 78dd76b or
 * LC review fixes #6/#7 (`tests/web-hub/http/lan-password-client.test.ts`'s own rationale) — a
 * unit test on either side can mock the *other* side's shape correctly by construction, so a
 * real field-name/status-code/cookie mismatch between the two only surfaces once they're wired
 * together against the real `createHttpFrontend` routes. Covers the six flows plan §4.2 calls
 * out: first subscribe, history pagination, 401/auth, logout, reconnect, timer cleanup.
 */

// ---------------------------------------------------------------------------
// a tiny same-origin HTTP client harness (cookie jar + fetch/EventSource shims)
// ---------------------------------------------------------------------------

interface RawResp {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
}

function rawHttp(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<RawResp> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(opts.body));
    const req = httpRequest(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(5_000, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

class CookieJar {
  private kv: string | undefined;
  absorb(setCookie: string[] | string | undefined): void {
    const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!first) return;
    if (/;\s*Max-Age=0\b/i.test(first)) {
      this.kv = undefined;
      return;
    }
    this.kv = first.split(";")[0];
  }
  header(): string | undefined {
    return this.kv;
  }
  /** Simulate the server-side session having gone away without the client knowing yet — same
   * cookie *name*, garbage value, so a request still sends *a* cookie but the server rejects it. */
  corrupt(): void {
    if (!this.kv) return;
    const name = this.kv.split("=")[0];
    this.kv = `${name}=deadbeefdeadbeefdeadbeefdeadbeef`;
  }
}

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

function fetchViaHttp(port: number, jar: CookieJar, calls?: string[]): FetchImpl {
  return async (url, init = {}) => {
    calls?.push(url);
    // A real browser's `fetch()` sets `Origin` automatically on every same-origin request; the
    // password-client.js code never sets it itself (CSRF requires it for LAN state-changing
    // requests, plan lan-plan.md §2.4) — mirror that here the way `lan-password-client.test.ts`'s
    // `fetchViaLan` does.
    const headers: Record<string, string> = { Origin: `http://127.0.0.1:${port}`, ...(init.headers ?? {}) };
    if (jar.header() !== undefined) headers.Cookie = jar.header()!;
    const r = await rawHttp(port, {
      method: init.method ?? "GET",
      path: url,
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    jar.absorb(r.headers["set-cookie"]);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (n: string) => (r.headers[n.toLowerCase()] as string | undefined) ?? null },
      async json() {
        return r.body.length > 0 ? JSON.parse(r.body) : {};
      },
    };
  };
}

/** The `EventSource` subset both `@logic` clients use: `addEventListener`/`close`/`readyState`,
 * constructed as `new EventSource(url, init)`. Backed by a real `node:http` SSE request. */
class HttpEventSource {
  static instances: HttpEventSource[] = [];
  readyState = 0;
  private listeners = new Map<string, Array<(ev: { data?: string; lastEventId?: string }) => void>>();
  private req: ReturnType<typeof httpRequest>;

  constructor(
    url: string,
    private readonly port: number,
    private readonly jar: CookieJar,
  ) {
    HttpEventSource.instances.push(this);
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, Accept: "text/event-stream" };
    if (jar.header() !== undefined) headers.Cookie = jar.header()!;
    this.req = httpRequest({ host: "127.0.0.1", port, path: url, headers, agent: false }, (res) => {
      if ((res.statusCode ?? 0) !== 200) {
        this.readyState = 2;
        res.resume();
        this.dispatch("error", {});
        return;
      }
      this.readyState = 1;
      let buf = "";
      res.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) this.dispatchFrame(p);
      });
      res.on("end", () => {
        if (this.readyState !== 2) {
          this.readyState = 2;
          this.dispatch("error", {});
        }
      });
      res.on("error", () => {
        if (this.readyState !== 2) {
          this.readyState = 2;
          this.dispatch("error", {});
        }
      });
    });
    this.req.on("error", () => {
      this.readyState = 2;
      this.dispatch("error", {});
    });
    this.req.end();
  }

  addEventListener(name: string, fn: (ev: { data?: string; lastEventId?: string }) => void): void {
    const l = this.listeners.get(name) ?? [];
    l.push(fn);
    this.listeners.set(name, l);
  }
  close(): void {
    this.readyState = 2;
    this.req.destroy();
  }
  /** Test-only: simulate the connection dying at the network level (server restart, dropped
   * socket) — the client's own CLOSED/`error` path decides what to do next (§4.2 flow ⑤). */
  simulateDrop(): void {
    this.readyState = 2;
    this.req.destroy();
    this.dispatch("error", {});
  }
  private dispatch(name: string, ev: { data?: string; lastEventId?: string }): void {
    for (const fn of this.listeners.get(name) ?? []) fn(ev);
  }
  private dispatchFrame(block: string): void {
    let id: string | undefined;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) id = line.slice(4);
      else if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    if (dataLines.length === 0) return;
    this.dispatch(event, { data: dataLines.join("\n"), lastEventId: id ?? "" });
  }
}

function eventSourceClassFor(port: number, jar: CookieJar): new (url: string, init?: unknown) => HttpEventSource {
  return class extends HttpEventSource {
    constructor(url: string, _init?: unknown) {
      super(url, port, jar);
    }
  };
}

/** Counts genuinely *pending* timers so a post-teardown assertion can prove zero leaked. */
function countingTimers() {
  const live = new Set<NodeJS.Timeout>();
  return {
    setTimeout: (fn: () => void, ms: number): NodeJS.Timeout => {
      const h = setTimeout(() => {
        live.delete(h);
        fn();
      }, ms);
      h.unref();
      live.add(h);
      return h;
    },
    clearTimeout: (h: NodeJS.Timeout): void => {
      live.delete(h);
      clearTimeout(h);
    },
    active: (): number => live.size,
  };
}

const flush = async (rounds = 15): Promise<void> => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitUntil(pred: () => boolean, timeoutMs = 4_000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// ---------------------------------------------------------------------------
// fixture: one agent, 450 history entries (tail 400 on snapshot, older 50 on one page)
// ---------------------------------------------------------------------------

const AGENT_KEY = "agent-A";
const TOTAL_ENTRIES = 450;
const TAIL = 400;

function buildEntries(): Array<{
  id: string;
  parentId: string | null;
  type: "message";
  timestamp: string;
  message: unknown;
}> {
  return Array.from({ length: TOTAL_ENTRIES }, (_, i) => ({
    id: `e${i}`,
    parentId: i === 0 ? null : `e${i - 1}`,
    type: "message" as const,
    timestamp: String(i),
    message: { role: "user", content: `msg-${i}`, timestamp: i },
  }));
}

function wireHistoryFixture(deps: FakeDeps): void {
  const entries = buildEntries();
  deps.agents.set(AGENT_KEY, makeAgent(AGENT_KEY));
  deps.setSnapshot(async (agentKey): Promise<HistoryPayload> => {
    const tail = entries.slice(-TAIL);
    return {
      agentKey,
      entries: tail as never,
      tailMessages: [],
      fromSeq: 1,
      hasMore: entries.length > TAIL,
      ...(tail[0] ? { oldestEntryId: tail[0].id } : {}),
      source: "file",
    };
  });
  deps.setPage(async (agentKey, before, limit): Promise<HistoryPayload> => {
    const idx = entries.findIndex((e) => e.id === before);
    const start = Math.max(0, idx - limit);
    const older = entries.slice(start, idx);
    return {
      agentKey,
      entries: older as never,
      tailMessages: [],
      fromSeq: 1,
      hasMore: start > 0,
      ...(older[0] ? { oldestEntryId: older[0].id } : {}),
      source: "file",
    };
  });
}

// ---------------------------------------------------------------------------
// password (LAN) harness
// ---------------------------------------------------------------------------

interface PasswordHarness {
  fe: HttpFrontend;
  deps: FakeDeps;
  port: number;
  cleanup(): Promise<void>;
}

async function startPasswordHub(): Promise<PasswordHarness> {
  const tmp = makeTmp("pwh-int-lan-");
  const deps = fakeDeps(tmp.dir);
  wireHistoryFixture(deps);
  const store = fakeLanStore();
  const kdf = fakeKdf();
  const limiter = createLoginLimiter({ now: () => Date.now() });
  const admission = createKdfAdmission({ now: () => Date.now(), isTightened: limiter.isTightened });
  const hosts = createHostsPort();
  const scope = createScope({ log: deps.log, now: () => Date.now() });
  const cfg = { port: await freePort(), extraHosts: [], trustProxyFrom: [], externalOrigins: [] };
  const fe = createHttpFrontend({
    ...deps,
    lan: { cfg, store, kdf, limiter, admission, hosts, scope, onStatus: () => {} },
  });
  const status = await fe.lan!.start();
  const port = status.state === "on" ? status.port : 0;
  seedLanUser(store, { username: "alice", password: "correct-horse-battery-1" });
  return {
    fe,
    deps,
    port,
    async cleanup() {
      await fe.close();
      await scope.dispose();
      tmp.cleanup();
    },
  };
}

function buildPasswordClient(port: number) {
  const jar = new CookieJar();
  const calls: string[] = [];
  const timers = countingTimers();
  const EventSourceClass = eventSourceClassFor(port, jar);
  const deps: PasswordTransportDeps = {
    fetch: fetchViaHttp(port, jar, calls),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    EventSource: EventSourceClass as any,
    location: { hash: "", pathname: "/", search: "" },
    history: { replaceState: () => {} },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: () => Date.now(),
    onMessage: () => {},
    onConn: () => {},
    onAuthEvent: () => {},
    onUnauthenticated: () => {},
    onSessionInfo: () => {},
    onLoginRetry: () => {},
  };
  const auth = usePasswordAuth({ deps, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  const scope = effectScope();
  const hub = scope.run(() =>
    useHub({
      createTransport: auth.createTransport,
      doc: { hidden: false, addEventListener: () => {}, removeEventListener: () => {} },
      win: { addEventListener: () => {}, removeEventListener: () => {} },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    }),
  ) as UseHubHandle;
  return { jar, calls, timers, auth, hub, scope };
}

describe("password (LAN) + real HTTP: useHub end-to-end (vue-plan.md v2.1 \u00a74.2)", () => {
  let h: PasswordHarness;
  afterEach(async () => {
    if (h) await h.cleanup();
    HttpEventSource.instances = [];
  });

  it("\u2460 first subscribe: login \u2192 SSE agents frame \u2192 route \u2192 real /api/subscribe \u2192 history snapshot lands (tail 400, hasMore)", async () => {
    h = await startPasswordHub();
    const c = buildPasswordClient(h.port);
    const res = await c.auth.submit({ username: "alice", password: "correct-horse-battery-1" });
    expect(c.auth.error.value).toBeNull();
    void res;
    await waitUntil(() => c.hub.state.value.order.length > 0);
    c.hub.dispatch({ event: "route", data: { agentKey: AGENT_KEY } });
    await waitUntil(() => c.hub.state.value.agents.get(AGENT_KEY)?.history === "loaded");
    const agent = c.hub.state.value.agents.get(AGENT_KEY)!;
    expect(agent.items).toHaveLength(TAIL);
    expect(agent.hasMore).toBe(true);
    expect(agent.items[0]?.entryId).toBe(`e${TOTAL_ENTRIES - TAIL}`);
    c.hub.dispose();
    c.scope.stop();
  });

  it("\u2461 history pagination: loadOlder() \u2192 real GET /api/history?before \u2192 prepends 50, hasMore=false", async () => {
    h = await startPasswordHub();
    const c = buildPasswordClient(h.port);
    await c.auth.submit({ username: "alice", password: "correct-horse-battery-1" });
    await waitUntil(() => c.hub.state.value.order.length > 0);
    c.hub.dispatch({ event: "route", data: { agentKey: AGENT_KEY } });
    await waitUntil(() => c.hub.state.value.agents.get(AGENT_KEY)?.history === "loaded");
    c.hub.loadOlder(AGENT_KEY);
    await waitUntil(
      () =>
        c.hub.state.value.agents.get(AGENT_KEY)?.paging === false &&
        c.hub.state.value.agents.get(AGENT_KEY)!.items.length > TAIL,
    );
    const agent = c.hub.state.value.agents.get(AGENT_KEY)!;
    expect(agent.items).toHaveLength(TAIL + 50);
    expect(agent.hasMore).toBe(false);
    expect(agent.items[0]?.entryId).toBe("e0");
    c.hub.dispose();
    c.scope.stop();
  });

  it('\u2462 401/auth: a server-revoked session reports conn="auth" and triggers no request storm', async () => {
    h = await startPasswordHub();
    const c = buildPasswordClient(h.port);
    await c.auth.submit({ username: "alice", password: "correct-horse-battery-1" });
    await waitUntil(() => c.hub.state.value.order.length > 0);
    const n = h.fe.lan!.revoke({ userId: 1 });
    expect(n).toBe(1);
    await waitUntil(() => c.hub.state.value.conn === "auth");
    const requestsAfter = HttpEventSource.instances.length;
    await flush(30);
    expect(HttpEventSource.instances.length).toBe(requestsAfter); // no reconnect storm after a hard revoke
    c.hub.dispose();
    c.scope.stop();
  });

  it("\u2463 logout: cookie invalidated, SSE closed, state reset, zero further requests", async () => {
    h = await startPasswordHub();
    const c = buildPasswordClient(h.port);
    await c.auth.submit({ username: "alice", password: "correct-horse-battery-1" });
    await waitUntil(() => c.hub.state.value.order.length > 0);
    await c.auth.signOut();
    await waitUntil(() => c.hub.state.value.conn === "auth");
    expect(HttpEventSource.instances.at(-1)!.readyState).toBe(2);
    const after = await rawHttp(h.port, {
      method: "GET",
      path: "/api/session",
      headers: { Cookie: c.jar.header() ?? "" },
    });
    expect(after.status).toBe(401); // the session really is gone server-side, not just client-side
    c.hub.dispose();
    c.scope.stop();
  });

  it("\u2464 reconnect: a dropped SSE reconnects and resubscribes the current agent exactly once", async () => {
    h = await startPasswordHub();
    const c = buildPasswordClient(h.port);
    await c.auth.submit({ username: "alice", password: "correct-horse-battery-1" });
    await waitUntil(() => c.hub.state.value.order.length > 0);
    c.hub.dispatch({ event: "route", data: { agentKey: AGENT_KEY } });
    await waitUntil(() => c.hub.state.value.agents.get(AGENT_KEY)?.history === "loaded");
    const firstClientId = c.hub.state.value.clientId;
    const streamBefore = HttpEventSource.instances.length;

    HttpEventSource.instances.at(-1)!.simulateDrop();
    await waitUntil(() => c.hub.state.value.conn === "reconnecting");
    // Real (non-injectable, hardcoded in the frozen `@logic/password-client.js`) 1-3s backoff —
    // a generous 10s/20s budget de-flakes this under CI load (verifier item 3) without needing a
    // fake clock the legacy client doesn't accept.
    await waitUntil(() => HttpEventSource.instances.length > streamBefore, 10_000);
    await waitUntil(() => c.hub.state.value.clientId !== null && c.hub.state.value.clientId !== firstClientId, 10_000);
    await waitUntil(() => c.hub.state.value.agents.get(AGENT_KEY)?.sub?.pending === false, 10_000);
    expect(c.hub.state.value.agents.get(AGENT_KEY)?.sub?.clientId).toBe(c.hub.state.value.clientId);
    c.hub.dispose();
    c.scope.stop();
  }, 20_000);

  it("\u2465 timer cleanup: dispose() + scope.stop() leaves zero pending timers and zero server-side SSE connections", async () => {
    h = await startPasswordHub();
    const c = buildPasswordClient(h.port);
    await c.auth.submit({ username: "alice", password: "correct-horse-battery-1" });
    await waitUntil(() => c.hub.state.value.order.length > 0);
    c.hub.dispatch({ event: "route", data: { agentKey: AGENT_KEY } });
    await waitUntil(() => c.hub.state.value.agents.get(AGENT_KEY)?.history === "loaded");
    expect(c.timers.active()).toBeGreaterThan(0); // the SSE silence watchdog is armed
    c.hub.dispose();
    c.scope.stop();
    expect(c.timers.active()).toBe(0);
    await waitUntil(() => h.fe.clientCount() === 0);
  });
});

describe("password (LAN) + real HTTP: SSE Last-Event-ID replay/resync contract (src/web-hub/hub/http.ts, verifier fix 2026-09-27)", () => {
  let h: PasswordHarness;
  afterEach(async () => {
    if (h) await h.cleanup();
  });

  /** Direct `POST /api/login` (bypassing the frozen client entirely), returning the session cookie. */
  async function loginRaw(port: number): Promise<string> {
    const r = await rawHttp(port, {
      method: "POST",
      path: "/api/login",
      headers: { "Content-Type": "application/json", "X-PWH": "1", Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ username: "alice", password: "correct-horse-battery-1" }),
    });
    expect(r.status).toBe(200);
    const setCookie = r.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
    if (!cookie) throw new Error("no session cookie");
    return cookie;
  }

  /**
   * This is exactly the seam item 3 flagged: the integration harness's own hand-rolled
   * `HttpEventSource` never sends `Last-Event-ID` on reconnect (real browser `EventSource` can't
   * be told to, either, on a freshly-constructed instance — only the browser's *own* transparent
   * retry of the *same* object does that automatically), so the existing ⑤ reconnect tests above
   * never exercised the hub's replay-vs-resync branch (`src/web-hub/hub/sse.ts`'s `replayPlan`) at
   * all. Drive it directly against the real hub with `openSse`'s `lastEventId` option instead of
   * depending on the frozen password/token clients ever supporting it.
   */
  it("a covered gap (Last-Event-ID still in the ring) replays the missed frame instead of resyncing", async () => {
    h = await startPasswordHub();
    const cookie = await loginRaw(h.port);
    const es1 = await openSse(h.port, { cookie });
    await es1.waitFor((e) => e.event === "agents");
    h.deps.emit({ type: "agent_stale", agentKey: AGENT_KEY }); // baseline: one ring frame with an id
    const baseline = await es1.waitFor((e) => e.event === "agent_stale");
    es1.close();
    // "Missed" while disconnected — this is the frame a real reconnect-with-Last-Event-ID must replay.
    h.deps.emit({ type: "agent_stale", agentKey: AGENT_KEY });
    const es2 = await openSse(h.port, { cookie, lastEventId: baseline.id! });
    const replayed = await es2.waitFor((e) => e.event === "agent_stale");
    expect(replayed.id).toBeGreaterThan(baseline.id!);
    expect(es2.events.some((e) => e.event === "resync")).toBe(false); // covered gap ⇒ no resync
    es2.close();
  });

  it("an uncovered gap (Last-Event-ID far outside the ring) emits resync{lastEventId,currentId} instead of replaying", async () => {
    h = await startPasswordHub();
    const cookie = await loginRaw(h.port);
    // Prime the ring with one real frame so `oldest`/`currentId` are both well past `1`.
    const es0 = await openSse(h.port, { cookie });
    await es0.waitFor((e) => e.event === "agents");
    h.deps.emit({ type: "agent_stale", agentKey: AGENT_KEY });
    await es0.waitFor((e) => e.event === "agent_stale");
    es0.close();
    const es = await openSse(h.port, { cookie, lastEventId: 1 }); // guaranteed below `oldest - 1`
    const resync = await es.waitFor((e) => e.event === "resync");
    expect(resync.data).toMatchObject({ lastEventId: 1 });
    expect(typeof resync.data.currentId).toBe("number");
    expect(es.events.some((e) => e.event === "agent_stale")).toBe(false); // uncovered ⇒ no replay
    es.close();
  });
});

// ---------------------------------------------------------------------------
// token (loopback) harness — plan §4.2: "token 模式同套 describe.each（③ 改为 token 失效后的一次静默重登）"
// ---------------------------------------------------------------------------

interface TokenHarness {
  fe: HttpFrontend;
  deps: FakeDeps;
  port: number;
  token: string;
  cleanup(): Promise<void>;
}

async function startTokenHub(): Promise<TokenHarness> {
  const tmp = makeTmp("pwh-int-token-");
  const deps = fakeDeps(tmp.dir);
  wireHistoryFixture(deps);
  const fe = createHttpFrontend(deps);
  const { port } = await fe.listen();
  const token = readFileSync(deps.paths.tokenFile, "utf8").trim();
  return {
    fe,
    deps,
    port,
    token,
    async cleanup() {
      await fe.close();
      tmp.cleanup();
    },
  };
}

function buildTokenClient(port: number, token: string) {
  const jar = new CookieJar();
  const calls: string[] = [];
  const timers = countingTimers();
  const storage = new Map<string, string>();
  storage.set(TOKEN_KEY, token);
  const EventSourceClass = eventSourceClassFor(port, jar);
  const baseDeps: Omit<TokenTransportDeps, "onMessage" | "onConn"> = {
    fetch: fetchViaHttp(port, jar, calls),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    EventSource: EventSourceClass as any,
    storage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => void storage.set(k, v),
      removeItem: (k) => void storage.delete(k),
    },
    location: { hash: "", pathname: "/", search: "" },
    history: { replaceState: () => {} },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    now: () => Date.now(),
  };
  const scope = effectScope();
  const hub = scope.run(() =>
    useHub({
      createTransport: (hooks) =>
        createTokenTransport({ ...baseDeps, onMessage: hooks.onMessage, onConn: hooks.onConn }),
      doc: { hidden: false, addEventListener: () => {}, removeEventListener: () => {} },
      win: { addEventListener: () => {}, removeEventListener: () => {} },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    }),
  ) as UseHubHandle;
  return { jar, calls, timers, storage, hub, scope };
}

describe("token (loopback) + real HTTP: useHub end-to-end (vue-plan.md v2.1 \u00a74.2)", () => {
  let h: TokenHarness;
  afterEach(async () => {
    if (h) await h.cleanup();
    HttpEventSource.instances = [];
  });

  it("\u2460 first subscribe: stored-token cold start \u2192 SSE agents frame \u2192 route \u2192 real /api/subscribe \u2192 history snapshot lands", async () => {
    h = await startTokenHub();
    const c = buildTokenClient(h.port, h.token);
    void c.hub.start();
    await waitUntil(() => c.hub.state.value.order.length > 0, 6_000);
    c.hub.dispatch({ event: "route", data: { agentKey: AGENT_KEY } });
    await waitUntil(() => c.hub.state.value.agents.get(AGENT_KEY)?.history === "loaded");
    const agent = c.hub.state.value.agents.get(AGENT_KEY)!;
    expect(agent.items).toHaveLength(TAIL);
    expect(agent.hasMore).toBe(true);
    c.hub.dispose();
    c.scope.stop();
  }, 10_000);

  it("\u2461 history pagination: loadOlder() \u2192 real GET /api/history?before \u2192 prepends 50, hasMore=false", async () => {
    h = await startTokenHub();
    const c = buildTokenClient(h.port, h.token);
    void c.hub.start();
    await waitUntil(() => c.hub.state.value.order.length > 0, 6_000);
    c.hub.dispatch({ event: "route", data: { agentKey: AGENT_KEY } });
    await waitUntil(() => c.hub.state.value.agents.get(AGENT_KEY)?.history === "loaded");
    c.hub.loadOlder(AGENT_KEY);
    await waitUntil(() => (c.hub.state.value.agents.get(AGENT_KEY)?.items.length ?? 0) > TAIL);
    const agent = c.hub.state.value.agents.get(AGENT_KEY)!;
    expect(agent.items).toHaveLength(TAIL + 50);
    expect(agent.hasMore).toBe(false);
    expect(agent.items[0]?.entryId).toBe("e0");
    c.hub.dispose();
    c.scope.stop();
  }, 10_000);

  it("\u2462 (token variant) a 401 from a corrupted session cookie triggers exactly one silent re-login via the stored token, then succeeds", async () => {
    h = await startTokenHub();
    const c = buildTokenClient(h.port, h.token);
    void c.hub.start();
    await waitUntil(() => c.hub.state.value.order.length > 0, 6_000);
    c.hub.dispatch({ event: "route", data: { agentKey: AGENT_KEY } });
    await waitUntil(() => c.hub.state.value.agents.get(AGENT_KEY)?.history === "loaded");
    c.jar.corrupt();
    c.calls.length = 0;
    c.hub.loadOlder(AGENT_KEY);
    await waitUntil(() => (c.hub.state.value.agents.get(AGENT_KEY)?.items.length ?? 0) > TAIL, 6_000);
    expect(c.calls.filter((u) => u === "/api/login")).toHaveLength(1);
    expect(c.calls.filter((u) => u.startsWith("/api/history"))).toHaveLength(2); // first 401'd, retried once
    c.hub.dispose();
    c.scope.stop();
  }, 10_000);

  it("\u2464 reconnect: a dropped SSE reconnects (fresh clientId) and resubscribes the current agent exactly once", async () => {
    h = await startTokenHub();
    const c = buildTokenClient(h.port, h.token);
    void c.hub.start();
    await waitUntil(() => c.hub.state.value.order.length > 0, 6_000);
    c.hub.dispatch({ event: "route", data: { agentKey: AGENT_KEY } });
    await waitUntil(() => c.hub.state.value.agents.get(AGENT_KEY)?.history === "loaded");
    const firstClientId = c.hub.state.value.clientId;
    const streamBefore = HttpEventSource.instances.length;

    HttpEventSource.instances.at(-1)!.simulateDrop();
    // Real (non-injectable, hardcoded in the frozen `@logic/token-client.js`) 1-3s backoff — see
    // the password-mode variant above for why this can't use a fake clock (verifier item 3).
    await waitUntil(() => HttpEventSource.instances.length > streamBefore, 10_000);
    await waitUntil(() => c.hub.state.value.clientId !== null && c.hub.state.value.clientId !== firstClientId, 10_000);
    await waitUntil(() => c.hub.state.value.agents.get(AGENT_KEY)?.sub?.pending === false, 10_000);
    expect(c.hub.state.value.agents.get(AGENT_KEY)?.sub?.clientId).toBe(c.hub.state.value.clientId);
    c.hub.dispose();
    c.scope.stop();
  }, 20_000);

  it("\u2465 timer cleanup: dispose() + scope.stop() leaves zero pending timers and zero server-side SSE connections", async () => {
    h = await startTokenHub();
    const c = buildTokenClient(h.port, h.token);
    void c.hub.start();
    await waitUntil(() => c.hub.state.value.order.length > 0, 6_000);
    c.hub.dispatch({ event: "route", data: { agentKey: AGENT_KEY } });
    await waitUntil(() => c.hub.state.value.agents.get(AGENT_KEY)?.history === "loaded");
    expect(c.timers.active()).toBeGreaterThan(0);
    c.hub.dispose();
    c.scope.stop();
    expect(c.timers.active()).toBe(0);
    await waitUntil(() => h.fe.clientCount() === 0);
  }, 10_000);
});
