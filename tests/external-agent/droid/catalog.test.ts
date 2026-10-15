import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tmpRoots: string[] = [];
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}
import { DEFAULT_EXTERNAL_AGENTS_SETTINGS } from "../../../src/config/settings.js";
import {
  binaryFingerprint,
  createDroidCatalog,
  parseAvailableModels,
  unknownDroidModelMessage,
} from "../../../src/external-agent/droid/catalog.js";
import { DROID_METHODS } from "../../../src/external-agent/droid/protocol.js";
import { probeCwd } from "../../../src/external-agent/paths.js";
import { makeFakeDeps, type FakeCatalogStore } from "./fakes.js";

const SETTINGS = { ...DEFAULT_EXTERNAL_AGENTS_SETTINGS.droid, enabled: true };
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

const AVAIL = [
  {
    id: "gpt-6-luna",
    modelId: "gpt-6-luna",
    modelProvider: "openai",
    displayName: "GPT-6 Luna",
    supportedReasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "low",
    deprecated: false,
    tokenMultiplier: 0.04,
  },
  { id: "kimi-k3", modelProvider: "factory", deprecated: false, supportedReasoningEfforts: ["high"] },
  { id: "auto", kind: "router", modelProvider: "factory", deprecated: false },
  { id: "old-1", deprecated: true },
  { junk: true },
];

describe("droid/catalog parseAvailableModels", () => {
  it("字段映射 + 畸形条目跳过", () => {
    const models = parseAvailableModels(AVAIL);
    expect(models).toHaveLength(4);
    expect(models[0]).toEqual({
      id: "gpt-6-luna",
      displayName: "GPT-6 Luna",
      upstreamProvider: "openai",
      tokenMultiplier: 0.04,
      reasoningEfforts: ["low", "high"],
      defaultEffort: "low",
      deprecated: false,
    });
    expect(models[1]).toMatchObject({ id: "kimi-k3", upstreamProvider: "factory", reasoningEfforts: ["high"] });
    expect(models[2]).toMatchObject({ id: "auto", kind: "router" });
    expect(models[3]).toMatchObject({ id: "old-1", deprecated: true });
    expect(parseAvailableModels("junk")).toEqual([]);
  });
});

