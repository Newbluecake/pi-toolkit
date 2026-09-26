import { describe, expect, it } from "vitest";
import { formatSlots, slotsInfo } from "../../src/core/format.js";

/**
 * P1 fix (todo #16 review): unit coverage for the display/reservation split
 * — slotsInfo's `inUse` must never exceed `limit`, with any overflow
 * surfaced separately as `queued`. See spawn-service.ts's slotsInfo call
 * site for why the raw admission-reservation count and the displayed
 * occupancy are deliberately two different numbers.
 */
describe("slotsInfo / formatSlots (core/format.ts)", () => {
  it("caps inUse at limit and reports the overflow as queued", () => {
    expect(slotsInfo(1, 3, 2)).toEqual({ limit: 1, inUse: 1, free: 0, queued: 2 });
    expect(formatSlots(slotsInfo(1, 3, 2))).toBe("slots: 1/1 in use, 0 free, 2 queued");
  });

  it("omits queued when there is none", () => {
    expect(slotsInfo(10, 10)).toEqual({ limit: 10, inUse: 10, free: 0 });
    expect(formatSlots(slotsInfo(10, 10))).toBe("slots: 10/10 in use, 0 free");
  });

  it("renders the normal under-capacity case unchanged", () => {
    expect(slotsInfo(10, 7)).toEqual({ limit: 10, inUse: 7, free: 3 });
    expect(formatSlots(slotsInfo(10, 7))).toBe("slots: 7/10 in use, 3 free");
  });

  it("limit=0 (unlimited) never carries free or queued, regardless of the queued argument", () => {
    expect(slotsInfo(0, 4)).toEqual({ limit: 0, inUse: 4 });
    expect(slotsInfo(0, 4, 5)).toEqual({ limit: 0, inUse: 4 });
    expect(formatSlots(slotsInfo(0, 4))).toBe("slots: 4 running (no limit)");
  });

  it("negative limit is treated like 0 (unlimited form, never a divide-by/negative-free artifact)", () => {
    expect(slotsInfo(-1, 2)).toEqual({ limit: -1, inUse: 2 });
    expect(formatSlots(slotsInfo(-1, 2))).toBe("slots: 2 running (no limit)");
  });
});
