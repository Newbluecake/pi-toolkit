/**
 * Scheduled tasks — cross-process locks (plan r3 §4.5/§4.7, S1; security review B1/M6 rework).
 *
 * KERNEL mutex: flock(2) on a lock file, held for the WHOLE synchronous body. Node has no flock(2),
 * so — exactly like `src/secure/settings-lock.ts` — a short-lived `flock -x -n -E 75 3` child runs
 * on OUR descriptor (stdio slot 3): flock locks belong to the open file description, so the lock
 * outlives the child and is released only when we close the fd — or when this process dies (the
 * kernel closes it; libuv opens every fd O_CLOEXEC, so no other child inherits it).
 *
 * Consequences (why B1 / M6 cannot recur):
 *   - there is NO stale-lock reclamation at all: a crashed holder releases by dying; nobody ever
 *     renames/unlinks a lock to "break" it, so no breaker can remove a live lock;
 *   - a live holder (any host-local process, alive or wedged) ⇒ `E_BUSY` after the deadline; there
 *     is no forced-break entry point (repair goes through the same lock).
 * The lock file itself is never removed except by `recycleSessionDir` as the LAST action of its
 * locked body; a waiter that flocked an unlinked inode notices (fd dev/ino ≠ path) and retries.
 *
 * Non-blocking polling (`-n`, retry every 25 ms) keeps the event loop free; the deadline runs on
 * the monotonic clock. The retry timer is deliberately REF'd: an unref'd wait lets a process whose
 * only pending work is this transaction exit mid-wait (Node exit 13, the claim silently never
 * happens); the wait is bounded by `timeoutMs`, so it can never wedge print mode. Holder identity is written into the lock file only as
 * a diagnostic for the E_BUSY message. Missing `flock` binary ⇒ fail closed (`E_BUSY` + reason).
 *
 * Darwin (P3): macOS has no `flock(1)`, so the same kernel lock is taken via a short-lived `perl`
 * child running `flock(2)` through `Fcntl` — on OUR descriptor (stdio slot 3, `open("+<&=3")` dups
 * fd 3 onto the same open file description). Lock ownership semantics are identical to the Linux
 * backend, so the B1/M6 argument above transfers unchanged: no stale reclamation, no forced
 * break, a crashed holder releases by dying. The perl child runs with a fixed minimal `PATH` (no
 * `PERL5OPT`/`PERL5LIB` inheritance); missing/timeout/signal/unexpected-exit perl ⇒ fail closed
 * with a fixed detail (never `busy`: an unknown lock state must not be guessed).
 */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { fdPath } from "./paths.js";
import { SCHED_LOCK_FILE } from "./spec.js";

const O_NOFOLLOW: number = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
export const SCHED_LOCK_RETRY_MS = 25;
export const SCHED_LOCK_TIMEOUT_MS = 2_000;
export const SCHED_LOCK_SHUTDOWN_TIMEOUT_MS = 500;
/** Store-level admission lock (session-directory cap, m1). */
export const SCHED_STORE_LOCK_FILE = ".store.lock";
const FLOCK_CONFLICT_EXIT = 75;
const HOLDER_INFO_MAX = 1024;

export type AcquireResult = "held" | "busy" | { kind: "fail"; detail: string };
/** Synchronous lock attempt on `fd`; on `held` the lock belongs to that fd's open file description. */
export type LockAcquire = (fd: number) => AcquireResult;
export interface AcquireDeps {
  spawn?: typeof spawnSync;
  timeoutMs?: number;
}

/** Perl `flock(2)` script — the single source of truth shared by `perlFlockAcquire` and the darwin
 * startup probe (plan P3-a). `open("+<&=3")` dups fd 3 onto the SAME open file description, so the
 * kernel lock outlives the perl child and is released only when OUR fd closes. `-MFcntl=:flock`
 * exports LOCK_EX/LOCK_NB; Errno is imported explicitly (`-MErrno=…`) and compared numerically
 * (`$!==X` parses as `$! == X`) — no `%!`/`$!{…}` hash-key lookups (plan revision #8). */
export const PERL_FLOCK_SCRIPT =
  'open(my $fh, "+<&=3") or exit 2; flock($fh, LOCK_EX|LOCK_NB) and exit 0; exit(($!==EWOULDBLOCK || $!==EAGAIN) ? 75 : 3)';
export const PERL_FLOCK_ARGS = ["-MFcntl=:flock", "-MErrno=EWOULDBLOCK,EAGAIN", "-e", PERL_FLOCK_SCRIPT] as const;
const PERL_ENV: Readonly<Record<string, string>> = Object.freeze({ PATH: "/usr/bin:/bin" });

