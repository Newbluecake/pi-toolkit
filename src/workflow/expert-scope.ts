import type { RunId } from "../core/types.js";
import { CONSULT_MAIN_EXPERT_ID, type ConsultExpertRef } from "../core/types.js";
import type { CallId, WorkflowChildSummary } from "./types.js";

/**
 * workflow-experts (docs/dev/workflow-experts/plan.md §4.2, D9/D10): local
 * name resolution for `agent({ experts })` inside a `SubagentWorkflow` run —
 * before anything is handed to the (host-session) consult resolver, a
 * handle that names one of *this workflow's own* `agent()` calls (by
 * declared or effective label) must resolve against that call's own
 * settlement, never fall through to an outer run that happens to share the
 * label (D9's "常见的「失败后同 label 重试」写法可以正常解析" example).
 *
 * State lives entirely in the closure `createWorkflowExpertScope()` returns
 * — one instance per workflow run, owned by `attachHostCallHandler`'s own
 * closure (host.ts), never module-scope (AGENTS.md's per-`activate()` /
 * per-run invariant).
 */

export interface WorkflowExpertScope {
  /** Called at submission time (host.ts's three `registry.submit` call sites) with the *declared* `opts.label`, if any. */
  noteSubmitted(callId: CallId, declaredLabel: string | undefined): void;
  /** Called once a call binds to a real `runId` (post spawn-dedup — `effectiveLabel` may differ from the declared one, e.g. "dev" -> "dev-2"). */
  noteBound(callId: CallId, runId: RunId, effectiveLabel: string | undefined): void;
  /** Called from the same `recordSettled` chokepoint host.ts already has — carries the final source/status/runId/label. */
  noteSettled(summary: WorkflowChildSummary): void;
  /**
   * D9/D10: `"main"` always passes through untouched (resolved by the
   * consult wiring's own reserved-id priority, unaffected by
   * `completedOnly`). Otherwise: no local call ever declared or resolved to
   * this label -> `pass` (let the resolver try an external label/run_id).
   * A local candidate exists -> `local` (rewrite to its runId) or `reject`
   * (D10: any unsettled candidate rejects outright; among settled
   * candidates, exactly one usable [`source:"live"`, `status:"completed"`,
   * has a runId] -> local; zero or >1 -> reject, fail-closed).
   */
  mapLocal(
    handle: string,
  ): { kind: "pass"; handle: string } | { kind: "local"; runId: RunId } | { kind: "reject"; message: string };
}

/**
 * D17: the workflow-facing seam onto `consult`'s `resolveExperts` (package
 * C) — never throws; every failure is `{ error }`. The `stack.ts` wiring
 * (§4.8) always calls it with `{ completedOnly: true }`.
 */
export type WorkflowExpertResolver = (
  handles: readonly string[],
) => { refs: readonly ConsultExpertRef[] } | { error: { message: string } };

interface CallInfo {
  declaredLabel: string | undefined;
  effectiveLabel: string | undefined;
  runId: RunId | undefined;
  settled: boolean;
  summary: WorkflowChildSummary | undefined;
}

