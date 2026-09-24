import { describe, expect, it } from "vitest";
import {
  composeHintLineTokens,
  computeDynamicThreshold,
  type DynamicThresholdInput,
} from "../../../src/compact-hint/dynamic/threshold.js";
import {
  buildPriceModel,
  priceSegments,
  rateAt,
  segmentContains,
  tierBoundaries,
} from "../../../src/compact-hint/dynamic/pricing.js";
import {
  cycleAverageCostUsd,
  closedFormCStarTokens,
  cycleTurns,
  fixedCostUsd,
} from "../../../src/compact-hint/dynamic/cost-model.js";
import type { DynamicConfig, DynamicThresholdOutcome, PriceModel } from "../../../src/compact-hint/dynamic/types.js";
import {
  effectiveThresholdPercentWithTokens,
  thresholdLineTokens,
  windowScaledForcePercent,
} from "../../../src/compact-hint/threshold.js";

/** 与 tests/core/core.test.ts 同款 seeded PRNG（mulberry32）。 */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const OPUS: PriceModel = buildPriceModel({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, []);
const SOL: PriceModel = buildPriceModel({ input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 }, [
  { inputTokensAbove: 272_000, input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 },
]);
const TERRA: PriceModel = buildPriceModel({ input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 }, [
  { inputTokensAbove: 272_000, input: 4, output: 24, cacheRead: 0.4, cacheWrite: 5 },
]);
const KIMI: PriceModel = buildPriceModel({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }, []);

const DEFAULT_CONFIG: DynamicConfig = {
  mode: "on",
  minHintPercent: 35,
  maxQualityPercent: 60,
  rediscoveryUsd: 10,
  unknownPriceMode: "static",
};

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[Math.floor(next() * values.length)] as T;
}

function rand(next: () => number, lo: number, hi: number): number {
  return lo + next() * (hi - lo);
}

/** 正常域场景（P1–P8）：价格已知、参数有限、订阅分支关闭。 */
function randomSaneInput(next: () => number, overrides: { minHintAtLeast10?: boolean } = {}): DynamicThresholdInput {
  const window = pick(next, [32_000, 100_000, 200_000, 372_000, 1_000_000, 1_048_576]);
  const price = pick(next, [OPUS, SOL, TERRA, KIMI]);
  const minHintChoices = overrides.minHintAtLeast10 ? ([10, 25, 35, 45] as const) : ([0, 15, 25, 35, 45] as const);
  return {
    window,
    usedTokens: rand(next, 10_000, window * 0.9),
    price,
    growth: { g: rand(next, 300, 4_000), sigma: rand(next, 0, 1_500), samples: pick(next, [0, 3, 9, 40]) },
    start: { s0: rand(next, 4_000, Math.min(400_000, window * 0.3)), samples: pick(next, [0, 1, 5]) },
    handoffTokens: rand(next, 0, 8_000),
    config: {
      ...DEFAULT_CONFIG,
      minHintPercent: pick(next, minHintChoices),
      rediscoveryUsd: rand(next, 0, 60),
    },
    force: { atPercent: pick(next, [0, 50, 65, 88, 95]), atTokensK: pick(next, [0, 0, 100, 550, 900]) },
    reserveTokens: pick(next, [16_384, 32_768, 100_000]),
    epoch: 7,
  };
}

