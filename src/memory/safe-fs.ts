// The memory module's SOLE fs entry point (optimize-plan §3.1, todo #22 P0-b).
//
// Every read/write/lock primitive the rest of `src/memory/**` needs lives
// here: directory canonicalization (symlinked memory roots are trusted,
// §3.1 "目录信任语义"), regular-file-only open/read/write (O_NOFOLLOW so a
// file-level symlink inside the memory dir is refused — evaluated at open
// time, not a separate lstat-then-open TOCTOU window), atomic
// create/replace/rename, and the lock-file primitives `lock.ts` composes
// into `withMemoryDirLock`. `tests/memory/fs-guard.test.ts` asserts this is
// the ONLY file under `src/memory/**` that imports `node:fs` (or `fs` /
// `node:fs/promises`) — `import type` is exempt, `lock.ts` is not.
//
// Zero pi/typebox imports; independently unit-testable.

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { MemoryError, memoryDirFor, type MemoryPaths } from "./paths.js";

// The platform is assumed POSIX (repo-wide convention, AGENTS.md); the
// O_NOFOLLOW fallback below only matters if that assumption is ever wrong.
const O_NOFOLLOW: number | undefined = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW;

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function codeOf(err: unknown): string | undefined {
  return isErrnoException(err) ? err.code : undefined;
}

// ───────────────────────────── directory trust ─────────────────────────────

export interface CanonicalDir {
  /** The stable, user-facing path (what renders in prompt text / /mem path). */
  display: string;
  /** `realpathSync(display)` — every fs primitive below operates on this. */
  real: string;
  /** True when `display` resolves to a different path (§3.1 slug-dir trust). */
  linked: boolean;
}

/**
 * Canonicalize a display directory path once. Missing directory → undefined
 * (callers on the write path `mkdirSync` first); canonical target exists but
 * is not a directory → undefined (treated as "no memory here").
 */
export function canonicalDir(display: string): CanonicalDir | undefined {
  let real: string;
  try {
    real = realpathSync(display);
  } catch {
    return undefined;
  }
  let st;
  try {
    st = lstatSync(real);
  } catch {
    return undefined;
  }
  if (!st.isDirectory()) return undefined;
  return { display, real, linked: real !== display };
}

/** `canonicalDir(memoryDirFor(cwd, paths))` — the cwd-keyed convenience form
 *  every caller outside `store.ts`'s CC-import path actually wants. */
export function canonicalMemoryDir(cwd: string, paths?: MemoryPaths): CanonicalDir | undefined {
  return canonicalDir(memoryDirFor(cwd, paths));
}

/** Ensure `path` exists as a directory (creating missing ancestors). The
 *  final component MAY be a symlink to a real directory — ancestor symlinks
 *  and the slug directory itself are user-configured trust, §3.1. */
export function ensureMemoryDir(path: string, mode = 0o700): void {
  mkdirSync(path, { recursive: true, mode });
}

/** `.trash` / `.backup` / `.backup/<id>`: must be a REAL directory, never a
 *  symlink (§3.1) — these are internal bookkeeping dirs, not user config. */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new MemoryError(`${path} is not a plain directory`);
  }
}

/** The ONE primitive allowed to follow a symlink target — only for probing a
 *  Claude-Code project's memory/ dir, which lives outside our memory tree
 *  entirely (§3.1's function-name-is-the-warning). */
