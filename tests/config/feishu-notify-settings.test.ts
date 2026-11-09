import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  loadSettingsFromFile,
  persistSettingOverride,
  readSettingsNoMigrate,
} from "../../src/config/settings.js";
import {
  currentOf,
  isKnownSettingKey,
  parseSettingValue,
  SETTING_SPECS,
  settingKeys,
} from "../../src/config/setting-specs.js";
import { parseNotifyFields } from "../../src/feishu-notify/settings.js";
import { FEISHU_NOTIFY_SETTING_SPECS } from "../../src/feishu-notify/setting-specs.js";
import { createStatusCommand } from "../../src/commands/status.js";
import { SettingsEditorModel, renderSettingsEditor } from "../../src/ui/settings-editor.js";
import { SECURE_DOMAIN_KEY, resetSecureDomainForTests } from "../../src/secure/domain.js";

const scratch: string[] = [];
function file(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "notify-settings-"));
  scratch.push(dir);
  const path = join(dir, "pi-toolkit.json");
  writeFileSync(path, text);
  return path;
}
afterEach(() => {
  resetSecureDomainForTests();
  vi.restoreAllMocks();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const additions = [
  "feishuNotify.waitNotifyTimeoutSec",
  "feishuNotify.heartbeatIntervalSec",
  "feishuNotify.idleNotifyTimeoutSec",
  "feishuNotify.subagentSummaryEnabled",
  "feishuNotify.subagentForegroundSummary",
  "feishuNotify.requireBackgroundIdle",
  "feishuNotify.watchDefault",
];

describe("#70 unified feishuNotify settings", () => {
  it("keeps sparse defaults so legacy and env fallback are not overwritten during settings loading", () => {
    expect(DEFAULT_SETTINGS.feishuNotify).toEqual({ enabled: true });
    for (const input of [undefined, null, [], false, "bad", { feishuNotify: null }, { feishuNotify: [] }]) {
      expect(loadSettings(input).feishuNotify).toEqual({ enabled: true });
    }
    expect(
      loadSettings({ feishuNotify: { enabled: false, watchDefault: false, idleNotifyTimeoutSec: 0 } }).feishuNotify,
    ).toEqual({ enabled: false, idleNotifyTimeoutSec: 0, watchDefault: false });
  });

  it("whitelists all fields, ignores null/invalid/unknown values and copies tool arrays", () => {
    const tools = ["ask_user"];
    const raw = {
      enabled: true,
      webhookUrl: "",
      secret: "",
      waitNotifyTools: tools,
      waitNotifyTimeoutSec: -1,
      heartbeatIntervalSec: 0,
      idleNotifyTimeoutSec: 0.5,
      subagentFlushDebounceMs: 12.5,
      subagentDeliveryGraceMs: 0,
      subagentSummaryEnabled: false,
      subagentForegroundSummary: false,
      requireBackgroundIdle: false,
      watchDefault: false,
      unknown: "ignored",
    };
    const { unknown: _unknown, ...expected } = raw;
    const result = loadSettings({ feishuNotify: raw }).feishuNotify;
    expect(result).toEqual(expected);
    expect(result.waitNotifyTools).not.toBe(tools);
    for (const key of Object.keys(parseNotifyFields(raw))) {
      expect(parseNotifyFields({ [key]: null })).toEqual({});
    }
    expect(
      parseNotifyFields({
        webhookUrl: {},
        secret: false,
        waitNotifyTools: [null],
        idleNotifyTimeoutSec: Infinity,
        watchDefault: 0,
      }),
    ).toEqual({});
  });

  it("adds exactly seven safe non-live specs; credentials, arrays and *Ms stay JSON-only", () => {
    expect(Object.keys(FEISHU_NOTIFY_SETTING_SPECS)).toEqual(additions);
    expect(settingKeys().filter((key) => key.startsWith("feishuNotify."))).toEqual([
      "feishuNotify.enabled",
      ...additions,
    ]);
    for (const key of additions) {
      const spec = SETTING_SPECS[key]!;
      expect(spec.path).toBe(key);
      expect(spec.live).toBeUndefined();
      expect(spec.time).toBeUndefined(); // existing legacy Sec fields are already seconds
      expect(spec.description).toContain("/reload");
      expect(currentOf(DEFAULT_SETTINGS, spec)).toBeUndefined(); // unset = inherit, not an injected default
      const raw = spec.kind === "boolean" ? "false" : "0";
      expect(parseSettingValue(spec, raw)).toEqual({
        ok: true,
        stored: spec.kind === "boolean" ? false : 0,
        live: spec.kind === "boolean" ? false : 0,
      });
    }
    for (const key of [
      "secret",
      "webhookUrl",
      "waitNotifyTools",
      "subagentFlushDebounceMs",
      "subagentDeliveryGraceMs",
    ]) {
      expect(isKnownSettingKey(`feishuNotify.${key}`)).toBe(false);
    }
  });

  it("TUI rows, text list, completions and rejected credential set requests never display credential values", async () => {
    const secret = ["synthetic", "signing", "value"].join("-");
    const webhook = `https://example.invalid/${secret}`;
    const settings = {
      current: loadSettings({ feishuNotify: { webhookUrl: webhook, secret, watchDefault: true } }),
      persist: vi.fn(() => undefined),
      path: "/safe/pi-toolkit.json",
    };
    const model = new SettingsEditorModel(settings);
    expect(model.snapshot().rows.some((row) => row.key === "feishuNotify.watchDefault" && row.value === "true")).toBe(
      true,
    );
    const command = createStatusCommand({ settings } as never);
    const notified: string[] = [];
    const ctx = { mode: "rpc", ui: { notify: (message: string) => notified.push(message) } };
    await command.handler("settings list", ctx as never);
    expect(notified[0]).toContain("feishuNotify.watchDefault");
    await command.handler(`settings set feishuNotify.secret ${secret}`, ctx as never);
    await command.handler(`settings set feishuNotify.webhookUrl ${webhook}`, ctx as never);
    expect(notified[1]).toContain('Unknown settings key "feishuNotify.secret"');
    expect(notified[2]).toContain('Unknown settings key "feishuNotify.webhookUrl"');
    expect(settings.persist).not.toHaveBeenCalled();
    const completions = command.getArgumentCompletions!("settings set feishuNotify.", 0);
    const surfaces = JSON.stringify({
      rows: model.snapshot().rows,
      rendered: renderSettingsEditor(model.snapshot(), { width: 120 }),
      notified,
      completions,
    });
    expect(surfaces).not.toContain(secret);
    expect(surfaces).not.toContain(webhook);
    expect(completions?.some((item) => item.value === "settings set feishuNotify.watchDefault")).toBe(true);
    expect(completions?.some((item) => item.value === "settings set feishuNotify.secret")).toBe(false);
  });

  it("malformed unified JSON cannot leak snippets through load warnings or persistence errors; file untouched", () => {
    const secret = ["synthetic", "broken-json", "value"].join("-");
    const text = `{"feishuNotify":{"secret":"${secret}"} ${secret}`;
    const path = file(text);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadSettingsFromFile(path).feishuNotify).toEqual({ enabled: true });
    expect(readSettingsNoMigrate(path).feishuNotify).toEqual({ enabled: true });
    const persistError = persistSettingOverride("feishuNotify.watchDefault", false, path);
    expect(persistError).toBe(`${path}: invalid or unreadable settings; not modifying it`);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain("invalid or unreadable settings");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    expect(persistError).not.toContain(secret);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("persistence of safe settings preserves JSON-only credentials and full file loading keeps every field", () => {
    const secret = ["synthetic", "round-trip", "value"].join("-");
    const raw = {
      enabled: true,
      secret,
      webhookUrl: `https://example.invalid/${secret}`,
      subagentFlushDebounceMs: 1_501,
      waitNotifyTools: [],
    };
    const path = file(JSON.stringify({ feishuNotify: raw }));
    expect(persistSettingOverride("feishuNotify.watchDefault", false, path)).toBeUndefined();
    const expected = { ...raw, watchDefault: false };
    expect(JSON.parse(readFileSync(path, "utf8")).feishuNotify).toEqual(expected);
    expect(loadSettingsFromFile(path).feishuNotify).toEqual(expected);
    expect(readSettingsNoMigrate(path).feishuNotify).toEqual(expected);
  });

  it("both loaders force enabled:false in locked domains even with unified credentials and explicit enabled:true", () => {
    const path = file(
      JSON.stringify({ feishuNotify: { enabled: true, webhookUrl: "https://example.invalid", watchDefault: true } }),
    );
    (globalThis as Record<symbol, unknown>)[SECURE_DOMAIN_KEY] = { kind: "locked" };
    expect(loadSettingsFromFile(path).feishuNotify.enabled).toBe(false);
    expect(readSettingsNoMigrate(path).feishuNotify.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.feishuNotify).toEqual({ enabled: true });
  });
});
