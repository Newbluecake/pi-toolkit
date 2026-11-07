/**
 * title · settings (#56 batch 2 ⑧): the `title` block's type, frozen defaults and never-throws parser
 * (design: docs/dev/title/plan.md). `src/config/settings.ts` imports ONLY this module for the block.
 */

/**
 * 会话标题模型生成 v2（任务 #12 + 随任务动态刷新，r1 评审裁定）：会话未命名时
 * 用 before_agent_start 生成 ≤20 字首标；之后按里程碑（新增用户输入数/累计
 * 运行时长）在 agent_settled 刷新——但只刷新自己写的标题，用户 /name 过的
 * 永久不再动。`enabled`/`model` 是 v1 既有两键，三个新键是刷新里程碑/额度。
 * 失败静默、在途互斥、过期结果隔离、所有权判定由模块不变量保证
 * （src/title/title.ts），不是设置项。逐字段容错解析见 parseTitleSettings
 * （never throws）。非 live（activate 时捕获，改后 /reload）。
 */
export interface TitleSettings {
  /** 总开关。false = 不注册任何 handler（行为与功能不存在时逐字节相同）。Default true。 */
  enabled: boolean;
  /**
   * 标题模型，strict `provider/id`；空串 = 跟随当前会话模型。默认
   * `zai-coding-cn/glm-5.3-flash`：订阅线（quota.providers 同源）里最便宜最快的
   * flash 档——本机订阅单价 $0.12/M in、$0.42/M out（订阅额度内边际成本为 0），
   * 一次标题 ≤512 token，成本可忽略；解析失败/异机无此 provider 时同样回落
   * 当前会话模型（memory.tidy.model 同款约定）。
   */
  model: string;
  /** 自上次生成以来新增用户输入数达到此值即可刷新；0 = 关闭此条件。默认 4。 */
  refreshEveryInputs: number;
  /** 新增用户输入 ≥1 且累计运行时长（分钟）达到此值即可刷新；0 = 关闭此条件。默认 15。 */
  refreshAfterMinutes: number;
  /**
   * `maxRefreshes` 的滚动统计窗口（分钟）：只统计这个窗口内的刷新次数，超出窗口的旧刷新
   * 不再计入额度（窗口滑走后又可以刷新，长会话的标题不会永久冻结）。`0` = legacy 口径，
   * `maxRefreshes` 退化为整个会话生命周期的上限（与引入本字段前逐字节相同）。默认 60。
   */
  refreshWindowMinutes: number;
  /**
   * 每 `refreshWindowMinutes` 窗口（或整个会话生命周期，当窗口=0）内的刷新上限（不含首标）；
   * 0 = 只首标不刷新。默认 5。
   */
  maxRefreshes: number;
}

/** Parse the optional `title` settings block（任务 #12 + v2 + rolling-window plan）：逐字段回退默认，never throws；model 串只 trim 不校验——strict 校验在运行时 parseStrictModelRef，解析失败自行回落会话模型。四个计数键（refreshEveryInputs/refreshAfterMinutes/refreshWindowMinutes/maxRefreshes）：`Number.isSafeInteger(x) && x >= 0` 否则回默认；字符串数字（如 "4"）不接受。 */
export function parseTitleSettings(input: unknown): TitleSettings {
  const defaults = DEFAULT_TITLE_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const nonNegativeInt = (raw: unknown, fallback: number): number =>
    typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : fallback;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    // 空串是合法哨兵（跟随会话模型）：保留；非字符串回默认。运行时 strict 解析
    // 失败/找不到 provider 也自行回落会话模型（见 TitleSettings.model 注释）。
    model: typeof value.model === "string" ? value.model.trim() : defaults.model,
    refreshEveryInputs: nonNegativeInt(value.refreshEveryInputs, defaults.refreshEveryInputs),
    refreshAfterMinutes: nonNegativeInt(value.refreshAfterMinutes, defaults.refreshAfterMinutes),
    refreshWindowMinutes: nonNegativeInt(value.refreshWindowMinutes, defaults.refreshWindowMinutes),
    maxRefreshes: nonNegativeInt(value.maxRefreshes, defaults.maxRefreshes),
  };
}

export const DEFAULT_TITLE_SETTINGS: TitleSettings = {
  enabled: true,
  model: "zai-coding-cn/glm-5.3-flash",
  refreshEveryInputs: 4,
  refreshAfterMinutes: 15,
  refreshWindowMinutes: 60,
  maxRefreshes: 5,
};
