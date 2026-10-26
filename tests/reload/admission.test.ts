import { describe, expect, it, vi } from "vitest";
import type { QueryService } from "../../src/service/query-service.js";
import type { SpawnService } from "../../src/service/spawn-service.js";
import { createAgentTool, type NestedSpawnPort } from "../../src/tools/agent-tool.js";
import { createWorkflowTool } from "../../src/tools/workflow-tool.js";
import { createResultTool } from "../../src/tools/result-tool.js";
import { createSteerTool } from "../../src/tools/steer-tool.js";
import { createAbortTool } from "../../src/tools/abort-tool.js";
import { createWorkflowChildSpawner } from "../../src/workflow/spawner-adapter.js";
import { DeferredReloadController } from "../../src/reload/defer.js";
import type { WorkflowRunBudget } from "../../src/workflow/types.js";

const params = { description: "test dispatch", prompt: "work", subagent_type: "general-purpose" };
const budget: WorkflowRunBudget = {
  scriptLoadMs: 1_000,
  scriptSliceMs: 1_000,
  workerBootMs: 1_000,
  heartbeatMs: 0,
  heartbeatStallMs: 5_000,
  terminateConfirmMs: 100,
  workflowTotalMs: 10_000,
  runawayPolicy: "diagnose_only",
};

function setup() {
  const fire = vi.fn();
  const ctl = new DeferredReloadController({ fire });
  const spawn = vi.fn(async () => ({ runId: "r_TEST" }));
  const spawnAndWait = vi.fn(async () => ({
    runId: "r_CHILD",
    status: "completed",
    text: "child done",
    turns: 1,
    durationMs: 1,
    diag: {},
  }));
  const port = { spawn, spawnAndWait } as unknown as NestedSpawnPort;
  const start = vi.fn(() => ({ workflowId: "wf_TEST" }));
  const isReloadPending = () => ctl.pending;
  const agent = createAgentTool({ spawn: port, isReloadPending });
  const workflow = createWorkflowTool({ defaultBudget: budget, runs: { start } as never, isReloadPending });
  return { ctl, port, spawn, spawnAndWait, start, agent, workflow, fire };
}

describe("main-session reload admission", () => {
  it.each([false, true])(
    "rejects Agent (resume=%s) as an error result without spawning or throwing",
    async (resume) => {
      const h = setup();
      h.ctl.arm(1);
      const result = await h.agent.execute(
        "tc",
        { ...params, ...(resume ? { resume: "r_OLD" } : {}) },
        undefined,
        undefined,
        {} as never,
      );
      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({ error: { code: "E_RELOAD_PENDING", kind: "config", retryable: true } });
      expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("收到继续通知后再派发") });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining("/agent reload cancel") });
      expect(h.spawn).not.toHaveBeenCalled();
      expect(h.spawnAndWait).not.toHaveBeenCalled();
    },
  );

  it("rejects SubagentWorkflow before reading its budget, parsing a script or starting a worker", async () => {
    const h = setup();
    h.ctl.arm(1);
    const readBudget = vi.fn(() => {
      throw new Error("budget should not be read");
    });
    const tool = createWorkflowTool({
      isReloadPending: () => h.ctl.pending,
      get defaultBudget() {
        return readBudget();
      },
      runs: { start: h.start } as never,
    });
    const result = await tool.execute("tc", { script: "invalid" }, undefined, undefined, {} as never);
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ error: { code: "E_RELOAD_PENDING" } });
    expect(h.start).not.toHaveBeenCalled();
    expect(readBudget).not.toHaveBeenCalled();
  });

  it("continues blocking during queued fire, then allows fresh and resume calls after cancellation", async () => {
    const h = setup();
    h.ctl.arm(1);
    h.ctl.handleRunSettled(0);
    expect(h.fire).toHaveBeenCalledTimes(1);
    const denied = await h.agent.execute("tc", params, undefined, undefined, {} as never);
    expect(denied.isError).toBe(true);
    expect(h.spawn).not.toHaveBeenCalled();
    h.ctl.disarm();
    for (const resume of [undefined, "r_OLD"]) {
      const result = await h.agent.execute(
        "tc",
        { ...params, ...(resume ? { resume } : {}) },
        undefined,
        undefined,
        {} as never,
      );
      expect(result.isError).not.toBe(true);
      expect(result.details).toMatchObject({ runId: "r_TEST" });
    }
    const wf = await h.workflow.execute(
      "tc",
      { script: "export const meta={name:'x',description:'y'}; return 1;" },
      undefined,
      undefined,
      {} as never,
    );
    expect(wf.isError).not.toBe(true);
    expect(wf.details).toMatchObject({ workflowId: "wf_TEST", status: "running" });
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("does not block nested Agent (background=%s)", async (background) => {
    const h = setup();
    h.ctl.arm(1);
    const nested = createAgentTool({ spawn: h.port, allowedTypes: [params.subagent_type], parentRunId: "r_PARENT" });
    const result = await nested.execute(
      "tc",
      { ...params, run_in_background: background },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.isError).not.toBe(true);
    expect(background ? h.spawn : h.spawnAndWait).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({ runId: background ? "r_TEST" : "r_CHILD" });
  });

  it("does not gate an existing workflow's internal agent() spawn adapter", async () => {
    const h = setup();
    h.ctl.arm(1);
    const children = createWorkflowChildSpawner(h.port as SpawnService, {} as never);
    const result = await children.spawn({ type: params.subagent_type, prompt: "existing workflow child" });
    expect(result).toEqual({ runId: "r_TEST" });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.spawn.mock.calls[0]).toEqual([
      expect.objectContaining({ prompt: "existing workflow child", callerOwned: true }),
    ]);
  });

  it("does not block result reads, steer or abort of running work", async () => {
    const h = setup();
    h.ctl.arm(1);
    const get = vi.fn(() => ({
      runId: "r_RUNNING",
      status: "running",
      phase: "prompt",
      updatedAt: 1,
      diag: { createdAt: 0, turns: 0 },
    }));
    const steer = vi.fn(async () => ({ ok: true }));
    const stop = vi.fn(async () => ({ ok: true }));
    const query = { get, steer, stop } as unknown as QueryService;
    const result = await createResultTool({ query }).execute(
      "tc",
      { run_id: "r_RUNNING" },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("still running") });
    const steered = await createSteerTool({ query }).execute(
      "tc",
      { run_id: "r_RUNNING", text: "keep working" },
      undefined,
      undefined,
      {} as never,
    );
    expect(steered.content[0]).toMatchObject({ text: expect.stringContaining("Sent follow-up instruction") });
    const aborted = await createAbortTool({ query }).execute(
      "tc",
      { run_id: "r_RUNNING" },
      undefined,
      undefined,
      {} as never,
    );
    expect(aborted.content[0]).toMatchObject({ text: expect.stringContaining("Abort requested") });
    expect(get).toHaveBeenCalled();
    expect(steer).toHaveBeenCalledWith("r_RUNNING", "keep working");
    expect(stop).toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });
});
