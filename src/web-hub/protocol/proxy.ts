/**
 * web-hub port-proxy protocol (web-hub-proxy plan v2 §12 package X0 — frozen surface).
 *
 * Pure TypeScript, ZERO imports (`node:*`-free, DOM-free): the browser UI reaches it through the
 * `@protocol` alias exactly like `protocol/preview-html.ts`, while the hub's X1a/X1b/X1c packages
 * (`hub/proxy/*`, `hub/http.ts`, `hub/hub.ts`) and the UI's X2 package build against the same
 * constants — ONE module so the hub side and the UI side can never drift. Nothing here is
 * consumed at runtime yet: X0 ships declarations only (no route, no listener, no cap
 * advertisement); `webHub.proxy.enabled` stays off by default and the hub is byte-identical.
 *
 * Frozen here (every value cites its plan section; values the plan leaves open are marked
 * "X0 decision" and recorded in `docs/dev/web-hub-proxy/X0-report.md`):
 * - the three hub API paths + the reserved proxy-listener prefix + the gate cookie name (§3.5/§3.8);
 * - port range / instance caps / TTLs (§0 Q3/Q4, §3.2–§3.4);
 * - request admission / WebSocket / timeout / header-size caps and the Node `http.Server` options (§3.5–§3.7);
 * - the closed deny-reason sets, their HTTP status/error-code mapping and the JSON body shapes (§3.8);
 * - the open / list / stop wire bodies (§3.4/§3.8);
 * - the log event names and field whitelist (§7), the fixed page copy (§3.5) and the
 *   `webHub.proxy.portRange` text grammar shared by the settings parser and the hub (§5).
 *
 * NOT here: the SSRF fence tables (`hub/proxy/target.ts`, X1a), hop-by-hop header lists
 * (`hub/proxy/headers.ts`, X1a) and the `ports.json` IO budgets (64 KiB / 1 s load, 2 s write —
 * deliberately internal to `hub/proxy/ports-map.ts` so tests can shrink them, plan author's call).
 */

// ---------------------------------------------------------------------------
// paths, prefixes, cookie (§3.5 / §3.8)
// ---------------------------------------------------------------------------

/** §3.8: `POST` — open (or reuse) a proxy for `{target}`; strictCsrfOk → resolveIdentity → bucket. */
export const PROXY_OPEN_PATH = "/api/proxy/open";
/** §3.8: `GET` (`X-PWH: 1`) — list the live proxies + policy. */
export const PROXY_LIST_PATH = "/api/proxy";
/** §3.8: `POST` — stop one instance by id. */
export const PROXY_STOP_PATH = "/api/proxy/stop";

/** §3.5 step 3: every path under this prefix on a proxy listener belongs to the proxy itself and
 * is NEVER forwarded to a target (anything but `enter` ⇒ 404). */
export const PROXY_RESERVED_PREFIX = "/__pwh_proxy__/";
/** §3.5 step 3: `GET /__pwh_proxy__/enter?c=<code>` — one-time code exchange. */
export const PROXY_ENTER_PATH = "/__pwh_proxy__/enter";
/** §3.5 step 3: the query parameter carrying the one-time code. */
export const PROXY_ENTER_QUERY = "c";

/** §3.5 step 3: gate cookie name is `pwh_px_<port>` (one cookie per proxy origin). Disjoint from
 * the hub's `pwh_sid` / `pwh_lan` — proxy listeners never read those and hub routes never read this. */
export const PROXY_COOKIE_PREFIX = "pwh_px_";

/** `pwh_px_<port>` (§3.5 step 3). */
export function proxyCookieName(port: number): string {
  return `${PROXY_COOKIE_PREFIX}${String(port)}`;
}

/** §3.6: cookie pairs / `Set-Cookie` names starting with this prefix are hub credentials — dropped
 * on the way to a target (request `Cookie`) and from a target (response `Set-Cookie`). */
export const PROXY_STRIPPED_COOKIE_PREFIX = "pwh_";

/** §3.6: response header an upstream must never be able to relay (it could wipe hub cookies/storage). */
export const PROXY_DROPPED_RESPONSE_HEADERS = ["clear-site-data"] as const;

