import { describe, expect, it } from "vitest";
import {
  createDateTimeSource,
  crossDayContent,
  dateChanged,
  firstTurnContent,
  formatUtcOffset,
  resolveTimeZone,
} from "../../src/date/core.js";

const TZ = "Asia/Shanghai";
/** 2026-10-15 17:00 UTC == 2026-10-16 01:00 (Asia/Shanghai)。 */
const AT_SHANGHAI_NEXT_DAY = Date.UTC(2026, 9, 15, 17, 0, 0);
/** 2026-10-15 10:00 UTC == 2026-10-15 18:00 (Asia/Shanghai)。 */
const AT_SHANGHAI_SAME_DAY = Date.UTC(2026, 9, 15, 10, 0, 0);

describe("date core formatting", () => {
  it("renders the marker with date, weekday and IANA zone", () => {
    const src = createDateTimeSource({ timeZone: TZ });
    expect(src.dateKey(AT_SHANGHAI_NEXT_DAY)).toBe("2026-10-16");
    expect(src.weekday(AT_SHANGHAI_NEXT_DAY)).toBe("Fri");
    expect(src.marker(AT_SHANGHAI_NEXT_DAY)).toBe("[date] 2026-10-16 Fri (Asia/Shanghai)");
  });

  it("a different zone keeps the previous calendar day for the same instant", () => {
    const src = createDateTimeSource({ timeZone: "UTC" });
    expect(src.marker(AT_SHANGHAI_NEXT_DAY)).toBe("[date] 2026-10-15 Thu (UTC)");
  });

  it("an invalid injected timeZone falls back to the host zone without throwing", () => {
    const src = createDateTimeSource({ timeZone: "Not/AZone" });
    expect(src.timeZone.kind).toBe("iana");
    expect(src.marker(Date.now())).toMatch(/^\[date\] \d{4}-\d{2}-\d{2} [A-Z][a-z]{2} \(.+\)$/);
  });

  it("formats UTC offset labels", () => {
    expect(formatUtcOffset(480)).toBe("UTC+08:00");
    expect(formatUtcOffset(-330)).toBe("UTC-05:30");
    expect(formatUtcOffset(0)).toBe("UTC+00:00");
  });

  it("resolveTimeZone prefers the host IANA id and never throws", () => {
    expect(resolveTimeZone().kind).toBe("iana");
  });

  it("first turn is the bare marker; cross-day appends the short note", () => {
    const src = createDateTimeSource({ timeZone: TZ });
    const marker = src.marker(AT_SHANGHAI_SAME_DAY);
    expect(firstTurnContent(marker)).toBe(marker);
    expect(crossDayContent(marker)).toBe(`${marker} — 当前日期已变更`);
  });

  it("dateChanged: no baseline is not a cross-day; equal keys are not; different keys are", () => {
    expect(dateChanged(undefined, "2026-10-15")).toBe(false);
    expect(dateChanged("2026-10-15", "2026-10-15")).toBe(false);
    expect(dateChanged("2026-10-15", "2026-10-16")).toBe(true);
  });

  it("a midnight rollover inside one zone flips the date key", () => {
    const src = createDateTimeSource({ timeZone: TZ });
    expect(src.dateKey(AT_SHANGHAI_SAME_DAY)).toBe("2026-10-15");
    expect(src.dateKey(AT_SHANGHAI_NEXT_DAY)).toBe("2026-10-16");
    expect(dateChanged(src.dateKey(AT_SHANGHAI_SAME_DAY), src.dateKey(AT_SHANGHAI_NEXT_DAY))).toBe(true);
  });
});