/** 脏数据场景（P9）：注入 0 / 负价 / NaN / 极小窗口 / 极大 g / 脏 tier。 */
function randomDirtyInput(next: () => number): DynamicThresholdInput {
  const window = pick(next, [32_000, 372_000, 1_000_000, 100_000, Number.NaN, 0, 31_999]);
  const pricePool: PriceModel[] = [
    buildPriceModel({ input: 4, output: 20, cacheRead: 0, cacheWrite: 5 }, []), // cacheRead=0
    buildPriceModel({ input: 4, output: 20, cacheRead: -0.4, cacheWrite: 5 }, []), // 负读价
    buildPriceModel({ input: 4, output: 20, cacheRead: Number.NaN, cacheWrite: Number.NaN }, []), // NaN 价
    buildPriceModel({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, [
      { inputTokensAbove: -100, input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 }, // 负阈值 → 清洗
      { inputTokensAbove: Number.NaN, input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 }, // NaN → 清洗
      { inputTokensAbove: 272_000, cacheRead: Number.NaN }, // 单价缺失 → 继承 base
      { inputTokensAbove: 272_000, input: 8, output: 40, cacheRead: -0.8, cacheWrite: 10 }, // 负读价档 → readKnown=false
    ]),
    OPUS,
  ];
  const input = randomSaneInput(next);
  return {
    ...input,
    window,
    usedTokens: pick(next, [input.usedTokens, null, Number.NaN, 0]),
    price: pick(next, pricePool),
    growth: {
      g: pick(next, [input.growth.g, 50, 1e6, Number.NaN]),
      sigma: pick(next, [0, 500, Number.NaN, -5]),
      samples: 30,
    },
    start: { s0: pick(next, [input.start.s0, 1_000, 900_000, Number.NaN]), samples: 1 },
    handoffTokens: pick(next, [input.handoffTokens, 0, Number.NaN]),
    config: {
      ...input.config,
      minHintPercent: pick(next, [input.config.minHintPercent, 0, 60, Number.NaN, -5]),
      maxQualityPercent: pick(next, [60, 80, 0.9, 100, Number.NaN]),
      rediscoveryUsd: pick(next, [input.config.rediscoveryUsd, 0, -3, Number.NaN]),
      unknownPriceMode: pick(next, ["static", "quality"] as const),
    },
    force: { atPercent: pick(next, [0, 50, 88, 95, Number.NaN]), atTokensK: pick(next, [0, 550, 900, Number.NaN]) },
    reserveTokens: pick(next, [16_384, 0, 500_000, Number.NaN]),
    staticHint: next() < 0.3 ? { percent: pick(next, [0, 75]), tokensK: pick(next, [0, 500, 2_000]) } : undefined,
    subscription: next() < 0.2 ? { active: true, usedPct: pick(next, [null, rand(next, 0, 120)]) } : undefined,
  };
}

/** 与实现同式的读侧 clamp（P7 独立重建候选用；见 threshold.ts 步骤 5–7）。 */
function expectedBounds(input: DynamicThresholdInput) {
  const w = input.window;
  const sigma = Number.isFinite(input.growth.sigma) && input.growth.sigma > 0 ? input.growth.sigma : 0;
  const g = Math.min(0.1 * w, Math.max(300, (Number.isFinite(input.growth.g) ? input.growth.g : 0) + 0.5 * sigma));
  const s0 = Math.min(0.35 * w, Math.max(4_000, Number.isFinite(input.start.s0) ? input.start.s0 : 0));
  const lowerBound = Math.max((input.config.minHintPercent / 100) * w, s0 + 2 * g);
  const effForce = effectiveThresholdPercentWithTokens(
    windowScaledForcePercent(input.force.atPercent, w),
    input.force.atTokensK,
    w,
    input.reserveTokens,
  );
  const forceCap = effForce > 0 ? (effForce / 100) * w - 0.03 * w : Number.POSITIVE_INFINITY;
  const cap = Math.min((input.config.maxQualityPercent / 100) * w, w - input.reserveTokens, forceCap);
  return { g, s0, lowerBound, cap };
}

/** P7 的独立候选重建（§3.4 第 10 步）。 */
function rebuildCandidates(input: DynamicThresholdInput): number[] {
  const { g, s0, lowerBound, cap } = expectedBounds(input);
  const segments = priceSegments(input.price, input.window);
  const kUsd = fixedCostUsd({
    handoffTokens: input.handoffTokens,
    outputPerM: rateAt(input.price, s0).output,
    s0,
    price: input.price,
    rediscoveryUsd: input.config.rediscoveryUsd,
  });
  const margin = Math.max(2 * g, 0.01 * input.window);
  const values = [lowerBound, cap];
  for (const segment of segments) {
    const cStar = closedFormCStarTokens(s0, kUsd, g, segment.read);
    if (cStar !== undefined && segmentContains(segment, cStar) && cStar >= lowerBound && cStar <= cap) {
      values.push(cStar);
    }
  }
  for (const boundary of tierBoundaries(input.price, input.window)) {
    if (boundary - margin >= lowerBound && boundary - margin <= cap) values.push(boundary - margin);
    if (boundary >= lowerBound && boundary <= cap) values.push(boundary);
  }
  return values;
}

function effectiveForceOf(input: DynamicThresholdInput): number {
  return effectiveThresholdPercentWithTokens(
    windowScaledForcePercent(input.force.atPercent, input.window),
    input.force.atTokensK,
    input.window,
    input.reserveTokens,
  );
}

/** 递归断言：所有数字叶子有限且 >= 0（P9）。 */
function assertFiniteNonNegativeNumbers(value: unknown, path: string): void {
  if (typeof value === "number") {
    expect(Number.isFinite(value), `${path} 必须有限（实际 ${value}）`).toBe(true);
    expect(value, `${path} 必须非负（实际 ${value}）`).toBeGreaterThanOrEqual(0);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => assertFiniteNonNegativeNumbers(item, `${path}[${i}]`));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) assertFiniteNonNegativeNumbers(child, `${path}.${key}`);
  }
}

