/**
 * fabric-thread P1 (arch r3 §5–§6): `ThreadEngine` — the agent-side pure-logic orchestrator for
 * thread subscription fast-path routing. Everything the fast path decides, it decides HERE; P3
 * only wires host facts in (run registry, hub link, prompt-release path) and host effects out.
 *
 * Ownership map (all per-instance, I4; every timer goes through the injected Clock — the P3
 * adapter must unref, I5):
 *   - §5 lifecycle: subscribe/unsubscribe/handback admission, eager terminal cleanup
 *     (`onRunSnapshot`), lazy pre-route re-validation, `onRunReaped` fallback, `dispose`
 *     (stack_disposed + generation bump), frozen terminal summaries (`threadSummary`).
 *   - §6 routing: the R0–R7 decision table, per-thread lanes (在途 1 / 等待 laneWait), per-run
 *     serial gates (在途 1 / 等待 4), absolute deadlines (ONE `deadlineAt` for lane wait +
 *     per-run wait + steer), buffers (≤4 events / ≤32 KiB / startTimeoutMin TTL) and the §6.5
 *     first-running flush.
 *   - §6.7 aggregation: first reply (routed ⇔ any observed outcome; all-none ⇔ release to the
 *     native path), system auto-return (ONLY when every subscriber is `none` — at most once per
 *     event, never while any `queued`/`unknown`), dedup via the EventRecord slot.
 *
 * Safety spine (G4 / r3-3): the engine NEVER falls back or auto-returns for a subscriber whose
 * steer was actually CALLED — those outcomes are `queued`/`unknown`, and only the hub's handback
 * channel may re-deliver (`by:"system"`), at most once per event.
 */
import type { Clock, TimerHandle } from "../../core/clock.js";
import { isTerminalStatus } from "../../core/status.js";
import type { RunStatus } from "../../core/types.js";
import { THREAD_SUBS_MAX, type ThreadCloseReason } from "../../web-hub/protocol/thread.js";
import type { Outcome, ThreadEngineSettings, ThreadEventId, ThreadHandle, ThreadRunId, ThreadStats } from "./types.js";
import { DEFAULT_THREAD_ENGINE_SETTINGS, THREAD_ROUTED_WINDOW_MS } from "./types.js";
import { ThreadDirectory } from "./directory.js";
import { computeEventDeadline, remainingBudgetMs } from "./deadline.js";
import { decideRoute, type RouteDecision } from "./decision.js";
import { aggregateFirstReply, autoReturnDecision, canTransitionOutcome, outcomeForDisposition } from "./outcome.js";
import { RunGate, ThreadLane, type RunSteerTask } from "./lane.js";
import { EventRecordTable, type EventRecord } from "./records.js";
import { SubscriptionRegistry, deliveryModeForFacts, type SubscribeResult } from "./subscriptions.js";

// --------------------------------------------------------------------- host contract

export interface ThreadEngineDeps {
  clock: Clock;
  /** engine-relevant `fabric.threads.*` leaves (P0-clamped upstream); defaults = §11.1 P0. */
  settings?: Partial<ThreadEngineSettings>;
  /** §5.1/§6.4 run facts — resolved per call by the P3 wiring from the run registry. */
  runFacts(runId: ThreadRunId): ThreadRunFactsLike | undefined;
  /** §5.1/§5.5: hub online ∧ hello_ack.caps ∋ thr.v1. */
  hubCapable(): boolean;
  /** §6.4 `QueryService.steerThread` — the HOST adapter enforces `capMs` (single-call ceiling);
   *  resolves with the pi QueuedInputDisposition string, or rejects. */
  steerThread(runId: ThreadRunId, text: string, capMs: number): Promise<string>;
  /** §6.7 routed first reply — the source of `cmd_result.data.thread`. */
  replyRouted(eventId: ThreadEventId, runs: ReadonlyArray<{ runId: string; label: string }>): void;
  /** §6.7 all-none first reply: re-dispatch through the prompt-release path
   *  (`createPromptRelease().current()`) — the caller RE-CHECKS and re-dispatches on the spot;
   *  `false` = the re-check refused (session moved on) and NOTHING was dispatched: the engine
   *  then owes the hub an `E_STALE_CTX{effect:"none"}` reply via {@link ThreadEngineDeps.replyStaleCtx}. */
  releaseToNative(eventId: ThreadEventId): boolean;
  /** §6.7 system auto-return (`thr_req{op:"handback", by:"system"}`) — at most once per event. */
  requestAutoReturn(eventId: ThreadEventId): void;
  /** `E_STALE_CTX{retryable:true, effect:"none"}` reply channel: used at dispose for events
   *  that were never replied and never called a subscriber, AND whenever a native release is
   *  refused (§6.7 复检失败) — the engine owns the decision, the adapter only sends the frame. */
  replyStaleCtx(eventId: ThreadEventId): void;
  /** display-only line (§6.7 主会话可见性 — appendEntry("subagent:thread") source). */
  display(line: string): void;
  /** §6.3 R4 display hint (≤ 1/hour/thread). */
  hint(line: string): void;
  /** §6.5 晚到结果 / anomaly sink — audit only, never changes a sent reply. */
  audit(entry: Record<string, unknown>): void;
}

/** Re-exported shape so P3 can import one type from the engine module. */
export type ThreadRunFactsLike = import("./types.js").ThreadRunFacts;

