/** #39 P1 op-cap: private capability lifecycle, owner/turn binding, audit, HumanTurnTracker. */
import { describe, expect, it } from "vitest";
import {
  createHumanTurnTracker,
  createMemoryOpCapRegistry,
  HUMAN_TURN_MAX_DIALOGS,
} from "../../../src/memory/scopes/op-cap.js";
import { scopedOpDigest, bodyTextDigest } from "../../../src/memory/scopes/limits.js";
import type { FrozenScopedOp, MemoryOwner } from "../../../src/memory/scopes/types.js";

const owner = (epoch = 1, branch = 1): MemoryOwner => ({
  incarnation: {},
  sid: "sess-1",
  sessionFile: "/s.json",
  sessionEpoch: epoch,
  branchGen: branch,
});

const operation = { storageScope: "session", op: "create", text: "fact", authority: "user" } as FrozenScopedOp;
const opDigest = scopedOpDigest(operation);
const textDigest = bodyTextDigest("fact");

function minted(
  registry: ReturnType<typeof createMemoryOpCapRegistry>,
  tracker: ReturnType<typeof createHumanTurnTracker>,
  o: MemoryOwner,
) {
  const turn = tracker.noteInteractive(o);
  return registry.mint({
    operation,
    binding: { owner: o, humanTurn: turn, toolCallId: "tc1", nonce: "a".repeat(32), opDigest, textDigest },
    channel: "tui",
    project: "proj123456",
  });
}

describe("capability lifecycle", () => {
  it("mint → reserve → check → consume (one-shot); consume twice fails", () => {
    const tracker = createHumanTurnTracker();
    const registry = createMemoryOpCapRegistry(() => tracker.current());
    const o = owner();
    const cap = minted(registry, tracker, o);
    expect(registry.stateOf(cap)).toBe("minted");
    expect(registry.reserve(cap, o)).toBeDefined();
    expect(registry.stateOf(cap)).toBe("reserved");
    expect(registry.check(cap, o)).toBeDefined();
    expect(registry.consume(cap)).toBe(true);
    expect(registry.consume(cap)).toBe(false);
    expect(registry.stateOf(cap)).toBe("unknown"); // consumed records are gone
    expect(registry.check(cap, o)).toBeUndefined();
  });

  it("reserve/check verify the owner by identity: sid/epoch/branch/incarnation mismatch refuse", () => {
    const tracker = createHumanTurnTracker();
    const registry = createMemoryOpCapRegistry(() => tracker.current());
    const o = owner();
    const cap = minted(registry, tracker, o);
    expect(registry.reserve(cap, owner(2, 1))).toBeUndefined(); // different incarnation object
    const sameIncarnation = { ...o };
    expect(registry.reserve(cap, sameIncarnation)).toBeDefined(); // same reference + fields ⇒ same owner
    const epochBump = { ...o, incarnation: o.incarnation, sessionEpoch: 2 };
    expect(registry.reserve(cap, epochBump)).toBeUndefined();
    const branchBump = { ...o, incarnation: o.incarnation, branchGen: 2 };
    expect(registry.reserve(cap, branchBump)).toBeUndefined();
    expect(registry.reserve(cap, o)).toBeDefined(); // the real owner still can
  });

  it("the human turn must still be current at reserve/check", () => {
    const tracker = createHumanTurnTracker();
    const registry = createMemoryOpCapRegistry(() => tracker.current());
    const o = owner();
    const cap = minted(registry, tracker, o);
    expect(registry.stateOf(cap)).toBe("minted");
    tracker.noteNonHuman(); // unprovable input: turn gone
    expect(registry.reserve(cap, o)).toBeUndefined();
    const cap2 = minted(registry, tracker, o); // minted under a NEW turn
    expect(registry.reserve(cap2, o)).toBeDefined(); // its own binding turn is current
  });

  it("revoke: single cap and revoke-all; revoked caps never reserve", () => {
    const tracker = createHumanTurnTracker();
    const registry = createMemoryOpCapRegistry(() => tracker.current());
    const o = owner();
    const a = minted(registry, tracker, o);
    const b = minted(registry, tracker, o);
    registry.revoke(a);
    expect(registry.stateOf(a)).toBe("revoked");
    expect(registry.reserve(a, o)).toBeUndefined();
    expect(registry.stateOf(b)).toBe("minted");
    registry.revoke();
    expect(registry.stateOf(b)).toBe("revoked");
    expect(registry.reserve(b, o)).toBeUndefined();
  });

  it("audit lines derive ONLY from cap fields", () => {
    const tracker = createHumanTurnTracker();
    const registry = createMemoryOpCapRegistry(() => tracker.current());
    const o = owner();
    const turn = tracker.noteInteractive(o);
    const cap = registry.mint({
      operation,
      binding: { owner: o, humanTurn: turn, toolCallId: "tc9", nonce: "b".repeat(32), opDigest, textDigest },
      channel: "web",
      project: "projabcdef1234",
      who: "9a8b7c6d",
    });
    const audit = registry.auditOf(cap, "2026-11-07T00:00:00.000Z");
    expect(audit).toMatchObject({
      at: "2026-11-07T00:00:00.000Z",
      op: "create",
      via: "dialog",
      channel: "web",
      who: "9a8b7c6d",
      by: "agent",
      project: "projabcdef1234",
      sid8: "sess-1",
    });
    expect(audit?.turn).toBe(turn.id.slice(0, 8));
    expect(audit?.cap).toMatch(/^[a-f0-9]{8}$/);
    expect(JSON.stringify(audit)).not.toContain("fact"); // no body text in audit
    // a foreign object (model-forged) has no audit and no state
    expect(registry.auditOf({} as never, "x")).toBeUndefined();
    expect(registry.stateOf({} as never)).toBe("unknown");
  });

  it("mint validates binding digests/nonce and channel", () => {
    const tracker = createHumanTurnTracker();
    const registry = createMemoryOpCapRegistry(() => tracker.current());
    const o = owner();
    const turn = tracker.noteInteractive(o);
    const good = { owner: o, humanTurn: turn, toolCallId: "tc", nonce: "c".repeat(32), opDigest, textDigest };
    expect(() =>
      registry.mint({ operation, binding: { ...good, opDigest: "nothex" }, channel: "tui", project: "p" }),
    ).toThrow();
    expect(() =>
      registry.mint({ operation, binding: { ...good, nonce: "short" }, channel: "tui", project: "p" }),
    ).toThrow();
    expect(() => registry.mint({ operation, binding: good, channel: "sms" as never, project: "p" })).toThrow();
  });
});

