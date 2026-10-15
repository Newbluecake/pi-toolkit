import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { QueryService } from "../service/query-service.js";
import type { ResolveRunResult } from "../service/resolve-target.js";

/** steer reply modes (see SteerToolParams.reply). */
export type SteerReply = "none" | "ack" | "report";

const TERMINAL_STATUSES = new Set(["completed", "failed", "timed_out", "aborted"]);

/**
 * Wrap a steer text with a reply-channel hint for the child (fabric on ⇒ it
 * owns a message_agent tool). Unlike the @mention framing (progress ⇒
 * display-only), the orchestrator must READ the answer, so the reply kind is
 * "finding" — the context channel (`subagent:fabric`, deliverAs steer,
 * triggerTurn) that lands in the main model's context and wakes it.
 */
export function frameSteerReply(text: string, reply: "ack" | "report"): string {
  const ask =
    reply === "ack"
      ? '请先用 message_agent 工具回复主会话一条简短确认（to: "root", kind: "finding"）：已收到 + 你将如何调整（一两句话即可）。'
      : '请先用 message_agent 工具回复主会话一份简明进度报告（to: "root", kind: "finding"，不超过 10 行），' +
        "包含四项：1) 已完成；2) 正在进行；3) 阻塞项（无则写「无」）；4) 预计完成时间/剩余工作（ETA）。";
  return (
    `[主会话 steer · 需${reply === "ack" ? "回复" : "进度报告"}] 以下是主会话通过 steer_subagent 发给你的指令。` +
    `${ask}该回复会进入主会话上下文；回复后继续当前任务。` +
    `finding 消息受每 run 配额限制，超限会被丢弃：回复一次即可，不要重复发送。\n\n` +
    `主会话指令：\n${text}`
  );
}

/**
 * "steer_subagent" — drop-in replacement for @tintinweb/pi-subagents' steer
 * tool. Unlike the original (report 5.7 / architecture D2 P1: steer()'s
 * rejection was swallowed and it had no timeout), this always reports a
 * concrete ok/failure reason instead of a bare success (architecture
 * QueryService.steer contract, service/query-service.ts).
 */
export const SteerToolParams = Type.Object({
  run_id: Type.String({
    description:
      "The run id of the subagent to steer; also accepts a unique run_id prefix or the Agent call's label (its description).",
  }),
  text: Type.String({ description: "The follow-up instruction to send to the running subagent." }),
  reply: Type.Optional(
    Type.Union([Type.Literal("none"), Type.Literal("ack"), Type.Literal("report")], {
      description:
        'none (default): deliver the text as-is. "ack": the subagent first replies ONE short confirmation ' +
        '(received + how it will adjust). "report": it first replies a concise progress report ' +
        "(done so far / doing now / blockers / ETA, ≤10 lines). Replies are sent with message_agent " +
        '(to "root", kind "finding") and arrive in your context as a subagent:fabric message after the ' +
        "subagent's next turn — end your turn instead of polling. Needs fabric (message_agent); without it, " +
        "or for an external-agent run, the text is delivered verbatim (no reply). Findings are per-run quota " +
        "limited (fabric.findingQuota, default 10) — a reply over quota is dropped.",
    }),
  ),
});
export type SteerToolParams = Static<typeof SteerToolParams>;

