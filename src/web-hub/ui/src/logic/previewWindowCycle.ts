/**
 * web-hub-preview-windows plan r2 §5.6 (W3): the DOM-free half of the conversation ⇄ window
 * keyboard switcher (`Ctrl+` / `Ctrl+Shift+``, user 拍板 3) — an Alt+Tab-style MRU ring.
 *
 * The ring is `["page", ...order reversed]`: the conversation first, then the ACTIVE window
 * (the manager's `order` tail), then progressively older ones. The composable
 * (`composables/usePreviewWindowCycle.ts`) owns the DOM side (keydown, guards, focus
 * landing); these pure helpers only build and walk the ring, so the "no ping-pong" guarantee
 * is testable in node: the ring is FROZEN for as long as the cycle keeps reusing its
 * snapshot, so `focusWindow` raising a window mid-cycle never rebuilds it — stepping twice
 * from the active window must reach the second-oldest entry, never bounce back.
 */
export type PreviewCycleEntry = "page" | number;

/**
 * Build a fresh ring from the manager's activation `order` (last = active = highest z):
 * `["page", active, next-newest, …, oldest]`. Duplicate ids (a manager defect) are dropped
 * keeping the most-recent occurrence; an empty `order` yields `["page"]` (the composable's
 * no-windows guard means that degenerate ring is never walked).
 */
export function previewCycleRing(order: readonly number[]): readonly PreviewCycleEntry[] {
  const seen = new Set<number>();
  const ring: PreviewCycleEntry[] = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    ring.push(id);
  }
  return ["page", ...ring];
}

/**
 * One step along a ring from `at`: `dir === 1` is `Ctrl+`` (forward), `-1` is
 * `Ctrl+Shift+`` (backward); both wrap around. Returns `null` when `at` is not on the ring —
 * the caller must take a fresh snapshot instead of stepping.
 */
export function previewCycleStep(
  ring: readonly PreviewCycleEntry[],
  at: PreviewCycleEntry,
  dir: 1 | -1,
): PreviewCycleEntry | null {
  const idx = ring.indexOf(at);
  if (idx < 0) return null;
  const n = ring.length;
  if (n === 0) return null;
  return ring[(idx + dir + n) % n] ?? null;
}
