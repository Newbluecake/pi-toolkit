import { formatDuration } from "../core/format.js";
import type { CompactionFailureRecord, ContextSwitchDiag, RunExitFacts, RunExitJob } from "../core/types.js";

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

/**
 * child-context-switch plan P0 (§2.3.1, result text line): renders
 * `RunOutcome.diag.contextSwitches` into the one-line summary
 * `get_subagent_result`'s formatOutcome (src/tools/result-tool.ts, wired by
 * the child-wiring package) appends to a subagent's result text and the
 * parent completion notice reuses. Returns `undefined` when the run never
 * produced any context-switch diagnostics at all (the common case: the
 * feature is off, or the run never called switch_context).
 */
export function formatContextSwitches(contextSwitches: ContextSwitchDiag | undefined): string | undefined {
  if (!contextSwitches) return undefined;
  const { count, last, selfcheck, capability, rejected } = contextSwitches;
  if (
    count <= 0 &&
    last === undefined &&
    selfcheck === undefined &&
    capability === undefined &&
    (rejected === undefined || rejected.length === 0)
  )
    return undefined;
  const parts: string[] = [`context switches: ${count}`];
  if (last) {
    const droppedTokens = Math.max(0, last.dropped.tokensBefore - last.dropped.tokensAfterEstimate);
    parts.push(
      `(dropped ~${droppedTokens} tokens / ${last.dropped.entries} entries; last at entry ${last.dropped.toEntryId})`,
    );
  }
  if (capability) parts.push(`\u2014 capability disabled: ${capability.reason}`);
  if (selfcheck) parts.push(`\u2014 self-check failed: ${selfcheck.reason}`);
  if (rejected && rejected.length > 0) {
    const lastRejected = rejected[rejected.length - 1]!;
    parts.push(`\u2014 rejected: ${rejected.length} (last: ${lastRejected.reason})`);
  }
  return parts.join(" ");
}

/**
 * child-context-switch plan P0 (§2.3.1): renders a trailing note for the
 * most recent pi auto-compaction failure, unless `errorMessage` (the run's
 * own `error.message`) already mentions it — the runner's own settlement
 * error concatenation (runner.ts's `compactionFailureAnnotation`) already
 * does that for a LIVE (non-stale) failure that caused this particular run
 * to fail; this is the fallback for every other case (a stale failure
 * superseded by a later success, or a run that completed despite an
 * earlier recorded compaction failure).
 */
export function formatCompactionFailureNote(
  compactionFailures: readonly CompactionFailureRecord[] | undefined,
  errorMessage?: string,
): string | undefined {
  if (!compactionFailures || compactionFailures.length === 0) return undefined;
  const last = compactionFailures[compactionFailures.length - 1]!;
  if (errorMessage && errorMessage.includes(last.message)) return undefined;
  return `auto-compaction failed: ${last.message}`;
}
