/** Avatar filesystem boundary. This is deliberately the only avatar module importing node:fs*. */
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import type { FileHandle as NodeFileHandle } from "node:fs/promises";
import { AVATAR_FILE, AVATAR_MAX_BYTES, AVATAR_TMP } from "../../protocol/avatar.js";
import { racePreviewIo, createPreviewIoTracker, PreviewIoError, type PreviewIoTracker } from "../preview/fs.js";

export interface AvatarDirIdentity {
  readonly dev: number;
  readonly ino: number;
}
export interface AvatarFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
}

export interface AvatarHandle {
  stat(): Promise<AvatarFileStat>;
  read(position: number, buffer: Uint8Array, offset: number, length: number): Promise<number>;
  write(buffer: Uint8Array, position?: number): Promise<number>;
  datasync(): Promise<void>;
  close(): Promise<void>;
}

export interface AvatarFs {
  readonly tracker: PreviewIoTracker;
  ensureDir(deadlineAt: number): Promise<AvatarDirIdentity>;
  lstatDir(deadlineAt: number): Promise<AvatarDirIdentity>;
  openRead(path: string, deadlineAt: number): Promise<AvatarHandle>;
  openTemp(path: string, deadlineAt: number): Promise<AvatarHandle>;
  renameTemp(deadlineAt: number): Promise<void>;
  unlinkTemp(deadlineAt: number): Promise<void>;
  unlinkAvatar(deadlineAt: number): Promise<void>;
  fsyncDir(deadlineAt: number): Promise<void>;
}

export interface AvatarFsDeps {
  stateDir: string;
  now?: () => number;
  tracker?: PreviewIoTracker;
  getuid?: () => number;
  lstat?: typeof lstat;
  mkdir?: typeof mkdir;
  chmod?: typeof chmod;
  open?: typeof open;
  rename?: typeof rename;
  unlink?: typeof unlink;
}

const READ_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOCTTY ?? 0);
const TEMP_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (fsConstants.O_NOFOLLOW ?? 0) |
  (fsConstants.O_NOCTTY ?? 0);
const DIR_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
export const avatarDirPath = (stateDir: string): string => `${stateDir}/avatar`;
export const avatarFilePath = (stateDir: string): string => `${avatarDirPath(stateDir)}/${AVATAR_FILE}`;
export const avatarTempPath = (stateDir: string): string => `${avatarDirPath(stateDir)}/${AVATAR_TMP}`;

function statView(s: Awaited<ReturnType<typeof lstat>>): AvatarFileStat {
  return {
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymbolicLink: s.isSymbolicLink(),
    uid: Number(s.uid),
    mode: Number(s.mode),
    nlink: Number(s.nlink),
    size: Number(s.size),
  };
}
function identity(s: Awaited<ReturnType<typeof lstat>>): AvatarDirIdentity {
  return { dev: Number(s.dev), ino: Number(s.ino) };
}
function atPath(root: string, file: string): string {
  return `${root}/avatar/${file}`;
}
function remaining(deadlineAt: number, now: () => number): number {
  return Math.max(0, deadlineAt - now());
}

