/**
 * compact-hint dynamic · 周期平均成本 A(C)、固定成本 K、分段闭式解 C*（dynamic-threshold-plan.md §3.3）。
 *
 * 轮数 `m(C) = max(1, ceil((C − S0) / g))`；周期内第 `j` 轮（`j = 0..m−1`）上下文约
 * `S0 + j·g`。周期平均成本（分档精确，O(#tiers)）：
 *
 * ```
 * A(C) = K / m  +  (1/m) · Σ_segments  read_s · [ n_s·S0 + g · (j_lo + j_hi − 1)·n_s / 2 ]
 * ```
 *
 * 每个价格段 `[a, b)`：`j_lo = clamp(ceil((a − S0)/g), 0, m)`、`j_hi = clamp(ceil((b − S0)/g), 0, m)`、
 * `n_s = j_hi − j_lo`（§3.3 原式）。与朴素逐轮求和在连续参数下恒等（P10；两侧公式只在
 * `S0 + j·g` 恰好压在档边界整数上时分歘认 1 轮，随机浮点下测度零）。
 *
 * 固定成本：`K = H + R + Wnew`，其中 `H = handoffTokens · output / 1e6`、
 * `Wnew = S0 · writeRateAt(S0)`（按 S0 计，研究 §2.2；writeKnown=false ⇒ 0）、
 * `R = config.rediscoveryUsd`（§5.1 经验先验）。v1 的 K 与 C 无关；`K(C)` 的签名
 * 保留给 v2 的闲置修正（§7）。
 */

import { isFinitePositive, type PriceSegment, writeRateAt } from "./pricing.js";
import type { PriceModel } from "./types.js";

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** 轮数 m(C)（§3.3）；g 非正 / 入参非有限时退化为 1（单轮周期，防 P9 注入）。 */
export function cycleTurns(c: number, s0: number, g: number): number {
  if (!Number.isFinite(c) || !Number.isFinite(s0) || !Number.isFinite(g) || g <= 0) return 1;
  return Math.max(1, Math.ceil((c - s0) / g));
}

export interface CycleCostInput {
  s0: number;
  g: number;
  /** 一次切换的固定成本（USD）；v1 与 C 无关（§3.3）。 */
  kUsd: number;
  segments: readonly PriceSegment[];
}

/** 周期平均成本 A(C)（USD/turn，§3.3 分段闭式）。 */
export function cycleAverageCostUsd(input: CycleCostInput, c: number): number {
  const { s0, g, kUsd, segments } = input;
  const m = cycleTurns(c, s0, g);
  let sum = 0;
  for (const segment of segments) {
    const read = segment.read;
    // read <= 0 的段贡献为 0（免费读）；负 read（脏数据）跳过以保 A >= 0（P9）。
    if (!(read > 0) || !Number.isFinite(read)) continue;
    const jLo = clamp(Math.ceil((segment.from - s0) / g), 0, m);
    const jHi = clamp(Math.ceil((segment.to - s0) / g), 0, m);
    const n = jHi - jLo;
    if (n <= 0) continue;
    sum += read * (n * s0 + (g * (jLo + jHi - 1) * n) / 2);
  }
  return kUsd / m + sum / m;
}

export interface FixedCostInput {
  handoffTokens: number;
  /** USD / 1M token 的输出单价（tier-aware：threshold 传 `rateAt(price, S0).output`）。 */
  outputPerM: number;
  s0: number;
  price: PriceModel;
  rediscoveryUsd: number;
}

/** K = H + R + Wnew（§3.3）。缺失 / 非正的分量按 §2.1 退化（K 偏小 ⇒ C* 偏早 ⇒ 地板兜住）。 */
export function fixedCostUsd(input: FixedCostInput): number {
  const { handoffTokens, outputPerM, s0, price, rediscoveryUsd } = input;
  // H = handoffTokens · output / 1e6 —— 输出价缺失/非正 ⇒ H = 0
  const handoff =
    isFinitePositive(handoffTokens) && isFinitePositive(outputPerM) ? (handoffTokens * outputPerM) / 1_000_000 : 0;
  // Wnew = S0 · writeRateAt(S0) —— 单一 cacheWrite 近似（P1-1）；写价未知/非正 ⇒ 0
  const writeRate = Number.isFinite(s0) && s0 > 0 ? writeRateAt(price, s0) : Number.NaN;
  const wnew = isFinitePositive(writeRate) ? s0 * writeRate : 0;
  // R = rediscoveryUsd（§5.1：经验先验，未跨模型校准）；合法域 >= 0，负值防御性钳 0
  const rediscovery = isFinitePositive(rediscoveryUsd) ? rediscoveryUsd : 0;
  return Math.max(0, handoff + rediscovery + wnew);
}

/**
 * 固定 K、段内恒定读单价下的闭式解：`C* = S0 + sqrt(2·K·g / read)`
 * （研究 §2.1）。read 非正 / 入参非法 ⇒ undefined（不可算）。
 */
export function closedFormCStarTokens(s0: number, kUsd: number, g: number, readPerToken: number): number | undefined {
  if (!isFinitePositive(readPerToken)) return undefined;
  if (!Number.isFinite(s0) || s0 < 0 || !Number.isFinite(kUsd) || kUsd < 0 || !Number.isFinite(g) || g <= 0) {
    return undefined;
  }
  return s0 + Math.sqrt((2 * kUsd * g) / readPerToken);
}
