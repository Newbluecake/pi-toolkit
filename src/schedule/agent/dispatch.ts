/**
 * Scheduled tasks — message scheduler (plan r3 §6.2, §12 A2). Timed `message` runs and `handoff`
 * (a background result the main session should pick up) share ONE in-flight dispatcher.
 *
 * Pi-free by construction: everything pi-shaped (sending, abort, idle probes, the ledger sink, the
 * notices) arrives through `MessageSchedulerDeps`; `message.ts` is the only pi-facing assembly.
 *
 * Why not `RootWakeController`: it is bound to `subagent:xs`'s message type, ledger, policy and quotas
 * and frozen by the C-X conformance suite. This module implements the equivalent mechanisms for the
 * `subagent:schedule` message type — occupy BEFORE sending, fence + generation in the same synchronous
 * block as the send, authorization from the real trigger, a re-check before every model call,
 * start-timeout abort, a hard run limit, human hand-over and orphan abort — and stays mutually
 * exclusive with xs wake (`rootWakeBusy` / `xsWakeOwned`). Nothing here changes fabric behaviour.
 *
 * State machine (every transition is mirrored to the run's ledger record, except `authorized`,
 * which is in-memory only, and handoffs, which have no ledger run of their own):
 *
 *   queued ──(ready; CAS queued→dispatched; same sync block: beginDispatch + send + verifyDispatch)──▶ dispatched
 *   dispatched ──before_agent_start(token valid)──▶ authorized        (orphans abort synchronously)
 *   dispatched ──message_start in somebody else's run──▶ bound(merged)
 *   dispatched ──sentAt+60s──▶ unknown(start-timeout), token void
 *   authorized ──message_start──▶ bound
 *   authorized|bound ──sentAt+60s without a first `context`──▶ void + ctx.abort() ⇒ aborting
 *   authorized|bound ──authorizedAt+3600s──▶ void + ctx.abort() ⇒ aborting(run-max)
 *   authorized|bound ──human input──▶ continued (limit cancelled, nothing reported)
 *   bound ──agent_settled──▶ settled        aborting ──agent_settled──▶ dropped|unknown(start-timeout) | settled(run-max)
 *
 * Supervision survives /reload (review r1 #1): a process-level run registry (`Symbol.for`, like the
 * occupancy slot and xs's token ledger) records the authorized scheduled run — token, epoch, absolute
 * deadline, void/hand-over flags. `shutdown()` aborts a still-supervised run AND voids its record, and
 * every `context` check (this scheduler's, a later stack's, or the standalone guard in message.ts)
 * consults the registry, so a run that outlived its supervisor is blocked before its next model call.
 * A scheduled wake nobody can prove (orphan) is recorded as a void run: its model calls are refused too.
 * Deadlines are absolute: `before_agent_start` and every `context` compare `now` with sentAt+60s /
 * authorizedAt+3600s before trusting a timer that a long synchronous handler may have delayed.
 *
 * Known boundary (review r1 #2, disclosed in A2-report): pi runs its pre-start compaction BEFORE
 * `before_agent_start`, so the first provider request a wake can cause (a compaction) precedes our
 * authorization point — exactly like xs's B1. What we guarantee is the first MAIN-conversation request
 * and a start budget measured from the send: past 60s without a first model call the run is aborted.
 *
 * All timers go through the injected `Clock` (the system clock's timers are unref'd — a ref'd timer
 * wedges `pi -p`); no module-level state except the process-wide occupancy slot on a `Symbol.for` key.
 */
import { readBeforeAgentStartTrigger } from "../../adapters/pi-compat.js";
import type { Clock, TimerHandle } from "../../core/clock.js";
import { randomBytes } from "node:crypto";
import { classifyHumanInput, type WakeInputEvent } from "../../fabric/wake-input.js";
import { getXsHostCapability, type XsHostCapability } from "../../fabric/xs/host-cap.js";
import { createSessionFence, type FenceEvent, type FencePorts, type SessionFence } from "../../fabric/xs/fence.js";
import {
  canonicalJson,
  defHash,
  isApproved,
  isTerminalRunState,
  parseRunKey,
  SCHED_CAPABILITY_UNKNOWN_MAX_MS,
  SCHED_CUSTOM_TYPE,
  SCHED_DISPATCH_SYMBOL_KEY,
  SCHED_QUIET_MS,
  SCHED_RUN_MAX_MS,
  SCHED_START_TIMEOUT_MS,
  type Holder,
  type RunRecord,
  type ScheduleStateFile,
  type ScheduleTask,
} from "../core/spec.js";
import { sameHolder } from "../core/recovery.js";
import type { FenceStatus } from "../../fabric/xs/fence.js";
import { findRun, finishRun, updateRun, type SessionStore } from "../core/writer.js";
import type { ScheduleRefusal } from "./mode.js";

/** Idle re-evaluation cadence while something is queued (unref'd; nothing is armed when the queue is empty). */
export const SCHED_MSG_POLL_MS = 2_000;
/**
 * I1 (C-S5): hard cap, measured from the send, on how far OUR OWN pre-start compaction may push the 60 s start budget
 * (`SCHED_START_TIMEOUT_MS`). While the compaction this very send triggered is running the budget is paused (it rolls
 * forward); it resumes `SCHED_START_TIMEOUT_MS` after the compaction ends — never beyond `sentAt + this`.
 */
export const SCHED_START_COMPACTION_MAX_MS = 600_000;
/** After `ctx.abort()` the run gets this long to settle before it is force-finished (no wedged slot). */
export const SCHED_MSG_ABORT_GRACE_MS = 15_000;
/** Ledger write retries (terminal writes must land: a live holder's run is never recovered). */
export const SCHED_MSG_COMMIT_RETRIES = 5;
/** Idle observations (poll cadence) that release a stuck aborted run's capacity. */
export const SCHED_MSG_STUCK_IDLE_OBS = 2;
/** Bound on unmatched-end credits (an end that overtook its start). */
/**
 * I1 review r1 #1: how long after the send an observed `session_before_compact` is still attributed to it. Real pi awaits
 * EVERY handler of an event in turn, so with any handler ahead of ours (xs's, in production) our handler runs a few
 * microtasks after `sendCustomMessage` returned — the synchronous-stack attribution alone is not reliable. The
 * attribution is bound to the pending flight (`dispatched`, no run of a human's started, first compaction only).
 */
export const SCHED_SELF_COMPACTION_ATTRIB_MS = 5_000;
/**
 * I1 review r2 #4: after the LAST ui dialog end, dispatch waits this long before it may go. Dialog identity is only
 * (kind,title), so start(B) → end(A) → late start(A) cannot be told apart by counting: end(A) consumes B's open and the
 * count touches zero while B is still on screen. A late start that lands inside this bounded buffer re-blocks; one that
 * is later than the buffer is the documented residual (exits: `/schedule repair`, `/fabric fence reset`).
 */
export const UI_END_SETTLE_MS = 2_000;
/** sendMessage throwing this often in a row drops the run (pi cannot deliver). */
export const SCHED_MSG_SEND_FAILURES_MAX = 5;

// ----------------------------------------------------------------- ports

export interface SchedWakeMessage {
  customType: typeof SCHED_CUSTOM_TYPE;
  content: string;
  display: true;
  details: { kind: "message" | "handoff"; runKey: string; token: string; noteId: string };
}

export interface MessageSchedulerHost {
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  sendMessage(message: SchedWakeMessage, options: { triggerTurn: true }): void;
  abort(): void;
}

export type SettledReason = "merged" | "run-max" | "aborted";

/** Where a settled message run is recorded (terminal write + report + pendingReports, same commit). */
export interface SchedResultSink {
  /** Resolve `true` once the ledger holds the terminal state (false ⇒ retried). */
  settled(info: { run: RunRecord; task: ScheduleTask; text: string; reason?: SettledReason }): Promise<boolean>;
}

