/**
 * Scheduled tasks — the single-file writer (plan r3 §3.2 S1 / §4.2 / §4.2.1 / §4.7, S1).
 *
 * One `state.json` per session is the ONLY arbiter. Every mutation is
 *     lock → re-read → validate → (synchronous body on a draft) → housekeeping → ONE atomic replace
 * (O_EXCL temp + fsync → rename → dir fsync), `rev + 1`. A crash leaves either the old or the new
 * file, never a mix; stray temps are ignored by readers and reaped by GC.
 *
 * Two transaction forms:
 *   - `transact(body)` — the body sees a fresh draft under the lock (no cron work allowed in it);
 *   - `transactPlanned(plan, apply)` — §4.5's protocol: `plan` runs OUTSIDE the lock on a lock-free
 *     snapshot (all cron work), the lock is taken, the file re-read: if `rev` moved, or the
 *     lock-time clock passed the plan's `validUntil`, the attempt is dropped and re-planned (≤ 3
 *     attempts ⇒ `E_BUSY`); otherwise `apply` runs on the draft.
 *
 * Housekeeping on every write: expired pendingReports (24h, N1) and manualReqs (24h / ≤ 32) are
 * pruned, terminal runs are trimmed to 20 per task (non-terminal never), orphan terminal runs of
 * deleted tasks are recycled, and — only if the serialized file would exceed 256 KiB — a
 * deterministic compaction ladder shrinks UI history (runs, then missedLog; `missedTotal` and
 * `totalAfter` keep reconciliation exact). Still too large ⇒ `E_LIMIT`, nothing written.
 *
 * Also here: the pure ledger ops (run lifecycle with first-terminal-wins, pendingReports
 * add / remove / expire / overflow), corrupt-file quarantine (`repair`, the only `.bak` writer),
 * report-file GC and empty-directory recycling (§4.7).
 */
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { SCHED_STORE_LOCK_FILE, withDirLock, withSessionLock, type LockOpts, type LockOutcome } from "./lock.js";
import {
  closeQuiet,
  fdPath,
  fdRealPath,
  isPlainName,
  openDirAt,
  openDirPathUnchecked,
  openSessionDirAt,
  openStoreRoot,
  resolveStoreRoot,
  SchedFsError,
  sessionDirName,
  type InVaultPredicate,
  type StoreRoot,
} from "./paths.js";
import { listSessionDirs, readSessionState, readStateAt, type SessionStateRead } from "./reader.js";
import type { ProcessIdentity } from "./recovery.js";
import {
  emptyStateFile,
  isTerminalRunState,
  reportIdOf,
  SCHED_REPORT_NAME_RE,
  SCHED_LOCK_FILE,
  SCHED_MANUAL_REQ_TTL_MS,
  SCHED_MAX_SESSION_DIRS,
  SCHED_PENDING_REPORTS_MAX,
  SCHED_REPORT_BYTES_GLOBAL_MAX,
  SCHED_REPORT_BYTES_PER_SESSION_MAX,
  SCHED_REPORT_MAX_AGE_MS,
  SCHED_REPORT_RETENTION_MS,
  SCHED_REPORTS_DIR,
  SCHED_REPORTS_GLOBAL_MAX,
  SCHED_REPORTS_PER_SESSION_MAX,
  SCHED_RUNS_PER_TASK,
  SCHED_STATE_FILE,
  SCHED_STATE_MAX_BYTES,
  type PendingReport,
  type RunRecord,
  type ScheduleRunState,
  type ScheduleStateFile,
} from "./spec.js";

const O_NOFOLLOW: number = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
/** Planned-transaction attempts before `E_BUSY` (§4.5a step 1). */
export const SCHED_TX_PLAN_ATTEMPTS = 3;
/** Wall-vs-monotonic disagreement between plan and lock that voids a plan (clock jump, review M1). */
export const SCHED_PLAN_CLOCK_SKEW_MS = 1_000;
/** A just-written report is never GC'd: it may be about to enter pendingReports (§4.7). */
export const SCHED_REPORT_GC_GRACE_MS = 10 * 60_000;
/** Stray temp files older than this are reaped. */
export const SCHED_TMP_GC_AGE_MS = 60 * 60_000;
/** Empty-directory recycling requires no report newer than this (§4.7). */
export const SCHED_RECYCLE_REPORT_QUIET_MS = 24 * 3_600_000;
export { SCHED_REPORT_NAME_RE } from "./spec.js";

export type WriterErrorCode = "E_BUSY" | "E_DEGRADED" | "E_LIMIT";
export type TxResult<T> =
  | { ok: true; value: T; rev: number; wrote: boolean }
  /** `uncertain` ⇔ the new file was renamed into place but its durability could not be confirmed
   *  (directory fsync failed): the caller must NOT act on the body's result and must NOT blindly
   *  redo it — a later read decides (review M5). */
  | { ok: false; code: WriterErrorCode; detail: string; uncertain?: boolean };
export interface TxBody<T> {
  value: T;
  write: boolean;
}
export interface TxCtx {
  /** Lock-time clock. */
  now: number;
  /** rev of the file the draft was read from (0 = absent). */
  rev: number;
  /** The LOCKED session directory fd (undefined when the directory does not exist yet). */
  dirFd: number | undefined;
}

/** Crash/fault-injection points (tests / fault fixtures only; never wired in production). A hook
 *  may throw (an errno-coded Error simulates that syscall failing) or kill the process. */
export type WriterFaultPoint = "lock-held" | "file-fsync" | "tmp-written" | "renamed" | "dir-fsync";

export interface SessionStoreOpts {
  root: StoreRoot;
  sessionId: string;
  self: ProcessIdentity;
  epoch: string;
  inVault?: InVaultPredicate;
  uid?: number;
  /** Business (wall) clock. */
  now?: () => number;
  /** Monotonic clock (plan/lock consistency, lock deadline). Default `performance.now`. */
  monotonic?: () => number;
  lockTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** `flock` binary (tests). */
  flockBin?: string;
  faults?: (point: WriterFaultPoint) => void;
}

function errCode(err: unknown): string | undefined {
  return err instanceof Error && "code" in err ? String((err as NodeJS.ErrnoException).code) : undefined;
}

function writeAllSync(fd: number, data: Buffer): void {
  let off = 0;
  while (off < data.length) {
    const n = writeSync(fd, data, off, data.length - off);
    if (n <= 0) throw new Error("short write");
    off += n;
  }
}

