import { compareVersions } from "../protocol/version.js";
import { readStopMarkerSync, type StopMarkerRead } from "../protocol/stop-marker.js";

/** The user-visible replacement deadline is deliberately process-local and bounded. */
export const SUPERSEDE_DEFAULT_MAX_WAIT_MS = 30 * 60_000;
export const SUPERSEDE_MIN_WAIT_MS = 10_000;
export const SUPERSEDE_MAX_WAIT_MS = SUPERSEDE_DEFAULT_MAX_WAIT_MS;
export const SUPERSEDE_YIELD_MS = 10_000;
export const SUPERSEDE_THROTTLE_MS = 60_000;
export const SUPERSEDE_DRAIN_MAX_MS = 15_000;

export interface SupersedeState {
  nextVersion: string;
  since: number;
  deadlineAt: number;
  forced?: boolean;
  /** §6.7.3 ①: a stop marker (stopped, or unreadable ⇒ fail-closed unknown) outranks the 30min
   * deadline — while it holds the replacement is paused and the top bar shows "升级已暂停". */
  blocked?: "stopped" | "unknown";
}

export interface SupersedeOpenDialog {
  agentKey: string;
  count: number;
}

export interface SupersedeDeps {
  hubVersion: string;
  now: () => number;
  stopFile?: string;
  readStop?: (file: string) => StopMarkerRead;
  /** Live registry snapshot. `dialogs.open` is the only data used. */
  openDialogs: () => readonly SupersedeOpenDialog[];
  inflight: () => number;
  /** LAN KDF work is separate from command-router forwards. */
  kdfInflight?: () => number;
  /** Called after the state has entered restarting. Must drain, send the frame, and close. */
  restart: (args: {
    nextVersion: string;
    forced: boolean;
    openDialogs: readonly SupersedeOpenDialog[];
    inflightAtDrain: number;
  }) => void | Promise<void>;
  stateChanged?: (state: SupersedeState | undefined) => void;
  audit?: (op: "supersede" | "supersede_blocked", fields: Record<string, unknown>) => void;
  log?: { warn(msg: string, data?: object): void };
  /**
   * acc32-B9: the very first quiet check after `observe()` sees a version mismatch must not run
   * synchronously inside the hello-processing call stack — a reconnecting agent's `dialogs` slot
   * (D14: replayed once the connection is live, strictly *after* `hello`) may not have arrived
   * yet, so an already-open ask_user dialog from before the reconnect would be invisible to
   * `openDialogs()` at that exact instant and get raced past (`waitedMs:0` immediate replace).
   * Defaults to a real `setTimeout(fn, 0)` (unref'd) so the check runs on a later turn of the
   * event loop, after any frame that arrived in the same socket read as `hello` has been
   * processed; injectable so tests can make the deferral deterministic instead of timer-based.
   */
  defer?: (fn: () => void) => void;
}

export interface SupersedeController {
  state(): SupersedeState | undefined;
  observe(pluginVersion: string): void;
  tick(): void;
  dispose(): void;
}

export function supersedeWaitMs(env: NodeJS.ProcessEnv = process.env, log?: SupersedeDeps["log"]): number {
  const raw = env["PI_WEBHUB_SUPERSEDE_MAX_WAIT_MS"];
  if (raw === undefined || raw.trim() === "") return SUPERSEDE_DEFAULT_MAX_WAIT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < SUPERSEDE_MIN_WAIT_MS || n > SUPERSEDE_MAX_WAIT_MS) {
    log?.warn("web-hub: invalid PI_WEBHUB_SUPERSEDE_MAX_WAIT_MS; using 30 minutes", { value: raw });
    return SUPERSEDE_DEFAULT_MAX_WAIT_MS;
  }
  return Math.trunc(n);
}

/**
 * Version replacement state machine. It is intentionally independent of pi and
 * of the HTTP implementation: registry/commands/hub supply only observations
 * and a single restart callback. This keeps the safety rules testable in fake
 * clock tests and makes stop-marker failures fail closed.
 */
