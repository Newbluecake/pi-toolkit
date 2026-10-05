import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, parseTitleSettings } from "../../src/config/settings.js";
import { currentOf, defaultOf, isKnownSettingKey, SETTING_SPECS } from "../../src/config/setting-specs.js";

const defaults = DEFAULT_SETTINGS.title;

describe("title settings", () => {
  it("pins the defaults (任务 #12 + v2：enabled 默认 on，model 走订阅线 flash 档，刷新里程碑/额度默认)", () => {
    expect(defaults).toEqual({
      enabled: true,
      model: "zai-coding-cn/glm-5.3-flash",
      refreshEveryInputs: 4,
      refreshAfterMinutes: 15,
      maxRefreshes: 5,
    });
  });

  it("falls back for missing and non-object blocks", () => {
    for (const input of [undefined, null, 0, "nope", true, [], [1, 2]]) {
      expect(parseTitleSettings(input)).toEqual(defaults);
    }
    expect(parseTitleSettings({})).toEqual(defaults);
  });

  it("tolerates garbage field-by-field and never throws", () => {
    expect(parseTitleSettings({ enabled: "yes", model: 42 })).toEqual(defaults);
    expect(parseTitleSettings({ enabled: false }).enabled).toBe(false);
    expect(parseTitleSettings({ model: "zai/glm-5.3-highspeed" }).model).toBe("zai/glm-5.3-highspeed");
  });

  it("keeps the empty-string sentinel (跟随会话模型) instead of restoring the default", () => {
    expect(parseTitleSettings({ model: "" }).model).toBe("");
    expect(parseTitleSettings({ model: "   " }).model).toBe(""); // trim 后仍是哨兵
  });

  it("is wired into loadSettings", () => {
    expect(loadSettings({ title: "invalid" }).title).toEqual(defaults);
    expect(loadSettings({ title: { enabled: false, model: "" } }).title).toEqual({
      enabled: false,
      model: "",
      refreshEveryInputs: defaults.refreshEveryInputs,
      refreshAfterMinutes: defaults.refreshAfterMinutes,
      maxRefreshes: defaults.maxRefreshes,
    });
  });

  it("exposes title.* in SETTING_SPECS with resolvable defaults", () => {
    for (const key of [
      "title.enabled",
      "title.model",
      "title.refreshEveryInputs",
      "title.refreshAfterMinutes",
      "title.maxRefreshes",
    ]) {
      expect(isKnownSettingKey(key), key).toBe(true);
      const spec = SETTING_SPECS[key]!;
      expect(defaultOf(spec), key).not.toBeUndefined();
      expect(currentOf(DEFAULT_SETTINGS, spec), key).not.toBe("(unset)");
    }
    expect(defaultOf(SETTING_SPECS["title.model"]!)).toBe("zai-coding-cn/glm-5.3-flash");
    expect(defaultOf(SETTING_SPECS["title.refreshEveryInputs"]!)).toBe(4);
    expect(defaultOf(SETTING_SPECS["title.refreshAfterMinutes"]!)).toBe(15);
    expect(defaultOf(SETTING_SPECS["title.maxRefreshes"]!)).toBe(5);
  });

  describe("refreshEveryInputs / refreshAfterMinutes / maxRefreshes 边界（r1 #12：Number.isSafeInteger && >=0，否则回默认）", () => {
    const cases: Array<[unknown, string]> = [
      [NaN, "NaN"],
      [Infinity, "Infinity"],
      [-Infinity, "-Infinity"],
      [1.5, "1.5 (非整数)"],
      [-1, "-1 (负数)"],
      ["4", '"4" (字符串数字不接受)'],
      [null, "null"],
      [undefined, "undefined"],
      [true, "true"],
      [Number.MAX_SAFE_INTEGER + 1, "> MAX_SAFE_INTEGER"],
    ];
    for (const key of ["refreshEveryInputs", "refreshAfterMinutes", "maxRefreshes"] as const) {
      it(`${key}: falls back to the default for each garbage case`, () => {
        for (const [value, label] of cases) {
          expect(parseTitleSettings({ [key]: value })[key], `${key}=${label}`).toBe(defaults[key]);
        }
      });
      it(`${key}: accepts 0 and large valid integers`, () => {
        expect(parseTitleSettings({ [key]: 0 })[key]).toBe(0);
        expect(parseTitleSettings({ [key]: 999 })[key]).toBe(999);
      });
    }
  });
});
