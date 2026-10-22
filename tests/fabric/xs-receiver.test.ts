import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createSessionFence, type SessionFence } from "../../src/fabric/xs/fence.js";
import { XsReplyLedger, createXsReplyInboxPort } from "../../src/fabric/xs/reply-ledger.js";
import type { RootWakeDispatchResult, RootWakeRequest } from "../../src/fabric/root-wake.js";
import { XsDedup } from "../../src/fabric/xs/dedup.js";
import { XsInbox } from "../../src/fabric/xs/inbox.js";
import { XsMembership } from "../../src/fabric/xs/membership.js";
import { XsReceiver, type XsDeliverHost, type XsDeliverInput } from "../../src/fabric/xs/receiver.js";

/**
 * fabric phase-2 X4 (phase2-plan §8.4 pipeline + §6.3 evidence table + §11.2 X4 行 + r3
 * M2/N2): the receiver pipeline. Pure fakes — the host simulates exactly the pi 1.3 facts the
 * plan relies on (Fpi1 sync throw, Fpi2 !isIdle after triggerTurn:true, Fpi7 sync append vs
 * in-memory queue while streaming); the fence/membership/dedup/inbox are the REAL modules.
 *
 * Evidence-table rows pinned here:
 *   - sync send throw ⇒ none{host_rejected} (proof of no effect, §6.3 row 1)
 *   - deliver-only idle + leaf is this message ⇒ applied (§6.3 row 2)
 *   - deliver-only idle + leaf is NOT this message ⇒ unknown{accept_unverified} (§6.3 row 3)
 *   - deliver-only streaming ⇒ unknown{queued} (§6.3 row 4 / N2)
 *   - Controller dispatch deferred ⇒ unknown{start_deferred} + woke (§6.3 row 6)
 *   - M2: pipeline exception before dispatch ⇒ none{receiver_error}; after ⇒ unknown.
 */

const SESSION = "sess-main-0123456789abcdef";
const SENDER = "sess-other-9876543210fedcba";

interface HarnessOptions {
  replies?: boolean;
  recvPerHour?: number;
  wakeController?: boolean;
  idle?: boolean;
  allowFrom?: readonly string[];
  allowFromDenyAll?: boolean;
}

interface FakeHostCtl {
  sent: { message: { customType: string; content: string; details?: unknown }; options: { triggerTurn: boolean } }[];
  setIdle(v: boolean): void;
  makeSendThrow(): void;
  makeIsIdleThrow(): void;
  pushLeaf(entry: { type: string; customType?: string; details?: unknown }): void;
  aborts: number;
}

function makeHarness(options: HarnessOptions = {}) {
  const clock = new FakeClock(1_000);
  const persisted: unknown[] = [];
  const membership = new XsMembership({
    sessionId: SESSION,
    allowFrom: options.allowFrom ?? [],
    ...(options.allowFromDenyAll === undefined ? {} : { allowFromDenyAll: options.allowFromDenyAll }),
    clock,
    persist: (data) => persisted.push(data),
  });
  membership.attach();
  membership.join();
  const fence: SessionFence = createSessionFence({ clock });
  const inbox = new XsInbox(12, clock);
  const dedup = new XsDedup(256, clock);
  const replyInbox = new XsInbox(2, clock);
  const replyLedger = new XsReplyLedger({ clock });
  replyLedger.bindSession({ sessionId: SESSION, inbox: createXsReplyInboxPort(replyInbox) });

  const ctl: FakeHostCtl = {
    sent: [],
    aborts: 0,
    setIdle(v: boolean) {
      idle = v;
    },
    makeSendThrow() {
      sendThrows = true;
    },
    makeIsIdleThrow() {
      isIdleThrows = true;
    },
    pushLeaf(entry) {
      leaves.push(entry);
    },
  };
  let idle = options.idle ?? true;
  let sendThrows = false;
  let isIdleThrows = false;
  const leaves: { type: string; customType?: string; details?: unknown }[] = [];
  const host: XsDeliverHost = {
    isIdle: () => {
      if (isIdleThrows) throw new Error("isIdle boom");
      return idle;
    },
    hasPendingMessages: () => false,
    sendMessage(message, options) {
      if (sendThrows) throw new Error("sendMessage boom");
      ctl.sent.push({ message, options });
      if (options.triggerTurn)
        idle = false; // Fpi2: _isAgentRunActive=true synchronously
      else if (idle) leaves.push({ type: "custom_message", customType: message.customType, details: message.details });
    },
    getLeafEntry: () => leaves.at(-1),
  };

  const receiver = new XsReceiver({
    sessionId: SESSION,
    membership,
    fence,
    inbox,
    ...(options.replies ? { replyLedger } : {}),
    recvPerHour: options.recvPerHour ?? 30,
    wakesInPerHour: 12,
    host,
    dedup,
    clock,
    warn: () => {},
  });

  function input(over: Partial<XsDeliverInput> = {}): XsDeliverInput {
    return {
      xid: `xid-${Math.random().toString(36).slice(2, 10)}`,
      to: { sessionId: SESSION, epoch: membership.epoch },
      from: { sessionId: SENDER, ref: "ab12cd34ef56", cwdLabel: "~/ai/proj", agentId: "agent-1" },
      text: "hello cross-session",
      wake: false,
      expiresAt: clock.now() + 5_000,
      ...over,
    };
  }

  return { clock, membership, fence, inbox, replyInbox, replyLedger, dedup, host, receiver, ctl, persisted, input };
}

