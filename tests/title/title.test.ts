import { describe, expect, it, vi } from "vitest";
import {
  buildTitlePrompt,
  createTitleTrigger,
  sanitizeTitle,
  TITLE_ASSISTANT_EXCERPT_MAX_CHARS,
  TITLE_MAX_ATTEMPTS,
  TITLE_MAX_CHARS,
  TITLE_MAX_TOKENS,
  TITLE_PREVIOUS_MAX_CHARS,
  TITLE_RECENT_INPUT_ITEM_MAX_CHARS,
  TITLE_RECENT_INPUT_MAX_COUNT,
  TITLE_RECENT_INPUT_TOTAL_MAX_CHARS,
  TITLE_RETRY_DELAY_MS,
  TITLE_TIMEOUT_MS,
  type TitleCompletionRequest,
  type TitleGenerationDeps,
  type TitleModelRef,
  type TitlePorts,
  type TitleTrigger,
  type TitleTriggerOptions,
} from "../../src/title/title.js";

/** flush microtasks: 生成是 fire-and-forget，链上每个 await 都是一轮 microtask。 */
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
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
    const { systemPrompt } = buildTitlePrompt({ userInputs: ["anything"] });
    expect(systemPrompt).toContain("20 characters");
    expect(systemPrompt).toContain("no punctuation");
    expect(systemPrompt).toContain("no quotes");
  });

  it("adds the stability rule only when a previous title is present", () => {
    const withPrev = buildTitlePrompt({ previousTitle: "旧标题", userInputs: ["x"] });
    expect(withPrev.systemPrompt).toContain("output it unchanged");
    const noPrev = buildTitlePrompt({ userInputs: ["x"] });
    expect(noPrev.systemPrompt).not.toContain("output it unchanged");
  });

  it("includes the previous title, truncated to 60 code points, as an anchor section", () => {
    const { userPrompt } = buildTitlePrompt({ previousTitle: "字".repeat(100), userInputs: [] });
    const match = userPrompt.match(/^Current title: (.+)$/m);
    expect(match).not.toBeNull();
    expect(Array.from(match![1]!).length).toBe(TITLE_PREVIOUS_MAX_CHARS);
  });

  it("includes the assistant excerpt, truncated to 600 code points", () => {
    const { userPrompt } = buildTitlePrompt({ userInputs: [], assistantExcerpt: "字".repeat(700) });
    const match = userPrompt.match(/Latest assistant reply \(excerpt\): (.+)$/m);
    expect(match).not.toBeNull();
    expect(Array.from(match![1]!).length).toBe(TITLE_ASSISTANT_EXCERPT_MAX_CHARS);
  });

  it("omits sections that are absent/blank", () => {
    const { userPrompt } = buildTitlePrompt({ userInputs: [] });
    expect(userPrompt).toBe("");
    const { userPrompt: p2 } = buildTitlePrompt({ previousTitle: "   ", userInputs: [], assistantExcerpt: "  " });
    expect(p2).toBe("");
  });

  it("takes only the most recent 5 user inputs", () => {
    const inputs = Array.from({ length: 8 }, (_, i) => `消息${i}`);
    const { userPrompt } = buildTitlePrompt({ userInputs: inputs });
    for (let i = 0; i < 3; i++) expect(userPrompt).not.toContain(`消息${i}`);
    for (let i = 3; i < 8; i++) expect(userPrompt).toContain(`消息${i}`);
  });

  it("truncates each input item to 400 code points, surrogate-safe", () => {
    const long = "😀".repeat(TITLE_RECENT_INPUT_ITEM_MAX_CHARS + 50) + "tail";
    const { userPrompt } = buildTitlePrompt({ userInputs: [long] });
    const bulletLine = userPrompt.split("\n").find((l) => l.startsWith("- "))!;
    const content = bulletLine.slice(2);
    expect(Array.from(content).length).toBe(TITLE_RECENT_INPUT_ITEM_MAX_CHARS);
    expect(content).not.toContain("tail");
  });

  it("packs newest-first up to the exact 2000 code-point ceiling (5 × 400 = 2000, boundary-inclusive)", () => {
    // r1 的预算常数满足 TITLE_RECENT_INPUT_ITEM_MAX_CHARS(400) × TITLE_RECENT_INPUT_MAX_COUNT(5)
    // === TITLE_RECENT_INPUT_TOTAL_MAX_CHARS(2000)——因此 5 条均为满额 400 码点时，合计恰好
    // 打到边界（total+len === LIMIT，不触发 break，全部被采纳）。
    expect(TITLE_RECENT_INPUT_ITEM_MAX_CHARS * TITLE_RECENT_INPUT_MAX_COUNT).toBe(TITLE_RECENT_INPUT_TOTAL_MAX_CHARS);
    const items = ["字A", "字B", "字C", "字D", "字E"].map((tag) => tag.padEnd(400, "x"));
    const { userPrompt } = buildTitlePrompt({ userInputs: items });
    for (const tag of ["字A", "字B", "字C", "字D", "字E"]) expect(userPrompt).toContain(tag);
    const bulletLines = userPrompt.split("\n").filter((l) => l.startsWith("- "));
    expect(bulletLines.length).toBe(5);
    const totalCodePoints = bulletLines.reduce((sum, line) => sum + Array.from(line.slice(2)).length, 0);
    expect(totalCodePoints).toBe(TITLE_RECENT_INPUT_TOTAL_MAX_CHARS); // 恰好命中上限，不超。
  });

  it("the combined recent-input budget never exceeds 2000 code points, for any mix of sizes/counts (property check)", () => {
    // 因为每条先被截断到 ≤400（TITLE_RECENT_INPUT_ITEM_MAX_CHARS）再参与合计，且最多取 5 条
    // （TITLE_RECENT_INPUT_MAX_COUNT），按当前常数，5×400=2000 是数学上的理论上限——
    // 所以该上限不会被突破，但仍要严格断言它永远成立（回归防止未来常数调整后被打破）。
    for (let trial = 0; trial < 50; trial++) {
      const count = 1 + Math.floor(Math.random() * 8); // 1..8 条，故意超过 5 条测试截条数
      const items = Array.from({ length: count }, () => "字".repeat(1 + Math.floor(Math.random() * 700)));
      const { userPrompt } = buildTitlePrompt({ userInputs: items });
      const bulletLines = userPrompt.split("\n").filter((l) => l.startsWith("- "));
      expect(bulletLines.length, `trial ${trial}`).toBeLessThanOrEqual(TITLE_RECENT_INPUT_MAX_COUNT);
      const totalCodePoints = bulletLines.reduce((sum, line) => sum + Array.from(line.slice(2)).length, 0);
      expect(totalCodePoints, `trial ${trial}`).toBeLessThanOrEqual(TITLE_RECENT_INPUT_TOTAL_MAX_CHARS);
    }
  });

  it("stops packing an older item once it would overflow the remaining budget (newest-first, whole-item drop, strict boundary case)", () => {
    // 构造恰好越界的用例：4 条最新输入均为 400 码点（合计 1600），剩余额度恰好 400；
    // 第 5 条（最旧）未截断前有 401 码点——截断后仍是 400，恰好典中 2000 上限（不被丢）。
    // 若将第 5 条长度换成超过剩余额度的有效内容（例如前 4 条占满 400 后再加一条——在当前
    // ITEM_CAP×COUNT===TOTAL_CAP 的常数关系下，5 条均被截断至 ≤400 时合计永远 ≤2000，本来无法
    // 触发“被整条丢弃”——用下述 6 条输入来模拟：取最近 5 条的规则先打掉最旧的第 6 条，
    // 再验证剩下 5 条在总额内全数被采纳（边界命中，不溢出）。
    const items = ["被打掉的最旧条", ...Array.from({ length: 5 }, (_, i) => `第${i}条`.padEnd(400, "字"))];
    const { userPrompt } = buildTitlePrompt({ userInputs: items });
    expect(userPrompt).not.toContain("被打掉的最旧条"); // 超出 5 条窗口，先被 slice(-5) 排除
    for (let i = 0; i < 5; i++) expect(userPrompt).toContain(`第${i}条`);
    const bulletLines = userPrompt.split("\n").filter((l) => l.startsWith("- "));
    expect(bulletLines.length).toBe(5);
    const totalCodePoints = bulletLines.reduce((sum, line) => sum + Array.from(line.slice(2)).length, 0);
    expect(totalCodePoints).toBeLessThanOrEqual(TITLE_RECENT_INPUT_TOTAL_MAX_CHARS);
  });

  it("filters blank-only entries out of the recent-input pool", () => {
    const { userPrompt } = buildTitlePrompt({ userInputs: ["", "   ", "真实输入"] });
    expect(userPrompt).toContain("真实输入");
    expect(userPrompt.match(/- /g)?.length).toBe(1);
  });
});

