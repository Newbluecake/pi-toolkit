import { describe, expect, it } from "vitest";
import { createWorkflowActivityRegistry } from "../../src/workflow/activity.js";

/**
 * M3.6 phase tracking + M10 per-child lifecycle tracking for the live
 * workflow tool card. The registry is a pure event-reducer over the
 * `subagent:workflow:*` stream — these tests feed it the exact payloads
 * orchestrator.ts relays (`{ workflowId, ...event }`) and read the
 * resulting snapshots.
 */

const WF = "wf_test";

function registered() {
  const reg = createWorkflowActivityRegistry();
  reg.register(WF, "demo-flow", 1_000, 61_000);
  return reg;
}

function spawned(callId: string, extra: Record<string, unknown> = {}) {
  return { workflowId: WF, kind: "spawned", callId, runId: `run-${callId}`, at: 2_000, ...extra };
}

function settled(callId: string, extra: Record<string, unknown> = {}) {
  return {
    workflowId: WF,
    kind: "settled",
    callId,
    runId: `run-${callId}`,
    status: "completed",
    source: "live",
    durationMs: 500,
    at: 3_000,
    ...extra,
  };
}

describe("workflow activity registry (M3.6): workflow-level fields", () => {
  it("register/list/unregister round-trips name, startedAt, deadlineAt", () => {
    const reg = registered();
    expect(reg.list()).toHaveLength(1);
    const snap = reg.list()[0]!;
    expect(snap.name).toBe("demo-flow");
    expect(snap.startedAt).toBe(1_000);
    expect(snap.deadlineAt).toBe(61_000);
    reg.unregister(WF);
    expect(reg.list()).toHaveLength(0);
  });

  it("a phase enter event updates currentPhaseId; unknown workflows and malformed payloads are ignored", () => {
    const reg = registered();
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, phaseId: "Implement", kind: "enter" });
    expect(reg.list()[0]!.currentPhaseId).toBe("Implement");
    reg.onEvent("subagent:workflow:phase", { workflowId: "wf_other", phaseId: "X", kind: "enter" });
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, kind: "enter" }); // no phaseId
    reg.onEvent("unrelated:channel", { workflowId: WF, phaseId: "Y", kind: "enter" });
    expect(reg.list()[0]!.currentPhaseId).toBe("Implement");
  });
});

