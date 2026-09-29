import { compareVersions } from "../protocol/version.js";
import { readStopMarkerSync, type StopMarkerRead } from "../protocol/stop-marker.js";

/** The user-visible replacement deadline is deliberately process-local and bounded. */
export const SUPERSEDE_DEFAULT_MAX_WAIT_MS = 30 * 60_000;
export const SUPERSEDE_MIN_WAIT_MS = 10_000;
export const SUPERSEDE_MAX_WAIT_MS = SUPERSEDE_DEFAULT_MAX_WAIT_MS;
export const SUPERSEDE_YIELD_MS = 10_000;
export const SUPERSEDE_THROTTLE_MS = 60_000;
export const SUPERSEDE_DRAIN_MAX_MS = 15_000;
/** acc32-B9: how long `observe()` will wait for a newly-hello'd agent's first `dialogs` slot
 * frame before treating it as "no open dialog" and letting the (now-current) quiet judgment
 * proceed. Bounded per the task's "1–2s" guidance — long enough to cover the extra hub→agent→hub
 * round trip past `hello_ack` that carries the replayed slot, short enough that a genuinely quiet
 * hub still replaces promptly. */
export const SUPERSEDE_DIALOGS_HANDSHAKE_MS = 1_500;

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
   * acc32-B9 (revised per verifier r_29729WTC): a `setTimeout(fn, 0)` defer off the hello call
   * stack is not a reliable handshake — a reconnecting agent's `dialogs` slot frame (D14:
   * replayed only *after* `hello_ack` reaches the agent, i.e. a full extra hub→agent→hub round
   * trip beyond the `hello` that triggered `observe()`) can easily still be in flight when a
   * same-process 0ms timer fires; that is exactly the `waitedMs:0` immediate-replace bug the
   * plan's acceptance step 26/32 caught. The real fix has to actually wait for that frame:
   * `awaitDialogsSlot(agentKey, timeoutMs)` resolves either when `agentKey`'s first `dialogs`
   * frame lands (hub wires this to a one-shot `registry.bus` subscription, resolving immediately
   * if the registry already has a snapshot for it) or after `timeoutMs` elapses, whichever is
   * first — the bounded timeout is what keeps the "no open dialog" fast-replacement path from
   * hanging on an agent that never sends the frame at all (an older/minimal agent build).
   * `observe()` calls this at most once per `agentKey` (memoized) and only defers *that* agent's
   * contribution to the first quiet judgment — the periodic 250ms tick and the dialogs-bus
   * defense-in-depth re-check (hub.ts) are unaffected and keep running on their own schedule.
   * Missing in `deps` (e.g. a minimal test harness) degrades to "already resolved" (old
   * synchronous behavior), never to a permanent hang.
   */
  awaitDialogsSlot?: (agentKey: string, timeoutMs: number) => Promise<void>;
}

export interface SupersedeController {
  state(): SupersedeState | undefined;
  /** `agentKey` is optional only for older/minimal callers; hub.ts always passes it (needed for
   * the acc32-B9 dialogs handshake below — without it the first quiet check falls back to
   * running as soon as `observe()` returns, the pre-fix synchronous behavior). */
  observe(pluginVersion: string, agentKey?: string): void;
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
  /** acc32-B9: agentKeys we've already started (or finished) a dialogs handshake for — each
   * newly-hello'd agent gets at most one wait, never re-armed on a later `observe()` (e.g. a
   * still-higher version arriving from the same connection). */
  const dialogsAwaited = new Set<string>();
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
    observe(pluginVersion, agentKey) {
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
      // acc32-B9: never quiet-check the first time on nothing but a same-tick/0ms guess — actually
      // wait for THIS agent's `dialogs` slot frame (or the bounded handshake timeout) before
      // letting its contribution count toward quiet. `dialogsAwaited` makes this at most once per
      // agentKey; a missing `agentKey` (older/minimal caller) or a missing `awaitDialogsSlot` dep
      // degrades to the old "resolved immediately" behavior rather than hanging. `begin()`'s own
      // re-entrancy guard (`running`) plus the periodic 250ms tick and the dialogs-bus
      // defense-in-depth re-check (hub.ts) already cover any tick this defers past a
      // dispose/replace.
      if (agentKey === undefined || dialogsAwaited.has(agentKey)) {
        tick();
        return;
      }
      dialogsAwaited.add(agentKey);
      const wait = d.awaitDialogsSlot?.(agentKey, SUPERSEDE_DIALOGS_HANDSHAKE_MS) ?? Promise.resolve();
      Promise.resolve(wait).then(
        () => {
          if (!disposed) tick();
        },
        (err: unknown) => {
          d.log?.warn("web-hub: supersede awaitDialogsSlot failed", { agentKey, error: String(err) });
          if (!disposed) tick();
        },
      );
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
