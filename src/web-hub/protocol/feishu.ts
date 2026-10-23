/**
 * web-hub Feishu bot protocol (feishu-bot plan v2 §12/§14 package F0 — frozen surface).
 *
 * Pure TypeScript + typebox: `node:*`-free, pi-free, DOM-free. Everything the later packages
 * (F1 frame/chunks, F2 http/token/api, F3 connector, F4 state/credentials, F6 admission/requests,
 * F7 render/outbox, F8 service, FA hub assembly, F9 `/webhub feishu`) must agree on is frozen here
 * in ONE module — limits, caps, TTLs, timer bounds, destination allowlists, the bot status
 * vocabulary, the `fsb_req`/`fsb_res` agent↔hub frame schemas (folded into the two decode tables
 * by `protocol/messages.ts`, append-only), the `HubConfig.feishuBot` shape + its normalizer, the
 * request-token header (§R2-a) and the tenant-fact helpers (V10 `create_time` units, V11 codes).
 *
 * Nothing here is consumed at runtime yet: F0 ships declarations + pure helpers only (no hub
 * wiring, no cap advertisement — FA owns that). `feishuBot.enabled` stays off by default, so the
 * hub and the agent are byte-identical until FA lands.
 *
 * Module-boundary rules:
 * - `src/config/settings.ts` may NOT value-import this module (`tests/web-hub/boundary.test.ts`
 *   freezes its import closure). Its `feishuBot` defaults/ranges are literal mirrors; the parity
 *   tests in `tests/web-hub/protocol/feishu.test.ts` pin the two copies equal.
 * - `protocol/messages.ts` imports the frame schemas from here at top level, so this module must
 *   never value-import `messages.js` (TDZ; same rule as `run-transcript.ts`).
 *
 * Tenant facts (probe-results.md, real tenant 2026-10-18): V1–V6, V8–V11 positive; V7 (cross-
 * connection redelivery) and V12 unknown — nothing frozen here depends on them (the dedup TTL is
 * the plan's ≥72 h conservative value).
 */
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// frame / op / error identifiers (`fsb_*`, §9)
// ---------------------------------------------------------------------------

/** Agent→hub request frame type (`fsb_req {rid, op, …}`). Sent only when `hello_ack.caps ∋ fsb.v1`. */
export const FSB_REQ_TYPE = "fsb_req";
/** Hub→agent response frame type (`fsb_res {rid, ok, data|code,message}`). */
export const FSB_RES_TYPE = "fsb_res";

/**
 * The closed `fsb_req` op vocabulary. `info` is the wire op behind the `/webhub feishu status`
 * slash subcommand. Nothing else is reachable over this channel — setup/status/cancel/replace exist
 * only as local TUI commands (§R2-e: no web/LAN surface in v1).
 */
export const FSB_OPS = [
  "info",
  "setup_begin",
  "setup_status",
  "setup_cancel",
  "allow",
  "deny",
  "repair",
  "reset",
] as const;
export type FsbOp = (typeof FSB_OPS)[number];

/** Ops that mutate credentials/state destructively: the wire carries an explicit `confirm:true` (TUI confirmed). */
export const FSB_CONFIRM_OPS = ["repair", "reset"] as const;

/** `fsb_res{ok:false}.code` vocabulary (plan author, F0 consult). Wire accepts any `E_FSB_*` (forward compat). */
export const FSB_ERROR_CODES = [
  /** no credentials yet (status `unconfigured`/`off`): allow/deny/reset/repair have nothing to act on */
  "E_FSB_UNCONFIGURED",
  /** `setup_begin` conflicts with a running setup generation that cannot be adopted (e.g. replace while another runs) */
  "E_FSB_SETUP_ACTIVE",
  /** `replace` without `confirm`, or `repair`/`reset` without `confirm:true` */
  "E_FSB_CONFIRM_REQUIRED",
  /** allow-list full (cap {@link FEISHU_CAPS.allowList}) */
  "E_FSB_CAP",
  /** malformed op params (bad open_id, …) */
  "E_FSB_BAD_REQUEST",
  /** bot degraded/stopped state refuses the op (e.g. `state-corrupt` before `repair`) */
  "E_FSB_STATE",
] as const;
export type FsbErrorCode = (typeof FSB_ERROR_CODES)[number];

/** `fsb_res{ok:false}.code` wire shape (open-ended on purpose: an old agent must not drop a new hub's refusal). */
export const FSB_ERROR_CODE_WIRE_RE = /^E_FSB_[A-Z0-9_]{1,32}$/;

/** Feishu open_id (per-app, `ou_…`); the ONLY identity key — `user_id` is null without contacts scope (V2a). */
export const FEISHU_OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// bot status machine (§1) + wire shapes
// ---------------------------------------------------------------------------

/** §1 bot status machine: one value, shown by status/web. */
export const FEISHU_BOT_STATUSES = [
  "off",
  "unconfigured",
  "setup",
  "connecting",
  "open",
  "degraded",
  "auth_failed",
  "conn_limit",
  "stopped",
] as const;
export type FeishuBotStatus = (typeof FEISHU_BOT_STATUSES)[number];

/**
 * §1 `degraded` reasons (a fixed set plus the parametrized `capability-denied:<x>`). Statuses
 * that keep credentials loaded (every status except `off`/`unconfigured`) also count for the
 * `bot:1` idle keepalive (Q1) — see {@link feishuKeepaliveActive}.
 */
export const FEISHU_DEGRADED_REASONS = [
  "state-corrupt",
  "credentials-unsafe",
  "persist-failed",
  "ws-unavailable",
  "undecodable-events",
] as const;
export type FeishuDegradedReason = (typeof FEISHU_DEGRADED_REASONS)[number] | `capability-denied:${string}`;

