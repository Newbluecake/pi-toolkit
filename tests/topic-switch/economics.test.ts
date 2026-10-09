import { describe, expect, it } from "vitest";
import { calculateCost } from "@earendil-works/pi-ai";
import { BYTES_PER_TOKEN, IMAGE_TOKENS, estimateNextRequestUsd } from "../../src/topic-switch/economics.js";

/** pi-ai `ModelCost` 形状（base + tiers）。 */
function cost(
  base: { input: number; output: number; cacheRead: number; cacheWrite: number },
  tiers?: Array<{ inputTokensAbove: number } & Record<string, number>>,
) {
  return tiers === undefined ? { ...base } : { ...base, tiers };
}

const TEXT = "写一首关于秋天的七言绝句，要求押韵并且意境完整一点"; // 25 码点 × 3 bytes = 75 bytes ⇒ 25 tokens

function textTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);
}

describe("estimateNextRequestUsd · synthetic usage + formula", () => {
  const BASE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

  it("5m: prefix at cacheWrite price, new tokens at input price", () => {
    const est = estimateNextRequestUsd({
      prefixTokens: 200_000,
      newText: TEXT,
      imageCount: 0,
      cost: cost(BASE),
      writeTtl: "5m",
    });
    expect(est.kind).toBe("priced");
    if (est.kind !== "priced") return;
    expect(est).toMatchObject({ prefixTokens: 200_000, newTokens: textTokens(TEXT), writeTtl: "5m" });
    expect(est.usd).toBeCloseTo((BASE.cacheWrite * 200_000 + BASE.input * textTokens(TEXT)) / 1e6, 12);
  });

  it("1h: prefix at 2×input, new tokens at input", () => {
    const est = estimateNextRequestUsd({
      prefixTokens: 100_000,
      newText: "",
      imageCount: 1,
      cost: cost(BASE),
      writeTtl: "1h",
    });
    expect(est.kind).toBe("priced");
    if (est.kind !== "priced") return;
    const n = 0 + IMAGE_TOKENS;
    expect(est).toMatchObject({ prefixTokens: 100_000, newTokens: n, writeTtl: "1h" });
    expect(est.usd).toBeCloseTo((BASE.input * n + BASE.input * 2 * 100_000) / 1e6, 12);
  });

  it("none: whole prefix at plain input price", () => {
    const est = estimateNextRequestUsd({
      prefixTokens: 50_000,
      newText: "hi",
      imageCount: 0,
      cost: cost(BASE),
      writeTtl: "none",
    });
    expect(est.kind).toBe("priced");
    if (est.kind !== "priced") return;
    const n = textTokens("hi");
    expect(est).toMatchObject({ prefixTokens: 50_000, newTokens: n, writeTtl: "none" });
    expect(est.usd).toBeCloseTo((BASE.input * (50_000 + n)) / 1e6, 12);
  });

  it("images add 1600 tokens each; ceil on utf8 bytes/3", () => {
    const oneByte = "a".repeat(4); // 4 bytes ⇒ ceil(4/3) = 2
    expect(
      estimateNextRequestUsd({ prefixTokens: 1000, newText: oneByte, imageCount: 2, cost: cost(BASE), writeTtl: "5m" })
        .newTokens ?? -1,
    ).toBe(2 + 2 * IMAGE_TOKENS);
    const fourByte = "😀"; // 4 bytes ⇒ 2 tokens (code point = 1, bytes = 4)
    expect(
      estimateNextRequestUsd({ prefixTokens: 1000, newText: fourByte, imageCount: 0, cost: cost(BASE), writeTtl: "5m" })
        .newTokens ?? -1,
    ).toBe(2);
  });
});

