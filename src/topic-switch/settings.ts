/**
 * topic-switch · settings (plan.md §P1 "settings.ts").
 *
 * `src/config/settings.ts` (P3b) imports ONLY this module for the
 * `topicSwitch` block: it owns the interface, the frozen defaults and the
 * never-throws parser. Input is the post-`normalizeTimeUnits` **ms shape**
 * (`judgeTimeoutMs`, …) — the `*S ⇄ *Ms` file-key boundary belongs to
 * `config/settings.ts` + `TIME_SETTING_MS_PATHS`, not here. Out-of-range or
 * wrongly-typed fields fall back to defaults field-by-field
 * (parseTitleSettings 同款容错).
 */

export interface TopicSwitchSettings {
  enabled: boolean;
  costThresholdUsd: number;
  /** strict `provider/id`; runtime parseStrictModelRef failure is treated as empty (D3 chain falls through). */
  model: string;
  judgeTimeoutMs: number;
  minConfidence: number;
  confirmTimeoutMs: number;
  minChars: number;
  /** cooldown lifts once context regrew by this many tokens (0 ⇒ only a compaction lifts it). */
  regrowTokens: number;
  expirySlackMs: number;
  /** JSON-only live-acceptance seam (assumed cold TTL); NOT exposed in SETTING_SPECS. 0 = off. */
  debugAssumedTtlMs: number;
}

export const DEFAULT_TOPIC_SWITCH_SETTINGS: Readonly<TopicSwitchSettings> = Object.freeze({
  enabled: true,
  costThresholdUsd: 0.5,
  model: "",
  judgeTimeoutMs: 6_000,
  minConfidence: 0.7,
  confirmTimeoutMs: 30_000,
  minChars: 8,
  regrowTokens: 100_000,
  expirySlackMs: 30_000,
  debugAssumedTtlMs: 0,
});

/** finite number within [min, max] (inclusive), else fallback. */
function inRange(raw: unknown, min: number, max: number, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback;
}

/** Parse the optional `topicSwitch` block: field-by-field fallback to defaults, never throws. */
export function parseTopicSwitchSettings(input: unknown): TopicSwitchSettings {
  const d = DEFAULT_TOPIC_SWITCH_SETTINGS;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...d };
  const v = input as Record<string, unknown>;
  // `debugAssumedTtlMs` valid domain is 0 OR 10s–3600s — the 1–9.999s band is invalid (falls back to 0).
  const debugTtl = inRange(v.debugAssumedTtlMs, 10_000, 3_600_000, d.debugAssumedTtlMs);
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : d.enabled,
    costThresholdUsd: inRange(v.costThresholdUsd, Number.MIN_VALUE, 100, d.costThresholdUsd),
    model: typeof v.model === "string" ? v.model.trim() : d.model,
    judgeTimeoutMs: inRange(v.judgeTimeoutMs, 1_000, 30_000, d.judgeTimeoutMs),
    minConfidence: inRange(v.minConfidence, 0, 1, d.minConfidence),
    confirmTimeoutMs: inRange(v.confirmTimeoutMs, 5_000, 300_000, d.confirmTimeoutMs),
    minChars:
      typeof v.minChars === "number" && Number.isSafeInteger(v.minChars) && v.minChars >= 0 && v.minChars <= 200
        ? v.minChars
        : d.minChars,
    regrowTokens:
      typeof v.regrowTokens === "number" && Number.isSafeInteger(v.regrowTokens) && v.regrowTokens >= 0
        ? v.regrowTokens
        : d.regrowTokens,
    expirySlackMs: inRange(v.expirySlackMs, 0, 600_000, d.expirySlackMs),
    debugAssumedTtlMs: v.debugAssumedTtlMs === 0 ? 0 : debugTtl,
  };
}