describe("HumanTurnTracker", () => {
  it("interactive input opens a new turn and revokes capabilities via the hook", () => {
    let revoked = 0;
    const tracker = createHumanTurnTracker(() => {
      revoked++;
    });
    const o = owner();
    const first = tracker.noteInteractive(o);
    expect(tracker.current()?.id).toBe(first.id);
    expect(tracker.current()?.channel).toBe("tui");
    const second = tracker.noteInteractive(o);
    expect(second.id).not.toBe(first.id);
    expect(revoked).toBe(2); // each new turn invalidated the previous capabilities
  });

  it("non-human sources and lifecycle events clear the turn; web turns record channel", () => {
    const tracker = createHumanTurnTracker();
    const o = owner();
    tracker.noteInteractive(o);
    tracker.noteNonHuman();
    expect(tracker.current()).toBeUndefined();
    tracker.noteWebTurn(o);
    expect(tracker.current()?.channel).toBe("web");
    tracker.invalidate("agent_end");
    expect(tracker.current()).toBeUndefined();
  });

  it("rejected-flag and dialog budget are per-turn", () => {
    expect(HUMAN_TURN_MAX_DIALOGS).toBe(3);
    const tracker = createHumanTurnTracker();
    const o = owner();
    tracker.noteInteractive(o);
    tracker.noteDialog();
    tracker.noteDialog();
    expect(tracker.dialogsThisTurn()).toBe(2);
    tracker.markRejected();
    expect(tracker.rejected()).toBe(true);
    tracker.noteInteractive(o); // new turn resets both
    expect(tracker.rejected()).toBe(false);
    expect(tracker.dialogsThisTurn()).toBe(0);
  });
});
