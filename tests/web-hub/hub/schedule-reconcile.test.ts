/**
 * scheduled-reports plan r3 §7.2 (H1) — the missedLog reconciliation algorithm, unit level.
 *
 * §14's concrete numbers (R2-2): an hourly cron where 08:00 succeeded, 09:00 was missed
 * (offline), 10:00 succeeded, 11:00 and 12:00 were missed (sweep when the session opened at
 * 12:30) ⇒ the store holds TWO entries — `{(08,09], count 1}` and `{(10,12], count 2}` — with
 * `missedTotal = 3`. The hub observed 09:00 at 09:01:30 and notified once immediately; the
 * reconciliation must then notify 0 for the first entry (the observation is deducted) and 2 for
 * the second — total 3 notifications, exactly `missedTotal`, and no successful run is ever
 * counted.
 */
import { describe, expect, it } from "vitest";
import {
  emptyCursor,
  reconcileTask,
  type ObservedMiss,
  type TaskCursor,
} from "../../../src/web-hub/hub/schedule/reconcile.js";
import type { MissedEntry } from "../../../src/schedule/core/spec.js";

/** 2026-10-25T00:00:00Z — a fixed base so hour arithmetic is readable. */
const BASE = Date.UTC(2026, 9, 25, 0, 0, 0);
/** UTC epoch ms of hour `h` on that day. */
export const T = (h: number): number => BASE + h * 3_600_000;
export const HASH = "a".repeat(64);
const HASH2 = "b".repeat(64);

export function entry(
  seq: number,
  from: number,
  to: number,
  count: number,
  totalAfter: number,
  defHash = HASH,
): MissedEntry {
  return { seq, defHash, from, to, count, totalAfter, at: to, cause: "offline" };
}

const occOf = (missedTotal: number, missedLog: MissedEntry[]) => ({ defHash: HASH, missedTotal, missedLog });

describe("reconcileTask — §14 exact numbers", () => {
  // 08 ok, 09 missed (offline), 10 ok, 11+12 missed (sweep at 12:30).
  const e1 = entry(1, T(8), T(9), 1, 1);
  const e2 = entry(2, T(10), T(12), 2, 3);

  it("observed-then-sweep: the observation is deducted, total notifications == missedTotal", () => {
    const observed: ObservedMiss[] = [{ t: T(9), defHash: HASH, at: T(9) + 90_000 }];
    const cursor: TaskCursor = { ...emptyCursor(), observed };
    const r = reconcileTask(cursor, occOf(3, [e1, e2]), T(13));
    // e1: count 1 − 1 matched observation ⇒ 0 due; e2: count 2 − 0 ⇒ 2 due.
    expect(r.notify).toBe(2);
    expect(r.cursor.consumedSeq).toBe(2);
    expect(r.cursor.consumedTotal).toBe(3);
    // The matched observation is consumed (never deducted twice).
    expect(r.cursor.observed).toEqual([]);
    expect(r.changes.matched).toBe(1);
  });

  it("sweep-then-observe (nothing observed yet): both entries notify in full", () => {
    const r = reconcileTask(emptyCursor(), occOf(3, [e1, e2]), T(13));
    expect(r.notify).toBe(3);
    expect(r.cursor.consumedTotal).toBe(3);
  });

  it("an already-consumed log notifies nothing on rerun (hub restart / rescans are idempotent)", () => {
    const first = reconcileTask(emptyCursor(), occOf(3, [e1, e2]), T(13));
    const second = reconcileTask(first.cursor, occOf(3, [e1, e2]), T(14));
    expect(second.notify).toBe(0);
    expect(second.changes.matched).toBe(0);
  });

  it("a late-claim 'late' entry (from the OLD watermark to T) is notified like any other", () => {
    // §4.5a step 4: late claim appends {from: decidedThrough, to: T} — count covers the
    // intermediate undecided occurrences too; the hub just notifies e.count.
    const late = entry(1, T(8), T(9), 1, 1, HASH);
    const r = reconcileTask(emptyCursor(), occOf(1, [late]), T(10));
    expect(r.notify).toBe(1);
  });
});

