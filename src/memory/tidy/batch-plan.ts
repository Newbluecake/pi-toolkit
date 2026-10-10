import { BATCH_MAX_FILES } from "../contracts.js";
import { TIDY_SCHEMA } from "../contracts.js";

export interface BatchCandidate {
  name: string;
  body?: string;
  size?: number;
  bodyBytes?: number;
  /** Optional stable family key. Candidates without one use the k1 prefix. */
  k1?: string;
  [key: string]: unknown;
}
export interface PlannedBatch<T extends BatchCandidate = BatchCandidate> {
  index: number;
  family: string;
  files: readonly T[];
  bytes: number;
  otherNamesBytes: number;
}
export type BatchReportReason = "oversized" | "file-limit" | "invalid-size";
export interface BatchReport<T extends BatchCandidate = BatchCandidate> {
  candidate: T;
  reason: BatchReportReason;
  bytes: number;
}
export interface BatchPlan<T extends BatchCandidate = BatchCandidate> {
  batches: readonly PlannedBatch<T>[];
  reported: readonly BatchReport<T>[];
  capBytes: number;
  maxFiles: number;
}

export const OVERHEAD_FLOOR_BYTES = 0;
export const TIDY_SCHEMA_BYTES = Buffer.byteLength(JSON.stringify(TIDY_SCHEMA), "utf8");
export const overheadFloorBytes = OVERHEAD_FLOOR_BYTES + TIDY_SCHEMA_BYTES;

export interface HeadroomModel {
  contextWindow: number;
  maxTokens: number;
}
export interface HeadroomInput {
  model: HeadroomModel;
  overheadBytes: number;
  bytesPerToken?: number;
}
/** Bytes available for the input after reserving the model's output window. */
export function headroomBytes(input: HeadroomInput): number;
export function headroomBytes(model: HeadroomModel, overheadBytes: number, bytesPerToken?: number): number;
export function headroomBytes(
  inputOrModel: HeadroomInput | HeadroomModel,
  overheadArg?: number,
  bytesPerToken = 2,
): number {
  const nested = "model" in inputOrModel;
  const direct = inputOrModel as HeadroomModel & { overheadBytes?: number; bytesPerToken?: number };
  const model = nested ? inputOrModel.model : inputOrModel;
  const overhead = nested ? inputOrModel.overheadBytes : (overheadArg ?? direct.overheadBytes ?? 0);
  const bpt = nested ? (inputOrModel.bytesPerToken ?? 2) : (direct.bytesPerToken ?? bytesPerToken);
  if (
    !Number.isFinite(model.contextWindow) ||
    !Number.isFinite(model.maxTokens) ||
    !Number.isFinite(overhead) ||
    !Number.isFinite(bpt) ||
    bpt <= 0
  )
    return 0;
  return Math.max(0, Math.floor((model.contextWindow - model.maxTokens) * bpt - overhead));
}

