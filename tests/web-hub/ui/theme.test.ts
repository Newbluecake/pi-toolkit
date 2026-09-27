import { describe, expect, it } from "vitest";
import {
  applyThemeClasses,
  loadThemePref,
  THEME_STORAGE_KEY,
  useTheme,
} from "../../../src/web-hub/ui/src/composables/useTheme.js";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

function fakeDoc() {
  const classes = new Set<string>();
  return {
    classes,
    documentElement: {
      classList: {
        add: (...cls: string[]) => cls.forEach((c) => classes.add(c)),
        remove: (...cls: string[]) => cls.forEach((c) => classes.delete(c)),
      },
    },
  };
}

describe("useTheme (vue-plan.md v2.1 §3.9, §5.2 — P1)", () => {
  it("loadThemePref: 'system' default, invalid/missing values fall back to 'system'", () => {
    expect(loadThemePref(fakeStorage())).toBe("system");
    expect(loadThemePref(fakeStorage({ [THEME_STORAGE_KEY]: "light" }))).toBe("light");
    expect(loadThemePref(fakeStorage({ [THEME_STORAGE_KEY]: "dark" }))).toBe("dark");
    expect(loadThemePref(fakeStorage({ [THEME_STORAGE_KEY]: "bogus" }))).toBe("system");
  });

  it("loadThemePref: a throwing storage (disabled localStorage) fails open to 'system'", () => {
    const storage = {
      getItem: () => {
        throw new Error("disabled");
      },
    };
    expect(loadThemePref(storage)).toBe("system");
  });

  it("applyThemeClasses: 'system' removes both classes; 'light'/'dark' add exactly one each", () => {
    const doc = fakeDoc();
    applyThemeClasses(doc, "light");
    expect([...doc.classes]).toEqual(["theme-light"]);
    applyThemeClasses(doc, "dark");
    expect([...doc.classes]).toEqual(["theme-dark"]);
    applyThemeClasses(doc, "system");
    expect([...doc.classes]).toEqual([]);
  });

  it("useTheme(): reads the persisted pref on init and applies its class immediately", () => {
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: "dark" });
    const doc = fakeDoc();
    const handle = useTheme({ storage, doc });
    expect(handle.pref.value).toBe("dark");
    expect([...doc.classes]).toEqual(["theme-dark"]);
  });

  it("setPref(): persists the new value and swaps the class", () => {
    const storage = fakeStorage();
    const doc = fakeDoc();
    const handle = useTheme({ storage, doc });
    handle.setPref("light");
    expect(storage.map.get(THEME_STORAGE_KEY)).toBe("light");
    expect([...doc.classes]).toEqual(["theme-light"]);
    handle.setPref("dark");
    expect(storage.map.get(THEME_STORAGE_KEY)).toBe("dark");
    expect([...doc.classes]).toEqual(["theme-dark"]);
    handle.setPref("system");
    expect(storage.map.get(THEME_STORAGE_KEY)).toBe("system");
    expect([...doc.classes]).toEqual([]);
  });

  it("useTheme(): also updates <meta name=theme-color> when supplied", () => {
    const calls: Array<[string, string]> = [];
    const meta = { setAttribute: (n: string, v: string) => calls.push([n, v]) };
    const handle = useTheme({ storage: fakeStorage(), doc: fakeDoc(), metaThemeColor: meta });
    expect(calls).toHaveLength(1);
    handle.setPref("dark");
    expect(calls).toHaveLength(2);
    expect(calls[1]![0]).toBe("content");
  });

  it("a throwing storage.setItem doesn't prevent the class from applying", () => {
    const doc = fakeDoc();
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    const handle = useTheme({ storage, doc });
    expect(() => handle.setPref("dark")).not.toThrow();
    expect([...doc.classes]).toEqual(["theme-dark"]);
  });
});
