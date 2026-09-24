import { describe, expect, it } from "vitest";
import {
  advanceModelFingerprint,
  createEstimatorState,
  decayEstimator,
  growthEstimate,
  handoffEstimate,
  modelFingerprint,
  noteCompactBoundary,
  observeGrowth,
  observeHandoff,
  observeRestart,
  parseEstimatorState,
  serializeEstimatorState,
  startEstimate,
  type EstimatorState,
} from "../../../src/compact-hint/dynamic/estimator.js";
import { G_PRIOR, HANDOFF_PRIOR_TOKENS, s0PriorTokens } from "../../../src/compact-hint/dynamic/threshold.js";

const WINDOW = 1_000_000;

function stateWith(over: Partial<EstimatorState> = {}): EstimatorState {
  return { ...createEstimatorState(), ...over };
}

describe("dynamic estimator §4 (D1)", () => {
  it("T-D1-EWMA: P2-2 — 负 Δ 丢弃（不入 EWMA，基准前移），超大 Δ 截断到 0.25·W", () => {
    const base = stateWith({ lastTokens: 10_000, gMean: 800, gVar: 0, gSamples: 0 });

    // 负 Δ：EWMA 分毫不动，lastTokens 前移（Δ 口径保持「每轮增量」）
    const afterDrop = observeGrowth(base, 9_000, WINDOW);
    expect(afterDrop.gMean).toBe(800);
    expect(afterDrop.gVar).toBe(0);
    expect(afterDrop.gSamples).toBe(0);
    expect(afterDrop.lastTokens).toBe(9_000);

    // 零 Δ 同样丢弃
    const afterZero = observeGrowth(afterDrop, 9_000, WINDOW);
    expect(afterZero.gSamples).toBe(0);

    // 超大 Δ：截断到 0.25·W 后入 EWMA（Δ=40k → 25k）
    const truncated = observeGrowth(
      stateWith({ lastTokens: 10_000, gMean: 800, gVar: 0, gSamples: 0 }),
      50_000,
      100_000,
    );
    expect(truncated.gMean).toBeCloseTo(800 + 0.2 * (25_000 - 800), 9);
    expect(truncated.gSamples).toBe(1);
    expect(truncated.lastTokens).toBe(50_000);
  });

  it("T-D1-EWMA: 压缩边界后首个 Δ 丢弃（noteCompactBoundary 置 undefined ⇒ 下一次只立基准）", () => {
    let state = stateWith({ lastTokens: 500_000, gMean: 800, gSamples: 40 });
    state = noteCompactBoundary(state);
    expect(state.lastTokens).toBeUndefined();
    // 压缩后第一个观测只记录基准，不入 EWMA
    const first = observeGrowth(state, 90_000, WINDOW);
    expect(first.gSamples).toBe(40);
    expect(first.gMean).toBe(800);
    expect(first.lastTokens).toBe(90_000);
    // 第二个观测正常入 EWMA
    const second = observeGrowth(first, 91_200, WINDOW);
    expect(second.gSamples).toBe(41);
    expect(second.gMean).toBeGreaterThan(800);
  });

  it("T-D1-EWMA: 热身混合 — gSamples < 8 时按 G_PRIOR 加权；s0Samples === 0 时用 S0 先验", () => {
    const mixed = growthEstimate(stateWith({ gMean: 1_000, gVar: 0, gSamples: 3 }));
    expect(mixed.g).toBeCloseTo((3 * 1_000 + 5 * G_PRIOR) / 8, 9); // (3000 + 4000) / 8 = 875
    expect(mixed.samples).toBe(3);
    // 样本足量后直接用 EWMA 均值
    const warm = growthEstimate(stateWith({ gMean: 1_000, gVar: 0, gSamples: 8 }));
    expect(warm.g).toBe(1_000);

    const priorS0 = startEstimate(stateWith({ s0Mean: 0, s0Samples: 0 }), WINDOW);
    expect(priorS0.s0).toBe(s0PriorTokens(WINDOW)); // min(0.1·1M, 100k) = 100k
    const observedS0 = startEstimate(stateWith({ s0Mean: 88_000, s0Samples: 2 }), WINDOW);
    expect(observedS0.s0).toBe(88_000);

    expect(handoffEstimate(stateWith({ handoffSamples: 0 })).tokens).toBe(HANDOFF_PRIOR_TOKENS);
    expect(handoffEstimate(stateWith({ handoffMean: 5_500, handoffSamples: 2 })).tokens).toBe(5_500);
  });

  it("T-D1-EWMA: 方差用旧均值（对拍手算值）", () => {
    // 观测 x = Δ = 200（增长量）；公式 delta = x − mean_old = 200 − 100 = 100（基于旧均值）：
    // mean_new = 100 + 0.2·100 = 120；var_new = 0.8·(0 + 0.2·100²) = 1600；sigma = 40
    const state = stateWith({ gMean: 100, gVar: 0, gSamples: 3, lastTokens: 1_000 });
    const updated = observeGrowth(state, 1_200, WINDOW);
    expect(updated.gMean).toBeCloseTo(120, 9);
    expect(updated.gVar).toBeCloseTo(1_600, 6);
    expect(growthEstimate(updated).sigma).toBeCloseTo(40, 6);
    expect(updated.gSamples).toBe(4);
  });

  it("T-D1-EWMA: 返回新对象（原对象未被改动）；非法入参原样返回", () => {
    const snapshot = JSON.stringify({
      gMean: 900,
      gVar: 100,
      gSamples: 7,
      s0Mean: 80_000,
      s0Samples: 3,
      handoffMean: 3_000,
      handoffSamples: 2,
      lastTokens: 250_000,
      modelEpoch: 4,
      modelFingerprint: "a|b",
      version: 2,
    } satisfies EstimatorState);
    const state = JSON.parse(snapshot) as EstimatorState;
    observeGrowth(state, 300_000, WINDOW);
    observeRestart(state, 90_000);
    observeHandoff(state, 4_000);
    noteCompactBoundary(state);
    decayEstimator(state, "x|y", WINDOW);
    expect(JSON.stringify(state)).toBe(snapshot);

    expect(observeGrowth(state, Number.NaN, WINDOW)).toBe(state);
    expect(observeRestart(state, -1)).toBe(state);
    expect(observeHandoff(state, Number.POSITIVE_INFINITY)).toBe(state);
  });

  it("T-D1-EWMA: 样本减半用 floor（decayEstimator：gSamples/handoffSamples 减半，S0 清空回先验，epoch+1）", () => {
    const state = stateWith({
      gMean: 1_100,
      gVar: 5_000,
      gSamples: 5,
      s0Mean: 90_000,
      s0Samples: 4,
      handoffMean: 4_000,
      handoffSamples: 1,
      modelEpoch: 6,
      modelFingerprint: "old",
    });
    const decayed = decayEstimator(state, "new", WINDOW);
    expect(decayed.modelEpoch).toBe(7);
    expect(decayed.modelFingerprint).toBe("new");
    expect(decayed.gSamples).toBe(2); // floor(5/2)
    expect(decayed.gMean).toBe(1_100); // 值保留（σ 随 gVar 保留）
    expect(decayed.gVar).toBe(5_000);
    expect(decayed.s0Samples).toBe(0); // S0 清空
    expect(decayed.s0Mean).toBe(s0PriorTokens(WINDOW));
    expect(decayed.handoffSamples).toBe(0); // floor(1/2)
    expect(decayed.handoffMean).toBe(4_000); // 值保留
  });

  it("T-D1-EWMA: 序列化往返（含 lastTokens=undefined）；脏数据回读不抛、逐字段回先验", () => {
    const withLast = stateWith({
      gMean: 950,
      gVar: 1_000,
      gSamples: 12,
      lastTokens: 424_242,
      modelEpoch: 9,
      modelFingerprint: "p|i",
    });
    expect(parseEstimatorState(JSON.parse(serializeEstimatorState(withLast)), WINDOW)).toEqual(withLast);
    const noLast = stateWith({ gMean: 950, gVar: 1_000, gSamples: 12 });
    expect(parseEstimatorState(JSON.parse(serializeEstimatorState(noLast)), WINDOW)).toEqual(noLast);

    // 非对象 / version !== 2 ⇒ 全新状态
    expect(parseEstimatorState(undefined, WINDOW)).toEqual(createEstimatorState());
    expect(parseEstimatorState(null, WINDOW)).toEqual(createEstimatorState());
    expect(parseEstimatorState(42, WINDOW)).toEqual(createEstimatorState());
    expect(parseEstimatorState({ version: 1, gMean: 1 }, WINDOW)).toEqual(createEstimatorState());

    // 逐字段校验：非有限/负数 ⇒ 取先验；mean 失效时对应 samples 归 0
    const dirty = parseEstimatorState(
      {
        version: 2,
        gMean: Number.NaN,
        gSamples: 3,
        gVar: -7,
        s0Mean: -100,
        s0Samples: 2,
        handoffMean: Number.POSITIVE_INFINITY,
        handoffSamples: 5,
        lastTokens: -1,
        modelEpoch: -3,
        modelFingerprint: 99,
      },
      WINDOW,
    );
    expect(dirty.gMean).toBe(G_PRIOR);
    expect(dirty.gSamples).toBe(0);
    expect(dirty.gVar).toBe(0);
    expect(dirty.s0Mean).toBe(s0PriorTokens(WINDOW));
    expect(dirty.s0Samples).toBe(0);
    expect(dirty.handoffMean).toBe(HANDOFF_PRIOR_TOKENS);
    expect(dirty.handoffSamples).toBe(0);
    expect(dirty.lastTokens).toBeUndefined();
    expect(dirty.modelEpoch).toBe(0);
    expect(dirty.version).toBe(2);
  });

  it("T-D1-EPOCH: P1-7 — 指纹任一字段变化都翻 epoch（advanceModelFingerprint），同指纹原样返回", () => {
    const base = {
      provider: "anthropic",
      id: "claude-opus-5-5",
      api: "anthropic",
      baseUrl: "https://api.example.com",
      contextWindow: 1_000_000,
      rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      tiers: [{ inputTokensAbove: 272_000, cacheRead: 0.4 }],
    } as const;
    const fp = modelFingerprint(base);
    const state = stateWith({ gSamples: 10, s0Samples: 3, handoffSamples: 4, modelEpoch: 5, modelFingerprint: fp });

    // 同指纹 ⇒ 原样返回（不翻 epoch）
    expect(advanceModelFingerprint(state, fp, WINDOW)).toBe(state);

    // 任一字段变化 ⇒ 翻 epoch
    const variants = [
      { ...base, provider: "openai" },
      { ...base, id: "gpt-5.6-sol" },
      { ...base, api: "openai" },
      { ...base, baseUrl: "https://gw.example.com" },
      { ...base, contextWindow: 372_000 },
      { ...base, rates: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 } },
      { ...base, tiers: [{ inputTokensAbove: 272_000, cacheRead: 0.8 }] },
      { ...base, tiers: undefined },
      { ...base, rates: undefined },
    ];
    for (const variant of variants) {
      expect(modelFingerprint(variant)).not.toBe(fp);
      const flipped = advanceModelFingerprint(state, modelFingerprint(variant), WINDOW);
      expect(flipped.modelEpoch).toBe(6); // 每次从同一基态翻转 ⇒ 5 + 1
    }

    // 读不到的字段记 "unknown"
    expect(modelFingerprint({ ...base, provider: undefined, id: "" })).toContain("unknown|unknown|");
  });

  it("T-D1-EPOCH: 翻转后 published 清空归 wire 层（estimator 侧钉死 s0Samples=0、gSamples 减半、指纹替换）", () => {
    // published 不在 EstimatorState 内（§2.2/§4.3：清空发生在 wire 的 DynamicRuntime），
    // 这里锁定 estimator 侧的处置不被误改。
    const state = stateWith({ modelEpoch: 1, modelFingerprint: "a", gSamples: 8, s0Samples: 2 });
    const flipped = advanceModelFingerprint(state, "b", WINDOW);
    expect(flipped.modelEpoch).toBe(2);
    expect(flipped.gSamples).toBe(4);
    expect(flipped.s0Samples).toBe(0);
    expect(flipped.modelFingerprint).toBe("b");
  });
});