describe("reconcileTask — truncation (missedLog kept at 64)", () => {
  const e2 = entry(2, T(10), T(12), 2, 3);

  it("a truncated front is reconstructed from totalAfter; observations ≤ e₀.from are consumed by the gap", () => {
    // Agent truncated e1: only e2 remains. Cursor stopped after e1 (seq 1, total 1) — e2 is
    // still genuinely new to the hub (its count was never accounted) ⇒ notified in full.
    const cursor: TaskCursor = { consumedSeq: 1, consumedTotal: 1, observed: [] };
    const r = reconcileTask(cursor, occOf(3, [e2]), T(13));
    expect(r.notify).toBe(2);
    expect(r.cursor.consumedTotal).toBe(3);
  });

  it("a cursor at e1 processes the later e2 normally (notify 2 — e2 is genuinely new)", () => {
    const e1 = entry(1, T(8), T(9), 1, 1);
    // Cursor stopped after e1; e2 arrived since ⇒ the hub has not yet accounted for it.
    const cursor: TaskCursor = { consumedSeq: 1, consumedTotal: 1, observed: [] };
    const r = reconcileTask(cursor, occOf(3, [e1, e2]), T(13));
    expect(r.notify).toBe(2);
    expect(r.cursor.consumedTotal).toBe(3);
  });

  it("a cursor older than the truncation point gets the gap via totalAfter arithmetic", () => {
    // Hub was down when e1 AND e2 happened; the log has since truncated e1 away.
    const observed: ObservedMiss[] = [{ t: T(9), defHash: HASH, at: T(9) }];
    const cursor: TaskCursor = { consumedSeq: 0, consumedTotal: 0, observed };
    const r = reconcileTask(cursor, occOf(3, [e2]), T(13));
    // gap = (e2.totalAfter − e2.count) − consumedTotal − |observed ≤ e2.from| = (3−2) − 0 − 1 = 0
    // (the observed 09:00 belonged to the truncated e1), then e2 notifies 2.
    expect(r.notify).toBe(2);
    expect(r.cursor.observed).toEqual([]);
    expect(r.cursor.consumedSeq).toBe(2);
    expect(r.cursor.consumedTotal).toBe(3);
  });

  it("an observation inside e2's interval survives the gap and is deducted from e2 itself", () => {
    const observed: ObservedMiss[] = [{ t: T(11), defHash: HASH, at: T(11) }];
    const cursor: TaskCursor = { consumedSeq: 0, consumedTotal: 0, observed };
    const r = reconcileTask(cursor, occOf(3, [e2]), T(13));
    // gap = 1 − 0 − 0 = 1 (truncated e1), then e2: 2 − 1 matched = 1. Total 2, plus the
    // observation's own earlier notification ⇒ 3 overall.
    expect(r.notify).toBe(2);
    expect(r.cursor.observed).toEqual([]);
    expect(r.changes.matched).toBe(1);
  });

  it("an empty log with a larger missedTotal is fully gap-reconstructed (everything truncated)", () => {
    const observed: ObservedMiss[] = [{ t: T(9), defHash: HASH, at: T(9) }];
    const cursor: TaskCursor = { consumedSeq: 0, consumedTotal: 0, observed };
    const r = reconcileTask(cursor, occOf(3, []), T(13));
    // gap = 3 − 0 − 1 (the single observation is consumed) = 2.
    expect(r.notify).toBe(2);
    expect(r.cursor.observed).toEqual([]);
    expect(r.cursor.consumedTotal).toBe(3);
  });

  it("an empty log with consumedTotal == missedTotal is a no-op", () => {
    const r = reconcileTask({ consumedSeq: 2, consumedTotal: 3, observed: [] }, occOf(3, []), T(13));
    expect(r.notify).toBe(0);
  });
});

