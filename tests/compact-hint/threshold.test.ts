import { describe, expect, it } from "vitest";
import {
  buildCompactForceText,
  buildCompactHintText,
  buildUsageTickText,
  effectiveThresholdPercent,
  effectiveThresholdPercentWithTokens,
  maxThresholdPercent,
  thresholdLineTokens,
  tokenLineExceedsWindow,
  usageTickStep,
} from "../../src/compact-hint/threshold.js";

describe("compact hint thresholds", () => {
  it("matches the exact reserve matrix", () => {
    for (const [window, expected] of [
      [32000, 48],
      [32768, 50],
      [64000, 74],
      [65536, 75],
      [128000, 87],
      [131072, 87],
      [200000, 91],
      [262144, 93],
    ] as const)
      expect(maxThresholdPercent(window, 16384)).toBe(expected);
  });
  it("handles reserve overrides and invalid windows", () => {
    expect(maxThresholdPercent(128000, 32768)).toBe(74);
    expect(maxThresholdPercent(200000, 32768)).toBe(83);
    expect(maxThresholdPercent(262144, 32768)).toBe(87);
    expect(maxThresholdPercent(0, 1)).toBe(0);
    expect(maxThresholdPercent(Number.NaN, 1)).toBe(0);
    expect(effectiveThresholdPercent(0, 100000, 1)).toBe(0);
    expect(effectiveThresholdPercent(60, 100000, 1)).toBe(60);
  });

  it("combines percent and absolute token lines with min semantics", () => {
    // 1M window, default-style config: min(75% × 1M, 400k) → 400k → 40%.
    expect(effectiveThresholdPercentWithTokens(75, 400, 1_000_000, 16384)).toBe(40);
    // Percent line stricter: min(30% × 1M = 300k, 400k) → 300k → 30%.
    expect(effectiveThresholdPercentWithTokens(30, 400, 1_000_000, 16384)).toBe(30);
    // Absolute line stricter on a 200k window: min(75% × 200k, 100k) → 50%.
    expect(effectiveThresholdPercentWithTokens(75, 100, 200_000, 16384)).toBe(50);
    // Tokens-only (percent disabled): 100k on 200k → 50%.
    expect(effectiveThresholdPercentWithTokens(0, 100, 200_000, 16384)).toBe(50);
    // Both disabled → 0.
    expect(effectiveThresholdPercentWithTokens(0, 0, 200_000, 16384)).toBe(0);
  });

  it("is bit-identical to the percent-only path when tokens are 0 or auto-disabled", () => {
    for (const [percent, window, reserve] of [
      [75, 200_000, 16384],
      [87, 131_072, 16384],
      [95, 32_000, 16384],
      [88, 262_144, 32768],
      [0, 200_000, 16384],
    ] as const) {
      expect(effectiveThresholdPercentWithTokens(percent, 0, window, reserve)).toBe(
        effectiveThresholdPercent(percent, window, reserve),
      );
      // 400k > window → absolute line auto-disables → same as percent-only.
      expect(effectiveThresholdPercentWithTokens(percent, 400, window, reserve)).toBe(
        effectiveThresholdPercent(percent, window, reserve),
      );
    }
  });

  it("auto-disables the absolute line only when it strictly exceeds the window", () => {
    expect(tokenLineExceedsWindow(400, 256_000)).toBe(true);
    expect(tokenLineExceedsWindow(400, 372_000)).toBe(true);
    expect(tokenLineExceedsWindow(400, 400_000)).toBe(false); // equal → still active
    expect(tokenLineExceedsWindow(400, 1_000_000)).toBe(false);
    // 256k/372k-class windows: 400k default drops out, behavior unchanged.
    expect(effectiveThresholdPercentWithTokens(75, 400, 256_000, 16384)).toBe(75);
    // percent=0 with an auto-disabled absolute line → no threshold at all.
    expect(effectiveThresholdPercentWithTokens(0, 400, 256_000, 16384)).toBe(0);
    // Line ≤ window but > (window − reserve): clamped by the reserve cap, not
    // disabled — 380k on a 400k window with 16k reserve → cap 96%.
    expect(effectiveThresholdPercentWithTokens(0, 380, 400_000, 16_384)).toBe(maxThresholdPercent(400_000, 16_384));
  });

  it("computes combined absolute trigger lines for cross-validation", () => {
    expect(thresholdLineTokens(75, 0, 200_000)).toBe(150_000);
    expect(thresholdLineTokens(0, 100, 200_000)).toBe(100_000);
    expect(thresholdLineTokens(0, 300, 200_000)).toBe(0); // 300k exceeds the 200k window
    expect(thresholdLineTokens(75, 100, 200_000)).toBe(100_000); // min wins
    expect(thresholdLineTokens(0, 400, 256_000)).toBe(0); // auto-disabled
    expect(thresholdLineTokens(75, 400, 256_000)).toBe(192_000); // percent only
    expect(thresholdLineTokens(0, 0, 200_000)).toBe(0);
    expect(thresholdLineTokens(75, 0, undefined)).toBe(0); // no window → no percent line
    expect(thresholdLineTokens(0, 300, undefined)).toBe(300_000); // tokens need no window
  });
  it("builds the bilingual hint", () => {
    expect(buildCompactHintText(80, 75)).toContain("80%");
    expect(buildCompactHintText(80, 75)).toContain("compact_context");
    expect(buildCompactHintText(80, 75)).toContain("压缩不是终止");
    expect(buildCompactHintText(80, 75, 88)).toContain("\n\n建议");
    expect(buildCompactHintText(80, 75, 88)).toContain("- 若用量继续涨至 88%");
    expect(buildCompactHintText(80, 75, 88)).toContain("- 压缩不是终止");
    expect(buildCompactHintText(80, 75, 0)).not.toContain("强制压缩");
  });

  it("builds the force notice text", () => {
    expect(buildCompactForceText(88, 88)).toContain("88%");
    expect(buildCompactForceText(88, 88)).toContain("强制压缩");
    expect(buildCompactForceText(88, 88)).toContain("压缩不是终止");
  });

  it("computes usage tick steps from the first step up to the ceiling", () => {
    expect(usageTickStep(5, 10, 75)).toBe(0); // below the first step
    expect(usageTickStep(25, 10, 75)).toBe(20); // no floor: ticks start at 10%
    expect(usageTickStep(30, 10, 75)).toBe(30);
    expect(usageTickStep(39.9, 10, 75)).toBe(30);
    expect(usageTickStep(70, 10, 75)).toBe(70);
    expect(usageTickStep(75, 10, 75)).toBe(0); // at/above the ceiling (force zone)
    expect(usageTickStep(45, 15, 75)).toBe(45); // custom step grid
    expect(usageTickStep(50, 0, 75)).toBe(0); // disabled
  });

  it("builds the usage tick text below, at/above the hint ceiling, and without one", () => {
    expect(buildUsageTickText(42, 75)).toContain("42%");
    expect(buildUsageTickText(42, 75)).toContain("75%");
    expect(buildUsageTickText(42, 75)).toContain("无需操作");
    expect(buildUsageTickText(80, 75)).toContain("已超过提醒阈值 75%");
    expect(buildUsageTickText(80, 75)).toContain("compact_context");
    expect(buildUsageTickText(42, 0)).not.toContain("compact_context");
  });
});
