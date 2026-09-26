import type { Clock, TimerHandle } from "../core/clock.js";
import { withDeadline } from "../core/deadline.js";
import type { ConsultExpertRef, Millis, RunId, ThinkingLevel, UsageDelta } from "../core/types.js";
import { parseStrictModelRef } from "../config/model-hint.js";
import { deriveChildBudget } from "./budget.js";
import { snapshotAgentOpts, validateAgentOpts, type OptsDefect } from "./agent-opts.js";
import { createWorkflowExpertScope, resolveWorkflowExperts, type WorkflowExpertResolver } from "./expert-scope.js";
import { createCallRegistry, type CallRegistry } from "./call-registry.js";
import { buildEntry, CHAIN_SEED, nextChainDigest, sha256Hex, taskKeyOf, type JournalStore } from "./journal.js";
import { decideReplay, type ReplayIndex } from "./replay.js";
import { recheckBranches, type ProbeAgentBranchesFn } from "./isolation-verify.js";
import type {
  CallId,
  ChildWorktreeInfo,
  HostAckEnvelope,
  HostCallEnvelope,
  HostSettleEnvelope,
  JournalEntry,
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
    /**
     * Per-call model override (agent()'s `opts.model`, Agent-tool `model`
     * semantics): a strict `provider/id` pair as split by `parseStrictModelRef`
     * — `modelHintOverride` carries the non-pair form instead, exactly one of
     * the two is ever set for a given call. Structurally compatible with
     * `SpawnRequest.modelOverride`, which the real spawner-adapter forwards
     * verbatim so spawn admission can existence-check it (unknown model ⇒
     * spawn error ⇒ `agent()` rejects, `Did you mean` suggestion preserved).
     */
    modelOverride?: { provider: string; id: string };
    /** The non-pair `opts.model` form ("sonnet", "kimi-k3") — resolved as a fuzzy hint at spawn admission. */
    modelHintOverride?: string;
    /** Per-call thinking-level override (agent()'s `opts.thinking`), same values as the Agent tool's `thinking` param. */
    thinkingOverride?: ThinkingLevel;
    /**
     * workflow-experts (docs/dev/workflow-experts/plan.md §4.2/§4.8): the
     * resolved (trusted) expert whitelist for this child — structurally the
     * same field `SpawnRequest.consultExperts` already carries for the
     * top-level/nested Agent tool. Host.ts only ever populates this from a
     * successful `resolveWorkflowExperts` call; the script itself can never
     * construct a `ConsultExpertRef` (it only ever passes handle strings).
     */
    consultExperts?: readonly ConsultExpertRef[];
    /**
     * workflow-worktree plan D1: opt-in per-call worktree isolation
     * (`agent(prompt, { isolation: "worktree" })`) — forwarded verbatim to
     * `SpawnRequest.isolation`, which the real spawner-adapter already
     * threads through to `SpawnService.spawn`. Absent for an ordinary call
     * (never sent as `undefined`).
     */
    isolation?: "worktree";
    /**
     * replay-verify plan D4.1: pinned once per run (`isolationCwd`) and
     * threaded verbatim into the H2 worktree extension's own resolution
     * point — set only for an isolated call while `verify` mode is on;
     * absent for every other call and for `off` mode (byte-identical spawn
     * request, D9's off-mode guarantee).
     */
    cwd?: string;
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
  /**
   * workflow-experts §4.2/§4.8/D17: dispatch-time expert resolution for this
   * workflow run — the production wiring (`spawner-adapter.ts`, `stack.ts`)
   * forwards to `consult`'s `resolveExperts` (package C) with `{
   * completedOnly: true }` (D8) fixed. Never throws (contract, not just
   * convention — `resolveWorkflowExperts` also wraps a throw defensively).
   * Absent — e.g. a `ChildSpawner` test double, or `consult.enabled=false` at
   * the real wiring — fails closed: `agent({ experts })` rejects with "not
   * supported in this context" (D17), it never silently drops `experts`.
   */
  resolveExperts?: WorkflowExpertResolver;
  /**
   * workflow-worktree plan D2: the live availability gate for
   * `isolation:"worktree"` (decision 1 — no fallback to the shared
   * checkout). `stack.ts` wires this to `() => settings.worktree.enabled`,
   * read fresh on every call so a `/reload` that flips the setting takes
   * effect immediately. Absent, or returning anything other than `true` —
   * e.g. a `ChildSpawner` test double that never implements it — fails
   * closed: `handleAgent`'s D2 gate rejects any `isolation:"worktree"` call
   * with `isolation_unavailable` rather than silently spawning it
   * unisolated.
   */
  worktreeAvailable?(): boolean;
  /**
   * workflow-worktree plan D5: bounded (via `capMs`) or unbounded wait for
   * this run's worktree disposition, resolved through the production
   * adapter's own mapping of `SpawnService.waitWorktreeDisposition`'s
   * `settled|none|timeout|disposed` result onto `ChildWorktreeInfo`'s
   * `committed|clean|kept|pending|none` states (`timeout`/`disposed` both
   * become `"pending"` — host.ts never needs to tell them apart). Never
   * rejects, never hangs beyond the `capMs`/port-owned upper bound. Absent —
   * a `ChildSpawner` test double, or a real adapter whose underlying
   * `SpawnService` doesn't implement `waitWorktreeDisposition` — is treated
   * by `handleAgent` exactly like an immediate `{ state: "none" }`.
   */
  awaitWorktree?(runId: RunId, opts: { horizon: "settle" | "late"; capMs?: Millis }): Promise<ChildWorktreeInfo>;
  /**
   * replay-verify plan D4/D9: `stack.ts` wires this to
   * `() => settings.workflow.isolationReplay`, read fresh every call (a
   * `/reload` that flips it takes effect for the next run's
   * `buildJournalConfig`, not this one — the mode is pinned once at load
   * time, matching `isolationCwd`'s own per-run pinning). Absent — an
   * older/test `ChildSpawner` — defaults to `"off"` (fail-closed: no probe,
   * legacy RP7 behavior).
   */
  isolationReplayMode?(): "verify" | "off";
  /**
   * replay-verify plan D4.1: the cwd H2 would fall back to for THIS run
   * (`() => process.cwd()` in production) — read exactly once, at
   * `buildJournalConfig` time, and threaded through as the pinned
   * `isolationReplay.cwd` for the whole run's probe/spawn-cwd/recheck.
   * Absent falls back to `process.cwd()` directly.
   */
  isolationCwd?(): string;
  /**
   * replay-verify plan D4.2/D4.4: a single bounded `git for-each-ref` over
   * `branches` (already regex-validated `pi-agent-<safe>` names) —
   * `stack.ts` wires this to `pi.exec("git", ["for-each-ref", ...])`. Absent
   * — an older/test `ChildSpawner` — disables both the load-time probe and
   * the terminal recheck (fail-closed to live/unverified, never to a wrong
   * hit).
   */
  probeAgentBranches?: ProbeAgentBranchesFn;
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

/** workflow-agent-queue §5 (workflow-experts adds "experts_unresolved"): why an `agent()` call was rejected. */
export type WorkflowChildRejectReason =
  | "invalid_args"
  | "max_children"
  | "budget_exhausted"
  | "spawn_error"
  | "spawn_timeout"
  | "host_call_timeout"
  | "experts_unresolved"
  /** workflow-worktree plan D2: `isolation:"worktree"` requested while `ChildSpawner.worktreeAvailable?.()` is not `true` — no fallback to the shared checkout (decision 1). */
  | "isolation_unavailable";

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
  /**
   * replay-verify plan D4/D9: present only when `workflow.isolationReplay`
   * resolved to `"verify"` for this run (built once by
   * `orchestrator.ts#buildJournalConfig`, before boot). Its absence is what
   * `decideReplay`/`handleAgent` treat as `off` — there is no separate
   * `mode:"off"` variant of this shape.
   */
  readonly isolationReplay?: {
    readonly mode: "verify";
    /** D4.1: the cwd pinned for this run's spawn requests/probe/recheck. */
    readonly cwd: string;
    /** D4.2: entry digests that verified against the load-time snapshot probe. */
    readonly verified: ReadonlySet<string>;
    /** D6.2: this run's unique fold seed — `sha256Hex(nonce:key:occurrence)` is `isoId`, so two runs never coincidentally mint the same one. */
    readonly nonce: string;
    /** D4.2: the load-time probe's own counters, fixed once before boot. */
    readonly stats: { probed: number; verified: number; unverified: number; probeError?: string };
  };
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
    | "worktreeSettleMaxMs"
  >;
  /**
   * The workflow's static absolute **hard ceiling** (`W.hardAt`, fixed at
   * enqueue — workflow-agent-queue §0′ #1). Children are pinned to it: every
   * dispatched child gets `deadlineAt = W.hardAt` (CC4) and `budgetOverride.
   * totalMs = W.hardAt − now` (explicit ⇒ a hard-capped child, D-10), and
   * every `agent()` ack carries it as `deadlineAt` (the worker's settle-wait
   * bound). Children still never outlive the workflow: it ends at `killAt()`
   * and `stopOwned` structurally stops them. Without grace/extension
   * configured this equals the soft deadline.
   */
  readonly workflowDeadlineAt?: Millis;
  /**
   * workflow-agent-queue §4.3 (stage B): the *mutable* instant the workflow
   * is going to stop at (grace window / extensions included — the deadline
   * controller's `killAt`). Bounds every host call (HR2), `gate()`, the BW2
   * budget checks and the queued-dispatch spawn timeout, so a workflow inside
   * its grace window keeps dispatching. Defaults to `workflowDeadlineAt`.
   */
  killAt?(): Millis;
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
  /**
   * replay-verify plan D4.4: the terminal, diagnostic-only recheck — for
   * every `source:"replay"` child whose journaled disposition was
   * `committed`, re-probes its branch and annotates `WorkflowChildSummary.
   * replayStale` ("gone"/"moved") on a mismatch. Never throws, never
   * changes any settle a script already received; a no-op when no journal
   * was configured, `isolationReplay` was never armed, there is no
   * `probeAgentBranches` port, or there were zero committed replay hits
   * this run (zero git calls in every one of those cases). Intended to run
   * *concurrently* with `flushJournal` (orchestrator.ts), never gating it.
   */
  recheckReplayedIsolation(deadlineMs: Millis): Promise<void>;
}

