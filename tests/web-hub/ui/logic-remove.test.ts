import { describe, expect, it } from "vitest";
import {
  classifyRemoveError,
  removalTargetForAgent,
  removalTargetForSpawn,
} from "../../../src/web-hub/ui/src/logic/remove.js";
import type { SpawnRecordPublic, SpawnsPayload } from "../../../src/web-hub/protocol/spawn.js";

/**
 * web-hub-delete-session plan v2 §5.2/§7.2: the two pure target functions (`removalTargetForAgent`
 * for AgentCard, `removalTargetForSpawn` for SpawnRow) and `classifyRemoveError`'s six-bucket
 * taxonomy. Table-driven, same discipline as `logic-spawn.test.ts`.
 */

function rec(over: Partial<SpawnRecordPublic> = {}): SpawnRecordPublic {
  return {
    spawnId: "sp1",
    state: "live",
    createdAt: 1000,
    updatedAt: 1000,
    cwdLabel: "proj",
    origin: { listener: "loopback", reqId: "req-aaaaaaaaaaaaaaaa" },
    ...over,
  };
}

function spawns(items: SpawnRecordPublic[]): SpawnsPayload {
  return { items, active: 0, max: 4 };
}

describe("removalTargetForAgent (AgentCard's target, §5.2)", () => {
  it("a record (starting/live/stopping) bound to this agent's key ⇒ managed, carrying removing", () => {
    for (const state of ["starting", "live", "stopping"] as const) {
      const agent = { key: "a1", down: false, card: { state: "live" } };
      const target = removalTargetForAgent(agent, spawns([rec({ spawnId: "sp1", state, agentKey: "a1" })]));
      expect(target).toEqual({ kind: "managed", spawnId: "sp1", removing: false });
    }
  });

  it("removing:true on the managed record rides through", () => {
    const agent = { key: "a1", down: false, card: { state: "live" } };
    const target = removalTargetForAgent(
      agent,
      spawns([rec({ spawnId: "sp1", state: "stopping", agentKey: "a1", removing: true })]),
    );
    expect(target).toEqual({ kind: "managed", spawnId: "sp1", removing: true });
  });

  it("multiple records for the same key ⇒ the latest updatedAt wins", () => {
    const agent = { key: "a1", down: false, card: { state: "live" } };
    const target = removalTargetForAgent(
      agent,
      spawns([
        rec({ spawnId: "old", state: "live", agentKey: "a1", updatedAt: 100 }),
        rec({ spawnId: "new", state: "stopping", agentKey: "a1", updatedAt: 200 }),
      ]),
    );
    expect(target).toEqual({ kind: "managed", spawnId: "new", removing: false });
  });

  it("exited/failed records never count as managed (not in {starting,live,stopping})", () => {
    const agent = { key: "a1", down: true, card: { state: "stale" } };
    const target = removalTargetForAgent(agent, spawns([rec({ spawnId: "sp1", state: "exited", agentKey: "a1" })]));
    expect(target).toEqual({ kind: "offline" }); // falls through to the offline branch
  });

  it("agent.down or card.state === 'stale' (no managed record) ⇒ offline", () => {
    expect(removalTargetForAgent({ key: "a1", down: true, card: { state: "live" } }, null)).toEqual({
      kind: "offline",
    });
    expect(removalTargetForAgent({ key: "a1", down: false, card: { state: "stale" } }, null)).toEqual({
      kind: "offline",
    });
  });

  it("an online, unmanaged agent ⇒ null (no button, 在线 TUI 会话不可删)", () => {
    expect(removalTargetForAgent({ key: "a1", down: false, card: { state: "live" } }, null)).toBeNull();
  });

  it("a record for a DIFFERENT agentKey never matches", () => {
    const agent = { key: "a1", down: false, card: { state: "live" } };
    const target = removalTargetForAgent(agent, spawns([rec({ spawnId: "sp1", state: "live", agentKey: "a2" })]));
    expect(target).toBeNull();
  });

  it("garbage input ⇒ null", () => {
    expect(removalTargetForAgent(null, null)).toBeNull();
    expect(removalTargetForAgent(undefined, null)).toBeNull();
    expect(removalTargetForAgent({}, null)).toBeNull();
    expect(removalTargetForAgent({ key: "a1", down: false }, { items: "garbage" } as never)).toBeNull();
  });
});

