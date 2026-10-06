/**
 * worktree-web plan §4.3 (W3): the periodic, bounded git-worktree sampler.
 *
 * Implementation note (deviates from the plan's literal API sketch on purpose,
 * per the W3 kickoff directive): `agent/index.ts`'s 1Hz `onTick` already exists
 * (`setInterval(onTick, 1_000)`, unref'd) — this sampler does NOT own a second
 * persistent interval for its 30s-baseline / up-to-5min-backoff cadence. Instead
 * `tick(now)` is called from that same existing 1Hz tick and internally decides
 * whether enough time has passed since the last scan to start another one. The
 * only timers this module creates itself are short-lived, scan-scoped, and
 * always `unref()`'d:
 *   - the per-scan hard-deadline timer (`hardDeadlineMs`, default 8000ms) — see
 *     "harness deadline" below;
 *   - the kick debounce's trailing timer (fires once, ≤ kickDebounceMs later).
 *
 * Hard deadline (r1 #1, ★ merge gate): every scan gets its own `AbortController`
 * and a `setTimeout` deadline race — the deadline firing calls `controller.abort()`
 * and immediately settles the scan as `error{timeout}`, completely independent of
 * whether the underlying `scanWorktrees`/`GitRunner` promise ever resolves (a git
 * process ignoring SIGTERM, or a `realpath` wedged in libuv's thread pool, cannot
 * delay the sampler's own observable return past `hardDeadlineMs` + a tick). A
 * scan that outlives its own deadline is tracked as a "zombie" (`zombies` set);
 * while any zombie is outstanding, no new scan is started (to avoid piling up
 * stuck processes/threads). The zombie's eventual real settlement is discarded
 * (its content is never applied — `generation` no longer matches once a
 * `start()`/`stop()` has happened since), but it is NOT a pure no-op: clearing
 * it from `zombies` is exactly what may unblock a `pendingRerun` a kick/tick
 * recorded while it was outstanding, so that rerun is attempted right there
 * (verifier W3 review #1 — a late zombie settlement used to silently drop a
 * remembered rerun forever).
 *
 * Across a `start()`/`stop()` restart (verifier W3 review #2): an in-flight
 * scan is aborted, but its confirmation of death is NOT assumed — the
 * `AbortSignal` is only a request, and a non-compliant `GitRunner` (or a
 * genuinely wedged thread-pool call) might never actually settle despite it.
 * The aborted scan is therefore folded into the SAME `zombies` tracking (never
 * cleared by `start()`/`stop()`) so a brand-new scan cannot start concurrently
 * with an unconfirmed-dead one; the guard lifts itself the moment that old
 * scan's own promise actually settles (whether via its still-armed deadline
 * timer, or because the abort did take effect after all).
 *
 * Fingerprint-gated publish: a successful scan is only turned into a cache
 * replacement + `onChange()` call when `worktreesFingerprint` actually changes
 * (content, OR the minute bucket of `sampledAt`, OR `staleMin` — see
 * `agent/worktrees.ts`). `error` results keep the previous cache (stale-while-
 * error); `not-repo` clears it.
 */
import { promises as fsPromises } from "node:fs";
import type { GitRunner } from "../../git/run.js";
import { scanWorktrees, type ScannedWorktree, type ScanResult } from "../../git/worktrees.js";
import { projectWorktrees, worktreesFingerprint } from "./worktrees.js";
import type { WorktreesWire } from "../protocol/messages.js";

const DEFAULT_HARD_DEADLINE_MS = 8_000;
const DEFAULT_BASE_INTERVAL_MS = 30_000;
const DEFAULT_MAX_INTERVAL_MS = 5 * 60_000;
const KICK_DEBOUNCE_MS = 5_000;
const STALE_AFTER_MS = 90_000;
const SLOW_SCAN_MS = 1_500;
const FAST_SCAN_MS = 500;

export interface WorktreeSampler {
  /** `readStatus`'s synchronous read of the current cached projection. Zero I/O. */
  current(): WorktreesWire | undefined;
  /** session_start: clears cache/degraded set only when `cwd` actually changed, then
   * immediately attempts a first scan (subject to `isLive()`/single-flight/zombie gating). */
  start(cwd: string): void;
  /** A real event happened (turn_end/agent_settled/fleet fingerprint change/reconnect) that
   * makes a fresher sample worth having sooner than the baseline interval. Debounced to at
   * most one scan START per `kickDebounceMs`; in-flight or zombie-blocked ⇒ remembered as a
   * single pending rerun. */
  kick(): void;
  /** Call once per second from the host's existing 1Hz tick. Starts a baseline/backoff scan
   * when due; recomputes `staleMin` on the cached wire. Returns true iff `current()`'s
   * observable shape changed as a *direct result of this call* (i.e. the staleMin edge) —
   * scan completions publish through `onChange()` instead, not through this return value. */
  tick(now: number): boolean;
  /** session_shutdown/`/reload`: aborts any in-flight scan, clears timers, bumps the
   * generation so a still-unsettled (zombied) scan can never write to the cache again. */
  stop(): void;
}

