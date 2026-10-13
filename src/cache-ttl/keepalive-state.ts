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
/**
 * Largest `intervalMs` that still leaves room for a "ping" decision to fire at all.
 *
 * `evaluateTick`'s #13 (`cache-expired`, checked at `now >= aliveUntil - TTL_SAFETY_MARGIN_MS`)
 * runs BEFORE #15 (`not-due`, checked at `now < nextPingAt`) — see `onRealRequest`'s
 * `aliveUntil = now + ASSUMED_TTL_MS` / `nextPingAt = now + intervalMs`. Once
 * `intervalMs > ASSUMED_TTL_MS - TTL_SAFETY_MARGIN_MS - TICK_INTERVAL_MS`, `nextPingAt` falls at
 * or after the cache-expired cutoff, so #13 always wins first and the window can NEVER reach
 * `ping` — a session configured this way silently never pings, no matter how long a tool runs
 * (found investigating todo #15's real-machine "never pings" report, 2026-09-27; the report's own
 * default-settings case had exactly `TICK_INTERVAL_MS` = 15s of margin at the 240s default —
 * this constant pins that margin so a user-configured `keepaliveIntervalMs` can't erase it).
 * `src/config/settings.ts` clamps `keepaliveIntervalMs` to this value.
 */
export const MAX_SAFE_KEEPALIVE_INTERVAL_MS: Millis = ASSUMED_TTL_MS - TTL_SAFETY_MARGIN_MS - TICK_INTERVAL_MS;
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
  /** Start time of the most recent PROVEN cache read in this window. */
  lastProvenPingStartedAt: Millis | undefined;
  /**
   * Non-plan addition (documented deviation, see final reply): the reason the
   * *current* window stopped pinging after an unproven result, so status
   * text (§9.1 "本轮已停：<kind>") doesn't need extra service-side
   * bookkeeping. Cleared on the next real request; left untouched by
   * `invalidate()` (which only touches the two fields plan.md specifies).
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
    lastStopReason: undefined,
  };
}

export interface SessionTotals {
  /** Total successful (proven-hit) pings this session. */
  pings: number;
  cacheReadTokens: number;
  /** Legacy aggregate streak, retained for status/readback compatibility. */
  consecutiveUnproven: number;
  /** Legacy aggregate total, retained for status/readback compatibility. */
  unprovenTotal: number;
  /** Monotonic — a single proven write disables the session forever. */
  provenWrites: number;
  /** Transient-only breaker counters; the real-request recovery path clears these. */
  transientConsecutiveUnproven: number;
  transientUnprovenTotal: number;
  /** Non-transient breaker counters; these remain session-permanent. */
  nonTransientConsecutiveUnproven: number;
  nonTransientUnprovenTotal: number;
  /** `transient: true` marks a disable that a successful real request may clear. */
  disabled: { reason: string; at: Millis; transient?: true } | undefined;
  lastUnproven: { kind: string; at: Millis } | undefined;
  /**
   * O3 (provider-evidence breaker, 2026-10-12): this session's keepalive-active-but-zero-read
   * verdict was already folded into the provider evidence ledger at dispose time. Persisted
   * (via the regular session snapshot) so a `/reload`-rebuilt service never counts the SAME
   * session twice.
   */
  noCacheValueCounted?: boolean;
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
    transientConsecutiveUnproven: 0,
    transientUnprovenTotal: 0,
    nonTransientConsecutiveUnproven: 0,
    nonTransientUnprovenTotal: 0,
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

/** The custom entry type used to persist the session-level breaker snapshot. */
export const KEEPALIVE_AUDIT_CUSTOM_TYPE = "subagent:cache-keepalive";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Rehydrate only session-level breaker/accounting fields from the current
 * branch. Window/prefix state is intentionally not restored across /reload.
 * Invalid or partial snapshots degrade field-by-field and never throw.
 */
