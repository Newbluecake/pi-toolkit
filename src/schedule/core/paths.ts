/**
 * Scheduled tasks — store layout + READ-ONLY fd-anchored file primitives (plan r3 §4.7/§7.6, S1).
 *
 * Layout: `<storeDir>/<sessionDirName(sid)>/{state.json,.lock,reports/<taskId>-<YYYYMMDD-HHmm>[-n].md} (legacy <64hex>.md retained)`.
 *
 * Every open is anchored on an already-open DIRECTORY fd through `/proc/self/fd/<fd>/<name>`
 * (the hub's spawn-history precedent): each level is opened `O_DIRECTORY|O_NOFOLLOW` (files
 * `O_NOFOLLOW|O_NONBLOCK`), then `fstat`-checked — right type, owned by the expected uid, not
 * group/other-writable, size within the cap. A swapped-in symlink at any level fails with ELOOP
 * instead of being followed, and the parent can no longer be swapped underneath us. Without
 * `/proc/self/fd` (non-Linux) every operation fails closed (`platform`).
 *
 * This module contains NO write primitive (pinned by tests/schedule/core/reader.test.ts) — it is
 * shared by the hub's pure reader and the agent writer; writes live in writer.ts / lock.ts.
 *
 * Vault checks are injected (`inVault`): the hub must not import the secure-domain module, and
 * the predicate is evaluated against BOTH the literal and the canonical store path.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

const O_NOFOLLOW: number = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
const O_DIRECTORY: number = (fsConstants as Record<string, number | undefined>).O_DIRECTORY ?? 0;
const O_NONBLOCK: number = (fsConstants as Record<string, number | undefined>).O_NONBLOCK ?? 0;

export const SCHED_FD_ROOT = "/proc/self/fd";

/** Why a path was refused. Static vocabulary (safe to log / project). */
export type SchedFsReason =
  | "platform"
  | "relative"
  | "vault"
  | "missing"
  | "symlink"
  | "not-dir"
  | "not-file"
  | "owner"
  | "mode"
  | "too-large"
  | "moved"
  | "bad-name"
  | "io";

export class SchedFsError extends Error {
  constructor(
    readonly reason: SchedFsReason,
    message: string,
  ) {
    super(message);
    this.name = "SchedFsError";
  }
}

/** `/proc/self/fd/<fd>[/<name>]`. */
export function fdPath(fd: number, name?: string): string {
  return name === undefined ? `${SCHED_FD_ROOT}/${fd}` : `${SCHED_FD_ROOT}/${fd}/${name}`;
}

export function fdAnchoringAvailable(): boolean {
  try {
    return statSync(SCHED_FD_ROOT).isDirectory();
  } catch {
    return false;
  }
}

function errCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err ? String((err as NodeJS.ErrnoException).code) : undefined;
}

/** Plain directory-entry name (no separators, not `.`/`..`, no NUL, bounded). */
export function isPlainName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 255 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\0")
  );
}

const SID_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Session id → directory name. A wire-shaped sid (`SCHED_SESSION_ID_RE`) is used verbatim; anything
 * else becomes `_<sha256(sid)[0..32]>` — a leading `_` can never be a verbatim name, so the two
 * spaces never collide. `state.sessionId` must still equal the sid (degraded otherwise).
 */
export function sessionDirName(sessionId: string): string {
  if (SID_DIR_RE.test(sessionId)) return sessionId;
  return `_${createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 32)}`;
}

export function isSessionDirName(name: string): boolean {
  return SID_DIR_RE.test(name) || /^_[0-9a-f]{32}$/.test(name);
}

export interface FsCheckOpts {
  /** Expected owner (default: process uid). */
  uid?: number;
}

function expectedUid(opts: FsCheckOpts): number | undefined {
  return opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
}

export interface OpenedDir {
  fd: number;
  dev: number;
  ino: number;
}

function checkStat(st: Stats, kind: "dir" | "file", what: string, opts: FsCheckOpts): void {
  if (kind === "dir" ? !st.isDirectory() : !st.isFile()) {
    throw new SchedFsError(
      kind === "dir" ? "not-dir" : "not-file",
      `${what}: not a ${kind === "dir" ? "directory" : "regular file"}`,
    );
  }
  const uid = expectedUid(opts);
  if (uid !== undefined && st.uid !== uid) throw new SchedFsError("owner", `${what}: owned by uid ${st.uid}`);
  if ((st.mode & 0o022) !== 0) throw new SchedFsError("mode", `${what}: group/other-writable`);
}

