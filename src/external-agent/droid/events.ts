/**
 * droid 通知 → DriverEvent 纯映射器（plan §4.5/§4.9，arch §8.1 修订版：策略行删除、
 * request_permission 行移到 §4.3 由 session 处理、thinking 按 S11）。
 *
 * 纯：不触盘、不起进程；usage 走注入的 UsageLedger（P2 实现，测试注入假账本），
 * transcript 走注入的 append 回调。可用 samples/ 回放。
 *
 * 关键实测行为（droid-protocol §13）：
 * - tool_call 的 input 渐进流式（同 id 多次）⇒ 取最后一次（S/27/30/31）。
 * - interrupt 时 tool_result 重复发两次、S/31 还有第二条 "Batch cancelled" ⇒ 按 toolUseId 去重。
 * - create_message 的 visibility:"llm_only" 是上下文注入 ⇒ 过滤（连 transcript 也不写）。
 * - thinking_text_delta 流式全文 ⇒ thinking_delta；thinking_text_complete 不载文本 ⇒ 不映射；
 *   create_message 的 thinking 块只在该 messageId 从未收到 delta 时补发一次（§4.9）。
 * - agent_turn_completed.tokenUsage 是**本 turn 增量**（对账权威），cumulativeTokenUsage 是累计（S10）。
 */
import type { Clock } from "../../core/clock.js";
import { previewToolArgs } from "../../core/tool-preview.js";
import type { DriverEvent, UsageDelta } from "../../core/types.js";
import type { UsageLedger } from "../types.js";
import { DROID_EXTERNAL_META_THROTTLE_MS } from "./protocol.js";
import { droidTokenCounts } from "./usage-fields.js";

const ZERO_COUNTS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, credits: 0 } as const;

export interface DroidTurnCompletion {
  reason: string;
  turnId?: string;
}

export interface DroidMapperHooks {
  emit(e: DriverEvent): void;
  ledger: UsageLedger;
  clock: Clock;
  /** resume 会话首 turn 无基线（L1：避免把历史用量记进本 run）。 */
  resume: boolean;
  /** transcript 里 assistant 消息的 model 字段（"droid/<id>"）。 */
  modelRef: string;
  appendTranscript?(entry: { type: "message"; message: unknown }): void;
  /** session 用来清权限回执计时器（§4.3）。 */
  onToolResult?(toolUseId: string): void;
  /** turn 终结（session 据此结算 prompt()）。在 tool_end/turn_end/message_end/settled 之后调用。 */
  onTurnCompleted?(c: DroidTurnCompletion): void;
  /** assistant 消息落地（session 据此节流轮询 get_context_stats）。 */
  onAssistantMessage?(): void;
}

export interface DroidMapper {
  /** 喂入一条 params.notification 对象；畸形输入记 unknownNotifications，绝不 throw。 */
  notify(n: unknown): void;
  /** 本 turn 收集到的 error 通知文本（原始、未脱敏——脱敏在 session 侧）。 */
  errors(): readonly string[];
  /** prompt 开始时清本 turn 的 error 列表。 */
  resetTurnErrors(): void;
  lastAssistantText(): string | undefined;
  /** 有已开始但未被 agent_turn_completed 结算的 agent turn（r3 对账开关）。 */
  turnOpen(): boolean;
  unknownNotifications(): number;
}

interface ToolMeta {
  name: string;
  input: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

function mergeUsage(a: UsageDelta | undefined, b: UsageDelta | undefined): UsageDelta | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const unpriced =
    a.unpriced === "all" || b.unpriced === "all"
      ? ("all" as const)
      : a.unpriced === "partial" || b.unpriced === "partial"
        ? ("partial" as const)
        : undefined;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    costUsd: a.costUsd + b.costUsd,
    ...(unpriced === undefined ? {} : { unpriced }),
  };
}

