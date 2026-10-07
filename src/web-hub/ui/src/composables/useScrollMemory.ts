/**
 * Per-agentKey scroll-position memory for the main-session transcript
 * (docs/dev/web-hub-session-switch/plan.md §1.4 — E1, v1 最小闭环): switching sessions used to
 * always remount at the bottom; this store lets `Transcript.vue` save "where the user was
 * reading" (an anchor entry's identity ids + a pixel offset) on unmount and restore it on the
 * next mount. No DOM here — pure data + pure math, so it is trivially unit-testable; the store
 * lives in memory only (a `Map` under `DashboardView`'s provide, cap 16, insertion-order LRU)
 * and is keyed by agentKey (E1-6): a restore successor's brand-new key simply finds no record
 * and degrades to today's bottom-follow behavior.
 *
 * Anchor identity (E1-1): each transcript entry contributes an id SET — `e:<entryId>` when the
 * backing entry has an id, `k:<messageKey>` when it is a non-custom message with a finite
 * numeric timestamp. A live streamed message only has its `k:` id, the same message replayed
 * from history has both, so a record saved live still restores after the history snapshot
 * replaces the live tail. Ids that appear in MORE than one entry are ambiguous and never usable.
 */
import type { InjectionKey } from "vue";

/** What gets remembered for one agentKey. `anchorIds`/`anchorOffsetPx` are absent when there
 * was nothing anchorable on screen (next mount then just keeps `following:false`, no restore). */
export interface ScrollMemoryRecord {
  readonly following: boolean;
  /** ALL ids of the picked anchor row (any one of them can match on restore). */
  readonly anchorIds?: readonly string[];
  /** `anchorRowTop - viewportTop` in content coordinates (px, may be negative). */
  readonly anchorOffsetPx?: number;
}

export interface ScrollMemory {
  get(key: string): ScrollMemoryRecord | undefined;
  set(key: string, rec: ScrollMemoryRecord): void;
  delete(key: string): void;
  readonly size: number;
}

export const SCROLL_MEMORY_CAP = 16;

/** Insertion-order LRU (MRU at the tail); `get` touches, `set` overwrites AND touches. */
export function createScrollMemory(cap: number = SCROLL_MEMORY_CAP): ScrollMemory {
  const max = Math.max(1, Math.floor(cap));
  const map = new Map<string, ScrollMemoryRecord>();
  return {
    get(key: string): ScrollMemoryRecord | undefined {
      const rec = map.get(key);
      if (rec !== undefined) {
        map.delete(key);
        map.set(key, rec);
      }
      return rec;
    },
    set(key: string, rec: ScrollMemoryRecord): void {
      map.delete(key);
      map.set(key, rec);
      while (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    delete(key: string): void {
      map.delete(key);
    },
    get size(): number {
      return map.size;
    },
  };
}

/** Provided by `DashboardView.vue`, consumed by `AgentDetail.vue` (following 初值) and
 * `Transcript.vue` (only when its `memoryKey` prop is set — the drawer never passes it). */
export const SCROLL_MEMORY: InjectionKey<ScrollMemory> = Symbol("web-hub-scroll-memory");

/**
 * Build `id → entry index` over an anchors array (one id-set per entry, aligned with
 * `TxBuild.entries`). An id that occurs in more than one entry is ambiguous and is excluded —
 * restoring to "one of two identical-looking rows" is worse than degrading to the bottom.
 */
export function buildAnchorIndex(anchors: readonly (readonly string[])[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ids of anchors) {
    for (const id of new Set(ids)) counts.set(id, (counts.get(id) ?? 0) + 1); // per-entry unique
  }
  const out = new Map<string, number>();
  anchors.forEach((ids, i) => {
    for (const id of new Set(ids)) {
      if (counts.get(id) === 1) out.set(id, i);
    }
  });
  return out;
}

/**
 * Locate a saved record's anchor in a built index: ANY of the record's ids hitting is enough;
 * different ids resolving to DIFFERENT indices is ambiguous ⇒ `undefined` (degrade).
 */
export function findAnchor(index: ReadonlyMap<string, number>, ids: readonly string[]): number | undefined {
  let found: number | undefined;
  for (const id of ids) {
    const idx = index.get(id);
    if (idx === undefined) continue;
    if (found === undefined) found = idx;
    else if (found !== idx) return undefined;
  }
  return found;
}

/** A visible row measured in content coordinates (relative to the scroll box's content top). */
export interface ScrollAnchorRow {
  /** UNAMBIGUOUS ids only — the caller filters through `buildAnchorIndex` before calling. */
  readonly ids: readonly string[];
  readonly top: number;
  readonly bottom: number;
}

export interface PickedAnchor {
  readonly ids: readonly string[];
  readonly offsetPx: number;
}

/**
 * Pick the save-time anchor: the first row that is (a) anchorable (`ids` non-empty after the
 * caller's ambiguity filter — a row whose every id is ambiguous contributes no ids), and
 * (b) at least partially below the viewport top (`bottom > viewportTop`). `offsetPx` is the
 * row's top relative to the viewport top and may be negative (the row straddles the top edge).
 */
export function pickAnchor(rows: ReadonlyArray<ScrollAnchorRow>, viewportTop: number): PickedAnchor | undefined {
  for (const row of rows) {
    if (row.ids.length === 0) continue;
    if (row.bottom <= viewportTop) continue;
    return { ids: row.ids, offsetPx: row.top - viewportTop };
  }
  return undefined;
}

/**
 * Restore-time window start (E1-4): if the anchor already sits inside the default tail window,
 * that window IS the restore (no artificial "N newer hidden"); otherwise center the anchor in
 * the window — at least `floor(defaultSize/2)` entries above it, clamped at 0. Either way the
 * anchor index `j` ends up inside `[start, start + defaultSize)`.
 */
export function restoreStart(j: number, len: number, defaultSize: number): number {
  const size = Math.max(1, Math.floor(defaultSize));
  const defaultStart = Math.max(0, Math.floor(len) - size);
  if (j >= defaultStart) return defaultStart;
  return Math.max(0, j - Math.floor(size / 2));
}