describe("xs-receiver: pipeline stage rejections (§8.4)", () => {
  it("stage 1: expired ⇒ none{expired}", () => {
    const h = makeHarness();
    const verdict = h.receiver.deliver(h.input({ expiresAt: h.clock.now() }));
    expect(verdict).toEqual({ effect: "none", reason: "expired", woke: false });
    expect(h.ctl.sent).toEqual([]);
  });

  it("stage 2: a duplicate xid replays the FIRST ack verbatim — nothing is re-dispatched", () => {
    const h = makeHarness();
    const first = h.receiver.deliver(h.input({ xid: "dup-1" }));
    expect(first.effect).toBe("applied");
    const second = h.receiver.deliver(h.input({ xid: "dup-1" }));
    expect(second).toEqual(first);
    expect(h.ctl.sent).toHaveLength(1);
  });

  it("stage 2: dedup table full ⇒ none{dedup_full} (refuse, never evict)", () => {
    const clock = new FakeClock(1_000);
    const membership = new XsMembership({ sessionId: SESSION, clock, persist: () => {} });
    membership.attach();
    membership.join();
    const dedup = new XsDedup(1, clock);
    dedup.admit("occupied", clock.now() + 60_000); // someone else's live entry
    const receiver = new XsReceiver({
      sessionId: SESSION,
      membership,
      fence: createSessionFence({ clock }),
      inbox: new XsInbox(12, clock),
      recvPerHour: 30,
      wakesInPerHour: 12,
      host: {
        isIdle: () => true,
        hasPendingMessages: () => false,
        sendMessage: () => {},
        getLeafEntry: () => undefined,
      },
      dedup,
      clock,
      warn: () => {},
    });
    const verdict = receiver.deliver(h_input(membership, clock));
    expect(verdict).toEqual({ effect: "none", reason: "dedup_full", woke: false });
  });

  it("stage 3: not joined / receive off / allowFrom / blocklist all collapse to none{rejected}", () => {
    const h = makeHarness();
    h.membership.leave();
    expect(h.receiver.deliver(h.input())).toEqual({ effect: "none", reason: "rejected", woke: false });
    h.membership.join();
    h.membership.setReceive("off");
    expect(h.receiver.deliver(h.input())).toEqual({ effect: "none", reason: "rejected", woke: false });
    h.membership.setReceive("wake");

    const g = makeHarness({ allowFrom: ["sess-allowed-0001"] });
    expect(g.receiver.deliver(g.input())).toEqual({ effect: "none", reason: "rejected", woke: false });

    const k = makeHarness({ allowFromDenyAll: true });
    expect(k.receiver.deliver(k.input())).toEqual({ effect: "none", reason: "rejected", woke: false });

    const b = makeHarness();
    b.membership.block(SENDER);
    expect(b.receiver.deliver(b.input())).toEqual({ effect: "none", reason: "rejected", woke: false });
  });

  it("stage 4: to.sessionId / to.epoch mismatch ⇒ none{session_changed}", () => {
    const h = makeHarness();
    expect(
      h.receiver.deliver(h.input({ to: { sessionId: "sess-somewhere-else", epoch: h.membership.epoch } })),
    ).toEqual({
      effect: "none",
      reason: "session_changed",
      woke: false,
    });
    expect(h.receiver.deliver(h.input({ to: { sessionId: SESSION, epoch: h.membership.epoch + 7 } }))).toEqual({
      effect: "none",
      reason: "session_changed",
      woke: false,
    });
    // a leave mid-flight bumps the epoch ⇒ the old-epoch frame is refused locally (§8.1)
    const staleEpoch = h.membership.epoch;
    h.membership.leave();
    h.membership.join();
    expect(h.membership.epoch).toBeGreaterThan(staleEpoch);
    expect(h.receiver.deliver(h.input({ to: { sessionId: SESSION, epoch: staleEpoch } }))).toEqual({
      effect: "none",
      reason: "session_changed",
      woke: false,
    });
    // the CURRENT epoch still works
    expect(h.receiver.deliver(h.input()).effect).toBe("applied");
  });

  it("stage 5: each fence window ⇒ none{fenced:<name>}; goal only downgrades a wake", () => {
    for (const opener of ["session_before_compact", "session_before_tree", "session_before_switch"] as const) {
      const h = makeHarness();
      h.fence.onEvent({ type: opener });
      expect(h.receiver.deliver(h.input())).toEqual({
        effect: "none",
        reason: `fenced:${fenceNameOf(opener)}`,
        woke: false,
      });
    }
    const h = makeHarness();
    const goalFence = createSessionFence({ clock: h.clock, ports: { goal: () => true } });
    // goal active: plain delivery passes, wake degrades — pinned in the truth-table suite; here the reject-only half:
    const receiver2 = new XsReceiver({
      sessionId: SESSION,
      membership: h.membership,
      fence: goalFence,
      inbox: h.inbox,
      recvPerHour: 30,
      wakesInPerHour: 12,
      host: h.host,
      dedup: h.dedup,
      clock: h.clock,
      warn: () => {},
    });
    expect(receiver2.deliver(h.input()).effect).toBe("applied"); // delivery itself never blocked by goal
  });

  it("stage 6: recvPerHour exhausted ⇒ none{inbound_rate}; inbox full ⇒ none{inbox_full}", () => {
    const h = makeHarness({ recvPerHour: 1 });
    expect(h.receiver.deliver(h.input()).effect).toBe("applied");
    expect(h.receiver.deliver(h.input())).toEqual({ effect: "none", reason: "inbound_rate", woke: false });

    const k = makeHarness();
    k.inbox.accept("held-1", "appended");
    k.inbox.accept("held-2", "appended");
    // cap 12 default — fill the rest
    for (let i = 3; i <= 12; i++) k.inbox.accept(`held-${i}`, "appended");
    expect(k.inbox.isFull()).toBe(true);
    expect(k.receiver.deliver(k.input())).toEqual({ effect: "none", reason: "inbox_full", woke: false });
    expect(k.ctl.sent).toEqual([]);
  });
});

