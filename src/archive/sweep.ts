/** Pure fleet auto-archive selection (#59). No clock, persistence or timers. */
import {
  ARCHIVE_ENTRIES_CAP,
  autoArchiveDue,
  isArchived,
  sameItem,
  type ArchiveEntry,
  type ArchiveKind,
  type ArchiveState,
} from "./state.js";

export interface ArchiveCandidate {
  kind: ArchiveKind;
  id: string;
  terminal: boolean;
  settledAt: number;
}

export interface ArchiveSweepPolicy {
  afterMs: number;
  /** 0 removes the count gate (legacy time-only behavior). */
  keepRuns: number;
  keepBash: number;
}

/** Archive entries whose item is no longer in the live candidate lists (evicted from the fleet /
 *  bash recycle). Only these may be dropped to make room: they are invisible in the UI anyway. */
function goneEntries(state: ArchiveState, candidates: readonly ArchiveCandidate[]): ArchiveEntry[] {
  const live = new Set(candidates.map((c) => `${c.kind}\u0000${c.id}`));
  return state.entries.filter((e) => !live.has(`${e.kind}\u0000${e.id}`));
}

/** How many NEW archives fit without evicting a live entry: free slots + gone entries. */
function archiveRoom(state: ArchiveState, candidates: readonly ArchiveCandidate[]): number {
  return Math.max(0, ARCHIVE_ENTRIES_CAP - state.entries.length) + goneEntries(state, candidates).length;
}

/** Drop (oldest first) just enough gone entries so `incoming` new archives fit under the cap.
 *  The state's own FIFO cap would instead evict the oldest-INSERTED entries — live ones included —
 *  and the evicted live items would be re-selected by the next sweep (the flip-flop bug). */
export function makeArchiveRoom(
  state: ArchiveState,
  candidates: readonly ArchiveCandidate[],
  incoming: number,
): ArchiveState {
  const needed = state.entries.length + incoming - ARCHIVE_ENTRIES_CAP;
  if (needed <= 0) return state;
  const drop = goneEntries(state, candidates).slice(0, needed);
  if (drop.length === 0) return state;
  return { ...state, entries: state.entries.filter((e) => !drop.some((d) => sameItem(d, e))) };
}

/** Count unarchived terminal items, including held items, independently by kind.
 * Select oldest eligible items until the keep count is reached or eligibility
 * runs out. Held items count but are never selected. Input order/state are unchanged.
 *
 * Capacity: the result never exceeds `archiveRoom` (the archive snapshot is FIFO-capped at
 * ARCHIVE_ENTRIES_CAP). When more items are eligible than fit, the NEWEST-settled ones win — they
 * are the rows the drawer can show; the oldest unarchived terminal items sit beyond the fleet
 * wire's row caps. Selecting past the cap would evict live entries that the next sweep
 * re-selects, flipping archived/unarchived every minute. */
export function selectAutoArchives(
  state: ArchiveState,
  candidates: readonly ArchiveCandidate[],
  now: number,
  policy: ArchiveSweepPolicy,
): ArchiveCandidate[] {
  if (policy.afterMs <= 0) return [];
  const selected: ArchiveCandidate[] = [];
  for (const kind of ["run", "bash"] as const) {
    const seen = new Set<string>();
    const remaining = candidates.filter((item) => {
      if (item.kind !== kind || !item.terminal || isArchived(state, item) || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    const keep = kind === "run" ? policy.keepRuns : policy.keepBash;
    const excess = keep === 0 ? remaining.length : Math.max(0, remaining.length - keep);
    selected.push(
      ...remaining
        .filter((item) => autoArchiveDue(state, item, item.settledAt, now, policy.afterMs))
        .sort((a, b) => a.settledAt - b.settledAt)
        .slice(0, excess),
    );
  }
  const room = archiveRoom(state, candidates);
  if (selected.length <= room) return selected;
  const keep = new Set(
    selected
      .slice()
      .sort((a, b) => b.settledAt - a.settledAt)
      .slice(0, room),
  );
  return selected.filter((item) => keep.has(item));
}
