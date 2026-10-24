/**
 * external-agent plan §6.2 P5 验收① + quota-plan r2 §4 接线清单 2（15.x P7 转入项 3）：
 * enabled=false ⇒ 关闭态零接线、零行为变化（无路由 / 无钩子 / 无写盘 / 提示词 golden /
 * consult 与 set_model 未拿到谓词）；enabled=true 且 quota.providers:"" ⇒ 零 Factory 请求。
 */
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionStack, type Stack } from "../../src/stack.js";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import { formatAvailableModelsForPrompt, type AvailableModelEntry } from "../../src/config/available-models.js";
import { formatUnknownModelError } from "../../src/config/model-hint.js";

/** 与 P4a golden fixture 相同的确定性模型表（tests/fixtures/available-models-golden.txt）。 */
function goldenModels(): AvailableModelEntry[] {
  return [
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5", reasoning: true, contextWindow: 200_000 },
    { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000 },
    { provider: "openai", id: "gpt-5.2", contextWindow: 1_000_000 },
    { provider: "kimi", id: "kimi-k2.5" },
    { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000 },
    { provider: "moonshot", id: "kimi-k2.5-turbo", contextWindow: 128_000 },
    ...Array.from({ length: 26 }, (_, i) => ({ provider: `prov${i}`, id: `model-${i}`, name: `Filler ${i}` })),
  ];
}

const golden = readFileSync(join(__dirname, "..", "fixtures", "available-models-golden.txt"), "utf8");

function fakePi() {
  return {
    sendMessage: vi.fn(),
    appendEntry: () => undefined,
    events: { emit: () => undefined, on: () => () => undefined },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  } as unknown as ExtensionAPI;
}

function stackContext(cwd: string): ExtensionContext {
  return {
    cwd,
    sessionManager: { getEntries: () => [], getSessionId: () => "ext-disabled", getBranch: () => [] },
    modelRegistry: {
      getAvailable: () => goldenModels(),
      getAll: () => goldenModels(),
      find: (p: string, id: string) => goldenModels().find((m) => m.provider === p && m.id === id),
    },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    hasUI: false,
    mode: "interactive",
  } as unknown as ExtensionContext;
}

const type = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" } as never;
const types = {
  get: (name: string) => (name === "worker" ? type : undefined),
  list: () => [type],
  reload: async () => ({ types: [type], errors: [] }),
} as never;

function settings(over: { externalEnabled?: boolean; quotaProviders?: string } = {}): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    fleetWidget: false,
    bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
    cacheTtl: { ...DEFAULT_SETTINGS.cacheTtl, keepalive: false },
    quota: { ...DEFAULT_SETTINGS.quota, providers: over.quotaProviders ?? "", gate: true },
    externalAgents: {
      droid: { ...DEFAULT_SETTINGS.externalAgents.droid, enabled: over.externalEnabled ?? false },
    },
  };
}

interface Built {
  stack: Stack;
  agentDir: string;
  dispose(): void;
}

