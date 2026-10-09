// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import LangMenu from "../../../src/web-hub/ui/src/components/shell/LangMenu.vue";
import {
  LANG_STORAGE_KEY,
  resetLangForTests,
  setLangOverride,
  useI18n,
} from "../../../src/web-hub/ui/src/composables/useI18n.js";

/**
 * 2026-10-10: the TopBar's two-state language toggle (which showed the TARGET language — "EN"
 * while the UI was Chinese, the reported counter-intuition) became `shell/LangMenu.vue`, a
 * menu-button dropdown: the trigger shows the CURRENT language (中/EN + chevron) and the menu
 * lists both languages as `menuitemradio`s in their own script (中文 / English — never
 * translated). This file pins the interaction contract: radio semantics + aria-checked,
 * selection persists via `setLangOverride` (`pwh_lang`) and returns focus to the trigger,
 * Escape / outside pointerdown / Tab close, and ArrowUp/ArrowDown/Home/End/Enter/Space
 * keyboard navigation (the NewSessionMenu dropdown pattern with radio focus-on-checked).
 *
 * The i18n shared source is module-level: every test resets it + localStorage, and wrappers
 * mount attached to `document.body` so `document.activeElement` assertions are meaningful.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  resetLangForTests();
  localStorage.clear();
  for (const w of mounted.splice(0)) w.unmount();
});

function m(): ReturnType<typeof mount> {
  const w = mount(LangMenu, { attachTo: document.body });
  mounted.push(w);
  return w;
}

function triggerOf(w: ReturnType<typeof mount>) {
  return w.get(".lang-toggle");
}

function itemEls(w: ReturnType<typeof mount>): HTMLButtonElement[] {
  return w.findAll(".lang-menu-item").map((i) => i.element as HTMLButtonElement);
}

async function open(w: ReturnType<typeof mount>): Promise<void> {
  await triggerOf(w).trigger("click");
  await flushPromises(); // openMenu focuses the checked item after a nextTick
}

describe("LangMenu trigger", () => {
  it("shows the CURRENT language compact label + chev-down, with menu-button aria wiring", () => {
    const w = m();
    const trigger = triggerOf(w);
    // default en ⇒ "EN" on the trigger (the retired toggle said 中文 here — target, not current)
    expect(trigger.text()).toBe("EN");
    expect(trigger.attributes("aria-haspopup")).toBe("menu");
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(trigger.attributes("aria-controls")).toBe("lang-menu");
    const chevron = trigger.find("svg.icon-sm");
    expect(chevron.exists()).toBe(true);
    expect(chevron.find("use").attributes("href")).toBe("#i-chev-down");
    expect(w.find("#lang-menu").exists()).toBe(false);
  });

  it("zh UI ⇒ trigger says 中 and the aria-label names 中文 in Chinese", () => {
    setLangOverride("zh");
    const w = m();
    const trigger = triggerOf(w);
    expect(trigger.text()).toBe("中");
    expect(trigger.attributes("aria-label")).toBe("语言：中文");
    expect(trigger.attributes("title")).toBe("语言：中文");
  });

  it("en UI aria-label names English in English", () => {
    const w = m();
    const trigger = triggerOf(w);
    expect(trigger.attributes("aria-label")).toBe("Language: English");
  });
});

describe("LangMenu menu", () => {
  it("opens on click: role=menu with two radio items in their own scripts, check + focus on the current one", async () => {
    const w = m();
    await open(w);
    const menu = w.get("#lang-menu");
    expect(menu.attributes("role")).toBe("menu");
    expect(menu.attributes("aria-label")).toBe("Language");
    const items = w.findAll(".lang-menu-item");
    expect(items.map((i) => i.attributes("role"))).toEqual(["menuitemradio", "menuitemradio"]);
    expect(items.map((i) => i.text())).toEqual(["中文", "English"]); // own script, never translated
    expect(items.map((i) => i.attributes("aria-checked"))).toEqual(["false", "true"]); // en current
    // the check glyph sits ONLY on the checked item
    expect(items[0]!.find(".lang-item-check svg").exists()).toBe(false);
    expect(items[1]!.find(".lang-item-check svg").exists()).toBe(true);
    // opening focuses the checked item
    expect(document.activeElement).toBe(items[1]!.element);
    expect(triggerOf(w).attributes("aria-expanded")).toBe("true");
  });

  it("selecting the other language switches, persists, closes the menu and refocuses the trigger", async () => {
    const w = m();
    await open(w);
    await w.get('.lang-menu-item[data-lang="zh"]').trigger("click");
    expect(useI18n().lang).toBe("zh");
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe("zh");
    expect(w.find("#lang-menu").exists()).toBe(false);
    expect(triggerOf(w).attributes("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(triggerOf(w).element);
    // the trigger label flipped to the new CURRENT language
    expect(triggerOf(w).text()).toBe("中");
  });

  it("selecting the CURRENT language just closes — no override is written", async () => {
    const w = m();
    await open(w);
    await w.get('.lang-menu-item[data-lang="en"]').trigger("click"); // already current
    expect(useI18n().lang).toBe("en");
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBeNull();
    expect(w.find("#lang-menu").exists()).toBe(false);
    expect(document.activeElement).toBe(triggerOf(w).element);
  });

  it("Escape closes and returns focus to the trigger", async () => {
    const w = m();
    await open(w);
    await w.get('.lang-menu-item[data-lang="en"]').trigger("keydown", { key: "Escape" });
    expect(w.find("#lang-menu").exists()).toBe(false);
    expect(triggerOf(w).attributes("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(triggerOf(w).element);
  });

  it("outside pointerdown closes; a pointerdown on the trigger itself does not", async () => {
    const w = m();
    await open(w);
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await flushPromises();
    expect(w.find("#lang-menu").exists()).toBe(false);

    await open(w);
    triggerOf(w).element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await flushPromises();
    expect(w.find("#lang-menu").exists()).toBe(true);
  });

  it("Tab closes (APG menus) without stealing the browser's own focus move", async () => {
    const w = m();
    await open(w);
    await w.get('.lang-menu-item[data-lang="en"]').trigger("keydown", { key: "Tab" });
    expect(w.find("#lang-menu").exists()).toBe(false);
  });
});

describe("LangMenu keyboard navigation", () => {
  it("ArrowDown/ArrowUp/Enter/Space on the closed trigger open it (no native double-activation)", async () => {
    const w = m();
    const trigger = triggerOf(w);
    await trigger.trigger("keydown", { key: "ArrowDown" });
    await flushPromises();
    expect(w.find("#lang-menu").exists()).toBe(true);
    expect(document.activeElement).toBe(itemEls(w)[1]); // focus lands on the CHECKED item
    await trigger.trigger("keydown", { key: "Escape" });

    await trigger.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(w.find("#lang-menu").exists()).toBe(true);
    await trigger.trigger("keydown", { key: "Escape" });

    await trigger.trigger("keydown", { key: " " });
    await flushPromises();
    expect(w.find("#lang-menu").exists()).toBe(true);
  });

  it("arrows wrap around; Home/End jump to the ends; Enter selects the focused item", async () => {
    const w = m();
    await open(w); // en current ⇒ focus on English (index 1)
    const [zh, en] = itemEls(w);
    expect(document.activeElement).toBe(en);

    await en.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(zh); // wraps 1 → 0

    await zh.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(en); // wraps 0 → 1

    await en.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(zh);

    await zh.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(en);

    await en.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(useI18n().lang).toBe("en"); // Enter on the checked item selected it (no-op switch)
    expect(w.find("#lang-menu").exists()).toBe(false);

    // Space selects the focused item too: re-open (focus back on en), Home to zh, then Space.
    await open(w);
    const items2 = itemEls(w);
    await items2[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(items2[0]);
    await items2[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(useI18n().lang).toBe("zh");
    expect(w.find("#lang-menu").exists()).toBe(false);
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe("zh");
  });

  it("Enter on the trigger while open closes it (toggle semantics, focus returns)", async () => {
    const w = m();
    await open(w);
    await triggerOf(w).trigger("keydown", { key: "Enter" });
    expect(w.find("#lang-menu").exists()).toBe(false);
    expect(document.activeElement).toBe(triggerOf(w).element);
  });
});
