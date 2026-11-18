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

export interface PathBackend {
  readonly platform: "linux" | "darwin";
  available(): boolean;
  path(fd: number, name?: string): string;
  lstatAt(fd: number, rel: string, opts?: FsCheckOpts): Stats;
  locate(fd: number): string;
  prepare(path: string, kind: "dir" | "file"): unknown;
  confirm(snap: unknown, args: { fd: number; path: string; st: Stats; kind: "dir" | "file"; parentFd?: number }): void;
}

interface FdRecord {
  backend: "darwin";
  path: string;
  dev: number;
  ino: number;
  chain: DarwinSnapshot[];
  lastUsed: number;
}
interface FdRegistry {
  map: Map<number, FdRecord>;
  lastSweepAt: number;
}
const FD_PATHS_KEY = Symbol.for("pi-subagent:sched-fd-paths:v1");

function fdRegistry(): FdRegistry | undefined {
  return (globalThis as Record<symbol, unknown>)[FD_PATHS_KEY] as FdRegistry | undefined;
}

function fdBackendOf(fd: number): PathBackend {
  const registry = fdRegistry();
  if (registry === undefined) return linuxPathBackend;
  if (!registry.map.has(fd)) return defaultPathBackend();
  return darwinPathBackend;
}

/** `/proc/self/fd/<fd>[/<name>]`. */
export function fdPath(fd: number, name?: string): string {
  return fdBackendOf(fd).path(fd, name);
}

function linuxFdPath(fd: number, name?: string): string {
  return name === undefined ? `${SCHED_FD_ROOT}/${fd}` : `${SCHED_FD_ROOT}/${fd}/${name}`;
}

function linuxLstatAt(dirFd: number, rel: string, _opts?: FsCheckOpts): Stats {
  return lstatSync(fdPath(dirFd, rel));
}

export const linuxPathBackend: PathBackend = Object.freeze({
  platform: "linux",
  available: () => linuxFdAnchoringAvailable(),
  path: linuxFdPath,
  lstatAt: linuxLstatAt,
  locate: (fd: number) => readlinkSync(linuxFdPath(fd)),
  prepare: () => undefined,
  confirm: () => undefined,
});

export interface DarwinSnapshot {
  dev: number;
  ino: number;
  bt: number | null;
}

export function birthOf(st: Pick<Stats, "birthtimeMs" | "ctimeMs">): number | null {
  return Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 && st.birthtimeMs < st.ctimeMs ? st.birthtimeMs : null;
}

export function darwinSnapshotEqual(snap: DarwinSnapshot, cur: DarwinSnapshot): boolean {
  return snap.dev === cur.dev && snap.ino === cur.ino && (snap.bt === null || snap.bt === cur.bt);
}

export interface DarwinBackendOpts {
  now?: () => number;
  capacity?: number;
  ttlMs?: number;
  birthtime?: "auto" | "off";
  hooks?: { beforeVerify?(point: string): void; afterVerify?(point: string): void };
}

