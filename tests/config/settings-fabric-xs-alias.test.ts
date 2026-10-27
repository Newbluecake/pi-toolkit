import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings } from "../../src/config/settings.js";
import { parseFabricXsAliasSettings } from "../../src/fabric/settings.js";
import { FABRIC_SETTING_SPECS } from "../../src/fabric/setting-specs.js";
import {
  currentOf,
  defaultOf,
  effectOf,
  isKnownSettingKey,
  parseSettingValue,
  SETTING_SPECS,
  writeSetting,
} from "../../src/config/setting-specs.js";

/** alias-plan §3.6 (AL0b). */
const d = DEFAULT_SETTINGS.fabric.crossSession.alias;
const al = (block: unknown) => loadSettings({ fabric: { crossSession: { alias: block } } }).fabric.crossSession.alias;

describe("fabric.crossSession.alias settings", () => {
  it("defaults: on, 168h, 10min cool, 10min take floor, autoFromCwd on", () => {
    expect(d).toEqual({ enabled: true, offlineLeaseH: 168, coolMin: 10, takeMinOfflineMin: 10, autoFromCwd: true });
    expect(loadSettings({}).fabric.crossSession.alias).toEqual(d);
    expect(loadSettings({}).fabric.crossSession.alias).not.toBe(d);
  });
  it("non-object blocks fall back without aliasing", () => {
    for (const input of [undefined, null, 1, "x", true, [], [1]]) {
      const parsed = parseFabricXsAliasSettings(input);
      expect(parsed).toEqual(d);
      expect(parsed).not.toBe(d);
    }
  });
  it("offlineLeaseH clamps to 1–720 and floors", () => {
    expect(al({ offlineLeaseH: 0 }).offlineLeaseH).toBe(1);
    expect(al({ offlineLeaseH: -3 }).offlineLeaseH).toBe(1);
    expect(al({ offlineLeaseH: 721 }).offlineLeaseH).toBe(720);
    expect(al({ offlineLeaseH: 24.9 }).offlineLeaseH).toBe(24);
  });
  it("takeMinOfflineMin can never go below the NQ1 floor of 10 (range 10–1440)", () => {
    expect(al({ takeMinOfflineMin: 0 }).takeMinOfflineMin).toBe(10);
    expect(al({ takeMinOfflineMin: 9 }).takeMinOfflineMin).toBe(10);
    expect(al({ takeMinOfflineMin: 30 }).takeMinOfflineMin).toBe(30);
    expect(al({ takeMinOfflineMin: 99_999 }).takeMinOfflineMin).toBe(1_440);
  });
  it("coolMin clamps to 1–1440", () => {
    expect(al({ coolMin: 0 }).coolMin).toBe(1);
    expect(al({ coolMin: 5000 }).coolMin).toBe(1_440);
    expect(al({ coolMin: 20 }).coolMin).toBe(20);
  });
  it("wrong-typed leaves fall back field by field; enabled is honoured", () => {
    expect(al({ enabled: "no", offlineLeaseH: "9", coolMin: NaN, takeMinOfflineMin: null })).toEqual(d);
    expect(al({ enabled: false }).enabled).toBe(false);
    expect(al({ enabled: false, coolMin: 30 })).toEqual({ ...d, enabled: false, coolMin: 30 });
  });
  it("autoFromCwd (alias-force-default §6): default true, honours booleans, wrong types fall back, siblings untouched", () => {
    expect(d.autoFromCwd).toBe(true);
    expect(al({ autoFromCwd: false }).autoFromCwd).toBe(false);
    expect(al({ autoFromCwd: true }).autoFromCwd).toBe(true);
    for (const bad of ["false", 0, null, [], {}]) expect(al({ autoFromCwd: bad }).autoFromCwd).toBe(true);
    expect(al({ autoFromCwd: false, coolMin: 30 })).toEqual({ ...d, autoFromCwd: false, coolMin: 30 });
    expect(al({ enabled: false }).autoFromCwd).toBe(true); // independent of alias.enabled (the agent gates on both)
    expect(parseFabricXsAliasSettings({ autoFromCwd: false }).autoFromCwd).toBe(false);
  });
  it("does not disturb sibling blocks", () => {
    const cs = loadSettings({ fabric: { crossSession: { alias: { coolMin: 30 } } } }).fabric.crossSession;
    expect(cs.channels).toEqual(DEFAULT_SETTINGS.fabric.crossSession.channels);
    expect(cs.reply).toEqual(DEFAULT_SETTINGS.fabric.crossSession.reply);
  });
});

describe("fabric.crossSession.alias.autoFromCwd setting spec (alias-force-default §6)", () => {
  const key = "fabric.crossSession.alias.autoFromCwd";
  it("is a known, non-live boolean spec whose path/default match DEFAULT_SETTINGS", () => {
    expect(isKnownSettingKey(key)).toBe(true);
    const spec = SETTING_SPECS[key]!;
    expect(spec).toMatchObject({ kind: "boolean", path: key });
    expect(spec.live).toBeUndefined();
    expect(effectOf(spec)).toBe("takes effect after /reload");
    expect(defaultOf(spec)).toBe(true);
    expect(currentOf(DEFAULT_SETTINGS, spec)).toBe(true);
  });
  it("is the LAST fabric shard entry (appended after fabric.wake.parkCapPerTarget) and the only crossSession key on the surface", () => {
    const keys = Object.keys(FABRIC_SETTING_SPECS);
    expect(keys[keys.length - 1]).toBe(key);
    expect(keys[keys.length - 2]).toBe("fabric.wake.parkCapPerTarget");
    expect(Object.keys(SETTING_SPECS).filter((k) => k.startsWith("fabric.crossSession."))).toEqual([key]);
  });
  it("round-trips a write: parse → live object → persisted stored value, and reloads through loadSettings", () => {
    const spec = SETTING_SPECS[key]!;
    const parsed = parseSettingValue(spec, "false");
    expect(parsed).toMatchObject({ ok: true, stored: false, live: false });
    expect(parseSettingValue(spec, "maybe").ok).toBe(false);
    const persisted: [string, unknown][] = [];
    const current = loadSettings({});
    if (!parsed.ok) throw new Error("unreachable");
    const r = writeSetting({ current, persist: (k, v) => (persisted.push([k, v]), undefined) }, key, parsed);
    expect(current.fabric.crossSession.alias.autoFromCwd).toBe(false);
    expect(persisted).toEqual([[key, false]]);
    expect(r).toMatchObject({ key, previous: "true", next: "false", effect: "takes effect after /reload" });
    expect(
      loadSettings({ fabric: { crossSession: { alias: { autoFromCwd: false } } } }).fabric.crossSession.alias
        .autoFromCwd,
    ).toBe(false);
  });
});
