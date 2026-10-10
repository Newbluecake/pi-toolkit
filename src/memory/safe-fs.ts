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
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { MemoryError, memoryDirFor, type MemoryPaths } from "./paths.js";
import { parseTmpName, tmpNameFor, type TmpKind } from "./tmp-names.js";
import type { Ident, Loc, Obs } from "./contracts.js";

// The platform is assumed POSIX (repo-wide convention, AGENTS.md); the
// O_NOFOLLOW fallback below only matters if that assumption is ever wrong.
const O_NOFOLLOW: number | undefined = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW;
const O_DIRECTORY: number = (fsConstants as Record<string, number | undefined>).O_DIRECTORY ?? 0;
const MAX_OBSERVED_BYTES = 64 * 1024 * 1024;

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

// ───────────────────────────── transaction storage primitives (tidy P2a) ─────────────────────────────

/** Errors from the transaction primitives carry whether a syscall may have
 * changed the directory.  Recovery uses this bit to decide whether an
 * `attempt` event is required. */
export class TxnFsError extends Error {
  readonly code: string;
  readonly mutated: boolean;
  readonly leftovers: readonly Loc[] | undefined;

  constructor(code: string, message: string, mutated = false, leftovers?: readonly Loc[]) {
    super(message);
    this.name = "TxnFsError";
    this.code = code;
    this.mutated = mutated;
    this.leftovers = leftovers;
  }
}

export interface RunDir {
  area: "live" | "root" | "archive" | "backup" | "trash";
  path: string;
  dev: number;
  ino: number;
}

export interface FsyncWarningState {
  readonly warnings: Set<string>;
}

export function createFsyncWarningState(): FsyncWarningState {
  return { warnings: new Set<string>() };
}

export interface RunDirs {
  live: RunDir;
  root: RunDir;
  archive: RunDir;
  backup: RunDir;
  trash: RunDir;
  id: string;
  fsyncWarnings: FsyncWarningState;
}

function txnErr(code: string, message: string, mutated = false, leftovers?: readonly Loc[]): TxnFsError {
  return new TxnFsError(code, message, mutated, leftovers);
}

function statDir(path: string, area: RunDir["area"]): RunDir {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    throw txnErr("DIR_SWAPPED", `directory is unavailable: ${path}: ${String(err)}`);
  }
  if (!st.isDirectory() || st.isSymbolicLink())
    throw txnErr("DIR_SWAPPED", `directory is not a plain directory: ${path}`);
  return { area, path, dev: st.dev, ino: st.ino };
}

function verifyMutationDir(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    throw txnErr("DIR_SWAPPED", `directory changed: ${path}: ${String(err)}`);
  }
  if (!st.isDirectory() || st.isSymbolicLink())
    throw txnErr("DIR_SWAPPED", `directory is not a plain directory: ${path}`);
}

function verifyDir(dir: RunDir): void {
  let st;
  try {
    st = lstatSync(dir.path);
  } catch (err) {
    throw txnErr("DIR_SWAPPED", `directory changed: ${dir.path}: ${String(err)}`);
  }
  if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== dir.dev || st.ino !== dir.ino) {
    throw txnErr("DIR_SWAPPED", `directory changed: ${dir.path}`);
  }
}
export { verifyDir };

/** Open and pin the identity of every directory used by a run. No directory
 * fd is retained: Node 22 has no openat/renameat2 binding, so each mutating
 * path syscall is preceded by verifyDir (M-T9). Crash state: this setup step
 * either leaves only a newly-created archive/backup directory or no run dirs. */
