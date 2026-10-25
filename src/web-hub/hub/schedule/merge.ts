/**
 * scheduled-reports plan r3 §7.2/E1 (H1, r2 after review round 1) — the per-task hour gate.
 *
 * E1's "at most ONE notification per task per wall-clock hour" is now enforced AUTHORITATIVELY
 * by the Feishu side (`hub/feishu/schedule.ts`'s `noticesTask`/`noticesGlobal` caps + the
 * NoticeBudget `schedule` lane — F1 refuses a same-hour second notice with `task-hour`). H1's
 * role shrinks to:
 *   - PERSISTED pending accumulators (missed counts / unknown runKeys / droppedIndex increments)
 *     that survive crashes and a late bot binding — nothing is consumed until a delivery
 *     actually succeeded (review r1 #2/#3/#5/#13);
 *   - this hour gate: at most one delivery ATTEMPT per task per hour, so a busy scan loop never
 *     hammers a refusing bot. Any outcome (queued or refused) marks the hour as attempted —
 *     retries wait for the next hour, where F1's own caps roll over.
 *
 * A refused attempt (budget/global/headroom/no-owner/task-hour) keeps the pendings untouched;
 * they are the carry E1 speaks of, and the every-round delivery pass gives them an independent
 * flush path (review r1 #2) — no new events are needed for a carried batch to go out.
 */

/** Wall-clock hour bucket (floor(ms / 3600_000)). */
export const hourOf = (now: number): number => Math.floor(now / 3_600_000);

export interface HourGate {
  hour: number;
  /** A delivery attempt was already made for this hour (any outcome). */
  attempted: boolean;
}

export const EMPTY_HOUR_GATE: HourGate = { hour: 0, attempted: false };

/** True ⇔ an attempt may be made for `now`'s hour (hour rolled over, or never attempted). */
export function gateFresh(gate: HourGate, now: number): boolean {
  const h = hourOf(now);
  if (h !== gate.hour) return true;
  return !gate.attempted;
}

/** Record that an attempt was made for `now`'s hour. */
export function gateAttempt(gate: HourGate, now: number): HourGate {
  return { hour: hourOf(now), attempted: true };
}

/** Pending unknown runKeys cap — STOP-ADDING (a skipped unknown is simply never notified). */
export const PENDING_UNKNOWNS_MAX = 64;
/** Delivered-unknown dedup cap — STOP-ADDING (bounded re-notify residual, disclosed). */
export const NOTIFIED_UNKNOWN_MAX = 64;
/** How many unknown runKeys ride ONE notice card (the rest stay pending for later hours). */
export const NOTICE_UNKNOWNS_PER_CARD = 1;
