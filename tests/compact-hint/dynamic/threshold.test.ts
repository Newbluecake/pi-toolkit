import { describe, expect, it } from "vitest";
import {
  composeHintLineTokens,
  computeDynamicThreshold,
  resolveSubscriptionPressure,
  staticHintActive,
  subscriptionPressureLine,
  type DynamicThresholdInput,
  type SubscriptionStateInput,
} from "../../../src/compact-hint/dynamic/threshold.js";
import { buildPriceModel } from "../../../src/compact-hint/dynamic/pricing.js";
import type { DynamicConfig, DynamicThresholdOutcome, PriceModel } from "../../../src/compact-hint/dynamic/types.js";
import {
  effectiveThresholdPercentWithTokens,
  thresholdLineTokens,
  windowScaledForcePercent,
} from "../../../src/compact-hint/threshold.js";

/** 研究 §4.1 的代表价格。 */
const OPUS: PriceModel = buildPriceModel({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, []);
const SOL: PriceModel = buildPriceModel({ input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 }, [
  { inputTokensAbove: 272_000, input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 },
]);
const KIMI_NO_WRITE: PriceModel = buildPriceModel({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }, []);

const DEFAULT_CONFIG: DynamicConfig = {
  mode: "on",
  minHintPercent: 35,
  maxQualityPercent: 60,
  rediscoveryUsd: 10,
  unknownPriceMode: "static",
};

function baseInput(overrides: Partial<DynamicThresholdInput> = {}): DynamicThresholdInput {
  return {
    window: 1_000_000,
    usedTokens: 400_000,
    price: OPUS,
    growth: { g: 800, sigma: 0, samples: 30 },
    start: { s0: 100_000, samples: 4 },
    handoffTokens: 2_000,
    config: { ...DEFAULT_CONFIG },
    force: { atPercent: 88, atTokensK: 0 },
    reserveTokens: 16_384,
    epoch: 3,
    ...overrides,
  };
}

function compute(overrides: Partial<DynamicThresholdInput> = {}): DynamicThresholdOutcome {
  return computeDynamicThreshold(baseInput(overrides));
}

describe("dynamic threshold §3.4 (D1)", () => {
  it("T-D1-USABLE: P0-1 — 六种退化各自返回 {usable:false, reason}；usable:true 时 hintTokens > 0", () => {
    // 1. window-unknown（W 缺失 / 非有限 / <= 0）
    expect(compute({ window: 0 })).toEqual({ usable: false, reason: "window-unknown" });
    expect(compute({ window: Number.NaN })).toEqual({ usable: false, reason: "window-unknown" });
    expect(compute({ window: -1 })).toEqual({ usable: false, reason: "window-unknown" });
    // 2. window-too-small
    expect(compute({ window: 31_999, usedTokens: 10_000 })).toEqual({ usable: false, reason: "window-too-small" });
    // 3. usage-unknown（tokens == null；NaN 同样视为未测到）
    expect(compute({ usedTokens: null })).toEqual({ usable: false, reason: "usage-unknown" });
    expect(compute({ usedTokens: Number.NaN })).toEqual({ usable: false, reason: "usage-unknown" });
    // 4. price-unknown（cacheRead 非有限正数 + static 模式）
    const noRead = buildPriceModel({ input: 4, output: 20, cacheRead: 0, cacheWrite: 5 }, []);
    expect(compute({ price: noRead })).toEqual({ usable: false, reason: "price-unknown" });
    // 5. infeasible-range（reserve 占窗口 80%）
    expect(compute({ reserveTokens: 800_000 })).toEqual({ usable: false, reason: "infeasible-range" });
    // 6. static-hint-disabled（percent=0 且绝对线 2000k > 窗口 1M ⇒ 自动失效）
    expect(compute({ staticHint: { percent: 0, tokensK: 2_000 } })).toEqual({
      usable: false,
      reason: "static-hint-disabled",
    });

    // usable:true ⇒ 恒有正线（P0-1 的另一半）
    const usable = compute();
    expect(usable.usable).toBe(true);
    if (usable.usable) {
      expect(usable.hintTokens).toBeGreaterThan(0);
      expect(usable.hintPercent).toBeGreaterThanOrEqual(1);
    }
    // usable:false 分支不含任何数值线字段（P11）
    for (const outcome of [
      compute({ window: 0 }),
      compute({ window: 31_999, usedTokens: 1 }),
      compute({ usedTokens: null }),
      compute({ price: noRead }),
      compute({ reserveTokens: 800_000 }),
      compute({ staticHint: { percent: 0, tokensK: 2_000 } }),
    ]) {
      expect(outcome.usable).toBe(false);
      expect(Object.keys(outcome).sort()).toEqual(["reason", "usable"]);
    }
  });

  it("T-D1-FEASIBLE: P0-2 — 候选集恒含两端点；cap < lowerBound ⇒ infeasible；reserve 占 80% ⇒ 退化；W=31_999 ⇒ window-too-small", () => {
    const outcome = compute();
    expect(outcome.usable).toBe(true);
    if (!outcome.usable) return;
    const tokens = outcome.candidates.map((c) => c.tokens);
    expect(tokens).toContain(outcome.lowerBound);
    expect(tokens).toContain(outcome.cap);
    expect(outcome.candidates.length).toBeLessThanOrEqual(8);
    // 质量上限低于地板 ⇒ infeasible（不再出现需要仲裁的「地板顶穿上限」状态）
    expect(compute({ config: { ...DEFAULT_CONFIG, minHintPercent: 90 } })).toEqual({
      usable: false,
      reason: "infeasible-range",
    });
    // reserve 接近窗口
    expect(compute({ reserveTokens: 800_000 })).toEqual({ usable: false, reason: "infeasible-range" });
    // 极小窗口
    expect(compute({ window: 31_999, usedTokens: 10_000 })).toEqual({ usable: false, reason: "window-too-small" });
    // 边界值：W = 32_000 恰好放行
    const atMin = compute({ window: 32_000, usedTokens: 10_000, start: { s0: 4_000, samples: 1 } });
    expect(atMin.usable).toBe(true);
  });

  it("T-D1-FORCE-OFF: 有效 force 线为 0（两条线都关）⇒ 仍 usable 且 basis 永不为 force-gap", () => {
    // forceAtPercent=0 且 forceAtTokens=0 ⇒ effForce=0 ⇒ cap 省略 force 项（部分采纳）
    for (const rediscoveryUsd of [0.5, 1, 10, 60, 100]) {
      const outcome = compute({ force: { atPercent: 0, atTokensK: 0 }, config: { ...DEFAULT_CONFIG, rediscoveryUsd } });
      expect(outcome.usable).toBe(true);
      if (outcome.usable) {
        expect(outcome.basis).not.toBe("force-gap");
        expect(outcome.cap).toBeCloseTo(600_000, 6); // cap = min(60%W, W−reserve)，无 force 项
      }
    }
  });

  it("T-D1-FORCE-OFF: R2-9 — forceAtPercent=0 但 forceAtTokens=550（W=1M）⇒ cap 必须计入 force−迟滞项", () => {
    // effForce = effectiveThresholdPercentWithTokens(0, 550, 1M, reserve) = 55 ⇒ forceCap = 52%·W
    const effForce = effectiveThresholdPercentWithTokens(
      windowScaledForcePercent(0, 1_000_000),
      550,
      1_000_000,
      16_384,
    );
    expect(effForce).toBe(55);
    const outcome = compute({
      force: { atPercent: 0, atTokensK: 550 },
      config: { ...DEFAULT_CONFIG, rediscoveryUsd: 60 },
    });
    expect(outcome.usable).toBe(true);
    if (outcome.usable) {
      expect(outcome.cap).toBeCloseTo(520_000, 6); // (55 − 3)% · 1M
      expect(outcome.basis).toBe("force-gap"); // C* ≈ 796k > cap ⇒ argmin 命中 cap 且 cap 来自 force−迟滞
      expect(outcome.hintPercent).toBe(52);
    }
  });

  it("T-D1-TIER-CANDIDATE: GPT-5.6 sol 参数下 argmin 命中 272k − margin，basis=tier、nextTierTokens=272_000", () => {
    // K = H + R + Wnew = 0.04 + 13.15 + 37_200·5e-6 = 13.376 ⇒ C*(cheap) = 268_509（m=290，顶点 289.14）
    // 恰落在 B−margin=268_280（m=289）之后半档内 ⇒ 量化后的 argmin 由 B−margin 以更近的整数轮胜出。
    const outcome = computeDynamicThreshold(
      baseInput({
        window: 372_000,
        usedTokens: 200_000,
        price: SOL,
        growth: { g: 800, sigma: 0, samples: 9 },
        start: { s0: 37_200, samples: 1 },
        config: { ...DEFAULT_CONFIG, maxQualityPercent: 80, rediscoveryUsd: 13.15 },
      }),
    );
    expect(outcome.usable).toBe(true);
    if (!outcome.usable) return;
    expect(outcome.basis).toBe("tier");
    expect(outcome.nextTierTokens).toBe(272_000);
    expect(outcome.hintTokens).toBe(268_280); // 272_000 − max(2·800, 0.01·372_000)
    expect(outcome.hintPercent).toBe(72); // 与 §10.1 的标记示例 [hint 72% · tier 272k] 对齐
    const tokens = outcome.candidates.map((c) => c.tokens);
    expect(tokens).toContain(268_280);
    expect(tokens).toContain(272_000);
  });

  it("T-D1-FLOOR: 低 R ⇒ C* 低于地板 ⇒ argmin 命中 lowerBound，basis=floor", () => {
    const outcome = compute({ config: { ...DEFAULT_CONFIG, rediscoveryUsd: 1 } });
    expect(outcome.usable).toBe(true);
    if (outcome.usable) {
      expect(outcome.basis).toBe("floor");
      expect(outcome.hintTokens).toBeCloseTo(350_000, 6); // 35% · 1M
      expect(outcome.hintPercent).toBe(35);
    }
  });

  it("T-D1-QUALITY: 高 R ⇒ C* 超上限 ⇒ argmin 命中 cap，basis=quality-cap", () => {
    const outcome = compute({ config: { ...DEFAULT_CONFIG, rediscoveryUsd: 100 } });
    expect(outcome.usable).toBe(true);
    if (outcome.usable) {
      expect(outcome.basis).toBe("quality-cap");
      expect(outcome.hintTokens).toBeCloseTo(600_000, 6); // 60% · 1M
      expect(outcome.hintPercent).toBe(60);
    }
  });

  it("T-D1-RESERVE: reserve 大到 W−reserve < 质量上限 ⇒ cap 来自 reserve，basis=reserve-cap", () => {
    // 注：effForce 本身被 effectiveThresholdPercentWithTokens 的 reserve 钳位钳住，
    // 有效 force 线 > 0 时 force−迟滞恒低于 W−reserve；reserve-cap 只在 force 项被省略
    // （两条 force 线都关，§3.4 第 7 步部分采纳分支）时才可能成为绑定上限。
    const outcome = compute({
      reserveTokens: 500_000,
      force: { atPercent: 0, atTokensK: 0 },
      config: { ...DEFAULT_CONFIG, rediscoveryUsd: 100 },
    });
    expect(outcome.usable).toBe(true);
    if (outcome.usable) {
      expect(outcome.basis).toBe("reserve-cap");
      expect(outcome.hintTokens).toBeCloseTo(500_000, 6); // 1M − 500k
      expect(outcome.cap).toBeCloseTo(500_000, 6);
      expect(outcome.hintPercent).toBe(50);
    }
  });

  it("T-D1-DEADBAND: published=41、新解 42 ⇒ 仍 41；新解 44（差 2，非 <2）⇒ 44；epoch 变化 ⇒ 死区失效", () => {
    // K = 0.04 + 12.26 + 0.5 = 12.8 ⇒ C* = 100k + 320k = 420k ⇒ 新解恰为 42%
    const fresh = compute({ config: { ...DEFAULT_CONFIG, rediscoveryUsd: 12.26 } });
    expect(fresh.usable).toBe(true);
    if (fresh.usable) expect(fresh.hintPercent).toBe(42);

    const hold = compute({
      config: { ...DEFAULT_CONFIG, rediscoveryUsd: 12.26 },
      published: { percent: 41, epoch: 3 },
    });
    expect(hold.usable).toBe(true);
    if (hold.usable) {
      expect(hold.hintPercent).toBe(41); // |42 − 41| = 1 < 2 ⇒ 沿用
      expect(hold.hintTokens).toBeCloseTo(410_000, 6);
    }

    const boundaryNotHeld = compute({
      config: { ...DEFAULT_CONFIG, rediscoveryUsd: 12.26 },
      published: { percent: 44, epoch: 3 },
    });
    expect(boundaryNotHeld.usable).toBe(true);
    if (boundaryNotHeld.usable) expect(boundaryNotHeld.hintPercent).toBe(42); // |42−44| = 2 不满足 < 2

    const equalNotHeld = compute({
      config: { ...DEFAULT_CONFIG, rediscoveryUsd: 12.26 },
      published: { percent: 40, epoch: 3 },
    });
    if (equalNotHeld.usable) expect(equalNotHeld.hintPercent).toBe(42); // |42−40| = 2 ⇒ 死区严格小于

    const epochChanged = compute({
      config: { ...DEFAULT_CONFIG, rediscoveryUsd: 12.26 },
      published: { percent: 41, epoch: 2 },
    });
    if (epochChanged.usable) expect(epochChanged.hintPercent).toBe(42); // epoch 未对上 ⇒ 死区失效
  });

  it("T-D1-QUANTIZE: R2-5 — W=10M + minHint=0 + R=0 ⇒ 线被抬到 ceil(W/100)、percent >= 1、经 thresholdLineTokens 往返不塌成 0", () => {
    const outcome = compute({
      window: 10_000_000,
      usedTokens: 500_000,
      growth: { g: 800, sigma: 0, samples: 30 },
      start: { s0: 4_200, samples: 1 },
      config: { ...DEFAULT_CONFIG, minHintPercent: 0, rediscoveryUsd: 0 },
    });
    expect(outcome.usable).toBe(true);
    if (!outcome.usable) return;
    // 纯成本解 C* ≈ 26k（0.26%）会被 floor 换算成 0 ⇒ 抬到 ceil(W/100) = 100_000
    expect(outcome.hintTokens).toBe(100_000);
    expect(outcome.hintPercent).toBe(1);
    // 消费侧往返：tokens → unit-k → percent 不塌成 0（线不会被当作「未启用」）
    const lineTokens = thresholdLineTokens(0, outcome.hintTokens / 1000, 10_000_000);
    expect(lineTokens).toBe(100_000);
    expect(effectiveThresholdPercentWithTokens(0, outcome.hintTokens / 1000, 10_000_000, 16_384)).toBe(1);

    // 抬升后越过 cap ⇒ 老实退化（质量上限 0.9% < 1%）
    const exceedsCap = compute({
      window: 10_000_000,
      usedTokens: 500_000,
      growth: { g: 800, sigma: 0, samples: 30 },
      start: { s0: 4_200, samples: 1 },
      config: { ...DEFAULT_CONFIG, minHintPercent: 0, maxQualityPercent: 0.9, rediscoveryUsd: 0 },
    });
    expect(exceedsCap).toEqual({ usable: false, reason: "infeasible-range" });

    // W=1M 常规参数下该抬升不生效（lowerBound 350k ≫ ceil(W/100)=10k，不影响既有结果）
    const normal = compute({ config: { ...DEFAULT_CONFIG, rediscoveryUsd: 1 } });
    if (normal.usable) {
      expect(normal.hintTokens).toBeCloseTo(350_000, 6);
      expect(normal.hintPercent).toBe(35);
    }
  });

  it("T-D1-DEGRADE-PRICE: P1-8 — cacheRead 缺失/0/NaN + static ⇒ usable:false；+ quality ⇒ usable:true、basis=quality-cap、落在区间内", () => {
    for (const cacheRead of [0, Number.NaN, -0.2]) {
      const price = buildPriceModel({ input: 4, output: 20, cacheRead, cacheWrite: 5 }, []);
      expect(price.readKnown).toBe(false);
      const degraded = compute({ price });
      expect(degraded).toEqual({ usable: false, reason: "price-unknown" });

      const quality = compute({ price, config: { ...DEFAULT_CONFIG, unknownPriceMode: "quality" } });
      expect(quality.usable).toBe(true);
      if (quality.usable) {
        expect(quality.basis).toBe("quality-cap");
        expect(quality.hintTokens).toBeCloseTo(600_000, 6);
        expect(quality.hintTokens).toBeGreaterThanOrEqual(quality.lowerBound);
        expect(quality.hintTokens).toBeLessThanOrEqual(quality.cap);
        expect(quality.candidates).toEqual([]); // 未进成本模型
        expect(quality.cStarTokens).toBeUndefined();
      }
    }
  });

  it("T-D1-SUBSCRIPTION: resolveSubscriptionPressure — stale ⇒ null；窗口全过期 ⇒ null；未过期取最大；undefined resetAt 视为未过期", () => {
    const now = 1_000_000;
    expect(resolveSubscriptionPressure(undefined, now)).toBeNull();
    expect(resolveSubscriptionPressure({ stale: true, windows: [{ usedPct: 80 }] }, now)).toBeNull();
    expect(resolveSubscriptionPressure({ windows: [{ usedPct: 80, resetAtMs: now - 1 }] }, now)).toBeNull();
    expect(
      resolveSubscriptionPressure(
        {
          windows: [{ usedPct: 60, resetAtMs: now + 1_000 }, { usedPct: 90 }, { usedPct: 70, resetAtMs: now - 5 }],
        },
        now,
      ),
    ).toBe(90);
  });

  it("T-D1-SUBSCRIPTION: D6 前压曲线 — 75/85/95 三点取值正确、恒不低于地板、basis 与 pressure 正确", () => {
    // 曲线端点（token 空间）：qualityCap=600k，lowerBound=350k
    expect(subscriptionPressureLine(75, 600_000, 350_000)).toBe(600_000);
    expect(subscriptionPressureLine(85, 600_000, 350_000)).toBe(475_000); // 600k − 250k·10/20
    expect(subscriptionPressureLine(95, 600_000, 350_000)).toBe(350_000);

    const run = (usedPct: number | null): DynamicThresholdOutcome =>
      compute({ subscription: { active: true, usedPct } satisfies SubscriptionStateInput });

    const at75 = run(75);
    if (at75.usable) {
      expect(at75.basis).toBe("quality-cap"); // usedPct <= 75 不前压
      expect(at75.hintTokens).toBeCloseTo(600_000, 6);
      expect(at75.subscriptionPressure).toBe(75);
      expect(at75.hintPercent).toBe(60);
    }
    const at85 = run(85);
    if (at85.usable) {
      expect(at85.basis).toBe("quota");
      expect(at85.hintTokens).toBeCloseTo(475_000, 6);
      expect(at85.subscriptionPressure).toBe(85);
      expect(at85.hintPercent).toBe(47);
    }
    const at95 = run(95);
    if (at95.usable) {
      expect(at95.basis).toBe("quota");
      expect(at95.hintTokens).toBeCloseTo(350_000, 6);
      expect(at95.subscriptionPressure).toBe(95);
      expect(at95.hintPercent).toBe(35);
    }
    // verdict 缺失/stale/无未过期窗口（usedPct=null）⇒ 不前压
    const noPressure = run(null);
    if (noPressure.usable) {
      expect(noPressure.basis).toBe("quality-cap");
      expect(noPressure.hintTokens).toBeCloseTo(600_000, 6);
      expect(noPressure.subscriptionPressure).toBeUndefined();
    }
    // 全程恒不低于地板、恒不超过 cap
    for (let usedPct = 0; usedPct <= 100; usedPct += 5) {
      const outcome = run(usedPct);
      expect(outcome.usable).toBe(true);
      if (outcome.usable) {
        expect(outcome.hintTokens).toBeGreaterThanOrEqual(outcome.lowerBound - 1e-6);
        expect(outcome.hintTokens).toBeLessThanOrEqual(outcome.cap + 1e-6);
      }
    }
  });

  it("T-D1-WRITE-ZERO: cacheWrite=0 不退化；writePricingApproximate 恒 true（P1-1）", () => {
    const price = KIMI_NO_WRITE;
    expect(price.readKnown).toBe(true);
    expect(price.writeKnown).toBe(false);
    const outcome = compute({ price });
    expect(outcome.usable).toBe(true); // Wnew=0 ⇒ K 偏小 ⇒ C* 偏早 ⇒ 地板兜住，不退化
    if (outcome.usable) {
      expect(outcome.basis).toBe("floor");
      expect(outcome.writePricingApproximate).toBe(true);
    }
    // 写价缺失（NaN）同样不退化
    const missingWrite = buildPriceModel({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: Number.NaN }, []);
    expect(missingWrite.writeKnown).toBe(false);
    const stillUsable = compute({ price: missingWrite });
    expect(stillUsable.usable).toBe(true);
    if (stillUsable.usable) expect(stillUsable.writePricingApproximate).toBe(true);
  });

  it("§3.6 合成三行：percent 线、绝对线、绝对线超窗自动失效（动态层不得复活）", () => {
    const dynamic = compute(); // usable, hintTokens ≈ 385_626
    expect(dynamic.usable).toBe(true);
    if (!dynamic.usable) return;
    const dyn = dynamic.hintTokens;

    // percent=75, tokens=0 ⇒ min(750k, dyn)
    expect(staticHintActive({ percent: 75, tokensK: 0 }, 1_000_000, 16_384)).toBe(true);
    expect(
      composeHintLineTokens({
        staticLines: { percent: 75, tokensK: 0 },
        window: 1_000_000,
        reserveTokens: 16_384,
        mode: "on",
        dynamic,
      }),
    ).toBe(Math.min(750_000, dyn));

    // percent=0, tokens=500（绝对线 500k，低于窗口）⇒ min(500k, dyn)
    expect(staticHintActive({ percent: 0, tokensK: 500 }, 1_000_000, 16_384)).toBe(true);
    expect(
      composeHintLineTokens({
        staticLines: { percent: 0, tokensK: 500 },
        window: 1_000_000,
        reserveTokens: 16_384,
        mode: "on",
        dynamic,
      }),
    ).toBe(Math.min(500_000, dyn));

    // percent=0, tokens=2000（绝对线 2M > 窗口 1M ⇒ 自动失效）⇒ hint 关闭，动态不得复活
    expect(staticHintActive({ percent: 0, tokensK: 2_000 }, 1_000_000, 16_384)).toBe(false);
    expect(
      composeHintLineTokens({
        staticLines: { percent: 0, tokensK: 2_000 },
        window: 1_000_000,
        reserveTokens: 16_384,
        mode: "on",
        dynamic,
      }),
    ).toBe(0);

    // mode off/shadow ⇒ 静态线；动态退化（usable:false）⇒ 静态线（与现行行为逐字节一致）
    const staticTokens = 750_000;
    for (const mode of ["off", "shadow"] as const) {
      expect(
        composeHintLineTokens({
          staticLines: { percent: 75, tokensK: 0 },
          window: 1_000_000,
          reserveTokens: 16_384,
          mode,
          dynamic,
        }),
      ).toBe(staticTokens);
    }
    expect(
      composeHintLineTokens({
        staticLines: { percent: 75, tokensK: 0 },
        window: 1_000_000,
        reserveTokens: 16_384,
        mode: "on",
        dynamic: { usable: false, reason: "price-unknown" },
      }),
    ).toBe(staticTokens);
  });
});
