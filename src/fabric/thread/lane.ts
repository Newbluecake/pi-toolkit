/**
 * fabric-thread P1 (arch r3 §6.5): the two bounded queues of the fast path.
 *
 * - `ThreadLane` — ONE per thread: FIFO, at most 1 event in fan-out (“在途 1”), wait ≤ 8
 *   (`fabric.threads.laneWait`). An event's lane occupancy lasts until dispatch is complete in
 *   the CUSTODY sense: every subscriber either took the event (buffered) or reached a terminal
 *   outcome. A steer that was called but has not settled keeps the lane busy (S11: event 2 waits
 *   in the LANE, not the run gate); a buffered handoff does NOT (the buffer owns the rest).
 * - `RunGate` — ONE per run: at most 1 thread steer in flight, wait ≤ 4 (§6.5 per-run 串行; the
 *   5th waiter records `none` BEFORE any pi call — safe fallback). Shared by lane steers and
 *   flush steers (“冲刷…复用 per-run 串行”).
 *
 * Both are dumb ordered containers: the engine owns deadlines, outcomes and generation checks.
 */
import type { ThreadEventId, ThreadRunId } from "./types.js";

export class ThreadLane {
  private waitQ: ThreadEventId[] = [];
  private inflightEvent: ThreadEventId | undefined;

  constructor(readonly maxWait: number) {}

  get inFlight(): ThreadEventId | undefined {
    return this.inflightEvent;
  }

  get waitingCount(): number {
    return this.waitQ.length;
  }

  waitFull(): boolean {
    return this.waitQ.length >= this.maxWait;
  }

  /** §6.5/R5 admission predicate: an event can ALWAYS enter a free lane (it goes straight to
   *  fan-out and never actually waits); the wait cap only binds while the lane is busy. */
  canAccept(): boolean {
    return this.inflightEvent === undefined || this.waitQ.length < this.maxWait;
  }

  /** §6.3 R5 predicate input. Mirrors {@link canAccept} (kept in lockstep). */
  enqueue(eventId: ThreadEventId): boolean {
    if (!this.canAccept()) return false;
    this.waitQ.push(eventId);
    return true;
  }

  /** Take the head into fan-out — only when the lane is free. */
  begin(): ThreadEventId | undefined {
    if (this.inflightEvent !== undefined) return undefined;
    const next = this.waitQ.shift();
    if (next === undefined) return undefined;
    this.inflightEvent = next;
    return next;
  }

  /** Release the in-flight slot (dispatch complete in the custody sense). */
  complete(eventId: ThreadEventId): boolean {
    if (this.inflightEvent !== eventId) return false;
    this.inflightEvent = undefined;
    return true;
  }

  /** §6.5 deadline removal while still waiting (lane_timeout). */
  removeWaiting(eventId: ThreadEventId): boolean {
    const i = this.waitQ.indexOf(eventId);
    if (i < 0) return false;
    this.waitQ.splice(i, 1);
    return true;
  }

  waiting(): readonly ThreadEventId[] {
    return this.waitQ;
  }
}

export interface RunSteerTask {
  readonly runId: ThreadRunId;
  readonly eventId: ThreadEventId;
  readonly subId: string;
}

export const THREAD_RUN_GATE_WAIT = 4;

export class RunGate {
  private waitQ: RunSteerTask[] = [];
  private inflightTask: RunSteerTask | undefined;

  constructor(readonly maxWait: number = THREAD_RUN_GATE_WAIT) {}

  get busy(): boolean {
    return this.inflightTask !== undefined;
  }

  get inFlight(): RunSteerTask | undefined {
    return this.inflightTask;
  }

  get queuedCount(): number {
    return this.waitQ.length;
  }

  waitFull(): boolean {
    return this.waitQ.length >= this.maxWait;
  }

  /** §6.5: 超出时该订阅者记 `none`（调用前确定）— the CALLER records the outcome. */
  enqueue(task: RunSteerTask): boolean {
    if (this.waitFull()) return false;
    this.waitQ.push(task);
    return true;
  }

  /** Pop the next waiter into the in-flight slot (engine calls this only while free). */
  next(): RunSteerTask | undefined {
    if (this.inflightTask !== undefined) return undefined;
    const t = this.waitQ.shift();
    if (t === undefined) return undefined;
    this.inflightTask = t;
    return t;
  }

  /** Free the in-flight slot — normal settle OR abandon (deadline passed: the late settle is
   *  audit-only, §6.5 晚到结果; the gate must not stay wedged behind a hanging call). */
  releaseInflight(task: RunSteerTask): boolean {
    if (this.inflightTask !== task) return false;
    this.inflightTask = undefined;
    return true;
  }

  /** Pre-call cancellation (event deadline / run terminal / dispose). Returns the removed tasks —
   *  every one of them records `none` (调用前确定, §6.4 safe fallback). Never touches in-flight. */
  cancelQueued(predicate: (task: RunSteerTask) => boolean): RunSteerTask[] {
    const removed: RunSteerTask[] = [];
    this.waitQ = this.waitQ.filter((t) => {
      if (predicate(t)) {
        removed.push(t);
        return false;
      }
      return true;
    });
    return removed;
  }

  queued(): readonly RunSteerTask[] {
    return this.waitQ;
  }
}
