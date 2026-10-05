/**
 * 会话标题模型生成 v2——pi 侧装配（纯核心在 ./title.ts）。
 *
 * `wireTitle` 只做三件事（I7：src/index.ts 调这里，逻辑不进装配文件）：
 * 1. 子会话防御性排除（结构上 post-guard 已保证仅主会话可达，这里再查
 *    isChildSession——双保险，可测）；
 * 2. 注册 `before_agent_start` / `agent_end` / `agent_settled` / `session_start` /
 *    `session_shutdown` 五个 handler（事件分工：before_agent_start 计数 + 首标
 *    门检，agent_end 记录本轮是否正常收尾，agent_settled 累加运行时长 + 刷新
 *    门检，session_start/session_shutdown 维护 epoch/内存状态）；
 * 3. 把每次事件收到的 `ExtensionContext` 适配成核心需要的依赖：
 *    - `findModel`/`currentModel`/`complete`/`sessionKey`——这四个会在异步重试
 *      循环里被多次调用，**按次绑定**到本次 handler 收到的 ctx（`buildDeps(ctx)`
 *      就地构造一个闭包捕获该 ctx 的对象，随 `onBeforeAgentStart`/`onAgentSettled`
 *      的参数传给核心），绝不经过任何跨事件共享的可变引用——核心全程只认这份
 *      快照，不会因为生成在途又来了新的 pi 事件（新会话/`/reload`）而悄悄漂移
 *      到别的 ctx 上；
 *    - `readUserInputs`/`readAssistantExcerpt`/`titleRecords`——核心只在触发
 *      handler 的同步段调用这三个（不会在 completion 的异步重试里再碰），走
 *      共享的 `ctxRef`（handler 开头刚赋值，同步读取不存在过期风险）；
 *    - `getSessionName`/`setSessionName`/`recordOwnTitle` 只依赖 `pi`，与 ctx
 *      无关，始终共享。
 *
 * completion 走 `ctx.modelRegistry.complete(model, context, options)`——
 * pi 的同步兼容门面上的一次性 API（内部 stream 到 done 聚合 AssistantMessage），
 * 请求时鉴权由 registry 处理，是 repo 里直调 LLM 的最短路径（memory tidy
 * 走重型 subagent spawn，标题这种 ≤512 token 的一次性调用不值得起会话）。
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { parseStrictModelRef } from "../config/model-hint.js";
import { createTitleTrigger, type TitleGenerationDeps, type TitlePorts, type TitleTrigger } from "./title.js";

/** 自有标题记录的 customType（会话级 appendEntry，schema `{v:1,name,at}`）。 */
export const TITLE_RECORD_CUSTOM_TYPE = "subagent:title";

export interface WireTitleDeps {
  /** 子会话（print 模式）不触发标题生成——防御性双保险（post-guard 已排除）。 */
  isChildSession: boolean;
  /** settings.title.model 原始串：strict `provider/id`；空串/非法 = 跟随会话模型。 */
  model: string;
  /** settings.title.refreshEveryInputs：新增用户输入数达到此值即可刷新；0 = 关闭此条件。 */
  refreshEveryInputs: number;
  /** settings.title.refreshAfterMinutes：新增输入≥1 且累计运行时长达到此分钟数即可刷新；0 = 关闭此条件。 */
  refreshAfterMinutes: number;
  /** settings.title.maxRefreshes：每会话刷新上限（不含首标）；0 = 只首标不刷新。 */
  maxRefreshes: number;
}

/** 从 AssistantMessage 提取纯文本；errorMessage/无文本块按失败抛出（completion 调用方）。 */
function assistantText(message: AssistantMessage): string {
  if (message.errorMessage) throw new Error(message.errorMessage);
  const text = message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join(" ");
  if (!text.trim()) throw new Error("title completion returned no text");
  return text;
}

/** branch 里一条 user 消息（string 或文本/图片块数组）的纯文本；空白/纯图片 ⇒ undefined。 */
function userMessageText(content: string | (TextContent | { type: string })[]): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed ? trimmed : undefined;
  }
  const joined = content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .trim();
  return joined ? joined : undefined;
}

/** 从 branch（chronological ascending）提取全部 user 消息文本，过滤空白/纯图片。 */
function extractUserInputs(branch: readonly SessionEntry[]): string[] {
  const out: string[] = [];
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (!message || message.role !== "user") continue;
    const text = userMessageText(message.content as never);
    if (text) out.push(text);
  }
  return out;
}

/**
 * 从 branch 提取最后一条 assistant 回复的文本摘录——只看最近一条（chronological
 * 倒序找到的第一条 role==="assistant"），不回退去找更早的；该回复 aborted/error/
 * errorMessage/无文本块 ⇒ undefined（compaction 等非 message 条目跳过，继续往前找
 * 真正的消息条目，但找到的 assistant 消息本身不合格就直接放弃，不再继续找更早的——
 * 这是 r1 字面口径「最后一条且满足条件」，不是「找一条满足条件的」）。
 */
function extractAssistantExcerpt(branch: readonly SessionEntry[]): string | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== "message") continue;
    const message = entry.message as AssistantMessage | { role?: string } | undefined;
    if (!message || (message as { role?: string }).role !== "assistant") continue;
    const assistantMsg = message as AssistantMessage;
    if (assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error") return undefined;
    if (assistantMsg.errorMessage) return undefined;
    const text = assistantMsg.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join(" ")
      .trim();
    return text ? text : undefined;
  }
  return undefined;
}

