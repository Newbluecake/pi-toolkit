/**
 * ask-user background interrupt (docs/dev/ask-user-async/plan.md §3, P2):
 * the background-completion hub — the provider half of the interrupt data
 * path. pi-free.
 *
 * The plan's §3.1 consumer port (`AskUserBackgroundPort`) is frozen in
 * `src/ask-user/background.ts` (P1's first commit) and RE-EXPORTED here —
 * there must never be two parallel definitions. Both files are pi-free, so
 * this type-only import (erased at compile time) does not violate layering.
 *
 * What the hub does (§3.2):
 *  - `createSender(send)` wraps the three real completion-notice send points
 *    (subagent single/digest, workflow settle, bash job settle) so every
 *    successful streaming-time send mints a token and broadcasts a
 *    `BackgroundCompletion`. A synchronous throw from `send` propagates
 *    untouched — no token, no broadcast (the workflow sink DEPENDS on the
 *    throw to fall back to persisted re-delivery, workflow-notice.ts).
 *  - Token confirmation is a state machine (§3.4, replacing v1's
 *    business-key dequeue): every token carries the message's customType and
 *    a sha1 of its content; `message_start` confirms the oldest pending
 *    token with the same customType AND hash, falling back to the oldest
 *    pending of the same customType (diag.mismatch) when pi rewrote the
 *    content, and counting diag.unmatched when nothing is pending (re-sends,
 *    non-streaming sends).
 *  - Orphan detection (§2.4 self-check): a token still pending when its run
 *    settles is an ORPHAN — explicit detection, never a silent cleanup. A
 *    settle with ≥1 settle-orphan counts one failure (settle-level, per the
 *    plan author); a settle whose run minted tokens but orphaned none resets
 *    the streak; a settle with no tokens at all changes nothing. Two
 *    consecutive failures disable the interrupt for the REST OF THE PROCESS
 *    (`Symbol.for` global — a module-level flag would reset on pi's
 *    fresh-module `/reload`, a per-hub one on every session rebuild), with
 *    one WARN, same "post-verified, 2 consecutive" precedent as
 *    `src/context-switch/capability.ts`. Behavior check, never a version
 *    check (I14).
 *
 * Compatibility assumptions A1–A4 this file relies on are recorded in
 * `src/adapters/pi-compat.ts`'s honesty note and locked by the S0
 * conformance suite (C7/C8/C9/C10/C11).
 */
import { createHash } from "node:crypto";

// ── §3.1 consumer port (frozen in src/ask-user/background.ts by P1) ─────────

import type { AskUserBackgroundPort, BackgroundCompletion, BackgroundCompletionKind } from "../ask-user/background.js";
export type { AskUserBackgroundPort, BackgroundCompletion, BackgroundCompletionKind };

// ── provider side ───────────────────────────────────────────────────────────

/** The message shape pi's ExtensionAPI.sendMessage accepts (void return). */
export interface CompletionMessage {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
}
export type SendMessageFn = (message: CompletionMessage, options?: { triggerTurn?: boolean }) => void;

/** §3.2 sender: `sendCompletion(kind, message, options, count?)`; `count` is the digest item count (default 1). */
export type SendCompletion = (
  kind: BackgroundCompletionKind,
  message: CompletionMessage,
  options?: { triggerTurn?: boolean },
  count?: number,
) => void;

export interface BackgroundCompletionDiag {
  /** message_start matched a pending token by customType but NOT by content hash. */
  mismatch: number;
  /** message_start for a tracked customType with no pending token to confirm. */
  unmatched: number;
  /** Tokens still pending when their agent run settled (feeds the §2.4 self-check). */
  orphaned: number;
}

export interface BackgroundCompletionHub extends AskUserBackgroundPort {
  createSender(send: SendMessageFn): SendCompletion;
  /** Forwarded from the `message_start` event (index.ts, holder-routed). */
  noteMessageStart(message: { role?: string; customType?: string; content?: unknown }): void;
  /** Forwarded from the `agent_end` event. */
  noteAgentEnd(): void;
  /** Forwarded from the `agent_settled` event. */
  noteAgentSettled(): void;
  /**
   * §3.3: clears listeners and stops all bookkeeping — after dispose,
   * sendCompletion only forwards to `send` (no token, no broadcast), so an
   * old stack's coalescer/bash flush during teardown can never interrupt the
   * new session. Idempotent.
   */
  dispose(): void;
  readonly diag: BackgroundCompletionDiag;
}

