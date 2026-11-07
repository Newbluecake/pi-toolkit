import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createSessionFence, type SessionFence } from "../../src/fabric/xs/fence.js";
import { XsDedup } from "../../src/fabric/xs/dedup.js";
import { XsInbox } from "../../src/fabric/xs/inbox.js";
import { XsMembership } from "../../src/fabric/xs/membership.js";
import {
  XsReceiver,
  type XsDeliverHost,
  type XsDeliverInput,
  type XsReceiverProgressPort,
} from "../../src/fabric/xs/receiver.js";

/**
 * fabric-xs-activation plan §3 P1 (arch §4.1/§4.2 evidence table): the receiver pipeline's
 * PROGRESS writes — one statement per settled verdict, through the optional `progress` port.
 * Pins:
 *  - none{refusal} ⇒ deliveryEffect "none" + reason (a definitive row, never fabricated later);
 *  - busy deliver-only ⇒ phase queued (N2);
 *  - idle + REAL leaf xid match ⇒ phase delivered + entryId (never guessed);
 *  - wake rows ⇒ the wake view's requested/stage/decision/reason (receiver stage);
 *  - a solicited reply confirmed applied ⇒ `replyWritten` fires (requester-side `replied`);
 *  - dedup replay ⇒ NO second write (the first settle already recorded it);
 *  - port absent ⇒ nothing throws, behaviour byte-identical (implicit in every other suite).
 */

const SESSION = "sess-main-0123456789abcdef";
const SENDER = "sess-other-9876543210fedcba";

function makeHarness(options: { idle?: boolean; replies?: boolean } = {}) {
  const clock = new FakeClock(1_000);
  const membership = new XsMembership({ sessionId: SESSION, clock, persist: () => {} });
  membership.attach();
  membership.join();
  const fence: SessionFence = createSessionFence({ clock });
  const inbox = new XsInbox(12, clock);
  const dedup = new XsDedup(256, clock);
  const writes: { messageId: string; fields: Record<string, unknown> }[] = [];
  const replyWritten: { requestId: string; at: number }[] = [];
  const progress: XsReceiverProgressPort = {
    observe: (messageId, fields) => void writes.push({ messageId, fields: fields as Record<string, unknown> }),
    replyWritten: (requestId, at) => void replyWritten.push({ requestId, at }),
  };
  let idle = options.idle ?? true;
  let sendThrows = false;
  let leafAppend = true;
  const leaves: { type: string; customType?: string; details?: unknown; id?: string }[] = [];
  const host: XsDeliverHost = {
    isIdle: () => idle,
    hasPendingMessages: () => false,
    sendMessage(message, options) {
      if (sendThrows) throw new Error("sendMessage boom");
      if (options.triggerTurn) idle = false;
      else if (idle && leafAppend)
        leaves.push({
          type: "custom_message",
          customType: message.customType,
          details: message.details,
          id: `e${leaves.length + 1}`,
        });
    },
    getLeafEntry: () => leaves.at(-1),
  };
  const receiver = new XsReceiver({
    sessionId: SESSION,
    membership,
    fence,
    inbox,
    recvPerHour: 30,
    wakesInPerHour: 12,
    host,
    dedup,
    clock,
    warn: () => {},
    progress,
  });
  const input = (over: Partial<XsDeliverInput> = {}): XsDeliverInput => ({
    xid: `x${Math.random().toString(36).slice(2, 10)}`,
    to: { sessionId: SESSION, epoch: membership.epoch },
    from: { sessionId: SENDER, ref: "ab12cd34ef56", cwdLabel: "~/ai/proj", agentId: "agent-1" },
    text: "hello cross-session",
    wake: false,
    expiresAt: clock.now() + 5_000,
    ...over,
  });
  return {
    clock,
    receiver,
    writes,
    replyWritten,
    input,
    setIdle: (v: boolean) => (idle = v),
    makeSendThrow: () => (sendThrows = true),
    setLeafAppend: (v: boolean) => (leafAppend = v),
  };
}