export interface ThreadEventInput {
  eventId: ThreadEventId;
  h: ThreadHandle;
  label: string;
  sentAt: number;
  /** §4.2 `isFeishuCmdOrigin(frame.origin)`. */
  trustedOrigin: boolean;
  hasThreadMeta: boolean;
  threadMetaValid: boolean;
  /** §6.2 first line strictly matches the hub header. */
  headerOk: boolean;
  /** §7.2 `bypass:true` ⇒ R1. */
  bypass: boolean;
  /** §6.2 addressing guard hit `addressed_other` ⇒ R3. */
  addressedOther: boolean;
  frameDeadlineMs: number;
  /** §9.1 encapsulated wrapper text (P3 builds it) — buffer bytes + steer payload. */
  text: string;
}

export type HandleEventResult =
  | { action: "native"; decision: RouteDecision }
  | { action: "lane"; deadlineAt: number }
  | {
      action: "deduped";
      eventId: ThreadEventId;
      replied: boolean;
      replyKind: "routed" | "fallback" | undefined;
    };

export type HandbackAdmission =
  | { ok: true; subId: string }
  | { ok: false; reason: "event_unknown" | "not_delivered" | "window_expired" | "sub_ended" | "hub_unsupported" };

/** §5.3 ① frozen terminal summary — read ONCE by the notifier, then deleted. */
export interface FrozenThreadSummary {
  runId: ThreadRunId;
  subs: number;
  routed: number;
  replies: number;
  handbacks: number;
  endedAt: number;
}

const SUMMARY_FREEZE_MAX = 64;
const SUMMARY_FREEZE_TTL_MS = 30 * 60_000;

/** One steer in flight (lane phase or flush phase) — runtime wrapper around the gate task. */
interface SteerRuntime {
  readonly task: RunSteerTask;
  /** the exact text to steer — travels with the task (the ActiveEvent may already be dropped). */
  readonly text: string;
  capMs: number;
  called: boolean;
  settled: boolean;
  /** flush path: no frame deadline, single-call cap = steerTimeoutMs (§6.5). */
  readonly flushed: boolean;
  backstop: TimerHandle | undefined;
  readonly gen: number;
}

/** Per-event runtime while the fast path still owns it (lane wait / fan-out). */
interface ActiveEvent {
  readonly record: EventRecord;
  readonly h: ThreadHandle;
  /** §3.1 ThreadEvent.sentAt (= the request's sourceCreatedAt) — rides along for the buffer. */
  readonly sentAt: number;
  /** §9.1 wrapper text — the payload every lane-phase steer of this event uses. */
  readonly text: string;
  phase: "lane_wait" | "fanout";
  /** §6.5 dispatch complete in the custody sense: every live subscriber took a terminal outcome
   *  or a buffer slot, and no lane-phase gate task is pending. */
  dispatchDone: boolean;
  pendingTasks: number;
  deadlineTimer: TimerHandle | undefined;
}

function steerKey(eventId: string, subId: string): string {
  return `${eventId}\u0000${subId}`;
}

// --------------------------------------------------------------------- engine

export class ThreadEngine {
  readonly settings: ThreadEngineSettings;
  readonly directory = new ThreadDirectory();
  private readonly registry = new SubscriptionRegistry();
  private readonly records: EventRecordTable;
  private readonly lanes = new Map<ThreadHandle, ThreadLane>();
  private readonly gates = new Map<ThreadRunId, RunGate>();
  private readonly active = new Map<ThreadEventId, ActiveEvent>();
  private readonly steers = new Map<string, SteerRuntime>();
  private readonly hourly = new Map<ThreadHandle, number[]>();
  private readonly lastHintAt = new Map<ThreadHandle, number>();
  private readonly bufferTimers = new Map<string, TimerHandle>();
  private readonly seenRunning = new Set<ThreadRunId>();
  private readonly summaries = new Map<ThreadRunId, FrozenThreadSummary>();
  private readonly statsValue: ThreadStats = {
    activeSubs: 0,
    routed: 0,
    slow: 0,
    laneFull: 0,
    budget: 0,
    laneTimeout: 0,
    handback: 0,
    unknown: 0,
    deduped: 0,
    autoReturned: 0,
    disposed: false,
  };
  private generation = 0;
  private disposedFlag = false;
  private subSeq = 0;

  constructor(private readonly deps: ThreadEngineDeps) {
    this.settings = { ...DEFAULT_THREAD_ENGINE_SETTINGS, ...deps.settings };
    this.records = new EventRecordTable(64, this.settings.handbackWindowMin * 60_000);
  }

  // ------------------------------------------------------------------ §3.1 directory

  /** P3 calls this on every valid thread-bearing frame (hub-driven recency). */
  noteThread(h: ThreadHandle, label: string): void {
    if (this.disposedFlag) return;
    this.directory.note(h, label, this.deps.clock.now());
  }

  // ------------------------------------------------------------------ §5.1 admission

  subscribe(input: {
    runId: ThreadRunId;
    h: ThreadHandle;
    label: string;
    scope: string;
    createdBy: "root" | "human";
  }): SubscribeResult {
    if (this.disposedFlag) return { ok: false, reason: "hub_unsupported" };
    const result = this.registry.subscribe(input, {
      now: this.deps.clock.now(),
      settings: this.settings,
      directory: {
        state: (h) => {
          const entry = this.directory.get(h);
          if (!entry) return "unknown" as const;
          return entry.closed ? ("closed" as const) : ("open" as const);
        },
      },
      runFacts: this.deps.runFacts,
      hubCapable: this.deps.hubCapable,
      newSubId: () => `t${++this.subSeq}`,
    });
    this.statsValue.activeSubs = this.registry.activeCount();
    return result;
  }

