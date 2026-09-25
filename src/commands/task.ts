/**
 * `/task <任务描述>` — 用户直接从主会话启动一个后台 subagent。
 *
 * 与主会话 `Agent` 工具的后台派发路径（tools/agent-tool.ts spawnInBackground）
 * 共用同一条 SpawnService.spawn + notification outbox 链路：
 *
 *  - agent 类型固定 `general-purpose`（config/agent-types.ts 的内置兜底类型，
 *    无 agent 文件时也存在），模型用该类型配置/默认（不指定 model）；
 *  - 不指定 timeout（无 budgetOverride）⇒ 默认预算，享有宽限/延长机制；
 *  - `detachSignalOnStart: true`：fire-and-forget 后台语义（命令不在任何模型
 *    turn 内，本就没有 caller signal，该标记与 Agent 工具后台路径保持一致）；
 *  - 无 expectAck / parentRunId ⇒ 完成通知走与 Agent 后台 run 完全相同的
 *    投递路径（runtime-adapter → notifier → outbox，triggerTurn: true 唤醒
 *    主会话模型处理结果）。
 *
 * 启动记录：`pi.sendMessage(customType: "subagent:task-started", { triggerTurn: false })`
 * 只写主会话上下文、不触发模型回复、不打断当前对话（steaming 时由 pi 延迟到
 * 本轮 tool result 之后落盘；idle 时立即落盘——两种情况下模型都在下一轮可见）。
 * 不用 `deliverAs: "nextTurn"`：该模式把消息扣在内存里、只在下一次 *用户*
 * prompt（prompt() 路径）时注入，`sendMessage({triggerTurn:true})` 的通知唤醒轮
 * 不经过该路径，完成通知先到时启动记录反而缺席，且重启即丢。
 */

import type { ExtensionCommandContext, MessageRenderer, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { firstNonEmptyLine, sanitizeLabelBase } from "../core/labels.js";
import type { ErrorInfo, RunId, SpawnRequest } from "../core/types.js";

/** customType of the start record injected into the main-session context (`subagent:*` naming convention). */
export const TASK_STARTED_CUSTOM_TYPE = "subagent:task-started";

/** Fixed agent type — a built-in fallback in config/agent-types.ts, always registered. */
export const TASK_AGENT_TYPE = "general-purpose";

/** Character budget for the task description preview inside the start record. */
export const TASK_DESCRIPTION_PREVIEW_CHARS = 400;

/** `details` payload of the start record (stable shape; keep additive-only). */
export interface TaskStartedDetails {
  kind: "task-started";
  runId: RunId;
  label: string;
  agentType: string;
  /** Truncated task description (preview only; the full prompt lives on the run). */
  task: string;
  truncated: boolean;
}

export interface TaskCommandDeps {
  /**
   * SpawnService.spawn forwarded through the current session stack (holder
   * pattern in src/index.ts — same forwarding the Agent tool uses). Never
   * call the runner directly: bypassing SpawnService would skip label
   * uniquification, the mention registry and the notification plumbing.
   */
  spawn(req: SpawnRequest): Promise<{ runId: RunId; label?: string } | { error: ErrorInfo }>;
  /** pi.sendMessage — writes the start record into the main-session context. */
  sendMessage(
    message: { customType: string; content: string; display: boolean; details: unknown },
    options: { triggerTurn: false },
  ): void;
}

const USAGE =
  "用法：/task <任务描述> — 整段文本原样作为后台 subagent（general-purpose）的任务 prompt；不支持任何参数或 flag。";

/**
 * Derive a short label from the task description: first non-empty line,
 * sanitized to the shared label rules (whitespace-free, ≤36 code points —
 * see core/labels.ts). Uniquification stays in SpawnService (`-2`, `-3`, …),
 * exactly like an Agent tool dispatch.
 */
export function deriveTaskLabel(description: string): string | undefined {
  return sanitizeLabelBase(firstNonEmptyLine(description) ?? "");
}

/** Truncate the description preview for the start record (pure; budget in chars). */
export function truncateTaskDescription(
  description: string,
  budget = TASK_DESCRIPTION_PREVIEW_CHARS,
): { text: string; truncated: boolean } {
  if (description.length <= budget) return { text: description, truncated: false };
  return { text: `${description.slice(0, budget)}…`, truncated: true };
}

/** Model-facing text of the start record (content is always delivered to the model). */
export function buildTaskStartedContent(runId: RunId, label: string, taskPreview: string): string {
  return (
    `Background task started via the /task command (user-initiated).\n` +
    `run_id: ${runId}\n` +
    `label: ${label}\n` +
    `agent type: ${TASK_AGENT_TYPE}\n` +
    `Task: ${taskPreview}\n\n` +
    `A completion notification will arrive when the run settles; read the full result then with get_subagent_result(run_id: "${runId}"). No action is needed before that.`
  );
}

export function buildTaskStartedDetails(runId: RunId, label: string, description: string): TaskStartedDetails {
  const preview = truncateTaskDescription(description);
  return {
    kind: "task-started",
    runId,
    label,
    agentType: TASK_AGENT_TYPE,
    task: preview.text,
    truncated: preview.truncated,
  };
}

/**
 * Optional compact TUI renderer for the start record: one muted line instead
 * of the default custom-message box (English tokens only — compact marker).
 * Registration is guarded by a `typeof pi.registerMessageRenderer` probe in
 * src/index.ts; without it the default renderer shows the full content.
 *
 * pi hands a custom renderer's component straight to the chat container with
 * no surrounding Box, so the line must carry its own horizontal padding —
 * `options.outputPad` (the user's outputPad setting, default 1), the same
 * indent pi uses for user/assistant messages. Padding 0 left the line flush
 * against column 0, out of line with everything around it.
 */
export const renderTaskStartedMessage: MessageRenderer<TaskStartedDetails> = (message, options, theme) => {
  const details = message.details;
  if (!details || typeof details !== "object") return undefined;
  const { runId, label } = details as Partial<TaskStartedDetails>;
  if (runId === undefined || label === undefined) return undefined;
  const short = runId.length > 8 ? runId.slice(0, 8) : runId;
  const padX = typeof options?.outputPad === "number" && options.outputPad >= 0 ? options.outputPad : 1;
  return new Text(theme.fg("muted", `/task started · ${label} (#${short}) · background`), padX, 0);
};

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // best effort
  }
}

