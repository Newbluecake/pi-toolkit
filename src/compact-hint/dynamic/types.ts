/**
 * compact-hint dynamic · 纯函数层的输入/输出/状态类型（dynamic-threshold-plan.md §3.1）。
 *
 * P0-1 的核心：`usable: false` 与「线为 0」在类型上不可混淆——调用方无法写出
 * `hintTokens === 0` 这种歧义判断；六种退化各自带 `DegradeReason`，`usable: true`
 * 的输出恒满足 `hintTokens > 0`、`hintPercent >= 1`（§3.4 不变式）。
 *
 * 本模块（及整个 D1 纯函数层）零 pi import、零 fs、零隐式 `Date.now`——时间与
 * 上下文全部由参数注入；不持有任何模块级可变状态。
 */

/** 单价（USD / 1M token）。与宿主模型的 `ModelCostRates` 同形，但只作结构化 duck type。 */
export interface PriceRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 请求级分档：`tokens > inputTokensAbove`（严格大于）时该档按全请求计价（P1-9）。 */
export interface PriceTier extends PriceRates {
  inputTokensAbove: number;
}

/** 已清洗的价格模型（tiers 由 `normalizeTiers` 排序、去脏；S6/P1-9）。 */
export interface PriceModel {
  base: PriceRates;
  tiers: readonly PriceTier[];
  /** cacheRead 是有限正数（base 与全部 tier 都必须是；§8 退化阶梯第 2 行的判据）。 */
  readKnown: boolean;
  /** cacheWrite 是有限正数；false ⇒ `writePricingApproximate`（P1-1：v1 恒近似）。 */
  writeKnown: boolean;
}

/** 在线增长估计（g 已含热身先验混合，§4.1；clamp 只在 threshold 读侧做）。 */
export interface GrowthEstimate {
  g: number;
  sigma: number;
  samples: number;
}

/** 切换后起点估计（s0 已含先验回落，§4.1）。 */
export interface StartEstimate {
  s0: number;
  samples: number;
}

/** 动态层配置（§11.1 的 `compact.dynamicThreshold`；D1 只读，接线属 D3）。 */
export interface DynamicConfig {
  mode: "off" | "shadow" | "on";
  /** 地板：默认 35（研究 §7.4）。 */
  minHintPercent: number;
  /** 质量上限：默认 60 —— 未校准的安全上限（D8）。 */
  maxQualityPercent: number;
  /** 再发现成本 R：默认 $10 —— 经验先验，未跨模型校准（D2/§5.1）。 */
  rediscoveryUsd: number;
  /** 价格未知时的退化模式：默认 "static"（最保守 = 不改变现行行为）。 */
  unknownPriceMode: "static" | "quality";
}

export type DegradeReason =
  | "window-unknown" // W 缺失 / 非有限 / <= 0
  | "window-too-small" // W < DYNAMIC_MIN_WINDOW
  | "usage-unknown" // ContextUsage.tokens == null
  | "price-unknown" // cacheRead 不是有限正数（且 unknownPriceMode="static"）
  | "infeasible-range" // cap < lowerBound（含 reserve 接近窗口、质量上限低于地板、force 线过低）
  | "static-hint-disabled" // 今天就没有 hint 线（§3.6 判活谓词，由 D3 的钩子传入静态线时才检查）
  | "internal-error"; // 纯函数抛异常的兜底归类（wire 层捕获；纯层自身永不产生）

export type ThresholdBasis = "cost" | "tier" | "floor" | "quality-cap" | "reserve-cap" | "force-gap" | "quota";

/** argmin 候选的诊断视图（§3.4 第 10 步构造的集合，≤ 8 条）。 */
export interface Candidate {
  tokens: number;
  usdPerTurn: number;
  label: string;
}

export type DynamicThresholdOutcome =
  | {
      usable: true;
      /** 恒 > 0，且落在 [max(lowerBound, ceil(W/100)), cap]（R2-5 量化下限）。 */
      hintTokens: number;
      /** floor(hintTokens * 100 / W)，恒 >= 1。 */
      hintPercent: number;
      basis: ThresholdBasis;
      lowerBound: number;
      cap: number; // 可行区间，供 status/遥测诊断
      /** 基础段（S0 所在段）闭式解；不可算时 undefined（§3.3）。 */
      cStarTokens: number | undefined;
      /** 线前方最近的价格档边界 B（status 的 "next tier"；无则 undefined）。 */
      nextTierTokens: number | undefined;
      /** P1-1：v1 恒 true（单一 cacheWrite 近似，不区分 5m/1h）。 */
      writePricingApproximate: boolean;
      /** D6 前压曲线所用的 usedPct；未用前压时 undefined。 */
      subscriptionPressure: number | undefined;
      /**
       * 常规（成本）分支的 argmin 候选，恒含 lowerBound/cap 两端点（§3.4 第 10 步）。
       * quality / 订阅分支跳过 argmin ⇒ 恒为空数组（P6b：未进成本模型）。
       */
      candidates: readonly Candidate[];
    }
  | { usable: false; reason: DegradeReason };
