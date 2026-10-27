import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, loadSettingsFromFile, TIME_SETTING_MS_PATHS } from "../../src/config/settings.js";
import { DEFAULT_EXTERNAL_AGENTS_SETTINGS, parseExternalAgentsSettings } from "../../src/external-agent/settings.js";
import { secondsKeyOf } from "../../src/config/time-units.js";

/**
 * external-agent plan §2.8 (P1): settings shape, defaults, per-field tolerant
 * parsing, time-unit boundary (*S file ⇄ *Ms internal), pricing validation,
 * and the 关闭态字节一致 requirement — a settings file without
 * `externalAgents` must never gain a single new key from a load/migrate pass.
 */
describe("externalAgents.droid settings (plan §2.8)", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });
  const warnings = (): string[] => warn.mock.calls.map((c) => String(c[0]));

  it("defaults are frozen (enabled false ⇒ closed-state byte identity)", () => {
    expect(DEFAULT_EXTERNAL_AGENTS_SETTINGS).toEqual({
      droid: {
        enabled: false,
        binary: "droid",
        protocolCheck: "strict",
        models: [],
        advertiseMax: 12,
        injectMemory: true,
        pricing: {},
        catalogTtlMs: 86_400_000,
        requestTimeoutMs: 15_000,
        initTimeoutMs: 20_000,
        killGraceMs: 2_000,
      },
    });
  });

  it("missing / malformed input falls back to defaults, never throws", () => {
    for (const input of [undefined, null, 42, "x", [], {}, { droid: null }, { droid: "x" }, { droid: [] }]) {
      expect(parseExternalAgentsSettings(input)).toEqual(DEFAULT_EXTERNAL_AGENTS_SETTINGS);
      expect(warnings()).toEqual([]);
    }
  });

  it("unknown keys are ignored; per-field illegal values fall back", () => {
    const out = parseExternalAgentsSettings({
      droid: {
        nonsense: true,
        enabled: "yes",
        binary: "",
        protocolCheck: "loud",
        models: "all",
        advertiseMax: 12.5,
        injectMemory: 0,
        catalogTtlMs: Number.NaN,
        requestTimeoutMs: -1,
        initTimeoutMs: Number.POSITIVE_INFINITY,
        killGraceMs: "2",
      },
    }).droid;
    expect(out).toEqual({
      enabled: false,
      binary: "droid",
      protocolCheck: "strict",
      models: [],
      advertiseMax: 12,
      injectMemory: true,
      pricing: {},
      catalogTtlMs: 86_400_000,
      requestTimeoutMs: 15_000,
      initTimeoutMs: 20_000,
      killGraceMs: 2_000,
    });
    expect(warnings()).toEqual([]);
  });

  it("accepts legal values verbatim", () => {
    const out = parseExternalAgentsSettings({
      droid: {
        enabled: true,
        binary: "/usr/local/bin/droid",
        protocolCheck: "warn",
        models: ["gpt-6-luna", "claude-sonnet-5"],
        advertiseMax: 50,
        injectMemory: false,
      },
    }).droid;
    expect(out.enabled).toBe(true);
    expect(out.binary).toBe("/usr/local/bin/droid");
    expect(out.protocolCheck).toBe("warn");
    expect(out.models).toEqual(["gpt-6-luna", "claude-sonnet-5"]);
    expect(out.advertiseMax).toBe(50);
    expect(out.injectMemory).toBe(false);
  });

  it("binary rejects empty strings and NUL, falls back to default", () => {
    expect(parseExternalAgentsSettings({ droid: { binary: "" } }).droid.binary).toBe("droid");
    expect(parseExternalAgentsSettings({ droid: { binary: "a\0b" } }).droid.binary).toBe("droid");
  });

  it("models entries must match the id charset, dedupe, and cap at 50", () => {
    const ids = Array.from({ length: 60 }, (_, i) => `m${i}`);
    const out = parseExternalAgentsSettings({ droid: { models: [...ids, "bad key with spaces", "x"] } }).droid;
    expect(out.models).toHaveLength(50);
    expect(out.models).toEqual(ids.slice(0, 50));
  });

  it("durations: in-range pass, out-of-range/non-number fall back to default (no silent clamp)", () => {
    const d = parseExternalAgentsSettings({
      droid: {
        catalogTtlMs: 120_000,
        requestTimeoutMs: 30_000,
        initTimeoutMs: 60_000,
        killGraceMs: 500,
      },
    }).droid;
    expect(d.catalogTtlMs).toBe(120_000);
    expect(d.requestTimeoutMs).toBe(30_000);
    expect(d.initTimeoutMs).toBe(60_000);
    expect(d.killGraceMs).toBe(500);
    // boundaries are legal
    const edges = parseExternalAgentsSettings({
      droid: { catalogTtlMs: 60_000, requestTimeoutMs: 1_000, initTimeoutMs: 5_000, killGraceMs: 200 },
    }).droid;
    expect([edges.catalogTtlMs, edges.requestTimeoutMs, edges.initTimeoutMs, edges.killGraceMs]).toEqual([
      60_000, 1_000, 5_000, 200,
    ]);
    const over = parseExternalAgentsSettings({
      droid: { catalogTtlMs: 2_592_000_001, requestTimeoutMs: 120_001, initTimeoutMs: 120_001, killGraceMs: 30_001 },
    }).droid;
    expect([over.catalogTtlMs, over.requestTimeoutMs, over.initTimeoutMs, over.killGraceMs]).toEqual([
      86_400_000, 15_000, 20_000, 2_000,
    ]);
  });

  it("file stores *S seconds; the four droid durations are on the time-unit boundary", () => {
    for (const ms of [
      "externalAgents.droid.catalogTtlMs",
      "externalAgents.droid.requestTimeoutMs",
      "externalAgents.droid.initTimeoutMs",
      "externalAgents.droid.killGraceMs",
    ]) {
      expect(TIME_SETTING_MS_PATHS).toContain(ms);
    }
    const fromFile = loadSettings({ externalAgents: { droid: { catalogTtlS: 120, killGraceS: 3 } } });
    expect(fromFile.externalAgents.droid.catalogTtlMs).toBe(120_000);
    expect(fromFile.externalAgents.droid.killGraceMs).toBe(3_000);
    // *S key of each path is the storage form
    expect(secondsKeyOf("externalAgents.droid.catalogTtlMs")).toBe("externalAgents.droid.catalogTtlS");
  });

  it("pricing: accepts unpriced / strict provider/id / full rate objects; drops the rest with one warn per key", () => {
    const out = parseExternalAgentsSettings({
      droid: {
        pricing: {
          "kimi-k3": "unpriced",
          "claude-sonnet-5": "anthropic/claude-sonnet-5",
          "glm-5.3": { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
          "zero-rates": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          "bad-ref": "sonnet",
          "missing-rate": { input: 1, output: 2, cacheRead: 0.5 },
          "neg-rate": { input: -1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
          "nan-rate": { input: Number.NaN, output: 2, cacheRead: 0.5, cacheWrite: 1 },
          "bad value key!": "unpriced",
        },
      },
    }).droid;
    expect(out.pricing).toEqual({
      "kimi-k3": "unpriced",
      "claude-sonnet-5": "anthropic/claude-sonnet-5",
      "glm-5.3": { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
      "zero-rates": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    const w = warnings();
    expect(w.some((line) => line.includes("externalAgents.droid.pricing.bad-ref ignored"))).toBe(true);
    expect(w.some((line) => line.includes("externalAgents.droid.pricing.missing-rate ignored"))).toBe(true);
    expect(w.some((line) => line.includes("externalAgents.droid.pricing.neg-rate ignored"))).toBe(true);
    expect(w.some((line) => line.includes("externalAgents.droid.pricing.nan-rate ignored"))).toBe(true);
    expect(w.some((line) => line.includes("externalAgents.droid.pricing.[bad value key!]"))).toBe(false);
    expect(w.some((line) => line.includes("bad value key!"))).toBe(true);
    expect(w.filter((line) => line.includes("bad-ref")).length).toBe(1);
  });

  it("pricing is not an object ⇒ ignored silently", () => {
    const out = parseExternalAgentsSettings({ droid: { pricing: "nope" } }).droid;
    expect(out.pricing).toEqual({});
    expect(warnings()).toEqual([]);
  });

  it("a file without externalAgents gains NO new keys on loadSettingsFromFile (关闭态字节一致)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-ext-"));
    const path = join(dir, "pi-subagent.json");
    const original = { concurrencyLimit: 4, budget: { idleS: 240 } };
    writeFileSync(path, JSON.stringify(original, null, 2) + "\n", "utf8");
    loadSettingsFromFile(path);
    const after = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(after).toEqual(original);
    expect("externalAgents" in after).toBe(false);
  });

  it("a file with externalAgents *S keys round-trips them (still seconds, no *Ms rewrite)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-ext-"));
    const path = join(dir, "pi-subagent.json");
    const original = { externalAgents: { droid: { enabled: true, catalogTtlS: 300, killGraceS: 1 } } };
    writeFileSync(path, JSON.stringify(original, null, 2) + "\n", "utf8");
    const settings = loadSettingsFromFile(path);
    expect(settings.externalAgents.droid.enabled).toBe(true);
    expect(settings.externalAgents.droid.catalogTtlMs).toBe(300_000);
    expect(settings.externalAgents.droid.killGraceMs).toBe(1_000);
    const after = JSON.parse(readFileSync(path, "utf8")) as typeof original;
    expect(after).toEqual(original);
  });
});
