/**
 * LAN generation scope (plan §3): a disposable tree of unref'd timers and
 * deferred cleanups, used by `startHub`'s `rootScope` (hub lifetime) and by
 * `hub/lan-controller.ts`'s per-`start()` child scope (LD, W3). Dispose is
 * idempotent, cascades to children first (most specific torn down first),
 * then runs its own defers in reverse registration order, each bounded by
 * `DEFER_DEADLINE_MS` so a wedged cleanup (e.g. a db child process ignoring
 * SIGTERM) can never block hub shutdown — errors are only logged.
 */
import type { HubLog } from "./ports.js";

export interface Scope {
  readonly signal: AbortSignal;
  /** Always unref'd; cleared on dispose. `repeat` ⇒ `setInterval`, else `setTimeout`. */
  timer(fn: () => void, ms: number, repeat?: boolean): void;
  /** Runs in reverse registration order on dispose, each bounded by 2s; errors only logged. */
  defer(fn: () => void | Promise<void>): void;
  /** A child scope disposed (recursively) before this scope's own defers run. */
  child(): Scope;
  dispose(): Promise<void>;
}

const DEFER_DEADLINE_MS = 2_000;

export function createScope(deps: { log: HubLog; now: () => number }): Scope {
  const controller = new AbortController();
  const timers = new Set<ReturnType<typeof globalThis.setTimeout> | ReturnType<typeof globalThis.setInterval>>();
  const defers: Array<() => void | Promise<void>> = [];
  const children: Scope[] = [];
  let disposePromise: Promise<void> | undefined;

  function timer(fn: () => void, ms: number, repeat = false): void {
    if (controller.signal.aborted) return;
    const t = repeat ? setInterval(fn, ms) : setTimeout(fn, ms);
    t.unref?.();
    timers.add(t);
  }

  function defer(fn: () => void | Promise<void>): void {
    defers.push(fn);
  }

  function child(): Scope {
    const c = createScope(deps);
    children.push(c);
    return c;
  }

  async function runBounded(fn: () => void | Promise<void>): Promise<void> {
    try {
      await withDeadline(
        (async () => {
          await fn();
        })(),
        DEFER_DEADLINE_MS,
      );
    } catch (err) {
      deps.log.error("web-hub scope: deferred cleanup failed", { error: String(err) });
    }
  }

  function dispose(): Promise<void> {
    if (disposePromise !== undefined) return disposePromise;
    disposePromise = (async () => {
      controller.abort();
      for (const t of timers) {
        clearTimeout(t as ReturnType<typeof globalThis.setTimeout>);
        clearInterval(t as ReturnType<typeof globalThis.setInterval>);
      }
      timers.clear();
      for (const c of [...children].reverse()) await c.dispose();
      children.length = 0;
      for (const fn of [...defers].reverse()) await runBounded(fn);
      defers.length = 0;
    })();
    return disposePromise;
  }

  return { signal: controller.signal, timer, defer, child, dispose };
}

export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`E_DEADLINE: exceeded ${ms}ms`)), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(t);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Race `p` against `signal` (plan §1.4.2): already-aborted ⇒ reject
 * immediately with `signal.reason`; otherwise race the two, discarding
 * whichever loses — a late `p` result is dropped, its cleanup is the
 * caller's job (every W1 call site that wraps a step in `withSignal` also
 * threads the same `signal` one level down so that step notices the abort
 * once its own work eventually completes and cleans up after itself).
 */
export function withSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(toAbortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(toAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function toAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" ? reason : "web-hub: aborted");
}
