/**
 * scheduled-reports plan r3 §5.6/§7.1 (H1) — projecting one session's ScheduleStateFile onto the
 * frozen `ScheduleSessionProjectionWire`: task definitions + defHash/executable/pendingApproval,
 * hub-computed nextAt (shared cron core, task tz), totals, most-recent-first runs with the Feishu
 * receipt display vocabulary, and droppedReports.
 */
import { describe, expect, it } from "vitest";
import { projectSession } from "../../../src/web-hub/hub/schedule/project.js";
import {
  defHash,
  emptyStateFile,
  reportIdOf,
  type Holder,
  type RunRecord,
  type ScheduleTask,
} from "../../../src/schedule/core/spec.js";
import type { ScheduleReceiptState } from "../../../src/web-hub/protocol/schedule.js";

const NOW = Date.UTC(2026, 9, 25, 13, 0, 0); // 2026-10-25T13:00Z
const SID = "019a-demo-sess-0001";
const DAY = 24 * 3_600_000;

const holder: Holder = { pid: 1, start: 1, host: "h", boot: "b", epoch: "e1" };

function task(over: Partial<ScheduleTask> = {}): ScheduleTask {
  const t: ScheduleTask = {
    id: "s_abcd2345",
    name: "daily",
    form: "background",
    when: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    prompt: "do it",
    feishu: true,
    enabled: true,
    createdBy: "user",
    createdVia: "tui",
    createdAt: NOW - DAY,
    ownerCwd: "/tmp/x",
    approval: { hash: "", by: "user", via: "tui", at: NOW - DAY },
    ...over,
  };
  t.approval = { hash: defHash(t), by: "user", via: "tui", at: NOW - DAY };
  return over.approval === null ? { ...t, approval: undefined } : t;
}

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runKey: "s_abcd2345@1761350400000",
    taskId: "s_abcd2345",
    kind: "auto",
    form: "background",
    scheduledAt: NOW - 3_600_000,
    defHash: defHash(task()),
    state: "completed",
    holder,
    startedAt: NOW - 3_600_000,
    endedAt: NOW - 1_800_000,
    note: "written",
    ...over,
  };
}

const state = (over: Partial<ReturnType<typeof emptyStateFile>> = {}) => ({
  ...emptyStateFile(SID),
  rev: 7,
  ...over,
});

const noBot = { configured: false, open: false };
const openBot = { configured: true, open: true, installedAt: NOW - 10 * DAY };

