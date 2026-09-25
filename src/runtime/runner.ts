import {
  describeTimeout,
  effectiveDeadlineAt,
  extendability,
  remainingFor,
  withDeadline,
  SET_MODEL_TIMEOUT_MS,
} from "../core/deadline.js";
import type { Clock } from "../core/clock.js";
import { createInitialState, reduce } from "../core/state-machine.js";
import { isTerminalStatus } from "../core/status.js";
import type {
  DeadlineBudget,
  DeliveryPayload,
  EffectEnvelope,
  ErrorInfo,
  ExtendOutcome,
  ExtendSource,
  LifecycleEvent,
  Millis,
  RunEffect,
  RunExitFacts,
  RunId,
  RunInput,
  RunOutcome,
  RunSnapshot,
  RunState,
  RunDisplayMeta,
  SetModelOutcome,
  StampedInput,
  StopCause,
} from "../core/types.js";
import type { SnapshotStore } from "../core/store.js";
import type { SessionDriver, SessionHandle, SessionSpec } from "./session-driver.js";
import type { SlotPool, SlotTicket } from "./slot-pool.js";
import type { ToolScopeEnforcer, ToolScopePolicy } from "./tool-scope.js";
import type { Watchdog } from "./watchdog.js";
import type { Reaper, ReapInput } from "./reaper.js";

