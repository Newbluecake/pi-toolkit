/**
 * Test-infrastructure hardening for web-hub's HOME boundary.
 *
 * This guard is intentionally unrelated to Bug B's root cause: D-B diagnoses socket-fence
 * I/O, while this file prevents a test from accidentally talking to the developer's real hub.
 * It is test-only and must never be imported from src/**.
 */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import net from "node:net";
import childProcess from "node:child_process";
import { afterEach } from "vitest";
import { resolveHubPaths, webHubStateDir } from "../../src/web-hub/protocol/paths.js";

/** Captured while this setup module is evaluated, before any test can mutate HOME. */
export const REAL_HOME = process.env.HOME !== undefined && process.env.HOME !== "" ? process.env.HOME : homedir();
export const REAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? `${REAL_HOME}/.pi/agent`;

const realUid = process.getuid?.() ?? 0;
const realXdg = process.env.XDG_RUNTIME_DIR;
const realPaths = resolveHubPaths({ home: REAL_HOME, uid: realUid, xdgRuntimeDir: realXdg || undefined });
const protectedRoots = [
  webHubStateDir(REAL_HOME),
  realPaths.socketPath,
  ...(realXdg === undefined || realXdg === "" ? [] : [`${realXdg}/pi-webhub.sock`]),
  `/tmp/pi-webhub-${realUid}/hub.sock`,
].map(normalize);

interface Violation {
  operation: string;
  target: string;
  stack: string;
}
const violations: Violation[] = [];
let allowedDepth = 0;

function pathInRoot(target: string, root: string): boolean {
  const t = normalize(isAbsolute(target) ? target : resolve(target));
  const r = normalize(isAbsolute(root) ? root : resolve(root));
  return t === r || t.startsWith(`${r}/`);
}

function forbiddenPath(target: unknown): string | undefined {
  if (typeof target !== "string" || target.startsWith("\0")) return undefined;
  return protectedRoots.find((root) => pathInRoot(target, root));
}

function violation(operation: string, target: string): void {
  if (allowedDepth > 0) return;
  const error = new Error(`sandbox-home guard: ${operation} targeted ${target}`);
  violations.push({ operation, target, stack: error.stack ?? error.message });
  throw error;
}

function socketTarget(args: readonly unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === "string") return first;
  if (typeof first === "object" && first !== null && "path" in first) {
    const path = (first as { path?: unknown }).path;
    return typeof path === "string" ? path : undefined;
  }
  return undefined;
}

function configHome(options: unknown): string | undefined {
  const env =
    typeof options === "object" && options !== null && "env" in options
      ? ((options as { env?: NodeJS.ProcessEnv }).env ?? process.env)
      : process.env;
  const raw = env?.PI_WEBHUB_CONFIG;
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && "home" in value) {
      const home = (value as { home?: unknown }).home;
      return typeof home === "string" ? home : undefined;
    }
  } catch {
    // The production launcher will report malformed config. The guard only protects valid config.
  }
  return undefined;
}

function guardSocket(operation: string, args: readonly unknown[]): void {
  const target = socketTarget(args);
  const root = target === undefined ? undefined : forbiddenPath(target);
  if (target !== undefined && root !== undefined) violation(operation, target);
}

function guardSpawn(operation: string, args: readonly unknown[]): void {
  const home = configHome(args[2]);
  if (home !== undefined && resolve(home) === resolve(REAL_HOME)) violation(operation, `PI_WEBHUB_CONFIG.home=${home}`);
}

// Built-in ESM named exports are snapshots of the CJS built-in exports. Mutate the CJS objects and
// call syncBuiltinESMExports so both `import { connect }` and `import net from "node:net"` observe
// the wrappers. Vitest setupFiles run before test modules are evaluated.
const require = createRequire(import.meta.url);
const netCjs = require("node:net") as typeof net;
const childCjs = require("node:child_process") as typeof childProcess;
const originalConnect = netCjs.connect;
const originalCreateConnection = netCjs.createConnection;
const originalListen = netCjs.Server.prototype.listen;
const originalSpawn = childCjs.spawn;
const originalSpawnSync = childCjs.spawnSync;
const originalFork = childCjs.fork;

const guardedConnect = function (this: unknown, ...args: unknown[]): net.Socket {
  guardSocket("net.connect", args);
  return (originalConnect as (...values: unknown[]) => net.Socket).apply(this, args);
};
const guardedCreateConnection = function (this: unknown, ...args: unknown[]): net.Socket {
  guardSocket("net.createConnection", args);
  return (originalCreateConnection as (...values: unknown[]) => net.Socket).apply(this, args);
};
const guardedListen = function (this: net.Server, ...args: unknown[]): net.Server {
  guardSocket("net.Server.listen", args);
  return (originalListen as (...values: unknown[]) => net.Server).apply(this, args);
};
const guardedSpawn = function (this: unknown, ...args: unknown[]): childProcess.ChildProcess {
  guardSpawn("child_process.spawn", args);
  return (originalSpawn as (...values: unknown[]) => childProcess.ChildProcess).apply(this, args);
};
const guardedSpawnSync = function (this: unknown, ...args: unknown[]): childProcess.SpawnSyncReturns<Buffer> {
  guardSpawn("child_process.spawnSync", args);
  return (originalSpawnSync as (...values: unknown[]) => childProcess.SpawnSyncReturns<Buffer>).apply(this, args);
};
const guardedFork = function (this: unknown, ...args: unknown[]): childProcess.ChildProcess {
  guardSpawn("child_process.fork", args);
  return (originalFork as (...values: unknown[]) => childProcess.ChildProcess).apply(this, args);
};

(netCjs as { connect: typeof net.connect }).connect = guardedConnect as typeof net.connect;
(netCjs as { createConnection: typeof net.createConnection }).createConnection =
  guardedCreateConnection as typeof net.createConnection;
(netCjs.Server.prototype as { listen: typeof net.Server.prototype.listen }).listen =
  guardedListen as typeof net.Server.prototype.listen;
(childCjs as { spawn: typeof childProcess.spawn }).spawn = guardedSpawn as typeof childProcess.spawn;
(childCjs as { spawnSync: typeof childProcess.spawnSync }).spawnSync =
  guardedSpawnSync as typeof childProcess.spawnSync;
(childCjs as { fork: typeof childProcess.fork }).fork = guardedFork as typeof childProcess.fork;
syncBuiltinESMExports();

/** Test-only escape hatch for an intentional real-home integration test. */
export async function withRealHomeAllowed<T>(fn: () => T | Promise<T>): Promise<T> {
  allowedDepth++;
  try {
    return await fn();
  } finally {
    allowedDepth--;
  }
}

/** Test helper for asserting the guard's call-site behavior without failing the containing test. */
export function clearSandboxHomeViolations(): void {
  violations.length = 0;
}

/** Primarily useful to the guard's own tests; callers should prefer afterEach's failure. */
export function sandboxHomeViolations(): readonly Violation[] {
  return [...violations];
}

afterEach(() => {
  if (violations.length === 0) return;
  const details = violations.map((v) => `${v.operation} → ${v.target}\n${v.stack}`).join("\n\n");
  violations.length = 0;
  throw new Error(`sandbox-home guard caught real hub access:\n${details}`);
});
