import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { DEFAULT_SETTINGS, TIME_SETTING_MS_PATHS, loadSettings, mergeBudget } from "../../src/config/settings.js";
import { SETTING_SPECS, defaultOf, parseSettingValue, writeSetting } from "../../src/config/setting-specs.js";
import { migrateTimeUnitsToSeconds } from "../../src/config/time-units.js";

describe("#62 product defaults, not personal settings", () => {
  it("uses actual 1800s floor / 600s grace across all settings defaults", () => {
    for (const b of [DEFAULT_BUDGET, DEFAULT_SETTINGS.budget, loadSettings({}).budget, mergeBudget()]) {
      expect(b.minTotalMs).toBe(1_800_000);
      expect(b.totalGraceMs).toBe(600_000);
      expect(b.totalMs).toBe(1_800_000);
    }
    expect(loadSettings({ budget: { totalS: 7200 } }).budget).toMatchObject({
      totalMs: 7_200_000,
      minTotalMs: 1_800_000,
      totalGraceMs: 600_000,
    });
  });
  it.each([0, 1, 30, 1800])("accepts host minTotalS=%s in seconds and preserves grace overrides", (minTotalS) => {
    expect(loadSettings({ budget: { minTotalS, totalGraceS: 42 } }).budget).toMatchObject({
      minTotalMs: minTotalS * 1000,
      totalGraceMs: 42_000,
    });
  });
  it.each([NaN, Infinity, -Infinity, -1, "wrong", null])(
    "invalid floor %s falls back without poisoning total",
    (minTotalS) => {
      expect(loadSettings({ budget: { minTotalS, totalS: 7200 } }).budget).toMatchObject({
        minTotalMs: 1_800_000,
        totalMs: 7_200_000,
      });
      expect(mergeBudget({ minTotalMs: 20_000 }, { minTotalMs: minTotalS as number }).minTotalMs).toBe(20_000);
    },
  );
  it("declares seconds/live/min0 with the correct defaults", () => {
    const spec = SETTING_SPECS["budget.minTotalS"]!;
    expect(spec).toMatchObject({ path: "budget.minTotalMs", time: true, live: true, min: 0 });
    expect(defaultOf(spec)).toBe(1800);
    expect(defaultOf(SETTING_SPECS["budget.totalGraceS"]!)).toBe(600);
    expect(TIME_SETTING_MS_PATHS).toContain("budget.minTotalMs");
    expect(parseSettingValue(spec, "-1").ok).toBe(false);
  });
  it("live editor persists seconds but mutates only the new-run host budget in ms", () => {
    const current = loadSettings({});
    const admittedBeforeEdit = mergeBudget(current.budget);
    const stored: unknown[] = [];
    const spec = SETTING_SPECS["budget.minTotalS"]!;
    const parsed = parseSettingValue(spec, "30");
    if (!parsed.ok) throw Error(parsed.error);
    expect(parsed).toEqual({ ok: true, stored: 30, live: 30_000 });
    const result = writeSetting(
      {
        current,
        path: "/unused/test-settings.json",
        persist: (key, value) => {
          stored.push([key, value]);
          return undefined;
        },
      },
      "budget.minTotalS",
      parsed,
    );
    expect(stored).toEqual([["budget.minTotalS", 30]]);
    expect(current.budget.minTotalMs).toBe(30_000);
    expect(admittedBeforeEdit.minTotalMs).toBe(1_800_000);
    expect(result.effect).toBe("applies to new runs immediately");
  });
  it("the time-unit migration converts a legacy minTotalMs to seconds", () => {
    const migrated = migrateTimeUnitsToSeconds({ budget: { minTotalMs: 30_000 } }, TIME_SETTING_MS_PATHS);
    expect(migrated.value).toEqual({ budget: { minTotalS: 30 } });
    expect(migrated.changed).toBe(true);
    expect(migrated.warnings).toEqual([]);
  });
});
