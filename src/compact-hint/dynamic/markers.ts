/**
 * compact-hint dynamic · 英文短标记 + 中文单行说明（dynamic-threshold-plan.md §10.1 / §10.2）。
 *
 * 中英分工（AGENTS.md）：短标记只用英文 token 与仓库既有的 `·`（U+00B7）分隔符，
 * 绝不混中文；中文只出现在面向模型/用户的整句 prose（hint note）里。
 *
 * 方案 §10.1 列出的标记取值：`hint 41% · cost`、`hint 35% · floor`、`hint 60% · quality`、
 * `hint 72% · tier 272k`、`hint 38% · quota`、`hint 75% · static`。`reserve-cap` /
 * `force-gap` 两种 basis 未列出标记取值，这里给同构短 token `reserve` / `force`
 * （否则这两类线在 tick 里不可见）——已在施工报告中标注为方案未覆盖处。
 */

import type { ThresholdBasis } from "./types.js";

/** P2-3 的断言口径：标记不得含 CJK（`·` U+00B7 合法）。 */
export const MARKER_CJK_PATTERN = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

function formatK(tokens: number): string {
  return `${Math.max(0, Math.round(tokens / 1000))}k`;
}

/** tick 标记的 basis：`static` 表示「静态线在用」（mode off/shadow 或静态线更早），不是 ThresholdBasis 成员。 */
export type MarkerBasis = ThresholdBasis | "static";

const BASIS_LABEL: Record<Exclude<ThresholdBasis, "tier">, string> = {
  cost: "cost",
  floor: "floor",
  "quality-cap": "quality",
  "reserve-cap": "reserve",
  "force-gap": "force",
  quota: "quota",
};

/** tick 文案尾部的英文短标记（§10.1；D3 经 `buildUsageTickText` 的可选 `marker` 参数追加）。 */
export function tickMarker(basis: MarkerBasis, hintPercent: number, nextTierTokens?: number | undefined): string {
  const pct = Math.round(hintPercent);
  if (basis === "tier") {
    const tierText =
      nextTierTokens !== undefined && Number.isFinite(nextTierTokens) && nextTierTokens > 0
        ? ` ${formatK(nextTierTokens)}`
        : "";
    return `hint ${pct}% · tier${tierText}`;
  }
  if (basis === "static") return `hint ${pct}% · static`;
  return `hint ${pct}% · ${BASIS_LABEL[basis]}`;
}

export interface HintNoteContext {
  hintPercent: number;
  usedTokens: number | null;
  window: number;
  nextTierTokens?: number | undefined;
  /** D6 前压曲线的 usedPct（`outcome.subscriptionPressure`）。 */
  usedPct?: number | undefined;
}

/**
 * hint 文案追加的中文 prose 行（§10.2）：仅 `basis ∈ {cost, tier, quota}` 追加一行，
 * 其余 basis 与参数不足（取不到距离/压力）时返回 undefined——note 省略时文案与今天逐字节相同。
 * demand（L2）文案不加任何动态信息（§10.2）。
 */
export function hintNote(basis: ThresholdBasis, ctx: HintNoteContext): string | undefined {
  const pct = Math.round(ctx.hintPercent);
  switch (basis) {
    case "cost":
      return `- 本次阈值由价格模型给出 [hint ${pct}% · cost]：继续下去每轮都要为这段长前缀付 cache-read。`;
    case "tier": {
      const next = ctx.nextTierTokens;
      if (next === undefined || !Number.isFinite(next) || ctx.usedTokens === null || !Number.isFinite(ctx.usedTokens)) {
        return undefined; // 取不到距离 ⇒ 不编文案
      }
      const distance = next - ctx.usedTokens;
      if (distance <= 0) return undefined; // 已在档内/越界 ⇒ 距离无意义
      return `- 再涨约 ${formatK(distance)} token 就会跨进高价档 [tier ${formatK(next)}]，跨档后单价翻倍；在此之前切换最划算。`;
    }
    case "quota": {
      const usedPct = ctx.usedPct;
      if (usedPct === undefined || !Number.isFinite(usedPct)) return undefined;
      return `- 订阅额度已用 ${Math.round(usedPct)}% [quota]，提前切换可以少烧一些额度。`;
    }
    default:
      return undefined;
  }
}
