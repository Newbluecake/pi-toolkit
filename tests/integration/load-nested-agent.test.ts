import { describe, expect, it } from "vitest";
import { createAgentTool } from "../../src/tools/agent-tool.js";

describe("nested Agent load admission", () => {
  it("forwards the nested load policy and preserves the nested rejection text", async () => {
    const requests: unknown[] = [];
    const tool = createAgentTool({
      allowedTypes: ["worker"],
      parentRunId: "r_parent",
      forceSlotless: true,
      loadGate: () => true,
      spawn: {
        spawn: async (request) => {
          requests.push(request);
          return { error: { kind: "config", message: "load gate: nested delegation rejected", retryable: true } };
        },
        spawnAndWait: async () => {
          throw new Error("not used");
        },
      },
    });

    await expect(
      tool.execute(
        "call",
        {
          description: "nested",
          prompt: "delegate",
          subagent_type: "worker",
          run_in_background: true,
        } as never,
        undefined,
      ),
    ).rejects.toThrow("nested delegation rejected");
    expect(requests).toHaveLength(1);
    expect((requests[0] as { loadPolicy?: string }).loadPolicy).toBe("reject");
    expect((requests[0] as { parentRunId?: string }).parentRunId).toBe("r_parent");
  });
});