  /** §5.5 `thread(action:"unsubscribe")` — ends the sub; buffered events each record `none`. */
  unsubscribe(subId: string): { ok: true } | { ok: false; reason: "sub_ended" | "unknown_sub" } {
    if (this.disposedFlag) return { ok: false, reason: "sub_ended" };
    const existing = this.registry.get(subId);
    if (!existing) return { ok: false, reason: "unknown_sub" };
    const sub = this.registry.end(subId, "unsubscribed", this.deps.clock.now());
    if (!sub) return { ok: false, reason: "sub_ended" };
    this.drainBufferAsNone(sub, "unsubscribed");
    this.statsValue.activeSubs = this.registry.activeCount();
    return { ok: true };
  }

  /** §6.8 counter feed — P3 calls this when a Worker `thread(action:"reply")` post is accepted. */
  recordReply(subId: string): void {
    const sub = this.registry.get(subId);
    if (sub) sub.replies++;
  }

  // ------------------------------------------------------------------ §5.4 thread close

  /** `thr_closed{h, reason}` — returns the affected subscribers so P3 can steer the 解绑 notices. */
  threadClosed(h: ThreadHandle, _reason: ThreadCloseReason): Array<{ runId: ThreadRunId; label: string }> {
    this.directory.close(h);
    const affected: Array<{ runId: ThreadRunId; label: string }> = [];
    for (const sub of this.registry.activeSubsOfThread(h)) {
      const sub2 = this.registry.end(sub.subId, "thread_closed", this.deps.clock.now());
      if (sub2) {
        this.drainBufferAsNone(sub2, "thread_closed");
        affected.push({ runId: sub2.runId, label: sub2.label });
      }
    }
    // events of this thread still waiting in its lane re-validate lazily at dispatch
    this.statsValue.activeSubs = this.registry.activeCount();
    return affected;
  }

  // ------------------------------------------------------------------ §6.1 the decision point

  handleEvent(input: ThreadEventInput): HandleEventResult {
    if (this.disposedFlag) {
      return { action: "native", decision: { rule: "R0", route: "native", reason: "feature_off" } };
    }
    const now = this.deps.clock.now();
    // §5.3 lazy validation (最后一道兜底): end subs whose run already reached a terminal state
    // (or vanished from the registry) BEFORE computing R2.
    this.lazyValidateThread(input.h, now);

    const lane = this.laneFor(input.h);
    const decision = decideRoute({
      featureEnabled: true, // the engine exists only while the feature is on (P3 constructs none otherwise)
      trustedOrigin: input.trustedOrigin,
      hasThreadMeta: input.hasThreadMeta,
      threadMetaValid: input.threadMetaValid,
      headerOk: input.headerOk,
      bypass: input.bypass,
      hasLiveSubscriber: this.registry.activeSubsOfThread(input.h).length > 0,
      addressedOther: input.addressedOther,
      hourlyCapReached: this.hourlyCount(input.h, now) >= this.settings.routedPerThreadPerHour,
      laneWaitFull: !lane.canAccept(),
      recordsFull: !this.records.canInsert(now),
      steerTimeoutMs: this.settings.steerTimeoutMs,
      frameDeadlineMs: input.frameDeadlineMs,
    });
    if (decision.rule === "R7") {
      // §6.5 dedup slot first — the SAME synchronous step as lane entry.
      const existing = this.records.get(input.eventId);
      if (existing) {
        this.statsValue.deduped++;
        return {
          action: "deduped",
          eventId: input.eventId,
          replied: existing.replied,
          replyKind: existing.replyKind,
        };
      }
      const deadline = computeEventDeadline(now, this.settings.steerTimeoutMs, input.frameDeadlineMs);
      if (deadline === undefined) {
        // unreachable — decideRoute ran R6 on the same inputs one tick earlier; defensive guard
        this.statsValue.budget++;
        return { action: "native", decision: { rule: "R6", route: "native", reason: "budget_invalid" } };
      }
      const record = this.records.insert(input.eventId, input.h, now, deadline.deadlineAt, now);
      if (record === undefined) {
        this.statsValue.laneFull++;
        return { action: "native", decision: { rule: "R5", route: "native", reason: "records_full" } };
      }
      if (!lane.enqueue(input.eventId)) {
        // same-tick race guard (decideRoute just said not full)
        this.statsValue.laneFull++;
        return { action: "native", decision: { rule: "R5", route: "native", reason: "lane_wait_full" } };
      }
      const event: ActiveEvent = {
        record,
        h: input.h,
        sentAt: input.sentAt,
        text: input.text,
        phase: "lane_wait",
        dispatchDone: false,
        pendingTasks: 0,
        deadlineTimer: this.deps.clock.setTimer(deadline.span, () => this.onDeadline(input.eventId)),
      };
      this.active.set(input.eventId, event);
      this.pumpLane(input.h);
      return { action: "lane", deadlineAt: deadline.deadlineAt };
    }
    switch (decision.rule) {
      case "R2":
        this.statsValue.slow++;
        break;
      case "R4":
        this.maybeHint(input.h, now);
        break;
      case "R5":
        this.statsValue.laneFull++;
        break;
      case "R6":
        this.statsValue.budget++;
        break;
      default:
        break; // R0/R1/R3: no counter — the native path stays untouched
    }
    return { action: "native", decision };
  }

  // ------------------------------------------------------------------ §5.3 cleanup hooks

  /** Eager hook at `stack.ts` onSnapshot — first-running flush; terminal freeze + cleanup.
   *  `stopping` needs no action (pre-call `none` via the facts check; §5.3). */
  onRunSnapshot(runId: ThreadRunId, status: RunStatus | string): void {
    if (this.disposedFlag) return;
    const now = this.deps.clock.now();
    if (status === "running" && !this.seenRunning.has(runId)) {
      this.seenRunning.add(runId);
      this.flushRun(runId);
      return;
    }
    if (isTerminalStatus(status as RunStatus)) {
      this.seenRunning.delete(runId);
      this.onRunTerminal(runId, String(status), now);
    }
  }

