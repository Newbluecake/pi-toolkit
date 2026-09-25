/**
 * Prompt-cache keepalive — pure state machine (pi-free).
 *
 * This module owns: capture/fingerprint types, the payload inspector, the
 * `evaluateTick` short-circuit ladder (plan.md §5.2, 15 checks + the ping
 * outcome), the window/session reducers (plan.md §5.3/§6.3/§9.2), and the
 * status-bar / `/cache-ttl status` text builders plus cost estimation
 * (plan.md §7.6/§9.1/§9.4).
 *
 * Hard rule (AGENTS.md + plan.md): no pi imports, no module-level mutable
 * state, no implicit clock reads — every function takes `now` as an input.
 *
 * Type ownership note (step 4 assembly, per the task's final reply): the
 * ping-client package now exists — `PingOutcome` is owned there and imported
 * here directly instead of being echoed structurally. `UnprovenKind` is
 * derived from it (every kind except `"proven-hit"`).
 */

import type { Millis } from "../core/types.js";
import type { PingHeaderSource, PingOutcome } from "./ping-client.js";
// Type-only back-reference (adaptive.ts value-imports constants from THIS
// module): erased at runtime ⇒ no ESM cycle (adaptive plan.md §3.5).
import type { AdaptiveBreakerReason, AdaptiveSnapshot } from "./adaptive.js";

// ---------------------------------------------------------------------------
// Constants (plan.md §6.1/§6.2/§7.5/§10.1 — safety knobs, deliberately not
// settings so a misconfiguration can't disable the guardrails).
// ---------------------------------------------------------------------------

/** Anthropic's advertised ephemeral (5m) cache entry lifetime. */
export const ASSUMED_TTL_MS: Millis = 300_000;
/** Safety margin subtracted from `aliveUntil` before we consider a ping "too late" (plan.md #13). */
export const TTL_SAFETY_MARGIN_MS: Millis = 45_000;
/** Scheduler tick precision (service layer; exported so tests/service code share one constant). */
export const TICK_INTERVAL_MS: Millis = 15_000;
/** I-K7: consecutive unproven pings before the whole session is disabled. */
export const UNPROVEN_STREAK_LIMIT = 2;
/** I-K7: cumulative (non-consecutive) unproven pings before the whole session is disabled. */
export const UNPROVEN_TOTAL_LIMIT = 3;
/** G4: providers billed per-request rather than per-token — ping cost model doesn't hold. */
export const PING_DENY_PROVIDERS: ReadonlySet<string> = new Set(["github-copilot"]);
/** G3: only Anthropic's Messages API has cache_control / free-read-refresh semantics. */
export const ANTHROPIC_MESSAGES_API = "anthropic-messages";
/** G2: only these run modes can plausibly resume a long-idle session. */
const RUN_MODES_ALLOWING_PING: ReadonlySet<string> = new Set(["tui", "rpc"]);

/** Gate #4 as a predicate, for callers outside `evaluateTick` (F1 horizon report). */
export function keepaliveModeAllowsPing(mode: string): boolean {
  return RUN_MODES_ALLOWING_PING.has(mode);
}

// ---------------------------------------------------------------------------
// ping-client.ts type re-export (collapsed onto the real types in step 4 —
// see the type-ownership note above).
// ---------------------------------------------------------------------------

/** The `PingOutcome` `"proven-hit"` variant, extracted from the real ping-client type. */
export type ProvenHitOutcome = Extract<PingOutcome, { kind: "proven-hit" }>;

/** Every `PingOutcome` kind except `"proven-hit"` (plan.md §7.5 — everything else is unproven). */
export type UnprovenKind = Exclude<PingOutcome["kind"], "proven-hit">;

// ---------------------------------------------------------------------------
// Payload shape + fingerprint (plan.md §3.2/§3.3)
// ---------------------------------------------------------------------------

export interface PayloadShape {
  /** Count of `cache_control.type === "ephemeral"` breakpoints found anywhere in the payload. */
  ephemeralBreakpoints: number;
  /** True if any ephemeral breakpoint carries `ttl: "1h"`. */
  ttl1h: boolean;
  /** True if `payload.thinking` is present and not `{type:"disabled"}`. */
  hasThinking: boolean;
  maxTokens: number | undefined;
}

export type FingerprintField =
  | "sessionId"
  | "provider"
  | "api"
  | "ctxModelId"
  | "baseUrl"
  | "authHeaderKeys"
  | "breakpointPath"
  | "thinkingDigest"
  | "systemDigest"
  | "toolsDigest"
  | "messageCount";

export interface FingerprintDiff {
  field: FingerprintField;
  category: "safety" | "effectiveness";
}

/**
 * plan.md §3.3: fields split into "safety-critical" (could turn a ping into a
 * real write or hit the wrong endpoint) and "effectiveness-critical" (only
 * wastes a 0.1P read). Order here is also `compareFingerprint`'s priority —
 * the first differing field (safety fields first) is reported.
 */
export interface CaptureFingerprint {
  sessionId: string;
  provider: string;
  api: string;
  /** The wire-level `payload.model` (may legitimately differ from `ctxModelId` — fallback models). */
  modelId: string;
  /** `ctx.model.id` at capture time. */
  ctxModelId: string;
  baseUrl: string;
  /** Sorted, comma-joined auth header *keys* (never values) — locked in after the first ping resolves auth. */
  authHeaderKeys: string;
  breakpointPath: string;
  thinkingDigest: string;
  systemDigest: string;
  toolsDigest: string;
  messageCount: number;
}

/** plan.md §2.3: primitives the caller (pi-facing capture code) must supply; everything else is derived from `payload`. */
export interface FingerprintContextInput {
  sessionId: string;
  provider: string;
  api: string;
  ctxModelId: string;
  baseUrl: string;
  authHeaderKeys: string;
}

/** plan.md §3.4: an actually-measured lower bound on the reusable prefix, or "unknown" (⇒ don't ping, G6). */
export type PrefixEstimate = { tokens: number; source: "usage" } | { tokens: 0; source: "unknown" };

/**
 * plan.md §2.3: what `before_provider_request` + `before_provider_headers`
 * together capture for one real request.
 *
 * `headers` (root-cause fix): the VERBATIM header snapshot taken from the
 * `before_provider_headers` hook for this exact request (null-valued
 * deletions already filtered out) — never hand-reassembled. Pairing these
 * two hooks' captures for the same request is `cache-ttl.ts`'s
 * responsibility (see its `pendingCapture` slot); a `CapturedRequest` only
 * ever reaches this far once both halves are known.
 */
export interface CapturedRequest {
  sessionId: string;
  /** I-K9: the service instance id that captured this request. */
  instance: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  fingerprint: CaptureFingerprint;
  shape: PayloadShape;
  prefix: PrefixEstimate;
  capturedAt: Millis;
}

// ---------------------------------------------------------------------------
// Window / session state (plan.md §5.1/§5.3, I-K7, I-K8)
// ---------------------------------------------------------------------------

