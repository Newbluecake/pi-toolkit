/**
 * Fault-matrix child (scheduled-reports plan r3 §14 「故障注入」, I1): drives ONE manual run through the three
 * ledger phases the background executor performs — claim → running → terminal report — and SIGKILLs itself
 * at `<phase>:<writer point>`. Usage: tsx schedule-matrix-child.ts <storeDir> <sid> <taskId> <phase:point|none>
 */
import { createHash } from "node:crypto";
import { manualClaim } from "../../../src/schedule/core/claim.js";
import { holderOf, readSelfIdentity } from "../../../src/schedule/core/recovery.js";
import {
  addPendingReport,
  ensureStoreRoot,
  finishRun,
  openSessionStore,
  pendingReportFor,
  updateRun,
  writeReportLocked,
  type WriterFaultPoint,
} from "../../../src/schedule/core/writer.js";

const [storeDir, sessionId, taskId, mode] = process.argv.slice(2) as [string, string, string, string];
const [targetPhase, targetPoint] = mode.split(":") as [string, WriterFaultPoint | undefined];
let phase = "claim";
const self = readSelfIdentity()!;
const holder = holderOf(self, "child");
const store = openSessionStore({
  root: ensureStoreRoot(storeDir),
  sessionId,
  self,
  epoch: "child",
  faults: (p) => {
    if (phase === targetPhase && p === targetPoint) process.kill(process.pid, "SIGKILL");
  },
});
const claim = await manualClaim(store, { taskId, reqId: "matrix_request_123456", holder });
if (claim.kind !== "started" || !claim.run) throw new Error(`claim: ${JSON.stringify(claim)}`);
const runKey = claim.run.runKey;
phase = "running";
await store.transact((d) => ({ value: updateRun(d, runKey, { state: "running", runId: "r_matrix" }), write: true }));
phase = "report";
const reportFile = `reports/${createHash("sha256").update(runKey).digest("hex")}.md`;
await writeReportLocked(store, {
  reportFile,
  data: Buffer.from("# matrix report\n\nbody\n", "utf8"),
  now: Date.now(),
  commit: (draft, ctx, written) => {
    const out = finishRun(draft, runKey, { state: "completed", ...(written ? { reportFile } : {}) }, ctx.now);
    const rec = draft.runs.find((r) => r.runKey === runKey);
    if (out === "ok" && written && rec) addPendingReport(draft, pendingReportFor(sessionId, rec, "completed"), ctx.now);
    return { value: out, write: out === "ok" };
  },
});
process.stdout.write(JSON.stringify({ runKey, reportFile }));
