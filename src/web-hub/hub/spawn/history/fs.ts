/**
 * web-hub session-history plan §4.5 (`fs.ts`): the injectable fs surface every other P-scan
 * module reaches disk through — generation/pin/cwd/snapshot never call `node:fs*` directly, so
 * every op can be faked, slow-injected, or errno-injected in tests (same discipline as
 * `hub/preview/admit.ts`'s `PreviewFs`).
 *
 * `HISTORY_DIR_OPEN_FLAGS` / `HISTORY_FILE_OPEN_FLAGS` carry `O_NOFOLLOW` always and
 * `O_NONBLOCK` on the file flags (PD20: a file swapped for a FIFO/device must never park a
 * libuv thread). Enumeration and header/snapshot reads ONLY ever call these functions with a
 * `/proc/self/fd/<fd>/<name>` path (E8) — this module just executes whatever path it is given;
 * the fd-anchoring discipline lives in `generation.ts`/`pin.ts`/`snapshot.ts`, and fake-fs test
 * doubles assert the paths they receive never start with a literal `R/` prefix.
 */
import { constants, fstatSync, lstatSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

const fsConstants = constants;

export const HISTORY_DIR_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0);
export const HISTORY_FILE_OPEN_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
export const HISTORY_FILE_CREATE_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
/** E8a: re-opening an already-pinned fd via its OWN `/proc/self/fd/<fd>` magic link yields a
 * fresh, independent file description on the SAME inode — `O_NOFOLLOW` must NOT be set here (it
 * would ELOOP on the procfs symlink itself), mirroring `hub/preview/fs.ts`'s
 * `PREVIEW_TASK_OPEN_FLAGS`. */
export const HISTORY_TASK_OPEN_FLAGS = fsConstants.O_RDONLY;

export interface HistoryStat {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly nlink: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface HistoryDirent {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface HistoryHandle {
  readonly fd: number;
  stat(): Promise<HistoryStat>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  write(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesWritten: number }>;
  truncate(len: number): Promise<void>;
  close(): Promise<void>;
}

export interface HistoryFs {
  realpath(path: string): Promise<string>;
  open(path: string, flags: number, mode?: number): Promise<HistoryHandle>;
  readdir(path: string, opts: { withFileTypes: true }): Promise<HistoryDirent[]>;
  lstat(path: string): Promise<HistoryStat>;
  mkdir(path: string, mode: number): Promise<void>;
  unlink(path: string): Promise<void>;
}

/** Sync surface for `pin.ts`'s `verifyForSpawn` / `captureSessionPathPin` / `verifySessionPathPin`
 * (resume-preflight and restore-preflight, both deliberately synchronous — §4.5.6). */
export interface HistorySyncFs {
  lstatSync(path: string): HistoryStat;
  realpathSync(path: string): string;
  fstatSync(fd: number): HistoryStat;
}

interface NodeStatLike {
  dev: number;
  ino: number;
  uid: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  mode: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

function toHistoryStat(st: NodeStatLike): HistoryStat {
  const isFile = st.isFile();
  const isDirectory = st.isDirectory();
  const isSymbolicLink = st.isSymbolicLink();
  return {
    dev: st.dev,
    ino: st.ino,
    uid: st.uid,
    nlink: st.nlink,
    size: st.size,
    mtimeMs: st.mtimeMs,
    mode: st.mode,
    isFile: () => isFile,
    isDirectory: () => isDirectory,
    isSymbolicLink: () => isSymbolicLink,
  };
}

/** Real `FileHandle` adapter — `close()` is idempotent (every exit path can call it safely). */
class RealHistoryHandle implements HistoryHandle {
  private closed = false;

  constructor(private readonly h: FileHandle) {}

  get fd(): number {
    return this.h.fd;
  }

  async stat(): Promise<HistoryStat> {
    return toHistoryStat(await this.h.stat());
  }

  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> {
    return this.h.read(buffer, offset, length, position);
  }

  write(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesWritten: number }> {
    return this.h.write(buffer, offset, length, position);
  }

  truncate(len: number): Promise<void> {
    return this.h.truncate(len);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return this.h.close();
  }
}

export function defaultHistoryFs(): HistoryFs {
  return {
    realpath: (p) => realpath(p),
    open: async (p, flags, mode) => new RealHistoryHandle(await open(p, flags, mode)),
    readdir: async (p) => {
      const ents = await readdir(p, { withFileTypes: true });
      return ents.map((e) => ({
        name: e.name,
        isFile: () => e.isFile(),
        isDirectory: () => e.isDirectory(),
        isSymbolicLink: () => e.isSymbolicLink(),
      }));
    },
    lstat: async (p) => toHistoryStat(await lstat(p)),
    mkdir: async (p, mode) => {
      // recursive:true mirrors `stderr-sink.ts`'s precedent for the same `<stateDir>/spawn/`
      // tree and removes an implicit cross-package bootstrap-ordering dependency (harmless when
      // the parent already exists — unlike a plain mkdir it never throws EEXIST either).
      await mkdir(p, { mode, recursive: true });
    },
    unlink: (p) => unlink(p),
  };
}

export function defaultHistorySyncFs(): HistorySyncFs {
  return {
    lstatSync: (p) => toHistoryStat(lstatSync(p)),
    realpathSync: (p) => realpathSync(p),
    fstatSync: (fd) => toHistoryStat(fstatSync(fd)),
  };
}

/** `/proc/self/fd/<fd>/<name>` — the fd-anchored path form every enumeration/pin/snapshot call
 * uses instead of a by-path walk (E8). */
export function fdPath(fd: number, name?: string): string {
  return name === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${name}`;
}

export function errCodeOf(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = err.code;
    if (typeof code === "string") return code;
  }
  return undefined;
}
