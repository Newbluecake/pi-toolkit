/**
 * web-hub-preview plan v3 PV1 验收：`WebHubSettings.preview` → `PI_WEBHUB_CONFIG` 的下发矩阵。
 *
 *   - 默认配置（settings 不带 `preview`）⇒ `PI_WEBHUB_CONFIG` 与 preview 合入前的形态相比
 *     **恰好多一个** `preview:"on"`（U1：默认 on）；
 *   - `preview:"off"` ⇒ 与现状（preview 合入前）**深相等**——连 `preview` 键都不存在
 *     （§4.7 矩阵 off 行的 wire 层前提）；
 *   - `preview:"loopback"` ⇒ `preview:"loopback"` 上 wire。
 *
 * 手法照抄 `wiring-spawn.test.ts`：auto-spawn 一条 hub 进程（nodeLoader 指向假 jiti-cli、
 * netConnect 抛 ENOENT），从 spawnImpl spy 的 env 里读 `PI_WEBHUB_CONFIG`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { wireWebHub, type WebHubDeps, type WebHubSettings } from "../../../src/web-hub/agent/index.js";
import { fakeCtx, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir } from "./helpers.js";

let tmp: ReturnType<typeof tmpDir>;
beforeEach(() => {
  tmp = tmpDir("wh-d-wire-preview-");
  resetGlobals();
});
afterEach(() => {
  resetGlobals();
  tmp.cleanup();
});

/** A `webHub.nodeLoader` override that resolves ok (so `shouldSpawnHub` can pass launcherOk). */
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

/** Drive session_start through wireWebHub with autoStart on and capture PI_WEBHUB_CONFIG. */
async function hubConfigFor(settings: WebHubSettings): Promise<Record<string, unknown>> {
  const spawnImpl = vi.fn(() => ({ on: () => undefined, unref: () => undefined }) as never);
  const { pi, fire } = fakePi();
  wireWebHub(pi, deps({ settings, netConnect: enoentConnect(), spawnImpl }));
  fire("session_start", { type: "session_start", reason: "startup" }, fakeCtx({ mode: "tui" }).ctx);
  await flush();
  await flush();
  expect(spawnImpl).toHaveBeenCalledTimes(1);
  const env = (spawnImpl.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2].env;
  return JSON.parse(env.PI_WEBHUB_CONFIG) as Record<string, unknown>;
}

/** The byte-exact pre-preview hub config for this fixture (what the off case must deep-equal). */
function baselineConfig(): Record<string, unknown> {
  return {
    v: 1,
    home: tmp.dir,
    port: 0,
    idleExitMinutes: 10,
    pluginVersion: "1.2.3",
    buildId: "1.2.3@test",
    launcher: [process.execPath, "/nonexistent/pi"],
  };
}

const BASELINE_KEYS = ["buildId", "home", "idleExitMinutes", "launcher", "pluginVersion", "port", "v"];

describe("wireWebHub — preview config (plan PV1: default on ⇒ exactly one extra key; off ⇒ pre-preview deep-equal)", () => {
  it('default settings (no preview key) ⇒ PI_WEBHUB_CONFIG deep-equals baseline + exactly one extra key preview:"on"', async () => {
    const settings: WebHubSettings = { ...SETTINGS, autoStart: true, nodeLoader: fakeNodeLoader() };
    const config = await hubConfigFor(settings);
    expect(config).toEqual({ ...baselineConfig(), preview: "on" });
    // 恰好多一个：键集合 = 基线 + preview，别无其他
    expect(Object.keys(config).sort()).toEqual([...BASELINE_KEYS, "preview"].sort());
    expect(config.preview).toBe("on");
  });

  it('settings.preview: "off" ⇒ PI_WEBHUB_CONFIG deep-equals the pre-preview shape (no preview key at all)', async () => {
    const settings: WebHubSettings = { ...SETTINGS, autoStart: true, nodeLoader: fakeNodeLoader(), preview: "off" };
    const config = await hubConfigFor(settings);
    expect(config).toEqual(baselineConfig());
    expect("preview" in config).toBe(false);
  });

  it('settings.preview: "loopback" ⇒ config.preview === "loopback"', async () => {
    const settings: WebHubSettings = {
      ...SETTINGS,
      autoStart: true,
      nodeLoader: fakeNodeLoader(),
      preview: "loopback",
    };
    const config = await hubConfigFor(settings);
    expect(config).toEqual({ ...baselineConfig(), preview: "loopback" });
    expect(config.preview).toBe("loopback");
  });
});
