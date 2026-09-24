/**
 * compact-hint dynamic · D3 设置测试（dynamic-threshold-plan.md §11 / §12 D3）。
 *
 * T-D3-ON-DEFAULT：缺省配置解析出 mode="on"（用户拍板 D1）。
 * T-D3-SETTINGS：逐字段回退、min > max 交叉校验、5 个 setting-spec 的 path 可解析。
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_DYNAMIC_THRESHOLD_SETTINGS,
  DEFAULT_SETTINGS,
  loadSettings,
  parseDynamicThresholdSettings,
} from "../../src/config/settings.js";
import {
  SETTING_SPECS,
  currentOf,
  isKnownSettingKey,
  parseSettingValue,
  settingKeys,
} from "../../src/config/setting-specs.js";
import { setPath } from "../../src/config/time-units.js";

describe('T-D3-ON-DEFAULT: 缺省配置解析出 mode="on"', () => {
  it("pins the dynamic-threshold defaults (mode on / 35 / 60 / $10 / static)", () => {
    expect(DEFAULT_DYNAMIC_THRESHOLD_SETTINGS).toEqual({
      mode: "on",
      minHintPercent: 35,
      maxQualityPercent: 60,
      rediscoveryUsd: 10,
      unknownPriceMode: "static",
    });
  });

  it('resolves mode="on" for missing / non-object / empty blocks', () => {
    for (const input of [undefined, null, 0, "on", true, [], {}]) {
      expect(parseDynamicThresholdSettings(input).mode, `input=${String(input)}`).toBe("on");
    }
    expect(DEFAULT_SETTINGS.compact.dynamicThreshold.mode).toBe("on");
    expect(loadSettings({}).compact.dynamicThreshold.mode).toBe("on");
  });

  it("wires the block through loadSettings", () => {
    expect(loadSettings({ compact: { dynamicThreshold: { mode: "shadow" } } }).compact.dynamicThreshold).toEqual({
      mode: "shadow",
      minHintPercent: 35,
      maxQualityPercent: 60,
      rediscoveryUsd: 10,
      unknownPriceMode: "static",
    });
  });
});

describe("T-D3-SETTINGS: 逐字段回退、交叉校验、白名单", () => {
  it("falls back per-field for malformed values (never throws)", () => {
    const parsed = parseDynamicThresholdSettings({
      mode: "loud",
      minHintPercent: Number.NaN,
      maxQualityPercent: -1,
      rediscoveryUsd: "10",
      unknownPriceMode: 3,
    });
    expect(parsed).toEqual(DEFAULT_DYNAMIC_THRESHOLD_SETTINGS);
  });

  it("cross-validates minHintPercent > maxQualityPercent by resetting both", () => {
    expect(parseDynamicThresholdSettings({ minHintPercent: 70, maxQualityPercent: 60 })).toEqual(
      parseDynamicThresholdSettings({}), // 两者都回默认（§11.1）
    );
    // 边界：min == max 合法（不交叉）
    expect(parseDynamicThresholdSettings({ minHintPercent: 50, maxQualityPercent: 50 }).minHintPercent).toBe(50);
  });

  it("keeps valid values (mode/unknownPriceMode whitelists, floats floored, rediscovery decimal)", () => {
    expect(
      parseDynamicThresholdSettings({
        mode: "shadow",
        minHintPercent: 40.9,
        maxQualityPercent: 55,
        rediscoveryUsd: 12.5,
        unknownPriceMode: "quality",
      }),
    ).toEqual({
      mode: "shadow",
      minHintPercent: 40,
      maxQualityPercent: 55,
      rediscoveryUsd: 12.5,
      unknownPriceMode: "quality",
    });
    // rediscoveryUsd=0 合法（R=0 ⇒ 纯 cache-read 最优，由地板兜住）
    expect(parseDynamicThresholdSettings({ rediscoveryUsd: 0 }).rediscoveryUsd).toBe(0);
  });

  it("registers the 5 spec keys and their paths resolve inside DEFAULT_SETTINGS", () => {
    const specs: [string, string][] = [
      ["compact.dynamicThreshold.mode", "shadow"],
      ["compact.dynamicThreshold.minHintPercent", "40"],
      ["compact.dynamicThreshold.maxQualityPercent", "55"],
      ["compact.dynamicThreshold.rediscoveryUsd", "12.5"],
      ["compact.dynamicThreshold.unknownPriceMode", "quality"],
    ];
    for (const [key, raw] of specs) {
      expect(isKnownSettingKey(key, false), key).toBe(true);
      const spec = SETTING_SPECS[key]!;
      expect(spec, key).toBeDefined();
      // path 可解析：写进一份深拷贝的默认设置后 currentOf 能读回写入值
      const parsed = parseSettingValue(spec, raw);
      expect(parsed.ok, key).toBe(true);
      const next = structuredClone(DEFAULT_SETTINGS);
      setPath(next, spec.path, (parsed as { value: unknown }).value);
      expect(currentOf(next, spec), key).not.toBeNull();
    }
    expect(settingKeys(false)).toEqual(expect.arrayContaining(specs.map(([key]) => key)));
  });

  it("enum specs validate values (mode off|shadow|on; unknownPriceMode static|quality)", () => {
    expect(parseSettingValue(SETTING_SPECS["compact.dynamicThreshold.mode"]!, "off").ok).toBe(true);
    expect(parseSettingValue(SETTING_SPECS["compact.dynamicThreshold.mode"]!, "loud").ok).toBe(false);
    expect(parseSettingValue(SETTING_SPECS["compact.dynamicThreshold.unknownPriceMode"]!, "quality").ok).toBe(true);
    expect(parseSettingValue(SETTING_SPECS["compact.dynamicThreshold.unknownPriceMode"]!, "fallback").ok).toBe(false);
    expect(parseSettingValue(SETTING_SPECS["compact.dynamicThreshold.rediscoveryUsd"]!, "-1").ok).toBe(false);
    expect(parseSettingValue(SETTING_SPECS["compact.dynamicThreshold.minHintPercent"]!, "101").ok).toBe(false);
  });
});
