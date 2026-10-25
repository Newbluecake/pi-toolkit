/**
 * scheduled-reports plan r3 §4.4 (S1): tz-aware cron core — field-wise enumeration, the two DST
 * rules (non-existent local minute ⇒ no occurrence; ambiguous ⇒ the EARLIER offset only), the
 * budgets (next horizon 400d / 50 000 candidates, count cap 10 000) and the single shared
 * `countOccurrences(a, b]` the agent (missedLog) and the hub (reconciliation) both call.
 */
import { describe, expect, it } from "vitest";
import {
  compileWhen,
  countOccurrences,
  isOccurrence,
  isValidTimeZone,
  nextOccurrence,
  occurrencesBetween,
  parseCron,
  validateWhen,
  type CompiledWhen,
} from "../../../src/schedule/core/cron.js";
import type { ScheduleWhen } from "../../../src/schedule/core/spec.js";

const MIN = 60_000;
const H = 3_600_000;
const D = 24 * H;
const utc = (s: string): number => Date.parse(s);

function compiled(when: ScheduleWhen): CompiledWhen {
  const r = compileWhen(when);
  if (!r.ok) throw new Error(r.error);
  return r.when;
}
const cron = (expr: string, tz: string): CompiledWhen => compiled({ kind: "cron", expr, tz });

describe("parseCron", () => {
  it("accepts the 5-field grammar: lists, ranges, steps, names, 7=Sunday", () => {
    const ok = [
      "* * * * *",
      "*/15 9-17 * * 1-5",
      "0 8 1,15 * *",
      "5-50/5 0 * jan-mar MON",
      "0 0 * * 7",
      "0 0 * * sun",
      "10/20 * * * *",
      "  0   8  *  *  *  ",
    ];
    for (const e of ok) expect(parseCron(e).ok, e).toBe(true);
    const p = parseCron("0 0 * * 7");
    expect(p.ok && p.fields.dow).toEqual([0]);
  });

  it("rejects malformed expressions", () => {
    const bad = [
      "",
      "* * * *",
      "* * * * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * 32 * *",
      "* * * 13 *",
      "* * * * 8",
      "*/0 * * * *",
      "5-1 * * * *",
      "1,,2 * * * *",
      "a * * * *",
      "@daily",
      "1.5 * * * *",
      "-1 * * * *",
      `${"1,".repeat(80)}1 * * * *`,
    ];
    for (const e of bad) expect(parseCron(e).ok, e).toBe(false);
  });
});

