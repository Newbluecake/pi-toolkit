/**
 * Preview virtual-scroll text model (preview-perf plan r3 §4.2/§4.4) — the pure
 * `VirtualSourceFactory` implementation behind `VirtualCode`/`VirtualBlock` (P2/P3 consume
 * it through the P1a-frozen `@logic/previewVirtualTypes.js` contract; this file must never
 * change those shapes). No DOM, no Vue, no I/O — same discipline as `./previewLines.ts`.
 *
 * Data model (all offsets are UTF-16 code units into the LOADED text):
 *  - `starts` holds line-start offsets, `starts[0] === 0` for non-empty text. When the text
 *    ends with "\n" the array carries one PENDING entry `=== length` (the would-be start of
 *    the next line): `lineCount` excludes it, but `lineStart(lineCount) === length` — the
 *    frozen §4.2 contract — holds through it, and the pending entry is silently PROMOTED to
 *    a real line start by the next `append` (no re-scan of the old terminator needed).
 *  - `append` scans only `[oldLength, newLength)` for "\n"; the from-change line reported in
 *    `lastChange` (`fromLine`) is the last unterminated line (it grew), or the pending/first
 *    new line when the old text ended with "\n".
 *  - `displayLine(i)` clips the line's content to `PREVIEW_VLINE_DISPLAY_MAX` units
 *    (surrogate-safe: a cut never ends on a lone high surrogate), applies highlight spans,
 *    and carries the terminator in the separate `eol` field (§R2 #1). Cached per line;
 *    appends invalidate only lines ≥ `fromLine`, highlight arrival clears everything, and a
 *    FIFO cap bounds the cache (selection keeps ≤2048 lines mounted, 8192 covers it).
 *  - `maxDisplayCols` is the §4.4 UPPER BOUND over all lines' DISPLAYED prefixes: ASCII 1
 *    column, tab advances to the next 8-column stop, every other code point 2 columns, the
 *    clip marker adds 12; naturally capped at `4096 × 8 + 12`. Maintained incrementally on
 *    append (recomputed for lines ≥ `fromLine` only), hence monotone by construction.
 *
 * Dev builds (vite `import.meta.env.DEV`, also true under vitest) throw on an `append`
 * prefix violation; production rebuilds the index from the new text (frozen §4.2 note).
 */

import { decodeHighlightSpans } from "@logic/highlight.js";
import {
  PREVIEW_VLINE_DISPLAY_MAX,
  PREVIEW_VLINE_MAX_PARTS,
  type DisplayLine,
  type DisplayPart,
  type HighlightSpans,
  type MutableVirtualSource,
  type VirtualSourceFactory,
  type VirtualTextChange,
} from "@logic/previewVirtualTypes.js";

/** Dev assertion gate (see header; production keeps running via rebuild). */
const DEV = import.meta.env?.DEV === true;

/** displayLine cache ceiling — FIFO-evicted; ≥ the 2048-line selection mount cap (§4.5). */
const DISPLAY_CACHE_MAX = 8192;

/** §4.4: the clip marker's own column budget (`…(+N)` ≈ 12 columns). */
const CLIP_MARKER_COLS = 12;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

const EMPTY_LINE: DisplayLine = { parts: [], eol: "", clipped: 0 };

/**
 * §4.4 upper-bound column count of `content`'s DISPLAYED prefix: ASCII 1 col, tab → next
 * 8-col stop, any other code point 2 cols. Iterates at most `PREVIEW_VLINE_DISPLAY_MAX`
 * units (columns are monotone in the prefix, so stopping at the unit cap is still an upper
 * bound of every surrogate-adjusted shorter cut).
 */
function displayCols(content: string): number {
  let col = 0;
  const end = Math.min(content.length, PREVIEW_VLINE_DISPLAY_MAX);
  for (let i = 0; i < end;) {
    const code = content.charCodeAt(i);
    if (code === 0x09) {
      col = (Math.floor(col / 8) + 1) * 8;
      i += 1;
    } else if (code < 0x80) {
      col += 1;
      i += 1;
    } else {
      col += 2;
      i += code >= 0xd800 && code <= 0xdbff && isLowSurrogate(content.charCodeAt(i + 1)) ? 2 : 1;
    }
  }
  return col;
}

