/**
 * Scheduled tasks — shared plain-text rendering (A3): the `schedule` tool, `/schedule`, the
 * `pi_schedules` prompt section and the digest all speak through these helpers so a task reads the
 * same everywhere. Pure — no IO, no pi. UI language split (AGENTS.md): compact markers are English
 * tokens; prose aimed at the user lives with the callers.
 */
import { compileWhen, formatLocal, parseCron } from "../core/cron.js";
import { absoluteReportPath, type ReportLocation } from "./result-reference.js";
import {
  displayTz,
  defHash,
  isTerminalRunState,
  type OccState,
  type RunRecord,
  type ScheduleTask,
  type StoredWhen,
} from "../core/spec.js";

export function whenText(when: StoredWhen): string {
  if (when.kind === "every")
    return `every ${when.everyMs / 1000}s · anchor ${new Date(when.anchorAt).toISOString()} · UTC`;
  if (when.kind === "cron") {
    const strict = parseCron(when.expr, { strictSteps: true });
    return `cron "${when.expr}" ${when.tz}${!strict.ok && strict.error.includes(" exceeds ") ? ` · legacy-step: ${strict.error}` : ""}`;
  }
  return `once ${when.at} ${when.tz}`;
}

/** Local wall time of `t` in the task's tz (`YYYY-MM-DD HH:mm`), ISO fallback if the tz cannot compile. */
export function localTime(when: StoredWhen, t: number): string {
  const c = compileWhen(when);
  return c.ok ? `${formatLocal(c.when, t)} ${displayTz(when)}` : new Date(t).toISOString();
}

/** UI-derived flags: only `paused` (approval was removed — schedule-auto-approve r2). */
export function taskFlags(task: ScheduleTask): string[] {
  const out: string[] = [];
  if (!task.enabled) out.push("paused");
  return out;
}

export function taskLine(task: ScheduleTask, extra?: { next?: number | undefined }): string {
  const flags = taskFlags(task);
  const parts = [
    `${task.id} "${task.name}"`,
    whenText(task.when),
    task.form,
    ...(task.feishu ? ["feishu"] : []),
    ...flags,
    ...(extra?.next !== undefined ? [`next ${localTime(task.when, extra.next)}`] : []),
  ];
  return parts.join(" · ");
}

export function taskDetail(task: ScheduleTask, occ?: OccState, manual?: number): string[] {
  const hash = defHash(task);
  const lines = [
    `${task.id} "${task.name}" · ${task.form}${task.enabled ? "" : " · paused"}`,
    `when: ${whenText(task.when)}`,
    `feishu: ${task.feishu ? "yes" : "no"}`,
    `cwd: ${task.ownerCwd}`,
  ];
  if (task.bg !== undefined) {
    const b = task.bg;
    lines.push(
      `type: ${b.type} · model: ${b.model === undefined ? "(default)" : `${b.model.provider}/${b.model.id}`}` +
        ` · thinking: ${b.thinking ?? "(default)"} · timeout: ${b.timeoutS}s`,
      `${b.consultMain ? "consultMain: yes (legacy, ignored) · " : ""}handoff: ${b.handoff ? "yes" : "no"}` +
        ` · isolation: ${b.isolation ?? "none"}`,
    );
  }
  lines.push(
    `defHash: ${hash}`,
    `created: ${task.createdBy} via ${task.createdVia}`,
    "prompt:",
    ...task.prompt.split("\n").map((l) => `  ${l}`),
  );
  if (occ !== undefined)
    lines.push(
      `totals: fired ${occ.firedTotal} · missed ${occ.missedTotal} · skipped ${occ.skippedTotal}` +
        (manual === undefined ? "" : ` · manual ${manual}`),
    );
  return lines;
}

/** One-line meaning of a dropped run's reason (English tokens — shared by the tool and the command). */
const DROPPED_NOTE: Readonly<Record<string, string>> = {
  coalesced: "replaced by a newer run of the same task while queued",
  "owner-closed": "the owner session closed before it was sent",
  capability: "this pi cannot be triggered by scheduled messages",
  "capability-unknown": "queued over 30 min, pi trigger capability unconfirmed",
  "start-timeout": "the trigger never started within 60 s",
  "task-changed": "the task was paused, changed or deleted while queued; not sent",
};

export function runLine(run: RunRecord, when?: StoredWhen, location?: ReportLocation): string {
  const report = absoluteReportPath(location, run.reportFile);
  const at = when === undefined ? new Date(run.scheduledAt).toISOString() : localTime(when, run.scheduledAt);
  const end = run.endedAt !== undefined && isTerminalRunState(run.state) ? "" : " (in progress)";
  return [
    `${at}`,
    run.kind,
    ...(run.catchUp === undefined ? [] : [`catch-up ×${run.catchUp.dueCount}`, catchUpText(run)]),
    `${run.state}${run.reason ? `(${run.reason})` : ""}${end}`,
    ...(run.state === "dropped" && run.reason !== undefined && DROPPED_NOTE[run.reason] !== undefined
      ? [DROPPED_NOTE[run.reason]!]
      : []),
    ...(run.runId ? [`run ${run.runId}`] : []),
    ...(report === undefined ? [] : [`report ${report}`]),
    ...(run.note === "unverified" ? ["note unverified"] : []),
  ].join(" · ");
}

/** The durable run is the only source: both executors/report/history consume the same window. */
export function catchUpText(run: RunRecord): string {
  const c = run.catchUp;
  return c === undefined
    ? ""
    : `这是补跑；合并 ${c.dueCount} 次到期，本次只执行一次。区间 (${new Date(c.fromExclusive).toISOString()}, ${new Date(c.through).toISOString()}]；原计划时间 ${new Date(run.scheduledAt).toISOString()}；恢复时间 ${new Date(c.recoveredAt).toISOString()}（${c.cause}）。`;
}
