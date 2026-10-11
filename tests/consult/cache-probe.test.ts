import { describe, expect, it } from "vitest";
import { foldConsultCacheProbe } from "../../src/core/consult-summary.js";
import type { ConsultExpertRef, ExpertRequestSnapshot, RunDiagnostics, RunSnapshot } from "../../src/core/types.js";
import { buildCacheProbe } from "../../src/consult/tool.js";
import type { RunPrefixRecord } from "../../src/consult/prefix-probe.js";

const ref: ConsultExpertRef = {
  runId: "r_expert",
  sessionFile: "/sessions/expert.jsonl",
  agentType: "explorer",
  contextTokens: 50,
};

const snapshot: ExpertRequestSnapshot = {
  tools: [{ name: "read", description: "read", parameters: { type: "object" } }],
  systemSections: {},
  sourceSessionId: "s_expert",
  lastRequestUsage: { input: 100, cacheRead: 50, cacheWrite: 50 },
};

const diagnostics = (
  costUsd: number,
  consultIdentityPrediction?: RunDiagnostics["consultIdentityPrediction"],
): RunDiagnostics =>
  ({
    createdAt: 0,
    phase: "settled",
    phaseEnteredAt: 0,
    pendingTools: 0,
    turns: 2,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
    usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, costUsd },
    ...(consultIdentityPrediction === undefined ? {} : { consultIdentityPrediction }),
  }) as RunDiagnostics;

const terminalExpert = (settledAt: number): RunSnapshot =>
  ({
    runId: ref.runId,
    generation: 1,
    status: "completed",
    phase: "settled",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: { ...diagnostics(0), settledAt },
    updatedAt: settledAt,
  }) as RunSnapshot;

describe("buildCacheProbe", () => {
  it("folds wire comparison, requests, gaps, hit ratio, keepalive delta and guard counters", () => {
    const expert: RunPrefixRecord = {
      runId: ref.runId,
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude",
      latest: {
        seq: 1,
        startedAt: 50,
        endedAt: 100,
        fieldHashes: { model: "m", tools: "t", system: "s", thinking: "h" },
      },
    };
    const consult: RunPrefixRecord = {
      runId: "r_consult",
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude",
      first: {
        seq: 0,
        startedAt: 400,
        fieldHashes: { model: "m", tools: "t", system: "s", thinking: "h" },
      },
      requests: [
        {
          seq: 0,
          startedAt: 400,
          fieldHashes: {},
          usage: { input: 100, cacheRead: 100, cacheWrite: 0, output: 10, costUsd: 0.2 },
        },
        {
          seq: 1,
          startedAt: 500,
          fieldHashes: {},
          toolsDrift: true,
          usage: { input: 120, cacheRead: 0, cacheWrite: 80, output: 8, costUsd: 0.3 },
        },
      ],
    };
    const probe = buildCacheProbe({
      ref,
      snapshot,
      outcome: "completed",
      consultRunId: consult.runId,
      consultDiagnostics: diagnostics(0.6),
      expertLive: terminalExpert(200),
      guardCounters: { calls: 3, batches: 2, terminated: true, identity: 1, nested: 1, costAfterUsd: 0.1 },
      registry: { get: (runId) => (runId === ref.runId ? expert : runId === consult.runId ? consult : undefined) },
    });
    expect(probe).toMatchObject({
      expertRunId: ref.runId,
      outcome: "completed",
      identity: {
        preflight: "pass",
        expertTools: 1,
        wire: { model: true, tools: true, system: true, thinking: true },
      },
      api: "anthropic-messages",
      gapSettleMs: 200,
      gapLastRequestMs: 300,
      expertPrefixTokens: 200,
      prefixSource: "snapshot-usage",
      keepalivePingUsd: expect.closeTo(0.1, 10),
      hitRatio: 0.5,
      blocked: { calls: 3, batches: 2, terminated: true, identity: 1, nested: 1, costAfterUsd: 0.1 },
    });
    expect(probe?.requests).toEqual([
      { input: 100, cacheRead: 100, cacheWrite: 0, output: 10, costUsd: 0.2 },
      { input: 120, cacheRead: 0, cacheWrite: 80, output: 8, costUsd: 0.3, toolsDrift: true },
    ]);
  });

  it("threads the driver prediction into the consult cache probe", () => {
    const predicted = { system: false, model: true, thinking: true, cwd: true, forcedPrompt: false };
    const probe = buildCacheProbe({
      ref,
      snapshot,
      outcome: "completed",
      consultDiagnostics: diagnostics(0, predicted),
      registry: { get: () => undefined },
    });
    expect(probe?.identity.predicted).toEqual(predicted);
  });

  it("omits unavailable wire data and reports a null hit ratio for a zero prefix", () => {
    const zero: ExpertRequestSnapshot = { ...snapshot, lastRequestUsage: { input: 0, cacheRead: 0, cacheWrite: 0 } };
    const probe = buildCacheProbe({
      ref: { ...ref, contextTokens: undefined },
      snapshot: zero,
      outcome: "completed",
      consultRunId: "r_missing",
      consultDiagnostics: diagnostics(0),
      registry: { get: () => undefined },
    });
    expect(probe?.identity.wire).toBeUndefined();
    expect(probe?.hitRatio).toBeNull();
    expect(probe?.prefixSource).toBe("snapshot-usage");
  });

  it("degrades safely when a registry getter throws and increments probeErrors", () => {
    const consultRecord: RunPrefixRecord = { runId: "r_consult", requests: [] };
    const probe = buildCacheProbe({
      ref,
      snapshot,
      outcome: "completed",
      consultRunId: consultRecord.runId,
      consultDiagnostics: diagnostics(0),
      registry: {
        get: (runId) => {
          if (runId === consultRecord.runId) return consultRecord;
          throw new Error("registry unavailable");
        },
      },
    });
    expect(probe?.outcome).toBe("completed");
    expect(probe?.identity.preflight).toBe("pass");
    expect(consultRecord.probeErrors).toBe(1);
  });

  it("the folded summary keeps only the newest eight probes", () => {
    let summary;
    for (let i = 0; i < 10; i++) {
      summary = foldConsultCacheProbe(summary, {
        expertRunId: `r_${i}`,
        outcome: "completed",
        identity: { preflight: "pass", expertTools: 0 },
      });
    }
    expect(summary?.cacheProbes).toHaveLength(8);
    expect(summary?.cacheProbes?.[0]?.expertRunId).toBe("r_2");
  });
});
