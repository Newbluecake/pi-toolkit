/**
 * scheduled-reports plan r3 §7 (H1, r2 after review round 1) — the hub's read-only schedule
 * coordinator.
 *
 * Round-2 architecture changes (each traced to a review finding, see H1-report's disposition
 * table):
 *   - ONE serial queue carries scans, observations and delivery (r1 #8) — no round ever
 *     interleaves with another's reads or commits.
 *   - The observation clock arms ABSOLUTE deadlines that a 60s scan may only pull EARLIER,
 *     and the startup round includes the 10-minute catch-up pass (r1 #1).
 *   - Pending notifications are PERSISTED accumulators (missed counts / unknown runKeys /
 *     droppedIndex increments) consumed only by a successful delivery; every state-changing
 *     round flushes (r1 #2/#3/#5). E1's hourly caps are enforced authoritatively by F1's
 *     pushNotice; H1 keeps a per-task hour gate so a busy loop never hammers a refusing bot,
 *     and refusals retain the pendings (r1 #6).
 *   - hub-state flush failures block delivery (marks are restored; nothing sends) (r1 #4).
 *   - Observations are never wall-clock expired; the service STOP-ADDS at the cap (r1 #7).
 *   - Ledger rebuild detection: seq-anchor total mismatch or history below the cursor resets
 *     and reconstructs the retained prefix; rebuilds/clamps are counted (r1 #9).
 *   - Timed-out scans rotate (resume cursor) and never delete unvisited sessions (r1 #10).
 *   - Unknown prediction re-reads the ledger fresh for dead-holder evidence, excludes `queued`
 *     (the writer recovers those as dropped), and keys off RUNS so deleted tasks still notify
 *     (r1 #11/#12, minor #15).
 *   - Delivery flows through F1's committed interface (FeishuSchedulePort ← coordinator,
 *     service.schedule → bindDelivery) — the round-1 duck binding is gone (verify major).
 */
import type { HubEvent, HubLog } from "../ports.js";
import {
  SCHED_HUB_CAP,
  SCHED_RUN_ACK_WAIT_MS,
  SCHED_RUN_TTL_MS,
  SCHED_SESSION_ID_RE,
  type HubScheduleConfig,
  type SchedAgentFrame,
  type SchedulesPayloadWire,
  type ScheduleReceiptState,
} from "../../protocol/schedule.js";
import type { HubFrame } from "../../protocol/messages.js";
import { compileTask } from "../../../schedule/core/occurrence.js";
import { occurrencesBetween } from "../../../schedule/core/cron.js";
import {
  isApproved,
  isTerminalRunState,
  defHash,
  isExecutable,
  SCHED_RECEIPTS_MAX,
  type PendingReport,
  type ScheduleStateFile,
} from "../../../schedule/core/spec.js";
import { judgeHolder, readSelfIdentity, type ProcessIdentity } from "../../../schedule/core/recovery.js";
import { resolveStoreRoot, sessionDirName, type StoreRoot } from "../../../schedule/core/paths.js";
import { readReportFile } from "../../../schedule/core/reader.js";
import { scanSessionOne, scanStore, type ScanResult } from "./scan.js";
import {
  createSchedHubStore,
  schedHubStatePath,
  taskStateOf,
  type SchedHubStore,
  type SchedHubTaskState,
} from "./hub-state.js";
import { gateAttempt, gateFresh, NOTICE_UNKNOWNS_PER_CARD, PENDING_UNKNOWNS_MAX, hourOf } from "./merge.js";
import { reconcileTask } from "./reconcile.js";
import { projectPayload, type BotStatus, type ReceiptView } from "./project.js";
import type {
  FeishuSchedulePort,
  ScheduleDelivery,
  ScheduleReportOffer,
  ScheduleRunRequest,
  ScheduleRunResult,
  SchedBoundTap,
} from "./feishu-port.js";

/** The observation point of occurrence T (§7.2): T + tolerance + 30s. */
export const SCHED_OBSERVE_DELAY_MS = 60_000 + 30_000;
/** Hub start catch-up window: only observation points from the last 10 minutes are re-checked. */
export const SCHED_OBSERVE_CATCHUP_MS = 10 * 60_000;
export const SCHED_FULL_SCAN_INTERVAL_MS = 60_000;
export const SCHED_OBSERVE_CANDIDATES_MAX = 16;

export interface RegistryLike {
  list(): readonly { agentKey: string; session?: { sessionId: string; name?: string }; cwd?: string }[];
  isConnected(agentKey: string): boolean;
  getCaps?(agentKey: string): readonly string[] | undefined;
  send(agentKey: string, frame: HubFrame): boolean;
  bus?: { subscribe(fn: (e: HubEvent) => void): () => void };
}

/** Injectable timer seam (tests drive the observation clock deterministically). */
export interface SchedTimerHandle {
  unref?(): void;
}
export interface SchedTimer {
  set(ms: number, fn: () => void): SchedTimerHandle;
  clear(h: SchedTimerHandle | undefined): void;
  interval(ms: number, fn: () => void): SchedTimerHandle;
}

const realTimer: SchedTimer = {
  set(ms, fn) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear(h) {
    if (h !== undefined) clearTimeout(h as ReturnType<typeof setTimeout>);
  },
  interval(ms, fn) {
    const t = setInterval(fn, ms);
    t.unref?.();
    return t;
  },
};

