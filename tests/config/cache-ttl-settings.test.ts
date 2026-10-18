import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, isTimeSettingKey, loadSettings, parseCacheTtlSettings } from "../../src/config/settings.js";
import { SETTING_SPECS } from "../../src/config/setting-specs.js";

describe("cache-ttl keepalive settings", () => {
  it("defaults match the keepalive settings", () => {
    expect(DEFAULT_SETTINGS.cacheTtl).toEqual({
      mode: "auto",
      keepalive: true,
      keepaliveIntervalMs: 240_000,
      keepaliveMinPrefixTokens: 20_000,
      childKeepalive: true,
      childKeepaliveMaxPingsPerRun: 24,
      childKeepaliveMaxConcurrent: 4,
      childKeepaliveRunBudgetUsd: 1.5,
      childKeepaliveProcessBudgetUsd: 10,
    });
  });

  it("falls back field-by-field on malformed input, never throws", () => {
    for (const input of [undefined, null, [], "x", 42]) {
      expect(parseCacheTtlSettings(input)).toEqual(DEFAULT_SETTINGS.cacheTtl);
    }
    expect(
      parseCacheTtlSettings({
        keepalive: "nope",
        keepaliveIntervalMs: "nope",
        keepaliveMinPrefixTokens: NaN,
      }),
    ).toEqual(DEFAULT_SETTINGS.cacheTtl);
  });

  it("accepts valid overrides", () => {
    expect(
      parseCacheTtlSettings({
        keepalive: false,
        keepaliveIntervalMs: 120_000,
        keepaliveMinPrefixTokens: 5_000,
      }),
    ).toEqual({
      mode: "auto",
      keepalive: false,
      keepaliveIntervalMs: 120_000,
      keepaliveMinPrefixTokens: 5_000,
      childKeepalive: true,
      childKeepaliveMaxPingsPerRun: 24,
      childKeepaliveMaxConcurrent: 4,
      childKeepaliveRunBudgetUsd: 1.5,
      childKeepaliveProcessBudgetUsd: 10,
    });
  });

  it('clamps keepaliveIntervalMs into [60s, 240s] (todo #15 real-machine finding: values above 240s leave zero margin between `nextPingAt` and the `cache-expired` cutoff, so a window can NEVER reach a "ping" decision — see MAX_SAFE_KEEPALIVE_INTERVAL_MS\'s doc comment)', () => {
    expect(parseCacheTtlSettings({ keepaliveIntervalMs: 1_000 }).keepaliveIntervalMs).toBe(
      DEFAULT_SETTINGS.cacheTtl.keepaliveIntervalMs,
    );
    expect(parseCacheTtlSettings({ keepaliveIntervalMs: 300_000 }).keepaliveIntervalMs).toBe(
      DEFAULT_SETTINGS.cacheTtl.keepaliveIntervalMs,
    );
    expect(parseCacheTtlSettings({ keepaliveIntervalMs: 60_000 }).keepaliveIntervalMs).toBe(60_000);
    // 240_000 (the default, and MAX_SAFE_KEEPALIVE_INTERVAL_MS) is the largest value that still
    // leaves TICK_INTERVAL_MS of ping-eligible margin — accepted as-is.
    expect(parseCacheTtlSettings({ keepaliveIntervalMs: 240_000 }).keepaliveIntervalMs).toBe(240_000);
    // Anything above that (this used to accept up to 280_000, a value that can never actually
    // ping — regression pinned here) falls back to the safe default instead of being honored.
    expect(parseCacheTtlSettings({ keepaliveIntervalMs: 250_000 }).keepaliveIntervalMs).toBe(
      DEFAULT_SETTINGS.cacheTtl.keepaliveIntervalMs,
    );
    expect(parseCacheTtlSettings({ keepaliveIntervalMs: 280_000 }).keepaliveIntervalMs).toBe(
      DEFAULT_SETTINGS.cacheTtl.keepaliveIntervalMs,
    );
  });

  it("keepaliveIntervalMs is registered as a duration field (seconds on disk)", () => {
    expect(isTimeSettingKey("cacheTtl.keepaliveIntervalS")).toBe(true);
  });

  it("round-trips through loadSettings with seconds-on-disk storage", () => {
    const loaded = loadSettings({ cacheTtl: { keepaliveIntervalS: 90 } });
    expect(loaded.cacheTtl.keepaliveIntervalMs).toBe(90_000);
  });

  it("registers only the 3 surviving keepalive SETTING_SPECS entries", () => {
    expect(SETTING_SPECS["cacheTtl.keepalive"]).toMatchObject({ kind: "boolean", path: "cacheTtl.keepalive" });
    expect(SETTING_SPECS["cacheTtl.keepaliveIntervalS"]).toMatchObject({
      kind: "number",
      path: "cacheTtl.keepaliveIntervalMs",
      time: true,
      min: 60,
      max: 240,
    });
    expect(SETTING_SPECS["cacheTtl.keepaliveMaxPings"]).toBeUndefined();
    expect(Object.values(SETTING_SPECS).some((s) => s.path === "cacheTtl.keepaliveMaxPings")).toBe(false);
    expect(SETTING_SPECS["cacheTtl.keepaliveMinPrefixTokens"]).toMatchObject({
      kind: "number",
      path: "cacheTtl.keepaliveMinPrefixTokens",
    });
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

describe("cache-ttl removed settings migration", () => {
  it("ignores removed leaves and warns once when persisted adaptive mode is encountered", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const parsed = parseCacheTtlSettings({
      mode: "adaptive",
      adaptiveWriteBudgetTokens: 200_000,
      keepaliveUpgradeAfterBudget: true,
    });
    expect(parsed.mode).toBe("auto");
    expect(Object.keys(parsed).some((key) => key.includes("adaptive") || key === "keepaliveUpgradeAfterBudget")).toBe(
      false,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("falls back invalid modes and accepts only auto/on/off", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const mode of ["bogus", 1, null]) expect(parseCacheTtlSettings({ mode }).mode).toBe("auto");
    expect(parseCacheTtlSettings({ mode: "on" }).mode).toBe("on");
    expect(parseCacheTtlSettings({ mode: "off" }).mode).toBe("off");
    expect(parseCacheTtlSettings({ mode: "auto" }).mode).toBe("auto");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("parses keepalive duration and ignores removed duration paths", () => {
    expect(isTimeSettingKey("cacheTtl.keepaliveIntervalS")).toBe(true);
    expect(isTimeSettingKey("cacheTtl.adaptiveColdCooldownS")).toBe(false);
    expect(isTimeSettingKey("cacheTtl.adaptiveColdMinHorizonS")).toBe(false);
    expect(
      loadSettings({ cacheTtl: { keepaliveIntervalS: 90, adaptiveColdCooldownS: 300 } }).cacheTtl.keepaliveIntervalMs,
    ).toBe(90_000);
    expect(SETTING_SPECS["cacheTtl.mode"]).toMatchObject({ kind: "enum", values: ["auto", "on", "off"] });
    expect(SETTING_SPECS["cacheTtl.keepaliveUpgradeAfterBudget"]).toBeUndefined();
  });
});

describe("removed keepaliveMaxPings — status-only four-state migration", () => {
  it.each([5, 0, -1, "x", NaN, Infinity, null, undefined])(
    "ignores present legacy value %s without warning",
    (value) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const raw = { keepalive: true, keepaliveMaxPings: value };
        const expected = {
          ...DEFAULT_SETTINGS.cacheTtl,
          legacyKeepaliveMaxPings: typeof value === "number" && Number.isFinite(value) ? value : "invalid",
        };
        for (let i = 0; i < 3; i++) {
          expect(parseCacheTtlSettings(raw)).toEqual(expected);
          expect(loadSettings({ cacheTtl: raw }).cacheTtl).toEqual(expected);
        }
        expect(parseCacheTtlSettings({ ...raw, keepalive: false }).keepalive).toBe(false);
        expect(expected).not.toHaveProperty("keepaliveMaxPings");
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );
  it("absent legacy key stays absent", () => {
    expect(parseCacheTtlSettings({})).toEqual(DEFAULT_SETTINGS.cacheTtl);
    expect(parseCacheTtlSettings({})).not.toHaveProperty("legacyKeepaliveMaxPings");
  });
});
