import { formatSize } from "@earendil-works/pi-coding-agent";
import { type BashJobManager } from "./manager.js";
import { isTerminalJobStatus, previewCommand, type JobRecord } from "./types.js";
import { describeJobStatus } from "./types.js";
import { formatDuration } from "../core/format.js";

/** customType of the bash job completion notice (§5) — distinct from `subagent:notification`. */
export const BASH_JOB_NOTIFICATION_TYPE = "bash-job:notification";

/** Output tail attached to a completion notice (§5). */
export const BASH_JOB_TAIL_BYTES = 1024;

export const BASH_JOB_TAIL_LINES = 10;

/** Wall-clock life of a job (spawn → exit, or → now while it runs). */
export function bashJobElapsedMs(record: JobRecord, now: number): number {
  return Math.max(0, (record.endedAt ?? now) - (record.spawnedAt ?? record.createdAt));
}

/** `exit N` when the code is known, otherwise the tool layer's own phrase. */
function bashJobOutcomePhrase(record: JobRecord): string {
  if ((record.status === "completed" || record.status === "failed") && record.exitCode !== null) {
    return `exit ${record.exitCode}`;
  }
  return describeJobStatus(record);
}

/**
 * §5 completion notice. Deliberately prefixed "Bash job" (vs. the
 * "Subagent …" wording of `delivery/format.ts`) so a downstream hook, the
 * user and the model can all tell the two notification channels apart.
 *
 * The `Full log:` line is dropped only when the message already shows the
 * ENTIRE log: terminal job, no size cap, and `tailCoversWholeLog` (the tail
 * text is byte-for-byte the whole current file — derived from the read
 * offsets in `readBashJobTail`, never guessed from text length). Otherwise
 * the model still needs the path to read what was left out.
 */
export function formatBashJobNotification(
  record: JobRecord,
  tail?: string,
  now: number = Date.now(),
  tailCoversWholeLog = false,
): string {
  const head =
    `Bash job ${record.jobId} ($ ${previewCommand(record.command, 60)}) finished: ` +
    `${bashJobOutcomePhrase(record)} after ${formatDuration(bashJobElapsedMs(record, now))}.`;
  const body = tail !== undefined && tail.length > 0 ? ["--- output tail ---", tail, "---"] : [];
  return [
    head,
    ...body,
    ...(isTerminalJobStatus(record.status) && !record.outputTruncated && tailCoversWholeLog
      ? []
      : [
          `Full log: ${record.logPath} — a plain file: read it directly with the read tool, or with tail/grep/awk ` +
            `(grep a large log rather than reading it whole). Its last line records this outcome.`,
        ]),
    ...(record.outputTruncated ? ["(the job's log hit its size cap; some output was dropped)"] : []),
  ].join("\n");
}

/**
 * bash-timeout-grace plan §4 (P5b): the main-session job-deadline notice
 * channel — distinct customType from the completion notice
 * (`BASH_JOB_NOTIFICATION_TYPE`) so a downstream hook/model can tell the two
 * apart. "grace" wakes the model into a decision turn (mirrors
 * `deliveryOptionsFor` for the run-level timeout-notify channel);
 * "extended" is a TUI-only receipt (the tool call already told the model the
 * same numbers in its own return text — §2.6/`bash-job-tool.ts`).
 */
export const BASH_JOB_DEADLINE_NOTIFICATION_TYPE = "bash-job:timeout";

/** §4/§2.6: the `extend_s` suggestion shown in the grace notice — same value as `bash-job-tool.ts`'s own grace line. */
const BASH_JOB_GRACE_SUGGESTED_EXTEND_S = 600;

/**
 * §4 main-session grace notice (seven-line template, mirrors
 * `delivery/deadline-notice.ts`'s run-level `formatDeadlineNotice`): wakes
 * the model with the job's own command/log context and a copyable `extend`
 * call. `record.deadline` is always defined when this is called (only
 * `onDeadline(record, "grace")` calls it) — the `undefined` branch is a
 * defensive fallback that should be unreachable.
 */