function mapOpenError(err: unknown, what: string, path?: string): SchedFsError {
  const code = errCode(err);
  // O_DIRECTORY|O_NOFOLLOW on a symlink reports ENOTDIR on Linux: name the real cause.
  if (code === "ENOTDIR" && path !== undefined) {
    try {
      if (lstatSync(path).isSymbolicLink()) return new SchedFsError("symlink", `${what}: symlink refused`);
    } catch {
      /* fall through */
    }
  }
  if (code === "ELOOP" || code === "EMLINK") return new SchedFsError("symlink", `${what}: symlink refused`);
  if (code === "ENOENT") return new SchedFsError("missing", `${what}: missing`);
  if (code === "ENOTDIR") return new SchedFsError("not-dir", `${what}: not a directory`);
  return new SchedFsError("io", `${what}: ${code ?? String(err)}`);
}

/** Open an absolute, already-canonical directory path `O_DIRECTORY|O_NOFOLLOW` and check it. */
export function openDirPath(path: string, opts: FsCheckOpts = {}): OpenedDir {
  if (!fdAnchoringAvailable()) throw new SchedFsError("platform", "fd-anchored opens need /proc/self/fd");
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (err) {
    throw mapOpenError(err, "store dir", path);
  }
  try {
    const st = fstatSync(fd);
    checkStat(st, "dir", "store dir", opts);
    return { fd, dev: st.dev, ino: st.ino };
  } catch (err) {
    closeQuiet(fd);
    throw err;
  }
}

/**
 * The CURRENT location of an open directory fd (kernel's view via `/proc/self/fd/<fd>`), so vault
 * and identity checks judge the object actually opened, never a stale path string (review M3).
 */
export function fdRealPath(fd: number): string {
  try {
    return readlinkSync(fdPath(fd));
  } catch (err) {
    throw new SchedFsError("io", `cannot resolve fd location: ${errCode(err) ?? String(err)}`);
  }
}

/** Open an existing ancestor directory without owner/mode policy (only for anchored creation). */
export function openDirPathUnchecked(path: string): OpenedDir {
  if (!fdAnchoringAvailable()) throw new SchedFsError("platform", "fd-anchored opens need /proc/self/fd");
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (err) {
    throw mapOpenError(err, "ancestor dir", path);
  }
  const st = fstatSync(fd);
  return { fd, dev: st.dev, ino: st.ino };
}

/** Open child directory `name` of `parentFd` (`O_DIRECTORY|O_NOFOLLOW`, checked). */
export function openDirAt(parentFd: number, name: string, opts: FsCheckOpts = {}): OpenedDir {
  if (!isPlainName(name)) throw new SchedFsError("bad-name", "bad directory name");
  let fd: number;
  const path = fdPath(parentFd, name);
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (err) {
    throw mapOpenError(err, `dir ${name}`, path);
  }
  try {
    const st = fstatSync(fd);
    checkStat(st, "dir", `dir ${name}`, opts);
    return { fd, dev: st.dev, ino: st.ino };
  } catch (err) {
    closeQuiet(fd);
    throw err;
  }
}