/** §3.6 request-header drops beyond hop-by-hop + `Connection`-listed tokens: exact names. */
export const PROXY_DROPPED_REQUEST_HEADERS = ["x-pwh", "forwarded", "x-real-ip"] as const;
/** §3.6 request-header drops by prefix (`Proxy-*`, incoming `X-Forwarded-*`). */
export const PROXY_DROPPED_REQUEST_HEADER_PREFIXES = ["proxy-", "x-forwarded-"] as const;

/** `http://<browserHost>:<port>` — the per-instance browser origin (§3.4: `"http://" +
 * canonicalHostKey(Host)`; `browserHost` is the host part, an IPv4 literal or hostname). */
export function proxyOriginOf(browserHost: string, port: number): string {
  return `http://${browserHost}:${String(port)}`;
}

/** §2/§3.4: `enterUrl = <origin>/__pwh_proxy__/enter?c=<code>` (code is base64url — never needs escaping). */
export function buildProxyEnterUrl(origin: string, code: string): string {
  return `${origin}${PROXY_ENTER_PATH}?${PROXY_ENTER_QUERY}=${code}`;
}

// ---------------------------------------------------------------------------
// in-page framing (link-preview plan §2.2 / §2.5, LP0)
// ---------------------------------------------------------------------------

/** §2.5 / D5: cross-origin app permissions; never allow-top-navigation* or credentialless.
 * Popups can escape: this only protects the hub page, NOT a sandbox for malicious apps. */
export const PROXY_FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";
/** §2.5: the iframe's Permissions Policy allow attribute. */
export const PROXY_FRAME_ALLOW = "clipboard-write; fullscreen";
/** §2.2: the listener's existing strict CSP without frame-ancestors. Append that directive per
 * request; without a validated Host the listener must retain frame-ancestors 'none' + XFO DENY. */
export const PROXY_STRICT_CSP_BASE =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'";

/** §2.2: sources for proxy-generated pages only, from a VALIDATED canonical hostname (IPv6
 * stays bracketed) and the actual bound hub/LAN ports. Never pass raw Host header bytes. */
export function proxyFrameAncestors(hostname: string, hubPort: number, lanPort?: number): string {
  return `'self' ${proxyOriginOf(hostname, hubPort)}${lanPort === undefined ? "" : ` ${proxyOriginOf(hostname, lanPort)}`}`;
}

/** §2.2: per-request framing policy after Host validation; absence keeps strict listener headers.
 * This must never be applied to upstream responses (their XFO/CSP pass through untouched). */
export type ProxyReplyPolicy = { frameAncestors: string };

// ---------------------------------------------------------------------------
// port range + instance limits (§0 Q3/Q4, §3.3, §3.4, §5)
// ---------------------------------------------------------------------------

/** §0 Q3: default proxy port range, inclusive. */
export const PROXY_DEFAULT_PORT_RANGE: readonly [number, number] = Object.freeze([7900, 7949] as const);
/** §5: the on-disk text form of the default range (`webHub.proxy.portRange`). */
export const PROXY_DEFAULT_PORT_RANGE_TEXT = "7900-7949";
/** §0 Q3: default cap on concurrent proxies. */
export const PROXY_DEFAULT_MAX_PROXIES = 8;
/** §5: `webHub.proxy.maxProxies` accepted domain 1..16 (anything else ⇒ default + warning). */
export const PROXY_MAX_PROXIES_MIN = 1;
export const PROXY_MAX_PROXIES_MAX = 16;
/** §5: a configured range spanning more than this many ports ⇒ default + warning. */
export const PROXY_PORT_RANGE_MAX_SPAN = 256;
/** X0 decision (conservative): the lowest port a configured range may start at — never a
 * privileged port (the plan only forbids hub/LAN overlap and > 256 ports). */
