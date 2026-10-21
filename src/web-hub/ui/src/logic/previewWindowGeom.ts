/**
 * web-hub-preview-windows plan r2 §7.3 (W1): PURE window geometry for the desktop modeless
 * preview windows — constraint clamping (P1–P6), the default placement, cascade offsets and
 * per-axis resize. No DOM, no Vue, no listeners, no rAF (source-scan): every function is a
 * total mapping `(rect, viewportBox) → rect` and never throws, so W2's gesture controller
 * (`usePreviewWindowLayout`) only ever moves pointer deltas through here.
 *
 * Viewport box: `vp = {vw, vh, top}` — `top` is the topbar's bottom edge (ask-float's
 * `topOffset()` measures it at the call site). Derived once per call:
 * - `AW = max(0, vw − 2·EDGE)`, `AH = max(0, vh − top − 2·EDGE)` (the usable box);
 * - effective minimum `mw = min(MIN_W, AW)`, `mh = min(MIN_H, AH)` — on a short viewport the
 *   minimum DEGRADES to the usable height instead of contradicting P3 (评审 #9).
 *
 * Constraint priorities (normative table, high → low):
 *   P1  numbers are finite — any NaN/Infinity falls back to `defaultRect(vp)`
 *   P2  `w ≥ mw`, `h ≥ mh`
 *   P3  `w ≤ AW`, `h ≤ AH`
 *   P4  title bar reachable — `x ∈ [TITLE_KEEP_X − w, vw − TITLE_KEEP_X]`,
 *       `y ∈ [top, vh − TITLE_H]`
 *   P5  the dragged edge stays inside the usable box (resize/move only)
 *   P6  the opposite edge stays fixed (resize only; only a P4 translation may move it)
 *
 * `clampRect` is idempotent (`clampRect(clampRect(r)) === clampRect(r)`), which the property
 * tests lean on; `resizeRect` is exactly "per-axis P2/P5/P6 clamping, then clampRect".
 */

/** Never narrower than this (unless the viewport itself is smaller — P2 vs P3 resolution). */
export const MIN_W = 360;
/** Never shorter than this (same degradation rule as `MIN_W`). */
export const MIN_H = 240;
/** The margin a window's DRAGGED edge must keep from the viewport sides (P5). */
export const EDGE = 8;
/** At least this much of the title bar stays horizontally reachable (P4). */
export const TITLE_KEEP_X = 96;
/** The title bar's height — the vertical P4 keep-zone. */
export const TITLE_H = 48;
/** The cascade step (§7.3 cascadeRect candidates). */
export const CASCADE = 32;
/** Two window origins closer than this on BOTH axes count as "the same slot". */
export const CASCADE_MIN_SEP = 16;
/** The resize hot-zone half-width (W2's gesture controller reads this; coarse pointers 12). */
export const RZ_EDGE = 6;
/** The resize hot-zone half-width for coarse (touch) pointers. */
export const RZ_EDGE_COARSE = 12;

export interface PreviewRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** `vw`/`vh` are `window.innerWidth/innerHeight`; `top` is the topbar's bottom edge. */
export interface PreviewViewportBox {
  readonly vw: number;
  readonly vh: number;
  readonly top: number;
}

/** The eight resize directions (W2's `.pw-rz[data-dir]` hot zones). */
export type PreviewResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface DerivedBox {
  readonly aw: number;
  readonly ah: number;
  readonly mw: number;
  readonly mh: number;
}

function boxOf(vp: PreviewViewportBox): DerivedBox {
  const aw = Math.max(0, vp.vw - 2 * EDGE);
  const ah = Math.max(0, vp.vh - vp.top - 2 * EDGE);
  return { aw, ah, mw: Math.min(MIN_W, aw), mh: Math.min(MIN_H, ah) };
}

function finiteRect(r: PreviewRect): boolean {
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h);
}

/** `h`'s raw default is `min(0.85·vh, 900)`; P2's effective minimum always wins over the raw
 * formula (a short viewport must not produce a contradiction, 评审 #9). */
export function defaultRect(vp: PreviewViewportBox): PreviewRect {
  const b = boxOf(vp);
  const w = Math.min(Math.max(Math.min(960, b.aw), b.mw), b.aw);
  const h = Math.min(Math.max(Math.min(0.85 * vp.vh, 900, b.ah), b.mh), b.ah);
  // centered inside the usable box — a fresh window is always fully inside it
  return { x: EDGE + (b.aw - w) / 2, y: vp.top + EDGE + (b.ah - h) / 2, w, h };
}

/**
 * P1 → P3 size clamping followed by the P4 translation (the ONLY place a clamped rect moves).
 * A non-finite input falls back to `defaultRect(vp)` (P1).
 */
export function clampRect(r: PreviewRect, vp: PreviewViewportBox): PreviewRect {
  if (!finiteRect(r)) return defaultRect(vp);
  const b = boxOf(vp);
  const w = Math.min(Math.max(r.w, b.mw), b.aw);
  const h = Math.min(Math.max(r.h, b.mh), b.ah);
  // P4: keep (at least) TITLE_KEEP_X of the title bar horizontally reachable and the whole
  // title bar vertically reachable. `min(max(…))` picks the upper bound when the interval is
  // degenerate (only reachable on absurdly tiny viewports).
  const x = Math.min(Math.max(r.x, TITLE_KEEP_X - w), vp.vw - TITLE_KEEP_X);
  const y = Math.min(Math.max(r.y, vp.top), vp.vh - TITLE_H);
  return { x, y, w, h };
}

