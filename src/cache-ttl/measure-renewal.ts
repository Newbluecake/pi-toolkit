/**
 * Boundary renewal arm of `/cache-ttl measure` (measure-plan.md r4 §5.5, rulings 10/13/14). Pure and pi-free.
 *
 * Question: does a cache READ reset the entry's lifetime? At the first valid TTL miss (slot `b`, the UNTOUCHED arm) one
 * renewal read `R` re-sends the prefix of slot `a` (the slot holding `lowerMs`, the TOUCHED arm: it was read once at
 * `r1`, its own probe). Eligibility is checked from ACTUAL send intervals with their uncertainty — never from nominal
 * gaps (gate G-b): before sending with planned timings (`headersAt` bounded by the 30 s per-send deadline), and again
 * after with the real ones.
 *
 * Verdicts: `true` (basis `documented-ceiling` | `paired-empirical`) or `unknown(reason)`. `false` is NEVER produced —
 * a miss of `R` is equally explained by eviction, an undetectable backend split or lost usage.
 */

import {
  DOCUMENTED_CEILING_ORIGIN,
  MEASURE_TIMING,
  RENEWAL,
  type ClassifyResult,
  type EffectiveTier,
  type IntervalMs,
  type MeasureUsage,
  type RenewalBasis,
  type RenewalRecord,
  type RenewalUnknownReason,
  type RequestTiming,
  type SlotBaseline,
} from "./measure-types.js";
import { slackOf } from "./measure-classify.js";

/** `[y.sentAt − x.headersAt, y.headersAt − x.sentAt]` — the idle/age interval between two touches `x → y` (§5.1). */
export function intervalBetween(x: RequestTiming, y: RequestTiming): IntervalMs {
  return [y.sentAt - x.headersAt, y.headersAt - x.sentAt];
}

/** Everything known at the boundary (all timings are real, measured on the run's clock). */
export interface RenewalGeometry {
  tier: EffectiveTier;
  /** Lower-case normalised origin of the route (scheme://host[:port], default port dropped); `undefined` ⇒ unknown. */
  origin?: string;
  /** `lowerMs` — the idle lower bound of slot `a`'s valid probe hit (`r1`). */
  lowerMs: number;
  touchedGapMs: number;
  untouchedGapMs: number;
  /** Slot `a`'s write, its probe `r1`, slot `b`'s write and its valid miss probe. */
  wA: RequestTiming;
  r1: RequestTiming;
  wB: RequestTiming;
  miss: RequestTiming;
  /** A 429 was seen anywhere in the run. */
  rateLimited: boolean;
  /** `w_a`, `r1`, `w_b` and the miss were all valid samples (R's own validity is judged at the verdict). */
  involvedValid: boolean;
}

/** The documented ceiling (ms) for this tier on this origin, or `undefined` when the documented basis does not apply. */
export function documentedCeilingFor(tier: EffectiveTier, origin: string | undefined): number | undefined {
  if (origin === undefined || origin.toLowerCase() !== DOCUMENTED_CEILING_ORIGIN) return undefined;
  if (tier === "ephemeral" || tier === "ephemeral-1h") return RENEWAL.documentedCeilingMs[tier];
  return undefined;
}

export interface BasisEvaluation {
  basis: RenewalBasis;
  ok: boolean;
  /** Ceiling `K` used. */
  ceilingMs: number;
  ageRMs: IntervalMs;
  idleRMs: IntervalMs;
  missAgeMs: IntervalMs;
  /** Which condition failed (diagnostics only). */
  failed?: "age" | "idle" | "validity";
}

/**
 * §5.5 conditions for one basis with a given R timing: `ageR.lo ≥ K + m_age` and `idleR.hi + 10 s < survival`, where
 * `ageR = [R.sentAt − w_a.headersAt, R.headersAt − w_a.sentAt]`, `idleR` = interval from `r1` to `R`, and `missAge` =
 * the slot-`b` miss measured from `b`'s WRITE (conservative for slot 5, whose probe anchor moved to the control).
 */
export function evaluateBasis(basis: RenewalBasis, g: RenewalGeometry, r: RequestTiming): BasisEvaluation | undefined {
  const ageRMs = intervalBetween(g.wA, r);
  const idleRMs = intervalBetween(g.r1, r);
  const missAgeMs = intervalBetween(g.wB, g.miss);
  let ceilingMs: number;
  let survival: number;
  if (basis === "documented-ceiling") {
    const k = documentedCeilingFor(g.tier, g.origin);
    if (k === undefined) return undefined;
    ceilingMs = k;
    survival = Math.max(g.lowerMs, k);
  } else {
    ceilingMs = missAgeMs[1];
    survival = g.lowerMs;
  }
  const base = { basis, ceilingMs, ageRMs, idleRMs, missAgeMs } as const;
  if (basis === "paired-empirical" && (g.rateLimited || !g.involvedValid)) {
    return { ...base, ok: false, failed: "validity" };
  }
  if (ageRMs[0] < ceilingMs + RENEWAL.ageMarginMs[basis]) return { ...base, ok: false, failed: "age" };
  if (idleRMs[1] + RENEWAL.idleMarginMs >= survival) return { ...base, ok: false, failed: "idle" };
  return { ...base, ok: true };
}

