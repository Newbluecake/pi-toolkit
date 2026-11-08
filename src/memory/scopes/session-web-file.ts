import type { BigIntStats } from "node:fs";
/** Read-only guard for the entire JSONL; never creates or repairs a session file. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, basename, join } from "node:path";

export class SessionWebFileError extends Error {
  constructor(
    readonly code: "E_MEM_FILE_TOO_LARGE" | "E_WRITE_GATE",
    readonly changed = false,
  ) {
    super(code);
  }
}
const maxBytes = 8 * 1024 * 1024;
function stamp(s: BigIntStats): string {
  return JSON.stringify([
    String(s.dev),
    String(s.ino),
    String(s.size),
    String(s.mtimeNs),
    String(s.ctimeNs),
    String(s.mode),
  ]);
}
export function observeSessionWebFile(path: string, check: () => void): string {
  check();
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new SessionWebFileError("E_WRITE_GATE");
    check();
    const parent = realpathSync(dirname(path));
    check();
    const ps = lstatSync(parent, { bigint: true });
    check();
    if (!ps.isDirectory()) throw new SessionWebFileError("E_WRITE_GATE");
    // Verify absence after resolving the parent; a concurrently created file cannot pass.
    try {
      lstatSync(path);
      throw new SessionWebFileError("E_WRITE_GATE", true);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    check();
    return JSON.stringify(["absent", join(parent, basename(path)), String(ps.dev), String(ps.ino)]);
  }
  check();
  if (!before.isFile() || before.isSymbolicLink()) throw new SessionWebFileError("E_WRITE_GATE", true);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    check();
    const opened = fstatSync(fd, { bigint: true });
    check();
    if (!opened.isFile() || stamp(before) !== stamp(opened)) throw new SessionWebFileError("E_WRITE_GATE", true);
    if (opened.size > BigInt(maxBytes)) throw new SessionWebFileError("E_MEM_FILE_TOO_LARGE");
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      check();
      const n = readSync(fd, buf, 0, buf.length, null);
      check();
      if (!n) break;
      total += n;
      if (total > maxBytes) throw new SessionWebFileError("E_MEM_FILE_TOO_LARGE");
      hash.update(buf.subarray(0, n));
    }
    check();
    const after = fstatSync(fd, { bigint: true });
    check();
    const tail = lstatSync(path, { bigint: true });
    check();
    const canonical = realpathSync(path);
    check();
    if (BigInt(total) !== opened.size || stamp(opened) !== stamp(after) || stamp(opened) !== stamp(tail))
      throw new SessionWebFileError("E_WRITE_GATE", true);
    return JSON.stringify(["file", canonical, stamp(opened), hash.digest("hex")]);
  } finally {
    closeSync(fd);
  }
}
