/** P2-local deadlines/errors. No resource owner, durable state or v1 dependency. */
import { createSegmentedClock } from "../../../../core/clock.js";
import type { TerminalFailureV2 } from "../../../protocol/terminal-v2.js";

export function clampSpanMs(ms: number): number {
  return Number.isFinite(ms) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(ms))) : 0;
}
export function viewClock(now: () => number) {
  return createSegmentedClock({
    now,
    set(ms, fn) {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return timer;
    },
    clear: (timer) => clearTimeout(timer as NodeJS.Timeout),
  });
}
export class TerminalV2Fault extends Error {
  constructor(readonly failure: TerminalFailureV2) {
    super(failure.code);
  }
}
export function fail(
  code: Exclude<TerminalFailureV2["code"], "E_INPUT_UNKNOWN">,
  effect: "none" | "unknown" = "none",
): TerminalFailureV2 {
  return { ok: false, code, effect };
}
export const inputUnknown = (): TerminalFailureV2 => ({ ok: false, code: "E_INPUT_UNKNOWN", effect: "unknown" });
export function asFailure(error: unknown): TerminalFailureV2 {
  return error instanceof TerminalV2Fault ? error.failure : fail("E_UNAVAILABLE", "unknown");
}
export function requireLive(signal: AbortSignal): void {
  if (signal.aborted) throw new TerminalV2Fault(fail("E_DEADLINE", "unknown"));
}
/** Bounded logical wait. Abort is not evidence that the underlying effect did not happen.
 * Work that ignores AbortSignal remains observed, but can never publish a late result. */
export interface TerminalDeadlineV2 {
  readonly signal: AbortSignal;
  wait<T>(work: Promise<T>): Promise<T>;
  dispose(): void;
}
export function deadline(now: () => number, ms: number, signals: readonly AbortSignal[] = []): TerminalDeadlineV2 {
  const controller = new AbortController();
  const clock = viewClock(now);
  const at = now() + clampSpanMs(ms);
  const abort = () => controller.abort();
  const timer = clock.setTimer(clampSpanMs(at - now()), abort);
  for (const signal of signals) {
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }
  return {
    signal: controller.signal,
    async wait<T>(work: Promise<T>): Promise<T> {
      void work.catch(() => {});
      requireLive(controller.signal);
      return new Promise<T>((resolve, reject) => {
        const stop = () => {
          controller.signal.removeEventListener("abort", cancelled);
        };
        const cancelled = () => {
          stop();
          reject(new TerminalV2Fault(fail("E_DEADLINE", "unknown")));
        };
        controller.signal.addEventListener("abort", cancelled, { once: true });
        work.then(
          (value) => {
            stop();
            if (controller.signal.aborted || now() >= at) cancelled();
            else resolve(value);
          },
          (error: unknown) => {
            stop();
            reject(error);
          },
        );
      });
    },
    dispose() {
      clock.clearTimer(timer);
      for (const signal of signals) signal.removeEventListener("abort", abort);
      controller.abort();
    },
  };
}
