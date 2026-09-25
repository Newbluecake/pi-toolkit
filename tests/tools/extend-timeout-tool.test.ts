import { describe, expect, it, vi } from "vitest";
import type { Text } from "@earendil-works/pi-tui";
import { createExtendTimeoutTool, ExtendTimeoutParams } from "../../src/tools/extend-timeout-tool.js";
import type { ExtendOutcome, RunSnapshot } from "../../src/core/types.js";
import type { QueryService } from "../../src/service/query-service.js";
import type { WorkflowQueryPort } from "../../src/tools/workflow-target.js";
import type { BackgroundWorkflowView } from "../../src/workflow/background.js";
import type { WorkflowExtendOutcome } from "../../src/workflow/deadline.js";

const theme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text } as never;
const ctx = (lastComponent?: unknown) => ({ lastComponent, state: {} }) as never;

function snapshot(overrides: {
  runId?: string;
  status?: RunSnapshot["status"];
  deadlineAt?: number;
  hardDeadlineAt?: number;
  enqueuedAt?: number;
  extensions?: number;
}): RunSnapshot {
  return {
    runId: overrides.runId ?? "r-abcdef123456",
    generation: 1,
    status: overrides.status ?? "running",
    phase: "tool_exec",
    deadlines: {
      enqueuedAt: overrides.enqueuedAt ?? 0,
      deadlineAt: overrides.deadlineAt,
      queueDeadlineAt: undefined,
      ...(overrides.hardDeadlineAt === undefined ? {} : { hardDeadlineAt: overrides.hardDeadlineAt }),
    },
    diag: {
      createdAt: 0,
      phase: "tool_exec",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 0,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      ...(overrides.extensions === undefined
        ? {}
        : { overtime: { graces: 0, extensions: overrides.extensions, grantedMs: 0 } }),
    },
    updatedAt: 0,
  };
}

type FakeQuery = Pick<QueryService, "extendTimeout" | "get"> & {
  extendTimeout: ReturnType<typeof vi.fn>;
};

function setup(outcome: ExtendOutcome, snap?: RunSnapshot) {
  const query: FakeQuery = {
    extendTimeout: vi.fn(() => outcome),
    get: vi.fn(() => snap),
  };
  const tool = createExtendTimeoutTool({ query, now: () => NOW });
  return { query, tool };
}

const NOW = 10_000;
const RUN_ID = "r-abcdef123456";

function okOutcome(overrides: Partial<ExtendOutcome & { ok: true }> = {}): ExtendOutcome {
  return {
    ok: true,
    runId: RUN_ID,
    previousDeadlineAt: 600_000,
    deadlineAt: 610_000, // NOW + 600s → "New deadline in 10m00s"
    requestedMs: 600_000,
    grantedMs: 600_000,
    clamped: false,
    extensionsUsed: 1,
    extensionsRemaining: 2,
    hardDeadlineAt: 1_210_000, // 600s above the new deadline
    rescuedFromGrace: false,
    ...overrides,
  };
}

async function executeText(tool: ReturnType<typeof createExtendTimeoutTool>, params: Record<string, unknown>) {
  const result = await tool.execute("tc1", params as never);
  return (result.content[0] as { text: string }).text;
}

