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
  | "cold-cooldown";

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
  /** Measured tokens written since the last 1h upgrade (refresh throttle input). */
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
    droppedPending: 0,
    lastDecision: undefined,
    lastReconcile: undefined,
  };
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
export function isPrefix1hCovered(state: AdaptiveState, now: Millis): boolean {
  return (
    state.oneHourCoverUntil !== undefined &&
    now < state.oneHourCoverUntil &&
    state.confirmed1hWrites + state.unconfirmed1hWrites > 0
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
}

export function decideAdaptiveTtl(input: AdaptiveDecideInput): AdaptiveDecision {
  const { now, mode, api, provider, modelId, supportsLongCacheRetention, shape, signals, ledger, config, state } =
    input;
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
  const covered1h = isPrefix1hCovered(state, now);
  if (!covered1h && feeBudgetExhausted(state, config)) return no("fee-budget");

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
  const warm =
    ledgerFresh &&
    ledger.cacheRead > 0 &&
    state.lastRequestStartedAt !== undefined &&
    now - state.lastRequestStartedAt < ASSUMED_TTL_MS - TTL_SAFETY_MARGIN_MS;

  // Quantified horizon (shared): a bash job or a human gate that outlived a cold
  // window is long by construction; a subagent must show enough remaining budget.
  const horizonOk =
    signals.backgroundBashJobs > 0 ||
    signals.uiPrompts > 0 ||
    (signals.subagentRuns > 0 &&
      (signals.maxSubagentHorizonMs === undefined || signals.maxSubagentHorizonMs >= config.coldMinHorizonMs));

  if (warm) {
    // Warm: marginal cost 0.75 × Δ (baseline: same request unrewritten). Wide
    // signals (strong or weak), but Δ and refresh rate are controlled.
    if (ledger.cacheWrite > config.maxDeltaTokens) return no("delta-too-large", seen);
    // ...unless this warm request is also the prefix's FIRST 1h write, in which
    // case it is economically a cold upgrade (full-prefix rewrite) and has to
    // earn the fee: either a quantified live horizon, or S4's demonstrated
    // long-gap habit — which is itself the payback condition.
    if (!covered1h && !horizonOk && weak.length === 0) return no("fee-horizon-too-short", seen);
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
      predictedDeltaTokens: ledger.cacheWrite,
      at: now,
    };
  }

  // Cold (incl. M1 stale ledger): marginal 0.75 × P. Strong signals only, plus
  // a quantified horizon, a per-session cap and a cooldown.
  if (strong.length === 0) return no("cold-signal-too-weak", seen);
  if (!horizonOk) return no("cold-signal-too-weak", seen);
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
      covered1h: isPrefix1hCovered(state, input.now),
    },
    oneHourCoverUntil: input.now + ADAPTIVE_COVER_MS,
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

  next = {
    ...next,
    lastReconciledEntrySeq: ledger.entrySeq,
    tokensSinceLast1hWrite: next.tokensSinceLast1hWrite + ledger.cacheWrite,
    lastReconcile: {
      at: now,
      cacheRead: ledger.cacheRead,
      cacheWrite: ledger.cacheWrite,
      cacheWrite1h: ledger.cacheWrite1h,
      costTotalUsd: ledger.costTotalUsd,
      cacheWriteUsd: ledger.cacheWriteUsd,
    },
  };

  const pending = next.pending;
  if (pending !== undefined && ledger.entrySeq >= pending.minEntrySeq) {
    const confirmed = ledger.cacheWrite1h !== undefined && ledger.cacheWrite1h > 0;
    next = {
      ...next,
      pending: undefined,
      confirmed1hWrites: next.confirmed1hWrites + (confirmed ? 1 : 0),
      unconfirmed1hWrites: next.unconfirmed1hWrites + (!confirmed && ledger.cacheWrite > 0 ? 1 : 0),
      // Two budgets, one settlement: the ENTRY FEE (uncovered transition) is a
      // one-time capital cost with its own cap and its own USD fraction; only a
      // covered 1h→1h upgrade spends the marginal budget the §4.4 bound is about.
      // Missing cost data (`cacheWriteUsd === undefined`) accrues nothing on either
      // side — the token budgets still bound the session (never guess a cost).
      ...(pending.covered1h
        ? {
            upgradeWriteTokens: next.upgradeWriteTokens + ledger.cacheWrite,
            upgradeWriteUsd:
              next.upgradeWriteUsd +
              (ledger.cacheWriteUsd === undefined ? 0 : MARGINAL_WRITE_FRACTION * ledger.cacheWriteUsd),
          }
        : {
            feeUpgrades: next.feeUpgrades + 1,
            feeWriteTokens: next.feeWriteTokens + ledger.cacheWrite,
            feeWriteUsd:
              next.feeWriteUsd +
              (ledger.cacheWriteUsd === undefined ? 0 : ENTRY_FEE_MARGINAL_WRITE_FRACTION * ledger.cacheWriteUsd),
          }),
    };
    // The warm probes test §0.4 corollary 1 — "a warm 1h upgrade bills only the
    // increment" — which is a claim about 1h→1h. On a transition the full-prefix
    // rewrite IS the expected shape (field evidence, plan.md §16.3), so judging it
    // here produced a guaranteed false trip on the first upgrade of every session.
    if (pending.class === "warm" && pending.covered1h) {
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
    next.oneHourCoverUntil !== undefined &&
    now < next.oneHourCoverUntil &&
    next.lastGapMs !== undefined &&
    next.lastGapMs > ASSUMED_TTL_MS
  ) {
    if (ledger.cacheRead > 0) {
      next = { ...next, indirect1hConfirms: next.indirect1hConfirms + 1 };
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
    droppedPending: state.droppedPending,
    breaker: state.breaker,
    lastReconcile: state.lastReconcile,
  };
}
