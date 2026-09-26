import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { renderHandoffCore, validateHandoff } from "../context-switch/handoff.js";
import type { PendingHandoffStore } from "../context-switch/store.js";
import { buildHandoffAdvisory, type TodoTrackerSnapshot } from "../todo/nudge.js";

/**
 * "switch_context" — 上下文切换：模型把"要带到下一段上下文的状态"写进参数，
 * 这段文本经 `session_before_compact` 直接成为压缩条目的 summary（零摘要 LLM 调用）。
 *
 * 与 compact_context 的区别（docs/dev/context-switch/context-switch-plan.md §1）：
 * compact_context 触发 pi 的通用摘要（再跑一次 LLM，模型只能通过 instructions 间接影响保留内容）；
 * switch_context 的保留内容 100% 由模型撰写，且 `keep_recent:false` 时压缩点之前的消息全部丢弃，
 * 语义等同"换到下一个会话"，但会话文件、在跑的 subagent、todo、成本统计都不受影响。
 *
 * 机制沿用 compact-tool 的结论（其头注释）：
 * - `ctx.compact()` 会同步 abort 当前 turn，execute() 必须立即返回，绝不 await 压缩完成；
 * - 因此压缩后的"继续干活"靠 onComplete 里的 follow-up 用户消息；
 * - 后台 subagent 因 detachSignalOnStart 不受这次 abort 影响。
 */

export const SwitchContextToolParams = Type.Object({
  goal: Type.String({
    description:
      "REQUIRED. The overall objective, including the user's original request in their own terms. This replaces the conversation — if it is not here, it is lost.",
  }),
  progress: Type.String({
    description: "REQUIRED. What has been done so far and where the work currently stands (facts, not plans).",
  }),
  next_steps: Type.String({
    description: "REQUIRED. The ordered plan for what to do next, concrete enough to act on without the old context.",
  }),
  decisions: Type.Optional(
    Type.String({
      description: "Decisions already made, user preferences and explicit prohibitions, with their reasons.",
    }),
  ),
  key_files: Type.Optional(
    Type.Array(Type.String(), {
      description: "Key file paths, each with a short note on its role, e.g. 'src/foo.ts — request router'.",
    }),
  ),
  pitfalls: Type.Optional(
    Type.String({ description: "Dead ends, failed attempts and gotchas, so the next context does not repeat them." }),
  ),
  open_questions: Type.Optional(
    Type.String({ description: "Unresolved questions or things awaiting user confirmation." }),
  ),
  keep_recent: Type.Optional(
    Type.Boolean({
      description:
        "Keep the most recent messages in addition to your handoff text. Default true. Set false for a clean switch where ONLY your handoff text survives.",
    }),
  ),
  resume: Type.Optional(
    Type.Boolean({ description: "Automatically continue the current task after the switch. Default true." }),
  ),
});
export type SwitchContextToolParams = Static<typeof SwitchContextToolParams>;

export interface SwitchContextToolDeps {
  store: PendingHandoffStore;
  /** activate() 时注入的 pi.sendUserMessage，便于单测。 */
  sendUserMessage: (text: string) => void;
  /** 两次切换之间的最小间隔。默认 60s。 */
  cooldownMs?: number;
  now?: () => number;
  /**
   * todo-nudge 的只读端口（L1 feature）：给一句"交接会带走 N 个未完成任务"的
   * 提示，不依赖 todo 模块内部——只读一个状态快照。省略时（todo.nudge 关闭/
   * 未启用）这条提示完全不出现，行为与功能不存在时一致。
   */
  todoTracker?: () => TodoTrackerSnapshot;
}

export const SWITCH_RESUME_TEXT =
  "[switch_context] 上下文已切换：此前的历史已被你自己撰写的交接内容取代。" +
  "请以交接内容为准继续当前任务；细节不足时读取其中列出的文件或上一段会话文件，不要凭空假设。" +
  "除非上下文再次涨到高位，不要再次调用 switch_context。";

export const SWITCH_FALLBACK_TEXT =
  "[switch_context] 压缩已完成，但你的交接文本未被采用（已过期或被其他压缩抢先），当前摘要是 pi 生成的通用摘要。" +
  "请基于现有摘要继续任务；如果发现关键状态缺失，先重新确认现状再动手。";

