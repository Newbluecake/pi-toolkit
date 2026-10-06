// @vitest-environment happy-dom
/**
 * `shell/SettingsView.vue` (floating panel content, revised 2026-10 field report: settings is
 * no longer the standalone `#/settings` page — it is a panel floated over the session view by
 * `shell/SettingsOverlay.vue`) — theme radio rows (`useTheme`), font-size slider
 * (`useFontScale`), and the composer's default delivery mode (`useDeliverDefault`,
 * `pwh_deliver`). Also covers:
 *
 *  - the `theme-init.js` early-boot font-scale half (moved here from the retired
 *    `font-scale-toggle.test.ts`): a persisted in-range `pwh_fontscale` must reach `<html>`'s
 *    `--fs-scale` before first paint;
 *  - the slider-immunity field report: `.settings-font` pins `--fs-scale: 1` in settings.css
 *    so the slider's own geometry never shifts under the user's finger mid-drag (the DOM
 *    half — computed style in a real browser — is asserted by the playwright screenshot pass;
 *    here we pin the stylesheet declaration itself, same source-pinning precedent as
 *    `hash-route.test.ts`'s App.vue wiring pin);
 *  - the TopBar gear toggle that mounts/unmounts the panel.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import SettingsView from "../../../src/web-hub/ui/src/components/shell/SettingsView.vue";
import TopBar from "../../../src/web-hub/ui/src/components/shell/TopBar.vue";

// NOTE: resolve via path, not `new URL(...)` — happy-dom replaces the URL global with one
// that rejects file: URLs.
const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src/web-hub/ui");
const THEME_INIT = resolve(UI_ROOT, "public/theme-init.js");
const SETTINGS_CSS = resolve(UI_ROOT, "src/styles/settings.css");

function runThemeInit(): void {
  // Execute the real bootstrap script against happy-dom's window/document, exactly as the
  // browser would from index.html's <script src="/theme-init.js">.
  new Function(readFileSync(THEME_INIT, "utf8"))();
}

function fsScale(): string {
  return document.documentElement.style.getPropertyValue("--fs-scale");
}

const mounted: Array<ReturnType<typeof mount>> = [];

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.style.removeProperty("--fs-scale");
  document.documentElement.classList.remove("theme-light", "theme-dark");
});

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.style.removeProperty("--fs-scale");
  document.documentElement.classList.remove("theme-light", "theme-dark");
  for (const w of mounted.splice(0)) w.unmount();
});

function mountSettings() {
  const wrapper = mount(SettingsView, { attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

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

describe("SettingsView.vue — theme section", () => {
  it("renders three radio options with the persisted pref checked", () => {
    window.localStorage.setItem("pwh_theme", "dark");
    const w = mountSettings();
    const radios = w.findAll('[role="radiogroup"]')[0]!.findAll('[role="radio"]');
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => r.attributes("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(radios.map((r) => r.text())).toEqual(["System", "Light", "Dark"]);
  });

  it("clicking another option applies the class and persists pwh_theme", async () => {
    const w = mountSettings();
    const radios = w.findAll('[role="radiogroup"]')[0]!.findAll('[role="radio"]');
    await radios[2]!.trigger("click"); // dark
    expect(document.documentElement.classList.contains("theme-dark")).toBe(true);
    expect(window.localStorage.getItem("pwh_theme")).toBe("dark");
    expect(radios[2]!.attributes("aria-checked")).toBe("true");
    await radios[0]!.trigger("click"); // back to system — both classes removed
    expect(document.documentElement.classList.contains("theme-dark")).toBe(false);
    expect(window.localStorage.getItem("pwh_theme")).toBe("system");
  });
});

describe("SettingsView.vue — font-size section", () => {
  it("slider input live-previews without persisting; change persists the final value", async () => {
    const w = mountSettings();
    const range = w.find('input[type="range"]');
    expect(range.attributes("min")).toBe("0.8");
    expect(range.attributes("max")).toBe("3");
    expect(range.attributes("step")).toBe("0.05");
    expect(w.find(".settings-font-readout").text()).toBe("100%");
    const el = range.element as HTMLInputElement;

    el.value = "1.8";
    await range.trigger("input");
    expect(fsScale()).toBe("1.8");
    expect(w.find(".settings-font-readout").text()).toBe("180%");
    expect(window.localStorage.getItem("pwh_fontscale")).toBe(null); // not yet

    await range.trigger("change");
    expect(window.localStorage.getItem("pwh_fontscale")).toBe("1.8"); // persisted on release
  });

  it("reset returns to 100% and persists", async () => {
    window.localStorage.setItem("pwh_fontscale", "1.5");
    const w = mountSettings();
    expect(w.find(".settings-font-readout").text()).toBe("150%");
    await w.find("button.settings-font-reset").trigger("click");
    expect(w.find(".settings-font-readout").text()).toBe("100%");
    expect(fsScale()).toBe("1");
    expect(window.localStorage.getItem("pwh_fontscale")).toBe("1");
  });

  it("slider container is immune to --fs-scale (settings.css re-declares the font tokens on .settings-font)", () => {
    // User field report + acceptance P1: the slider's geometry used to scale with the very
    // value it controls, shifting under the user's finger mid-drag. `--fs-scale: 1` alone is
    // NOT sufficient (custom properties substitute var() at the declaring element — :root's
    // tokens arrive pre-substituted), so the block must also RE-DECLARE the font tokens with
    // values referencing the container's own scale. happy-dom never applies the stylesheet,
    // so the declarations are pinned here; the playwright probe asserts the real browser's
    // computed readout fontSize === "13px" and a stable row rect mid-drag.
    const css = readFileSync(SETTINGS_CSS, "utf8");
    const block = /\.settings-font\s*\{([^}]*)\}/.exec(css);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/--fs-scale:\s*1\s*;/);
    expect(block![1]).toMatch(/--fs-sm:\s*calc\(13px \* var\(--fs-scale/);
    expect(block![1]).toMatch(/--fs-xs:\s*calc\(12px \* var\(--fs-scale/);
    expect(block![1]).toMatch(/--fs-md:\s*calc\(14px \* var\(--fs-scale/);
  });
});

describe("SettingsView.vue — default delivery section", () => {
  it("renders steer/followUp radios; unset or corrupted storage falls back to steer", () => {
    const w = mountSettings();
    const radios = w.findAll('[role="radiogroup"]')[1]!.findAll('[role="radio"]');
    expect(radios).toHaveLength(2);
    expect(radios.map((r) => r.attributes("aria-checked"))).toEqual(["true", "false"]);
    w.unmount();

    window.localStorage.setItem("pwh_deliver", "bogus");
    const bad = mountSettings();
    const badRadios = bad.findAll('[role="radiogroup"]')[1]!.findAll('[role="radio"]');
    expect(badRadios.map((r) => r.attributes("aria-checked"))).toEqual(["true", "false"]);
  });

  it("loads a stored followUp and persists changes on click", async () => {
    window.localStorage.setItem("pwh_deliver", "followUp");
    const w = mountSettings();
    const radios = w.findAll('[role="radiogroup"]')[1]!.findAll('[role="radio"]');
    expect(radios.map((r) => r.attributes("aria-checked"))).toEqual(["false", "true"]);
    await radios[0]!.trigger("click"); // steer
    expect(window.localStorage.getItem("pwh_deliver")).toBe("steer");
    expect(radios[0]!.attributes("aria-checked")).toBe("true");
    await radios[1]!.trigger("click"); // followUp
    expect(window.localStorage.getItem("pwh_deliver")).toBe("followUp");
  });
});

describe("SettingsView.vue — navigation", () => {
  it("close button only emits `close` — the owner (SettingsOverlay/TopBar) decides how to tear the panel down", async () => {
    const w = mountSettings();
    const close = w.find("button.settings-close");
    expect(close.exists()).toBe(true);
    await close.trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
  });
});

describe("TopBar settings entry (floating panel, revised 2026-10)", () => {
  const baseProps = { conn: "open", hubVersion: null, canSignOut: false } as const;

  it("gear is a toggle button with an i18n aria-label; old href/toggles gone", () => {
    const wrapper = mount(TopBar, { props: baseProps });
    mounted.push(wrapper);
    const gear = wrapper.find("button.settings-link");
    expect(gear.exists()).toBe(true);
    expect(gear.attributes("href")).toBeUndefined();
    expect(gear.attributes("aria-expanded")).toBe("false");
    expect(gear.attributes("aria-controls")).toBe("settings-panel");
    expect(gear.attributes("aria-label")).toBe("Settings");
    expect(gear.find("use").attributes("href")).toBe("#i-gear");
    expect(wrapper.find(".theme-trigger").exists()).toBe(false);
    expect(wrapper.find(".fontscale-toggle").exists()).toBe(false);
  });
});