export interface WindowState {
  /** I-K8: bumped on real request / invalidate / session-or-instance change. Ping results carry a snapshot of this. */
  windowEpoch: number;
  capture: CapturedRequest | undefined;
  windowStartAt: Millis | undefined;
  lastReadStartedAt: Millis | undefined;
  aliveUntil: Millis | undefined;
  nextPingAt: Millis | undefined;
  pings: number;
  requestInFlight: boolean;
  pingInFlight: boolean;
  pingStartedAt: Millis | undefined;
  /**
   * Start time of the most recent PROVEN cache read in this window — i.e. the
   * `pingStartedAt` of the last `proven-hit` ping. Unlike `lastReadStartedAt`
   * (which `onRealRequest` sets optimistically at request start, before any
   * hit is known) this is only ever written by evidence: a ping that came
   * back with `cache_read > 0 && cache_creation === 0`.
   *
   * Why it exists (field incident, see docs/dev/cache-ttl-adaptive/plan.md
   * §17): the adaptive predictor's warm/cold split used to key off the last
   * REAL request alone, so a window kept demonstrably alive by 13 minutes of
   * successful pings was still classified `cold` — "the prefix is dead
   * anyway" — and upgraded to 1h, which cannot read the 5m entries the pings
   * had just refreshed. That turned a free full hit into a full-prefix 1h
   * rewrite. `CacheKeepaliveService.provenCacheReadAt()` exports this field
   * so the predictor can see the proof.
   */
  lastProvenPingStartedAt: Millis | undefined;
  upgradePending: boolean;
  /**
   * Non-plan addition (documented deviation, see final reply): the reason the
   * *current* window stopped pinging after an unproven result, so status
   * text (§9.1 "本轮已停：<kind>") doesn't need extra service-side
   * bookkeeping. Cleared on the next real request; left untouched by
   * `invalidate()` (which only touches the three fields plan.md specifies).
   */
  lastStopReason: string | undefined;
}

export function createInitialWindowState(): WindowState {
  return {
    windowEpoch: 0,
    capture: undefined,
    windowStartAt: undefined,
    lastReadStartedAt: undefined,
    aliveUntil: undefined,
    nextPingAt: undefined,
    pings: 0,
    requestInFlight: false,
    pingInFlight: false,
    pingStartedAt: undefined,
    lastProvenPingStartedAt: undefined,
    upgradePending: false,
    lastStopReason: undefined,
  };
}

export interface SessionTotals {
  /** Total successful (proven-hit) pings this session. */
  pings: number;
  cacheReadTokens: number;
  /** I-K7: reset only by a proven hit — never by a real request. */
  consecutiveUnproven: number;
  /** I-K7: monotonic for the session — never reset. */
  unprovenTotal: number;
  /** I-K7: monotonic — a single proven write disables the session forever. */
  provenWrites: number;
  disabled: { reason: string; at: Millis } | undefined;
  lastUnproven: { kind: string; at: Millis } | undefined;
  // plan.md §9.2 (M2): post-hoc load-bearing vs. wasted accounting.
  unnecessaryWindows: number;
  unnecessaryPings: number;
  loadBearingWindows: number;
  loadBearingPings: number;
  avoidedMissTokens: number;
  /**
   * D5 (field incident): windows whose pings were provably thrown away because
   * the very next real request went out as a `ttl:"1h"` write. A 1h request
   * resumes from the last 1h-written prefix point and cannot read the 5m
   * entries the pings refreshed (measured 13/13 on cloudrouter-anthropic), so
   * such a window is neither "load-bearing" nor merely "unnecessary" — its
   * cost was incurred AND its benefit was discarded. Counting it as
   * load-bearing (the pre-fix behaviour) made `/cache-ttl status` claim it had
   * avoided a rewrite the session then paid for anyway.
   */
  discardedWindows: number;
  discardedPings: number;
}

export function createInitialSessionTotals(): SessionTotals {
  return {
    pings: 0,
    cacheReadTokens: 0,
    consecutiveUnproven: 0,
    unprovenTotal: 0,
    provenWrites: 0,
    disabled: undefined,
    lastUnproven: undefined,
    unnecessaryWindows: 0,
    unnecessaryPings: 0,
    loadBearingWindows: 0,
    loadBearingPings: 0,
    avoidedMissTokens: 0,
    discardedWindows: 0,
    discardedPings: 0,
  };
}

export interface KeepaliveConfig {
  enabled: boolean;
  intervalMs: Millis;
  maxPings: number;
  minPrefixTokens: number;
  upgradeAfterBudget: boolean;
}

/**
 * F1 (adaptive verification-2026-09-25): the longest real-request gap a keepalive
 * window can bridge — the last ping lands at `maxPings × intervalMs` and keeps the
 * entry alive for one more TTL. The adaptive predictor refuses to open a NEW 1h
 * prefix while every gap the session has shown fits inside this horizon.
 */
export function keepaliveGapHorizonMs(config: Pick<KeepaliveConfig, "intervalMs" | "maxPings">): Millis {
  return Math.max(0, config.maxPings) * config.intervalMs + ASSUMED_TTL_MS;
}

// ---------------------------------------------------------------------------
// evaluateTick (plan.md §5.2 — 15 short-circuit checks + the ping outcome)
// ---------------------------------------------------------------------------

export type TickSkipReason =
  | "disabled"
  | "session-disabled"
  | "no-capture"
  | "mode"
  | "not-anthropic"
  | "no-cache-control"
  | "ttl-1h"
  | "not-streaming"
  | "prefix-unproven"
  | "prefix-too-small"
  | "request-in-flight"
  | "ping-in-flight"
  | "not-armed"
  /** F1 (adaptive verification-2026-09-25): a settled, confirmed 1h entry already backs this prefix — pinging the 5m chain would pay for the same gap twice. */
  | "adaptive-1h"
  | "cache-expired"
  | "budget-exhausted"
  | "not-due";

export type InvalidateReason =
  | "payload-shape"
  | "clone-failed"
  | "session-compact"
  | "session-compact-failed"
  | "session-tree"
  | "model-select"
  | "thinking-level-select"
  | "system-prompt-drift"
  | "resources-changed"
  | "session-changed"
  | `fingerprint-drift:${string}`;

export interface TickSkip {
  kind: "skip";
  reason: TickSkipReason;
  /** false ⇒ the tick loop must keep re-arming; true ⇒ this window is done until the next real request. */
  terminal: boolean;
}
export interface TickPing {
  kind: "ping";
}
export interface TickInvalidate {
  kind: "invalidate";
  reason: InvalidateReason;
}
export type TickDecision = TickSkip | TickPing | TickInvalidate;

export interface EvaluateTickInput {
  now: Millis;
  /** `ctx.mode` (only `"tui"`/`"rpc"` can plausibly resume a long-idle session, G2). */
  mode: string;
  armed: boolean;
  config: KeepaliveConfig;
  session: SessionTotals;
  window: WindowState;
  /** Freshly-derived fingerprint of "what would go out right now"; compared against `window.capture.fingerprint`. */
  currentFingerprint: CaptureFingerprint;
  /**
   * F1: the adaptive predictor reports that a settled, confirmed 1h entry covers
   * the current prefix with only a small 5m tail (`adaptiveCoversPrefix`). Absent
   * ⇒ false (keepalive-only sessions are unchanged).
   */
  adaptiveCovered?: boolean;
}

export interface TickResult {
  decision: TickDecision;
  /** Possibly-updated window (only rules #9 `invalidate` and #14 `budget-exhausted` mutate it). */
  window: WindowState;
}

