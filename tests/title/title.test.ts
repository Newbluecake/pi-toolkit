import { describe, expect, it, vi } from "vitest";
import {
  buildTitlePrompt,
  createTitleTrigger,
  sanitizeTitle,
  TITLE_INPUT_MAX_CHARS,
  TITLE_MAX_CHARS,
  TITLE_MAX_ATTEMPTS,
  TITLE_MAX_TOKENS,
  TITLE_RETRY_DELAY_MS,
  TITLE_TIMEOUT_MS,
  type TitleCompletionRequest,
  type TitleModelRef,
  type TitlePorts,
  type TitleTrigger,
} from "../../src/title/title.js";

/** flush microtasks: 生成是 fire-and-forget，链上每个 await 都是一轮 microtask。 */
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

describe("sanitizeTitle", () => {
  it("collapses whitespace and newlines to single spaces", () => {
    expect(sanitizeTitle("Fix login\n\nbug   on\tmobile")).toBe("Fix login bug on mobile");
  });

  it("strips model label prefixes (标题：/Title:) even under wrappers", () => {
    expect(sanitizeTitle("标题：修复登录超时")).toBe("修复登录超时");
    expect(sanitizeTitle("Title: Ship v2")).toBe("Ship v2");
    expect(sanitizeTitle("**标题：重构数据层**")).toBe("重构数据层");
  });

  it("strips wrapping quotes and markdown emphasis", () => {
    expect(sanitizeTitle('"引号包裹的标题"')).toBe("引号包裹的标题");
    expect(sanitizeTitle("“弯引号标题”")).toBe("弯引号标题");
    expect(sanitizeTitle("`code style`")).toBe("code style");
  });

  it("strips trailing/leading sentence punctuation but keeps interior", () => {
    expect(sanitizeTitle("修复超时。")).toBe("修复超时");
    expect(sanitizeTitle("Ship it!")).toBe("Ship it");
    expect(sanitizeTitle("- 前置破折号 -")).toBe("前置破折号");
    expect(sanitizeTitle("don't break C++")).toBe("don't break C++");
  });

  it("hard-caps at 60 code points, surrogate-safe", () => {
    expect(Array.from(sanitizeTitle("😀".repeat(80))).length).toBe(TITLE_MAX_CHARS);
    const cjk = "字".repeat(61);
    expect(Array.from(sanitizeTitle(cjk)).length).toBe(TITLE_MAX_CHARS);
    expect(sanitizeTitle("字".repeat(30)).length).toBe(30);
  });

  it("returns empty string for junk (caller treats as failure)", () => {
    for (const junk of ["", "   ", "\n\n", "**", "标题：", "Title:", "。。。", "《》"]) {
      expect(sanitizeTitle(junk), JSON.stringify(junk)).toBe("");
    }
  });
});

describe("buildTitlePrompt", () => {
  it("embeds the output contract in the system prompt", () => {
    const { systemPrompt } = buildTitlePrompt("anything");
    expect(systemPrompt).toContain("20 characters");
    expect(systemPrompt).toContain("no punctuation");
    expect(systemPrompt).toContain("no quotes");
  });

  it("truncates the first user message to 2000 code points, surrogate-safe", () => {
    const long = "😀".repeat(TITLE_INPUT_MAX_CHARS + 50) + "tail";
    const { userPrompt } = buildTitlePrompt(long);
    expect(Array.from(userPrompt).length).toBe(TITLE_INPUT_MAX_CHARS);
    // 截断发生在尾部：tail 没进来，且首字符保留。
    expect(Array.from(userPrompt)[0]).toBe("😀");
  });
});

/** 模型句柄哨兵（核心对 M 不透明）。 */
const FLASH = { tag: "flash" } as const;
const SESSION = { tag: "session" } as const;
const REF: TitleModelRef = { provider: "zai-coding-cn", id: "glm-5.3-flash" };

interface Harness {
  trigger: TitleTrigger;
  names: string[]; // setSessionName 调用序抓（非真实状态）
  state: { name?: string };
  findCalls: TitleModelRef[];
  completeCalls: TitleCompletionRequest[];
  sleepCalls: number[];
  complete: ReturnType<typeof vi.fn>;
  session: { key: string }; // 会话身份（sessionKey 端口背后）
}

