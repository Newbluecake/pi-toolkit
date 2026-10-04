import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_COMPLETION_PENDING_CAP,
  createBackgroundCompletionHub,
  resetBackgroundCompletionHealthForTest,
  type BackgroundCompletion,
  type CompletionMessage,
} from "../../src/service/background-completions.js";

/**
 * ask-user-async plan §10 P2-1: hub unit tests — token minting (streaming
 * only), sync-throw pass-through, listener isolation, the §3.4 token state
 * machine (hash confirm / customType fallback / FIFO / unmatched / orphan
 * windows / cap), and the §2.4 process-wide self-check (2 consecutive
 * settle-level orphan runs ⇒ disabled + one WARN).
 */

function msg(content: string, customType = "subagent:notification"): CompletionMessage {
  return { customType, content, display: true, details: { content } };
}

function setup(streaming = true) {
  let now = 1_000;
  let isStreaming = streaming;
  const sent: { message: CompletionMessage; options?: { triggerTurn?: boolean } }[] = [];
  const events: BackgroundCompletion[] = [];
  const hub = createBackgroundCompletionHub({ isStreaming: () => isStreaming, now: () => now });
  const sendCompletion = hub.createSender((message, options) => {
    sent.push({ message, ...(options ? { options } : {}) });
  });
  hub.subscribe((event) => events.push(event));
  return {
    hub,
    sendCompletion,
    sent,
    events,
    setStreaming: (value: boolean) => {
      isStreaming = value;
    },
  };
}

// noteMessageStart takes the MESSAGE itself; the event→message unwrap lives in
// stack.ts's createBackgroundCompletionEventHook (covered by the integration test).
const start = (content: string, customType = "subagent:notification") => ({ role: "custom", customType, content });

beforeEach(() => {
  resetBackgroundCompletionHealthForTest();
});

describe("background-completions hub: minting & broadcast (§3.2)", () => {
  it("streaming send mints one token and broadcasts { kind, count, token, at }", () => {
    const { hub, sendCompletion, sent, events } = setup(true);
    sendCompletion("subagent", msg("a"), { triggerTurn: true });
    expect(sent).toHaveLength(1);
    expect(events).toEqual([{ kind: "subagent", count: 1, token: 1, at: 1_000 }]);
    expect(hub.pendingTokens()).toBe(1);
    expect(hub.tokenState(1)).toBe("pending");
  });

  it("non-streaming send broadcasts with token undefined and mints nothing (A4/C11)", () => {
    const { hub, sendCompletion, sent, events } = setup(false);
    sendCompletion("bash", msg("b", "bash-job:notification"), { triggerTurn: true });
    expect(sent).toHaveLength(1);
    expect(events).toEqual([{ kind: "bash", count: 1, token: undefined, at: 1_000 }]);
    expect(hub.pendingTokens()).toBe(0);
  });

  it("isStreaming is sampled BEFORE the send (a send that flips idle still mints)", () => {
    const { sendCompletion, events, setStreaming } = setup(true);
    // The send itself settles the run (idle by return) — the pre-send sample must win.
    const hubSend = sendCompletion;
    setStreaming(true);
    hubSend("subagent", msg("flip"), { triggerTurn: true });
    expect(events[0]!.token).toBe(1);
  });

  it("a synchronous throw from send propagates untouched: no token, no broadcast", () => {
    const hub = createBackgroundCompletionHub({ isStreaming: () => true, now: () => 0 });
    const events: BackgroundCompletion[] = [];
    hub.subscribe((event) => events.push(event));
    const boom = new Error("send failed");
    const sendCompletion = hub.createSender(() => {
      throw boom;
    });
    expect(() => sendCompletion("workflow", msg("w", "subagent:workflow-notification"), { triggerTurn: true })).toThrow(
      boom,
    );
    expect(events).toHaveLength(0);
    expect(hub.pendingTokens()).toBe(0);
  });

  it("a throwing listener is isolated from the other listeners and the send path", () => {
    const hub = createBackgroundCompletionHub({ isStreaming: () => true, now: () => 0 });
    const events: BackgroundCompletion[] = [];
    hub.subscribe(() => {
      throw new Error("bad listener");
    });
    hub.subscribe((event) => events.push(event));
    const sendCompletion = hub.createSender(() => undefined);
    expect(() => sendCompletion("subagent", msg("x"), { triggerTurn: true })).not.toThrow();
    expect(events).toHaveLength(1);
  });

  it("unsubscribe stops delivery", () => {
    const hub = createBackgroundCompletionHub({ isStreaming: () => true, now: () => 0 });
    const events: BackgroundCompletion[] = [];
    const unsub = hub.subscribe((event) => events.push(event));
    unsub();
    hub.createSender(() => undefined)("subagent", msg("x"));
    expect(events).toHaveLength(0);
  });
});