export const PROXY_PORT_RANGE_MIN_PORT = 1024;
export const PROXY_PORT_RANGE_MAX_PORT = 65_535;
/** §3.4 step 2: at most this many live proxies per principal (global cap is `maxProxies`). */
export const PROXY_PER_PRINCIPAL_MAX = 4;
/** §3.3: a NEW target tries `listen` on at most this many unmapped ports (skipping `EADDRINUSE`). */
export const PROXY_PORT_BIND_ATTEMPTS = 8;
/** §3.3: ports.json schema version. */
export const PROXY_PORTS_FILE_VERSION = 1;
/** §3.3: `<stateDir>/proxy/ports.json` — directory + file name (0600). */
export const PROXY_STATE_DIR_NAME = "proxy";
export const PROXY_PORTS_FILE_NAME = "ports.json";

/** §3.4: the listener binds `0.0.0.0` iff `config.lan` exists (Q2), else loopback. */
export const PROXY_BIND_HOST_LAN = "0.0.0.0";
export const PROXY_BIND_HOST_LOOPBACK = "127.0.0.1";

/** §3.4: per-creation `listen` deadline. */
export const PROXY_LISTEN_TIMEOUT_MS = 2_000;
/** §3.1: the 1-slot DNS gate's caller deadline (the slot is held until the lookup really settles). */
export const PROXY_DNS_TIMEOUT_MS = 2_000;
/** §3.4: the hub's close deadline `dispose()` is bounded by. */
export const PROXY_CLOSE_DEADLINE_MS = 2_000;

/**
 * §5 grammar of `webHub.proxy.portRange`: `"<lo>-<hi>"`, decimal digits only, no leading zero, no
 * whitespace inside (outer whitespace trimmed), `lo ≤ hi`, both in
 * [{@link PROXY_PORT_RANGE_MIN_PORT}, {@link PROXY_PORT_RANGE_MAX_PORT}], span ≤
 * {@link PROXY_PORT_RANGE_MAX_SPAN}. A single port or any other spelling is `undefined`
 * (X0 decision: strict, no `"7900"` shorthand). Never throws.
 *
 * The overlap-with-hub/LAN-port rule needs runtime ports and lives in
 * {@link proxyRangeContainsPort}; `config/settings.ts` carries a parity copy of this parser
 * (it may not value-import this module — `tests/web-hub/boundary.test.ts` freezes its closure),
 * pinned against this one by `tests/web-hub/protocol/proxy.test.ts`.
 */
export function parseProxyPortRange(text: unknown): [number, number] | undefined {
  if (typeof text !== "string") return undefined;
  const m = /^([1-9]\d{0,4})-([1-9]\d{0,4})$/.exec(text.trim());
  if (m === null) return undefined;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (lo > hi) return undefined;
  if (lo < PROXY_PORT_RANGE_MIN_PORT || hi > PROXY_PORT_RANGE_MAX_PORT) return undefined;
  if (hi - lo + 1 > PROXY_PORT_RANGE_MAX_SPAN) return undefined;
  return [lo, hi];
}

/** Inverse of {@link parseProxyPortRange}. */
export function formatProxyPortRange(range: readonly [number, number]): string {
  return `${String(range[0])}-${String(range[1])}`;
}

/** Inclusive membership test (used by the settings overlap check and §3.1's self-port rule). */
export function proxyRangeContainsPort(range: readonly [number, number], port: number): boolean {
  return Number.isInteger(port) && port >= range[0] && port <= range[1];
}

// ---------------------------------------------------------------------------
// secrets, codes, sessions, revocation (§3.2)
// ---------------------------------------------------------------------------

/** §3.2: codes and session ids are `randomBytes(32)` base64url, stored only as `sha256`. */
export const PROXY_SECRET_BYTES = 32;
/** 43 base64url chars — the shape of a code / gate-cookie value. Anchored; anything else is invalid. */
export const PROXY_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
/** X0 decision: the grammar `POST /api/proxy/stop` accepts for `instanceId` (opaque; the engine
 * picks a value inside it). Looser than the secret shape — an instance id is not a credential. */