export interface ResolvedSpawnRequest extends SessionSpec {
  runId: string;
  prompt: string;
  signal?: AbortSignal;
  /**
   * Background-spawn semantics ("detached from the parent turn"): the
   * external `signal` linkage is narrowed to the admission window — the
   * runner detaches the external listener right after the cancel handle is
   * created. An already-aborted signal still cancels immediately inside
   * createCancelHandle (detach happens after handle creation). See
   * SpawnRequest.detachSignalOnStart (core/types.ts).
   */
  detachSignalOnStart?: boolean;
  slotless?: boolean;
  /** X3: propagated through so RunState/RunSnapshot.parentRunId (core §5.1) is actually populated for nested runs — previously always undefined because nothing threaded it past RunnerSpec.request. */
  parentRunId?: string;
  /**
   * CC4: absolute deadline cap threaded from SpawnRequest.deadlineAt. Must be
   * explicitly propagated by the adapter (service/runtime-adapter.ts) into the
   * object literal it builds here — same failure mode as parentRunId above:
   * silently dropped if a hop forgets to spread it. See service/request-threading.ts
   * for the compile-time guard against exactly that.
   */
  deadlineAt?: Millis;
  /**
   * consult (plan §4.3/§4.4): threaded verbatim from
   * `SpawnRequest.forkSessionFrom`. The runner uses it for two things:
   * ① session_create opens this file through `driver.resume` instead of
   * creating a fresh session; ② after the run is physically reaped it is
   * handed back to `RunnerDeps.onReaped(runId, forkSessionFrom)` so the fork
   * copy can be deleted at the one point in time where nothing can write to
   * it again. Declared here (rather than only in package B) because
   * `service/request-threading.ts`'s Gate C requires every THREADED field to
   * exist under the same name on this interface.
   */
  forkSessionFrom?: string;
  /** M-A: display-only spawn metadata (model/label/agent type) folded into diag at enqueue time for the presentation layer (fleet tree / Agent tool card). */
  displayMeta?: RunDisplayMeta;
  /** X11: per-run tool-scope policy + a fresh (per-run) enforcer instance; undefined = no dynamic re-enforcement (legacy behavior). */
  toolScope?: { policy: ToolScopePolicy; enforcer: ToolScopeEnforcer };
}
export interface CancelHandle {
  readonly runId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  cancel(reason: string): void;
  readonly whenCancelled: Promise<never>;
  detach(): void;
}
export function createCancelHandle(
  runId: string,
  generation: number,
  external: AbortSignal | undefined,
  onCancel: (reason: string) => void,
): CancelHandle {
  const controller = new AbortController();
  let reject!: (reason?: unknown) => void;
  const whenCancelled = new Promise<never>((_, r) => {
    reject = r;
  });
  whenCancelled.catch(() => undefined);
  let detached = false;
  const cancel = (reason: string) => {
    if (controller.signal.aborted) return;
    try {
      controller.abort(reason);
    } catch {
      /* listener failures do not block cancellation */
    }
    reject(new Error(reason));
    onCancel(reason);
  };
  const onExternal = () => cancel("external");
  if (external?.aborted) cancel("external");
  else if (external) external.addEventListener("abort", onExternal, { once: true });
  return {
    runId,
    generation,
    signal: controller.signal,
    cancel,
    whenCancelled,
    detach: () => {
      if (!detached) {
        detached = true;
        external?.removeEventListener("abort", onExternal);
      }
    },
  };
}
export interface CriticalResult {
  slotReleased: boolean;
  waitersSettled: boolean;
  snapshotPersisted: boolean;
}
export interface EffectInterpreter {
  apply(runId: string, generation: number, batch: readonly EffectEnvelope[]): void;
  applyCriticalSync(runId: string, generation: number, batch: readonly EffectEnvelope[]): CriticalResult;
  readonly audit: readonly EffectAuditRecord[];
}
export interface EffectAuditRecord {
  effectId: string;
  kind: string;
  ok: boolean;
  ms: number;
  error?: string;
}
export type EffectFailureHandler = (runId: string, generation: number, kind: RunEffect["kind"], error: Error) => void;
export class BasicEffectInterpreter implements EffectInterpreter {
  private seen = new Set<string>();
  private records: EffectAuditRecord[] = [];
  constructor(
    private readonly handlers: Partial<Record<RunInput["kind"] | string, (e: EffectEnvelope["effect"]) => void>> = {},
    private readonly onFailure?: EffectFailureHandler,
  ) {}
  get audit() {
    return this.records;
  }
  apply(runId: string, generation: number, batch: readonly EffectEnvelope[]) {
    for (const e of batch) this.one(runId, generation, e);
  }
  applyCriticalSync(runId: string, generation: number, batch: readonly EffectEnvelope[]) {
    this.apply(
      runId,
      generation,
      batch.filter((e) => e.criticality === "critical"),
    );
    return {
      slotReleased: batch.some((e) => e.effect.kind === "release_slot"),
      waitersSettled: batch.some((e) => e.effect.kind === "settle_waiters"),
      snapshotPersisted: batch.some((e) => e.effect.kind === "persist_snapshot"),
    };
  }
  private one(runId: string, generation: number, e: EffectEnvelope) {
    if (this.seen.has(e.effectId)) return;
    this.seen.add(e.effectId);
    const at = Date.now();
    try {
      this.handlers[e.effect.kind]?.(e.effect);
      this.records.push({ effectId: e.effectId, kind: e.effect.kind, ok: true, ms: Date.now() - at });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.records.push({
        effectId: e.effectId,
        kind: e.effect.kind,
        ok: false,
        ms: Date.now() - at,
        error: error.message,
      });
      // Major 4 (5.6.1): a failed effect must be fed back into the state
      // machine as `effect_failed` so critical effects get compensated and
      // persist_snapshot gets its bounded durable-retry loop (R9). Without
      // this callback the audit record would be the only trace and the run
      // would never see diag.degraded / outcome.persistFailed.
      try {
        this.onFailure?.(runId, generation, e.effect.kind, error);
      } catch {
        /* onFailure must never break the interpreter's own error isolation */
      }
    }
    if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value as string);
  }
}
export interface RunnerDeps {
  clock: Clock;
  driver: SessionDriver;
  pool: SlotPool;
  store: SnapshotStore;
  watchdog: Watchdog;
  reaper: Reaper;
  effects: EffectInterpreter;
  emit: (e: LifecycleEvent) => void;
  deliver: (p: DeliveryPayload) => void;
  /**
   * H3 (architecture §7.1): bounded, post-terminal, pre-physical-reclaim hook
   * (worktree commit/gate is the intended M2 consumer). Wired here — not at
   * the L3 service seam — because reap() is fire-and-forget from the
   * runner's own `finally` block; by the time `Runner.run()`'s promise
   * resolves back up at L3, physical reclaim may already be in flight or
   * finished. This is the only point in the call graph that is reliably
   * "after logical settle, before dispose".
   */
  beforeReap?: (outcome: RunOutcome, ctx: { cwd: string; deadlineMs: Millis }) => Promise<void> | void;
  /** Diagnostics-only sink for extension hook failures/timeouts (H3); never affects run outcome or settle timing beyond reapMs bound. */
  onExtensionError?: (hook: "beforeReap" | "onLateArrival", runId: string, error: string) => void;
  /** Fired after every accepted dispatch with the fresh state — the live
   *  read-model feed for in-flight runs (persist_snapshot is terminal-only). */
  onStateChange?: (runId: string, state: RunState) => void;
  /**
   * X3: invoked whenever this run's cancellation is triggered (explicit
   * abortRun() call or the external SpawnRequest.signal firing), from
   * whichever path first reaches it — the single funnel point inside
   * createCancelHandle's onCancel callback below. Always called with cause
   * "parent_abort" (semantically "your parent is going away"), regardless of
   * *why* the parent itself stopped. The caller (service/runtime-adapter.ts,
   * wired from index.ts) is expected to look up and abort this run's own
   * children; RuntimeRunner itself has no notion of a run tree.
   */
  onChildAbort?: (runId: string, cause: StopCause) => void;
  /**
   * bash-timeout-grace plan §3.2 (P0b, frozen): synchronous, idempotent,
   * never-throwing seal callback. Invoked by the runner's internal
   * `sealBeforeTerminal(runId, gen)` exactly once per (runId, generation)
   * that has a bound session, immediately before the FIRST input guaranteed
   * to move that run into a terminal RunStatus (§3.2's table: bind failure,
   * the normal/catch prompt_settled dispatches, the abort_grace/extension_bind
   * fireDeadline() branch, and the run() finally fallback — invariant I-SEAL).
   * Returns the child bash job snapshot to fold into
   * `diag.exitFacts` (dispatched as `session_event{t:"exit_facts"}`), or
   * `undefined` when there is nothing to report — no child registry entry for
   * this sessionId, the feature disabled, or this stack never wired it at
   * all. A thrown error is treated exactly like an absent callback: swallowed
   * by the runner, never surfaced into the dispatch path (RunExitFacts is
   * best-effort presentation data, not a state-machine invariant — AGENTS.md
   * zero-hang: this must never block or reject).
   */
  sealSession?: (runId: RunId, sessionId: string) => RunExitFacts | undefined;
  /**
   * consult (plan §4.4, frozen surface) + bash-timeout-grace plan §3.2:
   * physical-reclaim-completed hook. Called once per run after the
   * finally-block's `runReap()` finishes (beforeReap + reaper dispose
   * included, success or failure), and once more from each late-arrival path
   * after `disposeLate`. `forkSessionFrom` is taken straight from
   * `req.forkSessionFrom` (undefined for every non-consult run) — the
   * deletion fact travels with the request, so no side registry (the v2
   * pendingDeletions race) exists. `sessionId` (added by the
   * bash-timeout-grace plan, §3.2) is the child session id observed at the
   * call site — `handle?.sessionId` on the normal reap path, `h.sessionId` on
   * both late-arrival paths — so a host-side listener can defensively seal a
   * session `sealBeforeTerminal` never reached (e.g. a late-arrival session
   * created outside the normal handle lifecycle); additive parameter,
   * existing wiring that ignores the third argument is unaffected.
   * Implementations must be idempotent, synchronous and non-throwing (a
   * throw is swallowed and only loses the cleanup).
   */
  onReaped?: (runId: RunId, forkSessionFrom?: string, sessionId?: string) => void;
}
export interface Runner {
  run(req: ResolvedSpawnRequest, budget: DeadlineBudget): Promise<RunOutcome>;
}
const error = (e: unknown, kind: ErrorInfo["kind"] = "internal"): ErrorInfo => ({
  kind,
  message: e instanceof Error ? e.message : String(e),
  retryable: false,
});
/** Cap for a start-phase exception message carried into diag.error / the outbox failReason. */
export const START_ERROR_MESSAGE_CAP = 1000;
/**
 * A session_create / extension_bind / prompt() *rejection* (as opposed to a
 * cancel or a deadline) is a real failure with a real cause — e.g. pi's
 * `No API key found for <provider>.` when the child session's fresh model
 * runtime does not know the requested provider. Keep the message (capped) so
 * the completion notice and get_subagent_result show it instead of the
 * generic "cancelled" the guards used to report for every rejection.
 */
