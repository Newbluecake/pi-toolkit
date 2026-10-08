// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectLang,
  LANG_STORAGE_KEY,
  loadLangOverride,
  resetLangForTests,
  setLangOverride,
  useI18n,
} from "../../../src/web-hub/ui/src/composables/useI18n.js";
import TopBar from "../../../src/web-hub/ui/src/components/shell/TopBar.vue";

/**
 * 2026-10-08: manual language switch (TopBar 中/EN toggle, `pwh_lang` override).
 * Module-level shared source ⇒ every test resets it (resetLangForTests) and localStorage.
 */

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => (map.has(k) ? (map.get(k) ?? null) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

afterEach(() => {
  resetLangForTests();
  localStorage.clear();
});

describe("useI18n manual override", () => {
  it("loadLangOverride accepts only zh/en, junk and errors fail open to null", () => {
    expect(loadLangOverride(fakeStorage({ [LANG_STORAGE_KEY]: "zh" }))).toBe("zh");
    expect(loadLangOverride(fakeStorage({ [LANG_STORAGE_KEY]: "en" }))).toBe("en");
    expect(loadLangOverride(fakeStorage({ [LANG_STORAGE_KEY]: "fr" }))).toBeNull();
    expect(loadLangOverride(fakeStorage())).toBeNull();
    const throwing = {
      getItem: () => {
        throw new Error("disabled");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(loadLangOverride(throwing)).toBeNull();
  });

  it("an explicit languages argument stays pinned regardless of the override", () => {
    const pinned = useI18n(["zh-CN"]);
    setLangOverride("en");
    expect(pinned.lang).toBe("zh");
    expect(pinned.t("shell.signOut")).toBe("退出");
    resetLangForTests();
  });

  it("the shared handle reacts to setLangOverride (t and the lang getter)", () => {
    const i18n = useI18n(); // no-arg ⇒ shared reactive source
    const before = i18n.t("shell.signOut");
    setLangOverride(i18n.lang === "zh" ? "en" : "zh");
    expect(i18n.t("shell.signOut")).not.toBe(before);
  });

  it("setLangOverride persists and clears the pwh_lang key", () => {
    setLangOverride("zh");
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe("zh");
    setLangOverride(null);
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBeNull();
  });

  it("detectLang's auto rule is unchanged (zh* first tag ⇒ zh, else en)", () => {
    expect(detectLang(["zh-CN", "en"])).toBe("zh");
    expect(detectLang(["en-US", "zh-CN"])).toBe("en");
    expect(detectLang([])).toBe("en");
    expect(detectLang(undefined)).toBe("en");
  });
});

describe("TopBar language toggle", () => {
  function mountBar() {
    return mount(TopBar, {
      props: { brandTitle: "t", conn: "open", hubVersion: "v", controlOn: false, uiStamp: "x", canSignOut: true },
      global: { stubs: { SettingsOverlay: true, AppIcon: true } },
    });
  }

  it("renders the target language's own name and flips on click", async () => {
    const wrapper = mountBar();
    const btn = wrapper.get(".lang-toggle");
    const before = btn.text();
    expect(["中文", "EN"]).toContain(before);
    await btn.trigger("click");
    const after = wrapper.get(".lang-toggle").text();
    expect(after).not.toBe(before);
    expect(["中文", "EN"]).toContain(after);
    // the whole shared i18n source flipped with it
    const i18n = useI18n();
    expect(i18n.lang).toBe(localStorage.getItem(LANG_STORAGE_KEY));
  });

  it("carries a translated aria-label", () => {
    const wrapper = mountBar();
    const label = wrapper.get(".lang-toggle").attributes("aria-label");
    expect(label === "切换语言" || label === "Switch language").toBe(true);
  });
});