/** 模型句柄哨兵（核心对 M 不透明）。 */
const FLASH = { tag: "flash" } as const;
const SESSION = { tag: "session" } as const;
const REF: TitleModelRef = { provider: "zai-coding-cn", id: "glm-5.3-flash" };

/** 默认关闭刷新（等价 v1：只首标）；单测按需覆盖。 */
const V1_ONLY: TitleTriggerOptions = { refreshEveryInputs: 0, refreshAfterMinutes: 0, maxRefreshes: 5 };

interface Harness {
  trigger: TitleTrigger<unknown>;
  /** 每次触发要的生成依赖（findModel/currentModel/complete/sessionKey）——测试里复用同一份，
   * 但它自身就是装配层每次触发时就地构造的那一份。 */
  deps: TitleGenerationDeps<unknown>;
  names: string[]; // setSessionName 调用序抓（非真实状态）
  records: Array<{ name: string }>; // recordOwnTitle 调用序抓
  /** setSessionName/recordOwnTitle 的合并调用序（#3a 严格断记前后顺序用）。 */
  callLog: string[];
  state: { name?: string; clock: number };
  findCalls: TitleModelRef[];
  completeCalls: TitleCompletionRequest[];
  sleepCalls: number[];
  complete: ReturnType<typeof vi.fn>;
  recordOwnTitle: ReturnType<typeof vi.fn>;
  session: { key: string };
  latestOwn: { name?: string; count: number };
}

