/**
 * scheduled-reports verify r1 (major): a REAL F1 schedule service (`createFeishuSchedule`, the
 * exact object hub.ts hands the coordinator via `bindDelivery`) × a REAL H1 coordinator over a
 * REAL on-disk store — the two committed interfaces finally meet:
 *   - 报告发现 → F1 pushReport（飞书 outbox final + 回执 accepted）→ receiptsChanged → H1 推
 *     sched_receipts 给在线归属会话；
 *   - 错过 → 对账 pending → F1 pushNotice（每小时合并卡）→ 同小时第二批被 F1 的 task-hour
 *     拒绝后结转，下一小时合并发出。
 * F1's own deps are stubbed at its SEAM (state/outbox/budget — the same doubles F1's
 * schedule-push.test.ts uses); everything on the H1 side is production code + real files.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScheduleService, type ScheduleCoordinator } from "../../../src/web-hub/hub/schedule/service.js";
import {
  createFeishuSchedule,
  scheduleRequestId,
  type FeishuScheduleDeps,
} from "../../../src/web-hub/hub/feishu/schedule.js";
import { createNoticeBudget } from "../../../src/web-hub/hub/feishu/security.js";
import type { EnqueueFinalInput, EnqueueNoticeInput, EnqueueResult } from "../../../src/web-hub/hub/feishu/outbox.js";
import type { FeishuScheduleReceipt, ScheduleReceiptState } from "../../../src/web-hub/hub/feishu/state.js";
import { createFakeClock } from "../../fixtures/feishu/fake-http.js";
import { defHash, emptyStateFile, type ScheduleStateFile, type ScheduleTask } from "../../../src/schedule/core/spec.js";
import { SCHED_HUB_CAP } from "../../../src/web-hub/protocol/schedule.js";
import type { HubFrame } from "../../../src/web-hub/protocol/messages.js";

const BASE = Date.UTC(2026, 9, 26, 0, 0, 0);
const T = (h: number): number => BASE + h * 3_600_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SID = "sid-alpha";

const dirs: string[] = [];
const services: ScheduleCoordinator[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "pwh-sched-f1-"));
  dirs.push(d);
  return d;
};

const task = (): ScheduleTask => {
  const t: ScheduleTask = {
    id: "s_abcd2345",
    name: "日报",
    form: "background",
    when: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    prompt: "跑一遍",
    feishu: true,
    enabled: true,
    bg: { type: "general-purpose", timeoutS: 1800, consultMain: false, handoff: false },
    approval: { hash: "", by: "user", via: "tui", at: 1 },
    createdBy: "user",
    createdVia: "tui",
    createdAt: 1,
    ownerCwd: "/tmp/x",
  };
  t.approval = { hash: defHash(t), by: "user", via: "tui", at: 1 };
  return t;
};

function writeState(root: string, build: (s: ScheduleStateFile) => void): void {
  const dir = join(root, SID);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const s = emptyStateFile(SID);
  s.rev = 1;
  build(s);
  writeFileSync(join(dir, "state.json"), JSON.stringify(s), { mode: 0o600 });
}

/** F1's rig (schedule-push.test.ts) — the REAL createFeishuSchedule against its own seams. */
function rigFeishu(clockNow: () => number) {
  const receipts = new Map<string, FeishuScheduleReceipt>();
  const outboxParts: Array<{ requestId?: string; kind: string }> = [];
  const finals: EnqueueFinalInput[] = [];
  const notices: EnqueueNoticeInput[] = [];
  const clock = { now: clockNow };
  const state: FeishuScheduleDeps["state"] = {
    scheduleReceipts: {
      get: (id) => receipts.get(id),
      set: (id, i) => {
        const rec: FeishuScheduleReceipt = { ...i, at: clock.now() };
        receipts.set(id, rec);
        return { ok: true as const, value: rec };
      },
      list: (f?) =>
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
    now: () => clock.now(),
    owner: () => "ou_owner0123456789",
    installedAt: () => T(0) - 3_600_000,
    ready: () => true,
    budget: createNoticeBudget({ now: () => clock.now() }),
    outbox: {
      enqueueFinal: async (i) => {
        finals.push(i);
        outboxParts.push({ requestId: i.requestId, kind: "final" });
        return { ok: true, sendIds: ["a"], durable: true, duplicate: false };
      },
      enqueueNotice: async (i) => {
        notices.push(i);
        return { ok: true, sendIds: ["n"], durable: true, duplicate: false };
      },
    },
    workSize: () => 0,
    count: () => {},
    onReceipts: () => {},
    log: () => {},
  };
  const schedule = createFeishuSchedule(deps);
  return { schedule, finals, notices, receipts, deps };
}

function fakeRegistry() {
  const sent: HubFrame[] = [];
  const agents = new Map<string, { session?: { sessionId: string }; caps?: string[]; connected: boolean }>();
  return {
    sent,
    agents,
    list: () =>
      [...agents.entries()].map(([agentKey, a]) => ({
        agentKey,
        ...(a.session === undefined ? {} : { session: a.session }),
      })),
    isConnected: (k: string) => agents.get(k)?.connected ?? false,
    getCaps: (k: string) => agents.get(k)?.caps,
    send: (k: string, f: HubFrame) => {
      sent.push(f);
      return agents.get(k)?.connected ?? false;
    },
    subscribe: () => () => {},
  };
}

describe("real F1 schedule × real H1 coordinator", () => {
  it.each(["legacy", "short", "short-suffix"])(
    "%s 报告 → 飞书附件 + receipts；hub restart 不重复推送且不写账本",
    async (format) => {
      const root = tmp();
      const rid = createHash("sha256").update(`${SID}\0s_abcd2345@1`).digest("hex");
      const fileName =
        format === "legacy" ? `${rid}.md` : `s_abcd2345-20261026-0100${format === "short-suffix" ? "-3" : ""}.md`;
      const reportFile = `reports/${fileName}`;
      writeState(root, (s) => {
        s.tasks.push(task());
        s.pendingReports.push({
          reportId: rid,
          runKey: "s_abcd2345@1",
          taskId: "s_abcd2345",
          form: "background",
          endedAt: T(1),
          expiresAt: T(1) + DAY,
          reportFile,
          status: "completed",
        });
      });
      mkdirSync(join(root, SID, "reports"), { recursive: true, mode: 0o700 });
      writeFileSync(join(root, SID, reportFile), "# 日报正文\n\n" + "段落\n\n".repeat(10_000), { mode: 0o600 });
      const ledgerBefore = readFileSync(join(root, SID, "state.json"));

      const reg = fakeRegistry();
      reg.agents.set("a1", { session: { sessionId: SID }, connected: true, caps: [SCHED_HUB_CAP] });
      let now = T(2);
      const f1 = rigFeishu(() => now);
      const upload = vi.fn(async (_input: { bytes: Buffer; fileName: string }) => ({
        ok: true as const,
        fileKey: "fk",
      }));
      f1.deps.upload = upload;
      const hubStateDir = tmp();
      // Wire the two committed seams exactly like hub.ts: F1's receiptsChanged → coordinator,
      // coordinator's port → F1's deps (construction-time), delivery after "bot start".
      const svc = createScheduleService({
        config: { dir: root, toleranceS: 60 },
        stateDir: hubStateDir,
        registry: reg,
        log: { info: () => {}, warn: () => {}, error: () => {} },
        now: () => now,
      });
      services.push(svc);
      // Production wiring (service.ts): F1's receiptsChanged → the hub port → sched_receipts.
      f1.deps.onReceipts = (sid, rows) => svc.port().receiptsChanged(sid, rows);
      await svc.rescanAll();
      svc.bindDelivery(f1.schedule);
      await svc.rescanAll();

      // F1 turned the discovery into exactly one outbox final with the report body.
      expect(f1.finals).toHaveLength(1);
      expect(f1.finals[0]!.requestId).toBe(scheduleRequestId(rid));
      expect(upload).toHaveBeenCalledOnce();
      const attachmentFileName = format === "legacy" ? "reply-sidalp.md" : fileName;
      expect(upload.mock.calls[0]![0].fileName).toBe(attachmentFileName);
      expect(f1.finals[0]!.messages[0]!.content).toContain(`完整内容见附件 \`${attachmentFileName}\``);
      expect(upload.mock.calls[0]![0].bytes.toString("utf8")).toContain("日报正文");
      expect(f1.finals[0]!.messages.some((m) => m.msgType === "file")).toBe(true);
      // The receipt exists (accepted) — and the coordinator learned it via receiptsChanged →
      // sched_receipts reached the ONLINE owning session.
      expect(f1.receipts.get(rid)?.state).toBe("accepted");
      const frame = reg.sent.find((f) => f.t === "sched_receipts") as { sessionId: string; reportIds: string[] };
      expect(frame.sessionId).toBe(SID);
      expect(frame.reportIds).toEqual([rid]);
      // A later round does not re-offer (F1's receipt table dedups via hasReceipt).
      const offersBefore = svc.status().counters.reportsOffered;
      await svc.rescanAll();
      expect(svc.status().counters.reportsOffered).toBe(offersBefore);
      await svc.dispose();
      const restarted = createScheduleService({
        config: { dir: root, toleranceS: 60 },
        stateDir: hubStateDir,
        registry: reg,
        log: { info: () => {}, warn: () => {}, error: () => {} },
        now: () => now,
      });
      services.push(restarted);
      f1.deps.onReceipts = (sid, rows) => restarted.port().receiptsChanged(sid, rows);
      const restartedBot = createFeishuSchedule(f1.deps); // durable receipt/outbox survive process recreation
      await restartedBot.reconcile();
      restarted.bindDelivery(restartedBot);
      await restarted.rescanAll();
      expect(restarted.readReport(SID, reportFile)).toMatchObject({
        ok: true,
        text: expect.stringContaining("日报正文"),
      });
      expect(f1.finals).toHaveLength(1);
      expect(upload).toHaveBeenCalledOnce();
      expect(f1.receipts.get(rid)?.state).toBe("accepted");
      expect(readFileSync(join(root, SID, "state.json"))).toEqual(ledgerBefore);
    },
  );

  it("错过 → 每小时合并卡：第一批发出，同小时第二批被 F1 拒后结转，下一小时合并", async () => {
    const root = tmp();
    const t = task();
    const writeMissed = (total: number, entries: unknown[], rev: number): void => {
      writeState(root, (s) => {
        s.rev = rev;
        s.tasks.push(t);
        s.occ[t.id] = {
          defHash: defHash(t),
          decidedThrough: T(12),
          firedTotal: 0,
          missedTotal: total,
          skippedTotal: 0,
          missedLog: entries as never,
        };
      });
    };
    const e = (seq: number, count: number, totalAfter: number) => ({
      seq,
      defHash: defHash(t),
      from: T(11),
      to: T(12),
      count,
      totalAfter,
      at: T(12),
      cause: "offline" as const,
    });
    writeMissed(2, [e(1, 2, 2)], 1);
    const reg = fakeRegistry();
    let now = T(12) + 30 * 60_000;
    const f1 = rigFeishu(() => now);
    const svc = createScheduleService({
      config: { dir: root, toleranceS: 60 },
      stateDir: tmp(),
      registry: reg,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => now,
    });
    services.push(svc);
    await svc.rescanAll();
    svc.bindDelivery(f1.schedule);
    await svc.rescanAll();
    expect(f1.notices).toHaveLength(1);
    expect(JSON.stringify(f1.notices[0])).toContain("已错过");

    // Same hour: a second batch arrives; F1 refuses the same-hour notice (task-hour) — H1
    // retains the pendings (nothing lost, nothing duplicated).
    writeMissed(5, [e(1, 2, 2), e(2, 3, 5)], 2);
    await svc.rescanAll();
    expect(f1.notices).toHaveLength(1);

    // Next hour: the carry merges into ONE card with the full count.
    now += HOUR;
    await svc.rescanAll();
    expect(f1.notices).toHaveLength(2);
    expect(JSON.stringify(f1.notices[1])).toContain("已错过");
    // F1's per-task-hour table did its job: exactly one notice per task per hour, and the
    // carried batch merged into the next hour's single card (rendered by F1 itself).
  });

  it("结果未知 → unknown 卡经 F1 发出；sched_bound 经 tap 到达 F1 的事件流", async () => {
    const root = tmp();
    const t = task();
    writeState(root, (s) => {
      s.tasks.push(t);
      s.occ[t.id] = {
        defHash: defHash(t),
        decidedThrough: T(12),
        firedTotal: 1,
        missedTotal: 0,
        skippedTotal: 0,
        missedLog: [],
      };
      s.runs.push({
        runKey: "s_abcd2345@2",
        taskId: t.id,
        kind: "auto",
        form: "background",
        scheduledAt: T(12),
        defHash: defHash(t),
        state: "unknown",
        holder: { pid: 1, start: 1, host: "h", boot: "b", epoch: "e" },
        startedAt: T(12),
        note: "none",
      });
    });
    const reg = fakeRegistry();
    let now = T(13);
    const f1 = rigFeishu(() => now);
    const svc = createScheduleService({
      config: { dir: root, toleranceS: 60 },
      stateDir: tmp(),
      registry: reg,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => now,
    });
    services.push(svc);
    const events: string[] = [];
    svc.setBoundTap((agentKey, runKey) => events.push(`${agentKey}:${runKey}`));
    svc.onAgentFrame("a1", { t: "sched_bound", agentKey: "a1", runKey: "s_abcd2345@2" });
    expect(events).toEqual(["a1:s_abcd2345@2"]);
    svc.bindDelivery(f1.schedule);
    await svc.rescanAll();
    expect(f1.notices).toHaveLength(1);
    expect(JSON.stringify(f1.notices[0])).toContain("结果未知");
  });
});
