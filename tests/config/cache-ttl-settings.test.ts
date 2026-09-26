import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, isTimeSettingKey, loadSettings, parseCacheTtlSettings } from "../../src/config/settings.js";
import { SETTING_SPECS, parseSettingValue } from "../../src/config/setting-specs.js";

const PROMOTED_DEFAULT = { ...DEFAULT_SETTINGS.cacheTtl, mode: "adaptive" as const };

describe("cache-ttl keepalive settings", () => {
  it("defaults match plan.md §10.1 (mode stays the flag-off default; adaptive promotion happens in parse)", () => {
    expect(DEFAULT_SETTINGS.cacheTtl).toEqual({
      mode: "auto",
      keepalive: true,
      keepaliveIntervalMs: 240_000,
      keepaliveMaxPings: 11,
      keepaliveMinPrefixTokens: 20_000,
      keepaliveUpgradeAfterBudget: true,
      adaptiveEnabled: true,
      adaptiveWriteBudgetTokens: 200_000,
      adaptiveWriteBudgetUsd: 1.0,
      adaptiveFeeBudgetTokens: 600_000,
      adaptiveFeeBudgetUsd: 3.0,
      adaptiveMaxDeltaTokens: 32_000,
      adaptiveRefreshAfterTokens: 16_000,
      adaptiveColdUpgrades: 1,
      adaptiveColdCooldownMs: 1_200_000,
      adaptiveColdMinHorizonMs: 600_000,
      adaptiveHistoryGapSignal: true,
      childKeepalive: true,
      childKeepaliveMaxPingsPerRun: 24,
      childKeepaliveMaxConcurrent: 4,
      childKeepaliveRunBudgetUsd: 1.5,
      childKeepaliveProcessBudgetUsd: 10,
    });
  });

  it("falls back field-by-field on malformed input, never throws", () => {
    for (const input of [undefined, null, [], "x", 42]) {
      // adaptive plan.md §7.1: absent block ⇒ adaptiveEnabled (default on) promotes the default mode.
      expect(parseCacheTtlSettings(input)).toEqual(PROMOTED_DEFAULT);
    }
    expect(
      parseCacheTtlSettings({
        keepalive: "nope",
        keepaliveIntervalMs: "nope",
        keepaliveMaxPings: -1,
        keepaliveMinPrefixTokens: NaN,
        keepaliveUpgradeAfterBudget: 1,
        adaptiveEnabled: "nope",
        adaptiveWriteBudgetTokens: -1,
        adaptiveWriteBudgetUsd: -1,
        adaptiveFeeBudgetTokens: -1,
        adaptiveFeeBudgetUsd: 101,
        adaptiveMaxDeltaTokens: "nope",
        adaptiveRefreshAfterTokens: NaN,
        adaptiveColdUpgrades: -3,
        adaptiveColdCooldownMs: 1_000,
        adaptiveColdMinHorizonMs: 9_999_999,
        adaptiveHistoryGapSignal: 1,
      }),
    ).toEqual(PROMOTED_DEFAULT);
  });

  it("accepts valid overrides", () => {
    expect(
      parseCacheTtlSettings({
        keepalive: false,
        keepaliveIntervalMs: 120_000,
        keepaliveMaxPings: 5,
        keepaliveMinPrefixTokens: 5_000,
        keepaliveUpgradeAfterBudget: false,
        adaptiveEnabled: false,
        adaptiveWriteBudgetTokens: 0,
        adaptiveWriteBudgetUsd: 0.25,
        adaptiveFeeBudgetTokens: 300_000,
        adaptiveFeeBudgetUsd: 1.5,
        adaptiveMaxDeltaTokens: 10_000,
        adaptiveRefreshAfterTokens: 4_000,
        adaptiveColdUpgrades: 3,
        adaptiveColdCooldownMs: 600_000,
        adaptiveColdMinHorizonMs: 0,
        adaptiveHistoryGapSignal: false,
      }),
    ).toEqual({
      // absent mode + adaptiveEnabled:false ⇒ the flag-off default, byte-for-byte today's behaviour
      mode: "auto",
      keepalive: false,
      keepaliveIntervalMs: 120_000,
      keepaliveMaxPings: 5,
      keepaliveMinPrefixTokens: 5_000,
      keepaliveUpgradeAfterBudget: false,
      adaptiveEnabled: false,
      adaptiveWriteBudgetTokens: 0,
      adaptiveWriteBudgetUsd: 0.25,
      adaptiveFeeBudgetTokens: 300_000,
      adaptiveFeeBudgetUsd: 1.5,
      adaptiveMaxDeltaTokens: 10_000,
      adaptiveRefreshAfterTokens: 4_000,
      adaptiveColdUpgrades: 3,
      adaptiveColdCooldownMs: 600_000,
      adaptiveColdMinHorizonMs: 0,
      adaptiveHistoryGapSignal: false,
      childKeepalive: true,
      childKeepaliveMaxPingsPerRun: 24,
      childKeepaliveMaxConcurrent: 4,
      childKeepaliveRunBudgetUsd: 1.5,
      childKeepaliveProcessBudgetUsd: 10,
    });
  });

  it("parses adaptiveWriteBudgetUsd without flooring: fractional budgets survive, 0 = gate off, >100 falls back", () => {
    // 0.5 must stay 0.5 — flooring it to 0 would silently DISABLE the USD gate.
    expect(parseCacheTtlSettings({ adaptiveWriteBudgetUsd: 0.5 }).adaptiveWriteBudgetUsd).toBe(0.5);
    expect(parseCacheTtlSettings({ adaptiveWriteBudgetUsd: 0 }).adaptiveWriteBudgetUsd).toBe(0);
    expect(parseCacheTtlSettings({ adaptiveWriteBudgetUsd: 100 }).adaptiveWriteBudgetUsd).toBe(100);
    expect(parseCacheTtlSettings({ adaptiveWriteBudgetUsd: 100.5 }).adaptiveWriteBudgetUsd).toBe(
      DEFAULT_SETTINGS.cacheTtl.adaptiveWriteBudgetUsd,
    );
    expect(parseCacheTtlSettings({ adaptiveWriteBudgetUsd: NaN }).adaptiveWriteBudgetUsd).toBe(
      DEFAULT_SETTINGS.cacheTtl.adaptiveWriteBudgetUsd,
    );
  });

  it("clamps keepaliveIntervalMs into [60s, 280s]", () => {
    expect(parseCacheTtlSettings({ keepaliveIntervalMs: 1_000 }).keepaliveIntervalMs).toBe(
      DEFAULT_SETTINGS.cacheTtl.keepaliveIntervalMs,
    );
    expect(parseCacheTtlSettings({ keepaliveIntervalMs: 300_000 }).keepaliveIntervalMs).toBe(
      DEFAULT_SETTINGS.cacheTtl.keepaliveIntervalMs,
    );
    expect(parseCacheTtlSettings({ keepaliveIntervalMs: 60_000 }).keepaliveIntervalMs).toBe(60_000);
    expect(parseCacheTtlSettings({ keepaliveIntervalMs: 280_000 }).keepaliveIntervalMs).toBe(280_000);
  });

  it("keepaliveIntervalMs is registered as a duration field (seconds on disk)", () => {
    expect(isTimeSettingKey("cacheTtl.keepaliveIntervalS")).toBe(true);
  });

  it("round-trips through loadSettings with seconds-on-disk storage", () => {
    const loaded = loadSettings({ cacheTtl: { keepaliveIntervalS: 90 } });
    expect(loaded.cacheTtl.keepaliveIntervalMs).toBe(90_000);
  });

  it("registers the 5 SETTING_SPECS entries per plan.md §10.3 step 5", () => {
    expect(SETTING_SPECS["cacheTtl.keepalive"]).toMatchObject({ kind: "boolean", path: "cacheTtl.keepalive" });
    expect(SETTING_SPECS["cacheTtl.keepaliveIntervalS"]).toMatchObject({
      kind: "number",
      path: "cacheTtl.keepaliveIntervalMs",
      time: true,
      min: 60,
      max: 280,
    });
    expect(SETTING_SPECS["cacheTtl.keepaliveMaxPings"]).toMatchObject({
      kind: "number",
      path: "cacheTtl.keepaliveMaxPings",
    });
    expect(SETTING_SPECS["cacheTtl.keepaliveMinPrefixTokens"]).toMatchObject({
      kind: "number",
      path: "cacheTtl.keepaliveMinPrefixTokens",
    });
    expect(SETTING_SPECS["cacheTtl.keepaliveUpgradeAfterBudget"]).toMatchObject({
      kind: "boolean",
      path: "cacheTtl.keepaliveUpgradeAfterBudget",
    });
  });
});