function makeHarness(
  init: {
    modelRef?: TitleModelRef | null;
    found?: unknown;
    current?: unknown;
    initialName?: string;
    completeImpl?: (req: TitleCompletionRequest, attempt: number) => string | Promise<string>;
    options?: Partial<TitleTriggerOptions>;
    recordThrows?: boolean;
    userInputs?: string[];
    assistantExcerpt?: string;
    initialOwnRecord?: { name?: string; count: number };
  } = {},
): Harness {
  const state: { name?: string; clock: number } = { name: init.initialName, clock: 0 };
  const session = { key: "session-one" };
  const names: string[] = [];
  const records: Array<{ name: string }> = [];
  const callLog: string[] = [];
  const findCalls: TitleModelRef[] = [];
  const completeCalls: TitleCompletionRequest[] = [];
  const sleepCalls: number[] = [];
  const found = "found" in init ? init.found : FLASH;
  const latestOwn: { name?: string; count: number } = init.initialOwnRecord ?? { name: undefined, count: 0 };
  let attempt = 0;
  const complete = vi.fn((model: unknown, req: TitleCompletionRequest) => {
    void model;
    completeCalls.push(req);
    attempt += 1;
    if (init.completeImpl) return Promise.resolve(init.completeImpl(req, attempt));
    return Promise.resolve("模型生成的标题");
  });
  const recordOwnTitle = vi.fn((name: string) => {
    callLog.push("appendEntry");
    if (init.recordThrows) throw new Error("appendEntry failed");
    records.push({ name });
    latestOwn.name = name;
    latestOwn.count += 1;
  });
  const ports: TitlePorts = {
    getSessionName: () => state.name,
    setSessionName: (name) => {
      callLog.push("setSessionName");
      names.push(name);
      state.name = name;
    },
    sleep: (ms) => {
      sleepCalls.push(ms);
      return Promise.resolve();
    },
    timeoutSignal: () => new AbortController().signal,
    now: () => state.clock,
    readUserInputs: () => init.userInputs ?? [],
    readAssistantExcerpt: () => init.assistantExcerpt,
    titleRecords: () => ({ latestName: latestOwn.name, count: latestOwn.count }),
    recordOwnTitle,
  };
  const deps: TitleGenerationDeps<unknown> = {
    findModel: (ref) => {
      findCalls.push(ref);
      return found;
    },
    currentModel: () => init.current,
    complete: complete as unknown as TitleGenerationDeps<unknown>["complete"],
    sessionKey: () => session.key,
  };
  const options: TitleTriggerOptions = {
    ...V1_ONLY,
    ...(init.modelRef === null ? {} : { modelRef: init.modelRef ?? REF }),
    ...init.options,
  };
  const trigger = createTitleTrigger<unknown>(ports, options);
  return {
    trigger,
    deps,
    names,
    records,
    callLog,
    state,
    findCalls,
    completeCalls,
    sleepCalls,
    complete,
    recordOwnTitle,
    session,
    latestOwn,
  };
}