/** Snapshot checks detect completed replacements; the following pathname syscall retains U1-U6. */
export function createDarwinPathBackend(o: DarwinBackendOpts = {}): PathBackend {
  const now = o.now ?? Date.now;
  const capacity = o.capacity ?? 1024;
  const ttl = o.ttlMs ?? 600_000;
  const snapshot = (st: Stats): DarwinSnapshot => ({
    dev: st.dev,
    ino: st.ino,
    bt: o.birthtime === "off" ? null : birthOf(st),
  });
  const prefixes = (path: string): string[] => {
    if (!isAbsolute(path) || path.includes("\0") || path.split("/").some((p) => p === "." || p === ".."))
      throw new SchedFsError("bad-name", "non-canonical directory path");
    const out = ["/"];
    for (const part of path.split("/").filter(Boolean)) out.push(join(out[out.length - 1]!, part));
    return out;
  };
  const chainAt = (path: string): DarwinSnapshot[] =>
    prefixes(path).map((p) => {
      const st = lstatSync(p);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new SchedFsError("moved", "directory chain changed");
      return snapshot(st);
    });
  const verify = (fd: number, point: string): FdRecord => {
    const reg = fdRegistry();
    const rec = reg?.map.get(fd);
    if (!rec) throw new SchedFsError("io", "fd has no verified path");
    try {
      o.hooks?.beforeVerify?.(point);
      const st = fstatSync(fd);
      if (!st.isDirectory() || st.dev !== rec.dev || st.ino !== rec.ino) {
        // The fd identity is dev/ino; birth belongs to each directory chain entry.
        throw new SchedFsError("moved", "directory fd changed");
      }
      const cur = chainAt(rec.path);
      if (cur.length !== rec.chain.length || rec.chain.some((s, i) => !darwinSnapshotEqual(s, cur[i]!)))
        throw new SchedFsError("moved", "directory chain changed");
      rec.lastUsed = now();
    } catch {
      reg!.map.delete(fd);
      throw new SchedFsError("moved", "directory snapshot changed");
    }
    o.hooks?.afterVerify?.(point);
    return rec;
  };
  const backend: PathBackend = {
    platform: "darwin",
    available: () => true,
    prepare(path, kind) {
      let st: Stats;
      try {
        st = lstatSync(path);
      } catch (err) {
        throw mapOpenError(err, kind, path);
      }
      if (st.isSymbolicLink()) throw new SchedFsError("symlink", "symlink refused");
      if (kind === "dir" ? !st.isDirectory() : !st.isFile())
        throw new SchedFsError(kind === "dir" ? "not-dir" : "not-file", "unexpected entry type");
      return snapshot(st);
    },
    confirm(snap, a) {
      o.hooks?.beforeVerify?.("confirm-post");
      try {
        const post = lstatSync(a.path);
        const pre = snap as DarwinSnapshot;
        if (
          post.isSymbolicLink() ||
          !darwinSnapshotEqual(pre, snapshot(a.st)) ||
          !darwinSnapshotEqual(pre, snapshot(post))
        )
          throw new SchedFsError("moved", "entry changed during open");
        if (a.kind === "dir") {
          let chain: DarwinSnapshot[];
          if (a.parentFd !== undefined) {
            const parent = fdRegistry()?.map.get(a.parentFd);
            if (
              !parent ||
              !isPlainName(a.path.slice(parent.path === "/" ? 1 : parent.path.length + 1)) ||
              !a.path.startsWith(parent.path === "/" ? "/" : parent.path + "/")
            )
              throw new SchedFsError("moved", "parent record unavailable");
            chain = [...parent.chain, snapshot(a.st)];
          } else {
            chain = chainAt(a.path);
            if (!darwinSnapshotEqual(chain[chain.length - 1]!, snapshot(a.st)))
              throw new SchedFsError("moved", "directory changed during open");
          }
          let reg = fdRegistry();
          if (!reg) {
            reg = { map: new Map(), lastSweepAt: now() };
            (globalThis as Record<symbol, unknown>)[FD_PATHS_KEY] = reg;
          }
          const t = now();
          if (reg.map.size >= Math.min(256, capacity) || t - reg.lastSweepAt >= 60_000) {
            for (const [fd, rec] of reg.map) {
              try {
                const st = fstatSync(fd);
                if (st.dev !== rec.dev || st.ino !== rec.ino || t - rec.lastUsed > ttl) reg.map.delete(fd);
              } catch {
                reg.map.delete(fd);
              }
            }
            reg.lastSweepAt = t;
          }
          if (reg.map.size >= capacity && !reg.map.has(a.fd)) throw new SchedFsError("io", "fd registry full");
          reg.map.set(a.fd, { backend: "darwin", path: a.path, dev: a.st.dev, ino: a.st.ino, chain, lastUsed: t });
        }
      } catch (err) {
        fdRegistry()?.map.delete(a.fd);
        if (err instanceof SchedFsError) throw err;
        throw new SchedFsError("moved", "entry changed during open");
      }
      o.hooks?.afterVerify?.("confirm-post");
    },
    path(fd, name) {
      if (name !== undefined && !isPlainName(name)) throw new SchedFsError("bad-name", "bad entry name");
      const rec = verify(fd, "path");
      return name === undefined ? rec.path : join(rec.path, name);
    },
    locate(fd) {
      return verify(fd, "locate").path;
    },
    lstatAt(fd, rel, opts) {
      const parts = rel.split("/");
      if (parts.length > 8 || !parts.every(isPlainName)) throw new SchedFsError("bad-name", "bad relative path");
      const opened: number[] = [];
      try {
        verify(fd, "lstatAt");
        let cur = fd;
        for (const part of parts.slice(0, -1)) {
          try {
            const d = openDirAt(cur, part, opts);
            opened.push(d.fd);
            cur = d.fd;
          } catch (err) {
            if (err instanceof SchedFsError && err.reason === "missing")
              throw Object.assign(new Error("missing intermediate directory"), { code: "ENOENT" });
            throw err;
          }
        }
        return lstatSync(backend.path(cur, parts[parts.length - 1]!));
      } finally {
        for (const fd of opened.reverse()) closeQuiet(fd);
      }
    },
  };
  return backend;
}

