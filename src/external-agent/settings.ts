/**
 * external-agent · settings (#56 batch 2 ⑧): the `externalAgents` block's types, frozen defaults and
 * never-throws parser (droid pricing refs are validated with the pure `parseStrictModelRef`, external-agent
 * plan §2.8). `src/config/settings.ts` imports ONLY this module for the block (the secure-domain force-off of
 * `externalAgents.droid.enabled` stays in the aggregator).
 */
import type { ExternalPriceRates } from "../core/types.js";
import { parseStrictModelRef } from "../config/model-hint.js";

export type ExternalProtocolCheck = "strict" | "warn";

/** "provider/id"（用该 pi 模型的价格）| "unpriced" | 显式单价（USD/1M，四项必填、有限、≥0）。 */
export type DroidPricingOverride = string | ExternalPriceRates;

export interface DroidAgentSettings {
  enabled: boolean; // 默认 false；非 live（stack 构建时读）
  binary: string; // 默认 "droid"；非 live
  protocolCheck: ExternalProtocolCheck; // 默认 "strict"；非 live
  models: string[]; // 提示词展示的 droid 模型 id；[] = 自动
  advertiseMax: number; // 默认 12，整数 0..50
  injectMemory: boolean; // 默认 true（U5）
  pricing: Record<string, DroidPricingOverride>; // 默认 {}；键 = droid 模型 id
  catalogTtlMs: number; // 文件键 catalogTtlS，默认 86400s，60s..30d
  requestTimeoutMs: number; // 文件键 requestTimeoutS，默认 15s，1..120s
  initTimeoutMs: number; // 文件键 initTimeoutS，默认 20s，5..120s
  killGraceMs: number; // 文件键 killGraceS，默认 2s，0.2..30s
}

export interface ExternalAgentsSettings {
  droid: DroidAgentSettings;
}

export const DEFAULT_EXTERNAL_AGENTS_SETTINGS: ExternalAgentsSettings = {
  droid: {
    enabled: false,
    binary: "droid",
    protocolCheck: "strict",
    models: [],
    advertiseMax: 12,
    injectMemory: true,
    pricing: {},
    catalogTtlMs: 86_400_000,
    requestTimeoutMs: 15_000,
    initTimeoutMs: 20_000,
    killGraceMs: 2_000,
  },
};

/** droid 模型 id / pricing 键的合法字符集（§2.8）。 */
const EXTERNAL_MODEL_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** 解析 externalAgents 块：未知键忽略；逐项非法回退默认；never throws。关闭态字节一致要求：
 *  迁移（migrateSettingsFileTimeUnits）只转换文件里已存在的键，缺 externalAgents 的文件不写入任何新键。 */
export function parseExternalAgentsSettings(input: unknown): ExternalAgentsSettings {
  const defaults = DEFAULT_EXTERNAL_AGENTS_SETTINGS.droid;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { droid: { ...defaults } };
  const droid = (input as Record<string, unknown>).droid;
  if (!droid || typeof droid !== "object" || Array.isArray(droid)) return { droid: { ...defaults } };
  const value = droid as Record<string, unknown>;
  // 时长（内部毫秒）：非有限数或越界 ⇒ 回默认（不静默 clamp，parseBashJobsSettings 同款）。
  const duration = (raw: unknown, fallback: number, min: number, max: number): number => {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max) return fallback;
    return raw;
  };
  const binary =
    typeof value.binary === "string" && value.binary.length > 0 && !value.binary.includes("\0")
      ? value.binary
      : defaults.binary;
  const models: string[] = [];
  if (Array.isArray(value.models)) {
    for (const id of value.models) {
      if (typeof id === "string" && EXTERNAL_MODEL_KEY_RE.test(id) && !models.includes(id)) models.push(id);
      if (models.length >= 50) break;
    }
  }
  const pricing: Record<string, DroidPricingOverride> = {};
  if (value.pricing && typeof value.pricing === "object" && !Array.isArray(value.pricing)) {
    for (const [id, raw] of Object.entries(value.pricing as Record<string, unknown>)) {
      if (!EXTERNAL_MODEL_KEY_RE.test(id)) {
        console.warn(`[pi-subagent] externalAgents.droid.pricing.${id} ignored: invalid model id`);
        continue;
      }
      let ok = false;
      if (raw === "unpriced" || (typeof raw === "string" && parseStrictModelRef(raw) !== undefined)) ok = true;
      else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const r = raw as Record<string, unknown>;
        const rate = (k: string): boolean => typeof r[k] === "number" && Number.isFinite(r[k]) && r[k] >= 0;
        ok = rate("input") && rate("output") && rate("cacheRead") && rate("cacheWrite");
      }
      if (ok) pricing[id] = raw as DroidPricingOverride;
      else
        console.warn(
          `[pi-subagent] externalAgents.droid.pricing.${id} ignored: expected "unpriced", a strict provider/id, or explicit USD/1M rates`,
        );
    }
  }
  return {
    droid: {
      enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
      binary,
      protocolCheck:
        value.protocolCheck === "warn" || value.protocolCheck === "strict"
          ? value.protocolCheck
          : defaults.protocolCheck,
      models,
      advertiseMax:
        typeof value.advertiseMax === "number" &&
        Number.isInteger(value.advertiseMax) &&
        value.advertiseMax >= 0 &&
        value.advertiseMax <= 50
          ? value.advertiseMax
          : defaults.advertiseMax,
      injectMemory: typeof value.injectMemory === "boolean" ? value.injectMemory : defaults.injectMemory,
      pricing,
      catalogTtlMs: duration(value.catalogTtlMs, defaults.catalogTtlMs, 60_000, 2_592_000_000),
      requestTimeoutMs: duration(value.requestTimeoutMs, defaults.requestTimeoutMs, 1_000, 120_000),
      initTimeoutMs: duration(value.initTimeoutMs, defaults.initTimeoutMs, 5_000, 120_000),
      killGraceMs: duration(value.killGraceMs, defaults.killGraceMs, 200, 30_000),
    },
  };
}
