/**
 * Scheduled tasks — shared plain-text rendering (A3): the `schedule` tool, `/schedule`, the
 * `pi_schedules` prompt section and the digest all speak through these helpers so a task reads the
 * same everywhere. Pure — no IO, no pi. UI language split (AGENTS.md): compact markers are English
 * tokens; prose aimed at the user lives with the callers.
 */
import { compileWhen, formatLocal } from "../core/cron.js";
import {
  defHash,
  isApproved,
  isTerminalRunState,
  type OccState,
  type RunRecord,
  type ScheduleTask,
  type ScheduleWhen,
} from "../core/spec.js";

export function whenText(when: ScheduleWhen): string {
  return when.kind === "cron" ? `cron "${when.expr}" ${when.tz}` : `once ${when.at} ${when.tz}`;
}

/** Local wall time of `t` in the task's tz (`YYYY-MM-DD HH:mm`), ISO fallback if the tz cannot compile. */
export function localTime(when: ScheduleWhen, t: number): string {
  const c = compileWhen(when);
  return c.ok ? `${formatLocal(c.when, t)} ${when.tz}` : new Date(t).toISOString();
}

/** UI-derived flags: pending approval and paused are independent (§4.3). */
export function taskFlags(task: ScheduleTask): string[] {
  const out: string[] = [];
  if (!isApproved(task)) out.push("pending");
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
      `consultMain: ${b.consultMain ? "yes" : "no"} · handoff: ${b.handoff ? "yes" : "no"}` +
        ` · isolation: ${b.isolation ?? "none"}`,
    );
  }
  lines.push(
    `approval: ${
      isApproved(task) ? `approved (${task.approval?.via ?? "?"})` : "PENDING — needs the user's /schedule approve"
    }`,
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

export function runLine(run: RunRecord, when?: ScheduleWhen): string {
  const at = when === undefined ? new Date(run.scheduledAt).toISOString() : localTime(when, run.scheduledAt);
  const end = run.endedAt !== undefined && isTerminalRunState(run.state) ? "" : " (in progress)";
  return [
    `${at}`,
    run.kind,
    `${run.state}${run.reason ? `(${run.reason})` : ""}${end}`,
    ...(run.runId ? [`run ${run.runId}`] : []),
    ...(run.reportFile ? [`report ${run.reportFile}`] : []),
    ...(run.note === "unverified" ? ["note unverified"] : []),
  ].join(" · ");
}
