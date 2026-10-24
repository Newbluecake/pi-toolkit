import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { recoverRuns } from "../../src/schedule/core/claim.js";
import { sessionDirName } from "../../src/schedule/core/paths.js";
import { isTerminalRunState } from "../../src/schedule/core/spec.js";
import { gcSessionReports, SESSION_GC_CAPS } from "../../src/schedule/core/writer.js";
import { addTask, approve, env, makeTask, readOk, self, SID, type Env } from "../schedule/core/fixtures.js";

/**
 * scheduled-reports I1 (plan r3 §14 「故障注入矩阵」): a real child process SIGKILLs itself at every ledger
 * write point of ONE background run's lifecycle — claim, `running`, and the terminal report commit
 * (report file → state tmp → rename). After each kill (and after the next process's recovery) the outcome
 * may only be: nothing claimed / a recoverable non-terminal run that becomes `unknown(crash)` / a complete
 * terminal run — and an unindexed report file is never referenced (GC reaps it), an indexed one always is.
 * NEVER a silent loss (a run that exists in no state, or a pending index entry whose report file is missing).
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CHILD = join(ROOT, "tests/integration/fixtures/schedule-matrix-child.ts");
let E: Env;
afterEach(() => E?.cleanup());

async function drive(mode: string) {
  E = env(Date.now());
  const store = E.store();
  const task = approve(makeTask({ when: { kind: "cron", expr: "0 8 * * *", tz: "UTC" }, ownerCwd: E.dir }));
  await addTask(store, task, Date.now() - 3_600_000);
  const res = spawnSync(process.execPath, ["--import", "tsx", CHILD, E.storeDir, SID, task.id, mode], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 40_000,
  });
  const dir = join(E.storeDir, sessionDirName(SID));
  return { store, task, res, dir };
}

type Row = {
  mode: string;
  /** state of the run right after the kill (undefined ⇒ the claim never became durable). */
  before: string | undefined;
  /** state after the NEXT process's recoverRuns. */
  after: string | undefined;
  report: "none" | "orphan-file" | "indexed";
};
const MATRIX: Row[] = [
  { mode: "claim:lock-held", before: undefined, after: undefined, report: "none" },
  { mode: "claim:tmp-written", before: undefined, after: undefined, report: "none" },
  { mode: "claim:renamed", before: "dispatching", after: "unknown", report: "none" },
  { mode: "running:lock-held", before: "dispatching", after: "unknown", report: "none" },
  { mode: "running:tmp-written", before: "dispatching", after: "unknown", report: "none" },
  { mode: "running:renamed", before: "running", after: "unknown", report: "none" },
  { mode: "report:lock-held", before: "running", after: "unknown", report: "none" },
  { mode: "report:tmp-written", before: "running", after: "unknown", report: "orphan-file" },
  { mode: "report:renamed", before: "completed", after: "completed", report: "indexed" },
];

describe("fault-injection matrix (real SIGKILL at every ledger write point of one run)", () => {
  for (const row of MATRIX) {
    it(`${row.mode}: run ${row.before ?? "never claimed"} → ${row.after ?? "still undecided"}; report ${row.report}`, async () => {
      const { store, res, dir } = await drive(row.mode);
      expect(res.signal).toBe("SIGKILL");
      const s0 = readOk(store);
      expect(s0.runs.map((r) => r.state)).toEqual(row.before === undefined ? [] : [row.before]);
      // the pending index and the report file always agree: indexed ⇒ file exists; no index entry ⇒ never indexed
      const indexed = s0.pendingReports.length;
      expect(indexed).toBe(row.report === "indexed" ? 1 : 0);
      const reportsDir = join(dir, "reports");
      const files = existsSync(reportsDir) ? readdirSync(reportsDir) : [];
      expect(files.length).toBe(row.report === "none" ? 0 : 1);
      if (row.report === "indexed") {
        expect(s0.runs[0]!.reportFile).toBeDefined();
        expect(files).toContain(s0.runs[0]!.reportFile!.slice("reports/".length));
      } else if (row.report === "orphan-file") {
        expect(s0.runs[0]!.reportFile).toBeUndefined(); // written but never referenced
      }

      // the next process recovers: a non-terminal run of the dead holder becomes unknown(crash); terminal stays
      const rec = await recoverRuns(store, self());
      const s1 = readOk(store);
      expect(s1.runs.map((r) => r.state)).toEqual(row.after === undefined ? [] : [row.after]);
      if (row.after === "unknown") {
        expect(s1.runs[0]).toMatchObject({ state: "unknown", reason: "crash" });
        expect(rec.runs).toHaveLength(1);
      }
      for (const r of s1.runs) expect(isTerminalRunState(r.state)).toBe(true); // no run is left in limbo

      // an orphan report file (never indexed) is reaped by GC once past retention; an indexed one never is
      const gc = await gcSessionReports(
        store,
        Date.now() +
          (row.report === "indexed" ? 2 : 0) * 3_600_000 +
          (row.report === "indexed" ? 0 : SESSION_GC_CAPS.retentionMs + 3_600_000),
      );
      expect(gc).toMatchObject({ ok: true });
      const after = existsSync(reportsDir) ? readdirSync(reportsDir) : [];
      // (an indexed report is referenced by pendingReports: 2 h later it is still there, awaiting the hub's receipt)
      expect(after.length).toBe(row.report === "indexed" ? 1 : 0);
    }, 60_000);
  }

  it("control: without a fault the whole lifecycle completes, indexes the report once and recovery changes nothing", async () => {
    const { store, res, dir } = await drive("none");
    expect(res.status).toBe(0);
    const s = readOk(store);
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]).toMatchObject({ state: "completed" });
    expect(s.pendingReports).toHaveLength(1);
    expect(existsSync(join(dir, "reports"))).toBe(true);
    const rec = await recoverRuns(store, self());
    expect(rec.runs).toHaveLength(0);
  }, 60_000);
});
