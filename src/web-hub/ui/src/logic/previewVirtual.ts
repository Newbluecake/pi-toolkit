/**
 * Preview virtual-scroll geometry & renderer selection (preview-perf plan r3 §4.1/§4.3/§4.5,
 * P1) — pure functions consumed by P2's `VirtualCode`/`VirtualBlock` and P3's wiring. No
 * DOM, no Vue; every measurement (rowH, viewportH, scrollTop) is INJECTED by the caller.
 *
 *  - `chooseSourceRenderer` — the §4.1 decision table. With the build-time kill switch off
 *    (`virtualEnabled === false`, first check by r3 ruling) it delegates to the r0 selection
 *    EXACTLY (legacy / `NumberedCode` ≤8000 / >8000 degrade + `linesTooMany` note / streaming
 *    per-segment `CodeLines` with the cumulative 8000 degrade owned by P3's `syncLineSegs`);
 *    with it on, >600-line non-stream and ALL line-numbered streams go virtual, and the
 *    per-window full view (§4.7) plus line-numbers-off keep the legacy single-text DOM.
 *  - `computeWindow` — the contiguous mounted BLOCK range for a scroll position: visible
 *    lines ± `overscan` viewport-heights, quantized to `PREVIEW_VIRTUAL_BLOCK_LINES`-line
 *    blocks, with half-block hysteresis against the previously mounted range (§4.5: an edge
 *    shrinks only once the target has moved half a block past it; growth is immediate), and
 *    the selection grow-only retention capped at `VIRTUAL_SELECTION_MAX_LINES` lines (64
 *    blocks) — past the cap the NORMAL window returns and `capped` flags the §4.5 notice.
 *  - `maxLines` — `min(VIRTUAL_MAX_LINES, floor(VIRTUAL_MAX_PX / rowH))` (§4.3).
 *  - `reanchor` — row-height-change scroll anchoring by logical line + intra-line fraction
 *    (§4.3 行高重测时的滚动锚点).
 */

import { PREVIEW_NUMBERED_LINES_MAX } from "@logic/previewLines.js";
import {
  PREVIEW_VIRTUAL_BLOCK_LINES,
  PREVIEW_VIRTUAL_ENABLED,
  PREVIEW_VIRTUAL_MIN_LINES,
  VIRTUAL_MAX_LINES,
  VIRTUAL_MAX_PX,
  VIRTUAL_SELECTION_MAX_LINES,
} from "@logic/previewVirtualTypes.js";

/** Half a block, in lines — the §4.5 hysteresis band at each window edge. */
const HALF_BLOCK = PREVIEW_VIRTUAL_BLOCK_LINES / 2;

/** Selection cap in whole blocks (2048 lines = 64 × 32; pinned by the P1a test). */
const MAX_SELECTION_BLOCKS = VIRTUAL_SELECTION_MAX_LINES / PREVIEW_VIRTUAL_BLOCK_LINES;

/** Which renderer a source view uses (§4.1). The string is the whole discriminant. */
export type SourceRendererChoice =
  | "legacy" /* line numbers off / full view: single-text body or legacy segments */
  | "numbered" /* full-DOM per-line view: NumberedCode → CodeLines */
  | "numbered-capped" /* r0 >8000 degrade: HighlightedCode + preview.linesTooMany note */
  | "stream-lines" /* r0 stream: one CodeLines per segment (8000 cumulative degrade per-seg) */
  | "virtual"; /* VirtualCode → VirtualBlock */

export interface ChooseRendererInput {
  /** The user's line-numbers toggle (`pwh_linenumbers`, default on). */
  readonly lineNumbers: boolean;
  /** Per-window full-view escape (§4.7) — renders exactly like line numbers off. */
  readonly fullView: boolean;
  /** true for a streaming source view. */
  readonly stream: boolean;
  /** `countCodeLines(shownSource)` (non-stream); streams decide without it. */
  readonly lineCount: number;
}

