/** #50 P50.1: per-session, pi-free trigger/aggregation owner. No model, writes,
 * messages, audit or proposal storage. P50.2 registers ONE handler at wireMemory.
 * Candidate revisions are selection evidence, NOT §4.2 raw-byte frozen inputs or
 * §5 prepared/proposed/committed evidence. P50.2 must freeze before any request. */
import { createHash } from "node:crypto";
import { systemClock, type Clock, type TimerHandle } from "../../core/clock.js";
import { clampSpanMs } from "../../core/deadline.js";
import type { MemoryIncrementalSettings } from "../settings.js";
import type { MemoryActivityPort, MemoryActivitySnapshot } from "./activity.js";
import { isExternalWriteOrigin } from "./write-origin.js";

export const INCREMENTAL_POLICY_VERSION = "p50-selection-v1";
export const INCREMENTAL_DIRECTORY_LIMIT = 8;
export const INCREMENTAL_ACTION_LIMIT = 16;
export type IncrementalState = "idle" | "quiet-wait" | "idle-wait" | "running" | "cooldown" | "stopped";
export interface IncrementalDirectory {
  readonly realpath: string;
  readonly dev: number;
  readonly ino: number;
  readonly sessionEpoch: number;
}
export interface IncrementalCandidate {
  readonly id: string;
  readonly rev: string;
  readonly topic: string;
  readonly authority: "user" | "agent";
}
export interface IncrementalCorpus {
  readonly fingerprint: string;
  readonly candidates: readonly IncrementalCandidate[];
  readonly omittedCount: number;
}
export interface MemoryIdleLease {
  readonly generation: number;
  readonly lastActivityAt: number;
}
export interface IncrementalBatch {
  readonly v: 1;
  readonly batchId: string;
  readonly policyVersion: typeof INCREMENTAL_POLICY_VERSION;
  readonly directory: IncrementalDirectory;
  readonly corpus: IncrementalCorpus;
  readonly changeCount: number;
  readonly taskDoneEligible: boolean;
  readonly lastExternalWriteAt: number;
  readonly activityLease: MemoryIdleLease;
  readonly limits: { readonly autoActions: 2; readonly generateRequests: 2; readonly jobCostCapUsd: number };
}
export interface IncrementalAttemptContext {
  readonly signal: AbortSignal;
  /** Recheck after EVERY await. False forbids any late proposal/body write. */
  isCurrent(): boolean;
  /** Recheck after every await and immediately before any automatic commit. */
  leaseValid(): boolean;
  /** High-level generate cap only. P50.2 ALSO reserves actual provider attempts,
   * bounded queue, concurrency, zombie and worst-cost in the SINGLE JevClient.
   * Unknown/unpriced/no adapter defaults to denial (jobCostCapUsd is zero). */
  tryStartGenerate(): boolean;
  capReached(): void;
}
export type IncrementalResult = { readonly kind: "settled" | "cap-reached" | "revision-unavailable" };
export type IncrementalBatchHandler = (
  batch: IncrementalBatch,
  context: IncrementalAttemptContext,
) => Promise<IncrementalResult> | IncrementalResult;
/** Explicit P50.2 seam: the production default performs zero requests/writes. */
export const unavailableIncrementalHandler: IncrementalBatchHandler = () => ({ kind: "revision-unavailable" });
export type IncrementalEvent =
  "quiet-elapsed" | "host-idle" | "task-done" | "cooldown-elapsed" | "settled" | "cap-reached";
