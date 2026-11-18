/** Exclusive terminal-only backup. Unknown/failed writes remain partial; never GC,
 * overwrite or restore. This function does not establish producer sealing itself. */
import { renameSync } from "node:fs";
import { HeldDirectory, digest, json, type CapturedFile } from "../terminal-v2-maintenance/files.js";
import type { TerminalSourceSnapshot } from "./snapshot.js";
export interface TerminalBackup {
  manifestSha256: string;
  completeSha256: string;
  verify(): void;
}
export function backupTerminalSource(
  snapshot: TerminalSourceSnapshot,
  destination: HeldDirectory,
  guard: () => void,
): TerminalBackup {
  const check = () => {
    guard();
    snapshot.verify();
    destination.check();
  };
  check();
  if (destination.names().length) throw new Error("E_BACKUP_NOT_EMPTY");
  const copies: CapturedFile[] = [];
  const publish = (name: string, bytes: Buffer) => {
    check();
    if (!destination.absent(name) || !destination.absent(`.pending-${name}`)) throw new Error("E_BACKUP_EXISTS");
    const pending = destination.create(`.pending-${name}`, bytes);
    check();
    destination.verify(pending);
    renameSync(destination.at(pending.name), destination.at(name));
    destination.sync();
    check();
    const actual = destination.read(name, bytes.length);
    if (
      actual.fingerprint.dev !== pending.fingerprint.dev ||
      actual.fingerprint.ino !== pending.fingerprint.ino ||
      !actual.bytes.equals(bytes)
    )
      throw new Error("E_BACKUP_CHANGED");
    copies.push(actual);
    return actual;
  };
  const index: Array<{ source: string; backup: string; sha256: string }> = [];
  for (const [n, f] of [...snapshot.files.values()]
    .sort((a, b) => (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0))
    .entries()) {
    const name = `file-${String(n).padStart(4, "0")}`;
    publish(name, f.bytes);
    index.push({ source: f.entry.path, backup: name, sha256: f.entry.sha256 });
  }
  const manifest = publish("source-manifest.json", json(snapshot.manifest));
  if (manifest.fingerprint.sha256 !== snapshot.manifestSha256) throw new Error("E_SOURCE_MANIFEST_CHANGED");
  const indexFile = publish(
    "backup-index.json",
    json({ v: 1, sourceManifestSha256: snapshot.manifestSha256, files: index }),
  );
  const complete = publish(
    "backup-complete.json",
    json({
      v: 1,
      kind: "terminal-retained-backup",
      sourceManifestSha256: snapshot.manifestSha256,
      indexSha256: digest(indexFile.bytes),
      files: index.length,
    }),
  );
  const expected = copies.map((f) => f.name).sort();
  const verify = () => {
    check();
    // Dedicated backup directory has at most 515 fixed names. HeldDirectory's
    // ordinary 256-name helper is intentionally not relaxed for other tools.
    for (const file of copies) destination.verify(file);
    check();
  };
  // Full exact listing through the held fd (a source snapshot supports 512 files).
  verifyBackupMembership(destination, expected);
  verify();
  destination.sync();
  verify();
  return {
    manifestSha256: snapshot.manifestSha256,
    completeSha256: complete.fingerprint.sha256,
    verify() {
      verifyBackupMembership(destination, expected);
      verify();
    },
  };
}
import { readdirSync } from "node:fs";
function verifyBackupMembership(dir: HeldDirectory, expected: string[]) {
  dir.check();
  const names = readdirSync(`/proc/self/fd/${dir.fd}`).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error("E_BACKUP_CHANGED");
}
