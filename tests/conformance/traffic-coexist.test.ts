/**
 * traffic 合并 T6 conformance — 真 pi 资源加载器下的双录制器共存（plan r3 §2.4 / §8.3）。
 *
 * 用真 `DefaultResourceLoader` + 临时 settings.json 的 `packages`（toolkit 仓库路径 + 临时
 * 外部 pi-traffic-record fixture 包）装配真 AgentSession，断言单向优先级认领协议：
 * **活动录制器恰为 1**。
 *
 * - CX1/CX2 外部旧版（v0.2.x，不认协议、恒活动）：两种加载顺序下 toolkit 都在 session_start
 *   复核（getCommands 权威证据）让位——claim 释放、钩子惰性；外部保持活动。
 * - CX3/CX4 外部墓碑版（v0.3.0，认领协议）：toolkit 先加载 ⇒ 墓碑版整体让位；外部先加载 ⇒
 *   toolkit 零注册零 claim（`external-active` 符号）。
 * - CX5 项目级过滤（packages 条目对象 filter 把外部扩展排除）：settings 列着但未加载 ⇒
 *   toolkit 保持活动；端到端 `/record on` + prompt 后 toolkit 库里确有该会话的行；shutdown
 *   后无残留 claim。
 * - CX6 settings 列着一个不存在的路径：外部未加载 ⇒ toolkit 活动。
 *
 * fixture 通过 `Symbol.for("test:traffic-fixture")` 暴露自身状态（版本/是否活动/是否让位/
 * payload 计数），toolkit 侧活动性用**进程符号** `pi-traffic-record:claim` 判定（与生产
 * isActive 同源）。全程临时 HOME/agentDir，无外网。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { peekEngine } from "../../src/traffic/engine.js";
import { resetTrafficGlobalForTest } from "../../src/traffic/container.js";
import { resetTrafficSessionSlotsForTest } from "../../src/traffic/index.js";
import { toolkitClaimIsLive } from "../../src/traffic/claim.js";
import { AnthropicStub } from "./fixtures/anthropic-stub.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const TOOLKIT_PACKAGE = REPO_ROOT;
const HOST_KEY = Symbol.for("pi-subagent:host");
const FEISHU_HOST_KEY = Symbol.for("pi-subagent:feishu-notify:host");
const KEEPALIVE_PORT_KEY = Symbol.for("pi-subagent:traffic-keepalive-port");
const REWRITE_MARKS_KEY = Symbol.for("pi-subagent:traffic-rewrite-marks");
const CLAIM_KEY = Symbol.for("pi-traffic-record:claim");
const EXTERNAL_ACTIVE_KEY = Symbol.for("pi-traffic-record:external-active");
const FIXTURE_STATE_KEY = Symbol.for("test:traffic-fixture");

type FixtureVersion = "0.2.1" | "0.3.0";

interface FixtureState {
  version: FixtureVersion;
  active: boolean;
  yielded: boolean;
  payloads: number;
  recordCommand: boolean;
}

/** 极小外部录制器：旧版恒活动；墓碑版只在无有效 toolkit claim 时活动（§2.4 协议的外部侧）。 */
function writeExternalFixture(dir: string, version: FixtureVersion): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "pi-traffic-record", version, private: true, pi: { extensions: ["./index.ts"] } }),
  );
  const tombstone = version === "0.3.0";
  writeFileSync(
    join(dir, "index.ts"),
    `const g = globalThis as Record<symbol, any>;
const STATE = Symbol.for("test:traffic-fixture");
const CLAIM = Symbol.for("pi-traffic-record:claim");
const EXTERNAL_ACTIVE = Symbol.for("pi-traffic-record:external-active");
export default function externalTrafficRecordFixture(pi: any): void {
  const state = { version: ${JSON.stringify(version)}, active: false, yielded: false, payloads: 0, recordCommand: false };
  g[STATE] = state;
  const claim = g[CLAIM];
  const claimLive =
    claim && claim.v === 1 && claim.owner === "pi-toolkit" && claim.pid === process.pid &&
    typeof claim.isLive === "function" && claim.isLive() === true;
  if (${tombstone ? "true" : "false"} && claimLive) {
    state.yielded = true;
    return; // 墓碑版整体让位：不注册命令、不打 patch。
  }
  state.active = true;
  if (${tombstone ? "true" : "false"}) g[EXTERNAL_ACTIVE] = { v: 1, version: "0.3.0", pid: process.pid };
  pi.registerCommand("record", { description: "external fixture /record", handler: async () => {} });
  state.recordCommand = true;
  pi.on("before_provider_request", () => {
    state.payloads++;
  });
}
`,
  );
  return dir;
}

