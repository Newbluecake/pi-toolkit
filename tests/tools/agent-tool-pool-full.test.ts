import { describe, expect, it } from "vitest";
import { createAgentTool, type NestedSpawnPort } from "../../src/tools/agent-tool.js";
import type { RunOutcome, SpawnRequest } from "../../src/core/types.js";
import type { SlotsInfo } from "../../src/core/format.js";

/**
 * L1 (agent-tool pool-full plan §1/§2) + §5 (user follow-up, slots on every
 * dispatch): Agent tool ↔ SpawnService seam. `fakePort` never touches a real
 * SlotPool — these tests verify (a) the tool sets `poolFullPolicy` from its
 * `queueWhenFull` dep (default false ⇒ "reject"), for BOTH the top-level and
 * nested surfaces, (b) the spawn-success message surfaces `queued` info when
 * SpawnService reports it, and (c) every successful dispatch's message/
 * details carries `slots`.
 */
function fakePort(
  result: {
    runId: string;
    label?: string;
    queued?: { position: number; runningCount: number; limit: number; queueWaitMs: number };
    slots?: SlotsInfo;
  } = {
    runId: "child-1",
  },
  blockingOutcome?: RunOutcome,
): NestedSpawnPort & { seen?: SpawnRequest } {
  const port: NestedSpawnPort & { seen?: SpawnRequest } = {
    async spawn(req) {
      port.seen = req;
      return result;
    },
    async spawnAndWait(req) {
      port.seen = req;
      return blockingOutcome ?? ({ runId: "child-1" } as unknown as RunOutcome);
    },
    // P1 fix (todo #16 review): mirrors the real SpawnService method — the
    // nested blocking path (spawnAndCollect) prefers this over spawnAndWait
    // when it's present, exactly like the real port does.
    ...(blockingOutcome
      ? {
          async spawnAndWaitWithSlots(req) {
            port.seen = req;
            return {
              outcome: blockingOutcome,
              slots: result.slots ?? { limit: 0, inUse: 0 },
              ...(result.queued ? { queued: result.queued } : {}),
            };
          },
        }
      : {}),
  };
  return port;
}

const args = { description: "d", prompt: "p", subagent_type: "worker" } as const;

