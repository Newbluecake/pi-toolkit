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
  WriterFaultPoint | "lock-hold-wait",
];
const self = readSelfIdentity()!;
const store = openSessionStore({
  root: ensureStoreRoot(storeDir),
  sessionId,
  self,
  epoch: "child",
  faults: (p: WriterFaultPoint) => {
    // `lock-hold-wait` (race test): hold the kernel lock and BLOCK until the test SIGKILLs us, so the victim
    // can never exit by itself before the kill (the old self-kill raced the other children's win).
    if (p === "lock-held" && (point as string) === "lock-hold-wait") {
      process.stdout.write("HELD\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    if (p === point) process.kill(process.pid, "SIGKILL");
  },
});
const r = await autoClaim(store, { taskId, t: Number(tText), armedSince: 0, holder: holderOf(self, "child") });
process.stdout.write(JSON.stringify(r));
