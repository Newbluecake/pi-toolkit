// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatTimeRange } from "../../../src/web-hub/ui/src/logic/timeRange.js";

/**
 * Start/end token (2026-10-18 user pick C). Every case pins an explicit IANA zone so the suite is
 * independent of the machine's TZ (the UI itself passes no zone ⇒ browser local).
 */
const SH = { timeZone: "Asia/Shanghai" }; // UTC+8, no DST
const NY = { timeZone: "America/New_York" };
const at = (iso: string): number => Date.parse(iso);

describe("formatTimeRange", () => {
  it("running (no end): zh-CN date + HH:MM, tooltip start only with seconds", () => {
    const r = formatTimeRange(at("2026-10-18T22:41:05+08:00"), undefined, SH);
    expect(r).toEqual({ text: "2026年10月18日 22:41", title: "2026-10-18 22:41:05" });
  });

  it("finished same day: end abbreviated to HH:MM", () => {
    const r = formatTimeRange(at("2026-10-18T22:41:05+08:00"), at("2026-10-18T22:47:17+08:00"), SH);
    expect(r).toEqual({
      text: "2026年10月18日 22:41 → 22:47",
      title: "2026-10-18 22:41:05 → 2026-10-18 22:47:17",
    });
  });

  it("finished across midnight: full date on both sides", () => {
    const r = formatTimeRange(at("2026-10-17T23:58:40+08:00"), at("2026-10-18T00:12:40+08:00"), SH);
    expect(r).toEqual({
      text: "2026年10月17日 23:58 → 2026年10月18日 00:12",
      title: "2026-10-17 23:58:40 → 2026-10-18 00:12:40",
    });
  });

  it("day comparison happens in the display zone, not UTC", () => {
    // 15:30Z and 17:30Z: same UTC day, but 23:30 / 01:30(+1) in Shanghai ⇒ cross-day there
    const a = at("2026-10-18T15:30:00Z");
    const b = at("2026-10-18T17:30:00Z");
    expect(formatTimeRange(a, b, SH)?.text).toBe("2026年10月18日 23:30 → 2026年10月19日 01:30");
    // 12:00Z and 20:00Z: same day in New York (08:00 / 16:00 EDT)
    expect(formatTimeRange(at("2026-10-18T12:00:00Z"), at("2026-10-18T20:00:00Z"), NY)?.text).toBe(
      "2026年10月18日 08:00 → 16:00",
    );
  });

  it("24h clock, midnight renders 00:xx (never 24:xx)", () => {
    expect(formatTimeRange(at("2026-10-18T00:05:09+08:00"), undefined, SH)).toEqual({
      text: "2026年10月18日 00:05",
      title: "2026-10-18 00:05:09",
    });
  });

  it("invalid start ⇒ null (render nothing)", () => {
    for (const bad of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, "1700000000000", {}]) {
      expect(formatTimeRange(bad, 1, SH)).toBeNull();
    }
  });

  it("invalid or before-start end ⇒ treated as still running (start only)", () => {
    const start = at("2026-10-18T22:41:05+08:00");
    const startOnly = { text: "2026年10月18日 22:41", title: "2026-10-18 22:41:05" };
    expect(formatTimeRange(start, Number.NaN, SH)).toEqual(startOnly);
    expect(formatTimeRange(start, "x", SH)).toEqual(startOnly);
    expect(formatTimeRange(start, start - 1, SH)).toEqual(startOnly);
  });

  it("end === start is a finished zero-length run (same day ⇒ HH:MM)", () => {
    const t = at("2026-10-18T22:41:05+08:00");
    expect(formatTimeRange(t, t, SH)?.text).toBe("2026年10月18日 22:41 → 22:41");
  });

  it("without a zone option it still formats using the runtime-local zone", () => {
    const r = formatTimeRange(at("2026-10-18T12:00:00Z"));
    expect(r?.text).toMatch(/^\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/);
    expect(r?.title).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
