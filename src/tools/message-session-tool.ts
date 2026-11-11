import { createHash } from "node:crypto";
import type { InvocationRef } from "../fabric/xs/human-grant.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import type { XsSendOutcome, XsSender } from "../fabric/xs/sender.js";

/**
 * fabric phase-2 X3 (phase2-plan §4.3 + r3 M2/S3): `message_session` — the send half of the
 * main-session cross-session tool pair. Report semantics only (P5: no `kind` parameter); the
 * recipient reads the body as UNTRUSTED input (fenced header, §8.8 — receiver side). The sender
 * identity is never a parameter: the hub stamps `from` after the four-way bind (§8.1).
 *
 * The schema is a frozen module constant (provider-cache-prefix convention — identical to
 * `list_sessions`/`message_agent`): no settings-dependent field exists because a wake that
 * cannot run degrades at runtime with an explicit `wakeDowngraded`, it never changes the shape.
 *
 * r3 S3 ruling, verbatim in the description: `effect:"unknown"` means the message MAY have
 * entered the recipient's queue — it usually becomes visible at the recipient's next turn
 * boundary — and must not be blindly resent.
 */

/** Frozen LEGACY instance (reply off). Byte-identical to the pre-reply schema — pinned by
 *  `tests/fixtures/fabric-xs-reply-off-golden.json`; never edit. */
export const MessageSessionParamsLegacy = Type.Object({
  to: Type.String({
    maxLength: 128,
    description:
      "Target session: a short ref from list_sessions, a full session id, or a session name. " +
      "Reserved forms (root, system, main, r_…, @…, wf_…) are rejected — those address runs and labels, not sessions.",
  }),
  text: Type.String({
    maxLength: 16_384,
    description: "Message body. Truncated to fabric.maxChars (75% head + 25% tail) before sending.",
  }),
  wake: Type.Optional(
    Type.Boolean({
      description:
        "Omit or false (default): deliver only. true: also wake the recipient session — EXPENSIVE, it starts a model " +
        "turn there; rate-limited and chain-depth-limited, and past any limit it is downgraded to deliver-only with the " +
        "reason in wakeDowngraded.",
    }),
  ),
});
/** Back-compat name for the legacy instance. */
export const MessageSessionParams = MessageSessionParamsLegacy;

/** Reply-plan §4.1 (RX4): the second frozen instance (reply on) — the legacy properties verbatim
 *  plus `expectReply` / `replyTo`. Picked once per activation (`messageSessionParamsFor`). */
export const MessageSessionParamsReply = Type.Object({
  ...MessageSessionParamsLegacy.properties,
  expectReply: Type.Optional(
    Type.Object(
      {
        timeoutS: Type.Optional(
          Type.Integer({
            minimum: 60,
            maximum: 86_400,
            description: "How long to wait for the reply (default fabric.crossSession.reply.defaultTimeoutS = 1800).",
          }),
        ),
      },
      {
        additionalProperties: false,
        description:
          "Ask the recipient to reply with replyTo. You get a notification when the reply arrives (it may wake you) " +
          "or when the timeout passes without one. One reply per request. Pending requests do not survive a pi restart.",
      },
    ),
  ),
  replyTo: Type.Optional(
    Type.String({
      pattern: "^q[0-9a-f]{18}$",
      description:
        "Answer a request you received: copy the reply_to id from its header. Exactly one reply is accepted; " +
        "wake is ignored (the requester decides whether a reply wakes it).",
    }),
  ),
});
export type MessageSessionParams = Static<typeof MessageSessionParamsReply>;

/** The ONE instance-selection rule: `reply.enabled` (frozen at activate) ⇒ reply instance,
 *  otherwise the legacy instance (same precedent as the wake switch). */
export function messageSessionParamsFor(
  replyEnabled: boolean,
): typeof MessageSessionParamsLegacy | typeof MessageSessionParamsReply {
  return replyEnabled ? MessageSessionParamsReply : MessageSessionParamsLegacy;
}

