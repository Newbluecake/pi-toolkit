import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, TIME_SETTING_MS_PATHS } from "../../src/config/settings.js";
import {
  currentOf,
  defaultOf,
  isKnownSettingKey,
  parseSettingValue,
  SETTING_SPECS,
} from "../../src/config/setting-specs.js";
import { DEFAULT_TOPIC_SWITCH_SETTINGS } from "../../src/topic-switch/settings.js";

/**
 * topic-switch plan.md §P3b.1 ("settings.ts": AgentSettings.topicSwitch + default values +
 * parseTopicSwitchSettings(value.topicSwitch) + four *Ms TIME_SETTING_MS_PATHS entries) and
 * §P3b.1's setting-specs table (nine settable keys; debugAssumedTtlS is JSON-only and
 * deliberately excluded). The pure parser itself (`parseTopicSwitchSettings`) is already
 * exhaustively tested by `tests/topic-switch/settings.test.ts` (P1) — this file only covers the
 * config/settings.ts *S⇄*Ms wiring boundary and the SETTING_SPECS surface.
 */
describe("AgentSettings.topicSwitch default", () => {
  it("matches DEFAULT_TOPIC_SWITCH_SETTINGS exactly", () => {
    expect(DEFAULT_SETTINGS.topicSwitch).toEqual(DEFAULT_TOPIC_SWITCH_SETTINGS);
  });

  it("falls back to defaults for a missing/invalid block", () => {
    expect(loadSettings({}).topicSwitch).toEqual(DEFAULT_TOPIC_SWITCH_SETTINGS);
    expect(loadSettings({ topicSwitch: "nope" }).topicSwitch).toEqual(DEFAULT_TOPIC_SWITCH_SETTINGS);
  });
});

describe("topicSwitch.* file seconds ⇄ internal ms (TIME_SETTING_MS_PATHS)", () => {
  it("registers exactly the four duration fields, never the non-duration ones", () => {
    for (const path of [
      "topicSwitch.judgeTimeoutMs",
      "topicSwitch.confirmTimeoutMs",
      "topicSwitch.expirySlackMs",
      "topicSwitch.debugAssumedTtlMs",
    ]) {
      expect(TIME_SETTING_MS_PATHS, path).toContain(path);
    }
    expect(TIME_SETTING_MS_PATHS.filter((p) => p.startsWith("topicSwitch."))).toHaveLength(4);
    expect(TIME_SETTING_MS_PATHS).not.toContain("topicSwitch.costThresholdUsd");
    expect(TIME_SETTING_MS_PATHS).not.toContain("topicSwitch.minChars");
    expect(TIME_SETTING_MS_PATHS).not.toContain("topicSwitch.regrowTokens");
    expect(TIME_SETTING_MS_PATHS).not.toContain("topicSwitch.minConfidence");
  });

  it("judgeTimeoutS/confirmTimeoutS/expirySlackS round-trip through loadSettings into *Ms", () => {
    const settings = loadSettings({
      topicSwitch: { judgeTimeoutS: 12, confirmTimeoutS: 45, expirySlackS: 20 },
    });
    expect(settings.topicSwitch.judgeTimeoutMs).toBe(12_000);
    expect(settings.topicSwitch.confirmTimeoutMs).toBe(45_000);
    expect(settings.topicSwitch.expirySlackMs).toBe(20_000);
  });

  it("debugAssumedTtlS (JSON-only) also round-trips through the *S⇄*Ms boundary", () => {
    const settings = loadSettings({ topicSwitch: { debugAssumedTtlS: 20 } });
    expect(settings.topicSwitch.debugAssumedTtlMs).toBe(20_000);
    // 1–9.999s is an invalid non-zero band (src/topic-switch/settings.ts) → falls back to 0.
    const invalid = loadSettings({ topicSwitch: { debugAssumedTtlS: 5 } });
    expect(invalid.topicSwitch.debugAssumedTtlMs).toBe(0);
  });

  it("legacy *Ms keys are tolerated (identity conversion) by loadSettings, same as every other duration field", () => {
    const settings = loadSettings({ topicSwitch: { judgeTimeoutMs: 9_000 } });
    expect(settings.topicSwitch.judgeTimeoutMs).toBe(9_000);
  });

  it("out-of-domain *S values fall back to the field default (parseTopicSwitchSettings's own clamp)", () => {
    const settings = loadSettings({ topicSwitch: { judgeTimeoutS: 999 } }); // 999s > 30s max
    expect(settings.topicSwitch.judgeTimeoutMs).toBe(DEFAULT_TOPIC_SWITCH_SETTINGS.judgeTimeoutMs);
  });
});

