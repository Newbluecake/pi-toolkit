import { describe, expect, it, vi } from "vitest";
import { CONSULT_MAIN_EXPERT_ID, type ConsultExpertRef } from "../../src/core/types.js";
import {
  createWorkflowExpertScope,
  resolveWorkflowExperts,
  type WorkflowExpertResolver,
} from "../../src/workflow/expert-scope.js";
import type { WorkflowChildSummary } from "../../src/workflow/types.js";

/**
 * workflow-experts (docs/dev/workflow-experts/plan.md §4.2, D9/D10, §6 test
 * list B#12-19): pure unit coverage for the local (within-this-workflow)
 * name resolution layer and its handoff to the (stubbed) consult resolver.
 * Package C's real `consult.resolveExperts` is stubbed here per the task's
 * file domain — see the module doc's cross-reference for the frozen
 * `{ completedOnly?: boolean }` signature this stub honors.
 */

function summary(overrides: Partial<WorkflowChildSummary> & { callId: string }): WorkflowChildSummary {
  return {
    source: "live",
    status: "completed",
    durationMs: 10,
    ...overrides,
  };
}

function ref(runId: string, label?: string): ConsultExpertRef {
  return { runId, ...(label !== undefined ? { label } : {}), sessionFile: `/tmp/${runId}.jsonl`, agentType: "gp" };
}

describe("createWorkflowExpertScope.mapLocal: D9/D10 local resolution", () => {
  it('"main" always passes through, even when a local call happens to share the label', () => {
    const scope = createWorkflowExpertScope();
    scope.noteSubmitted("c1", CONSULT_MAIN_EXPERT_ID);
    scope.noteBound("c1", "r1", CONSULT_MAIN_EXPERT_ID);
    scope.noteSettled(summary({ callId: "c1", runId: "r1" }));
    expect(scope.mapLocal("main")).toEqual({ kind: "pass", handle: "main" });
  });

  it("no local call ever declared or bound to this label -> pass (fall through to resolver)", () => {
    const scope = createWorkflowExpertScope();
    expect(scope.mapLocal("dev")).toEqual({ kind: "pass", handle: "dev" });
  });

  it("resolves to the runId of a completed local call matched by its DECLARED label", () => {
    const scope = createWorkflowExpertScope();
    scope.noteSubmitted("c1", "dev");
    scope.noteBound("c1", "r1", "dev");
    scope.noteSettled(summary({ callId: "c1", runId: "r1", label: "dev" }));
    expect(scope.mapLocal("dev")).toEqual({ kind: "local", runId: "r1" });
  });

  it("resolves via the EFFECTIVE (post-dedup) label even when the declared label differs — and never leaks to the outer same-named run", () => {
    const scope = createWorkflowExpertScope();
    scope.noteSubmitted("c1", "dev");
    scope.noteBound("c1", "r1", "dev-2"); // spawn deduped "dev" -> "dev-2"
    scope.noteSettled(summary({ callId: "c1", runId: "r1", label: "dev-2" }));
    expect(scope.mapLocal("dev-2")).toEqual({ kind: "local", runId: "r1" });
    // The original declared handle "dev" never matches an effective-only rename target it wasn't bound under.
  });

  it("any unsettled candidate -> reject 'still running', regardless of other settled candidates", () => {
    const scope = createWorkflowExpertScope();
    scope.noteSubmitted("c1", "dev");
    scope.noteBound("c1", "r1", "dev");
    // c1 never settles.
    const r = scope.mapLocal("dev");
    expect(r.kind).toBe("reject");
    if (r.kind !== "reject") throw new Error("expected reject");
    expect(r.message).toContain("still running");
  });

  it("same label, first failed then completed -> resolves to the completed one", () => {
    const scope = createWorkflowExpertScope();
    scope.noteSubmitted("c1", "dev");
    scope.noteBound("c1", "r1", "dev");
    scope.noteSettled(summary({ callId: "c1", runId: "r1", label: "dev", status: "failed" }));
    scope.noteSubmitted("c2", "dev");
    scope.noteBound("c2", "r2", "dev");
    scope.noteSettled(summary({ callId: "c2", runId: "r2", label: "dev", status: "completed" }));
    expect(scope.mapLocal("dev")).toEqual({ kind: "local", runId: "r2" });
  });

  it("same label, both completed -> ambiguous reject", () => {
    const scope = createWorkflowExpertScope();
    scope.noteSubmitted("c1", "dev");
    scope.noteBound("c1", "r1", "dev");
    scope.noteSettled(summary({ callId: "c1", runId: "r1", label: "dev", status: "completed" }));
    scope.noteSubmitted("c2", "dev");
    scope.noteBound("c2", "r2", "dev");
    scope.noteSettled(summary({ callId: "c2", runId: "r2", label: "dev", status: "completed" }));
    const r = scope.mapLocal("dev");
    expect(r.kind).toBe("reject");
    if (r.kind !== "reject") throw new Error("expected reject");
    expect(r.message).toContain("ambiguous");
  });

  it("zero completed candidates (all failed/withheld/timed_out/aborted) -> reject listing the observed states", () => {
    const scope = createWorkflowExpertScope();
    scope.noteSubmitted("c1", "dev");
    scope.noteSettled(summary({ callId: "c1", label: "dev", status: "failed" }));
    const r = scope.mapLocal("dev");
    expect(r.kind).toBe("reject");
    if (r.kind !== "reject") throw new Error("expected reject");
    expect(r.message).toContain("failed");
  });

  it("a replayed local call is never usable (D16) — reject mentions noReplay/external run_id guidance", () => {
    const scope = createWorkflowExpertScope();
    scope.noteSubmitted("c1", "dev");
    scope.noteSettled(summary({ callId: "c1", runId: "r1", label: "dev", source: "replay", status: "completed" }));
    const r = scope.mapLocal("dev");
    expect(r.kind).toBe("reject");
    if (r.kind !== "reject") throw new Error("expected reject");
    expect(r.message).toContain("replay");
    expect(r.message).toContain("noReplay");
  });
});

