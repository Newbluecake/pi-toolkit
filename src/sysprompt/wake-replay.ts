/**
 * Wake-run prompt replay, pure core (sysprompt-stable plan v3.1 §4.4, package S1).
 *
 * Notification wake runs (`pi.sendMessage(…, { triggerTurn: true })`) never pass
 * through `before_agent_start` (its only caller is `prompt()`), so their request
 * head is rendered from the base prompt while user runs carry the run-level
 * forced text — two alternating byte lineages that invalidate the whole prompt
 * prefix on every cross-class switch (field-2026-09-24 §5.1: 44% vs 10%).
 *
 * This module holds no pi imports and no state beyond the `WakeReplay` closure:
 * `buildReplayMessages` reproduces pi's own forced-prompt projection shape
 * (0.87.1 `agent-session.js` `_installAgentForcedPromptProjection`) so a replayed
 * wake request is byte-identical to what the following user run will send.
 */

/** Minimal structural message type: this module must not import pi. */
export type MessageLike = { role: string } & Record<string, unknown>;

/**
 * Structural slice of pi-ai's `getCurrentSystemMessage` (the only fields the
 * replay head needs). Assignable from the real helper since its parameter type
 * `TranscriptMessages = readonly { role: string }[]` is the wider one.
 */
export type GetCurrentSystemMessage = (
  messages: readonly MessageLike[],
) => { toolsAdded?: unknown[]; timestamp?: number } | undefined;

/**
 * Field-for-field isomorphic to pi's forced-prompt projection
 * (`_installAgentForcedPromptProjection`, 0.87.1 agent-session.js):
 * `[head, …non-system messages]` where `head` = `{ role: "system", content:
 * forced, toolsAdded?: current.toolsAdded, timestamp: current.timestamp ?? now() }`
 * — every other system message is dropped, `toolsAdded` is taken from the
 * transcript's CURRENT resolved tool set (the real declarations, not a stale
 * copy), and the timestamp is preserved from the first system message
 * (invariant I8). Does not mutate the input array or its entries.
 *
 * Applying this to its own output is idempotent (review-3 conclusion 1:
 * verified against the real projection), so pi re-projecting a forced run on
 * top of our replay result is a no-op.
 */
export function buildReplayMessages(
  messages: readonly MessageLike[],
  forced: string,
  getCurrentSystemMessage: GetCurrentSystemMessage,
  now: () => number = () => Date.now(),
): MessageLike[] {
  const current = getCurrentSystemMessage(messages);
  const head: MessageLike = {
    role: "system",
    content: forced,
    ...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
    timestamp: current?.timestamp ?? now(),
  };
  return [head, ...messages.filter((message) => message.role !== "system")];
}

/**
 * Single-state capture cell (review-2 #5: no `pendingCapture`, no request-time
 * capture — F15 guarantees the `before_agent_start` chain value is byte-identical
 * to what requests will use). All state lives in this closure; `/reload` builds
 * a fresh one because the wiring is called from `activate()`.
 */
export interface WakeReplay {
  /** Record the forced text to replay; `undefined` clears the capture. */
  capture(forced: string | undefined): void;
  captured(): string | undefined;
  /**
   * Replay onto a request's messages. `undefined` (= leave the request
   * untouched, i.e. today's behavior) when nothing is captured or the pi-ai
   * transcript helper is unavailable (§4.8: no helper ⇒ no replay).
   */
  apply(messages: readonly MessageLike[]): MessageLike[] | undefined;
  reset(): void;
}

export function createWakeReplay(deps: { getCurrentSystemMessage: GetCurrentSystemMessage | undefined }): WakeReplay {
  let captured: string | undefined;
  return {
    capture(forced) {
      captured = forced;
    },
    captured() {
      return captured;
    },
    apply(messages) {
      if (captured === undefined || deps.getCurrentSystemMessage === undefined) return undefined;
      return buildReplayMessages(messages, captured, deps.getCurrentSystemMessage);
    },
    reset() {
      captured = undefined;
    },
  };
}
