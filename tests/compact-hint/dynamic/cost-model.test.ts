import { describe, expect, it } from "vitest";
import {
  closedFormCStarTokens,
  cycleAverageCostUsd,
  cycleTurns,
  fixedCostUsd,
} from "../../../src/compact-hint/dynamic/cost-model.js";
import { buildPriceModel, priceSegments } from "../../../src/compact-hint/dynamic/pricing.js";

/** 研究 §4.1 的 Claude Opus 5.5：1M 窗口，input 4 / output 20 / cacheRead 0.2 / cacheWrite 5。 */
const OPUS_BASE = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
const SOL_BASE = { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 };

/** 朴素逐轮求和（P10 的参照实现）：第 j 轮上下文 S0 + j·g，单价按 rateAt 逐轮取。 */
function naiveCycleCostUsd(
  args: { s0: number; g: number; kUsd: number; readAt: (tokens: number) => number },
  c: number,
): number {
  const m = cycleTurns(c, args.s0, args.g);
  let sum = 0;
  for (let j = 0; j < m; j += 1) {
    const context = args.s0 + j * args.g;
    const read = args.readAt(context);
    if (read > 0) sum += read * context;
  }
  return args.kUsd / m + sum / m;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe("dynamic cost model (§3.3)", () => {
  it("cycleTurns: max(1, ceil((C − S0)/g))，g 非法 ⇒ 1", () => {
    expect(cycleTurns(10_000, 4_000, 800)).toBe(8); // ceil(7.5)
    expect(cycleTurns(4_000, 4_000, 800)).toBe(1);
    expect(cycleTurns(3_000, 4_000, 800)).toBe(1); // C < S0 钳到 1
    expect(cycleTurns(10_000, 4_000, 0)).toBe(1); // g 非法防 P9
    expect(cycleTurns(Number.NaN, 4_000, 800)).toBe(1);
  });

  it("T-D1-COST-SEGMENTS: 分段求和 == 朴素逐轮求和（随机 200 组，误差 < 1e-9）", () => {
    const next = mulberry32(20260925);
    const rand = (lo: number, hi: number) => lo + next() * (hi - lo);
    for (let i = 0; i < 200; i += 1) {
      const window = Math.round(rand(60_000, 1_200_000));
      const s0 = rand(1_000, Math.min(50_000, window * 0.3));
      const g = rand(120, 3_000);
      const kUsd = rand(0.01, 20);
      const tierCount = Math.floor(next() * 3);
      const base = {
        input: rand(1, 8),
        output: rand(5, 40),
        cacheRead: rand(0.05, 1.5),
        cacheWrite: rand(0.5, 8),
      };
      const thresholds = Array.from({ length: tierCount }, () => rand(s0 + g, window - 1))
        .sort((a, b) => a - b)
        .filter((v, idx, arr) => arr.indexOf(v) === idx);
      const rawTiers = thresholds.map((above) => ({
        inputTokensAbove: above,
        input: base.input * 2,
        output: base.output * 2,
        cacheRead: base.cacheRead * (1.5 + next()),
        cacheWrite: base.cacheWrite * 2,
      }));
      const price = buildPriceModel(base, rawTiers);
      const segments = priceSegments(price, window);
      const cycle = { s0, g, kUsd, segments };
      const probe = rand(s0 + g, window * 0.98);
      const segmented = cycleAverageCostUsd(cycle, probe);
      const naive = naiveCycleCostUsd(
        {
          s0,
          g,
          kUsd,
          readAt: (tokens) => {
            // 逐轮按全请求档位取价（tier 语义与 rateAt 一致：严格大于）
            let rate = base.cacheRead;
            for (const tier of price.tiers) if (tokens > tier.inputTokensAbove) rate = tier.cacheRead;
            return rate / 1e6;
          },
        },
        probe,
      );
      expect(Math.abs(segmented - naive)).toBeLessThan(1e-9);
    }
  });

  it("T-D1-CSTAR: 复现研究 §4.2 — Opus 5.5（K=$0.48, g=774, S0=100k, r=$0.2/M）⇒ 160,952 ± 1%", () => {
    const cStar = closedFormCStarTokens(100_000, 0.48, 774, 0.2 / 1_000_000);
    expect(cStar).toBeDefined();
    expect(Math.abs((cStar as number) - 160_952)).toBeLessThan(160_952 * 0.01);
    expect(cStar).toBeCloseTo(160_952.44, -1); // 数值锚点
  });

  it("T-D1-CSTAR-R10: R=10 ⇒ Opus 5.5 的 C* 落在 [380k, 420k]（§5.1 默认值的依据）", () => {
    const price = buildPriceModel(OPUS_BASE, []);
    // K = H + R + Wnew = 2000·20/1e6 + 10 + 100k·5e-6 = 0.04 + 10 + 0.5 = 10.54
    const kUsd = fixedCostUsd({ handoffTokens: 2_000, outputPerM: 20, s0: 100_000, price, rediscoveryUsd: 10 });
    expect(kUsd).toBeCloseTo(10.54, 6);
    const cStar = closedFormCStarTokens(100_000, kUsd, 774, 0.2 / 1_000_000);
    expect(cStar).toBeDefined();
    expect(cStar as number).toBeGreaterThanOrEqual(380_000);
    expect(cStar as number).toBeLessThanOrEqual(420_000);
  });

  it("fixedCostUsd: 写价未知/0 ⇒ Wnew=0；输出价缺失 ⇒ H=0；负 R 钳 0；K 恒 >= 0", () => {
    const noWrite = buildPriceModel({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }, []);
    expect(
      fixedCostUsd({ handoffTokens: 2_000, outputPerM: 15, s0: 100_000, price: noWrite, rediscoveryUsd: 10 }),
    ).toBeCloseTo(10 + (2_000 * 15) / 1e6, 9);
    const opus = buildPriceModel(OPUS_BASE, []);
    expect(
      fixedCostUsd({ handoffTokens: 2_000, outputPerM: 0, s0: 100_000, price: opus, rediscoveryUsd: 10 }),
    ).toBeCloseTo(10 + 100_000 * (5 / 1e6), 9);
    expect(
      fixedCostUsd({ handoffTokens: 2_000, outputPerM: 20, s0: 100_000, price: opus, rediscoveryUsd: -5 }),
    ).toBeCloseTo(0.04 + 0.5, 9);
    // R=0 合法（纯 cache-read 最优，会被地板兜住）
    expect(fixedCostUsd({ handoffTokens: 0, outputPerM: 20, s0: 100_000, price: opus, rediscoveryUsd: 0 })).toBeCloseTo(
      0.5,
      9,
    );
  });

  it("closedFormCStarTokens: read 非正 / 参数非法 ⇒ undefined；K=0 ⇒ C* = S0", () => {
    expect(closedFormCStarTokens(100_000, 1, 800, 0)).toBeUndefined();
    expect(closedFormCStarTokens(100_000, 1, 800, -0.2e-6)).toBeUndefined();
    expect(closedFormCStarTokens(100_000, 1, 0, 0.2e-6)).toBeUndefined();
    expect(closedFormCStarTokens(100_000, -1, 800, 0.2e-6)).toBeUndefined();
    expect(closedFormCStarTokens(100_000, 0, 800, 0.2e-6)).toBe(100_000);
  });

  it("cycleAverageCostUsd 与闭式解自洽：无档、K=0.48 的 Opus 参数在 C* 处取到 A 的极小值", () => {
    const price = buildPriceModel(OPUS_BASE, []);
    const segments = priceSegments(price, 1_000_000);
    const s0 = 100_000;
    const g = 774;
    const kUsd = 0.48;
    const cycle = { s0, g, kUsd, segments };
    const cStar = closedFormCStarTokens(s0, kUsd, g, 0.2 / 1e6) as number;
    for (const probe of [cStar - 5_000, cStar + 5_000, cStar - 20_000, cStar + 20_000, 500_000]) {
      expect(cycleAverageCostUsd(cycle, cStar)).toBeLessThanOrEqual(cycleAverageCostUsd(cycle, probe) + 1e-12);
    }
  });

  it("跨档代价可见：sol 模型在 B 上下各取一点，越过 272k 后周期成本显著抬升", () => {
    const price = buildPriceModel(SOL_BASE, [
      { inputTokensAbove: 272_000, input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 },
    ]);
    const segments = priceSegments(price, 372_000);
    const cycle = { s0: 37_200, g: 800, kUsd: 13.376, segments };
    const justBelow = cycleAverageCostUsd(cycle, 272_000);
    const wellAbove = cycleAverageCostUsd(cycle, 320_000);
    expect(wellAbove).toBeGreaterThan(justBelow);
  });
});
