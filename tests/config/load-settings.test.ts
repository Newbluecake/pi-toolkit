// sysload plan (docs/dev/sysload/plan.md) §6.1 P0: `load.*` settings block — parser tolerance +
// spec surface + time-unit dual track + the cross-domain `webHub.load` flag. Style follows
// quota-settings.test.ts (per-block settings test file).

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  isTimeSettingKey,
  loadSettings,
  parseLoadSettings,
  TIME_SETTING_MS_PATHS,
} from "../../src/config/settings.js";
import { parseWebHubSettings } from "../../src/web-hub/agent/settings.js";
import { currentOf, defaultOf, isKnownSettingKey, SETTING_SPECS } from "../../src/config/setting-specs.js";
import {
  DEFAULT_LOAD_RECOVER_MS,
  DEFAULT_LOAD_SAMPLE_INTERVAL_MS,
  DEFAULT_LOAD_SUSTAIN_MS,
  DEFAULT_LOAD_THRESHOLDS,
  LOAD_SUSTAIN_RECOVER_MAX_FACTOR,
} from "../../src/sysload/types.js";

const defaults = DEFAULT_SETTINGS.load;

const LOAD_TIME_PATHS = [
  "load.sampleIntervalMs",
  "load.sustainMs",
  "load.recoverMs",
  "load.hint.repeatMs",
  "load.hint.minIntervalMs",
] as const;

const LOAD_SPEC_KEYS = [
  "load.enabled",
  "load.gate",
  "load.gateLevel",
  "load.sampleIntervalS",
  "load.sustainS",
  "load.recoverS",
  "load.cpu.warnPercent",
  "load.cpu.critPercent",
  "load.cpu.psiWarnPercent",
  "load.cpu.psiCritPercent",
  "load.mem.warnAvailPercent",
  "load.mem.critAvailPercent",
  "load.disk.warnFreePercent",
  "load.disk.critFreePercent",
  "load.disk.critFreeGiB",
  "load.hint.enabled",
  "load.hint.display",
  "load.hint.repeatS",
  "load.hint.minIntervalS",
  "load.hud",
] as const;

