/**
 * Preview large-text performance (preview-perf plan r3) — P1a FROZEN INTERFACE.
 *
 * This file is the single-owner contract for the virtual-scrolling source view
 * (`docs/dev/preview-perf/plan.md` §4.2 + the constant list of §8.1's P1a row). It was
 * committed FIRST, before P1 (pure logic) / P2 (VirtualBlock renderer) / P3 (wiring,
 * find, full view); those packages only CONSUME it and must not change it. Any shape
 * change needs a plan revision, not an in-flight edit.
 *
 * Contents are types + build-time constants ONLY — no runtime logic, no Vue, no DOM
 * (same discipline as `./previewLines.ts` / `./preview.js`).
 *
 * Section map:
 *  - `DisplayPart` / `DisplayLine` ………………………… §4.2 (clip marker BEFORE the terminator)
 *  - `VirtualTextSource` / `VirtualTextChange` ……… §4.2 (text model: access, slicing, revision)
 *  - `VirtualSourceFactory` / `MutableVirtualSource` §4.2 (non-stream + stream construction)
 *  - `HighlightSpans` ………………………………………………… §4.2 / §5.3 (compact, transferable)
 *  - constants ………………………………………………………………… §0 / §4.1 / §4.3 / §4.5 / §4.6 / §5.3
 */

/** One displayed fragment; `cls` "" = plain text node, else a `tok-*` class list. (§4.2) */
export interface DisplayPart {
  readonly cls: string;
  readonly text: string;
}

/**
 * One logical line AS DISPLAYED (P1 builds it; VirtualBlock renders it verbatim). (§4.2)
 * r3: the terminator is a SEPARATE field — the clip marker must render BEFORE it, so the
 * line keeps exactly ONE line box and the fixed row height holds by construction (§R2 #1).
 */
export interface DisplayLine {
  /**
   * Display parts WITHOUT the line terminator: the line's first ≤ `PREVIEW_VLINE_DISPLAY_MAX`
   * code units (surrogate-safe: never ends on a lone high surrogate). A token part that
   * carried the "\n" in the source (cross-line comment/string) is cut: its "\n" moves to `eol`.
   */
  readonly parts: readonly DisplayPart[];
  /**
   * The line's own terminator ("\n"), or "" for an unterminated last line. Always rendered as
   * the line element's LAST child, a plain text node (block-final ⇒ swallowed by the browser,
   * exactly CodeLines' mechanism) — never inside a token span, never after the clip marker.
   */
  readonly eol: "\n" | "";
  /**
   * Hidden code units after the display cut (0 ⇒ not clipped). Rendered ONLY as CSS generated
   * content on an EMPTY marker span placed between `parts` and `eol`, never as DOM text.
   */
  readonly clipped: number;
}

/**
 * What the last revision bump changed — drives incremental consumers (find, renderer).
 * (§4.2 spells this union inline on `VirtualTextSource.lastChange`; extracted verbatim.)
 */
export type VirtualTextChange =
  | { readonly kind: "init" }
  | { readonly kind: "append"; readonly fromLine: number; readonly fromOffset: number }
  | { readonly kind: "highlight" };

/** The single text model behind a virtual body (source = ANSI-stripped LOADED text). (§4.2) */
export interface VirtualTextSource {
  /** Monotone; bumps on append AND on highlight arrival. */
  readonly revision: number;
  /** What the last bump changed — drives incremental consumers (find, renderer). */
  readonly lastChange: VirtualTextChange;
  /** Logical line count (countCodeLines semantics: a source-final "\n" adds no phantom line). */
  readonly lineCount: number;
  /** Total loaded length (UTF-16 code units) == text().length. */
  readonly length: number;
  /** The whole loaded text (same string instance PreviewText already holds — no copy). */
  text(): string;
  /** text().slice(start, end) — bounds clamped. */
  slice(start: number, end: number): string;
  /** Offset of line i's first code unit; lineStart(lineCount) === length. */
  lineStart(i: number): number;
  /** Line i incl. its "\n" (the last line may lack one — and may still GROW on append). */
  lineText(i: number): string;
  /** Display form of line i (clip + highlight applied). Cached per (i, revision class). */
  displayLine(i: number): DisplayLine;
  /** Upper-bound display width in `ch` over ALL lines' DISPLAYED prefix (§4.4); monotone. */
  readonly maxDisplayCols: number;
  /** Binary search: the line containing `offset` (0 ≤ offset ≤ length). */
  lineOf(offset: number): number;
}

/** Constructor surface P3 wires into PreviewText. (§4.2) */
export interface VirtualSourceFactory {
  /** Non-stream: one-shot text (+ later highlight). */
  fromText(text: string): MutableVirtualSource;
  /** Stream: starts empty, grows via append. */
  forStream(): MutableVirtualSource;
}

export interface MutableVirtualSource extends VirtualTextSource {
  /**
   * Stream only: the new FULL text (the old text must be its prefix — asserted; violations
   * throw in dev, rebuild in prod). Scans only [oldLength, newLength).
   */
  append(fullText: string): void;
  /** Highlight arrival (main-thread or Worker result), see §5. Null ⇒ stay plain. */
  setHighlight(spans: HighlightSpans | null): void;
}