export function createWorkflowExpertScope(): WorkflowExpertScope {
  const calls = new Map<CallId, CallInfo>();

  function candidatesFor(handle: string): Array<{ callId: CallId; info: CallInfo }> {
    const out: Array<{ callId: CallId; info: CallInfo }> = [];
    for (const [callId, info] of calls) {
      if (info.declaredLabel === handle || info.effectiveLabel === handle) out.push({ callId, info });
    }
    return out;
  }

  return {
    noteSubmitted(callId, declaredLabel) {
      calls.set(callId, {
        declaredLabel,
        effectiveLabel: undefined,
        runId: undefined,
        settled: false,
        summary: undefined,
      });
    },
    noteBound(callId, runId, effectiveLabel) {
      const info = calls.get(callId);
      if (!info) return;
      info.runId = runId;
      if (effectiveLabel !== undefined) info.effectiveLabel = effectiveLabel;
    },
    noteSettled(summary) {
      const info = calls.get(summary.callId);
      if (!info) {
        // Defensive: a settle for a callId this scope never saw submitted
        // for (shouldn't happen — noteSubmitted fires at every submission
        // site in host.ts). Record enough to still be matchable by label.
        calls.set(summary.callId, {
          declaredLabel: summary.label,
          effectiveLabel: summary.label,
          runId: summary.runId,
          settled: true,
          summary,
        });
        return;
      }
      info.settled = true;
      info.summary = summary;
      if (summary.runId !== undefined) info.runId = summary.runId;
      if (summary.label !== undefined) info.effectiveLabel = summary.label;
    },
    mapLocal(handle) {
      const trimmed = handle.trim();
      if (trimmed === CONSULT_MAIN_EXPERT_ID) return { kind: "pass", handle: trimmed };
      const candidates = candidatesFor(trimmed);
      if (candidates.length === 0) return { kind: "pass", handle: trimmed };
      if (candidates.some((c) => !c.info.settled)) {
        return {
          kind: "reject",
          message: `expert "${trimmed}" is still running in this workflow — await it before using it as an expert`,
        };
      }
      const usable = candidates.filter(
        (c) =>
          c.info.summary?.source === "live" && c.info.summary?.status === "completed" && c.info.runId !== undefined,
      );
      if (usable.length === 1) return { kind: "local", runId: usable[0]!.info.runId! };
      if (usable.length > 1) {
        return {
          kind: "reject",
          message: `expert "${trimmed}" is ambiguous — ${usable.length} completed local calls in this workflow share that label; use the run_id instead`,
        };
      }
      const states = candidates.map((c) =>
        c.info.summary?.source === "replay" ? "replay" : (c.info.summary?.status ?? "unknown"),
      );
      const replayHint = states.includes("replay")
        ? "; a replayed local call has no live session to consult in this run — retry with noReplay:true or pass an external run_id/label"
        : "";
      return {
        kind: "reject",
        message: `expert "${trimmed}": no completed local call matches — observed state(s): ${states.join(", ")}${replayHint}`,
      };
    },
  };
}

/**
 * §4.2: maps every handle through `mapLocal` first (any `reject` aborts the
 * whole submission — D19 "只要有本地候选就绝不回落到 resolver"), then hands
 * the rewritten batch (local hits replaced by their runId, everything else
 * verbatim) to `resolver` in one call. `resolver` absent -> `not supported`
 * (D17, never silently ignored). A `pending:true` ref in the result is a
 * second, defense-in-depth check for D8 (`completedOnly` should already
 * have excluded it) — reject rather than trust it. Refs are deduped by
 * `runId` (D18: a label and a run_id resolving to the same run collapse to
 * one entry).
 */
export function resolveWorkflowExperts(
  handles: readonly string[],
  scope: WorkflowExpertScope,
  resolver: WorkflowExpertResolver | undefined,
): { ok: true; refs: readonly ConsultExpertRef[]; ids: readonly string[] } | { ok: false; message: string } {
  const rewritten: string[] = [];
  for (const handle of handles) {
    const mapped = scope.mapLocal(handle);
    if (mapped.kind === "reject") return { ok: false, message: mapped.message };
    rewritten.push(mapped.kind === "local" ? mapped.runId : mapped.handle);
  }
  if (!resolver) {
    return {
      ok: false,
      message:
        "experts is not supported in this context (no consult whitelist resolver is wired for this workflow); drop the experts option",
    };
  }
  let result: ReturnType<WorkflowExpertResolver>;
  try {
    result = resolver(rewritten);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  if ("error" in result) return { ok: false, message: result.error.message };
  if (result.refs.some((r) => r.pending === true)) {
    return {
      ok: false,
      message: "agent({ experts }): a resolved expert is still running — workflow experts must be completed runs",
    };
  }
  const byRunId = new Map<string, ConsultExpertRef>();
  for (const ref of result.refs) {
    if (!byRunId.has(ref.runId)) byRunId.set(ref.runId, ref);
  }
  const dedup = [...byRunId.values()];
  return { ok: true, refs: dedup, ids: dedup.map((r) => r.runId) };
}
