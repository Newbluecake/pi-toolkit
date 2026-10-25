/** F1 through the real service composition: `/schedule`, report push + settle write-back, `sched_bound`, feature off. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { eventually, f8Rig, sentContent } from "../../../fixtures/feishu/f8.js";
import { messageEnvelope } from "../../../fixtures/feishu/f6.js";
import type {
  FeishuSchedulePort,
  FeishuScheduleRow,
  ScheduleReceiptView,
  ScheduleReportOffer,
} from "../../../../src/web-hub/hub/feishu/schedule.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
async function rig(options: Parameters<typeof f8Rig>[0] = {}) {
  const r = await f8Rig(options);
  cleanups.push(() => r.close());
  await r.ready();
  return r;
}
const H = (n: string | number) => createHash("sha256").update(String(n)).digest("hex");
const ROWS: FeishuScheduleRow[] = [
  {
    sessionId: "session-1",
    sessionLabel: "One",
    online: true,
    taskId: "s_abcd2345",
    name: "日报",
    form: "background",
    when: "cron 0 9 * * *",
    enabled: true,
    approved: true,
    defHash: H("def"),
    lastStatus: "completed",
  },
  {
    sessionId: "session-2",
    sessionLabel: "Two",
    online: false,
    taskId: "s_wxyz2345",
    name: "周报",
    form: "message",
    when: "cron 0 9 * * 1",
    enabled: true,
    approved: false,
    defHash: H("def2"),
  },
];
function port(over: Partial<FeishuSchedulePort> = {}) {
  const changes: Array<[string, ScheduleReceiptView[]]> = [];
  const run = vi.fn<FeishuSchedulePort["run"]>(async () => ({ kind: "started" }));
  const p: FeishuSchedulePort = {
    list: () => ROWS,
    run,
    receiptsChanged: (sid, rows) => changes.push([sid, [...rows]]),
    ...over,
  };
  return { p, run, changes };
}
const offer = (n: number, over: Partial<ScheduleReportOffer> = {}): ScheduleReportOffer => ({
  sessionId: "session-1",
  sessionLabel: "One",
  reportId: H(n),
  runKey: `s_abcd2345@${n}`,
  taskId: "s_abcd2345",
  taskName: "日报",
  status: "completed",
  endedAt: Date.now(),
  expiresAt: Date.now() + 86_400_000,
  read: () => "今日销量 **42**",
  ...over,
});

describe("feature off (no HubConfig.schedule ⇒ no port)", () => {
  it("/schedule is an unknown command, help has no schedule line, push is inert, no state key", async () => {
    const r = await rig();
    await r.bind();
    r.send(messageEnvelope("s1", "/schedule"));
    await eventually(() => expect(sentContent(r)).toContain("未知命令 /schedule"));
    expect(sentContent(r)).not.toContain("定时任务");
    r.send(messageEnvelope("h1", "/help"));
    await eventually(() => expect(sentContent(r)).toContain("/unbind"));
    expect(sentContent(r)).not.toContain("/schedule [run");
    const before = r.fake.sent.length;
    expect((await r.service.schedule.pushReport(offer(1))).outcome).toBe("n/a");
    expect(
      await r.service.schedule.pushNotice({
        key: "k",
        sessionId: "s",
        sessionLabel: "s",
        taskId: "t",
        taskName: "n",
        kind: "missed",
        count: 1,
      }),
    ).toEqual({ outcome: "refused", reason: "inactive" });
    expect(r.service.schedule.receiptsFor("session-1")).toEqual([]);
    expect(r.fake.sent.length).toBe(before);
    expect("scheduleReceipts" in (await r.disk())).toBe(false);
  });
});

describe("/schedule", () => {
  it("lists frozen rows, then runs by number with a deterministic cmdId; redelivery keeps the reqId", async () => {
    const { p, run } = port();
    const r = await rig({ schedule: p });
    await r.bind();
    r.send(messageEnvelope("l1", "/help"));
    await eventually(() => expect(sentContent(r)).toContain("/schedule [run"));
    r.send(messageEnvelope("l2", "/schedule"));
    await eventually(() => expect(sentContent(r)).toContain("日报"));
    expect(sentContent(r)).toContain("周报");
    expect(sentContent(r)).toContain("待批准");
    r.send(messageEnvelope("r1", "/schedule run 1"));
    await eventually(() => expect(run).toHaveBeenCalledTimes(1));
    await eventually(() => expect(sentContent(r)).toContain("已开始"));
    const req = run.mock.calls[0]![0];
    expect(req).toMatchObject({ sessionId: "session-1", taskId: "s_abcd2345", defHash: H("def") });
    expect(req.reqId).toMatch(/^fs[A-Za-z0-9_-]{30}$/);
    r.send(messageEnvelope("r2", "/schedule run 1"));
    await eventually(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1]![0].reqId).not.toBe(req.reqId); // a NEW message ⇒ a new manual run
  });

  it("maps refusals/offline/timeout to the specified replies; stale or out-of-range numbers never reach the hub", async () => {
    const { p, run } = port();
    const r = await rig({ schedule: p });
    await r.bind();
    r.send(messageEnvelope("e0", "/schedule run 1"));
    await eventually(() => expect(sentContent(r)).toContain("列表已过期"));
    expect(run).not.toHaveBeenCalled();
    r.send(messageEnvelope("e1", "/schedule"));
    await eventually(() => expect(sentContent(r)).toContain("周报"));
    r.send(messageEnvelope("e2", "/schedule run 9"));
    await eventually(() => expect(sentContent(r)).toContain("序号无效"));
    run.mockResolvedValueOnce({ kind: "offline" });
    r.send(messageEnvelope("e3", "/schedule run 2"));
    await eventually(() => expect(sentContent(r)).toContain("归属会话不在线（Two）"));
    run.mockResolvedValueOnce({ kind: "refused", reason: "defhash" });
    r.send(messageEnvelope("e4", "/schedule run 1"));
    await eventually(() => expect(sentContent(r)).toContain("任务已修改，请重新 /schedule"));
    run.mockResolvedValueOnce({ kind: "timeout" });
    r.send(messageEnvelope("e5", "/schedule run 1"));
    await eventually(() => expect(sentContent(r)).toContain("执行结果未确认"));
    run.mockResolvedValueOnce({ kind: "multi" });
    r.send(messageEnvelope("e6", "/schedule run 1"));
    await eventually(() => expect(sentContent(r)).toContain("会话在多处打开"));
  });

  it("a hub-side rejection never escapes (run throws ⇒ unconfirmed reply)", async () => {
    const { p, run } = port();
    const r = await rig({ schedule: p });
    await r.bind();
    r.send(messageEnvelope("t0", "/schedule"));
    await eventually(() => expect(sentContent(r)).toContain("日报"));
    run.mockRejectedValueOnce(new Error("boom"));
    r.send(messageEnvelope("t1", "/schedule run 1"));
    await eventually(() => expect(sentContent(r)).toContain("执行结果未确认"));
  });

  it("group chats are refused with the p2p-only notice", async () => {
    const { p, run } = port();
    const r = await rig({ schedule: p });
    const opts = { chatType: "group" as const, threadId: "thread-1", mentions: true };
    await r.bind(opts);
    r.send(messageEnvelope("g1", "/schedule run 1", opts));
    await eventually(() => expect(sentContent(r)).toContain("schedule-p2p-only"));
    expect(run).not.toHaveBeenCalled();
  });
});

describe("report push through the service", () => {
  it("queued → delivered: receipt accepted→sent, persisted, pushed to the hub port; second offer is skipped", async () => {
    const { p, changes } = port();
    const r = await rig({ schedule: p });
    const res = await r.service.schedule.pushReport(offer(1));
    expect(res.outcome).toBe("queued");
    await eventually(() => expect(sentContent(r)).toContain("今日销量"));
    await eventually(() => expect(r.service.schedule.receiptsFor("session-1")[0]?.state).toBe("sent"));
    await eventually(() => expect(changes.map(([, rows]) => rows[0]!.state)).toEqual(["accepted", "sent"]));
    expect((await r.disk())["scheduleReceipts"][H(1)]).toMatchObject({ sid: "session-1", state: "sent" });
    expect((await r.service.schedule.pushReport(offer(1))).outcome).toBe("skipped");
    expect(r.service.schedule.hasReceipt(H(1))).toBe(true);
    // the outbox group is gone after settle (no stuck `sch:` parts)
    await eventually(async () => expect(Object.keys((await r.disk())["outbox"] ?? {})).toHaveLength(0));
  });

  it("a send the platform rejects ends as failed(code) and is never re-pushed", async () => {
    const { p } = port();
    const r = await rig({ schedule: p });
    r.fake.script("POST", /messages/, { json: { code: 230001, msg: "bad" } });
    expect((await r.service.schedule.pushReport(offer(2))).outcome).toBe("queued");
    await eventually(() => expect(r.service.schedule.receiptsFor("session-1")[0]?.state).toBe("failed"));
    expect((await r.service.schedule.pushReport(offer(2))).outcome).toBe("skipped");
  });

  it("notices use the owner p2p target", async () => {
    const { p } = port();
    const r = await rig({ schedule: p });
    const res = await r.service.schedule.pushNotice({
      key: "m1",
      sessionId: "session-1",
      sessionLabel: "One",
      taskId: "s_abcd2345",
      taskName: "日报",
      kind: "missed",
      count: 2,
    });
    expect(res.outcome).toBe("queued");
    await eventually(() => expect(sentContent(r)).toContain("已错过"));
  });
});

describe("sched_bound exact suppression of the done notice", () => {
  let nowRef: () => number = () => 0;
  const idle = () => ({ at: nowRef(), fleet: { complete: true, terminal: [] }, bash: { complete: true, running: 0 } });
  async function localRun(r: Awaited<ReturnType<typeof rig>>, mid?: () => void) {
    r.event({ type: "agent_start" });
    r.event({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "tick" }] } });
    mid?.();
    r.event({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "RESULT" }], stopReason: "stop" },
    });
    r.event({ type: "agent_settled" });
  }
  it("baseline: a local run still sends the done notice", async () => {
    const { p } = port();
    const r = await rig({ schedule: p, idleEvidence: idle });
    nowRef = r.clock.now;
    await r.bind();
    await localRun(r);
    await eventually(() => expect(sentContent(r)).toContain("done: RESULT"));
  });
  it.each(["after", "before"] as const)("bound %s the bound message's ev ⇒ no done notice", async (order) => {
    const { p } = port();
    const r = await rig({ schedule: p, idleEvidence: idle });
    nowRef = r.clock.now;
    await r.bind();
    const bound = () => r.emit({ type: "sched_bound", agentKey: "agent-1", runKey: "s_abcd2345@1761350400000" });
    if (order === "before") {
      r.event({ type: "agent_start" });
      bound();
      r.event({ type: "message_start", message: { role: "user", content: [] } });
      r.event({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "RESULT" }], stopReason: "stop" },
      });
      r.event({ type: "agent_settled" });
    } else await localRun(r, bound);
    await new Promise((res) => setTimeout(res, 80));
    expect(sentContent(r)).not.toContain("done: RESULT");
  });
  it("a human user message joining the scheduled run restores the done notice", async () => {
    const { p } = port();
    const r = await rig({ schedule: p, idleEvidence: idle });
    nowRef = r.clock.now;
    await r.bind();
    r.event({ type: "agent_start" });
    r.event({ type: "message_start", message: { role: "user", content: [] } });
    r.emit({ type: "sched_bound", agentKey: "agent-1", runKey: "s_abcd2345@1761350400000" });
    r.event({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "human" }] } });
    r.event({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "RESULT" }], stopReason: "stop" },
    });
    r.event({ type: "agent_settled" });
    await eventually(() => expect(sentContent(r)).toContain("done: RESULT"));
  });
  it("the marker is per run: the next local run notifies again; a bind with no run in flight is ignored", async () => {
    const { p } = port();
    const r = await rig({ schedule: p, idleEvidence: idle });
    nowRef = r.clock.now;
    await r.bind();
    r.emit({ type: "sched_bound", agentKey: "agent-1", runKey: "s_abcd2345@1" }); // no agent_start yet
    await localRun(r);
    await eventually(() => expect(sentContent(r)).toContain("done: RESULT"));
  });
  it("without a schedule port the frame is ignored (done still sent)", async () => {
    const r = await rig({ idleEvidence: idle });
    nowRef = r.clock.now;
    await r.bind();
    await localRun(r, () => r.emit({ type: "sched_bound", agentKey: "agent-1", runKey: "s_abcd2345@1" }));
    await eventually(() => expect(sentContent(r)).toContain("done: RESULT"));
  });
});