export function createTaskCommand(deps: TaskCommandDeps): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  return {
    description:
      "启动一个后台 general-purpose subagent 执行任务：/task <任务描述>。整段文本原样作为任务 prompt（不支持参数）；启动后可继续对话，完成时会收到通知，用 get_subagent_result 读取结果。",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      // The whole argument text is the task prompt — verbatim, no flags.
      const prompt = args.trim();
      if (prompt.length === 0) {
        notify(ctx, USAGE, "warning");
        return;
      }
      const label = deriveTaskLabel(prompt);
      let spawned: Awaited<ReturnType<TaskCommandDeps["spawn"]>>;
      try {
        spawned = await deps.spawn({
          type: TASK_AGENT_TYPE,
          prompt,
          // No model/thinking override (the type's config + global defaults),
          // no budgetOverride (default budget: grace window + extension), no
          // expectAck/parentRunId/slotless — identical field set to the
          // top-level Agent tool's background spawn.
          ...(label !== undefined ? { label } : {}),
          detachSignalOnStart: true,
        });
      } catch (error) {
        notify(ctx, `/task 启动失败：${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      if ("error" in spawned) {
        notify(ctx, `/task 启动失败：${spawned.error.message}`, "error");
        return;
      }
      // SpawnService may have uniquified the label ("-2", …) — the record must
      // carry the effective one (@mention / get_subagent_result target).
      const effectiveLabel = spawned.label ?? label ?? spawned.runId;
      try {
        deps.sendMessage(
          {
            customType: TASK_STARTED_CUSTOM_TYPE,
            content: buildTaskStartedContent(spawned.runId, effectiveLabel, truncateTaskDescription(prompt).text),
            display: true,
            details: buildTaskStartedDetails(spawned.runId, effectiveLabel, prompt),
          },
          // Context-only record: no model turn now, never steers into the
          // current reply; persisted immediately (idle) or flushed after the
          // current turn's tool results (streaming).
          { triggerTurn: false },
        );
      } catch (error) {
        console.warn(`[pi-subagent] /task start record send failed: ${String(error)}`);
      }
      notify(ctx, `后台任务已启动：${effectiveLabel}（run_id: ${spawned.runId}）。完成时会收到通知。`);
    },
  };
}
