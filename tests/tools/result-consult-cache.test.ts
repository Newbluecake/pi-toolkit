import { describe, expect, it } from "vitest";
import type { ConsultCacheDiagnostics, RunDiagnostics, RunSnapshot, UsageDelta } from "../../src/core/types.js";
import { createResultTool } from "../../src/tools/result-tool.js";
import type { QueryService } from "../../src/service/query-service.js";

/**
 * cache-thread plan §5.3 / §11 (U): the `get_subagent_result` consult section
 * — prediction, measured first request, anchor state and thread ride the
 * trailing suffix lines; runs without the fields keep byte-identical result
 * text.
 */

const usage: UsageDelta = { input: 42, output: 17, cacheRead: 3, cacheWrite: 0, costUsd: 0.0055 };

function baseDiag(overrides: Partial<RunDiagnostics> = {}): RunDiagnostics {
  return {
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
    usage,
    ...overrides,
  };
}

function snapshot(diag: RunDiagnostics): RunSnapshot {
  return {
    runId: "r1",
    generation: 1,
    status: "completed",
    phase: "settled",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag,
    outcome: { runId: "r1", status: "completed", text: "done", turns: 1, durationMs: 10, usage, diag },
    updatedAt: 10,
  };
}

function queryFor(diag: RunDiagnostics): QueryService {
  const snap = snapshot(diag);
  return {
    get: () => snap,
    list: () => [],
    wait: async () => ({ ok: true, outcome: snap.outcome! }),
    waitAll: async () => ({ settled: [], pending: [] }),
    steer: async () => undefined,
    stop: async () => false,
  };
}

async function resultText(diag: RunDiagnostics): Promise<string> {
  const tool = createResultTool({ query: queryFor(diag) });
  const result = await tool.execute("tc1", { run_id: "r1" }, undefined, () => undefined, {} as never);
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

const cache = (
  predicted: ConsultCacheDiagnostics["predicted"]["state"],
  first?: ConsultCacheDiagnostics["first"],
): ConsultCacheDiagnostics => ({ v: 1, predicted: { state: predicted }, ...(first ? { first } : {}) });

describe("get_subagent_result consult cache section (§5.3 U)", () => {
  it("appends the consult line with prediction, measurement, anchor and thread", async () => {
    const text = await resultText(
      baseDiag({
        consultCache: cache("warm", { v: 1, readShare: 0.962, label: "hit", anchor: "added", at: 5 }),
        consultThread: { threadId: "c7k9q2mx", seq: 2 },
      }),
    );
    expect(text).toContain(
      "\nConsult cache: predicted warm; first request hit 96% read share; anchor added; thread c7k9q2mx #2",
    );
  });

  it("renders the pending prediction while the first response is outstanding", async () => {
    const text = await resultText(baseDiag({ consultCache: cache("cold"), consultThread: { threadId: "x", seq: 1 } }));
    expect(text).toContain("\nConsult cache: predicted cold; first response pending; thread x #1");
  });

  it("thread-only diagnostics render the thread clause alone", async () => {
    const text = await resultText(baseDiag({ consultThread: { threadId: "c7k9q2mx", seq: 3 } }));
    expect(text).toContain("\nConsult cache: thread c7k9q2mx #3");
  });

  it("runs without the fields keep the exact pre-feature result text", async () => {
    const text = await resultText(baseDiag());
    expect(text).not.toContain("Consult cache:");
    expect(text).toBe("done\n\n(duration: 10ms · usage: in:42 out:17 cache_r:3 cache_w:0 cost:$0.0055)");
  });
});