export interface WorktreeSamplerDeps {
  run: GitRunner;
  home: string | undefined;
  now: () => number;
  /** `conn?.status().state === "live"` — sampler must never run git while disconnected. */
  isLive: () => boolean;
  /** Fired exactly when `current()`'s content actually changed; caller re-publishes status. */
  onChange: () => void;
  hardDeadlineMs?: number;
  baseIntervalMs?: number;
  maxIntervalMs?: number;
  kickDebounceMs?: number;
  staleAfterMs?: number;
  realpath?: (p: string) => Promise<string>;
  scan?: { maxProbes?: number; concurrency?: number; cmdTimeoutMs?: number };
}

interface InFlightScan {
  id: number;
  generation: number;
  controller: AbortController;
}

export function createWorktreeSampler(deps: WorktreeSamplerDeps): WorktreeSampler {
  const hardDeadlineMs = deps.hardDeadlineMs ?? DEFAULT_HARD_DEADLINE_MS;
  const baseIntervalMs = deps.baseIntervalMs ?? DEFAULT_BASE_INTERVAL_MS;
  const maxIntervalMs = deps.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
  const kickDebounceMs = deps.kickDebounceMs ?? KICK_DEBOUNCE_MS;
  const staleAfterMs = deps.staleAfterMs ?? STALE_AFTER_MS;
  const realpath = deps.realpath ?? ((p: string) => fsPromises.realpath(p));

  let cwd: string | undefined;
  let cache: WorktreesWire | undefined;
  const degraded = new Set<string>();
  const zombies = new Set<number>();

  let generation = 0;
  let sampleId = 0;
  let inFlight: InFlightScan | undefined;
  let lastScanStartedAt: number | undefined;
  let currentIntervalMs = baseIntervalMs;
  let pendingRerun = false;
  let trailingTimer: { cancel(): void } | undefined;

  const unrefTimer = (ms: number, fn: () => void): { cancel(): void } => {
    const t = setTimeout(fn, ms);
    t.unref();
    return { cancel: () => clearTimeout(t) };
  };

  const clearTrailingTimer = (): void => {
    trailingTimer?.cancel();
    trailingTimer = undefined;
  };

  const canStartNow = (): boolean => cwd !== undefined && deps.isLive() && inFlight === undefined && zombies.size === 0;

  /** Consumes a remembered rerun request IF the conditions that blocked it have actually
   * cleared. Safe to call speculatively (e.g. right after a zombie settles) — `attemptStart()`
   * re-checks everything and simply re-arms `pendingRerun` if something is still blocking. */
  const tryConsumeRerun = (): void => {
    if (!pendingRerun) return;
    pendingRerun = false;
    attemptStart();
  };

  const attemptStart = (): void => {
    if (cwd === undefined) return;
    if (inFlight !== undefined || zombies.size > 0) {
      pendingRerun = true;
      return;
    }
    if (!deps.isLive()) return;
    startScan(cwd);
  };

  /** Aborts the current in-flight scan (if any) WITHOUT assuming the abort actually kills it
   * promptly — it is folded into `zombies` until its own `.then()` confirms real settlement
   * (verifier W3 review #2). Used by both `start()` and `stop()`; neither clears `zombies`
   * itself — individual entries only ever leave via that confirmed settlement. */
  const abortInFlight = (): void => {
    if (inFlight !== undefined) {
      zombies.add(inFlight.id);
      inFlight.controller.abort();
      inFlight = undefined;
    }
  };

  const startScan = (scanCwd: string): void => {
    const id = ++sampleId;
    const gen = generation;
    const controller = new AbortController();
    inFlight = { id, generation: gen, controller };
    const startedAt = deps.now();
    lastScanStartedAt = startedAt;

    let settled = false;
    const deadline = unrefTimer(hardDeadlineMs, () => {
      if (settled) return;
      settled = true;
      zombies.add(id);
      controller.abort();
      if (inFlight?.id === id) inFlight = undefined;
      finishWith(id, gen, { kind: "error", reason: "timeout" }, startedAt);
    });

    scanWorktrees(deps.run, scanCwd, {
      signal: controller.signal,
      degraded: new Set(degraded),
      realpath,
      ...(deps.scan?.maxProbes !== undefined ? { maxProbes: deps.scan.maxProbes } : {}),
      ...(deps.scan?.concurrency !== undefined ? { concurrency: deps.scan.concurrency } : {}),
      ...(deps.scan?.cmdTimeoutMs !== undefined ? { cmdTimeoutMs: deps.scan.cmdTimeoutMs } : {}),
    })
      .then(
        (result) => result,
        (): ScanResult => ({ kind: "error", reason: "spawn" }),
      )
      .then((result) => {
        zombies.delete(id);
        if (settled) {
          // A zombie (or an aborted-on-restart scan, same tracking — see module docstring)
          // settling late: the result itself is discarded (nothing here applies it to the
          // cache), but this may have been the very thing blocking a remembered rerun.
          tryConsumeRerun();
          return;
        }
        settled = true;
        deadline.cancel();
        if (inFlight?.id === id) inFlight = undefined;
        void finishWith(id, gen, result, startedAt);
      });
  };

  const finishWith = async (id: number, gen: number, result: ScanResult, startedAt: number): Promise<void> => {
    const isCurrent = gen === generation; // a stop()/start() since this scan began discards it.
    if (isCurrent) await applyResult(result, startedAt);
    tryConsumeRerun();
  };

  const applyResult = async (result: ScanResult, startedAt: number): Promise<void> => {
    const durationMs = deps.now() - startedAt;
    if (result.kind === "ok") {
      const additions = await Promise.all(
        result.worktrees
          .filter((row: ScannedWorktree) => row.unprobed === "timeout")
          .map((row) => realpath(row.path).catch(() => row.path)),
      );
      for (const key of additions) degraded.add(key);
      const sampledAt = deps.now();
      const wire = projectWorktrees(result, deps.home, sampledAt);
      replaceCacheIfChanged(wire);
      adjustBackoff(false, durationMs);
    } else if (result.kind === "not-repo") {
      if (cache !== undefined) {
        cache = undefined;
        deps.onChange();
      }
      adjustBackoff(false, durationMs);
    } else {
      // error (timeout/abort/spawn/list): stale-while-error — keep the previous cache.
      adjustBackoff(true, durationMs);
    }
  };

  const replaceCacheIfChanged = (wire: WorktreesWire): void => {
    const nextFp = worktreesFingerprint(wire);
    const prevFp = worktreesFingerprint(cache);
    if (nextFp !== prevFp) {
      cache = wire;
      deps.onChange();
    }
  };

  const adjustBackoff = (isError: boolean, durationMs: number): void => {
    if (isError || durationMs > SLOW_SCAN_MS) {
      currentIntervalMs = Math.min(maxIntervalMs, currentIntervalMs * 2);
    } else if (durationMs < FAST_SCAN_MS) {
      currentIntervalMs = baseIntervalMs;
    }
  };

  return {
    current: () => cache,

    start(newCwd: string): void {
      generation += 1;
      if (newCwd !== cwd) {
        cache = undefined;
        degraded.clear();
      }
      cwd = newCwd;
      currentIntervalMs = baseIntervalMs;
      lastScanStartedAt = undefined;
      pendingRerun = false;
      clearTrailingTimer();
      abortInFlight();
      // `zombies` is deliberately NOT cleared here (verifier W3 review #2): an old scan that
      // hasn't confirmed its own death yet (whether already zombied via its deadline, or just
      // aborted above and still unconfirmed) must keep blocking a brand-new scan from starting
      // concurrently with it. `attemptStart()` below will simply record a `pendingRerun` in
      // that case, consumed automatically once the old scan's `.then()` actually fires.
      attemptStart();
    },

    kick(): void {
      if (cwd === undefined) return;
      const now = deps.now();
      if (lastScanStartedAt !== undefined) {
        const sinceStart = now - lastScanStartedAt;
        if (sinceStart < kickDebounceMs) {
          if (trailingTimer === undefined) {
            trailingTimer = unrefTimer(kickDebounceMs - sinceStart, () => {
              trailingTimer = undefined;
              attemptStart();
            });
          }
          return;
        }
      }
      attemptStart();
    },

    tick(now: number): boolean {
      if (canStartNow() && (lastScanStartedAt === undefined || now - lastScanStartedAt >= currentIntervalMs)) {
        attemptStart();
      }
      if (cache === undefined) return false;
      const age = now - cache.sampledAt;
      if (age > staleAfterMs) {
        const staleMin = Math.floor(age / 60_000);
        if (cache.staleMin === staleMin) return false;
        cache = { ...cache, staleMin };
        return true;
      }
      if (cache.staleMin !== undefined) {
        const { staleMin: _drop, ...rest } = cache;
        cache = rest;
        return true;
      }
      return false;
    },

    stop(): void {
      generation += 1;
      abortInFlight();
      clearTrailingTimer();
      pendingRerun = false;
      cwd = undefined;
      // `zombies` is deliberately NOT cleared — same reasoning as `start()` above.
    },
  };
}
