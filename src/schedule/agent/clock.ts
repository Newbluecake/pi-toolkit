/**
 * Scheduled tasks — SessionClock (plan r3 §4.4, §4.5a, §4.6; A0).
 *
 * The per-session timer that turns occurrences into claims. It owns NO ledger semantics: every
 * decision is one S1 transaction (`autoClaim`, `sweep`, `recoverRuns`); this module only decides
 * WHEN to ask.
 *
 *  - `armedSince` (fixed at construction = stack build): occurrences before it are never fired by
 *    this process (§4.4 — a session opened after T may not execute T; sweep judges it later).
 *  - One segmented, unref'd timer armed at the earliest claimable occurrence over all executable
 *    tasks: smallest T with T > decidedThrough and T ≥ armedSince (late ⇒ autoClaim records missed).
 *  - Startup: sweep (bounded rounds while `more`) → recover dead holders → arm.
 *  - Supplemental sweep: when sweep reports an in-tolerance occurrence this process cannot fire,
 *    `plan.supplementalAt` (= T + tol + 1 s) re-sweeps then.
 *  - 30 s poll: a `stat` of state.json; a change re-reads rev ⇒ sweep + rearm; non-terminal runs held
 *    by OTHER holders ⇒ `recoverRuns` (§4.6 periodic recovery). Root not created yet ⇒ the store
 *    port is re-resolved (lazy, read-only).
 *  - 60 s heartbeat: |Δwall − Δmono| > 60 s (sleep / clock jump) ⇒ sweep + rearm.
 *  - `poke()` (turn_start / local write): rev changed ⇒ sweep + rearm.
 *  - A claim whose ledger commit is `uncertain` (rename done, dir fsync failed, S1 review M5) is
 *    never dispatched; a follow-up re-read finishes such a run of OURS as `unknown(no-outcome)`.
 *
 * Zero-hang: every timer is created through the injected `Clock` (production: the unref'd segmented
 * `systemClock`); all async work is serialized on one chain and re-checks `disposed` after each
 * await. Nothing here keeps a process alive.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import type { Clock, TimerHandle } from "../../core/clock.js";
import { autoClaim, recoverRuns, sweep, type AutoClaimResult, type ClaimGate } from "../core/claim.js";
import { nextOccurrence } from "../core/cron.js";
import { compileTask, SCHED_SUPPLEMENTAL_SWEEP_DELAY_MS } from "../core/occurrence.js";
import { sameHolder, type JudgeOpts, type ProcessIdentity } from "../core/recovery.js";
import {
  autoRunKey,
  defHash,
  isExecutable,
  isTerminalRunState,
  SCHED_FIRE_TOLERANCE_MS,
  SCHED_STATE_FILE,
  type Holder,
  type RunRecord,
  type ScheduleStateFile,
  type ScheduleTask,
} from "../core/spec.js";
import { finishRun, findRun, type SessionStore } from "../core/writer.js";
import type { ScheduleRefusal } from "./mode.js";

export const SCHED_POLL_MS = 30_000;
export const SCHED_HEARTBEAT_MS = 60_000;
/** Wall/monotonic divergence that counts as a clock jump (§4.4). */
export const SCHED_DRIFT_MS = 60_000;
/** Max sweep rounds per sweep request (each ≤ 64 × 10 000 occurrences). */
export const SCHED_SWEEP_ROUNDS = 8;
/** Lock contention retry delay while the occurrence is still inside tolerance. */
export const SCHED_BUSY_RETRY_MS = 2_000;
/** Delay before re-reading the ledger after an uncertain claim commit. */
export const SCHED_UNCERTAIN_RECHECK_MS = 5_000;

/** Lazily resolved store: undefined while the store root does not exist yet. Never throws. */
export interface StorePort {
  get(): SessionStore | undefined;
}

export interface SessionClockDeps {
  store: StorePort;
  holder: Holder;
  self: ProcessIdentity;
  armedSince: number;
  /** Timers (production: unref'd `systemClock`). `clock.now()` is the business clock. */
  clock: Clock;
  monotonic?: () => number;
  /** In-lock gate (`assertExecutable` without a task). */
  gate: ClaimGate;
  /** Lock-free per-task pre-check (`assertExecutable(task)`: owner cwd vault check, executor present). */
  preflight?: (task: ScheduleTask) => ScheduleRefusal | undefined;
  judge?: JudgeOpts;
  /** A `fired` claim: the run is ours; hand it to the executor (must not throw; owns the terminal write). */
  onFired: (run: RunRecord, task: ScheduleTask) => void;
  /** The ledger was written by this clock (coordinator pushes `sched_changed`). */
  onChanged?: () => void;
  warn?: (message: string) => void;
}

