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
  rmdirSync,
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

/** Generic filesystem-safe basename check (P0-c): non-empty, no path
 *  separator, no NUL byte, not `.`/`..`. Used by the delete primitives below
 *  — their targets (`.trash/<id>-<name>`, `.backup/<id>`) are not always
 *  `*.md` (e.g. `manifest.json`), so `NAME_RE`/`isV2Name` don't apply; this
 *  is only a path-traversal/injection guard, not a filename-format rule. */
function isSafeName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");
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
 * Canonicalize a display directory path once, distinguishing WHY it failed
 * (P0-c, doctor D14 "canonical target is not a directory" vs. "no memory
 * here" needed separate states). `canonicalDir` below is the pre-existing
 * collapsed form (`ok` → the dir, anything else → `undefined`) — its own
 * signature/behavior is unchanged.
 */
export type CanonicalDirState = { state: "ok"; dir: CanonicalDir } | { state: "missing" } | { state: "not-dir" };

export function canonicalDirState(display: string): CanonicalDirState {
  let real: string;
  try {
    real = realpathSync(display);
  } catch {
    return { state: "missing" };
  }
  let st;
  try {
    st = lstatSync(real);
  } catch {
    return { state: "missing" };
  }
  if (!st.isDirectory()) return { state: "not-dir" };
  return { state: "ok", dir: { display, real, linked: real !== display } };
}

/**
 * Canonicalize a display directory path once. Missing directory → undefined
 * (callers on the write path `mkdirSync` first); canonical target exists but
 * is not a directory → undefined (treated as "no memory here").
 */
export function canonicalDir(display: string): CanonicalDir | undefined {
  const result = canonicalDirState(display);
  return result.state === "ok" ? result.dir : undefined;
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
  nlink: number;
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
    files.push({ name, path, size: st.size, mtimeMs: st.mtimeMs, nlink: st.nlink });
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
  nlink: number;
}

function toRegularStat(st: {
  dev: number;
  ino: number;
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
}): RegularStat {
  return {
    dev: st.dev,
    ino: st.ino,
    size: st.size,
    mode: st.mode,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    nlink: st.nlink,
  };
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

// ───────────────────────────── delete primitives (P0-c) ─────────────────────────────

/**
 * Delete a single regular file by name. Used for physical eviction beyond a
 * retention count (`.trash` eviction past 20 entries) — the entry itself was
 * already put there by `renameNoClobber`/a caller-controlled rename, so this
 * is the second half of that lifecycle, not a general-purpose delete. `name`
 * is checked with `isSafeName` (path-traversal guard, not a filename-format
 * rule — `.trash`/`.backup` entries are not all `*.md`); the target is then
 * `lstatSync`-checked and MUST be a plain regular file (symlink / directory /
 * FIFO / socket / etc. ⇒ refused, nothing is deleted).
 */
export function unlinkRegular(dir: string, name: string): void {
  if (!isSafeName(name)) throw new MemoryError(`refused to delete ${JSON.stringify(name)}: invalid name`);
  const path = join(dir, name);
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new MemoryError(`refused to delete ${name}: is a symlink`);
  if (!st.isFile()) throw new MemoryError(`refused to delete ${name}: not a regular file`);
  // lstat-then-unlink TOCTOU (P0-c review): if `path` is swapped between the
  // checks above and this call, `unlinkSync` still cannot escape outside
  // `dir` — swapped to a directory ⇒ EISDIR/EPERM, nothing deleted; swapped
  // to a symlink ⇒ only the symlink entry itself is removed (unlink never
  // follows a symlink), never its target. So the residual window can only
  // ever delete a directory ENTRY named `name` inside `dir`, never reach
  // through a symlink to something outside it.
  unlinkSync(path);
}

export type RemoveFlatDirResult =
  | { removed: true; count: number; partial?: true }
  | { removed: false; reason: "not-found" | "symlink" | "not-directory" | "not-flat" | "bad-name" };

export interface RemoveFlatDirHooks {
  /** Test-only race injection point: called once every quarantined child has
   *  been verified as a plain regular file and the quarantine directory's
   *  own identity (dev/ino) has been recorded, but before anything is
   *  deleted. Lets tests simulate a concurrent entry insertion (⇒ `rmdir`
   *  below fails ENOTEMPTY) or a swap of the quarantine directory itself
   *  (⇒ the dev/ino recheck below refuses to delete) and assert nothing
   *  outside the quarantine directory is ever touched. Production callers
   *  never pass this. */
  beforeDelete?: (quarantinePath: string) => void;
}

/** Pick a `.rm-<random>` name under `dirParent` that does not currently
 *  exist. Dot-prefixed, so it can never collide with a real backup/trash id
 *  (none of this file's id-naming conventions produce a leading dot) and is
 *  invisible to `listDirNames`-based enumeration of legitimate entries. */
function pickQuarantineName(dirParent: string): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `.rm-${randomBytes(6).toString("hex")}`;
    try {
      lstatSync(join(dirParent, candidate));
    } catch (err) {
      if (codeOf(err) === "ENOENT") return candidate;
      throw err;
    }
  }
  throw new MemoryError(`could not allocate a quarantine name under ${dirParent}`);
}

