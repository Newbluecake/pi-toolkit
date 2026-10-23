import { describe, expect, it } from "vitest";
import {
  captureDisplayTitle,
  deriveUniqueLabel,
  firstNonEmptyLine,
  MAX_DISPLAY_TITLE_LENGTH,
  MAX_LABEL_BASE_LENGTH,
  MAX_LABEL_ATTEMPTS,
  sanitizeLabelBase,
} from "../../src/core/labels.js";

describe("labels", () => {
  it("sanitizes whitespace, controls, separators, and preserves symbols", () => {
    expect(sanitizeLabelBase("  sleep\t3  ")).toBe("sleep-3");
    expect(sanitizeLabelBase("a\u0000\u001fb")).toBe("a-b");
    expect(sanitizeLabelBase("---a---b---")).toBe("a-b");
    expect(sanitizeLabelBase("***")).toBe("***");
    expect(sanitizeLabelBase(" \n\t\r ")).toBeUndefined();
    expect(sanitizeLabelBase("中文 任务")).toBe("中文-任务");
  });

  it("truncates by code point without splitting emoji", () => {
    const value = "😀".repeat(MAX_LABEL_BASE_LENGTH);
    const result = sanitizeLabelBase(value);
    expect(result).toBe("😀".repeat(MAX_LABEL_BASE_LENGTH));
    expect([...result!]).toHaveLength(MAX_LABEL_BASE_LENGTH);
  });

  it("selects the first free suffix and handles exhaustion", () => {
    const taken = new Set(["x", "x-2"]);
    expect(deriveUniqueLabel("x", (label) => taken.has(label))).toBe("x-3");
    taken.add("x-3");
    expect(deriveUniqueLabel("x", (label) => taken.has(label))).toBe("x-4");
    expect(deriveUniqueLabel("x-2", (label) => label === "x-2")).toBe("x-2-2");
    expect(deriveUniqueLabel("x", () => true)).toBeUndefined();
    const base = "a".repeat(MAX_LABEL_BASE_LENGTH);
    expect(deriveUniqueLabel(base, (label) => label !== `${base}-999`)).toHaveLength(40);
    expect(MAX_LABEL_ATTEMPTS).toBe(999);
  });

  it("derives a prompt base from the first non-empty line", () => {
    expect(firstNonEmptyLine("\n\n  do this\nnext")).toBe("  do this");
    expect(firstNonEmptyLine("\u0000\u0001\nwork")).toBe("work");
    expect(firstNonEmptyLine("\n\t")).toBeUndefined();
  });

  it("captureDisplayTitle keeps inner whitespace and the first non-empty line verbatim", () => {
    // The whole point of the field: whitespace is NOT dasherized, slashes/plus signs survive.
    expect(captureDisplayTitle("implement /title auto+status")).toBe("implement /title auto+status");
    // Outer whitespace trims; inner runs of spaces keep verbatim — but tabs
    // count as control chars and are stripped (they render as nothing stable).
    expect(captureDisplayTitle("  spaced   out  \t words ")).toBe("spaced   out   words");
    expect(captureDisplayTitle("\n\nfirst line\nsecond line")).toBe("first line");
    expect(captureDisplayTitle("中文 任务 标题")).toBe("中文 任务 标题");
  });

  it("captureDisplayTitle strips control chars and rejects empty input", () => {
    expect(captureDisplayTitle("a\u0000\u001fb")).toBe("ab");
    expect(captureDisplayTitle("\u0000\u0001\nreal title")).toBe("real title");
    expect(captureDisplayTitle("")).toBeUndefined();
    expect(captureDisplayTitle(" \n\t\r ")).toBeUndefined();
    expect(captureDisplayTitle("\u0000\u001f")).toBeUndefined();
  });

  it("captureDisplayTitle caps by code point without splitting emoji", () => {
    const value = "😀".repeat(MAX_DISPLAY_TITLE_LENGTH + 5);
    const result = captureDisplayTitle(value);
    expect(result).toBe("😀".repeat(MAX_DISPLAY_TITLE_LENGTH));
    expect([...result!]).toHaveLength(MAX_DISPLAY_TITLE_LENGTH);
    expect(MAX_DISPLAY_TITLE_LENGTH).toBe(120);
  });
});