/** §3.4: pending tokens beyond this cap evict the oldest to orphaned (NOT counted by the self-check). */
export const BACKGROUND_COMPLETION_PENDING_CAP = 64;
/** Retained token records (any state) for `tokenState` lookups; oldest evicted first. */
const TOKEN_RETENTION = 256;

/** The only customTypes this hub ever mints tokens for — message_start of any other type is ignored entirely. */
const TRACKED_CUSTOM_TYPES: ReadonlySet<string> = new Set([
  "subagent:notification",
  "subagent:workflow-notification",
  "bash-job:notification",
]);

// ── §2.4 process-wide self-check health (sticky until pi restarts) ──────────

const HEALTH_KEY = Symbol.for("pi-subagent:ask-user-interrupt-health");
interface InterruptHealth {
  consecutiveFailures: number;
  disabled: boolean;
  warned: boolean;
}
type HealthGlobal = typeof globalThis & { [HEALTH_KEY]?: InterruptHealth };

function health(): InterruptHealth {
  const g = globalThis as HealthGlobal;
  return (g[HEALTH_KEY] ??= { consecutiveFailures: 0, disabled: false, warned: false });
}

/** Test hook: reset the process-global self-check state. */
export function resetBackgroundCompletionHealthForTest(): void {
  delete (globalThis as HealthGlobal)[HEALTH_KEY];
}

function noteSettleOutcome(tokensMinted: number, orphaned: number): void {
  const h = health();
  if (tokensMinted === 0) return; // a settle with no tokens neither adds nor resets
  if (orphaned === 0) {
    h.consecutiveFailures = 0;
    return;
  }
  h.consecutiveFailures += 1;
  if (h.consecutiveFailures >= 2 && !h.disabled) {
    h.disabled = true;
    if (!h.warned) {
      h.warned = true;
      console.warn(
        "[pi-subagent] ask-user background interrupt disabled for this process: completion notices failed " +
          "delivery confirmation (message_start) in 2 consecutive agent runs — pi's delivery semantics may have " +
          "changed; run npm run test:conformance before upgrading pi",
      );
    }
  }
}

// ── hub ─────────────────────────────────────────────────────────────────────

type TokenState = "pending" | "consumed" | "orphaned";
interface CompletionToken {
  seq: number;
  customType: string;
  contentHash: string;
  count: number;
  kind: BackgroundCompletionKind;
  sentAt: number;
  state: TokenState;
}

function hashContent(content: unknown): string {
  const text = typeof content === "string" ? content : (JSON.stringify(content) ?? String(content));
  return createHash("sha1").update(text).digest("hex");
}

