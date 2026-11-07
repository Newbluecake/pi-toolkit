/**
 * jev-reflex · #25 B1 backtest evidence fold (BA §4.7 / U2 / U4): replay rows restricted to a
 * frozen holdout batch → `BacktestEvidence`. Only rows whose turnKey is in the batch AND whose
 * split is "holdout" count; confirmed and lenient are kept in separate ledgers (K11 — the
 * promotion rate uses confirmed only); reasked/corrected count on high rows with (unverified)
 * review "ok" verdicts waived into `waived`.
 *
 * Review records are UNVERIFIED data (R-I14): they feed statistics, never authentication.
 * Pure, pi-free, no state (I4/R-I10).
 */

import { createHash } from "node:crypto";
import { identityKey, templateHash } from "../identity.js";
import { countCrossSessionRepeats } from "../promotion.js";
import type {
  BacktestEvidence,
  EvidenceIdentity,
  EvalBatchV1,
  GateFactName,
  ReplayRow,
  ReviewFileV1,
  RScriptV1,
  Turn,
} from "../types.js";

/**
 * The batch turn key: sha256(`${entryId}\0${at}`), full hex. This IS the definition B3's
 * ledger-format encodes and `admitBatch` compares — import it, do not re-derive.
 */
export function turnKeyOf(turn: Pick<Turn, "entryId" | "at">): string {
  return createHash("sha256").update(`${turn.entryId}\u0000${turn.at}`, "utf8").digest("hex");
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Strict parse of a `reviews/<portId>.json` payload (BA §4.8): anything malformed ⇒ undefined
 * (bad data is skipped, never partially trusted — R-I14).
 */
export function parseReviewFile(raw: unknown): ReviewFileV1 | undefined {
  if (!isObj(raw) || raw["v"] !== 1 || raw["unverified"] !== true) return undefined;
  const entries = raw["entries"];
  if (!Array.isArray(entries)) return undefined;
  const out: ReviewFileV1["entries"][number][] = [];
  for (const e of entries) {
    if (!isObj(e)) return undefined;
    const digest = e["digest"];
    const portId = e["portId"];
    const verdict = e["verdict"];
    const at = e["at"];
    if (typeof digest !== "string" || digest.length === 0) return undefined;
    if (typeof portId !== "string" || portId.length === 0) return undefined;
    if (verdict !== "ok" && verdict !== "misfire") return undefined;
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0) return undefined;
    out.push({ digest, portId, verdict, at });
  }
  return { v: 1, entries: out, unverified: true };
}

/**
 * Resolve a replay row's high hit to its V2 evidence identity against the catalog/draft lists
 * the row was produced with. Non-high rows ⇒ undefined. `portVer` is 0 (backtest has no port
 * runs; the identity KEY only binds lineage+templateHash so this never affects merging).
 */
export function highIdentityOf(
  row: ReplayRow,
  builtin: readonly RScriptV1[],
  drafts: readonly RScriptV1[],
): EvidenceIdentity | undefined {
  if (row.cls.k !== "high") return undefined;
  const cls = row.cls;
  const script = (cls.layer === "draft" ? drafts : builtin).find((s) => s.id === cls.scriptId);
  if (script === undefined) return undefined;
  return {
    lineage: script.lineage ?? script.id,
    templateHash: templateHash(script),
    portId: script.port.id,
    portVer: 0,
  };
}

/** Review entry keyed by digest, filtered to the identity's port. */
function reviewIndex(review: ReviewFileV1 | undefined, portId: string): Map<string, "ok" | "misfire"> {
  const map = new Map<string, "ok" | "misfire">();
  if (review === undefined) return map;
  for (const e of review.entries) if (e.portId === portId && !map.has(e.digest)) map.set(e.digest, e.verdict);
  return map;
}

const EMPTY_UNKNOWN: Record<GateFactName, number> = {
  idle: 0,
  pendingMessages: 0,
  topicSwitchActive: 0,
  goalBusy: 0,
  inFlight: 0,
  sourceMode: 0,
};

/**
 * Fold identity-filtered replay rows into the backtest side of a merged promotion verdict.
 *
 * Contract: `rows` are replay output rows for the WHOLE corpus, pre-filtered by the caller to
 * rows whose high hits resolve to `identity` (`highIdentityOf`) — non-high rows may ride along
 * (they contribute nothing) — plus, for the `unscored` count, that identity's high rows whose
 * split is "unscored". Turn-side counts only rows with `turnKeys ∈ batch ∧ split==="holdout"`.
 */
export function backtestEvidence(
  rows: readonly ReplayRow[],
  batch: EvalBatchV1,
  identity: EvidenceIdentity,
  review?: ReviewFileV1,
): BacktestEvidence {
  const keySet = new Set(batch.turnKeys);
  const reviews = reviewIndex(review, identity.portId);

  const confirmed = { judged: 0, diverge: 0 };
  const lenient = { judged: 0, diverge: 0, unknownFacts: { ...EMPTY_UNKNOWN } };
  let reasked = 0;
  let corrected = 0;
  let waived = 0;
  let suspects = 0;
  let reviewed = 0;
  let misfires = 0;
  let unscored = 0;
  const crossRows: { session: string; at: number; key: string; digest: string }[] = [];
  const misfired = new Set<string>();

  for (const row of rows) {
    if (row.cls.k !== "high") continue;
    const turn = row.turn;
    if (turn.split === "unscored") {
      unscored += 1;
      continue;
    }
    if (!keySet.has(turnKeyOf(turn)) || turn.split !== "holdout") continue; // train / out-of-batch
    const bucket = row.acceptance === "confirmed" ? confirmed : lenient;
    bucket.judged += 1;
    if (row.cls.agree === "diverge") bucket.diverge += 1;
    if (row.acceptance === "lenient") {
      for (const fact of turn.unknownFacts) lenient.unknownFacts[fact] += 1;
    }
    const waiver = reviews.get(turn.digest);
    if (row.reasked && waiver !== "ok") reasked += 1;
    if (row.corrected && waiver !== "ok") corrected += 1;
    if ((row.reasked || row.corrected) && waiver === "ok") waived += 1; // once per waived row
    if (row.suspect !== undefined) {
      suspects += 1;
      if (waiver !== undefined) reviewed += 1;
    }
    if (waiver === "misfire" && !misfired.has(turn.digest)) {
      misfired.add(turn.digest);
      misfires += 1;
    }
    crossRows.push({ session: turn.session, at: turn.at, key: identityKey(identity), digest: turn.digest });
  }

  const key = identityKey(identity);
  return {
    batchId: batch.batchId,
    manifestHash: batch.manifestHash,
    identity,
    confirmed,
    lenient,
    reasked,
    crossSessionRepeats: countCrossSessionRepeats(crossRows).get(key) ?? 0,
    corrected,
    waived,
    suspects,
    reviewed,
    misfires,
    unscored,
  };
}
