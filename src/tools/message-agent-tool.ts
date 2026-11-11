import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { type NodeRef, type MessageKind, type CanMessage, effectiveCanMessage } from "../core/message.js";
import type { FabricRouter, AdmissionResult } from "../fabric/router.js";
import type { MentionChannel, MentionSendResult } from "../fabric/mention.js";

export const MessageAgentParams = Type.Object({
  to: Type.String({
    description:
      'Target run id, "root" for the root session, or @label for a registered top-level agent (requires can_message: mention)',
  }),
  kind: Type.Union([Type.Literal("progress"), Type.Literal("report"), Type.Literal("directive")]),
  text: Type.String({ description: "Message body" }),
});
export type MessageAgentParams = Static<typeof MessageAgentParams>;

/**
 * fabric-cross-session plan v3 §4.2 (W1): the wake-enabled schema — today's three fields plus an optional `wake`. Built
 * ONCE per activation from settings (`messageAgentParams`), never per call: the provider-visible tool schema is part of
 * the cached request prefix, so it must be frozen for the whole activation.
 */
export const MessageAgentParamsWithWake = Type.Object({
  ...MessageAgentParams.properties,
  wake: Type.Optional(
    Type.Boolean({
      description:
        "Omit for the default behaviour. false = deliver only: the message is never allowed to start a turn or resume a " +
        "finished agent. true = wake the recipient (EXPENSIVE: starts a model turn; limited per sender and by a chain-depth " +
        "ceiling — over the limit it is silently downgraded to deliver-only and the result says so). A running agent is " +
        "always just steered. progress messages never wake (wake:true is rejected for them).",
    }),
  ),
});
export type MessageAgentParamsWithWake = Static<typeof MessageAgentParamsWithWake>;

/**
 * Schema factory. `wake:false` returns the exact pre-wake `MessageAgentParams` INSTANCE (golden: byte-identical when
 * wake is off), `wake:true` the schema with the optional `wake` field.
 */
export function messageAgentParams(opts: {
  wake: boolean;
}): typeof MessageAgentParams | typeof MessageAgentParamsWithWake {
  return opts.wake ? MessageAgentParamsWithWake : MessageAgentParams;
}

export interface MessageAgentToolDeps {
  router: FabricRouter;
  /** The host owns these values; callers cannot override the sender identity. */
  from: NodeRef;
  generation: () => number | undefined;
  canMessage?: readonly ("parent" | "child" | "ancestor" | "descendant" | "sibling" | "self" | "mention")[];
  mention?: MentionChannel;
  /**
   * `fabric.enabled ∧ fabric.wake.enabled`, frozen per activation. false/absent ⇒ the legacy schema and behaviour; an
   * undeclared `wake` argument a model might still send is dropped.
   */
  wakeOn?: boolean;
}

/** Admission-only advice: a denied kind/relation is not permission to switch kind or route. */
export function messageAgentKindHint(input: { to: string; kind: string; canMessage?: readonly CanMessage[] }): string {
  const boundary = input.to.startsWith("@")
    ? 'the @label route requires can_message: mention and only carries kind "report" (or "progress"); kind "directive" is parent-to-child only.'
    : input.kind === "directive"
      ? 'kind "directive" may only be sent by a parent to its own child run.'
      : `report/progress require an authorized target relation in your can_message set (${effectiveCanMessage(input.canMessage).join("|")}; default: direct parent only).`;
  return (
    boundary +
    " Verify the intended kind and target with your parent; do not switch kind or address to bypass authorization. " +
    'Use your authorized direct parent for questions/reports, or the "result" channel via run completion for final results. ' +
    'kind:"progress" to root only renders in the TUI display; the model never sees it.'
  );
}

/** #84 D1: pure formatting over the existing receipt; never re-admit, reserve or refund. */
function admissionHint(result: AdmissionResult | MentionSendResult): string {
  if (result.ok) return "";
  switch (result.status) {
    case "invalid_wake":
      return "progress 不会唤醒模型；若确实只需展示进度，省略 wake 或设为 false。不要改 kind 绕过限制。";
    case "quota_exhausted":
      return "本 run 的该 kind 额度已耗尽，请停止重试，在最终结果/完成汇报中提供信息；不要换 kind、目标或省略 wake 绕过额度。";
    case "target_backpressure":
      return "目标收件容量已满，本次未获准投递；等待目标消费已有消息后再决定是否重试，不要连续重试或换路由绕过容量。";
    case "unknown_label":
      return "未找到已注册的顶层 @label；向父会话确认精确 label 或获授权的 run id，不要猜测目标。";
    case "not_root_child":
      return "@label 只能指向已注册的顶层 run；向父会话确认获授权的目标，不要换地址绕过关系限制。";
    case "not_authorized":
      return "@label 需要 can_message: mention，且不能指向自己或承载 directive；请向父会话确认授权，不要换 kind/地址绕过。";
    case "target_not_ready":
      return "目标尚未就绪或当前不能接收此请求；等待父会话确认目标状态，不要通过省略 wake 或换 kind 强行启动。";
    case "not_wakeable":
      return "目标不允许被本请求唤醒；停止自动重试，交由父会话/用户确认后续安排，不要改 wake 或路由绕过。";
    case "resume_failed":
      return "恢复请求失败，不能据此证明没有副作用；不要自动重发正文。向父会话报告并核对 run 状态，已预留的 report 额度不退款。";
  }
}