export interface BoundedRead {
  bytes: Buffer;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

/**
 * Read regular file `name` under `dirFd` — `O_NOFOLLOW|O_NONBLOCK` (a FIFO can never block the
 * open), fstat-checked, at most `maxBytes` (larger ⇒ `too-large`, nothing returned).
 */
export function readFileAt(dirFd: number, name: string, maxBytes: number, opts: FsCheckOpts = {}): BoundedRead {
  if (!isPlainName(name)) throw new SchedFsError("bad-name", "bad file name");
  let fd: number;
  try {
    fd = openSync(fdPath(dirFd, name), fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    throw mapOpenError(err, `file ${name}`);
  }
  try {
    const st = fstatSync(fd);
    checkStat(st, "file", `file ${name}`, opts);
    if (st.size > maxBytes) throw new SchedFsError("too-large", `file ${name}: ${st.size} > ${maxBytes} bytes`);
    // Read at most maxBytes + 1 so a file that grew after fstat is still detected as too large.
    const buf = Buffer.alloc(Math.min(maxBytes + 1, Math.max(st.size + 1, 1)));
    let off = 0;
    for (;;) {
      if (off >= buf.length) break;
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    if (off > maxBytes) throw new SchedFsError("too-large", `file ${name}: grew past ${maxBytes} bytes`);
    if (off !== st.size) throw new SchedFsError("io", `file ${name}: changed while being read`);
    return { bytes: buf.subarray(0, off), size: off, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino };
  } finally {
    closeQuiet(fd);
  }
}

export function closeQuiet(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
}

// ----------------------------------------------------------------- store root (§7.6)

/** Inject the secure-domain check: true ⇔ the path lies inside a registered vault. */
export type InVaultPredicate = (path: string) => boolean;

export interface StoreRoot {
  /** As configured (absolute). */
  literal: string;
  /** realpath at resolve time. */
  real: string;
  dev: number;
  ino: number;
}

export interface StoreRootOpts extends FsCheckOpts {
  inVault?: InVaultPredicate;
}

function vaultCheck(literal: string, real: string | undefined, opts: StoreRootOpts): void {
  if (opts.inVault === undefined) return;
  if (opts.inVault(literal) || (real !== undefined && opts.inVault(real))) {
    throw new SchedFsError("vault", "store dir lies inside an encrypted vault");
  }
}

/**
 * Resolve + pin the store root (hub start / agent stack build): absolute literal path outside every
 * vault; the directory is opened (O_NOFOLLOW) and the OPENED fd's kernel location must be outside
 * every vault too (this also closes the realpath→open window); owned by uid, not
 * group/other-writable; records that location plus dev/ino. Throws `SchedFsError`.
 */
export function resolveStoreRoot(storeDir: string, opts: StoreRootOpts = {}): StoreRoot {
  if (typeof storeDir !== "string" || !isAbsolute(storeDir) || storeDir.includes("\0")) {
    throw new SchedFsError("relative", "store dir must be an absolute path");
  }
  vaultCheck(storeDir, undefined, opts);
  let real: string;
  try {
    real = realpathSync(storeDir);
  } catch (err) {
    throw mapOpenError(err, "store dir");
  }
  vaultCheck(storeDir, real, opts);
  const dir = openDirPath(real, opts);
  try {
    const actual = fdRealPath(dir.fd);
    vaultCheck(storeDir, actual, opts);
    if (actual !== real) throw new SchedFsError("moved", "store dir moved while being pinned");
    return { literal: storeDir, real: actual, dev: dir.dev, ino: dir.ino };
  } finally {
    closeQuiet(dir.fd);
  }
}

/**
 * Re-open a pinned root for one scan/transaction. Judged on the OPENED object: dev/ino must match
 * the pin, the fd's current kernel location must still be the pinned path (an ancestor moved or
 * swapped for a symlink ⇒ `moved`) and outside every vault (literal path re-checked as well).
 * Caller closes `fd`.
 */
export function openStoreRoot(root: StoreRoot, opts: StoreRootOpts = {}): OpenedDir {
  vaultCheck(root.literal, root.real, opts);
  const dir = openDirPath(root.real, opts);
  try {
    if (dir.dev !== root.dev || dir.ino !== root.ino) {
      throw new SchedFsError("moved", "store dir identity changed since it was pinned");
    }
    const actual = fdRealPath(dir.fd);
    vaultCheck(root.literal, actual, opts);
    if (actual !== root.real) throw new SchedFsError("moved", "store dir location changed since it was pinned");
    return dir;
  } catch (err) {
    closeQuiet(dir.fd);
    throw err;
  }
}

/** Open session dir `name` under an opened root and verify the opened fd sits exactly there. */
export function openSessionDirAt(rootFd: number, rootReal: string, name: string, opts: FsCheckOpts = {}): OpenedDir {
  const d = openDirAt(rootFd, name, opts);
  try {
    if (fdRealPath(d.fd) !== join(rootReal, name))
      throw new SchedFsError("moved", "session dir is not where it was opened");
    return d;
  } catch (err) {
    closeQuiet(d.fd);
    throw err;
  }
}
