import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../src/core/clock.js";
import { createCatalogPoolPort } from "../../src/quota/pools.js";
import { createQuotaStack as createRealQuotaStack, type QuotaStack as RealQuotaStack } from "../../src/quota/index.js";
import { buildSessionStack, type Stack } from "../../src/stack.js";
import { createQuotaHintHook } from "../../src/quota/index.js";
import type { ProviderVerdict } from "../../src/quota/ladder.js";
import { DEFAULT_SETTINGS, type AgentSettings, type QuotaSettings } from "../../src/config/settings.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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

/** session stack（providers=""，零网络）+ 闸门委托给真 droid service。 */
function sessionStackWith(h: DroidHarness, cwd: string): Stack {
  const stack = buildSessionStack(fakePi(), stackContext(cwd), quotaSettings(), workerTypes, []);
  vi.spyOn(stack.quota!, "verdictsForModel").mockImplementation((m) => h.stack.service.verdictsForModel(m));
  vi.spyOn(stack.quota!, "poolAlternatives").mockImplementation((b, l) => h.stack.service.poolAlternatives(b, l));
  return stack;
}

describe("quota wiring — droid pools (P7)", () => {
  it("standard exhausted ⇒ spawn droid/<standard model> is fast-failed with core-pool + pi-native alternatives; no run is created", async () => {
    const h = droidHarness(() => jsonResp(fixtureJson("factory-limits-standard-exhausted.json")));
    h.stack.service.refreshIfStale();
    await h.stack.service.whenIdle();
    expect(h.fetchMock).toHaveBeenCalledTimes(1); // 两个池共用一次请求
    // 回归：`providers:"droid"` token 必须展开成两个虚拟 id（曾只置开关位，对子被 selectAdapters 滤光 ⇒ 零请求）。
    expect(h.stack.service.verdicts().map((v) => v.provider)).toEqual(["droid-standard", "droid-core"]);
    const [url, init] = h.fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://api.factory.ai/api/billing/limits");
    expect(init.headers.Authorization).toBe(`Bearer ${FACTORY_KEY}`);

    const stack = sessionStackWith(h, "/tmp/pi-subagent-quota-droid-block");
    const spawned = await stack.spawn.spawn({
      type: "worker",
      prompt: "needs the standard pool",
      modelOverride: { provider: "droid", id: "claude-opus-5-5" },
    });
    expect(spawned).toMatchObject({ error: { kind: "config", retryable: false } });
    const message = "error" in spawned ? spawned.error.message : "";
    expect(message).toContain("quota gate: droid/claude-opus-5-5（standard 池）");
    expect(message).toContain("优先改用 droid core 池模型：droid/glm-5.3、droid/kimi-k3");
    // session registry 里没有可推荐的 pi 模型 ⇒ 只有 core 行，没有 pi 行。
    expect(message).not.toContain("pi 原生子 agent");
    expect(message).toContain("Factory 超额策略为 extraUsage（额外余额 $12.34）"); // fixture overage=extraUsage, not opened
    expect(message).not.toContain(FACTORY_KEY);
    expect(stack.query.list()).toEqual([]);
    teardown(stack);
    h.stack.dispose();
  });

  it("droid/glm-5.3 (core pool, healthy) passes the gate while standard stays exhausted", async () => {
    const h = droidHarness(() => jsonResp(fixtureJson("factory-limits-standard-exhausted.json")));
    h.stack.service.refreshIfStale();
    await h.stack.service.whenIdle();
    const stack = sessionStackWith(h, "/tmp/pi-subagent-quota-droid-core");
    // resumeFrom 指向不存在的 run：该错误发生在闸门**之后**——闸门若拦会先返回 quota gate 文案。
    const spawned = await stack.spawn.spawn({
      type: "worker",
      prompt: "core pool is fine",
      modelOverride: { provider: "droid", id: "glm-5.3" },
      resumeFrom: "no-such-run-anywhere",
    });
    expect("error" in spawned ? spawned.error.message : "").not.toContain("quota gate");
    expect(stack.query.list()).toEqual([]);
    teardown(stack);
    h.stack.dispose();
  });

  it("droidAllowExtraUsage=true opens the standard gate (extraUsage + balance) — same exhausted data passes", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-quota-droid-open-"));
    tmpDirs.push(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("FACTORY_API_KEY", FACTORY_KEY);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResp(fixtureJson("factory-limits-standard-exhausted.json"))),
    );
    const port = createCatalogPoolPort({ provider: "droid", catalog: () => CATALOG });
    const real = createRealQuotaStack({
      settings: { ...DEFAULT_SETTINGS.quota, providers: "droid", droidAllowExtraUsage: true },
      clock: new FakeClock(1_000),
      statePath: join(agentDir, "quota-state.json"),
      droid: { pools: () => port },
    })!;
    real.service.refreshIfStale();
    await real.service.whenIdle();
    const h = { stack: real } as DroidHarness;
    const stack = sessionStackWith(h, "/tmp/pi-subagent-quota-droid-open");
    const spawned = await stack.spawn.spawn({
      type: "worker",
      prompt: "money is explicitly allowed",
      modelOverride: { provider: "droid", id: "claude-opus-5-5" },
      resumeFrom: "no-such-run-anywhere",
    });
    expect("error" in spawned ? spawned.error.message : "").not.toContain("quota gate");
    teardown(stack);
    real.dispose();
  });

  it("no droid input injected ⇒ zero Factory requests, zero credential warnings, no gate effect — even with providers listing droid", async () => {
    const h = droidHarness(() => jsonResp(fixtureJson("factory-limits-standard-exhausted.json")), {
      withDroidInput: false,
    });
    h.stack.service.refreshIfStale();
    h.clock.advance(DEFAULT_SETTINGS.quota.refreshMs + 1);
    h.stack.service.refreshIfStale();
    await h.stack.service.whenIdle();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
    expect(h.stack.service.verdicts()).toEqual([]);
    expect(h.stack.service.verdictsForModel({ provider: "droid", id: "claude-opus-5-5" })).toBeUndefined();
    expect(h.clock.pendingTimers).toBe(0);
    // 该 service 经闸门依旧放行 droid 模型（旧路径：非受管 ⇒ 放行）。
    const stack = sessionStackWith(h, "/tmp/pi-subagent-quota-droid-uninjected");
    const spawned = await stack.spawn.spawn({
      type: "worker",
      prompt: "unmanaged",
      modelOverride: { provider: "droid", id: "claude-opus-5-5" },
      resumeFrom: "no-such-run-anywhere",
    });
    expect("error" in spawned ? spawned.error.message : "").not.toContain("quota gate");
    teardown(stack);
    h.stack.dispose();
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
    "HTTP %i ⇒ never blocks spawn (D3): one warning, HUD `droid auth`, and no key substring anywhere",
    async (status) => {
      const h = droidHarness(() => jsonResp({ error: "nope" }, status));
      h.stack.service.refreshIfStale();
      await h.stack.service.whenIdle();
      expect(h.fetchMock).toHaveBeenCalledTimes(1); // 非瞬时错误不重试
      expect(h.stack.service.verdicts()).toEqual([]);
      expect(h.stack.service.problems()).toEqual([{ family: "droid", status }]);
      // 再刷一轮：同一状态码只告警一次。
      h.clock.advance(DEFAULT_SETTINGS.quota.refreshMs + 1);
      h.stack.service.refreshIfStale();
      await h.stack.service.whenIdle();
      const droidWarns = h.warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("[quota] droid:"));
      expect(droidWarns).toHaveLength(1);
      expect(droidWarns[0]).toContain(`HTTP ${status}`);
      const hud = h.setStatus.mock.calls.map((c) => c[0] as string | undefined).filter((x) => x !== undefined);
      expect(hud.at(-1)).toBe(`quota droid auth ${status}`);
      const everything = JSON.stringify([h.warn.mock.calls, h.setStatus.mock.calls, h.stack.service.problems()]);
      expect(everything).not.toContain(FACTORY_KEY);
      expect(everything).not.toContain("fk-live");

      // 不拦：任何 droid 模型的 spawn 都越过闸门（无快照 ⇒ fail-open）。
      const stack = sessionStackWith(h, `/tmp/pi-subagent-quota-droid-auth-${status}`);
      const spawned = await stack.spawn.spawn({
        type: "worker",
        prompt: "auth trouble must not block",
        modelOverride: { provider: "droid", id: "claude-opus-5-5" },
        resumeFrom: "no-such-run-anywhere",
      });
      const message = "error" in spawned ? spawned.error.message : "";
      expect(message).not.toContain("quota gate");
      expect(message).not.toContain(FACTORY_KEY);
      teardown(stack);
      h.stack.dispose();
    },
  );
});
