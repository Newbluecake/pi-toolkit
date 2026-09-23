/**
 * Adapter registry (docs/dev/quota/quota-plan.md §3.7): the complete
 * `QuotaProviderId → ProviderAdapter` map plus `selectAdapters` filtering.
 * Runtime identifiers keep the `pi-subagent`-era names on purpose (AGENTS.md).
 */

import type { QuotaProviderId } from "../types.js";
import { QUOTA_PROVIDER_IDS } from "../types.js";
import { kimiAdapter } from "./kimi.js";
import type { ProviderAdapter } from "./types.js";
import { zaiAdapter, zaiOverseasAdapter } from "./zai.js";

export const ADAPTERS: Readonly<Record<QuotaProviderId, ProviderAdapter>> = {
  "zai-coding-cn": zaiAdapter,
  zai: zaiOverseasAdapter,
  "kimi-coding": kimiAdapter,
};

/** 白名单过滤（settings.quota.providers 解析成 id 后经此筛选）；按注册序输出。 */
export function selectAdapters(enabled: readonly QuotaProviderId[]): readonly ProviderAdapter[] {
  return QUOTA_PROVIDER_IDS.filter((id) => enabled.includes(id)).map((id) => ADAPTERS[id]);
}

export { kimiAdapter, zaiAdapter, zaiOverseasAdapter };
