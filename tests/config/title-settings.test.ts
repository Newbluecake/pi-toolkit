import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, parseTitleSettings } from "../../src/config/settings.js";
import { currentOf, defaultOf, isKnownSettingKey, SETTING_SPECS } from "../../src/config/setting-specs.js";

const defaults = DEFAULT_SETTINGS.title;

describe("title settings", () => {
  it("pins the defaults (任务 #12：enabled 默认 on，model 走订阅线 flash 档)", () => {
    expect(defaults).toEqual({
      enabled: true,
      model: "zai-coding-cn/glm-5.3-flash",
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
    expect(loadSettings({ title: { enabled: false, model: "" } }).title).toEqual({ enabled: false, model: "" });
  });

  it("exposes title.* in SETTING_SPECS with resolvable defaults", () => {
    for (const key of ["title.enabled", "title.model"]) {
      expect(isKnownSettingKey(key), key).toBe(true);
      const spec = SETTING_SPECS[key]!;
      expect(defaultOf(spec), key).not.toBeUndefined();
      expect(currentOf(DEFAULT_SETTINGS, spec), key).not.toBe("(unset)");
    }
    expect(defaultOf(SETTING_SPECS["title.model"]!)).toBe("zai-coding-cn/glm-5.3-flash");
  });
});
