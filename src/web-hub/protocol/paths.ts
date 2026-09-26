/**
 * web-hub on-disk layout (plan §1.3.1 — frozen interface, S1-W1 接口包).
 *
 * State lives under `<home>/.pi/agent/web-hub/`. Unix domain socket paths are
 * capped by the kernel sockaddr limit, so `hub.sock` has a fallback chain
 * (arch §3 状态目录): `<stateDir>/hub.sock` → `$XDG_RUNTIME_DIR/pi-webhub.sock`
 * → `/tmp/pi-webhub-<uid>/hub.sock`. Only the socket moves; hub.json / token /
 * hub.log / start.lock / hub.db always stay in `stateDir`.
 *
 * `ensurePrivateDir` is async (`fs.promises`) and policy-driven per §1.3.1.
 * `STATE_DIR_POLICY` is W1's (byte-identical to P1's synchronous behavior,
 * just async). LP (this file, S1-W2) fills in the *enforcement* of
 * `XDG_SOCKET_DIR_POLICY` (a pre-existing directory we don't own — check
 * only, never create/repair) and `TMP_SOCKET_DIR_POLICY` (`/tmp` fallback —
 * create/repair, but only under a sticky parent) and implements
 * `verifyBoundSocket` (symlink / owner check on the bound socket *and* its
 * containing directory).
 *
 * `verifyBoundSocket(socketPath, dirBefore, deps)` deliberately does **not**
 * throw when the directory's freshly-observed `{dev,ino}` differs from
 * `dirBefore` — it only rejects hygiene violations (wrong type, symlink,
 * wrong owner) on the socket and its directory, and otherwise always
 * returns the identity it actually observed. A bare identity drift (the
 * directory swapped for a *different* directory that still passes every
 * hygiene check) is exactly the "seen vs. recorded identity differs" case
 * `singleton.ts`'s frozen `fenceLossOf` classifies as `"dir-replaced"` /
 * `"socket-replaced"` from the *caller's* own comparison of this return
 * value against its reference (`dirBefore` again at bind time, `identity.dir`
 * at fence time) — throwing here for a bare mismatch would make that
 * classification unreachable, since `fenceLossOf`'s thrown-`PrivateDirError`
 * branch has no reason dedicated to "identity changed" (only to type /
 * symlink / owner violations) and would otherwise fall through to the
 * deferred `"io"` bucket instead of firing immediately. `dirBefore` is kept
 * in the signature (frozen, §1.3.1) purely to document what the caller's own
 * comparison is against; the bind-time caller (`singleton.ts`) does exactly
 * that comparison itself right after calling this function.
 */

import { Buffer } from "node:buffer";
import { chmod, lstat, mkdir, realpath, stat } from "node:fs/promises";

export const SOCKET_PATH_MAX_BYTES = 100;

// ---------------------------------------------------------------------------
// §1.3.1 frozen types
// ---------------------------------------------------------------------------

export interface DirPolicy {
  readonly create: boolean; // false ⇒ 只检查（$XDG_RUNTIME_DIR 不是我们的目录）
  readonly recursive: boolean; // mkdir -p（只对 stateDir）
  readonly allowOwnedSymlink: boolean; // 目录本身是 symlink：链接属主为当前 uid ⇒ realpath 后检查目标；否则拒绝
  readonly repairMode: boolean; // 属主是自己但模式宽于 0700 ⇒ chmod + warn；false ⇒ 拒绝
  readonly parentMustBeSticky: boolean; // /tmp 回落：realpath(parent) 必须是目录且 (mode & 0o1000) !== 0
}

export const STATE_DIR_POLICY: DirPolicy = {
  create: true,
  recursive: true,
  allowOwnedSymlink: true,
  repairMode: true,
  parentMustBeSticky: false,
};

export const XDG_SOCKET_DIR_POLICY: DirPolicy = {
  create: false,
  recursive: false,
  allowOwnedSymlink: false,
  repairMode: false,
  parentMustBeSticky: false,
};

export const TMP_SOCKET_DIR_POLICY: DirPolicy = {
  create: true,
  recursive: false,
  allowOwnedSymlink: false,
  repairMode: true,
  parentMustBeSticky: true,
};

export interface DirIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface HubPaths {
  stateDir: string;
  socketPath: string;
  socketDir: string; // dirname(socketPath)
  hubJson: string;
  tokenFile: string;
  logFile: string;
  startLock: string;
  policies: { readonly stateDir: DirPolicy; readonly socketDir: DirPolicy };
  dbFile: string; // §4.1
}

