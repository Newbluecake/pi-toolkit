/**
 * topic-switch · next-request cost estimate (plan.md §P1 "economics.ts", 评审 #6).
 *
 * Term-by-term replica of pi-ai `calculateCost` (`PIAI/models.js`):
 *   - tier 选档判据 `inputTokens > tier.inputTokensAbove`，取阈值最大者**整组替换** base；
 *   - 1h 写 = 2×input（Anthropic 规则），5m 写 = `cacheWrite` 单价；
 *   - usd = (input×rates.input + (cacheWrite−cacheWrite1h)×rates.cacheWrite
 *            + cacheWrite1h×2×rates.input) / 1e6，output/cacheRead 计 0。
 * 刻意不复用 `compact-hint/dynamic/pricing.ts`（其 tier 缺字段回落 base，与 pi-ai 不同）。
 * 输出 token 不计 ⇒ 估值是下界（少问方向）。测试与真实 `calculateCost` 交叉核对（≤1e-12）。
 */

export const BYTES_PER_TOKEN = 3;
export const IMAGE_TOKENS = 1600;

export type CostEstimate =
  | { kind: "priced"; usd: number; prefixTokens: number; newTokens: number; writeTtl: "5m" | "1h" | "none" }
  | { kind: "unpriced"; reason: "no-cost" | "rate-invalid" }
  | { kind: "unknown"; reason: "no-usage" };

/** pi-ai `ModelCost`/`ModelCostTier` 结构切片（读 `ctx.model.cost` 原样传入）。 */
interface RatesLike {
  input?: unknown;
  cacheWrite?: unknown;
  tiers?: unknown;
}

export function estimateNextRequestUsd(i: {
  prefixTokens: number | null | undefined;
  newText: string;
  imageCount: number;
  cost: unknown;
  writeTtl: "5m" | "1h" | "none";
}): CostEstimate {
  // P 非有限或 ≤0（含 null/undefined、刚压缩）⇒ unknown —— 前缀规模不可证。
  const P = i.prefixTokens;
  if (typeof P !== "number" || !Number.isFinite(P) || P <= 0) return { kind: "unknown", reason: "no-usage" };
  if (i.cost === null || typeof i.cost !== "object") return { kind: "unpriced", reason: "no-cost" };

  const N = Math.ceil(Buffer.byteLength(i.newText, "utf8") / BYTES_PER_TOKEN) + i.imageCount * IMAGE_TOKENS;

  // 合成 usage（cacheRead = output = 0）：
  //   none ⇒ 全前缀按 input 全价；5m ⇒ 前缀按 cacheWrite；1h ⇒ 前缀按 2×input（1h 部分单独计）。
  let input: number;
  let cacheWrite: number;
  let cacheWrite1h: number;
  switch (i.writeTtl) {
    case "none":
      input = P + N;
      cacheWrite = 0;
      cacheWrite1h = 0;
      break;
    case "5m":
      input = N;
      cacheWrite = P;
      cacheWrite1h = 0;
      break;
    case "1h":
      input = N;
      cacheWrite = P;
      cacheWrite1h = P;
      break;
  }

  // 档位：inputTokens = input+cacheRead+cacheWrite；`inputTokensAbove < inputTokens`
  // 中阈值最大的 tier 整组替换 base（与 pi-ai calculateCost 完全同判据，含严格大于）。
  const cost = i.cost as RatesLike;
  const inputTokens = input + cacheWrite;
  let rates: { input?: unknown; cacheWrite?: unknown } = cost;
  let matchedThreshold = -1;
  const tiers = Array.isArray(cost.tiers) ? cost.tiers : [];
  for (const tier of tiers) {
    if (tier === null || typeof tier !== "object") continue;
    const t = tier as { inputTokensAbove?: unknown; input?: unknown; cacheWrite?: unknown };
    const above = t.inputTokensAbove;
    if (typeof above !== "number" || !Number.isFinite(above)) continue;
    if (inputTokens > above && above > matchedThreshold) {
      rates = t;
      matchedThreshold = above;
    }
  }

  // 本次用到的单价（input 恒用；5m 另需 cacheWrite）非有限或 <0 ⇒ unpriced。
  const rateInput = rates.input;
  if (typeof rateInput !== "number" || !Number.isFinite(rateInput) || rateInput < 0) {
    return { kind: "unpriced", reason: "rate-invalid" };
  }
  if (i.writeTtl === "5m") {
    const rateWrite = rates.cacheWrite;
    if (typeof rateWrite !== "number" || !Number.isFinite(rateWrite) || rateWrite < 0) {
      return { kind: "unpriced", reason: "rate-invalid" };
    }
  }

  const shortWrite = cacheWrite - cacheWrite1h;
  // 与 pi-ai 逐项同序：cost.input = (rates.input/1e6)×input；
  // cost.cacheWrite = (rates.cacheWrite×shortWrite + rates.input×2×longWrite)/1e6；
  // total = 两者之和（output/cacheRead 恒为 0 项）。交叉核对误差 ≤1e-12。
  const costInput = (rateInput / 1e6) * input;
  const writeRate = typeof rates.cacheWrite === "number" && Number.isFinite(rates.cacheWrite) ? rates.cacheWrite : 0;
  const costCacheWrite = (writeRate * shortWrite + rateInput * 2 * cacheWrite1h) / 1e6;
  return { kind: "priced", usd: costInput + costCacheWrite, prefixTokens: P, newTokens: N, writeTtl: i.writeTtl };
}
