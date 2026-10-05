import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { wireTitle } from "../../src/title/index.js";
import { TITLE_RETRY_DELAY_MS } from "../../src/title/title.js";

/** flush microtasks：生成链是 fire-and-forget。 */
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

interface RecordedHandler {
  event: string;
  handler: (event: never, ctx: unknown) => unknown;
}

function makePi() {
  const handlers: RecordedHandler[] = [];
  const appendEntry = vi.fn();
  const pi = {
    on: vi.fn((event: string, handler: (event: never, ctx: unknown) => unknown) => {
      handlers.push({ event, handler });
    }),
    getSessionName: vi.fn(() => undefined as string | undefined),
    setSessionName: vi.fn(),
    appendEntry,
  };
  return { pi, handlers, appendEntry };
}

function assistant(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "zai-coding-cn",
    model: "glm-5.3-flash",
    usage: { input: 10, output: 5 },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  } as unknown as AssistantMessage;
}

function userMessageEntry(id: string, content: unknown) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content, timestamp: 0 } };
}

function assistantMessageEntry(id: string, message: AssistantMessage) {
  return { type: "message", id, parentId: null, timestamp: "", message };
}

function customTitleEntry(id: string, data: unknown) {
  return { type: "custom", id, parentId: null, timestamp: "", customType: "subagent:title", data };
}

function makeCtx(
  init: {
    completeImpl?: (text: string) => string;
    found?: unknown;
    branch?: unknown[];
    entries?: unknown[];
    sessionId?: string;
  } = {},
) {
  const complete = vi.fn(() => Promise.resolve(assistant(init.completeImpl?.("x") ?? "接线层标题")));
  const ctx = {
    model: undefined,
    modelRegistry: {
      find: vi.fn(() => init.found ?? { provider: "zai-coding-cn", id: "glm-5.3-flash" }),
      complete,
    },
    sessionManager: {
      getBranch: vi.fn(() => init.branch ?? []),
      getEntries: vi.fn(() => init.entries ?? []),
      getSessionId: vi.fn(() => init.sessionId ?? "s1"),
    },
  };
  return { ctx, complete };
}

const DEPS = {
  isChildSession: false,
  model: "zai-coding-cn/glm-5.3-flash",
  refreshEveryInputs: 4,
  refreshAfterMinutes: 15,
  maxRefreshes: 5,
};

describe("wireTitle — registration", () => {
  it("registers nothing for child sessions (print mode)", () => {
    const { pi } = makePi();
    const wiring = wireTitle(pi as never, { ...DEPS, isChildSession: true });
    expect(wiring).toBeUndefined();
    expect(pi.on).not.toHaveBeenCalled();
  });

  it("wires before_agent_start + agent_end + agent_settled + session_start + session_shutdown", () => {
    const { pi, handlers } = makePi();
    const wiring = wireTitle(pi as never, DEPS);
    expect(wiring).toBeDefined();
    expect(handlers.map((h) => h.event)).toEqual([
      "before_agent_start",
      "agent_end",
      "agent_settled",
      "session_start",
      "session_shutdown",
    ]);
  });
});

