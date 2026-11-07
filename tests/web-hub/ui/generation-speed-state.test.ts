import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import { projectSessionEntry } from "../../../src/web-hub/protocol/keys.js";
import {
  GENERATION_HISTORY_CAP,
  WEB_MESSAGE_SPEED_ENTRY_TYPE,
} from "../../../src/web-hub/protocol/message-generation.js";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";

/**
 * task58 (web-hub-tokens-speed §5.3): the reducer-side generation map lifecycle — rebuilt
 * from EXACTLY the current loaded entries through the protocol's single
 * `generationHistoryIndex` (never an incremental merge of our own rules):
 * snapshot rebuild · exact-mid matching against loaded assistant entries · unmatched /
 * invalid metadata ignored · duplicate mid ⇒ last valid wins · 512 cap (513 evicts oldest) ·
 * page-prepend and `append` merge in loaded order · a replacing snapshot without the custom
 * entry leaves NO stale stamp (deletion residue) · session switch clears · the run drawer
 * rides the same cores. Live `message_end` stamps ride the message itself (not the map).
 *
 * All wire entries come from the REAL `projectSessionEntry` projection.
 */

type Msg = { event: string; data: any };
const run = (msgs: Msg[], s = initialState(null)) => msgs.reduce((acc, m) => reduce(acc, m), s);

const card = (agentKey: string, sessionId = "s1") => ({
  agentKey,
  kind: "tui",
  pid: 1,
  cwd: "/tmp/p",
  state: "live",
  pluginVersion: "1.0.0",
  outdated: false,
  session: {
    sessionId,
    sessionFile: `/tmp/${sessionId}.jsonl`,
    cwd: "/tmp/p",
    reason: "startup",
    leafId: null,
    mode: "tui",
  },
  prompts: [],
});

const ts = (n: number) => new Date(n).toISOString();

function rawAssistant(id: string, at: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    parentId: null,
    type: "message",
    timestamp: ts(at),
    message: { role: "assistant", content: [{ type: "text", text: `hi ${id}` }], timestamp: at, ...extra },
  };
}

function rawSpeedCustom(
  id: string,
  at: number,
  mid: string,
  core: Record<string, unknown> = { tokens: 10, genMs: 500, deltaCount: 2 },
  data?: Record<string, unknown>,
) {
  return {
    id,
    parentId: null,
    type: "custom",
    timestamp: ts(at),
    customType: WEB_MESSAGE_SPEED_ENTRY_TYPE,
    ...(data !== undefined ? { data } : { data: { piToolkitGeneration: { v: 1, mid, ...core } } }),
  };
}

const wire = (raws: unknown[]): any[] => raws.map((r) => projectSessionEntry(r)).filter((e) => e !== undefined);