describe("background-completions hub: token state machine (§3.4)", () => {
  it("single: message_start with same customType + content confirms the token", () => {
    const { hub, sendCompletion } = setup(true);
    sendCompletion("subagent", msg("hello"), { triggerTurn: true });
    hub.noteMessageStart(start("hello"));
    expect(hub.tokenState(1)).toBe("consumed");
    expect(hub.pendingTokens()).toBe(0);
    expect(hub.diag).toEqual({ mismatch: 0, unmatched: 0, orphaned: 0 });
  });

  it("digest: one send mints ONE token carrying the item count", () => {
    const { hub, sendCompletion, events } = setup(true);
    sendCompletion("subagent", msg("digest of 3"), { triggerTurn: true }, 3);
    expect(events).toEqual([{ kind: "subagent", count: 3, token: 1, at: 1_000 }]);
    expect(hub.pendingTokens()).toBe(1);
    hub.noteMessageStart(start("digest of 3"));
    expect(hub.tokenState(1)).toBe("consumed");
  });

  it("hash mismatch falls back to the oldest pending of the same customType (diag.mismatch++)", () => {
    const { hub, sendCompletion } = setup(true);
    sendCompletion("subagent", msg("original"), { triggerTurn: true });
    hub.noteMessageStart(start("rewritten by pi"));
    expect(hub.tokenState(1)).toBe("consumed");
    expect(hub.diag.mismatch).toBe(1);
  });

  it("same-type concurrent sends with different content are matched by hash, not order", () => {
    const { hub, sendCompletion } = setup(true);
    sendCompletion("subagent", msg("A"), { triggerTurn: true });
    sendCompletion("subagent", msg("B"), { triggerTurn: true });
    hub.noteMessageStart(start("B")); // out of order — the later send confirms first
    expect(hub.tokenState(2)).toBe("consumed");
    expect(hub.tokenState(1)).toBe("pending");
    hub.noteMessageStart(start("A"));
    expect(hub.tokenState(1)).toBe("consumed");
    expect(hub.diag.mismatch).toBe(0);
  });

  it("identical content is indistinguishable — FIFO confirmation is correct", () => {
    const { hub, sendCompletion } = setup(true);
    sendCompletion("subagent", msg("same"), { triggerTurn: true });
    sendCompletion("subagent", msg("same"), { triggerTurn: true });
    hub.noteMessageStart(start("same"));
    expect(hub.tokenState(1)).toBe("consumed");
    expect(hub.tokenState(2)).toBe("pending");
    hub.noteMessageStart(start("same"));
    expect(hub.tokenState(2)).toBe("consumed");
  });

  it("message_start with no pending token counts diag.unmatched and changes no state (re-send)", () => {
    const { hub, sendCompletion } = setup(true);
    sendCompletion("subagent", msg("once"), { triggerTurn: true });
    hub.noteMessageStart(start("once"));
    hub.noteMessageStart(start("once")); // redelivery of the same content
    expect(hub.diag.unmatched).toBe(1);
    expect(hub.tokenState(1)).toBe("consumed");
  });

  it("ignores non-custom roles, untracked customTypes and missing content", () => {
    const { hub, sendCompletion } = setup(true);
    sendCompletion("subagent", msg("keep"), { triggerTurn: true });
    hub.noteMessageStart({ role: "user", customType: "subagent:notification", content: "keep" });
    hub.noteMessageStart({ role: "custom", customType: "subagent:timeout", content: "x" });
    hub.noteMessageStart({ role: "custom", customType: "subagent:notification", content: undefined });
    // Only the third one reached the matcher (tracked type, no hash match ⇒ fallback consume).
    expect(hub.tokenState(1)).toBe("consumed");
    expect(hub.diag.mismatch).toBe(1);
    expect(hub.diag.unmatched).toBe(0);
  });

  it("tokens minted between agent_end and agent_settled survive the settle (§3.4)", () => {
    const { hub, sendCompletion } = setup(true);
    sendCompletion("subagent", msg("in-run"), { triggerTurn: true });
    hub.noteAgentEnd();
    // Another settled handler sends AFTER agent_end — its token confirms in the NEXT run.
    sendCompletion("workflow", msg("late", "subagent:workflow-notification"), { triggerTurn: true });
    hub.noteAgentSettled();
    expect(hub.tokenState(1)).toBe("orphaned");
    expect(hub.tokenState(2)).toBe("pending");
    expect(hub.diag.orphaned).toBe(1);
    // …and the late token is judged by the NEXT run's settle.
    hub.noteAgentEnd();
    hub.noteAgentSettled();
    expect(hub.tokenState(2)).toBe("orphaned");
  });

  it("agent_settled without a preceding agent_end judges every token minted so far (defensive)", () => {
    const { hub, sendCompletion } = setup(true);
    sendCompletion("subagent", msg("no-end"), { triggerTurn: true });
    hub.noteAgentSettled();
    expect(hub.tokenState(1)).toBe("orphaned");
  });

  it(`pending beyond the ${"cap"} evicts the oldest to orphaned WITHOUT feeding the self-check`, () => {
    const { hub, sendCompletion } = setup(true);
    for (let i = 0; i < BACKGROUND_COMPLETION_PENDING_CAP + 2; i++)
      sendCompletion("subagent", msg(`n${i}`), { triggerTurn: true });
    expect(hub.pendingTokens()).toBe(BACKGROUND_COMPLETION_PENDING_CAP);
    expect(hub.tokenState(1)).toBe("orphaned");
    expect(hub.tokenState(2)).toBe("orphaned");
    expect(hub.tokenState(3)).toBe("pending");
    expect(hub.diag.orphaned).toBe(0); // cap eviction is not the §2.4 signal
    // A settle after cap eviction alone must not disable the port.
    hub.noteAgentEnd();
    hub.noteAgentSettled();
    expect(hub.disabled).toBe(false);
  });
});

