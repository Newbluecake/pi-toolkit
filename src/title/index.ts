/**
 * 会话标题模型生成——pi 侧装配（纯核心在 ./title.ts）。
 *
 * `wireTitle` 只做三件事（I7：src/index.ts 调这里，逻辑不进装配文件）：
 * 1. 子会话防御性排除（结构上 post-guard 已保证仅主会话可达，这里再查
 *    isChildSession——双保险，可测）；
 * 2. 注册 `before_agent_start`（门检 + fire-and-forget）与 `session_start`
 *    （重置一次性格子）两个 handler；
 * 3. 把 `ExtensionContext.modelRegistry` 适配成核心的 TitlePorts：
 *    find/complete 都从最近一次 handler 收到的 ctx 惰性取（模型解析永远
 *    发生在生成时刻，不做 activate 时快照——/new 切模型后依然正确）。
 *
 * completion 走 `ctx.modelRegistry.complete(model, context, options)`——
 * pi 的同步兼容门面上的一次性 API（内部 stream 到 done 聚合 AssistantMessage），
 * 请求时鉴权由 registry 处理，是 repo 里直调 LLM 的最短路径（memory tidy
 * 走重型 subagent spawn，标题这种 ≤512 token 的一次性调用不值得起会话）。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { parseStrictModelRef } from "../config/model-hint.js";
import { createTitleTrigger, type TitlePorts, type TitleTrigger } from "./title.js";

export interface WireTitleDeps {
  /** 子会话（print 模式）不触发标题生成——防御性双保险（post-guard 已排除）。 */
  isChildSession: boolean;
  /** settings.title.model 原始串：strict `provider/id`；空串/非法 = 跟随会话模型。 */
  model: string;
}

/** 从 AssistantMessage 提取纯文本；errorMessage/无文本块按失败抛出。 */
function assistantText(message: AssistantMessage): string {
  if (message.errorMessage) throw new Error(message.errorMessage);
  const text = message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join(" ");
  if (!text.trim()) throw new Error("title completion returned no text");
  return text;
}

export interface TitleWiring {
  trigger: TitleTrigger;
}

export function wireTitle(pi: ExtensionAPI, deps: WireTitleDeps): TitleWiring | undefined {
  if (deps.isChildSession) return undefined;

  // strict 解析；空串哨兵/非 strict 形 → undefined（核心自动回落会话模型）。
  const modelRef = parseStrictModelRef(deps.model);

  // 最近一次事件 handler 收到的 ctx（modelRegistry 只在事件 ctx 上，不在 pi 上）。
  const ctxRef: { current?: ExtensionContext } = {};

  const ports: TitlePorts<unknown> = {
    getSessionName: () => safe(() => pi.getSessionName()),
    setSessionName: (name) => {
      pi.setSessionName(name);
    },
    findModel: (ref) => safe(() => ctxRef.current?.modelRegistry.find(ref.provider, ref.id)),
    currentModel: () => safe(() => ctxRef.current?.model),
    complete: async (model, request) => {
      const ctx = ctxRef.current;
      if (!ctx) throw new Error("no extension context captured yet");
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
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        if (typeof t === "object" && typeof t.unref === "function") t.unref(); // AGENTS.md: ref'd timers wedge `pi -p`
      }),
    timeoutSignal: (ms) => AbortSignal.timeout(ms),
    sessionKey: () => safe(() => ctxRef.current?.sessionManager.getSessionId()),
  };

  const trigger = createTitleTrigger(ports, modelRef ? { modelRef } : {});

  pi.on("before_agent_start", (event, ctx) => {
    // ctx 惰性捕获（handler 签名 (event, ctx)）：模型解析永远发生在生成时刻。
    ctxRef.current = ctx;
    trigger.onBeforeAgentStart(event.prompt);
  });
  pi.on("session_start", () => {
    trigger.onSessionStart();
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
