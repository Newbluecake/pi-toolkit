/**
 * hub single-instance guard (plan §1.3.2 / §1.3.3 — frozen interface, S1-W1
 * 接口包).
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
 *    Review fix #5 (v1): every lock/probe/release file op (`open`/`stat`/
 *    `readFile`/`unlink`/`rename`) is `fs.promises`, not `*Sync`. Review fix
 *    #3 (v2): so are `instanceGuardName`'s `realpath` and the guard-answer
 *    uid check (`sameUid`) — both now take the startup `signal` too.
 * ② `listen(sock)`; `EADDRINUSE` ⇒ connect-probe with a `probeMs` deadline
 *    (connect success = alive — no `hello` is sent, so the live hub never
 *    registers a dirty record); only ECONNREFUSED/ENOENT count as dead (EAGAIN
 *    = backlog full = a wedged but live hub) ⇒ unlink + listen once more.
 *    Once bound, `identity` (dev/ino of the socket + its containing dir) is
 *    captured via a minimal `lstat`-only helper — W1 does *not* call the
 *    exported `verifyBoundSocket` (that stub enforces symlink/owner checks,
 *    LP's job; see `protocol/paths.ts`).
 * ③ The lock is released as soon as the socket is bound: from then on the
 *    bound socket itself is the mutual-exclusion token (later starters hit
 *    EADDRINUSE and their probe succeeds). hub.json is written by `hub.ts`.
 *
 * Cancellation (`SingletonDeps.signal`, §3.1's `startup` scope): every
 * internal await is raced against the signal via `withSignal` (a genuinely
 * hung fs call — as injected by `startup-cancel.test.ts` — must still let
 * `acquireSingleton` return promptly once the deadline fires); a late bind
 * that only notices the abort *after* it already owns the socket closes the
 * server (which unlinks the still-ours path via libuv) before returning
 * `{kind:"failed", reason:"aborted"}`.
 *
 * Review fix #2 (v2): `releaseLock` (unraced by design — releasing a lock we
 * hold must run to completion even after abort) sits in `acquireFileSingleton`'s
 * `finally`, which runs *before* the function's own promise settles — the
 * outer `withSignal` wrap around the whole `acquireSingleton(...)` call at
 * the `hub.ts` call site can therefore have already timed out and moved on
 * *while* `releaseLock` is still running unraced. If that happens, the
 * "owner" value this function is about to return is a **late result nobody
 * is listening for**: unlike the identity-computation/bind checks earlier in
 * this function (which the caller is still awaiting when they run), a value
 * constructed after `releaseLock` returns is handed to a caller who may
 * already be gone. So `signal` is re-checked *after* the try/finally (i.e.
 * after `releaseLock` has actually finished) and, if aborted by then, the
 * about-to-be-returned owner self-releases (closing the socket server *and*
 * the instance guard) before reporting `{kind:"failed", reason:"aborted"}`
 * instead of handing back a value nobody will ever call `.release()` on.
 * `release()`'s own `lstat`/`rename` calls are now bounded by
 * `RELEASE_DEADLINE_MS` too (`withDeadline`), matching `closeServer`'s
 * existing bound — a wedged disk during release must not hang it.
 *
 * Review fix #2 (v3): `releaseLock` itself was still unbounded — a wedged
 * `readFile`/`unlink` there would hang the `finally` block forever, which
 * means the late-abort self-release recheck above (v2's fix) could never
 * run either, silently reintroducing the same zero-hang violation one layer
 * up. Both of `releaseLock`'s fs calls are now individually bounded by
 * `RELEASE_DEADLINE_MS` (still never raced against `signal` — a timeout is
 * just treated the same as any other read/unlink failure: leave the lock
 * file for the next starter's own stale-lock check).
 *
 * Fence: `startFence` compares a fresh `lstat` against the identity recorded
 * at bind time; `fenceLossOf` classifies the mismatch/error into a `FenceLoss`
 * (§1.3.2) — `"io"` (timeout or an unclassified error) only fires `onLost`
 * after `ioStrikes` consecutive occurrences, everything else fires once,
 * immediately. Review fix #7 (v1): the socket-lstat and dir-lstat of a single
 * check share one `checkDeadlineMs` budget (the dir check gets whatever the
 * socket check didn't spend), not `checkDeadlineMs` each — a single slow
 * check can cost at most `checkDeadlineMs` wall-clock time in total.
 */