/** `flock -x -n -E 75 3` child on our descriptor (stdio slot 3). */
export function linuxFlockAcquire(flockBin = "flock", deps: AcquireDeps = {}): LockAcquire {
  const spawn = deps.spawn ?? spawnSync;
  const timeout = deps.timeoutMs ?? 5_000;
  return (fd) => {
    const r = spawn(flockBin, ["-x", "-n", "-E", String(FLOCK_CONFLICT_EXIT), "3"], {
      stdio: ["ignore", "ignore", "ignore", fd],
      timeout,
    });
    if (r.error !== undefined) {
      return {
        kind: "fail",
        detail: code(r.error) === "ENOENT" ? "flock binary not found (fail closed)" : `flock: ${String(r.error)}`,
      };
    }
    if (r.status === FLOCK_CONFLICT_EXIT) return "busy";
    if (r.status !== 0) return { kind: "fail", detail: `flock exited ${String(r.status ?? r.signal)}` };
    return "held";
  };
}

/** `flock(2)` via a perl child on our descriptor (stdio slot 3) — the Darwin lock backend (plan
 * P3-a). The result mapping is fail-closed with fixed details: ENOENT ⇒ "perl binary not found",
 * `spawnSync` timeout (error ETIMEDOUT, status null, SIGTERM) and signal kills ⇒ fail (never
 * `busy` — an unknown lock state must not be guessed), exit 75 ⇒ `busy`, exit 0 ⇒ `held`, any
 * other exit ⇒ fail. */
export function perlFlockAcquire(perlBin = "/usr/bin/perl", deps: AcquireDeps = {}): LockAcquire {
  const spawn = deps.spawn ?? spawnSync;
  const timeout = deps.timeoutMs ?? 5_000;
  return (fd) => {
    const r = spawn(perlBin, [...PERL_FLOCK_ARGS], {
      stdio: ["ignore", "ignore", "ignore", fd],
      timeout,
      env: { ...PERL_ENV },
    });
    if (r.error !== undefined) {
      const c = code(r.error);
      if (c === "ENOENT") return { kind: "fail", detail: "perl binary not found (fail closed)" };
      if (c === "ETIMEDOUT")
        return { kind: "fail", detail: `perl flock timed out after ${String(timeout)}ms (fail closed)` };
      return { kind: "fail", detail: `perl: ${String(r.error)}` };
    }
    if (r.status === null && r.signal !== null)
      return { kind: "fail", detail: `perl flock killed by ${String(r.signal)} (fail closed)` };
    if (r.status === FLOCK_CONFLICT_EXIT) return "busy";
    if (r.status !== 0) return { kind: "fail", detail: `perl flock exited ${String(r.status)}` };
    return "held";
  };
}

/** Platform-default lock acquisition: darwin ⇒ perl `flock(2)`, everything else ⇒ `flock(1)`
 * (plan P3-a). `deps` is forwarded to the chosen backend so tests can capture the spawn
 * invocation (T-P8/T-P9); production callers pass none and get the real `spawnSync`. */
export function defaultLockAcquire(
  o: { platform?: string; flockBin?: string; perlBin?: string } = {},
  deps: AcquireDeps = {},
): LockAcquire {
  const platform = o.platform ?? process.platform;
  return platform === "darwin" ? perlFlockAcquire(o.perlBin, deps) : linuxFlockAcquire(o.flockBin, deps);
}

export interface LockOpts {
  timeoutMs?: number;
  /** Monotonic clock for the deadline (default `performance.now`). */
  monotonic?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Diagnostic payload written into the lock file while held (pid/host…; never trusted). */
  holderInfo?: Record<string, unknown>;
  /** `flock` binary (tests). */
  flockBin?: string;
  /** Lock acquisition strategy; wins over `flockBin`. */
  acquire?: LockAcquire;
  /** Lock file name inside the directory (default `.lock`). */
  name?: string;
}

export type LockOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: "E_BUSY"; detail: string; holder?: Record<string, unknown>; gone?: boolean };

/** Bounded retry sleep (ref'd on purpose — see the module comment). */
export function lockRetrySleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function code(err: unknown): string | undefined {
  return err instanceof Error && "code" in err ? String((err as NodeJS.ErrnoException).code) : undefined;
}

