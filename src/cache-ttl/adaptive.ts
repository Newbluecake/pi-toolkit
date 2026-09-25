/**
 * Adaptive 1h predictor — pure state machine (pi-free).
 * Design: docs/dev/cache-ttl-adaptive/plan.md §3 (decision), §4 (probes/breaker),
 * §5 (observability). Second-review amendments baked in:
 *
 * - M1 (ledger anchoring): the warm judgement requires a FRESH ledger —
 *   `entrySeq > lastInvalidateSeq && modelId === ctx.model.id`. pi's compaction
 *   appends and never deletes, so an unanchored ledger stays pre-compact forever
 *   and would false-trip the warm probes into a session-permanent breaker.
 * - M2 (composite probe): trips on `cacheWrite > max(factor × predictedDelta, floor)`
 *   instead of a write-ratio — small-prefix sessions legitimately have high
 *   increment ratios, that is a normal shape, not a corollary-1 violation.
 * - m1: a dropped pending PRE-BOOKS `predictedDeltaTokens` into the budget, so
 *   the §4.4 ≤0.75×(W+P)×R bound holds on every path.
 * - m2: `lastReconciledEntrySeq` idempotency watermark — one ledger observation
 *   is accounted exactly once no matter how many of message_end/turn_end/agent_end fire.
 * - USD budget gate: `upgradeWriteUsd` accumulates the MARGINAL cost of upgrading
 *   (MARGINAL_WRITE_FRACTION × the ledger's `cost.cacheWrite`), and the breaker
 *   fires when EITHER the token or the USD budget is exhausted — the USD gate is
 *   primary (same 200k tokens spans 3–5× in dollars across models), tokens stay
 *   as the fallback for routes that report no cost split. See plan.md 后续修订.
 * - Prefix-scaled probe floor: the floor of the M2 composite probe clamps to
 *   `0.5 × measured prefix` for small prefixes, so a full-prefix rewrite on a
 *   pathological route trips at P=40k too (the fixed 64k floor could never see
 *   it); large prefixes are clamped back to 64k — byte-identical to before.
 * - ENTRY FEE (field-evidence revision, plan.md §16.3): measured on real routes,
 *   a request carrying `ttl:"1h"` does NOT read a prefix that was cached at 5m —
 *   the first upgrade of a prefix rewrites the WHOLE prefix as 1h (`cacheRead = 0`
 *   or a tiny residue, `cacheWrite1h = cacheWrite ≈ P`), and only the FOLLOWING
 *   1h→1h upgrades bill the increment (§0.4 corollary 1). That one-time cost is
 *   the "entry fee". Consequences baked in here:
 *     (a) the warm probes only judge COVERED (1h→1h) settlements — judging the
 *         transition made `warm-miss` / `warm-write-too-expensive` fire on the
 *         very first upgrade of every session, killing the feature before it
 *         could ever amortize the fee it had just paid;
 *     (b) the fee is accounted against its OWN budget (`feeWriteTokens/Usd`),
 *         so the marginal budget `W` keeps measuring what it was designed for
 *         (steady-state 1h premiums) instead of tripping `write-budget` on the
 *         first transition of any session with P > W;
 *     (c) paying a fee requires a quantified horizon (`fee-horizon-too-short`).
 *   The structural "this route ignores ttl:1h" detector is unchanged: it is the
 *   §4.3 `1h-ineffective` probe, which by construction observes the state AFTER
 *   the fee was paid.
 *
 * Hard rule (same as keepalive-state.ts): no pi imports, no module-level mutable
 * state, no implicit clock reads — `now` is always an input. Value-imports
 * constants from ./keepalive-state.js; keepalive-state.ts only type-imports
 * `AdaptiveSnapshot` back (type-only imports are erased ⇒ no runtime cycle).
 */

import type { Millis } from "../core/types.js";
import {
  ANTHROPIC_MESSAGES_API,
  ASSUMED_TTL_MS,
  PING_DENY_PROVIDERS,
  TTL_SAFETY_MARGIN_MS,
  type InvalidateReason,
  type PayloadShape,
} from "./keepalive-state.js";
import type { LedgerUsage } from "./usage-ledger.js";
import { prefixFromLedger } from "./usage-ledger.js";

// ---------------------------------------------------------------------------
// Constants (plan.md §7.2 — guardrails, deliberately NOT settings).
// ---------------------------------------------------------------------------

/** M2 composite probe: trip when the measured write exceeds factor × predicted delta... */
export const ADAPTIVE_PROBE_WRITE_FACTOR = 3;
/** ...AND this absolute floor (one partially-hit post-compact rewrite can legitimately reach 50k+; the probe catches structural route-level violations, not a single large rewrite). */
export const ADAPTIVE_PROBE_WRITE_FLOOR_TOKENS = 64_000;
/** ...AND the floor is prefix-scaled: for a small prefix P the effective floor drops to
 *  `min(FLOOR_TOKENS, max(FLOOR_MIN_TOKENS, fraction × P))`.
 *
 *  Design intent — tighten ONLY where needed: at P ≥ 128k we have 0.5·P ≥ 64k, so the
 *  clamp folds back to the fixed 64k floor and behaviour is byte-identical to the M2
 *  composite probe (no new false trips on healthy large-prefix routes). At a small
 *  prefix (P = 40k) the floor drops to 20k, which is what lets the probe recognize
 *  "the ENTIRE prefix was rewritten" in one settlement — under the fixed 64k floor
 *  such a route burned the whole budget before anything tripped. */
export const ADAPTIVE_PROBE_WRITE_FLOOR_FRACTION = 0.5;
/** Hard lower bound of the prefix-scaled floor: keeps a tiny prefix (P < 8k) from
 *  scaling the floor into noise where ordinary increments would false-trip. */
export const ADAPTIVE_PROBE_WRITE_FLOOR_MIN_TOKENS = 4_000;
/** plan.md §6.1a: a pending probe whose ledger never arrives is dropped (and pre-booked, m1) after this. */
export const ADAPTIVE_PENDING_TTL_MS: Millis = 120_000;
/** S4 ring buffer size (plan.md §3.2). */
export const ADAPTIVE_GAP_RING_SIZE = 20;
/** §4.3: an upgrade claims 1h of coverage from its decision time. */
export const ADAPTIVE_COVER_MS: Millis = 3_600_000;
/**
 * D3: what counts as "the 1h entry survived" when a long-gap request lands
 * inside the cover window, and as "this settlement was a real increment"
 * when a pending upgrade settles.
 *
 * The anchor is the PREVIOUS settlement's prefix (`state.lastPrefixTokens`),
 * not the current request's own prefix: a request that legitimately appends a
 * huge delta still reads the whole old prefix, so anchoring on the old prefix
 * never punishes a large increment — only a genuine collapse of the read.
 *
 * Why it exists: the probe used to accept `cacheRead > 0`. In the field
 * incident a request that read 11,356 of an expected 252,052 tokens (4.5% —
 * just the cross-session-shared system/tools block) and rewrote 239,709 at the
 * 1h rate was scored as an `indirect1hConfirm`, i.e. as PROOF that 1h worked.
 * Measured healthy long-gap hits in the same session ran 81.5%–91%, so 0.5
 * separates the two populations with a wide margin on both sides.
 */
export const ADAPTIVE_COVER_HIT_FRACTION = 0.5;
/**
 * How long after a demonstrated read a prefix still counts as "warm" (cheap to
 * extend). Same value as before this change — the assumed 5m TTL minus the
 * keepalive safety margin — named here because D1 gave it a second caller.
 */
export const WARM_WINDOW_MS: Millis = ASSUMED_TTL_MS - TTL_SAFETY_MARGIN_MS;

/** `Math.max` over two possibly-undefined timestamps; `undefined` only when both are. */
function maxDefined(a: Millis | undefined, b: Millis | undefined): Millis | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}
/** Fraction of the ledger's 1h-inclusive `cost.cacheWrite` that is the MARGINAL cost of
 *  upgrading a write from 5m to 1h. Derivation (plan.md §0.3/§0.4 pricing): 1h write
 *  bills 2.0× base input, 5m write bills 1.25× ⇒ marginal 0.75×. pi prices a full 1h
 *  write into `cost.cacheWrite` at 2.0×, so marginal = 0.75/2.0 = 0.375 of what the
 *  ledger reports. Applied only when the route reports `cost.cacheWrite` — missing
 *  data is never guessed. */
