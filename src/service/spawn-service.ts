import { statSync } from "node:fs";
import { applyBudgetPolicy } from "../core/deadline.js";
import { mergeBudget } from "../config/settings.js";
import { newRunId, isRunId } from "../core/ids.js";
import { deriveUniqueLabel, firstNonEmptyLine, sanitizeLabelBase } from "../core/labels.js";
import { toErrorInfo } from "../core/errors.js";
import { formatSlots, slotsInfo, type SlotsInfo } from "../core/format.js";
import type { AgentTypeRegistry } from "../config/agent-types.js";
import { formatModelCandidates, formatUnknownModelError, type ModelCandidate } from "../config/model-hint.js";
import type { QuotaGateVerdict } from "../quota/gate.js";
import { CONSULT_MAIN_AGENT_TYPE } from "../core/types.js";
import type {
  AgentTypeConfig,
  DeadlineBudget,
  ErrorInfo,
  RunId,
  RunOutcome,
  RunSnapshot,
  SpawnRequest,
  StopCause,
  WorktreeDisposal,
} from "../core/types.js";
import type { LifecycleSink, Runner, RunnerSpec, SlotPool } from "./ports.js";
import { TombstoneStore } from "./tombstone.js";
import {
  resolveResumeTarget,
  resolveRunId,
  type ResolveResumeResult,
  type ResolveRunResult,
} from "./resolve-target.js";

/**
 * consult (plan §16): the "no type" admission branch for `consult("main",
 * …)` — a static, in-memory `AgentTypeConfig` used ONLY when a request names
 * `CONSULT_MAIN_AGENT_TYPE` AND carries `forkSessionFrom`. Deliberately NOT
 * registered anywhere (no `AgentTypeRegistry` involvement at all): it never
 * appears in `list()`/the system-prompt agent-types section, and a plain
 * dispatch of this type name (no `forkSessionFrom`) is rejected exactly like
 * any other unknown type, since `deps.types.get()` is only ever bypassed
 * below when both conditions hold. Every field the runtime adapter forces
 * for a consult run anyway (tools, prompt) is irrelevant here; this only
 * needs to exist so admission has *some* config to build the run's
 * RunnerSpec from.
 */
const MAIN_SNAPSHOT_TYPE_CONFIG: AgentTypeConfig = {
  name: CONSULT_MAIN_AGENT_TYPE,
  description: 'Internal: a read-only fork of the host main session (consult("main", …) only).',
  systemPrompt: "",
  promptMode: "append",
};

export interface SpawnLabelTarget {
  readonly runId: RunId;
  readonly type: SpawnRequest["type"];
  readonly parent: RunId | "root";
}
export type BoundedWaitResult = { kind: "settled"; outcome: RunOutcome } | { kind: "pending" };
/**
 * workflow-worktree plan D5/D13: the four possible outcomes of waiting for a
 * worktree disposition. `disposed` only appears after `SpawnService.dispose()`
 * has run (a stack rebuild/shutdown) — every still-pending waiter is settled
 * with it immediately, and every subsequent call returns it synchronously.
 */
export type WorktreeWaitResult =
  { kind: "settled"; disposition: WorktreeDisposal } | { kind: "none" } | { kind: "timeout" } | { kind: "disposed" };
