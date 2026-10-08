// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatDuration } from "../../../src/web-hub/ui/src/logic/duration.js";

/**
 * Tool-duration chip formatter (tool-duration plan, 2026-10): auto-scaled units with
 * boundary-safe rounding — rounding must NEVER produce `60s`/`60m` (59.96s ⇒ `1m 00s`), and
 * invalid inputs (negative/NaN/Infinity/non-number) return null (render nothing).
 */
describe("formatDuration", () => {
  it.each([
    [0, "0ms"],
    [1, "1ms"],
    [340, "340ms"],
    [999, "999ms"],
    [999.9, "999ms"], // floored — never rounds up into the seconds bucket
    [1_000, "1.0s"],
    [2_400, "2.4s"],
    [9_490, "9.5s"],
    [9_940, "9.9s"],
    [9_949, "9.9s"],
    [9_950, "10s"], // rounds to 10.0 ⇒ falls through to the integer-seconds bucket
    [9_960, "10s"],
    [10_000, "10s"],
    [12_000, "12s"],
    [59_400, "59s"],
    [59_499, "59s"],
    [59_500, "1m 00s"], // 59.5s rounds to 60s ⇒ carries, never "60s"
    [59_960, "1m 00s"], // the plan's own example (59.96s)
    [60_000, "1m 00s"],
    [61_000, "1m 01s"],
    [185_000, "3m 05s"], // the plan's own example (zero-padded seconds)
    [599_499, "9m 59s"],
    [599_500, "10m 00s"],
    [3_720_000, "1h 02m"], // the plan's own example
    [3_599_499, "59m 59s"],
    [3_599_500, "1h 00m"], // carries at the hour boundary, never "60m"
    [3_600_000, "1h 00m"],
    [90_610_000, "25h 10m"], // hours stay unbounded
  ])("%ims ⇒ %s", (ms, want) => {
    expect(formatDuration(ms)).toBe(want);
  });

  it.each([
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["non-number string", "1200"],
    ["undefined", undefined],
    ["null", null],
  ])("%s ⇒ null (render nothing)", (_label, ms) => {
    expect(formatDuration(ms)).toBeNull();
  });
});
