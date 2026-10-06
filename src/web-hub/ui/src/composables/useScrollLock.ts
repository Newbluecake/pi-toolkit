/**
 * Shared body scroll lock (verify:model-switch-M3b 打回项 — the lock must be COMPOSABLE).
 * `PickerSheet.vue` and `PreviewHost.vue` both lock `document.body.style.overflow` while
 * their overlay is open; two independent save/restore implementations stack badly (an outer
 * overlay unmounting first restores the pre-hidden value and unlocks the page while the
 * inner overlay is still open).
 *
 * This module reference-counts instead: the FIRST `acquireBodyScrollLock()` saves the
 * original overflow and sets `hidden`; only the LAST release restores it. Each returned
 * release function is idempotent (a double release never drives the count negative or
 * restores early). Module-level state is acceptable here — this is the browser single-page
 * UI, not a pi extension (no per-activate rebuild semantics).
 *
 * `resetBodyScrollLock()` is exported for tests only.
 */

let count = 0;
let savedOverflow: string | null = null;

/**
 * Acquire one scroll-lock hold. Returns an idempotent release function; the page's original
 * `body.style.overflow` is restored exactly when the LAST outstanding hold is released —
 * regardless of acquisition/release order across stacked overlays.
 */
export function acquireBodyScrollLock(): () => void {
  if (count === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  count += 1;
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    count -= 1;
    if (count === 0 && savedOverflow !== null) {
      document.body.style.overflow = savedOverflow;
      savedOverflow = null;
    }
  };
}

/** Test-only: drop all outstanding holds and restore the saved overflow (if any). */
export function resetBodyScrollLock(): void {
  if (savedOverflow !== null) {
    document.body.style.overflow = savedOverflow;
    savedOverflow = null;
  }
  count = 0;
}