  /** Physical-reaping fallback (stack.ts onReaped) — ONLY leftovers (§5.3). */
  onRunReaped(runId: ThreadRunId): void {
    if (this.disposedFlag) return;
    const now = this.deps.clock.now();
    this.cancelGateTasks(runId, () => true);
    for (const sub of this.registry.activeSubsOfRun(runId)) {
      const ended = this.registry.end(sub.subId, "stale", now);
      if (ended) this.drainBufferAsNone(ended, "reaped");
    }
    this.seenRunning.delete(runId);
    this.statsValue.activeSubs = this.registry.activeCount();
  }

  /** §5.3 stack 销毁 / §9.4 C4 — lanes closed, subs ended, generation advanced; NO auto-return. */
  dispose(): void {
    if (this.disposedFlag) return;
    this.disposedFlag = true;
    this.statsValue.disposed = true;
    this.generation++;
    const now = this.deps.clock.now();
    const events = [...this.active.values()];
    // ① deadline timers off; lane-phase steers settle NOW — uncalled ⇒ none (safe fallback),
    //    called-but-unsettled ⇒ unknown (§6.5). A settle with every OTHER outcome determined
    //    fires firstReply right here (routed ⇔ some observed, or fallback ⇒ E_STALE_CTX below).
    //    Flush steers are left to the generation bump (audit-only discard).
    for (const event of events) {
      if (event.deadlineTimer !== undefined) this.deps.clock.clearTimer(event.deadlineTimer);
      for (const steer of [...this.steers.values()]) {
        if (steer.task.eventId !== event.record.eventId || steer.flushed) continue;
        this.finishSteer(steer, steer.called ? "unknown" : "none", "disposed");
      }
    }
    // ② end every subscription (stack_disposed) and sweep its buffer — buffered ⇒ none. This is
    //    what makes a MIXED event (called steer + still-buffered subscriber) judgeable below.
    for (const handle of this.bufferTimers.values()) this.deps.clock.clearTimer(handle);
    this.bufferTimers.clear();
    for (const sub of this.registry.all()) {
      if (sub.state !== "active") continue;
      const ended = this.registry.end(sub.subId, "stack_disposed", now);
      if (ended) this.drainBufferAsNone(ended, "disposed");
    }
    // ③ §6.5 “已有调用的事件按当时的聚合结果回复”： every still-unreplied event replies per
    //    its CURRENT aggregate — a called steer (unknown) ⇒ routed; all-none (nobody was ever
    //    called) ⇒ firstReply's disposed fallback replies E_STALE_CTX. Auto-return stays
    //    suppressed (§9.4 C4).
    for (const event of events) {
      if (!event.record.replied) this.firstReply(event, now);
    }
    this.active.clear();
    this.statsValue.activeSubs = 0;
  }

  /** §5.3 ① — frozen terminal summary, read once (notifier), TTL 30 min, table ≤ 64. */
  threadSummary(runId: ThreadRunId): FrozenThreadSummary | undefined {
    const now = this.deps.clock.now();
    for (const [id, s] of this.summaries) {
      if (now - s.endedAt > SUMMARY_FREEZE_TTL_MS) this.summaries.delete(id);
    }
    const s = this.summaries.get(runId);
    if (s === undefined) return undefined;
    this.summaries.delete(runId);
    return s;
  }

  // ------------------------------------------------------------------ §5.5 handback (agent-side admission)

  /** The THREE local rules only (r3-7): delivered to THIS run, inside H from deliveredAt, sub
   *  ACTIVE ∧ hub cap. Whether the hub still retains the original is the hub's call (§8.3). */
  requestHandback(input: { runId: ThreadRunId; eventId: ThreadEventId }): HandbackAdmission {
    if (this.disposedFlag) return { ok: false, reason: "sub_ended" };
    const record = this.records.get(input.eventId);
    if (!record) return { ok: false, reason: "event_unknown" };
    const sub = this.registry.activeByRunAndThread(input.runId, record.h);
    if (!sub) return { ok: false, reason: "sub_ended" };
    const outcome = record.perSub.get(sub.subId);
    if (outcome !== "queued" && outcome !== "unknown") return { ok: false, reason: "not_delivered" };
    const now = this.deps.clock.now();
    if (record.deliveredAt === undefined || now > record.deliveredAt + this.settings.handbackWindowMin * 60_000) {
      return { ok: false, reason: "window_expired" };
    }
    if (!this.deps.hubCapable()) return { ok: false, reason: "hub_unsupported" };
    const ended = this.registry.end(sub.subId, "handback", now);
    if (!ended) return { ok: false, reason: "sub_ended" };
    this.drainBufferAsNone(ended, "handback");
    record.handback = "pending";
    ended.handbacks++;
    this.statsValue.handback++;
    this.statsValue.activeSubs = this.registry.activeCount();
    return { ok: true, subId: sub.subId };
  }

  /** `thr_res` lands (explicit or system): records the state; `gone` ⇒ P3 degrades to a finding. */
  markHandback(eventId: ThreadEventId, state: "done" | "gone" | "unknown"): { degrade: "finding" | "none" } {
    const record = this.records.get(eventId);
    if (!record) return { degrade: "none" };
    record.handback = state;
    return { degrade: state === "gone" ? "finding" : "none" };
  }

  // ------------------------------------------------------------------ introspection