function makeHarness(
  init: {
    modelRef?: TitleModelRef | null; // null = 不配 ref（空串哨兵路径）
    found?: unknown; // findModel 返回值；不传默认 FLASH，显式传 undefined = 注册表查不到
    current?: unknown; // currentModel 返回值
    initialName?: string;
    nameAfterComplete?: string; // 生成完成后、写入前名字被用户抢先设置
    completeImpl?: (req: TitleCompletionRequest, attempt: number) => string | Promise<string>;
  } = {},
): Harness {
  const state: { name?: string } = { name: init.initialName };
  const session = { key: "session-one" };
  const names: string[] = [];
  const findCalls: TitleModelRef[] = [];
  const completeCalls: TitleCompletionRequest[] = [];
  const sleepCalls: number[] = [];
  const found = "found" in init ? init.found : FLASH;
  let attempt = 0;
  const complete = vi.fn((model: unknown, req: TitleCompletionRequest) => {
    void model; // 核心把模型句柄作第一参传（TitlePorts.complete 签名）
    completeCalls.push(req);
    attempt += 1;
    if (init.completeImpl) return Promise.resolve(init.completeImpl(req, attempt));
    return Promise.resolve("模型生成的标题");
  });
  const ports: TitlePorts<unknown> = {
    getSessionName: () => state.name,
    setSessionName: (name) => {
      names.push(name);
      state.name = name;
    },
    findModel: (ref) => {
      findCalls.push(ref);
      return found;
    },
    currentModel: () => init.current,
    complete: complete as unknown as TitlePorts<unknown>["complete"],
    sleep: (ms) => {
      sleepCalls.push(ms);
      return Promise.resolve();
    },
    timeoutSignal: () => new AbortController().signal,
    sessionKey: () => session.key,
  };
  const trigger = createTitleTrigger(ports, init.modelRef === null ? {} : { modelRef: init.modelRef ?? REF });
  return { trigger, names, state, findCalls, completeCalls, sleepCalls, complete, session };
}