export function createSupersede(deps?: SupersedeDeps): SupersedeController {
  if (deps === undefined) return createSupersedeStub();
  const d = deps;
  const waitMs = supersedeWaitMs(process.env, d.log);
  const defer =
    d.defer ??
    ((fn: () => void) => {
      const t = setTimeout(fn, 0);
      t.unref?.();
    });
  let pending: SupersedeState | undefined;
  let lastReplacementAt = Number.NEGATIVE_INFINITY;
  let blockedLogged = false;
  let disposed = false;
  let running = false;

  function emit(): void {
    d.stateChanged?.(pending === undefined ? undefined : { ...pending });
  }

  function stopState(): StopMarkerRead {
    if (d.stopFile === undefined) return { state: "absent" };
    try {
      return (d.readStop ?? readStopMarkerSync)(d.stopFile);
    } catch (err) {
      return { state: "unknown", code: err instanceof Error ? err.message : "EIO" };
    }
  }

  function begin(forced: boolean, stop: StopMarkerRead): void {
    if (disposed || running || pending === undefined) return;
    if (stop.state !== "absent") {
      if (forced && !blockedLogged) {
        blockedLogged = true;
        d.audit?.("supersede_blocked", { reason: "stop", stop: stop.state });
      }
      return;
    }
    if (!forced && d.now() - lastReplacementAt < SUPERSEDE_THROTTLE_MS) return;
    running = true;
    const current = pending;
    const openDialogs = d.openDialogs();
    const inflightAtDrain = d.inflight();
    pending = { ...current, ...(forced ? { forced: true as const } : {}) };
    emit();
    d.audit?.("supersede", {
      from: d.hubVersion,
      to: current.nextVersion,
      forced,
      waitedMs: Math.max(0, d.now() - current.since),
      openDialogs: openDialogs.reduce((n, x) => n + x.count, 0),
      inflightAtDrain,
    });
    Promise.resolve(d.restart({ nextVersion: current.nextVersion, forced, openDialogs, inflightAtDrain }))
      .then(() => {
        lastReplacementAt = d.now();
        running = false;
        pending = undefined;
        emit();
      })
      .catch((err: unknown) => {
        // A failed close must not leave the controller permanently wedged. Keep
        // the pending state and retry on the next observation/tick.
        running = false;
        d.log?.warn("web-hub: supersede restart failed", { error: String(err) });
      });
  }

  function tick(): void {
    if (disposed || pending === undefined || running) return;
    const t = d.now();
    const stop = stopState();
    // Surface blocked-state transitions to the SSE `info` frame (the 250ms tick cadence is the
    // only place the stop marker is sampled, so this doubles as the "升级已暂停" data path).
    const blockedNow = stop.state === "absent" ? undefined : (stop.state as "stopped" | "unknown");
    if (pending.blocked !== blockedNow) {
      const next = { ...pending };
      if (blockedNow === undefined) {
        delete next.blocked;
        blockedLogged = false; // re-blocking re-audits
      } else {
        next.blocked = blockedNow;
      }
      pending = next;
      emit();
    }
    const quiet = d.openDialogs().every((x) => x.count === 0) && d.inflight() === 0 && (d.kdfInflight?.() ?? 0) === 0;
    if (quiet && stop.state === "absent") {
      begin(false, stop);
      return;
    }
    if (t >= pending.deadlineAt) {
      // Stop intent has priority over the deadline. Once it disappears, this
      // same tick path immediately retries because deadlineAt remains elapsed.
      begin(true, stop);
    }
  }

  return {
    state: () => (pending === undefined ? undefined : { ...pending }),
    observe(pluginVersion) {
      if (disposed || compareVersions(pluginVersion, d.hubVersion) <= 0) return;
      const t = d.now();
      if (pending === undefined) {
        pending = { nextVersion: pluginVersion, since: t, deadlineAt: t + waitMs };
        blockedLogged = false;
        emit();
      } else if (compareVersions(pluginVersion, pending.nextVersion) > 0) {
        // `since` and `deadlineAt` are intentionally not rewritten.
        pending = { ...pending, nextVersion: pluginVersion };
        emit();
      }
      // acc32-B9: never quiet-check synchronously inside the hello call stack — defer so a
      // `dialogs` frame that arrives right after this same `hello` (D14 reconnect replay) has a
      // chance to update the registry first. `begin()`'s own re-entrancy guard (`running`) plus
      // the periodic 250ms tick already cover any tick this defers past a dispose/replace.
      defer(tick);
    },
    tick,
    dispose() {
      disposed = true;
      pending = undefined;
      running = false;
      emit();
    },
  };
}

/** Kept for C0 callers and external tests that only need the original tiny seam. */
export function createSupersedeStub(): SupersedeController {
  return { state: () => undefined, observe() {}, tick() {}, dispose() {} };
}
