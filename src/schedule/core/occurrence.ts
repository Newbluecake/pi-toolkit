/**
 * Scheduled tasks — occurrence verdicts: watermark, sweep with the tolerance cut-off, missedLog
 * (plan r3 §4.4, S1). Pure functions over a state snapshot / draft; all cron work happens here,
 * OUTSIDE the lock (the writer only applies the resulting plan under the lock).
 *
 * Three mutually exclusive verdicts per auto occurrence T (UTC ms):
 *   - executed — only by a claim (claim.ts) while `now ≤ T + tol`;
 *   - missed   — only once `now > T + tol` (sweep, or a claim's late branch);
 *   - skipped  — overlap / D13 coalescing (`skippedTotal`, never counted as missed).
 * `decidedThrough` is the monotone watermark: every T ≤ it has a verdict.
 *
 * Sweep: `cut = now − tol − 1` (so `T ≤ cut ⇔ now > T + tol` — the claim's execution bound
 * `now ≤ T + tol` and the sweep can never both own the same T). Only `decidedThrough < T ≤ cut`
 * is decided; occurrences still inside the tolerance window are left to the owning timer, or to a
 * supplemental sweep at `T + tol + 1s` when this process armed after T.
 *
 * missedLog chunks: each `MissedEntry` covers `(from, to]` where `to` is an occurrence and `count
 * = countOccurrences(def, from, to)` EXACTLY (≤ SCHED_COUNT_CAP per entry — a longer gap is split
 * into consecutive entries, at most 64 per sweep, the rest left for the next sweep).
 */
import { countOccurrences, compileWhen, nextOccurrence, occurrencesBetween, type CompiledWhen } from "./cron.js";
import {
  defHash,
  isExecutable,
  SCHED_COUNT_CAP,
  SCHED_FIRE_TOLERANCE_MS,
  SCHED_MISSED_LOG_MAX,
  type MissedCause,
  type MissedEntry,
  type OccState,
  type ScheduleStateFile,
  type ScheduleTask,
} from "./spec.js";

export const SCHED_SUPPLEMENTAL_SWEEP_DELAY_MS = 1_000;
/** Max missedLog entries one sweep / late claim appends; the remainder waits for the next sweep. */
export const SCHED_SWEEP_MAX_CHUNKS = SCHED_MISSED_LOG_MAX;

/** Largest T the sweep may decide at `now` (`T ≤ cut ⇔ now > T + tol`). */
export function sweepCut(now: number): number {
  return now - SCHED_FIRE_TOLERANCE_MS - 1;
}

/** Still inside the online execution window (`now ≤ T + tol`). */
export function withinTolerance(t: number, now: number): boolean {
  return now <= t + SCHED_FIRE_TOLERANCE_MS;
}

/** Fresh occurrence state for a newly created task: nothing before `now` is ever owed. */
export function initOcc(task: ScheduleTask, now: number): OccState {
  return { defHash: defHash(task), decidedThrough: now, firedTotal: 0, missedTotal: 0, skippedTotal: 0, missedLog: [] };
}

/** Pause→resume, approval, definition change: occurrences before `now` are void, never missed. */
export function voidUntil(occ: OccState, now: number): void {
  occ.decidedThrough = Math.max(occ.decidedThrough, now);
}

export interface MissedChunk {
  from: number;
  to: number;
  count: number;
}

export interface ChunkPlan {
  chunks: MissedChunk[];
  /** Watermark after applying the chunks (= last chunk's `to`, or `from` when none). */
  reached: number;
  /** True ⇔ occurrences ≤ `through` remain undecided (chunk budget hit). */
  more: boolean;
}

/** Split the occurrences in `(from, through]` into exact-count chunks of ≤ SCHED_COUNT_CAP. */
export function planMissedChunks(
  c: CompiledWhen,
  from: number,
  through: number,
  maxChunks = SCHED_SWEEP_MAX_CHUNKS,
): ChunkPlan {
  const chunks: MissedChunk[] = [];
  let cur = from;
  while (cur < through) {
    if (chunks.length >= maxChunks) return { chunks, reached: cur, more: true };
    const ts = occurrencesBetween(c, cur, through, SCHED_COUNT_CAP);
    if (ts.length === 0) break;
    const to = ts[ts.length - 1]!;
    chunks.push({ from: cur, to, count: ts.length });
    cur = to;
    if (ts.length < SCHED_COUNT_CAP) break;
  }
  return { chunks, reached: cur, more: false };
}

/** Append chunks to `occ` (seq, totalAfter, truncation to the last 64 entries). */
export function appendMissed(
  occ: OccState,
  chunks: readonly MissedChunk[],
  hash: string,
  cause: MissedCause,
  at: number,
): MissedEntry[] {
  const out: MissedEntry[] = [];
  for (const ch of chunks) {
    if (ch.count <= 0) continue;
    const seq = (occ.missedLog[occ.missedLog.length - 1]?.seq ?? 0) + 1;
    occ.missedTotal += ch.count;
    const e: MissedEntry = {
      seq,
      defHash: hash,
      from: ch.from,
      to: ch.to,
      count: ch.count,
      totalAfter: occ.missedTotal,
      at,
      cause,
    };
    occ.missedLog.push(e);
    out.push(e);
  }
  if (occ.missedLog.length > SCHED_MISSED_LOG_MAX) occ.missedLog.splice(0, occ.missedLog.length - SCHED_MISSED_LOG_MAX);
  return out;
}

