/**
 * Adapter-layer contract (docs/dev/quota/quota-plan.md §3.7): the narrow
 * re-export face of `src/quota/types.ts` shared by adapters and the quota
 * service, plus one small extension (`QuotaAdapter`) that pins each adapter's
 * factory default baseUrl — the service/stack layer maps
 * `settings.quota.*BaseUrl` onto `AdapterDeps.baseUrl` at runtime; adapters
 * never hardcode hosts outside request construction.
 */

export type {
  AdapterDeps,
  FetchJson,
  ProviderAdapter,
  QuotaProviderId,
  QuotaSnapshot,
  QuotaWindow,
  QuotaWindowsSnapshot,
  WindowScope,
} from "../types.js";
export type { Millis } from "../../core/types.js";

import type { ProviderAdapter } from "../types.js";

/**
 * `ProviderAdapter` + 静态默认值。`defaultBaseUrl` 只是 settings 缺省时的
 * 参考（settings 解析层已内置同样的默认串）；请求 URL 一律取注入的
 * `deps.baseUrl`。结构上是 ProviderAdapter 的超集，可直接装进
 * `Record<QuotaProviderId, ProviderAdapter>`。
 */
export interface QuotaAdapter extends ProviderAdapter {
  readonly defaultBaseUrl: string;
}

/** 解析层公共守卫：plain object（非 null / 非数组）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析层公共钳制：已用百分比 0..100。 */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** 有限数字守卫（typeof 守卫纪律：无一处直接下标解引用）。 */
export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
