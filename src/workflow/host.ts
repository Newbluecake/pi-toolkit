import type { Clock, TimerHandle } from "../core/clock.js";
import { withDeadline } from "../core/deadline.js";
import type { Millis, RunId, UsageDelta } from "../core/types.js";
import { deriveChildBudget } from "./budget.js";
import { createCallRegistry, type CallRegistry } from "./call-registry.js";
import { buildEntry, CHAIN_SEED, nextChainDigest, taskKeyOf, type JournalStore } from "./journal.js";
import { decideReplay, type ReplayIndex } from "./replay.js";
import type {
  CallId,
  HostAckEnvelope,
  HostCallEnvelope,
  HostSettleEnvelope,
  OrphanChildSummary,
  ReplayScope,
  TaskKey,
  TaskSemantics,
  WorkerHost,
  WorkflowChildSummary,
  WorkflowReplayStats,
  WorkflowRunBudget,
} from "./types.js";

/**
 * M3.2 (workflow design §3.3/§3.5/§4.4): the host-side call handler —
 * `agent()`/`gate()` land here as `HostCallEnvelope`s, get answered with the
 * ack segment (HR3: `agent`'s ack never waits for the child), and (for
 * `agent`) get a second, asynchronous `settle` push once the spawned child
 * reaches a terminal state.
 *
 * Deliberately **not** importing `SpawnService` from `src/service/` (WI2,
 * carried forward from M3.1: the isolation shell stays decoupled from the
 * core/service layer's concrete types). `ChildSpawner` below is a
 * structural subset `SpawnService` already satisfies — the orchestrator's
 * caller passes a real `SpawnService` instance, TypeScript accepts it
 * because the shapes match, and `src/workflow/**` still has zero import
 * edges into `src/service/**`.
 */

export interface ChildSpawnResult {
  readonly runId: RunId;
  readonly label?: string;
}
export interface ChildSpawnError {
  readonly error: { readonly message: string };
}
export interface ChildOutcome {
  readonly runId: RunId;
  readonly status: "completed" | "failed" | "timed_out" | "aborted";
  readonly text?: string;
  readonly error?: { readonly message: string };
  /** M3.6 (§5.2 `budget.spent()`, M3.5 X9 leftover): the real `SpawnService`'s `RunOutcome.usage` is structurally compatible here — threaded through so `handleAgent`'s live-settle push can report `outputTokens` for the sandbox's cumulative counter (see `HostSettleEnvelope.outputTokens`'s doc). Optional: a `ChildSpawner` double with no usage concept simply never reports any (0 spent, never fabricated). */
  readonly usage?: UsageDelta;
}
export interface ChildSpawner {
  spawn(req: {
    type: string;
    prompt: string;
    label?: string;
    deadlineAt?: Millis;
    parentRunId?: string;
    /**
     * M3.3 Minor fix (§4.4.3 BW1/BW3): the relative budget `deriveChildBudget`
     * computed, threaded all the way to `SpawnRequest.budgetOverride` —
     * previously only the absolute `deadlineAt` cap was forwarded, so a
     * `SpawnService` that (like the real one) resolves relative
     * `totalMs`/`queueWaitMs` at the child's own enqueue time had no relative
     * signal at all, only the CC4 ceiling.
     */
    budgetOverride?: { totalMs?: Millis; queueWaitMs?: Millis };
  }): Promise<ChildSpawnResult | ChildSpawnError>;
  abort(runId: RunId, cause?: string): Promise<boolean>;
  waitAll(opts: { runIds: RunId[] }): Promise<{ settled: ChildOutcome[]; pending: RunId[] }>;
  /**
   * M3.3 §3.7 OS1/OS4: workflow-scoped bulk stop — structurally compatible
   * with `SpawnService.stopChildrenOf` (CC1). Optional: when absent, WL2
   * falls back to per-call `abort()` via `CallRegistry.cancelAll` alone
   * (still correct, just without the OS4 sweep's extra safety net for
   * children the registry never learned about).
   */
  stopChildrenOf?(parentRunId: string, cause: string): Promise<{ stopped: RunId[]; pending: RunId[] }>;
  /**
   * M3.5 §6.3 E2: a content hash of `type`'s *resolved* agent-type
   * configuration (systemPrompt/tools/model/thinking, per the design's
   * `agentTypeConfigHash`) — the real assembler wires this to the same
   * `AgentTypeRegistry` `SpawnService` itself resolves against, so an edited
   * `.md` definition changes the hash. Optional: when absent (or when it
   * returns `undefined` for a particular `type`), `handleAgent` **fails
   * closed** — that call is never eligible to replay (RP `config_hash_
   * unavailable`, M3.6 Blocker fix) rather than falling back to a bare
   * `type`-name key that could silently reuse a stale result across a
   * changed agent-type definition.
   */
  configHashOf?(type: string): string | undefined;
}

export type GateRunner = (
  cmd: string,
  opts: { cwd?: string; timeoutMs: Millis },
) => Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>;

/**
 * M10 (live workflow tool card): an observational child-lifecycle event —
 * "spawned" fires once a live `agent()` child has really spawned and its
 * `runId` is bound (and it was *not* already cancelled in the admission
 * window, see `registry.bind()`'s `cancelNow` path); "settled" fires exactly
 * once per child from the same `recordSettled` chokepoint that feeds
 * `WorkflowOutcome.children` — live, replay-hit and withheld outcomes alike.
 * Purely observational: consumers (the `SubagentWorkflow` tool's live card,
 * the fleet UI) must treat delivery as best-effort; none of the engine's
 * zero-hang invariants may ever come to depend on a listener existing.
 */
export interface WorkflowChildEvent {
  /**
   * workflow-agent-queue §5 adds two kinds:
   *  - "queued": the call was acked as queued (all maxParallel slots busy).
   *    It is followed by either "spawned" → "settled" or a direct "settled",
   *    never by a "spawned" preceding it.
   *  - "rejected": an admission failure — an ack failure that is not a
   *    cancellation (`stage: "admission"`), or a post-ack dispatch failure
   *    settled with `rejected: true` (`stage: "dispatch"`). When the call has
   *    a `children[]` record, "rejected" precedes its (withheld) "settled".
   *    Cancellation-class outcomes (stop, phase timeout, budget running out
   *    while queued) never emit "rejected".
   */
  readonly kind: "queued" | "spawned" | "settled" | "rejected";
  readonly callId: CallId;
  readonly runId?: RunId;
  readonly label?: string;
  readonly agentType?: string;
  readonly phaseId?: string;
  /** "settled" only — mirrors the recorded `WorkflowChildSummary`. */
  readonly status?: WorkflowChildSummary["status"];
  readonly source?: "live" | "replay";
  readonly durationMs?: Millis;
  /** "settled" only, previously-queued calls only — mirrors `WorkflowChildSummary.queueWaitMs`. */
  readonly queueWaitMs?: Millis;
  /** "rejected" only. */
  readonly stage?: "admission" | "dispatch";
  /** "rejected" only. */
  readonly reason?: WorkflowChildRejectReason;
  /** "rejected" only — the failure message, capped at 200 chars. */
  readonly message?: string;
  readonly at: Millis;
}

/** workflow-agent-queue §5: why an `agent()` call was rejected. */
export type WorkflowChildRejectReason =
  "invalid_args" | "max_children" | "budget_exhausted" | "spawn_error" | "spawn_timeout" | "host_call_timeout";

/** §5: event messages are capped at 200 chars. */
export function capEventMessage(message: string): string {
  return message.length > 200 ? `${message.slice(0, 199)}\u2026` : message;
}