export interface HandoffInput {
  /** The background run this handoff reports on (no ledger run of its own). */
  runKey: string;
  taskId: string;
  /** The task as the background run saw it (display / gate only — the dispatch-time snapshot is re-read). */
  task: ScheduleTask;
  /** `defHash` the source background run was authorized under; the send is refused if the task changed. */
  defHash: string;
  /** Same noteId as the result note it replaces (§6.3). */
  noteId: string;
  content: string;
  /** Claim time (`startedAt`) of the source background run: a pause/delete AFTER it revokes the handoff. */
  startedAt?: number;
  onEnd(outcome: HandoffOutcome): void;
}

/** `dropped`/`unknown` ⇒ the caller falls back to a quiet result message (nothing is lost). */
export type HandoffOutcome =
  | { kind: "settled"; text: string; merged: boolean; runMax: boolean }
  | { kind: "continued" }
  | { kind: "dropped"; reason: string }
  | { kind: "unknown"; reason: string };

export interface SchedNoticeInfo {
  run: RunRecord;
  task: ScheduleTask;
  reason: "capability" | "capability-unknown";
}

export interface OccupancySlot {
  tryClaim(owner: string, runKey: string): boolean;
  release(owner: string, runKey: string): void;
}

export interface MessageSchedulerDeps {
  sessionId: string;
  holder: Holder;
  store(): SessionStore | undefined;
  /** `ScheduleAgent.gate(task)` — owner / mode / lock / executor checks, re-run at the send point. */
  gate(task: ScheduleTask): ScheduleRefusal | undefined;
  isDisposed(): boolean;
  /** A ledger write happened. */
  changed(): void;
  host: MessageSchedulerHost;
  results: SchedResultSink;
  contentFor(run: RunRecord, task: ScheduleTask): string;
  /** Quiet note into the session for a capability drop (never called for owner-closed). */
  notice(info: SchedNoticeInfo): void;
  /** One-time user-facing notice (absent capability). */
  notify?(message: string): void;
  clock: Clock;
  capability?: XsHostCapability;
  fencePorts?: FencePorts;
  rootWakeBusy?(): boolean;
  xsWakeOwned?(): boolean;
  attributeInput?(): ((text: string) => "web_prompt" | undefined) | undefined;
  occupancy?: OccupancySlot;
  /** Process-level record of the authorized scheduled run (default: `Symbol.for` registry). */
  registry?: ScheduledRunRegistry;
  /** Epochs known disposed in this process (`wire.ts`'s table); default: none. */
  epochDisposed?(epoch: string): boolean;
  /** §7.5: the message reached `bound` (message_start) in a run WE started — send `sched_bound`. */
  onBound?(runKey: string): void;
  newId?(): string;
  warn?(message: string): void;
}

export interface MessageScheduler {
  /** The `message` executor entry: a freshly claimed `queued` run. */
  enqueue(run: RunRecord, task: ScheduleTask): void;
  /** The handoff entry for A1's note path. `false` ⇒ not accepted (stopped) — fall back to a quiet note. */
  enqueueHandoff(input: HandoffInput): boolean;
  /**
   * I1 (A2 residual 3): a pause / delete of `taskId` revokes its QUEUED message and handoff entries
   * (never an already dispatched / in-flight run). Message entries end as `dropped(task-changed)`, handoff
   * entries call `onEnd({dropped,"task-changed"})` (their owner falls back to a quiet recap). Returns the
   * number of entries revoked. In-memory only: another process's queue is out of reach (disclosed residual).
   */
  revokeTask(taskId: string): number;
  onBeforeAgentStart(event: unknown): "other" | "authorized" | "aborted";
  onContext(): void;
  onMessageStart(message: unknown): void;
  onMessageEnd(message: unknown): void;
  onAgentStart(): void;
  onAgentSettled(event?: { aborted?: boolean }): void;
  onInput(event: WakeInputEvent): void;
  onUiPrompt(open: boolean, info?: { kind?: string; title?: string }): void;
  onFenceEvent(event: FenceEvent): void;
  /** Stack teardown: void tokens, clear timers, free the slot, hand back queued handoffs. No ledger writes (closeEpoch owns them). */
  shutdown(): void;
  status(): { capability: string; queued: number; inflight: string | undefined };
  /** Why nothing is being dispatched right now (fence windows, ui prompts, stuck run) — for `/schedule status`. */
  diagnostics(): SchedDiagnostics;
  /**
   * LOCAL human escape: clears this scheduler's fence windows and the ui-prompt balance (M1: nothing
   * else ever opens them without completion evidence). Integration wires `/fabric fence reset` to it.
   */
  resetBlockers(): void;
  /** `""` | `" · msg off"` | `" · msg ?"` for the status line (A3 composes it). */
  statusSuffix(): string;
  /** Resolves when no ledger work is pending (tests, orderly teardown). */
  idle(): Promise<void>;
  readonly fence: SessionFence;
}

// ----------------------------------------------------------------- trigger shape

export type ScheduleTrigger =
  { kind: "none" } | { kind: "quiet" } | { kind: "wake"; wake: "message" | "handoff" | "unknown"; token?: string };

const QUIET_KINDS: ReadonlySet<unknown> = new Set(["result", "digest", "handoff-recap"]);

/**
 * What a `before_agent_start` event says about OUR message type. `quiet` kinds never start a run;
 * anything else carrying our customType is a wake that must prove its token (orphans abort).
 */
export function readScheduleTrigger(event: unknown): ScheduleTrigger {
  const trigger = readBeforeAgentStartTrigger(event);
  if (trigger.kind !== "custom" || trigger.customType !== SCHED_CUSTOM_TYPE) return { kind: "none" };
  const details =
    trigger.details !== null && typeof trigger.details === "object"
      ? (trigger.details as { kind?: unknown; token?: unknown })
      : undefined;
  if (QUIET_KINDS.has(details?.kind)) return { kind: "quiet" };
  const wake = details?.kind === "message" || details?.kind === "handoff" ? details.kind : "unknown";
  return typeof details?.token === "string" && details.token !== ""
    ? { kind: "wake", wake, token: details.token }
    : { kind: "wake", wake };
}

export interface SchedDiagnostics {
  capability: string;
  queued: number;
  inflight: string | undefined;
  stuck: boolean;
  fence: FenceStatus;
  /** Open ui prompts as counted by start/end events (> 0 blocks dispatch). */
  uiPrompts: number;
  uiBlockedSince: number | undefined;
}

// ----------------------------------------------------------------- run registry (survives /reload)

export interface ScheduledRunRecord {
  token: string;
  epoch: string;
  /** authorizedAt + SCHED_RUN_MAX_MS; ignored once handed to a human. */
  deadlineAt: number;
  voided: boolean;
  handed: boolean;
}

export interface ScheduledRunRegistry {
  get(): ScheduledRunRecord | undefined;
  set(record: ScheduledRunRecord): void;
  clear(): void;
}

export const SCHED_RUN_REGISTRY_KEY = "pi-subagent:sched-run";

/** One slot on `Symbol.for`: the run currently executing for a scheduled wake (authorized or orphan). */
export function createProcessRunRegistry(key: string = SCHED_RUN_REGISTRY_KEY): ScheduledRunRegistry {
  const sym = Symbol.for(key);
  const cell = (): { current?: ScheduledRunRecord } => {
    const g = globalThis as Record<symbol, unknown>;
    let c = g[sym] as { current?: ScheduledRunRecord } | undefined;
    if (c === undefined || typeof c !== "object") {
      c = {};
      g[sym] = c;
    }
    return c;
  };
  return {
    get: () => cell().current,
    set: (record) => {
      cell().current = record;
    },
    clear: () => {
      delete cell().current;
    },
  };
}

