/** F1 §7.1/§7.3: pushScheduleReport, receipts, settle write-back, restart reconcile, budgets, notices. */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  SCHEDULE_REPORT_GLOBAL_PER_HOUR,
  SCHEDULE_REPORT_TASK_PER_HOUR,
  SCHEDULE_NOTICE_GLOBAL_PER_HOUR,
  createFeishuSchedule,
  scheduleRequestId,
  type FeishuScheduleDeps,
  type ScheduleReportOffer,
} from "../../../../src/web-hub/hub/feishu/schedule.js";
import { createNoticeBudget } from "../../../../src/web-hub/hub/feishu/security.js";
import type {
  EnqueueFinalInput,
  EnqueueNoticeInput,
  EnqueueResult,
  SettledGroup,
} from "../../../../src/web-hub/hub/feishu/outbox.js";
import type { FeishuScheduleReceipt, ScheduleReceiptState } from "../../../../src/web-hub/hub/feishu/state.js";
import { createFakeClock } from "../../../fixtures/feishu/fake-http.js";

const H = (n: string | number) => createHash("sha256").update(String(n)).digest("hex");
const SID = "019a0000-aaaa-7bbb-8ccc-dddddddddddd";
const T0 = 1_760_000_000_000;

function rig(over: Partial<FeishuScheduleDeps> = {}) {
  const clock = createFakeClock(T0);
  const receipts = new Map<string, FeishuScheduleReceipt>();
  const outboxParts: Array<{ requestId?: string; kind: string }> = [];
  const finals: EnqueueFinalInput[] = [];
  const notices: EnqueueNoticeInput[] = [];
  const changed: Array<[string, Array<{ reportId: string; state: string; code?: string }>]> = [];
  const counts: Record<string, number> = {};
  let nextFinal: EnqueueResult = { ok: true, sendIds: ["a"], durable: true, duplicate: false };
  const state = {
    scheduleReceipts: {
      get: (id: string) => receipts.get(id),
      set(id: string, i: { sid: string; state: ScheduleReceiptState; code?: string }) {
        const rec: FeishuScheduleReceipt = { ...i, at: clock.now() };
        receipts.set(id, rec);
        return { ok: true as const, value: rec };
      },
      list: (f?: { sid?: string }) =>
        [...receipts]
          .filter(([, v]) => f?.sid === undefined || v.sid === f.sid)
          .map(([reportId, v]) => ({ reportId, ...v })),
      get size() {
        return receipts.size;
      },
    },
    outbox: {
      list: () => outboxParts,
      get size() {
        return outboxParts.length;
      },
    },
    usage: () => ({ bytes: 1_000, budget: 4 * 1024 * 1024, reserve: 32_768 }),
    commit: vi.fn(async () => true),
  };
  const deps: FeishuScheduleDeps = {
    state,
    now: clock.now,
    owner: () => "ou_owner0123456789",
    installedAt: () => T0 - 3_600_000,
    ready: () => true,
    budget: createNoticeBudget(clock),
    outbox: {
      enqueueFinal: async (i) => {
        finals.push(i);
        if (nextFinal.ok) outboxParts.push({ requestId: i.requestId, kind: "final" });
        return nextFinal;
      },
      enqueueNotice: async (i) => {
        notices.push(i);
        return { ok: true, sendIds: ["n"], durable: true, duplicate: false };
      },
    },
    workSize: () => 0,
    count: (r) => {
      counts[r] = (counts[r] ?? 0) + 1;
    },
    onReceipts: (sid, rows) => changed.push([sid, rows]),
    ...over,
  };
  const sch = createFeishuSchedule(deps);
  const offer = (n: number | string, o: Partial<ScheduleReportOffer> = {}): ScheduleReportOffer => ({
    sessionId: SID,
    sessionLabel: "api · 019a00",
    reportId: H(n),
    runKey: `s_abcd2345@${n}`,
    taskId: "s_abcd2345",
    taskName: "日报",
    status: "completed",
    endedAt: T0 - 1_000,
    expiresAt: T0 + 86_400_000,
    read: () => "# 报告\n\n正文 <b>x</b>",
    ...o,
  });
  return {
    sch,
    clock,
    receipts,
    finals,
    notices,
    changed,
    counts,
    state,
    outboxParts,
    setFinal: (r: EnqueueResult) => (nextFinal = r),
    deps,
    offer,
  };
}

