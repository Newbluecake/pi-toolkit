/**
 * web-hub upload storage — the raw fs layer (plan `docs/dev/web-hub-upload/plan.md` §2.2).
 *
 * This is the ONLY upload-side module allowed to import `node:fs` directly
 * (`tests/web-hub/hub/upload-fs-guard.test.ts` enforces that `hub/uploads.ts` — the state
 * machine built on top of this — reaches the disk exclusively through the injectable
 * `UploadFsDeps` surface exported here, mirroring `src/memory/safe-fs.ts`'s boundary).
 *
 * Why not reuse `src/memory/safe-fs.ts` outright: it is a synchronous API (would block the hub
 * event loop) and depends on `MemoryError`/memory's own module boundary — §2.2's explicit call.
 * The algorithms are ported per-function with the precedent cited in each doc comment.
 *
 * Every actual fs call goes through `fsStep()`: the call is only *initiated* when the request's
 * absolute deadline still has budget left (§2.2.5 "剩余 ≤ 0 ⇒ 不发起"), and is raced against
 * `min(FS_STEP_CAP_MS, remaining)` with an unref'd timer so a hung filesystem can never wedge
 * the hub (all timer handles satisfy `hasRef() === false`).
 */

import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, link, mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { PrivateDirError } from "../protocol/paths.js";

// ---------------------------------------------------------------------------
// §2.2.5 deadlines
// ---------------------------------------------------------------------------

/** Request-scoped absolute deadline (§2.2.5) — the HTTP layer passes its `reqDeadline`'s `at`. */
export interface Deadline {
  readonly at: number;
}

/** Per-fs-call step cap (§2.2.5): every step gets `min(FS_STEP_CAP_MS, remaining)`. */
export const FS_STEP_CAP_MS = 5_000;

/** §2.2.3 v3 #4: total budget of the constructor-time hardlink probe. */
export const PROBE_CAP_MS = 2_000;

export type UploadFsReason = "short-write" | "deadline" | "chain-mismatch" | "not-regular";

export class UploadFsError extends Error {
  readonly reason: UploadFsReason;

  constructor(reason: UploadFsReason, message: string) {
    super(`upload-fs: ${reason}: ${message}`);
    this.reason = reason;
  }
}

export function isUploadFsDeadline(err: unknown): boolean {
  return err instanceof UploadFsError && err.reason === "deadline";
}

/**
 * Bound one fs call (§2.2.5). The call is created lazily — `lazy()` is NOT invoked when the
 * deadline has already expired — and raced against `min(FS_STEP_CAP_MS, deadline.at - now())`
 * with an unref'd timer. A late underlying result simply resolves a promise nobody awaits
 * anymore; the store's poison machinery (`hub/uploads.ts`) is what makes those harmless.
 */
export function fsStep<T>(lazy: () => Promise<T>, deadline: Deadline, now: () => number): Promise<T> {
  const remaining = deadline.at - now();
  if (remaining <= 0) {
    return Promise.reject(new UploadFsError("deadline", "budget exhausted before fs step"));
  }
  const budget = Math.min(FS_STEP_CAP_MS, remaining);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UploadFsError("deadline", `fs step exceeded ${budget}ms`)), budget);
    timer.unref();
    lazy().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Race `p` against an unref'd `ms` timer, rejecting with the §2.2.5 deadline error. */
export function raceDeadlineUnref<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new UploadFsError("deadline", `operation exceeded ${Math.max(0, ms)}ms`)),
      Math.max(0, ms),
    );
    timer.unref();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** A delay whose timer is unref'd (never keeps the process alive; §U2 acceptance "所有 timer unref"). */
export function unrefDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref();
  });
}

// ---------------------------------------------------------------------------
// §2.2.1 injectable fs surface (fault injection for the U2 hard gates)
// ---------------------------------------------------------------------------

