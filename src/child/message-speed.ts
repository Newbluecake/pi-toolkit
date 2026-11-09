/** Child-local observation only: no hub client, global registry, timer or SDK message mutation. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentSettings } from "../config/settings.js";
import { createMessageSpeed, type MessageSpeedOwner } from "../web-hub/agent/message-speed.js";
import { messageSpeedBinding } from "../web-hub/agent/message-speed-binding.js";
import { wireMessageSpeed } from "../web-hub/agent/message-speed-wire.js";

export interface ChildMessageSpeedOptions {
  /** Must synchronously recheck the secure domain at the actual append point. Missing fails closed. */
  secureRecheckForWrite?: (ctx: ExtensionContext) => unknown;
  monotonicNow?: () => number;
}

export function wireChildMessageSpeed(
  pi: ExtensionAPI,
  settings: AgentSettings,
  options: ChildMessageSpeedOptions = {},
): void {
  if (!settings.webHub?.enabled || settings.webHub.subagentTranscript === "off") return;

  const activationGeneration = {};
  let sessionGeneration = 0;
  let current: ExtensionContext | undefined;
  let manager: ExtensionContext["sessionManager"] | undefined;
  let owner: MessageSpeedOwner | undefined;
  const speed = createMessageSpeed({
    ...(options.monotonicNow ? { monotonicNow: options.monotonicNow } : {}),
    currentOwner: () =>
      current !== undefined &&
      current.sessionManager === manager &&
      current.sessionManager.getSessionId() === owner?.sessionId
        ? owner
        : undefined,
    getCurrentContext: () => current,
    sessionId: (ctx: ExtensionContext) => ctx.sessionManager.getSessionId(),
    ...(options.secureRecheckForWrite ? { secureRecheckForWrite: options.secureRecheckForWrite } : {}),
    appendEntry: (type, data) => pi.appendEntry(type, data),
  });
  const clear = () => {
    speed.reset();
    current = undefined;
    manager = undefined;
    owner = undefined;
  };
  const noteContext = (ctx: ExtensionContext) => {
    current = ctx;
    // An observed owner switch poisons the whole loop, even if it switches back.
    if (
      owner !== undefined &&
      (ctx.sessionManager !== manager || ctx.sessionManager.getSessionId() !== owner.sessionId)
    )
      clear();
  };
  // Reuse the existing public raw-proof port and invisible custom-entry renderer.
  // No EventTap: this batch deliberately does NOT stamp live run messages.
  wireMessageSpeed(pi, speed, (ctx) => {
    noteContext(ctx);
    return owner !== undefined;
  });
  pi.on("agent_start", (event, ctx) => {
    clear();
    current = ctx;
    manager = ctx.sessionManager;
    owner = {
      sessionId: manager.getSessionId(),
      sessionGeneration: ++sessionGeneration,
      activationGeneration,
      ownerToken: {},
    };
    speed.event({ type: event.type });
  });
  const forward = (event: { type: string }, ctx: ExtensionContext) => {
    noteContext(ctx);
    speed.event(event as Record<string, unknown>);
  };
  pi.on("turn_start", forward);
  pi.on("message_start", forward);
  pi.on("turn_end", forward);
  pi.on("message_update", (event, ctx) => {
    noteContext(ctx);
    const delta = event.assistantMessageEvent;
    // The unmerged public delta, never the accumulated assistant message/content.
    speed.delta(
      delta.type,
      "delta" in delta && typeof delta.delta === "string" ? delta.delta : "",
      messageSpeedBinding(event),
    );
  });
  pi.on("message_end", (event, ctx) => {
    noteContext(ctx);
    speed.end(event.message);
  });
  // Child AgentSession.dispose() need not emit shutdown. All closures belong ONLY
  // to this pi instance (no external roots); agent_end/settled release context and
  // pending final-message references, and dispose can GC the whole graph directly.
  pi.on("agent_end", clear);
  pi.on("agent_settled", clear);
  pi.on("session_shutdown", clear);
}