describe("topicSwitch.* in SETTING_SPECS", () => {
  const expectedKeys = [
    "topicSwitch.enabled",
    "topicSwitch.costThresholdUsd",
    "topicSwitch.model",
    "topicSwitch.judgeTimeoutS",
    "topicSwitch.minConfidence",
    "topicSwitch.confirmTimeoutS",
    "topicSwitch.minChars",
    "topicSwitch.regrowTokens",
    "topicSwitch.expirySlackS",
  ];

  it("lists exactly the nine settable keys, each resolvable, min/max mirroring the parser's domain", () => {
    for (const key of expectedKeys) {
      expect(isKnownSettingKey(key), key).toBe(true);
      const spec = SETTING_SPECS[key]!;
      expect(defaultOf(spec), key).not.toBeUndefined();
      expect(currentOf(DEFAULT_SETTINGS, spec), key).not.toBe("(unset)");
    }
  });

  it("debugAssumedTtlS is NOT exposed in SETTING_SPECS (JSON-only live-acceptance seam)", () => {
    expect(isKnownSettingKey("topicSwitch.debugAssumedTtlS")).toBe(false);
    expect(Object.keys(SETTING_SPECS).some((k) => k.startsWith("topicSwitch.") && k.includes("debug"))).toBe(false);
  });

  it("no stray topicSwitch.* keys beyond the expected nine", () => {
    const actual = Object.keys(SETTING_SPECS).filter((k) => k.startsWith("topicSwitch."));
    expect(actual.sort()).toEqual([...expectedKeys].sort());
  });

  it("pins the default values shown by the editor/text command", () => {
    expect(defaultOf(SETTING_SPECS["topicSwitch.enabled"]!)).toBe(true);
    expect(defaultOf(SETTING_SPECS["topicSwitch.costThresholdUsd"]!)).toBe(0.5);
    expect(defaultOf(SETTING_SPECS["topicSwitch.model"]!)).toBe(""); // empty list joins to ""
    expect(defaultOf(SETTING_SPECS["topicSwitch.judgeTimeoutS"]!)).toBe(6);
    expect(defaultOf(SETTING_SPECS["topicSwitch.minConfidence"]!)).toBe(0.7);
    expect(defaultOf(SETTING_SPECS["topicSwitch.confirmTimeoutS"]!)).toBe(30);
    expect(defaultOf(SETTING_SPECS["topicSwitch.minChars"]!)).toBe(8);
    expect(defaultOf(SETTING_SPECS["topicSwitch.regrowTokens"]!)).toBe(100_000);
    expect(defaultOf(SETTING_SPECS["topicSwitch.expirySlackS"]!)).toBe(30);
  });

  it("topicSwitch.model is a csv-style spec: stored comma string ⇄ live topicSwitch.models list", () => {
    const spec = SETTING_SPECS["topicSwitch.model"]!;
    expect(spec.kind).toBe("string");
    expect(spec.csv).toBe(true);
    expect(spec.path).toBe("topicSwitch.models");
    // currentOf joins the live list into the stored-domain csv string
    const settings = loadSettings({ topicSwitch: { model: "a/b,c/d" } });
    expect(settings.topicSwitch.models).toEqual(["a/b", "c/d"]);
    expect(currentOf(settings, spec)).toBe("a/b,c/d");
    expect(currentOf(DEFAULT_SETTINGS, spec)).toBe("");
  });

  it("model list file forms all load: JSON array, csv string, single (legacy) string; garbage ⇒ default", () => {
    expect(loadSettings({ topicSwitch: { model: ["a/b", "c/d"] } }).topicSwitch.models).toEqual(["a/b", "c/d"]);
    expect(loadSettings({ topicSwitch: { model: "a/b, c/d" } }).topicSwitch.models).toEqual(["a/b", "c/d"]);
    expect(loadSettings({ topicSwitch: { model: "a/b" } }).topicSwitch.models).toEqual(["a/b"]);
    expect(loadSettings({ topicSwitch: { model: 7 } }).topicSwitch.models).toEqual([]);
    expect(loadSettings({ topicSwitch: { model: null } }).topicSwitch.models).toEqual([]);
    expect(loadSettings({}).topicSwitch.models).toEqual([]);
  });

  it("parseSettingValue round-trips the csv surface: input string → stored csv + live array; empty clears", () => {
    const spec = SETTING_SPECS["topicSwitch.model"]!;
    const parsed = parseSettingValue(spec, "x/one, x/two,,");
    expect(parsed).toEqual({ ok: true, stored: "x/one,x/two", live: ["x/one", "x/two"] });
    const cleared = parseSettingValue(spec, "");
    expect(cleared).toEqual({ ok: true, stored: "", live: [] });
  });

  it("costThresholdUsd / minConfidence / minChars specs mirror the parser's min/max domain", () => {
    const cost = SETTING_SPECS["topicSwitch.costThresholdUsd"]!;
    expect(cost.kind).toBe("number");
    if (cost.kind === "number") {
      expect(cost.min).toBe(0.01);
      expect(cost.max).toBe(100);
    }
    const confidence = SETTING_SPECS["topicSwitch.minConfidence"]!;
    if (confidence.kind === "number") {
      expect(confidence.min).toBe(0);
      expect(confidence.max).toBe(1);
    }
    const minChars = SETTING_SPECS["topicSwitch.minChars"]!;
    if (minChars.kind === "number") {
      expect(minChars.min).toBe(0);
      expect(minChars.max).toBe(200);
    }
  });

  it("every description mentions privacy for the judge-model field (plan §1: 隐私说明)", () => {
    const spec = SETTING_SPECS["topicSwitch.model"]!;
    expect(spec.description?.toLowerCase()).toContain("sends the new request and a short excerpt");
  });
});
