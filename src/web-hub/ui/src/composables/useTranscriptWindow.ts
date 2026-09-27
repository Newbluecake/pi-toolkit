/**
 * Client-side transcript windowing (vue-plan.md v2.1 §3.6, §5.2 — P1). Pure math only — no DOM,
 * no scroll handling (that's `useFollowScroll.ts`) — so it's trivially property-testable: given
 * the total item count and a window `start`, decide which slice actually mounts, capped at
 * `TRANSCRIPT_CAP` (300) mounted `.tx-item`s regardless of how far back the user has scrolled.
 * The hub already caps its snapshot at `DEFAULT_TAIL_ENTRIES` (400, unchanged wire protocol) —
 * this is the second, purely client-side cap that keeps a long-lived mobile tab's DOM bounded.
 */
import { computed, ref, type ComputedRef, type Ref } from "vue";

/** Plan §0.3: mobile ≤480px gets an 80-item default window, everything else 200. */
export const MOBILE_DEFAULT_WINDOW = 80;
export const DESKTOP_DEFAULT_WINDOW = 200;

/** Hard cap on mounted `.tx-item`s regardless of viewport (plan §0.2 "对话流窗口化上限 300"). */
export const TRANSCRIPT_CAP = 300;

export interface ComputeWindowInput {
  /** Total number of items currently available (`agent.items.length` plus any live/streaming tail). */
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
 * @param len live total item count (`agent.items.length` [+1 for an in-flight streaming message]).
 * @param isMobile `matchMedia("(max-width: 480px)").matches`, e.g. from `useMedia.ts`.
 */
export function useTranscriptWindow(
  len: Ref<number>,
  isMobile: Ref<boolean>,
  cap: number = TRANSCRIPT_CAP,
): TranscriptWindowHandle {
  const start = ref(defaultWindowStart(len.value, defaultWindowSize(isMobile.value))) as Ref<number>;
  const window = computed(() => computeWindow({ len: len.value, start: start.value, cap }));
  function showEarlier(pageSize?: number): void {
    start.value = revealEarlier(start.value, pageSize ?? defaultWindowSize(isMobile.value));
  }
  function resetToLatest(): void {
    start.value = defaultWindowStart(len.value, defaultWindowSize(isMobile.value));
  }
  return { start, window, showEarlier, resetToLatest };
}