/** Best-effort read of the diagnostic holder info (never used for decisions). */
export function readLockHolder(dirFd: number, name = SCHED_LOCK_FILE): Record<string, unknown> | undefined {
  let fd: number;
  try {
    fd = openSync(fdPath(dirFd, name), fsConstants.O_RDONLY | O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    const buf = Buffer.alloc(HOLDER_INFO_MAX);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const v = JSON.parse(buf.subarray(0, n).toString("utf8")) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

type TryResult =
  | { kind: "held"; fd: number }
  | { kind: "busy" }
  | { kind: "retry" }
  | { kind: "gone" }
  | { kind: "fail"; detail: string };

function tryLock(dirFd: number, name: string, acquire: LockAcquire): TryResult {
  const path = fdPath(dirFd, name);
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDWR | fsConstants.O_CREAT | O_NOFOLLOW | fsConstants.O_NONBLOCK, 0o600);
  } catch (err) {
    const c = code(err);
    if (c === "ENOENT") return { kind: "gone" };
    if (c === "ELOOP") return { kind: "fail", detail: "lock file is a symlink" };
    return { kind: "fail", detail: `lock open: ${c ?? String(err)}` };
  }
  let keep = false;
  try {
    const st = fstatSync(fd);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!st.isFile() || (uid !== undefined && st.uid !== uid))
      return { kind: "fail", detail: "lock file is not our regular file" };
    const r = acquire(fd);
    if (r === "busy") return { kind: "busy" };
    if (r !== "held") return { kind: "fail", detail: r.detail };
    // Locked an inode that is no longer the linked lock file (recycled meanwhile)? Retry.
    let linked;
    try {
      linked = lstatSync(path);
    } catch {
      return { kind: "gone" };
    }
    if (linked.dev !== st.dev || linked.ino !== st.ino) return { kind: "retry" };
    keep = true;
    return { kind: "held", fd };
  } finally {
    if (!keep) closeSync(fd);
  }
}

function writeHolderInfo(fd: number, info: Record<string, unknown> | undefined): void {
  if (info === undefined) return;
  try {
    const bytes = Buffer.from(JSON.stringify(info).slice(0, HOLDER_INFO_MAX), "utf8");
    ftruncateSync(fd, 0);
    writeSync(fd, bytes, 0, bytes.length, 0);
  } catch {
    /* diagnostic only */
  }
}

/**
 * Run the SYNCHRONOUS `body` while holding the flock on `<dir>/<name>`. Contention ⇒ `E_BUSY`
 * after the deadline (with the holder's diagnostic info when readable); `gone` when the directory
 * vanished. Errors thrown by `body` propagate (after release).
 */
export async function withDirLock<T>(dirFd: number, body: () => T, opts: LockOpts = {}): Promise<LockOutcome<T>> {
  const mono = opts.monotonic ?? (() => performance.now());
  const sleep = opts.sleep ?? lockRetrySleep;
  const name = opts.name ?? SCHED_LOCK_FILE;
  const acquire =
    opts.acquire ??
    defaultLockAcquire({
      platform: process.platform,
      ...(opts.flockBin === undefined ? {} : { flockBin: opts.flockBin }),
    });
  const deadline = mono() + (opts.timeoutMs ?? SCHED_LOCK_TIMEOUT_MS);
  for (let spins = 0; ; spins++) {
    const r = tryLock(dirFd, name, acquire);
    if (r.kind === "held") {
      writeHolderInfo(r.fd, opts.holderInfo);
      try {
        return { ok: true, value: body() };
      } finally {
        try {
          ftruncateSync(r.fd, 0);
        } catch {
          /* recycled / diagnostic only */
        }
        closeSync(r.fd); // releases the flock
      }
    }
    if (r.kind === "gone") return { ok: false, code: "E_BUSY", detail: "directory is gone", gone: true };
    if (r.kind === "fail") return { ok: false, code: "E_BUSY", detail: r.detail };
    if (r.kind === "retry" && spins < 8) continue;
    if (mono() >= deadline) {
      const holder = readLockHolder(dirFd, name);
      const who =
        holder && typeof holder.pid === "number"
          ? `pid ${holder.pid}${typeof holder.host === "string" ? ` on ${holder.host}` : ""}`
          : "another process";
      return {
        ok: false,
        code: "E_BUSY",
        detail: `schedule state is locked by ${who}; it is released automatically when that process exits — close it and retry`,
        ...(holder === undefined ? {} : { holder }),
      };
    }
    await sleep(SCHED_LOCK_RETRY_MS);
  }
}

/** Session lock (`<session dir>/.lock`). */
export function withSessionLock<T>(sessFd: number, body: () => T, opts: LockOpts = {}): Promise<LockOutcome<T>> {
  return withDirLock(sessFd, body, { ...opts, name: SCHED_LOCK_FILE });
}
