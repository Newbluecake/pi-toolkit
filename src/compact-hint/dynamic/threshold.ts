/**
 * compact-hint dynamic · 可行区间 → 候选 → argmin → 量化 → 死区（dynamic-threshold-plan.md §3.4/§3.5/§8/§9）。
 *
 * 收敛顺序即语义（P0-2）：先算可行区间 `[lowerBound, cap]`（两端点恒进候选集），
 * 再构造候选、取 argmin、抬量化下限（R2-5）、过发布死区（P2-1）。任何一步算不出
 * 可行线都返回 `{ usable: false, reason }`（P0-1），绝不把 0 当线。
 *
 * `forceAtPercent` / `forceAtTokens` / `forceScaling` 的表达式一字不改（S3：force 是
 * 安全网）；动态层只输出 hint 线，与静态线的 min 合成规则见 `composeHintLineTokens`（§3.6）。
 */

import { effectiveThresholdPercentWithTokens, thresholdLineTokens, windowScaledForcePercent } from "../threshold.js";
import { closedFormCStarTokens, cycleAverageCostUsd, fixedCostUsd, type CycleCostInput } from "./cost-model.js";
import { priceSegments, rateAt, segmentContains, tierBoundaries, type PriceSegment } from "./pricing.js";
import type {
  Candidate,
  DynamicConfig,
  DynamicThresholdOutcome,
  GrowthEstimate,
  PriceModel,
  StartEstimate,
  ThresholdBasis,
} from "./types.js";

// ---------------------------------------------------------------------------
// §3.5 内部常量（不可配置，集中在文件顶部，带推导注释）
// ---------------------------------------------------------------------------

/** 更小的窗口由 reserve 主导（pi 自身线在 95% 附近），成本优化无意义。 */
export const DYNAMIC_MIN_WINDOW = 32_000;
/** 研究 §2.3：主会话增长 P50 ≈ 779。 */
export const MIN_G = 300;
/** 单轮吃掉 >10% 窗口是异常，不让它主导阈值。 */
export const MAX_G_FRACTION = 0.1;
/** `g + 0.5σ` 作为 P90 的廉价单调代理。 */
export const G_SIGMA_WEIGHT = 0.5;
/** 研究 §2.3 全量 P50 774 / 主会话 779。 */
export const G_PRIOR = 800;
/** 先验混合窗口。 */
export const G_WARMUP_SAMPLES = 8;
/** 研究 §3.2：真实四次切换后 S0 = 92.5k–101.5k ⇒ S0 先验 = min(10%·W, 100k)。 */
export const S0_PRIOR_FRACTION = 0.1;
export const S0_PRIOR_CAP = 100_000;
/** 机械附录 + system prompt 的地板。 */
export const MIN_S0 = 4_000;
/** 研究 §3.2：交接 4,191–8,493 字符。 */
export const HANDOFF_PRIOR_TOKENS = 2_000;
/** hint 与 force 的最小间距（百分点）。 */
export const HYSTERESIS_PCT = 3;
/** 发布死区（百分点），抑制线抖动。 */
export const PUBLISH_DEADBAND_PCT = 2;
/** 跨档前留两轮余量完成切换：TIER_MARGIN = max(2g, 1%·W)。 */
export const TIER_MARGIN_WINDOW_FRACTION = 0.01;
/** 研究 §7.4 建议 0.2。 */
export const EWMA_ALPHA_G = 0.2;
/** S0 样本稀少故更快（handoff 同理：样本只来自真实切换，同样稀少）。 */
export const EWMA_ALPHA_S0 = 0.4;
/** D6 前压曲线端点；75 对齐 `DEFAULT_THRESHOLDS.l2 = 75`（src/quota/ladder.ts）。 */
export const SUB_PRESSURE_FROM = 75;
export const SUB_PRESSURE_TO = 95;
/**
 * R2-5：低于 1% 的线经 floor 换算会变成 0（= 线未启用），必须在纯函数层抬到
 * `ceil(W/100)` 或老实退化。见 §3.4 步骤 11。
 */
