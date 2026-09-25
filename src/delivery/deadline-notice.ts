import { formatDuration } from "../core/format.js";
import type { DeadlineNotice, Millis, RunDiagnostics, RunSnapshot } from "../core/types.js";
import type { WorkflowDeadlineNotice } from "../workflow/deadline.js";

/**
 * timeout-notify (arch §5): the grace/extended notice channel.
 *
 * This channel deliberately does NOT touch the delivery outbox (D-4): the
 * outbox is keyed by deliveryKey(runId, generation) — one terminal record
 * per run — and a grace notice occupying that key would silently swallow
 * the run's real terminal enqueue(). Notices here are fire-and-forget
 * custom messages (no persistence, no reconcile): losing one degrades to
 * the pre-feature behavior (the run simply dies at graceUntil).
 */
export const TIMEOUT_NOTICE_TYPE = "subagent:timeout";

/** Notify policy mirror of ExtendSettings["notify"] (config/settings.ts) — kept structural so delivery stays config-import-free. */
export type DeadlineNotifyPolicy = "background" | "always" | "off";

const short = (runId: string) => runId.slice(0, 8);
const who = (notice: DeadlineNotice) =>
  notice.label ? `"${notice.label}" (#${short(notice.runId)})` : `#${short(notice.runId)}`;

function oneLine(value: string, cap: number): string {
  const clean = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > cap ? `${clean.slice(0, cap - 1)}…` : clean;
}

/** "tool_exec (bash) · 7 turns · $0.41 · idle 3s" — live picture from the snapshot's diagnostics. */
function nowLine(snapshot: RunSnapshot, now: Millis): string {
  const diag = snapshot.diag;
  const parts = [diag.phase + (diag.currentTool ? ` (${diag.currentTool.name})` : ""), `${diag.turns} turns`];
  if (diag.usage) parts.push(`$${diag.usage.costUsd.toFixed(2)}`);
  parts.push(`idle ${formatDuration(now - (diag.lastEventAt ?? diag.phaseEnteredAt))}`);
  return parts.join(" · ");
}

/**
 * Render a deadline notice as model-facing text (arch §5.3 grace template /
 * §5.4 extended receipt). All durations are relative (formatDuration), never
 * absolute clock readings — same convention as formatSingle, and it keeps
 * the snapshots locale/timezone-independent.
 */
export function formatDeadlineNotice(notice: DeadlineNotice, ctx: { now: Millis; snapshot?: RunSnapshot }): string {
  const { now, snapshot } = ctx;
  if (notice.kind === "extended") {
    // §5.4: a one-line receipt. For source "tool" the calling model already
    // has the same information in the tool result — this line exists for the
    // human watching the agent tree.
    let line =
      `⏳ Run ${who(notice)} deadline extended by ${formatDuration(notice.grantedMs ?? 0)} ` +
      `(${notice.extensionsUsed} of ${notice.maxExtensions} extensions used, ` +
      `${formatDuration(Math.max(0, notice.hardDeadlineAt - notice.deadlineAt))} headroom left).`;
    const reason = snapshot?.diag.overtime?.lastReason;
    if (reason) line += ` Reason: ${oneLine(reason, 120)}`;
    return line;
  }
  // kind === "grace" (§5.3 seven-line template)
  const graceLeft = formatDuration(Math.max(0, (notice.graceUntil ?? now) - now));
  const extendS = Math.max(1, Math.round((notice.suggestedExtendMs ?? 60_000) / 1000));
  const extensionsLeft = notice.maxExtensions - notice.extensionsUsed;
  const headroom = formatDuration(Math.max(0, notice.hardDeadlineAt - Math.max(now, notice.deadlineAt)));
  // Original total budget = current deadline minus already-granted
  // extensions, measured from enqueue. Absent a snapshot we cannot know it.
  const budgetMs =
    snapshot !== undefined
      ? notice.deadlineAt - (snapshot.diag.overtime?.grantedMs ?? 0) - snapshot.deadlines.enqueuedAt
      : undefined;
  const lines = [
    `⏳ Subagent ${who(notice)} hit its ${budgetMs === undefined ? "" : `${formatDuration(budgetMs)} `}time budget and is STILL RUNNING.`,
    `Grace: ${graceLeft} left — after that it is killed as timed_out and you only get its partial output.`,
    ...(snapshot !== undefined ? [`Now: ${nowLine(snapshot, now)}`] : []),
    `Give it more time:  extend_subagent_timeout(run_id: "${short(notice.runId)}", extend_s: ${extendS})`,
    `Budget left: ${extensionsLeft} of ${notice.maxExtensions} extensions, at most ${headroom} more.`,
    `Doing nothing lets it expire — that is a valid choice if its partial result is enough.`,
    ...(notice.taskPreview ? [`Task: ${oneLine(notice.taskPreview, 120)}`] : []),
  ];
  return lines.join("\n");
}

/**
 * §5.5 suppression rules 2/3 (rule 1 — CC2 child-run drop — lives in
 * service/runtime-adapter.ts, the only place that owns childRunIds):
 *
 *  - policy "off": deliver nothing (the grace window itself still applies).
 *  - policy "always": deliver everything (debug only, D-17 — rule 2 ignored).
 *  - policy "background" (default): skip runs a caller is synchronously
 *    blocked on (expectsAck — spawnAndWait from a nested Agent call, a
 *    workflow step, the /goal verifier, consult) — the waiting model could
 *    not act on the notice anyway, so it would be pure noise. The top-level
 *    Agent tool always spawns in the background, so its runs are never
 *    skipped.
 *
 * Note the responsibility boundary: whether an "extended" receipt wakes the
 * model is NOT decided here but in deliveryOptionsFor (triggerTurn: false);
 * this function only decides deliver/drop.
 */