describe("wireTitle — first title generation", () => {
  it("generates a title through the registry on the first prompt and writes it back via pi", async () => {
    const { pi, handlers, appendEntry } = makePi();
    const { ctx, complete } = makeCtx();
    wireTitle(pi as never, DEPS);
    const before = handlers.find((h) => h.event === "before_agent_start")!;
    before.handler({ prompt: "帮我修一个登录超时" } as never, ctx);
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0]![1] as { systemPrompt: string; messages: unknown[] };
    expect(request.systemPrompt).toContain("session title");
    expect(request.messages.length).toBe(1);
    expect((request.messages[0] as { role: string; content: string }).content).toContain("帮我修一个登录超时");
    expect(pi.setSessionName).toHaveBeenCalledWith("接线层标题");
    expect(appendEntry).toHaveBeenCalledWith("subagent:title", expect.objectContaining({ v: 1, name: "接线层标题" }));
  });

  it("includes branch's existing user messages (string content) alongside the current prompt", async () => {
    const { pi, handlers } = makePi();
    const { ctx, complete } = makeCtx({ branch: [userMessageEntry("1", "既有的用户消息")] });
    wireTitle(pi as never, DEPS);
    const before = handlers.find((h) => h.event === "before_agent_start")!;
    before.handler({ prompt: "本次消息" } as never, ctx);
    await flush();
    const request = complete.mock.calls[0]![1] as { messages: { content: string }[] };
    expect(request.messages[0]!.content).toContain("既有的用户消息");
    expect(request.messages[0]!.content).toContain("本次消息");
  });

  it("extracts array-shaped user message content (text blocks) and skips image-only messages", async () => {
    const { pi, handlers } = makePi();
    const { ctx, complete } = makeCtx({
      branch: [
        userMessageEntry("1", [{ type: "text", text: "数组形式的文本块" }]),
        userMessageEntry("2", [{ type: "image", data: "base64...", mimeType: "image/png" }]),
      ],
    });
    wireTitle(pi as never, DEPS);
    const before = handlers.find((h) => h.event === "before_agent_start")!;
    before.handler({ prompt: "本次消息" } as never, ctx);
    await flush();
    const request = complete.mock.calls[0]![1] as { messages: { content: string }[] };
    expect(request.messages[0]!.content).toContain("数组形式的文本块");
    // 图片-only 消息不应该产生一条额外的空输入（不会在 prompt 里出现空行）。
    expect(request.messages[0]!.content).not.toMatch(/-\s*\n-/);
  });

  it("maps completion errors to silent give-up (no write, no throw)", async () => {
    vi.useFakeTimers();
    try {
      const { pi, handlers } = makePi();
      const complete = vi.fn(() => Promise.reject(new Error("429")));
      const ctx = {
        model: undefined,
        modelRegistry: { find: () => ({ provider: "p", id: "m" }), complete },
        sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => "s1" },
      };
      wireTitle(pi as never, DEPS);
      const before = handlers.find((h) => h.event === "before_agent_start")!;
      expect(() => before.handler({ prompt: "第一条" } as never, ctx)).not.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(TITLE_RETRY_DELAY_MS);
      expect(complete).toHaveBeenCalledTimes(2);
      expect(pi.setSessionName).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats an AssistantMessage with errorMessage as a failure", async () => {
    vi.useFakeTimers();
    try {
      const { pi, handlers } = makePi();
      const bad = assistant("never mind", { errorMessage: "upstream 5xx" });
      const complete = vi.fn(() => Promise.resolve(bad));
      const ctx = {
        model: undefined,
        modelRegistry: { find: () => ({ provider: "p", id: "m" }), complete },
        sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => "s1" },
      };
      wireTitle(pi as never, DEPS);
      const before = handlers.find((h) => h.event === "before_agent_start")!;
      before.handler({ prompt: "第一条" } as never, ctx);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(TITLE_RETRY_DELAY_MS);
      expect(complete).toHaveBeenCalledTimes(2);
      expect(pi.setSessionName).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("wireTitle — refresh via agent_end/agent_settled", () => {
  it("refreshes after N inputs, carrying ownership record forward and extracting the assistant excerpt", async () => {
    const { pi, handlers, appendEntry } = makePi();
    pi.getSessionName.mockReturnValue("旧标题");
    const branch = [
      userMessageEntry("1", "第一条"),
      assistantMessageEntry("2", assistant("第一条回复")),
      userMessageEntry("3", "第二条"),
      assistantMessageEntry("4", assistant("最新的回复摘录")),
    ];
    const entries = [customTitleEntry("x", { v: 1, name: "旧标题", at: 1 })];
    const { ctx, complete } = makeCtx({ branch, entries, completeImpl: () => "刷新后的新标题" });
    wireTitle(pi as never, { ...DEPS, refreshEveryInputs: 1, refreshAfterMinutes: 0 });
    const before = handlers.find((h) => h.event === "before_agent_start")!;
    const end = handlers.find((h) => h.event === "agent_end")!;
    const settled = handlers.find((h) => h.event === "agent_settled")!;
    before.handler({ prompt: "第二条" } as never, ctx);
    end.handler({ messages: [assistant("最新的回复摘录")] } as never, ctx);
    settled.handler({} as never, ctx);
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0]![1] as { messages: { content: string }[] };
    expect(request.messages[0]!.content).toContain("Current title: 旧标题");
    expect(request.messages[0]!.content).toContain("最新的回复摘录");
    expect(pi.setSessionName).toHaveBeenCalledWith("刷新后的新标题");
    expect(appendEntry).toHaveBeenCalledWith(
      "subagent:title",
      expect.objectContaining({ v: 1, name: "刷新后的新标题" }),
    );
  });

  it("agent_end(aborted) blocks the following agent_settled from refreshing", async () => {
    const { pi, handlers } = makePi();
    pi.getSessionName.mockReturnValue("旧标题");
    const entries = [customTitleEntry("x", { v: 1, name: "旧标题", at: 1 })];
    const { ctx, complete } = makeCtx({ entries });
    wireTitle(pi as never, { ...DEPS, refreshEveryInputs: 1, refreshAfterMinutes: 0 });
    const before = handlers.find((h) => h.event === "before_agent_start")!;
    const end = handlers.find((h) => h.event === "agent_end")!;
    const settled = handlers.find((h) => h.event === "agent_settled")!;
    before.handler({ prompt: "输入" } as never, ctx);
    end.handler({ messages: [assistant("x", { stopReason: "aborted" })] } as never, ctx);
    settled.handler({} as never, ctx);
    await flush();
    expect(complete).not.toHaveBeenCalled();
  });

  it("skips non-matching/invalid custom entries when reading title records (illegal records ignored)", async () => {
    const { pi, handlers } = makePi();
    pi.getSessionName.mockReturnValue("旧标题");
    const entries = [
      customTitleEntry("a", { v: 1, name: "", at: 1 }), // 空名字，非法
      customTitleEntry("b", { v: 2, name: "旧标题", at: 1 }), // v 不对，非法
      { type: "custom", id: "c", parentId: null, timestamp: "", customType: "other:thing", data: { v: 1 } }, // 不同 customType
      customTitleEntry("d", { v: 1, name: "旧标题", at: 1 }), // 唯一合法记录
    ];
    const { ctx, complete } = makeCtx({ entries, completeImpl: () => "刷新成功" });
    wireTitle(pi as never, { ...DEPS, refreshEveryInputs: 1, refreshAfterMinutes: 0 });
    const before = handlers.find((h) => h.event === "before_agent_start")!;
    const end = handlers.find((h) => h.event === "agent_end")!;
    const settled = handlers.find((h) => h.event === "agent_settled")!;
    before.handler({ prompt: "输入" } as never, ctx);
    end.handler({ messages: [assistant("ok")] } as never, ctx);
    settled.handler({} as never, ctx);
    await flush();
    // 唯一合法记录名字与当前名字一致 ⇒ 自有，可以刷新。
    expect(complete).toHaveBeenCalledTimes(1);
    expect(pi.setSessionName).toHaveBeenCalledWith("刷新成功");
  });

  it("user-owned title (no matching record) never triggers a refresh request", async () => {
    const { pi, handlers } = makePi();
    pi.getSessionName.mockReturnValue("用户 /name 的标题");
    const entries: unknown[] = []; // 无任何自有记录
    const { ctx, complete } = makeCtx({ entries });
    wireTitle(pi as never, { ...DEPS, refreshEveryInputs: 1, refreshAfterMinutes: 0 });
    const before = handlers.find((h) => h.event === "before_agent_start")!;
    const end = handlers.find((h) => h.event === "agent_end")!;
    const settled = handlers.find((h) => h.event === "agent_settled")!;
    before.handler({ prompt: "输入" } as never, ctx);
    end.handler({ messages: [assistant("ok")] } as never, ctx);
    settled.handler({} as never, ctx);
    await flush();
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not fall back to an earlier normal assistant reply when the branch's most recent assistant message errored (#3b: no-fallback semantics, verifier-confirmed)", async () => {
    const { pi, handlers } = makePi();
    pi.getSessionName.mockReturnValue("旧标题");
    const entries = [customTitleEntry("x", { v: 1, name: "旧标题", at: 1 })];
    // branch 里最后一条消息是带 errorMessage 的 assistant；在它之前还有一条正常的 assistant 回复。
    // 按 r1 字面口径（verifier 确认）：只看最后一条，不合格就省略，不回退找更早的。
    const branch = [
      userMessageEntry("1", "第一条"),
      assistantMessageEntry("2", assistant("更早的正常回复")),
      userMessageEntry("3", "第二条"),
      assistantMessageEntry("4", assistant("出错的回复", { errorMessage: "upstream 5xx" })),
    ];
    const { ctx, complete } = makeCtx({ branch, entries, completeImpl: () => "刷新成功" });
    wireTitle(pi as never, { ...DEPS, refreshEveryInputs: 1, refreshAfterMinutes: 0 });
    const before = handlers.find((h) => h.event === "before_agent_start")!;
    const end = handlers.find((h) => h.event === "agent_end")!;
    const settled = handlers.find((h) => h.event === "agent_settled")!;
    before.handler({ prompt: "第二条" } as never, ctx);
    // agent_end 的判定走它自己的 event.messages（设为本轮正常收尾，不影响刷新门检），
    // 与 branch 里持久化的最后一条解耦——专门隔离出摘录提取逻辑本身。
    end.handler({ messages: [assistant("本轮真的成功收尾")] } as never, ctx);
    settled.handler({} as never, ctx);
    await flush();
    expect(complete).toHaveBeenCalledTimes(1); // 刷新确实触发了
    const request = complete.mock.calls[0]![1] as { messages: { content: string }[] };
    expect(request.messages[0]!.content).not.toContain("更早的正常回复"); // 不回退
    expect(request.messages[0]!.content).not.toContain("Latest assistant reply"); // 整段摘录被省略
  });

  it.each(["aborted", "error"] as const)(
    "omits the assistant excerpt when the branch's most recent assistant message has stopReason %s",
    async (stopReason) => {
      const { pi, handlers } = makePi();
      pi.getSessionName.mockReturnValue("旧标题");
      const entries = [customTitleEntry("x", { v: 1, name: "旧标题", at: 1 })];
      const branch = [
        userMessageEntry("1", "第一条"),
        assistantMessageEntry("2", assistant("更早的正常回复")),
        userMessageEntry("3", "第二条"),
        assistantMessageEntry("4", assistant("被中断的回复", { stopReason })),
      ];
      const { ctx, complete } = makeCtx({ branch, entries, completeImpl: () => "刷新成功" });
      wireTitle(pi as never, { ...DEPS, refreshEveryInputs: 1, refreshAfterMinutes: 0 });
      const before = handlers.find((h) => h.event === "before_agent_start")!;
      const end = handlers.find((h) => h.event === "agent_end")!;
      const settled = handlers.find((h) => h.event === "agent_settled")!;
      before.handler({ prompt: "第二条" } as never, ctx);
      end.handler({ messages: [assistant("本轮真的成功收尾")] } as never, ctx);
      settled.handler({} as never, ctx);
      await flush();
      expect(complete).toHaveBeenCalledTimes(1);
      const request = complete.mock.calls[0]![1] as { messages: { content: string }[] };
      expect(request.messages[0]!.content).not.toContain("被中断的回复");
      expect(request.messages[0]!.content).not.toContain("更早的正常回复");
      expect(request.messages[0]!.content).not.toContain("Latest assistant reply");
    },
  );

  it("binds completion/model/sessionKey to the triggering event's own ctx — a later event's ctx never leaks into an in-flight retry (#1 regression)", async () => {
    vi.useFakeTimers();
    try {
      const { pi, handlers } = makePi();
      const complete1 = vi
        .fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce(assistant("来自触发时 ctx 的标题"));
      const ctx1 = {
        model: undefined,
        modelRegistry: { find: () => ({ provider: "p", id: "m1" }), complete: complete1 },
        sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => "s1" },
      };
      const complete2 = vi.fn(() => Promise.resolve(assistant("不应该被用到的标题")));
      const ctx2 = {
        model: undefined,
        modelRegistry: { find: () => ({ provider: "p", id: "m2" }), complete: complete2 },
        sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => "s2" },
      };
      wireTitle(pi as never, DEPS);
      const before = handlers.find((h) => h.event === "before_agent_start")!;
      const settled = handlers.find((h) => h.event === "agent_settled")!;

      before.handler({ prompt: "第一条" } as never, ctx1); // 首标：attempt 1 失败，进入退避
      await vi.advanceTimersByTimeAsync(0);
      expect(complete1).toHaveBeenCalledTimes(1);

      // 退避期间来了一个完全不同的 ctx——agent_settled handler 内部会先 ctxRef.current = ctx2
      // （这正是本测试要钉死的回归点：若仍走共享 ctxRef，下面的第二次尝试会错误地用上
      // ctx2.modelRegistry）。由于未命名且没有有效记录，这个 settled 本身不会触发第二次生成
      // （互斥/未命名门检都会拦下来），但对 ctxRef 的写入会实际发生。
      settled.handler({} as never, ctx2);

      await vi.advanceTimersByTimeAsync(TITLE_RETRY_DELAY_MS); // 第二次尝试
      expect(complete1).toHaveBeenCalledTimes(2); // 第二次尝试仍用 ctx1 的 complete
      expect(complete2).not.toHaveBeenCalled(); // ctx2 的 complete 完全没被调用
      expect(pi.setSessionName).toHaveBeenCalledWith("来自触发时 ctx 的标题");
    } finally {
      vi.useRealTimers();
    }
  });
});
