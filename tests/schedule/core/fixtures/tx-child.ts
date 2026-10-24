/**
 * Multi-process admission child (review m1): creates session `<sessionId>` under `<storeDir>` by
 * committing one write and prints the TxResult. Usage: tsx tx-child.ts <storeDir> <sessionId>
 */
import { readSelfIdentity } from "../../../../src/schedule/core/recovery.js";
import { ensureStoreRoot, openSessionStore } from "../../../../src/schedule/core/writer.js";

const [storeDir, sessionId] = process.argv.slice(2) as [string, string];
const store = openSessionStore({
  root: ensureStoreRoot(storeDir),
  sessionId,
  self: readSelfIdentity()!,
  epoch: "child",
});
const r = await store.transact(() => ({ value: 0, write: true }));
process.stdout.write(JSON.stringify(r));