  stats(): Readonly<ThreadStats> {
    this.statsValue.activeSubs = this.registry.activeCount();
    return { ...this.statsValue };
  }

  /** Test/inspection surface — the live aggregate of one event (§3.1 EventRecord). */
  inspectRecord(eventId: ThreadEventId): EventRecord | undefined {
    return this.records.get(eventId);
  }

  inspectSubscriptions(): Array<Record<string, unknown>> {
    return this.registry.all().map((s) => ({
      subId: s.subId,
      h: s.h,
      runId: s.runId,
      label: s.label,
      scope: s.scope,
      state: s.state,
      endReason: s.endReason,
      routed: s.routed,
      replies: s.replies,
      handbacks: s.handbacks,
      buffered: s.buffer.length,
      bufferedSentAt: s.buffer.list().map((e) => e.sentAt),
    }));
  }

  // ================================================================== internals

  private laneFor(h: ThreadHandle): ThreadLane {
    let lane = this.lanes.get(h);
    if (!lane) {
      lane = new ThreadLane(this.settings.laneWait);
      this.lanes.set(h, lane);
    }
    return lane;
  }

  private gateFor(runId: ThreadRunId): RunGate {
    let gate = this.gates.get(runId);
    if (!gate) {
      gate = new RunGate();
      this.gates.set(runId, gate);
    }
    return gate;
  }

  /** §5.3 lazy pre-route validation — end subs whose run is terminal or gone from the registry. */
  private lazyValidateThread(h: ThreadHandle, now: number): void {
    for (const sub of this.registry.activeSubsOfThread(h)) {
      const facts = this.deps.runFacts(sub.runId);
      let reason: "stale" | "run_terminal" | undefined;
      if (facts === undefined) reason = "stale";
      else if (isTerminalStatus(facts.status)) reason = "run_terminal";
      if (reason !== undefined) {
        const ended = this.registry.end(sub.subId, reason, now);
        if (ended) this.drainBufferAsNone(ended, "lazy validation");
      }
    }
    this.statsValue.activeSubs = this.registry.activeCount();
  }

  /** §6.5 lane pump — start fan-out while the lane is free and the next event's budget remains. */
  private pumpLane(h: ThreadHandle): void {
    if (this.disposedFlag) return;
    const lane = this.lanes.get(h);
    if (!lane) return;
    while (lane.inFlight === undefined) {
      const next = lane.waiting()[0];
      if (next === undefined) return;
      const event = this.active.get(next);
      if (event === undefined) {
        lane.removeWaiting(next); // defensive: stale entry
        continue;
      }
      const now = this.deps.clock.now();
      if (now >= event.record.deadlineAt) {
        lane.removeWaiting(next);
        this.onDeadline(next); // expired while queued — same handling, same tick
        continue;
      }
      lane.begin();
      this.dispatchEvent(event, now);
    }
  }

  /** §6.5/§6.6 fan-out: subscribers in creation order; per sub — buffer / gate / none. */
  private dispatchEvent(event: ActiveEvent, now: number): void {
    event.phase = "fanout";
    for (const sub of this.registry.activeSubsOfThread(event.h)) {
      const facts = this.deps.runFacts(sub.runId);
      const mode = facts ? deliveryModeForFacts(facts) : "none";
      if (mode === "none") {
        this.applyOutcome(event.record, sub.subId, "none", `pre-call (${facts?.status ?? "run_gone"})`);
        continue;
      }
      if (mode === "buffer") {
        const push = sub.buffer.push(event.record.eventId, event.h, event.sentAt, event.text);
        if (push.ok) {
          this.applyOutcome(event.record, sub.subId, "buffered", "run queued/starting");
          this.armBufferTimer(sub.subId);
        } else {
          this.applyOutcome(event.record, sub.subId, "none", `buffer ${push.reason}`);
        }
        continue;
      }
      // steer — through the per-run serial gate (§6.5 per-run 串行)
      const gate = this.gateFor(sub.runId);
      const key = steerKey(event.record.eventId, sub.subId);
      const steer: SteerRuntime = {
        task: { runId: sub.runId, eventId: event.record.eventId, subId: sub.subId },
        text: event.text,
        capMs: 0,
        called: false,
        settled: false,
        flushed: false,
        backstop: undefined,
        gen: this.generation,
      };
      event.pendingTasks++;
      if (!gate.enqueue(steer.task)) {
        event.pendingTasks--;
        this.applyOutcome(event.record, sub.subId, "none", "per-run wait full");
        continue;
      }
      this.steers.set(key, steer);
      this.pumpGate(sub.runId);
    }
    event.dispatchDone = true;
    this.afterOutcomeChange(event.record);
  }

  /** §6.5 per-run gate pump — call while budget remains; expired lane tasks record `none`.
   *  FLUSH tasks have no frame deadline (§6.5) — their ActiveEvent may already be gone. */
  private pumpGate(runId: ThreadRunId): void {
    if (this.disposedFlag) return;
    const gate = this.gates.get(runId);
    if (!gate) return;
    while (!gate.busy) {
      const next = gate.queued()[0];
      if (next === undefined) return;
      const steer = this.steers.get(steerKey(next.eventId, next.subId));
      const now = this.deps.clock.now();
      if (steer === undefined) {
        gate.next();
        gate.releaseInflight(next); // defensive: unknown task — drop it
        continue;
      }
      if (!steer.flushed) {
        const event = this.active.get(next.eventId);
        if (event === undefined || now >= event.record.deadlineAt) {
          // §6.5: 在 per-run 队列中被截止淘汰 — pre-call, safe fallback
          gate.next();
          gate.releaseInflight(next);
          this.finishSteer(steer, "none", "deadline while queued in run gate");
          continue;
        }
        gate.next();
        this.callSteer(steer, now, event.record.deadlineAt);
        continue;
      }
      gate.next();
      this.callSteer(steer, now, undefined);
    }
  }

