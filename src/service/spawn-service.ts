import { statSync } from "node:fs";
import { applyBudgetPolicy } from "../core/deadline.js";
import { mergeBudget } from "../config/settings.js";
import { newRunId, isRunId } from "../core/ids.js";
import { isLiveSessionFile } from "../core/live-session-files.js";
import { deriveUniqueLabel, firstNonEmptyLine, sanitizeLabelBase, captureDisplayTitle } from "../core/labels.js";
import { toErrorInfo } from "../core/errors.js";
import type { WakeExclusion } from "../core/message.js";
import { persistableWakeOrigin } from "../core/run-journal.js";
import { formatSlots, slotsInfo, type SlotsInfo } from "../core/format.js";
import type { AgentTypeRegistry } from "../config/agent-types.js";
import { formatModelCandidates, formatUnknownModelError, type ModelCandidate } from "../config/model-hint.js";
import type { QuotaGateVerdict } from "../quota/gate.js";
import { CONSULT_MAIN_AGENT_TYPE, displayAgentType } from "../core/types.js";
import { createInitialState, TASK_PROMPT_CAP } from "../core/state-machine.js";
import type {
  AgentTypeConfig,
  DeadlineBudget,
  ErrorInfo,
  RunDiagnostics,
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
import type { ExternalAgentsPort } from "../external-agent/types.js";
import { isExternalSessionPath } from "../external-agent/paths.js";
import type { InboxPort } from "../fabric/wake.js";
import {
  MSG_EXPERTS_UNSUPPORTED,
  MSG_READONLY_DOMAIN,
  MSG_RESUME_ISOLATION,
  msgResumeCrossRuntime,
  msgResumeDisabled,
} from "../external-agent/messages.js";

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
   * fabric-cross-session plan v3 §3.4a: the run that currently owns a resume of `sessionFile` (admitted by ANY resume
   * entry — Agent, @mention, revive, RPC, /task — and not yet terminal), or `undefined`. Pure registry read: no I/O, no
   * side effect. Accepts the persisted session-file path only (what `diag.sessionFile` / `resolveResume` yield).
   */
  successorOf(sessionFile: string): RunId | undefined;
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
  /**
   * admitted-run-visibility fix (2026-10-08 incident): every run id between
   * the instant spawn() admits it and its terminal settlement — the
   * ADMISSION-TIME truth, independent of whether a runner-produced snapshot
   * has landed in the registry yet (a resume opens the old session file
   * before the runtime adapter ever enters RuntimeRunner.run(), which can
   * take a while — see spawn-service.ts's `running` set doc). Busy-counting
   * call sites (deferred /reload's re-count, activeSubagentRunCount, the
   * background-status provider shared with feishu-notify)
   * must union this with their own registry-derived count so a run admitted
   * after the last registry snapshot can never make them under-count.
   */
  runningIds(): readonly RunId[];
}
export interface SpawnServiceDeps {
  types: AgentTypeRegistry;
  pool: SlotPool;
  runner: Runner;
  now?: () => number;
  budget?: Partial<DeadlineBudget>;
  onSnapshot?: (snapshot: RunSnapshot) => void;
  /**
   * fabric-cross-session plan §3.3 L4 (W1): causal-level reader, present only when `fabric.enabled ∧ fabric.wake.enabled`
   * (absent ⇒ no run ever gets `wakeLevel`, byte-identical to before). `levelOfRun` is a run's current effective level
   * (live runner state, `?? 0`), `root` the main session's level.
   */
  causal?: { levelOfRun(runId: RunId): number; root(): number };
  /** Trusted W3 reservation hook; wired ONLY with fabric wake on. No file I/O. */
  inbox?: InboxPort;
  /** Narrow admission hook for the fabric tree; called after a child edge is recorded. */
  onSpawnEdge?: (parentRunId: RunId, childRunId: RunId) => void;
  onLifecycle?: LifecycleSink;
  onOutcomeAcked?: (outcome: RunOutcome) => void;
  notifyTerminalFailure?: (outcome: RunOutcome, opts?: { quiet?: true }) => void;
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
   * external-agent plan §5.1 (P4b): the droid provider admission gate. Absent
   * ⇒ byte-identical pre-feature behavior — a `droid/x` model falls through to
   * the `modelExists` check below and is rejected as an unknown pi model.
   * Present (P5, only when externalAgents.droid.enabled) ⇒ the zero-side-effect
   * admission zone below claims `droid/*` models and enforces the readonly /
   * availability / experts / fork / resume cross-runtime rules.
   */
  external?: ExternalAgentsPort;
  /**
   * external-agent plan §5.1 (P4b): the pi agent dir (`getAgentDir()`), used
   * for the structural external-session detection (`isExternalSessionPath`)
   * that stays live even when `external` is absent (the ⑤ always-on resume
   * guard). Injected by P5 alongside `external`.
   */
  agentDir?: string;
  /**
   * 额度闸门（quota-plan §6）：**同步**、只读缓存、返回 undefined 放行。
   * 未注入时行为与今天完全一致（全特性可一键回退，plan R11）。
   */
  quotaGate?: (model: { provider: string; id: string }) => QuotaGateVerdict | undefined;
  /** sysload §6.2: synchronous, side-effect-free evaluator used only by Agent-tool requests carrying loadPolicy. */
  loadGate?: (ctx: { nested: boolean }) => { message: string } | undefined;
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
  /**
   * 终态 run 的**持久**视图（resolve-target.ts 的 "records are the durable,
   * long-lived view" 设计本意）：stack 注入持久 store 的 list——重启后经
   * pi-run-log 的种子恢复，resume/get_result 才能找到本进程生命周期之前的
   * 终态 run（2026-10-04 事故：此前 records 与 liveSnapshots 都接进程内
   * Map，重启即空）。未注入时回退进程内 records（既有行为）。
   */
  durableRecords?: () => readonly RunSnapshot[];
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
  // fabric-cross-session plan v3 §3.4a (S0): the resume mutex is now an OWNER registry — resume key (target run id AND
  // session file) → the run that holds it. Mutual exclusion is unchanged (a held key rejects `resume_locked`, released
  // at the same points as before: terminal / `start()` failure); the owner id is what `successorOf` exposes so
  // mailbox/WakeService (W3/W4) can tell "target finished but a successor run is already on its session".
  const resumeOwners = new Map<string, RunId>();
  // Fix 3 (admitted-run-visibility plan): a per-run AbortController wired into
  // start()'s RunnerSpec.signal (merged with any caller-supplied req.signal via
  // AbortSignal.any) solely so abort() has a cooperative-cancel lever that still
  // works BEFORE the runtime adapter has entered RuntimeRunner.run() for this run
  // (deps.runner.abort finds nothing in its own activeCancels map yet and reports
  // ok:false — the exact admitted-but-unobserved window a resume's H2/session-open
  // can stretch out). AbortSignal.aborted is sticky, so calling .abort() here is
  // still observed the instant createCancelHandle finally runs its synchronous
  // "already aborted" check — one entry per currently-admitted run, deleted in
  // finish() (same lifecycle as `running`/`slotfulLabel`, never leaks).
  const admissionAbort = new Map<RunId, AbortController>();
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
    records: deps.durableRecords ?? (() => [...records.values()]),
    tombstones,
    now,
  });
  const resolveRun = (handle: string) => resolveRunId(handle, targetDeps());
  const resolveResume = (handle: string) => resolveResumeTarget(handle, targetDeps());
  // external-agent plan §5.1 (P4b): resume-target model lookup, for inheriting
  // a droid run's model when a resume omits a model override. Live records
  // first, then the durable store — the same precedence resolve-target uses.
  const modelOfRun = (runId: RunId): { provider: string; id: string } | undefined => {
    const live = records.get(runId);
    if (live?.diag.model !== undefined) return live.diag.model;
    for (const snap of deps.durableRecords?.() ?? []) {
      if (snap.runId === runId && snap.diag.model !== undefined) return snap.diag.model;
    }
    // external-agent §15 跟踪项 2（P5）：live/durable 都已不在（tombstone-only）时的
    // 最后来源——外部会话 resume 无 override 时继承 droid 模型不再落空。
    return tombstones.get(runId)?.model;
  };
  const terminal = (s: string) => ["completed", "failed", "timed_out", "aborted"].includes(s);
  const finish = (outcome: RunOutcome) => {
    outcomes.set(outcome.runId, outcome);
    running.delete(outcome.runId);
    stopping.delete(outcome.runId);
    claimedRunIds.delete(outcome.runId);
    admissionAbort.delete(outcome.runId); // Fix 3: release the admission-time cancel lever once settled
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
  /**
   * Fix 2 (admitted-run-visibility plan): a run becomes visible to
   * list_subagents / get_subagent_result / @label resolution the INSTANT
   * spawn() admits it, not only once the runtime adapter's first real
   * onSnapshot lands — for a resume that can be seconds away (the adapter
   * opens the old session file before even entering RuntimeRunner.run()).
   * Mirrors core/state-machine.ts's own createInitialState() shape
   * (queued/queue_wait) plus the same write-once display metadata
   * (label/model/agentType/taskPrompt) runtime-adapter.ts folds into
   * diag at enqueue time, so the provisional row looks like the real thing
   * until the real onSnapshot (same records.set(runId, …) call site, see
   * below) overwrites it. Deliberately does NOT go through deps.onSnapshot —
   * that closure (stack.ts) pokes the usage broadcaster / fabric tree /
   * consult cap-watcher, side effects meant for a run the host has actually
   * observed progress from, not a placeholder that is about to be replaced.
   */
  const buildProvisionalSnapshot = (
    runId: RunId,
    req: SpawnRequest,
    model: { provider: string; id: string } | undefined,
  ): RunSnapshot => {
    const at = now();
    const initial = createInitialState(runId, 1, at, req.parentRunId);
    const diag: RunDiagnostics = {
      ...initial.diag,
      ...(model ? { model } : {}),
      ...(req.label !== undefined ? { label: req.label } : {}),
      ...(req.title !== undefined ? { title: req.title } : {}),
      agentType: displayAgentType(req.type),
      taskPrompt: req.prompt.slice(0, TASK_PROMPT_CAP),
      // consult A/B instrumentation plan (§5 P1b): mirror the two write-once
      // display fields the runtime adapter will fold into diag at enqueue
      // time (identical values — pure req passthrough) so the provisional row
      // stays consistent with the real snapshot that replaces it.
      // `experts` is deliberately NOT mirrored: `granted` is only knowable
      // after the adapter's injection decision (deps.consult present and
      // returned a tool), and a guessed value here would put a wrong
      // "granted" into a diag analysis treats as authoritative. The
      // provisional snapshot is never journaled/persisted, so nothing that
      // reads persisted entries ever sees this gap.
      ...(req.dispatchMeta === undefined ? {} : { dispatchMeta: req.dispatchMeta }),
      ...(req.schemaPreset === undefined ? {} : { schemaPreset: req.schemaPreset }),
    };
    return {
      runId: initial.runId,
      generation: initial.generation,
      status: initial.status,
      phase: initial.phase,
      deadlines: initial.deadlines,
      diag,
      updatedAt: at,
      ...(initial.parentRunId === undefined ? {} : { parentRunId: initial.parentRunId }),
    };
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
    // Fix 2: write the provisional snapshot synchronously, before anything
    // else in this function yields to the event loop (same "runs to
    // completion before start()'s caller's `void start(...)` statement
    // returns" discipline `running.add` above already relies on).
    records.set(runId, buildProvisionalSnapshot(runId, req, model));
    // Fix 3: admission-time cancel lever — see admissionAbort's own doc above.
    const admissionController = new AbortController();
    admissionAbort.set(runId, admissionController);
    const signal =
      req.signal === undefined
        ? admissionController.signal
        : typeof AbortSignal.any === "function"
          ? AbortSignal.any([req.signal, admissionController.signal])
          : req.signal; // pre-ES2024 runtime fallback: admission-time cancel degrades to a no-op, caller's own signal still works
    // D5a: capture the run's ACTUAL effective reapMs (this mergeBudget result,
    // not a constant) the moment it's known, so a later wait can use it even
    // if agent-type-level budgetOverride raised/lowered it. Capacity-bounded
    // only against new writes — an already-running run is never evicted.
    if (req.isolation === "worktree" && worktreeWait.size < WORKTREE_WAIT_CAPACITY) {
      worktreeWait.set(runId, { reapMs: budget.reapMs });
    }
    let observedSnapshot = false;
    try {
      const spec: RunnerSpec = {
        runId,
        type: config,
        // Extensions (X1 worktree) key side effects off the run id; give them
        // a deterministic one instead of a label fallback.
        request: { ...req, runId, signal },
        ...(req.cwd ? { cwd: req.cwd } : {}),
        ...(model ? { model } : {}),
        budget,
        depth,
      };
      const outcome = await deps.runner.run(spec, {
        ...(deps.onLifecycle ? { onLifecycle: deps.onLifecycle } : {}),
        onSnapshot: (s) => {
          observedSnapshot = true;
          records.set(runId, s);
          deps.onSnapshot?.(s);
        },
      });
      finish(outcome);
    } catch (error) {
      if (!observedSnapshot) deps.inbox?.onRunGone(runId);
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
          // Preserve any dispatch/acceptance evidence if a runner throws after publishing snapshots.
          ...(deps.inbox && observedSnapshot ? records.get(runId)?.diag : {}),
          ...(req.label !== undefined ? { label: req.label } : {}),
          ...(req.title !== undefined ? { title: req.title } : {}),
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
      if (req.parentRunId === undefined && !req.suppressDelivery)
        deps.notifyTerminalFailure?.(failed, req.wakeOrigin === undefined ? undefined : { quiet: true });
    } finally {
      // Release every key acquired at spawn time (targetId AND sessionFile) —
      // deleting only req.resumeFrom leaks the targetId lock forever once
      // resumeFrom has been rewritten to the session file (P1: repeat-resume
      // of the same session was permanently rejected).
      for (const key of resumeLockKeys) if (resumeOwners.get(key) === runId) resumeOwners.delete(key);
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
      // (resumeOwners/labels/nesting/parentOf/childrenOf/running below). A
      // rejected resume request must never write a resumeOwners entry that
      // only `start()`'s `finally` would ever clean up (that path never runs
      // for a request rejected here), which would otherwise permanently lock
      // out the resume target (same failure class as the already-fixed
      // "leaks the targetId lock forever" bug in this file). Zero side
      // effects: no runId, no index writes, no H2, no worktree, no slot.
      if (req.deadlineAt !== undefined && req.deadlineAt <= now())
        return { error: { kind: "config", message: "deadlineAt already expired", retryable: false, reason: "config" } };
      // P0-r (todo #22 optimize-plan §7.0 point 4): toolDomain:"readonly" never
      // combines with isolation / forkSessionFrom / resumeFrom — tidy never
      // needs any of them, and combining them would be a latent misuse
      // waiting to happen (e.g. a readonly consult-like run also asking for a
      // worktree). Zero side effects, same admission discipline as the CC4
      // check right above.
      if (
        req.toolDomain === "readonly" &&
        (req.isolation !== undefined || req.forkSessionFrom !== undefined || req.resumeFrom !== undefined)
      ) {
        return {
          error: {
            kind: "config",
            message: 'toolDomain:"readonly" cannot be combined with isolation, forkSessionFrom, or resumeFrom',
            retryable: false,
            reason: "config",
          },
        };
      }
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
              reason: "pool_full",
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
        return {
          error: {
            kind: "config",
            message: `unknown agent type: ${req.type}. ${hint}`,
            retryable: false,
            reason: "unknown_type",
          },
        };
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
                reason: "config",
              },
            };
          }
          admittedModel = resolved;
        }
      }
      // ── external-agent plan §5.1 (P4b) admission ──
      // Zero-side-effect zone, after hint resolution and before `modelExists`.
      // ① resume-target pre-resolution (pure read): decide whether the resume
      // target is an external-agent session, from structural evidence (path
      // under `<agentDir>/external-agent/`) or the port's own owner lookup.
      // ⑤ the always-on guard rejects an external session file when the port
      // is absent (structural evidence only, never the enabled flag).
      let resumeTargetRunId: RunId | undefined;
      let resumeTargetExternal = false;
      if (req.resumeFrom !== undefined && (deps.external !== undefined || deps.agentDir !== undefined)) {
        const resume = resolveResume(req.resumeFrom);
        if (resume.ok) {
          const file = resume.sessionFile;
          resumeTargetExternal =
            (deps.agentDir !== undefined && isExternalSessionPath(file, deps.agentDir)) ||
            deps.external?.ownerOfSessionFile(file) !== undefined;
          resumeTargetRunId = resume.runId;
          if (resumeTargetExternal) {
            if (deps.external === undefined) {
              return {
                error: { kind: "config", message: msgResumeDisabled(resume.runId), retryable: false, reason: "config" },
              };
            }
            // ② resume target is external: inherit the target's droid model
            // when no override is given (resume never changes runtime); a pi
            // model override is a cross-runtime resume and is rejected.
            if (req.modelOverride === undefined) {
              const targetModel = modelOfRun(resume.runId);
              if (targetModel !== undefined) admittedModel = targetModel;
            } else if (deps.external.owns(req.modelOverride.provider) !== true) {
              return {
                error: {
                  kind: "config",
                  message: msgResumeCrossRuntime(resume.runId, "droid"),
                  retryable: false,
                  reason: "config",
                },
              };
            }
          }
        }
      }
      const admittedExternal = admittedModel !== undefined && deps.external?.owns(admittedModel.provider) === true;
      // ③ admitted model is claimed by an external provider: enforce the
      // readonly / availability / model / experts / fork / resume rules, all
      // with zero side effects. Passing skips the pi registry existence check
      // below; quota/load gates keep running as usual (no droid adapter ⇒ the
      // quota gate fails open).
      if (admittedExternal && deps.external !== undefined && admittedModel !== undefined) {
        if (req.toolDomain === "readonly") {
          return { error: { kind: "config", message: MSG_READONLY_DOMAIN, retryable: false, reason: "config" } };
        }
        const unavailable = deps.external.unavailableReason(admittedModel.provider);
        if (unavailable !== undefined) {
          return { error: { kind: "config", message: unavailable, retryable: false, reason: "external_unavailable" } };
        }
        // 2026-10-16 用户拍板：非空 externalAgents.droid.models 是新 spawn 的白名单——
        // droid 模型 id 不在名单内 ⇒ 拒绝（与 unknown-model 同一零副作用准入位；名单判定
        // 不依赖目录，目录不可用也照样执行）。resume 无 override 继承目标 run 的模型不受
        // 限（老 run 不因名单收紧而无法续跑）；显式 modelOverride 仍按新选择对待。工作流
        // agent() 子调用与嵌套 Agent 走同一准入，同样受限。
        if (!(resumeTargetExternal && req.modelOverride === undefined)) {
          const rejection = deps.external.modelAllowlistRejection?.(admittedModel);
          if (rejection !== undefined) {
            return { error: { kind: "config", message: rejection, retryable: false, reason: "config" } };
          }
        }
        if (deps.external.exists(admittedModel) === false) {
          return {
            error: {
              kind: "config",
              message: deps.external.unknownModelMessage(admittedModel),
              retryable: false,
              reason: "config",
            },
          };
        }
        if (req.consultExperts !== undefined && req.consultExperts.length > 0) {
          return { error: { kind: "config", message: MSG_EXPERTS_UNSUPPORTED, retryable: false, reason: "config" } };
        }
        if (req.forkSessionFrom !== undefined) {
          return { error: { kind: "config", message: MSG_EXPERTS_UNSUPPORTED, retryable: false, reason: "config" } };
        }
        if (resumeTargetRunId !== undefined && !resumeTargetExternal) {
          return {
            error: {
              kind: "config",
              message: msgResumeCrossRuntime(resumeTargetRunId, "pi"),
              retryable: false,
              reason: "config",
            },
          };
        }
        if (resumeTargetExternal && req.isolation !== undefined) {
          return { error: { kind: "config", message: MSG_RESUME_ISOLATION, retryable: false, reason: "config" } };
        }
      }
      // Strict provider/id admission check (a renamed provider such as
      // `cloudrouter-anthropic/…` → `cr-anthropic/…`): fail fast with
      // suggestions instead of creating a run that can only die at session
      // create. Same zero-side-effect admission zone as the hint check above;
      // an unavailable registry (undefined) never blocks. External-agent
      // models (claimed by `deps.external`) skip this — the provider's own
      // `exists`/`unknownModelMessage` checks above are the authoritative
      // admission gate for them (plan §5.1 ③).
      if (admittedModel && !admittedExternal && deps.modelExists?.(admittedModel) === false) {
        const fromType = req.modelOverride === undefined && config.model !== undefined;
        return {
          error: {
            kind: "config",
            message: formatUnknownModelError(admittedModel, deps.availableModels?.() ?? [], {
              ...(fromType ? { source: `agent type "${config.name}" frontmatter model` } : {}),
              ...(deps.quotaAnnotate ? { annotate: deps.quotaAnnotate } : {}),
            }),
            retryable: false,
            reason: "config",
          },
        };
      }
      // 额度闸门（quota-plan §6）：admittedModel 定型之后、任何可变状态写入
      // （resumeOwners/labels/nesting/…）之前——与 CC4/unknown-type/model-hint
      // 同一「零副作用准入区」。只读同步缓存，绝不发网络请求；越线 ⇒ 快速
      // 失败并直接给替代模型，不烧一个注定 429 的 run。
      if (admittedModel && deps.quotaGate) {
        const gate = deps.quotaGate(admittedModel);
        if (gate) return { error: { kind: "config", message: gate.message, retryable: false, reason: "quota" } };
      }
      // sysload §6.2: Agent (top-level and nested) is the only producer that
      // carries loadPolicy. Keep this in the zero-side-effect admission zone,
      // after quota and before nesting/run/label/worktree state is touched.
      if (req.loadPolicy === "reject" && deps.loadGate) {
        const gate = deps.loadGate({ nested: req.parentRunId !== undefined && nesting.has(req.parentRunId) });
        if (gate !== undefined)
          return { error: { kind: "config", message: gate.message, retryable: true, reason: "load" } };
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
                reason: "config",
              },
            };
          depth = parent.depth + 1;
          if (depth > maxNestedDepth)
            return {
              error: {
                kind: "config",
                message: `nested delegation depth ${depth} exceeds the configured maximum (${maxNestedDepth})`,
                retryable: false,
                reason: "config",
              },
            };
        }
      }
      let resolvedReq = req;
      let lockKeys: string[] = [];
      // §2.2 解析式第 ② 项（R-inherit）：resume 目标已持久化的策略；旧条目缺字段
      // 保持 undefined（落第 ③ 项按请求形状推导）。非 resume 请求恒 undefined。
      let resumeTimeoutPolicy: SpawnRequest["timeoutPolicy"] = undefined;
      // consult A/B instrumentation plan (§5 P1b, D3 recommendation):
      // `dispatchMeta = req.dispatchMeta ?? resume.dispatchMeta` — a rework
      // resume naturally belongs to the same package, so inheriting keeps
      // the enrollment without the main session re-stating it every time.
      // Source is the terminal snapshot's diag ONLY (resolve-target does not
      // read tombstones for this field). `schemaPreset`/`experts` are NOT
      // inherited — they are per-dispatch fields.
      let resumeDispatchMeta: SpawnRequest["dispatchMeta"] = undefined;
      let resumePrevWakeLevel: number | undefined = undefined;
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
            reason: "config",
          },
        };
      const labelAction: "register" | "repoint" = repoint ? "repoint" : "register";

      // consult (plan §4.4): fork admission branch. Validated here — after
      // label planning, before the resume branch — and deliberately takes no
      // locks: a fork copy is private to this one run (concurrent consults of
      // the same expert each hold their own copy), so resumeOwners has nothing
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
              reason: "config",
            },
          };
        }
        if (req.resumeFrom)
          return {
            error: {
              kind: "config",
              message: "forkSessionFrom and resumeFrom are mutually exclusive",
              retryable: false,
              reason: "config",
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
              reason: "config",
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
            error: {
              kind: "config",
              message: resume.ok ? target.error : resume.error,
              retryable: false,
              reason: "config",
            },
          };
        }
        const targetId = target.runId;
        if (running.has(targetId))
          return {
            error: {
              kind: "config",
              message: `run ${targetId} is still running; use steer_subagent instead`,
              retryable: false,
              reason: "target_running",
            },
          };
        const resume = resolveResume(req.resumeFrom);
        if (!resume.ok) return { error: { kind: "config", message: resume.error, retryable: false, reason: "config" } };
        // run-persistence plan D8: a same-process stack rebuild (/reload whose
        // shutdown drain timed out) can leave the previous stack's run still
        // closing — and writing — this very session file. Refuse (never wait)
        // until that run is physically reaped.
        if (isLiveSessionFile(resume.sessionFile))
          return {
            error: {
              kind: "config",
              message: `run ${targetId}'s session is still being closed by the previous session stack; retry in a few seconds`,
              retryable: false,
              reason: "session_closing",
            },
          };
        if (resumeOwners.has(targetId) || resumeOwners.has(resume.sessionFile))
          return {
            error: {
              kind: "config",
              message: `run ${targetId} already has a resume in progress`,
              retryable: false,
              reason: "resume_locked",
            },
          };
        resumeOwners.set(targetId, runId);
        resumeOwners.set(resume.sessionFile, runId);
        resumeTimeoutPolicy = resume.timeoutPolicy;
        resumeDispatchMeta = resume.dispatchMeta;
        resumePrevWakeLevel = resume.wakeLevel;
        resolvedReq = {
          ...req,
          resumeFrom: resume.sessionFile,
          ...(req.dispatchMeta === undefined && resumeDispatchMeta !== undefined
            ? { dispatchMeta: resumeDispatchMeta }
            : {}),
          // R-inherit for the display-only title: a resume that re-states no
          // description keeps showing the original one (same terminal-snapshot
          // source rule as dispatchMeta).
          ...(req.title === undefined && resume.title !== undefined ? { title: resume.title } : {}),
        };
        lockKeys = [targetId, resume.sessionFile];
      }
      // §2.2 解析式：新请求显式策略 > resume 继承（R-inherit）> 按请求形状推导
      // （仅看请求，不从 run 快照做形状推断）。结果恒为确定值，写回 resolvedReq，
      // 经 enqueued 输入镜像进 diag.timeoutPolicy，随所有持久化面走。
      const resolvedPolicy: NonNullable<SpawnRequest["timeoutPolicy"]> =
        req.timeoutPolicy ??
        resumeTimeoutPolicy ??
        (req.budgetOverride?.totalMs !== undefined ? "fixed" : "extendable");
      const budget = applyBudgetPolicy(mergeBudget(deps.budget, config.budgetOverride, req.budgetOverride), {
        // "fixed" ⇒ maxTotalFactor 钳 1（H = deadlineAt，无宽限无延长）；"extendable"
        // 保留合并后的 factor（默认 2），Agent 工具的显式 timeout_s 与默认预算同权
        fixedDeadline: resolvedPolicy === "fixed",
        extensionsEnabled: deps.extensionsEnabled ?? true,
      });
      // W3: never trust a caller's trackInput. Only a successfully bound reservation may enable W2.
      if (resolvedReq.trackInput !== undefined) {
        const { trackInput: _untrusted, ...rest } = resolvedReq;
        resolvedReq = rest;
      }
      if (deps.inbox && lockKeys.length > 0 && resolvedReq.resumeFrom) {
        const trigger = req.wakeOrigin?.trigger;
        const inbox = deps.inbox.onResumeAdmitted({
          runId,
          sessionFile: resolvedReq.resumeFrom,
          ...(trigger ? { trigger: { ...trigger, sender: req.wakeOrigin!.by } } : {}),
        });
        if (inbox.persistFailed) {
          for (const key of lockKeys) if (resumeOwners.get(key) === runId) resumeOwners.delete(key);
          return {
            error: {
              kind: "config",
              message: "fabric inbox reservation could not be persisted",
              retryable: true,
              reason: "inbox_persist_failed",
            },
          };
        }
        if (inbox.trackInput && inbox.block)
          resolvedReq = {
            ...resolvedReq,
            prompt: `${req.prompt}\n\n${inbox.block}`,
            trackInput: true,
          };
      }
      const parent = req.parentRunId ?? "root";
      const target = { runId, type: req.type, parent };
      labels.set(effective, target);
      deps.onLabel?.(effective, target, { resumed: labelAction === "repoint" });
      // Display-only title (the Agent tool's raw description, already captured
      // by captureDisplayTitle): kept only when it differs from the effective
      // label, so a label-shaped description adds no bytes to any diag/persist
      // surface. The web fleet tree renders it as the row's main title with
      // the label as secondary text.
      // Re-normalized here (idempotent) so every spawn source — not just the Agent tool — is
      // clamped to MAX_DISPLAY_TITLE_LENGTH before the value reaches any persisted diag.
      const clampedTitle = resolvedReq.title === undefined ? undefined : captureDisplayTitle(resolvedReq.title);
      const effectiveTitle = clampedTitle !== undefined && clampedTitle !== effective ? clampedTitle : undefined;
      // Strip any raw title first: a title equal to the effective label (or a
      // resume-inherited one now re-stated by the request) must not leak through.
      const { title: _droppedTitle, ...reqWithoutTitle } = resolvedReq;
      resolvedReq = {
        ...reqWithoutTitle,
        label: effective,
        ...(effectiveTitle === undefined ? {} : { title: effectiveTitle }),
      };
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
      resolvedReq = { ...resolvedReq, timeoutPolicy: resolvedPolicy };
      // fabric-cross-session plan §3.3 L4 (W1): initial effective causal level, written BEFORE `void start` below.
      //  · a wake revive (`wakeOrigin`) or a legacy @mention resume (`wakeHopLevel`) is itself a hop by a node at level
      //    h ⇒ max(h+1, prevFinal), where prevFinal = the resumed run's final level (it carries its past influence);
      //  · every other spawn (Agent tool incl. `Agent({resume})`, RPC, /task, workflow) is a new human epoch ⇒ the
      //    SPAWNER's level (parent run if nested, else root) and never prevFinal — so a root just reset by human input
      //    spawns at 0. A caller-supplied `wakeLevel` is never trusted: wake off ⇒ the field is stripped.
      if (deps.causal) {
        const hop = req.wakeOrigin?.level ?? req.wakeHopLevel;
        const level =
          hop !== undefined
            ? Math.max(hop + 1, resumePrevWakeLevel ?? 0)
            : req.parentRunId
              ? deps.causal.levelOfRun(req.parentRunId)
              : deps.causal.root();
        resolvedReq = { ...resolvedReq, wakeLevel: level };
      } else if (resolvedReq.wakeLevel !== undefined) {
        const { wakeLevel: _untrusted, ...rest } = resolvedReq;
        resolvedReq = rest;
      }
      // fabric-cross-session plan §4.5 (W5): the wake-ability verdict is decided HERE, once, from this request's own shape
      // (never trusted from a caller; absent with wake off ⇒ no new diag bytes). Priority: the first cause that applies.
      if (deps.inbox) {
        const wakeExclusion: WakeExclusion | "none" =
          req.forkSessionFrom !== undefined
            ? "consult_fork"
            : req.toolDomain === "readonly"
              ? "readonly_domain"
              : req.suppressDelivery === true || req.expectAck === true || req.callerOwned === true
                ? "caller_owned"
                : admittedExternal
                  ? "external_agent"
                  : "none";
        resolvedReq = { ...resolvedReq, wakeExclusion };
        // Provenance rides the display meta; the mailbox claim token is a secret that must not outlive admission.
        if (req.wakeOrigin !== undefined)
          resolvedReq = { ...resolvedReq, wakeOrigin: persistableWakeOrigin(req.wakeOrigin) };
      } else {
        const { wakeExclusion: _e, wakeOrigin: _o, ...rest } = resolvedReq;
        void _e;
        void _o;
        resolvedReq = rest;
      }
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
    successorOf(sessionFile) {
      return resumeOwners.get(sessionFile);
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
          ...(disposition.commit === undefined ? {} : { commit: disposition.commit }),
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
            ...(wt.commit === undefined ? {} : { commit: wt.commit }),
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
      const result = deps.runner.abort ? (await deps.runner.abort(runId, cause)).ok : false;
      if (result) return true;
      // Fix 3: the runtime adapter does not know this runId yet (still deep
      // inside the async H2/resume session-open work that precedes
      // RuntimeRunner.run() ever being entered — deps.runner.abort reports
      // ok:false because its own activeCancels map has no entry). Fall back
      // to the admission-time controller wired into start()'s RunnerSpec.signal:
      // AbortSignal semantics are sticky, so arming it now is still observed the
      // instant createCancelHandle finally runs (its synchronous "already
      // aborted" check), forcing an immediate self-cancel before any session or
      // tool work begins. Returns true whether this call actually armed it or
      // it was already armed by an earlier call (P1-1: cancellation is armed
      // either way, so a second/Nth abort() during the same A2 window must not
      // regress to false just because there is nothing new left to arm) —
      // idempotent, matching the existing "cooperative request dispatched"
      // meaning of deps.runner.abort's own ok:true, not a confirmation of
      // terminal settlement.
      const controller = admissionAbort.get(runId);
      if (controller) {
        if (!controller.signal.aborted) controller.abort(cause);
        return true;
      }
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
    runningIds: () => [...running],
    snapshots: () => [...records.values()],
  };
  return service;
}
