/**
 * `/title` 命令（src/title/command.ts）+ 回收记录口径（src/title/records.ts）测试。
 *
 * 线级（wire-level）测试复用 wire.test.ts 的假 pi 模式：fake pi 捕获 registerCommand
 * 注册的命令本体，handler 用假 ExtensionCommandContext（ui.notify + sessionManager）
 * 直接驱动；事件钩子（before_agent_start/agent_end/agent_settled）用带假
 * modelRegistry 的 ctx 驱动，完整走「用户改名 → /title auto → 下一次 settled
 * 无视阈值重新生成 → 回收记录不占刷新额度」的端到端链路。
 */

import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, RegisteredCommand, SessionEntry } from "@earendil-works/pi-coding-agent";
import { wireTitle } from "../../src/title/index.js";
import { isValidTitleRecordData, readTitleRecords, TITLE_RECORD_CUSTOM_TYPE } from "../../src/title/records.js";

/** flush microtasks：生成链是 fire-and-forget。 */
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

interface RecordedHandler {
  event: string;
  handler: (event: never, ctx: unknown) => unknown;
}

function customEntry(id: string, customType: string, data: unknown): SessionEntry {
  return { type: "custom", id, parentId: null, timestamp: "", customType, data } as unknown as SessionEntry;
}

function titleEntry(id: string, data: unknown): SessionEntry {
  return customEntry(id, TITLE_RECORD_CUSTOM_TYPE, data);
}

/** 假 pi：名字/记录有真实状态（setSessionName 改名、appendEntry 追加到 entries）。 */
function makePi() {
  const handlers: RecordedHandler[] = [];
  const entries: SessionEntry[] = [];
  const state = { name: undefined as string | undefined };
  const pi = {
    on: vi.fn((event: string, handler: (event: never, ctx: unknown) => unknown) => {
      handlers.push({ event, handler });
    }),
    getSessionName: vi.fn(() => state.name),
    setSessionName: vi.fn((name: string) => {
      state.name = name;
    }),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      entries.push(customEntry(`e${entries.length + 1}`, customType, data));
    }),
    registerCommand: vi.fn(),
  };
  return { pi, handlers, entries, state };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "zai-coding-cn",
    model: "glm-5.3-flash",
    usage: { input: 10, output: 5 },
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/** 事件钩子 ctx（假 modelRegistry/sessionManager）；completeText 控制本轮生成的标题。 */
function makeEventCtx(entries: SessionEntry[], init: { completeText?: string; sessionId?: string } = {}) {
  const complete = vi.fn(() => Promise.resolve(assistant(init.completeText ?? "生成标题")));
  const ctx = {
    model: undefined,
    modelRegistry: {
      find: vi.fn(() => ({ provider: "zai-coding-cn", id: "glm-5.3-flash" })),
      complete,
    },
    sessionManager: {
      getBranch: vi.fn(() => []),
      getEntries: vi.fn(() => entries),
      getSessionId: vi.fn(() => init.sessionId ?? "s1"),
    },
  };
  return { ctx, complete };
}

/** 命令 handler ctx：捕获 notify，sessionManager 指向共享 entries。 */
function makeCommandCtx(entries: SessionEntry[]) {
  const notify = vi.fn();
  const ctx = {
    ui: { notify },
    sessionManager: { getEntries: vi.fn(() => entries) },
  } as unknown as ExtensionCommandContext;
  return { ctx, notify };
}

function registeredCommand(pi: {
  registerCommand: ReturnType<typeof vi.fn>;
}): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  expect(pi.registerCommand).toHaveBeenCalledWith("title", expect.anything());
  return pi.registerCommand.mock.calls[0]![1] as Omit<RegisteredCommand, "name" | "sourceInfo">;
}

function lastNotify(notify: ReturnType<typeof vi.fn>): { text: string; level: string } {
  const call = notify.mock.calls.at(-1);
  expect(call).toBeDefined();
  return { text: call![0] as string, level: (call![1] as string | undefined) ?? "info" };
}

