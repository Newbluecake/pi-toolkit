import { NoActiveSessionError } from "../holder.js";
import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { QueryService } from "../service/query-service.js";
import type { ResolveRunResult } from "../service/resolve-target.js";
import { resolveToolTarget, type WorkflowQueryPort } from "./workflow-target.js";
import { labelOfRun, labelOfSnapshot, runRefDetails, runRefText, titleForHandle } from "./run-ref.js";
import type { BackgroundWorkflowView } from "../workflow/background.js";
import { RESULT_TOOL_NAME } from "../core/tool-names.js";

export const AbortToolParams = Type.Object({
  run_id: Type.String({
    description:
      "The run id of the subagent to abort; also accepts a unique run_id prefix or the Agent call's label (its description). " +
      "A SubagentWorkflow id (wf_…, or a unique prefix / the workflow's script name) stops the whole workflow and all of its child runs.",
  }),
  reason: Type.Optional(Type.String({ description: "Optional reason to include in the confirmation." })),
});
export type AbortToolParams = Static<typeof AbortToolParams>;

function previewReason(reason?: string): string | undefined {
  if (!reason) return undefined;
  const clean = reason
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? (clean.length > 80 ? `${clean.slice(0, 79)}…` : clean) : undefined;
}

function workflowStopText(view: BackgroundWorkflowView, settled: boolean): string {
  const id = view.workflowId;
  if (!settled) {
    return (
      `Stop requested for workflow ${id} ("${view.name}"); it is still settling (its child runs are being stopped). ` +
      "Its completion notification will report the final state."
    );
  }
  const outcome = view.outcome;
  const cause = outcome?.stopCause ? ` (${outcome.stopCause})` : "";
  const children = outcome ? outcome.children.length : 0;
  return (
    `Workflow ${id} ("${view.name}") stopped: ${view.status}${cause}; ${children} child call(s) recorded. ` +
    `A completion notification follows; ${RESULT_TOOL_NAME}(run_id: "${id}") returns the final outcome.`
  );
}

class AbortToolError extends Error {}
function abortFailure(reason: string, text: string, effect: "none" | "unknown" = "none"): Error {
  return new AbortToolError(
    `${text} [code=abort_${reason} reason=${reason} retryable=false effect=${effect}]. ` +
      (effect === "unknown"
        ? "Stopping is unverified. Read the run's terminal state before further action; do not automatically send another abort. Escalation fallback values do not prove a completed kill."
        : ""),
  );
}

export function createAbortTool(deps: {
  query: QueryService;
  resolveRun?: (handle: string) => ResolveRunResult;
  /** Background SubagentWorkflow management (absent: workflow ids are not accepted). */
  workflows?: WorkflowQueryPort;
}): ToolDefinition<typeof AbortToolParams> {
  return {
    name: "abort_subagent",
    label: "Abort Subagent",
    description:
      "Stop a still-running subagent started with the Agent tool, or a background SubagentWorkflow by its workflow id " +
      "(wf_…; stops every child run of that workflow). Terminal runs and workflows are reported as already-finished " +
      "instead of erroring, so repeated calls are safe.",
    promptSnippet: "abort_subagent(run_id, reason?) - stop a running subagent or background workflow",
    parameters: AbortToolParams,
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const title = theme.fg(
        "toolTitle",
        theme.bold(
          `Abort Subagent: ${titleForHandle(args?.run_id, { resolveRun: deps.resolveRun, get: (id) => deps.query.get(id) })}`,
        ),
      );
      const reason = previewReason(args?.reason);
      text.setText(reason ? `${title}\n${theme.fg("muted", reason)}` : title);
      return text;
    },
    async execute(_toolCallId, params) {
      let invoked = false;
      let stoppingRun: string | undefined;
      try {
        let target;
        try {
          target = resolveToolTarget(params.run_id, deps.resolveRun, deps.workflows);
        } catch (error) {
          if (error instanceof NoActiveSessionError) throw error;
          throw abortFailure("target_resolution", "Target resolution failed (unknown or ambiguous handle).");
        }
        if (target.kind === "workflow") {
          const workflowId = target.workflowId;
          invoked = true;
          const stopped = await deps.workflows!.stop(workflowId, "user_stop");
          const reason = previewReason(params.reason);
          if (stopped.ok) {
            return {
              content: [{ type: "text" as const, text: workflowStopText(stopped.view, stopped.settled) }],
              details: {
                workflowId,
                ok: true,
                settled: stopped.settled,
                status: stopped.view.status,
                ...(reason ? { reason } : {}),
              },
            };
          }
          if (stopped.reason === "already_terminal") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `workflow ${workflowId} has already reached a terminal state ("${stopped.view.status}"); nothing to abort`,
                },
              ],
              details: { workflowId, alreadyTerminal: true, status: stopped.view.status },
            };
          }
          throw abortFailure("unknown_workflow", `unknown workflow id: ${params.run_id}`);
        }
        const runId = target.runId;
        const label = labelOfRun(deps.query, runId);
        const who = runRefText(runId, label);
        stoppingRun = runId;
        invoked = true;
        const result = await deps.query.stop(runId, "user_stop");
        if (result.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Abort requested for ${who} (escalation: ${result.escalatedTo}). Use ${RESULT_TOOL_NAME}(run_id: "${runId}", wait: true) to wait for its terminal state.`,
              },
            ],
            details: {
              ...runRefDetails(runId, label),
              ok: true,
              escalatedTo: result.escalatedTo,
              ...(previewReason(params.reason) ? { reason: previewReason(params.reason) } : {}),
            },
          };
        }
        if (result.reason === "already_terminal") {
          return {
            content: [
              {
                type: "text" as const,
                text: `${who} has already reached a terminal state ("${result.status}"); nothing to abort`,
              },
            ],
            details: { ...runRefDetails(runId, label), alreadyTerminal: true, status: result.status },
          };
        }
        if (result.reason === "unknown_run") throw abortFailure("unknown_run", `unknown run_id: ${params.run_id}`);
        throw abortFailure(
          "stop_failed",
          `failed to abort ${who}; no terminal state was confirmed`,
          result.effect ?? "unknown",
        );
      } catch (error) {
        if (error instanceof AbortToolError || error instanceof NoActiveSessionError) throw error;
        if (stoppingRun !== undefined) {
          try {
            const after = deps.query.get(stoppingRun);
            if (after && ["completed", "failed", "timed_out", "aborted"].includes(after.status)) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `run ${stoppingRun} has already reached a terminal state ("${after.status}"); no further abort was sent`,
                  },
                ],
                details: {
                  ...runRefDetails(stoppingRun, labelOfRun(deps.query, stoppingRun)),
                  alreadyTerminal: true,
                  status: after.status,
                },
              };
            }
          } catch {
            /* Unreadable is not terminal evidence. */
          }
        }
        throw abortFailure(
          invoked ? "stop_failed" : "read_failed",
          "Abort failed; no stop confirmation is available.",
          invoked ? "unknown" : "none",
        );
      }
    },
  } satisfies ToolDefinition<typeof AbortToolParams>;
}
