import type { AnchorIdentity, RunId } from "../core/types.js";

/**
 * consult follow-up threads (docs/dev/consult/cache-thread-plan.md §4, R2-1…R2-3).
 *
 * Pi-free, closure-state only (one registry per `wireConsult`, never module
 * scope). A *thread* is keyed by (askerRunId × expertRunId); its `head` is the
 * fork file of the last answered consult, retained instead of deleted so the
 * next consult of the same expert forks "expert history + Q1 + A1" and the
 * expert sees its own earlier answers.
 *
 * Invariants (each pinned by tests/consult/threads.test.ts):
 *  - only a fork whose session was positively disposed (`onReaped`
 *    `{disposed:true}`, R2-1) can become a head — an unsealed file is never
 *    copied or adopted;
 *  - promotion needs `eligible ∧ sealed ∧ epoch ok ∧ thread open ∧
 *    candidate.gen === thread.gen` (R2-2): asker terminal, FIFO eviction,
 *    reset and `fresh` all bump `gen` and close the record, so a late result
 *    can never resurrect a dropped thread (it only deletes its own file);
 *  - disk: every owned file counts (heads + all in-flight/candidate forks,
 *    including ones still growing — re-stat'd on demand); promotion re-stats
 *    the real size and refuses adoption beyond the caps (R2-3);
 *  - no timers, no I/O at module load; time and fs are injected.
 */

export const THREAD_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
export const THREAD_BUDGET_BYTES = 512 * 1024 * 1024;
export const THREAD_MAX_THREADS = 32;
export const THREAD_MAX_PROMOTIONS = 8;
export const THREAD_IDLE_MS = 60 * 60 * 1000;

export type ThreadReason = "context" | "cost" | "size" | "budget" | "seq-cap" | "identity";
export type ThreadMode = "continued" | "new" | "fresh" | "reset" | "pending" | "branch";

export interface ThreadFsPort {
  /** Byte size of a regular file; `undefined` when missing/unreadable. Must not throw. */
  size(path: string): number | undefined;
  /** ENOENT-silent delete scoped to the consult dir; must not throw. */
  remove(path: string): void;
}

export interface ThreadHead {
  file: string;
  bytes: number;
  consultRunId: RunId;
  tokens: number;
  percent?: number | null;
}

/** What `begin` hands the tool: where to fork from and what to tell the model/UI. */
export interface ThreadLease {
  readonly threadId: string;
  readonly epoch: string;
  readonly gen: number;
  /** 1-based position this consult asks at (= retained answers seen + 1). */
  readonly seq: number;
  readonly mode: ThreadMode;
  readonly reason?: ThreadReason;
  /** True iff this consult's answer may become the thread's next head. */
  readonly keep: boolean;
  /** File to fork: the head's fork file, or the expert's original session. */
  readonly sourceFile: string;
  /** Retained answers the expert will see (thread.seq at begin). */
  readonly retained: number;
  /** Trusted first-consult anchor identity — only when the source is a head. */
  readonly base?: AnchorIdentity;
  /** Head the source copy comes from (undefined ⇒ original session). */
  readonly head?: Readonly<ThreadHead>;
  /** Bytes reserved for the copy. */
  readonly reservedBytes: number;
}

export interface BeginParams {
  askerRunId: RunId;
  expertRunId: RunId;
  /** The expert's original persisted session. */
  originalFile: string;
  /** Opaque signature of the original session (size+mtime…); a change ⇒ reset(identity). */
  sourceKey?: string;
  fresh?: boolean;
  /** Force a reset with this reason (identity-retry path). */
  forceReset?: ThreadReason;
  /** Context/cost admission for a usable head; return a reason to reset. */
  headGuard?: (head: Readonly<ThreadHead>) => ThreadReason | undefined;
}

export interface SettleParams {
  /** completed ∧ non-empty ∧ not guard-terminated ∧ no preserve failure (§4.2 ②). */
  eligible: boolean;
  tokens?: number;
  percent?: number | null;
  consultRunId?: RunId;
  /** Trusted identity of the history end learned from the consult's first successful wire request (added|relocated, valid identity; `degraded` is irrelevant — it only reflects the breakpoint budget). */
  base?: AnchorIdentity;
}

