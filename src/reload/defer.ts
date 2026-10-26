/**
 * Deferred /reload — pure decision logic (pi-free, unit-testable).
 *
 * Problem: pi's built-in `/reload` tears the extension runtime down
 * immediately, and this extension's session_shutdown handler stops every
 * running subagent. The deferred-reload feature intercepts exact `/reload`
 * submissions (see editor.ts), parks the request while the fleet is busy,
 * and fires the real reload once every run has settled.
 *
 * This file holds only the pure pieces: the rewrite predicate, the active
 * run counter, and the arm/disarm/settle state machine. All pi-facing
 * wiring lives in index.ts.
 */

import { clampSpanMs } from "../core/deadline.js";
import { systemClock, type Clock, type TimerHandle } from "../core/clock.js";

/** One bounded, cancellable natural-idle wait per controller; no polling. */
export const RELOAD_IDLE_WAIT_MS = 30 * 60_000;

/** Run statuses that count as settled (mirrors the terminal set used across the codebase). */
export const TERMINAL_RUN_STATUSES: readonly string[] = ["completed", "failed", "timed_out", "aborted"];

/** Only an exact `/reload` (modulo surrounding whitespace) is rewritten; `/reload x` passes through. */
export function shouldRewriteReload(text: string): boolean {
  return text.trim() === "/reload";
}

/**
 * Count runs whose status is not terminal.
 *
 * admitted-run-visibility fix (2026-10-08 incident): `admittedIds` is
 * SpawnService's own admission-time truth (`SpawnService.runningIds()`) —
 * every run id from the instant spawn() admits it until it settles,
 * independent of whether a runner-produced snapshot has landed in `runs`
 * yet (a resume can take a while to open its session file before the first
 * one does). Union'd by runId so a run visible in both never double-counts,
 * and a run admitted after `runs` was read (or never yet carrying a usable
 * `runId`, defensively) still counts. Omitting the second argument keeps
 * today's registry-only behavior byte-for-byte (existing callers/tests).
 */
export function countActiveRuns(
  runs: readonly { status: string; runId?: string }[],
  admittedIds?: readonly string[],
): number {
  const active = runs.filter((run) => !TERMINAL_RUN_STATUSES.includes(run.status));
  if (admittedIds === undefined || admittedIds.length === 0) return active.length;
  const ids = new Set<string>();
  let unidentified = 0;
  for (const run of active) {
    if (run.runId !== undefined) ids.add(run.runId);
    else unidentified++;
  }
  for (const id of admittedIds) ids.add(id);
  return ids.size + unidentified;
}

export interface DeferredReloadControllerDeps {
  /**
   * Invoked once when the fleet drains while armed. The fire path re-checks
   * busyness itself (`/agent reload fire`), so firing on a stale zero count
   * is safe — the command just re-arms.
   */
  fire: () => void;
  clock?: Clock;
}

/**
 * Arm/disarm state machine for one pending deferred reload.
 *
 * - `arm(n)` parks a reload request while `n` runs are active. Re-arming is
 *   idempotent: it just refreshes the remembered count.
 * - `handleRunSettled(activeCount)` is called on every run-terminal event
 *   with a freshly counted active count; when it reaches zero the controller
 *   queues fire once, keeping pending true until the command actually reloads
 *   or cancels. New dispatches remain blocked throughout the fire queue window.
 * - `disarm()` cancels a pending reload (`/agent reload cancel`, force-now).
 */
export class DeferredReloadController {
  private armed = false;
  private activeCount = 0;
  private fireQueued = false;
  private streamingAtArm = false;
  private readonly fireCallback: () => void;
  private readonly clock: Clock;
  private idleWait: { timer?: TimerHandle } | undefined;
  private idleWaitExpired = false;
  private sawStreamingWait = false;

  constructor(deps: DeferredReloadControllerDeps) {
    this.fireCallback = deps.fire;
    this.clock = deps.clock ?? systemClock;
  }

  get waitedWhileStreaming(): boolean {
    return this.sawStreamingWait;
  }

  /** Invalidate callbacks and clear the unref'd timer, without clearing interruption history. */
  cancelIdleWait(): void {
    const waiting = this.idleWait;
    this.idleWait = undefined;
    if (waiting?.timer !== undefined) this.clock.clearTimer(waiting.timer);
  }

  /**
   * Never await this from a command/event handler: it may be on the run's own
   * completion stack. On idle, re-send fire so its command re-counts busy runs.
   */
  waitForIdle(wait: () => Promise<void>, isIdle: () => boolean, notify: (reason: string) => void): void {
    if (!this.armed || this.idleWait || this.idleWaitExpired) return;
    this.sawStreamingWait = true;
    const waiting: { timer?: TimerHandle } = {};
    this.idleWait = waiting;
    const fail = (reason: string) => {
      if (this.idleWait !== waiting) return;
      this.cancelIdleWait();
      this.idleWaitExpired = true;
      notify(reason);
    };
    waiting.timer = this.clock.setTimer(clampSpanMs(RELOAD_IDLE_WAIT_MS)!, () => {
      fail(
        "等待模型自然空闲已超过 30 分钟，reload 仍挂起，不会自动中止回合。请用 /agent reload now 强制执行，或 /agent reload cancel 取消。",
      );
    });
    void Promise.resolve()
      .then(() => {
        if (this.idleWait === waiting) return wait();
      })
      .then(() => {
        if (this.idleWait !== waiting) return;
        if (!isIdle()) {
          fail("模型尚未空闲，reload 仍挂起。请重试 /agent reload，或使用 now/cancel。");
          return;
        }
        this.cancelIdleWait();
        this.fireCallback();
      })
      .catch(() =>
        fail("等待模型空闲失败，reload 仍挂起，不会自动中止回合。请重试 /agent reload，或使用 now/cancel。"),
      );
  }

  /** True while a reload request is parked waiting for the fleet to settle. */
  get pending(): boolean {
    return this.armed;
  }

  /** Last active-run count this controller observed (diagnostics/testing). */
  get rememberedActiveCount(): number {
    return this.activeCount;
  }

  /** Whether the model was streaming when this reload was FIRST armed. */
  get interruptedAtArm(): boolean {
    return this.streamingAtArm;
  }

  /** Returns true only for the first arm; repeated requests refresh the count, not the snapshot. */
  arm(activeCount: number, wasStreaming = false): boolean {
    const first = !this.armed;
    if (first) this.streamingAtArm = wasStreaming;
    this.armed = true;
    this.idleWaitExpired = false;
    this.activeCount = Math.max(0, activeCount);
    // A fire command that re-counted busy must wait for the next drain.
    this.fireQueued = false;
    return first;
  }

  disarm(): void {
    this.cancelIdleWait();
    this.idleWaitExpired = false;
    this.sawStreamingWait = false;
    this.armed = false;
    this.activeCount = 0;
    this.fireQueued = false;
    this.streamingAtArm = false;
  }

  handleRunSettled(activeCount: number): void {
    if (!this.armed || this.idleWaitExpired) return;
    this.activeCount = Math.max(0, activeCount);
    if (this.activeCount > 0 || this.fireQueued) return;
    this.fireQueued = true;
    this.fireCallback();
  }
}