export function createSteerTool(deps: {
  query: QueryService;
  resolveRun?: (handle: string) => ResolveRunResult;
  /** Same signal as the @mention wiring (src/index.ts): fabric on ⇒ the child owns message_agent. */
  fabricEnabled?: () => boolean;
}): ToolDefinition<typeof SteerToolParams> {
  return {
    name: "steer_subagent",
    label: "Steer Subagent",
    description:
      "Send a follow-up instruction to a currently running subagent started with the Agent tool. " +
      'With reply="ack"/"report" the subagent also answers back once via message_agent (kind "finding") — ' +
      "the answer arrives in your context as a subagent:fabric message, so end your turn instead of polling.",
    promptSnippet:
      "steer_subagent(run_id, text, reply?) - send a follow-up instruction to a running subagent; " +
      "reply=ack|report asks it to answer back via message_agent",
    parameters: SteerToolParams,
    /** Same rationale as get_subagent_result's renderCall: show *which* run is being steered and a preview of the instruction, not a bare tool name. */
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const title = theme.fg("toolTitle", theme.bold(`Steer Subagent: ${args?.run_id ?? "…"}`));
      const preview = args?.text?.replace(/\s+/g, " ").trim();
      const clipped = preview && preview.length > 80 ? `${preview.slice(0, 79)}…` : preview;
      text.setText(clipped ? `${title}\n${theme.fg("muted", clipped)}` : title);
      return text;
    },
    async execute(_toolCallId, params) {
      const resolved = deps.resolveRun?.(params.run_id);
      if (resolved && !resolved.ok) throw new Error(resolved.error);
      const runId = resolved?.ok ? resolved.runId : params.run_id;
      const reply = params.reply ?? "none";
      // reply≠none wraps the text so the child answers via message_agent
      // (kind "finding" ⇒ the orchestrator's context, see frameSteerReply).
      // Degrade to verbatim — mirroring the @mention fabric-off path — when
      // the child cannot have the tool: fabric disabled, or an external
      // (droid) run which never gets message_agent injected
      // (runtime-adapter's `deps.fabric && !readonlyDomain && !isExternal`).
      let framed = false;
      let degradedReason: string | undefined;
      let text = params.text;
      if (reply !== "none") {
        if (!deps.fabricEnabled?.()) {
          degradedReason = "reply 不可用：fabric 未启用";
        } else if (deps.query.get(runId)?.diag.external) {
          degradedReason = "reply 不可用：目标为外部 agent run（无 message_agent）";
        } else if (deps.query.get(runId)?.parentRunId !== undefined) {
          // A nested run (grandchild of the main session) replying `to: "root"`
          // is an "ancestor" relation, which the default can_message ["parent"]
          // rejects at fabric admission — the reply would be dropped.
          degradedReason = "reply 不可用：目标不是主会话的直接子 agent（回复会被消息路由拒绝）";
        } else {
          framed = true;
          text = frameSteerReply(params.text, reply);
        }
      }
      const result = await deps.query.steer(runId, text);
      if (!result.ok) {
        // A TERMINAL run is the common not_running case a caller can actually
        // act on: keep today's error shape, but point at the resume path
        // (Agent({ resume }) accepts label or run_id) instead of leaving the
        // orchestrator to retry a steer that can never land. No auto-resume.
        const status = result.reason === "not_running" ? deps.query.get(runId)?.status : undefined;
        const reason =
          result.reason === "not_running"
            ? status !== undefined && TERMINAL_STATUSES.has(status)
              ? `run ${params.run_id} is not currently running (status: ${status}); ` +
                `it has finished and cannot be steered — use Agent({ resume: "${params.run_id}" }) to continue its session in a new run instead`
              : `run ${params.run_id} is not currently running`
            : result.reason === "steer_timeout"
              ? `steer to run ${params.run_id} timed out`
              : `run ${params.run_id} rejected the steer: ${result.detail ?? "unknown reason"}`;
        throw new Error(reason);
      }
      const base = `Sent follow-up instruction to run ${runId}.`;
      const resultText = framed
        ? `${base} reply=${reply}: the subagent will send ONE message_agent reply (to "root", kind "finding") after its next turn — ` +
          `it arrives in your context as a subagent:fabric message and wakes you, so end your turn now instead of waiting or polling.`
        : degradedReason
          ? `${base} ${degradedReason}，已按普通 steer 送达（文本原样转发，不会收到回复消息）。`
          : base;
      return {
        content: [{ type: "text" as const, text: resultText }],
        details: framed
          ? { ok: true, runId, reply, replyFramed: true }
          : reply !== "none"
            ? { ok: true, runId, reply, replyFramed: false }
            : { ok: true, runId },
      };
    },
  } satisfies ToolDefinition<typeof SteerToolParams>;
}