describe("resolveWorkflowExperts: local rewrite + resolver handoff (D9/D11/D17-D19)", () => {
  it("local hits are rewritten to their runId before the resolver sees them; the resolver is called once with the whole rewritten batch", () => {
    const scope = createWorkflowExpertScope();
    scope.noteSubmitted("c1", "dev");
    scope.noteBound("c1", "r1", "dev");
    scope.noteSettled(summary({ callId: "c1", runId: "r1", label: "dev", status: "completed" }));
    const resolver = vi.fn<WorkflowExpertResolver>((handles) => ({
      refs: handles.map((h) => ref(h === "r1" ? "r1" : "r-outside", h === "r1" ? "dev" : "outside")),
    }));
    const result = resolveWorkflowExperts(["dev", "outside"], scope, resolver);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(["r1", "outside"]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.ids).toEqual(["r1", "r-outside"]);
  });

  it("when a local candidate exists, the resolver never sees the original label at all (never falls back to it)", () => {
    const scope = createWorkflowExpertScope();
    scope.noteSubmitted("c1", "dev");
    scope.noteBound("c1", "r1", "dev");
    scope.noteSettled(summary({ callId: "c1", runId: "r1", label: "dev", status: "completed" }));
    const resolver = vi.fn<WorkflowExpertResolver>((handles) => ({ refs: handles.map((h) => ref(h)) }));
    resolveWorkflowExperts(["dev"], scope, resolver);
    const calledWith = resolver.mock.calls[0]![0];
    expect(calledWith).not.toContain("dev");
    expect(calledWith).toEqual(["r1"]);
  });

  it("a mapLocal reject short-circuits before the resolver is ever called", () => {
    const scope = createWorkflowExpertScope();
    scope.noteSubmitted("c1", "dev"); // never settles -> still running
    const resolver = vi.fn<WorkflowExpertResolver>(() => ({ refs: [] }));
    const result = resolveWorkflowExperts(["dev"], scope, resolver);
    expect(result).toEqual({ ok: false, message: expect.stringContaining("still running") });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('"main" passes straight through to the resolver even with a completed local call also present', () => {
    const scope = createWorkflowExpertScope();
    scope.noteSubmitted("c1", "dev");
    scope.noteBound("c1", "r1", "dev");
    scope.noteSettled(summary({ callId: "c1", runId: "r1", label: "dev", status: "completed" }));
    const resolver = vi.fn<WorkflowExpertResolver>((handles) => ({
      refs: handles.map((h) => (h === "main" ? { ...ref("main", "main"), kind: "main" as const } : ref(h))),
    }));
    const result = resolveWorkflowExperts(["main", "dev"], scope, resolver);
    expect(resolver).toHaveBeenCalledWith(["main", "r1"]);
    expect(result.ok).toBe(true);
  });

  it("resolver error is passed through verbatim", () => {
    const scope = createWorkflowExpertScope();
    const resolver: WorkflowExpertResolver = () => ({ error: { message: "boom from consult" } });
    const result = resolveWorkflowExperts(["outside"], scope, resolver);
    expect(result).toEqual({ ok: false, message: "boom from consult" });
  });

  it("resolver absent -> 'not supported in this context', never silently drops experts", () => {
    const scope = createWorkflowExpertScope();
    const result = resolveWorkflowExperts(["outside"], scope, undefined);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toContain("not supported in this context");
  });

  it("a pending:true ref in the resolver's result is rejected as a defense-in-depth double-check", () => {
    const scope = createWorkflowExpertScope();
    const resolver: WorkflowExpertResolver = () => ({ refs: [{ ...ref("r1"), pending: true }] });
    const result = resolveWorkflowExperts(["outside"], scope, resolver);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toContain("still running");
  });

  it("refs are deduped by runId — a label and a run_id resolving to the same run collapse to one entry (D18)", () => {
    const scope = createWorkflowExpertScope();
    const resolver: WorkflowExpertResolver = (handles) => ({
      refs: handles.map((h) => ref("r-shared", h)),
    });
    const result = resolveWorkflowExperts(["dev", "r-shared"], scope, resolver);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.refs).toHaveLength(1);
    expect(result.ids).toEqual(["r-shared"]);
  });

  it("a throwing resolver is caught defensively and turned into a failure (belt-and-braces on top of D17's contract)", () => {
    const scope = createWorkflowExpertScope();
    const resolver: WorkflowExpertResolver = () => {
      throw new Error("resolver blew up");
    };
    const result = resolveWorkflowExperts(["outside"], scope, resolver);
    expect(result).toEqual({ ok: false, message: "resolver blew up" });
  });
});