describe("Agent tool pool-full policy wiring (L1)", () => {
  it('top-level Agent defaults poolFullPolicy to "reject" when queueWhenFull is absent', async () => {
    const port = fakePort();
    await createAgentTool({ spawn: port }).execute("tc", args, undefined, undefined, {} as never);
    expect(port.seen?.poolFullPolicy).toBe("reject");
  });

  it('top-level Agent uses "queue" when queueWhenFull() returns true', async () => {
    const port = fakePort();
    await createAgentTool({ spawn: port, queueWhenFull: () => true }).execute(
      "tc",
      args,
      undefined,
      undefined,
      {} as never,
    );
    expect(port.seen?.poolFullPolicy).toBe("queue");
  });

  it("queueWhenFull is read fresh on every call (live /agent settings)", async () => {
    let live = false;
    const port = fakePort();
    const tool = createAgentTool({ spawn: port, queueWhenFull: () => live });
    await tool.execute("tc1", args, undefined, undefined, {} as never);
    expect(port.seen?.poolFullPolicy).toBe("reject");
    live = true;
    await tool.execute("tc2", args, undefined, undefined, {} as never);
    expect(port.seen?.poolFullPolicy).toBe("queue");
  });

  it("the nested delegation tool sets the same poolFullPolicy from its own queueWhenFull dep", async () => {
    const port = fakePort();
    await createAgentTool({
      spawn: port,
      parentRunId: "parent-1",
      allowedTypes: ["worker"],
      forceSlotless: true,
      queueWhenFull: () => true,
    }).execute("tc", { ...args, run_in_background: true }, undefined, undefined, {} as never);
    expect(port.seen?.poolFullPolicy).toBe("queue");
    // Nested calls are always slotless regardless of the policy — the field
    // is set for consistency but never actually gates admission for them.
    expect(port.seen?.slotless).toBe(true);
  });

  it("surfaces §2's queued-position message when SpawnService reports queued info", async () => {
    const port = fakePort({
      runId: "child-1",
      label: "d",
      queued: { position: 2, runningCount: 6, limit: 6, queueWaitMs: 600_000 },
    });
    const result = await createAgentTool({ spawn: port, queueWhenFull: () => true }).execute(
      "tc",
      args,
      undefined,
      undefined,
      {} as never,
    );
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(text).toContain("Queued: 6/6 running, position 2, max wait 10m");
  });

  it("adds no queued note when SpawnService reports no queued info (the common, pool-has-room path)", async () => {
    const port = fakePort({ runId: "child-1", label: "d" });
    const result = await createAgentTool({ spawn: port }).execute("tc", args, undefined, undefined, {} as never);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(text).not.toContain("Queued:");
  });

  it("§5 (user follow-up): a successful dispatch's message and details carry the compact slots readout", async () => {
    const port = fakePort({ runId: "child-1", label: "d", slots: { limit: 10, inUse: 7, free: 3 } });
    const result = await createAgentTool({ spawn: port }).execute("tc", args, undefined, undefined, {} as never);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(text).toContain("slots: 7/10 in use, 3 free");
    expect(result.details).toMatchObject({ slots: { limit: 10, inUse: 7, free: 3 } });
  });

  it("§5: renders the unlimited-pool form when slots.free is absent (concurrencyLimit=0)", async () => {
    const port = fakePort({ runId: "child-1", label: "d", slots: { limit: 0, inUse: 4 } });
    const result = await createAgentTool({ spawn: port }).execute("tc", args, undefined, undefined, {} as never);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(text).toContain("slots: 4 running (no limit)");
  });

  it("§5: the nested (background) Agent tool also reports slots", async () => {
    const port = fakePort({ runId: "child-1", label: "d", slots: { limit: 3, inUse: 1, free: 2 } });
    const result = await createAgentTool({
      spawn: port,
      parentRunId: "parent-1",
      allowedTypes: ["worker"],
      forceSlotless: true,
    }).execute("tc", { ...args, run_in_background: true }, undefined, undefined, {} as never);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(text).toContain("slots: 1/3 in use, 2 free");
  });

  it("§5: omits the slots line/details when the port doesn't report it (older test doubles)", async () => {
    const port = fakePort({ runId: "child-1", label: "d" });
    const result = await createAgentTool({ spawn: port }).execute("tc", args, undefined, undefined, {} as never);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(text).not.toContain("slots:");
    expect(result.details).not.toHaveProperty("slots");
  });

  it("P1 fix (todo #16 review): the nested BLOCKING path (no run_in_background) also surfaces slots via spawnAndWaitWithSlots", async () => {
    const outcome: RunOutcome = {
      runId: "child-1",
      status: "completed",
      turns: 1,
      durationMs: 10,
      text: "done",
      diag: {
        createdAt: 0,
        phase: "settled",
        phaseEnteredAt: 1,
        settledAt: 1,
        pendingTools: 0,
        turns: 1,
        escalation: [],
        orphaned: false,
        generation: 1,
        degraded: [],
        staleInputs: 0,
        unkillable: [],
        label: "d",
      },
    } as unknown as RunOutcome;
    const port = fakePort({ runId: "child-1", label: "d", slots: { limit: 3, inUse: 1, free: 2 } }, outcome);
    const result = await createAgentTool({
      spawn: port,
      parentRunId: "parent-1",
      allowedTypes: ["worker"],
      forceSlotless: true,
    }).execute("tc", args, undefined, undefined, {} as never);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(text).toContain("slots: 1/3 in use, 2 free");
    expect(result.details).toMatchObject({ slots: { limit: 3, inUse: 1, free: 2 } });
  });

  it("P1 fix: the nested BLOCKING path falls back to plain spawnAndWait (no slots line) when spawnAndWaitWithSlots is absent", async () => {
    const port = fakePort({ runId: "child-1", label: "d" }); // no blockingOutcome ⇒ no spawnAndWaitWithSlots on the port
    port.spawnAndWait = async () =>
      ({
        runId: "child-1",
        status: "completed",
        turns: 1,
        durationMs: 10,
        text: "done",
        diag: {
          createdAt: 0,
          phase: "settled",
          phaseEnteredAt: 1,
          settledAt: 1,
          pendingTools: 0,
          turns: 1,
          escalation: [],
          orphaned: false,
          generation: 1,
          degraded: [],
          staleInputs: 0,
          unkillable: [],
          label: "d",
        },
      }) as unknown as RunOutcome;
    const result = await createAgentTool({
      spawn: port,
      parentRunId: "parent-1",
      allowedTypes: ["worker"],
      forceSlotless: true,
    }).execute("tc", args, undefined, undefined, {} as never);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    expect(text).not.toContain("slots:");
    expect(result.details).not.toHaveProperty("slots");
  });
});