export interface PlanBatchesOptions {
  targetBytes?: number;
  maxInputBytes?: number;
  /** Direct post-overhead cap aliases useful to pure callers/tests. */
  capBytes?: number;
  budgetBytes?: number;
  /** Measured full dispatch overhead; the schema floor is always included. */
  overheadBytes?: number;
  headroomBytes?: number;
  maxFiles?: number;
  /** Files at or above this size are isolated in their own batch. */
  topicMaxBytes?: number;
  otherNamesBytes?: number;
}
function byteLength(candidate: BatchCandidate): number {
  if (typeof candidate.size === "number") return candidate.size;
  if (typeof candidate.bodyBytes === "number") return candidate.bodyBytes;
  return typeof candidate.body === "string" ? Buffer.byteLength(candidate.body, "utf8") : NaN;
}
function familyOf(candidate: BatchCandidate): string {
  if (typeof candidate.k1 === "string" && candidate.k1.length > 0) return candidate.k1;
  // k1 groups are intentionally conservative: a leading topic stem is the
  // stable grouping key, while the complete filename remains the sort key.
  return candidate.name.split(/[._-]/u, 1)[0] ?? candidate.name;
}
function compareName(a: BatchCandidate, b: BatchCandidate): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Deterministic family-grouped next-fit packing. No candidate is silently lost. */
export function planBatches<T extends BatchCandidate>(
  candidates: readonly T[],
  options: PlanBatchesOptions,
): BatchPlan<T> {
  const maxFiles = Math.max(0, Math.min(BATCH_MAX_FILES, options.maxFiles ?? BATCH_MAX_FILES));
  const directCap = options.capBytes ?? options.budgetBytes;
  const target = Number.isFinite(options.targetBytes)
    ? Math.max(0, Math.floor(options.targetBytes as number))
    : Number.isFinite(directCap)
      ? Math.max(0, Math.floor(directCap as number))
      : Number.POSITIVE_INFINITY;
  const maxInput = Number.isFinite(options.maxInputBytes)
    ? Math.max(0, Math.floor(options.maxInputBytes as number))
    : Number.POSITIVE_INFINITY;
  // `headroomBytes` already represents the post-overhead input allowance.
  // The overhead floor is used by callers when obtaining that measurement;
  // never subtract it twice here.
  const computedHeadroom = options.headroomBytes ?? Number.POSITIVE_INFINITY;
  const capBytes = Math.max(0, Math.min(target, maxInput, computedHeadroom));
  const sorted = [...candidates].sort((a, b) => {
    const left = familyOf(a);
    const right = familyOf(b);
    const family = left < right ? -1 : left > right ? 1 : 0;
    return family || compareName(a, b);
  });
  const reported: BatchReport<T>[] = [];
  const batches: PlannedBatch<T>[] = [];
  const groups = new Map<string, T[]>();
  for (const candidate of sorted) {
    const size = byteLength(candidate);
    if (!Number.isFinite(size) || size < 0) {
      reported.push({ candidate, reason: "invalid-size", bytes: 0 });
    } else if (size > capBytes) {
      reported.push({ candidate, reason: "oversized", bytes: size });
    } else {
      const list = groups.get(familyOf(candidate)) ?? [];
      list.push(candidate);
      groups.set(familyOf(candidate), list);
    }
  }
  const namesCap = Math.max(0, options.otherNamesBytes ?? 4 * 1024);
  const topicMaxBytes = Number.isFinite(options.topicMaxBytes)
    ? Math.max(0, options.topicMaxBytes as number)
    : Number.POSITIVE_INFINITY;
  for (const [family, group] of groups) {
    let current: T[] = [];
    let bytes = 0;
    let namesBytes = 0;
    const flush = (): void => {
      if (current.length === 0) return;
      batches.push({ index: batches.length + 1, family, files: current, bytes, otherNamesBytes: namesBytes });
      current = [];
      bytes = 0;
      namesBytes = 0;
    };
    for (const candidate of group) {
      const size = byteLength(candidate);
      if (maxFiles === 0) {
        reported.push({ candidate, reason: "file-limit", bytes: size });
        continue;
      }
      const nameBytes = Buffer.byteLength(candidate.name, "utf8");
      const isolated = size >= topicMaxBytes;
      const wouldExceed =
        current.length > 0 &&
        (isolated || current.length >= maxFiles || bytes + size > capBytes || namesBytes + nameBytes > namesCap);
      if (wouldExceed) flush();
      if (nameBytes > namesCap && current.length === 0) {
        // A name by itself cannot fit the bookkeeping budget; report rather
        // than making a batch that violates the hard bound.
        reported.push({ candidate, reason: "file-limit", bytes: size });
        continue;
      }
      current.push(candidate);
      bytes += size;
      namesBytes += nameBytes;
      // A topic-sized file must not share a batch with any other file.
      if (isolated) flush();
    }
    flush();
  }
  return { batches, reported, capBytes, maxFiles };
}

export const packBatches = planBatches;
