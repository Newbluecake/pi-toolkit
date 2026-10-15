import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../src/core/clock.js";
import { createCatalogPoolPort } from "../../src/quota/pools.js";
import { createQuotaStack as createRealQuotaStack, type QuotaStack as RealQuotaStack } from "../../src/quota/index.js";
import { buildSessionStack, type Stack } from "../../src/stack.js";
import { createQuotaHintHook } from "../../src/quota/index.js";
import { parseSubscriptionProviders, pickAlternatives } from "../../src/quota/gate.js";
import type { ProviderVerdict } from "../../src/quota/ladder.js";
import { DEFAULT_SETTINGS, type AgentSettings, type QuotaSettings } from "../../src/config/settings.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildDroidStack, makeBinary, type DroidStack } from "./helpers/external-droid.js";

/**
 * quota-plan §9 末尾：装配面（Pack A）的六条集成用例。
 *
 * 测试隔离：`quota.providers: ""` ⇒ 零 adapter ⇒ refreshIfStale 空转、零网络、
 * 零 demotion 读——buildSessionStack 因此完全密闭（生产默认值经 providers
 * 白名单选择 adapter，这里刻意清空）。需要 verdict 时直接对 stack.quota 的
 * 同步判定面打 spy（gate/hook 闭包读的正是同一个 service 实例）。
 */

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
    sessionManager: { getEntries: () => [], getSessionId: () => "quota-test", getBranch: () => [] },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    hasUI: false,
    mode: "interactive",
  } as unknown as ExtensionContext;
}

const emptyTypes = { get: () => undefined, list: () => [], reload: async () => ({ types: [], errors: [] }) } as never;

/** providers="" 锁死零网络；其余按用例覆盖。 */
function quotaSettings(overrides: Partial<QuotaSettings> = {}): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    fleetWidget: false,
    bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
    cacheTtl: { ...DEFAULT_SETTINGS.cacheTtl, keepalive: false },
    quota: { ...DEFAULT_SETTINGS.quota, providers: "", ...overrides },
  };
}

/** L3、非陈旧的 zai-coding-cn 判定（闸门/注入共用桩）。 */
function l3Verdict(overrides: Partial<ProviderVerdict> = {}): ProviderVerdict {
  return {
    provider: "zai-coding-cn",
    level: 3,
    windows: [{ scope: "5h", usedPct: 98, level: 3, reason: "exhausted" }],
    demoted: false,
    fetchedAt: Date.now(),
    stale: false,
    ...overrides,
  };
}

function l1Verdict(): ProviderVerdict {
  return l3Verdict({ level: 1, windows: [{ scope: "5h", usedPct: 55, level: 1, reason: "pct" }] });
}

/** hook 的 ctx：interactive 模式（print/json 首行门放行）。 */
function turnCtx(): ExtensionContext {
  return { mode: "interactive" } as unknown as ExtensionContext;
}

/** 与 index.ts 逐字同构的钩子接线（holder 间接层是 /reload 存活的关键）。 */
function wireQuotaHook(pi: ExtensionAPI, holder: { current?: Stack }) {
  return createQuotaHintHook({
    state: () => holder.current?.quotaHint,
    verdicts: () => holder.current?.quota?.verdicts() ?? [],
    refresh: () => holder.current?.quota?.refreshIfStale(),
    sendMessage: (message, options) => pi.sendMessage(message, options),
  });
}

function teardown(stack: Stack): void {
  stack.quota?.dispose();
  stack.scheduler.stop();
  stack.rpc.close();
}