/** Compact, transferable highlight result over SOURCE offsets (Worker-friendly, §5.3). (§4.2) */
export interface HighlightSpans {
  /** index → "tok-…" class list */
  readonly classes: readonly string[];
  /** Triples [start, end, classIdx] sorted by start, non-overlapping; gaps are plain text. */
  readonly spans: Uint32Array;
}

/* ------------------------------------------------------------------------- *
 * Build-time constants (§8.1 P1a list: ENABLED / 600 / 32 / 2048 / 4096 /
 * 15e6 / 500k / 80k / 1000 / FIND_MAX). All are compile-time values: changing
 * one requires a `build:web` rebuild — none is a runtime setting.
 * ------------------------------------------------------------------------- */

/**
 * Build-time kill switch for the virtual source view (§4.1, r3 §R2 #4). `false` makes
 * `chooseSourceRenderer` delegate to the r0 selection (legacy / NumberedCode / CodeLines
 * per segment, incl. the 8000-line degrade) — the three r0 branches MUST stay alive in P3.
 * NOT a runtime setting: user-facing runtime exits remain the per-window full view (§4.7)
 * and the global line-numbers toggle. Setting `PREVIEW_VIRTUAL_MIN_LINES` to `Infinity`
 * is NOT a kill switch (r3 superseded that claim).
 */
export const PREVIEW_VIRTUAL_ENABLED = true;

/**
 * Threshold: numbered NON-stream sources above this many lines render via `VirtualCode`;
 * at or below it the full-DOM `NumberedCode` → `CodeLines` path is kept (§4.1). Stream
 * sources with line numbers on are ALWAYS virtual, regardless of this threshold. PB
 * re-measures the 600-line highlight / long-line / narrow-screen cases on the real build
 * before the threshold is finalized (§0).
 */
export const PREVIEW_VIRTUAL_MIN_LINES = 600;

/**
 * Lines per virtual block (§4.3/§4.5): block top = blockIndex × `PREVIEW_VIRTUAL_BLOCK_LINES`
 * × rowH (rounding error stays inside a block, never accumulates); the window keeps a
 * contiguous block range with ±1 screen overscan (1.5 on coarse pointers) and half-block
 * hysteresis. 2048 selection lines = 64 blocks of this size.
 */
export const PREVIEW_VIRTUAL_BLOCK_LINES = 32;

/**
 * While a native selection is active the mounted range only grows (stays contiguous),
 * capped at this many lines (§4.5, 已拍板 ④); past the cap the window returns to normal
 * and the selection is no longer guaranteed (status notice → Ctrl+A / full view).
 */
export const VIRTUAL_SELECTION_MAX_LINES = 2048;

/**
 * Per-line display cut in UTF-16 code units (§4.2, 已拍板 ②): `DisplayLine.parts` carries
 * the first ≤ this many units (surrogate-safe), hidden units are counted in `clipped` and
 * surfaced only as the CSS-generated `…(+N)` marker. Native copy of a clipped line yields
 * just the displayed prefix; full content goes through copy-all / full view / download.
 */
export const PREVIEW_VLINE_DISPLAY_MAX = 4096;

/**
 * Element-height budget for the virtual spacer (§4.3), below Firefox's ~1.78e7 and
 * Chromium/WebKit's ~3.3e7 element size ceilings. With it: maxLines =
 * min(`VIRTUAL_MAX_LINES`, floor(VIRTUAL_MAX_PX / rowH)).
 */
export const VIRTUAL_MAX_PX = 15_000_000;

/**
 * Hard line-count ceiling for the virtual view (§4.3): maxLines =
 * min(500_000, floor(VIRTUAL_MAX_PX / rowH)) — ~769k lines at 19.5 px, ~256k at 58.5 px
 * (300% font scale). Beyond it the tail shows the "loaded N lines, view capped" notice;
 * copy and find still cover ALL loaded text.
 */
export const VIRTUAL_MAX_LINES = 500_000;

/**
 * P5 Worker token budget: `flattenTokens(tree, { maxTokens: 80_000 })` runs INSIDE the
 * worker, and only then is the result encoded into `HighlightSpans` and transferred back
 * (§5.3, 已拍板 ①). Distinct from `highlight.js`'s main-thread `HIGHLIGHT_MAX_TOKENS`
 * (20 000) — until the worker lands (and whenever it is unavailable) the virtual view
 * keeps the ORIGINAL gate (100 KiB / 3000 lines / 20k tokens, §5.1).
 */
export const HIGHLIGHT_WORKER_MAX_TOKENS = 80_000;

/**
 * A line whose `displayLine` would exceed this many parts renders as PLAIN text instead
 * (§5.3): the check happens on the main thread and only affects rendering, never the
 * tokenizing cost.
 */
export const PREVIEW_VLINE_MAX_PARTS = 1000;

/**
 * Find hit cap (§4.6): hits are the greedy non-overlapping sequence (hₖ₊₁ =
 * indexOf(q, hₖ + |q|)); collection stops here, followed by exactly ONE "more" probe at
 * h₁₀₀₀₀ + |q| (UI shows `10000+`). Once full, incremental appends skip re-searching and
 * only redo the probe — the first 10 000 greedy hits satisfy the prefix property, so the
 * capped result always equals the full search's prefix.
 */
export const FIND_MAX = 10_000;
