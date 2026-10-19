/** Isolated proxy origin listener: direct Host/conn guard, one-time entry and cookie gate (§3.5). */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Socket } from "node:net";
import type { ClientAllowGuard, ConnLease, HostSnapshot } from "../ports.js";
import { createConnGuard } from "../conn-guard.js";
import { canonicalHostKey } from "../../protocol/lan.js";
import { clearingSetCookies, resolveCookieIdentitySync, PROXY_GATE_COOKIE_MAX } from "../auth-identity.js";
import {
  PROXY_STRICT_CSP_BASE,
  proxyFrameAncestors,
  type ProxyReplyPolicy,
  PROXY_STREAM_HWM_BYTES,
  PROXY_SERVER_OPTIONS,
  PROXY_MAX_REQUESTS_PER_SOCKET,
  PROXY_SOCKET_TIMEOUT_MS,
  PROXY_CONN_GUARD,
  PROXY_ENTER_PATH,
  PROXY_ENTER_QUERY,
  PROXY_RESERVED_PREFIX,
  PROXY_ENTER_RATE_PER_MIN,
  PROXY_ENTER_BAD_CODE_WEIGHT,
  PROXY_EXPIRED_PAGE_ZH,
  PROXY_EXPIRED_PAGE_EN,
  PROXY_COOKIE_CONFLICT_REASON,
  PROXY_RETRY_AFTER_S,
  proxyCookieName,
  PROXY_LISTENER_STATUS as STATUS,
} from "../../protocol/proxy.js";
import { createProxyForwarder, type ProxyForwardDeps, type ProxyRequestGate } from "./forward.js";
import { armProxyHandshake, createProxyWebSockets, proxyResponseHead, type ProxyWsBudget } from "./ws.js";
import type { FilteredProxyHeaders } from "./headers.js";