describe("load settings", () => {
  it("pins the defaults (sysload plan §2 U2/§6.1)", () => {
    expect(defaults).toEqual({
      enabled: true,
      gate: true,
      gateLevel: "crit",
      sampleIntervalMs: 5_000,
      sustainMs: 60_000,
      recoverMs: 30_000,
      cpu: { warnPercent: 85, critPercent: 95, psiWarnPercent: 40, psiCritPercent: 70 },
      mem: { warnAvailPercent: 15, critAvailPercent: 8 },
      disk: { warnFreePercent: 10, critFreePercent: 5, critFreeGiB: 5 },
      hint: { enabled: true, display: true, repeatMs: 600_000, minIntervalMs: 120_000 },
      hud: true,
    });
    // DEFAULT_SETTINGS.load reuses the frozen sysload constants rather than re-stating the
    // numbers — pin that equivalence too so the two never drift silently.
    expect(defaults.cpu).toEqual(DEFAULT_LOAD_THRESHOLDS.cpu);
    expect(defaults.mem).toEqual(DEFAULT_LOAD_THRESHOLDS.mem);
    expect(defaults.disk).toEqual(DEFAULT_LOAD_THRESHOLDS.disk);
    expect(defaults.sampleIntervalMs).toBe(DEFAULT_LOAD_SAMPLE_INTERVAL_MS);
    expect(defaults.sustainMs).toBe(DEFAULT_LOAD_SUSTAIN_MS);
    expect(defaults.recoverMs).toBe(DEFAULT_LOAD_RECOVER_MS);
  });

  it("falls back for missing and non-object blocks", () => {
    for (const input of [undefined, null, 0, "nope", true, [], [1, 2]]) {
      expect(parseLoadSettings(input)).toEqual(defaults);
    }
    expect(parseLoadSettings({})).toEqual(defaults);
  });

  it("tolerates garbage field-by-field and never throws", () => {
    expect(
      parseLoadSettings({
        enabled: "yes",
        gate: 1,
        gateLevel: "crazy",
        sampleIntervalMs: "fast",
        sustainMs: Number.NaN,
        recoverMs: Number.POSITIVE_INFINITY,
        cpu: "nope",
        mem: 42,
        disk: [],
        hint: "nope",
        hud: null,
      }),
    ).toEqual(defaults);
    // nested garbage field-by-field
    expect(
      parseLoadSettings({
        cpu: { warnPercent: "x", critPercent: null, psiWarnPercent: {}, psiCritPercent: [] },
        mem: { warnAvailPercent: "x", critAvailPercent: undefined },
        disk: { warnFreePercent: "x", critFreePercent: NaN, critFreeGiB: "five" },
        hint: { enabled: "x", display: 0, repeatMs: "x", minIntervalMs: {} },
      }),
    ).toEqual(defaults);
  });

  it("clamps sampleIntervalMs into [2000,60000] (§5.2 upper bound)", () => {
    expect(parseLoadSettings({ sampleIntervalMs: 1 }).sampleIntervalMs).toBe(2_000);
    expect(parseLoadSettings({ sampleIntervalMs: 999_999 }).sampleIntervalMs).toBe(60_000);
    expect(parseLoadSettings({ sampleIntervalMs: 10_000 }).sampleIntervalMs).toBe(10_000);
  });

  it("clamps sustainMs into [0, 120×interval] and recoverMs into [interval, 120×interval] (§5.2)", () => {
    const withSmallInterval = parseLoadSettings({ sampleIntervalMs: 2_000, sustainMs: -5, recoverMs: 0 });
    expect(withSmallInterval.sustainMs).toBe(0); // clamped up to the floor
    expect(withSmallInterval.recoverMs).toBe(2_000); // clamped up to interval (the floor)

    const bigInterval = 60_000;
    const max = LOAD_SUSTAIN_RECOVER_MAX_FACTOR * bigInterval;
    const overflowing = parseLoadSettings({
      sampleIntervalMs: bigInterval,
      sustainMs: max * 10,
      recoverMs: max * 10,
    });
    expect(overflowing.sustainMs).toBe(max);
    expect(overflowing.recoverMs).toBe(max);

    // the DEFAULT recoverMs (30000) is below a large explicit interval (60000) — the invariant
    // (recoverMs >= interval) must still hold for the returned value even though the caller
    // never touched recoverMs at all (only clamping the fallback itself achieves this).
    const recoverFallbackBelowInterval = parseLoadSettings({ sampleIntervalMs: bigInterval });
    expect(recoverFallbackBelowInterval.recoverMs).toBeGreaterThanOrEqual(bigInterval);
    expect(recoverFallbackBelowInterval.recoverMs).toBe(bigInterval);
  });

  it("clamps CPU thresholds monotonically (warn <= crit, higher busy/PSI is worse)", () => {
    const inverted = parseLoadSettings({ cpu: { warnPercent: 90, critPercent: 50 } });
    expect(inverted.cpu.warnPercent).toBe(90);
    expect(inverted.cpu.critPercent).toBe(90); // clamped UP to warn
    const invertedPsi = parseLoadSettings({ cpu: { psiWarnPercent: 80, psiCritPercent: 10 } });
    expect(invertedPsi.cpu.psiCritPercent).toBe(80);
    // a legal ascending config passes through untouched
    const legal = parseLoadSettings({ cpu: { warnPercent: 60, critPercent: 90 } });
    expect([legal.cpu.warnPercent, legal.cpu.critPercent]).toEqual([60, 90]);
  });

  it("clamps MEM thresholds monotonically (warn >= crit, lower avail% is worse)", () => {
    const inverted = parseLoadSettings({ mem: { warnAvailPercent: 5, critAvailPercent: 50 } });
    expect(inverted.mem.warnAvailPercent).toBe(5);
    expect(inverted.mem.critAvailPercent).toBe(5); // clamped DOWN to warn
    const legal = parseLoadSettings({ mem: { warnAvailPercent: 15, critAvailPercent: 8 } });
    expect([legal.mem.warnAvailPercent, legal.mem.critAvailPercent]).toEqual([15, 8]);
  });

  it("clamps DISK percent thresholds monotonically (warn >= crit, lower free% is worse)", () => {
    const inverted = parseLoadSettings({ disk: { warnFreePercent: 2, critFreePercent: 50 } });
    expect(inverted.disk.warnFreePercent).toBe(2);
    expect(inverted.disk.critFreePercent).toBe(2); // clamped DOWN to warn
  });

  it("accepts an explicit non-default critFreeGiB and renames clamp garbage to the default", () => {
    expect(parseLoadSettings({ disk: { critFreeGiB: 20 } }).disk.critFreeGiB).toBe(20);
    expect(parseLoadSettings({ disk: { critFreeGiB: -1 } }).disk.critFreeGiB).toBe(0);
    expect(parseLoadSettings({ disk: { critFreeGiB: "lots" } }).disk.critFreeGiB).toBe(defaults.disk.critFreeGiB);
  });

  it("accepts gateLevel 'warn' and 'crit' only", () => {
    expect(parseLoadSettings({ gateLevel: "warn" }).gateLevel).toBe("warn");
    expect(parseLoadSettings({ gateLevel: "crit" }).gateLevel).toBe("crit");
    expect(parseLoadSettings({ gateLevel: "info" }).gateLevel).toBe(defaults.gateLevel);
  });

  it("parses the hint sub-block field-by-field, tolerant", () => {
    const parsed = parseLoadSettings({
      hint: { enabled: false, display: false, repeatMs: 1_000, minIntervalMs: 2_000 },
    });
    expect(parsed.hint).toEqual({ enabled: false, display: false, repeatMs: 1_000, minIntervalMs: 2_000 });
  });

  it("exposes the load duration keys as time settings (seconds storage keys)", () => {
    expect(isTimeSettingKey("load.sampleIntervalS")).toBe(true);
    expect(isTimeSettingKey("load.sampleIntervalMs")).toBe(false);
    expect(isTimeSettingKey("load.cpu.warnPercent")).toBe(false);
  });

  it("registers all load.* duration paths in TIME_SETTING_MS_PATHS", () => {
    for (const path of LOAD_TIME_PATHS) {
      expect(TIME_SETTING_MS_PATHS, path).toContain(path);
      expect(isTimeSettingKey(path.replace(/Ms$/, "S")), path).toBe(true);
    }
    // non-duration load fields must NOT be registered
    expect(TIME_SETTING_MS_PATHS).not.toContain("load.cpu.warnPercent");
    expect(TIME_SETTING_MS_PATHS).not.toContain("load.gateLevel");
    expect(TIME_SETTING_MS_PATHS).not.toContain("load.disk.critFreeGiB");
  });

  it("exposes load.* in SETTING_SPECS, all non-live", () => {
    for (const key of LOAD_SPEC_KEYS) {
      expect(isKnownSettingKey(key), key).toBe(true);
      const spec = SETTING_SPECS[key]!;
      expect(spec.live, key).toBeUndefined();
      expect(spec.path, key).toMatch(/^load\./);
      expect(defaultOf(spec), key).not.toBeUndefined();
      expect(currentOf(DEFAULT_SETTINGS, spec), key).not.toBe("(unset)");
    }
    // duration specs carry time:true and point at the internal *Ms path
    expect(SETTING_SPECS["load.sampleIntervalS"]).toMatchObject({
      kind: "number",
      path: "load.sampleIntervalMs",
      time: true,
    });
    expect(SETTING_SPECS["load.hint.repeatS"]).toMatchObject({
      kind: "number",
      path: "load.hint.repeatMs",
      time: true,
    });
    // gateLevel is an enum, not a number
    expect(SETTING_SPECS["load.gateLevel"]).toMatchObject({
      kind: "enum",
      path: "load.gateLevel",
      values: ["crit", "warn"],
    });
  });

  it("loadSettings({}) carries load.enabled=true (fail-open default — §1/§6.1)", () => {
    expect(loadSettings({}).load).toEqual(defaults);
  });

  it("loadSettings threads a load block through parseLoadSettings (not a raw pass-through)", () => {
    const settings = loadSettings({ load: { enabled: false, sampleIntervalMs: 10_000 } });
    expect(settings.load.enabled).toBe(false);
    expect(settings.load.sampleIntervalMs).toBe(10_000);
    // untouched fields still carry the parser's defaults
    expect(settings.load.gate).toBe(true);
  });

  it("round-trips through the *S/*Ms seconds<->ms migration the same way quota does", () => {
    const settings = loadSettings({ load: { sampleIntervalS: 10, hint: { repeatS: 60 } } });
    expect(settings.load.sampleIntervalMs).toBe(10_000);
    expect(settings.load.hint.repeatMs).toBe(60_000);
  });

  // ---------------------------------------------------------------------------
  // webHub.load (cross-domain field, pre-approved P0 addition — see plan §10 package notes)
  // ---------------------------------------------------------------------------

  it("webHub.load defaults to true", () => {
    expect(DEFAULT_SETTINGS.webHub.load).toBe(true);
  });

  it("parseWebHubSettings keeps an explicit webHub.load=false and falls back garbage to true", () => {
    expect(parseWebHubSettings({ load: false }).load).toBe(false);
    expect(parseWebHubSettings({ load: "nope" }).load).toBe(true);
    expect(parseWebHubSettings({}).load).toBe(true);
    expect(parseWebHubSettings(undefined).load).toBe(true);
  });
});