describe("xs-receiver: evidence table (§6.3)", () => {
  it("deliver-only idle + leaf is this message ⇒ applied (sync evidence, Fpi7)", () => {
    const h = makeHarness();
    const verdict = h.receiver.deliver(h.input());
    expect(verdict).toEqual({ effect: "applied", woke: false });
    expect(h.ctl.sent).toHaveLength(1);
    expect(h.ctl.sent[0]!.options).toEqual({ triggerTurn: false });
    expect(h.ctl.sent[0]!.message.customType).toBe("subagent:xs");
    expect(h.inbox.snapshot()[0]!.mode).toBe("appended");
  });

  it("deliver-only streaming ⇒ unknown{queued} + inbox mode queued (N2/Fpi7)", () => {
    const h = makeHarness({ idle: false });
    const verdict = h.receiver.deliver(h.input());
    expect(verdict).toEqual({ effect: "unknown", reason: "queued", woke: false });
    expect(h.ctl.sent).toHaveLength(1); // delivered into pi's in-memory queue
    expect(h.inbox.snapshot()[0]!.mode).toBe("queued");
  });

  it("deliver-only idle but leaf is NOT this message ⇒ unknown{accept_unverified}", () => {
    const h = makeHarness();
    // The host accepts the send but its observable leaf belongs to someone else — the sync
    // evidence for THIS message is missing (§6.3 row 3: 宿主吞掉了异步错误等).
    const receiver = new XsReceiver({
      sessionId: SESSION,
      membership: h.membership,
      fence: h.fence,
      inbox: h.inbox,
      recvPerHour: 30,
      wakesInPerHour: 12,
      host: {
        isIdle: () => true,
        hasPendingMessages: () => false,
        sendMessage: () => {}, // succeeds but writes nothing observable
        getLeafEntry: () => ({ type: "custom_message", customType: "someone-else", details: {} }),
      },
      dedup: h.dedup,
      clock: h.clock,
      warn: () => {},
    });
    const verdict = receiver.deliver(h.input());
    expect(verdict).toEqual({ effect: "unknown", reason: "accept_unverified", woke: false });
    expect(h.inbox.snapshot()[0]!.mode).toBe("appended"); // conservative hold
  });

  it("synchronous sendMessage throw ⇒ none{host_rejected} — proof of no effect (§6.3 row 1 / Fpi1)", () => {
    const h = makeHarness();
    h.ctl.makeSendThrow();
    expect(h.receiver.deliver(h.input())).toEqual({ effect: "none", reason: "host_rejected", woke: false });
  });

  it("dispatch-point fence re-open / gen move ⇒ unknown{accept_unverified} (T1, applied 不可记)", () => {
    const h = makeHarness();
    const clock = h.clock;
    // A port that activates only AFTER beginDispatch (simulating the window opening mid-block):
    let armSwitch = false;
    const fence = createSessionFence({ clock, ports: { webExec: () => armSwitch } });
    const receiver = new XsReceiver({
      sessionId: SESSION,
      membership: h.membership,
      fence,
      inbox: h.inbox,
      recvPerHour: 30,
      wakesInPerHour: 12,
      host: h.host,
      dedup: h.dedup,
      clock,
      warn: () => {},
    });
    const orig = h.host.sendMessage.bind(h.host);
    (h.host as { sendMessage: typeof orig }).sendMessage = (m, o) => {
      armSwitch = true; // the window opens between beginDispatch and verifyDispatch
      orig(m, o);
    };
    const verdict = receiver.deliver(h.input());
    expect(verdict).toEqual({ effect: "unknown", reason: "accept_unverified", woke: false });
    expect(h.ctl.sent).toHaveLength(1); // the write physically happened (post-dispatch ambiguity, M2)
  });
});

