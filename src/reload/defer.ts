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

/** Run statuses that count as settled (mirrors the terminal set used across the codebase). */
export const TERMINAL_RUN_STATUSES: readonly string[] = ["completed", "failed", "timed_out", "aborted"];

/** Only an exact `/reload` (modulo surrounding whitespace) is rewritten; `/reload x` passes through. */
export function shouldRewriteReload(text: string): boolean {
  return text.trim() === "/reload";
}

/** Count runs whose status is not terminal. */
export function countActiveRuns(runs: readonly { status: string }[]): number {
  return runs.filter((run) => !TERMINAL_RUN_STATUSES.includes(run.status)).length;
}

export interface DeferredReloadControllerDeps {
  /**
   * Invoked once when the fleet drains while armed. The fire path re-checks
   * busyness itself (`/agent reload fire`), so firing on a stale zero count
   * is safe — the command just re-arms.
   */
  fire: () => void;
}

/**
 * Arm/disarm state machine for one pending deferred reload.
 *
 * - `arm(n)` parks a reload request while `n` runs are active. Re-arming is
 *   idempotent: it just refreshes the remembered count.
 * - `handleRunSettled(activeCount)` is called on every run-terminal event
 *   with a freshly counted active count; when it reaches zero the controller
 *   disarms and fires (fire first, state already clean, so a fire handler
 *   that synchronously re-arms cannot be clobbered).
 * - `disarm()` cancels a pending reload (`/agent reload cancel`, force-now).
 */
export class DeferredReloadController {
  private armed = false;
  private activeCount = 0;
  private readonly fireCallback: () => void;

  constructor(deps: DeferredReloadControllerDeps) {
    this.fireCallback = deps.fire;
  }

  /** True while a reload request is parked waiting for the fleet to settle. */
  get pending(): boolean {
    return this.armed;
  }

  /** Last active-run count this controller observed (diagnostics/testing). */
  get rememberedActiveCount(): number {
    return this.activeCount;
  }

  arm(activeCount: number): void {
    this.armed = true;
    this.activeCount = Math.max(0, activeCount);
  }

  disarm(): void {
    this.armed = false;
    this.activeCount = 0;
  }

  handleRunSettled(activeCount: number): void {
    if (!this.armed) return;
    this.activeCount = Math.max(0, activeCount);
    if (this.activeCount > 0) return;
    this.disarm();
    this.fireCallback();
  }
}
