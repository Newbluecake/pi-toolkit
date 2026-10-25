/**
 * `@logic/previewLineIndex.ts` (preview-perf plan r3 §4.2/§4.4, P1) — the virtual text
 * model. The load-bearing properties: arbitrary-cut-point appends build EXACTLY the index a
 * one-shot `fromText` builds (incl. surrogate-split cuts), `lineStart`/`lineOf` are inverse,
 * a source-final "\n" spawns no phantom line, `displayLine` is surrogate-safe with a
 * separate `eol` (parts never carry "\n", cross-line spans are cut), and `maxDisplayCols`
 * is the §4.4 upper bound and monotone under append.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createVirtualSourceFactory } from "../../../src/web-hub/ui/src/logic/previewLineIndex.js";
import type { DisplayLine, MutableVirtualSource } from "../../../src/web-hub/ui/src/logic/previewVirtualTypes.js";
import { PREVIEW_VLINE_DISPLAY_MAX } from "../../../src/web-hub/ui/src/logic/previewVirtualTypes.js";

const factory = createVirtualSourceFactory();

/** Test-side naive §4.4 column oracle (independent of the implementation). */
function naiveCols(content: string): number {
  let col = 0;
  const end = Math.min(content.length, PREVIEW_VLINE_DISPLAY_MAX);
  for (let i = 0; i < end; i++) {
    const code = content.charCodeAt(i);
    if (code === 0x09) col = (Math.floor(col / 8) + 1) * 8;
    else if (code < 0x80) col += 1;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < end &&
      content.charCodeAt(i + 1) >= 0xdc00 &&
      content.charCodeAt(i + 1) <= 0xdfff
    ) {
      col += 2;
      i++; // a full surrogate pair inside the window counts once
    } else col += 2; // lone surrogate / BMP non-ASCII
  }
  return col;
}

const lineTextOf = (s: MutableVirtualSource, i: number): string => s.lineText(i);

function snapshot(s: MutableVirtualSource) {
  const lines: DisplayLine[] = [];
  for (let i = 0; i < s.lineCount; i++) lines.push(s.displayLine(i));
  const starts: number[] = [];
  for (let i = 0; i <= s.lineCount; i++) starts.push(s.lineStart(i));
  const lineOf: number[] = [];
  for (let o = 0; o <= s.length; o++) lineOf.push(s.lineOf(o));
  return { lineCount: s.lineCount, length: s.length, maxDisplayCols: s.maxDisplayCols, lines, starts, lineOf };
}

describe("createVirtualSourceFactory — one-shot vs arbitrary-cut appends (property)", () => {
  const ALPHABET = ["a", "b", "\n", "\n", "中", "\t", "\uD801\uDC00", "\uD801", "\uDC00", "Σ", " "];
  const arbText = fc.array(fc.constantFrom(...ALPHABET), { maxLength: 90 }).map((xs) => xs.join(""));
  const arbCuts = fc
    .uniqueArray(fc.nat({ max: 400 }), { minLength: 1, maxLength: 8 })
    .map((ns) => [...new Set(ns)].sort((x, y) => x - y));

  it("any split (cut points may fall inside a surrogate pair) equals the one-shot build", () => {
    fc.assert(
      fc.property(arbText, arbCuts, (text, cuts) => {
        const points = cuts.filter((c) => c > 0 && c < text.length);
        const stream = factory.forStream();
        for (const p of points) stream.append(text.slice(0, p));
        stream.append(text);
        expect(snapshot(stream)).toEqual(snapshot(factory.fromText(text)));
      }),
      { numRuns: 200 },
    );
  });

  it("append bumps revision monotonically and reports the first changed line/offset", () => {
    const s = factory.forStream();
    expect(s.revision).toBe(0);
    s.append("ab");
    expect(s.revision).toBe(1);
    expect(s.lastChange).toEqual({ kind: "append", fromLine: 0, fromOffset: 0 });
    s.append("ab\nx"); // "ab" (2) ⇒ the old last line (0) grows
    expect(s.lastChange).toEqual({ kind: "append", fromLine: 0, fromOffset: 2 });
    s.append("ab\nx\ny"); // "ab\nx" (4) ⇒ line 1 ("x") grows and terminates
    expect(s.lastChange).toEqual({ kind: "append", fromLine: 1, fromOffset: 4 });
    s.append("ab\nx\ny\n"); // "ab\nx\ny" (6) ⇒ line 2 ("y") terminates ⇒ text ends "\n"
    expect(s.lastChange).toEqual({ kind: "append", fromLine: 2, fromOffset: 6 });
    s.append("ab\nx\ny\nz"); // "ab\nx\ny\n" (7) ended "\n" ⇒ pending line 3 becomes real
    expect(s.lastChange).toEqual({ kind: "append", fromLine: 3, fromOffset: 7 });
    expect(factory.fromText("t").revision).toBe(1);
    expect(factory.fromText("t").lastChange).toEqual({ kind: "init" });
  });

  it("appending a non-prefix text throws in dev instead of corrupting", () => {
    const s = factory.forStream();
    s.append("abc");
    expect(() => s.append("abd")).toThrowError(/prefix/);
    expect(() => s.append("ab")).toThrowError(/prefix/); // shrink is a violation too
  });
});

