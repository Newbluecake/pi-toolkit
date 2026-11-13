import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { decodeHubFrame } from "../../../src/web-hub/protocol/messages.js";
import {
  TERMINAL_HTTP_PATHS,
  TerminalResolvedAckSchema,
  terminalIdentityKey,
  terminalResolvedAckMatches,
  type TerminalResolvedAckAuthority,
  type TerminalResourceIdentity,
} from "../../../src/web-hub/protocol/terminal.js";

const identity: TerminalResourceIdentity = {
  agentSessionId: "old-session",
  termId: "term",
  epoch: "old-epoch",
  ownerInstance: "old-owner",
  reservationId: "reservation",
};
function sample() {
  const ready = {
    offerId: "offer",
    localConnectionInstance: "connection",
    sessionId: "current-session",
    epoch: "current-epoch",
    ownerInstance: "current-owner",
    mode: "resource-only" as const,
    hubNonce: "hub-nonce",
    agentChallenge: "agent-challenge",
    expiresAt: 3000,
  };
  const authority: TerminalResolvedAckAuthority = {
    live: true,
    current: {
      localConnectionInstance: ready.localConnectionInstance,
      sessionId: ready.sessionId,
      epoch: ready.epoch,
      ownerInstance: ready.ownerInstance,
    },
    channel: {
      channelId: "resource-channel",
      localConnectionInstance: ready.localConnectionInstance,
      sessionId: ready.sessionId,
      epoch: ready.epoch,
      ownerInstance: ready.ownerInstance,
      mode: ready.mode,
    },
    challenge: { hubBootId: "hub-boot", challengeId: "challenge", linkGen: 2, deadlineAt: 5000 },
    inventoryId: "inventory",
    revision: 3,
    lastJournalRevision: 7,
    receipts: [identity],
    now: 4000,
  };
  const frame = {
    t: "term_req" as const,
    v: 1 as const,
    rid: "rid",
    sessionId: ready.sessionId,
    epoch: ready.epoch,
    ownerInstance: ready.ownerInstance,
    channelId: authority.channel.channelId,
    op: "resolved_ack" as const,
    resolved: {
      hubBootId: "hub-boot",
      challengeId: "challenge",
      linkGen: 2,
      inventoryId: "inventory",
      revision: 3,
      journalRevision: 8,
      identities: [identity],
    },
  };
  return { authority, frame };
}
describe("r4.1 private durable resolved acknowledgement", () => {
  it("accepts the exact resource-only current challenge, not a command or HTTP operation", () => {
    const { frame, authority } = sample();
    expect(decodeHubFrame(frame)).toBe(frame);
    expect(terminalResolvedAckMatches(frame, authority)).toBe(true);
    // Only bound scope survives establishment, not an expired bootstrap proof or private nonces.
    expect(authority.channel).not.toHaveProperty("expiresAt");
    expect(authority.channel).not.toHaveProperty("hubNonce");
    expect(authority.channel).not.toHaveProperty("grant");
    expect(
      terminalResolvedAckMatches(
        { t: "cmd", cmd: { op: "command", name: "webhub", args: JSON.stringify(frame) } },
        authority,
      ),
    ).toBe(false);
    expect(TERMINAL_HTTP_PATHS).not.toHaveProperty("resolved_ack");
  });
  it("keeps the legacy inventory request byte-identical and valid", () => {
    const old = {
      t: "term_req",
      v: 1,
      rid: "inventory-rid",
      sessionId: "session",
      epoch: "epoch",
      ownerInstance: "owner",
      channelId: "channel",
      op: "inventory",
      challenge: { hubBootId: "boot", challengeId: "challenge", linkGen: 1, deadlineAt: 5000 },
    };
    const bytes = JSON.stringify(old) + "\n";
    expect(decodeHubFrame(old)).toBe(old);
    expect(JSON.stringify(decodeHubFrame(old)) + "\n").toBe(bytes);
  });
  it("rejects incomplete/unknown/oversized schema fields and nonpositive durable revision", () => {
    const { frame } = sample(),
      ack = frame.resolved;
    for (const resolved of [
      { ...ack, journalRevision: 0 },
      { ...ack, journalRevision: 1.5 },
      { ...ack, journalRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...ack, committed: true },
      { ...ack, identities: [] },
      { ...ack, identities: Array.from({ length: 33 }, (_, i) => ({ ...identity, termId: `term-${i}` })) },
      { ...ack, identities: [{ ...identity, epoch: 3 }] },
      { ...ack, identities: [{ ...identity, pid: 7 }] },
    ])
      expect(Value.Check(TerminalResolvedAckSchema, resolved)).toBe(false);
    const { journalRevision: _rev, ...missing } = ack;
    expect(Value.Check(TerminalResolvedAckSchema, missing)).toBe(false);
    expect(
      Value.Check(TerminalResolvedAckSchema, {
        ...ack,
        identities: Array.from({ length: 32 }, (_, i) => ({ ...identity, termId: `term-${i}` })),
      }),
    ).toBe(true);
    expect(decodeHubFrame({ ...frame, grant: "forged" })).toBeUndefined();
  });
  it.each(["hubBootId", "challengeId", "linkGen", "inventoryId", "revision", "journalRevision"] as const)(
    "rejects stale/wrong %s without forgetting receipts",
    (field) => {
      const { frame, authority } = sample();
      const wrong =
        typeof frame.resolved[field] === "number"
          ? field === "journalRevision"
            ? 6
            : Number(frame.resolved[field]) + 1
          : "wrong";
      expect(terminalResolvedAckMatches({ ...frame, resolved: { ...frame.resolved, [field]: wrong } }, authority)).toBe(
        false,
      );
    },
  );
  it.each([
    "live",
    "mode",
    "connection",
    "current-session",
    "current-epoch",
    "current-owner",
    "channel",
    "sessionId",
    "epoch",
    "ownerInstance",
    "deadline",
  ])("rejects %s authority mismatch", (fault) => {
    const { frame, authority } = sample();
    let a = authority,
      f = frame;
    if (fault === "live") a = { ...a, live: false };
    if (fault === "mode") a = { ...a, channel: { ...a.channel, mode: "interactive" } };
    if (fault === "connection") a = { ...a, current: { ...a.current, localConnectionInstance: "other" } };
    if (fault === "current-session") a = { ...a, current: { ...a.current, sessionId: "other" } };
    if (fault === "current-epoch") a = { ...a, current: { ...a.current, epoch: "other" } };
    if (fault === "current-owner") a = { ...a, current: { ...a.current, ownerInstance: "other" } };
    if (fault === "deadline") a = { ...a, now: 5000 };
    if (fault === "channel") f = { ...f, channelId: "other" };
    if (fault === "sessionId" || fault === "epoch" || fault === "ownerInstance") f = { ...f, [fault]: "other" };
    expect(terminalResolvedAckMatches(f, a)).toBe(false);
  });
  it("compares the full old resource tuple and rejects unknown/duplicate batches atomically", () => {
    const { frame, authority } = sample();
    for (const field of ["agentSessionId", "termId", "epoch", "ownerInstance", "reservationId"] as const)
      expect(
        terminalResolvedAckMatches(
          { ...frame, resolved: { ...frame.resolved, identities: [{ ...identity, [field]: "wrong" }] } },
          authority,
        ),
        field,
      ).toBe(false);
    expect(
      terminalResolvedAckMatches(
        { ...frame, resolved: { ...frame.resolved, identities: [identity, identity] } },
        authority,
      ),
    ).toBe(false);
    expect(
      terminalResolvedAckMatches(
        { ...frame, resolved: { ...frame.resolved, identities: [identity, { ...identity, termId: "unknown" }] } },
        authority,
      ),
    ).toBe(false);
    expect(terminalResolvedAckMatches(frame, { ...authority, receipts: [identity, identity] })).toBe(false);
  });
  it("forgets only after full acceptance; replay/unknown are no-effect, missing ACK does not expire receipts", () => {
    const { frame, authority } = sample();
    const receipts = new Map([[terminalIdentityKey(identity), identity]]);
    let floor = authority.lastJournalRevision;
    // Minimal A-side receipt fixture; production OS proof/fence/journal remain A/H responsibilities.
    const deliver = (raw: unknown, now = authority.now) => {
      if (
        !terminalResolvedAckMatches(raw, {
          ...authority,
          now,
          lastJournalRevision: floor,
          receipts: [...receipts.values()],
        })
      )
        return false;
      for (const i of raw.resolved.identities) receipts.delete(terminalIdentityKey(i));
      floor = raw.resolved.journalRevision;
      return true;
    };
    expect(
      deliver({
        ...frame,
        resolved: { ...frame.resolved, identities: [identity, { ...identity, termId: "unknown" }] },
      }),
    ).toBe(false);
    expect(receipts.size).toBe(1);
    expect(floor).toBe(7);
    expect(deliver(frame, 5000)).toBe(false);
    expect(receipts.size).toBe(1); // expired ACK != discard permission
    expect(deliver(frame)).toBe(true);
    expect(receipts.size).toBe(0);
    expect(floor).toBe(8);
    expect(deliver(frame)).toBe(false);
    expect(receipts.size).toBe(0);
    expect(floor).toBe(8);
  });
});
