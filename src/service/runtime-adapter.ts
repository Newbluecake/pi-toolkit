import type { Clock } from "../core/clock.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { applyStructuredOutputPolicy, validateAgainstSchema } from "../core/json-schema.js";
import type { SnapshotStore } from "../core/store.js";
import type {
  ConsultExpertRef,
  DeadlineNotice,
  ErrorInfo,
  LifecycleEvent,
  RunDiagnostics,
  RunEffect,
  RunExitFacts,
  RunId,
  RunOutcome,
  RunSnapshot,
  SessionSpec,
  StopCause,
  SubagentExtensionPoints,
  WorktreeDisposal,
  Millis,
} from "../core/types.js";
import { displayAgentType } from "../core/types.js";
import { deliveryKey } from "../core/delivery-key.js";
import type { Notifier } from "../delivery/notifier.js";
import { mergeExtensionPoints } from "../extensions/registry.js";
import { writeLateWorktreeDisposition } from "../adapters/worktree-disposition-sink.js";
import { TASK_PROMPT_CAP } from "../core/state-machine.js";
import {
  BasicEffectInterpreter,
  RuntimeRunner,
  type ResolvedSpawnRequest,
  type RunnerDeps,
} from "../runtime/runner.js";
import type { Reaper } from "../runtime/reaper.js";
import type { SessionDriver } from "../runtime/session-driver.js";
import type { SlotPool } from "../runtime/slot-pool.js";
import {
  buildToolScopePolicy,
  bashJobGrant,
  CONSULT_READONLY_TOOLS,
  createToolScopeEnforcer,
} from "../runtime/tool-scope.js";
import type { Watchdog } from "../runtime/watchdog.js";
import { threadThroughRequestFields } from "./request-threading.js";
import { createAgentTool, type NestedSpawnPort } from "../tools/agent-tool.js";
import type { ResolveExpertsResult } from "../consult/index.js";
import { createStructuredOutputTool } from "../tools/structured-output-tool.js";
import { createMessageAgentTool } from "../tools/message-agent-tool.js";
import { createSetModelTool } from "../tools/set-model-tool.js";
import type { FabricRouter } from "../fabric/router.js";
import { createMentionChannel } from "../fabric/mention.js";
import type { MentionRegistry } from "../mention/registry.js";
import type { QueryService } from "./query-service.js";
import type { SpawnService } from "./spawn-service.js";
import type { LifecycleSink, Runner, RunnerCallbacks, RunnerSpec } from "./ports.js";