export function openRunDirs(
  liveReal: string,
  id: string,
  opts: { createArchive?: boolean; createBackup?: boolean } = {},
): RunDirs {
  const live = statDir(liveReal, "live");
  const root: RunDir = { ...live, area: "root" };
  const archivePath = join(liveReal, "archive");
  try {
    lstatSync(archivePath);
  } catch (err) {
    if (codeOf(err) !== "ENOENT" || !opts.createArchive)
      throw txnErr("DIR_SWAPPED", `archive directory is unavailable: ${archivePath}`);
    verifyDir(live);
    mkdirSync(archivePath, { mode: 0o700 });
  }
  let archive = statDir(archivePath, "archive");
  try {
    if (realpathSync(archive.path) !== archive.path)
      throw txnErr("DIR_SWAPPED", `archive directory is symlinked: ${archive.path}`);
  } catch (err) {
    if (err instanceof TxnFsError) throw err;
    throw txnErr("DIR_SWAPPED", `archive directory cannot be canonicalized: ${archive.path}`);
  }
  const backupRoot = join(liveReal, ".backup");
  const backupPath = join(backupRoot, id);
  if (opts.createBackup) ensurePrivateDir(backupPath);
  const backup = statDir(backupPath, "backup");
  const trashPath = join(liveReal, ".trash");
  let trash: RunDir;
  try {
    // Trash is read-only and is intentionally not created by this primitive;
    // inspect its entry first so ENOENT remains distinguishable from a swap.
    lstatSync(trashPath);
    trash = statDir(trashPath, "trash");
  } catch (err) {
    if (codeOf(err) === "ENOENT") {
      trash = { area: "trash", path: trashPath, dev: -1, ino: -1 };
    } else throw err;
  }
  return { live, root, archive, backup, trash, id, fsyncWarnings: createFsyncWarningState() };
}

function dirForArea(dirs: RunDirs, area: "live" | "root" | "archive" | "backup" | "trash"): RunDir {
  return dirs[area];
}

