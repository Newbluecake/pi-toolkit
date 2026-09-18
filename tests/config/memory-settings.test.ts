// memory-plan §7.10: memory.* settings block — parser tolerance + spec surface.
// Style follows goal-settings.test.ts (per-block settings test file).

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, parseMemorySettings } from "../../src/config/settings.js";
import { currentOf, defaultOf, isKnownSettingKey, SETTING_SPECS } from "../../src/config/setting-specs.js";

const defaults = DEFAULT_SETTINGS.memory;

describe("memory settings", () => {
  it("pins the defaults (memory-plan §3.1, 9 keys)", () => {
    expect(defaults).toEqual({
      enabled: true,
      injectInChildSessions: true,
      allowWriteInChildSessions: false,
      freezeInjectionAfterWrite: false,
      inlineMax: 3,
      byteCap: 4000,
      indexMax: 15,
      maxFileBytes: 262_144,
      maxWriteBytes: 65_536,
    });
  });

  it("falls back for missing and non-object blocks", () => {
    for (const input of [undefined, null, 0, "nope", true, [], [1, 2]]) {
      expect(parseMemorySettings(input)).toEqual(defaults);
    }
    expect(parseMemorySettings({})).toEqual(defaults);
  });

  it("tolerates garbage field-by-field and never throws", () => {
    expect(
      parseMemorySettings({
        enabled: "yes",
        injectInChildSessions: 1,
        allowWriteInChildSessions: "true",
        freezeInjectionAfterWrite: null,
        inlineMax: -1,
        byteCap: Number.NaN,
        indexMax: 0,
        maxFileBytes: 100,
        maxWriteBytes: "a lot",
      }),
    ).toEqual(defaults);
  });

  it("accepts in-range values (byteCap=0 / inlineMax=0 are legal)", () => {
    const parsed = parseMemorySettings({
      enabled: false,
      injectInChildSessions: false,
      allowWriteInChildSessions: true,
      freezeInjectionAfterWrite: true,
      inlineMax: 0,
      byteCap: 0,
      indexMax: 1,
      maxFileBytes: 1024,
      maxWriteBytes: 256,
    });
    expect(parsed).toEqual({
      enabled: false,
      injectInChildSessions: false,
      allowWriteInChildSessions: true,
      freezeInjectionAfterWrite: true,
      inlineMax: 0,
      byteCap: 0,
      indexMax: 1,
      maxFileBytes: 1024,
      maxWriteBytes: 256,
    });
  });

  it("clamps maxWriteBytes to ≤ maxFileBytes (misconfig elimination)", () => {
    // maxWriteBytes 65_536 out of range for maxFileBytes 2048 ⇒ falls back to
    // the default, then clamps to the file cap.
    expect(parseMemorySettings({ maxFileBytes: 2048, maxWriteBytes: 65_536 }).maxWriteBytes).toBe(2048);
    // Default maxWriteBytes (64KiB) also clamps when the file cap is lowered.
    expect(parseMemorySettings({ maxFileBytes: 4096 }).maxWriteBytes).toBe(4096);
    // In-range value survives untouched.
    expect(parseMemorySettings({ maxFileBytes: 4096, maxWriteBytes: 1024 }).maxWriteBytes).toBe(1024);
  });

  it("enforces documented ranges", () => {
    expect(parseMemorySettings({ inlineMax: 51 }).inlineMax).toBe(defaults.inlineMax);
    expect(parseMemorySettings({ byteCap: 65_537 }).byteCap).toBe(defaults.byteCap);
    expect(parseMemorySettings({ indexMax: 101 }).indexMax).toBe(defaults.indexMax);
    expect(parseMemorySettings({ maxFileBytes: 4 * 1024 * 1024 + 1 }).maxFileBytes).toBe(defaults.maxFileBytes);
    expect(parseMemorySettings({ maxWriteBytes: 255 }).maxWriteBytes).toBe(defaults.maxWriteBytes);
    // boundary values are accepted
    expect(parseMemorySettings({ inlineMax: 50 }).inlineMax).toBe(50);
    expect(parseMemorySettings({ byteCap: 65_536 }).byteCap).toBe(65_536);
    expect(parseMemorySettings({ indexMax: 100 }).indexMax).toBe(100);
  });

  it("floors in-range floats (truncation semantics locked, verifier nit)", () => {
    expect(parseMemorySettings({ inlineMax: 2.9 }).inlineMax).toBe(2);
    expect(parseMemorySettings({ byteCap: 4000.7 }).byteCap).toBe(4000);
  });

  it("is wired into loadSettings", () => {
    expect(loadSettings({ memory: "invalid" }).memory).toEqual(defaults);
    expect(loadSettings({ memory: { enabled: false, byteCap: 123 } }).memory).toEqual({
      ...defaults,
      enabled: false,
      byteCap: 123,
    });
  });

  it("exposes the nine memory.* keys in SETTING_SPECS, all non-live", () => {
    const keys = [
      "memory.enabled",
      "memory.injectInChildSessions",
      "memory.allowWriteInChildSessions",
      "memory.freezeInjectionAfterWrite",
      "memory.inlineMax",
      "memory.byteCap",
      "memory.indexMax",
      "memory.maxFileBytes",
      "memory.maxWriteBytes",
    ];
    for (const key of keys) {
      expect(isKnownSettingKey(key), key).toBe(true);
      const spec = SETTING_SPECS[key]!;
      expect(spec.live, key).toBeUndefined();
      expect(spec.time, key).toBeUndefined();
      expect(defaultOf(spec), key).not.toBeUndefined();
      expect(currentOf(DEFAULT_SETTINGS, spec), key).not.toBe("(unset)");
    }
    expect(SETTING_SPECS["memory.enabled"]).toMatchObject({ kind: "boolean", path: "memory.enabled" });
    // Nit 1: byteCap needs a max that count() cannot express.
    expect(SETTING_SPECS["memory.byteCap"]).toMatchObject({
      kind: "number",
      path: "memory.byteCap",
      min: 0,
      max: 65_536,
      integer: true,
    });
    expect(SETTING_SPECS["memory.indexMax"]).toMatchObject({ min: 1 });
    expect(SETTING_SPECS["memory.maxFileBytes"]).toMatchObject({ min: 1024 });
    expect(SETTING_SPECS["memory.maxWriteBytes"]).toMatchObject({ min: 256 });
  });
});
