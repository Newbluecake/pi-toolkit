import { existsSync, statSync } from "node:fs";
import type { DispatchMeta } from "../core/dispatch-meta.js";
import type { RunId, RunSnapshot, RunStatus, TimeoutPolicy } from "../core/types.js";
import type { Tombstone, TombstoneStore } from "./tombstone.js";

// RPC intentionally keeps exact-string semantics. This resolver is only for
// the model-facing tools and status/resume paths; src/rpc/* must not use it.

export interface TargetLabel {
  readonly runId: RunId;
}
export interface ResumeCandidate {
  readonly label: string;
  readonly runId: RunId;
  readonly status: RunStatus | "terminal";
  readonly ageMinutes: number;
}
export interface ResolveTargetDeps {
  labels: ReadonlyMap<string, TargetLabel>;
  liveSnapshots: readonly RunSnapshot[] | (() => readonly RunSnapshot[]);
  records: readonly RunSnapshot[] | (() => readonly RunSnapshot[]);
  tombstones: Pick<TombstoneStore, "list" | "get">;
  now?: () => number;
}
export type ResolveRunResult =
  | { readonly ok: true; readonly runId: RunId }
  | { readonly ok: false; readonly error: string; readonly candidates: readonly ResumeCandidate[] };
export type ResolveResumeResult =
  | {
      readonly ok: true;
      readonly runId: RunId;
      readonly sessionFile: string;
      /**
       * Timeout-policy of the resumed run (agent-explicit-timeout-extend plan §2.7):
       * `snapshotWithSessionFile(...)?.diag.timeoutPolicy ?? tombstones.get(runId)?.timeoutPolicy`.
       * Absent for old entries lacking the field. Type-only in this batch;
       * `resolveResumeTarget` fills it in P1.
       */
      readonly timeoutPolicy?: TimeoutPolicy;
      /**
       * consult A/B instrumentation plan (§5 P1b, D3 recommendation): the
       * resumed run's `diag.dispatchMeta` — unlike `timeoutPolicy`, sourced
       * from a terminal snapshot ONLY (never the tombstone: tombstones are a
       * TTL-bounded last-resort view and are deliberately not extended with
       * analytics fields). Absent for old entries lacking the field.
       */
      readonly dispatchMeta?: DispatchMeta;
      /**
       * The resumed run's display-only `diag.title` (same terminal-snapshot-only
       * source rule as `dispatchMeta`), so a resume keeps showing the original
       * description as its title. Absent for old entries / runs without one.
       */
      readonly title?: string;
      /**
       * fabric-cross-session plan §3.3 L4: the resumed run's FINAL effective causal level (`prevFinal`) —
       * terminal snapshot first, then the tombstone (which S0 extended with it). Absent for runs that never had one.
       */
      readonly wakeLevel?: number;
    }
  | { readonly ok: false; readonly error: string; readonly candidates: readonly ResumeCandidate[] };

const TERMINAL = new Set<RunStatus>(["completed", "failed", "timed_out", "aborted"]);

function values<T>(source: readonly T[] | (() => readonly T[])): readonly T[] {
  return typeof source === "function" ? source() : source;
}
function oneLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}
function sourceSnapshots(deps: ResolveTargetDeps): RunSnapshot[] {
  const merged = new Map<RunId, RunSnapshot>();
  // Records are the durable, long-lived view. Live snapshots win when both
  // views contain an id because they are the freshest view of that run.
  for (const snapshot of values(deps.records)) merged.set(snapshot.runId, snapshot);
  for (const snapshot of values(deps.liveSnapshots)) merged.set(snapshot.runId, snapshot);
  return [...merged.values()];
}
function snapshotWithSessionFile(deps: ResolveTargetDeps, runId: RunId): RunSnapshot | undefined {
  // Keep the source ordering explicit: a live terminal snapshot is preferred,
  // then the long-lived terminal record, then the TTL-bounded tombstone.
  const live = values(deps.liveSnapshots)
    .filter((snapshot) => snapshot.runId === runId && TERMINAL.has(snapshot.status) && snapshot.diag.sessionFile)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (live) return live;
  return values(deps.records)
    .filter((snapshot) => snapshot.runId === runId && TERMINAL.has(snapshot.status) && snapshot.diag.sessionFile)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}