const BACKUP_NAME_RE = /^s\d{1,3}-\d{1,5}-(?:live|archive|trash)--[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/;
const TRASH_NAME_RE = /^\d{8}T\d{9}Z-\d+-[0-9a-f]{6}-[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/;

/** The sole transaction namespace path resolver. Crash state: pure lookup;
 * it cannot mutate disk. */
export function resolveLoc(dirs: RunDirs, loc: Loc): { dir: RunDir; name: string } {
  if (loc.area === "tmp") {
    const parsed = parseTmpName(loc.name);
    if (!parsed) throw txnErr("INVALID_LOC", `invalid transaction temporary name: ${loc.name}`);
    const area = loc.within === "root" ? "root" : loc.within;
    return { dir: dirForArea(dirs, area), name: loc.name };
  }
  if (loc.area === "live" || loc.area === "archive") {
    if (!isV2Name(loc.name)) throw txnErr("INVALID_LOC", `invalid memory filename: ${loc.name}`);
  } else if (loc.area === "backup") {
    if (!BACKUP_NAME_RE.test(loc.name)) throw txnErr("INVALID_LOC", `invalid backup filename: ${loc.name}`);
  } else if (loc.area === "trash") {
    if (!TRASH_NAME_RE.test(loc.name)) throw txnErr("INVALID_LOC", `invalid trash filename: ${loc.name}`);
  }
  return { dir: dirForArea(dirs, loc.area), name: loc.name };
}

function identFromStat(st: { dev: number; ino: number; size: number }, sha: string): Ident {
  return { dev: st.dev, ino: st.ino, size: st.size, sha };
}

function sameIdent(a: Ident, b: Ident): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.sha === b.sha;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function readFdBytes(fd: number, size: number): Buffer {
  if (size > MAX_OBSERVED_BYTES) throw txnErr("TOO_LARGE", `file exceeds observation limit (${size} bytes)`);
  return readFileSync(fd);
}

/** Observe without following file symlinks. A single retry distinguishes a
 * normal concurrent replacement from an unreadable object. Crash state: pure
 * observation; no directory entry is changed. */
export function observeLoc(dirs: RunDirs, loc: Loc, opts: { maxFileBytes?: number } = {}): Obs {
  const resolved = resolveLoc(dirs, loc);
  if (resolved.dir.area === "trash" && resolved.dir.dev === -1) return { kind: "absent" };
  verifyDir(resolved.dir);
  const path = join(resolved.dir.path, resolved.name);
  let lastRacing = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    let lst;
    try {
      lst = lstatSync(path);
    } catch (err) {
      if (codeOf(err) === "ENOENT") return { kind: "absent" };
      return { kind: "other", reason: "unreadable" };
    }
    if (lst.isSymbolicLink()) return { kind: "other", reason: "symlink" };
    if (!lst.isFile()) return { kind: "other", reason: "not-file" };
    let fd: number;
    try {
      fd = openRegular(resolved.dir.path, resolved.name, fsConstants.O_RDONLY);
    } catch (err) {
      if (codeOf(err) === "ELOOP" || (err instanceof MemoryError && /ELOOP|symlink/i.test(err.message))) {
        return { kind: "other", reason: "symlink" };
      }
      return { kind: "other", reason: "unreadable" };
    }
    try {
      const fst = fstatSync(fd);
      if (fst.dev !== lst.dev || fst.ino !== lst.ino) {
        lastRacing = true;
        continue;
      }
      const max = opts.maxFileBytes ?? MAX_OBSERVED_BYTES;
      if (fst.size > max) return { kind: "other", reason: "too-large" };
      const bytes = readFdBytes(fd, max);
      const after = fstatSync(fd);
      if (after.dev !== fst.dev || after.ino !== fst.ino || after.size !== fst.size) {
        lastRacing = true;
        continue;
      }
      return { kind: "file", ...identFromStat(after, sha256(bytes)) };
    } catch {
      return { kind: "other", reason: "unreadable" };
    } finally {
      closeSync(fd);
    }
  }
  return { kind: "other", reason: lastRacing ? "racing" : "unreadable" };
}

function assertEpochInternal(dirs: RunDirs, runEpoch?: number): void {
  if (runEpoch === undefined) return;
  assertEpoch(dirs, runEpoch);
}

function ensureTmp(resolved: { dir: RunDir; name: string }, target?: { dir: RunDir; name: string }): void {
  if (parseTmpName(resolved.name) === undefined)
    throw txnErr("INVALID_LOC", `not a transaction temporary: ${resolved.name}`);
  if (
    target !== undefined &&
    (resolved.dir.path !== target.dir.path ||
      resolved.dir.dev !== target.dir.dev ||
      resolved.dir.ino !== target.dir.ino)
  ) {
    throw txnErr("INVALID_LOC", "temporary and target must share a directory");
  }
}

/** Crash state: after the file fsync, a process crash may leave a complete
 * un-staged tmp; a failed write either removes an identity-verified partial
 * tmp or reports it as a leftover. */
export function writeTmpLoc(dirs: RunDirs, tmp: Loc, bytes: Buffer, opts: { epoch?: number } = {}): Ident {
  const resolved = resolveLoc(dirs, tmp);
  ensureTmp(resolved);
  verifyDir(resolved.dir);
  assertEpochInternal(dirs, opts.epoch);
  const path = join(resolved.dir.path, resolved.name);
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (O_NOFOLLOW ?? 0), 0o600);
  } catch (err) {
    if (codeOf(err) === "EEXIST") throw txnErr("TMP_COLLISION", `temporary already exists: ${resolved.name}`);
    throw txnErr("IO", `cannot create temporary ${resolved.name}: ${String(err)}`);
  }
  let st: { dev: number; ino: number; size: number } | undefined;
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
    const fst = fstatSync(fd);
    st = { dev: fst.dev, ino: fst.ino, size: fst.size };
  } catch (err) {
    try {
      const fst = fstatSync(fd);
      closeSync(fd);
      const lst = lstatSync(path);
      if (lst.dev === fst.dev && lst.ino === fst.ino) {
        // Best-effort cleanup is still guarded by the same parent-dir check;
        // if it fails, the tmp is deliberately left for conflict reporting.
        verifyDir(resolved.dir);
        assertEpochInternal(dirs, opts.epoch);
        unlinkSync(path);
      }
    } catch {
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
      throw txnErr("IO", `temporary write failed and cleanup was incomplete: ${String(err)}`, true, [tmp]);
    }
    throw txnErr("IO", `temporary write failed: ${String(err)}`);
  }
  closeSync(fd);
  return identFromStat(st!, sha256(bytes));
}

const HARDLINK_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);
function noHardlink(err: unknown): boolean {
  return HARDLINK_CODES.has(codeOf(err) ?? "");
}
function hardlinkError(err: unknown, path = process.cwd(), mutated = false): TxnFsError {
  return txnErr(
    "NO_HARDLINK",
    `memory dir ${path} is on a filesystem without hard-link support (${codeOf(err) ?? "unknown"}) — /mem tidy --batch and restore need link(2) for no-clobber moves; move ~/.pi/agent/memory to a local filesystem or use plain /mem tidy <file>`,
    mutated,
  );
}

