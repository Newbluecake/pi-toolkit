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
  // Each row falsifies one predicate while keeping the other guards satisfied.
  // Mirror the invalid connection id on both sides so equality still holds.
  const cases: Array<[string, Array<[string, unknown]>]> = [
    ["frame schema", [["frame.extra", true]]],
    ["operation tag (schema + tag boundary)", [["frame.op", "inventory"]]],
    ["live", [["authority.live", false]]],
    ["channel.mode", [["authority.channel.mode", "interactive"]]],
    [
      "connection id schema",
      [
        ["authority.channel.localConnectionInstance", ""],
        ["authority.current.localConnectionInstance", ""],
      ],
    ],
    ...["localConnectionInstance", "sessionId", "epoch", "ownerInstance"].map(
      (field): [string, Array<[string, unknown]>] => [`current.${field}`, [[`authority.current.${field}`, "other"]]],
    ),
    ["challenge schema", [["authority.challenge.extra", true]]],
    ...["channelId", "sessionId", "epoch", "ownerInstance"].map((field): [string, Array<[string, unknown]>] => [
      `frame.${field}`,
      [[`frame.${field}`, "other"]],
    ]),
    ["now safe integer", [["authority.now", 0.5]]],
    ["now nonnegative", [["authority.now", -1]]],
    ["deadline equality", [["authority.now", 5000]]],
    ...["hubBootId", "challengeId", "inventoryId"].map((field): [string, Array<[string, unknown]>] => [
      `resolved.${field}`,
      [[`frame.resolved.${field}`, "other"]],
    ]),
    ["resolved.linkGen", [["frame.resolved.linkGen", 3]]],
    ["resolved.revision", [["frame.resolved.revision", 4]]],
    ["journal floor safe integer", [["authority.lastJournalRevision", 7.5]]],
    ["journal floor nonnegative", [["authority.lastJournalRevision", -1]]],
    ["journal rollback", [["authority.lastJournalRevision", 9]]],
    [
      "receipt cap",
      [
        [
          "authority.receipts",
          [identity, ...Array.from({ length: 32 }, (_, i) => ({ ...identity, termId: `other-${i}` }))],
        ],
      ],
    ],
    ["receipt schema", [["authority.receipts", [{ ...identity, extra: true }]]]],
    ["receipt duplicate", [["authority.receipts", [identity, identity]]]],
    ...["agentSessionId", "termId", "epoch", "ownerInstance", "reservationId"].map(
      (field): [string, Array<[string, unknown]>] => [
        `identity.${field}`,
        [["frame.resolved.identities", [{ ...identity, [field]: "other" }]]],
      ],
    ),
    ["identity duplicate", [["frame.resolved.identities", [identity, identity]]]],
    ["known then unknown", [["frame.resolved.identities", [identity, { ...identity, termId: "other" }]]]],
    ["unknown then known", [["frame.resolved.identities", [{ ...identity, termId: "other" }, identity]]]],
  ];
  it.each(cases)("single binding: %s", (_condition, changes) => {
    const input = sample();
    expect(terminalResolvedAckMatches(input.frame, input.authority)).toBe(true);
    for (const [path, value] of changes) {
      const keys = path.split(".");
      let object = input as unknown as Record<string, unknown>;
      for (const key of keys.slice(0, -1)) object = object[key] as Record<string, unknown>;
      object[keys.at(-1)!] = value;
    }
    expect(terminalResolvedAckMatches(input.frame, input.authority)).toBe(false);
  });
  it("accepts the receipt cap boundary and an equal durable journal floor", () => {
    const { frame, authority } = sample();
    expect(
      terminalResolvedAckMatches(frame, {
        ...authority,
        lastJournalRevision: 8,
        receipts: [identity, ...Array.from({ length: 31 }, (_, i) => ({ ...identity, termId: `other-${i}` }))],
      }),
    ).toBe(true);
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
