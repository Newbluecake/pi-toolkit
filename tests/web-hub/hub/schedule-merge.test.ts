/**
 * scheduled-reports plan r3 §7.2/E1 (H1 r2) — the per-task hour gate. E1's authoritative
 * hourly caps now live in F1's pushNotice (per-task-hour + global-hour + NoticeBudget lane);
 * H1's gate only bounds ATTEMPT frequency: at most one delivery attempt per task per wall-clock
 * hour, any outcome marks the hour, and the hour rolls over lazily. The persisted PENDING
 * accumulators (hub-state) are the carry — they survive refusals, crashes and a late binding,
 * with an independent flush path every round (service-level regression tests pin those).
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_HOUR_GATE,
  gateAttempt,
  gateFresh,
  hourOf,
  NOTICE_UNKNOWNS_PER_CARD,
  PENDING_UNKNOWNS_MAX,
} from "../../../src/web-hub/hub/schedule/merge.js";

const HOUR = 3_600_000;
const H10 = 10 * HOUR;

describe("hour gate (E1 attempt frequency)", () => {
  it("a fresh gate allows an attempt; any outcome marks the hour", () => {
    const g = EMPTY_HOUR_GATE;
    expect(gateFresh(g, H10 + 60_000)).toBe(true);
    const spent = gateAttempt(g, H10 + 60_000);
    expect(spent).toEqual({ hour: hourOf(H10 + 60_000), attempted: true });
    // Same hour, after a queued OR refused attempt ⇒ no second attempt.
    expect(gateFresh(spent, H10 + 30 * 60_000)).toBe(false);
  });

  it("the next wall-clock hour rolls the gate open again (the carry's independent flush path)", () => {
    const spent = gateAttempt(EMPTY_HOUR_GATE, H10 + 60_000);
    expect(gateFresh(spent, 11 * HOUR + 5_000)).toBe(true);
    expect(gateFresh(spent, 11 * HOUR + 5_000)).toBe(true);
  });

  it("an idle gate (never attempted) stays open within its hour", () => {
    const g = { hour: hourOf(H10), attempted: false };
    expect(gateFresh(g, H10 + 59 * 60_000)).toBe(true);
  });
});

describe("carry bounds (stop-adding, never silent-drop)", () => {
  it("pins the pending-unknown cap and the per-card unknown count", () => {
    expect(PENDING_UNKNOWNS_MAX).toBe(64);
    expect(NOTICE_UNKNOWNS_PER_CARD).toBe(1);
  });
});
