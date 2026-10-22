import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import type { FenceDispatchVerdict } from "../../src/fabric/xs/fence.js";
import { XsInbox } from "../../src/fabric/xs/inbox.js";
import {
  buildDroppedSummaryContent,
  buildInvalidationNoticeContent,
  buildTimeoutNoticeContent,
  XsReplyNoticeGate,
  type XsReplyNoticePorts,
  type XsReplyNoticeWakeRequest,
  type XsReplyQuietWrite,
  type XsReplyNoticeWakeResult,
} from "../../src/fabric/xs/reply-notice.js";
import { createXsReplyInboxPort, XsReplyLedger, type XsReplyTicket } from "../../src/fabric/xs/reply-ledger.js";

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:xs-reply-ledger")];
});

const TIMEOUT_MS = 60_000;
const LATE_GRACE_MS = 600_000;

function seqIds(): () => string {
  let n = 0;
  return () => `q${String(++n).padStart(18, "0")}`;
}

interface Harness {
  clock: FakeClock;
  ledger: XsReplyLedger;
  gate: XsReplyNoticeGate;
  writes: XsReplyQuietWrite[];
  wakeRequests: XsReplyNoticeWakeRequest[];
  wakeResult: () => XsReplyNoticeWakeResult;
  state: {
    disposed: boolean;
    sessionId: string;
    joined: boolean;
    receive: "off" | "deliver" | "wake" | "replies";
    fence: FenceDispatchVerdict;
    verifyOk: boolean;
    /** When verifyOk is false, report the failure as a wakeOnly (goal) verdict. */
    verifyWakeOnly: boolean;
    wakeThrows: boolean;
    hostThrows: boolean;
  };
}

function harness(overrides: Partial<Harness["state"]> = {}): Harness {
  const clock = new FakeClock();
  const ledger = new XsReplyLedger({ clock, newRequestId: seqIds() });
  ledger.bindSession({ sessionId: "A", inbox: createXsReplyInboxPort(new XsInbox(8)) });
  const writes: XsReplyQuietWrite[] = [];
  const wakeRequests: XsReplyNoticeWakeRequest[] = [];
  const state: Harness["state"] = {
    disposed: false,
    sessionId: "A",
    joined: true,
    receive: "wake",
    fence: { ok: true, gen: 7 },
    verifyOk: true,
    verifyWakeOnly: false,
    wakeThrows: false,
    hostThrows: false,
    ...overrides,
  };
  let wakeResult: XsReplyNoticeWakeResult = { dispatched: true };
  const ports: XsReplyNoticePorts = {
    ledger,
    sessionId: "A",
    getSessionId: () => state.sessionId,
    disposed: () => state.disposed,
    joined: () => state.joined,
    receive: () => state.receive,
    fence: {
      beginDispatch: () => state.fence,
      verifyDispatch: (gen: number): FenceDispatchVerdict =>
        state.verifyOk
          ? { ok: true, gen }
          : state.verifyWakeOnly
            ? { ok: false, reason: "fenced:goal", wakeOnly: true }
            : { ok: false, reason: "gen_changed" },
    },
    controller: {
      dispatch: (request: XsReplyNoticeWakeRequest): XsReplyNoticeWakeResult => {
        if (state.wakeThrows) throw new Error("controller down");
        wakeRequests.push(request);
        return wakeResult;
      },
    },
    host: {
      sendMessage: (write: XsReplyQuietWrite): void => {
        if (state.hostThrows) throw new Error("host rejected");
        writes.push(write);
      },
    },
    clock,
  };
  const gate = new XsReplyNoticeGate(ports);
  return { clock, ledger, gate, writes, wakeRequests, wakeResult: () => wakeResult, state };
}

/** Issue + time out a ticket so it owes a timeout notice. */
function oweTicket(h: Harness, wakeOnReply = true): XsReplyTicket {
  const result = h.ledger.issue({
    requesterSessionId: "A",
    replierSessionId: "B",
    replierRef: "B",
    origin: wakeOnReply ? "model" : "human",
    wakeOnReply,
    requesterLevel: 2,
    timeoutMs: TIMEOUT_MS,
    lateGraceMs: LATE_GRACE_MS,
    maxPending: 8,
    maxPendingPerTarget: 3,
  });
  if (!result.ok) throw new Error("issue failed");
  h.clock.advance(TIMEOUT_MS);
  h.ledger.sweep();
  return result.ticket;
}

