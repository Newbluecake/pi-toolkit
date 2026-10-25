/**
 * scheduled-reports plan r3 §10.3 (S0): the `schedule.*` settings group — defaults (enabled=false
 * ⇒ zero surface), field-by-field tolerant parsing, the `*S ⇄ *Ms` storage boundary, the spec-table
 * entries, and literal-mirror parity with src/schedule/core/spec.ts (settings.ts may not
 * value-import it — tests/web-hub/boundary.test.ts freezes its import closure).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULE_SETTINGS,
  DEFAULT_SETTINGS,
  isTimeSettingKey,
  loadSettings,
  parseScheduleSettings,
  SCHEDULE_TIMEOUT_MAX_MS,
  SCHEDULE_TIMEOUT_MIN_MS,
  TIME_SETTING_MS_PATHS,
} from "../../src/config/settings.js";
import {
  currentOf,
  defaultOf,
  isKnownSettingKey,
  parseSettingValue,
  SETTING_SPECS,
} from "../../src/config/setting-specs.js";
import {
  SCHED_BG_TIMEOUT_DEFAULT_S,
  SCHED_BG_TIMEOUT_MAX_S,
  SCHED_BG_TIMEOUT_MIN_S,
} from "../../src/schedule/core/spec.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
import { freezeDomain, makeFakeVault, type FakeVault } from "../secure/helpers.js";

let v: FakeVault | undefined;
afterEach(() => {
  resetSecureDomainForTests();
  v?.cleanup();
  v = undefined;
});

describe("schedule settings: defaults (§10.3)", () => {
  it("pins enabled=false (zero surface), 1800s default / 14400s max, no dir key", () => {
    expect(DEFAULT_SCHEDULE_SETTINGS).toEqual({
      enabled: false,
      defaultTimeoutMs: 1_800_000,
      maxTimeoutMs: 14_400_000,
    });
    expect(DEFAULT_SETTINGS.schedule).toEqual(DEFAULT_SCHEDULE_SETTINGS);
    expect("dir" in DEFAULT_SETTINGS.schedule).toBe(false);
    expect(loadSettings({}).schedule).toEqual(DEFAULT_SCHEDULE_SETTINGS);
    expect(loadSettings(null).schedule).toEqual(DEFAULT_SCHEDULE_SETTINGS);
  });

  it("literal mirrors equal spec.ts's constants", () => {
    expect(SCHEDULE_TIMEOUT_MIN_MS).toBe(SCHED_BG_TIMEOUT_MIN_S * 1000);
    expect(SCHEDULE_TIMEOUT_MAX_MS).toBe(SCHED_BG_TIMEOUT_MAX_S * 1000);
    expect(DEFAULT_SCHEDULE_SETTINGS.defaultTimeoutMs).toBe(SCHED_BG_TIMEOUT_DEFAULT_S * 1000);
  });

  it("absent / malformed block ⇒ defaults (fresh copy), never throws", () => {
    for (const input of [undefined, null, 42, "x", [], {}]) {
      const out = parseScheduleSettings(input);
      expect(out).toEqual(DEFAULT_SCHEDULE_SETTINGS);
      expect(out).not.toBe(DEFAULT_SCHEDULE_SETTINGS);
    }
    expect(loadSettings({ schedule: "bogus" }).schedule).toEqual(DEFAULT_SCHEDULE_SETTINGS);
  });
});

describe("schedule settings: parsing", () => {
  it("file keys are integer seconds (*S) converted to ms", () => {
    const s = loadSettings({
      schedule: { enabled: true, dir: "/srv/sched", defaultTimeoutS: 600, maxTimeoutS: 7200 },
    }).schedule;
    expect(s).toEqual({ enabled: true, dir: "/srv/sched", defaultTimeoutMs: 600_000, maxTimeoutMs: 7_200_000 });
  });

  it("each field falls back independently", () => {
    expect(loadSettings({ schedule: { enabled: "yes", defaultTimeoutS: 30, maxTimeoutS: 99_999 } }).schedule).toEqual(
      DEFAULT_SCHEDULE_SETTINGS,
    );
    expect(loadSettings({ schedule: { defaultTimeoutS: 90.5 } }).schedule.defaultTimeoutMs).toBe(1_800_000);
    expect(loadSettings({ schedule: { defaultTimeoutS: 60 } }).schedule.defaultTimeoutMs).toBe(60_000);
    expect(loadSettings({ schedule: { maxTimeoutS: 14_400 } }).schedule.maxTimeoutMs).toBe(14_400_000);
    expect(loadSettings({ schedule: { maxTimeoutS: 14_401 } }).schedule.maxTimeoutMs).toBe(14_400_000);
  });

  it("defaultTimeout is clamped to ≤ maxTimeout", () => {
    const s = loadSettings({ schedule: { maxTimeoutS: 600 } }).schedule;
    expect(s).toMatchObject({ defaultTimeoutMs: 600_000, maxTimeoutMs: 600_000 });
    const t = loadSettings({ schedule: { defaultTimeoutS: 3600, maxTimeoutS: 1200 } }).schedule;
    expect(t).toMatchObject({ defaultTimeoutMs: 1_200_000, maxTimeoutMs: 1_200_000 });
  });

  it("dir accepts only an absolute NUL-free path; anything else leaves the key absent", () => {
    for (const dir of ["", "relative/dir", "~/x", 42, "/a\0b", `/${"a".repeat(4096)}`]) {
      const s = parseScheduleSettings({ dir });
      expect("dir" in s).toBe(false);
    }
    expect(parseScheduleSettings({ dir: "/abs" }).dir).toBe("/abs");
  });

  it("is registered on the *S ⇄ *Ms boundary", () => {
    expect(TIME_SETTING_MS_PATHS).toContain("schedule.defaultTimeoutMs");
    expect(TIME_SETTING_MS_PATHS).toContain("schedule.maxTimeoutMs");
    expect(isTimeSettingKey("schedule.defaultTimeoutS")).toBe(true);
    expect(isTimeSettingKey("schedule.maxTimeoutS")).toBe(true);
  });

  it("is NOT force-disabled by the secure domain in S0 (the agent refuses with E_SECURE, §3.3)", () => {
    v = makeFakeVault();
    freezeDomain(v);
    expect(loadSettings({ schedule: { enabled: true } }).schedule.enabled).toBe(true);
  });
});

describe("schedule setting specs", () => {
  it("exposes exactly enabled / defaultTimeoutS / maxTimeoutS (dir is JSON-only)", () => {
    const keys = Object.keys(SETTING_SPECS).filter((k) => k.startsWith("schedule."));
    expect(keys).toEqual(["schedule.enabled", "schedule.defaultTimeoutS", "schedule.maxTimeoutS"]);
    expect(isKnownSettingKey("schedule.dir")).toBe(false);
    for (const k of keys) expect(SETTING_SPECS[k]!.live).toBeUndefined(); // non-live (§10.3)
  });

  it("defaults render in the stored (seconds) domain", () => {
    expect(defaultOf(SETTING_SPECS["schedule.enabled"]!)).toBe(false);
    expect(defaultOf(SETTING_SPECS["schedule.defaultTimeoutS"]!)).toBe(1800);
    expect(defaultOf(SETTING_SPECS["schedule.maxTimeoutS"]!)).toBe(14_400);
    expect(currentOf(DEFAULT_SETTINGS, SETTING_SPECS["schedule.maxTimeoutS"]!)).toBe(14_400);
  });

  it("validates input in seconds within 60..14400", () => {
    const spec = SETTING_SPECS["schedule.defaultTimeoutS"]!;
    expect(parseSettingValue(spec, "600")).toEqual({ ok: true, stored: 600, live: 600_000 });
    expect(parseSettingValue(spec, "59").ok).toBe(false);
    expect(parseSettingValue(spec, "14401").ok).toBe(false);
    expect(parseSettingValue(spec, "1.5").ok).toBe(false);
    expect(parseSettingValue(SETTING_SPECS["schedule.enabled"]!, "on")).toEqual({ ok: true, stored: true, live: true });
  });
});