describe("createTitleTrigger", () => {
  it("generates once, sanitizes, and writes the session name", async () => {
    const h = makeHarness({ completeImpl: () => "  **标题：修复登录超时。**  \n" });
    h.trigger.onBeforeAgentStart("帮我修复登录超时的 bug");
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.names).toEqual(["修复登录超时"]);
    expect(h.state.name).toBe("修复登录超时");
  });

  it("passes the built prompt, 512 maxTokens, and a signal through", async () => {
    const h = makeHarness({ found: FLASH });
    h.trigger.onBeforeAgentStart("第一条消息");
    await flush();
    expect(h.findCalls).toEqual([REF]);
    expect(h.completeCalls[0]!.maxTokens).toBe(TITLE_MAX_TOKENS);
    expect(h.completeCalls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(h.completeCalls[0]!.userPrompt).toBe("第一条消息");
    expect(h.completeCalls[0]!.systemPrompt).toContain("session title");
  });

  it("skips silently when the session already has a name (user /name'd or generated)", async () => {
    const h = makeHarness({ initialName: "用户起的名字" });
    h.trigger.onBeforeAgentStart("第一条消息");
    await flush();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.names).toEqual([]);
  });

  it("skips empty prompts without latching the attempt", async () => {
    const h = makeHarness();
    h.trigger.onBeforeAgentStart("   ");
    await flush();
    expect(h.complete).not.toHaveBeenCalled();
    // 闩锁未置位：后续真实消息仍可生成。
    h.trigger.onBeforeAgentStart("真实的第一条");
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it("generates only once per session (latch)", async () => {
    const h = makeHarness();
    h.trigger.onBeforeAgentStart("第一条");
    h.trigger.onBeforeAgentStart("第二条（steer/追问）");
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it("resets the latch on session_start so a fresh unnamed session gets titled", async () => {
    const h = makeHarness({
      completeImpl: (_req, attempt) => {
        if (attempt <= TITLE_MAX_ATTEMPTS) throw new Error("network down"); // 会话一：两次全败
        return "模型生成的标题"; // 会话二：重置闩锁后的首次尝试成功
      },
    });
    h.trigger.onBeforeAgentStart("会话一的第一条");
    await flush();
    expect(h.state.name).toBeUndefined();
    // session_start（new/resume/fork/reload）重置一次性格子。
    h.trigger.onSessionStart();
    h.trigger.onBeforeAgentStart("会话二的第一条");
    await flush();
    expect(h.state.name).toBe("模型生成的标题");
  });

  it("gives up silently after 2 failed attempts (no retry storm, one backoff)", async () => {
    const h = makeHarness({
      completeImpl: () => {
        throw new Error("429");
      },
    });
    h.trigger.onBeforeAgentStart("第一条");
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(TITLE_MAX_ATTEMPTS);
    expect(h.sleepCalls).toEqual([TITLE_RETRY_DELAY_MS]);
    expect(h.names).toEqual([]);
  });

  it("succeeds on the second attempt after one transient failure", async () => {
    const h = makeHarness({
      completeImpl: (_req, attempt) => {
        if (attempt === 1) throw new Error("timeout");
        return "第二次的标题";
      },
    });
    h.trigger.onBeforeAgentStart("第一条");
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(2);
    expect(h.names).toEqual(["第二次的标题"]);
  });

  it("treats sanitize-to-empty output as a failure (2 attempts, no write)", async () => {
    const h = makeHarness({ completeImpl: () => "标题：" });
    h.trigger.onBeforeAgentStart("第一条");
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(TITLE_MAX_ATTEMPTS);
    expect(h.names).toEqual([]);
  });

  it("discards the generated title if the user named the session mid-flight", async () => {
    const h = makeHarness({
      completeImpl: () => {
        // 模拟生成期间用户 /name：complete 返回前名字已落档。
        h.state.name = "用户抢先起的名字";
        return "模型的标题";
      },
    });
    h.trigger.onBeforeAgentStart("第一条");
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.names).toEqual([]);
    expect(h.state.name).toBe("用户抢先起的名字");
  });

  it("discards the generated title if the session switched mid-flight (/new during generation)", async () => {
    const h = makeHarness({
      completeImpl: () => {
        // 模拟生成期间用户 /new：会话身份换了（晚到的标题属于旧会话）。
        h.session.key = "session-two";
        return "旧会话的标题";
      },
    });
    h.trigger.onBeforeAgentStart("第一条");
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.names).toEqual([]);
    expect(h.state.name).toBeUndefined();
  });

  it("falls back to the session model when the configured ref is absent from the registry", async () => {
    const seen: unknown[] = [];
    const state: { name?: string } = {};
    const ports: TitlePorts<unknown> = {
      getSessionName: () => state.name,
      setSessionName: (n) => {
        state.name = n;
      },
      findModel: () => undefined,
      currentModel: () => SESSION,
      complete: (model) => {
        seen.push(model);
        return Promise.resolve("回落生成的标题");
      },
      sleep: () => Promise.resolve(),
      timeoutSignal: () => new AbortController().signal,
      sessionKey: () => "s1",
    };
    const trigger = createTitleTrigger(ports, { modelRef: REF });
    trigger.onBeforeAgentStart("第一条");
    await flush();
    expect(seen).toEqual([SESSION]);
    expect(state.name).toBe("回落生成的标题");
  });

  it("uses the session model directly when no ref is configured (empty-string sentinel)", async () => {
    const h = makeHarness({ modelRef: null, current: SESSION, completeImpl: () => "跟随会话模型" });
    h.trigger.onBeforeAgentStart("第一条");
    await flush();
    expect(h.findCalls).toEqual([]);
    expect(h.state.name).toBe("跟随会话模型");
  });

  it("gives up silently when no model resolves at all", async () => {
    const h = makeHarness({ found: undefined, current: undefined });
    h.trigger.onBeforeAgentStart("第一条");
    await flush();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.names).toEqual([]);
  });

  it("never rejects the fire-and-forget promise even when ports explode", async () => {
    const ports: TitlePorts<unknown> = {
      getSessionName: () => {
        throw new Error("registry exploded");
      },
      setSessionName: () => {
        throw new Error("write failed");
      },
      findModel: () => FLASH,
      currentModel: () => undefined,
      complete: () => Promise.reject(new Error("network")),
      sleep: () => Promise.resolve(),
      timeoutSignal: () => new AbortController().signal,
      sessionKey: () => "s1",
    };
    const trigger = createTitleTrigger(ports, { modelRef: REF });
    expect(() => trigger.onBeforeAgentStart("第一条")).not.toThrow();
    await flush(); // 不产生 unhandled rejection 即通过
  });

  it("pins the spec constants (10s timeout, 2 attempts, 60-char cap, 2000-char input)", () => {
    expect(TITLE_TIMEOUT_MS).toBe(10_000);
    expect(TITLE_MAX_ATTEMPTS).toBe(2);
    expect(TITLE_MAX_CHARS).toBe(60);
    expect(TITLE_INPUT_MAX_CHARS).toBe(2_000);
  });
});