describe("estimateNextRequestUsd · tiers (pi-ai parity)", () => {
  const BASE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  const DISCOUNT = { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.875 };

  it("tier applies when inputTokens (P+N) strictly exceeds the threshold — whole group replaces base", () => {
    const tiers = [{ inputTokensAbove: 100_000, ...DISCOUNT }];
    // P = 100_000 − N − 1 keeps P+N = 99_999 ≤ threshold ⇒ base rates.
    const nUnder = textTokens(TEXT);
    const under = estimateNextRequestUsd({
      prefixTokens: 100_000 - nUnder - 1,
      newText: TEXT,
      imageCount: 0,
      cost: cost(BASE, tiers),
      writeTtl: "5m",
    });
    expect(under.kind === "priced" ? under.usd : NaN).toBeCloseTo(
      (BASE.cacheWrite * (100_000 - nUnder - 1) + BASE.input * nUnder) / 1e6,
      12,
    );
    // P+N = threshold exactly ⇒ still base (strict >).
    const atEdge = estimateNextRequestUsd({
      prefixTokens: 100_000 - nUnder,
      newText: TEXT,
      imageCount: 0,
      cost: cost(BASE, tiers),
      writeTtl: "5m",
    });
    expect(atEdge.kind === "priced" ? atEdge.usd : NaN).toBeCloseTo(
      (BASE.cacheWrite * (100_000 - nUnder) + BASE.input * nUnder) / 1e6,
      12,
    );
    // P+N = threshold + 1 ⇒ discounted tier.
    const over = estimateNextRequestUsd({
      prefixTokens: 100_000 - nUnder + 1,
      newText: TEXT,
      imageCount: 0,
      cost: cost(BASE, tiers),
      writeTtl: "5m",
    });
    expect(over.kind === "priced" ? over.usd : NaN).toBeCloseTo(
      (DISCOUNT.cacheWrite * (100_000 - nUnder + 1) + DISCOUNT.input * nUnder) / 1e6,
      12,
    );
  });

  it("highest matching threshold wins even if listed out of order", () => {
    const tiers = [
      { inputTokensAbove: 200_000, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      { inputTokensAbove: 50_000, ...DISCOUNT },
    ];
    const est = estimateNextRequestUsd({
      prefixTokens: 300_000,
      newText: "",
      imageCount: 0,
      cost: cost(BASE, tiers),
      writeTtl: "5m",
    });
    expect(est.kind === "priced" ? est.usd : NaN).toBeCloseTo((1.25 * 300_000) / 1e6, 12); // 5m: prefix at the winning tier's cacheWrite
  });
});

describe("estimateNextRequestUsd · cross-check against REAL calculateCost", () => {
  type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };
  const scenarios: Array<{
    label: string;
    base: Rates;
    tiers?: Array<{ inputTokensAbove: number } & Rates>;
    P: number;
    N: number;
    ttl: "5m" | "1h" | "none";
  }> = [];

  const ratesList: Rates[] = [
    { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  ];
  const pnList = [1_000, 60_000, 129_999, 200_000];
  const ttlList = ["5m", "1h", "none"] as const;

  for (const base of ratesList) {
    for (const P of pnList) {
      for (const ttl of ttlList) {
        scenarios.push({ label: `flat P=${P} ${ttl}`, base, P, N: 37, ttl });
        scenarios.push({
          label: `tiered P=${P} ${ttl}`,
          base,
          tiers: [
            {
              inputTokensAbove: 100_000,
              input: base.input / 2,
              output: base.output / 2,
              cacheRead: base.cacheRead / 2,
              cacheWrite: base.cacheWrite / 2,
            },
          ],
          P,
          N: 37,
          ttl,
        });
      }
    }
  }

  it("estimate.usd === calculateCost(usage).total for every synthetic usage (≤1e-12)", () => {
    for (const s of scenarios) {
      const est = estimateNextRequestUsd({
        prefixTokens: s.P,
        newText: "x".repeat(s.N * 3), // exactly N tokens (N*3 bytes, N divisible-friendly)
        imageCount: 0,
        cost: s.tiers === undefined ? cost(s.base) : cost(s.base, s.tiers),
        writeTtl: s.ttl,
      });
      expect(est.kind).toBe("priced");
      if (est.kind !== "priced") continue;

      const input = s.ttl === "none" ? s.P + s.N : s.N;
      const cacheWrite = s.ttl === "none" ? 0 : s.P;
      const cacheWrite1h = s.ttl === "1h" ? s.P : 0;
      const usage = { input, output: 0, cacheRead: 0, cacheWrite, cacheWrite1h, cost: {} } as unknown as Parameters<
        typeof calculateCost
      >[1];
      const model = { cost: s.tiers === undefined ? cost(s.base) : cost(s.base, s.tiers) } as unknown as Parameters<
        typeof calculateCost
      >[0];
      const real = calculateCost(model, usage);
      expect(Math.abs(real.total - est.usd)).toBeLessThanOrEqual(1e-12);
      expect(est.newTokens).toBe(s.N);
    }
  });
});

describe("estimateNextRequestUsd · degraded inputs", () => {
  const BASE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

  it("P null/undefined/0/NaN/∞/负数 ⇒ unknown/no-usage (刚压缩 ⇒ 不问)", () => {
    for (const P of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        estimateNextRequestUsd({ prefixTokens: P, newText: "x", imageCount: 0, cost: cost(BASE), writeTtl: "5m" }),
      ).toEqual({
        kind: "unknown",
        reason: "no-usage",
      });
    }
  });

  it("cost non-object ⇒ unpriced/no-cost", () => {
    for (const c of [undefined, null, 42, "free", true]) {
      expect(
        estimateNextRequestUsd({ prefixTokens: 1000, newText: "x", imageCount: 0, cost: c, writeTtl: "5m" }),
      ).toEqual({
        kind: "unpriced",
        reason: "no-cost",
      });
    }
  });

  it("missing / NaN / negative used rates ⇒ unpriced/rate-invalid", () => {
    // input always needed
    expect(
      estimateNextRequestUsd({ prefixTokens: 1000, newText: "x", imageCount: 0, cost: {}, writeTtl: "none" }),
    ).toEqual({
      kind: "unpriced",
      reason: "rate-invalid",
    });
    expect(
      estimateNextRequestUsd({
        prefixTokens: 1000,
        newText: "x",
        imageCount: 0,
        cost: { input: Number.NaN, cacheWrite: 1 },
        writeTtl: "none",
      }),
    ).toEqual({ kind: "unpriced", reason: "rate-invalid" });
    // 5m additionally needs cacheWrite
    expect(
      estimateNextRequestUsd({ prefixTokens: 1000, newText: "x", imageCount: 0, cost: { input: 3 }, writeTtl: "5m" }),
    ).toEqual({
      kind: "unpriced",
      reason: "rate-invalid",
    });
    expect(
      estimateNextRequestUsd({
        prefixTokens: 1000,
        newText: "x",
        imageCount: 0,
        cost: { input: 3, cacheWrite: -0.1 },
        writeTtl: "5m",
      }),
    ).toEqual({ kind: "unpriced", reason: "rate-invalid" });
  });

  it("zero rates price at $0 (kept exact: both terms are 0)", () => {
    const est = estimateNextRequestUsd({
      prefixTokens: 1000,
      newText: "x",
      imageCount: 0,
      cost: { input: 0, output: 0, cacheRead: 0 },
      writeTtl: "1h",
    });
    expect(est).toEqual({ kind: "priced", usd: 0, prefixTokens: 1000, newTokens: textTokens("x"), writeTtl: "1h" });
  });

  it("non-array tiers are ignored (defensive; pi-ai would throw)", () => {
    const est = estimateNextRequestUsd({
      prefixTokens: 1000,
      newText: "x",
      imageCount: 0,
      cost: { ...BASE, tiers: 42 },
      writeTtl: "5m",
    });
    expect(est.kind).toBe("priced");
  });
});