/** Bases to try, strongest first: documented (official origin only), then paired-empirical (any route). */
function evaluateAll(g: RenewalGeometry, r: RequestTiming): BasisEvaluation[] {
  const out: BasisEvaluation[] = [];
  const doc = evaluateBasis("documented-ceiling", g, r);
  if (doc !== undefined) out.push(doc);
  const paired = evaluateBasis("paired-empirical", g, r);
  if (paired !== undefined) out.push(paired);
  return out;
}

export type RenewalPlan =
  | { eligible: true; basis: RenewalBasis; ceilingMs: number; plannedSentAt: number; plannedHeadersAt: number }
  | { eligible: false; evaluations: BasisEvaluation[]; plannedSentAt: number; plannedHeadersAt: number };

/**
 * Pre-send check: `R` is planned `delayAfterMissMs` after the miss response and its `headersAt` is bounded by the
 * per-send deadline. Ineligible ⇒ the runner sends nothing (zero cost).
 */
export function planRenewal(g: RenewalGeometry): RenewalPlan {
  const plannedSentAt = g.miss.headersAt + RENEWAL.delayAfterMissMs;
  const plannedHeadersAt = plannedSentAt + MEASURE_TIMING.perSendDeadlineMs;
  const evaluations = evaluateAll(g, { sentAt: plannedSentAt, headersAt: plannedHeadersAt });
  const ok = evaluations.find((e) => e.ok);
  if (ok !== undefined) {
    return { eligible: true, basis: ok.basis, ceilingMs: ok.ceilingMs, plannedSentAt, plannedHeadersAt };
  }
  return { eligible: false, evaluations, plannedSentAt, plannedHeadersAt };
}

/** What happened to `R` (built by the runner from the action table / classification). */
export type RenewalReadInfo =
  | { verdict: "hit" | "miss"; timing: RequestTiming; usage: MeasureUsage; baselineA: SlotBaseline }
  | { verdict: "inconclusive"; reason: RenewalUnknownReason; timing?: RequestTiming; usage?: MeasureUsage }
  | { verdict: "not-sent"; reason: RenewalUnknownReason };

const geometryFields = (g: RenewalGeometry) => ({
  touchedGapMs: g.touchedGapMs,
  untouchedGapMs: g.untouchedGapMs,
  missAgeMs: intervalBetween(g.wB, g.miss),
});

/** Map a classification of `R` to its read info. */
export function readInfoFromClassification(
  c: ClassifyResult,
  timing: RequestTiming,
  usage: MeasureUsage,
  baselineA: SlotBaseline,
): RenewalReadInfo {
  if (c.kind === "hit" || c.kind === "miss") return { verdict: c.kind, timing, usage, baselineA };
  return { verdict: "inconclusive", reason: c.reason as RenewalUnknownReason, timing, usage };
}

/** Record for a renewal that was never attempted (ineligible pair, no expiry observed, budget …). */
export function unsentRenewalRecord(reason: RenewalUnknownReason, g?: RenewalGeometry): RenewalRecord {
  return { renewsOnRead: "unknown", reason, ...(g !== undefined ? geometryFields(g) : {}) };
}

/** §5.5 verdict + record after `R` was (or was not) read. Never `renewsOnRead: "false"`. */
export function finalizeRenewal(g: RenewalGeometry, read: RenewalReadInfo): RenewalRecord {
  const geo = geometryFields(g);
  if (read.verdict === "not-sent") {
    return { renewsOnRead: "unknown", reason: read.reason, ...geo, read: { verdict: "not-sent" } };
  }
  const timing = read.timing;
  const timingFields = timing !== undefined ? { sentAt: timing.sentAt, headersAt: timing.headersAt } : {};
  if (read.verdict === "inconclusive") {
    return {
      renewsOnRead: "unknown",
      reason: read.reason,
      ...geo,
      read: {
        verdict: "inconclusive",
        ...timingFields,
        ...(read.usage !== undefined ? { P: read.usage.P, C: read.usage.C } : {}),
      },
    };
  }
  const { usage, baselineA } = read;
  const readRecord = {
    verdict: read.verdict,
    ...timingFields,
    P: usage.P,
    C: usage.C,
    B: baselineA.B,
    S: baselineA.S,
  } as const;
  if (read.verdict === "miss") {
    return { renewsOnRead: "unknown", reason: "renewal-miss", ...geo, read: readRecord };
  }
  // hit: re-check the pair with the ACTUAL timings
  if (Math.abs(usage.P - baselineA.P_w) > slackOf(baselineA.P_w)) {
    return { renewsOnRead: "unknown", reason: "backend-mismatch", ...geo, read: readRecord };
  }
  const evaluations = evaluateAll(g, read.timing);
  const ok = evaluations.find((e) => e.ok);
  if (ok === undefined) {
    const shown = evaluations[evaluations.length - 1];
    return {
      renewsOnRead: "unknown",
      reason: "pair-ineligible",
      ...geo,
      ...(shown !== undefined
        ? { ceilingMs: shown.ceilingMs, ageRMs: shown.ageRMs, idleRMs: shown.idleRMs }
        : { ageRMs: intervalBetween(g.wA, read.timing), idleRMs: intervalBetween(g.r1, read.timing) }),
      read: readRecord,
    };
  }
  return {
    renewsOnRead: "true",
    basis: ok.basis,
    ...(ok.basis === "paired-empirical" ? { assumptions: [...RENEWAL.pairedAssumptions] } : {}),
    ...geo,
    ceilingMs: ok.ceilingMs,
    ageRMs: ok.ageRMs,
    idleRMs: ok.idleRMs,
    read: readRecord,
  };
}
