/**
 * hub HTTP LAN side (plan §2.5, §6, §7 — S1-W2 `LC:http`), split out of
 * `http.ts` (source-governance batch-2 ⑨-H2) as a pure extraction:
 * `createLanTransport` (the `node:http` binder + `ConnGuard` wiring) lives
 * here together with the LAN application router (`handleLanRequest`) —
 * reusing `http.ts`'s `createRouteSet` so agents/fleet/history/SSE behave
 * identically to loopback; only the auth mechanism and quotas differ. The shared low-level HTTP helpers stay in
 * `http.ts` and are imported back; nothing in this file is edited relative
 * to its previous `http.ts` incarnation except the added `export` keywords.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Value } from "@sinclair/typebox/value";
import { AGENT_REMOVE_PATH, COMMAND_COMPLETE_PATH, LOAD_TOP_PATH } from "../protocol/http-contract.js";
import { canonicalOrigin, classifyHostToken, parseOrigin } from "../protocol/lan.js";
import {
  LAN_2FA_CANCEL_PATH,
  LAN_2FA_COOKIE,
  LAN_2FA_PATH,
  LAN_2FA_WAIT_PATH,
  LanFactorBodySchema,
  normalizeRecoveryCode,
} from "../protocol/lan-2fa.js";
import { AVATAR_DELETE_PATH, AVATAR_PATH, AVATAR_STORE_MIN_MS } from "../protocol/avatar.js";
import { PREVIEW_PATH, PREVIEW_PROBE_PATH } from "../protocol/preview.js";
import { PREVIEW_AUTH_RESERVE_MS } from "./preview/routes.js";
import { PREVIEW_HTML_CAP_PATH, PV_PREFIX, PVW_PREFIX } from "../protocol/preview-html.js";
import { PRIVACY_LOCK_PATH, PRIVACY_VERIFY_PATH } from "../protocol/privacy.js";
import { SCHED_API_PATH } from "../protocol/schedule.js";
import { UPLOAD_CHUNK_PATH, UPLOAD_TOTAL_MS } from "../protocol/upload.js";
import { VERSION_INFO_PATH, VERSION_LIMITS } from "../protocol/version-info.js";
import { WTDIFF_FILES_PATH, WTDIFF_FILE_PATH } from "../protocol/worktree-diff.js";
import { WTGRAPH_FILES_PATH, WTGRAPH_PATH } from "../protocol/worktree-graph.js";
import { WTDIFF_AUTH_RESERVE_MS } from "./worktree-diff/routes.js";
import type { AgentRemoveFrontendPort } from "./agent-remove.js";
import {
  cookieCandidates,
  lanIdentity,
  lanRecordValid,
  resolveCookieIdentity,
  type AuthIdentity,
  type LanSessionResult,
} from "./auth-identity.js";
import type { AuthRevokeBus } from "./auth-revoke.js";
import type { UploadHttpMetrics } from "./audit.js";
import { createCmdLimit, type CmdLimit } from "./cmd-limit.js";
import type { CommandCompleteRoutes } from "./command-complete.js";
import { FILE_SEARCH_AUTH_RESERVE_MS, FILE_SEARCH_PATH } from "./file-search.js";
import {
  buildContext,
  CLOSE_DEADLINE_MS,
  field,
  HttpError,
  isHeadlessPath,
  isProxyApiPath,
  LAN_LOGIN_BODY_BYTES,
  LAN_REQUEST_TIMEOUT_MS,
  normalizePeerIp,
  proxyBrowserHost,
  readBody,
  readJson,
  requestFailedFields,
  type RouteSet,
  sendCookieConflict,
  sendError,
  sendJson,
  serveLoadTop,
  serveSchedules,
  serveVersionInfo,
  setSecurityHeaders,
  strictCsrfOk,
  apiCrossSiteOk,
  toAbortError,
  uploadCsrfOk,
} from "./http.js";
import { dispatchCmdOrDialog } from "./http-cmd.js";
import { formatLanCookie, hashSid, LAN_SESSION_COOKIE } from "./lan-auth.js";
import { LOAD_TOP_DEADLINE_MS, LOAD_TOP_LAN_TOTAL_MS, type HubLoadService } from "./load.js";
import type {
  ClientAllowGuard,
  ConnGuard,
  ConnLease,
  HostSnapshot,
  HubLog,
  LanFrontendDeps,
  LanListenerHandle,
  LanLoginCore,
  LanSessionRecord,
  LanSessionsRoutes,
  LanTransport,
  LoginIo,
  LoginReply,
  RequestContext,
} from "./ports.js";
import type {
  AvatarRoutes,
  CommandRouter,
  PreviewAuthHandled,
  PreviewAuthResult,
  PreviewRoutes,
  PrivacyRouteIo,
  PrivacyRoutes,
  ProxyRouteIo,
  ProxyRoutes,
  RegistryView,
  VersionInfoPort,
  WorktreeDiffRoutes,
  WorktreeGraphRoutes,
} from "./ports.js";
import { deriveBudget, LAN_AUTH_CAP_MS, LAN_AUTH_RESERVE_MS, raceDeadline, type ReqDeadline } from "./req-deadline.js";
import type { ScheduleCoordinator } from "./schedule/service.js";
import type { SpawnFrontendPort } from "./spawn/ports.js";
import type { SseClient, SseHub } from "./sse.js";
import type { UiServer } from "./static.js";
import { handleUploadRequest } from "./upload-http.js";
import type { UploadStore } from "./uploads.js";
import type { FileSearchRoutes } from "./ports.js";

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

const LAN_CLIENT_IP_INFLIGHT_CAP = 16;
const LAN_SID_WAITERS_CAP = 8;
const LAN_SSE_GLOBAL_CAP = 32;
const LAN_SSE_PER_SID_CAP = 8;

/** web-hub-upload plan §1.3 (U3): a LAN chunk request's SECOND authorize (after the body read)
 * shares the final ~1s of `UPLOAD_TOTAL_MS` with the disk write — its `touchSession` race keeps
 * only this much in reserve for the write (the first authorize keeps `UPLOAD_TOTAL_MS -
 * LAN_AUTH_CAP_MS` = 11s). */
const UPLOAD_CHUNK_REAUTH_RESERVE_MS = 300;

const LAN_SSE_EXPIRY_BATCH_CAP = 32;
const LAN_SSE_EXPIRY_BATCH_DEADLINE_MS = 20_000;

// §4.2 review fix (lan-plan.md task LC #1): the 55s tick above depends on the db being reachable
// (`touchSession`); while the db is down it can't revoke anything, so a per-connection local
// timer keyed off the session's own `absoluteExpiresAt` (7-day hard ceiling) is the only thing
// that still fires. `setTimeout`'s delay is a signed 32-bit int (~24.8 days) — well above the
// 7-day ceiling in practice, but `scheduleAbsoluteExpiry` still segments a longer remaining span
// defensively rather than silently truncating it.
const ABS_EXPIRY_MAX_DELAY_MS = 2_147_483_647;

// ---------------------------------------------------------------------------
// LAN application router (plan §2.5, §6.4, §7)
// ---------------------------------------------------------------------------

