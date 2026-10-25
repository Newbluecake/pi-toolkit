import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, TIME_SETTING_MS_PATHS } from "../../src/config/settings.js";
import { isKnownSettingKey, SETTING_SPECS } from "../../src/config/setting-specs.js";

// #40: the consult subsystem and its `consult.*` settings were removed. A settings file that
// still carries the block must load exactly like one without it — silently (no throw, no warn).
const LEGACY_BLOCK = {
  enabled: false,
  timeoutS: 90,
  maxAnswerChars: 100,
  maxTurns: 5,
  maxFirstRequestUsd: 1.5,
  maxCostUsd: 3,
  maxConcurrent: 4,
};

describe("legacy consult.* settings block is ignored (#40)", () => {
  it("has no consult group in the defaults, the specs or the time-key list", () => {
    expect(Object.keys(DEFAULT_SETTINGS)).not.toContain("consult");
    expect(Object.keys(SETTING_SPECS).filter((k) => k.startsWith("consult."))).toEqual([]);
    expect(isKnownSettingKey("consult.enabled")).toBe(false);
    expect(TIME_SETTING_MS_PATHS.filter((p) => p.startsWith("consult."))).toEqual([]);
  });

  it("loads a file with a full consult block identically to one without it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const baseline = loadSettings({});
      const withLegacy = loadSettings({ consult: LEGACY_BLOCK });
      expect(withLegacy).toEqual(baseline);
      expect(Object.keys(withLegacy)).not.toContain("consult");
      for (const junk of ["invalid", 7, null, [], { timeoutS: "x", maxTurns: -1 }]) {
        expect(loadSettings({ consult: junk })).toEqual(baseline);
      }
      // A legacy block next to real settings must not disturb them.
      const mixed = loadSettings({ consult: LEGACY_BLOCK, goal: { maxTurns: 7 } });
      expect(mixed.goal.maxTurns).toBe(7);
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
