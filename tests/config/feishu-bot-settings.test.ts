// feishu-bot plan v2 §9 (F0): top-level `feishuBot` settings block — defaults, tolerance, warnings,
// non-live semantics (off by default ⇒ byte-identical), file round-trip through loadSettingsFromFile.
import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_FEISHU_BOT_SETTINGS,
  DEFAULT_SETTINGS,
  loadFeishuBotWarnings,
  loadSettings,
  loadSettingsFromFile,
  parseFeishuBotBlock,
  TIME_SETTING_MS_PATHS,
} from "../../src/config/settings.js";

const defaults = DEFAULT_FEISHU_BOT_SETTINGS;

describe("feishuBot settings: defaults", () => {
  it("pins the §9 defaults (off by default)", () => {
    expect(defaults).toEqual({
      securityAlerts: true,
      enabled: false,
      allowGroups: true,
      groupRootTopics: false,
      notify: "bound",
      spawnScope: "known",
      debounceMs: 1500,
      staleMessageS: 300,
      files: { outbound: "auto", inbound: true, maxInboundMiB: 30 },
    });
    expect(DEFAULT_SETTINGS.feishuBot).toEqual(defaults);
  });

  it("loadSettings({}) / undefined / garbage ⇒ defaults, as fresh copies (no shared mutable alias)", () => {
    for (const src of [{}, undefined, null, "x", [], { feishuBot: null }, { feishuBot: undefined }]) {
      const s = loadSettings(src).feishuBot;
      expect(s).toEqual(defaults);
    }
    const a = loadSettings({}).feishuBot;
    a.files.maxInboundMiB = 99;
    a.enabled = true;
    expect(loadSettings({}).feishuBot).toEqual(defaults);
    expect(DEFAULT_FEISHU_BOT_SETTINGS.files.maxInboundMiB).toBe(30);
    expect(DEFAULT_SETTINGS.feishuBot.files.maxInboundMiB).toBe(30);
    expect(DEFAULT_SETTINGS.feishuBot.enabled).toBe(false);
  });

  it("is a top-level block, not nested under webHub", () => {
    expect(loadSettings({ webHub: { feishuBot: { enabled: true } } }).feishuBot.enabled).toBe(false);
    expect(loadSettings({ feishuBot: { enabled: true } }).feishuBot.enabled).toBe(true);
    expect(DEFAULT_SETTINGS.webHub).not.toHaveProperty("feishuBot");
  });
});