describe("background-completions hub: §2.4 self-check (process-global, settle-level)", () => {
  it("two consecutive settles with orphans disable the port and WARN exactly once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { hub, sendCompletion } = setup(true);
      sendCompletion("subagent", msg("run1"), { triggerTurn: true });
      hub.noteAgentEnd();
      hub.noteAgentSettled();
      expect(hub.disabled).toBe(false);
      sendCompletion("subagent", msg("run2"), { triggerTurn: true });
      hub.noteAgentEnd();
      hub.noteAgentSettled();
      expect(hub.disabled).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      // Sticky: further orphan settles never warn again.
      sendCompletion("subagent", msg("run3"), { triggerTurn: true });
      hub.noteAgentEnd();
      hub.noteAgentSettled();
      expect(warn).toHaveBeenCalledTimes(1);
      // …and a NEW hub (next session build) still reads the process-global flag.
      const fresh = createBackgroundCompletionHub({ isStreaming: () => true, now: () => 0 });
      expect(fresh.disabled).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("a clean run (all tokens confirmed) resets the consecutive-failure streak", () => {
    const { hub, sendCompletion } = setup(true);
    sendCompletion("subagent", msg("r1"), { triggerTurn: true });
    hub.noteAgentEnd();
    hub.noteAgentSettled(); // failure 1
    sendCompletion("subagent", msg("r2"), { triggerTurn: true });
    hub.noteMessageStart(start("r2")); // confirmed
    hub.noteAgentEnd();
    hub.noteAgentSettled(); // clean — streak resets
    sendCompletion("subagent", msg("r3"), { triggerTurn: true });
    hub.noteAgentEnd();
    hub.noteAgentSettled(); // failure 1 again, NOT 2
    expect(hub.disabled).toBe(false);
  });

  it("a settle with no tokens neither adds nor resets the streak", () => {
    const { hub, sendCompletion } = setup(true);
    sendCompletion("subagent", msg("r1"), { triggerTurn: true });
    hub.noteAgentEnd();
    hub.noteAgentSettled(); // failure 1
    hub.noteAgentEnd();
    hub.noteAgentSettled(); // no tokens this run — no change
    sendCompletion("subagent", msg("r2"), { triggerTurn: true });
    hub.noteAgentEnd();
    hub.noteAgentSettled(); // failure 2
    expect(hub.disabled).toBe(true);
  });
});

describe("background-completions hub: dispose (§3.3)", () => {
  it("dispose stops broadcast/bookkeeping but keeps forwarding sends; idempotent", () => {
    const { hub, sendCompletion, sent, events } = setup(true);
    sendCompletion("subagent", msg("before"), { triggerTurn: true });
    expect(events).toHaveLength(1);
    hub.dispose();
    hub.dispose(); // idempotent
    expect(hub.pendingTokens()).toBe(0);
    expect(hub.tokenState(1)).toBeUndefined();
    // Old-stack flush during teardown: the message still goes out (delivery
    // semantics preserved), but nothing is minted or broadcast.
    sendCompletion("subagent", msg("after"), { triggerTurn: true });
    expect(sent).toHaveLength(2);
    expect(events).toHaveLength(1);
    expect(hub.pendingTokens()).toBe(0);
    hub.noteMessageStart(start("after"));
    expect(hub.diag.unmatched).toBe(0);
  });

  it("subscribe after dispose is a no-op", () => {
    const hub = createBackgroundCompletionHub({ isStreaming: () => true, now: () => 0 });
    hub.dispose();
    const events: BackgroundCompletion[] = [];
    const unsub = hub.subscribe((event) => events.push(event));
    hub.createSender(() => undefined)("subagent", msg("x"));
    expect(events).toHaveLength(0);
    expect(() => unsub()).not.toThrow();
  });
});
