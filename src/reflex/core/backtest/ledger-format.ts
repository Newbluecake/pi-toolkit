/** B3 ledger codecs and storage policy. All records are unverified data, not authentication. */
import type {
  CorpusManifestV1,
  EvalBatchV1,
  ExposureRecordV1,
  RevisionRecordV1,
  ReviewFileV1,
  Turn,
} from "../types.js";
import { parseReviewFile, turnKeyOf } from "./evidence.js";
import { cacheVersions, hash, type CachedFile } from "./cache-format.js";

export interface LedgerState {
  manifests: readonly CorpusManifestV1[];
  batches: readonly EvalBatchV1[];
  exposures: readonly ExposureRecordV1[];
  revisions: readonly RevisionRecordV1[];
  reviews: readonly ReviewFileV1[];
}
export interface LedgerPort {
  read(): Promise<LedgerState>;
  /** Must reject existing paths: immutable manifests/batches, wx publication only. */
  create(kind: "manifest" | "batch", value: CorpusManifestV1 | EvalBatchV1): Promise<void>;
  /** Append only; never truncate or replace these two journals. */
  append(kind: "exposure" | "revision", value: ExposureRecordV1 | RevisionRecordV1): Promise<void>;
}
export function emptyLedger(): LedgerState {
  return { manifests: [], batches: [], exposures: [], revisions: [], reviews: [] };
}
export function createManifest(files: readonly CachedFile[]): CorpusManifestV1 {
  const body = {
    v: 1 as const,
    normalizeVersion: cacheVersions().normalizeVersion,
    files: [...files]
      .sort((a, b) => a.stamp.file.localeCompare(b.stamp.file))
      .map((f) => ({
        sessionId: f.header.id,
        pathHash: hash(f.stamp.file),
        size: f.stamp.size,
        mtimeMs: f.stamp.mtimeMs,
        lines: f.lines,
        lastEntryId: f.lastEntryId,
      })),
  };
  return { ...body, manifestHash: hash(JSON.stringify(body)) };
}
export function createBatch(
  lineage: string,
  manifestHash: string,
  turns: readonly Turn[],
  cutoffAt: number,
  since: number,
  until: number,
  createdAt: number,
): EvalBatchV1 {
  if (turns.some((t) => t.split !== "holdout")) throw new Error("batch requires holdout turns");
  const ordered = [...turns].sort((a, b) => turnKeyOf(a).localeCompare(turnKeyOf(b)));
  const turnKeys = ordered.map(turnKeyOf);
  if (new Set(turnKeys).size !== turnKeys.length) throw new Error("duplicate turn keys");
  return {
    v: 1,
    batchId: hash(lineage + turnKeys.join("\u0000")),
    lineage,
    manifestHash,
    cutoffAt,
    since,
    until,
    turnKeys,
    turnDigests: ordered.map((t) => t.digest),
    createdAt,
  };
}
export type LedgerKind = "manifest" | "batch" | "exposure" | "revision" | "review";
export type LedgerValue = CorpusManifestV1 | EvalBatchV1 | ExposureRecordV1 | RevisionRecordV1 | ReviewFileV1;
export function encodeLedger(value: LedgerValue): string {
  return JSON.stringify(value) + "\n";
}
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);
export function decodeLedger(kind: LedgerKind, text: string): LedgerValue | undefined {
  try {
    const v: unknown = JSON.parse(text);
    if (kind === "review") return parseReviewFile(v);
    if (!obj(v) || v["v"] !== 1) return undefined;
    if (kind === "manifest") {
      if (!hex(v["manifestHash"]) || !str(v["normalizeVersion"]) || !Array.isArray(v["files"])) return undefined;
      for (const f of v["files"])
        if (
          !obj(f) ||
          !str(f["sessionId"]) ||
          !hex(f["pathHash"]) ||
          ![f["size"], f["mtimeMs"], f["lines"]].every(num) ||
          typeof f["lastEntryId"] !== "string"
        )
          return undefined;
      const { manifestHash, ...body } = v;
      if (hash(JSON.stringify(body)) !== manifestHash) return undefined;
    } else {
      if (!str(v["lineage"])) return undefined;
      if (kind === "batch") {
        if (
          !hex(v["batchId"]) ||
          !hex(v["manifestHash"]) ||
          ![v["cutoffAt"], v["since"], v["until"], v["createdAt"]].every(num) ||
          !strings(v["turnKeys"]) ||
          !v["turnKeys"].every(hex) ||
          !strings(v["turnDigests"]) ||
          v["turnKeys"].length !== v["turnDigests"].length ||
          new Set(v["turnKeys"]).size !== v["turnKeys"].length ||
          hash(v["lineage"] + [...v["turnKeys"]].sort().join("\u0000")) !== v["batchId"]
        )
          return undefined;
      } else {
        if (!str(v["templateHash"])) return undefined;
        if (kind === "exposure") {
          if (!hex(v["batchId"]) || !num(v["at"]) || !["report", "review", "show"].includes(String(v["via"])))
            return undefined;
        } else if (
          !num(v["firstSeenAt"]) ||
          (v["gitCommitAt"] !== undefined && !num(v["gitCommitAt"])) ||
          !["catalog", "draft-file", "drafts-out"].includes(String(v["source"]))
        )
          return undefined;
      }
    }
    return v as unknown as LedgerValue;
  } catch {
    return undefined;
  }
}