export const PROXY_INSTANCE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** §3.2: one-time code lifetime (`expAt = now + 60 s`). */
export const PROXY_CODE_TTL_MS = 60_000;
/** §0 Q4: proxy session idle limit (never beyond the parent hub login). */
export const PROXY_SESSION_IDLE_MS = 2 * 60 * 60_000;
/** §0 Q4: proxy session absolute limit — `hardAt = min(now + 12 h, parentExpiresAt)`. */
export const PROXY_SESSION_HARD_MS = 12 * 60 * 60_000;
/** §3.2: `lastUsedAt` refresh on WS data is throttled to once per this window. */
export const PROXY_TOUCH_THROTTLE_MS = 60_000;

/** §3.2: caps per instance — refuse the new one, never evict. */
export const PROXY_CODES_PER_INSTANCE = 16;
export const PROXY_SESSIONS_PER_INSTANCE = 16;
/** §3.2 "128 global". X0 decision: the global cap applies to codes AND sessions independently. */
export const PROXY_CODES_GLOBAL = 128;
export const PROXY_SESSIONS_GLOBAL = 128;
/** §3.2: revocation tombstone ring size (a `seq0` older than the oldest ⇒ fail closed 503). */
export const PROXY_TOMBSTONE_RING = 256;

/** §3.4: an instance with no sockets and no request for this long closes (its port binding stays). */
export const PROXY_INSTANCE_IDLE_MS = 15 * 60_000;
/** §3.4: the (unref'd) idle sweep interval, alive only while ≥ 1 instance exists. */
export const PROXY_SWEEP_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// listener / admission / forwarding / WebSocket caps (§3.5–§3.7)
// ---------------------------------------------------------------------------

/** §3.5: the `http.Server` options of every proxy listener (`connectionsCheckingInterval: 1000`
 * so half-sent headers die within ≤ 11 s, not ≤ 40 s — §R1 #11). */
export const PROXY_SERVER_OPTIONS = Object.freeze({
  maxHeaderSize: 16_384,
  headersTimeout: 10_000,
  requestTimeout: 300_000,
  keepAliveTimeout: 5_000,
  connectionsCheckingInterval: 1_000,
} as const);
/** §3.5: `server.maxRequestsPerSocket`. */
export const PROXY_MAX_REQUESTS_PER_SOCKET = 1_000;
/** §3.5: non-WebSocket socket idle timeout. */
export const PROXY_SOCKET_TIMEOUT_MS = 120_000;
/** §3.5: the shared conn-guard (`createConnGuard`) options — direct pool only. */
export const PROXY_CONN_GUARD = Object.freeze({
  directTotalPerIp: 48,
  directUnauthPoolCap: 32,
  directUnauthPerIpCap: 8,
  maxConnections: 256,
} as const);
/** §3.5 step 3: `enter` per-IP bucket (requests per minute); a bad code counts double. */
export const PROXY_ENTER_RATE_PER_MIN = 20;
export const PROXY_ENTER_BAD_CODE_WEIGHT = 2;
/** §3.5 step 3: `safeOriginForm` rejects a path?query longer than this. */
export const PROXY_NEXT_PATH_MAX_BYTES = 2048;

/** §3.6: admission — active upstream requests per instance / globally. */
export const PROXY_ACTIVE_PER_INSTANCE = 32;
export const PROXY_ACTIVE_GLOBAL = 128;
/** §3.6: FIFO waiters per instance / globally, and the max residence ⇒ 503 `Retry-After: 1`. */
export const PROXY_QUEUE_PER_INSTANCE = 64;
export const PROXY_QUEUE_GLOBAL = 256;
export const PROXY_QUEUE_WAIT_MS = 10_000;
export const PROXY_RETRY_AFTER_S = 1;
/** §3.6: per-instance upstream `http.Agent` (`maxSockets` = the active cap, so its unbounded queue is never used). */
export const PROXY_AGENT_OPTIONS = Object.freeze({
  keepAlive: true,
  maxSockets: 32,
  maxFreeSockets: 4,
  timeout: 60_000,
} as const);
/** §3.6: upstream timers (all unref'd): connect ⇒ 502, response head ⇒ 504, upstream idle ⇒ destroy. */
export const PROXY_CONNECT_TIMEOUT_MS = 5_000;
export const PROXY_HEAD_TIMEOUT_MS = 120_000;
export const PROXY_UPSTREAM_IDLE_MS = 300_000;
/** §3.6: request-body counting-Transform cap ⇒ 413 (head unsent) or destroy. */
export const PROXY_REQUEST_BODY_MAX_BYTES = 256 * 1024 * 1024;
/** §3.6: upstream request/response header cap. */
export const PROXY_MAX_HEADER_BYTES = 16_384;
/** §3.6: the explicit stream highWaterMark (Node 22 default for byte streams). */
export const PROXY_STREAM_HWM_BYTES = 65_536;

