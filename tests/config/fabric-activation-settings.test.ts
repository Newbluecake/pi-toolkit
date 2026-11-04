import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings } from "../../src/config/settings.js";
import { defaultOf, effectOf, isKnownSettingKey, SETTING_SPECS } from "../../src/config/setting-specs.js";

/** fabric-xs-activation plan §3 P0: the `fabric.crossSession.activation.*` leaves — one
 *  engineering rollback switch for the whole progress/activation group (arch §3.2). */
const defaults = DEFAULT_SETTINGS.fabric.crossSession.activation;
const activation = (block: unknown) =>
  loadSettings({ fabric: { crossSession: { activation: block } } }).fabric.crossSession.activation;

describe("fabric.crossSession.activation settings (fabric-xs-activation plan §3 P0)", () => {
  it("defaults ON; absent key ≡ on (explicit false is the off isolation)", () => {
    expect(defaults).toEqual({ enabled: true });
    expect(activation(undefined)).toEqual({ enabled: true });
    expect(loadSettings({}).fabric.crossSession.activation).toEqual({ enabled: true });
  });
  it("missing / non-object blocks fall back to defaults and never alias DEFAULT_SETTINGS", () => {
    for (const input of [null, 0, "no", true, [], [1]]) {
      const parsed = activation(input);
      expect(parsed).toEqual(defaults);
      expect(parsed).not.toBe(defaults);
    }
    // the clone never aliases the nested default object either (parseFabricSettings' clone path)
    const parsed = loadSettings({ fabric: { crossSession: { activation: { enabled: true } } } }).fabric.crossSession;
    expect(parsed.activation).toEqual(defaults);
    expect(parsed.activation).not.toBe(defaults);
  });
  it("field-by-field tolerant: only a real boolean `enabled` changes anything; unknown keys ignored", () => {
    expect(activation({ enabled: false })).toEqual({ enabled: false });
    for (const bad of ["false", 0, null, undefined, {}]) {
      expect(activation({ enabled: bad })).toEqual({ enabled: true });
    }
    expect(activation({ enabled: false, extra: 1 })).toEqual({ enabled: false });
    // a non-object fabric block keeps the default (whole-block fallback)
    expect(loadSettings({ fabric: "oops" }).fabric.crossSession.activation).toEqual({ enabled: true });
  });
  it("explicit false survives a full round-trip through the parser (off isolation pin)", () => {
    const once = loadSettings({ fabric: { crossSession: { activation: { enabled: false } } } });
    const twice = loadSettings(once.fabric ? { fabric: once.fabric } : {});
    // re-parsing the already-parsed structure keeps false (the stored preference is honoured)
    expect(twice.fabric.crossSession.activation).toEqual({ enabled: false });
  });
  it("the sibling crossSession blocks are untouched by the new leaf", () => {
    const parsed = loadSettings({}).fabric.crossSession;
    const { activation: _a, ...rest } = parsed;
    const { activation: _da, ...restDefaults } = DEFAULT_SETTINGS.fabric.crossSession;
    expect(rest).toEqual(restDefaults);
    expect(Object.keys(parsed)).toEqual([...Object.keys(restDefaults), "activation"]); // trailing append
  });
  it("is on the settable surface as a known, non-live key (corpus append is P5's declared refresh)", () => {
    expect(isKnownSettingKey("fabric.crossSession.activation.enabled")).toBe(true);
    const spec = SETTING_SPECS["fabric.crossSession.activation.enabled"];
    expect(spec).toBeDefined();
    if (spec !== undefined) {
      expect(defaultOf(spec)).toBe(true); // default true
      expect(effectOf(spec)).toBe("takes effect after /reload"); // non-live (arch §3.2)
      expect((spec as { live?: boolean }).live).toBeFalsy();
    }
    // listed after alias.autoFromCwd — the fabric shard's listing order only gains the trailing key
    const keys = Object.keys(SETTING_SPECS).filter((k) => k.startsWith("fabric."));
    expect(keys.indexOf("fabric.crossSession.activation.enabled")).toBe(keys.length - 1);
  });
});