/** Compile a task's `when`, or undefined (never-hitting / invalid ⇒ the caller shows degraded). */
export function compileTask(task: ScheduleTask): CompiledWhen | undefined {
  const r = compileWhen(task.when);
  return r.ok ? r.when : undefined;
}

// ----------------------------------------------------------------- sweep plan

export interface SweepTaskPlan {
  taskId: string;
  /** Definition version the chunks were computed for (must still match at apply time). */
  defHash: string;
  decidedThrough: number;
  chunks: MissedChunk[];
  reached: number;
  more: boolean;
  cause: MissedCause;
  /** once task fully decided by this sweep ⇒ disable it. */
  disableOnce: boolean;
}

export interface SweepPlan {
  now: number;
  cut: number;
  tasks: SweepTaskPlan[];
  /** occ.defHash ≠ defHash(task) (external edit): rebase the watermark, never count. */
  rebase: string[];
  /** Latest lock-time `now` at which this plan is still exact (∞ when nothing can change). */
  validUntil: number;
  /** Undecided occurrences still inside the tolerance window (sorted by t). */
  inTolerance: Array<{ taskId: string; t: number }>;
  /** When to run the supplemental sweep for in-tolerance occurrences this process cannot fire. */
  supplementalAt?: number;
}

export interface SweepOpts {
  /** This process's `armedSince` (occurrences ≥ it are fired by its own timer, not swept early). */
  armedSince?: number;
  /** Restrict to these tasks (definition change: sweep the old definition of one task). */
  taskIds?: readonly string[];
}

/** Compute (outside the lock) what a sweep at `now` would decide. Pure. */
export function planSweep(state: ScheduleStateFile, now: number, opts: SweepOpts = {}): SweepPlan {
  const cut = sweepCut(now);
  const plan: SweepPlan = { now, cut, tasks: [], rebase: [], validUntil: Number.POSITIVE_INFINITY, inTolerance: [] };
  for (const task of state.tasks) {
    if (opts.taskIds !== undefined && !opts.taskIds.includes(task.id)) continue;
    const occ = state.occ[task.id];
    if (occ === undefined || !isExecutable(task)) continue;
    const hash = defHash(task);
    if (occ.defHash !== hash) {
      plan.rebase.push(task.id);
      continue;
    }
    const c = compileTask(task);
    if (c === undefined) continue;
    const dt = occ.decidedThrough;
    const cp = cut > dt ? planMissedChunks(c, dt, cut) : { chunks: [], reached: dt, more: false };
    const once = task.when.kind === "once";
    if (cp.chunks.length > 0 || cp.more) {
      plan.tasks.push({
        taskId: task.id,
        defHash: hash,
        decidedThrough: dt,
        ...cp,
        cause: once ? "once-past" : "offline",
        disableOnce: once && !cp.more,
      });
    }
    if (cp.more) continue; // the rest is decided by the next sweep; this plan cannot go stale
    // The next undecided occurrence after max(reached, cut) decides how long the plan stays exact.
    const after = Math.max(cp.reached, cut);
    const n = nextOccurrence(c, after);
    if (n === undefined) continue;
    plan.validUntil = Math.min(plan.validUntil, n + SCHED_FIRE_TOLERANCE_MS);
    if (n <= now) {
      plan.inTolerance.push({ taskId: task.id, t: n });
      if (opts.armedSince === undefined || opts.armedSince > n) {
        const at = n + SCHED_FIRE_TOLERANCE_MS + SCHED_SUPPLEMENTAL_SWEEP_DELAY_MS;
        plan.supplementalAt = Math.min(plan.supplementalAt ?? at, at);
      }
    }
  }
  plan.inTolerance.sort((a, b) => a.t - b.t);
  return plan;
}

export function sweepPlanIsEmpty(plan: SweepPlan): boolean {
  return plan.tasks.length === 0 && plan.rebase.length === 0;
}

/**
 * Apply a sweep plan to a draft taken under the lock. Each task plan is re-verified against the
 * draft (definition hash and watermark unchanged) — a mismatch skips that task (the caller's rev
 * check normally makes this impossible). Returns the appended entries.
 */
export function applySweep(draft: ScheduleStateFile, plan: SweepPlan, at: number): MissedEntry[] {
  const out: MissedEntry[] = [];
  for (const tp of plan.tasks) {
    const task = draft.tasks.find((t) => t.id === tp.taskId);
    const occ = draft.occ[tp.taskId];
    if (
      task === undefined ||
      occ === undefined ||
      occ.defHash !== tp.defHash ||
      occ.decidedThrough !== tp.decidedThrough
    ) {
      continue;
    }
    out.push(...appendMissed(occ, tp.chunks, tp.defHash, tp.cause, at));
    occ.decidedThrough = Math.max(occ.decidedThrough, tp.reached);
    if (tp.disableOnce) task.enabled = false;
  }
  for (const id of plan.rebase) {
    const task = draft.tasks.find((t) => t.id === id);
    const occ = draft.occ[id];
    if (task === undefined || occ === undefined) continue;
    occ.defHash = defHash(task);
    voidUntil(occ, plan.now);
  }
  return out;
}

/** once verdict derived from the ledger (spec has no task `reason` field — S1 deviation). */
export function onceVerdict(task: ScheduleTask, occ: OccState | undefined): "once-done" | "once-past" | undefined {
  if (task.when.kind !== "once" || task.enabled || occ === undefined) return undefined;
  if (occ.firedTotal > 0) return "once-done";
  if (occ.missedTotal > 0) return "once-past";
  return undefined;
}