export interface RuntimeAdapterDeps {
  clock: Clock;
  driver: SessionDriver;
  pool: SlotPool;
  store: SnapshotStore;
  watchdog: Watchdog;
  reaper: Reaper;
  notifier: Notifier;
  /** Global lifecycle sink (e.g. forwarded to pi.events); per-run callbacks are additionally invoked. */
  onLifecycle?: LifecycleSink;
  /** M2 Wave 1: the four documented extension hooks (architecture §7.1), pre-merged or raw — mergeExtensionPoints() is idempotent over a single already-merged entry. */
  extensions?: readonly SubagentExtensionPoints[];
  /**
   * X1 (agent tree): late-bound sink for post-settlement worktree display
   * state (beforeReap → spawn-service live records). A holder rather than a
   * value for the same reason as nestedSpawn: the adapter is constructed
   * before createSpawnService exists (spawn needs the runner as its own dep);
   * stack.ts fills `.current` once spawn is up. The durable store is patched
   * directly by the wrapper below — only the live records need this sink,
   * because the live registry shadows the store for the current session.
   */
  worktreeDiag?: { current?: (runId: RunId, disposition: WorktreeDisposal) => void };
  /**
   * X3: lazily-resolved narrow spawn port used to build the nested Agent
   * tool injected into a child session's own SessionSpec.customTools. A
   * getter (not a value) because createRuntimeRunnerAdapter is constructed
   * before createSpawnService exists in index.ts (SpawnService itself needs
   * the runner as one of its own deps) — the getter is called at spawn time,
   * by which point index.ts has filled in the ref.
   */
  nestedSpawn?: () => NestedSpawnPort | undefined;
  /** Live cap for nested Agent blocking result text. */
  resultMaxChars?: () => number;
  /**
   * L1 (agent-tool pool-full plan §2): pool-full dispatch policy for the
   * nested Agent tool — forwarded verbatim to `createAgentTool`'s
   * `queueWhenFull` dep (see agent-tool.ts). Practically a no-op today
   * (nested calls are always `forceSlotless`), wired only to keep "same rule
   * for nested" true if that ever changes.
   */
  queueWhenFull?: () => boolean;
  /** X3: forwarded to RunnerDeps.onChildAbort (see runtime/runner.ts) — called whenever this run's cancellation is triggered, so the caller can cascade-abort its children. */
  onChildAbort?: (runId: RunId, cause: StopCause) => void;
  /** set_model: fuzzy model-hint resolver (same instance spawn admission uses — stack.ts Stack.models). */
  resolveModelHint?: (hint: string) => { provider: string; id: string } | undefined;
  /** set_model (review m4): available-model candidates (stack.models.available passthrough) so the
   *  subagent-side resolution-failure candidate listing matches the host form's E2 text. */
  availableModels?: () => readonly { provider: string; id: string; name?: string }[];
  /**
   * timeout-notify: sink for `notify_deadline` effects (grace entered /
   * deadline extended) of top-level runs. stack.ts wires this to the
   * `subagent:timeout` channel (delivery/deadline-notice.ts); child runs are
   * filtered before this sink is ever called (CC2 / D-8).
   */
  onDeadlineNotice?: (notice: DeadlineNotice) => void;
  /** Optional fabric surface; absent means no message_agent injection. */
  fabric?: {
    router: FabricRouter;
    mention?: {
      registry: MentionRegistry;
      query: () => QueryService | undefined;
      spawn: () => SpawnService | undefined;
    };
  };
  /**
   * consult (consult plan §6 C-12; cwd getter — workflow-worktree plan §2
   * D10): per-run consult-tool factory. Injected into a (non-consult) child
   * run iff its dispatcher attached a resolved expert whitelist
   * (`SpawnRequest.consultExperts`). Returns undefined when consult is
   * disabled or the whitelist is empty — no tool, no grant. `selfCwd` is a
   * getter (structural type, this module never imports consult's own
   * `ConsultAskerCwd`) because the run's cwd cell is written once, AFTER H2
   * resolves — the factory is called before H2, but its returned tool's
   * `execute()` only ever runs later, once the session exists.
   */
  consult?: (
    selfRunId: RunId,
    selfCwd: () => { cwd: string; isolated: boolean },
    whitelist: readonly ConsultExpertRef[],
  ) => ToolDefinition | undefined;
  /** consult: dispatch-time `experts` resolver handed to the nested Agent tool (same trust level as `resume`, plan §5.2). */
  consultResolveExperts?: (refs: readonly string[]) => ResolveExpertsResult;
  /**
   * consult §4.4: forwarded to RunnerDeps.onReaped (runner calls it after
   * physical reap / late disposal) AND invoked by this adapter directly on
   * its early-exit paths (settleConfigFailure and any pre-runner throw) —
   * those never reach the runner's own finally, so the fork copy would leak
   * to the 24h sweep without this second call site. Must be idempotent.
   */
  onReaped?: (runId: RunId, forkSessionFrom?: string, sessionId?: string) => void;
  /**
   * bash-timeout-grace plan §3.2 (P5 wiring of the P0b-frozen `RunnerDeps`
   * field): forwarded verbatim to `RunnerDeps.sealSession` — `sealBeforeTerminal`
   * calls this synchronously, exactly once per (runId, generation), before the
   * FIRST terminal reducer input, so the returned `RunExitFacts` (if any) can
   * be folded into `diag.exitFacts` before the run settles (I-SEAL).
   */
  sealSession?: (runId: RunId, sessionId: string) => RunExitFacts | undefined;
  /**
   * bash-timeout-grace plan §3.4 (P5): called every time `onStateChange` sees
   * a defined `state.sessionId` for a run (not just the first time — the
   * callee, `src/stack.ts`'s `attachHost`, is itself idempotent/cheap). Lets
   * the host attach a `HostRunView` (watchdog due date / hard deadline /
   * maxExtensions / stopping / tool-return-lag telemetry) into the process-
   * global `ChildBashRegistry` for the child session's own bash tools to read.
   */
  onSessionSeen?: (runId: RunId, sessionId: string) => void;
  /**
   * bash-timeout-grace plan §3.10: the `bashJobs.childSessions` setting gate,
   * captured once per stack build (never changes mid-session) — feeds
   * `bashJobGrant` below so a spawned child's agent type deciding it declares
   * `tools` (or none) determines whether `bash_job` is added to
   * `grantedReserved` (and, when the type restricts `tools`, merged into
   * `sessionSpec.tools`) for that particular run.
   */
  childBashJobsEnabled?: boolean;
}

/**
 * timeout-notify: the `notify_deadline` effect handler, exported as a pure
 * function so it can be unit-tested without a reducer (RK-10: feed a
 * hand-built EffectEnvelope to a BasicEffectInterpreter that registers only
 * this handler). Non-notify effects pass through untouched; child-run
 * notices are dropped here (CC2 — same position and pattern as the
 * enqueue_delivery child guard below): a child run is owned by its parent
 * and must never push a deadline notice into the top-level context (D-8).
 */
export function deadlineNoticeHandler(
  childRunIds: ReadonlySet<string>,
  sink?: (notice: DeadlineNotice) => void,
): (e: RunEffect) => void {
  return (e) => {
    if (e.kind !== "notify_deadline") return;
    if (childRunIds.has(e.notice.runId)) return; // CC2 (D-8)
    sink?.(e.notice);
  };
}

/**
 * Bounded await for H2 (resolveSessionSpec): distinct from RuntimeRunner's
 * internal `guard()` (which races an AbortSignal too) because this hook has
 * no cancel-linkage requirement in the architecture, only a startupMs-scale
 * timeout ("调用方施加 startupMs 超时") — and because a thrown/timed-out hook
 * must surface its *real* message (used for G4 diagnosability), which
 * guard()'s generic "cancelled" reason would otherwise erase.
 */
function withStartupTimeout<T>(
  p: Promise<T>,
  ms: number,
  clock: Clock,
): Promise<{ ok: true; value: T } | { ok: false; error: ErrorInfo; timedOut: boolean }> {
  return new Promise((resolve) => {
    let done = false;
    const timer = clock.setTimer(Math.max(0, ms), () => {
      if (done) return;
      done = true;
      resolve({
        ok: false,
        error: { kind: "config", message: `resolveSessionSpec timed out after ${ms}ms`, retryable: false },
        timedOut: true,
      });
    });
    p.then(
      (value) => {
        if (done) return;
        done = true;
        clock.clearTimer(timer);
        resolve({ ok: true, value });
      },
      (err) => {
        if (done) return;
        done = true;
        clock.clearTimer(timer);
        resolve({
          ok: false,
          error: { kind: "config", message: err instanceof Error ? err.message : String(err), retryable: false },
          timedOut: false,
        });
      },
    );
  });
}