describe("workflow activity registry (M10): child lifecycle tracking", () => {
  it("a spawned event adds an active row with label/agentType/runId", () => {
    const reg = registered();
    reg.onEvent("subagent:workflow:child", spawned("c1", { label: "dev:a", agentType: "general-purpose" }));
    const snap = reg.list()[0]!;
    expect(snap.activeChildren).toHaveLength(1);
    expect(snap.activeChildren[0]).toMatchObject({
      callId: "c1",
      runId: "run-c1",
      label: "dev:a",
      agentType: "general-purpose",
      enteredAt: 2_000,
    });
    expect(snap.settledTotal).toBe(0);
  });

  it("a settled event removes the active row and bumps the totals + recent-settled trail", () => {
    const reg = registered();
    reg.onEvent("subagent:workflow:child", spawned("c1", { label: "dev:a" }));
    reg.onEvent("subagent:workflow:child", spawned("c2"));
    reg.onEvent("subagent:workflow:child", settled("c1", { label: "dev:a", durationMs: 1_200 }));
    const snap = reg.list()[0]!;
    expect(snap.activeChildren.map((c) => c.callId)).toEqual(["c2"]);
    expect(snap.settledTotal).toBe(1);
    expect(snap.completedTotal).toBe(1);
    expect(snap.replayTotal).toBe(0);
    expect(snap.settledChildren).toHaveLength(1);
    expect(snap.settledChildren[0]).toMatchObject({ callId: "c1", label: "dev:a", status: "completed" });
  });

  it("a settled without a preceding spawned (replay hit / withheld) counts but has no active row to remove", () => {
    const reg = registered();
    reg.onEvent(
      "subagent:workflow:child",
      settled("c1", { runId: undefined, source: "replay", status: "completed", durationMs: 0 }),
    );
    const snap = reg.list()[0]!;
    expect(snap.activeChildren).toHaveLength(0);
    expect(snap.settledTotal).toBe(1);
    expect(snap.completedTotal).toBe(1);
    expect(snap.replayTotal).toBe(1);
  });

  it("failed/withheld settles do not count as completed", () => {
    const reg = registered();
    reg.onEvent("subagent:workflow:child", settled("c1", { status: "failed" }));
    reg.onEvent("subagent:workflow:child", settled("c2", { status: "withheld", runId: undefined }));
    const snap = reg.list()[0]!;
    expect(snap.settledTotal).toBe(2);
    expect(snap.completedTotal).toBe(0);
  });

  it("a duplicate settle of the same callId counts only once", () => {
    const reg = registered();
    reg.onEvent("subagent:workflow:child", settled("c1"));
    reg.onEvent("subagent:workflow:child", settled("c1"));
    expect(reg.list()[0]!.settledTotal).toBe(1);
    expect(reg.list()[0]!.settledChildren).toHaveLength(1);
  });

  it("the recent-settled trail is capped (totals stay exact)", () => {
    const reg = registered();
    for (let i = 0; i < 12; i += 1) reg.onEvent("subagent:workflow:child", settled(`c${i}`));
    const snap = reg.list()[0]!;
    expect(snap.settledTotal).toBe(12);
    expect(snap.settledChildren).toHaveLength(8);
    expect(snap.settledChildren[0]!.callId).toBe("c4"); // oldest dropped
    expect(snap.settledChildren[7]!.callId).toBe("c11");
  });

  it("malformed child payloads are ignored, never fatal", () => {
    const reg = registered();
    reg.onEvent("subagent:workflow:child", null);
    reg.onEvent("subagent:workflow:child", { workflowId: WF, kind: "spawned" }); // no callId
    reg.onEvent("subagent:workflow:child", { workflowId: WF, kind: "mystery", callId: "c1", at: 1 });
    reg.onEvent("subagent:workflow:child", { workflowId: WF, kind: "spawned", callId: "c1" }); // no at
    const snap = reg.list()[0]!;
    expect(snap.activeChildren).toHaveLength(0);
    expect(snap.settledTotal).toBe(0);
  });

  it("child events for unknown/unregistered workflows are dropped", () => {
    const reg = registered();
    reg.onEvent("subagent:workflow:child", { ...spawned("c1"), workflowId: "wf_gone" });
    expect(reg.list()[0]!.activeChildren).toHaveLength(0);
  });
});