export interface HubPathsEnv {
  home: string;
  uid: number;
  xdgRuntimeDir?: string | undefined;
}

export type PrivateDirReason = "not-directory" | "symlink" | "owner-mismatch" | "mode" | "parent-not-sticky" | "io";

export class PrivateDirError extends Error {
  readonly reason: PrivateDirReason;
  readonly dir: string;

  constructor(reason: PrivateDirReason, dir: string, message?: string) {
    super(message ?? `web-hub: ${dir}: ${reason}`);
    this.reason = reason;
    this.dir = dir;
  }
}

export type FsDeps = Pick<typeof import("node:fs/promises"), "lstat" | "stat" | "mkdir" | "chmod" | "realpath"> & {
  getuid(): number;
};

function defaultFsDeps(): FsDeps {
  return { lstat, stat, mkdir, chmod, realpath, getuid: () => process.getuid?.() ?? 0 };
}

// ---------------------------------------------------------------------------
// pure path resolution
// ---------------------------------------------------------------------------

/** `<home>/.pi/agent/web-hub` */
export function webHubStateDir(home: string): string {
  return `${home}/.pi/agent/web-hub`;
}

function dirnameOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

function policyFor(socketDir: string, stateDir: string, xdgRuntimeDir: string | undefined): DirPolicy {
  if (socketDir === stateDir) return STATE_DIR_POLICY;
  if (xdgRuntimeDir !== undefined && socketDir === xdgRuntimeDir) return XDG_SOCKET_DIR_POLICY;
  return TMP_SOCKET_DIR_POLICY;
}

/** Pure path resolution (no fs access) including the >100-byte socket fallback chain. */
export function resolveHubPaths(env: HubPathsEnv): HubPaths {
  const stateDir = webHubStateDir(env.home);
  const candidates: string[] = [`${stateDir}/hub.sock`];
  if (env.xdgRuntimeDir !== undefined) candidates.push(`${env.xdgRuntimeDir}/pi-webhub.sock`);
  candidates.push(`/tmp/pi-webhub-${env.uid}/hub.sock`);
  const socketPath =
    candidates.find((c) => byteLength(c) <= SOCKET_PATH_MAX_BYTES) ?? candidates[candidates.length - 1]!;
  const socketDir = dirnameOf(socketPath);
  return {
    stateDir,
    socketPath,
    socketDir,
    hubJson: `${stateDir}/hub.json`,
    tokenFile: `${stateDir}/token`,
    logFile: `${stateDir}/hub.log`,
    startLock: `${stateDir}/start.lock`,
    dbFile: `${stateDir}/hub.db`,
    policies: { stateDir: STATE_DIR_POLICY, socketDir: policyFor(socketDir, stateDir, env.xdgRuntimeDir) },
  };
}

// ---------------------------------------------------------------------------
// ensurePrivateDir (async; policy-driven)
// ---------------------------------------------------------------------------

/**
 * Create (or repair) a private directory per `policy` (§1.3.1 table). Every
 * branch is `fs.promises`-based (no sync fs calls) and takes injectable
 * `deps` for testing.
 *
 * - `STATE_DIR_POLICY` (W1): byte-identical to P1's synchronous behavior,
 *   just async — `mkdir -p` with mode 0700; if it already exists, force
 *   mode 0700 and verify the owner is the current uid.
 * - `XDG_SOCKET_DIR_POLICY` (LP): a pre-existing directory we don't own —
 *   `create:false` ⇒ never `mkdir`s; ENOENT (or any `lstat` failure) is
 *   `PrivateDirError("io", …)` (§1.3.5); otherwise it must lstat as a
 *   directory (not a symlink — `allowOwnedSymlink:false`), owned by the
 *   current uid, with `(mode & 0o077) === 0`; a wider mode is rejected as
 *   `"mode"` (`repairMode:false` — never chmod'd).
 * - `TMP_SOCKET_DIR_POLICY` (LP): the `/tmp` fallback. First checks the
 *   *parent* of `dir` is, after `realpath`, a sticky directory
 *   (`parentMustBeSticky`) — otherwise `"parent-not-sticky"` (another uid in
 *   a non-sticky parent could otherwise delete/replace our directory
 *   between checks). Then `lstat(dir)`: ENOENT ⇒ `mkdir(dir, {mode:0o700})`
 *   (non-recursive — `recursive:false`; an `EEXIST` race re-`lstat`s once).
 *   The (possibly just-created) entry must be a directory, not a symlink
 *   (`allowOwnedSymlink:false`) and owned by the current uid (`"symlink"` /
 *   `"not-directory"` / `"owner-mismatch"` otherwise, the last one without
 *   chmod'ing); a mode wider than 0700 is repaired in place
 *   (`repairMode:true` — sticky parent means other uids can't replace our
 *   entry between the check and the chmod).
 */
