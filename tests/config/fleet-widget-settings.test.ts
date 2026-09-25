import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings } from "../../src/config/settings.js";
import { SETTING_SPECS } from "../../src/config/setting-specs.js";

describe("config: fleetWidgetMaxRows (M-C2 — no longer clamped by pi's string-array widget cap)", () => {
  it("defaults to 20 when absent", () => {
    expect(DEFAULT_SETTINGS.fleetWidgetMaxRows).toBe(20);
    expect(loadSettings({}).fleetWidgetMaxRows).toBe(20);
  });

  it("accepts an in-range integer verbatim", () => {
    expect(loadSettings({ fleetWidgetMaxRows: 10 }).fleetWidgetMaxRows).toBe(10);
    expect(loadSettings({ fleetWidgetMaxRows: 1 }).fleetWidgetMaxRows).toBe(1);
    expect(loadSettings({ fleetWidgetMaxRows: 40 }).fleetWidgetMaxRows).toBe(40);
  });

  it("a non-integer value falls back to the default", () => {
    expect(loadSettings({ fleetWidgetMaxRows: 12.9 }).fleetWidgetMaxRows).toBe(20);
    expect(loadSettings({ fleetWidgetMaxRows: 1.5 }).fleetWidgetMaxRows).toBe(20);
  });

  it("out-of-range (0, negative, > 40) falls back to the default", () => {
    expect(loadSettings({ fleetWidgetMaxRows: 0 }).fleetWidgetMaxRows).toBe(20);
    expect(loadSettings({ fleetWidgetMaxRows: -3 }).fleetWidgetMaxRows).toBe(20);
    expect(loadSettings({ fleetWidgetMaxRows: 41 }).fleetWidgetMaxRows).toBe(20);
    expect(loadSettings({ fleetWidgetMaxRows: 1000 }).fleetWidgetMaxRows).toBe(20);
  });

  it("non-numeric junk falls back to the default field-by-field", () => {
    for (const bad of ["10", null, undefined, NaN, Infinity, {}]) {
      expect(loadSettings({ fleetWidgetMaxRows: bad }).fleetWidgetMaxRows).toBe(20);
    }
  });

  it("is registered in SETTING_SPECS as an integer 1-40 count knob", () => {
    const spec = SETTING_SPECS.fleetWidgetMaxRows;
    expect(spec).toBeDefined();
    expect(spec!.kind).toBe("number");
    expect(spec!.path).toBe("fleetWidgetMaxRows");
    if (spec!.kind === "number") {
      expect(spec!.integer).toBe(true);
      expect(spec!.min).toBe(1);
      expect(spec!.max).toBe(40);
    }
  });
});
