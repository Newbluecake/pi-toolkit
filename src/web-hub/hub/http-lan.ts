/**
 * hub HTTP LAN side (plan §2.5, §6, §7 — S1-W2 `LC:http`), split out of
 * `http.ts` (source-governance batch-2 ⑨-H2) as a pure extraction:
 * `createLanTransport` (the `node:http` binder + `ConnGuard` wiring) lives
 * here together with the LAN application router (`handleLanRequest*` moving
 * in the follow-up commit) — reusing `http.ts`'s `createRouteSet` so
 * agents/fleet/history/SSE behave identically to loopback; only the auth
 * mechanism and quotas differ. The shared low-level HTTP helpers stay in
 * `http.ts` and are imported back; nothing in this file is edited relative
 * to its previous `http.ts` incarnation except the added `export` keywords.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { classifyHostToken } from "../protocol/lan.js";
import {
  buildContext,
  CLOSE_DEADLINE_MS,
  LAN_REQUEST_TIMEOUT_MS,
  normalizePeerIp,
  requestFailedFields,
  sendError,
  setSecurityHeaders,
  toAbortError,
} from "./http.js";
import type {
  ClientAllowGuard,
  ConnGuard,
  ConnLease,
  HostSnapshot,
  HubLog,
  LanListenerHandle,
  LanTransport,
  RequestContext,
} from "./ports.js";

const LAN_BIND_HOST = "0.0.0.0";
const LAN_SOCKET_IDLE_MS = 60_000;
const LAN_HEADERS_TIMEOUT_MS = 10_000;
const LAN_KEEPALIVE_TIMEOUT_MS = 5_000;

/** First label-ish token before an optional `:port` — used only to decide whether a rejected
 * Host looks IPv4-shaped enough to justify a throttled recompute (§2.3). Not a validator. */
function hostPartOf(raw: string | undefined): string {
  if (raw === undefined) return "";
  const idx = raw.lastIndexOf(":");
  return (idx < 0 ? raw : raw.slice(0, idx)).toLowerCase();
}

/** §2.3's transport seam for the LAN listener; §6.3's `ConnGuard` is now frozen in `hub/ports.ts` (review fix #9). */
export interface LanTransportCtx {
  clientAllow: ClientAllowGuard;
  csp?: string;
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
        const peerIp = normalizePeerIp(socket.remoteAddress);
        const viaTrustedProxy = snapshot.trustProxyFrom.has(peerIp);
        if (!ctx.clientAllow.admitPeer(peerIp, viaTrustedProxy)) {
          socket.destroy();
          return;
        }
        socket.unref();
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
          setSecurityHeaders(res, ctx.csp);
          sendError(res, result.reject, result.code, result.detail);
          return;
        }
        if (
          result.viaTrustedProxy &&
          !ctx.clientAllow.admitForwarded({ clientIp: result.clientIp, xffUsable: result.xffUsable === true })
        ) {
          setSecurityHeaders(res, ctx.csp);
          sendError(res, 403, "E_CLIENT");
          return;
        }
        ctx.handleRequest(req, res, result, lease).catch((err: unknown) => {
          ctx.log.error("web-hub lan http: request failed", requestFailedFields(req, err));
          if (!res.headersSent) sendError(res, 500, "E_INTERNAL");
          else res.destroy();
        });
      });
      // Review fix (LC, plan §1.4/§3, W3 acceptance item 1): the entry check above only catches
      // a signal that was *already* aborted before `bind()` was even called — a signal that
      // aborts while `listen()` is still in flight (the caller's `LAN_START_DEADLINE_MS` timer, or
      // a concurrent `LanFacade.close()`) was previously ignored entirely: `listen()`'s callback
      // would still fire, still `resolve()`, and hand back a fully bound, listening server that
      // nobody asked for anymore — a leaked listener holding the port. Wire an `abort` listener for
      // the whole lifetime of this bind attempt so whichever settles first (the real `listening`/
      // `error` event, or the caller giving up) wins exactly once; the loser's side effect (a
      // half-bound or fully-bound `srv`) is always closed by this function itself — the caller
      // never has to know a server object ever existed for an attempt it abandoned.
      return new Promise<LanListenerHandle>((resolve, reject) => {
        let settled = false;
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          srv.off("error", onError);
          // `srv.close()` is safe to call even before `listening` has fired (Node queues the
          // close behind the in-flight bind); either way the port is released and no 'listening'
          // server is left dangling.
          srv.close();
          reject(toAbortError(signal));
        };
        const onError = (err: Error): void => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(err);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        srv.once("error", onError);
        srv.listen(port, LAN_BIND_HOST, () => {
          srv.off("error", onError);
          signal.removeEventListener("abort", onAbort);
          if (settled) return; // `onAbort` (or `onError`) already won the race and closed `srv`
          if (signal.aborted) {
            // Belt-and-suspenders for the boundary case where `listening` fires without our own
            // `abort` listener having run first — either way, a caller that gave up must never
            // receive a resolved handle.
            settled = true;
            srv.close();
            reject(toAbortError(signal));
            return;
          }
          settled = true;
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
