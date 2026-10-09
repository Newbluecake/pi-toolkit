/**
 * web-hub session-history plan §6.1 (verbatim budget table) + the v3.2/v3.3 fd-ledger
 * amendments. Every numeric constant the rest of `hub/spawn/history/**` uses lives here —
 * `HISTORY_FD_MAX`/`HISTORY_PIN_MAX`/`HISTORY_GEN_MAX` are P0-frozen in `./ports.js` (the
 * plan's §6.1 note: "budget.ts 不存在时，P0 先把这三个常量放在 ports.ts，P-scan 直接导入"), so
 * this module re-exports them rather than re-declaring.
 *
 * `createHistoryIoGate()` / `historyStep()` implement PD4's local IO admission:
 * `inflight + zombies < HISTORY_FS_SLOTS`, reusing `hub/preview/fs.ts`'s
 * `createPreviewIoTracker`/`racePreviewIo` with a history-owned tracker instance (never shared
 * with preview's).
 */
import {
  PreviewIoError,
  createPreviewIoTracker,
  isPreviewIoError,
  racePreviewIo,
  type PreviewIoTracker,
} from "../../preview/fs.js";
import { HISTORY_FD_MAX, HISTORY_GEN_MAX, HISTORY_PIN_MAX } from "./ports.js";
import type { FdKind, FdLedger } from "./fd-ledger.js";

export { HISTORY_FD_MAX, HISTORY_GEN_MAX, HISTORY_PIN_MAX };

// ---------------------------------------------------------------------------
// §6.1 budget table (verbatim)
// ---------------------------------------------------------------------------

export const HISTORY_REQ_TOTAL_MS = 3_000;

export const HISTORY_ENUM_BUDGET_MS = 1_500;
/** §4.5.3 step 4 "保证推进": at least one of a finished dir, 64 lstat'd files, or one recorded
 * error count — whichever comes first — even past budget (zombie breaker excepted). */
export const HISTORY_ENUM_MIN_FILES = 64;

export const HISTORY_DIR_LIMIT = 4_096;
export const HISTORY_FILE_LIMIT = 50_000;

export const HISTORY_GEN_REUSE_MS = 10_000;
export const HISTORY_GEN_IDLE_MS = 60_000;
export const HISTORY_GEN_MAX_AGE_MS = 300_000;

/** Consecutive-failure threshold shared by `enumRetry` (enumeration) and `ioFailures` (paging). */
export const HISTORY_IO_RETRY_MAX = 3;

/**
 * gpt-6-astra P1-a: a SEPARATE, LARGER consecutive-retry threshold for `isHistoryDeadlineLoss`
 * (a call that raced out on its own per-call budget, never a genuine I/O error) — generation.ts's
 * `deadlineRetry` map. Deliberately higher than `HISTORY_IO_RETRY_MAX`: a budget-timeout loss is
 * weaker evidence of a real problem than an actual errno (an unlucky run of tiny per-call budgets
 * under load can lose a few races against a perfectly healthy fs call), so it earns more chances
 * before giving up — but it MUST still be finite: plan §3.1 requires every enumeration blocking
 * point (dir open, dir stat/readdir, file lstat) to be dragged at most a bounded number of
 * requests before it is counted `dirsSkipped`/`filesSkipped` and the cursor advances, even for a
 * path that deterministically never finishes within budget (a truly hung mount) — otherwise the
 * generation can never reach `complete`.
 */
export const HISTORY_DEADLINE_RETRY_MAX = 6;

export const HISTORY_HEADER_LINE_MAX = 4 * 1024;
export const HISTORY_HEAD_MAX_BYTES = 256 * 1024;
export const HISTORY_HEAD_BLOCK_BYTES = 32 * 1024;
export const HISTORY_HEAD_FILE_MS = 400;

export const HISTORY_INDEX_BUDGET_MS = 1_500;
export const HISTORY_INDEX_BYTES_MAX = 64 * 1024 * 1024;

/** PD4: history's own local fs-thread admission, independent of any hub-wide pool promise. */
export const HISTORY_FS_SLOTS = 2;

export const HISTORY_CWD_STEP_MS = 200;
export const HISTORY_CWD_BUDGET_MS = 500;
export const HISTORY_CWD_CACHE_MS = 30_000;

export const PROC_SCAN_PID_MAX = 8_192;
export const PROC_SCAN_BUDGET_MS = 300;
export const PROC_SCAN_CACHE_MS = 5_000;
export const PROC_SYNC_MS = 50;
/** Finding 5 fix: per-call bound (NOT the whole-scan budget) for each of `scanAsync`'s 3
 * per-pid async calls (statUid/readStat/readCmdline) — a single hung/slow pid can no longer
 * stall past the loop's own elapsed-time check. */
export const PROC_CALL_MS = 75;

export const PIN_BUDGET_MS = 800;

export const HISTORY_SNAPSHOT_MAX_BYTES = 128 * 1024 * 1024;
export const HISTORY_SNAPSHOT_BUDGET_MS = 4_000;
export const HISTORY_SNAPSHOT_BLOCK_BYTES = 64 * 1024;

