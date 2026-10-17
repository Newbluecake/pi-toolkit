/**
 * web-hub HTML preview — the `/pv` physical-IO quota (plan v2 §2.5, P1a).
 *
 * A semaphore of `PV_IO_SLOTS` OUTSTANDING real fs operations (readlink/realpath/stat/open/
 * fstat/read/close). A slot is released only when the underlying operation actually SETTLES: the
 * caller's race (`racePreviewIo`, unref'd timer, per-op `PV_IO_OP_TIMEOUT_MS` capped by the
 * request deadline) may give up earlier, but the slot stays held — a zombie — until settle, so
 * a wedged fs can never occupy more than `PV_IO_SLOTS` libuv threads. Waiters are FIFO, bounded
 * by the caller's deadline/signal (`PreviewIoError("busy")` ⇒ 503, `"abort"` ⇒ silent). Own
 * instance per routes closure; never shared with preview/history.
 *
 * Handles produced by a raced-out `open` are closed on settle (`lateFds`); closes are
 * PRIORITY work (they jump the waiter queue and are never dropped for deadline reasons — a
 * leaked fd is worse than a late close): the caller waits at most `opTimeoutMs`, the close
 * itself still runs as soon as a slot frees. A close that never completes keeps its slot
 * forever ⇒ `/pv` degrades to busy while the rest of the hub keeps its libuv threads.
 * All timers are unref'd. Pure of node:fs (the ops are injected closures).
 */

import { PV_IO_OP_TIMEOUT_MS, PV_IO_SLOTS } from "../../protocol/preview-html.js";
import { PreviewIoError, racePreviewIo } from "./fs.js";

export interface PvStepOpts {
  /** absolute wall-clock deadline (same clock as the gate's `now`). */
  readonly deadlineAt: number;
  readonly signal?: AbortSignal | undefined;
}

export interface PvIoGate {
  readonly slots: number;
  /** operations currently holding a slot (including zombies whose race already gave up). */
  readonly inflight: number;
  /** callers waiting for a slot (non-close). */
  readonly waiting: number;
  /** raced-out opens whose handle has not yet been closed. */
  readonly lateFds: number;
  /** One fs operation. Rejects `PreviewIoError` `busy` (no slot before the deadline),
   * `deadline` (per-op cap/deadline raced out; the slot stays held until settle) or `abort`. */
  run<T>(op: () => Promise<T>, o: PvStepOpts): Promise<T>;
  /** `run` for a handle-producing op: a handle that arrives AFTER the race gave up is closed. */
  open<H extends { close(): Promise<void> }>(op: () => Promise<H>, o: PvStepOpts): Promise<H>;
  /** Bounded, never-rejecting close (see module header). */
  close(op: () => Promise<void>): Promise<void>;
  /** Reject every waiter (`abort`) and refuse new `run`/`open`; closes keep working. */
  dispose(): void;
}

export interface PvIoGateOpts {
  slots?: number;
  opTimeoutMs?: number;
  now?: () => number;
}

interface Waiter {
  grant(): void;
  fail(err: PreviewIoError): void;
  readonly priority: boolean;
}

export function createPvIoGate(opts: PvIoGateOpts = {}): PvIoGate {
  const slots = Math.max(1, opts.slots ?? PV_IO_SLOTS);
  const opTimeoutMs = opts.opTimeoutMs ?? PV_IO_OP_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  let inflight = 0;
  let lateFds = 0;
  let disposed = false;
  const waiters: Waiter[] = [];

  const pump = (): void => {
    while (inflight < slots && waiters.length > 0) {
      const w = waiters.shift() as Waiter;
      inflight += 1;
      w.grant();
    }
  };
  const release = (): void => {
    inflight -= 1;
    pump();
  };

  /** Resolves once a slot is held; rejects `busy`/`abort` (never for priority waiters). */
  const acquire = (
    deadlineAt: number | undefined,
    signal: AbortSignal | undefined,
    priority: boolean,
  ): Promise<void> => {
    if (signal?.aborted) return Promise.reject(new PreviewIoError("abort", "aborted before slot"));
    if (inflight < slots && waiters.length === 0) {
      inflight += 1;
      return Promise.resolve();
    }
    if (deadlineAt !== undefined && deadlineAt - now() <= 0) {
      return Promise.reject(new PreviewIoError("busy", "no pv io slot before deadline"));
    }
    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      };
      const w: Waiter = {
        priority,
        grant: () => {
          cleanup();
          resolve();
        },
        fail: (err) => {
          cleanup();
          reject(err);
        },
      };
      const drop = (err: PreviewIoError): void => {
        const i = waiters.indexOf(w);
        if (i !== -1) {
          waiters.splice(i, 1);
          w.fail(err);
        }
      };
      if (deadlineAt !== undefined) {
        timer = setTimeout(
          () => drop(new PreviewIoError("busy", "no pv io slot before deadline")),
          Math.max(0, deadlineAt - now()),
        );
        timer.unref();
      }
      if (signal !== undefined) {
        onAbort = () => drop(new PreviewIoError("abort", "aborted while waiting for pv io slot"));
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (priority) {
        let i = 0;
        while (i < waiters.length && (waiters[i] as Waiter).priority) i += 1;
        waiters.splice(i, 0, w);
      } else {
        waiters.push(w);
      }
    });
  };

  /** Start `op` under an already-held slot; the slot is released when `op` REALLY settles. */
  const start = <T>(op: () => Promise<T>): Promise<T> => {
    const real = Promise.resolve().then(op);
    real.then(release, release);
    return real;
  };

  const runInternal = async <T>(
    op: () => Promise<T>,
    o: PvStepOpts,
    onRacedOut?: (real: Promise<T>) => void,
  ): Promise<T> => {
    if (disposed) throw new PreviewIoError("abort", "pv io gate disposed");
    await acquire(o.deadlineAt, o.signal, false);
    // slot held: from here the slot is only ever returned by the op's real settle
    const t = now();
    if (o.signal?.aborted || o.deadlineAt - t <= 0) {
      release();
      throw new PreviewIoError(o.signal?.aborted ? "abort" : "deadline", "budget exhausted after slot grant");
    }
    const real = start(op);
    try {
      return await racePreviewIo(real, Math.min(t + opTimeoutMs, o.deadlineAt), o.signal, now);
    } catch (err) {
      if (err instanceof PreviewIoError && onRacedOut !== undefined) onRacedOut(real);
      throw err;
    }
  };

  const gate: PvIoGate = {
    slots,
    get inflight() {
      return inflight;
    },
    get waiting() {
      return waiters.filter((w) => !w.priority).length;
    },
    get lateFds() {
      return lateFds;
    },
    run: (op, o) => runInternal(op, o),
    open: (op, o) =>
      runInternal(op, o, (real) => {
        lateFds += 1;
        real.then(
          (h) => {
            lateFds -= 1;
            void gate.close(() => h.close());
          },
          () => {
            lateFds -= 1;
          },
        );
      }),
    close: (op) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, opTimeoutMs);
        timer.unref();
        const done = (): void => {
          clearTimeout(timer);
          resolve();
        };
        acquire(undefined, undefined, true).then(() => {
          const real = start(op);
          real.then(done, done);
        }, done);
      }),
    dispose: () => {
      disposed = true;
      for (const w of [...waiters]) {
        if (w.priority) continue;
        waiters.splice(waiters.indexOf(w), 1);
        w.fail(new PreviewIoError("abort", "pv io gate disposed"));
      }
    },
  };
  return gate;
}