  /** `deadlineAt === undefined` ⇒ flush path: single-call cap is steerTimeoutMs (§6.5). */
  private callSteer(steer: SteerRuntime, now: number, deadlineAt: number | undefined): void {
    steer.called = true;
    const capMs =
      deadlineAt === undefined ? this.settings.steerTimeoutMs : Math.max(1, remainingBudgetMs(deadlineAt, now));
    steer.capMs = capMs;
    const gen = steer.gen;
    steer.backstop = this.deps.clock.setTimer(capMs, () => {
      if (gen !== this.generation) return; // disposed between arming and firing
      // single-call ceiling exceeded with pi's steer still pending ⇒ unknown (§6.4 post-call)
      this.finishSteer(steer, "unknown", "steer timeout");
    });
    this.deps
      .steerThread(steer.task.runId, steer.text, capMs)
      .then(
        (disposition) => this.onSteerSettled(gen, steer, disposition),
        (error: unknown) => this.onSteerSettled(gen, steer, "unknown", error),
      )
      .catch(() => {}); // the settle path itself must never throw into a dangling promise
  }

  private onSteerSettled(gen: number, steer: SteerRuntime, disposition: string, error?: unknown): void {
    if (gen !== this.generation) return; // §6.5 代际检查 — discard wholesale
    const outcome = outcomeForDisposition(disposition);
    if (steer.settled) {
      // §6.5 晚到结果: audit only — never changes the sent reply; display upgrade unknown → queued.
      const record = this.records.get(steer.task.eventId);
      if (record && outcome === "queued" && record.perSub.get(steer.task.subId) === "unknown") {
        record.displayUpgradedTo = "queued";
      }
      this.deps.audit({ kind: "late-steer", eventId: steer.task.eventId, subId: steer.task.subId, outcome });
      return;
    }
    this.finishSteer(steer, outcome, `steer settled (${disposition})`, error);
  }

  /** The ONE settle path — outcome application, gate release, event completion. Idempotent. */
  private finishSteer(steer: SteerRuntime, outcome: Outcome, why: string, error?: unknown): void {
    if (steer.settled) return;
    steer.settled = true;
    if (steer.backstop !== undefined) {
      this.deps.clock.clearTimer(steer.backstop);
      steer.backstop = undefined;
    }
    const key = steerKey(steer.task.eventId, steer.task.subId);
    this.steers.delete(key);
    const gate = this.gates.get(steer.task.runId);
    if (gate) gate.releaseInflight(steer.task);
    const event = this.active.get(steer.task.eventId);
    const record = this.records.get(steer.task.eventId);
    if (event !== undefined && !steer.flushed) {
      event.pendingTasks = Math.max(0, event.pendingTasks - 1);
    }
    if (record !== undefined) {
      this.applyOutcome(record, steer.task.subId, outcome, why, error);
    }
    if (!this.disposedFlag) this.pumpGate(steer.task.runId);
  }

  /** §6.4/§6.7 outcome application with the transition law + completion/auto-return checks. */
  private applyOutcome(record: EventRecord, subId: string, outcome: Outcome, why: string, error?: unknown): void {
    const prev = record.perSub.get(subId);
    if (prev !== undefined && !canTransitionOutcome(prev, outcome)) {
      if (prev === "unknown" && outcome === "queued") {
        record.displayUpgradedTo = "queued"; // display upgrade only (§6.5 晚到结果)
        this.deps.audit({ kind: "display-upgrade", eventId: record.eventId, subId });
        return;
      }
      this.deps.audit({ kind: "illegal-transition", eventId: record.eventId, subId, prev, outcome, why });
      return;
    }
    record.perSub.set(subId, outcome);
    if (outcome === "unknown") this.statsValue.unknown++;
    if (error !== undefined) this.deps.audit({ kind: "steer-error", eventId: record.eventId, subId, why });
    EventRecordTable.refreshJudged(record);
    this.notifySubscriberLost(record, subId, prev, outcome, why);
    this.afterOutcomeChange(record);
  }

  /** §6.7 主会话可见性: a routed event where one subscriber was lost while another observed it. */
  private notifySubscriberLost(
    record: EventRecord,
    subId: string,
    prev: Outcome | undefined,
    outcome: Outcome,
    why: string,
  ): void {
    if (outcome !== "none" || prev === undefined) return;
    if (prev !== "buffered" && prev !== "flushing") return;
    if (!record.replied || record.replyKind !== "routed") return;
    const sub = this.registry.get(subId);
    if (!sub) return;
    for (const [otherId, o] of record.perSub) {
      if (otherId === subId || (o !== "queued" && o !== "unknown")) continue;
      const other = this.registry.get(otherId);
      if (!other) continue;
      this.deps.display(
        `[thread] 事件未送达 @${sub.label}（run_id: ${sub.runId}，${why}），已由 @${other.label}（run_id: ${other.runId}）接收`,
      );
      return;
    }
  }

  /** §6.5/§6.7: early first reply, lane release, and the at-most-once auto-return. */
  private afterOutcomeChange(record: EventRecord): void {
    const event = this.active.get(record.eventId);
    if (event !== undefined && event.phase === "fanout" && event.dispatchDone && event.pendingTasks === 0) {
      if (!record.replied && record.judged) this.firstReply(event, this.deps.clock.now());
      this.releaseLane(event);
    }
    if (record.judged && record.replied && record.replyKind === "routed") {
      this.maybeAutoReturn(record);
    }
  }