/** Translate by the gesture delta, then clamp (P5 rides through the P4 translation). */
export function moveRect(start: PreviewRect, dx: number, dy: number, vp: PreviewViewportBox): PreviewRect {
  return clampRect({ x: start.x + dx, y: start.y + dy, w: start.w, h: start.h }, vp);
}

/**
 * Per-axis resize (§7.3's normative rules), then the final `clampRect`.
 *
 * Dragging a MAX edge (right/bottom): the desired edge is `s.end + d`; `lo = s.start +
 * min-size` (P2), `hi = vpEnd − EDGE` (P5) — the desired edge clamps into `[lo, hi]`. (The
 * plan's `min(vpEnd−EDGE, s.start+A)` P3 term is enforced equivalently by the trailing
 * `clampRect`: it shrinks the width while keeping `x`, so only the DRAGGED edge moves.)
 * Dragging a MIN edge (left/top): the desired edge is `s.start + d`; `hi = s.end − min-size`
 * (P2), `lo = min(hi, max(vpStart + EDGE, s.end − A))` (P5 + P3 — the dragged edge may not
 * move so far out that the width would exceed `A`; without this term the trailing P3 size
 * clamp would shove the OPPOSITE edge back inbounds by non-P4 means, violating P6). When P5
 * and P2 conflict (the interval would be empty — a viewport narrower/shorter than the
 * minimum) P2 wins: the window keeps its minimum size and the dragged edge may cross the
 * viewport margin. The opposite edge stays fixed throughout; the trailing `clampRect` is
 * the only step allowed to move it (a mostly-offscreen window resizing back into view).
 */
export function resizeRect(
  start: PreviewRect,
  dir: PreviewResizeDir,
  dx: number,
  dy: number,
  vp: PreviewViewportBox,
): PreviewRect {
  let x = start.x;
  let y = start.y;
  let w = start.w;
  let h = start.h;
  const b = boxOf(vp);
  if (dir.includes("e")) {
    const lo = start.x + b.mw;
    const right = Math.max(Math.min(start.x + start.w + dx, vp.vw - EDGE), lo);
    w = right - start.x;
  }
  if (dir.includes("w")) {
    const end = start.x + start.w;
    const hi = end - b.mw;
    // P5's wall AND P3's `s.end − AW` floor — see the doc comment above (P6 rework #1).
    const lo = Math.min(hi, Math.max(EDGE, end - b.aw));
    const left = Math.min(Math.max(start.x + dx, lo), hi);
    w = end - left;
    x = left;
  }
  if (dir.includes("s")) {
    const lo = start.y + b.mh;
    const bottom = Math.max(Math.min(start.y + start.h + dy, vp.vh - EDGE), lo);
    h = bottom - start.y;
  }
  if (dir.includes("n")) {
    const end = start.y + start.h;
    const hi = end - b.mh;
    // P5's wall AND P3's `s.end − AH` floor — the vertical twin of the `w` branch.
    const lo = Math.min(hi, Math.max(vp.top + EDGE, end - b.ah));
    const top = Math.min(Math.max(start.y + dy, lo), hi);
    h = end - top;
    y = top;
  }
  return clampRect({ x, y, w, h }, vp);
}

/** Fully inside the usable box (P5's box, evaluated for the whole rect). */
function fullyInBox(r: PreviewRect, vp: PreviewViewportBox): boolean {
  const b = boxOf(vp);
  return r.x >= EDGE && r.y >= vp.top + EDGE && r.x + r.w <= vp.vw - EDGE && r.y + r.h <= vp.vh - EDGE;
}

/**
 * The new-window placement (§7.3): size from `clampRect(base)`, then the first candidate
 * position that is fully inside the usable box AND whose top-left corner is separated from
 * every occupied window's top-left by `|dx| ≥ CASCADE_MIN_SEP || |dy| ≥ CASCADE_MIN_SEP`.
 * Candidates: ① `base + k·CASCADE` (k = 1..6, the classic diagonal cascade), then ②
 * `origin + j·CASCADE` (j = 0..6, origin = the usable box's top-left — always fits, overlap
 * accepted as the documented fallback). The result passes through `clampRect`.
 */
export function cascadeRect(base: PreviewRect, vp: PreviewViewportBox, occupied: readonly PreviewRect[]): PreviewRect {
  const b = clampRect(base, vp);
  const origin = { x: EDGE, y: vp.top + EDGE };
  const separated = (px: number, py: number): boolean => {
    for (const o of occupied) {
      if (Math.abs(px - o.x) < CASCADE_MIN_SEP && Math.abs(py - o.y) < CASCADE_MIN_SEP) return false;
    }
    return true;
  };
  const fits = (px: number, py: number): boolean =>
    fullyInBox({ x: px, y: py, w: b.w, h: b.h }, vp) && separated(px, py);
  for (let k = 1; k <= 6; k++) {
    const px = b.x + k * CASCADE;
    const py = b.y + k * CASCADE;
    if (fits(px, py)) return clampRect({ x: px, y: py, w: b.w, h: b.h }, vp);
  }
  for (let j = 0; j <= 6; j++) {
    const px = origin.x + j * CASCADE;
    const py = origin.y + j * CASCADE;
    if (fits(px, py)) return clampRect({ x: px, y: py, w: b.w, h: b.h }, vp);
  }
  return clampRect({ ...origin, w: b.w, h: b.h }, vp); // documented fallback — overlap accepted
}