const DEFAULT_AGENT_TYPE = "general-purpose";

/** workflow-agent-queue D2/D5: what `dispatchQueued` needs to spawn a call that was acked as queued. */
interface QueuedAgentCall {
  readonly callId: CallId;
  readonly prompt: string;
  readonly agentType: string;
  readonly label?: string;
  readonly phaseId?: string;
  /** Per-call model/thinking overrides (see `ChildSpawner.spawn`) — resolved once at submission, carried to dispatch. */
  readonly modelOverride?: { provider: string; id: string };
  readonly modelHintOverride?: string;
  readonly thinkingOverride?: ThinkingLevel;
  /** workflow-experts §4.4: the resolved refs (bound to `spawnRequestFor`'s `consultExperts`) and the ids they resolved to (diagnostics, `WorkflowChildSummary.experts`). Set only when `opts.experts` was present and resolution succeeded — a call never reaches this struct otherwise (§4.4's admission gate rejects it first). */
  readonly consultExperts?: readonly ConsultExpertRef[];
  readonly expertIds?: readonly string[];
  /** workflow-worktree plan D1/D2: set only when `opts.isolation` was present AND the D2 availability gate passed — a rejected isolation request never reaches this struct (mirrors `consultExperts`'s admission-gated-first pattern). */
  readonly isolation?: "worktree";
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** workflow-worktree plan D5: fallback when `WorkflowRunBudget.worktreeSettleMaxMs` is absent (an older/test budget object) — matches `DEFAULT_BUDGET.reapMs` (5s, core/deadline.ts) + 1s. */
const DEFAULT_WORKTREE_SETTLE_MAX_MS: Millis = 6_000;

/** replay-verify plan D2: same shape guard journal.ts's `parseEntry` enforces at read time — checked again here at write time so a malformed branch/commit (a `ChildSpawner` contract violation, or a future H3 change this plan didn't anticipate) degrades to "not written" instead of writing a line that would corrupt on the very next load. */
const WRITE_BRANCH_RE = /^pi-agent-[A-Za-z0-9._-]{1,200}$/;
const WRITE_COMMIT_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/**
 * replay-verify plan D3: maps this call's settle-time `ChildWorktreeInfo`
 * (`wt`) onto the `JournalEntry.worktree` shape a journal write is allowed
 * to carry, stamped with the live `isoId` this run folded for it (D6.2).
 * Returns `undefined` — never written — for every disposition the design
 * table (D3) marks "不写": `kept`, `pending`, `none`, or a `committed`
 * missing its sha (H3 succeeded but the trailing `rev-parse HEAD` failed,
 * D1.2) or carrying a shape that fails the same regex `parseEntry` would
 * reject on load (defense-in-depth against a future H3/adapter defect).
 */
function replayableWorktree(wt: ChildWorktreeInfo | undefined, isoId: string): JournalEntry["worktree"] | undefined {
  if (!wt) return undefined;
  if (wt.state === "clean") return { state: "clean", isoId };
  if (
    wt.state === "committed" &&
    wt.branch !== undefined &&
    wt.commit !== undefined &&
    WRITE_BRANCH_RE.test(wt.branch) &&
    WRITE_COMMIT_RE.test(wt.commit)
  ) {
    return { state: "committed", branch: wt.branch, commit: wt.commit, isoId };
  }
  return undefined; // kept / pending / none / committed-without-a-usable-sha
}

/**
 * workflow-worktree plan D5: never rejects, never hangs beyond whatever
 * bound `spawner.awaitWorktree` itself promises — an absent method (an
 * older/fake `ChildSpawner`, or a real adapter over a `SpawnService` with no
 * `waitWorktreeDisposition`) degrades to `{ state: "none" }` instead of
 * throwing, and a throwing implementation (contract violation) is caught
 * defensively as `pending` rather than becoming an unhandled rejection.
 */
async function awaitWorktreeSafe(
  spawner: ChildSpawner,
  runId: RunId,
  opts: { horizon: "settle" | "late"; capMs?: Millis },
): Promise<ChildWorktreeInfo> {
  if (!spawner.awaitWorktree) return { state: "none" };
  try {
    return await spawner.awaitWorktree(runId, opts);
  } catch {
    // A rejecting port (contract violation) says nothing about the run —
    // H3 may still be committing. Map it to `pending` (plan §2 D5 / §6 #15),
    // never `none`, so the script and the outcome never claim "no worktree"
    // for a run that may yet land on a pi-agent branch.
    return { state: "pending" };
  }
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
    worktreeSettleMaxMs: deps.budget.worktreeSettleMaxMs ?? DEFAULT_WORKTREE_SETTLE_MAX_MS,
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
  /** workflow-experts D22: set alongside `call.expertIds` at submission time, consumed once by `recordSettled` to fold `experts` into the recorded `WorkflowChildSummary`. */
  const expertIdsOf = new Map<CallId, readonly string[]>();
  /** workflow-worktree plan D5/D2: set once (in `runBoundChild`) for a call that requested `isolation:"worktree"` and was actually bound to a run — read by `forceSettleActive` (which has no other way to know) and deleted by `recordSettled` alongside the other per-callId maps. */
  const isolationOf = new Map<CallId, true>();
  /** workflow-worktree plan D5 step 3/4: a disposition the "late" listener (no cap, no host timer) delivered after this call's own settle — folded into `worktreeFinal` by the `children` getter at read time, never mutating the frozen `worktree` field. */
  const lateWorktreeOf = new Map<CallId, ChildWorktreeInfo>();
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
  /**
   * callId -> the journal bookkeeping needed to write an entry once this
   * call's live settle arrives (RP3: only successful calls are ever
   * journaled). replay-verify plan D2/D6: `isolation`/`isoId` are set only
   * for a call that itself declared `isolation:"worktree"` while `verify`
   * mode is on (D3/D9: `off` mode keeps the pre-plan behavior of never
   * setting this map at all for an isolated call) — `isoId` is this live
   * run's own fold identity for that call (D6.2's `isoIdLive`), carried
   * here so the eventual write (`runBoundChild`'s `onOutcome`) can stamp it
   * onto the entry regardless of the settle-time disposition.
   */
  const journalMetaOf = new Map<
    CallId,
    {
      taskKey: TaskKey;
      chainDigestBefore: string;
      occurrence: number;
      agentType: string;
      isolation?: "worktree";
      isoId?: string;
    }
  >();
  const replayStats = { hits: 0, misses: 0, skipped: 0 };
  /**
   * replay-verify plan D6.5/D4.4: run-scoped isolation counters that only
   * ever grow — `freshFolds` (F2 actually applied, i.e. an accepted
   * isolated `verify`-mode chain-scope call) and `stale` (the terminal
   * recheck found a previously-trusted replay hit's branch gone/moved).
   * Combined with `deps.journal.isolationReplay.stats`'s load-time probe
   * counts by the `replayStats` getter below. Both stay 0 (never surfaced
   * as a key at all, since `isolation` is only added when `deps.journal.
   * isolationReplay` is configured) when this run never used `verify` mode.
   */
  let freshFolds = 0;
  let staleReplayCount = 0;
  // workflow-experts D13-D15: one scope per run (closure-local, not module
  // scope). `replayTainted` starts false and is set (never cleared) the
  // instant some call's experts resolve successfully (§4.4) — every call
  // *submitted* afterwards reads `tainted:true` at its own journal-block
  // decideReplay (the call that itself set it still reads the pre-taint
  // value, D13's "解析成功" row uses `experts:true`, not `tainted:true`, for
  // itself).
  const expertScope = createWorkflowExpertScope();
  let replayTainted = false;
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
    const experts = expertIdsOf.get(summary.callId);
    labelOf.delete(summary.callId);
    agentTypeOf.delete(summary.callId);
    enqueuedAtOf.delete(summary.callId);
    queueWaitOf.delete(summary.callId);
    expertIdsOf.delete(summary.callId);
    isolationOf.delete(summary.callId);
    const labelled = summary.label === undefined && label !== undefined ? { ...summary, label } : summary;
    const withQueueWait =
      queueWaitMs !== undefined && labelled.queueWaitMs === undefined ? { ...labelled, queueWaitMs } : labelled;
    const enriched =
      experts !== undefined && withQueueWait.experts === undefined ? { ...withQueueWait, experts } : withQueueWait;
    children.push(enriched);
    deps.onChildSettled?.(enriched);
    // workflow-experts §4.4: the single chokepoint every settlement (live,
    // replay hit, withheld, force-settled) passes through — the workflow
    // expert scope needs to see every one of them (D10's "still running" /
    // "completed" / "failed" classification depends on it).
    expertScope.noteSettled(enriched);
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
    // workflow-worktree plan D5 step 5/D7: an isolated, already-bound call
    // that the workflow force-settled (stop/terminate) before its own
    // settle-wait finished still has a real worktree in flight — H3 keeps
    // running in the background regardless (D7). Read `isolationOf` before
    // `recordSettled` deletes it; the pending marker and the late listener
    // are the only trace this force-settle leaves behind for it.
    const isolated = isolationOf.has(callId);
    if (isolated && state?.runId !== undefined) startLateWorktreeListener(callId, state.runId);
    recordSettled({
      callId,
      ...(state?.runId !== undefined ? { runId: state.runId } : {}),
      source: "live",
      status: "aborted",
      durationMs,
      ...(phaseId !== undefined ? { phaseId } : {}),
      ...(isolated && state?.runId !== undefined ? { worktree: { state: "pending" } as const } : {}),
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

  /** Time left until the workflow stops (`killAt`, grace/extensions included); +∞ for the defensive uncapped case. */
  function remainingWorkflowMs(): Millis {
    const killAt = deps.killAt?.() ?? deps.workflowDeadlineAt;
    if (killAt === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(0, killAt - deps.clock.now());
  }

  /**
   * workflow-worktree plan D5 step 3: the unbounded "late" listener — no
   * cap, no host timer, because nothing here ever awaits it; its own upper
   * bound is owned entirely by the port (`5 × reapMs_eff + 1s`, or
   * immediate `disposed` once a stack rebuild/shutdown tears the port
   * down). Only a *real* disposition (`committed`/`clean`/`kept`) is ever
   * recorded — `pending`/`none` mean nothing new arrived (or the port was
   * disposed mid-flight) and are silently discarded, matching D5's "晚到
   * 监听收到 disposed 时直接丢弃".
   */
  function startLateWorktreeListener(callId: CallId, runId: RunId): void {
    void awaitWorktreeSafe(deps.spawner, runId, { horizon: "late" }).then((info) => {
      if (info.state === "pending" || info.state === "none") return;
      lateWorktreeOf.set(callId, info);
    });
  }

  async function handleAgent(callId: CallId, args: unknown): Promise<HostAckEnvelope> {
    const a = args as {
      prompt?: unknown;
      opts?: unknown;
      /** workflow-experts §4.5: the worker's own structural report on the *original* (pre-snapshot) opts object — absent for a raw envelope posted with no report at all (host.test.ts's direct-envelope harness, or a forged/legacy call). */
      optsReport?: { unknownKeys?: readonly string[]; defect?: OptsDefect };
    };
    if (typeof a.prompt !== "string") {
      const message = "agent(prompt, opts?): prompt must be a string";
      emitRejected(callId, "admission", "invalid_args", message, displayMetaOfArgs(args));
      return { kind: "host_ack", id: callId, ok: false, error: { message } };
    }
    // workflow-experts §4.1/§4.4 (D1-D7): strict structural validation of
    // `opts`. The host takes its own independent snapshot of whatever
    // actually arrived on the wire (defense-in-depth — a forged/legacy
    // envelope with no `optsReport` at all must still be caught) and merges
    // it with the worker's own report of the *original* sandboxed object
    // (which the worker never forwards verbatim — N1). Either side's defect
    // wins; `unknownKeys` is the union; the error message is generated once,
    // here.
    const validated = validateAgentOpts(snapshotAgentOpts(a.opts), a.optsReport);
    if (!validated.ok) {
      emitRejected(callId, "admission", "invalid_args", validated.message, displayMetaOfArgs(args));
      return { kind: "host_ack", id: callId, ok: false, error: { message: validated.message } };
    }
    const validOpts = validated.opts;
    const label = validOpts.label;
    const agentType = validOpts.agentType ?? deps.defaultAgentType ?? DEFAULT_AGENT_TYPE;
    // The Agent tool's own split, reused verbatim (`parseStrictModelRef`, no
    // reimplementation): a strict `provider/id` pair becomes `modelOverride`
    // (existence-checked by spawn admission); anything else stays the raw
    // string as `modelHintOverride` (fuzzy-resolved at spawn admission,
    // unresolvable ⇒ spawn error ⇒ `agent()` rejects). Exactly one of the
    // two is ever set.
    // Same rule as the Agent tool (agent-tool.ts: `params.model` truthiness): an
    // empty string means "no override", never an empty fuzzy hint.
    const model = validOpts.model !== undefined && validOpts.model !== "" ? validOpts.model : undefined;
    const modelOverride = model !== undefined ? parseStrictModelRef(model) : undefined;
    const modelHintOverride = model !== undefined && modelOverride === undefined ? model : undefined;
    const thinkingOverride = validOpts.thinking;
    // M3.4 §5.2: worker-source.ts already resolved \`opts.phase\` against the
    // script's environment \`phase(title)\` (explicit \`opts.phase\` wins) before
    // this call ever left the sandbox — this handler just records whatever it
    // receives, it never itself falls back to a "current phase" notion (that
    // state lives in \`currentPhaseId\`/\`handlePhase\` above, worker-side only).
    const phaseId = validOpts.phase;
    // workflow-worktree plan D1 (§2 evidence table, previously M3.5 RP7):
    // opt-in per-call `isolation:"worktree"` — now threaded into
    // `ChildSpawner.spawn()`'s request (real worktree isolation, gated by
    // D2's `worktreeAvailable()` below), and still into the journal's
    // taskKey so the pre-lookup D3/RP7 gate (and the post-lookup RP7 check
    // for older, already-written entries) can veto replaying it.
    const isolation = validOpts.isolation;

    // workflow-experts §4.4/D9-D11/P1 fix: recorded at each of the three
    // REAL `registry.submit` sites below (replay hit / FIFO queue /
    // immediate dispatch) — never here. A call rejected before any of those
    // (invalid_args, max_children, budget_exhausted, experts_unresolved)
    // never occupies a `CallInfo` slot, so a later call reusing the same
    // label never sees a phantom "still running" candidate (§5's table: a
    // rejection must leave zero trace in `expertScope`, matching D10/#23's
    // "caught experts_unresolved, then continue" semantics).
    const declaresExperts = validOpts.experts !== undefined;

    // M3.5 §6.2/§6.4: the replay short-circuit. Computed unconditionally
    // whenever a journal is configured, before any admission-limit checks
    // below — occurrence/chain-digest must advance on *every* submission,
    // hit or miss (定理 3 "至多复用一次" depends on `occCounters` incrementing
    // regardless of outcome), and a replay hit never touches the live
    // resource limits below (it doesn't hold a `SlotPool`/parallel slot).
    const journal = deps.journal;
    // replay-verify plan D6.2: `verify`/`foldable` are computed unconditionally
    // (even without a journal — both then stay `false`) so the taint-vs-fold
    // choice below (§ "D2 ④" area) and the F2 fold application right before
    // dispatch share one flag each with the journal block, matching the
    // pseudocode's variable lifetime (declared once per call, read at up to
    // three points that are NOT nested inside `if (journal)`).
    const verify = journal?.isolationReplay?.mode === "verify";
    const foldable = isolation !== undefined && verify && journal?.scope === "chain";
    // D6.2 F2: set inside the journal block below (iff `foldable`), applied
    // exactly once, right before `QueuedAgentCall` is constructed — never
    // read/written anywhere between (I2: no `await` on that path).
    let pendingFold: string | undefined;
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
        // Raw strings, not the resolved pair: the taskKey must distinguish
        // every distinct *declared* model/thinking (same prompt + different
        // model must never replay the old result). Two spellings of the same
        // model simply miss — safe; the reverse is not.
        ...(model !== undefined ? { model } : {}),
        ...(thinkingOverride !== undefined ? { thinking: thinkingOverride } : {}),
        ...(isolation !== undefined ? { isolation } : {}),
        ...(deps.workflowArgs !== undefined ? { workflowArgs: deps.workflowArgs } : {}),
      };
      const taskKey = taskKeyOf(sem);
      const chainDigestBefore = chainDigest;
      // replay-verify plan D6.3 I1: `kForOccurrence` (the lookup key) is
      // always computed from the *unfolded* `chainDigestBefore` — folding
      // (F1/F2) only ever changes what a LATER call sees, never this call's
      // own occurrence/lookup key.
      const kForOccurrence = journal.scope === "content" ? taskKey : nextChainDigest(chainDigestBefore, taskKey);
      const occurrence = occCounters.get(kForOccurrence) ?? 0;
      occCounters.set(kForOccurrence, occurrence + 1);
      // §6.2 step 5: the chain always advances, hit or miss (still unfolded here).
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
        // workflow-experts §4.4/§5: `experts` is "this call itself declared
        // opts.experts" (regardless of whether resolution below ends up
        // succeeding — the contract table's "解析成功" row still reads
        // `skip:experts` for itself); `tainted` is the run-wide flag set by
        // some *earlier* call's successful resolution (D13). Both bypass
        // `index.lookup` entirely.
        experts: declaresExperts,
        tainted: replayTainted,
        // workflow-worktree plan D3 / replay-verify plan D5: an isolated call
        // is unconditionally skip UNLESS `verify` mode is on, in which case
        // it may still hit a verified `committed`/unchecked `clean` entry.
        isolation: isolation !== undefined,
        ...(journal.replayTtlMs !== undefined ? { replayTtlMs: journal.replayTtlMs } : {}),
        ...(verify
          ? {
              isolationReplay: "verify" as const,
              isolationVerified: (e: JournalEntry) => journal.isolationReplay!.verified.has(e.digest),
            }
          : {}),
      });

      // replay-verify plan D7: `worktreeAvailable()` off at the exact moment
      // of an otherwise-valid isolated hit blocks it (never folds, never
      // journal-writes-as-hit) and falls through to the ordinary D2 gate
      // below, which will reject the call with `isolation_unavailable`.
      const isoHitBlocked =
        decision.kind === "hit" && isolation !== undefined && deps.spawner.worktreeAvailable?.() !== true;
      if (decision.kind === "hit" && !isoHitBlocked) {
        replayStats.hits += 1;
        // D6.2 F1: fold the entry's OWN `isoId` (not a freshly-minted one) —
        // this is what makes a downstream hit reproduce exactly the fold the
        // upstream LIVE run applied (I7), and it is the only place `chainDigest`
        // is folded via an entry that was actually read from the journal.
        if (foldable && decision.entry.worktree !== undefined) {
          chainDigest = nextChainDigest(chainDigest, `iso:${decision.entry.worktree.isoId}`);
        }
        const wt: ChildWorktreeInfo | undefined =
          decision.entry.worktree === undefined
            ? undefined
            : decision.entry.worktree.state === "committed"
              ? { state: "committed", branch: decision.entry.worktree.branch, commit: decision.entry.worktree.commit }
              : { state: "clean" };
        expertScope.noteSubmitted(callId, label);
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
          ...(wt !== undefined ? { worktree: wt } : {}),
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
          ...(wt !== undefined ? { worktree: wt } : {}),
        } satisfies HostSettleEnvelope);
        return {
          kind: "host_ack",
          id: callId,
          ok: true,
          value: { callId, deadlineAt: deps.clock.now() },
        };
      }
      if (decision.kind === "miss") replayStats.misses += 1;
      else replayStats.skipped += 1; // covers a genuine skip decision AND an isoHitBlocked hit
      // workflow-experts D12/D13/P3: an experts call (this one) or anything
      // submitted after the chain was tainted is NEVER journaled, regardless
      // of how its live settle turns out — skip the bookkeeping that would
      // otherwise let `runBoundChild`'s completion handler write an entry.
      // replay-verify plan D3/D9: an isolated call under `off` mode is never
      // journaled either (the pre-plan behavior, `isolation === undefined ||
      // verify` below is false for it); under `verify` mode it IS eligible
      // (independent of scope — content scope keeps writing too, D6.4's "弱
      // 模式"), unless `declaresExperts`/`replayTainted` already vetoes it
      // (same rule as any other call).
      const isoIdLive =
        isolation !== undefined && verify
          ? sha256Hex(`${journal.isolationReplay!.nonce}:${kForOccurrence}:${occurrence}`).slice(0, 32)
          : undefined;
      if (!declaresExperts && !replayTainted && (isolation === undefined || verify)) {
        journalMetaOf.set(callId, {
          taskKey,
          chainDigestBefore,
          occurrence,
          agentType,
          ...(isoIdLive !== undefined ? { isolation: "worktree" as const, isoId: isoIdLive } : {}),
        });
      }
      // D6.3 I3/I4: `pendingFold` is set purely from `foldable`/`isoIdLive` —
      // NOT gated by `declaresExperts`/`replayTainted` (D8: an accepted
      // isolated call still folds even after the chain was independently
      // tainted by an earlier experts call; I3: at most one fold per call).
      pendingFold = foldable ? isoIdLive : undefined;
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

