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
async function fixture() {
  const e = env(Date.now());
  envs.push(e);
  const store = e.store();
  const task = approve(makeTask());
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
  it("bounds UTF-8 bytes, leaves valid text and atomically creates terminal/index", async () => {
    const f = await fixture();
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
    }
    expect(truncateUtf8("a😀中", 5)).toBe("a😀");
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
