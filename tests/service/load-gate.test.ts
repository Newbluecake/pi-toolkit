import { describe, expect, it, vi } from "vitest";
import { createSpawnService } from "../../src/service/spawn-service.js";
import type { AgentTypeConfig, RunOutcome } from "../../src/core/types.js";
import type { Runner, SlotPool } from "../../src/service/ports.js";

const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
const outcome = {
  runId: "r_test",
  status: "completed",
  turns: 0,
  durationMs: 0,
  diag: {
    createdAt: 0,
    phase: "settled",
    phaseEnteredAt: 0,
    settledAt: 0,
    pendingTools: 0,
    turns: 0,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
  },
} satisfies RunOutcome;

function make(runner: Runner, loadGate?: (ctx: { nested: boolean }) => { message: string } | undefined) {
  const pool: SlotPool = { acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }) };
  return createSpawnService({
    types: { get: () => type, list: () => [type], reload: async () => ({ types: [type], errors: [] }) },
    pool,
    runner,
    now: () => 0,
    ...(loadGate === undefined ? {} : { loadGate }),
  });
}

describe("SpawnService load admission", () => {
  it("rejects before runner/label/run side effects and preserves pool precedence", async () => {
    const run = vi.fn(async () => outcome);
    const service = make({ run }, () => ({ message: "load gate: crit" }));

    const result = await service.spawn({
      type: "worker",
      prompt: "work",
      label: "builder",
      loadPolicy: "reject",
    });
    expect(result).toEqual({ error: { kind: "config", message: "load gate: crit", retryable: true, reason: "load" } });
    expect(run).not.toHaveBeenCalled();
    expect(service.snapshots()).toHaveLength(0);
  });

  it("marks a live parent request as nested for the gate and leaves ordinary producers ungated", async () => {
    const nested = vi.fn(() => ({ message: "nested load gate" }));
    const service = make({ run: async () => outcome }, nested);
    const parent = await service.spawn({ type: "worker", prompt: "parent" });
    if ("error" in parent) throw new Error(parent.error.message);

    const child = await service.spawn({
      type: "worker",
      prompt: "child",
      parentRunId: parent.runId,
      loadPolicy: "reject",
    });
    expect(child).toEqual({ error: { kind: "config", message: "nested load gate", retryable: true, reason: "load" } });
    expect(nested).toHaveBeenCalledWith({ nested: true });

    const workflow = await service.spawn({ type: "worker", prompt: "workflow" });
    expect("error" in workflow).toBe(false);
    expect(nested).toHaveBeenCalledTimes(1);
  });
});