/** Only exact, locally owned error tokens may cross the tool boundary. No arbitrary Error/cause text. */
function messageAgentError(
  error: unknown,
  params: MessageAgentParams,
  canMessage: readonly CanMessage[] | undefined,
): string {
  const token = error instanceof Error ? error.message : undefined;
  switch (token) {
    case "message not authorized":
      return `${token} — ${messageAgentKindHint({ ...params, ...(canMessage === undefined ? {} : { canMessage }) })}`;
    case "sender is not running":
    case "shutting down":
      return `${token} — 当前发送方生命周期不允许发送；停止重试，交由父会话/用户确认，不要借其他身份发送。`;
    case "invalid message key node":
      return `${token} — to 应为精确 run id、root 或已注册 @label；向父会话确认目标，不要猜测。`;
    case "message_agent: wake must be a boolean":
      return `${token} — wake 只接受 true/false 或省略；保留原发送意图，不要用参数变化绕过限制。`;
    case "message_agent: cannot determine generation":
    case "invalid message key generation":
    case "invalid message key sequence":
    case "mention route target mismatch":
    case "mention target is not a root child":
    case "mention target is gone":
    case "cannot persist mention report reservation":
      return `${token} — 无法安全完成当前发送；停止重试并向父会话报告，由宿主核对状态。`;
    default:
      return "message_agent: unexpected failure — 发送效果无法确认；不要自动重发正文，向父会话/用户报告并核对状态。";
  }
}

/** The kinds a caller may send (#34 E1; schema order). A retired kind is not sendable any more. */
const SENDABLE_KINDS: readonly string[] = ["progress", "report", "directive"];

export function createMessageAgentTool(deps: MessageAgentToolDeps): ToolDefinition<typeof MessageAgentParams> {
  const wakeOn = deps.wakeOn === true;
  return {
    name: "message_agent",
    label: "message_agent",
    description:
      'Send a message to another agent or the root session. Kind semantics: "report" is injected into the target ' +
      "session's model context — use it to ask questions of, or report findings to, the parent/root session; " +
      '"progress" only renders in the TUI display when to:"root" — the model NEVER sees it (never use it to ask a ' +
      'question); "directive" may only be sent by a parent to its own child run (a child sending it upward is rejected). ' +
      'Task results are reported via run completion (the "result" channel, child→parent), not via this tool.',
    // The wake-on schema is a strict superset (one extra optional field), so the declared tool type stays the legacy one.
    parameters: messageAgentParams({ wake: wakeOn }) as typeof MessageAgentParams,
    async execute(_toolCallId, params) {
      // #34 (E1): guard before anything else — pi's schema validation normally rejects an unknown kind upstream, but a
      // direct caller bypassing it must not reach the router/mention (which would answer "message not authorized",
      // misleading for a retired kind). Synchronous throw: no seq, no quota, no record.
      if (!SENDABLE_KINDS.includes(params.kind))
        throw new Error(
          `message_agent: unknown kind — valid kinds: "report" (enters the target session's model ` +
            'context; use it to ask or report back), "progress" (to:"root" only renders in the TUI display), ' +
            '"directive" (parent to its own child run only)',
        );
      try {
        const wake = wakeOn ? (params as { wake?: unknown }).wake : undefined;
        if (wake !== undefined && typeof wake !== "boolean") throw new Error("message_agent: wake must be a boolean");
        const admitted: AdmissionResult | MentionSendResult =
          wake === true && params.kind === "progress"
            ? { ok: false, status: "invalid_wake", reason: "progress_never_wakes" }
            : params.to.startsWith("@")
              ? deps.mention
                ? await (wake === undefined
                    ? deps.mention.send(params.to.slice(1), params.kind, params.text)
                    : deps.mention.send(params.to.slice(1), params.kind, params.text, wake))
                : { ok: false, status: "unknown_label", label: params.to.slice(1) }
              : (() => {
                  const generation = deps.generation();
                  if (generation === undefined || !Number.isInteger(generation) || generation < 1)
                    throw new Error("message_agent: cannot determine generation");
                  return deps.router.admit(deps.from, {
                    to: params.to as NodeRef,
                    kind: params.kind as MessageKind,
                    text: params.text,
                    generation: generation as never,
                    ...(wake === undefined ? {} : { wake }),
                    ...(deps.canMessage === undefined ? {} : { canMessage: deps.canMessage }),
                  });
                })();
        // Mention resume failures may contain arbitrary spawn/provider exceptions. Keep the receipt and quota,
        // but never expose that raw error through either content or details.
        const result =
          !admitted.ok && admitted.status === "resume_failed"
            ? { ...admitted, error: "message_agent: resume failed" }
            : admitted;
        // Do not overwrite the legacy numeric `quota` in quota_exhausted. Success/resume receipts
        // retain their admission-time snapshot even if another concurrent send has since completed.
        const reportQuota =
          params.kind === "report"
            ? "quota" in result && typeof result.quota === "object" && result.quota !== null
              ? result.quota
              : deps.router.reportQuotaSnapshot(deps.from)
            : undefined;
        const decorated =
          reportQuota && !("quota" in result && typeof result.quota === "object") ? { ...result, reportQuota } : result;
        const hint = reportQuota
          ? `（report ${reportQuota.used}/${reportQuota.limit} 已用，剩 ${reportQuota.remaining} 次）` +
            (!result.ok && result.status === "quota_exhausted"
              ? "（report 额度已耗尽，请勿再试；请在最终结果或完成汇报中提供信息。）"
              : "")
          : "";
        return {
          content: [
            { type: "text", text: JSON.stringify(decorated) + hint + (result.ok ? "" : `\n${admissionHint(result)}`) },
          ],
          details: decorated,
        };
      } catch (error) {
        const message = messageAgentError(error, params, deps.canMessage);
        if (params.kind === "report") {
          const quota = deps.router.reportQuotaSnapshot(deps.from);
          throw new Error(`${message}（report ${quota.used}/${quota.limit} 已用，剩 ${quota.remaining} 次）`);
        }
        throw new Error(message);
      }
    },
  };
}
