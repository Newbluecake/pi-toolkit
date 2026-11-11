import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEGACY_RESULT_TOOL_NAME } from "../../src/core/tool-names.js";
import { resolveNotifyConfig, legacyNotifyConfigPath } from "../../src/feishu-notify/config.js";
import { parseConfig, sendToFeishu, type Config } from "../../src/feishu-notify/core.js";
import wireFeishuNotify from "../../src/feishu-notify/index.js";
import { parseFeishuNotifySettings } from "../../src/feishu-notify/settings.js";
import { SECURE_DOMAIN_KEY, resetSecureDomainForTests } from "../../src/secure/domain.js";

// Synthetic runtime values, never a real webhook token, signing secret or persisted fixture.
const credential = (name: string) => ["synthetic", name, "only"].join("-");
const url = (name: string) => `https://example.invalid/${credential(name)}`;
const allFields: Config = {
  webhookUrl: url("unified"),
  secret: credential("signing"),
  waitNotifyTimeoutSec: 12,
  waitNotifyTools: ["ask_user", LEGACY_RESULT_TOOL_NAME],
  heartbeatIntervalSec: 34,
  idleNotifyTimeoutSec: 56,
  subagentSummaryEnabled: false,
  subagentFlushDebounceMs: 78,
  subagentDeliveryGraceMs: 90,
  subagentForegroundSummary: true,
  requireBackgroundIdle: false,
  watchDefault: true,
};
const scratch: string[] = [];
afterEach(() => {
  resetSecureDomainForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function resolve(unified: unknown, legacy: unknown = {}, env: NodeJS.ProcessEnv = {}) {
  return resolveNotifyConfig({ unified, env, legacyPath: "/legacy.json", readFile: () => JSON.stringify(legacy) });
}

describe("#70 one notification configuration resolver", () => {
  it("legacy-only and unified-only cover all twelve fields, preserving tool rename compatibility", () => {
    expect(Object.keys(allFields)).toHaveLength(12);
    const expected = { enabled: true, ...parseConfig(allFields, {}) };
    expect(resolve({}, allFields)).toEqual(expected);
    expect(resolve(allFields)).toEqual(expected);
    expect(expected.waitNotifyTools).toEqual(["ask_user", "get_run_result"]);
  });

  it("merges field by field: unified > legacy > existing two env vars > built-ins", () => {
    const config = resolve(
      { webhookUrl: url("new"), waitNotifyTimeoutSec: 0, watchDefault: false },
      { webhookUrl: url("old"), secret: credential("old-signing"), idleNotifyTimeoutSec: 42, watchDefault: true },
      { FEISHU_WEBHOOK_URL: url("env"), FEISHU_WEBHOOK_SECRET: credential("env-signing") },
    );
    expect(config).toEqual({
      ...parseConfig({}, {}),
      enabled: true,
      webhookUrl: url("new"),
      secret: credential("old-signing"),
      waitNotifyTimeoutSec: 0,
      idleNotifyTimeoutSec: 42,
      watchDefault: false,
    });
    const inherited = resolve({ secret: credential("new-signing") }, {}, { FEISHU_WEBHOOK_URL: url("env") });
    expect(inherited.webhookUrl).toBe(url("env"));
    expect(inherited.secret).toBe(credential("new-signing"));
    const envOnly = resolve(
      {},
      {},
      {
        FEISHU_WEBHOOK_URL: url("env-only"),
        FEISHU_WEBHOOK_SECRET: credential("env-only-signing"),
      },
    );
    expect(envOnly.webhookUrl).toBe(url("env-only"));
    expect(envOnly.secret).toBe(credential("env-only-signing"));
  });

  it("null/invalid fields inherit, while explicit false, zero, negative, empty string and [] do not", () => {
    const nullFields = Object.fromEntries(Object.keys(allFields).map((key) => [key, null]));
    expect(resolve(nullFields, allFields)).toEqual(resolve({}, allFields));
    expect(resolve(null, allFields)).toEqual(resolve({}, allFields));
    expect(
      resolve(
        {
          webhookUrl: 123,
          secret: {},
          heartbeatIntervalSec: Number.NaN,
          waitNotifyTimeoutSec: Number.POSITIVE_INFINITY,
          waitNotifyTools: ["ask_user", 123],
          watchDefault: "true",
        },
        allFields,
      ),
    ).toEqual(resolve({}, allFields));
    const explicit = {
      webhookUrl: "",
      secret: "",
      waitNotifyTimeoutSec: 0,
      waitNotifyTools: [],
      heartbeatIntervalSec: -1,
      idleNotifyTimeoutSec: 0,
      subagentSummaryEnabled: false,
      subagentFlushDebounceMs: 0,
      subagentDeliveryGraceMs: 0,
      subagentForegroundSummary: false,
      requireBackgroundIdle: false,
      watchDefault: false,
    };
    expect(
      resolve(explicit, allFields, { FEISHU_WEBHOOK_URL: url("env"), FEISHU_WEBHOOK_SECRET: credential("env") }),
    ).toEqual({ enabled: true, ...explicit });
    expect(resolve({ secret: "" }, allFields).webhookUrl).toBe(allFields.webhookUrl);
    expect(resolve({ secret: "" }, allFields).secret).toBe("");
  });

  it("missing/bad/non-object legacy file falls back safely to env and defaults without reporting content", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const readFile of [
      () => undefined,
      () => `{${credential("broken")}`,
      () => "null",
      () => "[]",
      () => "false",
      () => {
        throw new Error(credential("io-error"));
      },
    ]) {
      const config = resolveNotifyConfig({ unified: {}, env: { FEISHU_WEBHOOK_URL: url("env") }, readFile });
      expect(config.webhookUrl).toBe(url("env"));
      expect(config.waitNotifyTimeoutSec).toBe(120);
    }
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(resolve({}).watchDefault).toBe(false);
    expect(resolve({}, { enabled: false }).enabled).toBe(true); // enabled is unified-only
  });

  it("FEISHU_NOTIFY_CONFIG_PATH selects only the old fallback, empty disables file I/O, and never overrides unified", () => {
    const readFile = vi.fn(() => JSON.stringify({ webhookUrl: url("old"), watchDefault: true }));
    const env = { FEISHU_NOTIFY_CONFIG_PATH: "/chosen.json", FEISHU_WEBHOOK_URL: url("env") };
    expect(legacyNotifyConfigPath({})).toMatch(/\/\.pi\/agent\/feishu-notify\.json$/);
    expect(resolveNotifyConfig({ unified: { webhookUrl: url("new") }, env, readFile }).webhookUrl).toBe(url("new"));
    expect(readFile).toHaveBeenCalledWith("/chosen.json");
    readFile.mockClear();
    expect(
      resolveNotifyConfig({ unified: {}, env: { ...env, FEISHU_NOTIFY_CONFIG_PATH: "" }, readFile }).webhookUrl,
    ).toBe(url("env"));
    expect(readFile).not.toHaveBeenCalled();
    expect(legacyNotifyConfigPath({ FEISHU_NOTIFY_CONFIG_PATH: "relative.json" })).toBe("relative.json");
  });

  it("unified file follows agentDir, legacy override stays fallback, and neither file is changed", () => {
    const dir = mkdtempSync(join(tmpdir(), "notify-config-"));
    scratch.push(dir);
    const settingsPath = join(dir, "pi-toolkit.json");
    const legacyPath = join(dir, "legacy.json");
    const unifiedText = JSON.stringify({ feishuNotify: { secret: credential("new"), watchDefault: false } });
    const legacyText = JSON.stringify({ webhookUrl: url("old"), secret: credential("old"), watchDefault: true });
    writeFileSync(settingsPath, unifiedText);
    writeFileSync(legacyPath, legacyText);
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    vi.stubEnv("FEISHU_NOTIFY_CONFIG_PATH", legacyPath);
    const config = resolveNotifyConfig();
    expect(config.webhookUrl).toBe(url("old"));
    expect(config.secret).toBe(credential("new"));
    expect(config.watchDefault).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).toBe(unifiedText);
    expect(readFileSync(legacyPath, "utf8")).toBe(legacyText);
  });

  it.each(["secure", "locked"])(
    "%s frozen verdict wins even over an explicitly false secure seam and all fallback sources",
    (kind) => {
      (globalThis as Record<symbol, unknown>)[SECURE_DOMAIN_KEY] = { kind };
      const readFile = vi.fn(() => JSON.stringify(allFields));
      expect(
        resolveNotifyConfig({ unified: allFields, env: { FEISHU_WEBHOOK_URL: url("env") }, readFile, secure: false }),
      ).toEqual({ enabled: false });
      expect(readFile).not.toHaveBeenCalled();
      const on = vi.fn();
      const registerCommand = vi.fn();
      wireFeishuNotify({ on, registerCommand } as never);
      expect(on).not.toHaveBeenCalled();
      expect(registerCommand).not.toHaveBeenCalled();
    },
  );

  it("explicit unified enabled:false does not read old credentials or re-enable through env", () => {
    const readFile = vi.fn(() => JSON.stringify(allFields));
    expect(
      resolveNotifyConfig({ unified: { enabled: false }, env: { FEISHU_WEBHOOK_URL: url("env") }, readFile }),
    ).toEqual({ enabled: false });
    expect(readFile).not.toHaveBeenCalled();
    expect(parseFeishuNotifySettings({ enabled: null })).toEqual({ enabled: true });
  });

  it("never leaks credentials from reflected HTTP bodies, thrown values, URLs or signed payloads", async () => {
    const config = resolve(allFields);
    const bodyLeak = JSON.stringify(config);
    for (const fetchFn of [
      vi.fn(async () => ({ ok: false, status: 400, text: async () => bodyLeak }) as Response),
      vi.fn(async () => {
        throw new Error(bodyLeak);
      }),
      vi.fn(async () => {
        throw bodyLeak;
      }),
    ]) {
      const result = await sendToFeishu(config, {}, { fetchFn, sleep: async () => {} });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/^(HTTP 400: Feishu notification rejected|Feishu notification request failed)$/);
      expect(result.error).not.toContain(credential("signing"));
      expect(result.error).not.toContain(url("unified"));
      expect(fetchFn).toHaveBeenCalledTimes(3);
    }
  });
});
