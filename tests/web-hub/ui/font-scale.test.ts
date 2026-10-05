import { describe, expect, it } from "vitest";
import {
  applyFontScale,
  FONT_SCALE_STORAGE_KEY,
  FONT_SCALES,
  fontScalePercent,
  loadFontScale,
  nextFontScale,
  useFontScale,
} from "../../../src/web-hub/ui/src/composables/useFontScale.js";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

function fakeDoc() {
  const props = new Map<string, string>();
  return {
    props,
    documentElement: {
      style: {
        setProperty: (name: string, value: string) => void props.set(name, value),
      },
    },
  };
}

describe("useFontScale (pwh_fontscale → --fs-scale, mirrors useTheme)", () => {
  it("loadFontScale: '1' default; every valid step loads; invalid/missing values fall back to '1'", () => {
    expect(loadFontScale(fakeStorage())).toBe("1");
    for (const s of FONT_SCALES) {
      expect(loadFontScale(fakeStorage({ [FONT_SCALE_STORAGE_KEY]: s }))).toBe(s);
    }
    expect(loadFontScale(fakeStorage({ [FONT_SCALE_STORAGE_KEY]: "bogus" }))).toBe("1");
    expect(loadFontScale(fakeStorage({ [FONT_SCALE_STORAGE_KEY]: "2" }))).toBe("1");
  });

  it("loadFontScale: a throwing storage (disabled) fails open to '1'", () => {
    const storage = {
      getItem: () => {
        throw new Error("disabled");
      },
    };
    expect(loadFontScale(storage)).toBe("1");
  });

  it("applyFontScale: writes --fs-scale on the document element", () => {
    const doc = fakeDoc();
    applyFontScale(doc, "1.3");
    expect(doc.props.get("--fs-scale")).toBe("1.3");
  });

  it("nextFontScale: cycles 1 → 1.15 → 1.3 → 1.5 → 1", () => {
    expect(nextFontScale("1")).toBe("1.15");
    expect(nextFontScale("1.15")).toBe("1.3");
    expect(nextFontScale("1.3")).toBe("1.5");
    expect(nextFontScale("1.5")).toBe("1");
  });

  it("fontScalePercent: 1 → 100, 1.15 → 115, 1.3 → 130, 1.5 → 150", () => {
    expect(fontScalePercent("1")).toBe(100);
    expect(fontScalePercent("1.15")).toBe(115);
    expect(fontScalePercent("1.3")).toBe(130);
    expect(fontScalePercent("1.5")).toBe(150);
  });

  it("useFontScale(): reads the persisted scale on init and applies the property immediately", () => {
    const storage = fakeStorage({ [FONT_SCALE_STORAGE_KEY]: "1.5" });
    const doc = fakeDoc();
    const handle = useFontScale({ storage, doc });
    expect(handle.scale.value).toBe("1.5");
    expect(doc.props.get("--fs-scale")).toBe("1.5");
  });

  it("setScale(): persists the new value and rewrites the property (round-trip)", () => {
    const storage = fakeStorage();
    const doc = fakeDoc();
    const handle = useFontScale({ storage, doc });
    handle.setScale("1.15");
    expect(storage.map.get(FONT_SCALE_STORAGE_KEY)).toBe("1.15");
    expect(doc.props.get("--fs-scale")).toBe("1.15");
    // persistence round-trip: a fresh composable over the same storage picks the value back up
    const doc2 = fakeDoc();
    const handle2 = useFontScale({ storage, doc: doc2 });
    expect(handle2.scale.value).toBe("1.15");
    expect(doc2.props.get("--fs-scale")).toBe("1.15");
  });

  it("cycle(): walks the whole ladder and wraps back to 100%", () => {
    const storage = fakeStorage();
    const doc = fakeDoc();
    const handle = useFontScale({ storage, doc });
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      handle.cycle();
      seen.push(handle.scale.value);
    }
    expect(seen).toEqual(["1.15", "1.3", "1.5", "1", "1.15"]);
    expect(storage.map.get(FONT_SCALE_STORAGE_KEY)).toBe("1.15");
  });

  it("a throwing storage.setItem doesn't prevent the property from applying", () => {
    const doc = fakeDoc();
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    const handle = useFontScale({ storage, doc });
    expect(() => handle.setScale("1.3")).not.toThrow();
    expect(doc.props.get("--fs-scale")).toBe("1.3");
  });
});