  private releaseLane(event: ActiveEvent): void {
    const lane = this.lanes.get(event.h);
    if (lane) lane.complete(event.record.eventId);
    if (event.record.replied) {
      if (event.deadlineTimer !== undefined) {
        this.deps.clock.clearTimer(event.deadlineTimer);
        event.deadlineTimer = undefined;
      }
      // buffered outcomes may still be pending — that is the flush path's business now
      this.active.delete(event.record.eventId);
    }
    // the in-flight slot is free either way (custody rule) — let the next waiter fan out even
    // while this event's reply is still pending at its own deadline
    this.pumpLane(event.h);
  }

  /** §6.7 首次回复 — routed ⇔ any observed; all-none ⇒ native release. */
  private firstReply(event: ActiveEvent, now: number): void {
    if (event.record.replied) return;
    const aggregate = aggregateFirstReply(event.record.perSub.values());
    if (aggregate === "routed") {
      const record = event.record;
      record.replied = true;
      record.replyKind = "routed";
      record.deliveredAt = now;
      this.statsValue.routed++;
      this.pushHourly(event.h, now);
      // §6.7/§7.3: unique observed (runId,label) pairs, wire-capped at THREAD_SUBS_MAX
      const seenRuns = new Set<string>();
      const runs: Array<{ runId: string; label: string }> = [];
      for (const [subId, outcome] of record.perSub) {
        if (outcome === "none") continue;
        const sub = this.registry.get(subId);
        if (!sub) continue;
        sub.routed++;
        if (outcome === "buffered") sub.buffer.setDeliveredAt(record.eventId, now);
        if (seenRuns.has(sub.runId)) continue;
        seenRuns.add(sub.runId);
        if (runs.length < THREAD_SUBS_MAX) runs.push({ runId: sub.runId, label: sub.label });
      }
      for (const [subId, outcome] of record.perSub) {
        if (outcome !== "buffered") continue;
        const sub = this.registry.get(subId);
        if (sub) this.armBufferTimer(subId);
      }
      this.deps.replyRouted(record.eventId, runs);
    } else {
      event.record.replied = true;
      event.record.replyKind = "fallback";
      event.record.judged = true;
      if (this.disposedFlag) {
        // §6.5 dispose: no subscriber was called ⇒ E_STALE_CTX, never a native re-dispatch
        this.deps.replyStaleCtx(event.record.eventId);
      } else if (this.deps.releaseToNative(event.record.eventId)) {
        // re-check passed, the prompt-release path re-dispatched the event — done
      } else {
        // §6.7 复检失败： nothing was re-dispatched, so the ENGINE owes the hub the reply
        this.deps.replyStaleCtx(event.record.eventId);
        this.deps.audit({ kind: "native-release-refused", eventId: event.record.eventId });
      }
    }
  }

  /** §6.7 系统自动回流 — ONLY all-`none`, at most once, never while disposed (§9.4 C4). */
  private maybeAutoReturn(record: EventRecord): void {
    if (this.disposedFlag || record.autoReturned || record.handback !== undefined) return;
    const decision = autoReturnDecision(record.perSub.values());
    if (decision.kind !== "request") return;
    record.autoReturned = true;
    record.handback = "pending";
    this.statsValue.autoReturned++;
    this.statsValue.handback++;
    this.deps.requestAutoReturn(record.eventId);
  }

  /** §6.5 absolute-deadline handler — same-tick reply guaranteed (synchronous callback). */
  private onDeadline(eventId: ThreadEventId): void {
    const event = this.active.get(eventId);
    if (event === undefined) return;
    const now = this.deps.clock.now();
    if (event.phase === "lane_wait") {
      const lane = this.lanes.get(event.h);
      if (lane) lane.removeWaiting(eventId);
      this.statsValue.laneTimeout++;
      for (const sub of this.registry.activeSubsOfThread(event.h)) {
        this.applyOutcome(event.record, sub.subId, "none", "lane timeout");
      }
      this.firstReply(event, now); // empty perSub ⇒ fallback (native release path)
      this.releaseLane(event);
      return;
    }
    // fan-out phase: queued-not-called ⇒ none (pre-call); called-not-returned ⇒ unknown (§6.5)
    for (const steer of [...this.steers.values()]) {
      if (steer.task.eventId !== eventId || steer.flushed) continue;
      if (!steer.called) this.finishSteer(steer, "none", "deadline before call");
      else if (!steer.settled) this.finishSteer(steer, "unknown", "deadline with steer in flight");
    }
    if (!event.record.replied) this.firstReply(event, now);
    this.releaseLane(event);
  }

  // ------------------------------------------------------------------ §6.5 buffers & flush

  /** (Re)arm the per-subscription buffer TTL timer (§6.5 startTimeoutMin from the earliest
   *  anchored deliveredAt). Fires ⇒ end the sub (start_timeout) and sweep the buffer to none. */
  private armBufferTimer(subId: string): void {
    const existing = this.bufferTimers.get(subId);
    if (existing !== undefined) {
      this.deps.clock.clearTimer(existing);
      this.bufferTimers.delete(subId);
    }
    const sub = this.registry.get(subId);
    if (!sub || sub.state !== "active") return;
    const expiry = sub.buffer.expiryAt(this.settings.startTimeoutMin * 60_000);
    if (expiry === undefined) return;
    const handle = this.deps.clock.setTimer(Math.max(0, expiry - this.deps.clock.now()), () => {
      this.bufferTimers.delete(subId);
      const s = this.registry.get(subId);
      if (!s || s.state !== "active") return;
      const now = this.deps.clock.now();
      const expiryNow = s.buffer.expiryAt(this.settings.startTimeoutMin * 60_000);
      if (expiryNow === undefined) return;
      if (now < expiryNow) {
        this.armBufferTimer(subId); // earliest changed since arming — re-arm
        return;
      }
      const ended = this.registry.end(subId, "start_timeout", now);
      if (ended) {
        this.drainBufferAsNone(ended, "start_timeout");
        this.statsValue.activeSubs = this.registry.activeCount();
      }
    });
    this.bufferTimers.set(subId, handle);
  }

