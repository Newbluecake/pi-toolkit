// #34 T-Q1 (plan §6.3): the renamed fabric quota key parses deterministically. The pre-#34 key is
// intentionally NOT read anywhere — it must be ignored silently like any other unknown key (default
// 10), never warn, and never surface in a parsed result. Both entry points are pinned: the block
// parser (`parseFabricSettings`) and the whole-file loader (`loadSettings`).
import { describe, expect, it, vi } from "vitest";
import { parseFabricSettings } from "../../src/fabric/settings.js";
import { DEFAULT_SETTINGS, loadSettings } from "../../src/config/settings.js";
import { SETTING_SPECS } from "../../src/config/setting-specs.js";

const LEGACY_KEY = "findingQuota"; // #34 legacy input

type Case = readonly [label: string, input: unknown, expected: number];
const CASES: readonly Case[] = [
  ["empty block falls back to the default", {}, 10],
  ["the new key is honoured", { reportQuota: 3 }, 3],
  ["the legacy key alone is ignored", { [LEGACY_KEY]: 3 }, 10],
  ["the legacy key loses when both are present", { [LEGACY_KEY]: 3, reportQuota: 5 }, 5],
  ["zero stays valid (unchanged rule)", { reportQuota: 0 }, 0],
  ["fractions floor (Math.floor)", { reportQuota: 2.7 }, 2],
  ["negative falls back", { reportQuota: -1 }, 10],
  ["non-object source falls back", "5", 10],
  ["NaN falls back", Number.NaN, 10],
  ["Infinity falls back", Number.POSITIVE_INFINITY, 10],
  ["null falls back", null, 10],
];

describe("#34 T-Q1: fabric.reportQuota parses deterministically (legacy key unread)", () => {
  for (const [label, input, expected] of CASES) {
    it(`${label} → reportQuota=${expected} (both entry points, no warn)`, () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        expect(parseFabricSettings(input).reportQuota).toBe(expected);
        expect(loadSettings({ fabric: input }).fabric.reportQuota).toBe(expected);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  }

  it("the legacy key never surfaces in a parsed result", () => {
    for (const parsed of [
      parseFabricSettings({}),
      parseFabricSettings({ [LEGACY_KEY]: 3 }),
      parseFabricSettings({ reportQuota: 3 }),
      loadSettings({ fabric: { [LEGACY_KEY]: 3 } }).fabric,
    ]) {
      expect(Object.hasOwn(parsed, LEGACY_KEY)).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain(LEGACY_KEY);
    }
  });

  it("DEFAULT_SETTINGS.fabric keeps the renamed key at the same position", () => {
    const keys = Object.keys(DEFAULT_SETTINGS.fabric);
    const i = keys.indexOf("reportQuota");
    expect(i).toBeGreaterThan(0);
    expect(keys[i - 1]).toBe("maxPerRun");
    expect(keys[i + 1]).toBe("directiveQuota");
    expect(keys).not.toContain(LEGACY_KEY);
    expect(DEFAULT_SETTINGS.fabric.reportQuota).toBe(10);
  });

  it("SETTING_SPECS carries the renamed spec and drops the pre-#34 one", () => {
    expect(SETTING_SPECS["fabric.reportQuota"]).toMatchObject({
      kind: "number",
      path: "fabric.reportQuota",
      integer: true,
      min: 0,
      description: "Report messages per sender run",
    });
    expect(SETTING_SPECS[`fabric.${LEGACY_KEY}`]).toBeUndefined();
    expect(Object.values(SETTING_SPECS).some((spec) => spec.path === `fabric.${LEGACY_KEY}`)).toBe(false);
  });
});