describe("quota wiring (Pack A assembly surface)", () => {
  it("buildSessionStack exposes quota + quotaHint when enabled, omits both when disabled", () => {
    const on = buildSessionStack(fakePi(), stackContext("/tmp/pi-subagent-quota-on"), quotaSettings(), emptyTypes, []);
    expect(on.quota).toBeDefined();
    expect(on.quotaHint).toBeDefined();
    expect(on.quotaHint?.enabled).toBe(true);
    teardown(on);

    const off = buildSessionStack(
      fakePi(),
      stackContext("/tmp/pi-subagent-quota-off"),
      quotaSettings({ enabled: false }),
      emptyTypes,
      [],
    );
    expect(off.quota).toBeUndefined();
    expect(off.quotaHint).toBeUndefined();
    teardown(off);
  });

  it("a second buildSessionStack disposes the previous quota service exactly once", () => {
    const first = buildSessionStack(
      fakePi(),
      stackContext("/tmp/pi-subagent-quota-handoff"),
      quotaSettings(),
      emptyTypes,
      [],
    );
    const disposeSpy = vi.spyOn(first.quota!, "dispose");
    const second = buildSessionStack(
      fakePi(),
      stackContext("/tmp/pi-subagent-quota-handoff"),
      quotaSettings(),
      emptyTypes,
      [],
    );
    expect(disposeSpy).toHaveBeenCalledTimes(1); // top-of-build handoff
    expect(second.quota).toBeDefined();
    expect(second.quota).not.toBe(first.quota); // a fresh service per session
    // M3：双重 dispose（handoff + session_shutdown）幂等——只清理一次。
    second.quota?.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    teardown(second);
  });

  it("the turn_end hook reads the rebuilt stack through the holder (survives /reload)", () => {
    const pi = fakePi();
    const holder: { current?: Stack } = {};
    const first = buildSessionStack(
      fakePi(),
      stackContext("/tmp/pi-subagent-quota-reload-a"),
      quotaSettings({ tickStepPercent: 10 }),
      emptyTypes,
      [],
    );
    holder.current = first;
    vi.spyOn(first.quota!, "verdicts").mockReturnValue([l1Verdict()]);
    const hook = wireQuotaHook(pi, holder);
    hook({}, turnCtx());
    expect(pi.sendMessage).toHaveBeenCalledTimes(1); // first entry into L1 announces
    hook({}, turnCtx());
    expect(pi.sendMessage).toHaveBeenCalledTimes(1); // latched in the old state
    teardown(first);

    // "Reload": index.ts registers the hook once per activate() and never
    // re-registers it on session_start — only holder.current is swapped.
    const second = buildSessionStack(
      fakePi(),
      stackContext("/tmp/pi-subagent-quota-reload-b"),
      quotaSettings({ tickStepPercent: 5 }),
      emptyTypes,
      [],
    );
    holder.current = second;
    vi.spyOn(second.quota!, "verdicts").mockReturnValue([l1Verdict()]);
    hook({}, turnCtx());
    expect(pi.sendMessage).toHaveBeenCalledTimes(2); // fresh latch in the NEW state
    expect(second.quotaHint?.latches.size).toBe(1);
    teardown(second);
  });

  it("an L3 stub fast-fails spawn with a config error and zero mutable state", async () => {
    const type = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" } as never;
    const types = {
      get: (name: string) => (name === "worker" ? type : undefined),
      list: () => [type],
      reload: async () => ({ types: [type], errors: [] }),
    } as never;
    const stack = buildSessionStack(fakePi(), stackContext("/tmp/pi-subagent-quota-gate"), quotaSettings(), types, []);
    vi.spyOn(stack.quota!, "verdictFor").mockImplementation((provider: string) =>
      provider === "zai-coding-cn" ? l3Verdict() : undefined,
    );
    const spawned = await stack.spawn.spawn({
      type: "worker",
      prompt: "doomed to 429",
      modelOverride: { provider: "zai-coding-cn", id: "glm-some-model" },
    });
    expect(spawned).toMatchObject({ error: { kind: "config", retryable: false } });
    expect("error" in spawned && spawned.error.message).toContain("quota gate");
    // 零可变状态写：闸门在 resumeLocks/labels/nesting/running 之前返回。
    expect(stack.query.list()).toEqual([]);
    teardown(stack);
  });

  it("quota.gate=false lets the same L3 verdict pass the gate", async () => {
    const type = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" } as never;
    const types = {
      get: (name: string) => (name === "worker" ? type : undefined),
      list: () => [type],
      reload: async () => ({ types: [type], errors: [] }),
    } as never;
    const stack = buildSessionStack(
      fakePi(),
      stackContext("/tmp/pi-subagent-quota-gate-off"),
      quotaSettings({ gate: false }),
      types,
      [],
    );
    vi.spyOn(stack.quota!, "verdictFor").mockImplementation((provider: string) =>
      provider === "zai-coding-cn" ? l3Verdict() : undefined,
    );
    // resumeFrom 指向不存在的 run：该错误发生在闸门**之后**、首个可变写之前——
    // 若闸门仍在生效，会先返回 quota gate 文案（见上一条用例）。
    const spawned = await stack.spawn.spawn({
      type: "worker",
      prompt: "should pass the gate",
      modelOverride: { provider: "zai-coding-cn", id: "glm-some-model" },
      resumeFrom: "no-such-run-anywhere",
    });
    expect(spawned).toMatchObject({ error: { kind: "config", retryable: false } });
    const message = "error" in spawned ? spawned.error.message : "";
    expect(message).not.toContain("quota gate");
    expect(stack.query.list()).toEqual([]);
    teardown(stack);
  });

  it("quota.enabled=false leaves the whole feature dark: no hook sends, unchanged spawn", async () => {
    const pi = fakePi();
    const holder: { current?: Stack } = {};
    const stack = buildSessionStack(
      fakePi(),
      stackContext("/tmp/pi-subagent-quota-feature-off"),
      quotaSettings({ enabled: false }),
      emptyTypes,
      [],
    );
    holder.current = stack;
    expect(stack.quota).toBeUndefined(); // deps all see nothing
    const hook = wireQuotaHook(pi, holder);
    expect(() => hook({}, turnCtx())).not.toThrow();
    expect(pi.sendMessage).not.toHaveBeenCalled();

    // Spawn unchanged: quotaRef is empty ⇒ the (gate=true) closure stays a
    // pass-through; the only error is the ordinary resume one, as today.
    const type = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" } as never;
    const types = {
      get: (name: string) => (name === "worker" ? type : undefined),
      list: () => [type],
      reload: async () => ({ types: [type], errors: [] }),
    } as never;
    const spawnStack = buildSessionStack(
      fakePi(),
      stackContext("/tmp/pi-subagent-quota-feature-off-spawn"),
      quotaSettings({ enabled: false }),
      types,
      [],
    );
    const spawned = await spawnStack.spawn.spawn({
      type: "worker",
      prompt: "unmodified behavior",
      modelOverride: { provider: "zai-coding-cn", id: "glm-some-model" },
      resumeFrom: "no-such-run-anywhere",
    });
    expect("error" in spawned ? spawned.error.message : "").not.toContain("quota gate");
    expect(spawnStack.query.list()).toEqual([]);
    teardown(spawnStack);
    teardown(stack);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// quota-plan r2 §11 quota-wiring（P7）：droid 池端到端。真 createQuotaStack（真适配器 +
// 真 createFetchJson，全局 fetch 被桩替换——绝不触达 api.factory.ai）+ 真 buildSessionStack
// 的闸门接线（stack.ts 的 modelView/poolAlternatives deps 委托给真 service）。
// P5 尚未向 stack.ts 注入 droid 输入，所以 session stack 自带的 service 无 droid 适配器；
// 这里把它的 verdictsForModel/poolAlternatives 委托给独立构造的真 droid service，
// 验证的正是 stack.ts 的闸门 deps → evaluateQuotaGate → spawn config error 这条线。
// ─────────────────────────────────────────────────────────────────────────────

const FACTORY_KEY = "fk-live-SECRET-0123456789";
const tmpDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/quota", name), "utf8")) as unknown;
}

const CATALOG = {
  models: [
    { id: "claude-opus-5-5", upstreamProvider: "anthropic" },
    { id: "glm-5.3", upstreamProvider: "factory" },
    { id: "kimi-k3", upstreamProvider: "factory" },
  ],
};

interface DroidHarness {
  readonly stack: RealQuotaStack;
  readonly clock: FakeClock;
  readonly fetchMock: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly setStatus: ReturnType<typeof vi.fn>;
}

function droidHarness(
  respond: () => Response,
  opts: { withDroidInput?: boolean; providers?: string } = {},
): DroidHarness {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-quota-droid-"));
  tmpDirs.push(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir); // 凭据回落不读真实 ~/.pi/agent/auth.json
  vi.stubEnv("FACTORY_API_KEY", FACTORY_KEY);
  const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => respond());
  vi.stubGlobal("fetch", fetchMock);
  const clock = new FakeClock(1_000);
  const warn = vi.fn();
  const setStatus = vi.fn();
  const port = createCatalogPoolPort({ provider: "droid", catalog: () => CATALOG });
  const stack = createRealQuotaStack({
    settings: { ...DEFAULT_SETTINGS.quota, providers: opts.providers ?? "droid" },
    clock,
    statePath: join(agentDir, "quota-state.json"),
    setStatus,
    warn,
    ...(opts.withDroidInput === false ? {} : { droid: { pools: () => port } }),
  });
  if (stack === undefined) throw new Error("quota disabled");
  return { stack, clock, fetchMock, warn, setStatus };
}

const jsonResp = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const workerTypes = (() => {
  const type = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" } as never;
  return {
    get: (name: string) => (name === "worker" ? type : undefined),
    list: () => [type],
    reload: async () => ({ types: [type], errors: [] }),
  } as never;
})();

/**
 * 15.x P7 转入项 2（P5）：真 stack 端到端——不再 vi.spyOn 委托。buildDroidStack 用
 * fake-droid wrapper 当 binary：端口/目录探测（stack_build 后台）→ createCatalogPoolPort
 * → createQuotaStack 的 droid 输入 → service 判定面 → stack.ts 的闸门 deps，全链真接线。
 * billing 响应经 stub 的全局 fetch（绝不触达 api.factory.ai）。
 */
async function realDroidStack(respond: () => Response, quotaOver: Partial<QuotaSettings> = {}): Promise<DroidStack> {
  vi.stubEnv("FACTORY_API_KEY", FACTORY_KEY);
  const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => respond());
  vi.stubGlobal("fetch", fetchMock);
  const binary = makeBinary(join(tmpdir(), `quota-wiring-bin-${Math.random().toString(36).slice(2)}`), []);
  const s = buildDroidStack({
    binary,
    quota: { providers: "droid", ...(quotaOver as object) } as never,
  });
  // 目录探测（stack_build 后台启动）完成后再判定/派发，否则池映射退化为 custom: 启发式。
  const deadline = Date.now() + 20_000;
  for (;;) {
    const ids = (s.stack.external?.advertised() ?? []).map((m) => m.id);
    if (ids.includes("kimi-k3") && ids.includes("claude-sonnet-5")) break;
    if (Date.now() > deadline) throw new Error("catalog probe did not complete");
    await new Promise((r) => setTimeout(r, 100));
  }
  s.stack.quota?.refreshIfStale();
  await s.stack.quota?.whenIdle();
  return s;
}

const realStacks: DroidStack[] = [];
afterEach(() => {
  for (const s of realStacks.splice(0)) s.dispose();
});

/** session stack（providers=""，零网络）+ 闸门委托给真 droid service。 */
function sessionStackWith(h: DroidHarness, cwd: string): Stack {
  const stack = buildSessionStack(fakePi(), stackContext(cwd), quotaSettings(), workerTypes, []);
  vi.spyOn(stack.quota!, "verdictsForModel").mockImplementation((m) => h.stack.service.verdictsForModel(m));
  vi.spyOn(stack.quota!, "poolAlternatives").mockImplementation((b, l) => h.stack.service.poolAlternatives(b, l));
  return stack;
}

describe("quota wiring — droid pools (P7, real-stack e2e since P5)", () => {
  it("standard exhausted ⇒ spawn droid/<standard model> is fast-failed with core-pool + pi-native alternatives; no run is created", async () => {
    const s = await realDroidStack(() => jsonResp(fixtureJson("factory-limits-standard-exhausted.json")));
    realStacks.push(s);
    // 两个池的判定面真实存在（真适配器 + 真 catalog 端口）。
    expect(s.stack.quota?.verdicts().map((v) => v.provider)).toEqual(["droid-standard", "droid-core"]);
    const spawned = await s.stack.spawn.spawn({
      type: "worker",
      prompt: "needs the standard pool",
      modelOverride: { provider: "droid", id: "claude-sonnet-5" },
    });
    expect(spawned).toMatchObject({ error: { kind: "config", retryable: false } });
    const message = "error" in spawned ? spawned.error.message : "";
    expect(message).toContain("quota gate: droid/claude-sonnet-5（Standard 池）");
    // fake 目录的 core 池只有 kimi-k3（auto=router、old-model-1=deprecated 已滤）。
    expect(message).toContain("优先改用 Droid Core 池模型：droid/kimi-k3");
    expect(message).toContain(
      "Droid 模型按池：Standard 池（已拦，勿派）：droid/gpt-6-luna、droid/claude-sonnet-5；Core 池（有余量）：droid/kimi-k3。",
    );
    expect(message).toContain("Factory 超额策略为 extraUsage（额外余额 $12.34）");
    expect(message).not.toContain(FACTORY_KEY);
    expect(s.stack.query.list()).toEqual([]);
  });

  it("droid/kimi-k3 (core pool, healthy) passes the gate while standard stays exhausted", async () => {
    const s = await realDroidStack(() => jsonResp(fixtureJson("factory-limits-standard-exhausted.json")));
    realStacks.push(s);
    // resumeFrom 指向不存在的 run：该错误发生在闸门**之后**——闸门若拦会先返回 quota gate 文案。
    const spawned = await s.stack.spawn.spawn({
      type: "worker",
      prompt: "core pool is fine",
      modelOverride: { provider: "droid", id: "kimi-k3" },
      resumeFrom: "no-such-run-anywhere",
    });
    expect("error" in spawned ? spawned.error.message : "").not.toContain("quota gate");
    expect(s.stack.query.list()).toEqual([]);
  });

  it("droidAllowExtraUsage=true opens the standard gate (extraUsage + balance) — same exhausted data passes", async () => {
    const s = await realDroidStack(() => jsonResp(fixtureJson("factory-limits-standard-exhausted.json")), {
      droidAllowExtraUsage: true,
    });
    realStacks.push(s);
    const spawned = await s.stack.spawn.spawn({
      type: "worker",
      prompt: "money is explicitly allowed",
      modelOverride: { provider: "droid", id: "claude-sonnet-5" },
      resumeFrom: "no-such-run-anywhere",
    });
    expect("error" in spawned ? spawned.error.message : "").not.toContain("quota gate");
  });

  it("no droid input (externalAgents off) ⇒ verdictsForModel undefined — the gate stays on the legacy path", async () => {
    // enabled=false ⇒ 端口缺席 ⇒ stack.ts 不注入 droid 输入（15.x-3 同源断言，这里补判定面）。
    const agentDir = mkdtempSync(join(tmpdir(), "pi-quota-droid-off-"));
    tmpDirs.push(agentDir);
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const stack = buildSessionStack(
      fakePi(),
      stackContext("/tmp/pi-subagent-quota-droid-off"),
      quotaSettings({ providers: "droid" }),
      workerTypes,
      [],
    );
    try {
      expect(stack.external).toBeUndefined();
      expect(stack.quota?.verdictsForModel({ provider: "droid", id: "claude-opus-5-5" })).toBeUndefined();
      expect(stack.quota?.poolAlternatives("droid-standard")).toEqual([]);
    } finally {
      stack.quota?.dispose();
      stack.scheduler.stop();
      stack.rpc.close();
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  });

  it("droid input injected but `droid` absent from quota.providers ⇒ zero requests, one hint warning", async () => {
    const h = droidHarness(() => jsonResp({}), { providers: "" });
    h.stack.service.refreshIfStale();
    await h.stack.service.whenIdle();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(String(h.warn.mock.calls[0]?.[0])).toContain("quota.providers");
    h.stack.dispose();
  });

  it.each([401, 402, 403])(
    "HTTP %i ⇒ never blocks spawn (D3): one warning, invisible pools (no auth chip), and no key substring anywhere",
    async (status) => {
      const h = droidHarness(() => jsonResp({ error: "nope" }, status));
      h.stack.service.refreshIfStale();
      await h.stack.service.whenIdle();
      expect(h.fetchMock).toHaveBeenCalledTimes(1); // 非瞬时错误不重试
      expect(h.stack.service.verdicts()).toEqual([]);
      expect(h.stack.service.problems()).toEqual([]); // 终版拍板：鉴权问题不进任何 UI
      // 再刷一轮：同一状态码只告警一次。
      h.clock.advance(DEFAULT_SETTINGS.quota.refreshMs + 1);
      h.stack.service.refreshIfStale();
      await h.stack.service.whenIdle();
      const droidWarns = h.warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("[quota] droid:"));
      expect(droidWarns).toHaveLength(1);
      expect(droidWarns[0]).toContain(`HTTP ${status}`);
      const hud = h.setStatus.mock.calls.map((c) => c[0] as string | undefined).filter((x) => x !== undefined);
      expect(hud.at(-1)).toBeUndefined(); // 两池不可信 ⇒ 无 HUD 行，也不出 auth 段
      const everything = JSON.stringify([h.warn.mock.calls, h.setStatus.mock.calls, h.stack.service.problems()]);
      expect(everything).not.toContain(FACTORY_KEY);
      expect(everything).not.toContain("fk-live");
      h.stack.dispose();
    },
  );

  it("15.x-5: the turn_end hook walks the real stack — droid L3 alternatives include the core pool", async () => {
    const s = await realDroidStack(() => jsonResp(fixtureJson("factory-limits-standard-exhausted.json")));
    realStacks.push(s);
    const pi = fakePi();
    const holder: { current?: Stack } = {};
    holder.current = s.stack;
    // 与 index.ts 逐字同构的钩子接线（含 poolAlternatives 行）。
    const hook = createQuotaHintHook({
      state: () => holder.current?.quotaHint,
      verdicts: () => holder.current?.quota?.verdicts() ?? [],
      refresh: () => holder.current?.quota?.refreshIfStale(),
      sendMessage: (message, options) => pi.sendMessage(message, options),
      alternatives: (provider) =>
        pickAlternatives(provider, {
          verdictFor: (p) => holder.current?.quota?.verdictFor(p),
          available: () => holder.current?.models.recommendable() ?? [],
          isSubscription: parseSubscriptionProviders(DEFAULT_SETTINGS.quota.subscriptionProviders),
          poolAlternatives: (b) => holder.current?.quota?.poolAlternatives(b) ?? [],
        }),
    });
    hook({}, turnCtx());
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(pi.sendMessage.mock.calls[0]);
    expect(sent).toContain("droid-standard");
    expect(sent).toContain("droid/kimi-k3"); // core 池替代真实来自 stack 的 quota service
    expect(sent).not.toContain(FACTORY_KEY);
  });
});
