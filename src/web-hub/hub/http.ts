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
 *
 * ---------------------------------------------------------------------------
 * LAN listener (plan §2.5, §6, §7 — S1-W2 `LC:http`). Everything below the
 * loopback implementation is the LAN side: `buildContext`'s `"lan"` branch,
 * `createLanTransport` (the `node:http` binder + `ConnGuard` wiring), the
 * LAN application router (`handleLanRequest`, reusing `createRouteSet` so
 * agents/fleet/history/SSE behave identically to loopback — only the auth
 * mechanism and quotas differ), and `createHttpFrontend`'s `deps.lan` wiring
 * that assembles all of it into `HttpFrontend.lan: LanFacade`. This absorbs
 * what plan §3 sketches as a separate `lan-controller.ts` (`LanController`)
 * — that type never made it into `hub/ports.ts`'s W1 freeze, and `http.ts`
 * (LC's exclusive file) is the only place `HttpFrontend.lan` can actually be
 * constructed from a `LanFrontendDeps`, so LC implements the bind → 60s tick
 * → 421-throttled recompute → revoke lifecycle directly here rather than
 * depending on a same-named file that S1-W3's LD package has not written
 * yet. Flagged in the delivery report as a documented deviation, not a
 * frozen-signature change (§11 W1 review only froze `hub/ports.ts` on this
 * point — this is a fully additive implementation choice).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { API_ERRORS, type AgentCard, type HistoryPayload } from "../protocol/http-contract.js";
import { canonicalHostKey, canonicalOrigin, classifyHostToken, parseOrigin } from "../protocol/lan.js";
import type { FleetRowWire } from "../protocol/messages.js";
import { TIMING } from "../protocol/messages.js";
import { createAuth, readCookie, SESSION_COOKIE, LOGIN_WINDOW_MS } from "./auth.js";
import { createConnGuard } from "./conn-guard.js";
import { formatLanCookie, hashSid, readLanCookie, runLanLogin } from "./lan-auth.js";
import { sameHostKeys } from "./net-hosts.js";
import type {
  AgentView,
  ConnGuard,
  ConnLease,
  FrontendDeps,
  FrontendFactory,
  HostSnapshot,
  HttpFrontend,
  HubEvent,
  HubInfo,
  HubLog,
  HistoryService,
  LanFacade,
  LanFrontendDeps,
  LanListenerHandle,
  LanSessionRecord,
  LanStatus,
  LanTransport,
  ListenerKind,
  RegistryView,
  RequestContext,
} from "./ports.js";
import { createSseHub, type SseClient, type SseEventName, type SseHub } from "./sse.js";
import { serveIndex, serveStatic, webRoot } from "./static.js";

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
export const MAX_BODY_BYTES = 64 * 1024;
export const LAN_LOGIN_BODY_BYTES = 4 * 1024;
export const HISTORY_PAGE_MAX = 400;
const BODY_DEADLINE_MS = 10_000;
/** Outer guard on history calls; B enforces TIMING.snapshotMs itself, this only bounds a misbehaving port. */
const HISTORY_GUARD_MS = TIMING.snapshotMs + 1_000;
const CLOSE_DEADLINE_MS = 2_000;
const MAX_PENDING_FRAMES = 4_096;
const BIND_HOST = "127.0.0.1"; // not configurable by design (arch §9)
const LAN_BIND_HOST = "0.0.0.0";
const LAN_SOCKET_IDLE_MS = 60_000;
const LAN_HEADERS_TIMEOUT_MS = 10_000;
const LAN_REQUEST_TIMEOUT_MS = 15_000;
const LAN_KEEPALIVE_TIMEOUT_MS = 5_000;
const LAN_CLIENT_IP_INFLIGHT_CAP = 16;
const LAN_SID_WAITERS_CAP = 8;
const LAN_SSE_GLOBAL_CAP = 32;
const LAN_SSE_PER_SID_CAP = 8;
const LAN_RECOMPUTE_THROTTLE_MS = 5_000;
const LAN_TICK_MS = 60_000;

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
    case "E_BUSY":
    case "E_DB":
      return 503;
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

function readBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
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
      if (size > maxBytes) finish(new HttpError(413, "E_BAD_REQUEST", "body too large"));
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

async function readJson(req: IncomingMessage, maxBytes?: number): Promise<unknown> {
  const buf = await readBody(req, maxBytes);
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

type BuildContextReject = { reject: 400 | 421; code: "E_BAD_REQUEST" | "E_HOST"; detail: string };

/** First label-ish token before an optional `:port` — used only to decide whether a rejected
 * Host looks IPv4-shaped enough to justify a throttled recompute (§2.3). Not a validator. */
function hostPartOf(raw: string | undefined): string {
  if (raw === undefined) return "";
  const idx = raw.lastIndexOf(":");
  return (idx < 0 ? raw : raw.slice(0, idx)).toLowerCase();
}

function buildLanContext(
  req: IncomingMessage,
  lan: { snapshot: HostSnapshot; trust: ReadonlySet<string> },
): RequestContext | BuildContextReject {
  const peerIp = normalizePeerIp(req.socket.remoteAddress);
  const resolution = resolveProxyLocal(peerIp, req.headers, lan.trust);
  if (resolution.viaTrustedProxy && resolution.warnings.includes("proto-invalid")) {
    return { reject: 400, code: "E_BAD_REQUEST", detail: "proxy-proto" };
  }
  const hostRaw = resolution.hostHeader;
  if (hostRaw !== undefined && hostRaw.includes(",")) {
    return { reject: 400, code: "E_BAD_REQUEST", detail: "proxy-host" };
  }
  const hostKey = canonicalHostKey(hostRaw, resolution.scheme);
  if (hostKey === undefined) {
    return { reject: 400, code: "E_BAD_REQUEST", detail: "bad-host" };
  }
  const externalOrigin = canonicalOrigin(resolution.scheme, hostKey);
  if (resolution.viaTrustedProxy) {
    if (!lan.snapshot.externalOrigins.has(externalOrigin)) {
      return { reject: 421, code: "E_HOST", detail: "proxy-host" };
    }
  } else if (!lan.snapshot.hostKeys.has(hostKey)) {
    return { reject: 421, code: "E_HOST", detail: "host" };
  }
  return {
    kind: "lan",
    peerIp,
    viaTrustedProxy: resolution.viaTrustedProxy,
    clientIp: resolution.clientIp,
    scheme: resolution.scheme,
    hostKey,
    externalOrigin,
    snapshot: lan.snapshot,
  };
}

// Inlined instead of importing `./proxy.js` to keep `buildContext` (a pure function per plan
// §1.4.4) free of any module with its own exported test surface beyond what it re-exports; the
// canonical, tested implementation lives in `hub/proxy.ts` (`resolveProxy`) and this delegates to
// it byte-for-byte (kept as a thin re-export, not a duplicate) — see below.
import { resolveProxy as resolveProxyLocal } from "./proxy.js";

/**
 * Build the per-request `RequestContext` (plan §2.5 step 1). The loopback
 * branch centralizes what P1's `allowedHost`/`csrfOk` already read off `req`
 * (`req.headers.host`, `req.socket.remoteAddress`) into one place — it does
 * *not* replace those functions' own P1 decision logic (kept byte-identical
 * in `handle()`), so it never rejects for `kind: "loopback"`. The `"lan"`
 * branch (§2.4 proxy resolution, §2.2 canonicalization, §2.3 whitelist)
 * rejects with 400/421 *before* any `RequestContext` is constructed —
 * matching `createLanTransport`'s contract of only ever calling
 * `handleRequest` with a fully-built `RequestContext`.
 */
export function buildContext(
  req: IncomingMessage,
  kind: ListenerKind,
  lan?: { snapshot: HostSnapshot; trust: ReadonlySet<string> },
): RequestContext | { reject: 400 | 421; code: "E_BAD_REQUEST" | "E_HOST"; detail: string } {
  if (kind === "lan") {
    if (lan === undefined) throw new Error('web-hub: buildContext(req, "lan") requires the lan snapshot/trust arg');
    return buildLanContext(req, lan);
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

/** §2.3's transport seam for the LAN listener; §6.3's `ConnGuard` is now frozen in `hub/ports.ts` (review fix #9). */
export interface LanTransportCtx {
  handleRequest(req: IncomingMessage, res: ServerResponse, ctx: RequestContext, lease: ConnLease): Promise<void>;
  log: HubLog;
  connGuard: ConnGuard;
  /**
   * Called synchronously — never `await`ed by the transport — whenever a request was rejected
   * with `E_HOST` from a *direct* (non-proxy) peer whose `Host` header's host part parses as an
   * IPv4 literal (§2.3: "直连请求收到 421 且 Host 的主机部分是 IPv4 语法 ⇒ 一次节流重算").
   * The transport itself has no `HostsPort`/`cfg` access — throttling and the actual
   * `hosts.compute()` + `handle.swap()` are the caller's job (`createHttpFrontend`'s LAN facade).
   */
  onIPv4HostReject?(hostPart: string): void;
}

interface SocketWithLease extends Socket {
  __lanLease?: ConnLease;
}

export function createLanTransport(ctx: LanTransportCtx): LanTransport {
  return {
    bind(port: number, first: HostSnapshot, signal: AbortSignal): Promise<LanListenerHandle> {
      if (signal.aborted) return Promise.reject(toAbortError(signal));
      let snapshot = first;
      const srv: Server = createServer();
      srv.headersTimeout = LAN_HEADERS_TIMEOUT_MS;
      srv.requestTimeout = LAN_REQUEST_TIMEOUT_MS;
      srv.keepAliveTimeout = LAN_KEEPALIVE_TIMEOUT_MS;
      srv.on("clientError", (_err, socket) => socket.destroy());
      srv.on("connection", (socket: SocketWithLease) => {
        socket.unref();
        const peerIp = normalizePeerIp(socket.remoteAddress);
        const viaTrustedProxy = snapshot.trustProxyFrom.has(peerIp);
        const lease = ctx.connGuard.admit({ peerIp, viaTrustedProxy, onEvict: () => socket.destroy() });
        if (lease === undefined) {
          socket.destroy();
          return;
        }
        socket.__lanLease = lease;
        socket.setTimeout(LAN_SOCKET_IDLE_MS, () => socket.destroy());
        socket.once("close", () => lease.release());
      });
      srv.on("request", (req: IncomingMessage, res: ServerResponse) => {
        const socket = req.socket as SocketWithLease;
        const lease = socket.__lanLease;
        if (lease === undefined) {
          res.destroy();
          return;
        }
        const result = buildContext(req, "lan", { snapshot, trust: snapshot.trustProxyFrom });
        if ("reject" in result) {
          if (result.code === "E_HOST" && !snapshot.trustProxyFrom.has(normalizePeerIp(socket.remoteAddress))) {
            const hostPart = hostPartOf(req.headers.host);
            const cls = classifyHostToken(hostPart);
            if (cls.ok && cls.kind === "ipv4") ctx.onIPv4HostReject?.(hostPart);
          }
          setSecurityHeaders(res);
          sendError(res, result.reject, result.code, result.detail);
          return;
        }
        ctx.handleRequest(req, res, result, lease).catch((err: unknown) => {
          ctx.log.error("web-hub lan http: request failed", { url: req.url, error: String(err) });
          if (!res.headersSent) sendError(res, 500, "E_INTERNAL");
          else res.destroy();
        });
      });
      return new Promise<LanListenerHandle>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        srv.once("error", onError);
        srv.listen(port, LAN_BIND_HOST, () => {
          srv.off("error", onError);
          srv.on("error", (err) => ctx.log.error("web-hub lan http: server error", { error: String(err) }));
          srv.unref();
          const addr = srv.address();
          const boundPort = addr !== null && typeof addr === "object" ? addr.port : port;
          resolve({
            port: boundPort,
            current: () => snapshot,
            swap: (next) => {
              snapshot = next;
            },
            close: () =>
              new Promise<void>((res2) => {
                const timer = setTimeout(res2, CLOSE_DEADLINE_MS);
                timer.unref?.();
                srv.close(() => {
                  clearTimeout(timer);
                  res2();
                });
                srv.closeAllConnections();
              }),
          });
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// shared route set (agents / fleet / history / SSE) — used by both listeners
// ---------------------------------------------------------------------------

interface RouteSet {
  pending: Map<string, Map<string, PendingSub>>;
  fleetCache: Map<string, FleetRowWire[]>;
  onHubEvent(e: HubEvent): void;
  subscribe(body: unknown, res: ServerResponse): void;
  unsubscribe(body: unknown, res: ServerResponse): void;
  openEvents(req: IncomingMessage, res: ServerResponse, auth?: SseClient["auth"]): SseClient;
  historyPage(query: URLSearchParams, res: ServerResponse): Promise<void>;
}

function createRouteSet(
  sse: SseHub,
  routeDeps: {
    registry: RegistryView;
    history: HistoryService;
    log: HubLog;
    info: () => HubInfo;
    port: () => number;
    isClosed: () => boolean;
  },
): RouteSet {
  const pending = new Map<string, Map<string, PendingSub>>();
  const fleetCache = new Map<string, FleetRowWire[]>();

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
  }

  function bufferScoped(agentKey: string, frame: PendingFrame): void {
    for (const [clientId, m] of pending) {
      const p = m.get(agentKey);
      if (p === undefined) continue;
      if (sse.get(clientId) === undefined) {
        pending.delete(clientId);
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
    if (routeDeps.isClosed()) return;
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
      routeDeps.log.error("web-hub http: bus event dispatch failed", { type: e.type, error: String(err) });
    }
  }

  async function runSnapshot(client: SseClient, agentKey: string, p: PendingSub): Promise<void> {
    let payload: HistoryPayload | undefined;
    let error: string | undefined;
    let message: string | undefined;
    try {
      payload = await withDeadline(routeDeps.history.snapshot(agentKey), HISTORY_GUARD_MS);
    } catch (err) {
      const d = safeErrorDetail(err, routeDeps.log);
      error = d.code;
      message = d.message;
    }
    if (getPending(client.id, agentKey) !== p) return;
    deletePending(client.id, agentKey);
    if (routeDeps.isClosed() || sse.get(client.id) !== client) return;
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

  function openEvents(req: IncomingMessage, res: ServerResponse, auth?: SseClient["auth"]): SseClient {
    const raw = req.headers["last-event-id"];
    const lastEventId = typeof raw === "string" && /^\d{1,16}$/.test(raw.trim()) ? Number(raw.trim()) : undefined;
    const client = sse.attach(req, res, lastEventId, auth);
    client.send("hub", { ...routeDeps.info(), port: routeDeps.port() });
    client.send("agents", { agents: routeDeps.registry.list().map(toCard) });
    for (const [agentKey, runs] of fleetCache) client.send("fleet", { agentKey, runs });
    res.once("close", () => pending.delete(client.id));
    return client;
  }

  function subscribe(body: unknown, res: ServerResponse): void {
    const clientId = stringField(body, "clientId");
    const agentKey = stringField(body, "agentKey");
    if (clientId === undefined || agentKey === undefined) throw new HttpError(400, "E_BAD_REQUEST");
    const client = sse.get(clientId);
    if (client === undefined) throw new HttpError(404, "E_NOT_FOUND", "unknown clientId");
    if (routeDeps.registry.get(agentKey) === undefined) throw new HttpError(404, "E_NOT_FOUND", "unknown agentKey");
    client.subscribed.delete(agentKey);
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
    if (routeDeps.registry.get(agentKey) === undefined) throw new HttpError(404, "E_NOT_FOUND", "unknown agentKey");
    try {
      sendJson(res, 200, await withDeadline(routeDeps.history.page(agentKey, before, limit), HISTORY_GUARD_MS));
    } catch (err) {
      const d = safeErrorDetail(err, routeDeps.log);
      throw new HttpError(statusFor(d.code), d.code, d.message);
    }
  }

  return { pending, fleetCache, onHubEvent, subscribe, unsubscribe, openEvents, historyPage };
}

// ---------------------------------------------------------------------------
// LAN application router (plan §2.5, §6.4, §7)
// ---------------------------------------------------------------------------

interface LanRuntime {
  lan: LanFrontendDeps;
  routes: RouteSet;
  lanSse: SseHub;
  root: string;
  now: () => number;
  version: () => string;
  log: HubLog;
  clientInflight: Map<string, number>;
  sidInflight: Map<string, { promise: Promise<LanSessionRecord | undefined>; waiters: number }>;
}

function sharedTouchSession(rt: LanRuntime, sidHash: string): Promise<LanSessionRecord | undefined> | "busy" {
  let entry = rt.sidInflight.get(sidHash);
  if (entry === undefined) {
    const promise = rt.lan.store.touchSession(sidHash, rt.now()).finally(() => {
      rt.sidInflight.delete(sidHash);
    });
    entry = { promise, waiters: 1 };
    rt.sidInflight.set(sidHash, entry);
    return promise;
  }
  if (entry.waiters >= LAN_SID_WAITERS_CAP) return "busy";
  entry.waiters++;
  return entry.promise;
}

function releaseClientInflight(rt: LanRuntime, ip: string): void {
  const c = (rt.clientInflight.get(ip) ?? 1) - 1;
  if (c <= 0) rt.clientInflight.delete(ip);
  else rt.clientInflight.set(ip, c);
}

interface LanSessionResult {
  userId: number;
  epoch: number;
  sidHash: string;
}

/** §2.5 step 5's "需要会话" gate: per-clientIP inflight quota → (for `/api/events`) SSE
 * global/per-sid limits, checked *before* any IPC → `touchSession` (deduped per `sidHash`, ≤8
 * riders) → expiry + origin-binding re-check. Sends the terminal error response itself and
 * returns `undefined` on any failure; on success the caller still owns `res` (and, for SSE,
 * `res`'s lifetime governs when the inflight slot is released). */
async function requireLanSession(
  rt: LanRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  isSseRoute: boolean,
  lease: ConnLease,
): Promise<LanSessionResult | undefined> {
  const ip = ctx.clientIp;
  const current = rt.clientInflight.get(ip) ?? 0;
  if (current >= LAN_CLIENT_IP_INFLIGHT_CAP) {
    sendError(res, 429, "E_RATE");
    return undefined;
  }
  rt.clientInflight.set(ip, current + 1);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseClientInflight(rt, ip);
  };
  res.once("close", release);
  res.once("finish", release);

  const sid = readLanCookie(req.headers.cookie);
  if (sid === undefined) {
    release();
    sendError(res, 401, "E_AUTH");
    return undefined;
  }
  const sidHash = hashSid(sid);

  if (isSseRoute) {
    const perSid = rt.lanSse.list().filter((c) => c.auth?.sidHash === sidHash).length;
    if (rt.lanSse.count() >= LAN_SSE_GLOBAL_CAP || perSid >= LAN_SSE_PER_SID_CAP) {
      release();
      sendError(res, 429, "E_RATE");
      return undefined;
    }
  }

  const touched = sharedTouchSession(rt, sidHash);
  let rec: LanSessionRecord | undefined;
  if (touched === "busy") {
    release();
    sendError(res, 429, "E_RATE");
    return undefined;
  }
  try {
    rec = await touched;
  } catch (err) {
    release();
    rt.log.error("web-hub lan http: touchSession failed", { error: String(err) });
    sendError(res, 503, "E_DB");
    return undefined;
  }
  if (rec === undefined) {
    release();
    sendError(res, 401, "E_AUTH");
    return undefined;
  }
  const expired = rt.now() >= Math.min(rec.expiresAt, rec.absoluteExpiresAt);
  if (expired || rec.boundOrigin !== ctx.externalOrigin) {
    release();
    sendError(res, 401, "E_AUTH");
    return undefined;
  }
  lease.enterAuthed();
  return { userId: rec.userId, epoch: rec.epoch, sidHash };
}

function csrfOkLan(req: IncomingMessage, ctx: RequestContext): boolean {
  const ct = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json") return false;
  if (req.headers["x-pwh"] !== "1") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  const parsed = parseOrigin(origin);
  if (parsed === undefined) return false;
  return canonicalOrigin(parsed.scheme, parsed.hostKey) === ctx.externalOrigin;
}

async function handleLanRequestInner(
  rt: LanRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  lease: ConnLease,
): Promise<void> {
  setSecurityHeaders(res);
  const url = req.url ?? "/";
  const qi = url.indexOf("?");
  const path = qi < 0 ? url : url.slice(0, qi);
  const query = new URLSearchParams(qi < 0 ? "" : url.slice(qi + 1));
  const method = (req.method ?? "GET").toUpperCase();

  if (method === "OPTIONS") throw new HttpError(404, "E_NOT_FOUND");

  if (path === "/healthz") {
    if (method !== "GET" && method !== "HEAD") throw new HttpError(404, "E_NOT_FOUND");
    sendJson(
      res,
      200,
      { ok: true, version: rt.version(), authMode: "password", plaintext: ctx.scheme === "http" },
      { "Cache-Control": "no-store" },
    );
    return;
  }

  if (path !== "/api" && !path.startsWith("/api/")) {
    if (method !== "GET" && method !== "HEAD") throw new HttpError(404, "E_NOT_FOUND");
    if (!(await serveStatic(rt.root, path, res, { authMode: "password" }))) throw new HttpError(404, "E_NOT_FOUND");
    return;
  }

  res.setHeader("Cache-Control", "no-store");

  if (method === "POST") {
    if (!csrfOkLan(req, ctx)) throw new HttpError(403, "E_CSRF");
    if (path === "/api/login") {
      const body = await readJson(req, LAN_LOGIN_BODY_BYTES);
      const outcome = await runLanLogin(
        ctx,
        body,
        { store: rt.lan.store, kdf: rt.lan.kdf, limiter: rt.lan.limiter, admission: rt.lan.admission },
        rt.now(),
        { onAdmitted: () => lease.enterLoginPending() },
      );
      if (outcome.status === 200) {
        lease.enterAuthed();
        sendJson(
          res,
          200,
          { ok: true, initialPasswordInUse: outcome.initialPasswordInUse },
          { "Set-Cookie": formatLanCookie(outcome.cookie, { secure: ctx.scheme === "https" }) },
        );
      } else if (outcome.status === 429) {
        sendJson(
          res,
          429,
          { error: "E_RATE", ...(outcome.saturated === true ? { saturated: true } : {}) },
          { "Retry-After": String(Math.ceil(outcome.retryAfterMs / 1000)) },
        );
      } else {
        sendError(res, 401, "E_AUTH");
      }
      return;
    }
    if (path === "/api/logout") {
      const sid = readLanCookie(req.headers.cookie);
      if (sid !== undefined) {
        const sidHash = hashSid(sid);
        try {
          await rt.lan.store.deleteSession(sidHash);
          rt.lanSse.revoke((c) => c.auth?.sidHash === sidHash, "revoked");
        } catch (err) {
          rt.log.error("web-hub lan http: logout deleteSession failed", { error: String(err) });
        }
      }
      sendJson(
        res,
        200,
        { ok: true },
        { "Set-Cookie": formatLanCookie("", { secure: ctx.scheme === "https", clear: true }) },
      );
      return;
    }
    const session = await requireLanSession(rt, req, res, ctx, false, lease);
    if (session === undefined) return;
    const body = await readJson(req);
    if (path === "/api/subscribe") return rt.routes.subscribe(body, res);
    if (path === "/api/unsubscribe") return rt.routes.unsubscribe(body, res);
    throw new HttpError(404, "E_NOT_FOUND");
  }

  if (method === "GET") {
    if (path === "/api/session") {
      const session = await requireLanSession(rt, req, res, ctx, false, lease);
      if (session === undefined) return;
      const summary = await rt.lan.store.getUserSummary(session.userId);
      sendJson(res, 200, {
        username: summary?.username ?? "",
        initialPasswordInUse: summary?.initialPasswordInUse ?? false,
      });
      return;
    }
    if (path === "/api/events") {
      const session = await requireLanSession(rt, req, res, ctx, true, lease);
      if (session === undefined) return;
      rt.routes.openEvents(req, res, {
        sidHash: session.sidHash,
        userId: session.userId,
        epoch: session.epoch,
        boundOrigin: ctx.externalOrigin,
        verifiedAt: rt.now(),
      });
      return;
    }
    if (path === "/api/history") {
      const session = await requireLanSession(rt, req, res, ctx, false, lease);
      if (session === undefined) return;
      await rt.routes.historyPage(query, res);
      return;
    }
  }

  throw new HttpError(404, "E_NOT_FOUND");
}

function handleLanRequest(
  rt: LanRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  lease: ConnLease,
): Promise<void> {
  return handleLanRequestInner(rt, req, res, ctx, lease).catch((err: unknown) => {
    if (err instanceof HttpError) {
      if (err.status === 413 || err.status === 408) {
        res.setHeader("Connection", "close");
        res.once("finish", () => req.destroy());
      }
      sendError(res, err.status, err.code, err.message === err.code ? undefined : err.message);
      return;
    }
    rt.log.error("web-hub lan http: request failed", { url: req.url, error: String(err) });
    if (!res.headersSent) sendError(res, 500, "E_INTERNAL");
    else res.destroy();
  });
}

function buildLanStatus(cfg: LanFrontendDeps["cfg"], snapshot: HostSnapshot, boundPort: number): LanStatus {
  const hosts = [...snapshot.hostKeys]
    .map((k) => k.slice(0, k.lastIndexOf(":")))
    .sort((a, b) => {
      const aIsIp =
        classifyHostToken(a).ok &&
        classifyHostToken(a).ok === true &&
        (classifyHostToken(a) as { kind: string }).kind === "ipv4";
      const bIsIp =
        classifyHostToken(b).ok &&
        classifyHostToken(b).ok === true &&
        (classifyHostToken(b) as { kind: string }).kind === "ipv4";
      if (aIsIp !== bIsIp) return aIsIp ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  const proxy =
    cfg.trustProxyFrom.length > 0
      ? { trustedFrom: [...cfg.trustProxyFrom], externalOrigins: [...cfg.externalOrigins] }
      : undefined;
  return {
    state: "on",
    port: boundPort,
    hosts,
    omitted: [...snapshot.omitted],
    ...(proxy === undefined ? {} : { proxy }),
    warnings: ["plaintext"],
  };
}

export const createHttpFrontend: FrontendFactory = (deps: FrontendDeps): HttpFrontend => {
  const { config, registry, bus, history, log, now } = deps;
  const auth = createAuth({ tokenFile: deps.paths.tokenFile, log });
  const sse = createSseHub({ now });
  const root = webRoot();
  let server: Server | undefined;
  let port = 0;
  let unsubscribeBus: (() => void) | undefined;
  let closed = false;

  const routes = createRouteSet(sse, {
    registry,
    history,
    log,
    info: deps.info,
    port: () => port,
    isClosed: () => closed,
  });

  // ---- LAN facade (§2.5/§6/§7) ------------------------------------------

  let lanFacade: LanFacade | undefined;
  let lanSseRef: SseHub | undefined;
  if (deps.lan !== undefined) {
    const lan = deps.lan;
    const lanSse = createSseHub({ now });
    lanSseRef = lanSse;
    const lanRoutes = createRouteSet(lanSse, {
      registry,
      history,
      log,
      info: deps.info,
      port: () => lan.cfg.port,
      isClosed: () => lanClosed,
    });
    let lanClosed = false;
    const unsubscribeLanBus = bus.subscribe(lanRoutes.onHubEvent);
    const rt: LanRuntime = {
      lan,
      routes: lanRoutes,
      lanSse,
      root,
      now,
      version: () => deps.info().version,
      log,
      clientInflight: new Map(),
      sidInflight: new Map(),
    };
    const connGuard = createConnGuard();
    let handle: LanListenerHandle | undefined;
    let gen = 0;
    let status: LanStatus = { state: "starting" };
    let lastRecomputeAt = 0;

    function recompute(force: boolean): void {
      if (handle === undefined) return;
      const t = now();
      if (!force && t - lastRecomputeAt < LAN_RECOMPUTE_THROTTLE_MS) return;
      lastRecomputeAt = t;
      const next = lan.hosts.compute(lan.cfg);
      const cur = handle.current();
      if (sameHostKeys(cur, next)) return;
      gen++;
      const swapped: HostSnapshot = { ...next, gen };
      handle.swap(swapped);
      status = buildLanStatus(lan.cfg, swapped, handle.port);
      lan.onStatus(status);
    }

    const transport = createLanTransport({
      log,
      connGuard,
      onIPv4HostReject: () => recompute(false),
      handleRequest: (req, res, ctx, lease) => handleLanRequest(rt, req, res, ctx, lease),
    });

    lanFacade = {
      async start(): Promise<LanStatus> {
        const first = lan.hosts.compute(lan.cfg);
        gen = 1;
        handle = await transport.bind(lan.cfg.port, { ...first, gen }, lan.scope.signal);
        status = buildLanStatus(lan.cfg, handle.current(), handle.port);
        lan.scope.timer(() => recompute(true), LAN_TICK_MS, true);
        return status;
      },
      status(): LanStatus {
        return status;
      },
      async close(): Promise<void> {
        lanClosed = true;
        unsubscribeLanBus();
        lanSse.closeAll();
        rt.sidInflight.clear();
        rt.clientInflight.clear();
        await handle?.close();
      },
      revoke(target: { sidHash: string } | { userId: number }): number {
        const pred: (c: SseClient) => boolean =
          "sidHash" in target ? (c) => c.auth?.sidHash === target.sidHash : (c) => c.auth?.userId === target.userId;
        return lanSse.revoke(pred, "revoked");
      },
    };
  }

  // ---- loopback subscriptions -------------------------------------------

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
    routes.openEvents(req, res);
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
      if (path === "/api/subscribe") return routes.subscribe(body, res);
      if (path === "/api/unsubscribe") return routes.unsubscribe(body, res);
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
      if (path === "/api/history") return routes.historyPage(query, res);
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
    if (!(await serveStatic(root, path, res, { authMode: "token" }))) throw new HttpError(404, "E_NOT_FOUND");
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
    unsubscribeBus = bus.subscribe(routes.onHubEvent);
    log.info("web-hub http listening", { host: BIND_HOST, port });
    return { port };
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await lanFacade?.close();
    unsubscribeBus?.();
    unsubscribeBus = undefined;
    routes.pending.clear();
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

  return {
    listen,
    close,
    clientCount: () => sse.count() + (lanSseRef === undefined ? 0 : lanSseRef.count()),
    ...(lanFacade === undefined ? {} : { lan: lanFacade }),
  };
};
