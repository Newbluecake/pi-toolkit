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
 * Every JSON body leaves through ONE exit — `sendJson` (delegating to `gzip.ts`'s negotiation):
 * a ≥2 KiB body for a client offering gzip (q>0) is compressed on the thread pool and answered
 * with `Content-Encoding: gzip` + `Vary: Accept-Encoding`; everything else is byte-identical
 * identity. SSE frames never pass through it (flush semantics), and the static UI keeps its own
 * compress-once cache in `static.ts`.
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
import {
  API_ERRORS,
  AGENT_REMOVE_PATH,
  LOAD_TOP_PATH,
  type AgentCard,
  type HistoryPayload,
} from "../protocol/http-contract.js";
import { canonicalHostKey, canonicalOrigin, classifyHostToken, parseOrigin } from "../protocol/lan.js";
import type { CmdOp, FleetRowWire } from "../protocol/messages.js";
import { TIMING } from "../protocol/messages.js";
import { createAuth, SESSION_COOKIE, LOGIN_WINDOW_MS } from "./auth.js";
import {
  clearingSetCookies,
  cookieCandidates,
  COOKIE_CONFLICT_REASON,
  LAN_COOKIE_MAX,
  lanIdentity,
  lanRecordValid,
  loopbackIdentity,
  LOOPBACK_COOKIE_MAX,
  resolveCookieIdentity,
  type AuthIdentity,
  type IdentityResult,
  type LanSessionResult,
} from "./auth-identity.js";
import { createAuthRevokeBus, type AuthRevokeBus } from "./auth-revoke.js";
import type { UploadHttpMetrics } from "./audit.js";
import { createCmdLimit, type CmdLimit } from "./cmd-limit.js";
import { createConnGuard } from "./conn-guard.js";
import { COMMAND_COMPLETE_PATH } from "../protocol/http-contract.js";
import type { CommandCompleteRoutes } from "./command-complete.js";
import { createFileSearchRoutes, FILE_SEARCH_AUTH_RESERVE_MS, FILE_SEARCH_PATH } from "./file-search.js";
import type { AgentRemoveFrontendPort, AgentRemoveIo } from "./agent-remove.js";
import { formatLanCookie, hashSid, LAN_SESSION_COOKIE } from "./lan-auth.js";
import { Value } from "@sinclair/typebox/value";
import { createLanSessionsRoutes } from "./lan-sessions.js";
import type { LanSessionsRoutes } from "./ports.js";
import { createKdfUpgrader } from "./kdf-upgrade.js";
import { effectiveWriteTarget } from "./kdf.js";
import { createLanLoginCore } from "./lan-login.js";
import { createSecurityEventBus } from "./security-events.js";
import {
  LAN_2FA_COOKIE,
  LAN_2FA_PATH,
  LAN_2FA_WAIT_PATH,
  LAN_2FA_CANCEL_PATH,
  LanFactorBodySchema,
  normalizeRecoveryCode,
} from "../protocol/lan-2fa.js";
import type { LanLoginCore, LoginIo, LoginReply } from "./ports.js";
import { sameHostKeys } from "./net-hosts.js";
import { UPLOAD_CHUNK_PATH, UPLOAD_TOTAL_MS } from "../protocol/upload.js";
import { PREVIEW_PATH, PREVIEW_PROBE_PATH } from "../protocol/preview.js";
import { PREVIEW_HTML_CAP_PATH, PV_PREFIX, PVW_PREFIX } from "../protocol/preview-html.js";
import { VERSION_INFO_PATH, VERSION_LIMITS } from "../protocol/version-info.js";
import { AVATAR_DELETE_PATH, AVATAR_PATH, AVATAR_STORE_MIN_MS } from "../protocol/avatar.js";
import { PROXY_LIST_PATH, PROXY_OPEN_PATH, PROXY_STOP_PATH } from "../protocol/proxy.js";
import { PRIVACY_LOCK_PATH, PRIVACY_VERIFY_PATH } from "../protocol/privacy.js";
import type { SpawnsPayload } from "../protocol/spawn.js";
import { handleUploadRequest } from "./upload-http.js";
import { sendJsonNegotiated } from "./gzip.js";
import { dispatchCmdOrDialog } from "./http-cmd.js";
import { createLanTransport } from "./http-lan.js";
import type { UploadStore } from "./uploads.js";
import type { SpawnFrontendPort } from "./spawn/ports.js";
import { errCode, isPvLogUrl, redactLogUrl } from "./preview/pv-path.js";
import { PREVIEW_AUTH_RESERVE_MS } from "./preview/routes.js";
import { WTDIFF_AUTH_RESERVE_MS } from "./worktree-diff/routes.js";
import { WTDIFF_FILES_PATH, WTDIFF_FILE_PATH } from "../protocol/worktree-diff.js";
import { SCHED_API_PATH, SCHED_SESSION_ID_RE, type SchedulesPayloadWire } from "../protocol/schedule.js";
import type { ScheduleCoordinator } from "./schedule/service.js";
import { WTGRAPH_PATH } from "../protocol/worktree-graph.js";
import {
  createHubLoad,
  loadTopErrorCode,
  LOAD_TOP_DEADLINE_MS,
  LOAD_TOP_LAN_TOTAL_MS,
  type HubLoadService,
} from "./load.js";
import type {
  AgentView,
  AvatarRoutes,
  CommandRouter,
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
  LanOffReason,
  LanSessionRecord,
  LanStatus,
  ListenerKind,
  FileSearchRoutes,
  PreviewRoutes,
  VersionInfoPort,
  PreviewAuthHandled,
  PreviewAuthResult,
  PrivacyRouteIo,
  PrivacyRoutes,
  ProxyRouteIo,
  ProxyRoutes,
  WorktreeDiffRoutes,
  WorktreeGraphRoutes,
  RegistryView,
  RequestContext,
  RunSink,
  RunTranscriptService,
} from "./ports.js";
import {
  deadlineRace,
  deriveBudget,
  LAN_AUTH_CAP_MS,
  LAN_AUTH_RESERVE_MS,
  raceDeadline,
  type ReqDeadline,
} from "./req-deadline.js";
import { combineRunSinks, createRunRoutes } from "./run-routes.js";
import { createSseHub, type SseClient, type SseEventName, type SseHub } from "./sse.js";
import { createUiServer, type CreateUiServerOptions, type UiServer } from "./static.js";
import { buildUiCandidates } from "./ui-root.js";

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
/** Link-preview §2.4: only proxy-on widens what the hub may embed, never who may embed the hub. */
export function hubCsp(range?: readonly [number, number]): string {
  if (range === undefined) return CSP;
  const sources = Array.from({ length: range[1] - range[0] + 1 }, (_, i) => `http://*:${range[0] + i}`);
  return CSP.replace("frame-ancestors 'none'", `frame-src 'self' ${sources.join(" ")}; frame-ancestors 'none'`);
}
export const MAX_BODY_BYTES = 64 * 1024;
export const LAN_LOGIN_BODY_BYTES = 4 * 1024;
export const HISTORY_PAGE_MAX = 400;
const BODY_DEADLINE_MS = 10_000;
/** Outer guard on history calls; B enforces TIMING.snapshotMs itself, this only bounds a misbehaving port. */
const HISTORY_GUARD_MS = TIMING.snapshotMs + 1_000;
export const CLOSE_DEADLINE_MS = 2_000;
const MAX_PENDING_FRAMES = 4_096;
const BIND_HOST = "127.0.0.1"; // not configurable by design (arch §9)
const LAN_REQUEST_TIMEOUT_MS = 15_000;
/** §3.3 nesting invariant (C3 acceptance): both listeners' Node HTTP `requestTimeout` share this
 * one value — `srv.requestTimeout` below (loopback) and `LAN_REQUEST_TIMEOUT_MS` (LAN) must never
 * drift apart, since `deadline-nesting.test.ts` asserts `WRITE_TOTAL_MS(13s) < LAN_REQUEST_TIMEOUT_MS
 * (15s) < ui/*-client.js's CMD_REQUEST_TIMEOUT_MS (16s, the browser fetch AbortController)`. */
export { LAN_REQUEST_TIMEOUT_MS };
/** web-hub-upload plan §1.3 (U3): a LAN chunk request's SECOND authorize (after the body read)
 * shares the final ~1s of `UPLOAD_TOTAL_MS` with the disk write — its `touchSession` race keeps
 * only this much in reserve for the write (the first authorize keeps `UPLOAD_TOTAL_MS -
 * LAN_AUTH_CAP_MS` = 11s). */
const UPLOAD_CHUNK_REAUTH_RESERVE_MS = 300;
const LAN_CLIENT_IP_INFLIGHT_CAP = 16;
const LAN_SID_WAITERS_CAP = 8;
const LAN_SSE_GLOBAL_CAP = 32;
const LAN_SSE_PER_SID_CAP = 8;
const LAN_RECOMPUTE_THROTTLE_MS = 5_000;
const LAN_TICK_MS = 60_000;
// Review fix (LC, plan §1.4/§3, W3 acceptance item 1): `LanFacade.start()` is specified to be
// bounded by `LAN_START_DEADLINE_MS` (plan's own `lan-controller.ts` sketch defines it as
// 30_000ms; §15.8 moved the actual implementation into this file's self-hosted lifecycle without
// changing the budget). Exported so tests can drive it with `vi.useFakeTimers()` the same way
// `hub.ts`'s `HUB_START_DEADLINE_MS` contract tests do, instead of waiting out 30 real seconds.
export const LAN_START_DEADLINE_MS = 30_000;
// §4.2 "SSE 到期复核" (LC review fix, lan-plan.md §15.9 #3): a periodic (≤60s) recheck of every
// LAN SSE connection's session, independent of the ping-only keepalive `sse.ts` already does.
const LAN_SSE_EXPIRY_TICK_MS = 55_000;
const LAN_SSE_EXPIRY_BATCH_CAP = 32;
const LAN_SSE_EXPIRY_BATCH_DEADLINE_MS = 20_000;
// §4.2 review fix (lan-plan.md task LC #1): the 55s tick above depends on the db being reachable
// (`touchSession`); while the db is down it can't revoke anything, so a per-connection local
// timer keyed off the session's own `absoluteExpiresAt` (7-day hard ceiling) is the only thing
// that still fires. `setTimeout`'s delay is a signed 32-bit int (~24.8 days) — well above the
// 7-day ceiling in practice, but `scheduleAbsoluteExpiry` still segments a longer remaining span
// defensively rather than silently truncating it.
const ABS_EXPIRY_MAX_DELAY_MS = 2_147_483_647;

/** Host part of a Host header / host key without the port; keeps an IPv6 literal's brackets
 * (`[::1]:7878` ⇒ `[::1]`, `127.0.0.1:7878` ⇒ `127.0.0.1`). */
function proxyBrowserHost(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? "" : host.slice(0, end + 1);
  }
  return host.split(":")[0] ?? "";
}
export function toAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "web-hub: aborted");
}

type ApiError = (typeof API_ERRORS)[number];

