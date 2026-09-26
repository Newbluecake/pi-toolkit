import { describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import type { ChildOutcome, ChildSpawner } from "../../src/workflow/host.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import { createOrchestrator } from "../../src/workflow/orchestrator.js";
import { createWorkflowActivityRegistry, type WorkflowActivitySnapshot } from "../../src/workflow/activity.js";
import { createBackgroundWorkflows, type BackgroundWorkflows } from "../../src/workflow/background.js";
import type { WorkflowOutcome, WorkflowRunBudget } from "../../src/workflow/types.js";
import type { RunSnapshot } from "../../src/core/types.js";
import {
  buildWorkflowProgressLines,
  createDisabledWorkflowToolStub,
  createWorkflowTool,
  formatWorkflowNotification,
  formatWorkflowResultText,
  formatWorkflowSummary,
  renderOutcomeText,
  renderWorktreeBlock,
} from "../../src/tools/workflow-tool.js";

/**
 * SubagentWorkflow tool — background-only (docs/dev/workflow-background/plan.md).
 *
 *  - The tool validates, starts the run in the background registry and
 *    returns the workflow id at once; the workflow settles later.
 *  - "two agents, real worker" proves the engine path is intact end-to-end:
 *    a real `node:worker_threads` worker runs a real script that calls
 *    `agent()` twice, through the real orchestrator, started by the tool.
 *  - The bounded run → stop → settle → fallback sequence (formerly WT13/WT17
 *    in this tool) now lives in the registry: tests/workflow/background.test.ts.
 */

const REAL_BUDGET: WorkflowRunBudget = {
  scriptLoadMs: 2_000,
  scriptSliceMs: 2_000,
  workerBootMs: 5_000,
  heartbeatMs: 0,
  heartbeatStallMs: 60_000,
  terminateConfirmMs: 2_000,
  workflowTotalMs: 20_000,
  runawayPolicy: "diagnose_only",
  hostCallMs: 5_000,
  gateMs: 5_000,
  maxParallel: 8,
  maxChildren: 50,
  maxBatchItems: 50,
};

function makeSpawner(opts: { hold?: boolean } = {}): {
  spawner: ChildSpawner;
  spawnedPrompts: string[];
  release: () => void;
} {
  const spawnedPrompts: string[] = [];
  let n = 0;
  const promptByRunId = new Map<string, string>();
  let releaseHeld!: () => void;
  const held = new Promise<void>((resolve) => (releaseHeld = resolve));
  const spawner: ChildSpawner = {
    spawn: async (req) => {
      spawnedPrompts.push(req.prompt);
      const runId = `r${++n}`;
      promptByRunId.set(runId, req.prompt);
      return { runId };
    },
    abort: async () => true,
    waitAll: async ({ runIds }) => {
      if (opts.hold) await held;
      const settled: ChildOutcome[] = runIds.map((runId) => {
        const prompt = promptByRunId.get(runId) ?? "";
        return { runId, status: "completed" as const, text: `done:${prompt}` };
      });
      return { settled, pending: [] };
    },
    configHashOf: (type) => `cfg:${type}`,
  };
  return { spawner, spawnedPrompts, release: () => releaseHeld() };
}

function realRuns(spawner: ChildSpawner): BackgroundWorkflows {
  const activity = createWorkflowActivityRegistry();
  return createBackgroundWorkflows({
    clock: systemClock,
    activity,
    createOrchestrator: (workflowId) =>
      createOrchestrator({
        clock: systemClock,
        createWorkerHost: () => createWorkerHost({ clock: systemClock }),
        spawner,
        gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
        parentRunId: workflowId,
        emit: (channel, payload) => activity.onEvent(channel, payload),
      }),
  });
}

function toolWith(runs: BackgroundWorkflows, budget: WorkflowRunBudget = REAL_BUDGET) {
  return createWorkflowTool({ defaultBudget: budget, runs });
}

async function settle(runs: BackgroundWorkflows, workflowId: string): Promise<WorkflowOutcome> {
  const waited = await runs.wait(workflowId, { waitMs: 15_000 });
  if (!waited.ok) throw new Error(`workflow did not settle: ${waited.reason}`);
  return waited.view.outcome;
}

const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");

describe("SubagentWorkflow tool: background-only", () => {
  it("returns immediately with a workflow id + label marker while the workflow is still running", async () => {
    const { spawner, release } = makeSpawner({ hold: true });
    const runs = realRuns(spawner);
    const tool = toolWith(runs);
    const script = 'export const meta = { name: "held-flow", description: "t" };\nreturn await agent("task");';
    const result = await tool.execute("call-bg", { script }, undefined);
    const details = result.details as { workflowId: string; label: string; status: string; background: boolean };
    expect(details).toMatchObject({ label: "held-flow", status: "running", background: true });
    expect(details.workflowId).toMatch(/^wf_[0-9a-f]{20}$/);
    // The call did not wait for the terminal state: the registry still has it running.
    expect(runs.get(details.workflowId)?.status).toBe("running");
    const body = text(result);
    expect(body).toContain(`workflow_id: ${details.workflowId}`);
    expect(body).toContain(`get_subagent_result(run_id: "${details.workflowId}")`);
    expect(body).toContain(`abort_subagent(run_id: "${details.workflowId}")`);
    expect(body).toMatch(/do not block or poll/);
    expect(body).toContain(`[workflow label: "held-flow" · workflow_id: ${details.workflowId} · status: running]`);
    release();
    const outcome = await settle(runs, details.workflowId);
    expect(outcome.status).toBe("completed");
    expect(outcome.result).toBe("done:task");
  }, 20_000);

  it("the workflow is detached from the tool call's signal once started (Esc on the turn does not stop it)", async () => {
    const { spawner, release } = makeSpawner({ hold: true });
    const runs = realRuns(spawner);
    const tool = toolWith(runs);
    const controller = new AbortController();
    const result = await tool.execute(
      "call-detached",
      { script: 'export const meta = { name: "d", description: "t" };\nreturn await agent("x");' },
      controller.signal,
    );
    const id = (result.details as { workflowId: string }).workflowId;
    controller.abort(); // after start
    release();
    const outcome = await settle(runs, id);
    expect(outcome.status).toBe("completed"); // not "aborted"
  }, 20_000);

  it("an already-aborted signal is still rejected before anything starts", async () => {
    const { spawner, spawnedPrompts } = makeSpawner();
    const runs = realRuns(spawner);
    const tool = toolWith(runs);
    const controller = new AbortController();
    controller.abort();
    const result = await tool.execute(
      "call-3",
      { script: 'export const meta = { name: "t", description: "t" };\nreturn 1;' },
      controller.signal,
    );
    expect(result.details).toEqual({ status: "aborted" });
    expect(runs.list()).toEqual([]);
    expect(spawnedPrompts).toEqual([]);
  });

  it("an empty or oversized script is rejected synchronously and nothing is registered", async () => {
    const runs = realRuns(makeSpawner().spawner);
    const tool = toolWith(runs);
    await expect(tool.execute("c", { script: "   " }, undefined)).rejects.toThrow(/must not be empty/);
    await expect(tool.execute("c", { script: "x".repeat(600 * 1024) }, undefined)).rejects.toThrow(/byte limit/);
    expect(runs.list()).toEqual([]);
  });

  it("timeout_s overrides the workflow budget", async () => {
    const started: WorkflowRunBudget[] = [];
    const tool = createWorkflowTool({
      defaultBudget: REAL_BUDGET,
      runs: {
        start: (req) => {
          started.push(req.budget);
          return { workflowId: "wf_fixed", name: req.name, startedAt: 0, status: "running" };
        },
      },
    });
    await tool.execute(
      "c",
      { script: 'export const meta={name:"t",description:"t"};\nreturn 1;', timeout_s: 7 },
      undefined,
    );
    expect(started[0]!.workflowTotalMs).toBe(7_000);
  });

  it("describes the background model and no longer claims to block", () => {
    const tool = toolWith(realRuns(makeSpawner().spawner));
    expect(tool.description).toContain("always runs in the background");
    expect(tool.description).toContain("get_subagent_result");
    expect(tool.description).toContain("abort_subagent");
    expect(tool.description).not.toMatch(/BLOCKS|blocks until/);
    expect(tool.promptSnippet).toMatch(/background/);
  });

  it("documents agent()'s per-call model/thinking opts (Agent-tool model semantics) and the strict opts / experts contract", () => {
    const tool = toolWith(realRuns(makeSpawner().spawner));
    expect(tool.description).toContain("model");
    expect(tool.description).toContain("thinking");
    // The script-param description carries the opts list a script author reads.
    const params = tool.parameters as unknown as { properties: { script: { description: string } } };
    const desc = params.properties.script.description;
    expect(desc).toContain("strictly validated");
    expect(desc).toContain("model");
    expect(desc).toContain("provider/id");
    expect(desc).toContain("fuzzy hint");
    expect(desc).toContain("thinking");
    expect(desc).toContain("'off' | 'low' | 'medium' | 'high'");
    expect(desc).toContain("isolation");
    expect(desc).toContain("experts");
    expect(desc).toContain("completed");
    expect(desc).toContain("noReplay");
  });
});

describe("SubagentWorkflow (background): real worker end-to-end", () => {
  it("a two-agent script (sequential) runs through a real worker and settles with the combined result", async () => {
    const { spawner, spawnedPrompts } = makeSpawner();
    const runs = realRuns(spawner);
    const script =
      'export const meta = { name: "two-agent", description: "t" };\n' +
      'const a = await agent("first task");\n' +
      'const b = await agent("second task");\n' +
      'return a + "|" + b;';
    const r = await toolWith(runs).execute("call-1", { script }, undefined);
    const outcome = await settle(runs, (r.details as { workflowId: string }).workflowId);
    expect(spawnedPrompts).toEqual(["first task", "second task"]);
    expect(outcome.status).toBe("completed");
    expect(outcome.children).toHaveLength(2);
    expect(renderOutcomeText(outcome)).toContain("done:first task|done:second task");
  }, 15_000);

  it("a two-agent script run in parallel() also completes end-to-end", async () => {
    const { spawner, spawnedPrompts } = makeSpawner();
    const runs = realRuns(spawner);
    const script =
      'export const meta = { name: "parallel-two", description: "t" };\n' +
      'const [a, b] = await parallel([() => agent("p1"), () => agent("p2")]);\n' +
      'return [a, b].join(",");';
    const r = await toolWith(runs).execute("call-2", { script }, undefined);
    const outcome = await settle(runs, (r.details as { workflowId: string }).workflowId);
    expect(spawnedPrompts.sort()).toEqual(["p1", "p2"]);
    expect(outcome.status).toBe("completed");
  }, 15_000);

  it("a script error (after an await) settles as failed with the workflow's diagnostic text", async () => {
    const runs = realRuns(makeSpawner().spawner);
    const script = 'export const meta = { name: "t", description: "t" };\nawait agent("x");\nthrow new Error("boom");';
    const r = await toolWith(runs).execute("call-4", { script }, undefined);
    const outcome = await settle(runs, (r.details as { workflowId: string }).workflowId);
    expect(outcome.status).toBe("failed");
    expect(renderOutcomeText(outcome)).toMatch(/boom/);
  }, 10_000);

  it("a pipeline stage that throws settles items to null AND surfaces a stage-error WARNING (the null is never silent)", async () => {
    const runs = realRuns(makeSpawner().spawner);
    // First-stage signature bug, the exact incident shape: (item) reads the
    // *prev* arg (undefined on stage 0), so every item throws a TypeError.
    const script =
      'export const meta = { name: "pipe-null", description: "t" };\n' +
      "const graded = await pipeline(\n" +
      "  [{ dim: 'a' }, { dim: 'b' }],\n" +
      "  async (item) => item.dim.toUpperCase(),\n" +
      "  async (prev) => prev + '!',\n" +
      ");\n" +
      "return JSON.stringify(graded);";
    const r = await toolWith(runs).execute("call-5", { script }, undefined);
    const outcome = await settle(runs, (r.details as { workflowId: string }).workflowId);
    const body = renderOutcomeText(outcome);
    expect(body).toContain("[null,null]");
    expect(outcome.status).toBe("completed");
    expect(body).toMatch(/WARNING: 2 parallel\(\)\/pipeline\(\) stage\(s\) threw/);
    expect(body).toMatch(/pipeline\[item 0 stage 0\]:/);
    expect(body).toMatch(/Cannot read propert/);
  }, 15_000);

  it("a parallel thunk that throws resolves its slot to null AND surfaces a stage-error WARNING", async () => {
    const runs = realRuns(makeSpawner().spawner);
    const script =
      'export const meta = { name: "par-null", description: "t" };\n' +
      "const r = await parallel([\n" +
      "  async () => { throw new Error('thunk boom'); },\n" +
      "  async () => 'ok',\n" +
      "]);\n" +
      "return JSON.stringify(r);";
    const r = await toolWith(runs).execute("call-6", { script }, undefined);
    const outcome = await settle(runs, (r.details as { workflowId: string }).workflowId);
    const body = renderOutcomeText(outcome);
    expect(body).toContain('[null,"ok"]');
    expect(body).toMatch(/WARNING: 1 parallel\(\)\/pipeline\(\) stage\(s\) threw/);
    expect(body).toMatch(/parallel\[item 0\]: thunk boom/);
  }, 15_000);
});

describe("SubagentWorkflow disabled stub (settings.workflow.enabled === false)", () => {
  it("registers under the same tool name but always throws a clear, honest error", async () => {
    const stub = createDisabledWorkflowToolStub();
    expect(stub.name).toBe("SubagentWorkflow");
    await expect(
      stub.execute("call", { script: 'export const meta = { name: "t", description: "t" };\nreturn 1;' }, undefined),
    ).rejects.toThrow(/disabled/);
  });
});

function fakeOutcome(overrides: Partial<WorkflowOutcome> = {}): WorkflowOutcome {
  return {
    workflowId: "wf_fake",
    status: "completed",
    pendingReconcile: false,
    durationMs: 1,
    children: [],
    diag: { createdAt: 0, heartbeat: { seq: 0, observedAt: 0, stalledMs: 0 }, logLines: 0 },
    ...overrides,
  };
}

describe("M10: buildWorkflowProgressLines", () => {
  const base: WorkflowActivitySnapshot = {
    workflowId: "wf_1",
    name: "demo-flow",
    startedAt: 0,
    activeChildren: [],
    settledChildren: [],
    settledTotal: 0,
    completedTotal: 0,
    replayTotal: 0,
    queuedChildren: [],
    rejectedTotal: 0,
    stageErrorTotal: 0,
    phases: [],
  };

  it("renders the header with name, phase, elapsed and remaining budget", () => {
    const lines = buildWorkflowProgressLines({ ...base, currentPhaseId: "Implement", deadlineAt: 1_800_000 }, 130_000);
    expect(lines[0]).toBe("⏳ demo-flow · phase: Implement · 2m10s · 27m50s left");
    expect(lines).toHaveLength(1); // no tally/children yet
  });

  it("stage B: inside the grace window the header counts down the grace; an extended run shows (+N)", () => {
    const grace = buildWorkflowProgressLines({ ...base, deadlineAt: 60_000, graceUntil: 150_000 }, 62_000);
    expect(grace[0]).toBe("⏳ demo-flow · 1m02s · grace 1m28s left");
    const extended = buildWorkflowProgressLines({ ...base, deadlineAt: 120_000, extensions: 1 }, 62_000);
    expect(extended[0]).toBe("⏳ demo-flow · 1m02s · 58s left (+1)");
  });

  it("renders the settled/running tally and the recent-settled trail with per-status marks", () => {
    const lines = buildWorkflowProgressLines(
      {
        ...base,
        settledTotal: 3,
        completedTotal: 2,
        replayTotal: 1,
        settledChildren: [
          { callId: "c1", label: "explore:auth", status: "completed", source: "live", durationMs: 48_000 },
          { callId: "c2", label: "dev:api", status: "completed", source: "replay", durationMs: 0 },
          { callId: "c3", label: "dev:web", status: "failed", source: "live", durationMs: 62_000 },
        ],
        activeChildren: [{ callId: "c4", label: "verify:api", enteredAt: 100_000 }],
      },
      130_000,
    );
    expect(lines[1]).toBe("✓ 2 (1 replay) · ✗ 1 · ▸ 1 running");
    expect(lines[2]).toBe("✓ explore:auth (48s) · ↩ dev:api (0ms) · ✗ dev:web (1m02s)");
    // c4 has no snapshot available (snapshotOf not provided) → fallback row.
    expect(lines[3]).toBe("▸ verify:api · spawned 30s ago");
  });

  it("renders a live child's own M-B progress lines re-prefixed with its label when a snapshot is available", () => {
    const snap: RunSnapshot = {
      runId: "run-c1",
      generation: 1,
      status: "running",
      phase: "model_turn",
      deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
      diag: {
        createdAt: 100_000,
        phase: "model_turn",
        phaseEnteredAt: 100_000,
        pendingTools: 1,
        turns: 3,
        escalation: [],
        orphaned: false,
        generation: 1,
        degraded: [],
        staleInputs: 0,
        unkillable: [],
        model: { provider: "p", id: "kimi-k3" },
        toolHistory: [{ name: "bash", toolCallId: "t1", startedAt: 120_000 }],
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, costUsd: 0.08 },
      },
      updatedAt: 130_000,
    };
    const lines = buildWorkflowProgressLines(
      { ...base, activeChildren: [{ callId: "c1", label: "dev:api", runId: "run-c1", enteredAt: 100_000 }] },
      130_000,
      (runId) => (runId === "run-c1" ? snap : undefined),
    );
    expect(lines[1]).toBe("▸ 1 running");
    expect(lines[2]).toContain("▸ dev:api · p/kimi-k3");
    expect(lines[2]).toContain("turn 4");
    expect(lines[2]).toContain("$0.08");
    expect(lines.some((l) => l.includes("▸ bash"))).toBe(true); // the child's running tool row
  });

  it("caps per-child rows and collapses the rest into a +N line", () => {
    const activeChildren = Array.from({ length: 8 }, (_, i) => ({
      callId: `c${i}`,
      label: `t${i}`,
      enteredAt: 0,
    }));
    const lines = buildWorkflowProgressLines({ ...base, activeChildren }, 1_000);
    expect(lines.filter((l) => l.startsWith("▸ t"))).toHaveLength(6);
    expect(lines[lines.length - 1]).toBe("… +2 more running");
  });
});

