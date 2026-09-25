import type { Millis } from "../core/types.js";
import type { WorkflowId } from "./types.js";

/**
 * workflow-agent-queue plan §4.1/§4.2 (stage B): the workflow-level
 * counterpart of the subagent timeout grace + extension machinery
 * (`src/core/deadline.ts` — `hardDeadlineAtFor` / `extendability` /
 * `graceWindow`, reduced in `state-machine.ts`). Pure, clock-free and
 * pi-free: every method takes `now` explicitly, nothing here arms a timer —
 * orchestrator.ts owns the single WT8 timer and re-arms it at
 * `nextTimerAt()` whenever `onTimer`/`extend` moves the deadline.
 *
 * Semantics (mirrors the subagent run, D-6/D-7/D-10):
 *  - `softAt` starts at `startedAt + totalMs`; `hardAt = startedAt +
 *    ceil(totalMs × max(1, maxTotalFactor))` and never moves.
 *  - The WT8 timer fires at `nextTimerAt()` (= `graceUntil ?? softAt`). At the
 *    soft deadline a workflow with extension budget left (`extendability` ok)
 *    and `totalGraceMs > 0` enters a grace window `graceUntil = min(now +
 *    totalGraceMs, hardAt)`; otherwise it expires. At `graceUntil` it expires.
 *  - `extend()` pushes `softAt` to `min(max(now, softAt) + extendMs, hardAt)`,
 *    clears any grace window (a rescue) and consumes one extension.
 *  - An explicit `timeout_s` workflow runs with `maxTotalFactor = 1` ⇒
 *    `hardAt === softAt` ⇒ `no_headroom` ⇒ no grace, no extension (D-10).
 *  - `close()` (called synchronously by the orchestrator's `finish()`, review
 *    v2 #5) makes every later `extend()` fail with `already_terminal`.
 *
 * Invariants (property-tested): `softAt` is monotone non-decreasing,
 * `softAt ≤ killAt(now) ≤ hardAt`, `hardAt` is constant, `extensions ≤
 * maxExtensions`, `graces ≤ maxExtensions` — so WT8 is armed at most
 * `1 + graces + extensions ≤ 1 + 2 × maxExtensions` times.
 */

export interface WorkflowDeadlinePolicy {
  /** The workflow's own total budget (WT8 `workflowTotalMs`). Must be > 0. */
  readonly totalMs: Millis;
  /** Grace window length; `0` disables grace. */
  readonly totalGraceMs: Millis;
  /** Extension budget; `0` disables grace and extension alike (D-6/D-16). */
  readonly maxExtensions: number;
  /** Hard ceiling factor (`≥ 1`; values below 1 are treated as 1). `1` = hard cap (explicit `timeout_s`). */
  readonly maxTotalFactor: number;
}

export interface WorkflowDeadlineState {
  readonly startedAt: Millis;
  /** Current soft deadline (moves only forward, only through `extend`). */
  readonly softAt: Millis;
  /** Absolute hard ceiling — constant. */
  readonly hardAt: Millis;
  /** Present only while inside a grace window. */
  readonly graceUntil?: Millis;
  readonly extensions: number;
  readonly grantedMs: Millis;
  readonly graces: number;
  readonly closed: boolean;
  readonly stopping: boolean;
}

export type WorkflowExtendRejectReason =
  "unknown_workflow" | "already_terminal" | "stopping" | "limit_reached" | "no_headroom" | "uncapped" | "unsupported";

/** Structurally the same shape as core's `ExtendOutcome` (runId → workflowId, `unknown_run` → `unknown_workflow`, no `not_started`). */
export type WorkflowExtendOutcome =
  | {
      readonly ok: true;
      readonly workflowId: WorkflowId;
      readonly previousDeadlineAt: Millis;
      readonly deadlineAt: Millis;
      readonly requestedMs: Millis;
      readonly grantedMs: Millis;
      /** grantedMs < requestedMs (clamped by the hard ceiling). */
      readonly clamped: boolean;
      readonly extensionsUsed: number;
      readonly extensionsRemaining: number;
      readonly hardDeadlineAt: Millis;
      /** This extension rescued the workflow out of its grace window. */
      readonly rescuedFromGrace: boolean;
    }
  | { readonly ok: false; readonly reason: WorkflowExtendRejectReason; readonly detail?: string };

/**
 * Review v2 #8: the workflow deadline notice lives here (pure data — the
 * orchestrator builds it, `src/delivery/deadline-notice.ts` renders it,
 * `src/stack.ts` delivers it on the `subagent:timeout` channel).
 */
export interface WorkflowDeadlineNotice {
  readonly kind: "grace" | "extended";
  readonly workflowId: WorkflowId;
  readonly at: Millis;
  /** Soft deadline after the change. */
  readonly deadlineAt: Millis;
  /** `kind === "grace"`: when the grace window ends (the workflow then stops as timed_out). */
  readonly graceUntil?: Millis;
  readonly hardDeadlineAt: Millis;
  readonly extensionsUsed: number;
  readonly maxExtensions: number;
  /** The workflow's original total budget (`workflowTotalMs`). */
  readonly totalMs: Millis;
  /** `kind === "grace"`: copyable suggestion = min(totalMs, headroom). */
  readonly suggestedExtendMs?: Millis;
  /** `kind === "extended"`. */
  readonly requestedMs?: Millis;
  readonly grantedMs?: Millis;
  readonly reason?: string;
  /** Live picture at notice time (the "Now:" line). */
  readonly live?: {
    readonly phaseId?: string;
    readonly running: number;
    readonly queued: number;
    readonly settled: number;
  };
}

