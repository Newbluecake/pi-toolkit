import { describe, expect, it } from "vitest";
import {
  alignFontScale,
  applyFontScale,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STORAGE_KEY,
  fontScalePercent,
  formatFontScale,
  loadFontScale,
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

describe("useFontScale (pwh_fontscale → --fs-scale, continuous 0.8–2.0 / 0.05 steps)", () => {
  it("loadFontScale: default 1 when unset; valid stored decimals load aligned", () => {
    expect(loadFontScale(fakeStorage())).toBe(1);
    expect(loadFontScale(fakeStorage({ [FONT_SCALE_STORAGE_KEY]: "1.25" }))).toBe(1.25);
    expect(loadFontScale(fakeStorage({ [FONT_SCALE_STORAGE_KEY]: "0.8" }))).toBe(0.8);
    expect(loadFontScale(fakeStorage({ [FONT_SCALE_STORAGE_KEY]: "2" }))).toBe(2);
    // stored values align to the 0.05 grid
    expect(loadFontScale(fakeStorage({ [FONT_SCALE_STORAGE_KEY]: "1.13" }))).toBe(1.15);
    expect(loadFontScale(fakeStorage({ [FONT_SCALE_STORAGE_KEY]: "1.02" }))).toBe(1);
  });

  it("loadFontScale: unparseable / out-of-range / partially-numeric values fail open to 1", () => {
    expect(loadFontScale(fakeStorage({ [FONT_SCALE_STORAGE_KEY]: "bogus" }))).toBe(1);
    expect(loadFontScale(fakeStorage({ [FONT_SCALE_STORAGE_KEY]: "" }))).toBe(1);
    expect(loadFontScale(fakeStorage({ [FONT_SCALE_STORAGE_KEY]: "0.5" }))).toBe(1); // below min
    expect(loadFontScale(fakeStorage({ [FONT_SCALE_STORAGE_KEY]: "2.5" }))).toBe(1); // above max
    expect(loadFontScale(fakeStorage({ [FONT_SCALE_STORAGE_KEY]: "1.2abc" }))).toBe(1); // strict Number(), no partial parse
    expect(loadFontScale(fakeStorage({ [FONT_SCALE_STORAGE_KEY]: "Infinity" }))).toBe(1);
  });

  it("loadFontScale: a throwing storage (disabled) fails open to 1", () => {
    const storage = {
      getItem: () => {
        throw new Error("disabled");
      },
    };
    expect(loadFontScale(storage)).toBe(1);
  });

  it("alignFontScale: clamps to [0.8, 2.0] and snaps to the 0.05 grid", () => {
    expect(alignFontScale(1)).toBe(1);
    expect(alignFontScale(0.5)).toBe(FONT_SCALE_MIN);
    expect(alignFontScale(2.5)).toBe(FONT_SCALE_MAX);
    expect(alignFontScale(1.13)).toBe(1.15);
    expect(alignFontScale(1.12)).toBe(1.1);
    expect(alignFontScale(1.8)).toBe(1.8); // no float noise
  });

  it("formatFontScale: compact decimal strings", () => {
    expect(formatFontScale(1)).toBe("1");
    expect(formatFontScale(1.25)).toBe("1.25");
    expect(formatFontScale(0.8)).toBe("0.8");
    expect(formatFontScale(2)).toBe("2");
  });

  it("fontScalePercent: 1 → 100, 1.25 → 125, 0.8 → 80", () => {
    expect(fontScalePercent(1)).toBe(100);
    expect(fontScalePercent(1.25)).toBe(125);
    expect(fontScalePercent(0.8)).toBe(80);
  });

  it("applyFontScale: writes --fs-scale on the document element", () => {
    const doc = fakeDoc();
    applyFontScale(doc, 1.3);
    expect(doc.props.get("--fs-scale")).toBe("1.3");
  });

  it("useFontScale(): reads the persisted scale on init and applies the property immediately", () => {
    const storage = fakeStorage({ [FONT_SCALE_STORAGE_KEY]: "1.5" });
    const doc = fakeDoc();
    const handle = useFontScale({ storage, doc });
    expect(handle.scale.value).toBe(1.5);
    expect(doc.props.get("--fs-scale")).toBe("1.5");
  });

  it("setScale(): clamps, aligns, persists the formatted string, and rewrites the property (round-trip)", () => {
    const storage = fakeStorage();
    const doc = fakeDoc();
    const handle = useFontScale({ storage, doc });
    handle.setScale(1.26);
    expect(handle.scale.value).toBe(1.25); // snapped to grid
    expect(storage.map.get(FONT_SCALE_STORAGE_KEY)).toBe("1.25");
    expect(doc.props.get("--fs-scale")).toBe("1.25");
    handle.setScale(9);
    expect(storage.map.get(FONT_SCALE_STORAGE_KEY)).toBe("2"); // clamped
    // persistence round-trip: a fresh composable over the same storage picks the value back up
    const doc2 = fakeDoc();
    const handle2 = useFontScale({ storage, doc: doc2 });
    expect(handle2.scale.value).toBe(2);
    expect(doc2.props.get("--fs-scale")).toBe("2");
  });

  it("preview(): applies live without touching storage (drag must not hammer localStorage)", () => {
    const storage = fakeStorage();
    const doc = fakeDoc();
    const handle = useFontScale({ storage, doc });
    handle.preview(1.8);
    handle.preview(1.6);
    expect(handle.scale.value).toBe(1.6);
    expect(doc.props.get("--fs-scale")).toBe("1.6");
    expect(storage.map.has(FONT_SCALE_STORAGE_KEY)).toBe(false);
    // a later setScale persists the final resting value
    handle.setScale(1.6);
    expect(storage.map.get(FONT_SCALE_STORAGE_KEY)).toBe("1.6");
  });

  it("reset(): returns to 100% and persists it", () => {
    const storage = fakeStorage({ [FONT_SCALE_STORAGE_KEY]: "1.8" });
    const doc = fakeDoc();
    const handle = useFontScale({ storage, doc });
    expect(handle.scale.value).toBe(1.8);
    handle.reset();
    expect(handle.scale.value).toBe(1);
    expect(doc.props.get("--fs-scale")).toBe("1");
    expect(storage.map.get(FONT_SCALE_STORAGE_KEY)).toBe("1");
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
    expect(() => handle.setScale(1.3)).not.toThrow();
    expect(doc.props.get("--fs-scale")).toBe("1.3");
  });
});
