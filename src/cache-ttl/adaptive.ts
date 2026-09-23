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

// ---------------------------------------------------------------------------
// Constants (plan.md §7.2 — guardrails, deliberately NOT settings).
// ---------------------------------------------------------------------------

/** M2 composite probe: trip when the measured write exceeds factor × predicted delta... */
export const ADAPTIVE_PROBE_WRITE_FACTOR = 3;
/** ...AND this absolute floor (one partially-hit post-compact rewrite can legitimately reach 50k+; the probe catches structural route-level violations, not a single large rewrite). */
export const ADAPTIVE_PROBE_WRITE_FLOOR_TOKENS = 64_000;
/** plan.md §6.1a: a pending probe whose ledger never arrives is dropped (and pre-booked, m1) after this. */
export const ADAPTIVE_PENDING_TTL_MS: Millis = 120_000;
/** S4 ring buffer size (plan.md §3.2). */
export const ADAPTIVE_GAP_RING_SIZE = 20;
/** §4.3: an upgrade claims 1h of coverage from its decision time. */
export const ADAPTIVE_COVER_MS: Millis = 3_600_000;

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
  maxDeltaTokens: number;
  refreshAfterTokens: number;
  coldUpgrades: number;
  coldCooldownMs: Millis;
  coldMinHorizonMs: Millis;
  historyGapSignal: boolean;
  /** M2 composite probe inputs — filled from the constants above by the service, injectable for tests. */
  probeWriteFactor: number;
  probeWriteFloorTokens: number;
}

export interface AdaptivePending {
  requestSeq: number;
  /** Snapshot of `entries.length` at decision time; reconcile settles only against a ledger with `entrySeq >= minEntrySeq` (plan.md §6.1a). */
  minEntrySeq: number;
  at: Millis;
  class: AdaptiveUpgradeClass;
  predictedDeltaTokens: number;
}

export interface AdaptiveReconcileRecord {
  at: Millis;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number | undefined;
  costTotalUsd: number | undefined;
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
  if (state.upgradeWriteTokens >= config.writeBudgetTokens) return no("write-budget"); // G-G / I-A6

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

  if (warm) {
    // Warm: marginal cost 0.75 × Δ (baseline: same request unrewritten). Wide
    // signals (strong or weak), but Δ and refresh rate are controlled.
    if (ledger.cacheWrite > config.maxDeltaTokens) return no("delta-too-large", seen);
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
  const horizonOk =
    signals.backgroundBashJobs > 0 || // a bash job that outlived a cold window is a long job by construction
    signals.uiPrompts > 0 || // a human gate that outlived a cold window is AFK by construction
    (signals.subagentRuns > 0 &&
      (signals.maxSubagentHorizonMs === undefined || signals.maxSubagentHorizonMs >= config.coldMinHorizonMs));
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
      upgradeWriteTokens: next.upgradeWriteTokens + expired.predictedDeltaTokens,
    };
    if (next.upgradeWriteTokens >= config.writeBudgetTokens) next = tripBreaker(next, "write-budget", now);
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
    },
  };

  const pending = next.pending;
  if (pending !== undefined && ledger.entrySeq >= pending.minEntrySeq) {
    const confirmed = ledger.cacheWrite1h !== undefined && ledger.cacheWrite1h > 0;
    next = {
      ...next,
      pending: undefined,
      upgradeWriteTokens: next.upgradeWriteTokens + ledger.cacheWrite,
      confirmed1hWrites: next.confirmed1hWrites + (confirmed ? 1 : 0),
      unconfirmed1hWrites: next.unconfirmed1hWrites + (!confirmed && ledger.cacheWrite > 0 ? 1 : 0),
    };
    if (pending.class === "warm") {
      if (ledger.cacheRead === 0) {
        // Judged warm, actually missed — the warm/cold judgement is unreliable on this route.
        next = tripBreaker(next, "warm-miss", now);
      } else if (
        ledger.cacheWrite >
        Math.max(config.probeWriteFactor * pending.predictedDeltaTokens, config.probeWriteFloorTokens)
      ) {
        // M2 composite probe: the "warm" upgrade rewrote far more than the
        // predicted increment — corollary 1 (plan.md §0.4) does not hold here.
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

  if (next.upgradeWriteTokens >= config.writeBudgetTokens) next = tripBreaker(next, "write-budget", now);
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
      upgradeWriteTokens: next.upgradeWriteTokens + pending.predictedDeltaTokens,
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
