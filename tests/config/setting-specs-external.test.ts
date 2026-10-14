// external-agent plan §6.2 P4a 验收③：TUI 设置面（SETTING_SPECS）只暴露
// `externalAgents.droid.{enabled,injectMemory,protocolCheck}` 三个叶子；其余
// `externalAgents.droid.*`（binary / models / advertiseMax / pricing / 各超时）
// 是 JSON-only 设置，故意不进表。

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import {
  currentOf,
  defaultOf,
  isKnownSettingKey,
  parseSettingValue,
  SETTING_SPECS,
  settingKeys,
  writeSetting,
  type SettingsStore,
} from "../../src/config/setting-specs.js";

const EXPOSED = [
  "externalAgents.droid.enabled",
  "externalAgents.droid.injectMemory",
  "externalAgents.droid.protocolCheck",
];

const JSON_ONLY = [
  "externalAgents.droid.binary",
  "externalAgents.droid.models",
  "externalAgents.droid.advertiseMax",
  "externalAgents.droid.pricing",
  "externalAgents.droid.catalogTtlS",
  "externalAgents.droid.requestTimeoutS",
  "externalAgents.droid.initTimeoutS",
  "externalAgents.droid.killGraceS",
];

describe("setting-specs externalAgents.droid (P4a 验收③)", () => {
  it("exposes exactly the three TUI leaves", () => {
    for (const key of EXPOSED) {
      expect(settingKeys()).toContain(key);
      expect(isKnownSettingKey(key)).toBe(true);
    }
    expect(SETTING_SPECS["externalAgents.droid.enabled"]?.kind).toBe("boolean");
    expect(SETTING_SPECS["externalAgents.droid.injectMemory"]?.kind).toBe("boolean");
    expect(SETTING_SPECS["externalAgents.droid.protocolCheck"]).toMatchObject({
      kind: "enum",
      values: ["strict", "warn"],
    });
  });

  it("keeps every other externalAgents.droid leaf JSON-only (absent from the spec table)", () => {
    for (const key of JSON_ONLY) expect(settingKeys()).not.toContain(key);
  });

  it("defaults come from DEFAULT_SETTINGS.externalAgents.droid", () => {
    const d = DEFAULT_SETTINGS.externalAgents.droid;
    expect(defaultOf(SETTING_SPECS["externalAgents.droid.enabled"]!)).toBe(d.enabled);
    expect(defaultOf(SETTING_SPECS["externalAgents.droid.injectMemory"]!)).toBe(d.injectMemory);
    expect(defaultOf(SETTING_SPECS["externalAgents.droid.protocolCheck"]!)).toBe(d.protocolCheck);
    expect(currentOf(DEFAULT_SETTINGS, SETTING_SPECS["externalAgents.droid.enabled"]!)).toBe(false);
    expect(currentOf(DEFAULT_SETTINGS, SETTING_SPECS["externalAgents.droid.injectMemory"]!)).toBe(true);
    expect(currentOf(DEFAULT_SETTINGS, SETTING_SPECS["externalAgents.droid.protocolCheck"]!)).toBe("strict");
  });

  it("parses bool / enum input and writes through to the nested live path + persistence key", () => {
    const persisted: Array<[string, unknown]> = [];
    const store: SettingsStore = {
      current: structuredClone(DEFAULT_SETTINGS),
      persist: (key, value) => {
        persisted.push([key, value]);
        return undefined;
      },
      path: "/tmp/settings.json",
    };
    expect(parseSettingValue(SETTING_SPECS["externalAgents.droid.enabled"]!, "true")).toEqual({
      ok: true,
      stored: true,
      live: true,
    });
    writeSetting(store, "externalAgents.droid.enabled", { stored: true, live: true });
    expect(store.current.externalAgents.droid.enabled).toBe(true);
    expect(persisted).toEqual([["externalAgents.droid.enabled", true]]);

    expect(parseSettingValue(SETTING_SPECS["externalAgents.droid.protocolCheck"]!, "warn")).toEqual({
      ok: true,
      stored: "warn",
      live: "warn",
    });
    writeSetting(store, "externalAgents.droid.protocolCheck", { stored: "warn", live: "warn" });
    expect(store.current.externalAgents.droid.protocolCheck).toBe("warn");
    expect(persisted[1]).toEqual(["externalAgents.droid.protocolCheck", "warn"]);

    // 非法输入照常拒绝。
    expect(parseSettingValue(SETTING_SPECS["externalAgents.droid.enabled"]!, "maybe")).toMatchObject({ ok: false });
    expect(parseSettingValue(SETTING_SPECS["externalAgents.droid.protocolCheck"]!, "loose")).toMatchObject({
      ok: false,
    });
  });
});
