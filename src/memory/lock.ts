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
import { resolve as resolvePath } from "node:path";
import { MemoryError } from "./paths.js";
import {
  isProcessAlive,
  lockBreak,
  lockCreate,
  lockRead,
  lockRelease,
  readProcIdentity,
  type LockPayload,
} from "./safe-fs.js";

/** M-T4: age is never proof of death. Only a same-host owner whose
 * pid+starttime (or legacy pid alone) is provably dead may be reclaimed;
 * cross-host and unprovable owners require explicit --break-lock. */
const RETRY_MS = 25;
const DEFAULT_TIMEOUT_MS = 2_000;
/** `body` running longer than this WARNs (not an error — the lock is still
 * released normally); a warning never grants permission to break a live lock. */
const SLOW_BODY_WARN_MS = 5_000;

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
 * `RETRY_MS` until `timeoutMs` elapses; only a same-host owner whose
 * process identity is provably dead is broken and re-raced immediately.
 */
export async function withMemoryDirLock<T>(dir: string, body: () => T, opts: MemoryLockOpts = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = opts.log ?? ((message: string) => console.warn(`[pi-subagent] ${message}`));
  const token = randomBytes(8).toString("hex");
  const owner = readProcIdentity(process.pid);
  const payload: LockPayload = {
    pid: process.pid,
    host: hostname(),
    token,
    at: Date.now(),
    ...(owner?.startTicks === undefined ? {} : { startTicks: owner.startTicks }),
    ...(owner?.bootId === undefined ? {} : { bootId: owner.bootId }),
  };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (lockCreate(dir, payload)) break;
    const current = lockRead(dir);
    if (current?.payload !== undefined) {
      const holder = current.payload;
      let dead = false;
      let verified = false;
      if (holder.host === payload.host) {
        const actual = readProcIdentity(holder.pid);
        if (holder.startTicks !== undefined) {
          // A missing /proc record is only proof of death when kill(0) also
          // returns ESRCH; permission failures remain unprovable.
          if (actual === undefined) {
            verified = !isProcessAlive(holder.pid);
            dead = verified;
          } else {
            verified = true;
            dead =
              String(actual.startTicks) !== String(holder.startTicks) ||
              (holder.bootId !== undefined && actual.bootId !== undefined && actual.bootId !== holder.bootId);
          }
        } else {
          verified = true;
          dead = !isProcessAlive(holder.pid);
        }
      } else {
        // Cross-host identity is never provable from this process. M-T4
        // requires refusal regardless of age or the local pid table.
        dead = false;
      }
      if (dead && verified) {
        lockBreak(dir);
        continue; // re-race for the lock immediately, no sleep
      }
    }
    if (Date.now() >= deadline) {
      const holder = current?.payload;
      const since = holder ? new Date(holder.at).toISOString() : "unknown";
      const ownerText = holder === undefined ? "unknown owner" : `pid ${holder.pid} on ${holder.host}`;
      throw new MemoryError(
        `memory dir busy: lock ${resolvePath(dir, ".lock")} is held by ${ownerText} since ${since} (owner cannot be verified) — if no pi process holds it, run /mem tidy --break-lock`,
      );
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
