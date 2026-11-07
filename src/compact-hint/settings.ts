/**
 * compact-hint · settings (#56 batch 2 ⑧): the `compact` block's types, frozen defaults and never-throws
 * parsers (`compact.dynamicThreshold` included). `src/config/settings.ts` imports ONLY this module for the block.
 */
import {
  DEFAULT_FORCE_THRESHOLD_PERCENT,
  DEFAULT_HINT_THRESHOLD_PERCENT,
  DEFAULT_USAGE_TICK_STEP_PERCENT,
} from "./threshold.js";

/** 动态阈值（dynamic-threshold-plan.md §11.1）：价格/缓存感知的 switch_context 提醒线。 */
export interface DynamicThresholdSettings {
  /** 默认 "on"（用户拍板 D1；风险由 min 合成 + force 不动 + off 逐字节回归兑住）。shadow = 全量计算 + 遥测 + status，不改任何模型可见字节。 */
  mode: "off" | "shadow" | "on";
  /** 地板：默认 35（研究 §7.4）。 */
  minHintPercent: number;
  /** 质量上限：默认 60 —— 未校准的安全上限（D8）。 */
  maxQualityPercent: number;
  /** 再发现成本 R：默认 $10 —— 经验先验，未跨模型校准（D2/§5.1）。 */
  rediscoveryUsd: number;
  /** 价格未知时的退化模式：默认 "static"（最保守 = 不改变现行行为）。 */
  unknownPriceMode: "static" | "quality";
}

export interface CompactSettings {
  enabled: boolean;
  hintThresholdPercent: number;
  /** Force-compaction line. With `forceScaling` on (the default) this is the
   *  anchor for a 1M-token window; the effective line rises 5 points per
   *  decade of window shrinkage (1M→88, 200k→91, 37k→95) before the reserve
   *  cap clamps it below pi's own automatic compaction line. */
  forceAtPercent: number;
  /** Scale `forceAtPercent` with the model's context window. Default true;
   *  set false to use the configured percentage literally on every window. */
  forceScaling: boolean;
  /** Absolute hint threshold in units of k tokens (default 500 = 500k used
   *  tokens). 0 = no absolute limit (percent only). Auto-disabled when the
   *  line strictly exceeds the model's context window. When both the percent
   *  and the absolute line apply, whichever fires first wins. */
  hintThresholdTokens: number;
  /** Absolute force threshold in units of k tokens; 0 = no absolute limit
   *  (default). Same auto-disable rule as hintThresholdTokens. */
  forceAtTokens: number;
  /** Coarsest step (percent points) between lightweight usage-tick reports.
   *  The grid is non-linear — it densifies toward the force ceiling (step/2
   *  within 2 steps of it, step/5 within 1) so reminders get more frequent as
   *  the threshold approaches. 0 disables ticks. Keeps the model aware of
   *  context usage before the reminder fires. */
  usageTickStepPercent: number;
  assumedReserveTokens?: number;
  /** 注册 `switch_context`（模型自写交接内容的上下文切换工具），并让 hint/force 层改为催它。
   *  Default true。false = 回到纯 compact_context 行为（docs/dev/context-switch/context-switch-plan.md §6）。 */
  switchTool: boolean;
  /** switchTool 开启时是否**同时**保留 `compact_context` 工具。Default false（彻底替换）。
   *  switchTool=false 时本项无意义：compact_context 总是注册。 */
  keepCompactTool: boolean;
  /** 越过强制线后，先硬性要求模型调用 `switch_context` 的次数；用完仍越线才回落到通用强制压缩。
   *  Default 1；0 = 不给机会，直接强制通用压缩。 */
  forceDemandTurns: number;
  /** 价格感知动态提醒线（docs/dev/compact-hint/dynamic-threshold-plan.md）。 */
  dynamicThreshold: DynamicThresholdSettings;
  /**
   * child-context-switch plan §4（用户确认 1）：子会话是否注册 switch_context 工具 +
   * turn_end/context/session_compact handler（另受 `compact.enabled && compact.switchTool` 与
   * §3.1 能力检测约束）。Default true。
   */
  childSessions: boolean;
  /**
   * child-context-switch plan §2.1/§4（评审 6）：每 run 切换上限，按分支上带
   * `details.source === "pi-toolkit:switch_context"` 的 fromHook compaction 条数计（resume 续写
   * 同一会话文件时计数延续）。Default 5；钳到 [1, 20]。
   */
  childMaxSwitches: number;
}

/** 动态阈值默认值（§11.2）：mode 默认 on（用户拍板 D1）；maxQualityPercent/rediscoveryUsd 均未校准。 */
export const DEFAULT_DYNAMIC_THRESHOLD_SETTINGS: DynamicThresholdSettings = {
  mode: "on",
  minHintPercent: 35,
  maxQualityPercent: 60,
  rediscoveryUsd: 10,
  unknownPriceMode: "static",
};

