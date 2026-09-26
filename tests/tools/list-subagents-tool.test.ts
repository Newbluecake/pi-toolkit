import { describe, expect, it } from "vitest";
import { createListSubagentsTool, type ListSubagentsDetails } from "../../src/tools/list-subagents-tool.js";
import type { QueryService } from "../../src/service/query-service.js";
import type { RunSnapshot, UsageDelta } from "../../src/core/types.js";
import type { WorkflowActivitySnapshot } from "../../src/workflow/activity.js";
import type { SlotsInfo } from "../../src/core/format.js";

const NOW = 100_000;

const usage: UsageDelta = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.0123 };

function baseSnapshot(overrides: Partial<RunSnapshot> & { runId: string }): RunSnapshot {
  return {
    runId: overrides.runId,
    generation: 1,
    status: "running",
    phase: "model_turn",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: {
      createdAt: NOW - 5_000,
      phase: "model_turn",
      phaseEnteredAt: NOW - 1_000,
      pendingTools: 0,
      turns: 2,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      usage,
      label: "worker-a",
      agentType: "worker",
      model: { provider: "acme", id: "big" },
      ...overrides.diag,
    },
    updatedAt: NOW,
    ...overrides,
  } as RunSnapshot;
}

function queryOf(runs: RunSnapshot[]): QueryService {
  const byId = new Map(runs.map((r) => [r.runId, r]));
  return {
    get: (id) => byId.get(id),
    list: () => [...runs],
    wait: async () => ({ ok: false, reason: "unknown_run" }),
    waitAll: async () => ({ settled: [], pending: [] }),
    steer: async () => ({ ok: false, reason: "not_running" }),
    setModel: async () => ({ ok: false, reason: "not_running" }) as never,
    stop: async () => ({ ok: false, reason: "unknown_run" }),
    extendTimeout: () => ({ ok: false, reason: "unknown_run" }),
  };
}

function spawnOf(slots: SlotsInfo) {
  return { slots: () => slots };
}

function baseWorkflowSnapshot(
  overrides: Partial<WorkflowActivitySnapshot> & { workflowId: string },
): WorkflowActivitySnapshot {
  return {
    workflowId: overrides.workflowId,
    name: "my-script",
    startedAt: NOW - 20_000,
    activeChildren: [],
    settledChildren: [],
    settledTotal: 0,
    completedTotal: 0,
    replayTotal: 0,
    queuedChildren: [],
    rejectedTotal: 0,
    stageErrorTotal: 0,
    phases: [],
    ...overrides,
  };
}

function detailsOf(result: { details?: unknown }): ListSubagentsDetails {
  return result.details as ListSubagentsDetails;
}