/** Structural sanity for a highlight payload (defensive: a bad worker result degrades to plain). */
function isValidSpans(spans: unknown): spans is HighlightSpans {
  if (spans === null || typeof spans !== "object") return false;
  const s = spans as { classes?: unknown; spans?: unknown };
  if (!Array.isArray(s.classes) || s.classes.some((c) => typeof c !== "string")) return false;
  if (!(s.spans instanceof Uint32Array) || s.spans.length % 3 !== 0) return false;
  return true;
}

/** Fresh `starts` (incl. the pending trailing entry when `text` ends with "\n"). */
function buildStarts(text: string): number[] {
  if (text === "") return [];
  const starts = [0];
  for (let p = text.indexOf("\n"); p >= 0; p = text.indexOf("\n", p + 1)) starts.push(p + 1);
  return starts;
}

/** Line count from `starts` + the text's terminator shape (countCodeLines semantics). */
function countFrom(starts: readonly number[], text: string): number {
  if (text === "") return 0;
  return text.endsWith("\n") ? starts.length - 1 : starts.length;
}

function buildSource(initialText: string, initialRev: number): MutableVirtualSource {
  let text = initialText;
  let starts = buildStarts(text);
  let rev = initialRev;
  let change: VirtualTextChange = { kind: "init" };
  let lineCount = countFrom(starts, text);
  let highlight: HighlightSpans | null = null;
  let maxCols = 0;
  const cache = new Map<number, DisplayLine>();

  const lineStart = (i: number): number => {
    if (i <= 0) return 0;
    return i < starts.length ? (starts[i] as number) : text.length;
  };

  /** §4.4 column bound of line `i`'s displayed prefix (+ marker when clipped). */
  const lineCols = (i: number): number => {
    const next = i + 1 < starts.length ? (starts[i + 1] as number) : text.length;
    const raw = text.slice(starts[i] as number, next);
    const content = raw.endsWith("\n") ? raw.slice(0, raw.length - 1) : raw;
    const cols = displayCols(content);
    return content.length > PREVIEW_VLINE_DISPLAY_MAX ? cols + CLIP_MARKER_COLS : cols;
  };

  const refreshMaxCols = (fromLine: number): void => {
    for (let i = fromLine; i < lineCount; i++) {
      const c = lineCols(i);
      if (c > maxCols) maxCols = c;
    }
    maxCols = Math.min(maxCols, PREVIEW_VLINE_DISPLAY_MAX * 8 + CLIP_MARKER_COLS);
  };

  const displayLine = (i: number): DisplayLine => {
    if (i < 0 || i >= lineCount) return EMPTY_LINE;
    const hit = cache.get(i);
    if (hit !== undefined) return hit;
    const s = starts[i] as number;
    const next = i + 1 < starts.length ? (starts[i + 1] as number) : text.length;
    const raw = text.slice(s, next);
    const terminated = raw.endsWith("\n");
    const content = terminated ? raw.slice(0, raw.length - 1) : raw;
    let take = content.length;
    let clipped = 0;
    if (content.length > PREVIEW_VLINE_DISPLAY_MAX) {
      take = PREVIEW_VLINE_DISPLAY_MAX;
      // surrogate-safe cut: never end the displayed prefix on a lone high surrogate (§4.2)
      if (isHighSurrogate(content.charCodeAt(take - 1)) && isLowSurrogate(content.charCodeAt(take))) take -= 1;
      clipped = content.length - take;
    }
    let parts: readonly DisplayPart[];
    if (highlight === null || take === 0) {
      parts = take === 0 ? [] : [{ cls: "", text: content.slice(0, take) }];
    } else {
      const decoded = decodeHighlightSpans(highlight, text, s, s + take);
      parts =
        decoded === null
          ? [{ cls: "", text: content.slice(0, take) }] // malformed spans ⇒ plain, never throw
          : decoded;
      if (parts.length > PREVIEW_VLINE_MAX_PARTS) parts = [{ cls: "", text: content.slice(0, take) }];
    }
    const line: DisplayLine = { parts, eol: terminated ? "\n" : "", clipped };
    if (cache.size >= DISPLAY_CACHE_MAX) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(i, line);
    return line;
  };

  /** Prod recovery for an append-contract violation: full rebuild, `init` change. */
  const rebuild = (fullText: string): void => {
    text = fullText;
    starts = buildStarts(text);
    lineCount = countFrom(starts, text);
    cache.clear();
    maxCols = 0;
    refreshMaxCols(0);
    rev += 1;
    change = { kind: "init" };
  };

  refreshMaxCols(0);

  return {
    get revision() {
      return rev;
    },
    get lastChange() {
      return change;
    },
    get lineCount() {
      return lineCount;
    },
    get length() {
      return text.length;
    },
    get maxDisplayCols() {
      return maxCols;
    },
    text: () => text,
    slice: (start: number, end: number): string => {
      const len = text.length;
      const s = Math.max(0, Math.min(Math.floor(start) || 0, len));
      const e = Math.max(0, Math.min(Math.floor(end) || 0, len));
      return s >= e ? "" : text.slice(s, e);
    },
    lineStart,
    lineText: (i: number): string => {
      if (i < 0 || i >= lineCount) return "";
      return text.slice(lineStart(i), lineStart(i + 1));
    },
    displayLine,
    lineOf: (offset: number): number => {
      if (lineCount <= 0) return 0;
      if (offset <= 0) return 0;
      if (offset >= text.length) return lineCount - 1;
      let lo = 0;
      let hi = lineCount - 1;
      let ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if ((starts[mid] as number) <= offset) {
          ans = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return ans;
    },
    append: (fullText: string): void => {
      if (typeof fullText !== "string" || fullText === text) return;
      const oldLen = text.length;
      if (fullText.length < oldLen || !fullText.startsWith(text)) {
        if (DEV) throw new Error("previewLineIndex.append: the old text must be a prefix of the new text");
        rebuild(fullText);
        return;
      }
      if (fullText.length === oldLen) return; // defensive: equal length + prefix ⇒ identical
      const newLen = fullText.length;
      // First line whose display changes: the (growing) unterminated last line, or the line
      // the old terminator's pending start promotes into. An empty stream also seeds line 0.
      const fromLine = oldLen === 0 || text.endsWith("\n") ? lineCount : lineCount - 1;
      if (oldLen === 0 && starts.length === 0) starts.push(0); // "" grew its first line
      for (let p = fullText.indexOf("\n", oldLen); p >= 0 && p < newLen; p = fullText.indexOf("\n", p + 1)) {
        starts.push(p + 1); // p+1 === newLen stays PENDING until more text arrives
      }
      text = fullText;
      lineCount = countFrom(starts, text);
      for (const k of cache.keys()) if (k >= fromLine) cache.delete(k);
      refreshMaxCols(fromLine);
      rev += 1;
      change = { kind: "append", fromLine, fromOffset: oldLen };
    },
    setHighlight: (spans: HighlightSpans | null): void => {
      highlight = isValidSpans(spans) ? spans : null;
      cache.clear(); // highlight repaints every mounted block (§4.5)
      rev += 1;
      change = { kind: "highlight" };
    },
  };
}

/**
 * The `VirtualSourceFactory` (§4.2). `fromText` builds a one-shot source (revision 1,
 * `init`); `forStream` starts empty (revision 0) and grows through `append`.
 */
export function createVirtualSourceFactory(): VirtualSourceFactory {
  return {
    fromText: (text: string): MutableVirtualSource => buildSource(text, 1),
    forStream: (): MutableVirtualSource => buildSource("", 0),
  };
}
