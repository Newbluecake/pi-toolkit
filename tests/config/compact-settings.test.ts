import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, parseCompactSettings } from "../../src/config/settings.js";

const defaults = DEFAULT_SETTINGS.compact;

describe("compact settings", () => {
  it("pins the enabled-by-default value", () => {
    expect(defaults).toEqual({
      enabled: true,
      hintThresholdPercent: 75,
      forceAtPercent: 88,
      forceScaling: true,
      hintThresholdTokens: 500,
      forceAtTokens: 0,
      usageTickStepPercent: 10,
    });
  });

  it("falls back for missing and non-object blocks", () => {
    for (const input of [undefined, null, 0, "nope", true, [], [1, 2]]) {
      expect(parseCompactSettings(input)).toEqual(defaults);
    }
    expect(parseCompactSettings({})).toEqual(defaults);
  });

  it("falls back when enabled is not boolean", () => {
    for (const enabled of [undefined, null, 0, "true", [], {}, () => true]) {
      expect(parseCompactSettings({ enabled })).toEqual(defaults);
    }
    expect(parseCompactSettings({ enabled: false })).toEqual({
      enabled: false,
      hintThresholdPercent: 75,
      forceAtPercent: 88,
      forceScaling: true,
      hintThresholdTokens: 500,
      forceAtTokens: 0,
      usageTickStepPercent: 10,
    });
  });

  it("parses absolute token thresholds with 0=off and force>hint validation", () => {
    // Explicit values pass through (floored).
    expect(parseCompactSettings({ hintThresholdTokens: 300, forceAtTokens: 500 })).toMatchObject({
      hintThresholdTokens: 300,
      forceAtTokens: 500,
    });
    expect(parseCompactSettings({ hintThresholdTokens: 250.9 }).hintThresholdTokens).toBe(250);
    // 0 disables the absolute line explicitly.
    expect(parseCompactSettings({ hintThresholdTokens: 0 }).hintThresholdTokens).toBe(0);
    // Invalid values fall back to the 500k default.
    for (const invalid of [-1, Number.NaN, "400", null, Infinity]) {
      expect(parseCompactSettings({ hintThresholdTokens: invalid }).hintThresholdTokens).toBe(500);
    }
    // forceAtTokens defaults to 0 and accepts 0.
    expect(parseCompactSettings({}).forceAtTokens).toBe(0);
    expect(parseCompactSettings({ forceAtTokens: 0 }).forceAtTokens).toBe(0);
    // forceAtTokens > 0 must exceed the configured hint token line (mirror of
    // the force>hint percent rule): 300 <= 500 default → falls back to 0;
    // but 300 is fine when the hint line is explicitly lowered.
    expect(parseCompactSettings({ forceAtTokens: 300 }).forceAtTokens).toBe(0);
    expect(parseCompactSettings({ hintThresholdTokens: 200, forceAtTokens: 300 }).forceAtTokens).toBe(300);
    expect(parseCompactSettings({ hintThresholdTokens: 0, forceAtTokens: 300 }).forceAtTokens).toBe(300);
    for (const invalid of [-5, Number.NaN, "500"]) {
      expect(parseCompactSettings({ forceAtTokens: invalid }).forceAtTokens).toBe(0);
    }
  });

  it("returns a fresh object and is wired into loadSettings", () => {
    const parsed = parseCompactSettings({});
    expect(parsed).not.toBe(defaults);
    parsed.enabled = false;
    expect(defaults.enabled).toBe(true);
    expect(loadSettings({ compact: { enabled: false } }).compact).toEqual({
      enabled: false,
      hintThresholdPercent: 75,
      forceAtPercent: 88,
      forceScaling: true,
      hintThresholdTokens: 500,
      forceAtTokens: 0,
      usageTickStepPercent: 10,
    });
    expect(loadSettings({ compact: "invalid" }).compact).toEqual(defaults);
    expect(parseCompactSettings({ hintThresholdPercent: 60, assumedReserveTokens: 32768 })).toEqual({
      enabled: true,
      hintThresholdPercent: 60,
      forceAtPercent: 88,
      forceScaling: true,
      hintThresholdTokens: 500,
      forceAtTokens: 0,
      usageTickStepPercent: 10,
      assumedReserveTokens: 32768,
    });
    expect(parseCompactSettings({ hintThresholdPercent: 0 })).toEqual({
      enabled: true,
      hintThresholdPercent: 0,
      forceAtPercent: 88,
      forceScaling: true,
      hintThresholdTokens: 500,
      forceAtTokens: 0,
      usageTickStepPercent: 10,
    });
    expect(parseCompactSettings({ hintThresholdPercent: 0.5 })).toEqual(defaults);
    expect(parseCompactSettings({ hintThresholdPercent: 75, forceAtPercent: 0 })).toMatchObject({ forceAtPercent: 0 });
    expect(parseCompactSettings({ hintThresholdPercent: 75, forceAtPercent: 88 })).toMatchObject({
      forceAtPercent: 88,
      forceScaling: true,
    });
    expect(parseCompactSettings({ hintThresholdPercent: 75, forceAtPercent: 75 })).toMatchObject({
      forceAtPercent: 88,
      forceScaling: true,
    });
    expect(parseCompactSettings({ hintThresholdPercent: 75, forceAtPercent: "88" })).toMatchObject({
      forceAtPercent: 88,
      forceScaling: true,
    });
    expect(parseCompactSettings({ hintThresholdPercent: 101, assumedReserveTokens: -1 })).toEqual(defaults);
  });

  it("parses forceScaling with a true default and literal opt-out", () => {
    // Default on: the configured forceAtPercent is a 1M-window anchor.
    expect(parseCompactSettings({}).forceScaling).toBe(true);
    expect(parseCompactSettings({ forceAtPercent: 90 }).forceScaling).toBe(true);
    // Explicit opt-out keeps the percentage literal on every window.
    expect(parseCompactSettings({ forceScaling: false }).forceScaling).toBe(false);
    expect(parseCompactSettings({ forceAtPercent: 90, forceScaling: false }).forceScaling).toBe(false);
    for (const invalid of ["true", 1, null, [], {}, undefined]) {
      expect(parseCompactSettings({ forceScaling: invalid }).forceScaling).toBe(true);
    }
  });

  it("parses usageTickStepPercent with 0=off and a 5% minimum", () => {
    expect(parseCompactSettings({ usageTickStepPercent: 0 }).usageTickStepPercent).toBe(0);
    expect(parseCompactSettings({ usageTickStepPercent: 15 }).usageTickStepPercent).toBe(15);
    for (const invalid of [1, 4, -10, 101, "10", null, Number.NaN]) {
      expect(parseCompactSettings({ usageTickStepPercent: invalid }).usageTickStepPercent).toBe(10);
    }
  });
});
