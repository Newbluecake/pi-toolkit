import type { RunSnapshot, UsageDelta } from "../core/types.js";
import type { ResolveRunResult } from "../service/resolve-target.js";
import type { WorkflowActivitySnapshot } from "../workflow/activity.js";
import type { BackgroundWorkflows } from "../workflow/background.js";

/**
 * Background-workflow management port shared by `get_subagent_result` and
 * `abort_subagent` (docs/dev/workflow-background/plan.md §2.3). Structural —
 * `index.ts` forwards it through the session holder like every other port.
 */
export interface WorkflowQueryPort extends Pick<
  BackgroundWorkflows,
  "resolve" | "resolveLabel" | "get" | "wait" | "stop"
> {
  /** Live activity row (running workflows only). */
  activity(workflowId: string): WorkflowActivitySnapshot | undefined;
  /** Live child run snapshot, for the per-child progress rows. */
  snapshotOf?(runId: string): RunSnapshot | undefined;
  /** A child run's lifetime usage, for spend accounting on the terminal read. */
  usageOf?(runId: string): UsageDelta | undefined;
  /**
   * workflow-agent-queue §4.5 (stage B): `extend_subagent_timeout(run_id: "wf_…")`.
   * Optional so read-only ports (result/abort test doubles) keep compiling;
   * absent ⇒ the extend tool answers `unsupported`.
   */
  extend?: BackgroundWorkflows["extend"];
}

export type ToolTarget =
  { readonly kind: "run"; readonly runId: string } | { readonly kind: "workflow"; readonly workflowId: string };

/** Every workflow id starts with this prefix; run ids never do (`r_…`). A workflow's children carry it as their `parentRunId`. */
export const WORKFLOW_ID_PREFIX = "wf_";

/**
 * Resolve a model-facing `run_id` argument to a run or a background workflow.
 *
 * Order (runs and workflows never collide on ids — run ids are `r_…`,
 * workflow ids `wf_…`):
 *  1. exact workflow id, then unique workflow-id prefix;
 *  2. the run resolver (exact → prefix → Agent label);
 *  3. only when the run resolver found nothing: the workflow's script name
 *     (the single running workflow of that name, else the most recent one).
 * An ambiguous workflow match throws; a `wf_…` handle that matches no known
 * workflow throws a workflow-specific error instead of the run resolver's.
 */
export function resolveToolTarget(
  handle: string,
  resolveRun: ((handle: string) => ResolveRunResult) | undefined,
  workflows: WorkflowQueryPort | undefined,
): ToolTarget {
  if (workflows) {
    const byId = workflows.resolve(handle);
    if (byId.kind === "workflow") return { kind: "workflow", workflowId: byId.workflowId };
    if (byId.kind === "ambiguous") throw new Error(byId.error);
    if (handle.startsWith(WORKFLOW_ID_PREFIX)) {
      throw new Error(
        `unknown workflow id: ${handle}. Background workflows are tracked per session — they do not survive /reload ` +
          "or a session switch except through their completion notification.",
      );
    }
  }
  if (!resolveRun) {
    const byLabel = workflows?.resolveLabel(handle);
    if (byLabel?.kind === "workflow") return { kind: "workflow", workflowId: byLabel.workflowId };
    if (byLabel?.kind === "ambiguous") throw new Error(byLabel.error);
    return { kind: "run", runId: handle };
  }
  const run = resolveRun(handle);
  if (run.ok) return { kind: "run", runId: run.runId };
  const byLabel = workflows?.resolveLabel(handle);
  if (byLabel?.kind === "workflow") return { kind: "workflow", workflowId: byLabel.workflowId };
  if (byLabel?.kind === "ambiguous") throw new Error(byLabel.error);
  throw new Error(run.error);
}