/** Capability names that can be probed `ok`/`denied`/`unknown` at runtime (§4 "capability probing", §10). */
export const FEISHU_CAPABILITY_NAMES = ["cards", "reactions", "files", "cardCallback"] as const;
export type FeishuCapabilityName = (typeof FEISHU_CAPABILITY_NAMES)[number];
export const FEISHU_CAPABILITY_STATES = ["ok", "denied", "unknown"] as const;
export type FeishuCapabilityState = (typeof FEISHU_CAPABILITY_STATES)[number];

/** `capability-denied:<x>` reason string for a capability. */
export function capabilityDeniedReason(name: FeishuCapabilityName): `capability-denied:${FeishuCapabilityName}` {
  return `capability-denied:${name}`;
}

/** §1 Q1 keepalive: credentials loaded ⇔ any status except `off`/`unconfigured` (incl. `degraded`/`auth_failed`; `stopped` too until reset). */
export function feishuKeepaliveActive(status: FeishuBotStatus): boolean {
  return status !== "off" && status !== "unconfigured";
}

// ---------------------------------------------------------------------------
// brands + destination allowlists (§2.2, R1 #7)
// ---------------------------------------------------------------------------

/** Credential `brand` (§4.4). `feishu` = mainland (probe-confirmed), `lark` = international. */
export const FEISHU_BRANDS = ["feishu", "lark"] as const;
export type FeishuBrand = (typeof FEISHU_BRANDS)[number];

/** §2.2: `apiBase` per brand — the ONLY open-API origins the bot talks to. */
export const FEISHU_API_BASES: Readonly<Record<FeishuBrand, string>> = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
};
/** §2.2: registration (device flow) origins — the ONLY other HTTPS destinations. */
export const FEISHU_REGISTRATION_BASES: Readonly<Record<FeishuBrand, string>> = {
  feishu: "https://accounts.feishu.cn",
  lark: "https://accounts.larksuite.com",
};
/**
 * §2.2 WS host suffix allowlist (frozen from the F-probe P2 observation: `msg-frontier.feishu.cn`).
 * A host qualifies iff it is a PROPER subdomain (`endsWith(".feishu.cn")`) — the bare apex does not.
 */
export const FEISHU_WS_HOST_SUFFIXES = [".feishu.cn", ".larksuite.com"] as const;

export function isFeishuBrand(value: unknown): value is FeishuBrand {
  return value === "feishu" || value === "lark";
}

/** True iff `base` is exactly one of the two frozen open-API origins (no path, no trailing slash). */
export function isAllowedApiBase(base: unknown): boolean {
  return typeof base === "string" && (base === FEISHU_API_BASES.feishu || base === FEISHU_API_BASES.lark);
}

/** True iff `base` is exactly one of the two frozen registration origins. */
export function isAllowedRegistrationBase(base: unknown): boolean {
  return (
    typeof base === "string" && (base === FEISHU_REGISTRATION_BASES.feishu || base === FEISHU_REGISTRATION_BASES.lark)
  );
}

/**
 * §2.2: the WS endpoint URL returned by bootstrap must be `wss:`, carry no userinfo, use the default
 * port (443) and a hostname that is a proper subdomain of `.feishu.cn` / `.larksuite.com`.
 * Hostnames are compared case-insensitively, a trailing dot is refused (it would make a distinct
 * DNS name), and IP literals can never match a suffix. Anything else ⇒ refuse + `degraded`.
 */
