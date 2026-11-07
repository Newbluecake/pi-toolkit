/**
 * schedule · settings (#56 batch 2 ⑧): the `schedule` block's types, bounds, frozen defaults and never-throws parser.
 * `src/config/settings.ts` imports ONLY this module for the block.
 */

// ── 定时任务（scheduled-reports plan r3 §10.3，S0 冻结面）：设置形状 / 默认值 / 解析。全部非 live。 ──
//
// this file may NOT value-import the schedule modules (tests/web-hub/boundary.test.ts
// freezes the settings import closure); the ranges below are literal mirrors of
// `src/schedule/core/spec.ts`'s SCHED_BG_TIMEOUT_* constants — parity pinned by
// tests/config/schedule-settings.test.ts.

/** Hard floor / ceiling (ms) for both timeout knobs; the stored file keys are integer seconds (`*S`). */
export const SCHEDULE_TIMEOUT_MIN_MS = 60_000;
export const SCHEDULE_TIMEOUT_MAX_MS = 14_400_000;

export interface ScheduleSettings {
  /** 总开关，默认 false ⇒ 零面（工具/命令/段/HubConfig/旧文件写入全部不变）。 */
  enabled: boolean;
  /** storeDir 覆盖（绝对路径，JSON-only，不进 SETTING_SPECS——bashJobs.dir 同款）；缺省 = `<agentDir>/schedules`（A0 解析并做 vault 双检）。 */
  dir?: string;
  /** background 任务未指定 `timeoutS` 时的默认值（文件键 `schedule.defaultTimeoutS`，秒）。默认 1800s；总是 ≤ maxTimeoutMs。 */
  defaultTimeoutMs: number;
  /** 任务 `timeoutS` 上限（文件键 `schedule.maxTimeoutS`，秒）。默认且硬上限 14400s。 */
  maxTimeoutMs: number;
}

export const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
  enabled: false,
  defaultTimeoutMs: 1_800_000,
  maxTimeoutMs: SCHEDULE_TIMEOUT_MAX_MS,
};

/**
 * 解析 `schedule` 组（已过 normalizeTimeUnits：`*S` 文件键此时是 `*Ms` 毫秒）：逐字段回落默认，永不抛错。
 * 时长须为整秒（ms % 1000 === 0）且落在 [60s, 14400s]；`dir` 只接受无 NUL 的绝对路径。
 * 最后把 defaultTimeoutMs 收敛到 ≤ maxTimeoutMs。
 */
export function parseScheduleSettings(input: unknown): ScheduleSettings {
  const d = DEFAULT_SCHEDULE_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...d };
  const value = input as Record<string, unknown>;
  const timeout = (raw: unknown, fallback: number): number =>
    typeof raw === "number" &&
    Number.isInteger(raw) &&
    raw % 1000 === 0 &&
    raw >= SCHEDULE_TIMEOUT_MIN_MS &&
    raw <= SCHEDULE_TIMEOUT_MAX_MS
      ? raw
      : fallback;
  const maxTimeoutMs = timeout(value.maxTimeoutMs, d.maxTimeoutMs);
  const defaultTimeoutMs = Math.min(timeout(value.defaultTimeoutMs, d.defaultTimeoutMs), maxTimeoutMs);
  const dir =
    typeof value.dir === "string" && value.dir.startsWith("/") && !value.dir.includes("\0") && value.dir.length <= 4096
      ? value.dir
      : undefined;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : d.enabled,
    ...(dir === undefined ? {} : { dir }),
    defaultTimeoutMs,
    maxTimeoutMs,
  };
}

// ── 外部 agent（external-agent plan §2.8，冻结面）：设置形状 / 默认值 / 解析 ──