export const MIN_LINE_PERCENT = 1;

/** S0 先验（§3.5）：min(10%·W, 100k)。 */
export function s0PriorTokens(window: number): number {
  if (!Number.isFinite(window) || window <= 0) return S0_PRIOR_CAP;
  return Math.min(S0_PRIOR_FRACTION * window, S0_PRIOR_CAP);
}

/** TIER_MARGIN（§3.5）：max(2g, 1%·W) —— 跨档前留两轮余量完成切换。 */
export function tierMarginTokens(g: number, window: number): number {
  return Math.max(2 * g, TIER_MARGIN_WINDOW_FRACTION * window);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** 量化下限（R2-5）：`ceil(W/100)` tokens，保证 floor 换算回百分比后 >= 1。 */
function minLineTokens(window: number): number {
  return Math.ceil(window / MIN_LINE_PERCENT / 100);
}

// ---------------------------------------------------------------------------
// 输入形状
// ---------------------------------------------------------------------------

/** force 静态配置（原样透传：`compact.forceAtPercent` / `compact.forceAtTokens`，单位 k）。 */
export interface ForceLines {
  atPercent: number;
  atTokensK: number;
}

/** 静态 hint 线配置（§3.6 判活谓词用；不传 ⇒ 纯层不做 static-hint-disabled 检查）。 */
export interface StaticHintLines {
  percent: number;
  tokensK: number;
}

/** 订阅分支输入（§8.2 的识别由 wire 完成，纯层只吃已解析的压力值）。 */
export interface SubscriptionStateInput {
  /** §8.2 识别成立（quota enabled ∧ 订阅 provider ∧ verdict 存在）。 */
  active: boolean;
  /** 未过期窗口的 usedPct 最大值（`resolveSubscriptionPressure`）；null = stale / 无未过期窗口。 */
  usedPct: number | null;
}

/** 已发布的线（§9.2 状态机：死区只在同 epoch 内生效）。 */
export interface PublishedLine {
  percent: number;
  epoch: number;
}

export interface DynamicThresholdInput {
  /** 上下文窗口 W。 */
  window: number;
  /** `ContextUsage.tokens`；null ⇒ 本轮不重算（usage-unknown）。 */
  usedTokens: number | null;
  price: PriceModel;
  growth: GrowthEstimate;
  start: StartEstimate;
  /** 交接 token 数（`handoffEstimate(state).tokens`）。 */
  handoffTokens: number;
  config: DynamicConfig;
  force: ForceLines;
  reserveTokens: number;
  /** 静态 hint 线；传入时先做判活检查（static-hint-disabled）。 */
  staticHint?: StaticHintLines | undefined;
  subscription?: SubscriptionStateInput | undefined;
  published?: PublishedLine | undefined;
  /** 当前模型 epoch（`EstimatorState.modelEpoch`）。 */
  epoch: number;
}

// ---------------------------------------------------------------------------
// §8.2 订阅压力取法（写死）
// ---------------------------------------------------------------------------

export interface SubscriptionWindowLike {
  usedPct: number;
  /** 未定义 = 不过期窗口。 */
  resetAtMs?: number | undefined;
}

export interface SubscriptionVerdictLike {
  stale?: boolean | undefined;
  windows?: readonly SubscriptionWindowLike[] | undefined;
}

/**
 * 压力值取法（§8.2）：verdict 缺失或 `stale === true` ⇒ null（不前压）；
 * 否则取**未过期**窗口（`resetAtMs === undefined || resetAtMs > nowMs`）的
 * `usedPct` 最大值（Kimi 周耗尽陷阱同款口径）；无未过期窗口 ⇒ null。
 */
export function resolveSubscriptionPressure(
  verdict: SubscriptionVerdictLike | undefined,
  nowMs: number,
): number | null {
  if (verdict === undefined || verdict.stale === true) return null;
  let max: number | null = null;
  for (const win of verdict.windows ?? []) {
    if (win.resetAtMs !== undefined && !(win.resetAtMs > nowMs)) continue;
    if (typeof win.usedPct !== "number" || !Number.isFinite(win.usedPct)) continue;
    if (max === null || win.usedPct > max) max = win.usedPct;
  }
  return max;
}

/** D6 前压曲线（token 空间，线性插值）：<=75 取质量上限，75→95 线性压到地板，>=95 取地板。 */
export function subscriptionPressureLine(usedPct: number, qualityCapTokens: number, lowerBound: number): number {
  if (usedPct <= SUB_PRESSURE_FROM) return qualityCapTokens;
  if (usedPct >= SUB_PRESSURE_TO) return lowerBound;
  return (
    qualityCapTokens -
    ((qualityCapTokens - lowerBound) * (usedPct - SUB_PRESSURE_FROM)) / (SUB_PRESSURE_TO - SUB_PRESSURE_FROM)
  );
}

// ---------------------------------------------------------------------------
// §3.4 主流程
// ---------------------------------------------------------------------------

type CapOrigin = ThresholdBasis;

function sanitizePercent(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return clamp(value, 0, 100);
}

export function computeDynamicThreshold(input: DynamicThresholdInput): DynamicThresholdOutcome {
  const w = input.window;

  // 1. W 无效 ⇒ window-unknown
  if (!Number.isFinite(w) || w <= 0) return { usable: false, reason: "window-unknown" };
  // 2. W < DYNAMIC_MIN_WINDOW ⇒ window-too-small
  if (w < DYNAMIC_MIN_WINDOW) return { usable: false, reason: "window-too-small" };
  // 3. usedTokens 未知 ⇒ usage-unknown（NaN 同样视为未测到，绝不当 0 用）
  if (input.usedTokens === null || !Number.isFinite(input.usedTokens)) {
    return { usable: false, reason: "usage-unknown" };
  }
  // 3.5（§3.6 判活谓词的纯层入口）：今天没有 hint 线 ⇒ 动态层不得复活。
  if (input.staticHint !== undefined) {
    const active =
      effectiveThresholdPercentWithTokens(input.staticHint.percent, input.staticHint.tokensK, w, input.reserveTokens) >
      0;
    if (!active) return { usable: false, reason: "static-hint-disabled" };
  }
  // 4a. 退化阶梯第 2 行（§8.1）：价格未知 + static ⇒ 退化；+ quality ⇒ 进入 quality 分支
  const priceUnknown = !input.price.readKnown;
  if (priceUnknown && input.config.unknownPriceMode === "static") {
    return { usable: false, reason: "price-unknown" };
  }
  const qualityBranch = priceUnknown && input.config.unknownPriceMode === "quality";
  // 4b. 退化阶梯第 3 行（§8.2）：订阅分支跳过 argmin（第 9 步执行）
  const subscriptionBranch = input.subscription !== undefined && input.subscription.active === true;

  // 5. 读侧 clamp（P2-2：存储层保留原始浮点，clamp 只在这里做）
  const sigma = Number.isFinite(input.growth.sigma) && input.growth.sigma > 0 ? input.growth.sigma : 0;
  const rawG = (Number.isFinite(input.growth.g) ? input.growth.g : 0) + G_SIGMA_WEIGHT * sigma;
  const g = clamp(rawG, MIN_G, MAX_G_FRACTION * w);
  const s0 = clamp(Number.isFinite(input.start.s0) ? input.start.s0 : 0, MIN_S0, 0.35 * w);

  // 6. 地板
  const minHintPercent = sanitizePercent(input.config.minHintPercent, 0);
  const lowerBound = Math.max((minHintPercent / 100) * w, s0 + 2 * g);

  // 7. cap = min(质量上限, W − reserve, 有效 force 线 − 迟滞)。
  //    R2-9：判定对象是**有效 force 线**（两条线都关才省略 force 项），不是 forceAtPercent。
  const maxQualityPercent = sanitizePercent(input.config.maxQualityPercent, 60);
  const qualityCap = (maxQualityPercent / 100) * w;
  const reserveCap = w - input.reserveTokens;
  const effForce = effectiveThresholdPercentWithTokens(
    windowScaledForcePercent(input.force.atPercent, w),
    input.force.atTokensK,
    w,
    input.reserveTokens,
  );
  const forceCap = effForce > 0 ? (effForce / 100) * w - (HYSTERESIS_PCT / 100) * w : Number.POSITIVE_INFINITY;
  let cap = Math.min(qualityCap, reserveCap);
  let capOrigin: CapOrigin = qualityCap <= reserveCap ? "quality-cap" : "reserve-cap";
  if (forceCap < cap) {
    cap = forceCap;
    capOrigin = "force-gap";
  }

  // 8. cap < lowerBound 或 cap <= 0 ⇒ infeasible-range（reserve 接近窗口、质量上限低于地板、force 线过低统一在此退化）
  if (!Number.isFinite(cap) || cap <= 0 || cap < lowerBound) {
    return { usable: false, reason: "infeasible-range" };
  }

  const minLine = minLineTokens(w);
  let lineTokens: number;
  let basis: ThresholdBasis;
  let cStarTokens: number | undefined;
  let subscriptionPressure: number | undefined;
  let candidates: Candidate[] = [];

  const boundaries = tierBoundaries(input.price, w);
  const nextTierAfter = (tokens: number): number | undefined => boundaries.find((b) => b >= tokens);

  // 成本模型输入（quality 分支不用；订阅分支只为 cStarTokens 诊断）
  const segments = priceSegments(input.price, w);
  const kUsd = fixedCostUsd({
    handoffTokens: input.handoffTokens,
    outputPerM: rateAt(input.price, s0).output,
    s0,
    price: input.price,
    rediscoveryUsd: input.config.rediscoveryUsd,
  });

  if (qualityBranch) {
    // §8.1 第 2 行（quality）：clamp(60%·W, lowerBound, cap)，不进 argmin（P6b）
    lineTokens = clamp(qualityCap, lowerBound, cap);
    basis = "quality-cap";
    cStarTokens = undefined; // 价格未知 ⇒ 闭式解不可算
  } else if (subscriptionBranch) {
    // 9. 订阅分支（§8.2）：前压曲线，跳过 argmin
    const usedPct = input.subscription?.usedPct;
    if (usedPct === null || usedPct === undefined || !Number.isFinite(usedPct)) {
      // verdict 缺失 / stale / 无未过期窗口 ⇒ 不前压
      lineTokens = clamp(qualityCap, lowerBound, cap);
      basis = "quality-cap";
    } else {
      lineTokens = clamp(subscriptionPressureLine(usedPct, qualityCap, lowerBound), lowerBound, cap);
      basis = usedPct > SUB_PRESSURE_FROM ? "quota" : "quality-cap";
      subscriptionPressure = usedPct;
    }
    cStarTokens = s0SegmentCStar(segments, s0, g, kUsd);
  } else {
    // 10. 常规分支：候选 = {lowerBound, cap} ∪ {区间内的 C*_s} ∪ {区间内的 B, B − TIER_MARGIN}，argmin A(C)
    const cycle: CycleCostInput = { s0, g, kUsd, segments };
    const margin = tierMarginTokens(g, w);

    type Built = {
      tokens: number;
      kind: "floor" | "cap" | "cstar" | "tier" | "tier-margin";
      tierB?: number;
      label: string;
    };
    const built: Built[] = [
      { tokens: lowerBound, kind: "floor", label: "floor" }, // 两端点恒在集合内（P0-2）
      { tokens: cap, kind: "cap", label: "cap" },
    ];
    for (const segment of segments) {
      const cStar = closedFormCStarTokens(s0, kUsd, g, segment.read);
      // 仅当落在本段区间内才收为候选（§3.3），且必须在可行区间内
      if (cStar !== undefined && segmentContains(segment, cStar) && cStar >= lowerBound && cStar <= cap) {
        built.push({ tokens: cStar, kind: "cstar", label: "c*" });
      }
    }
    for (const boundary of boundaries) {
      const below = boundary - margin;
      if (below >= lowerBound && below <= cap) {
        built.push({ tokens: below, kind: "tier-margin", tierB: boundary, label: "tier-margin" });
      }
      if (boundary >= lowerBound && boundary <= cap) {
        built.push({ tokens: boundary, kind: "tier", tierB: boundary, label: "tier" });
      }
    }
    built.sort((a, b) => a.tokens - b.tokens);
    const unique: Built[] = [];
    for (const item of built) {
      const last = unique[unique.length - 1];
      if (last === undefined || last.tokens !== item.tokens) unique.push(item);
    }
    // argmin，并列取 token 最小者（确定性；P1 单调性友好）
    let best = unique[0];
    let bestCost = cycleAverageCostUsd(cycle, best?.tokens ?? lowerBound);
    for (let i = 1; i < unique.length; i += 1) {
      const item = unique[i];
      if (item === undefined) continue;
      const cost = cycleAverageCostUsd(cycle, item.tokens);
      if (cost < bestCost) {
        best = item;
        bestCost = cost;
      }
    }
    lineTokens = best?.tokens ?? lowerBound;
    // 13. basis 归因（§3.4 第 13 步）
    switch (best?.kind) {
      case "tier":
      case "tier-margin":
        basis = "tier";
        break;
      case "cap":
        basis = capOrigin; // quality-cap | reserve-cap | force-gap（有效 force 线为 0 时 force-gap 永不出现）
        break;
      case "cstar":
        basis = "cost";
        break;
      default:
        basis = "floor";
        break;
    }
    cStarTokens = s0SegmentCStar(segments, s0, g, kUsd);
    // 诊断候选（≤ 8 条；argmin 已在完整集合上完成）
    candidates = unique.slice(0, 8).map((item) => ({
      tokens: item.tokens,
      usdPerTurn: cycleAverageCostUsd(cycle, item.tokens),
      label: item.label,
    }));
  }

  // 11. 量化下限（R2-5）：抬到 ceil(W/100)，保证 floor 换算后 >= 1%；抬不过 cap ⇒ 老实退化
  lineTokens = Math.max(lineTokens, minLine);
  if (lineTokens > cap) return { usable: false, reason: "infeasible-range" };
  let hintTokens = lineTokens;
  let hintPercent = Math.floor((hintTokens * 100) / w);

  // 12. 发布死区（§9.2）：同 epoch 且差值 < PUBLISH_DEADBAND_PCT ⇒ 沿用已发布线；
  //     仅当沿用值仍落在可行区间内才采纳（P4/P5 不因死区而破——published 可能来自更早的配置）。
  const published = input.published;
  if (
    published !== undefined &&
    Number.isFinite(published.percent) &&
    published.epoch === input.epoch &&
    Math.abs(hintPercent - published.percent) < PUBLISH_DEADBAND_PCT
  ) {
    const adopted = Math.ceil((published.percent / 100) * w);
    if (adopted >= Math.max(lowerBound, minLine) && adopted <= cap) {
      hintTokens = adopted;
      hintPercent = published.percent;
    }
  }

  const nextTierTokens = qualityBranch ? undefined : nextTierAfter(hintTokens);
  return {
    usable: true,
    hintTokens,
    hintPercent,
    basis,
    lowerBound,
    cap,
    cStarTokens,
    nextTierTokens,
    writePricingApproximate: true, // P1-1：v1 恒 true（单一 cacheWrite 近似，不区分 5m/1h）
    subscriptionPressure,
    candidates,
  };
}

/** `cStarTokens`：S0 所在段的闭式解（§3.3，供 status 显示成本下界）；不可算 ⇒ undefined。 */
function s0SegmentCStar(segments: readonly PriceSegment[], s0: number, g: number, kUsd: number): number | undefined {
  const segment = segments.find((seg) => segmentContains(seg, s0));
  if (segment === undefined) return undefined;
  return closedFormCStarTokens(s0, kUsd, g, segment.read);
}

// ---------------------------------------------------------------------------
// §3.6 合成规则（P0-1 完整版；stack.ts 的钩子（D3）调用这个纯函数）
// ---------------------------------------------------------------------------

/** 今天是否有 hint 线（判活谓词，复用 S2 的既有函数）。 */
export function staticHintActive(lines: StaticHintLines, window: number, reserveTokens: number): boolean {
  return effectiveThresholdPercentWithTokens(lines.percent, lines.tokensK, window, reserveTokens) > 0;
}

export interface ComposeHintLineArgs {
  staticLines: StaticHintLines;
  window: number;
  reserveTokens: number;
  mode: DynamicConfig["mode"];
  /** Only `usable` and `hintTokens` are read, so a status view can pass a structural slice. */
  dynamic: Pick<Extract<DynamicThresholdOutcome, { usable: true }>, "usable" | "hintTokens"> | { usable: false };
}

/**
 * 动态线与静态线的合成（D3：min，动态线只能提前）：
 * - 今天没有线（判活谓词为假）⇒ 0，动态层不得复活；
 * - mode !== "on"（off / shadow）⇒ 静态线；
 * - 动态退化（usable:false）⇒ 静态线（现行行为，逐字节一致）；
 * - 否则 min(静态线, 动态线)。
 * `staticHintActive ⇒ staticTokens > 0`（由两个既有函数的定义域保证），min 永远有意义。
 */
export function composeHintLineTokens(args: ComposeHintLineArgs): number {
  const { staticLines, window: w, reserveTokens, mode, dynamic } = args;
  if (!staticHintActive(staticLines, w, reserveTokens)) return 0;
  const staticTokens = thresholdLineTokens(staticLines.percent, staticLines.tokensK, w);
  if (mode !== "on") return staticTokens;
  if (!dynamic.usable) return staticTokens;
  return Math.min(staticTokens, dynamic.hintTokens);
}

export interface EffectiveHintArgs {
  /** The static line as the hook resolves it today (`effectiveThresholdPercentWithTokens`). */
  staticEffectivePercent: number;
  staticLines: StaticHintLines;
  window: number;
  reserveTokens: number;
  /** A usable dynamic line in `on` mode; undefined for off / shadow / degraded. */
  dynamic: { hintTokens: number; hintPercent: number } | undefined;
}

/**
 * The hint percent the hook actually fires at, plus whether the dynamic line won. Shared by
 * the compact-hint hook and `/agent status` so the status line can never disagree with the
 * real trigger: the dynamic line only wins when it is strictly earlier in token terms (D3).
 */
export function resolveEffectiveHint(args: EffectiveHintArgs): { percent: number; dynamicWon: boolean } {
  const { staticEffectivePercent, staticLines, window: w, reserveTokens, dynamic } = args;
  if (dynamic === undefined) return { percent: staticEffectivePercent, dynamicWon: false };
  const composed = composeHintLineTokens({
    staticLines,
    window: w,
    reserveTokens,
    mode: "on",
    dynamic: { usable: true, hintTokens: dynamic.hintTokens },
  });
  const staticTokens = thresholdLineTokens(staticLines.percent, staticLines.tokensK, w);
  if (composed > 0 && composed < staticTokens) {
    return { percent: Math.min(staticEffectivePercent, dynamic.hintPercent), dynamicWon: true };
  }
  return { percent: staticEffectivePercent, dynamicWon: false };
}