export function evaluateTick(input: EvaluateTickInput): TickResult {
  const { config, session, window, armed, mode, now, currentFingerprint, adaptiveCovered } = input;

  const skip = (reason: TickSkipReason, terminal: boolean): TickResult => ({
    decision: { kind: "skip", reason, terminal },
    window,
  });

  // #1
  if (!config.enabled) return skip("disabled", true);
  // #2 — I-K7: session-level breaker, never reset by a real request.
  if (session.disabled !== undefined) return skip("session-disabled", true);
  // #3
  const capture = window.capture;
  if (capture === undefined) return skip("no-capture", true);
  // #4 — G2
  if (!RUN_MODES_ALLOWING_PING.has(mode)) return skip("mode", true);
  // #5 — G3 + G4
  if (capture.fingerprint.api !== ANTHROPIC_MESSAGES_API || PING_DENY_PROVIDERS.has(capture.fingerprint.provider)) {
    return skip("not-anthropic", true);
  }
  // #6 — G5
  if (capture.shape.ephemeralBreakpoints === 0) return skip("no-cache-control", true);
  // #7 — G5
  if (capture.shape.ttl1h) return skip("ttl-1h", true);
  // #7.5 — I-K1/B1: only a payload that was itself a real streaming request can
  // be replayed byte-for-byte with an early-abort read; `preparePingPayload`
  // deliberately never rewrites `stream`, so a captured non-streaming payload
  // must be refused here rather than mutated. Terminal: this window's capture
  // won't change until the next real request re-captures it.
  if (capture.payload.stream !== true) return skip("not-streaming", true);
  // #8 — G6 (M3: only a measured lower bound counts)
  if (capture.prefix.source !== "usage") return skip("prefix-unproven", true);
  if (capture.prefix.tokens < config.minPrefixTokens) return skip("prefix-too-small", true);
  // #9 — G7 (M4)
  const diff = compareFingerprint(capture.fingerprint, currentFingerprint);
  if (diff !== undefined) {
    const reason: InvalidateReason = `fingerprint-drift:${diff.field}`;
    return { decision: { kind: "invalidate", reason }, window: invalidate(window, reason) };
  }
  // #10
  if (window.requestInFlight) return skip("request-in-flight", false);
  // #11
  if (window.pingInFlight) return skip("ping-in-flight", false);
  // #11.5 — F1: the request after the gap will read the 1h entry and rewrite only
  // the small 5m tail; every ping would duplicate that cover. Terminal: the cover
  // only changes at the next real request, which opens a new window anyway.
  if (adaptiveCovered === true) return skip("adaptive-1h", true);
  // #12 — G8
  if (!armed) return skip("not-armed", false);
  // #13 — most important: the cache is presumed dead, pinging now would be a full write.
  if (window.aliveUntil !== undefined && now >= window.aliveUntil - TTL_SAFETY_MARGIN_MS) {
    return skip("cache-expired", true);
  }
  // #14 — I-K2 hard budget; arms the one-shot 1h upgrade (§6.3).
  if (window.pings >= config.maxPings) {
    return {
      decision: { kind: "skip", reason: "budget-exhausted", terminal: true },
      window: { ...window, upgradePending: true },
    };
  }
  // #15
  if (window.nextPingAt !== undefined && now < window.nextPingAt) return skip("not-due", false);
  // #16
  return { decision: { kind: "ping" }, window };
}

// ---------------------------------------------------------------------------
// Fingerprint comparison (plan.md §3.3/§5.2 #9, M4)
// ---------------------------------------------------------------------------

const FINGERPRINT_FIELDS: ReadonlyArray<{ field: FingerprintField; category: "safety" | "effectiveness" }> = [
  { field: "sessionId", category: "safety" },
  { field: "provider", category: "safety" },
  { field: "api", category: "safety" },
  { field: "ctxModelId", category: "safety" },
  { field: "baseUrl", category: "safety" },
  { field: "authHeaderKeys", category: "safety" },
  { field: "breakpointPath", category: "effectiveness" },
  { field: "thinkingDigest", category: "effectiveness" },
  { field: "systemDigest", category: "effectiveness" },
  { field: "toolsDigest", category: "effectiveness" },
  { field: "messageCount", category: "effectiveness" },
];

/** Returns the first differing field (safety fields checked first), or `undefined` if identical. */
export function compareFingerprint(
  captured: CaptureFingerprint,
  current: CaptureFingerprint,
): FingerprintDiff | undefined {
  for (const { field, category } of FINGERPRINT_FIELDS) {
    if (captured[field] !== current[field]) return { field, category };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Payload inspection (plan.md §3.2/§3.3)
// ---------------------------------------------------------------------------

type RecordValue = Record<string, unknown>;

function isObjectRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractText(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).join("\n");
  if (isObjectRecord(node) && typeof node.text === "string") return node.text;
  return "";
}

interface PayloadAnalysis {
  ephemeralBreakpoints: number;
  ttl1h: boolean;
  hasThinking: boolean;
  maxTokens: number | undefined;
  breakpointPath: string;
  systemDigest: string;
  toolsDigest: string;
  thinkingDigest: string;
  messageCount: number;
}

const EMPTY_ANALYSIS: PayloadAnalysis = {
  ephemeralBreakpoints: 0,
  ttl1h: false,
  hasThinking: false,
  maxTokens: undefined,
  breakpointPath: "",
  systemDigest: "",
  toolsDigest: "",
  thinkingDigest: "",
  messageCount: 0,
};

/**
 * Single tree walk (iterative-safe via WeakSet cycle guard, mirrors the
 * skeleton in cache-ttl.ts's `rewrite()`) producing both `PayloadShape` and
 * the payload-derived half of `CaptureFingerprint` — no full serialization
 * (M3/M4: cheap, O(size) with no JSON.stringify of the whole payload).
 */
function analyzePayload(payload: unknown): PayloadAnalysis {
  if (!isObjectRecord(payload)) return EMPTY_ANALYSIS;

  const breakpointPaths: string[] = [];
  let ephemeralBreakpoints = 0;
  let ttl1h = false;
  const seen = new WeakSet<object>();

  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, path ? `${path}.${i}` : String(i)));
      return;
    }
    const obj = node as RecordValue;
    const control = obj.cache_control;
    if (isObjectRecord(control) && control.type === "ephemeral") {
      ephemeralBreakpoints += 1;
      breakpointPaths.push(path);
      if (control.ttl === "1h") ttl1h = true;
    }
    for (const [key, value] of Object.entries(obj)) {
      walk(value, path ? `${path}.${key}` : key);
    }
  };
  walk(payload, "");

  const thinking = payload.thinking;
  const hasThinking = isObjectRecord(thinking) && thinking.type !== "disabled";
  const thinkingDigest = thinking !== undefined ? (JSON.stringify(thinking) ?? "") : "";
  const maxTokensRaw = payload.max_tokens;
  const maxTokens = typeof maxTokensRaw === "number" ? maxTokensRaw : undefined;

  const systemText = extractText(payload.system);
  const systemDigest = `${systemText.length}:${systemText.slice(0, 64)}:${systemText.slice(-64)}`;

  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const toolNames = tools.map((t) => (isObjectRecord(t) && typeof t.name === "string" ? t.name : ""));
  const toolsDigest = `${tools.length}:${toolNames.join(",")}`;

  const messages = Array.isArray(payload.messages) ? payload.messages : [];

  return {
    ephemeralBreakpoints,
    ttl1h,
    hasThinking,
    maxTokens,
    breakpointPath: breakpointPaths.join(","),
    systemDigest,
    toolsDigest,
    thinkingDigest,
    messageCount: messages.length,
  };
}