export const FORK_SRC_SWEEP_MAX = 256;
/** Finding 5 fix: per-step bound for `sweepForkSrcDir`'s per-file lstat/unlink — a hung entry
 * can no longer stall the whole best-effort startup sweep indefinitely. */
export const FORK_SRC_SWEEP_STEP_MS = 500;

export const HISTORY_INDEX_MAX = 50_000;
export const HISTORY_PAGE_BYTES_MAX = 192 * 1024;

/** v3.2 V2 / v3.3 W3: `dispose()`'s bounded wait for active leases before force-closing fds. */
export const HISTORY_DISPOSE_MS = 2_500;

/** Finding-1 fix: the bound every `boundedClose`/`boundedUnlink` races against — its OWN
 * deadline, never the caller's request deadline (a close/unlink must always be attempted, even
 * past budget, same discipline as `hub/preview/fs.ts`'s `PREVIEW_DIR_CLOSE_MS`). */
export const HISTORY_CLOSE_MS = 1_000;

// ---------------------------------------------------------------------------
// PD4 local IO gate
// ---------------------------------------------------------------------------

export class HistoryBusyError extends Error {
  constructor(message: string) {
    super(`history-io: busy: ${message}`);
    this.name = "HistoryBusyError";
  }
}

export function isHistoryBusyError(err: unknown): boolean {
  return err instanceof HistoryBusyError || (err instanceof PreviewIoError && err.ioFail === "busy");
}

/**
 * A `historyStep`/`boundedFdOpen` call that raced out on ITS OWN per-call budget (or an
 * aborted signal) before the underlying fs call settled — never evidence that the directory or
 * file is actually unreachable: `racePreviewIo`'s underlying promise is still running in the
 * background (tracked via the gate's zombie/lateFd counters) and, for a healthy path, will go
 * on to settle successfully moments later. `runAdvance` must NOT fold this into the SAME
 * `enumRetry`/HISTORY_IO_RETRY_MAX consecutive-failure counter real I/O errors use (busy
 * already gets this exact carve-out below) — doing so lets an unlucky string of tiny per-call
 * budgets (e.g. a loaded CI runner) consume an injected transient fault's own "succeeds on the
 * 3rd attempt" slot with an unrelated timeout, silently dropping a directory's files even
 * though the real open()/stat()/lstat() it raced against was never going to fail at all —
 * violating the documented "transient errors never cause skipped" invariant (session-history
 * plan §3.1 F31, generation.test.ts's scale-run property).
 */
export function isHistoryDeadlineLoss(err: unknown): boolean {
  return isPreviewIoError(err) && (err.ioFail === "deadline" || err.ioFail === "abort");
}

export interface HistoryIoGate {
  readonly tracker: PreviewIoTracker;
  readonly inflight: number;
  /** Finding-1 fix: count of `boundedFdOpen` calls whose deadline already won the race but
   * whose underlying `open()` has not yet settled+closed — observable so `dispose()` can poll
   * for drainage and tests can assert convergence back to a baseline fd count. */
  readonly lateFdCount: number;
  admit(): boolean;
}

interface GateState {
  inflight: number;
  lateFd: number;
}

/** Mutable state lives off the public object (WeakMap, same pattern as `hub/preview/fs.ts`'s
 * `trackerStates`) so `HistoryIoGate` never needs an internal/public type-cast split. */
const gateStates = new WeakMap<HistoryIoGate, GateState>();

/** Independent tracker instance — never the one `hub/preview` owns (PD4). */
export function createHistoryIoGate(max: number = HISTORY_FS_SLOTS): HistoryIoGate {
  const tracker = createPreviewIoTracker(max);
  const state: GateState = { inflight: 0, lateFd: 0 };
  const gate: HistoryIoGate = {
    tracker,
    get inflight(): number {
      return state.inflight;
    },
    get lateFdCount(): number {
      return state.lateFd;
    },
    admit(): boolean {
      return state.inflight + tracker.zombies < max;
    },
  };
  gateStates.set(gate, state);
  return gate;
}

/**
 * `historyStep(lazy, deadlineAt)`: admission-gated, deadline-raced, unref'd-timer IO step. Not
 * admitted ⇒ synchronous `HistoryBusyError` (the call is never initiated, matching PD4's "不满足
 * 准入时抛 busy"). `inflight` is held for exactly the lifetime of the race (decremented when the
 * race itself settles, whether by real completion or by timing out into a zombie — the tracker
 * then separately tracks the lingering real IO until it eventually resolves).
 */
export function historyStep<T>(
  gate: HistoryIoGate,
  lazy: () => Promise<T>,
  deadlineAt: number,
  now: () => number,
  signal?: AbortSignal,
): Promise<T> {
  const state = gateStates.get(gate);
  if (state === undefined || !gate.admit()) {
    return Promise.reject(new HistoryBusyError("inflight + zombies >= slots"));
  }
  state.inflight += 1;
  const done = (): void => {
    state.inflight = Math.max(0, state.inflight - 1);
  };
  return racePreviewIo(Promise.resolve().then(lazy), deadlineAt, signal, now, gate.tracker).then(
    (v) => {
      done();
      return v;
    },
    (err: unknown) => {
      done();
      throw err;
    },
  );
}