export function isDirFollowOutside(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Raw directory-entry listing (any names), empty on any readdir failure. */
export function listDirNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ───────────────────────────── regular-file listing ─────────────────────────────

export interface RegularFileEntry {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
}

export type SkippedKind = "symlink" | "dangling" | "not-file" | "bad-name";
export interface SkippedEntry {
  name: string;
  kind: SkippedKind;
}

const V2_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/;

/** Same filename-acceptance regex the v2 tool surface / tiered renderer /
 *  doctor / tidy use. Exported so those layers share exactly one pattern. */
export function isV2Name(name: string): boolean {
  return V2_NAME_RE.test(name);
}

/**
 * List `*.md` entries of `dir`, classifying every skip reason instead of
 * silently dropping it (§3.1, §10 B14). `names: "legacy"` accepts any `*.md`
 * name (pre-#22 behavior); `names: "v2"` additionally requires `isV2Name`.
 * File-level symlinks are ALWAYS skipped (§2.7's one accepted legacy
 * deviation) — dangling vs. valid-target symlinks are distinguished only for
 * the skip reason (`doctor` D14), not for whether they're skipped.
 */
export function listRegular(
  dir: string,
  opts: { names: "legacy" | "v2" },
): {
  files: RegularFileEntry[];
  skipped: SkippedEntry[];
} {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { files: [], skipped: [] };
  }
  const files: RegularFileEntry[] = [];
  const skipped: SkippedEntry[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    if (opts.names === "v2" && !isV2Name(name)) {
      skipped.push({ name, kind: "bad-name" });
      continue;
    }
    const path = join(dir, name);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      skipped.push({ name, kind: "dangling" });
      continue;
    }
    if (st.isSymbolicLink()) {
      try {
        statSync(path); // follows the link, only to classify the skip reason
        skipped.push({ name, kind: "symlink" });
      } catch {
        skipped.push({ name, kind: "dangling" });
      }
      continue;
    }
    if (!st.isFile()) {
      skipped.push({ name, kind: "not-file" });
      continue;
    }
    files.push({ name, path, size: st.size, mtimeMs: st.mtimeMs });
  }
  return { files, skipped };
}

// ───────────────────────────── regular-file open/read ─────────────────────────────

export interface RegularStat {
  dev: number;
  ino: number;
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
}

function toRegularStat(st: {
  dev: number;
  ino: number;
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
}): RegularStat {
  return { dev: st.dev, ino: st.ino, size: st.size, mode: st.mode, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
}

/**
 * Existence + regular-file check WITHOUT opening/reading the file. Missing →
 * undefined; symlink or other non-regular entry → throws (file-level
 * symlinks are refused everywhere, §3.1/N2).
 */
export function statRegularIfExists(dir: string, name: string): RegularStat | undefined {
  const path = join(dir, name);
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if (codeOf(err) === "ENOENT") return undefined;
    throw err;
  }
  if (st.isSymbolicLink()) throw new MemoryError(`refused: ${name} is a symlink`);
  if (!st.isFile()) throw new MemoryError(`refused: ${name} is not a regular file`);
  return toRegularStat(st);
}

/**
 * Open `name` under `dir` with O_NOFOLLOW so a symlink swapped in between an
 * earlier lstat and this open fails with ELOOP instead of being followed
 * (§3.1's TOCTOU fix). Falls back to lstat+open+dev/ino comparison on the
 * (POSIX-violating) platforms that lack `O_NOFOLLOW`.
 */
export function openRegular(dir: string, name: string, flags: number, mode?: number): number {
  const path = join(dir, name);
  if (typeof O_NOFOLLOW === "number") {
    let fd: number;
    try {
      fd = mode === undefined ? openSync(path, flags | O_NOFOLLOW) : openSync(path, flags | O_NOFOLLOW, mode);
    } catch (err) {
      if (codeOf(err) === "ELOOP") throw new MemoryError(`refused to open ${name}: symlink (ELOOP)`);
      throw err;
    }
    let st;
    try {
      st = fstatSync(fd);
    } catch (err) {
      closeSync(fd);
      throw err;
    }
    if (!st.isFile()) {
      closeSync(fd);
      throw new MemoryError(`refused to open ${name}: not a regular file`);
    }
    return fd;
  }
  // Fallback: no O_NOFOLLOW on this platform — best-effort TOCTOU narrowing.
  const lst = lstatSync(path);
  if (lst.isSymbolicLink()) throw new MemoryError(`refused to open ${name}: symlink`);
  const fd = mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
  const st = fstatSync(fd);
  if (!st.isFile() || st.dev !== lst.dev || st.ino !== lst.ino) {
    closeSync(fd);
    throw new MemoryError(`refused to open ${name}: not a regular file (swap detected)`);
  }
  return fd;
}

export interface RegularRead {
  text: string;
  stat: RegularStat;
}

