/**
 * Persistent, fail-safe admission for the DB breaker's hub self-restart.
 *
 * This is intentionally a tiny synchronous store: the breaker callback runs in
 * the hub event loop and must decide before entering the existing admin close
 * path. A missing file is the only normal read failure (the first restart).
 * Every other read/parse/validation/write failure disables self-restart for
 * this process. The file is replaced atomically and is always mode 0600.
 */
import { chmodSync, closeSync, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

export const SELF_RESTART_WINDOW_MS = 60 * 60 * 1000;
export const SELF_RESTART_MAX_PER_WINDOW = 2;
const MAX_TIMESTAMPS = 4;
export const MAX_SELF_RESTART_FILE_BYTES = 4 * 1024;

type RecordShape = { v: 1; timestamps: number[] };

export type SelfRestartDecision =
  | { allowed: true; timestamps: number[] }
  | { allowed: false; reason: "invalid-state" | "clock-backwards" | "limit" | "write-failed" };

export interface SelfRestartStore {
  tryAcquire(now: number): SelfRestartDecision;
}

function validRecord(value: unknown): value is RecordShape {
  if (value === null || typeof value !== "object") return false;
  const record = value as { v?: unknown; timestamps?: unknown };
  if (record.v !== 1 || !Array.isArray(record.timestamps) || record.timestamps.length > MAX_TIMESTAMPS) return false;
  let previous = -Infinity;
  for (const timestamp of record.timestamps) {
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp < 0 || timestamp < previous) {
      return false;
    }
    previous = timestamp;
  }
  return true;
}

function readRecord(path: string): RecordShape | undefined | SelfRestartDecision {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SELF_RESTART_FILE_BYTES) {
      return { allowed: false, reason: "invalid-state" };
    }
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.subarray(0, offset).toString("utf8"));
    } catch {
      return { allowed: false, reason: "invalid-state" };
    }
    return validRecord(parsed) ? parsed : { allowed: false, reason: "invalid-state" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return { allowed: false, reason: "invalid-state" };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The read already failed or completed; admission remains fail-safe.
      }
    }
  }
}

function writeRecord(path: string, record: RecordShape): boolean {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    // chmod after rename also repairs a pre-existing path on filesystems that
    // preserve the target inode in unusual test doubles.
    chmodSync(path, 0o600);
    return true;
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // Best effort; the admission decision remains fail-safe.
    }
    return false;
  }
}

export function createSelfRestartStore(path: string): SelfRestartStore {
  let disabled = false;
  return {
    tryAcquire(now) {
      if (disabled || !Number.isFinite(now) || now < 0) {
        disabled = true;
        return { allowed: false, reason: "invalid-state" };
      }
      const loaded = readRecord(path);
      if (loaded !== undefined && "allowed" in loaded) {
        disabled = true;
        return loaded;
      }
      const timestamps = loaded?.timestamps ?? [];
      const newest = timestamps[timestamps.length - 1];
      if (newest !== undefined && now < newest) {
        disabled = true;
        return { allowed: false, reason: "clock-backwards" };
      }
      const fresh = timestamps.filter((timestamp) => now - timestamp < SELF_RESTART_WINDOW_MS);
      if (fresh.length >= SELF_RESTART_MAX_PER_WINDOW) {
        return { allowed: false, reason: "limit" };
      }
      const next = [...fresh, now].slice(-MAX_TIMESTAMPS);
      if (!writeRecord(path, { v: 1, timestamps: next })) {
        disabled = true;
        return { allowed: false, reason: "write-failed" };
      }
      return { allowed: true, timestamps: next };
    },
  };
}
