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

export const MessageSessionParams = Type.Object({
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
export type MessageSessionParams = Static<typeof MessageSessionParams>;

/** r3 S3 wording for every `unknown` verdict — advice prose, so Chinese is correct per the
 *  UI-language split; the model must not blindly resend. */
export const XS_UNKNOWN_HINT = "注意：这条消息可能已进入对方队列，通常在对方下一个 turn 边界可见；不要重发。";

export interface MessageSessionToolDeps {
  sender: XsSender;
}

export function createMessageSessionTool(deps: MessageSessionToolDeps): ToolDefinition<typeof MessageSessionParams> {
  return {
    name: "message_session",
    label: "message_session",
    description:
      "Send a message to another joined main session on this machine's web hub (fabric cross-session; the recipient " +
      "sees it as untrusted input). Reply to an incoming cross-session message by messaging its from.ref. " +
      'effect "applied" = delivery confirmed; "none" = provably NOT delivered (safe to retry later); "unknown" = the ' +
      "message may have entered the recipient's queue — it usually becomes visible at the recipient's next turn " +
      "boundary; do NOT blindly resend.",
    parameters: MessageSessionParams,
    async execute(_toolCallId, params) {
      const outcome: XsSendOutcome = await deps.sender.message({
        to: params.to,
        text: params.text,
        ...(params.wake !== undefined ? { wake: params.wake } : {}),
      });
      const hint = outcome.effect === "unknown" ? `\n${XS_UNKNOWN_HINT}` : "";
      return { content: [{ type: "text", text: JSON.stringify(outcome) + hint }], details: outcome };
    },
  };
}