export function isAllowedWsUrl(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "wss:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.port !== "" && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  if (host.endsWith(".")) return false;
  return FEISHU_WS_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

// ---------------------------------------------------------------------------
// error-code classification (§2.1 enum.ts + V11 probe)
// ---------------------------------------------------------------------------

/** §2.1 bootstrap success. */
export const FEISHU_CODE_OK = 0;
/** §2.1 enum.ts `system_busy` ⇒ retryable backoff. */
export const FEISHU_CODE_SYSTEM_BUSY = 1;
/** §2.1 enum.ts `internal` ⇒ retryable backoff. */
export const FEISHU_CODE_INTERNAL = 1_000_040_343;
/** §2.1 enum.ts `exceed_conn_limit` ⇒ `conn_limit`. */
export const FEISHU_CODE_EXCEED_CONN_LIMIT = 1_000_040_350;

/** Retryable bootstrap codes (backoff `min(60 s, 2^n s)` full jitter, §2.4). */
export const FEISHU_BOOTSTRAP_RETRYABLE_CODES: readonly number[] = [FEISHU_CODE_SYSTEM_BUSY, FEISHU_CODE_INTERNAL];

/**
 * Codes mapped to `auth_failed` (retry every 10 min, message surfaced). §2.1: `514` auth_failed and
 * `403` forbidden (SDK enum); plan §R/V11: `10003`; probe V11 (real tenant, wrong secret):
 * bootstrap `1000040345` and `tenant_access_token` `10014`. Every OTHER non-zero code (that is not
 * retryable / conn-limit) is ALSO `auth_failed` with the code surfaced — this table names the
 * known members, {@link classifyBootstrapCode} is the authority.
 */
export const FEISHU_AUTH_FAILED_CODES: readonly number[] = [514, 403, 10_003, 10_014, 1_000_040_345];

/** Token endpoint: stale/invalid tenant token ⇒ invalidate + retry ONCE (§3). */
export const FEISHU_TOKEN_INVALID_CODES: readonly number[] = [99_991_663, 99_991_664];
/** §3 send classification (multica): uncertain ⇒ retry ONLY with the same `uuid`. */
export const FEISHU_SEND_UNCERTAIN_CODES: readonly number[] = [230_020];
/** §4 first reply with one of these on a capability ⇒ `capability:<x>=denied`. */
export const FEISHU_CAPABILITY_DENIED_CODES: readonly number[] = [99_991_672, 230_027];

export type BootstrapCodeClass =
  | { kind: "ok" }
  | { kind: "retry"; code: number }
  | { kind: "auth_failed"; code: number }
  | { kind: "conn_limit"; code: number };

/** §2.1 mapping: `0` ok; `1`/`1000040343` retry; `1000040350` conn_limit; everything else non-zero ⇒ `auth_failed`. */
export function classifyBootstrapCode(code: number): BootstrapCodeClass {
  if (code === FEISHU_CODE_OK) return { kind: "ok" };
  if (FEISHU_BOOTSTRAP_RETRYABLE_CODES.includes(code)) return { kind: "retry", code };
  if (code === FEISHU_CODE_EXCEED_CONN_LIMIT) return { kind: "conn_limit", code };
  return { kind: "auth_failed", code };
}

/** True when the HTTP/API code means "credentials rejected" for the token endpoint (V11: `10014` etc.). */
export function isAuthFailedCode(code: number): boolean {
  return code !== FEISHU_CODE_OK && classifyBootstrapCode(code).kind === "auth_failed";
}

// ---------------------------------------------------------------------------
// limits, caps, TTLs, timers (§2.3/§2.4/§3/§5.8/§R2-f ...)
// ---------------------------------------------------------------------------

const KIB = 1024;
const MIB = 1024 * 1024;

/** §2.3 malformed-frame limits (a violation ⇒ drop + counter + NO ACK). */
export const FEISHU_FRAME_LIMITS = {
  maxFrameBytes: 1 * MIB,
  maxHeaders: 64,
  maxHeaderKeyBytes: 4 * KIB,
  maxHeaderValueBytes: 4 * KIB,
} as const;

/** §2.3 aggregate chunk cache (`chunks.ts`, mirrors node-sdk `data-cache.ts`); overflow ⇒ refuse new chunk sets (no ACK). */
export const FEISHU_CHUNK_LIMITS = {
  ttlMs: 10_000,
  maxMessages: 16,
  maxMessageBytes: 4 * MIB,
  maxTotalBytes: 8 * MIB,
  /** chunk meta: `sum` is an integer 1..64, `seq ∈ [0,sum)` */
  maxSum: 64,
} as const;

/** §2.4 finite timer bounds + connector budgets. `ReconnectCount` from ClientConfig is IGNORED (always retry). */
export const FEISHU_TIMERS = {
  pingIntervalMinS: 10,
  pingIntervalMaxS: 300,
  pingIntervalDefaultS: 120,
  reconnectIntervalMinS: 1,
  reconnectIntervalMaxS: 600,
  reconnectNonceMinS: 0,
  reconnectNonceMaxS: 60,
  /** after each ping, no inbound frame within this ⇒ close + reconnect (SDK `armLiveness`) */
  livenessMs: 30_000,
  handshakeMs: 10_000,
  bootstrapMs: 8_000,
  /** `bufferedAmount` above this ⇒ reconnect */
  writeBackpressureBytes: 1 * MIB,
  /** backoff `min(60 s, 2^n s)` full jitter, reset after `stableResetMs` */
  backoffCapMs: 60_000,
  stableResetMs: 60_000,
  /** auth_failed retry every 10 min; conn_limit every 5 min (§2.1) */
  authFailedRetryMs: 600_000,
  connLimitRetryMs: 300_000,
  /** §R2-d: physical sockets ≤ 2 (current + one closing); a close not finished in 5 s is `terminate()`d */
  maxPhysicalSockets: 2,
  closeTerminateMs: 5_000,
} as const;

/** §2.1 bootstrap request. */
export const FEISHU_BOOTSTRAP = {
  /** body cap ≤64 KiB */
  maxBodyBytes: 64 * KIB,
  timeoutMs: 8_000,
  /** headers (probe/SDK): Content-Type + `locale: zh` */
  contentType: "application/json; charset=utf-8",
  locale: "zh",
  path: "/callback/ws/endpoint",
} as const;

/** §3 HTTP defaults. */
export const FEISHU_HTTP = {
  defaultTimeoutMs: 8_000,
  maxJsonBytes: 1 * MIB,
  /** tenant token cached until `expire − 300 s` */
  tokenRefreshMarginS: 300,
  tokenPath: "/open-apis/auth/v3/tenant_access_token/internal",
} as const;

/** §2.4 ACK path + shutdown budgets (R1 #1). */
export const FEISHU_ACK = {
  /** group commit every ≤100 ms, fsync'd */
  groupCommitMs: 100,
  /** commit not durable within 1.5 s ⇒ no ACK + `degraded(persist-failed)` */
  commitDeadlineMs: 1_500,
  /** the platform's own redelivery deadline for an un-ACKed event (informational) */
  platformBudgetMs: 3_000,
  /** ACK payload (SDK shape; V6 verified) */
  payload: '{"code":200}',
} as const;

/** §1 single shutdown policy: bounded steps, in order. */
export const FEISHU_SHUTDOWN_BUDGET_MS = {
  groupCommit: 1_000,
  inFlightDispatch: 2_000,
  outboxDrain: 2_000,
  stateFlush: 1_000,
} as const;

/**
 * §5.8 + §R2-f: every map/queue has a cap; at cap the NEW item is refused (never silent eviction of
 * security state). `*Ttl*` values are milliseconds.
 */
export const FEISHU_CAPS = {
  /** `state.json` file budget (≤4 MiB); admission checks the post-write size BEFORE accepting durable work (R2-c) */
  stateMaxBytes: 4 * MIB,
  allowList: 32,
  /** dedup (event_id + message_id): refuse ⇒ stop ACKing new events + `degraded` */
  dedup: 16_384,
  /** ≥ V7 redelivery horizon; V7 is still unmeasured, so 72 h is the conservative plan value */
  dedupTtlMs: 72 * 3_600_000,
  /** non-terminal requests; at cap ⇒ new inbound refused with notice */
  requestsNonTerminal: 256,
  /** terminal request records keep metadata for 24 h */
  terminalTtlMs: 24 * 3_600_000,
  /** §R2-f terminal request metadata */
  terminalMetadata: 2_000,
  bindings: 256,
  dialogCards: 64,
  dialogCardsTtlMs: 24 * 3_600_000,
  nonces: 512,
  nonceTtlMs: 24 * 3_600_000,
  approvals: 16,
  approvalsTtlMs: 24 * 3_600_000,
  /** outbox parts (finals never dropped) */
  outboxParts: 512,
  /** upload staging (§7.1), bytes */
  stagingBytes: 100 * MIB,
  /** §R2-f list generations 4 per chat / 10 min */
  listGenerationsPerChat: 4,
  listGenerationTtlMs: 10 * 60_000,
  /** §R2-f debounce buffers across chats */
  debounceBufferChats: 64,
  /** §R2-f ask_user answer drafts 32 / 30 min */
  askDrafts: 32,
  askDraftTtlMs: 30 * 60_000,
  /** session-card (`/list` switch card, session-card-plan §1): buttons per card */
  listCardMaxButtons: 8,
  /** session-card: rows rendered as text lines on the card body */
  listCardMaxRows: 40,
  /** session-card: button label cap in code points (sid6/state are never truncated) */
  listButtonLabelMax: 36,
  /** session-card: open-card slots, global / per operator (anchor-record backed) */
  listCardsOpenGlobal: 16,
  listCardsOpenPerOperator: 4,
  /** session-card: nonce sub-quota reserve — session-card issues with maxTotal = nonces − this */
  noncesReservedForOthers: 128,
  /** session-card: physical PATCH IO pool size (zombie work occupies a slot until real settle) */
  listCardPatchIoMax: 8,
} as const;

/** §R2-c: durable `received` payload body cap (longer inbound text is staged as a `.txt` upload attachment). */
export const FEISHU_RECEIVED_BODY_MAX_BYTES = 16 * KIB;
/** credentials file ≤ 4 KiB (§4.4). */
export const FEISHU_CREDENTIALS_MAX_BYTES = 4 * KIB;

/** §4.1 admission rate limits (the shared hub `agent:${agentKey}` 30/1 s bucket is NOT redefined here). */
export const FEISHU_RATE_LIMITS = {
  senderCmd: { max: 10, windowMs: 3_000 },
  global: { max: 60, windowMs: 60_000 },
  callback: { max: 20, windowMs: 60_000 },
} as const;

/** §4.2/§4.3 identity + nonce parameters. */
export const FEISHU_IDENTITY = {
  /** card nonce: 16 random bytes, base64url ⇒ 22 chars (§4.3) */
  nonceBytes: 16,
  nonceEncodedLength: 22,
  /** strangers: ≤1 approval card per sender per 24 h */
  approvalPerSenderMs: 24 * 3_600_000,
  /** reactions only on messages younger than this (§4.2) */
  reactionMaxAgeMs: 120_000,
} as const;

/** Valid card-nonce text: 16 bytes base64url without padding. */
export const FEISHU_NONCE_RE = /^[A-Za-z0-9_-]{22}$/;

/** §5.5 debounce. */
export const FEISHU_DEBOUNCE = {
  /** a batch closes at 20 attachments */
  maxAttachments: 20,
} as const;

/** §6 replies. */
export const FEISHU_REPLY_LIMITS = {
  /** serialized card JSON ≤20 KB UTF-8 bytes per part */
  maxCardBytes: 20_000,
  maxParts: 4,
  /** outbox: ≤2 retries with the same uuid, per-chat serial ≥250 ms, global ≤20/s, task budget 30 s */
  maxRetries: 2,
  perChatMinGapMs: 250,
  globalPerSecond: 20,
  taskBudgetMs: 30_000,
  /** ask_user cards (§6.3): ≤8 questions, Other ≤4 KiB */
  askMaxQuestions: 8,
  askOtherMaxBytes: 4 * KIB,
  /** R2-g: cards not expired before the agent's authoritative dialog list arrives; 30 s ⇒ "状态未知" */
  askReconcileWaitMs: 30_000,
} as const;

/** §7 files. */
export const FEISHU_FILE_LIMITS = {
  /** inbound: per-file deadline, concurrency */
  inboundTimeoutMs: 30_000,
  inboundConcurrency: 4,
  /** outbound auto-send / button caps (§7.2): per reply */
  outboundAutoMax: 3,
  outboundButtonMax: 5,
  outboundCandidatesMax: 8,
  outboundAutoImageMaxBytes: 10 * MIB,
  outboundUploadMaxBytes: 30 * MIB,
  /** preview-chain total admission budget per reply */
  outboundAdmitBudgetMs: 1_500,
} as const;

/** §8 notifications. */
export const FEISHU_NOTIFY_LIMITS = {
  /** done: first 1 500 chars; ≥60 s apart per session */
  doneMaxChars: 1_500,
  doneMinGapMs: 60_000,
  /** failed / waiting: ≤1 per 5 min per session */
  failedMinGapMs: 300_000,
  waitingMinGapMs: 300_000,
  /** global ≤20 notices/min */
  globalPerMin: 20,
  /** registry status must be fresher than this to count as background-idle evidence */
  idleEvidenceFreshMs: 10_000,
} as const;

/** §9 setup (device flow). */
export const FEISHU_SETUP = {
  /** hard stop at `expires_in` (≤600 s); every request 8 s */
  maxExpiresInS: 600,
  requestTimeoutMs: 8_000,
  /** `slow_down` adds +5 s to the poll interval */
  slowDownAddS: 5,
  /** agent-side `setup_status` polling cadence */
  agentPollMs: 2_000,
  /** wire cap for the decorated `verification_uri_complete` shown to the user (https only, enforced by F4) */
  qrUrlMaxLength: 2_048,
} as const;

/** §5.2/§4.2 stale rule: `create_time` older than `staleMessageS` ⇒ not executed. */
export const FEISHU_STALE_DEFAULT_S = 300;

// ---------------------------------------------------------------------------
// create_time normalization (V10) + stale rule
// ---------------------------------------------------------------------------

/**
 * V10 (probe, real tenant): message events carry a 13-digit **millisecond** `create_time`; card
 * callback headers carry a 16-digit **microsecond** one. Normalize by digit count only:
 * `13` ⇒ ms as-is, `16` ⇒ µs ÷ 1000 (floor). Accepts a decimal string (the wire form) or a safe
 * integer. ANY other digit count (incl. 10-digit seconds — never observed) ⇒ `undefined`: the
 * unit is not guessed, the caller decides (recommended: fail closed, do not execute).
 */
export function normalizeCreateTimeMs(raw: unknown): number | undefined {
  let digits: string;
  if (typeof raw === "string") digits = raw.trim();
  else if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) digits = String(raw);
  else return undefined;
  if (!/^[1-9][0-9]*$/.test(digits)) return undefined;
  if (digits.length === 13) return Number(digits);
  if (digits.length === 16) return Math.floor(Number(digits) / 1000);
  return undefined;
}