export function readBackKeepaliveSessionState(branch: readonly unknown[]): SessionTotals | undefined {
  try {
    let restored: SessionTotals | undefined;
    for (const raw of branch) {
      const entry = record(raw);
      if (entry?.type !== "custom" || entry.customType !== KEEPALIVE_AUDIT_CUSTOM_TYPE) continue;
      const data = record(entry.data);
      const snapshot = record(data?.session);
      if (!snapshot) continue;
      const base = restored ?? createInitialSessionTotals();
      const next: SessionTotals = { ...base };
      for (const key of [
        "pings",
        "cacheReadTokens",
        "consecutiveUnproven",
        "unprovenTotal",
        "provenWrites",
        "transientConsecutiveUnproven",
        "transientUnprovenTotal",
        "nonTransientConsecutiveUnproven",
        "nonTransientUnprovenTotal",
        "unnecessaryWindows",
        "unnecessaryPings",
        "loadBearingWindows",
        "loadBearingPings",
        "avoidedMissTokens",
        "discardedWindows",
        "discardedPings",
      ] as const) {
        const value = finiteNonNegative(snapshot[key]);
        if (value !== undefined) next[key] = value;
      }
      if ("disabled" in snapshot) {
        const disabled = record(snapshot.disabled);
        if (disabled === undefined) {
          next.disabled = undefined;
        } else {
          const reason = typeof disabled.reason === "string" && disabled.reason !== "" ? disabled.reason : undefined;
          const at = finiteNonNegative(disabled.at);
          if (reason !== undefined && at !== undefined) {
            next.disabled = {
              reason,
              at: at as Millis,
              ...(disabled.transient === true ? { transient: true as const } : {}),
            };
          }
        }
      }
      if ("lastUnproven" in snapshot) {
        const last = record(snapshot.lastUnproven);
        if (last === undefined) next.lastUnproven = undefined;
        else {
          const kind = typeof last.kind === "string" && last.kind !== "" ? last.kind : undefined;
          const at = finiteNonNegative(last.at);
          if (kind !== undefined && at !== undefined) next.lastUnproven = { kind, at: at as Millis };
        }
      }
      // O3: restore the once-per-session accounting guard (see SessionTotals.noCacheValueCounted).
      if (snapshot.noCacheValueCounted === true) next.noCacheValueCounted = true;
      restored = next;
    }
    return restored;
  } catch {
    return undefined;
  }
}

