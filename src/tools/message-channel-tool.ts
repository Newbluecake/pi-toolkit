import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import type { XsSender } from "../fabric/xs/sender.js";
import { xsNoneFailureHint } from "./message-session-tool.js";
import type { XsBroadcastOutcome } from "../fabric/xs/types-channel.js";

/**
 * Channel plan §5/§6.1 (CH4): `message_channel` — broadcast one message to every session that
 * shares a named channel with you. Registered (by CHW) ONLY in the main session and only while
 * `xsOn ∧ channels.enabled`; child sessions never get it. The schema is a frozen module constant
 * (provider-cache-prefix convention). No `expectReply` (a broadcast has no single replier) and
 * `#default` cannot be broadcast to (Q2) — both refused by the sender/hub, not by the schema.
 */

export const MessageChannelParams = Type.Object(
  {
    channel: Type.String({
      maxLength: 33,
      description:
        "Channel to broadcast to, e.g. #team (the leading # is optional). You must have joined it; #default cannot be broadcast to.",
    }),
    text: Type.String({
      maxLength: 16_384,
      description: "Message body. Truncated to fabric.maxChars (75% head + 25% tail) before sending.",
    }),
    wake: Type.Optional(
      Type.Boolean({
        description:
          "Omit or false (default): deliver only. true: also wake recipients — EXPENSIVE; only for human-initiated chains, " +
          "at most 4 recipients and 2 wake-broadcasts per hour; otherwise it is downgraded to deliver-only with the " +
          "reason in wakeDowngraded.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type MessageChannelParams = Static<typeof MessageChannelParams>;

/** Advice prose for `unknown`/partial verdicts (Chinese per the UI-language split). */
export const XS_BROADCAST_UNKNOWN_HINT =
  "注意：广播可能已部分或全部进入对方队列；不要重发整条广播。需要补发时，只对 effect 为 none 的 ref 单独用 message_session。";

const DESCRIPTION =
  "Broadcast a message to every other session that joined the same named channel on this machine's web hub " +
  "(fabric cross-session; recipients see it as untrusted input). To answer a broadcast you received, use " +
  "message_session with its from.ref — never message_channel. #default cannot be broadcast to. " +
  'effect "applied" = all recipients confirmed; "none" = provably nobody got it; "unknown" = partial or unconfirmed ' +
  "(see results per recipient) — do NOT resend the whole broadcast.";

export interface MessageChannelToolDeps {
  sender: XsSender;
}

export function createMessageChannelTool(deps: MessageChannelToolDeps): ToolDefinition<typeof MessageChannelParams> {
  return {
    name: "message_channel",
    label: "message_channel",
    description: DESCRIPTION,
    parameters: MessageChannelParams,
    async execute(_toolCallId, params, signal) {
      let outcome: XsBroadcastOutcome;
      try {
        outcome = await deps.sender.broadcast({
          ...(signal !== undefined ? { signal } : {}),
          channel: params.channel,
          text: params.text,
          ...(params.wake !== undefined ? { wake: params.wake } : {}),
        });
      } catch {
        throw new Error(
          "message_channel: unexpected failure — 无法确认广播效果，可能已部分投递；不要重发整条广播，请用户核对原结果。",
        );
      }
      let hint = outcome.effect === "unknown" ? `\n${XS_BROADCAST_UNKNOWN_HINT}` : "";
      if (outcome.effect === "none") {
        const advice =
          outcome.status === "default_channel"
            ? "#default 不支持广播；请用 list_sessions 确认本次意图中的精确目标，再单独 message_session，不要猜测收件人。"
            : outcome.status === "bad_channel"
              ? "频道名无效、保留或不在当前链路；核对原频道名及 /fabric status。请用户确认成员资格，不要自行 join 或换频道绕过。"
              : outcome.status === "fanout_too_large"
                ? "收件人数超过广播上限；停止本次广播，请用户缩小明确的收件范围，不要拆批绕过上限。"
                : outcome.reason === "no_recipients"
                  ? "当前频道没有可投递收件人；用 list_sessions 核对可见目标，不要猜测收件人或自行加入其他频道。"
                  : xsNoneFailureHint(outcome);
        if (advice) hint += `\n${advice}`;
      }
      return { content: [{ type: "text", text: JSON.stringify(outcome) + hint }], details: outcome };
    },
  };
}
