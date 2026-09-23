import { describe, expect, it, vi } from "vitest";
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
    cacheTtl: { ...DEFAULT_SETTINGS.cacheTtl, keepalive: false, adaptiveEnabled: false },
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