const DEPS = {
  isChildSession: false,
  enabled: true,
  model: "zai-coding-cn/glm-5.3-flash",
  refreshEveryInputs: 99, // 阈值抬高：只有 one-shot 绕过的刷新才会发生
  refreshAfterMinutes: 0,
  refreshWindowMinutes: 0, // legacy 终身额度口径
  maxRefreshes: 5,
};

describe("records.ts — reclaim record semantics", () => {
  it("old {v:1,name,at} and pre-window {v:1,name} records still parse (back-compat)", () => {
    expect(isValidTitleRecordData({ v: 1, name: "标题", at: 123 })).toBe(true);
    expect(isValidTitleRecordData({ v: 1, name: "标题" })).toBe(true);
    expect(isValidTitleRecordData({ v: 1, name: "标题", at: 1, reclaim: true })).toBe(true);
    expect(isValidTitleRecordData({ v: 1, name: "标题", at: 1, reclaim: "yes" })).toBe(false);
    expect(isValidTitleRecordData({ v: 1, name: "" })).toBe(false);
  });

  it("reclaim records update latestName but never count toward quota or the window", () => {
    const records = readTitleRecords([
      titleEntry("a", { v: 1, name: "首标", at: 1000 }),
      titleEntry("b", { v: 1, name: "用户标题", at: 2000, reclaim: true }),
      titleEntry("c", { v: 1, name: "刷新标题", at: 3000 }),
    ]);
    expect(records.latestName).toBe("刷新标题");
    expect(records.count).toBe(2); // 首标 + 1 次刷新；回收不计数
    expect(records.refreshTimestamps).toEqual([3000]);
  });

  it("a reclaim as the first valid record still restores ownership; the following refresh is the new 'first title'", () => {
    const records = readTitleRecords([
      titleEntry("a", { v: 1, name: "v1 遗留标题", at: 1000, reclaim: true }),
      titleEntry("b", { v: 1, name: "重新生成", at: 2000 }),
    ]);
    expect(records.latestName).toBe("重新生成");
    expect(records.count).toBe(1); // 回收后的首次生成按「首标」口径不占刷新额度
    expect(records.refreshTimestamps).toEqual([]);
  });
});

