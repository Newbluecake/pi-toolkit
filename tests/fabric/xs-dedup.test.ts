import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { XS_DEDUP_GRACE_MS, XS_DEDUP_UNSETTLED, getXsDedup, XsDedup } from "../../src/fabric/xs/dedup.js";

/**
 * fabric phase-2 X4 (phase2-plan §9 + §11.2 X4 行): the process-level dedup table.
 * Anchors: unexpired duplicate ⇒ replay the FIRST ack; a duplicate after a "reload" (fresh
 * module instance sharing the Symbol.for global) is still intercepted; full capacity ⇒ refuse,
 * never evict; entries die at expiresAt + 1s (lazy purge, no timers).
 */

const ACK = { effect: "applied" as const, woke: false };

describe("xs-dedup", () => {
  it("fresh admit reserves and owes one settle; a settled duplicate replays the FIRST ack verbatim", () => {
    const clock = new FakeClock(1_000);
    const dedup = new XsDedup(4, clock);
    expect(dedup.admit("x1", 6_000)).toEqual({ kind: "fresh" });
    dedup.settle("x1", { effect: "none", reason: "rejected", woke: false });
    expect(dedup.admit("x1", 6_000)).toEqual({
      kind: "replay",
      verdict: { effect: "none", reason: "rejected", woke: false },
    });
    // A second settle never overwrites the first ack.
    dedup.settle("x1", ACK);
    expect(dedup.admit("x1", 6_000)).toEqual({
      kind: "replay",
      verdict: { effect: "none", reason: "rejected", woke: false },
    });
  });

  it("unexpired duplicate is intercepted even while a NEWER expiresAt would differ", () => {
    const clock = new FakeClock(1_000);
    const dedup = new XsDedup(4, clock);
    expect(dedup.admit("x1", 6_000)).toEqual({ kind: "fresh" });
    dedup.settle("x1", ACK);
    expect(dedup.admit("x1", 60_000)).toEqual({ kind: "replay", verdict: ACK });
  });

  it("entry dies at expiresAt + 1s (lazy purge) — after that a duplicate is fresh again", () => {
    const clock = new FakeClock(1_000);
    const dedup = new XsDedup(4, clock);
    dedup.admit("x1", 6_000);
    dedup.settle("x1", ACK);
    clock.advance(4_999); // now = 5999 < expiresAt 6000 + grace
    expect(dedup.admit("x1", 6_000).kind).toBe("replay");
    clock.advance(1 + XS_DEDUP_GRACE_MS); // now = 7000 ≥ 6000 + 1s
    expect(dedup.admit("x1", 6_000)).toEqual({ kind: "fresh" });
  });

  it("full capacity REFUSES instead of evicting a live entry; purgeable entries free room first", () => {
    const clock = new FakeClock(1_000);
    const dedup = new XsDedup(2, clock);
    dedup.admit("x1", 6_000);
    dedup.admit("x2", 6_000);
    expect(dedup.admit("x3", 6_000)).toEqual({ kind: "full" });
    expect(dedup.snapshot().map((s) => s.xid)).toEqual(["x1", "x2"]); // nothing evicted
    clock.advance(6_100); // now = 7100 ≥ expiresAt(6000) + 1s ⇒ x1/x2 purgeable
    expect(dedup.admit("x3", 60_000)).toEqual({ kind: "fresh" });
    expect(dedup.size).toBe(1);
  });

  it("an un-settled reserve replays the conservative unknown{receiver_error} verdict (M2 direction)", () => {
    const dedup = new XsDedup(4, new FakeClock(1_000));
    dedup.admit("x1", 6_000); // crashed before settle
    expect(dedup.admit("x1", 6_000)).toEqual({ kind: "replay", verdict: XS_DEDUP_UNSETTLED });
    expect(XS_DEDUP_UNSETTLED).toEqual({ effect: "unknown", reason: "receiver_error", woke: false });
  });

  it("the process global survives a fresh module load (cross /reload), per D3/§9", async () => {
    const global1 = getXsDedup();
    const { getXsDedup: loadAgain } = await import("../../src/fabric/xs/dedup.js");
    expect(loadAgain()).toBe(global1);
  });

  it("invalid capacity throws; settle on an unknown xid is a no-op", () => {
    expect(() => new XsDedup(0)).toThrow(RangeError);
    const dedup = new XsDedup(4, new FakeClock(0));
    expect(() => dedup.settle("nope", ACK)).not.toThrow();
    expect(dedup.size).toBe(0);
  });
});