describe("droid/catalog store 与探测", () => {
  it("snapshot：内存 ⇒ 磁盘缓存；绝不 spawn", () => {
    const agentDir = mkTmp("droid-agent-");
    const f = makeFakeDeps(agentDir);
    const store = f.deps.catalogStore as FakeCatalogStore;
    const catalog = createDroidCatalog(f.deps, () => SETTINGS);
    expect(catalog.snapshot()).toBeUndefined();
    expect(f.spawnOpts).toHaveLength(0);
    store.onDisk = { provider: "droid", fetchedAt: 1, models: [] };
    expect(catalog.snapshot()?.fetchedAt).toBe(1);
  });

  it("refreshInBackground：探测写缓存（probeCwd + extraEnv），close 后 graceful", async () => {
    const agentDir = mkTmp("droid-agent-");
    const f = makeFakeDeps(agentDir);
    f.rpcHandler = (m) => {
      if (m === DROID_METHODS.initializeSession)
        return { sessionId: "probe-session-1", session: { messages: [] }, settings: {}, availableModels: AVAIL };
      return {};
    };
    const catalog = createDroidCatalog(f.deps, () => SETTINGS);
    catalog.refreshInBackground("stack_build");
    await flush();
    expect(f.spawnOpts).toHaveLength(1);
    expect(f.spawnOpts[0]!.cwd).toBe(probeCwd(agentDir));
    expect(f.spawnOpts[0]!.extraEnv).toEqual({ DISABLE_AUTO_UPDATE: "1", FACTORYD_DISABLE_AUTO_UPDATE: "1" });
    const snap = catalog.snapshot();
    expect(snap?.models.map((m) => m.id)).toEqual(["gpt-6-luna", "kimi-k3", "auto", "old-1"]);
    expect(snap?.protocolVersion).toBeUndefined(); // 假 rpc 未走 envelope.check
    expect((f.deps.catalogStore as FakeCatalogStore).written).toHaveLength(1);
    expect(f.rpcs[0]!.requests.map((r) => r.method)).toEqual([
      DROID_METHODS.initializeSession,
      DROID_METHODS.closeSession,
    ]);
    expect(f.children[0]!.terminated).toEqual(["graceful"]);
  });

  it("single-flight：探测中重复调用不再 spawn", async () => {
    const agentDir = mkTmp("droid-agent-");
    const f = makeFakeDeps(agentDir);
    f.rpcHandler = undefined; // FakeRpc handler 缺席 ⇒ request 永远 pending（探测挂起）
    const catalog = createDroidCatalog(f.deps, () => SETTINGS);
    catalog.refreshInBackground("stack_build");
    catalog.refreshInBackground("stale");
    expect(f.spawnOpts).toHaveLength(1);
    catalog.dispose();
    expect(f.children[0]!.terminated).toContain("now");
  });

  it("探测失败（spawn 抛错）静默：snapshot 保持旧缓存", async () => {
    const agentDir = mkTmp("droid-agent-");
    const f = makeFakeDeps(agentDir);
    const store = f.deps.catalogStore as FakeCatalogStore;
    store.onDisk = { provider: "droid", fetchedAt: 7, models: [] };
    f.spawnError = new Error("spawn ENOENT");
    const catalog = createDroidCatalog(f.deps, () => SETTINGS);
    catalog.refreshInBackground("stack_build");
    await flush();
    expect(catalog.snapshot()?.fetchedAt).toBe(7);
  });

  it("探测中漂移 ⇒ catalog.drift 记录", async () => {
    const agentDir = mkTmp("droid-agent-");
    const f = makeFakeDeps(agentDir);
    f.rpcHandler = (m) => {
      if (m === DROID_METHODS.initializeSession) {
        f.rpcs[0]!.opts.onDrift({ expected: "1.264.0", actual: "9.9.9" });
        return { sessionId: "probe-session-2", settings: {}, availableModels: AVAIL };
      }
      return {};
    };
    const catalog = createDroidCatalog(f.deps, () => SETTINGS);
    catalog.refreshInBackground("stack_build");
    await flush();
    expect(catalog.snapshot()?.drift).toEqual({ expected: "1.264.0", actual: "9.9.9" });
  });

  it("observeInit：run init 顺带刷新目录（零额外进程）", () => {
    const agentDir = mkTmp("droid-agent-");
    const f = makeFakeDeps(agentDir);
    const catalog = createDroidCatalog(f.deps, () => SETTINGS);
    catalog.observeInit(AVAIL, "1.264.0");
    expect(catalog.snapshot()?.protocolVersion).toBe("1.264.0");
    expect(catalog.snapshot()?.models).toHaveLength(4);
    expect(f.spawnOpts).toHaveLength(0);
    catalog.observeInit([], "1.264.0"); // 空表不覆盖
    expect(catalog.snapshot()?.models).toHaveLength(4);
  });
});

describe("droid/catalog binaryFingerprint 与 unknownDroidModelMessage", () => {
  it("binaryFingerprint：realpath|size|mtime|ino；不存在 ⇒ undefined", () => {
    const f = join(mkTmp("droid-bin-"), "droid");
    writeFileSync(f, "x");
    expect(binaryFingerprint(f)).toMatch(/\|\d+\|\d+(\.\d+)?\|\d+$/);
    expect(binaryFingerprint("/nonexistent/droid")).toBeUndefined();
  });

  it("unknownDroidModelMessage：带目录候选 / 目录缺失提示", () => {
    const withCatalog = unknownDroidModelMessage("bogus", {
      provider: "droid",
      fetchedAt: 0,
      models: parseAvailableModels(AVAIL),
    });
    expect(withCatalog).toContain('"bogus"');
    expect(withCatalog).toContain("gpt-6-luna");
    expect(withCatalog).not.toContain("old-1"); // deprecated 不列
    expect(unknownDroidModelMessage("bogus", undefined)).toContain("catalog unavailable");
  });
});