export function formatBashJobGraceNotice(record: JobRecord, now: number = Date.now()): string {
  const deadline = record.deadline;
  if (deadline === undefined) {
    return `⏳ Bash job ${record.jobId} hit its timeout and is STILL RUNNING.`;
  }
  const graceLeft = formatDuration(Math.max(0, (deadline.graceUntil ?? now) - now));
  const extensionsLeft = Math.max(0, deadline.policy.maxExtensions - deadline.extensions);
  const headroom = formatDuration(Math.max(0, deadline.hardAt - Math.max(now, deadline.dueAt)));
  return [
    `⏳ Bash job ${record.jobId} hit its ${formatDuration(deadline.timeoutMs)} timeout and is STILL RUNNING.`,
    `Grace: ${graceLeft} left — then it is killed as timed_out (partial log stays at ${record.logPath}).`,
    `Command: ${previewCommand(record.command, 60)} · running ${formatDuration(bashJobElapsedMs(record, now))} · log ${formatSize(record.logBytes)}`,
    `Give it more time:  bash_job(action: "extend", job_id: "${record.jobId}", extend_s: ${BASH_JOB_GRACE_SUGGESTED_EXTEND_S})`,
    `Budget left: ${extensionsLeft} of ${deadline.policy.maxExtensions} extensions, at most ${headroom} more.`,
    `Doing nothing lets it expire — that is a valid choice if you no longer need it.`,
  ].join("\n");
}

/**
 * §4 main-session "already extended" receipt — TUI-only (`triggerTurn:
 * false`): the tool's own return text (`bash-job-tool.ts`) already told the
 * calling model the same numbers, so this is display-only for the human
 * watching the session.
 */
export function formatBashJobExtendedNotice(record: JobRecord, now: number = Date.now()): string {
  const deadline = record.deadline;
  if (deadline === undefined) {
    return `⏳ Bash job ${record.jobId} timeout extended.`;
  }
  const extensionsLeft = Math.max(0, deadline.policy.maxExtensions - deadline.extensions);
  const headroom = formatDuration(Math.max(0, deadline.hardAt - Math.max(now, deadline.dueAt)));
  return (
    `⏳ Bash job ${record.jobId} timeout extended — now fires in ${formatDuration(Math.max(0, deadline.dueAt - now))} ` +
    `(${extensionsLeft} of ${deadline.policy.maxExtensions} extensions left, ${headroom} hard-limit headroom left).`
  );
}

function tailOffset(size: number): number {
  return Math.max(0, size - BASH_JOB_TAIL_BYTES);
}

export interface BashJobTail {
  readonly text: string | undefined;
  readonly logBytes: number;
  /** True when `text` IS the entire current log (read from byte 0 through EOF, no cap, no line trim). */
  readonly coversWholeLog: boolean;
}

function lastLines(content: string, max: number): string | undefined {
  const lines = content.replace(/\n+$/, "").split("\n");
  const tail = lines.slice(Math.max(0, lines.length - max)).join("\n");
  return tail.trim().length > 0 ? tail : undefined;
}

/**
 * Best-effort log tail for the notice. Never advances the model-facing read
 * cursor (`bash_job output` must still see everything) and never rejects — a
 * missing/unreadable log only costs the tail, not the notification.
 *
 * Two passes: a terminal record's `logBytes` is usually exact, but an adopted
 * or `exited_unknown` job's counter can lag behind the file, so the first read
 * (which reports the real size) is repeated from the true tail offset.
 */
export async function readBashJobTail(
  manager: BashJobManager,
  record: JobRecord,
  sizeHint?: number,
): Promise<BashJobTail | undefined> {
  try {
    const options = { advanceCursor: false, maxBytes: BASH_JOB_TAIL_BYTES } as const;
    // B1: record.logBytes may lag the adopted file, so the first bounded read
    // discovers the real size and the second pass re-reads the actual tail.
    const hintedSize = Math.max(record.logBytes, sizeHint ?? 0);
    let read = await manager.readOutput(record.jobId, { ...options, offset: tailOffset(hintedSize) });
    if (read.logBytes > hintedSize) {
      read = await manager.readOutput(record.jobId, { ...options, offset: tailOffset(read.logBytes) });
    }
    const text = lastLines(read.content, BASH_JOB_TAIL_LINES);
    // Coverage is derived from the read result itself (start offset 0, next
    // offset at the current EOF, no size cap) plus one text equality that
    // catches the BASH_JOB_TAIL_LINES trim dropping earlier lines — never
    // guessed from text length (bytes vs chars).
    const coversWholeLog =
      text !== undefined &&
      !record.outputTruncated &&
      read.startOffset === 0 &&
      read.nextOffset >= read.logBytes &&
      text === read.content.replace(/\n+$/, "");
    return { text, logBytes: read.logBytes, coversWholeLog };
  } catch {
    return undefined;
  }
}
