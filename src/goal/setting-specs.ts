/**
 * goal · setting specs (#56 batch 2 ⑧, D8-3): this subsystem's slice of the settable-surface table. The entries
 * keep their original text and order; `config/setting-specs.ts` spreads the record at the same position, so the
 * listing order of `/agent settings` and the TUI editor is unchanged (pinned by tests/config/setting-specs-pin.test.ts).
 */
import { seconds, count, bool } from "../config/spec-helpers.js";
import type { SettingSpec } from "../config/spec-helpers.js";

export const GOAL_SETTING_SPECS: Record<string, SettingSpec> = {
  // /goal（goal-plan v4 条件 9）：goal.* 进白名单 + 设置编辑器可见。
  "goal.enabled": bool("goal.enabled", "Enable the /goal objective-driven loop"),
  "goal.maxTurns": count("goal.maxTurns", 1, "Default max continuation iterations per goal"),
  "goal.maxMinutes": count("goal.maxMinutes", 0, "Wall-clock cap per goal in minutes; 0 = unlimited"),
  "goal.budgetTokens": count("goal.budgetTokens", 0, "Token budget per goal (input+output); 0 = unlimited"),
  "goal.budgetCostUsd": {
    kind: "number",
    path: "goal.budgetCostUsd",
    min: 0,
    description: "Cost budget per goal in USD (cost.total); 0 = unlimited",
  },
  "goal.verifierType": {
    kind: "string",
    path: "goal.verifierType",
    description: "Agent type used for natural-language goal evaluation",
  },
  "goal.verifierModelHint": {
    kind: "string",
    path: "goal.verifierModelHint",
    description: "Model hint for the goal evaluator (should differ from the working model)",
  },
  "goal.evalTimeoutS": seconds("goal.evalTimeoutMs", {
    hint: "evaluation in-flight timeout; counts toward consecutive eval failures",
    description: "Goal evaluator timeout",
  }),
  "goal.untilCmdTimeoutS": seconds("goal.untilCmdTimeoutMs", { description: "until-cmd execution timeout" }),
  "goal.deliveryWatchdogS": seconds("goal.deliveryWatchdogMs", {
    hint: "no new run observed within this window => retry once, then stop the goal",
    description: "Continuation delivery watchdog",
  }),
};
