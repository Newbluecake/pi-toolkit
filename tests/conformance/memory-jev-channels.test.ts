/**
 * J0 conformance（jev-plan §4 J0 测试清单；arch §10「P0 conformance」）：C-J1–C-J15。
 *
 * 全部用真实 `AgentSession`（复用 ./agent-session-harness.ts 的 fakeModel /
 * fakeModelRuntime / withSession 三件套）+ 脚本模型，钉住 jev 依赖的 pi 行为前提。
 * 离线项（C-J1–C-J6、C-J7 类型级、C-J9–C-J14、C-J15 目录级）必须全绿；依赖凭证/
 * 网络的项（C-J7 真实调用、C-J8、C-J15 可用性+真实调用）在未设
 * `PI_TOOLKIT_JEV_CONFORMANCE=1` 时整体 skip 并写明原因（照 droid-protocol.test.ts
 * 的自门控写法；凭证测试由主会话在 E0 中执行）。
 *
 * 与架构稿表述不同、按现状断言的点（测试内注明，并已上报 root）：
 *  - C-J4：streaming 中 `sendMessage(triggerTurn:false)` 的消息在**本 turn 的
 *    turn_end**（该轮 assistant 消息与全部工具结果落盘之后）立即 append 进会话，
 *    因此对本 run 内**下一次 LLM 调用即可见**（agent-session.js `turn_end` 分支的
 *    `_flushPendingCustomMessages`），且不触发额外一轮——arch §6.1.3 的原假设成立。
 *    注意投影形状：LLM 上下文里 custom 消息以 `role:"user"` 出现（convertToLlm）。
 *  - C-J6：streaming 中 `sendMessage(triggerTurn:true)` 走 agent.steer 队列，同样在
 *    本 run 内下一次请求可见（与 triggerTurn:false 的差别只在排队通道，不在可见时机）；
 *    空闲 + triggerTurn:false 才是纯 append（message_start/message_end）路径。arch
 *    表述「streaming → message_start」不准：steer 分支不发 message_start。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { OPENCODE_CLASSIFIER_MODELS } from "@earendil-works/pi-ai/providers/opencode.models";
import { OPENROUTER_CLASSIFIER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";

import {
  assistantTextMsg,
  disposeHarnessDirs,
  fakeModel,
  fakeModelRuntime,
  withSession,
  type ScriptedTurn,
} from "./agent-session-harness.js";

const GATED = process.env.PI_TOOLKIT_JEV_CONFORMANCE === "1";
const GATED_SKIP_REASON =
  "needs real credentials/network (PI_TOOLKIT_JEV_CONFORMANCE=1; run by the main session in E0)";

afterEach(disposeHarnessDirs);

// ───────────────────────── helpers ─────────────────────────

interface Observed {
  beforeAgentStart: Array<{ messageType: string; customType?: string; prompt?: string }>;
  toolCalls: Array<{
    toolName: string;
    toolCallId: string;
    parentToolCallId?: string;
    input: unknown;
    at: number;
    doneAt: number;
  }>;
  toolResults: Array<{
    toolName: string;
    toolCallId: string;
    isError: boolean;
    usage?: unknown;
    structuredContent?: unknown;
  }>;
  messageStarts: string[];
  sessionCompact: number;
  turnEnds: Array<{ turnIndex: number; hasToolResults: boolean; messageEntryId: string }>;
  commandCtx:
    | {
        mode: unknown;
        hasUI: unknown;
        setEditorText: typeof Function | undefined;
        getEditorTextReturn?: string;
        registry?: string;
      }
    | undefined;
  eventCtxRegistry: string | undefined;
  toolCtxRegistry: string | undefined;
  rendererCalls: number;
}

function freshObserved(): Observed {
  return {
    beforeAgentStart: [],
    toolCalls: [],
    toolResults: [],
    messageStarts: [],
    sessionCompact: 0,
    turnEnds: [],
    commandCtx: undefined,
    eventCtxRegistry: undefined,
    toolCtxRegistry: undefined,
    rendererCalls: 0,
  };
}

/** 描述 jev 依赖面的观察扩展：before_agent_start / tool_call / tool_result /
 *  message_start / session_compact / turn_end / 命令 ctx / 渲染器。 */
