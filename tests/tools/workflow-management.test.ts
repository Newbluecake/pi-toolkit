import { describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import type { RunSnapshot, UsageDelta } from "../../src/core/types.js";
import type { QueryService } from "../../src/service/query-service.js";
import { createAbortTool } from "../../src/tools/abort-tool.js";
import { createResultTool } from "../../src/tools/result-tool.js";
import type { WorkflowQueryPort } from "../../src/tools/workflow-target.js";
import { createWorkflowActivityRegistry } from "../../src/workflow/activity.js";
import { createBackgroundWorkflows, type BackgroundWorkflows } from "../../src/workflow/background.js";
import type { Orchestrator } from "../../src/workflow/orchestrator.js";
import type { WorkflowOutcome, WorkflowRunBudget } from "../../src/workflow/types.js";

/**
 * get_subagent_result / abort_subagent accept a background workflow id
 * (docs/dev/workflow-background/plan.md §2.3): resolution, running progress,
 * terminal outcome, bounded wait + anti-polling, abort idempotency, and
 * usage accounting that never double-counts a child run.
 */

const BUDGET: WorkflowRunBudget = {
  scriptLoadMs: 1_000,
  scriptSliceMs: 1_000,
  workerBootMs: 1_000,
  heartbeatMs: 0,
  heartbeatStallMs: 60_000,
  terminateConfirmMs: 10,
  workflowTotalMs: 60_000,
  runawayPolicy: "diagnose_only",
  abortGraceMs: 10,
  reconcileMs: 10,
};

const childUsage: Record<string, UsageDelta> = {
  r_CHILD001: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.1 },
  r_CHILD002: { input: 20, output: 7, cacheRead: 1, cacheWrite: 0, costUsd: 0.2 },
};

function outcome(overrides: Partial<WorkflowOutcome> = {}): WorkflowOutcome {
  return {
    workflowId: "wf_x",
    status: "completed",
    pendingReconcile: false,
    durationMs: 65_000,
    result: "FINAL-ANSWER",
    children: [
      { callId: "c1", runId: "r_CHILD001", label: "a", source: "live", status: "completed", durationMs: 1 },
      { callId: "c2", runId: "r_CHILD002", label: "b", source: "live", status: "completed", durationMs: 1 },
      { callId: "c3", label: "cached", source: "replay", status: "completed", durationMs: 0 },
    ],
    diag: { createdAt: 0, heartbeat: { seq: 0, observedAt: 0, stalledMs: 0 }, logLines: 0 },
    ...overrides,
  };
}

function harness() {
  const releases: ((o: WorkflowOutcome) => void)[] = [];
  const stops: string[] = [];
  const activity = createWorkflowActivityRegistry();
  let n = 0;
  const runs: BackgroundWorkflows = createBackgroundWorkflows({
    clock: systemClock,
    activity,
    newId: () => `wf_mgmt${++n}_abcdef`,
    createOrchestrator: (): Orchestrator => {
      let release!: (o: WorkflowOutcome) => void;
      const runP = new Promise<WorkflowOutcome>((resolve) => (release = resolve));
      releases.push(release);
      return {
        run: () => runP,
        stop: async (_id, cause) => {
          stops.push(cause);
          release(outcome({ status: "aborted", stopCause: cause, result: undefined }));
          return { ok: true };
        },
        outcomeAt1: () => undefined,
        settled: () => runP,
      };
    },
  });
  const workflows: WorkflowQueryPort = {
    resolve: (h) => runs.resolve(h),
    resolveLabel: (h) => runs.resolveLabel(h),
    get: (id) => runs.get(id),
    wait: (id, o) => runs.wait(id, o),
    stop: (id, c, o) => runs.stop(id, c, o),
    activity: (id) => activity.list().find((w) => w.workflowId === id),
    usageOf: (runId) => childUsage[runId],
  };
  const childSnapshot = (runId: string): RunSnapshot =>
    ({
      runId,
      generation: 1,
      status: "completed",
      phase: "settled",
      deadlines: { enqueuedAt: 0 },
      diag: { usage: childUsage[runId], generation: 1 },
      outcome: {
        runId,
        status: "completed",
        text: "child text",
        turns: 1,
        durationMs: 5,
        usage: childUsage[runId],
        diag: {},
      },
      updatedAt: 0,
    }) as unknown as RunSnapshot;
  const query = {
    get: (runId: string) => (runId in childUsage ? childSnapshot(runId) : undefined),
    stop: async () => ({ ok: false, reason: "unknown_run" }),
    wait: async () => ({ ok: false, reason: "unknown_run" }),
  } as unknown as QueryService;
  const resolveRun = (handle: string) =>
    handle in childUsage
      ? ({ ok: true, runId: handle } as const)
      : ({ ok: false, error: `run target not found: ${handle}`, candidates: [] } as const);
  const start = (name = "review-flow") =>
    runs.start({ script: "export const meta={name:'x',description:'y'};\nreturn 1;", name, budget: BUDGET });
  return { runs, workflows, query, resolveRun, releases, stops, start };
}

