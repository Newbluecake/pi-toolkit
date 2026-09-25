/**
 * web-hub on-disk layout (plan §1.3.1 — frozen interface, S1-W1 接口包).
 *
 * State lives under `<home>/.pi/agent/web-hub/`. Unix domain socket paths are
 * capped by the kernel sockaddr limit, so `hub.sock` has a fallback chain
 * (arch §3 状态目录): `<stateDir>/hub.sock` → `$XDG_RUNTIME_DIR/pi-webhub.sock`
 * → `/tmp/pi-webhub-<uid>/hub.sock`. Only the socket moves; hub.json / token /
 * hub.log / start.lock / hub.db always stay in `stateDir`.
 *
 * `ensurePrivateDir` is async (`fs.promises`) and policy-driven per §1.3.1:
 * W1 keeps P1's exact behavior for `STATE_DIR_POLICY` (the only policy P1's
 * `stateDir` ever used) and stubs the *enforcement* of `XDG_SOCKET_DIR_POLICY`
 * / `TMP_SOCKET_DIR_POLICY` (symlink / owner / sticky-parent checks — LP's
 * job, §11 落地清单 C) so calling `ensurePrivateDir` with either of those two
 * policies throws `E_NOT_IMPLEMENTED:LP` instead of silently skipping the
 * checks it doesn't yet perform. `verifyBoundSocket` (used by LP's hardened
 * `singleton.ts` and by `startFence`'s eventual real check) is a full stub for
 * the same reason: W1's own `acquireSingleton` / `startFence` build a
 * `SocketIdentity` from a private minimal `lstat` helper instead of calling
 * this export (§11 落地清单 B note).
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
 * Create (or repair) a private directory per `policy`. W1 fully implements
 * `STATE_DIR_POLICY` (byte-identical to P1's synchronous behavior, just
 * async): `mkdir -p` with mode 0700; if it already exists, force mode 0700
 * and verify the owner is the current uid. `XDG_SOCKET_DIR_POLICY` /
 * `TMP_SOCKET_DIR_POLICY` enforcement (symlink rejection, sticky-parent check,
 * no-chmod-on-owner-mismatch) is LP's job (§11 落地清单 C) — calling with
 * either throws `E_NOT_IMPLEMENTED:LP`.
 */
export async function ensurePrivateDir(dir: string, policy: DirPolicy, deps?: Partial<FsDeps>): Promise<DirIdentity> {
  if (policy !== STATE_DIR_POLICY) {
    throw new Error("E_NOT_IMPLEMENTED:LP");
  }
  const fs = { ...defaultFsDeps(), ...deps };
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

// ---------------------------------------------------------------------------
// verifyBoundSocket — stub (LP fills in symlink/owner/sticky enforcement)
// ---------------------------------------------------------------------------

export interface SocketIdentity {
  readonly socket: DirIdentity;
  readonly dir: DirIdentity;
}

/**
 * `lstat` the bound socket and its containing directory: socket must not be a
 * symlink and must be owned by the current uid; the directory's `{dev,ino}`
 * must equal `dirBefore` (no swap between the pre-bind check and now). W1
 * stub: throws `E_NOT_IMPLEMENTED:LP` unconditionally — `acquireSingleton`
 * builds its own `identity` via a minimal private `lstat` (dev/ino only, no
 * symlink/owner check) instead of calling this export; LP replaces that
 * internal call with this function once it is filled in.
 */
export async function verifyBoundSocket(
  _socketPath: string,
  _dirBefore: DirIdentity,
  _deps?: Partial<FsDeps>,
): Promise<SocketIdentity> {
  throw new Error("E_NOT_IMPLEMENTED:LP");
}

function byteLength(p: string): number {
  return Buffer.from(p, "utf8").length;
}
