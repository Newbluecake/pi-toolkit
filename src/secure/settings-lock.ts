/**
 * Cross-process lock for rewriting `pi-subagent.json` (data-encryption P1 security review #5, the
 * "需 P2 配合" protocol in docs/dev/data-encryption/P1-report.md).
 *
 * Protocol shared with the launcher (`src/secure/bin/helper.mjs` registerVault): an exclusive
 * flock(2) on `<dir of settings>/.<basename>.lock` (default `~/.pi/agent/.pi-subagent.json.lock`),
 * opened `O_RDONLY|O_CREAT|O_NOFOLLOW` 0600 and fstat-checked to be our own regular file, held over
 * the WHOLE re-read → merge → write tmp → rename. Wait ≤10 s, then give up the write (never fall
 * back to an unlocked write) — except when the `flock` binary does not exist at all: the launcher
 * itself requires `flock`, so without it no concurrent launcher writer can exist and an unlocked
 * (still atomic) write keeps settings persistence working on hosts such as macOS.
 *
 * Node has no flock(2): `flock -x -w 10 3` runs as a synchronous child on OUR descriptor (stdio slot
 * 3). flock locks belong to the open file description, so the lock outlives the child and is held
 * until we close the fd. Everything stays synchronous (callers are synchronous).
 *
 * pi-free; settings.ts imports it (web-hub boundary closure pins the import surface).
 */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export const SETTINGS_LOCK_WAIT_S = 10;
const FLOCK_TIMEOUT_EXIT = 75;

export function settingsLockPath(settingsPath: string): string {
  return join(dirname(settingsPath), `.${basename(settingsPath)}.lock`);
}

export type SettingsLockOutcome<T> = { ok: true; value: T; locked: boolean } | { ok: false; error: string };

export interface SettingsLockDeps {
  /** `flock` binary (tests). */
  flockBin?: string;
  waitS?: number;
}

/**
 * Run `fn` while holding the settings lock. Never throws: lock failures and `fn` throws come back
 * as `{ ok: false }`. `locked:false` only on the documented no-flock-binary exception.
 */
export function withSettingsFileLock<T>(
  settingsPath: string,
  fn: () => T,
  deps: SettingsLockDeps = {},
): SettingsLockOutcome<T> {
  const lockFile = settingsLockPath(settingsPath);
  let fd: number;
  try {
    mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 });
    fd = openSync(
      lockFile,
      constants.O_RDONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
  } catch (error) {
    return { ok: false, error: `设置锁文件 ${lockFile} 无法打开（${errText(error)}）；未写入` };
  }
  try {
    const st = fstatSync(fd);
    const uid = process.getuid?.();
    if (!st.isFile() || (uid !== undefined && st.uid !== uid))
      return { ok: false, error: `设置锁文件 ${lockFile} 不是本用户的普通文件；未写入` };
    const waitS = deps.waitS ?? SETTINGS_LOCK_WAIT_S;
    const r = spawnSync(deps.flockBin ?? "flock", ["-x", "-E", String(FLOCK_TIMEOUT_EXIT), "-w", String(waitS), "3"], {
      stdio: ["ignore", "ignore", "pipe", fd],
      timeout: (waitS + 5) * 1000,
    });
    let locked = true;
    if (r.error) {
      if ((r.error as NodeJS.ErrnoException).code !== "ENOENT")
        return { ok: false, error: `无法获取设置文件锁（${errText(r.error)}）；未写入` };
      locked = false; // no flock binary ⇒ no launcher writer can exist (see header)
    } else if (r.status === FLOCK_TIMEOUT_EXIT) {
      return { ok: false, error: `设置文件锁 ${lockFile} 等待 ${waitS}s 超时（另一个进程正在改写设置）；未写入` };
    } else if (r.status !== 0) {
      return { ok: false, error: `无法获取设置文件锁（flock exit ${String(r.status ?? r.signal)}）；未写入` };
    }
    try {
      return { ok: true, value: fn(), locked };
    } catch (error) {
      return { ok: false, error: errText(error) };
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Atomic settings write (tmp + rename) to the file's REAL location: a symlinked settings file keeps
 * its link (the target is replaced); an existing regular file keeps its permission bits minus
 * group/other write; a new file is 0600. Throws on a non-regular target.
 */
export function writeSettingsFileAtomic(settingsPath: string, text: string): void {
  let target = settingsPath;
  let st: Stats | undefined;
  try {
    target = realpathSync(settingsPath);
    st = lstatSync(target);
  } catch {
    st = undefined; // new file
  }
  if (st && !st.isFile()) throw new Error(`${settingsPath} 不是普通文件`);
  const mode = st ? (st.mode & 0o777 & ~0o022) | 0o600 : 0o600;
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { encoding: "utf8", mode, flag: "w" });
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
