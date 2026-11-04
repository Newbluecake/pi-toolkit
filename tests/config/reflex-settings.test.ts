import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings } from "../../src/config/settings.js";
import {
  currentOf,
  isKnownSettingKey,
  parseSettingValue,
  SETTING_SPECS,
  settingKeys,
} from "../../src/config/setting-specs.js";
import { DEFAULT_REFLEX_SETTINGS, parseReflexSettings } from "../../src/reflex/core/settings.js";

describe("parseReflexSettings (never throws, field-by-field fallback)", () => {
  it("defaults are off with an empty autoResolve and are frozen", () => {
    expect(DEFAULT_REFLEX_SETTINGS).toEqual({ enabled: false, autoResolve: [] });
    expect(Object.isFrozen(DEFAULT_REFLEX_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_REFLEX_SETTINGS.autoResolve)).toBe(true);
  });

  it.each([undefined, null, "x", 3, [], true])("garbage block %j ⇒ defaults", (input) => {
    expect(parseReflexSettings(input)).toEqual({ enabled: false, autoResolve: [] });
  });

  it("wrong-typed fields fall back independently", () => {
    expect(parseReflexSettings({ enabled: "yes", autoResolve: "quota.summary" })).toEqual({
      enabled: false,
      autoResolve: ["quota.summary"],
    });
    expect(parseReflexSettings({ enabled: true, autoResolve: 5 })).toEqual({ enabled: true, autoResolve: [] });
  });

  it("autoResolve accepts csv or array: trimmed, empties dropped, deduped, order kept", () => {
    expect(parseReflexSettings({ autoResolve: " quota.summary , jobs.list,,quota.summary " }).autoResolve).toEqual([
      "quota.summary",
      "jobs.list",
    ]);
    expect(parseReflexSettings({ autoResolve: ["b.x", " a.y ", "b.x", 7, "c.z,d.w"] }).autoResolve).toEqual([
      "b.x",
      "a.y",
      "c.z",
      "d.w",
    ]);
  });

  it("returns a fresh array each time (the frozen default is never aliased)", () => {
    const a = parseReflexSettings({});
    const b = parseReflexSettings({});
    expect(a.autoResolve).not.toBe(b.autoResolve);
    expect(a.autoResolve).not.toBe(DEFAULT_REFLEX_SETTINGS.autoResolve);
  });
});

describe("AgentSettings.reflex wiring", () => {
  it("default equals the module default and is not an alias of it", () => {
    expect(DEFAULT_SETTINGS.reflex).toEqual({ enabled: false, autoResolve: [] });
    expect(DEFAULT_SETTINGS.reflex.autoResolve).not.toBe(DEFAULT_REFLEX_SETTINGS.autoResolve);
  });

  it("loadSettings parses the block; missing / invalid block ⇒ default", () => {
    expect(loadSettings({ reflex: { enabled: true, autoResolve: "jobs.list" } }).reflex).toEqual({
      enabled: true,
      autoResolve: ["jobs.list"],
    });
    expect(loadSettings({}).reflex).toEqual({ enabled: false, autoResolve: [] });
    expect(loadSettings({ reflex: "nope" }).reflex).toEqual({ enabled: false, autoResolve: [] });
  });
});

describe("reflex setting specs", () => {
  it("exposes exactly the two keys, appended at the END of the table", () => {
    const keys = settingKeys();
    expect(keys.filter((k) => k.startsWith("reflex."))).toEqual(["reflex.enabled", "reflex.autoResolve"]);
    expect(keys.slice(-2)).toEqual(["reflex.enabled", "reflex.autoResolve"]);
    expect(isKnownSettingKey("reflex.enabled")).toBe(true);
  });

  it("enabled is a non-live boolean; autoResolve is a live csv string over the string[] field", () => {
    const enabled = SETTING_SPECS["reflex.enabled"]!;
    expect(enabled.kind).toBe("boolean");
    expect(enabled.live).toBeUndefined();
    const auto = SETTING_SPECS["reflex.autoResolve"]!;
    expect(auto.kind).toBe("string");
    expect(auto.live).toBe(true);
    expect("csv" in auto && auto.csv).toBe(true);
    expect(parseSettingValue(auto, " quota.summary , jobs.list ")).toEqual({
      ok: true,
      stored: "quota.summary,jobs.list",
      live: ["quota.summary", "jobs.list"],
    });
  });

  it("currentOf reads the live value in the stored (csv) domain", () => {
    const s = loadSettings({ reflex: { enabled: true, autoResolve: ["a.b", "c.d"] } });
    expect(currentOf(s, SETTING_SPECS["reflex.enabled"]!)).toBe(true);
    expect(currentOf(s, SETTING_SPECS["reflex.autoResolve"]!)).toBe("a.b,c.d");
  });
});
