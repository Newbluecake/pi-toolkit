/**
 * Classification, control decision and TTL result of `/cache-ttl measure` (measure-plan.md r4 §5.1/§5.3/§5.4).
 * Pure and pi-free.
 */

import type { Millis } from "../core/types.js";
import {
  CLASSIFY,
  ELIGIBILITY,
  TTL_GAPS_MS,
  type ClassifyResult,
  type MeasureRunStatus,
  type MeasureUsage,
  type SlotBaseline,
  type TtlResult,
  type TtlSampleRecord,
} from "./measure-types.js";

/** §5.3: per-slot write baseline — `B = C_w` (relay-injected cached baseline), `S = P_w − B` (the slot's own prefix). */
export function slotBaselineOf(write: MeasureUsage): SlotBaseline {
  return { P_w: write.P, B: write.C, S: write.P - write.C };
}

/** §5.3: `slack(P) = max(512, ⌈0.02·P⌉)`. */
export function slackOf(P: number): number {
  return Math.max(CLASSIFY.slackMinTokens, Math.ceil(CLASSIFY.slackShare * P));
}

/** §5.3: minimum own prefix — `S ≥ 4096` and `S ≥ 0.5·P_w`. */
export function ownPrefixSufficient(b: SlotBaseline): boolean {
  return b.S >= CLASSIFY.minOwnTokens && b.S >= CLASSIFY.minOwnShare * b.P_w;
}

/**
 * §5.3: classify one read against its own slot's write. Order: own-prefix minimum → backend-size mismatch →
 * hit (`C − B ≥ 0.8·S`) / miss (`C − B ≤ 0.2·S`) / partial. Callers pass only readings whose `cacheEvidence` is valid.
 */
export function classifyRead(baseline: SlotBaseline, read: MeasureUsage): ClassifyResult {
  if (!ownPrefixSufficient(baseline)) return { kind: "inconclusive", reason: "own-prefix-small" };
  if (Math.abs(read.P - baseline.P_w) > slackOf(baseline.P_w))
    return { kind: "inconclusive", reason: "backend-mismatch" };
  const delta = read.C - baseline.B;
  if (delta >= CLASSIFY.hitShare * baseline.S) return { kind: "hit" };
  if (delta <= CLASSIFY.missShare * baseline.S) return { kind: "miss" };
  return { kind: "inconclusive", reason: "partial" };
}

/** §4.3 runtime bound guard: which stated condition (if any) an observed request broke. */
export function boundBroken(
  usage: MeasureUsage | undefined,
  pBound: number,
  outputCap: number,
): "C1" | "C2" | undefined {
  if (usage === undefined) return undefined;
  if (usage.P > pBound) return "C1";
  if (usage.output !== undefined && usage.output > outputCap) return "C2";
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Control (§5.1 step 2, ruling 8)
// ---------------------------------------------------------------------------------------------------------------------

export type ControlAttemptVerdict = "hit" | "miss" | "other";
export type ControlDecision =
  /** A valid hit: proceed to the TTL probes. */
  | { kind: "proceed" }
  /** First attempt was not a valid hit and the single retry is still available. */
  | { kind: "retry" }
  /** Two valid misses ⇒ the route does not cache (ruling 8). */
  | { kind: "no-cache" }
  /** Anything else after the retry ⇒ cannot tell. */
  | { kind: "control-inconclusive" };

/** Decide after each control attempt (`attempts` = the verdicts so far, at most 2). */
export function decideControl(attempts: readonly ControlAttemptVerdict[]): ControlDecision {
  if (attempts.some((a) => a === "hit")) return { kind: "proceed" };
  if (attempts.length < 2) return { kind: "retry" };
  return attempts.every((a) => a === "miss") ? { kind: "no-cache" } : { kind: "control-inconclusive" };
}

// ---------------------------------------------------------------------------------------------------------------------
// TTL result (§5.4)
// ---------------------------------------------------------------------------------------------------------------------

const isValidSample = (s: TtlSampleRecord): boolean =>
  s.cacheEvidence === "valid" && (s.verdict === "hit" || s.verdict === "miss") && s.idleMs !== undefined;

/**
 * §5.4: `lowerMs` = max `idle.lo` over valid hits ("at least X"), none ⇒ unknown; `missMs` = min `idle.hi` over valid
 * misses (an observed miss — never a TTL ceiling); `reachedMaxGap` only with a valid hit at the 61-min arm;
 * `consistent` = hits < misses. `eligible` additionally needs a complete/partial run, ≥ 1 valid hit and
 * `lowerMs ≥ 150 s` (same key/tier/age are checked on lookup).
 */
export function computeTtlResult(samples: readonly TtlSampleRecord[], status: MeasureRunStatus): TtlResult {
  const hits = samples.filter((s) => isValidSample(s) && s.verdict === "hit");
  const misses = samples.filter((s) => isValidSample(s) && s.verdict === "miss");
  const lowerMs = hits.length > 0 ? Math.max(...hits.map((s) => s.idleMs![0])) : undefined;
  const missMs = misses.length > 0 ? Math.min(...misses.map((s) => s.idleMs![1])) : undefined;
  const lastGap = TTL_GAPS_MS[TTL_GAPS_MS.length - 1];
  const reachedMaxGap = hits.some((s) => s.gapMs === lastGap);
  const consistent = lowerMs === undefined || missMs === undefined || lowerMs < missMs;
  const eligible =
    (status === "complete" || status === "partial") &&
    consistent &&
    hits.length >= 1 &&
    lowerMs !== undefined &&
    lowerMs >= ELIGIBILITY.minLowerMs;
  return {
    ...(lowerMs !== undefined ? { lowerMs } : {}),
    ...(missMs !== undefined ? { missMs } : {}),
    reachedMaxGap,
    consistent,
    validHits: hits.length,
    validMisses: misses.length,
    eligible,
  };
}

/** Consumer-side eligibility of a stored record (§5.4 incl. age; key/tier equality is the lookup's job). */
export function recordEligible(
  run: { status: MeasureRunStatus; ttl: TtlResult; finishedAt?: Millis; startedAt: Millis },
  now: Millis,
): boolean {
  const t = run.ttl;
  if (run.status !== "complete" && run.status !== "partial") return false;
  if (!t.consistent || t.validHits < 1 || t.lowerMs === undefined || t.lowerMs < ELIGIBILITY.minLowerMs) return false;
  const sampledAt = run.finishedAt ?? run.startedAt;
  return now - sampledAt <= ELIGIBILITY.maxAgeMs && now >= sampledAt - 60_000;
}

const fmtMin = (ms: number): string => {
  const m = ms / 60_000;
  return Number.isInteger(m) ? `${m}` : m.toFixed(1);
};

/** Human wording of a TTL result — never states a ceiling; "≥ 61 min" only with a valid 61-min hit. */
export function describeTtl(ttl: TtlResult): string {
  if (ttl.lowerMs === undefined) return "ttl unknown (no valid hit)";
  const base = ttl.reachedMaxGap ? "ttl ≥ 61 min" : `ttl ≥ ${fmtMin(ttl.lowerMs)} min`;
  return ttl.missMs !== undefined
    ? `${base}; miss observed at ≤ ${fmtMin(ttl.missMs)} min (expiry or eviction under this run's load)`
    : base;
}
