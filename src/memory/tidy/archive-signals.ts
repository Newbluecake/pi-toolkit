import type { MemoryStatus } from "../contracts.js";
import type { TidySnapshotFile } from "./snapshot.js";

export type ArchiveSignal = "S1" | "S2" | "S3" | "S4" | "S5" | "T";
export interface ArchiveSignalOptions {
  now?: Date | number;
  olderThanDays?: number;
  triage?: boolean;
  triageConfidence?: number;
  orphan?: boolean;
  isIndex?: boolean;
}
export interface ArchiveSignalResult {
  signals: readonly ArchiveSignal[];
  suggested: boolean;
  eligible: boolean;
  reason: string;
}
export interface ArchiveCandidate {
  file: TidySnapshotFile;
  signal: ArchiveSignalResult;
  conflict: boolean;
}

const DATE_RE = /(?:^|[^\d])(20\d{2})[-_](\d{2})[-_](\d{2})(?:[^\d]|$)/u;
const COMPLETION_RE =
  /(?:\b(?:done|completed|complete|superseded|replaced|obsolete|no longer needed|已完成|已被取代|已废弃)\b)/iu;
function dateValue(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.match(DATE_RE);
  if (!match) return undefined;
  const value = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(value) ? value : undefined;
}
function statusOf(file: TidySnapshotFile): MemoryStatus | undefined {
  return file.meta.status;
}
function isOld(file: TidySnapshotFile, now: number, days: number): boolean {
  const fromMeta = dateValue(file.meta.updated);
  const fromName = dateValue(file.name);
  const newest = Math.max(fromMeta ?? -Infinity, fromName ?? -Infinity);
  if (!Number.isFinite(newest)) return false;
  return now - newest >= days * 86_400_000;
}

/** Deterministic, explainable archive signals; mtime is deliberately ignored. */
export function archiveSignals(file: TidySnapshotFile, options: ArchiveSignalOptions = {}): ArchiveSignalResult {
  // Callers should provide the command's captured clock value. The
  // deterministic zero fallback keeps this module a pure function in tests.
  const now = options.now instanceof Date ? options.now.getTime() : (options.now ?? 0);
  const days = options.olderThanDays ?? 180;
  const signals: ArchiveSignal[] = [];
  if (statusOf(file) === "archived") signals.push("S1");
  if (statusOf(file) === "stale") signals.push("S2");
  if (isOld(file, now, days)) signals.push("S3");
  if (COMPLETION_RE.test(file.body)) signals.push("S4");
  if (options.orphan) signals.push("S5");
  if (options.triage && (options.triageConfidence ?? 0) >= 0.9) signals.push("T");
  // The index is rendered from the memory layout rather than stored as a
  // separate top-level file. Keep core/primary/pin exclusions driven by the
  // existing snapshot metadata and caller classification.
  const excluded = file.name === "core.md" || file.isPrimaryCore || file.meta.pin || options.isIndex;
  const eligible = !excluded && signals.length > 0;
  const suggested = eligible && !signals.includes("S5") && (signals.includes("S1") || signals.includes("T"));
  const reason = signals.length === 0 ? "no deterministic archive signal" : signals.join(" ");
  return { signals, suggested, eligible, reason };
}

export function selectArchiveCandidates(
  files: readonly TidySnapshotFile[],
  options: ArchiveSignalOptions & { conflicts?: ReadonlySet<string> } = {},
): readonly ArchiveCandidate[] {
  return files
    .map((file) => ({
      file,
      signal: archiveSignals(file, options),
      conflict: options.conflicts?.has(file.name) ?? false,
    }))
    .filter(({ signal }) => signal.eligible);
}
