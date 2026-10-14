/**
 * Adapter registry (docs/dev/quota/quota-plan.md §3.7): the complete
 * `QuotaProviderId → ProviderAdapter` map plus `selectAdapters` filtering.
 * Runtime identifiers keep the `pi-subagent`-era names on purpose (AGENTS.md).
 */

import type { QuotaProviderId, StaticQuotaProviderId } from "../types.js";
import { QUOTA_PROVIDER_IDS, isDroidQuotaId } from "../types.js";
import type { DroidAdapterPair } from "./droid.js";
import { kimiAdapter } from "./kimi.js";
import type { ProviderAdapter } from "./types.js";
import { zaiAdapter, zaiOverseasAdapter } from "./zai.js";

/**
 * 静态三池（kimi/zai）注册表。droid 两个池不在此列——它们由 `createDroidAdapters`
 * 按 stack 构造（pair 闭包共享在途请求），经 `selectAdapters` 的第二个参数注入。
 * `tests/quota/adapters-zai.test.ts` 钉死本表的三键形状。
 */
export const ADAPTERS: Readonly<Record<StaticQuotaProviderId, ProviderAdapter>> = {
  "zai-coding-cn": zaiAdapter,
  zai: zaiOverseasAdapter,
  "kimi-coding": kimiAdapter,
};

/**
 * 白名单过滤（settings.quota.providers 解析成 id 后经此筛选）；按 QUOTA_PROVIDER_IDS
 * 注册序输出。droid 池 id 取自 pair；pair 缺席（droid 未启用/未接线）⇒ 跳过，
 * 输出与改动前逐字节一致（关闭态 D11：零适配器 ⇒ 零网络、零凭据读取）。
 */
export function selectAdapters(
  enabled: readonly QuotaProviderId[],
  droid?: DroidAdapterPair | undefined,
): readonly ProviderAdapter[] {
  const out: ProviderAdapter[] = [];
  for (const id of QUOTA_PROVIDER_IDS) {
    if (!enabled.includes(id)) continue;
    if (isDroidQuotaId(id)) {
      if (droid !== undefined) out.push(id === "droid-standard" ? droid.standard : droid.core);
      continue;
    }
    out.push(ADAPTERS[id]);
  }
  return out;
}

export { kimiAdapter, zaiAdapter, zaiOverseasAdapter };
