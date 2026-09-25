/**
 * web-hub on-disk layout (plan §包 A — frozen interface).
 *
 * State lives under `<home>/.pi/agent/web-hub/`. Unix domain socket paths are
 * capped by the kernel sockaddr limit, so `hub.sock` has a fallback chain
 * (arch §3 状态目录): `<stateDir>/hub.sock` → `$XDG_RUNTIME_DIR/pi-webhub.sock`
 * → `/tmp/pi-webhub-<uid>/hub.sock`. Only the socket moves; hub.json / token /
 * hub.log / start.lock always stay in `stateDir`.
 */
import { Buffer } from "node:buffer";
import { chmodSync, mkdirSync, statSync } from "node:fs";

export const SOCKET_PATH_MAX_BYTES = 100;

export interface HubPaths {
  stateDir: string;
  socketPath: string;
  hubJson: string;
  tokenFile: string;
  logFile: string;
  startLock: string;
}

export interface HubPathsEnv {
  home: string;
  uid: number;
  xdgRuntimeDir?: string | undefined;
}

/** `<home>/.pi/agent/web-hub` */
export function webHubStateDir(home: string): string {
  return `${home}/.pi/agent/web-hub`;
}

/** Pure path resolution (no fs access) including the >100-byte socket fallback chain. */
export function resolveHubPaths(env: HubPathsEnv): HubPaths {
  const stateDir = webHubStateDir(env.home);
  const candidates: string[] = [`${stateDir}/hub.sock`];
  if (env.xdgRuntimeDir !== undefined) candidates.push(`${env.xdgRuntimeDir}/pi-webhub.sock`);
  candidates.push(`/tmp/pi-webhub-${env.uid}/hub.sock`);
  const socketPath =
    candidates.find((c) => byteLength(c) <= SOCKET_PATH_MAX_BYTES) ?? candidates[candidates.length - 1]!;
  return {
    stateDir,
    socketPath,
    hubJson: `${stateDir}/hub.json`,
    tokenFile: `${stateDir}/token`,
    logFile: `${stateDir}/hub.log`,
    startLock: `${stateDir}/start.lock`,
  };
}

/**
 * Create (or repair) a private directory: `mkdir -p` with mode 0700; if it
 * already exists, force mode 0700 and verify the owner is the current uid.
 * Throws otherwise — a shared/wrong-owner directory must never hold the token.
 */
export function ensurePrivateDir(dir: string): void {
  const uid = process.getuid?.();
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(dir);
  } catch {
    mkdirSync(dir, { mode: 0o700, recursive: true });
    // umask may have masked owner bits on freshly created segments.
    chmodSync(dir, 0o700);
    st = statSync(dir);
  }
  if (!st.isDirectory()) {
    throw new Error(`web-hub: ${dir} exists and is not a directory`);
  }
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`web-hub: ${dir} owned by uid ${st.uid}, expected ${uid}`);
  }
  chmodSync(dir, 0o700);
}

function byteLength(p: string): number {
  return Buffer.from(p, "utf8").length;
}
