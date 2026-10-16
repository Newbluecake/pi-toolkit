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
  /** 该池可推荐的模型 id（已滤 deprecated / router / custom:），偏好序在前。
   *  白名单模式（2026-10-16 用户拍板）：非空 externalAgents.droid.models ⇒ 只返回名单内
   *  id（配置序，目录追加段不再出现）。 */
  modelsInPool(pool: QuotaPoolId): readonly string[];
  /** 非空 `externalAgents.droid.models` ⇒ 全量名单；缺省方法 / undefined / 空数组 ⇒ 无
   *  白名单（推荐面维持旧行为）。service 层据此把 `quota.droidPools` 的推荐面加法也
   *  限制在名单内。同步、永不抛。 */
  allowlist?(): readonly string[] | undefined;
}

/**
 * pi provider 被拦/告急时的外部 droid 补充候选（2026-10-15 用户拍板）：一个池 +
 * 该池模型（已带 `droid/` 前缀）。core 池排在 standard 池前；入选池须未 stale、
 * 未触闸门线（gate 关闭时仍按 L3 排除）——推荐一个闸门自己也会拦下（或读数不真）
 * 的模型只会制造第二次快速失败。
 */
export interface DroidPoolAlternative {
  readonly pool: QuotaPoolId;
  readonly models: readonly string[];
  /** Core 池自身已触线、按回落规则计入 Standard 池额度（Standard 池仍有可信余量）
   * 时为 true（2026-10-16 实测定界）；Standard 池模型不能反向使用 Core 池额度，
   * standard 池条目永不带此标记。 */
  readonly fallback?: true | undefined;
}

/**
 * droid 池逐池清单条目（2026-10-15 用户要求「结合 droid 可用模型，把 standard / core
 * 各自能用哪些列出来」）：状态相对**闸门线**（`settings.gate ? gateLevel : 3`）判读，
 * 且仅对**可信**池生成（快照缺席 / stale / 鉴权失败 ⇒ 整池不可见——终版拍板「数据
 * 拿不到就当没有该订阅」，不出「无数据」文案）。
 */
export type DroidPoolState = "ok" | "warn" | "blocked" | "fallback";

export interface DroidPoolListingEntry {
  readonly pool: QuotaPoolId;
  /** 有余量（ok，等级低于闸门线）/ 预警（warn，≥L1 但低于闸门线）/ 已拦，勿派
   * （blocked，≥闸门线）/ 额度尽，回落 Standard 计费（fallback：仅 core 池——自身
   * ≥闸门线但 Standard 池仍有可信余量，Core 模型按 Factory 回落规则计入 Standard
   * 池额度，可照常派发，2026-10-16 实测定界）。 */
  readonly state: DroidPoolState;
  /** 该池候选总数（截断前，poolCandidates 序）。 */
  readonly total: number;
  /** 前 ≤5 个候选（`droid/<id>` 前缀，poolCandidates 偏好序）。 */
  readonly models: readonly string[];
}

/**
 * droid 池被拦时的建议包（D7 对称化）：另一池的推荐模型 + 两池逐池清单。
 * `models` 为空 ⇒ 不出 droid 推荐行（另一池无快照 / stale / 鉴权失败 / 触线——
 * 「no trustworthy data ⇒ the subscription does not exist」，2026-10-15 拍板）；
 * `listing` 为空（两池都无候选，目录未探测/droid 未装）⇒ 渲染层保持旧版通用括号
 * 注释（输出字节不变）。整包为空 ⇒ 调用方输出与旧版一致。数组外形（0/1 元素）让
 * stack.ts / index.ts 的现有接线（`?? []` 兜底与纯转发）无需改动即可通过类型检查。
 */
export interface DroidPoolAdvice {
  /** 建议改用的池（被拦池的另一池）。 */
  readonly pool: QuotaPoolId;
  /** 另一池 ≤limit 个 `droid/<id>`；无可信数据 / 触线 ⇒ 空。 */
  readonly models: readonly string[];
  /** 逐池清单（standard 在前；零候选池与不可信池均被省略）。 */
  readonly listing: readonly DroidPoolListingEntry[];
  /** 仅 blocked === "droid-core" 时可出现：Core 池自身触线但 Standard 池仍有可信
   * 余量 ⇒ Core 模型按回落规则计入 Standard 池额度、闸门放行（2026-10-16 实测
   * 定界）。渲染层据此把 L3 文案从「禁用」换成「回落计费说明」。 */
  readonly coreFallback?: true | undefined;
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