/** Structural slice of `fs.Stats` used by the upload layer (fakes only need these). */
export interface FileStat {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
  readonly size: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** Structural slice of `fs.promises.FileHandle` (fakes only need these). */
export interface UploadFileHandle {
  write(
    buffer: Buffer | Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }>;
  truncate(len: number): Promise<void>;
  datasync(): Promise<void>;
  sync(): Promise<void>;
  stat(): Promise<FileStat>;
  close(): Promise<void>;
}

export interface UploadFsDeps {
  now(): number;
  getuid(): number;
  lstat(path: string): Promise<FileStat>;
  mkdir(path: string, opts: { mode: number }): Promise<string | undefined>;
  chmod(path: string, mode: number): Promise<void>;
  readdir(path: string): Promise<string[]>;
  open(path: string, flags: number, mode?: number): Promise<UploadFileHandle>;
  link(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  readFile(path: string): Promise<string>;
  randomBytes(n: number): Buffer;
}

export function defaultUploadFsDeps(): UploadFsDeps {
  const uid = (): number => process.getuid?.() ?? 0;
  return {
    now: () => Date.now(),
    getuid: uid,
    lstat: (path) => lstat(path),
    mkdir: (path, opts) => mkdir(path, { mode: opts.mode }) as Promise<string | undefined>,
    chmod: (path, mode) => chmod(path, mode),
    readdir: (path) => readdir(path),
    open: (path, flags, mode) => open(path, flags, mode),
    link: (from, to) => link(from, to),
    unlink: (path) => unlink(path),
    rename: (from, to) => rename(from, to),
    rm: (path, opts) => rm(path, opts),
    readFile: (path) => readFile(path, "utf8"),
    randomBytes: (n) => cryptoRandomBytes(n),
  };
}

// ---------------------------------------------------------------------------
// §2.2.1 directory identity & verification
// ---------------------------------------------------------------------------

export interface DirId {
  readonly dev: number;
  readonly ino: number;
}

export interface DirChainEntry {
  readonly path: string;
  readonly id: DirId;
}

/** `[uploads, bucket, id]` — recorded at creation time, re-verified on every open (#3). */
export type DirChain = readonly DirChainEntry[];

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

/** Validate a freshly-`lstat`ed directory against §2.2.1's rules (symlink/owner/mode-repair). */
async function validatePrivateDir(path: string, st: FileStat, fs: UploadFsDeps, deadline: Deadline): Promise<DirId> {
  if (st.isSymbolicLink()) throw new PrivateDirError("symlink", path, `web-hub: ${path} is a symlink`);
  if (!st.isDirectory()) throw new PrivateDirError("not-directory", path, `web-hub: ${path} is not a directory`);
  if (st.uid !== fs.getuid()) {
    throw new PrivateDirError(
      "owner-mismatch",
      path,
      `web-hub: ${path} owned by uid ${st.uid}, expected ${fs.getuid()}`,
    );
  }
  if ((st.mode & 0o777) !== 0o700) {
    // §2.2.1: repair, don't reject — every parent is one of our own 0700 directories (same
    // reasoning as TMP_SOCKET_DIR_POLICY's repairMode, `protocol/paths.ts`).
    await fsStep(() => fs.chmod(path, 0o700), deadline, fs.now);
  }
  return { dev: st.dev, ino: st.ino };
}

/**
 * `ensureUploadDir` (§2.2.1, #3): `lstat` (NEVER `stat` — it follows symlinks), refuse symlinks,
 * verify owner, repair a widened mode back to 0700, and return the recorded `{dev, ino}`.
 * `create:true` makes an ENOENT a non-recursive `mkdir(path, {mode:0700})` (an EEXIST race
 * re-`lstat`s once). Precedents: `paths.ts` `ensureXdgSocketDir` / `ensureTmpSocketDir` — this
 * deliberately does NOT reuse `ensurePrivateDir(STATE_DIR_POLICY)` (v2 #3).
 */
export async function ensureUploadDir(
  path: string,
  opts: { create: boolean },
  fs?: Partial<UploadFsDeps> | undefined,
  deadline?: Deadline | undefined,
): Promise<DirId> {
  const deps: UploadFsDeps = { ...defaultUploadFsDeps(), ...fs };
  const dl: Deadline = deadline ?? { at: deps.now() + FS_STEP_CAP_MS };
  let st: FileStat | undefined;
  try {
    st = await fsStep(() => deps.lstat(path), dl, deps.now);
  } catch (err) {
    if (errCode(err) !== "ENOENT" || !opts.create) {
      throw new PrivateDirError("io", path, `web-hub: ${path}: ${errMsg(err)}`);
    }
  }
  if (st === undefined) {
    try {
      await fsStep(() => deps.mkdir(path, { mode: 0o700 }), dl, deps.now);
    } catch (err) {
      if (errCode(err) !== "EEXIST") {
        throw new PrivateDirError("io", path, `web-hub: ${path}: ${errMsg(err)}`);
      }
      // lost the create race to another starter of the same hub — re-lstat once
    }
    try {
      st = await fsStep(() => deps.lstat(path), dl, deps.now);
    } catch (err) {
      throw new PrivateDirError("io", path, `web-hub: ${path}: ${errMsg(err)}`);
    }
  }
  return validatePrivateDir(path, st, deps, dl);
}

/**
 * `<id>/` creation (§2.1): `mkdir` FIRST (non-recursive, 0700) so a pre-existing entry — any
 * entry, including a symlink — surfaces as a raw `EEXIST` the caller maps to "id 不复用"
 * (`E_UPLOAD_CONFLICT`); only a successful create gets the §2.2.1 validation + `DirId`.
 * A post-`mkdir` validation failure is wrapped in `UploadDirCreateError` with `created:true`
 * so the caller knows the directory is its own and may safely remove it again.
 */
export class UploadDirCreateError extends Error {
  /** `true` when the `mkdir` itself succeeded (the directory on disk is ours to clean up). */
  readonly created: boolean;
  readonly causeErr: unknown;