/** Errors meaning "this filesystem cannot fsync a directory" — the only ones tolerated (review M5). */
const DIR_FSYNC_UNSUPPORTED: ReadonlySet<string> = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/** Thrown when the rename happened but directory durability is unconfirmed. */
export class CommitUncertainError extends Error {
  constructor(readonly code: string) {
    super(`commit uncertain: directory fsync failed (${code})`);
    this.name = "CommitUncertainError";
  }
}

function fsyncDir(dirFd: number, faults?: (p: WriterFaultPoint) => void): void {
  try {
    faults?.("dir-fsync");
    fsyncSync(dirFd);
  } catch (err) {
    const c = errCode(err) ?? "EIO";
    if (DIR_FSYNC_UNSUPPORTED.has(c)) return;
    throw new CommitUncertainError(c);
  }
}

/**
 * Atomically replace `name` under `dirFd` with `data` (0600): O_EXCL temp → write → fsync →
 * rename → directory fsync. Failures before the rename leave the old file (temp removed); a
 * directory-fsync failure after it throws `CommitUncertainError`.
 */
export function atomicWriteAt(dirFd: number, name: string, data: Buffer, faults?: (p: WriterFaultPoint) => void): void {
  if (!isPlainName(name)) throw new SchedFsError("bad-name", "bad file name");
  const tmp = `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(
    fdPath(dirFd, tmp),
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | O_NOFOLLOW,
    0o600,
  );
  try {
    writeAllSync(fd, data);
    faults?.("file-fsync");
    fsyncSync(fd);
    closeSync(fd);
    faults?.("tmp-written");
    renameSync(fdPath(dirFd, tmp), fdPath(dirFd, name));
  } catch (err) {
    closeQuiet(fd);
    try {
      unlinkSync(fdPath(dirFd, tmp));
    } catch {
      /* renamed or already gone */
    }
    throw err;
  }
  faults?.("renamed");
  fsyncDir(dirFd, faults);
}

/**
 * mkdir the store directory (0700) WITHOUT ever creating anything before the location is judged
 * (review M3): the literal path and the canonical path of its longest existing ancestor (plus the
 * remainder) must lie outside every vault; the ancestor is then opened O_NOFOLLOW, its OPENED
 * location re-checked, and each missing component is created anchored on its parent fd and
 * re-opened O_NOFOLLOW (owner/mode checked). Finally the root is pinned (`resolveStoreRoot`).
 */
export function ensureStoreRoot(storeDir: string, opts: { inVault?: InVaultPredicate; uid?: number } = {}): StoreRoot {
  if (typeof storeDir !== "string" || !isAbsolute(storeDir) || storeDir.includes("\0")) {
    throw new SchedFsError("relative", "store dir must be an absolute path");
  }
  const inVault = opts.inVault ?? ((): boolean => false);
  if (inVault(storeDir)) throw new SchedFsError("vault", "store dir lies inside an encrypted vault");
  const parts = storeDir.split("/").filter((p) => p !== "");
  let existing = "/";
  let i = 0;
  for (; i < parts.length; i++) {
    const next = join(existing, parts[i]!);
    try {
      if (!statSync(next).isDirectory()) throw new SchedFsError("not-dir", `${next}: not a directory`);
    } catch (err) {
      if (err instanceof SchedFsError) throw err;
      if (errCode(err) === "ENOENT") break;
      throw err;
    }
    existing = next;
  }
  const rest = parts.slice(i);
  const canonical = realpathSync(existing);
  if (inVault(canonical) || inVault(join(canonical, ...rest))) {
    throw new SchedFsError("vault", "store dir resolves inside an encrypted vault");
  }
  let parent = openDirPathUnchecked(canonical);
  try {
    const actual = fdRealPath(parent.fd);
    if (actual !== canonical || inVault(actual))
      throw new SchedFsError("vault", "store dir ancestor moved or lies in a vault");
    let at = actual;
    for (const comp of rest) {
      if (!isPlainName(comp)) throw new SchedFsError("bad-name", "bad path component");
      try {
        mkdirSync(fdPath(parent.fd, comp), { mode: 0o700 });
      } catch (err) {
        if (errCode(err) !== "EEXIST") throw err;
      }
      const child = openDirAt(parent.fd, comp, opts.uid === undefined ? {} : { uid: opts.uid });
      closeQuiet(parent.fd);
      parent = child;
      at = join(at, comp);
      const loc = fdRealPath(parent.fd);
      if (loc !== at || inVault(loc)) throw new SchedFsError("vault", "created store dir is not where expected");
    }
  } finally {
    closeQuiet(parent.fd);
  }
  return resolveStoreRoot(storeDir, opts);
}

export function nonTerminalRuns(state: ScheduleStateFile, taskId: string): RunRecord[] {
  return state.runs.filter((r) => r.taskId === taskId && !isTerminalRunState(r.state));
}

export function findRun(state: ScheduleStateFile, runKey: string): RunRecord | undefined {
  return state.runs.find((r) => r.runKey === runKey);
}

export type RunUpdate = Partial<
  Pick<RunRecord, "state" | "runId" | "reason" | "note" | "noteId" | "noteHolder" | "noteFileOffset">
>;

/** Non-terminal → non-terminal progress (e.g. dispatching → running{runId}). Terminal runs are frozen. */
export function updateRun(draft: ScheduleStateFile, runKey: string, patch: RunUpdate): "ok" | "missing" | "terminal" {
  if (patch.state !== undefined && isTerminalRunState(patch.state))
    throw new TypeError("updateRun: use finishRun for terminal states");
  const run = findRun(draft, runKey);
  if (run === undefined) return "missing";
  if (isTerminalRunState(run.state)) return "terminal";
  Object.assign(run, patch);
  return "ok";
}

export interface RunFinish {
  state: ScheduleRunState;
  reason?: string;
  reportFile?: string;
  note?: RunRecord["note"];
  noteId?: string;
  /** Compact text kept as `lateOutcome` when the run already ended. */
  lateText?: string;
}

/**
 * First terminal write wins (§4.6): a non-terminal run takes the terminal state; an already
 * terminal run only records `lateOutcome` (once) and returns `"late"` — no report, no message.
 */
export function finishRun(
  draft: ScheduleStateFile,
  runKey: string,
  fin: RunFinish,
  now: number,
): "ok" | "late" | "missing" {
  if (!isTerminalRunState(fin.state)) throw new TypeError("finishRun: state must be terminal");
  const run = findRun(draft, runKey);
  if (run === undefined) return "missing";
  if (isTerminalRunState(run.state)) {
    if (run.lateOutcome === undefined)
      run.lateOutcome = (fin.lateText ?? `${fin.state}${fin.reason ? `:${fin.reason}` : ""}`).slice(0, 256);
    return "late";
  }
  run.state = fin.state;
  if (fin.reason !== undefined) run.reason = fin.reason;
  else delete run.reason;
  run.endedAt = now;
  if (fin.reportFile !== undefined) run.reportFile = fin.reportFile;
  if (fin.note !== undefined) run.note = fin.note;
  if (fin.noteId !== undefined) run.noteId = fin.noteId;
  return "ok";
}

/**
 * Add a pending-delivery report (§4.2.1) in the same draft as the run's terminal write. Idempotent
 * by reportId. Overflow (> 64) drops the OLDEST entry, counts it in `reportStats` and marks its run
 * (if still present) `report-skipped(index-cap)`. Never refuses the new entry.
 */
export function addPendingReport(
  draft: ScheduleStateFile,
  entry: PendingReport,
  now: number,
): { dropped: PendingReport[] } {
  if (draft.pendingReports.some((p) => p.reportId === entry.reportId)) return { dropped: [] };
  draft.pendingReports.push(entry);
  const dropped: PendingReport[] = [];
  while (draft.pendingReports.length > SCHED_PENDING_REPORTS_MAX) {
    let oldest = 0;
    for (let i = 1; i < draft.pendingReports.length; i++) {
      if (draft.pendingReports[i]!.endedAt < draft.pendingReports[oldest]!.endedAt) oldest = i;
    }
    const [gone] = draft.pendingReports.splice(oldest, 1);
    dropped.push(gone!);
    draft.reportStats.droppedIndexCap += 1;
    draft.reportStats.lastDroppedAt = now;
    const run = findRun(draft, gone!.runKey);
    if (run !== undefined) run.reason = "report-skipped(index-cap)";
  }
  return { dropped };
}

/** `sched_receipts`: drop these reports from the index. Returns how many were removed. */
export function removePendingReports(draft: ScheduleStateFile, reportIds: readonly string[]): number {
  const ids = new Set(reportIds);
  const before = draft.pendingReports.length;
  draft.pendingReports = draft.pendingReports.filter((p) => !ids.has(p.reportId));
  return before - draft.pendingReports.length;
}

/** Entries with `now ≥ expiresAt` (N1: 24h) leave the index. */
export function expirePendingReports(draft: ScheduleStateFile, now: number): number {
  const before = draft.pendingReports.length;
  draft.pendingReports = draft.pendingReports.filter((p) => now < p.expiresAt);
  return before - draft.pendingReports.length;
}

/** Index the ACTUAL allocated path; reportId remains the stable session/run deduplication key. */
export function pendingReportFor(sessionId: string, run: RunRecord, status: string): PendingReport {
  if (run.reportFile === undefined) throw new TypeError("pending report requires a written reportFile");
  const endedAt = run.endedAt ?? run.startedAt;
  return {
    reportId: reportIdOf(sessionId, run.runKey),
    runKey: run.runKey,
    taskId: run.taskId,
    form: run.form,
    endedAt,
    expiresAt: endedAt + SCHED_REPORT_MAX_AGE_MS,
    reportFile: run.reportFile,
    status: status.slice(0, 256),
  };
}

/**
 * Drop EXPIRED manual requests only (review M2): an unexpired request is a 24h idempotency promise
 * and is never evicted for capacity — `manualClaim` refuses NEW requests with `E_LIMIT` instead.
 */
export function pruneManualReqs(draft: ScheduleStateFile, now: number): void {
  draft.manualReqs = Object.fromEntries(
    Object.entries(draft.manualReqs).filter(([, q]) => now - q.at < SCHED_MANUAL_REQ_TTL_MS),
  );
}

/** Unexpired manual requests (the idempotency window). */
export function liveManualReqCount(state: ScheduleStateFile, now: number): number {
  return Object.values(state.manualReqs).filter((q) => now - q.at < SCHED_MANUAL_REQ_TTL_MS).length;
}

/** Keep ≤ `perTask` terminal runs per task (newest by endedAt); orphan terminal runs are recycled. */
export function trimRuns(draft: ScheduleStateFile, perTask = SCHED_RUNS_PER_TASK): void {
  const live = new Set(draft.tasks.map((t) => t.id));
  const keep = new Set<RunRecord>();
  const byTask = new Map<string, RunRecord[]>();
  for (const r of draft.runs) {
    if (!isTerminalRunState(r.state)) keep.add(r);
    else if (live.has(r.taskId)) {
      const list = byTask.get(r.taskId) ?? [];
      list.push(r);
      byTask.set(r.taskId, list);
    }
  }
  for (const list of byTask.values()) {
    list.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt) || (a.runKey < b.runKey ? -1 : 1));
    for (const r of list.slice(0, perTask)) keep.add(r);
  }
  draft.runs = draft.runs.filter((r) => keep.has(r));
}

/** Delete a task (§4.7): definition, occ, manualTotal, digest watermark. Runs / pendingReports stay. */
export function removeTask(draft: ScheduleStateFile, taskId: string): boolean {
  const before = draft.tasks.length;
  draft.tasks = draft.tasks.filter((t) => t.id !== taskId);
  delete draft.occ[taskId];
  delete draft.manualTotal[taskId];
  delete draft.digest.shownMissedTotal[taskId];
  return draft.tasks.length !== before;
}

/** The per-write housekeeping (see the module header). */
export function housekeeping(draft: ScheduleStateFile, now: number): void {
  expirePendingReports(draft, now);
  pruneManualReqs(draft, now);
  trimRuns(draft);
}

const COMPACTION_LADDER: ReadonlyArray<{ runs?: number; missed?: number }> = [
  { runs: 10 },
  { runs: 5 },
  { runs: 1 },
  { missed: 32 },
  { missed: 8 },
  { missed: 1 },
];

/** Serialize, compacting UI history deterministically until ≤ 256 KiB; undefined ⇒ cannot fit. */
export function serializeToFit(draft: ScheduleStateFile): Buffer | undefined {
  let bytes = Buffer.from(JSON.stringify(draft), "utf8");
  for (const step of COMPACTION_LADDER) {
    if (bytes.length <= SCHED_STATE_MAX_BYTES) return bytes;
    if (step.runs !== undefined) trimRuns(draft, step.runs);
    if (step.missed !== undefined) {
      for (const occ of Object.values(draft.occ)) {
        if (occ.missedLog.length > step.missed) occ.missedLog.splice(0, occ.missedLog.length - step.missed);
      }
    }
    bytes = Buffer.from(JSON.stringify(draft), "utf8");
  }
  return bytes.length <= SCHED_STATE_MAX_BYTES ? bytes : undefined;
}

// ----------------------------------------------------------------- session store

export interface SessionStore {
  readonly sessionId: string;
  readonly dirName: string;
  readonly root: StoreRoot;
  /** Lock-free snapshot (`absent` ⇒ no ledger yet). */
  read(): SessionStateRead;
  transact<T>(body: (draft: ScheduleStateFile, ctx: TxCtx) => TxBody<T>): Promise<TxResult<T>>;
  /**
   * §4.5 protocol. `plan` runs outside the lock at (wall `planAt`, monotonic `m0`); it is applied
   * only if, under the lock, rev is unchanged, `planAt ≤ now ≤ validUntil` AND the wall clock moved
   * like the monotonic clock (|Δwall − Δmono| ≤ 1 s). Otherwise re-planned (≤ 3 attempts ⇒ E_BUSY).
   */
  transactPlanned<P extends { validUntil: number }, T>(
    plan: (snapshot: ScheduleStateFile, now: number) => { plan: P } | { done: T },
    apply: (draft: ScheduleStateFile, plan: P, ctx: TxCtx) => TxBody<T>,
  ): Promise<TxResult<T>>;
  /** Quarantine a corrupt state.json to `state.json.bak` and start empty (`/schedule repair`).
   *  Uses the ordinary lock: a live holder ⇒ E_BUSY (there is no forced break, review M6). */
  repair(): Promise<TxResult<{ quarantined: boolean }>>;
  /** Run `fn` with the session dir fd (read-only helpers; GC). Undefined when the dir is missing. */
  withDir<T>(fn: (sessFd: number) => T): T | undefined;
}

type SessOpen =
  { kind: "ok"; fd: number } | { kind: "missing" } | { kind: "error"; code: WriterErrorCode; detail: string };

export function openSessionStore(opts: SessionStoreOpts): SessionStore {
  const now = opts.now ?? Date.now;
  const mono = opts.monotonic ?? (() => performance.now());
  const dirName = sessionDirName(opts.sessionId);
  const fsOpts = {
    ...(opts.uid === undefined ? {} : { uid: opts.uid }),
    ...(opts.inVault === undefined ? {} : { inVault: opts.inVault }),
  };

  function lockOpts(): LockOpts {
    return {
      monotonic: mono,
      holderInfo: { pid: opts.self.pid, start: opts.self.start, host: opts.self.host, epoch: opts.epoch, at: now() },
      ...(opts.lockTimeoutMs === undefined ? {} : { timeoutMs: opts.lockTimeoutMs }),
      ...(opts.sleep === undefined ? {} : { sleep: opts.sleep }),
      ...(opts.flockBin === undefined ? {} : { flockBin: opts.flockBin }),
    };
  }

  function errorOf(err: unknown): { kind: "error"; code: WriterErrorCode; detail: string } {
    return { kind: "error", code: "E_DEGRADED", detail: err instanceof Error ? err.message : String(err) };
  }

  /** Open the existing session dir (fd location verified). */
  function openSess(): SessOpen {
    let rootFd: number | undefined;
    try {
      rootFd = openStoreRoot(opts.root, fsOpts).fd;
      try {
        return { kind: "ok", fd: openSessionDirAt(rootFd, opts.root.real, dirName, fsOpts).fd };
      } catch (err) {
        if (err instanceof SchedFsError && err.reason === "missing") return { kind: "missing" };
        throw err;
      }
    } catch (err) {
      return errorOf(err);
    } finally {
      closeQuiet(rootFd);
    }
  }

  /**
   * Create the session dir under the STORE-level flock (review m1): count → mkdir is atomic across
   * sessions/processes; a failed or truncated listing refuses creation (fail closed).
   */
  async function createSess(): Promise<SessOpen> {
    let rootFd: number | undefined;
    try {
      rootFd = openStoreRoot(opts.root, fsOpts).fd;
      const fd0 = rootFd;
      const locked = await withDirLock(
        fd0,
        (): SessOpen => {
          try {
            return { kind: "ok", fd: openSessionDirAt(fd0, opts.root.real, dirName, fsOpts).fd };
          } catch (err) {
            if (!(err instanceof SchedFsError) || err.reason !== "missing") throw err;
          }
          const listing = listSessionDirs(opts.root, { ...fsOpts, max: SCHED_MAX_SESSION_DIRS + 1 });
          if (listing.kind !== "ok" || listing.truncated) {
            return {
              kind: "error",
              code: "E_LIMIT",
              detail: "cannot prove the session-directory count (scan failed or truncated)",
            };
          }
          if (listing.dirs.length >= SCHED_MAX_SESSION_DIRS) {
            return { kind: "error", code: "E_LIMIT", detail: `at most ${SCHED_MAX_SESSION_DIRS} session directories` };
          }
          try {
            mkdirSync(fdPath(fd0, dirName), { mode: 0o700 });
          } catch (err) {
            if (errCode(err) !== "EEXIST") throw err;
          }
          return { kind: "ok", fd: openSessionDirAt(fd0, opts.root.real, dirName, fsOpts).fd };
        },
        { ...lockOpts(), name: SCHED_STORE_LOCK_FILE },
      );
      if (!locked.ok) return { kind: "error", code: "E_BUSY", detail: locked.detail };
      return locked.value;
    } catch (err) {
      return errorOf(err);
    } finally {
      closeQuiet(rootFd);
    }
  }

  type Inner<T> = TxResult<T> | { retry: true };

  /** One locked attempt: read, check, body, housekeeping, write. */
  async function lockedAttempt<T>(
    create: boolean,
    body: (draft: ScheduleStateFile, ctx: TxCtx) => TxBody<T> | { retry: true },
  ): Promise<Inner<T>> {
    const sess = create ? await createSess() : openSess();
    if (sess.kind === "error") return { ok: false, code: sess.code, detail: sess.detail };
    if (sess.kind === "missing") {
      // No directory yet: run the body on an empty ledger; a write forces creation + a real attempt.
      const r = body(emptyStateFile(opts.sessionId), { now: now(), rev: 0, dirFd: undefined });
      if ("retry" in r) return r;
      if (!r.write) return { ok: true, value: r.value, rev: 0, wrote: false };
      return lockedAttempt(true, body);
    }
    const fd = sess.fd;
    try {
      let out: Inner<T> | undefined;
      const locked: LockOutcome<void> = await withSessionLock(
        fd,
        () => {
          opts.faults?.("lock-held");
          const read = readStateAt(fd, dirName, fsOpts);
          if (read.kind === "degraded") {
            out = { ok: false, code: "E_DEGRADED", detail: `${read.reason}: ${read.detail}` };
            return;
          }
          const base = read.kind === "ok" ? read.state : emptyStateFile(opts.sessionId);
          const draft = structuredClone(base);
          const ctx: TxCtx = { now: now(), rev: base.rev, dirFd: fd };
          const r = body(draft, ctx);
          if ("retry" in r) {
            out = r;
            return;
          }
          if (!r.write) {
            out = { ok: true, value: r.value, rev: base.rev, wrote: false };
            return;
          }
          housekeeping(draft, ctx.now);
          draft.v = 1;
          draft.sessionId = opts.sessionId;
          draft.rev = base.rev + 1;
          const bytes = serializeToFit(draft);
          if (bytes === undefined) {
            out = { ok: false, code: "E_LIMIT", detail: "state.json would exceed 256 KiB" };
            return;
          }
          try {
            atomicWriteAt(fd, SCHED_STATE_FILE, bytes, opts.faults);
          } catch (err) {
            out =
              err instanceof CommitUncertainError
                ? { ok: false, code: "E_DEGRADED", detail: err.message, uncertain: true }
                : { ok: false, code: "E_DEGRADED", detail: `write failed: ${errCode(err) ?? String(err)}` };
            return;
          }
          out = { ok: true, value: r.value, rev: draft.rev, wrote: true };
        },
        lockOpts(),
      );
      if (!locked.ok) {
        if (locked.gone === true) return { retry: true };
        return { ok: false, code: "E_BUSY", detail: locked.detail };
      }
      return out!;
    } catch (err) {
      // A body that itself committed a file (e.g. writeReportLocked) may throw CommitUncertainError.
      return {
        ok: false,
        code: "E_DEGRADED",
        detail: err instanceof Error ? err.message : String(err),
        ...(err instanceof CommitUncertainError ? { uncertain: true } : {}),
      };
    } finally {
      closeQuiet(fd);
    }
  }

  async function transact<T>(body: (draft: ScheduleStateFile, ctx: TxCtx) => TxBody<T>): Promise<TxResult<T>> {
    for (let i = 0; i < SCHED_TX_PLAN_ATTEMPTS; i++) {
      const r = await lockedAttempt<T>(false, body);
      if (!("retry" in r)) return r;
    }
    return { ok: false, code: "E_BUSY", detail: "session directory kept disappearing" };
  }

  function read(): SessionStateRead {
    const sess = openSess();
    if (sess.kind === "missing") return { kind: "absent" };
    if (sess.kind === "error") return { kind: "degraded", reason: "io", detail: sess.detail };
    try {
      return readStateAt(sess.fd, dirName, fsOpts);
    } finally {
      closeQuiet(sess.fd);
    }
  }

  async function transactPlanned<P extends { validUntil: number }, T>(
    plan: (snapshot: ScheduleStateFile, now: number) => { plan: P } | { done: T },
    apply: (draft: ScheduleStateFile, plan: P, ctx: TxCtx) => TxBody<T>,
  ): Promise<TxResult<T>> {
    for (let attempt = 0; attempt < SCHED_TX_PLAN_ATTEMPTS; attempt++) {
      const snap = read();
      if (snap.kind === "degraded") return { ok: false, code: "E_DEGRADED", detail: `${snap.reason}: ${snap.detail}` };
      const base = snap.kind === "ok" ? snap.state : emptyStateFile(opts.sessionId);
      const planAt = now();
      const m0 = mono();
      const p = plan(base, planAt);
      if ("done" in p) return { ok: true, value: p.done, rev: base.rev, wrote: false };
      const r = await lockedAttempt<T>(false, (draft, ctx) => {
        const skew = Math.abs(ctx.now - planAt - (mono() - m0));
        if (
          ctx.rev !== base.rev ||
          ctx.now < planAt ||
          ctx.now > p.plan.validUntil ||
          skew > SCHED_PLAN_CLOCK_SKEW_MS
        ) {
          return { retry: true };
        }
        return apply(draft, p.plan, ctx);
      });
      if (!("retry" in r)) return r;
    }
    return { ok: false, code: "E_BUSY", detail: "state or clock kept changing while planning (re-planned 3 times)" };
  }

  async function repair(): Promise<TxResult<{ quarantined: boolean }>> {
    const sess = openSess();
    if (sess.kind === "missing") return { ok: true, value: { quarantined: false }, rev: 0, wrote: false };
    if (sess.kind === "error") return { ok: false, code: sess.code, detail: sess.detail };
    const fd = sess.fd;
    try {
      let out: TxResult<{ quarantined: boolean }> | undefined;
      const locked = await withSessionLock(
        fd,
        () => {
          const cur = readStateAt(fd, dirName, fsOpts);
          if (cur.kind !== "degraded") {
            out = { ok: true, value: { quarantined: false }, rev: cur.kind === "ok" ? cur.state.rev : 0, wrote: false };
            return;
          }
          if (
            cur.reason === "symlink" ||
            cur.reason === "not-file" ||
            cur.reason === "owner" ||
            cur.reason === "mode"
          ) {
            // Never rename something we would not have written ourselves; a human must look.
            out = { ok: false, code: "E_DEGRADED", detail: `${cur.reason}: ${cur.detail} (fix manually)` };
            return;
          }
          renameSync(fdPath(fd, SCHED_STATE_FILE), fdPath(fd, `${SCHED_STATE_FILE}.bak`));
          const fresh = emptyStateFile(opts.sessionId);
          fresh.rev = 1;
          try {
            atomicWriteAt(fd, SCHED_STATE_FILE, Buffer.from(JSON.stringify(fresh), "utf8"), opts.faults);
          } catch (err) {
            out = {
              ok: false,
              code: "E_DEGRADED",
              detail: String(err),
              ...(err instanceof CommitUncertainError ? { uncertain: true } : {}),
            };
            return;
          }
          out = { ok: true, value: { quarantined: true }, rev: 1, wrote: true };
        },
        lockOpts(),
      );
      if (!locked.ok) return { ok: false, code: "E_BUSY", detail: locked.detail };
      return out!;
    } catch (err) {
      return { ok: false, code: "E_DEGRADED", detail: err instanceof Error ? err.message : String(err) };
    } finally {
      closeQuiet(fd);
    }
  }

  function withDir<T>(fn: (sessFd: number) => T): T | undefined {
    const sess = openSess();
    if (sess.kind !== "ok") return undefined;
    try {
      return fn(sess.fd);
    } finally {
      closeQuiet(sess.fd);
    }
  }

  return { sessionId: opts.sessionId, dirName, root: opts.root, read, transact, transactPlanned, repair, withDir };
}

// ----------------------------------------------------------------- GC / recycling (§4.7)

export interface ReportFileStat {
  name: string;
  size: number;
  mtimeMs: number;
}

export interface ReportInventory {
  reports: ReportFileStat[];
  /** Stray temp files (`.<name>.<pid>.<rand>.tmp`) with their mtime. */
  temps: ReportFileStat[];
  /** False ⇔ the listing is not provably complete (reports dir unopenable other than missing, or
   *  the scan bound was hit). Capacity decisions treat an incomplete listing as "full". */
  complete: boolean;
}

const INVENTORY_SCAN_MAX = 4096;

/** List `reports/` under a session dir fd (lstat only — never follows; bounded). */
export function reportInventory(sessFd: number): ReportInventory {
  const inv: ReportInventory = { reports: [], temps: [], complete: true };
  let repFd: number | undefined;
  try {
    repFd = openDirAt(sessFd, SCHED_REPORTS_DIR).fd;
  } catch (err) {
    if (!(err instanceof SchedFsError && err.reason === "missing")) inv.complete = false;
    return inv;
  }
  try {
    const dir = opendirSync(fdPath(repFd));
    try {
      inv.complete = false;
      for (let i = 0; i < INVENTORY_SCAN_MAX; i++) {
        const ent = dir.readSync();
        if (ent === null) {
          inv.complete = true;
          break;
        }
        const isReport = SCHED_REPORT_NAME_RE.test(ent.name);
        const isTemp = ent.name.startsWith(".") && ent.name.endsWith(".tmp");
        if (!isReport && !isTemp) continue;
        let st;
        try {
          st = lstatSync(fdPath(repFd, ent.name));
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        (isReport ? inv.reports : inv.temps).push({ name: ent.name, size: st.size, mtimeMs: st.mtimeMs });
      }
    } finally {
      dir.closeSync();
    }
  } finally {
    closeQuiet(repFd);
  }
  return inv;
}

const SESSION_TMP_RE = /^\.(?:state\.json|lock)\.[0-9]+\.[0-9a-f]+\.tmp$/;

/** Stray writer/lock temps directly under the session dir (lstat only, bounded). */
export function sessionTemps(sessFd: number): ReportFileStat[] {
  const out: ReportFileStat[] = [];
  const dir = opendirSync(fdPath(sessFd));
  try {
    for (let i = 0; i < INVENTORY_SCAN_MAX; i++) {
      const ent = dir.readSync();
      if (ent === null) break;
      if (!SESSION_TMP_RE.test(ent.name)) continue;
      try {
        const st = lstatSync(fdPath(sessFd, ent.name));
        if (st.isFile()) out.push({ name: ent.name, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* gone */
      }
    }
  } finally {
    dir.closeSync();
  }
  return out;
}

/** Report names (short or legacy) protected by the pending-delivery index. */
export function referencedReports(state: ScheduleStateFile): Set<string> {
  return new Set(state.pendingReports.map((p) => p.reportFile.slice(SCHED_REPORTS_DIR.length + 1)));
}

export interface GcCaps {
  maxCount: number;
  maxBytes: number;
  retentionMs: number;
}
export const SESSION_GC_CAPS: GcCaps = Object.freeze({
  maxCount: SCHED_REPORTS_PER_SESSION_MAX,
  maxBytes: SCHED_REPORT_BYTES_PER_SESSION_MAX,
  retentionMs: SCHED_REPORT_RETENTION_MS,
});

/** Room to reserve for reports about to be written (review m2). */
export interface GcIncoming {
  count: number;
  bytes: number;
}
const NO_INCOMING: GcIncoming = Object.freeze({ count: 0, bytes: 0 });

/**
 * Choose deletions (pure): expired (> retention) unprotected reports, then oldest unprotected until
 * the remaining files PLUS `incoming` fit the count/byte caps. Protected = referenced by
 * pendingReports OR younger than the grace.
 */
export function planReportDeletions(
  reports: readonly ReportFileStat[],
  referenced: ReadonlySet<string>,
  now: number,
  caps: GcCaps,
  incoming: GcIncoming = NO_INCOMING,
): { delete: string[]; overCap: boolean } {
  const protectedOf = (r: ReportFileStat): boolean =>
    referenced.has(r.name) || now - r.mtimeMs < SCHED_REPORT_GC_GRACE_MS;
  const sorted = [...reports].sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1));
  const del = new Set<string>();
  for (const r of sorted) if (!protectedOf(r) && now - r.mtimeMs >= caps.retentionMs) del.add(r.name);
  let count = sorted.length - del.size + incoming.count;
  let bytes = sorted.filter((r) => !del.has(r.name)).reduce((s, r) => s + r.size, 0) + incoming.bytes;
  for (const r of sorted) {
    if (count <= caps.maxCount && bytes <= caps.maxBytes) break;
    if (del.has(r.name) || protectedOf(r)) continue;
    del.add(r.name);
    count -= 1;
    bytes -= r.size;
  }
  return { delete: [...del], overCap: count > caps.maxCount || bytes > caps.maxBytes };
}

/** Over the caps given what is ACTUALLY left (+ incoming)? */
function overCapAfter(
  reports: readonly ReportFileStat[],
  deleted: ReadonlySet<string>,
  caps: Pick<GcCaps, "maxCount" | "maxBytes">,
  incoming: GcIncoming,
): boolean {
  const left = reports.filter((r) => !deleted.has(r.name));
  const bytes = left.reduce((s, r) => s + r.size, 0) + incoming.bytes;
  return left.length + incoming.count > caps.maxCount || bytes > caps.maxBytes;
}

export interface GcResult {
  deleted: string[];
  tempsReaped: number;
  /** True ⇔ what is ACTUALLY left plus `incoming` exceeds the per-session caps ⇒ A1 must not write. */
  overCap: boolean;
}

function unlinkReports(sessFd: number, names: Iterable<string>, refs: ReadonlySet<string>): string[] {
  const done: string[] = [];
  let repFd: number | undefined;
  try {
    repFd = openDirAt(sessFd, SCHED_REPORTS_DIR).fd;
    for (const name of names) {
      if (refs.has(name) || !(SCHED_REPORT_NAME_RE.test(name) || (name.startsWith(".") && name.endsWith(".tmp"))))
        continue;
      try {
        unlinkSync(fdPath(repFd, name));
        done.push(name);
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* no reports dir */
  } finally {
    closeQuiet(repFd);
  }
  return done;
}

/**
 * Per-session report GC: inventory outside the lock, deletions re-checked against the FRESH index
 * under the lock (a report referenced meanwhile is never deleted). `overCap` is computed from what
 * was ACTUALLY deleted (a failed unlink counts as still present; an incomplete listing ⇒ true).
 *
 * `incoming` here is only an estimate for housekeeping — the lock is released when this returns.
 * Writers must NOT "GC, then write": use `writeReportLocked`, which re-measures, makes room, writes
 * the report and commits the ledger in ONE writer-lock critical section (review round 2, m2).
 */
export async function gcSessionReports(
  store: SessionStore,
  now: number,
  caps: GcCaps = SESSION_GC_CAPS,
  incoming: GcIncoming = NO_INCOMING,
): Promise<TxResult<GcResult>> {
  const inv = store.withDir((fd) => reportInventory(fd));
  if (inv === undefined) {
    const overCap = overCapAfter([], new Set(), caps, incoming);
    return { ok: true, value: { deleted: [], tempsReaped: 0, overCap }, rev: 0, wrote: false };
  }
  return store.transact((draft, ctx) => {
    if (ctx.dirFd === undefined) {
      return {
        value: { deleted: [], tempsReaped: 0, overCap: overCapAfter([], new Set(), caps, incoming) },
        write: false,
      };
    }
    const refs = referencedReports(draft);
    // Re-inventory under the lock: the actual files decide, not the unlocked snapshot.
    const fresh = reportInventory(ctx.dirFd);
    const plan = planReportDeletions(fresh.reports, refs, now, caps, incoming);
    const deleted = unlinkReports(ctx.dirFd, plan.delete, refs);
    const temps = inv.temps.filter((t) => now - t.mtimeMs >= SCHED_TMP_GC_AGE_MS).map((t) => t.name);
    let tempsReaped = unlinkReports(ctx.dirFd, temps, refs).length;
    // Crash leftovers in the session dir itself (`.state.json.*.tmp`, `.lock.*.tmp`): we hold the
    // lock, so none of them belongs to a live write.
    for (const t of sessionTemps(ctx.dirFd)) {
      if (now - t.mtimeMs < SCHED_TMP_GC_AGE_MS) continue;
      try {
        unlinkSync(fdPath(ctx.dirFd, t.name));
        tempsReaped += 1;
      } catch {
        /* gone */
      }
    }
    const overCap = !fresh.complete || overCapAfter(fresh.reports, new Set(deleted), caps, incoming);
    return { value: { deleted, tempsReaped, overCap }, write: false };
  });
}

export interface ReportWriteInput<T> {
  /** Relative report path. For new runs pass the base path from `reportFileOf`. */
  reportFile: string;
  /** Allocate -2, -3, … under the writer lock instead of replacing an existing file. */
  allocateUnique?: boolean;
  data: Buffer;
  now: number;
  caps?: GcCaps;
  /** Ledger update committed in the SAME transaction (e.g. `finishRun` + `addPendingReport`);
   *  `written` says whether the report file landed (false ⇒ mark `report-skipped(cap)`). */
  commit?: (draft: ScheduleStateFile, ctx: TxCtx, written: boolean, reportFile: string) => TxBody<T>;
}

export interface ReportWriteResult<T> {
  written: boolean;
  /** Actual allocated path, present only when the file was written. */
  reportFile?: string;
  /** True ⇔ even after GC the session caps leave no room for this report (nothing written). */
  overCap: boolean;
  deleted: string[];
  value?: T;
}

/**
 * Capacity admission + report write as ONE single-writer critical section (review round 2, m2):
 * under the session writer lock (a kernel flock — every writer of this session's reports and
 * ledger goes through it) it re-inventories `reports/`, deletes what GC may delete to make room
 * for exactly this report, re-checks the caps against the files ACTUALLY left, writes the file
 * (atomic, 0600) only if it fits, and commits the caller's ledger update in the same transaction.
 * Two concurrent writers therefore serialize: the second one measures the first one's file and
 * gets `overCap` instead of both taking the last slot. Global caps (all sessions) stay soft — they
 * are enforced afterwards by `gcGlobalReports`.
 */
export async function writeReportLocked<T = undefined>(
  store: SessionStore,
  input: ReportWriteInput<T>,
): Promise<TxResult<ReportWriteResult<T>>> {
  const prefix = `${SCHED_REPORTS_DIR}/`;
  const name = input.reportFile.startsWith(prefix) ? input.reportFile.slice(prefix.length) : "";
  if (!SCHED_REPORT_NAME_RE.test(name)) return { ok: false, code: "E_DEGRADED", detail: "bad report path" };
  const caps = input.caps ?? SESSION_GC_CAPS;
  const incoming: GcIncoming = { count: 1, bytes: input.data.length };
  return store.transact<ReportWriteResult<T>>((draft, ctx) => {
    if (ctx.dirFd === undefined) {
      // No session dir yet: request creation; the transaction re-runs this body with the locked dir.
      return { value: { written: false, overCap: false, deleted: [] }, write: true };
    }
    const fd = ctx.dirFd;
    const refs = referencedReports(draft);
    const fresh = reportInventory(fd);
    let allocated = name;
    if (input.allocateUnique) {
      // Include ledger references as well as disk entries: GC/eviction never reassigns a live
      // run's name. lstat also reserves non-regular entries without following them.
      const used = new Set([...refs, ...draft.runs.flatMap((r) => r.reportFile?.slice(prefix.length) ?? [])]);
      let available = false;
      for (let n = 1; n <= INVENTORY_SCAN_MAX; n++) {
        allocated = n === 1 ? name : `${name.slice(0, -3)}-${n}.md`;
        if (used.has(allocated)) continue;
        try {
          lstatSync(fdPath(fd, `${SCHED_REPORTS_DIR}/${allocated}`));
        } catch (err) {
          if (errCode(err) !== "ENOENT") throw err;
          available = true;
          break;
        }
      }
      if (!available) throw new SchedFsError("io", "report name allocation exhausted");
    }
    const reportFile = `${prefix}${allocated}`;
    // Explicit legacy writes may replace a same-named file; allocated new reports never do.
    const others = fresh.reports.filter((r) => r.name !== allocated);
    const plan = planReportDeletions(others, refs, input.now, caps, incoming);
    const deleted = unlinkReports(fd, plan.delete, refs);
    const overCap = !fresh.complete || overCapAfter(others, new Set(deleted), caps, incoming);
    let written = false;
    if (!overCap) {
      try {
        mkdirSync(fdPath(fd, SCHED_REPORTS_DIR), { mode: 0o700 });
      } catch (err) {
        if (errCode(err) !== "EEXIST") throw err;
      }
      const repFd = openDirAt(fd, SCHED_REPORTS_DIR).fd;
      try {
        atomicWriteAt(repFd, allocated, input.data);
      } finally {
        closeQuiet(repFd);
      }
      written = true;
    }
    const c = input.commit?.(draft, ctx, written, reportFile);
    return {
      value: {
        written,
        overCap,
        deleted,
        ...(written ? { reportFile } : {}),
        ...(c === undefined ? {} : { value: c.value }),
      },
      write: c?.write ?? false,
    };
  });
}

/** Global report caps (≤ 2 000 files / 128 MiB across all sessions): plan oldest-first, delete per session under its lock. */
export async function gcGlobalReports(
  storeOpts: Omit<SessionStoreOpts, "sessionId">,
  now: number,
): Promise<{ deleted: number; overCap: boolean }> {
  const fsOpts = {
    ...(storeOpts.uid === undefined ? {} : { uid: storeOpts.uid }),
    ...(storeOpts.inVault === undefined ? {} : { inVault: storeOpts.inVault }),
  };
  const listing = listSessionDirs(storeOpts.root, fsOpts);
  // An incomplete scan is never evidence of free capacity.
  if (listing.kind !== "ok") return { deleted: 0, overCap: true };
  let complete = !listing.truncated;
  type Row = ReportFileStat & { sessionId: string; protected: boolean };
  const rows: Row[] = [];
  for (const dir of listing.dirs) {
    const snap = readSessionState(storeOpts.root, dir, fsOpts);
    if (snap.kind !== "ok") {
      if (snap.kind === "degraded") complete = false; // left alone, and its files are unknown
      continue;
    }
    const store = openSessionStore({ ...storeOpts, sessionId: snap.state.sessionId });
    const refs = referencedReports(snap.state);
    const inv = store.withDir((fd) => reportInventory(fd));
    for (const r of inv?.reports ?? []) {
      rows.push({
        ...r,
        sessionId: snap.state.sessionId,
        protected: refs.has(r.name) || now - r.mtimeMs < SCHED_REPORT_GC_GRACE_MS,
      });
    }
  }
  rows.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1));
  let count = rows.length;
  let bytes = rows.reduce((s, r) => s + r.size, 0);
  const victims = new Map<string, Set<string>>();
  for (const r of rows) {
    if (count <= SCHED_REPORTS_GLOBAL_MAX && bytes <= SCHED_REPORT_BYTES_GLOBAL_MAX) break;
    if (r.protected) continue;
    const set = victims.get(r.sessionId) ?? new Set<string>();
    set.add(r.name);
    victims.set(r.sessionId, set);
    count -= 1;
    bytes -= r.size;
  }
  const actuallyDeleted = new Set<string>();
  for (const [sessionId, names] of victims) {
    const store = openSessionStore({ ...storeOpts, sessionId });
    const r = await store.transact((draft, ctx) => ({
      value: ctx.dirFd === undefined ? [] : unlinkReports(ctx.dirFd, names, referencedReports(draft)),
      write: false,
    }));
    if (r.ok) for (const n of r.value) actuallyDeleted.add(`${sessionId}/${n}`);
  }
  // Capacity from what was REALLY deleted (lock failures / new references count as still present).
  const left = rows.filter((r) => !actuallyDeleted.has(`${r.sessionId}/${r.name}`));
  const leftBytes = left.reduce((s2, r) => s2 + r.size, 0);
  return {
    deleted: actuallyDeleted.size,
    overCap: !complete || left.length > SCHED_REPORTS_GLOBAL_MAX || leftBytes > SCHED_REPORT_BYTES_GLOBAL_MAX,
  };
}

/** §4.7 空目录: no task, no non-terminal run, no pendingReports, no report newer than 24h. */
export function isRecyclable(state: ScheduleStateFile | undefined, inv: ReportInventory, now: number): boolean {
  if (!inv.complete) return false; // unknown contents are never recycled
  if (state !== undefined) {
    if (state.tasks.length > 0 || state.pendingReports.length > 0) return false;
    if (state.runs.some((r) => !isTerminalRunState(r.state))) return false;
  }
  return !inv.reports.some((r) => now - r.mtimeMs < SCHED_RECYCLE_REPORT_QUIET_MS);
}

/**
 * Remove the whole session directory when recyclable — under the lock, lock file last, then rmdir
 * via the store root (a racing waiter that re-created the lock makes rmdir fail with ENOTEMPTY:
 * harmless; it then works on a fresh, empty ledger).
 */
export async function recycleSessionDir(store: SessionStore, now: number): Promise<TxResult<{ recycled: boolean }>> {
  const r = await store.transact((draft, ctx) => {
    const fd = ctx.dirFd;
    if (fd === undefined) return { value: false, write: false };
    const inv = reportInventory(fd);
    if (!isRecyclable(ctx.rev === 0 ? undefined : draft, inv, now)) return { value: false, write: false };
    unlinkReports(
      fd,
      [...inv.reports, ...inv.temps].map((x) => x.name),
      new Set(),
    );
    try {
      rmdirSync(fdPath(fd, SCHED_REPORTS_DIR));
    } catch (err) {
      if (errCode(err) !== "ENOENT") return { value: false, write: false };
    }
    for (const name of [SCHED_STATE_FILE, `${SCHED_STATE_FILE}.bak`]) {
      try {
        unlinkSync(fdPath(fd, name));
      } catch (err) {
        if (errCode(err) !== "ENOENT") return { value: false, write: false };
      }
    }
    try {
      unlinkSync(fdPath(fd, SCHED_LOCK_FILE));
    } catch {
      /* release handles it */
    }
    return { value: true, write: false };
  });
  if (!r.ok || !r.value) return r.ok ? { ...r, value: { recycled: false } } : r;
  let rootFd: number | undefined;
  try {
    rootFd = openStoreRoot(store.root).fd;
    rmdirSync(fdPath(rootFd, store.dirName));
  } catch {
    /* ENOTEMPTY: a waiter got in, or already gone — fine */
  } finally {
    closeQuiet(rootFd);
  }
  return { ...r, value: { recycled: true } };
}
