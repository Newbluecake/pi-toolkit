import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  computeWindowCap,
  pickRateTier,
  realRequestInputTokens,
  FALLBACK_WINDOW_CAP,
  WINDOW_CAP_CEILING,
  type KeepaliveCostModel,
} from "../../src/cache-ttl/keepalive-state.js";

const cap = (w: number, r = 1) => computeWindowCap({ cacheRead: r, cacheWrite: w });

describe("dynamic window cap — prefix budget only", () => {
  it.each([
    [3.75, 0.3, 11],
    [6.25, 0.5, 11],
    [25, 2, 11],
    [1.25, 0.1, 11],
    [1.25, 0.025, 48],
    [2, 1, 0],
    [2.000000001, 1, 1],
    [12 - Number.EPSILON * 8, 1, 10],
    [12 + Number.EPSILON * 8, 1, 10],
    [12 - 1e-12, 1, 10],
    [12 + 1e-12, 1, 11],
    [1 + Number.EPSILON, 1, 0],
    [2 - Number.EPSILON, 1, 0],
    [2 + Number.EPSILON * 2, 1, 0],
    [98, 1, 96],
  ])("W=%s R=%s => %s priced", (w, r, n) => {
    expect(cap(w, r)).toEqual({ cap: n, source: "priced" });
  });

  it("integer equality is not profitable (all caps 0..96)", () => {
    for (let n = 0; n <= 96; n++) expect(cap(n + 2)).toEqual({ cap: n, source: "priced" });
  });

  it.each([99, 100, 2002, 2 ** 54, Number.MAX_VALUE])("clamps W/R=%s only AFTER finite checks", (w) => {
    const result = cap(w);
    expect(result).toMatchObject({ cap: 96, source: "clamped" });
    expect(result.rawCap).toBeGreaterThan(96);
  });

  it.each([
    [undefined, "unpriced"],
    [{ cacheRead: 0, cacheWrite: 3 }, "no-read"],
    [{ cacheWrite: 3 }, "no-read"],
    [{ cacheRead: 1 }, "no-write"],
    [{ cacheRead: 1, cacheWrite: 0 }, "no-write"],
    [{ cacheRead: 1, cacheWrite: 1 }, "write-le-read"],
    [{ cacheRead: 1, cacheWrite: 1 - Number.EPSILON }, "write-le-read"],
    [{ cacheRead: 1, cacheWrite: 0.5 }, "write-le-read"],
    [{ cacheRead: Number.MIN_VALUE, cacheWrite: 1 }, "non-finite"],
    ...[NaN, Infinity, -1, "1"].flatMap((value) => [
      [{ cacheRead: value, cacheWrite: 3 }, "no-read"],
      [{ cacheRead: 1, cacheWrite: value }, "no-write"],
    ]),
  ])("invalid prices %j => fallback (%s)", (cost, reason) => {
    expect(computeWindowCap(cost as KeepaliveCostModel | undefined)).toEqual({
      cap: FALLBACK_WINDOW_CAP,
      source: "fallback",
      reason,
    });
  });

  it("property: priced is the maximal profitable integer; clamped is a bounded prefix budget", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.000001, max: 1_000_000, noNaN: true }),
        fc.double({ min: 1.000001, max: 10000, noNaN: true }),
        (r, q) => {
          const w = q * r;
          const result = cap(w, r);
          expect(Number.isInteger(result.cap)).toBe(true);
          expect(result.cap).toBeGreaterThanOrEqual(0);
          expect(result.cap).toBeLessThanOrEqual(WINDOW_CAP_CEILING);
          const tolerance = 8 * Number.EPSILON * Math.max(w, (result.cap + 2) * r);
          if (result.source === "priced") {
            // Integer-neighbourhood equality uses the plan's 4-ULP convention.
            expect((result.cap + 1) * r).toBeLessThan(w + tolerance);
            expect(w).toBeLessThanOrEqual((result.cap + 2) * r + tolerance);
          } else if (result.source === "clamped") {
            expect(result.cap).toBe(96);
            expect(result.rawCap).toBeGreaterThan(96);
            expect((result.cap + 1) * r).toBeLessThan(w + tolerance);
          } else {
            expect(result.cap).toBe(11);
            expect(result.reason).toBeTypeOf("string");
          }
        },
      ),
      { seed: 20261018, numRuns: 2000 },
    );
  });
});

