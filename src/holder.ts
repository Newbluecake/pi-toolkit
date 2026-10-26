import type { Notifier } from "./delivery/notifier.js";
import type { OrphanRegistry } from "./runtime/reaper.js";
import type { QueryService } from "./service/query-service.js";
import type { SpawnService } from "./service/spawn-service.js";
import type { SpawnRequest } from "./core/types.js";
import type { BashJobManager } from "./bash/manager.js";
import type { TidyPort, TidySpawnRequest } from "./memory/contracts.js";
import type { WorkflowToolDeps } from "./tools/workflow-tool.js";
import type { WorkflowQueryPort } from "./tools/workflow-target.js";
import type { Stack } from "./stack.js";

/**
 * Holder-routed forwarders (moved out of index.ts, #56 batch 2 step 5).
 * Each session_start rebuilds the stack (ctx.sessionManager is only available there); tools/commands are
 * registered once at activate() time, so they forward every call through `holder.current` at call time rather
 * than closing over a specific instance. Explicit per-method forwarding (not a Proxy) keeps `this` binding
 * correct for methods like QueryService.waitAll() that call other methods on `this` internally.
 */
export type StackHolder = { current?: Stack };

export function requireStack(holder: StackHolder): Stack {
  if (!holder.current) throw new Error("pi-subagent: no active session yet");
  return holder.current;
}
/** todo #22 optimize-plan §7.0 (P0-b): projects the memory module's narrow
 *  `TidySpawnRequest` onto a real `SpawnRequest`, always forcing the P0-r
 *  readonly tool domain literal through untouched — `wireMemory`'s
 *  `TidyPort` is the only caller. */
function mapTidySpawnRequest(req: TidySpawnRequest): SpawnRequest {
  return {
    type: req.type,
    prompt: req.prompt,
    ...(req.label === undefined ? {} : { label: req.label }),
    ...(req.cwd === undefined ? {} : { cwd: req.cwd }),
    ...(req.modelOverride === undefined ? {} : { modelOverride: req.modelOverride }),
    ...(req.thinkingOverride === undefined ? {} : { thinkingOverride: req.thinkingOverride }),
    ...(req.totalMs === undefined ? {} : { budgetOverride: { totalMs: req.totalMs } }),
    ...(req.schema === undefined ? {} : { schema: req.schema }),
    ...(req.inputBudget === undefined ? {} : { inputBudget: req.inputBudget }),
    toolDomain: req.toolDomain,
    expectAck: req.expectAck,
    suppressDelivery: req.suppressDelivery,
  };
}
export function forwardSpawn(holder: StackHolder): SpawnService {
  return {
    spawn: (req) => requireStack(holder).spawn.spawn(req),
    spawnAndWait: (req) => requireStack(holder).spawn.spawnAndWait(req),
    abort: (runId, cause) => requireStack(holder).spawn.abort(runId, cause),
    waitAll: (opts) => requireStack(holder).spawn.waitAll(opts),
    waitOutcome: (runId, waitMs) => requireStack(holder).spawn.waitOutcome(runId, waitMs),
    expectsAck: (runId) => requireStack(holder).spawn.expectsAck(runId),
    // CC1: forwarded for parity with the rest of SpawnService; no caller yet
    // (the workflow orchestrator that will use this lands in M3.1+).
    stopChildrenOf: (parentId, cause) => requireStack(holder).spawn.stopChildrenOf(parentId, cause),
    resolveRun: (handle) => requireStack(holder).spawn.resolveRun(handle),
    resolveResume: (handle) => requireStack(holder).spawn.resolveResume(handle),
    successorOf: (sessionFile) => requireStack(holder).spawn.successorOf(sessionFile),
    setConcurrencyLimit: (n) => requireStack(holder).spawn.setConcurrencyLimit(n),
    slots: () => requireStack(holder).spawn.slots(),
    runningIds: () => requireStack(holder).spawn.runningIds(),
  };
}
export function forwardResolveRun(holder: StackHolder) {
  return (handle: string) => {
    const result = requireStack(holder).spawn.resolveRun?.(handle);
    if (!result) throw new Error("pi-subagent: run resolver unavailable");
    return result;
  };
}
export function forwardQuery(holder: StackHolder): QueryService {
  return {
    get: (runId) => requireStack(holder).query.get(runId),
    list: (filter) => requireStack(holder).query.list(filter),
    wait: (runId, opts) => requireStack(holder).query.wait(runId, opts),
    waitAll: (opts) => requireStack(holder).query.waitAll(opts),
    steer: (runId, text, origin) => requireStack(holder).query.steer(runId, text, origin),
    setModel: (runId, model, opts) => requireStack(holder).query.setModel(runId, model, opts),
    stop: (runId, cause) => requireStack(holder).query.stop(runId, cause),
    extendTimeout: (runId, extendMs, opts) => requireStack(holder).query.extendTimeout(runId, extendMs, opts),
  };
}
export function forwardWorkflow(holder: StackHolder, isReloadPending: () => boolean): WorkflowToolDeps {
  return {
    isReloadPending,
    get defaultBudget() {
      return requireStack(holder).workflow.defaultBudget;
    },
    runs: { start: (req) => requireStack(holder).workflow.runs.start(req) },
  };
}
/** Background workflow management for get_run_result / abort_subagent (plan §2.3). Lenient when no
 *  session exists yet: nothing resolves as a workflow, so the run path produces its usual error. */
