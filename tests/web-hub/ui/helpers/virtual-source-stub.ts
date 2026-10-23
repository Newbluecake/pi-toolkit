/**
 * preview-perf P2 — the TEST-ONLY `VirtualTextSource` stub (plan §8.1 P2 row: the stub
 * lives in the test directory precisely so P2 never imports P1's `logic/previewLineIndex.ts`
 * while both packages run in parallel). It implements the FROZEN interface
 * (`logic/previewVirtualTypes.ts`) faithfully enough to exercise VirtualCode/VirtualBlock:
 *
 * - `countCodeLines` line semantics (source-final "\n" adds no phantom line);
 * - `displayLine` with the §4.2 clip contract: `parts` NEVER contain the terminator
 *   (highlight spans are clamped to the line body), `eol` is its own field, `clipped`
 *   counts the hidden units, and the display cut is surrogate-safe (never ends on a lone
 *   high surrogate);
 * - `setHighlight` maps `HighlightSpans` (source offsets) onto per-line parts, cutting
 *   cross-line tokens at line boundaries — the class carries to every piece;
 * - `maxDisplayCols` is the §4.4 UPPER BOUND over displayed prefixes (ASCII 1 / tab to the
 *   next 8-col stop / any other code point 2, capped at 4096·8+12) — monotone under the
 *   append-only discipline;
 * - `append(fullText)` asserts the prefix rule (dev throw) and reports
 *   `{kind:"append", fromLine: lineOf(oldLength), fromOffset: oldLength}`.
 *
 * When P1 lands, this file is DELETED and the tests switch to the real factory (对接包).
 */
import {
  PREVIEW_VLINE_DISPLAY_MAX,
  type DisplayLine,
  type DisplayPart,
  type HighlightSpans,
  type MutableVirtualSource,
  type VirtualTextChange,
} from "../../../../src/web-hub/ui/src/logic/previewVirtualTypes.js";

/** §4.4: total column cap = a fully-tab 4096-unit line + the 12-col clip marker allowance. */
const MAX_COLS_CAP = PREVIEW_VLINE_DISPLAY_MAX * 8 + 12;

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

/** Column upper bound of one DISPLAYED prefix (§4.4 rules, tab stops of 8). */
function colsOfLine(displayed: string): number {
  let col = 0;
  for (const ch of displayed) {
    if (ch === "\t") col += 8 - (col % 8);
    else col += 1;
  }
  return Math.min(col, MAX_COLS_CAP);
}

export function stubSource(initialText: string): MutableVirtualSource {
  let text = initialText;
  let revision = 1;
  let lastChange: VirtualTextChange = { kind: "init" };
  let highlight: HighlightSpans | null = null;
  /** Offsets of every line start; `lineCount === lineStarts.length`. */
  let lineStarts: number[] = [];

  function rebuildLines(): void {
    const starts: number[] = [];
    if (text !== "") {
      starts.push(0);
      for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
      if (starts.length > 0 && starts[starts.length - 1] === text.length) starts.pop(); // final "\n" ⇒ no phantom
    }
    lineStarts = starts;
  }
  function maxCols(): number {
    let max = 0;
    for (let i = 0; i < lineStarts.length; i++) {
      const dl = source.displayLine(i);
      max = Math.max(max, colsOfLine(dl.parts.map((p) => p.text).join("")));
    }
    return max;
  }
  rebuildLines();

  let source: MutableVirtualSource;
  source = {
    get revision() {
      return revision;
    },
    get lastChange() {
      return lastChange;
    },
    get lineCount() {
      return lineStarts.length;
    },
    get length() {
      return text.length;
    },
    get maxDisplayCols() {
      return maxCols();
    },
    text() {
      return text;
    },
    slice(start, end) {
      const a = Math.max(0, Math.min(text.length, Math.floor(start)));
      const b = Math.max(a, Math.min(text.length, Math.floor(end)));
      return text.slice(a, b);
    },
    lineStart(i) {
      if (i < 0) return 0;
      if (i >= lineStarts.length) return text.length;
      return lineStarts[i] ?? text.length;
    },
    lineText(i) {
      if (i < 0 || i >= lineStarts.length) return "";
      const start = lineStarts[i] ?? 0;
      const end = i + 1 < lineStarts.length ? (lineStarts[i + 1] ?? text.length) : text.length;
      return text.slice(start, end);
    },
    lineOf(offset) {
      if (lineStarts.length === 0) return 0;
      let lo = 0;
      let hi = lineStarts.length - 1;
      const off = Math.max(0, Math.min(text.length, Math.floor(offset)));
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((lineStarts[mid] ?? text.length) <= off) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    displayLine(i) {
      const raw = source.lineText(i);
      const term = raw.endsWith("\n") ? "\n" : "";
      const body = term === "" ? raw : raw.slice(0, -1);
      // surrogate-safe display cut: the visible prefix must never end on a lone high
      // surrogate — its low half would be on the excluded side of the cut, so decrement.
      let cut = Math.min(body.length, PREVIEW_VLINE_DISPLAY_MAX);
      if (cut > 0 && cut < body.length && isHighSurrogate(body.charCodeAt(cut - 1))) cut -= 1;
      const clipped = body.length > cut ? body.length - cut : 0;
      const lineOff = i < lineStarts.length ? (lineStarts[i] ?? 0) : text.length;
      const visibleEnd = lineOff + cut;
      const parts: DisplayPart[] = [];
      if (highlight === null) {
        if (cut > 0) parts.push({ cls: "", text: body.slice(0, cut) });
      } else {
        let pos = lineOff;
        for (let s = 0; s < highlight.spans.length; s += 3) {
          const spanStart = highlight.spans[s] ?? 0;
          const spanEnd = highlight.spans[s + 1] ?? 0;
          const cls = highlight.classes[highlight.spans[s + 2] ?? 0] ?? "";
          if (spanEnd <= lineOff || spanStart >= visibleEnd) continue;
          const a = Math.max(spanStart, lineOff);
          const b = Math.min(spanEnd, visibleEnd);
          if (a > pos) parts.push({ cls: "", text: text.slice(pos, a) });
          if (b > a) parts.push({ cls, text: text.slice(a, b) });
          pos = Math.max(pos, b);
        }
        if (pos < visibleEnd) parts.push({ cls: "", text: text.slice(pos, visibleEnd) });
      }
      return { parts, eol: term === "" ? "" : "\n", clipped };
    },
    append(fullText) {
      if (!fullText.startsWith(text)) {
        throw new Error(
          `virtual-source-stub: append is not a prefix extension (old ${text.length}, new ${fullText.length})`,
        );
      }
      const fromOffset = text.length;
      const fromLine = source.lineOf(fromOffset);
      text = fullText;
      rebuildLines();
      revision += 1;
      lastChange = { kind: "append", fromLine, fromOffset };
    },
    setHighlight(spans) {
      highlight = spans;
      revision += 1;
      lastChange = { kind: "highlight" };
    },
  };
  return source;
}

/** Helper: build `HighlightSpans` from plain [start, end, cls] triples (test authoring). */
export function spansOf(...ranges: Array<[number, number, string]>): HighlightSpans {
  const classes: string[] = [];
  const spans = new Uint32Array(ranges.length * 3);
  let k = 0;
  for (const [start, end, cls] of ranges) {
    const idx = classes.indexOf(cls);
    const classIdx = idx >= 0 ? idx : classes.push(cls) - 1;
    spans[k] = start;
    spans[k + 1] = end;
    spans[k + 2] = classIdx;
    k += 3;
  }
  return { classes, spans };
}