export interface KeepaliveConfig {
  enabled: boolean;
  intervalMs: Millis;
  maxPings: number;
  minPrefixTokens: number;
  /**
   * child-ka-core (plan.md §2.4/§3): additionally allow `mode === "print"`
   * through gate #4 (G2) — a child (subagent) session's run mode. Default
   * `undefined`/falsy ⇒ today's behavior (only `tui`/`rpc`), so the main
   * session is byte-identical unless a caller explicitly opts in.
   */
  allowHeadless?: boolean;
  /**
   * child-ka-core: cumulative PROVEN-HIT ping cap across the whole run (all
   * windows), independent of the per-window `maxPings`. Checked against
   * `session.pings` (plan.md §2.4: "`session.pings >= maxSessionPings`").
   * Default `undefined` = unbounded (today's behavior).
   */
  maxSessionPings?: number;
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
  | "cache-expired"
  | "budget-exhausted"
  /** child-ka-core: per-run proven-hit cap (`config.maxSessionPings`) reached — pure, checked in `evaluateTick`. */
  | "session-cap"
  /** child-ka-core: pi's own native `CacheWarmer` already handles this model/route (declares `promptCache`) — pinging too would double-warm. Pure, checked in `evaluateTick` via `nativeWarmerActive`. */
  | "native-warmer"
  /**
   * child-ka-core: the process-wide ping ledger denied a concurrency slot
   * (non-terminal, re-armed at the normal 15s tick like any other
   * non-terminal skip) or the rolling 24h $ budget (terminal). Decided in
   * the SERVICE layer (`cache-keepalive.ts`'s `onTick`, which owns the
   * ledger) — `evaluateTick` never produces these; they only share this
   * union so `report().lastSkip` has one consistent type.
   */
  | "global-cap"
  | "usd-process"
  /** child-ka-core: this run's own $ budget (`runBudgetUsd`) would be exceeded by this ping's estimated cost. Decided in the service layer, see `"global-cap"`. */
  | "usd-run"
  /** child-ka-core: the model/route has no cost data at all — a budget can't be enforced without a price. Decided in the service layer, see `"global-cap"`. */
  | "usd-unpriced"
  /**
   * O3 (provider-evidence breaker, 2026-10-12): this provider+model route is fused off by the
   * persisted evidence ledger — `NO_CACHE_VALUE_STREAK_LIMIT` consecutive sessions had an
   * ACTIVE keepalive yet never observed a single cache read (requests all succeeded; the cache
   * simply never hit, so every ping is provably worthless). Decided in the service layer
   * (`cache-keepalive.ts`'s `onTick`), which also latches `session.disabled` with the same
   * reason so the status bar annotates it and later ticks short-circuit at #2. Resets only via
   * an observed `cacheRead > 0` (`ProviderEvidenceStore.noteCacheRead`).
   */
  | "no-cache-value"
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
  /** child-context-switch plan.md §2.4 ("边界切换不发 session_compact，但会改写前缀，所以 ...
   *  也→ invalidate"): a committed boundary-draft switch_context rewrites the child session's
   *  context exactly like a compaction does; the child cache-ttl wiring (`src/cache-ttl/child.ts`)
   *  invalidates on it the same way it does on `session-compact` above. Main-session behavior is
   *  unaffected — nothing on the main-session path ever passes this reason. */
  | "context-switch"
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
   * O2 follow-up (gate #7 分流, 2026-10-12 用户拍板): whether this capture's provider+model
   * route has PROVEN 1h-write landing evidence, resolved by the SERVICE layer at tick time via
   * the injected evidence store (`provider-evidence.ts`) — this module stays pi-free and never
   * sees the store itself.
   *   - `true`  ⇒ a real 1h entry lives for an hour; gate #7 keeps the legacy `skip("ttl-1h")`.
   *   - `false` ⇒ collapsing route (or the store's read failed — the store fails towards
   *     "no evidence" by design): gate #7 lets the window THROUGH to the ping path, where
   *     `runPing`'s `stripCacheControlTtl` degrades the replay to plain 5m semantics. This is
   *     the safe direction (I6): stripped of `ttl`, the ping is exactly a normal 5m ping — it
   *     cannot do worse than the route's own behaviour.
   *   - `undefined` (no evidence store wired at all) ⇒ legacy byte-identical skip.
   */
  write1hEvidence?: boolean;
  /**
   * child-ka-core: true when pi's own native `CacheWarmer` is already handling
   * this model/route (it declares `promptCache`) — the caller (service layer)
   * derives this from `ctx.model`; `evaluateTick` itself never reads `ctx`.
   * Absent/false ⇒ today's behavior.
   */
  nativeWarmerActive?: boolean;
}

export interface TickResult {
  decision: TickDecision;
  /** Possibly-updated window (only rule #9 `invalidate` mutates it). */
  window: WindowState;
}

export function evaluateTick(input: EvaluateTickInput): TickResult {
  const { config, session, window, armed, mode, now, currentFingerprint, nativeWarmerActive } = input;

  const skip = (reason: TickSkipReason, terminal: boolean): TickResult => ({
    decision: { kind: "skip", reason, terminal },
    window,
  });

  // #1
  if (!config.enabled) return skip("disabled", true);
  // #2 — I-K7: session-level breaker, never reset by a real request.
  if (session.disabled !== undefined) return skip("session-disabled", true);
  // #2.5 — child-ka-core: per-run proven-hit cap across all windows, independent of
  // (and checked before) the per-window #14 budget below. `undefined` ⇒ unbounded
  // (today's behavior — main session never sets this).
  if (config.maxSessionPings !== undefined && session.pings >= config.maxSessionPings) {
    return skip("session-cap", true);
  }
  // #3
  const capture = window.capture;
  if (capture === undefined) return skip("no-capture", true);
  // #4 — G2. child-ka-core: `allowHeadless` additionally allows "print" (a child
  // session's run mode) — the main session never sets this, so its behavior is
  // byte-identical (only "tui"/"rpc" pass).
  const modeAllowed = RUN_MODES_ALLOWING_PING.has(mode) || (config.allowHeadless === true && mode === "print");
  if (!modeAllowed) return skip("mode", true);
  // #4.5 — child-ka-core: pi's own native CacheWarmer already handles this
  // model/route (declares `promptCache`) — pinging too would double-warm it.
  if (nativeWarmerActive === true) return skip("native-warmer", true);
  // #5 — G3 + G4
  if (capture.fingerprint.api !== ANTHROPIC_MESSAGES_API || PING_DENY_PROVIDERS.has(capture.fingerprint.provider)) {
    return skip("not-anthropic", true);
  }
  // #6 — G5
  if (capture.shape.ephemeralBreakpoints === 0) return skip("no-cache-control", true);
  // #7 — G5. O2 follow-up (分流): a ttl:"1h" capture is skipped only on a route with PROVEN
  // 1h landing evidence (`write1hEvidence === true`, incl. the legacy `undefined` default) —
  // there a real 1h entry lives an hour and the 5m ping cadence doesn't match its semantics.
  // Without evidence (collapsing relay / store read failure) the window falls through to the
  // ping path and `runPing` strips `ttl` (see ping-client.ts's `stripCacheControlTtl`): the
  // 5m-based interval / budget / aliveUntil assumptions below then apply UNCHANGED, which is
  // exactly right — stripped of the intent field, the entry really is a 5m entry.
  if (capture.shape.ttl1h && input.write1hEvidence !== false) return skip("ttl-1h", true);
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
  // #12 — G8
  if (!armed) return skip("not-armed", false);
  // #13 — most important: the cache is presumed dead, pinging now would be a full write.
  if (window.aliveUntil !== undefined && now >= window.aliveUntil - TTL_SAFETY_MARGIN_MS) {
    return skip("cache-expired", true);
  }
  // #14 — I-K2 hard budget.
  if (window.pings >= config.maxPings) return skip("budget-exhausted", true);
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
 * R4 (cache review 2026-09-25): a cheap identity of the prefix LINEAGE — the
 * parts of the payload that, when they change, make every cached entry of the
 * previous lineage unreadable (system text digest, tool list, thinking config).
 * Two requests with different keys cannot share a cache prefix, so cache state
 * must never carry assumptions across lineages (field: wake turns ran without
 * the memory/agent sections, 01a0d2f9 / 01a0d2e4). Same digests `CaptureFingerprint` uses (G7).
 */
export function payloadLineageKey(payload: unknown): string | undefined {
  if (!isObjectRecord(payload)) return undefined;
  // Byte-level (not canonical) serialization on purpose (review round 3): the
  // upstream cache matches BYTE prefixes, so two tool lists that differ only in
  // key order are already different cache lineages — canonicalizing would hide a
  // real lineage split. pi serializes its own tool list deterministically.
  // Review round 2 (R8): hash the FULL content. The fingerprint digests above
  // (length + first/last 64 chars, tool names only) are fine for G7's drift
  // alarm but collide on exactly the edits that split lineages in the field — a
  // same-length change in the middle of the system prompt (memory frontmatter
  // timestamps) or a tool schema/description change under the same name.
  const systemText = extractText(payload.system);
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  let toolsJson: string;
  let thinkingJson: string;
  try {
    toolsJson = JSON.stringify(tools) ?? "";
    thinkingJson = payload.thinking !== undefined ? (JSON.stringify(payload.thinking) ?? "") : "";
  } catch {
    // Unserializable (cyclic) content has no reliable identity — report "unknown"
    // (lineage unchecked) rather than a lossy stand-in that could collide.
    return undefined;
  }
  return `${systemText.length}:${hash53(systemText)}|${tools.length}:${hash53(toolsJson)}|${hash53(thinkingJson)}`;
}

/**
 * 53-bit content hash (cyrb53) over UTF-16 code units — fast and dependency-free.
 * Not cryptographic: an accidental collision needs ~10⁸ distinct lineages in one
 * session (review round 3 asked for more than 32 bits), and a collision's worst
 * case stays bounded by the cover window, probes and budgets.
 */
function hash53(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
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
    lastStopReason: undefined,
  };
  return { window: newWindow, session: closedSession };
}

/** The real request that opened the current window has settled (message_end / turn_end / agent_end / agent_settled). */
export function onRequestSettled(window: WindowState): WindowState {
  return window.requestInFlight ? { ...window, requestInFlight: false } : window;
}

/**
 * A real provider response is the only settle event that can recover a
 * transient breaker. Pi emits several settle-shaped events for one request;
 * callers pass the assistant message from whichever event they have.
 */
export function isSuccessfulRealRequest(message: unknown): boolean {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return false;
  const candidate = message as { role?: unknown; usage?: unknown; stopReason?: unknown };
  return (
    candidate.role === "assistant" &&
    candidate.usage !== undefined &&
    candidate.usage !== null &&
    typeof candidate.usage === "object" &&
    !Array.isArray(candidate.usage) &&
    candidate.stopReason !== "error" &&
    candidate.stopReason !== "aborted"
  );
}

function isTransientUnproven(kind: UnprovenKind, httpStatus?: number): boolean {
  if (kind === "network" || kind === "accepted-then-lost" || kind === "malformed") return true;
  if (kind !== "http" || httpStatus === undefined) return false;
  return httpStatus === 408 || httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599);
}

