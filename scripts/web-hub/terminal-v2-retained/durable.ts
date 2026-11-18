/** Tool-only exclusive publication. Caller holds real maintenance ownership and an
 * absolute deadline. Rename-entered failures are unknown, never repaired/deleted. */
import { renameSync } from "node:fs";
import { HeldDirectory, type CapturedFile } from "../terminal-v2-maintenance/files.js";
export function publishRetainedFile(dir: HeldDirectory, name: string, bytes: Buffer, guard: () => void): CapturedFile {
  guard();
  dir.check();
  if (!dir.absent(name) || !dir.absent(`.pending-${name}`)) throw new Error("E_RETAINED_FILE_EXISTS");
  const pending = dir.create(`.pending-${name}`, bytes);
  guard();
  dir.verify(pending);
  renameSync(dir.at(pending.name), dir.at(name));
  dir.sync();
  guard();
  const actual = dir.read(name, bytes.length);
  if (
    actual.fingerprint.dev !== pending.fingerprint.dev ||
    actual.fingerprint.ino !== pending.fingerprint.ino ||
    !actual.bytes.equals(bytes)
  )
    throw new Error("E_RETAINED_FILE_CHANGED");
  dir.verify(actual);
  guard();
  return actual;
}
