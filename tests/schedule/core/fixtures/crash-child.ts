/**
 * Fault-injection child (scheduled-reports plan r3 §14 「故障注入」): runs ONE auto claim against a
 * real store and SIGKILLs itself at the requested writer fault point. Usage:
 *   tsx crash-child.ts <storeDir> <sessionId> <taskId> <T> <point>
 */
import { autoClaim } from "../../../../src/schedule/core/claim.js";
import { holderOf, readSelfIdentity } from "../../../../src/schedule/core/recovery.js";
import { ensureStoreRoot, openSessionStore, type WriterFaultPoint } from "../../../../src/schedule/core/writer.js";

const [storeDir, sessionId, taskId, tText, point] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  WriterFaultPoint,
];
const self = readSelfIdentity()!;
const store = openSessionStore({
  root: ensureStoreRoot(storeDir),
  sessionId,
  self,
  epoch: "child",
  faults: (p) => {
    if (p === point) process.kill(process.pid, "SIGKILL");
  },
});
const r = await autoClaim(store, { taskId, t: Number(tText), armedSince: 0, holder: holderOf(self, "child") });
process.stdout.write(JSON.stringify(r));