function isPermanentThresholdMet(session: SessionTotals): boolean {
  return (
    session.provenWrites >= 1 ||
    session.nonTransientConsecutiveUnproven >= UNPROVEN_STREAK_LIMIT ||
    session.nonTransientUnprovenTotal >= UNPROVEN_TOTAL_LIMIT
  );
}

/**
 * Recover only a transient disable after a successful real provider request.
 * Economic/semantic failures remain permanent, including a non-transient
 * threshold reached after an earlier transient disable.
 */
export function onSuccessfulRealRequest(session: SessionTotals, successful: boolean): SessionTotals {
  if (!successful || session.disabled?.transient !== true || isPermanentThresholdMet(session)) return session;
  return {
    ...session,
    consecutiveUnproven: 0,
    transientConsecutiveUnproven: 0,
    transientUnprovenTotal: 0,
    disabled: undefined,
  };
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
    transientConsecutiveUnproven: 0,
    nonTransientConsecutiveUnproven: 0,
  };
  return { applied: true, window: newWindow, session: newSession };
}

/**
 * Everything that isn't a proven hit (B3): failures, missing usage, double
 * zero, disconnects, HTTP errors, network errors, and `proven-write` (a
 * positive signal a real write happened). Failures are counted in separate
 * transient and permanent buckets. I-K8: dropped silently (no counting at
 * all) on epoch mismatch.
 */