/**
 * M3.5 §6.5/§6.6: everything `handleAgent` needs to run the replay
 * short-circuit + write journal entries for one run. Optional on
 * `HostCallHandlerDeps` — a run with no `journal` configured skips both
 * (unchanged M3.2/M3.4 live-only behavior, zero journal I/O).
 */
export interface JournalRunConfig {
  readonly store: JournalStore;
  readonly dir: string;
  readonly index: ReplayIndex;
  readonly scope: ReplayScope;
  /** RP1. */
  readonly noReplay: boolean;
  readonly replayTtlMs?: Millis;
  readonly journalFlushMs?: Millis;
  /**
   * RP9, mutable: `true` until the worker's `meta` message says otherwise
   * (see orchestrator.ts's `onMeta` wiring — updated *before* boot()
   * resolves the script's first turn, so no `agent()` call can ever observe
   * a stale value). A plain object (not a getter function) so orchestrator.ts
   * and host.ts share one mutable cell without an extra indirection layer.
   */
  readonly deterministic: { current: boolean };
}

export interface HostCallHandlerDeps {
  readonly clock: Clock;
  readonly workerHost: WorkerHost;
  readonly spawner: ChildSpawner;
  readonly gateRunner: GateRunner;
  readonly budget: Pick<
    WorkflowRunBudget,
    | "hostCallMs"
    | "gateMs"
    | "maxParallel"
    | "maxChildren"
    | "maxBatchItems"
    | "childBudgetPolicy"
    | "childBudgetFraction"
    | "childTotalMs"
    | "cancelRetryWindowMs"
    | "phaseTotalMs"
  >;
  /** WR2-equivalent: the workflow's own absolute deadline, computed once at enqueue and never recomputed here. */
  readonly workflowDeadlineAt?: Millis;
  readonly defaultAgentType?: string;
  readonly parentRunId?: string;
  /** M3.5 §6.2: the workflow run's own top-level `args` — folded into every task's `TaskSemantics.workflowArgs`. */
  readonly workflowArgs?: unknown;
  /** M3.5, see `JournalRunConfig`'s doc. */
  readonly journal?: JournalRunConfig;
  /** Fired once per settled/withheld child, in settlement order (feeds `WorkflowOutcome.children`). */
  onChildSettled?(summary: WorkflowChildSummary): void;
  /** M10: live child-lifecycle feed (see `WorkflowChildEvent`). Optional, harmless no-op if absent. */
  onChildEvent?(event: WorkflowChildEvent): void;
  /** M3.4 §9.2: fired once per `phase(title)`/timeout transition (progress-event plumbing; optional, harmless no-op if absent). */
  onPhaseChange?(event: { phaseId: string; kind: "enter" | "timeout"; at: Millis }): void;
}

export interface HostCallHandler {
  readonly registry: CallRegistry;
  readonly children: readonly WorkflowChildSummary[];
  /** M3.4 §9.1/§9.2: the most recent `phase(title)` the script declared, if any (diagnostics only). */
  readonly currentPhaseId: string | undefined;
  /** M3.5 §3.3/§9.4: replay hit/miss/skip counters for this run; `corruptLines` mirrors `deps.journal.index.stats.corruptLines` (fixed at load time). `undefined` when no `journal` was configured. */
  readonly replayStats: WorkflowReplayStats | undefined;
  /** Best-effort: attempts to stop every still-active child (used ahead of a future M3.3 abort pipeline; harmless no-op today if nothing is running). */
  cancelAllChildren(cause: string): void;
  /**
   * M3.3 §7.2 WL1/WL2/WL4 (inline): closes the gate, cascade-cancels every
   * still-active call, waits up to `graceMs` (WT10 `abortGraceMs`) for real
   * settlement, then force-settles and reports whatever is left as
   * orphaned. Idempotent (WI6) — a second call (or a subsequent
   * `WorkerHost.terminate()`'s `onTerminating`) is a no-op once this has run.
   */
  stopOwned(cause: string, graceMs: Millis): Promise<{ orphanChildren: readonly OrphanChildSummary[] }>;
  /** M3.5 JS4: a single bounded best-effort flush of this run's `journal` (no-op if none configured). Intended to be called once, ahead of the workflow's terminal decision (orchestrator.ts). */
  flushJournal(deadlineMs: Millis): Promise<{ written: number; pending: number } | undefined>;
}

const DEFAULT_AGENT_TYPE = "general-purpose";

