/**
 * web-hub session-history plan v3.3 W1 (`fd-ledger.ts`): reserve-before-open accounting.
 */
import { describe, expect, it } from "vitest";
import { createFdLedger } from "../../../../../src/web-hub/hub/spawn/history/fd-ledger.js";

describe("createFdLedger", () => {
  it("reserves up to max, rejects beyond it, and releases exactly what was reserved", () => {
    const ledger = createFdLedger(4);
    expect(ledger.reserve(2, "gen")).toBe(true);
    expect(ledger.reserve(2, "pin")).toBe(true);
    expect(ledger.counts()).toEqual({ gen: 2, pin: 2, temp: 0, max: 4 });
    expect(ledger.reserve(1, "temp")).toBe(false); // would exceed max
    ledger.release(2, "pin");
    expect(ledger.counts()).toEqual({ gen: 2, pin: 0, temp: 0, max: 4 });
    expect(ledger.reserve(1, "temp")).toBe(true);
    expect(ledger.counts()).toEqual({ gen: 2, pin: 0, temp: 1, max: 4 });
  });

  it("never goes negative on over-release (defensive clamp, X3 #1/#2)", () => {
    const ledger = createFdLedger(4);
    ledger.release(5, "gen");
    expect(ledger.counts()).toEqual({ gen: 0, pin: 0, temp: 0, max: 4 });
  });

  it("n<=0 reserve/release are no-ops", () => {
    const ledger = createFdLedger(2);
    expect(ledger.reserve(0, "gen")).toBe(true);
    expect(ledger.counts().gen).toBe(0);
    ledger.release(0, "gen");
    expect(ledger.counts().gen).toBe(0);
  });

  it("concurrent independent kinds never interfere — totals are summed across kinds for admission", () => {
    const ledger = createFdLedger(3);
    expect(ledger.reserve(1, "gen")).toBe(true);
    expect(ledger.reserve(1, "pin")).toBe(true);
    expect(ledger.reserve(1, "temp")).toBe(true);
    expect(ledger.reserve(1, "gen")).toBe(false); // total already at max
    ledger.release(1, "pin");
    expect(ledger.reserve(1, "gen")).toBe(true);
  });
});
