/**
 * hub single-instance guard (plan §包 B, arch §3.3 三步).
 *
 * ⓪ Linux only — instance guard: `listen("\0pi-webhub-<uid>-<hash(stateDir)>")`,
 *    an abstract-namespace unix socket held for the hub's whole lifetime. The
 *    kernel makes the bind atomic, frees it when the process dies (no stale
 *    state) and nothing on disk can delete it — so a hub whose `hub.sock` /
 *    `hub.json` / `start.lock` were removed by a third party (acceptance #13:
 *    `rm -f` while a TUI-respawned hub was live) still blocks every later
 *    starter. Busy ⇒ the holder answers its pid; an alive same-uid pid ⇒
 *    `exists`. A foreign/dead answer (squatter) ⇒ ignore the guard and fall
 *    back to ①–③. No abstract namespace (non-Linux) ⇒ ①–③ only.
 * ① `open(start.lock, "wx")` (content `pid ts`; stale = holder pid dead or
 *    mtime older than `lockStaleMs` ⇒ unlink + retry once; live holder ⇒ back
 *    off once, then `exists` if a hub answers, else retry the lock once).
 * ② `listen(sock)`; `EADDRINUSE` ⇒ connect-probe with a `probeMs` deadline
 *    (connect success = alive — no `hello` is sent, so the live hub never
 *    registers a dirty record); only ECONNREFUSED/ENOENT count as dead (EAGAIN
 *    = backlog full = a wedged but live hub) ⇒ unlink + listen once more.
 * ③ The lock is released as soon as the socket is bound: from then on the
 *    bound socket itself is the mutual-exclusion token (later starters hit
 *    EADDRINUSE and their probe succeeds). hub.json is written by `hub.ts`.
 *
 * Fence: `startFence` compares `stat(sock).ino` with the inode recorded at
 * listen time; a mismatch or a vanished path ⇒ `onLost()`.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import net from "node:net";
import { dirname } from "node:path";
import { ensurePrivateDir, type HubPaths } from "../protocol/paths.js";
import { pidAlive } from "../protocol/pid.js";

export { pidAlive } from "../protocol/pid.js";

export type SingletonResult =
  | { kind: "owner"; server: import("node:net").Server; inode: number; release(): Promise<void> } // release: close + unlink sock（inode 仍是自己时）
  | { kind: "exists"; hubPid?: number }
  | { kind: "failed"; error: string };

export const DEFAULT_PROBE_MS = 500;
export const DEFAULT_LOCK_STALE_MS = 10_000;
export const DEFAULT_FENCE_MS = 30_000;
/** First fence check comes early: a path removed right after startup must not leave the hub unreachable for 30s. */
export const DEFAULT_FENCE_FIRST_MS = 2_000;
const RELEASE_DEADLINE_MS = 2_000;

export interface SingletonDeps {
  probeMs?: number;
  lockStaleMs?: number;
  now?: () => number;
  /**
   * Instance-guard address (step ⓪). Default: `instanceGuardName(paths)` (abstract socket on
   * Linux, `undefined` elsewhere). `null` disables the guard (tests of the ①–③ fallback).
   */
  guardName?: string | null;
}

export async function acquireSingleton(paths: HubPaths, deps?: SingletonDeps): Promise<SingletonResult> {
  const probeMs = deps?.probeMs ?? DEFAULT_PROBE_MS;
  const lockStaleMs = deps?.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  const now = deps?.now ?? Date.now;

  try {
    ensurePrivateDir(paths.stateDir);
    const sockDir = dirname(paths.socketPath);
    if (sockDir !== paths.stateDir) ensurePrivateDir(sockDir);
  } catch (err) {
    return { kind: "failed", error: `state dir: ${errMsg(err)}` };
  }

  // ⓪ instance guard (held until release(); closed on every non-owner return)
  const guardName = deps?.guardName === undefined ? instanceGuardName(paths) : (deps.guardName ?? undefined);
  let guard: net.Server | undefined;
  if (guardName !== undefined) {
    const g = await acquireGuard(guardName, probeMs);
    if (g.kind === "busy") return existsResult(paths, g.holderPid);
    if (g.kind === "held") guard = g.server;
    // "off": no abstract namespace / foreign squatter ⇒ ①–③ only
  }
  let handedOver = false;
  try {
    const r = await acquireFileSingleton(paths, probeMs, lockStaleMs, now, guard);
    handedOver = r.kind === "owner";
    return r;
  } finally {
    if (!handedOver && guard !== undefined) await closeServer(guard);
  }
}