describe("M10: formatWorkflowSummary", () => {
  it("renders status · duration · children tally (✓/↩/✗) · cost", () => {
    const summary = formatWorkflowSummary(
      fakeOutcome({
        durationMs: 130_000,
        children: [
          { callId: "c1", source: "live", status: "completed", durationMs: 1 },
          { callId: "c2", source: "replay", status: "completed", durationMs: 0 },
          { callId: "c3", source: "live", status: "failed", durationMs: 2 },
        ],
      }),
      { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.42 },
    );
    expect(summary).toBe("completed · 2m10s · 3 children (✓2 ↩1 ✗1) · $0.42");
  });

  it("omits the children tally and cost when absent", () => {
    expect(formatWorkflowSummary(fakeOutcome({ durationMs: 500 }))).toBe("completed · 500ms");
  });
});

describe("renderOutcomeText: does not duplicate child output already in result", () => {
  const child = (
    label: string,
    status: WorkflowOutcome["children"][number]["status"],
    textPreview?: string,
  ): WorkflowOutcome["children"][number] => ({
    callId: `c-${label}`,
    label,
    source: "live",
    status,
    durationMs: 10,
    ...(textPreview !== undefined ? { textPreview } : {}),
  });

  it("with a result: completed children show status only; failed children keep their preview", () => {
    const body = renderOutcomeText(
      fakeOutcome({
        result: { a: "ALPHA-OUTPUT" },
        children: [child("a", "completed", "ALPHA-OUTPUT"), child("b", "failed", "BETA-ERROR-DETAIL")],
      }),
    );
    expect(body.match(/ALPHA-OUTPUT/g)).toHaveLength(1); // only inside result:
    expect(body).toContain("  - [completed] a\n");
    expect(body).toContain("  - [failed] b: BETA-ERROR-DETAIL");
    expect(body).toContain("children (2, completed outputs omitted");
  });

  it("a structured result is pretty-printed on its own lines; a primitive stays inline", () => {
    const obj = { a: "x", n: [1, 2] };
    expect(renderOutcomeText(fakeOutcome({ result: obj }))).toContain(`result:\n${JSON.stringify(obj, null, 2)}`);
    expect(renderOutcomeText(fakeOutcome({ result: 42 }))).toContain("result: 42");
  });

  it("without a result: completed children keep their preview (it is the only place the output shows up)", () => {
    const body = renderOutcomeText(fakeOutcome({ children: [child("a", "completed", "ALPHA-OUTPUT")] }));
    expect(body).toContain("  - [completed] a: ALPHA-OUTPUT");
    expect(body).toContain("children (1):");
  });
});