/** §3.7: a 10 s destroy deadline armed immediately on `upgrade`, cleared only after the 101 is written. */
export const PROXY_WS_HANDSHAKE_MS = 10_000;
/** §3.7: established-WS idle limit (each side `setTimeout`) ⇒ destroy both. */
export const PROXY_WS_IDLE_MS = 30 * 60_000;
/** §3.7: concurrent WebSockets per instance / globally ⇒ 503. */
export const PROXY_WS_PER_INSTANCE = 32;
export const PROXY_WS_GLOBAL = 64;
/** §3.7: a non-101 upstream answer to an Upgrade is relayed (filtered headers) with at most this much body. */
export const PROXY_WS_NON101_BODY_MAX_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// hub API: bodies (§3.4 / §3.8)
// ---------------------------------------------------------------------------

/** §3.8: `POST /api/proxy/open` body cap. */
export const PROXY_OPEN_MAX_BODY_BYTES = 2 * 1024;
/** §3.8: open/stop bucket — capacity 10, +1 token per 6 s, per principal. */
export const PROXY_OPEN_BUCKET_CAPACITY = 10;
export const PROXY_OPEN_BUCKET_REFILL_MS = 6_000;

/** §3.1: the closed classification of an ALLOWED target address (the UI renders it verbatim). */
export const PROXY_TARGET_CLASSES = ["loopback", "private", "cgnat", "ula"] as const;
export type ProxyTargetClass = (typeof PROXY_TARGET_CLASSES)[number];

/** §3.4: the target as the hub reports it (`host` is the user-typed host token, `port` 1–65535). */
export interface ProxyTargetWire {
  readonly host: string;
  readonly port: number;
  readonly cls: ProxyTargetClass;
}

/** `POST /api/proxy/open` request body (≤ {@link PROXY_OPEN_MAX_BODY_BYTES}): `host:port`,
 * `http://host:port[/path?query]` or `[v6]:port` (§3.1). */
export interface ProxyOpenRequestBody {
  readonly target: string;
}

/** §3.4 step 7 / §3.8: the 200 answer. */
export interface ProxyOpenResult {
  readonly instanceId: string;
  /** `http://<browserHost>:<port>` */
  readonly origin: string;
  /** `<origin>/__pwh_proxy__/enter?c=<code>` — open it in a NEW tab (§8). */
  readonly enterUrl: string;
  readonly target: ProxyTargetWire;
}

/** §3.8: one `GET /api/proxy` item (`mine` — opened by the requesting principal). */
export interface ProxyListItem {
  readonly instanceId: string;
  readonly target: ProxyTargetWire;
  readonly origin: string;
  readonly createdAt: number;
  readonly mine: boolean;
}

/** §3.8: the policy block (`portRange` is a tuple like `HubConfig.proxy`; `lan` = `config.lan` exists, Q2). */
export interface ProxyPolicyWire {
  readonly maxProxies: number;
  readonly portRange: readonly [number, number];
  readonly lan: boolean;
}

/** §3.8: `GET /api/proxy` 200 body. */
export interface ProxyListResponse {
  readonly items: readonly ProxyListItem[];
  readonly policy: ProxyPolicyWire;
}

/** §3.8: `POST /api/proxy/stop` request body. */
export interface ProxyStopRequestBody {
  readonly instanceId: string;
}

/** X0 decision: `POST /api/proxy/stop` 200 body (the plan says only "200 · 404"). */
export interface ProxyStopResponse {
  readonly ok: true;
}

// ---------------------------------------------------------------------------
// hub API: deny reasons, error codes, status mapping (§3.8)
// ---------------------------------------------------------------------------

