// Run lease storage for tidy batch (P2a §10.1).  This module deliberately
// has no filesystem imports: all path and syscall policy lives in safe-fs.
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import {
  createFsyncWarningState,
  createTxnExclusive,
  fsyncDirBestEffort,
  isProcessAlive,
  readProcIdentity,
  readRegular,
  replaceAtomic,
  statRegularIfExists,
  unlinkRegular,
  writeTxnTemp,
} from "../safe-fs.js";

export const LEASE_NAME = ".tidy-run.json";

export interface LeasePayload {
  pid: number;
  host: string;
  token: string;
  at: number;
  epoch: number;
  draining: readonly string[];
  startTicks?: number | string;
  bootId?: string;
}

export interface LeaseRecord {
  payload: LeasePayload;
  mtimeMs: number;
}

function validPayload(value: unknown): value is LeasePayload {
  if (value === null || typeof value !== "object") return false;
  const p = value as Partial<LeasePayload>;
  return (
    typeof p.pid === "number" &&
    Number.isSafeInteger(p.pid) &&
    p.pid > 0 &&
    typeof p.host === "string" &&
    typeof p.token === "string" &&
    typeof p.at === "number" &&
    Number.isFinite(p.at) &&
    typeof p.epoch === "number" &&
    Number.isSafeInteger(p.epoch) &&
    p.epoch >= 0 &&
    Array.isArray(p.draining) &&
    p.draining.every((id) => typeof id === "string") &&
    (p.startTicks === undefined || typeof p.startTicks === "string" || typeof p.startTicks === "number") &&
    (p.bootId === undefined || typeof p.bootId === "string")
  );
}

/** O_EXCL-equivalent lease acquisition. A complete payload is linked into
 * place, so a normal hard-link-capable filesystem never exposes a partial
 * lease after a process crash. Crash state: only the complete lease or its
 * private staged tmp can remain. */
export function leaseCreate(dir: string, payload: LeasePayload): boolean {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const tmp = writeTxnTemp(dir, "e", bytes);
  try {
    try {
      createTxnExclusive(dir, tmp, LEASE_NAME);
      return true;
    } catch (err) {
      if (err instanceof Error && /already exists/.test(err.message)) return false;
      throw err;
    }
  } finally {
    try {
      unlinkRegular(dir, tmp);
    } catch {
      /* consumed or unavailable */
    }
  }
}

export function leaseRead(dir: string): LeaseRecord | undefined {
  let stat;
  try {
    stat = statRegularIfExists(dir, LEASE_NAME);
  } catch {
    return undefined;
  }
  if (stat === undefined) return undefined;
  try {
    const raw = readRegular(dir, LEASE_NAME).text;
    const parsed: unknown = JSON.parse(raw);
    if (!validPayload(parsed)) return undefined;
    return { payload: parsed, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

/** Refresh is token scoped. A missing or differently-owned lease is a no-op.
 * Crash state: rename leaves either the old complete lease or the new complete
 * lease; the staged tmp is otherwise recoverable as an orphan. */
export function leaseRefresh(dir: string, payload: LeasePayload): boolean {
  const current = leaseRead(dir);
  if (current?.payload.token !== payload.token) return false;
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const tmp = writeTxnTemp(dir, "e", bytes);
  const fsyncWarnings = createFsyncWarningState();
  try {
    replaceAtomic(dir, tmp, LEASE_NAME);
    fsyncDirBestEffort(dir, undefined, fsyncWarnings);
    return true;
  } finally {
    try {
      unlinkRegular(dir, tmp);
    } catch {
      /* consumed */
    }
  }
}

/** Crash state: release leaves the complete lease or an absent entry; it
 * never removes a lease with another token. */
export function leaseRelease(dir: string, token: string): boolean {
  if (leaseRead(dir)?.payload.token !== token) return false;
  try {
    unlinkRegular(dir, LEASE_NAME);
    fsyncDirBestEffort(dir, undefined, createFsyncWarningState());
    return true;
  } catch {
    return false;
  }
}

/** Explicit break only; automatic callers should never invoke this. */
export function leaseBreak(dir: string): boolean {
  try {
    unlinkRegular(dir, LEASE_NAME);
    fsyncDirBestEffort(dir, undefined, createFsyncWarningState());
    return true;
  } catch {
    return false;
  }
}

export function makeLeasePayload(epoch = 0, draining: readonly string[] = []): LeasePayload {
  const identity = readProcIdentity(process.pid);
  return {
    pid: process.pid,
    host: hostname(),
    token: randomBytes(8).toString("hex"),
    at: Date.now(),
    epoch,
    draining: [...draining],
    ...(identity?.startTicks === undefined ? {} : { startTicks: identity.startTicks }),
    ...(identity?.bootId === undefined ? {} : { bootId: identity.bootId }),
  };
}

/** Conservative owner check shared by recovery and status: cross-host,
 * malformed, or pid-reused owners are never declared dead automatically. */
export function leaseOwnerAlive(record: LeaseRecord): boolean | undefined {
  const p = record.payload;
  if (p.host !== hostname()) return undefined;
  const identity = readProcIdentity(p.pid);
  if (identity === undefined) return isProcessAlive(p.pid) ? true : false;
  if (p.startTicks !== undefined && String(identity.startTicks) !== String(p.startTicks)) return false;
  if (p.bootId !== undefined && identity.bootId !== undefined && identity.bootId !== p.bootId) return false;
  return true;
}
