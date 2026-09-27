// memory-plan §7.10 + todo #22 optimize-plan §9 (P0-b): memory.* settings
// block — parser tolerance + spec surface. P5 defaults are tiered/v2;
// explicit legacy remains the byte-compatible opt-out.

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, parseMemorySettings } from "../../src/config/settings.js";
import { currentOf, defaultOf, isKnownSettingKey, SETTING_SPECS } from "../../src/config/setting-specs.js";

const defaults = DEFAULT_SETTINGS.memory;

describe("memory settings", () => {
  it("pins the P5 defaults (tiered injection + v2 tool surface)", () => {
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
      layout: "tiered",
      toolSurface: "v2",
      childProfile: "core",
      coreBytes: 1600,
      blockBytes: 2400,
      topicWarnBytes: 8192,
      topicMaxBytes: 16384,
      doctor: { notifyOnStart: true, staleDays: 60 },
      tidy: {
        agentType: "Plan",
        model: "",
        timeoutMs: 180_000,
        maxInputBytes: 49_152,
        maxOutputBytes: 65_536,
        maxCostUsd: 2.0,
        maxTurns: 4,
      },
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
        layout: "bogus",
        toolSurface: 42,
        childProfile: "everything",
        coreBytes: "nope",
        blockBytes: null,
        topicWarnBytes: [],
        topicMaxBytes: {},
        doctor: "nope",
        tidy: 42,
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
      ...defaults,
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

  it("exposes the pre-#22 nine memory.* keys in SETTING_SPECS, all non-live", () => {
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

  // ─────────────────────── todo #22 optimize-plan §9 (P0-b) ───────────────────────

  it("layout / toolSurface / childProfile are enum knobs, falling back on garbage", () => {
    expect(parseMemorySettings({ layout: "tiered" }).layout).toBe("tiered");
    expect(parseMemorySettings({ layout: "legacy" }).layout).toBe("legacy");
    expect(parseMemorySettings({ layout: "bogus" }).layout).toBe("tiered");
    expect(parseMemorySettings({ toolSurface: "v2" }).toolSurface).toBe("v2");
    expect(parseMemorySettings({ toolSurface: "bogus" }).toolSurface).toBe("v2");
    expect(parseMemorySettings({ childProfile: "full" }).childProfile).toBe("full");
    expect(parseMemorySettings({ childProfile: "none" }).childProfile).toBe("none");
    expect(parseMemorySettings({ childProfile: "bogus" }).childProfile).toBe("core");
  });

  it("coreBytes clamps to ≤ blockBytes - 600", () => {
    expect(parseMemorySettings({ blockBytes: 1000, coreBytes: 900 }).coreBytes).toBe(400);
    expect(parseMemorySettings({ blockBytes: 4000, coreBytes: 2000 }).coreBytes).toBe(2000);
  });

  it("topicMaxBytes is clamped to ≥ topicWarnBytes", () => {
    expect(parseMemorySettings({ topicWarnBytes: 20_000, topicMaxBytes: 16_384 }).topicMaxBytes).toBe(20_000);
    expect(parseMemorySettings({ topicWarnBytes: 4096, topicMaxBytes: 8192 }).topicMaxBytes).toBe(8192);
  });

  it("blockBytes / coreBytes / topicWarnBytes / topicMaxBytes enforce their documented ranges", () => {
    expect(parseMemorySettings({ blockBytes: 799 }).blockBytes).toBe(defaults.blockBytes);
    expect(parseMemorySettings({ blockBytes: 16_385 }).blockBytes).toBe(defaults.blockBytes);
    expect(parseMemorySettings({ blockBytes: 800 }).blockBytes).toBe(800);
    expect(parseMemorySettings({ coreBytes: 255 }).coreBytes).toBe(defaults.coreBytes);
    expect(parseMemorySettings({ topicWarnBytes: 1023 }).topicWarnBytes).toBe(defaults.topicWarnBytes);
  });

  it("doctor block: field-by-field fallback, never throws on garbage", () => {
    expect(parseMemorySettings({ doctor: { notifyOnStart: false, staleDays: 90 } }).doctor).toEqual({
      notifyOnStart: false,
      staleDays: 90,
    });
    expect(parseMemorySettings({ doctor: { staleDays: 6 } }).doctor.staleDays).toBe(defaults.doctor.staleDays);
    expect(parseMemorySettings({ doctor: { staleDays: 3651 } }).doctor.staleDays).toBe(defaults.doctor.staleDays);
    expect(parseMemorySettings({ doctor: "nope" }).doctor).toEqual(defaults.doctor);
    expect(parseMemorySettings({ doctor: null }).doctor).toEqual(defaults.doctor);
  });

  it("tidy block: field-by-field fallback; model/agentType accept any non-empty string (validated only at dispatch time, §7.1)", () => {
    const parsed = parseMemorySettings({
      tidy: {
        agentType: "verifier",
        model: "cr-anthropic/claude-opus-5-5",
        timeoutMs: 60_000,
        maxInputBytes: 20_000,
        maxOutputBytes: 10_000,
        maxCostUsd: 1.5,
        maxTurns: 2,
      },
    });
    expect(parsed.tidy).toEqual({
      agentType: "verifier",
      model: "cr-anthropic/claude-opus-5-5",
      timeoutMs: 60_000,
      maxInputBytes: 20_000,
      maxOutputBytes: 10_000,
      maxCostUsd: 1.5,
      maxTurns: 2,
    });
    // model accepts a free-form (non-strict-provider/id) value too — §7.1
    // resolves/WARNs about that at DISPATCH time (P4), not at settings-parse time.
    expect(parseMemorySettings({ tidy: { model: "not a strict ref" } }).tidy.model).toBe("not a strict ref");
    expect(parseMemorySettings({ tidy: { model: "" } }).tidy.model).toBe("");
    // an empty agentType string falls back (never registers a blank agent type name)
    expect(parseMemorySettings({ tidy: { agentType: "" } }).tidy.agentType).toBe(defaults.tidy.agentType);
    // maxCostUsd never 0; garbage falls back
    expect(parseMemorySettings({ tidy: { maxCostUsd: 0 } }).tidy.maxCostUsd).toBe(defaults.tidy.maxCostUsd);
    expect(parseMemorySettings({ tidy: { maxCostUsd: -1 } }).tidy.maxCostUsd).toBe(defaults.tidy.maxCostUsd);
    expect(parseMemorySettings({ tidy: { maxCostUsd: 51 } }).tidy.maxCostUsd).toBe(defaults.tidy.maxCostUsd);
    // a fractional cost cap is preserved (float, not floored like the byte/turn fields)
    expect(parseMemorySettings({ tidy: { maxCostUsd: 3.25 } }).tidy.maxCostUsd).toBe(3.25);
    expect(parseMemorySettings({ tidy: "nope" }).tidy).toEqual(defaults.tidy);
    expect(parseMemorySettings({ tidy: { maxTurns: 0 } }).tidy.maxTurns).toBe(defaults.tidy.maxTurns);
    expect(parseMemorySettings({ tidy: { maxTurns: 21 } }).tidy.maxTurns).toBe(defaults.tidy.maxTurns);
  });

  it("timeoutMs round-trips through the file's timeoutS seconds key (TIME_SETTING_MS_PATHS)", () => {
    expect(loadSettings({ memory: { tidy: { timeoutS: 60 } } }).memory.tidy.timeoutMs).toBe(60_000);
  });

  it("exposes the new §9 knobs in SETTING_SPECS, all non-live", () => {
    const keys = [
      "memory.layout",
      "memory.toolSurface",
      "memory.childProfile",
      "memory.coreBytes",
      "memory.blockBytes",
      "memory.topicWarnBytes",
      "memory.topicMaxBytes",
      "memory.doctor.notifyOnStart",
      "memory.doctor.staleDays",
      "memory.tidy.agentType",
      "memory.tidy.model",
      "memory.tidy.timeoutS",
      "memory.tidy.maxInputBytes",
      "memory.tidy.maxOutputBytes",
      "memory.tidy.maxCostUsd",
      "memory.tidy.maxTurns",
    ];
    for (const key of keys) {
      expect(isKnownSettingKey(key), key).toBe(true);
      const spec = SETTING_SPECS[key]!;
      expect(spec.live, key).toBeUndefined();
    }
    expect(SETTING_SPECS["memory.layout"]).toMatchObject({ kind: "enum", values: ["tiered", "legacy"] });
    expect(SETTING_SPECS["memory.toolSurface"]).toMatchObject({ kind: "enum", values: ["v2", "legacy"] });
    expect(SETTING_SPECS["memory.childProfile"]).toMatchObject({ kind: "enum", values: ["core", "full", "none"] });
    expect(SETTING_SPECS["memory.tidy.timeoutS"]).toMatchObject({ path: "memory.tidy.timeoutMs", time: true });
    expect(SETTING_SPECS["memory.tidy.maxCostUsd"]).toMatchObject({ kind: "number", min: 0.05, max: 50 });
    expect(defaultOf(SETTING_SPECS["memory.layout"]!)).toBe("tiered");
    expect(defaultOf(SETTING_SPECS["memory.toolSurface"]!)).toBe("v2");
  });
});
