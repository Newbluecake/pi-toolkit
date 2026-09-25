import { randomUUID } from "node:crypto";
import type { Clock, TimerHandle } from "../core/clock.js";
import type { Millis } from "../core/types.js";
import type { WorkflowActivityRegistry } from "./activity.js";
import type { Orchestrator, OrchestratorRunRequest } from "./orchestrator.js";
import type {
  ReplayScope,
  WorkflowId,
  WorkflowOutcome,
  WorkflowRunBudget,
  WorkflowStopCause,
  WorkflowTerminalStatus,
} from "./types.js";

/**
 * Background workflow registry (docs/dev/workflow-background/plan.md).
 *
 * `SubagentWorkflow` used to block its tool call until the workflow settled.
 * It now returns a `workflowId` immediately and the run continues here — one
 * registry per session stack (built in `src/stack.ts`, never module-level):
 *
 * - `start()` registers the activity row, creates the per-run orchestrator and
 *   drives it through the same bounded sequence the blocking tool used
 *   (§4.3.2 WT13/WT17): race `run()` against the total budget, on timeout fire
 *   an un-awaited idempotent `stop()`, race the settle against a grace window,
 *   and fall back to the `outcomeAt1()` snapshot (or a bare skeleton) marked
 *   `degraded: "settlement_timeout"`. Every started workflow therefore reaches
 *   a terminal entry — the zero-hang invariant holds without a tool call to
 *   anchor it.
 * - `stop()` is the management entry (`abort_subagent`): it asks the driver to
 *   stop early, and the driver applies the same bounded settle + fallback.
 * - Terminal entries are retained (bounded count + TTL, pruned lazily — no
 *   timers) so `get_subagent_result` can read them after the fact.
 * - Shutdown: `shutdown()` requests a stop on everything still running,
 *   `drain()` waits (bounded), `seal()` finalizes stragglers with their
 *   degraded snapshot and suppresses any later settle; `abandon()` is the
 *   defensive variant (stop requested, notifications dropped).
 *
 * The workflow is fully detached from the tool call's AbortSignal: the only
 * ways to stop it are `stop()` (abort_subagent), its own budget, or the
 * session ending.
 */

/** §4.3.2 WT17: grace window for `settled()` after the run itself overran its bound (the blocking tool's constant). */
export const SETTLEMENT_GRACE_MS = 3_000;
/** §4.1 WT8's tick granularity, folded into the run bound like the blocking tool did. */
const TICK_MS = 250;
/** Bus event fired (by the stack's notice sink) after a background workflow reached its terminal entry — the deferred /reload recount listens to it. */
export const WORKFLOW_SETTLED_EVENT = "subagent:workflow:settled";
/** Default cap on retained terminal entries (oldest evicted first). */
const DEFAULT_MAX_TERMINAL = 50;
/** Default TTL of a retained terminal entry. */
const DEFAULT_TERMINAL_TTL_MS = 6 * 60 * 60 * 1_000;

export type BackgroundWorkflowStatus = "running" | WorkflowTerminalStatus;

export interface BackgroundWorkflowView {
  readonly workflowId: WorkflowId;
  /** Script `meta.name` (display label). */
  readonly name: string;
  readonly startedAt: Millis;
  readonly deadlineAt?: Millis;
  readonly status: BackgroundWorkflowStatus;
  readonly outcome?: WorkflowOutcome;
  readonly settledAt?: Millis;
  /** First stop cause requested through `stop()`/`shutdown()` (undefined when never asked to stop). */
  readonly stopRequested?: WorkflowStopCause;
  /** Aggregate child spend captured at settle time (set by the owner via `onSettled`'s return, or seeded). */
  readonly usage?: BackgroundWorkflowUsage;
}

export interface BackgroundWorkflowUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly costUsd: number;
}