describe("renderOutcomeText: replay stats line (replay-verify plan D11/§6 test 19)", () => {
  it("off mode / no isolation activity: the replay line has no wt-* suffix at all", () => {
    const body = renderOutcomeText(fakeOutcome({ replay: { hits: 2, misses: 1, skipped: 0, corruptLines: 0 } }));
    expect(body).toContain("replay: 2 hit, 1 miss, 0 skipped, 0 corrupt");
    expect(body).not.toContain("wt-");
  });

  it("verify mode appends `, N wt-verified, N wt-unverified`", () => {
    const body = renderOutcomeText(
      fakeOutcome({
        replay: {
          hits: 1,
          misses: 0,
          skipped: 0,
          corruptLines: 0,
          isolation: { probed: 3, verified: 2, unverified: 1, freshFolds: 1, stale: 0 },
        },
      }),
    );
    expect(body).toContain("replay: 1 hit, 0 miss, 0 skipped, 0 corrupt, 2 wt-verified, 1 wt-unverified");
  });

  it("a nonzero stale count appends `, N wt-stale`", () => {
    const body = renderOutcomeText(
      fakeOutcome({
        replay: {
          hits: 1,
          misses: 0,
          skipped: 0,
          corruptLines: 0,
          isolation: { probed: 1, verified: 1, unverified: 0, freshFolds: 0, stale: 1 },
        },
      }),
    );
    expect(body).toContain("1 wt-verified, 0 wt-unverified, 1 wt-stale");
  });

  it("#21: a journal load timeout surfaces loadError as a live-only / not-written warning", () => {
    const body = renderOutcomeText(
      fakeOutcome({
        replay: { hits: 0, misses: 0, skipped: 2, corruptLines: 0, loadError: "journal load timed out" },
      }),
    );
    expect(body).toContain("replay: 0 hit, 0 miss, 2 skipped, 0 corrupt");
    expect(body).toContain("journal not used this run (journal load timed out)");
    expect(body).toContain("nothing was written to the journal");
  });
});

