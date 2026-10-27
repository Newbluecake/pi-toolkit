import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings } from "../../src/config/settings.js";
import { parseFabricXsAliasSettings } from "../../src/fabric/settings.js";

/** alias-plan §3.6 (AL0b). */
const d = DEFAULT_SETTINGS.fabric.crossSession.alias;
const al = (block: unknown) => loadSettings({ fabric: { crossSession: { alias: block } } }).fabric.crossSession.alias;

describe("fabric.crossSession.alias settings", () => {
  it("defaults: on, 168h, 10min cool, 10min take floor", () => {
    expect(d).toEqual({ enabled: true, offlineLeaseH: 168, coolMin: 10, takeMinOfflineMin: 10 });
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
  it("does not disturb sibling blocks", () => {
    const cs = loadSettings({ fabric: { crossSession: { alias: { coolMin: 30 } } } }).fabric.crossSession;
    expect(cs.channels).toEqual(DEFAULT_SETTINGS.fabric.crossSession.channels);
    expect(cs.reply).toEqual(DEFAULT_SETTINGS.fabric.crossSession.reply);
  });
});