interface Pending {
  count: number;
  taskDoneEligible: boolean;
  quietSatisfied: boolean;
  lastExternalWriteAt: number;
  corpus: IncrementalCorpus;
}
interface DirectoryState {
  identity: IncrementalDirectory;
  state: IncrementalState;
  pending?: Pending;
  cooldownUntil: number;
  dormant: boolean;
  active?: { controller: AbortController; batch: IncrementalBatch };
  lateDiagnosed: boolean;
}
export interface IncrementalDeps {
  readonly settings: MemoryIncrementalSettings;
  /** Host-resolved explicit batch budget. Absent/invalid is 0 (no paid opt-in).
   * Frozen into each batch; not a setting, route or bypass of client admission. */
  readonly jobCostCapUsd?: number;
  /** Undefined owner => stopped, zero timer, zero handler/client/write. */
  activity(): MemoryActivityPort | undefined;
  isCurrent(directory: IncrementalDirectory): boolean;
  /** Synchronous, read-only selection snapshot; never use a stale corpus fallback. */
  readCorpus(directory: IncrementalDirectory): IncrementalCorpus | undefined;
  readonly handler?: IncrementalBatchHandler;
  /** P50.2 checks ALL queue/call/cost/concurrency budgets synchronously.
   * Required before entering running AND rechecked before every generate attempt;
   * absent/throw/false denies. Batch admission is not a permanent reservation. */
  readonly canAttempt?: (batch: IncrementalBatch) => boolean;
  readonly clock?: Clock;
  readonly diagnostic?: (line: string) => void;
}
const keyOf = (d: IncrementalDirectory): string => JSON.stringify([d.realpath, d.dev, d.ino, d.sessionEpoch]);
const digest = (data: unknown): string => createHash("sha256").update(JSON.stringify(data)).digest("hex");

