/**
 * Quota-aware dispatch (docs/dev/quota/quota-plan.md §3.1): pure types +
 * constants shared by every `src/quota/` module. Zero pi imports — only the
 * type-only `Millis` from core (plan §2 分层纪律: this file stays unit-testable
 * under plain node).
 *
 * M2（评审修订）：`CredentialResolver` 的接口定义放在这里（紧邻
 * `ProviderAdapter`），`credentials.ts` 只 `import type` 引用——这样
 * `QuotaServiceDeps` 不依赖 C 包编译产物。
 */

import type { Millis } from "../core/types.js";

/** auth store / pi model registry 的 provider id（二者逐字相同，见 plan §0）。 */
export type QuotaProviderId = "zai-coding-cn" | "zai" | "kimi-coding";

export const QUOTA_PROVIDER_IDS: readonly QuotaProviderId[] = ["zai-coding-cn", "zai", "kimi-coding"];

export function isQuotaProviderId(value: string): value is QuotaProviderId {
  return (QUOTA_PROVIDER_IDS as readonly string[]).includes(value);
}

export type WindowScope = "5h" | "week";

/** L0 静默 / L1 提示 / L2 建议 / L3 强烈。数值可比较——provider 级取 max。 */
export type LadderLevel = 0 | 1 | 2 | 3;

export interface QuotaWindow {
  readonly scope: WindowScope;
  /** 已用百分比，0..100，解析层已 clamp。 */
  readonly usedPct: number;
  /** 窗口重置的 epoch ms；解析不出时 undefined（预测层据此关闭 ETA-vs-reset 比较）。 */
  readonly resetAt?: Millis | undefined;
}

export interface QuotaWindowsSnapshot {
  readonly provider: QuotaProviderId;
  readonly kind: "windows";
  readonly windows: readonly QuotaWindow[];
  readonly fetchedAt: Millis;
  /** GLM 的 data.level（"max"/"pro"…），仅用于 HUD 展示。 */
  readonly plan?: string | undefined;
}

/** 快照统一为窗口型（余额型已随 moonshot 适配器移除，用户决策）。 */
export type QuotaSnapshot = QuotaWindowsSnapshot;

/** 网络层注入口：永不抛，失败/非 JSON/非 2xx 一律 undefined。 */
export type FetchJson = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>>; readonly signal?: AbortSignal | undefined },
) => Promise<unknown | undefined>;

export interface AdapterDeps {
  readonly fetchJson: FetchJson;
  /** 已解析好的裸 key；undefined 时适配器必须立刻返回 undefined（不得发请求）。 */
  readonly apiKey: string | undefined;
  readonly now: () => Millis;
  readonly baseUrl: string;
  readonly userAgent: string;
  readonly signal?: AbortSignal | undefined;
}

export interface ProviderAdapter {
  readonly id: QuotaProviderId;
  readonly kind: QuotaSnapshot["kind"];
  /** 静默降级契约：**绝不抛**，任何异常/形状不符返回 undefined。 */
  fetchQuota(deps: AdapterDeps): Promise<QuotaSnapshot | undefined>;
}

/**
 * M2（评审修订）：接口定义从 `credentials.ts` 移入本文件——`QuotaServiceDeps`
 * 因此不依赖 C 包编译产物。实现（`createCredentialResolver` /
 * `ENV_FALLBACK`）仍在 `credentials.ts`。
 */
export interface CredentialResolver {
  /** 同步；无凭据返回 undefined。首次 miss 打一次 WARN，之后静默。 */
  (provider: QuotaProviderId): string | undefined;
}