/**
 * H2 failure path ("钩子抛错/超时 → run failed(config)，不得静默继续"): the hook
 * runs before any slot is acquired or session created, so there is no
 * RuntimeRunner state to finish through — build the terminal RunOutcome
 * directly instead of faking a state-machine run.
 */
function failedConfigOutcome(runId: string, error: ErrorInfo, now: number, label?: string): RunOutcome {
  const diag: RunDiagnostics = {
    createdAt: now,
    phase: "resolve_config",
    phaseEnteredAt: now,
    pendingTools: 0,
    turns: 0,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
    ...(label !== undefined ? { label } : {}),
    error,
  };
  return { runId, status: "failed", error, turns: 0, durationMs: 0, diag };
}

/**
 * Assembles the prompt actually sent to the model turn from the agent type's
 * systemPrompt + promptMode and the caller's request prompt (architecture
 * §5.12 / agent .md frontmatter semantics: "replace" vs "append").
 *
 * "replace" types do NOT get their system prompt here: it travels as
 * `SessionSpec.systemPrompt` and replaces pi's base system prompt (see the
 * sessionSpec assembly below). It used to be silently dropped on both paths,
 * so every replace-mode type ran with no role prompt at all.
 */
function buildPrompt(spec: RunnerSpec): string {
  const { type, request } = spec;
  if (!type.systemPrompt || type.promptMode === "replace") return request.prompt;
  return `${type.systemPrompt}\n\n${request.prompt}`;
}

/**
 * workflow-worktree plan D9 ("只读提示的 prompt 路径", v2.1 condition 4): folds an H2
 * extension's `SessionSpec.promptNotes` into the actual model-facing prompt.
 * `notes` undefined or empty ⇒ returns the SAME string reference byte-
 * identical (no-op fast path, so `linkPaths: []` never allocates a new
 * string and callers can `===`-compare it against `buildPrompt(spec)`).
 */
export function appendPromptNotes(prompt: string, notes?: readonly string[]): string {
  if (!notes || notes.length === 0) return prompt;
  return `${prompt}\n\n${notes.join("\n\n")}`;
}

/**
 * The real cross-layer seam: bridges the L2 execution engine (RuntimeRunner,
 * hang-proof but call-shaped as `run(req, budget)`) to the L3 service
 * contract (ports.Runner, call-shaped as `run(spec, callbacks)`), and wires
 * the state machine's effects (persist_snapshot / enqueue_delivery /
 * emit_lifecycle) to the actual SnapshotStore / Notifier / lifecycle sinks —
 * none of which RuntimeRunner touches directly (by design, see RunnerDeps).
 *
 * Also closes the effect-failure feedback loop: BasicEffectInterpreter's
 * onFailure callback re-dispatches `effect_failed` into the still-running
 * (runId, generation), which is what actually drives the persist_snapshot
 * durable-retry state machine (core/state-machine.ts handleEffectFailed) and
 * makes `outcome.persistFailed` observable (G5a).
 */