export type ReapVerdict = "keep" | "delete";

interface Thread {
  id: string;
  key: string;
  askerRunId: RunId;
  expertRunId: RunId;
  epoch: string;
  gen: number;
  closed: boolean;
  head?: ThreadHead | undefined;
  /** The single keep-fork that has not been resolved yet (pending mode while set). */
  candidate?: ForkRec | undefined;
  base?: AnchorIdentity | undefined;
  snapDigest?: string | undefined;
  sourceKey?: string | undefined;
  /** Number of promotions == retained answers. */
  seq: number;
  busy?: ThreadLease | undefined;
  lastUsedAt: number;
}

interface ForkRec {
  path: string;
  thread: Thread;
  gen: number;
  epoch: string;
  keep: boolean;
  reserved: number;
  decided: boolean;
  eligible: boolean;
  reaped: boolean;
  sealed: boolean;
  tokens?: number;
  percent?: number | null;
  consultRunId?: RunId;
  base?: AnchorIdentity;
}

export interface ThreadsStats {
  threads: number;
  heads: number;
  forks: number;
  usedBytes: number;
  promotions: number;
  refusedAdoptions: number;
  closed: boolean;
}

export interface ThreadView {
  id: string;
  askerRunId: RunId;
  expertRunId: RunId;
  gen: number;
  seq: number;
  headFile?: string;
  hasCandidate: boolean;
  busy: boolean;
}

export interface ConsultThreads {
  readonly epoch: string;
  /** Decide what the next consult of (asker, expert) forks from. `undefined` ⇒ registry closed (legacy path). */
  begin(params: BeginParams): ThreadLease | undefined;
  /** Record the consult's own fork copy (after a successful copy, before spawn). Returns false when the lease is stale/closed. */
  openFork(lease: ThreadLease, path: string): boolean;
  /** Drop the lease's bookkeeping when the tool call ends (always; idempotent). */
  finish(lease: ThreadLease): void;
  /** Tool-side stale-fork cleanup (the tool deleted the file itself). */
  abandonFork(lease: ThreadLease, path: string): void;
  /** Record the first trusted digest of the expert's request identity (loadout) on the thread; false ⇒ mismatch. */
  noteDigest(lease: ThreadLease, digest: string): boolean;
  /** Outcome known. Resolves the candidate if its session was already disposed. */
  settle(path: string, result: SettleParams): void;
  /** Runner reaped the consult run. Returns whether the caller must delete the file. */
  onReaped(path: string, info?: { disposed: boolean }): ReapVerdict;
  /** An asker reached a terminal state: drop its threads (R2-2). */
  onRunTerminal(runId: RunId): void;
  /** Soft-TTL pass (called from consult entry / terminal snapshots / close). */
  sweepIdle(): void;
  /** Whether a head file is currently retained at `path`. */
  isHead(path: string): boolean;
  views(): ThreadView[];
  stats(): ThreadsStats;
  /** Idempotent. Deletes every head and every reaped retained fork; late callbacks only delete. */
  close(): void;
}

export interface ThreadsDeps {
  fs: ThreadFsPort;
  now: () => number;
  /** This wireConsult instance's epoch id. */
  epoch: string;
  newId?: () => string;
  limits?: Partial<{
    maxSourceBytes: number;
    budgetBytes: number;
    maxThreads: number;
    maxPromotions: number;
    idleMs: number;
  }>;
}

function randomBase36(length: number): string {
  let s = "";
  while (s.length < length) s += Math.random().toString(36).slice(2);
  return s.slice(0, length);
}