export const MARGINAL_WRITE_FRACTION = 0.375;
/** Same idea for the ENTRY FEE (the first, uncovered 5m→1h upgrade of a prefix), where the
 *  counterfactual is different: without the upgrade the request would have HIT the 5m entry
 *  (0.1× base for P) and written only the increment; with it, P is rewritten at 2.0× base.
 *  Marginal ≈ (2.0 − 0.1)/2.0 = 0.95 of what the ledger reports as `cost.cacheWrite`.
 *  Using 0.375 here would under-report the fee by ~2.5× and let it hide inside the
 *  marginal budget. */
export const ENTRY_FEE_MARGINAL_WRITE_FRACTION = 0.95;
/** plan.md §18: the 5m TAIL a covered 1h→1h refresh has to rewrite. A `ttl:"1h"` request
 *  resumes from the last 1h write point and cannot read the 5m entries written since, so
 *  that tail — which the same request at 5m would have READ (0.1×) — is rewritten at 2.0×.
 *  Same counterfactual as the entry fee ⇒ same (2.0 − 0.1)/2.0 fraction; only the genuinely
 *  new increment keeps the 0.375 of MARGINAL_WRITE_FRACTION. */
export const TAIL_REWRITE_MARGINAL_WRITE_FRACTION = ENTRY_FEE_MARGINAL_WRITE_FRACTION;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AdaptiveSignalKind = "subagent" | "bash-job" | "ui-gate" | "history-gap";
export type AdaptiveUpgradeClass = "warm" | "cold";

export type AdaptiveDeclineReason =
  | "mode"
  | "not-anthropic"
  | "no-1h-support"
  | "no-cache-control"
  | "already-1h"
  | "breaker"
  | "write-budget"
  /** The entry fee (first, uncovered 1h write of a prefix) has no budget left this session. */
  | "fee-budget"
  /** An uncovered upgrade would pay the entry fee, but nothing quantifies a horizon long enough to amortize it. */
  | "fee-horizon-too-short"
  | "no-signal"
  | "delta-too-large"
  | "refresh-throttled"
  | "cold-signal-too-weak"
  | "cold-budget"
  | "cold-cooldown"
  /** D1: the cold branch's premise ("the prefix is dead anyway") is false — keepalive has proven it alive. */
  | "cold-cache-alive"
  /** F1 (verification-2026-09-25): opening a new 1h prefix would pay an entry fee for gaps the keepalive
   *  pinger already covers more cheaply; only a session that has DEMONSTRATED a gap beyond the ping
   *  horizon earns the fee. */
  | "keepalive-covers"
  /** task #14: compact-hint reports the prefix is about to be discarded by a context switch /
   *  compaction (usage near the earliest active line, or a handoff pending) — a NEW 1h prefix
   *  (entry fee) would be paid for a prefix that is thrown away next. Covered renewals pass. */
  | "switch-imminent";

export type AdaptiveBreakerReason = "warm-write-too-expensive" | "warm-miss" | "write-budget" | "1h-ineffective";

export interface AdaptiveDecision {
  upgrade: boolean;
  class: AdaptiveUpgradeClass | undefined;
  reason: AdaptiveDeclineReason | undefined;
  /** Strong + weak signals present at decision time ([] when a group-A gate fired first). */
  signals: AdaptiveSignalKind[];
  predictedDeltaTokens: number;
  at: Millis;
}

export interface AdaptiveSignals {
  subagentRuns: number;
  /** max(hardDeadlineAt ?? deadlineAt) − now across non-terminal runs; undefined when unknown. */
  maxSubagentHorizonMs: number | undefined;
  backgroundBashJobs: number;
  uiPrompts: number;
  /** Excluded from decisions (plan.md §3.3: type-agnostic, near-always true) — audit/status only. */
  activeTools: number;
}

export interface AdaptiveConfig {
  writeBudgetTokens: number;
  /** USD marginal-write budget per session (primary gate); 0 = USD gate off (tokens only). */
  writeBudgetUsd: number;
  /** Per-session budget for ENTRY FEES (uncovered 5m→1h transitions), measured cacheWrite tokens.
   *  0 = no fee may ever be paid ⇒ no prefix can ever be opened ⇒ the feature is off (rollback switch). */
  feeBudgetTokens: number;
  /** USD counterpart of `feeBudgetTokens` (accrued with ENTRY_FEE_MARGINAL_WRITE_FRACTION); 0 = USD fee gate off. */
  feeBudgetUsd: number;
  maxDeltaTokens: number;
  refreshAfterTokens: number;
  coldUpgrades: number;
  coldCooldownMs: Millis;
  coldMinHorizonMs: Millis;
  historyGapSignal: boolean;
  /** M2 composite probe inputs — filled from the constants above by the service, injectable for tests. */
  probeWriteFactor: number;
  probeWriteFloorTokens: number;
  /** Prefix-scaled floor fraction (see ADAPTIVE_PROBE_WRITE_FLOOR_FRACTION). */
  probeWriteFloorFraction: number;
  /** Prefix-scaled floor hard minimum (see ADAPTIVE_PROBE_WRITE_FLOOR_MIN_TOKENS). */
  probeWriteFloorMinTokens: number;
}

export interface AdaptivePending {
  requestSeq: number;
  /** Snapshot of `entries.length` at decision time; reconcile settles only against a ledger with `entrySeq >= minEntrySeq` (plan.md §6.1a). */
  minEntrySeq: number;
  at: Millis;
  class: AdaptiveUpgradeClass;
  predictedDeltaTokens: number;
  /** Was the prefix already under a settled 1h entry when this upgrade was decided?
   *  false ⇒ this upgrade pays the ENTRY FEE (full-prefix 1h rewrite): it is accounted
   *  against the fee budget and is NOT judged by the warm probes (see the header note). */
  covered1h: boolean;
  /** plan.md §18: `state.tokensSinceLast1hWrite` at decision time — the 5m tail written
   *  since the last 1h write point, invisible to a `ttl:"1h"` request. Used to split the
   *  settlement's USD cost (tail at 0.95, increment at 0.375) and to restore the tail
   *  counter when the upgrade demonstrably did not land (`cacheWrite1h === 0`).
   *  Absent ⇒ 0 (records created before this field existed). */
  tail5mTokens?: number;
}

export interface AdaptiveReconcileRecord {
  at: Millis;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number | undefined;
  costTotalUsd: number | undefined;
  /** `cost.cacheWrite` of the observed entry (the USD gate's raw input); undefined when unreported. */
  cacheWriteUsd: number | undefined;
}