describe("xs reply NoticeGate — §7.2 admission matrix", () => {
  it("nothing owed ⇒ nothing_owed, no write, no timer", () => {
    const h = harness();
    expect(h.gate.flush()).toEqual({ written: false, reason: "nothing_owed" });
    expect(h.writes).toHaveLength(0);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("disposed ⇒ refused, owed kept", () => {
    const h = harness({ disposed: true });
    const ticket = oweTicket(h);
    expect(h.gate.flush()).toMatchObject({ written: false, reason: "disposed" });
    expect(h.writes).toHaveLength(0);
    expect(h.ledger.owedNotices("A").map((t) => t.requestId)).toEqual([ticket.requestId]);
  });

  it("session_changed / not_joined / receive_off each refuse and keep owed", () => {
    for (const override of [{ sessionId: "OTHER" }, { joined: false }, { receive: "off" as const }] as const) {
      const h = harness(...[override]);
      const ticket = oweTicket(h);
      const result = h.gate.flush();
      expect(result.written).toBe(false);
      if (override.sessionId !== undefined) expect(result.reason).toBe("session_changed");
      else if (override.joined === false) expect(result.reason).toBe("not_joined");
      else expect(result.reason).toBe("receive_off");
      expect(h.writes).toHaveLength(0);
      expect(h.ledger.owedNotices("A")).toHaveLength(1);
      void ticket;
    }
  });

  it("fence window (non-wakeOnly) refuses BOTH paths — no quiet-during-fence fallback (r2 #2)", () => {
    const h = harness({ fence: { ok: false, reason: "fenced:switch" } });
    oweTicket(h);
    expect(h.gate.flush()).toMatchObject({ written: false, reason: "fenced" });
    expect(h.writes).toHaveLength(0);
    expect(h.wakeRequests).toHaveLength(0);
    expect(h.ledger.owedNotices("A")).toHaveLength(1);
    // the 30s fallback timer is armed and retries into the same refusal
    expect(h.clock.pendingTimers).toBe(1);
    h.clock.advance(30_000);
    expect(h.writes).toHaveLength(0);
    expect(h.ledger.owedNotices("A")).toHaveLength(1);
  });

  it("wakeOnly fence (goal) allows the QUIET write only — controller never called", () => {
    const h = harness({ fence: { ok: false, reason: "fenced:goal", wakeOnly: true } });
    const ticket = oweTicket(h); // wakeOnReply true, receive wake
    const result = h.gate.flush();
    expect(result).toMatchObject({ written: "quiet", requestIds: [ticket.requestId] });
    expect(h.wakeRequests).toHaveLength(0);
    expect(h.writes).toHaveLength(1);
    expect(h.ledger.owedNotices("A")).toHaveLength(0);
  });

  it("wakeOnly (goal) quiet write is NOT counted noticeUnverified; a real gen_changed still is", () => {
    const goal = harness({
      fence: { ok: false, reason: "fenced:goal", wakeOnly: true },
      verifyOk: false,
      verifyWakeOnly: true,
    });
    oweTicket(goal);
    expect(goal.gate.flush()).toMatchObject({ written: "quiet" });
    expect(goal.gate.status().noticeUnverified).toBe(0);
    expect(goal.ledger.owedNotices("A")).toHaveLength(0);

    const moved = harness({ verifyOk: false });
    oweTicket(moved, false);
    expect(moved.gate.flush()).toMatchObject({ written: "quiet" });
    expect(moved.gate.status().noticeUnverified).toBe(1);
  });
});

describe("xs reply NoticeGate — wake vs quiet", () => {
  it("wakeOnReply ∧ receive wake ∧ controller ⇒ solicited wake at the ticket's level; owed cleared", () => {
    const h = harness();
    const ticket = oweTicket(h);
    expect(h.gate.flush()).toMatchObject({ written: "wake", requestIds: [ticket.requestId] });
    expect(h.wakeRequests).toHaveLength(1);
    expect(h.wakeRequests[0]).toMatchObject({
      xid: `t_${ticket.requestId}`,
      solicited: true,
      returnLevel: 2,
      from: { kind: "local", reason: "reply_timeout" },
    });
    expect(h.wakeRequests[0]!.expiresAt).toBe(h.clock.now() + 5_000);
    expect(h.writes).toHaveLength(0);
    expect(h.ledger.owedNotices("A")).toHaveLength(0);
    expect(h.gate.status()).toMatchObject({ writes: { wake: 1, quiet: 0 }, retryArmed: false });
  });

  it("wakeOnReply=false (human origin) ⇒ quiet write, display:true, no wake", () => {
    const h = harness();
    const ticket = oweTicket(h, false);
    expect(h.gate.flush()).toMatchObject({ written: "quiet", requestIds: [ticket.requestId] });
    expect(h.wakeRequests).toHaveLength(0);
    const write = h.writes[0]!;
    expect(write.customType).toBe("subagent:xs-reply");
    expect(write.display).toBe(true);
    expect(write.details.requestIds).toEqual([ticket.requestId]);
    expect(write.content).toContain(ticket.requestId);
  });

  it("receive=deliver ⇒ quiet (R2); receive=replies still wakes", () => {
    const deliver = harness({ receive: "deliver" });
    oweTicket(deliver);
    expect(deliver.gate.flush()).toMatchObject({ written: "quiet" });
    expect(deliver.wakeRequests).toHaveLength(0);

    const replies = harness({ receive: "replies" });
    oweTicket(replies);
    expect(replies.gate.flush()).toMatchObject({ written: "wake" });
  });

  it("controller none ⇒ wake_none, owed kept, retried by the 30s timer; downgrade ⇒ quiet in the same sync block", () => {
    const h = harness();
    const ticket = oweTicket(h);
    let wakeResult: XsReplyNoticeWakeResult = { dispatched: false, effect: "none", reason: "busy" };
    const writes: XsReplyQuietWrite[] = [];
    const requests: XsReplyNoticeWakeRequest[] = [];
    const gate = new XsReplyNoticeGate({
      ledger: h.ledger,
      sessionId: "A",
      getSessionId: () => "A",
      disposed: () => false,
      joined: () => true,
      receive: () => "wake",
      fence: {
        beginDispatch: () => ({ ok: true, gen: 1 }),
        verifyDispatch: (gen: number) => ({ ok: true, gen }),
      },
      controller: {
        dispatch: (request: XsReplyNoticeWakeRequest): XsReplyNoticeWakeResult => {
          requests.push(request);
          return wakeResult;
        },
      },
      host: {
        sendMessage: (write: XsReplyQuietWrite): void => {
          writes.push(write);
        },
      },
      clock: h.clock,
    });
    expect(gate.flush()).toMatchObject({ written: false, reason: "wake_none" });
    expect(h.ledger.owedNotices("A")).toHaveLength(1);
    expect(h.clock.pendingTimers).toBe(1);
    wakeResult = { dispatched: true };
    h.clock.advance(30_000); // timer fires ⇒ retry flush
    expect(requests).toHaveLength(2);
    expect(writes).toHaveLength(0);
    expect(h.ledger.owedNotices("A")).toHaveLength(0);

    // downgrade path: one fresh owed ticket, controller returns wakeDowngraded
    const ticket2 = oweTicket(h);
    wakeResult = { dispatched: false, wakeDowngraded: "busy" };
    expect(gate.flush()).toMatchObject({ written: "quiet", requestIds: [ticket2.requestId] });
    expect(writes).toHaveLength(1);
    void ticket;
  });

  it("controller throw / host throw ⇒ host_threw, owed kept (§7.2 step 5/6)", () => {
    const h1 = harness({ wakeThrows: true });
    oweTicket(h1);
    expect(h1.gate.flush()).toMatchObject({ written: false, reason: "host_threw" });
    expect(h1.ledger.owedNotices("A")).toHaveLength(1);

    const h2 = harness({ hostThrows: true });
    const ticket = oweTicket(h2, false); // quiet path
    expect(h2.gate.flush()).toMatchObject({ written: false, reason: "host_threw" });
    expect(h2.ledger.owedNotices("A")).toHaveLength(1);
    void ticket;
  });

  it("verifyDispatch failure after a successful write: owed STILL cleared, noticeUnverified counted, no resend (NQ3)", () => {
    const h = harness({ verifyOk: false });
    const ticket = oweTicket(h, false);
    expect(h.gate.flush()).toMatchObject({ written: "quiet" });
    expect(h.ledger.owedNotices("A")).toHaveLength(0);
    expect(h.gate.status().noticeUnverified).toBe(1);
    h.clock.advance(60_000); // no retry timer: nothing owed
    expect(h.writes).toHaveLength(1);
    void ticket;
  });

  it("multiple owed tickets of one session merge into ONE write (ids sorted); returnLevel = min", () => {
    const h = harness();
    const t1 = oweTicket(h); // level 2
    // second ticket with level 1, issued AFTER the first timed out
    const result = h.ledger.issue({
      requesterSessionId: "A",
      replierSessionId: "C",
      replierRef: "C",
      origin: "model",
      wakeOnReply: true,
      requesterLevel: 1,
      timeoutMs: TIMEOUT_MS,
      lateGraceMs: LATE_GRACE_MS,
      maxPending: 8,
      maxPendingPerTarget: 3,
    });
    if (!result.ok) throw new Error("issue failed");
    h.clock.advance(TIMEOUT_MS);
    h.ledger.sweep();
    const flush = h.gate.flush();
    expect(flush).toMatchObject({ written: "wake", requestIds: [t1.requestId, result.ticket.requestId].sort() });
    expect(h.wakeRequests[0]!.returnLevel).toBe(1);
    expect(h.wakeRequests).toHaveLength(1);
    expect(h.ledger.owedNotices("A")).toHaveLength(0);
  });
});

describe("xs reply NoticeGate — drop at lateUntil and one-shot quiet notices", () => {
  it("owed never admitted past lateUntil ⇒ swept away, droppedNotices++, retry disarms", () => {
    const h = harness({ joined: false }); // admission permanently refused
    const ticket = oweTicket(h);
    h.gate.flush(); // not_joined — retry timer armed
    expect(h.clock.pendingTimers).toBe(1);
    h.clock.advance(LATE_GRACE_MS + 30_000); // retry fires past lateUntil
    expect(h.gate.flush()).toEqual({ written: false, reason: "nothing_owed" });
    expect(h.writes).toHaveLength(0);
    expect(h.ledger.droppedNoticeCount("A")).toBe(1);
    expect(h.clock.pendingTimers).toBe(0);
    void ticket;
  });

  it("emitQuiet: admission-checked, never wakes; the §3.3 restart invalidation and §3.4 summary ride it", () => {
    const h = harness({ receive: "off" });
    expect(
      h.gate.emitQuiet(buildInvalidationNoticeContent([{ requestId: "q000000000000000001", replierRef: "B" }], 2), [
        "q000000000000000001",
      ]),
    ).toMatchObject({ written: false, reason: "receive_off" });
    h.state.receive = "wake";
    expect(
      h.gate.emitQuiet(buildInvalidationNoticeContent([{ requestId: "q000000000000000001", replierRef: "B" }], 2), [
        "q000000000000000001",
      ]),
    ).toMatchObject({ written: "quiet" });
    expect(h.wakeRequests).toHaveLength(0); // one-shot quiet NEVER wakes, controller present or not
    expect(h.writes[0]!.content).toContain("另有 2 条");
    expect(h.writes[0]!.content).toContain("pi 重启");

    const fenced = harness({ fence: { ok: false, reason: "fenced:tree" } });
    expect(fenced.gate.emitQuiet(buildDroppedSummaryContent(3), [])).toMatchObject({
      written: false,
      reason: "fenced",
    });
    expect(fenced.writes).toHaveLength(0);
    // one-shot notices do not arm the retry timer (the caller decides retries)
    expect(fenced.clock.pendingTimers).toBe(0);
  });

  it("dispose stops writing and clears the retry timer", () => {
    const h = harness({ joined: false });
    oweTicket(h);
    h.gate.flush();
    expect(h.clock.pendingTimers).toBe(1);
    h.state.joined = true;
    h.gate.dispose();
    expect(h.clock.pendingTimers).toBe(0);
    h.clock.advance(120_000);
    expect(h.writes).toHaveLength(0);
    expect(h.gate.flush()).toMatchObject({ written: false, reason: "disposed" });
  });
});

describe("xs reply notice copy (§3.3/§3.4/§7.2)", () => {
  it("timeout copy lists every ticket with its deadline and the grace-window promise", () => {
    const clock = new FakeClock(1_000);
    const ledger = new XsReplyLedger({ clock, newRequestId: seqIds() });
    const tickets: XsReplyTicket[] = [];
    for (const replier of ["B", "C"]) {
      const result = ledger.issue({
        requesterSessionId: "A",
        replierSessionId: replier,
        replierRef: replier,
        origin: "model",
        wakeOnReply: true,
        requesterLevel: 1,
        timeoutMs: TIMEOUT_MS,
        lateGraceMs: LATE_GRACE_MS,
        maxPending: 8,
        maxPendingPerTarget: 3,
      });
      if (result.ok) tickets.push(result.ticket);
    }
    const content = buildTimeoutNoticeContent(tickets);
    expect(content).toContain("[fabric xs reply-timeout]");
    expect(content).toContain("2 个跨会话请求");
    expect(content).toContain(tickets[0]!.requestId);
    expect(content).toContain("宽限期");
  });

  it("invalidation and dropped-summary copies carry the fail-closed wording", () => {
    const invalidation = buildInvalidationNoticeContent([{ requestId: "q0123456789abcdef01", replierRef: "B" }], 0);
    expect(invalidation).toContain("凭证已失效");
    expect(invalidation).toContain("请忽略");
    expect(buildDroppedSummaryContent(5)).toContain("5 个跨会话请求超时并已过期");
  });
});
