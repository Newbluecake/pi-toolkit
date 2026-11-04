/**
 * jev-reflex · promotion gate — the ONLY implementation (plan R1 step 11; U5, arch §4.8).
 * Read-only judgement: it computes eligibility and Chinese reasons, it never touches settings
 * (晋升只能人工改设置, U6/D9).
 *
 * 口径 (plan R1 step 11):
 * - `candidates` = `kind:"shadow"` records; `portRuns`/`portOk`/`unavailable` are scoped to
 *   those records with `port.outcome ∈ {ok, uncertain, error, timeout}` (`unavailable` is
 *   counted separately and stays out of the ok-rate denominator);
 * - `judged = agree + noTool + diverge` (unknown never enters a denominator);
 * - `reasked` = session-internal `reasked:true` marks + AUTO-era `kind:"repeat"` records;
 * - `crossSessionRepeats` is filled by `countCrossSessionRepeats` (R3b; `undefined` ⇒
 *   undetermined ⇒ never eligible);
 * - `corrected` = `subagent:reflex-correction` entries targeting this `scriptId@scriptVer`;
 * - `p50ms`/`p95ms` stay caller-filled (accumulate holds no sample buffer — R1-report);
 *   `msPercentiles` is the helper for that.
 */

import { REPEAT_WINDOW_MS } from "./budget.js";
import type { ReflexAnswerDetailsV1, ReflexCorrectionV1, ReflexRecordV1 } from "./types.js";

export const PROMOTION_GATE = Object.freeze({
  minCandidates: 50,
  minOkRate: 0.99,
  maxDivergeRate: 0.05,
  maxReasked: 0,
  maxCorrected: 0,
});

export interface ScriptStats {
  scriptId: string;
  scriptVer: number;
  candidates: number;
  portRuns: number;
  portOk: number;
  unavailable: number;
  judged: number;
  agree: number;
  noTool: number;
  diverge: number;
  unknown: number;
  reasked: number;
  crossSessionRepeats: number | undefined;
  corrected: number;
  answered: number;
  fallback: number;
  repeat: number;
  p50ms?: number;
  p95ms?: number;
}

export type PromotionRow =
  | { kind: "record"; rec: ReflexRecordV1 }
  | { kind: "answer"; details: ReflexAnswerDetailsV1 }
  | { kind: "correction"; c: ReflexCorrectionV1 };

function keyOf(scriptId: string, scriptVer: number): string {
  return `${scriptId}@${scriptVer}`;
}

function statsFor(stats: Map<string, ScriptStats>, scriptId: string, scriptVer: number): ScriptStats {
  const key = keyOf(scriptId, scriptVer);
  let entry = stats.get(key);
  if (entry === undefined) {
    entry = {
      scriptId,
      scriptVer,
      candidates: 0,
      portRuns: 0,
      portOk: 0,
      unavailable: 0,
      judged: 0,
      agree: 0,
      noTool: 0,
      diverge: 0,
      unknown: 0,
      reasked: 0,
      crossSessionRepeats: undefined,
      corrected: 0,
      answered: 0,
      fallback: 0,
      repeat: 0,
    };
    stats.set(key, entry);
  }
  return entry;
}

/** Fold one transcript row into `stats` (mutates the map; callers own both). */
export function accumulate(stats: Map<string, ScriptStats>, row: PromotionRow): void {
  if (row.kind === "correction") {
    statsFor(stats, row.c.targetScriptId, row.c.targetScriptVer).corrected += 1;
    return;
  }
  if (row.kind === "answer") {
    statsFor(stats, row.details.scriptId, row.details.scriptVer).answered += 1;
    return;
  }
  const rec = row.rec;
  const s = statsFor(stats, rec.scriptId, rec.scriptVer);
  if (rec.kind === "shadow") {
    s.candidates += 1;
    const outcome = rec.port?.outcome;
    if (outcome === "ok" || outcome === "uncertain" || outcome === "error" || outcome === "timeout") {
      s.portRuns += 1;
      if (outcome === "ok") s.portOk += 1;
    } else if (outcome === "unavailable") {
      s.unavailable += 1;
    }
  } else if (rec.kind === "fallback") {
    s.fallback += 1;
  } else if (rec.kind === "repeat") {
    s.repeat += 1;
    if (rec.state === "auto") s.reasked += 1; // AUTO-era repeats count as re-asks (口径)
  }
  if (rec.reasked === true) s.reasked += 1;
  if (rec.model !== undefined) {
    switch (rec.model.agree) {
      case "agree":
        s.agree += 1;
        break;
      case "no-tool":
        s.noTool += 1;
        break;
      case "diverge":
        s.diverge += 1;
        break;
      default:
        s.unknown += 1;
    }
    s.judged = s.agree + s.noTool + s.diverge; // 口径: unknown never enters the denominator
  }
}

