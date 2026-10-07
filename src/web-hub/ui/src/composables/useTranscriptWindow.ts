/**
 * Client-side transcript windowing (vue-plan.md v2.1 §3.6, §5.2 — P1). Pure math only — no DOM,
 * no scroll handling (that's `useFollowScroll.ts`) — so it's trivially property-testable: given
 * the total ENTRY count (`buildTxEntries(agent).entries.length` — E1-2's single coordinate
 * system, docs/dev/web-hub-session-switch/plan.md §1.4) and a window `start`, decide which slice
 * actually mounts, capped at `TRANSCRIPT_CAP` (300) mounted `.tx-item`s regardless of how far
 * back the user has scrolled. The hub already caps its snapshot at `DEFAULT_TAIL_ENTRIES` (400,
 * unchanged wire protocol) — this is the second, purely client-side cap that keeps a long-lived
 * mobile tab's DOM bounded.
 */
import { computed, ref, type ComputedRef, type Ref } from "vue";

/** Plan §0.3: mobile ≤480px gets an 80-item default window, everything else 200. */
export const MOBILE_DEFAULT_WINDOW = 80;
export const DESKTOP_DEFAULT_WINDOW = 200;

/** Hard cap on mounted `.tx-item`s regardless of viewport (plan §0.2 "对话流窗口化上限 300"). */
export const TRANSCRIPT_CAP = 300;

export interface ComputeWindowInput {
  /** Total number of entries currently available (`buildTxEntries(agent).entries.length`). */
  readonly len: number;
  /** Current window start index (0-based, oldest-first); clamped into `[0, len]`. */
  readonly start: number;
  /** Max number of items allowed to mount at once. */
  readonly cap: number;
}

export interface ComputeWindowResult {
  /** Clamped, final start index. */
  readonly start: number;
  /** Exclusive end index — `len` unless the tail had to shrink to respect `cap`. */
  readonly end: number;
  /** Items above `start` (the "N earlier hidden · Show" affordance). */
  readonly hiddenBefore: number;
  /** Items below `end` (the "N newer hidden · Jump to latest" affordance — only nonzero once
   * revealing older items pushed the tail out past `cap`). */
  readonly hiddenAfter: number;
}

/**
 * Decide the mounted `[start, end)` slice. When the caller has revealed enough older items that
 * `end - start` would exceed `cap`, the *tail* shrinks (anchored on the just-revealed `start`) —
 * never the head, so "Show N earlier" always actually reveals them.
 */
export function computeWindow(input: ComputeWindowInput): ComputeWindowResult {
  const len = Math.max(0, Math.floor(input.len));
  const cap = Math.max(1, Math.floor(input.cap));
  const start = Math.min(Math.max(0, Math.floor(input.start)), len);
  const end = Math.min(len, start + cap);
  return { start, end, hiddenBefore: start, hiddenAfter: len - end };
}

/** Initial window start for a freshly loaded/selected agent: the last `defaultSize` items. */
export function defaultWindowStart(len: number, defaultSize: number): number {
  return Math.max(0, Math.floor(len) - Math.floor(defaultSize));
}

/** "Show N earlier" — reveal `pageSize` more items above the current window, never past 0. */
export function revealEarlier(currentStart: number, pageSize: number): number {
  return Math.max(0, Math.floor(currentStart) - Math.floor(pageSize));
}

/**
 * Reposition the window start after a load-older page landed (session-switch plan §1.4
 * E1-2): prefer re-anchoring on the KEY of the entry that was the window's first mounted row
 * when paging started — the page may fold existing entries (an orphan `toolResult` pairs up
 * with the just-arrived `toolCall`), so a plain length-delta shift no longer keeps the same
 * entries mounted. Falls back to the delta shift when the key itself was folded away.
 */
export function repositionAfterPage(
  start: number,
  firstKey: string | undefined,
  entries: ReadonlyArray<{ readonly key: string }>,
  lenAtPagingStart: number,
): number {
  if (firstKey !== undefined) {
    const idx = entries.findIndex((e) => e.key === firstKey);
    if (idx >= 0) return idx;
  }
  const delta = entries.length - lenAtPagingStart;
  return delta > 0 ? start + delta : start;
}

/** `matchMedia("(max-width: 480px)")` ⇒ the mobile default, else the desktop one. */
export function defaultWindowSize(isMobile: boolean): number {
  return isMobile ? MOBILE_DEFAULT_WINDOW : DESKTOP_DEFAULT_WINDOW;
}

// ---------------------------------------------------------------------------
// stateful composable (thin reactive wrapper over the pure functions above)
// ---------------------------------------------------------------------------

export interface TranscriptWindowHandle {
  /** Current window start index (oldest-first). Mutate directly, or via `showEarlier`/`resetToLatest`. */
  readonly start: Ref<number>;
  readonly window: ComputedRef<ComputeWindowResult>;
  /** "N earlier hidden · Show": reveal `pageSize` (default: the viewport's own default window size) more. */
  showEarlier(pageSize?: number): void;
  /** New agent selected / "Jump to latest" clicked: snap back to the last default-size window. */
  resetToLatest(): void;
}

/**
 * @param len live total entry count (`buildTxEntries(agent).entries.length`, E1-2's single
 * coordinate system — NOT `items.length + streaming + tools`).
 * @param isMobile `matchMedia("(max-width: 480px)").matches`, e.g. from `useMedia.ts`.
 * @param initialStart restore-time start (E1-4's `restoreStart`); omitted ⇒ the default tail
 * window. Used as-is (the `window` computed clamps it into `[0, len]`).
 */
export function useTranscriptWindow(
  len: Ref<number>,
  isMobile: Ref<boolean>,
  cap: number = TRANSCRIPT_CAP,
  initialStart?: number,
): TranscriptWindowHandle {
  const start = ref(initialStart ?? defaultWindowStart(len.value, defaultWindowSize(isMobile.value))) as Ref<number>;
  const window = computed(() => computeWindow({ len: len.value, start: start.value, cap }));
  function showEarlier(pageSize?: number): void {
    start.value = revealEarlier(start.value, pageSize ?? defaultWindowSize(isMobile.value));
  }
  function resetToLatest(): void {
    start.value = defaultWindowStart(len.value, defaultWindowSize(isMobile.value));
  }
  return { start, window, showEarlier, resetToLatest };
}
