/** Pure fleet auto-archive selection (#59). No clock, persistence or timers. */
import { autoArchiveDue, isArchived, type ArchiveKind, type ArchiveState } from "./state.js";

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

/** Count unarchived terminal items, including held items, independently by kind.
 * Select oldest eligible items until the keep count is reached or eligibility
 * runs out. Held items count but are never selected. Input order/state are unchanged. */
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
  return selected;
}