describe("cache-ttl adaptive settings (adaptive plan.md §7)", () => {
  it("adaptive is a whitelisted mode; absent/invalid modes resolve via the adaptiveEnabled flag", () => {
    expect(parseCacheTtlSettings({ mode: "adaptive" }).mode).toBe("adaptive");
    for (const mode of ["auto", "on", "off"] as const) {
      // an explicitly written mode always wins over the flag (§7.1)
      expect(parseCacheTtlSettings({ mode }).mode).toBe(mode);
      expect(parseCacheTtlSettings({ mode, adaptiveEnabled: false }).mode).toBe(mode);
    }
    // invalid/absent ⇒ flag-gated default
    expect(parseCacheTtlSettings({ mode: "bogus" }).mode).toBe("adaptive");
    expect(parseCacheTtlSettings({ mode: 1 }).mode).toBe("adaptive");
    expect(parseCacheTtlSettings({ mode: "bogus", adaptiveEnabled: false }).mode).toBe("auto");
    expect(parseCacheTtlSettings({ adaptiveEnabled: false }).mode).toBe("auto");
  });

  it("clamps adaptiveColdCooldownMs into [60s, 7200s] and adaptiveColdMinHorizonMs into [0, 7200s]", () => {
    expect(parseCacheTtlSettings({ adaptiveColdCooldownMs: 59_999 }).adaptiveColdCooldownMs).toBe(1_200_000);
    expect(parseCacheTtlSettings({ adaptiveColdCooldownMs: 7_200_001 }).adaptiveColdCooldownMs).toBe(1_200_000);
    expect(parseCacheTtlSettings({ adaptiveColdCooldownMs: 60_000 }).adaptiveColdCooldownMs).toBe(60_000);
    expect(parseCacheTtlSettings({ adaptiveColdMinHorizonMs: -1 }).adaptiveColdMinHorizonMs).toBe(600_000);
    expect(parseCacheTtlSettings({ adaptiveColdMinHorizonMs: 0 }).adaptiveColdMinHorizonMs).toBe(0);
  });

  it("registers both new ms paths as duration fields with seconds display keys", () => {
    expect(isTimeSettingKey("cacheTtl.adaptiveColdCooldownS")).toBe(true);
    expect(isTimeSettingKey("cacheTtl.adaptiveColdMinHorizonS")).toBe(true);
    const loaded = loadSettings({ cacheTtl: { adaptiveColdCooldownS: 300, adaptiveColdMinHorizonS: 900 } });
    expect(loaded.cacheTtl.adaptiveColdCooldownMs).toBe(300_000);
    expect(loaded.cacheTtl.adaptiveColdMinHorizonMs).toBe(900_000);
  });

  it("registers the 8 adaptive SETTING_SPECS entries and the 4-value mode choice", () => {
    expect(SETTING_SPECS["cacheTtl.mode"]).toMatchObject({ kind: "enum", values: ["auto", "on", "off", "adaptive"] });
    expect(SETTING_SPECS["cacheTtl.adaptiveEnabled"]).toMatchObject({
      kind: "boolean",
      path: "cacheTtl.adaptiveEnabled",
    });
    expect(SETTING_SPECS["cacheTtl.adaptiveWriteBudgetTokens"]).toMatchObject({
      kind: "number",
      path: "cacheTtl.adaptiveWriteBudgetTokens",
    });
    expect(SETTING_SPECS["cacheTtl.adaptiveWriteBudgetUsd"]).toMatchObject({
      kind: "number",
      path: "cacheTtl.adaptiveWriteBudgetUsd",
      min: 0,
    });
    expect(SETTING_SPECS["cacheTtl.adaptiveMaxDeltaTokens"]).toMatchObject({
      kind: "number",
      path: "cacheTtl.adaptiveMaxDeltaTokens",
    });
    expect(SETTING_SPECS["cacheTtl.adaptiveRefreshAfterTokens"]).toMatchObject({
      kind: "number",
      path: "cacheTtl.adaptiveRefreshAfterTokens",
    });
    expect(SETTING_SPECS["cacheTtl.adaptiveColdUpgrades"]).toMatchObject({
      kind: "number",
      path: "cacheTtl.adaptiveColdUpgrades",
    });
    expect(SETTING_SPECS["cacheTtl.adaptiveColdCooldownS"]).toMatchObject({
      kind: "number",
      path: "cacheTtl.adaptiveColdCooldownMs",
      time: true,
      min: 60,
      max: 7200,
    });
    expect(SETTING_SPECS["cacheTtl.adaptiveColdMinHorizonS"]).toMatchObject({
      kind: "number",
      path: "cacheTtl.adaptiveColdMinHorizonMs",
      time: true,
    });
    expect(SETTING_SPECS["cacheTtl.adaptiveHistoryGapSignal"]).toMatchObject({
      kind: "boolean",
      path: "cacheTtl.adaptiveHistoryGapSignal",
    });
  });
});

