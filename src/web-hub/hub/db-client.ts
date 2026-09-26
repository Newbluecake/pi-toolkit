/**
 * Dual-channel IPC client for the resident query subprocess (plan §4.2): an
 * *interactive* channel (64 in-flight + 128 queued, admission-gated) and a
 * *reserved* channel (concurrency 1, used only by `lan-store.ts`'s low-priority
 * callers — the SSE 55s expiry-recheck tick and `purgeExpired` — never
 * contending with interactive traffic). Also owns the resident subprocess's
 * lifecycle: spawn, NDJSON framing (reusing `protocol/ndjson.ts`'s decoder so
 * the 64 KiB single-line cap and framing rules match the agent↔hub channel),
 * a 2s per-request deadline that SIGKILLs the child and fails every in-flight
 * request with `E_DB` on expiry, and exit-driven restart with 1s→5s→30s
 * backoff (a crash rejects every in-flight *and* still-queued request
 * immediately with `E_DB` — nothing rides out to the next child, so a
 * restart is fail-closed rather than a delayed success) — the 4th failure
 * inside a rolling 10-minute window gives up and reports `db-unavailable`
 * instead of respawning again (fail-closed).
 *
 * This module never imports `node:sqlite` — it only ever talks to the
 * subprocess whose script text `db-child.ts` builds.
 */
import { type ChildProcessWithoutNullStreams, spawn as defaultSpawn } from "node:child_process";
import { encodeFrame, NdjsonDecoder } from "../protocol/ndjson.js";
import { buildQueryScript } from "./db-child.js";
import type { HubLog } from "./ports.js";

export const MAX_LINE_BYTES = 64 * 1024;
export const DEFAULT_INTERACTIVE_SLOTS = 64;
export const DEFAULT_QUEUE_SLOTS = 128;
export const DEFAULT_DEADLINE_MS = 2_000;
export const DEFAULT_DEDUP_MAX_WAITERS = 8;
export const DEFAULT_BACKOFF_MS = [1_000, 5_000, 30_000];
export const DEFAULT_RESTART_WINDOW_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_RESTARTS_IN_WINDOW = 4;

export type DbClientErrorCode = "E_BUSY" | "E_DB" | "E_RATE";

export class DbClientError extends Error {
  readonly code: DbClientErrorCode;
  constructor(code: DbClientErrorCode, message: string) {
    super(message);
    this.name = "DbClientError";
    this.code = code;
  }
}

export interface DbCallOptions {
  signal?: AbortSignal;
  /** Routes through the concurrency-1 reserved channel instead of the interactive
   * one (§4.2's tick/`purgeExpired` carve-out). Never counted against the 64
   * interactive slots or the 128 queue slots. */
  reserved?: boolean;
  /** Concurrent calls sharing the same key fan out to one in-flight IPC request
   * (§4.2 "同 sid 去重"); the (cap+1)th distinct waiter is rejected immediately
   * with `E_RATE` instead of being admitted. */
  dedupKey?: string;
}

export interface DbClientDeps {
  dbFile: string;
  log: HubLog;
  now?: () => number;
  interactiveSlots?: number;
  queueSlots?: number;
  deadlineMs?: number;
  dedupMaxWaiters?: number;
  backoffMs?: number[];
  restartWindowMs?: number;
  maxRestartsInWindow?: number;
  /** Forces script test-hook compilation regardless of `process.env.PI_WEBHUB_DB_TEST`
   * — test convenience, never read by production code paths. */
  test?: boolean;
  /** Injectable for tests; defaults to `node:child_process`'s `spawn`. */
  spawnFn?: typeof defaultSpawn;
}

export interface DbClient {
  call<T = unknown>(op: string, args: Record<string, unknown>, opts?: DbCallOptions): Promise<T>;
  /** Fires (at most once) when the client gives up permanently after the 4th
   * restart failure inside the rolling window. Returns an unsubscribe fn. */
  onUnavailable(cb: (reason: "db-unavailable") => void): () => void;
  /** True once `onUnavailable` has fired. */
  readonly unavailable: boolean;
  /** Kills the current child (if any), cancels the pending respawn timer, and
   * rejects everything outstanding. Idempotent. */
  close(): Promise<void>;
}

