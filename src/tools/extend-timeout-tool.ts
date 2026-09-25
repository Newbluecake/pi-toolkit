import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "../core/format.js";
import type { ExtendOutcome, Millis, RunSnapshot } from "../core/types.js";
import type { QueryService } from "../service/query-service.js";
import type { ResolveRunResult } from "../service/resolve-target.js";
import type { BackgroundWorkflowView } from "../workflow/background.js";
import type { WorkflowExtendOutcome } from "../workflow/deadline.js";
import { resolveToolTarget, WORKFLOW_ID_PREFIX, type WorkflowQueryPort } from "./workflow-target.js";

/**
 * timeout-notify (arch §4): extend a running subagent's soft deadline by a
 * number of SECONDS. The grant is clamped by the run's hard ceiling
 * (maxTotalFactor × totalMs, frozen at enqueue), so the model may get less
 * than it asked for — the result text always says exactly how much was
 * granted. Only default-budget runs are extendable; runs spawned with an
 * explicit timeout_s are hard-capped (no grace, no extension).
 *
 * workflow-agent-queue §4.5 (stage B): the same tool extends a background
 * SubagentWorkflow when `run_id` resolves to a workflow (`wf_…`, prefix or
 * script name — `resolveToolTarget`). A workflow's own children are pinned to
 * the workflow's hard ceiling and cannot be extended individually: the tool
 * refuses them and points at the owning workflow instead.
 */
export const ExtendTimeoutParams = Type.Object({
  run_id: Type.String({
    description:
      "The run id of the subagent whose time budget to extend; also accepts a unique run_id prefix or the Agent call's label (its description). Also accepts a SubagentWorkflow id (wf_…), a unique prefix of one, or the workflow's script name, to extend the whole workflow.",
  }),
  extend_s: Type.Integer({
    minimum: 1,
    description:
      "Extra wall-clock seconds to add on top of the run's current deadline. The grant is capped by the run's hard ceiling, so you may get less than you ask for — the result says exactly how much was granted.",
  }),
  reason: Type.Optional(
    Type.String({
      description: "Short note on why more time is warranted; shown in the agent tree and the run's diagnostics.",
    }),
  ),
});
export type ExtendTimeoutParams = Static<typeof ExtendTimeoutParams>;

function previewReason(reason?: string): string | undefined {
  if (!reason) return undefined;
  const clean = reason
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? (clean.length > 80 ? `${clean.slice(0, 79)}…` : clean) : undefined;
}

const short = (runId: string) => runId.slice(0, 8);
const readResultHint = (runId: string) => `get_subagent_result(run_id: "${short(runId)}")`;
const respawnHint = "or abort_subagent and respawn with a larger timeout_s";

/** Remaining milliseconds until the run's current soft deadline (best-effort; 0 when unknown). */
function remainingMs(snapshot: RunSnapshot | undefined, now: Millis): Millis {
  const deadlineAt = snapshot?.deadlines.deadlineAt;
  return deadlineAt === undefined ? 0 : Math.max(0, deadlineAt - now);
}

function rejectionMessage(
  result: ExtendOutcome & { ok: false },
  snapshot: RunSnapshot | undefined,
  now: Millis,
): string {
  const runId = snapshot?.runId;
  const name = runId === undefined ? "the run" : `run ${short(runId)}`;
  switch (result.reason) {
    case "unknown_run":
      return `unknown run: no live or recorded run matches that id. List runs with /agent status, then retry with an exact run_id, a unique prefix, or a label.`;
    case "unsupported":
      return `this build cannot extend run deadlines. Let the run finish within its current budget, ${respawnHint}.`;
    case "not_started":
      return (
        `${name} has not started running yet (${snapshot?.status ?? "unknown"}); its deadline can only be extended ` +
        `once it is executing. Check on it with ${runId ? readResultHint(runId) : "get_subagent_result"} and extend after it starts.`
      );
    case "stopping":
      return (
        `${name} is already shutting down (abort in progress); extending its deadline would not bring it back. ` +
        `Collect its terminal outcome with ${runId ? readResultHint(runId) : "get_subagent_result"}.`
      );
    case "already_terminal":
      return (
        `${name} already finished (${snapshot?.status ?? "terminal"}). ` +
        `Use ${runId ? readResultHint(runId) : "get_subagent_result"} to read its output.`
      );
    case "uncapped":
      // Defensive (the config layer forbids an uncapped total budget, D-11) —
      // kept so a hand-fed state can never produce an opaque failure.
      return `${name} has no time cap configured; there is nothing to extend.`;
    case "limit_reached": {
      const used = snapshot?.diag.overtime?.extensions;
      const count = used === undefined ? "all" : `all ${used}`;
      return (
        `${name} has already used ${count} deadline extensions. It will stop at its current deadline ` +
        `(in ${formatDuration(remainingMs(snapshot, now))}). Read what it has so far with ` +
        `${runId ? readResultHint(runId) : "get_subagent_result"}, ${respawnHint}.`
      );
    }
    case "no_headroom": {
      const d = snapshot?.deadlines;
      const explicitCap =
        d !== undefined &&
        d.hardDeadlineAt !== undefined &&
        d.deadlineAt !== undefined &&
        d.hardDeadlineAt === d.deadlineAt &&
        (snapshot?.diag.overtime?.extensions ?? 0) === 0;
      if (explicitCap) {
        // D-10: spawned with an explicit timeout_s (or a workflow/RPC/goal
        // derived totalMs) — the hard ceiling IS the original deadline.
        return (
          `${name} was spawned with an explicit timeout, which is a hard cap; it stops at its deadline ` +
          `(in ${formatDuration(remainingMs(snapshot, now))}) and cannot be extended. Read what it has so far with ` +
          `${runId ? readResultHint(runId) : "get_subagent_result"}, ${respawnHint}.`
        );
      }
      const fromStart =
        snapshot !== undefined && d?.hardDeadlineAt !== undefined
          ? formatDuration(Math.max(0, d.hardDeadlineAt - snapshot.deadlines.enqueuedAt))
          : "its configured ceiling";
      return (
        `${name} is at its hard ceiling (${fromStart} from start); no further extension is possible. ` +
        `It stops at its deadline (in ${formatDuration(remainingMs(snapshot, now))}). Read what it has so far with ` +
        `${runId ? readResultHint(runId) : "get_subagent_result"}, ${respawnHint}.`
      );
    }
  }
}