describe("pushScheduleReport", () => {
  it("accepts once: receipt written before enqueue, `sch:` request id, owner p2p target, sched_receipts pushed", async () => {
    const r = rig();
    let receiptAtEnqueue: string | undefined;
    const orig = r.deps.outbox.enqueueFinal;
    r.deps.outbox.enqueueFinal = async (i) => {
      receiptAtEnqueue = r.receipts.get(H(1))?.state;
      return orig(i);
    };
    const res = await r.sch.pushReport(r.offer(1));
    expect(res).toEqual({ reportId: H(1), outcome: "queued" });
    expect(receiptAtEnqueue).toBe("accepted");
    expect(r.finals).toHaveLength(1);
    expect(r.finals[0]!.requestId).toBe(scheduleRequestId(H(1)));
    expect(r.finals[0]!.requestId).toBe(`sch:${H(1)}`);
    expect(r.finals[0]!.target).toEqual({
      scope: "p2p",
      via: "send",
      receiveIdType: "open_id",
      receiveId: "ou_owner0123456789",
    });
    expect(r.finals[0]!.messages[0]!.content).toContain("日报");
    expect(r.changed).toEqual([[SID, [{ reportId: H(1), state: "accepted" }]]]);
    // second offer of the same report never enqueues again
    expect(await r.sch.pushReport(r.offer(1))).toEqual({ reportId: H(1), outcome: "skipped" });
    expect(r.finals).toHaveLength(1);
  });

  it("concurrent offers of one report enqueue at most once", async () => {
    const r = rig();
    const [a, b] = await Promise.all([r.sch.pushReport(r.offer(1)), r.sch.pushReport(r.offer(1))]);
    expect(r.finals).toHaveLength(1);
    expect([a.outcome, b.outcome].sort()).toEqual(["queued", "skipped"]);
  });

  it("never-installed bot ⇒ n/a with no receipt; report older than the install ⇒ n/a", async () => {
    const a = rig({ installedAt: () => undefined });
    expect((await a.sch.pushReport(a.offer(1))).outcome).toBe("n/a");
    expect(a.receipts.size).toBe(0);
    const b = rig();
    expect((await b.sch.pushReport(b.offer(1, { endedAt: T0 - 7_200_000 }))).outcome).toBe("n/a");
    expect(b.receipts.size).toBe(0);
    expect(b.finals).toHaveLength(0);
  });

  it("disconnected ⇒ waiting (no receipt, retried later); past expiresAt ⇒ expired", async () => {
    let ready = false;
    const r = rig({ ready: () => ready });
    expect((await r.sch.pushReport(r.offer(1))).outcome).toBe("waiting");
    expect(r.receipts.size).toBe(0);
    ready = true;
    expect((await r.sch.pushReport(r.offer(1, { expiresAt: T0 - 1 }))).outcome).toBe("expired");
    expect(r.receipts.size).toBe(0);
    expect((await r.sch.pushReport(r.offer(1))).outcome).toBe("queued");
  });

  it("outbox refusal ⇒ refused(outbox-<code>) receipt, never retried", async () => {
    const r = rig();
    r.setFinal({ ok: false, refused: "cap" });
    expect((await r.sch.pushReport(r.offer(1))).outcome).toBe("refused");
    expect(r.receipts.get(H(1))).toMatchObject({ state: "refused", code: "outbox-cap" });
    expect(await r.sch.pushReport(r.offer(1))).toEqual({ reportId: H(1), outcome: "skipped" });
    expect(r.changed.at(-1)![1]).toEqual([{ reportId: H(1), state: "refused", code: "outbox-cap" }]);
  });

  it("an unreadable report file ⇒ refused(file) (no retry loop)", async () => {
    const r = rig();
    expect((await r.sch.pushReport(r.offer(1, { read: () => undefined }))).outcome).toBe("refused");
    expect(r.receipts.get(H(1))).toMatchObject({ state: "refused", code: "file" });
    expect(r.finals).toHaveLength(0);
  });

  it("per-task hourly budget refuses the 7th report, counted, and folds into the next notice", async () => {
    const r = rig();
    for (let i = 0; i < SCHEDULE_REPORT_TASK_PER_HOUR; i++)
      expect((await r.sch.pushReport(r.offer(i))).outcome).toBe("queued");
    const over = await r.sch.pushReport(r.offer(99));
    expect(over.outcome).toBe("refused");
    expect(r.receipts.get(H(99))).toMatchObject({ state: "refused", code: "budget" });
    expect(r.counts["sched-budget"]).toBe(1);
    expect(r.finals).toHaveLength(SCHEDULE_REPORT_TASK_PER_HOUR);
    const n = await r.sch.pushNotice({
      key: "k1",
      sessionId: SID,
      sessionLabel: "api",
      taskId: "s_abcd2345",
      taskName: "日报",
      kind: "missed",
      count: 2,
    });
    expect(n.outcome).toBe("queued");
    expect(JSON.stringify(r.notices[0]!.message)).toContain("另有 1 份报告未推送");
    // next hour: budget resets
    r.clock.advance(3_600_000);
    expect((await r.sch.pushReport(r.offer(100))).outcome).toBe("queued");
  });

  it("global hourly budget caps reports across tasks", async () => {
    const r = rig();
    let queued = 0;
    for (let i = 0; i < SCHEDULE_REPORT_GLOBAL_PER_HOUR + 5; i++) {
      const res = await r.sch.pushReport(
        r.offer(i, { taskId: `s_${String.fromCharCode(97 + (i % 26))}bcd2345`, runKey: `s_x@${i}` }),
      );
      if (res.outcome === "queued") queued++;
    }
    expect(queued).toBe(SCHEDULE_REPORT_GLOBAL_PER_HOUR);
  });

  it("headroom: outbox ≥50% full, or state nearly full, or work lane busy ⇒ refused(headroom)", async () => {
    const parts = Array.from({ length: 300 }, () => ({ kind: "final" }));
    const a = rig();
    a.outboxParts.push(...parts);
    expect((await a.sch.pushReport(a.offer(1))).outcome).toBe("refused");
    expect(a.receipts.get(H(1))).toMatchObject({ state: "refused", code: "headroom" });
    const b = rig();
    b.state.usage = () => ({ bytes: 4 * 1024 * 1024 - 400_000, budget: 4 * 1024 * 1024, reserve: 32_768 });
    expect((await b.sch.pushReport(b.offer(1))).outcome).toBe("refused");
    const c = rig({ workSize: () => 250 });
    expect((await c.sch.pushReport(c.offer(1))).outcome).toBe("refused");
  });

  it("receipt table full ⇒ not delivered, counted `sched-receipt-cap`, no receipt", async () => {
    const r = rig();
    r.state.scheduleReceipts.set = () => ({ ok: false, refused: "cap" }) as never;
    expect((await r.sch.pushReport(r.offer(1))).outcome).toBe("refused");
    expect(r.counts["sched-receipt-cap"]).toBe(1);
    expect(r.finals).toHaveLength(0);
  });

  it("card is rendered safely: markdown neutralized, label bounded, failed status ⇒ failed card", async () => {
    const r = rig();
    await r.sch.pushReport(
      r.offer(1, {
        status: "aborted",
        taskName: "x".repeat(200),
        read: () => "[click](javascript:alert(1)) <at id=all></at>",
      }),
    );
    const content = r.finals[0]!.messages[0]!.content;
    expect(content).not.toContain("](javascript:");
    expect(content).not.toContain("<at id=all>");
    expect(content).toContain("已中止");
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(20_000);
  });

  it("long reports overflow to an md attachment (single-flight upload); upload failure truncates", async () => {
    const big = "段落\n\n".repeat(30_000);
    let inflight = 0,
      max = 0;
    const upload = vi.fn(async () => {
      inflight++;
      max = Math.max(max, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return { ok: true as const, fileKey: "fk" };
    });
    const r = rig({ upload });
    await Promise.all([
      r.sch.pushReport(r.offer(1, { read: () => big })),
      r.sch.pushReport(r.offer(2, { read: () => big })),
    ]);
    expect(max).toBe(1);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(r.finals[0]!.messages.some((m) => m.msgType === "file")).toBe(true);
    const f = rig({ upload: async () => ({ ok: false as const }) });
    await f.sch.pushReport(f.offer(1, { read: () => big }));
    expect(f.finals[0]!.messages.every((m) => m.msgType === "interactive")).toBe(true);
  });
});

describe("settle write-back and restart reconcile", () => {
  const group = (id: string, over: Partial<SettledGroup> = {}): SettledGroup =>
    ({
      kind: "final",
      requestId: scheduleRequestId(id),
      outcome: "delivered",
      replyFailed: false,
      target: { route: "send", targetId: "x" },
      parts: [],
      recovered: false,
      ...over,
    }) as SettledGroup;

  it("delivered ⇒ sent; failed ⇒ failed(code); partial / expired-uncertain ⇒ uncertain; each pushes receipts", async () => {
    const r = rig();
    for (const n of [1, 2, 3, 4]) await r.sch.pushReport(r.offer(n));
    expect(await r.sch.settled(group(H(1)))).toBe(true);
    await r.sch.settled(group(H(2), { outcome: "failed", replyFailed: true, code: "target-gone" }));
    await r.sch.settled(group(H(3), { outcome: "partial", replyFailed: true, code: "rejected:api-code-1" }));
    await r.sch.settled(group(H(4), { outcome: "failed", replyFailed: true, code: "expired-uncertain" }));
    expect(r.receipts.get(H(1))!.state).toBe("sent");
    expect(r.receipts.get(H(2))).toMatchObject({ state: "failed", code: "target-gone" });
    expect(r.receipts.get(H(3))!.state).toBe("uncertain");
    expect(r.receipts.get(H(4))!.state).toBe("uncertain");
    expect(r.changed.at(-1)![1][0]!.state).toBe("uncertain");
  });

  it("a non-schedule group is not claimed; an unknown report id is claimed and ignored", async () => {
    const r = rig();
    expect(await r.sch.settled({ ...group(H(1)), requestId: "fsabc" })).toBe(false);
    expect(await r.sch.settled(group(H(1)))).toBe(true);
    expect(r.receipts.size).toBe(0);
  });

  it("a settle whose commit fails throws so the outbox re-invokes it", async () => {
    const r = rig();
    await r.sch.pushReport(r.offer(1));
    r.state.commit.mockResolvedValueOnce(false);
    await expect(r.sch.settled(group(H(1)))).rejects.toThrow("persist-failed");
  });

  it("reconcile: accepted receipts without an outbox group become uncertain; covered ones stay", async () => {
    const r = rig();
    await r.sch.pushReport(r.offer(1));
    await r.sch.pushReport(r.offer(2));
    r.outboxParts.length = 0;
    r.outboxParts.push({ requestId: scheduleRequestId(H(2)), kind: "final" });
    await r.sch.reconcile();
    expect(r.receipts.get(H(1))!.state).toBe("uncertain");
    expect(r.receipts.get(H(2))!.state).toBe("accepted");
    expect(r.changed.at(-1)![1].map((x) => x.reportId)).toEqual([H(1)]);
  });
});

describe("pushNotice (missed / unknown)", () => {
  const base = { sessionId: SID, sessionLabel: "api", taskId: "s_abcd2345", taskName: "日报" };
  it("is at-most-once, owner p2p, `schm:`-style stable key, schedule lane", async () => {
    const r = rig();
    const res = await r.sch.pushNotice({ ...base, key: "missed:1", kind: "missed", count: 3 });
    expect(res.outcome).toBe("queued");
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]!.key).toMatch(/^schm:[A-Za-z0-9_-]{24}$/);
    expect(r.notices[0]!.target).toEqual({
      scope: "p2p",
      via: "send",
      receiveIdType: "open_id",
      receiveId: "ou_owner0123456789",
    });
    expect(JSON.stringify(r.notices[0]!.message)).toContain("3");
  });

  it("per-task one notice per clock hour; global ≤30/h; schedule lane keeps critical reserve", async () => {
    const r = rig();
    expect((await r.sch.pushNotice({ ...base, key: "a", kind: "missed", count: 1 })).outcome).toBe("queued");
    expect((await r.sch.pushNotice({ ...base, key: "b", kind: "missed", count: 1 })).outcome).toBe("refused");
    expect(r.counts["sched-notice-task-hour"]).toBe(1);
    let ok = 0;
    for (let i = 0; i < 40; i++) {
      const res = await r.sch.pushNotice({ ...base, taskId: `t${i}`, key: `g${i}`, kind: "unknown", at: T0 });
      if (res.outcome === "queued") ok++;
    }
    expect(ok + 1).toBeLessThanOrEqual(SCHEDULE_NOTICE_GLOBAL_PER_HOUR);
    expect(r.deps.budget.remaining()).toBeGreaterThanOrEqual(5);
  });

  it("no owner / bot never configured ⇒ refused without enqueue", async () => {
    const r = rig({ owner: () => undefined });
    expect((await r.sch.pushNotice({ ...base, key: "a", kind: "missed", count: 1 })).outcome).toBe("refused");
    expect(r.notices).toHaveLength(0);
  });
});

describe("receipts view", () => {
  it("receiptsFor(sid) lists non-expired receipts of that session only", async () => {
    const r = rig();
    await r.sch.pushReport(r.offer(1));
    await r.sch.pushReport(r.offer(2, { sessionId: "other" }));
    expect(r.sch.receiptsFor(SID)).toEqual([{ reportId: H(1), state: "accepted" }]);
    expect(r.sch.hasReceipt(H(1))).toBe(true);
    expect(r.sch.hasReceipt(H(3))).toBe(false);
  });
});