export const darwinPathBackend: PathBackend = createDarwinPathBackend();

export function defaultPathBackend(): PathBackend {
  return process.platform === "darwin" ? darwinPathBackend : linuxPathBackend;
}

export function lstatAt(fd: number, rel: string, opts?: FsCheckOpts): Stats {
  return fdBackendOf(fd).lstatAt(fd, rel, opts);
}

function linuxFdAnchoringAvailable(): boolean {
  try {
    return statSync(SCHED_FD_ROOT).isDirectory();
  } catch {
    return false;
  }
}

export function fdAnchoringAvailable(): boolean {
  return defaultPathBackend().available();
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
  /** Explicit path backend; consumed only at root/open entry points. */
  backend?: PathBackend;
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
  if (!(opts.backend ?? defaultPathBackend()).available())
    throw new SchedFsError("platform", "fd-anchored opens need /proc/self/fd");
  const backend = opts.backend ?? defaultPathBackend();
  const snap = backend.prepare(path, "dir");
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (err) {
    throw mapOpenError(err, "store dir", path);
  }
  try {
    const st = fstatSync(fd);
    checkStat(st, "dir", "store dir", opts);
    backend.confirm(snap, { fd, path, st, kind: "dir" });
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
    return fdBackendOf(fd).locate(fd);
  } catch (err) {
    if (err instanceof SchedFsError) throw err;
    throw new SchedFsError("io", `cannot resolve fd location: ${errCode(err) ?? String(err)}`);
  }
}

/** Open an existing ancestor directory without owner/mode policy (only for anchored creation). */
export function openDirPathUnchecked(path: string, opts: FsCheckOpts = {}): OpenedDir {
  if (!(opts.backend ?? defaultPathBackend()).available())
    throw new SchedFsError("platform", "fd-anchored opens need /proc/self/fd");
  const backend = opts.backend ?? defaultPathBackend();
  const snap = backend.prepare(path, "dir");
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (err) {
    throw mapOpenError(err, "ancestor dir", path);
  }
  try {
    const st = fstatSync(fd);
    backend.confirm(snap, { fd, path, st, kind: "dir" });
    return { fd, dev: st.dev, ino: st.ino };
  } catch (err) {
    closeQuiet(fd);
    throw err;
  }
}

/** Open child directory `name` of `parentFd` (`O_DIRECTORY|O_NOFOLLOW`, checked). */
export function openDirAt(parentFd: number, name: string, opts: FsCheckOpts = {}): OpenedDir {
  if (!isPlainName(name)) throw new SchedFsError("bad-name", "bad directory name");
  let fd: number;
  const backend = fdBackendOf(parentFd);
  const path = fdPath(parentFd, name);
  const snap = backend.prepare(path, "dir");
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (err) {
    throw mapOpenError(err, `dir ${name}`, path);
  }
  try {
    const st = fstatSync(fd);
    checkStat(st, "dir", `dir ${name}`, opts);
    backend.confirm(snap, { fd, path, st, kind: "dir", parentFd });
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
  const backend = fdBackendOf(dirFd);
  const path = fdPath(dirFd, name);
  const snap = backend.prepare(path, "file");
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
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
    backend.confirm(snap, { fd, path, st, kind: "file", parentFd: dirFd });
    if (backend.platform === "darwin") backend.path(dirFd);
    return { bytes: buf.subarray(0, off), size: off, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino };
  } finally {
    closeQuiet(fd);
  }
}

export function closeQuiet(fd: number | undefined): void {
  if (fd === undefined) return;
  fdRegistry()?.map.delete(fd);
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
  backend?: PathBackend;
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
  const backend = opts.backend ?? defaultPathBackend();
  const dir = openDirPath(real, { ...opts, backend });
  try {
    const actual = fdRealPath(dir.fd);
    vaultCheck(storeDir, actual, opts);
    if (actual !== real) throw new SchedFsError("moved", "store dir moved while being pinned");
    return {
      literal: storeDir,
      real: actual,
      dev: dir.dev,
      ino: dir.ino,
      ...(opts.backend === undefined ? {} : { backend: opts.backend }),
    };
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
  const backend = opts.backend ?? root.backend ?? defaultPathBackend();
  const dir = openDirPath(root.real, { ...opts, backend });
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
