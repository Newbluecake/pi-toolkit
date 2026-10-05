/**
 * web-hub-spawn plan §SP6 (arch v2 §7.3/§6.5, invariant L2): the hub-side owner of the
 * independent reaper watchdog child process.
 *
 * The reaper itself is a detached `node -e "<script>"` child (script text from
 * `reaper-source.ts`'s `buildReaperSource`, the same inline-script pattern as
 * `db-client.ts:177`) in its OWN process group, so a signal aimed at the hub's group does not
 * take it down. The hub `unref()`s it. Protocol is NDJSON: `track`/`untrack` frames up,
 * `{ok:"ready"}` + diagnostics down. While the hub lives, every non-terminal spawn must be
 * tracked (L2); when the hub dies — normally or not — the stdin pipe's EOF is what arms the
 * reaper's TERM→KILL escalation (L3), which is why `close()` only ends stdin and never waits
 * for or kills the child.
 *
 * Lifecycle: `start()` waits for the `{ok:"ready"}` handshake (≤2s, capped by the caller's
 * `ReqDeadline`). An established reaper that exits unexpectedly is respawned on the
 * `[1s, 5s, 30s]` backoff ladder; the 4th failure inside a rolling 10-minute window gives up:
 * `available` flips false and `onUnavailable` fires (§6.5 — new spawns get
 * `503 E_LAUNCHER{reason:"reaper"}`). A successful respawn fires `onRestart` so the supervisor
 * can re-`track` every non-terminal record (frames written while no child was up are dropped;
 * the supervisor's store is the source of truth). A failed INITIAL `start()` simply returns
 * `false` — no background retry before the first success.
 *
 * All timers (`setTimeout`) are `unref()`'d so a pending respawn/ready-timeout can never wedge
 * a print-mode hub shutdown.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { NdjsonDecoder } from "../../protocol/ndjson.js";
import type { HubLog } from "../ports.js";
import type { ReqDeadline } from "../req-deadline.js";
import { buildReaperSource } from "./reaper-source.js";

/** arch §7.3: the reaper must report `{ok:"ready"}` within this budget after being spawned. */
export const REAPER_READY_TIMEOUT_MS = 2_000;
/** §6.5: unexpected-exit respawn backoff ladder. */
export const DEFAULT_REAPER_BACKOFF_MS: readonly [number, number, number] = [1_000, 5_000, 30_000];
/** §6.5: rolling window the restart failures are counted in. */
export const DEFAULT_REAPER_RESTART_WINDOW_MS = 10 * 60 * 1000;
/** §6.5: this many failures inside the window ⇒ permanently unavailable (fail-closed). */
export const DEFAULT_REAPER_MAX_RESTARTS_IN_WINDOW = 4;

/** One tracked spawn, as sent in the `{op:"track"}` frame (arch §7.3's wire shape). */
export interface ReaperTrackRecord {
  spawnId: string;
  pid: number;
  startTicks: number;
  bootId: string;
  uid: number;
}

export interface ReaperDeps {
  log: HubLog;
  now?: () => number;
  /** Injectable for tests; defaults to `node:child_process`'s `spawn`. */
  spawnFn?: typeof spawn;
  /** Injectable for tests; defaults to `buildReaperSource()` (real arch §7.3 timings). */
  script?: string;
  readyTimeoutMs?: number;
  backoffMs?: readonly number[];
  restartWindowMs?: number;
  maxRestartsInWindow?: number;
}

export interface Reaper {
  /**
   * Spawn the child and await the ready handshake, bounded by
   * `min(readyTimeoutMs, deadline.remaining())`. `true` ⇒ reaper is live (`available` flips
   * true); `false` ⇒ no watchdog (spawn spawn must be refused, §6.5) — no background retry
   * happens before the first success. Resolves `false` immediately once closed.
   */
  start(deadline: ReqDeadline): Promise<boolean>;
  /** Fire-and-forget `{op:"track"}`; dropped when no live child (a respawn re-tracks via `onRestart`). */
  track(rec: ReaperTrackRecord): void;
  /** Fire-and-forget `{op:"untrack"}`; dropped when no live child. */
  untrack(pid: number): void;
  /**
   * `stdin.end()` only — never waits, never kills: the EOF is exactly what arms the reaper's
   * TERM→KILL escalation for everything still tracked (arch §7.3). Idempotent; also cancels a
   * pending respawn.
   */
  close(): void;
  /** False before the first successful `start()`, and permanently false after give-up. */
  readonly available: boolean;
  /** Fires at most once, when the restart budget is exhausted. Returns an unsubscribe fn. */
  onUnavailable(cb: () => void): () => void;
  /** Fires each time a respawned reaper completes its ready handshake. Returns an unsubscribe fn. */
  onRestart(cb: () => void): () => void;
}