// ---------------------------------------------------------------------------
// Finding-1 fix: the sole fd-producing-open / bounded-close primitives
// ---------------------------------------------------------------------------

export type FdOpenResult<H> =
  | { ok: true; handle: H }
  | { ok: false; reason: "busy" }
  | { ok: false; reason: "deadline" }
  | { ok: false; reason: "error"; err: unknown };

export interface BoundedFdOpenDeps {
  gate: HistoryIoGate;
  ledger: FdLedger;
  now(): number;
}

function markLateFd(gate: HistoryIoGate): void {
  const state = gateStates.get(gate);
  if (state !== undefined) state.lateFd += 1;
}

function unmarkLateFd(gate: HistoryIoGate): void {
  const state = gateStates.get(gate);
  if (state !== undefined) state.lateFd = Math.max(0, state.lateFd - 1);
}

/**
 * The ONE fd-producing-open primitive every P-scan open() call site routes through (verifier
 * rejection #1). Reserves `n` fds of `kind` in the ledger BEFORE `openFn` is ever invoked — a
 * reservation failure (or a gate-admission failure) returns a synchronous `busy` outcome and
 * `openFn` is never called. The real open races `deadlineAt` through `historyStep` (so it
 * shares the gate's own admission + `PreviewIoTracker` zombie accounting — a late settle of the
 * underlying promise already correctly decrements that tracker on its own, see
 * `racePreviewIo`'s `settleUnderlying`). What `racePreviewIo` loses on a deadline win is the
 * VALUE itself (the open `FileHandle`) — `historyStep`'s caller never sees it. This function
 * recovers that: it creates the underlying `openFn()` promise itself (`real`, below) and
 * attaches its OWN independent `.then()` onto that exact promise instance (independent of
 * whatever `historyStep`/`racePreviewIo` separately did with it), so when/if it settles late:
 * on success, the orphaned handle is closed through `boundedClose` and the ledger reservation
 * is released exactly once (after the close settles/gives up); on failure, the reservation is
 * just released once. `gate.lateFdCount` is bumped for the duration of that outstanding
 * continuation so `dispose()` can poll for drainage and tests can assert the fd count converges
 * back to a baseline.
 */
export function boundedFdOpen<H extends { close(): Promise<void> }>(
  n: number,
  kind: FdKind,
  openFn: () => Promise<H>,
  deadlineAt: number,
  deps: BoundedFdOpenDeps,
  signal?: AbortSignal,
): Promise<FdOpenResult<H>> {
  if (!deps.ledger.reserve(n, kind)) {
    return Promise.resolve({ ok: false, reason: "busy" });
  }

  let real: Promise<H> | undefined;
  const lazy = (): Promise<H> => {
    real = Promise.resolve().then(openFn);
    return real;
  };

  const onOpened = (handle: H): FdOpenResult<H> => ({ ok: true, handle });
  const onRejected = (err: unknown): FdOpenResult<H> => {
    if (real === undefined) {
      // admission rejected synchronously (gate busy) — `lazy()` never ran, `openFn()` was
      // never called (the Finding-1 "reserve fail → open never called" contract).
      deps.ledger.release(n, kind);
      return { ok: false, reason: "busy" };
    }
    const underlying = real;
    if (isPreviewIoError(err) && (err.ioFail === "deadline" || err.ioFail === "abort")) {
      markLateFd(deps.gate);
      underlying.then(
        (handle) => {
          unmarkLateFd(deps.gate);
          void boundedClose(() => handle.close(), deps).finally(() => {
            deps.ledger.release(n, kind);
          });
        },
        () => {
          unmarkLateFd(deps.gate);
          deps.ledger.release(n, kind);
        },
      );
      return { ok: false, reason: "deadline" };
    }
    // the real open() itself rejected before the deadline/abort race decided anything.
    deps.ledger.release(n, kind);
    return { ok: false, reason: "error", err };
  };

  return historyStep(deps.gate, lazy, deadlineAt, deps.now, signal).then(onOpened, onRejected);
}

/**
 * Bounded, tracked close — mirrors `hub/preview/fs.ts`'s `boundedClose` exactly (own
 * `HISTORY_CLOSE_MS` deadline, never the caller's request deadline; no signal, a close must
 * always be attempted; swallows every outcome, timeout or rejection alike). Shared by every
 * `.close()` call site in the 14 history source files — never a bespoke
 * `.close().catch(()=>undefined)`.
 */
export function boundedClose(close: () => Promise<void>, deps: { gate: HistoryIoGate; now(): number }): Promise<void> {
  const deadlineAt = deps.now() + HISTORY_CLOSE_MS;
  return racePreviewIo(Promise.resolve().then(close), deadlineAt, undefined, deps.now, deps.gate.tracker).then(
    () => undefined,
    () => undefined,
  );
}

/** Same bound/discipline as `boundedClose`, for `fs.unlink()` call sites. */
export function boundedUnlink(
  unlink: () => Promise<void>,
  deps: { gate: HistoryIoGate; now(): number },
): Promise<void> {
  return boundedClose(unlink, deps);
}