export function onUnproven(
  window: WindowState,
  session: SessionTotals,
  pingEpoch: number,
  kind: UnprovenKind,
  now: Millis,
  httpStatus?: number,
): ReducerOutcome {
  if (pingEpoch !== window.windowEpoch) return { applied: false, window, session };
  const newWindow: WindowState = {
    ...window,
    pingInFlight: false,
    capture: undefined, // stop this window from pinging again.
    lastStopReason: kind,
  };
  const transient = isTransientUnproven(kind, httpStatus);
  const unprovenTotal = session.unprovenTotal + 1;
  const consecutiveUnproven = session.consecutiveUnproven + 1;
  const provenWrites = kind === "proven-write" ? session.provenWrites + 1 : session.provenWrites;
  const transientConsecutiveUnproven = transient ? session.transientConsecutiveUnproven + 1 : 0;
  const transientUnprovenTotal = transient ? session.transientUnprovenTotal + 1 : session.transientUnprovenTotal;
  const nonTransientConsecutiveUnproven = transient ? 0 : session.nonTransientConsecutiveUnproven + 1;
  const nonTransientUnprovenTotal = transient
    ? session.nonTransientUnprovenTotal
    : session.nonTransientUnprovenTotal + 1;
  const permanent =
    provenWrites >= 1 ||
    nonTransientConsecutiveUnproven >= UNPROVEN_STREAK_LIMIT ||
    nonTransientUnprovenTotal >= UNPROVEN_TOTAL_LIMIT;
  const transientTrip =
    transientConsecutiveUnproven >= UNPROVEN_STREAK_LIMIT || transientUnprovenTotal >= UNPROVEN_TOTAL_LIMIT;
  const disabled = permanent
    ? { reason: kind, at: now }
    : transientTrip
      ? session.disabled?.transient === true
        ? session.disabled
        : { reason: kind, at: now, transient: true as const }
      : session.disabled;
  const newSession: SessionTotals = {
    ...session,
    unprovenTotal,
    consecutiveUnproven,
    provenWrites,
    transientConsecutiveUnproven,
    transientUnprovenTotal,
    nonTransientConsecutiveUnproven,
    nonTransientUnprovenTotal,
    lastUnproven: { kind, at: now },
    disabled,
  };
  return { applied: true, window: newWindow, session: newSession };
}

/**
 * Explicit invalidation (payload-shape anomaly, compaction, model switch,
 * fingerprint drift, ...). Bumps `windowEpoch` (I-K8) so any ping already in
 * flight for the old window is discarded on return. Deliberately touches
 * only the two fields plan.md §5.3 specifies — nothing else.
 */
