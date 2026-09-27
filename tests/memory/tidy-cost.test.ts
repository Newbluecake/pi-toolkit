import { describe, expect, it } from "vitest";
import { estimateTidyUsd, isPricedRates, tidyRatesFromModelCost } from "../../src/memory/tidy/cost.js";

describe("tidy cost estimation (§7.1)", () => {
  it("isPricedRates: input>0 or output>0 is priced; both zero is unpriced", () => {
    expect(isPricedRates({ input: 1, output: 0 })).toBe(true);
    expect(isPricedRates({ input: 0, output: 2 })).toBe(true);
    expect(isPricedRates({ input: 0, output: 0 })).toBe(false);
  });

  it("estimateTidyUsd applies the §7.1 formula", () => {
    const promptBytes = 10_000;
    const maxOutputBytes = 65_536;
    const rates = { input: 3, output: 15, cacheWrite: 3.75 };
    const inTok = Math.ceil(promptBytes / 2);
    const outTok = Math.ceil(Math.min(maxOutputBytes, 1.25 * promptBytes + 4096) / 2) + 2048;
    const expected = (inTok * Math.max(rates.input, rates.cacheWrite) + outTok * rates.output) / 1e6;
    expect(estimateTidyUsd({ promptBytes, maxOutputBytes, rates })).toBeCloseTo(expected, 10);
  });

  it("estimateTidyUsd uses cacheWrite when it exceeds input (write-price dominates)", () => {
    const a = estimateTidyUsd({
      promptBytes: 1000,
      maxOutputBytes: 1000,
      rates: { input: 1, output: 1, cacheWrite: 10 },
    });
    const b = estimateTidyUsd({ promptBytes: 1000, maxOutputBytes: 1000, rates: { input: 1, output: 1 } });
    expect(a).toBeGreaterThan(b);
  });

  it("estimateTidyUsd caps output tokens at maxOutputBytes/2 + thinking margin", () => {
    const rates = { input: 0, output: 10 };
    const small = estimateTidyUsd({ promptBytes: 100, maxOutputBytes: 100, rates });
    const large = estimateTidyUsd({ promptBytes: 100, maxOutputBytes: 1_000_000, rates });
    expect(large).toBeGreaterThan(small);
  });

  it("tidyRatesFromModelCost picks the highest tier whose threshold is exceeded", () => {
    const cost = {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      tiers: [
        { inputTokensAbove: 0, input: 3, output: 15, cacheWrite: 3.75 },
        { inputTokensAbove: 200_000, input: 6, output: 22.5, cacheWrite: 7.5 },
      ],
    };
    expect(tidyRatesFromModelCost(cost, 1000)).toEqual({ input: 3, output: 15, cacheWrite: 3.75 });
    expect(tidyRatesFromModelCost(cost, 300_000)).toEqual({ input: 6, output: 22.5, cacheWrite: 7.5 });
  });

  it("tidyRatesFromModelCost falls back to the base rate with no tiers", () => {
    const cost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 };
    expect(tidyRatesFromModelCost(cost, 999_999)).toEqual({ input: 1, output: 2, cacheWrite: 1.5 });
  });
});