describe("renderWorktreeBlock (workflow-worktree plan D5 §4 render, §6 test 23)", () => {
  const withWorktree = (
    label: string,
    worktree: WorkflowOutcome["children"][number]["worktree"],
    extra: Partial<WorkflowOutcome["children"][number]> = {},
  ): WorkflowOutcome["children"][number] => ({
    callId: `c-${label}`,
    runId: `r-${label}`,
    label,
    source: "live",
    status: "completed",
    durationMs: 10,
    worktree,
    ...extra,
  });

  it("returns undefined when no child carries a worktree entry at all", () => {
    expect(renderWorktreeBlock(fakeOutcome({ children: [withWorktree("a", undefined)] }))).toBeUndefined();
    expect(renderWorktreeBlock(fakeOutcome({ children: [] }))).toBeUndefined();
  });

  it("clean and none are never listed", () => {
    expect(
      renderWorktreeBlock(
        fakeOutcome({ children: [withWorktree("a", { state: "clean" }), withWorktree("b", { state: "none" })] }),
      ),
    ).toBeUndefined();
  });

  it("renders committed with branch, kept with path, and pending→final when worktreeFinal has arrived", () => {
    const block = renderWorktreeBlock(
      fakeOutcome({
        children: [
          withWorktree("a", { state: "committed", branch: "pi-agent-r-a" }),
          withWorktree("b", { state: "kept", path: "/tmp/wt/r-b" }),
          withWorktree("c", { state: "pending" }, { worktreeFinal: { state: "committed", branch: "pi-agent-r-c" } }),
          withWorktree("d", { state: "pending" }),
        ],
      }),
    );
    expect(block).toBeDefined();
    expect(block).toContain("worktrees:");
    expect(block).toContain("a → pi-agent-r-a (expected branch pi-agent-r-a)");
    expect(block).toContain("b → kept /tmp/wt/r-b (expected branch pi-agent-r-b)");
    expect(block).toContain("c → pending→pi-agent-r-c (expected branch pi-agent-r-c)");
    expect(block).toContain("d → pending (expected branch pi-agent-r-d)");
  });

  it("caps at 64 lines / 8 KiB total, folding the rest into an '…N more' line pointing at git branch --list", () => {
    const children = Array.from({ length: 100 }, (_, i) =>
      withWorktree(`n${i}`, { state: "committed", branch: `pi-agent-r-n${i}` }),
    );
    const block = renderWorktreeBlock(fakeOutcome({ children }))!;
    const lines = block.split("\n");
    expect(lines[0]).toBe("worktrees:");
    const bodyLines = lines.slice(1, -1);
    expect(bodyLines.length).toBeLessThanOrEqual(64);
    expect(lines.at(-1)).toMatch(/^…\d+ more; git branch --list 'pi-agent-\*'$/);
    expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(8 * 1024); // header + tail included
  });

  it("the 8 KiB cap includes the header and the '…N more' tail even with long lines", () => {
    const children = Array.from({ length: 60 }, (_, i) =>
      withWorktree(`n${i}`, { state: "kept", path: `/tmp/${"x".repeat(250)}/${i}` }),
    );
    const block = renderWorktreeBlock(fakeOutcome({ children }))!;
    expect(block.split("\n").at(-1)).toMatch(/^…\d+ more; git branch --list 'pi-agent-\*'$/);
    expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(8 * 1024);
  });

  it("a single overlong line is truncated to WORKTREE_BLOCK_LINE_MAX_CHARS", () => {
    const block = renderWorktreeBlock(
      fakeOutcome({ children: [withWorktree("a", { state: "kept", path: "/" + "x".repeat(500) })] }),
    )!;
    const line = block.split("\n")[1]!;
    expect(line.length).toBeLessThanOrEqual(300);
    expect(line.endsWith("…")).toBe(true);
  });

  it("replay-verify plan D7/D11: a replayed committed hit renders `label → branch (replayed @sha7)`, never the expected-branch suffix", () => {
    const block = renderWorktreeBlock(
      fakeOutcome({
        children: [
          withWorktree(
            "a",
            { state: "committed", branch: "pi-agent-r-old", commit: "abc1234def5678900000000000000000000abcd" },
            { source: "replay", runId: undefined },
          ),
        ],
      }),
    );
    expect(block).toContain("a → pi-agent-r-old (replayed @abc1234)");
    expect(block).not.toContain("expected branch");
  });

  it("D4.4: a stale terminal recheck appends ', branch gone'/', branch moved' to the replay row", () => {
    const gone = renderWorktreeBlock(
      fakeOutcome({
        children: [
          withWorktree(
            "a",
            { state: "committed", branch: "pi-agent-r-old", commit: "abc1234def5678900000000000000000000abcd" },
            { source: "replay", runId: undefined, replayStale: "gone" },
          ),
        ],
      }),
    );
    expect(gone).toContain("(replayed @abc1234, branch gone)");
    const moved = renderWorktreeBlock(
      fakeOutcome({
        children: [
          withWorktree(
            "a",
            { state: "committed", branch: "pi-agent-r-old", commit: "abc1234def5678900000000000000000000abcd" },
            { source: "replay", runId: undefined, replayStale: "moved" },
          ),
        ],
      }),
    );
    expect(moved).toContain("(replayed @abc1234, branch moved)");
  });

  it("a replayed `clean` entry is never listed (same rule as a live clean call)", () => {
    expect(
      renderWorktreeBlock(
        fakeOutcome({
          children: [withWorktree("a", { state: "clean" }, { source: "replay", runId: undefined })],
        }),
      ),
    ).toBeUndefined();
  });
});

