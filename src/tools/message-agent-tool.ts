import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import type { NodeRef, MessageKind } from "../core/message.js";
import type { FabricRouter, AdmissionResult } from "../fabric/router.js";
import type { MentionChannel, MentionSendResult } from "../fabric/mention.js";

export const MessageAgentParams = Type.Object({
  to: Type.String({
    description:
      'Target run id, "root" for the root session, or @label for a registered top-level agent (requires can_message: mention)',
  }),
  kind: Type.Union([Type.Literal("progress"), Type.Literal("finding"), Type.Literal("directive")]),
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

export function createMessageAgentTool(deps: MessageAgentToolDeps): ToolDefinition<typeof MessageAgentParams> {
  const wakeOn = deps.wakeOn === true;
  return {
    name: "message_agent",
    label: "message_agent",
    description: "Send a progress, finding, or directive message to another agent or the root session.",
    // The wake-on schema is a strict superset (one extra optional field), so the declared tool type stays the legacy one.
    parameters: messageAgentParams({ wake: wakeOn }) as typeof MessageAgentParams,
    async execute(_toolCallId, params) {
      const wake = wakeOn ? (params as { wake?: unknown }).wake : undefined;
      if (wake !== undefined && typeof wake !== "boolean") throw new Error("message_agent: wake must be a boolean");
      const result: AdmissionResult | MentionSendResult =
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
                  throw new Error(`message_agent: cannot determine generation for ${deps.from}`);
                return deps.router.admit(deps.from, {
                  to: params.to as NodeRef,
                  kind: params.kind as MessageKind,
                  text: params.text,
                  generation: generation as never,
                  ...(wake === undefined ? {} : { wake }),
                  ...(deps.canMessage === undefined ? {} : { canMessage: deps.canMessage }),
                });
              })();
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
