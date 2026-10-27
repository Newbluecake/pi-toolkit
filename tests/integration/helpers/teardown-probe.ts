/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Test-only instrumentation for tests/integration/stack-teardown-matrix.test.ts (#56 ⑦ step 7-1).
 *
 * Everything here records an ORDERED log of teardown-ish calls on real components without changing what they do:
 * a wrapper logs `<gen>.<component>.<method>` and then forwards to the original (same `this`, same return value).
 * `gen` is the number of the `buildSessionStack` call that created the component (g1, g2, …), so a line such as
 * `g1.usageBroadcaster.dispose` says WHICH stack's component was torn down — the whole point of the matrix.
 */
export interface TeardownProbe {
  log: string[];
  /** Number of `buildSessionStack` calls so far (across module re-imports; lives in the hoisted test scope). */
  gen: number;
  /** When true, the usage broadcaster believes one run is in flight (so `poke()` arms its 1 Hz tick). */
  fakeActiveRun: boolean;
}

export function newProbe(): TeardownProbe {
  return { log: [], gen: 0, fakeActiveRun: false };
}

const WRAPPED = Symbol.for("pi-toolkit:test:teardown-wrapped");

/** Replace `obj[name]` with a logging forwarder. Idempotent per (object, method). */
export function logMethod(probe: TeardownProbe, label: string, obj: any, name: string, tag?: string): void {
  if (obj === undefined || obj === null || typeof obj[name] !== "function") return;
  const marks: Record<string, true> = (obj[WRAPPED] ??= {});
  if (marks[name]) return;
  marks[name] = true;
  const original = obj[name] as (...args: unknown[]) => unknown;
  Object.defineProperty(obj, name, {
    configurable: true,
    writable: true,
    enumerable: true,
    value: function (this: unknown, ...args: unknown[]) {
      probe.log.push(`${label}.${tag ?? name}`);
      return original.apply(this, args);
    },
  });
}

/** Wrap every teardown-relevant member the built `Stack` exposes. Absent members are skipped. */
export function instrumentStack(probe: TeardownProbe, stack: any, gen: number): void {
  const p = `g${gen}`;
  const on = (label: string, obj: any, ...names: string[]) => {
    for (const name of names) logMethod(probe, `${p}.${label}`, obj, name);
  };
  on("xs", stack.xs, "dispose");
  if (stack.xs?.fence && typeof stack.xs.fence.onEvent === "function" && !stack.xs.fence[WRAPPED]) {
    const original = stack.xs.fence.onEvent.bind(stack.xs.fence) as (event: { type: string }) => unknown;
    stack.xs.fence[WRAPPED] = { onEvent: true };
    stack.xs.fence.onEvent = (event: { type: string }) => {
      if (event.type === "session_shutdown") probe.log.push(`${p}.xs.fence.session_shutdown`);
      return original(event);
    };
  }
  on("rootWakeRecovery", stack.rootWakeRecovery, "dispose");
  on("backgroundCompletions", stack.backgroundCompletions, "dispose");
  on("schedule", stack.schedule, "shutdown", "dispose");
  on("scheduleBackground", stack.scheduleBackground, "dispose");
  on("fleetWidget", stack.fleetWidget, "dispose");
  on("bashJobs", stack.bashJobs, "dispose");
  on("archive", stack.archive, "dispose");
  on("bashJobRecovery", stack.bashJobRecovery, "dispose");
  on("keepalive", stack.keepalive, "dispose");
  on("quota", stack.quota, "dispose");
  on("dynamic", stack.dynamic, "dispose");
  on("load", stack.load, "dispose");
  on("rpc", stack.rpc, "close");
  on("external", stack.external, "dispose");
  on("notifier", stack.notifier, "dispose");
  on("workflow.runs", stack.workflow?.runs, "abandon", "shutdown", "drain", "seal");
  on("runJournal", stack.runJournal, "flushPending");
  on("spawn", stack.spawn, "abort");
  on("query", stack.query, "waitAll");
  on("worktreeLate", stack.worktreeLate, "dispose");
  on("worktreeOrphansStartup", stack.worktreeOrphansStartup, "dispose");
}

/** Where a timer was created: the first stack frame under `src/` that is not the clock plumbing. */
export function timerSite(): string {
  const lines = (new Error().stack ?? "").split("\n").slice(2);
  for (const line of lines) {
    const m = /\/(src\/[^:)]+\.ts)/.exec(line);
    if (m && m[1] !== undefined && !m[1].endsWith("core/clock.ts")) return m[1];
  }
  return "(outside src)";
}

export interface TimerTrack {
  /** Timers created since `start` that neither fired nor were cleared: `{site, ms, ref}`. */
  outstanding(): Array<{ site: string; ms: number; ref: boolean }>;
  stop(): void;
}

/**
 * Wraps the (fake) global setTimeout/clearTimeout so every timer created while tracking is attributed to a
 * `src/**` file. Call AFTER `vi.useFakeTimers()`; `stop()` restores the fake functions.
 */
export function trackTimers(): TimerTrack {
  const g = globalThis as any;
  const saved = {
    setTimeout: g.setTimeout,
    clearTimeout: g.clearTimeout,
    setInterval: g.setInterval,
    clearInterval: g.clearInterval,
  };
  const live = new Map<unknown, { site: string; ms: number }>();
  g.setTimeout = (fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const site = timerSite();
    let handle: unknown;
    handle = saved.setTimeout(
      (...a: unknown[]) => {
        live.delete(handle);
        fn(...a);
      },
      ms,
      ...rest,
    );
    live.set(handle, { site, ms: ms ?? 0 });
    return handle;
  };
  g.setInterval = (fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const handle = saved.setInterval(fn, ms, ...rest);
    live.set(handle, { site: timerSite(), ms: ms ?? 0 });
    return handle;
  };
  const clear = (original: (h: unknown) => void) => (handle: unknown) => {
    live.delete(handle);
    original(handle);
  };
  g.clearTimeout = clear(saved.clearTimeout);
  g.clearInterval = clear(saved.clearInterval);
  return {
    outstanding: () =>
      [...live.entries()].map(([handle, info]) => ({
        ...info,
        ref: typeof (handle as any)?.hasRef === "function" ? (handle as any).hasRef() : true,
      })),
    stop: () => Object.assign(g, saved),
  };
}