export interface SpawnService {
  spawn(req: SpawnRequest): Promise<
    | {
        runId: RunId;
        label?: string;
        /** §5 (user follow-up, agent-tool pool-full plan): current pool occupancy on EVERY successful dispatch, slotless calls included — same inclusion rule as SlotPool itself (consult forks / nested Agent excluded, workflow children included). */
        slots: SlotsInfo;
        /** L1 (agent-tool pool-full plan §2): present only when this (non-slotless) request was admitted while the conceptual pool was already at capacity — i.e. it queues behind `runningCount` others, `limit`-wide, at 1-indexed `position`, bounded by `queueWaitMs` (the same budget the real SlotPool enforces). */
        queued?: { position: number; runningCount: number; limit: number; queueWaitMs: number };
      }
    | { error: ErrorInfo }
  >;
  spawnAndWait(req: SpawnRequest): Promise<RunOutcome>;
  /**
   * P1 fix (todo #16 review): same dispatch/wait semantics as spawnAndWait,
   * but also returns the dispatch-time `slots`/`queued` snapshot so a
   * blocking caller (the nested Agent tool) can render pool occupancy
   * without RunOutcome carrying a field that only makes sense at dispatch
   * time. Optional so pre-existing SpawnService test doubles keep
   * compiling; a real caller falls back to plain spawnAndWait when absent.
   */
  spawnAndWaitWithSlots?(req: SpawnRequest): Promise<{
    outcome: RunOutcome;
    slots: SlotsInfo;
    queued?: { position: number; runningCount: number; limit: number; queueWaitMs: number };
  }>;
  waitOutcome(runId: RunId, waitMs?: number): Promise<BoundedWaitResult>;
  expectsAck(runId: RunId): boolean;
  /**
   * X1 (agent tree): post-settlement worktree display state. beforeReap runs
   * AFTER finish() built the terminal snapshot, so the disposal outcome can
   * only land by patching the settled record here (the live registry shadows
   * the durable store for the current session — patching the store alone
   * would never converge). Optional so test fakes of SpawnService stay valid.
   */
  markWorktreeDisposition?(runId: RunId, disposition: WorktreeDisposal): void;
  /**
   * workflow-worktree plan D5: bounded wait for a worktree disposition
   * report from H3 (beforeReap), keyed off the run's ACTUAL effective
   * `budget.reapMs` (D5a) rather than a constant. `horizon` picks the upper
   * bound: "settle" = reapMs+1s (covers the runner's own withTimeout(reapMs)
   * window), "late" = 5×reapMs+1s (covers H3 continuing to run in the
   * background after the runner gave up on it — up to 5 git commands, each
   * bounded by reapMs). `capMs` additionally clamps the wait from above (the
   * caller's own remaining budget). Never rejects.
   */
  waitWorktreeDisposition?(
    runId: RunId,
    opts: { horizon: "settle" | "late"; capMs?: number },
  ): Promise<WorktreeWaitResult>;
  /**
   * workflow-worktree plan D13: idempotent. Settles every outstanding
   * worktree waiter with `{ kind: "disposed" }`, clears their timers, and
   * clears the D5a reapMs table. After this call `waitWorktreeDisposition`
   * always resolves `{ kind: "disposed" }` synchronously and
   * `markWorktreeDisposition` becomes a no-op — late H3 reports must be
   * redirected to the current session's durable sink instead (Runner.dispose,
   * see runtime-adapter.ts), never back into this (about to be replaced)
   * live registry or its store.
   */
  dispose?(): void;
  abort(runId: RunId, cause?: StopCause): Promise<boolean>;
  waitAll(opts?: { runIds?: RunId[]; waitMs?: number }): Promise<{ settled: RunOutcome[]; pending: RunId[] }>;
  /** Resolve a label without exposing the mutable internal index. */
  getLabel?(label: string): SpawnLabelTarget | undefined;
  /** Resolve model-facing run handles to their canonical process-local id. */
  resolveRun(handle: string): ResolveRunResult;
  /** Resolve a model-facing resume handle to an owned, existing session file. */
  resolveResume(handle: string): ResolveResumeResult;
  /**
   * CC1 (workflow design §8.2 / §3.7 OS1–OS4): the only owner-stop entry
   * point for a caller whose own id is never a tracked run (e.g. a future
   * workflow orchestrator's `WorkflowId` — it has no session/RunState, so
   * `abort(workflowId)` would return `false` at its first-line `!running.has`
   * guard without ever cascading). Reuses the exact same recursive cascade
   * `abort()` already performs (`cascadeChildren`) — there is only ever one
   * cascade implementation, never a second one (OS1).
   */
  stopChildrenOf(parentId: RunId, cause?: StopCause): Promise<{ stopped: RunId[]; pending: RunId[] }>;
  /**
   * L1 (agent-tool pool-full plan §4): live concurrencyLimit update —
   * `/agent settings` writing `concurrencyLimit` calls this (via
   * `SettingsStore.onWrite`) so the change takes effect immediately instead
   * of requiring `/reload`. Forwards to `SlotPool.setLimit` (optional on the
   * port; a pool that doesn't implement it is a no-op here, never a throw).
   */
  setConcurrencyLimit(n: number): void;
  /**
   * L1 todo #19 (list_subagents): current pool occupancy on demand, WITHOUT
   * spawning — same admission-time `slotfulLabel` count and `slotsInfo` call
   * the pool-full reject/queue paths above already use (never `deps.pool.stats`,
   * for the identical reason those paths avoid it: `stats.inUse` only updates
   * deep inside the runtime adapter, after H2/worktree creation, so it lags
   * the atomic admission reservation this method must mirror).
   */
  slots(): SlotsInfo;
}
export interface SpawnServiceDeps {
  types: AgentTypeRegistry;
  pool: SlotPool;
  runner: Runner;
  now?: () => number;
  budget?: Partial<DeadlineBudget>;
  onSnapshot?: (snapshot: RunSnapshot) => void;
  /** Narrow admission hook for the fabric tree; called after a child edge is recorded. */
  onSpawnEdge?: (parentRunId: RunId, childRunId: RunId) => void;
  onLifecycle?: LifecycleSink;
  onOutcomeAcked?: (outcome: RunOutcome) => void;
  notifyTerminalFailure?: (outcome: RunOutcome) => void;
  /** X6 bridge: fired when a label is first registered (mention registry feed). */
  onLabel?: (label: string, target: SpawnLabelTarget, info: { resumed: boolean }) => void;
  tombstones?: TombstoneStore;
  /** X3: hard cap on nested-delegation depth (top-level run = depth 0). Default 3. */
  maxNestedDepth?: number;
  /**
   * Fuzzy model-hint resolution (frontmatter `model:` non-pair value or the
   * Agent tool's free-form `model` param), wired in stack.ts over pi's
   * model registry. Undefined = hints cannot resolve and are rejected with
   * a config error (fail-closed, never silently inherited).
   */
  resolveModelHint?: (hint: string) => { provider: string; id: string } | undefined;
  /** Optional live candidate list for self-correcting unknown-hint errors. */
  availableModels?: () => readonly ModelCandidate[];
  /**
   * Strict `provider/id` existence check against pi's model registry — the
   * exact lookup the session driver's create() would otherwise fail on
   * (`ModelRegistry.find`), wired in stack.ts. `true` = known, `false` =
   * definitely unknown ⇒ admission rejects with suggestions (no run is
   * created), `undefined` = registry unavailable ⇒ admission does not block
   * (fail-open: the driver's own lookup stays the backstop). Not injected ⇒
   * no dispatch-time check at all (pre-existing behavior).
   */
  modelExists?: (model: { provider: string; id: string }) => boolean | undefined;
  /**
   * 额度闸门（quota-plan §6）：**同步**、只读缓存、返回 undefined 放行。
   * 未注入时行为与今天完全一致（全特性可一键回退，plan R11）。
   */
  quotaGate?: (model: { provider: string; id: string }) => QuotaGateVerdict | undefined;
  /** unknown-hint 错误里给候选模型附额度标记（quota-plan §4.3）。缺省时错误文案逐字节不变。 */
  quotaAnnotate?: (candidate: ModelCandidate) => string | undefined;
  /**
   * timeout-notify 总开关（D-16，settings.extend.enabled）。false 时合并后钳
   * maxExtensions = 0——宽限与延长一并关闭，agent-type / per-spawn 的覆盖都盖不回来
   * （不注册工具就不发"请调用工具"的通知，保持一致性）。Default true。
   */
  extensionsEnabled?: boolean;
  runIdTaken?: (id: string) => boolean;
  /** Test seam for pre-populating the process-local label index. */
  labelIndex?: Map<string, SpawnLabelTarget>;
}
export function createSpawnService(deps: SpawnServiceDeps): SpawnService & { snapshots(): readonly RunSnapshot[] } {
  const now = deps.now ?? (() => Date.now());
  const maxNestedDepth = deps.maxNestedDepth ?? 3;
  const records = new Map<RunId, RunSnapshot>();
  const outcomes = new Map<RunId, RunOutcome>();
  const waits = new Map<RunId, Set<(outcome: RunOutcome) => void>>();
  const running = new Set<RunId>();
  // D19 (workflow-experts §4.7): idempotent set of runIds currently being
  // torn down. Populated synchronously by abort() BEFORE its first `await`
  // (cascadeChildren) so a consult fork admission racing the same tick sees
  // it; cleared in finish() (also idempotent — Set.delete on an absent key
  // is a no-op). This is deliberately separate from `running`: a run stays
  // in `running` until finish() actually settles it, but must be rejected
  // for new fork admission the instant abort() is called.
  const stopping = new Set<RunId>();
  const claimedRunIds = new Set<RunId>();
  const resumeLocks = new Set<string>();
  // L1 (agent-tool pool-full plan §1): every currently ADMITTED (from the
  // instant spawn() decides to proceed, until finish()) non-slotless run,
  // keyed to its effective label. This is deliberately NOT `deps.pool.stats`
  // (which only reflects runs that have actually reached the real
  // SlotPool.acquire() call — deep inside the runtime adapter, AFTER H2/
  // worktree creation): admission decisions must be atomic against
  // concurrent same-tick spawn() calls, and the real pool only updates
  // asynchronously, well after this function has already returned. Every
  // non-slotless request — reject-policy or queue-policy alike — is
  // tracked here so a reject-policy admission check sees queue-policy
  // occupants too (workflow children, consult forks, resume, /task).
  const slotfulLabel = new Map<RunId, string>();
  // D5a (workflow-worktree plan): per-run effective reapMs for worktree waits,
  // tombstoned (expiresAt) rather than FIFO-capped so a slow, still-live run
  // never loses its own entry because unrelated runs churned through the map.
  // Capacity-bounded (4096) only against NEW writes; existing entries are
  // never evicted to make room.
  const worktreeWait = new Map<RunId, { reapMs: number; expiresAt?: number }>();
  const WORKTREE_WAIT_CAPACITY = 4096;
  interface WorktreeWaiter {
    resolve(result: WorktreeWaitResult): void;
    timer?: ReturnType<typeof setTimeout>;
  }
  const worktreeWaiters = new Map<RunId, Set<WorktreeWaiter>>();
  let worktreeDisposed = false;
  const worktreeSettleMs = (reapMs: number) => reapMs + 1_000;
  const worktreeLateMs = (reapMs: number) => 5 * reapMs + 1_000;
  const pruneWorktreeWait = () => {
    const n = now();
    for (const [id, entry] of worktreeWait) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= n) worktreeWait.delete(id);
    }
  };
  const effectiveReapMs = (runId: RunId): number => worktreeWait.get(runId)?.reapMs ?? mergeBudget(deps.budget).reapMs;
  const settleWorktreeWaiter = (runId: RunId, waiter: WorktreeWaiter, result: WorktreeWaitResult): void => {
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    const set = worktreeWaiters.get(runId);
    if (set) {
      set.delete(waiter);
      if (set.size === 0) worktreeWaiters.delete(runId);
    }
    waiter.resolve(result);
  };
  const labels = deps.labelIndex ?? new Map<string, SpawnLabelTarget>();
  const tombstones = deps.tombstones ?? new TombstoneStore(30 * 60 * 1000, now);
  // X3: nested-delegation bookkeeping. `nesting` holds, for every currently
  // *running* top-level or nested run, the depth it was spawned at plus the
  // canSpawn whitelist of its own agent type (i.e. what it, in turn, is
  // allowed to spawn) — this is the authoritative enforcement point,
  // independent of (and in addition to) the injected nested Agent tool's own
  // check in tools/agent-tool.ts. `childrenOf`/`parentOf` track the run tree
  // purely for cascading abort; both are cleaned up as runs finish so they
  // never grow past the number of currently-running nested runs.
  const nesting = new Map<RunId, { depth: number; canSpawn?: string[] }>();
  const childrenOf = new Map<RunId, Set<RunId>>();
  const parentOf = new Map<RunId, RunId>();
  const targetDeps = () => ({
    labels,
    liveSnapshots: () => [...records.values()],
    records: () => [...records.values()],
    tombstones,
    now,
  });
  const resolveRun = (handle: string) => resolveRunId(handle, targetDeps());
  const resolveResume = (handle: string) => resolveResumeTarget(handle, targetDeps());
  const terminal = (s: string) => ["completed", "failed", "timed_out", "aborted"].includes(s);
  const finish = (outcome: RunOutcome) => {
    outcomes.set(outcome.runId, outcome);
    running.delete(outcome.runId);
    stopping.delete(outcome.runId);
    claimedRunIds.delete(outcome.runId);
    nesting.delete(outcome.runId);
    slotfulLabel.delete(outcome.runId); // L1: release the conceptual slot regardless of admission policy
    const parent = parentOf.get(outcome.runId);
    if (parent !== undefined) {
      parentOf.delete(outcome.runId);
      const siblings = childrenOf.get(parent);
      if (siblings) {
        siblings.delete(outcome.runId);
        if (siblings.size === 0) childrenOf.delete(parent);
      }
    }
    const snapshot = outcome.diag
      ? ({
          runId: outcome.runId,
          generation: outcome.diag.generation,
          status: outcome.status,
          phase: "settled",
          // consult plan §9 T-18 (package E finding): this fallback
          // rebuild from `outcome.diag` (RunOutcome carries no parentRunId
          // of its own) used to silently drop the nesting edge that the
          // runner's own terminal snapshot (core/state-machine.ts settle())
          // already carried through `onSnapshot` moments earlier in this
          // same call — every nested run (X3 included, not just consult)
          // lost its `nested` fleet marker and `query.list({ parentRunId })`
          // visibility the instant it settled. `parent` is `parentOf.get
          // (outcome.runId)`, captured above before the cascade cleanup.
          ...(parent !== undefined ? { parentRunId: parent } : {}),
          deadlines: {
            enqueuedAt: outcome.diag.enqueuedAt ?? outcome.diag.createdAt,
            deadlineAt: outcome.diag.deadlineAt,
            queueDeadlineAt: undefined,
            // BL-5：终态重建从 diag 镜像恢复硬天花板与（宽限中结束的）宽限窗口
            ...(outcome.diag.hardDeadlineAt !== undefined ? { hardDeadlineAt: outcome.diag.hardDeadlineAt } : {}),
            ...(outcome.diag.overtime?.grace !== undefined ? { graceUntil: outcome.diag.overtime.grace.until } : {}),
          },
          diag: { ...outcome.diag },
          outcome,
          updatedAt: now(),
        } satisfies RunSnapshot)
      : undefined;
    if (snapshot) {
      records.set(outcome.runId, snapshot);
      tombstones.register(snapshot);
      deps.onSnapshot?.(snapshot);
    }
    // D5a: finish() runs BEFORE H3 (beforeReap) completes (waitAll returns
    // early, see spawn-service.ts:231/:695-716) — outcome.diag.worktree at
    // this point only tells us whether isolation was ever attempted
    // ("active", set at request-build time), never the final disposition.
    pruneWorktreeWait();
    if (outcome.diag?.worktree) {
      // Only refresh an entry start() admitted — never create one here, so the
      // D5a capacity bound holds (a run past capacity keeps no entry and every
      // later wait falls back to settings.budget.reapMs).
      const entry = worktreeWait.get(outcome.runId);
      if (entry)
        worktreeWait.set(outcome.runId, { reapMs: entry.reapMs, expiresAt: now() + worktreeLateMs(entry.reapMs) });
    } else {
      worktreeWait.delete(outcome.runId);
    }
    for (const resolve of waits.get(outcome.runId) ?? []) resolve(outcome);
    waits.delete(outcome.runId);
  };
  const start = async (
    req: SpawnRequest,
    runId: RunId,
    config: NonNullable<ReturnType<AgentTypeRegistry["get"]>>,
    budget: DeadlineBudget,
    resumeLockKeys: readonly string[] = [],
    depth = 0,
    // Resolved at spawn admission (strict pair or fuzzy hint, request
    // override winning over the type's config) — start() itself never
    // re-derives it from req/config.
    model?: { provider: string; id: string },
  ) => {
    running.add(runId);
    // D5a: capture the run's ACTUAL effective reapMs (this mergeBudget result,
    // not a constant) the moment it's known, so a later wait can use it even
    // if agent-type-level budgetOverride raised/lowered it. Capacity-bounded
    // only against new writes — an already-running run is never evicted.
    if (req.isolation === "worktree" && worktreeWait.size < WORKTREE_WAIT_CAPACITY) {
      worktreeWait.set(runId, { reapMs: budget.reapMs });
    }
    try {
      const spec: RunnerSpec = {
        runId,
        type: config,
        // Extensions (X1 worktree) key side effects off the run id; give them
        // a deterministic one instead of a label fallback.
        request: { ...req, runId },
        ...(req.cwd ? { cwd: req.cwd } : {}),
        ...(model ? { model } : {}),
        budget,
        depth,
      };
      const outcome = await deps.runner.run(spec, {
        ...(deps.onLifecycle ? { onLifecycle: deps.onLifecycle } : {}),
        onSnapshot: (s) => {
          records.set(runId, s);
          deps.onSnapshot?.(s);
        },
      });
      finish(outcome);
    } catch (error) {
      const failed: RunOutcome = {
        runId,
        status: "failed",
        turns: 0,
        durationMs: 0,
        diag: {
          createdAt: now(),
          phase: "settled",
          phaseEnteredAt: now(),
          pendingTools: 0,
          turns: 0,
          escalation: [],
          orphaned: false,
          generation: 1,
          degraded: [],
          staleInputs: 0,
          unkillable: [],
          ...(req.label !== undefined ? { label: req.label } : {}),
        },
        error: toErrorInfo(error),
      };
      finish(failed);
      // consult plan §6 B-6: only top-level runs notify from this catch — it
      // captures runner.run() itself throwing, a path that bypasses the
      // adapter's CC2 suppression, so a nested run would otherwise leak a
      // top-level notification its parent never asked for (the parent awaits
      // the outcome through spawnAndWait/waitOutcome). Session_create
      // failures never reach here (the runner's own catch folds them into
      // prompt_settled). T-8 locks this.
      if (req.parentRunId === undefined) deps.notifyTerminalFailure?.(failed);
    } finally {
      // Release every key acquired at spawn time (targetId AND sessionFile) —
      // deleting only req.resumeFrom leaks the targetId lock forever once
      // resumeFrom has been rewritten to the session file (P1: repeat-resume
      // of the same session was permanently rejected).
      for (const key of resumeLockKeys) resumeLocks.delete(key);
    }
  };
  /**
   * CC1: extracted, byte-for-byte, from abort()'s pre-existing children loop
   * (the recursion below re-enters `service.abort`, which is what actually
   * disambiguates already-finished/never-started children via `running.has`
   * — unchanged from before this extraction). Both `abort()` and the new
   * `stopChildrenOf()` call this and nothing else; there is exactly one
   * cascade implementation (OS1/OS3).
   */
  async function cascadeChildren(runId: RunId, cause: StopCause): Promise<RunId[]> {
    const children = [...(childrenOf.get(runId) ?? [])].filter((c) => running.has(c));
    if (children.length) await Promise.all(children.map((c) => service.abort(c, cause)));
    return children;
  }
  const service: SpawnService & { snapshots(): readonly RunSnapshot[] } = {
    async spawn(req) {
      // CC4/CP1 (workflow design §4.4.1 F2, CP1-a/b/c): must be the first
      // statement in spawn() — strictly before ANY mutable state write
      // (resumeLocks/labels/nesting/parentOf/childrenOf/running below). A
      // rejected resume request must never write a resumeLocks entry that
      // only `start()`'s `finally` would ever clean up (that path never runs
      // for a request rejected here), which would otherwise permanently lock
      // out the resume target (same failure class as the already-fixed
      // "leaks the targetId lock forever" bug in this file). Zero side
      // effects: no runId, no index writes, no H2, no worktree, no slot.
      if (req.deadlineAt !== undefined && req.deadlineAt <= now())
        return { error: { kind: "config", message: "deadlineAt already expired", retryable: false } };
      // L1 (agent-tool pool-full plan §1): reject-policy admission check —
      // zero side effects, runs before type/model/quota/nesting checks and
      // strictly before ANY mutable write, so a rejected call never creates a
      // run, a label, a nesting entry, or (much later, inside the runtime
      // adapter's H2 hook) a worktree. `slotfulLabel` — not `deps.pool.stats`
      // — is the atomicity anchor: multiple spawn() calls dispatched in the
      // same tick run their synchronous bodies back-to-back with no
      // interleaving (no `await` precedes this check), so each sees every
      // prior call's reservation even though the real SlotPool only commits
      // a slot much later (deep inside the runtime adapter, after H2).
      if (req.slotless !== true && req.poolFullPolicy === "reject") {
        const limit = deps.pool.stats?.limit ?? 0;
        if (limit > 0 && slotfulLabel.size >= limit) {
          const runningLabels = [...slotfulLabel.values()].slice(0, 10);
          return {
            error: {
              kind: "config",
              message:
                `agent pool is full: ${formatSlots(slotsInfo(limit, slotfulLabel.size))}` +
                (runningLabels.length ? ` (${runningLabels.join(", ")})` : "") +
                ". Wait for one to finish and dispatch again, or raise concurrencyLimit (/agent settings).",
              retryable: true,
            },
          };
        }
      }
      // consult (plan §16): the "no type" bypass for `consult("main", …)` —
      // never touches `deps.types` at all when it fires, so it has zero
      // effect on the registry, `list()`, or a real type of the same name
      // dispatched WITHOUT a forkSessionFrom (that still falls through to
      // the normal lookup below and is rejected as unknown, same as today).
      const config =
        req.type === CONSULT_MAIN_AGENT_TYPE && req.forkSessionFrom !== undefined
          ? MAIN_SNAPSHOT_TYPE_CONFIG
          : deps.types.get(req.type);
      if (!config) {
        // Self-correcting error: list the valid names so a model that missed
        // (or predates) the system-prompt type section recovers in one turn
        // instead of burning turns on trial-and-error guesses.
        const known = deps.types.list().map((t) => t.name);
        const hint = known.length ? `Valid types: ${known.join(", ")}` : "No agent types are registered.";
        return { error: { kind: "config", message: `unknown agent type: ${req.type}. ${hint}`, retryable: false } };
      }
      // Model-hint admission check (fuzzy frontmatter `model:` / Agent tool
      // `model` param). Strict provider/id pairs are existence-checked right
      // below (modelExists); only hints need resolving here, and an
      // unresolvable hint is rejected BEFORE any mutable state write (same
      // admission discipline as the resume/CC4 checks) instead of settling as
      // a failed run — and never
      // silently downgraded to the parent/default model.
      let admittedModel = req.modelOverride ?? config.model;
      if (!admittedModel) {
        const modelHint = req.modelHintOverride ?? config.modelHint;
        if (modelHint) {
          const resolved = deps.resolveModelHint?.(modelHint);
          if (!resolved) {
            const suffix = formatModelCandidates(deps.availableModels?.() ?? [], 8, deps.quotaAnnotate);
            return {
              error: {
                kind: "config",
                message:
                  `unknown model hint: "${modelHint}" — pass a strict provider/id, or a bare id/substring of an available model ` +
                  `(pi /model lists what's available).${suffix ? ` ${suffix}` : ""}`,
                retryable: false,
              },
            };
          }
          admittedModel = resolved;
        }
      }
      // Strict provider/id admission check (a renamed provider such as
      // `cloudrouter-anthropic/…` → `cr-anthropic/…`): fail fast with
      // suggestions instead of creating a run that can only die at session
      // create. Same zero-side-effect admission zone as the hint check above;
      // an unavailable registry (undefined) never blocks.
      if (admittedModel && deps.modelExists?.(admittedModel) === false) {
        const fromType = req.modelOverride === undefined && config.model !== undefined;
        return {
          error: {
            kind: "config",
            message: formatUnknownModelError(admittedModel, deps.availableModels?.() ?? [], {
              ...(fromType ? { source: `agent type "${config.name}" frontmatter model` } : {}),
              ...(deps.quotaAnnotate ? { annotate: deps.quotaAnnotate } : {}),
            }),
            retryable: false,
          },
        };
      }
      // 额度闸门（quota-plan §6）：admittedModel 定型之后、任何可变状态写入
      // （resumeLocks/labels/nesting/…）之前——与 CC4/unknown-type/model-hint
      // 同一「零副作用准入区」。只读同步缓存，绝不发网络请求；越线 ⇒ 快速
      // 失败并直接给替代模型，不烧一个注定 429 的 run。
      if (admittedModel && deps.quotaGate) {
        const gate = deps.quotaGate(admittedModel);
        if (gate) return { error: { kind: "config", message: gate.message, retryable: false } };
      }
      // X3: nesting depth + canSpawn whitelist. Authoritative for real
      // nested chains produced by the injected nested Agent tool, whose
      // parentRunId always names a currently-tracked, still-running entry
      // (the tool only exists inside an active session). `parentRunId` is
      // NOT a model-facing parameter of the top-level Agent tool, so an
      // untracked/foreign parentRunId cannot originate from tool-call input
      // — it is either a stale/finished reference or a caller using
      // `parentRunId` purely as a display label (pre-X3 usage, still
      // supported); neither case is a nested-delegation privilege
      // escalation, so it is left unrestricted (depth 0, no canSpawn cap)
      // rather than rejected. The check below only fires when the parent IS
      // currently tracked, i.e. it is a real, live nesting relationship.
      let depth = 0;
      if (req.parentRunId) {
        const parent = nesting.get(req.parentRunId);
        if (parent) {
          // consult (plan §4.4, review-1 #1): fork requests (a consulted
          // expert's copy) skip the canSpawn gate — the asking run's type
          // generally has no canSpawn for the *expert's* type, and requiring
          // it would reject every consult. Depth still counts and is still
          // capped: a consult run is a real nested run for depth purposes.
          if (!req.forkSessionFrom && !parent.canSpawn?.includes(req.type))
            return {
              error: {
                kind: "config",
                message: `nested delegation is not permitted: parent's agent type may only spawn [${(parent.canSpawn ?? []).join(", ")}], not "${req.type}"`,
                retryable: false,
              },
            };
          depth = parent.depth + 1;
          if (depth > maxNestedDepth)
            return {
              error: {
                kind: "config",
                message: `nested delegation depth ${depth} exceeds the configured maximum (${maxNestedDepth})`,
                retryable: false,
              },
            };
        }
      }
      let resolvedReq = req;
      let lockKeys: string[] = [];
      const runId = newRunId(
        (id) => records.has(id) || running.has(id) || tombstones.has(id) || deps.runIdTaken?.(id) === true,
      );
      // Label planning is deliberately read-only and completes before the
      // first mutable admission write (resume locks included).
      const requestedBase =
        sanitizeLabelBase(req.label ?? "") ?? sanitizeLabelBase(firstNonEmptyLine(req.prompt) ?? "");
      let base = requestedBase ?? "agent";
      if (isRunId(base)) {
        console.warn(`[pi-subagent] label "${base}" looks like a run id; using a fallback label instead`);
        base = "agent";
      }
      const resumeTarget = req.resumeFrom ? resolveRun(req.resumeFrom) : undefined;
      const prior = labels.get(base);
      const repoint =
        req.resumeFrom !== undefined &&
        prior !== undefined &&
        resumeTarget?.ok === true &&
        prior.runId === resumeTarget.runId;
      const effective = repoint ? base : deriveUniqueLabel(base, (label) => labels.has(label));
      if (effective === undefined)
        return {
          error: {
            kind: "config",
            message: `cannot derive a unique label from "${base}": all 999 numbered variants are taken — pass a different label/description`,
            retryable: false,
          },
        };
      const labelAction: "register" | "repoint" = repoint ? "repoint" : "register";

      // consult (plan §4.4): fork admission branch. Validated here — after
      // label planning, before the resume branch — and deliberately takes no
      // locks: a fork copy is private to this one run (concurrent consults of
      // the same expert each hold their own copy), so resumeLocks has nothing
      // to mutex. statSync (not existsSync+statSync) keeps the check a single
      // race-free syscall.
      if (req.forkSessionFrom) {
        // D19 (workflow-experts §4.7, N3): a fork (consult) request must be
        // rejected while its parent is stopping or already gone — not just
        // absent from `running` but also present in `stopping` (abort() has
        // been called but the run hasn't settled yet). This runs before any
        // mutable state write, same admission discipline as the rest of
        // spawn(). The tool-call `signal` remains a second line of defense.
        if (!req.parentRunId || !running.has(req.parentRunId) || stopping.has(req.parentRunId)) {
          return {
            error: {
              kind: "config",
              message: "parent run is stopping or gone",
              retryable: false,
            },
          };
        }
        if (req.resumeFrom)
          return {
            error: {
              kind: "config",
              message: "forkSessionFrom and resumeFrom are mutually exclusive",
              retryable: false,
            },
          };
        try {
          if (!statSync(req.forkSessionFrom).isFile())
            throw new Error(`fork session file missing: ${req.forkSessionFrom}`);
        } catch {
          return {
            error: {
              kind: "config",
              message: `fork session file missing: ${req.forkSessionFrom}`,
              retryable: false,
            },
          };
        }
      }

      if (req.resumeFrom) {
        // Resolve once for the running hint, then resolve the owned session
        // file. Both calls are synchronous and this whole admission section
        // runs before the first await, so lock checks and writes are atomic.
        const target = resumeTarget!;
        if (!target.ok) {
          const resume = resolveResume(req.resumeFrom);
          return {
            error: { kind: "config", message: resume.ok ? target.error : resume.error, retryable: false },
          };
        }
        const targetId = target.runId;
        if (running.has(targetId))
          return {
            error: {
              kind: "config",
              message: `run ${targetId} is still running; use steer_subagent instead`,
              retryable: false,
            },
          };
        const resume = resolveResume(req.resumeFrom);
        if (!resume.ok) return { error: { kind: "config", message: resume.error, retryable: false } };
        if (resumeLocks.has(targetId) || resumeLocks.has(resume.sessionFile))
          return {
            error: { kind: "config", message: `run ${targetId} already has a resume in progress`, retryable: false },
          };
        resumeLocks.add(targetId);
        resumeLocks.add(resume.sessionFile);
        resolvedReq = { ...req, resumeFrom: resume.sessionFile };
        lockKeys = [targetId, resume.sessionFile];
      }
      const budget = applyBudgetPolicy(mergeBudget(deps.budget, config.budgetOverride, req.budgetOverride), {
        // D-10：per-spawn 显式 totalMs ⇒ 硬顶（maxTotalFactor = 1，无宽限无延长）
        explicitTotal: req.budgetOverride?.totalMs !== undefined,
        extensionsEnabled: deps.extensionsEnabled ?? true,
      });
      const parent = req.parentRunId ?? "root";
      const target = { runId, type: req.type, parent };
      labels.set(effective, target);
      deps.onLabel?.(effective, target, { resumed: labelAction === "repoint" });
      resolvedReq = { ...resolvedReq, label: effective };
      // L1 (agent-tool pool-full plan §1/§2): reservation + queued-position
      // bookkeeping for every non-slotless request, computed BEFORE this run
      // is added to `slotfulLabel` (so `.size` below counts only runs AHEAD
      // of it). Reject-policy calls that reached this point already know the
      // pool wasn't full (the early check above rejected it otherwise);
      // queue-policy calls (the default for everyone except the top-level/
      // nested Agent tool — workflow children, consult forks, /task, resume)
      // can still be "queued" in this conceptual sense, which is exactly what
      // §2's "already queued: N/N running, position k" message is built from.
      let queued: { position: number; runningCount: number; limit: number; queueWaitMs: number } | undefined;
      const limit = deps.pool.stats?.limit ?? 0;
      if (req.slotless !== true) {
        if (limit > 0 && slotfulLabel.size >= limit) {
          queued = {
            position: slotfulLabel.size - limit + 1,
            runningCount: slotfulLabel.size,
            limit,
            queueWaitMs: budget.queueWaitMs,
          };
        }
        slotfulLabel.set(runId, effective);
      }
      // §5 (user follow-up): every SUCCESSFUL dispatch — slotless (nested
      // Agent, consult) included — reports the pool's current occupancy, so
      // the caller sees ambient concurrency even for a call that itself never
      // consumes a slot. Computed AFTER the reservation above, so a
      // non-slotless call's own slot is reflected in its own `inUse`.
      //
      // P1 fix (todo #16 review): `slotfulLabel.size` is the ATOMIC ADMISSION
      // count — every non-slotless request that won admission, whether or
      // not it has actually acquired a real SlotPool slot yet (queue-policy
      // requests admitted past the limit sit in `slotfulLabel` too, so a
      // same-tick burst can't over-admit). That is the right count for the
      // pool-full/queue DECISION above, but it is the wrong count to DISPLAY
      // as `inUse`: with queueWhenFull=true a still-queued request was
      // showing up as "in use" even though it holds no real slot, producing
      // impossible readouts like `slots: 2/1 in use, 0 free`. `slotsInfo`
      // now caps the displayed `inUse` at `limit` and reports the overflow
      // separately as `queued`, so the two numbers together always add up to
      // the true admitted count while `inUse` never exceeds `limit`.
      const slots: SlotsInfo = slotsInfo(limit, slotfulLabel.size, Math.max(0, slotfulLabel.size - limit));
      // consult (plan §4.4, review-2 #6): a fork run's nesting entry carries
      // NO canSpawn — a consulted expert must not delegate further. Together
      // with the adapter not injecting the nested Agent tool and pi's
      // read-only tools allowlist, this is one of three independent guards.
      nesting.set(runId, {
        depth,
        ...(config.canSpawn && !req.forkSessionFrom ? { canSpawn: config.canSpawn } : {}),
      });
      if (req.expectAck) claimedRunIds.add(runId);
      if (req.parentRunId) {
        parentOf.set(runId, req.parentRunId);
        const siblings = childrenOf.get(req.parentRunId) ?? new Set<RunId>();
        siblings.add(runId);
        childrenOf.set(req.parentRunId, siblings);
        deps.onSpawnEdge?.(req.parentRunId, runId);
      } else {
        // In the fabric tree, every top-level run is a child of the host root.
        deps.onSpawnEdge?.("root", runId);
      }
      void start(resolvedReq, runId, config, budget, lockKeys, depth, admittedModel);
      return { runId, label: effective, slots, ...(queued ? { queued } : {}) };
    },
    async spawnAndWait(req) {
      const started = await service.spawn({ ...req, expectAck: true });
      if ("error" in started) throw new Error(started.error.message);
      const result = await new Promise<RunOutcome>((resolve) => {
        const done = outcomes.get(started.runId);
        if (done) resolve(done);
        else {
          const set = waits.get(started.runId) ?? new Set();
          set.add(resolve);
          waits.set(started.runId, set);
        }
      });
      try {
        deps.onOutcomeAcked?.(result);
      } catch {
        // Best effort only; consumption must not alter the returned outcome.
      }
      return result;
    },
    // P1 fix (todo #16 review, agent-tool.ts nested blocking path): identical
    // to spawnAndWait, but ALSO hands back the dispatch-time `slots` snapshot
    // (and `queued`, if the call itself queued) that `spawn()` already
    // computed — deliberately not folded into RunOutcome (a core type that
    // outlives this one call site; slots are a dispatch-moment reading, not
    // a property of the finished run) and deliberately not re-derived after
    // the wait (the pool's occupancy at completion time is a different,
    // less useful number — the caller wants to know what the pool looked
    // like WHEN it dispatched). spawnAndWait itself is left untouched since
    // it is a stable, widely-used port (goal/hook.ts, index.ts forwarding,
    // etc.) whose return type (`Promise<RunOutcome>`) must not change.
    async spawnAndWaitWithSlots(req) {
      const started = await service.spawn({ ...req, expectAck: true });
      if ("error" in started) throw new Error(started.error.message);
      const result = await new Promise<RunOutcome>((resolve) => {
        const done = outcomes.get(started.runId);
        if (done) resolve(done);
        else {
          const set = waits.get(started.runId) ?? new Set();
          set.add(resolve);
          waits.set(started.runId, set);
        }
      });
      try {
        deps.onOutcomeAcked?.(result);
      } catch {
        // Best effort only; consumption must not alter the returned outcome.
      }
      return { outcome: result, slots: started.slots, ...(started.queued ? { queued: started.queued } : {}) };
    },
    async waitOutcome(runId, waitMs) {
      const ack = (outcome: RunOutcome) => {
        try {
          deps.onOutcomeAcked?.(outcome);
        } catch {
          // Best effort only; acknowledgement must not alter wait semantics.
        }
      };
      const done = outcomes.get(runId);
      if (done) {
        ack(done);
        return { kind: "settled", outcome: done };
      }
      return new Promise<BoundedWaitResult>((resolve) => {
        let settledFlag = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const set = waits.get(runId) ?? new Set<(outcome: RunOutcome) => void>();
        const waiter = (outcome: RunOutcome) => {
          if (settledFlag) return;
          cleanup();
          ack(outcome);
          resolve({ kind: "settled", outcome });
        };
        const cleanup = () => {
          if (settledFlag) return;
          settledFlag = true;
          if (timer !== undefined) clearTimeout(timer);
          set.delete(waiter);
          if (set.size === 0) waits.delete(runId);
        };
        set.add(waiter);
        waits.set(runId, set);
        if (waitMs !== undefined) {
          timer = setTimeout(() => {
            if (settledFlag) return;
            cleanup();
            const late = outcomes.get(runId);
            if (late) ack(late);
            resolve(late ? { kind: "settled", outcome: late } : { kind: "pending" });
          }, waitMs);
          (timer as { unref?: () => void }).unref?.();
        }
      });
    },
    expectsAck(runId) {
      return claimedRunIds.has(runId);
    },
    // X1: no running.has guard — by the time beforeReap reports, the run is
    // already terminal and finish() has replaced the live record with the
    // settled snapshot. Mutate exactly that record; the widget's 1Hz tick
    // re-reads QueryService, so no re-emit is needed (and re-firing
    // onSnapshot for a settled run would ping fabric/usage for nothing).
    markWorktreeDisposition(runId, disposition) {
      if (worktreeDisposed) return; // D13: dispose() makes this a no-op — late reports go through the durable sink instead
      const live = records.get(runId);
      if (live) {
        live.diag.worktree = {
          state: disposition.state,
          ...(disposition.branch === undefined ? {} : { branch: disposition.branch }),
          ...(disposition.path === undefined ? {} : { path: disposition.path }),
        };
      }
      pruneWorktreeWait();
      worktreeWait.delete(runId); // D5a: mark ⇒ delete
      const waiters = worktreeWaiters.get(runId);
      if (waiters) {
        for (const waiter of [...waiters]) settleWorktreeWaiter(runId, waiter, { kind: "settled", disposition });
      }
    },
    async waitWorktreeDisposition(runId, opts) {
      pruneWorktreeWait();
      if (worktreeDisposed) return { kind: "disposed" };
      const live = records.get(runId);
      const wt = live?.diag.worktree;
      if (!wt) {
        worktreeWait.delete(runId); // D5a: none ⇒ delete
        return { kind: "none" };
      }
      if (wt.state !== "active") {
        return {
          kind: "settled",
          disposition: {
            state: wt.state,
            ...(wt.branch === undefined ? {} : { branch: wt.branch }),
            ...(wt.path === undefined ? {} : { path: wt.path }),
          },
        };
      }
      const reapMs = effectiveReapMs(runId);
      const horizonMs = opts.horizon === "settle" ? worktreeSettleMs(reapMs) : worktreeLateMs(reapMs);
      const waitMs = Math.max(0, opts.capMs !== undefined ? Math.min(opts.capMs, horizonMs) : horizonMs);
      return new Promise<WorktreeWaitResult>((resolve) => {
        const waiter: WorktreeWaiter = { resolve };
        const set = worktreeWaiters.get(runId) ?? new Set<WorktreeWaiter>();
        set.add(waiter);
        worktreeWaiters.set(runId, set);
        waiter.timer = setTimeout(() => {
          // D5a: a "late" horizon timing out means nobody is ever going to ask
          // again — drop the reapMs entry; a "settle" timeout keeps it, since a
          // "late" waiter may still be registered afterward.
          if (opts.horizon === "late") worktreeWait.delete(runId);
          settleWorktreeWaiter(runId, waiter, { kind: "timeout" });
        }, waitMs);
        (waiter.timer as unknown as { unref?: () => void }).unref?.();
      });
    },
    dispose() {
      if (worktreeDisposed) return;
      worktreeDisposed = true;
      for (const [runId, set] of [...worktreeWaiters]) {
        for (const waiter of [...set]) settleWorktreeWaiter(runId, waiter, { kind: "disposed" });
      }
      worktreeWait.clear();
    },
    async abort(runId, cause = "user_stop") {
      if (!running.has(runId)) return false;
      // D19 (workflow-experts §4.7, N3): synchronous, before the first
      // `await` below (cascadeChildren) — a fork admission racing this same
      // tick must see `runId` as stopping. `stopping` is an idempotent set
      // (repeated abort() calls on the same runId, or the production path
      // stopChildrenOf → abort, just re-add the same member); cleared once
      // in finish(), also idempotent.
      stopping.add(runId);
      // X3: cascade to nested children before/alongside aborting this run
      // itself. Recurses through `service.abort` so grandchildren are
      // reached too; idempotent against the double-hop that also arrives via
      // RunnerDeps.onChildAbort (runtime/runner.ts → index.ts wiring) once
      // this run's own cancellation actually fires — `running.has()` /
      // createCancelHandle's already-aborted guard make the second pass a
      // no-op rather than an infinite loop.
      await cascadeChildren(runId, "parent_abort");
      if (deps.runner.abort) return (await deps.runner.abort(runId, cause)).ok;
      return false;
    },
    async stopChildrenOf(parentId, cause = "parent_abort") {
      // CC1 (OS1/OS2): the only owner-stop entry point that works when
      // `parentId` itself is not (and never will be) a tracked run — unlike
      // abort(), this never calls `running.has(parentId)` and never calls
      // `deps.runner.abort` on `parentId`. Reuses the identical cascade
      // abort() uses; the only difference is the guard swapped from
      // `running.has` to "does this id have any children at all".
      const stopped = await cascadeChildren(parentId, cause);
      // OS4: snapshot taken AFTER the cascade attempt, for the caller's own
      // sweep pass — children that hadn't actually finished yet (still
      // tracked in childrenOf; cascadeChildren's fire of `service.abort` does
      // not itself remove them, only their eventual `finish()` does).
      const pending = [...(childrenOf.get(parentId) ?? [])];
      return { stopped, pending };
    },
    async waitAll(opts = {}) {
      const ids = opts.runIds ?? [...running];
      const settled: RunOutcome[] = [];
      const pending: RunId[] = [];
      await Promise.all(
        ids.map(async (id) => {
          const result = await new Promise<RunOutcome | undefined>((resolve) => {
            const done = outcomes.get(id);
            if (done) return resolve(done);
            const set = waits.get(id) ?? new Set();
            set.add(resolve as (o: RunOutcome) => void);
            waits.set(id, set);
            if (opts.waitMs !== undefined) setTimeout(() => resolve(undefined), opts.waitMs);
          });
          if (result) settled.push(result);
          else pending.push(id);
        }),
      );
      return { settled, pending };
    },
    getLabel: (label) => labels.get(label),
    resolveRun,
    resolveResume,
    setConcurrencyLimit(n) {
      deps.pool.setLimit?.(n);
    },
    slots() {
      const limit = deps.pool.stats?.limit ?? 0;
      return slotsInfo(limit, slotfulLabel.size, Math.max(0, slotfulLabel.size - limit));
    },
    snapshots: () => [...records.values()],
  };
  return service;
}
