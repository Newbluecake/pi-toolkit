/** Pure fleet auto-archive selection + cap trimming (#59, #91). No clock, persistence or timers. */
import {
  ARCHIVE_ENTRIES_CAP,
  archivedSetOf,
  autoArchiveDue,
  horizonOf,
  raiseHorizon,
  type ArchiveEntry,
  type ArchiveHorizon,
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

/** Canonical key of the `live` map `trimToCap` consumes: `kind\0id`. */
export function liveKey(kind: ArchiveKind, id: string): string {
  return `${kind}\u0000${id}`;
}

/** Count unarchived terminal items, including held items, independently by kind.
 * Select oldest eligible items until the keep count is reached or eligibility
 * runs out. Held items count but are never selected. Input order/state are unchanged.
 *
 * #91: terminal items settled at/below their kind's horizon are IMPLICITLY archived —
 * they neither count toward keep nor get selected (held items always count). There is
 * NO room truncation here any more: capacity is decided once, by `trimToCap`, which
 * must see the complete selection so the losers of a full-cap contest fold into the
 * horizon in the SAME write instead of being re-selected next sweep (the pre-#91
 * `archiveRoom` clamp is what made a full cap of live entries stall auto-archive —
 * gone≈0 ⇒ room=0 ⇒ selection always empty). */
export function selectAutoArchives(
  state: ArchiveState,
  candidates: readonly ArchiveCandidate[],
  now: number,
  policy: ArchiveSweepPolicy,
): ArchiveCandidate[] {
  if (policy.afterMs <= 0) return [];
  const selected: ArchiveCandidate[] = [];
  for (const kind of ["run", "bash"] as const) {
    const archived = archivedSetOf(state, kind);
    const held = new Set(state.held.filter((h) => h.kind === kind).map((h) => h.id));
    const horizon = horizonOf(state, kind);
    const seen = new Set<string>();
    const remaining = candidates.filter((item) => {
      if (item.kind !== kind || !item.terminal || seen.has(item.id)) return false;
      seen.add(item.id);
      if (archived.has(item.id)) return false;
      // Held items always count; implicitly-archived ones (settled ≤ horizon) never do.
      return held.has(item.id) || item.settledAt > horizon;
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

/**
 * Enforce the 256-entry snapshot cap after new archives were folded in with
 * `archiveItem(·, Infinity)` (#91). No overflow ⇒ the SAME reference back.
 * Overflow evicts `overflow` victims by priority:
 *
 *  P1 unprotected entries whose item is GONE from the live lists — oldest-INSERTED
 *     first (invisible in the UI anyway);
 *  P2 unprotected LIVE `auto` entries — oldest-SETTLED first (ties keep insertion
 *     order via stable sort);
 *  P3 unprotected LIVE manual entries — oldest-settled first;
 *  P4 protected entries (a manual batch's own ids) — insertion order, i.e. the
 *     pre-#91 capTail semantics, so a >cap batch still keeps its newest rows.
 *
 * Every LIVE victim raises its kind's horizon to its settledAt (`raiseHorizon`,
 * monotone) — the evicted item is implicitly archived from then on and can never be
 * re-selected, which is what makes resurrect flip-flop impossible by construction:
 * an entry leaves the explicit set only via gone (not a candidate), horizon (never
 * selectable again) or hold (never auto-selected). Gone victims do not move the
 * horizon. `held` is untouched.
 */
export function trimToCap(
  state: ArchiveState,
  live: ReadonlyMap<string, number>,
  protect: ReadonlySet<string>,
): ArchiveState {
  const overflow = state.entries.length - ARCHIVE_ENTRIES_CAP;
  if (overflow <= 0) return state;
  const key = (e: ArchiveEntry) => liveKey(e.kind, e.id);
  const gone: ArchiveEntry[] = [];
  const liveAuto: ArchiveEntry[] = [];
  const liveManual: ArchiveEntry[] = [];
  const safe: ArchiveEntry[] = [];
  for (const e of state.entries) {
    if (protect.has(key(e))) safe.push(e);
    else if (!live.has(key(e))) gone.push(e);
    else if (e.auto === true) liveAuto.push(e);
    else liveManual.push(e);
  }
  const settled = (e: ArchiveEntry): number => live.get(key(e)) ?? -Infinity;
  liveAuto.sort((a, b) => settled(a) - settled(b));
  liveManual.sort((a, b) => settled(a) - settled(b));
  const victims = [...gone, ...liveAuto, ...liveManual, ...safe].slice(0, overflow);
  let horizon: ArchiveHorizon | undefined = state.horizon;
  for (const v of victims) {
    const s = live.get(key(v));
    if (s !== undefined) horizon = raiseHorizon(horizon, v.kind, s);
  }
  const victimKeys = new Set(victims.map(key));
  return {
    entries: state.entries.filter((e) => !victimKeys.has(key(e))),
    held: state.held,
    ...(horizon !== undefined ? { horizon } : {}),
  };
}
