// quota-plan §9 (tests/config/quota-settings.test.ts): quota.* settings block —
// parser tolerance + spec surface + time-unit dual track. Style follows
// memory-settings.test.ts (per-block settings test file).

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  isTimeSettingKey,
  loadSettings,
  parseQuotaSettings,
  TIME_SETTING_MS_PATHS,
} from "../../src/config/settings.js";
import { currentOf, defaultOf, isKnownSettingKey, SETTING_SPECS } from "../../src/config/setting-specs.js";

const defaults = DEFAULT_SETTINGS.quota;

const QUOTA_TIME_PATHS = [
  "quota.refreshMs",
  "quota.staleAfterMs",
  "quota.l3EtaMs",
  "quota.minIntervalMs",
  "quota.repeatMs",
  "quota.requestTimeoutMs",
] as const;

const QUOTA_SPEC_KEYS = [
  "quota.enabled",
  "quota.providers",
  "quota.subscriptionProviders",
  "quota.refreshS",
  "quota.staleAfterS",
  "quota.l1Percent",
  "quota.l2Percent",
  "quota.l3Percent",
  "quota.l3EtaS",
  "quota.tickStepPercent",
  "quota.minIntervalS",
  "quota.repeatS",
  "quota.display",
  "quota.gate",
  "quota.gateLevel",
  "quota.hud",
  "quota.requestTimeoutS",
] as const;