const workflowReadHint = (workflowId: string) => `get_subagent_result(run_id: "${workflowId}")`;
const workflowRestartHint = "or abort_subagent and restart the workflow with a larger timeout_s";

function workflowRejectionMessage(
  workflowId: string,
  result: WorkflowExtendOutcome & { ok: false },
  view: BackgroundWorkflowView | undefined,
  now: Millis,
): string {
  const name = view ? `workflow ${workflowId} ("${view.name}")` : `workflow ${workflowId}`;
  const left = formatDuration(Math.max(0, (view?.graceUntil ?? view?.deadlineAt ?? now) - now));
  switch (result.reason) {
    case "unknown_workflow":
      return `unknown workflow: ${workflowId}. Background workflows are tracked per session; list them with /agent status.`;
    case "unsupported":
      return (
        `this build cannot extend ${name}${result.detail ? ` (${result.detail})` : ""}. Let it finish within its ` +
        `current budget, ${workflowRestartHint}.`
      );
    case "already_terminal":
      return (
        `${name} already finished${view && view.status !== "running" ? ` (${view.status})` : " (its terminal decision is made)"}. ` +
        `Use ${workflowReadHint(workflowId)} to read its outcome.`
      );
    case "stopping":
      return (
        `${name} is already stopping${view?.stopRequested ? ` (${view.stopRequested})` : ""}; extending its deadline ` +
        `would not bring it back. Collect its outcome with ${workflowReadHint(workflowId)} after the completion notification.`
      );
    case "uncapped":
      return `${name} has no time cap configured; there is nothing to extend.`;
    case "limit_reached": {
      const count = view?.extensions === undefined ? "all" : `all ${view.extensions}`;
      return (
        `${name} has already used ${count} deadline extensions. It stops at its current deadline (in ${left}) and ` +
        `its children are aborted with it. Read what it produced with ${workflowReadHint(workflowId)} after the ` +
        `notification, ${workflowRestartHint}.`
      );
    }
    case "no_headroom": {
      const explicitCap =
        view !== undefined &&
        view.hardDeadlineAt !== undefined &&
        view.deadlineAt !== undefined &&
        view.hardDeadlineAt === view.deadlineAt &&
        (view.extensions ?? 0) === 0;
      if (explicitCap) {
        return (
          `${name} was started with an explicit timeout_s, which is a hard cap; it stops at its deadline ` +
          `(in ${left}) and cannot be extended. Read what it produced with ${workflowReadHint(workflowId)} after the ` +
          `notification, ${workflowRestartHint}.`
        );
      }
      const ceiling =
        view?.hardDeadlineAt !== undefined
          ? formatDuration(Math.max(0, view.hardDeadlineAt - view.startedAt))
          : "its configured ceiling";
      return (
        `${name} is at its hard ceiling (${ceiling} from start); no further extension is possible. It stops at its ` +
        `deadline (in ${left}). Read what it produced with ${workflowReadHint(workflowId)} after the notification, ` +
        `${workflowRestartHint}.`
      );
    }
  }
}