export function createConsultThreads(deps: ThreadsDeps): ConsultThreads {
  const { fs, now, epoch } = deps;
  const maxSource = deps.limits?.maxSourceBytes ?? THREAD_MAX_SOURCE_BYTES;
  const budget = deps.limits?.budgetBytes ?? THREAD_BUDGET_BYTES;
  const maxThreads = deps.limits?.maxThreads ?? THREAD_MAX_THREADS;
  const maxPromotions = deps.limits?.maxPromotions ?? THREAD_MAX_PROMOTIONS;
  const idleMs = deps.limits?.idleMs ?? THREAD_IDLE_MS;
  const newId = deps.newId ?? (() => `th_${randomBase36(6)}`);

  let closed = false;
  let promotions = 0;
  let refusedAdoptions = 0;
  const threads = new Map<string, Thread>();
  const forks = new Map<string, ForkRec>();
  /** Leases between `begin` and `finish`: their copy size is reserved until the file exists. */
  const leases = new Set<ThreadLease>();
  const leaseOwner = new WeakMap<ThreadLease, Thread>();
  const leaseForked = new WeakSet<ThreadLease>();
  const headPaths = new Set<string>();

  const keyOf = (asker: RunId, expert: RunId): string => `${asker}\u0000${expert}`;

  function removeFile(path: string): void {
    try {
      fs.remove(path);
    } catch {
      /* never throws */
    }
  }

  function setHead(thread: Thread, head: ThreadHead | undefined): void {
    if (thread.head !== undefined) headPaths.delete(thread.head.file);
    thread.head = head;
    if (head !== undefined) headPaths.add(head.file);
  }

  function discardFork(rec: ForkRec): void {
    forks.delete(rec.path);
    if (rec.thread.candidate === rec) rec.thread.candidate = undefined;
    if (!headPaths.has(rec.path)) removeFile(rec.path);
  }

  /** Close a thread record: gen+1, closed, head deleted. In-flight forks resolve later by deletion only (R2-2). */
  function dropThread(thread: Thread): void {
    if (thread.closed) return;
    thread.closed = true;
    thread.gen += 1;
    if (threads.get(thread.key) === thread) threads.delete(thread.key);
    const head = thread.head;
    setHead(thread, undefined);
    if (head !== undefined) removeFile(head.file);
    const cand = thread.candidate;
    thread.candidate = undefined;
    if (cand !== undefined) {
      cand.eligible = false;
      // A reaped (waiting) candidate has no owner left: delete now. An
      // unreaped one is deleted by its own onReaped (never before the session is gone).
      if (cand.reaped) discardFork(cand);
    }
  }

  function forkBytes(rec: ForkRec): number {
    return Math.max(rec.reserved, fs.size(rec.path) ?? 0);
  }

  /** Σ heads + every owned in-flight/candidate fork (growing ones re-stat'd) + not-yet-copied reservations. */
  function usedBytes(exclude?: ForkRec): number {
    let total = 0;
    for (const t of threads.values()) if (t.head !== undefined) total += t.head.bytes;
    for (const rec of forks.values()) if (rec !== exclude) total += forkBytes(rec);
    for (const lease of leases) if (!leaseForked.has(lease)) total += lease.reservedBytes;
    return total;
  }

  function evictable(t: Thread): boolean {
    return t.busy === undefined && t.candidate === undefined && t.head !== undefined;
  }

  /** Evict least-recently-used idle heads of threads other than `except` until `needed` more bytes fit. */
  function makeRoom(needed: number, except?: Thread, excludeFork?: ForkRec): boolean {
    const over = (): boolean => usedBytes(excludeFork) + needed > budget;
    if (!over()) return true;
    const victims = [...threads.values()]
      .filter((t) => t !== except && evictable(t))
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const victim of victims) {
      dropThread(victim);
      if (!over()) return true;
    }
    return !over();
  }

  function evictForThreadCap(): void {
    while (threads.size >= maxThreads) {
      const all = [...threads.values()];
      const idle = all.filter((t) => t.busy === undefined && t.candidate === undefined);
      const pool = idle.length > 0 ? idle : all;
      const oldest = pool.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (oldest === undefined) return;
      dropThread(oldest);
    }
  }

  function newThread(asker: RunId, expert: RunId, sourceKey: string | undefined, register: boolean): Thread {
    if (register) evictForThreadCap();
    const key = keyOf(asker, expert);
    const thread: Thread = {
      id: newId(),
      key,
      askerRunId: asker,
      expertRunId: expert,
      epoch,
      gen: 0,
      closed: false,
      seq: 0,
      lastUsedAt: now(),
      sourceKey,
    };
    if (register) threads.set(key, thread);
    return thread;
  }

  function sweepIdle(): void {
    if (closed) return;
    const t = now();
    for (const thread of [...threads.values()]) {
      if (thread.busy !== undefined || thread.candidate !== undefined) continue;
      if (t - thread.lastUsedAt > idleMs) dropThread(thread);
    }
  }

  function makeLease(
    thread: Thread,
    p: {
      mode: ThreadMode;
      reason?: ThreadReason;
      keep: boolean;
      sourceFile: string;
      head?: ThreadHead | undefined;
      reserved: number;
      /** Override: a side lease that fell back to the original session sees NO retained answers. */
      retained?: number;
    },
  ): ThreadLease {
    const retained = p.retained ?? thread.seq;
    const lease: ThreadLease = {
      threadId: thread.id,
      epoch,
      gen: thread.gen,
      seq: retained + 1,
      mode: p.mode,
      ...(p.reason === undefined ? {} : { reason: p.reason }),
      keep: p.keep,
      sourceFile: p.sourceFile,
      retained,
      ...(p.head !== undefined && thread.base !== undefined ? { base: thread.base } : {}),
      ...(p.head === undefined ? {} : { head: { ...p.head } }),
      reservedBytes: p.reserved,
    };
    leases.add(lease);
    leaseOwner.set(lease, thread);
    if (p.keep) thread.busy = lease;
    thread.lastUsedAt = now();
    return lease;
  }

  /**
   * Non-keeping lease on a thread that already has a writer: `branch` (writer in flight) or `pending` (previous
   * answer not yet sealed). The head is used only when it passes the SAME admission as a continued consult
   * (identity, size, context/cost guard, budget pre-check); otherwise the consult is forked from the original
   * session and the lease says so truthfully (`reset` + reason, retained 0). The thread itself is never dropped
   * here — its writer is still running.
   */
  function sideLease(thread: Thread, params: BeginParams, mode: "branch" | "pending"): ThreadLease {
    const head = thread.head;
    let reason: ThreadReason | undefined;
    let headBytes: number | undefined;
    if (head !== undefined) {
      headBytes = fs.size(head.file);
      if (params.sourceKey !== undefined && thread.sourceKey !== undefined && thread.sourceKey !== params.sourceKey)
        reason = "identity";
      else if (headBytes === undefined) reason = "identity";
      else if (headBytes > maxSource) reason = "size";
      else reason = params.headGuard?.(head);
      if (reason === undefined && !makeRoom(headBytes!, thread)) reason = "budget";
      if (reason === undefined) {
        return makeLease(thread, { mode, keep: false, sourceFile: head.file, head, reserved: headBytes! });
      }
    }
    const originalBytes = fs.size(params.originalFile) ?? 0;
    if (originalBytes > maxSource) reason = "size";
    else makeRoom(originalBytes, thread);
    if (reason === undefined) {
      // No head yet: the expert sees only its original session — truthful as branch/pending with retained 0.
      return makeLease(thread, {
        mode,
        keep: false,
        sourceFile: params.originalFile,
        reserved: originalBytes,
        retained: 0,
      });
    }
    return makeLease(thread, {
      mode: "reset",
      reason,
      keep: false,
      sourceFile: params.originalFile,
      reserved: originalBytes,
      retained: 0,
    });
  }

  function begin(params: BeginParams): ThreadLease | undefined {
    if (closed) return undefined;
    sweepIdle();
    const key = keyOf(params.askerRunId, params.expertRunId);
    let thread = threads.get(key);
    let reset: ThreadReason | undefined = params.forceReset;
    let fresh = false;

    if (params.fresh === true) {
      if (thread !== undefined) dropThread(thread);
      thread = undefined;
      fresh = true;
    }

    if (thread !== undefined && thread.busy !== undefined) {
      // Single writer: a second concurrent consult is a branch off the retained head, never kept.
      return sideLease(thread, params, "branch");
    }

    if (thread !== undefined && reset === undefined) {
      if (params.sourceKey !== undefined && thread.sourceKey !== undefined && thread.sourceKey !== params.sourceKey)
        reset = "identity";
      else if (thread.head !== undefined) {
        const head = thread.head;
        const headBytes = fs.size(head.file);
        if (headBytes === undefined) reset = "identity";
        else if (thread.seq >= maxPromotions) reset = "seq-cap";
        else if (headBytes > maxSource) reset = "size";
        else reset = params.headGuard?.(head);
      } else if (thread.seq >= maxPromotions) reset = "seq-cap";
    }

    if (thread !== undefined && reset !== undefined) {
      dropThread(thread);
      thread = undefined;
    }

    if (thread !== undefined) {
      // Open thread, idle writer. An unresolved candidate means the previous answer is not retained yet.
      if (thread.candidate !== undefined) return sideLease(thread, params, "pending");
      const head = thread.head;
      const reserved = (head === undefined ? fs.size(params.originalFile) : (fs.size(head.file) ?? head.bytes)) ?? 0;
      if (!makeRoom(reserved, thread)) {
        // Cannot hold another copy: degrade to a one-off (not kept); the thread is dropped.
        dropThread(thread);
        thread = undefined;
        reset = "budget";
      } else {
        return makeLease(thread, {
          mode: head === undefined ? "new" : "continued",
          keep: true,
          sourceFile: head?.file ?? params.originalFile,
          head,
          reserved,
        });
      }
    }

    // No usable thread: new / fresh / reset — the source is always the original session.
    const originalBytes = fs.size(params.originalFile);
    if (originalBytes !== undefined && originalBytes > maxSource) {
      // Too big to ever hold: an untracked one-off (its own throw-away record, never registered).
      const detached = newThread(params.askerRunId, params.expertRunId, params.sourceKey, false);
      return makeLease(detached, {
        mode: "reset",
        reason: "size",
        keep: false,
        sourceFile: params.originalFile,
        reserved: 0,
      });
    }
    const reserved = originalBytes ?? 0;
    if (reset === undefined && !makeRoom(reserved)) reset = "budget";
    const created = newThread(params.askerRunId, params.expertRunId, params.sourceKey, true);
    return makeLease(created, {
      mode: reset !== undefined ? "reset" : fresh ? "fresh" : "new",
      ...(reset === undefined ? {} : { reason: reset }),
      // plan §4.2 ②: a reset (other than the explicit `fresh`) is a one-off, never retained.
      keep: reset === undefined,
      sourceFile: params.originalFile,
      reserved,
    });
  }

  function openFork(lease: ThreadLease, path: string): boolean {
    const thread = leaseOwner.get(lease);
    if (closed || thread === undefined || lease.epoch !== epoch || forks.has(path)) return false;
    const rec: ForkRec = {
      path,
      thread,
      gen: lease.gen,
      epoch: lease.epoch,
      keep: lease.keep,
      reserved: lease.reservedBytes,
      decided: false,
      eligible: false,
      reaped: false,
      sealed: false,
    };
    forks.set(path, rec);
    leaseForked.add(lease);
    if (lease.keep && !thread.closed && thread.gen === lease.gen) thread.candidate = rec;
    return true;
  }

  function finish(lease: ThreadLease): void {
    leases.delete(lease);
    const thread = leaseOwner.get(lease);
    if (thread === undefined) return;
    if (thread.busy === lease) thread.busy = undefined;
    thread.lastUsedAt = now();
  }

  function abandonFork(lease: ThreadLease, path: string): void {
    const rec = forks.get(path);
    if (rec === undefined) return;
    forks.delete(path);
    if (rec.thread.candidate === rec) rec.thread.candidate = undefined;
    leaseForked.delete(lease);
  }

  function noteDigest(lease: ThreadLease, digest: string): boolean {
    const thread = leaseOwner.get(lease);
    if (thread === undefined || thread.closed || thread.gen !== lease.gen) return true;
    if (thread.snapDigest === undefined) {
      thread.snapDigest = digest;
      return true;
    }
    return thread.snapDigest === digest;
  }

  /** Promote when every condition holds; otherwise delete the file. Called once both facts are known. */
  function resolve(rec: ForkRec): ReapVerdict {
    const thread = rec.thread;
    if (
      closed ||
      rec.epoch !== epoch ||
      thread.closed ||
      thread.gen !== rec.gen ||
      thread.candidate !== rec ||
      !rec.keep ||
      !rec.eligible ||
      !rec.sealed
    ) {
      discardFork(rec);
      return "delete";
    }
    // R2-3: re-stat the real size before adoption (the file kept growing until dispose).
    const actual = fs.size(rec.path);
    if (actual === undefined || actual > maxSource || !makeRoom(actual - (thread.head?.bytes ?? 0), thread, rec)) {
      refusedAdoptions += 1;
      discardFork(rec);
      return "delete";
    }
    const oldHead = thread.head;
    forks.delete(rec.path);
    thread.candidate = undefined;
    setHead(thread, {
      file: rec.path,
      bytes: actual,
      consultRunId: rec.consultRunId ?? "",
      tokens: rec.tokens ?? 0,
      ...(rec.percent === undefined ? {} : { percent: rec.percent }),
    });
    thread.seq += 1;
    thread.lastUsedAt = now();
    if (thread.base === undefined && rec.base !== undefined) thread.base = rec.base;
    promotions += 1;
    if (oldHead !== undefined) removeFile(oldHead.file);
    return "keep";
  }

  function settle(path: string, result: SettleParams): void {
    const rec = forks.get(path);
    if (rec === undefined || rec.decided) return;
    rec.decided = true;
    rec.eligible = result.eligible && rec.keep;
    if (result.tokens !== undefined) rec.tokens = result.tokens;
    if (result.percent !== undefined) rec.percent = result.percent;
    if (result.consultRunId !== undefined) rec.consultRunId = result.consultRunId;
    if (result.base !== undefined) rec.base = result.base;
    if (!rec.eligible && rec.thread.candidate === rec) rec.thread.candidate = undefined;
    if (rec.reaped) resolve(rec);
  }

  function onReaped(path: string, info?: { disposed: boolean }): ReapVerdict {
    // Never delete a retained head, even on a duplicate callback.
    if (headPaths.has(path)) return "keep";
    const rec = forks.get(path);
    if (rec === undefined) return "delete";
    rec.reaped = true;
    rec.sealed = info?.disposed === true;
    if (!rec.sealed) {
      // R2-1: no proof the session is gone ⇒ never adopt; delete (legacy behaviour).
      rec.eligible = false;
      discardFork(rec);
      return "delete";
    }
    // Sealed but the tool has not judged eligibility yet: keep the file; settle() finishes the job.
    if (!rec.decided && !closed && rec.thread.candidate === rec) return "keep";
    if (!rec.decided) {
      discardFork(rec);
      return "delete";
    }
    return resolve(rec);
  }

  function onRunTerminal(runId: RunId): void {
    if (closed) return;
    for (const thread of [...threads.values()]) {
      if (thread.askerRunId === runId) dropThread(thread);
    }
    sweepIdle();
  }

  function close(): void {
    if (closed) return;
    closed = true;
    for (const thread of [...threads.values()]) dropThread(thread);
    for (const rec of [...forks.values()]) {
      rec.eligible = false;
      rec.thread.candidate = undefined;
      // A reaped file has no live writer: delete now. An unreaped one is deleted by its own
      // late onReaped (the verdict after close is always "delete"); never before its session is gone.
      if (rec.reaped) discardFork(rec);
    }
    leases.clear();
  }

  return {
    epoch,
    begin,
    openFork,
    finish,
    abandonFork,
    noteDigest,
    settle,
    onReaped,
    onRunTerminal,
    sweepIdle,
    isHead: (path) => headPaths.has(path),
    views: () =>
      [...threads.values()].map((t) => ({
        id: t.id,
        askerRunId: t.askerRunId,
        expertRunId: t.expertRunId,
        gen: t.gen,
        seq: t.seq,
        ...(t.head === undefined ? {} : { headFile: t.head.file }),
        hasCandidate: t.candidate !== undefined,
        busy: t.busy !== undefined,
      })),
    stats: () => ({
      threads: threads.size,
      heads: [...threads.values()].filter((t) => t.head !== undefined).length,
      forks: forks.size,
      usedBytes: usedBytes(),
      promotions,
      refusedAdoptions,
      closed,
    }),
    close,
  };
}
