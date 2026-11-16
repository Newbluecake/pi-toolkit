/** Fake only the wall clock/deadline timers: real fs, IPC and nextTick remain real.
 * Callers must await an explicit "entered the parked operation" signal before advancing.
 */
import { expect, onTestFinished, vi } from "vitest";

export function virtualTime(): void {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  onTestFinished(() => vi.useRealTimers());
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

/** Observe both outcomes immediately (also prevents unhandled rejection during advancement). */
export function observe<T>(promise: Promise<T>) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return {
    promise,
    get settled() {
      return settled;
    },
    async pendingAfter(ms: number) {
      await vi.advanceTimersByTimeAsync(ms);
      expect(settled, "must remain pending before the deadline").toBe(false);
    },
    async advance(ms: number) {
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}