describe("projectSession — tasks", () => {
  it("carries the definition, defHash, derived approval flags, totals and droppedReports", () => {
    const t = task();
    const s = state({
      tasks: [t],
      occ: {
        s_abcd2345: {
          defHash: defHash(t),
          decidedThrough: NOW,
          firedTotal: 3,
          missedTotal: 2,
          skippedTotal: 1,
          missedLog: [],
        },
      },
      manualTotal: { s_abcd2345: 5 },
    });
    const p = projectSession(s, { now: NOW, receipts: new Map(), bot: noBot });
    expect(p.sessionId).toBe(SID);
    expect(p.rev).toBe(7);
    expect(p.droppedReports).toBe(0);
    expect(p.tasks).toHaveLength(1);
    const tp = p.tasks[0]!;
    expect(tp.task).toEqual(t);
    expect(tp.defHash).toBe(defHash(t));
    expect(tp.executable).toBe(true);
    expect(tp.pendingApproval).toBe(false);
    expect(tp.totals).toEqual({ fired: 3, missed: 2, skipped: 1, manual: 5 });
  });

  it("unapproved / paused tasks derive pendingApproval / executable independently (S2)", () => {
    const approved = task();
    const unapproved = task({ id: "s_efgh6789", approval: null as never });
    const paused = task({ id: "s_ijkl1234", enabled: false });
    const s = state({
      tasks: [approved, unapproved, paused],
      occ: {
        s_abcd2345: {
          defHash: defHash(approved),
          decidedThrough: NOW,
          firedTotal: 0,
          missedTotal: 0,
          skippedTotal: 0,
          missedLog: [],
        },
        s_efgh6789: {
          defHash: defHash(unapproved),
          decidedThrough: NOW,
          firedTotal: 0,
          missedTotal: 0,
          skippedTotal: 0,
          missedLog: [],
        },
        s_ijkl1234: {
          defHash: defHash(paused),
          decidedThrough: NOW,
          firedTotal: 0,
          missedTotal: 0,
          skippedTotal: 0,
          missedLog: [],
        },
      },
    });
    const p = projectSession(s, { now: NOW, receipts: new Map(), bot: noBot });
    const byId = Object.fromEntries(p.tasks.map((t) => [t.task.id, t]));
    expect(byId["s_abcd2345"]!.executable).toBe(true);
    expect(byId["s_efgh6789"]!.executable).toBe(false);
    expect(byId["s_efgh6789"]!.pendingApproval).toBe(true);
    // Paused but approved: not executable, NOT pending approval.
    expect(byId["s_ijkl1234"]!.executable).toBe(false);
    expect(byId["s_ijkl1234"]!.pendingApproval).toBe(false);
  });

  it("computes nextAt with the shared cron core in the task tz; a paused task has none", () => {
    const t = task(); // daily 09:00 UTC
    const paused = task({ id: "s_ijkl1234", enabled: false });
    const s = state({
      tasks: [t, paused],
      occ: {
        s_abcd2345: {
          defHash: defHash(t),
          decidedThrough: NOW,
          firedTotal: 0,
          missedTotal: 0,
          skippedTotal: 0,
          missedLog: [],
        },
        s_ijkl1234: {
          defHash: defHash(paused),
          decidedThrough: NOW,
          firedTotal: 0,
          missedTotal: 0,
          skippedTotal: 0,
          missedLog: [],
        },
      },
    });
    const p = projectSession(s, { now: NOW, receipts: new Map(), bot: noBot });
    const expectedNext = Date.UTC(2026, 9, 26, 9, 0, 0); // next 09:00 UTC after 13:00Z
    expect(p.tasks[0]!.nextAt).toBe(expectedNext);
    expect(p.tasks[0]!.degraded).toBeUndefined();
    expect(p.tasks[1]!.nextAt).toBeUndefined();
    expect(p.tasks[1]!.degraded).toBeUndefined();
  });

  it("an enabled task with no occurrence in the horizon is degraded:never", () => {
    const never = task({ when: { kind: "cron", expr: "0 9 1 1 *", tz: "UTC" } }); // Jan 1 only
    const s = state({
      tasks: [never],
      occ: {
        s_abcd2345: {
          defHash: defHash(never),
          decidedThrough: NOW,
          firedTotal: 0,
          missedTotal: 0,
          skippedTotal: 0,
          missedLog: [],
        },
      },
    });
    // NOW is 2026-10-25; the next Jan 1 is within 400 days… force the horizon tiny instead:
    const p = projectSession(s, { now: NOW, receipts: new Map(), bot: noBot, nextHorizonMs: 10 * DAY });
    expect(p.tasks[0]!.nextAt).toBeUndefined();
    expect(p.tasks[0]!.degraded).toBe("never");
  });

  it("a once task that is already past has no nextAt", () => {
    const once = task({ when: { kind: "once", at: "2026-10-20T09:00", tz: "UTC" } });
    const s = state({
      tasks: [once],
      occ: {
        s_abcd2345: {
          defHash: defHash(once),
          decidedThrough: NOW,
          firedTotal: 1,
          missedTotal: 0,
          skippedTotal: 0,
          missedLog: [],
        },
      },
    });
    const p = projectSession(s, { now: NOW, receipts: new Map(), bot: noBot });
    expect(p.tasks[0]!.nextAt).toBeUndefined();
  });

  it("surfaces reportStats.droppedIndexCap", () => {
    const s = state({ reportStats: { droppedIndexCap: 3, lastDroppedAt: NOW } });
    expect(projectSession(s, { now: NOW, receipts: new Map(), bot: noBot }).droppedReports).toBe(3);
  });
});