export interface AdaptiveState {
  /** Monotonic counter, bumped per pending record (plan.md §6.1a correlation). */
  requestSeq: number;
  lastRequestStartedAt: Millis | undefined;
  /** Gap between the last two request starts — the §4.3/§5.2 cold-branch input at reconcile time. */
  lastGapMs: number | undefined;
  /** Ring of the last ADAPTIVE_GAP_RING_SIZE inter-request gaps (S4). */
  gaps: readonly number[];
  breaker: { reason: AdaptiveBreakerReason; at: Millis } | undefined;
  /** I-A6: measured cacheWrite total attributed to upgrades (m1: includes pre-booked dropped pendings). */
  upgradeWriteTokens: number;
  /** MARGINAL USD cost attributed to upgrades: MARGINAL_WRITE_FRACTION × the settled
   *  ledger's `cost.cacheWrite`, accumulated only when the route reports it (never guessed). */
  upgradeWriteUsd: number;
  /** Measured cacheWrite of settled ENTRY FEES (uncovered transitions) — kept out of
   *  `upgradeWriteTokens` so the marginal budget is not spent on a one-time capital cost. */
  feeWriteTokens: number;
  /** USD counterpart of `feeWriteTokens` (ENTRY_FEE_MARGINAL_WRITE_FRACTION × `cost.cacheWrite`). */
  feeWriteUsd: number;
  /** Count of settled entry fees (observability; a healthy session pays exactly one). */
  feeUpgrades: number;
  warmUpgrades: number;
  coldUpgradesUsed: number;
  lastColdUpgradeAt: Millis | undefined;
  lastUpgradeAt: Millis | undefined;
  /** Measured 5m-written tokens since the last 1h write point (plan.md §18): exactly the tail
   *  a `ttl:"1h"` request cannot read and must rewrite. Refresh-throttle input and part of a
   *  covered warm upgrade's predicted 1h write. The upgrade's own 1h write is NOT counted. */
  tokensSinceLast1hWrite: number;
  /** True while a strong-signal episode is open (first upgrade of an episode bypasses the refresh throttle). */
  armedEpisode: boolean;
  pending: AdaptivePending | undefined;
  /** m4 (accepted v1 limitation): armed optimistically at decision time, not at ledger confirmation. */
  oneHourCoverUntil: Millis | undefined;
  /** M1: high-water mark (`entries.length − 1`) at the last invalidate; warm requires a strictly newer ledger. */
  lastInvalidateSeq: number;
  /** m2: idempotency watermark — reconcile side effects require `ledger.entrySeq` strictly greater. */
  lastReconciledEntrySeq: number;
  confirmed1hWrites: number;
  unconfirmed1hWrites: number;
  indirect1hConfirms: number;
  ineffective1h: number;
  /** D3 anchor: `cacheRead + cacheWrite` of the previous settled ledger entry (0 before the first). */
  lastPrefixTokens: number;
  /** F2: settlements that revealed prefix drift (a collapsed read on a shrunk prefix, or inside the
   *  warm window) and therefore dropped the 1h cover instead of judging the route. Session telemetry,
   *  restored on /reload. */
  driftCoverClears: number;
  /** R4: `payloadLineageKey` of the most recent request (undefined until a caller supplies one). */
  lastLineageKey: string | undefined;
  /** R4: lineage key of the request that armed the current 1h cover — a request of another lineage
   *  cannot read that entry, so it is neither "covered" nor evidence about the route. */
  coverLineageKey: string | undefined;
  /** R3: `entriesLength` at the latest decision. A ledger entry below it belongs to an EARLIER request,
   *  so the request-level facts (`lastGapMs`, `lastLineageKey`) do not describe it. */
  lastDecisionEntriesLength: number;
  /** R2: longest gap after which a covered request demonstrably READ the 1h entry in this session.
   *  The keepalive pinger only stands down once this covers its whole horizon (evidence, not the
   *  optimistic 1h cover). Session evidence, restored on /reload. */
  max1hSurvivalMs: number;
  /** R9 (review round 2): route (`provider|model` of the settling ledger) the survival evidence was
   *  measured on — 1h lifetime is a property of the upstream route, so evidence never transfers. */
  survivalRouteKey: string | undefined;
  /** R9: route of the most recently settled ledger entry (what the next ping would replay against). */
  lastRouteKey: string | undefined;
  droppedPending: number;
  lastDecision: AdaptiveDecision | undefined;
  lastReconcile: AdaptiveReconcileRecord | undefined;
}

export function createInitialAdaptiveState(): AdaptiveState {
  return {
    requestSeq: 0,
    lastRequestStartedAt: undefined,
    lastGapMs: undefined,
    gaps: [],
    breaker: undefined,
    upgradeWriteTokens: 0,
    upgradeWriteUsd: 0,
    feeWriteTokens: 0,
    feeWriteUsd: 0,
    feeUpgrades: 0,
    warmUpgrades: 0,
    coldUpgradesUsed: 0,
    lastColdUpgradeAt: undefined,
    lastUpgradeAt: undefined,
    tokensSinceLast1hWrite: 0,
    armedEpisode: false,
    pending: undefined,
    oneHourCoverUntil: undefined,
    lastInvalidateSeq: -1,
    lastReconciledEntrySeq: -1,
    confirmed1hWrites: 0,
    unconfirmed1hWrites: 0,
    indirect1hConfirms: 0,
    ineffective1h: 0,
    lastPrefixTokens: 0,
    driftCoverClears: 0,
    lastLineageKey: undefined,
    coverLineageKey: undefined,
    lastDecisionEntriesLength: -1,
    max1hSurvivalMs: 0,
    survivalRouteKey: undefined,
    lastRouteKey: undefined,
    droppedPending: 0,
    lastDecision: undefined,
    lastReconcile: undefined,
  };
}

