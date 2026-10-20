import { capExpertRefs } from "./types.js";
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
 *
 * consult A/B instrumentation plan (§5 P1a, review §8 #1): `experts`,
 * `dispatchMeta`, `schemaPreset` and `consults` are whitelisted below so a
 * crash-interrupted run's journal entry — and the terminal `aborted`
 * snapshot `interruptedFromJournal` seeds from it — both keep them. Leaving
 * `dispatchMeta` out would otherwise silently drop D3's resume-inherited
 * lane/packageId/abArm the moment a run restarts mid-flight, making the
 * analysis script misclassify real rework as `unenrolled`.
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
  "thinkingLevel",
  "consultIdentityPrediction",
  "label",
  "agentType",
  "taskPrompt",
  "worktree",
  "toolCounts",
  "stopRequestedAt",
  "stopCause",
  "timeoutReason",
  "timeoutPolicy",
  "error",
  "orphaned",
  "generation",
  "deadlineAt",
  "hardDeadlineAt",
  "overtime",
  "staleInputs",
  "sessionFile",
  "childExtensionMissing",
  "experts",
  "dispatchMeta",
  "schemaPreset",
  "consultOf",
  // Cache/thread plan §5.3 / R2-4: same persistence surfaces as other consult
  // diag. Tombstones intentionally omit these display-only facts (user ruling 2026-10-18).
  "consultCache",
  "consultThread",
  "consults",
  "external",
  // fabric-cross-session plan v3 §4.1 (S0): wake facts are run facts and ride every persistence surface; absent ⇒ not
  // copied (so a wake-off run's journal bytes never change). `wakeOrigin` is re-stripped of its claimToken in projectDiag.
  "wakeOrigin",
  "wakeLevel",
  "wakeExclusion",
  "inputAcceptedAt",
  "promptOutcome",
] as const satisfies readonly (keyof RunDiagnostics)[];

/**
 * plan v3 §4.1: `diag.wakeOrigin.trigger.claimToken` is a mailbox-internal secret (a memory-only field of the claimed
 * record) and must never reach a persisted entry. Returns the SAME object when there is nothing to strip.
 */
export function persistableWakeOrigin<T extends NonNullable<RunDiagnostics["wakeOrigin"]>>(origin: T): T {
  if (origin.trigger === undefined || !("claimToken" in origin.trigger)) return origin;
  const { claimToken: _claimToken, ...trigger } = origin.trigger;
  return { ...origin, trigger };
}

/**
 * The persistence form of a snapshot (terminal `subagent:run` entry): identical to the input — same reference —
 * unless `diag.wakeOrigin` (or the outcome's copy of it) still carries a `claimToken`, in which case only that token is
 * dropped. Wake-off runs never have a wakeOrigin ⇒ byte-identical, no clone.
 */
export function withoutWakeSecrets(snapshot: RunSnapshot): RunSnapshot {
  const dirty = (d: RunDiagnostics | undefined): boolean =>
    d?.wakeOrigin?.trigger !== undefined && "claimToken" in d.wakeOrigin.trigger;
  if (!dirty(snapshot.diag) && !dirty(snapshot.outcome?.diag)) return snapshot;
  const clean = (d: RunDiagnostics): RunDiagnostics =>
    d.wakeOrigin === undefined ? d : { ...d, wakeOrigin: persistableWakeOrigin(d.wakeOrigin) };
  return {
    ...snapshot,
    diag: clean(snapshot.diag),
    ...(snapshot.outcome === undefined ? {} : { outcome: { ...snapshot.outcome, diag: clean(snapshot.outcome.diag) } }),
  };
}

function projectDiag(diag: RunDiagnostics): RunDiagnostics {
  const out: Record<string, unknown> = {};
  for (const key of JOURNAL_DIAG_FIELDS) {
    const value = diag[key];
    if (value !== undefined) out[key] = value;
  }
  if (typeof diag.taskPrompt === "string" && diag.taskPrompt.length > JOURNAL_TASK_PROMPT_CAP)
    out["taskPrompt"] = diag.taskPrompt.slice(0, JOURNAL_TASK_PROMPT_CAP);
  // consult A/B instrumentation plan (review §8 ⚠️ item): re-apply the
  // `experts.refs` cap defensively here too — the real producer
  // (P1b's runtime adapter) lives outside core, so this is the journal's own
  // last-line guarantee that a persisted entry never carries more than
  // `EXPERTS_REFS_CAP` refs, independent of whatever `state-machine.ts`'s
  // `enqueued` branch already enforced on the live diag.
  if (diag.experts !== undefined) out["experts"] = { ...diag.experts, refs: capExpertRefs(diag.experts.refs) };
  if (diag.wakeOrigin !== undefined) out["wakeOrigin"] = persistableWakeOrigin(diag.wakeOrigin);
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