/** r3 S3 wording for every `unknown` verdict — advice prose, so Chinese is correct per the
 *  UI-language split; the model must not blindly resend. */
export const XS_UNKNOWN_HINT = "注意：这条消息可能已进入对方队列，通常在对方下一个 turn 边界可见；不要重发。";

/** Reply-plan §4.2 tool prose (Chinese advice blocks, per the UI-language split). */
export function xsReplyIssuedHint(requestId: string, dueAt: string): string {
  return `已登记期待回复 ${requestId}，截止 ${dueAt}；回复到达或超时都会通知你，无需轮询（pi 重启会使未决请求失效）。`;
}
export const XS_REPLY_TO_UNKNOWN_HINT =
  "可能已送达。对方凭证一次性：重发同一回复不会造成重复投递，但可能被拒收（拒收说明对方已收到、已超过宽限期，或对方 pi 已重启使凭证失效）。";
export const XS_REPLY_TO_REJECTED_HINT = "对方未接收（已收到过回复、凭证过期或失效、或对方策略拒收）；不要再重发。";

export interface MessageSessionToolDeps {
  sender: XsSender;
  activation?: boolean;
  /** Main-session activation ∧ wake gate, frozen at activate; children never receive it. */
  idleWakeAdvice?: boolean;
  invocation?(toolCallId: string): InvocationRef | undefined;
  /** `fabric.crossSession.reply.enabled` frozen at activate: selects the schema instance and the
   *  description. Omitted/false ⇒ the legacy tool, byte-identical to pre-reply. */
  reply?: boolean;
  /** `alias.enabled` ∧ hub cap frozen at activate (alias-plan §6): selects the alias description (schema
   *  identical to the same reply-mode instance; `to` already accepts any ≤128-char string). Omitted/false ⇒ byte-identical. */
  alias?: boolean;
  /** rebind-plan r3 §3.2 step 7 (agent package): `fabric.threads.enabled ∧ rebind` frozen at
   *  activate ⇒ appends the topic-handover dispatch convention. Omitted/false ⇒ NEVER appended
   *  (threads-on × rebind-off stays byte-identical, A16). */
  threadRebind?: boolean;
}

const ALIAS_TO_SUFFIX =
  ' When the user refers to a session by a short word (e.g. "给前端发消息"), pass that word verbatim as `to`: aliases are ' +
  "unique on this hub and matched before names. If the result is no_target or ambiguous, call list_sessions and ask " +
  "the user — never guess or pick the closest one.";

/** rebind-plan r3 §3.2 steps 6–7: the topic-handover dispatch convention — appended ONLY while
 *  `fabric.threads.rebind` is on (off ⇒ never appended, A16 byte-parity). */
const THREAD_REBIND_SUFFIX =
  " Feishu topic handover: to make a group topic follow your dispatch, first call " +
  'thread(action:"rebind", h, to) and send with `to` set to the FULL sessionId its result returns; put the ' +
  'thread handle in your text and require the worker to run thread(action:"acquire", h) BEFORE subscribing or ' +
  "replying (acquire is the only trusted directory entry — skipping it degrades safely: subscribe answers " +
  "thread_unknown and the events keep going to the main session).";

/** alias-plan §6 prose for `E_XS_ALIAS_UNAVAILABLE` (advice block ⇒ Chinese). */
export const XS_ALIAS_UNAVAILABLE_HINT = "hub 别名服务暂不可用，请用 list_sessions 给出的 ref";

const LEGACY_DESCRIPTION =
  "Send a message to another joined main session on this machine's web hub (fabric cross-session; the recipient " +
  "sees it as untrusted input). Reply to an incoming cross-session message by messaging its from.ref. " +
  'effect "applied" = delivery confirmed; "none" = provably NOT delivered (safe to retry later); "unknown" = the ' +
  "message may have entered the recipient's queue — it usually becomes visible at the recipient's next turn " +
  "boundary; do NOT blindly resend.";