export function createIncrementalScheduler(deps: IncrementalDeps) {
  const clock = deps.clock ?? systemClock; // segmented and unref'd, including every long-delay segment
  const settings = {
    ...deps.settings,
    quietMs: clampSpanMs(deps.settings.quietMs) ?? 0,
    idleMs: clampSpanMs(deps.settings.idleMs) ?? 0,
    cooldownMs: clampSpanMs(deps.settings.cooldownMs) ?? 0,
  };
  const directories = new Map<string, DirectoryState>();
  let timer: TimerHandle | undefined;
  let naturalWakeAt: number | undefined;
  let stopped = !settings.enabled;
  let owner: MemoryActivityPort | undefined;
  let unsubscribe: (() => void) | undefined;
  let ownerDiagnosed = false;
  const diagnostic = (line: string): void => {
    try {
      deps.diagnostic?.(line);
    } catch {
      /* diagnostics never change admission */
    }
  };
  const cancelTimer = (): void => {
    if (timer) clock.clearTimer(timer);
    timer = undefined;
  };
  const stopDirectory = (d: DirectoryState): void => {
    d.state = "stopped";
    d.active?.controller.abort();
    delete d.active;
    delete d.pending;
  };
  function stop(_reason: "abort" | "shutdown" | "reload" | "owner-unavailable" = "abort"): void {
    stopped = true;
    cancelTimer();
    naturalWakeAt = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    for (const d of directories.values()) stopDirectory(d);
  }
  const activity = (): MemoryActivitySnapshot | undefined => {
    if (stopped) return undefined;
    let current: MemoryActivityPort | undefined;
    try {
      current = deps.activity();
    } catch {
      /* unknown is off */
    }
    if (!current || (owner && current !== owner)) {
      if (!ownerDiagnosed) {
        ownerDiagnosed = true;
        diagnostic("p50: activity owner unavailable; incremental revision disabled");
      }
      stop("owner-unavailable");
      return undefined;
    }
    if (!owner) {
      owner = current;
      try {
        unsubscribe = current.subscribe?.(() => activityChanged());
      } catch {
        stop("owner-unavailable");
        return undefined;
      }
    }
    try {
      return current.snapshot(clock.now());
    } catch {
      return undefined;
    }
  };
  const current = (d: DirectoryState): boolean => {
    if (stopped || d.state === "stopped") return false;
    try {
      if (deps.isCurrent(d.identity)) return true;
    } catch {
      /* fail closed */
    }
    stopDirectory(d);
    return false;
  };
  const readCorpus = (d: IncrementalDirectory): IncrementalCorpus | undefined => {
    try {
      return deps.readCorpus(d);
    } catch {
      return undefined;
    }
  };
  const eligible = (p: Pending): boolean => p.count >= settings.changeThreshold || p.taskDoneEligible;
  const hostQuiet = (s: MemoryActivitySnapshot | undefined): s is MemoryActivitySnapshot =>
    s !== undefined &&
    s.running === false &&
    s.toolsInFlight === 0 &&
    s.liveIdle === true &&
    s.hasPendingMessages === false &&
    Number.isFinite(s.lastActivityAt) &&
    Number.isFinite(s.generation);
  const leaseValid = (lease: MemoryIdleLease): boolean => {
    const s = activity();
    return (
      hostQuiet(s) &&
      s.generation === lease.generation &&
      s.lastActivityAt === lease.lastActivityAt &&
      clock.now() - s.lastActivityAt >= settings.idleMs
    );
  };
  const budgetAllows = (batch: IncrementalBatch): boolean => {
    try {
      return deps.canAttempt?.(batch) === true;
    } catch {
      return false;
    }
  };
  const cap = (d: DirectoryState): void => {
    if (!current(d)) return;
    // Preserve ONE change evidence; no self retry until a new natural write/task-done.
    const batch = d.active?.batch;
    d.active?.controller.abort();
    delete d.active;
    const p = d.pending;
    const corpus = p?.corpus ?? batch?.corpus;
    if (corpus)
      d.pending = {
        count: 1,
        taskDoneEligible: false,
        quietSatisfied: false,
        lastExternalWriteAt: p?.lastExternalWriteAt ?? batch!.lastExternalWriteAt,
        corpus,
      };
    d.state = "quiet-wait";
    d.dormant = true;
  };
  function start(d: DirectoryState, snapshot: MemoryActivitySnapshot): void {
    const p = d.pending!;
    // Selection snapshot is copied/frozen. Never inject a trailing revision into it.
    const corpus = Object.freeze({
      ...p.corpus,
      candidates: Object.freeze(p.corpus.candidates.map((c) => Object.freeze({ ...c }))),
    });
    const directory = Object.freeze({ ...d.identity });
    const batch: IncrementalBatch = Object.freeze({
      v: 1,
      batchId: digest([
        directory.sessionEpoch,
        keyOf(directory),
        corpus.candidates.map((c) => [c.id, c.rev]),
        INCREMENTAL_POLICY_VERSION,
      ]),
      policyVersion: INCREMENTAL_POLICY_VERSION,
      directory,
      corpus,
      changeCount: p.count,
      taskDoneEligible: p.taskDoneEligible,
      lastExternalWriteAt: p.lastExternalWriteAt,
      activityLease: Object.freeze({ generation: snapshot.generation, lastActivityAt: snapshot.lastActivityAt }),
      limits: Object.freeze({
        autoActions: 2,
        generateRequests: 2,
        jobCostCapUsd: Number.isFinite(deps.jobCostCapUsd) && deps.jobCostCapUsd! > 0 ? deps.jobCostCapUsd! : 0,
      }),
    });
    // §2.2(4): batch admission MUST precede pending consumption, running and
    // handler dispatch. Denial retains one change evidence, dormant (no retry loop).
    if (!budgetAllows(batch)) {
      cap(d);
      return;
    }
    // A synchronous admission port may reenter the host; never consume a newer
    // pending batch or an invalidated lease after checking the old selection.
    if (!current(d) || d.state !== "idle-wait" || d.pending !== p || !leaseValid(batch.activityLease)) return;
    const active = { controller: new AbortController(), batch };
    d.active = active;
    delete d.pending;
    d.state = "running";
    let generates = 0;
    const isCurrent = (): boolean =>
      current(d) && d.active === active && !active.controller.signal.aborted && activity() !== undefined;
    const context: IncrementalAttemptContext = {
      signal: active.controller.signal,
      isCurrent,
      leaseValid: () => isCurrent() && leaseValid(batch.activityLease),
      tryStartGenerate: () => {
        if (!isCurrent() || !leaseValid(batch.activityLease)) return false;
        // The earlier batch check is not a reservation: budgets can change
        // while a handler awaits, so each attempt needs fresh admission too.
        if (generates >= batch.limits.generateRequests || !budgetAllows(batch)) {
          cap(d);
          arm();
          return false;
        }
        generates++;
        return true;
      },
      capReached: () => {
        if (d.active === active) {
          cap(d);
          arm();
        }
      },
    };
    // Detached opportunity; no synchronous write path or turn is held open.
    void Promise.resolve()
      .then(() => {
        if (!isCurrent()) return undefined;
        return (deps.handler ?? unavailableIncrementalHandler)(batch, context);
      })
      .then(
        (result) => {
          if (!isCurrent()) {
            if (!d.lateDiagnosed) {
              d.lateDiagnosed = true;
              diagnostic("p50: late batch result ignored");
            }
            return;
          }
          if (result?.kind === "cap-reached") cap(d);
          else event(d, "settled");
          arm();
        },
        () => {
          if (isCurrent()) {
            cap(d);
            arm();
          } else if (!d.lateDiagnosed) {
            d.lateDiagnosed = true;
            diagnostic("p50: late batch result ignored");
          }
        },
      );
  }
  function event(d: DirectoryState, kind: IncrementalEvent): void {
    if (!current(d)) return;
    const now = clock.now(),
      p = d.pending;
    if (kind === "cap-reached") {
      cap(d);
      return;
    }
    if (kind === "settled") {
      if (d.state !== "running") return;
      delete d.active;
      d.state = "cooldown";
      d.cooldownUntil = now + settings.cooldownMs;
      if (p && p.corpus.candidates.length === 0 && p.corpus.omittedCount > 0) cap(d);
      return;
    }
    if (kind === "task-done") {
      if (!settings.taskDoneTrigger || !p || d.state === "running") return;
      p.taskDoneEligible = true;
      d.dormant = false;
      if (d.state === "quiet-wait" && (p.quietSatisfied || now - p.lastExternalWriteAt >= settings.quietMs)) {
        p.quietSatisfied = true;
        d.state = "idle-wait";
      }
      return; // NEVER bypass quiet, continuous idle or cooldown
    }
    if (kind === "cooldown-elapsed") {
      if (now < d.cooldownUntil) return;
      d.cooldownUntil = 0; // real release also in quiet-wait/idle-wait
      if (d.state === "cooldown") d.state = p ? "quiet-wait" : "idle";
      if (p && d.state === "quiet-wait" && !d.dormant) event(d, "quiet-elapsed");
      return;
    }
    if (!p || d.dormant) return;
    if (kind === "quiet-elapsed") {
      if (d.state !== "quiet-wait" || now - p.lastExternalWriteAt < settings.quietMs) return;
      const corpus = readCorpus(d.identity);
      if (!corpus || corpus.fingerprint !== p.corpus.fingerprint) {
        cap(d);
        return;
      }
      p.quietSatisfied = true;
      if (eligible(p)) d.state = "idle-wait"; // threshold is a HARD gate here
      return;
    }
    if (kind === "host-idle") {
      if (d.state !== "idle-wait" || !eligible(p) || !p.quietSatisfied || now < d.cooldownUntil) return;
      const s = activity(); // real context, NOT a captured idle boolean
      if (!hostQuiet(s) || now - s.lastActivityAt < settings.idleMs) return;
      const corpus = readCorpus(d.identity);
      if (!corpus || corpus.fingerprint !== p.corpus.fingerprint) {
        cap(d);
        return;
      }
      start(d, s);
    }
  }
  function arm(): void {
    cancelTimer();
    const snapshot = activity();
    if (stopped) return;
    const now = clock.now();
    let due = Infinity;
    for (const d of directories.values()) {
      if (!current(d) || d.dormant || d.state === "running") continue;
      if (d.cooldownUntil > 0 || d.state === "cooldown") due = Math.min(due, Math.max(now, d.cooldownUntil));
      const p = d.pending;
      if (!p) continue;
      // Optional no-subscribe fallback: one delayed live check per natural
      // tool/result/turn-end event, never a self-rearming busy-host poll.
      if (naturalWakeAt !== undefined) due = Math.min(due, naturalWakeAt);
      if (d.state === "quiet-wait" && !p.quietSatisfied)
        due = Math.min(due, Math.max(now, p.lastExternalWriteAt + settings.quietMs));
      if (d.state === "idle-wait" && now >= d.cooldownUntil && hostQuiet(snapshot))
        due = Math.min(due, Math.max(now, snapshot.lastActivityAt + settings.idleMs));
    }
    if (!Number.isFinite(due)) return;
    timer = clock.setTimer(clampSpanMs(due - now) ?? 0, () => {
      timer = undefined;
      if (naturalWakeAt !== undefined && clock.now() >= naturalWakeAt) naturalWakeAt = undefined;
      if (!activity() || stopped) return;
      for (const d of directories.values()) {
        if (!current(d) || d.dormant) continue;
        if ((d.cooldownUntil > 0 || d.state === "cooldown") && clock.now() >= d.cooldownUntil)
          event(d, "cooldown-elapsed");
        event(d, "quiet-elapsed");
        event(d, "host-idle");
      }
      arm();
    });
  }
  function activityChanged(naturalWake = false): void {
    if (stopped) return;
    if (naturalWake) naturalWakeAt = clock.now() + (clampSpanMs(settings.idleMs) ?? 0);
    arm();
  }
  return {
    externalWrite(identity: IncrementalDirectory, corpus: IncrementalCorpus, origin?: string): void {
      if (stopped || !isExternalWriteOrigin(origin) || !activity()) return;
      const key = keyOf(identity);
      for (const [oldKey, old] of directories) {
        if (old.identity.realpath === identity.realpath && oldKey !== key) {
          stopDirectory(old);
          directories.delete(oldKey);
        }
      }
      let d = directories.get(key);
      if (!d) {
        if (directories.size >= INCREMENTAL_DIRECTORY_LIMIT) return;
        d = {
          identity: Object.freeze({ ...identity }),
          state: "idle",
          cooldownUntil: 0,
          dormant: false,
          lateDiagnosed: false,
        };
        directories.set(key, d);
      }
      if (!current(d)) return;
      const used = [...directories.values()]
        .filter((other) => other !== d)
        .reduce((n, other) => n + (other.pending?.corpus.candidates.length ?? 0), 0);
      const available = Math.max(0, INCREMENTAL_ACTION_LIMIT - used);
      const selected = corpus.candidates.slice(0, available);
      const bounded = {
        ...corpus,
        candidates: selected.map((c) => ({ ...c })),
        omittedCount: corpus.omittedCount + corpus.candidates.length - selected.length,
      };
      const prior = d.pending;
      d.pending = {
        count: Math.min(Number.MAX_SAFE_INTEGER, (prior?.count ?? 0) + 1),
        taskDoneEligible: prior?.taskDoneEligible ?? false,
        quietSatisfied: false,
        lastExternalWriteAt: clock.now(),
        corpus: bounded,
      };
      d.dormant = false;
      // running retains exactly one trailing batch; every other state resets quiet.
      if (d.state !== "running") d.state = "quiet-wait";
      if (!available && d.state !== "running") cap(d);
      arm();
    },
    taskDone(identity: IncrementalDirectory): void {
      const d = directories.get(keyOf(identity));
      if (d) event(d, "task-done");
      if (!stopped) arm();
    },
    activityChanged,
    stop,
    /** Read-only test/diagnostic view. No live mutable references escape. */
    inspect(identity: IncrementalDirectory) {
      const d = directories.get(keyOf(identity));
      return d
        ? {
            state: d.state,
            pendingCount: d.pending?.count ?? 0,
            taskDoneEligible: d.pending?.taskDoneEligible ?? false,
            quietSatisfied: d.pending?.quietSatisfied ?? false,
            cooldownUntil: d.cooldownUntil,
            dormant: d.dormant,
          }
        : undefined;
    },
  };
}