export class HttpError extends Error {
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
    case "E_DIR": // web-hub-spawn arch §8.2: admit rejection ⇒ 400 (reason rides the body)
      return 400;
    case "E_AUTH":
      return 401;
    case "E_CSRF":
    case "E_SPAWN_DENIED": // web-hub-spawn arch §8.2: policy/platform refusal, no record created
    case "E_PROXY_DENIED": // web-hub-proxy §3.8: address-class refusal (the route answers its own 400s explicitly)
      return 403;
    case "E_NOT_FOUND":
      return 404;
    case "E_AGENT_GONE":
      return 410;
    case "E_HOST":
      return 421;
    case "E_RATE":
      return 429;
    case "E_LIMIT": // web-hub-spawn arch §6.5: resource limits exhausted ⇒ 409
      return 409;
    case "E_LAUNCHER": // web-hub-spawn arch §6.5: launcher/persist/reaper/breaker ⇒ 503
    case "E_PROXY_UNAVAILABLE": // web-hub-proxy §3.8: ports store / busy / closing (409 reverse-proxy is explicit)
      return 503;
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
  return deadlineRace(p, ms, () => Object.assign(new Error("E_DEADLINE"), { code: "E_DEADLINE" }));
}

/**
 * web-hub-html-preview plan v2 §2.6: the three HTTP fallback error logs used to carry the raw
 * `req.url` + `String(err)`. For `/pv/<cap>/…` and `/pvw/<cap>` the URL IS the credential and an
 * fs error message carries paths, so those two fields are redacted (`/pv/[redacted]`, error code
 * only). Every other URL keeps the exact original fields.
 */
export function requestFailedFields(req: IncomingMessage, err: unknown): { url: string | undefined; error: string } {
  const url = req.url;
  if (url !== undefined && isPvLogUrl(url)) return { url: redactLogUrl(url), error: errCode(err) };
  return { url, error: String(err) };
}

export function setSecurityHeaders(res: ServerResponse, csp = CSP): void {
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  // gzip.ts's unified negotiation point for EVERY /api JSON body (this same function instance is
  // injected into the spawn/preview/file-search/agent-remove/upload route modules below): identity
  // responses are byte-identical to the pre-gzip behavior; a ≥2 KiB body for a client offering
  // gzip (q>0) is compressed on the thread pool with Content-Encoding/Vary and a post-compression
  // Content-Length. SSE (`sse.ts`) never passes through here — its flush semantics stay untouched.
  sendJsonNegotiated(res, status, body, headers);
}

export function sendError(res: ServerResponse, status: number, code: string, message?: string): void {
  sendJson(res, status, message === undefined ? { error: code } : { error: code, message });
}

export function field(body: unknown, name: string): unknown {
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined;
}

export function stringField(body: unknown, name: string): string | undefined {
  const v = field(body, name);
  return typeof v === "string" && v.length > 0 && v.length <= 256 ? v : undefined;
}

export function readBody(
  req: IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
  maxMs: number = BODY_DEADLINE_MS,
): Promise<Buffer> {
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
    const timer = setTimeout(() => finish(new HttpError(408, "E_DEADLINE", "body read timeout")), Math.max(0, maxMs));
    timer.unref?.();
    req.on("data", onData);
    req.once("end", () => finish(undefined));
    req.once("error", () => finish(new HttpError(400, "E_BAD_REQUEST", "request error")));
    req.once("aborted", () => finish(new HttpError(400, "E_BAD_REQUEST", "request aborted")));
  });
}

export async function readJson(req: IncomingMessage, maxBytes?: number, maxMs?: number): Promise<unknown> {
  const buf = await readBody(req, maxBytes, maxMs);
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
  if (v.control !== undefined) card.control = v.control;
  if (v.epoch !== undefined) card.epoch = v.epoch;
  if (v.dialogs !== undefined) card.dialogs = v.dialogs;
  // accfix-N2 (acc32-B1 same-shape residual): `commands` was left out of this copy — a browser
  // tab that attaches (fresh page, reconnect, or a second tab) after the agent already sent its
  // `commands` slot got a snapshot with no `commands` field at all, so it stayed in plain-prompt
  // mode (no palette on `/`) until something else (e.g. the agent's own `/reload`) happened to
  // resend a live `commands` SSE event.
  if (v.commands !== undefined) card.commands = v.commands;
  // web-hub-upload plan U1 #10: toCard() is a whitelist copy — upload/uploadLan must be listed
  // here explicitly or a browser that (re)attaches never sees them on the fleet snapshot.
  if (v.upload !== undefined) card.upload = v.upload;
  if (v.uploadLan !== undefined) card.uploadLan = v.uploadLan;
  // fleet-drawer plan §5.3 (F3b): same whitelist rule — runTranscript/runTranscriptLan ride the
  // initial `agents` snapshot (this copy), `agent_up`, and reconnect paths; registry's card()
  // always sets them (false for a pre-F2 agent), so the copy is unconditional-in-practice.
  if (v.runTranscript !== undefined) card.runTranscript = v.runTranscript;
  if (v.runTranscriptLan !== undefined) card.runTranscriptLan = v.runTranscriptLan;
  // web-hub-steer-recall plan §2.3 S4: same whitelist rule — registry's card() only ever sets
  // `hold` to `true` (never false), so the copy keeps the "absent = feature off" wire shape.
  if (v.hold !== undefined) card.hold = v.hold;
  return card;
}

// ---------------------------------------------------------------------------
// §1.4.4 buildContext / createLanTransport
// ---------------------------------------------------------------------------