export function createAvatarFs(deps: AvatarFsDeps): AvatarFs {
  const now = deps.now ?? Date.now;
  const tracker = deps.tracker ?? createPreviewIoTracker(1);
  const ls = deps.lstat ?? lstat;
  const mk = deps.mkdir ?? mkdir;
  const cm = deps.chmod ?? chmod;
  const op = deps.open ?? open;
  const rn = deps.rename ?? rename;
  const un = deps.unlink ?? unlink;
  const uid = deps.getuid ?? (() => process.getuid?.() ?? -1);
  const dir = avatarDirPath(deps.stateDir);

  function assertAvailable(): void {
    if (tracker.zombies >= tracker.max) throw new PreviewIoError("busy", "avatar io tracker tripped");
  }
  async function step<T>(p: Promise<T>, deadlineAt: number): Promise<T> {
    assertAvailable();
    if (remaining(deadlineAt, now) <= 0) throw new PreviewIoError("deadline", "avatar io budget exhausted");
    return racePreviewIo(p, deadlineAt, undefined, now, tracker);
  }
  async function dirStat(deadlineAt: number): Promise<Awaited<ReturnType<typeof lstat>>> {
    return step(ls(dir), deadlineAt);
  }
  async function ensureDir(deadlineAt: number): Promise<AvatarDirIdentity> {
    let s: Awaited<ReturnType<typeof lstat>>;
    try {
      s = await dirStat(deadlineAt);
    } catch (err) {
      if (!isCode(err, "ENOENT")) throw err;
      try {
        await step(mk(dir, { mode: 0o700 }), deadlineAt);
      } catch (mkdirErr) {
        if (!isCode(mkdirErr, "EEXIST")) throw mkdirErr;
      }
      s = await dirStat(deadlineAt);
    }
    const actualUid = uid();
    if (!s.isDirectory() || s.isSymbolicLink() || (actualUid >= 0 && s.uid !== actualUid)) throw fsReason("dir");
    if ((Number(s.mode) & 0o777) !== 0o700) {
      await step(cm(dir, 0o700), deadlineAt);
      s = await dirStat(deadlineAt);
    }
    return identity(s);
  }
  async function lstatDir(deadlineAt: number): Promise<AvatarDirIdentity> {
    const s = await dirStat(deadlineAt);
    const actualUid = uid();
    if (!s.isDirectory() || s.isSymbolicLink() || (actualUid >= 0 && s.uid !== actualUid))
      throw fsReason("dir-swapped");
    return identity(s);
  }
  async function wrap(handle: NodeFileHandle): Promise<AvatarHandle> {
    let closed = false;
    return {
      async stat() {
        return statView(await handle.stat());
      },
      async read(position, buffer, offset, length) {
        return (await handle.read(buffer, offset, length, position)).bytesRead;
      },
      async write(buffer, position = 0) {
        return (await handle.write(buffer, position)).bytesWritten;
      },
      async datasync() {
        await handle.datasync();
      },
      async close() {
        if (!closed) {
          closed = true;
          await handle.close();
        }
      },
    };
  }
  async function openWith(
    path: string,
    flags: number,
    mode: number | undefined,
    deadlineAt: number,
  ): Promise<AvatarHandle> {
    assertAvailable();
    const pending = op(path, flags, mode);
    try {
      const handle = await racePreviewIo(pending, deadlineAt, undefined, now, tracker);
      return wrap(handle);
    } catch (err) {
      // A raced-out open can still resolve. Close that fd when it does; this callback is
      // intentionally independent of the request epoch and is the only late action allowed.
      void pending.then(
        (handle) => handle.close().catch(() => undefined),
        () => undefined,
      );
      throw err;
    }
  }
  return {
    tracker,
    ensureDir,
    lstatDir,
    openRead: (path, deadlineAt) => openWith(path, READ_FLAGS, undefined, deadlineAt),
    openTemp: (path, deadlineAt) => openWith(path, TEMP_FLAGS, 0o600, deadlineAt),
    // The commit operations are returned raw so store.ts can retain the underlying promise for
    // pending/reconcile after the request race has given up. The store applies racePreviewIo
    // with this same tracker at the exact per-step deadline.
    renameTemp: async (_deadlineAt) => rn(atPath(deps.stateDir, AVATAR_TMP), atPath(deps.stateDir, AVATAR_FILE)),
    unlinkTemp: (deadlineAt) => step(un(atPath(deps.stateDir, AVATAR_TMP)), deadlineAt),
    unlinkAvatar: async (_deadlineAt) => un(atPath(deps.stateDir, AVATAR_FILE)),
    fsyncDir: async (deadlineAt) => {
      assertAvailable();
      let handle: NodeFileHandle | undefined;
      try {
        const pending = op(dir, DIR_FLAGS);
        try {
          handle = await racePreviewIo(pending, deadlineAt, undefined, now, tracker);
        } catch (err) {
          void pending.then(
            (late) => late.close().catch(() => undefined),
            () => undefined,
          );
          throw err;
        }
        await racePreviewIo(handle.sync(), deadlineAt, undefined, now, tracker);
      } finally {
        if (handle !== undefined) await handle.close().catch(() => undefined);
      }
    },
  };
}

export async function ensureAvatarDir(fs: AvatarFs, deadlineAt: number): Promise<AvatarDirIdentity> {
  return fs.ensureDir(deadlineAt);
}

/** Naming alias used by assembly code that prefers the preview fs convention. */
export const defaultAvatarFs = createAvatarFs;

function isCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}
function fsReason(reason: string): Error & { code: string } {
  const e = new Error(reason) as Error & { code: string };
  e.code = reason;
  return e;
}

export { AVATAR_MAX_BYTES };
