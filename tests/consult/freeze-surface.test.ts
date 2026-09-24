import { describe, expect, it } from "vitest";
import type { ConsultExpertRef, ForkExpertSessionResult, RunSnapshot, StopCause } from "../../src/core/types.js";
import { CONSULT_READONLY_TOOLS } from "../../src/runtime/tool-scope.js";
import { matchRunId, type ResolveTargetDeps } from "../../src/service/resolve-target.js";

/**
 * Package A (consult plan §6) freeze-surface lock. Everything asserted here is
 * something packages B/C/D are allowed to depend on without re-deriving it —
 * plan §10 "包 A 合并后不得再改".
 */

/** Type-level equality; `true` only when the two unions are mutually assignable. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * §15 #1 / checklist ①: `StopCause` stays the closed five-value union — a
 * capped consult run is aborted as `user_stop`, so state-machine.ts and the
 * transition-matrix/property tests are untouched by this feature. Widening
 * StopCause (e.g. adding "turn_cap") makes this line fail `tsc --noEmit`.
 */
const stopCauseUnchanged: Same<StopCause, "parent_abort" | "user_stop" | "timeout" | "shutdown" | "parent_gone"> = true;

describe("consult package A: frozen surface", () => {
  it("keeps StopCause closed at the existing five causes (§15 #1)", () => {
    expect(stopCauseUnchanged).toBe(true);
  });

  it("CONSULT_READONLY_TOOLS is exactly the read-only four, in plan order", () => {
    expect(CONSULT_READONLY_TOOLS).toEqual(["read", "grep", "find", "ls"]);
    // pi 默认激活 read/bash/edit/write：grep/find/ls 只有被显式写进 tools 才存在，
    // bash/edit/write 必须缺席（B 形态的零写能力就靠这一条）。
    for (const forbidden of ["bash", "edit", "write", "Agent", "message_agent", "consult"]) {
      expect(CONSULT_READONLY_TOOLS).not.toContain(forbidden);
    }
  });

  it("ForkExpertSessionResult narrows on `ok` (result object, never a throw — §15 #2)", () => {
    const ok: ForkExpertSessionResult = { ok: true, path: "/tmp/fork.jsonl" };
    const bad: ForkExpertSessionResult = { ok: false, reason: "no session header" };
    const describeResult = (r: ForkExpertSessionResult): string => (r.ok ? `path:${r.path}` : `reason:${r.reason}`);
    expect(describeResult(ok)).toBe("path:/tmp/fork.jsonl");
    expect(describeResult(bad)).toBe("reason:no session header");
  });

  it("ConsultExpertRef carries the dispatch-time snapshot fields consult pre-checks read", () => {
    const ref: ConsultExpertRef = {
      runId: "r_EXPERT01",
      label: "explorer",
      sessionFile: "/tmp/expert.jsonl",
      agentType: "explorer",
      model: { provider: "cloudrouter-anthropic", id: "claude-opus-5-5" },
      contextPercent: 42,
      contextTokens: 150_000,
      pending: false,
    };
    // 首轮成本预检（§4.1）只需要 contextTokens + model；上下文预检只需要 contextPercent。
    expect(ref.contextTokens).toBe(150_000);
    expect(ref.contextPercent).toBe(42);
    expect(ref.model?.provider).toBe("cloudrouter-anthropic");
    // runId 是匹配键，label 只作展示（跨 reload 代际可重名）。
    const minimal: ConsultExpertRef = { runId: "r_X", sessionFile: "/tmp/x.jsonl", agentType: "explorer" };
    expect(minimal.label).toBeUndefined();
  });
});

/**
 * §4.5 / §6 C-8b: `matchRunId` is exported so the ExpertIndex resolves ids
 * with the very implementation `resolve-target` uses. This exercises the deps
 * shape the index will feed it (projected records only, empty labels /
 * liveSnapshots / tombstones).
 */
describe("consult package A: matchRunId is reusable by the ExpertIndex", () => {
  function projected(runId: string): RunSnapshot {
    return {
      runId,
      generation: 1,
      status: "completed",
      phase: "settled",
      deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
      diag: {
        createdAt: 0,
        phase: "settled",
        phaseEnteredAt: 0,
        pendingTools: 0,
        turns: 1,
        escalation: [],
        orphaned: false,
        generation: 1,
        degraded: [],
        staleInputs: 0,
        unkillable: [],
        sessionFile: `/tmp/${runId}.jsonl`,
      },
      updatedAt: 0,
    };
  }
  function indexDeps(ids: readonly string[]): ResolveTargetDeps {
    return {
      records: () => ids.map(projected),
      liveSnapshots: [],
      labels: new Map(),
      tombstones: { list: () => [], get: () => undefined },
    };
  }

  it("resolves an exact id, a unique prefix, and reports ambiguity", () => {
    const deps = indexDeps(["r_ABCDEFGH", "r_ABCDEFGJ", "r_ZZZZ0001"]);
    expect(matchRunId("r_ABCDEFGH", deps)).toEqual({ runId: "r_ABCDEFGH", ambiguous: false });
    expect(matchRunId("r_Z", deps)).toEqual({ runId: "r_ZZZZ0001", ambiguous: false });
    expect(matchRunId("r_ABCDEFG", deps)).toEqual({ ambiguous: true });
    expect(matchRunId("nope", deps)).toEqual({ ambiguous: false });
  });

  it("ignores labels entirely (label semantics are the index's own, §4.5)", () => {
    const deps: ResolveTargetDeps = {
      ...indexDeps(["r_AAAA0001"]),
      labels: new Map([["explorer", { runId: "r_AAAA0001" }]]),
    };
    expect(matchRunId("explorer", deps)).toEqual({ ambiguous: false });
    expect(matchRunId("r_AAAA0001", deps)).toEqual({ runId: "r_AAAA0001", ambiguous: false });
  });
});