export function invalidate(window: WindowState, _reason: InvalidateReason): WindowState {
  return { ...window, capture: undefined, windowEpoch: window.windowEpoch + 1 };
}

// ---------------------------------------------------------------------------
// Cost estimation (plan.md §7.6, M5 — never claim $0 for an unknown rate)
// ---------------------------------------------------------------------------

export interface KeepaliveCostTier {
  inputTokensAbove: number;
  cacheRead?: number;
  /** child-ka-core: mirrors pi-ai's per-tier cache-WRITE rate (models.json's `tiers[].cacheWrite`). */
  cacheWrite?: number;
}

/** Minimal structural echo of pi-ai's `Model["cost"]` shape (models.js `calculateCost`). */
export interface KeepaliveCostModel {
  cacheRead?: number;
  /** child-ka-core: pi-ai's cache-WRITE rate (models.json's `cost.cacheWrite`, $ per million tokens). */
  cacheWrite?: number;
  tiers?: KeepaliveCostTier[];
}

/** Shared tier-selection walk (highest `inputTokensAbove` strictly below `tokens`) used by both `cacheReadCostUsd` and `cacheWriteCostUsd` — mirrors pi-ai `models.js`'s `calculateCost`. */
function tieredRate(
  cost: KeepaliveCostModel,
  tokens: number,
  base: number | undefined,
  pickTier: (tier: KeepaliveCostTier) => number | undefined,
): number | undefined {
  let rate = base;
  let matchedThreshold = -1;
  for (const tier of cost.tiers ?? []) {
    const tierRate = pickTier(tier);
    if (tokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold && tierRate !== undefined) {
      rate = tierRate;
      matchedThreshold = tier.inputTokensAbove;
    }
  }
  return rate;
}

/**
 * Mirrors pi-ai `models.js` `calculateCost`'s tier selection (highest
 * `inputTokensAbove` strictly below `tokens`), applied to the cache-read
 * rate only. Returns `undefined` (never `0`) when the rate is unknown or
 * zero — M5: the UI must show "cost unknown", not a misleading `$0`.
 */
export function cacheReadCostUsd(cost: KeepaliveCostModel | undefined, tokens: number): number | undefined {
  if (!cost || tokens <= 0) return undefined;
  const rate = tieredRate(cost, tokens, cost.cacheRead, (t) => t.cacheRead);
  if (rate === undefined || rate === 0) return undefined;
  return (rate / 1_000_000) * tokens;
}

/**
 * child-ka-core (plan.md §2.4): same tier-selection as `cacheReadCostUsd`,
 * applied to the cache-WRITE rate — used to price a `proven-write` outcome
 * (actual `cacheWriteTokens`) and the conservative upper-bound charge for an
 * unproven-but-possibly-billed outcome (estimated on `prefix.tokens`).
 * Returns `undefined` (never `0`) when the rate is unknown or zero.
 */
