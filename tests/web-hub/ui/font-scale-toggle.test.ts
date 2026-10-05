// @vitest-environment happy-dom
/**
 * `FontScaleToggle.vue` (shell top-bar font-size cycle button) + the `theme-init.js`
 * early-boot half of the font-scale feature: the init script must apply a persisted
 * `pwh_fontscale` to `<html>`'s `--fs-scale` before first paint (no flash of small text),
 * and the toggle must cycle 100→115→130→150→100, persist each step, and keep its aria-label
 * announcing current → next percentages.
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

describe("theme-init.js font-scale early boot", () => {
  it("applies a persisted valid scale to <html> before paint", () => {
    window.localStorage.setItem("pwh_fontscale", "1.5");
    runThemeInit();
    expect(fsScale()).toBe("1.5");
  });

  it.each(["1", "bogus", "2"])(
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

describe("FontScaleToggle.vue", () => {
  it("renders the Aa glyph with an aria-label announcing current → next percentage", () => {
    const wrapper = mount(FontScaleToggle);
    const button = wrapper.find("button");
    expect(button.text()).toBe("Aa");
    expect(button.attributes("aria-label")).toContain("100%");
    expect(button.attributes("aria-label")).toContain("115%");
  });

  it("clicking cycles 100→115→130→150→100, persisting each step and rewriting --fs-scale", async () => {
    const wrapper = mount(FontScaleToggle);
    const button = wrapper.find("button");
    const expected: Array<[string, string]> = [
      ["1.15", "115%"],
      ["1.3", "130%"],
      ["1.5", "150%"],
      ["1", "100%"],
    ];
    for (const [stored, pct] of expected) {
      await button.trigger("click");
      expect(window.localStorage.getItem("pwh_fontscale")).toBe(stored);
      expect(fsScale()).toBe(stored);
      expect(button.attributes("aria-label")).toContain(pct);
    }
  });

  it("starts from the persisted scale (115% stored → first click goes to 130%)", async () => {
    window.localStorage.setItem("pwh_fontscale", "1.15");
    const wrapper = mount(FontScaleToggle);
    expect(wrapper.find("button").attributes("aria-label")).toContain("115%");
    await wrapper.find("button").trigger("click");
    expect(window.localStorage.getItem("pwh_fontscale")).toBe("1.3");
  });

  it("falls back to 100% on a corrupted stored value", () => {
    window.localStorage.setItem("pwh_fontscale", "bogus");
    const wrapper = mount(FontScaleToggle);
    expect(wrapper.find("button").attributes("aria-label")).toContain("100%");
    expect(fsScale()).toBe("1");
  });
});
