import type {
  ErrorInfo,
  Millis,
  RestartInterruptedInfo,
  RunDiagnostics,
  RunId,
  RunJournalMark,
  RunOutcome,
  RunSnapshot,
  RunState,
  WorktreeDisposition,
} from "./types.js";

/**
 * run-persistence plan (docs/dev/subagent-run-persistence/plan.md) D3/D4/D7:
 * the pure half of the non-terminal run journal. Pi-free, no I/O, no timers.
 *
 * - `journalSnapshotFromState` — the slim whitelist projection written as a
 *   NON-terminal `subagent:run` entry (session_created / shutdown_flush).
 * - `interruptedFromJournal` — the seed-side mapping of such an entry to a
 *   TERMINAL `aborted` snapshot (J1: the in-memory store only ever holds
 *   terminal snapshots).
 */

/** D3: journal entries cap the dispatch prompt harder than terminal entries (TASK_PROMPT_CAP = 4096). */
export const JOURNAL_TASK_PROMPT_CAP = 1024;

/**
 * D3 whitelist: the only diag fields a journal entry carries. Everything else
 * (text/textFinal/thinkingText/toolHistory/currentTool/retry/compacting/
 * absorbedRunIds/contextSwitches/compactionFailures/exitFacts/finalLeafId/
 * persistStatus/deliveryKey/lastWarn/lastTurnStartAt/settledAt) is dropped;
 * the array-typed required fields (escalation/degraded/unkillable) are reset
 * to [].
 */
const JOURNAL_DIAG_FIELDS = [
  "createdAt",
  "enqueuedAt",
  "startedAt",
  "promptDispatchedAt",
  "phase",
  "phaseEnteredAt",
  "lastEventAt",
  "lastEventType",
  "pendingTools",
  "turns",
  "usage",
  "contextUsage",
  "model",
  "label",
  "agentType",
  "taskPrompt",
  "worktree",
  "toolCounts",
  "stopRequestedAt",
  "stopCause",
  "timeoutReason",
  "error",
  "orphaned",
  "generation",
  "deadlineAt",
  "hardDeadlineAt",
  "overtime",
  "staleInputs",
  "sessionFile",
  "childExtensionMissing",
] as const satisfies readonly (keyof RunDiagnostics)[];

function projectDiag(diag: RunDiagnostics): RunDiagnostics {
  const out: Record<string, unknown> = {};
  for (const key of JOURNAL_DIAG_FIELDS) {
    const value = diag[key];
    if (value !== undefined) out[key] = value;
  }
  if (typeof diag.taskPrompt === "string" && diag.taskPrompt.length > JOURNAL_TASK_PROMPT_CAP)
    out["taskPrompt"] = diag.taskPrompt.slice(0, JOURNAL_TASK_PROMPT_CAP);
  out["escalation"] = [];
  out["degraded"] = [];
  out["unkillable"] = [];
  return out as unknown as RunDiagnostics;
}

/** D3: the slim, outcome-free journal projection of a live (non-terminal) run state. */
export function journalSnapshotFromState(state: RunState, at: Millis, mark: RunJournalMark): RunSnapshot {
  return {
    runId: state.runId,
    generation: state.generation,
    status: state.status,
    phase: state.phase,
    deadlines: state.deadlines,
    diag: projectDiag(state.diag),
    updatedAt: at,
    ...(state.parentRunId === undefined ? {} : { parentRunId: state.parentRunId }),
    journal: {
      kind: mark.kind,
      ...(mark.shutdownReason === undefined ? {} : { shutdownReason: mark.shutdownReason }),
    },
  };
}

function isoOrRaw(at: Millis): string {
  return Number.isFinite(at) ? new Date(at).toISOString() : String(at);
}

/** D4/D7: model-facing explanation of a restart-interrupted run (English, same register as formatOutcome). */
export function restartInterruptedMessage(
  runId: RunId,
  info: RestartInterruptedInfo,
  worktree?: WorktreeDisposition,
): string {
  const cause = info.shutdownReason ?? "crash/kill";
  const base =
    `interrupted by a pi restart (${cause}): the run was still ${info.lastStatus} ` +
    `(phase ${info.lastPhase}) when last recorded at ${isoOrRaw(info.lastSeenAt)}; its final result was never recorded. ` +
    `The child session is intact — continue it with Agent({ resume: "${runId}", ... }).`;
  return worktree === undefined
    ? base
    : `${base} Its worktree changes may be uncommitted on disk — check /agent status for orphan worktrees before resuming.`;
}

/**
 * D4: map a non-terminal journal entry to a terminal `aborted` snapshot with
 * an outcome (E10: an outcome-less snapshot would read as "still running" and
 * make query.wait block until its deadline). `updatedAt` stays the last-seen
 * moment, never the restart moment. The output never carries `journal`.
 */
export function interruptedFromJournal(snapshot: RunSnapshot): RunSnapshot {
  const lastSeenAt = snapshot.updatedAt;
  const info: RestartInterruptedInfo = {
    lastStatus: snapshot.status,
    lastPhase: snapshot.phase,
    lastSeenAt,
    source: snapshot.journal?.kind ?? "session_created",
    ...(snapshot.journal?.shutdownReason === undefined ? {} : { shutdownReason: snapshot.journal.shutdownReason }),
  };
  const worktree: WorktreeDisposition | undefined =
    snapshot.diag.worktree === undefined
      ? undefined
      : snapshot.diag.worktree.state === "active"
        ? { state: "kept" }
        : snapshot.diag.worktree;
  const error: ErrorInfo = {
    kind: "aborted",
    retryable: false,
    message: restartInterruptedMessage(snapshot.runId, info, worktree),
  };
  const diag: RunDiagnostics = {
    ...snapshot.diag,
    phase: "settled",
    phaseEnteredAt: lastSeenAt,
    settledAt: lastSeenAt,
    stopCause: snapshot.diag.stopCause ?? "shutdown",
    error,
    restartInterrupted: info,
    ...(worktree === undefined ? {} : { worktree }),
  };
  const outcome: RunOutcome = {
    runId: snapshot.runId,
    status: "aborted",
    turns: diag.turns,
    durationMs: Math.max(0, lastSeenAt - snapshot.deadlines.enqueuedAt) || 0,
    ...(diag.usage === undefined ? {} : { usage: diag.usage }),
    error,
    diag,
  };
  return {
    runId: snapshot.runId,
    generation: snapshot.generation,
    status: "aborted",
    phase: "settled",
    deadlines: snapshot.deadlines,
    diag,
    outcome,
    updatedAt: lastSeenAt,
    ...(snapshot.parentRunId === undefined ? {} : { parentRunId: snapshot.parentRunId }),
  };
}