// Same strict policy as the hub, without importing its frontend/composition graph.
const STRICT_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
});
const expiredPage = () => `${PROXY_EXPIRED_PAGE_ZH}\n${PROXY_EXPIRED_PAGE_EN}\n`;
export function sendProxyResponse(
  res: ServerResponse,
  status: number,
  headers: Record<string, string | string[]> = {},
  body?: string,
  policy?: ProxyReplyPolicy,
): void {
  if (res.destroyed || res.headersSent) {
    res.destroy();
    return;
  }
  const { "X-Frame-Options": _xfo, ...frameHeaders } = STRICT_HEADERS;
  res.writeHead(status, {
    ...(policy === undefined
      ? STRICT_HEADERS
      : {
          ...frameHeaders,
          "Content-Security-Policy": `${PROXY_STRICT_CSP_BASE}; frame-ancestors ${policy.frameAncestors}`,
        }),
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(
    body ?? (status === STATUS.gateFailed || status === STATUS.enterFailed ? expiredPage() : "Proxy request refused\n"),
  );
}
export interface ProxyListenerDeps extends Omit<ProxyForwardDeps, "reply"> {
  port: number;
  hubPort: number;
  lanPort?: number;
  lan: boolean;
  lanHostSnapshot(): HostSnapshot | undefined;
  budget: ProxyWsBudget;
  onRequest(): void;
  /**
   * LAN client allowlist (LAN security §2.3 #3). REQUIRED on purpose — no optional chaining anywhere:
   * a forgotten wire is a compile error, never a silently-open listener. Callers that have no
   * allowlist pass an inactive guard (`createClientAllowGuard({})`), which admits everything.
   * Enforced in the `connection` hook, i.e. before both `request` and `upgrade`.
   */
  clientAllow: ClientAllowGuard;
}
export interface ProxyListener {
  readonly server: Server;
  readonly sockets: Set<Socket>;
  readonly upgraded: Set<Socket>;
  readonly forward: ReturnType<typeof createProxyForwarder>;
  close(): Promise<void>;
}
/** A raw listener; service owns bounded listen/close, idle sweep and the irreversible fence. */
export function createProxyListener(deps: ProxyListenerDeps): ProxyListener {
  const server = createServer({ ...PROXY_SERVER_OPTIONS, highWaterMark: PROXY_STREAM_HWM_BYTES });
  server.maxRequestsPerSocket = PROXY_MAX_REQUESTS_PER_SOCKET;
  const guard = createConnGuard(PROXY_CONN_GUARD);
  const leases = new Map<Socket, ConnLease>();
  const sockets = new Set<Socket>();
  const upgraded = new Set<Socket>();
  const attached = new Map<Socket, Set<ProxyRequestGate["session"]>>();
  const enterRates = new Map<string, { at: number; used: number }>();
  let closing = false;
  let closed: Promise<void> | undefined;
  const forward = createProxyForwarder({
    ...deps,
    reply: (res, status, headers, policy) => sendProxyResponse(res, status, headers, undefined, policy),
  });
  const rejectSocket = (
    socket: Socket,
    status: number,
    headers: FilteredProxyHeaders = {},
    body = status === STATUS.gateFailed || status === STATUS.enterFailed ? expiredPage() : "Proxy request refused\n",
  ) => {
    if (socket.destroyed) return;
    socket.end(
      proxyResponseHead(status, {
        ...STRICT_HEADERS,
        ...headers,
        ...(status === STATUS.busy ? { "Retry-After": String(PROXY_RETRY_AFTER_S) } : {}),
        "Content-Length": Buffer.byteLength(body),
        Connection: "close",
      }) + body,
      () => socket.destroy(),
    );
  };
  const ws = createProxyWebSockets({ ...deps, upgraded, reject: rejectSocket });
  server.on("connection", (socket) => {
    socket.unref();
    if (closing) {
      socket.destroy();
      return;
    }
    // Allowlist first: a denied peer gets no bytes and never takes a connection-guard lease.
    // Proxy origins are never behind a trusted reverse proxy (`viaTrustedProxy: false` below).
    if (!deps.clientAllow.admitPeer(socket.remoteAddress ?? "", false)) {
      socket.destroy();
      return;
    }
    const lease = guard.admit({
      peerIp: socket.remoteAddress ?? "",
      viaTrustedProxy: false,
      onEvict: () => socket.destroy(),
    });
    if (lease === undefined) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    leases.set(socket, lease);
    socket.setTimeout(PROXY_SOCKET_TIMEOUT_MS, () => {
      if (!upgraded.has(socket)) socket.destroy();
    });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      lease.release();
      sockets.delete(socket);
      leases.delete(socket);
      upgraded.delete(socket);
      for (const s of attached.get(socket) ?? []) deps.sessions.detach(s, socket);
      attached.delete(socket);
    });
  });
  server.on("clientError", (_err, socket) => {
    // Header overflows have a useful bounded 431 response; all other parse errors just close.
    if ("code" in _err && _err.code === "HPE_HEADER_OVERFLOW") rejectSocket(socket as Socket, 431);
    else socket.destroy();
  });
  server.on("connect", (_req, socket) => socket.destroy());
  // Binding errors have their own service-owned once listener; never become unhandled later.
  server.on("error", () => {});
  const attach = (req: IncomingMessage, gate: ProxyRequestGate): boolean => {
    const socket = req.socket;
    if (!deps.sessions.attach(gate.session, socket)) return false;
    let set = attached.get(socket);
    if (set === undefined) {
      set = new Set();
      attached.set(socket, set);
    }
    set.add(gate.session);
    leases.get(socket)?.enterAuthed();
    return true;
  };
  const hostOrigin = (req: IncomingMessage): string | undefined => {
    const host = canonicalHostKey(req.headers.host, "http");
    if (host === undefined) return undefined;
    const allowed = new Set([`127.0.0.1:${deps.port}`, `localhost:${deps.port}`]);
    if (deps.lan)
      for (const key of deps.lanHostSnapshot()?.hostKeys ?? []) {
        const h = key.slice(0, key.lastIndexOf(":"));
        allowed.add(`${h}:${deps.port}`);
      }
    return allowed.has(host) ? `http://${host}` : undefined;
  };
  const targetStatus = (req: IncomingMessage): number | undefined => {
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) return STATUS.badTarget;
    if (req.method === "TRACE" || req.method === "TRACK") return STATUS.methodNotAllowed;
    return undefined;
  };
  const gate = (req: IncomingMessage, origin: string) =>
    resolveCookieIdentitySync(req.headers.cookie, proxyCookieName(deps.port), PROXY_GATE_COOKIE_MAX, (sid) =>
      deps.sessions.lookup(sid, deps.instanceId, origin, { touch: false }),
    );
  const conflictHeaders = (req: IncomingMessage) => ({
    "Set-Cookie": clearingSetCookies(proxyCookieName(deps.port), req.url ?? "/", req.headers.host, { secure: false }),
  });
  server.on("request", (req, res) => {
    const origin = hostOrigin(req);
    if (closing) {
      sendProxyResponse(res, STATUS.busy);
      return;
    }
    if (origin === undefined) {
      sendProxyResponse(res, STATUS.hostMismatch);
      return;
    }
    const policy: ProxyReplyPolicy = {
      frameAncestors: proxyFrameAncestors(origin.slice(7, origin.lastIndexOf(":")), deps.hubPort, deps.lanPort),
    };
    const reply = (status: number, headers?: Record<string, string | string[]>, body?: string) =>
      sendProxyResponse(res, status, headers, body, policy);
    const invalid = targetStatus(req);
    if (invalid !== undefined) {
      reply(invalid);
      return;
    }
    const url = new URL(req.url!, origin);
    if (url.pathname.startsWith(PROXY_RESERVED_PREFIX)) {
      if (req.method !== "GET" || url.pathname !== PROXY_ENTER_PATH) {
        reply(STATUS.reservedNotFound);
        return;
      }
      const peer = req.socket.remoteAddress ?? "";
      const now = deps.now();
      for (const [ip, r] of enterRates) if (now - r.at >= 60_000) enterRates.delete(ip);
      let rate = enterRates.get(peer);
      if (rate === undefined) {
        if (enterRates.size >= PROXY_CONN_GUARD.maxConnections) {
          reply(STATUS.rateLimited);
          return;
        }
        rate = { at: now, used: 0 };
        enterRates.set(peer, rate);
      }
      if (rate.used >= PROXY_ENTER_RATE_PER_MIN) {
        reply(STATUS.rateLimited);
        return;
      }
      rate.used++;
      const prior = gate(req, origin);
      const result = deps.sessions.exchange(
        url.searchParams.get(PROXY_ENTER_QUERY) ?? "",
        deps.instanceId,
        origin,
        prior.kind === "one" ? { reuse: prior.rec } : undefined,
      );
      if (!result.ok) {
        rate.used += PROXY_ENTER_BAD_CODE_WEIGHT - 1;
        if ("kind" in result) reply(STATUS.enterFailed);
        else reply(result.status, {}, JSON.stringify({ error: result.error, reason: result.reason }));
        return;
      }
      deps.onRequest();
      const access = {
        ...policy,
        origin,
        browserHost: req.headers.host!,
        session: result.rec,
        traffic: deps.sessionTraffic(result.rec),
      };
      if (!attach(req, access)) {
        res.destroy();
        return;
      }
      reply(
        303,
        {
          Location: result.nextPath,
          ...(result.reused
            ? {}
            : { "Set-Cookie": `${proxyCookieName(deps.port)}=${result.sid}; HttpOnly; SameSite=Lax; Path=/` }),
        },
        "",
      );
      return;
    }
    const resolved = gate(req, origin);
    if (resolved.kind === "conflict") {
      reply(
        STATUS.gateFailed,
        conflictHeaders(req),
        JSON.stringify({ error: "E_AUTH", reason: PROXY_COOKIE_CONFLICT_REASON }),
      );
      return;
    }
    if (resolved.kind !== "one") {
      reply(STATUS.gateFailed);
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method ?? "")) {
      if (
        (req.headers.origin !== undefined && req.headers.origin !== origin) ||
        ["same-site", "cross-site"].includes(String(req.headers["sec-fetch-site"]))
      ) {
        reply(STATUS.originForbidden);
        return;
      }
    }
    const access = {
      ...policy,
      origin,
      browserHost: req.headers.host!,
      session: resolved.rec,
      traffic: deps.sessionTraffic(resolved.rec),
    };
    if (!deps.sessions.touch(resolved.rec, "http") || !attach(req, access)) {
      res.destroy();
      return;
    }
    deps.onRequest();
    deps.traffic.reqs++;
    access.traffic.reqs++;
    forward.handle(req, res, access);
  });
  server.on("upgrade", (req, raw, head) => {
    const socket = raw as Socket;
    const cancelHandshake = armProxyHandshake(socket, deps.timer);
    const reject = (status: number, headers?: FilteredProxyHeaders, body?: string) =>
      rejectSocket(socket, status, headers, body);
    const origin = hostOrigin(req);
    if (closing) {
      reject(STATUS.busy);
      return;
    }
    if (origin === undefined) {
      reject(STATUS.hostMismatch);
      return;
    }
    const invalid = targetStatus(req);
    if (invalid !== undefined) {
      reject(invalid);
      return;
    }
    if (new URL(req.url!, origin).pathname.startsWith(PROXY_RESERVED_PREFIX)) {
      reject(STATUS.reservedNotFound);
      return;
    }
    const resolved = gate(req, origin);
    if (resolved.kind === "conflict") {
      reject(
        STATUS.gateFailed,
        conflictHeaders(req),
        JSON.stringify({ error: "E_AUTH", reason: PROXY_COOKIE_CONFLICT_REASON }),
      );
      return;
    }
    if (resolved.kind !== "one") {
      reject(STATUS.gateFailed);
      return;
    }
    if (req.headers.origin !== origin) {
      reject(STATUS.originForbidden);
      return;
    }
    if (
      req.method !== "GET" ||
      req.headers.upgrade?.toLowerCase() !== "websocket" ||
      !req.headers["sec-websocket-key"]
    ) {
      reject(STATUS.badTarget);
      return;
    }
    const access = {
      frameAncestors: proxyFrameAncestors(origin.slice(7, origin.lastIndexOf(":")), deps.hubPort, deps.lanPort),
      origin,
      browserHost: req.headers.host!,
      session: resolved.rec,
      traffic: deps.sessionTraffic(resolved.rec),
    };
    if (!attach(req, access)) {
      socket.destroy();
      return;
    }
    deps.onRequest();
    ws.handle(req, socket, head, access, cancelHandshake);
  });
  return {
    server,
    sockets,
    upgraded,
    forward,
    close() {
      if (closed !== undefined) {
        // A service listen seam may settle AFTER the first close, including after its promise.
        if (server.listening) {
          server.close();
          server.closeAllConnections();
        }
        return closed;
      }
      closing = true;
      ws.close();
      forward.close();
      // Do not await before destroying sockets: server.close alone cannot close upgrades.
      closed = new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      for (const socket of upgraded) socket.destroy();
      enterRates.clear();
      return closed;
    },
  };
}