export function forwardWorkflowQuery(holder: StackHolder): WorkflowQueryPort {
  return {
    resolve: (handle) => holder.current?.workflow.runs.resolve(handle) ?? { kind: "none" },
    resolveLabel: (handle) => holder.current?.workflow.runs.resolveLabel(handle) ?? { kind: "none" },
    get: (workflowId) => holder.current?.workflow.runs.get(workflowId),
    wait: (workflowId, opts) => requireStack(holder).workflow.runs.wait(workflowId, opts),
    stop: (workflowId, cause, opts) => requireStack(holder).workflow.runs.stop(workflowId, cause, opts),
    extend: (workflowId, extendMs, opts) => requireStack(holder).workflow.runs.extend(workflowId, extendMs, opts),
    activity: (workflowId) => holder.current?.workflow.activity.list().find((w) => w.workflowId === workflowId),
    snapshotOf: (runId) => holder.current?.query.get(runId),
    usageOf: (runId) => holder.current?.query.get(runId)?.diag.usage,
  };
}
/** bash auto-background: the current session's job manager (absent before the
 *  first session_start, or when the feature is off) — both bash tools read it
 *  at call time so they survive session rebuilds. */
export function forwardBashJobs(holder: StackHolder): () => BashJobManager | undefined {
  return () => holder.current?.bashJobs;
}
export function forwardOrphans(holder: StackHolder): OrphanRegistry {
  return {
    register: (r) => requireStack(holder).orphans.register(r),
    recordLateRecovered: (runId, gen) => requireStack(holder).orphans.recordLateRecovered(runId, gen),
    get recent() {
      return requireStack(holder).orphans.recent;
    },
    get totalCount() {
      return requireStack(holder).orphans.totalCount;
    },
    get lateRecoveredCount() {
      return requireStack(holder).orphans.lateRecoveredCount;
    },
    countInWindow: (ms) => requireStack(holder).orphans.countInWindow(ms),
    get byReason() {
      return requireStack(holder).orphans.byReason;
    },
    resetCircuit: (op) => requireStack(holder).orphans.resetCircuit(op),
  };
}
export function forwardNotifier(holder: StackHolder): Notifier {
  return {
    enqueue: (p, opts) => requireStack(holder).notifier.enqueue(p, opts),
    finalize: (runId, generation, patch) => requireStack(holder).notifier.finalize(runId, generation, patch),
    settleBatch: (keys, ok) => requireStack(holder).notifier.settleBatch(keys, ok),
    ack: (runId, generation, by) => requireStack(holder).notifier.ack(runId, generation, by),
    peek: (key) => requireStack(holder).notifier.peek(key),
    consume: (key, by) => requireStack(holder).notifier.consume(key, by),
    reconcile: (persisted) => requireStack(holder).notifier.reconcile(persisted),
    verifyPersisted: (keys) => requireStack(holder).notifier.verifyPersisted(keys),
    get stats() {
      return requireStack(holder).notifier.stats;
    },
    get degraded() {
      return requireStack(holder).notifier.degraded;
    },
    get ackedSuppressions() {
      return requireStack(holder).notifier.ackedSuppressions;
    },
  };
}

/** todo #22 optimize-plan P0-b (§7's spawn port): reads the CURRENT session stack, same late-bound
 *  `holder.current` pattern as `forwardSpawn`. Only reached for the main session (post-guard). */
export function createTidyPort(holder: StackHolder): TidyPort {
  return {
    spawn: (req) => requireStack(holder).spawn.spawn(mapTidySpawnRequest(req)),
    waitOutcome: (runId, waitMs) => requireStack(holder).spawn.waitOutcome(runId, waitMs),
    abort: (runId, cause) => requireStack(holder).spawn.abort(runId, cause),
    snapshot: (runId) => holder.current?.query.get(runId),
  };
}
