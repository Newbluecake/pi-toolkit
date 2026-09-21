import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wireHud } from "../../src/hud/index.js";
import { LLM_TIME_ENTRY_TYPE, SESSION_START_ENTRY_TYPE } from "../../src/hud/timing.js";

/**
 * S4 生命周期测试：假 pi（含假 events bus，记录 on/off）驱动 wireHud，
 * 断言 activate → session_shutdown → 再 activate 三轮后总线监听数不增长、
 * timer 全部 clear。fake pi 内联（S7：禁止跨包共享 helper）。
 */

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function makeBus() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(channel: string, handler: (data: unknown) => void) {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
    emit(channel: string, data: unknown) {
      for (const handler of listeners.get(channel) ?? []) handler(data);
    },
    count() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
}

type Bus = ReturnType<typeof makeBus>;

function makePi(bus: Bus) {
  const hooks = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const pi = {
    on: (name: string, handler: Handler) => {
      const arr = hooks.get(name) ?? [];
      arr.push(handler);
      hooks.set(name, arr);
    },
    registerCommand: (name: string, value: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
      commands.set(name, value),
    appendEntry: vi.fn(),
    exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "", killed: false })),
    events: bus,
  } as unknown as ExtensionAPI;
  return { pi, hooks, commands };
}

function makeCtx(mode: string = "tui") {
  return {
    mode,
    cwd: "/tmp/hud-lifecycle-test",
    ui: {
      setFooter: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
      theme: { fg: (_color: string, text: string) => text },
    },
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [],
      getCwd: () => "/tmp/hud-lifecycle-test",
      getSessionName: () => undefined,
    },
    getContextUsage: () => undefined,
    model: undefined,
  } as unknown as ExtensionContext;
}

async function fire(hooks: Map<string, Handler[]>, name: string, ctx: ExtensionContext, event: unknown = {}) {
  for (const handler of hooks.get(name) ?? []) await handler(event, ctx);
}

describe("hud lifecycle (S3/S4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps bus listener count and timers flat across three reload cycles", async () => {
    // 事件总线跨 /reload 存活：三轮共用一个 bus。
    const bus = makeBus();
    for (let round = 0; round < 3; round++) {
      const { pi, hooks } = makePi(bus);
      wireHud(pi);
      expect(bus.count()).toBe(7); // 6 个 subagent(s):* + 1 个 subagent:usage

      const ctx = makeCtx("tui");
      await fire(hooks, "session_start", ctx);
      expect(vi.getTimerCount()).toBe(1); // refreshTimer

      await fire(hooks, "turn_start", ctx);
      expect(vi.getTimerCount()).toBe(2); // + llmTimer

      await fire(hooks, "session_shutdown", ctx);
      expect(bus.count()).toBe(0); // 全部退订，不随 reload 累积
      expect(vi.getTimerCount()).toBe(0); // 两个 interval 都 clear
      expect(ctx.ui.setFooter).toHaveBeenCalledWith(undefined);
      expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-hud", undefined);
    }
    // 三轮后第四次激活仍只有一套监听（不增长）。
    const { pi } = makePi(bus);
    wireHud(pi);
    expect(bus.count()).toBe(7);
  });

  it("resubscribes on the next session_start after an in-process shutdown (/new)", async () => {
    const bus = makeBus();
    const { pi, hooks } = makePi(bus);
    wireHud(pi);
    const ctx = makeCtx("tui");
    await fire(hooks, "session_start", ctx);
    await fire(hooks, "session_shutdown", ctx);
    expect(bus.count()).toBe(0);
    await fire(hooks, "session_start", makeCtx("tui"));
    expect(bus.count()).toBe(7);
  });

  it("is fully inert in non-tui mode (S3): no timers, no appendEntry, no footer", async () => {
    const bus = makeBus();
    const { pi, hooks } = makePi(bus);
    wireHud(pi);
    const ctx = makeCtx("rpc");
    await fire(hooks, "session_start", ctx);
    expect(vi.getTimerCount()).toBe(0);
    expect(ctx.ui.setFooter).not.toHaveBeenCalled();

    await fire(hooks, "turn_start", ctx);
    expect(pi.appendEntry).not.toHaveBeenCalled(); // appendEntry 在 live 门之后
    expect(vi.getTimerCount()).toBe(0);

    // 源插件缺陷：onBgStarted 无 mode 门会在 print/rpc 模式启 1Hz timer —— 已修复。
    bus.emit("subagent:started", { runId: "bg-1" });
    expect(vi.getTimerCount()).toBe(0);

    await fire(hooks, "message_end", ctx, { message: { role: "user" } });
    await fire(hooks, "tool_execution_start", ctx, { toolName: "bash" });
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();

    await fire(hooks, "session_shutdown", ctx);
    expect(bus.count()).toBe(0);
    expect(ctx.ui.setFooter).not.toHaveBeenCalled(); // 非 live 从未装 footer，也不清
  });

  it("tracks background agents via the bus and persists the held round on settle", async () => {
    const bus = makeBus();
    const { pi, hooks } = makePi(bus);
    wireHud(pi);
    const ctx = makeCtx("tui");
    await fire(hooks, "session_start", ctx);

    // 主会话空闲时后台 agent 启动 → 占位计时段 + 1Hz llmTimer。
    bus.emit("subagent:started", { runId: "run-1" });
    expect(vi.getTimerCount()).toBe(2); // refreshTimer + llmTimer

    // 兼容旧复数频道 { id }；Map 键去重，同 id 重复事件无害。
    bus.emit("subagents:started", { id: "run-1" });
    bus.emit("subagents:started", { id: "run-2" });

    bus.emit("subagent:completed", { runId: "run-1" }); // 还剩 run-2，不收尾
    expect(pi.appendEntry).not.toHaveBeenCalledWith(LLM_TIME_ENTRY_TYPE, expect.anything());

    bus.emit("subagent:failed", { runId: "run-2" }); // 最后一个结束 → 收尾落盘
    expect(pi.appendEntry).toHaveBeenCalledWith(
      LLM_TIME_ENTRY_TYPE,
      expect.objectContaining({ roundDurationMs: expect.any(Number) }),
    );
    expect(vi.getTimerCount()).toBe(1); // llmTimer 停，refreshTimer 留

    // subagent:usage 载荷 malformed 不炸。
    bus.emit("subagent:usage", { runs: "nope" });
    bus.emit("subagent:usage", { runs: [{ runId: 1 }, { runId: "r", costUsd: "x", terminal: 1 }] });

    await fire(hooks, "session_shutdown", ctx);
  });

  it("persists session-start entry on first turn_start (live only)", async () => {
    const bus = makeBus();
    const { pi, hooks, commands } = makePi(bus);
    wireHud(pi);
    expect(commands.has("pi-hud-refresh")).toBe(true);
    const ctx = makeCtx("tui");
    await fire(hooks, "session_start", ctx);
    await fire(hooks, "turn_start", ctx);
    expect(pi.appendEntry).toHaveBeenCalledWith(SESSION_START_ENTRY_TYPE, { startedAt: expect.any(Number) });
    await fire(hooks, "turn_start", ctx);
    // 第二个 turn_start 强制收尾上一轮并持久化 llm-time，但 session-start 只落盘一次。
    await fire(hooks, "turn_start", ctx);
    const sessionStartCalls = vi
      .mocked(pi.appendEntry)
      .mock.calls.filter(([customType]) => customType === SESSION_START_ENTRY_TYPE);
    expect(sessionStartCalls).toHaveLength(1);
    await fire(hooks, "session_shutdown", ctx);
  });
});