export function createExtendTimeoutTool(deps: {
  query: Pick<QueryService, "extendTimeout" | "get">;
  resolveRun?: (handle: string) => ResolveRunResult;
  /** workflow-agent-queue §4.5: background workflows (`wf_…` targets). Absent ⇒ only runs are extendable. */
  workflows?: WorkflowQueryPort;
  /** Injectable clock for relative-duration text; defaults to wall clock. */
  now?: () => Millis;
}): ToolDefinition<typeof ExtendTimeoutParams> {
  const now = deps.now ?? (() => Date.now());
  return {
    name: "extend_subagent_timeout",
    label: "Extend Subagent Timeout",
    description:
      "Give a running subagent more wall-clock time by pushing its deadline forward (extend_s seconds, added on top of the current deadline). Only default-budget runs can be extended — a run spawned with an explicit timeout_s is a hard cap. Each run allows a limited number of extensions and an absolute ceiling, so a request may be clamped or refused; the result says exactly what was granted and how much headroom is left. Extending a run that is inside its timeout grace window rescues it back to normal execution. Also works on a background SubagentWorkflow (run_id: its wf_… id) with the same rules; the children of a workflow cannot be extended one by one — extend their workflow instead.",
    promptSnippet: "extend_subagent_timeout(run_id, extend_s, reason?) - give a running subagent more time",
    parameters: ExtendTimeoutParams,
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const title = theme.fg("toolTitle", theme.bold(`Extend Subagent Timeout: ${args?.run_id ?? "…"}`));
      const amount = typeof args?.extend_s === "number" ? `+${formatDuration(args.extend_s * 1000)}` : undefined;
      const reason = previewReason(args?.reason);
      const detail = [amount, reason].filter((v) => v !== undefined).join(" · ");
      text.setText(detail ? `${title}\n${theme.fg("muted", detail)}` : title);
      return text;
    },
    async execute(_toolCallId, params) {
      const target = resolveToolTarget(params.run_id, deps.resolveRun, deps.workflows);
      if (target.kind === "workflow") {
        const workflowId = target.workflowId;
        // Synchronous by design, like the run path: check → extend → re-arm
        // WT8 happen inside the orchestrator with no await (D-9 analogue).
        const result: WorkflowExtendOutcome = deps.workflows?.extend
          ? deps.workflows.extend(workflowId, params.extend_s * 1000, {
              ...(params.reason === undefined ? {} : { reason: params.reason }),
            })
          : { ok: false, reason: "unsupported" };
        const at = now();
        if (!result.ok)
          throw new Error(workflowRejectionMessage(workflowId, result, deps.workflows?.get(workflowId), at));
        const total = result.extensionsUsed + result.extensionsRemaining;
        let text =
          `Extended workflow ${workflowId} by ${formatDuration(result.grantedMs)} ` +
          `(requested ${formatDuration(result.requestedMs)}${result.clamped ? ", clamped by its hard ceiling" : ""}). ` +
          `New deadline in ${formatDuration(Math.max(0, result.deadlineAt - at))}. ` +
          `${result.extensionsRemaining} of ${total} extensions left; ` +
          `at most ${formatDuration(Math.max(0, result.hardDeadlineAt - result.deadlineAt))} more available.`;
        if (result.rescuedFromGrace)
          text += " The workflow was inside its timeout grace window and is now back to normal execution.";
        return { content: [{ type: "text" as const, text }], details: result };
      }
      const runId = target.runId;
      // workflow-agent-queue §0′ #1: a workflow's children are pinned to the
      // workflow's hard ceiling (explicit budget ⇒ never extendable anyway);
      // point the model at the owner, which is what actually moves the kill point.
      const parent = deps.query.get(runId)?.parentRunId;
      if (parent !== undefined && parent.startsWith(WORKFLOW_ID_PREFIX)) {
        throw new Error(
          `run ${short(runId)} is a child of workflow ${parent}; a workflow's children run under the workflow's own ` +
            `deadline and cannot be extended one by one. Extend the workflow instead: ` +
            `extend_subagent_timeout(run_id: "${parent}", extend_s: ${params.extend_s}).`,
        );
      }
      // Synchronous by design (D-9 / arch §4.6): check → dispatch → re-read
      // happen with no await inside the runner, closing the TOCTOU window
      // against the watchdog tick.
      const result = deps.query.extendTimeout(runId, params.extend_s * 1000, {
        source: "tool",
        ...(params.reason === undefined ? {} : { reason: params.reason }),
      });
      const at = now();
      if (!result.ok) throw new Error(rejectionMessage(result, deps.query.get(runId), at));
      const total = result.extensionsUsed + result.extensionsRemaining;
      let text =
        `Extended run ${short(runId)} by ${formatDuration(result.grantedMs)} ` +
        `(requested ${formatDuration(result.requestedMs)}${result.clamped ? ", clamped by its hard ceiling" : ""}). ` +
        `New deadline in ${formatDuration(Math.max(0, result.deadlineAt - at))}. ` +
        `${result.extensionsRemaining} of ${total} extensions left; ` +
        `at most ${formatDuration(Math.max(0, result.hardDeadlineAt - result.deadlineAt))} more available.`;
      if (result.rescuedFromGrace)
        text += " The run was inside its timeout grace window and is now back to normal execution.";
      // Defensive: extendability rejects queue_wait with not_started, so this
      // is unreachable through the real runner — keep the truthful note for
      // any custom Runner implementation that lets a queued run through.
      if (deps.query.get(runId)?.status === "queued")
        text += " Note: this run has not started yet; its queue-wait timeout is unaffected.";
      return {
        content: [{ type: "text" as const, text }],
        details: result,
      };
    },
  } satisfies ToolDefinition<typeof ExtendTimeoutParams>;
}
