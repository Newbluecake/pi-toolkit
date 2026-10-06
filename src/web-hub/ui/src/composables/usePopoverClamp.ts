/**
 * Desktop-popover viewport clamp (2026-10 widened model/thinking popovers — user 拍板: the
 * pickers may cover other content, but must NEVER overflow the viewport). Two axes:
 *
 * - **Horizontal** (`clampPopoverX`): the panels anchor `left: 0` under their chip, so a chip
 *   near the right edge would push a min(720px) panel past the viewport. We measure the panel
 *   and shift its inline `left` just enough to keep it inside [margin, innerWidth - margin].
 * - **Vertical** (`clampPopoverY`): the panels open ABOVE the chip (`bottom: calc(100% + 6px)`),
 *   so a chip near the TOP of a short page (new session, phone browser at desktop width) runs
 *   the panel's top off-screen — worse once the search input's autofocus opens the mobile
 *   keyboard and shrinks the visual viewport. We measure the space above/below the chip
 *   (window.visualViewport height/offsetTop when available, else innerHeight), open below the
 *   chip when above doesn't fit AND below has more room, and cap `max-height` at
 *   min(70vh, space in the chosen direction) — the `.model-list` flex child scrolls
 *   internally, so the search head and the footer stay visible.
 *
 * Inline styles are cleared first so a re-open re-measures from the CSS anchor. A panel/chip
 * that already fits above keeps the CSS position; happy-dom's zero rects ⇒ no-op, so
 * layout-less tests are unaffected. While open, window resize + visualViewport resize/scroll
 * re-run both clamps (frame-cadence leading/trailing throttle via setTimeout —
 * requestAnimationFrame is banned repo-wide, renderGate.ts owns scheduling, plan §3.5), and
 * the watch source folds in the form-factor flag so crossing the ≤640px boundary re-clamps
 * the re-created panel.
 */
import { nextTick, onScopeDispose, watch, type Ref } from "vue";

/** Minimal gutter between a clamped popover and the viewport edge (px). */
export const POPOVER_VIEWPORT_MARGIN = 8;

/** CSS offset between the chip and its panel (`bottom: calc(100% + 6px)` in models.css). */
export const POPOVER_PANEL_GAP = 6;

/** Height cap as a fraction of the viewport (mirrors the CSS `max-height: 70vh`). */
export const POPOVER_MAX_VH_RATIO = 0.7;

export function clampPopoverX(el: HTMLElement, margin: number = POPOVER_VIEWPORT_MARGIN): void {
  el.style.removeProperty("left");
  const rect = el.getBoundingClientRect();
  let shift = 0;
  if (rect.right > window.innerWidth - margin) shift = window.innerWidth - margin - rect.right;
  if (rect.left + shift < margin) shift = margin - rect.left;
  if (shift !== 0) el.style.left = `${Math.round(shift)}px`;
}

/**
 * Fit the panel vertically against the viewport: keep it above the chip when that fits (or
 * above simply has more room), otherwise flip it below the chip (inline `top` + `bottom:
 * auto`), and always cap its inline `max-height` at min(70vh, available space). A zero chip
 * rect (happy-dom, detached nodes) is a no-op: the inline overrides just cleared stay clear,
 * i.e. the CSS anchor applies.
 */
export function clampPopoverY(el: HTMLElement, anchor: HTMLElement, margin: number = POPOVER_VIEWPORT_MARGIN): void {
  el.style.removeProperty("top");
  el.style.removeProperty("bottom");
  el.style.removeProperty("max-height");
  const chip = anchor.getBoundingClientRect();
  if (chip.width === 0 && chip.height === 0) return; // happy-dom zero rects ⇒ no-op
  const vv = window.visualViewport;
  const vTop = vv !== null && vv !== undefined ? vv.offsetTop : 0;
  const vHeight = vv !== null && vv !== undefined ? vv.height : window.innerHeight;
  const availAbove = Math.max(0, chip.top - vTop - margin - POPOVER_PANEL_GAP);
  const availBelow = Math.max(0, vTop + vHeight - chip.bottom - margin - POPOVER_PANEL_GAP);
  const needed = el.getBoundingClientRect().height;
  // Open above if it fits or above has more space; otherwise flip below.
  const below = availAbove < needed && availBelow > availAbove;
  const avail = below ? availBelow : availAbove;
  if (below) {
    el.style.top = `calc(100% + ${POPOVER_PANEL_GAP}px)`;
    el.style.bottom = "auto";
  }
  el.style.maxHeight = `${Math.floor(Math.min(POPOVER_MAX_VH_RATIO * vHeight, avail))}px`;
}

/** Template refs may resolve to a `<component :is>` instance — unwrap `$el`. */
function asElement(raw: unknown): HTMLElement | null {
  if (raw instanceof HTMLElement) return raw;
  const maybe = (raw as { $el?: unknown } | null | undefined)?.$el;
  return maybe instanceof HTMLElement ? maybe : null;
}

/**
 * Watch a popover's open flag and clamp its panel into the viewport on open, then keep
 * re-clamping while it stays open (window resize, visualViewport resize/scroll — the latter
 * catches the mobile keyboard shrinking the viewport). Only applies to the desktop form
 * factor (`desktop()` false ⇒ the ≤640px Teleport'd sheet, full-width by construction, needs
 * nothing); the watch source folds `desktop()` in, so crossing the narrow boundary while open
 * drops the listeners (→ sheet) or clamps the re-created desktop panel (→ popover).
 */
export function usePopoverClamp(
  open: Ref<boolean>,
  desktop: () => boolean,
  panel: () => unknown,
  anchor?: () => unknown,
): void {
  let listening = false;
  let lastClamp = -Infinity;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;

  async function apply(): Promise<void> {
    await nextTick();
    const el = asElement(panel());
    if (el === null) return;
    clampPopoverX(el);
    const a = anchor !== undefined ? asElement(anchor()) : null;
    if (a !== null) clampPopoverY(el, a);
  }

  function runClamp(): void {
    lastClamp = Date.now();
    if (open.value && desktop()) void apply();
  }

  /** Frame-cadence throttle (rAF is banned repo-wide): leading edge runs immediately when the
   * last clamp is ≥16ms ago, otherwise a single trailing-edge timer coalesces the burst. */
  function schedule(): void {
    if (trailingTimer !== null) return;
    const elapsed = Date.now() - lastClamp;
    if (elapsed >= 16) {
      runClamp();
      return;
    }
    trailingTimer = setTimeout(() => {
      trailingTimer = null;
      runClamp();
    }, 16 - elapsed);
  }

  function clearTrailing(): void {
    if (trailingTimer !== null) {
      clearTimeout(trailingTimer);
      trailingTimer = null;
    }
  }

  function setListening(on: boolean): void {
    if (on === listening) return;
    listening = on;
    const fn = on ? "addEventListener" : "removeEventListener";
    window[fn]("resize", schedule);
    const vv = window.visualViewport;
    vv?.[fn]("resize", schedule);
    vv?.[fn]("scroll", schedule);
    if (!on) clearTrailing();
  }

  watch(
    () => open.value && desktop(),
    (on) => {
      if (!on) {
        setListening(false);
        return;
      }
      void apply();
      setListening(true);
    },
  );

  onScopeDispose(() => {
    setListening(false);
  });
}