export function createBackgroundCompletionHub(deps: {
  /** Sampled BEFORE each send (§3.2 step 1): true ⇒ the send lands in the steer queue and mints a token. */
  isStreaming: () => boolean;
  now: () => number;
}): BackgroundCompletionHub {
  const listeners = new Set<(event: BackgroundCompletion) => void>();
  const tokens = new Map<number, CompletionToken>();
  const diag: BackgroundCompletionDiag = { mismatch: 0, unmatched: 0, orphaned: 0 };
  let disposed = false;
  let seq = 0;
  /** seq at the most recent agent_end (tokens minted after it belong to the NEXT run's judgment). */
  let endSeq: number | undefined;
  /** seq boundary of the last settle — tokens in (lastSettleSeq, endSeq] belong to the run being judged. */
  let lastSettleSeq = 0;

  const pendingTokens = (): CompletionToken[] => {
    const out: CompletionToken[] = [];
    for (const t of tokens.values()) if (t.state === "pending") out.push(t);
    return out; // Map iteration order == insertion order == seq order
  };

  const evictRetention = (): void => {
    while (tokens.size > TOKEN_RETENTION) {
      // Prefer the oldest non-pending record; a pending one is only evicted
      // (as silently vanished) when the map is ALL pending — impossible in
      // practice since the pending cap (64) is far below TOKEN_RETENTION.
      let evicted = false;
      for (const [key, t] of tokens) {
        if (t.state !== "pending") {
          tokens.delete(key);
          evicted = true;
          break;
        }
      }
      if (!evicted) {
        const oldest = tokens.keys().next();
        if (oldest.done) return;
        tokens.delete(oldest.value);
      }
    }
  };

  const mint = (kind: BackgroundCompletionKind, message: CompletionMessage, count: number): CompletionToken => {
    seq += 1;
    const token: CompletionToken = {
      seq,
      customType: message.customType,
      contentHash: hashContent(message.content),
      count,
      kind,
      sentAt: deps.now(),
      state: "pending",
    };
    tokens.set(seq, token);
    // §3.4 cap: oldest pending rolls to orphaned — explicit state, but NOT a
    // self-check failure (the queue simply outpaced consumption).
    const pending = pendingTokens();
    for (let i = 0; i < pending.length - BACKGROUND_COMPLETION_PENDING_CAP; i++) pending[i]!.state = "orphaned";
    evictRetention();
    return token;
  };

  const broadcast = (event: BackgroundCompletion): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // one bad listener must never break the others or the send path (§3.2)
      }
    }
  };

  return {
    get disabled() {
      return health().disabled;
    },
    diag,

    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    pendingTokens() {
      if (disposed) return 0;
      return pendingTokens().length;
    },

    tokenState(token) {
      if (disposed) return undefined;
      return tokens.get(token)?.state;
    },

    createSender(send) {
      return (kind, message, options, count = 1) => {
        if (disposed) {
          send(message, options);
          return;
        }
        // §3.2 step 1: sample BEFORE the send — a streaming-time send has
        // synchronously entered the steer queue by the time send returns (A1/C8).
        const streaming = deps.isStreaming();
        // §3.2 step 2: a synchronous throw propagates untouched — no token, no broadcast.
        send(message, options);
        const token = streaming ? mint(kind, message, count) : undefined;
        broadcast({ kind, count, token: token?.seq, at: deps.now() });
      };
    },

    noteMessageStart(message) {
      if (disposed) return;
      if (message.role !== "custom") return;
      const customType = message.customType;
      if (customType === undefined || !TRACKED_CUSTOM_TYPES.has(customType)) return;
      const hash = hashContent(message.content);
      const pending = pendingTokens().filter((t) => t.customType === customType);
      // §3.4: oldest pending with same customType AND hash …
      const exact = pending.find((t) => t.contentHash === hash);
      if (exact) {
        exact.state = "consumed";
        return;
      }
      // … else oldest pending of the same customType (content rewritten?) …
      const fallback = pending[0];
      if (fallback) {
        fallback.state = "consumed";
        diag.mismatch += 1;
        return;
      }
      // … else nothing to confirm (re-send, non-streaming send).
      diag.unmatched += 1;
    },

    noteAgentEnd() {
      if (disposed) return;
      endSeq = seq;
    },

    noteAgentSettled() {
      if (disposed) return;
      // Defensive: pi's contract is agent_end before agent_settled, but if an
      // end was never observed, judge every token minted so far.
      const boundary = endSeq ?? seq;
      // Tokens minted between agent_end and agent_settled (seq > endSeq, by
      // other settled handlers) survive — they confirm in the NEXT run (§3.4).
      let minted = 0;
      let orphaned = 0;
      for (const t of tokens.values()) {
        if (t.seq <= lastSettleSeq || t.seq > boundary) continue;
        minted += 1;
        if (t.state === "pending") {
          t.state = "orphaned";
          diag.orphaned += 1;
          orphaned += 1;
        }
      }
      noteSettleOutcome(minted, orphaned);
      lastSettleSeq = boundary;
      endSeq = undefined;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      tokens.clear();
    },
  };
}
