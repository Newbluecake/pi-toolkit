import type { StopCause } from "../core/types.js";
import type { AgentTypeRegistry } from "../config/agent-types.js";
import type { ChildOutcome, ChildSpawnError, ChildSpawnResult, ChildSpawner } from "./host.js";
import type { ChildWorktreeInfo } from "./types.js";
import type { SpawnService } from "../service/spawn-service.js";

/**
 * M3.6 (workflow design §11 M3.6, blocker fix §6.3 E2): the production
 * `ChildSpawner` \u2014 a thin adapter over the real `SpawnService` +
 * `AgentTypeRegistry`, assembled once per session in `stack.ts` (D7/I7:
 * `src/workflow/**` stays decoupled from `src/service/**` concrete types,
 * WI2 \u2014 this file lives *outside* `src/workflow/**` for exactly that
 * reason, mirroring where `runtime-adapter.ts` sits relative to
 * `runtime/runner.ts`).
 *
 * `SpawnService.spawn`/`waitAll` are already structurally compatible with
 * `ChildSpawner` (host.ts's own doc comment) \u2014 the only real work here is
 * (a) narrowing `StopCause` (a small closed union) down from the
 * `ChildSpawner` surface's plain `string` `cause` parameter, since a
 * workflow-internal stop cause (`"runaway"`, `"script_error"`,
 * `"phase_timeout"`, \u2026) has no matching core `StopCause` member, and
 * (b) wiring `configHashOf` to the real `AgentTypeRegistry` (the Blocker fix
 * \u2014 without this, `host.ts` fails closed on replay for every call, which
 * is the *safe* default but not the *useful* one).
 */
function toCoreStopCause(cause?: string): StopCause | undefined {
  switch (cause) {
    case "user_stop":
    case "timeout":
    case "shutdown":
    case "parent_abort":
    case "parent_gone":
      return cause;
    case undefined:
      return undefined;
    default:
      // "runaway" / "script_error" / "worker_died" / "phase_timeout" / any
      // future WorkflowStopCause member: all describe "this workflow's own
      // owner decided to stop it", which is exactly core's `parent_abort`.
      return "parent_abort";
  }
}

export interface WorkflowChildSpawnerOptions {
  /**
   * workflow-experts §4.8: the workflow-facing seam onto `consult`'s
   * `resolveExperts(refs, opts?)` (package C's frozen-face signature).
   * `stack.ts` wires this to a late-bound ref over the real consult wiring.
   * `createWorkflowChildSpawner` itself always calls it with `{
   * completedOnly: true }` (D8) and wraps any throw into `{ error }` before
   * handing a plain 1-arg `WorkflowExpertResolver` down to `host.ts`
   * (`ChildSpawner.resolveExperts`) — host.ts/`resolveWorkflowExperts` never
   * know about `completedOnly` at all, that policy choice lives entirely at
   * this seam.
   */
  resolveExperts?: (
    refs: readonly string[],
    opts: { completedOnly: true },
  ) => { refs: readonly import("../core/types.js").ConsultExpertRef[] } | { error: { message: string } };
  /**
   * workflow-worktree plan D2: the live availability gate for
   * `isolation:"worktree"` — `stack.ts` wires this to `() =>
   * settings.worktree.enabled`, read fresh on every call (a `/reload` that
   * flips the setting takes effect immediately, same convention as
   * `resolveExperts` being a late-bound ref rather than a snapshot). Absent
   * — e.g. a test that never configures it — `handleAgent`'s D2 gate fails
   * closed (`worktreeAvailable?.() !== true` reads `undefined`).
   */
  worktreeAvailable?: () => boolean;
}

