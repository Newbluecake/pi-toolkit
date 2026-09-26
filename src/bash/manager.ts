import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import type { Clock, TimerHandle } from "../core/clock.js";
import type { Millis } from "../core/types.js";
import {
  applyJobExtension,
  createJobDeadline,
  DEFAULT_JOB_DEADLINE_POLICY,
  jobGraceWindow,
  resumeDeadline,
  type JobExtensionReason,
} from "./deadline.js";
import { newJobId } from "./ids.js";
import type { JobStore } from "./job-store.js";
import type { JobExit, KillOutcome, ProcessPort, SpawnedJob } from "./process.js";
import {
  createJobRecord,
  formatJobLogFooter,
  isTerminalJobStatus,
  needsCompletionNotice,
  previewCommand,
  transitionJob,
  truncateFinalText,
  type JobDeadline,
  type JobDeadlinePolicy,
  type JobId,
  type JobRecord,
  type JobStatus,
  type JobTransitionPatch,
} from "./types.js";
import { formatDuration } from "../core/format.js";

/**
 * bash auto-background §3 — `BashJobManager`, the owner of a backgrounded
 * bash job's whole life: spawn, log tee (with a hard size cap), terminal
 * settlement, incremental output reads, prefix resolution, kill, bounded
 * `waitExit`, the single-channel completion notification poll, and the
 * post-restart `recover()` decision tree.
 *
 * Layering:
 * - **no pi imports** — the `notify` callback is injected by `src/stack.ts`,
 *   which owns `pi.sendMessage`; the manager only knows "deliver this record";
 * - no settings import — every knob arrives structurally (`BashJobManagerOptions`),
 *   so the `bashJobs` settings block can evolve independently;
 * - no mutable module-level state (the extension re-activates in-process on
 *   `/reload`);
 * - every timer goes through the injected `Clock`, whose real implementation
 *   `unref()`s (a ref'd timer wedges `pi -p`).
 *
 * Invariants worth preserving:
 * - **I-a** every status change goes through `transitionJob`; an illegal move
 *   is WARNed and dropped, never thrown — a bug signal must not cost us a live
 *   process.
 * - **I-b** notifications have exactly one channel: "terminal on disk +
 *   `backgroundedAt` set + `notifiedAt` unset" observed by the *current*
 *   manager's poll (§3.6). Write paths only persist; a disposed manager's
 *   in-flight finalization callbacks therefore cannot double-notify after
 *   `/reload`.
 * - **I-c** identity doubt never kills: `checkPidOwnership() === "unsafe"`
 *   marks the job `orphaned` and refuses the kill (§3.3 safety floor).
 */

export const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_BACKGROUND_JOBS = 8;
export const DEFAULT_NOTIFY_POLL_MS = 2_000;
/**
 * Grace before a foreground-completed job's files are dropped. Not zero: the
 * auto-background threshold can fire in the same tick the process exits, and
 * `markBackgrounded` must still find a record to stamp.
 */
export const DEFAULT_DISCARD_GRACE_MS = 5_000;
/** Cap on one `readOutput` increment; the cursor makes the rest reachable. */
export const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
/**
 * Minimum spacing between in-session retention sweeps (§15). Long-lived
 * sessions would otherwise never prune: `recover()` only runs at stack build.
 * Throttled and piggybacked on `create()` **on purpose** — a timer here would
 * wake an idle session and wedge `pi -p`.
 */
export const DEFAULT_SWEEP_INTERVAL_MS = 600_000;
/**
 * bash-timeout-grace plan §2.4 R12 (v5, user-widened): the job's own staged
 * on-disk persistence budget before `reserve()` gives up and fails the job
 * without ever spawning a process. Not a tool-call wait bound — that is
 * `§3.6`'s separate `R`/abort race, layered on top of this.
 */
export const STAGE_PERSIST_TIMEOUT_MS: Millis = 30_000;
/** §2.2/R7: `extend()`'s own bound on waiting for the matching disk write. */
export const EXTEND_PERSIST_TIMEOUT_MS: Millis = 2_000;
/** Candidate list cap in resolution errors (matches `resolve-target.ts`). */
const MAX_CANDIDATES = 10;

/** Marker line appended once the log hits `maxLogBytes` (§3.4). */
export function formatLogTruncationNotice(maxLogBytes: number): string {
  return `\n[log truncated at ${maxLogBytes} bytes]\n`;
}

export interface BashJobManagerOptions {
  store: JobStore;
  processPort: ProcessPort;
  clock: Clock;
  /** Session that owns newly created jobs (recorded for display/filtering). */
  sessionId: string;
  /** Defaults to `process.pid`; injectable so recovery tests can fake hosts. */
  hostPid?: number;
  /**
   * Completion notification sink (§5). Rejecting means "retry next tick" —
   * `notifiedAt` is only stamped after it resolves. Omit it and the manager
   * simply leaves records unnotified for a later session to pick up.
   */
  notify?: (record: JobRecord) => Promise<void> | void;
  maxLogBytes?: number;
  maxBackgroundJobs?: number;
  /** Notification / adopted-liveness poll cadence. */
  pollMs?: Millis;
  /** Grace before foreground-completed job records are discarded (0 = at the next tick). */
  discardGraceMs?: Millis;
  /** SIGTERM → SIGKILL window handed to `killJobTree`. */
  killGraceMs?: Millis;
  maxReadBytes?: number;
  /** Minimum spacing between `create()`-driven retention sweeps. */
  sweepIntervalMs?: Millis;
  /** Post-exit drain cap used by the process port and log marker. */
  drainTimeoutMs?: Millis;
  warn?: (message: string) => void;
  /**
   * bash-timeout-grace plan §2.1: the frozen deadline policy stamped onto
   * every job created with a `timeoutMs` (§2.3/2.4). Defaults to
   * `DEFAULT_JOB_DEADLINE_POLICY` (U4: 60s grace / 3 extensions / 3x factor).
   */
  deadlinePolicy?: JobDeadlinePolicy;
  /**
   * §3 (child session bash jobs): stamps every job this manager creates with
   * `owner: "subagent"` (§3.9's crash-recovery branch keys off this field).
   * Omitted for the main session's manager.
   */
  owner?: "subagent";
  /**
   * §3.6 S1: synchronous admission gate consulted by `reserve()` before a new
   * job is created. Returning `false` (a sealed child run, §3.3) rejects the
   * call with "run is ending; no new bash jobs" and spawns nothing. Omitted
   * (main session) means "always admit".
   */
  admit?: () => boolean;
  /**
   * §2.3 table: fired synchronously whenever a running job's deadline enters
   * its grace window (deduplicated per grace episode via `graceNotified`,
   * R6) or a successful `extend()` moves `dueAt` forward. The caller (a later
   * package) owns actually notifying anyone; the manager only decides *when*.
   */
  onDeadline?: (record: JobRecord, kind: "grace" | "extended") => void;
}