/**
 * The §4.1 table, kill switch first (r3 §R2 #4). `options.virtualEnabled` defaults to the
 * build-time `PREVIEW_VIRTUAL_ENABLED` — tests inject `false` to keep the r0 branches
 * pinned; P3's production call site reads the constant.
 */
export function chooseSourceRenderer(
  input: ChooseRendererInput,
  options?: { readonly virtualEnabled?: boolean },
): SourceRendererChoice {
  const virtualEnabled = options?.virtualEnabled ?? PREVIEW_VIRTUAL_ENABLED;
  if (!virtualEnabled) {
    // r0 selection, byte-identical: the three branches P3 must keep alive (§4.1 row 1).
    if (!input.lineNumbers || input.fullView) return "legacy";
    if (input.stream) return "stream-lines";
    return input.lineCount > PREVIEW_NUMBERED_LINES_MAX ? "numbered-capped" : "numbered";
  }
  if (!input.lineNumbers || input.fullView) return "legacy";
  if (input.stream) return "virtual"; // streams are ALWAYS virtual (no mid-stream switch)
  return input.lineCount > PREVIEW_VIRTUAL_MIN_LINES ? "virtual" : "numbered";
}

/** An inclusive block-index range (`hi === lo − 1` marks the empty window). */
export interface BlockRange {
  readonly lo: number;
  readonly hi: number;
}

export interface ComputeWindowInput {
  readonly scrollTop: number;
  readonly viewportH: number;
  readonly rowH: number;
  readonly lineCount: number;
  /** Overscan margin in viewport-heights (§4.5: 1, or 1.5 on coarse pointers). */
  readonly overscan: number;
  /** The previously mounted block range, if any (drives hysteresis and retention). */
  readonly retain: Readonly<BlockRange> | null;
  /** §4.5: a native selection is active — the window only grows over `retain`. */
  readonly selectionActive?: boolean;
}

export interface ComputedWindow extends BlockRange {
  /** true when selection retention hit the 2048-line cap and the NORMAL window returned. */
  readonly capped: boolean;
}

const EMPTY_WINDOW: ComputedWindow = { lo: 0, hi: -1, capped: false };

/** `retain` normalized into the live block range (null when empty/unusable). */
function clampRetain(retain: Readonly<BlockRange> | null, maxBlock: number): BlockRange | null {
  if (retain === null) return null;
  const lo = Math.max(0, Math.min(Math.floor(retain.lo), maxBlock));
  const hi = Math.max(0, Math.min(Math.floor(retain.hi), maxBlock));
  return hi >= lo ? { lo, hi } : null;
}

/**
 * The target (retain-free) window: visible lines ± overscan screens, clamped to the text
 * and quantized to blocks. Shared by the plain path and the post-cap fallback.
 */
function targetWindow(input: ComputeWindowInput, maxBlock: number): BlockRange {
  const first = Math.floor(Math.max(0, input.scrollTop) / input.rowH);
  const last = Math.ceil((Math.max(0, input.scrollTop) + input.viewportH) / input.rowH) - 1;
  const margin = Math.max(0, Math.ceil((input.overscan * input.viewportH) / input.rowH));
  const tLo = Math.max(0, first - margin);
  const tHi = Math.min(input.lineCount - 1, last + margin);
  return {
    lo: Math.max(0, Math.min(Math.floor(tLo / PREVIEW_VIRTUAL_BLOCK_LINES), maxBlock)),
    hi: Math.max(0, Math.min(Math.floor(tHi / PREVIEW_VIRTUAL_BLOCK_LINES), maxBlock)),
  };
}

/**
 * The mounted block range (§4.5). Inclusive `lo..hi`; `{lo: 0, hi: -1}` for an empty body
 * or unusable geometry. Half-block hysteresis: a previously mounted edge stays mounted while
 * it lies within `PREVIEW_VIRTUAL_BLOCK_LINES + HALF_BLOCK` lines of the target edge —
 * shrinking lags half a block behind the target, growth is immediate, so a small scroll
 * jitter at a block boundary cannot unmount and re-mount the same block. While
 * `selectionActive` the window instead only GROWS over `retain` (contiguous), capped at 64
 * blocks; hitting the cap returns the normal window with `capped: true` (the §4.5 status
 * notice fires, the selection promise ends).
 */