describe("whole-tier selection from the window-opening REAL response's full input", () => {
  const cost = {
    cacheRead: 0.3,
    cacheWrite: 3.75,
    tiers: [
      { inputTokensAbove: 40_000, cacheRead: 0.025, cacheWrite: 1.25 },
      { inputTokensAbove: 100_000, cacheRead: 1, cacheWrite: 3 },
    ],
  };
  it.each([
    [39_999, 11],
    [40_000, 11],
    [40_001, 48],
    [100_000, 48],
    [100_001, 1],
  ])("strict threshold with total %s => %s", (total, n) => {
    expect(computeWindowCap(cost, total)).toEqual({ cap: n, source: "priced" });
  });
  it("uncached input >8192 can cross one OR multiple tiers; never use prefix lower bound", () => {
    for (const [input, expected] of [
      [25_000, 48],
      [150_000, 1],
    ]) {
      const total = realRequestInputTokens({ role: "assistant", usage: { input, cacheRead: 30_000, cacheWrite: 0 } });
      expect(computeWindowCap(cost, total)).toEqual({ cap: expected, source: "priced" });
    }
    expect(pickRateTier(cost, 40_000)).toBe(cost);
    expect(pickRateTier(cost, 40_001)).toBe(cost.tiers[0]);
    // Rate selection is by threshold, not declaration order.
    expect(computeWindowCap({ ...cost, tiers: [...cost.tiers].reverse() }, 200_000).cap).toBe(1);
  });
  it.each([
    { cacheRead: 1 },
    { cacheWrite: 3 },
    { cacheRead: NaN, cacheWrite: 3 },
    { cacheRead: 1, cacheWrite: Infinity },
  ])("incomplete tier %j never borrows a base rate", (rates) => {
    expect(computeWindowCap({ ...cost, tiers: [{ inputTokensAbove: 1, ...rates }] }, 2)).toEqual({
      cap: 11,
      source: "fallback",
      reason: "tier-incomplete",
    });
  });
  it.each([undefined, NaN, Infinity, -1])("tiered model without reliable full usage (%s) is uncertain", (total) => {
    expect(computeWindowCap(cost, total)).toEqual({ cap: 11, source: "fallback", reason: "tier-uncertain" });
  });
  it("no tiers / empty tiers needs no usage; a known total 0 selects the base tier", () => {
    expect(computeWindowCap({ cacheRead: 0.3, cacheWrite: 3.75 })).toEqual({ cap: 11, source: "priced" });
    expect(computeWindowCap({ cacheRead: 0.3, cacheWrite: 3.75, tiers: [] })).toEqual({ cap: 11, source: "priced" });
    expect(computeWindowCap(cost, 0)).toEqual({ cap: 11, source: "priced" });
  });
  it.each([
    undefined,
    { role: "user", usage: { input: 1, cacheRead: 2, cacheWrite: 3 } },
    { role: "assistant", usage: { cacheRead: 30_000, cacheWrite: 0 } },
    ...[NaN, Infinity, -1, "1"].map((input) => ({ role: "assistant", usage: { input, cacheRead: 1, cacheWrite: 1 } })),
    { role: "assistant", usage: { input: Number.MAX_VALUE, cacheRead: Number.MAX_VALUE, cacheWrite: 0 } },
    { role: "assistant", stopReason: "error", usage: { input: 1, cacheRead: 1, cacheWrite: 1 } },
  ])("rejects missing/invalid/error response usage %j", (message) => {
    expect(realRequestInputTokens(message)).toBeUndefined();
  });
});
