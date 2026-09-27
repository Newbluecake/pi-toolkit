import { describe, expect, it } from "vitest";
import { createAgentTool, type AgentToolParams, type NestedSpawnPort } from "../../src/tools/agent-tool.js";
import { isSchema, SpawnParamsSchema, type SpawnParams } from "../../src/rpc/protocol.js";
import { snapshotAgentOpts, validateAgentOpts } from "../../src/workflow/agent-opts.js";
import { createSpawnService } from "../../src/service/spawn-service.js";
import type { AgentTypeConfig, RunOutcome, SpawnRequest } from "../../src/core/types.js";
import type { Runner, SlotPool } from "../../src/service/ports.js";

/**
 * todo #22 memory optimize-plan §10 N6 / §7.0 point 4: `SpawnRequest.toolDomain`
 * is only ever set by the in-process tidy caller (which builds its own
 * `SpawnRequest` field-by-field) — every public entry point that turns
 * MODEL/remote input into a `SpawnRequest` either rejects an unknown
 * `toolDomain` key outright or silently drops it before it ever reaches the
 * request. This file pins that down for the three surfaces the plan names:
 * the Agent tool, RPC spawn, and workflow `agent()` opts. It also pins the
 * spawn-service admission guard (§7.0 point 4): `toolDomain:"readonly"`
 * combined with isolation/forkSessionFrom/resumeFrom is a config error.
 */

function fakePort(): NestedSpawnPort & { seen?: SpawnRequest } {
  const port: NestedSpawnPort & { seen?: SpawnRequest } = {
    async spawn(req) {
      port.seen = req;
      return { runId: "child-1" };
    },
    async spawnAndWait(req) {
      port.seen = req;
      return {
        runId: "child-1",
        status: "completed",
        turns: 1,
        durationMs: 1,
        diag: {
          createdAt: 0,
          phase: "settled",
          phaseEnteredAt: 1,
          pendingTools: 0,
          turns: 1,
          escalation: [],
          orphaned: false,
          generation: 1,
          degraded: [],
          staleInputs: 0,
          unkillable: [],
        },
      };
    },
  };
  return port;
}

describe("N6: SpawnRequest.toolDomain cannot leak in through the Agent tool", () => {
  it("execute() never forwards a toolDomain key even when it rides along in the raw params object", async () => {
    const port = fakePort();
    const tool = createAgentTool({ spawn: port });
    const params = {
      description: "d",
      prompt: "p",
      subagent_type: "worker",
      toolDomain: "readonly",
    } as unknown as AgentToolParams;
    await tool.execute("tc", params, undefined, undefined, {} as never);
    expect(port.seen).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(port.seen, "toolDomain")).toBe(false);
  });
});

describe("N6: SpawnRequest.toolDomain cannot leak in through RPC spawn params", () => {
  it("SpawnParamsSchema (additionalProperties: false) rejects a params object carrying toolDomain", () => {
    const raw = { type: "worker", prompt: "p", toolDomain: "readonly" };
    expect(isSchema<SpawnParams>(SpawnParamsSchema, raw)).toBe(false);
    // Control: the same object minus toolDomain validates fine — the schema
    // itself is not accidentally rejecting everything.
    const { toolDomain: _drop, ...clean } = raw;
    expect(isSchema<SpawnParams>(SpawnParamsSchema, clean)).toBe(true);
  });
});

describe("N6: SpawnRequest.toolDomain cannot leak in through workflow agent() opts", () => {
  it("validateAgentOpts rejects an opts object carrying toolDomain as an unknown key", () => {
    const snapshot = snapshotAgentOpts({ label: "x", toolDomain: "readonly" });
    expect(snapshot.unknownKeys).toContain("toolDomain");
    const result = validateAgentOpts(snapshot);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("toolDomain");
  });

  it("control: opts without the unknown key validates fine", () => {
    const snapshot = snapshotAgentOpts({ label: "x" });
    expect(snapshot.unknownKeys).toEqual([]);
    const result = validateAgentOpts(snapshot);
    expect(result.ok).toBe(true);
  });
});

describe("N6 / §7.0 point 4: spawn-service admission rejects toolDomain combined with isolation/forkSessionFrom/resumeFrom", () => {
  const type: AgentTypeConfig = { name: "Plan", description: "x", systemPrompt: "", promptMode: "append" };
  const outcome: RunOutcome = {
    runId: "x",
    status: "completed",
    turns: 1,
    durationMs: 2,
    diag: {
      createdAt: 0,
      phase: "settled",
      phaseEnteredAt: 2,
      settledAt: 2,
      pendingTools: 0,
      turns: 1,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
    },
  };
  function deps() {
    const runner: Runner = { run: async (spec) => ({ ...outcome, runId: spec.runId }) };
    const pool: SlotPool = { acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }) };
    return {
      types: { get: () => type, list: () => [], reload: async () => ({ types: [type], errors: [] }) },
      pool,
      runner,
      now: () => 0,
    };
  }

  it.each([
    ["isolation", { isolation: "worktree" as const }],
    ["forkSessionFrom", { forkSessionFrom: "/tmp/fork.jsonl" }],
    ["resumeFrom", { resumeFrom: "does-not-exist" }],
  ] as const)("rejects toolDomain:readonly combined with %s", async (_label, extra) => {
    const service = createSpawnService(deps());
    const result = await service.spawn({ type: "Plan", prompt: "tidy", toolDomain: "readonly", ...extra });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.kind).toBe("config");
      expect(result.error.message).toContain("toolDomain");
    }
  });

  it("control: toolDomain:readonly alone (no combination) is admitted normally", async () => {
    const service = createSpawnService(deps());
    const result = await service.spawn({ type: "Plan", prompt: "tidy", toolDomain: "readonly" });
    expect("runId" in result).toBe(true);
  });
});