/** customType of the service's audit entries (the writer side aliases this in ../service/cache-adaptive.ts). */
export const ADAPTIVE_AUDIT_CUSTOM_TYPE = "subagent:cache-adaptive";

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Session-state read-back (field-2026-09-24 §3.1): the write/fee budgets and the
 * breaker are session-permanent by design (G-F §4.2), but the service object is
 * rebuilt on every session_start (`/reload` included), which used to reset them
 * to zero — one reload after an 11-hour breaker re-armed the upgrade path and
 * paid ~$5 of entry fees within two minutes. Rehydrate the SESSION-LEVEL fields
 * from the current branch's own `subagent:cache-adaptive` audit entries:
 * decision entries carry a full `budget` snapshot, reconcile entries carry the
 * post-settlement counters plus `breaker` (its timestamp is the entry's `at`).
 * Entries are applied in branch order, so the LAST one wins.
 *
 * Prefix-bound transients (warm/cold timestamps, `lastPrefixTokens`, the 5m
 * tail counter, the pending probe, the 1h cover, gap ring) are deliberately NOT
 * restored — the prefix may have changed across the reload, so the rebuilt
 * predictor must re-measure it. Starting from `createInitialAdaptiveState()`
 * makes that structural rather than a field-by-field decision.
 *
 * Never throws; corrupt/partial entries fall back field-by-field to the initial
 * value, and a branch with no usable entries yields `undefined` (caller falls
 * back to a fully initial state). `/resume` into another session reads THAT
 * session's entries (correct by construction); `/new` has none.
 */
export function readBackAdaptiveSessionState(branch: readonly unknown[]): AdaptiveState | undefined {
  try {
    let restored: AdaptiveState | undefined;
    for (const raw of branch) {
      const entry = asRecord(raw);
      if (entry?.type !== "custom" || entry.customType !== ADAPTIVE_AUDIT_CUSTOM_TYPE) continue;
      const data = asRecord(entry.data);
      if (data === undefined) continue;
      const base = restored ?? createInitialAdaptiveState();
      if (data.kind === "decision") {
        const budget = asRecord(data.budget);
        if (budget === undefined) continue;
        restored = {
          ...base,
          upgradeWriteTokens: asFiniteNumber(budget.upgradeWriteTokens) ?? base.upgradeWriteTokens,
          upgradeWriteUsd: asFiniteNumber(budget.upgradeWriteUsd) ?? base.upgradeWriteUsd,
          feeWriteTokens: asFiniteNumber(budget.feeWriteTokens) ?? base.feeWriteTokens,
          feeWriteUsd: asFiniteNumber(budget.feeWriteUsd) ?? base.feeWriteUsd,
          coldUpgradesUsed: asFiniteNumber(budget.coldUpgrades) ?? base.coldUpgradesUsed,
        };
      } else if (data.kind === "reconcile") {
        // Reconcile counters are the POST-settlement truth — fresher than the
        // budget snapshot of any earlier decision entry. The breaker is
        // session-permanent: once seen it is kept with its FIRST trip time.
        const reason = typeof data.breaker === "string" && data.breaker.length > 0 ? data.breaker : undefined;
        const at = asFiniteNumber(data.at);
        restored = {
          ...base,
          upgradeWriteTokens: asFiniteNumber(data.upgradeWriteTokens) ?? base.upgradeWriteTokens,
          upgradeWriteUsd: asFiniteNumber(data.upgradeWriteUsd) ?? base.upgradeWriteUsd,
          feeWriteTokens: asFiniteNumber(data.feeWriteTokens) ?? base.feeWriteTokens,
          feeWriteUsd: asFiniteNumber(data.feeWriteUsd) ?? base.feeWriteUsd,
          driftCoverClears: asFiniteNumber(data.driftCoverClears) ?? base.driftCoverClears,
          ...restoredSurvival(base, data),
          breaker:
            base.breaker ??
            (reason !== undefined && at !== undefined
              ? { reason: reason as AdaptiveBreakerReason, at: at as Millis }
              : undefined),
        };
      }
    }
    return restored;
  } catch {
    return undefined;
  }
}

/**
 * R9: survival evidence is restored WITH its route. Same route ⇒ keep the larger
 * value (evidence only grows); a different route ⇒ the newer entry replaces it
 * (evidence never transfers across routes). Entries without a route key (pre-R9)
 * restore nothing — unbound evidence is exactly what R9 forbids.
 */
function restoredSurvival(
  base: AdaptiveState,
  data: Record<string, unknown>,
): Pick<AdaptiveState, "max1hSurvivalMs" | "survivalRouteKey"> {
  const ms = asFiniteNumber(data.max1hSurvivalMs);
  const route =
    typeof data.survivalRouteKey === "string" && data.survivalRouteKey !== "" ? data.survivalRouteKey : undefined;
  if (ms === undefined || ms <= 0 || route === undefined) {
    return { max1hSurvivalMs: base.max1hSurvivalMs, survivalRouteKey: base.survivalRouteKey };
  }
  if (route === base.survivalRouteKey)
    return { max1hSurvivalMs: Math.max(base.max1hSurvivalMs, ms), survivalRouteKey: route };
  return { max1hSurvivalMs: ms, survivalRouteKey: route };
}

/**
 * R9: the upstream route a ledger entry was served by, or `undefined` when the
 * entry does not identify it (no `provider` / no `model`). Review round 3: an
 * unknown route must never compare equal to another unknown route — two
 * providers serving the same model id would otherwise share survival evidence.
 */
export function ledgerRouteKey(ledger: LedgerUsage): string | undefined {
  if (ledger.providerId === undefined || ledger.providerId === "" || ledger.modelId === "") return undefined;
  return `${ledger.providerId}|${ledger.modelId}`;
}

// ---------------------------------------------------------------------------
// decideAdaptiveTtl (plan.md §3.5)
// ---------------------------------------------------------------------------

/**
 * Dual write-budget predicate (G-G / I-A6): the breaker fires when EITHER budget
 * is exhausted. The USD budget is the PRIMARY gate — it measures what we actually
 * try to protect (money), and a fixed token count spans 3–5× in dollars across
 * models. The token budget stays as the fallback for routes that report no cost
 * split; `writeBudgetUsd = 0` turns the USD gate off (tokens only). Note the token
 * side keeps its legacy `>=` semantics, so `writeBudgetTokens = 0` still means
 * "no upgrades at all" (the plan.md §4.4 rollback switch).
 */
function budgetExhausted(state: AdaptiveState, config: AdaptiveConfig): boolean {
  if (state.upgradeWriteTokens >= config.writeBudgetTokens) return true;
  return config.writeBudgetUsd > 0 && state.upgradeWriteUsd >= config.writeBudgetUsd;
}

/**
 * Same dual predicate for the ENTRY FEE budget. Only uncovered (transition)
 * upgrades are gated by it; a steady-state 1h→1h upgrade stays available even
 * after the fee budget is gone — the fee is a capital cost already paid, and
 * refusing the cheap follow-ups would throw away exactly what it bought.
 * `feeBudgetTokens = 0` therefore means "never open a prefix" ⇒ the adaptive
 * upgrade path is off end to end (rollback switch, same spirit as W = 0).
 */
function feeBudgetExhausted(state: AdaptiveState, config: AdaptiveConfig): boolean {
  if (state.feeWriteTokens >= config.feeBudgetTokens) return true;
  return config.feeBudgetUsd > 0 && state.feeWriteUsd >= config.feeBudgetUsd;
}

/**
 * Is the outgoing prefix already backed by a 1h entry this session paid for?
 *
 * Two conjuncts, both load-bearing: the §4.3 cover window must still be open
 * (`invalidateAdaptive` clears it on any prefix drift, so a post-compact prefix
 * correctly counts as uncovered again) AND at least one upgrade must have
 * actually SETTLED with a write (`confirmed + unconfirmed`). The second guard
 * exists because the cover is armed optimistically at decision time (m4): a
 * second request fired before the first settled would otherwise be judged
 * "covered" and handed to the warm probes while it is in fact still a
 * transition. Erring toward "uncovered" only ever costs probe coverage, never
 * money — the budgets bound both paths.
 */
export function isPrefix1hCovered(state: AdaptiveState, now: Millis, lineageKey?: string): boolean {
  return (
    state.oneHourCoverUntil !== undefined &&
    now < state.oneHourCoverUntil &&
    state.confirmed1hWrites + state.unconfirmed1hWrites > 0 &&
    // R4: another lineage cannot read the 1h entry this cover was bought for.
    (lineageKey === undefined || state.coverLineageKey === undefined || lineageKey === state.coverLineageKey)
  );
}

/**
 * F1 (verification-2026-09-25, keepalive side): may the keepalive pinger stand
 * down for the current window because a 1h entry already backs this prefix?
 *
 * R2 (review 2026-09-25): standing down is TERMINAL for the window — once the 5m
 * chain lapses, a later ping would be a write, so keepalive cannot resume. It is
 * therefore only allowed on EVIDENCE that the 1h entry outlives every gap the
 * pinger could have bridged: this session has seen a covered request read the
 * 1h entry after a gap ≥ `horizonMs` (`max1hSurvivalMs`), and the remaining
 * cover spans the horizon. The measured route kept 1h entries alive for ~23 min
 * and lost them past ~27 min — without such proof, pinging is the safe cover.
 *
 * Pings replay the last (5m) request and keep the 5m chain alive; when a
 * settled, CONFIRMED (`cacheWrite1h > 0`) 1h write covers the prefix and the
 * 5m tail written since is small, the request after the gap reads the 1h entry
 * and rewrites only that tail at 5m — every ping in between is paid twice
 * (simulation: adaptive+keepalive cost 32% more than keepalive alone). Stricter
 * than `isPrefix1hCovered` on purpose: no breaker, no unsettled upgrade, at
 * least one split-reported 1h write, tail ≤ `refreshAfterTokens`. If the 1h
 * entry dies early anyway, the next long-gap request trips `1h-ineffective`,
 * this predicate turns false, and pinging resumes — one bounded miss.
 */
export function adaptiveCoversPrefix(
  state: AdaptiveState,
  config: AdaptiveConfig,
  now: Millis,
  horizonMs: Millis,
): boolean {
  return (
    state.breaker === undefined &&
    state.pending === undefined &&
    state.confirmed1hWrites > 0 &&
    isPrefix1hCovered(state, now, state.lastLineageKey) &&
    state.tokensSinceLast1hWrite <= config.refreshAfterTokens &&
    state.max1hSurvivalMs >= horizonMs &&
    // R9: evidence only counts on the route it was measured on.
    state.survivalRouteKey !== undefined &&
    state.survivalRouteKey === state.lastRouteKey &&
    state.oneHourCoverUntil !== undefined &&
    state.oneHourCoverUntil - now >= horizonMs
  );
}

export interface AdaptiveDecideInput {
  now: Millis;
  /** G-A defense: anything but "adaptive" never upgrades. */
  mode: string;
  api: string;
  provider: string;
  /** ctx.model.id — M1 anchor compared against the ledger's `modelId`. */
  modelId: string;
  supportsLongCacheRetention: boolean;
  shape: PayloadShape;
  signals: AdaptiveSignals;
  ledger: LedgerUsage;
  config: AdaptiveConfig;
  state: AdaptiveState;
  /**
   * D1: start time of the most recent PROVEN cache read from the keepalive
   * pinger (`CacheKeepaliveService.provenCacheReadAt()`), or `undefined` when
   * keepalive is off / has never proven a hit / the window was invalidated.
   *
   * The warm window is measured from the later of this and
   * `state.lastRequestStartedAt`: a ping that came back `cache_read > 0,
   * cache_creation === 0` is strictly better evidence that the prefix is live
   * than "a real request went out", which is only an assumption.
   */
  lastProvenCacheReadAt: Millis | undefined;
  /**
   * F1 (verification-2026-09-25): the longest gap the keepalive pinger can bridge
   * for this session (`maxPings × interval + TTL`), or `undefined` when keepalive
   * is off / session-disabled / unable to ping this route. While defined, opening
   * a NEW 1h prefix (entry fee, warm-uncovered or cold) is refused with
   * `keepalive-covers` unless the gap ring already holds a gap longer than it —
   * pings are the cheaper cover for anything shorter. Absent ⇒ pre-fix behaviour.
   */
  keepaliveHorizonMs?: number | undefined;
  /**
   * task #14: compact-hint's `switchImminent` (stack.ts passes the compact-hint state flag).
   * `true` ⇒ an upgrade that would open a NEW 1h prefix (entry fee) is refused with
   * `switch-imminent`; a covered renewal is unaffected. Absent / `false` ⇒ unchanged.
   */
  switchImminent?: boolean | undefined;
  /** R4: `payloadLineageKey` of the outgoing payload. Absent ⇒ lineage is not checked (pre-fix behaviour). */
  lineageKey?: string | undefined;
}

export function decideAdaptiveTtl(input: AdaptiveDecideInput): AdaptiveDecision {
  const {
    now,
    mode,
    api,
    provider,
    modelId,
    supportsLongCacheRetention,
    shape,
    signals,
    ledger,
    config,
    state,
    lastProvenCacheReadAt,
    keepaliveHorizonMs,
    switchImminent,
    lineageKey,
  } = input;
  const no = (reason: AdaptiveDeclineReason, signalsSeen: AdaptiveSignalKind[] = []): AdaptiveDecision => ({
    upgrade: false,
    class: undefined,
    reason,
    signals: signalsSeen,
    predictedDeltaTokens: 0,
    at: now,
  });

  // ── Group A: capability gates (signal-independent) ──────────────────────
  if (mode !== "adaptive") return no("mode"); // G-A
  if (api !== ANTHROPIC_MESSAGES_API) return no("not-anthropic"); // G-B
  if (PING_DENY_PROVIDERS.has(provider)) return no("not-anthropic"); // G-B′ (copilot bills per request)
  if (!supportsLongCacheRetention) return no("no-1h-support"); // G-C / I-A4
  if (shape.ephemeralBreakpoints === 0) return no("no-cache-control"); // G-D
  if (shape.ttl1h) return no("already-1h"); // G-E (pi already wrote 1h)
  if (state.breaker !== undefined) return no("breaker"); // G-F (§4.2, session-permanent)
  if (budgetExhausted(state, config)) return no("write-budget"); // G-G / I-A6 (USD primary, tokens fallback)
  // G-H (entry fee): an upgrade whose prefix is not already 1h-backed rewrites the
  // whole prefix on real routes. Refuse a NEW fee once its budget is gone; the
  // steady-state path below stays open.
  const covered1h = isPrefix1hCovered(state, now, lineageKey);
  if (!covered1h && feeBudgetExhausted(state, config)) return no("fee-budget");
  // task #14: never pay a NEW entry fee (whole-prefix 1h rewrite) for a prefix the next
  // context switch discards. A covered renewal stays open: it rewrites only the tail at
  // +0.75x, and refusing it would strand the prefix — F1 has keepalive stand down while
  // the 1h cover holds, so nothing would protect it once that cover lapses. Residual: a
  // covered request whose OWN payload drifted still settles as a full rewrite (D4
  // `readCollapsed`); that is only knowable after settlement, and F2 clears the cover as
  // soon as a drifted settlement is seen, so the next imminent request is gated here.
  if (!covered1h && switchImminent === true) return no("switch-imminent");

  // ── Group B: horizon signals ────────────────────────────────────────────
  const strong: AdaptiveSignalKind[] = [];
  if (signals.subagentRuns > 0) strong.push("subagent");
  if (signals.backgroundBashJobs > 0) strong.push("bash-job");
  if (signals.uiPrompts > 0) strong.push("ui-gate");
  const weak: AdaptiveSignalKind[] =
    config.historyGapSignal && state.gaps.some((gap) => gap > ASSUMED_TTL_MS) ? ["history-gap"] : [];
  const seen: AdaptiveSignalKind[] = [...strong, ...weak];
  if (strong.length === 0 && weak.length === 0) return no("no-signal");

  // ── Group C: warm/cold split (M1: the ledger must be FRESH to count as warm) ──
  const ledgerFresh =
    ledger.source === "usage" &&
    ledger.entrySeq > state.lastInvalidateSeq &&
    ledger.modelId !== "" &&
    ledger.modelId === modelId;
  // D1: the warm window runs from the last DEMONSTRATED read, which a keepalive
  // proven-hit establishes just as well as (better than) a real request.
  const lastReadAt = maxDefined(state.lastRequestStartedAt, lastProvenCacheReadAt);
  const cacheProvenAlive =
    lastProvenCacheReadAt !== undefined && now - lastProvenCacheReadAt < ASSUMED_TTL_MS - TTL_SAFETY_MARGIN_MS;
  const warm = ledgerFresh && ledger.cacheRead > 0 && lastReadAt !== undefined && now - lastReadAt < WARM_WINDOW_MS;

  // Quantified horizon (shared): a bash job or a human gate that outlived a cold
  // window is long by construction; a subagent must show enough remaining budget.
  const horizonOk =
    signals.backgroundBashJobs > 0 ||
    signals.uiPrompts > 0 ||
    (signals.subagentRuns > 0 &&
      (signals.maxSubagentHorizonMs === undefined || signals.maxSubagentHorizonMs >= config.coldMinHorizonMs));
  // F1: keepalive can bridge every gap this session has shown so far ⇒ a new
  // 1h prefix would only duplicate what the pings already buy.
  const keepaliveCovers = keepaliveHorizonMs !== undefined && !state.gaps.some((gap) => gap > keepaliveHorizonMs);

  if (warm) {
    // Warm: marginal cost 0.75 × Δ (baseline: same request unrewritten). Wide
    // signals (strong or weak), but Δ and refresh rate are controlled.
    //
    // plan.md §18: on a COVERED prefix the 1h write is not just Δ — a `ttl:"1h"`
    // request resumes from the last 1h write point and cannot read the 5m tail
    // written since, so it rewrites `tail + Δ`. Field data (session 01a0cf02):
    // pred Δ=1,829 with a 15,532 tail settled at 17,094. Gate and predict on the
    // real quantity. (Uncovered: the whole prefix is rewritten — that is the entry
    // fee, gated by its own budget/horizon below; Δ stays the delta gate there.)
    const tail5m = covered1h ? state.tokensSinceLast1hWrite : 0;
    const predicted1hWrite = tail5m + ledger.cacheWrite;
    if (predicted1hWrite > config.maxDeltaTokens) return no("delta-too-large", seen);
    // ...unless this warm request is also the prefix's FIRST 1h write, in which
    // case it is economically a cold upgrade (full-prefix rewrite) and has to
    // earn the fee with a quantified LIVE horizon. F3 (verification-2026-09-25):
    // S4 alone used to qualify too, and paid a $2.06 fee on a 101 s-gap request
    // that no long gap ever followed (session 01a0d24f); 5 of 9 field fees never
    // amortized. S4 keeps its role for refreshing an already-covered prefix.
    if (!covered1h && !horizonOk) return no("fee-horizon-too-short", seen);
    if (!covered1h && keepaliveCovers) return no("keepalive-covers", seen);
    const episodeJustArmed = strong.length > 0 && !state.armedEpisode; // signal just opened: always upgrade
    // The throttle only guards REPEAT purchases after an upgrade; before the
    // session's first upgrade there is nothing to refresh (otherwise a
    // weak-signal-only session could never open — plan.md §3.6 #9).
    if (
      state.lastUpgradeAt !== undefined &&
      !episodeJustArmed &&
      state.tokensSinceLast1hWrite < config.refreshAfterTokens
    ) {
      return no("refresh-throttled", seen);
    }
    return {
      upgrade: true,
      class: "warm",
      reason: undefined,
      signals: seen,
      predictedDeltaTokens: predicted1hWrite,
      at: now,
    };
  }

  // Cold (incl. M1 stale ledger): marginal 0.75 × P. Strong signals only, plus
  // a quantified horizon, a per-session cap and a cooldown.
  //
  // D1 hard gate (field incident): the cold branch prices a full-prefix 1h
  // rewrite as cheap because it assumes the prefix is already dead. When the
  // keepalive pinger has PROVEN it alive within the TTL window that premise is
  // simply false, and upgrading destroys a live cache: a `ttl:"1h"` request
  // resumes from the last 1h-written prefix point and cannot read the 5m
  // entries the pings refreshed, so the "free" rewrite is a full-price one.
  // Reached only when `warm` was false for another reason (stale ledger,
  // `cacheRead === 0`); the warm test above already absorbs the common case.
  if (cacheProvenAlive) return no("cold-cache-alive", seen);
  if (strong.length === 0) return no("cold-signal-too-weak", seen);
  if (!horizonOk) return no("cold-signal-too-weak", seen);
  if (!covered1h && keepaliveCovers) return no("keepalive-covers", seen);
  if (state.coldUpgradesUsed >= config.coldUpgrades) return no("cold-budget", seen);
  if (state.lastColdUpgradeAt !== undefined && now - state.lastColdUpgradeAt < config.coldCooldownMs)
    return no("cold-cooldown", seen);
  return {
    upgrade: true,
    class: "cold",
    reason: undefined,
    signals: strong,
    predictedDeltaTokens: ledger.source === "usage" ? ledger.cacheRead + ledger.cacheWrite : 0,
    at: now,
  };
}

// ---------------------------------------------------------------------------
// Reducers (same immutability contract as keepalive-state.ts: return the same
// reference when nothing applies, a fresh object otherwise).
// ---------------------------------------------------------------------------

export interface NoteDecisionInput {
  now: Millis;
  /** Gap since the previous request start (undefined on the first request). */
  gapMs: number | undefined;
  /** `entries.length` at decision time — the pending record's `minEntrySeq` anchor. */
  entriesLength: number;
  /** Strong signals present at decision time (drives `armedEpisode`). */
  strongSignals: number;
  /** R4: lineage key of this request's payload (same value handed to `decideAdaptiveTtl`). */
  lineageKey?: string | undefined;
}

/** Called for every adaptive-mode request, upgrade or not: gap ring, warm-window clock, episode latch, pending probe record. */
export function noteDecision(
  state: AdaptiveState,
  decision: AdaptiveDecision,
  input: NoteDecisionInput,
): AdaptiveState {
  const gaps = input.gapMs === undefined ? state.gaps : [...state.gaps, input.gapMs].slice(-ADAPTIVE_GAP_RING_SIZE);
  let next: AdaptiveState = {
    ...state,
    gaps,
    lastGapMs: input.gapMs,
    lastRequestStartedAt: input.now,
    lastDecision: decision,
    lastDecisionEntriesLength: input.entriesLength,
    ...(input.lineageKey !== undefined ? { lastLineageKey: input.lineageKey } : {}),
  };
  if (input.strongSignals > 0 && !next.armedEpisode) next = { ...next, armedEpisode: true };
  if (!decision.upgrade || decision.class === undefined) return next;
  const requestSeq = next.requestSeq + 1;
  return {
    ...next,
    requestSeq,
    pending: {
      requestSeq,
      minEntrySeq: input.entriesLength,
      at: input.now,
      class: decision.class,
      predictedDeltaTokens: decision.predictedDeltaTokens,
      // Read from `state` (pre-arm) on purpose: the cover armed just below
      // belongs to THIS upgrade and must not make it look like its own successor.
      covered1h: isPrefix1hCovered(state, input.now, input.lineageKey),
      tail5mTokens: state.tokensSinceLast1hWrite,
    },
    oneHourCoverUntil: input.now + ADAPTIVE_COVER_MS,
    coverLineageKey: input.lineageKey,
    lastUpgradeAt: input.now,
    tokensSinceLast1hWrite: 0,
    warmUpgrades: next.warmUpgrades + (decision.class === "warm" ? 1 : 0),
    coldUpgradesUsed: next.coldUpgradesUsed + (decision.class === "cold" ? 1 : 0),
    lastColdUpgradeAt: decision.class === "cold" ? input.now : next.lastColdUpgradeAt,
  };
}

function tripBreaker(state: AdaptiveState, reason: AdaptiveBreakerReason, at: Millis): AdaptiveState {
  return state.breaker !== undefined ? state : { ...state, breaker: { reason, at } };
}

/**
 * F4 (verification-2026-09-25): marginal fraction of `cost.cacheWrite` for an
 * ENTRY-FEE settlement. A WARM transition's counterfactual is "the 5m request
 * would have hit" ⇒ (2.0 − 0.1)/2.0 = 0.95. A COLD upgrade was decided precisely
 * because the prefix is presumed dead (session start, stale ledger, >TTL gap),
 * so the 5m counterfactual rewrites it too ⇒ only the 5m→1h premium is marginal,
 * 0.375. Booking cold at 0.95 over-reported by ~2.5× (simulation: $1.87 booked
 * vs $1.35 true) and exhausted the fee budget early.
 */
function entryFeeFraction(pending: AdaptivePending): number {
  return pending.class === "cold" ? MARGINAL_WRITE_FRACTION : ENTRY_FEE_MARGINAL_WRITE_FRACTION;
}

/**
 * plan.md §18: marginal fraction of `cost.cacheWrite` for a COVERED 1h→1h
 * settlement. The part of the write that re-covers the 5m tail (which the same
 * request at 5m would have read at 0.1×) costs TAIL_REWRITE_MARGINAL_WRITE_FRACTION;
 * only the genuinely new increment costs MARGINAL_WRITE_FRACTION. The tail share is
 * capped at the measured write (a partially-landed refresh cannot rewrite more tail
 * than it wrote at all).
 */
function coveredMarginalFraction(cacheWrite: number, tail5mTokens: number): number {
  if (cacheWrite <= 0) return MARGINAL_WRITE_FRACTION;
  const tailPart = Math.min(Math.max(0, tail5mTokens), cacheWrite);
  return (
    (TAIL_REWRITE_MARGINAL_WRITE_FRACTION * tailPart + MARGINAL_WRITE_FRACTION * (cacheWrite - tailPart)) / cacheWrite
  );
}

/**
 * Effective floor of the M2 composite probe, scaled by the prefix measured AT
 * SETTLEMENT TIME: `min(FLOOR_TOKENS, max(FLOOR_MIN_TOKENS, fraction × P))` with
 * `P = cacheRead + cacheWrite` (`prefixFromLedger`). The clamp keeps large
 * prefixes (P ≥ 128k ⇒ 0.5P ≥ 64k) on the fixed 64k floor — byte-identical to
 * the pre-revision probe — while letting small prefixes (P = 40k ⇒ 20k) still
 * recognize "the whole prefix was rewritten" in one settlement. The 4k hard
 * minimum keeps tiny prefixes from scaling the floor into ordinary-increment
 * noise. See ADAPTIVE_PROBE_WRITE_FLOOR_FRACTION for the design intent.
 */
function probeWriteFloorTokens(ledger: LedgerUsage, config: AdaptiveConfig): number {
  const prefix = prefixFromLedger(ledger).tokens;
  return Math.min(
    config.probeWriteFloorTokens,
    Math.max(config.probeWriteFloorMinTokens, config.probeWriteFloorFraction * prefix),
  );
}

/**
 * plan.md §4.2/§4.3/§5.2: account one observed ledger entry. Idempotent (m2):
 * a ledger at or below `lastReconciledEntrySeq` is a duplicate observation
 * (message_end + turn_end + agent_end all fire for one turn) and is ignored.
 * A pending probe is settled only against a ledger at or beyond its
 * `minEntrySeq` snapshot (§6.1a); one that outlives ADAPTIVE_PENDING_TTL_MS is
 * dropped and pre-booked (m1) so the §4.4 bound covers the dropped path too.
 */
export function onLedgerObserved(
  state: AdaptiveState,
  ledger: LedgerUsage,
  now: Millis,
  config: AdaptiveConfig,
): AdaptiveState {
  let next = state;

  // m1: pending TTL drop — path-independent of ledger freshness (the ledger
  // not arriving is exactly the case this covers).
  const expired = next.pending;
  if (expired !== undefined && now - expired.at > ADAPTIVE_PENDING_TTL_MS) {
    next = {
      ...next,
      pending: undefined,
      droppedPending: next.droppedPending + 1,
      // Pre-book into the same budget the settlement would have used.
      ...(expired.covered1h
        ? { upgradeWriteTokens: next.upgradeWriteTokens + expired.predictedDeltaTokens }
        : { feeWriteTokens: next.feeWriteTokens + expired.predictedDeltaTokens }),
    };
    // No USD accrual here: a dropped pending has no ledger, and cost is never guessed.
    if (budgetExhausted(next, config)) next = tripBreaker(next, "write-budget", now);
  }

  // m2 watermark: every ledger-driven side effect below requires a strictly newer entry.
  if (ledger.source !== "usage" || ledger.entrySeq <= next.lastReconciledEntrySeq) return next;

  // D3/D4 anchor: the prefix as of the PREVIOUS settlement, captured before it
  // is overwritten below. `0` (nothing observed yet) disables both judgements
  // that depend on it — they fall back to the pre-fix `cacheRead > 0` test.
  const prevPrefixTokens = next.lastPrefixTokens;
  const readCollapsed = prevPrefixTokens > 0 && ledger.cacheRead < ADAPTIVE_COVER_HIT_FRACTION * prevPrefixTokens;
  // F2 (verification-2026-09-25): prefix drift the invalidate events never saw.
  // Two field shapes, both on sessions with alternating prompt lineages:
  //   - the prefix SHRANK (01a0d2f9 10:49: 83,691 < 87,393 — a wake-turn lineage
  //     that shared only 9,149 tokens; the 1h entry was read intact 23 min later);
  //   - a whole-prefix miss INSIDE the warm window, with no gap to blame
  //     (01a0d2e4 10:48:34: 56 s gap, read 11,846 / write 207,109).
  // Either way the 1h cover no longer maps onto the prefix being sent, so the
  // cover is dropped and the route is NOT judged on this observation. An upgrade
  // settling here is exempt: its own collapse is the entry-fee shape (D4) and it
  // just wrote a fresh 1h entry for the new prefix.
  //
  // Review revisions: R3 — only a ledger entry of the LATEST decision's request is
  // described by `lastGapMs` / `lastLineageKey`; an older one is accounted but not
  // judged. R4 — when the lineage keys say this request is of ANOTHER lineage than
  // the cover, the miss is explained (it could never read that entry): no verdict,
  // and the cover is kept for its own lineage, which may well come back. A shrunk
  // prefix alone is not drift either (history can legitimately get shorter while
  // still reading the cached prefix); it has to come with a collapsed read.
  const settlesPending = next.pending !== undefined && ledger.entrySeq >= next.pending.minEntrySeq;
  const describesLatest = ledger.entrySeq >= next.lastDecisionEntriesLength;
  const otherLineage =
    next.coverLineageKey !== undefined &&
    next.lastLineageKey !== undefined &&
    next.lastLineageKey !== next.coverLineageKey;
  const prefixShrunk = prevPrefixTokens > 0 && ledger.cacheRead + ledger.cacheWrite < prevPrefixTokens;
  const insideWarmWindow = next.lastGapMs === undefined || next.lastGapMs <= ASSUMED_TTL_MS;
  const drift =
    !settlesPending && describesLatest && !otherLineage && readCollapsed && (prefixShrunk || insideWarmWindow);

  next = {
    ...next,
    lastReconciledEntrySeq: ledger.entrySeq,
    lastRouteKey: ledgerRouteKey(ledger),
    tokensSinceLast1hWrite: next.tokensSinceLast1hWrite + ledger.cacheWrite,
    lastPrefixTokens: ledger.cacheRead + ledger.cacheWrite,
    lastReconcile: {
      at: now,
      cacheRead: ledger.cacheRead,
      cacheWrite: ledger.cacheWrite,
      cacheWrite1h: ledger.cacheWrite1h,
      costTotalUsd: ledger.costTotalUsd,
      cacheWriteUsd: ledger.cacheWriteUsd,
    },
  };
  if (drift && next.oneHourCoverUntil !== undefined) {
    next = { ...next, oneHourCoverUntil: undefined, driftCoverClears: next.driftCoverClears + 1 };
  }

  const pending = next.pending;
  if (pending !== undefined && ledger.entrySeq >= pending.minEntrySeq) {
    const confirmed = ledger.cacheWrite1h !== undefined && ledger.cacheWrite1h > 0;
    // D4: `pending.covered1h` is a CLAIM made at decision time from the cover
    // window; the ledger is the fact. When the read collapsed, this settlement
    // rewrote the whole prefix no matter what the cover said — that is an entry
    // fee (one-time capital cost), not a marginal 1h→1h increment, and booking
    // it as marginal both misprices it and can blow the marginal budget in a
    // single request (observed: 239,709 tok / $1.36 in one settlement).
    const paysEntryFee = !pending.covered1h || readCollapsed;
    // §18 tail bookkeeping: a landed 1h write moves the 1h write point to the end
    // of this prefix, so the invisible tail is whatever this request itself wrote
    // at 5m (normally 0). An explicit `cacheWrite1h === 0` means the upgrade did
    // not land (the request went out as 5m) ⇒ the pre-decision tail was never
    // absorbed and is restored. Unreported split ⇒ assume it landed (as before).
    const tailAfter =
      ledger.cacheWrite1h === undefined
        ? 0
        : ledger.cacheWrite1h > 0
          ? Math.max(0, ledger.cacheWrite - ledger.cacheWrite1h)
          : (pending.tail5mTokens ?? 0) + next.tokensSinceLast1hWrite;
    next = {
      ...next,
      pending: undefined,
      tokensSinceLast1hWrite: tailAfter,
      confirmed1hWrites: next.confirmed1hWrites + (confirmed ? 1 : 0),
      unconfirmed1hWrites: next.unconfirmed1hWrites + (!confirmed && ledger.cacheWrite > 0 ? 1 : 0),
      // Two budgets, one settlement: the ENTRY FEE (uncovered transition) is a
      // one-time capital cost with its own cap and its own USD fraction; only a
      // covered 1h→1h upgrade spends the marginal budget the §4.4 bound is about.
      // Missing cost data (`cacheWriteUsd === undefined`) accrues nothing on either
      // side — the token budgets still bound the session (never guess a cost).
      ...(!paysEntryFee
        ? {
            upgradeWriteTokens: next.upgradeWriteTokens + ledger.cacheWrite,
            upgradeWriteUsd:
              next.upgradeWriteUsd +
              (ledger.cacheWriteUsd === undefined
                ? 0
                : coveredMarginalFraction(ledger.cacheWrite, pending.tail5mTokens ?? 0) * ledger.cacheWriteUsd),
          }
        : {
            feeUpgrades: next.feeUpgrades + 1,
            feeWriteTokens: next.feeWriteTokens + ledger.cacheWrite,
            feeWriteUsd:
              next.feeWriteUsd +
              (ledger.cacheWriteUsd === undefined ? 0 : entryFeeFraction(pending) * ledger.cacheWriteUsd),
          }),
    };
    // The warm probes test §0.4 corollary 1 — "a warm 1h upgrade bills only the
    // increment" — which is a claim about 1h→1h. On a transition the full-prefix
    // rewrite IS the expected shape (field evidence, plan.md §16.3), so judging it
    // here produced a guaranteed false trip on the first upgrade of every session.
    // F5: the same holds for a covered upgrade whose read COLLAPSED — D4 above has
    // already booked it as an entry fee (the prefix drifted under the cover), so
    // judging it as a 1h→1h increment contradicted our own bookkeeping (field:
    // 01a0d188 04:04:55 was booked as a fee AND tripped warm-write-too-expensive).
    if (pending.class === "warm" && pending.covered1h && !readCollapsed) {
      if (ledger.cacheRead === 0) {
        // Covered by a settled 1h entry, still a total miss: the prefix drifted
        // under us (or the cover is a lie) ⇒ the warm judgement is unreliable here.
        next = tripBreaker(next, "warm-miss", now);
      } else if (
        ledger.cacheWrite >
        Math.max(config.probeWriteFactor * pending.predictedDeltaTokens, probeWriteFloorTokens(ledger, config))
      ) {
        // M2 composite probe with a prefix-scaled floor: the "warm" upgrade
        // rewrote far more than the predicted increment — corollary 1 (plan.md
        // §0.4) does not hold here.
        next = tripBreaker(next, "warm-write-too-expensive", now);
      }
    }
  }

  // §4.3/§5.2: a cold request inside the 1h cover window proves (hit) or
  // disproves (miss ⇒ trip) that the upstream honored ttl:"1h".
  if (
    describesLatest &&
    !otherLineage &&
    !drift &&
    next.oneHourCoverUntil !== undefined &&
    now < next.oneHourCoverUntil &&
    next.lastGapMs !== undefined &&
    next.lastGapMs > ASSUMED_TTL_MS
  ) {
    // D3: `cacheRead > 0` was far too weak a success criterion — a request that
    // read only the tiny cross-session-shared system/tools block (4.5% of the
    // expected prefix) and rewrote everything else at the 1h rate was scored as
    // an indirect CONFIRMATION that 1h works. Judge against the previously
    // measured prefix instead; see ADAPTIVE_COVER_HIT_FRACTION.
    const hit = prevPrefixTokens > 0 ? !readCollapsed : ledger.cacheRead > 0;
    if (hit) {
      const route = ledgerRouteKey(ledger);
      next = {
        ...next,
        indirect1hConfirms: next.indirect1hConfirms + 1,
        // R9: evidence from another route is discarded, never merged; evidence on an
        // UNKNOWN route is not evidence at all (it could stand keepalive down anywhere).
        ...(route === undefined
          ? { max1hSurvivalMs: 0, survivalRouteKey: undefined }
          : {
              max1hSurvivalMs:
                next.survivalRouteKey === route ? Math.max(next.max1hSurvivalMs, next.lastGapMs) : next.lastGapMs,
              survivalRouteKey: route,
            }),
      };
    } else {
      next = { ...next, ineffective1h: next.ineffective1h + 1 };
      next = tripBreaker(next, "1h-ineffective", now);
    }
  }

  if (budgetExhausted(next, config)) next = tripBreaker(next, "write-budget", now);
  return next;
}

/**
 * Prefix-drift invalidation (compact / model switch / tree nav / ...). Records
 * the M1 high-water mark so a pre-drift ledger can never be judged warm again;
 * clears the pending probe (pre-booked per m1) and the 1h cover (the 1h entry
 * no longer corresponds to the current prefix). Budget and breaker survive.
 */
export function invalidateAdaptive(
  state: AdaptiveState,
  _reason: InvalidateReason,
  entriesLength: number,
): AdaptiveState {
  let next: AdaptiveState = {
    ...state,
    lastInvalidateSeq: Math.max(state.lastInvalidateSeq, entriesLength - 1),
    oneHourCoverUntil: undefined,
  };
  const pending = next.pending;
  if (pending !== undefined) {
    next = {
      ...next,
      pending: undefined,
      droppedPending: next.droppedPending + 1,
      ...(pending.covered1h
        ? { upgradeWriteTokens: next.upgradeWriteTokens + pending.predictedDeltaTokens }
        : { feeWriteTokens: next.feeWriteTokens + pending.predictedDeltaTokens }),
    };
  }
  return next;
}

/** `agent_settled`: close the strong-signal episode (self-heals leaked start/end pairs; service clears its own counters). */
export function endArmedEpisode(state: AdaptiveState): AdaptiveState {
  return state.armedEpisode ? { ...state, armedEpisode: false } : state;
}

// ---------------------------------------------------------------------------
// Snapshot (plan.md §8.1 — structured first, strings second; consumed by
// keepalive-state.ts's status builders via a type-only import back-reference).
// ---------------------------------------------------------------------------

export interface AdaptiveSnapshot {
  lastDecision: AdaptiveDecision | undefined;
  coverRemainingMs: number | undefined;
  upgradeWriteTokens: number;
  writeBudgetTokens: number;
  budgetFraction: number;
  /** USD-gate counterparts: marginal USD accrued vs the USD budget (primary gate). */
  upgradeWriteUsd: number;
  writeBudgetUsd: number;
  /** `upgradeWriteUsd / writeBudgetUsd`; 0 while the USD gate is off (`writeBudgetUsd = 0`). */
  usdFraction: number;
  /** ENTRY FEE accounting (uncovered 5m→1h transitions) — separate from the marginal budget. */
  feeUpgrades: number;
  feeWriteTokens: number;
  feeBudgetTokens: number;
  feeWriteUsd: number;
  feeBudgetUsd: number;
  /** True when no NEW prefix can be opened this session (steady-state upgrades are unaffected). */
  feeBudgetExhausted: boolean;
  warmUpgrades: number;
  coldUpgradesUsed: number;
  coldUpgradeCap: number;
  coldCooldownRemainingMs: number | undefined;
  longGapCount: number;
  confirmed1hWrites: number;
  unconfirmed1hWrites: number;
  indirect1hConfirms: number;
  ineffective1h: number;
  /** F2: 1h covers dropped because a settlement revealed prefix drift. */
  driftCoverClears: number;
  /** R2: longest demonstrated 1h survival (gap before a covered hit) this session. */
  max1hSurvivalMs: number;
  droppedPending: number;
  breaker: { reason: AdaptiveBreakerReason; at: Millis } | undefined;
  lastReconcile: AdaptiveReconcileRecord | undefined;
}

export function buildAdaptiveSnapshot(state: AdaptiveState, config: AdaptiveConfig, now: Millis): AdaptiveSnapshot {
  return {
    lastDecision: state.lastDecision,
    coverRemainingMs:
      state.oneHourCoverUntil !== undefined && state.oneHourCoverUntil > now
        ? state.oneHourCoverUntil - now
        : undefined,
    upgradeWriteTokens: state.upgradeWriteTokens,
    writeBudgetTokens: config.writeBudgetTokens,
    budgetFraction: config.writeBudgetTokens > 0 ? state.upgradeWriteTokens / config.writeBudgetTokens : 1,
    upgradeWriteUsd: state.upgradeWriteUsd,
    writeBudgetUsd: config.writeBudgetUsd,
    usdFraction: config.writeBudgetUsd > 0 ? state.upgradeWriteUsd / config.writeBudgetUsd : 0,
    feeUpgrades: state.feeUpgrades,
    feeWriteTokens: state.feeWriteTokens,
    feeBudgetTokens: config.feeBudgetTokens,
    feeWriteUsd: state.feeWriteUsd,
    feeBudgetUsd: config.feeBudgetUsd,
    feeBudgetExhausted: feeBudgetExhausted(state, config),
    warmUpgrades: state.warmUpgrades,
    coldUpgradesUsed: state.coldUpgradesUsed,
    coldUpgradeCap: config.coldUpgrades,
    coldCooldownRemainingMs:
      state.lastColdUpgradeAt !== undefined
        ? Math.max(0, state.lastColdUpgradeAt + config.coldCooldownMs - now)
        : undefined,
    longGapCount: state.gaps.filter((gap) => gap > ASSUMED_TTL_MS).length,
    confirmed1hWrites: state.confirmed1hWrites,
    unconfirmed1hWrites: state.unconfirmed1hWrites,
    indirect1hConfirms: state.indirect1hConfirms,
    ineffective1h: state.ineffective1h,
    driftCoverClears: state.driftCoverClears,
    max1hSurvivalMs: state.max1hSurvivalMs,
    droppedPending: state.droppedPending,
    breaker: state.breaker,
    lastReconcile: state.lastReconcile,
  };
}
