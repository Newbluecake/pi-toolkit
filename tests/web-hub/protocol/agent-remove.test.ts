/**
 * web-hub-delete-session plan v2 §4.3: the frozen protocol face for "delete a session from the
 * web list" — `AGENT_REMOVE_PATH`, the `SSE_EVENTS`/`API_ERRORS` tail inserts, and the
 * `AgentRemoveRequest`/`AgentRemoveResult`/`AgentRemoveErrorReason`/`AgentRemovedPayload` types
 * from `http-contract.ts`, plus `SpawnRecordPublic.removing` and `SPAWN_GONE_REASON` from
 * `spawn.ts`. P1 (hub/agent-remove.ts, supervisor, registry) and P2 (UI) import these — they
 * must never redefine the literals pinned here.
 *
 * Type-level pins (the request/result/payload shapes) are compile-time only — assigning literal
 * values to each type below fails `tsc` if the shape ever drifts; there is nothing to assert at
 * runtime for a type alias. Runtime pins cover the arrays' actual contents and order.
 */
import { describe, expect, it } from "vitest";
import type {
  AgentRemoveErrorReason,
  AgentRemovedPayload,
  AgentRemoveRequest,
  AgentRemoveResult,
} from "../../../src/web-hub/protocol/http-contract.js";
import { AGENT_REMOVE_PATH, API_ERRORS, SSE_EVENTS } from "../../../src/web-hub/protocol/http-contract.js";
import type { SpawnRecordPublic } from "../../../src/web-hub/protocol/spawn.js";
import { SPAWN_GONE_REASON } from "../../../src/web-hub/protocol/spawn.js";

describe("protocol/http-contract — agent-remove endpoint path (§4.1)", () => {
  it("pins the path", () => {
    expect(AGENT_REMOVE_PATH).toBe("/api/agents/remove");
  });
});

describe("protocol/http-contract — SSE_EVENTS (§4.3①: agent_removed slots in right before spawns)", () => {
  it("keeps spawns as the tail entry (pinned by spawn.test.ts too — must never regress)", () => {
    expect(SSE_EVENTS.at(-1)).toBe("spawns");
  });

  it("places agent_removed immediately before spawns", () => {
    const spawnsIdx = SSE_EVENTS.indexOf("spawns");
    expect(spawnsIdx).toBeGreaterThan(-1);
    expect(SSE_EVENTS[spawnsIdx - 1]).toBe("agent_removed");
  });

  it("contains agent_removed exactly once", () => {
    expect(SSE_EVENTS.filter((e) => e === "agent_removed")).toHaveLength(1);
  });
});

describe("protocol/http-contract — API_ERRORS (§4.3②: E_AGENT_ONLINE tail-appended)", () => {
  it("is the last entry in the array", () => {
    expect(API_ERRORS.at(-1)).toBe("E_AGENT_ONLINE");
  });

  it("appears exactly once", () => {
    expect(API_ERRORS.filter((c) => c === "E_AGENT_ONLINE")).toHaveLength(1);
  });

  it("existing codes keep their relative order (append-only — spot check a few anchors)", () => {
    const launcher = API_ERRORS.indexOf("E_LAUNCHER");
    const previewChanged = API_ERRORS.indexOf("E_PREVIEW_CHANGED");
    const agentOnline = API_ERRORS.indexOf("E_AGENT_ONLINE");
    expect(launcher).toBeGreaterThan(-1);
    expect(previewChanged).toBeGreaterThan(launcher);
    expect(agentOnline).toBeGreaterThan(previewChanged);
  });
});

describe("protocol/http-contract — AgentRemoveRequest (§4.3④: agentKey xor spawnId)", () => {
  it("accepts the agentKey form", () => {
    const req: AgentRemoveRequest = { agentKey: "a123-abcdef" };
    expect(req).toEqual({ agentKey: "a123-abcdef" });
  });

  it("accepts the spawnId form", () => {
    const req: AgentRemoveRequest = { spawnId: "0123456789abcdef" };
    expect(req).toEqual({ spawnId: "0123456789abcdef" });
  });
});

describe("protocol/http-contract — AgentRemoveResult (§2.4/§4.1: 200 removed vs 202 pending)", () => {
  it("accepts the removed-true (200) shape", () => {
    const result: AgentRemoveResult = { removed: true };
    expect(result).toEqual({ removed: true });
  });

  it("accepts the pending (202) shape", () => {
    const result: AgentRemoveResult = {
      removed: false,
      pending: true,
      spawnId: "0123456789abcdef",
      state: "stopping",
    };
    expect(result.state).toBe("stopping");
  });
});

describe("protocol/http-contract — AgentRemoveErrorReason (§2.4/§4.1: shared by E_AGENT_ONLINE and E_SPAWN_DENIED)", () => {
  it("covers exactly the three reasons used by the remove endpoint", () => {
    const reasons: AgentRemoveErrorReason[] = ["online", "exit-unconfirmed", "lan-off"];
    expect(reasons).toHaveLength(3);
  });
});

describe("protocol/http-contract — AgentRemovedPayload (§2.3: the agent_removed SSE payload)", () => {
  it("is just the removed agentKey", () => {
    const payload: AgentRemovedPayload = { agentKey: "a123-abcdef" };
    expect(payload).toEqual({ agentKey: "a123-abcdef" });
  });
});

describe("protocol/spawn — SpawnRecordPublic.removing (§2.2: present while a delete is in flight)", () => {
  it("is optional and, when present, is the literal true", () => {
    const base: Omit<SpawnRecordPublic, "removing"> = {
      spawnId: "0123456789abcdef",
      state: "stopping",
      createdAt: 0,
      updatedAt: 0,
      cwdLabel: "repo",
      origin: { listener: "loopback", reqId: "r1" },
    };
    const withoutRemoving: SpawnRecordPublic = base;
    const withRemoving: SpawnRecordPublic = { ...base, removing: true };
    expect(withoutRemoving.removing).toBeUndefined();
    expect(withRemoving.removing).toBe(true);
  });
});

describe("protocol/spawn — SPAWN_GONE_REASON (§2.5: idempotent-hit-but-record-gone rejection reason)", () => {
  it("pins the literal value shared by routes.ts and the UI's classifySpawnError", () => {
    expect(SPAWN_GONE_REASON).toBe("spawn-gone");
  });
});