/** 自有标题记录的落盘形状（r1 #14：`{v:1,name,at}`，name 非空字符串，at 数值）。 */
interface TitleRecordData {
  v: 1;
  name: string;
  at: number;
}

function isValidTitleRecordData(data: unknown): data is TitleRecordData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return d.v === 1 && typeof d.name === "string" && d.name.length > 0 && typeof d.at === "number";
}

/** 会话级（全部 fileEntries）扫描自有标题记录：最近一条有效记录的名字 + 有效记录总数。非法记录跳过。 */
function readTitleRecords(entries: readonly SessionEntry[]): { latestName?: string | undefined; count: number } {
  let latestName: string | undefined;
  let count = 0;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== TITLE_RECORD_CUSTOM_TYPE) continue;
    if (!isValidTitleRecordData(entry.data)) continue;
    count++;
    latestName = entry.data.name; // entries 是 chronological ascending，最后一次赋值即最新
  }
  return { latestName, count };
}

export interface TitleWiring {
  trigger: TitleTrigger<unknown>;
}

export function wireTitle(pi: ExtensionAPI, deps: WireTitleDeps): TitleWiring | undefined {
  if (deps.isChildSession) return undefined;

  // strict 解析；空串哨兵/非 strict 形 → undefined（核心自动回落会话模型）。
  const modelRef = parseStrictModelRef(deps.model);

  // 仅供三个「只在触发 handler 同步段被调用一次」的端口使用（读文本/记录）——
  // handler 开头刚赋值即同步消费，不会跨 await，不存在过期风险。模型解析/
  // completion/会话身份这四个会在异步重试循环里被多次调用的依赖**不**走这个
  // 共享引用，而是由 buildDeps(ctx) 按次绑定（见下）。
  const ctxRef: { current?: ExtensionContext } = {};

  const ports: TitlePorts = {
    getSessionName: () => safe(() => pi.getSessionName()),
    setSessionName: (name) => {
      pi.setSessionName(name);
    },
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        if (typeof t === "object" && typeof t.unref === "function") t.unref(); // AGENTS.md: ref'd timers wedge `pi -p`
      }),
    timeoutSignal: (ms) => AbortSignal.timeout(ms),
    now: () => Date.now(),
    readUserInputs: () => safe(() => extractUserInputs(ctxRef.current?.sessionManager.getBranch() ?? [])) ?? [],
    readAssistantExcerpt: () => safe(() => extractAssistantExcerpt(ctxRef.current?.sessionManager.getBranch() ?? [])),
    titleRecords: () => safe(() => readTitleRecords(ctxRef.current?.sessionManager.getEntries() ?? [])) ?? { count: 0 },
    recordOwnTitle: (name) => {
      pi.appendEntry(TITLE_RECORD_CUSTOM_TYPE, { v: 1, name, at: Date.now() });
    },
  };

  /**
   * 按次构造生成依赖：闭包捕获**本次 handler 收到的 ctx**（不是共享引用），
   * 核心异步重试循环全程只通过这份闭包访问 completion/模型解析/会话身份，
   * 绝不会因为中途又来了新的 pi 事件而漂移到别的会话/ctx 上。
   */
  function buildDeps(ctx: ExtensionContext): TitleGenerationDeps<unknown> {
    return {
      findModel: (ref) => safe(() => ctx.modelRegistry.find(ref.provider, ref.id)),
      currentModel: () => safe(() => ctx.model),
      complete: async (model, request) => {
        const message = await ctx.modelRegistry.complete(
          model as never,
          {
            systemPrompt: request.systemPrompt,
            messages: [{ role: "user", content: request.userPrompt, timestamp: Date.now() }],
          },
          {
            signal: request.signal,
            maxTokens: request.maxTokens,
          },
        );
        return assistantText(message);
      },
      sessionKey: () => safe(() => ctx.sessionManager.getSessionId()),
    };
  }

  const trigger = createTitleTrigger<unknown>(ports, {
    ...(modelRef ? { modelRef } : {}),
    refreshEveryInputs: deps.refreshEveryInputs,
    refreshAfterMinutes: deps.refreshAfterMinutes,
    maxRefreshes: deps.maxRefreshes,
  });

  pi.on("before_agent_start", (event, ctx) => {
    // ctxRef 只给 readUserInputs 这三个同步端口用（本次调用里立即被消费）；
    // completion 等异步依赖走下面就地构造的 buildDeps(ctx)。
    ctxRef.current = ctx;
    trigger.onBeforeAgentStart(event.prompt, buildDeps(ctx));
  });
  pi.on("agent_end", (event) => {
    // 取 event.messages 中最后一条 assistant（不是数组最后一个元素——末尾可能是
    // toolResult/custom 等非 assistant 条目）；找不到按未正常收尾处理（安全方向）。
    let last: AssistantMessage | undefined;
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const m = event.messages[i] as { role?: string } | undefined;
      if (m && m.role === "assistant") {
        last = m as AssistantMessage;
        break;
      }
    }
    const ok = !!last && last.stopReason !== "aborted" && last.stopReason !== "error" && !last.errorMessage;
    trigger.onAgentEnd(ok);
  });
  pi.on("agent_settled", (_event, ctx) => {
    ctxRef.current = ctx;
    trigger.onAgentSettled(buildDeps(ctx));
  });
  pi.on("session_start", () => {
    trigger.onSessionStart();
  });
  pi.on("session_shutdown", () => {
    trigger.onSessionShutdown();
  });

  return { trigger };
}

/** 吞掉读端口的意外异常（registry 在 /reload 瞬间可能抛）——undefined 按未解析处理。 */
function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