export interface LanRuntime {
  loginCore?: LanLoginCore;
  sessions?: LanSessionsRoutes;
  csp: string;
  lan: LanFrontendDeps;
  /** web-hub-proxy plan §4.2 (XA): the frontend-wide auth revocation bus (same instance as the
   * loopback listener's) — every LAN revoke site `emit`s here instead of calling the preview
   * hook directly. */
  authRevoke: AuthRevokeBus;
  /** §4.1 (XA): `pwh_lan` candidate cap. Absent/1 ⇒ first-value, byte-identical to pre-XA;
   * `LAN_COOKIE_MAX` only when the frontend's `multiCandidateAuth` option is on. */
  lanCookieMax?: number;
  /** web-hub-proxy plan §4.3/§3.8 (X1c): the proxy route frontend + the `/api` cross-site gate
   * (P4). Both absent ⇒ the LAN `/api` matrix is byte-identical to a hub without the feature. */
  proxy?: ProxyRoutes;
  /** scheduled-reports H1 (§5.6): the coordinator serving `GET /api/schedules` on the LAN
   *  listener (same width as loopback — the panel is read-only by design). Absent ⇒ the LAN
   *  branch keeps its original reply matrix, byte-identical. */
  schedules?: ScheduleCoordinator;
  crossSiteGate?: boolean;
  routes: RouteSet;
  lanSse: SseHub;
  /** Weak keys avoid retaining disconnected SSE clients; holds only the resolved IP. */
  sseClientIps?: WeakMap<SseClient, string>;
  ui: UiServer;
  now: () => number;
  version: () => string;
  hubCaps?: readonly string[];
  log: HubLog;
  clientInflight: Map<string, number>;
  sidInflight: Map<string, { promise: Promise<LanSessionRecord | undefined>; waiters: number }>;
  /** §4.2 review fix (LC #1): per-`SseClient.id` local absolute-expiry timers, keyed so a
   * connection's own close/revoke can clear it and `LanFacade.close()` can sweep the rest. */
  absoluteExpiryTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** §5.1/§9.2 review fix (LC #2): marks a corrupt KDF param row so the next status rebuild
   * folds `db-invalid:kdf` into `LanStatus.warnings` — set by the login path's
   * `onCorruptKdfParams`, read by `buildLanStatus` via the closure in `createHttpFrontend`. */
  markKdfInvalid: () => void;
  /** plan §6.1/§6.3 (C3): P2 control-plane wiring for `POST /api/cmd`/`/api/dialog` on the LAN
   * listener — optional so `LanRuntime` literals built by other tests (e.g.
   * `lan-sse-verifiedat.test.ts`, unrelated to cmd/dialog) don't need to supply them; the real
   * assembly in `createHttpFrontend` always sets all three. */
  registry?: RegistryView;
  commands?: CommandRouter | undefined;
  /** web-hub-upload plan §6 U3: upload store for the LAN `/api/upload/*` branch (same instance
   * as the loopback listener's; absent ⇒ those endpoints answer 501). */
  uploads?: UploadStore | undefined;
  /** §5.4 (U3 P2-2): shared HTTP-layer upload reject counters (same instance as loopback's). */
  uploadMetrics?: UploadHttpMetrics | undefined;
  cmdLimit?: CmdLimit;
  /** C3 P1 fix (plan §6.4): 429-audit throttle map, shared with the loopback listener (same
   * instance `createHttpFrontend` passes to both `dispatchCmdOrDialog` call sites) so a given
   * throttle key's reject line is written at most once per `RATE_AUDIT_WINDOW_MS` regardless of
   * which listener the flood is coming from. */
  rejectAudit429?: Map<string, number>;
  /** web-hub-spawn plan §SP9 (arch §8.2): the spawn route frontend, same instance as the
   * loopback listener's. `handleLanRequestInner` only dispatches to it when its own LAN-policy
   * gate (`publicPayload("lan") !== undefined`, i.e. `cfg.lan !== "off"`) passes — absent ⇒ the
   * LAN face stays byte-identical to the not-enabled matrix. */
  spawn?: SpawnFrontendPort | undefined;
  /** web-hub-preview plan v3 §4.5/§4.7 (PV3): the preview route frontend, same instance as the
   * loopback listener's. `handleLanRequestInner` only dispatches to it when `mode === "on"`
   * (§4.7 matrix: `mode:"loopback"` ⇒ LAN answers 404 exactly like not-enabled); absent ⇒
   * `GET /api/preview` on LAN keeps its original 404, byte-identical. */
  preview?: PreviewRoutes | undefined;
  /** @文件补全 (file-mention): the file-search route frontend, same instance as the loopback
   * listener's; same §4.7 gate as preview above (`mode === "on"` only, else original 404). */
  fileSearch?: FileSearchRoutes | undefined;
  commandComplete?: CommandCompleteRoutes | undefined;
  /** worktree-diff plan §1.6 (D3): the worktree-diff route frontend, same instance as the
   * loopback listener's; same §4.7-style LAN gate as preview/file-search above (`mode === "on"`
   * only — `mode:"loopback"` keeps the LAN 404 byte-identical to not-enabled, D6). */
  worktreeDiff?: WorktreeDiffRoutes | undefined;
  /** worktree-graph plan v2 §2.6 (P2): the worktree-graph route frontend, same instance as the
   * loopback listener's; same §4.7-style LAN gate as wtdiff above (`mode === "on"` only —
   * `mode:"loopback"` keeps the LAN 404 byte-identical to not-enabled). */
  worktreeGraph?: WorktreeGraphRoutes | undefined;
  /** web-hub-delete-session plan v2 §2.9: the agent/managed-session removal route frontend, same
   * instance as the loopback listener's. Absent ⇒ `POST /api/agents/remove` on LAN keeps its
   * original 404, byte-identical to not-enabled. */
  agentRemove?: AgentRemoveFrontendPort | undefined;
  /** web-hub-avatar plan v2.1 §2.1: same route instance as loopback; absent keeps the off matrix. */
  avatar?: AvatarRoutes | undefined;
  /** web-hub-privacy plan v2.1 (P1): same route instance as loopback; absent keeps both
   * `/api/privacy/*` paths at their byte-identical not-enabled 404s. The LAN dispatch mounts
   * BOTH `verify` and `lock` (loopback mounts only `lock` — v2.1 N1). */
  privacy?: PrivacyRoutes | undefined;
  /** sysload P3: shared hub activation for the LAN-equal-width top endpoint. */
  load?: HubLoadService;
  /** web-hub-version plan §3.9: same service as the loopback listener's; absent ⇒ route not mounted. */
  versionInfo?: VersionInfoPort | undefined;
}

function sharedTouchSession(
  rt: LanRuntime,
  sidHash: string,
  ip: string,
): Promise<LanSessionRecord | undefined> | "busy" {
  let entry = rt.sidInflight.get(sidHash);
  if (entry === undefined) {
    const promise = rt.lan.store.touchSession(sidHash, rt.now(), { ip }).finally(() => {
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

/** `lan-store.ts`'s concrete `LanStore` exposes an unfrozen `touchSessionReserved` for exactly
 * this tick (its own doc comment says so), but `LanFrontendDeps.store` is typed as the frozen
 * `LanStorePort` (§1.4.1/§4, W1) which has no such method — widening it is a signature change
 * out of this package's review-fix authorization (only `ConnLease` got one, lan-plan.md §15.9
 * #1). Duck-type it instead: use the reserved channel when the concrete store happens to expose
 * it, otherwise fall back to the plain (frozen) `touchSession` — either way the validation logic
 * below is identical. */
function touchForExpiryRecheck(
  store: LanFrontendDeps["store"],
  sidHash: string,
  now: number,
  ip?: string,
): Promise<LanSessionRecord | undefined> {
  const opts = ip === undefined ? {} : { ip };
  const reserved = (store as { touchSessionReserved?: LanFrontendDeps["store"]["touchSession"] }).touchSessionReserved;
  return typeof reserved === "function"
    ? reserved.call(store, sidHash, now, opts)
    : store.touchSession(sidHash, now, opts);
}

/** §4.2 "SSE 到期复核" (LC review fix, lan-plan.md §15.9 #3): a 55s tick, independent of `sse.ts`'s
 * ping-only keepalive, that re-validates every authenticated LAN SSE connection's session —
 * revoked (`deleteSession`)/rotated (`setPassword`'s epoch bump)/expired sessions must not leave
 * an SSE stream open past this cadence even if nothing else ever touches them again. Per §4.2:
 * processes at most `LAN_SSE_EXPIRY_BATCH_CAP` (32) clients per tick, serially, deferring any
 * remainder to the next tick (backlog only grows if `LAN_SSE_EXPIRY_TICK_MS` is somehow shorter
 * than 32 sequential IPC round-trips, which never happens in practice); a store rejection (`E_DB`
 * / timeout) *keeps* the connection open and only logs — "can't verify" is never treated as
 * "revoke". */
/** Exported for a focused unit test on the §4.2 review-fix behaviors (LC #3's `verifiedAt`
 * update; the batch/deadline/db-rejection paths are already covered end-to-end through
 * `tests/web-hub/http/lan-sse-expiry.test.ts`'s real HTTP harness) — not part of any frozen
 * (`ports.ts`) surface. */
export async function recheckLanSseExpiry(rt: LanRuntime): Promise<void> {
  const clients = rt.lanSse
    .list()
    .filter((c): c is SseClient & { auth: NonNullable<SseClient["auth"]> } => c.auth !== undefined);
  if (clients.length === 0) return;
  const batch = clients.slice(0, LAN_SSE_EXPIRY_BATCH_CAP);
  if (clients.length > batch.length) {
    rt.log.warn("web-hub lan http: sse expiry recheck backlog, deferring remainder to next tick", {
      pending: clients.length - batch.length,
    });
  }
  const deadline = rt.now() + LAN_SSE_EXPIRY_BATCH_DEADLINE_MS;
  for (const client of batch) {
    if (rt.now() > deadline) {
      rt.log.warn("web-hub lan http: sse expiry recheck batch deadline exceeded, deferring remainder", {});
      break;
    }
    const auth = client.auth;
    let rec: LanSessionRecord | undefined;
    try {
      rec = await touchForExpiryRecheck(rt.lan.store, auth.sidHash, rt.now(), rt.sseClientIps?.get(client));
    } catch (err) {
      rt.log.error("web-hub lan http: sse expiry recheck touchSession failed, keeping connection", {
        error: String(err),
      });
      continue;
    }
    const expired =
      rec === undefined ||
      rec.epoch !== auth.epoch ||
      rec.boundOrigin !== auth.boundOrigin ||
      rt.now() >= Math.min(rec.expiresAt, rec.absoluteExpiresAt);
    if (expired) rt.lanSse.revoke((c) => c === client, "expired");
    // §4.2 review fix (LC #3): a successful recheck (not expired) is itself proof of liveness —
    // record it on the client's own `auth` so `list()`/observability reflects the last time this
    // connection's session was actually re-validated, not just when it was opened.
    else auth.verifiedAt = rt.now();
  }
}

/** §4.2 review fix (LC #1): schedules (and, on fire, reschedules across `ABS_EXPIRY_MAX_DELAY_MS`
 * segments) a client-local `unref`'d timer at the session's `absoluteExpiresAt` (7-day hard
 * ceiling) so an LAN SSE connection is force-closed at that instant even while the db is
 * unavailable and `recheckLanSseExpiry`'s 55s tick can't reach it (that tick depends on
 * `touchSession`, i.e. the db). Idempotent to call again for the same client — overwrites
 * whatever timer was tracked under `client.id`. */
function scheduleAbsoluteExpiry(rt: LanRuntime, client: SseClient, absoluteExpiresAt: number): void {
  const arm = (): void => {
    const remaining = absoluteExpiresAt - rt.now();
    if (remaining <= 0) {
      rt.absoluteExpiryTimers.delete(client.id);
      if (client.revoked !== true) rt.lanSse.revoke((c) => c === client, "expired");
      return;
    }
    const t = setTimeout(arm, Math.min(remaining, ABS_EXPIRY_MAX_DELAY_MS));
    t.unref();
    rt.absoluteExpiryTimers.set(client.id, t);
  };
  arm();
}

/** Clears (if any) the absolute-expiry timer for `clientId` — called on the connection's own
 * `close` (natural disconnect, logout/passwd revoke, tick-recheck revoke) and swept in bulk by
 * `LanFacade.close()`. Safe to call when there is nothing to clear. */
function clearAbsoluteExpiry(rt: LanRuntime, clientId: string): void {
  const t = rt.absoluteExpiryTimers.get(clientId);
  if (t === undefined) return;
  clearTimeout(t);
  rt.absoluteExpiryTimers.delete(clientId);
}

/** What `requireLanSession` resolves to: the historical fields every route consumer reads, plus
 * the single `AuthIdentity` (§4.1) built from the SAME resolution — nothing re-parses the cookie. */
interface LanAuthed extends LanSessionResult {
  identity: AuthIdentity;
}

/** Thrown from inside the candidate validator to abort the whole resolution with a terminal error
 * (429 busy / 503 db) — fail closed, never "try the next candidate". */
class LanAuthFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
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
  /** §3.3 step ② (C3 P1 fix): when supplied (only the `/api/cmd`/`/api/dialog` write pipeline
   * does), races the shared `touchSession` lookup against this many ms so a slow/hung db can never
   * silently eat the whole request-level `ReqDeadline` budget. A timeout degrades to the exact
   * same 503 `E_DB` branch a real `touchSession` rejection already takes below — the underlying
   * shared promise is never cancelled (other waiters on the same `sidHash` still get their
   * result), this request just stops waiting on it. */
  authDeadlineMs?: number,
  /** §6.4 (C3 P1 fix): when supplied (same callers as `authDeadlineMs`), the failure `code` sent
   * to the client is also mirrored here so `dispatchCmdOrDialog` can write its own reject-phase
   * audit line — this function keeps sending the response itself either way, this is purely an
   * out-param for audit correlation. */
  authFailure?: { code?: string },
): Promise<LanAuthed | undefined> {
  const fail = (status: number, code: string): undefined => {
    if (authFailure !== undefined) authFailure.code = code;
    sendError(res, status, code);
    return undefined;
  };
  const ip = ctx.clientIp;
  const current = rt.clientInflight.get(ip) ?? 0;
  if (current >= LAN_CLIENT_IP_INFLIGHT_CAP) {
    return fail(429, "E_RATE");
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

  // §4.1 (XA): the ONE resolution of `pwh_lan`. `max === 1` (default) is the legacy first-value
  // path — same checks, same order, same IPC as before (no cookie ⇒ 401 before anything else; SSE
  // caps before `touchSession`; busy/db/deadline ⇒ the same 429/503; expired/origin ⇒ 401).
  const resolveStarted = Date.now();
  let resolution;
  try {
    resolution = await resolveCookieIdentity(
      req.headers.cookie,
      LAN_SESSION_COOKIE,
      rt.lanCookieMax ?? 1,
      async (sid, index) => {
        const sidHash = hashSid(sid);
        if (isSseRoute) {
          const perSid = rt.lanSse.list().filter((c) => c.auth?.sidHash === sidHash).length;
          if (rt.lanSse.count() >= LAN_SSE_GLOBAL_CAP || perSid >= LAN_SSE_PER_SID_CAP) {
            throw new LanAuthFailure(429, "E_RATE");
          }
        }
        const touched = sharedTouchSession(rt, sidHash, ctx.clientIp);
        if (touched === "busy") throw new LanAuthFailure(429, "E_RATE");
        let rec: LanSessionRecord | undefined;
        try {
          // one shared budget across candidates: the first gets the full `authDeadlineMs`
          rec =
            authDeadlineMs === undefined
              ? await touched
              : await raceDeadline(
                  touched,
                  index === 0 ? authDeadlineMs : Math.max(1, authDeadlineMs - (Date.now() - resolveStarted)),
                );
        } catch (err) {
          rt.log.error("web-hub lan http: touchSession failed", { error: String(err) });
          throw new LanAuthFailure(503, "E_DB");
        }
        if (rec === undefined || !lanRecordValid(rec, rt.now(), ctx.externalOrigin)) return undefined;
        return { rec, sidHash };
      },
    );
  } catch (err) {
    release();
    if (err instanceof LanAuthFailure) return fail(err.status, err.code);
    throw err;
  }
  if (resolution.kind === "conflict") {
    release();
    if (authFailure !== undefined) authFailure.code = "E_AUTH";
    sendCookieConflict(res, req, LAN_SESSION_COOKIE, ctx.scheme === "https");
    return undefined;
  }
  if (resolution.kind === "none") {
    release();
    return fail(401, "E_AUTH");
  }
  const { rec, sidHash } = resolution.rec;
  // Feishu phone links remember only an already-admitted, successfully authenticated Host.
  try {
    rt.lan.onAuthenticated?.(ctx);
  } catch {
    /* observation must never affect auth */
  }
  lease.enterAuthed();
  const lan: LanSessionResult = {
    userId: rec.userId,
    epoch: rec.epoch,
    sidHash,
    absoluteExpiresAt: rec.absoluteExpiresAt,
  };
  return { ...lan, identity: lanIdentity(lan, rec) };
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

/** C's post-success work belongs to response finish, NEVER response close. */
export function writeLanLoginReply(
  result: LoginReply,
  res: ServerResponse,
  io: LoginIo,
  lease: ConnLease,
  abort: () => void,
  log: HubLog,
): void {
  if (io.signal.aborted || !io.responseOpen()) {
    abort();
    lease.leaveLoginPending();
    return;
  }
  if (result.after !== undefined) {
    const after = result.after;
    res.once("finish", () => {
      void after().catch(() => log.error("web-hub lan login: after failed"));
    });
  }
  if (result.status === 200 && "ok" in result.body) lease.enterAuthed();
  else lease.leaveLoginPending();
  // Node preserves arrays here (session + cleared challenge cookie); do not comma-join them.
  for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
  sendJson(res, result.status, result.body);
}

async function handleLanLogin(
  rt: LanRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  lease: ConnLease,
  path: string,
): Promise<void> {
  const core = rt.loginCore;
  if (core === undefined) throw new HttpError(503, "E_DB");
  const controller = new AbortController();
  let finished = false;
  const abort = () => controller.abort();
  const cleanup = () => {
    req.off("aborted", abort);
    res.off("close", close);
  };
  const close = () => {
    if (!finished) abort();
    cleanup();
  };
  req.once("aborted", abort);
  res.once("close", close);
  res.once("finish", () => {
    finished = true;
    cleanup();
  });
  // Ordinary IncomingMessage.close/end is a successfully read body, NOT client cancellation.
  const io: LoginIo = {
    ua: req.headers["user-agent"] ?? "",
    signal: controller.signal,
    responseOpen: () => !res.destroyed && !res.writableEnded,
    onAdmitted: () => lease.enterLoginPending(),
  };
  try {
    let result: LoginReply;
    if (path === "/api/login") {
      const body = await readJson(req, LAN_LOGIN_BODY_BYTES);
      result = await core.passwordLogin(ctx, body, io.ua, io);
    } else {
      const token = cookieCandidates(req.headers.cookie, LAN_2FA_COOKIE, 1).values[0] ?? "";
      lease.enterLoginPending();
      if (path === LAN_2FA_WAIT_PATH) result = await core.waitApproval(token, ctx, io);
      else if (path === LAN_2FA_CANCEL_PATH) {
        core.cancel(token, ctx);
        result = {
          status: 200,
          body: { ok: true },
          headers: {
            "Set-Cookie": `${LAN_2FA_COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/login; Max-Age=0${ctx.scheme === "https" ? "; Secure" : ""}`,
          },
        };
      } else {
        const body = await readJson(req, LAN_LOGIN_BODY_BYTES);
        // Strict schema validation precedes core admission/budget accounting. Never cast method.
        const code = field(body, "code");
        const normalized =
          field(body, "method") === "recovery" && typeof code === "string"
            ? { ...(body as Record<string, unknown>), code: normalizeRecoveryCode(code) }
            : body;
        if (!Value.Check(LanFactorBodySchema, normalized)) throw new HttpError(400, "E_BAD_REQUEST");
        result = await core.submitFactor(token, normalized, ctx, io);
      }
    }
    writeLanLoginReply(result, res, io, lease, abort, rt.log);
  } catch (err) {
    abort();
    lease.leaveLoginPending();
    throw err;
  }
}

async function handleLanRequestInner(
  rt: LanRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  lease: ConnLease,
): Promise<void> {
  setSecurityHeaders(res, rt.csp);
  const url = req.url ?? "/";
  const qi = url.indexOf("?");
  const path = qi < 0 ? url : url.slice(0, qi);
  const query = new URLSearchParams(qi < 0 ? "" : url.slice(qi + 1));
  const method = (req.method ?? "GET").toUpperCase();

  if (method === "OPTIONS") throw new HttpError(404, "E_NOT_FOUND");
  if (
    rt.lan.secondFactorEnabled !== true &&
    (path === LAN_2FA_PATH || path === LAN_2FA_WAIT_PATH || path === LAN_2FA_CANCEL_PATH)
  ) {
    throw new HttpError(404, "E_NOT_FOUND");
  }

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
    // web-hub-html-preview plan v2 §4 (P1b): `/pv/<cap>/<rel>` and `/pvw/<cap>` — capability-
    // authenticated (I1: no cookie, no `requireLanSession`), dispatched before the static
    // fallback and gated `mode === "on"` + the methods being attached; otherwise this falls
    // through to `ui.serve` ⇒ the original 404, byte-identical. `path` is query-stripped.
    if (rt.preview !== undefined && rt.preview.mode === "on") {
      if (rt.preview.servePv !== undefined && path.startsWith(PV_PREFIX)) {
        return rt.preview.servePv(req, res, path.slice(PV_PREFIX.length), {
          listener: "lan",
          ip: ctx.clientIp,
          origin: ctx.externalOrigin,
        });
      }
      if (rt.preview.serveWrapper !== undefined && path.startsWith(PVW_PREFIX)) {
        return rt.preview.serveWrapper(req, res, path.slice(PVW_PREFIX.length), {
          listener: "lan",
          ip: ctx.clientIp,
          origin: ctx.externalOrigin,
        });
      }
    }
    const acceptLanguage = req.headers["accept-language"];
    const acceptEncoding = req.headers["accept-encoding"];
    if (
      !(await rt.ui.serve(path, res, {
        authMode: "password",
        ...(rt.lan.secondFactorEnabled === true && rt.hubCaps?.includes("lan.2fa.v1") ? { lan2fa: true } : {}),
        ...(typeof acceptLanguage === "string" ? { acceptLanguage } : {}),
        ...(typeof acceptEncoding === "string" ? { acceptEncoding } : {}),
      }))
    ) {
      throw new HttpError(404, "E_NOT_FOUND");
    }
    return;
  }

  res.setHeader("Cache-Control", "no-store");

  // web-hub-proxy plan §4.3 (P4, X1c): armed only when the proxy is wired. After the OPTIONS 404
  // above (no ACAO either way), before any cookie is read.
  if (rt.crossSiteGate === true && !apiCrossSiteOk(req, ctx.externalOrigin)) throw new HttpError(403, "E_CSRF");

  // web-hub-spawn plan §SP9 (arch §8.2): `/api/headless*` — dispatched before the generic
  // method branches, exactly like the `/api/cmd`/`/api/upload` branches below, and gated on the
  // spawn frontend's own LAN-policy verdict (`publicPayload("lan")` is undefined when
  // `cfg.lan === "off"`) so a policy-off LAN face falls through to the ORIGINAL paths and stays
  // byte-identical to the not-enabled matrix. `authorize` copies the :cmd segment below.
  if (rt.spawn !== undefined && isHeadlessPath(path) && rt.spawn.publicPayload("lan") !== undefined) {
    return rt.spawn.handle(req, res, method, path, query, {
      listener: "lan",
      ip: ctx.clientIp,
      scheme: ctx.scheme,
      viaTrustedProxy: ctx.viaTrustedProxy,
      strictCsrfOk: () => strictCsrfOk(req, ctx.externalOrigin),
      authorize: async (deadline) => {
        const authDeadlineMs = deriveBudget(deadline.remaining(), LAN_AUTH_CAP_MS, LAN_AUTH_RESERVE_MS);
        const authFailure: { code?: string } = {};
        const session = await requireLanSession(rt, req, res, ctx, false, lease, authDeadlineMs, authFailure);
        if (session === undefined) return { handled: true, code: authFailure.code ?? "E_AUTH" };
        return { ip: ctx.clientIp, user: `u${session.userId}` };
      },
      readJson,
      sendJson,
      sendError,
      HttpError,
    });
  }

  // web-hub-proxy plan §3.8 (X1c): `/api/proxy*` — dispatched right after headless on the LAN
  // face too (present only when the proxy is wired, which implies `config.lan` here). The route
  // owns CSRF/auth/bucket; a trusted-reverse-proxy mint is refused inside it (409
  // `reverse-proxy`). `false` ⇒ not a proxy route/method ⇒ the original matrix below.
  if (rt.proxy !== undefined && isProxyApiPath(path)) {
    const proxyIo: ProxyRouteIo = {
      listener: "lan",
      ip: ctx.clientIp,
      expectedOrigin: ctx.externalOrigin,
      browserHost: proxyBrowserHost(ctx.hostKey),
      viaTrustedProxy: ctx.viaTrustedProxy,
      strictCsrfOk: () => strictCsrfOk(req, ctx.externalOrigin),
      xPwhOk: () => req.headers["x-pwh"] === "1",
      resolveIdentity: async (deadline) => {
        const authDeadlineMs = deriveBudget(deadline.remaining(), LAN_AUTH_CAP_MS, LAN_AUTH_RESERVE_MS);
        const authFailure: { code?: string } = {};
        const session = await requireLanSession(rt, req, res, ctx, false, lease, authDeadlineMs, authFailure);
        if (session === undefined) {
          const code = authFailure.code;
          return { ok: false, code: code === "E_RATE" || code === "E_DB" ? code : "E_AUTH" };
        }
        return { ok: true, id: session.identity };
      },
      readJson,
      sendJson,
      sendError,
    };
    if (await rt.proxy.handle(req, res, method, path, proxyIo)) return;
  }

  if (
    rt.sessions !== undefined &&
    (await rt.sessions.handle(req, res, method, path, {
      listener: "lan",
      ip: ctx.clientIp,
      xPwhOk: () => req.headers["x-pwh"] === "1",
      csrfOkLan: () => csrfOkLan(req, ctx),
      requireLanSession: async (deadline) => {
        const session = await requireLanSession(rt, req, res, ctx, false, lease, deadline.remaining());
        return session === undefined
          ? { handled: true }
          : { userId: session.userId, sidHash: session.identity.sidTag, user: `u${session.userId}` };
      },
      readJson,
      sendJson,
      clearCookie: (res) =>
        res.setHeader("Set-Cookie", formatLanCookie("", { secure: ctx.scheme === "https", clear: true })),
    }))
  )
    return;

  // sysload plan §7.1/§7.3 (web-hub-load LAN-budget fix): `GET /api/load/top` — dispatched at
  // the same spot as the spawn/preview branches (after headless, before the method branches).
  // The auth budget is derived from `LOAD_TOP_LAN_TOTAL_MS` (an 8s total admission window, same
  // shape as preview/wtdiff below), reserving `LOAD_TOP_DEADLINE_MS` (1.5s) for the scan phase
  // `serveLoadTop` runs afterwards — NOT from `LOAD_TOP_DEADLINE_MS` itself, which would squeeze
  // LAN's IPC-bound auth round-trip down to ~1s and fail it on any real system under load (see
  // `LOAD_TOP_LAN_TOTAL_MS`'s doc comment in `load.ts` for the full before/after).
  if (rt.load !== undefined && method === "GET" && path === LOAD_TOP_PATH) {
    if (req.headers["x-pwh"] !== "1") throw new HttpError(403, "E_CSRF");
    const authDeadlineMs = deriveBudget(LOAD_TOP_LAN_TOTAL_MS, LAN_AUTH_CAP_MS, LOAD_TOP_DEADLINE_MS);
    const authFailure: { code?: string } = {};
    const session = await requireLanSession(rt, req, res, ctx, false, lease, authDeadlineMs, authFailure);
    if (session === undefined) return;
    return serveLoadTop(
      rt.load,
      req,
      res,
      `lan:${session.identity.principal}:load-top`,
      rt.cmdLimit ?? createCmdLimit(rt.now),
    );
  }

  // scheduled-reports H1 (§5.6): `GET /api/schedules` — LAN, same width as loopback (the panel
  // is read-only by design; E3's write restrictions live in the command layer, not here).
  // Snapshot-only (no scan at request time) ⇒ no rate limiter beyond the shared admission.
  if (rt.schedules !== undefined && method === "GET" && path === SCHED_API_PATH) {
    if (req.headers["x-pwh"] !== "1") throw new HttpError(403, "E_CSRF");
    const authDeadlineMs = deriveBudget(8_000, LAN_AUTH_CAP_MS, 1_000);
    const session = await requireLanSession(rt, req, res, ctx, false, lease, authDeadlineMs);
    if (session === undefined) return;
    return serveSchedules(rt.schedules, res, query, sendJson);
  }

  // web-hub-version plan §3.9: `GET /api/version` — LAN, same width as loopback (D3). Absent
  // `versionInfo` ⇒ falls through to the original 404/401 matrix.
  if (rt.versionInfo !== undefined && method === "GET" && path === VERSION_INFO_PATH) {
    if (req.headers["x-pwh"] !== "1") throw new HttpError(403, "E_CSRF");
    const authDeadlineMs = deriveBudget(8_000, LAN_AUTH_CAP_MS, VERSION_LIMITS.requestMs);
    const authFailure: { code?: string } = {};
    const session = await requireLanSession(rt, req, res, ctx, false, lease, authDeadlineMs, authFailure);
    if (session === undefined) return;
    return serveVersionInfo(
      rt.versionInfo,
      rt.ui,
      req,
      res,
      `lan:${session.identity.principal}:version`,
      rt.cmdLimit ?? createCmdLimit(rt.now),
    );
  }

  // web-hub-preview plan v3 §4.5/§4.7 (PV3): `GET /api/preview` — dispatched at the same spot
  // as the spawn branch above (after headless, before the method branches). LAN additionally
  // requires `mode === "on"` (§4.7: `mode:"loopback"` falls through to the original 404,
  // byte-identical to not-enabled — D12). `authorize` mirrors the cmd/dialog branch's LAN
  // segment, but with preview's own §3.1 ② reserve (`PREVIEW_AUTH_RESERVE_MS`: after auth at
  // least 4s of the 8s admission budget must remain for the fs phases).
  if (rt.preview !== undefined && rt.preview.mode === "on" && method === "GET" && path === PREVIEW_PATH) {
    return rt.preview.handle(req, res, query, {
      listener: "lan",
      ip: ctx.clientIp,
      expectedOrigin: ctx.externalOrigin,
      authorize: async (deadline) => {
        const authDeadlineMs = deriveBudget(deadline.remaining(), LAN_AUTH_CAP_MS, PREVIEW_AUTH_RESERVE_MS);
        const authFailure: { code?: string } = {};
        const session = await requireLanSession(rt, req, res, ctx, false, lease, authDeadlineMs, authFailure);
        if (session === undefined) return { handled: true, code: authFailure.code ?? "E_AUTH" };
        return { ip: ctx.clientIp, user: `u${session.userId}` };
      },
      sendJson,
    });
  }

  // web-hub-preview 2026-10-07 修订「先探测后标记」: `POST /api/preview/probe` — the batch
  // existence probe, dispatched right after the preview branch with the IDENTICAL §4.7 LAN
  // gate (`mode === "on"`; `mode:"loopback"` falls through to the original 404, byte-
  // identical to not-enabled) and the same authorize segment (preview's §3.1 ② reserve).
  if (rt.preview !== undefined && rt.preview.mode === "on" && method === "POST" && path === PREVIEW_PROBE_PATH) {
    return rt.preview.handleProbe(req, res, query, {
      listener: "lan",
      ip: ctx.clientIp,
      expectedOrigin: ctx.externalOrigin,
      authorize: async (deadline) => {
        const authDeadlineMs = deriveBudget(deadline.remaining(), LAN_AUTH_CAP_MS, PREVIEW_AUTH_RESERVE_MS);
        const authFailure: { code?: string } = {};
        const session = await requireLanSession(rt, req, res, ctx, false, lease, authDeadlineMs, authFailure);
        if (session === undefined) return { handled: true, code: authFailure.code ?? "E_AUTH" };
        return { ip: ctx.clientIp, user: `u${session.userId}` };
      },
      sendJson,
    });
  }

  // web-hub-html-preview plan v2 §2.1/§4 (P1b): `POST /api/preview/html-cap` — dispatched beside
  // the probe branch with the IDENTICAL gate (`mode === "on"`; the method only exists when the
  // HTML surface is attached). The authorize segment additionally surfaces the session tag and
  // user id the minted capability binds to for revocation.
  if (
    rt.preview !== undefined &&
    rt.preview.mode === "on" &&
    rt.preview.handleHtmlCap !== undefined &&
    method === "POST" &&
    path === PREVIEW_HTML_CAP_PATH
  ) {
    return rt.preview.handleHtmlCap(req, res, query, {
      listener: "lan",
      ip: ctx.clientIp,
      expectedOrigin: ctx.externalOrigin,
      authorize: async (deadline) => {
        const authDeadlineMs = deriveBudget(deadline.remaining(), LAN_AUTH_CAP_MS, PREVIEW_AUTH_RESERVE_MS);
        const authFailure: { code?: string } = {};
        const session = await requireLanSession(rt, req, res, ctx, false, lease, authDeadlineMs, authFailure);
        if (session === undefined) return { handled: true, code: authFailure.code ?? "E_AUTH" };
        const id = session.identity;
        return {
          ip: ctx.clientIp,
          user: id.principal,
          sidTag: id.sidTag,
          ...(id.userId === undefined ? {} : { userId: id.userId }),
        };
      },
      sendJson,
    });
  }

  // @文件补全 (file-mention): `GET /api/files/search` — dispatched right after the preview
  // branch, same insertion point class (after headless/preview, before the method branches) and
  // the same §4.7 LAN gate (`mode === "on"`; `mode:"loopback"` ⇒ the original 404 below,
  // byte-identical). The LAN authorize segment mirrors preview's, but with file-search's own
  // auth reserve (`FILE_SEARCH_AUTH_RESERVE_MS`: at least 2s of the 4s budget survives auth).
  if (rt.fileSearch !== undefined && rt.fileSearch.mode === "on" && method === "GET" && path === FILE_SEARCH_PATH) {
    return rt.fileSearch.handle(req, res, query, {
      listener: "lan",
      ip: ctx.clientIp,
      expectedOrigin: ctx.externalOrigin,
      authorize: async (deadline) => {
        const authDeadlineMs = deriveBudget(deadline.remaining(), LAN_AUTH_CAP_MS, FILE_SEARCH_AUTH_RESERVE_MS);
        const authFailure: { code?: string } = {};
        const session = await requireLanSession(rt, req, res, ctx, false, lease, authDeadlineMs, authFailure);
        if (session === undefined) return { handled: true, code: authFailure.code ?? "E_AUTH" };
        return { ip: ctx.clientIp, user: `u${session.userId}` };
      },
      sendJson,
    });
  }

  if (rt.commandComplete !== undefined && method === "POST" && path === COMMAND_COMPLETE_PATH) {
    return rt.commandComplete.handle(req, res, {
      listener: "lan",
      ip: ctx.clientIp,
      expectedOrigin: ctx.externalOrigin,
      strictCsrfOk: () => strictCsrfOk(req, ctx.externalOrigin),
      authorize: async (deadline) => {
        const authDeadlineMs = deriveBudget(deadline.remaining(), LAN_AUTH_CAP_MS, 2_000);
        const failure: { code?: string } = {};
        const session = await requireLanSession(rt, req, res, ctx, false, lease, authDeadlineMs, failure);
        if (session === undefined) return { handled: true, code: failure.code ?? "E_AUTH" };
        return { ip: ctx.clientIp, user: `u${session.userId}` };
      },
      readJson,
      sendJson,
    });
  }

  // worktree-diff plan §1.6/§2.2 (D3): the two worktree-diff GETs — dispatched right after the
  // file-search branch, same insertion-point class and the same LAN gate (`mode === "on"`;
  // `mode:"loopback"` falls through to the original 404 below, byte-identical to not-enabled).
  // The LAN authorize segment mirrors preview's, but with wtdiff's own §1.7 ② reserve
  // (`WTDIFF_AUTH_RESERVE_MS`: after LAN auth at least 5 s of the 8 s admission budget must
  // remain for membership + the three-fd pin).
  if (
    rt.worktreeDiff !== undefined &&
    rt.worktreeDiff.mode === "on" &&
    method === "GET" &&
    (path === WTDIFF_FILES_PATH || path === WTDIFF_FILE_PATH)
  ) {
    const routes = rt.worktreeDiff;
    const io = {
      listener: "lan" as const,
      ip: ctx.clientIp,
      expectedOrigin: ctx.externalOrigin,
      authorize: async (deadline: ReqDeadline): Promise<PreviewAuthResult | PreviewAuthHandled> => {
        const authDeadlineMs = deriveBudget(deadline.remaining(), LAN_AUTH_CAP_MS, WTDIFF_AUTH_RESERVE_MS);
        const authFailure: { code?: string } = {};
        const session = await requireLanSession(rt, req, res, ctx, false, lease, authDeadlineMs, authFailure);
        if (session === undefined) return { handled: true, code: authFailure.code ?? "E_AUTH" };
        return { ip: ctx.clientIp, user: `u${session.userId}` };
      },
      sendJson,
    };
    return path === WTDIFF_FILES_PATH
      ? routes.handleFiles(req, res, query, io)
      : routes.handleFile(req, res, query, io);
  }

  // worktree-graph plan v2 §2.6: the one worktree-graph GET — dispatched right after the wtdiff
  // branch above, same insertion-point class and the same LAN gate (`mode === "on"`;
  // `mode:"loopback"` falls through to the original 404 below, byte-identical to not-enabled).
  // The LAN authorize segment reuses wtdiff's own §1.7 ② reserve (same §2.4 admission budget).
  // wtgraph.files.v1: the commit-files GET rides the SAME branch, LAN gate and authorize segment.
  if (
    rt.worktreeGraph !== undefined &&
    rt.worktreeGraph.mode === "on" &&
    method === "GET" &&
    (path === WTGRAPH_PATH || (path === WTGRAPH_FILES_PATH && rt.worktreeGraph.handleFiles !== undefined))
  ) {
    const graphHandler =
      path === WTGRAPH_FILES_PATH && rt.worktreeGraph.handleFiles !== undefined
        ? rt.worktreeGraph.handleFiles.bind(rt.worktreeGraph)
        : rt.worktreeGraph.handle.bind(rt.worktreeGraph);
    return graphHandler(req, res, query, {
      listener: "lan",
      ip: ctx.clientIp,
      expectedOrigin: ctx.externalOrigin,
      authorize: async (deadline: ReqDeadline): Promise<PreviewAuthResult | PreviewAuthHandled> => {
        const authDeadlineMs = deriveBudget(deadline.remaining(), LAN_AUTH_CAP_MS, WTDIFF_AUTH_RESERVE_MS);
        const authFailure: { code?: string } = {};
        const session = await requireLanSession(rt, req, res, ctx, false, lease, authDeadlineMs, authFailure);
        if (session === undefined) return { handled: true, code: authFailure.code ?? "E_AUTH" };
        return { ip: ctx.clientIp, user: `u${session.userId}` };
      },
      sendJson,
    });
  }

  // web-hub-delete-session plan v2 §2.9/§4.1: `POST /api/agents/remove` — same insertion point
  // class as headless/preview/file-search above (after every GET-shaped special route, before
  // the generic `POST` branch). `authorize` copies the `/api/cmd` LAN segment verbatim (single
  // auth, same as stop).
  if (rt.agentRemove !== undefined && method === "POST" && path === AGENT_REMOVE_PATH) {
    return rt.agentRemove.handle(req, res, {
      listener: "lan",
      ip: ctx.clientIp,
      strictCsrfOk: () => strictCsrfOk(req, ctx.externalOrigin),
      authorize: async (deadline) => {
        const authDeadlineMs = deriveBudget(deadline.remaining(), LAN_AUTH_CAP_MS, LAN_AUTH_RESERVE_MS);
        const authFailure: { code?: string } = {};
        const session = await requireLanSession(rt, req, res, ctx, false, lease, authDeadlineMs, authFailure);
        if (session === undefined) return { handled: true, code: authFailure.code ?? "E_AUTH" };
        return { ip: ctx.clientIp, user: `u${session.userId}` };
      },
      readJson,
      sendJson,
      sendError,
      HttpError,
    });
  }

  // web-hub-avatar plan v2.1 §2.1: the route owns its auth/CSRF/body pipeline;
  // this dispatch point is deliberately immediately before the generic POST branch.
  if (
    rt.avatar !== undefined &&
    ((method === "GET" && path === AVATAR_PATH) ||
      (method === "POST" && path === AVATAR_PATH) ||
      (method === "POST" && path === AVATAR_DELETE_PATH))
  ) {
    const avatarPath = path === AVATAR_DELETE_PATH ? AVATAR_DELETE_PATH : AVATAR_PATH;
    return rt.avatar.handle(req, res, avatarPath, {
      listener: "lan",
      ip: ctx.clientIp,
      expectedOrigin: ctx.externalOrigin,
      authorize: async (deadline) => {
        const authDeadlineMs = deriveBudget(deadline.remaining(), LAN_AUTH_CAP_MS, AVATAR_STORE_MIN_MS);
        const authFailure: { code?: string } = {};
        const session = await requireLanSession(rt, req, res, ctx, false, lease, authDeadlineMs, authFailure);
        if (session === undefined) return { handled: true, code: authFailure.code ?? "E_AUTH" };
        return { ip: ctx.clientIp, user: `u${session.userId}` };
      },
      sendJson,
    });
  }

  // web-hub-privacy plan v2.1 (P1): `/api/privacy/verify` + `/api/privacy/lock` on the LAN
  // listener (loopback mounts only `lock` — see handleApi below). Same insertion point class as
  // avatar above (immediately before the generic POST branch); the route owns its own
  // CSRF/body/audit pipeline, the authorize closure mirrors the avatar segment but ALSO yields
  // the session's numeric userId (the `verifyPassword` pipeline's starting point, plan「校验
  // 管线」: 会话取 userId → getUserSummary → getUser → 共用 KDF admission).
  if (rt.privacy !== undefined && method === "POST" && (path === PRIVACY_VERIFY_PATH || path === PRIVACY_LOCK_PATH)) {
    const io: PrivacyRouteIo = {
      listener: "lan",
      ip: ctx.clientIp,
      strictCsrfOk: () => strictCsrfOk(req, ctx.externalOrigin),
      authorize: async (deadline) => {
        const authDeadlineMs = deriveBudget(deadline.remaining(), LAN_AUTH_CAP_MS, LAN_AUTH_RESERVE_MS);
        const authFailure: { code?: string } = {};
        const session = await requireLanSession(rt, req, res, ctx, false, lease, authDeadlineMs, authFailure);
        if (session === undefined) return { handled: true, code: authFailure.code ?? "E_AUTH" };
        return { ip: ctx.clientIp, user: `u${session.userId}`, userId: session.userId };
      },
      readJson,
      sendJson,
      sendError,
      HttpError,
    };
    return path === PRIVACY_VERIFY_PATH ? rt.privacy.handleVerify(req, res, io) : rt.privacy.handleLock(req, res, io);
  }

  if (method === "POST") {
    if (path === "/api/cmd" || path === "/api/dialog") {
      return dispatchCmdOrDialog(req, res, path, {
        listener: "lan",
        ip: ctx.clientIp,
        strictCsrfOk: () => strictCsrfOk(req, ctx.externalOrigin),
        authorize: async (deadline) => {
          const authDeadlineMs = deriveBudget(deadline.remaining(), LAN_AUTH_CAP_MS, LAN_AUTH_RESERVE_MS);
          const authFailure: { code?: string } = {};
          const session = await requireLanSession(rt, req, res, ctx, false, lease, authDeadlineMs, authFailure);
          if (session === undefined) return { handled: true, code: authFailure.code ?? "E_AUTH" };
          return { ip: ctx.clientIp, user: `u${session.userId}` };
        },
        registry: rt.registry ?? { list: () => [], get: () => undefined },
        commands: rt.commands,
        uploads: rt.uploads,
        limit: rt.cmdLimit ?? createCmdLimit(rt.now),
        rejectAudit429: rt.rejectAudit429 ?? new Map(),
        log: rt.log,
        now: rt.now,
      });
    }
    // web-hub-upload plan §1.2/§5.1 (U3): /api/upload/* — the same write-endpoint pipeline shape
    // as /api/cmd (strict CSRF — `uploadCsrfOk` for octet-stream chunk bodies — double
    // authorize, per-principal bucket); inserted before the generic `csrfOkLan` gate exactly like
    // the cmd/dialog branch above. authorize copies the :cmd segment, except a CHUNK request's
    // first authorize keeps `UPLOAD_TOTAL_MS - LAN_AUTH_CAP_MS` (11s) in reserve for body+write
    // (§1.3) and its post-body reauth shares the final ~1s with the write.
    if (path.startsWith("/api/upload/")) {
      let authCalls = 0;
      return handleUploadRequest(req, res, path, query, {
        listener: "lan",
        ip: ctx.clientIp,
        csrfOk: (kind) =>
          kind === "chunk" ? uploadCsrfOk(req, ctx.externalOrigin) : strictCsrfOk(req, ctx.externalOrigin),
        authorize: async (deadline) => {
          authCalls += 1;
          const reserve =
            path !== UPLOAD_CHUNK_PATH
              ? LAN_AUTH_RESERVE_MS
              : authCalls === 1
                ? UPLOAD_TOTAL_MS - LAN_AUTH_CAP_MS
                : UPLOAD_CHUNK_REAUTH_RESERVE_MS;
          const authDeadlineMs = deriveBudget(deadline.remaining(), LAN_AUTH_CAP_MS, reserve);
          const authFailure: { code?: string } = {};
          const session = await requireLanSession(rt, req, res, ctx, false, lease, authDeadlineMs, authFailure);
          if (session === undefined) return { handled: true, code: authFailure.code ?? "E_AUTH" };
          return { ip: ctx.clientIp, user: `u${session.userId}` };
        },
        registry: rt.registry ?? { list: () => [], get: () => undefined },
        store: rt.uploads,
        metrics: rt.uploadMetrics,
        limit: rt.cmdLimit ?? createCmdLimit(rt.now),
        rejectAudit429: rt.rejectAudit429 ?? new Map(),
        log: rt.log,
        now: rt.now,
        io: { readBody, sendJson },
      });
    }
    if (!csrfOkLan(req, ctx)) throw new HttpError(403, "E_CSRF");
    if (
      path === "/api/login" ||
      (rt.lan.secondFactorEnabled === true && (path === LAN_2FA_PATH || path === LAN_2FA_CANCEL_PATH))
    ) {
      await handleLanLogin(rt, req, res, ctx, lease, path);
      return;
    }
    if (path === "/api/logout") {
      // §4.1 (XA): logout targets come from the same cookie module as authentication — legacy
      // (max 1) = the first `pwh_lan` value, whether or not it is still a valid session; in
      // multi-candidate mode every distinct candidate is logged out (a logout must never be
      // refused by a conflict).
      for (const sid of cookieCandidates(req.headers.cookie, LAN_SESSION_COOKIE, rt.lanCookieMax ?? 1).values) {
        const sidHash = hashSid(sid);
        // web-hub-html-preview plan v2 §2.4: this session's HTML capabilities die with it —
        // revoked BEFORE the awaited delete (a logout never leaves a window where the caps
        // outlive the intent) and again after it (a mint whose authorize ran inside that window
        // still carries `sidHash`; the second bump catches it). Bus emits (XA §4.2), same
        // positions/order as the former direct hook calls.
        rt.authRevoke.emit({ sel: { sidTag: sidHash }, reason: "logout" });
        try {
          await rt.lan.store.deleteSession(sidHash);
          rt.authRevoke.emit({ sel: { sidTag: sidHash }, reason: "logout" });
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
    // fleet-drawer plan §3.4/§5.4 (F4): run-transcript subscribe/unsubscribe — inside the same
    // `csrfOkLan` + `requireLanSession` pipeline as the agent-level ones above.
    if (path === "/api/run/subscribe") return rt.routes.runSubscribe(body, res);
    if (path === "/api/run/unsubscribe") return rt.routes.runUnsubscribe(body, res);
    throw new HttpError(404, "E_NOT_FOUND");
  }

  if (method === "GET") {
    if (path === LAN_2FA_WAIT_PATH && rt.lan.secondFactorEnabled === true) {
      if (req.headers["x-pwh"] !== "1") throw new HttpError(403, "E_CSRF");
      await handleLanLogin(rt, req, res, ctx, lease, path);
      return;
    }
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
      const client = rt.routes.openEvents(req, res, {
        sidHash: session.sidHash,
        userId: session.userId,
        epoch: session.epoch,
        boundOrigin: ctx.externalOrigin,
        verifiedAt: rt.now(),
      });
      // §4.2 review fix (LC #1): a db-independent hard ceiling — cleared on the connection's own
      // `close` (natural disconnect, logout/passwd revoke, or the 55s tick's own "expired" revoke).
      rt.sseClientIps?.set(client, ctx.clientIp);
      scheduleAbsoluteExpiry(rt, client, session.absoluteExpiresAt);
      res.once("close", () => clearAbsoluteExpiry(rt, client.id));
      return;
    }
    if (path === "/api/history") {
      const session = await requireLanSession(rt, req, res, ctx, false, lease);
      if (session === undefined) return;
      await rt.routes.historyPage(query, res);
      return;
    }
    if (path === "/api/run/history") {
      const session = await requireLanSession(rt, req, res, ctx, false, lease);
      if (session === undefined) return;
      await rt.routes.runHistoryPage(query, res);
      return;
    }
  }

  throw new HttpError(404, "E_NOT_FOUND");
}

export function handleLanRequest(
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
    rt.log.error("web-hub lan http: request failed", requestFailedFields(req, err));
    if (!res.headersSent) sendError(res, 500, "E_INTERNAL");
    else res.destroy();
  });
}