function build(over: { externalEnabled?: boolean; quotaProviders?: string } = {}): Built {
  const agentDir = mkdtempSync(join(tmpdir(), "ext-disabled-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const stack = buildSessionStack(fakePi(), stackContext(agentDir), settings(over), types, []);
  return {
    stack,
    agentDir,
    dispose() {
      stack.external?.dispose();
      stack.quota?.dispose();
      stack.schedule?.dispose();
      stack.rpc.close();
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const fn of teardowns.splice(0)) fn();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("external-disabled bytes (P5 验收①)", () => {
  it("enabled=false ⇒ 无端口、无进程登记、无 exit 钩子、无写盘", () => {
    const reg = globalThis as Record<symbol, unknown>;
    const key = Symbol.for("pi-subagent:external-agent-procs");
    const hadRegistry = reg[key] !== undefined;
    const exitListeners = process.listeners("exit").length;
    const b = build({ externalEnabled: false });
    teardowns.push(b.dispose);
    expect(b.stack.external).toBeUndefined();
    // 进程级登记未被创建（此前若被其它测试创建则不新增——按 key 存在性对账）。
    expect(reg[key] !== undefined).toBe(hadRegistry);
    // 一次性 exit 钩子未安装。
    expect(process.listeners("exit").length).toBe(exitListeners);
    // 目录零创建：<agentDir>/external-agent 与 cache/external-agent 都不存在。
    expect(existsSync(join(b.agentDir, "external-agent"))).toBe(false);
    expect(existsSync(join(b.agentDir, "cache", "external-agent"))).toBe(false);
  });

  it("enabled=false ⇒ Available models 提示词与 golden 逐字节一致（external 投影缺席）", () => {
    const b = build({ externalEnabled: false });
    teardowns.push(b.dispose);
    // stack.models.available() 与注册表一致；external 缺席 ⇒ P4a golden 锁定的输出。
    const models = b.stack.models.available();
    expect(formatAvailableModelsForPrompt(models)).toBe(golden);
    expect(formatAvailableModelsForPrompt(models, undefined)).toBe(golden);
  });

  it("enabled=false ⇒ consult/set_model 谓词缺席：droid/x 严格解析不落外部、错误逐字节原样", () => {
    const b = build({ externalEnabled: false });
    teardowns.push(b.dispose);
    // resolveHint 不包装：严格 droid/x 不被外部认领 ⇒ 原函数（注册表无 droid ⇒ undefined）。
    expect(b.stack.models.resolveHint("droid/gpt-6-luna")).toBeUndefined();
    expect(b.stack.models.resolveHint("gpt-5.2")).toEqual({ provider: "openai", id: "gpt-5.2" });
    // spawn droid/x ⇒ 与改动前逐字节一致的 unknown-model 文案（端口缺席路径）。
    const spawned = b.stack.spawn
      .spawn({ type: "worker", prompt: "x", modelOverride: { provider: "droid", id: "gpt-6-luna" } })
      .then((r) => r as { error?: { message: string } });
    return spawned.then((r) => {
      expect(r.error?.message).toBe(
        formatUnknownModelError(
          { provider: "droid", id: "gpt-6-luna" },
          goldenModels().map((m) => ({ provider: m.provider, id: m.id, name: m.name })),
        ),
      );
      expect(b.stack.query.list()).toEqual([]);
    });
  });

  it("15.x-3：enabled=false ⇒ 零 api.factory.ai 请求、零 [quota] droid 告警", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("FACTORY_API_KEY", "fk-disabled-bytes");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = build({ externalEnabled: false, quotaProviders: "droid" });
    teardowns.push(b.dispose);
    teardowns.push(() => warn.mockRestore());
    b.stack.quota?.refreshIfStale();
    await b.stack.quota?.whenIdle?.();
    await new Promise((r) => setTimeout(r, 200));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("[quota] droid"))).toEqual([]);
  });

  it('15.x-3：enabled=true 且 quota.providers:"" ⇒ 同样零 Factory 请求（一次 hint 告警允许）', async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("FACTORY_API_KEY", "fk-providers-empty");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const b = build({ externalEnabled: true, quotaProviders: "" });
    teardowns.push(b.dispose);
    teardowns.push(() => warn.mockRestore());
    b.stack.quota?.refreshIfStale();
    await b.stack.quota?.whenIdle?.();
    await new Promise((r) => setTimeout(r, 200));
    expect(fetchMock).not.toHaveBeenCalled();
    const droidWarns = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("[quota]"));
    // 唯一允许的告警：droid 不在 quota.providers 白名单的提示（恰好一次）。
    expect(droidWarns.filter((m) => m.includes("quota.providers"))).toHaveLength(1);
    expect(droidWarns.filter((m) => m.includes("[quota] droid:"))).toEqual([]);
  });
});
