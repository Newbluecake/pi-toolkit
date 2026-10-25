/**
 * scheduled-reports plan r3 §7.2 (H1, r2 after review round 1) — the missedLog reconciliation
 * algorithm.
 *
 * The agent-written `missedLog` is the single source of truth: each entry says "every occurrence
 * of `defHash` in `(from, to]` was missed". The hub keeps a per-task cursor
 * `{consumedSeq, consumedTotal, observed[]}` (persisted in `hub-state.ts`) and, per scan:
 *
 *  1. For each new entry `e` (`e.seq > consumedSeq`):
 *     `notify = e.count − |{o ∈ observed : e.from < o.T ≤ e.to ∧ o.defHash = e.defHash}|` —
 *     observations already notified at observation time are deducted so each missed occurrence
 *     is notified exactly once; matched observations are consumed.
 *  2. Truncation (missedLog keeps the last 64): when the cursor's anchor entry (seq ===
 *     consumedSeq) is gone and the log still reaches past the cursor (`oldest.seq >
 *     consumedSeq`), the truncated part is reconstructed as
 *     `gap = (oldest.totalAfter − oldest.count) − consumedTotal`, minus observations with
 *     `T ≤ oldest.from` (those necessarily belong to the truncated part — consumed and deleted);
 *     `oldest` itself is then processed by the normal loop (the cursor is rewound to
 *     `oldest.seq − 1`). An EMPTY log with `missedTotal > consumedTotal` means everything
 *     truncated: the gap is the whole difference and every observation is consumed.
 *  3. Ledger rebuild/rollback detection (review r1 #9): the entry at `seq === consumedSeq` must
 *     carry `totalAfter === consumedTotal`. A mismatch, or a log whose newest seq is BELOW the
 *     cursor (history was rewritten/shortened), is a REBUILD: the cursor resets to {0,0},
 *     flagged — and the reset FALLS THROUGH to the truncation branch so the retained prefix is
 *     reconstructed from zero instead of being silently skipped (a one-time replay of the
 *     truncated prefix is the honest outcome; never silent).
 *
 * Observations are NEVER expired by wall clock (review r1 #7): un-reconciled evidence must
 * survive so a later sweep cannot double-count an already-notified occurrence. Bounding happens
 * upstream — the service STOP-ADDS at the per-task cap instead of evicting (a skipped
 * observation is never notified, so it can only be notified later by reconciliation), and the
 * whole session record dies with the session (7d without any scan contact), which is the only
 * disclosed double-count residual.
 */
import type { MissedEntry } from "../../../schedule/core/spec.js";

export interface ObservedMiss {
  /** The occurrence instant (UTC epoch ms). */
  t: number;
  defHash: string;
  at: number;
}

export interface TaskCursor {
  consumedSeq: number;
  consumedTotal: number;
  observed: ObservedMiss[];
}

export const emptyCursor = (): TaskCursor => ({ consumedSeq: 0, consumedTotal: 0, observed: [] });

/** Dedup-evidence cap (STOP-ADDING — never evicting; the service enforces before pushing). */
export const OBSERVED_MAX = 64;

export interface ReconcileChanges {
  /** Observations consumed by entry matching (deducted). */
  matched: number;
  /** Missed occurrences reconstructed from a truncated front. */
  truncatedGap: number;
  /** Ledger rebuild/rollback detected (cursor reset + full prefix replay). */
  reset: boolean;
  /** An entry's count was smaller than its matched observations (defensive clamp). */
  clamped: boolean;
}

export interface ReconcileResult {
  cursor: TaskCursor;
  /** Freshly-due missed notifications (feeds the task's pendingMissed accumulator). */
  notify: number;
  changes: ReconcileChanges;
}

interface OccLike {
  missedTotal: number;
  missedLog: MissedEntry[];
}

/**
 * One task's reconciliation pass. `occ` is the freshly-read occurrence state (validated by the
 * reader); the entries are processed in seq order.
 */
export function reconcileTask(cursor: TaskCursor, occ: OccLike, _now: number): ReconcileResult {
  const changes: ReconcileChanges = { matched: 0, truncatedGap: 0, reset: false, clamped: false };
  let cur: TaskCursor = { ...cursor, observed: [...cursor.observed] };
  const log = [...occ.missedLog].sort((a, b) => a.seq - b.seq);
  let notify = 0;

  const consume = (from: number, to: number, defHash: string): number => {
    let matched = 0;
    const kept: ObservedMiss[] = [];
    for (const o of cur.observed) {
      if (o.t > from && o.t <= to && o.defHash === defHash) matched++;
      else kept.push(o);
    }
    cur.observed = kept;
    return matched;
  };

  /** Reconstruct the truncated front from `gapBase` down to the cursor's consumedTotal. */
  const truncateFrom = (oldest: MissedEntry, gapBase: number): void => {
    const before = cur.observed.length;
    const kept: ObservedMiss[] = [];
    for (const o of cur.observed) {
      if (o.t <= oldest.from) changes.matched++;
      else kept.push(o);
    }
    cur.observed = kept;
    const dropped = before - kept.length;
    const gap = gapBase - cur.consumedTotal - dropped;
    if (gap > 0) {
      notify += gap;
      changes.truncatedGap += gap;
    } else if (dropped > 0 && gap < 0) changes.clamped = true;
    cur.consumedSeq = oldest.seq - 1;
    cur.consumedTotal = gapBase;
  };

  if (log.length === 0) {
    if (occ.missedTotal > cur.consumedTotal) {
      // Everything truncated (or the ledger was rebuilt shorter). Consume all observations
      // (they were notified when observed; the difference beyond them is the gap).
      const observedAll = cur.observed.length;
      cur.observed = [];
      const gap = occ.missedTotal - cur.consumedTotal - observedAll;
      if (gap > 0) {
        notify += gap;
        changes.truncatedGap += gap;
      } else if (observedAll > 0 && gap < 0) changes.clamped = true;
      changes.matched += observedAll;
      cur.consumedTotal = occ.missedTotal;
    }
    return { cursor: cur, notify, changes };
  }

  const newest = log[log.length - 1]!;
  const oldest = log[0]!;

  if (cur.consumedSeq > 0) {
    const anchor = log.find((e) => e.seq === cur.consumedSeq);
    if (anchor !== undefined) {
      if (anchor.totalAfter !== cur.consumedTotal) {
        // Same seq, different cumulative total: the ledger was rebuilt in place.
        changes.reset = true;
        cur = emptyCursor();
      }
    } else if (newest.seq < cur.consumedSeq) {
      // History shortened below the cursor: rollback/rebuild.
      changes.reset = true;
      cur = emptyCursor();
    }
  }

  if (oldest.seq > cur.consumedSeq + 1) {
    // Truncated front (also reached after a reset above — the retained prefix is reconstructed
    // from zero rather than skipped). gapBase = cumulative total just before `oldest`.
    truncateFrom(oldest, oldest.totalAfter - oldest.count);
  }

  for (const e of log) {
    if (e.seq <= cur.consumedSeq) continue;
    const matched = consume(e.from, e.to, e.defHash);
    changes.matched += matched;
    if (matched > e.count) changes.clamped = true;
    notify += Math.max(0, e.count - matched);
    cur.consumedSeq = e.seq;
    cur.consumedTotal = e.totalAfter;
  }
  return { cursor: cur, notify, changes };
}