describe("feishuBot settings: parsing", () => {
  it("accepts every valid leaf", () => {
    const parsed = parseFeishuBotBlock({
      enabled: true,
      allowGroups: false,
      groupRootTopics: true,
      notify: "off",
      spawnScope: "roots",
      debounceMs: 2500,
      staleMessageS: 600,
      files: { outbound: "buttons", inbound: false, maxInboundMiB: 12 },
    });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.feishuBot).toEqual({
      securityAlerts: true,
      enabled: true,
      allowGroups: false,
      groupRootTopics: true,
      notify: "off",
      spawnScope: "roots",
      debounceMs: 2500,
      staleMessageS: 600,
      files: { outbound: "buttons", inbound: false, maxInboundMiB: 12 },
    });
    expect(loadSettings({ feishuBot: { files: { outbound: "off" } } }).feishuBot.files).toEqual({
      outbound: "off",
      inbound: true,
      maxInboundMiB: 30,
    });
  });

  it("partial blocks keep the other defaults and warn about nothing", () => {
    const parsed = parseFeishuBotBlock({ enabled: true });
    expect(parsed.warnings).toEqual([]);
    expect(parsed.feishuBot).toEqual({ ...defaults, enabled: true });
  });

  it("wrong types / unknown enum values fall back field by field with a warning each", () => {
    const parsed = parseFeishuBotBlock({
      enabled: "yes",
      allowGroups: 1,
      groupRootTopics: "no",
      notify: "all",
      spawnScope: "anywhere",
      debounceMs: "fast",
      staleMessageS: Number.NaN,
      files: { outbound: "everything", inbound: "true", maxInboundMiB: Infinity },
    });
    expect(parsed.feishuBot).toEqual(defaults);
    expect(parsed.warnings).toEqual([
      "enabled-invalid",
      "allow-groups-invalid",
      "group-root-topics-invalid",
      "notify-invalid",
      "spawn-scope-invalid",
      "debounce-invalid",
      "stale-invalid",
      "files-outbound-invalid",
      "files-inbound-invalid",
      "files-max-inbound-invalid",
    ]);
  });

  it("a bad leaf never poisons its neighbours", () => {
    const parsed = parseFeishuBotBlock({ enabled: true, notify: 7, debounceMs: 100, files: { maxInboundMiB: 5 } });
    expect(parsed.feishuBot).toMatchObject({ enabled: true, notify: "bound", debounceMs: 100 });
    expect(parsed.feishuBot.files.maxInboundMiB).toBe(5);
    expect(parsed.warnings).toEqual(["notify-invalid"]);
  });

  it("numbers are rounded then clamped into range, with a -clamped warning only when changed", () => {
    expect(parseFeishuBotBlock({ debounceMs: -5 }).feishuBot.debounceMs).toBe(0);
    expect(parseFeishuBotBlock({ debounceMs: 10_001 }).feishuBot.debounceMs).toBe(10_000);
    expect(parseFeishuBotBlock({ staleMessageS: 1 }).feishuBot.staleMessageS).toBe(30);
    expect(parseFeishuBotBlock({ staleMessageS: 99_999 }).feishuBot.staleMessageS).toBe(3_600);
    expect(parseFeishuBotBlock({ files: { maxInboundMiB: 0 } }).feishuBot.files.maxInboundMiB).toBe(1);
    expect(parseFeishuBotBlock({ files: { maxInboundMiB: 101 } }).feishuBot.files.maxInboundMiB).toBe(100);
    expect(parseFeishuBotBlock({ files: { maxInboundMiB: 7.6 } }).feishuBot.files.maxInboundMiB).toBe(8);
    expect(parseFeishuBotBlock({ debounceMs: 1200.4 }).feishuBot.debounceMs).toBe(1200);
    expect(
      parseFeishuBotBlock({ debounceMs: 99_999, staleMessageS: 1, files: { maxInboundMiB: 500 } }).warnings,
    ).toEqual(["debounce-clamped", "stale-clamped", "files-max-inbound-clamped"]);
    // exact boundaries are not "clamped"
    expect(parseFeishuBotBlock({ debounceMs: 0, staleMessageS: 30, files: { maxInboundMiB: 1 } }).warnings).toEqual([]);
    expect(
      parseFeishuBotBlock({ debounceMs: 10_000, staleMessageS: 3600, files: { maxInboundMiB: 100 } }).warnings,
    ).toEqual([]);
  });

  it("non-object block ⇒ defaults; present-but-not-object warns, absent/null does not; bad files ⇒ files-invalid", () => {
    expect(parseFeishuBotBlock(undefined)).toEqual({ feishuBot: defaults, warnings: [] });
    expect(parseFeishuBotBlock(null)).toEqual({ feishuBot: defaults, warnings: [] });
    for (const bad of [5, "x", true, []]) {
      expect(parseFeishuBotBlock(bad)).toEqual({ feishuBot: defaults, warnings: ["block-invalid"] });
    }
    for (const bad of [5, "x", [], null]) {
      const parsed = parseFeishuBotBlock({ enabled: true, files: bad });
      expect(parsed.feishuBot).toEqual({ ...defaults, enabled: true });
      expect(parsed.warnings).toEqual(["files-invalid"]);
    }
  });

  it("never throws on hostile input and ignores unknown keys (never copied)", () => {
    const hostile = { enabled: true, __proto__: { polluted: true }, extra: { a: 1 }, files: { __x: 1 } };
    const parsed = parseFeishuBotBlock(hostile);
    expect(parsed.feishuBot).toEqual({ ...defaults, enabled: true });
    expect(parsed.feishuBot).not.toHaveProperty("extra");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("feishuBot settings: file loading (non-live, no time migration)", () => {
  let path: string;
  beforeEach(() => {
    path = join(mkdtempSync(join(tmpdir(), "pi-subagent-feishu-bot-")), "pi-subagent.json");
  });

  it("is not a time-unit path: debounceMs stays ms, staleMessageS stays seconds, the file is never rewritten", () => {
    expect(TIME_SETTING_MS_PATHS.filter((p) => p.startsWith("feishuBot"))).toEqual([]);
    const body = JSON.stringify({ feishuBot: { enabled: true, debounceMs: 2000, staleMessageS: 120 } });
    writeFileSync(path, body, "utf8");
    const s = loadSettingsFromFile(path);
    expect(s.feishuBot).toMatchObject({ enabled: true, debounceMs: 2000, staleMessageS: 120 });
    expect(readFileSync(path, "utf8")).toBe(body);
  });

  it("missing file / malformed JSON ⇒ defaults (feature stays off)", () => {
    expect(loadSettingsFromFile(path).feishuBot).toEqual(defaults);
    writeFileSync(path, "not json", "utf8");
    expect(loadSettingsFromFile(path).feishuBot.enabled).toBe(false);
  });

  it("a settings file without the block is byte-identical to defaults elsewhere (off ⇒ nothing changes)", () => {
    writeFileSync(path, JSON.stringify({ concurrencyLimit: 3 }), "utf8");
    const withFile = loadSettingsFromFile(path);
    expect(withFile.feishuBot).toEqual(DEFAULT_SETTINGS.feishuBot);
    expect(withFile.webHub).toEqual(DEFAULT_SETTINGS.webHub);
  });
});

describe("loadFeishuBotWarnings", () => {
  let path: string;
  beforeEach(() => {
    path = join(mkdtempSync(join(tmpdir(), "pi-subagent-feishu-warn-")), "pi-subagent.json");
  });
  const put = (value: unknown) => writeFileSync(path, JSON.stringify(value), "utf8");

  it("returns exactly the parseFeishuBotBlock warnings off the raw file", () => {
    put({ feishuBot: { enabled: "x", debounceMs: 99_999, files: { outbound: "zip" } } });
    expect(loadFeishuBotWarnings(path)).toEqual(["enabled-invalid", "debounce-clamped", "files-outbound-invalid"]);
    put({ feishuBot: { enabled: true } });
    expect(loadFeishuBotWarnings(path)).toEqual([]);
  });

  it("missing file / malformed JSON / missing or malformed blocks ⇒ [] (never throws)", () => {
    expect(loadFeishuBotWarnings(path)).toEqual([]);
    writeFileSync(path, "not json", "utf8");
    expect(loadFeishuBotWarnings(path)).toEqual([]);
    put("nope");
    expect(loadFeishuBotWarnings(path)).toEqual([]);
    put({ other: 1 });
    expect(loadFeishuBotWarnings(path)).toEqual([]);
    put({ feishuBot: 5 });
    expect(loadFeishuBotWarnings(path)).toEqual(["block-invalid"]);
  });
});

describe("LAN security P0 securityAlerts", () => {
  it("defaults true, accepts only bool, warns on wrong type", () => {
    expect(parseFeishuBotBlock({}).feishuBot.securityAlerts).toBe(true);
    expect(parseFeishuBotBlock({ securityAlerts: false })).toMatchObject({
      feishuBot: { securityAlerts: false },
      warnings: [],
    });
    expect(parseFeishuBotBlock({ securityAlerts: "false" })).toMatchObject({
      feishuBot: { securityAlerts: true },
      warnings: ["security-alerts-invalid"],
    });
  });
});