export type WorkflowDeadlineTimerResult =
  | { readonly kind: "grace"; readonly until: Millis }
  | { readonly kind: "expire" }
  /** Defensive: the timer fired before `nextTimerAt()` (never in practice — the orchestrator clears the old timer on every re-arm). Re-arm at `at`. */
  | { readonly kind: "wait"; readonly at: Millis };

export type WorkflowExtendability =
  | { readonly ok: true; readonly headroomMs: Millis }
  | { readonly ok: false; readonly reason: "already_terminal" | "stopping" | "limit_reached" | "no_headroom" };

export interface WorkflowDeadlineController {
  readonly policy: WorkflowDeadlinePolicy;
  state(): WorkflowDeadlineState;
  readonly closed: boolean;
  /** Same verdict order as core `extendability` (`core/deadline.ts`): terminal → stopping → limit → headroom. */
  extendability(now: Millis): WorkflowExtendability;
  /** WT8 fired at `now`. */
  onTimer(now: Millis): WorkflowDeadlineTimerResult;
  extend(now: Millis, extendMs: Millis): WorkflowExtendOutcome;
  /** When WT8 must fire next: `graceUntil ?? softAt`. */
  nextTimerAt(): Millis;
  /**
   * The latest instant the workflow can still be running given the current
   * state, *without* any further extension: `graceUntil` inside a grace
   * window; otherwise `min(max(now, softAt) + totalGraceMs, hardAt)` when a
   * grace window will be available at the soft deadline, else `softAt`.
   * Always within `[softAt, hardAt]`. host.ts bounds every host call, gate
   * and BW2 budget check by it (grace keeps dispatching).
   */
  killAt(now: Millis): Millis;
  /** A stop was requested but the terminal decision is not made yet: extension refused with `stopping`. */
  markStopping(): void;
  /** Terminal decision made (orchestrator `finish()`): every later `extend` fails with `already_terminal`. Idempotent. */
  close(): void;
}

export function createWorkflowDeadlineController(
  workflowId: WorkflowId,
  startedAt: Millis,
  policy: WorkflowDeadlinePolicy,
): WorkflowDeadlineController {
  const totalMs = Math.max(1, policy.totalMs);
  const factor = Number.isFinite(policy.maxTotalFactor) ? Math.max(1, policy.maxTotalFactor) : 1;
  const maxExtensions = Math.max(0, Math.floor(policy.maxExtensions));
  const totalGraceMs = Math.max(0, policy.totalGraceMs);
  const normalized: WorkflowDeadlinePolicy = { totalMs, totalGraceMs, maxExtensions, maxTotalFactor: factor };
  const hardAt = startedAt + Math.ceil(totalMs * factor);
  let softAt = startedAt + totalMs;
  let graceUntil: Millis | undefined;
  let extensions = 0;
  let grantedMs = 0;
  let graces = 0;
  let closed = false;
  let stopping = false;

  function extendability(now: Millis): WorkflowExtendability {
    if (closed) return { ok: false, reason: "already_terminal" };
    if (stopping) return { ok: false, reason: "stopping" };
    if (extensions >= maxExtensions) return { ok: false, reason: "limit_reached" };
    const headroom = hardAt - Math.max(now, softAt);
    if (headroom <= 0) return { ok: false, reason: "no_headroom" }; // incl. D-10: explicit timeout_s ⇒ hardAt === softAt
    return { ok: true, headroomMs: headroom };
  }

  /** Grace window available at `at` (D-6: only with extension budget left; D-7: clamped by the hard ceiling). */
  function graceUntilAt(at: Millis): Millis | undefined {
    if (totalGraceMs <= 0) return undefined;
    if (!extendability(at).ok) return undefined;
    const until = Math.min(at + totalGraceMs, hardAt);
    return until > at ? until : undefined;
  }

  return {
    policy: normalized,
    state() {
      return {
        startedAt,
        softAt,
        hardAt,
        ...(graceUntil !== undefined ? { graceUntil } : {}),
        extensions,
        grantedMs,
        graces,
        closed,
        stopping,
      };
    },
    get closed() {
      return closed;
    },
    extendability,
    onTimer(now) {
      if (closed) return { kind: "expire" };
      if (graceUntil !== undefined) {
        if (now < graceUntil) return { kind: "wait", at: graceUntil };
        return { kind: "expire" };
      }
      if (now < softAt) return { kind: "wait", at: softAt };
      const until = graceUntilAt(now);
      if (until === undefined) return { kind: "expire" };
      graceUntil = until;
      graces += 1;
      return { kind: "grace", until };
    },
    extend(now, extendMs) {
      const verdict = extendability(now);
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      const prev = softAt;
      // Base on max(now, prev): inside a grace window prev is already in the
      // past, so "+60s" measured from prev could be a zero net gain.
      const base = Math.max(now, prev);
      const requested = Math.max(0, extendMs);
      const next = Math.min(base + requested, hardAt);
      if (next <= prev && next <= now) return { ok: false, reason: "no_headroom" }; // zero net gain
      const granted = next - base;
      const rescuedFromGrace = graceUntil !== undefined;
      softAt = next;
      graceUntil = undefined;
      extensions += 1;
      grantedMs += granted;
      return {
        ok: true,
        workflowId,
        previousDeadlineAt: prev,
        deadlineAt: next,
        requestedMs: requested,
        grantedMs: granted,
        clamped: granted < requested,
        extensionsUsed: extensions,
        extensionsRemaining: maxExtensions - extensions,
        hardDeadlineAt: hardAt,
        rescuedFromGrace,
      };
    },
    nextTimerAt() {
      return graceUntil ?? softAt;
    },
    killAt(now) {
      if (graceUntil !== undefined) return graceUntil;
      return graceUntilAt(Math.max(now, softAt)) ?? softAt;
    },
    markStopping() {
      stopping = true;
    },
    close() {
      closed = true;
    },
  };
}