const exec = (tool: { execute: (...a: never[]) => unknown }, params: Record<string, unknown>) =>
  (tool.execute as (...a: unknown[]) => Promise<{ content: { text: string }[]; details: any; usage?: any }>)(
    "tc",
    params,
    undefined,
    undefined,
    {},
  );

describe("get_subagent_result with a workflow id", () => {
  it("running: returns progress (not an error) and warns on a polling loop", async () => {
    const h = harness();
    const wf = h.start();
    const tool = createResultTool({ query: h.query, resolveRun: h.resolveRun, workflows: h.workflows });
    const first = await exec(tool, { run_id: wf.workflowId });
    expect(first.content[0]!.text).toMatch(
      new RegExp(`^Workflow ${wf.workflowId} \\("review-flow"\\) is still running\\.`),
    );
    expect(first.content[0]!.text).toContain("⏳ review-flow"); // buildWorkflowProgressLines header
    expect(first.details).toMatchObject({ workflowId: wf.workflowId, status: "running" });
    expect(first.usage).toBeUndefined();
    await exec(tool, { run_id: wf.workflowId });
    await exec(tool, { run_id: wf.workflowId });
    const fourth = await exec(tool, { run_id: wf.workflowId });
    expect(fourth.content[0]!.text).toMatch(/Polling too frequently/);
  });

  it("terminal: renders the outcome + trailer, attaches the children's spend exactly once", async () => {
    const h = harness();
    const wf = h.start();
    h.releases[0]!(outcome({ workflowId: wf.workflowId }));
    await h.runs.wait(wf.workflowId, { waitMs: 1_000 });
    const tool = createResultTool({ query: h.query, resolveRun: h.resolveRun, workflows: h.workflows });
    const first = await exec(tool, { run_id: wf.workflowId });
    const body = first.content[0]!.text;
    expect(body).toContain(`workflow ${wf.workflowId}: completed`);
    expect(body).toContain("result: FINAL-ANSWER");
    expect(body).toMatch(/\(duration: 1m05s · children: 3 · usage: in:30 out:12 cache_r:1 cache_w:0 cost:\$0\.3000\)$/);
    expect(first.usage?.cost?.total).toBeCloseTo(0.3);
    expect(first.details).toMatchObject({
      workflowId: wf.workflowId,
      label: "review-flow",
      status: "completed",
      runIds: ["r_CHILD001", "r_CHILD002"],
    });
    expect(first.details.summary).toContain("3 children");
    // Re-reads never re-attach usage…
    const second = await exec(tool, { run_id: wf.workflowId });
    expect(second.usage).toBeUndefined();
    expect(second.details.costUsd).toBeCloseTo(0.3); // …but still display the spend.
    // …and neither does reading a child run the workflow already accounted for.
    const child = await exec(tool, { run_id: "r_CHILD001" });
    expect(child.usage).toBeUndefined();
  });

  it("a child read individually first is excluded from the workflow's aggregate (control for the dedupe)", async () => {
    const h = harness();
    const wf = h.start();
    h.releases[0]!(outcome({ workflowId: wf.workflowId }));
    await h.runs.wait(wf.workflowId, { waitMs: 1_000 });
    const tool = createResultTool({ query: h.query, resolveRun: h.resolveRun, workflows: h.workflows });
    const child = await exec(tool, { run_id: "r_CHILD001" });
    expect(child.usage?.cost?.total).toBeCloseTo(0.1);
    const wfRead = await exec(tool, { run_id: wf.workflowId });
    expect(wfRead.usage?.cost?.total).toBeCloseTo(0.2); // only r_CHILD002 left to account
  });

  it("a seeded (post-reload) entry whose children are gone falls back to the usage captured at settle", async () => {
    const h = harness();
    h.runs.seedTerminal({
      workflowId: "wf_seeded",
      name: "old-flow",
      startedAt: 0,
      status: "completed",
      outcome: outcome({
        workflowId: "wf_seeded",
        children: [{ callId: "c9", runId: "r_GONE0000", source: "live", status: "completed", durationMs: 1 }],
      }),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.42 },
    });
    const tool = createResultTool({ query: h.query, resolveRun: h.resolveRun, workflows: h.workflows });
    const read = await exec(tool, { run_id: "wf_seeded" });
    expect(read.usage?.cost?.total).toBeCloseTo(0.42);
    expect((await exec(tool, { run_id: "wf_seeded" })).usage).toBeUndefined();
  });

  it("resultMaxChars caps the outcome text", async () => {
    const h = harness();
    const wf = h.start();
    h.releases[0]!(outcome({ workflowId: wf.workflowId, result: "y".repeat(5_000) }));
    await h.runs.wait(wf.workflowId, { waitMs: 1_000 });
    const tool = createResultTool({
      query: h.query,
      resolveRun: h.resolveRun,
      workflows: h.workflows,
      resultMaxChars: () => 400,
    });
    const read = await exec(tool, { run_id: wf.workflowId });
    expect(read.content[0]!.text).toMatch(/chars omitted/);
    expect(read.details).toMatchObject({ truncated: true });
  });

  it("wait: resolves once the workflow settles; a timeout throws workflow-worded guidance that escalates", async () => {
    const h = harness();
    const wf = h.start();
    const tool = createResultTool({ query: h.query, resolveRun: h.resolveRun, workflows: h.workflows });
    await expect(exec(tool, { run_id: wf.workflowId, wait: true, wait_ms: 20 })).rejects.toThrow(
      new RegExp(`workflow ${wf.workflowId} is still going.*workflow's completion notification`),
    );
    await expect(exec(tool, { run_id: wf.workflowId, wait: true, wait_ms: 20 })).rejects.toThrow(
      /2 consecutive timeouts on this workflow/,
    );
    const pending = exec(tool, { run_id: wf.workflowId, wait: true, wait_ms: 5_000 });
    setTimeout(() => h.releases[0]!(outcome({ workflowId: wf.workflowId })), 20);
    const done = await pending;
    expect(done.details).toMatchObject({ workflowId: wf.workflowId, status: "completed" });
    expect(done.usage?.cost?.total).toBeCloseTo(0.3);
  });

  it("resolves a unique id prefix and the workflow's script name; run ids still take the run path", async () => {
    const h = harness();
    const wf = h.start("unique-name");
    const tool = createResultTool({ query: h.query, resolveRun: h.resolveRun, workflows: h.workflows });
    expect((await exec(tool, { run_id: wf.workflowId.slice(0, 8) })).details.workflowId).toBe(wf.workflowId);
    expect((await exec(tool, { run_id: "unique-name" })).details.workflowId).toBe(wf.workflowId);
    const run = await exec(tool, { run_id: "r_CHILD002" });
    expect(run.details.runId).toBe("r_CHILD002");
    expect(run.details.workflowId).toBeUndefined();
  });

  it("an unknown wf_ id throws a workflow-specific error; an unknown plain handle keeps the run resolver's error", async () => {
    const h = harness();
    const tool = createResultTool({ query: h.query, resolveRun: h.resolveRun, workflows: h.workflows });
    await expect(exec(tool, { run_id: "wf_missing" })).rejects.toThrow(/unknown workflow id: wf_missing/);
    await expect(exec(tool, { run_id: "nothing" })).rejects.toThrow(/run target not found: nothing/);
  });
});