export function createRuntimeRunnerAdapter(deps: RuntimeAdapterDeps): Runner {
  const merged = mergeExtensionPoints(deps.extensions ?? []);
  // D13 (v2.1 condition 2): flipped once by `dispose()` (stack.ts rebuild /
  // session_shutdown). After that, the H3 write-back below stops touching
  // `deps.store`/`deps.worktreeDiag` — both belong to a stack that's about to
  // be replaced — and instead routes to the CURRENT session's durable sink
  // (adapters/worktree-disposition-sink.ts), which the next stack registers
  // independently.
  let disposed = false;
  const perRun = new Map<string, RunnerCallbacks>();
  // CC2: runs spawned with a parentRunId (i.e. workflow/nested children, X3)
  // must not enqueue a top-level completion notification (workflow design
  // §7.4 gap ① "child ownership" / §8.2 CC2). Tracked by runId, set at the
  // start of run() (before any await) and cleared in its `finally`, so the
  // shared enqueue_delivery interpreter below — which only sees the effect
  // payload, not the originating RunnerSpec — can still tell child runs
  // apart from top-level ones.
  const childRunIds = new Set<string>();
  const schemaRunIds = new Set<string>();
  const policyPendingRunIds = new Map<string, number>();
  let runtime!: RuntimeRunner;
  const effects = new BasicEffectInterpreter(
    {
      persist_snapshot: (e) => {
        if (e.kind !== "persist_snapshot") return;
        deps.store.put(e.snapshot);
        perRun.get(e.snapshot.runId)?.onSnapshot?.(e.snapshot);
      },
      enqueue_delivery: (e) => {
        if (e.kind !== "enqueue_delivery") return;
        // CC2: child runs are consumed exclusively by their owner (the parent
        // run / future workflow orchestrator), never by the top-level outbox
        // — otherwise every child of a busy parent would independently spam a
        // top-level completion notification (workflow design §8.2 CC2).
        if (childRunIds.has(e.payload.runId)) return;
        const hold = schemaRunIds.has(e.payload.runId);
        if (hold) policyPendingRunIds.set(e.payload.runId, e.payload.generation);
        deps.notifier.enqueue(e.payload, { hold });
      },
      emit_lifecycle: (e) => {
        if (e.kind !== "emit_lifecycle") return;
        perRun.get(e.event.runId)?.onLifecycle?.(e.event);
        deps.onLifecycle?.(e.event);
        merged.onLifecycle?.(e.event); // H1: run lifecycle bypass observer
      },
      // timeout-notify: grace/extended notices ride the effect bus
      // (best_effort); CC2 filtering lives inside deadlineNoticeHandler.
      notify_deadline: deadlineNoticeHandler(childRunIds, deps.onDeadlineNotice),
    },
    (runId, generation, kind, err) => runtime.notifyEffectFailed(runId, generation, kind as RunEffect["kind"], err),
  );
  const runnerDeps: RunnerDeps = {
    clock: deps.clock,
    driver: deps.driver,
    pool: deps.pool,
    store: deps.store,
    watchdog: deps.watchdog,
    reaper: deps.reaper,
    effects,
    // RuntimeRunner never calls these directly (all real side effects flow
    // through `effects` above); kept as inert no-ops to satisfy RunnerDeps.
    emit: () => undefined,
    deliver: () => undefined,
    ...(merged.beforeReap
      ? {
          // H3, X1-wrapped: enrich the ctx with the post-settlement diag
          // write-back the worktree extension uses to report its disposal
          // outcome (agent-tree `⎇` marker). Patches BOTH the durable store
          // snapshot and — via the late-bound worktreeDiag holder — the
          // spawn-service live record, which shadows the store in the live
          // registry. Best-effort by design: a failure here must never reach
          // the hook (the marker just stays "⎇ wt").
          beforeReap: (outcome: RunOutcome, ctx: { cwd: string; deadlineMs: Millis }) => {
            const hook = merged.beforeReap!;
            const setWorktreeDisposition = (disposition: WorktreeDisposal): void => {
              // D13: after dispose(), this stack's store/live-sink belong to
              // a replaced stack — route the report to whichever session
              // CURRENTLY owns the durable sink instead (never back into the
              // about-to-be-discarded registry, which could resurrect this
              // run into the WRONG session's read-back).
              if (disposed) {
                writeLateWorktreeDisposition({
                  runId: outcome.runId,
                  state: disposition.state,
                  ...(disposition.branch === undefined ? {} : { branch: disposition.branch }),
                  ...(disposition.path === undefined ? {} : { path: disposition.path }),
                  at: deps.clock.now(),
                });
                return;
              }
              deps.worktreeDiag?.current?.(outcome.runId, disposition);
              try {
                const snapshot = deps.store.get(outcome.runId);
                if (snapshot)
                  deps.store.put({
                    ...snapshot,
                    diag: { ...snapshot.diag, worktree: disposition },
                    updatedAt: deps.clock.now(),
                  });
              } catch {
                /* best effort — see comment above */
              }
            };
            return hook(outcome, { ...ctx, setWorktreeDisposition });
          },
        }
      : {}), // H3
    onStateChange: (runId, state) => {
      // bash-timeout-grace plan §3.4 (P5): fires on every state change, not
      // gated behind `perRun`'s onSnapshot callback — the child bash job
      // registry must see `state.sessionId` as soon as it exists regardless
      // of whether this particular run wired a live snapshot observer.
      if (state.sessionId !== undefined) {
        try {
          deps.onSessionSeen?.(runId, state.sessionId);
        } catch (error) {
          console.warn(`[pi-subagent] onSessionSeen failed for run ${runId} (ignored): ${error}`);
        }
      }
      const cb = perRun.get(runId)?.onSnapshot;
      if (!cb) return;
      cb({
        runId,
        generation: state.generation,
        status: state.status,
        phase: state.phase,
        deadlines: state.deadlines,
        diag: state.diag,
        updatedAt: deps.clock.now(),
        // consult plan §9 T-18 (package E finding): the terminal `settle()`
        // transition (core/state-machine.ts) has always spread
        // `state.parentRunId` into its snapshot; this LIVE per-dispatch
        // projection never did, so every nested run (X3 Agent tool spawns
        // included, not just consult) showed up in the fleet widget / any
        // `query.list({ parentRunId })` lookup as non-nested until it
        // settled. `state.parentRunId` is set once at `createInitialState`
        // and never changes, so this is a pure gap-fill, not new behavior.
        ...(state.parentRunId === undefined ? {} : { parentRunId: state.parentRunId }),
      });
    },
    onExtensionError: (hook, runId, error) =>
      console.warn(`[pi-subagent] extension hook ${hook} failed for run ${runId} (ignored): ${error}`),
    ...(deps.onChildAbort ? { onChildAbort: deps.onChildAbort } : {}), // X3 cascade
    // consult §6 C-12 / §4.4: forwarded to RunnerDeps.onReaped — the field
    // itself is package B's addition to RunnerDeps (frozen surface
    // `onReaped(runId, forkSessionFrom?)`); spreading it here is a no-op
    // until B lands (the runner simply ignores the extra property).
    ...(deps.onReaped ? { onReaped: deps.onReaped } : {}),
    // bash-timeout-grace plan §3.2 (P0b-frozen field, P5 wiring): forwarded
    // verbatim — `sealBeforeTerminal` is the runner's own call site.
    ...(deps.sealSession ? { sealSession: deps.sealSession } : {}),
  };
  runtime = new RuntimeRunner(runnerDeps);
  /**
   * M1 验收 Minor fix (X7 前置): the H2 failure path runs before
   * RuntimeRunner exists for this run, so it used to bypass every
   * observability channel — no terminal snapshot in the store (QueryService,
   * /agent status and the fleet panel couldn't see the run at all) and no
   * lifecycle event. Persist + emit here through the same channels the
   * effect interpreter uses for state-machine-driven outcomes.
   */
  const settleConfigFailure = (runId: string, error: ErrorInfo, label?: string): RunOutcome => {
    const now = deps.clock.now();
    const outcome = failedConfigOutcome(runId, error, now, label);
    const snapshot: RunSnapshot = {
      runId,
      generation: outcome.diag.generation,
      status: "failed",
      phase: "settled", // terminal-snapshot convention (state-machine.ts finish): diag.phase keeps the real phase
      deadlines: { enqueuedAt: outcome.diag.createdAt, deadlineAt: undefined, queueDeadlineAt: undefined },
      diag: outcome.diag,
      outcome,
      updatedAt: now,
    };
    deps.store.put(snapshot);
    perRun.get(runId)?.onSnapshot?.(snapshot);
    const event: LifecycleEvent = { runId, generation: outcome.diag.generation, status: "failed", at: now };
    perRun.get(runId)?.onLifecycle?.(event);
    deps.onLifecycle?.(event);
    merged.onLifecycle?.(event); // H1: run lifecycle bypass observer
    if (!childRunIds.has(runId)) {
      try {
        deps.notifier.enqueue({
          key: deliveryKey(runId, outcome.diag.generation),
          runId,
          generation: outcome.diag.generation,
          status: outcome.status,
          textPreview: "",
          ...(outcome.diag.label === undefined ? {} : { label: outcome.diag.label }),
          ...(outcome.error?.message === undefined ? {} : { failReason: outcome.error.message }),
          diag: {
            phase: outcome.diag.phase,
            status: outcome.status,
            pendingTools: outcome.diag.pendingTools,
            staleInputs: outcome.diag.staleInputs,
            degraded: outcome.diag.degraded.length,
          },
          createdAt: outcome.diag.createdAt,
          reconcileRound: 0,
        });
      } catch (err) {
        console.warn(
          `[pi-subagent] config-failure notification failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return outcome;
  };
  return {
    async run(spec, callbacks) {
      if (callbacks) perRun.set(spec.runId, callbacks);
      if (spec.request.parentRunId !== undefined) childRunIds.add(spec.runId); // CC2
      if (spec.request.schema !== undefined) schemaRunIds.add(spec.runId);
      // X10: captures the last StructuredOutput submission for this run, if
      // any. Populated (only) by the injected tool's onSubmit below; read
      // again, independently, after the run settles (host-side re-validation
      // — architecture §7.2 X10 "双重校验").
      const structured: { value?: unknown } = {};
      let settled: RunOutcome | undefined;
      // consult §5.4 B: the sole "this is a consult run" predicate — a fork
      // request produced exclusively by the consult tool (plan §4.3). Gates
      // the read-only tool domain AND every injection skip below.
      const isConsultRun = spec.request.forkSessionFrom !== undefined;
      // consult §4.4 early-exit bookkeeping: set right before the runner is
      // entered. Every return/throw before that point (settleConfigFailure,
      // pre-runner sync throws) never reaches the runner's own finally, so
      // the adapter's finally below is the only onReaped call site for them.
      let runnerEntered = false;
      // D12 (v2.1 condition 1): mirrors the onReaped bookkeeping above for
      // `abandonSessionSpec` — fired (fire-and-forget) in this same finally
      // whenever H2 ran on this runId but the runner never got entered
      // afterwards (startup timeout, the hook itself throwing, a LATER
      // extension in the merged chain throwing, or a synchronous throw
      // between H2 succeeding and `runnerEntered = true`).
      let h2Invoked = false;
      let abandonReason: "startup_timeout" | "h2_failed" | "pre_runner_exit" | undefined;
      const h2Controller = new AbortController();
      try {
        // CC4/CP2: re-check the absolute deadline cap as the first thing
        // inside this run's own execution, before any sessionSpec/customTools
        // construction or H2 invocation — catches drift accrued between
        // SpawnService's admission check (CP1) and this run actually
        // starting (e.g. queued behind other synchronous work). H2 is not
        // invoked on this path, so no worktree is created.
        if (spec.request.deadlineAt !== undefined && spec.request.deadlineAt <= deps.clock.now())
          return settleConfigFailure(
            spec.runId,
            {
              kind: "config",
              message: "deadlineAt already expired",
              retryable: false,
            },
            spec.request.label,
          );
        // Per-spawn thinkingOverride (Agent tool `thinking` param) wins over
        // the agent type's configured thinkingLevel; neither set => leave the
        // session to pi's global defaultThinkingLevel.
        const thinkingLevel = spec.request.thinkingOverride ?? spec.type.thinkingLevel;
        // D10 consult cwd (workflow-worktree plan §2 D10): a cell read by the
        // consult tool's getter. The consult factory below is called BEFORE
        // H2 runs, but the tool it returns only ever executes later (once the
        // session exists, which is always after H2) — so writing this cell
        // once, right after H2 succeeds, is enough for every `execute()` call
        // to observe the post-H2 value. H2 failing, or never running at all
        // (no resolveSessionSpec hook, or isolation not requested), leaves it
        // at this pre-H2 value with `isolated:false`.
        const preH2Cwd = spec.cwd ?? process.cwd();
        let askerCwd: { cwd: string; isolated: boolean } = { cwd: preH2Cwd, isolated: false };
        let sessionSpec: SessionSpec = {
          ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
          ...(spec.model === undefined ? {} : { model: spec.model }),
          ...(spec.type.tools === undefined ? {} : { tools: spec.type.tools }),
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
          ...(spec.type.promptMode === "replace" && spec.type.systemPrompt
            ? { systemPrompt: spec.type.systemPrompt }
            : {}),
        };
        // X3/X10 built-in injected tools, always applied ahead of any H2
        // extension (so an extension's resolveSessionSpec still sees — and can
        // further extend — the full customTools list).
        const grantedReserved: string[] = [];
        const customTools: unknown[] = [];
        // consult §5.4 B-1: a consulted expert copy gets NONE of the injected
        // tools (message_agent / set_model / nested Agent / StructuredOutput /
        // consult) — every injection branch below is explicitly
        // !isConsultRun-guarded rather than relying on the implicit "a
        // consult request carries no consultExperts" premise (review-2 #13).
        if (deps.fabric && !isConsultRun) {
          customTools.push(
            createMessageAgentTool({
              router: deps.fabric.router,
              ...(deps.fabric.mention && deps.fabric.mention.query() && deps.fabric.mention.spawn()
                ? {
                    mention: createMentionChannel({
                      router: deps.fabric.router,
                      registry: deps.fabric.mention.registry,
                      query: deps.fabric.mention.query()!,
                      spawn: deps.fabric.mention.spawn()!,
                      from: spec.runId,
                      generation: () => runtime.getRunState(spec.runId)?.generation,
                      ...(spec.type.canMessage === undefined ? {} : { canMessage: spec.type.canMessage }),
                    }),
                  }
                : {}),
              from: spec.runId,
              // Why: read the LIVE generation from RuntimeRunner's in-memory
              // state, not deps.store — persist_snapshot is terminal-only, so
              // a mid-run store.get(runId) is always undefined and every
              // message_agent call failed with "cannot determine generation".
              generation: () => runtime.getRunState(spec.runId)?.generation,
              ...(spec.type.canMessage === undefined ? {} : { canMessage: spec.type.canMessage }),
            }),
          );
          grantedReserved.push("message_agent");
        }
        // set_model (plan §4.7): every run gets the self-scoped form (the tool
        // itself rejects foreign run_ids, D-2). Injection is unconditional,
        // but for agent types declaring a `tools:` allowlist it only TAKES
        // EFFECT because of the grantedReserved merge into sessionSpec.tools
        // below (M1). All deps are injected explicitly — no ExtensionContext
        // reads (unreliable inside child sessions) — which also keeps the
        // tool 100% unit-testable.
        // consult §5.4 B-1: a consulted expert copy gets none of the injected
        // tools — read-only four only.
        if (!isConsultRun) {
          customTools.push(
            createSetModelTool({
              selfRunId: spec.runId,
              runs: { setModel: (runId, model, opts) => runtime.setModelForRun(runId, model, opts ?? {}) },
              ...(deps.resolveModelHint ? { resolveHint: deps.resolveModelHint } : {}),
              ...(deps.availableModels ? { available: deps.availableModels } : {}),
            }),
          );
          grantedReserved.push("set_model");
        }
        if (!isConsultRun && spec.type.canSpawn?.length && deps.nestedSpawn) {
          const port = deps.nestedSpawn();
          if (port) {
            customTools.push(
              createAgentTool({
                spawn: port,
                parentRunId: spec.runId,
                allowedTypes: spec.type.canSpawn,
                forceSlotless: true,
                ...(deps.resultMaxChars ? { resultMaxChars: deps.resultMaxChars } : {}),
                ...(deps.queueWhenFull ? { queueWhenFull: deps.queueWhenFull } : {}),
                // consult §4.2: nested dispatchers resolve `experts` with the
                // same dispatch-time resolver as the top-level Agent tool
                // (same trust level as `resume`, plan §5.2); agent-tool
                // throws on an `experts` param when this is not wired.
                ...(deps.consultResolveExperts ? { resolveExperts: deps.consultResolveExperts } : {}),
              }),
            );
            grantedReserved.push("Agent");
          }
        }
        // consult injection (plan §6 C-12, after set_model): only a run whose
        // dispatcher attached a resolved expert whitelist gets the consult
        // tool — and never a consult run itself (explicit !isConsultRun,
        // review-2 #13).
        if (!isConsultRun && spec.request.consultExperts?.length && deps.consult) {
          const consultTool = deps.consult(spec.runId, () => askerCwd, spec.request.consultExperts);
          if (consultTool !== undefined) {
            customTools.push(consultTool);
            grantedReserved.push("consult");
          }
        }
        if (!isConsultRun && spec.request.schema !== undefined) {
          const schema = spec.request.schema;
          customTools.push(
            createStructuredOutputTool({
              schema,
              onSubmit: (value) => {
                const result = validateAgainstSchema(schema, value);
                if (result.ok) structured.value = value;
                return result;
              },
            }),
          );
          grantedReserved.push("StructuredOutput");
        }
        // bash-timeout-grace plan §3.10 (P5): no customTools injection — `bash`/
        // `bash_job` are registered by the CHILD session's own pre-guard
        // `activate()` (src/bash/child.ts, src/index.ts), not injected here.
        // This only decides whether OUR OWN enforcer (RESERVED_TOOL_NAMES
        // denies `bash_job` by default) grants it for this particular run,
        // and merges it into pi's own `sessionSpec.tools` allowlist below
        // when the agent type declares one (same M1 rescue as every other
        // grantedReserved push).
        if (
          bashJobGrant({
            ...(spec.type.tools !== undefined ? { typeTools: spec.type.tools } : {}),
            childBashJobs: deps.childBashJobsEnabled ?? false,
            consult: isConsultRun,
          })
        ) {
          grantedReserved.push("bash_job");
        }
        if (customTools.length)
          sessionSpec = { ...sessionSpec, customTools: [...(sessionSpec.customTools ?? []), ...customTools] };
        // M1 (set_model review): pi filters customTools against the session's
        // `tools` allowlist when (re)building its tool registry
        // (agent-session.js _refreshToolRegistry → isAllowedTool, fed by
        // sdk.js `allowedToolNames = options.tools`), so for agent types that
        // declare `tools:` an injected reserved tool is silently dropped —
        // grantedReserved only feeds the enforcer policy below and cannot
        // rescue pi's registry filter. Merge the granted names into the
        // pi-level allowlist as well. (A pre-existing latent defect for
        // message_agent/Agent/StructuredOutput, cured here by the same merge.)
        if (sessionSpec.tools !== undefined && grantedReserved.length > 0)
          sessionSpec = { ...sessionSpec, tools: [...new Set([...sessionSpec.tools, ...grantedReserved])] };
        // H2: resolveSessionSpec runs before any slot/session resource is
        // acquired and is bounded by startupMs; a throw or timeout fails the
        // run outright ("failed(config)", not a silent fallback to the
        // unmodified spec). D12 (v2.1 condition 1): the hook gets `ctx.signal`,
        // aborted the instant this wrapper gives up on it (timeout or a
        // rejection) — an extension that created a resource (the worktree) is
        // expected to notice it and unwind; `abandonSessionSpec` below is the
        // fire-and-forget backstop for whatever the hook itself couldn't
        // finish before returning.
        if (merged.resolveSessionSpec) {
          const hook = merged.resolveSessionSpec;
          h2Invoked = true;
          const resolved = await withStartupTimeout(
            Promise.resolve().then(() => hook(sessionSpec, spec.request, { signal: h2Controller.signal })),
            spec.budget.startupMs,
            deps.clock,
          );
          if (!resolved.ok) {
            h2Controller.abort();
            abandonReason = resolved.timedOut ? "startup_timeout" : "h2_failed";
            return settleConfigFailure(spec.runId, resolved.error, spec.request.label);
          }
          sessionSpec = resolved.value;
          // D10: write the cwd cell exactly once, now that H2 has finished
          // successfully. `isolated` requires all three: isolation was
          // actually requested, H2 gave sessionSpec a cwd, and that cwd
          // differs from the pre-H2 value (a no-op H2 that echoes the same
          // cwd back is not isolation).
          askerCwd = {
            cwd: sessionSpec.cwd ?? preH2Cwd,
            isolated:
              spec.request.isolation === "worktree" && sessionSpec.cwd !== undefined && sessionSpec.cwd !== preH2Cwd,
          };
        }
        // consult §5.4 B-2: FORCE the read-only tool domain AFTER H2, so no
        // extension (worktree or future) can ever widen a consult run's
        // tools. Same constant as the enforcer policy below — single source
        // (CONSULT_READONLY_TOOLS), never a second list. This also activates
        // grep/find/ls, which pi only activates when named in `tools` (an
        // unset `tools` means read/bash/edit/write — the two fixture shapes
        // `tools: undefined` and `tools: ["bash","write"]` both collapse to
        // the read-only four here).
        if (isConsultRun) sessionSpec = { ...sessionSpec, tools: [...CONSULT_READONLY_TOOLS] };
        // X11: re-applied at bind and every turn_end (runtime/runner.ts), not
        // just once here — this is what actually closes the MCP-late-registration
        // gap (architecture §7.5). `undefined` allow-list preserves the pre-X11
        // behavior for agent types without a `tools` field: no restriction
        // beyond the always-on reserved-name protection.
        // consult §5.4 B-3: a consult run's policy is built from the SAME
        // constant as the pi-level allowlist above, with no grants at all.
        const toolScope = {
          policy: isConsultRun
            ? buildToolScopePolicy({ tools: CONSULT_READONLY_TOOLS, granted: [] })
            : buildToolScopePolicy({
                ...(spec.type.tools ? { tools: spec.type.tools } : {}),
                granted: grantedReserved,
              }),
          enforcer: createToolScopeEnforcer({
            // TS4: never silent. Note: §7.5's literal "WARN + diag.degraded"
            // is only half-met here — the enforcer is built before the run's
            // dispatch channel exists, so blocked/failed enforcement lands in
            // the log but not in diag.degraded (documented gap, P3).
            onBlocked: (names) =>
              console.warn(
                `[pi-subagent] tool scope: blocked late-registered/reserved tool(s) not in run ${spec.runId}'s whitelist: ${names.join(", ")}`,
              ),
            onError: (error) =>
              console.warn(
                `[pi-subagent] tool scope: setActiveTools failed for run ${spec.runId} (retried at next turn boundary): ${error instanceof Error ? error.message : String(error)}`,
              ),
          }),
        };
        // D9 ("只读提示的 prompt 路径", v2.1 condition 4): `promptNotes` is NOT a
        // driver-facing SessionSpec field — pulled out here so it never rides
        // along in `...sessionFields` into the create/resume request, and
        // folded into the actual prompt via `appendPromptNotes` below instead
        // (the `prompt` field on SessionSpec itself is always overridden by
        // the request's own prompt on the next line regardless).
        const { promptNotes, ...sessionFields } = sessionSpec;
        const req: ResolvedSpawnRequest = {
          runId: spec.runId,
          ...sessionFields,
          // consult §5.4 B-4: a consult run's prompt is the consult question
          // verbatim — buildPrompt's agent-type prefix (the whole task
          // instruction of the expert's type) is already in the fork's
          // history; replace-mode systemPrompt above survives untouched.
          prompt: isConsultRun ? spec.request.prompt : appendPromptNotes(buildPrompt(spec), promptNotes),
          ...threadThroughRequestFields(spec.request), // F3/F4 (CC4 — also carries deadlineAt)
          toolScope,
          // M-A: display-only metadata for the presentation layer (diag.model/
          // label/agentType). spec.model is already the merged
          // modelOverride-or-type-default pair; undefined means "pi session
          // default", which the UI renders as such.
          displayMeta: {
            ...(spec.model === undefined ? {} : { model: spec.model }),
            ...(spec.request.label === undefined ? {} : { label: spec.request.label }),
            // consult §16.5 (acceptance follow-up): display-only — the main-session
            // sentinel type is folded to "main" here so every diag-driven renderer
            // shows the reserved id; spawn/admission keep comparing the raw
            // spec.type.name (and consult runs can never re-enter admission: the
            // expert index excludes them structurally by session-file location).
            agentType: displayAgentType(spec.type.name),
            taskPrompt: spec.request.prompt.slice(0, TASK_PROMPT_CAP),
            // X1 (agent tree): `⎇ wt` on the row while the run is in flight;
            // keyed off the request's declared intent. H2 failure paths
            // (disabled/uncreatable worktree) never fold displayMeta, so a
            // failed(config) row shows no marker at all.
            ...(spec.request.isolation === "worktree" ? { worktree: { state: "active" } } : {}),
            // consult §6 C-12: display-only consult marker (badge without
            // parsing the `consult-` label prefix).
            ...(isConsultRun
              ? {
                  consultOf: {
                    ...(spec.request.parentRunId !== undefined ? { askerRunId: spec.request.parentRunId } : {}),
                  },
                }
              : {}),
          },
        };
        runnerEntered = true;
        let outcome = await runtime.run(req, spec.budget);
        // X10 host-side re-validation (second of the two mandatory checks).
        if (spec.request.schema !== undefined) {
          outcome = applyStructuredOutputPolicy(outcome, spec.request.schema, structured.value);
          settled = outcome;
          try {
            const snapshot = deps.store.get(spec.runId);
            if (snapshot) deps.store.put({ ...snapshot, outcome, status: outcome.status, updatedAt: deps.clock.now() });
          } catch (err) {
            console.warn(
              `[pi-subagent] post-policy snapshot persist failed for ${spec.runId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        } else settled = outcome;
        return outcome;
      } finally {
        // D12 (v2.1 condition 1): fire-and-forget — the run's own outcome
        // (failed(config), already returned above) must never wait on this.
        // Bounded by the extension's own compensation logic (at most a few
        // git commands, each under gitTimeoutMs); nothing here awaits it.
        if (h2Invoked && !runnerEntered) {
          const reason = abandonReason ?? "pre_runner_exit";
          void Promise.resolve()
            .then(() => merged.abandonSessionSpec?.(spec.runId, { reason }))
            .catch((err) =>
              console.warn(
                `[pi-subagent] abandonSessionSpec failed for run ${spec.runId} (ignored): ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
        }
        // consult §4.4 early-exit path: the runner was never entered, so its
        // own finally/onReaped will not run — delete the fork copy here while
        // nothing can write to it (no session was ever opened against it).
        // Deliberately NOT unconditional: deleting for an entered runner
        // would race its runReap()/disposeLate `_persist` (appendFileSync)
        // and resurrect a header-less fragment — the exact race §4.4 removed.
        if (!runnerEntered && isConsultRun) {
          try {
            deps.onReaped?.(spec.runId, spec.request.forkSessionFrom);
          } catch {
            /* cleanup must never mask the run's own outcome */
          }
        }
        perRun.delete(spec.runId);
        childRunIds.delete(spec.runId); // CC2
        const generation = policyPendingRunIds.get(spec.runId);
        if (generation !== undefined) {
          policyPendingRunIds.delete(spec.runId);
          deps.notifier.finalize(
            spec.runId,
            generation,
            settled
              ? {
                  status: settled.status,
                  textPreview:
                    settled.structuredResult === undefined
                      ? (settled.text ?? "")
                      : JSON.stringify(settled.structuredResult),
                  ...(settled.structuredResult === undefined
                    ? {}
                    : { structuredPreview: JSON.stringify(settled.structuredResult) }),
                  ...((settled.error?.message ?? settled.timeoutReason)
                    ? { failReason: settled.error?.message ?? settled.timeoutReason }
                    : {}),
                  ...(settled.diag.label === undefined ? {} : { label: settled.diag.label }),
                  diag: {
                    phase: "settled",
                    status: settled.status,
                    pendingTools: settled.diag.pendingTools,
                    staleInputs: settled.diag.staleInputs,
                    degraded: settled.diag.degraded.length,
                  },
                }
              : { degradedReason: "policy-error" },
          );
        }
        schemaRunIds.delete(spec.runId);
      }
    },
    abort(runId, cause) {
      return runtime.abortRun(runId, cause);
    },
    steer(runId, text) {
      return runtime.steerRun(runId, text);
    },
    setModel(runId, model, opts) {
      return runtime.setModelForRun(runId, model, opts ?? {});
    },
    // timeout-notify: synchronous passthrough (D-9) — no logic here; the
    // runner/reducer is the single source of truth for extendability.
    extendDeadline(runId, extendMs, opts) {
      return runtime.extendDeadline(runId, extendMs, opts);
    },
    // M4: EventWatchdog 接线——stack.ts 通过这两个可选方法把 watchdog 的
    // getState/dispatch 晚绑定到真实的 run 状态机上。
    getRunState(runId, generation) {
      return runtime.getRunState(runId, generation);
    },
    fireDeadline(runId, generation, input) {
      runtime.fireDeadline(runId, generation, input);
    },
    // D13 (v2.1 condition 2): idempotent. Flips the redirect above; stack.ts
    // calls this at the top of a rebuild (handing off from the PREVIOUS
    // stack's adapter) and again on session_shutdown.
    dispose() {
      disposed = true;
    },
  };
}
