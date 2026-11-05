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

// #25 B5: append-only V2 API. The R1/R3b exports above remain frozen.
import { identityKey, resolveIdentity, type IdentityRow } from "./identity.js";
import { portOfScript } from "./port-defaults.js";
import { createRowDeduper } from "./shadow-dedupe.js";
import type {
  BatchValidity,
  CorpusManifestV1,
  EvalBatchV1,
  EvidenceIdentity,
  ExposureRecordV1,
  MergedEvidence,
  PortId,
  PortReliability,
  PromotionVerdictV2,
  RevisionRecordV1,
  RScriptV1,
  StatsV2,
  Turn,
} from "./types.js";

export const PROMOTION_GATE_V2 = Object.freeze({
  minIntentSamples: 50,
  maxDivergeRate: 0.05,
  minPortRuns: 10,
});

/** Optional transcript envelope; AUTO answers require `at` to establish repeat evidence. */
export type LiveEvidenceRow = PromotionRow & { entryId?: string; session?: string; at?: number };

function identityRowV2(row: PromotionRow): IdentityRow {
  if (row.kind === "correction")
    return {
      scriptId: row.c.targetScriptId,
      scriptVer: row.c.targetScriptVer,
      ...(row.c.targetTemplateHash !== undefined ? { templateHash: row.c.targetTemplateHash } : {}),
    };
  if (row.kind === "answer") return row.details;
  return {
    scriptId: row.rec.scriptId,
    scriptVer: row.rec.scriptVer,
    ...(row.rec.templateHash !== undefined ? { templateHash: row.rec.templateHash } : {}),
    ...(row.rec.port?.portId !== undefined ? { portId: row.rec.port.portId } : {}),
    ...(row.rec.port !== undefined ? { portVer: row.rec.port.portVer } : {}),
  };
}

/** Fold identity-level intent and zero-tolerance evidence; unknown agreement never counts. */
export function accumulateV2(
  rows: readonly PromotionRow[],
  resolve: (row: IdentityRow) => EvidenceIdentity | undefined,
): Map<string, StatsV2> {
  const stats = new Map<string, StatsV2>();
  for (const row of rows) {
    if (row.kind === "record" && row.rec.kind === "ambiguous") continue;
    const identity = resolve(identityRowV2(row));
    if (identity === undefined) continue;
    const key = identityKey(identity);
    const s = stats.get(key) ?? { identity, judged: 0, diverge: 0, reasked: 0, corrected: 0 };
    // Identity excludes port version, but keep the latest observed version for audit output.
    if (identity.portVer > s.identity.portVer) s.identity = identity;
    stats.set(key, s);
    if (row.kind === "correction") s.corrected++;
    else if (row.kind === "record") {
      const r = row.rec;
      if (r.model !== undefined && r.model.agree !== "unknown") {
        s.judged++;
        if (r.model.agree === "diverge") s.diverge++;
      }
      if (r.reasked === true || (r.kind === "repeat" && r.state === "auto")) s.reasked++;
    }
  }
  return stats;
}

/** Recover a draft's port from other rows of the same recorded template, even if its file
 * was removed. Conflicting hints stay unresolved instead of guessing a port. */
function recordedPortsV2(rows: readonly PromotionRow[]): (r: IdentityRow) => PortId | undefined {
  const hints = new Map<string, PortId | null>();
  const key = (r: IdentityRow): string => `${r.scriptId}@${r.scriptVer}#${r.templateHash ?? ""}`;
  for (const row of rows) {
    const r = identityRowV2(row);
    if (r.portId === undefined) continue;
    const k = key(r);
    if (!hints.has(k)) hints.set(k, r.portId);
    else if (hints.get(k) !== r.portId) hints.set(k, null);
  }
  return (r) => hints.get(key(r)) ?? undefined;
}

/** Version 0 is UNKNOWN, never a success pool. Missing results taint every observed version
 * of that port; callers also check the @0 bucket when the target version has no observations. */
export function portReliabilityV2(rows: readonly PromotionRow[]): Map<`${PortId}@${number}`, PortReliability> {
  const recorded = recordedPortsV2(rows);
  return foldPortsV2(rows, (r) => r.portId ?? portOfScript(r.scriptId) ?? recorded(r));
}

