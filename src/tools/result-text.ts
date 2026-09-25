import { formatDuration } from "../core/format.js";
import type { RunExitFacts, RunExitJob } from "../core/types.js";

export interface TruncatedResultText {
  /** The body, plus a truncation marker when the body exceeded maxChars. */
  text: string;
  truncated: boolean;
  /** Original body length in UTF-16 code units. */
  totalChars: number;
}

/**
 * Fraction of the budget given to the head; the rest goes to the tail.
 * Reports typically front-load context and back-load conclusions, so a
 * head-only cut loses the densest section — keep both ends, elide the middle.
 */
const HEAD_RATIO = 0.7;

/**
 * Cap only the result body. Callers append duration/usage trailers after this
 * helper so the cap remains meaningful for the model-facing answer itself.
 */
export function truncateResultText(text: string, maxChars: number, sessionFile?: string): TruncatedResultText {
  const totalChars = text.length;
  if (maxChars <= 0 || totalChars <= maxChars) return { text, truncated: false, totalChars };

  // totalChars > maxChars guarantees tailStart > headLength below.
  let headLength = Math.floor(maxChars * HEAD_RATIO);
  if (headLength > 0) {
    const previous = text.charCodeAt(headLength - 1);
    if (previous >= 0xd800 && previous <= 0xdbff) headLength--;
  }
  let tailStart = totalChars - (maxChars - headLength);
  if (tailStart > headLength) {
    const first = text.charCodeAt(tailStart);
    if (first >= 0xdc00 && first <= 0xdfff) tailStart++;
  }
  const head = text.slice(0, headLength);
  const tail = text.slice(tailStart);
  const omitted = tailStart - headLength;
  const suffix = sessionFile ? `; full session transcript: ${sessionFile} — use the read tool to inspect it` : "";
  return {
    text:
      `${head}\n\n… [middle ${omitted} of ${totalChars} chars omitted ` +
      `— showing first ${headLength} + last ${tail.length}]${suffix}\n\n${tail}`,
    truncated: true,
    totalChars,
  };
}

/**
 * bash-timeout-grace plan §3.7 (P0b, frozen): renders one child bash job at
 * exit-time. `terminating` jobs show elapsed runtime (a SIGTERM was just sent
 * by the seal — the eventual kill result lands in the job store, never
 * retroactively edits this notice, per §3.7); every other (terminal) state
 * shows the exit code when known plus a "not seen by the subagent" marker
 * when the child session's own agent never observed this job finish (bash_job
 * wait/status) before the run ended — `terminating` jobs never get that
 * marker (they are unseen by definition, it would be redundant).
 */
function formatExitJob(job: RunExitJob): string {
  const parts: string[] = [`${job.jobId} \`${job.commandPreview}\``];
  if (job.state === "terminating") {
    parts.push(`terminating (ran ${formatDuration(job.durationMs)})`);
  } else {
    parts.push(job.exitCode === null ? job.state : `${job.state} exit ${job.exitCode}`);
    if (!job.seen) parts.push("(not seen by the subagent)");
  }
  parts.push(`\u00b7 log ${job.logPath}`);
  return parts.join(" ");
}

/**
 * bash-timeout-grace plan §3.7 (P0b, frozen): renders `RunOutcome.diag.exitFacts`
 * (already threaded there via the `exit_facts` session_event, §3.8) into the
 * trailing lines `get_subagent_result`'s `formatOutcome` (src/tools/result-tool.ts,
 * a later package) appends to a subagent's result text, and that the parent
 * completion notice reuses via `DeliveryPayload.exitFacts`. Pure text
 * formatting only — no pi imports, matches this file's existing convention
 * (`truncateResultText`). Returns `undefined` when there is nothing to render
 * (no bash jobs and no exhausted settle-hold budget), so callers can simply
 * skip appending a trailing blank section.
 */
export function formatExitFacts(facts: RunExitFacts | undefined): string | undefined {
  if (!facts) return undefined;
  const lines: string[] = [];
  if (facts.bashJobs.length > 0 || (facts.bashJobsMore ?? 0) > 0) {
    const jobLines = facts.bashJobs.map(formatExitJob);
    const more = facts.bashJobsMore ? ` (+${facts.bashJobsMore} more)` : "";
    lines.push(`Background bash jobs at exit: ${jobLines.join("; ")}${more}`);
  }
  if (facts.hold?.exhausted) {
    lines.push(
      `Settle hold budget exhausted (${facts.hold.rounds}/${facts.hold.cap} reminders); the run was released with jobs still running.`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}
