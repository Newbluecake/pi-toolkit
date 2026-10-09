// @vitest-environment happy-dom
/**
 * `pwh_motion` (`composables/useMotionPref.ts`, 2026-10) — the browser-side motion switch.
 * The user's desktop Edge reports `prefers-reduced-motion: reduce` (Windows animation
 * effects off), which the reduce media rules honored unconditionally, killing every
 * animation. Pinned here:
 *
 *  - pref parsing/fail-safe: only the exact tokens `system|on|off` parse; absent/junk and a
 *    throwing storage fail open to `"system"` — byte-identical pre-feature behavior;
 *  - the `<html data-motion>` attribute: application, live same-tab update, cross-tab
 *    `storage`-event update (including `storage.clear()`), and the `public/theme-init.js`
 *    pre-paint bootstrap half (persisted `on`/`off` reach `<html>` before first paint);
 *  - `prefersReducedMotion()` — the single JS-side funnel: `on` ⇒ false, `off` ⇒ true,
 *    `system` ⇒ `matchMedia` (and `false` when there is no `matchMedia` at all);
 *  - the SettingsView 「动态效果」 card: always rendered, three radio rows, click applies +
 *    persists (and back to system removes the attribute);
 *  - en/zh key parity for the new i18n leaves (the global parity suite enforces the rest).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import SettingsView from "../../../src/web-hub/ui/src/components/shell/SettingsView.vue";
import {
  MOTION_STORAGE_KEY,
  applyMotionAttr,
  loadMotionPref,
  parseMotionPref,
  prefersReducedMotion,
  resetMotionPrefForTests,
  setMotionPrefValue,
  useMotionPref,
  type MotionDocument,
  type MotionStorage,
  type MotionStorageEvent,
  type MotionWindow,
} from "../../../src/web-hub/ui/src/composables/useMotionPref.js";
import { MESSAGES } from "../../../src/web-hub/ui/src/i18n/index.js";

// NOTE: resolve via path, not `new URL(...)` — happy-dom replaces the URL global with one
// that rejects file: URLs (same note as settings-view.test.ts).
const THEME_INIT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src/web-hub/ui/public/theme-init.js");

function runThemeInit(): void {
  // Execute the real bootstrap script against happy-dom's window/document, exactly as the
  // browser would from index.html's <script src="/theme-init.js">.
  new Function(readFileSync(THEME_INIT, "utf8"))();
}

function attr(): string | null {
  return document.documentElement.getAttribute("data-motion");
}

function fakeStorage(initial: Record<string, string> = {}): MotionStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

function fakeDoc(): MotionDocument & { attrs: Map<string, string> } {
  const attrs = new Map<string, string>();
  return {
    attrs,
    documentElement: {
      setAttribute: (n, v) => void attrs.set(n, v),
      removeAttribute: (n) => void attrs.delete(n),
    },
  };
}

const mounted: Array<ReturnType<typeof mount>> = [];

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-motion");
});

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-motion");
  resetMotionPrefForTests();
});

// --- pure pref read/write ----------------------------------------------------------------------

describe("pwh_motion — parsing and fail-safe", () => {
  it("only the three exact tokens parse; absent/junk → null", () => {
    expect(parseMotionPref("system")).toBe("system");
    expect(parseMotionPref("on")).toBe("on");
    expect(parseMotionPref("off")).toBe("off");
    for (const raw of ["true", "yes", "", " ON ", "0", "system ", null]) expect(parseMotionPref(raw)).toBeNull();
  });

  it("loadMotionPref: absent ⇒ system; valid tokens pass through; junk ⇒ system; throwing storage ⇒ system", () => {
    expect(loadMotionPref(fakeStorage())).toBe("system");
    expect(loadMotionPref(fakeStorage({ [MOTION_STORAGE_KEY]: "on" }))).toBe("on");
    expect(loadMotionPref(fakeStorage({ [MOTION_STORAGE_KEY]: "off" }))).toBe("off");
    expect(loadMotionPref(fakeStorage({ [MOTION_STORAGE_KEY]: "bogus" }))).toBe("system");
    const throwing = {
      getItem: () => {
        throw new Error("locked");
      },
      setItem: () => {
        throw new Error("locked");
      },
    };
    expect(loadMotionPref(throwing)).toBe("system");
  });

  it("setMotionPrefValue persists and ignores write failures", () => {
    const storage = fakeStorage();
    setMotionPrefValue(storage, "off");
    expect(storage.map.get(MOTION_STORAGE_KEY)).toBe("off");
    const throwing = {
      getItem: (): string | null => null,
      setItem: () => {
        throw new Error("locked");
      },
    };
    expect(() => setMotionPrefValue(throwing, "on")).not.toThrow();
  });

  it("applyMotionAttr: on/off set the attribute; system removes it (even a pre-existing one)", () => {
    const doc = fakeDoc();
    applyMotionAttr(doc, "on");
    expect(doc.attrs.get("data-motion")).toBe("on");
    applyMotionAttr(doc, "off");
    expect(doc.attrs.get("data-motion")).toBe("off");
    applyMotionAttr(doc, "system");
    expect(doc.attrs.has("data-motion")).toBe(false);
  });
});

// --- the JS-side funnel ------------------------------------------------------------------------

describe("prefersReducedMotion — the single JS-side funnel", () => {
  it("on ⇒ false (never reduced); off ⇒ true (always reduced)", () => {
    expect(prefersReducedMotion("on", { matchMedia: () => ({ matches: true }) })).toBe(false);
    expect(prefersReducedMotion("off", { matchMedia: () => ({ matches: false }) })).toBe(true);
  });

  it("system ⇒ whatever matchMedia says", () => {
    expect(
      prefersReducedMotion("system", { matchMedia: (q) => ({ matches: q === "(prefers-reduced-motion: reduce)" }) }),
    ).toBe(true);
    expect(prefersReducedMotion("system", { matchMedia: () => ({ matches: false }) })).toBe(false);
  });

  it("system + no window (SSR/test injection null) ⇒ false — the no-preference platform default", () => {
    expect(prefersReducedMotion("system", null)).toBe(false);
  });
});

// --- the composable: attribute application, live update, cross-tab ------------------------------

describe("useMotionPref — apply, live update, cross-tab", () => {
  it("reads the persisted pref on init and applies the attribute immediately", () => {
    const storage = fakeStorage({ [MOTION_STORAGE_KEY]: "off" });
    const doc = fakeDoc();
    const h = useMotionPref({ storage, doc, win: null });
    expect(h.pref.value).toBe("off");
    expect(doc.attrs.get("data-motion")).toBe("off");
  });

  it("setPref persists, swaps the attribute live, and system removes it", () => {
    const storage = fakeStorage();
    const doc = fakeDoc();
    const h = useMotionPref({ storage, doc, win: null });
    h.setPref("on");
    expect(storage.map.get(MOTION_STORAGE_KEY)).toBe("on");
    expect(doc.attrs.get("data-motion")).toBe("on");
    h.setPref("off");
    expect(doc.attrs.get("data-motion")).toBe("off");
    h.setPref("system");
    expect(doc.attrs.has("data-motion")).toBe(false);
    expect(storage.map.get(MOTION_STORAGE_KEY)).toBe("system");
  });

  it("a storage event from ANOTHER tab flips the shared pref and the attribute (cross-tab)", () => {
    const listeners: Array<(ev: MotionStorageEvent) => void> = [];
    const win: MotionWindow = {
      addEventListener: (_t, l) => void listeners.push(l),
      removeEventListener: () => {},
    };
    const storage = fakeStorage();
    const doc = fakeDoc();
    const h = useMotionPref({ storage, doc, win });
    expect(h.pref.value).toBe("system");

    for (const l of [...listeners]) l({ key: MOTION_STORAGE_KEY, newValue: "off" });
    expect(h.pref.value).toBe("off");
    expect(doc.attrs.get("data-motion")).toBe("off");

    for (const l of [...listeners]) l({ key: MOTION_STORAGE_KEY, newValue: "bogus" });
    expect(h.pref.value).toBe("system"); // invalid value from the other tab fails open
    expect(doc.attrs.has("data-motion")).toBe(false);
  });

  it("an unrelated storage key is ignored; key null (storage.clear()) re-reads the pref", () => {
    const listeners: Array<(ev: MotionStorageEvent) => void> = [];
    const win: MotionWindow = {
      addEventListener: (_t, l) => void listeners.push(l),
      removeEventListener: () => {},
    };
    const storage = fakeStorage({ [MOTION_STORAGE_KEY]: "on" });
    const doc = fakeDoc();
    const h = useMotionPref({ storage, doc, win });
    expect(doc.attrs.get("data-motion")).toBe("on");

    for (const l of [...listeners]) l({ key: "pwh_something_else", newValue: "off" });
    expect(h.pref.value).toBe("on"); // untouched

    storage.map.delete(MOTION_STORAGE_KEY); // the other tab cleared storage
    for (const l of [...listeners]) l({ key: null, newValue: null });
    expect(h.pref.value).toBe("system");
    expect(doc.attrs.has("data-motion")).toBe(false);
  });
});

// --- theme-init.js early boot -------------------------------------------------------------------

describe("theme-init.js motion early boot (pre-paint attribute)", () => {
  it("applies a persisted on/off before first paint", () => {
    window.localStorage.setItem(MOTION_STORAGE_KEY, "off");
    runThemeInit();
    expect(attr()).toBe("off");

    window.localStorage.setItem(MOTION_STORAGE_KEY, "on");
    runThemeInit();
    expect(attr()).toBe("on");
  });

  it("system / junk / absent set NO attribute (the OS media query answers alone)", () => {
    window.localStorage.setItem(MOTION_STORAGE_KEY, "system");
    runThemeInit();
    expect(attr()).toBeNull();

    window.localStorage.setItem(MOTION_STORAGE_KEY, "bogus");
    runThemeInit();
    expect(attr()).toBeNull();

    window.localStorage.removeItem(MOTION_STORAGE_KEY);
    runThemeInit();
    expect(attr()).toBeNull();
  });

  it("still applies the theme class and font scale alongside (original behavior intact)", () => {
    window.localStorage.setItem("pwh_theme", "dark");
    window.localStorage.setItem("pwh_fontscale", "1.2");
    window.localStorage.setItem(MOTION_STORAGE_KEY, "off");
    runThemeInit();
    expect(document.documentElement.classList.contains("theme-dark")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--fs-scale")).toBe("1.2");
    expect(attr()).toBe("off");
  });
});

// --- the settings card ---------------------------------------------------------------------------

describe("SettingsView — the 「动态效果 / Motion」 card", () => {
  function motionSection(): ReturnType<typeof mount> {
    const w = mount(SettingsView, { attachTo: document.body });
    mounted.push(w);
    return w.find('section[aria-label="Motion"]');
  }

  it("is ALWAYS rendered (no page-condition gating) with three radio options, system default", () => {
    const section = motionSection();
    expect(section.exists()).toBe(true);
    const options = section.findAll(".settings-option");
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.attributes("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(options.map((o) => o.text())).toEqual(["Follow system (default)", "Always animate", "Always reduce"]);
    expect(section.find(".settings-note").text()).toBe(
      "Follow system honors the operating system's reduce-animation setting.",
    );
    expect(attr()).toBeNull(); // system ⇒ no attribute
  });

  it("a persisted pref is reflected on mount (off checked, attribute applied)", () => {
    window.localStorage.setItem(MOTION_STORAGE_KEY, "off");
    const section = motionSection();
    const options = section.findAll(".settings-option");
    expect(options.map((o) => o.attributes("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(attr()).toBe("off");
  });

  it("invalid stored values fall back to system (fail-safe through the real card)", () => {
    window.localStorage.setItem(MOTION_STORAGE_KEY, "yes");
    const section = motionSection();
    expect(section.findAll(".settings-option")[0]!.attributes("aria-checked")).toBe("true");
    expect(attr()).toBeNull();
  });

  it("clicking on/off/system applies the attribute live and persists", async () => {
    const section = motionSection();
    const options = section.findAll(".settings-option");
    await options[1]!.trigger("click"); // on
    expect(window.localStorage.getItem(MOTION_STORAGE_KEY)).toBe("on");
    expect(attr()).toBe("on");
    await section.findAll(".settings-option")[2]!.trigger("click"); // off
    expect(window.localStorage.getItem(MOTION_STORAGE_KEY)).toBe("off");
    expect(attr()).toBe("off");
    await section.findAll(".settings-option")[0]!.trigger("click"); // back to system
    expect(window.localStorage.getItem(MOTION_STORAGE_KEY)).toBe("system");
    expect(attr()).toBeNull();
  });
});

// --- i18n parity pin ------------------------------------------------------------------------------

describe("i18n leaves exist in BOTH languages (global parity suite enforces the rest)", () => {
  it("settings.motion*", () => {
    for (const lang of ["en", "zh"] as const) {
      const settings = MESSAGES[lang]?.["settings"];
      expect(settings?.motionSection, `${lang}.settings.motionSection`).toBeTruthy();
      expect(settings?.motionHint, `${lang}.settings.motionHint`).toBeTruthy();
      expect(settings?.motionSystem, `${lang}.settings.motionSystem`).toBeTruthy();
      expect(settings?.motionOn, `${lang}.settings.motionOn`).toBeTruthy();
      expect(settings?.motionOff, `${lang}.settings.motionOff`).toBeTruthy();
    }
  });
});