/** Strict transaction create: unlike the legacy createExclusive this never
 * falls back to rename when hard links are unavailable. */
export function createTxnExclusive(dir: string, tmp: string, name: string): void {
  const fsyncWarnings = createFsyncWarningState();
  const tmpPath = join(dir, tmp);
  const destPath = join(dir, name);
  verifyMutationDir(dir);
  try {
    linkSync(tmpPath, destPath);
  } catch (err) {
    if (codeOf(err) === "EEXIST") throw txnErr("EXISTS", `${name} already exists`, false);
    if (noHardlink(err)) throw hardlinkError(err, dir);
    throw txnErr("IO", `link failed: ${String(err)}`, false);
  }
  fsyncDirBestEffort(dir, undefined, fsyncWarnings);
  verifyMutationDir(dir);
  try {
    unlinkSync(tmpPath);
  } catch (err) {
    throw txnErr("IO", `temporary cleanup failed: ${String(err)}`, true, [{ area: "tmp", within: "root", name: tmp }]);
  }
  fsyncDirBestEffort(dir, undefined, fsyncWarnings);
}

function lstatRegular(path: string): { dev: number; ino: number; size: number } {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    throw txnErr(codeOf(err) === "ENOENT" ? "MISSING" : "IO", `cannot stat ${path}: ${String(err)}`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw txnErr("OWNERSHIP", `not a regular file: ${path}`);
  return { dev: st.dev, ino: st.ino, size: st.size };
}

/** Crash state: link-before-unlink leaves either the source, both names,
 * or only the destination; the source identity in the intent covers all three. */
export function moveLocNoClobber(
  dirs: RunDirs,
  from: Loc,
  to: Loc,
  expect: Ident,
  opts: { epoch?: number } = {},
): void {
  const src = resolveLoc(dirs, from);
  const dst = resolveLoc(dirs, to);
  verifyDir(src.dir);
  verifyDir(dst.dir);
  assertEpochInternal(dirs, opts.epoch);
  const before = lstatRegular(join(src.dir.path, src.name));
  if (before.dev !== expect.dev || before.ino !== expect.ino || before.size !== expect.size)
    throw txnErr("OWNERSHIP", "source identity changed");
  try {
    lstatSync(join(dst.dir.path, dst.name));
    throw txnErr("EXISTS", "destination already exists");
  } catch (err) {
    if (err instanceof TxnFsError) throw err;
    if (codeOf(err) !== "ENOENT") throw txnErr("IO", `cannot inspect destination: ${String(err)}`);
  }
  verifyDir(src.dir);
  verifyDir(dst.dir);
  assertEpochInternal(dirs, opts.epoch);
  try {
    linkSync(join(src.dir.path, src.name), join(dst.dir.path, dst.name));
  } catch (err) {
    if (codeOf(err) === "EEXIST") throw txnErr("EXISTS", "destination already exists");
    if (noHardlink(err)) throw hardlinkError(err, src.dir.path);
    throw txnErr("IO", `link failed: ${String(err)}`);
  }
  let linked: { dev: number; ino: number; size: number };
  try {
    linked = lstatRegular(join(dst.dir.path, dst.name));
  } catch (err) {
    throw new TxnFsError("OWNERSHIP", "destination postcondition failed", true, [to]);
  }
  if (linked.dev !== expect.dev || linked.ino !== expect.ino || linked.size !== expect.size)
    throw txnErr("OWNERSHIP", "destination identity changed", true, [to]);
  fsyncDirBestEffort(src.dir.path, undefined, dirs.fsyncWarnings);
  if (src.dir.path !== dst.dir.path) fsyncDirBestEffort(dst.dir.path, undefined, dirs.fsyncWarnings);
  verifyDir(src.dir);
  assertEpochInternal(dirs, opts.epoch);
  const still = lstatRegular(join(src.dir.path, src.name));
  if (still.dev !== expect.dev || still.ino !== expect.ino || still.size !== expect.size)
    throw txnErr("OWNERSHIP", "source changed before unlink", true, [to]);
  verifyDir(src.dir);
  assertEpochInternal(dirs, opts.epoch);
  try {
    unlinkSync(join(src.dir.path, src.name));
  } catch (err) {
    throw txnErr("IO", `source unlink failed: ${String(err)}`, true, [to, from]);
  }
  fsyncDirBestEffort(src.dir.path, undefined, dirs.fsyncWarnings);
}

/** Crash state: a staged tmp may remain before link, both target/tmp may
 * exist after link, or only target may remain after cleanup. */
export function createLocExclusive(
  dirs: RunDirs,
  target: Loc,
  tmp: Loc,
  bytes: Buffer,
  onStaged?: (ident: Ident) => void,
  opts: { epoch?: number } = {},
): Ident {
  const dst = resolveLoc(dirs, target);
  const staging = resolveLoc(dirs, tmp);
  ensureTmp(staging, dst);
  const ident = writeTmpLoc(dirs, tmp, bytes, opts);
  onStaged?.(ident);
  verifyDir(dst.dir);
  assertEpochInternal(dirs, opts.epoch);
  try {
    linkSync(join(staging.dir.path, staging.name), join(dst.dir.path, dst.name));
  } catch (err) {
    if (codeOf(err) === "EEXIST") throw txnErr("EXISTS", "target already exists", true);
    if (noHardlink(err))
      throw new TxnFsError("NO_HARDLINK", hardlinkError(err, dst.dir.path, true).message, true, [tmp]);
    throw txnErr("IO", `link failed: ${String(err)}`, true, [tmp]);
  }
  const observed = observeLoc(dirs, target);
  if (observed.kind !== "file" || !sameIdent(observed, ident))
    throw txnErr("OWNERSHIP", "created target failed identity postcondition", true, [target, tmp]);
  fsyncDirBestEffort(dst.dir.path, undefined, dirs.fsyncWarnings);
  verifyDir(staging.dir);
  assertEpochInternal(dirs, opts.epoch);
  try {
    unlinkObservedLoc(dirs, tmp, ident, opts);
  } catch (err) {
    throw new TxnFsError("IO", "temporary cleanup failed", true, [tmp]);
  }
  return ident;
}

/** Crash state: a staged tmp remains before rename; after rename only the
 * replacement target remains. The before object is never overwritten in place. */
export function replaceLocAtomic(
  dirs: RunDirs,
  target: Loc,
  tmp: Loc,
  bytes: Buffer,
  expect: Ident,
  onStaged?: (ident: Ident) => void,
  opts: { epoch?: number } = {},
): Ident {
  const dst = resolveLoc(dirs, target);
  const staging = resolveLoc(dirs, tmp);
  ensureTmp(staging, dst);
  const ident = writeTmpLoc(dirs, tmp, bytes, opts);
  onStaged?.(ident);
  verifyDir(dst.dir);
  assertEpochInternal(dirs, opts.epoch);
  const current = observeLoc(dirs, target);
  if (current.kind !== "file" || !sameIdent(current, expect)) throw txnErr("CAS_FAILED", "target changed", true, [tmp]);
  verifyDir(dst.dir);
  assertEpochInternal(dirs, opts.epoch);
  try {
    renameSync(join(staging.dir.path, staging.name), join(dst.dir.path, dst.name));
  } catch (err) {
    throw txnErr("IO", `atomic replacement failed: ${String(err)}`, true, [tmp, target]);
  }
  fsyncDirBestEffort(dst.dir.path, undefined, dirs.fsyncWarnings);
  const after = observeLoc(dirs, target);
  if (after.kind !== "file" || !sameIdent(after, ident))
    throw txnErr("OWNERSHIP", "replacement failed identity postcondition", true, [target]);
  return ident;
}

/** Crash state: unlink is the final directory action; it leaves either the
 * verified file or an absent entry, and never deletes an unverified object. */
export function unlinkObservedLoc(
  dirs: RunDirs,
  loc: Loc,
  expect: Pick<Ident, "dev" | "ino" | "sha"> & Partial<Pick<Ident, "size">>,
  opts: { epoch?: number } = {},
): "unlinked" | "absent" {
  const resolved = resolveLoc(dirs, loc);
  verifyDir(resolved.dir);
  assertEpochInternal(dirs, opts.epoch);
  let st;
  try {
    st = lstatSync(join(resolved.dir.path, resolved.name));
  } catch (err) {
    if (codeOf(err) === "ENOENT") return "absent";
    throw txnErr("IO", `cannot stat for unlink: ${String(err)}`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw txnErr("OWNERSHIP", "unlink target is not a regular file");
  const observed = observeLoc(dirs, loc);
  if (
    observed.kind !== "file" ||
    observed.dev !== expect.dev ||
    observed.ino !== expect.ino ||
    observed.sha !== expect.sha ||
    (expect.size !== undefined && observed.size !== expect.size)
  ) {
    throw txnErr("OWNERSHIP", "unlink ownership check failed");
  }
  verifyDir(resolved.dir);
  assertEpochInternal(dirs, opts.epoch);
  try {
    unlinkSync(join(resolved.dir.path, resolved.name));
  } catch (err) {
    if (codeOf(err) === "ENOENT") return "absent";
    throw txnErr("IO", `unlink failed: ${String(err)}`, true, [loc]);
  }
  fsyncDirBestEffort(resolved.dir.path, undefined, dirs.fsyncWarnings);
  return "unlinked";
}

/** Crash state: fsync failure is diagnostic only; the directory operation
 * remains complete and the caller continues under M-T1's process-crash scope. */
export function fsyncDirBestEffort(
  path: string,
  log: (message: string) => void = (message) => console.warn(`[pi-subagent] ${message}`),
  state?: FsyncWarningState,
): void {
  try {
    const fd = openSync(path, fsConstants.O_RDONLY | O_DIRECTORY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if (state === undefined || !state.warnings.has(path)) {
      state?.warnings.add(path);
      log(`best-effort directory fsync failed for ${path}: ${String(err)}`);
    }
  }
}

export interface ProcIdentity {
  pid: number;
  startTicks: number;
  bootId?: string;
}

/** ESRCH is the only proof of death. Every other process.kill failure is
 * treated as alive/unprovable so callers never reclaim an owner on EACCES. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export function readProcIdentity(pid: number): ProcIdentity | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = raw
      .slice(close + 1)
      .trim()
      .split(/\s+/);
    const rawStartTicks = fields[19];
    if (rawStartTicks === undefined) return undefined;
    const startTicks = Number(rawStartTicks);
    if (!Number.isSafeInteger(startTicks) || startTicks < 0) return undefined;
    let bootId: string | undefined;
    try {
      bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
    } catch {
      /* non-Linux */
    }
    return { pid, startTicks, ...(bootId === undefined ? {} : { bootId }) };
  } catch {
    return undefined;
  }
}

type EpochTarget = RunDirs | RunDir | string;
function rootDir(target: EpochTarget): RunDir {
  if (typeof target === "string") return statDir(target, "root");
  return "root" in target ? target.root : target;
}
export function readEpoch(target: EpochTarget): number {
  const root = rootDir(target);
  verifyDir(root);
  try {
    const parsed = JSON.parse(readRegular(root.path, ".owner-epoch").text) as { epoch?: unknown };
    return typeof parsed.epoch === "number" && Number.isSafeInteger(parsed.epoch) && parsed.epoch >= 0
      ? parsed.epoch
      : 0;
  } catch {
    return 0;
  }
}
export function assertEpoch(target: EpochTarget, runEpoch: number): void {
  if (!Number.isSafeInteger(runEpoch) || runEpoch < 0) throw txnErr("EPOCH_REVOKED", "invalid run epoch");
  const current = readEpoch(target);
  if (current > runEpoch)
    throw txnErr("EPOCH_REVOKED", `owner epoch ${runEpoch} has been revoked (current ${current})`);
}
export function bumpEpoch(
  target: EpochTarget,
  by: { pid: number; host: string } = { pid: process.pid, host: "unknown" },
): number {
  const root = rootDir(target);
  verifyDir(root);
  const next = readEpoch(root) + 1;
  const tmp = tmpNameFor(randomBytes(4).toString("hex"), 0, "o");
  const payload = Buffer.from(
    JSON.stringify({ epoch: next, at: new Date().toISOString(), by, reason: "break-lock" }),
    "utf8",
  );
  const tmpPath = join(root.path, tmp);
  verifyDir(root);
  let fd: number;
  try {
    fd = openSync(tmpPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (O_NOFOLLOW ?? 0), 0o600);
  } catch (err) {
    if (codeOf(err) === "EEXIST") throw txnErr("TMP_COLLISION", `temporary already exists: ${tmp}`);
    throw err;
  }
  try {
    writeAll(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  verifyDir(root);
  renameSync(tmpPath, join(root.path, ".owner-epoch"));
  fsyncDirBestEffort(root.path, undefined, createFsyncWarningState());
  return next;
}

/** Crash state: a probe tmp or its linked twin may remain orphaned; no user
 * file is touched and status can report any leftover. */
export function probeHardlinks(dirs: RunDirs, opts: { epoch?: number } = {}): void {
  for (const area of ["live", "archive", "backup"] as const) {
    const dir = dirs[area];
    verifyDir(dir);
    assertEpochInternal(dirs, opts.epoch);
    const nonce = randomBytes(4).toString("hex");
    const first: Loc = { area: "tmp", within: area, name: tmpNameFor(nonce, 0, "p") };
    const second: Loc = { area: "tmp", within: area, name: tmpNameFor(nonce, 0, "p") };
    // Two p names cannot be identical; the second uses a different nonce while
    // retaining the grammar's fixed sequence for probe names.
    second.name = tmpNameFor(randomBytes(4).toString("hex"), 0, "p");
    let ident: Ident | undefined;
    try {
      ident = writeTmpLoc(dirs, first, Buffer.from("probe\\n"), opts);
      verifyDir(dir);
      assertEpochInternal(dirs, opts.epoch);
      try {
        linkSync(join(dir.path, first.name), join(dir.path, second.name));
      } catch (err) {
        if (noHardlink(err)) throw hardlinkError(err, dir.path);
        throw txnErr("IO", `hard-link probe failed: ${String(err)}`);
      }
      fsyncDirBestEffort(dir.path, undefined, dirs.fsyncWarnings);
      const linked = lstatRegular(join(dir.path, second.name));
      if (linked.dev !== ident.dev || linked.ino !== ident.ino)
        throw txnErr("OWNERSHIP", "hard-link probe identity mismatch", true);
      unlinkObservedLoc(dirs, second, ident, opts);
      unlinkObservedLoc(dirs, first, ident, opts);
    } catch (err) {
      try {
        if (ident) unlinkObservedLoc(dirs, first, ident, opts);
      } catch {
        /* orphan is reported by status */
      }
      if (err instanceof TxnFsError && err.code === "NO_HARDLINK")
        throw new TxnFsError("NO_HARDLINK", err.message, false);
      throw err;
    }
  }
}

// ───────────────────────────── lock-file primitives (consumed by lock.ts) ─────────────────────────────

export interface LockPayload {
  pid: number;
  host: string;
  token?: string;
  at: number;
  startTicks?: number | string;
  bootId?: string;
}

const LOCK_NAME = ".lock";

/** Create a complete lock by staging it and linking it into place. On a
 * filesystem without hard links we retain the legacy O_EXCL fallback: this
 * is intentionally limited to the lock, never transaction operations. */
/** Write a grammar-compliant non-operation temporary for lease/manifest
 * callers. The caller owns the subsequent link/rename and cleanup. */
export function writeTxnTemp(dir: string, kind: TmpKind, data: Buffer): string {
  if (kind === "b" || kind === "c") throw new TxnFsError("INVALID_LOC", `operation temporary ${kind} requires a Loc`);
  const name = tmpNameFor(randomBytes(4).toString("hex"), 0, kind);
  verifyMutationDir(dir);
  let fd: number;
  try {
    fd = openSync(
      join(dir, name),
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (err) {
    if (codeOf(err) === "EEXIST") throw new TxnFsError("TMP_COLLISION", `temporary already exists: ${name}`);
    throw err;
  }
  try {
    writeAll(fd, data);
    fsyncSync(fd);
  } catch (err) {
    try {
      closeSync(fd);
    } finally {
      try {
        verifyMutationDir(dir);
        unlinkSync(join(dir, name));
      } catch {
        /* best effort */
      }
    }
    throw err;
  }
  closeSync(fd);
  return name;
}

export function lockCreate(dir: string, payload: LockPayload): boolean {
  const fsyncWarnings = createFsyncWarningState();
  const path = join(dir, LOCK_NAME);
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const tmp = join(dir, tmpNameFor(randomBytes(4).toString("hex"), 0, "l"));
  verifyMutationDir(dir);
  let tempFd: number;
  try {
    tempFd = openSync(tmp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (O_NOFOLLOW ?? 0), 0o600);
    try {
      writeAll(tempFd, bytes);
      fsyncSync(tempFd);
    } finally {
      closeSync(tempFd);
    }
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    if (codeOf(err) === "EEXIST") throw new TxnFsError("TMP_COLLISION", `temporary already exists: ${tmp}`);
    throw err;
  }
  try {
    verifyMutationDir(dir);
    linkSync(tmp, path);
    fsyncDirBestEffort(dir, undefined, fsyncWarnings);
    verifyMutationDir(dir);
    unlinkSync(tmp);
    fsyncDirBestEffort(dir, undefined, fsyncWarnings);
    return true;
  } catch (err) {
    if (codeOf(err) === "EEXIST") {
      try {
        verifyMutationDir(dir);
        unlinkSync(tmp);
      } catch {
        /* best effort */
      }
      return false;
    }
    if (!noHardlink(err)) {
      try {
        verifyMutationDir(dir);
        unlinkSync(tmp);
      } catch {
        /* best effort */
      }
      throw err;
    }
    try {
      verifyMutationDir(dir);
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    // Explicitly preserve the old lock-only degradation. A process crash can
    // leave an empty/partial payload here; lock.ts treats that as unprovable.
    let fd: number;
    try {
      verifyMutationDir(dir);
      fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (O_NOFOLLOW ?? 0), 0o600);
    } catch (fallbackErr) {
      if (codeOf(fallbackErr) === "EEXIST") return false;
      throw fallbackErr;
    }
    try {
      writeAll(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirBestEffort(dir);
    return true;
  }
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
    raw = readRegular(dir, LOCK_NAME).text;
  } catch {
    return undefined;
  }
  let payload: LockPayload | undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.host === "string" &&
      (parsed.token === undefined || typeof parsed.token === "string") &&
      typeof parsed.at === "number"
    ) {
      payload = {
        pid: parsed.pid,
        host: parsed.host,
        at: parsed.at,
        ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
        ...(typeof parsed.startTicks === "string" || typeof parsed.startTicks === "number"
          ? { startTicks: parsed.startTicks }
          : {}),
        ...(typeof parsed.bootId === "string" ? { bootId: parsed.bootId } : {}),
      };
    }
  } catch {
    payload = undefined;
  }
  return { payload, mtimeMs: st.mtimeMs };
}

/** Rename the lock file out of the way then delete it — only one concurrent
 *  breaker can win the rename, so this is the "break a stale lock" primitive. */
export function lockBreak(dir: string): boolean {
  const fsyncWarnings = createFsyncWarningState();
  const path = join(dir, LOCK_NAME);
  const staleName = join(dir, tmpNameFor(randomBytes(4).toString("hex"), 0, "l"));
  try {
    verifyMutationDir(dir);
    renameSync(path, staleName);
  } catch {
    return false;
  }
  fsyncDirBestEffort(dir, undefined, fsyncWarnings);
  try {
    verifyMutationDir(dir);
    unlinkSync(staleName);
  } catch {
    // ignore
  }
  fsyncDirBestEffort(dir, undefined, fsyncWarnings);
  return true;
}

/** Delete the lock file ONLY if it still carries `token` — never removes a
 *  lock someone else has since acquired. */
export function lockRelease(dir: string, token: string): void {
  const fsyncWarnings = createFsyncWarningState();
  const current = lockRead(dir);
  if (current?.payload?.token !== token) return;
  try {
    verifyMutationDir(dir);
    unlinkSync(join(dir, LOCK_NAME));
    fsyncDirBestEffort(dir, undefined, fsyncWarnings);
  } catch {
    // already gone
  }
}
