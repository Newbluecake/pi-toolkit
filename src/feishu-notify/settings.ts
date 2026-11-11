/** Sparse unified settings: absence must not mask legacy-file / environment fallback. */
import type { Config } from "./core.js";

export interface FeishuNotifySettings extends Config {
  enabled: boolean;
}

const STRING_KEYS = ["webhookUrl", "secret"] as const;
const NUMBER_KEYS = [
  "waitNotifyTimeoutSec",
  "heartbeatIntervalSec",
  "idleNotifyTimeoutSec",
  "subagentFlushDebounceMs",
  "subagentDeliveryGraceMs",
] as const;
const BOOLEAN_KEYS = [
  "subagentSummaryEnabled",
  "subagentForegroundSummary",
  "requireBackgroundIdle",
  "watchDefault",
] as const;

/** Whitelist all twelve legacy leaves. null/invalid = absent; false/0/""/[] are explicit. */
export function parseNotifyFields(input: unknown): Config {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return {};
  const raw = input as Record<string, unknown>;
  const out: Config = {};
  for (const key of STRING_KEYS) if (typeof raw[key] === "string") out[key] = raw[key];
  for (const key of NUMBER_KEYS) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  for (const key of BOOLEAN_KEYS) if (typeof raw[key] === "boolean") out[key] = raw[key];
  if (Array.isArray(raw.waitNotifyTools) && raw.waitNotifyTools.every((value) => typeof value === "string")) {
    out.waitNotifyTools = [...raw.waitNotifyTools];
  }
  return out;
}

export function parseFeishuNotifySettings(input: unknown): FeishuNotifySettings {
  const enabled =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).enabled
      : undefined;
  return { enabled: typeof enabled === "boolean" ? enabled : true, ...parseNotifyFields(input) };
}