/** §4.2 stale: `now − createTime > staleMessageS`. A create_time in the future is not stale. Unknown time ⇒ `undefined`. */
export function isStaleCreateTime(
  createTimeMs: number | undefined,
  nowMs: number,
  staleMessageS: number,
): boolean | undefined {
  if (createTimeMs === undefined) return undefined;
  return nowMs - createTimeMs > staleMessageS * 1_000;
}

// ---------------------------------------------------------------------------
// ClientConfig clamps (§2.4)
// ---------------------------------------------------------------------------

export interface FeishuClientConfig {
  /** milliseconds, clamped to [10 s, 300 s] */
  pingIntervalMs: number;
  /** milliseconds, clamped to [1 s, 600 s] */
  reconnectIntervalMs: number;
  /** milliseconds, clamped to [0, 60 s] */
  reconnectNonceMs: number;
}

export const FEISHU_CLIENT_CONFIG_DEFAULT: Readonly<FeishuClientConfig> = Object.freeze({
  pingIntervalMs: FEISHU_TIMERS.pingIntervalDefaultS * 1_000,
  reconnectIntervalMs: 120_000,
  reconnectNonceMs: 30_000,
});

function clampSeconds(raw: unknown, min: number, max: number, fallbackMs: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallbackMs;
  return Math.min(max, Math.max(min, raw)) * 1_000;
}