    // workflow-worktree plan D2 (same admission stage as the experts
    // resolution right below): the live availability gate for
    // `isolation:"worktree"` — decision 1, no fallback to the shared
    // checkout. Checked before this call ever touches the registry,
    // `expertScope`, or `replayTainted` — a rejected isolation call leaves
    // no trace anywhere (`journalMetaOf` — replay-verify plan D6.2: possibly
    // just set above, for a `verify`-mode isolated call — is explicitly
    // deleted here so a rejected call never lingers as if it were pending a
    // live write).
    if (isolation !== undefined && deps.spawner.worktreeAvailable?.() !== true) {
      journalMetaOf.delete(callId);
      const message =
        'agent(): isolation:"worktree" requires worktree.enabled=true — there is no fallback to the shared checkout';
      emitRejected(callId, "admission", "isolation_unavailable", message, { label, agentType, phaseId });
      return { kind: "host_ack", id: callId, ok: false, error: { message } };
    }
    if (isolation !== undefined && !foldable) {
      // D3: an accepted isolation call taints the rest of the chain exactly
      // like a successful experts resolution below — this call's own
      // journal-block decision already ran above reading the pre-taint
      // value (`isolation:true` already forced it to `skip`, independent of
      // `tainted`). replay-verify plan D6: when `foldable` (verify mode,
      // chain scope) the taint is replaced by the F2 fold below instead —
      // D9/off mode and content scope keep this unconditional taint.
      replayTainted = true;
    }

