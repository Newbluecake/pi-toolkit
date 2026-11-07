/**
 * R1 · normalize (plan R1 step 2): pipeline order, NFKC, trailing punctuation, whitespace
 * collapse, code-point counting, raw line counting.
 */
import { describe, expect, it } from "vitest";
import { normalizeInput } from "../../../src/reflex/core/normalize.js";

describe("normalizeInput", () => {
  it("NFKC-folds then lowercases (order: ＦＵＬＬＷＩＤＴＨ → folded → lower)", () => {
    expect(normalizeInput("Ｇｉｔ Ｓｔａｔｕｓ").norm).toBe("git status");
  });

  it("collapses whitespace runs to a single space and trims", () => {
    expect(normalizeInput("  bash   jobs \t ").norm).toBe("bash jobs");
  });

  it("strips stacked trailing punctuation ?？。.!！~", () => {
    expect(normalizeInput("后台还有几个 job？？。。。!!~").norm).toBe("后台还有几个 job");
  });

  it("keeps interior punctuation", () => {
    expect(normalizeInput("5h 额度,用了多少?").norm).toBe("5h 额度,用了多少");
  });

  it("counts chars in code points (not UTF-16 units)", () => {
    const { norm, chars } = normalizeInput("😀😀 后台");
    expect(norm).toBe("😀😀 后台");
    expect(chars).toBe(5);
  });

  it("counts lines of the RAW text (newlines are collapsed in norm but reported)", () => {
    const r = normalizeInput("a\nb\nc");
    expect(r.norm).toBe("a b c");
    expect(r.lines).toBe(3);
    expect(normalizeInput("single").lines).toBe(1);
  });

  it("empty and punctuation-only input normalize to empty", () => {
    expect(normalizeInput("   ").norm).toBe("");
    expect(normalizeInput("？？？").norm).toBe("");
    expect(normalizeInput("").chars).toBe(0);
  });
});