export function createSwitchContextTool(deps: SwitchContextToolDeps): ToolDefinition<typeof SwitchContextToolParams> {
  const cooldownMs = deps.cooldownMs ?? 60_000;
  const now = deps.now ?? (() => Date.now());
  // 每次 activate() 新建实例：/reload 在同进程内重新激活扩展，闸门必须从干净状态开始。
  let switching = false;
  let lastTriggeredAt = 0;

  return {
    name: "switch_context",
    label: "Switch Context",
    description:
      "Switch to a fresh context NOW, carrying over ONLY the state you write in these parameters. " +
      "Your handoff text replaces the conversation history verbatim — no summarizer runs, so nothing " +
      "you omit can be recovered (the raw session file stays on disk, but re-reading it is expensive). " +
      "Use it when context usage is high, or when a distinct phase of work just finished and the detailed " +
      "history is no longer needed. Calling this ends your current turn; the task then resumes automatically " +
      "with your handoff as the context (unless resume=false). Background subagents and background bash jobs " +
      "keep running. Only available in interactive sessions (not print/json mode).",
    promptSnippet:
      "switch_context(goal, progress, next_steps, decisions?, key_files?, pitfalls?, open_questions?, keep_recent?, resume?) - replace the conversation history with a handoff you write yourself",
    promptGuidelines: [
      "Use switch_context when context usage is high or a phase of work has completed: you write the carry-over state, so nothing important is lost to a generic summary.",
      "Write goal/progress/next_steps as if briefing a competent colleague who has never seen this conversation: no pronouns pointing at deleted messages, no 'as discussed above'.",
      "Always list key_files with a one-line role for each, and record user preferences/prohibitions under decisions — those are the first things a generic summary drops.",
      "Never call switch_context twice in a row; after a switch, continue the task from your handoff.",
    ],
    parameters: SwitchContextToolParams,
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const title = theme.fg("toolTitle", theme.bold("Switch Context"));
      const preview = args?.goal?.replace(/\s+/g, " ").trim();
      const clipped = preview && preview.length > 80 ? `${preview.slice(0, 79)}…` : preview;
      text.setText(clipped ? `${title}\n${theme.fg("muted", clipped)}` : title);
      return text;
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      // print/json 一次性模式：压缩的 abort 会杀掉唯一的 turn，follow-up 消息也没有生命周期保障。
      if (ctx.mode === "print" || ctx.mode === "json") {
        return {
          content: [
            {
              type: "text" as const,
              text: "switch_context is not available in non-interactive (print/json) mode. Rely on pi's automatic compaction and continue your task with the current context.",
            },
          ],
          details: { ok: false as const, reason: "non_interactive_mode" },
        };
      }
      if (switching) {
        return {
          content: [{ type: "text" as const, text: "A context switch is already in progress. Continue your task." }],
          details: { ok: false as const, reason: "in_flight" },
        };
      }
      if (now() - lastTriggeredAt < cooldownMs) {
        return {
          content: [
            {
              type: "text" as const,
              text: `A context switch already happened less than ${cooldownMs / 1000}s ago. Refusing to switch again. Continue your task with the current context.`,
            },
          ],
          details: { ok: false as const, reason: "cooldown" },
        };
      }

      const validation = validateHandoff(params);
      if (!validation.ok) {
        return {
          content: [{ type: "text" as const, text: `[switch_context] 交接内容不合格：${validation.reason}` }],
          details: { ok: false as const, reason: "invalid_handoff" },
          isError: true,
        };
      }

      const keepRecent = params.keep_recent !== false;
      const resume = params.resume !== false;
      const core = renderHandoffCore(validation.value);
      const seq = deps.store.stage({ core, keepRecent, resume });

      const usage = ctx.getContextUsage();
      const usageText = usage?.tokens != null ? ` (~${Math.round(usage.tokens / 1000)}k tokens)` : "";

      switching = true;
      lastTriggeredAt = now();
      ctx.ui.notify(`Model requested a context switch${usageText}…`, "info");

      try {
        ctx.compact({
          onComplete: () => {
            switching = false;
            // 交接文本仍挂在 store 上 ⇒ hook 没吃到它（过期/被别的压缩抢先）。
            const notApplied = deps.store.peek()?.seq === seq;
            deps.store.clear(seq);
            ctx.ui.notify(notApplied ? "Context compacted (handoff not applied)." : "Context switched.", "info");
            if (!resume) return;
            try {
              deps.sendUserMessage(notApplied ? SWITCH_FALLBACK_TEXT : SWITCH_RESUME_TEXT);
            } catch {
              // 会话已被替换/正在关闭——没有可继续的目标。
            }
          },
          onError: (error) => {
            switching = false;
            deps.store.clear(seq);
            ctx.ui.notify(`Context switch failed: ${error.message}`, "error");
            if (!resume) return;
            try {
              deps.sendUserMessage(
                `[switch_context] 上下文切换失败（${error.message}）：历史未被替换，你的交接文本已作废。` +
                  "不要立刻重试，先继续当前任务。",
              );
            } catch {
              // 会话已被替换/正在关闭。
            }
          },
        });
      } catch (error) {
        switching = false;
        deps.store.clear(seq);
        throw error;
      }

      // ctx.compact() 同步 abort 当前 run，这个返回值可能永远到不了模型；真正的交接在 onComplete。
      // todo-nudge 切换前提示（L1 feature）：只提示、不阻止；快照读取失败（best effort）
      // 时静默跳过，绝不能让一个可见性特性把真正的切换拖垮。
      let advisory: string | undefined;
      if (deps.todoTracker) {
        try {
          advisory = buildHandoffAdvisory(deps.todoTracker());
        } catch {
          advisory = undefined;
        }
      }
      const baseText = "Context switch triggered. This turn ends now; work resumes with your handoff as the context.";
      return {
        content: [
          {
            type: "text" as const,
            text: advisory ? `${baseText}\n\n${advisory}` : baseText,
          },
        ],
        details: { ok: true as const, seq, keepRecent },
        terminate: true,
      };
    },
  } satisfies ToolDefinition<typeof SwitchContextToolParams>;
}