describe("time zones", () => {
  it("accepts IANA zones Intl supports and refuses the rest", () => {
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
    expect(isValidTimeZone("+08:00")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(compileWhen({ kind: "cron", expr: "* * * * *", tz: "Nope/Zone" }).ok).toBe(false);
  });
});

describe("nextOccurrence", () => {
  it("fixed-offset zone: daily 08:00 Asia/Shanghai; `after` is exclusive", () => {
    const c = cron("0 8 * * *", "Asia/Shanghai");
    expect(nextOccurrence(c, utc("2026-10-23T23:59:00Z"))).toBe(utc("2026-10-24T00:00:00Z"));
    expect(nextOccurrence(c, utc("2026-10-24T00:00:00Z"))).toBe(utc("2026-10-25T00:00:00Z"));
  });

  it("DST spring-forward (America/New_York 2026-03-08): the non-existent 02:30 yields no occurrence", () => {
    const c = cron("30 2 * * *", "America/New_York");
    // Mar 7 02:30 EST = 07:30Z → next is Mar 9 02:30 EDT = 06:30Z (Mar 8 has no 02:30).
    expect(nextOccurrence(c, utc("2026-03-07T07:30:00Z"))).toBe(utc("2026-03-09T06:30:00Z"));
  });

  it("DST fall-back (America/New_York 2026-11-01): the ambiguous 01:30 maps to the EARLIER offset only", () => {
    const c = cron("30 1 * * *", "America/New_York");
    const first = nextOccurrence(c, utc("2026-10-31T12:00:00Z"));
    expect(first).toBe(utc("2026-11-01T05:30:00Z")); // 01:30 EDT
    expect(isOccurrence(c, utc("2026-11-01T05:30:00Z"))).toBe(true);
    expect(isOccurrence(c, utc("2026-11-01T06:30:00Z"))).toBe(false); // 01:30 EST, second instance
    expect(nextOccurrence(c, first!)).toBe(utc("2026-11-02T06:30:00Z")); // next day 01:30 EST
  });

  it("half-hour DST shift (Australia/Lord_Howe 2026-10-04 02:00→02:30): 02:15 skipped", () => {
    const c = cron("15 2 * * *", "Australia/Lord_Howe");
    // Oct 3 02:15 LHST(+10:30) = Oct 2 15:45Z; Oct 4 02:15 does not exist; Oct 5 02:15 LHDT(+11) = Oct 4 15:15Z.
    expect(nextOccurrence(c, utc("2026-10-02T15:45:00Z"))).toBe(utc("2026-10-04T15:15:00Z"));
  });

  it("dom/dow both restricted ⇒ OR (Vixie); a `*`-led field ⇒ AND", () => {
    const or = cron("0 0 13 * 5", "UTC"); // 13th OR Friday
    // 2026-11-01 is a Sunday; first Friday is Nov 6, the 13th is also a Friday.
    expect(nextOccurrence(or, utc("2026-11-01T00:00:00Z"))).toBe(utc("2026-11-06T00:00:00Z"));
    const and = cron("0 0 */2 * 5", "UTC"); // odd days AND Friday
    // Fridays in Nov 2026: 6, 13, 20, 27 → first odd one is the 13th.
    expect(nextOccurrence(and, utc("2026-11-01T00:00:00Z"))).toBe(utc("2026-11-13T00:00:00Z"));
  });

  it("never-hitting expression ⇒ undefined (400-day horizon); a tiny candidate budget ⇒ undefined", () => {
    expect(nextOccurrence(cron("0 0 30 2 *", "UTC"), utc("2026-01-01T00:00:00Z"))).toBeUndefined();
    const c = cron("59 23 31 12 *", "UTC");
    const after = utc("2026-01-01T00:00:00Z");
    expect(nextOccurrence(c, after)).toBe(utc("2026-12-31T23:59:00Z"));
    expect(nextOccurrence(c, after, { candidateBudget: 10 })).toBeUndefined();
    expect(nextOccurrence(c, after, { horizonMs: 100 * D })).toBeUndefined();
  });

  it("is independent of the process time zone", () => {
    const exprs: Array<[string, string]> = [
      ["30 1 * * *", "America/New_York"],
      ["*/20 * * * *", "Europe/London"],
      ["0 9 * * 1-5", "Asia/Kolkata"],
    ];
    const run = (): number[] =>
      exprs.flatMap(([e, tz]) =>
        occurrencesBetween(cron(e, tz), utc("2026-10-20T00:00:00Z"), utc("2026-11-05T00:00:00Z"), 400),
      );
    const prev = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const a = run();
      process.env.TZ = "Pacific/Kiritimati";
      const b = run();
      process.env.TZ = "America/Los_Angeles";
      const c = run();
      expect(a.length).toBeGreaterThan(100);
      expect(b).toEqual(a);
      expect(c).toEqual(a);
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });
});

describe("countOccurrences (the ONE shared counter)", () => {
  it("counts (a, b] — left exclusive, right inclusive", () => {
    const c = cron("0 * * * *", "UTC");
    const a = utc("2026-10-24T08:00:00Z");
    expect(countOccurrences(c, a, a + 3 * H)).toEqual({ count: 3, capped: false });
    expect(countOccurrences(c, a - 1, a + 3 * H)).toEqual({ count: 4, capped: false });
    expect(countOccurrences(c, a, a + 3 * H - 1)).toEqual({ count: 2, capped: false });
    expect(countOccurrences(c, a, a)).toEqual({ count: 0, capped: false });
    expect(countOccurrences(c, a + H, a)).toEqual({ count: 0, capped: false });
  });

  it("DST days: 23 hourly on spring-forward, 48 half-hourly on the 25-hour fall-back day", () => {
    const hourly = cron("0 * * * *", "America/New_York");
    // local Mar 8 00:00 EST = 05:00Z … local Mar 9 00:00 EDT = 04:00Z
    expect(countOccurrences(hourly, utc("2026-03-08T05:00:00Z") - 1, utc("2026-03-09T04:00:00Z") - 1).count).toBe(23);
    const half = cron("*/30 * * * *", "America/New_York");
    // local Nov 1 00:00 EDT = 04:00Z … local Nov 2 00:00 EST = 05:00Z (25 real hours)
    expect(countOccurrences(half, utc("2026-11-01T04:00:00Z") - 1, utc("2026-11-02T05:00:00Z") - 1).count).toBe(48);
    expect(countOccurrences(half, utc("2026-03-08T05:00:00Z") - 1, utc("2026-03-09T04:00:00Z") - 1).count).toBe(46);
  });

  it("each local wall time maps to at most one instant (ascending, unique) across a DST year", () => {
    const c = cron("*/15 * * * *", "America/New_York");
    const ts = occurrencesBetween(c, utc("2026-01-01T00:00:00Z"), utc("2027-01-01T00:00:00Z"), 100_000);
    for (let i = 1; i < ts.length; i++) expect(ts[i]! > ts[i - 1]!).toBe(true);
    // 365 days × 96, minus 2 non-existent quarter hours… minus 4 on spring day (02:00–02:45)
    expect(ts.length).toBe(365 * 96 - 4);
  });

  it("caps at 10 000 and flags it", () => {
    const c = cron("* * * * *", "UTC");
    const a = utc("2026-10-01T00:00:00Z");
    expect(countOccurrences(c, a, a + 30 * D)).toEqual({ count: 10_000, capped: true });
    // exactly 10 000 in range ⇒ not capped
    expect(countOccurrences(c, a, a + 10_000 * MIN)).toEqual({ count: 10_000, capped: false });
  });

  it("once: 1 iff a < at ≤ b", () => {
    const c = compiled({ kind: "once", at: "2026-10-25T08:00", tz: "Asia/Shanghai" });
    const t = utc("2026-10-25T00:00:00Z");
    expect(countOccurrences(c, t - 1, t).count).toBe(1);
    expect(countOccurrences(c, t, t + D).count).toBe(0);
    expect(nextOccurrence(c, t - 1)).toBe(t);
    expect(nextOccurrence(c, t)).toBeUndefined();
    expect(isOccurrence(c, t)).toBe(true);
  });
});

describe("once compile / validateWhen", () => {
  it("once in an ambiguous local time takes the earlier offset; a non-existent one is invalid", () => {
    const amb = compiled({ kind: "once", at: "2026-11-01T01:30", tz: "America/New_York" });
    expect(nextOccurrence(amb, utc("2026-10-01T00:00:00Z"))).toBe(utc("2026-11-01T05:30:00Z"));
    expect(compileWhen({ kind: "once", at: "2026-03-08T02:30", tz: "America/New_York" }).ok).toBe(false);
    for (const bad of [
      "2026-13-01T00:00",
      "2026-02-30T08:00",
      "2026-1-1T8:00",
      "2026-10-25 08:00",
      "2026-10-25T08:00:00",
    ]) {
      expect(compileWhen({ kind: "once", at: bad, tz: "UTC" }).ok, bad).toBe(false);
    }
  });

  it("requires at least one hit within 400 days of now", () => {
    const now = utc("2026-10-24T00:00:00Z");
    expect(validateWhen({ kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" }, now).ok).toBe(true);
    expect(validateWhen({ kind: "cron", expr: "0 0 30 2 *", tz: "UTC" }, now).ok).toBe(false);
    expect(validateWhen({ kind: "once", at: "2026-10-23T08:00", tz: "UTC" }, now).ok).toBe(false); // past
    expect(validateWhen({ kind: "once", at: "2028-10-23T08:00", tz: "UTC" }, now).ok).toBe(false); // > 400d
    expect(validateWhen({ kind: "once", at: "2026-10-25T08:00", tz: "UTC" }, now).ok).toBe(true);
    expect(validateWhen({ kind: "cron", expr: "0 8 * * *", tz: "Bad/Zone" }, now).ok).toBe(false);
  });
});