async function executeError(tool: ReturnType<typeof createExtendTimeoutTool>, params: Record<string, unknown>) {
  try {
    await tool.execute("tc1", params as never);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected execute to throw");
}

describe("tools/extend-timeout-tool: schema", () => {
  it("extend_s is an integer in seconds with minimum 1; run_id documents label acceptance", () => {
    const props = ExtendTimeoutParams.properties;
    expect(props.extend_s.type).toBe("integer");
    expect(props.extend_s.minimum).toBe(1);
    expect(props.extend_s.description).toMatch(/seconds/);
    expect(props.run_id.description).toContain("label");
  });
});

describe("tools/extend-timeout-tool: execute happy path", () => {
  it("passes extend_s * 1000 (seconds → milliseconds) and the tool source to query.extendTimeout", async () => {
    const { query, tool } = setup(okOutcome());
    await executeText(tool, { run_id: RUN_ID, extend_s: 600, reason: "needs the full test suite" });
    expect(query.extendTimeout).toHaveBeenCalledWith(RUN_ID, 600_000, {
      source: "tool",
      reason: "needs the full test suite",
    });
  });

  it("success text reports granted/requested/remaining/ceiling with relative durations", async () => {
    const { tool } = setup(okOutcome());
    const text = await executeText(tool, { run_id: RUN_ID, extend_s: 600 });
    expect(text).toContain(`Extended run ${RUN_ID.slice(0, 8)} by 10m00s`);
    expect(text).toContain("requested 10m00s");
    expect(text).not.toContain("clamped");
    expect(text).toContain("New deadline in 10m00s");
    expect(text).toContain("2 of 3 extensions left");
    expect(text).toContain("at most 10m00s more available");
    expect(text).not.toContain("grace window");
  });

  it("a clamped grant says so explicitly", async () => {
    const { tool } = setup(
      okOutcome({ grantedMs: 120_000, clamped: true, deadlineAt: 130_000, hardDeadlineAt: 130_000 }),
    );
    const text = await executeText(tool, { run_id: RUN_ID, extend_s: 600 });
    expect(text).toContain("by 2m00s");
    expect(text).toContain("requested 10m00s, clamped by its hard ceiling");
    expect(text).toContain("at most 0ms more available");
  });

  it("a rescue from grace is called out", async () => {
    const { tool } = setup(okOutcome({ rescuedFromGrace: true }));
    const text = await executeText(tool, { run_id: RUN_ID, extend_s: 600 });
    expect(text).toContain("inside its timeout grace window and is now back to normal execution");
  });

  it("details carry the raw ExtendOutcome", async () => {
    const outcome = okOutcome();
    const { tool } = setup(outcome);
    const result = await tool.execute("tc1", { run_id: RUN_ID, extend_s: 600 } as never);
    expect(result.details).toBe(outcome);
  });

  it("defensive: a queued run that somehow succeeded is told its queue-wait timeout is unaffected", async () => {
    const { tool } = setup(okOutcome(), snapshot({ status: "queued" }));
    const text = await executeText(tool, { run_id: RUN_ID, extend_s: 600 });
    expect(text).toContain("this run has not started yet; its queue-wait timeout is unaffected.");
  });
});

describe("tools/extend-timeout-tool: resolveRun", () => {
  it("resolves prefixes/labels through resolveRun before calling the query", async () => {
    const { query, tool } = setup(okOutcome());
    const withResolver = createExtendTimeoutTool({
      query,
      resolveRun: (handle) =>
        handle === "reviewer" ? { ok: true, runId: RUN_ID } : { ok: false, error: "no such run", candidates: [] },
    });
    await executeText(withResolver, { run_id: "reviewer", extend_s: 60 });
    expect(query.extendTimeout).toHaveBeenCalledWith(RUN_ID, 60_000, { source: "tool" });
    void tool;
  });

  it("a failed resolution throws the resolver's error (with candidates) untouched", async () => {
    const { query } = setup(okOutcome());
    const tool = createExtendTimeoutTool({
      query,
      resolveRun: () => ({ ok: false, error: "ambiguous handle, candidates: a, b", candidates: [] }),
    });
    const message = await executeError(tool, { run_id: "rev", extend_s: 60 });
    expect(message).toBe("ambiguous handle, candidates: a, b");
  });
});

describe("tools/extend-timeout-tool: rejection matrix (arch §4.4 — every refusal says what to do next)", () => {
  const rejected = (reason: string): ExtendOutcome => ({ ok: false, reason: reason as never });

  it("unknown_run → list runs and retry", async () => {
    const { tool } = setup(rejected("unknown_run"));
    const message = await executeError(tool, { run_id: "nope", extend_s: 60 });
    expect(message).toContain("unknown run");
    expect(message).toContain("/agent status"); // next step
  });

  it("unsupported → this build cannot extend; fall back to respawn", async () => {
    const { tool } = setup(rejected("unsupported"), snapshot({}));
    const message = await executeError(tool, { run_id: RUN_ID, extend_s: 60 });
    expect(message).toContain("this build cannot extend run deadlines");
    expect(message).toContain("respawn"); // next step
  });

  it("not_started → extend only once executing; check with get_subagent_result", async () => {
    const { tool } = setup(rejected("not_started"), snapshot({ status: "queued" }));
    const message = await executeError(tool, { run_id: RUN_ID, extend_s: 60 });
    expect(message).toContain("has not started running yet (queued)");
    expect(message).toContain("extend after it starts"); // next step
    expect(message).toContain(`get_subagent_result(run_id: "${RUN_ID.slice(0, 8)}")`);
  });

  it("stopping → cannot bring it back; collect the terminal outcome", async () => {
    const { tool } = setup(rejected("stopping"), snapshot({ status: "stopping" }));
    const message = await executeError(tool, { run_id: RUN_ID, extend_s: 60 });
    expect(message).toContain("already shutting down");
    expect(message).toContain("would not bring it back");
    expect(message).toContain("get_subagent_result"); // next step
  });

  it("already_terminal → read the output instead", async () => {
    const { tool } = setup(rejected("already_terminal"), snapshot({ status: "completed" }));
    const message = await executeError(tool, { run_id: RUN_ID, extend_s: 60 });
    expect(message).toContain("already finished (completed)");
    expect(message).toContain("to read its output"); // next step
  });

  it("uncapped → nothing to extend", async () => {
    const { tool } = setup(rejected("uncapped"), snapshot({}));
    const message = await executeError(tool, { run_id: RUN_ID, extend_s: 60 });
    expect(message).toContain("has no time cap configured; there is nothing to extend");
  });

  it("limit_reached → remaining time + read-so-far / respawn exits", async () => {
    const { tool } = setup(
      rejected("limit_reached"),
      snapshot({ deadlineAt: NOW + 42_000, hardDeadlineAt: 600_000, extensions: 3 }),
    );
    const message = await executeError(tool, { run_id: RUN_ID, extend_s: 60 });
    expect(message).toContain("has already used all 3 deadline extensions");
    expect(message).toContain("It will stop at its current deadline (in 42s)");
    expect(message).toContain("get_subagent_result"); // next step ①
    expect(message).toContain("abort_subagent and respawn with a larger timeout_s"); // next step ②
  });

  it("no_headroom with an explicit timeout (hardDeadlineAt === deadlineAt, no extensions) → hard-cap variant", async () => {
    const { tool } = setup(
      rejected("no_headroom"),
      snapshot({ deadlineAt: NOW + 42_000, hardDeadlineAt: NOW + 42_000 }), // H === deadlineAt, extensions 0
    );
    const message = await executeError(tool, { run_id: RUN_ID, extend_s: 60 });
    expect(message).toContain("spawned with an explicit timeout, which is a hard cap");
    expect(message).toContain("it stops at its deadline (in 42s) and cannot be extended");
    expect(message).toContain("get_subagent_result"); // next step ①
    expect(message).toContain("respawn with a larger timeout_s"); // next step ②
  });

  it("no_headroom after extensions (at the ceiling) → ceiling variant", async () => {
    const { tool } = setup(
      rejected("no_headroom"),
      snapshot({ enqueuedAt: 0, deadlineAt: 3_600_000, hardDeadlineAt: 3_600_000, extensions: 2 }),
    );
    const message = await executeError(tool, { run_id: RUN_ID, extend_s: 60 });
    expect(message).toContain("is at its hard ceiling (1h00m from start); no further extension is possible");
    expect(message).toContain("get_subagent_result"); // next step
  });
});

describe("tools/extend-timeout-tool: renderCall (TUI call card)", () => {
  it("renders the title plus a gray +amount · reason preview", () => {
    const { tool } = setup(okOutcome());
    const comp = tool.renderCall!(
      { run_id: "r9", extend_s: 600, reason: "needs the full test suite" },
      theme,
      ctx(),
    ) as Text;
    const out = comp.render(120).join("\n");
    expect(out).toContain("Extend Subagent Timeout: r9");
    expect(out).toContain("+10m00s · needs the full test suite");
  });

  it("clips long reason previews and tolerates partial streaming args", () => {
    const { tool } = setup(okOutcome());
    const long = "x".repeat(200);
    const clipped = (tool.renderCall!({ run_id: "r9", extend_s: 30, reason: long }, theme, ctx()) as Text)
      .render(300)
      .join("\n");
    expect(clipped).toContain("+30s");
    expect(clipped).toContain("…");
    expect(clipped).not.toContain("x".repeat(100));
    const streaming = (tool.renderCall!({}, theme, ctx()) as Text).render(120).join("\n");
    expect(streaming).toContain("Extend Subagent Timeout:");
  });
});

// ── workflow-agent-queue §4.5 (stage B): wf_… targets ────────────────────────

const WF = "wf_0123456789abcdef0123";

function workflowView(overrides: Partial<BackgroundWorkflowView> = {}): BackgroundWorkflowView {
  return {
    workflowId: WF,
    name: "review-flow",
    startedAt: 0,
    deadlineAt: 70_000, // NOW + 60s
    hardDeadlineAt: 130_000,
    status: "running",
    ...overrides,
  };
}

function workflowSetup(outcome: WorkflowExtendOutcome, view: BackgroundWorkflowView | undefined = workflowView()) {
  const extend = vi.fn(() => outcome);
  const workflows: WorkflowQueryPort = {
    resolve: (handle) =>
      handle.startsWith("wf_") && WF.startsWith(handle) ? { kind: "workflow", workflowId: WF } : { kind: "none" },
    resolveLabel: (handle) => (handle === "review-flow" ? { kind: "workflow", workflowId: WF } : { kind: "none" }),
    get: () => view,
    wait: async () => ({ ok: false, reason: "unknown_workflow" }),
    stop: async () => ({ ok: false, reason: "unknown_workflow" }),
    activity: () => undefined,
    extend,
  };
  const query: FakeQuery = { extendTimeout: vi.fn(() => okOutcome()), get: vi.fn(() => undefined) };
  const tool = createExtendTimeoutTool({
    query,
    resolveRun: () => ({ ok: false, error: "no such run", candidates: [] }),
    workflows,
    now: () => NOW,
  });
  return { tool, extend, query };
}

function workflowOk(overrides: Partial<WorkflowExtendOutcome & { ok: true }> = {}): WorkflowExtendOutcome {
  return {
    ok: true,
    workflowId: WF,
    previousDeadlineAt: 70_000,
    deadlineAt: 670_000, // NOW + 660s
    requestedMs: 600_000,
    grantedMs: 600_000,
    clamped: false,
    extensionsUsed: 1,
    extensionsRemaining: 2,
    hardDeadlineAt: 1_270_000,
    rescuedFromGrace: false,
    ...overrides,
  };
}

describe("tools/extend-timeout-tool: SubagentWorkflow targets", () => {
  it("run_id documents workflow ids; the description mentions workflows and their children", () => {
    const { tool } = workflowSetup(workflowOk());
    const runId = (ExtendTimeoutParams.properties.run_id as { description: string }).description;
    expect(runId).toContain("SubagentWorkflow id (wf_…)");
    expect(tool.description).toContain("background SubagentWorkflow");
    expect(tool.description).toContain("extend their workflow instead");
  });

  it("a wf_ id (exact, prefix or script name) goes to workflows.extend, never to the run query", async () => {
    for (const handle of [WF, "wf_0123", "review-flow"]) {
      const { tool, extend, query } = workflowSetup(workflowOk());
      await executeText(tool, { run_id: handle, extend_s: 600, reason: "tests left" });
      expect(extend).toHaveBeenCalledWith(WF, 600_000, { reason: "tests left" });
      expect(query.extendTimeout).not.toHaveBeenCalled();
    }
  });

  it("success text mirrors the run receipt; a rescue is called out; details carry the raw outcome", async () => {
    const { tool } = workflowSetup(workflowOk({ rescuedFromGrace: true, clamped: true, requestedMs: 900_000 }));
    const result = await tool.execute("tc1", { run_id: WF, extend_s: 900 } as never);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe(
      `Extended workflow ${WF} by 10m00s (requested 15m00s, clamped by its hard ceiling). New deadline in 11m00s. ` +
        "2 of 3 extensions left; at most 10m00s more available. " +
        "The workflow was inside its timeout grace window and is now back to normal execution.",
    );
    expect(result.details).toMatchObject({ ok: true, workflowId: WF, rescuedFromGrace: true });
  });

  it("explicit timeout_s workflow → no_headroom with the hard-cap wording", async () => {
    const { tool } = workflowSetup(
      { ok: false, reason: "no_headroom" },
      workflowView({ deadlineAt: 70_000, hardDeadlineAt: 70_000 }),
    );
    const message = await executeError(tool, { run_id: WF, extend_s: 60 });
    expect(message).toBe(
      `workflow ${WF} ("review-flow") was started with an explicit timeout_s, which is a hard cap; it stops at its ` +
        `deadline (in 1m00s) and cannot be extended. Read what it produced with get_subagent_result(run_id: "${WF}") ` +
        "after the notification, or abort_subagent and restart the workflow with a larger timeout_s.",
    );
  });

  it("no_headroom after extensions → ceiling wording", async () => {
    const { tool } = workflowSetup(
      { ok: false, reason: "no_headroom" },
      workflowView({ deadlineAt: 130_000, hardDeadlineAt: 130_000, extensions: 2 }),
    );
    const message = await executeError(tool, { run_id: WF, extend_s: 60 });
    expect(message).toContain("is at its hard ceiling (2m10s from start)");
    expect(message).toContain("stops at its deadline (in 2m00s)");
  });

  it.each<[WorkflowExtendOutcome & { ok: false }, Partial<BackgroundWorkflowView>, string[]]>([
    [{ ok: false, reason: "limit_reached" }, { extensions: 3 }, ["already used all 3 deadline extensions", "in 1m00s"]],
    [{ ok: false, reason: "limit_reached" }, {}, ["already used all deadline extensions"]],
    [{ ok: false, reason: "stopping" }, { stopRequested: "user_stop" }, ["is already stopping (user_stop)"]],
    [{ ok: false, reason: "already_terminal" }, { status: "completed" }, ["already finished (completed)"]],
    [{ ok: false, reason: "already_terminal" }, {}, ["already finished (its terminal decision is made)"]],
    [{ ok: false, reason: "unsupported", detail: "boom" }, {}, ["this build cannot extend", "(boom)"]],
    [{ ok: false, reason: "uncapped" }, {}, ["no time cap configured"]],
    [{ ok: false, reason: "unknown_workflow" }, {}, ["unknown workflow", "/agent status"]],
  ])("rejection %o → says what to do next", async (outcome, view, fragments) => {
    const { tool } = workflowSetup(outcome, workflowView(view));
    const message = await executeError(tool, { run_id: WF, extend_s: 60 });
    for (const f of fragments) expect(message).toContain(f);
  });

  it("a port without extend() answers unsupported", async () => {
    const { query } = setup(okOutcome());
    const workflows: WorkflowQueryPort = {
      resolve: () => ({ kind: "workflow", workflowId: WF }),
      resolveLabel: () => ({ kind: "none" }),
      get: () => workflowView(),
      wait: async () => ({ ok: false, reason: "unknown_workflow" }),
      stop: async () => ({ ok: false, reason: "unknown_workflow" }),
      activity: () => undefined,
    };
    const tool = createExtendTimeoutTool({ query, workflows, now: () => NOW });
    expect(await executeError(tool, { run_id: WF, extend_s: 60 })).toContain("this build cannot extend");
  });

  it("a workflow's child run is intercepted: points at the owning workflow, never calls extendTimeout", async () => {
    const child = { ...snapshot({}), parentRunId: WF } as RunSnapshot;
    const { query, tool } = setup(okOutcome(), child);
    const message = await executeError(tool, { run_id: RUN_ID, extend_s: 120 });
    expect(message).toBe(
      `run r-abcdef is a child of workflow ${WF}; a workflow's children run under the workflow's own deadline and ` +
        `cannot be extended one by one. Extend the workflow instead: extend_subagent_timeout(run_id: "${WF}", extend_s: 120).`,
    );
    expect(query.extendTimeout).not.toHaveBeenCalled();
  });

  it("a nested (non-workflow) child run is still extendable", async () => {
    const nested = { ...snapshot({}), parentRunId: "r-parent0001" } as RunSnapshot;
    const { query, tool } = setup(okOutcome(), nested);
    await executeText(tool, { run_id: RUN_ID, extend_s: 60 });
    expect(query.extendTimeout).toHaveBeenCalled();
  });
});
