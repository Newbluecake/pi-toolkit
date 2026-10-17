import type { ProxyTimerPort } from "../../../../src/web-hub/hub/proxy/dns-gate.js";

export function manualClock(start = 1_000) {
  let now = start;
  let serial = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const timer: ProxyTimerPort = {
    after(ms, fn) {
      const id = ++serial;
      timers.set(id, { at: now + ms, fn });
      return () => {
        timers.delete(id);
      };
    },
  };
  return {
    now: () => now,
    timer,
    advance(ms: number) {
      now += ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
        if (next === undefined) break;
        timers.delete(next[0]);
        next[1].fn();
      }
    },
    pending: () => timers.size,
  };
}
export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
