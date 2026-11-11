/** Stable IDs and standalone file-trash recovery. No legacy tidy backup reader lives here. */
import { join } from "node:path";
import type { MemoryWriteGate } from "./contracts.js";
import { withMemoryDirLock } from "./lock.js";
import { MemoryError, memoryDirFor, type MemoryPaths } from "./paths.js";
import {
  canonicalDir,
  inspectDirNoFollow,
  isV2Name,
  listDirNames,
  moveFileNoClobberStrict,
  statRegularIfExists,
} from "./safe-fs.js";

export const LEGACY_BACKUP_RUNBOOK =
  "https://github.com/Newbluecake/pi-toolkit/blob/dev/docs/guide/memory.md#legacy-tidy-backup-recovery";
export const LEGACY_BACKUP_REFUSAL = [
  "Legacy tidy backups are no longer supported by /mem restore.",
  "Stop all memory writers and pause automatic migration before opening sessions; verify the real memory directory (same environment and symlink target, using /mem path only in an already read-only session).",
  "Make and verify a complete backup including hidden files. Inspect journal/manifest/archive read-only, compare candidate files in a separate directory, then manually select content to recover without overwriting live files.",
  "Keep all journals/manifests/archive; never remove a lock based on age. Do not pass old backup IDs/files to --trash, --block or migrate. Stop on damaged or unknown data.",
  `Safe manual recovery runbook: ${LEGACY_BACKUP_RUNBOOK}`,
].join("\n");

/** Keep the historical millisecond/hex grammar: existing trash and blocks IDs remain readable. */
export function newMemoryId(now: Date, pid: number, rand6: string): string {
  const pad = (n: number, length = 2): string => String(n).padStart(length, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}${pad(now.getUTCMilliseconds(), 3)}Z`;
  return `${stamp}-${pid}-${rand6}`;
}

export function listTrashEntries(dir: string): { id: string; name: string; fileName: string }[] {
  const out: { id: string; name: string; fileName: string }[] = [];
  const re = /^(\d{8}T\d{9}Z-\d+-[0-9a-f]{6})-(.+)$/;
  for (const fileName of listDirNames(join(dir, ".trash"))) {
    const m = re.exec(fileName);
    if (m?.[1] && m[2]) out.push({ id: m[1], name: m[2], fileName });
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** Locked no-clobber restore; old journals/leases/manifests are deliberately not inspected.
 * Conflicts never overwrite live content. The compatibility decision argument accepts only skip.
 */
export async function restoreFromTrash(
  cwd: string,
  id: string,
  _decision: "skip" = "skip",
  paths?: MemoryPaths,
  gate?: MemoryWriteGate,
): Promise<{ restored: boolean; reason?: string }> {
  const dir = canonicalDir(memoryDirFor(cwd, paths))?.real;
  if (!dir) throw new MemoryError(`memory directory for ${cwd} is not accessible`);
  const check = (): void => {
    if (gate && !gate.check(dir).ok) throw new MemoryError("E_WRITE_GATE: memory write refused");
  };
  check();
  return withMemoryDirLock(dir, () => {
    check();
    const parent = inspectDirNoFollow(dir);
    const trash = inspectDirNoFollow(join(dir, ".trash"));
    if (parent.dev !== trash.dev) throw new MemoryError("E_WRITE_GATE: trash device changed");
    const entry = listTrashEntries(dir).find((e) => e.id === id);
    if (!entry) throw new MemoryError(`no trash entry ${id}`);
    if (!isV2Name(entry.name)) throw new MemoryError("INVALID_LOC: unsafe trash filename");
    if (!statRegularIfExists(join(dir, ".trash"), entry.fileName)) throw new MemoryError(`no trash entry ${id}`);
    if (statRegularIfExists(dir, entry.name)) return { restored: false, reason: `${entry.name} already exists` };
    check();
    moveFileNoClobberStrict(dir, join(".trash", entry.fileName), entry.name);
    return { restored: true };
  });
}