    // workflow-experts §4.2/§4.4 stage ④ (§5's ordering: after journal/
    // maxChildren/BW2, before queueing/dispatch): resolve the whitelist.
    // `mapLocal`'s own rejects and the resolver's failures are both reported
    // the same way — `experts_unresolved`, an ordinary ack failure the
    // script can `.catch()` (D11: fast, synchronous, bounded — a handful of
    // `statSync`s at most, never a new wait).
    let consultExperts: readonly ConsultExpertRef[] | undefined;
    let expertIds: readonly string[] | undefined;
    if (declaresExperts) {
      const resolved = resolveWorkflowExperts(validOpts.experts!, expertScope, deps.spawner.resolveExperts);
      if (!resolved.ok) {
        emitRejected(callId, "admission", "experts_unresolved", resolved.message, { label, agentType, phaseId });
        return { kind: "host_ack", id: callId, ok: false, error: { message: resolved.message } };
      }
      consultExperts = resolved.refs;
      expertIds = resolved.ids;
      expertIdsOf.set(callId, expertIds);
      // D13: taint takes effect for every call *submitted after this point* —
      // this call's own journal-block decision already ran (above) reading
      // the pre-taint value, exactly matching the contract table's "带
      // experts，解析成功" row (`experts:true`, not `tainted:true`, for itself).
      replayTainted = true;
    }

