import { describe, expect, it } from "vitest";
import { isSwitchImminent, SWITCH_IMMINENT_MARGIN_PERCENT } from "../../src/compact-hint/threshold.js";

describe("isSwitchImminent", () => {
  it("fires within the margin of the earliest active line", () => {
    expect(SWITCH_IMMINENT_MARGIN_PERCENT).toBe(5);
    expect(isSwitchImminent(44, 50, 88)).toBe(false);
    expect(isSwitchImminent(45, 50, 88)).toBe(true);
    expect(isSwitchImminent(60, 50, 88)).toBe(true);
  });

  it("uses the force line when the hint line is off, and the earlier of the two otherwise", () => {
    expect(isSwitchImminent(82, 0, 88)).toBe(false);
    expect(isSwitchImminent(83, 0, 88)).toBe(true);
    expect(isSwitchImminent(36, 91, 40)).toBe(true);
  });

  it("is false with every line off or a non-finite percent", () => {
    expect(isSwitchImminent(99, 0, 0)).toBe(false);
    expect(isSwitchImminent(Number.NaN, 50, 88)).toBe(false);
  });
});