export interface BackgroundWorkflowStartRequest {
  readonly script: string;
  readonly name: string;
  readonly budget: WorkflowRunBudget;
  readonly args?: unknown;
  readonly journal?: string;
  readonly noReplay?: boolean;
  readonly replayScope?: ReplayScope;
}

export type BackgroundWorkflowWaitResult =
  | { readonly ok: true; readonly view: BackgroundWorkflowView & { readonly outcome: WorkflowOutcome } }
  | { readonly ok: false; readonly reason: "unknown_workflow" | "wait_timeout" | "aborted" };

export type BackgroundWorkflowStopResult =
  | { readonly ok: true; readonly settled: true; readonly view: BackgroundWorkflowView }
  | { readonly ok: true; readonly settled: false; readonly view: BackgroundWorkflowView }
  | { readonly ok: false; readonly reason: "unknown_workflow" }
  | { readonly ok: false; readonly reason: "already_terminal"; readonly view: BackgroundWorkflowView };

export type WorkflowResolution =
  | { readonly kind: "workflow"; readonly workflowId: WorkflowId }
  | { readonly kind: "ambiguous"; readonly error: string }
  | { readonly kind: "none" };

/** Why a settle is being reported: a normal settle while the session is live, or one produced during shutdown. */
export type BackgroundSettlePhase = "live" | "shutdown";

export interface BackgroundWorkflowsDeps {
  readonly clock: Clock;
  readonly activity: WorkflowActivityRegistry;
  createOrchestrator(workflowId: WorkflowId): Orchestrator;
  /** Id generator override (tests). Default: `wf_` + 20 hex chars. */
  newId?(): WorkflowId;
  /**
   * Fires exactly once per workflow when it reaches its terminal entry (not
   * after `seal()`/`abandon()`). May return the aggregate usage to retain on
   * the entry. Exceptions are swallowed — a notification failure must never
   * break the registry.
   */
  onSettled?(
    view: BackgroundWorkflowView & { readonly outcome: WorkflowOutcome },
    phase: BackgroundSettlePhase,
  ): BackgroundWorkflowUsage | void;
  readonly maxTerminal?: number;
  readonly terminalTtlMs?: Millis;
}

export interface BackgroundWorkflows {
  /** Validate-free start (the tool validated first). Throws once the registry is shutting down. */
  start(req: BackgroundWorkflowStartRequest): BackgroundWorkflowView;
  get(workflowId: WorkflowId): BackgroundWorkflowView | undefined;
  list(): readonly BackgroundWorkflowView[];
  /** Workflows that have not reached their terminal entry yet. */
  activeCount(): number;
  /** Exact workflow id, then unique id prefix. `none` for anything that is not (a prefix of) a known workflow id. */
  resolve(handle: string): WorkflowResolution;
  /** Script-name match: the single running workflow of that name, else the most recent one. */
  resolveLabel(handle: string): WorkflowResolution;
  wait(workflowId: WorkflowId, opts: { waitMs: Millis; signal?: AbortSignal }): Promise<BackgroundWorkflowWaitResult>;
  stop(
    workflowId: WorkflowId,
    cause: WorkflowStopCause,
    opts?: { waitMs?: Millis },
  ): Promise<BackgroundWorkflowStopResult>;
  /** Insert an already-terminal entry (read back from a persisted notice after /reload); its retention starts now. No-op when the id exists. */
  seedTerminal(view: BackgroundWorkflowView & { readonly outcome: WorkflowOutcome }): void;
  /** Request `stop("shutdown")` on every running workflow; later settles report phase "shutdown". Idempotent. */
  shutdown(): void;
  /** Wait (bounded) for every running workflow to settle. Never rejects. */
  drain(waitMs: Millis): Promise<void>;
  /** Finalize still-running workflows with their degraded snapshot, then suppress every later settle. */
  seal(): void;
  /** Defensive teardown: stop everything, report nothing. */
  abandon(): void;
  readonly shuttingDown: boolean;
}

