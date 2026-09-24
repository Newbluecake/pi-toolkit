/**
 * compact-hint dynamic · tier-aware 单价解析（dynamic-threshold-plan.md §3.2）。
 *
 * 与宿主的 `calculateCost` 及仓库既有两处读法（S6：`src/stack.ts` priceOf、
 * `src/cache-ttl/keepalive-state.ts` cacheReadCostUsd）口径一致：取
 * `inputTokensAbove < tokens` 中阈值最大的那一档，按全请求计价。
 *
 * P1-9 边界语义（写死）：判据是 `tokens > tier.inputTokensAbove`（严格大于）。
 * 因此**边界值 B 本身仍属低价档**，`B + 1` 才进高价档；分档提醒瞄准 `B − TIER_MARGIN`，
 * 而候选集里的 `B` 表示「刚好还在低档的最后一个 token」。
 */

import { type PriceModel, type PriceRates, type PriceTier } from "./types.js";

/** 有限正数判据（§8 退化阶梯的 "cacheRead/cacheWrite 是有限正数"）。 */
export function isFinitePositive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * 清洗原始 tiers（P1-9 脏数据规则）：
 * - 非对象条目 / `inputTokensAbove` 非有限 / 负数 ⇒ 整档丢弃（0 合法保留）；
 * - 单价字段缺失或非有限 ⇒ 继承 base 的对应字段；
 * - `inputTokensAbove` 重复 ⇒ 保留最后一个；
 * - 结果升序排序。
 */
export function normalizeTiers(raw: unknown, base: PriceRates): readonly PriceTier[] {
  if (!Array.isArray(raw)) return [];
  const byThreshold = new Map<number, PriceTier>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const above = record.inputTokensAbove;
    if (typeof above !== "number" || !Number.isFinite(above) || above < 0) continue;
    const rate = (value: unknown, fallback: number): number =>
      typeof value === "number" && Number.isFinite(value) ? value : fallback;
    byThreshold.set(above, {
      inputTokensAbove: above,
      input: rate(record.input, base.input),
      output: rate(record.output, base.output),
      cacheRead: rate(record.cacheRead, base.cacheRead),
      cacheWrite: rate(record.cacheWrite, base.cacheWrite),
    });
  }
  return [...byThreshold.values()].sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);
}

/** 构造清洗后的 `PriceModel`（wire/D3 读 `ctx.model.cost` 后调用）。 */
export function buildPriceModel(base: PriceRates, rawTiers: unknown): PriceModel {
  const tiers = normalizeTiers(rawTiers, base);
  // 任一档（含 base）cacheRead 非有限正数 ⇒ 价格不可用（readKnown=false ⇒ §8 第 2 行退化）。
  const readKnown = isFinitePositive(base.cacheRead) && tiers.every((tier) => isFinitePositive(tier.cacheRead));
  const writeKnown = isFinitePositive(base.cacheWrite);
  return { base, tiers, readKnown, writeKnown };
}

/** tokens 处适用的整组单价（USD/1M）：`inputTokensAbove < tokens` 的最大档，否则 base。 */
export function rateAt(price: PriceModel, tokens: number): PriceRates {
  let matched: PriceTier | undefined;
  for (const tier of price.tiers) {
    if (tokens > tier.inputTokensAbove && (matched === undefined || tier.inputTokensAbove > matched.inputTokensAbove)) {
      matched = tier;
    }
  }
  const rates = matched ?? price.base;
  return { input: rates.input, output: rates.output, cacheRead: rates.cacheRead, cacheWrite: rates.cacheWrite };
}

/** tokens 处的读单价（USD/token）。 */
export function readRateAt(price: PriceModel, tokens: number): number {
  return rateAt(price, tokens).cacheRead / 1_000_000;
}

/** tokens 处的写单价（USD/token）。v1 单一 cacheWrite 近似（P1-1，不区分 5m/1h）。 */
export function writeRateAt(price: PriceModel, tokens: number): number {
  return rateAt(price, tokens).cacheWrite / 1_000_000;
}

/** 升序去重、落在 (0, window) 内的档边界。 */
export function tierBoundaries(price: PriceModel, window: number): readonly number[] {
  if (!Number.isFinite(window) || window <= 0) return [];
  const thresholds: number[] = [];
  for (const tier of price.tiers) {
    if (tier.inputTokensAbove > 0 && tier.inputTokensAbove < window) thresholds.push(tier.inputTokensAbove);
  }
  thresholds.sort((a, b) => a - b);
  const out: number[] = [];
  for (const threshold of thresholds) {
    if (out.length === 0 || out[out.length - 1] !== threshold) out.push(threshold);
  }
  return out;
}

/**
 * 价格段（升序，覆盖 [0, window]）。`read` 为 USD/token。
 * 段的成员语义与 `rateAt` 的严格大于判据对齐（P1-9）：第 i 段覆盖
 * `(from, to]`（首段为 `[0, to]`）——即上边界 B 本身属于**低价**段，
 * B+1 才落进下一段。
 */
export interface PriceSegment {
  from: number;
  to: number;
  /** USD / token */
  read: number;
}

/** 把窗口切成恒定读单价的价格段（供成本模型积分与分段闭式解使用）。 */
export function priceSegments(price: PriceModel, window: number): readonly PriceSegment[] {
  if (!Number.isFinite(window) || window <= 0) return [];
  const boundaries = tierBoundaries(price, window);
  const segments: PriceSegment[] = [];
  let from = 0;
  let rates: PriceRates = price.base;
  for (const boundary of boundaries) {
    if (boundary <= from) continue; // 防御：退化段
    segments.push({ from, to: boundary, read: rates.cacheRead / 1_000_000 });
    const tier = price.tiers.find((t) => t.inputTokensAbove === boundary);
    if (tier !== undefined) rates = tier;
    from = boundary;
  }
  if (window > from) segments.push({ from, to: window, read: rates.cacheRead / 1_000_000 });
  return segments;
}

/** `c` 是否落在段内（含上边界、不含下边界；首段含 0）——与 `rateAt` 的边界语义一致。 */
export function segmentContains(segment: PriceSegment, c: number): boolean {
  if (c > segment.to) return false;
  return segment.from <= 0 ? true : c > segment.from;
}
