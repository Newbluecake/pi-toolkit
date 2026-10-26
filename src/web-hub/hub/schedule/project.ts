/**
 * scheduled-reports plan r3 §5.6 (H1) — projecting one session's `ScheduleStateFile` (S1's
 * validated read) onto the S0-frozen `ScheduleSessionProjectionWire`: task definitions with
 * defHash / executable / pendingApproval / hub-computed nextAt (the SHARED cron core, in the
 * task's own tz), totals, most-recent-first runs with the §7.1 Feishu display vocabulary, and
 * droppedReports. Pure: no IO beyond the compiled-when math, no clock reads (`now` is injected).
 */
import { compileTask } from "../../../schedule/core/occurrence.js";
import { nextOccurrence } from "../../../schedule/core/cron.js";
import {
  defHash,
  isExecutable,
  isPendingApproval,
  reportIdOf,
  SCHED_REPORT_MAX_AGE_MS,
  type RunRecord,
  type ScheduleStateFile,
  type ScheduleTask,
} from "../../../schedule/core/spec.js";
import type {
  ScheduleFeishuDisplay,
  ScheduleReceiptState,
  ScheduleRunProjectionWire,
  SchedulesPayloadWire,
  ScheduleSessionProjectionWire,
  ScheduleTaskProjectionWire,
} from "../../protocol/schedule.js";

export interface ReceiptView {
  state: ScheduleReceiptState;
  at: number;
}

/** §7.1 状态区分 — the bot halves are fed by the Feishu integration (`botState`). */
export interface BotStatus {
  configured: boolean;
  open: boolean;
  installedAt?: number;
}

export interface ProjectDeps {
  now: number;
  receipts: ReadonlyMap<string, ReceiptView>;
  bot: BotStatus;
  /**
   * #61: the live confirm offer for (session, task, defHash), or undefined. The caller (service)
   * enforces online ∧ hash-match ∧ unexpired; project only gates on `pendingApproval`.
   */
  offerOf?: (sessionId: string, taskId: string, defHash: string) => { offerId: string; expiresAt: number } | undefined;
  /** Test seam / horizon override (defaults to the spec's 400-day horizon). */
  nextHorizonMs?: number;
}

/**
 * §7.1 状态区分. A pending INDEX entry is a concrete undelivered report — its receipt, then its
 * 24h window, then bot capability decide. Without an entry the run is historical: a known
 * receipt still shows its state; a never-configured bot shows `n/a` (permanent, never delivered);
 * a run past its window shows `expired`; a never-pushing run (task.feishu false / unfinished)
 * shows `none`. `waiting` without an entry is the disclosed residual (entry cleaned by the agent
 * after a receipt this hub never learned).
 */
const feishuOf = (run: RunRecord, state: ScheduleStateFile, deps: ProjectDeps): ScheduleFeishuDisplay => {
  const pending = state.pendingReports.find((p) => p.runKey === run.runKey);
  if (pending !== undefined) {
    const receipt = deps.receipts.get(pending.reportId);
    if (receipt !== undefined) return receipt.state;
    if (deps.now >= pending.expiresAt) return "expired";
    return deps.bot.configured ? "waiting" : "n/a";
  }
  // No index entry: a receipt may still be known (delivered then confirmed + removed).
  const receipt = deps.receipts.get(reportIdOf(state.sessionId, run.runKey));
  if (receipt !== undefined) return receipt.state;
  const taskFeishu = state.tasks.find((t) => t.id === run.taskId)?.feishu === true;
  if (run.endedAt === undefined || !taskFeishu) return "none";
  if (!deps.bot.configured) return "n/a";
  if (deps.now >= run.endedAt + SCHED_REPORT_MAX_AGE_MS) return "expired";
  return "waiting";
};

function taskProjection(task: ScheduleTask, state: ScheduleStateFile, deps: ProjectDeps): ScheduleTaskProjectionWire {
  const hash = defHash(task);
  const occ = state.occ[task.id];
  const compiled = compileTask(task);
  let nextAt: number | undefined;
  let degraded: "never" | undefined;
  if (task.enabled && compiled !== undefined) {
    nextAt = nextOccurrence(compiled, deps.now, {
      ...(deps.nextHorizonMs === undefined ? {} : { horizonMs: deps.nextHorizonMs }),
    });
    if (nextAt === undefined) degraded = "never";
  } else if (task.enabled && compiled === undefined) {
    degraded = "never";
  }
  const pendingApproval = isPendingApproval(task);
  const offer = pendingApproval ? deps.offerOf?.(state.sessionId, task.id, hash) : undefined;
  return {
    task,
    defHash: hash,
    executable: isExecutable(task),
    pendingApproval,
    ...(nextAt === undefined ? {} : { nextAt }),
    ...(degraded === undefined ? {} : { degraded }),
    totals: {
      fired: occ?.firedTotal ?? 0,
      missed: occ?.missedTotal ?? 0,
      skipped: occ?.skippedTotal ?? 0,
      manual: state.manualTotal[task.id] ?? 0,
    },
    ...(offer === undefined ? {} : { offer: { offerId: offer.offerId, expiresAt: offer.expiresAt } }),
  };
}

function runProjection(run: RunRecord, state: ScheduleStateFile, deps: ProjectDeps): ScheduleRunProjectionWire {
  return {
    runKey: run.runKey,
    taskId: run.taskId,
    kind: run.kind,
    form: run.form,
    scheduledAt: run.scheduledAt,
    state: run.state,
    ...(run.reason === undefined ? {} : { reason: run.reason }),
    ...(run.runId === undefined ? {} : { runId: run.runId }),
    startedAt: run.startedAt,
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
    ...(run.reportFile === undefined ? {} : { reportFile: run.reportFile }),
    feishu: feishuOf(run, state, deps),
  };
}

export function projectSession(state: ScheduleStateFile, deps: ProjectDeps): ScheduleSessionProjectionWire {
  const runs = [...state.runs].sort((a, b) => b.startedAt - a.startedAt).map((r) => runProjection(r, state, deps));
  return {
    sessionId: state.sessionId,
    rev: state.rev,
    tasks: state.tasks.map((t) => taskProjection(t, state, deps)),
    runs,
    droppedReports: state.reportStats.droppedIndexCap,
  };
}

export function projectPayload(sessions: readonly ScheduleStateFile[], deps: ProjectDeps): SchedulesPayloadWire {
  return { sessions: sessions.map((s) => projectSession(s, deps)) };
}