/**
 * Delete `<parent.real>/<childName>` ONLY if it is a real directory (never a
 * symlink) containing nothing but plain regular files (a "flat" directory) —
 * used to physically remove an old `.backup/<id>/` past the retention count
 * (P4 tidy). Any child entry that is itself a symlink, a subdirectory, or
 * any other non-regular type refuses the WHOLE operation: nothing is deleted,
 * not even the regular siblings. `parent` must already be canonicalized
 * (`canonicalDir`/`canonicalDirState`) — this never realpaths on its own.
 * Returns a result instead of throwing, matching `listRegular`/`lockCreate`'s
 * style for an expected-outcome (not exceptional) refusal.
 *
 * Isolate-then-delete (P0-c fix): Node has no `openat`/`unlinkat`, so a
 * classic lstat-then-readdir-then-unlink walk down `childName` has a TOCTOU
 * window — if the verified directory is swapped for a symlink after the
 * checks above but before the walk, deletion can follow it outside the
 * memory tree. Instead, the directory ENTRY is `renameSync`'d out of the way
 * FIRST: rename acts on the entry itself, never on a symlink's target, so
 * whatever `childName` names at that instant — real directory or something
 * swapped in — is what moves, and nothing can reach it via the original name
 * again. Every check below (symlink? directory? flat? still the same
 * inode?) runs against the quarantined copy; any failure rolls the entry
 * back to its original name (best effort) and deletes nothing.
 */
export function removeFlatDir(
  parent: CanonicalDir,
  childName: string,
  hooks?: RemoveFlatDirHooks,
): RemoveFlatDirResult {
  if (!isSafeName(childName)) return { removed: false, reason: "bad-name" };
  const dirPath = join(parent.real, childName);
  const quarantinePath = join(parent.real, pickQuarantineName(parent.real));

  try {
    renameSync(dirPath, quarantinePath);
  } catch (err) {
    if (codeOf(err) === "ENOENT") return { removed: false, reason: "not-found" };
    throw err;
  }

  const rollback = (): void => {
    try {
      renameSync(quarantinePath, dirPath);
    } catch {
      // Could not move it back (e.g. something now occupies the original
      // name) — leave it under the quarantine name. That name is
      // dot-prefixed and never produced by real id generation, so no
      // listing/enumeration code mistakes it for a legitimate backup/trash
      // entry; it is simply orphaned until a human cleans it up. Nothing
      // has been deleted.
    }
  };

  let st;
  try {
    st = lstatSync(quarantinePath);
  } catch (err) {
    if (codeOf(err) === "ENOENT") return { removed: false, reason: "not-found" };
    throw err;
  }
  if (st.isSymbolicLink()) {
    rollback();
    return { removed: false, reason: "symlink" };
  }
  if (!st.isDirectory()) {
    rollback();
    return { removed: false, reason: "not-directory" };
  }
  const identity = { dev: st.dev, ino: st.ino };

  let names: string[];
  try {
    names = readdirSync(quarantinePath);
  } catch (err) {
    rollback();
    if (codeOf(err) === "ENOENT") return { removed: false, reason: "not-found" };
    throw err;
  }
  const children: string[] = [];
  for (const name of names) {
    const childPath = join(quarantinePath, name);
    let cst;
    try {
      cst = lstatSync(childPath);
    } catch (err) {
      if (codeOf(err) === "ENOENT") continue; // vanished between readdir and lstat — nothing to verify or delete
      rollback();
      throw err;
    }
    if (cst.isSymbolicLink() || cst.isDirectory() || !cst.isFile()) {
      rollback();
      return { removed: false, reason: "not-flat" };
    }
    children.push(name);
  }

  hooks?.beforeDelete?.(quarantinePath);

  // Optional hardening: if the quarantine directory itself was swapped out
  // from under us between verification and here, stop — delete nothing.
  // Nothing in the real filesystem can address `quarantinePath` by name (a
  // freshly random name under a directory only this call renamed into), so
  // this can only fire via `hooks.beforeDelete` in tests; it turns
  // "impossible in practice" into "provably checked".
  let st2;
  try {
    st2 = lstatSync(quarantinePath);
  } catch (err) {
    if (codeOf(err) === "ENOENT") return { removed: false, reason: "not-found" };
    throw err;
  }
  if (st2.isSymbolicLink() || !st2.isDirectory() || st2.dev !== identity.dev || st2.ino !== identity.ino) {
    // Whatever is at `quarantinePath` now is not the directory we verified —
    // leave it exactly where it is (under the quarantine name, not the
    // original name) and refuse without deleting or renaming anything.
    return { removed: false, reason: "not-directory" };
  }

  // Every name in `children` was verified regular at verification time.
  // `unlinkSync` never follows a symlink, so even if a name were replaced
  // with a symlink to an outside file in the (test-only) window above, this
  // removes only the directory entry inside the quarantine dir, never an
  // outside target.
  let deleted = 0;
  for (const name of children) {
    try {
      unlinkSync(join(quarantinePath, name));
      deleted++;
    } catch (err) {
      if (codeOf(err) === "ENOENT") continue; // already gone
      throw err;
    }
  }

  try {
    rmdirSync(quarantinePath);
  } catch (err) {
    if (codeOf(err) === "ENOTEMPTY" || codeOf(err) === "EEXIST") {
      // A new entry was inserted into the quarantine directory after
      // verification (only reachable via `hooks.beforeDelete` in tests —
      // `quarantinePath`'s random name is otherwise unguessable). From the
      // caller's point of view the backup IS gone: nothing lives under the
      // original name anymore. The quarantine directory and whatever raced
      // into it are left behind under the dot-prefixed quarantine name
      // (invisible to normal enumeration) rather than being force-deleted —
      // deletion never widens beyond what was verified regular.
      return { removed: true, count: deleted, partial: true };
    }
    throw err;
  }
  return { removed: true, count: deleted };
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