/** `as`-free structural shim: a pipe that happens to carry `unref` (the runtime net.Socket)
 *  gets unref'd; the plain-stream ChildProcess typing is silent about it — exactly what we want
 *  (weak-typing rules forbid passing a `Writable` where `{unref?}` is declared, so narrow at
 *  runtime instead). */
function unrefQuietly(s: unknown): void {
  if (typeof s === "object" && s !== null && "unref" in s && typeof s.unref === "function") s.unref();
}

/** The ready-handshake frame, narrowed without a cast (`hub/spawn/**` zero-`as` contract). */
function isReadyFrame(v: unknown): boolean {
  return typeof v === "object" && v !== null && "ok" in v && v.ok === "ready";
}

export function createReaper(deps: ReaperDeps): Reaper {
  const log = deps.log;
  const now = deps.now ?? Date.now;
  const spawnFn = deps.spawnFn ?? spawn;
  const script = deps.script ?? buildReaperSource();
  const readyTimeoutMs = deps.readyTimeoutMs ?? REAPER_READY_TIMEOUT_MS;
  const backoffMs = deps.backoffMs ?? DEFAULT_REAPER_BACKOFF_MS;
  const restartWindowMs = deps.restartWindowMs ?? DEFAULT_REAPER_RESTART_WINDOW_MS;
  const maxRestarts = deps.maxRestartsInWindow ?? DEFAULT_REAPER_MAX_RESTARTS_IN_WINDOW;

  let child: ChildProcess | undefined;
  let closed = false;
  let available = false;
  let everStarted = false;
  let respawnTimer: ReturnType<typeof setTimeout> | undefined;
  const failureTimestamps: number[] = [];
  const unavailableListeners = new Set<() => void>();
  const restartListeners = new Set<() => void>();

  function writeFrame(frame: Record<string, unknown>): void {
    const c = child;
    if (c === undefined || c.stdin === null || c.stdin.destroyed) return;
    try {
      c.stdin.write(`${JSON.stringify(frame)}\n`);
    } catch (err) {
      log.warn("web-hub spawn reaper: stdin write failed", { error: String(err) });
    }
  }

  function fireRestart(): void {
    for (const cb of restartListeners) {
      try {
        cb();
      } catch (err) {
        log.error("web-hub spawn reaper: onRestart listener threw", { error: String(err) });
      }
    }
  }

  function giveUp(): void {
    if (!available) return;
    available = false;
    for (const cb of unavailableListeners) {
      try {
        cb();
      } catch (err) {
        log.error("web-hub spawn reaper: onUnavailable listener threw", { error: String(err) });
      }
    }
  }

  function noteFailureAndSchedule(): void {
    if (closed || !available) return;
    const t = now();
    while (failureTimestamps.length > 0 && t - failureTimestamps[0]! >= restartWindowMs) {
      failureTimestamps.shift();
    }
    failureTimestamps.push(t);
    if (failureTimestamps.length >= maxRestarts) {
      log.error("web-hub spawn reaper: giving up after repeated failures", {
        failures: failureTimestamps.length,
        windowMs: restartWindowMs,
      });
      giveUp();
      return;
    }
    const idx = Math.min(failureTimestamps.length - 1, backoffMs.length - 1);
    const delay = backoffMs[idx]!;
    log.warn("web-hub spawn reaper: scheduling respawn", { delayMs: delay, failures: failureTimestamps.length });
    respawnTimer = setTimeout(() => {
      respawnTimer = undefined;
      respawn();
    }, delay);
    respawnTimer.unref?.();
  }

  function respawn(): void {
    if (closed || !available) return;
    spawnChild((ok) => {
      // A respawn that never becomes ready is itself a restart failure (counted above); an
      // established-then-lost child is counted by its own 'exit' handler instead — the two
      // paths never double-count because `readyOk` separates them.
      if (!ok) {
        noteFailureAndSchedule();
        return;
      }
      log.info("web-hub spawn reaper: respawned");
      fireRestart();
    }, readyTimeoutMs);
  }

  function killChild(c: ChildProcess): void {
    try {
      c.kill("SIGKILL");
    } catch {
      // already gone
    }
  }

  /**
   * Spawn one child and wire it. `onReady(ok)` settles exactly once (ready frame / timeout /
   * early exit / spawn error). A child that exits AFTER a successful handshake is an
   * unexpected-exit failure and schedules the backoff respawn itself.
   */
  function spawnChild(onReady: (ok: boolean) => void, timeoutMs: number): void {
    let c: ChildProcess;
    try {
      c = spawnFn(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", script], {
        detached: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch (err) {
      log.error("web-hub spawn reaper: spawn failed", { error: String(err) });
      onReady(false);
      return;
    }
    child = c;
    c.unref();
    // Pipes are net.Socket instances at runtime (they carry unref); the ChildProcess typings
    // expose them as plain streams, so go through a narrow structural view.
    unrefQuietly(c.stdin);
    unrefQuietly(c.stdout);

    let readySettled = false;
    let readyOk = false;
    const readyTimer = setTimeout(() => {
      if (readySettled) return;
      readySettled = true;
      log.error("web-hub spawn reaper: ready handshake timed out", { timeoutMs });
      killChild(c);
      onReady(false);
    }, timeoutMs);
    readyTimer.unref?.();

    function settleReady(ok: boolean): void {
      if (readySettled) return;
      readySettled = true;
      readyOk = ok;
      clearTimeout(readyTimer);
      if (!ok) killChild(c);
      onReady(ok);
    }

    const dec = new NdjsonDecoder({
      maxFrameBytes: 64 * 1024,
      onFrame: (value) => {
        if (!readySettled) {
          if (isReadyFrame(value)) {
            settleReady(true);
          } else {
            log.warn("web-hub spawn reaper: unexpected first frame", { frame: value });
            settleReady(false);
          }
          return;
        }
        log.info("web-hub spawn reaper: diag", { frame: value });
      },
      onError: (err) => log.warn("web-hub spawn reaper: bad frame from child", { error: err.code }),
    });
    c.stdout?.on("data", (chunk: Buffer) => dec.push(chunk));
    c.stdin?.on("error", () => {});
    c.stdout?.on("error", () => {});
    c.on("error", (err) => {
      log.error("web-hub spawn reaper: child error", { error: String(err) });
      settleReady(false);
    });
    c.on("exit", (code, signal) => {
      log.info("web-hub spawn reaper: child exited", { code, signal, ready: readyOk });
      const wasReady = readyOk;
      settleReady(false);
      if (child === c) child = undefined;
      if (closed || !everStarted || !wasReady) return;
      noteFailureAndSchedule();
    });
  }

  return {
    start(deadline: ReqDeadline): Promise<boolean> {
      if (closed) return Promise.resolve(false);
      if (deadline.remaining() <= 0) {
        log.error("web-hub spawn reaper: start called with an exhausted deadline");
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolve) => {
        // arch §7.3's handshake budget, further capped by the caller's remaining deadline
        // (the remaining≤0 pre-reject above guarantees budget > 0 at this point).
        const budget = Math.min(readyTimeoutMs, Math.max(0, deadline.remaining()));
        spawnChild((ok) => {
          if (closed) {
            resolve(false);
            return;
          }
          if (ok) {
            everStarted = true;
            available = true;
            log.info("web-hub spawn reaper: ready");
          }
          resolve(ok);
        }, budget);
      });
    },
    track(rec: ReaperTrackRecord): void {
      writeFrame({
        op: "track",
        spawnId: rec.spawnId,
        pid: rec.pid,
        startTicks: rec.startTicks,
        bootId: rec.bootId,
        uid: rec.uid,
      });
    },
    untrack(pid: number): void {
      writeFrame({ op: "untrack", pid });
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (respawnTimer !== undefined) {
        clearTimeout(respawnTimer);
        respawnTimer = undefined;
      }
      const c = child;
      child = undefined;
      if (c !== undefined && c.stdin !== null && !c.stdin.destroyed) {
        try {
          c.stdin.end();
        } catch {
          // pipe already broken — the reaper sees EOF either way
        }
      }
    },
    get available(): boolean {
      return available;
    },
    onUnavailable(cb: () => void): () => void {
      unavailableListeners.add(cb);
      return () => unavailableListeners.delete(cb);
    },
    onRestart(cb: () => void): () => void {
      restartListeners.add(cb);
      return () => restartListeners.delete(cb);
    },
  };
}
