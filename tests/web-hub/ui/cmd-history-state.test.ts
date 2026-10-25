import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";
import { cmdEndRecord, cmdRecord, cmdWireEntry, userWireEntry } from "./fixtures/cmd-records.js";

/** U1 · logic/state.js `entryItem` (plan §4.7): a projected `subagent:cmd` tombstone WITH a
 *  valid `cmd` field becomes a `kind:"cmd"` item; every other custom tombstone (absent or
 *  invalid `cmd`) stays invisible — legacy behavior byte-identical. Driven through the real
 *  reducer (history frame) like transcript.test.ts, not a hand-rolled items array. */

type Msg = { event: string; data: unknown; id?: number };
const run = (msgs: Msg[], s = initialState()): ReturnType<typeof initialState> =>
  msgs.reduce((acc, m) => reduce(acc, m), s);

function agentWith(entries: Record<string, unknown>[]): AgentState {
  const s = run([
    { event: "hello", data: { clientId: "c1" } },
    {
      event: "agents",
      data: [
        {
          agentKey: "agent-a",
          kind: "tui",
          pid: 1,
          cwd: "/tmp/p",
          state: "live",
          pluginVersion: "1.0.0",
          outdated: false,
          prompts: [],
        },
      ],
    },
    { event: "subscribing", data: { agentKey: "agent-a", clientId: "c1" } },
    {
      event: "history",
      data: { agentKey: "agent-a", entries, tailMessages: [], fromSeq: entries.length, hasMore: false },
    },
  ]);
  return s.agents.get("agent-a") as unknown as AgentState;
}

describe("entryItem — custom + cmd ⇒ kind cmd (§4.7)", () => {
  it("a custom tombstone with a valid cmd record becomes a cmd item", () => {
    const a = agentWith([cmdWireEntry("e1", cmdEndRecord())]);
    expect(a.items).toHaveLength(1);
    expect(a.items[0]?.kind).toBe("cmd");
    expect(a.items[0]?.entryId).toBe("e1");
  });

  it("start records become items too (running cards)", () => {
    const a = agentWith([cmdWireEntry("e1", cmdRecord())]);
    expect(a.items[0]?.kind).toBe("cmd");
  });

  it("invalid cmd (v:2 / bad cmdId) ⇒ NO item (pure tombstone, invisible as before)", () => {
    expect(agentWith([cmdWireEntry("e1", cmdRecord({ v: 2 }))]).items).toHaveLength(0);
    expect(agentWith([cmdWireEntry("e1", cmdRecord({ cmdId: "short" }))]).items).toHaveLength(0);
  });

  it("a custom tombstone WITHOUT cmd stays invisible (legacy)", () => {
    const tomb = cmdWireEntry("e1", undefined);
    expect(agentWith([tomb]).items).toHaveLength(0);
    const timing = { ...cmdWireEntry("e2", undefined), timing: { t1: 42 } };
    expect(agentWith([timing]).items).toHaveLength(0);
  });

  it("neighbours (messages) are unaffected and order is kept", () => {
    const a = agentWith([
      userWireEntry("m1", 1_700_000_000_000, "before"),
      cmdWireEntry("e1", cmdEndRecord()),
      userWireEntry("m2", 1_700_000_002_000, "after"),
    ]);
    expect(a.items.map((i) => i.kind)).toEqual(["message", "cmd", "message"]);
  });

  it("start+end of one cmdId both enter items (folding is entries.ts's job, not the reducer's)", () => {
    const a = agentWith([cmdWireEntry("e1", cmdRecord()), cmdWireEntry("e2", cmdEndRecord())]);
    expect(a.items.map((i) => i.kind)).toEqual(["cmd", "cmd"]);
  });
});
