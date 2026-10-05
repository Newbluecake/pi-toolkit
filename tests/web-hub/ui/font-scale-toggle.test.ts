// @vitest-environment happy-dom
/**
 * `FontScaleToggle.vue` (top-bar font-size slider popover) + the `theme-init.js` early-boot
 * half of the feature: the init script must apply a persisted in-range `pwh_fontscale` to
 * `<html>`'s `--fs-scale` before first paint (no flash of small text), and the popover must
 * open/close via trigger/Esc/outside-pointer, live-preview slider drags without persisting
 * until release, and reset to 100%.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import FontScaleToggle from "../../../src/web-hub/ui/src/components/shell/FontScaleToggle.vue";

// NOTE: resolve via path, not `new URL(...)` — happy-dom replaces the URL global with one
// that rejects file: URLs.
const THEME_INIT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src/web-hub/ui/public/theme-init.js");

function runThemeInit(): void {
  // Execute the real bootstrap script against happy-dom's window/document, exactly as the
  // browser would from index.html's <script src="/theme-init.js">.
  new Function(readFileSync(THEME_INIT, "utf8"))();
}

function fsScale(): string {
  return document.documentElement.style.getPropertyValue("--fs-scale");
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.style.removeProperty("--fs-scale");
  document.documentElement.classList.remove("theme-light", "theme-dark");
});

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.style.removeProperty("--fs-scale");
});

describe("theme-init.js font-scale early boot (numeric parse)", () => {
  it("applies a persisted in-range value to <html> before paint", () => {
    window.localStorage.setItem("pwh_fontscale", "1.8");
    runThemeInit();
    expect(fsScale()).toBe("1.8");
  });

  it.each(["1", "0.8", "3"])("applies boundary value %s", (v) => {
    window.localStorage.setItem("pwh_fontscale", v);
    runThemeInit();
    expect(fsScale()).toBe(v);
  });

  it.each(["bogus", "0.5", "3.5", "Infinity"])(
    "sets nothing for %s (tokens.css's var(--fs-scale, 1) fallback is already 100%)",
    (v) => {
      window.localStorage.setItem("pwh_fontscale", v);
      runThemeInit();
      expect(fsScale()).toBe("");
    },
  );

  it("sets nothing when no preference was ever stored", () => {
    runThemeInit();
    expect(fsScale()).toBe("");
  });

  it("still applies the theme class alongside the font scale (original behavior intact)", () => {
    window.localStorage.setItem("pwh_theme", "dark");
    window.localStorage.setItem("pwh_fontscale", "1.15");
    runThemeInit();
    expect(document.documentElement.classList.contains("theme-dark")).toBe(true);
    expect(fsScale()).toBe("1.15");
  });
});

describe("FontScaleToggle.vue popover", () => {
  it("renders the Aa trigger with aria-haspopup/expanded and the current percentage; popover starts closed", () => {
    const wrapper = mount(FontScaleToggle);
    const trigger = wrapper.find("button.fontscale-toggle");
    expect(trigger.text()).toBe("Aa");
    expect(trigger.attributes("aria-haspopup")).toBe("dialog");
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(trigger.attributes("aria-label")).toContain("100%");
    expect(wrapper.find(".fontscale-popover").exists()).toBe(false);
  });

  it("opens on trigger click (slider + readout + reset visible) and closes on re-click", async () => {
    const wrapper = mount(FontScaleToggle);
    const trigger = wrapper.find("button.fontscale-toggle");
    await trigger.trigger("click");
    expect(wrapper.find(".fontscale-popover").exists()).toBe(true);
    expect(trigger.attributes("aria-expanded")).toBe("true");
    const range = wrapper.find('input[type="range"]');
    expect(range.exists()).toBe(true);
    expect(range.attributes("min")).toBe("0.8");
    expect(range.attributes("max")).toBe("3");
    expect(range.attributes("step")).toBe("0.05");
    expect(wrapper.find(".fontscale-readout").text()).toBe("100%");
    expect(wrapper.find("button.fontscale-reset").exists()).toBe(true);
    await trigger.trigger("click");
    expect(wrapper.find(".fontscale-popover").exists()).toBe(false);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const wrapper = mount(FontScaleToggle, { attachTo: document.body });
    const trigger = wrapper.find("button.fontscale-toggle");
    await trigger.trigger("click");
    expect(wrapper.find(".fontscale-popover").exists()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".fontscale-popover").exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    wrapper.unmount();
  });

  it("closes on pointer down outside, but not on pointer down inside", async () => {
    const wrapper = mount(FontScaleToggle, { attachTo: document.body });
    await wrapper.find("button.fontscale-toggle").trigger("click");
    expect(wrapper.find(".fontscale-popover").exists()).toBe(true);
    // inside (the popover itself) — stays open
    wrapper.find(".fontscale-popover").element.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".fontscale-popover").exists()).toBe(true);
    // outside (document body) — closes
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".fontscale-popover").exists()).toBe(false);
    wrapper.unmount();
  });

  it("slider input live-previews without persisting; change persists the final value", async () => {
    const wrapper = mount(FontScaleToggle);
    await wrapper.find("button.fontscale-toggle").trigger("click");
    const range = wrapper.find('input[type="range"]');
    const el = range.element as HTMLInputElement;

    el.value = "1.8";
    await range.trigger("input");
    expect(fsScale()).toBe("1.8");
    expect(wrapper.find(".fontscale-readout").text()).toBe("180%");
    expect(window.localStorage.getItem("pwh_fontscale")).toBe(null); // not yet

    el.value = "1.65";
    await range.trigger("input");
    expect(fsScale()).toBe("1.65");
    expect(window.localStorage.getItem("pwh_fontscale")).toBe(null); // still not

    await range.trigger("change");
    expect(window.localStorage.getItem("pwh_fontscale")).toBe("1.65"); // persisted on release
  });

  it("reset returns to 100% and persists", async () => {
    window.localStorage.setItem("pwh_fontscale", "1.5");
    const wrapper = mount(FontScaleToggle);
    await wrapper.find("button.fontscale-toggle").trigger("click");
    expect(wrapper.find(".fontscale-readout").text()).toBe("150%");
    await wrapper.find("button.fontscale-reset").trigger("click");
    expect(wrapper.find(".fontscale-readout").text()).toBe("100%");
    expect(fsScale()).toBe("1");
    expect(window.localStorage.getItem("pwh_fontscale")).toBe("1");
    // popover stays open after reset
    expect(wrapper.find(".fontscale-popover").exists()).toBe(true);
  });

  it("starts from the persisted scale; corrupted stored values fall back to 100%", async () => {
    window.localStorage.setItem("pwh_fontscale", "1.35");
    const ok = mount(FontScaleToggle);
    expect(ok.find("button.fontscale-toggle").attributes("aria-label")).toContain("135%");
    ok.unmount();

    window.localStorage.setItem("pwh_fontscale", "bogus");
    const bad = mount(FontScaleToggle);
    expect(bad.find("button.fontscale-toggle").attributes("aria-label")).toContain("100%");
    expect(fsScale()).toBe("1");
    bad.unmount();
  });
});