function observingExtension(o: Observed, hooks: Partial<Record<string, unknown>> = {}) {
  return (pi: ExtensionAPI): void => {
    pi.on("before_agent_start", ((
      event: { messageType: string; message?: { customType?: string }; prompt?: string },
      ctx: ExtensionContext,
    ) => {
      o.beforeAgentStart.push({
        messageType: event.messageType,
        customType: event.message?.customType,
        prompt: event.prompt,
      });
      // ctx 上的 getter 有 assertActive 守卫——只能在 handler 内同步读取。
      o.eventCtxRegistry = registryShape(ctx);
      const extra = hooks.beforeAgentStart as (() => void) | undefined;
      extra?.();
    }) as never);
    pi.on("tool_call", (async (
      event: { toolName: string; toolCallId: string; parentToolCallId?: string; input: unknown },
      _ctx: unknown,
    ) => {
      const at = Date.now();
      const extra = hooks.onToolCall as
        ((e: { toolName: string; toolCallId: string; input: unknown }) => unknown) | undefined;
      const result = extra?.(event);
      o.toolCalls.push({
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        ...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
        input: event.input,
        at,
        doneAt: Date.now(),
      });
      return result;
    }) as never);
    pi.on("tool_result", ((event: {
      toolName: string;
      toolCallId: string;
      isError: boolean;
      usage?: unknown;
      structuredContent?: unknown;
    }) => {
      o.toolResults.push({
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        isError: event.isError,
        ...(event.usage === undefined ? {} : { usage: event.usage }),
        ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
      });
    }) as never);
    pi.on("message_start", ((event: { message: { customType?: string; role: string } }) => {
      o.messageStarts.push(event.message.customType ?? event.message.role);
    }) as never);
    pi.on("session_compact", (() => {
      o.sessionCompact += 1;
    }) as never);
    pi.on("turn_end", ((event: { turnIndex: number; toolResultEntryIds: string[]; messageEntryId: string }) => {
      o.turnEnds.push({
        turnIndex: event.turnIndex,
        hasToolResults: event.toolResultEntryIds.length > 0,
        messageEntryId: event.messageEntryId,
      });
    }) as never);
    pi.registerCommand("cjcmd", {
      description: "C-J7/C-J14 command-ctx probe",
      handler: async (_args: string, ctx: ExtensionContext) => {
        o.commandCtx = {
          mode: safeRead(() => ctx.mode),
          hasUI: safeRead(() => ctx.hasUI),
          setEditorText: safeRead(() => ctx.ui?.setEditorText) as typeof Function | undefined,
          getEditorTextReturn: safeRead(() => ctx.ui?.getEditorText?.()),
          registry: registryShape(ctx),
        };
      },
    });
    pi.registerMessageRenderer("subagent:memory-inject", () => {
      o.rendererCalls += 1;
      return undefined;
    });
  };
}

function safeRead<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** ctx.modelRegistry 的三个方法是否齐备（jev 的 off("pi-api") 判定输入）。 */
function registryShape(ctx: ExtensionContext): string | undefined {
  try {
    const registry = ctx.modelRegistry as unknown as Record<string, unknown> | undefined;
    if (registry === undefined) return "MISSING";
    const parts = ["classify", "getAvailableOfType", "getModelOfType"].map((m) =>
      typeof registry[m] === "function" ? m : `!${m}`,
    );
    return parts.join(",");
  } catch (err) {
    return `THREW:${(err as Error).message.slice(0, 80)}`;
  }
}