function tombstoneList(deps: ResolveTargetDeps): readonly Tombstone[] {
  return deps.tombstones.list();
}
function knownIds(deps: ResolveTargetDeps): Set<RunId> {
  const ids = new Set<RunId>(sourceSnapshots(deps).map((snapshot) => snapshot.runId));
  for (const tombstone of tombstoneList(deps)) ids.add(tombstone.runId);
  return ids;
}
function labelsByRunId(deps: ResolveTargetDeps): Map<RunId, string> {
  const labels = new Map<RunId, string>();
  for (const [label, target] of deps.labels) if (!labels.has(target.runId)) labels.set(target.runId, label);
  return labels;
}

/** Label match when the process-local index misses: scan the snapshots' own `diag.label`.
 * The label index never survives a process restart (spawn-service only writes it in
 * `spawn()`), but the seeded durable snapshots carry their labels — without this fallback a
 * by-label resolve after a restart always missed while the error's own candidate list printed
 * that very label (2026-10 restart-resume incident: `resume target not found: sp3-0a5ad8.
 * Resumable targets: [sp3-0a5ad8 → r_0C5TWJ0D …]`). Latest `updatedAt` wins on collisions,
 * mirroring spawn-time label-repoint semantics. */
function labelFallback(handle: string, deps: ResolveTargetDeps): RunId | undefined {
  let best: RunSnapshot | undefined;
  for (const snapshot of sourceSnapshots(deps)) {
    if (snapshot.diag.label !== handle) continue;
    if (best === undefined || snapshot.updatedAt > best.updatedAt) best = snapshot;
  }
  return best?.runId;
}
function candidateList(deps: ResolveTargetDeps): readonly ResumeCandidate[] {
  const now = deps.now?.() ?? Date.now();
  const byId = new Map<RunId, ResumeCandidate>();
  const labels = labelsByRunId(deps);
  for (const runId of knownIds(deps)) {
    const snapshot = snapshotWithSessionFile(deps, runId);
    if (!snapshot) continue;
    byId.set(runId, {
      label: oneLine(snapshot.diag.label ?? labels.get(runId) ?? runId),
      runId,
      status: snapshot.status,
      ageMinutes: Math.floor(Math.max(0, now - snapshot.updatedAt) / 60_000),
    });
  }
  for (const tombstone of tombstoneList(deps)) {
    if (byId.has(tombstone.runId)) continue;
    byId.set(tombstone.runId, {
      label: oneLine(labels.get(tombstone.runId) ?? tombstone.runId),
      runId: tombstone.runId,
      status: "terminal",
      ageMinutes: Math.floor(Math.max(0, now - tombstone.createdAt) / 60_000),
    });
  }
  return [...byId.values()].slice(0, 10);
}
function formatCandidates(candidates: readonly ResumeCandidate[]): string {
  return candidates.length
    ? candidates
        .map(
          (candidate) => `${candidate.label} → ${candidate.runId} (${candidate.status}, ${candidate.ageMinutes}m ago)`,
        )
        .join(", ")
    : "none";
}
function resumeError(handle: string, candidates: readonly ResumeCandidate[]): string {
  return `resume target not found: ${oneLine(handle)}. Resumable targets: [${formatCandidates(candidates)}]`;
}
/**
 * Two-level id match: exact run id, then unique prefix. Exported for the
 * consult ExpertIndex (plan §4.5 / §6 C-8b, frozen surface) so the index
 * resolves ids with *this* implementation instead of a look-alike that can
 * drift; it feeds a minimal `ResolveTargetDeps` whose `records` are its own
 * projected snapshots (only `knownIds()` is reached from here — no label /
 * candidate logic).
 */