/** p50/p95 helper for callers that kept the raw ms samples (R3b, `/reflex status`). */
export function msPercentiles(samples: readonly number[]): { p50?: number; p95?: number } {
  if (samples.length === 0) return {};
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { p50: pick(0.5), p95: pick(0.95) };
}

/**
 * Count "same script@ver + same digest appearing again within REPEAT_WINDOW_MS in a DIFFERENT
 * session" (plan R3b 口径): rows are `(session, at, key, digest)` occurrences — shadow records
 * AND answers both feed this. Every key seen in `rows` is mapped (0 included); keys with no
 * rows stay absent (⇒ undetermined upstream).
 */
export function countCrossSessionRepeats(
  rows: readonly { session: string; at: number; key: string; digest: string }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  const last = new Map<string, { session: string; at: number }>();
  const ordered = [...rows].sort((a, b) => a.at - b.at);
  for (const row of ordered) {
    const lastKey = `${row.key}\u0000${row.digest}`;
    counts.set(row.key, counts.get(row.key) ?? 0);
    const prev = last.get(lastKey);
    if (prev !== undefined && row.at - prev.at <= REPEAT_WINDOW_MS && prev.session !== row.session) {
      counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
    }
    last.set(lastKey, { session: row.session, at: row.at });
  }
  return counts;
}

export interface PromotionVerdict {
  eligible: boolean;
  /** Chinese one-liners, one per failed criterion (empty ⇔ eligible). */
  reasons: readonly string[];
}

/** U5: ≥50 candidates / portRuns / judged, ok ≥ 99%, diverge ≤ 5%, zero re-asks (incl. cross-session, must be DETERMINED), zero corrections. */
export function evaluatePromotion(s: ScriptStats): PromotionVerdict {
  const g = PROMOTION_GATE;
  const reasons: string[] = [];
  if (s.candidates < g.minCandidates) reasons.push(`候选不足 ${g.minCandidates}（当前 ${s.candidates}）`);
  if (s.portRuns < g.minCandidates) reasons.push(`port 运行数不足 ${g.minCandidates}（当前 ${s.portRuns}）`);
  // 口径: judged = agree+noTool+diverge; hand-built stats must keep the field consistent
  // (accumulate maintains it automatically; unknown never enters a denominator).
  const judged = s.judged;
  if (judged < g.minCandidates) reasons.push(`判定样本不足 ${g.minCandidates}（当前 ${judged}）`);
  const okRate = s.portRuns > 0 ? s.portOk / s.portRuns : 0;
  if (!(okRate >= g.minOkRate))
    reasons.push(`port 成功率 ${(okRate * 100).toFixed(1)}% < ${(g.minOkRate * 100).toFixed(0)}%`);
  const divergeRate = judged > 0 ? s.diverge / judged : 0;
  if (!(divergeRate <= g.maxDivergeRate)) {
    reasons.push(`分歧率 ${(divergeRate * 100).toFixed(1)}% > ${(g.maxDivergeRate * 100).toFixed(0)}%`);
  }
  if (s.reasked > g.maxReasked) reasons.push(`存在重复提问（${s.reasked}）`);
  if (s.crossSessionRepeats === undefined) reasons.push("跨会话重复未判定");
  else if (s.crossSessionRepeats > 0) reasons.push(`存在跨会话重复（${s.crossSessionRepeats}）`);
  if (s.corrected > g.maxCorrected) reasons.push(`存在纠正（${s.corrected}）`);
  return { eligible: reasons.length === 0, reasons };
}
