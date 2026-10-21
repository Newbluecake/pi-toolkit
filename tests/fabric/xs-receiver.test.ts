import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createSessionFence, type SessionFence } from "../../src/fabric/xs/fence.js";
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

  return { clock, membership, fence, inbox, dedup, host, receiver, ctl, persisted, input };
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
