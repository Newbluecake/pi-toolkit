import type { RunSnapshot } from "../core/types.js";

/**
 * consult (docs/dev/consult/plan.md §4.1, review-2 #4): why a consult run was
 * cut short. Deliberately NOT part of `StopCause` (§15 #1): widening that
 * union would ripple through `src/core/state-machine.ts`'s stop_requested
 * branch, every `diag.stopCause` consumer and the transition-matrix/property
 * tests, for a purely display-level distinction. A capped run is aborted as
 * `StopCause="user_stop"`; the real reason surfaces only here (the watcher's
 * `capReason`) and as the tool result's `details.outcome`.
 */
export type ConsultCapReason = "turn_cap" | "cost_cap";

export interface CapWatcher {
  /** Feed every run snapshot (via the ConsultSpawnPort watch). */
  onSnapshot(snapshot: RunSnapshot): void;
  /** Set once a cap fired (undefined otherwise); the tool result maps it onto `details.outcome`. */
  readonly capReason: ConsultCapReason | undefined;
}

const TERMINAL = new Set(["completed", "failed", "timed_out", "aborted"]);

/**
 * Turn/cost cap watcher — judges ONLY at turn boundaries:
 *
 * - A new turn is detected by `diag.lastTurnStartAt` changing relative to the
 *   last observed value (sticky field, written on turn_start and surviving
 *   until the next one). This is equivalent to `lastEventType ===
 * "turn_start"` today (onStateChange fires per dispatch, snapshots are not
 *   merged) but stays correct even if snapshot throttling/merging is ever
 *   introduced (review-3 #10②).
 * - At a new turn: `diag.turns >= maxTurns` → `turn_cap` (turns counts
 *   *completed* turns, so the maxTurns+1-th turn starting is the cut point);
 *   else `maxCostUsd > 0 && diag.usage.costUsd > maxCostUsd` → `cost_cap`.
 * - Never aborts on message_end: the final answer message crossing the cap
 *   has no following turn_start, so the run completes normally and the full
 *   answer survives (review-2 #4 / plan §5.5). A capped run can only be one
 *   that ended its last turn on a tool_use and was about to start another
 *   paid turn — no final answer exists yet at that point.
 * - `onCap` fires at most once and is invoked synchronously from the snapshot
 *   callback; the caller schedules the actual abort via `queueMicrotask`
 *   (plan §4.1) so it never runs inside onStateChange's synchronous stack.
 *
 * Effective bounds (plan §4.1): cost ≈ max(first-request estimate, cap) + one
 * turn; turns ≤ maxTurns complete turns. The run's totalMs hard cap always
 * remains the outer bound.
 */
export function createCapWatcher(o: {
  maxTurns: number;
  /** Cumulative cost cap; 0 = cost cap off (the *first-request* pre-check uses a different setting, §4.6). */
  maxCostUsd: number;
  onCap: (reason: ConsultCapReason) => void;
}): CapWatcher {
  let lastTurnStartAt: number | undefined;
  let fired = false;
  let reason: ConsultCapReason | undefined;
  return {
    onSnapshot(snapshot: RunSnapshot): void {
      if (fired) return;
      if (TERMINAL.has(snapshot.status)) return; // terminal snapshots never judge
      const turnStartAt = snapshot.diag.lastTurnStartAt;
      if (turnStartAt === undefined || turnStartAt === lastTurnStartAt) return;
      lastTurnStartAt = turnStartAt;
      let cap: ConsultCapReason | undefined;
      if (o.maxTurns > 0 && snapshot.diag.turns >= o.maxTurns) cap = "turn_cap";
      else if (o.maxCostUsd > 0 && (snapshot.diag.usage?.costUsd ?? 0) > o.maxCostUsd) cap = "cost_cap";
      if (cap) {
        fired = true;
        reason = cap;
        o.onCap(cap);
      }
    },
    get capReason(): ConsultCapReason | undefined {
      return reason;
    },
  };
}