/**
 * §2.4: server `ClientConfig` (`PingInterval`/`ReconnectInterval`/`ReconnectNonce`, SECONDS) ⇒ finite,
 * clamped milliseconds. Non-number / NaN / Infinity fields fall back to the defaults field by field
 * (a malformed pong config is ignored by the caller; this never throws). `ReconnectCount` is ignored.
 */
export function clampClientConfig(raw: unknown): FeishuClientConfig {
  const d = FEISHU_CLIENT_CONFIG_DEFAULT;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ...d };
  const r = raw as Record<string, unknown>;
  const t = FEISHU_TIMERS;
  return {
    pingIntervalMs: clampSeconds(r["PingInterval"], t.pingIntervalMinS, t.pingIntervalMaxS, d.pingIntervalMs),
    reconnectIntervalMs: clampSeconds(
      r["ReconnectInterval"],
      t.reconnectIntervalMinS,
      t.reconnectIntervalMaxS,
      d.reconnectIntervalMs,
    ),
    reconnectNonceMs: clampSeconds(r["ReconnectNonce"], t.reconnectNonceMinS, t.reconnectNonceMaxS, d.reconnectNonceMs),
  };
}

/** §2.4 backoff ceiling for attempt `n` (0-based): `min(60 s, 2^n s)`; the connector applies full jitter `rand(0, ceiling)`. */
export function reconnectBackoffCeilingMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt < 0) return 1_000;
  const exp = Math.min(Math.floor(attempt), 30); // 2^30 s overflows nothing, and the cap bites at n=6
  return Math.min(FEISHU_TIMERS.backoffCapMs, 2 ** exp * 1_000);
}

// ---------------------------------------------------------------------------
// request-token header (§R2-a)
// ---------------------------------------------------------------------------

/**
 * §R2-a: every dispatched prompt's FIRST line is the bot header
 * `[飞书 · <sender display> · <chat label> · #<tok>]`, `tok = b64url(HMAC-SHA256(installSecret,
 * cmdId))[0:12]` (the HMAC itself is computed hub-side by F6 — this module stays `node:*`-free).
 * The remaining lines are the batch body. The header makes the dispatched text unique per request,
 * and Feishu senders cannot spoof it: display/label are sanitized here (no `[`, `]`, `·`, `#`,
 * newline, control/format chars), so a sender can never inject a header-shaped token.
 */