interface PendingCall {
  id: number;
  op: string;
  args: Record<string, unknown>;
  resolve(v: unknown): void;
  reject(err: Error): void;
  reserved: boolean;
  dispatched: boolean;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

interface DedupEntry {
  waiters: Array<{ resolve(v: unknown): void; reject(err: Error): void }>;
}

export function createDbClient(deps: DbClientDeps): DbClient {
  const log = deps.log;
  const now = deps.now ?? Date.now;
  const interactiveSlots = deps.interactiveSlots ?? DEFAULT_INTERACTIVE_SLOTS;
  const queueSlots = deps.queueSlots ?? DEFAULT_QUEUE_SLOTS;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const dedupMaxWaiters = deps.dedupMaxWaiters ?? DEFAULT_DEDUP_MAX_WAITERS;
  const backoffMs = deps.backoffMs ?? DEFAULT_BACKOFF_MS;
  const restartWindowMs = deps.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
  const maxRestartsInWindow = deps.maxRestartsInWindow ?? DEFAULT_MAX_RESTARTS_IN_WINDOW;
  const spawnFn = deps.spawnFn ?? defaultSpawn;

  let child: ChildProcessWithoutNullStreams | undefined;
  let nextId = 1;
  let closed = false;
  let unavailable = false;
  let respawnTimer: ReturnType<typeof setTimeout> | undefined;
  const restartFailureTimestamps: number[] = [];
  const unavailableListeners = new Set<(reason: "db-unavailable") => void>();

  const interactiveQueue: PendingCall[] = [];
  const reservedQueue: PendingCall[] = [];
  const dispatched = new Map<number, PendingCall>();
  const dedup = new Map<string, DedupEntry>();
  let interactiveInFlight = 0;
  let reservedInFlight = 0;

  function notifyUnavailable(): void {
    if (unavailable) return;
    unavailable = true;
    for (const cb of unavailableListeners) {
      try {
        cb("db-unavailable");
      } catch (err) {
        log.error("web-hub db-client: onUnavailable listener threw", { error: String(err) });
      }
    }
  }

  function scheduleRespawn(delayMs: number): void {
    if (closed || unavailable) return;
    respawnTimer = setTimeout(() => {
      respawnTimer = undefined;
      spawnChild();
    }, delayMs);
    respawnTimer.unref?.();
  }

  function onChildDown(): void {
    child = undefined;
    // §4.2: subprocess exit ⇒ reject every in-flight AND queued request immediately.
    // A queued-but-never-dispatched call must not be left to ride out on the next
    // (respawned) child: that would let a request submitted before the crash silently
    // execute against a fresh process minutes later, once backoff finishes — exactly the
    // "hang / execute across a restart" the plan forbids ("重启期间 LAN 请求一律 503，
    // 从不挂起"). Restart is fail-closed: every caller gets E_DB now, and any later admit
    // starts a clean queue against whichever child eventually comes up.
    const err = new DbClientError("E_DB", "web-hub db: query subprocess exited");
    for (const [, pc] of dispatched) {
      settleReject(pc, err);
    }
    dispatched.clear();
    for (const pc of interactiveQueue.splice(0)) {
      settleReject(pc, err);
    }
    for (const pc of reservedQueue.splice(0)) {
      settleReject(pc, err);
    }
    interactiveInFlight = 0;
    reservedInFlight = 0;

    if (closed) return;
    const t = now();
    while (restartFailureTimestamps.length > 0 && t - restartFailureTimestamps[0]! >= restartWindowMs) {
      restartFailureTimestamps.shift();
    }
    restartFailureTimestamps.push(t);
    if (restartFailureTimestamps.length >= maxRestartsInWindow) {
      log.error("web-hub db-client: giving up after repeated crashes", {
        failures: restartFailureTimestamps.length,
        windowMs: restartWindowMs,
      });
      notifyUnavailable();
      return;
    }
    const idx = Math.min(restartFailureTimestamps.length - 1, backoffMs.length - 1);
    scheduleRespawn(backoffMs[idx]!);
  }

  function spawnChild(): void {
    if (closed || unavailable) return;
    const script = buildQueryScript(deps.test === undefined ? {} : { test: deps.test });
    const c = spawnFn(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", script], {
      env: { ...process.env, PI_WEBHUB_DB_PATH: deps.dbFile },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = c;
    const dec = new NdjsonDecoder({
      maxFrameBytes: MAX_LINE_BYTES,
      onFrame: (value) => onFrame(value),
      onError: (err) => log.warn("web-hub db-client: bad frame from query subprocess", { error: err }),
    });
    c.stdout.on("data", (chunk: Buffer) => dec.push(chunk));
    c.stderr.on("data", (chunk: Buffer) => {
      if (deps.test) log.info("web-hub db-client: query subprocess stderr", { line: chunk.toString("utf8").trimEnd() });
    });
    c.on("error", (err) => log.error("web-hub db-client: spawn error", { error: String(err) }));
    c.on("exit", (code, signal) => {
      log.info("web-hub db-client: query subprocess exited", { code, signal });
      onChildDown();
    });
    c.stdin.on("error", () => {});
    c.stdout.on("error", () => {});
    // A freshly (re)spawned child may have room; drain whatever is queued.
    pump();
  }

  function onFrame(value: unknown): void {
    const frame = value as { id?: unknown; ok?: unknown; result?: unknown; code?: unknown; detail?: unknown };
    if (typeof frame.id !== "number") return;
    const pc = dispatched.get(frame.id);
    if (pc === undefined) return; // late reply for an already-settled/reaped call
    dispatched.delete(frame.id);
    if (pc.reserved) reservedInFlight--;
    else interactiveInFlight--;
    if (frame.ok === true) {
      settleResolve(pc, frame.result);
    } else {
      const code: DbClientErrorCode = frame.code === "E_RATE" || frame.code === "E_BUSY" ? frame.code : "E_DB";
      settleReject(
        pc,
        new DbClientError(code, typeof frame.detail === "string" ? frame.detail : "web-hub db: op failed"),
      );
    }
    pump();
  }

  function pump(): void {
    if (child === undefined) return;
    while (reservedInFlight === 0 && reservedQueue.length > 0) {
      const pc = reservedQueue.shift()!;
      dispatch(pc);
    }
    while (interactiveInFlight < interactiveSlots && interactiveQueue.length > 0) {
      const pc = interactiveQueue.shift()!;
      dispatch(pc);
    }
  }

  function dispatch(pc: PendingCall): void {
    if (child === undefined) {
      // Shouldn't happen (pump() only runs with a live child), but stay safe.
      (pc.reserved ? reservedQueue : interactiveQueue).push(pc);
      return;
    }
    pc.dispatched = true;
    dispatched.set(pc.id, pc);
    if (pc.reserved) reservedInFlight++;
    else interactiveInFlight++;
    const line = encodeFrame({ id: pc.id, op: pc.op, args: pc.args });
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      dispatched.delete(pc.id);
      if (pc.reserved) reservedInFlight--;
      else interactiveInFlight--;
      settleReject(pc, new DbClientError("E_DB", "web-hub db: request too large"));
      return;
    }
    child.stdin.write(line);
  }

  function clearPendingTimer(pc: PendingCall): void {
    clearTimeout(pc.timer);
    if (pc.signal !== undefined && pc.onAbort !== undefined) {
      pc.signal.removeEventListener("abort", pc.onAbort);
    }
  }

  function settleResolve(pc: PendingCall, value: unknown): void {
    clearPendingTimer(pc);
    pc.resolve(value);
  }

  function settleReject(pc: PendingCall, err: Error): void {
    clearPendingTimer(pc);
    pc.reject(err);
  }

  function removeFromQueue(queue: PendingCall[], pc: PendingCall): boolean {
    const idx = queue.indexOf(pc);
    if (idx === -1) return false;
    queue.splice(idx, 1);
    return true;
  }

  function onDeadline(pc: PendingCall): void {
    if (dispatched.has(pc.id)) {
      // In-flight timeout: the subprocess looks stuck. §4.2: SIGKILL it and fail
      // every currently in-flight request with E_DB (queued-but-undispatched
      // calls are untouched — they ride out on the next child).
      log.warn("web-hub db-client: query op deadline exceeded, killing subprocess", { op: pc.op });
      const dying = child;
      child = undefined;
      if (dying !== undefined) {
        dying.removeAllListeners("exit");
        dying.kill("SIGKILL");
      }
      for (const [, p] of dispatched) {
        settleReject(p, new DbClientError("E_DB", "web-hub db: query subprocess deadline exceeded"));
      }
      dispatched.clear();
      interactiveInFlight = 0;
      reservedInFlight = 0;
      onChildDown();
      return;
    }
    // Still queued after its full budget: overloaded, not stuck.
    if (removeFromQueue(interactiveQueue, pc) || removeFromQueue(reservedQueue, pc)) {
      settleReject(pc, new DbClientError("E_BUSY", "web-hub db: queue deadline exceeded"));
    }
  }

  function admit(op: string, args: Record<string, unknown>, opts: DbCallOptions | undefined): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (opts?.signal?.aborted === true) {
        reject(toAbortError(opts.signal));
        return;
      }
      if (unavailable) {
        reject(new DbClientError("E_DB", "web-hub db: unavailable"));
        return;
      }
      const reserved = opts?.reserved === true;
      const id = nextId++;
      const timer = setTimeout(() => onDeadline(pc), deadlineMs);
      timer.unref?.();
      const pc: PendingCall = { id, op, args, resolve, reject, reserved, dispatched: false, timer };
      if (opts?.signal !== undefined) {
        pc.signal = opts.signal;
        pc.onAbort = () => {
          if (pc.dispatched) return; // can't cancel an in-flight IPC; the reply is just discarded
          if (removeFromQueue(interactiveQueue, pc) || removeFromQueue(reservedQueue, pc)) {
            clearTimeout(pc.timer);
            reject(toAbortError(opts.signal));
          }
        };
        opts.signal.addEventListener("abort", pc.onAbort, { once: true });
      }
      const queue = reserved ? reservedQueue : interactiveQueue;
      if (!reserved && interactiveInFlight >= interactiveSlots && queue.length >= queueSlots) {
        clearTimeout(pc.timer);
        reject(new DbClientError("E_BUSY", "web-hub db: admission queue full"));
        return;
      }
      queue.push(pc);
      pump();
    });
  }

  async function call<T>(op: string, args: Record<string, unknown>, opts?: DbCallOptions): Promise<T> {
    const dedupKey = opts?.dedupKey;
    if (dedupKey === undefined) {
      return admit(op, args, opts) as Promise<T>;
    }
    const existing = dedup.get(dedupKey);
    if (existing === undefined) {
      const entry: DedupEntry = { waiters: [] };
      dedup.set(dedupKey, entry);
      const p = admit(op, args, opts).finally(() => dedup.delete(dedupKey));
      p.then(
        (v) => {
          for (const w of entry.waiters) w.resolve(v);
        },
        (err: Error) => {
          for (const w of entry.waiters) w.reject(err);
        },
      );
      return p as Promise<T>;
    }
    if (existing.waiters.length >= dedupMaxWaiters - 1) {
      throw new DbClientError("E_RATE", "web-hub db: too many callers waiting on the same key");
    }
    return new Promise<T>((resolve, reject) => {
      existing.waiters.push({ resolve: resolve as (v: unknown) => void, reject });
      if (opts?.signal !== undefined) {
        opts.signal.addEventListener(
          "abort",
          () => {
            const idx = existing.waiters.findIndex((w) => w.resolve === (resolve as (v: unknown) => void));
            if (idx !== -1) existing.waiters.splice(idx, 1);
            reject(toAbortError(opts.signal));
          },
          { once: true },
        );
      }
    });
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    if (respawnTimer !== undefined) {
      clearTimeout(respawnTimer);
      respawnTimer = undefined;
    }
    const err = new DbClientError("E_DB", "web-hub db: client closed");
    for (const [, pc] of dispatched) settleReject(pc, err);
    dispatched.clear();
    for (const pc of interactiveQueue.splice(0)) settleReject(pc, err);
    for (const pc of reservedQueue.splice(0)) settleReject(pc, err);
    const c = child;
    child = undefined;
    if (c !== undefined) {
      c.removeAllListeners("exit");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1_000);
        t.unref?.();
        c.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
        c.kill("SIGKILL");
      });
    }
  }

  // §4.2: the query subprocess is resident — spawn it eagerly rather than
  // waiting for the first call, so `onUnavailable`/crash-loop detection is
  // live from the moment the store exists, not just from first use.
  spawnChild();

  return {
    call,
    onUnavailable(cb) {
      unavailableListeners.add(cb);
      return () => unavailableListeners.delete(cb);
    },
    get unavailable() {
      return unavailable;
    },
    close,
  };
}

function toAbortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" ? reason : "web-hub db: aborted");
}