  /** §6.7 none-sweep: a drained buffer's events each record `none` for THIS sub, then the
   *  aggregate/auto-return check runs per event. */
  private drainBufferAsNone(sub: { subId: string }, why: string): void {
    const s = this.registry.get(sub.subId);
    if (!s) return;
    const handle = this.bufferTimers.get(sub.subId);
    if (handle !== undefined) {
      this.deps.clock.clearTimer(handle);
      this.bufferTimers.delete(sub.subId);
    }
    for (const entry of s.buffer.drain()) {
      const record = this.records.get(entry.eventId);
      if (!record) continue;
      this.applyOutcome(record, sub.subId, "none", why);
    }
  }

  /** §6.5 缓冲冲刷 — first onSnapshot(running): FIFO flushing → steerThread via the per-run gate;
   *  no frame deadline (the hub already got the routed reply), single-call cap steerTimeoutMs. */
  private flushRun(runId: ThreadRunId): void {
    for (const sub of this.registry.activeSubsOfRun(runId)) {
      const entries = sub.buffer.drain();
      if (entries.length === 0) continue;
      const gate = this.gateFor(runId);
      for (const entry of entries) {
        const record = this.records.get(entry.eventId);
        if (!record) continue;
        this.applyOutcome(record, sub.subId, "flushing", "flush start");
        const key = steerKey(entry.eventId, sub.subId);
        const steer: SteerRuntime = {
          task: { runId, eventId: entry.eventId, subId: sub.subId },
          text: entry.text,
          capMs: this.settings.steerTimeoutMs,
          called: false,
          settled: false,
          flushed: true,
          backstop: undefined,
          gen: this.generation,
        };
        this.steers.set(key, steer);
        if (!gate.enqueue(steer.task)) {
          this.steers.delete(key);
          this.applyOutcome(record, sub.subId, "none", "per-run wait full (flush)");
          continue;
        }
      }
      this.pumpGate(runId);
    }
  }

  // ------------------------------------------------------------------ §5.3 terminal

  private onRunTerminal(runId: ThreadRunId, status: string, now: number): void {
    // §5.3 ① freeze FIRST — the summary covers EVERY sub this run ever held, not just live ones
    const live = this.registry.activeSubsOfRun(runId);
    let routed = 0,
      replies = 0,
      handbacks = 0;
    for (const s of this.registry.all()) {
      if (s.runId !== runId) continue;
      routed += s.routed;
      replies += s.replies;
      handbacks += s.handbacks;
    }
    if (live.length > 0 || routed + replies + handbacks > 0) {
      this.summaries.set(runId, { runId, subs: live.length, routed, replies, handbacks, endedAt: now });
      this.trimSummaries(now);
    }
    // ② cancel pre-call gate tasks of this run (§6.4 pre-call ⇒ none); in-flight takes its real result
    this.cancelGateTasks(runId, () => true);
    // ③ end + sweep
    for (const sub of live) {
      const ended = this.registry.end(sub.subId, "run_terminal", now);
      if (ended) this.drainBufferAsNone(ended, `run ${status}`);
    }
    this.statsValue.activeSubs = this.registry.activeCount();
  }

  private trimSummaries(now: number): void {
    for (const [id, s] of this.summaries) {
      if (now - s.endedAt > SUMMARY_FREEZE_TTL_MS) this.summaries.delete(id);
    }
    while (this.summaries.size > SUMMARY_FREEZE_MAX) {
      const oldest = this.summaries.keys().next().value as ThreadRunId | undefined;
      if (oldest === undefined) break;
      this.summaries.delete(oldest);
    }
  }

  private cancelGateTasks(runId: ThreadRunId, predicate: (t: RunSteerTask) => boolean): void {
    const gate = this.gates.get(runId);
    if (!gate) return;
    for (const task of gate.cancelQueued(predicate)) {
      const steer = this.steers.get(steerKey(task.eventId, task.subId));
      if (steer && !steer.called) this.finishSteer(steer, "none", "cancelled pre-call");
    }
  }

  // ------------------------------------------------------------------ R4 hourly window

  private hourlyCount(h: ThreadHandle, now: number): number {
    const times = this.hourly.get(h);
    if (!times) return 0;
    this.pruneHourly(times, now);
    return times.length;
  }

  private pushHourly(h: ThreadHandle, now: number): void {
    let times = this.hourly.get(h);
    if (!times) {
      times = [];
      this.hourly.set(h, times);
    }
    times.push(now);
    this.pruneHourly(times, now);
  }

  private pruneHourly(times: number[], now: number): void {
    const cutoff = now - THREAD_ROUTED_WINDOW_MS;
    while (times.length > 0 && times[0]! < cutoff) times.shift();
  }

  /** §6.3 R4: display hint at most once per hour per thread. */
  private maybeHint(h: ThreadHandle, now: number): void {
    const last = this.lastHintAt.get(h);
    if (last !== undefined && now - last < THREAD_ROUTED_WINDOW_MS) return;
    this.lastHintAt.set(h, now);
    this.deps.hint(`[thread] 本小时直投数已达上限，事件回落主会话（${h}）`);
  }
}