describe("list_subagents", () => {
  it("reports an explicit empty state plus the slots line when nothing is active", async () => {
    const tool = createListSubagentsTool({
      query: queryOf([]),
      spawn: spawnOf({ limit: 5, inUse: 0, free: 5 }),
      workflow: { activity: { list: () => [] } },
      now: () => NOW,
    });
    const result = await tool.execute("tc", {}, undefined, () => undefined, {} as never);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(text).toContain("No active subagent runs or workflows.");
    expect(text).toContain("slots: 0/5 in use, 5 free");
    const details = detailsOf(result);
    expect(details.runs).toEqual([]);
    expect(details.workflows).toEqual([]);
    expect(details.slots).toEqual({ limit: 5, inUse: 0, free: 5 });
    expect(details.recent).toBeUndefined();
  });

  it("lists a plain active run with label/type/model/phase/elapsed/turns/cost", async () => {
    const run = baseSnapshot({ runId: "r_a" });
    const tool = createListSubagentsTool({
      query: queryOf([run]),
      spawn: spawnOf({ limit: 5, inUse: 1, free: 4 }),
      now: () => NOW,
    });
    const result = await tool.execute("tc", {}, undefined, () => undefined, {} as never);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(text).toContain("Subagent runs: 1 active");
    expect(text).toContain("r_a");
    expect(text).toContain('"worker-a"');
    expect(text).toContain("worker");
    expect(text).toContain("acme/big");
    expect(text).toContain("running/model_turn");
    expect(text).toContain("2t");
    expect(text).toContain("$0.0123");
    const details = detailsOf(result);
    expect(details.runs).toEqual([
      {
        runId: "r_a",
        label: "worker-a",
        agentType: "worker",
        model: { provider: "acme", id: "big" },
        status: "running",
        phase: "model_turn",
        elapsedMs: 5_000,
        turns: 2,
        costUsd: 0.0123,
        depth: 0,
      },
    ]);
  });

  it("shows a queued run's queue_wait duration instead of status/phase", async () => {
    const run = baseSnapshot({
      runId: "r_q",
      status: "queued",
      phase: "queue_wait",
      diag: {
        createdAt: NOW - 9_000,
        enqueuedAt: NOW - 9_000,
        phase: "queue_wait",
        phaseEnteredAt: NOW - 9_000,
      } as never,
    });
    const tool = createListSubagentsTool({
      query: queryOf([run]),
      spawn: spawnOf({ limit: 1, inUse: 1, free: 0, queued: 1 }),
      now: () => NOW,
    });
    const result = await tool.execute("tc", {}, undefined, () => undefined, {} as never);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(text).toContain("queue_wait 9s");
    expect(text).toContain("slots: 1/1 in use, 0 free, 1 queued");
    const details = detailsOf(result);
    expect(details.runs[0]?.queueWaitMs).toBe(9_000);
  });

  it("indents a nested Agent-tool child under its still-tracked parent", async () => {
    const parent = baseSnapshot({ runId: "r_parent", diag: { label: "parent", createdAt: NOW - 10_000 } as never });
    const child = baseSnapshot({
      runId: "r_child",
      parentRunId: "r_parent",
      diag: { label: "child", createdAt: NOW - 3_000 } as never,
    });
    const tool = createListSubagentsTool({
      query: queryOf([parent, child]),
      spawn: spawnOf({ limit: 5, inUse: 2, free: 3 }),
      now: () => NOW,
    });
    const result = await tool.execute("tc", {}, undefined, () => undefined, {} as never);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    const lines = text.split("\n");
    const parentLine = lines.findIndex((l) => l.includes("r_parent"));
    const childLine = lines.findIndex((l) => l.includes("r_child"));
    expect(parentLine).toBeGreaterThanOrEqual(0);
    expect(childLine).toBeGreaterThan(parentLine);
    expect(lines[childLine]).toMatch(/^\s+└─ /);
    const details = detailsOf(result);
    const childRow = details.runs.find((r) => r.runId === "r_child");
    expect(childRow?.depth).toBe(1);
    expect(childRow?.parentRunId).toBe("r_parent");
  });

  it("lists a workflow with its running child (joined against the live run snapshot) and its queued child, never duplicated at the top level", async () => {
    const childRun = baseSnapshot({
      runId: "r_wfchild",
      parentRunId: "wf_abc",
      diag: { label: "wf-child", createdAt: NOW - 2_000 } as never,
    });
    const wf = baseWorkflowSnapshot({
      workflowId: "wf_abc",
      name: "release-flow",
      currentPhaseId: "build",
      deadlineAt: NOW + 60_000,
      activeChildren: [
        {
          callId: "c1",
          runId: "r_wfchild",
          label: "wf-child",
          agentType: "worker",
          phaseId: "build",
          enteredAt: NOW - 2_000,
        },
      ],
      queuedChildren: [
        { callId: "c2", label: "wf-queued", agentType: "worker", phaseId: "build", queuedAt: NOW - 500 },
      ],
    });
    const tool = createListSubagentsTool({
      query: queryOf([childRun]),
      spawn: spawnOf({ limit: 5, inUse: 1, free: 4 }),
      workflow: { activity: { list: () => [wf] } },
      now: () => NOW,
    });
    const result = await tool.execute("tc", {}, undefined, () => undefined, {} as never);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(text).toContain("Workflows: 1 active");
    expect(text).toContain("wf_abc");
    expect(text).toContain("release-flow");
    expect(text).toContain("remaining 1m00s");
    expect(text).toContain("r_wfchild");
    expect(text).toContain("wf-queued");
    expect(text).toContain("queued");
    // Not duplicated in the top-level "Subagent runs" section.
    expect(text).not.toContain("Subagent runs: 1 active");
    const details = detailsOf(result);
    expect(details.runs).toEqual([]);
    expect(details.workflows).toHaveLength(1);
    expect(details.workflows[0]?.status).toBe("running");
    expect(details.workflows[0]?.children).toHaveLength(2);
    expect(details.workflows[0]?.children[0]?.run?.runId).toBe("r_wfchild");
    expect(details.workflows[0]?.children[1]?.queued).toBe(true);
  });

  it("nests a workflow child's own descendants under the workflow (never as top-level roots) and reports status", async () => {
    const child = baseSnapshot({
      runId: "r_wfc",
      parentRunId: "wf_x",
      diag: { label: "wf-child", createdAt: NOW - 3_000 } as never,
    });
    const grand = baseSnapshot({
      runId: "r_grand",
      parentRunId: "r_wfc",
      diag: { label: "grand", createdAt: NOW - 2_000 } as never,
    });
    const great = baseSnapshot({
      runId: "r_great",
      parentRunId: "r_grand",
      diag: { label: "great", createdAt: NOW - 1_000 } as never,
    });
    const wf = baseWorkflowSnapshot({
      workflowId: "wf_x",
      name: "deep",
      graceUntil: NOW + 30_000,
      activeChildren: [{ callId: "c1", runId: "r_wfc", label: "wf-child", enteredAt: NOW - 3_000 }],
    });
    const tool = createListSubagentsTool({
      query: queryOf([child, grand, great]),
      spawn: spawnOf({ limit: 5, inUse: 3, free: 2 }),
      workflow: { activity: { list: () => [wf] } },
      now: () => NOW,
    });
    const result = await tool.execute("tc", {}, undefined, () => undefined, {} as never);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    const details = detailsOf(result);
    expect(details.runs).toEqual([]); // no descendant leaks to the top level
    expect(text).not.toContain("Subagent runs:");
    const wfRow = details.workflows[0]!;
    expect(wfRow.status).toBe("grace");
    expect(text).toContain('"deep"  grace');
    const desc = wfRow.children[0]?.descendants ?? [];
    expect(desc.map((r) => [r.runId, r.depth])).toEqual([
      ["r_grand", 2],
      ["r_great", 3],
    ]);
    const lines = text.split("\n");
    const gi = lines.findIndex((l) => l.includes("r_grand"));
    const ci = lines.findIndex((l) => l.includes("r_wfc"));
    expect(gi).toBeGreaterThan(ci);
    expect(lines[gi]!.indexOf("r_grand")).toBeGreaterThan(lines[ci]!.indexOf("r_wfc"));
  });

  it("clamps `recent` to the 0-20 range and lists terminal runs newest-first", async () => {
    const older = baseSnapshot({
      runId: "r_old",
      status: "completed",
      diag: { label: "old", settledAt: NOW - 5_000, createdAt: NOW - 8_000 } as never,
    });
    const newer = baseSnapshot({
      runId: "r_new",
      status: "failed",
      diag: { label: "new", settledAt: NOW - 1_000, createdAt: NOW - 4_000 } as never,
    });
    const stillRunning = baseSnapshot({ runId: "r_live" });
    const tool = createListSubagentsTool({
      query: queryOf([older, newer, stillRunning]),
      spawn: spawnOf({ limit: 5, inUse: 1, free: 4 }),
      now: () => NOW,
    });
    const result = await tool.execute("tc", { recent: 1 }, undefined, () => undefined, {} as never);
    const details = detailsOf(result);
    expect(details.recent).toHaveLength(1);
    expect(details.recent?.[0]?.runId).toBe("r_new");
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(text).toContain("Recent (1):");
    expect(text).toContain("r_new");
    expect(text).not.toContain("r_old");
  });

  it("says explicitly when recent was requested but nothing terminal exists yet", async () => {
    const tool = createListSubagentsTool({
      query: queryOf([baseSnapshot({ runId: "r_live" })]),
      spawn: spawnOf({ limit: 5, inUse: 1, free: 4 }),
      now: () => NOW,
    });
    const result = await tool.execute("tc", { recent: 5 }, undefined, () => undefined, {} as never);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(text).toContain("Recent (0): no terminal runs recorded this session.");
  });

  it("mirrors the Agent tool's slots accounting verbatim via formatSlots", async () => {
    const tool = createListSubagentsTool({
      query: queryOf([]),
      spawn: spawnOf({ limit: 10, inUse: 10, free: 0, queued: 2 }),
      now: () => NOW,
    });
    const result = await tool.execute("tc", {}, undefined, () => undefined, {} as never);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(text).toContain("slots: 10/10 in use, 0 free, 2 queued");
  });
});