/**
 * R4 (adaptive review 2026-09-25): a cheap identity of the prefix LINEAGE — the
 * parts of the payload that, when they change, make every cached entry of the
 * previous lineage unreadable (system text digest, tool list, thinking config).
 * Two requests with different keys cannot share a cache prefix, so the adaptive
 * predictor must neither treat one's 1h cover as the other's nor judge the route
 * from a miss across lineages (field: wake turns ran without the memory/agent
 * sections, 01a0d2f9 / 01a0d2e4). Same digests `CaptureFingerprint` uses (G7).
 */
export function payloadLineageKey(payload: unknown): string {
  if (!isObjectRecord(payload)) return "";
  // Review round 2 (R8): hash the FULL content. The fingerprint digests above
  // (length + first/last 64 chars, tool names only) are fine for G7's drift
  // alarm but collide on exactly the edits that split lineages in the field — a
  // same-length change in the middle of the system prompt (memory frontmatter
  // timestamps) or a tool schema/description change under the same name.
  const systemText = extractText(payload.system);
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  let toolsJson = "";
  try {
    toolsJson = JSON.stringify(tools) ?? "";
  } catch {
    toolsJson = `${tools.length}`; // cyclic/unserializable tools: degrade to the count
  }
  const thinking = payload.thinking;
  let thinkingJson = "";
  try {
    thinkingJson = thinking !== undefined ? (JSON.stringify(thinking) ?? "") : "";
  } catch {
    thinkingJson = "?";
  }
  return `${systemText.length}:${fnv1a32(systemText)}|${tools.length}:${fnv1a32(toolsJson)}|${fnv1a32(thinkingJson)}`;
}