export function computeWindow(input: ComputeWindowInput): ComputedWindow {
  const B = PREVIEW_VIRTUAL_BLOCK_LINES;
  if (
    input.lineCount <= 0 ||
    !(input.rowH > 0) ||
    !Number.isFinite(input.rowH) ||
    !(input.viewportH > 0) ||
    !Number.isFinite(input.viewportH) ||
    !Number.isFinite(input.scrollTop)
  ) {
    return EMPTY_WINDOW;
  }
  const maxBlock = Math.floor((input.lineCount - 1) / B);
  const retain = clampRetain(input.retain, maxBlock);
  const selection = input.selectionActive === true && retain !== null;
  if (retain === null) return { ...targetWindow(input, maxBlock), capped: false };

  // Work in LINES so the hysteresis band is exact (半块 = 16 lines), quantize to blocks once.
  const first = Math.floor(Math.max(0, input.scrollTop) / input.rowH);
  const last = Math.ceil((Math.max(0, input.scrollTop) + input.viewportH) / input.rowH) - 1;
  const margin = Math.max(0, Math.ceil((input.overscan * input.viewportH) / input.rowH));
  let tLo = first - margin;
  let tHi = Math.min(input.lineCount - 1, last + margin);
  const rLo = retain.lo * B;
  const rHi = (retain.hi + 1) * B - 1;
  if (selection) {
    tLo = Math.min(tLo, rLo); // §4.5 只增不减: grow over the retained range…
    tHi = Math.max(tHi, rHi);
  } else {
    // …otherwise plain half-block hysteresis at each SHRINKING edge (growth is immediate):
    // an old edge survives while the target edge is still within B + 16 lines of it.
    if (rLo < tLo && tLo <= rLo + B + HALF_BLOCK) tLo = rLo;
    if (rHi > tHi && tHi >= rHi - B - HALF_BLOCK) tHi = rHi;
  }
  const lo = Math.max(0, Math.min(Math.floor(Math.max(0, tLo) / B), maxBlock));
  const hi = Math.max(0, Math.min(Math.floor(Math.min(input.lineCount - 1, tHi) / B), maxBlock));
  if (selection && hi - lo + 1 > MAX_SELECTION_BLOCKS) {
    return { ...targetWindow(input, maxBlock), capped: true }; // past 2048 lines ⇒ normal window
  }
  return { lo, hi, capped: false };
}

/**
 * The virtual view's line-count ceiling (§4.3): `min(500_000, floor(15e6 px / rowH))`.
 * Unusable rowH (not measured yet / degenerate) falls back to the line-count bound — the
 * px guard simply cannot be evaluated then; P2/P3 substitute their measured fallback first.
 */
export function maxLines(rowH: number): number {
  if (!Number.isFinite(rowH) || rowH <= 0) return VIRTUAL_MAX_LINES;
  return Math.min(VIRTUAL_MAX_LINES, Math.floor(VIRTUAL_MAX_PX / rowH));
}

/**
 * Row-height-change scroll anchoring (§4.3): the logical line under the scroll offset and
 * its intra-line fraction are re-projected onto the NEW row height, so a font-size change
 * keeps the same logical line at the viewport top. Unusable heights pass `scrollTop`
 * through (clamped ≥ 0) — the next RO callback re-anchors with real numbers.
 */
export function reanchor(scrollTop: number, oldH: number, newH: number): number {
  if (!Number.isFinite(scrollTop)) return 0;
  if (!(oldH > 0) || !Number.isFinite(oldH) || !(newH > 0) || !Number.isFinite(newH)) {
    return Math.max(0, scrollTop);
  }
  const st = Math.max(0, scrollTop);
  const anchorLine = Math.floor(st / oldH);
  const frac = (st - anchorLine * oldH) / oldH;
  return Math.max(0, (anchorLine + frac) * newH);
}