export interface CreateJobInit {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Live output relay for the foreground phase (pi's `BashOperations.exec`). */
  onData?: (chunk: string) => void;
  /**
   * bash-timeout-grace plan §2.1/U3: the model-supplied `timeout` (ms),
   * already resolved by the caller's `resolveTimeoutMs`. Omitted (or `<= 0`)
   * means "no job-level deadline" — the only representation of "no timeout".
   */
  timeoutMs?: Millis;
}

export interface CreatedJob {
  readonly jobId: JobId;
  /** The `running` record, already persisted. */
  readonly record: JobRecord;
  readonly pid: number;
  readonly pgid: number;
  readonly logPath: string;
  /** Settles with the terminal record after bounded exit/drain finalization. Never rejects. */
  readonly exit: Promise<JobRecord>;
}

export interface ReadOutputOptions {
  /** Explicit byte offset; defaults to the persisted `readCursor` (now always 0 in practice). */
  offset?: number;
  /** Persist the advanced cursor (default `true`). Tool callers pass `false`. */
  advanceCursor?: boolean;
  /** Per-call read cap; defaults to the manager's `maxReadBytes`. */
  maxBytes?: number;
}

export interface JobOutputRead {
  readonly jobId: JobId;
  readonly content: string;
  readonly startOffset: number;
  readonly nextOffset: number;
  /** Current size of the log file. */
  readonly logBytes: number;
  readonly state: JobStatus;
  readonly exitCode: number | null;
  /** The log itself was capped at `maxLogBytes` — output was dropped (§3.4). */
  readonly logTruncated: boolean;
  /** Whether the local log stream has been closed. */
  readonly logClosed: boolean;
  readonly finalText?: string;
  readonly record: JobRecord;
}

export type KillJobOutcome = KillOutcome | "already-terminal";

export interface KillJobResult {
  readonly jobId: JobId;
  readonly outcome: KillJobOutcome;
  /** True when nothing was signalled because the job had already settled. */
  readonly alreadyTerminal: boolean;
  /** Set when the kill was refused (`outcome === "refused"`). */
  readonly reason?: string;
  readonly record: JobRecord;
}

export interface RecoverSummary {
  /** `running` jobs whose pid was verified ours — now polled by this manager. */
  readonly adopted: readonly JobId[];
  /** `running` jobs whose pid was certainly gone (exit code lost). */
  readonly exitedUnknown: readonly JobId[];
  /** `running` jobs whose pid could not be attributed — marked, never killed. */
  readonly orphaned: readonly JobId[];
  /** `staged` jobs whose spawn outcome was lost with the previous process. */
  readonly lostStaged: readonly JobId[];
  /** Live jobs belonging to another live pi process — left untouched. */
  readonly foreign: readonly JobId[];
  /** Terminal jobs still awaiting their completion notification. */
  readonly pendingNotices: readonly JobId[];
  /** Job records dropped by the retention sweep. */
  readonly pruned: readonly JobId[];
  /** Non-record files dropped by the sweep (bad records, orphan logs, tmp debris). */
  readonly prunedFiles: readonly string[];
  /**
   * bash-timeout-grace plan §3.9: `owner: "subagent"` `running` jobs whose
   * identity was verified and were actively killed (not merely adopted).
   */
  readonly subagentKilled: readonly JobId[];
  /**
   * §2.5 step 4: `true` when the scan stopped early because `signal` fired
   * (or the manager was disposed) before every record was adjudicated —
   * `recover()` never hangs on it, it just does less work.
   */
  readonly partial: boolean;
}

export interface LocalJobHandoff {
  readonly jobId: JobId;
  readonly record: JobRecord;
  readonly handle: LocalHandle;
  /**
   * §2.4/§3.6 (P3+P4 verifier round 6): the exporting manager's in-flight
   * `killNonTerminal` attempt for this job, if any, carried across the
   * reload handoff so the adopting manager reuses the *same* promise
   * instead of sending a second signal for a kill that is already under
   * way. Optional and additive — backward compatible with any P0b-frozen
   * caller that does not know about it.
   */
  readonly killInFlight?: Promise<KillJobResult> | undefined;
}

/**
 * bash-timeout-grace plan §3.6: the synchronous half of a job's creation.
 * `started` never rejects (§3.6/R12) — every failure or cancellation path
 * settles the in-memory record to a terminal status first and resolves
 * `{ ok: false, error }`, so `waitExit`/`bash_job status`/the settle-hold
 * summary/exit facts can all observe the outcome without an unhandled
 * rejection anywhere in the process.
 */
export interface ReservedJob {
  readonly jobId: JobId;
  readonly logPath: string;
  readonly started: Promise<StartedResult>;
}

export type StartedResult =
  { readonly ok: true; readonly job: CreatedJob } | { readonly ok: false; readonly error: Error };

/** `extend()`'s own reasons on top of `deadline.ts`'s eligibility reasons. */
export type ManagerExtendReason = JobExtensionReason | "not_found";

export type ExtendJobOutcome =
  | { readonly ok: true; readonly record: JobRecord; readonly persistPending: boolean }
  | { readonly ok: false; readonly reason: ManagerExtendReason };

export interface BashJobManager {
  readonly dir: string;
  readonly maxBackgroundJobs: number;
  /**
   * §2.5/§3.9: `signal` (when given) is checked before every I/O call and
   * after every `await` (the linearization point is `signal.aborted` going
   * true) — aborting never leaves a mutated record, never rearms a timer,
   * never sends a notification; it simply makes `recover()` return sooner
   * with `partial: true`. Disposing the manager has the same effect on any
   * `recover()` call already in flight against it.
   */
  recover(signal?: AbortSignal): Promise<RecoverSummary>;
  create(init: CreateJobInit): Promise<CreatedJob>;
  /**
   * bash-timeout-grace plan §3.6: the non-blocking spawn entry point.
   * Synchronous (E33) — admits (§3.6 S1), allocates the `jobId`/`logPath`,
   * and returns immediately; the whole save → spawn → running sequence (R12)
   * runs behind `started`, which never rejects. Throws synchronously only
   * when the manager is disposed or `admit()` refuses (no job is created).
   */
  reserve(init: CreateJobInit): ReservedJob;
  /**
   * bash-timeout-grace plan §3.6/R12: cancel a job still inside `reserve()`'s
   * own flow (or kill it outright if it already reached `running`).
   * Synchronous, idempotent, and total — a stale/unknown `jobId` is a no-op.
   */
  cancelReserve(jobId: JobId): void;
  /** In-memory snapshot (sync, for `/agent status` and the tool layer). */
  get(jobId: JobId): JobRecord | undefined;
  /** Disk-authoritative read (falls back to memory when the file is gone). */
  load(jobId: JobId): Promise<JobRecord | undefined>;
  list(): readonly JobRecord[];
  /** exact id → unique prefix. Throws a candidate-listing error otherwise. */
  resolve(handle: string): JobId;
  /** Mark the job as handed to the model; enables its completion notice (§5). */
  markBackgrounded(jobId: JobId): Promise<JobRecord | undefined>;
  /**
   * bash-timeout-grace plan §3.6: synchronous twin of `markBackgrounded` for
   * the auto-background return path (R = D − 3s) — the tool call must return
   * with zero further `await`s, so the persistence is fired-and-forgotten
   * through the store's chain (R5) instead of awaited.
   */
  markBackgroundedSync(jobId: JobId): void;
  /**
   * §2.5 step 3 (crash-handoff log relocation): update the in-memory
   * `logPath` synchronously and queue the matching on-disk `upsert` on the
   * job's directory chain. Resolves once that write settles (or is skipped
   * because the job is gone) so the caller can safely `unlink` the old JSON
   * afterwards.
   */
  relocateLog(jobId: JobId, newLogPath: string): Promise<void>;
  /** Persist the inner tool's final text (allowed before or after settlement). */
  setFinalText(jobId: JobId, text: string): Promise<JobRecord | undefined>;
  /**
   * Declare *why* the process is about to die, so the exit handler labels the
   * terminal state `killed` / `timed_out` instead of inferring `failed`.
   */
  noteTermination(jobId: JobId, reason: "killed" | "timed_out"): void;
  readOutput(jobId: JobId, options?: ReadOutputOptions): Promise<JobOutputRead>;
  kill(jobId: JobId, options?: { graceMs?: Millis }): Promise<KillJobResult>;
  /**
   * bash-timeout-grace plan §2.2/§2.6 (`bash_job(action:"extend")`): apply an
   * extension synchronously against the in-memory record (R1) and wait at
   * most 2s for the matching disk write (R7) before returning —
   * `persistPending: true` means the extension is in effect (waiters/timers
   * already reflect it) but the write is still queued.
   */
  extend(jobId: JobId, extendMs: Millis, reason?: string): Promise<ExtendJobOutcome>;
  /**
   * Bounded wait for a terminal state; resolves with the latest record. An
   * abort signal settles the wait early (with the current record), so Esc /
   * session teardown can interrupt a `bash_job wait` tool call instead of
   * being stuck until the timeout fires.
   */
  waitExit(
    jobId: JobId,
    timeoutMs: Millis,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<JobRecord | undefined>;
  /**
   * §3.5 support: resolves once every given job id is terminal (or the
   * shared timeout/abort fires first, per-job, mirroring `waitExit`).
   */
  waitAllExit(jobIds: readonly JobId[], timeoutMs: Millis, opts?: { signal?: AbortSignal | undefined }): Promise<void>;
  /** §3.8 — this host's `running` **and** backgrounded jobs. */
  backgroundJobCount(): number;
  hasBackgroundCapacity(): boolean;
  /** Export backgrounded local jobs for the next in-process stack. */
  exportLocalJobs(): LocalJobHandoff[];
  hasOpenLocalHandle(jobId: JobId): boolean;
  /**
   * Adopt local handles exported by the previous stack (§2.5 step 2).
   * `opts.sessionId`, when given and different from a handed-off record's
   * own `sessionId`, retags it (this manager's session now owns the job).
   * Deadline timers are rearmed purely from the in-memory record — no I/O.
   */
  adoptLocalJobs(handoffs: LocalJobHandoff[], opts?: { sessionId?: string }): void;
  /** Wait until all queued store writes have settled. */
  drain(): Promise<void>;
  /** Clears timers only. Never kills a process, never notifies afterwards. */
  dispose(): void;
}

/** §5 gate: only ownerless (backgrounded) jobs are announced, and never orphans. */
export function shouldNotifyJob(record: JobRecord): boolean {
  return needsCompletionNotice(record) && record.backgroundedAt !== undefined && record.status !== "orphaned";
}

/**
 * A job that settled while still in the foreground never became a `job_id` the
 * model can use: the tool call itself returned (or threw) its full result, so
 * the record and log are litter. Keeping them would bloat `bash_job list` with
 * every `echo`, hold each command's output on disk for `retentionMs`, and
 * leave hundreds of files behind in a busy session.
 */
export function shouldDiscardJob(record: JobRecord): boolean {
  return isTerminalJobStatus(record.status) && record.backgroundedAt === undefined;
}

export interface LocalHandle {
  readonly spawned: SpawnedJob;
  readonly stream: WriteStream;
  /** Serializes log writes and lets `readOutput` wait for a real flush. */
  flush: Promise<void>;
  written: number;
  truncated: boolean;
  closed: boolean;
  /** False once anything was written that did not end in a newline. */
  atLineStart: boolean;
  pendingTerminal: { status: JobStatus; exitCode: number | null; at: Millis } | undefined;
  /** True after this handle crosses a session boundary. */
  adopted: boolean;
  /** Idempotency latch for the terminal footer line (change B). */
  footerWritten: boolean;
  /** Explicit ownership token for cross-stack finalization. */
  owner: object;
  termination?: "killed" | "timed_out";
}

interface Waiter {
  resolve(record: JobRecord | undefined): void;
  timer: TimerHandle;
}

interface Entry {
  record: JobRecord;
  /** Present only for jobs this manager spawned itself (not adopted ones). */
  local?: LocalHandle;
  waiters: Set<Waiter>;
  /**
   * bash-timeout-grace plan §2.4 R12: `reserve()`'s own sub-state while the
   * job has not reached `running` yet. `undefined` once spawn is settled
   * (running/failed/killed) — not itself part of the persisted record.
   */
  stage?: "persisting" | "spawning" | undefined;
  /** §2.4 R12: only-increases cancellation flag set by `cancelReserve` / sealing. */
  cancelled?: boolean | undefined;
  /** §2.3 due/grace timer for this job's `deadline`, if any (R2). */
  deadlineTimer?: TimerHandle | undefined;
  /**
   * §2.4/§3.6 (P3+P4 verifier round 5): the in-flight `killNonTerminal`
   * attempt for this job, if any. Concurrent kill triggers (an abort's
   * `cancelReserve` racing a seal/killAll fan-out, or two independent
   * `kill()` calls) must send at most one signal per termination attempt —
   * every caller reuses this same promise instead of calling
   * `processPort.killJobTree` again. Cleared once the attempt settles
   * (success *or* failure), so a later, non-concurrent `kill()` call (this
   * attempt is fully done and the job still needs killing) is free to start
   * a fresh one rather than being coalesced into a stale result forever.
   */
  killInFlight?: Promise<KillJobResult> | undefined;
}

export function createBashJobManager(options: BashJobManagerOptions): BashJobManager {
  const { store, processPort, clock } = options;
  const warn = options.warn ?? ((message: string) => console.warn(`[pi-subagent] ${message}`));
  const hostPid = options.hostPid ?? process.pid;
  const maxLogBytes = normalizePositive(options.maxLogBytes, DEFAULT_MAX_LOG_BYTES);
  const maxBackgroundJobs = normalizePositive(options.maxBackgroundJobs, DEFAULT_MAX_BACKGROUND_JOBS);
  const maxReadBytes = normalizePositive(options.maxReadBytes, DEFAULT_MAX_READ_BYTES);
  const pollMs = normalizePositive(options.pollMs, DEFAULT_NOTIFY_POLL_MS);
  const drainTimeoutMs =
    options.drainTimeoutMs !== undefined && Number.isFinite(options.drainTimeoutMs) && options.drainTimeoutMs >= 0
      ? Math.trunc(options.drainTimeoutMs)
      : 30_000;
  const killGraceMs = options.killGraceMs;
  const notify = options.notify;
  const sweepIntervalMs = normalizePositive(options.sweepIntervalMs, DEFAULT_SWEEP_INTERVAL_MS);
  // Unlike the other knobs, 0 is meaningful here ("discard on the next tick").
  const discardGraceMs =
    options.discardGraceMs !== undefined && Number.isFinite(options.discardGraceMs) && options.discardGraceMs >= 0
      ? Math.trunc(options.discardGraceMs)
      : DEFAULT_DISCARD_GRACE_MS;
  const deadlinePolicy = options.deadlinePolicy ?? DEFAULT_JOB_DEADLINE_POLICY;
  const myToken = {};

  const entries = new Map<JobId, Entry>();
  /**
   * Job ids this manager instance created itself. `recover()` must not
   * adjudicate them: `create()` persists a `staged` record *before* awaiting
   * the spawn, so a directory scan racing a fresh call would otherwise see
   * that record as "a staged job whose spawn outcome was lost" and bury a
   * live, still-spawning process under `failed` — after which the real
   * `staged -> running` transition is rejected as illegal and the pid is never
   * persisted, leaving an unkillable background process (worse than the bug it
   * was reporting). The owning `create()` call is always the authority for
   * these ids; recovery only speaks for jobs left behind by someone else.
   */
  const localJobs = new Set<JobId>();
  const notifying = new Set<JobId>();
  let pollTimer: TimerHandle | undefined;
  let ticking = false;
  let disposed = false;
  /** `undefined` = never swept by this manager (the first `create()` will). */
  let lastSweepAt: Millis | undefined;

  // ── memory table ─────────────────────────────────────────────────────────

  function ensureEntry(record: JobRecord): Entry {
    const existing = entries.get(record.jobId);
    if (existing) return existing;
    const created: Entry = { record, waiters: new Set() };
    entries.set(record.jobId, created);
    return created;
  }

  /**
   * Adopt a freshly persisted record into the table. A local job's live byte
   * counters win over the (deliberately throttled) on-disk ones, so status and
   * list views never regress while the process is still writing.
   *
   * R9 (read-not-regress): the incoming `deadline` never overwrites a
   * higher-`seq` in-memory one — a synchronous `extend()`/grace-entry can
   * complete before its own back-write lands on disk, and a *different*
   * write's disk read (recovery, a stale `manager.load()`) must not resurrect
   * the older value in memory.
   */
  function putRecord(record: JobRecord): JobRecord {
    const entry = ensureEntry(record);
    const handle = entry.local;
    const merged =
      handle && record.backgroundedAt === undefined && entry.record.backgroundedAt !== undefined
        ? { ...record, backgroundedAt: entry.record.backgroundedAt }
        : handle && !isTerminalJobStatus(record.status)
          ? {
              ...record,
              logBytes: Math.max(record.logBytes, handle.written),
              outputTruncated: record.outputTruncated || handle.truncated,
            }
          : record;
    const priorDeadline = entry.record.deadline;
    const incomingDeadline = merged.deadline;
    const withDeadline =
      priorDeadline !== undefined && (incomingDeadline === undefined || priorDeadline.seq >= incomingDeadline.seq)
        ? { ...merged, deadline: priorDeadline }
        : merged;
    entry.record = withDeadline;
    if (isTerminalJobStatus(withDeadline.status)) settleWaiters(entry);
    return withDeadline;
  }

  function settleWaiters(entry: Entry): void {
    for (const waiter of entry.waiters) {
      clock.clearTimer(waiter.timer);
      waiter.resolve(entry.record);
    }
    entry.waiters.clear();
  }

  // ── persistence helpers ──────────────────────────────────────────────────

  /**
   * `guard` (recover's abort checkpoint, §2.5 step 4): checked before the
   * store write is even queued (no new I/O after the linearization point)
   * and again before the result is folded into memory — a write that was
   * already in flight when the guard tripped is allowed to settle on disk,
   * but its result is discarded here: no `putRecord`, no waiter settlement.
   */
  async function applyTransition(
    jobId: JobId,
    to: JobStatus,
    patch: JobTransitionPatch,
    guard?: () => boolean,
  ): Promise<JobRecord | undefined> {
    if (guard?.()) return undefined;
    const stored = await store.update(jobId, (current) => {
      const result = transitionJob(current, to, patch);
      if (!result.ok) {
        // I-a: a lost race (double exit callback, poll vs. exit handler) is
        // expected noise, not a reason to throw away a record.
        warn(result.reason);
        return undefined;
      }
      return result.record;
    });
    if (!stored) return undefined;
    if (guard?.()) return undefined;
    return putRecord(stored);
  }

  /** `guard` as in `applyTransition` above (§2.5 step 4). */
  async function applyPatch(
    jobId: JobId,
    mutate: (record: JobRecord) => JobRecord | undefined,
    guard?: () => boolean,
  ): Promise<JobRecord | undefined> {
    if (guard?.()) return undefined;
    const stored = await store.update(jobId, mutate);
    if (!stored) return undefined;
    if (guard?.()) return undefined;
    return putRecord(stored);
  }

  // ── job-level deadline (bash-timeout-grace plan §2.3/§2.4) ───────────────

  /**
   * R5/R10: queue the deadline back-write on the store's chain without
   * awaiting it — memory (already updated by the caller) is authoritative,
   * disk is best-effort and CAS'd by `seq` so an in-flight write can never
   * undo a newer one (R10). A missing on-disk record (job never persisted,
   * or already pruned) is a no-op, not an error.
   */
  function persistDeadline(jobId: JobId, next: JobDeadline): void {
    void store
      .upsert(jobId, (current) => {
        if (!current) return undefined;
        if (current.deadline !== undefined && current.deadline.seq >= next.seq) return undefined;
        return { ...current, deadline: next };
      })
      .catch((error) => warn(`bash job ${jobId} deadline persistence error (ignored): ${String(error)}`));
  }

  /**
   * R2: the *only* deadline timer callback. Every arm captures nothing but
   * the `jobId` — staleness is judged fresh, every time, straight off the
   * live record, so a lost race (extend landed first, exit landed first)
   * simply produces a different (still correct) decision instead of a
   * stale one firing anyway.
   */
  function rearm(jobId: JobId): void {
    const entry = entries.get(jobId);
    if (!entry || disposed) return;
    if (entry.deadlineTimer !== undefined) {
      clock.clearTimer(entry.deadlineTimer);
      entry.deadlineTimer = undefined;
    }
    const record = entry.record;
    if (isTerminalJobStatus(record.status) || record.deadline === undefined) return;
    const now = clock.now();
    const decision = resumeDeadline(record, now);
    if (decision.kind === "none") return;
    if (decision.kind === "expire") {
      void killForDeadline(jobId, "timed_out");
      return;
    }
    if (decision.kind === "grace") {
      enterGrace(jobId, decision.graceUntil);
      return;
    }
    entry.deadlineTimer = clock.setTimer(Math.max(0, decision.at - now), () => {
      const live = entries.get(jobId);
      if (live) live.deadlineTimer = undefined;
      rearm(jobId);
    });
  }

  /**
   * §2.3/R6: enter (or re-confirm) the grace window — memory first (sync),
   * disk after (fire-and-forget), notification deduplicated per episode via
   * `graceNotified < graces`, then rearm at `graceUntil`.
   */
  function enterGrace(jobId: JobId, graceUntil: Millis): void {
    const entry = entries.get(jobId);
    if (!entry || disposed) return;
    const record = entry.record;
    const d = record.deadline;
    if (!d || isTerminalJobStatus(record.status)) return;
    const nextGraces = d.graces + 1;
    const notify = d.graceNotified < nextGraces;
    const next: JobDeadline = {
      ...d,
      graceUntil,
      graces: nextGraces,
      graceNotified: notify ? d.graceNotified + 1 : d.graceNotified,
      seq: d.seq + 1,
    };
    entry.record = { ...record, deadline: next };
    persistDeadline(jobId, next);
    if (notify) {
      try {
        options.onDeadline?.(entry.record, "grace");
      } catch (error) {
        warn(`bash job ${jobId} onDeadline(grace) threw (ignored): ${String(error)}`);
      }
    }
    rearm(jobId);
  }

  /**
   * §2.3 table: due (no/expired grace) → kill. Mirrors `bash-tool.ts`'s
   * existing `killTree` composition (`kill()` synchronously pins
   * `local.termination` before its first `await`, so relabelling it right
   * after the call — still in the same microtask — always wins) rather than
   * duplicating the identity-checked kill ladder.
   */
  async function killForDeadline(jobId: JobId, reason: "timed_out"): Promise<void> {
    const entry = entries.get(jobId);
    if (!entry || isTerminalJobStatus(entry.record.status)) return;
    if (entry.local) {
      void kill(jobId, {}).catch((error) => warn(`bash job ${jobId} deadline kill failed: ${String(error)}`));
      noteTerminationInternal(jobId, reason);
      return;
    }
    // Defensive fallback: a deadline timer should only ever be armed for a job
    // this manager itself spawned (and therefore still holds a local handle
    // for) — see `rearm`'s only callers. Kept total rather than assuming.
    const record = entry.record;
    const ownership = processPort.checkPidOwnership(record);
    if (ownership === "unsafe") {
      await applyTransition(jobId, "orphaned", { at: clock.now(), exitCode: null });
      return;
    }
    if (ownership === "dead") {
      await applyTransition(jobId, "exited_unknown", { at: clock.now(), exitCode: null });
      return;
    }
    const pid = record.pid;
    if (pid !== undefined) {
      const outcome = await processPort
        .killJobTree(pid, record.procStartTime !== undefined ? { expectedProcStartTime: record.procStartTime } : {})
        .catch(() => "refused" as const);
      if (outcome === "refused") {
        await applyTransition(jobId, "orphaned", { at: clock.now(), exitCode: null });
        return;
      }
    }
    await applyTransition(jobId, reason, { at: clock.now(), exitCode: null });
  }

  /** Shared by the public `noteTermination` and the internal deadline path. */
  function noteTerminationInternal(jobId: JobId, reason: "killed" | "timed_out"): void {
    const local = entries.get(jobId)?.local;
    if (local) local.termination = reason;
  }

  /**
   * §2.4 R12: race a promise against the clock (not real timers, so
   * FakeClock-driven tests are deterministic). Distinguishes "resolved",
   * "rejected" and "timed out" — `runReserveFlow` needs all three.
   */
  function raceOutcome<T>(
    promise: Promise<T>,
    ms: Millis,
  ): Promise<{ kind: "ok"; value: T } | { kind: "error"; error: unknown } | { kind: "timeout" }> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = clock.setTimer(ms, () => {
        if (settled) return;
        settled = true;
        resolve({ kind: "timeout" });
      });
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clock.clearTimer(timer);
          resolve({ kind: "ok", value });
        },
        (error) => {
          if (settled) return;
          settled = true;
          clock.clearTimer(timer);
          resolve({ kind: "error", error });
        },
      );
    });
  }

  /** R7: like `raceOutcome`, but collapsed to "did it settle before the deadline". */
  function raceSettled(promise: Promise<unknown>, ms: Millis): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = clock.setTimer(ms, () => {
        if (settled) return;
        settled = true;
        resolve(false);
      });
      promise.then(
        () => {
          if (settled) return;
          settled = true;
          clock.clearTimer(timer);
          resolve(true);
        },
        () => {
          if (settled) return;
          settled = true;
          clock.clearTimer(timer);
          resolve(true);
        },
      );
    });
  }

  // ── notification poll (single channel, §5 / I-b) ─────────────────────────

  function hasWork(): boolean {
    for (const entry of entries.values()) {
      if (!isTerminalJobStatus(entry.record.status)) return true;
      if (notify !== undefined && shouldNotifyJob(entry.record)) return true;
      if (shouldDiscardJob(entry.record)) return true;
    }
    return false;
  }

  function ensurePolling(): void {
    if (disposed || pollTimer !== undefined || !hasWork()) return;
    pollTimer = clock.setTimer(pollMs, () => {
      pollTimer = undefined;
      void tick();
    });
  }

  async function tick(): Promise<void> {
    if (disposed || ticking) return;
    ticking = true;
    try {
      for (const entry of [...entries.values()]) await probeAdopted(entry);
      for (const entry of [...entries.values()]) await deliverNotice(entry);
      for (const entry of [...entries.values()]) await discardForeground(entry.record);
    } finally {
      ticking = false;
      ensurePolling();
    }
  }

  /**
   * Adopted jobs have no `exit` event to listen to (their parent died with the
   * previous pi process), so liveness is polled. Only a *certainly dead* pid
   * moves the record; `"unsafe"` leaves it running (I-c).
   */
  async function probeAdopted(entry: Entry): Promise<void> {
    const record = entry.record;
    if (entry.local || record.status !== "running") return;
    if (processPort.checkPidOwnership(record) !== "dead") return;
    const fresh = await store.load(record.jobId);
    if (fresh && isTerminalJobStatus(fresh.status)) {
      putRecord(fresh);
      return;
    }
    await applyTransition(record.jobId, "exited_unknown", { at: clock.now(), exitCode: null });
  }

  async function deliverNotice(entry: Entry): Promise<void> {
    if (disposed || notify === undefined) return;
    if (entry.local && !entry.local.closed) return;
    const record = entry.record;
    if (!shouldNotifyJob(record) || notifying.has(record.jobId)) return;
    notifying.add(record.jobId);
    try {
      await notify(record);
    } catch (error) {
      // Natural backoff: retried on the next tick (§5).
      warn(`bash job ${record.jobId} notification failed (will retry): ${String(error)}`);
      return;
    } finally {
      notifying.delete(record.jobId);
    }
    const at = clock.now();
    const stored = await applyPatch(record.jobId, (current) =>
      current.notifiedAt === undefined ? { ...current, notifiedAt: at } : undefined,
    );
    if (stored === undefined) {
      const entry = entries.get(record.jobId);
      if (entry) entry.record = { ...entry.record, notifiedAt: at };
    }
  }

  /**
   * Drops a foreground-completed job (see `shouldDiscardJob`) once it is older
   * than `discardGraceMs`. The record is re-read first: a job backgrounded
   * between ticks must survive, and after a `/reload` the disk is the
   * authority. Never touches a process — these jobs are already terminal.
   */
  async function discardForeground(record: JobRecord): Promise<void> {
    if (disposed || !shouldDiscardJob(record)) return;
    if (clock.now() - (record.endedAt ?? record.createdAt) < discardGraceMs) return;
    const fresh = await store.load(record.jobId);
    if (fresh && !shouldDiscardJob(fresh)) {
      putRecord(fresh);
      return;
    }
    await store.remove(record.jobId);
    entries.delete(record.jobId);
    localJobs.delete(record.jobId);
  }

  // ── retention sweep (§15) ────────────────────────────────────────────────

  function sweepArgs() {
    // A log whose job is still in this manager's table is live output, not
    // orphan litter — even if its record is momentarily missing from disk.
    return { isTracked: (jobId: JobId) => entries.has(jobId) };
  }

  /**
   * Throttled full-directory prune, driven by `create()` (never by a timer).
   * Failure is diagnostic-only: cleanup must never break spawning a command.
   */
  async function maybeSweep(): Promise<void> {
    if (disposed) return;
    const now = clock.now();
    if (lastSweepAt !== undefined && now - lastSweepAt < sweepIntervalMs) return;
    lastSweepAt = now;
    try {
      await store.pruneExpired(sweepArgs());
    } catch (error) {
      warn(`bash job retention sweep failed: ${String(error)}`);
    }
  }

  // ── log tee with a hard cap (§3.4) ───────────────────────────────────────

  function pushWrite(handle: LocalHandle, buffer: Buffer): void {
    if (buffer.length === 0) return;
    handle.written += buffer.length;
    handle.atLineStart = buffer[buffer.length - 1] === 0x0a;
    handle.flush = handle.flush.then(
      () =>
        new Promise<void>((resolve) => {
          if (handle.closed) {
            resolve();
            return;
          }
          handle.stream.write(buffer, () => resolve());
        }),
    );
  }

  function teeChunk(entry: Entry, handle: LocalHandle, chunk: Buffer | string, onData?: (text: string) => void): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    if (onData) {
      try {
        onData(buffer.toString("utf8"));
      } catch (error) {
        warn(`bash job ${entry.record.jobId} output relay threw (ignored): ${String(error)}`);
      }
    }
    if (handle.truncated) return;
    const room = Math.max(0, maxLogBytes - handle.written);
    const overflow = buffer.length > room;
    pushWrite(handle, overflow ? buffer.subarray(0, room) : buffer);
    if (overflow) {
      handle.truncated = true;
      pushWrite(handle, Buffer.from(formatLogTruncationNotice(maxLogBytes), "utf8"));
      const bytes = handle.written;
      // The cap is a durable fact about the job; the running byte count is not
      // (it would thrash the JSON file), so only this edge persists eagerly.
      void applyPatch(entry.record.jobId, (current) =>
        current.outputTruncated ? undefined : { ...current, outputTruncated: true, logBytes: bytes },
      ).catch(() => undefined);
    }
    entry.record = { ...entry.record, logBytes: handle.written, outputTruncated: handle.truncated };
  }

  // ── create ───────────────────────────────────────────────────────────────

  function terminalStatusFor(handle: LocalHandle, exit: JobExit): JobStatus {
    if (handle.termination) return handle.termination;
    if (exit.signal !== null) return "killed";
    return exit.exitCode === 0 ? "completed" : "failed";
  }

  /**
   * Change B — append the terminal footer to the log *before the stream is
   * closed* (never reopen the file), exactly once per job.
   *
   * Deliberate cap violation: the footer is written even when the log already
   * hit `maxLogBytes`, so the log may end up slightly over the limit. The
   * footer is the conclusion of the log — losing it to a capacity policy would
   * defeat the whole point (a reader must be able to `tail` the file and know
   * how the job ended). One short line is a bounded overshoot.
   */
  function appendLogFooter(entry: Entry, handle: LocalHandle, status: JobStatus, exitCode: number | null, at: Millis) {
    if (handle.footerWritten || handle.closed) return;
    handle.footerWritten = true;
    const record = entry.record;
    const startedAt = record.spawnedAt ?? record.createdAt;
    const line = formatJobLogFooter({
      jobId: record.jobId,
      status,
      exitCode,
      duration: formatDuration(Math.max(0, at - startedAt)),
    });
    pushWrite(handle, Buffer.from(`${handle.atLineStart ? "" : "\n"}${line}\n`, "utf8"));
    // The footer is part of the log, so it counts towards logBytes like any
    // other byte; the terminal transition below persists `handle.written`.
    entry.record = { ...entry.record, logBytes: handle.written };
  }

  function formatDrainCapNotice(): string {
    return `\n[pi-subagent] log tail capture stopped: pipes still busy ${drainTimeoutMs}ms after process exit\n`;
  }

  async function finalizeLocal(jobId: JobId, entry: Entry, handle: LocalHandle): Promise<JobRecord> {
    const mine = myToken;
    const exit = await handle.spawned.processExitPromise;
    const at = clock.now();
    if (handle.owner !== mine) return entry.record;
    const status = terminalStatusFor(handle, exit);
    const patch: JobTransitionPatch = {
      at,
      exitCode: exit.exitCode,
      logBytes: handle.written,
      outputTruncated: handle.truncated,
      ...(exit.error !== undefined ? { finalText: exit.error.message } : {}),
    };
    if (!isTerminalJobStatus(entry.record.status)) {
      try {
        const stored = await applyTransition(jobId, status, patch);
        if (stored) entry.record = stored;
        else {
          const local = transitionJob(entry.record, status, patch);
          if (local.ok) {
            entry.record = putRecord(local.record);
            handle.pendingTerminal = { status, exitCode: exit.exitCode, at };
          }
          warn(`bash job ${jobId} terminal state persistence failed for ${status}`);
        }
      } catch (error) {
        const local = transitionJob(entry.record, status, patch);
        if (local.ok) {
          entry.record = putRecord(local.record);
          handle.pendingTerminal = { status, exitCode: exit.exitCode, at };
        }
        warn(`bash job ${jobId} terminal state persistence failed for ${status}: ${String(error)}`);
      }
    }
    ensurePolling();

    const { stop } = await handle.spawned.drainedPromise;
    if (handle.owner !== mine) return entry.record;
    try {
      if (handle.pendingTerminal) {
        try {
          const stored = await applyTransition(jobId, handle.pendingTerminal.status, {
            at: handle.pendingTerminal.at,
            exitCode: handle.pendingTerminal.exitCode,
            logBytes: handle.written,
            outputTruncated: handle.truncated,
          });
          if (stored) handle.pendingTerminal = undefined;
        } catch (error) {
          warn(`bash job ${jobId} terminal state lost on disk, recover() will reconcile: ${String(error)}`);
        }
      }
      if (stop === "capped") {
        const marker = formatDrainCapNotice();
        pushWrite(handle, Buffer.from(handle.atLineStart ? marker.slice(1) : marker, "utf8"));
        handle.truncated = true;
      }
      appendLogFooter(entry, handle, entry.record.status, exit.exitCode, at);
      await handle.flush.catch(() => undefined);
      handle.closed = true;
      await new Promise<void>((resolve) => {
        let settled = false;
        let timer: TimerHandle | undefined;
        const done = (): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clock.clearTimer(timer);
          handle.stream.removeListener("error", done);
          resolve();
        };
        handle.stream.once("error", done);
        handle.stream.end(done);
        timer = clock.setTimer(5_000, done);
      });
      await applyPatch(jobId, (current) => ({
        ...current,
        ...(isTerminalJobStatus(entry.record.status)
          ? {
              status: entry.record.status,
              ...(entry.record.endedAt === undefined ? {} : { endedAt: entry.record.endedAt }),
              exitCode: entry.record.exitCode,
              ...(entry.record.backgroundedAt === undefined ? {} : { backgroundedAt: entry.record.backgroundedAt }),
            }
          : {}),
        logBytes: handle.written,
        outputTruncated: handle.truncated,
      }));
    } catch (error) {
      warn(`bash job ${jobId} finalization failed: ${String(error)}`);
    }
    ensurePolling();
    if (handle.adopted) void tick();
    return entry.record;
  }

  // ── reserve / create (§3.6, R12) ──────────────────────────────────────────

  /** §2.4 R12: the persisting-stage cancellation/failure landing — no disk await. */
  function killReserveNoProcess(jobId: JobId, entry: Entry, reasonText: string): StartedResult {
    entry.stage = undefined;
    const at = clock.now();
    if (!isTerminalJobStatus(entry.record.status)) {
      const local = transitionJob(entry.record, "killed", { at, exitCode: null });
      if (local.ok) {
        entry.record = putRecord(local.record);
        settleWaiters(entry);
      }
      void store
        .update(jobId, (current) => {
          const result = transitionJob(current, "killed", { at, exitCode: null });
          return result.ok ? result.record : undefined;
        })
        .catch((error) => warn(`bash job ${jobId} killed-state persistence error (ignored): ${String(error)}`));
    }
    return { ok: false, error: new Error(reasonText) };
  }

  /** §2.4 R12: the save-timeout/save-error landing — no disk await either. */
  function failReserveSync(jobId: JobId, entry: Entry, message: string): StartedResult {
    entry.stage = undefined;
    const at = clock.now();
    if (!isTerminalJobStatus(entry.record.status)) {
      const local = transitionJob(entry.record, "failed", { at, exitCode: null, finalText: message });
      if (local.ok) {
        entry.record = putRecord(local.record);
        settleWaiters(entry);
      }
      void store
        .update(jobId, (current) => {
          const result = transitionJob(current, "failed", { at, exitCode: null, finalText: message });
          return result.ok ? result.record : undefined;
        })
        .catch((error) => warn(`bash job ${jobId} failed-state persistence error (ignored): ${String(error)}`));
    }
    return { ok: false, error: new Error(message) };
  }

  /**
   * §2.4 R12 / §3.6: the async body behind `reserve()`. Never rejects — every
   * exit path resolves a `StartedResult` (the outer `.catch` in `reserve()`
   * is a pure defensive backstop, this function is written to not need it).
   */
  async function runReserveFlow(jobId: JobId, entry: Entry, init: CreateJobInit): Promise<StartedResult> {
    const saveOutcome = await raceOutcome(store.save(entry.record), STAGE_PERSIST_TIMEOUT_MS);
    if (isTerminalJobStatus(entry.record.status)) {
      // `cancelReserve` already finalized this while the save was racing.
      return { ok: false, error: new Error(`bash job ${jobId} was cancelled before it started`) };
    }
    if (saveOutcome.kind === "timeout") {
      return failReserveSync(
        jobId,
        entry,
        "bash job store did not persist the staged record within 30s; command not started",
      );
    }
    if (saveOutcome.kind === "error") {
      const message = saveOutcome.error instanceof Error ? saveOutcome.error.message : String(saveOutcome.error);
      return failReserveSync(jobId, entry, message);
    }
    await mkdir(store.dir, { recursive: true, mode: 0o700 }).catch(() => undefined);
    if (entry.cancelled || (options.admit && !options.admit())) {
      return killReserveNoProcess(jobId, entry, `bash job ${jobId} was cancelled before it started`);
    }

    entry.stage = "spawning";
    let spawned: SpawnedJob;
    try {
      spawned = await processPort.spawnJob(init.command, init.cwd, init.env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.stage = undefined;
      // Same fire-and-forget persistence discipline as the other failure exits
      // (R1): the process never existed, so there is nothing time-sensitive
      // left to protect by awaiting the write.
      const at = clock.now();
      if (!isTerminalJobStatus(entry.record.status)) {
        const local = transitionJob(entry.record, "failed", { at, exitCode: null, finalText: message });
        if (local.ok) {
          entry.record = putRecord(local.record);
          settleWaiters(entry);
        }
        void applyTransition(jobId, "failed", { at, exitCode: null, finalText: message }).catch((e) =>
          warn(`bash job ${jobId} failed-state persistence error (ignored): ${String(e)}`),
        );
      }
      return { ok: false, error: error instanceof Error ? error : new Error(message) };
    }

    // R12: the pid is claimed into the entry *before* any cancellation
    // decision, in the same synchronous section — there is no window where a
    // returned pid belongs to nobody.
    const logPath = store.logPath(jobId);
    const handle: LocalHandle = {
      spawned,
      stream: createWriteStream(logPath, { flags: "a", mode: 0o600 }),
      flush: Promise.resolve(),
      written: 0,
      truncated: false,
      closed: false,
      adopted: false,
      atLineStart: true,
      footerWritten: false,
      owner: myToken,
      pendingTerminal: undefined,
    };
    entry.local = handle;
    entry.stage = undefined;
    const cancelledAfterSpawn = Boolean(entry.cancelled);
    handle.stream.on("error", (error) => {
      warn(`bash job ${jobId} log write failed: ${String(error)}`);
    });
    const onChunk = (chunk: Buffer | string): void => teeChunk(entry, handle, chunk, init.onData);
    spawned.stdout.on("data", onChunk);
    spawned.stderr.on("data", onChunk);

    if (cancelledAfterSpawn) {
      handle.termination = "killed";
      // Fire-and-forget (R12: "不 await"); the rejection is absorbed here so a
      // transport hiccup on the kill signal never becomes an unhandled
      // rejection — the exit event still settles the job's terminal state.
      void processPort
        .killJobTree(spawned.pid, { graceMs: 0 })
        .catch((error) => warn(`bash job ${jobId} cancel-kill failed: ${String(error)}`));
      void finalizeLocal(jobId, entry, handle).catch((error) => {
        warn(`bash job ${jobId} finalization failed: ${String(error)}`);
        return entry.record;
      });
      ensurePolling();
      return { ok: false, error: new Error(`bash job ${jobId} was cancelled before it could be handed off`) };
    }

    const at = clock.now();
    const localRunning = transitionJob(entry.record, "running", {
      at,
      pid: spawned.pid,
      pgid: spawned.pgid,
      ...(spawned.procStartTime !== undefined ? { procStartTime: spawned.procStartTime } : {}),
    });
    if (localRunning.ok) entry.record = putRecord(localRunning.record);
    // Fire-and-forget (R1): the tool call must not wait on this disk write —
    // it is enqueued on the store's chain and callers reading through the
    // same store observe it in order regardless.
    void applyTransition(jobId, "running", {
      at,
      pid: spawned.pid,
      pgid: spawned.pgid,
      ...(spawned.procStartTime !== undefined ? { procStartTime: spawned.procStartTime } : {}),
    }).catch((error) => warn(`bash job ${jobId} running-state persistence error (ignored): ${String(error)}`));

    if (init.timeoutMs !== undefined && init.timeoutMs > 0) {
      const deadline = createJobDeadline(init.timeoutMs, deadlinePolicy, entry.record.spawnedAt ?? at);
      entry.record = { ...entry.record, deadline };
      persistDeadline(jobId, deadline);
      rearm(jobId);
    }

    const record = entry.record;
    const exit = finalizeLocal(jobId, entry, handle).catch((error) => {
      warn(`bash job ${jobId} finalization failed: ${String(error)}`);
      return entry.record;
    });
    ensurePolling();
    // Fire-and-forget (throttled): keeps a days-long session from accreting
    // job files, without adding a timer or delaying the spawn path.
    void maybeSweep();

    return { ok: true, job: { jobId, record, pid: spawned.pid, pgid: spawned.pgid, logPath, exit } };
  }

  function reserve(init: CreateJobInit): ReservedJob {
    if (disposed) throw new Error("stale bash job manager");
    if (options.admit && !options.admit()) throw new Error("run is ending; no new bash jobs");
    const jobId = newJobId((candidate) => entries.has(candidate));
    localJobs.add(jobId);
    const logPath = store.logPath(jobId);
    const staged = createJobRecord({
      jobId,
      command: init.command,
      cwd: init.cwd,
      sessionId: options.sessionId,
      hostPid,
      logPath,
      createdAt: clock.now(),
    });
    const stagedWithOwner = options.owner !== undefined ? { ...staged, owner: options.owner } : staged;
    const entry = ensureEntry(stagedWithOwner);
    entry.cancelled = false;
    entry.stage = "persisting";

    const started = runReserveFlow(jobId, entry, init).catch((error): StartedResult => {
      // Defensive-only: `runReserveFlow` is written to never reject; absorb
      // anyway so `started` truly never rejects (§3.6's one hard guarantee).
      warn(`bash job ${jobId} reserve flow threw unexpectedly (absorbed): ${String(error)}`);
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    });
    return { jobId, logPath, started };
  }

  function cancelReserve(jobId: JobId): void {
    const entry = entries.get(jobId);
    if (!entry) return;
    entry.cancelled = true;
    if (entry.stage === "persisting") {
      killReserveNoProcess(jobId, entry, `bash job ${jobId} was cancelled before it started`);
      return;
    }
    if (entry.stage === "spawning") return; // resolved synchronously once spawnJob settles (R12)
    if (!isTerminalJobStatus(entry.record.status)) {
      void kill(jobId, {}).catch((error) => warn(`bash job ${jobId} cancelReserve kill failed: ${String(error)}`));
    }
  }

  /**
   * Deliberately independent of `reserve()`/`runReserveFlow` (not a thin
   * wrapper) — today's `bash-tool.ts` (P4, not yet migrated) calls `create()`
   * directly and its existing golden/timing tests (`tests/tools/bash-tool.
   * test.ts`) assert on the exact number of microtask ticks between spawn
   * and an early abort. `reserve()`'s save-race (R12) inherently adds a tick
   * versus a bare `await store.save(...)`; keeping `create()`'s body
   * byte-for-byte the pre-P3 implementation avoids leaking that shift into
   * a package this one must not touch. P4 is expected to migrate the tool
   * layer onto `reserve()` directly (per plan §3.6) and retire this path.
   */
  async function create(init: CreateJobInit): Promise<CreatedJob> {
    const jobId = newJobId((candidate) => entries.has(candidate));
    localJobs.add(jobId);
    const logPath = store.logPath(jobId);
    const baseRecord = createJobRecord({
      jobId,
      command: init.command,
      cwd: init.cwd,
      sessionId: options.sessionId,
      hostPid,
      logPath,
      createdAt: clock.now(),
    });
    const staged = putRecord(options.owner !== undefined ? { ...baseRecord, owner: options.owner } : baseRecord);
    // Persist before spawning: a crash between the two leaves a `staged`
    // record that `recover()` can honestly report as lost.
    await store.save(staged);
    await mkdir(store.dir, { recursive: true, mode: 0o700 }).catch(() => undefined);

    let spawned: SpawnedJob;
    try {
      spawned = await processPort.spawnJob(init.command, init.cwd, init.env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await applyTransition(jobId, "failed", { at: clock.now(), exitCode: null, finalText: message });
      throw error instanceof Error ? error : new Error(message);
    }

    const entry = ensureEntry(staged);
    const handle: LocalHandle = {
      spawned,
      stream: createWriteStream(logPath, { flags: "a", mode: 0o600 }),
      flush: Promise.resolve(),
      written: 0,
      truncated: false,
      closed: false,
      adopted: false,
      atLineStart: true,
      footerWritten: false,
      owner: myToken,
      pendingTerminal: undefined,
    };
    handle.stream.on("error", (error) => {
      warn(`bash job ${jobId} log write failed: ${String(error)}`);
    });
    entry.local = handle;

    const onChunk = (chunk: Buffer | string): void => teeChunk(entry, handle, chunk, init.onData);
    spawned.stdout.on("data", onChunk);
    spawned.stderr.on("data", onChunk);

    const running = await applyTransition(jobId, "running", {
      at: clock.now(),
      pid: spawned.pid,
      pgid: spawned.pgid,
      ...(spawned.procStartTime !== undefined ? { procStartTime: spawned.procStartTime } : {}),
    });
    let record = running ?? entry.record;
    if (init.timeoutMs !== undefined && init.timeoutMs > 0) {
      const deadline = createJobDeadline(init.timeoutMs, deadlinePolicy, record.spawnedAt ?? clock.now());
      entry.record = { ...entry.record, deadline };
      record = entry.record;
      persistDeadline(jobId, deadline);
      rearm(jobId);
    }

    const exit = finalizeLocal(jobId, entry, handle).catch((error) => {
      warn(`bash job ${jobId} finalization failed: ${String(error)}`);
      return entry.record;
    });
    ensurePolling();

    // Fire-and-forget (throttled): keeps a days-long session from accreting
    // job files, without adding a timer or delaying the spawn path.
    void maybeSweep();

    return { jobId, record, pid: spawned.pid, pgid: spawned.pgid, logPath, exit };
  }

  async function extend(jobId: JobId, extendMs: Millis, reason?: string): Promise<ExtendJobOutcome> {
    if (disposed) throw new Error("stale bash job manager");
    const entry = entries.get(jobId);
    if (!entry) return { ok: false, reason: "not_found" };
    const now = clock.now();
    const result = applyJobExtension(entry.record, extendMs, now, reason);
    if (!result.ok) return { ok: false, reason: result.reason };
    entry.record = putRecord(result.record);
    rearm(jobId);
    try {
      options.onDeadline?.(entry.record, "extended");
    } catch (error) {
      warn(`bash job ${jobId} onDeadline(extended) threw (ignored): ${String(error)}`);
    }
    const nextDeadline = entry.record.deadline;
    const persistPromise =
      nextDeadline === undefined
        ? Promise.resolve()
        : store.upsert(jobId, (current) => {
            if (!current) return undefined;
            if (current.deadline !== undefined && current.deadline.seq >= nextDeadline.seq) return undefined;
            return { ...current, deadline: nextDeadline };
          });
    const persisted = await raceSettled(persistPromise, EXTEND_PERSIST_TIMEOUT_MS);
    return { ok: true, record: entry.record, persistPending: !persisted };
  }

  function markBackgroundedSync(jobId: JobId): void {
    const entry = entries.get(jobId);
    if (!entry || entry.record.backgroundedAt !== undefined) return;
    const at = clock.now();
    entry.record = { ...entry.record, backgroundedAt: at };
    void store
      .update(jobId, (current) =>
        current.backgroundedAt === undefined ? { ...current, backgroundedAt: at } : undefined,
      )
      .catch((error) => warn(`bash job ${jobId} backgroundedAt persistence error (ignored): ${String(error)}`));
    ensurePolling();
  }

  async function relocateLog(jobId: JobId, newLogPath: string): Promise<void> {
    const entry = entries.get(jobId);
    if (entry) entry.record = { ...entry.record, logPath: newLogPath };
    // §2.5 step 3: the crash-handoff job may not have a JSON record on disk
    // at this (possibly brand-new) directory yet — `store.upsert` only writes
    // when `mutate` returns non-undefined, and a plain `current ?? undefined`
    // check would silently drop the write forever. Seed it from the
    // already-adopted in-memory record (`adoptLocalJobs` runs first, §2.5
    // step 2) so the first relocation also materializes the record, not just
    // repoints an existing one.
    const seed = entry?.record;
    await store.upsert(jobId, (current) => {
      if (current) return { ...current, logPath: newLogPath };
      if (seed) return { ...seed, logPath: newLogPath };
      return undefined;
    });
  }

  async function waitAllExit(
    jobIds: readonly JobId[],
    timeoutMs: Millis,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<void> {
    await Promise.all(jobIds.map((jobId) => waitExit(jobId, timeoutMs, opts)));
  }

  function waitExit(
    jobId: JobId,
    timeoutMs: Millis,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<JobRecord | undefined> {
    const entry = entries.get(jobId);
    if (!entry) return Promise.resolve(undefined);
    if (isTerminalJobStatus(entry.record.status)) return Promise.resolve(entry.record);
    if (opts?.signal?.aborted) return Promise.resolve(entry.record);
    return new Promise<JobRecord | undefined>((resolve) => {
      const onAbort = () => {
        entry.waiters.delete(waiter);
        clock.clearTimer(waiter.timer);
        settle(entry.record);
      };
      // Every settlement path goes through settle(), which also drops the
      // abort listener so it cannot accumulate on the tool-call signal.
      const settle = (record: JobRecord | undefined) => {
        opts?.signal?.removeEventListener("abort", onAbort);
        resolve(record);
      };
      const waiter: Waiter = {
        resolve: settle,
        timer: clock.setTimer(Math.max(0, timeoutMs), () => {
          entry.waiters.delete(waiter);
          // Z1: a wait never fails — the caller gets the current record.
          settle(entry.record);
        }),
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      entry.waiters.add(waiter);
    });
  }

  // ── resolution (§4.3, format aligned with service/resolve-target.ts) ──────

  function candidateLine(record: JobRecord, now: Millis): string {
    const ageMinutes = Math.floor(Math.max(0, now - (record.endedAt ?? record.createdAt)) / 60_000);
    return `${record.jobId} → $ ${previewCommand(record.command, 40)} (${record.status}, ${ageMinutes}m ago)`;
  }

  function formatCandidates(): string {
    const now = clock.now();
    const lines = [...entries.values()]
      .map((entry) => entry.record)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_CANDIDATES)
      .map((record) => candidateLine(record, now));
    return lines.length > 0 ? lines.join(", ") : "none";
  }

  function resolve(handle: string): JobId {
    const trimmed = handle.trim();
    if (entries.has(trimmed)) return trimmed;
    // An empty handle is "not found", never "ambiguous": every id starts with it.
    const matches = trimmed.length > 0 ? [...entries.keys()].filter((jobId) => jobId.startsWith(trimmed)) : [];
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only !== undefined) return only;
    const label = previewCommand(trimmed, 40);
    throw new Error(
      matches.length > 1
        ? `ambiguous bash job target: ${label}. Candidates: [${formatCandidates()}]`
        : `bash job not found: ${label}. Candidates: [${formatCandidates()}]`,
    );
  }

  // ── output reads (§4.3) ──────────────────────────────────────────────────

  async function readOutput(jobId: JobId, readOptions: ReadOutputOptions = {}): Promise<JobOutputRead> {
    const entry = entries.get(jobId);
    const record = entry?.record ?? (await store.load(jobId));
    if (!record) throw new Error(`bash job not found: ${jobId}`);
    // A local job may have unflushed writes in the chain; waiting makes reads
    // deterministic ("everything the process has emitted so far").
    if (entry?.local) await entry.local.flush.catch(() => undefined);

    const size = await fileSize(record.logPath);
    const cap = normalizePositive(readOptions.maxBytes, maxReadBytes);
    const startOffset = clampOffset(readOptions.offset ?? record.readCursor, size);
    const length = Math.min(size - startOffset, cap);
    let content = "";
    let bytesRead = 0;
    if (length > 0) {
      const file = await open(record.logPath, "r");
      try {
        const buffer = Buffer.alloc(length);
        const result = await file.read(buffer, 0, length, startOffset);
        bytesRead = result.bytesRead;
        content = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await file.close();
      }
    }
    const nextOffset = startOffset + bytesRead;
    let current = record;
    if (readOptions.advanceCursor !== false && nextOffset > record.readCursor) {
      const stored = await store.setReadCursor(jobId, nextOffset);
      if (stored) current = putRecord(stored);
    }
    return {
      jobId,
      content,
      startOffset,
      nextOffset,
      logBytes: size,
      state: current.status,
      exitCode: current.exitCode,
      logTruncated: current.outputTruncated,
      logClosed: entry?.local ? entry.local.closed : true,
      ...(current.finalText !== undefined ? { finalText: current.finalText } : {}),
      record: current,
    };
  }

  // ── kill (§3.3 ladder, idempotent, identity-guarded) ─────────────────────

  async function kill(
    jobId: JobId,
    killOptions: { graceMs?: Millis } = {},
    guard?: () => boolean,
  ): Promise<KillJobResult> {
    const entry = entries.get(jobId);
    const record = entry?.record ?? (await store.load(jobId));
    if (!record) throw new Error(`bash job not found: ${jobId}`);
    if (isTerminalJobStatus(record.status)) {
      const openLocal = entry?.local && !entry.local.closed;
      if (!openLocal) {
        return { jobId, outcome: "already-terminal", alreadyTerminal: true, record };
      }
      const pid = record.pid;
      if (pid === undefined) {
        return {
          jobId,
          outcome: "already-dead",
          alreadyTerminal: true,
          reason: `job already exited with code ${record.exitCode ?? "unknown"}; surviving pipe holders could not be signalled safely`,
          record,
        };
      }
      const outcome = await processPort.killJobTree(pid, {
        ...(killOptions.graceMs !== undefined ? { graceMs: killOptions.graceMs } : {}),
        ...(record.procStartTime !== undefined ? { expectedProcStartTime: record.procStartTime } : {}),
      });
      return {
        jobId,
        outcome,
        alreadyTerminal: true,
        reason:
          outcome === "refused"
            ? `job already exited with code ${record.exitCode ?? "unknown"}; surviving pipe holders could not be signalled safely`
            : `job already exited with code ${record.exitCode ?? "unknown"}; surviving pipe holders were terminated`,
        record,
      };
    }
    const pid = record.pid;
    if (pid === undefined) {
      // `staged`: no process to signal yet. Label it honestly and stop.
      const stored = await applyTransition(jobId, "killed", { at: clock.now(), exitCode: null }, guard);
      return { jobId, outcome: "already-dead", alreadyTerminal: false, record: stored ?? record };
    }

    // §2.4/§3.6 (P3+P4 verifier round 5): an in-flight kill for this
    // (non-terminal) job is reused rather than triggering a second signal —
    // concurrent triggers (an abort's `cancelReserve` racing a seal/killAll
    // fan-out, or two independent `kill()` calls) must send at most one
    // signal per termination attempt. `killNonTerminal`'s own synchronous
    // prefix (through the identity check and the actual signal-send) runs
    // to completion — or to its first genuine `await` — before this function
    // ever yields, so the latch below is set before any concurrent caller
    // gets a chance to run; §2.4/§3.6.
    if (entry?.killInFlight) return entry.killInFlight;
    const attempt = killNonTerminal(jobId, entry, record, pid, killOptions, guard);
    if (entry) {
      entry.killInFlight = attempt;
      // `.finally()` derives a *new* promise that mirrors `attempt`'s eventual
      // rejection — its own rejection must be swallowed here (the caller's
      // own handling of `attempt`/`kill()`'s return value, e.g.
      // `cancelReserve`'s `.catch`, is unaffected; this is purely cleanup
      // bookkeeping, not a consumer of the result).
      void attempt
        .finally(() => {
          if (entry.killInFlight === attempt) entry.killInFlight = undefined;
        })
        .catch(() => undefined);
    }
    return attempt;
  }

  /**
   * The non-terminal half of `kill()` (identity check → signal → outcome),
   * factored out so `kill()` can latch it as a single in-flight attempt
   * (§2.4/§3.6). A rejection here (e.g. `processPort.killJobTree` throwing)
   * propagates through the shared `entry.killInFlight` promise to every
   * concurrent caller and clears the latch once settled — a *later*,
   * non-concurrent `kill()` call is free to start a fresh attempt (SIGTERM
   * is idempotent; refusing to ever retry a failed kill would leave a job
   * unkillable after one transport hiccup, which cancelReserve's own
   * absorbed-rejection handling already treats as recoverable).
   */
  async function killNonTerminal(
    jobId: JobId,
    entry: Entry | undefined,
    record: JobRecord,
    pid: number,
    killOptions: { graceMs?: Millis },
    guard?: () => boolean,
  ): Promise<KillJobResult> {
    const grace = killOptions.graceMs ?? killGraceMs;
    const local = entry?.local;
    if (!local) {
      // Adopted job: prove ownership before signalling anything (I-c).
      const ownership = processPort.checkPidOwnership(record);
      if (ownership === "unsafe") return refuseAsOrphan(jobId, record, guard);
      if (ownership === "dead") {
        const stored = await applyTransition(jobId, "exited_unknown", { at: clock.now(), exitCode: null }, guard);
        if (!guard?.()) ensurePolling();
        return { jobId, outcome: "already-dead", alreadyTerminal: false, record: stored ?? record };
      }
    }

    // §2.5 step 4: the identity check above is done (a sync read), but
    // `killJobTree` is a real signal-send — recover()'s abort checkpoint must
    // be re-read immediately before it, not just before/after the identity
    // check, so a scan cancelled in this exact window never signals a
    // process it only meant to *look at*.
    if (guard?.()) {
      return {
        jobId,
        outcome: "refused",
        alreadyTerminal: false,
        reason: "bash job recovery cancelled before signalling",
        record,
      };
    }
    if (local) local.termination = "killed";
    const outcome = await processPort.killJobTree(pid, {
      ...(grace !== undefined ? { graceMs: grace } : {}),
      ...(record.procStartTime !== undefined ? { expectedProcStartTime: record.procStartTime } : {}),
    });
    if (outcome === "refused") {
      if (local) delete local.termination;
      return refuseAsOrphan(jobId, record, guard);
    }
    if (local) {
      // The `exit` event is authoritative for a job we own: it carries the
      // real exit code and flushes the log tail. `killed` is already pinned.
      ensurePolling();
      return { jobId, outcome, alreadyTerminal: false, record: entry?.record ?? record };
    }
    const stored = await applyTransition(jobId, "killed", { at: clock.now(), exitCode: null }, guard);
    if (!guard?.()) ensurePolling();
    return { jobId, outcome, alreadyTerminal: false, record: stored ?? record };
  }

  async function refuseAsOrphan(jobId: JobId, record: JobRecord, guard?: () => boolean): Promise<KillJobResult> {
    const stored = await applyTransition(jobId, "orphaned", { at: clock.now(), exitCode: null }, guard);
    return {
      jobId,
      outcome: "refused",
      alreadyTerminal: false,
      reason:
        `job ${jobId} cannot be safely killed: its pid ownership could not be verified ` +
        `(possible pid reuse), so it was marked orphaned instead of signalled`,
      record: stored ?? record,
    };
  }

  // ── recover (§3.6) ───────────────────────────────────────────────────────

  async function recover(signal?: AbortSignal): Promise<RecoverSummary> {
    const aborted = (): boolean => disposed || (signal?.aborted ?? false);
    const emptySummary = (): RecoverSummary => ({
      adopted: [],
      exitedUnknown: [],
      orphaned: [],
      lostStaged: [],
      foreign: [],
      pendingNotices: [],
      pruned: [],
      prunedFiles: [],
      subagentKilled: [],
      partial: true,
    });
    if (aborted()) return emptySummary();
    const pruned = await store.pruneExpired(sweepArgs());
    lastSweepAt = clock.now();
    if (aborted()) return { ...emptySummary(), pruned: pruned.jobs, prunedFiles: pruned.files };
    const records = await store.loadAll();
    const adopted: JobId[] = [];
    const exitedUnknown: JobId[] = [];
    const orphaned: JobId[] = [];
    const lostStaged: JobId[] = [];
    const foreign: JobId[] = [];
    // §3.9: crash-recovered jobs owned by a subagent's own bash tool are
    // actively (identity-checked) killed rather than merely adopted — there
    // is no subagent left alive to manage them.
    const subagentKilled: JobId[] = [];
    let subagentTotal = 0;
    let subagentOrphanedCount = 0;
    let partial = false;

    for (const record of records) {
      if (aborted()) {
        partial = true;
        break;
      }
      // Our own in-flight/settled job: `create()`/`reserve()` owns it end to end.
      if (localJobs.has(record.jobId)) continue;
      if (isTerminalJobStatus(record.status)) {
        putRecord(record);
        continue;
      }
      putRecord(record);
      if (record.status === "staged") {
        // The spawn outcome died with the previous process; there is no pid to
        // probe, so `failed` is the only honest label (§3.9 row 1: same for
        // both owner kinds).
        const stored = await applyTransition(
          record.jobId,
          "failed",
          {
            at: clock.now(),
            exitCode: null,
            finalText: "pi exited before this bash job's spawn was confirmed; the process state is unknown.",
          },
          aborted,
        );
        if (aborted()) {
          partial = true;
          break;
        }
        if (stored) lostStaged.push(record.jobId);
        continue;
      }
      // Another *live* pi process still owns this job: hands off entirely
      // (regardless of owner — a safety floor, not a §3.9 concern).
      if (record.hostPid > 0 && record.hostPid !== hostPid && processPort.probePid(record.hostPid)) {
        foreign.push(record.jobId);
        continue;
      }
      if (record.owner === "subagent") {
        // §3.9: `kill()`'s no-local-handle branch already does the identity
        // check (unsafe/dead/alive) and produces exactly the four outcomes
        // this table wants — alive+signalled → killed, alive+refused →
        // orphaned, dead → exited_unknown, unsafe → orphaned.
        subagentTotal++;
        const result = await kill(record.jobId, {}, aborted).catch((error) => {
          warn(`bash job ${record.jobId} crash-recovery kill failed: ${String(error)}`);
          return undefined;
        });
        if (aborted()) {
          partial = true;
          break;
        }
        const finalStatus = result?.record.status ?? entries.get(record.jobId)?.record.status;
        if (finalStatus === "killed") subagentKilled.push(record.jobId);
        else if (finalStatus === "orphaned") {
          orphaned.push(record.jobId);
          subagentOrphanedCount++;
        } else if (finalStatus === "exited_unknown") exitedUnknown.push(record.jobId);
        continue;
      }
      const ownership = processPort.checkPidOwnership(record);
      if (ownership === "alive") {
        // An adopted job is ownerless by definition — nobody is waiting on its
        // tool call anymore, so it becomes notification-eligible (§5).
        await applyPatch(
          record.jobId,
          (current) => (current.backgroundedAt === undefined ? { ...current, backgroundedAt: clock.now() } : undefined),
          aborted,
        );
        if (aborted()) {
          partial = true;
          break;
        }
        adopted.push(record.jobId);
        continue;
      }
      if (ownership === "dead") {
        const stored = await applyTransition(
          record.jobId,
          "exited_unknown",
          { at: clock.now(), exitCode: null },
          aborted,
        );
        if (aborted()) {
          partial = true;
          break;
        }
        if (stored) exitedUnknown.push(record.jobId);
        continue;
      }
      // "unsafe" — mark and display only; never kill, never announce (§3.6).
      const stored = await applyTransition(record.jobId, "orphaned", { at: clock.now(), exitCode: null }, aborted);
      if (aborted()) {
        partial = true;
        break;
      }
      if (stored) orphaned.push(record.jobId);
    }

    if (subagentTotal > 0) {
      warn(
        `${subagentTotal} subagent bash jobs from a crashed pi were reaped (${subagentKilled.length} killed, ${subagentOrphanedCount} orphaned — not signalled, pid unverifiable)`,
      );
    }

    const pendingNotices = [...entries.values()]
      .map((entry) => entry.record)
      .filter((record) => shouldNotifyJob(record))
      .map((record) => record.jobId);
    // §2.5 step 4: a cancelled scan rearms nothing — the poller (and any
    // notice it would deliver) belongs to a later, uncancelled pass.
    if (!partial) ensurePolling();
    return {
      adopted,
      exitedUnknown,
      orphaned,
      lostStaged,
      foreign,
      pendingNotices,
      pruned: pruned.jobs,
      prunedFiles: pruned.files,
      subagentKilled,
      partial,
    };
  }

  function exportLocalJobs(): LocalJobHandoff[] {
    const handoffs: LocalJobHandoff[] = [];
    for (const [jobId, entry] of entries) {
      if (!entry.local || entry.local.closed || entry.record.backgroundedAt === undefined) continue;
      entry.local.owner = {};
      // The next stack's `adoptLocalJobs` rearms a fresh deadline timer
      // (§2.5 step 2) off the handed-off record; a timer left running here
      // would otherwise dangle forever (the entry is about to be deleted, so
      // `dispose()`'s own sweep can no longer reach it to clear it).
      if (entry.deadlineTimer !== undefined) {
        clock.clearTimer(entry.deadlineTimer);
        entry.deadlineTimer = undefined;
      }
      handoffs.push({
        jobId,
        record: entry.record,
        handle: entry.local,
        ...(entry.killInFlight !== undefined ? { killInFlight: entry.killInFlight } : {}),
      });
      entries.delete(jobId);
      localJobs.delete(jobId);
    }
    return handoffs;
  }

  function hasOpenLocalHandle(jobId: JobId): boolean {
    const local = entries.get(jobId)?.local;
    return local !== undefined && !local.closed;
  }
  function adoptLocalJobs(handoffs: LocalJobHandoff[], opts?: { sessionId?: string }): void {
    for (const handoff of handoffs) {
      const record =
        opts?.sessionId !== undefined && opts.sessionId !== handoff.record.sessionId
          ? { ...handoff.record, sessionId: opts.sessionId }
          : handoff.record;
      const entry = ensureEntry(record);
      entry.local = handoff.handle;
      handoff.handle.owner = myToken;
      handoff.handle.adopted = true;
      localJobs.add(handoff.jobId);
      // §2.4/§3.6 (P3+P4 verifier round 6): carry the exporting manager's
      // in-flight kill across the handoff — a kill() call on the new
      // manager for this job must reuse the same promise, not send a second
      // signal for a kill already under way. The identity check in the
      // cleanup guards against clearing a *newer* lock: if this entry's own
      // `kill()` starts (and latches) a fresh attempt before the carried-over
      // one settles, `entry.killInFlight` no longer points at `carried` by
      // the time it settles, so the newer lock is left alone.
      const carried = handoff.killInFlight;
      if (carried !== undefined) {
        entry.killInFlight = carried;
        void carried
          .finally(() => {
            if (entry.killInFlight === carried) entry.killInFlight = undefined;
          })
          .catch(() => undefined);
      }
      void finalizeLocal(handoff.jobId, entry, handoff.handle).catch((error) => {
        warn(`bash job ${handoff.jobId} finalization failed after handoff: ${String(error)}`);
      });
      // §2.5 step 2: rearm purely off the handed-off in-memory record — no I/O,
      // so timer recovery never depends on a disk read completing.
      if (entry.record.deadline !== undefined) rearm(handoff.jobId);
    }
    ensurePolling();
  }

  // ── public surface ───────────────────────────────────────────────────────

  /** §3.8 — only this host's live, already-handed-off jobs occupy a slot. */
  function backgroundJobCount(): number {
    let count = 0;
    for (const entry of entries.values()) {
      const record = entry.record;
      if (record.status === "running" && record.backgroundedAt !== undefined && record.hostPid === hostPid) count++;
    }
    return count;
  }

  return {
    dir: store.dir,
    maxBackgroundJobs,
    recover,
    create,
    reserve,
    cancelReserve,
    resolve,
    readOutput,
    kill,
    extend,
    waitAllExit,
    markBackgroundedSync,
    relocateLog,

    get(jobId) {
      return entries.get(jobId)?.record;
    },

    async load(jobId) {
      const stored = await store.load(jobId);
      return stored ? putRecord(stored) : entries.get(jobId)?.record;
    },

    list() {
      return [...entries.values()].map((entry) => entry.record).sort((a, b) => a.createdAt - b.createdAt);
    },

    markBackgrounded(jobId) {
      const at = clock.now();
      return applyPatch(jobId, (current) =>
        current.backgroundedAt === undefined ? { ...current, backgroundedAt: at } : undefined,
      ).then((record) => {
        ensurePolling();
        return record;
      });
    },

    setFinalText(jobId, text) {
      // Not a transition: the inner tool's text often arrives just after the
      // exit event, and terminal records must still accept it.
      return applyPatch(jobId, (current) => ({ ...current, finalText: truncateFinalText(text) }));
    },

    noteTermination(jobId, reason) {
      const local = entries.get(jobId)?.local;
      if (local) local.termination = reason;
    },

    waitExit,

    backgroundJobCount,

    hasBackgroundCapacity() {
      return backgroundJobCount() < maxBackgroundJobs;
    },

    exportLocalJobs,
    hasOpenLocalHandle,
    adoptLocalJobs,
    drain() {
      return new Promise<void>((resolve) => {
        // The store intentionally exposes no queue; a no-op update is the
        // smallest barrier that is serialized after all prior writes.
        void store.loadAll().then(
          () => resolve(),
          () => resolve(),
        );
      });
    },

    dispose() {
      disposed = true;
      if (pollTimer !== undefined) {
        clock.clearTimer(pollTimer);
        pollTimer = undefined;
      }
      // R8: no stray deadline timer keeps firing (into a no-op, since
      // `rearm`/`killForDeadline` both bail on `disposed`) after dispose.
      for (const entry of entries.values()) {
        if (entry.deadlineTimer !== undefined) {
          clock.clearTimer(entry.deadlineTimer);
          entry.deadlineTimer = undefined;
        }
      }
      // Waiters must not outlive the manager; hand them the last known record.
      for (const entry of entries.values()) {
        for (const waiter of entry.waiters) {
          clock.clearTimer(waiter.timer);
          waiter.resolve(entry.record);
        }
        entry.waiters.clear();
      }
      // Deliberately *not* done here (§3.7): no process is signalled, and the
      // log streams stay open so an in-flight job keeps capturing output for
      // the next stack to adopt.
    },
  };
}

function normalizePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function clampOffset(value: number, size: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.trunc(value), size);
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
