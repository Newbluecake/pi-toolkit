import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { wireWebHub, type WebHubDeps, type WebHubSettings } from "../../../src/web-hub/agent/index.js";
import { DEFAULT_FEISHU_BOT_SETTINGS, type FeishuBotSettings } from "../../../src/config/settings.js";
import { fakeCtx, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";
let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir("wh-d-wire-proxy-");
  resetGlobals();
});
afterEach(() => {
  resetGlobals();
  tmp.cleanup();
});

function fakeNodeLoader(): string {
  const p = join(tmp.dir, "fake-jiti-cli.mjs");
  writeFileSync(p, "");
  return p;
}
function deps(over: Partial<WebHubDeps> = {}): WebHubDeps {
  return {
    settings: SETTINGS,
    fleet: () => [],
    env: { HOME: tmp.dir },
    paths: pathsIn(tmp.dir),
    buildInfo: async () => ({ pluginVersion: "1.2.3", buildId: "1.2.3@test" }),
    argv1: "/nonexistent/pi",
    ...over,
  };
}
const flush = () => new Promise<void>((r) => setImmediate(r));
function enoentConnect(): typeof import("node:net").connect {
  return (() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }) as unknown as typeof import("node:net").connect;
}

async function spawnedConfig(
  settings: WebHubSettings,
  feishuBot?: FeishuBotSettings,
): Promise<Record<string, unknown>> {
  const spawnImpl = vi.fn(() => ({ on: () => undefined, unref: () => undefined }) as never);
  const { pi, fire } = fakePi();
  wireWebHub(
    pi,
    deps({
      settings: { ...settings, autoStart: true, nodeLoader: fakeNodeLoader() },
      netConnect: enoentConnect(),
      spawnImpl,
      ...(feishuBot === undefined ? {} : { feishuBot }),
    }),
  );
  fire("session_start", { type: "session_start", reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
  await flush();
  await flush();
  expect(spawnImpl).toHaveBeenCalledTimes(1);
  const env = (spawnImpl.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2].env;
  return JSON.parse(env.PI_WEBHUB_CONFIG) as Record<string, unknown>;
}

describe("FA buildHubConfig top-level feishuBot gate", () => {
  it("absent and enabled:false are deep-equal configs with no bot key", async () => {
    const absent = await spawnedConfig(SETTINGS);
    resetGlobals();
    const off = await spawnedConfig(SETTINGS, DEFAULT_FEISHU_BOT_SETTINGS);
    expect(off).toEqual(absent);
    expect(off).not.toHaveProperty("feishuBot");
  });
  it("enabled passes exactly normalized public leaves, never enabled or secrets", async () => {
    const cfg = await spawnedConfig(SETTINGS, { ...DEFAULT_FEISHU_BOT_SETTINGS, enabled: true });
    // LAN-I/E now forwards security alerts (settings default on).
    const { enabled: _enabled, ...expected } = DEFAULT_FEISHU_BOT_SETTINGS;
    expect(cfg.feishuBot).toEqual(expected);
    expect(cfg.feishuBot).not.toHaveProperty("enabled");
    expect(cfg.feishuBot).toHaveProperty("securityAlerts", true);
    expect(cfg.feishuBot).toHaveProperty("xsMirror", true);
  });
  it("xsMirror:false is forwarded as false", async () => {
    const cfg = await spawnedConfig(SETTINGS, { ...DEFAULT_FEISHU_BOT_SETTINGS, enabled: true, xsMirror: false });
    expect(cfg.feishuBot).toHaveProperty("xsMirror", false);
  });
  it("control:false omits the entire key even if bot enabled", async () => {
    const cfg = await spawnedConfig({ ...SETTINGS, control: false }, { ...DEFAULT_FEISHU_BOT_SETTINGS, enabled: true });
    expect(cfg).not.toHaveProperty("feishuBot");
  });
  it("webHub disabled never spawns or registers hooks even if bot enabled", () => {
    const { pi, fire } = fakePi();
    const spawnImpl = vi.fn();
    wireWebHub(
      pi,
      deps({
        settings: { ...SETTINGS, enabled: false },
        feishuBot: { ...DEFAULT_FEISHU_BOT_SETTINGS, enabled: true },
        spawnImpl,
      }),
    );
    fire("session_start", { type: "session_start", reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
