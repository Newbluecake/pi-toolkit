/**
 * hub HTTP frontend (plan §包 C): static UI, auth, SSE push and the P1 REST
 * surface, bound to 127.0.0.1 only. Consumes the hub core exclusively through
 * `ports.ts` (`FrontendDeps`), so it compiles and tests without package B.
 *
 * Request pipeline (every response carries the security headers):
 *   1. `Host` ∉ {127.0.0.1:<port>, localhost:<port>} ⇒ 421 `E_HOST` (DNS rebinding; before auth)
 *   2. `/healthz` (no auth) · non-`/api` GET ⇒ static (no auth)
 *   3. `/api/*` ⇒ `Cache-Control: no-store`; POST ⇒ CSRF gate (`Content-Type:
 *      application/json` + `X-PWH: 1` + same-origin `Origin` when present) ⇒ 403
 *      `E_CSRF`; body ≤ 64 KiB (413) read under a deadline (408)
 *   4. `/api/login` (token) · `/api/logout`; everything else needs the `pwh_sid` cookie ⇒ 401 `E_AUTH`
 *
 * SSE payload shapes (`event` → `data`), for the frontend mirror:
 *   hello{clientId} · hub{version,buildId,pid,startedAt,proto,port} · agents{agents:AgentCard[]}
 *   agent_up{agentKey,agent} · agent_down{agentKey,reason} · agent_stale{agentKey}
 *   session{agentKey,session} · status{agentKey,status} · fleet{agentKey,runs} · prompt{agentKey,prompts}
 *   ev{agentKey,seq,e} · gap{agentKey,fromSeq} · append{agentKey,entries}   (ev/gap/append: subscribers only)
 *   history HistoryPayload | {agentKey,error,message?}   (directed, never in the replay ring)
 *   resync{lastEventId,currentId} · ping{ts}
 *
 * Subscribe ordering: `POST /api/subscribe` answers 202 at once; scoped frames
 * for that (client, agent) are buffered until `history.snapshot()` settles,
 * then `history` is pushed first, followed by buffered frames (ev with
 * `seq < fromSeq` dropped — already merged into the snapshot), and only then
 * does the client join the live subscriber set.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { API_ERRORS, type AgentCard, type HistoryPayload } from "../protocol/http-contract.js";
import { canonicalHostKey, canonicalOrigin } from "../protocol/lan.js";
import type { FleetRowWire } from "../protocol/messages.js";
import { TIMING } from "../protocol/messages.js";
import { createAuth, readCookie, SESSION_COOKIE, LOGIN_WINDOW_MS } from "./auth.js";
import type {
  AgentView,
  FrontendDeps,
  FrontendFactory,
  HostSnapshot,
  HttpFrontend,
  HubEvent,
  HubLog,
  LanTransport,
  ListenerKind,
  RequestContext,
} from "./ports.js";
import { createSseHub, type SseClient, type SseEventName } from "./sse.js";
import { serveStatic, webRoot } from "./static.js";

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
export const MAX_BODY_BYTES = 64 * 1024;
export const HISTORY_PAGE_MAX = 400;
const BODY_DEADLINE_MS = 10_000;
/** Outer guard on history calls; B enforces TIMING.snapshotMs itself, this only bounds a misbehaving port. */
const HISTORY_GUARD_MS = TIMING.snapshotMs + 1_000;
const CLOSE_DEADLINE_MS = 2_000;
const MAX_PENDING_FRAMES = 4_096;
const BIND_HOST = "127.0.0.1"; // not configurable by design (arch §9)

function toAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "web-hub: aborted");
}

type ApiError = (typeof API_ERRORS)[number];

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

interface PendingFrame {
  event: SseEventName;
  data: unknown;
  seq?: number;
}

interface PendingSub {
  frames: PendingFrame[];
  overflow: boolean;
}

function isApiError(v: unknown): v is ApiError {
  return typeof v === "string" && (API_ERRORS as readonly string[]).includes(v);
}

/** Best-effort error code: `err.code` or `err.message` when it is a known API error. */
function errorCode(err: unknown): string {
  if (err !== null && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (isApiError(code)) return code;
    const message = (err as { message?: unknown }).message;
    if (isApiError(message)) return message;
  }
  return isApiError(err) ? err : "E_INTERNAL";
}

/** Safe client-facing detail: known API codes keep their message; unknown errors collapse to E_INTERNAL (details logged only). */
function safeErrorDetail(
  err: unknown,
  log: { error(msg: string, fields?: Record<string, unknown>): void },
): {
  code: string;
  message?: string;
} {
  const code = errorCode(err);
  if (code === "E_INTERNAL") {
    log.error("web-hub http: unclassified error (details suppressed from client)", { error: String(err) });
    return { code };
  }
  return { code, message: err instanceof Error ? err.message : code };
}