function agentWithHistory(entries: unknown[], extra: Msg[] = []): AgentState {
  const s = run([
    { event: "agents", data: [card("A")] },
    { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
    { event: "history", data: { agentKey: "A", entries, tailMessages: [], fromSeq: 0, hasMore: false } },
    ...extra,
  ]);
  return s.agents.get("A") as unknown as AgentState;
}

describe("generation map — snapshot build", () => {
  it("matches the custom entry to the loaded assistant by exact mid; the message itself renders un-stamped", () => {
    const entries = wire([rawAssistant("m1", 1000), rawSpeedCustom("c1", 1100, "m1")]);
    const a = agentWithHistory(entries);
    expect(a.generation?.get("m1")).toEqual({ v: 1, tokens: 10, genMs: 500, deltaCount: 2 });
    // the custom tombstone renders nothing and never becomes an item
    expect(a.items).toHaveLength(1);
    expect(a.items[0]?.entryId).toBe("m1");
    // the history message carries NO container (projection stripped it)
    expect((a.items[0]?.message as Record<string, unknown>).piToolkitGeneration).toBeUndefined();
  });

  it("custom arriving BEFORE its assistant in the same batch still matches (order-independent within loaded set)", () => {
    const entries = wire([rawSpeedCustom("c1", 900, "m1"), rawAssistant("m1", 1000)]);
    const a = agentWithHistory(entries);
    expect(a.generation?.get("m1")).toBeDefined();
  });

  it("unmatched mid (assistant not loaded) and invalid metadata are ignored", () => {
    const entries = wire([
      rawAssistant("m1", 1000),
      rawSpeedCustom("cX", 1100, "not-loaded"),
      rawSpeedCustom("c2", 1200, "m1", { tokens: Number.NaN, genMs: 500, deltaCount: 2 }),
      rawSpeedCustom("c3", 1300, "m1", { tokens: 10, genMs: 100, deltaCount: 2 }),
    ]);
    const a = agentWithHistory(entries);
    expect(a.generation?.size).toBe(0);
  });

  it("raw container variants the sanitizer must reject never reach the map (v2 / non-own shapes / bad bounds)", () => {
    const entries = wire([
      rawAssistant("m1", 1000),
      rawSpeedCustom("c1", 1100, "m1", { tokens: 10, genMs: 500, deltaCount: 2, v: 2 }),
      rawSpeedCustom("c2", 1200, "m1", { tokens: 1.5, genMs: 500, deltaCount: 2 }),
      rawSpeedCustom("c3", 1300, "m1", { tokens: 10, genMs: 500, deltaCount: 0 }),
    ]);
    const a = agentWithHistory(entries);
    expect(a.generation?.size).toBe(0);
  });

  it("duplicate mid: the LAST valid custom entry wins; an invalid later entry does NOT clear an earlier valid one", () => {
    const entries = wire([
      rawAssistant("m1", 1000),
      rawSpeedCustom("c1", 1100, "m1", { tokens: 10, genMs: 500, deltaCount: 2 }),
      rawSpeedCustom("c2", 1200, "m1", { tokens: 40, genMs: 1000, deltaCount: 4 }),
    ]);
    const a = agentWithHistory(entries);
    expect(a.generation?.get("m1")).toEqual({ v: 1, tokens: 40, genMs: 1000, deltaCount: 4 });

    const entries2 = wire([
      rawAssistant("m1", 1000),
      rawSpeedCustom("c1", 1100, "m1", { tokens: 10, genMs: 500, deltaCount: 2 }),
      rawSpeedCustom("c2", 1200, "m1", { tokens: Number.NaN, genMs: 500, deltaCount: 2 }),
    ]);
    const a2 = agentWithHistory(entries2);
    expect(a2.generation?.get("m1")).toEqual({ v: 1, tokens: 10, genMs: 500, deltaCount: 2 });
  });
});

describe("generation map — bounded at 512 (loaded entries only)", () => {
  it(`${GENERATION_HISTORY_CAP + 1} matched pairs keep exactly ${GENERATION_HISTORY_CAP}, evicting the OLDEST`, () => {
    const raws: unknown[] = [];
    for (let i = 0; i <= GENERATION_HISTORY_CAP; i++) {
      const mid = `m${i}`;
      raws.push(rawAssistant(mid, 1000 + i * 10));
      raws.push(rawSpeedCustom(`c${i}`, 1005 + i * 10, mid));
    }
    const a = agentWithHistory(wire(raws));
    expect(a.generation?.size).toBe(GENERATION_HISTORY_CAP);
    expect(a.generation?.has("m0")).toBe(false); // oldest evicted
    expect(a.generation?.has("m1")).toBe(true);
    expect(a.generation?.has(`m${GENERATION_HISTORY_CAP}`)).toBe(true); // newest kept
  });
});

describe("generation map — page prepend & append merge in loaded order", () => {
  it("an older page carrying customs merges ahead of the existing log (same rules as wholesale)", () => {
    const fresh = wire([rawAssistant("m9", 9000), rawSpeedCustom("c9", 9100, "m9")]);
    const a = agentWithHistory(fresh, [
      {
        event: "page",
        data: {
          agentKey: "A",
          entries: wire([rawAssistant("m1", 1000), rawSpeedCustom("c1", 1100, "m1")]),
          hasMore: false,
        },
      },
    ]);
    expect(a.generation?.size).toBe(2);
    expect(a.generation?.get("m1")).toBeDefined();
    expect(a.generation?.get("m9")).toBeDefined();
    expect(a.items[0]?.entryId).toBe("m1"); // page prepends
    expect(a.items[1]?.entryId).toBe("m9");
  });

  it("append brings a custom whose assistant was loaded earlier (order across batches)", () => {
    const a = agentWithHistory(wire([rawAssistant("m1", 1000)]), [
      { event: "append", data: { agentKey: "A", entries: wire([rawSpeedCustom("c1", 1100, "m1")]) } },
    ]);
    expect(a.generation?.get("m1")).toEqual({ v: 1, tokens: 10, genMs: 500, deltaCount: 2 });
  });

  it("append bringing the assistant AFTER an earlier custom-only append still matches", () => {
    const a = agentWithHistory(wire([]), [
      { event: "append", data: { agentKey: "A", entries: wire([rawSpeedCustom("c1", 1100, "m1")]) } },
      { event: "append", data: { agentKey: "A", entries: wire([rawAssistant("m1", 1000)]) } },
    ]);
    expect(a.generation?.get("m1")).toBeDefined();
  });

  it("a duplicate-mid append is last-valid-wins across batches", () => {
    const a = agentWithHistory(wire([rawAssistant("m1", 1000), rawSpeedCustom("c1", 1100, "m1")]), [
      {
        event: "append",
        data: {
          agentKey: "A",
          entries: wire([rawSpeedCustom("c2", 1200, "m1", { tokens: 60, genMs: 2000, deltaCount: 6 })]),
        },
      },
    ]);
    expect(a.generation?.get("m1")).toEqual({ v: 1, tokens: 60, genMs: 2000, deltaCount: 6 });
  });

  it("an all-duplicate append is a same-state no-op (identical agent object reference)", () => {
    const entries = wire([rawAssistant("m1", 1000), rawSpeedCustom("c1", 1100, "m1")]);
    const s0 = run([
      { event: "agents", data: [card("A")] },
      { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
      { event: "history", data: { agentKey: "A", entries, tailMessages: [], fromSeq: 0, hasMore: false } },
    ]);
    const s1 = run([{ event: "append", data: { agentKey: "A", entries } }], s0);
    expect(s1.agents.get("A")).toBe(s0.agents.get("A")); // no-op ⇒ same agent object, same state
  });
});

describe("generation map — scope resets leave no residue", () => {
  it("a replacing snapshot WITHOUT the custom entry un-stamps the message (deletion residue impossible)", () => {
    const s0 = run([
      { event: "agents", data: [card("A")] },
      { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
      {
        event: "history",
        data: {
          agentKey: "A",
          entries: wire([rawAssistant("m1", 1000), rawSpeedCustom("c1", 1100, "m1")]),
          tailMessages: [],
          fromSeq: 0,
          hasMore: false,
        },
      },
    ]);
    const a0 = s0.agents.get("A") as unknown as AgentState;
    expect(a0.generation?.size).toBe(1);
    const s1 = run(
      [
        {
          event: "history",
          data: {
            agentKey: "A",
            entries: wire([rawAssistant("m1", 1000)]),
            tailMessages: [],
            fromSeq: 5,
            hasMore: false,
          },
        },
      ],
      s0,
    );
    const a1 = s1.agents.get("A") as unknown as AgentState;
    expect(a1.generation?.size).toBe(0);
    expect(a1.items).toHaveLength(1);
  });

  it("a session switch clears the map with the rest of the scope", () => {
    const s0 = run([
      { event: "agents", data: [card("A")] },
      { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
      {
        event: "history",
        data: {
          agentKey: "A",
          entries: wire([rawAssistant("m1", 1000), rawSpeedCustom("c1", 1100, "m1")]),
          tailMessages: [],
          fromSeq: 0,
          hasMore: false,
        },
      },
    ]);
    const s1 = run(
      [
        {
          event: "session",
          data: { agentKey: "A", session: { ...card("A").session, sessionId: "s2", sessionFile: "/tmp/s2.jsonl" } },
        },
      ],
      s0,
    );
    const a1 = s1.agents.get("A") as unknown as AgentState;
    expect(a1.history).toBe("waiting");
    expect(a1.generation?.size ?? 0).toBe(0);
    expect(a1.genLog).toHaveLength(0);
  });

  it("a fresh snapshot for the new session rebuilds independently (no cross-session carry-over)", () => {
    const s0 = run([
      { event: "agents", data: [card("A", "s1")] },
      { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
      {
        event: "history",
        data: {
          agentKey: "A",
          sessionId: "s1",
          entries: wire([rawAssistant("m1", 1000), rawSpeedCustom("c1", 1100, "m1")]),
          tailMessages: [],
          fromSeq: 0,
          hasMore: false,
        },
      },
    ]);
    const s1 = run(
      [
        {
          event: "session",
          data: { agentKey: "A", session: { ...card("A").session, sessionId: "s2", sessionFile: "/tmp/s2.jsonl" } },
        },
        {
          event: "history",
          data: {
            agentKey: "A",
            sessionId: "s2",
            entries: wire([rawAssistant("m2", 2000)]),
            tailMessages: [],
            fromSeq: 0,
            hasMore: false,
          },
        },
      ],
      s0,
    );
    const a1 = s1.agents.get("A") as unknown as AgentState;
    expect(a1.generation?.size).toBe(0); // m1's metadata did not follow the scope switch
  });
});

describe("generation map — live stamps ride the message, not the map", () => {
  it("a live message_end with the agent-stamped core keeps it on the item message", () => {
    const a = agentWithHistory(wire([]), [
      {
        event: "ev",
        data: {
          agentKey: "A",
          seq: 0,
          e: {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              timestamp: 2000,
              piToolkitGeneration: { v: 1, tokens: 30, genMs: 3000, deltaCount: 7 },
            },
          },
        },
      },
    ]);
    expect(a.generation?.size).toBe(0); // the map is history-only
    const live = a.items[0]?.message as Record<string, unknown>;
    expect(live.piToolkitGeneration).toEqual({ v: 1, tokens: 30, genMs: 3000, deltaCount: 7 });
    expect(a.items[0]?.entryId).toBeUndefined();
  });
});

describe("generation map — run drawer rides the same cores", () => {
  it("run_history builds the map on the runTx state; run_page merges; a reselect resets", () => {
    const s0 = run([
      { event: "agents", data: [card("A")] },
      { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
      { event: "history", data: { agentKey: "A", entries: [], tailMessages: [], fromSeq: 0, hasMore: false } },
      { event: "run_select", data: { agentKey: "A", runId: "r1" } },
      { event: "run_subscribing", data: { agentKey: "A", runId: "r1", at: 100, retries: 0 } },
      {
        event: "run_history",
        data: {
          agentKey: "A",
          runId: "r1",
          entries: wire([rawAssistant("m1", 1000), rawSpeedCustom("c1", 1100, "m1")]),
          tailMessages: [],
          tapId: "t1",
          fromSeq: 2,
          hasMore: false,
          terminal: false,
          live: true,
          status: "running",
        },
      },
    ]);
    const tx0 = (s0.agents.get("A") as unknown as AgentState).runTx!;
    expect(tx0.generation?.get("m1")).toEqual({ v: 1, tokens: 10, genMs: 500, deltaCount: 2 });

    const s1 = run(
      [
        {
          event: "run_page",
          data: {
            agentKey: "A",
            runId: "r1",
            entries: wire([rawAssistant("m0", 500), rawSpeedCustom("c0", 600, "m0")]),
            hasMore: false,
          },
        },
      ],
      s0,
    );
    const tx1 = (s1.agents.get("A") as unknown as AgentState).runTx!;
    expect(tx1.generation?.size).toBe(2);

    const s2 = run([{ event: "run_select", data: { agentKey: "A", runId: null } }], s1);
    expect((s2.agents.get("A") as unknown as AgentState).runTx).toBeNull();
  });
});