describe("/title auto — reclaim flow", () => {
  it("reclaim after a user rename: next settled turn regenerates (thresholds bypassed) and the reclaim record consumes no quota", async () => {
    const { pi, handlers, entries, state } = makePi();
    wireTitle(pi as never, DEPS);
    const cmd = registeredCommand(pi);
    const before = handlers.find((h) => h.event === "before_agent_start")!;
    const agentEnd = handlers.find((h) => h.event === "agent_end")!;
    const settled = handlers.find((h) => h.event === "agent_settled")!;
    const okEnd = { messages: [assistant("done")] } as never;

    // 1. 首标自动生成（ unnamed → 生成「自动标题」+ 正常自有记录）。
    const first = makeEventCtx(entries, { completeText: "自动标题" });
    before.handler({ prompt: "帮我修一个登录超时" } as never, first.ctx);
    await flush();
    expect(state.name).toBe("自动标题");
    expect(entries.length).toBe(1);

    // 2. 用户 /name 改名（无自有记录）⇒ 用户所有，settled 不再自动刷新。
    state.name = "用户标题";
    agentEnd.handler(okEnd, undefined);
    const beforeReclaim = makeEventCtx(entries, { completeText: "不应生成" });
    settled.handler({} as never, beforeReclaim.ctx);
    await flush();
    expect(beforeReclaim.complete).not.toHaveBeenCalled();

    // 3. /title auto：追加回收记录（name = 当前名字 + reclaim:true）并武装 one-shot 绕过。
    const cmdCtx = makeCommandCtx(entries);
    await cmd.handler("auto", cmdCtx.ctx);
    expect(lastNotify(cmdCtx.notify).text).toContain("已恢复自动生成标题");
    expect(entries.length).toBe(2);
    expect(entries[1]).toMatchObject({
      customType: TITLE_RECORD_CUSTOM_TYPE,
      data: { v: 1, name: "用户标题", reclaim: true },
    });

    // 4. 下一轮（before_agent_start → agent_end → agent_settled）：尽管 refreshEveryInputs=99
    //    远未达到，绕过标志让刷新照常发生；生成后登记正常自有记录（不带 reclaim）。
    const next = makeEventCtx(entries, { completeText: "刷新后的标题" });
    before.handler({ prompt: "再改一下重试逻辑" } as never, next.ctx);
    agentEnd.handler(okEnd, undefined);
    settled.handler({} as never, next.ctx);
    await flush();
    expect(next.complete).toHaveBeenCalledTimes(1);
    expect(state.name).toBe("刷新后的标题");
    expect(entries.length).toBe(3);
    expect(entries[2]).toMatchObject({ customType: TITLE_RECORD_CUSTOM_TYPE, data: { v: 1, name: "刷新后的标题" } });
    expect((entries[2] as unknown as { data: { reclaim?: boolean } }).data.reclaim).toBeUndefined();

    // 5. 额度口径：回收记录不计数（count = 首标 1 + 刷新 1 = 2，不是 3）。
    expect(readTitleRecords(entries).count).toBe(2);
  });

  it("reclaim is a one-shot bypass: the turn after the forced refresh obeys thresholds again", async () => {
    const { pi, handlers, entries, state } = makePi();
    wireTitle(pi as never, DEPS);
    const cmd = registeredCommand(pi);
    const before = handlers.find((h) => h.event === "before_agent_start")!;
    const agentEnd = handlers.find((h) => h.event === "agent_end")!;
    const settled = handlers.find((h) => h.event === "agent_settled")!;
    const okEnd = { messages: [assistant("done")] } as never;

    const first = makeEventCtx(entries, { completeText: "自动标题" });
    before.handler({ prompt: "初始需求" } as never, first.ctx);
    await flush();
    state.name = "用户标题";
    await cmd.handler("auto", makeCommandCtx(entries).ctx);

    const next = makeEventCtx(entries, { completeText: "刷新标题" });
    before.handler({ prompt: "继续" } as never, next.ctx);
    agentEnd.handler(okEnd, undefined);
    settled.handler({} as never, next.ctx);
    await flush();
    expect(next.complete).toHaveBeenCalledTimes(1); // 绕过已消耗

    // 再一轮：阈值（99 条输入）未到 ⇒ 不再刷新。
    agentEnd.handler(okEnd, undefined);
    const third = makeEventCtx(entries, { completeText: "不应生成" });
    settled.handler({} as never, third.ctx);
    await flush();
    expect(third.complete).not.toHaveBeenCalled();
  });

  it("already auto-owned: still arms a forced refresh and says so", async () => {
    const { pi, handlers, entries, state } = makePi();
    wireTitle(pi as never, DEPS);
    const cmd = registeredCommand(pi);
    const before = handlers.find((h) => h.event === "before_agent_start")!;
    const first = makeEventCtx(entries, { completeText: "自动标题" });
    before.handler({ prompt: "初始需求" } as never, first.ctx);
    await flush();
    expect(state.name).toBe("自动标题");

    const cmdCtx = makeCommandCtx(entries);
    await cmd.handler("auto", cmdCtx.ctx);
    expect(lastNotify(cmdCtx.notify).text).toContain("已是自动生成状态");
    // 回收记录照写（幂等，name 相同），不占额度。
    expect(readTitleRecords(entries).count).toBe(1);
  });

  it("unnamed session: no reclaim record, first title stays eligible", async () => {
    const { pi, entries } = makePi();
    wireTitle(pi as never, DEPS);
    const cmd = registeredCommand(pi);
    const cmdCtx = makeCommandCtx(entries);
    await cmd.handler("auto", cmdCtx.ctx);
    expect(lastNotify(cmdCtx.notify).text).toContain("尚未命名");
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("in-flight generation: auto refuses without writing a record or arming the bypass", async () => {
    const { pi, handlers, entries, state } = makePi();
    wireTitle(pi as never, DEPS);
    const cmd = registeredCommand(pi);
    const before = handlers.find((h) => h.event === "before_agent_start")!;
    const agentEnd = handlers.find((h) => h.event === "agent_end")!;
    const settled = handlers.find((h) => h.event === "agent_settled")!;

    // 让生成挂起（complete 永不 resolve）⇒ inFlight 期间 /title auto 必须拒绝。
    const hanging = makeEventCtx(entries);
    hanging.complete.mockImplementation(() => new Promise(() => {}));
    before.handler({ prompt: "挂起的首轮" } as never, hanging.ctx);

    const cmdCtx = makeCommandCtx(entries);
    await cmd.handler("auto", cmdCtx.ctx);
    const msg = lastNotify(cmdCtx.notify);
    expect(msg.level).toBe("warning");
    expect(msg.text).toContain("进行中");
    expect(pi.appendEntry).not.toHaveBeenCalled();

    // 绕过后续也未武装：结算一个不挂起的回合也不应刷新（且此时仍未命名，首标路径）。
    expect(state.name).toBeUndefined();
    agentEnd.handler({ messages: [assistant("done")] } as never, undefined);
    const after = makeEventCtx(entries);
    settled.handler({} as never, after.ctx);
    await flush();
    expect(after.complete).not.toHaveBeenCalled();
  });

  it("disabled (title.enabled=false): auto refuses with a disabled notice and writes nothing", async () => {
    const { pi, entries } = makePi();
    wireTitle(pi as never, { ...DEPS, enabled: false });
    const cmd = registeredCommand(pi);
    const cmdCtx = makeCommandCtx(entries);
    await cmd.handler("auto", cmdCtx.ctx);
    const msg = lastNotify(cmdCtx.notify);
    expect(msg.level).toBe("warning");
    expect(msg.text).toContain("已禁用");
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("unknown subcommand prints usage as a warning", async () => {
    const { pi, entries } = makePi();
    wireTitle(pi as never, DEPS);
    const cmd = registeredCommand(pi);
    const cmdCtx = makeCommandCtx(entries);
    await cmd.handler("wat", cmdCtx.ctx);
    const msg = lastNotify(cmdCtx.notify);
    expect(msg.level).toBe("warning");
    expect(msg.text).toContain("用法");
  });
});

describe("/title status", () => {
  it("auto-owned session: enabled, name, owner=auto, quota and input progress", async () => {
    const { pi, handlers, entries, state } = makePi();
    wireTitle(pi as never, { ...DEPS, maxRefreshes: 5 });
    const cmd = registeredCommand(pi);
    const before = handlers.find((h) => h.event === "before_agent_start")!;
    const first = makeEventCtx(entries, { completeText: "自动标题" });
    before.handler({ prompt: "初始需求" } as never, first.ctx);
    await flush();

    const cmdCtx = makeCommandCtx(entries);
    await cmd.handler("", cmdCtx.ctx);
    const { text } = lastNotify(cmdCtx.notify);
    expect(text).toContain("标题自动生成：开启");
    expect(text).toContain(`当前标题：${state.name}`);
    expect(text).toContain("归属：自动生成");
    expect(text).toContain("刷新额度：已用 0/5（终身）");
    expect(text).toContain("已积累 0/99 条输入"); // 生成成功后基线前移
  });

  it("user-owned session (renamed after first title): owner=user with the /title auto hint", async () => {
    const { pi, handlers, entries, state } = makePi();
    wireTitle(pi as never, DEPS);
    const cmd = registeredCommand(pi);
    const before = handlers.find((h) => h.event === "before_agent_start")!;
    const first = makeEventCtx(entries, { completeText: "自动标题" });
    before.handler({ prompt: "初始需求" } as never, first.ctx);
    await flush();
    state.name = "用户标题"; // 用户改名，无自有记录

    const cmdCtx = makeCommandCtx(entries);
    await cmd.handler("status", cmdCtx.ctx);
    const { text } = lastNotify(cmdCtx.notify);
    expect(text).toContain("归属：用户所有");
    expect(text).toContain("/title auto");
  });

  it("unnamed session: owner=none", async () => {
    const { pi, entries } = makePi();
    wireTitle(pi as never, DEPS);
    const cmd = registeredCommand(pi);
    const cmdCtx = makeCommandCtx(entries);
    await cmd.handler("status", cmdCtx.ctx);
    const { text } = lastNotify(cmdCtx.notify);
    expect(text).toContain("当前标题：（未命名）");
    expect(text).toContain("归属：无");
  });

  it("window mode reports in-window usage; reclaim records never inflate it", async () => {
    const now = Date.now();
    const { pi, entries } = makePi();
    // 预置历史：首标 + 窗口内 1 次刷新 + 窗口外 1 次刷新 + 1 条回收。
    entries.push(
      titleEntry("a", { v: 1, name: "首标", at: now - 10 * 60_000 }),
      titleEntry("b", { v: 1, name: "刷新1", at: now - 120 * 60_000 }), // 60 分钟窗口外
      titleEntry("c", { v: 1, name: "刷新2", at: now - 5 * 60_000 }),
      titleEntry("d", { v: 1, name: "刷新2", at: now - 60_000, reclaim: true }),
    );
    pi.getSessionName = vi.fn(() => "刷新2");
    wireTitle(pi as never, { ...DEPS, refreshWindowMinutes: 60, maxRefreshes: 3 });
    const cmd = registeredCommand(pi);
    const cmdCtx = makeCommandCtx(entries);
    await cmd.handler("status", cmdCtx.ctx);
    const { text } = lastNotify(cmdCtx.notify);
    expect(text).toContain("60 分钟窗口内已用 1/3");
    expect(text).toContain("归属：自动生成");
  });

  it("disabled (title.enabled=false): status says so and shows no live counters", async () => {
    const { pi, entries } = makePi();
    wireTitle(pi as never, { ...DEPS, enabled: false });
    const cmd = registeredCommand(pi);
    const cmdCtx = makeCommandCtx(entries);
    await cmd.handler("status", cmdCtx.ctx);
    const { text } = lastNotify(cmdCtx.notify);
    expect(text).toContain("标题自动生成：关闭");
    expect(text).toContain("title.enabled=false");
  });

  it("maxRefreshes=0 renders the closed-quota line", async () => {
    const { pi, entries } = makePi();
    wireTitle(pi as never, { ...DEPS, maxRefreshes: 0 });
    const cmd = registeredCommand(pi);
    const cmdCtx = makeCommandCtx(entries);
    await cmd.handler("status", cmdCtx.ctx);
    expect(lastNotify(cmdCtx.notify).text).toContain("刷新额度：已关闭");
  });
});

describe("/title completions", () => {
  it("offers auto/status with Chinese descriptions, filtered by prefix", () => {
    const { pi } = makePi();
    wireTitle(pi as never, DEPS);
    const cmd = registeredCommand(pi);
    const all = cmd.getArgumentCompletions?.("");
    expect(all).toEqual([
      { value: "auto", label: "auto", description: "恢复自动生成标题" },
      { value: "status", label: "status", description: "查看标题自动生成状态" },
    ]);
    expect(cmd.getArgumentCompletions?.("a")).toEqual([
      { value: "auto", label: "auto", description: "恢复自动生成标题" },
    ]);
    expect(cmd.getArgumentCompletions?.("x")).toEqual([]);
    expect(cmd.description).toContain("标题");
  });
});