export function matchRunId(handle: string, deps: ResolveTargetDeps): { runId?: RunId; ambiguous: boolean } {
  const ids = knownIds(deps);
  if (ids.has(handle)) return { runId: handle, ambiguous: false };
  const prefixes = [...ids].filter((runId) => runId.startsWith(handle));
  if (prefixes.length === 1) {
    const runId = prefixes[0];
    if (runId) return { runId, ambiguous: false };
  }
  return { ambiguous: prefixes.length > 1 };
}

/** Resolve an id, its unique prefix, or finally a registered label. */
export function resolveRunId(handle: string, deps: ResolveTargetDeps): ResolveRunResult {
  const candidates = candidateList(deps);
  const matched = matchRunId(handle, deps);
  if (matched.runId) return { ok: true, runId: matched.runId };
  if (matched.ambiguous)
    return {
      ok: false,
      error: `ambiguous run target: ${oneLine(handle)}. Candidates: [${formatCandidates(candidates)}]`,
      candidates,
    };
  const labelTarget = deps.labels.get(handle);
  // A just-started run may not have emitted its first live snapshot yet, but
  // its label registration is already authoritative for the running hint.
  if (labelTarget) return { ok: true, runId: labelTarget.runId };
  const seeded = labelFallback(handle, deps);
  if (seeded !== undefined) return { ok: true, runId: seeded };
  return {
    ok: false,
    error: `run target not found: ${oneLine(handle)}. Candidates: [${formatCandidates(candidates)}]`,
    candidates,
  };
}

/**
 * Resolve a resumable terminal run and validate its canonical session file.
 * A caller-provided path is never accepted: only a run id/prefix/label can
 * reach a session file obtained from a live/terminal snapshot or tombstone.
 */
export function resolveResumeTarget(handle: string, deps: ResolveTargetDeps): ResolveResumeResult {
  const candidates = candidateList(deps);
  const matched = matchRunId(handle, deps);
  let runId = matched.runId;
  if (!runId && !matched.ambiguous) runId = deps.labels.get(handle)?.runId ?? labelFallback(handle, deps);
  if (!runId || matched.ambiguous) return { ok: false, error: resumeError(handle, candidates), candidates };

  const sessionFile = snapshotWithSessionFile(deps, runId)?.diag.sessionFile ?? deps.tombstones.get(runId)?.sessionFile;
  if (!sessionFile || !existsSync(sessionFile) || !statIsFile(sessionFile))
    return { ok: false, error: resumeError(handle, candidates), candidates };
  // §2.7：R-inherit 的继承源——终态快照（live → durable record）优先，快照
  // 被逐出后靠 tombstone；旧条目缺字段 ⇒ undefined，解析式落第 ③ 项（按请求形状）。
  const timeoutPolicy =
    snapshotWithSessionFile(deps, runId)?.diag.timeoutPolicy ?? deps.tombstones.get(runId)?.timeoutPolicy;
  // consult A/B 计划（§5 P1b，D3 推荐）：dispatchMeta 的继承源只取终态快照的
  // diag（tombstone 不扩展 —— 它是 TTL 兜底视图，不带分析字段）。
  const dispatchMeta = snapshotWithSessionFile(deps, runId)?.diag.dispatchMeta;
  const title = snapshotWithSessionFile(deps, runId)?.diag.title;
  const wakeLevel = snapshotWithSessionFile(deps, runId)?.diag.wakeLevel ?? deps.tombstones.get(runId)?.wakeLevel;
  return {
    ok: true,
    runId,
    sessionFile,
    ...(timeoutPolicy === undefined ? {} : { timeoutPolicy }),
    ...(dispatchMeta === undefined ? {} : { dispatchMeta }),
    ...(title === undefined ? {} : { title }),
    ...(wakeLevel === undefined ? {} : { wakeLevel }),
  };
}
function statIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