describe("xs-receiver: r3 M2 — receiver_error split", () => {
  it("an exception BEFORE dispatch ⇒ none{receiver_error}, nothing sent", () => {
    const h = makeHarness();
    const poisoned = new Proxy(h.membership, {
      get(target, prop, recv) {
        if (prop === "senderAllowed")
          return () => {
            throw new Error("boom");
          };
        return Reflect.get(target, prop, recv);
      },
    });
    const receiver = new XsReceiver({
      sessionId: SESSION,
      membership: poisoned,
      fence: h.fence,
      inbox: h.inbox,
      recvPerHour: 30,
      wakesInPerHour: 12,
      host: h.host,
      dedup: h.dedup,
      clock: h.clock,
      warn: () => {},
    });
    expect(receiver.deliver(h.input({ xid: "m2-pre" }))).toEqual({
      effect: "none",
      reason: "receiver_error",
      woke: false,
    });
    expect(h.ctl.sent).toEqual([]);
  });

  it("an exception AFTER dispatch ⇒ unknown{receiver_error} (the write may have landed)", () => {
    const h = makeHarness();
    const poisonInbox = new Proxy(h.inbox, {
      get(target, prop, recv) {
        if (prop === "accept")
          return () => {
            throw new Error("boom");
          };
        return Reflect.get(target, prop, recv);
      },
    });
    const receiver = new XsReceiver({
      sessionId: SESSION,
      membership: h.membership,
      fence: h.fence,
      inbox: poisonInbox,
      recvPerHour: 30,
      wakesInPerHour: 12,
      host: h.host,
      dedup: h.dedup,
      clock: h.clock,
      warn: () => {},
    });
    expect(receiver.deliver(h.input({ xid: "m2-post" }))).toEqual({
      effect: "unknown",
      reason: "receiver_error",
      woke: false,
    });
    expect(h.ctl.sent).toHaveLength(1);
  });

  it("an error verdict is dedup-settled — the duplicate must not re-dispatch", () => {
    const h = makeHarness();
    const poisonInbox = new Proxy(h.inbox, {
      get(target, prop, recv) {
        if (prop === "accept")
          return () => {
            throw new Error("boom");
          };
        return Reflect.get(target, prop, recv);
      },
    });
    const receiver = new XsReceiver({
      sessionId: SESSION,
      membership: h.membership,
      fence: h.fence,
      inbox: poisonInbox,
      recvPerHour: 30,
      wakesInPerHour: 12,
      host: h.host,
      dedup: h.dedup,
      clock: h.clock,
      warn: () => {},
    });
    receiver.deliver(h.input({ xid: "m2-settle" }));
    // swap in the healthy inbox and try the SAME xid again
    const retry = new XsReceiver({
      sessionId: SESSION,
      membership: h.membership,
      fence: h.fence,
      inbox: h.inbox,
      recvPerHour: 30,
      wakesInPerHour: 12,
      host: h.host,
      dedup: h.dedup,
      clock: h.clock,
      warn: () => {},
    });
    expect(retry.deliver(h.input({ xid: "m2-settle" }))).toEqual({
      effect: "unknown",
      reason: "receiver_error",
      woke: false,
    });
    expect(h.ctl.sent).toHaveLength(1); // still exactly one send
  });
});