export function createDroidMapper(hooks: DroidMapperHooks): DroidMapper {
  const { emit, ledger, clock } = hooks;
  let inTurn = false;
  let turnIndex = 0;
  let toolResultsSinceAssistant = 0;
  let compacting = false;
  const pendingToolInput = new Map<string, ToolMeta>();
  const openTools = new Map<string, ToolMeta>();
  const endedTools = new Set<string>();
  const toolNames = new Map<string, string>();
  const seenTurnIds = new Set<string>();
  const thinkingDeltaSeen = new Set<string>();
  let lastAssistant: string | undefined;
  let turnErrors: string[] = [];
  let pendingUsage: UsageDelta | undefined;
  let unknown = 0;
  let lastMetaAt = 0;
  let overcountReported = false;

  const bufferUsage = (delta: UsageDelta | undefined): void => {
    pendingUsage = mergeUsage(pendingUsage, delta);
  };
  const flushUsage = (): UsageDelta | undefined => {
    const u = pendingUsage;
    pendingUsage = undefined;
    return u;
  };
  /** turn 终结时的 external_meta（credits/thinking/child 单调，reducer max 合并）。 */
  const emitTotalsMeta = (): void => {
    const totals = ledger.totals();
    emit({
      t: "external_meta",
      meta: {
        provider: "droid",
        credits: totals.credits,
        thinkingTokens: totals.thinking,
        childTokens: totals.childTokens,
        unknownNotifications: unknown,
      },
    });
    if (totals.overcount && !overcountReported) {
      overcountReported = true;
      emit({ t: "external_meta", meta: { provider: "droid", degraded: ["usage_overcount"] } });
    }
  };

  const startTurn = (): void => {
    // L1：fresh 首 turn 基线全 0；resume 首 turn 无基线；之后 = 最近累计快照。
    ledger.beginTurn(turnIndex === 0 ? (hooks.resume ? undefined : { ...ZERO_COUNTS }) : ledger.lastCumulative());
    turnIndex++;
    inTurn = true;
    emit({ t: "turn_start" });
  };

  const startTool = (id: string, name: string | undefined, input: unknown): void => {
    const meta: ToolMeta = pendingToolInput.get(id) ?? { name: name ?? "unknown", input: undefined };
    if (name !== undefined) meta.name = name;
    if (input !== undefined) meta.input = input;
    pendingToolInput.delete(id);
    openTools.set(id, meta);
    toolNames.set(id, meta.name);
    const argsPreview = previewToolArgs(meta.input);
    emit({
      t: "tool_start",
      toolCallId: id,
      toolName: meta.name,
      ...(argsPreview === undefined ? {} : { argsPreview }),
    });
  };

  const onWorkingState = (state: string | undefined): void => {
    if (state === "compacting_conversation") {
      if (!compacting) {
        compacting = true;
        emit({ t: "compaction_start", reason: "droid" });
      }
      return;
    }
    if (compacting) {
      compacting = false;
      emit({ t: "compaction_end", aborted: false });
    }
    if (state === "thinking" || state === "streaming_assistant_message") {
      if (!inTurn) {
        startTurn();
      } else if (toolResultsSinceAssistant > 0) {
        // pi 的 turn = 一次 assistant 消息 + 其工具结果；工具结果后的下一次模型调用开新 turn。
        emit({ t: "turn_end", toolResults: toolResultsSinceAssistant });
        toolResultsSinceAssistant = 0;
        startTurn();
      }
    }
    // executing_tool / idle / waiting_for_tool_confirmation：无事件
    // （idle 由 agent_turn_completed 处理，confirmation 由反向请求处理）。
  };

  const onCreateMessage = (msg: unknown): void => {
    if (msg === null || typeof msg !== "object") {
      unknown++;
      return;
    }
    const m = msg as Record<string, unknown>;
    if (m.visibility === "llm_only") return; // 上下文注入：过滤，连 transcript 也不写
    const id = str(m.id);
    if (id !== undefined && (id.startsWith("__internal__") || id.startsWith("context-"))) return;
    const role = str(m.role);
    const content = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [];

    if (role === "user") {
      const text = content
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
      if (text.length > 0)
        hooks.appendTranscript?.({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
      return;
    }

    if (role !== "assistant") return; // system 等：不入事件流、不入 transcript（pi 投影不认识）

    // thinking 块：仅当该消息从未有 thinking_text_delta 时补发一次（S11/§4.9）。
    const hasDelta = id !== undefined && thinkingDeltaSeen.has(id);
    if (!hasDelta)
      for (const b of content)
        if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.length > 0)
          emit({ t: "thinking_delta", delta: b.thinking });

    // tool_use 块：assistant 消息晚于执行开始的兜底（正常路径 tool_call/phase_changed 已 start）。
    for (const b of content) {
      if (b?.type !== "tool_use") continue;
      const callId = str(b.id);
      if (callId === undefined || openTools.has(callId) || endedTools.has(callId)) continue;
      startTool(callId, str(b.name), b.input);
    }

    const text = content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    if (text.trim().length > 0) lastAssistant = text;

    const usage = flushUsage();
    emit({ t: "message_end", ...(usage === undefined ? {} : { usage }) });

    const piContent: unknown[] = [];
    for (const b of content) {
      if (b?.type === "thinking" && typeof b.thinking === "string")
        piContent.push({ type: "thinking", thinking: b.thinking });
      else if (b?.type === "text" && typeof b.text === "string") piContent.push({ type: "text", text: b.text });
      else if (b?.type === "tool_use")
        piContent.push({
          type: "toolCall",
          id: str(b.id) ?? "",
          name: str(b.name) ?? "unknown",
          arguments: b.input ?? {},
        });
    }
    hooks.appendTranscript?.({
      type: "message",
      message: { role: "assistant", content: piContent, model: hooks.modelRef },
    });
    hooks.onAssistantMessage?.();
  };

  const onToolResult = (n: Record<string, unknown>): void => {
    const id = str(n.toolUseId);
    if (id === undefined) return;
    if (endedTools.has(id)) return; // 去重：interrupt 重复发两次 / "Batch cancelled" 第二条（S/27、S/31）
    if (!openTools.has(id)) startTool(id, toolNames.get(id), undefined); // 兜底：漏了 tool_call
    openTools.delete(id);
    endedTools.add(id);
    const name = toolNames.get(id) ?? "unknown";
    const isError = n.isError === true;
    emit({ t: "tool_end", toolCallId: id, toolName: name, isError });
    toolResultsSinceAssistant++;
    hooks.appendTranscript?.({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content: [
          { type: "text", text: typeof n.content === "string" ? n.content : JSON.stringify(n.content ?? null) },
        ],
        isError,
      },
    });
    hooks.onToolResult?.(id);
  };

  const onUsageChanged = (n: Record<string, unknown>): void => {
    const counts = droidTokenCounts(n.tokenUsage);
    if (counts === undefined) return;
    const delta = ledger.observeCumulative(counts, droidTokenCounts(n.lastCallTokenUsage));
    bufferUsage(delta);
    // credits 变化节流上报（arch §8.1；external_meta 不刷新活性）。
    const now = clock.now();
    if (delta !== undefined && now - lastMetaAt >= DROID_EXTERNAL_META_THROTTLE_MS) {
      lastMetaAt = now;
      const totals = ledger.totals();
      emit({
        t: "external_meta",
        meta: {
          provider: "droid",
          credits: totals.credits,
          thinkingTokens: totals.thinking,
          childTokens: totals.childTokens,
        },
      });
    }
  };

  const onTurnCompleted = (n: Record<string, unknown>): void => {
    const turnId = str(n.turnId);
    if (turnId !== undefined) {
      if (seenTurnIds.has(turnId)) return; // 重复 turnId（防御）
      seenTurnIds.add(turnId);
    }
    // 完成时补所有还开着的 tool 的 tool_end（interrupt 路径 droid 可能漏发/被我们去重掉）。
    for (const [id, meta] of [...openTools]) {
      openTools.delete(id);
      endedTools.add(id);
      emit({ t: "tool_end", toolCallId: id, toolName: meta.name, isError: true });
    }
    if (inTurn) emit({ t: "turn_end", toolResults: toolResultsSinceAssistant });
    inTurn = false;
    toolResultsSinceAssistant = 0;

    const turnCounts = droidTokenCounts(n.tokenUsage);
    // L3/L6：child 恒传入账本；是否计入 target 由账本的 cumulativeIncludesChild 口径（E3 常量）决定。
    const remainder =
      turnCounts === undefined ? undefined : ledger.completeTurn(turnCounts, droidTokenCounts(n.childTokenUsage));
    const usage = mergeUsage(flushUsage(), remainder);
    if (usage !== undefined) emit({ t: "message_end", usage });
    emitTotalsMeta();
    emit({ t: "settled" });
    hooks.onTurnCompleted?.({ reason: str(n.reason) ?? "completed", ...(turnId === undefined ? {} : { turnId }) });
  };

  return {
    notify(n: unknown): void {
      if (n === null || typeof n !== "object") {
        unknown++;
        return;
      }
      const notif = n as Record<string, unknown>;
      const type = str(notif.type);
      switch (type) {
        case "droid_working_state_changed":
          onWorkingState(str(notif.newState));
          return;
        case "assistant_text_delta":
          if (typeof notif.textDelta === "string" && notif.textDelta.length > 0)
            emit({ t: "text_delta", delta: notif.textDelta });
          return;
        case "thinking_text_delta": {
          const messageId = str(notif.messageId);
          if (messageId !== undefined) thinkingDeltaSeen.add(messageId);
          if (typeof notif.textDelta === "string" && notif.textDelta.length > 0)
            emit({ t: "thinking_delta", delta: notif.textDelta });
          return;
        }
        case "thinking_text_complete": // S11：不载文本，不映射
        case "assistant_text_complete":
        case "settings_updated": // 生效值校验由 provider/session 直接读通知
        case "mcp_status_changed":
        case "session_title_updated":
        case "permission_resolved": // §4.3 回执清理由 session 在委托给 mapper 前处理
          return;
        case "create_message":
          onCreateMessage(notif.message);
          return;
        case "tool_call": {
          const toolUse = notif.toolUse;
          if (toolUse === null || typeof toolUse !== "object") return;
          const tu = toolUse as Record<string, unknown>;
          const id = str(tu.id);
          if (id === undefined) return;
          const name = str(tu.name);
          if (name !== undefined) toolNames.set(id, name);
          pendingToolInput.set(id, { name: name ?? toolNames.get(id) ?? "unknown", input: tu.input }); // 渐进 input，取最后一次
          return;
        }
        case "tool_execution_phase_changed": {
          const id = str(notif.toolUseId);
          if (id === undefined) return;
          const name = str(notif.toolName);
          if (name !== undefined) toolNames.set(id, name);
          const phase = str(notif.phase);
          if ((phase === "queued" || phase === "executing") && !openTools.has(id) && !endedTools.has(id))
            startTool(id, name, undefined); // 兜底：assistant 消息晚于执行开始
          return;
        }
        case "tool_progress_update": {
          const id = str(notif.toolUseId);
          if (id !== undefined) emit({ t: "tool_update", toolCallId: id });
          return;
        }
        case "tool_result":
          onToolResult(notif);
          return;
        case "session_token_usage_changed":
          onUsageChanged(notif);
          return;
        case "agent_turn_completed":
          onTurnCompleted(notif);
          return;
        case "error":
          turnErrors.push(str(notif.message) ?? "unknown droid error");
          return;
        default:
          unknown++; // 前向兼容；计数随 external_meta 上报
          return;
      }
    },
    errors: () => turnErrors,
    resetTurnErrors: () => {
      turnErrors = [];
    },
    lastAssistantText: () => lastAssistant,
    turnOpen: () => inTurn,
    unknownNotifications: () => unknown,
  };
}