describe("formatWorkflowResultText/formatWorkflowNotification: the worktree block survives head/tail truncation", () => {
  it("formatWorkflowResultText places the worktree block OUTSIDE the truncated body, before the trailer", () => {
    const long = "x".repeat(5_000);
    const outcome = fakeOutcome({
      result: long,
      children: [
        {
          callId: "c1",
          runId: "r1",
          label: "a",
          source: "live",
          status: "completed",
          durationMs: 1,
          worktree: { state: "kept", path: "/tmp/wt/r1" },
        },
      ],
    });
    const { text } = formatWorkflowResultText(outcome, undefined, 500);
    expect(text).toMatch(/middle \d+ of \d+ chars omitted/); // body really was truncated
    expect(text).toContain("worktrees:\na → kept /tmp/wt/r1 (expected branch pi-agent-r1)");
    // trailer comes after the worktree block, worktree block comes after the (truncated) body.
    const bodyEnd = text.indexOf("chars omitted");
    const wtIdx = text.indexOf("worktrees:");
    const trailerIdx = text.indexOf("(duration:");
    expect(bodyEnd).toBeGreaterThan(-1);
    expect(wtIdx).toBeGreaterThan(bodyEnd);
    expect(trailerIdx).toBeGreaterThan(wtIdx);
  });

  it("formatWorkflowNotification places the worktree block OUTSIDE the truncated body, before the hint", () => {
    const long = "x".repeat(5_000);
    const outcome = fakeOutcome({
      result: long,
      children: [
        {
          callId: "c1",
          runId: "r1",
          label: "a",
          source: "live",
          status: "completed",
          durationMs: 1,
          worktree: { state: "committed", branch: "pi-agent-r1" },
        },
      ],
    });
    const body = formatWorkflowNotification({ workflowId: "wf_abc", name: "review-flow", outcome }, undefined, 500);
    expect(body).toContain("worktrees:\na → pi-agent-r1 (expected branch pi-agent-r1)");
    const wtIdx = body.indexOf("worktrees:");
    const hintIdx = body.indexOf("Re-read the full outcome");
    expect(wtIdx).toBeGreaterThan(-1);
    expect(hintIdx).toBeGreaterThan(wtIdx);
  });

  it("no worktree section is added when no child has a worktree entry (byte-identical to pre-D5)", () => {
    const outcome = fakeOutcome({
      result: "hi",
      children: [{ callId: "c1", source: "live", status: "completed", durationMs: 1 }],
    });
    const { text } = formatWorkflowResultText(outcome, undefined, 0);
    expect(text).not.toContain("worktrees:");
  });
});