export const FEISHU_REQUEST_TOKEN_LEN = 12;
export const FEISHU_REQUEST_TOKEN_RE = /^[A-Za-z0-9_-]{12}$/;
/** Max code points of the sanitized sender display / chat label inside the header (F0 decision). */
export const FEISHU_HEADER_FIELD_MAX = 32;

const HEADER_PREFIX = "[飞书 · ";
const HEADER_SEP = " · ";
const HEADER_LINE_RE = /^\[飞书 · ([^·[\]\n\r]*) · ([^·[\]\n\r]*) · #([A-Za-z0-9_-]{12})\]$/u;

/** cmdId shape (F6): `"fs" + b64url(sha256(batchId))[0:30]` — 32 chars, inside the hub's `CMD_ID_RE` `[A-Za-z0-9_-]{16,64}`. */
export const FEISHU_CMD_ID_PREFIX = "fs";
export const FEISHU_CMD_ID_RE = /^fs[A-Za-z0-9_-]{30}$/;

/** Sanitize an attacker-influenced display string for use inside the header (never empty, never `· [ ] #`, never multi-line). */
export function sanitizeHeaderField(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  const cleaned = text
    // control + format characters (bidi overrides, zero-width, BOM, …) and line/paragraph separators
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .replace(/[·[\]#]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned === "") return "?";
  const points = Array.from(cleaned);
  const cut =
    points.length > FEISHU_HEADER_FIELD_MAX ? points.slice(0, FEISHU_HEADER_FIELD_MAX).join("").trimEnd() : cleaned;
  return cut === "" ? "?" : cut;
}

/** The header line for a request; throws `TypeError` on a malformed token (programmer error). */
export function formatRequestHeader(senderDisplay: unknown, chatLabel: unknown, token: string): string {
  if (!FEISHU_REQUEST_TOKEN_RE.test(token)) {
    throw new TypeError(`formatRequestHeader: token must match ${FEISHU_REQUEST_TOKEN_RE.source}`);
  }
  return `${HEADER_PREFIX}${sanitizeHeaderField(senderDisplay)}${HEADER_SEP}${sanitizeHeaderField(chatLabel)}${HEADER_SEP}#${token}]`;
}

/** Dispatched prompt text = header line + `\n` + body. */
export function buildRequestText(headerLine: string, body: string): string {
  return `${headerLine}\n${body}`;
}

export interface ParsedRequestHeader {
  sender: string;
  chat: string;
  token: string;
}

/** Parse a header line (the exact output shape of {@link formatRequestHeader}); `undefined` on any deviation. */
export function parseRequestHeader(line: string): ParsedRequestHeader | undefined {
  const m = HEADER_LINE_RE.exec(line);
  if (m === null) return undefined;
  return { sender: m[1]!, chat: m[2]!, token: m[3]! };
}

/**
 * Split dispatched text into its first line + remainder and parse the first line. Used for the
 * anchor match (R2-a): the anchor is a user message whose first text block STARTS with the
 * byte-equal header line. `undefined` when the first line is not a well-formed header.
 */
export function splitRequestText(
  text: string,
): { header: ParsedRequestHeader; headerLine: string; body: string } | undefined {
  const nl = text.indexOf("\n");
  const headerLine = nl < 0 ? text : text.slice(0, nl);
  const header = parseRequestHeader(headerLine);
  if (header === undefined) return undefined;
  return { header, headerLine, body: nl < 0 ? "" : text.slice(nl + 1) };
}

// ---------------------------------------------------------------------------
// settings leaves + HubConfig.feishuBot (§9)
// ---------------------------------------------------------------------------

export const FEISHU_NOTIFY_MODES = ["bound", "off"] as const;
export type FeishuNotifyMode = (typeof FEISHU_NOTIFY_MODES)[number];
export const FEISHU_SPAWN_SCOPES = ["known", "roots"] as const;
export type FeishuSpawnScope = (typeof FEISHU_SPAWN_SCOPES)[number];
export const FEISHU_FILE_OUTBOUND_MODES = ["auto", "buttons", "off"] as const;
export type FeishuFileOutboundMode = (typeof FEISHU_FILE_OUTBOUND_MODES)[number];

/**
 * §9 defaults + ranges. `src/config/settings.ts` carries literal MIRRORS of these (it cannot import
 * this module — boundary test); `tests/web-hub/protocol/feishu.test.ts` pins parity.
 * Ranges (plan author, F0 consult): debounceMs 0–10 000, staleMessageS 30–3 600, maxInboundMiB 1–100
 * (100 = `UPLOAD_FILE_MAX_BYTES`).
 */
export const FEISHU_BOT_DEFAULTS = {
  enabled: false,
  allowGroups: true,
  groupRootTopics: false,
  securityAlerts: true,
  xsMirror: true,
  notify: "bound",
  spawnScope: "known",
  debounceMs: 1_500,
  staleMessageS: FEISHU_STALE_DEFAULT_S,
  files: { outbound: "auto", inbound: true, maxInboundMiB: 30 },
} as const;

export const FEISHU_BOT_RANGES = {
  debounceMs: { min: 0, max: 10_000 },
  staleMessageS: { min: 30, max: 3_600 },
  maxInboundMiB: { min: 1, max: 100 },
} as const;

/**
 * `HubConfig.feishuBot` (§1 gate): the KEY'S PRESENCE is the switch — there is no `enabled` field,
 * absence = off (no service, timers, network, disk, cap), same pattern as `spawn`/`proxy`.
 * Written by `buildHubConfig` iff `feishuBot.enabled ∧ webHub.enabled ∧ webHub.control !== false`.
 * Keepalive is not a leaf (Q1 fixed it).
 */
export interface FeishuBotHubConfig {
  /** Absent is false; P0 does not forward the settings default into this wire yet. */
  securityAlerts?: boolean;
  /** Absent is false (fail closed): mirror non-waking cross-session messages to bound p2p chats. */
  xsMirror?: boolean;
  allowGroups: boolean;
  groupRootTopics: boolean;
  notify: FeishuNotifyMode;
  spawnScope: FeishuSpawnScope;
  debounceMs: number;
  staleMessageS: number;
  files: {
    outbound: FeishuFileOutboundMode;
    inbound: boolean;
    maxInboundMiB: number;
  };
}

function isInt(raw: unknown, min: number, max: number): raw is number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= min && raw <= max;
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[]): raw is T {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw);
}

/**
 * `hub/main.ts` normalizer (F-A calls it): returns a fresh, exactly-shaped config, or `undefined`
 * when the value is malformed — the caller then DROPS the whole key (feature off). Every leaf is
 * mandatory and strictly validated (the agent-side settings parser already clamped everything, so
 * an out-of-range value here means a corrupted/forged config, never a user typo). Unknown extra
 * keys are ignored (forward compat) and never copied.
 */
export function normalizeFeishuBotHubConfig(input: unknown): FeishuBotHubConfig | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const r = input as Record<string, unknown>;
  const files = r["files"];
  if (files === null || typeof files !== "object" || Array.isArray(files)) return undefined;
  const f = files as Record<string, unknown>;
  const rg = FEISHU_BOT_RANGES;
  if (r["securityAlerts"] !== undefined && typeof r["securityAlerts"] !== "boolean") return undefined;
  if (r["xsMirror"] !== undefined && typeof r["xsMirror"] !== "boolean") return undefined;
  if (typeof r["allowGroups"] !== "boolean" || typeof r["groupRootTopics"] !== "boolean") return undefined;
  if (!oneOf(r["notify"], FEISHU_NOTIFY_MODES) || !oneOf(r["spawnScope"], FEISHU_SPAWN_SCOPES)) return undefined;
  if (!isInt(r["debounceMs"], rg.debounceMs.min, rg.debounceMs.max)) return undefined;
  if (!isInt(r["staleMessageS"], rg.staleMessageS.min, rg.staleMessageS.max)) return undefined;
  if (!oneOf(f["outbound"], FEISHU_FILE_OUTBOUND_MODES) || typeof f["inbound"] !== "boolean") return undefined;
  if (!isInt(f["maxInboundMiB"], rg.maxInboundMiB.min, rg.maxInboundMiB.max)) return undefined;
  return {
    ...(r["securityAlerts"] === undefined ? {} : { securityAlerts: r["securityAlerts"] as boolean }),
    ...(r["xsMirror"] === undefined ? {} : { xsMirror: r["xsMirror"] as boolean }),
    allowGroups: r["allowGroups"],
    groupRootTopics: r["groupRootTopics"],
    notify: r["notify"],
    spawnScope: r["spawnScope"],
    debounceMs: r["debounceMs"],
    staleMessageS: r["staleMessageS"],
    files: { outbound: f["outbound"], inbound: f["inbound"], maxInboundMiB: f["maxInboundMiB"] },
  };
}

