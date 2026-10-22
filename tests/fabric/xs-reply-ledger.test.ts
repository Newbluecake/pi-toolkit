import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FakeClock } from "../../src/core/clock.js";
import { XsInbox } from "../../src/fabric/xs/inbox.js";
import {
  buildReplyIssueEntry,
  buildReplySettleEntry,
  createXsReplyInboxPort,
  getXsReplyLedger,
  parseXsReplyEntry,
  planReplyRestartInvalidation,
  XsReplyDueScheduler,
  XsReplyLedger,
  type XsReplyIssueEntry,
  type XsReplySettleEntry,
  type XsReplyTicket,
} from "../../src/fabric/xs/reply-ledger.js";

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:xs-reply-ledger")];
});

const TIMEOUT_MS = 60_000; // RX0 minimum — the ledger clamps into [60s, 24h] anyway
const LATE_GRACE_MS = 600_000;

function seqIds(prefix = "q"): () => string {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(18, "0")}`;
}

function mkLedger(clock: FakeClock): XsReplyLedger {
  return new XsReplyLedger({ clock, newRequestId: seqIds() });
}

interface IssueOpts {
  requester?: string;
  replier?: string;
  timeoutMs?: number;
  lateGraceMs?: number;
  wakeOnReply?: boolean;
  level?: number;
  maxPending?: number;
  maxPendingPerTarget?: number;
}

function issueTicket(ledger: XsReplyLedger, opts: IssueOpts = {}): XsReplyTicket {
  const result = ledger.issue({
    requesterSessionId: opts.requester ?? "A",
    replierSessionId: opts.replier ?? "B",
    replierRef: opts.replier ?? "B",
    origin: "model",
    wakeOnReply: opts.wakeOnReply ?? true,
    requesterLevel: opts.level ?? 1,
    timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
    lateGraceMs: opts.lateGraceMs ?? LATE_GRACE_MS,
    maxPending: opts.maxPending ?? 8,
    maxPendingPerTarget: opts.maxPendingPerTarget ?? 3,
  });
  if (!result.ok) throw new Error(`issue failed: ${result.code}`);
  return result.ticket;
}

describe("xs reply ledger — §3.4 state table, row by row", () => {
  it("pending: receivable on time, occupies quota+slot, survives sweep; dueAt ⇒ timed_out", () => {
    const clock = new FakeClock(1000);
    const ledger = mkLedger(clock);
    const ticket = issueTicket(ledger);
    expect(ledger.classify(ticket.requestId, "B", "A")).toMatchObject({ kind: "reply" });
    expect(ledger.sweep()).toEqual({ timedOut: [], deleted: 0, dropped: 0 });
    expect(ledger.get(ticket.requestId)!.state).toBe("pending");
    clock.advance(TIMEOUT_MS);
    const swept = ledger.sweep();
    expect(swept.timedOut).toEqual([ticket.requestId]);
    const after = ledger.get(ticket.requestId)!;
    expect(after.state).toBe("timed_out");
    expect(after.noticeOwed).toBe("timeout");
  });

  it("pending: reserve ⇒ consuming; recordSend none ⇒ send_failed", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    const ticket = issueTicket(ledger);
    ledger.bindSession({ sessionId: "A", inbox: createXsReplyInboxPort(new XsInbox(8)) });
    expect(ledger.reserve(ticket.requestId, "x1")).toEqual({ ok: true });
    expect(ledger.get(ticket.requestId)).toMatchObject({ state: "consuming", priorState: "pending", consumedBy: "x1" });

    const other = issueTicket(ledger);
    ledger.recordSend(other.requestId, "none");
    expect(ledger.get(other.requestId)).toMatchObject({ state: "send_failed", sendEffect: "none" });
  });

  it("consuming: NOT receivable (duplicate + sync re-entry classify invalid), keeps quota+slot, sweep never touches it", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    ledger.bindSession({ sessionId: "A", inbox: createXsReplyInboxPort(new XsInbox(8)) });
    const ticket = issueTicket(ledger);
    ledger.reserve(ticket.requestId, "x1");
    expect(ledger.classify(ticket.requestId, "B", "A")).toMatchObject({ kind: "invalid", reason: "state" });
    clock.advance(10 * TIMEOUT_MS); // way past dueAt + lateUntil
    expect(ledger.sweep()).toEqual({ timedOut: [], deleted: 0, dropped: 0 });
    expect(ledger.get(ticket.requestId)!.state).toBe("consuming");
  });

  it("consuming: commit ⇒ replied (or late_replied from timed_out); release ⇒ priorState", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    const inbox = new XsInbox(8);
    const port = createXsReplyInboxPort(inbox);
    ledger.bindSession({ sessionId: "A", inbox: port });
    const onTime = issueTicket(ledger);
    ledger.reserve(onTime.requestId, "x1");
    expect(ledger.commit(onTime.requestId, "trigger")).toBe(true);
    expect(ledger.get(onTime.requestId)).toMatchObject({ state: "replied", consumedBy: "x1" });

    clock.advance(TIMEOUT_MS); // second ticket times out first
    ledger.sweep();
    const late = issueTicket(ledger, { replier: "C" });
    clock.advance(TIMEOUT_MS);
    ledger.sweep();
    expect(ledger.get(late.requestId)!.state).toBe("timed_out");
    ledger.reserve(late.requestId, "x2");
    ledger.commit(late.requestId, "appended");
    expect(ledger.get(late.requestId)!.state).toBe("late_replied");

    const released = issueTicket(ledger, { replier: "D" });
    ledger.reserve(released.requestId, "x3");
    ledger.release(released.requestId);
    expect(ledger.get(released.requestId)).toMatchObject({ state: "pending" });
    expect(port.occupied()).toBe(2); // the two commits; the release freed its reservation
    expect(port.free()).toBe(8 - 2);
  });

  it("timed_out: receivable (late) inside the grace window and still occupies quota; deleted at lateUntil", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    const ticket = issueTicket(ledger, { maxPending: 1 });
    clock.advance(TIMEOUT_MS);
    expect(ledger.classify(ticket.requestId, "B", "A")).toMatchObject({ kind: "late" });
    // quota: a single timed_out ticket exhausts maxPending=1
    expect(
      ledger.issue({
        requesterSessionId: "A",
        replierSessionId: "E",
        replierRef: "E",
        origin: "model",
        wakeOnReply: true,
        requesterLevel: 1,
        timeoutMs: TIMEOUT_MS,
        lateGraceMs: LATE_GRACE_MS,
        maxPending: 1,
        maxPendingPerTarget: 3,
      }),
    ).toEqual({ ok: false, code: "reply_quota" });
    clock.advance(LATE_GRACE_MS);
    const swept = ledger.sweep();
    expect(swept.deleted).toBe(1);
    expect(swept.dropped).toBe(1); // its timeout notice never passed admission
    expect(ledger.get(ticket.requestId)).toBeUndefined();
    expect(ledger.droppedNoticeCount("A")).toBe(1);
  });

  it("tombstones (replied/late_replied): not deleted before lateUntil, gone after; send_failed: immediately deletable", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    ledger.bindSession({ sessionId: "A", inbox: createXsReplyInboxPort(new XsInbox(8)) });
    const replied = issueTicket(ledger);
    ledger.reserve(replied.requestId, "x1");
    ledger.commit(replied.requestId, "trigger");
    clock.advance(TIMEOUT_MS + LATE_GRACE_MS - 1);
    ledger.sweep();
    expect(ledger.get(replied.requestId)!.state).toBe("replied"); // before lateUntil: kept
    clock.advance(1);
    expect(ledger.sweep().deleted).toBe(1);
    expect(ledger.get(replied.requestId)).toBeUndefined();

    const failed = issueTicket(ledger, { replier: "C" });
    ledger.recordSend(failed.requestId, "none");
    expect(ledger.sweep().deleted).toBe(1); // send_failed deletes on the very next sweep
    expect(ledger.get(failed.requestId)).toBeUndefined();
  });
});

describe("xs reply ledger — quota, capacity, sweep scope", () => {
  it("per-target quota counts receivable and consuming tickets only", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    ledger.bindSession({ sessionId: "A", inbox: createXsReplyInboxPort(new XsInbox(8)) });
    issueTicket(ledger, { replier: "B", maxPendingPerTarget: 2 });
    const t2 = issueTicket(ledger, { replier: "B", maxPendingPerTarget: 2 });
    ledger.reserve(t2.requestId, "x1"); // consuming still counts
    expect(
      ledger.issue({
        requesterSessionId: "A",
        replierSessionId: "B",
        replierRef: "B",
        origin: "model",
        wakeOnReply: true,
        requesterLevel: 1,
        timeoutMs: TIMEOUT_MS,
        lateGraceMs: LATE_GRACE_MS,
        maxPending: 8,
        maxPendingPerTarget: 2,
      }),
    ).toEqual({ ok: false, code: "reply_quota", perTarget: true });
    ledger.commit(t2.requestId, "trigger"); // tombstone frees the per-target quota
    const t3 = issueTicket(ledger, { replier: "B", maxPendingPerTarget: 2 });
    expect(ledger.get(t3.requestId)!.state).toBe("pending");
  });

  it("replyInbox occupancy counts into maxPending (the §6.4 issuance invariant)", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    const inbox = new XsInbox(8);
    ledger.bindSession({ sessionId: "A", inbox: createXsReplyInboxPort(inbox) });
    issueTicket(ledger, { maxPending: 2 }); // ticket 1
    issueTicket(ledger, { replier: "C", maxPending: 2 }); // ticket 2 — quota full now
    const third = ledger.issue({
      requesterSessionId: "A",
      replierSessionId: "D",
      replierRef: "D",
      origin: "model",
      wakeOnReply: true,
      requesterLevel: 1,
      timeoutMs: TIMEOUT_MS,
      lateGraceMs: LATE_GRACE_MS,
      maxPending: 2,
      maxPendingPerTarget: 3,
    });
    expect(third).toEqual({ ok: false, code: "reply_quota" });
    inbox.accept("outside", "appended"); // simulate an unreleased reply already in context accounting
    expect(ledger.stats("A").inbox).toBe(1);
  });

  it("process slots cap at 64: refuse after one sweep, never evict; sweep self-heals", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    const tryIssue = (session: string, replier: string) =>
      ledger.issue({
        requesterSessionId: session,
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
    let issued = 0;
    // 9 sessions × 8 tickets = 72 attempts > 64 slots: cross-session slot pressure
    for (let i = 0; i < 9; i++) {
      for (let j = 0; j < 8; j++) if (tryIssue(`S${i}`, `R${i}-${j}`).ok) issued += 1;
    }
    expect(issued).toBe(64);
    expect(ledger.size).toBe(64);
    expect(tryIssue("S8", "fresh")).toEqual({ ok: false, code: "reply_ledger_full" });
    // every entry intact — full means refuse, never evict
    expect(ledger.size).toBe(64);
    clock.advance(TIMEOUT_MS + LATE_GRACE_MS + 1); // everything expires
    const healed = tryIssue("S8", "fresh2");
    expect(healed.ok).toBe(true);
    expect(ledger.size).toBe(1);
  });

  it("sweep is process-wide: a switched-away session's tickets still time out and drop", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    const mine = issueTicket(ledger, { requester: "A" });
    const away = issueTicket(ledger, { requester: "OTHER" });
    clock.advance(TIMEOUT_MS);
    const swept = ledger.sweep(); // triggered by ANY session's activity
    expect(swept.timedOut.sort()).toEqual([away.requestId, mine.requestId].sort());
    expect(ledger.owedNotices("OTHER")).toHaveLength(1);
    clock.advance(LATE_GRACE_MS);
    ledger.sweep();
    expect(ledger.droppedNoticeCount("OTHER")).toBe(1);
    expect(ledger.droppedNoticeCount("A")).toBe(1);
  });

  it("droppedNotices per-session map is FIFO-capped at 32 sessions", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    for (let i = 0; i < 33; i++) {
      const ticket = issueTicket(ledger, { requester: `S${i}`, replier: `R${i}` });
      clock.advance(TIMEOUT_MS + LATE_GRACE_MS + 1);
      ledger.sweep();
      expect(ledger.get(ticket.requestId)).toBeUndefined();
    }
    expect(ledger.droppedNoticeCount("S0")).toBe(0); // evicted from the FIFO
    expect(ledger.droppedNoticeCount("S32")).toBe(1);
  });
});

describe("xs reply ledger — r2 Blocker counterexamples (fail closed, always refuse)", () => {
  it("branch rollback: consumption on branch X, back to branch Y, duplicate reply ⇒ refused (no branch awareness at all)", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    ledger.bindSession({ sessionId: "A", inbox: createXsReplyInboxPort(new XsInbox(8)) });
    const ticket = issueTicket(ledger);
    // "branch X": consume
    ledger.reserve(ticket.requestId, "x-1");
    ledger.commit(ticket.requestId, "trigger");
    // "/tree back to branch Y": the ledger is process memory — nothing branch-shaped exists to
    // rewind. The tombstone is authoritative regardless of any missing settle record on Y.
    expect(ledger.classify(ticket.requestId, "B", "A")).toMatchObject({ kind: "invalid", reason: "state" });
    expect(ledger.get(ticket.requestId)!.state).toBe("replied");
  });

  it("tombstone eviction revival: after lateUntil deletion the id is simply unknown ⇒ refused", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    ledger.bindSession({ sessionId: "A", inbox: createXsReplyInboxPort(new XsInbox(8)) });
    const ticket = issueTicket(ledger);
    ledger.reserve(ticket.requestId, "x1");
    ledger.commit(ticket.requestId, "trigger");
    clock.advance(TIMEOUT_MS + LATE_GRACE_MS + 1);
    ledger.sweep();
    expect(ledger.classify(ticket.requestId, "B", "A")).toMatchObject({ kind: "invalid", reason: "unknown_id" });
  });

  it("process restart: empty ledger refuses every old id and the §3.3 scan yields ONE invalidation notice", () => {
    const clock = new FakeClock();
    const first = mkLedger(clock);
    const issues: XsReplyIssueEntry[] = [];
    first.bindSession({
      sessionId: "A",
      appendIssue: (entry) => issues.push(entry),
    });
    const ticket = issueTicket(first); // persisted on the branch…
    expect(issues).toHaveLength(1);
    const now = ticket.issuedAt + 1_000;
    // …but the process died. Fresh ledger (empty process memory):
    const restarted = new XsReplyLedger({ clock, newRequestId: seqIds() });
    expect(restarted.classify(ticket.requestId, "B", "A")).toMatchObject({ kind: "invalid", reason: "unknown_id" });
    const records = [
      ...issues,
      ...([] as XsReplySettleEntry[]), // branch has no settle for it
    ].flatMap((entry) => (parseXsReplyEntry(entry, "A") ? [parseXsReplyEntry(entry, "A")!] : []));
    const plan = planReplyRestartInvalidation(records, restarted, now);
    expect(plan.invalid).toEqual([{ requestId: ticket.requestId, replierRef: "B", dueAt: ticket.dueAt }]);
    expect(plan.more).toBe(0);
    expect(plan.settles).toEqual([buildReplySettleEntry(ticket.requestId, "A", "invalidated")]);
    // once per (process, session)
    expect(restarted.markRestartScanned("A")).toBe(true);
    expect(restarted.markRestartScanned("A")).toBe(false);
  });

  it("appendEntry failure: receivability unaffected; the restart notice is simply missing", () => {
    const clock = new FakeClock();
    const ledger = new XsReplyLedger({
      clock,
      newRequestId: seqIds(),
    });
    ledger.bindSession({
      sessionId: "A",
      appendIssue: () => {
        throw new Error("disk full");
      },
      appendSettle: () => {
        throw new Error("disk full");
      },
    });
    const ticket = issueTicket(ledger); // must NOT throw
    expect(ledger.get(ticket.requestId)!.state).toBe("pending");
    ledger.bindSession({ sessionId: "A", inbox: createXsReplyInboxPort(new XsInbox(8)) });
    expect(ledger.reserve(ticket.requestId, "x1")).toEqual({ ok: true });
    ledger.commit(ticket.requestId, "trigger"); // settle sink failure swallowed
    expect(ledger.get(ticket.requestId)!.state).toBe("replied");
    // restart scan sees no records ⇒ no notice (RR1's accepted gap, disclosed in copy)
    expect(planReplyRestartInvalidation([], new XsReplyLedger({ clock, newRequestId: seqIds() }), 1)).toEqual({
      invalid: [],
      more: 0,
      settles: [],
    });
  });

  it("wrong replier / not requester / consuming / unsolicited classification (§3.2)", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    ledger.bindSession({ sessionId: "A", inbox: createXsReplyInboxPort(new XsInbox(8)) });
    const ticket = issueTicket(ledger);
    expect(ledger.classify(undefined, "B", "A")).toEqual({ kind: "unsolicited" });
    expect(ledger.classify(ticket.requestId, "C", "A")).toMatchObject({ kind: "invalid", reason: "wrong_replier" });
    expect(ledger.classify(ticket.requestId, undefined, "A")).toMatchObject({
      kind: "invalid",
      reason: "wrong_replier",
    });
    expect(ledger.classify(ticket.requestId, "B", "SOMEONE-ELSE")).toMatchObject({
      kind: "invalid",
      reason: "not_requester",
    });
    expect(ledger.stats("A").rejected).toBe(2); // the two wrong-replier verdicts classed as A
    expect(ledger.stats("SOMEONE-ELSE").rejected).toBe(1); // counted under the classifying stack
  });
});

describe("xs reply ledger — replyInbox pre-occupy protocol (§6.3/§6.4)", () => {
  it("reserve refuses (inbox_full, anomaly counted, ticket untouched) when the inbox is full", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    const inbox = new XsInbox(1);
    ledger.bindSession({ sessionId: "A", inbox: createXsReplyInboxPort(inbox) });
    const ticket = issueTicket(ledger);
    inbox.accept("someone-else", "appended"); // cap 1 already occupied
    expect(ledger.reserve(ticket.requestId, "x1")).toEqual({ ok: false, reason: "inbox_full" });
    expect(ledger.get(ticket.requestId)!.state).toBe("pending");
    expect(ledger.replyInboxAnomaly).toBe(1);
    expect(ledger.classify(ticket.requestId, "B", "A")).toMatchObject({ kind: "reply" }); // still receivable
  });

  it("commit settles the reservation into the inbox with the dispatch mode; release frees it", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    const inbox = new XsInbox(8);
    const port = createXsReplyInboxPort(inbox);
    ledger.bindSession({ sessionId: "A", inbox: port });
    const ticket = issueTicket(ledger);
    ledger.reserve(ticket.requestId, "x-reply");
    expect(port.occupied()).toBe(0); // reservation is not an entry: no double counting
    expect(port.free()).toBe(7);
    ledger.commit(ticket.requestId, "trigger");
    expect(port.occupied()).toBe(1);
    expect(inbox.snapshot()[0]).toMatchObject({ xid: "x-reply", mode: "trigger" });
    const second = issueTicket(ledger, { replier: "C" });
    ledger.reserve(second.requestId, "x2");
    ledger.release(second.requestId);
    expect(port.occupied()).toBe(1);
    expect(port.free()).toBe(7);
  });

  it("release past dueAt lands as timed_out (owed notice), past lateUntil deletes with dropped count", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    ledger.bindSession({ sessionId: "A", inbox: createXsReplyInboxPort(new XsInbox(8)) });
    const ticket = issueTicket(ledger);
    clock.advance(TIMEOUT_MS / 2);
    ledger.reserve(ticket.requestId, "x1");
    clock.advance(TIMEOUT_MS); // now past dueAt, inside grace
    ledger.release(ticket.requestId);
    expect(ledger.get(ticket.requestId)).toMatchObject({ state: "timed_out", noticeOwed: "timeout" });
    expect(ledger.owedNotices("A")).toHaveLength(1);

    const doomed = issueTicket(ledger, { replier: "C" });
    ledger.reserve(doomed.requestId, "x2");
    clock.advance(700_000); // past doomed's lateUntil (due + grace from its issue time)
    ledger.release(doomed.requestId);
    expect(ledger.get(doomed.requestId)).toBeUndefined();
    expect(ledger.droppedNoticeCount("A")).toBe(1);
  });
});

describe("xs reply ledger — delivered timeout notice is never re-owed (RX1 nit)", () => {
  it("clearOwed then reserve→release on a timed_out ticket does not owe the notice again", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    ledger.bindSession({ sessionId: "A", inbox: createXsReplyInboxPort(new XsInbox(8)) });
    const ticket = issueTicket(ledger);
    clock.advance(TIMEOUT_MS + 1);
    ledger.sweep();
    expect(ledger.owedNotices("A")).toHaveLength(1);
    ledger.clearOwed([ticket.requestId]); // the notice was delivered
    expect(ledger.reserve(ticket.requestId, "x1")).toEqual({ ok: true });
    ledger.release(ticket.requestId);
    expect(ledger.get(ticket.requestId)).toMatchObject({ state: "timed_out" });
    expect(ledger.owedNotices("A")).toHaveLength(0);
    // …and a release past lateUntil drops silently (no dropped-notice count for a delivered notice)
    ledger.reserve(ticket.requestId, "x2");
    clock.advance(LATE_GRACE_MS + 1);
    ledger.release(ticket.requestId);
    expect(ledger.get(ticket.requestId)).toBeUndefined();
    expect(ledger.droppedNoticeCount("A")).toBe(0);
  });
});

describe("xs reply ledger — session entries (§3.3)", () => {
  it("parseXsReplyEntry: tolerant, fork-filtered, shape-checked", () => {
    const good: XsReplyIssueEntry = {
      v: 1,
      op: "issue",
      requestId: "q000000000000000001",
      requesterSessionId: "A",
      replierRef: "B",
      dueAt: 5,
      lateUntil: 6,
    };
    expect(parseXsReplyEntry(good, "A")).toEqual(good);
    expect(parseXsReplyEntry(good, "FORK")).toBeUndefined(); // P10: fork/copy records ignored
    expect(parseXsReplyEntry({ ...good, v: 2 }, "A")).toBeUndefined();
    expect(parseXsReplyEntry({ ...good, requestId: "nope" }, "A")).toBeUndefined();
    expect(parseXsReplyEntry({ ...good, dueAt: "soon" }, "A")).toBeUndefined();
    expect(parseXsReplyEntry(null, "A")).toBeUndefined();
    const settle = buildReplySettleEntry("q000000000000000001", "A", "invalidated");
    expect(parseXsReplyEntry(settle, "A")).toEqual(settle);
    expect(parseXsReplyEntry({ ...settle, state: "weird" }, "A")).toBeUndefined();
  });

  it("restart plan: skips settled / live / expired-listing; caps at 16 with 「另有 N 条」; settles everything unmatched", () => {
    const clock = new FakeClock(1000);
    const ledger = mkLedger(clock);
    // one ticket still LIVE in this process (e.g. re-issued after restart) — untouched
    const live = issueTicket(ledger);
    const records: (XsReplyIssueEntry | XsReplySettleEntry)[] = [buildReplyIssueEntry(live)];
    const hexId = (n: number) => `q${n.toString(16).padStart(18, "0")}`;
    for (let i = 0; i < 20; i++) {
      records.push({
        v: 1,
        op: "issue",
        requestId: hexId(0x1000 + i),
        requesterSessionId: "A",
        replierRef: `R${i}`,
        dueAt: 2_000,
        lateUntil: 60_000,
      });
    }
    // one of them was properly settled before the crash
    records.push(buildReplySettleEntry(hexId(0x1004), "A", "replied"));
    // one expired long before the restart (lateUntil passed) — listed nowhere, still settled
    records.push({
      v: 1,
      op: "issue",
      requestId: "qffffffffffffffffff",
      requesterSessionId: "A",
      replierRef: "OLD",
      dueAt: 1,
      lateUntil: 1,
    });
    const plan = planReplyRestartInvalidation(
      records.flatMap((entry) => {
        const parsed = parseXsReplyEntry(entry, "A");
        return parsed ? [parsed] : [];
      }),
      ledger,
      2_000,
    );
    expect(plan.invalid).toHaveLength(16);
    expect(plan.more).toBe(3); // 19 unsettled unexpired − 16 listed
    expect(plan.settles).toHaveLength(20); // 19 unexpired + the expired one; `live` skipped
    expect(plan.invalid.every((item) => item.requestId !== hexId(0x1004))).toBe(true);
    expect(plan.settles).toContainEqual(buildReplySettleEntry("qffffffffffffffffff", "A", "invalidated"));
    expect(plan.settles.find((entry) => entry.requestId === live.requestId)).toBeUndefined();
  });

  it("issue/settle sinks receive well-formed entries on the happy path", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    const issues: XsReplyIssueEntry[] = [];
    const settles: XsReplySettleEntry[] = [];
    ledger.bindSession({
      sessionId: "A",
      inbox: createXsReplyInboxPort(new XsInbox(8)),
      appendIssue: (entry) => issues.push(entry),
      appendSettle: (entry) => settles.push(entry),
    });
    const ticket = issueTicket(ledger);
    expect(issues).toEqual([buildReplyIssueEntry(ticket)]);
    ledger.reserve(ticket.requestId, "x1");
    ledger.commit(ticket.requestId, "queued");
    expect(settles).toEqual([buildReplySettleEntry(ticket.requestId, "A", "replied")]);
    const failed = issueTicket(ledger, { replier: "C" });
    ledger.recordSend(failed.requestId, "none");
    expect(settles[1]).toEqual(buildReplySettleEntry(failed.requestId, "A", "send_failed"));
  });
});

describe("xs reply ledger — process accessor and visibility", () => {
  it("getXsReplyLedger returns the SAME object across calls (survives /reload by contract)", () => {
    const a = getXsReplyLedger();
    const b = getXsReplyLedger();
    expect(a).toBe(b);
  });

  it("stats and repliesView reflect the §8.3 numbers", () => {
    const clock = new FakeClock(5_000);
    const ledger = mkLedger(clock);
    const inbox = new XsInbox(8);
    ledger.bindSession({ sessionId: "A", inbox: createXsReplyInboxPort(inbox) });
    const t1 = issueTicket(ledger);
    const t2 = issueTicket(ledger, { replier: "C" });
    clock.advance(TIMEOUT_MS);
    ledger.sweep(); // t1 + t2 now timed_out (both owe a notice)
    const t3 = issueTicket(ledger, { replier: "D" });
    inbox.accept("x", "appended");
    const stats = ledger.stats("A");
    expect(stats).toMatchObject({
      pending: 3, // receivable-or-consuming: both timed_out + t3 (the `a` of a/maxPending)
      inbox: 1,
      timedOut: 2,
      owed: 2,
      dropped: 0,
      ledger: { size: 3, capacity: 64 },
      replyInboxAnomaly: 0,
    });
    const rows = ledger.repliesView("A").sort((a, b) => a.requestId.localeCompare(b.requestId));
    expect(rows).toHaveLength(3);
    const t3row = rows.find((row) => row.requestId === t3.requestId)!;
    expect(t3row.state).toBe("pending");
    expect(t3row.remainingS).toBeGreaterThan(0);
    expect(rows.find((row) => row.requestId === t1.requestId)).toMatchObject({ state: "timed_out", owed: true });
    expect(rows.find((row) => row.requestId === t2.requestId)).toMatchObject({ state: "timed_out", owed: true });
  });

  it("takeDroppedNotices reads and resets the counter (§3.4 switch-back summary)", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    const ticket = issueTicket(ledger);
    clock.advance(TIMEOUT_MS + LATE_GRACE_MS + 1);
    ledger.sweep();
    expect(ledger.takeDroppedNotices("A")).toBe(1);
    expect(ledger.takeDroppedNotices("A")).toBe(0);
    void ticket;
  });
});

describe("xs reply modules stay pi-free (reply-plan §12.1 source-scan gate)", () => {
  it("reply-ledger.ts and reply-notice.ts import no pi / peer modules", () => {
    const root = fileURLToPath(new URL("../../src/fabric/xs/", import.meta.url));
    for (const name of ["reply-ledger.ts", "reply-notice.ts"]) {
      const source = readFileSync(`${root}${name}`, "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);
      expect(imports.length).toBeGreaterThan(0);
      for (const specifier of imports) {
        const banned = /@earendil-works|^pi(\/|$)|pi-coding-agent|pi-tui|pi-ai/;
        expect({ file: name, specifier, banned: banned.test(specifier) }).toEqual({
          file: name,
          specifier,
          banned: false,
        });
      }
    }
  });
});

describe("xs reply due scheduler (§7.2)", () => {
  it("arms exactly one timer at the session's earliest pending dueAt; fires sweep + onDue; re-arms", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    let fires = 0;
    const scheduler = new XsReplyDueScheduler({
      ledger,
      sessionId: "A",
      clock,
      onDue: () => {
        fires += 1;
      },
    });
    const far = issueTicket(ledger, { timeoutMs: 300_000 });
    scheduler.refresh();
    expect(scheduler.nextDueAt()).toBe(far.dueAt);
    const near = issueTicket(ledger, { replier: "C", timeoutMs: 60_000 });
    scheduler.refresh(); // earlier due must REPLACE the armed timer (absolute, never postponed)
    expect(scheduler.nextDueAt()).toBe(near.dueAt);
    clock.advance(60_000); // fires at near.dueAt
    expect(fires).toBe(1);
    expect(ledger.get(near.requestId)!.state).toBe("timed_out"); // sweep ran BEFORE onDue
    expect(ledger.get(far.requestId)!.state).toBe("pending");
    clock.advance(240_000); // far's dueAt — re-armed by the fire handler
    expect(fires).toBe(2);
    expect(ledger.get(far.requestId)!.state).toBe("timed_out");
    scheduler.dispose();
  });

  it("only THIS session's tickets arm the timer; dispose cancels; refresh with nothing disarms", () => {
    const clock = new FakeClock();
    const ledger = mkLedger(clock);
    let fires = 0;
    const scheduler = new XsReplyDueScheduler({
      ledger,
      sessionId: "A",
      clock,
      onDue: () => {
        fires += 1;
      },
    });
    issueTicket(ledger, { requester: "OTHER" });
    scheduler.refresh();
    expect(scheduler.nextDueAt()).toBeUndefined();
    expect(clock.pendingTimers).toBe(0);
    const mine = issueTicket(ledger);
    scheduler.refresh();
    expect(clock.pendingTimers).toBe(1);
    scheduler.dispose();
    expect(clock.pendingTimers).toBe(0);
    clock.advance(10 * TIMEOUT_MS);
    expect(fires).toBe(0);
    void mine;
  });
});
