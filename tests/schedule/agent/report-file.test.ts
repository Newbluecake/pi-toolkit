import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitBackgroundReport, truncateUtf8 } from "../../../src/schedule/agent/report-file.js";
import { manualClaim } from "../../../src/schedule/core/claim.js";
import { readReportFile } from "../../../src/schedule/core/reader.js";
import { SCHED_REPORT_MAX_BYTES } from "../../../src/schedule/core/spec.js";
import { addTask, approve, env, holder, makeTask, readOk, type Env } from "../core/fixtures.js";
const envs: Env[] = [];
afterEach(() => {
  for (const e of envs.splice(0)) e.cleanup();
});
async function fixture(at = Date.now(), tz = "UTC") {
  const e = env(at);
  envs.push(e);
  const store = e.store();
  const task = approve(makeTask({ when: { kind: "cron", expr: "0 * * * *", tz } }));
  await addTask(store, task, e.clock.t);
  const c = await manualClaim(store, { taskId: task.id, reqId: "report_request_123", holder: holder() });
  if (c.kind !== "started" || !c.run) throw new Error("claim fixture");
  return {
    e,
    store,
    task,
    run: c.run,
    holder: holder(),
    isDisposed: () => false,
    now: e.clock.t,
    noteId: "note-unique",
    result: { state: "completed" as const, text: "结果" },
  };
}
describe("background report transaction", () => {
  it.each([undefined, "r_report"])(
    "bounds UTF-8 bytes and truncation references the available runId (%s)",
    async (runId) => {
      const f = await fixture();
      if (runId !== undefined) {
        f.run.runId = runId;
        await f.store.transact((d) => {
          d.runs[0]!.runId = runId;
          return { value: undefined, write: true };
        });
      }
      f.result.text = "报告😀".repeat(100000);
      const r = await commitBackgroundReport(f);
      expect(r.kind).toBe("committed");
      const state = readOk(f.store);
      const run = state.runs[0]!;
      expect(run).toMatchObject({ state: "completed", note: "pending", noteId: "note-unique" });
      expect(state.pendingReports[0]?.reportFile).toBe(run.reportFile);
      const report = readReportFile(f.store.root, f.store.dirName, run.reportFile!);
      expect(report.kind).toBe("ok");
      if (report.kind === "ok") {
        expect(report.bytes).toBeLessThanOrEqual(SCHED_REPORT_MAX_BYTES);
        expect(report.text).not.toContain("�");
        expect(report.text).toContain("截断");
        if (runId === undefined) expect(report.text).not.toContain("get_subagent_result");
        else expect(report.text).toContain(`get_subagent_result ${runId}`);
      }
      expect(truncateUtf8("a😀中", 5)).toBe("a😀");
    },
  );
  it("uses trigger time (not completion time), allocates -2/-3 for same-minute manual runs and indexes actual paths", async () => {
    const trigger = Date.parse("2026-10-25T23:52:01Z");
    const f = await fixture(trigger, "Asia/Shanghai");
    let run = f.run;
    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        f.e.clock.t = trigger + i * 1_000;
        const c = await manualClaim(f.store, { taskId: f.task.id, reqId: `report_request_${i}22`, holder: f.holder });
        if (c.kind !== "started" || !c.run) throw new Error(`manual claim: ${c.kind}`);
        run = c.run;
      }
      // Deliberately different finish minute: the occurrence/trigger determines the filename.
      const result = await commitBackgroundReport({
        ...f,
        run,
        now: trigger + 5 * 60_000,
        result: { state: "completed", text: `report ${i}` },
      });
      expect(result.kind).toBe("committed");
    }
    const prefix = `reports/${f.task.id}-20261026-0752`;
    const state = readOk(f.store);
    expect(state.runs.map((r) => r.reportFile).sort()).toEqual(
      [`${prefix}.md`, `${prefix}-2.md`, `${prefix}-3.md`].sort(),
    );
    for (const [i, run] of state.runs.entries()) {
      expect(state.pendingReports.find((p) => p.runKey === run.runKey)?.reportFile).toBe(run.reportFile);
      expect(readReportFile(f.store.root, f.store.dirName, run.reportFile!)).toMatchObject({
        kind: "ok",
        text: expect.stringContaining(`report ${i}`),
      });
    }
    expect(readdirSync(join(f.store.root.real, f.store.dirName, "reports"))).toHaveLength(3);
  });

  it("first terminal writer wins; duplicate result never rewrites the report", async () => {
    const f = await fixture();
    await commitBackgroundReport(f);
    const before = readReportFile(f.store.root, f.store.dirName, readOk(f.store).runs[0]!.reportFile!);
    const r = await commitBackgroundReport({ ...f, result: { state: "failed", reason: "model", text: "late" } });
    expect(r.kind).toBe("late");
    const state = readOk(f.store);
    expect(state.runs[0]).toMatchObject({ state: "completed", lateOutcome: "failed:model" });
    expect(readReportFile(f.store.root, f.store.dirName, state.runs[0]!.reportFile!)).toEqual(before);
    expect(state.pendingReports).toHaveLength(1);
  });
  it("dispose during lock acquisition writes only unknown and audit, never a report", async () => {
    const f = await fixture();
    const r = await commitBackgroundReport({ ...f, isDisposed: () => true });
    expect(r.kind).toBe("closed");
    expect(readOk(f.store).runs[0]).toMatchObject({
      state: "unknown",
      reason: "owner-closed",
      lateOutcome: "completed",
    });
    expect(readOk(f.store).pendingReports).toHaveLength(0);
    expect(existsSync(join(f.store.root.real, f.store.dirName, "reports"))).toBe(false);
  });
  it("cap refusal keeps a pending result but no file or delivery index", async () => {
    const f = await fixture();
    const r = await commitBackgroundReport({ ...f, caps: { maxCount: 0, maxBytes: 0, retentionMs: 1 } });
    expect(r.kind).toBe("committed");
    const state = readOk(f.store);
    expect(state.runs[0]).toMatchObject({ state: "completed", reason: "report-skipped(cap)", note: "pending" });
    expect(state.runs[0]?.reportFile).toBeUndefined();
    expect(state.pendingReports).toHaveLength(0);
  });
  it("feishu off still writes a local report, without an index; foreign epoch writes nothing", async () => {
    const f = await fixture();
    f.task.feishu = false;
    expect((await commitBackgroundReport({ ...f, holder: { ...f.holder, epoch: "foreign" } })).kind).toBe("foreign");
    expect(readOk(f.store).runs[0]?.state).toBe("dispatching");
    await commitBackgroundReport(f);
    expect(readOk(f.store).pendingReports).toHaveLength(0);
    expect(readdirSync(join(f.store.root.real, f.store.dirName, "reports"))).toHaveLength(1);
  });
});