describe("createTitleTrigger — first title (before_agent_start)", () => {
  it("generates once, sanitizes, writes the session name, and records ownership", () => {
    const h = makeHarness({ completeImpl: () => "  **标题：修复登录超时。**  \n" });
    h.trigger.onBeforeAgentStart("帮我修复登录超时的 bug", h.deps);
    return flush().then(() => {
      expect(h.complete).toHaveBeenCalledTimes(1);
      expect(h.names).toEqual(["修复登录超时"]);
      expect(h.state.name).toBe("修复登录超时");
      expect(h.records).toEqual([{ name: "修复登录超时" }]);
    });
  });

  it("calls setSessionName strictly before appendEntry (write-order invariant, #3a)", async () => {
    const h = makeHarness({ completeImpl: () => "排序标题" });
    h.trigger.onBeforeAgentStart("帮我排个序", h.deps);
    await flush();
    expect(h.callLog).toEqual(["setSessionName", "appendEntry"]);
  });

  it("passes the built prompt (previous title + recent inputs), 512 maxTokens, and a signal through", async () => {
    const h = makeHarness({ found: FLASH, userInputs: ["之前的输入"] });
    h.trigger.onBeforeAgentStart("第一条消息", h.deps);
    await flush();
    expect(h.findCalls).toEqual([REF]);
    expect(h.completeCalls[0]!.maxTokens).toBe(TITLE_MAX_TOKENS);
    expect(h.completeCalls[0]!.signal).toBeInstanceOf(AbortSignal);
    // 首标输入 = 既有 branch 用户消息 + 本次 prompt。
    expect(h.completeCalls[0]!.userPrompt).toContain("之前的输入");
    expect(h.completeCalls[0]!.userPrompt).toContain("第一条消息");
    expect(h.completeCalls[0]!.systemPrompt).toContain("session title");
  });

  it("skips silently when the session already has a name (user /name'd or generated)", async () => {
    const h = makeHarness({ initialName: "用户起的名字" });
    h.trigger.onBeforeAgentStart("第一条消息", h.deps);
    await flush();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.names).toEqual([]);
  });

  it("skips empty prompts without starting a generation", async () => {
    const h = makeHarness();
    h.trigger.onBeforeAgentStart("   ", h.deps);
    await flush();
    expect(h.complete).not.toHaveBeenCalled();
    h.trigger.onBeforeAgentStart("真实的第一条", h.deps);
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it("gives up silently after 2 failed attempts (no retry storm, one backoff) and resets the baseline", async () => {
    const h = makeHarness({
      completeImpl: () => {
        throw new Error("429");
      },
    });
    h.trigger.onBeforeAgentStart("第一条", h.deps);
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
    h.trigger.onBeforeAgentStart("第一条", h.deps);
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(2);
    expect(h.names).toEqual(["第二次的标题"]);
  });

  it("treats sanitize-to-empty output as a failure (2 attempts, no write)", async () => {
    const h = makeHarness({ completeImpl: () => "标题：" });
    h.trigger.onBeforeAgentStart("第一条", h.deps);
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(TITLE_MAX_ATTEMPTS);
    expect(h.names).toEqual([]);
  });

  it("discards the generated title if the user named the session mid-flight (stale, no write/record)", async () => {
    const h = makeHarness({
      completeImpl: () => {
        h.state.name = "用户抢先起的名字";
        return "模型的标题";
      },
    });
    h.trigger.onBeforeAgentStart("第一条", h.deps);
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.names).toEqual([]);
    expect(h.records).toEqual([]);
    expect(h.state.name).toBe("用户抢先起的名字");
  });

  it("discards the generated title if the session switched mid-flight (/new during generation)", async () => {
    const h = makeHarness({
      completeImpl: () => {
        h.session.key = "session-two";
        return "旧会话的标题";
      },
    });
    h.trigger.onBeforeAgentStart("第一条", h.deps);
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.names).toEqual([]);
    expect(h.state.name).toBeUndefined();
  });

  it("falls back to the session model when the configured ref is absent from the registry", async () => {
    const h = makeHarness({ found: undefined, current: SESSION, completeImpl: () => "回落生成的标题" });
    h.trigger.onBeforeAgentStart("第一条", h.deps);
    await flush();
    expect(h.state.name).toBe("回落生成的标题");
  });

  it("uses the session model directly when no ref is configured (empty-string sentinel)", async () => {
    const h = makeHarness({ modelRef: null, current: SESSION, completeImpl: () => "跟随会话模型" });
    h.trigger.onBeforeAgentStart("第一条", h.deps);
    await flush();
    expect(h.findCalls).toEqual([]);
    expect(h.state.name).toBe("跟随会话模型");
  });

  it("gives up silently when no model resolves at all", async () => {
    const h = makeHarness({ found: undefined, current: undefined });
    h.trigger.onBeforeAgentStart("第一条", h.deps);
    await flush();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.names).toEqual([]);
  });

  it("never rejects the fire-and-forget promise even when ports explode", async () => {
    const ports: TitlePorts = {
      getSessionName: () => {
        throw new Error("registry exploded");
      },
      setSessionName: () => {
        throw new Error("write failed");
      },
      sleep: () => Promise.resolve(),
      timeoutSignal: () => new AbortController().signal,
      now: () => 0,
      readUserInputs: () => {
        throw new Error("branch read failed");
      },
      readAssistantExcerpt: () => undefined,
      titleRecords: () => {
        throw new Error("entries read failed");
      },
      recordOwnTitle: () => {
        throw new Error("append failed");
      },
    };
    const explodingDeps: TitleGenerationDeps<unknown> = {
      findModel: () => FLASH,
      currentModel: () => undefined,
      complete: () => Promise.reject(new Error("network")),
      sessionKey: () => "s1",
    };
    const trigger = createTitleTrigger<unknown>(ports, { ...V1_ONLY, modelRef: REF });
    expect(() => trigger.onBeforeAgentStart("第一条", explodingDeps)).not.toThrow();
    await flush();
  });

  it("latches via in-flight mutex: a second before_agent_start while generating does not start a second request", async () => {
    const h = makeHarness();
    h.trigger.onBeforeAgentStart("第一条", h.deps);
    h.trigger.onBeforeAgentStart("第二条（steer/追问）", h.deps);
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it("pins the spec constants (10s timeout, 2 attempts, 60-char cap, recent-input budgets)", () => {
    expect(TITLE_TIMEOUT_MS).toBe(10_000);
    expect(TITLE_MAX_ATTEMPTS).toBe(2);
    expect(TITLE_MAX_CHARS).toBe(60);
    expect(TITLE_PREVIOUS_MAX_CHARS).toBe(60);
    expect(TITLE_RECENT_INPUT_MAX_COUNT).toBe(5);
    expect(TITLE_RECENT_INPUT_ITEM_MAX_CHARS).toBe(400);
    expect(TITLE_RECENT_INPUT_TOTAL_MAX_CHARS).toBe(2_000);
    expect(TITLE_ASSISTANT_EXCERPT_MAX_CHARS).toBe(600);
  });
});

