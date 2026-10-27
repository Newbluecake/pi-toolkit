/**
 * workflow · setting specs (#56 batch 2 ⑧, D8-3): this subsystem's slice of the settable-surface table. The entries
 * keep their original text and order; `config/setting-specs.ts` spreads the record at the same position, so the
 * listing order of `/agent settings` and the TUI editor is unchanged (pinned by tests/config/setting-specs-pin.test.ts).
 */
import { seconds, bool, choice } from "../config/spec-helpers.js";
import type { SettingSpec } from "../config/spec-helpers.js";
import { msToSeconds, secondsKeyOf } from "../config/time-units.js";
import { DEFAULT_WORKFLOW_BUDGET } from "./settings.js";
import type { WorkflowBudget } from "./settings.js";

/** Integer-second duration knob whose effective default lives in DEFAULT_WORKFLOW_BUDGET. */
function workflowSeconds(leaf: keyof WorkflowBudget): SettingSpec {
  return {
    // workflowTotalMs must be > 0 (BW10 is unsupported in background mode; 0 falls back to the default).
    ...seconds(`workflow.budget.${leaf}`, {
      description: WORKFLOW_BUDGET_DESCRIPTIONS[leaf],
      ...(leaf === "workflowTotalMs" ? { min: 1 } : {}),
    }),
    fallback: msToSeconds(DEFAULT_WORKFLOW_BUDGET[leaf]),
  };
}

/** One-line per-leaf descriptions for the workflow engine budget. */
const WORKFLOW_BUDGET_DESCRIPTIONS: Record<keyof WorkflowBudget, string> = {
  scriptLoadMs: "Workflow script load timeout",
  scriptSliceMs: "Per-slice script execution budget",
  workerBootMs: "Workflow worker boot timeout",
  hostCallMs: "Host call (agent/tool) timeout",
  gateMs: "User gate wait timeout",
  phaseTotalMs: "Per-phase cap; 0 = unlimited",
  workflowTotalMs: "Overall workflow cap (must be > 0; 0 falls back to the default)",
  heartbeatStallMs: "Heartbeat stall diagnostic threshold",
  abortGraceMs: "Abort grace before worker teardown",
  terminateConfirmMs: "Worker terminate confirm timeout",
};

const WORKFLOW_BUDGET_SPECS: Record<string, SettingSpec> = Object.fromEntries(
  (Object.keys(DEFAULT_WORKFLOW_BUDGET) as (keyof WorkflowBudget)[]).map((leaf) => [
    `workflow.budget.${secondsKeyOf(leaf)}`,
    workflowSeconds(leaf),
  ]),
);

export const WORKFLOW_SETTING_SPECS: Record<string, SettingSpec> = {
  "workflow.enabled": bool("workflow.enabled", "Master switch for SubagentWorkflow"),
  "workflow.replayTtlS": seconds("workflow.replayTtlMs", { description: "Journal replay retention; 0 = unlimited" }),
  "workflow.replayScope": choice("workflow.replayScope", ["chain", "content"], "Replay cache match scope"),
  "workflow.runawayPolicy": choice(
    "workflow.runawayPolicy",
    ["diagnose_only", "terminate_on_stall"],
    "Action when the workflow heartbeat stalls",
  ),
  "workflow.isolationReplay": choice(
    "workflow.isolationReplay",
    ["verify", "off"],
    'Verify a replayed isolation:"worktree" agent() call\'s branch still points at the recorded commit before reusing it; off restores pre-plan (always-live) behavior',
  ),
  "workflow.journalDir": { kind: "string", path: "workflow.journalDir", description: "Workflow journal directory" },
  ...WORKFLOW_BUDGET_SPECS,
};