function statusFor(code: string): number {
  switch (code) {
    case "E_BAD_REQUEST":
      return 400;
    case "E_AUTH":
      return 401;
    case "E_CSRF":
      return 403;
    case "E_NOT_FOUND":
      return 404;
    case "E_AGENT_GONE":
      return 410;
    case "E_HOST":
      return 421;
    case "E_RATE":
      return 429;
    case "E_NOT_IMPLEMENTED":
      return 501;
    case "E_DEADLINE":
      return 504;
    default:
      return 500;
  }
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("E_DEADLINE"), { code: "E_DEADLINE" })), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(text)),
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, code: string, message?: string): void {
  sendJson(res, status, message === undefined ? { error: code } : { error: code, message });
}

function field(body: unknown, name: string): unknown {
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined;
}

function stringField(body: unknown, name: string): string | undefined {
  const v = field(body, name);
  return typeof v === "string" && v.length > 0 && v.length <= 256 ? v : undefined;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reject(new HttpError(413, "E_BAD_REQUEST", "body too large"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (err: HttpError | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", onData);
      if (err === undefined) resolve(Buffer.concat(chunks));
      else reject(err);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) finish(new HttpError(413, "E_BAD_REQUEST", "body too large"));
      else chunks.push(chunk);
    };
    const timer = setTimeout(() => finish(new HttpError(408, "E_DEADLINE", "body read timeout")), BODY_DEADLINE_MS);
    timer.unref?.();
    req.on("data", onData);
    req.once("end", () => finish(undefined));
    req.once("error", () => finish(new HttpError(400, "E_BAD_REQUEST", "request error")));
    req.once("aborted", () => finish(new HttpError(400, "E_BAD_REQUEST", "request aborted")));
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const buf = await readBody(req);
  if (buf.length === 0) return undefined;
  try {
    return JSON.parse(buf.toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "E_BAD_REQUEST", "invalid JSON");
  }
}

function toCard(v: AgentView): AgentCard {
  const card: AgentCard = {
    agentKey: v.agentKey,
    kind: v.kind,
    pid: v.pid,
    cwd: v.cwd,
    state: v.state,
    pluginVersion: v.pluginVersion,
    outdated: v.outdated,
    prompts: v.prompts,
  };
  if (v.session !== undefined) card.session = v.session;
  if (v.status !== undefined) card.status = v.status;
  return card;
}

// ---------------------------------------------------------------------------
// §1.4.4 buildContext / createLanTransport
// ---------------------------------------------------------------------------

/** `::ffff:1.2.3.4` → `1.2.3.4` (IPv4-mapped IPv6, as node's `net`/`http` report dual-stack peers). */
function normalizePeerIp(ip: string | undefined): string {
  if (ip === undefined) return "";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/**
 * Build the per-request `RequestContext` (plan §2.5 step 1). The loopback
 * branch centralizes what P1's `allowedHost`/`csrfOk` already read off `req`
 * (`req.headers.host`, `req.socket.remoteAddress`) into one place — it does
 * *not* replace those functions' own P1 decision logic (kept byte-identical
 * in `handle()`), so it never rejects for `kind: "loopback"`. The `"lan"`
 * branch (host-snapshot lookup, proxy resolution, 400/421 rejection) is LC's
 * job (W2, S1-W2 `LC:http`) — W1 stub.
 */
export function buildContext(
  req: IncomingMessage,
  kind: ListenerKind,
  lan?: { snapshot: HostSnapshot; trust: ReadonlySet<string> },
): RequestContext | { reject: 400 | 421; code: "E_BAD_REQUEST" | "E_HOST"; detail: string } {
  if (kind === "lan") {
    void lan;
    throw new Error("E_NOT_IMPLEMENTED:LC");
  }
  const peerIp = normalizePeerIp(req.socket.remoteAddress);
  const hostHeader = req.headers.host;
  const hostKey = canonicalHostKey(hostHeader, "http") ?? (hostHeader ?? "").toLowerCase();
  return {
    kind: "loopback",
    peerIp,
    viaTrustedProxy: false,
    clientIp: peerIp,
    scheme: "http",
    hostKey,
    externalOrigin: canonicalOrigin("http", hostKey),
  };
}

/** §2.3's transport seam for the LAN listener; §6.3's `ConnGuard` port isn't frozen elsewhere in W1, so it stays unexported/loose here until LC (W2) fills this in. */
export interface LanTransportCtx {
  handleRequest(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void>;
  log: HubLog;
  connGuard: unknown;
}

export function createLanTransport(_ctx: LanTransportCtx): LanTransport {
  throw new Error("E_NOT_IMPLEMENTED:LC");
}

export const createHttpFrontend: FrontendFactory = (deps: FrontendDeps): HttpFrontend => {
  const { config, registry, bus, history, log, now } = deps;
  const auth = createAuth({ tokenFile: deps.paths.tokenFile, log });
  const sse = createSseHub({ now });
  const root = webRoot();
  const pending = new Map<string, Map<string, PendingSub>>(); // clientId → agentKey → buffer
  const fleetCache = new Map<string, FleetRowWire[]>();
  let server: Server | undefined;
  let port = 0;
  let unsubscribeBus: (() => void) | undefined;
  let closed = false;

  // ---- subscriptions --------------------------------------------------------

  function getPending(clientId: string, agentKey: string): PendingSub | undefined {
    return pending.get(clientId)?.get(agentKey);
  }

  function deletePending(clientId: string, agentKey: string): void {
    const m = pending.get(clientId);
    if (m === undefined) return;
    m.delete(agentKey);
    if (m.size === 0) pending.delete(clientId);
  }

  function dropAgent(agentKey: string): void {
    fleetCache.delete(agentKey);
    for (const clientId of [...pending.keys()]) deletePending(clientId, agentKey);
    // live subscriber sets are pruned lazily: sse.get() only returns live clients
  }

  function bufferScoped(agentKey: string, frame: PendingFrame): void {
    for (const [clientId, m] of pending) {
      const p = m.get(agentKey);
      if (p === undefined) continue;
      if (sse.get(clientId) === undefined) {
        pending.delete(clientId); // client disconnected mid-snapshot
        continue;
      }
      if (p.frames.length >= MAX_PENDING_FRAMES) p.overflow = true;
      else p.frames.push(frame);
    }
  }

  function scoped(event: SseEventName, data: unknown, agentKey: string, seq?: number): void {
    sse.publish(event, data, agentKey);
    bufferScoped(agentKey, seq === undefined ? { event, data } : { event, data, seq });
  }

  function onHubEvent(e: HubEvent): void {
    if (closed) return;
    try {
      switch (e.type) {
        case "agent_up":
          sse.publish("agent_up", { agentKey: e.agent.agentKey, agent: e.agent });
          break;
        case "agent_down":
          dropAgent(e.agentKey);
          sse.publish("agent_down", { agentKey: e.agentKey, reason: e.reason });
          break;
        case "agent_stale":
          sse.publish("agent_stale", { agentKey: e.agentKey });
          break;
        case "session":
          sse.publish("session", { agentKey: e.agentKey, session: e.session });
          break;
        case "status":
          sse.publish("status", { agentKey: e.agentKey, status: e.status });
          break;
        case "fleet":
          fleetCache.set(e.agentKey, e.runs);
          sse.publish("fleet", { agentKey: e.agentKey, runs: e.runs });
          break;
        case "prompt":
          sse.publish("prompt", { agentKey: e.agentKey, prompts: e.prompts });
          break;
        case "ev":
          scoped("ev", { agentKey: e.agentKey, seq: e.seq, e: e.e }, e.agentKey, e.seq);
          break;
        case "gap":
          scoped("gap", { agentKey: e.agentKey, fromSeq: e.fromSeq }, e.agentKey);
          break;
        case "append":
          scoped("append", { agentKey: e.agentKey, entries: e.entries }, e.agentKey);
          break;
      }
    } catch (err) {
      log.error("web-hub http: bus event dispatch failed", { type: e.type, error: String(err) });
    }
  }

  async function runSnapshot(client: SseClient, agentKey: string, p: PendingSub): Promise<void> {
    let payload: HistoryPayload | undefined;
    let error: string | undefined;
    let message: string | undefined;
    try {
      payload = await withDeadline(history.snapshot(agentKey), HISTORY_GUARD_MS);
    } catch (err) {
      const d = safeErrorDetail(err, log);
      error = d.code;
      message = d.message;
    }
    if (getPending(client.id, agentKey) !== p) return; // superseded, unsubscribed or agent gone
    deletePending(client.id, agentKey);
    if (closed || sse.get(client.id) !== client) return;
    if (payload === undefined) {
      client.send("history", { agentKey, error: error ?? "E_INTERNAL", message });
      return;
    }
    if (!client.send("history", payload)) return;
    for (const f of p.frames) {
      if (f.event === "ev" && f.seq !== undefined && f.seq < payload.fromSeq) continue;
      if (!client.send(f.event, f.data)) return;
    }
    if (p.overflow) client.send("gap", { agentKey, fromSeq: payload.fromSeq });
    client.subscribed.add(agentKey);
  }

  // ---- routes ---------------------------------------------------------------

  function allowedHost(host: string | undefined): boolean {
    if (host === undefined) return false;
    const h = host.toLowerCase();
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  }

  function csrfOk(req: IncomingMessage): boolean {
    const ct = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (ct !== "application/json") return false;
    if (req.headers["x-pwh"] !== "1") return false;
    const origin = req.headers.origin;
    if (origin !== undefined && origin.toLowerCase() !== `http://${(req.headers.host ?? "").toLowerCase()}`)
      return false;
    return true;
  }

  function openEvents(req: IncomingMessage, res: ServerResponse): void {
    const raw = req.headers["last-event-id"];
    const lastEventId = typeof raw === "string" && /^\d{1,16}$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
    const client = sse.attach(req, res, lastEventId);
    client.send("hub", { ...deps.info(), port });
    client.send("agents", { agents: registry.list().map(toCard) });
    for (const [agentKey, runs] of fleetCache) client.send("fleet", { agentKey, runs });
    res.once("close", () => pending.delete(client.id));
  }

  function subscribe(body: unknown, res: ServerResponse): void {
    const clientId = stringField(body, "clientId");
    const agentKey = stringField(body, "agentKey");
    if (clientId === undefined || agentKey === undefined) throw new HttpError(400, "E_BAD_REQUEST");
    const client = sse.get(clientId);
    if (client === undefined) throw new HttpError(404, "E_NOT_FOUND", "unknown clientId");
    if (registry.get(agentKey) === undefined) throw new HttpError(404, "E_NOT_FOUND", "unknown agentKey");
    client.subscribed.delete(agentKey); // re-subscribe = fresh snapshot (gap/resync recovery)
    const p: PendingSub = { frames: [], overflow: false };
    let m = pending.get(clientId);
    if (m === undefined) pending.set(clientId, (m = new Map()));
    m.set(agentKey, p);
    sendJson(res, 202, { ok: true });
    void runSnapshot(client, agentKey, p);
  }

  function unsubscribe(body: unknown, res: ServerResponse): void {
    const clientId = stringField(body, "clientId");
    const agentKey = stringField(body, "agentKey");
    if (clientId === undefined || agentKey === undefined) throw new HttpError(400, "E_BAD_REQUEST");
    sse.get(clientId)?.subscribed.delete(agentKey);
    deletePending(clientId, agentKey);
    sendJson(res, 200, { ok: true });
  }

  async function historyPage(query: URLSearchParams, res: ServerResponse): Promise<void> {
    const agentKey = query.get("agent") ?? "";
    const before = query.get("before") ?? "";
    const limitRaw = query.get("limit");
    if (agentKey.length === 0 || before.length === 0) throw new HttpError(400, "E_BAD_REQUEST");
    let limit = HISTORY_PAGE_MAX;
    if (limitRaw !== null) {
      if (!/^\d{1,9}$/.test(limitRaw)) throw new HttpError(400, "E_BAD_REQUEST", "bad limit");
      limit = Math.min(HISTORY_PAGE_MAX, Math.max(1, Number(limitRaw)));
    }
    if (registry.get(agentKey) === undefined) throw new HttpError(404, "E_NOT_FOUND", "unknown agentKey");
    try {
      sendJson(res, 200, await withDeadline(history.page(agentKey, before, limit), HISTORY_GUARD_MS));
    } catch (err) {
      const d = safeErrorDetail(err, log);
      throw new HttpError(statusFor(d.code), d.code, d.message);
    }
  }

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
    query: URLSearchParams,
  ): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    if (method === "POST") {
      if (!csrfOk(req)) throw new HttpError(403, "E_CSRF");
      const body = await readJson(req);
      if (path === "/api/login") {
        const r = auth.login(field(body, "token"), now());
        if (r.ok) {
          sendJson(
            res,
            200,
            { ok: true },
            { "Set-Cookie": `${SESSION_COOKIE}=${r.sid}; HttpOnly; SameSite=Strict; Path=/` },
          );
        } else if (r.code === "E_RATE") {
          sendJson(res, 429, { error: "E_RATE" }, { "Retry-After": String(Math.ceil(LOGIN_WINDOW_MS / 1000)) });
        } else {
          sendError(res, 401, "E_AUTH");
        }
        return;
      }
      if (path === "/api/logout") {
        const sid = readCookie(req.headers.cookie, SESSION_COOKIE);
        if (sid !== undefined) auth.logout(sid);
        sendJson(
          res,
          200,
          { ok: true },
          { "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` },
        );
        return;
      }
      if (!auth.check(req.headers.cookie, now())) throw new HttpError(401, "E_AUTH");
      if (path === "/api/subscribe") return subscribe(body, res);
      if (path === "/api/unsubscribe") return unsubscribe(body, res);
      if (
        path === "/api/cmd" ||
        path === "/api/dialog" ||
        path === "/api/headless" ||
        path.startsWith("/api/headless/")
      )
        throw new HttpError(501, "E_NOT_IMPLEMENTED"); // P2/P3 — middleware already applied
      throw new HttpError(404, "E_NOT_FOUND");
    }
    if (method === "GET") {
      if (!auth.check(req.headers.cookie, now())) throw new HttpError(401, "E_AUTH");
      if (path === "/api/events") return openEvents(req, res);
      if (path === "/api/history") return historyPage(query, res);
    }
    throw new HttpError(404, "E_NOT_FOUND");
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setSecurityHeaders(res);
    if (!allowedHost(req.headers.host)) throw new HttpError(421, "E_HOST");
    const url = req.url ?? "/";
    const qi = url.indexOf("?");
    const path = qi < 0 ? url : url.slice(0, qi);
    const query = new URLSearchParams(qi < 0 ? "" : url.slice(qi + 1));
    const method = (req.method ?? "GET").toUpperCase();
    if (path === "/api" || path.startsWith("/api/")) return handleApi(req, res, method, path, query);
    if (method !== "GET" && method !== "HEAD") throw new HttpError(404, "E_NOT_FOUND");
    if (path === "/healthz") {
      sendJson(res, 200, { ok: true, version: deps.info().version }, { "Cache-Control": "no-store" });
      return;
    }
    if (!(await serveStatic(root, path, res))) throw new HttpError(404, "E_NOT_FOUND");
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        if (err.status === 413 || err.status === 408) {
          res.setHeader("Connection", "close");
          res.once("finish", () => req.destroy());
        }
        sendError(res, err.status, err.code, err.message === err.code ? undefined : err.message);
        return;
      }
      log.error("web-hub http: request failed", { url: req.url, error: String(err) });
      if (!res.headersSent) sendError(res, 500, "E_INTERNAL");
      else res.destroy();
    });
  }

  // ---- lifecycle ------------------------------------------------------------

  function tryListen(srv: Server, p: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      srv.once("error", onError);
      srv.listen(p, BIND_HOST, () => {
        srv.off("error", onError);
        const addr = srv.address();
        resolve(addr !== null && typeof addr === "object" ? addr.port : p);
      });
    });
  }

  async function listen(opts?: { signal?: AbortSignal }): Promise<{ port: number }> {
    if (server !== undefined) return { port };
    if (closed) throw new Error("web-hub http frontend already closed");
    const signal = opts?.signal;
    if (signal?.aborted === true) throw toAbortError(signal);
    auth.token(); // create / repair the token file up front
    const srv = createServer(onRequest);
    srv.headersTimeout = 10_000;
    srv.requestTimeout = 15_000;
    srv.on("connection", (socket) => socket.unref());
    srv.on("clientError", (_err, socket) => socket.destroy());
    let abortedLate = false;
    const onAbort = (): void => {
      abortedLate = true;
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      try {
        port = await tryListen(srv, config.port);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || config.port === 0) throw err;
        log.warn("web-hub http: port in use, falling back to a random port", { port: config.port });
        port = await tryListen(srv, 0);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    if (abortedLate) {
      // The caller (startHub) already gave up while `listen` was in flight — self-clean.
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      throw toAbortError(signal!);
    }
    srv.on("error", (err) => log.error("web-hub http: server error", { error: String(err) }));
    srv.unref();
    server = srv;
    unsubscribeBus = bus.subscribe(onHubEvent);
    log.info("web-hub http listening", { host: BIND_HOST, port });
    return { port };
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    unsubscribeBus?.();
    unsubscribeBus = undefined;
    pending.clear();
    sse.closeAll();
    const srv = server;
    if (srv === undefined) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_DEADLINE_MS);
      timer.unref?.();
      srv.close(() => {
        clearTimeout(timer);
        resolve();
      });
      srv.closeAllConnections();
    });
  }

  return { listen, close, clientCount: () => sse.count() };
};
