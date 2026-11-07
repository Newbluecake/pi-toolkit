import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentSettings } from "../config/settings.js";
import type { StackHolder } from "../holder.js";
import { PendingHandoffStore } from "../context-switch/store.js";
import { createSwitchContextTool } from "../context-switch/tool.js";
import { createSwitchContextCompactHook } from "../context-switch/hook.js";
import { createSessionFactsProvider } from "../context-switch/session-facts.js";
import type { TodoTrackerSnapshot } from "../todo/nudge.js";
import { createCompactHintHook } from "./hook.js";
import { createCompactTool } from "./compact-tool.js";
import { createSetCompactThresholdTool } from "./threshold-tool.js";

/**
 * compact-hint / context-switch registrations moved verbatim out of `activate()` (#56 batch 2 step 5-4).
 * The two calls stay at their ORIGINAL positions in `activate()` (hooks right after the holder-routed delivery
 * hooks, tools after the core tools): the activation trace golden pins the interleaving with load / quota hooks.
 */
export function registerCompactHooks(
  pi: ExtensionAPI,
  deps: { holder: StackHolder; handoffStore: PendingHandoffStore },
): void {
  const { holder, handoffStore } = deps;
  pi.on(
    "turn_end",
    createCompactHintHook(holder, {
      sendMessage: (message, options) => pi.sendMessage(message, options),
      // deliverAs:"followUp": pi 1.2 counts the whole _prepareRun window (pre-compaction check +
      // all before_agent_start handlers) as busy, so the post-force onComplete resume can land
      // while a new run is starting — without deliverAs the text is silently dropped there
      // (extension_error only); idle runs ignore the option byte-for-byte (pi-1.2-compat §6.1).
      sendUserMessage: (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }),
      handoffPending: () => handoffStore.hasFresh(),
    }),
  );
  // compact-hint 动态阈值（dynamic-threshold-plan.md D3 §5.4）：三个新事件 handler。全部经
  // holder 读当前会话的 runtime（/reload 后自然指向新 stack），mode=off / 惰性 runtime 下
  // 全部 no-op（§11.3 回滚保证 1：首行判空）。注册一次 per activate()（I7）。
  pi.on("tool_call", (event) => {
    if (!holder.current?.dynamic) return;
    // 纯辅助诊断：只记「叫过 switch_context」，恒不拦截、不改 event.input（T-D3-TOOLCALL-PASSTHRU）。
    const toolName = (event as { toolName?: unknown }).toolName;
    if (toolName === "switch_context") holder.current.dynamic.onToolCall(toolName);
  });
  pi.on("session_compact", (event, ctx) => {
    if (!holder.current?.dynamic) return;
    holder.current.dynamic.onSessionCompact(event, ctx);
  });
  pi.on("model_select", (event) => {
    if (!holder.current?.dynamic) return;
    holder.current.dynamic.noteModelSelected((event as { model?: unknown }).model);
  });
}

/** Whole body sits inside the `settings.compact.enabled` gate (original behaviour). */
export function registerCompactTools(
  pi: ExtensionAPI,
  deps: {
    holder: StackHolder;
    settings: AgentSettings;
    handoffStore: PendingHandoffStore;
    /** Only passed while the todo nudge tracker exists (otherwise the key stays absent from the tool deps). */
    todoTracker?: () => TodoTrackerSnapshot;
  },
): void {
  const { holder, settings, handoffStore } = deps;
  if (settings.compact.enabled) {
    if (settings.compact.switchTool) {
      pi.registerTool(
        createSwitchContextTool({
          store: handoffStore,
          // deliverAs:"followUp": on pi 1.2 the onComplete resume can race a run that is still
          // inside its startup window (busy) — queue instead of dropping (pi-1.2-compat §6.1);
          // idle behavior is byte-identical on every supported pi version.
          sendUserMessage: (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }),
          // todo-nudge switch-before hint (L1 feature): only wired when the
          // tracker is actually active — wireTodo returns no port at all
          // when todo.nudge is disabled or todo itself is off, so a disabled
          // feature stays byte-identical to "not injected".
          ...(deps.todoTracker ? { todoTracker: deps.todoTracker } : {}),
        }),
      );
      // 模型自写的交接文本在这里变成 pi 压缩条目的 summary（零摘要 LLM 调用）。
      pi.on(
        "session_before_compact",
        createSwitchContextCompactHook({
          store: handoffStore,
          sessionFacts: createSessionFactsProvider(holder, settings),
          // R2-1：唯一因果信号——交接文本真的被采用时开火（带 seq），供动态遥测建 handoffMarker。
          onApplied: (info) => holder.current?.dynamic?.noteHandoffApplied(info),
          debug: process.env.PI_SUBAGENT_DEBUG_COMPACT_HINT === "1",
        }),
      );
      // 压缩失败/被取消：交接文本作废，绝不能留给下一次（可能是几十轮后）的压缩。
      // 动态遥测的两个 marker 同步清（§5.4 清除③；归因不能落在失败的一次上）。
      pi.on("session_compact_failed", () => {
        handoffStore.clear();
        holder.current?.dynamic?.clearMarkers("compact-failed");
      });
      pi.on("session_shutdown", () => handoffStore.clear());
    }
    // 彻底替换为默认：switchTool 开启时不再暴露 compact_context，
    // 除非显式 compact.keepCompactTool=true（回退开关）。
    if (!settings.compact.switchTool || settings.compact.keepCompactTool) {
      // Same deliverAs rationale as the switch_context closure above (pi-1.2-compat §6.1).
      pi.registerTool(
        createCompactTool({ sendUserMessage: (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }) }),
      );
    }
    pi.registerTool(
      createSetCompactThresholdTool({
        getState: () => holder.current?.compactHint,
        compactToolEnabled: () => settings.compact.enabled,
        toolName: settings.compact.switchTool ? "switch_context" : "compact_context",
        dynamic: { view: () => holder.current?.dynamic?.statusView() },
      }),
    );
  }
}
