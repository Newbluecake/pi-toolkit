import { describe, expect, it } from "vitest";
import { createAgentTool, type NestedSpawnPort } from "../../src/tools/agent-tool.js";
import type { ConsultExpertRef, RunOutcome, SpawnRequest } from "../../src/core/types.js";
import type { ResolveExpertsResult } from "../../src/consult/index.js";

/** T-20 / §4.2: Agent({ experts }) is dispatch-time resolved, never silently ignored. */

const ref: ConsultExpertRef = {
  runId: "r_EXPERT01",
  label: "explorer",
  sessionFile: "/tmp/expert.jsonl",
  agentType: "explorer",
};

function outcome(): RunOutcome {
  return {
    runId: "r_CHILD01",
    status: "completed",
    text: "child answer",
    turns: 1,
    durationMs: 10,
    diag: {
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
      label: "child",
    },
  };
}

function params(experts?: string[]) {
  return {
    description: "delegate",
    prompt: "do the work",
    subagent_type: "worker",
    ...(experts === undefined ? {} : { experts }),
  };
}

function port(calls: SpawnRequest[], options: { background?: boolean } = {}): NestedSpawnPort {
  return {
    spawn: async (req) => {
      calls.push(req);
      return { runId: "r_CHILD01", label: "child" };
    },
    spawnAndWait: async (req) => {
      calls.push(req);
      return outcome();
    },
  };
}

describe("Agent tool experts parameter", () => {
  it("throws when experts is passed in a context without a resolver", async () => {
    const calls: SpawnRequest[] = [];
    const tool = createAgentTool({ spawn: port(calls) });
    await expect(tool.execute("c", params(["explorer"]), undefined, undefined, undefined as never)).rejects.toThrow(
      "experts is not supported in this context",
    );
    expect(calls).toHaveLength(0);
  });

  it("propagates resolver configuration errors", async () => {
    const tool = createAgentTool({
      spawn: port([]),
      resolveExperts: () => {
        throw new Error('ambiguous expert "explorer": use run_id');
      },
    });
    await expect(tool.execute("c", params(["explorer"]), undefined, undefined, undefined as never)).rejects.toThrow(
      /ambiguous expert.*run_id/,
    );
  });

  it("stores resolved refs on the SpawnRequest and echoes mapping + running warning", async () => {
    const calls: SpawnRequest[] = [];
    const resolved: ResolveExpertsResult = {
      refs: [ref],
      lines: ['expert "explorer" → run_id r_EXPERT01 (explorer)'],
      warnings: ['⚠ expert "explorer" is still running; consult will nack until it finishes.'],
    };
    const tool = createAgentTool({ spawn: port(calls), resolveExperts: () => resolved });
    const result = (await tool.execute("c", params(["explorer"]), undefined, undefined, undefined as never)) as {
      content: Array<{ text: string }>;
    };
    expect(calls).toHaveLength(1);
    expect(calls[0]!.consultExperts).toEqual([ref]);
    const text = result.content.map((c) => c.text).join("\n");
    expect(text).toContain('expert "explorer" → run_id r_EXPERT01 (explorer)');
    expect(text).toContain("still running; consult will nack");
  });

  it("carries consultExperts through the background reconstruction path too", async () => {
    const calls: SpawnRequest[] = [];
    const resolved: ResolveExpertsResult = { refs: [ref], lines: ["mapping"], warnings: [] };
    const tool = createAgentTool({ spawn: port(calls), resolveExperts: () => resolved });
    await tool.execute(
      "c",
      { ...params(["explorer"]), run_in_background: true },
      undefined,
      undefined,
      undefined as never,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.consultExperts).toEqual([ref]);
    expect(calls[0]!.detachSignalOnStart).toBe(true);
  });

  it("experts remains optional and does not affect ordinary Agent calls", async () => {
    const calls: SpawnRequest[] = [];
    const tool = createAgentTool({ spawn: port(calls) });
    await tool.execute("c", params(), undefined, undefined, undefined as never);
    expect(calls[0]!.consultExperts).toBeUndefined();
  });
});
