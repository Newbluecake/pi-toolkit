import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  parseConsultSettings,
  TIME_SETTING_MS_PATHS,
} from "../../src/config/settings.js";
import { currentOf, defaultOf, isKnownSettingKey, SETTING_SPECS } from "../../src/config/setting-specs.js";

const defaults = DEFAULT_SETTINGS.consult;

describe("consult settings (plan §4.6, package A frozen surface)", () => {
  it("pins the seven fields and their defaults (P0-α③ calibrated $2 / $4)", () => {
    expect(defaults).toEqual({
      enabled: true,
      timeoutMs: 150_000,
      maxAnswerChars: 2_000,
      maxTurns: 3,
      maxFirstRequestUsd: 2,
      maxCostUsd: 4,
      maxConcurrent: 2,
    });
    // 冻结面断言：字段数恰好七个（新增旋钮必须先改方案 §4.6）。
    expect(Object.keys(defaults).sort()).toEqual([
      "enabled",
      "maxAnswerChars",
      "maxConcurrent",
      "maxCostUsd",
      "maxFirstRequestUsd",
      "maxTurns",
      "timeoutMs",
    ]);
    // §15 #4：预检阈值与累计帽必须是两个不同的值，否则 maxTurns 恒退化为 1。
    expect(defaults.maxCostUsd).toBeGreaterThan(defaults.maxFirstRequestUsd);
  });

  it("falls back for missing and non-object blocks", () => {
    for (const input of [undefined, null, 0, "nope", true, [], [1, 2]]) {
      expect(parseConsultSettings(input)).toEqual(defaults);
    }
    expect(parseConsultSettings({})).toEqual(defaults);
  });

  it("tolerates garbage field-by-field and never throws", () => {
    expect(
      parseConsultSettings({
        enabled: "yes",
        timeoutMs: -1,
        maxAnswerChars: 2.5,
        maxTurns: Number.NaN,
        maxFirstRequestUsd: -3,
        maxCostUsd: "free",
        maxConcurrent: 0, // 0 并发 = 永远 busy，是配置错误而非「关闭」⇒ 回落默认
      }),
    ).toEqual(defaults);
    expect(parseConsultSettings({ enabled: false }).enabled).toBe(false);
    expect(parseConsultSettings({ maxTurns: 1, maxConcurrent: 4 })).toEqual({
      ...defaults,
      maxTurns: 1,
      maxConcurrent: 4,
    });
  });

  it("keeps 0 for the two USD gates (0 = gate off) but not for the counters/timeout", () => {
    const parsed = parseConsultSettings({
      maxFirstRequestUsd: 0,
      maxCostUsd: 0,
      timeoutMs: 0,
      maxAnswerChars: 0,
      maxTurns: 0,
    });
    expect(parsed.maxFirstRequestUsd).toBe(0);
    expect(parsed.maxCostUsd).toBe(0);
    expect(parsed.timeoutMs).toBe(defaults.timeoutMs);
    expect(parsed.maxAnswerChars).toBe(defaults.maxAnswerChars);
    expect(parsed.maxTurns).toBe(defaults.maxTurns);
    // 美元阈值是小数域（$1.5 合法），计数域仍要求整数。
    expect(parseConsultSettings({ maxFirstRequestUsd: 1.5 }).maxFirstRequestUsd).toBe(1.5);
    expect(parseConsultSettings({ maxTurns: 2.5 }).maxTurns).toBe(defaults.maxTurns);
  });

  it("is wired into loadSettings and normalizes the *S time key to milliseconds", () => {
    expect(loadSettings({ consult: "invalid" }).consult).toEqual(defaults);
    expect(loadSettings({}).consult).toEqual(defaults);
    const loaded = loadSettings({ consult: { timeoutS: 90, maxTurns: 5, maxCostUsd: 1.25 } });
    expect(loaded.consult.timeoutMs).toBe(90_000);
    expect(loaded.consult.maxTurns).toBe(5);
    expect(loaded.consult.maxCostUsd).toBe(1.25);
  });

  it("registers the duration field in TIME_SETTING_MS_PATHS (and only that one)", () => {
    expect(TIME_SETTING_MS_PATHS).toContain("consult.timeoutMs");
    expect(TIME_SETTING_MS_PATHS.filter((p) => p.startsWith("consult."))).toEqual(["consult.timeoutMs"]);
  });

  it("exposes consult.* in SETTING_SPECS with resolvable defaults", () => {
    const keys = [
      "consult.enabled",
      "consult.timeoutS",
      "consult.maxAnswerChars",
      "consult.maxTurns",
      "consult.maxFirstRequestUsd",
      "consult.maxCostUsd",
      "consult.maxConcurrent",
    ];
    for (const key of keys) {
      expect(isKnownSettingKey(key), key).toBe(true);
      const spec = SETTING_SPECS[key]!;
      expect(defaultOf(spec), key).not.toBeUndefined();
      expect(currentOf(DEFAULT_SETTINGS, spec), key).not.toBe("(unset)");
    }
    expect(Object.keys(SETTING_SPECS).filter((k) => k.startsWith("consult."))).toEqual(keys);
    // 秒域展示：defaultOf 把时间键换算成秒。
    expect(defaultOf(SETTING_SPECS["consult.timeoutS"]!)).toBe(150);
    expect(defaultOf(SETTING_SPECS["consult.maxFirstRequestUsd"]!)).toBe(2);
    expect(defaultOf(SETTING_SPECS["consult.maxCostUsd"]!)).toBe(4);
  });
});
