import type { BigIntStats } from "node:fs";
/** Read-only guard for the entire JSONL; never creates or repairs a session file. */
import {
  openSessionObservationFile,
  lstatSessionObservation,
  lstatSessionObservationExists,
  fstatSessionObservation,
  readSessionObservationChunk,
  closeSessionObservation,
  realpathSessionObservation,
} from "../safe-fs.js";
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
    before = lstatSessionObservation(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new SessionWebFileError("E_WRITE_GATE");
    check();
    const parent = realpathSessionObservation(dirname(path));
    check();
    const ps = lstatSessionObservation(parent);
    check();
    if (!ps.isDirectory()) throw new SessionWebFileError("E_WRITE_GATE");
    // Verify absence after resolving the parent; a concurrently created file cannot pass.
    try {
      lstatSessionObservationExists(path);
      throw new SessionWebFileError("E_WRITE_GATE", true);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    check();
    return JSON.stringify(["absent", join(parent, basename(path)), String(ps.dev), String(ps.ino)]);
  }
  check();
  if (!before.isFile() || before.isSymbolicLink()) throw new SessionWebFileError("E_WRITE_GATE", true);
  const fd = openSessionObservationFile(path);
  try {
    check();
    const opened = fstatSessionObservation(fd);
    check();
    if (!opened.isFile() || stamp(before) !== stamp(opened)) throw new SessionWebFileError("E_WRITE_GATE", true);
    if (opened.size > BigInt(maxBytes)) throw new SessionWebFileError("E_MEM_FILE_TOO_LARGE");
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      check();
      const n = readSessionObservationChunk(fd, buf);
      check();
      if (!n) break;
      total += n;
      if (total > maxBytes) throw new SessionWebFileError("E_MEM_FILE_TOO_LARGE");
      hash.update(buf.subarray(0, n));
    }
    check();
    const after = fstatSessionObservation(fd);
    check();
    const tail = lstatSessionObservation(path);
    check();
    const canonical = realpathSessionObservation(path);
    check();
    if (BigInt(total) !== opened.size || stamp(opened) !== stamp(after) || stamp(opened) !== stamp(tail))
      throw new SessionWebFileError("E_WRITE_GATE", true);
    return JSON.stringify(["file", canonical, stamp(opened), hash.digest("hex")]);
  } finally {
    closeSessionObservation(fd);
  }
}