export async function ensurePrivateDir(dir: string, policy: DirPolicy, deps?: Partial<FsDeps>): Promise<DirIdentity> {
  const fs = { ...defaultFsDeps(), ...deps };
  if (policy === XDG_SOCKET_DIR_POLICY) return ensureXdgSocketDir(dir, fs);
  if (policy === TMP_SOCKET_DIR_POLICY) return ensureTmpSocketDir(dir, fs);
  const uid = fs.getuid();
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await fs.stat(dir);
  } catch {
    await fs.mkdir(dir, { mode: 0o700, recursive: true });
    // umask may have masked owner bits on freshly created segments.
    await fs.chmod(dir, 0o700);
    st = await fs.stat(dir);
  }
  if (!st.isDirectory()) {
    throw new PrivateDirError("not-directory", dir, `web-hub: ${dir} exists and is not a directory`);
  }
  if (st.uid !== uid) {
    throw new PrivateDirError("owner-mismatch", dir, `web-hub: ${dir} owned by uid ${st.uid}, expected ${uid}`);
  }
  await fs.chmod(dir, 0o700);
  return { dev: st.dev, ino: st.ino };
}

/** `XDG_SOCKET_DIR_POLICY`: check-only, never create/repair (§1.3.1 table). */
async function ensureXdgSocketDir(dir: string, fs: FsDeps): Promise<DirIdentity> {
  const uid = fs.getuid();
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await fs.lstat(dir);
  } catch (err) {
    // create:false — we never mkdir here, so an ENOENT (or any other lstat
    // failure) is not a "the directory is missing on purpose" signal, it's
    // an unusable candidate; §1.3.5: "create:false 下 ENOENT ⇒ io".
    throw new PrivateDirError("io", dir, `web-hub: ${dir}: ${errMsg(err)}`);
  }
  if (st.isSymbolicLink()) throw new PrivateDirError("symlink", dir, `web-hub: ${dir} is a symlink`);
  if (!st.isDirectory()) throw new PrivateDirError("not-directory", dir, `web-hub: ${dir} is not a directory`);
  if (st.uid !== uid) {
    throw new PrivateDirError("owner-mismatch", dir, `web-hub: ${dir} owned by uid ${st.uid}, expected ${uid}`);
  }
  if ((st.mode & 0o077) !== 0) {
    throw new PrivateDirError(
      "mode",
      dir,
      `web-hub: ${dir} mode ${(st.mode & 0o777).toString(8)} is group/other-accessible`,
    );
  }
  return { dev: st.dev, ino: st.ino };
}

/** `TMP_SOCKET_DIR_POLICY`: `/tmp` fallback — create/repair under a sticky parent (§1.3.1 table). */
async function ensureTmpSocketDir(dir: string, fs: FsDeps): Promise<DirIdentity> {
  await checkStickyParent(dir, fs);
  const uid = fs.getuid();
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await fs.lstat(dir);
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw new PrivateDirError("io", dir, `web-hub: ${dir}: ${errMsg(err)}`);
    try {
      await fs.mkdir(dir, { mode: 0o700 });
    } catch (mkErr) {
      if (errCode(mkErr) !== "EEXIST") throw new PrivateDirError("io", dir, `web-hub: ${dir}: ${errMsg(mkErr)}`);
      // lost the mkdir race to another starter (same uid — this dir's parent is ours-or-sticky) — re-lstat once.
    }
    try {
      st = await fs.lstat(dir);
    } catch (err2) {
      throw new PrivateDirError("io", dir, `web-hub: ${dir}: ${errMsg(err2)}`);
    }
  }
  if (st.isSymbolicLink()) throw new PrivateDirError("symlink", dir, `web-hub: ${dir} is a symlink`);
  if (!st.isDirectory()) throw new PrivateDirError("not-directory", dir, `web-hub: ${dir} is not a directory`);
  if (st.uid !== uid) {
    throw new PrivateDirError("owner-mismatch", dir, `web-hub: ${dir} owned by uid ${st.uid}, expected ${uid}`);
  }
  if ((st.mode & 0o777) !== 0o700) {
    // repairMode:true — the sticky parent means no other uid can swap this entry out from under
    // us between this check and the chmod, so repairing in place (rather than rejecting) is safe.
    await fs.chmod(dir, 0o700);
    const repaired = await fs.lstat(dir);
    return { dev: repaired.dev, ino: repaired.ino };
  }
  return { dev: st.dev, ino: st.ino };
}

