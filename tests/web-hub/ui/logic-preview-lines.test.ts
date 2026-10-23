/**
 * `@logic/previewLines.ts` (preview line numbers, 2026-10-23): the per-line split contract.
 * The load-bearing invariant: concatenating every line's parts reproduces the input text
 * BYTE-IDENTICALLY (each line carries its own "\n" terminator; a source-final "\n" spawns no
 * phantom line), so the numbered body's `textContent` matches the legacy single-`<pre>` body.
 */
import { describe, expect, it } from "vitest";
import {
  countCodeLines,
  lineNumberDigits,
  PREVIEW_NUMBERED_LINES_MAX,
  splitPartsIntoCodeLines,
  splitTextIntoCodeLines,
  type CodeLinePart,
} from "../../../src/web-hub/ui/src/logic/previewLines.js";

const join = (lines: readonly (readonly CodeLinePart[])[]): string =>
  lines.map((l) => l.map((p) => p.text).join("")).join("");

describe("splitTextIntoCodeLines", () => {
  it("splits per logical line, terminator riding its own line; round-trips byte-identically", () => {
    const lines = splitTextIntoCodeLines("line 1\n  indented\nline 3");
    expect(lines.map((l) => l.map((p) => p.text).join(""))).toEqual(["line 1\n", "  indented\n", "line 3"]);
    expect(join(lines)).toBe("line 1\n  indented\nline 3");
    expect(lines.every((l) => l.every((p) => p.cls === ""))).toBe(true);
  });

  it("a source-final newline spawns no phantom last line (the <pre> swallows it too)", () => {
    const lines = splitTextIntoCodeLines("a\n");
    expect(lines).toHaveLength(1);
    expect(join(lines)).toBe("a\n");
  });

  it('keeps blank middle lines as a lone "\\n" part (full-height blank, text preserved)', () => {
    const lines = splitTextIntoCodeLines("a\n\nb");
    expect(lines.map((l) => l.map((p) => p.text).join(""))).toEqual(["a\n", "\n", "b"]);
    expect(join(lines)).toBe("a\n\nb");
  });

  it("edge cases: empty input ⇒ zero lines; a lone newline ⇒ one blank line", () => {
    expect(splitTextIntoCodeLines("")).toEqual([]);
    const lines = splitTextIntoCodeLines("\n");
    expect(lines).toEqual([[{ cls: "", text: "\n" }]]);
    expect(join(splitTextIntoCodeLines("\n\nx"))).toBe("\n\nx");
  });
});

describe("splitPartsIntoCodeLines (flat token parts)", () => {
  it("cuts a cross-line token at the terminator, carrying its class to both pieces", () => {
    const lines = splitPartsIntoCodeLines([
      { cls: "tok-keyword", text: "const" },
      { cls: "", text: " s = " },
      { cls: "tok-string", text: "`a\nb\nc`" },
      { cls: "", text: ";" },
    ]);
    expect(lines.map((l) => l.map((p) => `${p.cls}|${p.text}`))).toEqual([
      ["tok-keyword|const", "| s = ", "tok-string|`a\n"],
      ["tok-string|b\n"],
      ["tok-string|c`", "|;"],
    ]);
    expect(join(lines)).toBe("const s = `a\nb\nc`;");
  });

  it("round-trips multi-line text with blank lines and a trailing newline", () => {
    const parts = [
      { cls: "tok-comment", text: "/* one\n\nthree */\n" },
      { cls: "", text: "tail" },
    ];
    const lines = splitPartsIntoCodeLines(parts);
    expect(lines.map((l) => l.map((p) => p.text).join(""))).toEqual(["/* one\n", "\n", "three */\n", "tail"]);
    expect(join(lines)).toBe("/* one\n\nthree */\ntail");
    // the trailing "\n" stayed on line 3 — no phantom fifth line
    expect(lines).toHaveLength(4);
  });

  it("handles empty parts and an all-newline part", () => {
    expect(splitPartsIntoCodeLines([])).toEqual([]);
    const lines = splitPartsIntoCodeLines([
      { cls: "", text: "" },
      { cls: "tok-x", text: "\n" },
    ]);
    expect(lines).toEqual([[{ cls: "tok-x", text: "\n" }]]);
  });
});

describe("countCodeLines / lineNumberDigits", () => {
  it("counts rendered logical lines without splitting", () => {
    expect(countCodeLines("")).toBe(0);
    expect(countCodeLines("a")).toBe(1);
    expect(countCodeLines("a\n")).toBe(1);
    expect(countCodeLines("a\nb")).toBe(2);
    expect(countCodeLines("a\n\nb\n")).toBe(3);
    expect(countCodeLines("\n".repeat(9000))).toBe(9000);
    // parity with the splitter on a fuzz-ish shape
    const t = "x\n\ny\n\n\nz";
    expect(countCodeLines(t)).toBe(splitTextIntoCodeLines(t).length);
  });

  it("digits: min 2, then the decimal width of the largest number", () => {
    expect(lineNumberDigits(1)).toBe(2);
    expect(lineNumberDigits(9)).toBe(2);
    expect(lineNumberDigits(99)).toBe(2);
    expect(lineNumberDigits(100)).toBe(3);
    expect(lineNumberDigits(3000)).toBe(4);
    expect(lineNumberDigits(Number.NaN)).toBe(2);
    expect(lineNumberDigits(0)).toBe(2);
  });

  it("the cap constant is a sane positive bound", () => {
    expect(PREVIEW_NUMBERED_LINES_MAX).toBeGreaterThan(1000);
  });
});