describe("abort_subagent with a workflow id", () => {
  it("stops the workflow (all children) and reports the terminal state; a repeat is already-finished, not an error", async () => {
    const h = harness();
    const wf = h.start();
    const tool = createAbortTool({ query: h.query, resolveRun: h.resolveRun, workflows: h.workflows });
    const first = await exec(tool, { run_id: wf.workflowId, reason: "changed plan" });
    expect(h.stops).toEqual(["user_stop"]);
    expect(first.content[0]!.text).toMatch(
      new RegExp(`Workflow ${wf.workflowId} \\("review-flow"\\) stopped: aborted \\(user_stop\\)`),
    );
    expect(first.details).toMatchObject({ workflowId: wf.workflowId, ok: true, settled: true, status: "aborted" });
    const second = await exec(tool, { run_id: wf.workflowId });
    expect(second.content[0]!.text).toMatch(/already reached a terminal state \("aborted"\)/);
    expect(second.details).toMatchObject({ alreadyTerminal: true });
    expect(h.stops).toEqual(["user_stop"]);
  });

  it("accepts a unique prefix and the script name; a finished workflow is reported, never re-stopped", async () => {
    const h = harness();
    const a = h.start("flow-a");
    const tool = createAbortTool({ query: h.query, resolveRun: h.resolveRun, workflows: h.workflows });
    await exec(tool, { run_id: "flow-a" });
    expect(h.runs.get(a.workflowId)?.status).toBe("aborted");
    const b = h.start("flow-b");
    h.releases[1]!(outcome({ workflowId: b.workflowId }));
    await h.runs.wait(b.workflowId, { waitMs: 1_000 });
    const r = await exec(tool, { run_id: b.workflowId.slice(0, 9) });
    expect(r.details).toMatchObject({ workflowId: b.workflowId, alreadyTerminal: true, status: "completed" });
    expect(h.stops).toEqual(["user_stop"]);
  });

  it("run ids keep going to QueryService.stop (control)", async () => {
    const h = harness();
    const stopped: string[] = [];
    const query = {
      stop: async (id: string) => (stopped.push(id), { ok: true, escalatedTo: "L1" }),
    } as unknown as QueryService;
    const tool = createAbortTool({ query, resolveRun: h.resolveRun, workflows: h.workflows });
    await exec(tool, { run_id: "r_CHILD001" });
    expect(stopped).toEqual(["r_CHILD001"]);
    expect(h.stops).toEqual([]);
  });
});

describe("model-facing descriptions mention workflow ids", () => {
  it("get_subagent_result and abort_subagent document wf_ ids in the tool and parameter text", () => {
    const h = harness();
    for (const tool of [
      createResultTool({ query: h.query, workflows: h.workflows }),
      createAbortTool({ query: h.query, workflows: h.workflows }),
    ]) {
      expect(tool.description).toMatch(/SubagentWorkflow/);
      expect(tool.description).toContain("wf_");
      expect(JSON.stringify(tool.parameters)).toContain("wf_");
    }
  });
});
