import { describe, expect, it } from "vitest";
import {
  buildPriceModel,
  normalizeTiers,
  priceSegments,
  rateAt,
  readRateAt,
  segmentContains,
  tierBoundaries,
  writeRateAt,
} from "../../../src/compact-hint/dynamic/pricing.js";
import type { PriceRates } from "../../../src/compact-hint/dynamic/types.js";

/** 研究 §4.1 的 GPT-5.6 Sol：cacheRead 在 272k 档翻倍（$0.4/M → $0.8/M）。 */
const SOL_BASE: PriceRates = { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 };
const SOL_RAW_TIERS = [{ inputTokensAbove: 272_000, input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 }];
const SOL_WINDOW = 372_000;

describe("dynamic pricing (§3.2)", () => {
  it("T-D1-PRICE-TIER: sol 272k 档 — readRateAt 在 271_999 / 272_000 为 0.4/M，272_001 为 0.8/M", () => {
    const price = buildPriceModel(SOL_BASE, SOL_RAW_TIERS);
    expect(price.readKnown).toBe(true);
    expect(readRateAt(price, 271_999)).toBeCloseTo(0.4 / 1_000_000, 15);
    expect(readRateAt(price, 272_000)).toBeCloseTo(0.4 / 1_000_000, 15);
    expect(readRateAt(price, 272_001)).toBeCloseTo(0.8 / 1_000_000, 15);
  });

  it("T-D1-TIER-BOUNDARY: P1-9 — B−1/B/B+1 三点归档正确（B 属低档），整组单价随之切换", () => {
    const price = buildPriceModel(SOL_BASE, SOL_RAW_TIERS);
    const low = rateAt(price, 272_000 - 1);
    const atB = rateAt(price, 272_000);
    const high = rateAt(price, 272_000 + 1);
    // B 本身仍属低档（严格大于判据）；B+1 才进高价档
    expect(atB).toEqual(low);
    expect(atB.cacheRead).toBe(0.4);
    expect(high.cacheRead).toBe(0.8);
    expect(high.input).toBe(8);
    // 写单价同规则
    expect(writeRateAt(price, 272_000)).toBeCloseTo(5 / 1_000_000, 15);
    expect(writeRateAt(price, 272_001)).toBeCloseTo(10 / 1_000_000, 15);
  });

  it("T-D1-TIER-BOUNDARY: 重复 inputTokensAbove 保留最后一个", () => {
    const tiers = normalizeTiers(
      [
        { inputTokensAbove: 100, cacheRead: 1, input: 1, output: 1, cacheWrite: 1 },
        { inputTokensAbove: 100, cacheRead: 2, input: 2, output: 2, cacheWrite: 2 },
      ],
      SOL_BASE,
    );
    expect(tiers).toHaveLength(1);
    expect(tiers[0]?.cacheRead).toBe(2);
  });

  it("T-D1-TIER-BOUNDARY: 负数 / NaN / 非有限 inputTokensAbove 被清洗掉", () => {
    const tiers = normalizeTiers(
      [
        { inputTokensAbove: -5, cacheRead: 9, input: 9, output: 9, cacheWrite: 9 },
        { inputTokensAbove: Number.NaN, cacheRead: 9, input: 9, output: 9, cacheWrite: 9 },
        { inputTokensAbove: Number.POSITIVE_INFINITY, cacheRead: 9, input: 9, output: 9, cacheWrite: 9 },
        { inputTokensAbove: 50, cacheRead: 0.8, input: 8, output: 40, cacheWrite: 10 },
      ],
      SOL_BASE,
    );
    expect(tiers).toHaveLength(1);
    expect(tiers[0]?.inputTokensAbove).toBe(50);
  });

  it("T-D1-TIER-BOUNDARY: 单价字段缺失 / 非有限时继承 base 对应字段；结果升序排序", () => {
    const tiers = normalizeTiers(
      [{ inputTokensAbove: 300, cacheRead: 0.9 }, { inputTokensAbove: 100, output: Number.NaN }, "not-a-tier", null],
      SOL_BASE,
    );
    expect(tiers.map((t) => t.inputTokensAbove)).toEqual([100, 300]);
    // 300 档只给了 cacheRead，其余继承 base
    expect(tiers[1]).toEqual({ inputTokensAbove: 300, input: 4, output: 20, cacheRead: 0.9, cacheWrite: 5 });
    // 100 档 output 非有限 ⇒ 继承 base；cacheRead 缺失 ⇒ 继承 base
    expect(tiers[0]).toEqual({ inputTokensAbove: 100, input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 });
  });

  it("tierBoundaries: 升序去重、只收 (0, W) 内的边界；去脏后的重复档不重复出现", () => {
    const price = buildPriceModel(SOL_BASE, [
      ...SOL_RAW_TIERS,
      { inputTokensAbove: 272_000, input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 }, // 重复
      { inputTokensAbove: 150_000, input: 6, output: 24, cacheRead: 0.6, cacheWrite: 7 },
      { inputTokensAbove: 0, input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
      { inputTokensAbove: 400_000, input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 }, // >= W
    ]);
    expect(tierBoundaries(price, SOL_WINDOW)).toEqual([150_000, 272_000]);
    // 非法窗口 ⇒ 空
    expect(tierBoundaries(price, 0)).toEqual([]);
    expect(tierBoundaries(price, Number.NaN)).toEqual([]);
  });

  it("priceSegments: 段覆盖 [0, W]、read 为 USD/token、边界点属低价段（segmentContains 与 rateAt 对齐）", () => {
    const price = buildPriceModel(SOL_BASE, SOL_RAW_TIERS);
    const segments = priceSegments(price, SOL_WINDOW);
    expect(segments).toEqual([
      { from: 0, to: 272_000, read: 0.4 / 1_000_000 },
      { from: 272_000, to: 372_000, read: 0.8 / 1_000_000 },
    ]);
    // B 属低价段；B+1 属高价段（与 rateAt 的 P1-9 语义一致）
    const low = segments[0]!;
    const high = segments[1]!;
    expect(segmentContains(low, 272_000)).toBe(true);
    expect(segmentContains(high, 272_000)).toBe(false);
    expect(segmentContains(high, 272_001)).toBe(true);
    // 每个段内的取价与 readRateAt 一致
    for (const [segment, probe] of [
      [low, 100_000],
      [low, 272_000],
      [high, 272_001],
      [high, 371_999],
    ] as const) {
      expect(segment.read).toBeCloseTo(readRateAt(price, probe), 15);
    }
  });

  it("readKnown / writeKnown: cacheRead 非 finite 正数（base 或任一档）⇒ readKnown=false；cacheWrite=0 ⇒ writeKnown=false", () => {
    expect(buildPriceModel({ ...SOL_BASE, cacheRead: 0 }, []).readKnown).toBe(false);
    expect(buildPriceModel({ ...SOL_BASE, cacheRead: Number.NaN }, []).readKnown).toBe(false);
    expect(buildPriceModel({ ...SOL_BASE, cacheRead: -0.4 }, []).readKnown).toBe(false);
    expect(
      buildPriceModel(SOL_BASE, [{ inputTokensAbove: 100, cacheRead: 0, input: 8, output: 40, cacheWrite: 10 }])
        .readKnown,
    ).toBe(false);
    // Kimi 式：读价已知、写价 0/缺失
    const kimi = buildPriceModel({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }, []);
    expect(kimi.readKnown).toBe(true);
    expect(kimi.writeKnown).toBe(false);
  });
});