    // replay-verify plan D6.2/D6.3 F2: the ONLY point `chainDigest` is
    // folded for a live (not-replayed) accepted isolated call — every
    // rejection above already `return`ed before reaching here (I4), and
    // every async failure after this point (spawn error, queued-and-
    // withheld, etc.) leaves the fold in place (I5/I6: fail-safe, since a
    // fold with nothing ever journaled under it can only ever miss, never
    // wrongly hit). Still inside the same synchronous段 the journal block
    // started in (I2: no `await` between them).
    if (pendingFold !== undefined) {
      freshFolds += 1;
      chainDigest = nextChainDigest(chainDigest, `iso:${pendingFold}`);
    }

    const call: QueuedAgentCall = {
      callId,
      prompt: a.prompt,
      agentType,
      ...(label !== undefined ? { label } : {}),
      ...(phaseId !== undefined ? { phaseId } : {}),
      ...(modelOverride !== undefined ? { modelOverride } : {}),
      ...(modelHintOverride !== undefined ? { modelHintOverride } : {}),
      ...(thinkingOverride !== undefined ? { thinkingOverride } : {}),
      ...(consultExperts !== undefined ? { consultExperts } : {}),
      ...(expertIds !== undefined ? { expertIds } : {}),
      ...(isolation !== undefined ? { isolation } : {}),
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
      expertScope.noteSubmitted(callId, label);
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
    expertScope.noteSubmitted(callId, label);
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
    expertScope.noteBound(callId, spawned.runId, effectiveLabel);
    runBoundChild(callId, spawned.runId, {
      agentType,
      phaseId,
      effectiveLabel,
      ...(call.isolation !== undefined ? { isolation: call.isolation } : {}),
    });

    return { kind: "host_ack", id: callId, ok: true, value: { callId, deadlineAt: derived.deadlineAt } };
  }

