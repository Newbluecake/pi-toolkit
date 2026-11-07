import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import type { WakeSessionParams as ActivationCall, XsActivationPort } from "../fabric/xs/session-activation.js";

/**
 * fabric-xs-activation plan §3 P3 (arch §4.4): `wake_session` — idempotent ACTIVATION of an
 * already-delivered, not-yet-processed cross-session request, plus its strictly read-only query.
 *
 * It never takes text and never re-delivers a body: it addresses the ORIGINAL message by the
 * `messageId`/`activationKey` a `message_session` result returned in `track` (or a `query`
 * answered). The schema is a frozen module constant (provider-cache-prefix convention); tool
 * mechanics live here, strategy lives in skills (I12). Registered only while
 * `fabric.crossSession.activation.enabled` is effective (frozen at activate) — see the P3
 * registration checklist (the registrar is `fabric/xs/activate.ts`).
 */
export const WakeSessionParams = Type.Object({
  to: Type.String({
    minLength: 1,
    maxLength: 128,
    description:
      "The ORIGINAL target of the message: its full session id (message_session result target.sessionId) or its 12-char ref. " +
      "It only has to match the original binding — it never re-addresses.",
  }),
  messageId: Type.String({
    minLength: 1,
    maxLength: 64,
    description: "track.messageId returned by the original message_session call.",
  }),
  activationKey: Type.String({
    minLength: 1,
    maxLength: 64,
    description:
      "track.activationKey returned by the original message_session call (always reuse it; never invent one).",
  }),
  action: Type.Optional(
    Type.Union([Type.Literal("activate"), Type.Literal("query")], {
      description:
        '"activate" (default): ask the recipient to process the already-delivered message now. "query": read-only progress lookup — ' +
        "never activates, never costs a wake.",
    }),
  ),
});
export type WakeSessionToolParams = Static<typeof WakeSessionParams>;

export const WAKE_SESSION_DESCRIPTION =
  "Activate an ALREADY-DELIVERED cross-session message that the recipient has not started processing (the wake was not " +
  "requested, was downgraded by quota/policy, or never started). It does not resend the body and cannot wake an arbitrary " +
  "session: only the exact messageId + activationKey of your own earlier message_session send qualifies, and only while it is " +
  "delivered, unstarted and within its tracking window. One effective activation per message — a second call is a no-op " +
  "(dup/already_active). It counts against the same wake quotas (pair default 2/hour) as a new control action. " +
  'status "accepted" = the host control action was submitted (the body may still only be delivered); "refused" effect none = ' +
  'nothing happened (retryable + retryAfterAt tell when quota allows); "unknown" = it may have taken effect: call again with ' +
  'action:"query" only — never activate again. Use action:"query" any time to read progress (queued/delivered/started/replied); ' +
  "a query that finds nothing never activates.";

export interface WakeSessionToolDeps {
  port: XsActivationPort;
  now?: () => number;
}

/** Chinese advice blocks (UI-language split): prose aimed at the model/user, never inline tokens. */
export function wakeSessionHint(status: string, effect: string, reason?: string, retryAfterAt?: number): string {
  if (status === "unknown" || effect === "unknown")
    return '激活结果未知：可能已生效。只能用 action:"query" 查询进展，不要再次 activate，也不要重发正文。';
  if (status === "accepted")
    return "控制动作已提交；正文可能仅为 delivered，开始处理与否请用 query 观察，不要重复激活。";
  if (status === "already_active") return "该消息已有激活/唤醒在进行或已消费，无需重复；用 query 观察进展。";
  if (status === "already_started" || status === "already_replied") return "对方已开始处理（或已回复），无需激活。";
  if (status === "unsupported") return "当前链路不支持激活（本机/hub/对方缺能力或功能关闭）；不要用重发正文代替。";
  if (status === "refused") {
    const when =
      retryAfterAt === undefined
        ? ""
        : `；最早可重试时间 ${new Date(retryAfterAt).toISOString()}（票据可能先过期，不会自动续期）`;
    return `激活被拒绝（${reason ?? "refused"}），未产生任何效果${when}。不要换 key，也不要重发正文。`;
  }
  return "";
}

export function createWakeSessionTool(deps: WakeSessionToolDeps): ToolDefinition<typeof WakeSessionParams> {
  return {
    name: "wake_session",
    label: "wake_session",
    description: WAKE_SESSION_DESCRIPTION,
    parameters: WakeSessionParams,
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as WakeSessionToolParams;
      const action = params.action ?? "activate";
      if (action === "query") {
        const out = await deps.port.query({ messageId: params.messageId, activationKey: params.activationKey });
        const hint =
          out.status === "known"
            ? ""
            : out.status === "unsupported"
              ? "\n当前链路不支持进展查询；不要重发正文。"
              : "\n未找到记录（已过期/未跟踪/hub 重启，或 key 不匹配）；查询不会触发任何激活。";
        return { content: [{ type: "text", text: JSON.stringify(out) + hint }], details: out };
      }
      const call: ActivationCall & { signal?: AbortSignal } = {
        to: params.to,
        messageId: params.messageId,
        activationKey: params.activationKey,
        action: "activate",
        ...(signal !== undefined ? { signal } : {}),
      };
      const out = await deps.port.activate(call);
      const hint = wakeSessionHint(out.status, out.effect, out.wakeDowngraded ?? out.reason, out.retryAfterAt);
      return {
        content: [{ type: "text", text: JSON.stringify(out) + (hint === "" ? "" : `\n${hint}`) }],
        details: out,
      };
    },
  };
}