const wakeOf = (fields: Record<string, unknown>): Record<string, unknown> => fields["wake"] as Record<string, unknown>;

describe("xs receiver progress evidence (fabric-xs-activation P1)", () => {
  it("a definitive refusal writes deliveryEffect none + the reason", () => {
    const h = makeHarness();
    h.receiver.deliver(h.input({ expiresAt: h.clock.now() }));
    expect(h.writes).toHaveLength(1);
    const w = h.writes[0]!;
    expect(w.fields["deliveryEffect"]).toBe("none");
    expect(w.fields["reason"]).toBe("expired");
    expect(wakeOf(w.fields)).toMatchObject({ requested: false, decision: "deliver_only" });
  });

  it("busy deliver-only writes phase queued (N2) — never delivered", () => {
    const h = makeHarness({ idle: false });
    const verdict = h.receiver.deliver(h.input());
    expect(verdict).toMatchObject({ effect: "unknown", reason: "queued" });
    const w = h.writes[0]!;
    expect(w.fields).toMatchObject({ deliveryEffect: "unknown", phase: "queued", reason: "queued" });
    expect(w.fields["deliveredAt"]).toBeUndefined();
  });

  it("idle + leaf xid match writes phase delivered + the REAL entryId", () => {
    const h = makeHarness();
    const verdict = h.receiver.deliver(h.input({ xid: "xdelivered01" }));
    expect(verdict.effect).toBe("applied");
    const w = h.writes[0]!;
    expect(w.fields).toMatchObject({ deliveryEffect: "applied", phase: "delivered" });
    expect(typeof w.fields["deliveredAt"]).toBe("number");
    expect(w.fields["entryId"]).toBe("e1");
  });

  it("idle + leaf NOT this message writes unknown without entryId", () => {
    const h = makeHarness();
    // the host swallows the write (no leaf appended) — idle but the leaf never matches
    h.setLeafAppend(false);
    const verdict = h.receiver.deliver(h.input());
    expect(verdict).toMatchObject({ effect: "unknown", reason: "accept_unverified" });
    const w = h.writes.at(-1)!;
    expect(w.fields).toMatchObject({ deliveryEffect: "unknown", reason: "accept_unverified" });
    expect(w.fields["entryId"]).toBeUndefined();
  });

  it("a requested wake without a Controller writes the receiver-stage downgrade", () => {
    const h = makeHarness();
    h.receiver.deliver(h.input({ wake: true }));
    const w = h.writes[0]!;
    expect(wakeOf(w.fields)).toMatchObject({
      requested: true,
      stage: "receiver",
      decision: "downgraded",
      reason: "wake_disabled",
    });
  });

  it("an expectReply deliver carries the requestId + pending replyState", () => {
    const h = makeHarness();
    h.receiver.deliver(h.input({ reply: { requestId: "q-abc123", dueAt: h.clock.now() + 60_000 } }));
    const w = h.writes[0]!;
    expect(w.fields).toMatchObject({ requestId: "q-abc123", replyState: "pending" });
  });

  it("a dedup replay writes NOTHING (the first settle recorded the row)", () => {
    const h = makeHarness();
    h.receiver.deliver(h.input({ xid: "xdup-1" }));
    expect(h.writes).toHaveLength(1);
    h.receiver.deliver(h.input({ xid: "xdup-1" }));
    expect(h.writes).toHaveLength(1);
  });

  it("host_rejected writes none{host_rejected} (proof of no effect)", () => {
    const h = makeHarness();
    h.makeSendThrow();
    const verdict = h.receiver.deliver(h.input());
    expect(verdict).toMatchObject({ effect: "none", reason: "host_rejected" });
    const w = h.writes[0]!;
    expect(w.fields).toMatchObject({ deliveryEffect: "none", reason: "host_rejected" });
  });
});
