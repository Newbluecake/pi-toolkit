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
export type StaticQuotaProviderId = "zai-coding-cn" | "zai" | "kimi-coding";

/**
 * droid 额度接入（docs/dev/external-agent/quota-plan.md r2 §2.1，D1）：Factory 的
 * standard / core 两个计费池建模成两个虚拟 quota provider。quota 模块里所有状态
 * （snapshots / rings / suspects / inflight / demotion / hook 闩锁 / HUD 去重）都按
 * provider 字符串键控，拆成两个 id 后全部原样复用。**不**新增字面 id `droid`：
 * 旧路径 `verdictFor("droid")` 仍返回 undefined（不受管 ⇒ 放行）。
 */
export type DroidQuotaProviderId = "droid-standard" | "droid-core";
export type QuotaProviderId = StaticQuotaProviderId | DroidQuotaProviderId;

export const QUOTA_PROVIDER_IDS: readonly QuotaProviderId[] = [
  // 旧三者顺序不变（字节不变承诺）。
  "zai-coding-cn",
  "zai",
  "kimi-coding",
  "droid-standard",
  "droid-core",
];

export const DROID_QUOTA_IDS: readonly DroidQuotaProviderId[] = ["droid-standard", "droid-core"];

export function isQuotaProviderId(value: string): value is QuotaProviderId {
  return (QUOTA_PROVIDER_IDS as readonly string[]).includes(value);
}

export function isDroidQuotaId(value: string): value is DroidQuotaProviderId {
  return value === "droid-standard" || value === "droid-core";
}

/** 外部 agent 的 provider 名（与 externalAgents.droid / 模型前缀 droid/ 同字面；quota 自持，不 import external-agent）。 */
export const DROID_PROVIDER = "droid";

export type WindowScope = "5h" | "week" | "month";

/** Factory 的两个计费池（D1）。 */
export type QuotaPoolId = "standard" | "core";

/** droid 客户端的超额分流语义（K4）；其它/缺失 ⇒ "off"（droid 语义 blocked）。 */
export type DroidOverage = "droidCore" | "extraUsage" | "off";

/** Factory 计费元数据（droid 池快照专属；kimi/zai 永不设置）。 */
export interface QuotaBillingInfo {
  readonly kind: "factory";
  readonly pool: QuotaPoolId;
  readonly overage: DroidOverage;
  readonly extraUsageAllowed: boolean;
  /** 整数 ≥0（解析层已钳制）。 */
  readonly extraUsageBalanceCents: number;
  /** service 装饰（解析层永不设置）：`quota.droidAllowExtraUsage` 放行判定（D6）。 */
  readonly gateOpen?: boolean | undefined;
}

/** 认证类问题（401/402/403）：不拦 spawn，只告警 + HUD/web 显示（D3）。 */
export interface QuotaProblem {
  readonly family: string; // "droid"
  readonly status: number; // 401 | 402 | 403
}

/**
 * 晚绑定池端口（P5 经 createCatalogPoolPort 供给；quota-plan r2 §2.1）。同步、永不抛。
 * 首次调用可能做一次有界（≤256KiB）磁盘读：底层 ExternalCatalogPort.snapshot() 首次会经
 * catalog-store 同步读缓存文件；P5 在 stack 构建时调用 warm() 预热，把这次读挪出 spawn
 * 准入热路径（评审 #3）。
 */
export interface QuotaPoolPort {
  readonly provider: string; // "droid"
  /** "none" = 不计费（BYOK）；undefined = 未知。 */
  poolOf(modelId: string): QuotaPoolId | "none" | undefined;
  /** 该池可推荐的模型 id（已滤 deprecated / router / custom:），偏好序在前。 */
  modelsInPool(pool: QuotaPoolId): readonly string[];
}

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
  /** Factory 计费元数据；kimi/zai 永不设置（字节不变承诺）。 */
  readonly billing?: QuotaBillingInfo | undefined;
}

/** 快照统一为窗口型（余额型已随 moonshot 适配器移除，用户决策）。 */
export type QuotaSnapshot = QuotaWindowsSnapshot;

/** 网络层注入口：永不抛，失败/非 JSON/非 2xx 一律 undefined。 */
export type FetchJson = (
  url: string,
  init: {
    readonly headers: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal | undefined;
    /** 最终失败（重试耗尽/不可重试）时回调一次 HTTP 状态码；中途重试不调（droid 的 401/402/403 归类用）。kimi/zai 不传 ⇒ 行为不变。 */
    readonly onHttpError?: ((status: number | undefined) => void) | undefined;
  },
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
  /** false ⇒ 本轮跳过：不读凭据、不记 lastAttempt、不发请求（droid 关闭态 D11）。 */
  readonly isActive?: (() => boolean) | undefined;
  /** 最近一次认证类问题（401/402/403）；成功后清除。 */
  readonly lastProblem?: (() => QuotaProblem | undefined) | undefined;
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
