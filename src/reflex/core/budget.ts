/**
 * jev-reflex · code constants + the single budget race (plan R1 step 1; arch §4.1, R-I7).
 *
 * Deliberately NOT settings (arch D7): the MVP has no tuning surface; adding keys later is
 * append-only. `raceBudget` clamps every computed deadline through `clampSpanMs` (I1) and arms
 * its timer through the injected `Clock` (unref/segmentation owned by the clock, I5). No
 * module-scope mutable state (I4). `PENDING_MAX_AGE_MS` is only checked at the two entry
 * points (input / agent_settled) — reflex never arms an aging timer (plan R1 step 1 note).
 */

import type { Clock, TimerHandle } from "../../core/clock.js";
import { clampSpanMs } from "../../core/deadline.js";

/** U4: in-band S2 wait ceiling (autoresolve port execution inside the input handler). */
export const REFLEX_BUDGET_MS = 1200;
/** S0 #9: questions longer than this (code points, trimmed) are not one-liners. */
export const MAX_INPUT_CHARS = 120;
/** PD6: same requestDigest becoming a candidate for the same script again within this window. */
export const REPEAT_WINDOW_MS = 600_000;
/** PD12: a correction counts only this long after the target candidate/answer settled. */
export const CORRECTION_WINDOW_MS = 90_000;
/** Consecutive error|timeout strikes before the demote overlay is set (arch §4.7). */
export const DEMOTE_AFTER_STRIKES = 2;
/** Answer body caps (arch §4.8): truncation is NOT a failure — it is labelled instead. */
export const MAX_ANSWER_LINES = 24;
export const MAX_ANSWER_BYTES = 2048;
/**
 * A pending shadow slot older than this is flushed as `model.agree:"unknown"` at the next
 * input / agent_settled entry — never by a timer (plan R1 step 1; R2b consumes it).
 */
export const PENDING_MAX_AGE_MS = REPEAT_WINDOW_MS;

export type BudgetTimeout = { kind: "timeout" };

/**
 * Race `p` against `min(budgetMs, REFLEX_BUDGET_MS)` on the injected clock. Contract:
 * - an invalid budget (NaN / ≤ 0, post-clamp `undefined`) resolves to `{kind:"timeout"}`
 *   immediately — the budget is the ceiling, never negotiable (I1);
 * - the timer goes through `clock.setTimer` and is cleared on every settlement path;
 * - an aborted `signal` settles the race as `{kind:"timeout"}` (R2a classifies aborts itself
 *   via `signal.aborted`; this keeps the race type total);
 * - a rejecting `p` is a caller bug: it is swallowed into `{kind:"timeout"}` so the input
 *   stage can never hang or throw (fail-open; callers that need to distinguish wrap `p`
 *   before handing it here — executePort's wrapper does exactly that).
 */
export function raceBudget<T>(
  p: Promise<T>,
  budgetMs: number,
  clock: Clock,
  signal?: AbortSignal,
): Promise<T | BudgetTimeout> {
  const span = clampSpanMs(Math.min(budgetMs, REFLEX_BUDGET_MS));
  if (span === undefined) {
    p.catch(() => undefined);
    return Promise.resolve({ kind: "timeout" });
  }
  if (signal?.aborted) {
    p.catch(() => undefined);
    return Promise.resolve({ kind: "timeout" });
  }
  return new Promise<T | BudgetTimeout>((resolve) => {
    let done = false;
    let timer: TimerHandle | undefined;
    const finish = (value: T | BudgetTimeout): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) {
        try {
          clock.clearTimer(timer);
        } catch {
          /* a broken clock must not turn settlement into a throw */
        }
      }
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish({ kind: "timeout" });
    if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
    try {
      timer = clock.setTimer(span, () => finish({ kind: "timeout" }));
      if (done) {
        // The timer fired synchronously (clock quirk): finish() already cleared it.
        return;
      }
    } catch {
      finish({ kind: "timeout" });
      return;
    }
    p.then(
      (value) => finish(value),
      () => finish({ kind: "timeout" }),
    );
  });
}
