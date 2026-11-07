import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, mergeSettings } from "../../src/config/settings.js";
import { currentOf, defaultOf, parseSettingValue, SETTING_SPECS } from "../../src/config/setting-specs.js";

describe("fast settings contract", () => {
  it("defaults to enabled without introducing a global mode", () => {
    expect(DEFAULT_SETTINGS.fast).toEqual({ enabled: true });
    expect(loadSettings({}).fast).toEqual({ enabled: true });
    expect(mergeSettings().fast).toEqual({ enabled: true });
    expect(Object.keys(DEFAULT_SETTINGS.fast)).toEqual(["enabled"]);
  });

  it("accepts explicit false independently of other settings", () => {
    expect(loadSettings({ fast: { enabled: false } }).fast).toEqual({ enabled: false });
    expect(loadSettings({ fast: { enabled: true } }).fast).toEqual({ enabled: true });
    const oldCaller = loadSettings({ concurrencyLimit: 2, date: { enabled: false } });
    expect(oldCaller.concurrencyLimit).toBe(2);
    expect(oldCaller.date.enabled).toBe(false);
    expect(oldCaller.fast).toEqual({ enabled: true });
  });

  it("uses the existing enabled-group tolerant parsing rules", () => {
    for (const fast of [undefined, null, false, true, 0, "false", [], [false], {}]) {
      expect(loadSettings({ fast }).fast).toEqual({ enabled: true });
    }
    for (const enabled of [undefined, null, 0, 1, "false", "true", [], {}, NaN]) {
      expect(loadSettings({ fast: { enabled } }).fast).toEqual({ enabled: true });
    }
    expect(loadSettings({ fast: { enabled: false, mode: "on" } }).fast).toEqual({ enabled: false });
    expect(DEFAULT_SETTINGS.fast.enabled).toBe(true);
  });

  it("exposes a validated boolean, non-live setting with a resolvable default", () => {
    const spec = SETTING_SPECS["fast.enabled"]!;
    expect(spec.kind).toBe("boolean");
    expect(spec.path).toBe("fast.enabled");
    expect(spec.live).toBeUndefined();
    expect(spec.description).toContain("inherit");
    expect(parseSettingValue(spec, "false")).toEqual({ ok: true, stored: false, live: false });
    expect(parseSettingValue(spec, "true")).toEqual({ ok: true, stored: true, live: true });
    expect(parseSettingValue(spec, "inherit")).toEqual({ ok: false, error: "expected true/false" });
    expect(defaultOf(spec)).toBe(true);
    expect(currentOf(loadSettings({ fast: { enabled: false } }), spec)).toBe(false);
    expect(Object.keys(SETTING_SPECS).filter((key) => key.startsWith("fast."))).toEqual(["fast.enabled"]);
  });
});