describe("projectSession — runs and the Feishu display", () => {
  const RK = "s_abcd2345@1761350400000";
  const RID = reportIdOf(SID, RK);

  it("orders most-recent first and keeps non-terminal runs", () => {
    const s = state({
      runs: [
        run({ runKey: "s_abcd2345@1", startedAt: 100, state: "running", endedAt: undefined }),
        run({ runKey: RK, startedAt: 300 }),
        run({ runKey: "s_abcd2345@2", startedAt: 200, state: "failed", reason: "auth" }),
      ],
    });
    const p = projectSession(s, { now: NOW, receipts: new Map(), bot: noBot });
    expect(p.runs.map((r) => r.runKey)).toEqual([RK, "s_abcd2345@2", "s_abcd2345@1"]);
    expect(p.runs[2]!.state).toBe("running");
    expect(p.runs[1]!.reason).toBe("auth");
  });

  it("maps the receipt vocabulary (§7.1 状态区分)", () => {
    const waiting = run({ runKey: RK, endedAt: NOW - 60_000 });
    const withReceipt = run({ runKey: "s_abcd2345@1761354000000" });
    const rid2 = reportIdOf(SID, "s_abcd2345@1761354000000");
    const s = state({
      tasks: [task()],
      runs: [waiting, withReceipt],
      pendingReports: [
        {
          reportId: RID,
          runKey: RK,
          taskId: "s_abcd2345",
          form: "background",
          endedAt: NOW - 60_000,
          expiresAt: NOW + DAY,
          reportFile: `reports/${RID}.md`,
          status: "completed",
        },
      ],
    });
    const receipts = new Map<string, { state: ScheduleReceiptState; at: number }>([[rid2, { state: "sent", at: NOW }]]);
    const p = projectSession(s, { now: NOW, receipts, bot: openBot });
    const byKey = Object.fromEntries(p.runs.map((r) => [r.runKey, r]));
    // In the index, unexpired, bot open, no receipt ⇒ waiting.
    expect(byKey[RK]!.feishu).toBe("waiting");
    // A receipt overrides everything.
    expect(byKey["s_abcd2345@1761354000000"]!.feishu).toBe("sent");
  });

  it("n/a when the bot was never configured; expired past the 24h window", () => {
    const rk1 = "s_abcd2345@1761350400000";
    const rk2 = "s_abcd2345@1761354000000";
    const rid1 = reportIdOf(SID, rk1);
    const rid2 = reportIdOf(SID, rk2);
    const s = state({
      tasks: [task()],
      runs: [run({ runKey: rk1, endedAt: NOW - 30 * DAY }), run({ runKey: rk2, endedAt: NOW - 25 * 3_600_000 })],
      pendingReports: [
        {
          reportId: rid1,
          runKey: rk1,
          taskId: "s_abcd2345",
          form: "background",
          endedAt: NOW - 30 * DAY,
          expiresAt: NOW - 6 * DAY,
          reportFile: `reports/${rid1}.md`,
          status: "completed",
        },
      ],
    });
    const p = projectSession(s, { now: NOW, receipts: new Map(), bot: noBot });
    const byKey = Object.fromEntries(p.runs.map((r) => [r.runKey, r]));
    expect(byKey[rk1]!.feishu).toBe("expired"); // index entry past expiresAt
    expect(byKey[rk2]!.feishu).toBe("n/a"); // no bot at all ⇒ never deliverable
  });

  it("none for runs that never push (task.feishu false / no report)", () => {
    const s = state({
      tasks: [task({ feishu: false })],
      runs: [run({ endedAt: NOW - 30 * DAY }), run({ state: "running", endedAt: undefined })],
    });
    const p = projectSession(s, { now: NOW, receipts: new Map(), bot: openBot });
    expect(p.runs.every((r) => r.feishu === "none")).toBe(true);
  });

  it("carries reportFile only when the run references one", () => {
    const rid = reportIdOf(SID, RK);
    const s = state({
      runs: [run({ reportFile: `reports/${rid}.md` }), run({ runKey: "s_abcd2345@9", reportFile: undefined })],
    });
    const p = projectSession(s, { now: NOW, receipts: new Map(), bot: noBot });
    expect(p.runs[0]!.reportFile).toBe(`reports/${rid}.md`);
    expect(p.runs[1]!.reportFile).toBeUndefined();
  });
});