export function createWorkflowChildSpawner(
  spawn: SpawnService,
  types: AgentTypeRegistry,
  opts?: WorkflowChildSpawnerOptions,
): ChildSpawner {
  return {
    async spawn(req): Promise<ChildSpawnResult | ChildSpawnError> {
      const result = await spawn.spawn({
        type: req.type,
        prompt: req.prompt,
        ...(req.label !== undefined ? { label: req.label } : {}),
        // workflow-experts §4.8: forwarded verbatim — already-resolved,
        // trusted refs (host.ts only ever populates this from a successful
        // `resolveWorkflowExperts`, never from anything the script itself
        // could construct).
        ...(req.consultExperts !== undefined && req.consultExperts.length > 0
          ? { consultExperts: [...req.consultExperts] }
          : {}),
        // workflow-worktree plan D1: forwarded verbatim to `SpawnRequest.
        // isolation` — the real worktree-isolation machinery lives entirely
        // in H2 (src/extensions/worktree.ts) and the service layer; this
        // adapter's only job is to not drop the field.
        ...(req.isolation !== undefined ? { isolation: req.isolation } : {}),
        // agent()'s `opts.model` / `opts.thinking` (Agent-tool `model`/
        // `thinking` semantics, split in host.ts's `handleAgent`):
        // forwarded verbatim so spawn admission existence-checks strict
        // pairs (`modelExists`, `Did you mean` suggestions) and fuzzy-resolves
        // hints — an unknown model / unresolvable hint / quota-gate block all
        // come back as a spawn error, i.e. a dispatch failure that rejects
        // the script's `agent()` call.
        ...(req.modelOverride !== undefined ? { modelOverride: req.modelOverride } : {}),
        ...(req.modelHintOverride !== undefined ? { modelHintOverride: req.modelHintOverride } : {}),
        ...(req.thinkingOverride !== undefined ? { thinkingOverride: req.thinkingOverride } : {}),
        ...(req.deadlineAt !== undefined ? { deadlineAt: req.deadlineAt } : {}),
        ...(req.parentRunId !== undefined ? { parentRunId: req.parentRunId } : {}),
        // §4.4.3 BW1/BW3: the workflow-derived relative budget, forwarded
        // verbatim \u2014 `SpawnRequest.budgetOverride` is `Partial<DeadlineBudget>`,
        // a strict superset of `{ totalMs?, queueWaitMs? }`.
        ...(req.budgetOverride !== undefined ? { budgetOverride: req.budgetOverride } : {}),
        // D-W3 (§5.4 / D4 front-condition 4): workflow children *do* go
        // through the core `SlotPool` like any other run — `slotless` is
        // deliberately left unset (defaults to `false`) rather than forced
        // `true`. The workflow's own `maxParallel` (run-budget.ts's RW5
        // `min(4, concurrencyLimit-1)`) is a *local* gate layered on top of,
        // never a substitute for, T1's queue-timeout protection.
      });
      return "error" in result
        ? { error: { message: result.error.message } }
        : { runId: result.runId, ...(result.label !== undefined ? { label: result.label } : {}) };
    },
    abort(runId, cause) {
      return spawn.abort(runId, toCoreStopCause(cause));
    },
    async waitAll(opts): Promise<{ settled: ChildOutcome[]; pending: string[] }> {
      const { settled, pending } = await spawn.waitAll({ runIds: opts.runIds });
      return {
        settled: settled.map((o) => ({
          runId: o.runId,
          status: o.status,
          ...(o.text !== undefined ? { text: o.text } : {}),
          ...(o.error !== undefined ? { error: { message: o.error.message } } : {}),
          ...(o.usage !== undefined ? { usage: o.usage } : {}),
        })),
        pending,
      };
    },
    async stopChildrenOf(parentRunId, cause) {
      return spawn.stopChildrenOf(parentRunId, toCoreStopCause(cause));
    },
    configHashOf(type) {
      return types.configHashOf(type);
    },
    ...(opts?.worktreeAvailable ? { worktreeAvailable: opts.worktreeAvailable } : {}),
    /**
     * workflow-worktree plan D5: maps `SpawnService.waitWorktreeDisposition`'s
     * `settled|none|timeout|disposed` result onto `ChildWorktreeInfo`
     * — `timeout` and `disposed` both collapse to `"pending"` (host.ts never
     * needs to tell a settle-wait give-up apart from a stack-rebuild
     * dispose). Absent `SpawnService.waitWorktreeDisposition` (an older/test
     * double) degrades to `{ state: "none" }` rather than throwing.
     */
    async awaitWorktree(runId, waitOpts): Promise<ChildWorktreeInfo> {
      if (!spawn.waitWorktreeDisposition) return { state: "none" };
      const result = await spawn.waitWorktreeDisposition(runId, waitOpts);
      switch (result.kind) {
        case "settled":
          return {
            state: result.disposition.state,
            ...(result.disposition.branch !== undefined ? { branch: result.disposition.branch } : {}),
            ...(result.disposition.path !== undefined ? { path: result.disposition.path } : {}),
          };
        case "none":
          return { state: "none" };
        case "timeout":
        case "disposed":
          return { state: "pending" };
      }
    },
    ...(opts?.resolveExperts
      ? {
          resolveExperts(handles) {
            try {
              return opts.resolveExperts!(handles, { completedOnly: true });
            } catch (e) {
              return { error: { message: e instanceof Error ? e.message : String(e) } };
            }
          },
        }
      : {}),
  };
}
