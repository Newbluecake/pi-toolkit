import { isAbsolute, relative } from "node:path";
import type { Millis, RunDiagnostics, RunId, RunSnapshot } from "../core/types.js";
import { matchRunId, type ResolveTargetDeps } from "../service/resolve-target.js";

/**
 * consult (docs/dev/consult/plan.md §4.5): ExpertIndex — the reload-proof
 * view of "which finished runs are consultable". Rebuilt once per
 * `buildSessionStack` from the main session's prefetched `subagent:run`
 * entries (pi-free: plain data in, plain data out).
 */

/** A terminal, persisted, non-consult run the index knows about. */
export interface ExpertRecord {
  runId: RunId;
  /** Display only; never a matching key (labels repeat across reload generations). */
  label?: string;
  sessionFile: string;
  agentType: string;
  model?: { provider: string; id: string };
  status: "completed" | "failed" | "timed_out" | "aborted";
  contextPercent?: number;
  contextTokens?: number;
  /** The run's original task prompt, summarized (`summarizeExpertTask`); display only. */
  task?: string;
  updatedAt: Millis;
}

export type ResolveIdResult =
  { ok: true; record: ExpertRecord } | { ok: false; ambiguous?: readonly RunId[]; reason: string };

export interface ExpertIndex {
  /** Rebuild from the main session's prefetched entries (replaces wholesale). */
  rebuildFromEntries(entries: readonly unknown[]): void;
  /**
   * runId exact → unique prefix, with the *same implementation* resolve-target
   * uses (`matchRunId`, §6 C-8b) — the index feeds it a minimal
   * `ResolveTargetDeps` projected from its own records (only `knownIds()` is
   * reached from there; labels/tombstones are intentionally inert).
   */
  resolveId(ref: string): ResolveIdResult;
  /** Label exact match — returns ALL hits (the index spans reload generations). */
  findByLabel(label: string): readonly ExpertRecord[];
  /** All records (diagnostics / candidate listing). */
  list(): readonly ExpertRecord[];
}

/** Max characters of an expert's task summary shown to the asker (display only). */
export const EXPERT_TASK_SUMMARY_CHARS = 160;

/**
 * One-line summary of an expert's original task prompt for the asker's consult tool
 * description: whitespace collapsed, truncated to `max` code points with an ellipsis.
 * Undefined for missing/blank input.
 */
export function summarizeExpertTask(taskPrompt: unknown, max = EXPERT_TASK_SUMMARY_CHARS): string | undefined {
  if (typeof taskPrompt !== "string") return undefined;
  const flat = taskPrompt.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return undefined;
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * Structural "is this file inside `dir`" check. Used for the consult-run
 * exclusion (fork copies always live under the consult dir, expert sessions
 * never do — an unfakeable marker, plan §4.5) and for the fork-file deletion
 * guard in `wireConsult.onReaped`.
 */
export function isUnderDir(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function isSubagentRunEntry(entry: unknown): entry is { data: unknown } {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as { type?: unknown; customType?: unknown; data?: unknown };
  return e.type === "custom" && e.customType === "subagent:run" && "data" in e;
}

/** Narrow a persisted snapshot status to the terminal subset the index keeps. */
function terminalStatus(status: string): ExpertRecord["status"] | undefined {
  switch (status) {
    case "completed":
    case "failed":
    case "timed_out":
    case "aborted":
      return status;
    default:
      return undefined;
  }
}

function contextNumbers(diag: RunDiagnostics): { percent?: number; tokens?: number } {
  const usage = diag.contextUsage;
  return {
    ...(usage?.percent != null ? { percent: usage.percent } : {}),
    ...(usage?.tokens != null ? { tokens: usage.tokens } : {}),
  };
}

/** Project an ExpertRecord back to the minimal RunSnapshot shape matchRunId reads. */
function projectToSnapshot(record: ExpertRecord): RunSnapshot {
  const diag: RunDiagnostics = {
    createdAt: 0,
    phase: "settled",
    phaseEnteredAt: 0,
    pendingTools: 0,
    turns: 0,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
    ...(record.label !== undefined ? { label: record.label } : {}),
    sessionFile: record.sessionFile,
  };
  return {
    runId: record.runId,
    generation: 1,
    status: record.status,
    phase: "settled",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag,
    updatedAt: record.updatedAt,
  };
}

export function createExpertIndex(opts: { consultDir: string }): ExpertIndex {
  let records = new Map<RunId, ExpertRecord>();
  const byLabel = (label: string): ExpertRecord[] => [...records.values()].filter((r) => r.label === label);
  const candidatesFor = (handle: string): RunId[] =>
    [...records.keys()].filter((id) => id === handle || id.startsWith(handle));
  return {
    rebuildFromEntries(entries: readonly unknown[]): void {
      const next = new Map<RunId, ExpertRecord>();
      for (const entry of entries) {
        if (!isSubagentRunEntry(entry)) continue;
        const snap = entry.data as RunSnapshot | undefined;
        if (!snap || typeof snap.runId !== "string" || typeof snap.status !== "string") continue;
        const status = terminalStatus(snap.status);
        if (status === undefined) continue;
        const diag = snap.diag;
        const sessionFile = diag?.sessionFile;
        if (typeof sessionFile !== "string" || sessionFile.length === 0) continue;
        // Structural consult-run exclusion: a fork copy always lives under
        // the consult dir, an expert session never does. Applies to BOTH
        // index and live paths (the live caller filters with the same
        // `isUnderDir` predicate) — label prefixes are unreliable (user
        // forgeable, truncated at 36 codepoints), see plan §13 #11.
        if (isUnderDir(opts.consultDir, sessionFile)) continue;
        const ctx = diag ? contextNumbers(diag) : {};
        const task = summarizeExpertTask(diag?.taskPrompt);
        next.set(snap.runId, {
          runId: snap.runId,
          ...(diag?.label !== undefined ? { label: diag.label } : {}),
          sessionFile,
          agentType: diag?.agentType ?? "",
          status,
          ...(diag?.model !== undefined ? { model: diag.model } : {}),
          ...(ctx.percent !== undefined ? { contextPercent: ctx.percent } : {}),
          ...(ctx.tokens !== undefined ? { contextTokens: ctx.tokens } : {}),
          ...(task !== undefined ? { task } : {}),
          updatedAt: typeof snap.updatedAt === "number" ? snap.updatedAt : 0,
        });
      }
      records = next;
    },
    resolveId(ref: string): ResolveIdResult {
      const deps: ResolveTargetDeps = {
        records: () => [...records.values()].map(projectToSnapshot),
        liveSnapshots: [],
        labels: new Map(),
        tombstones: { list: () => [], get: () => undefined },
      };
      const matched = matchRunId(ref, deps);
      if (matched.runId) {
        const record = records.get(matched.runId);
        if (record) return { ok: true, record };
      }
      if (matched.ambiguous) {
        const ambiguous = candidatesFor(ref);
        return { ok: false, ambiguous, reason: `ambiguous run id: "${ref}" matches ${ambiguous.length} experts` };
      }
      return { ok: false, reason: `no indexed expert matches "${ref}"` };
    },
    findByLabel(label: string): readonly ExpertRecord[] {
      return byLabel(label);
    },
    list(): readonly ExpertRecord[] {
      return [...records.values()];
    },
  };
}
