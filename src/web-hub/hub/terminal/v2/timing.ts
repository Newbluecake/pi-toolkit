/** Hub-local deadline/segmented-clock mirror. No core/domain runtime import (I8).
 * Segmentation follows core/clock.ts; each raw timer is unref'd. */
export type TimerHandle = { cancel(): void };
export function clampSpanMs(ms: number): number | undefined {
  return Number.isFinite(ms) && ms >= 0 && ms <= Number.MAX_SAFE_INTEGER ? Math.trunc(ms) : undefined;
}
export const systemClock = Object.freeze({
  now: () => Date.now(),
  setTimer(ms: number, fn: () => void): TimerHandle {
    const due = Date.now() + (clampSpanMs(ms) ?? 0);
    let stopped = false;
    let raw: NodeJS.Timeout;
    const arm = () => {
      raw = setTimeout(
        () => {
          if (stopped) return;
          if (Date.now() >= due) fn();
          else arm();
        },
        Math.min(2_147_483_647, Math.max(0, due - Date.now())),
      );
      raw.unref();
    };
    arm();
    return {
      cancel() {
        stopped = true;
        clearTimeout(raw);
      },
    };
  },
  clearTimer(h: TimerHandle): void {
    h.cancel();
  },
});
export class TerminalFaultV2 extends Error {
  constructor(
    readonly code: Exclude<import("../../../protocol/terminal-v2.js").TerminalErrorCodeV2, "E_INPUT_UNKNOWN">,
    readonly effect: "none" | "unknown" = "none",
  ) {
    super(code);
  }
}
export function failureV2(error: unknown): import("../../../protocol/terminal-v2.js").TerminalFailureV2 {
  return error instanceof TerminalFaultV2
    ? { ok: false, code: error.code, effect: error.effect }
    : { ok: false, code: "E_UNAVAILABLE", effect: "unknown" };
}
/** Logical cancellation only; the owner retains responsibility for late physical work. */
export async function boundedV2<T>(work: Promise<T>, at: number, signal: AbortSignal): Promise<T> {
  void work.catch(() => {});
  if (signal.aborted || Date.now() >= at) throw new TerminalFaultV2("E_DEADLINE", "unknown");
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      timer.cancel();
      signal.removeEventListener("abort", abort);
      fn();
    };
    const abort = () => finish(() => reject(new TerminalFaultV2("E_DEADLINE", "unknown")));
    const timer = systemClock.setTimer(clampSpanMs(Math.max(0, at - Date.now()))!, abort);
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) =>
        finish(() => {
          if (signal.aborted || Date.now() >= at) reject(new TerminalFaultV2("E_DEADLINE", "unknown"));
          else resolve(value);
        }),
      (error) => finish(() => reject(error)),
    );
  });
}