describe("quota settings", () => {
  it("pins the defaults (quota-plan §8.2)", () => {
    expect(defaults).toEqual({
      enabled: true,
      providers: "zai-coding-cn,zai,kimi-coding",
      subscriptionProviders: "",
      refreshMs: 600_000,
      staleAfterMs: 3_600_000,
      l1Percent: 50,
      l2Percent: 75,
      l3Percent: 90,
      l3EtaMs: 1_800_000,
      tickStepPercent: 10,
      minIntervalMs: 300_000,
      repeatMs: 1_800_000,
      display: true,
      gate: true,
      gateLevel: 3,
      hud: true,
      requestTimeoutMs: 10_000,
      zaiBaseUrl: "https://open.bigmodel.cn",
      zaiOverseasBaseUrl: "https://api.z.ai",
      kimiBaseUrl: "https://api.kimi.com",
      userAgent: "",
    });
  });

  it("falls back for missing and non-object blocks", () => {
    for (const input of [undefined, null, 0, "nope", true, [], [1, 2]]) {
      expect(parseQuotaSettings(input)).toEqual(defaults);
    }
    expect(parseQuotaSettings({})).toEqual(defaults);
  });

  it("tolerates garbage field-by-field and never throws (incl. refreshMs out of range, gateLevel: 0)", () => {
    expect(
      parseQuotaSettings({
        enabled: "yes",
        providers: 42,
        refreshMs: 59_999, // below the 60s floor
        staleAfterMs: Number.NaN,
        l1Percent: 0,
        l2Percent: 101,
        l3Percent: "ninety",
        l3EtaMs: "soon",
        tickStepPercent: -5,
        minIntervalMs: Number.POSITIVE_INFINITY,
        repeatMs: null,
        display: 1,
        gate: "true",
        gateLevel: 0,
        hud: null,
        requestTimeoutMs: 500, // below the 1s floor
        zaiBaseUrl: "ftp://example.com",
        zaiOverseasBaseUrl: 7,
        kimiBaseUrl: {},
        userAgent: 42,
      }),
    ).toEqual(defaults);
    // upper bound too: refreshMs above 24h also falls back
    expect(parseQuotaSettings({ refreshMs: 86_400_001 }).refreshMs).toBe(defaults.refreshMs);
    expect(parseQuotaSettings({ gateLevel: 4 }).gateLevel).toBe(defaults.gateLevel);
  });

  it("clamps thresholds monotonically (l1 <= l2 <= l3, quota-plan §8.3)", () => {
    const parsed = parseQuotaSettings({ l1Percent: 80, l2Percent: 50, l3Percent: 60 });
    expect(parsed.l1Percent).toBe(80);
    expect(parsed.l2Percent).toBe(80);
    expect(parsed.l3Percent).toBe(80);
    // a legal descending config passes through untouched
    const legal = parseQuotaSettings({ l1Percent: 40, l2Percent: 70, l3Percent: 95 });
    expect([legal.l1Percent, legal.l2Percent, legal.l3Percent]).toEqual([40, 70, 95]);
  });

  it("validates base URLs: non-http(s) falls back, trailing slashes are trimmed", () => {
    expect(parseQuotaSettings({ zaiBaseUrl: "ftp://example.com" }).zaiBaseUrl).toBe(defaults.zaiBaseUrl);
    expect(parseQuotaSettings({ kimiBaseUrl: "example.com" }).kimiBaseUrl).toBe(defaults.kimiBaseUrl);
    expect(parseQuotaSettings({ zaiBaseUrl: "  " }).zaiBaseUrl).toBe(defaults.zaiBaseUrl);
    expect(parseQuotaSettings({ zaiBaseUrl: "https://proxy.internal:8443///" }).zaiBaseUrl).toBe(
      "https://proxy.internal:8443",
    );
    expect(parseQuotaSettings({ zaiOverseasBaseUrl: "http://localhost:9000/" }).zaiOverseasBaseUrl).toBe(
      "http://localhost:9000",
    );
  });

  it("exposes the quota duration keys as time settings (seconds storage keys)", () => {
    expect(isTimeSettingKey("quota.refreshS")).toBe(true);
    expect(isTimeSettingKey("quota.refreshMs")).toBe(false);
    expect(isTimeSettingKey("quota.l1Percent")).toBe(false);
  });

  it("registers all six quota.* duration paths in TIME_SETTING_MS_PATHS", () => {
    for (const path of QUOTA_TIME_PATHS) {
      expect(TIME_SETTING_MS_PATHS, path).toContain(path);
      expect(isTimeSettingKey(path.replace(/Ms$/, "S")), path).toBe(true);
    }
    // non-duration quota fields must NOT be registered
    expect(TIME_SETTING_MS_PATHS).not.toContain("quota.l1Percent");
    expect(TIME_SETTING_MS_PATHS).not.toContain("quota.gateLevel");
    expect(TIME_SETTING_MS_PATHS).not.toContain("quota.providers");
  });

  it("exposes quota.* in SETTING_SPECS, all non-live, with baseUrl*/userAgent absent", () => {
    for (const key of QUOTA_SPEC_KEYS) {
      expect(isKnownSettingKey(key), key).toBe(true);
      const spec = SETTING_SPECS[key]!;
      expect(spec.live, key).toBeUndefined();
      expect(spec.path, key).toMatch(/^quota\./);
      expect(defaultOf(spec), key).not.toBeUndefined();
      expect(currentOf(DEFAULT_SETTINGS, spec), key).not.toBe("(unset)");
    }
    // duration specs carry time:true and point at the internal *Ms path
    expect(SETTING_SPECS["quota.refreshS"]).toMatchObject({ kind: "number", path: "quota.refreshMs", time: true });
    expect(SETTING_SPECS["quota.requestTimeoutS"]).toMatchObject({ kind: "number", path: "quota.requestTimeoutMs" });
    // gateLevel needs a max that count() cannot express
    expect(SETTING_SPECS["quota.gateLevel"]).toMatchObject({
      kind: "number",
      path: "quota.gateLevel",
      min: 1,
      max: 3,
      integer: true,
    });
    // escape hatches stay JSON-file-only (§8.5)
    for (const absent of ["quota.zaiBaseUrl", "quota.zaiOverseasBaseUrl", "quota.kimiBaseUrl", "quota.userAgent"]) {
      expect(isKnownSettingKey(absent), absent).toBe(false);
    }
  });

  it("converts the file's *S seconds to internal milliseconds via loadSettings", () => {
    expect(loadSettings({ quota: { refreshS: 300 } }).quota.refreshMs).toBe(300_000);
    expect(loadSettings({ quota: { repeatS: 0 } }).quota.repeatMs).toBe(0);
    // invalid block wired through loadSettings also falls back to defaults
    expect(loadSettings({ quota: "invalid" }).quota).toEqual(defaults);
  });
});