export interface SessionClockStatus {
  /** Earliest armed occurrence (UTC ms), if any. */
  nextAt: number | undefined;
  /** Task armed for `nextAt`. */
  nextTaskId: string | undefined;
  /** Last seen ledger rev (0 = absent). */
  rev: number;
  degraded: string | undefined;
}

export interface SessionClock {
  start(): Promise<void>;
  /** Cheap rev check (turn_start, external write signal): changed ⇒ sweep + rearm. */
  poke(): void;
  /** Unconditional sweep + recover + rearm (after a local write by A3, store root created, …). */
  refresh(): Promise<void>;
  status(): SessionClockStatus;
  /** Resolves when the serialized work chain is idle (tests / shutdown). */
  idle(): Promise<void>;
  dispose(): void;
}

interface FileStamp {
  ino: number;
  size: number;
  mtimeMs: number;
}

export function createSessionClock(deps: SessionClockDeps): SessionClock {
  const clock = deps.clock;
  const mono = deps.monotonic ?? (() => performance.now());
  const warn = deps.warn ?? ((m: string) => console.warn(`[pi-subagent] schedule: ${m}`));
  let disposed = false;
  let chain: Promise<void> = Promise.resolve();
  let fireTimer: TimerHandle | undefined;
  let supplementalTimer: TimerHandle | undefined;
  let supplementalAt: number | undefined;
  let pollTimer: TimerHandle | undefined;
  let beatTimer: TimerHandle | undefined;
  const retryTimers = new Set<TimerHandle>();
  /** Per-task floor: occurrences ≤ floor were already attempted by this clock (no re-fire loop). */
  const tried = new Map<string, number>();
  let lastRev = -1;
  let lastStamp: FileStamp | undefined;
  let degraded: string | undefined;
  let next: { t: number; taskId: string } | undefined;
  let beatWall = clock.now();
  let beatMono = mono();

  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    const p = chain.then(async () => {
      if (disposed) return;
      try {
        await fn();
      } catch (err) {
        warn(`clock step failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    chain = p;
    return p;
  };

  const clear = (h: TimerHandle | undefined): undefined => {
    if (h !== undefined) clock.clearTimer(h);
    return undefined;
  };

  function snapshot(): ScheduleStateFile | undefined {
    const store = deps.store.get();
    if (store === undefined) {
      lastRev = 0;
      return undefined;
    }
    const r = store.read();
    if (r.kind === "ok") {
      degraded = undefined;
      lastRev = r.state.rev;
      return r.state;
    }
    if (r.kind === "absent") {
      degraded = undefined;
      lastRev = 0;
      return undefined;
    }
    if (degraded !== r.reason) warn(`ledger degraded (${r.reason}): ${r.detail} — /schedule repair`);
    degraded = r.reason;
    return undefined;
  }

  function stampOf(store: SessionStore): FileStamp | undefined {
    try {
      const st = statSync(join(store.root.real, store.dirName, SCHED_STATE_FILE));
      return { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return undefined;
    }
  }

  /**
   * Next occurrence this clock should claim: T > decidedThrough, T ≥ armedSince, above the per-task
   * floor. A T already past tolerance is still claimed — `autoClaim`'s late branch records it as
   * missed(late) — so a timer that fires late never leaves an occurrence undecided.
   */
  function candidate(task: ScheduleTask, state: ScheduleStateFile): number | undefined {
    const occ = state.occ[task.id];
    if (occ === undefined || !isExecutable(task) || occ.defHash !== defHash(task)) return undefined;
    const c = compileTask(task);
    if (c === undefined) return undefined;
    const after = Math.max(occ.decidedThrough, deps.armedSince - 1, tried.get(task.id) ?? Number.NEGATIVE_INFINITY);
    return nextOccurrence(c, after);
  }

  function arm(): void {
    fireTimer = clear(fireTimer);
    next = undefined;
    if (disposed) return;
    const state = snapshot();
    if (state === undefined) return;
    const now = clock.now();
    for (const task of state.tasks) {
      const t = candidate(task, state);
      if (t !== undefined && (next === undefined || t < next.t)) next = { t, taskId: task.id };
    }
    if (next === undefined) return;
    fireTimer = clock.setTimer(Math.max(0, next.t - now), () => {
      fireTimer = undefined;
      void enqueue(fireDue);
    });
  }

  /** Pending supplemental sweep instants (deduped, bounded); one timer targets the earliest. */
  const supplementals = new Set<number>();
  const SUPPLEMENTALS_MAX = 64;

  function armSupplemental(): void {
    supplementalTimer = clear(supplementalTimer);
    supplementalAt = undefined;
    if (disposed || supplementals.size === 0) return;
    const at = Math.min(...supplementals);
    supplementalAt = at;
    supplementalTimer = clock.setTimer(Math.max(0, at - clock.now()), () => {
      supplementalTimer = undefined;
      supplementalAt = undefined;
      const now = clock.now();
      for (const t of supplementals) if (t <= now) supplementals.delete(t);
      void enqueue(async () => {
        await doSweep();
        arm();
      }).finally(armSupplemental);
    });
  }

  function scheduleSupplemental(at: number | undefined): void {
    if (at === undefined || disposed || supplementals.has(at)) return;
    if (supplementals.size >= SUPPLEMENTALS_MAX) supplementals.delete(Math.max(...supplementals));
    supplementals.add(at);
    if (supplementalAt === undefined || at < supplementalAt) armSupplemental();
  }

  async function doSweep(): Promise<void> {
    const store = deps.store.get();
    if (store === undefined) return;
    for (let round = 0; round < SCHED_SWEEP_ROUNDS && !disposed; round++) {
      const r = await sweep(store, { armedSince: deps.armedSince });
      if (r.kind === "error") {
        if (r.code !== "E_BUSY") warn(`sweep: ${r.code} ${r.detail}`);
        return;
      }
      if (r.wrote) deps.onChanged?.();
      scheduleSupplemental(r.plan.supplementalAt);
      if (!r.plan.tasks.some((t) => t.more)) return;
    }
  }

  async function doRecover(force: boolean): Promise<void> {
    const store = deps.store.get();
    if (store === undefined) return;
    if (!force) {
      const r = store.read();
      if (r.kind !== "ok") return;
      // Only foreign holders can be dead; our own runs are ours to finish.
      const foreign = r.state.runs.some(
        (run) => !isTerminalRunState(run.state) && !sameHolder(run.holder, deps.holder),
      );
      if (!foreign) return;
    }
    const r = await recoverRuns(store, deps.self, deps.judge ?? {});
    if (r.kind === "error") {
      if (r.code !== "E_BUSY") warn(`recover: ${r.code} ${r.detail}`);
      return;
    }
    if (r.runs.length > 0) deps.onChanged?.();
  }

  async function fireDue(): Promise<void> {
    const store = deps.store.get();
    const state = snapshot();
    if (store === undefined || state === undefined) return arm();
    const now = clock.now();
    for (const task of state.tasks) {
      if (disposed) return;
      const t = candidate(task, state);
      if (t === undefined || t > now) continue;
      const refusal = deps.preflight?.(task);
      if (refusal !== undefined) {
        tried.set(task.id, t); // not claimed: sweep decides T once it is past tolerance
        scheduleSupplemental(t + SCHED_FIRE_TOLERANCE_MS + SCHED_SUPPLEMENTAL_SWEEP_DELAY_MS);
        continue;
      }
      const res = await autoClaim(store, {
        taskId: task.id,
        t,
        armedSince: deps.armedSince,
        holder: deps.holder,
        gate: deps.gate,
      });
      if (disposed) return;
      handleClaim(store, task, t, res);
    }
    arm();
  }

  function handleClaim(store: SessionStore, task: ScheduleTask, t: number, res: AutoClaimResult): void {
    switch (res.kind) {
      case "fired":
        tried.set(task.id, t);
        deps.onChanged?.();
        try {
          deps.onFired(res.run, task);
        } catch (err) {
          warn(`executor threw for ${res.run.runKey}: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      case "overlap":
      case "missed":
        tried.set(task.id, t);
        deps.onChanged?.();
        return;
      case "lost":
        tried.set(task.id, t);
        return;
      case "ineligible":
        // "early": the wall clock is behind T (rollback) — leave it; arm() re-targets T.
        if (res.reason !== "early") {
          tried.set(task.id, t);
          scheduleSupplemental(t + SCHED_FIRE_TOLERANCE_MS + SCHED_SUPPLEMENTAL_SWEEP_DELAY_MS);
        }
        return;
      case "error":
        tried.set(task.id, t);
        if (res.uncertain === true) {
          scheduleRetry(SCHED_UNCERTAIN_RECHECK_MS, () => settleUncertain(store, autoRunKey(task.id, t)));
          return;
        }
        if (res.code === "E_BUSY" && clock.now() + SCHED_BUSY_RETRY_MS <= t + SCHED_FIRE_TOLERANCE_MS) {
          scheduleRetry(SCHED_BUSY_RETRY_MS, async () => {
            if (tried.get(task.id) === t) tried.delete(task.id);
            await fireDue();
          });
          return;
        }
        if (res.code !== "E_BUSY") warn(`claim ${task.id}@${t}: ${res.code} ${res.detail}`);
        return;
    }
  }

  function scheduleRetry(ms: number, fn: () => Promise<void>): void {
    const h = clock.setTimer(ms, () => {
      retryTimers.delete(h);
      void enqueue(fn);
    });
    retryTimers.add(h);
  }

  /** S1 review M5 follow-up: a run of OURS written by an uncertain commit is never dispatched. */
  async function settleUncertain(store: SessionStore, runKey: string): Promise<void> {
    const r = await store.transact((draft, ctx) => {
      const run = findRun(draft, runKey);
      if (run === undefined || isTerminalRunState(run.state) || !sameHolder(run.holder, deps.holder)) {
        return { value: false, write: false };
      }
      finishRun(draft, runKey, { state: "unknown", reason: "no-outcome" }, ctx.now);
      return { value: true, write: true };
    });
    if (r.ok && r.value) deps.onChanged?.();
    else if (!r.ok && r.code === "E_BUSY")
      scheduleRetry(SCHED_UNCERTAIN_RECHECK_MS, () => settleUncertain(store, runKey));
  }

  async function full(forceRecover: boolean): Promise<void> {
    await doSweep();
    if (disposed) return;
    await doRecover(forceRecover);
    if (disposed) return;
    const store = deps.store.get();
    if (store !== undefined) lastStamp = stampOf(store);
    arm();
  }

  function schedulePoll(): void {
    pollTimer = clock.setTimer(SCHED_POLL_MS, () => {
      pollTimer = undefined;
      void enqueue(async () => {
        const store = deps.store.get();
        if (store !== undefined) {
          const stamp = stampOf(store);
          const changed =
            stamp?.ino !== lastStamp?.ino || stamp?.size !== lastStamp?.size || stamp?.mtimeMs !== lastStamp?.mtimeMs;
          lastStamp = stamp;
          if (changed) {
            const before = lastRev;
            snapshot();
            if (lastRev !== before) await doSweep();
          }
          await doRecover(false);
          if (changed) arm();
        }
      }).finally(() => {
        if (!disposed) schedulePoll();
      });
    });
  }

  function scheduleBeat(): void {
    beatTimer = clock.setTimer(SCHED_HEARTBEAT_MS, () => {
      beatTimer = undefined;
      const wall = clock.now();
      const m = mono();
      const drift = wall - beatWall - (m - beatMono);
      beatWall = wall;
      beatMono = m;
      if (Math.abs(drift) > SCHED_DRIFT_MS) {
        void enqueue(async () => {
          await doSweep();
          arm();
        });
      }
      if (!disposed) scheduleBeat();
    });
  }

  return {
    async start() {
      if (disposed) return;
      await enqueue(() => full(true));
      if (disposed) return;
      beatWall = clock.now();
      beatMono = mono();
      if (pollTimer === undefined) schedulePoll();
      if (beatTimer === undefined) scheduleBeat();
    },
    poke() {
      void enqueue(async () => {
        const before = lastRev;
        snapshot();
        if (lastRev === before) return;
        await doSweep();
        arm();
      });
    },
    refresh() {
      return enqueue(() => full(false));
    },
    status() {
      return { nextAt: next?.t, nextTaskId: next?.taskId, rev: Math.max(0, lastRev), degraded };
    },
    idle() {
      return chain;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      fireTimer = clear(fireTimer);
      supplementalTimer = clear(supplementalTimer);
      supplementals.clear();
      pollTimer = clear(pollTimer);
      beatTimer = clear(beatTimer);
      for (const h of retryTimers) clock.clearTimer(h);
      retryTimers.clear();
      next = undefined;
    },
  };
}