/** Full-file read via `openRegular` (rejects symlinks/non-regular files). */
export function readRegular(dir: string, name: string): RegularRead {
  const fd = openRegular(dir, name, fsConstants.O_RDONLY);
  try {
    const st = fstatSync(fd);
    const buf = readFileSync(fd);
    return { text: buf.toString("utf8"), stat: toRegularStat(st) };
  } finally {
    closeSync(fd);
  }
}

/** Head-only read (pin detection / doctor previews) — same symlink refusal. */
export function readRegularHead(dir: string, name: string, bytes: number): RegularRead {
  const fd = openRegular(dir, name, fsConstants.O_RDONLY);
  try {
    const st = fstatSync(fd);
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return { text: buf.subarray(0, n).toString("utf8"), stat: toRegularStat(st) };
  } finally {
    closeSync(fd);
  }
}

// ───────────────────────────── writes ─────────────────────────────

/** Loop `writeSync` until `data` is fully written — `writeSync` is not
 *  guaranteed to write everything in one call (§3.1). */
export function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    let n: number;
    try {
      n = writeSync(fd, data, offset, data.length - offset);
    } catch (err) {
      throw new MemoryError(`short write: ${offset}/${data.length} bytes (${(err as Error).message})`);
    }
    if (n <= 0) throw new MemoryError(`short write: ${offset}/${data.length} bytes`);
    offset += n;
  }
}

/** Create a private temp file under `dir`, write+fsync `data`, return its
 *  name. Any failure cleans up the temp file before rethrowing — the target
 *  file is never touched (§3.1). */