export interface ScheduleServiceDeps {
  config: HubScheduleConfig;
  stateDir: string;
  registry: RegistryLike;
  log: HubLog;
  now?: () => number;
  /** Test seam: pre-built hub state store. */
  store?: SchedHubStore;
  /** Test seam: fs for the internally-built store (fsync/rename fault injection, r2 #4). */
  storeFs?: import("./hub-state.js").SchedHubStoreFs;
  /** Test seams for the scanner. */
  scanAll?: typeof scanStore;
  scanOne?: typeof scanSessionOne;
  /** Test seam for the timers (default: real unref'd setTimeout/setInterval). */
  timer?: SchedTimer;
}

export interface ScheduleCounters {
  scans: number;
  publishes: number;
  noticesQueued: number;
  noticesRefused: number;
  reportsOffered: number;
  receiptsPushed: number;
  observations: number;
  frames: number;
  /** Ledger rebuilds detected (cursor reset + prefix replay). */
  rebuilds: number;
  /** Entry counts smaller than their matched observations (defensive clamp). */
  clamped: number;
  /** Review r2 #13: DISTINCT unknown runKeys dropped after pendingUnknown filled its cap
   *  (stop-adding ⇒ permanent miss once the agent's own history rotates — disclosed residual). */
  unknownDropped: number;
  /** Gauge (per last flush): sessions whose LIVE task records alone exceeded the trim cap. */
  capOverflow: number;
  /** hub-state commits that failed (delivery blocked for those notices). */
  persistFailures: number;
  scanTimeouts: number;
  scanTruncated: number;
}

export interface ScheduleStatus {
  /** Root-level failure — the projection is empty until a hub restart. */
  degraded?: string;
  /** Due (deliverable) reports seen in the last scan round. */
  pendingSeen: number;
  scan: { truncated: boolean; timedOut: boolean; rotated: boolean };
  counters: ScheduleCounters;
}

export interface ScheduleCoordinator {
  snapshot(sessionId?: string): SchedulesPayloadWire;
  setSseSink(sink: { publish(payload: SchedulesPayloadWire): void }): void;
  rescanAll(): Promise<void>;
  rescanSession(sessionId: string): Promise<void>;
  tickObserve(): Promise<void>;
  onAgentFrame(agentKey: string, frame: SchedAgentFrame): void;
  /** F1's delivery half (`service.schedule`), handed over by hub.ts right after bot.start(). */
  bindDelivery(delivery: ScheduleDelivery | undefined): void;
  /** §7.5 tap: hub.ts forwards sched_bound into the bot's FeishuServiceEvent stream. */
  setBoundTap(tap: SchedBoundTap | undefined): void;
  /** The port hub.ts injects into FeishuBotServiceDeps.schedule (F1's construction-time seam). */
  port(): FeishuSchedulePort;
  /** Receipt updates (any accepted/sent/failed/uncertain/refused) — fed by F1's receiptsChanged. */
  receipts(
    sessionId: string,
    updates: ReadonlyArray<{ reportId: string; state: ScheduleReceiptState; at: number }>,
  ): void;
  readReport(sessionId: string, reportFile: string): { ok: true; text: string } | { ok: false; reason: string };
  status(): ScheduleStatus;
  dispose(): Promise<void>;
}

