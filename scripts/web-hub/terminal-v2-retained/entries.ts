/** Fixed local launcher profile, not a generic shell editor. Unsupported entry
 * syntax refuses. Source/metadata pins are checked before atomic replacement;
 * entry scripts are NOT credential/auth backups. */
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { HeldDirectory, digest, json } from "../terminal-v2-maintenance/files.js";
import { publishRetainedFile } from "./durable.js";
import type { InstallationProfile } from "./installation.js";
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export function retainedLauncherBytes(profile: InstallationProfile, installation: string): Buffer {
  return Buffer.from(
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(profile.newPackageRoot, "dist/maintenance/cli.mjs"))} launch --installation ${quote(installation)} -- "$@"\n`,
  );
}
export function oldLauncherBytes(profile: InstallationProfile): Buffer {
  return Buffer.from(`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(profile.piCli)} "$@"\n`);
}
const meta = (s: Stats) => JSON.stringify([s.dev, s.ino, s.uid, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs]);
function readEntry(dir: HeldDirectory, name: string) {
  dir.check();
  const path = dir.at(name),
    original = lstatSync(path);
  if (
    !original.isFile() ||
    original.uid !== process.getuid?.() ||
    original.nlink !== 1 ||
    (original.mode & 0o777) !== 0o700 ||
    original.size > 16384
  )
    throw new Error("E_RETAINED_LAUNCHER_UNSAFE");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (meta(fstatSync(fd)) !== meta(original)) throw new Error("E_RETAINED_LAUNCHER_CHANGED");
    const b = Buffer.alloc(original.size + 1);
    let n = 0;
    while (n < b.length) {
      const got = readSync(fd, b, n, b.length - n, n);
      if (!got) break;
      n += got;
    }
    if (n !== original.size || meta(fstatSync(fd)) !== meta(original) || meta(lstatSync(path)) !== meta(original))
      throw new Error("E_RETAINED_LAUNCHER_CHANGED");
    return { bytes: b.subarray(0, n), metadata: meta(original), dev: original.dev, ino: original.ino };
  } finally {
    closeSync(fd);
  }
}
export interface InstallationEntries {
  verify(): void;
  seal(installation: HeldDirectory, guard: () => void): void;
  close(): void;
}
export function pinInstallationEntries(profile: InstallationProfile, installation: string): InstallationEntries {
  const parents: HeldDirectory[] = [],
    entries: Array<{ dir: HeldDirectory; name: string; pin: ReturnType<typeof readEntry> }> = [];
  const fixed = retainedLauncherBytes(profile, installation),
    old = oldLauncherBytes(profile);
  try {
    for (const path of profile.launchers) {
      const dir = new HeldDirectory(dirname(path));
      parents.push(dir);
      const name = basename(path),
        pin = readEntry(dir, name);
      if (!pin.bytes.equals(fixed) && !pin.bytes.equals(old)) throw new Error("E_RETAINED_LAUNCHER_PROFILE_UNKNOWN");
      entries.push({ dir, name, pin });
    }
    const verify = () => {
      for (const e of entries) {
        const now = readEntry(e.dir, e.name);
        if (now.metadata !== e.pin.metadata || !now.bytes.equals(e.pin.bytes))
          throw new Error("E_RETAINED_LAUNCHER_CHANGED");
      }
    };
    return {
      verify,
      seal(directory, guard) {
        guard();
        verify();
        const original = entries.map((e) => ({
          path: join(e.dir.path, e.name),
          sha256: digest(e.pin.bytes),
          metadata: e.pin.metadata,
        }));
        // Durable declaration before the FIRST entry replacement. Retry may finish only
        // exact original-or-fixed entries, never adopt arbitrary changed scripts.
        if (directory.absent("entry-seal-prepared.json"))
          publishRetainedFile(directory, "entry-seal-prepared.json", json({ v: 1, entries: original }), guard);
        else {
          const prepared = directory.read("entry-seal-prepared.json", 32768);
          const recorded = JSON.parse(prepared.bytes.toString()) as { v?: unknown; entries?: unknown };
          if (recorded.v !== 1 || !Array.isArray(recorded.entries) || recorded.entries.length !== entries.length)
            throw new Error("E_RETAINED_ENTRY_SEAL_CHANGED");
          for (const [i, e] of entries.entries()) {
            const prior = recorded.entries[i] as { path?: unknown; sha256?: unknown; metadata?: unknown };
            if (
              prior.path !== join(e.dir.path, e.name) ||
              (!e.pin.bytes.equals(fixed) &&
                (prior.sha256 !== digest(e.pin.bytes) || prior.metadata !== e.pin.metadata))
            )
              throw new Error("E_RETAINED_ENTRY_SEAL_CHANGED");
          }
        }
        for (const e of entries) {
          if (e.pin.bytes.equals(fixed)) continue;
          guard();
          verify();
          const pending = e.dir.create(`.pending-${e.name}`, fixed);
          // chmod exact held temp FD before rename, preserving its inode pin.
          const fd = openSync(e.dir.at(pending.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const st = fstatSync(fd);
            if (st.dev !== pending.fingerprint.dev || st.ino !== pending.fingerprint.ino)
              throw new Error("E_RETAINED_LAUNCHER_CHANGED");
            fchmodSync(fd, 0o700);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          guard();
          verify();
          renameSync(e.dir.at(pending.name), e.dir.at(e.name));
          e.dir.sync();
          const actual = readEntry(e.dir, e.name);
          if (
            actual.dev !== pending.fingerprint.dev ||
            actual.ino !== pending.fingerprint.ino ||
            !actual.bytes.equals(fixed)
          )
            throw new Error("E_RETAINED_LAUNCHER_CHANGED");
          e.pin = actual;
          guard();
          verify();
        }
        for (const e of entries) {
          guard();
          e.dir.sync();
        }
        directory.sync();
        guard();
        verify();
      },
      close() {
        for (const dir of parents.reverse()) dir.close();
      },
    };
  } catch (e) {
    for (const dir of parents.reverse()) dir.close();
    throw e;
  }
}
