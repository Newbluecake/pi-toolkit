// Migrated from the retired tests/schedule/cron.test.ts (old global engine, A0): the two behaviours
// still relevant — five-field lists/steps and "next" across an hour / month boundary — re-pinned on
// the tz-aware core (explicit UTC instead of the old process-local Date).
import { describe, expect, it } from "vitest";
import { compileWhen, nextOccurrence, parseCron } from "../../../src/schedule/core/cron.js";

const at = (iso: string) => Date.parse(`${iso}Z`);
const compile = (expr: string) => {
  const r = compileWhen({ kind: "cron", expr, tz: "UTC" });
  if (!r.ok) throw new Error(r.error);
  return r.when;
};

describe("legacy cron behaviours on the core parser", () => {
  it("parses lists and steps; rejects out-of-range and wrong arity", () => {
    expect(parseCron("*/15 9,10 1-5 1,12 0").ok).toBe(true);
    expect(parseCron("60 * * * *").ok).toBe(false);
    expect(parseCron("* * * *").ok).toBe(false);
  });
  it("finds the next minute across an hour and a month boundary", () => {
    expect(nextOccurrence(compile("5 * * * *"), at("2026-01-01T12:05:00"))).toBe(at("2026-01-01T13:05:00"));
    expect(nextOccurrence(compile("0 0 1 * *"), at("2026-01-31T23:59:00"))).toBe(at("2026-02-01T00:00:00"));
  });
});