describe("formatWorkflowNotification", () => {
  const settled = (outcome: WorkflowOutcome) => ({ workflowId: "wf_abc", name: "review-flow", outcome });

  it("carries id, name, status, stats with spend, the outcome text, and how to re-read it", () => {
    const body = formatWorkflowNotification(
      settled(
        fakeOutcome({
          workflowId: "wf_abc",
          result: "ALL GOOD",
          durationMs: 65_000,
          children: [{ callId: "c1", runId: "r_1", source: "live", status: "completed", durationMs: 5 }],
        }),
      ),
      { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.25 },
      0,
    );
    expect(body.split("\n")[0]).toBe(
      'Workflow "review-flow" (wf_abc) completed — completed · 1m05s · 1 children (✓1) · $0.25',
    );
    expect(body).toContain("result: ALL GOOD");
    expect(body).toContain('get_subagent_result(run_id: "wf_abc")');
  });

  it("caps the outcome text by resultMaxChars (control: 0 = no cap)", () => {
    const long = "x".repeat(5_000);
    const capped = formatWorkflowNotification(settled(fakeOutcome({ result: long })), undefined, 500);
    expect(capped).toMatch(/middle \d+ of \d+ chars omitted/);
    expect(capped.length).toBeLessThan(1_500);
    const uncapped = formatWorkflowNotification(settled(fakeOutcome({ result: long })), undefined, 0);
    expect(uncapped).toContain(long);
  });

  it("states a non-completed status and its cause in the header", () => {
    const body = formatWorkflowNotification(
      settled(fakeOutcome({ status: "aborted", stopCause: "user_stop" })),
      undefined,
      0,
    );
    expect(body.split("\n")[0]).toMatch(/^Workflow "review-flow" \(wf_abc\) aborted — aborted/);
    expect(body).toContain("aborted (user_stop)");
  });
});