import { createHash } from "node:crypto";
import { chmod, lstat, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import net from "node:net";
import { dirname } from "node:path";
import {
  PrivateDirError,
  ensurePrivateDir,
  type FsDeps,
  type HubPaths,
  type PrivateDirReason,
  type SocketIdentity,
} from "../protocol/paths.js";
import { pidAlive } from "../protocol/pid.js";
import { withDeadline, withSignal } from "./lifecycle.js";

export { pidAlive } from "../protocol/pid.js";

export type SingletonResult =
  | { kind: "owner"; server: import("node:net").Server; identity: SocketIdentity; release(): Promise<void> }
  | { kind: "exists"; hubPid?: number }
  | { kind: "failed"; error: string; reason?: PrivateDirReason | "socket-verify" | "listen" | "lock" | "aborted" };

export const DEFAULT_PROBE_MS = 500;
export const DEFAULT_LOCK_STALE_MS = 10_000;
export const DEFAULT_FENCE_MS = 30_000;
/** First fence check comes early: a path removed right after startup must not leave the hub unreachable for 30s. */
export const DEFAULT_FENCE_FIRST_MS = 2_000;
/** Single fence check's *total* upper bound (§3.1; both lstat calls share this budget, review fix #7); 3 consecutive timeouts before `onLost("io")` fires. */
export const DEFAULT_FENCE_CHECK_DEADLINE_MS = 5_000;
export const DEFAULT_FENCE_IO_STRIKES = 3;
const RELEASE_DEADLINE_MS = 2_000;
/**
 * `releaseLock`'s own fs ops get a more generous deadline than `RELEASE_DEADLINE_MS` (used by
 * `closeServer`'s net-level fallback and `release()`'s socket-specific lstat/rename): those
 * lock-file reads/unlinks can legitimately contend with real disk I/O (observed under a fully
 * loaded test suite — not a hang, just slow) in a way a `net.Server.close()` callback normally
 * doesn't. Still bounded (never truly unbounded), just less trigger-happy about giving up on
 * genuinely-in-flight (not wedged) work and leaving a fresh, live-pid lock file behind for no
 * reason — which the next starter would then correctly (and safely) refuse to steal.
 */
const LOCK_RELEASE_DEADLINE_MS = 5_000;

/** fs.promises overrides for `acquireSingleton`'s lock/probe/release/guard file ops (testing only). */
type SingletonFsDeps = Partial<FsDeps> &
  Partial<Pick<typeof import("node:fs/promises"), "open" | "readFile" | "unlink" | "rename">>;

export interface SingletonDeps {
  probeMs?: number;
  lockStaleMs?: number;
  now?: () => number;
  /**
   * Instance-guard address (step ⓪). Default: `instanceGuardName(paths)` (abstract socket on
   * Linux, `undefined` elsewhere). `null` disables the guard (tests of the ①–③ fallback).
   */
  guardName?: string | null;
  /** fs.promises overrides for identity/lock/probe/release/guard file ops (testing only). */
  fs?: SingletonFsDeps | undefined;
  /** `startHub`'s `startup` scope (§3.1); a late bind self-cleans once it notices abort. */
  signal?: AbortSignal | undefined;
}

function raced<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  return signal === undefined ? p : withSignal(p, signal);
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function acquireSingleton(paths: HubPaths, deps?: SingletonDeps): Promise<SingletonResult> {
  const probeMs = deps?.probeMs ?? DEFAULT_PROBE_MS;
  const lockStaleMs = deps?.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  const now = deps?.now ?? Date.now;
  const signal = deps?.signal;

  try {
    await raced(ensurePrivateDir(paths.stateDir, paths.policies.stateDir, deps?.fs), signal);
    if (paths.socketDir !== paths.stateDir) {
      await raced(ensurePrivateDir(paths.socketDir, paths.policies.socketDir, deps?.fs), signal);
    }
  } catch (err) {
    if (aborted(signal)) return { kind: "failed", error: "start aborted", reason: "aborted" };
    return { kind: "failed", error: `state dir: ${errMsg(err)}` };
  }

  // ⓪ instance guard (held until release(); closed on every non-owner return)
  const guardName =
    deps?.guardName === undefined
      ? await instanceGuardName(paths, { signal, fs: deps?.fs })
      : (deps.guardName ?? undefined);
  let guard: net.Server | undefined;
  if (guardName !== undefined) {
    const g = await acquireGuard(guardName, probeMs, signal);
    if (g.kind === "busy") return existsResult(paths, g.holderPid, signal, deps?.fs);
    if (g.kind === "held") guard = g.server;
    // "off": no abstract namespace / foreign squatter ⇒ ①–③ only
  }
  let handedOver = false;
  try {
    const r = await acquireFileSingleton(paths, probeMs, lockStaleMs, now, guard, deps?.fs, signal);
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
  fsDeps: SingletonFsDeps | undefined,
  signal: AbortSignal | undefined,
): Promise<SingletonResult> {
  // ① start lock (kept outside the release-bearing try/finally below: an early return here
  // never actually held the lock, so it must never call releaseLock — that matters when the
  // lock file's content happens to match our own pid, e.g. tests that simulate "a live
  // starter" by writing `${process.pid} ${ts}` into the lock file).
  let lock: "ok" | "busy" | { error: string };
  try {
    lock = await tryLock(paths.startLock, now(), fsDeps, signal);
    if (lock === "busy" && (await lockIsStale(paths.startLock, lockStaleMs, now(), fsDeps, signal))) {
      await safeUnlink(paths.startLock, fsDeps, signal);
      lock = await tryLock(paths.startLock, now(), fsDeps, signal);
    }
    if (lock === "busy") {
      await raced(delay(probeMs), signal);
      if (await probeAlive(paths.socketPath, probeMs)) return await existsResult(paths, undefined, signal, fsDeps);
      lock = await tryLock(paths.startLock, now(), fsDeps, signal);
      if (lock === "busy") return { kind: "failed", error: "start lock held by a live starter" };
    }
  } catch (err) {
    if (aborted(signal)) return { kind: "failed", error: "start aborted", reason: "aborted" };
    throw err;
  }
  if (typeof lock === "object") return { kind: "failed", error: `start lock: ${lock.error}` };

  // `result` is assigned inside the try (never `return`ed directly) so the late-abort check
  // below can run *after* the release-bearing `finally` — see the file-header note on review
  // fix #2. Only a genuinely unexpected exception still `throw`s past this function.
  let result: SingletonResult;
  try {
    result = aborted(signal)
      ? { kind: "failed", error: "start aborted", reason: "aborted" }
      : await bindAndOwn(paths, probeMs, guard, fsDeps, signal); // ② bind + identity
  } catch (err) {
    if (aborted(signal)) result = { kind: "failed", error: "start aborted", reason: "aborted" };
    else throw err;
  } finally {
    // ③ release the lock — we know we hold it here (step ① above returned "ok"). Never raced
    // against `signal`: releasing a lock we hold must run to completion even after abort.
    await releaseLock(paths.startLock, fsDeps);
  }

  // Review fix #2: `releaseLock` just ran, unraced, and may have taken long enough that the
  // caller's own `withSignal` wrap around the whole `acquireSingleton(...)` call already timed
  // out and moved on. A late "owner" handed back at this point would never be `.release()`d by
  // anyone — self-release it now instead of leaking the socket/guard.
  if (result.kind === "owner" && aborted(signal)) {
    await result.release();
    return { kind: "failed", error: "start aborted", reason: "aborted" };
  }
  return result;
}

/** Step ② (§1.3.2): bind the socket (with the existing stale-socket unlink+relisten retry), then hand off to identity computation + the `owner` result. */
async function bindAndOwn(
  paths: HubPaths,
  probeMs: number,
  guard: net.Server | undefined,
  fsDeps: SingletonFsDeps | undefined,
  signal: AbortSignal | undefined,
): Promise<SingletonResult> {
  let bound = await listenOn(paths.socketPath);
  if (bound.kind === "inuse") {
    if (await probeAlive(paths.socketPath, probeMs)) return await existsResult(paths, undefined, signal, fsDeps);
    await safeUnlink(paths.socketPath, fsDeps, signal);
    bound = await listenOn(paths.socketPath);
    if (bound.kind === "inuse") return { kind: "failed", error: "socket still in use after unlink" };
  }
  if (bound.kind === "error") return { kind: "failed", error: `listen: ${bound.error}` };
  return bindIdentityAndOwn(paths, bound.server, guard, fsDeps, signal);
}

/** Identity computation + the `owner` result's `release()` closure (§1.3.2's ② continued). */
async function bindIdentityAndOwn(
  paths: HubPaths,
  server: net.Server,
  guard: net.Server | undefined,
  fsDeps: SingletonFsDeps | undefined,
  signal: AbortSignal | undefined,
): Promise<SingletonResult> {
  const chmodFn = fsDeps?.chmod ?? chmod;
  const lstatFn = fsDeps?.lstat ?? lstat;
  const renameFn = fsDeps?.rename ?? rename;
  let identity: SocketIdentity;
  try {
    await raced(chmodFn(paths.socketPath, 0o600), signal);
    const socketSt = await raced(lstatFn(paths.socketPath), signal);
    const dirSt = await raced(lstatFn(paths.socketDir), signal);
    identity = { socket: { dev: socketSt.dev, ino: socketSt.ino }, dir: { dev: dirSt.dev, ino: dirSt.ino } };
  } catch (err) {
    await closeServer(server);
    if (aborted(signal)) return { kind: "failed", error: "start aborted", reason: "aborted" };
    return { kind: "failed", error: `socket stat: ${errMsg(err)}`, reason: "socket-verify" };
  }
  if (aborted(signal)) {
    await closeServer(server); // libuv unlinks the path — it is still bound to us alone
    return { kind: "failed", error: "start aborted", reason: "aborted" };
  }
  let released = false;
  return {
    kind: "owner",
    server,
    identity,
    release: async () => {
      if (released) return;
      released = true;
      // libuv unlinks the bound path itself when the server closes (uv__pipe_close). If the
      // path now belongs to someone else (fence lost) or was replaced by a symlink, park the
      // foreign entry for the duration of the close so it survives, then put it back. Every fs
      // step is bounded by RELEASE_DEADLINE_MS (review fix #2) — a wedged disk must not hang
      // release() the way it would `closeServer`'s own 2s fallback covers the socket close.
      let ours = false;
      try {
        const st = await withDeadline(lstatFn(paths.socketPath), RELEASE_DEADLINE_MS);
        ours = !st.isSymbolicLink() && st.dev === identity.socket.dev && st.ino === identity.socket.ino;
      } catch {
        ours = false;
      }
      const parked = `${paths.socketPath}.fenced-${process.pid}`;
      let didPark = false;
      if (!ours) {
        try {
          await withDeadline(renameFn(paths.socketPath, parked), RELEASE_DEADLINE_MS);
          didPark = true;
        } catch {
          didPark = false; // nothing there (ENOENT) — close's unlink is harmless
        }
      }
      await closeServer(server);
      if (didPark) {
        try {
          await withDeadline(renameFn(parked, paths.socketPath), RELEASE_DEADLINE_MS);
        } catch {
          // best effort
        }
      }
      // ours: libuv's close already unlinked the path — never unlink again (a new owner may be there).
      // The instance guard goes last: a starter must not see it free while our path is still bound.
      if (guard !== undefined) await closeServer(guard);
    },
  };
}

// ---------------------------------------------------------------------------
// fence
// ---------------------------------------------------------------------------

export type FenceLoss =
  | "socket-missing" // lstat ENOENT
  | "socket-replaced" // socket.{dev,ino} 与 identity 不同
  | "socket-symlink" // lstat 是 symlink
  | "socket-not-socket" // lstat 存在但不是 socket
  | "dir-replaced" // 目录 {dev,ino} 与 identity.dir 不同
  | "owner-mismatch" // socket 或目录 uid 不是当前 uid
  | "io"; // 校验超时（5s）或非 PrivateDirError 的 I/O 错误；连续 3 次才触发 onLost("io")

/**
 * Map a fence-check outcome to a `FenceLoss`. `err` is the error from the
 * check (`undefined` when the check succeeded but produced a `seen` identity
 * that differs from `identity`); `seen` is the freshly observed identity.
 */
export function fenceLossOf(err: unknown, identity: SocketIdentity, seen: SocketIdentity | undefined): FenceLoss {
  if (err !== undefined && err !== null) {
    if (err instanceof PrivateDirError) {
      switch (err.reason) {
        case "not-directory":
          return "socket-not-socket";
        case "symlink":
          return "socket-symlink";
        case "owner-mismatch":
          return "owner-mismatch";
        default:
          return "io"; // "mode" | "parent-not-sticky" | "io"
      }
    }
    if (errCode(err) === "ENOENT") return "socket-missing";
    return "io"; // E_DEADLINE / EIO / EACCES / anything else non-PrivateDirError
  }
  if (seen !== undefined) {
    if (seen.socket.dev !== identity.socket.dev || seen.socket.ino !== identity.socket.ino) return "socket-replaced";
    if (seen.dir.dev !== identity.dir.dev || seen.dir.ino !== identity.dir.ino) return "dir-replaced";
  }
  return "io";
}

export function startFence(
  socketPath: string,
  identity: SocketIdentity,
  onLost: (why: FenceLoss) => void,
  intervalMs: number = DEFAULT_FENCE_MS,
  firstMs: number = Math.min(DEFAULT_FENCE_FIRST_MS, intervalMs),
  deps?: Partial<FsDeps> & { checkDeadlineMs?: number; ioStrikes?: number },
): () => void {
  const lstatFn = deps?.lstat ?? lstat;
  const checkDeadlineMs = deps?.checkDeadlineMs ?? DEFAULT_FENCE_CHECK_DEADLINE_MS;
  const ioStrikes = deps?.ioStrikes ?? DEFAULT_FENCE_IO_STRIKES;
  const dir = dirname(socketPath);
  let stopped = false;
  let inFlight = false;
  let ioStrikeCount = 0;

  function lost(why: FenceLoss): void {
    stop();
    onLost(why);
  }

  function noteIoStrike(): void {
    ioStrikeCount++;
    if (ioStrikeCount >= ioStrikes) {
      ioStrikeCount = 0;
      lost("io");
    }
  }

  async function checkAsync(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = true;
    // Review fix #7: the socket-lstat and dir-lstat share one checkDeadlineMs budget — the
    // dir check only gets whatever the socket check didn't spend, so a single check can cost
    // at most checkDeadlineMs in total, not checkDeadlineMs per lstat call.
    const deadlineAt = Date.now() + checkDeadlineMs;
    try {
      const st = await withDeadline(lstatFn(socketPath), remainingMs(deadlineAt));
      if (stopped) return;
      if (st.isSymbolicLink()) {
        ioStrikeCount = 0;
        lost("socket-symlink");
        return;
      }
      if (!st.isSocket()) {
        ioStrikeCount = 0;
        lost("socket-not-socket");
        return;
      }
      if (st.dev !== identity.socket.dev || st.ino !== identity.socket.ino) {
        ioStrikeCount = 0;
        lost("socket-replaced");
        return;
      }
      const dst = await withDeadline(lstatFn(dir), remainingMs(deadlineAt));
      if (stopped) return;
      if (dst.dev !== identity.dir.dev || dst.ino !== identity.dir.ino) {
        ioStrikeCount = 0;
        lost("dir-replaced");
        return;
      }
      ioStrikeCount = 0;
    } catch (err) {
      if (stopped) return;
      if (errCode(err) === "ENOENT") {
        ioStrikeCount = 0;
        lost("socket-missing");
        return;
      }
      noteIoStrike();
    } finally {
      inFlight = false;
    }
  }

  const check = (): void => {
    void checkAsync();
  };
  const first = setTimeout(check, firstMs);
  first.unref();
  const timer = setInterval(check, intervalMs);
  timer.unref();
  function stop(): void {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  }
  return stop;
}

function remainingMs(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

// ---------------------------------------------------------------------------
// ⓪ instance guard
// ---------------------------------------------------------------------------

/**
 * Linux abstract-namespace address for this state dir; `undefined` where
 * there is none. Review fix #3 (v2): `realpath` is `fs.promises`, raced
 * against `env.signal` (the startup scope) instead of a blocking `*Sync` call.
 */
export async function instanceGuardName(
  paths: HubPaths,
  env: {
    platform?: NodeJS.Platform;
    uid?: number;
    fs?: Partial<Pick<typeof import("node:fs/promises"), "realpath">> | undefined;
    signal?: AbortSignal | undefined;
  } = {},
): Promise<string | undefined> {
  if ((env.platform ?? process.platform) !== "linux") return undefined;
  let dir = paths.stateDir;
  try {
    const realpathFn = env.fs?.realpath ?? realpath;
    dir = await raced(realpathFn(dir), env.signal);
  } catch {
    // keep the configured spelling
  }
  const uid = env.uid ?? process.getuid?.() ?? 0;
  const h = createHash("sha256").update(dir).digest("hex").slice(0, 24);
  return `\0pi-webhub-${uid}-${h}`;
}

type GuardResult = { kind: "held"; server: net.Server } | { kind: "busy"; holderPid?: number } | { kind: "off" };

async function acquireGuard(name: string, probeMs: number, signal: AbortSignal | undefined): Promise<GuardResult> {
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
  if (answer.kind === "pid" && pidAlive(answer.pid) && (await sameUid(answer.pid, signal))) {
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

/**
 * `/proc/<pid>` owned by our uid (unreadable ⇒ trust: same-uid processes are
 * never hidden from us). Review fix #3 (v2): `fs.promises.stat`, raced
 * against the startup `signal`, instead of a blocking `statSync` call.
 */
async function sameUid(pid: number, signal: AbortSignal | undefined): Promise<boolean> {
  const uid = process.getuid?.();
  if (uid === undefined) return true;
  try {
    const st = await raced(stat(`/proc/${pid}`), signal);
    return st.uid === uid;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// helpers — lock / probe / release (review fix #5 v1 / #3 v2: fs.promises, abort-aware)
// ---------------------------------------------------------------------------

async function tryLock(
  file: string,
  ts: number,
  fsDeps: SingletonFsDeps | undefined,
  signal: AbortSignal | undefined,
): Promise<"ok" | "busy" | { error: string }> {
  const openFn = fsDeps?.open ?? open;
  let handle;
  try {
    handle = await raced(openFn(file, "wx", 0o600), signal);
  } catch (err) {
    if (aborted(signal)) throw err;
    if (errCode(err) === "EEXIST") return "busy";
    return { error: errMsg(err) };
  }
  try {
    await raced(handle.writeFile(`${process.pid} ${ts}\n`), signal);
  } catch (err) {
    if (aborted(signal)) throw err;
    // content is advisory; mtime still marks freshness
  } finally {
    await handle.close();
  }
  return "ok";
}

async function lockIsStale(
  file: string,
  staleMs: number,
  now: number,
  fsDeps: SingletonFsDeps | undefined,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const statFn = fsDeps?.stat ?? stat;
  const readFileFn = fsDeps?.readFile ?? readFile;
  let mtimeMs: number;
  let content: string;
  try {
    const st = await raced(statFn(file), signal);
    mtimeMs = st.mtimeMs;
    content = await raced(readFileFn(file, "utf8"), signal);
  } catch (err) {
    if (aborted(signal)) throw err;
    return errCode(err) === "ENOENT"; // vanished meanwhile ⇒ retry is safe
  }
  if (now - mtimeMs > staleMs) return true;
  const pid = Number.parseInt(content.trim().split(/\s+/)[0] ?? "", 10);
  if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) return true;
  return false; // empty (being written) or live holder
}

/**
 * Never raced against `signal` (releasing a lock we hold must run to completion even after
 * abort) but each fs op is bounded by its own `LOCK_RELEASE_DEADLINE_MS` deadline (`withDeadline`,
 * review fix round 3 #2) — without this, a wedged `readFile` here would hang forever and the
 * caller's `finally` (in `acquireFileSingleton`) would never complete, meaning the late-abort
 * self-release recheck that runs *after* it (review fix #2, round 2) could never run either,
 * reintroducing the zero-hang violation that fix was meant to close. A timeout is treated the
 * same as any other read/unlink failure: leave the lock file alone (the next starter's own
 * stale-lock check will reclaim it).
 */
async function releaseLock(file: string, fsDeps: SingletonFsDeps | undefined): Promise<void> {
  const readFileFn = fsDeps?.readFile ?? readFile;
  const unlinkFn = fsDeps?.unlink ?? unlink;
  try {
    const content = await withDeadline(readFileFn(file, "utf8"), LOCK_RELEASE_DEADLINE_MS);
    const pid = Number.parseInt(content.trim().split(/\s+/)[0] ?? "", 10);
    if (pid === process.pid) await withDeadline(unlinkFn(file), LOCK_RELEASE_DEADLINE_MS);
  } catch {
    // gone already, or timed out — leave it for the next starter's stale-lock check
  }
}

async function safeUnlink(
  file: string,
  fsDeps: SingletonFsDeps | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const unlinkFn = fsDeps?.unlink ?? unlink;
  try {
    await raced(unlinkFn(file), signal);
  } catch (err) {
    if (aborted(signal)) throw err;
    // ignore
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

async function existsResult(
  paths: HubPaths,
  holderPid: number | undefined,
  signal: AbortSignal | undefined,
  fsDeps?: SingletonFsDeps,
): Promise<SingletonResult> {
  const hubPid = holderPid ?? (await readHubPid(paths.hubJson, signal, fsDeps));
  return hubPid === undefined ? { kind: "exists" } : { kind: "exists", hubPid };
}

async function readHubPid(
  file: string,
  signal: AbortSignal | undefined,
  fsDeps: SingletonFsDeps | undefined,
): Promise<number | undefined> {
  const readFileFn = fsDeps?.readFile ?? readFile;
  try {
    const content = await raced(readFileFn(file, "utf8"), signal);
    const parsed = JSON.parse(content) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && pidAlive(parsed.pid)
      ? parsed.pid
      : undefined;
  } catch (err) {
    if (aborted(signal)) throw err;
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
