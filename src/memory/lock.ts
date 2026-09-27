// Directory-scoped mutual exclusion for the memory module (optimize-plan
// §3.2, todo #22 P0-b). ALL memory-directory mutations (v2 create/
// str_replace/insert/delete/rename/write/append, tidy apply, `--frontmatter`
// apply, restore, `/mem import`) run their synchronous `body` inside
// `withMemoryDirLock` so two concurrent callers on the same canonical
// directory never interleave. Reads (view/search/list, injection, doctor)
// never take the lock — they only ever see a fully-replaced file (renameSync
// is atomic), at worst a stale-but-whole version.
//
// Zero `node:fs` import (enforced by tests/memory/fs-guard.test.ts): every
// filesystem touch goes through `safe-fs.ts`'s lock-file primitives; this
// file only adds `node:os`'s `hostname()`, `node:crypto`'s `randomBytes` (a
// token, not an fs op), and unref'd retry timers.

import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { MemoryError } from "./paths.js";
import { lockBreak, lockCreate, lockRead, lockRelease, type LockPayload } from "./safe-fs.js";

/** A lock file older than this (by mtime) is presumed abandoned. Comfortably
 *  above the slow-body WARN threshold so a merely-slow body never trips it. */
const STALE_MS = 30_000;
const RETRY_MS = 25;
const DEFAULT_TIMEOUT_MS = 2_000;
/** `body` running longer than this WARNs (not an error — the lock is still
 *  released normally); set well under STALE_MS so a warned run never
 *  self-triggers another caller's stale-break. */
const SLOW_BODY_WARN_MS = 5_000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process ⇒ dead; any other errno (e.g. EPERM, a live
    // process owned by another user) means "can't tell, assume alive".
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export interface MemoryLockOpts {
  /** Total time to wait for the lock before throwing. Default 2000ms. */
  timeoutMs?: number;
  log?: (message: string) => void;
}

/**
 * Run `body` (which MUST be synchronous — no `await` inside it, so a
 * concurrent `before_agent_start` read can never observe a half-applied
 * change) with the canonical memory directory `dir` locked. Retries every
 * `RETRY_MS` until `timeoutMs` elapses; a lock whose file is stale (mtime
 * older than `STALE_MS`, or owned by a same-host dead pid) is broken and
 * re-raced immediately.
 */
export async function withMemoryDirLock<T>(dir: string, body: () => T, opts: MemoryLockOpts = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = opts.log ?? ((message: string) => console.warn(`[pi-subagent] ${message}`));
  const token = randomBytes(8).toString("hex");
  const payload: LockPayload = { pid: process.pid, host: hostname(), token, at: Date.now() };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (lockCreate(dir, payload)) break;
    const current = lockRead(dir);
    if (current) {
      const staleByAge = Date.now() - current.mtimeMs > STALE_MS;
      const staleByDeadPid =
        current.payload !== undefined && current.payload.host === payload.host && !isProcessAlive(current.payload.pid);
      if (staleByAge || staleByDeadPid) {
        lockBreak(dir);
        continue; // re-race for the lock immediately, no sleep
      }
    }
    if (Date.now() >= deadline) {
      const holder = current?.payload;
      const since = holder ? new Date(holder.at).toISOString() : "unknown";
      throw new MemoryError(`memory dir busy (lock held by pid ${holder?.pid ?? "?"} since ${since}); retry`);
    }
    await sleep(RETRY_MS);
  }
  const start = Date.now();
  try {
    return body();
  } finally {
    const elapsed = Date.now() - start;
    if (elapsed > SLOW_BODY_WARN_MS) log(`memory dir lock held for ${elapsed}ms (dir: ${dir})`);
    lockRelease(dir, token);
  }
}