describe("removalTargetForSpawn (SpawnRow's target, §5.2/§0.3)", () => {
  it.each(["starting", "failed"] as const)("%s ⇒ a spawn target carrying removing", (state) => {
    expect(removalTargetForSpawn(rec({ state, removing: true }))).toEqual({
      kind: "spawn",
      spawnId: "sp1",
      removing: true,
    });
  });

  it.each(["live", "stopping", "exited"] as const)("%s ⇒ null (AgentCard's target covers it instead)", (state) => {
    expect(removalTargetForSpawn(rec({ state }))).toBeNull();
  });

  it("garbage input ⇒ null", () => {
    expect(removalTargetForSpawn(null)).toBeNull();
    expect(removalTargetForSpawn({})).toBeNull();
  });
});

describe("classifyRemoveError (§5.2's six-bucket taxonomy)", () => {
  it("E_AGENT_ONLINE: reason distinguishes online from exit-unconfirmed", () => {
    expect(classifyRemoveError({ ok: false, error: "E_AGENT_ONLINE", reason: "online" })).toBe("online");
    expect(classifyRemoveError({ ok: false, error: "E_AGENT_ONLINE", reason: "exit-unconfirmed" })).toBe("unconfirmed");
    // no reason at all defaults to "online" (the more common/less alarming of the two)
    expect(classifyRemoveError({ ok: false, error: "E_AGENT_ONLINE" })).toBe("online");
  });

  it.each([
    ["E_SPAWN_DENIED", "managedLan"],
    ["E_RATE", "rate"],
    ["E_UNSUPPORTED", "unsupported"],
    ["E_NETWORK", "network"],
    ["HTTP 500", "network"],
  ] as const)("%s ⇒ %s", (error, kind) => {
    expect(classifyRemoveError({ ok: false, error })).toBe(kind);
  });

  it("a success outcome (or garbage) is not an error ⇒ undefined", () => {
    expect(classifyRemoveError({ ok: true, removed: true })).toBeUndefined();
    expect(classifyRemoveError(undefined)).toBeUndefined();
    expect(classifyRemoveError(null)).toBeUndefined();
    expect(classifyRemoveError("x" as never)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Anti-drift pins (verifier r1 #2, P2 打回): `classifyRemoveError`'s literals are no longer
// hand-typed in isolation — `@logic/remove.js` imports `API_ERRORS` straight from
// `protocol/http-contract.ts` (zero runtime typebox cost, same free-to-import rationale
// `@logic/contract.js`'s header documents for `SSE_EVENTS`/`API_ERRORS`) and throws at MODULE
// LOAD TIME if any of the four error codes it relies on ever leaves that frozen array; the three
// `AgentRemoveErrorReason` members (no runtime export of their own in the protocol — a bare TS
// union) are pinned by `transport/types.ts`'s exhaustive `{ [K in AgentRemoveErrorReason]: true }`
// record instead. These tests exercise both mechanisms with the REAL imported values.
// ---------------------------------------------------------------------------

describe("classifyRemoveError × the real protocol/transport constants (anti-drift pin)", () => {
  it("every API_ERRORS code classifyRemoveError relies on is still in the frozen protocol array", async () => {
    const { API_ERRORS } = await import("../../../src/web-hub/protocol/http-contract.js");
    for (const code of ["E_AGENT_ONLINE", "E_SPAWN_DENIED", "E_RATE", "E_UNSUPPORTED"]) {
      expect(API_ERRORS).toContain(code);
    }
  });

  it("AGENT_REMOVE_ERROR_REASONS (transport/types.ts's exhaustive pin) carries exactly the three protocol reasons", async () => {
    const mod = await import("../../../src/web-hub/ui/src/transport/types.js");
    expect([...mod.AGENT_REMOVE_ERROR_REASONS].sort()).toEqual(["exit-unconfirmed", "lan-off", "online"].sort());
    expect(mod.AGENT_REMOVE_REASON_ONLINE).toBe("online");
    expect(mod.AGENT_REMOVE_REASON_UNCONFIRMED).toBe("exit-unconfirmed");
    expect(mod.AGENT_REMOVE_REASON_LAN_OFF).toBe("lan-off");
  });

  it("classifyRemoveError fed the real AGENT_REMOVE_REASON_* constants resolves the same buckets", async () => {
    const { AGENT_REMOVE_REASON_ONLINE, AGENT_REMOVE_REASON_UNCONFIRMED } =
      await import("../../../src/web-hub/ui/src/transport/types.js");
    expect(classifyRemoveError({ ok: false, error: "E_AGENT_ONLINE", reason: AGENT_REMOVE_REASON_ONLINE })).toBe(
      "online",
    );
    expect(classifyRemoveError({ ok: false, error: "E_AGENT_ONLINE", reason: AGENT_REMOVE_REASON_UNCONFIRMED })).toBe(
      "unconfirmed",
    );
  });
});