export function createScheduleService(deps: ScheduleServiceDeps): ScheduleCoordinator {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log;
  const timer = deps.timer ?? realTimer;
  const scanAllFn = deps.scanAll ?? scanStore;
  const scanOneFn = deps.scanOne ?? scanSessionOne;
  const store =
    deps.store ??
    createSchedHubStore(schedHubStatePath(deps.stateDir), {
      now,
      ...(deps.storeFs === undefined ? {} : { fs: deps.storeFs }),
    });

  let disposed = false;
  let root: StoreRoot | undefined;
  let rootError: string | undefined;
  try {
    root = resolveStoreRoot(deps.config.dir);
  } catch (err) {
    rootError = err instanceof Error ? err.message : String(err);
    log.warn("web-hub schedule: store root unusable — projection stays empty", { error: rootError });
  }

  const self: ProcessIdentity | undefined = readSelfIdentity();
  const states = new Map<string, ScheduleStateFile>();
  const degradedSessions = new Map<string, string>();
  const receiptStates = new Map<string, ReceiptView>();
  const receiptsBySession = new Map<string, Set<string>>();
  const botStatus: BotStatus = { configured: false, open: true };
  let delivery: ScheduleDelivery | undefined;
  let boundTap: SchedBoundTap | undefined;

  let payload: SchedulesPayloadWire = { sessions: [] };
  let fingerprint = "";
  let sink: { publish(payload: SchedulesPayloadWire): void } | undefined;

  // ---- the ONE serial queue (r1 #8): scans, observations and delivery never interleave -----
  let queue: Promise<void> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // Rotation cursor for timed-out scans (r1 #10): next pass starts where the last stopped.
  let scanStart = 0;
  let scanTimedOut = false;
  let scanTruncated = false;

  let scanTimer: SchedTimerHandle | undefined;
  let observeTimer: SchedTimerHandle | undefined;
  /** Absolute deadline of the armed observation timer (a scan may only pull it EARLIER, r1 #1). */
  let observeDeadline: number | undefined;
  let unsubscribeBus: (() => void) | undefined;

  const counters: ScheduleCounters = {
    scans: 0,
    publishes: 0,
    noticesQueued: 0,
    noticesRefused: 0,
    reportsOffered: 0,
    receiptsPushed: 0,
    observations: 0,
    frames: 0,
    rebuilds: 0,
    clamped: 0,
    unknownDropped: 0,
    capOverflow: 0,
    persistFailures: 0,
    scanTimeouts: 0,
    scanTruncated: 0,
  };
  let pendingSeen = 0;

  const coordOf = (sid: string, taskId: string): SchedHubTaskState => taskStateOf(store.data, sid, taskId, now());

  // Review r2 #14: orphan-only eviction — the store asks which task ids are live (the agent's
  // ledger), so a live task's cursor/hour gate can never be trimmed away by orphan pressure.
  store.setLiveTasks((sid) => {
    const st = states.get(sid);
    return st === undefined ? new Set<string>() : new Set(st.tasks.map((t) => t.id));
  });

  // Review r2 #13: distinct runKeys already counted as dropped (bounded dedup for the counter).
  const unknownDroppedSeen = new Set<string>();

  // ---- projection --------------------------------------------------------------------------

  const rebuildPayload = (): void => {
    const next = projectPayload(
      [...states.values()].sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1)),
      {
        now: now(),
        receipts: receiptStates,
        bot: botStatus,
      },
    );
    for (const [sid, reason] of degradedSessions) {
      next.sessions.push({ sessionId: sid, rev: 0, degraded: reason, tasks: [], runs: [] });
    }
    payload = next;
    const fp = JSON.stringify(next);
    if (fp === fingerprint) return;
    fingerprint = fp;
    counters.publishes++;
    sink?.publish(next);
  };

  // ---- labels / online views (F1 offers + list rows) -----------------------------------------

  const onlineViews = (sid: string): string[] =>
    deps.registry
      .list()
      .filter((a) => a.session?.sessionId === sid && deps.registry.isConnected(a.agentKey))
      .map((a) => a.agentKey);

  const sessionLabel = (sid: string): string => {
    const view = deps.registry.list().find((a) => a.session?.sessionId === sid);
    return view?.session?.name ?? view?.cwd ?? sid;
  };

  const taskNameOf = (state: ScheduleStateFile, taskId: string): string =>
    state.tasks.find((t) => t.id === taskId)?.name ?? taskId;

  const whenText = (state: ScheduleStateFile, taskId: string): string => {
    const t = state.tasks.find((x) => x.id === taskId);
    if (t === undefined) return "deleted";
    const w = t.when;
    return w.kind === "cron" ? `cron ${w.expr} @ ${w.tz}` : `once ${w.at} @ ${w.tz}`;
  };

  // ---- one scan round ------------------------------------------------------------------------

  const applyScan = (result: ScanResult): void => {
    if (result.rootDegraded !== undefined) {
      rootError = result.rootDegraded;
      states.clear();
      degradedSessions.clear();
      log.warn("web-hub schedule: store root degraded", { error: result.rootDegraded });
      return;
    }
    rootError = undefined;
    // Partial (timed-out) rounds only ADD/REFRESH visited sessions — unvisited ones keep their
    // cached state instead of being deleted (r1 #10).
    const complete = !result.timedOut;
    const seen = new Set<string>();
    for (const s of result.sessions) {
      seen.add(s.sessionId);
      if (s.read.kind === "ok") {
        states.set(s.sessionId, s.read.state);
        degradedSessions.delete(s.sessionId);
      } else if (s.read.kind === "degraded") {
        states.delete(s.sessionId);
        degradedSessions.set(s.sessionId, `${s.read.reason}: ${s.read.detail}`);
      }
    }
    if (complete) {
      for (const sid of [...states.keys()]) if (!seen.has(sid)) states.delete(sid);
      for (const sid of [...degradedSessions.keys()]) if (!seen.has(sid)) degradedSessions.delete(sid);
    }
  };

  /**
   * Unknown prediction (r1 #11/#12, minor #15): terminal `unknown` runs pass through; a
   * NON-terminal run needs (a) state ≠ queued (the writer recovers a dead holder's queued
   * message as dropped(owner-closed), not unknown) and (b) a FRESH re-read proving the run is
   * still non-terminal with a dead holder — a stale snapshot must never be combined with later
   * death evidence.
   */
  const predictUnknowns = async (sid: string, state: ScheduleStateFile): Promise<string[]> => {
    if (self === undefined || root === undefined) return [];
    const out: string[] = [];
    for (const run of state.runs) {
      if (run.state === "unknown") {
        out.push(run.runKey);
        continue;
      }
      if (isTerminalRunState(run.state) || run.state === "queued") continue;
      if (judgeHolder(run.holder, self).liveness !== "dead") continue;
      const fresh = await scanOneFn(root, sid, { isCurrent: () => !disposed });
      if (fresh.kind !== "ok") continue;
      const again = fresh.state.runs.find((r) => r.runKey === run.runKey);
      if (again === undefined) continue;
      if (isTerminalRunState(again.state) || again.state === "queued") continue;
      if (judgeHolder(again.holder, self).liveness !== "dead") continue;
      out.push(run.runKey);
    }
    return out;
  };

  /** Reconcile + unknown + dropped accounting for every cached session (mutates store.data). */
  const absorbStates = async (): Promise<void> => {
    const t = now();
    for (const [sid, state] of states) {
      const session = store.data.sessions[sid] ?? { tasks: {}, droppedPending: 0, droppedShown: 0, lastSeenAt: t };
      store.data.sessions[sid] = session;
      session.lastSeenAt = t;

      const droppedDelta = state.reportStats.droppedIndexCap - session.droppedShown;
      if (droppedDelta > 0) {
        session.droppedPending += droppedDelta;
        session.droppedShown = state.reportStats.droppedIndexCap;
      } else if (state.reportStats.droppedIndexCap < session.droppedShown) {
        // The agent's ledger was rebuilt (droppedIndexCap reset down) — follow it down (r1 nit).
        session.droppedShown = state.reportStats.droppedIndexCap;
      }

      for (const task of state.tasks) {
        const ts = coordOf(sid, task.id);
        const r = reconcileTask(
          { consumedSeq: ts.consumedSeq, consumedTotal: ts.consumedTotal, observed: ts.observed },
          state.occ[task.id] ?? { missedTotal: 0, missedLog: [] },
          t,
        );
        ts.consumedSeq = r.cursor.consumedSeq;
        ts.consumedTotal = r.cursor.consumedTotal;
        ts.observed = r.cursor.observed;
        if (r.notify > 0) {
          ts.pendingMissed += r.notify;
          ts.lastAt = t;
        }
        if (r.changes.reset) {
          counters.rebuilds++;
          log.warn("web-hub schedule: ledger rebuild detected — cursor reset, prefix replayed", {
            session: sid.length > 0 ? "present" : "absent",
          });
        }
        if (r.changes.clamped) counters.clamped++;
      }

      // Unknown prediction keyed off RUNS — deleted tasks still notify (r1 #12).
      const unknowns = await predictUnknowns(sid, state);
      for (const runKey of unknowns) {
        const taskId = state.runs.find((r) => r.runKey === runKey)?.taskId ?? "";
        const ts = coordOf(sid, taskId);
        if (ts.notifiedUnknown.some((n) => n.runKey === runKey)) continue;
        if (ts.pendingUnknown.includes(runKey)) continue;
        if (ts.pendingUnknown.length >= PENDING_UNKNOWNS_MAX) {
          // Stop-adding (r1 #7): the evidence cap holds, so this run is DROPPED, not deferred —
          // counted per DISTINCT runKey and surfaced in status() (r2 #13, disclosed residual).
          if (!unknownDroppedSeen.has(runKey)) {
            unknownDroppedSeen.add(runKey);
            if (unknownDroppedSeen.size > 128) unknownDroppedSeen.delete(unknownDroppedSeen.values().next().value!);
            counters.unknownDropped++;
          }
          continue;
        }
        ts.pendingUnknown.push(runKey);
        ts.lastAt = t;
      }

      // Lifecycle cleanup of deleted-task records (r1 #14): only once they carry no duty and no
      // surviving run references them.
      const liveTasks = new Set(state.tasks.map((x) => x.id));
      const runTasks = new Set(state.runs.map((r) => r.taskId));
      for (const tid of [...Object.keys(session.tasks)]) {
        if (tid === "" || liveTasks.has(tid) || runTasks.has(tid)) continue;
        const ts = session.tasks[tid]!;
        if (ts.pendingMissed > 0 || ts.pendingUnknown.length > 0) continue;
        delete session.tasks[tid];
      }
    }
  };

  // ---- delivery (r1 #2/#5/#6: pendings persist; consumption only on success) ----------------

  const restoreTask = (sid: string, tid: string, snap: { ts: SchedHubTaskState; dropped: number }): void => {
    store.data.sessions[sid]!.tasks[tid] = snap.ts;
    store.data.sessions[sid]!.droppedPending = snap.dropped;
  };

  /**
   * One pushNotice attempt with PERSIST-BEFORE-SEND ordering (review r1 #4 + r2 #1): the
   * consumed pendings are committed to the hub state FIRST — any write/fsync/rename failure
   * makes `flush()` false, NOTHING is sent and the pendings are restored (the next round
   * retries). A REFUSAL after a proven commit also restores the pendings (nothing was sent)
   * with a best-effort re-commit; if that re-commit fails the carry was already persisted as
   * consumed — a one-time lost batch, disclosed (at-most-once bias; F1's stable outbox key
   * covers the crash-after-queue window anyway). Shared by the task AND taskless (r2 #1) paths.
   */
  const attemptNotice = async (
    sid: string,
    tid: string,
    build: () => Parameters<ScheduleDelivery["pushNotice"]>[0],
    consume: () => void,
  ): Promise<void> => {
    const session = store.data.sessions[sid];
    const ts = session?.tasks[tid];
    if (session === undefined || ts === undefined) return;
    const snap = { ts: { ...ts }, dropped: session.droppedPending };
    ts.gate = gateAttempt(ts.gate, now());
    consume();
    if (!(await store.flush())) {
      counters.persistFailures++;
      restoreTask(sid, tid, snap); // restores the UN-attempted gate: nothing was sent, an
      return; // in-hour retry after the disk heals is safe and desirable
    }
    const res = await delivery!.pushNotice(build());
    if (res.outcome === "queued") {
      counters.noticesQueued++;
      return;
    }
    counters.noticesRefused++;
    restoreTask(sid, tid, snap);
    // The hour stays SPENT on a refusal (never hammer a refusing bot).
    const live = store.data.sessions[sid]!.tasks[tid];
    if (live !== undefined) live.gate = gateAttempt(live.gate, now());
    if (!(await store.flush())) counters.persistFailures++;
  };

  /**
   * One delivery attempt for one (session, task). At most one per hour (gate); F1's pushNotice
   * is the authoritative E1/budget gate. `queued` ⇒ consume pendings, persist, done; refusals
   * keep the pendings (retry next hour).
   */
  const deliverTask = async (sid: string, tid: string, state: ScheduleStateFile): Promise<void> => {
    const session = store.data.sessions[sid];
    if (session === undefined) return;
    const ts = session.tasks[tid];
    if (ts === undefined) return;
    if (ts.pendingMissed <= 0 && ts.pendingUnknown.length <= 0 && session.droppedPending <= 0) return;
    if (!gateFresh(ts.gate, now())) return; // one attempt per task per hour (E1)
    const label = sessionLabel(sid);
    const name = taskNameOf(state, tid);
    const hour = hourOf(now());
    const droppedIndex = session.droppedPending;

    if (ts.pendingMissed > 0) {
      const count = ts.pendingMissed;
      const dropped = droppedIndex;
      await attemptNotice(
        sid,
        tid,
        () => ({
          key: `schm:${sid}\0${tid}\0${hour}\0missed`,
          sessionId: sid,
          sessionLabel: label,
          taskId: tid,
          taskName: name,
          kind: "missed",
          count,
          ...(dropped > 0 ? { droppedIndex: dropped } : {}),
        }),
        () => {
          ts.pendingMissed = 0;
          session.droppedPending = 0;
        },
      );
      return; // the hour's one attempt is spent (queued or refused)
    }

    // Missed exhausted: the oldest pending unknown rides this hour's card (one per hour).
    if (ts.pendingUnknown.length === 0) {
      // Nothing but a droppedIndex carry: a "skipped" card on its own (first task's gate).
      const dropped = session.droppedPending;
      if (dropped <= 0) return;
      await attemptNotice(
        sid,
        tid,
        () => ({
          key: `schm:${sid}\0${tid}\0${hour}\0dropped`,
          sessionId: sid,
          sessionLabel: label,
          taskId: tid,
          taskName: name,
          kind: "skipped",
          droppedIndex: dropped,
        }),
        () => {
          session.droppedPending = 0;
        },
      );
      return;
    }
    const runKey = ts.pendingUnknown[0]!;
    const at = state.runs.find((r) => r.runKey === runKey)?.scheduledAt;
    await attemptNotice(
      sid,
      tid,
      () => ({
        key: `schm:${sid}\0${runKey}\0unknown`,
        sessionId: sid,
        sessionLabel: label,
        taskId: tid,
        taskName: name,
        kind: "unknown",
        ...(at === undefined ? {} : { at }),
      }),
      () => {
        ts.pendingUnknown = ts.pendingUnknown.filter((k) => k !== runKey);
        ts.notifiedUnknown.push({ runKey, at: now() });
      },
    );
  };

  /** Delivery pass over every cached session (independent flush path for carried pendings). */
  const deliverRound = async (): Promise<void> => {
    if (delivery === undefined) return;
    for (const [sid, state] of states) {
      // Taskless sessions with a dropped carry ride the "" slot — SAME persist-before-send
      // attempt as every task path (review r2 #1: the old branch sent first, committed after).
      if (state.tasks.length === 0) {
        const session = store.data.sessions[sid];
        if (session !== undefined && session.droppedPending > 0) {
          const ts = coordOf(sid, "");
          if (gateFresh(ts.gate, now())) {
            const dropped = session.droppedPending;
            await attemptNotice(
              sid,
              "",
              () => ({
                key: `schm:${sid}\0\0${hourOf(now())}\0dropped`,
                sessionId: sid,
                sessionLabel: sessionLabel(sid),
                taskId: "",
                taskName: "",
                kind: "skipped",
                droppedIndex: dropped,
              }),
              () => {
                session.droppedPending = 0;
              },
            );
          }
        }
      }
      for (const task of state.tasks) await deliverTask(sid, task.id, state);
      // Deleted-task orphan slots still owed an unknown notice.
      const session = store.data.sessions[sid];
      if (session !== undefined) {
        for (const tid of Object.keys(session.tasks)) {
          if (state.tasks.some((t) => t.id === tid) || tid === "") continue;
          const ts = session.tasks[tid]!;
          if (ts.pendingUnknown.length === 0 && ts.pendingMissed <= 0) continue;
          await deliverTask(sid, tid, state);
        }
      }
    }
  };

  // ---- report discovery (§7.1 → F1) -----------------------------------------------------------

  const discoverReports = async (): Promise<number> => {
    let due = 0;
    if (delivery === undefined) {
      for (const state of states.values())
        due += state.pendingReports.filter((p) => now() < p.expiresAt && !receiptStates.has(p.reportId)).length;
      return due;
    }
    for (const [sid, state] of states) {
      for (const p of state.pendingReports) {
        if (now() >= p.expiresAt || receiptStates.has(p.reportId)) continue;
        due++;
        const offer: ScheduleReportOffer = {
          sessionId: sid,
          sessionLabel: sessionLabel(sid),
          reportId: p.reportId,
          runKey: p.runKey,
          taskId: p.taskId,
          taskName: taskNameOf(state, p.taskId),
          status: p.status,
          endedAt: p.endedAt,
          expiresAt: p.expiresAt,
          read: () => {
            const r = coordinator.readReport(sid, p.reportFile);
            return r.ok ? r.text : undefined;
          },
        };
        counters.reportsOffered++;
        botStatus.configured = true;
        try {
          await delivery.pushReport(offer);
        } catch (err) {
          log.error("web-hub schedule: pushReport threw", { error: String(err) });
        }
      }
    }
    return due;
  };

  // ---- observation (§7.2, r1 #1/#7/#8) ----------------------------------------------------------

  const sessionOnline = (sid: string): boolean => onlineViews(sid).length > 0;

  const observePass = async (): Promise<void> => {
    if (root === undefined || disposed) return;
    const t = now();
    const onlineCache = new Map<string, boolean>();
    for (const [sid, state] of states) {
      for (const task of state.tasks) {
        if (!isExecutable(task)) continue;
        const c = compileTask(task);
        if (c === undefined) continue;
        const ts = store.data.sessions[sid]?.tasks[task.id];
        if (ts === undefined) continue;
        const hash = defHash(task);
        const points = occurrencesBetween(
          c,
          t - SCHED_OBSERVE_CATCHUP_MS - SCHED_OBSERVE_DELAY_MS,
          t - SCHED_OBSERVE_DELAY_MS,
          SCHED_OBSERVE_CANDIDATES_MAX,
        );
        for (const point of points) {
          if (ts.observed.some((o) => o.t === point && o.defHash === hash)) continue;
          const read = await scanOneFn(root, sid, { isCurrent: () => !disposed });
          if (disposed || read.kind !== "ok") break;
          const occ = read.state.occ[task.id];
          if (occ === undefined || occ.decidedThrough >= point) continue;
          let isOnline = onlineCache.get(sid);
          if (isOnline === undefined) {
            isOnline = sessionOnline(sid);
            onlineCache.set(sid, isOnline);
          }
          if (isOnline) break;
          if (ts.observed.length >= 64) continue; // stop-adding (r1 #7): never evict evidence
          ts.observed.push({ t: point, defHash: hash, at: t });
          counters.observations++;
          ts.pendingMissed += 1;
        }
      }
    }
  };

  /**
   * Arm the observation clock by ABSOLUTE deadline (r1 #1): an armed timer is only ever replaced
   * by an EARLIER deadline — a 60s scan can no longer postpone a ≥90s timer indefinitely — and
   * the very first deadline sits at the earliest pending observation point.
   */
  const armObserve = (): void => {
    if (disposed) return;
    const t = now();
    let earliest: number | undefined;
    for (const state of states.values()) {
      for (const task of state.tasks) {
        if (!isExecutable(task)) continue;
        const c = compileTask(task);
        if (c === undefined) continue;
        const next = occurrencesBetween(c, t, t + SCHED_FULL_SCAN_INTERVAL_MS + SCHED_OBSERVE_DELAY_MS, 1)[0];
        if (next === undefined) continue;
        const at = next + SCHED_OBSERVE_DELAY_MS;
        if (earliest === undefined || at < earliest) earliest = at;
      }
    }
    // An armed FUTURE deadline is never dropped just because the next occurrence now looks far
    // away (r1 #1's exact failure: the 60s scan at T sees "next = T+1h" and used to clear the
    // pending T+90s deadline). The armed timer fires, its pass finds whatever is due, and the
    // re-arm below decides the next deadline from scratch.
    if (earliest === undefined) return;
    if (observeTimer !== undefined && observeDeadline !== undefined && observeDeadline <= earliest) return;
    timer.clear(observeTimer);
    observeDeadline = earliest;
    observeTimer = timer.set(Math.max(0, earliest - t), () => {
      observeTimer = undefined;
      observeDeadline = undefined;
      void enqueueRound("observe");
    });
  };

  // ---- round orchestration ----------------------------------------------------------------------

  let scanGen = 0;
  type RoundKind = "full" | "targeted" | "observe" | "deliver";
  const enqueueRound = (kind: RoundKind, sids: string[] = []): Promise<void> =>
    enqueue(async () => {
      if (disposed) return;
      await ready;
      let dirty = false;
      if (kind === "full" || kind === "targeted") {
        if (root === undefined) {
          rebuildPayload();
          return;
        }
        if (kind === "full") {
          const mine = ++scanGen;
          const result = await scanAllFn(root, {
            isCurrent: () => !disposed && mine === scanGen,
            startAt: scanStart,
          });
          if (disposed || mine !== scanGen || result.fenced) return;
          counters.scans++;
          scanTimedOut = result.timedOut;
          scanTruncated = result.truncated;
          if (result.timedOut) {
            counters.scanTimeouts++;
            scanStart = result.nextStart ?? 0;
          } else {
            scanStart = 0;
          }
          if (result.truncated) counters.scanTruncated++;
          applyScan(result);
        } else {
          for (const sid of sids) {
            if (!SCHED_SESSION_ID_RE.test(sid)) continue;
            const read = await scanOneFn(root, sid, { isCurrent: () => !disposed });
            if (disposed) return;
            counters.scans++;
            if (read.kind === "ok") {
              states.set(sid, read.state);
              degradedSessions.delete(sid);
            } else if (read.kind === "degraded") {
              states.delete(sid);
              degradedSessions.set(sid, `${read.reason}: ${read.detail}`);
            }
          }
        }
        await absorbStates();
        dirty = true;
      } else if (kind === "observe") {
        await observePass();
        dirty = true;
      }
      pendingSeen = await discoverReports();
      await deliverRound();
      rebuildPayload();
      if (dirty || delivery !== undefined) {
        await store.flush();
        counters.capOverflow = store.overflowSessions;
      }
      if (kind === "full" || kind === "observe") armObserve();
    });

  const kickScan = (): void => {
    void enqueueRound("full");
  };
  const rescanAll = (): Promise<void> => enqueueRound("full");
  const rescanSession = (sid: string): Promise<void> => enqueueRound("targeted", [sid]);

  // ---- receipts → sched_receipts (§7.1) -----------------------------------------------------------

  const pushReceipts = (sid: string, ids: string[]): void => {
    const live = onlineViews(sid);
    if (live.length === 0) return;
    for (let i = 0; i < ids.length; i += 64) {
      const chunk = ids.slice(i, i + 64);
      for (const agentKey of live) {
        if (deps.registry.send(agentKey, { t: "sched_receipts", sessionId: sid, reportIds: chunk })) {
          counters.receiptsPushed++;
        }
      }
    }
  };

  // ---- sched_run waiters (§7.4) --------------------------------------------------------------------

  const runWaiters = new Map<string, (r: ScheduleRunResult) => void>();
  const runTimers = new Map<string, SchedTimerHandle>();

  const settleRun = (reqId: string, result: ScheduleRunResult): void => {
    const resolve = runWaiters.get(reqId);
    if (resolve === undefined) return;
    runWaiters.delete(reqId);
    const h = runTimers.get(reqId);
    if (h !== undefined) {
      timer.clear(h);
      runTimers.delete(reqId);
    }
    resolve(result);
  };

  // ---- port (F1's construction-time seam) ------------------------------------------------------------

  const port: FeishuSchedulePort = {
    list(): ReturnType<FeishuSchedulePort["list"]> {
      const rows: import("../feishu/schedule.js").FeishuScheduleRow[] = [];
      for (const [sid, state] of states) {
        const online = onlineViews(sid).length === 1;
        for (const task of state.tasks) {
          let nextAt: number | undefined;
          const c = compileTask(task);
          if (task.enabled && c !== undefined) nextAt = occurrencesBetween(c, now(), now() + 400 * 86_400_000, 1)[0];
          const lastRun = [...state.runs]
            .filter((r) => r.taskId === task.id)
            .sort((a, b) => b.startedAt - a.startedAt)[0];
          rows.push({
            sessionId: sid,
            sessionLabel: sessionLabel(sid),
            online,
            taskId: task.id,
            name: task.name,
            form: task.form,
            when: whenText(state, task.id),
            enabled: task.enabled,
            approved: isApproved(task),
            defHash: defHash(task),
            ...(nextAt === undefined ? {} : { nextAt }),
            ...(lastRun === undefined ? {} : { lastStatus: lastRun.state }),
          });
        }
      }
      return rows;
    },
    async run(req: ScheduleRunRequest): Promise<ScheduleRunResult> {
      const views = onlineViews(req.sessionId);
      if (views.length === 0) return { kind: "offline" };
      if (views.length > 1) return { kind: "multi" };
      const caps = deps.registry.getCaps?.(views[0]!);
      if (caps === undefined || !caps.includes(SCHED_HUB_CAP)) return { kind: "refused", reason: "no-cap" };
      const sent = deps.registry.send(views[0]!, {
        t: "sched_run",
        reqId: req.reqId,
        sessionId: req.sessionId,
        taskId: req.taskId,
        defHash: req.defHash,
        expiresAt: now() + SCHED_RUN_TTL_MS,
      });
      if (!sent) return { kind: "offline" };
      return new Promise<ScheduleRunResult>((resolve) => {
        runWaiters.set(req.reqId, resolve);
        runTimers.set(
          req.reqId,
          timer.set(SCHED_RUN_ACK_WAIT_MS, () => settleRun(req.reqId, { kind: "timeout" })),
        );
      });
    },
    receiptsChanged(
      sessionId: string,
      receipts: readonly { reportId: string; state: ScheduleReceiptState; code?: string }[],
    ): void {
      coordinator.receipts(
        sessionId,
        receipts.map((r) => ({ reportId: r.reportId, state: r.state, at: now() })),
      );
    },
  };

  // ---- lifecycle ---------------------------------------------------------------------------------

  const ready: Promise<void> = store.load().then(() => {
    if (store.degraded) {
      log.warn("web-hub schedule: coordination state unreadable — starting fresh", {});
    }
  });

  const coordinator: ScheduleCoordinator = {
    snapshot(sessionId?: string): SchedulesPayloadWire {
      if (sessionId === undefined) return payload;
      if (!SCHED_SESSION_ID_RE.test(sessionId)) return { sessions: [] };
      return { sessions: payload.sessions.filter((s) => s.sessionId === sessionId) };
    },
    setSseSink(s): void {
      sink = s;
    },
    rescanAll,
    rescanSession,
    async tickObserve(): Promise<void> {
      await enqueueRound("observe");
    },
    onAgentFrame(agentKey: string, frame: SchedAgentFrame): void {
      counters.frames++;
      if (frame.t === "sched_changed") {
        void rescanSession(frame.sessionId);
        return;
      }
      if (frame.t === "sched_bound") {
        try {
          boundTap?.(agentKey, frame.runKey);
        } catch (err) {
          log.error("web-hub schedule: sched_bound tap threw", { error: String(err) });
        }
        return;
      }
      // sched_run_ack resolves the port's run() waiter (§7.4).
      if (frame.result === "started") settleRun(frame.reqId, { kind: "started" });
      else settleRun(frame.reqId, { kind: "refused", reason: frame.reason ?? "refused" });
    },
    bindDelivery(d: ScheduleDelivery | undefined): void {
      delivery = d;
      botStatus.configured = d !== undefined;
      // Refill the receipt view from F1's durable table (hub restart window).
      if (d !== undefined) {
        for (const sid of states.keys()) {
          try {
            for (const r of d.receiptsFor(sid)) {
              receiptStates.set(r.reportId, {
                state: r.state,
                at: now(),
                ...(r.code === undefined ? {} : { code: r.code }),
              });
              let set = receiptsBySession.get(sid);
              if (set === undefined) {
                set = new Set();
                receiptsBySession.set(sid, set);
              }
              set.add(r.reportId);
            }
          } catch {
            /* best-effort refill */
          }
        }
      }
      void rescanAll();
    },
    setBoundTap(tap: SchedBoundTap | undefined): void {
      boundTap = tap;
    },
    port(): FeishuSchedulePort {
      return port;
    },
    receipts(sessionId, updates): void {
      if (!SCHED_SESSION_ID_RE.test(sessionId)) return;
      const ids: string[] = [];
      for (const u of updates) {
        receiptStates.set(u.reportId, { state: u.state, at: u.at });
        if (receiptStates.size > SCHED_RECEIPTS_MAX) {
          const oldest = receiptStates.keys().next().value;
          if (oldest !== undefined) receiptStates.delete(oldest);
        }
        let set = receiptsBySession.get(sessionId);
        if (set === undefined) {
          set = new Set();
          receiptsBySession.set(sessionId, set);
        }
        if (!set.has(u.reportId)) set.add(u.reportId);
        ids.push(u.reportId);
      }
      if (ids.length > 0) {
        pushReceipts(sessionId, ids);
        void rescanSession(sessionId);
      }
    },
    readReport(sessionId, reportFile): { ok: true; text: string } | { ok: false; reason: string } {
      if (root === undefined) return { ok: false, reason: "store-degraded" };
      const r = readReportFile(root, sessionDirName(sessionId), reportFile);
      return r.kind === "ok" ? { ok: true, text: r.text } : { ok: false, reason: r.reason };
    },
    status(): ScheduleStatus {
      return {
        ...(rootError === undefined ? {} : { degraded: rootError }),
        pendingSeen,
        scan: { truncated: scanTruncated, timedOut: scanTimedOut, rotated: scanStart !== 0 },
        counters,
      };
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      scanGen++;
      timer.clear(scanTimer);
      timer.clear(observeTimer);
      scanTimer = undefined;
      observeTimer = undefined;
      observeDeadline = undefined;
      for (const [reqId, h] of [...runTimers]) {
        timer.clear(h);
        settleRun(reqId, { kind: "unavailable" });
      }
      unsubscribeBus?.();
      unsubscribeBus = undefined;
      await store.flush();
      await store.close();
    },
  };

  // bus: a session attaching (hello/session frame) ⇒ targeted rescan + receipt re-push (§7.1 补推)
  if (deps.registry.bus !== undefined) {
    const bus = deps.registry.bus;
    unsubscribeBus = bus.subscribe((e: HubEvent) => {
      if (disposed) return;
      const sid =
        e.type === "session" ? e.session?.sessionId : e.type === "agent_up" ? e.agent.session?.sessionId : undefined;
      if (sid === undefined) return;
      const ids = [...(receiptsBySession.get(sid) ?? [])];
      if (ids.length > 0) pushReceipts(sid, ids);
      void rescanSession(sid);
    });
  }

  scanTimer = timer.interval(SCHED_FULL_SCAN_INTERVAL_MS, kickScan);
  // Startup: initial scan, then the 10-minute observation catch-up (r1 #1).
  void rescanAll().then(() => coordinator.tickObserve());

  return coordinator;
}