/** §3.8: the closed set of deny reasons (`protocol/proxy.ts` is its home; order = plan order). */
export const PROXY_DENY_REASONS = [
  "syntax",
  "scheme",
  "userinfo",
  "port",
  "public",
  "link-local",
  "metadata",
  "multicast",
  "reserved",
  "translation",
  "unspecified",
  "mixed-answer",
  "dns-failed",
  "dns-timeout",
  "self-port",
  "port-busy",
  "ports-exhausted",
  "ports-store",
  "reverse-proxy",
] as const;
export type ProxyDenyReason = (typeof PROXY_DENY_REASONS)[number];

/** The proxy-specific error codes (X0 decision: NOT yet appended to `http-contract.ts`'s
 * `API_ERRORS` — that file is outside X0's domain; X1c appends the first two, tail-only).
 * `E_LIMIT` / `E_RATE` are existing codes. */
export const PROXY_ERROR_CODES = ["E_PROXY_DENIED", "E_PROXY_UNAVAILABLE"] as const;
export type ProxyErrorCode = (typeof PROXY_ERROR_CODES)[number];

/** Which wire error a reason is answered with, and the HTTP status (§3.8: 400/403 `E_PROXY_DENIED`,
 * 409 `E_LIMIT`/`E_PROXY_UNAVAILABLE`, 503). The plan lists the reasons and the status classes but
 * not the per-reason pairing — X0 decision, conservative: malformed input ⇒ 400, address-class
 * refusals ⇒ 403, resource/availability ⇒ 409/503. */
export const PROXY_REASON_RESPONSE = Object.freeze({
  syntax: { status: 400, error: "E_PROXY_DENIED" },
  scheme: { status: 400, error: "E_PROXY_DENIED" },
  userinfo: { status: 400, error: "E_PROXY_DENIED" },
  port: { status: 400, error: "E_PROXY_DENIED" },
  public: { status: 403, error: "E_PROXY_DENIED" },
  "link-local": { status: 403, error: "E_PROXY_DENIED" },
  metadata: { status: 403, error: "E_PROXY_DENIED" },
  multicast: { status: 403, error: "E_PROXY_DENIED" },
  reserved: { status: 403, error: "E_PROXY_DENIED" },
  translation: { status: 403, error: "E_PROXY_DENIED" },
  unspecified: { status: 403, error: "E_PROXY_DENIED" },
  "mixed-answer": { status: 403, error: "E_PROXY_DENIED" },
  "dns-failed": { status: 400, error: "E_PROXY_DENIED" },
  "self-port": { status: 403, error: "E_PROXY_DENIED" },
  "dns-timeout": { status: 503, error: "E_PROXY_UNAVAILABLE" },
  "port-busy": { status: 503, error: "E_PROXY_UNAVAILABLE" },
  "ports-store": { status: 503, error: "E_PROXY_UNAVAILABLE" },
  "ports-exhausted": { status: 409, error: "E_LIMIT" },
  "reverse-proxy": { status: 409, error: "E_PROXY_UNAVAILABLE" },
} as const satisfies Record<ProxyDenyReason, { readonly status: number; readonly error: ProxyErrorCode | "E_LIMIT" }>);

/** 409 `E_LIMIT` reasons (§3.4 step 2 `proxies`, §3.3 `ports-exhausted`). */
export const PROXY_LIMIT_REASONS = ["proxies", "ports-exhausted"] as const;
export type ProxyLimitReason = (typeof PROXY_LIMIT_REASONS)[number];

/** X0 decision: extra 503 `E_PROXY_UNAVAILABLE` reasons that are not target denials —
 * `closing` (§3.4 closing fence), `revocation-gap` (§3.2 tombstone gap, retryable),
 * `listen-timeout` (§3.4 per-creation listen deadline). `ports-store` (also a persist failure)
 * is in {@link PROXY_DENY_REASONS}. */
export const PROXY_UNAVAILABLE_EXTRA_REASONS = ["closing", "revocation-gap", "listen-timeout"] as const;
export type ProxyUnavailableExtraReason = (typeof PROXY_UNAVAILABLE_EXTRA_REASONS)[number];