interface CoexistOptions {
  externalVersion: FixtureVersion;
  order: "toolkit-first" | "external-first";
  /** `filtered`：packages 条目用对象 filter 排除其扩展（列着但未加载）；`missing`：路径不存在。 */
  externalEntry?: "load" | "filtered" | "missing";
  /** 端到端：/record on + 一次 prompt，断言 toolkit 侧库行。 */
  endToEnd?: boolean;
}

interface CoexistHost {
  fixtureState: () => FixtureState | undefined;
  recordCommandCount: () => number;
  promptOnce: () => Promise<string>;
  recordOn: () => Promise<void>;
  toolkitRowCounts: () => Promise<{ requests: number; sessions: number }>;
  shutdown: () => Promise<void>;
}

const stubs: AnthropicStub[] = [];
const scratchDirs: string[] = [];
const hosts: Array<() => Promise<void>> = [];

async function coexistHost(options: CoexistOptions): Promise<CoexistHost> {
  const stub = await AnthropicStub.start();
  stubs.push(stub);
  const cwd = mkdtempSync(join(tmpdir(), "traffic-coexist-"));
  scratchDirs.push(cwd);
  const home = join(cwd, "home");
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  initTheme("dark", false);
  const model = {
    id: "coexistence-stub",
    name: "coexistence stub",
    api: "anthropic-messages" as const,
    provider: "coexist-anthropic-stub",
    baseUrl: `${stub.baseUrl}/v1`,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200_000,
    maxTokens: 1024,
  };
  writeFileSync(
    join(agentDir, "pi-subagent.json"),
    JSON.stringify({
      rememberAgents: true,
      fleetWidget: false,
      webSearch: { enabled: false },
      todo: { enabled: false },
      memory: { enabled: false },
      date: { enabled: false },
      hud: { enabled: false },
      feishuNotify: { enabled: false },
      askUser: { enabled: false },
      sessionNav: { enabled: false },
      title: { enabled: false },
      topicSwitch: { enabled: false },
      quota: { enabled: false },
      load: { enabled: false },
      workflow: { enabled: false },
      fabric: { enabled: false },
      bashJobs: { autoBackgroundS: 0 },
      compact: { childSessions: false, hintPercent: 0, dynamicThreshold: { mode: "off" } },
      cacheTtl: { mode: "off", keepalive: false, childKeepalive: false },
      consult: { enabled: false },
      traffic: { enabled: true, childSessions: true, web: { host: "127.0.0.1", port: 4177 } },
    }),
  );
  const fixtureDir = writeExternalFixture(join(cwd, "external-pi-traffic-record"), options.externalVersion);
  const listedPath = options.externalEntry === "missing" ? `${fixtureDir}-does-not-exist` : fixtureDir;
  // 外部条目形态：普通字符串（加载）/ 对象 filter（flat：extensions: [] 显式排除全部扩展，列着但未加载）/ 不存在路径。
  const externalEntry: string | Record<string, unknown> =
    options.externalEntry === "filtered" ? { source: listedPath, extensions: [] } : listedPath;
  const packages: Array<string | Record<string, unknown>> =
    options.order === "toolkit-first" ? [TOOLKIT_PACKAGE, externalEntry] : [externalEntry, TOOLKIT_PACKAGE];
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: [],
      packages,
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    }),
  );
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [model.provider]: {
          baseUrl: model.baseUrl,
          api: model.api,
          apiKey: "coexist-stub-key",
          models: [model],
        },
      },
    }),
  );
  const settingsManager = SettingsManager.create(cwd, agentDir);
  // 真 settings 发现（不用 noExtensions / factory）：packages 里的 toolkit 与外部包都经真实路径加载。
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await resourceLoader.reload();
  if (options.externalEntry !== "missing")
    expect(resourceLoader.getExtensions().errors, JSON.stringify(resourceLoader.getExtensions().errors)).toEqual([]);
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: model as never,
    settingsManager,
    resourceLoader,
    sessionManager: manager,
    tools: ["read"],
  } as never);
  await session.bindExtensions({ mode: "print", onError: () => undefined });
  const runner = session.extensionRunner!;
  let shut = false;
  const shutdown = async (): Promise<void> => {
    if (shut) return;
    shut = true;
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "exit" });
    session.dispose();
  };
  hosts.push(shutdown);
  return {
    fixtureState: () => (globalThis as Record<symbol, FixtureState | undefined>)[FIXTURE_STATE_KEY],
    recordCommandCount: () =>
      runner.getRegisteredCommands().filter((command) => /^record(:\d+)?$/.test(command.name)).length,
    promptOnce: async () => {
      await session.prompt("coexistence probe");
      return session.sessionId;
    },
    recordOn: async () => {
      const command = runner.getCommand("record");
      if (!command) throw new Error("no /record command registered");
      await command.handler("on", runner.createCommandContext() as never);
    },
    toolkitRowCounts: async () => {
      const engine = peekEngine();
      if (!engine) throw new Error("no traffic engine (expected /record on before this)");
      await engine.dbPort.whenIdle();
      const db = new DatabaseSync(engine.dbPath, { readOnly: true });
      try {
        return {
          requests: (db.prepare("SELECT COUNT(*) c FROM requests").get() as { c: number }).c,
          sessions: (db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c,
        };
      } finally {
        db.close();
      }
    },
    shutdown,
  };
}

