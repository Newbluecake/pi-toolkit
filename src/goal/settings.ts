/**
 * goal · settings (#56 batch 2 ⑧): the `goal` block's type, frozen defaults and never-throws parser
 * (docs/dev/goal/goal-plan.md v4). Duration fields (`*Ms` internal, `*S` on disk) stay registered in
 * `TIME_SETTING_MS_PATHS`; `maxMinutes` is a minutes field outside the time-unit contract.
 * `src/config/settings.ts` imports ONLY this module for the block.
 */

/**
 * /goal 目标驱动持续运行（docs/dev/goal/goal-plan.md v4）。逐字段容错解析见
 * parseGoalSettings。时长字段（*Ms 内部毫秒、文件存 *S 秒）必须登记进
 * TIME_SETTING_MS_PATHS；maxMinutes 是分钟字段，不在时长规约内。
 */
export interface GoalSettings {
  /** Master switch；false 时 /goal 命令仍在但 hook 完全不评估。Default true. */
  enabled: boolean;
  /** 主动迭代轮数封顶（--max-turns 缺省值）。Default 20。 */
  maxTurns: number;
  /** wall-clock 封顶（分钟），在评估点检查、滞后一整轮（v4 M-h）；0 = 不限。Default 120。 */
  maxMinutes: number;
  /** 累计 token 预算（仅 input+output，v4 条件 6）；0 = 不限。 */
  budgetTokens: number;
  /** 累计成本预算（美元，cost.total 主口径；verifier 成本计入）；0 = 不限。 */
  budgetCostUsd: number;
  /** 评估器 agent 类型（D2：不新建类型，复用现成 verifier + 三重覆盖）。 */
  verifierType: string;
  /** 评估器模型 hint（D1：判定模型 ≠ 干活模型，默认 sonnet-5 覆盖主会话跑 k3 系的常见情况）。 */
  verifierModelHint: string;
  /** 单次评估超时（v4 条件 10：闩锁看门狗强制解锁并计入连败）。Default 300s。 */
  evalTimeoutMs: number;
  /** until-cmd 执行超时（C2）。Default 300s。 */
  untilCmdTimeoutMs: number;
  /** 续跑投递看门狗（v4 条件 4：未观察到新 run 则重试一次，再失败 → stopped）。Default 30s。 */
  deliveryWatchdogMs: number;
}

/**
 * /goal settings 块解析：逐字段容错、never throws（parseBashJobsSettings 同款
 * 风格）。数字须 finite 且 ≥ 0；verifierType/verifierModelHint 为空串回落默认
 * （exactOptionalPropertyTypes：字段总是存在，不设可选键）。
 */
export function parseGoalSettings(input: unknown): GoalSettings {
  const defaults = DEFAULT_GOAL_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const num = (raw: unknown, fallback: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : fallback;
  const int = (raw: unknown, fallback: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && Number.isInteger(raw) && raw >= 0 ? raw : fallback;
  const str = (raw: unknown, fallback: string): string => (typeof raw === "string" && raw.length > 0 ? raw : fallback);
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    maxTurns: int(value.maxTurns, defaults.maxTurns),
    maxMinutes: int(value.maxMinutes, defaults.maxMinutes),
    budgetTokens: int(value.budgetTokens, defaults.budgetTokens),
    budgetCostUsd: num(value.budgetCostUsd, defaults.budgetCostUsd),
    verifierType: str(value.verifierType, defaults.verifierType),
    verifierModelHint: str(value.verifierModelHint, defaults.verifierModelHint),
    evalTimeoutMs: num(value.evalTimeoutMs, defaults.evalTimeoutMs),
    untilCmdTimeoutMs: num(value.untilCmdTimeoutMs, defaults.untilCmdTimeoutMs),
    deliveryWatchdogMs: num(value.deliveryWatchdogMs, defaults.deliveryWatchdogMs),
  };
}

export const DEFAULT_GOAL_SETTINGS: GoalSettings = {
  enabled: true,
  maxTurns: 20,
  maxMinutes: 120,
  budgetTokens: 0,
  budgetCostUsd: 0,
  verifierType: "verifier",
  verifierModelHint: "cloudrouter-anthropic/claude-sonnet-5",
  evalTimeoutMs: 300_000,
  untilCmdTimeoutMs: 300_000,
  deliveryWatchdogMs: 30_000,
};
