import { describe, expect, it } from "vitest";
import { formatTokenSpeed } from "../../../src/web-hub/ui/src/format.js";

/**
 * task58 (web-hub-tokens-speed plan §6): `formatTokenSpeed` — the `12.4 tokens/s` chip's
 * formatter. Fixed unit, ALWAYS one decimal (every value — no range-dependent rounding), and
 * fail-closed: anything absent/non-finite/non-positive renders `""` (hidden), never a coerced
 * number. The show/hide GATE lives upstream (`entries.ts` via the protocol's single
 * `sanitizeGenerationCore`); these bounds here are the formatter's own defensive floor.
 */

const core = (tokens: number, genMs: number) => ({ tokens, genMs });

describe("formatTokenSpeed", () => {
  it("renders the fixed unit with exactly one decimal", () => {
    expect(formatTokenSpeed(core(10, 500))).toBe("20.0 tokens/s");
    expect(formatTokenSpeed(core(124, 10000))).toBe("12.4 tokens/s");
    expect(formatTokenSpeed(core(6, 1000))).toBe("6.0 tokens/s");
    expect(formatTokenSpeed(core(1, 1000))).toBe("1.0 tokens/s");
  });

  it("keeps one decimal for every magnitude — no k/m compaction, no locale grouping", () => {
    expect(formatTokenSpeed(core(1000, 1000))).toBe("1000.0 tokens/s");
    expect(formatTokenSpeed(core(10_000_000, 500))).toBe("20000000.0 tokens/s");
    expect(formatTokenSpeed(core(7, 7000))).toBe("1.0 tokens/s");
  });

  it("rounds to one decimal (toFixed), never truncates", () => {
    expect(formatTokenSpeed(core(125, 10000))).toBe("12.5 tokens/s");
    expect(formatTokenSpeed(core(1245, 100000))).toBe("12.4 tokens/s"); // 12.45 → JS binary repr rounds down
    expect(formatTokenSpeed(core(12455, 100000))).toBe("124.5 tokens/s");
  });

  it("accepts the monotonic-clock fractional genMs the contract allows", () => {
    expect(formatTokenSpeed(core(10, 500.5))).toBe("20.0 tokens/s");
  });

  it('hides ("") absent cores', () => {
    expect(formatTokenSpeed(undefined)).toBe("");
    expect(formatTokenSpeed(null)).toBe("");
  });

  it("hides non-finite / non-numeric / non-positive inputs without coercion", () => {
    expect(formatTokenSpeed(core(Number.NaN, 500))).toBe("");
    expect(formatTokenSpeed(core(10, Number.NaN))).toBe("");
    expect(formatTokenSpeed(core(Number.POSITIVE_INFINITY, 500))).toBe("");
    expect(formatTokenSpeed(core(10, Number.POSITIVE_INFINITY))).toBe("");
    expect(formatTokenSpeed(core(10, 0))).toBe("");
    expect(formatTokenSpeed(core(10, -500))).toBe("");
    expect(formatTokenSpeed(core(-10, 500))).toBe("");
    expect(formatTokenSpeed(core(0, 500))).toBe("");
    expect(formatTokenSpeed({ tokens: "10" as unknown as number, genMs: 500 })).toBe("");
    expect(formatTokenSpeed({ tokens: 10, genMs: "500" as unknown as number })).toBe("");
  });
});