/** X0 decision: 429 `E_RATE` reasons for the §3.2 code/session caps ("Overflow ⇒ refuse the new one (429)"). */
export const PROXY_CAP_REASONS = ["codes", "sessions"] as const;
export type ProxyCapReason = (typeof PROXY_CAP_REASONS)[number];

/** 400/403 `E_PROXY_DENIED` body. */
export interface ProxyDeniedBody {
  readonly error: "E_PROXY_DENIED";
  readonly reason: ProxyDenyReason;
}
/** 409/503 `E_PROXY_UNAVAILABLE` body. */
export interface ProxyUnavailableBody {
  readonly error: "E_PROXY_UNAVAILABLE";
  readonly reason: ProxyDenyReason | ProxyUnavailableExtraReason;
}
/** 409 `E_LIMIT` body (§3.4 `proxies`, §3.3 `ports-exhausted`). */
export interface ProxyLimitBody {
  readonly error: "E_LIMIT";
  readonly reason: ProxyLimitReason;
}
/** 429 `E_RATE` body for the code/session caps. */
export interface ProxyCapBody {
  readonly error: "E_RATE";
  readonly reason: ProxyCapReason;
}
/** Every error body a proxy route can answer with. */
export type ProxyErrorBody = ProxyDeniedBody | ProxyUnavailableBody | ProxyLimitBody | ProxyCapBody;

/** §4.1: the 401 `E_AUTH` conflict reason (`{ error: "E_AUTH", reason }`) — a parity copy of
 * `hub/auth-identity.ts`'s `COOKIE_CONFLICT_REASON` (protocol may not import hub; pinned equal by test). */
export const PROXY_COOKIE_CONFLICT_REASON = "cookie-conflict";

// ---------------------------------------------------------------------------
// proxy-listener fixed responses (§3.5)
// ---------------------------------------------------------------------------

/** §3.5: statuses the proxy listener itself answers (everything else is the upstream's). */
export const PROXY_LISTENER_STATUS = Object.freeze({
  /** Host header not in the allow-list (§3.4). */
  hostMismatch: 421,
  /** `TRACE`/`TRACK`. */
  methodNotAllowed: 405,
  /** absolute-form / `*` request target. */
  badTarget: 400,
  /** `enter`: invalid/expired/consumed code. */
  enterFailed: 410,
  /** gate cookie missing/dead/foreign. */
  gateFailed: 401,
  /** unsafe-method cross-origin (§3.5 step 6) / WS Origin mismatch (§3.7). */
  originForbidden: 403,
  /** any other `/__pwh_proxy__/*`. */
  reservedNotFound: 404,
  /** queue full / deadline / WS cap. */
  busy: 503,
  /** `enter` bucket exhausted. */
  rateLimited: 429,
  /** upstream connect failure / head timeout / request body cap. */
  badGateway: 502,
  gatewayTimeout: 504,
  bodyTooLarge: 413,
} as const);

/** §3.5 step 3: the fixed expired/unauthorized page copy (zh + en). */
export const PROXY_EXPIRED_PAGE_ZH = "链接已失效，请回到 hub 重新打开";
export const PROXY_EXPIRED_PAGE_EN = "Link expired";

// ---------------------------------------------------------------------------
// logging (§7)
// ---------------------------------------------------------------------------

/** §7: the two proxy log event names. */
export const PROXY_LOG_EVENTS = ["proxy-open", "proxy-end"] as const;
/** §7: `proxy-open` field whitelist (`target` is `"<ip>:<port>"`; `host`/`port` optional). */
export const PROXY_OPEN_LOG_FIELDS = [
  "ok",
  "reason",
  "principal",
  "listener",
  "cls",
  "target",
  "host",
  "port",
] as const;
/** §7: `proxy-end` field whitelist (per session and per instance). */
export const PROXY_END_LOG_FIELDS = ["instTag", "end", "reqs", "bytesUp", "bytesDown", "ws"] as const;
/** §7: denials are throttled to one log line per instance per this window. */
export const PROXY_DENY_LOG_THROTTLE_MS = 60_000;