const REPLY_DESCRIPTION =
  "Send a message to another joined main session on this machine's web hub (fabric cross-session; the recipient " +
  "sees it as untrusted input). To get an answer back, pass expectReply (you are notified on reply or timeout). " +
  "To answer an incoming message that carries reply_to, pass replyTo with that id and `to` = its from.ref (one " +
  "reply only; wake is ignored). " +
  'effect "applied" = delivery confirmed; "none" = provably NOT delivered (safe to retry later); "unknown" = the ' +
  "message may have entered the recipient's queue — it usually becomes visible at the recipient's next turn " +
  "boundary; do NOT blindly resend a request (a replyTo resend is idempotent but may be refused). " +
  "While working on a request that carried reply_to, send any intermediate question to its requester as a NEW message with expectReply (wake:true) — never the original replyTo (it accepts exactly one reply: your final result) — and do not block on ask_user: the requester cannot see your local dialog (the host redirects ask_user for you when it can).";

/** #84 D2: advice uses only the sender's existing none verdict, never infers delivery from a reason.
 * Unknown/applied keep their established receipt/activation guidance and bytes. No retry time is invented.
 */
export function xsNoneFailureHint(outcome: { status: string; effect: string; reason?: string }): string {
  if (outcome.effect !== "none") return "";
  switch (outcome.reason) {
    case "rate_in_flight":
    case "rate_sends_min":
    case "rate_sends_hour":
    case "rate_hub":
    case "rate_pair_interval":
    case "rate_broadcast_hour":
    case "rate_broadcast_interval":
    case "inbound_rate":
      return "本次正文未送达：发送频率或在途容量受限。停止连续重试；没有权威 retryAfter，不能推算恢复时间，不要换目标或路由绕过配额。";
    case "inbox_full":
    case "dedup_full":
      return "本次正文未送达：接收容量受限。等待已有消息被消费/容量释放后再决定是否重试，不要连续重试或换路由绕过。";
    case "fenced:compaction":
    case "fenced:tree":
    case "fenced:switch":
    case "fenced:web_exec":
    case "fenced:topic_switch":
    case "fenced:goal":
      return "本次正文未送达：目标处于操作边界保护中。等待该操作结束后再确认目标，不要自行重置 fence 或换路由绕过。";
    case "session_changed":
    case "changed":
      return "本次正文未送达：目标会话已变化；用 list_sessions 重新确认精确 ref，不要将原请求自动转发给其他会话。";
    case "expired":
      return "本次正文未送达：投递已过期；先确认目标和请求是否仍有效，再决定是否重新发送，不要连续重试。";
    case "rejected":
      return "本次正文未送达：接收方策略拒收，不能据此区分具体原因。停止重试并请用户确认；不要自行加入频道、改接收策略或换路由绕过。";
    case "host_rejected":
    case "receiver_error":
      return "本次正文未送达：接收端未完成投递；请用户核对目标状态，修复后再决定是否重试。";
  }
  switch (outcome.status) {
    case "origin_changed":
    case "stale_origin":
      return "本次正文未送达：发送来源已取消或变化。停止本次操作，在当前会话重新确认发送意图和目标后再决定是否发送。";
    case "not_joined":
      return "本次正文未送达：当前会话不具备本链路成员资格。请用户确认参与意图；不要自行执行 join、改策略或换路由绕过。";
    case "off":
    case "channel_unsupported":
      return "本次正文未送达：当前链路功能关闭或不支持。请用户核对 /fabric status 与 /webhub status；不要自行启用设置或改变成员资格。";
    case "too_large":
      return "本次正文未送达：消息超过帧大小限制；缩短正文后再发送，不要连续重试相同正文。";
    case "bad_frame":
      return "本次正文未送达：请求格式不被支持；核对工具参数，仍失败则请用户检查宿主版本，不要重复原调用。";
    case "reply_unsupported":
      return "本次正文未送达：当前链路不支持所需回复凭证或缺少精确会话身份。请用户核对能力/版本；不要编造 replyTo 或去掉回复约束绕过。";
    case "reply_unreceivable":
      return "本次正文未送达：当前会话无法接收该目标的回复。请用户确认成员资格、接收策略及阻止规则；不要自行 join、改 policy 或去掉 expectReply 绕过。";
    case "reply_quota":
    case "reply_ledger_full":
      return "本次正文未送达：未决回复额度或凭证账本容量已满。等待已有请求完成/过期后再决定是否发送，不要换目标、去掉 expectReply 或重启来绕过。";
    case "reply_target_mismatch":
      return "本次正文未送达：replyTo 与目标不匹配。核对原请求头中的 reply_to 和发送者精确 ref；不要编造凭证或改成普通消息重发最终回复。";
    case "error":
      return "本次正文未送达，但无法确定具体故障原因。请用户核对宿主状态后再决定是否重试；不要猜测网络或权限问题。";
    default:
      return "";
  }
}