/** `::ffff:1.2.3.4` → `1.2.3.4` (IPv4-mapped IPv6, as node's `net`/`http` report dual-stack peers). */
export function normalizePeerIp(ip: string | undefined): string {
  if (ip === undefined) return "";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

type BuildContextReject = { reject: 400 | 421; code: "E_BAD_REQUEST" | "E_HOST"; detail: string };

function buildLanContext(
  req: IncomingMessage,
  lan: { snapshot: HostSnapshot; trust: ReadonlySet<string> },
): RequestContext | BuildContextReject {
  const peerIp = normalizePeerIp(req.socket.remoteAddress);
  const resolution = resolveProxyLocal(peerIp, req.headers, lan.trust);
  if (resolution.viaTrustedProxy && resolution.warnings.includes("proto-invalid")) {
    return { reject: 400, code: "E_BAD_REQUEST", detail: "proxy-proto" };
  }
  if (resolution.viaTrustedProxy && resolution.warnings.includes("host-multi")) {
    return { reject: 400, code: "E_BAD_REQUEST", detail: "proxy-host" };
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
    xffUsable: !resolution.warnings.some(
      (w) => w === "xff-missing" || w === "xff-malformed" || w === "xff-all-trusted",
    ),
    ua: req.headers["user-agent"] ?? "",
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
import { tagClientAllowGuard } from "./client-allow.js";
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

// ---------------------------------------------------------------------------
// shared route set (agents / fleet / history / SSE) — used by both listeners
// ---------------------------------------------------------------------------

interface RouteSet {
  pending: Map<string, Map<string, PendingSub>>;
  fleetCache: Map<string, FleetRowWire[]>;
  onHubEvent(e: HubEvent): void;
  /** scheduled-reports H1 (§5.6): direct-send the schedule projection to every client of THIS
   *  listener (no `id:`, never the replay ring — the connect burst carries the snapshot). */
  onSchedules(payload: SchedulesPayloadWire): void;
  subscribe(body: unknown, res: ServerResponse): void;
  unsubscribe(body: unknown, res: ServerResponse): void;
  openEvents(req: IncomingMessage, res: ServerResponse, auth?: SseClient["auth"]): SseClient;
  historyPage(query: URLSearchParams, res: ServerResponse): Promise<void>;
  /** fleet-drawer plan §5.4 (F4): the run-transcript routes — 404-shaped stubs when no service
   * was wired (`deps.runTx` absent), byte-identical to a hub without the channel. */
  runSubscribe(body: unknown, res: ServerResponse): void;
  runUnsubscribe(body: unknown, res: ServerResponse): void;
  runHistoryPage(query: URLSearchParams, res: ServerResponse): Promise<void>;
  /** F4: this listener's run-route sink; combined by `createHttpFrontend` into the single
   * `runTx.setSink` slot. `undefined` when no run-transcript service was wired. */
  runSink: RunSink | undefined;
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
    /** web-hub-spawn plan §SP9 (arch §6.4/§8.2): this listener's `spawns` SSE snapshot —
     * `undefined` (deps.spawn absent, or LAN policy `off`) means the listener never sends a
     * `spawns` frame, byte-identical to the not-enabled matrix. Also doubles as the live-push
     * gate in `onHubEvent`'s `case "spawns"`. */
    spawns?: () => SpawnsPayload | undefined;
    /** fleet-drawer plan §5.4 (F4): this listener's identity — decides the cap requirement
     * (`runtx.v1` vs `runtx.v1`+`runtx.lan.v1`) and the run-watch ref prefix of its routes. */
    listener: ListenerKind;
    now: () => number;
    /** F4: the run-transcript service (F3b). Absent ⇒ `/api/run/*` answers 404 and no run SSE
     * event is ever sent — byte-identical to a hub without the channel. */
    runTx?: RunTranscriptService;
    /** sysload P3: latest host snapshot, sent after the spawns snapshot and never replayed. */
    load?: () => import("../protocol/messages.js").LoadWire | undefined;
    /** web-hub-privacy plan v2.1 (P1): this listener's locked-sessionId snapshot provider —
     * present ONLY when the privacy feature is assembled (`FrontendDeps.privacy`). The connect
     * burst sends the full set BEFORE `agents` (fail-closed anchor: a client holding the
     * `privacy.v1` cap waits for exactly this frame), and `onHubEvent`'s `case "privacy"`
     * direct-sends every change (never the replay ring, never an `id:`). Absent ⇒ no `privacy`
     * frame is ever sent, byte-identical to not-enabled. */
    privacy?: () => readonly string[];
    /** scheduled-reports H1 (§5.6): this listener's schedule-projection snapshot — sent in the
     * connect burst right AFTER `load`, and live-pushed via `RouteSet.onSchedules` (fingerprint
     * gated by the coordinator itself). Absent (config.schedule off ⇒ no coordinator) ⇒ no
     * `schedules` frame is ever sent, byte-identical to not-enabled. */
    schedules?: () => SchedulesPayloadWire | undefined;
  },
): RouteSet {
  const pending = new Map<string, Map<string, PendingSub>>();
  const fleetCache = new Map<string, FleetRowWire[]>();
  // F4 (fleet-drawer §5.4): one run-route instance per listener; the sink it exposes is
  // combined with the other listener's by `createHttpFrontend` (the service's `setSink` is a
  // single slot) — construction here, installation there.
  const runRoutes =
    routeDeps.runTx === undefined
      ? undefined
      : createRunRoutes(sse, {
          listener: routeDeps.listener,
          registry: routeDeps.registry,
          runTx: routeDeps.runTx,
          log: routeDeps.log,
          isClosed: routeDeps.isClosed,
          now: routeDeps.now,
        });

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

  function onSchedules(payload: SchedulesPayloadWire): void {
    // Direct-send, same posture as `load`/`privacy`: no id, no replay ring.
    for (const client of sse.list()) client.send("schedules", payload);
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
        // web-hub-delete-session plan v2 §2.3/§4.3 (r1 #4): a card was deleted — the EXACT order
        // matters (dropAgent BEFORE clearing scoped subscriptions BEFORE the broadcast) so that
        // a client still subscribed to this agentKey never receives an `ev`/`append` for it
        // after this point; the eventual `spawns` push (queued separately, supervisor-side) no
        // longer carries the record either way.
        case "agent_removed":
          dropAgent(e.agentKey);
          for (const c of sse.list()) c.subscribed.delete(e.agentKey);
          sse.publish("agent_removed", { agentKey: e.agentKey });
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
        // control-plane P2 slots/broadcasts (ports.ts's HubEvent doc comment: "http.ts 的 onHubEvent
        // 需要转发为 SSE" — registry.ts publishes these (dialogs/ctl/commands/cmd_late) but this
        // switch never forwarded them, so a subscribed browser never saw a live ask_user dialog /
        // command ledger / late steer settlement open or change (only the subscribe-time snapshot
        // via AgentCard.dialogs) even though the frontend reducer (`logic/state.js`) already has a
        // `case "dialogs"`/`"ctl"`/`"commands"`/`"cmd_late"` waiting for exactly this event name).
        case "dialogs":
          sse.publish("dialogs", { agentKey: e.agentKey, epoch: e.epoch, open: e.open, closed: e.closed });
          break;
        case "ctl":
          sse.publish("ctl", { agentKey: e.agentKey, epoch: e.epoch, sessionId: e.sessionId, items: e.items });
          break;
        case "commands":
          sse.publish("commands", { agentKey: e.agentKey, epoch: e.epoch, items: e.items });
          break;
        case "cmd_late":
          sse.publish("cmd_late", {
            agentKey: e.agentKey,
            id: e.id,
            op: e.op,
            ok: e.ok,
            ...(e.code === undefined ? {} : { code: e.code }),
            ...(e.data === undefined ? {} : { data: e.data }),
          });
          break;
        // web-hub-spawn plan §SP9 (arch §6.4/§8.2): the supervisor's `spawns` broadcast carries
        // the Public projection only. `routeDeps.spawns?.()` is the LISTENER gate, not the
        // payload: LAN policy `off` ⇒ undefined ⇒ this listener's clients never see a `spawns`
        // frame — byte-identical to the not-enabled matrix row.
        case "spawns": {
          const p = routeDeps.spawns?.();
          if (p !== undefined) sse.publish("spawns", e.payload);
          break;
        }
        case "hub":
          // acc32-B6: mirrors `openEvents`' own connect-time "hub" send below — same shape, so
          // the frontend's `case "hub"` reducer (already written for repeated frames) needs no
          // changes.
          sse.publish("hub", { ...routeDeps.info(), port: routeDeps.port() });
          break;
        case "load":
          // Host load is direct-send: no id and no replay-ring entry.
          for (const client of sse.list()) client.send("load", e.wire);
          break;
        // web-hub-privacy plan v2.1 (P1): the locked-set broadcast is direct-send too (never the
        // replay ring — a reconnecting client gets the full snapshot in its connect burst
        // instead). The `routeDeps.privacy` presence gate mirrors `case "spawns"`: feature off
        // ⇒ this listener never emits a `privacy` frame even if a bus event somehow arrives.
        case "privacy":
          if (routeDeps.privacy !== undefined) {
            for (const client of sse.list()) client.send("privacy", { locked: [...e.locked] });
          }
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
    // web-hub-privacy plan v2.1 (P1): the locked-set snapshot rides the connect burst BEFORE
    // `agents` (plan「锁状态下发」, with spawns/load as the同构 precedent) — a client holding
    // the `privacy.v1` cap fails CLOSED until exactly this frame lands, so it must precede the
    // first card data the UI could render details from.
    const privacyLocked = routeDeps.privacy?.();
    if (privacyLocked !== undefined) client.send("privacy", { locked: [...privacyLocked] });
    client.send("agents", { agents: routeDeps.registry.list().map(toCard) });
    // web-hub-spawn plan §SP9: the `spawns` snapshot rides right after `agents`, so a
    // (re)connecting browser gets the full fleet + spawn-board picture in one connect burst.
    const sp = routeDeps.spawns?.();
    if (sp !== undefined) client.send("spawns", sp);
    // sysload P3: the latest frame is a connect-time snapshot, after spawns. It
    // deliberately bypasses the replay ring and carries no SSE id.
    const load = routeDeps.load?.();
    if (load !== undefined) client.send("load", load);
    // scheduled-reports H1 (§5.6): the projection snapshot rides right after `load` (W1's
    // 「随 agents 重发快照」— reconnecting browsers get the full picture in one connect burst).
    // Same direct-send posture; absent coordinator ⇒ never sent.
    const schedulesWire = routeDeps.schedules?.();
    if (schedulesWire !== undefined) client.send("schedules", schedulesWire);
    for (const [agentKey, runs] of fleetCache) client.send("fleet", { agentKey, runs });
    res.once("close", () => {
      pending.delete(client.id);
      runRoutes?.onClientClose(client.id); // F4: run subs + watch refs die with the SSE conn
    });
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

  return {
    pending,
    fleetCache,
    onHubEvent,
    onSchedules,
    subscribe,
    unsubscribe,
    openEvents,
    historyPage,
    runSubscribe: (body, res) => {
      if (runRoutes === undefined) throw new HttpError(404, "E_NOT_FOUND");
      runRoutes.subscribe(body, res);
    },
    runUnsubscribe: (body, res) => {
      if (runRoutes === undefined) throw new HttpError(404, "E_NOT_FOUND");
      runRoutes.unsubscribe(body, res);
    },
    runHistoryPage: async (query, res) => {
      if (runRoutes === undefined) throw new HttpError(404, "E_NOT_FOUND");
      await runRoutes.historyPage(query, res);
    },
    runSink: runRoutes?.sink,
  };
}

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

/**
 * scheduled-reports H1: `FrontendDeps` carries the schedule coordinator as a duck-typed extra —
 * ports.ts is frozen for this package (same widening pattern as hub.ts's `HttpFrontendExt`).
 * Present ONLY when `config.schedule` exists (hub.ts attaches it); absent ⇒ the whole feature
 * stays byte-identical (no route, no SSE frame, no cap).
 */
type FrontendDepsSchedulesExt = FrontendDeps & { schedules?: ScheduleCoordinator };

/** `GET /api/schedules?sessionId=` — memory-only snapshot (the coordinator's scan loop owns all
 *  IO); same width on both listeners. `Cache-Control: no-store`, X-PWH-gated, auth-gated. */
function serveSchedules(
  coordinator: ScheduleCoordinator,
  res: ServerResponse,
  query: URLSearchParams,
  sendJsonFn: typeof sendJson,
): void {
  const raw = query.get("sessionId");
  let sessionId: string | undefined;
  if (raw !== null) {
    if (!SCHED_SESSION_ID_RE.test(raw)) {
      sendJsonFn(res, 400, { error: "E_BAD_REQUEST" }, { "Cache-Control": "no-store" });
      return;
    }
    sessionId = raw;
  }
  sendJsonFn(res, 200, coordinator.snapshot(sessionId), { "Cache-Control": "no-store" });
}

async function serveLoadTop(
  load: HubLoadService,
  req: IncomingMessage,
  res: ServerResponse,
  bucket: string,
  limiter: CmdLimit,
): Promise<void> {
  const admitted = limiter.admit(bucket, 3, 1_000);
  if (!admitted.ok) {
    sendJson(res, 429, { error: "E_RATE" }, { "Retry-After": String(Math.ceil(admitted.retryAfterMs / 1000)) });
    return;
  }
  let closed = false;
  let onClose: (() => void) | undefined;
  const disconnected = new Promise<never>((_, reject) => {
    onClose = () => {
      closed = true;
      reject(new Error("E_CLIENT_CLOSED"));
    };
    req.once("aborted", onClose);
    req.once("close", onClose);
    res.once("close", onClose);
  });
  try {
    const result = await Promise.race([withDeadline(load.top(), LOAD_TOP_DEADLINE_MS), disconnected]);
    if (!closed) sendJson(res, 200, result);
  } catch (error) {
    if (closed || (error instanceof Error && error.message === "E_CLIENT_CLOSED")) return;
    const code = loadTopErrorCode(error);
    const status = code === "E_BUSY" ? 503 : code === "E_DEADLINE" ? 504 : 500;
    sendError(res, status, code);
  } finally {
    if (onClose !== undefined) {
      req.off("aborted", onClose);
      req.off("close", onClose);
      res.off("close", onClose);
    }
  }
}

/**
 * web-hub-version plan §3.9: `GET /api/version` — shared by both listeners (authentication and
 * the `X-PWH` check already happened). Rate limit → parallel [UI redeploy probe, snapshot] →
 * respond. A probe `E_BUSY` ⇒ 503; a probe that merely times out is ignored (the snapshot is
 * still correct, only `HubInfo.ui` may lag); snapshot `E_BUSY` ⇒ 503, `E_DEADLINE` ⇒ 504. All
 * error answers are `no-store`; the 200 body is the service's `VersionInfoWire` verbatim.
 */
async function serveVersionInfo(
  version: VersionInfoPort,
  ui: UiServer,
  req: IncomingMessage,
  res: ServerResponse,
  bucket: string,
  limiter: CmdLimit,
): Promise<void> {
  const admitted = limiter.admit(bucket, 3, 1_000);
  if (!admitted.ok) {
    sendJson(res, 429, { error: "E_RATE" }, { "Retry-After": String(Math.ceil(admitted.retryAfterMs / 1000)) });
    return;
  }
  const ac = new AbortController();
  const onClose = (): void => ac.abort();
  req.once("aborted", onClose);
  req.once("close", onClose);
  res.once("close", onClose);
  const noStore = { "Cache-Control": "no-store" };
  try {
    const probeP: Promise<"busy" | "ok"> = withDeadline(ui.probe(), VERSION_LIMITS.requestMs).then(
      () => "ok" as const,
      (err: unknown) => (err instanceof Error && err.message === "E_BUSY" ? ("busy" as const) : ("ok" as const)),
    );
    const [probe, outcome] = await Promise.all([probeP, version.snapshot(ac.signal)]);
    if (ac.signal.aborted) return;
    if (probe === "busy" || (!outcome.ok && outcome.code === "E_BUSY")) {
      sendJson(res, 503, { error: "E_BUSY" }, noStore);
    } else if (!outcome.ok) {
      sendJson(res, 504, { error: "E_DEADLINE" }, noStore);
    } else {
      sendJson(res, 200, outcome.data, noStore);
    }
  } catch {
    if (!ac.signal.aborted) sendJson(res, 500, { error: "E_INTERNAL" }, noStore);
  } finally {
    req.off("aborted", onClose);
    req.off("close", onClose);
    res.off("close", onClose);
  }
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

/** web-hub-proxy §4.1: the 401 `cookie-conflict` answer (loopback + LAN). `Set-Cookie` clearing
 * lines are BEST-EFFORT (a shadow cookie with a non-segment Path or a parent Domain is not named);
 * the body's `reason` lets the UI show its manual-recovery copy. */
function sendCookieConflict(res: ServerResponse, req: IncomingMessage, cookieName: string, secure: boolean): void {
  if (res.headersSent || res.destroyed) return;
  const lines = clearingSetCookies(cookieName, req.url ?? "/", req.headers.host, { secure });
  res.setHeader("Set-Cookie", lines);
  sendJson(res, 401, { error: "E_AUTH", reason: COOKIE_CONFLICT_REASON });
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

/** web-hub-spawn arch §8.2: every route the spawn frontend owns (single source for both the
 * SP9 dispatch sites and the legacy 501 fallback below). */
function isHeadlessPath(path: string): boolean {
  return path === "/api/headless" || path.startsWith("/api/headless/");
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
  if (rt.worktreeGraph !== undefined && rt.worktreeGraph.mode === "on" && method === "GET" && path === WTGRAPH_PATH) {
    return rt.worktreeGraph.handle(req, res, query, {
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
    rt.log.error("web-hub lan http: request failed", requestFailedFields(req, err));
    if (!res.headersSent) sendError(res, 500, "E_INTERNAL");
    else res.destroy();
  });
}

/** §6.3 D8: write-endpoint CSRF is *stricter* than the read/subscribe endpoints' — `Origin`
 * must always be present (loopback's own `csrfOk` above tolerates a missing one; LAN's
 * `csrfOkLan` already required it) and, when a browser sends `Sec-Fetch-Site` at all, it must say
 * `same-origin` (K16 spike finding: a LAN plaintext direct-IP request carries `Origin` but *no*
 * `Sec-Fetch-Site` at all — that combination must still pass). */
export function strictCsrfOk(req: IncomingMessage, expectedOrigin: string): boolean {
  const ct = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json") return false;
  if (req.headers["x-pwh"] !== "1") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  const parsed = parseOrigin(origin);
  if (parsed === undefined) return false;
  if (canonicalOrigin(parsed.scheme, parsed.hostKey) !== expectedOrigin) return false;
  const sfs = req.headers["sec-fetch-site"];
  if (typeof sfs === "string" && sfs.toLowerCase() !== "same-origin") return false;
  return true;
}

/**
 * web-hub-proxy plan v2 §4.3 (P4): the hub `/api` cross-site gate, armed ONLY when the proxy is
 * wired. A proxied page's origin is same-site with the hub (ports are ignored by schemeful site),
 * so a `SameSite=Strict` hub cookie IS attached to its requests; this refuses them by metadata:
 *  - `Sec-Fetch-Site` present and ∉ {`same-origin`, `none`} ⇒ refuse;
 *  - `Origin` present and its canonical form ≠ the listener origin (`null` included) ⇒ refuse;
 *  - both absent (old engines, CLI) ⇒ pass.
 * Runs after the `OPTIONS` short-circuit (OPTIONS keeps its exact 404, no ACAO) and before any
 * cookie is read. Exported for the T-A1 unit matrix.
 */
export function apiCrossSiteOk(req: IncomingMessage, expectedOrigin: string): boolean {
  const sfs = req.headers["sec-fetch-site"];
  if (typeof sfs === "string") {
    const v = sfs.toLowerCase();
    if (v !== "same-origin" && v !== "none") return false;
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    const parsed = parseOrigin(origin);
    if (parsed === undefined) return false;
    if (canonicalOrigin(parsed.scheme, parsed.hostKey) !== expectedOrigin) return false;
  }
  return true;
}

function isProxyApiPath(path: string): boolean {
  return path === PROXY_OPEN_PATH || path === PROXY_LIST_PATH || path === PROXY_STOP_PATH;
}

/** web-hub-upload plan §5.2: chunk-endpoint CSRF — identical to `strictCsrfOk` except the
 * Content-Type must be `application/octet-stream` (chunk bodies are raw bytes). Neither
 * octet-stream nor `X-PWH` is CORS-safelisted, so a cross-origin request must preflight, and the
 * hub answers every `OPTIONS` with 404. Both listeners use this (the loopback's lenient
 * `csrfOk` must never cover an upload). */
function uploadCsrfOk(req: IncomingMessage, expectedOrigin: string): boolean {
  const ct = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/octet-stream") return false;
  if (req.headers["x-pwh"] !== "1") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  const parsed = parseOrigin(origin);
  if (parsed === undefined) return false;
  if (canonicalOrigin(parsed.scheme, parsed.hostKey) !== expectedOrigin) return false;
  const sfs = req.headers["sec-fetch-site"];
  if (typeof sfs === "string" && sfs.toLowerCase() !== "same-origin") return false;
  return true;
}

function buildLanStatus(
  cfg: LanFrontendDeps["cfg"],
  snapshot: HostSnapshot,
  boundPort: number,
  extraWarnings: readonly string[] = [],
): LanStatus {
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
    warnings: ["plaintext", ...extraWarnings],
  };
}

/** `FrontendDeps` plus the XA identity option (kept off the frozen `ports.ts` surface — X0/X1c may
 * promote it): `multiCandidateAuth` (default off) is the switch the proxy package flips to turn on
 * the multi-candidate duplicate-cookie path of §4.1 (loopback max 8, LAN max 3, conflict ⇒ 401
 * `cookie-conflict`). Off ⇒ first-value, byte-identical to pre-XA. */
export type FrontendIdentityDeps = FrontendDeps & { multiCandidateAuth?: boolean; crossSiteGate?: boolean };

export const createHttpFrontend: FrontendFactory = (deps: FrontendDeps): HttpFrontend => {
  const { config, registry, bus, history, log, now } = deps;
  const csp = hubCsp(config.proxy?.portRange);
  const auth = createAuth({ tokenFile: deps.paths.tokenFile, log });
  // web-hub-proxy plan §4.1/§4.2 (XA): the auth revocation bus + the multi-candidate cookie switch.
  // The HTML preview subscribes UNCONDITIONALLY (independent of any proxy setting); every former
  // direct `revokeHtmlCaps` call is a 1:1, in-place, same-order `authRevoke.emit`. The proxy
  // package attaches its own subscriber through the `subscribeAuthRevoke` extra at the bottom.
  const authRevoke = createAuthRevokeBus(log);
  // X1c: wiring the proxy routes (`deps.proxy`, present only when `config.proxy` exists) is what
  // arms BOTH the multi-candidate cookie path (§4.1) and the `/api` cross-site gate (§4.3 P4);
  // the explicit flags exist for tests that arm one without the routes. Neither armed ⇒ the
  // frontend is byte-identical to a hub without the feature.
  const proxyRoutes = deps.proxy;
  const multiCandidateAuth = (deps as FrontendIdentityDeps).multiCandidateAuth === true || proxyRoutes !== undefined;
  const crossSiteGate = (deps as FrontendIdentityDeps).crossSiteGate === true || proxyRoutes !== undefined;
  // Live LAN host allow-list for the proxy listeners (§3.4): `undefined` whenever the LAN listener
  // is down/closed, so a runtime LAN teardown drops LAN hosts to 421 on the proxy ports.
  let lanHostSnapshot: () => HostSnapshot | undefined = () => undefined;
  const loopbackCookieMax = multiCandidateAuth ? LOOPBACK_COOKIE_MAX : 1;
  const sse = createSseHub({ now });
  // \u00a76.7.1 (C8): bumped by `bumpLanRevokeGen()` (duck-typed extra below, called from
  // `admin.ts`'s `handleRotateToken`/recovery-scan callers) and read back by the LAN write-path's
  // `genNow` closure \u2014 mirrors `auth.authGen()` for the loopback listener (\u00a76.3 steps \u2462/\u2466).
  let lanRevokeGen = 0;
  // §6.5 (C3): one shared token-bucket limiter for every write endpoint on both listeners
  // (bucket keys already carry the listener label, so there is no cross-listener bleed-through).
  // FA: production ALWAYS takes the root-owned instance, also used by Feishu. The fallback
  // preserves standalone frontend callers that have no bot/composition root.
  const cmdLimit = deps.cmdLimit ?? createCmdLimit(now);
  // C3 P1 fix (§6.4): shared 429-audit throttle map for both listeners, same lifetime as `cmdLimit`.
  const rejectAudit429 = new Map<string, number>();
  // web-hub-spawn plan §SP9 (arch §4.1/§8.2): the managed-spawn route frontend — absent ⇒
  // `/api/headless*` keeps its legacy replies (404/501 per the §8.2 not-enabled matrix) and no
  // `spawns` SSE frame is ever sent, byte-identical to pre-SP9.
  const spawnRoutes = deps.spawn;
  // web-hub-preview plan v3 §4.5 (PV3): the preview route frontend — absent ⇒ `GET /api/preview`
  // keeps its legacy replies (401/404 per the §4.7 not-enabled matrix) and no `X-PWH-Preview-*`
  // header is ever sent, byte-identical to pre-PV3.
  const previewRoutes = deps.preview;
  // XA §4.2: HTML preview is subscribed UNCONDITIONALLY (whether or not a proxy exists); the method
  // is resolved at emit time so a wrapped/absent hook behaves exactly like the former direct call.
  authRevoke.subscribe((ev) => previewRoutes?.revokeHtmlCaps?.(ev.sel, ev.reason));
  // web-hub-delete-session plan v2 §2.9: the agent/managed-session removal route frontend —
  // absent ⇒ `POST /api/agents/remove` keeps its legacy reply (404, not-enabled), byte-identical.
  const agentRemoveRoutes = deps.agentRemove;
  // web-hub-avatar plan v2.1 §2.1: one route instance serves both listeners; the
  // absent dependency is the byte-identical feature-off path.
  const avatarRoutes = deps.avatar;
  // web-hub-privacy plan v2.1 (P1): same single-instance/two-listener discipline as avatar;
  // absent ⇒ no dispatch, no `privacy` SSE frame, byte-identical to pre-feature.
  const privacyRoutes = deps.privacy;
  // @文件补全 (file-mention): the `GET /api/files/search` route frontend. Default-constructed
  // from the preview line's presence/mode (the search endpoint is preview's completion
  // sibling — same cwd-root security surface, same §4.7 listener matrix), so `hub.ts` needs no
  // wiring of its own; an injected `deps.fileSearch` (tests) always wins. Absent ⇒ the
  // endpoint keeps its legacy replies (unauth GET ⇒ 401, authed ⇒ 404), byte-identical.
  const fileSearchRoutes: FileSearchRoutes | undefined =
    deps.fileSearch ??
    (previewRoutes === undefined
      ? undefined
      : createFileSearchRoutes({ mode: previewRoutes.mode, registry, log, now }));
  // worktree-diff plan §1.6 (D3): injected by hub.ts (never default-constructed — the routes
  // need the preview deny context + the git runner, both hub.ts-owned). Absent ⇒ the endpoints
  // keep their legacy replies, byte-identical.
  const worktreeDiffRoutes: WorktreeDiffRoutes | undefined = deps.worktreeDiff;
  // worktree-graph plan v2 §2.6 (P2): same injection discipline as worktree-diff above (never
  // default-constructed — the routes need the preview deny context + the shared git runner,
  // both hub.ts-owned). Absent ⇒ `GET /api/worktree-graph` keeps its legacy replies.
  const worktreeGraphRoutes: WorktreeGraphRoutes | undefined = deps.worktreeGraph;
  // sysload P3: one activation per hub process, shared by loopback and LAN.  The
  // callback is bound to both route sets below; no sampler is constructed when
  // config.load is absent or the bounded Linux probe fails.
  let loadRouteSets: RouteSet[] = [];
  // scheduled-reports H1 (§5.6): the coordinator arrives as a duck-typed FrontendDeps extra
  // (ports.ts stays frozen for this package — same widening pattern as `HttpFrontendExt`).
  // Constructed by hub.ts (it needs the registry + agent-server wiring), attached here ONLY
  // when `config.schedule` exists; absent ⇒ no routes, no SSE frame, byte-identical.
  const schedulesCoordinator: ScheduleCoordinator | undefined =
    config.schedule === undefined ? undefined : ((deps as FrontendDepsSchedulesExt).schedules ?? undefined);
  let schedRouteSets: RouteSet[] = [];
  if (schedulesCoordinator !== undefined) {
    schedulesCoordinator.setSseSink({
      publish: (payload) => {
        for (const route of schedRouteSets) route.onSchedules(payload);
      },
    });
  }
  const load: HubLoadService | undefined =
    config.load === undefined
      ? undefined
      : createHubLoad(config.load, {
          home: config.home,
          now,
          onWire: (wire) => {
            for (const route of loadRouteSets) route.onHubEvent({ type: "load", wire });
          },
          log,
        });
  const ui: UiServer =
    deps.ui ??
    createUiServer({
      candidates: buildUiCandidates({ home: config.home, hubVersion: config.pluginVersion }),
      hubVersion: config.pluginVersion,
      log,
      ...(deps.onUiStatus === undefined ? {} : { onStatus: deps.onUiStatus }),
      ...(deps.onUiServed === undefined ? {} : { onServed: deps.onUiServed }),
    } satisfies CreateUiServerOptions);
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
    ...(spawnRoutes === undefined ? {} : { spawns: () => spawnRoutes.publicPayload("loopback") }),
    // F4 (fleet-drawer §5.4): the loopback listener's run routes — caps gated on `runtx.v1`
    // (never `runtx.lan.v1`), refs prefixed `loopback:`.
    listener: "loopback",
    now,
    ...(deps.runTx === undefined ? {} : { runTx: deps.runTx }),
    ...(load === undefined ? {} : { load: () => load.latest() }),
    ...(privacyRoutes === undefined ? {} : { privacy: () => privacyRoutes.locked() }),
    ...(schedulesCoordinator === undefined ? {} : { schedules: () => schedulesCoordinator.snapshot() }),
  });
  loadRouteSets.push(routes);
  schedRouteSets.push(routes);

  // ---- LAN facade (§2.5/§6/§7) ------------------------------------------

  // §6.7.1 (C8): `revokeAll` is a duck-typed extra beyond the frozen `LanFacade` (same widening
  // pattern used elsewhere in this file) — `admin.ts`'s rotate-token flow needs to kill every
  // open LAN SSE stream, not just one target's, which the frozen `revoke(target)` can't express.
  let lanFacade: (LanFacade & { revokeAll?(): number }) | undefined;
  let lanSseRef: SseHub | undefined;
  // F4: the LAN route set's run sink, hoisted so the composite installation below (after both
  // route sets exist) can reach it.
  let lanRunSink: RunSink | undefined;
  if (deps.lan !== undefined) {
    const lan = deps.lan;
    if (lan.clientAllow === undefined) throw new Error("web-hub: LAN client guard is required");
    const clientAllow = tagClientAllowGuard(lan.clientAllow, "lan");
    const lanSse = createSseHub({ now });
    lanSseRef = lanSse;
    const lanRoutes = createRouteSet(lanSse, {
      registry,
      history,
      log,
      info: deps.info,
      port: () => lan.cfg.port,
      isClosed: () => lanClosed,
      // LAN policy `off` ⇒ publicPayload("lan") is undefined ⇒ no `spawns` snapshot, no live
      // forward — the LAN SSE face stays byte-identical to not-enabled (arch §8.2 matrix).
      ...(spawnRoutes === undefined ? {} : { spawns: () => spawnRoutes.publicPayload("lan") }),
      // F4 (fleet-drawer §5.4): the LAN listener's run routes — caps gated on `runtx.lan.v1`
      // too, refs prefixed `lan:`.
      listener: "lan",
      now,
      ...(deps.runTx === undefined ? {} : { runTx: deps.runTx }),
      ...(load === undefined ? {} : { load: () => load.latest() }),
      ...(privacyRoutes === undefined ? {} : { privacy: () => privacyRoutes.locked() }),
      ...(schedulesCoordinator === undefined ? {} : { schedules: () => schedulesCoordinator.snapshot() }),
    });
    loadRouteSets.push(lanRoutes);
    schedRouteSets.push(lanRoutes);
    lanRunSink = lanRoutes.runSink;
    let lanClosed = false;
    const unsubscribeLanBus = bus.subscribe(lanRoutes.onHubEvent);
    // §5.1/§9.2 review fix (LC #2): sticky once set (a corrupt KDF row doesn't self-heal without
    // an operator fixing the db), folded into `LanStatus.warnings` by every subsequent rebuild.
    let kdfInvalidWarning = false;
    const rt: LanRuntime = {
      csp,
      lan,
      routes: lanRoutes,
      lanSse,
      sseClientIps: new WeakMap(),
      ui,
      now,
      version: () => deps.info().version,
      ...(deps.info().caps === undefined ? {} : { hubCaps: deps.info().caps }),
      log,
      clientInflight: new Map(),
      sidInflight: new Map(),
      absoluteExpiryTimers: new Map(),
      registry,
      commands: deps.commands,
      uploads: deps.uploads,
      uploadMetrics: deps.uploadMetrics,
      cmdLimit,
      rejectAudit429,
      spawn: deps.spawn,
      preview: deps.preview,
      authRevoke,
      lanCookieMax: multiCandidateAuth ? LAN_COOKIE_MAX : 1,
      ...(proxyRoutes === undefined ? {} : { proxy: proxyRoutes }),
      ...(crossSiteGate ? { crossSiteGate: true } : {}),
      versionInfo: deps.version,
      avatar: deps.avatar,
      /** web-hub-privacy plan v2.1 (P1): same instance as the loopback listener's (or undefined
       * when `webHub.privacy` is off — both `/api/privacy/*` paths then keep their 404s). */
      privacy: privacyRoutes,
      /** @文件补全 (file-mention): same instance as the loopback listener's (or undefined when
       * preview/file-search is not enabled — the LAN face then keeps its original 404). */
      fileSearch: fileSearchRoutes,
      commandComplete: deps.commandComplete,
      /** worktree-diff plan §1.6 (D3): same instance as the loopback listener's (or undefined
       * when preview is off / /proc is unavailable — the LAN 404 stays byte-identical). */
      worktreeDiff: deps.worktreeDiff,
      /** worktree-graph plan v2 §2.6 (P2): same instance as the loopback listener's. */
      worktreeGraph: deps.worktreeGraph,
      /** web-hub-delete-session plan v2 §2.9: same instance as the loopback listener's. */
      agentRemove: deps.agentRemove,
      ...(load === undefined ? {} : { load }),
      ...(schedulesCoordinator === undefined ? {} : { schedules: schedulesCoordinator }),
      markKdfInvalid: () => {
        if (kdfInvalidWarning) return;
        kdfInvalidWarning = true;
        if (handle === undefined) return;
        status = withAllowlist(buildLanStatus(lan.cfg, handle.current(), handle.port, extraWarnings()));
        lan.onStatus(status);
      },
    };
    // One open-time verdict, shared with admin writes; never infer it from verifyTarget (which
    // can be stronger after rollback). Phase 1 therefore allocates no upgrader or extra KDF.
    const kdfUpgrader =
      lan.store.hardening?.writerActive === true
        ? createKdfUpgrader({ kdf: lan.kdf, store: lan.store, log, now, target: effectiveWriteTarget(true) })
        : undefined;
    lan.scope.defer(() => kdfUpgrader?.dispose());
    const loginCore = createLanLoginCore({
      ...(kdfUpgrader === undefined ? {} : { kdfUpgrader }),
      store: lan.store,
      kdf: lan.kdf,
      limiter: lan.limiter,
      admission: lan.admission,
      ...(lan.kdfPolicy === undefined ? {} : { kdfPolicy: lan.kdfPolicy }),
      secondFactorEnabled: lan.secondFactorEnabled === true,
      approval: lan.approval ?? { request: async () => "unavailable", close() {} },
      security: lan.security ?? createSecurityEventBus(log),
      authRevoke,
      revokeSse: (hash) => {
        lanSse.revoke((c) => c.auth?.sidHash === hash, "revoked");
      },
      now,
      log,
      onCorruptKdfParams: (username, reason) => {
        log.error("web-hub lan http: corrupt kdf params (db-invalid:kdf)", { username, reason });
        rt.markKdfInvalid();
      },
    });
    rt.sessions = createLanSessionsRoutes({
      store: lan.store,
      idleMs: lan.cfg.sessionIdleMs ?? 720 * 60_000,
      now,
      log,
      authRevoke,
      revokeSse: (hash) => {
        lanSse.revoke((c) => c.auth?.sidHash === hash, "revoked");
      },
    });
    lan.scope.defer(() => rt.sessions?.dispose());
    rt.loginCore = loginCore;
    lan.onLoginCore?.(loginCore);
    const offLoginRevoke = authRevoke.subscribe((ev) => loginCore.onRevoke(ev));
    lan.scope.defer(() => {
      offLoginRevoke();
      kdfUpgrader?.dispose();
      loginCore.dispose();
      lan.onLoginCore?.(undefined);
    });
    const connGuard = createConnGuard();
    let handle: LanListenerHandle | undefined;
    lanHostSnapshot = () => (lanClosed ? undefined : handle?.current());
    let gen = 0;
    let status: LanStatus = { state: "starting" };
    let lastRecomputeAt = 0;
    // Review fix (LC, plan §1.4/§3, W3 acceptance item 1): `start()`/`close()` race guard.
    // `startGen` is bumped by both a fresh `start()` call and by `close()` — whichever `start()`
    // captured the *current* value as `mine` right before its own `await` is the only one allowed
    // to publish a result; any attempt that finds `mine !== startGen` (a newer `start()` ran) or
    // `lanClosed` (a `close()` ran) after resuming from that `await` must self-clean instead of
    // mutating `handle`/`status` (§1.4 "迟到结果自我清理"). `inFlightStartAborts` lets `close()`
    // proactively abort a `start()` that is still awaiting `transport.bind()` so the half/fully
    // bound listener (and the port it holds) is released immediately rather than only once that
    // bind attempt eventually settles on its own.
    let startGen = 0;
    const inFlightStartAborts = new Set<AbortController>();

    function withAllowlist(s: LanStatus): LanStatus {
      return s.state === "on"
        ? {
            ...s,
            ...(clientAllow.active ? { allowClients: clientAllow.snapshot() } : {}),
            ...(lan.loginIpsRebuiltAt === undefined ? {} : { loginIpsRebuiltAt: lan.loginIpsRebuiltAt }),
          }
        : s;
    }

    function extraWarnings(): string[] {
      return [...(kdfInvalidWarning ? ["db-invalid:kdf"] : []), ...(lan.store.warnings?.() ?? [])];
    }

    // #66 P5/P6: store-raised residue and TOTP key-state warnings share this append-only channel.
    const offStoreWarnings = lan.store.onWarningsChanged?.(() => {
      if (handle === undefined || lanClosed) return;
      status = withAllowlist(buildLanStatus(lan.cfg, handle.current(), handle.port, extraWarnings()));
      lan.onStatus(status);
    });
    lan.scope.defer(() => offStoreWarnings?.());

    function recompute(force: boolean): void {
      if (handle === undefined || lanClosed) return;
      const t = now();
      if (!force && t - lastRecomputeAt < LAN_RECOMPUTE_THROTTLE_MS) return;
      lastRecomputeAt = t;
      const next = lan.hosts.compute(lan.cfg);
      const cur = handle.current();
      if (sameHostKeys(cur, next)) return;
      gen++;
      const swapped: HostSnapshot = { ...next, gen };
      handle.swap(swapped);
      status = withAllowlist(buildLanStatus(lan.cfg, swapped, handle.port, extraWarnings()));
      lan.onStatus(status);
    }

    const transport = createLanTransport({
      clientAllow,
      csp,
      log,
      connGuard,
      onIPv4HostReject: () => recompute(false),
      handleRequest: (req, res, ctx, lease) => handleLanRequest(rt, req, res, ctx, lease),
    });

    lanFacade = {
      async start(): Promise<LanStatus> {
        // §1.4/§3 "close 之后的 start 为 no-op": once closed, this facade never opens a listener again
        // (the only recovery path is a whole-new hub process via `/webhub restart`).
        if (lanClosed) return status;
        const mine = ++startGen;
        const startAbort = new AbortController();
        inFlightStartAborts.add(startAbort);
        let timedOut = false;
        const deadlineTimer = setTimeout(() => {
          timedOut = true;
          startAbort.abort(new Error(`web-hub: LAN start exceeded ${LAN_START_DEADLINE_MS}ms`));
        }, LAN_START_DEADLINE_MS);
        deadlineTimer.unref?.();
        try {
          const first = lan.hosts.compute(lan.cfg);
          gen = 1;
          let bound: LanListenerHandle;
          try {
            bound = await transport.bind(lan.cfg.port, { ...first, gen }, startAbort.signal);
          } catch (err) {
            if (mine !== startGen || lanClosed) return status; // a newer start()/close() already won
            const reason: LanOffReason = timedOut ? "timeout" : "listen-failed";
            status = reason === "timeout" ? { state: "off", reason } : { state: "off", reason, detail: String(err) };
            return status;
          }
          if (mine !== startGen || lanClosed) {
            // A newer start() (tests only — production calls this once) or a concurrent close() ran
            // while we were awaiting `bind()`: the port we just bound is now unwanted — release it
            // ourselves (§1.4 "已 bind 的 handle 被关闭、端口可重新 bind") and leave `handle`/`status`
            // untouched so we can never resurrect a facade that `close()` already tore down.
            void bound.close();
            return status;
          }
          handle = bound;
          status = withAllowlist(buildLanStatus(lan.cfg, handle.current(), handle.port, extraWarnings()));
          if (clientAllow.active) {
            // One unref'd trailing tick coalesces denies from BOTH listener kinds; scope owns cleanup.
            lan.scope.timer(
              () => {
                if (lanClosed || status.state !== "on") return;
                const next = withAllowlist(status);
                if (JSON.stringify(next) === JSON.stringify(status)) return;
                status = next;
                lan.onStatus(status);
              },
              30_000,
              true,
            );
          }
          lan.scope.timer(() => recompute(true), LAN_TICK_MS, true);
          lan.scope.timer(
            () => {
              if (lanClosed) return;
              void recheckLanSseExpiry(rt).catch((err: unknown) => {
                rt.log.error("web-hub lan http: sse expiry recheck tick failed", { error: String(err) });
              });
            },
            LAN_SSE_EXPIRY_TICK_MS,
            true,
          );
          return status;
        } finally {
          clearTimeout(deadlineTimer);
          inFlightStartAborts.delete(startAbort);
        }
      },
      status(): LanStatus {
        return status;
      },
      async close(): Promise<void> {
        lanClosed = true;
        startGen++; // invalidate any start() awaiting bind() right now, or about to be called
        // §1.4 "close 与 start 并发": don't just wait for an in-flight start()'s bind() to settle on
        // its own — abort it now so the half/fully bound listener (and the port) is released
        // immediately; `bind()`'s own abort handling (see `createLanTransport`) does the actual
        // `srv.close()`.
        for (const c of inFlightStartAborts) c.abort(new Error("web-hub: LAN closed"));
        inFlightStartAborts.clear();
        offLoginRevoke();
        kdfUpgrader?.dispose();
        loginCore.dispose();
        lan.onLoginCore?.(undefined);
        rt.sessions?.dispose();
        unsubscribeLanBus();
        lanSse.closeAll();
        rt.sidInflight.clear();
        rt.clientInflight.clear();
        // §4.2 review fix (LC #1): sweep any absolute-expiry timers not already cleared by their
        // connection's own `close` event (the `closeAll()` above ends every response, but that
        // event fires asynchronously — don't leave unref'd timers dangling past this `close()`).
        for (const t of rt.absoluteExpiryTimers.values()) clearTimeout(t);
        rt.absoluteExpiryTimers.clear();
        await handle?.close();
      },
      revoke(target: { sidHash: string } | { userId: number }): number {
        // web-hub-html-preview plan v2 §2.4: the real passwd commit path (`admin.ts handlePasswd`
        // → `store.setPassword` → `deps.lan()?.revoke({userId})`) — capability revocation rides
        // the same call as the SSE revoke.
        authRevoke.emit({
          sel: "sidHash" in target ? { sidTag: target.sidHash } : { userId: target.userId },
          reason: "sidHash" in target ? "logout" : "passwd",
        });
        const pred: (c: SseClient) => boolean =
          "sidHash" in target ? (c) => c.auth?.sidHash === target.sidHash : (c) => c.auth?.userId === target.userId;
        return lanSse.revoke(pred, "revoked");
      },
      revokeAll(): number {
        authRevoke.emit({ sel: { listener: "lan" }, reason: "rotate" });
        return lanSse.revoke(() => true, "revoked");
      },
    };

    // §4.1 fail-closed (LD review-fix P1): the resident query subprocess giving up permanently
    // (db-client.ts's `onUnavailable`, after its own 1s→5s→30s backoff exhausts 4 restarts in a
    // rolling 10-minute window) must actually tear the LAN listener down, not just relabel the
    // status — recovery is `/webhub restart` (a fresh process/assembly), never an in-place rebind
    // (`db-client.ts` never respawns again once `unavailable` is set, so there is nothing to
    // rebind *to* short of a full restart). `LanFrontendDeps.store` is frozen to the plain
    // `LanStorePort` (§1.4.1, W1), which has no `onUnavailable` — duck-type the concrete `LanStore`
    // instance instead (same pattern as `touchForExpiryRecheck`'s `touchSessionReserved`, §15.9
    // #3: widening the frozen interface is out of this package's authorization, so probe for the
    // method at runtime rather than changing the type). `defaultLanAssembly` (LD, lan-assembly.ts)
    // also subscribes to this same event to fold the reason into `hub.json.lan` even when no
    // `HttpFrontend.lan` exists to close (e.g. a fake facade in a unit test); that call is
    // idempotent with this one (`onStatus` is just the latest write) and this subscription is the
    // only one with the actual listener handle, so it is authoritative for `LanFacade.status()`
    // (read by `admin.ts`'s `lan_req info`/`/webhub status`) and for really closing the port.
    const storeWithUnavailable = lan.store as {
      onUnavailable?: (cb: (reason: "db-unavailable") => void) => () => void;
    };
    if (typeof storeWithUnavailable.onUnavailable === "function") {
      storeWithUnavailable.onUnavailable(() => {
        if (lanClosed) return;
        status = { state: "off", reason: "db-unavailable" };
        lan.onStatus(status);
        void lanFacade?.close().catch((err: unknown) => {
          log.error("web-hub lan http: failed to close LAN listener after db-unavailable", { error: String(err) });
        });
      });
    }
  }

  // fleet-drawer plan §5.4 (F4): the service's `setSink` is a single slot, so both listeners'
  // run-route sinks are combined into one fan-out sink — each part acts only on its own `subs`,
  // and its `dropped(refs)` filter matches refs by its own `${listener}:` prefix, so the two
  // listeners' independent SseHub client-id spaces can never cross-route. Installed once here,
  // after both route sets exist; run frames arriving before this point are silently dropped by
  // the service (no sink yet), same as any pre-listen agent traffic.
  if (deps.runTx !== undefined) {
    const parts = [routes.runSink, lanRunSink].filter((s): s is RunSink => s !== undefined);
    if (parts.length === 1) deps.runTx.setSink(parts[0]!);
    else if (parts.length > 1) deps.runTx.setSink(combineRunSinks(parts));
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

  // web-hub-proxy §4.1 (XA): the single loopback identity resolution. Every executing
  // `auth.check` site below goes through `authorizeLoopback`, which answers 401 itself (plain
  // `E_AUTH`, or the `cookie-conflict` body + best-effort clearing `Set-Cookie`s in
  // multi-candidate mode) and otherwise hands back the identity that authenticated.
  function resolveLoopbackIdentity(req: IncomingMessage): IdentityResult {
    const r = auth.resolve(req.headers.cookie, now(), { maxCandidates: loopbackCookieMax });
    if (!r.ok)
      return r.conflict === true ? { ok: false, code: "E_AUTH", conflict: true } : { ok: false, code: "E_AUTH" };
    return { ok: true, id: loopbackIdentity(r) };
  }

  function authorizeLoopback(req: IncomingMessage, res: ServerResponse): AuthIdentity | undefined {
    const r = resolveLoopbackIdentity(req);
    if (r.ok) return r.id;
    if (r.conflict === true) sendCookieConflict(res, req, SESSION_COOKIE, false);
    else sendError(res, 401, "E_AUTH");
    return undefined;
  }

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
    query: URLSearchParams,
  ): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    // web-hub-proxy plan §4.3 (P4, X1c): armed only when the proxy is wired. OPTIONS keeps its
    // exact legacy 404 (no ACAO) — the gate never answers it. Runs before any cookie is read.
    if (
      crossSiteGate &&
      method !== "OPTIONS" &&
      !apiCrossSiteOk(req, canonicalOrigin("http", canonicalHostKey(req.headers.host, "http") ?? ""))
    ) {
      throw new HttpError(403, "E_CSRF");
    }
    // web-hub-spawn plan §SP9 (arch §8.2): `/api/headless*` routes own their whole pipeline
    // (strict CSRF → auth → policy → body → admit → confirm → re-auth → sync start) through
    // the injected io below — the same helpers the cmd/dialog branch uses, one instance per
    // request. Inserted before the method branches; the legacy 501 line further down stays as
    // the not-enabled fallback (spawnRoutes absent).
    if (spawnRoutes !== undefined && isHeadlessPath(path)) {
      return spawnRoutes.handle(req, res, method, path, query, {
        listener: "loopback",
        ip: normalizePeerIp(req.socket.remoteAddress),
        scheme: "http",
        viaTrustedProxy: false,
        strictCsrfOk: () =>
          strictCsrfOk(req, canonicalOrigin("http", canonicalHostKey(req.headers.host, "http") ?? "")),
        authorize: async () => {
          if (authorizeLoopback(req, res) === undefined) return { handled: true, code: "E_AUTH" };
          return { ip: normalizePeerIp(req.socket.remoteAddress) };
        },
        readJson,
        sendJson,
        sendError,
        HttpError,
      });
    }
    // web-hub-proxy plan §3.8 (X1c): `/api/proxy*` — after headless, same spot as the LAN branch.
    // Absent routes ⇒ the original matrix. `handle` returns false for a non-matching method.
    if (proxyRoutes !== undefined && isProxyApiPath(path)) {
      const proxyIo: ProxyRouteIo = {
        listener: "loopback",
        expectedOrigin: canonicalOrigin("http", canonicalHostKey(req.headers.host, "http") ?? ""),
        browserHost: proxyBrowserHost((req.headers.host ?? "").toLowerCase()),
        viaTrustedProxy: false,
        strictCsrfOk: () =>
          strictCsrfOk(req, canonicalOrigin("http", canonicalHostKey(req.headers.host, "http") ?? "")),
        xPwhOk: () => req.headers["x-pwh"] === "1",
        resolveIdentity: async () => {
          const identity = authorizeLoopback(req, res); // answers 401 / cookie-conflict itself
          return identity === undefined ? { ok: false, code: "E_AUTH" } : { ok: true, id: identity };
        },
        readJson,
        sendJson,
        sendError,
      };
      if (await proxyRoutes.handle(req, res, method, path, proxyIo)) return;
    }
    // sysload P3: auth and CSRF hygiene happen before the shared on-demand scan.
    if (load !== undefined && method === "GET" && path === LOAD_TOP_PATH) {
      if (req.headers["x-pwh"] !== "1") throw new HttpError(403, "E_CSRF");
      const identity = authorizeLoopback(req, res);
      if (identity === undefined) return;
      return serveLoadTop(load, req, res, `loopback:${identity.principal}:load-top`, cmdLimit);
    }
    // web-hub-version plan §3.9: `GET /api/version` — absent service ⇒ original matrix.
    if (deps.version !== undefined && method === "GET" && path === VERSION_INFO_PATH) {
      if (req.headers["x-pwh"] !== "1") throw new HttpError(403, "E_CSRF");
      const identity = authorizeLoopback(req, res);
      if (identity === undefined) return;
      return serveVersionInfo(deps.version, ui, req, res, `loopback:${identity.principal}:version`, cmdLimit);
    }
    // scheduled-reports H1 (§5.6): `GET /api/schedules` — loopback (absent coordinator ⇒ the
    // original matrix: unauth 401, authed 404 — pinned by schedule-http.test.ts).
    if (schedulesCoordinator !== undefined && method === "GET" && path === SCHED_API_PATH) {
      if (req.headers["x-pwh"] !== "1") throw new HttpError(403, "E_CSRF");
      const identity = authorizeLoopback(req, res);
      if (identity === undefined) return;
      return serveSchedules(schedulesCoordinator, res, query, sendJson);
    }
    // web-hub-preview plan v3 §4.5/§4.7 (PV3): `GET /api/preview` — same insertion point as the
    // spawn branch above (after headless, before the method branches). Absent ⇒ falls through
    // to the original paths (unauth GET ⇒ 401, authed ⇒ 404 — the §4.7 not-enabled matrix,
    // byte-identical). The loopback authorize segment is a sync cookie-map lookup (no deadline
    // budgeting, same as every other loopback branch).
    if (previewRoutes !== undefined && method === "GET" && path === PREVIEW_PATH) {
      return previewRoutes.handle(req, res, query, {
        listener: "loopback",
        ip: normalizePeerIp(req.socket.remoteAddress),
        expectedOrigin: canonicalOrigin("http", canonicalHostKey(req.headers.host, "http") ?? ""),
        authorize: async () => {
          if (authorizeLoopback(req, res) === undefined) return { handled: true, code: "E_AUTH" };
          return { ip: normalizePeerIp(req.socket.remoteAddress) };
        },
        sendJson,
      });
    }
    // web-hub-preview 2026-10-07 修订: `POST /api/preview/probe` — same insertion point as the
    // preview branch above (loopback answers whenever the route frontend exists; the loopback
    // authorize segment is the same sync cookie lookup every other loopback branch uses).
    if (previewRoutes !== undefined && method === "POST" && path === PREVIEW_PROBE_PATH) {
      return previewRoutes.handleProbe(req, res, query, {
        listener: "loopback",
        ip: normalizePeerIp(req.socket.remoteAddress),
        expectedOrigin: canonicalOrigin("http", canonicalHostKey(req.headers.host, "http") ?? ""),
        authorize: async () => {
          if (authorizeLoopback(req, res) === undefined) return { handled: true, code: "E_AUTH" };
          return { ip: normalizePeerIp(req.socket.remoteAddress) };
        },
        sendJson,
      });
    }
    // web-hub-html-preview plan v2 §2.1/§4 (P1b): `POST /api/preview/html-cap` — beside the probe
    // branch (loopback answers whenever the HTML surface is attached). The authorize segment is
    // the same sync cookie lookup, plus the session tag the capability binds to for revocation.
    if (previewRoutes?.handleHtmlCap !== undefined && method === "POST" && path === PREVIEW_HTML_CAP_PATH) {
      return previewRoutes.handleHtmlCap(req, res, query, {
        listener: "loopback",
        ip: normalizePeerIp(req.socket.remoteAddress),
        expectedOrigin: canonicalOrigin("http", canonicalHostKey(req.headers.host, "http") ?? ""),
        authorize: async () => {
          // XA §4.1: the sidTag comes from the identity that actually authenticated (no cookie re-read).
          const identity = authorizeLoopback(req, res);
          if (identity === undefined) return { handled: true, code: "E_AUTH" };
          return { ip: normalizePeerIp(req.socket.remoteAddress), sidTag: identity.sidTag };
        },
        sendJson,
      });
    }
    // @文件补全 (file-mention): `GET /api/files/search` — same insertion point as the preview
    // branch above; absent ⇒ falls through to the original paths (unauth GET ⇒ 401, authed ⇒
    // 404, byte-identical). The loopback authorize segment is the same sync cookie lookup.
    if (fileSearchRoutes !== undefined && method === "GET" && path === FILE_SEARCH_PATH) {
      return fileSearchRoutes.handle(req, res, query, {
        listener: "loopback",
        ip: normalizePeerIp(req.socket.remoteAddress),
        expectedOrigin: canonicalOrigin("http", canonicalHostKey(req.headers.host, "http") ?? ""),
        authorize: async () => {
          if (authorizeLoopback(req, res) === undefined) return { handled: true, code: "E_AUTH" };
          return { ip: normalizePeerIp(req.socket.remoteAddress) };
        },
        sendJson,
      });
    }
    if (deps.commandComplete !== undefined && method === "POST" && path === COMMAND_COMPLETE_PATH) {
      const expectedOrigin = canonicalOrigin("http", canonicalHostKey(req.headers.host, "http") ?? "");
      return deps.commandComplete.handle(req, res, {
        listener: "loopback",
        ip: normalizePeerIp(req.socket.remoteAddress),
        expectedOrigin,
        strictCsrfOk: () => strictCsrfOk(req, expectedOrigin),
        authorize: async () => {
          if (authorizeLoopback(req, res) === undefined) return { handled: true, code: "E_AUTH" };
          return { ip: normalizePeerIp(req.socket.remoteAddress) };
        },
        readJson,
        sendJson,
      });
    }
    // worktree-diff plan §1.6 (D3): the two worktree-diff GETs — same insertion point as the
    // preview/file-search branches above; absent ⇒ falls through to the original paths
    // (unauth GET ⇒ 401, authed ⇒ 404, byte-identical). The loopback authorize segment is the
    // same sync cookie lookup every other loopback branch uses.
    if (
      worktreeDiffRoutes !== undefined &&
      method === "GET" &&
      (path === WTDIFF_FILES_PATH || path === WTDIFF_FILE_PATH)
    ) {
      const io = {
        listener: "loopback" as const,
        ip: normalizePeerIp(req.socket.remoteAddress),
        expectedOrigin: canonicalOrigin("http", canonicalHostKey(req.headers.host, "http") ?? ""),
        authorize: async (): Promise<PreviewAuthResult | PreviewAuthHandled> => {
          if (authorizeLoopback(req, res) === undefined) return { handled: true, code: "E_AUTH" };
          return { ip: normalizePeerIp(req.socket.remoteAddress) };
        },
        sendJson,
      };
      return path === WTDIFF_FILES_PATH
        ? worktreeDiffRoutes.handleFiles(req, res, query, io)
        : worktreeDiffRoutes.handleFile(req, res, query, io);
    }
    // worktree-graph plan v2 §2.6 (P2): the one worktree-graph GET — same insertion point as the
    // wtdiff branch above; absent ⇒ falls through to the original paths (unauth GET ⇒ 401,
    // authed ⇒ 404, byte-identical). The loopback authorize segment is the same sync cookie
    // lookup every other loopback branch uses.
    if (worktreeGraphRoutes !== undefined && method === "GET" && path === WTGRAPH_PATH) {
      return worktreeGraphRoutes.handle(req, res, query, {
        listener: "loopback",
        ip: normalizePeerIp(req.socket.remoteAddress),
        expectedOrigin: canonicalOrigin("http", canonicalHostKey(req.headers.host, "http") ?? ""),
        authorize: async (): Promise<PreviewAuthResult | PreviewAuthHandled> => {
          if (authorizeLoopback(req, res) === undefined) return { handled: true, code: "E_AUTH" };
          return { ip: normalizePeerIp(req.socket.remoteAddress) };
        },
        sendJson,
      });
    }
    // web-hub-delete-session plan v2 §2.9/§4.1: `POST /api/agents/remove` — same insertion point
    // class as headless/preview/file-search above, before the generic `POST` branch. authorize
    // is the same sync cookie-map lookup every other loopback branch uses.
    if (agentRemoveRoutes !== undefined && method === "POST" && path === AGENT_REMOVE_PATH) {
      return agentRemoveRoutes.handle(req, res, {
        listener: "loopback",
        ip: normalizePeerIp(req.socket.remoteAddress),
        strictCsrfOk: () =>
          strictCsrfOk(req, canonicalOrigin("http", canonicalHostKey(req.headers.host, "http") ?? "")),
        authorize: async () => {
          if (authorizeLoopback(req, res) === undefined) return { handled: true, code: "E_AUTH" };
          return { ip: normalizePeerIp(req.socket.remoteAddress) };
        },
        readJson,
        sendJson,
        sendError,
        HttpError,
      });
    }
    // web-hub-avatar plan v2.1 §2.1: loopback uses the same route object and
    // keeps the dispatch immediately before the generic POST branch.
    if (
      avatarRoutes !== undefined &&
      ((method === "GET" && path === AVATAR_PATH) ||
        (method === "POST" && path === AVATAR_PATH) ||
        (method === "POST" && path === AVATAR_DELETE_PATH))
    ) {
      const avatarPath = path === AVATAR_DELETE_PATH ? AVATAR_DELETE_PATH : AVATAR_PATH;
      return avatarRoutes.handle(req, res, avatarPath, {
        listener: "loopback",
        ip: normalizePeerIp(req.socket.remoteAddress),
        expectedOrigin: canonicalOrigin("http", canonicalHostKey(req.headers.host, "http") ?? ""),
        authorize: async () => {
          if (authorizeLoopback(req, res) === undefined) return { handled: true, code: "E_AUTH" };
          return { ip: normalizePeerIp(req.socket.remoteAddress) };
        },
        sendJson,
      });
    }
    // web-hub-privacy plan v2.1 (P1): `/api/privacy/lock` on the loopback listener — same
    // insertion point class as agent-remove/avatar above (immediately before the generic POST
    // branch); authorize is the same sync cookie-map lookup. `/api/privacy/verify` is
    // deliberately NOT mounted here (v2.1 N1: token mode has no second credential) — it falls
    // through to the generic POST branch's authed 404 below, byte-identical to not-enabled.
    if (privacyRoutes !== undefined && method === "POST" && path === PRIVACY_LOCK_PATH) {
      return privacyRoutes.handleLock(req, res, {
        listener: "loopback",
        ip: normalizePeerIp(req.socket.remoteAddress),
        strictCsrfOk: () =>
          strictCsrfOk(req, canonicalOrigin("http", canonicalHostKey(req.headers.host, "http") ?? "")),
        authorize: async () => {
          if (authorizeLoopback(req, res) === undefined) return { handled: true, code: "E_AUTH" };
          return { ip: normalizePeerIp(req.socket.remoteAddress) };
        },
        readJson,
        sendJson,
        sendError,
        HttpError,
      });
    }
    if (method === "POST") {
      if (path === "/api/cmd" || path === "/api/dialog") {
        return dispatchCmdOrDialog(req, res, path, {
          listener: "loopback",
          ip: normalizePeerIp(req.socket.remoteAddress),
          strictCsrfOk: () =>
            strictCsrfOk(req, canonicalOrigin("http", canonicalHostKey(req.headers.host, "http") ?? "")),
          authorize: async (_deadline) => {
            if (authorizeLoopback(req, res) === undefined) return { handled: true, code: "E_AUTH" };
            return { ip: normalizePeerIp(req.socket.remoteAddress) };
          },
          registry,
          commands: deps.commands,
          uploads: deps.uploads,
          limit: cmdLimit,
          rejectAudit429,
          log,
          now,
        });
      }
      // web-hub-upload plan §1.2/§5.1 (U3): /api/upload/*, inserted before the generic `csrfOk`
      // gate exactly like the cmd/dialog branch above; authorize copies that branch's loopback
      // segment verbatim (a sync cookie-map lookup needs no deadline budgeting on either call).
      if (path.startsWith("/api/upload/")) {
        const expectedOrigin = canonicalOrigin("http", canonicalHostKey(req.headers.host, "http") ?? "");
        return handleUploadRequest(req, res, path, query, {
          listener: "loopback",
          ip: normalizePeerIp(req.socket.remoteAddress),
          csrfOk: (kind) => (kind === "chunk" ? uploadCsrfOk(req, expectedOrigin) : strictCsrfOk(req, expectedOrigin)),
          authorize: async (_deadline) => {
            if (authorizeLoopback(req, res) === undefined) return { handled: true, code: "E_AUTH" };
            return { ip: normalizePeerIp(req.socket.remoteAddress) };
          },
          registry,
          store: deps.uploads,
          metrics: deps.uploadMetrics,
          limit: cmdLimit,
          rejectAudit429,
          log,
          now,
          io: { readBody, sendJson },
        });
      }
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
        // XA §4.1: logout targets come from the one cookie module — legacy (max 1) = the first
        // `pwh_sid` value (valid or not, exactly as before); multi-candidate mode logs out every
        // distinct candidate (a logout is never refused by a conflict).
        for (const sid of cookieCandidates(req.headers.cookie, SESSION_COOKIE, loopbackCookieMax).values) {
          auth.logout(sid);
          // web-hub-html-preview plan v2 §2.4: this session's HTML capabilities die with it.
          authRevoke.emit({ sel: { sidTag: hashSid(sid) }, reason: "logout" });
        }
        sendJson(
          res,
          200,
          { ok: true },
          { "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` },
        );
        return;
      }
      if (authorizeLoopback(req, res) === undefined) return;
      if (path === "/api/subscribe") return routes.subscribe(body, res);
      if (path === "/api/unsubscribe") return routes.unsubscribe(body, res);
      // fleet-drawer plan §3.4/§5.4 (F4): run-transcript subscribe/unsubscribe — same CSRF /
      // 64 KiB body / auth pipeline as the agent-level ones above (404 when no service wired).
      if (path === "/api/run/subscribe") return routes.runSubscribe(body, res);
      if (path === "/api/run/unsubscribe") return routes.runUnsubscribe(body, res);
      if (isHeadlessPath(path)) throw new HttpError(501, "E_NOT_IMPLEMENTED"); // P3 — spawn frontend not wired (SP9 matrix: not-enabled)
      throw new HttpError(404, "E_NOT_FOUND");
    }
    if (method === "GET") {
      if (authorizeLoopback(req, res) === undefined) return;
      if (path === "/api/events") return openEvents(req, res);
      if (path === "/api/history") return routes.historyPage(query, res);
      if (path === "/api/run/history") return routes.runHistoryPage(query, res); // F4: same session gate as /api/history
    }
    throw new HttpError(404, "E_NOT_FOUND");
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setSecurityHeaders(res, csp);
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
    // web-hub-html-preview plan v2 §4 (P1b): `/pv/<cap>/<rel>` + `/pvw/<cap>` — after
    // `allowedHost` and the `/api` branch, before the static fallback (`isAllowedUiPath` never
    // admits these prefixes). I1: capability-only — no cookie read, no `auth.check`. `path` is
    // query-stripped. Absent (html disabled) ⇒ falls through to `ui.serve` ⇒ the original 404.
    if (previewRoutes?.servePv !== undefined && path.startsWith(PV_PREFIX)) {
      return previewRoutes.servePv(req, res, path.slice(PV_PREFIX.length), {
        listener: "loopback",
        ip: normalizePeerIp(req.socket.remoteAddress),
        origin: canonicalOrigin("http", canonicalHostKey(req.headers.host, "http") ?? ""),
      });
    }
    if (previewRoutes?.serveWrapper !== undefined && path.startsWith(PVW_PREFIX)) {
      return previewRoutes.serveWrapper(req, res, path.slice(PVW_PREFIX.length), {
        listener: "loopback",
        ip: normalizePeerIp(req.socket.remoteAddress),
        origin: canonicalOrigin("http", canonicalHostKey(req.headers.host, "http") ?? ""),
      });
    }
    const acceptLanguage = req.headers["accept-language"];
    const acceptEncoding = req.headers["accept-encoding"];
    if (
      !(await ui.serve(path, res, {
        authMode: "token",
        ...(typeof acceptLanguage === "string" ? { acceptLanguage } : {}),
        ...(typeof acceptEncoding === "string" ? { acceptEncoding } : {}),
      }))
    ) {
      throw new HttpError(404, "E_NOT_FOUND");
    }
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
      log.error("web-hub http: request failed", requestFailedFields(req, err));
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
    srv.requestTimeout = LAN_REQUEST_TIMEOUT_MS;
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
    await load?.dispose();
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

  const frontend: HttpFrontend = {
    listen,
    close,
    clientCount: () => sse.count() + (lanSseRef === undefined ? 0 : lanSseRef.count()),
    ui,
    ...(lanFacade === undefined ? {} : { lan: lanFacade }),
  };
  // §6.7.1 (C8) — duck-typed extras beyond the frozen `HttpFrontend` (same widening pattern as
  // `storeWithUnavailable` above): `hub.ts` casts `fe` to reach these when wiring `admin.ts`'s
  // rotate-token deps and its own startup/periodic recovery. Attached via `Object.assign` (not
  // the object literal itself) so that literal still gets full excess-property checking against
  // the frozen `HttpFrontend` shape — every other caller of this factory stays byte-identical.
  return Object.assign(frontend, {
    auth,
    revokeAllSse: () => {
      // web-hub-html-preview plan v2 §2.4: token rotate (`revokeLoopbackSse`) also ends every
      // loopback-minted HTML capability.
      authRevoke.emit({ sel: { listener: "loopback" }, reason: "rotate" });
      return sse.revoke(() => true, "revoked");
    },
    /** XA §4.2: attach a revocation subscriber (the proxy package's duck-typed hook; returns the
     * unsubscribe). Subscribers run synchronously, in subscription order, exception-isolated. */
    subscribeAuthRevoke: (fn: Parameters<AuthRevokeBus["subscribe"]>[0]) => authRevoke.subscribe(fn),
    /** web-hub-proxy §3.4 (X1c): the LIVE LAN host allow-list (`undefined` ⇒ LAN down) — read per
     * request by the proxy listeners, never captured. */
    lanHostSnapshot: () => lanHostSnapshot(),
    bumpLanRevokeGen: () => {
      lanRevokeGen++;
    },
    lanRevokeGen: () => lanRevokeGen,
  });
};