/** 双工具调用的一条 assistant 消息（C-J3）。 */
function twoToolCallsMsg(
  model: ReturnType<typeof fakeModel>,
  a: { id: string; command: string },
  b: { id: string; command: string },
) {
  return {
    role: "assistant",
    content: [
      { type: "toolCall", id: a.id, name: "bash", arguments: { command: a.command } },
      { type: "toolCall", id: b.id, name: "bash", arguments: { command: b.command } },
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

const textTurn = (m: ReturnType<typeof fakeModel>, text: string): ScriptedTurn => ({
  toolCall: false,
  build: () => assistantTextMsg(m, text),
});
const bashTurn = (m: ReturnType<typeof fakeModel>, id: string, command: string): ScriptedTurn => ({
  toolCall: true,
  build: () => {
    const msg = assistantTextMsg(m, "x") as unknown as Record<string, unknown>;
    msg.content = [{ type: "toolCall", id, name: "bash", arguments: { command } }];
    msg.stopReason = "toolUse";
    return msg;
  },
});

// ───────────────────────── C-J1 ─────────────────────────

describe("C-J1: before_agent_start is awaited; message lands after the user message, before the first LLM request", () => {
  it("handler-returned message is visible to request 1, positioned after the user message; a throwing handler is swallowed", async () => {
    const o = freshObserved();
    let sawThrowingHandler = false;
    await withSession(
      {
        scripted: [textTurn(fakeModel(), "done")],
        extensionFactories: [
          (pi: ExtensionAPI) => {
            pi.on("before_agent_start", (async () => {
              // 25ms 异步：若 pi 不 await handler，这条消息就赶不上首次请求。
              await new Promise((resolve) => setTimeout(resolve, 25));
              return {
                message: {
                  customType: "subagent:memory-inject",
                  content: [{ type: "text", text: "CJ1-INJECTED" }],
                  display: false,
                },
              };
            }) as never);
          },
          (pi: ExtensionAPI) => {
            pi.on("before_agent_start", (() => {
              sawThrowingHandler = true;
              throw new Error("CJ1-HANDLER-BOOM");
            }) as never);
          },
          observingExtension(o),
        ],
      },
      async ({ session, modelRuntime }) => {
        await session.prompt("hello cj1");
        // handler 确实被 await：注入消息出现在第 1 次请求里，且在用户消息之后。
        const first = modelRuntime.requestMessages[0]!;
        // custom 消息在 LLM 上下文里以 role:"user" 投影（convertToLlm）—— 按文本找。
        const userIdx = first.findIndex((m: { role?: string; content?: unknown }) => {
          const c = m.content;
          return m.role === "user" && Array.isArray(c) && c.some((p: { text?: string }) => p.text === "hello cj1");
        });
        const injectedIdx = first.findIndex(
          (m: { role?: string; content?: unknown }) =>
            Array.isArray(m.content) && (m.content as { text?: string }[]).some((p) => p.text === "CJ1-INJECTED"),
        );
        expect(injectedIdx).toBeGreaterThan(userIdx);
        expect(userIdx).toBeGreaterThanOrEqual(0);
        expect(first[injectedIdx]!.role).toBe("user");
        // 抛错的 handler 被吞：run 正常完成（请求发出且回复 "done"）。
        expect(sawThrowingHandler).toBe(true);
        expect(modelRuntime.callCount()).toBe(1);
        const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
        const last = branch[branch.length - 1];
        expect(JSON.stringify(last)).toContain("done");
      },
    );
  });
});

// ───────────────────────── C-J2 ─────────────────────────

describe("C-J2: tool_call block ⇒ not executed, model gets isError result; tool_result does not fire; a throwing handler blocks with its message", () => {
  it("blocked and thrown calls both produce error results for the model, zero tool_result events, zero side effects", async () => {
    const o = freshObserved();
    const model = fakeModel();
    await withSession(
      {
        scripted: [
          bashTurn(model, "cj2a", "echo cj2-ran-a > ma.txt"),
          bashTurn(model, "cj2b", "echo cj2-ran-b > mb.txt"),
          textTurn(model, "done"),
        ],
        extensionFactories: [
          (pi: ExtensionAPI) => {
            pi.on("tool_call", ((event: { toolCallId: string; input: { command?: string } }) => {
              if (event.toolCallId === "cj2a") return { block: true, reason: "CJ2-BLOCKED-BY-GATE" };
              if (event.toolCallId === "cj2b") throw new Error("CJ2-THROWN-FROM-HANDLER");
              return undefined;
            }) as never);
          },
          observingExtension(o),
        ],
      },
      async ({ session, cwd, modelRuntime }) => {
        await session.prompt("cj2 go");
        // 工具未执行：标记文件不存在（bash 从未跑过）。
        expect(existsSync(join(cwd, "ma.txt"))).toBe(false);
        expect(existsSync(join(cwd, "mb.txt"))).toBe(false);
        // tool_result 不触发（block 与 throw 都走 immediate 路径，绕过 afterToolCall）。
        expect(o.toolResults.filter((r) => r.toolCallId === "cj2a" || r.toolCallId === "cj2b")).toEqual([]);
        // 模型收到的两次工具结果都是 isError，文本分别是 reason / 抛错消息。
        const request2 = JSON.stringify(modelRuntime.requestMessages[1]);
        const request3 = JSON.stringify(modelRuntime.requestMessages[2]);
        expect(request2).toContain("CJ2-BLOCKED-BY-GATE");
        expect(request3).toContain("CJ2-THROWN-FROM-HANDLER");
        expect(modelRuntime.callCount()).toBe(3); // 两次工具轮 + 收尾
        expect(existsSync(join(cwd, "ma.txt"))).toBe(false);
        void session;
      },
    );
  });
});

// ───────────────────────── C-J3 ─────────────────────────

describe("C-J3: two tool calls in one assistant message — dispatch order and concurrency", () => {
  it("dispatch follows content order and both run concurrently (default parallel toolExecution)", async () => {
    const o = freshObserved();
    const model = fakeModel();
    await withSession(
      {
        scripted: [
          {
            toolCall: true,
            build: (m) =>
              twoToolCallsMsg(
                m,
                { id: "cj3a", command: "sleep 0.4; echo A" },
                { id: "cj3b", command: "sleep 0.4; echo B" },
              ),
          },
          textTurn(model, "done"),
        ],
        extensionFactories: [observingExtension(o)],
      },
      async ({ session, modelRuntime }) => {
        await session.prompt("cj3 go");
        // 派发顺序 = content 顺序。
        expect(o.toolCalls.map((c) => c.toolCallId)).toEqual(["cj3a", "cj3b"]);
        // 并发性：cj3a 的结果晚于 cj3b 的派发（两个 0.4s 的 bash 重叠执行）。
        const aResult = o.toolResults.find((r) => r.toolCallId === "cj3a");
        const bCall = o.toolCalls.find((c) => c.toolCallId === "cj3b")!;
        expect(aResult).toBeDefined();
        // tool_result handler 的到达时刻没有单独记录，用请求合并代替：
        // 第二次 LLM 请求必须同时带上两个工具的结果（同一轮并行收口）。
        const request2 = JSON.stringify(modelRuntime.requestMessages[1]);
        expect(request2).toContain("echo A");
        expect(request2).toContain("echo B");
        // 并发证据：两次派发间隔 ≪ 400ms（若串行，cj3b 要等 cj3a 的 0.4s bash 跑完）。
        expect(bCall.at - o.toolCalls[0]!.at).toBeLessThan(350);
        expect(o.turnEnds.some((t) => t.hasToolResults)).toBe(true);
        void session;
      },
    );
  });
});

// ───────────────────────── C-J4 ─────────────────────────

describe("C-J4: sendMessage(triggerTurn:false) inside tool_call — landing point", () => {
  it("flushes at turn_end: visible to this run's next LLM call, after the tool results, no extra turn", async () => {
    const o = freshObserved();
    const model = fakeModel();
    let piRef: ExtensionAPI | undefined;
    await withSession(
      {
        scripted: [bashTurn(model, "cj4", "sleep 0.2; echo four"), textTurn(model, "done")],
        extensionFactories: [
          (pi: ExtensionAPI) => {
            piRef = pi;
            pi.on("tool_call", (() => {
              pi.sendMessage(
                {
                  customType: "subagent:memory-inject",
                  content: [{ type: "text", text: "CJ4-FAST-PATH" }],
                  display: true,
                },
                { triggerTurn: false },
              );
              return undefined;
            }) as never);
          },
          observingExtension(o),
        ],
      },
      async ({ session, modelRuntime }) => {
        await session.prompt("cj4 go");
        // 不起额外一轮：本 run 恰好两次 LLM 调用（工具轮 + 收尾轮）。
        expect(modelRuntime.callCount()).toBe(2);
        // 落点（arch §6.1.3 原假设成立）：turn_end 时 flush —— 本 run 内下一次
        // LLM 调用即可见，且排在工具结果之后；LLM 上下文里以 role:"user" 投影。
        const request2 = modelRuntime.requestMessages[1]!;
        const request2Text = JSON.stringify(request2);
        expect(request2Text).toContain("CJ4-FAST-PATH");
        const toolResultIdx = request2.findIndex(
          (m: { role?: string; toolCallId?: string }) => m.role === "toolResult",
        );
        const injectedIdx = request2.findIndex(
          (m: { role?: string; content?: unknown }) =>
            Array.isArray(m.content) && (m.content as { text?: string }[]).some((p) => p.text === "CJ4-FAST-PATH"),
        );
        expect(toolResultIdx).toBeGreaterThan(-1);
        expect(injectedIdx).toBeGreaterThan(toolResultIdx);
        expect(request2[injectedIdx]!.role).toBe("user");
        const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
        const customIdx = branch.findIndex(
          (e) => e.type === "custom_message" && JSON.stringify(e).includes("CJ4-FAST-PATH"),
        );
        expect(customIdx).toBeGreaterThan(-1);
        // 会话树上落的是 custom_message 条目（LLM 侧才投影成 user 角色）。
        expect((branch[customIdx] as { customType?: string }).customType).toBe("subagent:memory-inject");
        void piRef;
      },
    );
  });
});

// ───────────────────────── C-J5 ─────────────────────────

describe("C-J5: tool_result carries input/isError; built-in bash exposes structuredContent.exit_code", () => {
  it("exit 7 ⇒ isError true, structuredContent.exit_code 7, input.command preserved", async () => {
    const o = freshObserved();
    const model = fakeModel();
    await withSession(
      {
        scripted: [bashTurn(model, "cj5", "exit 7"), textTurn(model, "done")],
        extensionFactories: [observingExtension(o)],
      },
      async ({ session }) => {
        await session.prompt("cj5 go");
        const result = o.toolResults.find((r) => r.toolCallId === "cj5");
        expect(result).toBeDefined();
        expect(result!.isError).toBe(true);
        expect((result!.structuredContent as { exit_code?: number })?.exit_code).toBe(7);
        const call = o.toolCalls.find((c) => c.toolCallId === "cj5");
        expect((call?.input as { command?: string })?.command).toBe("exit 7");
        void session;
      },
    );
  });
});

// ───────────────────────── C-J6 ─────────────────────────

describe("C-J6: bash-job:notification delivery paths (idle triggerTurn / streaming steer / quiet append)", () => {
  it("idle + triggerTurn:true starts a custom run (before_agent_start messageType custom); streaming + triggerTurn:true steers into the SAME run; idle + no trigger only appends", async () => {
    const o = freshObserved();
    const model = fakeModel();
    let piRef: ExtensionAPI | undefined;
    const notice = (text: string) => ({
      customType: "bash-job:notification",
      content: [{ type: "text", text }],
      display: true,
      details: { kind: "bash-job", jobId: "j1", status: "completed", exitCode: 0 },
    });
    await withSession(
      {
        scripted: [bashTurn(model, "cj6", "sleep 0.4; echo six"), textTurn(model, "done"), textTurn(model, "done2")],
        extensionFactories: [
          (pi: ExtensionAPI) => {
            piRef = pi;
            pi.on("tool_call", (() => {
              // streaming 中按 notify() 的真实参数（triggerTurn:true）发送 —— 走 steer。
              pi.sendMessage(notice("CJ6-STEERED-NOTICE"), { triggerTurn: true });
              return undefined;
            }) as never);
          },
          observingExtension(o),
        ],
      },
      async ({ session, modelRuntime }) => {
        // (b) streaming + triggerTurn:true：并入同一 run 的下一次 LLM 请求（steer 队列）。
        await session.prompt("cj6 go");
        const request2Text = JSON.stringify(modelRuntime.requestMessages[1]);
        // 与 arch 表述「streaming → message_start」不同：现状是 steer 队列 —— 同一 run
        // 内下一次请求即可见（同样以 role:"user" 投影），且不起额外一轮。
        expect(request2Text).toContain("CJ6-STEERED-NOTICE");
        const callsAfterRun = modelRuntime.callCount();
        expect(callsAfterRun).toBe(2);
        // (a) 空闲 + triggerTurn:true：新 run 的 trigger 是 custom 消息本身。
        piRef!.sendMessage(notice("CJ6-IDLE-NOTICE"), { triggerTurn: true });
        await waitFor(() => modelRuntime.callCount() > callsAfterRun, 5000);
        const lastStart = o.beforeAgentStart[o.beforeAgentStart.length - 1]!;
        expect(lastStart.messageType).toBe("custom");
        expect(lastStart.customType).toBe("bash-job:notification");
        const lastRequest = modelRuntime.requestMessages[modelRuntime.requestMessages.length - 1]!;
        const idleNoticeIdx = lastRequest.findIndex(
          (m: { role?: string; content?: unknown }) =>
            Array.isArray(m.content) && (m.content as { text?: string }[]).some((p) => p.text === "CJ6-IDLE-NOTICE"),
        );
        // 新 run 的 trigger 就是这条 custom 消息：它是请求里的最后一条（累积上下文之后）。
        expect(idleNoticeIdx).toBe(lastRequest.length - 1);
        await waitForIdle(session);
        // (c) 空闲 + triggerTurn:false：只 append（message_start/message_end），不起 run。
        const before = modelRuntime.callCount();
        piRef!.sendMessage(notice("CJ6-QUIET-NOTICE"), { triggerTurn: false });
        await waitFor(
          () =>
            (session.sessionManager.getBranch() as Array<Record<string, unknown>>).some(
              (e) => e.type === "custom_message" && JSON.stringify(e).includes("CJ6-QUIET-NOTICE"),
            ),
          5000,
        );
        expect(modelRuntime.callCount()).toBe(before);
        expect(o.messageStarts).toContain("bash-job:notification");
      },
    );
  });
});

async function waitForIdle(session: { waitForIdle?: () => Promise<void> } & Record<string, unknown>): Promise<void> {
  if (typeof session.waitForIdle === "function") await session.waitForIdle();
  else await new Promise((resolve) => setTimeout(resolve, 50));
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ───────────────────────── C-J7 (offline part) ─────────────────────────

describe("C-J7: ctx.modelRegistry availability and the three method signatures (type-level, offline)", () => {
  it("event ctx, tool execute ctx and command ctx all expose classify/getAvailableOfType/getModelOfType as functions", async () => {
    const o = freshObserved();
    const model = fakeModel();
    const probeTool = {
      name: "cj7probe",
      label: "CJ7 probe",
      description: "captures the tool execute ctx",
      parameters: Type.Object({}),
      async execute(_id: string, _params: unknown, _signal: undefined, _onUpdate: undefined, ctx: ExtensionContext) {
        o.toolCtxRegistry = registryShape(ctx);
        return { content: [{ type: "text" as const, text: "ok" }], details: undefined };
      },
    };
    await withSession(
      {
        scripted: [
          {
            toolCall: true,
            build: (m) => {
              const msg = assistantTextMsg(m, "x") as unknown as Record<string, unknown>;
              msg.content = [{ type: "toolCall", id: "cj7", name: "cj7probe", arguments: {} }];
              msg.stopReason = "toolUse";
              return msg;
            },
          },
          textTurn(model, "done"),
        ],
        tools: ["bash", "cj7probe"],
        extensionFactories: [
          observingExtension(o),
          (pi: ExtensionAPI) => {
            pi.registerTool(probeTool as never);
          },
        ],
      },
      async ({ session, modelRuntime }) => {
        await session.prompt("cj7 go");
        expect(o.eventCtxRegistry).toBe("classify,getAvailableOfType,getModelOfType");
        expect(o.toolCtxRegistry).toBe("classify,getAvailableOfType,getModelOfType");
        expect(modelRuntime.callCount()).toBe(2);
        await session.prompt("/cjcmd");
        expect(o.commandCtx).toBeDefined();
        expect(o.commandCtx!.registry).toBe("classify,getAvailableOfType,getModelOfType");
      },
    );
  });
});

// ───────────────────────── C-J9 ─────────────────────────

describe("C-J9: skill expansion block format in event.prompt (strip-rule basis)", () => {
  it("'/skill:<name> args' expands to a <skill …>…</skill> block; unknown /commands pass through", async () => {
    const prompts: string[] = [];
    const model = fakeModel();
    const cwd = mkdtempSync(join(tmpdir(), "jev-cj9-"));
    const agentDir = join(cwd, ".pi-agent");
    mkdirSync(join(agentDir, "skills", "jev-conf"), { recursive: true });
    writeFileSync(
      join(agentDir, "skills", "jev-conf", "SKILL.md"),
      "---\ndescription: conformance probe skill\n---\n\n# Probe\n\nBody line of the skill.\n",
    );
    const modelRuntime = fakeModelRuntime(model, [textTurn(model, "done")]);
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [
        (pi: ExtensionAPI) => {
          pi.on("before_agent_start", ((event: { prompt?: string }) => {
            prompts.push(event.prompt ?? "");
          }) as never);
        },
      ] as never,
    });
    await loader.reload();
    const sessionManager = SessionManager.inMemory(cwd);
    const { session } = await createAgentSession({
      cwd,
      model: model as never,
      modelRuntime: modelRuntime as never,
      sessionManager,
      settingsManager,
      resourceLoader: loader,
      tools: ["bash"],
    });
    try {
      await session.prompt("/skill:jev-conf do the thing");
      await session.prompt("/no-such-command-here hello");
      const expanded = prompts.find((p) => p.includes("Body line of the skill"))!;
      // 剥离规则的依据：整块被 <skill name=… location=…> … </skill> 包裹，块后跟参数文本。
      expect(expanded.startsWith('<skill name="jev-conf" location="')).toBe(true);
      expect(expanded).toContain("</skill>\n\ndo the thing");
      expect(expanded).toContain("Body line of the skill.");
      // 未知 / 命令原样透传（未匹配的 skill 不展开）。
      expect(prompts).toContain("/no-such-command-here hello");
    } finally {
      session.dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ───────────────────────── C-J10 ─────────────────────────

describe("C-J10: compaction entries and turn_end checkpoints", () => {
  it("manual compact() writes a compaction entry with the summary; turn_end fires per turn with entry ids; post-compact requests drop the original text", async () => {
    const o = freshObserved();
    const model = fakeModel();
    await withSession(
      {
        scripted: [
          bashTurn(model, "cj10", "echo ten"),
          textTurn(model, "FIRST-REPLY"),
          textTurn(model, "COMPACTION-SUMMARY"),
        ],
        compaction: { keepRecentTokens: 1 },
        extensionFactories: [observingExtension(o)],
      },
      async ({ session, modelRuntime }) => {
        await session.prompt("hello cj10 secret-token-one");
        expect(modelRuntime.callCount()).toBe(2);
        await session.compact();
        expect(o.sessionCompact).toBe(1);
        const branch = session.sessionManager.getBranch() as Array<Record<string, unknown>>;
        const compaction = branch.find((e) => e.type === "compaction");
        expect(compaction).toBeDefined();
        expect(JSON.stringify(compaction)).toContain("COMPACTION-SUMMARY");
        // turn_end 检查点：每个 assistant 轮一条，带 messageEntryId；工具轮带 toolResultEntryIds。
        expect(o.turnEnds.length).toBeGreaterThanOrEqual(2);
        expect(o.turnEnds.some((t) => t.hasToolResults && t.messageEntryId !== "")).toBe(true);
        const indices = o.turnEnds.map((t) => t.turnIndex);
        expect([...indices].sort((a, b) => a - b)).toEqual(indices);
        // 压缩后新请求只含摘要，不含原始文本（子会话 B 层重注的判定输入）。
        await session.prompt("after compact");
        const lastRequest = JSON.stringify(modelRuntime.requestMessages[modelRuntime.requestMessages.length - 1]);
        expect(lastRequest).not.toContain("secret-token-one");
        expect(lastRequest).toContain("COMPACTION-SUMMARY");
      },
    );
  });
});

// ───────────────────────── C-J11 ─────────────────────────

describe("C-J11: nested ctx.executeTool goes through tool_call/tool_result with parentToolCallId", () => {
  it("a tool calling ctx.executeTool('bash') fires both hooks; nested id is <parent>/1", async () => {
    const o = freshObserved();
    const model = fakeModel();
    const outer = {
      name: "cj11outer",
      label: "CJ11 outer",
      description: "calls bash via ctx.executeTool",
      parameters: Type.Object({ nested_command: Type.String() }),
      async execute(
        _id: string,
        params: { nested_command: string },
        _signal: undefined,
        _onUpdate: undefined,
        ctx: {
          executeTool: (
            name: string,
            args: unknown,
          ) => Promise<{ isError?: boolean; result?: { content?: { text?: string }[] } }>;
        },
      ) {
        const outcome = await ctx.executeTool("bash", { command: params.nested_command });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(outcome.result?.content?.[0]?.text ?? "") }],
          details: undefined,
        };
      },
    };
    await withSession(
      {
        scripted: [
          {
            toolCall: true,
            build: (m) => {
              const msg = assistantTextMsg(m, "x") as unknown as Record<string, unknown>;
              msg.content = [
                { type: "toolCall", id: "cj11", name: "cj11outer", arguments: { nested_command: "echo cj11-nested" } },
              ];
              msg.stopReason = "toolUse";
              return msg;
            },
          },
          textTurn(model, "done"),
        ],
        tools: ["bash", "cj11outer"],
        extensionFactories: [
          observingExtension(o),
          (pi: ExtensionAPI) => {
            pi.registerTool(outer as never);
          },
        ],
      },
      async ({ session }) => {
        await session.prompt("cj11 go");
        const outerCall = o.toolCalls.find((c) => c.toolCallId === "cj11");
        const nestedCall = o.toolCalls.find((c) => c.toolName === "bash");
        expect(outerCall).toBeDefined();
        expect(outerCall!.parentToolCallId).toBeUndefined();
        expect(nestedCall).toBeDefined();
        expect(nestedCall!.parentToolCallId).toBe("cj11");
        expect(nestedCall!.toolCallId.startsWith("cj11/")).toBe(true);
        const nestedResult = o.toolResults.find((r) => r.toolCallId.startsWith("cj11/"));
        expect(nestedResult).toBeDefined();
        expect(nestedResult!.isError).toBe(false);
        void session;
      },
    );
  });
});

// ───────────────────────── C-J12 ─────────────────────────

describe("C-J12: tool results can carry usage; tool_result exposes it (JevWritePort.afterWrite landing)", () => {
  it("a tool returning usage surfaces on the tool_result event unchanged", async () => {
    const o = freshObserved();
    const model = fakeModel();
    const usageTool = {
      name: "cj12usage",
      label: "CJ12 usage",
      description: "returns usage",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text" as const, text: "cj12-echo" }],
          details: undefined,
          usage: {
            input: 11,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 11,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0025 },
          },
        };
      },
    };
    await withSession(
      {
        scripted: [
          {
            toolCall: true,
            build: (m) => {
              const msg = assistantTextMsg(m, "x") as unknown as Record<string, unknown>;
              msg.content = [{ type: "toolCall", id: "cj12", name: "cj12usage", arguments: {} }];
              msg.stopReason = "toolUse";
              return msg;
            },
          },
          textTurn(model, "done"),
        ],
        tools: ["bash", "cj12usage"],
        extensionFactories: [
          observingExtension(o),
          (pi: ExtensionAPI) => {
            pi.registerTool(usageTool as never);
          },
        ],
      },
      async ({ session, modelRuntime }) => {
        await session.prompt("cj12 go");
        const result = o.toolResults.find((r) => r.toolCallId === "cj12");
        expect(result).toBeDefined();
        expect((result!.usage as { input?: number })?.input).toBe(11);
        expect((result!.usage as { cost?: { total?: number } })?.cost?.total).toBe(0.0025);
        // usage 是工具自身的口径，不并入主 LLM 上下文记账（模型侧只见 content）。
        const request2 = JSON.stringify(modelRuntime.requestMessages[1]);
        expect(request2).toContain("cj12-echo");
        void session;
      },
    );
  });
});

// ───────────────────────── C-J13 ─────────────────────────

describe("C-J13: registerMessageRenderer for subagent:memory-inject (headless)", () => {
  it("registration is accepted; the message reaches the model; renderer is not invoked headless (TUI-only)", async () => {
    const o = freshObserved();
    const model = fakeModel();
    let piRef: ExtensionAPI | undefined;
    await withSession(
      {
        scripted: [textTurn(model, "done"), textTurn(model, "done2")],
        extensionFactories: [
          (pi: ExtensionAPI) => {
            piRef = pi;
          },
          observingExtension(o),
        ],
      },
      async ({ session, modelRuntime }) => {
        piRef!.sendMessage(
          {
            customType: "subagent:memory-inject",
            content: [{ type: "text", text: "CJ13-CONTENT" }],
            display: true,
          },
          { triggerTurn: false },
        );
        await waitFor(
          () =>
            (session.sessionManager.getBranch() as Array<Record<string, unknown>>).some(
              (e) => e.type === "custom_message" && JSON.stringify(e).includes("CJ13-CONTENT"),
            ),
          5000,
        );
        await session.prompt("cj13 go");
        expect(JSON.stringify(modelRuntime.requestMessages[0])).toContain("CJ13-CONTENT");
        // headless（无 TUI）：渲染器不会被调用 —— 折叠展示属于 TUI 面，
        // 由真机验收（live-acceptance）覆盖，不在本文件伪造。
        expect(o.rendererCalls).toBe(0);
      },
    );
  });
});

// ───────────────────────── C-J14 ─────────────────────────

describe("C-J14: ctx.ui.setEditorText in a command context", () => {
  it('exists and is callable in the command ctx (headless = no-op stub), getEditorText returns ""', async () => {
    const o = freshObserved();
    await withSession({ scripted: [], extensionFactories: [observingExtension(o)] }, async ({ session }) => {
      await session.prompt("/cjcmd");
      expect(o.commandCtx).toBeDefined();
      expect(typeof o.commandCtx!.setEditorText).toBe("function");
      // 无 TUI 的会话给 noOpUIContext：调用不抛错、getEditorText 恒空串。
      expect(o.commandCtx!.getEditorTextReturn).toBe("");
      expect(o.commandCtx!.mode).toBe("print");
      expect(o.commandCtx!.hasUI).toBe(false);
      void session;
    });
  });
});

// ───────────────────────── gated: C-J7 (real), C-J8, C-J15 ─────────────────────────

(GATED ? describe : describe.skip)("gated live classifier checks", () => {
  it.skip(`C-J7 real call + C-J8 error text + C-J15 catalog/availability — ${GATED_SKIP_REASON}`, () => {
    // 占位：真实调用（fetch 透传、abort、错误文本 `<Provider> API error (<status>): …`、
    // 上下文超限措辞）与 opencode/openrouter 目录/可用性探测由主会话在 E0 旁路任务里
    // 用凭证执行；本文件保持零网络。
  });
});

describe("C-J15 (offline catalog part): jev classifier ids exist in pi-ai's model catalog", () => {
  it("the opencode/openrouter classifier catalogs list jev-1.13/-free and typesafe/jev-1.13/-1.14", () => {
    // 目录级断言（零网络）：pi-ai 的 provider catalog 子路径导出就是
    // ModelRegistry.getModelsOfType("classifier") 的数据源。可用性（凭证）与
    // 真实调用在门控部分（E0）。
    const opencode = Object.values(OPENCODE_CLASSIFIER_MODELS).map((m) => `${m.provider}/${m.id}`);
    const openrouter = Object.values(OPENROUTER_CLASSIFIER_MODELS).map((m) => `${m.provider}/${m.id}`);
    expect(opencode).toContain("opencode/jev-1.13");
    expect(opencode).toContain("opencode/jev-1.13-free");
    expect(openrouter).toContain("openrouter/typesafe/jev-1.13");
    expect(openrouter).toContain("openrouter/typesafe/jev-1.14");
  });
});