export function shouldDeliverDeadlineNotice(
  notice: DeadlineNotice,
  ctx: {
    policy: DeadlineNotifyPolicy;
    expectsAck(runId: string): boolean;
  },
): boolean {
  if (ctx.policy === "off") return false;
  if (ctx.policy === "always") return true;
  return !ctx.expectsAck(notice.runId);
}

/**
 * pi.sendMessage options per notice kind (§5.2): a grace notice must wake
 * the model into a decision turn; an "extended" receipt is display-only for
 * the model's purposes (source "tool" already returned the same information
 * in the tool result), so it never triggers a turn.
 */
export function deliveryOptionsFor(notice: DeadlineNotice): { triggerTurn: boolean } {
  return { triggerTurn: notice.kind === "grace" };
}

/**
 * §5.6: terminal-notification tail — " (finished in overtime; N extension(s) used)"
 * — appended by stack.ts sendFormatted so the host sees that the earlier
 * grace notice is moot. Empty unless the run actually entered grace or was
 * extended at least once.
 */
export function overtimeTail(diag: RunDiagnostics | undefined): string {
  const overtime = diag?.overtime;
  if (overtime === undefined || (overtime.graces <= 0 && overtime.extensions <= 0)) return "";
  return ` (finished in overtime; ${overtime.extensions} extension${overtime.extensions === 1 ? "" : "s"} used)`;
}

// ── workflow deadline notices (workflow-agent-queue §4.5, stage B) ──────────

const shortWorkflowId = (workflowId: string) => workflowId.slice(0, 11); // "wf_" + 8

function workflowWho(notice: WorkflowDeadlineNotice, name: string | undefined): string {
  return name ? `"${oneLine(name, 60)}" (${shortWorkflowId(notice.workflowId)})` : shortWorkflowId(notice.workflowId);
}

/** `phase "review" · 2 running · 1 queued · 5 settled` — the workflow's live picture at notice time. */
function workflowNowLine(live: NonNullable<WorkflowDeadlineNotice["live"]>): string {
  const parts: string[] = [];
  if (live.phaseId !== undefined) parts.push(`phase "${oneLine(live.phaseId, 40)}"`);
  parts.push(`${live.running} running`, `${live.queued} queued`, `${live.settled} settled`);
  return parts.join(" · ");
}

/**
 * Render a workflow deadline notice (same channel and conventions as
 * `formatDeadlineNotice`: relative durations only, a directly copyable
 * extend call, "doing nothing is a valid choice"). The copyable call uses the
 * full workflow id so it can never hit an ambiguous-prefix error.
 */
export function formatWorkflowDeadlineNotice(
  notice: WorkflowDeadlineNotice,
  ctx: { now: Millis; name?: string },
): string {
  const { now } = ctx;
  const who = workflowWho(notice, ctx.name);
  if (notice.kind === "extended") {
    let line =
      `⏳ Workflow ${who} deadline extended by ${formatDuration(notice.grantedMs ?? 0)} ` +
      `(${notice.extensionsUsed} of ${notice.maxExtensions} extensions used, ` +
      `${formatDuration(Math.max(0, notice.hardDeadlineAt - notice.deadlineAt))} headroom left).`;
    if (notice.reason) line += ` Reason: ${oneLine(notice.reason, 120)}`;
    return line;
  }
  const graceLeft = formatDuration(Math.max(0, (notice.graceUntil ?? now) - now));
  const extendS = Math.max(1, Math.round((notice.suggestedExtendMs ?? 60_000) / 1000));
  const extensionsLeft = notice.maxExtensions - notice.extensionsUsed;
  const headroom = formatDuration(Math.max(0, notice.hardDeadlineAt - Math.max(now, notice.deadlineAt)));
  const extended =
    notice.extensionsUsed > 0
      ? ` (extended ${notice.extensionsUsed} time${notice.extensionsUsed === 1 ? "" : "s"})`
      : "";
  const lines = [
    `⏳ Workflow ${who} hit its ${formatDuration(notice.totalMs)} time budget${extended} and is STILL RUNNING.`,
    `Grace: ${graceLeft} left — then it stops as timed_out and its children are aborted.`,
    ...(notice.live !== undefined ? [`Now: ${workflowNowLine(notice.live)}`] : []),
    `Give it more time:  extend_subagent_timeout(run_id: "${notice.workflowId}", extend_s: ${extendS})`,
    `Budget left: ${extensionsLeft} of ${notice.maxExtensions} extensions, at most ${headroom} more.`,
    `Doing nothing lets it expire — that is a valid choice if its partial result is enough.`,
  ];
  return lines.join("\n");
}

/**
 * Workflow notices never have a caller synchronously blocked on them (a
 * workflow is always a background run), so only policy "off" suppresses them —
 * "background" and "always" both deliver.
 */
export function shouldDeliverWorkflowDeadlineNotice(ctx: { policy: DeadlineNotifyPolicy }): boolean {
  return ctx.policy !== "off";
}

/** Same rule as `deliveryOptionsFor`: a grace notice wakes the model into a decision turn; an extended receipt is display-only. */
export function workflowDeliveryOptionsFor(notice: WorkflowDeadlineNotice): { triggerTurn: boolean } {
  return { triggerTurn: notice.kind === "grace" };
}
