import { describe, expect, it } from "vitest";
import { droidTokenCounts } from "../../../src/external-agent/droid/usage-fields.js";

describe("droid/usage-fields（camelCase 归一）", () => {
  it("标准 tokenUsage 形状", () => {
    expect(
      droidTokenCounts({
        inputTokens: 373,
        outputTokens: 70,
        cacheCreationTokens: 15459,
        cacheReadTokens: 15391,
        thinkingTokens: 23,
        factoryCredits: 1031,
      }),
    ).toEqual({ input: 373, output: 70, cacheRead: 15391, cacheWrite: 15459, thinking: 23, credits: 1031 });
  });

  it("缺字段补 0（lastCallTokenUsage 只有 input/output/cacheRead，S/44 实样）", () => {
    expect(droidTokenCounts({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 1 })).toEqual({
      input: 5,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      thinking: 0,
      credits: 0,
    });
  });

  it("非对象 ⇒ undefined；NaN/Infinity/负数钳 0", () => {
    expect(droidTokenCounts(undefined)).toBeUndefined();
    expect(droidTokenCounts(null)).toBeUndefined();
    expect(droidTokenCounts("x")).toBeUndefined();
    expect(droidTokenCounts([])).toBeUndefined();
    expect(
      droidTokenCounts({ inputTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY, cacheReadTokens: -5 }),
    ).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, credits: 0 });
  });
});
