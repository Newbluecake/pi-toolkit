import { describe, expect, it, vi } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import {
  WORKFLOW_NOTICE_ENTRY_TYPE,
  WORKFLOW_NOTIFICATION_TYPE,
  WORKFLOW_SETTLED_EVENT,
  createWorkflowNoticeSink,
  readPendingWorkflowNotices,
  redeliverPendingWorkflowNotices,
} from "../../src/adapters/workflow-notice.js";
import { createWorkflowActivityRegistry } from "../../src/workflow/activity.js";
import { createBackgroundWorkflows } from "../../src/workflow/background.js";
import type { WorkflowOutcome } from "../../src/workflow/types.js";
import type { UsageDelta } from "../../src/core/types.js";

/**
 * Background workflow completion notices (docs/dev/workflow-background/plan.md §3):
 * live settle → one pi.sendMessage(triggerTurn); settle during shutdown →
 * persisted `pending` entry → re-delivered exactly once by the next stack.
 */

const usage: Record<string, UsageDelta> = {
  r_A: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: 0.25 },
  r_B: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.5 },
};

function settledView(overrides: Partial<WorkflowOutcome> = {}) {
  const outcome: WorkflowOutcome = {
    workflowId: "wf_n1",
    status: "completed",
    pendingReconcile: false,
    durationMs: 3_000,
    result: "SUMMARY-TEXT",
    children: [
      { callId: "c1", runId: "r_A", source: "live", status: "completed", durationMs: 1 },
      { callId: "c2", runId: "r_B", source: "live", status: "completed", durationMs: 1 },
    ],
    diag: { createdAt: 0, heartbeat: { seq: 0, observedAt: 0, stalledMs: 0 }, logLines: 0 },
    ...overrides,
  };
  return { workflowId: "wf_n1", name: "notify-flow", startedAt: 100, status: outcome.status, outcome };
}

function sinkHarness(maxChars = 0) {
  const sent: { message: { customType: string; content: string; details: any }; options: { triggerTurn: boolean } }[] =
    [];
  const entries: { type: "custom"; customType: string; data: unknown }[] = [];
  const events: { channel: string; payload: unknown }[] = [];
  const sink = createWorkflowNoticeSink({
    sendMessage: (message, options) => sent.push({ message: message as never, options }),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    emit: (channel, payload) => events.push({ channel, payload }),
    usageOf: (runId) => usage[runId],
    resultMaxChars: () => maxChars,
    now: () => 1_000,
  });
  return { sink, sent, entries, events };
}

describe("workflow notice sink: live settle", () => {
  it("sends exactly one triggerTurn notification with id, name, status, result and spend; persists nothing", () => {
    const h = sinkHarness();
    const captured = h.sink(settledView(), "live");
    expect(h.sent).toHaveLength(1);
    const { message, options } = h.sent[0]!;
    expect(options).toEqual({ triggerTurn: true });
    expect(message.customType).toBe(WORKFLOW_NOTIFICATION_TYPE);
    expect(message.content).toContain('Workflow "notify-flow" (wf_n1) completed');
    expect(message.content).toContain("$0.75");
    expect(message.content).toContain("result: SUMMARY-TEXT");
    expect(message.details).toMatchObject({
      kind: "workflow",
      workflowId: "wf_n1",
      label: "notify-flow",
      status: "completed",
      runIds: ["r_A", "r_B"],
      costUsd: 0.75,
    });
    expect(captured?.costUsd).toBeCloseTo(0.75);
    expect(h.entries).toEqual([]);
    expect(h.events).toEqual([
      { channel: WORKFLOW_SETTLED_EVENT, payload: { workflowId: "wf_n1", status: "completed" } },
    ]);
  });

  it("caps the result by resultMaxChars", () => {
    const h = sinkHarness(300);
    h.sink(settledView({ result: "z".repeat(4_000) }), "live");
    expect(h.sent[0]!.message.content).toMatch(/chars omitted/);
    expect(h.sent[0]!.message.content.length).toBeLessThan(1_200);
  });

  it("a throwing sendMessage falls back to the persisted pending entry (never lost silently)", () => {
    const entries: unknown[] = [];
    const sink = createWorkflowNoticeSink({
      sendMessage: () => {
        throw new Error("stale ctx");
      },
      appendEntry: (_t, data) => entries.push(data),
      resultMaxChars: () => 0,
      now: () => 1,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    sink(settledView(), "live");
    warn.mockRestore();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ state: "pending", workflowId: "wf_n1" });
  });
});

describe("workflow notice sink: settle during shutdown → persisted → re-delivered once", () => {
  it("persists instead of sending, then the next stack re-delivers without a turn and marks it delivered", () => {
    const h = sinkHarness();
    h.sink(settledView({ status: "aborted", stopCause: "shutdown", result: undefined }), "shutdown");
    expect(h.sent).toEqual([]); // not sent into a session that is going away
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]!.customType).toBe(WORKFLOW_NOTICE_ENTRY_TYPE);

    const runs = createBackgroundWorkflows({
      clock: systemClock,
      activity: createWorkflowActivityRegistry(),
      createOrchestrator: () => {
        throw new Error("unused");
      },
    });
    const resent: { details: any; triggerTurn: boolean }[] = [];
    const branch = [...h.entries];
    const deps = {
      branch: () => branch,
      runs,
      sendMessage: (m: { details: unknown }, o: { triggerTurn: boolean }) =>
        resent.push({ details: m.details, triggerTurn: o.triggerTurn }),
      appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
      now: () => 2_000,
    };
    expect(redeliverPendingWorkflowNotices(deps)).toBe(1);
    expect(resent).toHaveLength(1);
    expect(resent[0]!.triggerTurn).toBe(false);
    expect(resent[0]!.details).toMatchObject({ workflowId: "wf_n1", status: "aborted", redelivered: true });
    // get_subagent_result keeps working for it in the new stack.
    expect(runs.get("wf_n1")).toMatchObject({ status: "aborted", name: "notify-flow" });
    expect(runs.get("wf_n1")?.usage?.costUsd).toBeCloseTo(0.75);
    // The delivered marker makes a second rebuild a no-op.
    expect(redeliverPendingWorkflowNotices(deps)).toBe(0);
    expect(resent).toHaveLength(1);
  });

  it("readPendingWorkflowNotices ignores malformed, delivered and expired entries", () => {
    const now = 100 * 60 * 60 * 1_000;
    const pending = (workflowId: string, at: number) => ({
      type: "custom",
      customType: WORKFLOW_NOTICE_ENTRY_TYPE,
      data: {
        v: 1,
        state: "pending",
        workflowId,
        at,
        content: "c",
        details: {},
        name: "n",
        startedAt: 0,
        outcome: { status: "aborted" },
      },
    });
    const branch = [
      pending("wf_keep", now - 1_000),
      pending("wf_old", now - 25 * 60 * 60 * 1_000),
      pending("wf_done", now - 1_000),
      {
        type: "custom",
        customType: WORKFLOW_NOTICE_ENTRY_TYPE,
        data: { v: 1, state: "delivered", workflowId: "wf_done", at: now },
      },
      { type: "custom", customType: WORKFLOW_NOTICE_ENTRY_TYPE, data: { v: 2, garbage: true } },
      { type: "custom", customType: "other", data: pending("wf_foreign", now).data },
    ];
    expect(readPendingWorkflowNotices(branch, now).map((p) => p.workflowId)).toEqual(["wf_keep"]);
  });
});