  /**
   * The one `deriveChildBudget` call site — submission-time BW2 precheck and
   * dispatch time alike. The child budget is derived against the static hard
   * ceiling (`workflowDeadlineAt` = `W.hardAt`, §0′ #1: totalMs = hardAt − now,
   * deadlineAt = hardAt), while BW2 "expired" is judged against `killAt` —
   * the instant the workflow itself actually stops.
   */
  function deriveNow(): ReturnType<typeof deriveChildBudget> {
    if (remainingWorkflowMs() <= 0) return { totalMs: 0, queueWaitMs: 0, capped: "expired" };
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
    // replay-verify plan D4.1: the pinned cwd is only ever attached to an
    // isolated call's own spawn request, and only under `verify` mode — off
    // mode and every non-isolated call get the byte-identical (no `cwd`)
    // request (D9's off-mode guarantee).
    const isolationCwd =
      call.isolation !== undefined && deps.journal?.isolationReplay !== undefined
        ? deps.journal.isolationReplay.cwd
        : undefined;
    return {
      type: call.agentType,
      prompt: call.prompt,
      ...(call.label !== undefined ? { label: call.label } : {}),
      ...(call.modelOverride !== undefined ? { modelOverride: call.modelOverride } : {}),
      ...(call.modelHintOverride !== undefined ? { modelHintOverride: call.modelHintOverride } : {}),
      ...(call.thinkingOverride !== undefined ? { thinkingOverride: call.thinkingOverride } : {}),
      ...(call.consultExperts !== undefined ? { consultExperts: call.consultExperts } : {}),
      ...(call.isolation !== undefined ? { isolation: call.isolation } : {}),
      ...(isolationCwd !== undefined ? { cwd: isolationCwd } : {}),
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
    meta: {
      agentType: string;
      phaseId: string | undefined;
      effectiveLabel: string | undefined;
      /** workflow-worktree plan D5: forwarded from `call.isolation` by both dispatch paths — `undefined` for an ordinary call. */
      isolation?: "worktree";
    },
  ): void {
    const { agentType, phaseId, effectiveLabel, isolation } = meta;
    if (isolation !== undefined) isolationOf.set(callId, true);
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

    const onOutcome = (outcome: ChildOutcome | undefined, wt: ChildWorktreeInfo | undefined): void => {
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
          ...(wt !== undefined ? { worktree: wt } : {}),
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
        ...(wt !== undefined ? { worktree: wt } : {}),
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
          // replay-verify plan D3: an isolated call only ever writes when its
          // settle-time disposition (`wt`) maps onto a replayable shape
          // (`replayableWorktree`) — `kept`/`pending`/`none`/a `committed`
          // without a usable sha are all silently "not written" (D3's table),
          // never a corrupt/partial entry.
          const worktree = jm.isolation === "worktree" ? replayableWorktree(wt, jm.isoId!) : undefined;
          if (jm.isolation === undefined || worktree !== undefined) {
            journal.store.append(
              journal.dir,
              buildEntry({
                scope: journal.scope,
                key: jm.taskKey,
                chainDigestBefore: jm.chainDigestBefore,
                occurrence: jm.occurrence,
                agentType: jm.agentType,
                ...(jm.isolation !== undefined ? { isolation: jm.isolation } : {}),
                ...(worktree !== undefined ? { worktree } : {}),
                value: outcome.text ?? null,
                completedAt: deps.clock.now(),
                durationMs,
              }),
            );
          }
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
              // workflow-worktree plan D5: only ever attached to the ok:true
              // branch — a failed/aborted isolated child's worktree state
              // still lands in the recorded summary above, but the wire
              // contract to the worker (fullResult's `worktree` key) never
              // carries it for a failure.
              ...(wt !== undefined ? { worktree: wt } : {}),
            }
          : { kind: "host_settle", callId, ok: false, error: outcome.error ?? { message: `child ${outcome.status}` } };
      deps.workerHost.send(settleMsg);
    };

    /**
     * workflow-worktree plan D5 (host flow, steps 1-3): for an isolated
     * call, bound the wait for H3's settle-horizon disposition by
     * `min(remainingWorkflowMs(), worktreeSettleMaxMs)` — the call keeps its
     * `maxParallel` slot the whole time (D8) — then start the unbounded
     * "late" listener and hand both outcome+disposition to `onOutcome`
     * together. An unisolated call skips all of this (`wt` stays
     * `undefined`, byte-identical to the pre-D5 settle path).
     */
    async function afterOutcome(outcome: ChildOutcome | undefined): Promise<void> {
      if (registry.resolve(callId)?.phase === "settled") return; // already force-settled (stopOwned/onTerminating already started its own late listener, D5 step 5).
      if (isolation === undefined) {
        onOutcome(outcome, undefined);
        return;
      }
      const capMs = Math.max(1, Math.min(remainingWorkflowMs(), budget.worktreeSettleMaxMs));
      const result = await withDeadline(
        awaitWorktreeSafe(deps.spawner, runId, { horizon: "settle", capMs }),
        capMs,
        deps.clock,
        "worktree_settle",
      );
      if (registry.resolve(callId)?.phase === "settled") return; // raced with a stop while the settle-wait was in flight.
      const wt: ChildWorktreeInfo = result.ok ? result.value : { state: "pending" };
      startLateWorktreeListener(callId, runId);
      onOutcome(outcome, wt);
    }

    // HR3: fire the settle wait in the background. A rejecting waitAll() is
    // treated like "did not settle" — it must never leave the call holding a
    // maxParallel slot (and the FIFO queue stalled behind it) forever.
    void deps.spawner
      .waitAll({ runIds: [runId] })
      .then(
        ({ settled }) => afterOutcome(settled[0]),
        () => afterOutcome(undefined),
      )
      .catch((e: unknown) => {
        // A throwing observer (onChildEvent/onChildSettled) must not become an
        // unhandled rejection in the host process (same defensive net as
        // dispatchQueued's own continuation below).
        console.warn(`[pi-subagent] workflow agent() worktree-wait continuation failed: ${errMsg(e)}`);
      });
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
      expertScope.noteBound(callId, r.runId, effectiveLabel);
      runBoundChild(callId, r.runId, {
        agentType: call.agentType,
        phaseId: call.phaseId,
        effectiveLabel,
        ...(call.isolation !== undefined ? { isolation: call.isolation } : {}),
      });
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
      // workflow-worktree plan D5 step 4: fold in any "late" disposition
      // that has arrived since this call's own settle — the frozen
      // `worktree` field the worker actually saw is never mutated; only a
      // fresh object with `worktreeFinal` attached is returned, and only
      // for the callIds `lateWorktreeOf` actually has something for.
      if (lateWorktreeOf.size === 0) return children;
      return children.map((c) => {
        const final = lateWorktreeOf.get(c.callId);
        return final === undefined ? c : { ...c, worktreeFinal: final };
      });
    },
    get currentPhaseId() {
      return currentPhaseId;
    },
    get replayStats(): WorkflowReplayStats | undefined {
      if (!deps.journal) return undefined;
      const iso = deps.journal.isolationReplay;
      return {
        hits: replayStats.hits,
        misses: replayStats.misses,
        skipped: replayStats.skipped,
        corruptLines: deps.journal.index.stats.corruptLines,
        ...(replayTainted ? { tainted: true as const } : {}),
        ...(iso !== undefined
          ? {
              isolation: {
                probed: iso.stats.probed,
                verified: iso.stats.verified,
                unverified: iso.stats.unverified,
                freshFolds,
                stale: staleReplayCount,
                ...(iso.stats.probeError !== undefined ? { probeError: iso.stats.probeError } : {}),
              },
            }
          : {}),
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
    async recheckReplayedIsolation(deadlineMs) {
      const iso = deps.journal?.isolationReplay;
      if (!iso || !deps.spawner.probeAgentBranches) return;
      const targets: Array<{ callId: CallId; branch: string; commit: string }> = [];
      for (const c of children) {
        if (c.source === "replay" && c.worktree?.state === "committed" && c.worktree.branch !== undefined) {
          targets.push({ callId: c.callId, branch: c.worktree.branch, commit: c.worktree.commit! });
        }
      }
      if (targets.length === 0) return;
      try {
        const stale = await recheckBranches(targets, deps.spawner.probeAgentBranches, {
          cwd: iso.cwd,
          timeoutMs: Math.max(1, Math.min(2_000, deadlineMs)),
          clock: deps.clock,
        });
        if (stale.size === 0) return;
        for (let i = 0; i < children.length; i += 1) {
          const c = children[i]!;
          if (c.source !== "replay" || c.worktree?.state !== "committed" || c.worktree.branch === undefined) continue;
          const s = stale.get(c.worktree.branch);
          if (s === undefined) continue;
          staleReplayCount += 1;
          children[i] = { ...c, replayStale: s };
        }
      } catch {
        // D4.4: a defect surfacing here (a throwing `probeAgentBranches`
        // contract violation) must never fail the workflow's terminal
        // decision — the whole point of this recheck is diagnostic-only.
      }
    },
  };
}