async function acquireFileSingleton(
  paths: HubPaths,
  probeMs: number,
  lockStaleMs: number,
  now: () => number,
  guard: net.Server | undefined,
): Promise<SingletonResult> {
  // ① start lock
  let lock = tryLock(paths.startLock, now());
  if (lock === "busy" && lockIsStale(paths.startLock, lockStaleMs, now())) {
    safeUnlink(paths.startLock);
    lock = tryLock(paths.startLock, now());
  }
  if (lock === "busy") {
    await delay(probeMs);
    if (await probeAlive(paths.socketPath, probeMs)) return existsResult(paths);
    lock = tryLock(paths.startLock, now());
    if (lock === "busy") return { kind: "failed", error: "start lock held by a live starter" };
  }
  if (typeof lock === "object") return { kind: "failed", error: `start lock: ${lock.error}` };

  try {
    // ② bind
    let bound = await listenOn(paths.socketPath);
    if (bound.kind === "inuse") {
      if (await probeAlive(paths.socketPath, probeMs)) return existsResult(paths);
      safeUnlink(paths.socketPath);
      bound = await listenOn(paths.socketPath);
      if (bound.kind === "inuse") return { kind: "failed", error: "socket still in use after unlink" };
    }
    if (bound.kind === "error") return { kind: "failed", error: `listen: ${bound.error}` };
    const server = bound.server;
    let inode: number;
    try {
      chmodSync(paths.socketPath, 0o600);
      inode = statSync(paths.socketPath).ino;
    } catch (err) {
      await closeServer(server);
      return { kind: "failed", error: `socket stat: ${errMsg(err)}` };
    }
    let released = false;
    return {
      kind: "owner",
      server,
      inode,
      release: async () => {
        if (released) return;
        released = true;
        // libuv unlinks the bound path itself when the server closes (uv__pipe_close). If the
        // path now belongs to someone else (fence lost), park the foreign entry for the
        // duration of the close so it survives, then put it back.
        let ours = false;
        try {
          ours = statSync(paths.socketPath).ino === inode;
        } catch {
          ours = false;
        }
        const parked = `${paths.socketPath}.fenced-${process.pid}`;
        let didPark = false;
        if (!ours) {
          try {
            renameSync(paths.socketPath, parked);
            didPark = true;
          } catch {
            didPark = false; // nothing there (ENOENT) — close's unlink is harmless
          }
        }
        await closeServer(server);
        if (didPark) {
          try {
            renameSync(parked, paths.socketPath);
          } catch {
            // best effort
          }
        }
        // ours: libuv's close already unlinked the path — never unlink again (a new owner may be there).
        // The instance guard goes last: a starter must not see it free while our path is still bound.
        if (guard !== undefined) await closeServer(guard);
      },
    };
  } finally {
    // ③ release the lock — only if it is still ours.
    releaseLock(paths.startLock);
  }
}

export function startFence(
  socketPath: string,
  inode: number,
  onLost: () => void,
  intervalMs: number = DEFAULT_FENCE_MS,
  firstMs: number = Math.min(DEFAULT_FENCE_FIRST_MS, intervalMs),
): () => void {
  let stopped = false;
  let inFlight = false;
  const check = (): void => {
    if (stopped || inFlight) return;
    inFlight = true;
    stat(socketPath).then(
      (st) => {
        inFlight = false;
        if (!stopped && st.ino !== inode) lost();
      },
      () => {
        inFlight = false;
        if (!stopped) lost();
      },
    );
  };
  const first = setTimeout(check, firstMs);
  first.unref();
  const timer = setInterval(check, intervalMs);
  timer.unref();
  function lost(): void {
    stop();
    onLost();
  }
  function stop(): void {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  }
  return stop;
}

// ---------------------------------------------------------------------------
// ⓪ instance guard
// ---------------------------------------------------------------------------

/** Linux abstract-namespace address for this state dir; `undefined` where there is none. */
export function instanceGuardName(
  paths: HubPaths,
  env: { platform?: NodeJS.Platform; uid?: number } = {},
): string | undefined {
  if ((env.platform ?? process.platform) !== "linux") return undefined;
  let dir = paths.stateDir;
  try {
    dir = realpathSync(dir);
  } catch {
    // keep the configured spelling
  }
  const uid = env.uid ?? process.getuid?.() ?? 0;
  const h = createHash("sha256").update(dir).digest("hex").slice(0, 24);
  return `\0pi-webhub-${uid}-${h}`;
}

type GuardResult = { kind: "held"; server: net.Server } | { kind: "busy"; holderPid?: number } | { kind: "off" };

async function acquireGuard(name: string, probeMs: number): Promise<GuardResult> {
  const bound = await listenOn(name, (sock) => {
    sock.on("error", () => undefined);
    sock.end(`${process.pid}\n`);
  });
  if (bound.kind === "ok") {
    bound.server.unref(); // the hub socket (or a bounded startup wait) holds the loop, never the guard
    return { kind: "held", server: bound.server };
  }
  if (bound.kind === "error") return { kind: "off" }; // e.g. no abstract namespace support
  const answer = await askGuard(name, probeMs);
  if (answer.kind === "silent") return { kind: "busy" }; // stopped/wedged holder: never steal
  if (answer.kind === "pid" && pidAlive(answer.pid) && sameUid(answer.pid)) {
    return { kind: "busy", holderPid: answer.pid };
  }
  return { kind: "off" }; // refused / foreign or dead pid: not one of our hubs
}

