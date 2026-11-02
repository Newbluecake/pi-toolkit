import { clampSpanMs, dueAtFor, effectiveDeadlineAt, OVERTIME_PHASES } from "./deadline.js";
import type { DeadlineBudget, Millis, RunDeadlines, RunDiagnostics, RunPhase } from "./types.js";

/**
 * Structured-output repair turn (structured-output-repair-plan.md, r2): when a
 * schema run's first prompt settles completed without any StructuredOutput
 * submission, the runner sends ONE extra prompt on the same session/handle
 * before settling, asking the model to submit now. This module holds the pure
 * arithmetic of that decision (pi-free, I8): eligibility windows, the dynamic
 * close point, and the failure-suffix text. The runner owns the orchestration;
 * the adapter (service/runtime-adapter.ts) assembles the runtime-only spec.
 */

/** Model-visible repair prompt (English, ASCII, no internal vocabulary — see tests/core/structured-repair.test.ts). */
export const STRUCTURED_REPAIR_PROMPT =
  "You finished without calling the StructuredOutput tool, so your result has not been delivered.\n" +
  "Call StructuredOutput now, passing your final result as the tool's arguments (they must match the\n" +
  "requested JSON Schema). Do not redo the task and do not call any other tool. A plain-text or JSON\n" +
  "reply in chat is not accepted; only the StructuredOutput call counts.";

export interface StructuredRepairLimits {
  /** Skip the repair turn entirely when less than this remains before the earliest bound. */
  minRemainingMs: Millis;
  /** Hard cap on the repair window (windowDueAt = now + min(maxMs, available)). */
  maxMs: Millis;
  /** Safety tail kept between the local close point and every deadline the watchdog can fire. */
  tailMs: Millis;
  /** Close after this many turn_end events during the repair without a submission. */
  maxTurns: number;
}

export const STRUCTURED_REPAIR_DEFAULTS: StructuredRepairLimits = {
  minRemainingMs: 15_000,
  maxMs: 120_000,
  tailMs: 5_000,
  maxTurns: 3,
};

/** Outcome note reported to the adapter; only "attempted" and the two budget/grace skips change the failure message. */
export type StructuredRepairNote = "attempted" | "skipped_budget" | "skipped_grace" | "skipped_tool" | "skipped_phase";

/**
 * Runtime-only (never sent to pi); built by service/runtime-adapter.ts for
 * pi-path schema runs. Like `toolScope` / `inputBudget` on
 * ResolvedSpawnRequest, this field is consumed inside the runner only.
 */
export interface StructuredRepairSpec {
  readonly toolName: string;
  readonly prompt: string;
  readonly limits: StructuredRepairLimits;
  /** True while the capture window is open AND nothing has been submitted yet. */
  readonly pending: () => boolean;
  /** Idempotent, synchronous: from the first call on, every late submission is rejected. */
  readonly closeCapture: () => void;
  readonly report: (note: StructuredRepairNote) => void;
}

/**
 * Earliest sub-phase due across the run budget and the watchdog budget — the
 * watchdog reads the session-wide `settings.budget`, not the per-run budget,
 * so the runner must treat both as bounds (plan §1b). Only OVERTIME_PHASES
 * have a sub-phase due at all; everything else returns undefined.
 */
export function phaseDueAt(
  phase: RunPhase,
  diag: RunDiagnostics,
  budgets: readonly DeadlineBudget[],
): Millis | undefined {
  if (!OVERTIME_PHASES.includes(phase)) return undefined;
  let earliest: Millis | undefined;
  for (const budget of budgets) {
    const due = dueAtFor(phase, diag, budget);
    if (due !== undefined && (earliest === undefined || due < earliest)) earliest = due;
  }
  return earliest;
}

/**
 * Eligibility + window size, computed synchronously at settlement time.
 * available = min(effective deadline, sub-phase due) − tailMs − now; a run in
 * its grace window is never repaired (the deadline already fired once), and a
 * window below minRemainingMs is skipped rather than started-and-instantly-
 * killed. NaN anywhere fails the >= comparison and lands in skipped_budget.
 */
export function structuredRepairWindow(i: {
  now: Millis;
  deadlines: RunDeadlines;
  phaseDue: Millis | undefined;
  limits: StructuredRepairLimits;
}): { dueAt: Millis } | { skip: "skipped_grace" | "skipped_budget" } {
  if (i.deadlines.graceUntil !== undefined) return { skip: "skipped_grace" };
  const cap = effectiveDeadlineAt(i.deadlines);
  let bound: Millis | undefined;
  if (cap !== undefined && i.phaseDue !== undefined) bound = Math.min(cap, i.phaseDue);
  else bound = cap ?? i.phaseDue;
  // bound === undefined ⇒ uncapped run (defense branch — D-11 forbids it in
  // real wiring): the window is just the maxMs cap.
  const available = bound === undefined ? Number.POSITIVE_INFINITY : bound - i.limits.tailMs - i.now;
  if (!(available >= i.limits.minRemainingMs)) return { skip: "skipped_budget" };
  const span = clampSpanMs(Math.min(i.limits.maxMs, available));
  if (span === undefined) return { skip: "skipped_budget" };
  return { dueAt: i.now + span };
}

/**
 * Dynamic close point, re-derived on every repair-phase event: the local
 * close always precedes every deadline the watchdog (or the prompt guard)
 * could fire by at least tailMs (plan §1b/R2). May evaluate to <= now after
 * the state moved; the runner's rearm() treats that as "close now".
 */
export function structuredRepairCloseAt(i: {
  windowDueAt: Millis;
  deadlines: RunDeadlines;
  phaseDue: Millis | undefined;
  tailMs: Millis;
}): Millis {
  let out = i.windowDueAt;
  const deadline = effectiveDeadlineAt(i.deadlines);
  if (deadline !== undefined) out = Math.min(out, deadline - i.tailMs);
  if (i.phaseDue !== undefined) out = Math.min(out, i.phaseDue - i.tailMs);
  return out;
}

/** Failure-message suffix for the `captured === undefined` branch of applyStructuredOutputPolicy (plan §1j). */
export function structuredRepairSuffix(note: StructuredRepairNote | undefined): string {
  switch (note) {
    case "attempted":
      return " (after one repair turn)";
    case "skipped_budget":
      return " (repair turn skipped: not enough time left before a deadline)";
    case "skipped_grace":
      return " (repair turn skipped: run is past its deadline)";
    default:
      return "";
  }
}