describe("xs-receiver: content hygiene (§8.8/A6)", () => {
  it("delivered content is nonce-fenced, declares untrusted input, and carries no wake token", () => {
    const h = makeHarness();
    h.receiver.deliver(h.input());
    const content = h.ctl.sent[0]!.message.content as string;
    expect(content).toContain("不可信输入");
    expect(content).toMatch(/<<<fab-[A-Za-z0-9_]+>>>/);
    expect(content).toContain("<<<fab-");
    const details = h.ctl.sent[0]!.message.details as { xid: string };
    expect(details.xid).toBeDefined();
    expect("wakeToken" in details).toBe(false); // deliver-only never carries a token (XI10)
    expect("xsWake" in details).toBe(false);
  });
});

/** Helper for the standalone dedup-full case (own membership/clock). */
function h_input(membership: XsMembership, clock: FakeClock): XsDeliverInput {
  return {
    xid: "x-full",
    to: { sessionId: SESSION, epoch: membership.epoch },
    from: { sessionId: SENDER, ref: "ab12cd34ef56", cwdLabel: "~/x", agentId: "a" },
    text: "t",
    wake: false,
    expiresAt: clock.now() + 5_000,
  };
}

function fenceNameOf(opener: string): "compaction" | "tree" | "switch" {
  if (opener === "session_before_compact") return "compaction";
  if (opener === "session_before_tree") return "tree";
  return "switch";
}

/** Real ledger + independent replyInbox, not a hand-written authorization stub. */
function replyHarness(options: { human?: boolean; idle?: boolean } = {}) {
  const h = makeHarness({
    replies: true,
    recvPerHour: 0,
    ...(options.idle === undefined ? {} : { idle: options.idle }),
  });
  const issue = () =>
    h.replyLedger.issue({
      requesterSessionId: SESSION,
      replierSessionId: SENDER,
      replierRef: "ab12cd34ef56",
      origin: options.human ? "human" : "model",
      wakeOnReply: !options.human,
      requesterLevel: 2,
      timeoutMs: 60_000,
      lateGraceMs: 600_000,
      maxPending: 2,
      maxPendingPerTarget: 2,
    });
  const issued = issue();
  if (!issued.ok) throw new Error("ticket issue failed");
  const requestId = issued.ticket.requestId;
  return {
    ...h,
    requestId,
    issue,
    reply: (over: Partial<XsDeliverInput> = {}) => h.input({ inReplyTo: requestId, ...over }),
  };
}