describe("hud auto-fetch (hud.autoFetchMinutes)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** exec mock 调用中参数含 "fetch" 的次数。 */
  const fetchCallCount = (pi: ExtensionAPI): number =>
    vi.mocked(pi.exec).mock.calls.filter(([, args]) => (args as string[]).includes("fetch")).length;

  it("fetches once on session start, then again only after the configured interval", async () => {
    const bus = makeBus();
    const { pi, hooks } = makePi(bus);
    wireHud(pi, { autoFetchMinutes: 5 });
    const ctx = makeCtx("tui");
    await fire(hooks, "session_start", ctx); // 首个 refresh 即补一次 fetch（lastAutoFetchAt=0）
    expect(fetchCallCount(pi)).toBe(1);

    await vi.advanceTimersByTimeAsync(25_000); // 5 个 refresh tick，间隔内不再 fetch
    expect(fetchCallCount(pi)).toBe(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000); // 越过间隔 → 再 fetch 一次
    expect(fetchCallCount(pi)).toBe(2);
    await fire(hooks, "session_shutdown", ctx);
  });

  it("never auto-fetches when autoFetchMinutes is omitted (0 = off)", async () => {
    const bus = makeBus();
    const { pi, hooks } = makePi(bus);
    wireHud(pi);
    const ctx = makeCtx("tui");
    await fire(hooks, "session_start", ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchCallCount(pi)).toBe(0);
    await fire(hooks, "session_shutdown", ctx);
  });

  it("backs off to the next interval after a fetch failure (no 5s hammering while offline)", async () => {
    const bus = makeBus();
    const { pi, hooks } = makePi(bus);
    vi.mocked(pi.exec).mockRejectedValueOnce(new Error("spawn git failed"));
    wireHud(pi, { autoFetchMinutes: 5 });
    const ctx = makeCtx("tui");
    await fire(hooks, "session_start", ctx); // fetch 抛错被静默吞掉，时间戳照记
    expect(fetchCallCount(pi)).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000); // 退避：周期内不重试
    expect(fetchCallCount(pi)).toBe(1);
    await fire(hooks, "session_shutdown", ctx);
  });
});
