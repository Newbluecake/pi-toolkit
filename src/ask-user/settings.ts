/**
 * ask-user · settings (#56 batch 2 ⑧): the `askUser` block's types, frozen defaults and never-throws parsers
 * (EnabledGroup + the background-interrupt sub-block). `src/config/settings.ts` imports ONLY this module for the block.
 */
import type { EnabledGroup } from "../config/enabled-group.js";

/**
 * ask-user background interrupt (docs/dev/ask-user-async/plan.md §5.2.1/§6.1,
 * P2): main-session TUI default ON, RPC default OFF (rpc=true 只提供中途打断，
 * 已知限制：pi 不向客户端发撤回，对话框残留——plan §7.1). All four durations
 * are stored in the settings FILE as integer seconds under the `*S` name
 * (registered in TIME_SETTING_MS_PATHS) and parsed into internal milliseconds;
 * per-field fallback on any illegal value (non-number / NaN / non-finite /
 * non-integer / out of range), never throws — parseHudSettings 同款。
 * `maxDeferMs < quietMs` is clamped UP to quietMs (plan §5.2.1).
 */
export interface AskUserBackgroundInterruptSettings {
  /** Master switch for the background-completion interrupt (main-session TUI). Default true. */
  enabled: boolean;
  /** 合并窗口：首个完成到达后合并后续完成的窗口。默认 1s，合法 0–10s（0 = 下一个宏任务）。 */
  delayMs: number;
  /** 安静期：最后一次按键后等待多久才落下打断。默认 4s，合法 0–30s（0 = 无活跃保护）。 */
  quietMs: number;
  /** 活跃推迟上限：窗口到点后因持续打字最多再推迟。默认 20s，合法 0–120s，钳为 ≥ quietMs。 */
  maxDeferMs: number;
  /** 驻留期：重问框挂载后不落下打断的宽限。默认 10s，合法 0–60s（0 = 无驻留）。 */
  reaskDwellMs: number;
  /** 每题打断预算（用户拍板 3）：耗尽后回到今天的阻塞行为（已接受的降级，§5.2.4）。合法 1–10。 */
  maxPerQuestion: number;
  /** RPC 模式是否提供中途打断（默认 false；关 = RPC 路径与今天逐字节一致，plan §7.1）。 */
  rpc: boolean;
}

/** Merged ask_user settings: EnabledGroup + the background-interrupt sub-block. */
export interface AskUserSettings extends EnabledGroup {
  backgroundInterrupt: AskUserBackgroundInterruptSettings;
}

/**
 * Parse the `askUser` settings block (ask-user-async plan §6.1, P2):
 * EnabledGroup semantics plus the `backgroundInterrupt` sub-block,
 * field-by-field fallback to DEFAULT_ASK_USER_SETTINGS, never throws
 * (parseTodoSettings 同款). The four durations arrive ALREADY in internal
 * milliseconds (normalizeTimeUnits converts the on-disk integer `*S` seconds
 * up front); each must be a finite integer inside its §5.2.1 range, and
 * `maxDeferMs < quietMs` clamps UP to quietMs.
 */
export function parseAskUserSettings(input: unknown): AskUserSettings {
  const defaults = DEFAULT_ASK_USER_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ...defaults, backgroundInterrupt: { ...defaults.backgroundInterrupt } };
  const record = input as Record<string, unknown>;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
    backgroundInterrupt: parseBackgroundInterruptSettings(record.backgroundInterrupt, defaults.backgroundInterrupt),
  };
}

function parseBackgroundInterruptSettings(
  input: unknown,
  defaults: AskUserBackgroundInterruptSettings,
): AskUserBackgroundInterruptSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const record = input as Record<string, unknown>;
  const rangedMs = (value: unknown, fallback: number, max: number): number =>
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= max
      ? value
      : fallback;
  const quietMs = rangedMs(record.quietMs, defaults.quietMs, 30_000);
  const maxDeferMs = rangedMs(record.maxDeferMs, defaults.maxDeferMs, 120_000);
  const maxPerQuestion = record.maxPerQuestion;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
    delayMs: rangedMs(record.delayMs, defaults.delayMs, 10_000),
    quietMs,
    // §5.2.1：≥ quiet（否则钳为 quiet）；但显式 0 保留——0 是「永不因活跃推迟」
    // 的特殊语义（interrupt.ts normalizeInterruptSettings 同款规则，2026-10-05 验收
    // 发现此处无条件钳制会把 maxDeferS:0 错成 quietS 默认值）。
    maxDeferMs: maxDeferMs === 0 ? 0 : Math.max(maxDeferMs, quietMs),
    reaskDwellMs: rangedMs(record.reaskDwellMs, defaults.reaskDwellMs, 60_000),
    maxPerQuestion:
      typeof maxPerQuestion === "number" &&
      Number.isFinite(maxPerQuestion) &&
      Number.isInteger(maxPerQuestion) &&
      maxPerQuestion >= 1 &&
      maxPerQuestion <= 10
        ? maxPerQuestion
        : defaults.maxPerQuestion,
    rpc: typeof record.rpc === "boolean" ? record.rpc : defaults.rpc,
  };
}

export const DEFAULT_ASK_USER_SETTINGS: AskUserSettings = {
  enabled: true,
  backgroundInterrupt: {
    enabled: true,
    delayMs: 1_000,
    quietMs: 4_000,
    maxDeferMs: 20_000,
    reaskDwellMs: 10_000,
    maxPerQuestion: 3,
    rpc: false,
  },
};