describe("dynamic threshold 性质（§12 D1，seeded）", () => {
  it("P1: R ↑ ⇒ hintTokens 单调不减（usable:true 的样本内）", () => {
    const next = mulberry32(1101);
    const rGrid = [0, 0.5, 1, 2, 5, 10, 15, 20, 30, 50, 80, 120];
    let viableSeeds = 0;
    for (let seed = 0; seed < 200; seed += 1) {
      const base = randomSaneInput(next);
      const lines: number[] = [];
      for (const rediscoveryUsd of rGrid) {
        const outcome = computeDynamicThreshold({ ...base, config: { ...base.config, rediscoveryUsd } });
        if (outcome.usable) lines.push(outcome.hintTokens);
      }
      // 可行性与 R 无关：要么全可用要么全不可用，不会掺杂
      expect(lines.length === 0 || lines.length === rGrid.length).toBe(true);
      if (lines.length === 0) continue; // 场景整体不可行（如 reserve 占窗口过大）
      viableSeeds += 1;
      for (let i = 1; i < lines.length; i += 1) {
        expect(lines[i]).toBeGreaterThanOrEqual(lines[i - 1] - 1e-6);
      }
    }
    expect(viableSeeds).toBeGreaterThan(30);
  });

  it("P2: cacheRead ↑ ⇒ cStar 单调不增", () => {
    const next = mulberry32(1102);
    let viableSeeds = 0;
    for (let seed = 0; seed < 200; seed += 1) {
      const base = randomSaneInput(next, { minHintAtLeast10: true });
      if (base.price.tiers.length > 0) continue; // 无档模型：cStar 与 cacheRead 一一对应
      const multipliers = [0.25, 0.5, 1, 2, 4, 8];
      const stars: number[] = [];
      for (const multiplier of multipliers) {
        const price = buildPriceModel({ ...base.price.base, cacheRead: base.price.base.cacheRead * multiplier }, []);
        const outcome = computeDynamicThreshold({ ...base, price });
        if (outcome.usable && outcome.cStarTokens !== undefined) stars.push(outcome.cStarTokens);
      }
      if (stars.length === 0) continue;
      viableSeeds += 1;
      for (let i = 1; i < stars.length; i += 1) {
        expect(stars[i]).toBeLessThanOrEqual(stars[i - 1] + 1e-6);
      }
    }
    expect(viableSeeds).toBeGreaterThan(20);
  });

  it("P3: g ↑ ⇒ cStar 单调不减", () => {
    const next = mulberry32(1103);
    let viableSeeds = 0;
    for (let seed = 0; seed < 200; seed += 1) {
      const base = randomSaneInput(next, { minHintAtLeast10: true });
      if (base.price.tiers.length > 0) continue;
      const gGrid = [300, 500, 800, 1200, 2000, 4000, 8000];
      const stars: number[] = [];
      for (const g of gGrid) {
        const outcome = computeDynamicThreshold({ ...base, growth: { g, sigma: 0, samples: 30 } });
        if (outcome.usable && outcome.cStarTokens !== undefined) stars.push(outcome.cStarTokens);
      }
      if (stars.length === 0) continue;
      viableSeeds += 1;
      for (let i = 1; i < stars.length; i += 1) {
        expect(stars[i]).toBeGreaterThanOrEqual(stars[i - 1] - 1e-6);
      }
    }
    expect(viableSeeds).toBeGreaterThan(20);
  });

  it("P4: usable:true ∧ 有效 force 线 > 0 ⇒ hintPercent + 1 ≤ forcePercent", () => {
    const next = mulberry32(1104);
    let checked = 0;
    for (let seed = 0; seed < 300; seed += 1) {
      const input = randomSaneInput(next, { minHintAtLeast10: true });
      const effForce = effectiveForceOf(input);
      if (effForce <= 0) continue;
      const outcome = computeDynamicThreshold(input);
      if (!outcome.usable) continue;
      checked += 1;
      expect(outcome.hintPercent + 1).toBeLessThanOrEqual(effForce);
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("P5: usable:true ⇒ max(lowerBound, ceil(W/100)) ≤ hintTokens ≤ cap ≤ min(W−reserve, 60%·W)", () => {
    const next = mulberry32(1105);
    let checked = 0;
    for (let seed = 0; seed < 300; seed += 1) {
      const input = randomSaneInput(next); // maxQualityPercent 恒 60
      const outcome = computeDynamicThreshold(input);
      if (!outcome.usable) continue;
      checked += 1;
      const minLine = Math.ceil(input.window / 100);
      expect(outcome.hintTokens).toBeGreaterThanOrEqual(Math.max(outcome.lowerBound, minLine) - 1e-6);
      expect(outcome.hintTokens).toBeLessThanOrEqual(outcome.cap + 1e-6);
      expect(outcome.cap).toBeLessThanOrEqual(Math.min(input.window - input.reserveTokens, 0.6 * input.window) + 1e-6);
      expect(outcome.hintPercent).toBeGreaterThanOrEqual(1);
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("P6a: P1-8 — 价格未知 + static ⇒ usable:false，合成结果与直接用静态线逐字节一致", () => {
    const next = mulberry32(1106);
    let checked = 0;
    for (let seed = 0; seed < 100; seed += 1) {
      const base = randomSaneInput(next);
      const price = buildPriceModel({ ...base.price.base, cacheRead: pick(next, [0, Number.NaN]) }, []);
      const staticLines = pick(next, [
        { percent: 75, tokensK: 0 },
        { percent: 0, tokensK: 500 },
      ]);
      // 静态线自身已失效的组合（如小窗口下 500k 绝对线）走 static-hint-disabled，另由单测钉死
      if (
        !effectiveThresholdPercentWithTokens(staticLines.percent, staticLines.tokensK, base.window, base.reserveTokens)
      ) {
        continue;
      }
      checked += 1;
      const outcome = computeDynamicThreshold({ ...base, price, staticHint: staticLines });
      expect(outcome).toEqual({ usable: false, reason: "price-unknown" });
      // 合成（§3.6）与直接用静态线逐字节一致：退化 ⇒ 现行行为
      const composed = composeHintLineTokens({
        staticLines,
        window: base.window,
        reserveTokens: base.reserveTokens,
        mode: "on",
        dynamic: outcome,
      });
      expect(composed).toBe(thresholdLineTokens(staticLines.percent, staticLines.tokensK, base.window));
    }
    expect(checked).toBeGreaterThan(30);
  });

  it("P6b: P1-8 — 价格未知 + quality ⇒ usable:true（非价格原因退化除外），满足 P5，且未进成本模型", () => {
    const next = mulberry32(1107);
    let checked = 0;
    for (let seed = 0; seed < 200; seed += 1) {
      const base = randomSaneInput(next);
      const price = buildPriceModel({ ...base.price.base, cacheRead: 0 }, []);
      const outcome = computeDynamicThreshold({
        ...base,
        price,
        config: { ...base.config, unknownPriceMode: "quality" },
      });
      if (!outcome.usable) {
        // 质量模式下价格绝不成为退化原因；只可能是场景本身不可行
        expect(outcome.reason).toBe("infeasible-range");
        continue;
      }
      checked += 1;
      const minLine = Math.ceil(base.window / 100);
      expect(outcome.hintTokens).toBeGreaterThanOrEqual(Math.max(outcome.lowerBound, minLine) - 1e-6);
      expect(outcome.hintTokens).toBeLessThanOrEqual(outcome.cap + 1e-6);
      expect(outcome.basis).toBe("quality-cap");
      expect(outcome.cStarTokens).toBeUndefined();
      // 不等于任何 argmin 候选：未进成本模型 ⇒ 候选集恒空
      expect(outcome.candidates).toEqual([]);
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("P7: argmin 正确性 — 返回点 A(C) ≤ 所有候选的 A(C)", () => {
    const next = mulberry32(1108);
    let checked = 0;
    for (let seed = 0; seed < 200; seed += 1) {
      // minHint >= 10%：保证量化抬升永不介入（ceil(W/100) < lowerBound），返回点即 argmin 原值
      const input = randomSaneInput(next, { minHintAtLeast10: true });
      const outcome = computeDynamicThreshold(input);
      if (!outcome.usable || outcome.candidates.length === 0) continue; // 只考常规分支
      checked += 1;
      const { g, s0 } = expectedBounds(input);
      const segments = priceSegments(input.price, input.window);
      const kUsd = fixedCostUsd({
        handoffTokens: input.handoffTokens,
        outputPerM: rateAt(input.price, s0).output,
        s0,
        price: input.price,
        rediscoveryUsd: input.config.rediscoveryUsd,
      });
      const cycle = { s0, g, kUsd, segments };
      const returnedCost = cycleAverageCostUsd(cycle, outcome.hintTokens);
      for (const candidate of rebuildCandidates(input)) {
        expect(returnedCost).toBeLessThanOrEqual(cycleAverageCostUsd(cycle, candidate) + 1e-9);
      }
      for (const candidate of outcome.candidates) {
        expect(returnedCost).toBeLessThanOrEqual(candidate.usdPerTurn + 1e-9);
      }
    }
    expect(checked).toBeGreaterThan(80);
  });

  it("P8: 幂等 — 把输出回填成 published 再算一次，结果不变（percent/basis 层）", () => {
    const next = mulberry32(1109);
    let checked = 0;
    for (let seed = 0; seed < 200; seed += 1) {
      const input = randomSaneInput(next);
      const first = computeDynamicThreshold(input);
      if (!first.usable) continue;
      checked += 1;
      const second = computeDynamicThreshold({
        ...input,
        published: { percent: first.hintPercent, epoch: input.epoch },
      });
      expect(second.usable).toBe(true);
      if (second.usable) {
        expect(second.hintPercent).toBe(first.hintPercent);
        expect(second.basis).toBe(first.basis);
      }
    }
    expect(checked).toBeGreaterThan(80);
  });

  it("P9: 全域无 NaN/Infinity/负数（注入 0、负价、极小窗口、极大 g、脏 tier）", () => {
    const next = mulberry32(1110);
    let usable = 0;
    for (let seed = 0; seed < 600; seed += 1) {
      // 一半种子保持正常域（保证大量 usable 样本被扫描），一半注入脏数据
      const input = seed % 2 === 0 ? randomSaneInput(next) : randomDirtyInput(next);
      const outcome = computeDynamicThreshold(input); // 不抛即过第一步
      if (outcome.usable) {
        usable += 1;
        expect(outcome.hintPercent).toBeGreaterThanOrEqual(1);
        assertFiniteNonNegativeNumbers(outcome, `seed#${seed}`);
      } else {
        expect(Object.keys(outcome).sort()).toEqual(["reason", "usable"]);
      }
    }
    expect(usable).toBeGreaterThan(100);
  });

  it("P10: 分段成本 == 朴素成本（seeded 随机场景）", () => {
    const next = mulberry32(1111);
    const rand = (lo: number, hi: number) => lo + next() * (hi - lo);
    for (let i = 0; i < 200; i += 1) {
      const window = Math.round(rand(60_000, 1_200_000));
      const s0 = rand(1_000, Math.min(50_000, window * 0.3));
      const g = rand(120, 3_000);
      const kUsd = rand(0.01, 20);
      const base = { input: rand(1, 8), output: rand(5, 40), cacheRead: rand(0.05, 1.5), cacheWrite: rand(0.5, 8) };
      const threshold = rand(s0 + g, window - 1);
      const price = buildPriceModel(base, [
        {
          inputTokensAbove: threshold,
          input: base.input * 2,
          output: base.output * 2,
          cacheRead: base.cacheRead * 2,
          cacheWrite: base.cacheWrite * 2,
        },
      ]);
      const segments = priceSegments(price, window);
      const probe = rand(s0 + g, window * 0.98);
      const segmented = cycleAverageCostUsd({ s0, g, kUsd, segments }, probe);
      const m = cycleTurns(probe, s0, g);
      let naiveSum = 0;
      for (let j = 0; j < m; j += 1) {
        const context = s0 + j * g;
        const read = rateAt(price, context).cacheRead / 1e6;
        if (read > 0) naiveSum += read * context;
      }
      const naive = kUsd / m + naiveSum / m;
      expect(Math.abs(segmented - naive)).toBeLessThan(1e-9);
    }
  });

  it("P11: P0-1 — 输出恒为判别联合之一；usable:false 分支不含任何数值线字段", () => {
    const next = mulberry32(1112);
    const reasons = new Set([
      "window-unknown",
      "window-too-small",
      "usage-unknown",
      "price-unknown",
      "infeasible-range",
      "static-hint-disabled",
      "internal-error",
    ]);
    let usableCount = 0;
    for (let seed = 0; seed < 300; seed += 1) {
      const input = seed % 2 === 0 ? randomSaneInput(next, { minHintAtLeast10: true }) : randomDirtyInput(next);
      const outcome: DynamicThresholdOutcome = computeDynamicThreshold(input);
      if (outcome.usable) {
        usableCount += 1;
        expect(typeof outcome.hintTokens).toBe("number");
        expect(outcome.hintTokens).toBeGreaterThan(0);
        expect(Number.isInteger(outcome.hintPercent)).toBe(true);
        expect(Array.isArray(outcome.candidates)).toBe(true);
        expect(outcome.candidates.length).toBeLessThanOrEqual(8);
      } else {
        expect(Object.keys(outcome).sort()).toEqual(["reason", "usable"]);
        expect(reasons.has(outcome.reason)).toBe(true);
      }
    }
    expect(usableCount).toBeGreaterThan(50);
  });
});
