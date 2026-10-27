/**
 * hud · settings (#56 batch 2 ⑧): the `hud` block's type, frozen defaults and never-throws parser.
 * `src/config/settings.ts` imports ONLY this module for the block.
 */
import type { EnabledGroup } from "../config/enabled-group.js";

/**
 * HUD settings group. `autoFetchMinutes`: HUD 周期 `git fetch --quiet --prune`
 * 的间隔（分钟）——↑/↓ 计数对比的是本地 remote-tracking ref，不 fetch 就永远
 * 看不到别处推进的远程提交；0 = 关闭（只保留手动 /pi-hud-refresh）。
 */
export interface HudSettings extends EnabledGroup {
  autoFetchMinutes: number;
}

/** HUD 设置块解析：enabled 复用 EnabledGroup 语义，autoFetchMinutes 须 finite 且 ≥ 0；逐字段回落默认，never throws。 */
export function parseHudSettings(input: unknown): HudSettings {
  const defaults = DEFAULT_HUD_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const record = input as Record<string, unknown>;
  const minutes = record.autoFetchMinutes;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
    autoFetchMinutes:
      typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0 ? minutes : defaults.autoFetchMinutes,
  };
}

export const DEFAULT_HUD_SETTINGS: HudSettings = { enabled: true, autoFetchMinutes: 5 };