type GuardAnswer = { kind: "pid"; pid: number } | { kind: "silent" } | { kind: "bogus" };

/** Bounded by `deadlineMs`; ref'd on purpose (see probeAlive). */
function askGuard(name: string, deadlineMs: number): Promise<GuardAnswer> {
  return new Promise((resolve) => {
    let settled = false;
    let buf = "";
    const sock = net.connect(name);
    const done = (a: GuardAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(a);
    };
    const timer = setTimeout(() => done({ kind: "silent" }), deadlineMs);
    const parse = (): GuardAnswer => {
      const pid = Number.parseInt(buf.trim(), 10);
      return Number.isInteger(pid) && pid > 0 && String(pid) === buf.trim() ? { kind: "pid", pid } : { kind: "bogus" };
    };
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.includes("\n")) done(parse());
      else if (buf.length > 32) done({ kind: "bogus" });
    });
    sock.once("end", () => done(buf === "" ? { kind: "bogus" } : parse()));
    sock.once("error", (err) => done(isDeadConnectError(err) ? { kind: "bogus" } : { kind: "silent" }));
  });
}

/** `/proc/<pid>` owned by our uid (unreadable ⇒ trust: same-uid processes are never hidden from us). */
function sameUid(pid: number): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return true;
  try {
    return statSync(`/proc/${pid}`).uid === uid;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tryLock(file: string, ts: number): "ok" | "busy" | { error: string } {
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (err) {
    if (errCode(err) === "EEXIST") return "busy";
    return { error: errMsg(err) };
  }
  try {
    writeSync(fd, `${process.pid} ${ts}\n`);
  } catch {
    // content is advisory; mtime still marks freshness
  } finally {
    closeSync(fd);
  }
  return "ok";
}

function lockIsStale(file: string, staleMs: number, now: number): boolean {
  let mtimeMs: number;
  let content = "";
  try {
    mtimeMs = statSync(file).mtimeMs;
    content = readFileSync(file, "utf8");
  } catch (err) {
    return errCode(err) === "ENOENT"; // vanished meanwhile ⇒ retry is safe
  }
  if (now - mtimeMs > staleMs) return true;
  const pid = Number.parseInt(content.trim().split(/\s+/)[0] ?? "", 10);
  if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) return true;
  return false; // empty (being written) or live holder
}

function releaseLock(file: string): void {
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8").trim().split(/\s+/)[0] ?? "", 10);
    if (pid === process.pid) unlinkSync(file);
  } catch {
    // gone already
  }
}

type Bound = { kind: "ok"; server: net.Server } | { kind: "inuse" } | { kind: "error"; error: string };

function listenOn(socketPath: string, onConnection?: (sock: net.Socket) => void): Promise<Bound> {
  return new Promise((resolve) => {
    const server = onConnection === undefined ? net.createServer() : net.createServer(onConnection);
    const onError = (err: Error): void => {
      server.removeListener("listening", onListening);
      server.close();
      resolve(errCode(err) === "EADDRINUSE" ? { kind: "inuse" } : { kind: "error", error: errMsg(err) });
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve({ kind: "ok", server });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

/** connect success (or a connect that neither succeeds nor fails in time) ⇒ alive. */
function probeAlive(socketPath: string, deadlineMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    // Startup-phase waits stay ref'd on purpose: they are bounded by `deadlineMs`, and in the
    // hub process nothing else holds the loop yet — an unref'd wait would let node exit mid-acquire.
    const sock = net.connect(socketPath);
    const done = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(true), deadlineMs); // stopped peer: never steal
    sock.once("connect", () => done(true));
    // Only "nobody listens" is death. EAGAIN (unix backlog full — a wedged but live hub whose
    // queue filled with reconnect attempts) or anything else ⇒ alive: never steal.
    sock.once("error", (err) => done(!isDeadConnectError(err)));
  });
}

function isDeadConnectError(err: unknown): boolean {
  const code = errCode(err);
  return code === "ECONNREFUSED" || code === "ENOENT";
}

function existsResult(paths: HubPaths, holderPid?: number): SingletonResult {
  const hubPid = holderPid ?? readHubPid(paths.hubJson);
  return hubPid === undefined ? { kind: "exists" } : { kind: "exists", hubPid };
}

function readHubPid(file: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && pidAlive(parsed.pid)
      ? parsed.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, RELEASE_DEADLINE_MS);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function safeUnlink(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // ignore
  }
}

/** Bounded, ref'd on purpose (see probeAlive). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