export function createMessageSessionTool(
  deps: MessageSessionToolDeps,
): ToolDefinition<typeof MessageSessionParamsLegacy> {
  const replyOn = deps.reply === true;
  // Per tool activation, keep only a bounded digest and count; never retain message bodies.
  let streak: { digest: string; failures: number } | undefined;
  return {
    name: "message_session",
    label: "message_session",
    description:
      (replyOn ? REPLY_DESCRIPTION : LEGACY_DESCRIPTION) +
      (deps.alias === true ? ALIAS_TO_SUFFIX : "") +
      (deps.threadRebind === true ? THREAD_REBIND_SUFFIX : "") +
      (deps.activation === true
        ? " With expectReply and omitted wake, a verified one-use host human delegation requests wake only when all three peers support xs.state.v1; ordinary agent messages default to deliver-only. Explicit false always wins. One human input shares one allowance across its real call tree; parallel or additional targets need explicit true. wake is quota/policy limited; woke means dispatch accepted, not started. Keep the returned track.messageId/activationKey for read-only query or eligible activation; never resend unknown body delivery."
        : ""),
    parameters: (replyOn ? MessageSessionParamsReply : MessageSessionParamsLegacy) as typeof MessageSessionParamsLegacy,
    async execute(toolCallId, rawParams, signal) {
      const params = rawParams as MessageSessionParams;
      // legacy instance: the new fields can never legitimately arrive, and are never forwarded
      const expectReply = replyOn ? params.expectReply : undefined;
      const replyTo = replyOn ? params.replyTo : undefined;
      const digest = createHash("sha256")
        .update(
          JSON.stringify([
            params.to,
            params.text,
            params.wake,
            expectReply?.timeoutS,
            expectReply !== undefined,
            replyTo,
          ]),
        )
        .digest("hex");
      if (streak?.digest !== digest) streak = { digest, failures: 0 };
      const current = streak;
      let outcome: XsSendOutcome;
      try {
        const invocation = deps.activation === true ? deps.invocation?.(toolCallId) : undefined;
        outcome = await deps.sender.message({
          ...(invocation ? { invocation } : {}),
          ...(signal !== undefined ? { signal } : {}),
          to: params.to,
          text: params.text,
          ...(params.wake !== undefined ? { wake: params.wake } : {}),
          ...(expectReply !== undefined ? { expectReply } : {}),
          ...(replyTo !== undefined ? { replyTo } : {}),
        });
      } catch {
        // A throw is not evidence of none (the port may have acted). Do not invent a sender outcome.
        throw new Error(
          "message_session: unexpected failure — 无法确认发送效果；不要重发正文，请用户核对状态；如已有原 receipt，仅查询该 receipt。",
        );
      }
      // An older in-flight call must not change the streak for newer parameters.
      if (streak === current) {
        current.failures = outcome.status === "bad_args" ? Math.min(current.failures + 1, 5) : 0;
      }
      let hint = "";
      if (replyOn && outcome.status === "bad_args" && outcome.reason === "expect_and_reply_to")
        hint +=
          "\n发起请求请使用 expectReply 且不要带 replyTo；回复别人时使用 replyTo，其值必须来自请求头，不要编造。两条路径互斥。";
      if (streak === current && outcome.status === "bad_args" && current.failures >= 2)
        hint += `\n相同参数已连续失败 ${current.failures} 次，请修改参数或停止重试。若目标是会话名，先用 list_sessions 确认 ref。`;
      if (replyOn) {
        if (outcome.reply?.state === "pending")
          hint += `\n${xsReplyIssuedHint(outcome.reply.requestId, outcome.reply.dueAt)}`;
        if (outcome.replyTo !== undefined) {
          if (outcome.effect === "unknown") hint += `\n${XS_REPLY_TO_UNKNOWN_HINT}`;
          else if (outcome.effect === "none" && outcome.reason === "rejected") hint += `\n${XS_REPLY_TO_REJECTED_HINT}`;
        } else if (outcome.effect === "unknown") hint += `\n${XS_UNKNOWN_HINT}`;
      } else if (outcome.effect === "unknown") hint = `\n${XS_UNKNOWN_HINT}`;
      if (
        outcome.effect === "none" &&
        (outcome.status === "bad_target" || outcome.status === "no_target" || outcome.status === "ambiguous")
      )
        hint +=
          "\n`to` 只接受 `list_sessions` 给出的 ref、完整 session id 或精确会话名；先用 `list_sessions` 确认目标再发送。";
      // replyTo's once-only rejection explanation takes precedence over generic policy advice.
      const failureHint =
        outcome.replyTo !== undefined && outcome.reason === "rejected" ? "" : xsNoneFailureHint(outcome);
      if (failureHint) hint += `\n${failureHint}`;
      if (deps.alias === true && outcome.status === "alias_unavailable") hint += `\n${XS_ALIAS_UNAVAILABLE_HINT}`;
      if (deps.activation === true && outcome.wakeDowngraded)
        hint += `\n${xsWakeDowngradedHint(outcome.wakeDowngraded, outcome.effect)}`;
      if (deps.idleWakeAdvice === true && xsIdleNoWakeRisk(outcome)) hint += `\n${XS_IDLE_NO_WAKE_HINT}`;
      return { content: [{ type: "text", text: JSON.stringify(outcome) + hint }], details: outcome };
    },
  };
}

