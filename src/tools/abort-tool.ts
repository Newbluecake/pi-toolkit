import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { QueryService } from "../service/query-service.js";
import type { ResolveRunResult } from "../service/resolve-target.js";
import { resolveToolTarget, type WorkflowQueryPort } from "./workflow-target.js";
import type { BackgroundWorkflowView } from "../workflow/background.js";

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
    `A completion notification follows; get_subagent_result(run_id: "${id}") returns the final outcome.`
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
      const title = theme.fg("toolTitle", theme.bold(`Abort Subagent: ${args?.run_id ?? "…"}`));
      const reason = previewReason(args?.reason);
      text.setText(reason ? `${title}\n${theme.fg("muted", reason)}` : title);
      return text;
    },
    async execute(_toolCallId, params) {
      const target = resolveToolTarget(params.run_id, deps.resolveRun, deps.workflows);
      if (target.kind === "workflow") {
        const workflowId = target.workflowId;
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
        throw new Error(`unknown workflow id: ${params.run_id}`);
      }
      const runId = target.runId;
      const result = await deps.query.stop(runId, "user_stop");
      if (result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Abort requested for run ${runId} (escalation: ${result.escalatedTo}). Use get_subagent_result(run_id: "${runId}", wait: true) to wait for its terminal state.`,
            },
          ],
          details: {
            runId,
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
              text: `run ${runId} has already reached a terminal state ("${result.status}"); nothing to abort`,
            },
          ],
          details: { runId, alreadyTerminal: true, status: result.status },
        };
      }
      if (result.reason === "unknown_run") throw new Error(`unknown run_id: ${params.run_id}`);
      throw new Error(`failed to abort run ${runId} (escalation: ${result.escalatedTo})`);
    },
  } satisfies ToolDefinition<typeof AbortToolParams>;
}