describe("workflow activity registry (M11): per-phase pipeline stats", () => {
  function pipeline() {
    const reg = createWorkflowActivityRegistry();
    reg.register(WF, "pipe", 1_000, 61_000, ["scan", "summarize", "report"]);
    return reg;
  }

  it("planned phases are pending chips until entered; the entered one becomes active", () => {
    const reg = pipeline();
    expect(reg.list()[0]!.phases.map((p) => [p.id, p.state])).toEqual([
      ["scan", "pending"],
      ["summarize", "pending"],
      ["report", "pending"],
    ]);
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, phaseId: "summarize", kind: "enter" });
    // the entered phase moves to the chain head (entered segment); the others stay pending behind it
    expect(reg.list()[0]!.phases.map((p) => [p.id, p.state])).toEqual([
      ["summarize", "active"],
      ["scan", "pending"],
      ["report", "pending"],
    ]);
  });

  it("entered phases lead the chain in entry order; planned-but-unentered keep scan order behind them", () => {
    const reg = pipeline();
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, phaseId: "summarize", kind: "enter" });
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, phaseId: "scan", kind: "enter" });
    // entered segment = actual entry order (summarize, scan); report stays pending at the tail
    expect(reg.list()[0]!.phases.map((p) => [p.id, p.state])).toEqual([
      ["summarize", "done"],
      ["scan", "active"],
      ["report", "pending"],
    ]);
  });

  it("a runtime phase unknown to the scan appends to the entered segment (chain tail among entered)", () => {
    const reg = pipeline();
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, phaseId: "hotfix", kind: "enter" });
    expect(reg.list()[0]!.phases.map((p) => [p.id, p.state])).toEqual([
      ["hotfix", "active"],
      ["scan", "pending"],
      ["summarize", "pending"],
      ["report", "pending"],
    ]);
  });

  it("counts spawned/settled/failed per phase; settled resolves the phase via the spawned row (callId lookup)", () => {
    const reg = pipeline();
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, phaseId: "scan", kind: "enter" });
    reg.onEvent("subagent:workflow:child", spawned("c1", { phaseId: "scan" }));
    reg.onEvent("subagent:workflow:child", spawned("c2", { phaseId: "scan" }));
    reg.onEvent("subagent:workflow:child", settled("c1")); // completed; no phaseId on the event
    reg.onEvent("subagent:workflow:child", settled("c2", { status: "failed" }));
    // scan is still the current phase → active; entering summarize settles it to done
    expect(reg.list()[0]!.phases[0]).toMatchObject({ id: "scan", state: "active", spawned: 2, settled: 2, failed: 1 });
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, phaseId: "summarize", kind: "enter" });
    expect(reg.list()[0]!.phases[0]).toMatchObject({ id: "scan", state: "done", spawned: 2, settled: 2, failed: 1 });
    expect(reg.list()[0]!.phases[1]).toMatchObject({ id: "summarize", state: "active", spawned: 0, settled: 0 });
  });

  it("children without a phaseId count in the workflow totals but never land on the chain", () => {
    const reg = pipeline();
    reg.onEvent("subagent:workflow:child", spawned("c9")); // no phaseId anywhere
    reg.onEvent("subagent:workflow:child", settled("c9", { status: "failed" }));
    const snap = reg.list()[0]!;
    expect(snap.phases.map((p) => p.id)).toEqual(["scan", "summarize", "report"]);
    expect(snap.phases.every((p) => p.spawned === 0 && p.settled === 0)).toBe(true);
    expect(snap.settledTotal).toBe(1);
    expect(snap.completedTotal).toBe(0);
  });

  it("a settled event carrying phaseId (replay hit, no spawned row) counts toward that phase", () => {
    const reg = pipeline();
    reg.onEvent(
      "subagent:workflow:child",
      settled("c1", { runId: undefined, source: "replay", phaseId: "scan", durationMs: 0 }),
    );
    expect(reg.list()[0]!.phases[0]).toMatchObject({ id: "scan", state: "done", spawned: 0, settled: 1, failed: 0 });
  });

  it("a phase the script left while children still run is draining (never done/✓) until they all settle", () => {
    const reg = pipeline();
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, phaseId: "scan", kind: "enter" });
    reg.onEvent("subagent:workflow:child", spawned("c1", { phaseId: "scan" }));
    reg.onEvent("subagent:workflow:child", spawned("c2", { phaseId: "scan" }));
    reg.onEvent("subagent:workflow:child", settled("c1"));
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, phaseId: "summarize", kind: "enter" });
    expect(reg.list()[0]!.phases[0]).toMatchObject({ id: "scan", state: "draining", spawned: 2, settled: 1 });
    reg.onEvent("subagent:workflow:child", settled("c2"));
    expect(reg.list()[0]!.phases[0]).toMatchObject({ id: "scan", state: "done", spawned: 2, settled: 2 });
  });

  it("a frozen (terminal) snapshot never shows draining — unsettled stragglers freeze as done", () => {
    let now = 10_000;
    const reg = createWorkflowActivityRegistry({ now: () => now, terminalLingerMs: 5_000 });
    reg.register(WF, "pipe", 1_000, 61_000, ["scan", "summarize"]);
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, phaseId: "scan", kind: "enter" });
    reg.onEvent("subagent:workflow:child", spawned("c1", { phaseId: "scan" }));
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, phaseId: "summarize", kind: "enter" });
    reg.unregister(WF, { status: "aborted" });
    now += 1_000;
    const frozen = reg.listForDisplay()[0]!;
    expect(frozen.phases.map((p) => p.state)).toEqual(["done", "done"]);
  });

  it("re-entering an earlier phase keeps its first chain slot (documented positional semantics)", () => {
    const reg = pipeline();
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, phaseId: "scan", kind: "enter" });
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, phaseId: "summarize", kind: "enter" });
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, phaseId: "scan", kind: "enter" });
    expect(reg.list()[0]!.phases.map((p) => [p.id, p.state])).toEqual([
      ["scan", "active"],
      ["summarize", "done"],
      ["report", "pending"],
    ]);
  });

  it("WorkflowSettledChild carries settledAt (the event's `at`)", () => {
    const reg = registered();
    reg.onEvent("subagent:workflow:child", spawned("c1"));
    reg.onEvent("subagent:workflow:child", settled("c1", { at: 9_500 }));
    expect(reg.list()[0]!.settledChildren[0]!.settledAt).toBe(9_500);
  });
});

