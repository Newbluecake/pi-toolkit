import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import type { XsSendOutcome, XsSender } from "../fabric/xs/sender.js";

/**
 * fabric phase-2 X3 (phase2-plan §4.3 + r3 M2/S3): `message_session` — the send half of the
 * main-session cross-session tool pair. Finding semantics only (P5: no `kind` parameter); the
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
  /** `fabric.crossSession.reply.enabled` frozen at activate: selects the schema instance and the
   *  description. Omitted/false ⇒ the legacy tool, byte-identical to pre-reply. */
  reply?: boolean;
  /** `alias.enabled` ∧ hub cap frozen at activate (alias-plan §6): selects the alias description (schema
   *  identical to the same reply-mode instance; `to` already accepts any ≤128-char string). Omitted/false ⇒ byte-identical. */
  alias?: boolean;
}

const ALIAS_TO_SUFFIX =
  ' When the user refers to a session by a short word (e.g. "给前端发消息"), pass that word verbatim as `to`: aliases are ' +
  "unique on this hub and matched before names. If the result is no_target or ambiguous, call list_sessions and ask " +
  "the user — never guess or pick the closest one.";

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
  "boundary; do NOT blindly resend a request (a replyTo resend is idempotent but may be refused).";

export function createMessageSessionTool(
  deps: MessageSessionToolDeps,
): ToolDefinition<typeof MessageSessionParamsLegacy> {
  const replyOn = deps.reply === true;
  return {
    name: "message_session",
    label: "message_session",
    description: (replyOn ? REPLY_DESCRIPTION : LEGACY_DESCRIPTION) + (deps.alias === true ? ALIAS_TO_SUFFIX : ""),
    parameters: (replyOn ? MessageSessionParamsReply : MessageSessionParamsLegacy) as typeof MessageSessionParamsLegacy,
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as MessageSessionParams;
      // legacy instance: the new fields can never legitimately arrive, and are never forwarded
      const expectReply = replyOn ? params.expectReply : undefined;
      const replyTo = replyOn ? params.replyTo : undefined;
      const outcome: XsSendOutcome = await deps.sender.message({
        ...(signal !== undefined ? { signal } : {}),
        to: params.to,
        text: params.text,
        ...(params.wake !== undefined ? { wake: params.wake } : {}),
        ...(expectReply !== undefined ? { expectReply } : {}),
        ...(replyTo !== undefined ? { replyTo } : {}),
      });
      let hint = "";
      if (replyOn) {
        if (outcome.reply?.state === "pending")
          hint += `\n${xsReplyIssuedHint(outcome.reply.requestId, outcome.reply.dueAt)}`;
        if (outcome.replyTo !== undefined) {
          if (outcome.effect === "unknown") hint += `\n${XS_REPLY_TO_UNKNOWN_HINT}`;
          else if (outcome.effect === "none" && outcome.reason === "rejected") hint += `\n${XS_REPLY_TO_REJECTED_HINT}`;
        } else if (outcome.effect === "unknown") hint += `\n${XS_UNKNOWN_HINT}`;
      } else if (outcome.effect === "unknown") hint = `\n${XS_UNKNOWN_HINT}`;
      if (deps.alias === true && outcome.status === "alias_unavailable") hint += `\n${XS_ALIAS_UNAVAILABLE_HINT}`;
      return { content: [{ type: "text", text: JSON.stringify(outcome) + hint }], details: outcome };
    },
  };
}