afterEach(async () => {
  for (const shutdown of hosts.splice(0)) await shutdown();
  for (const stub of stubs.splice(0)) await stub.close();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  const engine = peekEngine();
  if (engine) await engine.close("test-teardown");
  resetTrafficGlobalForTest();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-traffic-record:claim")];
  delete (globalThis as Record<symbol, unknown>)[EXTERNAL_ACTIVE_KEY];
  delete (globalThis as Record<symbol, unknown>)[FIXTURE_STATE_KEY];
  resetTrafficSessionSlotsForTest();
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[FEISHU_HOST_KEY];
  delete (globalThis as Record<symbol, unknown>)[KEEPALIVE_PORT_KEY];
  delete (globalThis as Record<symbol, unknown>)[REWRITE_MARKS_KEY];
  vi.unstubAllEnvs();
});

/** 活动录制器数：toolkit claim 存活（生产 isActive 同源）+ fixture 自报活动。 */
function activeRecorders(fixture: FixtureState | undefined): number {
  return (toolkitClaimIsLive() ? 1 : 0) + (fixture?.active ? 1 : 0);
}

describe("traffic coexistence — real resource loader, exactly one active recorder (plan §2.4/§8.3)", () => {
  it("CX1: external v0.2.1 loaded AFTER the toolkit — toolkit yields at session_start re-check, external stays the one recorder", async () => {
    const host = await coexistHost({ externalVersion: "0.2.1", order: "toolkit-first", endToEnd: true });
    const fixture = host.fixtureState();
    expect(fixture).toMatchObject({ version: "0.2.1", active: true, yielded: false });
    // 权威证据复核释放了 claim ⇒ toolkit 不活动。
    expect(toolkitClaimIsLive()).toBe(false);
    expect(activeRecorders(fixture)).toBe(1);
    // 双 /record 注册都在（record 与 record:2），但活动录制器只有一个。
    expect(host.recordCommandCount()).toBe(2);
    // 端到端：唯一活动录制器（外部）确实在观察请求。
    await host.promptOnce();
    expect(fixture!.payloads).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it("CX2: external v0.2.1 loaded BEFORE the toolkit — same outcome, toolkit yields, exactly one recorder", async () => {
    const host = await coexistHost({ externalVersion: "0.2.1", order: "external-first" });
    const fixture = host.fixtureState();
    expect(fixture).toMatchObject({ version: "0.2.1", active: true, yielded: false });
    expect(toolkitClaimIsLive()).toBe(false);
    expect(activeRecorders(fixture)).toBe(1);
    expect(host.recordCommandCount()).toBe(2);
  }, 90_000);

  it("CX3: tombstone v0.3.0 loaded AFTER the toolkit — the tombstone yields entirely, toolkit is the one recorder", async () => {
    const host = await coexistHost({ externalVersion: "0.3.0", order: "toolkit-first" });
    const fixture = host.fixtureState();
    expect(fixture).toMatchObject({ version: "0.3.0", active: false, yielded: true, recordCommand: false });
    expect(toolkitClaimIsLive()).toBe(true);
    expect(activeRecorders(fixture)).toBe(1);
    // 墓碑版零注册 ⇒ 只有一个 /record（toolkit 的）。
    expect(host.recordCommandCount()).toBe(1);
  }, 90_000);

  it("CX4: tombstone v0.3.0 loaded BEFORE the toolkit — toolkit registers nothing (external-active), external is the one recorder", async () => {
    const host = await coexistHost({ externalVersion: "0.3.0", order: "external-first", endToEnd: true });
    const fixture = host.fixtureState();
    expect(fixture).toMatchObject({ version: "0.3.0", active: true, yielded: false, recordCommand: true });
    // toolkit 零注册零 claim（external-active 让位，不是发布后释放）。
    expect((globalThis as Record<symbol, unknown>)[CLAIM_KEY]).toBeUndefined();
    expect(toolkitClaimIsLive()).toBe(false);
    expect(activeRecorders(fixture)).toBe(1);
    expect(host.recordCommandCount()).toBe(1);
    await host.promptOnce();
    expect(fixture!.payloads).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it("CX5: external listed in settings but filtered out at the package level — toolkit stays active and records end to end; no claim residue after shutdown", async () => {
    const host = await coexistHost({ externalVersion: "0.2.1", order: "toolkit-first", externalEntry: "filtered" });
    // settings 列着外部包，但其扩展未加载（filter 排除）⇒ fixture 从未激活。
    expect(host.fixtureState()).toBeUndefined();
    expect(toolkitClaimIsLive()).toBe(true);
    expect(activeRecorders(undefined)).toBe(1);
    expect(host.recordCommandCount()).toBe(1);
    // 端到端：/record on（真命令路径）+ prompt ⇒ toolkit 库里确有本会话的行。
    await host.recordOn();
    const sessionId = await host.promptOnce();
    const counts = await host.toolkitRowCounts();
    expect(counts.requests).toBeGreaterThanOrEqual(1);
    expect(counts.sessions).toBeGreaterThanOrEqual(1);
    const engine = peekEngine()!;
    await engine.dbPort.whenIdle();
    const db = new DatabaseSync(engine.dbPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT session_id FROM requests").all() as unknown as { session_id: string }[];
      expect(rows.some((row) => row.session_id === sessionId)).toBe(true);
    } finally {
      db.close();
    }
    // shutdown ⇒ 身份校验释放，无残留 claim（reload 开→关等价）。
    await host.shutdown();
    expect(toolkitClaimIsLive()).toBe(false);
    expect((globalThis as Record<symbol, unknown>)[CLAIM_KEY]).toBeUndefined();
  }, 120_000);

  it("CX6: external package path listed but missing on disk — nothing loads, toolkit stays the one recorder", async () => {
    const host = await coexistHost({ externalVersion: "0.2.1", order: "toolkit-first", externalEntry: "missing" });
    expect(host.fixtureState()).toBeUndefined();
    expect(toolkitClaimIsLive()).toBe(true);
    expect(activeRecorders(undefined)).toBe(1);
    expect(host.recordCommandCount()).toBe(1);
  }, 90_000);
});