/** workflow-agent-queue D2/D5: what `dispatchQueued` needs to spawn a call that was acked as queued. */
interface QueuedAgentCall {
  readonly callId: CallId;
  readonly prompt: string;
  readonly agentType: string;
  readonly label?: string;
  readonly phaseId?: string;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Wires `deps.workerHost.events.onHostCall`/`onTerminating` and returns a
 * handle exposing the registry + accumulated child summaries. Call once per
 * workflow run (mirrors `createWorkerHost` — one instance per run, no
 * reuse).
 */
export function attachHostCallHandler(deps: HostCallHandlerDeps): HostCallHandler {
  const budget = {
    hostCallMs: deps.budget.hostCallMs ?? 60_000,
    gateMs: deps.budget.gateMs ?? 600_000,
    maxParallel: deps.budget.maxParallel ?? 4,
    maxChildren: deps.budget.maxChildren ?? 500,
    maxBatchItems: deps.budget.maxBatchItems ?? 1024,
    childBudgetPolicy: deps.budget.childBudgetPolicy ?? "inherit_remaining",
    ...(deps.budget.childBudgetFraction !== undefined ? { childBudgetFraction: deps.budget.childBudgetFraction } : {}),
    ...(deps.budget.childTotalMs !== undefined ? { childTotalMs: deps.budget.childTotalMs } : {}),
  };
  const children: WorkflowChildSummary[] = [];
  const startedAt = new Map<CallId, Millis>();
  const phaseOf = new Map<CallId, string>();
  // M10: submission-time display metadata, consulted when the lifecycle
  // events fire (recordSettled / the post-bind "spawned" announcement) and
  // folded into the recorded summary itself — `WorkflowChildSummary.label`
  // existed in the type since M3.x but was never populated until now.
  const labelOf = new Map<CallId, string>();
  const agentTypeOf = new Map<CallId, string>();
  let terminated = false;
  let currentPhaseId: string | undefined;

  // workflow-agent-queue D2/D3: `agent()` calls acked while every maxParallel
  // slot was busy wait here, strictly FIFO, until `pump()` admits them. They
  // hold no slot (`activeCount()` excludes the registry's `queued` phase).
  // Bounded: at most `maxChildren − active` entries (maxChildren counts
  // queued calls), and emptied synchronously by stopOwned/onTerminating.
  const waitQueue: QueuedAgentCall[] = [];
  const enqueuedAtOf = new Map<CallId, Millis>();
  /** Set at dispatch: how long a queued call waited for its slot. */
  const queueWaitOf = new Map<CallId, Millis>();
  /** D5: the per-dispatch spawn-timeout timer of each in-flight queued dispatch (cleared by whoever settles the call). */
  const spawnTimers = new Map<CallId, TimerHandle>();
  let pumping = false;

  function clearSpawnTimerOf(callId: CallId): void {
    const timer = spawnTimers.get(callId);
    if (timer === undefined) return;
    deps.clock.clearTimer(timer);
    spawnTimers.delete(callId);
  }

  // M3.5 §6.2: per-run chain digest (advances on every submission, hit or
  // miss — 推论 2.2/定理 4') + per-K submission counters (occurrence is
  // assigned here, at *submission* time, never at settle time — the one
  // property that makes completion order irrelevant to matching). Both are
  // no-ops (never read) when `deps.journal` is absent.
  let chainDigest = CHAIN_SEED;
  const occCounters = new Map<string, number>();
  /** callId -> the journal bookkeeping needed to write an entry once this call's live settle arrives (RP3: only successful calls are ever journaled). */
  const journalMetaOf = new Map<
    CallId,
    { taskKey: TaskKey; chainDigestBefore: string; occurrence: number; agentType: string; isolation?: "worktree" }
  >();
  const replayStats = { hits: 0, misses: 0, skipped: 0 };
  /**
   * M3.4 fix (found while adding real WT7 coverage): a *single* "current
   * phase timer" is wrong — clearing the previous phase's timer the instant
   * a script moves on to `phase("next")` means a straggler call left behind
   * in the abandoned phase never gets WT7's cancellation at all (the exact
   * pattern the design's own `agent()`-without-`await` + `parallel`/
   * `pipeline` idioms encourage). Each phase gets its own independent timer,
   * keyed by title, so a still-active call in an *earlier* phase is still
   * bounded by that phase's own budget even after the script has moved on.
   */
  const phaseTimers = new Map<string, ReturnType<Clock["setTimer"]>>();

  function clearAllPhaseTimers(): void {
    for (const timer of phaseTimers.values()) deps.clock.clearTimer(timer);
    phaseTimers.clear();
  }

  /**
   * M3.4 WT7/§7.2 WI8: a script's `phase(title)` statement re-labels the
   * environment every subsequent `agent()` call (without its own
   * `opts.phase`) lands under, and (if `budget.phaseTotalMs` is configured)
   * arms a fresh bounded timer *for that phase title specifically* —
   * independent of whatever other phase timers are already ticking for
   * earlier phases the script has since moved past.
   *
   * WI8 is the crucial distinction from WL1 `close_gate`: on expiry only the
   * calls this function itself tagged with `title` are cancelled
   * (`registry.cancel`, the ordinary A1-A4 per-call path) — the registry is
   * never closed, `terminated` never flips, and the workflow's own status is
   * completely unaffected. A phase timeout is a *local* event.
   */
  function handlePhase(title: string): void {
    if (terminated) return; // WL1 already closed everything down; a late phase() from the worker changes nothing.
    currentPhaseId = title;
    deps.onPhaseChange?.({ phaseId: title, kind: "enter", at: deps.clock.now() });
    const phaseTotalMs = deps.budget.phaseTotalMs;
    if (phaseTotalMs === undefined || phaseTotalMs <= 0) return;
    // Re-entering the same phase title restarts its own clock (a script that
    // calls `phase("retry")` more than once is opting into a fresh budget for
    // that leg, same as any other phase).
    const existing = phaseTimers.get(title);
    if (existing !== undefined) deps.clock.clearTimer(existing);
    phaseTimers.set(
      title,
      deps.clock.setTimer(phaseTotalMs, () => {
        phaseTimers.delete(title);
        const targets = registry.listActive().filter((active) => phaseOf.get(active.callId) === title);
        // Drop this phase's queued calls from the FIFO *before* settling
        // anything: each settle below pumps the queue, and it must never
        // dispatch a call this same timer is about to withhold.
        const targetIds = new Set(targets.map((t) => t.callId));
        for (let i = waitQueue.length - 1; i >= 0; i -= 1) {
          if (targetIds.has(waitQueue[i]!.callId)) waitQueue.splice(i, 1);
        }
        for (const active of targets) {
          // workflow-agent-queue D6/D7 (single owner): whoever flips a call to
          // settled records it. `cancel()` returning "withheld" means *this*
          // timer just settled a never-spawned admission — record + settle it
          // here (it used to be silently dropped from `children[]`). Active
          // (bound) calls return "retrying": their real settle still arrives
          // through the child's own waitAll() path.
          if (registry.cancel(active.callId, "phase_timeout") === "withheld") {
            settleUnspawned(active.callId, { cause: "phase_timeout", message: "withheld (phase_timeout)" });
          }
        }
        deps.onPhaseChange?.({ phaseId: title, kind: "timeout", at: deps.clock.now() });
      }),
    );
  }
  deps.workerHost.events.onPhase(handlePhase);

  const registry = createCallRegistry({
    clock: deps.clock,
    abort: (runId, cause) => deps.spawner.abort(runId, cause),
    // WT18: `startupMs`(core default 30s) + slack by default, but honors an
    // explicit budget override so a real assembler (or a test, via
    // `OrchestratorTestHooks.cancelRetryWindowMsOverride`) can thread the
    // *actual* configured window through instead of this fixed fallback.
    cancelRetryWindowMs: deps.budget.cancelRetryWindowMs ?? 35_000,
  });

  /** D1: slots in use — admission + pre_runner + running; `queued` calls hold none. */
  function activeCount(): number {
    const stats = registry.stats;
    return stats.admission + stats.pre_runner + stats.running;
  }

  /** D1: every call ever submitted this run, queued and settled included (the maxChildren measure). */
  function totalSubmitted(): number {
    const stats = registry.stats;
    return stats.queued + stats.admission + stats.pre_runner + stats.running + stats.settled;
  }

  /** How long `callId` waited in the queue: fixed at dispatch, or still running if it never left the queue. `undefined` for a call that was never queued. */
  function queueWaitMsOf(callId: CallId): Millis | undefined {
    const fixed = queueWaitOf.get(callId);
    if (fixed !== undefined) return fixed;
    const enqueuedAt = enqueuedAtOf.get(callId);
    return enqueuedAt === undefined ? undefined : deps.clock.now() - enqueuedAt;
  }

  function recordSettled(summary: WorkflowChildSummary): void {
    const label = labelOf.get(summary.callId);
    const agentType = agentTypeOf.get(summary.callId);
    const queueWaitMs = queueWaitMsOf(summary.callId);
    labelOf.delete(summary.callId);
    agentTypeOf.delete(summary.callId);
    enqueuedAtOf.delete(summary.callId);
    queueWaitOf.delete(summary.callId);
    const labelled = summary.label === undefined && label !== undefined ? { ...summary, label } : summary;
    const enriched =
      queueWaitMs !== undefined && labelled.queueWaitMs === undefined ? { ...labelled, queueWaitMs } : labelled;
    children.push(enriched);
    deps.onChildSettled?.(enriched);
    // M10: "settled" fires here — the single chokepoint every child outcome
    // (live settle, replay hit, withheld, force-settled abort) passes through.
    deps.onChildEvent?.({
      kind: "settled",
      callId: enriched.callId,
      ...(enriched.runId !== undefined ? { runId: enriched.runId } : {}),
      ...(enriched.label !== undefined ? { label: enriched.label } : {}),
      ...(agentType !== undefined ? { agentType } : {}),
      ...(enriched.phaseId !== undefined ? { phaseId: enriched.phaseId } : {}),
      status: enriched.status,
      source: enriched.source,
      durationMs: enriched.durationMs,
      ...(enriched.queueWaitMs !== undefined ? { queueWaitMs: enriched.queueWaitMs } : {}),
      at: deps.clock.now(),
    });
    if (registry.listActive().length === 0) {
      const waiters = drainWaiters.splice(0, drainWaiters.length);
      for (const cb of waiters) cb();
    }
    // D3: every settle may free a slot — hand it to the head of the queue.
    pump();
  }

  // M3.3 §7.2 WL2: event-driven (not polled) wait for "every still-active
  // call has really settled" — `recordSettled` above notifies every waiter
  // the instant the registry drains, so `stopOwned`'s bounded wait resolves
  // as soon as children finish for real instead of only on a fixed poll
  // cadence (also makes it exactly one `Clock.setTimer` per `stopOwned` call,
  // which plays correctly with `FakeClock`-driven tests — a single
  // `clock.advance(graceMs)` is enough to force the timeout branch).
  const drainWaiters: Array<() => void> = [];

  /**
   * workflow-agent-queue D10/§5: the single "rejected" emitter. Display
   * metadata comes from the submission maps when the call got that far, or
   * from `meta` for an ack failure that returns before them.
   */
  function emitRejected(
    callId: CallId,
    stage: "admission" | "dispatch",
    reason: WorkflowChildRejectReason,
    message: string,
    meta: { label?: string | undefined; agentType?: string | undefined; phaseId?: string | undefined } = {},
  ): void {
    const label = labelOf.get(callId) ?? meta.label;
    const agentType = agentTypeOf.get(callId) ?? meta.agentType;
    const phaseId = phaseOf.get(callId) ?? meta.phaseId;
    deps.onChildEvent?.({
      kind: "rejected",
      callId,
      ...(label !== undefined ? { label } : {}),
      ...(agentType !== undefined ? { agentType } : {}),
      ...(phaseId !== undefined ? { phaseId } : {}),
      stage,
      reason,
      message: capEventMessage(message),
      at: deps.clock.now(),
    });
  }

  /** Best-effort display metadata of a raw `agent()` args object (for "rejected" events emitted before `handleAgent` parses it). */
  function displayMetaOfArgs(args: unknown): { label?: string; agentType?: string; phaseId?: string } {
    const opts = (args as { opts?: unknown } | null | undefined)?.opts;
    if (opts === null || typeof opts !== "object") return {};
    const o = opts as { label?: unknown; agentType?: unknown; phase?: unknown };
    return {
      ...(typeof o.label === "string" ? { label: o.label } : {}),
      ...(typeof o.agentType === "string" ? { agentType: o.agentType } : {}),
      ...(typeof o.phase === "string" ? { phaseId: o.phase } : {}),
    };
  }

  /**
   * A1 (withheld) — workflow-agent-queue D6: the single recorder for a call
   * that never got a bound child. Callers must have *just* flipped the call
   * to settled themselves (`registry.cancel()` returned `"withheld"`) — that
   * is the single-owner rule that guarantees exactly one `children[]` entry
   * and at most one `host_settle` per callId. `message` is the real reason
   * (never a generic "terminating" for a phase timeout / spawn failure);
   * `rejected` marks a post-ack admission failure the worker must surface as
   * a rejection rather than `null`.
   */
  function settleUnspawned(
    callId: CallId,
    opts: {
      cause: string;
      message: string;
      rejected?: { stage: "admission" | "dispatch"; reason: WorkflowChildRejectReason };
    },
  ): void {
    clearSpawnTimerOf(callId); // an in-flight queued dispatch: no armed timer outlives its call (a late spawn still orphan-aborts).
    // §5 order: "rejected" precedes the withheld "settled".
    if (opts.rejected !== undefined) emitRejected(callId, opts.rejected.stage, opts.rejected.reason, opts.message);
    // D8: an undispatched call's duration runs from enqueue (queueWaitMs is recorded separately).
    const durationMs = deps.clock.now() - (enqueuedAtOf.get(callId) ?? startedAt.get(callId) ?? deps.clock.now());
    const phaseId = phaseOf.get(callId);
    journalMetaOf.delete(callId); // never journaled (RP3: withheld isn't a success).
    recordSettled({
      callId,
      source: "live",
      status: "withheld",
      durationMs,
      ...(phaseId !== undefined ? { phaseId } : {}),
    });
    deps.workerHost.send({
      kind: "host_settle",
      callId,
      ok: false,
      error: { message: opts.message },
      ...(opts.rejected !== undefined ? { rejected: true as const } : {}),
    } satisfies HostSettleEnvelope);
  }

  /**
   * A2/A3/A4: still active when the workflow decided to stop. Force-settles
   * it as `aborted` rather than waiting for the (now-moot) A2 retry loop to
   * eventually give up on its own `cancelRetryWindowMs` clock — HR8/WL4:
   * nothing may stay pending once the workflow itself has ended.
   */
  function forceSettleActive(callId: CallId, cause: string): void {
    const state = registry.resolve(callId);
    registry.settle(callId, deps.clock.now());
    const durationMs = deps.clock.now() - (startedAt.get(callId) ?? deps.clock.now());
    const phaseId = phaseOf.get(callId);
    journalMetaOf.delete(callId); // never journaled (RP3: forced-abort isn't a success).
    recordSettled({
      callId,
      ...(state?.runId !== undefined ? { runId: state.runId } : {}),
      source: "live",
      status: "aborted",
      durationMs,
      ...(phaseId !== undefined ? { phaseId } : {}),
    });
    // Best-effort: the port may already be closing (S5), but a send racing
    // that close is harmless (WorkerHost.send is a no-throw best-effort primitive).
    deps.workerHost.send({
      kind: "host_settle",
      callId,
      ok: false,
      error: { message: `workflow terminating (${cause})` },
    } satisfies HostSettleEnvelope);
  }

  function remainingWorkflowMs(): Millis {
    if (deps.workflowDeadlineAt === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(0, deps.workflowDeadlineAt - deps.clock.now());
  }

  async function handleAgent(callId: CallId, args: unknown): Promise<HostAckEnvelope> {
    const a = args as {
      prompt?: unknown;
      opts?: { label?: unknown; agentType?: unknown; phase?: unknown } | null;
    };
    if (typeof a.prompt !== "string") {
      const message = "agent(prompt, opts?): prompt must be a string";
      emitRejected(callId, "admission", "invalid_args", message, displayMetaOfArgs(args));
      return { kind: "host_ack", id: callId, ok: false, error: { message } };
    }
    const opts = a.opts ?? {};
    const label = typeof opts.label === "string" ? opts.label : undefined;
    const agentType =
      typeof opts.agentType === "string" ? opts.agentType : (deps.defaultAgentType ?? DEFAULT_AGENT_TYPE);
    // M3.4 §5.2: worker-source.ts already resolved \`opts.phase\` against the
    // script's environment \`phase(title)\` (explicit \`opts.phase\` wins) before
    // this call ever left the sandbox — this handler just records whatever it
    // receives, it never itself falls back to a "current phase" notion (that
    // state lives in \`currentPhaseId\`/\`handlePhase\` above, worker-side only).
    const phaseId = typeof opts.phase === "string" ? opts.phase : undefined;
    // M3.5 RP7 (§6.4): opt-in per-call `isolation:"worktree"` marker — not
    // yet threaded into `ChildSpawner.spawn()` (host.ts doesn't call
    // `SpawnService` directly, WI2), so it has no *live* effect on where the
    // child actually runs today. It exists here purely so the journal
    // records it and RP7 can veto replaying it once a future milestone wires
    // real worktree isolation through `ChildSpawner`.
    const isolation: "worktree" | undefined =
      (opts as { isolation?: unknown }).isolation === "worktree" ? "worktree" : undefined;

    // M3.5 §6.2/§6.4: the replay short-circuit. Computed unconditionally
    // whenever a journal is configured, before any admission-limit checks
    // below — occurrence/chain-digest must advance on *every* submission,
    // hit or miss (定理 3 "至多复用一次" depends on `occCounters` incrementing
    // regardless of outcome), and a replay hit never touches the live
    // resource limits below (it doesn't hold a `SlotPool`/parallel slot).
    const journal = deps.journal;
    if (journal) {
      // M3.6 Blocker fix (§6.3 E2 / replay.ts's `configHashAvailable`): a
      // missing `ChildSpawner.configHashOf` (or one that returns `undefined`
      // for this `agentType`) used to fall back to the bare type name as the
      // hash — silently promoting "we don't know if the config changed" to
      // "assume it didn't", which is exactly backwards for a cache. The
      // fallback string below only feeds the journal *write* path (so a
      // written entry still gets a taskKey distinct from any real-hash
      // taskKey, rather than colliding); `configHashAvailable: false` below
      // makes `decideReplay` skip the *read* path unconditionally, so no
      // entry — written under this fallback or any other — is ever handed
      // back as a hit while the real hash stays unresolved.
      const resolvedHash = deps.spawner.configHashOf?.(agentType);
      const configHashAvailable = resolvedHash !== undefined;
      const agentTypeConfigHash = resolvedHash ?? `unresolved:${agentType}`;
      const sem: TaskSemantics = {
        agentType,
        agentTypeConfigHash,
        prompt: a.prompt,
        ...(isolation !== undefined ? { isolation } : {}),
        ...(deps.workflowArgs !== undefined ? { workflowArgs: deps.workflowArgs } : {}),
      };
      const taskKey = taskKeyOf(sem);
      const chainDigestBefore = chainDigest;
      const kForOccurrence = journal.scope === "content" ? taskKey : nextChainDigest(chainDigestBefore, taskKey);
      const occurrence = occCounters.get(kForOccurrence) ?? 0;
      occCounters.set(kForOccurrence, occurrence + 1);
      // §6.2 step 5: the chain always advances, hit or miss.
      chainDigest = nextChainDigest(chainDigestBefore, taskKey);

      const decision = decideReplay({
        index: journal.index,
        taskKey,
        chainDigestBefore,
        occurrence,
        noReplay: journal.noReplay,
        deterministic: journal.deterministic.current,
        now: deps.clock.now(),
        configHashAvailable,
        ...(journal.replayTtlMs !== undefined ? { replayTtlMs: journal.replayTtlMs } : {}),
      });

      if (decision.kind === "hit") {
        replayStats.hits += 1;
        registry.submit(callId, deps.clock.now());
        startedAt.set(callId, deps.clock.now());
        if (phaseId !== undefined) phaseOf.set(callId, phaseId);
        if (label !== undefined) labelOf.set(callId, label);
        agentTypeOf.set(callId, agentType);
        registry.settle(callId, deps.clock.now());
        recordSettled({
          callId,
          source: "replay",
          status: "completed",
          durationMs: 0,
          taskKey,
          occurrence,
          ...(decision.entry.value !== null ? { textPreview: decision.entry.value.slice(0, 2048) } : {}),
          ...(phaseId !== undefined ? { phaseId } : {}),
        });
        // Same two-stage ack/settle shape as the live path (HR3) — the ack
        // returned below is what the caller posts; the settle push happens
        // here, synchronously, since there is nothing to await. Worker-side
        // buffering (`bufferedSettles`, worker-source.ts) already tolerates a
        // settle landing before its own ack is processed, so wire order is
        // not load-bearing here.
        deps.workerHost.send({
          kind: "host_settle",
          callId,
          ok: true,
          value: decision.entry.value,
        } satisfies HostSettleEnvelope);
        return {
          kind: "host_ack",
          id: callId,
          ok: true,
          value: { callId, deadlineAt: deps.clock.now() },
        };
      }
      if (decision.kind === "miss") replayStats.misses += 1;
      else replayStats.skipped += 1;
      journalMetaOf.set(callId, {
        taskKey,
        chainDigestBefore,
        occurrence,
        agentType,
        ...(isolation !== undefined ? { isolation } : {}),
      });
    }

    // §5.3 D-W… "narrowed": M3.2 does not have the agent-type registry
    // reachable at this layer (it lives in `AgentTypeRegistry`, service
    // layer) — unknown-type rejection is enforced by `ChildSpawner.spawn`
    // itself returning `{ error }`, which this handler already threads
    // through to an ack failure below. No separate check needed here.

    // workflow-agent-queue D2 ②: maxChildren counts queued calls too (the
    // queue can never outgrow `maxChildren − active`).
    if (totalSubmitted() >= budget.maxChildren) {
      journalMetaOf.delete(callId);
      const message = `agent(): maxChildren (${budget.maxChildren}) exceeded for this workflow run`;
      emitRejected(callId, "admission", "max_children", message, { label, agentType, phaseId });
      return { kind: "host_ack", id: callId, ok: false, error: { message } };
    }

    // D2 ③: submission-time BW2 stays an ack failure (the call is rejected
    // outright). A call that runs out of budget while *queued* is withheld
    // instead (→ null, see dispatchQueued) — the documented BW2 asymmetry.
    const derived = deriveNow();
    if (derived.capped === "expired") {
      journalMetaOf.delete(callId);
      const message = "WorkflowBudgetExhausted: no remaining budget to spawn a child (BW2)";
      emitRejected(callId, "admission", "budget_exhausted", message, { label, agentType, phaseId });
      return { kind: "host_ack", id: callId, ok: false, error: { message } };
    }

    const call: QueuedAgentCall = {
      callId,
      prompt: a.prompt,
      agentType,
      ...(label !== undefined ? { label } : {}),
      ...(phaseId !== undefined ? { phaseId } : {}),
    };
    if (phaseId !== undefined) phaseOf.set(callId, phaseId);
    if (label !== undefined) labelOf.set(callId, label);
    agentTypeOf.set(callId, agentType);

    // D2 ④: all maxParallel slots busy — or calls already waiting, so a
    // newcomer never jumps the FIFO — ack now, dispatch later (option C: the
    // same ack-first shape as a replay hit). The ack's `deadlineAt` bounds
    // the worker's `waitForSettle` (BW10 is gone, so it is always finite in
    // production); the host guarantees a settle before then because WT8's
    // `finish` → `stopOwned` withholds every still-queued call.
    if (waitQueue.length > 0 || activeCount() >= budget.maxParallel) {
      const at = deps.clock.now();
      registry.submit(callId, at, { queued: true });
      enqueuedAtOf.set(callId, at);
      waitQueue.push(call);
      deps.onChildEvent?.({
        kind: "queued",
        callId,
        ...(label !== undefined ? { label } : {}),
        agentType,
        ...(phaseId !== undefined ? { phaseId } : {}),
        at,
      });
      return {
        kind: "host_ack",
        id: callId,
        ok: true,
        value: {
          callId,
          ...(deps.workflowDeadlineAt !== undefined ? { deadlineAt: deps.workflowDeadlineAt } : {}),
          queued: true,
        },
      };
    }

    // D2 ⑤: a free slot — the pre-queue immediate path, unchanged (the ack
    // waits for spawn() itself, bounded by HR2).
    registry.submit(callId, deps.clock.now());
    startedAt.set(callId, deps.clock.now());

    const spawned = await deps.spawner.spawn(spawnRequestFor(call, derived));
    if ("error" in spawned) {
      // workflow-agent-queue D7 (single owner): a cancel (phase timeout,
      // stopOwned/terminate, HR2 residual release) may have already settled
      // *and recorded* this call while spawn() was in flight — recording it
      // again here used to produce a second `children[]` entry. Answer with
      // the same cancelled ack the success path's `bind().cancelNow` gives.
      const current = registry.resolve(callId);
      if (current?.phase === "settled") {
        return {
          kind: "host_ack",
          id: callId,
          ok: false,
          cancelled: true,
          cause: current.cancelIntent?.cause ?? "cancelled",
        };
      }
      registry.settle(callId, deps.clock.now());
      journalMetaOf.delete(callId);
      emitRejected(callId, "admission", "spawn_error", spawned.error.message);
      recordSettled({
        callId,
        source: "live",
        status: "withheld",
        durationMs: deps.clock.now() - (startedAt.get(callId) ?? deps.clock.now()),
        ...(phaseId !== undefined ? { phaseId } : {}),
      });
      return { kind: "host_ack", id: callId, ok: false, error: spawned.error };
    }

    const effectiveLabel = spawned.label ?? label;
    const bound = bindSpawned(callId, spawned.runId);
    if (bound.kind === "orphaned") {
      // M3.3 fix (was previously silently dropped): a cancel arrived while
      // this `agent()`'s `spawner.spawn()` call was still in flight, so
      // `CallRegistry` had already (synchronously, on the A1 admission
      // assumption "never spawns") settled this call as withheld. It *did*
      // spawn — `spawned.runId` is a real, running child. `registry.bind()`
      // itself already kicked off a bounded A2-style retry (`retryOrphanAbort`)
      // against it, so there is nothing further to do here beyond skipping the
      // `waitAll()`/`recordSettled` path — the withheld summary for this
      // callId was already recorded when the cancel first landed
      // (`settleUnspawned`/`forceSettleActive`), and recording it again here
      // would duplicate `children[]`.
      return { kind: "host_ack", id: callId, ok: false, cancelled: true, cause: bound.cause };
    }
    if (effectiveLabel !== undefined) labelOf.set(callId, effectiveLabel);
    runBoundChild(callId, spawned.runId, { agentType, phaseId, effectiveLabel });

    return { kind: "host_ack", id: callId, ok: true, value: { callId, deadlineAt: derived.deadlineAt } };
  }

  /** The one `deriveChildBudget` call site — submission-time BW2 precheck and dispatch time alike. */
  function deriveNow(): ReturnType<typeof deriveChildBudget> {
    return deriveChildBudget(
      {
        now: deps.clock.now(),
        policy: budget.childBudgetPolicy,
        ...(deps.workflowDeadlineAt !== undefined ? { workflowDeadlineAt: deps.workflowDeadlineAt } : {}),
        // M3.2: no phase tracking yet (see budget.ts doc) — `phaseDeadlineAt` deliberately omitted.
        ...(budget.childBudgetFraction !== undefined ? { fraction: budget.childBudgetFraction } : {}),
        ...(budget.childTotalMs !== undefined ? { fixedTotalMs: budget.childTotalMs } : {}),
      },
      undefined,
    );
  }

  function spawnRequestFor(
    call: QueuedAgentCall,
    derived: ReturnType<typeof deriveChildBudget>,
  ): Parameters<ChildSpawner["spawn"]>[0] {
    return {
      type: call.agentType,
      prompt: call.prompt,
      ...(call.label !== undefined ? { label: call.label } : {}),
      ...(derived.deadlineAt !== undefined ? { deadlineAt: derived.deadlineAt } : {}),
      ...(deps.parentRunId !== undefined ? { parentRunId: deps.parentRunId } : {}),
      budgetOverride: { totalMs: derived.totalMs, queueWaitMs: derived.queueWaitMs },
    };
  }

  /**
   * Binds a freshly spawned `runId` to its call. `"orphaned"` means the call
   * was already settled by someone else while spawn() was in flight — the
   * real child is being aborted (registry's `retryOrphanAbort`, or the
   * defensive `late_spawn` abort for a settled call that carries no cancel
   * intent) and the caller must not record or settle anything.
   */
  function bindSpawned(callId: CallId, runId: RunId): { kind: "bound" } | { kind: "orphaned"; cause: string } {
    const pre = registry.resolve(callId);
    if (pre?.phase === "settled" && pre.cancelIntent === undefined) {
      void deps.spawner.abort(runId, "late_spawn").catch(() => false);
      return { kind: "orphaned", cause: "late_spawn" };
    }
    const bound = registry.bind(callId, runId);
    if (bound.cancelNow) return { kind: "orphaned", cause: bound.cause ?? "cancelled" };
    return { kind: "bound" };
  }

  /**
   * workflow-agent-queue D4: everything after a successful, non-cancelled
   * bind — shared by the immediate (pre-ack) path and `dispatchQueued`.
   * Announces "spawned" and waits for the child's real outcome in the
   * background (HR3: never awaited by an ack).
   */
  function runBoundChild(
    callId: CallId,
    runId: RunId,
    meta: { agentType: string; phaseId: string | undefined; effectiveLabel: string | undefined },
  ): void {
    const { agentType, phaseId, effectiveLabel } = meta;
    const journal = deps.journal;
    // M10: the child is really running and was not cancelled in the
    // admission window — announce it. Emitted *after* the `cancelNow` check
    // so a call whose withheld settle already fired never produces a
    // spawned-after-settled ordering inversion for observers.
    deps.onChildEvent?.({
      kind: "spawned",
      callId,
      runId,
      ...(effectiveLabel !== undefined ? { label: effectiveLabel } : {}),
      agentType,
      ...(phaseId !== undefined ? { phaseId } : {}),
      at: deps.clock.now(),
    });

    const onOutcome = (outcome: ChildOutcome | undefined): void => {
      // Single owner (D6): stopOwned()/onTerminating may already have
      // force-settled (and recorded) this call as aborted; the child's real
      // outcome arriving afterwards must not produce a second record/settle.
      if (registry.resolve(callId)?.phase === "settled") return;
      registry.settle(callId, deps.clock.now());
      const durationMs = deps.clock.now() - (startedAt.get(callId) ?? deps.clock.now());
      if (!outcome) {
        // The spawner never settled this run (e.g. it was already gone by
        // the time waitAll looked it up) — report it honestly rather than hang.
        journalMetaOf.delete(callId); // never journaled (RP3: not a success).
        recordSettled({
          callId,
          runId,
          source: "live",
          status: "aborted",
          durationMs,
          ...(phaseId !== undefined ? { phaseId } : {}),
        });
        deps.workerHost.send({
          kind: "host_settle",
          callId,
          ok: false,
          error: { message: "child run did not settle" },
        } satisfies HostSettleEnvelope);
        return;
      }
      recordSettled({
        callId,
        runId: outcome.runId,
        source: "live",
        status: outcome.status,
        durationMs,
        ...(outcome.text !== undefined ? { textPreview: outcome.text.slice(0, 2048) } : {}),
        ...(phaseId !== undefined ? { phaseId } : {}),
      });
      // M3.5 RP3 (§6.4): only a *successful* live settle is ever journaled —
      // failed/aborted/timed-out children never get an entry, matching the
      // upstream plugin's "journaled failure ends the prefix" invariant
      // (§6.1) at the per-entry granularity `chain`/`content` scope already
      // gives us. `append()` is fire-and-forget (JS1) — never awaited here,
      // so a slow/failing disk cannot delay this settle push to the worker.
      if (journal && outcome.status === "completed") {
        const jm = journalMetaOf.get(callId);
        if (jm) {
          journal.store.append(
            journal.dir,
            buildEntry({
              scope: journal.scope,
              key: jm.taskKey,
              chainDigestBefore: jm.chainDigestBefore,
              occurrence: jm.occurrence,
              agentType: jm.agentType,
              ...(jm.isolation !== undefined ? { isolation: jm.isolation } : {}),
              value: outcome.text ?? null,
              completedAt: deps.clock.now(),
              durationMs,
            }),
          );
        }
      }
      journalMetaOf.delete(callId);
      const settleMsg: HostSettleEnvelope =
        outcome.status === "completed"
          ? {
              kind: "host_settle",
              callId,
              ok: true,
              value: outcome.text ?? null,
              ...(outcome.usage?.output !== undefined ? { outputTokens: outcome.usage.output } : {}),
              runId: outcome.runId,
              ...(effectiveLabel !== undefined ? { label: effectiveLabel } : {}),
            }
          : { kind: "host_settle", callId, ok: false, error: outcome.error ?? { message: `child ${outcome.status}` } };
      deps.workerHost.send(settleMsg);
    };
    // HR3: fire the settle wait in the background. A rejecting waitAll() is
    // treated like "did not settle" — it must never leave the call holding a
    // maxParallel slot (and the FIFO queue stalled behind it) forever.
    void deps.spawner.waitAll({ runIds: [runId] }).then(
      ({ settled }) => onOutcome(settled[0]),
      () => onOutcome(undefined),
    );
  }

  /**
   * workflow-agent-queue D5: dispatch a call that was acked as queued and
   * has just been admitted by `pump()`. Only a `host_settle` is left to send.
   * Every async exit is guarded by the single-owner rule: a continuation acts
   * only if *it* flips the call (`registry.cancel()` → `"withheld"`, or a
   * successful bind); otherwise someone else already recorded it.
   *
   * Deliberately **no** `withDeadline` around spawn() (review v1 Blocker-1):
   * the spawn promise keeps its own continuation, so a late runId always
   * reaches `registry.bind` → `cancelNow` → orphan abort instead of being
   * dropped by a timed-out race. The timeout is a separate timer.
   */
  function dispatchQueued(call: QueuedAgentCall): void {
    const { callId } = call;
    const now = deps.clock.now();
    queueWaitOf.set(callId, now - (enqueuedAtOf.get(callId) ?? now));
    startedAt.set(callId, now);

    const derived = deriveNow();
    if (derived.capped === "expired") {
      // Out of time while queued: withheld → null, not rejected (user decision
      // 2; from stage B on only seen when the workflow itself is about to time out).
      if (registry.cancel(callId, "budget_exhausted") === "withheld") {
        settleUnspawned(callId, { cause: "budget_exhausted", message: "workflow deadline reached while queued" });
      }
      return;
    }

    const spawnTimeoutMs = Math.max(1, Math.min(budget.hostCallMs, remainingWorkflowMs()));
    const timer = deps.clock.setTimer(spawnTimeoutMs, () => {
      spawnTimers.delete(callId);
      if (registry.resolve(callId)?.phase !== "admission") return;
      if (registry.cancel(callId, "spawn_timeout") === "withheld") {
        settleUnspawned(callId, {
          cause: "spawn_timeout",
          message: `spawn did not complete within ${spawnTimeoutMs}ms`,
          rejected: { stage: "dispatch", reason: "spawn_timeout" },
        });
      }
    });
    spawnTimers.set(callId, timer);
    const clearSpawnTimer = (): void => clearSpawnTimerOf(callId);

    let sp: Promise<ChildSpawnResult | ChildSpawnError>;
    try {
      sp = Promise.resolve(deps.spawner.spawn(spawnRequestFor(call, derived)));
    } catch (e) {
      sp = Promise.reject(e);
    }
    const onSpawned = (r: ChildSpawnResult | ChildSpawnError): void => {
      clearSpawnTimer();
      if ("error" in r) {
        if (registry.cancel(callId, "spawn_error") === "withheld") {
          settleUnspawned(callId, {
            cause: "spawn_error",
            message: r.error.message,
            rejected: { stage: "dispatch", reason: "spawn_error" },
          });
        }
        return;
      }
      const effectiveLabel = r.label ?? call.label;
      if (bindSpawned(callId, r.runId).kind === "orphaned") return;
      if (effectiveLabel !== undefined) labelOf.set(callId, effectiveLabel);
      runBoundChild(callId, r.runId, { agentType: call.agentType, phaseId: call.phaseId, effectiveLabel });
    };
    // Review v2 #4: `onSpawnThrew` is the error branch of `onSpawned`.
    const onSpawnThrew = (e: unknown): void => {
      clearSpawnTimer();
      if (registry.resolve(callId)?.phase === "settled") return;
      if (registry.cancel(callId, "spawn_error") === "withheld") {
        settleUnspawned(callId, {
          cause: "spawn_error",
          message: errMsg(e),
          rejected: { stage: "dispatch", reason: "spawn_error" },
        });
      }
    };
    void sp.then(onSpawned, onSpawnThrew).catch((e: unknown) => {
      // A throwing observer (onChildEvent/onChildSettled) must not become an
      // unhandled rejection in the host process.
      console.warn(`[pi-subagent] workflow agent() dispatch continuation failed: ${errMsg(e)}`);
    });
  }

  /**
   * workflow-agent-queue D3: dispatch queued calls FIFO while slots are free.
   * Synchronous; re-entrant calls (a dispatch that settles synchronously →
   * `recordSettled` → `pump`) are folded into the running loop.
   */
  function pump(): void {
    if (pumping) return;
    pumping = true;
    try {
      while (!terminated && waitQueue.length > 0 && activeCount() < budget.maxParallel) {
        const next = waitQueue.shift()!;
        if (!registry.admit(next.callId)) continue; // withheld while waiting — already recorded.
        dispatchQueued(next);
      }
    } finally {
      pumping = false;
    }
  }

  async function handleGate(callId: CallId, args: unknown): Promise<HostAckEnvelope> {
    const a = args as { cmd?: unknown; cwd?: unknown };
    if (typeof a.cmd !== "string") {
      return { kind: "host_ack", id: callId, ok: false, error: { message: "gate(cmd, opts?): cmd must be a string" } };
    }
    const timeoutMs = Math.min(budget.gateMs, remainingWorkflowMs());
    if (timeoutMs <= 0) {
      return {
        kind: "host_ack",
        id: callId,
        ok: false,
        error: { message: "WorkflowBudgetExhausted: no remaining workflow budget for gate()" },
      };
    }
    try {
      const result = await deps.gateRunner(a.cmd, {
        ...(typeof a.cwd === "string" ? { cwd: a.cwd } : {}),
        timeoutMs,
      });
      return { kind: "host_ack", id: callId, ok: true, value: result };
    } catch (e) {
      return { kind: "host_ack", id: callId, ok: false, error: { message: errMsg(e) } };
    }
  }

  deps.workerHost.events.onHostCall((envelope: HostCallEnvelope) => {
    if (terminated) {
      // Defense-in-depth, not the primary mechanism: once `terminate()`'s S5
      // has actually closed the host's end of the port (§2.3.1/WC09), a
      // message like this one can never be delivered here at all — this
      // branch only matters for the vanishingly narrow synchronous window
      // between `onTerminating` firing (S2) and S5 running, during which no
      // message delivery can happen anyway (JS has no preemption). Kept
      // anyway so a future refactor that widens that window fails safe
      // instead of silently answering a call from a workflow that already
      // decided to stop.
      deps.workerHost.send({
        kind: "host_ack",
        id: envelope.id,
        ok: false,
        cancelled: true,
        cause: "workflow_terminating",
      } satisfies HostAckEnvelope);
      return;
    }
    // HR2: every handler is double-sided-bounded — `hostCallMs` for `agent`'s
    // admission-only ack, `gateMs` for `gate`'s single-segment RPC — capped
    // by whatever workflow budget remains (never lets a handler outlive WT8).
    const opBudgetMs = envelope.op === "gate" ? budget.gateMs : budget.hostCallMs;
    const boundMs = Math.min(opBudgetMs, remainingWorkflowMs());
    // BW2: a workflow with zero (or negative) remaining budget is a distinct,
    // more specific condition than "the handler ran out of time" — report it
    // as such instead of letting `withDeadline(work, 0, ...)`'s ms<=0 fast
    // path win the race against `work` before it ever gets to run its own
    // BW2 check (core/deadline.ts's `withDeadline` resolves synchronously for
    // ms<=0 and only fires `p.catch()` on the real promise, discarding
    // whatever answer it would have produced).
    if (boundMs <= 0) {
      const message = "WorkflowBudgetExhausted: no remaining workflow budget to service this host call (BW2)";
      if (envelope.op === "agent") {
        emitRejected(envelope.id, "admission", "budget_exhausted", message, displayMetaOfArgs(envelope.args));
      }
      deps.workerHost.send({
        kind: "host_ack",
        id: envelope.id,
        ok: false,
        error: { message },
      } satisfies HostAckEnvelope);
      return;
    }
    const work =
      envelope.op === "agent" ? handleAgent(envelope.id, envelope.args) : handleGate(envelope.id, envelope.args);
    void withDeadline(work, boundMs, deps.clock, `host_call:${envelope.op}`).then((r) => {
      if (terminated) return; // avoid a duplicate ack racing the terminate()-driven one below.
      if (r.ok) {
        deps.workerHost.send(r.value);
        return;
      }
      const message =
        r.reason === "timeout"
          ? `host call '${envelope.op}' did not complete within ${boundMs}ms (HR2)`
          : r.error.message;
      deps.workerHost.send({
        kind: "host_ack",
        id: envelope.id,
        ok: false,
        error: { message },
      } satisfies HostAckEnvelope);
      // workflow-agent-queue D8: the ack above answers the worker, but the
      // admission itself used to stay in `admission` until spawn() finally
      // returned (or forever, if it threw) — occupying a maxParallel slot the
      // whole time. Release it now: withhold + record it here (single owner);
      // a late spawn then binds against a settled-with-intent call and goes
      // through the orphan-abort path (`registry.bind` → `retryOrphanAbort`).
      if (envelope.op === "agent" && registry.resolve(envelope.id) !== undefined) {
        // A spawn() that *threw* is a spawn error, not a timeout.
        const reason: WorkflowChildRejectReason = r.reason === "timeout" ? "host_call_timeout" : "spawn_error";
        if (registry.cancel(envelope.id, reason) === "withheld") {
          settleUnspawned(envelope.id, { cause: reason, message, rejected: { stage: "admission", reason } });
        }
      }
    });
  });

  // HR8: on terminate() (S2, before S5/S6 physically cut the port), reject
  // every call this host still has pending — both "ack never sent" (still in
  // admission, e.g. `spawner.spawn` hung) and "ack sent, settle never
  // pushed" (child still running when the workflow ended). `registry.cancel()`
  // on an active (pre_runner/running) call only *starts* the A2 bounded
  // retry loop — it deliberately does not settle the call synchronously
  // (CR7: that loop must not be forced to resolve instantly in the general
  // case). HR8 is a stronger requirement than CR7: once the *workflow itself*
  // is terminating, nothing may be left pending — so this handler explicitly
  // force-settles every still-active call the instant `terminate()` fires,
  // instead of waiting for the (now-moot, since the workflow is over) retry
  // loop to eventually give up on its own on the `cancelRetryWindowMs` clock.
  deps.workerHost.events.onTerminating((reason) => {
    if (terminated) return; // WL3 after WL1/WL2 already ran via stopOwned() — everything is settled, avoid double-recording.
    terminated = true;
    clearAllPhaseTimers(); // WR4-equivalent: no armed timer may survive the workflow's own terminal decision.
    const cancelled = registry.cancelAll(reason);
    waitQueue.length = 0; // D9: every queued call was just withheld by cancelAll.
    for (const callId of cancelled.withheld) {
      settleUnspawned(callId, { cause: reason, message: `workflow terminating (${reason})` });
    }
    for (const callId of cancelled.retrying) forceSettleActive(callId, reason);
  });

  return {
    registry,
    get children() {
      return children;
    },
    get currentPhaseId() {
      return currentPhaseId;
    },
    get replayStats(): WorkflowReplayStats | undefined {
      if (!deps.journal) return undefined;
      return {
        hits: replayStats.hits,
        misses: replayStats.misses,
        skipped: replayStats.skipped,
        corruptLines: deps.journal.index.stats.corruptLines,
      };
    },
    cancelAllChildren(cause) {
      const cancelled = registry.cancelAll(cause);
      waitQueue.length = 0;
      for (const callId of cancelled.withheld) {
        settleUnspawned(callId, { cause, message: `workflow terminating (${cause})` });
      }
    },
    async stopOwned(cause, graceMs) {
      if (terminated) return { orphanChildren: [] }; // idempotent (WI6): a prior stopOwned()/terminate() already ran.
      // WL1: close the gate *synchronously*, before anything else — no new
      // agent()/gate() admission can land after this point (onHostCall checks
      // the same `terminated` flag).
      terminated = true;
      clearAllPhaseTimers(); // same WR4-equivalent hygiene as onTerminating above.
      // WL2: cascade-cancel every still-active call (CallRegistry's bounded
      // retry loop +, if the caller supplied one, the core's own owner-stop
      // sweep — OS4).
      const cancelled = registry.cancelAll(cause);
      waitQueue.length = 0; // D9: every queued call was just withheld by cancelAll.
      for (const callId of cancelled.withheld) {
        settleUnspawned(callId, { cause, message: `workflow terminating (${cause})` });
      }
      if (deps.spawner.stopChildrenOf && deps.parentRunId !== undefined) {
        try {
          await deps.spawner.stopChildrenOf(deps.parentRunId, cause);
        } catch {
          // Best-effort sweep (OS4) — CallRegistry's own per-call retry loop
          // (already started by cancelAll above) is the real safety net.
        }
      }
      // WT10 abortGraceMs: give still-active children a real chance to
      // settle for real (their own `handleAgent().then()` callback calls
      // `registry.settle`/`recordSettled` with the true outcome, which wakes
      // this wait immediately via `drainWaiters`) before WL4 gives up on
      // them. Bounded by a single timer — not polled.
      if (registry.listActive().length > 0) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const timer = deps.clock.setTimer(Math.max(0, graceMs), () => {
            if (settled) return;
            settled = true;
            resolve();
          });
          drainWaiters.push(() => {
            if (settled) return;
            settled = true;
            deps.clock.clearTimer(timer);
            resolve();
          });
        });
      }
      // WL4 (reconcile, inline): anything still active after the grace window
      // is force-settled and reported as orphaned (RC3) rather than left
      // dangling in `children[]` with a non-terminal status (RC1).
      const orphanChildren: OrphanChildSummary[] = [];
      for (const active of registry.listActive()) {
        forceSettleActive(active.callId, cause);
        orphanChildren.push({
          callId: active.callId,
          ...(active.runId !== undefined ? { runId: active.runId } : {}),
          reason: "cancel_retry_exhausted",
          at: deps.clock.now(),
        });
      }
      return { orphanChildren };
    },
    async flushJournal(deadlineMs) {
      if (!deps.journal) return undefined;
      return deps.journal.store.flush(deps.journal.dir, deadlineMs);
    },
  };
}