function startError(e: unknown): ErrorInfo {
  const raw = (e instanceof Error ? e.message : String(e)).trim() || "session start failed (empty error message)";
  const message = raw.length > START_ERROR_MESSAGE_CAP ? `${raw.slice(0, START_ERROR_MESSAGE_CAP - 1)}…` : raw;
  return { kind: "internal", message, retryable: false };
}
/** Guard verdict: settled value, deadline, cancel signal, or the awaited promise's own rejection. */
type GuardResult<T> = { ok: true; value: T } | { ok: false; reason: "timeout" | "cancelled" } | GuardRejected;
interface GuardRejected {
  ok: false;
  reason: "error";
  error: unknown;
}
export class RuntimeRunner implements Runner {
  private readonly states = new Map<string, RunState>();
  private generation = new Map<string, number>();
  private readonly dispatchers = new Map<
    string,
    { gen: number; fn: (input: RunInput) => void; budget: DeadlineBudget }
  >();
  private readonly activeCancels = new Map<string, { gen: number; cancel: CancelHandle }>();
  private readonly activeHandles = new Map<string, { gen: number; handle: SessionHandle }>();
  /** bash-timeout-grace plan §3.2: runId -> generation already sealed, guarding sealBeforeTerminal's idempotency (I-SEAL). */
  private readonly sealedGenerations = new Map<string, number>();
  constructor(private readonly d: RunnerDeps) {}
  /** Public dispatch entry so external drivers (watchdog ticks, effect-failure feedback) can feed inputs into a specific, still-running (runId, generation) without touching another concurrent run (fixes the single-field-clobber hazard when limit > 1). */
  dispatchExternal(runId: string, generation: number, input: RunInput): void {
    const entry = this.dispatchers.get(runId);
    if (entry && entry.gen === generation) entry.fn(input);
  }
  /** Read-only snapshot of a run's internal RunState, for watchdog tick() / diagnostics. */
  getRunState(runId: string, generation?: number): RunState | undefined {
    const s = this.states.get(runId);
    return generation === undefined || s?.generation === generation ? s : undefined;
  }
  /**
   * timeout-notify (arch §4.6 / D-9): extend a running run's soft deadline.
   * Fully synchronous — check → dispatch → read-back with zero `await` in
   * between, so there is no TOCTOU window against the watchdog tick on the
   * single JS event loop. The reducer re-validates (defense in depth) and is
   * the one that actually moves deadlineAt; we only translate the outcome.
   */
  extendDeadline(runId: string, extendMs: number, opts: { source: ExtendSource; reason?: string }): ExtendOutcome {
    const state = this.states.get(runId);
    if (!state) return { ok: false, reason: "unknown_run" };
    const entry = this.dispatchers.get(runId);
    // Dispatcher gone (run hit its finally) or generation superseded ⇒ the run
    // is finished even if a terminal snapshot still lingers in this.states.
    if (!entry || entry.gen !== state.generation) return { ok: false, reason: "already_terminal" };
    const now = this.d.clock.now();
    const verdict = extendability(state, entry.budget, now);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    const prev = state.deadlines.deadlineAt!; // extendability ok ⇒ defined
    const hard = state.deadlines.hardDeadlineAt!;
    const wasInGrace = state.deadlines.graceUntil !== undefined;
    entry.fn({
      kind: "deadline_extended",
      at: now,
      extendMs,
      source: opts.source,
      ...(opts.reason === undefined ? {} : { reason: opts.reason }),
    });
    const after = this.states.get(runId);
    const next = after?.deadlines.deadlineAt;
    // The reducer refused (e.g. zero net gain inside the grace window) even
    // though the pre-check passed — surface it as no_headroom.
    if (next === undefined || next === prev) return { ok: false, reason: "no_headroom" };
    const requestedMs = Math.max(0, extendMs);
    const grantedMs = next - Math.max(now, prev);
    const extensionsUsed = after?.diag.overtime?.extensions ?? 0;
    return {
      ok: true,
      runId,
      previousDeadlineAt: prev,
      deadlineAt: next,
      requestedMs,
      grantedMs,
      clamped: grantedMs < requestedMs,
      extensionsUsed,
      extensionsRemaining: entry.budget.maxExtensions - extensionsUsed,
      hardDeadlineAt: after?.deadlines.hardDeadlineAt ?? hard,
      rescuedFromGrace: wasInGrace,
    };
  }
  /** Feed a failed effect back into the state machine (5.6.1 R9 compensation / persist retry loop). */
  notifyEffectFailed(runId: string, generation: number, effect: RunEffect["kind"], err: Error): void {
    this.dispatchExternal(runId, generation, {
      kind: "effect_failed",
      at: this.d.clock.now(),
      effect,
      error: error(err),
    });
  }
  /** L2 escalation trigger for QueryService.stop(): request cooperative + bounded abort of an active run. */
  async abortRun(
    runId: string,
    cause: StopCause = "user_stop",
  ): Promise<{ ok: boolean; escalatedTo: "L2" | "L3" | "L4" }> {
    const entry = this.activeCancels.get(runId);
    if (!entry) return { ok: false, escalatedTo: "L4" };
    entry.cancel.cancel(cause);
    return { ok: true, escalatedTo: "L2" };
  }
  /** Best-effort steer of an active run's session (QueryService.steer()); rejects if none is running. */
  async steerRun(runId: string, text: string): Promise<void> {
    const entry = this.activeHandles.get(runId);
    if (!entry) throw new Error(`no active session for run ${runId}`);
    await entry.handle.steer(text);
  }
  /** set_model: switch an active run's model. Bounded (SET_MODEL_TIMEOUT_MS) —
   *  session.setModel awaits a provider auth check, and no anti-hang path may
   *  await an unbounded pi call. (steerRun itself is unbounded — steerMs only
   *  feeds fabric/reaper; that unboundedness is a known defect this path does
   *  not repeat.) Returns a reason union instead of throwing so the tool can
   *  turn each failure into a distinct self-correcting message (plan §6). */
  async setModelForRun(
    runId: string,
    model: { provider: string; id: string },
    opts: { thinking?: string } = {},
  ): Promise<SetModelOutcome> {
    const entry = this.activeHandles.get(runId);
    if (!entry) return { ok: false, reason: "not_running" };
    const { gen, handle } = entry;
    if (!handle.setModel || !this.d.driver.resolveModelRef) return { ok: false, reason: "unsupported" };
    const resolved = this.d.driver.resolveModelRef(model.provider, model.id);
    if (!resolved) return { ok: false, reason: "unknown_model", detail: `${model.provider}/${model.id}` };
    const previousThinking = handle.getThinkingLevel?.();
    const applied = await withDeadline(handle.setModel(resolved), SET_MODEL_TIMEOUT_MS, this.d.clock, "set_model");
    if (!applied.ok)
      return applied.reason === "timeout"
        ? { ok: false, reason: "timeout" }
        : { ok: false, reason: "rejected", detail: applied.error.message };
    // Requirement 3: pi's setModel recomputes the thinking level (per-model
    // override → global defaultThinkingLevel → current), so "keep the current
    // level" must be written back explicitly; clamping stays with pi core.
    const desired = opts.thinking ?? previousThinking;
    if (desired !== undefined && handle.setThinkingLevel) {
      try {
        handle.setThinkingLevel(desired);
      } catch {
        /* non-fatal: the model may not support the level; pi already clamped */
      }
    }
    const effective = handle.getModelRef?.() ?? model;
    this.dispatchExternal(runId, gen, {
      kind: "session_event",
      at: this.d.clock.now(),
      event: { t: "model_changed", model: effective },
    });
    const level = handle.getThinkingLevel?.();
    return { ok: true, model: effective, ...(level === undefined ? {} : { thinking: level }) };
  }
  /**
   * bash-timeout-grace plan §3.2 (P0b, frozen): synchronous, idempotent
   * pre-terminal seal (invariant I-SEAL). No-ops when there is no bound
   * session for this (runId, generation) — nothing to seal — or when this
   * generation has already been sealed once. `sealSession` itself must never
   * throw into the dispatch path; a thrown error is treated exactly like an
   * absent callback (RunExitFacts is best-effort diagnostics, never a
   * lifecycle concern).
   */
  private sealBeforeTerminal(runId: string, gen: number): void {
    if (this.sealedGenerations.get(runId) === gen) return;
    const handleEntry = this.activeHandles.get(runId);
    if (!handleEntry || handleEntry.gen !== gen) return;
    this.sealedGenerations.set(runId, gen);
    let facts: RunExitFacts | undefined;
    try {
      facts = this.d.sealSession?.(runId, handleEntry.handle.sessionId);
    } catch {
      /* best-effort diagnostics — never break the dispatch path */
      facts = undefined;
    }
    if (facts === undefined) return;
    this.dispatchExternal(runId, gen, {
      kind: "session_event",
      at: this.d.clock.now(),
      event: { t: "exit_facts", facts },
    });
  }
  /**
   * M4: EventWatchdog 的超时入口。两步缺一不可：
   * 1. 先把 deadline_fired 折进状态机 —— 进入 abort_grace 并记录具体 timeoutReason；
   * 2. 再取消本 run 的 CancelHandle —— run() 正阻塞在 guard(handle.prompt(...)) 上，
   *    而 guard 只在 prompt 完成 / cancel / 总预算三点之一解除；没有这一步，状态机
   *    虽然已判 timed_out，run() 仍会挂到 totalMs 才返回，reaper 清理同样被拖延。
   *    取消后走与用户中止完全相同的 teardown/finally/reap 路径。
   * 顺序必须如此（先 deadline 后 cancel）：cancel 派发的 stop_requested 在
   * abort_grace 里只补记 stopCause，不会覆盖 timeoutReason，结果保持 timed_out。
   */
  fireDeadline(runId: string, generation: number, input: Extract<RunInput, { kind: "deadline_fired" }>): void {
    const state = this.states.get(runId);
    if (!state || state.generation !== generation || isTerminalStatus(state.status)) return;
    // bash-timeout-grace plan §3.2 (P0b, frozen): in these two phases a
    // deadline_fired is UNCONDITIONALLY terminal in the reducer (abort_grace's
    // second timeout; extension_bind's watchdog-driven timeout) — see
    // state-machine.ts's deadline_fired branch. Every other phase either stays
    // non-terminal (enters abort_grace) or is covered by one of the other four
    // sealBeforeTerminal call sites, so gating on these exact two phases keeps
    // sealAndKill from ever firing early against a run that is merely entering
    // its abort grace window.
    if (
      (state.phase === "abort_grace" || state.phase === "extension_bind") &&
      this.activeHandles.get(runId)?.gen === generation
    ) {
      this.sealBeforeTerminal(runId, generation);
    }
    this.dispatchExternal(runId, generation, input);
    // timeout-notify (arch §3.5, review-critical): re-read the state AFTER the
    // dispatch. If the run just entered a timeout grace window it is still
    // running normally — cancelling here would kill it at the exact moment the
    // grace was granted, silently nullifying the whole feature. Only a run that
    // actually transitioned to stopping (or terminal) gets its prompt guard
    // cancelled.
    const after = this.states.get(runId);
    if (!after || (after.status !== "stopping" && !isTerminalStatus(after.status))) return;
    const entry = this.activeCancels.get(runId);
    if (entry && entry.gen === generation) entry.cancel.cancel("timeout");
  }
  async run(req: ResolvedSpawnRequest, budget: DeadlineBudget): Promise<RunOutcome> {
    const gen = (this.generation.get(req.runId) ?? 0) + 1;
    this.generation.set(req.runId, gen);
    let state = createInitialState(req.runId, gen, this.d.clock.now(), req.parentRunId);
    this.states.set(req.runId, state);
    const cancel = createCancelHandle(req.runId, gen, req.signal, (reason) => {
      // M4: "timeout" 来自 fireDeadline（watchdog 超时），必须原样保留，
      // 否则超时取消会被误记为 user_stop。
      const selfCause: StopCause =
        reason === "external" ? "parent_abort" : reason === "timeout" ? "timeout" : "user_stop";
      this.dispatchExternal(req.runId, gen, {
        kind: "stop_requested",
        at: this.d.clock.now(),
        cause: selfCause,
      });
      // X3: cascade regardless of *why* this run stopped — a child's parent
      // going away is always "parent_abort" from the child's point of view.
      this.d.onChildAbort?.(req.runId, "parent_abort");
    });
    this.activeCancels.set(req.runId, { gen, cancel });
    if (req.detachSignalOnStart) cancel.detach();
    let ticket: SlotTicket | undefined;
    let handle: SessionHandle | undefined;
    let createP: Promise<SessionHandle> | undefined;
    const dispatch = (input: RunInput) => {
      const out = reduce(state, { generation: gen, input }, budget);
      state = out.state;
      this.states.set(req.runId, state);
      try {
        this.d.onStateChange?.(req.runId, state);
      } catch {
        /* observer must never break the dispatch loop */
      }
      this.d.effects.apply(req.runId, gen, out.effects);
    };
    this.dispatchers.set(req.runId, { gen, fn: dispatch, budget });
    try {
      dispatch({
        kind: "enqueued",
        at: this.d.clock.now(),
        budget,
        ...(req.deadlineAt === undefined ? {} : { deadlineCapAt: req.deadlineAt }),
        ...(req.displayMeta === undefined ? {} : { meta: req.displayMeta }),
      });
      // CC4/CP3: an already-expired deadlineAt cap settles the run as
      // failed(config) directly inside the `enqueued` reducer branch, before
      // any timer is armed. Must be checked here — before pool.acquire — or
      // this run would still occupy a slot despite already being terminal.
      if (state.outcome) return state.outcome;
      const acq = await this.guard(
        this.d.pool.acquire(req.runId, {
          ...(req.slotless === undefined ? {} : { slotless: req.slotless }),
          queueWaitMs: budget.queueWaitMs,
          signal: cancel.signal,
        }),
        remainingFor(budget.queueWaitMs, this.d.clock.now(), state.deadlines).ms,
        cancel,
        "queue",
      );
      if (acq.ok !== true) {
        dispatch({
          kind: "slot_denied",
          at: this.d.clock.now(),
          // pool.acquire never rejects (it resolves {ok:false,"aborted"}); a
          // rejection here is a pool bug and keeps the historical aborted mapping.
          reason: acq.reason === "timeout" ? "queue_timeout" : "aborted",
        });
        return state.outcome!;
      }
      if (!("ticket" in acq.value)) throw new Error("slot acquisition returned no ticket");
      ticket = acq.value.ticket;
      dispatch({ kind: "slot_acquired", at: this.d.clock.now() });
      dispatch({ kind: "phase_entered", at: this.d.clock.now(), phase: "session_create" });
      // consult (plan §4.4): a fork copy is just "an existing session file" —
      // open it through the same driver.resume seam as Agent({resume}); the
      // driver is unchanged (cwd arrives via SpawnRequest.cwd, overriding the
      // header cwd). forkSessionFrom is admitted mutually exclusive with
      // resumeFrom upstream, and wins the ?? so the ordering is total anyway.
      const openFile = req.forkSessionFrom ?? req.resumeFrom;
      createP = openFile
        ? this.d.driver.resume
          ? this.d.driver.resume(openFile, req)
          : Promise.reject(new Error("session driver does not support resume"))
        : this.d.driver.create(req);
      const createBudget = remainingFor(budget.startupMs, this.d.clock.now(), state.deadlines);
      const created = await this.guard(createP, createBudget.ms, cancel, "create");
      if (!created.ok) {
        this.d.driver.onLateArrival(createP, (h) => {
          this.d.reaper.disposeLate(req.runId, gen, h); // sync
          // 迟到会话的写入（appendThinkingLevelChange 等）已在 createP resolve
          // 前完成；dispose 后再回调删除（幂等，覆盖 _persist 重生残片）。
          this.notifyReaped(req, h.sessionId);
        });
        createP = undefined;
        dispatch({
          kind: "startup_failed",
          at: this.d.clock.now(),
          phase: "session_create",
          // A driver rejection (unknown model, createAgentSession throwing) is
          // failed(cause), not timed_out("cancelled"): only the startup budget
          // expiring is a timeout. A cancel/stop has already moved the run to
          // abort_grace, where startup_failed is absorbed either way.
          error: created.reason === "error" ? startError(created.error) : error(created.reason, "timeout"),
        });
        return state.outcome!;
      }
      handle = created.value;
      this.activeHandles.set(req.runId, { gen, handle });
      createP = undefined;
      // M-B2: the session's actual model — authoritative over spawn-time
      // displayMeta (covers pi-default-model runs and resume).
      const modelRef = handle.getModelRef?.();
      dispatch({
        kind: "session_created",
        at: this.d.clock.now(),
        sessionId: handle.sessionId,
        ...(handle.sessionFile === undefined ? {} : { sessionFile: handle.sessionFile }),
        ...(modelRef === undefined ? {} : { model: modelRef }),
      });
      dispatch({ kind: "phase_entered", at: this.d.clock.now(), phase: "extension_bind" });
      const bindBudget = remainingFor(budget.bindMs, this.d.clock.now(), state.deadlines);
      const bound = await this.guard(
        this.d.driver.bind(handle, (e) => {
          dispatch({ kind: "session_event", at: this.d.clock.now(), event: e });
          // X11 TS3: setActiveTools only ever happens at a turn boundary, never
          // mid tool_exec. TS-race guard: re-check terminality *after*
          // dispatch() above has already folded this same event into the
          // state machine, so a deadline_fired arriving in the same tick is
          // reflected in state.status before we decide whether to enforce.
          if (e.t === "turn_end" && req.toolScope && !isTerminalStatus(state.status)) {
            req.toolScope.enforcer.onTurnBoundary(handle!, req.toolScope.policy);
          }
        }),
        bindBudget.ms,
        cancel,
        "bind",
      );
      if (!bound.ok) {
        this.sealBeforeTerminal(req.runId, gen);
        dispatch({
          kind: "startup_failed",
          at: this.d.clock.now(),
          phase: "extension_bind",
          error: bound.reason === "error" ? startError(bound.error) : error(bound.reason, "timeout"),
        });
        return state.outcome!;
      }
      // X11: first application, right after bind and before prompt dispatch
      // (architecture §7.5 onBind). Guarded the same way as onTurnBoundary.
      if (req.toolScope && !isTerminalStatus(state.status)) req.toolScope.enforcer.onBind(handle, req.toolScope.policy);
      this.d.watchdog.arm(req.runId, gen);
      // M4: 迁入 prompt_dispatch——此前该相位无进入点，prompt() 挂起时 run 停在
      // extension_bind，watchdog 接线后会以 bindMs 误报 "extension_bind" 超时。
      // 迁入后由 firstEventMs 约束，语义为 no_first_event。
      dispatch({ kind: "phase_entered", at: this.d.clock.now(), phase: "prompt_dispatch" });
      // timeout-notify (arch §4.6 ③): the prompt guard must follow the *live*
      // effective deadline (graceUntil ?? deadlineAt), not a millisecond count
      // frozen at dispatch time — otherwise a deadline_extended would silently
      // fail and the run would still die at the old instant. queue/create/bind
      // guards above stay one-shot: those phases never grace nor extend (D-14).
      const prompted = await this.guardUntil(
        handle.prompt(req.prompt),
        () => effectiveDeadlineAt(state.deadlines),
        cancel,
        "prompt",
        () => {
          // Same due-source choice as the watchdog tick: total_grace while a
          // grace window is armed, total otherwise.
          const timer = state.deadlines.graceUntil !== undefined ? "total_grace" : "total";
          this.fireDeadline(req.runId, gen, { kind: "deadline_fired", at: this.d.clock.now(), timer, reason: "total" });
        },
      );
      const finalText = prompted.ok ? handle.getLastAssistantText() : undefined;
      // pi resolves prompt() even when the final turn errored (stopReason
      // "error" surfaces only on the message). Without this, a provider
      // crash looks like "completed with empty text".
      const turnError = prompted.ok ? handle.getTurnError?.() : undefined;
      const promptError = ((): ErrorInfo | undefined => {
        if (prompted.ok) return turnError === undefined ? undefined : error(turnError, "model");
        if (prompted.reason === "timeout") return error("timeout", "timeout");
        // prompt() itself rejected (pi threw before/while running the turn —
        // e.g. "No API key found for <provider>.") on a run nobody asked to
        // stop: failed with the real cause. A rejection racing a stop/deadline
        // (stopCause/timeoutReason already recorded) takes the cancel mapping
        // below, so abort/timeout semantics are unchanged.
        if (prompted.reason === "error" && state.diag.stopCause === undefined && state.diag.timeoutReason === undefined)
          return startError(prompted.error);
        // M4: guard 因 cancel 解除时，若状态机已因 watchdog 超时进入 abort_grace
        // （timeoutReason/stopCause 已记录），结果必须是 timed_out 而非 aborted。
        if (state.diag.timeoutReason !== undefined || state.diag.stopCause === "timeout") {
          // Name the timer that actually fired (tool / idle / total …) — a
          // sub-phase kill must not read like a total-budget timeout.
          const killedAt = state.phase === "abort_grace" ? state.diag.phaseEnteredAt : this.d.clock.now();
          return error(`${describeTimeout(state.diag, killedAt)}; prompt cancelled`, "timeout");
        }
        return error("cancelled", "aborted");
      })();
      this.sealBeforeTerminal(req.runId, gen);
      dispatch({
        kind: "prompt_settled",
        at: this.d.clock.now(),
        ...(promptError === undefined ? {} : { error: promptError }),
        ...(finalText === undefined ? {} : { text: finalText }),
      });
      return state.outcome!;
    } catch (e) {
      this.sealBeforeTerminal(req.runId, gen);
      dispatch({ kind: "prompt_settled", at: this.d.clock.now(), error: error(e) });
      return state.outcome!;
    } finally {
      this.sealBeforeTerminal(req.runId, gen);
      cancel.detach();
      this.d.watchdog.disarm(req.runId, gen);
      ticket?.release();
      if (createP) {
        // Review follow-up (P0b): this fallback is reached when the
        // guard-failure branch's own onLateArrival call threw (that is the
        // seam that leaves createP set into the catch path). A throwing
        // driver hook here must not propagate — an exception escaping the
        // finally would skip runReap()/notifyReaped() and the map cleanup
        // below and reject run() itself — so it is swallowed and reported
        // exactly like a throwing onReaped/beforeReap.
        try {
          this.d.driver.onLateArrival(createP, (h) => {
            this.d.reaper.disposeLate(req.runId, gen, h);
            this.notifyReaped(req, h.sessionId); // same ordering guarantee as the guard-failure path above
          });
        } catch (e) {
          this.d.onExtensionError?.("onLateArrival", req.runId, e instanceof Error ? e.message : String(e));
        }
      }
      const reap: ReapInput = {
        runId: req.runId,
        generation: gen,
        cancel,
        ...(handle ? { handle, sessionId: handle.sessionId } : {}),
        ...(state.diag.stopCause ? { cause: state.diag.stopCause } : {}),
        phase: state.phase,
        budget,
      };
      const beforeReap = this.d.beforeReap;
      const outcomeForHook = state.outcome;
      const runReap = async () => {
        if (beforeReap && outcomeForHook) {
          try {
            await this.withTimeout(
              Promise.resolve().then(() =>
                beforeReap(outcomeForHook, { cwd: req.cwd ?? "", deadlineMs: budget.reapMs }),
              ),
              budget.reapMs,
            );
          } catch (e) {
            this.d.onExtensionError?.("beforeReap", req.runId, e instanceof Error ? e.message : String(e));
          }
        }
        return this.d.reaper.reap(reap);
      };
      void runReap()
        .catch(() => undefined)
        .then(() => this.notifyReaped(req, handle?.sessionId));
      const dEntry = this.dispatchers.get(req.runId);
      if (dEntry && dEntry.gen === gen) this.dispatchers.delete(req.runId);
      const cEntry = this.activeCancels.get(req.runId);
      if (cEntry && cEntry.gen === gen) this.activeCancels.delete(req.runId);
      const hEntry = this.activeHandles.get(req.runId);
      if (hEntry && hEntry.gen === gen) this.activeHandles.delete(req.runId);
      const sealedGen = this.sealedGenerations.get(req.runId);
      if (sealedGen === gen) this.sealedGenerations.delete(req.runId);
    }
  }
  /** consult (§4.4): post-reap cleanup seam. Swallows everything — a cleanup callback must never affect the runner. */
  private notifyReaped(req: ResolvedSpawnRequest, sessionId?: string) {
    try {
      this.d.onReaped?.(req.runId, req.forkSessionFrom, sessionId);
    } catch {
      /* 清理回调不得影响 runner */
    }
  }
  /** Bounded generic await, no cancel signal (H3 beforeReap only needs a timeout, not abort-linkage). */
  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = this.d.clock.setTimer(Math.max(0, ms), () => {
        if (done) return;
        done = true;
        reject(new Error(`timed out after ${ms}ms`));
      });
      p.then(
        (v) => {
          if (done) return;
          done = true;
          this.d.clock.clearTimer(timer);
          resolve(v);
        },
        (e) => {
          if (done) return;
          done = true;
          this.d.clock.clearTimer(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }
  /**
   * timeout-notify (arch §4.6 ③ + guard-race fix): deadline-following guard.
   * When the timer fires it does NOT immediately conclude timeout — it re-reads
   * deadlineOf():
   *   - undefined → do not re-arm (defense only: D-11 forbids totalMs ≤ 0 at
   *     the config layer, so the normal path always has a deadline; this branch
   *     exists so directly-constructed RunDeadlines never cause setTimer(0)
   *     fake timeouts),
   *   - due > now → re-arm for due - now (the deadline was extended),
   *   - due <= now → the deadline genuinely expired: invoke onExpired() (which
   *     routes the expiry through the reducer via fireDeadline — the
   *     grace-vs-kill decision lives in the state machine, not here) and then
   *     re-read deadlineOf() once more: if it moved forward (grace entered, or
   *     an extension landed) re-arm; if it is unchanged (reducer took the kill
   *     path, or defensively ruled the fire illegal) resolve timeout — the
   *     original semantics.
   *
   * This makes the prompt guard a second, EXACT producer of deadline_fired
   * alongside the watchdog's 1Hz tick. Without it the guard (armed at the exact
   * deadline) would always beat the watchdog's first qualifying tick (which
   * lands strictly after the deadline) and kill the run before the grace
   * window could ever be entered. The two producers are redundant and safe:
   * whichever fires first triggers, the other is idempotent — the reducer
   * rules a deadline_fired whose timer is no longer in armedTimers illegal,
   * and fireDeadline() re-reads the state and only cancels when the run
   * actually transitioned to stopping/terminal (so a guard-triggered fire
   * that enters grace never cancels the prompt).
   * Rearming reuses the same Clock port and finish() clears the pending timer,
   * so no long-lived timer is added (pi -p print mode unaffected, R-12).
   */
  private async guardUntil<T>(
    p: Promise<T>,
    deadlineOf: () => Millis | undefined,
    cancel: CancelHandle,
    label: string,
    onExpired?: () => void,
  ): Promise<GuardResult<T>> {
    let timer: ReturnType<Clock["setTimer"]> | undefined;
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: GuardResult<T>) => {
        if (done) return;
        done = true;
        if (timer) {
          this.d.clock.clearTimer(timer);
          timer = undefined;
        }
        cancel.signal.removeEventListener("abort", onAbort);
        resolve(r);
      };
      const onAbort = () => finish({ ok: false, reason: "cancelled" });
      const arm = () => {
        const due = deadlineOf();
        if (due === undefined) return; // defense branch (D-11) — never setTimer(0)
        const now = this.d.clock.now();
        if (due > now) {
          timer = this.d.clock.setTimer(due - now, onTimer);
          return;
        }
        // Expired: let the reducer decide grace vs kill, then re-read.
        onExpired?.();
        const after = deadlineOf();
        const afterNow = this.d.clock.now();
        if (after !== undefined && after > afterNow) {
          timer = this.d.clock.setTimer(after - afterNow, onTimer);
          return;
        }
        // Note: when the reducer took the kill path, fireDeadline already
        // cancelled the guard (onAbort → finish("cancelled") ran synchronously
        // inside onExpired), so this finish() is a done-guarded no-op there.
        finish({ ok: false, reason: "timeout" });
      };
      const onTimer = () => {
        timer = undefined;
        arm();
      };
      if (cancel.signal.aborted) return onAbort();
      arm();
      cancel.signal.addEventListener("abort", onAbort, { once: true });
      p.then(
        (value) => finish({ ok: true, value }),
        (rejection: unknown) => finish({ ok: false, reason: "error", error: rejection }),
      ).catch(() => undefined);
    });
  }
  private async guard<T>(p: Promise<T>, ms: number, cancel: CancelHandle, label: string): Promise<GuardResult<T>> {
    let timer: ReturnType<Clock["setTimer"]> | undefined;
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: GuardResult<T>) => {
        if (done) return;
        done = true;
        if (timer) this.d.clock.clearTimer(timer);
        cancel.signal.removeEventListener("abort", onAbort);
        resolve(r);
      };
      const onAbort = () => finish({ ok: false, reason: "cancelled" });
      if (cancel.signal.aborted) return onAbort();
      timer = this.d.clock.setTimer(Math.max(0, ms), () => finish({ ok: false, reason: "timeout" }));
      cancel.signal.addEventListener("abort", onAbort, { once: true });
      p.then(
        (value) => finish({ ok: true, value }),
        (rejection: unknown) => finish({ ok: false, reason: "error", error: rejection }),
      ).catch(() => undefined);
    });
  }
}