// ---------------------------------------------------------------------------
// fsb_req / fsb_res schemas (§9) — folded into messages.ts decode tables
// ---------------------------------------------------------------------------

const RidSchema = Type.String({ minLength: 1, maxLength: 64 });
const OpenIdSchema = Type.String({ pattern: FEISHU_OPEN_ID_RE.source });
const strict = { additionalProperties: false } as const;

export const FsbReqSchema = Type.Union([
  Type.Object({ t: Type.Literal(FSB_REQ_TYPE), rid: RidSchema, op: Type.Literal("info") }, strict),
  Type.Object(
    {
      t: Type.Literal(FSB_REQ_TYPE),
      rid: RidSchema,
      op: Type.Literal("setup_begin"),
      replace: Type.Optional(Type.Literal(true)),
      confirm: Type.Optional(Type.Literal(true)),
    },
    strict,
  ),
  Type.Object({ t: Type.Literal(FSB_REQ_TYPE), rid: RidSchema, op: Type.Literal("setup_status") }, strict),
  Type.Object({ t: Type.Literal(FSB_REQ_TYPE), rid: RidSchema, op: Type.Literal("setup_cancel") }, strict),
  Type.Object(
    { t: Type.Literal(FSB_REQ_TYPE), rid: RidSchema, op: Type.Literal("allow"), openId: OpenIdSchema },
    strict,
  ),
  Type.Object(
    { t: Type.Literal(FSB_REQ_TYPE), rid: RidSchema, op: Type.Literal("deny"), openId: OpenIdSchema },
    strict,
  ),
  Type.Object(
    { t: Type.Literal(FSB_REQ_TYPE), rid: RidSchema, op: Type.Literal("repair"), confirm: Type.Literal(true) },
    strict,
  ),
  Type.Object(
    { t: Type.Literal(FSB_REQ_TYPE), rid: RidSchema, op: Type.Literal("reset"), confirm: Type.Literal(true) },
    strict,
  ),
]);

