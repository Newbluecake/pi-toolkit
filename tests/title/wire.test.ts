import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { wireTitle } from "../../src/title/index.js";
import { TITLE_RETRY_DELAY_MS } from "../../src/title/title.js";

/** flush microtasks：生成链是 fire-and-forget。 */
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

interface RecordedHandler {
  event: string;
  handler: (event: never, ctx: unknown) => unknown;
}

function makePi() {
  const handlers: RecordedHandler[] = [];
  const pi = {
    on: vi.fn((event: string, handler: (event: never, ctx: unknown) => unknown) => {
      handlers.push({ event, handler });
    }),
    getSessionName: vi.fn(() => undefined),
    setSessionName: vi.fn(),
  };
  return { pi, handlers };
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

function makeCtx(init: { completeImpl?: (text: string) => string; found?: unknown } = {}) {
  const complete = vi.fn(() => Promise.resolve(assistant(init.completeImpl?.("x") ?? "接线层标题")));
  const ctx = {
    model: undefined,
    modelRegistry: {
      find: vi.fn(() => init.found ?? { provider: "zai-coding-cn", id: "glm-5.3-flash" }),
      complete,
    },
  };
  return { ctx, complete };
}

describe("wireTitle", () => {
  it("registers nothing for child sessions (print mode)", () => {
    const { pi } = makePi();
    const wiring = wireTitle(pi as never, { isChildSession: true, model: "zai-coding-cn/glm-5.3-flash" });
    expect(wiring).toBeUndefined();
    expect(pi.on).not.toHaveBeenCalled();
  });

  it("wires before_agent_start + session_start for the main session", () => {
    const { pi, handlers } = makePi();
    const wiring = wireTitle(pi as never, { isChildSession: false, model: "zai-coding-cn/glm-5.3-flash" });
    expect(wiring).toBeDefined();
    expect(handlers.map((h) => h.event)).toEqual(["before_agent_start", "session_start"]);
  });

  it("generates a title through the registry on the first prompt and writes it back via pi", async () => {
    const { pi, handlers } = makePi();
    const { ctx, complete } = makeCtx();
    wireTitle(pi as never, { isChildSession: false, model: "zai-coding-cn/glm-5.3-flash" });
    const before = handlers.find((h) => h.event === "before_agent_start")!;
    before.handler({ prompt: "帮我修一个登录超时" } as never, ctx);
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);
    // complete 收到 systemPrompt + 单条 user message 的 Context 形状。
    const request = complete.mock.calls[0]![1] as { systemPrompt: string; messages: unknown[] };
    expect(request.systemPrompt).toContain("session title");
    expect(request.messages.length).toBe(1);
    expect((request.messages[0] as { role: string; content: string }).content).toBe("帮我修一个登录超时");
    expect(pi.setSessionName).toHaveBeenCalledWith("接线层标题");
  });

  it("maps completion errors to silent give-up (no write, no throw)", async () => {
    vi.useFakeTimers();
    try {
      const { pi, handlers } = makePi();
      const complete = vi.fn(() => Promise.reject(new Error("429")));
      const ctx = {
        model: undefined,
        modelRegistry: { find: () => ({ provider: "p", id: "m" }), complete },
      };
      wireTitle(pi as never, { isChildSession: false, model: "zai-coding-cn/glm-5.3-flash" });
      const before = handlers.find((h) => h.event === "before_agent_start")!;
      expect(() => before.handler({ prompt: "第一条" } as never, ctx)).not.toThrow();
      await vi.advanceTimersByTimeAsync(0); // 第一次尝试落地
      await vi.advanceTimersByTimeAsync(TITLE_RETRY_DELAY_MS); // 退避后第二次尝试
      expect(complete).toHaveBeenCalledTimes(2); // 两次尝试后静默放弃
      expect(pi.setSessionName).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats an AssistantMessage with errorMessage as a failure", async () => {
    vi.useFakeTimers();
    try {
      const { pi, handlers } = makePi();
      const bad = Object.assign(assistant("never mind"), { errorMessage: "upstream 5xx" });
      const complete = vi.fn(() => Promise.resolve(bad));
      const ctx = {
        model: undefined,
        modelRegistry: { find: () => ({ provider: "p", id: "m" }), complete },
      };
      wireTitle(pi as never, { isChildSession: false, model: "zai-coding-cn/glm-5.3-flash" });
      const before = handlers.find((h) => h.event === "before_agent_start")!;
      before.handler({ prompt: "第一条" } as never, ctx);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(TITLE_RETRY_DELAY_MS);
      // errorMessage 路径：assistantText 抛错 → 两次尝试 → 静默放弃（无写入）。
      expect(complete).toHaveBeenCalledTimes(2);
      expect(pi.setSessionName).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