/** #20 D1–D4: applied is evidence of idle at the receiver's pre-write sample, not current idleness. */
export const XS_IDLE_NO_WAKE_HINT =
  '注意：本次 expectReply 未请求唤醒，且投递时（接收端采样）对方会话空闲——这次写入不会触发对方处理，大概率等到超时也收不到回复。正文已送达，不要重发；需要对方处理请调用 wake_session（action "activate"，to 用本结果 to.ref，messageId/activationKey 取本结果 track）激活这条请求。只有正文未送达（effect none）时才改用 wake:true 重发。';

/** C1–C11. C11 also excludes contradictory applied+queued evidence (defense D-q). */
export function xsIdleNoWakeRisk(outcome: XsSendOutcome): boolean {
  return (
    outcome.status === "sent" &&
    outcome.effect === "applied" &&
    outcome.reply?.state === "pending" &&
    outcome.replyTo === undefined &&
    outcome.wake !== undefined &&
    outcome.wake.requested === false &&
    outcome.wakeDowngraded === undefined &&
    outcome.woke !== true &&
    outcome.track !== undefined &&
    outcome.track.activationKey !== undefined &&
    (outcome.progress?.phase === undefined || outcome.progress.phase === "delivered")
  );
}

export function xsWakeDowngradedHint(reason: string, effect: string): string {
  const quota = reason === "pair_wake_rate" ? "（hub，每会话对默认 2 次/小时）" : "";
  return `唤醒因 ${reason} 降级${quota}；${effect === "none" ? "正文未送达" : effect === "applied" ? "正文投递已确认，非 started 证明" : "正文可能已进入队列"}，不要重发。仅已确认送达且未开始的有效原 receipt 可人工 activate；配额降级须等待配额，unknown 只查询。`;
}