describe("line index invariants", () => {
  it("lineStart/lineOf are inverse; lineStart(lineCount) === length (property)", () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom("a", "\n", "\n\n", "中中", "\uD801\uDC00"), { maxLength: 40 })
          .map((xs) => xs.join("")),
        (text) => {
          const s = factory.fromText(text);
          expect(s.lineStart(s.lineCount)).toBe(s.length);
          for (let i = 0; i < s.lineCount; i++) {
            expect(s.lineOf(s.lineStart(i))).toBe(i);
            if (i + 1 < s.lineCount) expect(s.lineStart(i + 1)).toBeGreaterThan(s.lineStart(i));
          }
          expect(s.text()).toBe(text);
          expect(s.length).toBe(text.length);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("a source-final newline adds no phantom line (countCodeLines semantics)", () => {
    expect(factory.fromText("").lineCount).toBe(0);
    expect(factory.fromText("a").lineCount).toBe(1);
    expect(factory.fromText("a\n").lineCount).toBe(1);
    expect(factory.fromText("a\nb").lineCount).toBe(2);
    expect(factory.fromText("a\nb\n").lineCount).toBe(2);
    expect(factory.fromText("\n").lineCount).toBe(1);
    expect(factory.fromText("\n\n").lineCount).toBe(2);
    expect(factory.fromText("\n\n").lineText(1)).toBe("\n");
  });

  it("lineText carries the terminator; the last line may be unterminated and grow", () => {
    const s = factory.forStream();
    s.append("ab\ncd");
    expect(lineTextOf(s, 0)).toBe("ab\n");
    expect(lineTextOf(s, 1)).toBe("cd");
    s.append("ab\ncdef\ngh");
    expect(lineTextOf(s, 1)).toBe("cdef\n");
    expect(lineTextOf(s, 2)).toBe("gh");
  });

  it("slice clamps its bounds; out-of-range accessors are total", () => {
    const s = factory.fromText("abcdef");
    expect(s.slice(2, 5)).toBe("cde");
    expect(s.slice(-3, 99)).toBe("abcdef");
    expect(s.slice(4, 2)).toBe("");
    expect(s.slice(0, 0)).toBe("");
    expect(factory.fromText("").displayLine(0)).toEqual({ parts: [], eol: "", clipped: 0 });
    expect(factory.fromText("").lineOf(0)).toBe(0);
    expect(factory.fromText("a").lineText(-1)).toBe("");
    expect(factory.fromText("a").lineText(9)).toBe("");
  });
});

describe("displayLine — clip, eol, highlight (§4.2/§R2 #1)", () => {
  it("clips at 4096 units, surrogate-safe: the cut never ends on a lone high surrogate", () => {
    const content = `${"A".repeat(4095)}\uD801\uDC00${"x".repeat(10)}`; // 4095 + 2 + 10 units
    const s = factory.fromText(`${content}\n`);
    const d = s.displayLine(0);
    expect(d.parts).toEqual([{ cls: "", text: "A".repeat(4095) }]); // the pair is NOT split
    expect(d.eol).toBe("\n");
    expect(d.clipped).toBe(12); // 2 (pair) + 10 − 0 … = content − 4095
    // a cut landing on the pair's low surrogate side keeps the whole pair:
    const exact = factory.fromText(`${"A".repeat(4094)}\uD801\uDC00\n`);
    const d2 = exact.displayLine(0);
    expect(d2.parts).toEqual([{ cls: "", text: "A".repeat(4094) + "\uD801\uDC00" }]);
    expect(d2.clipped).toBe(0);
  });

  it("parts never contain '\\n'; eol is separate; empty line has no parts", () => {
    const s = factory.fromText("\nabc\n\n");
    expect(s.displayLine(0)).toEqual({ parts: [], eol: "\n", clipped: 0 });
    expect(s.displayLine(1)).toEqual({ parts: [{ cls: "", text: "abc" }], eol: "\n", clipped: 0 });
    expect(s.displayLine(2)).toEqual({ parts: [], eol: "\n", clipped: 0 });
    const last = factory.fromText("abc");
    expect(last.displayLine(0)).toEqual({ parts: [{ cls: "", text: "abc" }], eol: "", clipped: 0 });
  });

  it("a cross-line span is cut at the terminator: its '\\n' moves to eol, class stays", () => {
    const s = factory.fromText("aa\nbb\ncc");
    s.setHighlight({
      classes: ["tok-str"],
      spans: new Uint32Array([0, 5, 0]), // covers "aa\nbb" across the line break
    });
    expect(s.lastChange).toEqual({ kind: "highlight" });
    expect(s.displayLine(0)).toEqual({ parts: [{ cls: "tok-str", text: "aa" }], eol: "\n", clipped: 0 });
    expect(s.displayLine(1)).toEqual({ parts: [{ cls: "tok-str", text: "bb" }], eol: "\n", clipped: 0 });
    expect(s.displayLine(2)).toEqual({ parts: [{ cls: "", text: "cc" }], eol: "", clipped: 0 });
    // and a highlight that only touches the hidden tail of a clipped line renders plain there
    const long = factory.fromText(`${"x".repeat(4100)}\n`);
    long.setHighlight({ classes: ["tok-x"], spans: new Uint32Array([4098, 4100, 0]) });
    const d = long.displayLine(0);
    expect(d.parts).toEqual([{ cls: "", text: "x".repeat(4096) }]); // plain: no span hits the prefix
    expect(d.clipped).toBe(4);
    long.setHighlight(null); // back to plain, revision keeps climbing
    expect(long.displayLine(0).parts).toEqual([{ cls: "", text: "x".repeat(4096) }]);
    expect(long.lastChange).toEqual({ kind: "highlight" });
  });

  it("a line that would exceed PREVIEW_VLINE_MAX_PARTS renders as a single plain part", () => {
    const line = Array.from({ length: 1200 }, (_, i) => (i % 2 ? "b" : "a")).join("");
    const s = factory.fromText(`${line}\n`);
    const triples: number[] = [];
    for (let i = 0; i < 1200; i++) triples.push(i, i + 1, i % 2); // 1200 one-char spans
    s.setHighlight({ classes: ["tok-even", "tok-odd"], spans: new Uint32Array(triples) });
    expect(s.displayLine(0).parts).toEqual([{ cls: "", text: line }]);
  });

  it("malformed highlight payloads degrade to plain, never throw", () => {
    const s = factory.fromText("abc\n");
    s.setHighlight({ classes: ["tok"], spans: new Uint32Array([0, 2]) }); // % 3 !== 0
    expect(s.displayLine(0).parts).toEqual([{ cls: "", text: "abc" }]);
    s.setHighlight({ classes: [7], spans: new Uint32Array([0, 2, 0]) });
    expect(s.displayLine(0).parts).toEqual([{ cls: "", text: "abc" }]);
  });
});

describe("maxDisplayCols — §4.4 upper bound, monotone", () => {
  it("counts ASCII 1, tabs to the next 8-stop, non-ASCII code points 2, +12 when clipped", () => {
    const cols = (line: string): number => factory.fromText(`${line}\n`).maxDisplayCols;
    expect(cols("abc")).toBe(3);
    expect(cols("\t")).toBe(8);
    expect(cols("a\t")).toBe(8); // col 1 + tab → next 8-stop
    expect(cols("a\tb")).toBe(9);
    expect(cols("\t\t")).toBe(16);
    expect(cols("\t\ta")).toBe(17);
    expect(cols("中")).toBe(2);
    expect(cols("中中")).toBe(4);
    expect(cols("a\uD801\uDC00")).toBe(3); // one astral code point = 2
    expect(cols("a\uD801")).toBe(3); // a lone surrogate = 2 (upper bound)
    const tabbed = `${"\t".repeat(PREVIEW_VLINE_DISPLAY_MAX)}${"x".repeat(10)}`;
    expect(cols(tabbed)).toBe(PREVIEW_VLINE_DISPLAY_MAX * 8 + 12); // the natural cap
  });

  it("equals the naive per-line oracle and only grows under append (property)", () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom("a", "b", "\n", "\n", "\t", "中", "\uD801\uDC00", "\uD801"), { maxLength: 80 })
          .map((xs) => xs.join("")),
        fc
          .array(fc.nat({ max: 200 }), { minLength: 1, maxLength: 5 })
          .map((ns) => [...new Set(ns)].sort((x, y) => x - y)),
        (text, cuts) => {
          const points = cuts.filter((c) => c > 0 && c < text.length);
          const naive = (t: string): number => {
            let max = 0;
            for (const rawLine of t.split("\n")) {
              const clipped = rawLine.length > PREVIEW_VLINE_DISPLAY_MAX;
              const c = naiveCols(rawLine) + (clipped ? 12 : 0);
              if (c > max) max = c;
            }
            return Math.min(max, PREVIEW_VLINE_DISPLAY_MAX * 8 + 12);
          };
          const s = factory.forStream();
          let prev = 0;
          for (const p of points) {
            s.append(text.slice(0, p));
            expect(s.maxDisplayCols).toBeGreaterThanOrEqual(prev);
            prev = s.maxDisplayCols;
          }
          s.append(text);
          expect(s.maxDisplayCols).toBeGreaterThanOrEqual(prev);
          expect(s.maxDisplayCols).toBe(naive(text));
          expect(factory.fromText(text).maxDisplayCols).toBe(naive(text));
        },
      ),
      { numRuns: 150 },
    );
  });
});