/** 32-bit FNV-1a over UTF-16 code units — a fast, dependency-free content hash (not cryptographic). */
function fnv1a32(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function inspectPayload(payload: unknown): PayloadShape {
  const a = analyzePayload(payload);
  return {
    ephemeralBreakpoints: a.ephemeralBreakpoints,
    ttl1h: a.ttl1h,
    hasThinking: a.hasThinking,
    maxTokens: a.maxTokens,
  };
}

export function buildFingerprint(payload: unknown, context: FingerprintContextInput): CaptureFingerprint {
  const a = analyzePayload(payload);
  const modelId = isObjectRecord(payload) && typeof payload.model === "string" ? payload.model : "";
  return {
    sessionId: context.sessionId,
    provider: context.provider,
    api: context.api,
    modelId,
    ctxModelId: context.ctxModelId,
    baseUrl: context.baseUrl,
    authHeaderKeys: context.authHeaderKeys,
    breakpointPath: a.breakpointPath,
    thinkingDigest: a.thinkingDigest,
    systemDigest: a.systemDigest,
    toolsDigest: a.toolsDigest,
    messageCount: a.messageCount,
  };
}

// ---------------------------------------------------------------------------
// Reducers (plan.md §5.3, §6.3, §9.2 — pure, immutable: always return new
// objects on state change, or the exact same reference when nothing applies
// so callers/tests can assert "unchanged" with `toBe`/`===`).
// ---------------------------------------------------------------------------

/**
 * plan.md §9.2 (M2): classify a closing window as `load-bearing` (a real
 * request came back after the assumed-dead point — the pings likely avoided
 * a full rewrite) or `unnecessary` (the cache would have still been alive
 * with zero pings — pure 0.1P×k waste). No-op if the window never pinged.
 */
export function closeWindowAccounting(
  window: WindowState,
  session: SessionTotals,
  now: Millis,
  assumedTtlMs: Millis = ASSUMED_TTL_MS,
  nextRequestIs1h = false,
): SessionTotals {
  if (window.pings === 0 || window.windowStartAt === undefined) return session;
  // D5: a 1h next request discards this window's work regardless of timing —
  // judged BEFORE the alive/expired split, because "the cache was still alive"
  // is exactly the case where the discard hurts most.
  if (nextRequestIs1h) {
    return {
      ...session,
      discardedWindows: session.discardedWindows + 1,
      discardedPings: session.discardedPings + window.pings,
    };
  }
  const cameBackBeforeExpiry = now < window.windowStartAt + assumedTtlMs;
  if (cameBackBeforeExpiry) {
    return {
      ...session,
      unnecessaryWindows: session.unnecessaryWindows + 1,
      unnecessaryPings: session.unnecessaryPings + window.pings,
    };
  }
  const avoided = window.capture?.prefix.tokens ?? 0;
  return {
    ...session,
    loadBearingWindows: session.loadBearingWindows + 1,
    loadBearingPings: session.loadBearingPings + window.pings,
    avoidedMissTokens: session.avoidedMissTokens + avoided,
  };
}

/**
 * A real (non-ping) request just went out. Closes the previous window's M2
 * accounting, then resets the window for the new one. I-K7: deliberately
 * does NOT touch any of the session-level breaker fields
 * (`disabled`/`provenWrites`/`consecutiveUnproven`/`unprovenTotal`/`pings`/
 * `cacheReadTokens`/`lastUnproven`) — only `closeWindowAccounting`'s M2
 * fields change here.
 */
export function onRealRequest(
  window: WindowState,
  session: SessionTotals,
  captured: CapturedRequest,
  now: Millis,
  intervalMs: Millis,
  assumedTtlMs: Millis = ASSUMED_TTL_MS,
): { window: WindowState; session: SessionTotals } {
  const closedSession = closeWindowAccounting(window, session, now, assumedTtlMs, captured.shape.ttl1h);
  const newWindow: WindowState = {
    windowEpoch: window.windowEpoch + 1, // I-K8: any ping in flight for the old window is now unreachable.
    capture: captured,
    windowStartAt: now,
    lastReadStartedAt: now,
    aliveUntil: now + assumedTtlMs,
    nextPingAt: now + intervalMs, // anchor = request *start* time (official TTL semantics).
    pings: 0,
    requestInFlight: true,
    pingInFlight: false,
    pingStartedAt: undefined,
    lastProvenPingStartedAt: undefined,
    upgradePending: false,
    lastStopReason: undefined,
  };
  return { window: newWindow, session: closedSession };
}

/** The real request that opened the current window has settled (message_end / turn_end / agent_end / agent_settled). */
export function onRequestSettled(window: WindowState): WindowState {
  return window.requestInFlight ? { ...window, requestInFlight: false } : window;
}

/** Ping about to be sent — spend one unit of the per-window budget up front (never refunded once the fetch is issued). */
export function onPingStarted(window: WindowState, now: Millis): WindowState {
  return { ...window, pingInFlight: true, pings: window.pings + 1, pingStartedAt: now };
}

export interface ReducerOutcome {
  /** false ⇒ epoch mismatch (I-K8): nothing was changed, caller should count it as a silent drop. */
  applied: boolean;
  window: WindowState;
  session: SessionTotals;
}

/**
 * I-K7's only success path: `cache_read > 0 && cache_creation === 0`.
 * I-K8: `pingEpoch` must equal `window.windowEpoch` (self-asserted here, not
 * trusted from the caller) — a stale/preempted result is dropped entirely:
 * no proven/unproven counting, no `aliveUntil`/`nextPingAt` movement, no
 * breaker change.
 */
export function onProvenHit(
  window: WindowState,
  session: SessionTotals,
  pingEpoch: number,
  outcome: ProvenHitOutcome,
  intervalMs: Millis,
  assumedTtlMs: Millis = ASSUMED_TTL_MS,
): ReducerOutcome {
  if (pingEpoch !== window.windowEpoch) return { applied: false, window, session };
  // Official semantics: lifetime is measured from the request's *start*, not its completion.
  const pingStartedAt = window.pingStartedAt ?? window.windowStartAt ?? 0;
  const newWindow: WindowState = {
    ...window,
    pingInFlight: false,
    lastReadStartedAt: pingStartedAt,
    lastProvenPingStartedAt: pingStartedAt,
    aliveUntil: pingStartedAt + assumedTtlMs,
    nextPingAt: pingStartedAt + intervalMs,
    lastStopReason: undefined,
  };
  const newSession: SessionTotals = {
    ...session,
    pings: session.pings + 1,
    cacheReadTokens: session.cacheReadTokens + outcome.cacheReadTokens,
    consecutiveUnproven: 0, // only a proven hit can clear the streak (I-K7).
  };
  return { applied: true, window: newWindow, session: newSession };
}

/**
 * Everything that isn't a proven hit (B3): failures, missing usage, double
 * zero, disconnects, HTTP errors, network errors, and `proven-write` (a
 * positive signal a real write happened). All of it counts against the
 * session-level breaker and is never undone by a real request (I-K7).
 * I-K8: dropped silently (no counting at all) on epoch mismatch.
 */
export function onUnproven(
  window: WindowState,
  session: SessionTotals,
  pingEpoch: number,
  kind: UnprovenKind,
  now: Millis,
): ReducerOutcome {
  if (pingEpoch !== window.windowEpoch) return { applied: false, window, session };
  const newWindow: WindowState = {
    ...window,
    pingInFlight: false,
    capture: undefined, // stop this window from pinging again.
    lastStopReason: kind,
  };
  const unprovenTotal = session.unprovenTotal + 1;
  const consecutiveUnproven = session.consecutiveUnproven + 1;
  const provenWrites = kind === "proven-write" ? session.provenWrites + 1 : session.provenWrites;
  const shouldDisable =
    provenWrites >= 1 || consecutiveUnproven >= UNPROVEN_STREAK_LIMIT || unprovenTotal >= UNPROVEN_TOTAL_LIMIT;
  const newSession: SessionTotals = {
    ...session,
    unprovenTotal,
    consecutiveUnproven,
    provenWrites,
    lastUnproven: { kind, at: now },
    disabled: shouldDisable ? (session.disabled ?? { reason: kind, at: now }) : session.disabled,
  };
  return { applied: true, window: newWindow, session: newSession };
}

/**
 * Explicit invalidation (payload-shape anomaly, compaction, model switch,
 * fingerprint drift, ...). Bumps `windowEpoch` (I-K8) so any ping already in
 * flight for the old window is discarded on return. Deliberately touches
 * only the three fields plan.md §5.3 specifies — nothing else.
 */
export function invalidate(window: WindowState, _reason: InvalidateReason): WindowState {
  return { ...window, capture: undefined, upgradePending: false, windowEpoch: window.windowEpoch + 1 };
}

// ---------------------------------------------------------------------------
// One-shot 1h upgrade after budget exhaustion (plan.md §6.3, I-K5)
// ---------------------------------------------------------------------------

export interface ConsumeUpgradeInput {
  /** I-K6: the caller must have already verified session/instance identity. */
  sessionMatches: boolean;
  mode: "auto" | "on" | "off";
  upgradeAfterBudgetEnabled: boolean;
  now: Millis;
  assumedTtlMs?: Millis;
  /** task #14: compact-hint says the prefix is about to be discarded ⇒ never upgrade (stays pending). */
  switchImminent?: boolean;
}

export interface ConsumeUpgradeResult {
  consumed: boolean;
  window: WindowState;
}

/**
 * Only fires when the next real request is *guaranteed* to be a full write
 * anyway (now − lastReadStartedAt > TTL) — otherwise this would be actively
 * paying the 2× 1h rate instead of the 1.25× 5m rate. I-K5: only in `auto`
 * mode; never touches explicit `on`/`off`.
 */
export function consumeUpgrade(window: WindowState, input: ConsumeUpgradeInput): ConsumeUpgradeResult {
  const assumedTtlMs = input.assumedTtlMs ?? ASSUMED_TTL_MS;
  const eligible =
    window.upgradePending &&
    input.sessionMatches &&
    input.mode === "auto" &&
    input.upgradeAfterBudgetEnabled &&
    input.switchImminent !== true &&
    window.lastReadStartedAt !== undefined &&
    input.now - window.lastReadStartedAt > assumedTtlMs;
  if (!eligible) return { consumed: false, window };
  return { consumed: true, window: { ...window, upgradePending: false } };
}

// ---------------------------------------------------------------------------
// Cost estimation (plan.md §7.6, M5 — never claim $0 for an unknown rate)
// ---------------------------------------------------------------------------

export interface KeepaliveCostTier {
  inputTokensAbove: number;
  cacheRead?: number;
}

/** Minimal structural echo of pi-ai's `Model["cost"]` shape (models.js `calculateCost`). */
export interface KeepaliveCostModel {
  cacheRead?: number;
  tiers?: KeepaliveCostTier[];
}

/**
 * Mirrors pi-ai `models.js` `calculateCost`'s tier selection (highest
 * `inputTokensAbove` strictly below `tokens`), applied to the cache-read
 * rate only. Returns `undefined` (never `0`) when the rate is unknown or
 * zero — M5: the UI must show "cost unknown", not a misleading `$0`.
 */
export function cacheReadCostUsd(cost: KeepaliveCostModel | undefined, tokens: number): number | undefined {
  if (!cost || tokens <= 0) return undefined;
  let rate = cost.cacheRead;
  let matchedThreshold = -1;
  for (const tier of cost.tiers ?? []) {
    if (tokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold && tier.cacheRead !== undefined) {
      rate = tier.cacheRead;
      matchedThreshold = tier.inputTokensAbove;
    }
  }
  if (rate === undefined || rate === 0) return undefined;
  return (rate / 1_000_000) * tokens;
}

// ---------------------------------------------------------------------------
// Status bar + `/cache-ttl status` text (plan.md §9.1/§9.4)
// ---------------------------------------------------------------------------

export interface KeepaliveReport {
  enabled: boolean;
  armed: boolean;
  window: WindowState;
  session: SessionTotals;
  config: KeepaliveConfig;
  costUsd: number | undefined;
  dropped: { sessionMismatch: number; instanceMismatch: number; epochMismatch: number };
  lastSkip: TickSkipReason | undefined;
  prefixSource: "usage" | "unknown" | undefined;
  /**
   * Corrective fix (unrelated to the header bug, same audit pass): mirrors
   * `ctx.model.compat.supportsLongCacheRetention` (Anthropic-messages compat
   * flag; pi's own default is `true` when unset). `false` means pi will
   * never write `cache_control.ttl: "1h"` for this model on this route no
   * matter what `/cache-ttl on` or the budget-exhausted upgrade do — so the
   * `→1h` status hint would be an outright lie. `false` here also when the
   * service couldn't read `ctx.model` at all (conservative: don't promise a
   * transition we can't confirm is possible).
   */
  supportsLongCacheRetention: boolean;
  /**
   * Diagnostic fix (audit gap): the last resolved ping's full context, so
   * `/cache-ttl status` can answer "why did/didn't this land" without session-
   * file archaeology. `undefined` before the first ping resolves this session.
   * Never carries header/auth VALUES — only key names (`headerKeyDiff`).
   */
  lastPingDiagnostics: KeepalivePingDiagnostics | undefined;
}

/** See `KeepaliveReport.lastPingDiagnostics`. */
export interface KeepalivePingDiagnostics {
  at: Millis;
  /** `"proven-hit"` or any `UnprovenKind` (`"proven-write"`, `"no-usage"`, `"http"`, ...). */
  outcomeKind: string;
  elapsedSinceCaptureMs: number;
  prefixTokens: number;
  prefixSource: "usage" | "unknown";
  cacheReadInputTokens: number | undefined;
  cacheCreationInputTokens: number | undefined;
  headerSource: PingHeaderSource;
  /** Key NAMES only (never values) that were absent from the capture and filled from auth fallback. */
  headerKeyDiff: string[];
  model: string;
  baseUrl: string;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function formatCost(costUsd: number | undefined): string {
  return costUsd === undefined ? "unknown" : `≈$${costUsd.toFixed(2)}`;
}

/** The cache-TTL modes (mirrors `config/settings.ts`'s `CacheTtlMode` structurally — kept as a local literal union so this pi-free module never imports from `../config/`). */
export type CacheDisplayMode = "auto" | "on" | "off" | "adaptive";

export interface CacheStatusInput {
  mode: CacheDisplayMode;
  dirty: boolean;
  /** `undefined` ⇒ the keepalive service isn't present (setting off, or not yet built). */
  report: KeepaliveReport | undefined;
  /** `undefined` ⇒ adaptive isn't in play (mode isn't adaptive, or the service isn't wired). */
  adaptive?: AdaptiveSnapshot | undefined;
}

// ---------------------------------------------------------------------------
// Structured status snapshot (adaptive plan.md §8.1 — segments first, strings
// second, so a future HUD renderer can colorize without re-parsing text).
// ---------------------------------------------------------------------------

export type CacheSegmentKind = "mode" | "ttl-now" | "ping" | "adaptive";
export type CacheSegmentTone = "neutral" | "info" | "good" | "warn" | "bad";

export interface CacheStatusSegment {
  kind: CacheSegmentKind;
  /** Stable machine-readable id (HUD coloring/ordering hook), never internationalized. */
  id: string;
  /** Human-readable short text (the current TUI status bar joins these). */
  text: string;
  tone: CacheSegmentTone;
  /** Optional structured detail for HUD expansion — never pre-assembled strings. */
  detail?: Record<string, string | number | boolean>;
}

export interface CacheStatusSnapshot {
  mode: CacheDisplayMode;
  dirty: boolean;
  /** What the current request actually writes — the line the user most wants. */
  effectiveTtl: "1h" | "5m" | "provider-default" | "unknown";
  /** Why it's that (upgrade signals joined / decline reason / "mode:on" …), machine-readable. */
  effectiveReason: string;
  segments: readonly CacheStatusSegment[];
  keepalive?: KeepaliveReport;
  adaptive?: AdaptiveSnapshot;
}

/**
 * Status-bar abbreviations for the breaker reasons. The merged status line is a
 * single terminal row shared with every other extension's status (cache-ttl is
 * its longest contributor), so the longest reason gets a shorter display form.
 * Only the display text is abbreviated: `detail.reason` keeps the machine id and
 * `/cache-ttl status` still prints it in full. The map is exhaustive over
 * `AdaptiveBreakerReason` on purpose — a new reason fails to compile here rather
 * than silently reverting to a raw name of unbounded length.
 */
const BREAKER_DISPLAY: Record<AdaptiveBreakerReason, string> = {
  "warm-write-too-expensive": "warm-write-costly",
  "warm-miss": "warm-miss",
  "write-budget": "write-budget",
  "1h-ineffective": "1h-ineffective",
};

/** adaptive plan.md §8.2: the ttl-now / cover / budget / breaker segments (only in adaptive mode with a snapshot). */
function adaptiveSegments(snapshot: AdaptiveSnapshot): CacheStatusSegment[] {
  const segments: CacheStatusSegment[] = [];
  const last = snapshot.lastDecision;
  // A tripped breaker short-circuits the upgrade, so the ttl-now segment is
  // derivable from `off:<reason>` and only spends status-line width (plan.md
  // §8.2's breaker row is `cache adaptive · off:<reason>`): drop it.
  if (snapshot.breaker === undefined) {
    if (last?.upgrade === true) {
      // "→1h?" (warn) while every 1h write so far is unconfirmed (proxy may be
      // dropping the cache_creation split — plan.md §5.2).
      const unconfirmedOnly = snapshot.unconfirmed1hWrites > 0 && snapshot.confirmed1hWrites === 0;
      segments.push({
        kind: "ttl-now",
        id: "ttl-now:1h",
        text: `→1h${unconfirmedOnly ? "?" : ""}${last.signals.length > 0 ? ` (${last.signals.join("+")})` : ""}`,
        tone: unconfirmedOnly ? "warn" : "good",
      });
    } else {
      segments.push({ kind: "ttl-now", id: "ttl-now:5m", text: "5m", tone: "neutral" });
    }
  }
  if (snapshot.coverRemainingMs !== undefined) {
    segments.push({
      kind: "adaptive",
      id: "adaptive:cover",
      text: `1h cover ${Math.ceil(snapshot.coverRemainingMs / 60_000)}m`,
      tone: "info",
      detail: { coverRemainingMs: snapshot.coverRemainingMs },
    });
  }
  // Dual budget gate: USD is primary, tokens are the fallback for routes without
  // cost data. The segment shows whichever budget is CLOSER to its cap (the one
  // about to fire), while `detail` keeps both pairs of exact numbers.
  const tokenFraction = snapshot.writeBudgetTokens > 0 ? snapshot.budgetFraction : 0;
  const usdFraction = snapshot.writeBudgetUsd > 0 ? snapshot.usdFraction : 0;
  const worstFraction = Math.max(tokenFraction, usdFraction);
  if (worstFraction >= 0.8) {
    segments.push({
      kind: "adaptive",
      id: "adaptive:budget",
      // Percentage, not `198k/200k`: the segment only appears at ≥80% so the
      // question it answers is "how close to the cap", and the exact tokens
      // stay in `detail` (HUD expansion) + `/cache-ttl status`.
      text: `budget ${Math.floor(worstFraction * 100)}%`,
      tone: "warn",
      detail: {
        upgradeWriteTokens: snapshot.upgradeWriteTokens,
        writeBudgetTokens: snapshot.writeBudgetTokens,
        upgradeWriteUsd: snapshot.upgradeWriteUsd,
        writeBudgetUsd: snapshot.writeBudgetUsd,
        feeWriteTokens: snapshot.feeWriteTokens,
        feeBudgetTokens: snapshot.feeBudgetTokens,
        feeWriteUsd: snapshot.feeWriteUsd,
        feeBudgetUsd: snapshot.feeBudgetUsd,
      },
    });
  }
  if (snapshot.breaker !== undefined) {
    segments.push({
      kind: "adaptive",
      id: "adaptive:breaker",
      text: `off:${BREAKER_DISPLAY[snapshot.breaker.reason]}`,
      tone: "bad",
      detail: { reason: snapshot.breaker.reason, at: snapshot.breaker.at },
    });
  }
  return segments;
}

/**
 * Single structured snapshot of the merged status line. `renderCacheStatus`
 * below is a thin wrapper over this (join of segment texts) so the two never
 * disagree. Note the segment text dropped the pre-refactor colon
 * (`cache: 5m` → `cache 5m`) when the segments became independently
 * colourisable — the modes are behaviourally unchanged, the label is not
 * byte-identical.
 */
export function buildCacheStatusSnapshot(input: CacheStatusInput): CacheStatusSnapshot {
  const { mode, dirty, report, adaptive } = input;
  const segments: CacheStatusSegment[] = [];
  if (mode === "on")
    segments.push({ kind: "mode", id: "mode:on", text: `cache 1h${dirty ? "*" : ""}`, tone: "neutral" });
  else if (mode === "off")
    segments.push({ kind: "mode", id: "mode:off", text: `cache 5m${dirty ? "*" : ""}`, tone: "neutral" });
  else if (mode === "adaptive")
    segments.push({ kind: "mode", id: "mode:adaptive", text: `cache adaptive${dirty ? "*" : ""}`, tone: "neutral" });

  let effectiveTtl: CacheStatusSnapshot["effectiveTtl"];
  let effectiveReason: string;
  if (mode === "adaptive") {
    if (adaptive) segments.push(...adaptiveSegments(adaptive));
    effectiveTtl = adaptive?.lastDecision?.upgrade === true ? "1h" : "5m";
    effectiveReason =
      adaptive?.lastDecision === undefined
        ? "no-decision"
        : adaptive.lastDecision.upgrade
          ? adaptive.lastDecision.signals.join("+")
          : (adaptive.lastDecision.reason ?? "no-decision");
  } else {
    effectiveTtl = mode === "on" ? "1h" : mode === "off" ? "5m" : "provider-default";
    effectiveReason = `mode:${mode}`;
  }

  const pingText = renderPingSegment(mode, report);
  if (pingText !== undefined) segments.push({ kind: "ping", id: "ping:status", text: pingText, tone: "neutral" });

  return {
    mode,
    dirty,
    effectiveTtl,
    effectiveReason,
    segments,
    ...(report !== undefined ? { keepalive: report } : {}),
    ...(adaptive !== undefined ? { adaptive } : {}),
  };
}

/** Multi-line `/cache-ttl status` section for the adaptive predictor (adaptive plan.md §8.3). */
export function renderAdaptiveReportLines(snapshot: AdaptiveSnapshot): string[] {
  const lines: string[] = [];
  const last = snapshot.lastDecision;
  if (last === undefined) {
    lines.push("adaptive: no decision yet");
  } else if (last.upgrade) {
    lines.push(
      `adaptive: last=upgrade(${last.class ?? "?"}${last.signals.length > 0 ? `, ${last.signals.join("+")}` : ""}) @ ${last.at}`,
    );
  } else {
    lines.push(`adaptive: last=declined(${last.reason ?? "?"}) @ ${last.at}`);
  }
  const cooldown =
    snapshot.coldCooldownRemainingMs === undefined || snapshot.coldCooldownRemainingMs === 0
      ? "cooldown ready"
      : `cooldown ${Math.ceil(snapshot.coldCooldownRemainingMs / 60_000)}m`;
  const budgetUsd =
    snapshot.writeBudgetUsd > 0
      ? `$${snapshot.upgradeWriteUsd.toFixed(2)}/$${snapshot.writeBudgetUsd.toFixed(2)}`
      : `$${snapshot.upgradeWriteUsd.toFixed(2)}/off`;
  lines.push(
    `adaptive budget: write ${formatTokenCount(snapshot.upgradeWriteTokens)}/${formatTokenCount(snapshot.writeBudgetTokens)} tok · ${budgetUsd} · warm ${snapshot.warmUpgrades} · cold ${snapshot.coldUpgradesUsed}/${snapshot.coldUpgradeCap} · ${cooldown} · longGaps=${snapshot.longGapCount}`,
  );
  // Entry fee (plan.md §16.3): the one-time full-prefix 1h write. Shown as its own
  // line because it is a different KIND of spend from the marginal budget above
  // — reading them as one number is exactly the mistake the split fixes.
  const feeUsd =
    snapshot.feeBudgetUsd > 0
      ? `$${snapshot.feeWriteUsd.toFixed(2)}/$${snapshot.feeBudgetUsd.toFixed(2)}`
      : `$${snapshot.feeWriteUsd.toFixed(2)}/off`;
  lines.push(
    `adaptive entry fee: paid ${snapshot.feeUpgrades}× · ${formatTokenCount(snapshot.feeWriteTokens)}/${formatTokenCount(snapshot.feeBudgetTokens)} tok · ${feeUsd}${snapshot.feeBudgetExhausted ? " · exhausted (no new prefix)" : ""}`,
  );
  const cover =
    snapshot.coverRemainingMs !== undefined
      ? `cover ends in ${Math.ceil(snapshot.coverRemainingMs / 60_000)}m`
      : "no cover";
  lines.push(
    `adaptive 1h: confirmed ${snapshot.confirmed1hWrites} · unconfirmed ${snapshot.unconfirmed1hWrites} · indirect ${snapshot.indirect1hConfirms} · ineffective ${snapshot.ineffective1h} · ${cover}`,
  );
  if (snapshot.lastReconcile !== undefined) {
    const r = snapshot.lastReconcile;
    lines.push(
      `adaptive last reconcile: cacheRead=${formatTokenCount(r.cacheRead)} cacheWrite=${formatTokenCount(r.cacheWrite)} cacheWrite1h=${r.cacheWrite1h ?? "n/a"} cacheWrite$=${r.cacheWriteUsd !== undefined ? `$${r.cacheWriteUsd.toFixed(3)}` : "n/a"} cost=${r.costTotalUsd !== undefined ? `$${r.costTotalUsd.toFixed(3)}` : "n/a"}`,
    );
  }
  lines.push(
    snapshot.breaker !== undefined
      ? `adaptive breaker: disabled: ${snapshot.breaker.reason} @ ${snapshot.breaker.at}`
      : "adaptive breaker: none",
  );
  lines.push(`adaptive dropped: pending=${snapshot.droppedPending}`);
  return lines;
}

/**
 * The one and only `"ping ..."` segment of the merged status line — every
 * case from the task's required text table, minus the leading mode prefix
 * (the segments are joined by `renderCacheStatus` below). `undefined` ⇒
 * nothing keepalive-related worth showing right now.
 */
function renderPingSegment(mode: CacheDisplayMode, report: KeepaliveReport | undefined): string | undefined {
  if (report === undefined) return undefined;
  const { session, window, config } = report;

  if (session.disabled !== undefined) {
    return `ping off:${session.disabled.reason} ×${session.pings}`;
  }
  if (window.pings > 0 && window.pings >= config.maxPings) {
    // I-K5: mode !== "auto" means the caller (cache-ttl.ts) never lets
    // consumeUpgrade fire, so promising "→1h" in that configuration would be
    // a lie about what actually happens next. Also gated on
    // `supportsLongCacheRetention` (compat-flag fix, same audit pass): a
    // model/route that never accepts `ttl:"1h"` can never actually upgrade,
    // regardless of mode/budget settings. adaptive plan.md §6.2: in adaptive
    // mode this hint intentionally disappears (mode !== "auto") — the
    // adaptive segments in buildCacheStatusSnapshot take over.
    const upgradeHint = mode === "auto" && config.upgradeAfterBudget && report.supportsLongCacheRetention ? " →1h" : "";
    return `ping ${window.pings}/${config.maxPings} capped${upgradeHint}`;
  }
  if (window.lastStopReason !== undefined) {
    return `ping paused:${window.lastStopReason}`;
  }
  if (session.pings === 0 && window.pings === 0) return undefined;
  const cumulative = session.pings > window.pings ? ` Σ${session.pings}` : "";
  return `ping ${window.pings}/${config.maxPings}${cumulative} · ${formatTokenCount(session.cacheReadTokens)} · ${formatCost(report.costUsd)}`;
}

/**
 * Single status-bar segment (key `"cache-ttl"`) merging what used to be two
 * independent segments (`cache-ttl` mode + `cache-keepalive` ping activity —
 * see the task's merge requirement). This is the ONLY place that assembles
 * the text; both `cache-ttl.ts` (mode/dirty changes, session_start) and
 * `cache-keepalive.ts` (ping/window/session state changes) call this with
 * whatever `report` they currently have, so the two writers of the shared
 * key never disagree about formatting — only about timing (last-writer-wins
 * on a fresh string, not a fresh format).
 */
export function renderCacheStatus(input: CacheStatusInput, theme?: CacheStatusTheme): string | undefined {
  const snapshot = buildCacheStatusSnapshot(input);
  if (snapshot.segments.length === 0) return undefined;
  if (!theme) return snapshot.segments.map((segment) => segment.text).join(" · ");
  return snapshot.segments.map((segment) => colorizeSegment(segment, theme)).join(theme.fg("dim", " · "));
}

/** The subset of pi's `Theme` this module needs; kept structural so tests need no pi UI. */
export interface CacheStatusTheme {
  fg(color: string, text: string): string;
}

/** Older pi builds (and non-TUI contexts) have no `ctx.ui.theme` — then the status stays plain text. */
export function readCacheStatusTheme(ctx: unknown): CacheStatusTheme | undefined {
  const theme = (ctx as { ui?: { theme?: unknown } } | undefined)?.ui?.theme;
  return typeof (theme as CacheStatusTheme | undefined)?.fg === "function" ? (theme as CacheStatusTheme) : undefined;
}

/** `CacheSegmentTone` → HUD palette, so the cache segments match the rest of the footer. */
const TONE_COLOR: Record<CacheSegmentTone, string> = {
  neutral: "text",
  info: "accent",
  good: "success",
  warn: "warning",
  bad: "error",
};

/**
 * The HUD convention is a dim label followed by a bright value (`input 32`),
 * so the mode segment's leading `cache` word is dimmed and only the mode name
 * carries the tone colour. Every other segment is a bare value.
 */
function colorizeSegment(segment: CacheStatusSegment, theme: CacheStatusTheme): string {
  const color = TONE_COLOR[segment.tone];
  if (segment.kind === "mode") {
    const spaceAt = segment.text.indexOf(" ");
    if (spaceAt > 0) {
      return `${theme.fg("dim", segment.text.slice(0, spaceAt))} ${theme.fg(color, segment.text.slice(spaceAt + 1))}`;
    }
  }
  return theme.fg(color, segment.text);
}

/** Multi-line `/cache-ttl status` body (plan.md §9.4's required field list). */
export function renderKeepaliveReportLines(report: KeepaliveReport): string[] {
  const { config, window, session, dropped } = report;
  const lines: string[] = [];
  lines.push(`enabled: ${report.enabled ? "on" : "off"}`);
  lines.push(
    `interval: ${Math.round(config.intervalMs / 1000)}s · cap: ${config.maxPings}/window · min prefix: ${config.minPrefixTokens} tok`,
  );
  lines.push(`window: ${window.pings}/${config.maxPings} (${report.armed ? "armed" : "idle"})`);
  lines.push(
    `session: ${session.pings} ping · cache-read ${formatTokenCount(session.cacheReadTokens)} tok · cost ${formatCost(report.costUsd)}`,
  );
  if (report.prefixSource !== undefined) lines.push(`prefix source: ${report.prefixSource}`);
  lines.push(`long cache retention (1h) supported: ${report.supportsLongCacheRetention ? "yes" : "no"}`);
  lines.push(
    `audit: load-bearing ${session.loadBearingWindows} window/${session.loadBearingPings} ping · unnecessary ${session.unnecessaryWindows} window/${session.unnecessaryPings} ping · discarded-by-1h ${session.discardedWindows} window/${session.discardedPings} ping · avoided rewrite ${session.avoidedMissTokens} tok`,
  );
  if (session.lastUnproven !== undefined)
    lines.push(`last outcome: ${session.lastUnproven.kind} @ ${session.lastUnproven.at}`);
  if (report.lastPingDiagnostics !== undefined) {
    const d = report.lastPingDiagnostics;
    const headerDiff = d.headerKeyDiff.length > 0 ? ` (filled: ${d.headerKeyDiff.join(",")})` : "";
    lines.push(
      `last ping: ${d.outcomeKind} @ ${d.at} · +${d.elapsedSinceCaptureMs}ms since capture · prefix ${d.prefixTokens}tok (${d.prefixSource}) · cache_read=${d.cacheReadInputTokens ?? "n/a"} cache_creation=${d.cacheCreationInputTokens ?? "n/a"} · headers: ${d.headerSource}${headerDiff} · model=${d.model} · baseUrl=${d.baseUrl}`,
    );
  }
  lines.push(
    `breaker: unprovenTotal=${session.unprovenTotal} consecutiveUnproven=${session.consecutiveUnproven} provenWrites=${session.provenWrites}`,
  );
  lines.push(
    session.disabled !== undefined ? `disabled: ${session.disabled.reason} @ ${session.disabled.at}` : "not disabled",
  );
  lines.push(
    `dropped: sessionMismatch=${dropped.sessionMismatch} instanceMismatch=${dropped.instanceMismatch} epochMismatch=${dropped.epochMismatch}`,
  );
  if (report.lastSkip !== undefined) lines.push(`last skip: ${report.lastSkip}`);
  return lines;
}