export type FsbReqFrame =
  | { t: "fsb_req"; rid: string; op: "info" }
  | { t: "fsb_req"; rid: string; op: "setup_begin"; replace?: true; confirm?: true }
  | { t: "fsb_req"; rid: string; op: "setup_status" }
  | { t: "fsb_req"; rid: string; op: "setup_cancel" }
  | { t: "fsb_req"; rid: string; op: "allow"; openId: string }
  | { t: "fsb_req"; rid: string; op: "deny"; openId: string }
  | { t: "fsb_req"; rid: string; op: "repair"; confirm: true }
  | { t: "fsb_req"; rid: string; op: "reset"; confirm: true };

/** §9 setup public view: `device_code`, secret and token NEVER leave the hub — only these three fields. */
export const FEISHU_SETUP_PHASES = ["pending", "done", "expired", "denied", "cancelled", "failed"] as const;
export type FeishuSetupPhase = (typeof FEISHU_SETUP_PHASES)[number];

const SetupPhaseSchema = Type.Union(FEISHU_SETUP_PHASES.map((p) => Type.Literal(p)));

export const FsbSetupViewSchema = Type.Object(
  {
    phase: SetupPhaseSchema,
    qrUrl: Type.Optional(Type.String({ minLength: 1, maxLength: FEISHU_SETUP.qrUrlMaxLength })),
    /** epoch ms */
    expiresAt: Type.Optional(Type.Number()),
  },
  strict,
);
export interface FsbSetupView {
  phase: FeishuSetupPhase;
  qrUrl?: string;
  expiresAt?: number;
}

const CountSchema = Type.Integer({ minimum: 0 });
const CapStateSchema = Type.Union(FEISHU_CAPABILITY_STATES.map((s) => Type.Literal(s)));

/**
 * `info` result (§10 status). The secret, token, device_code and full ids NEVER appear: `owner` /
 * `allow` are masked (`ou_…9f3c`); the feishu-notify coexistence warning is added agent-side.
 */
export const FsbInfoDataSchema = Type.Object(
  {
    status: Type.Union(FEISHU_BOT_STATUSES.map((s) => Type.Literal(s))),
    /** reasons while `status:"degraded"` (also reported on other statuses when applicable) */
    degraded: Type.Optional(Type.Array(Type.String({ pattern: "^[a-z][a-z0-9:_-]{0,63}$" }), { maxItems: 16 })),
    brand: Type.Optional(Type.Union(FEISHU_BRANDS.map((b) => Type.Literal(b)))),
    gen: CountSchema,
    uptimeMs: Type.Optional(Type.Number({ minimum: 0 })),
    reconnects: CountSchema,
    lastClose: Type.Optional(
      Type.Object(
        { at: Type.Number(), reason: Type.String({ maxLength: 120 }), code: Type.Optional(Type.Number()) },
        strict,
      ),
    ),
    counters: Type.Object(
      {
        in: CountSchema,
        dup: CountSchema,
        dropped: Type.Record(Type.String({ maxLength: 64 }), CountSchema),
      },
      strict,
    ),
    outbox: Type.Object(
      {
        ok: CountSchema,
        failed: CountSchema,
        lastCode: Type.Optional(Type.Union([Type.Number(), Type.String({ maxLength: 64 })])),
      },
      strict,
    ),
    bindings: Type.Object({ total: CountSchema, offline: CountSchema, ambiguous: CountSchema }, strict),
    caps: Type.Object(
      {
        cards: CapStateSchema,
        reactions: CapStateSchema,
        files: CapStateSchema,
        cardCallback: CapStateSchema,
      },
      strict,
    ),
    /** `bot:1` idle keepalive active (Q1) */
    keepalive: Type.Boolean(),
    owner: Type.Optional(Type.String({ maxLength: 64 })),
    allow: Type.Array(Type.String({ maxLength: 64 }), { maxItems: FEISHU_CAPS.allowList }),
  },
  strict,
);
export interface FsbInfoData {
  status: FeishuBotStatus;
  degraded?: string[];
  brand?: FeishuBrand;
  gen: number;
  uptimeMs?: number;
  reconnects: number;
  lastClose?: { at: number; reason: string; code?: number };
  counters: { in: number; dup: number; dropped: Record<string, number> };
  outbox: { ok: number; failed: number; lastCode?: number | string };
  bindings: { total: number; offline: number; ambiguous: number };
  caps: Record<FeishuCapabilityName, FeishuCapabilityState>;
  keepalive: boolean;
  owner?: string;
  allow: string[];
}

/** `allow`/`deny` result. */
export const FsbAllowDataSchema = Type.Object({ changed: Type.Boolean(), count: CountSchema }, strict);
export interface FsbAllowData {
  changed: boolean;
  count: number;
}

export type FsbResData = FsbInfoData | FsbSetupView | FsbAllowData;

export const FsbResSchema = Type.Union([
  Type.Object(
    {
      t: Type.Literal(FSB_RES_TYPE),
      rid: RidSchema,
      ok: Type.Literal(true),
      data: Type.Optional(Type.Union([FsbInfoDataSchema, FsbSetupViewSchema, FsbAllowDataSchema])),
    },
    strict,
  ),
  Type.Object(
    {
      t: Type.Literal(FSB_RES_TYPE),
      rid: RidSchema,
      ok: Type.Literal(false),
      code: Type.String({ pattern: FSB_ERROR_CODE_WIRE_RE.source }),
      message: Type.String({ maxLength: 512 }),
    },
    strict,
  ),
]);

export type FsbResFrame =
  | { t: "fsb_res"; rid: string; ok: true; data?: FsbResData }
  | { t: "fsb_res"; rid: string; ok: false; code: string; message: string };
