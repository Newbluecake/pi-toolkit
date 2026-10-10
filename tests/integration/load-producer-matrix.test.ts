import { describe, expect, it, vi } from "vitest";
import { createSpawnService } from "../../src/service/spawn-service.js";
import type { AgentTypeConfig, RunOutcome } from "../../src/core/types.js";
import type { Runner, SlotPool } from "../../src/service/ports.js";

const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
const outcome = {
  runId: "r_matrix",
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

describe("load producer matrix", () => {
  it("gates Agent requests while exempt producer shapes remain admitted", async () => {
    const run = vi.fn(async () => outcome);
    const pool: SlotPool = { acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }) };
    const service = createSpawnService({
      types: { get: () => type, list: () => [type], reload: async () => ({ types: [type], errors: [] }) },
      pool,
      runner: { run } as Runner,
      now: () => 0,
      loadGate: ({ nested }) => ({ message: nested ? "nested blocked" : "blocked" }),
    });

    const gated = await service.spawn({ type: "worker", prompt: "agent", loadPolicy: "reject" });
    expect("error" in gated).toBe(true);
    expect(run).not.toHaveBeenCalled();

    for (const producer of [
      { type: "worker", prompt: "workflow" },
      { type: "worker", prompt: "rpc" },
      { type: "worker", prompt: "task" },
    ]) {
      const admitted = await service.spawn(producer);
      expect("error" in admitted).toBe(false);
    }
  });
});