/** The blocking tool's §4.3.1 `toolCallMs` minus the settle grace — how long `run()` itself may take. */
export function runBoundMs(budget: WorkflowRunBudget): Millis {
  return (
    budget.workflowTotalMs +
    TICK_MS +
    (budget.abortGraceMs ?? 10_000) +
    budget.terminateConfirmMs +
    (budget.reconcileMs ?? 1_000)
  );
}

/** Settle window after an explicit stop request: the orchestrator's own WL1–WL4 windows plus the grace. */
export function stopSettleBoundMs(budget: WorkflowRunBudget): Millis {
  return (
    TICK_MS +
    (budget.abortGraceMs ?? 10_000) +
    budget.terminateConfirmMs +
    (budget.reconcileMs ?? 1_000) +
    SETTLEMENT_GRACE_MS
  );
}

function defaultNewId(): WorkflowId {
  return `wf_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

type RaceResult<T> = { kind: "value"; value: T } | { kind: "timeout" } | { kind: "stop"; cause: WorkflowStopCause };

interface Entry {
  readonly workflowId: WorkflowId;
  readonly name: string;
  readonly startedAt: Millis;
  readonly deadlineAt?: Millis;
  readonly budget?: WorkflowRunBudget;
  readonly orchestrator?: Orchestrator;
  status: BackgroundWorkflowStatus;
  outcome?: WorkflowOutcome;
  settledAt?: Millis;
  usage?: BackgroundWorkflowUsage;
  stopRequested?: WorkflowStopCause;
  /** Resolves the driver's stop race (first call wins). */
  kickStop?: (cause: WorkflowStopCause) => void;
  readonly done: Promise<WorkflowOutcome>;
  resolveDone: (outcome: WorkflowOutcome) => void;
}

function view(entry: Entry): BackgroundWorkflowView {
  return {
    workflowId: entry.workflowId,
    name: entry.name,
    startedAt: entry.startedAt,
    ...(entry.deadlineAt !== undefined ? { deadlineAt: entry.deadlineAt } : {}),
    status: entry.status,
    ...(entry.outcome !== undefined ? { outcome: entry.outcome } : {}),
    ...(entry.settledAt !== undefined ? { settledAt: entry.settledAt } : {}),
    ...(entry.stopRequested !== undefined ? { stopRequested: entry.stopRequested } : {}),
    ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
  };
}

export function createBackgroundWorkflows(deps: BackgroundWorkflowsDeps): BackgroundWorkflows {
  const clock = deps.clock;
  const maxTerminal = Math.max(1, deps.maxTerminal ?? DEFAULT_MAX_TERMINAL);
  const ttlMs = Math.max(0, deps.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS);
  const newId = deps.newId ?? defaultNewId;
  const entries = new Map<WorkflowId, Entry>();
  let shuttingDown = false;
  let sealed = false;

  /** Bounded race of `promise` against `ms` and (optionally) a stop kick. The timer is always cleared. */
  function race<T>(promise: Promise<T>, ms: Millis, stopKick?: Promise<WorkflowStopCause>): Promise<RaceResult<T>> {
    return new Promise((resolve) => {
      let done = false;
      let timer: TimerHandle | undefined;
      const finish = (r: RaceResult<T>) => {
        if (done) return;
        done = true;
        if (timer !== undefined) clock.clearTimer(timer);
        resolve(r);
      };
      timer = clock.setTimer(Math.max(0, ms), () => finish({ kind: "timeout" }));
      promise.then(
        (value) => finish({ kind: "value", value }),
        () => undefined, // callers only pass never-rejecting promises
      );
      stopKick?.then((cause) => finish({ kind: "stop", cause }));
    });
  }

  function skeleton(
    workflowId: WorkflowId,
    startedAt: Millis,
    status: WorkflowTerminalStatus,
    extra: Partial<WorkflowOutcome>,
  ): WorkflowOutcome {
    const now = clock.now();
    return {
      workflowId,
      status,
      pendingReconcile: true,
      durationMs: Math.max(0, now - startedAt),
      children: [],
      diag: {
        createdAt: startedAt,
        heartbeat: { seq: 0, observedAt: now, stalledMs: 0 },
        logLines: 0,
        degraded: "settlement_timeout",
      },
      ...extra,
    };
  }

  /** `outcomeAt1()` marked degraded, or an honest skeleton when even that is gone (EI5 double failure). */
  function fallbackOutcome(entry: Entry, cause: WorkflowStopCause | "timeout"): WorkflowOutcome {
    let snapshot: WorkflowOutcome | undefined;
    try {
      snapshot = entry.orchestrator?.outcomeAt1(entry.workflowId);
    } catch {
      snapshot = undefined;
    }
    if (snapshot) return { ...snapshot, diag: { ...snapshot.diag, degraded: "settlement_timeout" } };
    return cause === "timeout"
      ? skeleton(entry.workflowId, entry.startedAt, "timed_out", { timeoutReason: "workflow_total" })
      : skeleton(entry.workflowId, entry.startedAt, "aborted", { stopCause: cause });
  }

  function prune(): void {
    const now = clock.now();
    const terminal = [...entries.values()].filter((e) => e.status !== "running");
    for (const e of terminal) {
      if (ttlMs > 0 && e.settledAt !== undefined && now - e.settledAt > ttlMs) entries.delete(e.workflowId);
    }
    const kept = [...entries.values()]
      .filter((e) => e.status !== "running")
      .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
    while (kept.length > maxTerminal) {
      const oldest = kept.shift();
      if (oldest) entries.delete(oldest.workflowId);
    }
  }

  /** Idempotent: the first terminal outcome wins; later ones (driver after seal, double settle) are ignored. */
  function finalize(entry: Entry, outcome: WorkflowOutcome): void {
    if (entry.status !== "running") return;
    entry.status = outcome.status;
    entry.outcome = outcome;
    entry.settledAt = clock.now();
    try {
      deps.activity.unregister(entry.workflowId);
    } catch {
      // activity is display-only
    }
    entry.resolveDone(outcome);
    if (!sealed && deps.onSettled) {
      try {
        const usage = deps.onSettled({ ...view(entry), outcome }, shuttingDown ? "shutdown" : "live");
        if (usage) entry.usage = usage;
      } catch (error) {
        console.warn(
          `[pi-subagent] workflow ${entry.workflowId} settle hook threw (ignored): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    prune();
  }

  async function drive(entry: Entry, req: OrchestratorRunRequest, stopKick: Promise<WorkflowStopCause>) {
    const orchestrator = entry.orchestrator!;
    const budget = entry.budget!;
    let runP: Promise<WorkflowOutcome>;
    try {
      runP = orchestrator.run(req);
    } catch (error) {
      runP = Promise.reject(error);
    }
    const outcomeP: Promise<WorkflowOutcome> = runP.catch((error: unknown) =>
      skeleton(entry.workflowId, entry.startedAt, "failed", {
        pendingReconcile: false,
        stopCause: "script_error",
        error: { message: error instanceof Error ? error.message : String(error) },
        diag: {
          createdAt: entry.startedAt,
          heartbeat: { seq: 0, observedAt: clock.now(), stalledMs: 0 },
          logLines: 0,
        },
      }),
    );
    const first = await race(outcomeP, runBoundMs(budget), stopKick);
    if (first.kind === "value") return finalize(entry, first.value);
    const cause: WorkflowStopCause = first.kind === "stop" ? first.cause : "timeout";
    // TL6: never await stop() — the bounded race below carries the wait.
    try {
      void orchestrator.stop(entry.workflowId, cause).catch(() => undefined);
    } catch {
      // a throwing stop() is the same as a stop() that never settles: the fallback below covers it
    }
    let settledP: Promise<WorkflowOutcome>;
    try {
      settledP = orchestrator.settled(entry.workflowId).catch(() => outcomeP);
    } catch {
      settledP = outcomeP;
    }
    const settleMs = first.kind === "stop" ? stopSettleBoundMs(budget) : SETTLEMENT_GRACE_MS;
    const second = await race(Promise.race([outcomeP, settledP]), settleMs);
    if (second.kind === "value") return finalize(entry, second.value);
    finalize(entry, fallbackOutcome(entry, cause));
  }

  function newEntry(
    base: Omit<Entry, "done" | "resolveDone" | "status"> & { status?: BackgroundWorkflowStatus },
  ): Entry {
    let resolveDone!: (o: WorkflowOutcome) => void;
    const done = new Promise<WorkflowOutcome>((resolve) => (resolveDone = resolve));
    return { status: "running", ...base, done, resolveDone };
  }

  return {
    get shuttingDown() {
      return shuttingDown;
    },
    start(req) {
      if (shuttingDown || sealed) throw new Error("session is shutting down; cannot start a workflow");
      prune();
      let workflowId = newId();
      for (let i = 0; entries.has(workflowId) && i < 10; i++) workflowId = newId();
      if (entries.has(workflowId)) throw new Error("unable to allocate a unique workflow id");
      const startedAt = clock.now();
      const deadlineAt = req.budget.workflowTotalMs > 0 ? startedAt + req.budget.workflowTotalMs : undefined;
      deps.activity.register(workflowId, req.name, startedAt, deadlineAt);
      let orchestrator: Orchestrator;
      try {
        orchestrator = deps.createOrchestrator(workflowId);
      } catch (error) {
        deps.activity.unregister(workflowId);
        throw error;
      }
      let kick!: (cause: WorkflowStopCause) => void;
      const stopKick = new Promise<WorkflowStopCause>((resolve) => (kick = resolve));
      const entry = newEntry({
        workflowId,
        name: req.name,
        startedAt,
        ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        budget: req.budget,
        orchestrator,
      });
      entry.kickStop = (cause) => {
        if (entry.stopRequested === undefined) entry.stopRequested = cause;
        kick(cause);
      };
      entries.set(workflowId, entry);
      const runReq: OrchestratorRunRequest = {
        workflowId,
        script: req.script,
        budget: req.budget,
        ...(req.args !== undefined ? { args: req.args } : {}),
        ...(req.journal !== undefined ? { journal: req.journal } : {}),
        ...(req.noReplay !== undefined ? { noReplay: req.noReplay } : {}),
        ...(req.replayScope !== undefined ? { replayScope: req.replayScope } : {}),
        // Deliberately no `signal`: the run is detached from the tool call.
      };
      void drive(entry, runReq, stopKick).catch((error: unknown) => {
        // drive() never throws by construction; this is the last line of the zero-hang guarantee.
        finalize(
          entry,
          skeleton(workflowId, startedAt, "failed", {
            error: { message: `workflow driver failed: ${error instanceof Error ? error.message : String(error)}` },
          }),
        );
      });
      return view(entry);
    },
    get(workflowId) {
      prune();
      const entry = entries.get(workflowId);
      return entry ? view(entry) : undefined;
    },
    list() {
      prune();
      return [...entries.values()].map(view);
    },
    activeCount() {
      return [...entries.values()].filter((e) => e.status === "running").length;
    },
    resolve(handle) {
      prune();
      if (!handle) return { kind: "none" };
      if (entries.has(handle)) return { kind: "workflow", workflowId: handle };
      const matches = [...entries.keys()].filter((id) => id.startsWith(handle));
      if (matches.length === 1) return { kind: "workflow", workflowId: matches[0]! };
      if (matches.length > 1)
        return {
          kind: "ambiguous",
          error: `ambiguous workflow target: ${handle}. Candidates: [${matches.slice(0, 10).join(", ")}]`,
        };
      return { kind: "none" };
    },
    resolveLabel(handle) {
      prune();
      const named = [...entries.values()].filter((e) => e.name === handle);
      if (named.length === 0) return { kind: "none" };
      const running = named.filter((e) => e.status === "running");
      if (running.length === 1) return { kind: "workflow", workflowId: running[0]!.workflowId };
      if (running.length > 1)
        return {
          kind: "ambiguous",
          error: `ambiguous workflow target: "${handle}" matches ${running.length} running workflows. Candidates: [${running.map((e) => e.workflowId).join(", ")}]`,
        };
      // Most recently started (ties: the later registration — Map order is insertion order).
      const latest = named.reduce((best, e) => (e.startedAt >= best.startedAt ? e : best));
      return { kind: "workflow", workflowId: latest.workflowId };
    },
    async wait(workflowId, opts) {
      const entry = entries.get(workflowId);
      if (!entry) return { ok: false, reason: "unknown_workflow" };
      if (entry.status !== "running" && entry.outcome) {
        return { ok: true, view: { ...view(entry), outcome: entry.outcome } };
      }
      if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<WorkflowStopCause>((resolve) => {
        onAbort = () => resolve("user_stop");
        opts.signal?.addEventListener("abort", onAbort, { once: true });
      });
      try {
        const r = await race(entry.done, opts.waitMs, aborted);
        if (r.kind === "value") return { ok: true, view: { ...view(entry), outcome: r.value } };
        return { ok: false, reason: r.kind === "stop" ? "aborted" : "wait_timeout" };
      } finally {
        if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
      }
    },
    async stop(workflowId, cause, opts) {
      const entry = entries.get(workflowId);
      if (!entry) return { ok: false, reason: "unknown_workflow" };
      if (entry.status !== "running") return { ok: false, reason: "already_terminal", view: view(entry) };
      entry.kickStop?.(cause);
      const bound = opts?.waitMs ?? (entry.budget ? stopSettleBoundMs(entry.budget) + 1_000 : SETTLEMENT_GRACE_MS);
      const r = await race(entry.done, bound);
      return r.kind === "value"
        ? { ok: true, settled: true, view: view(entry) }
        : { ok: true, settled: false, view: view(entry) };
    },
    seedTerminal(seed) {
      if (entries.has(seed.workflowId)) return;
      const entry = newEntry({
        workflowId: seed.workflowId,
        name: seed.name,
        startedAt: seed.startedAt,
        ...(seed.deadlineAt !== undefined ? { deadlineAt: seed.deadlineAt } : {}),
        ...(seed.usage !== undefined ? { usage: seed.usage } : {}),
        ...(seed.stopRequested !== undefined ? { stopRequested: seed.stopRequested } : {}),
      });
      entry.status = seed.outcome.status;
      entry.outcome = seed.outcome;
      // Retention counts from the seed (the entry was just re-registered), not from the original settle.
      entry.settledAt = clock.now();
      entry.resolveDone(seed.outcome);
      entries.set(seed.workflowId, entry);
      prune();
    },
    shutdown() {
      shuttingDown = true;
      for (const entry of entries.values()) if (entry.status === "running") entry.kickStop?.("shutdown");
    },
    async drain(waitMs) {
      const running = [...entries.values()].filter((e) => e.status === "running").map((e) => e.done);
      if (running.length === 0) return;
      await race(Promise.all(running), waitMs);
    },
    seal() {
      if (sealed) return;
      for (const entry of entries.values()) {
        if (entry.status === "running") finalize(entry, fallbackOutcome(entry, entry.stopRequested ?? "shutdown"));
      }
      sealed = true;
    },
    abandon() {
      sealed = true;
      shuttingDown = true;
      for (const entry of entries.values()) if (entry.status === "running") entry.kickStop?.("shutdown");
    },
  };
}