describe("reconcileTask — definition change / rollback / clamping", () => {
  const e1 = entry(1, T(8), T(9), 1, 1);
  const e2 = entry(2, T(10), T(12), 2, 3);

  it("an observation under a DIFFERENT defHash never deducts (definition-change case)", () => {
    const observed: ObservedMiss[] = [{ t: T(9), defHash: HASH2, at: T(9) }];
    const r = reconcileTask({ consumedSeq: 0, consumedTotal: 0, observed }, occOf(3, [e1, e2]), T(13));
    // No deduction anywhere: 1 + 2 = 3 due; the stale observation survives (expires by TTL later).
    expect(r.notify).toBe(3);
    expect(r.cursor.observed).toEqual(observed);
  });

  it("a state rollback (newest seq < consumedSeq) resets the cursor and reprocesses, flagged", () => {
    // e.g. /schedule repair rebuilt the ledger. Notices may duplicate once — flagged, never silent.
    const r = reconcileTask({ consumedSeq: 2, consumedTotal: 3, observed: [] }, occOf(1, [e1]), T(13));
    expect(r.changes.reset).toBe(true);
    expect(r.notify).toBe(1);
    expect(r.cursor.consumedSeq).toBe(1);
  });

  it("count < matched observations clamps at zero instead of going negative", () => {
    const observed: ObservedMiss[] = [
      { t: T(8) + 600_000, defHash: HASH, at: T(8) },
      { t: T(9), defHash: HASH, at: T(9) },
    ];
    const r = reconcileTask({ consumedSeq: 0, consumedTotal: 0, observed }, occOf(1, [e1]), T(13));
    expect(r.notify).toBe(0);
    expect(r.changes.clamped).toBe(true);
    // Both matched observations are still consumed.
    expect(r.cursor.observed).toEqual([]);
  });
});

describe("reconcileTask — ledger rebuild detection (review r1 #9)", () => {
  const e1 = entry(1, T(8), T(9), 1, 1);
  const e2 = entry(2, T(10), T(12), 2, 3);

  it("same seq but a different cumulative total is a REBUILD: reset + full prefix replay", () => {
    // The ledger was rebuilt in place: the entry the cursor stopped at now carries a much
    // larger totalAfter (older history was rewritten/merged).
    const rebuilt = [entry(1, T(8), T(9), 1, 1, HASH), { ...e2, totalAfter: 10, count: 9, from: T(9), to: T(12) }];
    const cursor: TaskCursor = { consumedSeq: 2, consumedTotal: 3, observed: [] };
    const r = reconcileTask(cursor, occOf(10, rebuilt), T(13));
    expect(r.changes.reset).toBe(true);
    // Replay from zero: e1 (1) + rebuilt e2 (9) ⇒ everything notified once more (flagged, never
    // silent) — and the cursor ends consistent with the new history.
    expect(r.notify).toBe(10);
    expect(r.cursor.consumedSeq).toBe(2);
    expect(r.cursor.consumedTotal).toBe(10);
  });

  it("a cursor ABOVE the newest retained seq resets AND reconstructs the truncated prefix", () => {
    // Old cursor seq=100; the rebuilt log only retains seq=50 (count 1, totalAfter 50).
    const e50 = entry(50, T(8), T(9), 1, 50);
    const cursor: TaskCursor = { consumedSeq: 100, consumedTotal: 60, observed: [] };
    const r = reconcileTask(cursor, occOf(50, [e50]), T(13));
    expect(r.changes.reset).toBe(true);
    // Prefix 49 (truncated) + the retained entry itself ⇒ the whole 50, not just 1.
    expect(r.notify).toBe(50);
    expect(r.cursor.consumedTotal).toBe(50);
  });

  it("an inconsistent anchor with NO retained history reconstructs via missedTotal", () => {
    const cursor: TaskCursor = { consumedSeq: 3, consumedTotal: 3, observed: [] };
    const r = reconcileTask(cursor, occOf(3, []), T(13));
    expect(r.changes.reset).toBe(false); // empty-log branch handles it without the reset flag
    expect(r.notify).toBe(0);
  });
});

describe("observations are never wall-clock expired (review r1 #7)", () => {
  it("an OLD un-reconciled observation still deducts — no re-count after a late sweep", () => {
    const e1 = entry(1, T(8), T(9), 1, 1);
    const observed: ObservedMiss[] = [{ t: T(9), defHash: HASH, at: T(9) - 30 * 24 * 3_600_000 }];
    const r = reconcileTask({ consumedSeq: 0, consumedTotal: 0, observed }, occOf(1, [e1]), T(13));
    expect(r.notify).toBe(0);
    expect(r.cursor.observed).toEqual([]);
  });
});
