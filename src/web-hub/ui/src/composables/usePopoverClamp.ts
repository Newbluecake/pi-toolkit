/**
 * Desktop-popover viewport clamp (2026-10 widened model/thinking popovers — user 拍板: the
 * pickers may cover other content, but must NEVER overflow the viewport). The panels anchor
 * `left: 0` under their chip, so a chip near the right edge would push a min(720px) panel
 * past the viewport. On open we measure the panel and shift its inline `left` just enough to
 * keep it inside [margin, innerWidth - margin]; the inline style is cleared first so a
 * re-open re-measures from the CSS anchor. A panel that already fits is left untouched
 * (happy-dom's zero rects ⇒ 0 shift, so layout-less tests are unaffected).
 */
import { nextTick, watch, type Ref } from "vue";

/** Minimal gutter between a clamped popover and the viewport edge (px). */
export const POPOVER_VIEWPORT_MARGIN = 8;

export function clampPopoverX(el: HTMLElement, margin: number = POPOVER_VIEWPORT_MARGIN): void {
  el.style.removeProperty("left");
  const rect = el.getBoundingClientRect();
  let shift = 0;
  if (rect.right > window.innerWidth - margin) shift = window.innerWidth - margin - rect.right;
  if (rect.left + shift < margin) shift = margin - rect.left;
  if (shift !== 0) el.style.left = `${Math.round(shift)}px`;
}

/**
 * Watch a popover's open flag and clamp its panel into the viewport on open. Only applies to
 * the desktop form factor (`desktop()` false ⇒ the ≤640px Teleport'd sheet, full-width by
 * construction, needs nothing). `panel()` may resolve to a component instance (a
 * `<component :is>` template ref), so `$el` is unwrapped.
 */
export function usePopoverClamp(open: Ref<boolean>, desktop: () => boolean, panel: () => unknown): void {
  watch(open, async (v) => {
    if (!v || !desktop()) return;
    await nextTick();
    const raw = panel();
    const el = raw instanceof HTMLElement ? raw : ((raw as { $el?: unknown } | null)?.$el ?? null);
    if (el instanceof HTMLElement) clampPopoverX(el);
  });
}