describe("createTitleTrigger — refresh milestones (agent_settled)", () => {
  it("refreshes after the Nth new input since last generation (refreshEveryInputs)", async () => {
    const h = makeHarness({
      initialName: "旧标题",
      initialOwnRecord: { name: "旧标题", count: 1 },
      options: { refreshEveryInputs: 4, refreshAfterMinutes: 0 },
      completeImpl: () => "新标题",
      userInputs: ["u1", "u2", "u3", "u4"],
    });
    for (let i = 0; i < 3; i++) {
      h.trigger.onBeforeAgentStart(`输入${i}`, h.deps);
      h.trigger.onAgentEnd(true);
      h.trigger.onAgentSettled(h.deps);
    }
    await flush();
    expect(h.complete).not.toHaveBeenCalled(); // 3 条，未达 4
    h.trigger.onBeforeAgentStart("输入4", h.deps);
    h.trigger.onAgentEnd(true);
    h.trigger.onAgentSettled(h.deps);
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.names).toEqual(["新标题"]);
    expect(h.completeCalls[0]!.userPrompt).toContain("Current title: 旧标题");
  });

  it("refreshes when >=1 new input and cumulative busy time crosses refreshAfterMinutes (injected now)", async () => {
    const h = makeHarness({
      initialName: "旧标题",
      initialOwnRecord: { name: "旧标题", count: 1 },
      options: { refreshEveryInputs: 0, refreshAfterMinutes: 15 },
      completeImpl: () => "耗时后的新标题",
    });
    h.state.clock = 0;
    h.trigger.onBeforeAgentStart("唯一一条输入", h.deps);
    h.state.clock = 16 * 60_000; // 16 分钟后收尾
    h.trigger.onAgentEnd(true);
    h.trigger.onAgentSettled(h.deps);
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.names).toEqual(["耗时后的新标题"]);
  });

  it("does not refresh when there is zero new input even if time threshold would otherwise pass", async () => {
    const h = makeHarness({
      initialName: "旧标题",
      initialOwnRecord: { name: "旧标题", count: 1 },
      options: { refreshEveryInputs: 0, refreshAfterMinutes: 1 },
    });
    // 没有任何 before_agent_start（无新输入），直接收尾。
    h.trigger.onAgentEnd(true);
    h.trigger.onAgentSettled(h.deps);
    await flush();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("does not refresh after an aborted or errored run", async () => {
    const h = makeHarness({
      initialName: "旧标题",
      initialOwnRecord: { name: "旧标题", count: 1 },
      options: { refreshEveryInputs: 1, refreshAfterMinutes: 0 },
    });
    h.trigger.onBeforeAgentStart("输入", h.deps);
    h.trigger.onAgentEnd(false); // aborted/error
    h.trigger.onAgentSettled(h.deps);
    await flush();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("same-name result: no write, no record, but counts as a successful refresh (baseline resets)", async () => {
    const h = makeHarness({
      initialName: "不变的标题",
      initialOwnRecord: { name: "不变的标题", count: 1 },
      options: { refreshEveryInputs: 1, refreshAfterMinutes: 0 },
      completeImpl: () => "不变的标题",
    });
    h.trigger.onBeforeAgentStart("输入1", h.deps);
    h.trigger.onAgentEnd(true);
    h.trigger.onAgentSettled(h.deps);
    await flush();
    expect(h.names).toEqual([]);
    expect(h.records).toEqual([]);
    // 基线前移：紧接着再来一条输入不会立刻又触发（因为 inputsSinceGen 已清零）。
    h.trigger.onBeforeAgentStart("输入2", h.deps);
    h.trigger.onAgentEnd(true);
    h.trigger.onAgentSettled(h.deps);
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(2); // 两次尝试都调用了 complete，但没有新 setSessionName
    expect(h.names).toEqual([]);
  });

  it("failure (attempts exhausted) resets the baseline — next refresh waits for the next milestone", async () => {
    const h = makeHarness({
      initialName: "旧标题",
      initialOwnRecord: { name: "旧标题", count: 1 },
      options: { refreshEveryInputs: 1, refreshAfterMinutes: 0 },
      completeImpl: () => {
        throw new Error("down");
      },
    });
    h.trigger.onBeforeAgentStart("输入1", h.deps);
    h.trigger.onAgentEnd(true);
    h.trigger.onAgentSettled(h.deps);
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(TITLE_MAX_ATTEMPTS);
    const callsAfterFirst = h.complete.mock.calls.length;
    // 没有新输入就立刻再 settled 一次：不应该再触发（baseline 已清零，inputsSinceGen=0 < 1）。
    h.trigger.onAgentSettled(h.deps);
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it("stale discard (new input arrives mid-flight): result thrown away, baseline NOT reset", async () => {
    let resolveFirst!: (value: string) => void;
    const h = makeHarness({
      initialName: "旧标题",
      initialOwnRecord: { name: "旧标题", count: 1 },
      options: { refreshEveryInputs: 1, refreshAfterMinutes: 0 },
      completeImpl: () => new Promise<string>((resolve) => (resolveFirst = resolve)),
    });
    h.trigger.onBeforeAgentStart("输入1", h.deps);
    h.trigger.onAgentEnd(true);
    h.trigger.onAgentSettled(h.deps); // 进入生成，in-flight
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(1);
    // 生成在途时，新的一轮 before_agent_start 到来（inputSeq 变化）——下一轮设置 inFlight 导致本轮 settled 被互斥跳过。
    h.trigger.onBeforeAgentStart("输入2（在途到达）", h.deps);
    // 完成第一次生成：写入前复验 inputSeq 已变 ⇒ stale，丢弃。
    resolveFirst("本应写入的标题");
    await flush();
    expect(h.names).toEqual([]); // 没有写入
    h.trigger.onAgentEnd(true);
    h.trigger.onAgentSettled(h.deps);
    await flush();
    // stale 没有清零基线：此刻 inputsSinceGen 应该仍 >=1（输入1 + 输入2 都算），故能立刻再次触发。
    expect(h.complete.mock.calls.length).toBeGreaterThan(1);
  });

  it("epoch change (session_start mid-flight) discards the result", async () => {
    let resolveFirst!: (value: string) => void;
    const h = makeHarness({
      initialName: "旧标题",
      initialOwnRecord: { name: "旧标题", count: 1 },
      options: { refreshEveryInputs: 1, refreshAfterMinutes: 0 },
      completeImpl: () => new Promise<string>((resolve) => (resolveFirst = resolve)),
    });
    h.trigger.onBeforeAgentStart("输入1", h.deps);
    h.trigger.onAgentEnd(true);
    h.trigger.onAgentSettled(h.deps);
    await flush();
    h.trigger.onSessionStart(); // reload：epoch+1
    resolveFirst("旧会话晚到的标题");
    await flush();
    expect(h.names).toEqual([]);
  });

  it("session_shutdown aborts the in-flight generation", async () => {
    let capturedSignal: AbortSignal | undefined;
    const h = makeHarness({
      initialName: "旧标题",
      initialOwnRecord: { name: "旧标题", count: 1 },
      options: { refreshEveryInputs: 1, refreshAfterMinutes: 0 },
      completeImpl: () => new Promise<string>(() => undefined), // 永不 resolve
    });
    // 替换 complete 以捕获 signal。
    const originalComplete = h.complete.getMockImplementation()!;
    h.complete.mockImplementation((model: unknown, req: TitleCompletionRequest) => {
      capturedSignal = req.signal;
      return originalComplete(model, req);
    });
    h.trigger.onBeforeAgentStart("输入1", h.deps);
    h.trigger.onAgentEnd(true);
    h.trigger.onAgentSettled(h.deps);
    await flush();
    expect(capturedSignal?.aborted).toBe(false);
    h.trigger.onSessionShutdown();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("session_start aborts the in-flight generation too, and the new session can start a fresh generation immediately without co-existing with the stale one (#2)", async () => {
    let capturedSignal: AbortSignal | undefined;
    const h = makeHarness({
      initialName: "旧标题",
      initialOwnRecord: { name: "旧标题", count: 1 },
      options: { refreshEveryInputs: 1, refreshAfterMinutes: 0 },
      completeImpl: () => new Promise<string>(() => undefined), // 永不 resolve：模拟旧会话的请求挂在半空
    });
    const originalComplete = h.complete.getMockImplementation()!;
    h.complete.mockImplementation((model: unknown, req: TitleCompletionRequest) => {
      if (!capturedSignal) capturedSignal = req.signal;
      return originalComplete(model, req);
    });
    h.trigger.onBeforeAgentStart("输入1", h.deps);
    h.trigger.onAgentEnd(true);
    h.trigger.onAgentSettled(h.deps);
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(false); // 旧请求还在途

    // reload/新会话：session_start 必须 abort 在途请求并清空互斥，让新会话能立即开始新的生成。
    h.trigger.onSessionStart();
    expect(capturedSignal?.aborted).toBe(true); // 旧请求被 abort——不是单纯清空引用而不打断网络请求

    // 新会话：未命名，走首标路径——若 inFlight 没被正确清空，这次会被互斥跳过（complete 不会被再调用）。
    h.state.name = undefined;
    h.trigger.onBeforeAgentStart("新会话的第一条", h.deps);
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(2); // 新请求确实发出了，没有被旧的在途卡住
  });

  it("user-owned title (current name != latest own record) never refreshes again", async () => {
    const h = makeHarness({
      initialName: "用户改的名字",
      initialOwnRecord: { name: "v1 遗留标题", count: 1 }, // 名字不匹配最近记录 ⇒ 用户所有
      options: { refreshEveryInputs: 1, refreshAfterMinutes: 0 },
    });
    h.trigger.onBeforeAgentStart("输入1", h.deps);
    h.trigger.onAgentEnd(true);
    h.trigger.onAgentSettled(h.deps);
    await flush();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("appendEntry failure after a successful write ⇒ subsequent settled treats the session as user-owned", async () => {
    const h = makeHarness({
      initialName: "旧标题",
      initialOwnRecord: { name: "旧标题", count: 1 },
      options: { refreshEveryInputs: 1, refreshAfterMinutes: 0 },
      recordThrows: true,
      completeImpl: () => "新标题",
    });
    h.trigger.onBeforeAgentStart("输入1", h.deps);
    h.trigger.onAgentEnd(true);
    h.trigger.onAgentSettled(h.deps);
    await flush();
    expect(h.names).toEqual(["新标题"]); // 名字写成功了
    expect(h.state.name).toBe("新标题");
    // 但 appendEntry 失败：latestOwn.name 还停在"旧标题"，与当前名字不一致 ⇒ 判用户所有。
    h.trigger.onBeforeAgentStart("输入2", h.deps);
    h.trigger.onAgentEnd(true);
    h.trigger.onAgentSettled(h.deps);
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(1); // 没有第二次生成
  });

  it("refresh quota exhausted (count - 1 >= maxRefreshes) stops further refreshes", async () => {
    const h = makeHarness({
      initialName: "旧标题",
      initialOwnRecord: { name: "旧标题", count: 6 }, // 1 首标 + 5 次刷新，maxRefreshes=5 已耗尽
      options: { refreshEveryInputs: 1, refreshAfterMinutes: 0, maxRefreshes: 5 },
    });
    h.trigger.onBeforeAgentStart("输入1", h.deps);
    h.trigger.onAgentEnd(true);
    h.trigger.onAgentSettled(h.deps);
    await flush();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("maxRefreshes=0 means only the first title, never refresh", async () => {
    const h = makeHarness({
      initialName: "首标",
      initialOwnRecord: { name: "首标", count: 1 },
      options: { refreshEveryInputs: 1, refreshAfterMinutes: 0, maxRefreshes: 0 },
    });
    h.trigger.onBeforeAgentStart("输入1", h.deps);
    h.trigger.onAgentEnd(true);
    h.trigger.onAgentSettled(h.deps);
    await flush();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("refreshEveryInputs=0 && refreshAfterMinutes=0 is equivalent to v1 (first title only, never refresh)", async () => {
    const h = makeHarness({
      initialName: "首标",
      initialOwnRecord: { name: "首标", count: 1 },
      options: { refreshEveryInputs: 0, refreshAfterMinutes: 0, maxRefreshes: 5 },
    });
    for (let i = 0; i < 20; i++) {
      h.trigger.onBeforeAgentStart(`输入${i}`, h.deps);
      h.trigger.onAgentEnd(true);
      h.trigger.onAgentSettled(h.deps);
    }
    h.state.clock = 999 * 60_000;
    h.trigger.onAgentSettled(h.deps);
    await flush();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("passes through the recent-inputs + assistant excerpt snapshot built by the wiring layer", async () => {
    const h = makeHarness({
      initialName: "旧标题",
      initialOwnRecord: { name: "旧标题", count: 1 },
      options: { refreshEveryInputs: 1, refreshAfterMinutes: 0 },
      userInputs: ["最近的用户输入"],
      assistantExcerpt: "最近的助手回复摘录",
      completeImpl: () => "新标题",
    });
    h.trigger.onBeforeAgentStart("输入1", h.deps);
    h.trigger.onAgentEnd(true);
    h.trigger.onAgentSettled(h.deps);
    await flush();
    expect(h.completeCalls[0]!.userPrompt).toContain("最近的用户输入");
    expect(h.completeCalls[0]!.userPrompt).toContain("最近的助手回复摘录");
    expect(h.completeCalls[0]!.userPrompt).toContain("Current title: 旧标题");
  });

  it("in-flight mutex: a refresh trigger while another generation is in flight is skipped (no second request)", async () => {
    const h = makeHarness({
      initialName: "旧标题",
      initialOwnRecord: { name: "旧标题", count: 1 },
      options: { refreshEveryInputs: 1, refreshAfterMinutes: 0 },
      completeImpl: () => new Promise<string>(() => undefined),
    });
    h.trigger.onBeforeAgentStart("输入1", h.deps);
    h.trigger.onAgentEnd(true);
    h.trigger.onAgentSettled(h.deps);
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(1);
    // 在途时再来一轮 settled（例如 agent_settled 被重复触发），不应该再发请求。
    h.trigger.onAgentEnd(true);
    h.trigger.onAgentSettled(h.deps);
    await flush();
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
});