// ---------------------------------------------------------------------------
// v1 review M1: the editor / `set` path validates against SETTING_SPECS only,
// while a reload re-parses through parseCacheTtlSettings — whose out-of-range
// handling is FALL BACK TO DEFAULT, not clamp. If the two bounds drift apart,
// an accepted value applies live (settings.cacheTtl is the very object the
// adaptive service reads) and then silently reverts on the next reload.
// ---------------------------------------------------------------------------

describe("adaptiveWriteBudgetUsd — spec bounds must mirror the parser", () => {
  const spec = SETTING_SPECS["cacheTtl.adaptiveWriteBudgetUsd"]!;

  it("declares the same [0, 100] range the parser enforces", () => {
    expect(spec.min).toBe(0);
    expect(spec.max).toBe(100);
  });

  it("rejects in the editor exactly what the parser would silently drop", () => {
    for (const raw of ["500", "-1"]) {
      expect(parseSettingValue(spec, raw).ok, `editor must reject ${raw}`).toBe(false);
      // …and the parser would have fallen back to the default rather than clamp.
      expect(parseCacheTtlSettings({ adaptiveWriteBudgetUsd: Number(raw) }).adaptiveWriteBudgetUsd).toBe(
        DEFAULT_SETTINGS.cacheTtl.adaptiveWriteBudgetUsd,
      );
    }
  });

  it("accepts a fractional budget without flooring it to the 0 = gate-off sentinel", () => {
    const parsed = parseSettingValue(spec, "0.5");
    expect(parsed.ok).toBe(true);
    expect(parseCacheTtlSettings({ adaptiveWriteBudgetUsd: 0.5 }).adaptiveWriteBudgetUsd).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// child-ka-core (docs/dev/child-context-switch/plan.md §2.4/§4): the five new
// persisted keys the child keepalive core reads through (P1 doesn't wire them
// up itself — that's P3's `src/cache-ttl/child.ts` — but the settings surface
// must exist, parse tolerantly, and clamp per §4's table).
// ---------------------------------------------------------------------------

describe("cache-ttl child keepalive settings (child-ka-core plan.md §4)", () => {
  it("defaults: childKeepalive on, 24/run, concurrency 4, $1.5/run, $10/24h process", () => {
    expect(DEFAULT_SETTINGS.cacheTtl.childKeepalive).toBe(true);
    expect(DEFAULT_SETTINGS.cacheTtl.childKeepaliveMaxPingsPerRun).toBe(24);
    expect(DEFAULT_SETTINGS.cacheTtl.childKeepaliveMaxConcurrent).toBe(4);
    expect(DEFAULT_SETTINGS.cacheTtl.childKeepaliveRunBudgetUsd).toBe(1.5);
    expect(DEFAULT_SETTINGS.cacheTtl.childKeepaliveProcessBudgetUsd).toBe(10);
  });

  it("falls back field-by-field on malformed child keys, never throws", () => {
    const parsed = parseCacheTtlSettings({
      childKeepalive: "nope",
      childKeepaliveMaxPingsPerRun: -1,
      childKeepaliveMaxConcurrent: 0,
      childKeepaliveRunBudgetUsd: -1,
      childKeepaliveProcessBudgetUsd: -1,
    });
    expect(parsed.childKeepalive).toBe(true);
    expect(parsed.childKeepaliveMaxPingsPerRun).toBe(24);
    expect(parsed.childKeepaliveMaxConcurrent).toBe(4);
    expect(parsed.childKeepaliveRunBudgetUsd).toBe(1.5);
    expect(parsed.childKeepaliveProcessBudgetUsd).toBe(10);
  });

  it("accepts valid overrides, including 0 = never ping", () => {
    const parsed = parseCacheTtlSettings({
      childKeepalive: false,
      childKeepaliveMaxPingsPerRun: 0,
      childKeepaliveMaxConcurrent: 8,
      childKeepaliveRunBudgetUsd: 0,
      childKeepaliveProcessBudgetUsd: 0,
    });
    expect(parsed.childKeepalive).toBe(false);
    expect(parsed.childKeepaliveMaxPingsPerRun).toBe(0);
    expect(parsed.childKeepaliveMaxConcurrent).toBe(8);
    expect(parsed.childKeepaliveRunBudgetUsd).toBe(0);
    expect(parsed.childKeepaliveProcessBudgetUsd).toBe(0);
  });

  it("clamps childKeepaliveMaxConcurrent into [1, 32]", () => {
    expect(parseCacheTtlSettings({ childKeepaliveMaxConcurrent: 0 }).childKeepaliveMaxConcurrent).toBe(4);
    expect(parseCacheTtlSettings({ childKeepaliveMaxConcurrent: 33 }).childKeepaliveMaxConcurrent).toBe(4);
    expect(parseCacheTtlSettings({ childKeepaliveMaxConcurrent: 1 }).childKeepaliveMaxConcurrent).toBe(1);
    expect(parseCacheTtlSettings({ childKeepaliveMaxConcurrent: 32 }).childKeepaliveMaxConcurrent).toBe(32);
  });

  it("clamps the two USD budgets into their documented ranges and never floors a fractional value", () => {
    expect(parseCacheTtlSettings({ childKeepaliveRunBudgetUsd: 1001 }).childKeepaliveRunBudgetUsd).toBe(1.5);
    expect(parseCacheTtlSettings({ childKeepaliveRunBudgetUsd: -1 }).childKeepaliveRunBudgetUsd).toBe(1.5);
    expect(parseCacheTtlSettings({ childKeepaliveRunBudgetUsd: 0.25 }).childKeepaliveRunBudgetUsd).toBe(0.25);
    expect(parseCacheTtlSettings({ childKeepaliveProcessBudgetUsd: 10_001 }).childKeepaliveProcessBudgetUsd).toBe(10);
    expect(parseCacheTtlSettings({ childKeepaliveProcessBudgetUsd: -1 }).childKeepaliveProcessBudgetUsd).toBe(10);
    expect(parseCacheTtlSettings({ childKeepaliveProcessBudgetUsd: 0.5 }).childKeepaliveProcessBudgetUsd).toBe(0.5);
  });
});