export function writeTempRegular(dir: string, name: string, data: Buffer, mode: number): string {
  const tmp = `.${name}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const path = join(dir, tmp);
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags, mode);
  try {
    writeAll(fd, data);
    fsyncSync(fd);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
    try {
      unlinkSync(path);
    } catch {
      // best effort
    }
    throw err;
  }
  closeSync(fd);
  return tmp;
}

/** `rename(2)` never follows a symlink at the DESTINATION name — it replaces
 *  the directory entry itself, which is exactly the atomic swap we want. */
export function replaceAtomic(dir: string, tmp: string, name: string): void {
  renameSync(join(dir, tmp), join(dir, name));
}

export interface CreateResult {
  note?: string;
}

/** Atomic no-clobber create via `link()` (target exists ⇒ EEXIST); degrades
 *  to a check-then-rename when hard links are unavailable (§3.1). The temp
 *  file is always cleaned up (link() does not consume it). */
export function createExclusive(dir: string, tmp: string, name: string): CreateResult {
  const tmpPath = join(dir, tmp);
  const destPath = join(dir, name);
  try {
    linkSync(tmpPath, destPath);
    unlinkSync(tmpPath);
    return {};
  } catch (err) {
    const code = codeOf(err);
    if (code === "EEXIST") {
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      throw new MemoryError(`${name} already exists`);
    }
    if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV") {
      let existing = true;
      try {
        lstatSync(destPath);
      } catch (lstatErr) {
        if (codeOf(lstatErr) !== "ENOENT") throw lstatErr;
        existing = false;
      }
      if (existing) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // ignore
        }
        throw new MemoryError(`${name} already exists`);
      }
      renameSync(tmpPath, destPath);
      return { note: "non-atomic create (no hard links)" };
    }
    throw err;
  }
}

/** Atomic no-clobber rename (`rename` command / restore-from-trash), degrading
 *  the same way `createExclusive` does. */
export function renameNoClobber(dir: string, from: string, to: string): CreateResult {
  const fromPath = join(dir, from);
  const toPath = join(dir, to);
  const st = lstatSync(fromPath);
  if (!st.isFile()) throw new MemoryError(`${from} is not a regular file`);
  try {
    linkSync(fromPath, toPath);
  } catch (err) {
    const code = codeOf(err);
    if (code === "EEXIST") throw new MemoryError(`${to} already exists`);
    if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV") {
      let existing = true;
      try {
        lstatSync(toPath);
      } catch (lstatErr) {
        if (codeOf(lstatErr) !== "ENOENT") throw lstatErr;
        existing = false;
      }
      if (existing) throw new MemoryError(`${to} already exists`);
      renameSync(fromPath, toPath);
      return { note: "non-atomic rename (no hard links)" };
    }
    throw err;
  }
  unlinkSync(fromPath);
  return {};
}

// ───────────────────────────── legacy write/append (frozen semantics) ─────────────────────────────

/** legacy `write`: in-place truncate+write, preserving the inode / existing
 *  mode — the same semantics `writeFileSync` had pre-#22, plus O_NOFOLLOW. */
export function writeInPlaceLegacy(dir: string, name: string, data: Buffer): void {
  const fd = openRegular(dir, name, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, 0o600);
  try {
    writeAll(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** legacy `append`: O_APPEND write; on failure, rolls back to the
 *  pre-append size ONLY if nothing else grew the file in the meantime
 *  (§3.1) — otherwise leaves the partial append in place rather than
 *  clobbering a concurrent writer's bytes. */
export function appendLegacy(dir: string, name: string, data: Buffer): { totalBytes: number } {
  const fd = openRegular(dir, name, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT, 0o600);
  try {
    const size0 = fstatSync(fd).size;
    let written = 0;
    try {
      while (written < data.length) {
        written += writeSync(fd, data, written, data.length - written);
      }
    } catch (writeErr) {
      let sizeNow = -1;
      try {
        sizeNow = fstatSync(fd).size;
      } catch {
        // ignore — best effort rollback decision below stays conservative
      }
      if (sizeNow === size0 + written) {
        try {
          ftruncateSync(fd, size0);
        } catch {
          // best effort
        }
        throw new MemoryError(`append to ${name} failed and was rolled back: ${(writeErr as Error).message}`);
      }
      throw new MemoryError(`append to ${name} failed, partial append left in place: ${(writeErr as Error).message}`);
    }
    return { totalBytes: fstatSync(fd).size };
  } finally {
    closeSync(fd);
  }
}

// ───────────────────────────── lock-file primitives (consumed by lock.ts) ─────────────────────────────

export interface LockPayload {
  pid: number;
  host: string;
  token: string;
  at: number;
}

const LOCK_NAME = ".lock";

/** `O_CREAT|O_EXCL` create of the lock file; `false` on EEXIST (lost the race). */
export function lockCreate(dir: string, payload: LockPayload): boolean {
  const path = join(dir, LOCK_NAME);
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = openSync(path, flags, 0o600);
  } catch (err) {
    if (codeOf(err) === "EEXIST") return false;
    throw err;
  }
  try {
    writeAll(fd, Buffer.from(JSON.stringify(payload), "utf8"));
  } finally {
    closeSync(fd);
  }
  return true;
}

export function lockRead(dir: string): { payload: LockPayload | undefined; mtimeMs: number } | undefined {
  const path = join(dir, LOCK_NAME);
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let payload: LockPayload | undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.host === "string" &&
      typeof parsed.token === "string" &&
      typeof parsed.at === "number"
    ) {
      payload = { pid: parsed.pid, host: parsed.host, token: parsed.token, at: parsed.at };
    }
  } catch {
    payload = undefined;
  }
  return { payload, mtimeMs: st.mtimeMs };
}

/** Rename the lock file out of the way then delete it — only one concurrent
 *  breaker can win the rename, so this is the "break a stale lock" primitive. */
export function lockBreak(dir: string): boolean {
  const path = join(dir, LOCK_NAME);
  const staleName = join(dir, `.lock.stale-${randomBytes(4).toString("hex")}`);
  try {
    renameSync(path, staleName);
  } catch {
    return false;
  }
  try {
    unlinkSync(staleName);
  } catch {
    // ignore
  }
  return true;
}

/** Delete the lock file ONLY if it still carries `token` — never removes a
 *  lock someone else has since acquired. */
export function lockRelease(dir: string, token: string): void {
  const current = lockRead(dir);
  if (current?.payload?.token !== token) return;
  try {
    unlinkSync(join(dir, LOCK_NAME));
  } catch {
    // already gone
  }
}