  constructor(created: boolean, err: unknown) {
    super(`upload-fs: created-dir validation failed: ${err instanceof Error ? err.message : String(err)}`);
    this.created = created;
    this.causeErr = err;
  }
}

export async function createUploadDir(
  path: string,
  fs?: Partial<UploadFsDeps> | undefined,
  deadline?: Deadline | undefined,
): Promise<DirId> {
  const deps: UploadFsDeps = { ...defaultUploadFsDeps(), ...fs };
  const dl: Deadline = deadline ?? { at: deps.now() + FS_STEP_CAP_MS };
  await fsStep(() => deps.mkdir(path, { mode: 0o700 }), dl, deps.now); // EEXIST propagates raw
  try {
    const st = await fsStep(() => deps.lstat(path), dl, deps.now);
    return await validatePrivateDir(path, st, deps, dl);
  } catch (err) {
    if (isUploadFsDeadline(err)) throw err; // deadline: caller's poison/deadline path decides
    throw new UploadDirCreateError(true, err);
  }
}

/**
 * Re-verify a recorded `[uploads, bucket, id]` chain by identity (#3): every level must still
 * `lstat` as a non-symlink directory owned… well, with the exact `dev/ino` recorded at creation
 * (an owner re-check is implied — a different inode is a different directory regardless of
 * owner). Precedent: `safe-fs.ts` `removeFlatDir`'s post-open identity re-check. A mismatch
 * means the directory was replaced between operations: callers must NOT delete by path.
 */
export async function verifyDirChain(
  chain: DirChain,
  fs?: Partial<UploadFsDeps> | undefined,
  deadline?: Deadline | undefined,
): Promise<void> {
  const deps: UploadFsDeps = { ...defaultUploadFsDeps(), ...fs };
  const dl: Deadline = deadline ?? { at: deps.now() + FS_STEP_CAP_MS };
  for (const entry of chain) {
    const st = await fsStep(() => deps.lstat(entry.path), dl, deps.now);
    if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== entry.id.dev || st.ino !== entry.id.ino) {
      throw new UploadFsError(
        "chain-mismatch",
        `${entry.path} is not the directory recorded at creation (dev ${st.dev}/${entry.id.dev}, ino ${st.ino}/${entry.id.ino})`,
      );
    }
  }
}

/** `O_NOFOLLOW`, plus `O_NONBLOCK` when available (a FIFO/device swapped in must not hang the open) — `paths.ts` TRUSTED_FILE_OPEN_FLAGS's reasoning. */
const O_NOFOLLOW_FLAGS = (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/** `.part` creation: exclusive, never through a symlink (§2.2.1/§2.2.2). */
export const PART_CREATE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW_FLAGS;
/** `.part` re-open for append-at-offset chunks / commit's datasync (must already exist). */
export const PART_WRITE_FLAGS = fsConstants.O_WRONLY | O_NOFOLLOW_FLAGS;
/** Read side of a trust-checked regular file (`paths.ts` `TRUSTED_FILE_OPEN_FLAGS` same reasoning). */
export const TRUSTED_READ_FLAGS = fsConstants.O_RDONLY | O_NOFOLLOW_FLAGS;
/** meta.json atomic-rename temp file (§2.2.3 step 4). */
export const META_TMP_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW_FLAGS;
/** Directory fsync (§2.2.3 step 5): `open(dir, O_RDONLY)` + `fh.sync()`. */
export const DIR_SYNC_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0);

/**
 * Open `dirChain[last]/name` with `O_NOFOLLOW` forced in (#3), then — in this order
 * (§2.2.1 "打开后 fstat 复核") — `fh.stat()` must be a regular file, and only afterwards is the
 * whole parent chain re-verified by identity. Any failure closes the handle; a chain mismatch
 * leaves deletion decisions to the caller (never delete a replaced directory by path).
 */
export async function openFileNoFollow(
  dirChain: DirChain,
  name: string,
  flags: number,
  mode?: number | undefined,
  fs?: Partial<UploadFsDeps> | undefined,
  deadline?: Deadline | undefined,
): Promise<UploadFileHandle> {
  const deps: UploadFsDeps = { ...defaultUploadFsDeps(), ...fs };
  const dl: Deadline = deadline ?? { at: deps.now() + FS_STEP_CAP_MS };
  const dir = dirChain[dirChain.length - 1]!.path;
  const path = `${dir}/${name}`;
  const fh = await fsStep(() => deps.open(path, flags | (fsConstants.O_NOFOLLOW ?? 0), mode), dl, deps.now);
  let ok = false;
  try {
    const st = await fsStep(() => fh.stat(), dl, deps.now);
    if (!st.isFile()) throw new UploadFsError("not-regular", `${path} is not a regular file`);
    await verifyDirChain(dirChain, deps, dl);
    ok = true;
    return fh;
  } finally {
    if (!ok) {
      // best-effort close on every failure path — a leaked fd must never outlive the error
      await raceDeadlineUnref(fh.close(), FS_STEP_CAP_MS).catch(() => undefined);
    }
  }
}

/**
 * §2.2.3 step 5: durability of the `<id>/` directory entry itself — `open(dir, O_RDONLY)` +
 * `fsync` (Linux/macOS support this). Purely advisory: an fsync failure only warns, never fails
 * the commit (the meta.json rename is already durable via its own `datasync`). The caller's
 * absolute request `deadline` threads through here like every other step (§2.2.5): with no
 * budget left the `open` is never initiated and the deadline error propagates — the caller
 * (commit) must poison rather than return a success reply after the request budget is gone.
 */
export async function syncDir(
  dir: string,
  fs?: Partial<UploadFsDeps> | undefined,
  deadline?: Deadline | undefined,
): Promise<void> {
  const deps: UploadFsDeps = { ...defaultUploadFsDeps(), ...fs };
  const dl: Deadline = deadline ?? { at: deps.now() + FS_STEP_CAP_MS };
  const fh = await fsStep(() => deps.open(dir, DIR_SYNC_FLAGS), dl, deps.now);
  try {
    await fsStep(() => fh.sync(), dl, deps.now);
  } finally {
    await raceDeadlineUnref(fh.close(), FS_STEP_CAP_MS).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// §2.2.2 complete write
// ---------------------------------------------------------------------------

/**
 * Loop `fh.write` until `buf` is fully written at `position` (§2.2.2, #6) — the async + positioned
 * + deadline-bounded port of `safe-fs.ts:355-367`'s `writeAll`. A `0` return or a throw is a
 * short-write error; the caller is responsible for `fh.truncate(received)` and state rollback.
 */
export async function writeAllAt(
  fh: UploadFileHandle,
  buf: Buffer,
  position: number,
  deadline: Deadline,
  fs?: Partial<UploadFsDeps> | undefined,
): Promise<void> {
  const deps: UploadFsDeps = { ...defaultUploadFsDeps(), ...fs };
  let off = 0;
  while (off < buf.length) {
    const slice = buf.subarray(off);
    const { bytesWritten } = await fsStep(() => fh.write(slice, 0, slice.length, position + off), deadline, deps.now);
    if (bytesWritten <= 0) throw new UploadFsError("short-write", `${off}/${buf.length}`);
    off += bytesWritten;
  }
}

// ---------------------------------------------------------------------------
// §2.2.3 v3 #4 hardlink probe
// ---------------------------------------------------------------------------

/**
 * Constructor-time hardlink probe (§2.2.3 v3 #4): `.probe-<rand>` → `link` → `.probe-<rand>.l` →
 * unlink both, bounded by `deadline` (PROBE_CAP_MS). Any failure — `EPERM`/`ENOTSUP`, timeout,
 * whatever — propagates and the store enters `disabled("no-hardlink")` for its whole lifetime;
 * the v2 fallback (locked lstat+rename) was deleted. Never leaves probe files behind: both names
 * are best-effort unlinked in `finally` even on failure (`recover()` sweeps strays too).
 */
export async function probeHardlink(
  dir: string,
  fs?: Partial<UploadFsDeps> | undefined,
  deadline?: Deadline | undefined,
): Promise<void> {
  const deps: UploadFsDeps = { ...defaultUploadFsDeps(), ...fs };
  const dl: Deadline = deadline ?? { at: deps.now() + PROBE_CAP_MS };
  const name = `.probe-${deps.randomBytes(8).toString("hex")}`;
  const a = `${dir}/${name}`;
  const b = `${dir}/${name}.l`;
  let linked = false;
  try {
    const fh = await fsStep(() => deps.open(a, PART_CREATE_FLAGS, 0o600), dl, deps.now);
    await fsStep(() => fh.close(), dl, deps.now);
    await fsStep(() => deps.link(a, b), dl, deps.now);
    linked = true;
    await fsStep(() => deps.unlink(b), dl, deps.now);
    await fsStep(() => deps.unlink(a), dl, deps.now);
  } finally {
    // best-effort cleanup — a probe must never linger (U2 hard gate 2)
    if (!linked) await deps.unlink(b).catch(() => undefined);
    await deps.unlink(a).catch(() => undefined);
  }
}