describe("workflow activity registry (M11): terminal linger (list() vs listForDisplay())", () => {
  function lingerReg() {
    let now = 10_000;
    const reg = createWorkflowActivityRegistry({ now: () => now, terminalLingerMs: 5_000 });
    return {
      reg,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("PIN: after unregister, list() drops the workflow immediately while listForDisplay() keeps it for the linger window", () => {
    // list() is the background-busy counter (keepalive backgroundBusy, deferred
    // /reload activeSubagentRunCount re-counted on settle events, status
    // countBusy) — a lingering entry there would strand a deferred reload
    // forever (no event fires when the linger expires).
    const { reg, advance } = lingerReg();
    reg.register(WF, "demo-flow", 1_000, 61_000, ["scan"]);
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, phaseId: "scan", kind: "enter" });
    reg.onEvent("subagent:workflow:child", spawned("c1", { phaseId: "scan" }));
    reg.onEvent("subagent:workflow:child", settled("c1"));
    reg.unregister(WF, { status: "completed" });
    expect(reg.list()).toHaveLength(0); // running-only contract, immediately
    expect(reg.listForDisplay()).toHaveLength(1);
    advance(4_999);
    expect(reg.listForDisplay()).toHaveLength(1);
    advance(2); // 5_001ms since endedAt — strictly past the window
    expect(reg.listForDisplay()).toHaveLength(0);
    expect(reg.list()).toHaveLength(0);
  });

  it("the frozen snapshot carries the terminal mark, frozen stats, and entered phases done (no active chip)", () => {
    const { reg } = lingerReg();
    reg.register(WF, "demo-flow", 1_000, 61_000, ["scan", "report"]);
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, phaseId: "scan", kind: "enter" });
    reg.onEvent("subagent:workflow:child", spawned("c1", { phaseId: "scan", label: "scan:files" }));
    reg.onEvent("subagent:workflow:child", settled("c1", { label: "scan:files" }));
    reg.unregister(WF, { status: "failed" });
    const frozen = reg.listForDisplay()[0]!;
    expect(frozen.terminal).toMatchObject({ status: "failed", endedAt: 10_000 });
    expect(frozen.currentPhaseId).toBe("scan");
    expect(frozen.settledChildren[0]).toMatchObject({ callId: "c1", label: "scan:files", settledAt: 3_000 });
    expect(frozen.phases.map((p) => [p.id, p.state])).toEqual([
      ["scan", "done"], // frozen: current phase no longer renders as active
      ["report", "pending"],
    ]);
  });

  it("unregister without a status marks the frozen snapshot as plain terminal; a later register of the same id drops it", () => {
    const { reg } = lingerReg();
    reg.register(WF, "demo-flow", 1_000);
    reg.unregister(WF);
    expect(reg.listForDisplay()[0]!.terminal!.status).toBe("terminal");
    reg.register(WF, "demo-flow-2", 20_000);
    expect(reg.listForDisplay()).toHaveLength(1);
    expect(reg.listForDisplay()[0]!.terminal).toBeUndefined();
    expect(reg.listForDisplay()[0]!.name).toBe("demo-flow-2");
  });

  it("terminalLingerMs: 0 removes the workflow outright (no frozen copy at all)", () => {
    let now = 10_000;
    const reg = createWorkflowActivityRegistry({ now: () => now, terminalLingerMs: 0 });
    reg.register(WF, "demo-flow", 1_000);
    reg.unregister(WF, { status: "completed" });
    expect(reg.list()).toHaveLength(0);
    expect(reg.listForDisplay()).toHaveLength(0);
  });

  it("events for an unregistered (frozen) workflow are dropped — the snapshot never mutates after freeze", () => {
    const { reg } = lingerReg();
    reg.register(WF, "demo-flow", 1_000);
    reg.unregister(WF, { status: "completed" });
    reg.onEvent("subagent:workflow:child", spawned("c1"));
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, phaseId: "x", kind: "enter" });
    const frozen = reg.listForDisplay()[0]!;
    expect(frozen.activeChildren).toHaveLength(0);
    expect(frozen.currentPhaseId).toBeUndefined();
  });
});