function foldPortsV2(
  rows: readonly PromotionRow[],
  resolvePort: (r: IdentityRow) => PortId | undefined,
): Map<`${PortId}@${number}`, PortReliability> {
  const ports = new Map<`${PortId}@${number}`, PortReliability>();
  const get = (portId: PortId, portVer: number): PortReliability => {
    const key = `${portId}@${portVer}` as const;
    let p = ports.get(key);
    if (p === undefined) {
      p = { portId, portVer, runs: 0, ok: 0, missing: 0, unavailable: 0 };
      ports.set(key, p);
    }
    return p;
  };
  for (const row of rows) {
    if (row.kind === "correction") continue;
    if (row.kind === "answer") {
      const p = get(row.details.portId, row.details.portVer);
      p.runs++;
      p.ok++;
      continue;
    }
    const r = row.rec;
    // A repeat did not execute a port; ambiguous candidates have no selected port.
    if (r.kind !== "shadow" && r.kind !== "fallback") continue;
    const portId = resolvePort(identityRowV2(row));
    if (portId === undefined) continue;
    const p = get(portId, r.port?.portVer ?? 0);
    if (r.port === undefined) p.missing++;
    else if (r.port.outcome === "unavailable") p.unavailable++;
    else {
      p.runs++;
      if (r.port.outcome === "ok") p.ok++;
    }
  }
  for (const p of ports.values()) if (p.portVer !== 0) p.missing += ports.get(`${p.portId}@0`)?.missing ?? 0;
  return ports;
}

export function batchValidity(
  batch: EvalBatchV1,
  identity: EvidenceIdentity,
  exposures: readonly ExposureRecordV1[],
  manifests: readonly CorpusManifestV1[],
): BatchValidity {
  if (!manifests.some((m) => m.manifestHash === batch.manifestHash)) return { ok: false, reason: "manifest-missing" };
  if (
    exposures.some(
      (e) => e.batchId === batch.batchId && e.lineage === identity.lineage && e.templateHash !== identity.templateHash,
    )
  )
    return { ok: false, reason: "exposed-then-modified" };
  return { ok: true };
}

/** First-seen for a hash cannot be overwritten by later appended copies; git evidence can
 * only tighten the cutoff. Revision records are unverified, not human authentication. */
export function lastRevisedAt(lineage: string, revisions: readonly RevisionRecordV1[]): number {
  const first = new Map<string, number>();
  let latest = 0;
  for (const r of revisions) {
    if (r.lineage !== lineage) continue;
    if (!first.has(r.templateHash)) first.set(r.templateHash, r.firstSeenAt);
    latest = Math.max(latest, first.get(r.templateHash)!, r.gitCommitAt ?? 0);
  }
  return latest;
}

export function admitBatch(
  candidate: readonly Pick<Turn, "at" | "digest">[],
  lineage: string,
  revisions: readonly RevisionRecordV1[],
  batches: readonly EvalBatchV1[],
  exposures: readonly ExposureRecordV1[],
): { ok: boolean; reason?: "before-revision" | "reused-exposed-turns"; cutoffAt: number } {
  const cutoffAt = lastRevisedAt(lineage, revisions);
  if (candidate.some((t) => t.at <= cutoffAt)) return { ok: false, reason: "before-revision", cutoffAt };
  const exposed = new Set(exposures.map((e) => e.batchId));
  const digests = new Set(batches.filter((b) => exposed.has(b.batchId)).flatMap((b) => [...b.turnDigests]));
  if (candidate.some((t) => digests.has(t.digest))) return { ok: false, reason: "reused-exposed-turns", cutoffAt };
  return { ok: true, cutoffAt };
}

/** Both offline CLIs use this ONE entry point. Dedup happens before any rate or repeat fold.
 * Draft corrections can outlive the draft file: a promoted builtin's lineage supplies its port. */