/** A wake nobody could prove: every model call of its run is refused. */
export function markOrphanRun(registry: ScheduledRunRegistry, token?: string): void {
  registry.set({ token: token ?? "", epoch: "", deadlineAt: 0, voided: true, handed: false });
}

/**
 * The per-model-call verdict for the run currently executing: `none` = not a scheduled run;
 * `abort` = voided, its epoch is gone, or the absolute 3600s limit passed without a human taking over.
 */
export function judgeScheduledContext(
  registry: ScheduledRunRegistry,
  now: number,
  epochDisposed: (epoch: string) => boolean = () => false,
): "none" | "ok" | "abort" {
  const r = registry.get();
  if (r === undefined) return "none";
  // A run a human took over is the human's: it is never refused (not by a dead supervisor epoch, not by
  // the deadline) — only an explicit void, which hand-over never sets, could.
  if (r.handed) return r.voided ? "abort" : "ok";
  if (r.voided) return "abort";
  if (r.epoch !== "" && epochDisposed(r.epoch)) return "abort";
  if (now >= r.deadlineAt) return "abort";
  return "ok";
}

// ----------------------------------------------------------------- process occupancy (§6.2)

interface OccupancyCell {
  owner?: string;
  runKey?: string;
}

/**
 * ONE in-flight scheduled dispatch per process on `Symbol.for("pi-subagent:sched-dispatch")` (the
 * process-global survives /reload's fresh module instance — worktree-origin precedent). An occupant
 * whose epoch is known disposed never blocks: its stack is gone (and a late trigger of its token is
 * an orphan the new stack aborts).
 */
export function createProcessOccupancy(
  epochDisposed: (epoch: string) => boolean = () => false,
  key: string = SCHED_DISPATCH_SYMBOL_KEY,
): OccupancySlot {
  const sym = Symbol.for(key);
  const cell = (): OccupancyCell => {
    const g = globalThis as Record<symbol, unknown>;
    let c = g[sym] as OccupancyCell | undefined;
    if (c === undefined || typeof c !== "object") {
      c = {};
      g[sym] = c;
    }
    return c;
  };
  return {
    tryClaim(owner, runKey) {
      const c = cell();
      if (c.owner === undefined || c.owner === owner || epochDisposed(c.owner)) {
        c.owner = owner;
        c.runKey = runKey;
        return true;
      }
      return false;
    },
    release(owner, runKey) {
      const c = cell();
      if (c.owner === owner && c.runKey === runKey) {
        delete c.owner;
        delete c.runKey;
      }
    },
  };
}

// ----------------------------------------------------------------- internals

type Phase = "dispatched" | "authorized" | "bound" | "aborting";
type AbortCause = "start-timeout" | "run-max" | "fenced";

interface QEntry {
  kind: "message" | "handoff";
  key: string;
  runKey: string;
  taskId: string;
  task: ScheduleTask;
  run?: RunRecord;
  handoff?: HandoffInput;
  /** The task exactly as it stood right after the claim / handoff enqueue (once-exemption evidence). */
  claimed?: ScheduleTask;
  queuedAt: number;
  dead: boolean;
  /** `revokeTask` hit this entry while its ledger CAS was in flight: the pump settles it afterwards. */
  revoked?: boolean;
  /** The ledger CAS for this entry is awaiting (the entry must stay in the queue until it settles). */
  casing?: boolean;
  /** The handoff's terminal callback has fired (exactly once, whichever path got there first). */
  ended?: boolean;
  /** Claim time of the source run (revocation generation check). */
  sourceAt: number;
  failures: number;
}

interface Flight {
  kind: "message" | "handoff";
  runKey: string;
  token: string;
  noteId: string;
  task: ScheduleTask;
  run?: RunRecord;
  handoff?: HandoffInput;
  sentAt: number;
  phase: Phase;
  authorizedAt?: number;
  /** Shared with the process registry once authorized. */
  record?: ScheduledRunRecord;
  /** A run somebody else started while we were `dispatched` (the message may merge into it). */
  foreignStart: boolean;
  /** The ledger / handoff owner already has this flight's terminal outcome. */
  recorded: boolean;
  /** Aborted run that never settled: result recorded, capacity held until settle / idle evidence. */
  stuck: boolean;
  idleObs: number;
  modelCalled: boolean;
  merged: boolean;
  handed: boolean;
  voided: boolean;
  abortCause?: AbortCause;
  /**
   * I1 (C-S5): pi's pre-start compaction fires SYNCHRONOUSLY inside `sendCustomMessage`. A `session_before_compact`
   * that arrives while THIS send is on the stack was caused by this send (`selfCompaction`): its compaction window is
   * exempt from `verifyDispatch`'s "session moved" verdict (compaction ONLY) and pauses the start budget
   * (`compacting` ⇒ rolling deadline, `compactEndedAt` ⇒ resumes). A compaction that starts later is foreign: no exemption.
   */
  selfCompaction?: boolean;
  /** Generation of the fence at the dispatch point (a later change ⇒ the session identity moved). */
  gen: number;
  /** End of the window in which a `session_before_compact` is still attributed to this send. */
  attribUntil: number;
  compacting?: boolean;
  compactStartedAt?: number;
  compactEndedAt?: number;
  sawAssistant: boolean;
  lastText?: string;
  startTimer?: TimerHandle | undefined;
  maxTimer?: TimerHandle | undefined;
  graceTimer?: TimerHandle | undefined;
}

const OWNER_CLOSED_CODES: ReadonlySet<string> = new Set([
  "E_NOT_OWNER",
  "E_SECURE",
  "E_MODE",
  "E_CHILD",
  "E_EPHEMERAL",
]);