export function cacheWriteCostUsd(cost: KeepaliveCostModel | undefined, tokens: number): number | undefined {
  if (!cost || tokens <= 0) return undefined;
  const rate = tieredRate(cost, tokens, cost.cacheWrite, (t) => t.cacheWrite);
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
  /**
   * todo #28: the last TERMINAL skip that hit a window which still had a
   * capture (i.e. a window that was actually able to ping, not merely a
   * globally-disabled feature) — deduped to one per `windowEpoch` by the
   * service (`auditTerminalSkipOnce`). This is the main session's "existing
   * diag channel" for the terminal-skip diagnostic (`/cache-ttl status`);
   * child sessions additionally get the same event as a
   * `subagent:cache-keepalive` jsonl audit entry (`kind: "terminal-skip"`)
   * via the shared `audit()` helper, since they have no interactive status
   * command to read this field from.
   */
  lastTerminalSkip?: { reason: TickSkipReason; at: Millis; windowEpoch: number } | undefined;
  prefixSource: "usage" | "unknown" | undefined;
  /**
   * Corrective fix (unrelated to the header bug, same audit pass): mirrors
   * `ctx.model.compat.supportsLongCacheRetention` (Anthropic-messages compat
   * flag; pi's own default is `true` when unset). `false` means pi will
   * never write `cache_control.ttl: "1h"` for this model on this route no
   * matter what `/cache-ttl on` does. `false` here also when the
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
  /**
   * Ping retry (user requirement 2026-09-26): how many HTTP attempts this ping made
   * before settling on `outcomeKind` (1 when no retry was needed). Optional so
   * existing literals (pre-retry callers/tests) stay valid without every one
   * naming a value.
   */
  attempts?: number | undefined;
  /**
   * O2 follow-up (gate #7 分流): this ping's replay had its `cache_control.ttl` stripped
   * (`stripCacheControlTtl`) because the route has no proven 1h landing evidence — the
   * distinguishing marker between an ordinary 5m ping and a "ttl-1h ⇒ 5m 放行" ping in the
   * audit trail and `/cache-ttl status`.
   */
  ttlStripped?: boolean | undefined;
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
export type CacheDisplayMode = "auto" | "on" | "off";

export interface CacheStatusInput {
  mode: CacheDisplayMode;
  dirty: boolean;
  report: KeepaliveReport | undefined;
}

export type CacheSegmentKind = "mode" | "ttl-now" | "ping";
export type CacheSegmentTone = "neutral" | "info" | "good" | "warn" | "bad";

export interface CacheStatusSegment {
  kind: CacheSegmentKind;
  id: string;
  text: string;
  tone: CacheSegmentTone;
  detail?: Record<string, string | number | boolean>;
}

export interface CacheStatusSnapshot {
  mode: CacheDisplayMode;
  dirty: boolean;
  effectiveTtl: "1h" | "5m" | "provider-default" | "unknown";
  effectiveReason: string;
  segments: readonly CacheStatusSegment[];
  keepalive?: KeepaliveReport;
}

export function buildCacheStatusSnapshot(input: CacheStatusInput): CacheStatusSnapshot {
  const { mode, dirty, report } = input;
  const segments: CacheStatusSegment[] = [];
  if (mode === "on")
    segments.push({ kind: "mode", id: "mode:on", text: `cache 1h${dirty ? "*" : ""}`, tone: "neutral" });
  else if (mode === "off")
    segments.push({ kind: "mode", id: "mode:off", text: `cache 5m${dirty ? "*" : ""}`, tone: "neutral" });

  const effectiveTtl = mode === "on" ? "1h" : mode === "off" ? "5m" : "provider-default";
  const effectiveReason = `mode:${mode}`;
  const pingText = renderPingSegment(report);
  if (pingText !== undefined) segments.push({ kind: "ping", id: "ping:status", text: pingText, tone: "neutral" });
  return {
    mode,
    dirty,
    effectiveTtl,
    effectiveReason,
    segments,
    ...(report !== undefined ? { keepalive: report } : {}),
  };
}

/**
 * The one and only `"ping ..."` segment of the merged status line — every
 * case from the task's required text table, minus the leading mode prefix
 * (the segments are joined by `renderCacheStatus` below). `undefined` ⇒
 * nothing keepalive-related worth showing right now.
 */
function renderPingSegment(report: KeepaliveReport | undefined): string | undefined {
  if (report === undefined) return undefined;
  const { session, window, config } = report;
  if (session.disabled !== undefined) return `ping off:${session.disabled.reason} ×${session.pings}`;
  if (window.pings > 0 && window.pings >= config.maxPings) return `ping ${window.pings}/${config.maxPings} capped`;
  if (window.lastStopReason !== undefined) return `ping paused:${window.lastStopReason}`;
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
    const attemptsSuffix = d.attempts !== undefined ? ` · attempts=${d.attempts}` : "";
    const ttlSuffix = d.ttlStripped === true ? " · ttl-stripped(1h→5m)" : "";
    lines.push(
      `last ping: ${d.outcomeKind} @ ${d.at} · +${d.elapsedSinceCaptureMs}ms since capture · prefix ${d.prefixTokens}tok (${d.prefixSource}) · cache_read=${d.cacheReadInputTokens ?? "n/a"} cache_creation=${d.cacheCreationInputTokens ?? "n/a"} · headers: ${d.headerSource}${headerDiff} · model=${d.model} · baseUrl=${d.baseUrl}${attemptsSuffix}${ttlSuffix}`,
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
  if (report.lastTerminalSkip !== undefined) {
    const t = report.lastTerminalSkip;
    lines.push(`terminal skip: ${t.reason} @ ${t.at} (window #${t.windowEpoch})`);
  }
  return lines;
}
