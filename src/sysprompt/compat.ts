import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as piAi from "@earendil-works/pi-ai";
import type { GetCurrentSystemMessage, MessageLike } from "./wake-replay.js";

export type ContextWithSystemHandlerResult = { messages: MessageLike[] } | undefined;
export type ContextWithSystemHandler = (
  event: { messages: MessageLike[] },
  ctx: ExtensionContext,
) => ContextWithSystemHandlerResult | Promise<ContextWithSystemHandlerResult>;

export function readForceSystemPrompt(event: unknown): string | undefined {
  if (event === null || typeof event !== "object") return undefined;
  const options = (event as { systemPromptOptions?: unknown }).systemPromptOptions;
  if (options === null || typeof options !== "object") return undefined;
  const forced = (options as { forceSystemPrompt?: unknown }).forceSystemPrompt;
  return typeof forced === "string" ? forced : undefined;
}

export function getTranscriptHelpers(): { getCurrentSystemMessage: GetCurrentSystemMessage } | undefined {
  const ns = piAi as unknown as { getCurrentSystemMessage?: GetCurrentSystemMessage };
  return typeof ns.getCurrentSystemMessage === "function"
    ? { getCurrentSystemMessage: ns.getCurrentSystemMessage }
    : undefined;
}

export function onContextWithSystem(pi: ExtensionAPI, handler: ContextWithSystemHandler): void {
  pi.on("context_with_system", async (event, ctx) => {
    const result = await handler({ messages: event.messages as unknown as MessageLike[] }, ctx);
    return result === undefined ? undefined : { messages: result.messages as unknown as typeof event.messages };
  });
}

export function tryGetSystemPrompt(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.getSystemPrompt();
  } catch {
    return undefined;
  }
}