function textOf(message: unknown): string | undefined {
  const m = message as { role?: unknown; content?: unknown } | null | undefined;
  if (m === null || m === undefined || typeof m !== "object" || m.role !== "assistant") return undefined;
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content
    .map((part) =>
      part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

export function createMessageScheduler(deps: MessageSchedulerDeps): MessageScheduler {
  const { clock, host } = deps;
  const capability = deps.capability ?? getXsHostCapability();
  const occupancy = deps.occupancy ?? createProcessOccupancy();
  const registry = deps.registry ?? createProcessRunRegistry();
  const epochDisposed = deps.epochDisposed ?? ((): boolean => false);
  const newId = deps.newId ?? ((): string => randomBytes(8).toString("hex"));
  const warn = deps.warn ?? ((m: string): void => console.warn(`[pi-subagent] schedule: ${m}`));
  const epoch = deps.holder.epoch;
  const fence = createSessionFence({
    clock,
    warn: (m) => warn(`scheduler ${m}`),
    ...(deps.fencePorts !== undefined ? { ports: deps.fencePorts } : {}),
  });

  const queue: QEntry[] = [];
  /**
   * I1 review r1 #3: in-process revocation generation — taskId → time of the last pause/delete. Anything whose source run
   * was claimed at or before it (a handoff that reaches the queue AFTER the pause, a CAS in flight) is refused; the
   * enabled=false once-claim exemption can therefore never launder a post-pause wake. Process-local by design
   * (cross-process stays the CAS's task-snapshot residual); FIFO-capped, dies with the scheduler.
   */
  const revokedAt = new Map<string, number>();
  const REVOKED_MAX = 64;
  const revokedSince = (taskId: string, sourceAt: number): boolean => {
    const at = revokedAt.get(taskId);
    return at !== undefined && sourceAt <= at;
  };
  let flight: Flight | undefined;
  /** The flight whose `host.sendMessage` call is on the stack right now (synchronous attribution of reentrant events). */
  let sending: Flight | undefined;
  let shut = false;
  let running = false;
  let startSeq = 0;
  let settledSeq = 0;
  let lastSettledAt = Number.NEGATIVE_INFINITY;
  /**
   * ui prompts, reconciled per dialog identity `(kind,title)` — pi's events carry no id. `open`: dialogs
   * believed open. `credit`: an `end` that overtook its own `start` (cancelled only by a start with the
   * SAME key). `ghost`: dialogs that were open when the local reset ran — their late `end` is swallowed
   * (consumed FIRST, so an old dialog's late end can never close a newer one). Blocked ⇔ any `open` > 0.
   */
  const uiOpen = new Map<string, number>();
  const uiGhost = new Map<string, number>();
  let uiBlockedSince: number | undefined;
  /** Time of the last ui dialog end (settle buffer, see `UI_END_SETTLE_MS`). */
  let uiLastEndAt: number | undefined;
  let notified = false;
  let pumping = false;
  let pumpAgain = false;
  let pumpTimer: TimerHandle | undefined;
  let pumpDue = Number.POSITIVE_INFINITY;
  let chain: Promise<unknown> = Promise.resolve();
  const work = new Set<Promise<unknown>>();
  const sleepers = new Map<TimerHandle, () => void>();

  // ------------------------------------------------------------- plumbing

  const stopped = (): boolean => {
    if (!shut && deps.isDisposed()) scheduler.shutdown();
    return shut;
  };

  const track = <T>(p: Promise<T>): Promise<T> => {
    work.add(p);
    const done = (): void => void work.delete(p);
    p.then(done, done);
    return p;
  };

  /** All ledger writes of this scheduler run strictly in order. */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return track(next);
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const h = clock.setTimer(ms, () => {
        sleepers.delete(h);
        resolve();
      });
      sleepers.set(h, resolve);
    });

  /** A terminal / progress write that must land; retried with backoff (single try after shutdown). */
  const commit = (label: string, fn: () => Promise<boolean>): void => {
    void serial(async () => {
      for (let i = 0; i <= SCHED_MSG_COMMIT_RETRIES; i++) {
        let ok = false;
        try {
          ok = await fn();
        } catch (err) {
          warn(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (ok) return;
        if (shut || i === SCHED_MSG_COMMIT_RETRIES) break;
        await sleep(Math.min(500 * 2 ** i, 8_000));
      }
      warn(`${label}: ledger write gave up`);
    });
  };

  async function tx<T>(
    body: (draft: ScheduleStateFile, now: number) => { value: T; write: boolean },
  ): Promise<{ ok: true; value: T; wrote: boolean } | { ok: false; uncertain: boolean }> {
    const s = deps.store();
    if (s === undefined) return { ok: false, uncertain: false };
    const r = await s.transact((draft, ctx) => body(draft, ctx.now));
    if (!r.ok) return { ok: false, uncertain: r.uncertain === true };
    if (r.wrote) deps.changed();
    return { ok: true, value: r.value, wrote: r.wrote };
  }

  const setState = (runKey: string, state: "bound" | "aborting" | "queued"): void =>
    commit(`state ${state}`, async () => {
      const r = await tx((draft) => {
        const cur = findRun(draft, runKey);
        // `queued` is only ever a revert of our own `dispatched`.
        if (state === "queued" && cur?.state !== "dispatched") return { value: undefined, write: false };
        return { value: undefined, write: updateRun(draft, runKey, { state }) === "ok" };
      });
      return r.ok;
    });

  const finishLedger = (runKey: string, state: "unknown" | "dropped" | "continued", reason?: string): void =>
    commit(`finish ${state}`, async () => {
      const r = await tx((draft, now) => {
        const out = finishRun(draft, runKey, { state, ...(reason !== undefined ? { reason } : {}) }, now);
        return { value: undefined, write: out === "ok" };
      });
      return r.ok;
    });

  /** S1 uncertain commit of OUR queued→dispatched intent: never sent, converge to unknown (A0's rule). */
  const settleUncertain = (runKey: string): void =>
    commit("uncertain intent", async () => {
      const r = await tx((draft, now) => {
        const run = findRun(draft, runKey);
        if (run === undefined || isTerminalRunState(run.state) || !sameHolder(run.holder, deps.holder))
          return { value: undefined, write: false };
        finishRun(draft, runKey, { state: "unknown", reason: "no-outcome" }, now);
        return { value: undefined, write: true };
      });
      return r.ok;
    });

  const safeAbort = (why: string): void => {
    try {
      host.abort();
    } catch (err) {
      warn(`abort (${why}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const hostIdle = (): boolean => {
    try {
      return host.isIdle();
    } catch {
      return false; // stale ctx ⇒ not provably idle
    }
  };
  const hostPending = (): boolean => {
    try {
      return host.hasPendingMessages();
    } catch {
      return true;
    }
  };

  const clearTimer = (h: TimerHandle | undefined): undefined => {
    if (h !== undefined) clock.clearTimer(h);
    return undefined;
  };
  const clearFlightTimers = (f: Flight): void => {
    f.startTimer = clearTimer(f.startTimer);
    f.maxTimer = clearTimer(f.maxTimer);
    f.graceTimer = clearTimer(f.graceTimer);
  };
  /** Void the token everywhere it is checked (this flight AND the process registry record). */
  const voidFlight = (f: Flight): void => {
    f.voided = true;
    if (f.record !== undefined) f.record.voided = true;
  };

  // ------------------------------------------------------------- pump (queue → flight)

  const schedulePump = (delayMs: number): void => {
    if (shut) return;
    const due = clock.now() + delayMs;
    if (pumpTimer !== undefined && pumpDue <= due) return;
    pumpTimer = clearTimer(pumpTimer);
    pumpDue = due;
    pumpTimer = clock.setTimer(delayMs, () => {
      pumpTimer = undefined;
      pumpDue = Number.POSITIVE_INFINITY;
      void track(pump());
    });
  };

  const uiOpenCount = (): number => {
    let n = 0;
    for (const v of uiOpen.values()) n += v;
    return n;
  };
  const bump = (m: Map<string, number>, key: string, by: number): void => {
    const next = (m.get(key) ?? 0) + by;
    if (next > 0) m.set(key, next);
    else m.delete(key);
  };

  const quietOk = (): boolean => !running && startSeq === settledSeq && clock.now() - lastSettledAt >= SCHED_QUIET_MS;

  /** Next re-evaluation: the poll cadence, or sooner when only the quiet window is left to wait out. */
  const waitMs = (): number => {
    if (running || startSeq !== settledSeq) return SCHED_MSG_POLL_MS;
    const left = lastSettledAt + SCHED_QUIET_MS - clock.now();
    return left > 0 ? Math.min(SCHED_MSG_POLL_MS, left) : SCHED_MSG_POLL_MS;
  };

  type Readiness = "ok" | "wait" | { drop: string };

  function readiness(e: QEntry): Readiness {
    if (stopped()) return "wait";
    const cap = capability.state;
    if (cap === "absent") return { drop: "capability" };
    if (cap === "unknown")
      return clock.now() - e.queuedAt >= SCHED_CAPABILITY_UNKNOWN_MAX_MS ? { drop: "capability-unknown" } : "wait";
    const refusal = deps.gate(e.task);
    if (refusal !== undefined) return { drop: OWNER_CLOSED_CODES.has(refusal.code) ? "owner-closed" : "capability" };
    if (!quietOk()) return "wait";
    if (!hostIdle() || hostPending()) return "wait";
    if (deps.rootWakeBusy?.() === true || deps.xsWakeOwned?.() === true) return "wait";
    if (uiOpenCount() > 0) return "wait";
    if (uiLastEndAt !== undefined && clock.now() - uiLastEndAt < UI_END_SETTLE_MS) return "wait";
    if (!fence.check().ok) return "wait"; // goal downgrades to wait too — never a rejection
    return "ok";
  }

  /** A handoff entry's terminal callback fires at most once (coalesce / revoke / CAS / shutdown may all race to it). */
  const endHandoff = (e: QEntry, outcome: HandoffOutcome): void => {
    if (e.ended === true) return;
    e.ended = true;
    e.handoff!.onEnd(outcome);
  };

  const dropEntry = async (e: QEntry, reason: string): Promise<void> => {
    if (e.kind === "handoff") {
      endHandoff(e, { kind: "dropped", reason });
      return;
    }
    const run = e.run!;
    const r = await serial(() =>
      tx((draft, now) => {
        const cur = findRun(draft, run.runKey);
        if (cur === undefined || cur.state !== "queued" || !sameHolder(cur.holder, deps.holder))
          return { value: false, write: false };
        finishRun(draft, run.runKey, { state: "dropped", reason }, now);
        return { value: true, write: true };
      }),
    );
    if (!r.ok || !r.value) return;
    if (reason === "capability" || reason === "capability-unknown") {
      try {
        deps.notice({ run, task: e.task, reason });
      } catch (err) {
        warn(`notice failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (reason === "capability" && !notified) {
        notified = true;
        try {
          deps.notify?.("当前 pi 不提供定时消息所需的触发能力：定时消息不会执行（已排队的会被丢弃并记入会话）");
        } catch {
          /* advisory */
        }
      }
    }
  };

  /**
   * Authorization is evaluated against the definition the run was bound to (`defHash` of the claim),
   * not the queue-time snapshot: still approved, unchanged, and enabled — except an auto `once` task,
   * which the claim itself disabled when it consumed the occurrence (that is not a pause).
   */
  const stillAuthorized = (
    t: ScheduleTask | undefined,
    expectHash: string,
    runKind: "auto" | "manual",
    needHandoff: boolean,
    claimed: ScheduleTask | undefined,
  ): t is ScheduleTask => {
    if (t === undefined || defHash(t) !== expectHash || !isApproved(t)) return false;
    if (needHandoff && t.bg?.handoff !== true) return false;
    if (t.enabled) return true;
    // `enabled:false` on an auto once task is what the claim itself wrote when it consumed the occurrence.
    // It is only forgiven while NOTHING about the task changed since (an edit, a rename, a delete, a
    // re-enable → anything but the claim's own state ⇒ refuse). Irreducible residual (see A2-report r2):
    // a no-op `pause` of an already-disabled once task leaves the state identical and is not detectable.
    return (
      runKind === "auto" &&
      t.when.kind === "once" &&
      claimed !== undefined &&
      canonicalJson(t) === canonicalJson(claimed)
    );
  };

  const snapshotTask = (taskId: string): ScheduleTask | undefined => {
    try {
      const snap = deps.store()?.read();
      const t = snap?.kind === "ok" ? snap.state.tasks.find((x) => x.id === taskId) : undefined;
      return t === undefined ? undefined : structuredClone(t);
    } catch {
      return undefined;
    }
  };

  type Cas = { kind: "ok"; task: ScheduleTask } | { kind: "gone" | "changed" | "busy" | "uncertain" };

  /**
   * The authorization point: under the ledger lock re-validate the task and (message) move
   * queued→dispatched. Returns the validated task snapshot — the ONLY definition that may be sent.
   * Edits after this CAS happen after authorization (linearization point of the send).
   */
  const casDispatched = async (e: QEntry): Promise<Cas> => {
    const s = deps.store();
    if (s === undefined) return { kind: "busy" };
    const r = await s.transact<Cas>((draft, ctx) => {
      if (e.kind === "message") {
        const cur = findRun(draft, e.runKey);
        if (cur === undefined || cur.state !== "queued" || !sameHolder(cur.holder, deps.holder))
          return { value: { kind: "gone" }, write: false };
        const t = draft.tasks.find((x) => x.id === cur.taskId);
        if (revokedSince(cur.taskId, e.sourceAt) || !stillAuthorized(t, cur.defHash, cur.kind, false, e.claimed)) {
          finishRun(draft, cur.runKey, { state: "dropped", reason: "task-changed" }, ctx.now);
          return { value: { kind: "changed" }, write: true };
        }
        cur.state = "dispatched";
        return { value: { kind: "ok", task: structuredClone(t) }, write: true };
      }
      const h = e.handoff!;
      const t = draft.tasks.find((x) => x.id === h.taskId);
      const kind = parseRunKey(h.runKey)?.kind ?? "manual";
      if (revokedSince(h.taskId, e.sourceAt) || !stillAuthorized(t, h.defHash, kind, true, e.claimed))
        return { value: { kind: "changed" }, write: false };
      return { value: { kind: "ok", task: structuredClone(t) }, write: false };
    });
    if (!r.ok) return r.uncertain === true ? { kind: "uncertain" } : { kind: "busy" };
    if (r.wrote) deps.changed();
    return r.value;
  };

  /** The synchronous block: re-check, fence, send, verify. No awaits in here. */
  function sendNow(e: QEntry): "sent" | "retry" | "failed" {
    if (readiness(e) !== "ok") return "retry";
    const begin = fence.beginDispatch();
    if (!begin.ok) return "retry";
    const token = newId();
    const noteId = e.kind === "handoff" ? e.handoff!.noteId : newId();
    const f: Flight = {
      kind: e.kind,
      runKey: e.runKey,
      token,
      noteId,
      task: e.task,
      ...(e.run !== undefined ? { run: e.run } : {}),
      ...(e.handoff !== undefined ? { handoff: e.handoff } : {}),
      sentAt: clock.now(),
      gen: begin.gen,
      attribUntil: clock.now() + SCHED_SELF_COMPACTION_ATTRIB_MS,
      phase: "dispatched",
      foreignStart: false,
      recorded: false,
      stuck: false,
      idleObs: 0,
      modelCalled: false,
      merged: false,
      handed: false,
      voided: false,
      sawAssistant: false,
    };
    // Occupy before the host call: even a synchronous reentrant hook sees the flight.
    flight = f;
    sending = f; // I1: events delivered on THIS synchronous stack were caused by this send
    const content = e.kind === "handoff" ? e.handoff!.content : deps.contentFor(e.run!, e.task);
    try {
      host.sendMessage(
        {
          customType: SCHED_CUSTOM_TYPE,
          content,
          display: true,
          details: { kind: e.kind, runKey: e.runKey, token, noteId },
        },
        { triggerTurn: true },
      );
    } catch (err) {
      sending = undefined;
      if (flight === f) flight = undefined;
      warn(`sendMessage failed: ${err instanceof Error ? err.message : String(err)}`);
      return "failed";
    }
    sending = undefined;
    if (flight !== f) return "sent"; // finished reentrantly (shutdown / terminal inside the send)
    let verify = fence.verifyDispatch(begin.gen);
    if (
      !verify.ok &&
      verify.reason === "fenced:compaction" &&
      f.selfCompaction === true &&
      fence.status().open.every((n) => n === "compaction")
    ) {
      // The compaction window is the pre-start compaction THIS send triggered (it began on this synchronous stack and
      // no other window / session identity change is involved): the dispatch is still provably ours and live.
      verify = { ok: true, gen: begin.gen };
    }
    if (!verify.ok) {
      // The session identity moved under the send: the write is not provably live. The trigger may
      // still start later — it is an orphan (no flight) and gets aborted on sight.
      closeFlight(f);
      recordUnknown(f, "owner-closed");
      return "sent";
    }
    armStart(f);
    return "sent";
  }

  /** A stuck aborted run holds the dispatch slot until settle or two idle observations. */
  function observeStuck(): void {
    const f = flight;
    if (f === undefined || !f.stuck) return;
    f.idleObs = hostIdle() ? f.idleObs + 1 : 0;
    if (f.idleObs < SCHED_MSG_STUCK_IDLE_OBS) return;
    // Reliable idle evidence stands in for the missing agent_settled.
    running = false;
    settledSeq = startSeq;
    lastSettledAt = clock.now();
    registry.clear();
    closeFlight(f);
  }

  async function pumpOnce(): Promise<void> {
    for (;;) {
      if (stopped()) return;
      if (flight?.stuck === true) {
        observeStuck();
        if (flight?.stuck === true) {
          schedulePump(SCHED_MSG_POLL_MS);
          return;
        }
      }
      const e = queue[0];
      if (e === undefined) return;
      if (flight !== undefined) {
        schedulePump(SCHED_MSG_POLL_MS);
        return;
      }
      const v = readiness(e);
      if (v === "wait") {
        schedulePump(waitMs());
        return;
      }
      if (v !== "ok") {
        queue.shift();
        await dropEntry(e, v.drop);
        continue;
      }
      if (!occupancy.tryClaim(epoch, e.runKey)) {
        schedulePump(SCHED_MSG_POLL_MS);
        return;
      }
      e.casing = true;
      const cas = await serial(() => casDispatched(e)).finally(() => {
        e.casing = false;
      });
      const remove = (): void => {
        const i = queue.indexOf(e);
        if (i >= 0) queue.splice(i, 1);
      };
      if (e.revoked === true) {
        // revokeTask() ran while the CAS was in flight (A2 residual 3): whatever the CAS did, nothing is sent.
        occupancy.release(epoch, e.runKey);
        remove();
        revokeEntry(e);
        continue;
      }
      if (cas.kind === "gone" || cas.kind === "changed") {
        occupancy.release(epoch, e.runKey);
        remove();
        if (cas.kind === "changed" && e.kind === "handoff") endHandoff(e, { kind: "dropped", reason: "task-changed" });
        continue;
      }
      if (cas.kind === "uncertain") {
        // The intent may or may not have landed: never send, never blindly retry — converge to unknown.
        occupancy.release(epoch, e.runKey);
        remove();
        settleUncertain(e.runKey);
        continue;
      }
      if (cas.kind === "busy") {
        occupancy.release(epoch, e.runKey);
        schedulePump(SCHED_MSG_POLL_MS);
        return;
      }
      if (cas.kind !== "ok") continue; // (all other kinds were handled above)
      e.task = cas.task; // send exactly the definition the CAS authorized
      if (e.dead || stopped()) {
        occupancy.release(epoch, e.runKey);
        remove();
        if (e.kind === "message") setState(e.runKey, "queued");
        continue;
      }
      const res = sendNow(e);
      if (res === "sent") {
        remove();
        return; // the flight owns the occupancy now
      }
      occupancy.release(epoch, e.runKey);
      if (e.kind === "message") setState(e.runKey, "queued");
      if (res === "failed") {
        e.failures += 1;
        if (e.failures >= SCHED_MSG_SEND_FAILURES_MAX) {
          remove();
          await dropEntry(e, "capability");
          continue;
        }
      }
      schedulePump(SCHED_MSG_POLL_MS);
      return;
    }
  }

  async function pump(): Promise<void> {
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        await pumpOnce();
      } while (pumpAgain && !shut);
    } catch (err) {
      warn(`pump failed: ${err instanceof Error ? err.message : String(err)}`);
      schedulePump(SCHED_MSG_POLL_MS);
    } finally {
      pumping = false;
    }
  }

  // ------------------------------------------------------------- flight lifecycle

  /** The flight is over (or voided): timers, slot, token. */
  function closeFlight(f: Flight): void {
    clearFlightTimers(f);
    voidFlight(f);
    if (flight === f) flight = undefined;
    occupancy.release(epoch, f.runKey);
    schedulePump(0);
  }

  function recordUnknown(f: Flight, reason: string): void {
    if (f.recorded) return;
    f.recorded = true;
    if (f.kind === "handoff") f.handoff!.onEnd({ kind: "unknown", reason });
    else finishLedger(f.runKey, "unknown", reason);
  }
  function recordDropped(f: Flight, reason: string): void {
    if (f.recorded) return;
    f.recorded = true;
    if (f.kind === "handoff") f.handoff!.onEnd({ kind: "dropped", reason });
    else finishLedger(f.runKey, "dropped", reason);
  }

  /** Dispatched and never started: void the token; abort unless a human's own run may carry the message. */
  function startTimeout(f: Flight): void {
    f.startTimer = clearTimer(f.startTimer);
    recordUnknown(f, "start-timeout");
    if (f.foreignStart) closeFlight(f);
    else abortRun(f, "start-timeout"); // our trigger is stuck in prepare / pre-start compaction
  }

  /**
   * I1 review r1 #2: has the session moved (or is a mutation window open) under a flight that has not made its first
   * model call? Our OWN compaction while it is still running is the only tolerated open window; `goal` only downgrades
   * waking and never counts. A compaction we did not trigger (or one that ended while another window opened) blocks.
   */
  function sessionMovedUnder(f: Flight): boolean {
    if (fence.generation() !== f.gen) return true;
    const open = fence.status().open.filter((n) => n !== "goal");
    if (open.length === 0) return false;
    return !(f.compacting === true && open.every((n) => n === "compaction"));
  }

  /**
   * The start budget's end: `sentAt + 60 s`, pushed out by the pre-start compaction THIS send triggered (rolling while it
   * runs, `+60 s` after it ended), never beyond `sentAt + SCHED_START_COMPACTION_MAX_MS`.
   */
  function startDeadlineOf(f: Flight, now: number): number {
    const base = f.sentAt + SCHED_START_TIMEOUT_MS;
    if (f.compactStartedAt === undefined) return base;
    const candidate = f.compacting === true ? now : (f.compactEndedAt ?? now);
    return Math.min(f.sentAt + SCHED_START_COMPACTION_MAX_MS, Math.max(base, candidate + SCHED_START_TIMEOUT_MS));
  }

  /** Absolute deadlines, checked synchronously before any timer callback gets a chance (r1 #6). */
  function enforceDeadlines(f: Flight): void {
    if (flight !== f || (f.recorded && f.phase !== "aborting")) return;
    const now = clock.now();
    if (f.phase === "dispatched") {
      if (now >= startDeadlineOf(f, now)) startTimeout(f);
      return;
    }
    if ((f.phase !== "authorized" && f.phase !== "bound") || f.merged || f.handed) return;
    if (!f.modelCalled && now >= startDeadlineOf(f, now)) abortRun(f, "start-timeout");
    else if (f.authorizedAt !== undefined && now >= f.authorizedAt + SCHED_RUN_MAX_MS) abortRun(f, "run-max");
  }

  function armStart(f: Flight): void {
    const left = Math.max(0, startDeadlineOf(f, clock.now()) - clock.now());
    f.startTimer = clock.setTimer(left, () => {
      f.startTimer = undefined;
      if (flight !== f || stopped()) return;
      enforceDeadlines(f);
      // Our own pre-start compaction moved the deadline: not due yet ⇒ look again at the new one (bounded by the hard cap).
      const waiting =
        !f.recorded &&
        (f.phase === "dispatched" ||
          ((f.phase === "authorized" || f.phase === "bound") && !f.modelCalled && !f.merged && !f.handed));
      if (flight === f && f.startTimer === undefined && waiting) armStart(f);
    });
  }

  function armMax(f: Flight): void {
    f.maxTimer = clock.setTimer(SCHED_RUN_MAX_MS, () => {
      f.maxTimer = undefined;
      if (flight === f && !stopped()) enforceDeadlines(f);
    });
  }

  function abortRun(f: Flight, cause: AbortCause): void {
    voidFlight(f);
    f.phase = "aborting";
    f.abortCause = cause;
    f.startTimer = clearTimer(f.startTimer);
    f.maxTimer = clearTimer(f.maxTimer);
    if (f.kind === "message" && !f.recorded) setState(f.runKey, "aborting");
    // Grace armed BEFORE the abort: a synchronous settle must find (and clear) it.
    f.graceTimer = clock.setTimer(SCHED_MSG_ABORT_GRACE_MS, () => {
      f.graceTimer = undefined;
      if (flight !== f) return;
      // The result is downgraded (we have no proof the run ended), but the dispatch slot stays held
      // until agent_settled or two idle observations — the timer is never evidence of death.
      warn(`aborted scheduled run ${f.runKey} has not settled; holding the dispatcher until it does`);
      recordUnknown(f, "no-outcome");
      f.stuck = true;
      schedulePump(SCHED_MSG_POLL_MS);
    });
    safeAbort(cause);
  }

  function settle(f: Flight, reason: SettledReason | undefined): void {
    if (f.recorded) {
      closeFlight(f);
      return;
    }
    f.recorded = true;
    const text = f.lastText ?? "";
    closeFlight(f);
    if (f.kind === "handoff") {
      f.handoff!.onEnd({ kind: "settled", text, merged: reason === "merged", runMax: reason === "run-max" });
      return;
    }
    const run = f.run!;
    const task = f.task;
    commit("settled", () => deps.results.settled({ run, task, text, ...(reason !== undefined ? { reason } : {}) }));
  }

  function finalizeAtSettle(f: Flight, aborted: boolean): void {
    if (f.recorded) {
      closeFlight(f); // result already recorded (handed over / downgraded): only the slot is left
      return;
    }
    if (f.phase === "aborting") {
      if (f.abortCause === "run-max") {
        settle(f, "run-max");
        return;
      }
      closeFlight(f);
      if (f.sawAssistant) recordUnknown(f, "start-timeout");
      else recordDropped(f, "start-timeout");
      return;
    }
    if (f.phase === "authorized") {
      // Authorized but our message never entered a run's context before it ended.
      closeFlight(f);
      if (f.sawAssistant) recordUnknown(f, "start-timeout");
      else recordDropped(f, "start-timeout");
      return;
    }
    // bound
    settle(f, f.merged ? "merged" : aborted ? "aborted" : undefined);
  }

  // ------------------------------------------------------------- queue

  const enqueueEntry = (e: QEntry): void => {
    const dup = queue.findIndex((x) => x.runKey === e.runKey && x.kind === e.kind);
    if (dup >= 0 || flight?.runKey === e.runKey) return;
    // D13: at most one queued entry per (kind, task) — the newest wins.
    const old = queue.findIndex((x) => x.key === e.key);
    if (old >= 0) {
      const [gone] = queue.splice(old, 1);
      gone!.dead = true;
      if (gone!.kind === "handoff") endHandoff(gone!, { kind: "dropped", reason: "coalesced" });
    }
    queue.push(e);
    schedulePump(0);
  };

  /** The terminal consequence of a revoked entry: handoff ⇒ owner falls back to a quiet recap; message ⇒ dropped. */
  const revokeEntry = (e: QEntry): void => {
    if (e.kind === "handoff") endHandoff(e, { kind: "dropped", reason: "task-changed" });
    else finishLedger(e.runKey, "dropped", "task-changed");
  };

  const claimedOf = (taskId: string): { claimed?: ScheduleTask } => {
    const claimed = snapshotTask(taskId);
    return claimed === undefined ? {} : { claimed };
  };

  // ------------------------------------------------------------- the scheduler

  const scheduler: MessageScheduler = {
    fence,
    enqueue(run, task) {
      if (stopped()) return;
      if (revokedSince(run.taskId, run.startedAt)) {
        finishLedger(run.runKey, "dropped", "task-changed"); // claimed before a pause/delete that already happened
        return;
      }
      enqueueEntry({
        kind: "message",
        key: `message:${run.taskId}`,
        runKey: run.runKey,
        taskId: run.taskId,
        task,
        run,
        ...claimedOf(run.taskId),
        queuedAt: clock.now(),
        dead: false,
        sourceAt: run.startedAt,
        failures: 0,
      });
    },
    enqueueHandoff(input) {
      if (stopped()) return false;
      const sourceAt = input.startedAt ?? clock.now();
      if (input.startedAt !== undefined && revokedSince(input.taskId, sourceAt)) {
        // The source run was claimed before a pause/delete that already happened: no wake. Exactly one outcome.
        try {
          input.onEnd({ kind: "dropped", reason: "task-changed" });
        } catch (err) {
          warn(`handoff onEnd failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return true;
      }
      enqueueEntry({
        kind: "handoff",
        key: `handoff:${input.taskId}`,
        runKey: input.runKey,
        taskId: input.taskId,
        task: input.task,
        handoff: input,
        ...claimedOf(input.taskId),
        queuedAt: clock.now(),
        dead: false,
        sourceAt,
        failures: 0,
      });
      return true;
    },
    revokeTask(taskId) {
      revokedAt.set(taskId, clock.now());
      while (revokedAt.size > REVOKED_MAX) revokedAt.delete(revokedAt.keys().next().value as string);
      let n = 0;
      for (const e of [...queue]) {
        if (e.taskId !== taskId || e.dead) continue;
        e.dead = true;
        n += 1;
        if (e.casing === true) {
          e.revoked = true; // the pump finishes it after the in-flight CAS (never sends)
          continue;
        }
        const i = queue.indexOf(e);
        if (i >= 0) queue.splice(i, 1);
        revokeEntry(e);
      }
      if (n > 0) schedulePump(0);
      return n;
    },
    onBeforeAgentStart(event) {
      const before = capability.state;
      capability.observe(event);
      if (capability.state !== before) schedulePump(0);
      const trigger = readScheduleTrigger(event);
      if (trigger.kind !== "wake") {
        registry.clear(); // a new run starts: the previous run's record is gone
        if (flight?.phase === "dispatched") flight.foreignStart = true;
        return "other";
      }
      const f = flight;
      if (f !== undefined) enforceDeadlines(f);
      if (
        !stopped() &&
        f !== undefined &&
        flight === f &&
        !f.voided &&
        trigger.token !== undefined &&
        trigger.token === f.token &&
        f.phase !== "aborting"
      ) {
        if (f.phase === "dispatched" && sessionMovedUnder(f)) {
          // The pre-start wait ended with a mutation window open (switch / fork / tree / web_exec / topic_switch, a
          // foreign compaction) or a new session identity: the dispatch is no longer provably live. Converge like the
          // post-send check does — unknown(owner-closed), never a resend — and stop this trigger before any model call.
          closeFlight(f);
          recordUnknown(f, "owner-closed");
          markOrphanRun(registry, trigger.token);
          safeAbort("fenced");
          return "aborted";
        }
        if (f.phase === "dispatched") {
          const now = clock.now();
          f.phase = "authorized";
          f.authorizedAt = now;
          f.record = { token: f.token, epoch, deadlineAt: now + SCHED_RUN_MAX_MS, voided: false, handed: false };
          armMax(f);
        }
        if (f.record !== undefined) registry.set(f.record);
        return "authorized";
      }
      // Orphan: stale token, other epoch, voided by the start timeout, or a forged one. Its run is
      // recorded as void so every model call it still makes is refused even if this abort is lost.
      markOrphanRun(registry, trigger.token);
      safeAbort("orphan");
      return "aborted";
    },
    onContext() {
      const f = flight;
      if (f !== undefined) enforceDeadlines(f);
      if (
        f !== undefined &&
        flight === f &&
        !f.recorded &&
        !f.modelCalled &&
        !f.merged &&
        !f.handed &&
        !f.voided &&
        (f.phase === "authorized" || f.phase === "bound") &&
        sessionMovedUnder(f)
      ) {
        // Last gate before the first model request (window opened between before_agent_start and here).
        recordUnknown(f, "owner-closed");
        abortRun(f, "fenced");
        return;
      }
      const verdict = judgeScheduledContext(registry, clock.now(), epochDisposed);
      if (verdict === "abort") {
        // The authorization behind this run is gone (start timeout, run limit, teardown, reload): block the call.
        safeAbort("context");
        return;
      }
      if (
        verdict === "ok" &&
        f !== undefined &&
        f.record !== undefined &&
        registry.get() === f.record &&
        (f.phase === "authorized" || f.phase === "bound")
      )
        f.modelCalled = true;
    },
    onMessageStart(message) {
      const m = message as { role?: unknown; customType?: unknown; details?: unknown } | null | undefined;
      if (m === null || m === undefined || m.role !== "custom" || m.customType !== SCHED_CUSTOM_TYPE) return;
      const f = flight;
      const token =
        m.details !== null && typeof m.details === "object" ? (m.details as { token?: unknown }).token : undefined;
      if (f === undefined || f.voided || token !== f.token) return;
      if (f.phase === "dispatched") {
        // Pulled into a run somebody else started: human present, no limit, result marked merged.
        f.merged = true;
        f.startTimer = clearTimer(f.startTimer);
      } else if (f.phase !== "authorized") return;
      f.phase = "bound";
      if (f.kind === "message") setState(f.runKey, "bound");
      if (!f.merged) {
        // §7.5: tell the hub this run belongs to a scheduled message (done-card suppression).
        try {
          deps.onBound?.(f.runKey);
        } catch (err) {
          warn(`sched_bound failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
    onMessageEnd(message) {
      const f = flight;
      if (f === undefined || f.phase === "dispatched") return;
      const text = textOf(message);
      if (text === undefined) return;
      f.sawAssistant = true;
      if (text !== "") f.lastText = text;
    },
    onAgentStart() {
      running = true;
      startSeq += 1;
    },
    onAgentSettled(event) {
      running = false;
      settledSeq = startSeq;
      lastSettledAt = clock.now();
      registry.clear();
      const f = flight;
      if (f !== undefined && f.phase !== "dispatched") finalizeAtSettle(f, event?.aborted === true);
      schedulePump(SCHED_QUIET_MS);
    },
    onInput(event) {
      const f = flight;
      if (f === undefined || f.handed || f.voided || f.merged || f.recorded) return;
      if (f.phase !== "authorized" && f.phase !== "bound") return;
      let human = false;
      try {
        human = classifyHumanInput(event, deps.attributeInput?.());
      } catch {
        human = false;
      }
      if (!human) return;
      // Proven own-run start + proven human input ⇒ the run belongs to the human now.
      f.handed = true;
      if (f.record !== undefined) f.record.handed = true;
      f.startTimer = clearTimer(f.startTimer);
      f.maxTimer = clearTimer(f.maxTimer);
      f.recorded = true;
      if (f.kind === "handoff") f.handoff!.onEnd({ kind: "continued" });
      else finishLedger(f.runKey, "continued");
    },
    onUiPrompt(open, info) {
      // Pairing is by (kind,title) because pi's ui events carry no unique dialog id (every `ui.custom` has no title). The
      // rule is deliberately one-directional: it can only OVER-block. An `end` that finds no open dialog is ignored — it
      // never becomes a credit that a later, different dialog of the same key could consume (I1 review r1 #4); a start
      // whose end was lost keeps blocking until `/schedule repair` or `/fabric fence reset`.
      const key = `${info?.kind ?? ""}\u0000${info?.title ?? ""}`;
      if (open) bump(uiOpen, key, 1);
      else if ((uiGhost.get(key) ?? 0) > 0) bump(uiGhost, key, -1);
      else if ((uiOpen.get(key) ?? 0) > 0) bump(uiOpen, key, -1);
      uiBlockedSince = uiOpenCount() > 0 ? (uiBlockedSince ?? clock.now()) : undefined;
      if (!open) {
        uiLastEndAt = clock.now();
        schedulePump(UI_END_SETTLE_MS); // dispatch is not due before the settle buffer is over
      }
    },
    onFenceEvent(event) {
      fence.onEvent(event);
      const f = flight;
      if (
        event.type === "session_before_compact" &&
        f !== undefined &&
        f.phase === "dispatched" &&
        !f.foreignStart &&
        f.compactStartedAt === undefined &&
        (sending === f || clock.now() <= f.attribUntil)
      ) {
        // pi's pre-start compaction for THIS send: observed on the send's own synchronous stack, or — because real pi
        // awaits every handler in turn, so any handler ahead of ours delays this one by microtasks — within a short window
        // bound to this still-`dispatched` flight (first compaction only; a human's run starting closes it).
        f.selfCompaction = true;
        f.compacting = true;
        f.compactStartedAt = clock.now();
      } else if (
        (event.type === "session_compact" || event.type === "session_compact_failed") &&
        f !== undefined &&
        f.compacting === true
      ) {
        // Finished / failed / cancelled: no resend, the flight converges by the ordinary rules (authorization at its
        // own before_agent_start, or the start budget which now resumes from here).
        f.compacting = false;
        f.compactEndedAt = clock.now();
        if (f.startTimer !== undefined) {
          f.startTimer = clearTimer(f.startTimer);
          armStart(f);
        }
      }
      schedulePump(0);
    },
    resetBlockers() {
      // Reset starts a new generation: whatever was believed open becomes a ghost (its late end is ignored),
      // credits are dropped. A dialog that is really still open will be counted again by its own events.
      for (const [k, v] of uiOpen) bump(uiGhost, k, v);
      uiOpen.clear();
      uiBlockedSince = undefined;
      uiLastEndAt = undefined; // the human's explicit exit: no buffer to wait out
      fence.reset();
      schedulePump(0);
    },
    shutdown() {
      if (shut) return;
      shut = true;
      pumpTimer = clearTimer(pumpTimer);
      const f = flight;
      flight = undefined;
      if (f !== undefined) {
        clearFlightTimers(f);
        // A run we authorized and still supervise must not outlive its supervisor (/reload does not
        // abort it): void the record and stop the run. A human's / merged run is left alone.
        const supervised = (f.phase === "authorized" || f.phase === "bound") && !f.handed && !f.merged;
        // Still `dispatched` (our trigger may be in pre-start compaction / prepare, with no registry record
        // yet): the prepare is ours unless a human's run started meanwhile ⇒ stop it too, otherwise the
        // 60s start budget would die with this stack. If the abort is lost, the trigger is an orphan the
        // next stack aborts at `before_agent_start` (its token is unknown there) — never let through.
        const preparing = f.phase === "dispatched" && !f.foreignStart && !f.recorded;
        f.voided = true;
        if (supervised && f.record !== undefined) f.record.voided = true; // a human's run keeps its (handed) record
        occupancy.release(epoch, f.runKey);
        if (supervised || preparing) safeAbort("shutdown");
        // Ledger runs are closed by closeEpoch; a handoff has none, so tell its owner.
        if (f.kind === "handoff" && !f.recorded) {
          f.recorded = true;
          f.handoff!.onEnd({ kind: "unknown", reason: "owner-closed" });
        }
      }
      for (const e of queue.splice(0)) {
        e.dead = true;
        if (e.kind === "handoff") endHandoff(e, { kind: "dropped", reason: "owner-closed" });
      }
      for (const [h, resolve] of [...sleepers]) {
        clock.clearTimer(h);
        sleepers.delete(h);
        resolve();
      }
      fence.dispose();
    },
    status() {
      return { capability: capability.state, queued: queue.length, inflight: flight?.phase };
    },
    diagnostics() {
      return {
        capability: capability.state,
        queued: queue.length,
        inflight: flight?.phase,
        stuck: flight?.stuck === true,
        fence: fence.status(),
        uiPrompts: uiOpenCount(),
        uiBlockedSince,
      };
    },
    statusSuffix() {
      if (capability.state === "absent") return " · msg off";
      if (capability.state === "unknown" && queue.length > 0) return " · msg ?";
      return "";
    },
    async idle() {
      for (;;) {
        if (work.size === 0) return;
        await Promise.allSettled([...work]);
      }
    },
  };
  return scheduler;
}
