// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";
import Transcript from "../../../src/web-hub/ui/src/components/transcript/Transcript.vue";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";
import { __resetCmdHistoryStores, useCmdHistory } from "../../../src/web-hub/ui/src/composables/useCmdHistory.js";
import { cmdEndRecord, cmdRecord, cmdWireEntry, userWireEntry, notify } from "./fixtures/cmd-records.js";

/**
 * U1 · Transcript.vue integration (plan §4.7): cmd records in the stream render as ONE
 * in-place-updating card (start+end fold); `status.cmdRunning` drives running vs
 * 「结果未记录」; a DetailDock-dispatched placeholder renders at the tail and is dropped the
 * moment the real record folds in. Legacy streams (no cmd fields) render zero `.msg-cmd`.
 */

vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

const mounted: Array<ReturnType<typeof mount>> = [];
beforeEach(() => __resetCmdHistoryStores());
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  __resetCmdHistoryStores();
});

const ID = "c0123456789abcdef012";
const T0 = 1_700_000_000_000;

type Msg = { event: string; data: unknown; id?: number };

function stateWith(msgs: Msg[]): ReturnType<typeof initialState> {
  return msgs.reduce((acc, m) => reduce(acc, m), initialState());
}

function baseMsgs(entries: Record<string, unknown>[]): Msg[] {
  return [
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
  ];
}

function agentOf(s: ReturnType<typeof initialState>): AgentState {
  return s.agents.get("agent-a") as unknown as AgentState;
}

function mountTx(agent: AgentState) {
  const w = mount(Transcript, { props: { agent, following: true, narrow: false } });
  mounted.push(w);
  return w;
}

describe("Transcript.vue — command cards", () => {
  it("start+end records render as ONE card at the start's position (in-place fold)", () => {
    const a = agentOf(
      stateWith(
        baseMsgs([
          cmdWireEntry("e1", cmdRecord({ cmdId: ID })),
          cmdWireEntry("e2", cmdEndRecord({ cmdId: ID, output: { entries: [notify("all good")] } })),
          userWireEntry("m1", T0 + 2000, "next question"),
        ]),
      ),
    );
    const w = mountTx(a);
    const cards = w.findAll(".msg-cmd");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.find(".cmd-state").text()).toContain("done");
    expect(cards[0]?.text()).toContain("all good");
    // position: the card sits BEFORE the following user message
    const texts = w.findAll(".tx-inner > *").map((el) => el.classes());
    const cmdAt = texts.findIndex((c) => c.includes("msg-cmd"));
    const userAt = texts.findIndex((c) => c.includes("msg-user"));
    expect(cmdAt).toBeGreaterThanOrEqual(0);
    expect(userAt).toBeGreaterThan(cmdAt);
  });

  it("start-only: cmdRunning ∋ cmdId ⇒ running; drop + 5 s seen grace ⇒ running; grace expiry flips to unrecorded", async () => {
    vi.useFakeTimers();
    try {
      let s = stateWith([
        ...baseMsgs([cmdWireEntry("e1", cmdRecord({ cmdId: ID }))]),
        { event: "status", data: { agentKey: "agent-a", status: { cmdRunning: [ID] } } },
      ]);
      const w = mountTx(agentOf(s));
      expect(w.find(".msg-cmd .cmd-state").text()).toContain("running");

      // the end record is lost (crash), cmdRunning drops the id — the seen grace still shows
      // running (the append frame may simply be lagging the status frame)
      s = reduce(s, { event: "status", data: { agentKey: "agent-a", status: { cmdRunning: [] } } });
      await w.setProps({ agent: agentOf(s) });
      expect(w.find(".msg-cmd .cmd-state").text()).toContain("running");

      // grace expired ⇒ the one-shot flip timer re-resolves the card to 结果未记录
      await vi.advanceTimersByTimeAsync(5_100);
      expect(w.find(".msg-cmd .cmd-state").text()).toContain("unrecorded");
    } finally {
      vi.useRealTimers();
    }
  });

  it("placeholder at the tail is dropped the moment the real record folds in (append)", async () => {
    const store = useCmdHistory("agent-a");
    store.begin({ cmdId: ID, name: "record", args: "status", startedAt: T0 });

    let s = stateWith(baseMsgs([userWireEntry("m1", T0, "hi")]));
    const w = mountTx(agentOf(s));
    expect(w.findAll(".msg-cmd")).toHaveLength(1); // the local placeholder
    expect(w.find(".msg-cmd .cmd-state").text()).toContain("running");

    // the command's end record arrives via a live append
    s = reduce(s, {
      event: "append",
      data: {
        agentKey: "agent-a",
        entries: [cmdWireEntry("e9", cmdEndRecord({ cmdId: ID, output: { entries: [notify("finished")] } }))],
      },
    });
    await w.setProps({ agent: agentOf(s) });
    const cards = w.findAll(".msg-cmd");
    expect(cards).toHaveLength(1); // real card only — placeholder gone
    expect(cards[0]?.text()).toContain("finished");
    expect(store.placeholders).toHaveLength(0);
  });

  it("legacy stream (custom tombstones without cmd) renders zero command cards", () => {
    const tomb = { ...cmdWireEntry("e1", undefined), customType: "subagent:web-tool-timing" };
    const a = agentOf(stateWith(baseMsgs([userWireEntry("m1", T0, "hi"), tomb])));
    const w = mountTx(a);
    expect(w.find(".msg-cmd").exists()).toBe(false);
  });
});
