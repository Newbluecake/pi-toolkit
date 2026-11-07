/**
 * The shared `{ enabled }` settings group (webSearch / date / feishuNotify / sessionNav, and the base of the
 * askUser / todo / hud blocks). Split out of `config/settings.ts` (#56 batch 2 ⑧) so subsystem `settings.ts`
 * files can build on it without importing the aggregator.
 */

/** Simple on/off settings group shared by the merged plugins (webSearch / todo). */
export interface EnabledGroup {
  enabled: boolean;
}

// ── 流量录制（traffic-merge plan §2.2）：设置形状 / 默认值 / 解析。全部非 live。 ──

/** Parse an `{enabled}` on/off group (merged plugins); field-level fallback to defaults, never throws. */
export function parseEnabledGroup(input: unknown, defaults: EnabledGroup): EnabledGroup {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const enabled = (input as Record<string, unknown>).enabled;
  return { enabled: typeof enabled === "boolean" ? enabled : defaults.enabled };
}
