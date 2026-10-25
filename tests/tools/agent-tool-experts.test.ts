import { describe, expect, it } from "vitest";
import { createAgentTool, type NestedSpawnPort } from "../../src/tools/agent-tool.js";
import type { RunOutcome, SpawnRequest } from "../../src/core/types.js";

/**
 * #40 compat: `experts` left the Agent schema with the consult feature. An
 * old-habit call still reaches execute (pi's validator lets the extra key
 * through): it is IGNORED with a one-line notice and the run is dispatched
 * normally — no consult wiring, nothing on the spawn request.
 */

const NOTICE = "`experts` was ignored";

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

function params(experts?: unknown) {
  return {
    description: "delegate",
    prompt: "do the work",
    subagent_type: "worker",
    ...(experts === undefined ? {} : { experts }),
  } as never;
}

function port(calls: SpawnRequest[]): NestedSpawnPort {
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

const textOf = (result: unknown): string =>
  (result as { content: Array<{ text: string }> }).content.map((c) => c.text).join("\n");

describe("Agent tool: legacy `experts` argument (#40)", () => {
  it("is not part of either Agent schema", () => {
    const top = createAgentTool({ spawn: port([]) });
    const nested = createAgentTool({ spawn: port([]), allowedTypes: ["worker"], parentRunId: "p" });
    for (const tool of [top, nested]) {
      expect(Object.keys((tool.parameters as { properties: object }).properties)).not.toContain("experts");
      expect(JSON.stringify(tool.parameters)).not.toContain("consult");
    }
  });

  it("top-level: ignores experts, dispatches normally, adds exactly one notice line, no consultExperts", async () => {
    const calls: SpawnRequest[] = [];
    const result = await createAgentTool({ spawn: port(calls) }).execute(
      "c",
      params(["explorer", "main"]),
      undefined,
      undefined,
      undefined as never,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("consultExperts");
    expect(calls[0]!.detachSignalOnStart).toBe(true);
    const text = textOf(result);
    expect(text).toContain("started in background");
    expect(text.split(NOTICE)).toHaveLength(2);
    expect(text).toContain("message_agent");
  });

  it("never calls a wired (deprecated) resolveExperts", async () => {
    const calls: SpawnRequest[] = [];
    let resolved = 0;
    await createAgentTool({
      spawn: port(calls),
      resolveExperts: () => {
        resolved++;
        throw new Error("must not be read");
      },
    }).execute("c", params(["explorer"]), undefined, undefined, undefined as never);
    expect(resolved).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("nested blocking path: ignores experts and appends the notice to the result", async () => {
    const calls: SpawnRequest[] = [];
    const nested = await createAgentTool({
      spawn: port(calls),
      parentRunId: "parent-1",
      allowedTypes: ["worker"],
    }).execute("c", params(["explorer"]), undefined, undefined, undefined as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("consultExperts");
    expect(calls[0]!.parentRunId).toBe("parent-1");
    const text = textOf(nested);
    expect(text).toContain("child answer");
    expect(text).toContain(NOTICE);
  });

  it("without experts: no notice and no consultExperts (byte-identical result content)", async () => {
    const calls: SpawnRequest[] = [];
    const result = await createAgentTool({ spawn: port(calls) }).execute(
      "c",
      params(),
      undefined,
      undefined,
      undefined as never,
    );
    expect(textOf(result)).not.toContain(NOTICE);
    expect(calls[0]).not.toHaveProperty("consultExperts");
  });

  it("an empty experts array is still an `experts` argument: ignored with the notice", async () => {
    const result = await createAgentTool({ spawn: port([]) }).execute(
      "c",
      params([]),
      undefined,
      undefined,
      undefined as never,
    );
    expect(textOf(result)).toContain(NOTICE);
  });
});