/** `parentMustBeSticky` (§1.3.1 table): `realpath` the parent, then confirm it's a sticky directory. */
async function checkStickyParent(dir: string, fs: FsDeps): Promise<void> {
  const parent = dirnameOf(dir);
  let real: string;
  try {
    real = await fs.realpath(parent);
  } catch (err) {
    throw new PrivateDirError(
      "parent-not-sticky",
      dir,
      `web-hub: ${dir}: parent ${parent} is unavailable: ${errMsg(err)}`,
    );
  }
  let pst: Awaited<ReturnType<typeof stat>>;
  try {
    pst = await fs.stat(real);
  } catch (err) {
    throw new PrivateDirError(
      "parent-not-sticky",
      dir,
      `web-hub: ${dir}: parent ${parent} is unavailable: ${errMsg(err)}`,
    );
  }
  if (!pst.isDirectory() || (pst.mode & 0o1000) === 0) {
    throw new PrivateDirError("parent-not-sticky", dir, `web-hub: ${dir}: parent ${parent} is not a sticky directory`);
  }
}

// ---------------------------------------------------------------------------
// verifyBoundSocket
// ---------------------------------------------------------------------------

export interface SocketIdentity {
  readonly socket: DirIdentity;
  readonly dir: DirIdentity;
}

/**
 * `lstat` the bound socket and its containing directory: the socket must not
 * be a symlink and must be a socket owned by the current uid; the directory
 * must not be a symlink and must be owned by the current uid. Used both
 * right after `bind()` (`singleton.ts`'s `bindIdentityAndOwn`, where the
 * caller additionally compares the returned `.dir` against its own
 * `dirBefore` to catch a TOCTOU swap between `ensurePrivateDir` and the bind)
 * and by `startFence`'s periodic check (where the caller compares the
 * returned identity against the one recorded at bind time to detect
 * `"socket-replaced"` / `"dir-replaced"`) — see the file header for why this
 * function itself never throws for a bare `dirBefore` mismatch.
 */
export async function verifyBoundSocket(
  socketPath: string,
  _dirBefore: DirIdentity,
  deps?: Partial<FsDeps>,
): Promise<SocketIdentity> {
  const fs = { ...defaultFsDeps(), ...deps };
  const uid = fs.getuid();
  const dir = dirnameOf(socketPath);

  // ENOENT (or any other lstat failure) propagates as-is — callers (bind-site catch-all,
  // `fenceLossOf`'s ENOENT⇒"socket-missing" mapping) rely on the raw error shape, not a
  // `PrivateDirError` wrapper, to recognize "the socket is simply gone".
  const socketSt = await fs.lstat(socketPath);
  if (socketSt.isSymbolicLink())
    throw new PrivateDirError("symlink", socketPath, `web-hub: ${socketPath} is a symlink`);
  if (!socketSt.isSocket())
    throw new PrivateDirError("not-directory", socketPath, `web-hub: ${socketPath} is not a socket`);
  if (socketSt.uid !== uid) {
    throw new PrivateDirError(
      "owner-mismatch",
      socketPath,
      `web-hub: ${socketPath} owned by uid ${socketSt.uid}, expected ${uid}`,
    );
  }

  const dirSt = await fs.lstat(dir);
  if (dirSt.isSymbolicLink()) throw new PrivateDirError("symlink", dir, `web-hub: ${dir} is a symlink`);
  if (!dirSt.isDirectory()) throw new PrivateDirError("not-directory", dir, `web-hub: ${dir} is not a directory`);
  if (dirSt.uid !== uid) {
    throw new PrivateDirError("owner-mismatch", dir, `web-hub: ${dir} owned by uid ${dirSt.uid}, expected ${uid}`);
  }

  return {
    socket: { dev: socketSt.dev, ino: socketSt.ino },
    dir: { dev: dirSt.dev, ino: dirSt.ino },
  };
}

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function byteLength(p: string): number {
  return Buffer.from(p, "utf8").length;
}