export function buildLiveEvidence(
  rows: readonly LiveEvidenceRow[],
  catalog: readonly RScriptV1[],
  drafts: readonly RScriptV1[],
): { stats: Map<string, StatsV2>; ports: Map<`${PortId}@${number}`, PortReliability> } {
  const recorded = recordedPortsV2(rows);
  const resolve = (r: IdentityRow): EvidenceIdentity | undefined => {
    const renamed = [...catalog, ...drafts].find((s) => s.lineage === r.scriptId);
    const portId = r.portId ?? renamed?.port.id ?? recorded(r);
    return resolveIdentity({ ...r, ...(portId !== undefined ? { portId } : {}) }, catalog, drafts);
  };
  const dedupe = createRowDeduper();
  const unique = rows.filter((r) => {
    const i = identityRowV2(r);
    const at = r.kind === "record" ? r.rec.at : r.kind === "correction" ? r.c.at : r.at;
    if (at === undefined) return true; // Keep counts, but repeats remain undetermined below.
    return dedupe({
      ...(r.entryId !== undefined ? { entryId: r.entryId } : {}),
      at,
      digest:
        r.kind === "correction"
          ? r.c.correctionDigest
          : r.kind === "record"
            ? r.rec.requestDigest
            : r.details.requestDigest,
      scriptKey: `${i.scriptId}@${i.scriptVer}`,
    });
  });
  const stats = accumulateV2(unique, resolve);
  const occurrences: { session: string; at: number; key: string; digest: string }[] = [];
  const unknown = new Set<string>();
  for (const row of unique) {
    if (row.kind === "correction" || (row.kind === "record" && row.rec.kind === "ambiguous")) continue;
    const identity = resolve(identityRowV2(row));
    if (identity === undefined) continue;
    const key = identityKey(identity);
    const at = row.kind === "record" ? row.rec.at : row.at;
    if (row.session === undefined || at === undefined || !Number.isFinite(at)) {
      unknown.add(key);
      continue;
    }
    occurrences.push({
      session: row.session,
      at,
      key,
      digest: row.kind === "record" ? row.rec.requestDigest : row.details.requestDigest,
    });
  }
  const repeats = countCrossSessionRepeats(occurrences);
  for (const [key, s] of stats) if (!unknown.has(key) && repeats.has(key)) s.crossSessionRepeats = repeats.get(key)!;
  const ports = foldPortsV2(unique, (r) => resolve(r)?.portId ?? portOfScript(r.scriptId));
  return { stats, ports };
}

export function evaluateMergedPromotion(e: MergedEvidence): PromotionVerdictV2 {
  const reasons: string[] = [];
  let undetermined = false;
  const g = PROMOTION_GATE_V2;
  const same = (i: EvidenceIdentity): boolean => identityKey(i) === identityKey(e.identity);
  const b = e.backtest;
  const live = e.live;
  const liveOK =
    live !== undefined &&
    same(live.identity) &&
    live.judged >= g.minIntentSamples &&
    live.diverge / live.judged <= g.maxDivergeRate;
  const backOK =
    b !== undefined &&
    same(b.identity) &&
    e.batchValid?.ok === true &&
    b.confirmed.judged >= g.minIntentSamples &&
    b.confirmed.diverge / b.confirmed.judged <= g.maxDivergeRate &&
    b.reviewed === b.suspects &&
    b.misfires === 0;
  if (!liveOK && !backOK) reasons.push("intent-evidence-insufficient");
  if (b !== undefined) {
    if (!same(b.identity)) reasons.push("identity-mismatch");
    if (b.reviewed !== b.suspects) reasons.push("review-incomplete");
    if (b.misfires !== 0) reasons.push("misfire");
    if (e.batchValid?.ok !== true) reasons.push(e.batchValid?.reason ?? "batch-invalid");
  }
  if (live !== undefined && !same(live.identity)) reasons.push("identity-mismatch");
  if (!e.scanComplete) reasons.push("scan-incomplete");
  const p = e.port;
  if (p !== undefined && p.missing > 0) {
    reasons.push("port-missing");
    undetermined = true;
  }
  if (p === undefined || p.portId !== e.identity.portId || p.portVer !== e.identity.portVer || p.runs < g.minPortRuns)
    reasons.push("port-runs-insufficient");
  if (p !== undefined && p.ok !== p.runs) reasons.push("port-not-all-ok");
  if ((live === undefined && b === undefined) || (live !== undefined && live.crossSessionRepeats === undefined)) {
    reasons.push("cross-session-undetermined");
    undetermined = true;
  }
  if ((live?.reasked ?? 0) + (b?.reasked ?? 0) > 0) reasons.push("reasked");
  if ((live?.corrected ?? 0) + (b?.corrected ?? 0) > 0) reasons.push("corrected");
  if ((live?.crossSessionRepeats ?? 0) + (b?.crossSessionRepeats ?? 0) > 0) reasons.push("cross-session-repeat");
  return {
    verdict: reasons.length === 0 ? "eligible" : undetermined ? "undetermined" : "not-eligible",
    reasons,
    identity: e.identity,
    ...(b !== undefined ? { batchId: b.batchId, manifestHash: b.manifestHash } : {}),
  };
}