describe("SubagentWorkflow tool: grace & extension (workflow-agent-queue §4.1, stage B)", () => {
  function recordingRuns() {
    const started: WorkflowRunBudget[] = [];
    const runs = {
      start: (req: { budget: WorkflowRunBudget; name: string }) => {
        started.push(req.budget);
        return { workflowId: "wf_0123456789abcdef0123", name: req.name, startedAt: 0, status: "running" as const };
      },
    };
    return { runs, started };
  }
  const script = 'export const meta = { name: "g", description: "t" };\nreturn 1;';
  const EXTENDABLE: WorkflowRunBudget = { ...REAL_BUDGET, totalGraceMs: 90_000, maxExtensions: 3, maxTotalFactor: 2 };

  it("default budget: started text names the hard ceiling it can be extended to; the budget keeps its factor", async () => {
    const { runs, started } = recordingRuns();
    const tool = createWorkflowTool({ defaultBudget: EXTENDABLE, runs });
    const body = text(await tool.execute("c", { script }, undefined));
    expect(body).toContain("budget: 20s (extendable up to 40s)");
    expect(started[0]!.maxTotalFactor).toBe(2);
  });

  it("explicit timeout_s: hard cap (factor 1), no extendable suffix", async () => {
    const { runs, started } = recordingRuns();
    const tool = createWorkflowTool({ defaultBudget: EXTENDABLE, runs });
    const body = text(await tool.execute("c", { script, timeout_s: 30 }, undefined));
    expect(body).toContain("budget: 30s)");
    expect(body).not.toContain("extendable");
    expect(started[0]).toMatchObject({ workflowTotalMs: 30_000, maxTotalFactor: 1 });
  });

  it("the description tells the model about the grace notice, extend_subagent_timeout and the timeout_s hard cap", () => {
    const tool = createWorkflowTool({ defaultBudget: EXTENDABLE, runs: recordingRuns().runs });
    expect(tool.description).toContain("extend_subagent_timeout(run_id: <workflow id>, extend_s)");
    expect(tool.description).toMatch(/explicit timeout_s is a hard cap/);
  });
});
