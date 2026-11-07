/**
 * fabric-thread P1 (arch r3 §6.5, r3-4): the ABSOLUTE event deadline shared by lane wait,
 * per-run wait and the whole steer — computed at the synchronous R0–R5 pass moment in
 * handlePrompt, via the SAME `clampSpanMs` primitive every other deadline goes through (I1).
 *
 * `span === undefined` (budget ≤ 0 / NaN) or `span < 500 ms` ⇒ R6: native path, ZERO steer calls.
 * The 1500 ms reserve against `frame.deadlineMs` leaves room for the fallback re-dispatch and
 * the cmd_result hop back to the hub (§6.5). Feishu's default `deadlineMs` is 8000 ⇒ span 4000.
 */
import { clampSpanMs } from "../../core/deadline.js";

/** §6.5: `budget = min(threads.steerTimeoutMs, frame.deadlineMs − 1500)`. */
export const THREAD_STEER_DEADLINE_RESERVE_MS = 1500;

/** §6.3 R6: a usable steer span must be at least this. */
export const THREAD_MIN_STEER_SPAN_MS = 500;

/** The clamped span for one event's whole fast-path budget, or `undefined` ⇒ R6. */
export function steerSpanMs(steerTimeoutMs: number, frameDeadlineMs: number): number | undefined {
  const budget = Math.min(steerTimeoutMs, frameDeadlineMs - THREAD_STEER_DEADLINE_RESERVE_MS);
  const span = clampSpanMs(budget);
  if (span === undefined || span < THREAD_MIN_STEER_SPAN_MS) return undefined;
  return span;
}

export interface EventDeadline {
  /** clamped span (`deadlineAt − receivedAt`). */
  span: number;
  /** `receivedAt + span` — lane wait, per-run wait and every steer call share this ONE instant. */
  deadlineAt: number;
}

/** §6.5 absolute deadline; `undefined` ⇒ R6 (`budget+1`, native, no subscriber is called). */
export function computeEventDeadline(
  receivedAt: number,
  steerTimeoutMs: number,
  frameDeadlineMs: number,
): EventDeadline | undefined {
  const span = steerSpanMs(steerTimeoutMs, frameDeadlineMs);
  if (span === undefined) return undefined;
  return { span, deadlineAt: receivedAt + span };
}

/** Remaining budget for a single steer call (§6.5: “剩余 ≤ 0 时不再发起调用”); 0 ⇒ do not call. */
export function remainingBudgetMs(deadlineAt: number, now: number): number {
  return deadlineAt - now;
}