describe("RX5 reply consumption §6.3", () => {
  it("normal inbox full and inbound rate zero do not intercept replies; quiet human replies bound future issuance", () => {
    const h = replyHarness({ human: true });
    for (let i = 0; i < h.inbox.cap; i++) h.inbox.accept(`normal-${i}`, "appended");
    expect(h.receiver.deliver(h.reply())).toEqual({ effect: "applied", woke: false });
    expect(h.ctl.sent[0]).toMatchObject({
      message: { display: true, details: { inReplyTo: h.requestId } },
      options: { triggerTurn: false },
    });
    expect(h.replyInbox.occupied).toBe(1);
    expect(h.receiver.wakeQuota().recvUsed).toBe(0);
    const second = h.issue();
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("second ticket missing");
    expect(h.receiver.deliver(h.reply({ inReplyTo: second.ticket.requestId })).effect).toBe("applied");
    expect(h.replyInbox.occupied).toBe(2);
    expect(h.issue()).toMatchObject({ ok: false, code: "reply_quota" });
    h.clock.advance(1);
    h.replyInbox.onRunStart();
    h.replyInbox.onRunSettled();
    expect(h.replyInbox.occupied).toBe(0);
    expect(h.issue().ok).toBe(true);
  });

  it("synchronous reentry sees consuming; only one possibly effective dispatch", () => {
    const h = replyHarness({ human: true });
    const send = h.host.sendMessage;
    let nested: unknown;
    h.host.sendMessage = (m, o) => {
      expect(h.replyLedger.get(h.requestId)?.state).toBe("consuming");
      nested = h.receiver.deliver(h.reply());
      send(m, o);
    };
    expect(h.receiver.deliver(h.reply()).effect).toBe("applied");
    expect(nested).toEqual({ effect: "none", reason: "rejected", woke: false });
    expect(h.ctl.sent).toHaveLength(1);
    expect(h.replyLedger.get(h.requestId)?.state).toBe("replied");
    expect(h.receiver.deliver(h.reply()).reason).toBe("rejected");
  });

  it.each(["expired", "session_changed", "rejected", "host_rejected"] as const)(
    "Controller none %s releases; another xid can retry",
    (reason) => {
      const h = replyHarness();
      h.receiver.setController({
        dispatch: () => {
          expect(h.replyLedger.get(h.requestId)?.state).toBe("consuming");
          return { dispatched: false, effect: "none", reason, woke: false };
        },
      });
      expect(h.receiver.deliver(h.reply())).toEqual({ effect: "none", reason, woke: false });
      expect(h.replyInbox.occupied).toBe(0);
      expect(h.replyLedger.get(h.requestId)?.state).toBe("pending");
      h.membership.setReceive("deliver");
      expect(h.receiver.deliver(h.reply()).effect).toBe("applied");
    },
  );

  it.each(["applied", "unknown"] as const)(
    "Controller dispatched %s commits trigger and passes solicited returnLevel",
    (effect) => {
      const h = replyHarness();
      const dispatch = vi.fn((_request: RootWakeRequest): RootWakeDispatchResult =>
        effect === "applied"
          ? { dispatched: true, effect, woke: true, token: "token" }
          : { dispatched: true, effect, woke: true, token: "token", reason: "start_deferred" },
      );
      h.receiver.setController({ dispatch });
      expect(h.receiver.deliver(h.reply())).toMatchObject({ effect, woke: true });
      expect(dispatch.mock.calls[0]).toEqual([
        expect.objectContaining({ solicited: true, returnLevel: 2, inReplyTo: h.requestId }),
      ]);
      expect(h.replyInbox.snapshot()[0]?.mode).toBe("trigger");
      expect(h.replyLedger.get(h.requestId)?.state).toBe("replied");
    },
  );

  it("Controller downgrade keeps consuming through quiet send and commits", () => {
    const h = replyHarness();
    h.receiver.setController({ dispatch: () => ({ dispatched: false, wakeDowngraded: "busy" }) });
    const send = h.host.sendMessage;
    h.host.sendMessage = (m, o) => {
      expect(h.replyLedger.get(h.requestId)?.state).toBe("consuming");
      send(m, o);
    };
    expect(h.receiver.deliver(h.reply())).toEqual({ effect: "applied", woke: false, wakeDowngraded: "busy" });
    expect(h.replyInbox.snapshot()[0]?.mode).toBe("appended");
  });

  it("second guard after Controller downgrade rejects and releases", () => {
    const h = replyHarness();
    h.receiver.setController({
      dispatch: () => {
        h.fence.onEvent({ type: "session_before_compact" });
        return { dispatched: false, wakeDowngraded: "busy" };
      },
    });
    expect(h.receiver.deliver(h.reply())).toMatchObject({ effect: "none", reason: "fenced:compaction" });
    expect(h.replyLedger.get(h.requestId)?.state).toBe("pending");
    expect(h.replyInbox.occupied).toBe(0);
    expect(h.ctl.sent).toHaveLength(0);
  });

  it("Controller downgrade then second guard throws ⇒ release", () => {
    const h = replyHarness();
    const dispatch = vi.fn((): RootWakeDispatchResult => ({ dispatched: false, wakeDowngraded: "busy" }));
    h.receiver.setController({ dispatch });
    const beginDispatch = h.fence.beginDispatch.bind(h.fence);
    const guard = vi
      .spyOn(h.fence, "beginDispatch")
      .mockImplementationOnce(beginDispatch)
      .mockImplementationOnce(() => {
        throw new Error("second guard failed before host send");
      });

    expect(h.receiver.deliver(h.reply())).toEqual({ effect: "none", reason: "receiver_error", woke: false });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(guard).toHaveBeenCalledTimes(2);
    expect(h.ctl.sent).toHaveLength(0);
    expect(h.replyLedger.get(h.requestId)?.state).toBe("pending");
    expect(h.replyInbox.occupied).toBe(0);
    expect(h.replyLedger.classify(h.requestId, SENDER, SESSION).kind).toBe("reply");
    guard.mockRestore();
    h.receiver.setController(undefined);
    expect(h.receiver.deliver(h.reply())).toEqual({ effect: "applied", woke: false, wakeDowngraded: "wake_disabled" });
    expect(h.ctl.sent).toHaveLength(1);
  });

  it("Controller request preparation throws before dispatch ⇒ release", () => {
    const h = replyHarness();
    const dispatch = vi.fn();
    h.receiver.setController({ dispatch });
    const input = h.reply();
    Object.defineProperty(input.from, "ref", {
      get: () => {
        throw new Error("request formatting failed");
      },
    });

    expect(h.receiver.deliver(input)).toEqual({ effect: "none", reason: "receiver_error", woke: false });
    expect(dispatch).not.toHaveBeenCalled();
    expect(h.ctl.sent).toHaveLength(0);
    expect(h.replyLedger.get(h.requestId)?.state).toBe("pending");
    expect(h.replyInbox.occupied).toBe(0);
  });

  it("first dispatch guard rejection releases; stage-5 fence never reserves", () => {
    const h = replyHarness();
    const reserve = vi.spyOn(h.replyLedger, "reserve");
    h.fence.onEvent({ type: "session_before_compact" });
    expect(h.receiver.deliver(h.reply()).effect).toBe("none");
    expect(reserve).not.toHaveBeenCalled();
    h.fence.reset();
    h.receiver.setController({ dispatch: vi.fn() });
    vi.spyOn(h.fence, "beginDispatch").mockReturnValue({ ok: false, reason: "fenced:compaction" });
    expect(h.receiver.deliver(h.reply()).reason).toBe("fenced:compaction");
    expect(reserve).toHaveBeenCalledOnce();
    expect(h.replyLedger.get(h.requestId)?.state).toBe("pending");
  });

  it("goal at dispatch guard downgrades to quiet and commits", () => {
    const h = replyHarness();
    const dispatch = vi.fn();
    h.receiver.setController({ dispatch });
    vi.spyOn(h.fence, "beginDispatch").mockReturnValue({ ok: false, reason: "fenced:goal", wakeOnly: true });
    expect(h.receiver.deliver(h.reply())).toMatchObject({ effect: "applied", woke: false, wakeDowngraded: "goal" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(h.replyLedger.get(h.requestId)?.state).toBe("replied");
  });

  it("host synchronous throw releases reservation", () => {
    const h = replyHarness({ human: true });
    h.ctl.makeSendThrow();
    expect(h.receiver.deliver(h.reply())).toEqual({ effect: "none", reason: "host_rejected", woke: false });
    expect(h.replyLedger.get(h.requestId)?.state).toBe("pending");
    expect(h.replyInbox.occupied).toBe(0);
  });

  it("exception before dispatched releases; after dispatched commits conservatively", () => {
    const h = replyHarness();
    const guard = vi.spyOn(h.fence, "beginDispatch").mockImplementation(() => {
      throw new Error("before");
    });
    expect(h.receiver.deliver(h.reply())).toEqual({ effect: "none", reason: "receiver_error", woke: false });
    expect(h.replyLedger.get(h.requestId)?.state).toBe("pending");
    guard.mockRestore();
    h.receiver.setController({
      dispatch: () => {
        throw new Error("after");
      },
    });
    expect(h.receiver.deliver(h.reply())).toEqual({ effect: "unknown", reason: "receiver_error", woke: false });
    expect(h.replyLedger.get(h.requestId)?.state).toBe("replied");
    expect(h.replyInbox.occupied).toBe(1);
  });

  it.each(["verify-failed", "verify-throws", "queued", "unverified"] as const)(
    "successful quiet send %s always commits",
    (mode) => {
      const h = replyHarness({ human: true, idle: mode !== "queued" });
      if (mode === "verify-failed")
        vi.spyOn(h.fence, "verifyDispatch").mockReturnValue({ ok: false, reason: "gen_changed" });
      if (mode === "verify-throws")
        vi.spyOn(h.fence, "verifyDispatch").mockImplementation(() => {
          throw new Error("post send");
        });
      if (mode === "unverified") h.host.getLeafEntry = () => undefined;
      const v = h.receiver.deliver(h.reply());
      expect(v).toMatchObject({
        effect: "unknown",
        woke: false,
        reason: mode === "verify-throws" ? "receiver_error" : mode === "queued" ? "queued" : "accept_unverified",
      });
      expect(h.replyLedger.get(h.requestId)?.state).toBe("replied");
      expect(h.replyInbox.occupied).toBe(1);
    },
  );

  it("timed-out reply inside grace is quiet and acknowledges reply_late", () => {
    const h = replyHarness();
    h.clock.advance(60_000);
    expect(h.receiver.deliver(h.reply())).toEqual({ effect: "applied", reason: "reply_late", woke: false });
    expect(h.replyLedger.get(h.requestId)?.state).toBe("late_replied");
    expect(h.ctl.sent[0]?.message.content).toContain("state=late");
  });

  it("reply inbox anomaly refuses without consuming", () => {
    const h = replyHarness();
    h.replyInbox.accept("full-1", "appended");
    h.replyInbox.accept("full-2", "appended");
    expect(h.receiver.deliver(h.reply())).toEqual({ effect: "none", reason: "inbox_full", woke: false });
    expect(h.replyLedger.get(h.requestId)?.state).toBe("pending");
    expect(h.replyLedger.stats(SESSION).replyInboxAnomaly).toBe(1);
  });

  it("reply remains subject to block and allowFrom, not forged/restarted credential", () => {
    const h = replyHarness();
    h.membership.block(SENDER);
    expect(h.receiver.deliver(h.reply()).reason).toBe("rejected");
    expect(h.replyLedger.get(h.requestId)?.state).toBe("pending");
    h.membership.unblock(SENDER);
    expect(h.receiver.deliver(h.reply({ from: { ...h.reply().from, sessionId: "wrong" } })).reason).toBe("rejected");
    const restarted = makeHarness({ replies: true });
    expect(restarted.receiver.deliver(restarted.input({ inReplyTo: h.requestId })).reason).toBe("rejected");
  });

  it.each([false, true])("expect header and details preserve reply stamp on wake=%s", (wake) => {
    const h = makeHarness();
    if (wake)
      h.receiver.setController({
        dispatch: (r) => {
          expect(r.reply).toEqual({ requestId: "q" + "a".repeat(18), dueAt: 61_000 });
          expect(r.content).toContain('reply_to="q' + "a".repeat(18) + '"');
          return { dispatched: true, effect: "applied", woke: true, token: "t" };
        },
      });
    const v = h.receiver.deliver(h.input({ wake, reply: { requestId: "q" + "a".repeat(18), dueAt: 61_000 } }));
    expect(v.effect).toBe("applied");
    if (!wake) {
      expect(h.ctl.sent[0]?.message.details).toMatchObject({ reply: { dueAt: 61_000 } });
      expect(h.ctl.sent[0]?.message.content).toContain("只接受一次回复");
    }
  });
});

it.each([false, true])("RX5 Controller dispatched then verify throws/fails (throws=%s) commits trigger", (throws) => {
  const h = replyHarness();
  h.receiver.setController({ dispatch: () => ({ dispatched: true, effect: "applied", woke: true, token: "t" }) });
  vi.spyOn(h.fence, "verifyDispatch").mockImplementation(() => {
    if (throws) throw new Error("after dispatch");
    return { ok: false, reason: "gen_changed" };
  });
  expect(h.receiver.deliver(h.reply())).toEqual({
    effect: "unknown",
    woke: false,
    reason: throws ? "receiver_error" : "accept_unverified",
  });
  expect(h.replyLedger.get(h.requestId)?.state).toBe("replied");
  expect(h.replyInbox.snapshot()[0]?.mode).toBe("trigger");
});

it("RX5 Controller downgrade followed by host rejection releases and retry remains possible", () => {
  const h = replyHarness();
  h.receiver.setController({ dispatch: () => ({ dispatched: false, wakeDowngraded: "busy" }) });
  h.ctl.makeSendThrow();
  expect(h.receiver.deliver(h.reply())).toEqual({ effect: "none", reason: "host_rejected", woke: false });
  expect(h.replyLedger.classify(h.requestId, SENDER, SESSION).kind).toBe("reply");
  expect(h.replyInbox.occupied).toBe(0);
});

it("RX5 replies still obey allowFrom before reservation", () => {
  const h = makeHarness({ replies: true, allowFrom: ["another-session"] });
  const result = h.replyLedger.issue({
    requesterSessionId: SESSION,
    replierSessionId: SENDER,
    replierRef: "peer",
    origin: "model",
    wakeOnReply: true,
    requesterLevel: 0,
    timeoutMs: 60_000,
    lateGraceMs: 600_000,
    maxPending: 2,
    maxPendingPerTarget: 2,
  });
  if (!result.ok) throw new Error("issue failed");
  const reserve = vi.spyOn(h.replyLedger, "reserve");
  expect(h.receiver.deliver(h.input({ inReplyTo: result.ticket.requestId })).reason).toBe("rejected");
  expect(reserve).not.toHaveBeenCalled();
  expect(h.replyLedger.get(result.ticket.requestId)?.state).toBe("pending");
});

it.each(["queued", "leaf-unverified", "verify-failed", "verify-throws"] as const)(
  "RX5 late reply %s preserves evidence reason but still commits late_replied",
  (mode) => {
    const h = replyHarness({ idle: mode !== "queued" });
    h.clock.advance(60_000);
    if (mode === "leaf-unverified") h.host.getLeafEntry = () => undefined;
    if (mode === "verify-failed")
      vi.spyOn(h.fence, "verifyDispatch").mockReturnValue({ ok: false, reason: "gen_changed" });
    if (mode === "verify-throws")
      vi.spyOn(h.fence, "verifyDispatch").mockImplementation(() => {
        throw new Error("after");
      });
    expect(h.receiver.deliver(h.reply())).toEqual({
      effect: "unknown",
      woke: false,
      reason: mode === "queued" ? "queued" : mode === "verify-throws" ? "receiver_error" : "accept_unverified",
    });
    expect(h.replyLedger.get(h.requestId)?.state).toBe("late_replied");
    expect(h.replyInbox.occupied).toBe(1);
  },
);
