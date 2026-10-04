/**
 * P1 (ask-user-async plan §3.1): the consumer-side port through which ask_user learns about
 * background task completions (subagent / workflow / background bash). The PROVIDER side
 * (the completion hub wired at the send points in src/stack.ts) is P2 — this file is the
 * pi-free contract both sides compile against, frozen by the first P1 commit (plan §10).
 *
 * When no port is injected (`AskUserWireOptions.background` undefined) ask_user is
 * byte-for-byte identical to the pre-feature behavior: no subscription, no timers, no
 * parked persistence, no notices.
 */

export type BackgroundCompletionKind = "subagent" | "workflow" | "bash";

export interface BackgroundCompletion {
  kind: BackgroundCompletionKind;
  /** >1 for a coalesced digest send. */
  count: number;
  /** §3.4 delivery token; undefined when the send happened while the agent was not streaming. */
  token: number | undefined;
  at: number;
}

export interface AskUserBackgroundPort {
  /** Returns the unsubscribe function. Listeners are isolated (a throwing listener never
   *  reaches the other listeners or the sender). */
  subscribe(listener: (event: BackgroundCompletion) => void): () => void;
  /** Tokens synchronously steered but not yet confirmed by `message_start` (§3.4). */
  pendingTokens(): number;
  /** §2.4 self-check: token delivery state; undefined = unknown (disposed / never minted). */
  tokenState(token: number): "pending" | "consumed" | "orphaned" | undefined;
  /** True once the runtime self-check has disabled the interrupt for this process (§2.4). */
  readonly disabled: boolean;
}