/** 解析 compact.dynamicThreshold（§11.1）：逐字段回退默认、交叉校验 min>max ⇒ 两者回默认、枚举白名单，永不抛。 */
export function parseDynamicThresholdSettings(input: unknown): DynamicThresholdSettings {
  const defaults = DEFAULT_DYNAMIC_THRESHOLD_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const mode = value.mode;
  const unknownPriceMode = value.unknownPriceMode;
  const percent = (raw: unknown, fallback: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 100 ? Math.floor(raw) : fallback;
  const min = percent(value.minHintPercent, defaults.minHintPercent);
  const max = percent(value.maxQualityPercent, defaults.maxQualityPercent);
  const crossed = min > max; // 交叉校验：min > max ⇒ 两者都回默认（§11.1）
  const rediscovery = value.rediscoveryUsd;
  return {
    mode: mode === "off" || mode === "shadow" || mode === "on" ? mode : defaults.mode,
    minHintPercent: crossed ? defaults.minHintPercent : min,
    maxQualityPercent: crossed ? defaults.maxQualityPercent : max,
    rediscoveryUsd:
      typeof rediscovery === "number" && Number.isFinite(rediscovery) && rediscovery >= 0
        ? rediscovery
        : defaults.rediscoveryUsd,
    unknownPriceMode:
      unknownPriceMode === "static" || unknownPriceMode === "quality" ? unknownPriceMode : defaults.unknownPriceMode,
  };
}

/** Parse the optional model-triggered context compaction settings block. */
export function parseCompactSettings(input: unknown): CompactSettings {
  const defaults = DEFAULT_COMPACT_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const threshold = value.hintThresholdPercent;
  const hintThresholdPercent =
    typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 1 && threshold <= 100
      ? Math.floor(threshold)
      : threshold === 0
        ? 0
        : defaults.hintThresholdPercent;
  const force = value.forceAtPercent;
  const forceAtPercent =
    typeof force === "number" &&
    Number.isFinite(force) &&
    force >= 0 &&
    force <= 100 &&
    (force === 0 || Math.floor(force) > hintThresholdPercent)
      ? Math.floor(force)
      : defaults.forceAtPercent;
  const hintTokens = value.hintThresholdTokens;
  const hintThresholdTokens =
    typeof hintTokens === "number" && Number.isFinite(hintTokens) && hintTokens >= 0
      ? Math.floor(hintTokens)
      : defaults.hintThresholdTokens;
  const forceTokens = value.forceAtTokens;
  const forceAtTokens =
    typeof forceTokens === "number" &&
    Number.isFinite(forceTokens) &&
    forceTokens >= 0 &&
    (forceTokens === 0 || Math.floor(forceTokens) > hintThresholdTokens)
      ? Math.floor(forceTokens)
      : defaults.forceAtTokens;
  const reserve = value.assumedReserveTokens;
  const tick = value.usageTickStepPercent;
  const demandTurns = value.forceDemandTurns;
  return {
    switchTool: typeof value.switchTool === "boolean" ? value.switchTool : defaults.switchTool,
    keepCompactTool: typeof value.keepCompactTool === "boolean" ? value.keepCompactTool : defaults.keepCompactTool,
    forceDemandTurns:
      typeof demandTurns === "number" && Number.isFinite(demandTurns) && demandTurns >= 0 && demandTurns <= 5
        ? Math.floor(demandTurns)
        : defaults.forceDemandTurns,
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    hintThresholdPercent,
    forceAtPercent,
    forceScaling: typeof value.forceScaling === "boolean" ? value.forceScaling : defaults.forceScaling,
    hintThresholdTokens,
    forceAtTokens,
    usageTickStepPercent:
      typeof tick === "number" && Number.isFinite(tick) && (tick === 0 || (tick >= 5 && tick <= 100))
        ? Math.floor(tick)
        : defaults.usageTickStepPercent,
    dynamicThreshold: parseDynamicThresholdSettings(value.dynamicThreshold),
    childSessions: typeof value.childSessions === "boolean" ? value.childSessions : defaults.childSessions,
    childMaxSwitches:
      typeof value.childMaxSwitches === "number" &&
      Number.isFinite(value.childMaxSwitches) &&
      value.childMaxSwitches >= 1 &&
      value.childMaxSwitches <= 20
        ? Math.floor(value.childMaxSwitches)
        : defaults.childMaxSwitches,
    ...(typeof reserve === "number" && Number.isFinite(reserve) && reserve > 0
      ? { assumedReserveTokens: Math.floor(reserve) }
      : {}),
  };
}

export const DEFAULT_COMPACT_SETTINGS: CompactSettings = {
  enabled: true,
  hintThresholdPercent: DEFAULT_HINT_THRESHOLD_PERCENT,
  forceAtPercent: DEFAULT_FORCE_THRESHOLD_PERCENT,
  forceScaling: true,
  hintThresholdTokens: 500,
  forceAtTokens: 0,
  usageTickStepPercent: DEFAULT_USAGE_TICK_STEP_PERCENT,
  switchTool: true,
  keepCompactTool: false,
  forceDemandTurns: 1,
  dynamicThreshold: DEFAULT_DYNAMIC_THRESHOLD_SETTINGS,
  childSessions: true,
  childMaxSwitches: 5,
};
