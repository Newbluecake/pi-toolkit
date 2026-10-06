import { describe, expect, it } from "vitest";
import {
  initialState,
  messageKey,
  needsSubscribe,
  reduce,
  selectedAgent,
} from "../../../src/web-hub/ui/src/logic/state.js";

type Msg = { event: string; data: any; id?: number };
const run = (msgs: Msg[], s = initialState()) => msgs.reduce((acc, m) => reduce(acc, m), s);

const card = (agentKey: string, extra: Record<string, unknown> = {}) => ({
  agentKey,
  kind: "tui",
  pid: 1,
  cwd: "/tmp/p",
  state: "live",
  pluginVersion: "1.0.0",
  outdated: false,
  session: {
    sessionId: "s1",
    sessionFile: "/tmp/s1.jsonl",
    cwd: "/tmp/p",
    reason: "startup",
    leafId: null,
    mode: "tui",
  },
  prompts: [],
  ...extra,
});

const userEntry = (id: string, ts: number, text = "hi") => ({
  id,
  parentId: null,
  type: "message",
  timestamp: new Date(ts).toISOString(),
  message: { role: "user", content: text, timestamp: ts },
});

/** hello + agents + subscribing + history(fromSeq) ⇒ agent A loaded. */
function loaded(historyExtra: Record<string, unknown> = {}, fromSeq = 10) {
  return run([
    { event: "hello", data: { clientId: "c1" } },
    { event: "agents", data: [card("A")] },
    { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
    { event: "subscribed", data: { agentKey: "A" } },
    {
      event: "history",
      data: {
        agentKey: "A",
        entries: [userEntry("e1", 1000)],
        tailMessages: [],
        fromSeq,
        hasMore: false,
        source: "file",
        ...historyExtra,
      },
    },
  ]);
}
const A = (s: ReturnType<typeof initialState>) => s.agents.get("A")!;
const ev = (seq: number, e: Record<string, unknown>): Msg => ({ event: "ev", data: { agentKey: "A", seq, e } });

describe("state.reduce", () => {
  it("is pure: never mutates the input state", () => {
    const s0 = loaded();
    const snapshot = { items: A(s0).items.length, lastSeq: A(s0).lastSeq, streaming: A(s0).streaming };
    reduce(s0, ev(10, { type: "message_start", message: { role: "assistant", content: [], timestamp: 5 } }));
    reduce(s0, { event: "agent_down", data: { agentKey: "A", reason: "x" } });
    expect({ items: A(s0).items.length, lastSeq: A(s0).lastSeq, streaming: A(s0).streaming }).toEqual(snapshot);
    expect(A(s0).down).toBe(false);
  });

  it("agents: full list, auto-selects the first live agent, records SSE id", () => {
    const s = reduce(initialState(), { event: "agents", data: { agents: [card("A"), card("B")] }, id: 7 });
    expect(s.order).toEqual(["A", "B"]);
    expect(s.selected).toBe("A");
    expect(s.lastEventId).toBe(7);
  });

  it("text/thinking deltas accumulate to the final text", () => {
    let s = loaded();
    s = run(
      [
        ev(10, { type: "message_start", message: { role: "assistant", content: [], timestamp: 2000 } }),
        ev(11, { type: "message_update", contentIndex: 0, deltaType: "thinking_delta", delta: "hmm " }),
        ev(12, { type: "message_update", contentIndex: 0, deltaType: "thinking_delta", delta: "ok" }),
        ev(13, { type: "message_update", contentIndex: 1, deltaType: "text_delta", delta: "Hel" }),
        ev(14, { type: "message_update", contentIndex: 1, deltaType: "text_delta", delta: "lo " }),
        ev(15, {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "world" },
        }),
      ],
      s,
    );
    expect(A(s).streaming.content).toEqual([
      { type: "thinking", thinking: "hmm ok" },
      { type: "text", text: "Hello world" },
    ]);
    const final = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm ok" },
        { type: "text", text: "Hello world" },
      ],
      timestamp: 2000,
    };
    s = reduce(s, ev(16, { type: "message_end", message: final }));
    expect(A(s).streaming).toBeNull();
    const last = A(s).items.at(-1)!;
    expect(last.message.content[1].text).toBe("Hello world");
    expect(last.key).toBe("assistant:2000");
  });

  it("deltas without a message_start (subscribed mid-stream) still accumulate", () => {
    const s = run(
      [
        ev(10, { type: "message_update", contentIndex: 0, delta: "a" }),
        ev(11, { type: "message_update", contentIndex: 0, delta: "b" }),
      ],
      loaded(),
    );
    expect(A(s).streaming.content).toEqual([{ type: "text", text: "ab" }]);
  });

  it("payload-less assistantMessageEvent updates (done/error) are ignored, no empty placeholder", () => {
    let s = run(
      [
        ev(10, { type: "message_start", message: { role: "assistant", content: [], timestamp: 2000 } }),
        ev(11, { type: "message_update", contentIndex: 0, delta: "hi" }),
      ],
      loaded(),
    );
    s = reduce(s, ev(12, { type: "message_update", assistantMessageEvent: { type: "done" } }));
    s = reduce(s, ev(13, { type: "message_update", assistantMessageEvent: { type: "error" } }));
    expect(A(s).streaming.content).toEqual([{ type: "text", text: "hi" }]);
    const noStream = reduce(loaded(), ev(14, { type: "message_update", assistantMessageEvent: { type: "done" } }));
    expect(A(noStream).streaming).toBeNull();
  });

  it("history inflight seeds the streaming message and live tools", () => {
    const s = loaded({
      inflight: {
        message: { role: "assistant", content: [{ type: "text", text: "par" }] },
        tools: [{ toolCallId: "t1", toolName: "bash", args: { command: "ls" }, partial: "a" }],
      },
    });
    const s2 = reduce(s, ev(10, { type: "message_update", contentIndex: 0, delta: "tial" }));
    expect(A(s2).streaming.content[0].text).toBe("partial");
    expect(A(s2).tools).toEqual([
      { toolCallId: "t1", toolName: "bash", args: { command: "ls" }, partial: "a", done: false },
    ]);
  });

  it("history then ev: dedupe by seq (seq < fromSeq and repeats ignored)", () => {
    let s = loaded({}, 10);
    const msg = (ts: number) => ({ type: "message_end", message: { role: "user", content: "x", timestamp: ts } });
    s = run([ev(8, msg(1)), ev(9, msg(2)), ev(10, msg(3)), ev(10, msg(4)), ev(11, msg(5))], s);
    expect(A(s).items.map((i) => i.message?.timestamp)).toEqual([1000, 3, 5]);
    expect(A(s).lastSeq).toBe(11);
  });

  it("non-custom messages are deduped by messageKey against history entries", () => {
    const s = reduce(
      loaded(),
      ev(10, { type: "message_end", message: { role: "user", content: "hi", timestamp: 1000 } }),
    );
    expect(A(s).items).toHaveLength(1);
  });

  it("custom messages are NOT key-deduped: two identical live customs both show", () => {
    const c = { role: "custom", customType: "probe:custom", content: "hello", display: true };
    const s = run(
      [ev(10, { type: "message_end", message: c }), ev(11, { type: "message_end", message: { ...c } })],
      loaded(),
    );
    expect(A(s).items.filter((i) => i.message?.role === "custom")).toHaveLength(2);
  });

  it("ev before history is ignored (hub replays buffered ev after history)", () => {
    const s = run([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [card("A")] },
      { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
      ev(3, { type: "message_end", message: { role: "user", content: "early", timestamp: 1 } }),
    ]);
    expect(A(s).items).toHaveLength(0);
    expect(A(s).history).toBe("waiting");
  });

  it("gap ⇒ needsResync ⇒ needsSubscribe returns the agent; history clears it", () => {
    let s = loaded();
    expect(needsSubscribe(s)).toBeUndefined();
    s = reduce(s, { event: "gap", data: { agentKey: "A", fromSeq: 12 } });
    expect(A(s).needsResync).toBe(true);
    expect(needsSubscribe(s)).toBe("A");
    s = reduce(s, { event: "subscribing", data: { agentKey: "A", clientId: "c1" } });
    expect(needsSubscribe(s)).toBeUndefined(); // in flight
    s = reduce(s, {
      event: "history",
      data: { agentKey: "A", entries: [], tailMessages: [], fromSeq: 20, hasMore: false, source: "file" },
    });
    expect(A(s).needsResync).toBe(false);
    expect(A(s).lastSeq).toBe(19);
  });

  it("a local seq jump (lost frames) also marks needsResync", () => {
    const s = run([ev(10, { type: "turn_start" }), ev(13, { type: "turn_end" })], loaded());
    expect(A(s).needsResync).toBe(true);
  });

  it("resync (global) marks every subscribed agent; hello (new client) forces resubscribe", () => {
    let s = reduce(loaded(), { event: "resync", data: {} });
    expect(A(s).needsResync).toBe(true);
    s = loaded();
    s = reduce(s, { event: "hello", data: { clientId: "c2" } });
    expect(A(s).sub).toBeNull();
    expect(needsSubscribe(s)).toBe("A");
  });

  it("stale / down / up card transitions", () => {
    let s = loaded();
    s = reduce(s, { event: "agent_stale", data: { agentKey: "A" } });
    expect(A(s).card.state).toBe("stale");
    expect(A(s).down).toBe(false);
    s = reduce(s, { event: "agent_down", data: { agentKey: "A", reason: "reaped" } });
    expect(A(s).down).toBe(true);
    expect(A(s).downReason).toBe("reaped");
    expect(needsSubscribe(reduce(s, { event: "gap", data: { agentKey: "A", fromSeq: 1 } }))).toBeUndefined();
    s = reduce(s, { event: "agent_up", data: { agent: card("A") } });
    expect(A(s).down).toBe(false);
    expect(A(s).card.state).toBe("live");
    expect(s.order).toEqual(["A"]);
    s = reduce(s, { event: "agent_up", data: { agent: card("B") } });
    expect(s.order).toEqual(["A", "B"]);
    s = reduce(s, { event: "agents", data: [card("B")] });
    expect(s.order).toEqual(["B"]);
    expect(s.selected).toBe("B");
  });

  it("append: merged by entryKey (non-custom deduped), custom never key-deduped, ids idempotent", () => {
    let s = reduce(loaded(), ev(10, { type: "message_end", message: { role: "user", content: "a", timestamp: 3000 } }));
    const custom = (id: string) => ({
      id,
      parentId: null,
      type: "custom_message",
      timestamp: "t",
      customType: "probe:custom",
      content: "hello",
      display: true,
    });
    const entries = [
      userEntry("e2", 3000, "a"),
      custom("c1"),
      custom("c2"),
      { id: "d1", parentId: null, type: "custom", timestamp: "t", customType: "x", dataKey: "k" },
    ];
    s = reduce(s, { event: "append", data: { agentKey: "A", entries } });
    const kinds = A(s).items.map((i) => i.kind + ":" + (i.entryId ?? i.message?.timestamp));
    expect(kinds).toEqual(["message:e1", "message:3000", "custom:c1", "custom:c2"]);
    // re-delivery of the same entries is a no-op
    const again = reduce(s, { event: "append", data: { agentKey: "A", entries } });
    expect(A(again).items).toHaveLength(4);
  });

  it("append before history is loaded is ignored", () => {
    const s = run([
      { event: "agents", data: [card("A")] },
      { event: "append", data: { agentKey: "A", entries: [userEntry("x", 1)] } },
    ]);
    expect(A(s).items).toHaveLength(0);
  });

  it("session change ⇒ transcript cleared, waits for new history; same session keeps it", () => {
    let s = loaded();
    const same = reduce(s, {
      event: "session",
      data: { agentKey: "A", session: { ...card("A").session, name: "renamed" } },
    });
    expect(A(same).items).toHaveLength(1);
    expect(A(same).session.name).toBe("renamed");
    s = reduce(s, {
      event: "session",
      data: {
        agentKey: "A",
        session: {
          sessionId: "s2",
          sessionFile: "/tmp/s2.jsonl",
          cwd: "/tmp/p",
          reason: "new",
          leafId: null,
          mode: "tui",
        },
      },
    });
    expect(A(s).items).toHaveLength(0);
    expect(A(s).history).toBe("waiting");
    expect(A(s).needsResync).toBe(true);
    expect(needsSubscribe(s)).toBe("A");
    // ev of the new session before its history must not leak in
    s = reduce(s, ev(1, { type: "message_end", message: { role: "user", content: "new", timestamp: 9 } }));
    expect(A(s).items).toHaveLength(0);
    s = reduce(s, {
      event: "history",
      data: {
        agentKey: "A",
        entries: [userEntry("n1", 9, "new")],
        tailMessages: [],
        fromSeq: 2,
        hasMore: false,
        source: "file",
      },
    });
    expect(A(s).items.map((i) => i.entryId)).toEqual(["n1"]);
  });

  it("cwd change with same sessionId/sessionFile counts as a session replacement (PV4 v3-2 cwd 双保险)", () => {
    let s = loaded();
    // same sessionId + sessionFile + cwd ⇒ untouched (现状一致)
    const same = reduce(s, {
      event: "session",
      data: { agentKey: "A", session: { ...card("A").session, name: "renamed" } },
    });
    expect(A(same).items).toHaveLength(1);
    expect(A(same).session.name).toBe("renamed");
    // cwd drift ⇒ scope invalidation: transcript dropped, fresh history awaited
    s = reduce(s, {
      event: "session",
      data: { agentKey: "A", session: { ...card("A").session, cwd: "/tmp/other" } },
    });
    expect(A(s).items).toHaveLength(0);
    expect(A(s).session.cwd).toBe("/tmp/other");
    expect(A(s).history).toBe("waiting");
    expect(A(s).needsResync).toBe(true);
    expect(needsSubscribe(s)).toBe("A");
  });

  it("history: tailMessages appended after entries, deduped against them; custom(data)/hidden skipped", () => {
    const s = loaded({
      entries: [
        userEntry("e1", 1000),
        { id: "d", parentId: "e1", type: "custom", timestamp: "t", customType: "x", dataKey: "k" },
        {
          id: "h",
          parentId: "d",
          type: "custom_message",
          timestamp: "t",
          customType: "x",
          content: "hidden",
          display: false,
        },
        { id: "k", parentId: "h", type: "compaction", timestamp: "t", summary: "S", firstKeptEntryId: "k" },
      ],
      tailMessages: [
        { role: "user", content: "hi", timestamp: 1000 },
        { role: "assistant", content: "unpersisted", timestamp: 1100 },
      ],
    });
    expect(A(s).items.map((i) => i.kind + ":" + (i.entryId ?? i.message.timestamp))).toEqual([
      "message:e1",
      "compaction:k",
      "message:1100",
    ]);
  });

  it("history error ⇒ history=error; retry re-arms subscribe", () => {
    let s = run([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [card("A")] },
      { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
      { event: "history", data: { agentKey: "A", error: "E_DEADLINE" } },
    ]);
    expect(A(s).history).toBe("error");
    expect(A(s).historyError).toBe("E_DEADLINE");
    s = reduce(s, { event: "subscribe_failed", data: { agentKey: "A", error: "E_AGENT_GONE" } });
    expect(needsSubscribe(s)).toBeUndefined(); // no automatic retry loop
    s = reduce(s, { event: "retry", data: { agentKey: "A" } });
    expect(needsSubscribe(s)).toBe("A");
  });

  it("paging prepends older entries without duplicates and updates hasMore", () => {
    let s = loaded({ hasMore: true, oldestEntryId: "e1" });
    s = reduce(s, { event: "paging", data: { agentKey: "A" } });
    expect(A(s).paging).toBe(true);
    s = reduce(s, {
      event: "page",
      data: {
        agentKey: "A",
        entries: [userEntry("e0", 500, "older"), userEntry("e1", 1000)],
        hasMore: false,
        oldestEntryId: "e0",
      },
    });
    expect(A(s).items.map((i) => i.entryId)).toEqual(["e0", "e1"]);
    expect(A(s).hasMore).toBe(false);
    expect(A(s).paging).toBe(false);
    expect(A(s).oldestEntryId).toBe("e0");
  });

  it("tools: execution start/update/end tracked; toolResult message_end drops the live entry", () => {
    let s = run(
      [
        ev(10, { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } }),
        ev(11, {
          type: "tool_execution_update",
          toolCallId: "t1",
          partialResult: { content: [{ type: "text", text: "a\n" }] },
        }),
      ],
      loaded(),
    );
    expect(A(s).tools[0]).toMatchObject({ toolCallId: "t1", partial: "a\n", done: false });
    s = reduce(
      s,
      ev(12, {
        type: "tool_execution_end",
        toolCallId: "t1",
        result: { content: [{ type: "text", text: "a\nb" }] },
        isError: false,
      }),
    );
    expect(A(s).tools[0]).toMatchObject({ done: true, isError: false });
    s = reduce(
      s,
      ev(13, {
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "bash",
          content: [{ type: "text", text: "a\nb" }],
          timestamp: 7,
        },
      }),
    );
    expect(A(s).tools).toHaveLength(0);
    expect(A(s).items.at(-1)!.key).toBe("toolResult:7:t1");
  });

  it("status / fleet / prompt update the agent; session_compact adds a separator once", () => {
    let s = run(
      [
        { event: "status", data: { agentKey: "A", status: { leafId: "x", busy: true, pending: false, costUsd: 0.5 } } },
        { event: "fleet", data: { agentKey: "A", runs: [{ runId: "r1" }] } },
        { event: "prompt", data: { agentKey: "A", prompts: [{ kind: "custom", since: 1 }] } },
        ev(10, { type: "session_compact", compactionEntry: { id: "k1", summary: "S" } }),
      ],
      loaded(),
    );
    expect(A(s).status.busy).toBe(true);
    expect(A(s).fleet).toHaveLength(1);
    expect(A(s).prompts[0]!.kind).toBe("custom");
    expect(A(s).items.at(-1)!.kind).toBe("compaction");
    s = reduce(s, {
      event: "append",
      data: {
        agentKey: "A",
        entries: [{ id: "k1", parentId: null, type: "compaction", timestamp: "t", summary: "S" }],
      },
    });
    expect(A(s).items.filter((i) => i.kind === "compaction")).toHaveLength(1);
  });

  it("select / unsubscribed; selectedAgent", () => {
    let s = run([{ event: "agents", data: [card("A"), card("B")] }]);
    expect(selectedAgent(s)?.key).toBe("A");
    s = reduce(s, { event: "select", data: { agentKey: "B" } });
    expect(s.selected).toBe("B");
    expect(reduce(s, { event: "select", data: { agentKey: "nope" } })).toBe(s);
    s = reduce(loaded(), { event: "unsubscribed", data: { agentKey: "A" } });
    expect(A(s).history).toBe("none");
  });

  it("messageKey mirrors protocol rules for non-custom roles", () => {
    expect(messageKey({ role: "user", timestamp: 5 })).toBe("user:5");
    expect(messageKey({ role: "toolResult", timestamp: 5, toolCallId: "c" })).toBe("toolResult:5:c");
    expect(messageKey({ role: "custom", customType: "x", content: "y" })).toBeUndefined();
  });

  describe("route (vue-plan.md v2.1 \u00a73.3 P1 compatibility extension)", () => {
    it("before any route event: legacy auto-select-first behavior is unchanged", () => {
      const s = reduce(initialState(), { event: "agents", data: [card("A"), card("B")] });
      expect(s.selected).toBe("A");
    });

    it("route to a present agent selects it, overriding auto-select", () => {
      let s = reduce(initialState(), { event: "agents", data: [card("A"), card("B")] });
      expect(s.selected).toBe("A");
      s = reduce(s, { event: "route", data: { agentKey: "B" } });
      expect(s.selected).toBe("B");
    });

    it("route to a null agentKey (list view) clears selection and stays cleared across further agents frames", () => {
      let s = reduce(initialState(), { event: "agents", data: [card("A")] });
      s = reduce(s, { event: "route", data: { agentKey: null } });
      expect(s.selected).toBeNull();
      s = reduce(s, { event: "agent_up", data: { agent: card("B") } });
      expect(s.selected).toBeNull(); // no auto-select once routed, even for a brand-new agent
    });

    it("deep link before the agents frame arrives: wanted is remembered and lands once agents shows up", () => {
      let s = reduce(initialState(), { event: "route", data: { agentKey: "A" } });
      expect(s.selected).toBeNull(); // not present yet
      s = reduce(s, { event: "agents", data: [card("A"), card("B")] });
      expect(s.selected).toBe("A"); // landed, not auto-selected "A" by list order coincidence
      s = reduce(s, { event: "agents", data: [card("B")] }); // A goes away
      expect(s.selected).toBeNull(); // no fallback to B
      s = reduce(s, { event: "agent_up", data: { agent: card("A") } }); // A comes back
      expect(s.selected).toBe("A");
    });

    it("routing to an unknown key twice is a no-op (same state object, no needless re-render trigger)", () => {
      const s0 = reduce(initialState(), { event: "agents", data: [card("A")] });
      const s1 = reduce(s0, { event: "route", data: { agentKey: "nope" } });
      expect(s1.selected).toBeNull();
      const s2 = reduce(s1, { event: "route", data: { agentKey: "nope" } });
      expect(s2).toBe(s1);
    });

    it("routed selection survives an intervening legacy select (no dispatcher does this in the new UI, but reduce() must stay total)", () => {
      let s = reduce(initialState(), { event: "agents", data: [card("A"), card("B")] });
      s = reduce(s, { event: "route", data: { agentKey: "B" } });
      s = reduce(s, { event: "select", data: { agentKey: "A" } }); // legacy event still works structurally
      expect(s.selected).toBe("A");
    });
  });

  it("unknown events and malformed ev are ignored (same state object)", () => {
    const s = loaded();
    expect(reduce(s, { event: "nope", data: {} })).toBe(s);
    expect(reduce(s, { event: "ev", data: { agentKey: "A", seq: "x", e: {} } })).toBe(s);
    expect(reduce(s, { event: "ev", data: { agentKey: "Z", seq: 1, e: { type: "turn_start" } } })).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// control plane (control-plan v2.1 §7.3/§7.7, package C4)
// ---------------------------------------------------------------------------

describe("state.reduce — control plane (§7.3/§7.7)", () => {
  const base = () => loaded();
  const send = (agentKey: string, item: Record<string, unknown>): Msg => ({
    event: "ctl_send",
    data: { agentKey, item },
  });
  const result = (agentKey: string, id: string, transition: unknown): Msg => ({
    event: "ctl_result",
    data: { agentKey, id, transition },
  });

  it("hub frame: caps negotiate control; state/nextVersion/supersede fields surface (§6.6/§7.3)", () => {
    let s = reduce(initialState(), { event: "hub", data: { version: "1.0.0", caps: ["ev.v1", "cmd.v1"] } });
    expect(s.control).toBe(true);
    expect(s.hubState).toBeUndefined();
    s = reduce(s, {
      event: "hub",
      data: {
        version: "1.0.0",
        caps: [],
        state: "restarting",
        nextVersion: "1.1.0",
        supersedePending: true,
        supersedeDeadlineAt: 1234,
        forced: true,
        draining: true,
      },
    });
    expect(s.control).toBe(false); // no cmd.v1 ⇒ read-only
    expect(s.hubState).toBe("restarting");
    expect(s.nextVersion).toBe("1.1.0");
    expect(s.supersedePending).toBe(true);
    expect(s.supersedeDeadlineAt).toBe(1234);
    expect(s.forced).toBe(true);
    expect(s.draining).toBe(true);
  });

  it("initial state: control off, no supersede flags", () => {
    const s = initialState();
    expect(s.control).toBe(false);
    expect(s.supersedePending).toBe(false);
  });

  it("ctl_send appends an optimistic item; same id replaces (retry)", () => {
    let s = base();
    s = reduce(s, send("A", { id: "c1", kind: "prompt", state: "sending", at: 1 }));
    s = reduce(s, send("A", { id: "c2", kind: "abort", state: "sending", at: 2 }));
    expect(A(s).pendingCtl.map((i) => i.id)).toEqual(["c1", "c2"]);
    s = reduce(s, send("A", { id: "c1", kind: "prompt", state: "sending", at: 3 }));
    expect(A(s).pendingCtl.map((i) => i.id)).toEqual(["c2", "c1"]);
    expect(A(s).pendingCtl[1]!.at).toBe(3);
  });

  it("ctl_result drives the pendingTransition machine: prompt ok ⇒ observed; abort ok ⇒ removed", () => {
    let s = base();
    s = reduce(s, send("A", { id: "c1", kind: "prompt", state: "sending", at: 1 }));
    s = reduce(s, send("A", { id: "c2", kind: "abort", state: "sending", at: 2 }));
    s = reduce(
      s,
      result("A", "c1", { type: "result", outcome: { ok: true, data: { delivery: "observed", behavior: "idle" } } }),
    );
    s = reduce(s, result("A", "c2", { type: "result", outcome: { ok: true, data: {} } }));
    expect(A(s).pendingCtl).toHaveLength(1);
    expect(A(s).pendingCtl[0]).toMatchObject({ id: "c1", state: "observed", behavior: "idle" });
  });

  it("ctl_retry / ctl_discard: failed item back to sending / removed", () => {
    let s = base();
    s = reduce(s, send("A", { id: "c1", kind: "prompt", state: "sending", at: 1 }));
    s = reduce(
      s,
      result("A", "c1", { type: "result", outcome: { ok: false, error: "E_RATE", retryable: true, effect: "none" } }),
    );
    expect(A(s).pendingCtl[0]).toMatchObject({ state: "failed", error: "E_RATE" });
    s = reduce(s, { event: "ctl_retry", data: { agentKey: "A", id: "c1" } });
    expect(A(s).pendingCtl[0]).toMatchObject({ id: "c1", state: "sending" });
    s = reduce(s, { event: "ctl_discard", data: { agentKey: "A", id: "c1" } });
    expect(A(s).pendingCtl).toEqual([]);
  });

  it("status frame: queue mirror lands on agent.queue; queueDropped transitions the optimistic item (§7.3)", () => {
    let s = base();
    s = reduce(s, send("A", { id: "c1", kind: "prompt", state: "queued", at: 1 }));
    s = reduce(s, {
      event: "status",
      data: {
        agentKey: "A",
        status: {
          leafId: null,
          busy: true,
          pending: true,
          queue: [{ id: "q1", text: "hi", deliver: "steer", source: "web", cmdId: "c1", at: 1 }],
        },
      },
    });
    expect(A(s).queue).toHaveLength(1);
    s = reduce(s, {
      event: "status",
      data: { agentKey: "A", status: { leafId: null, busy: false, pending: false, queue: [], queueDropped: ["c1"] } },
    });
    expect(A(s).queue).toEqual([]);
    expect(A(s).pendingCtl[0]).toMatchObject({ id: "c1", state: "dropped" });
  });

  it("status frame: queue omitted entirely (drained to empty, status.ts skips the field) still clears agent.queue (acc32-B2②)", () => {
    let s = base();
    s = reduce(s, {
      event: "status",
      data: {
        agentKey: "A",
        status: {
          leafId: null,
          busy: true,
          pending: true,
          queue: [{ id: "q1", text: "hi", deliver: "steer", source: "web", cmdId: "c1", at: 1 }],
        },
      },
    });
    expect(A(s).queue).toHaveLength(1);
    // The mirror drained to empty server-side: `status.ts` omits `queue` from the frame entirely
    // (it only assigns it "when non-empty") rather than sending `queue: []`.
    s = reduce(s, { event: "status", data: { agentKey: "A", status: { leafId: null, busy: false, pending: false } } });
    expect(A(s).queue).toEqual([]);
  });

  it("dialogs frame: slot overwrite; agents-frame cards carry dialogs too (§6.6)", () => {
    let s = reduce(initialState(), {
      event: "agents",
      data: [card("A", { dialogs: { epoch: "e0", open: [], closed: [] } })],
    });
    expect(A(s).dialogs).toEqual({ epoch: "e0", open: [], closed: [] });
    const open = [
      { dialogId: "ask:t1", source: "ask_user", toolCallId: "t1", questions: [], allowCancel: true, openedAt: 1 },
    ];
    s = reduce(s, { event: "dialogs", data: { agentKey: "A", epoch: "e1", open, closed: [] } });
    expect(A(s).dialogs).toEqual({ epoch: "e1", open, closed: [] });
  });

  it("agents-frame cards carry commands too (accfix-N2): a tab attaching after the fact still gets a palette", () => {
    // Mirrors the `dialogs` case above — `hub/http.ts`'s `toCard()` now copies `commands` onto
    // the wire `AgentCard` (accfix-N2), so a browser that (re)attaches after the agent already
    // announced its commands must see them immediately off the fleet snapshot, not only via a
    // live `commands` SSE event it may have missed.
    const commands = [{ name: "session", kind: "builtin", policy: "allow" }];
    let s = reduce(initialState(), { event: "agents", data: [card("A", { commands })] });
    expect(A(s).commands).toEqual(commands);

    // A subsequent `agent_up` refresh (e.g. after a reconnect) that still carries `commands`
    // must keep folding it in via `mergeCard`, not silently drop the previous value.
    const commands2 = [...commands, { name: "new", kind: "builtin", policy: "allow" }];
    s = reduce(s, { event: "agent_up", data: { agent: card("A", { commands: commands2 }) } });
    expect(A(s).commands).toEqual(commands2);
  });

  it("dialogs.closed settles this tab's dialog item: cmdId match ⇒ won (removed); otherwise lost (E_DIALOG_CLOSED)", () => {
    let s = base();
    s = reduce(s, send("A", { id: "c1", kind: "dialog_answer", dialogId: "ask:t1", state: "sending", at: 1 }));
    s = reduce(s, send("A", { id: "c2", kind: "dialog_answer", dialogId: "ask:t2", state: "sending", at: 2 }));
    s = reduce(s, {
      event: "dialogs",
      data: {
        agentKey: "A",
        epoch: "e1",
        open: [],
        closed: [
          { dialogId: "ask:t1", by: "web", outcome: "answered", cmdId: "c1", at: 10 },
          { dialogId: "ask:t2", by: "tui", outcome: "answered", at: 11 },
        ],
      },
    });
    expect(A(s).pendingCtl).toHaveLength(1);
    expect(A(s).pendingCtl[0]).toMatchObject({ id: "c2", state: "failed", error: "E_DIALOG_CLOSED", message: "tui" });
  });

  it("ctl frame: raw items on agent.ctl; entries merge into pending items by cmdId (never creating new ones)", () => {
    let s = base();
    s = reduce(s, send("A", { id: "c1", kind: "prompt", state: "observed", at: 1 }));
    const items = [
      { cmdId: "c1", op: "prompt", state: "queued", behavior: "steer", at: 1, updatedAt: 2 },
      { cmdId: "other-tab", op: "prompt", state: "started", at: 3, updatedAt: 3 },
    ];
    s = reduce(s, { event: "ctl", data: { agentKey: "A", epoch: "e1", sessionId: "s1", items } });
    expect(A(s).ctl).toEqual(items);
    expect(A(s).pendingCtl).toHaveLength(1); // "other-tab" never materializes a local item
    expect(A(s).pendingCtl[0]).toMatchObject({ id: "c1", state: "queued" });
    // consumed ⇒ the optimistic item is done
    s = reduce(s, {
      event: "ctl",
      data: {
        agentKey: "A",
        epoch: "e1",
        sessionId: "s1",
        items: [{ cmdId: "c1", op: "prompt", state: "consumed", at: 1, updatedAt: 4 }],
      },
    });
    expect(A(s).pendingCtl).toEqual([]);
  });

  it("commands frame: agent.commands slot (§4.6 completion/policies)", () => {
    let s = base();
    const items = [{ name: "compact", kind: "builtin", policy: "allow", policyBusy: "confirm" }];
    s = reduce(s, { event: "commands", data: { agentKey: "A", epoch: "e1", items } });
    expect(A(s).commands).toEqual(items);
  });

  it("cmd_late: terminates the matching pending item; command-kind arms lateQuery (v2.1 §7.7)", () => {
    let s = base();
    s = reduce(s, send("A", { id: "c1", kind: "steer_subagent", runId: "r_1", state: "unknown", at: 1 }));
    s = reduce(s, send("A", { id: "c2", kind: "command", name: "compact", state: "running", at: 2 }));
    s = reduce(s, { event: "cmd_late", data: { agentKey: "A", id: "c1", op: "steer_subagent", ok: true } });
    expect(A(s).pendingCtl.map((i) => i.id)).toEqual(["c2"]);
    s = reduce(s, { event: "cmd_late", data: { agentKey: "A", id: "c2", op: "command", ok: true } });
    expect(A(s).pendingCtl[0]).toMatchObject({ id: "c2", state: "querying", lateQuery: true });
    // unknown id ⇒ no-op (same object)
    const before = s;
    s = reduce(s, { event: "cmd_late", data: { agentKey: "A", id: "nope", op: "prompt", ok: true } });
    expect(s).toBe(before);
  });

  it("agent_down: in-flight pending items become unknown+offline (§3.5), settled ones untouched", () => {
    let s = base();
    s = reduce(s, send("A", { id: "c1", kind: "prompt", state: "sending", at: 1 }));
    s = reduce(s, send("A", { id: "c2", kind: "prompt", state: "observed", at: 2 }));
    s = reduce(s, { event: "agent_down", data: { agentKey: "A", reason: "reap" } });
    expect(A(s).pendingCtl[0]).toMatchObject({ id: "c1", state: "unknown", offline: true });
    expect(A(s).pendingCtl[1]).toMatchObject({ id: "c2", state: "observed" });
  });

  it("control events for unknown agents / malformed payloads are no-ops", () => {
    const s = base();
    expect(reduce(s, send("Z", { id: "c1", kind: "prompt", state: "sending", at: 1 }))).toBe(s);
    expect(reduce(s, { event: "ctl_send", data: { agentKey: "A", item: { noId: true } } })).toBe(s);
    expect(reduce(s, { event: "ctl_result", data: { agentKey: "A", id: "c1" } })).toBe(s);
    expect(reduce(s, { event: "dialogs", data: { agentKey: "Z", epoch: "e", open: [], closed: [] } })).toBe(s);
    expect(reduce(s, { event: "cmd_late", data: { agentKey: "A" } })).toBe(s);
  });
});

describe("state.reduce: spawns slot (web-hub-spawn SP11 / arch §8.2)", () => {
  const frame = (extra: Record<string, unknown> = {}) => ({
    items: [
      {
        spawnId: "sp1",
        state: "starting",
        createdAt: 1,
        updatedAt: 1,
        cwdLabel: "p",
        origin: { listener: "loopback", reqId: "r1" },
      },
    ],
    active: 1,
    max: 4,
    ...extra,
  });

  it("initialState().spawns is null (a hub with spawn disabled never sends the frame)", () => {
    expect(initialState().spawns).toBeNull();
  });

  it("a valid spawns frame overwrites the slot wholesale (overwrite semantics)", () => {
    let s = reduce(initialState(), { event: "spawns", data: frame() });
    expect(s.spawns).toMatchObject({ active: 1, max: 4 });
    const next = frame({ items: [], active: 0 });
    s = reduce(s, { event: "spawns", data: next });
    expect(s.spawns).toMatchObject({ items: [], active: 0 });
  });

  it("invalid payloads are ignored wholesale (same state reference, slot untouched)", () => {
    const s0 = reduce(initialState(), { event: "spawns", data: frame() });
    for (const bad of [
      { active: 1, max: 4 }, // items missing
      { items: "x", active: 1, max: 4 },
      { items: [], active: "1", max: 4 },
      { items: [], active: 1 }, // max missing
      { items: [{ state: "starting" }], active: 1, max: 4 }, // item without spawnId
      { items: [null], active: 1, max: 4 },
      { items: [{ spawnId: "sp1" }], active: 1, max: 4 }, // item without state
    ]) {
      expect(reduce(s0, { event: "spawns", data: bad }).spawns).toBe(s0.spawns);
    }
  });

  it("hello does NOT clear the slot (the hub re-sends the snapshot right after agents)", () => {
    let s = reduce(initialState(), { event: "spawns", data: frame() });
    s = reduce(s, { event: "hello", data: { clientId: "c2" } });
    expect(s.spawns).toMatchObject({ active: 1 });
    expect(s.clientId).toBe("c2");
  });
});

// ---------------------------------------------------------------------------
// fleet-drawer F5 appendix: pins the main-session halves of the §6.5 refactor.
// `historyCore`/`pageCore`/`eventCore` were extracted from applyHistory/applyPage/applyEvent
// (shared with RunTxState now) — the behaviors below moved through that refactor and had no
// direct pin before.
// ---------------------------------------------------------------------------

describe("state.reduce — main-session pins across the F5 kernel extraction (fleet-drawer §6.5)", () => {
  it("model_select / session_info_changed still patch the MAIN agent's session+card (agent-only wrapper cases)", () => {
    let s = loaded();
    s = run(
      [
        ev(10, { type: "session_info_changed", name: "renamed" }),
        ev(11, { type: "model_select", model: { provider: "prov", id: "mid" } }),
      ],
      s,
    );
    expect(A(s).session).toMatchObject({ name: "renamed", model: { provider: "prov", id: "mid" } });
    expect(A(s).card.session).toBe(A(s).session);
    // without a session slot they stay inert (no crash, same agent object semantics)
    const bare = run([{ event: "agents", data: [{ ...card("A"), session: undefined }] }]);
    const bareNext = run([ev(5, { type: "session_info_changed", name: "x" })], bare);
    expect(bareNext.agents.get("A")!.session).toBeUndefined();
  });

  it("hello keeps runTx content (§6.5: only useHub's runSubs clear — the reducer slot survives for the reconnect badge)", () => {
    let s = run(
      [
        { event: "run_select", data: { agentKey: "A", runId: "r_AB12CD34" } },
        { event: "run_subscribing", data: { agentKey: "A", runId: "r_AB12CD34", at: 1, retries: 0 } },
        {
          event: "run_history",
          data: {
            agentKey: "A",
            runId: "r_AB12CD34",
            entries: [userEntry("e1", 1000)],
            tailMessages: [],
            fromSeq: 4,
            hasMore: false,
            source: "live",
            terminal: false,
            status: "running",
            live: true,
          },
        },
      ],
      loaded(),
    );
    s = reduce(s, { event: "hello", data: { clientId: "c2" } });
    expect(s.clientId).toBe("c2");
    expect(s.agents.get("A")!.sub).toBeNull(); // main sub cleared (pre-existing behavior)
    expect(s.agents.get("A")!.runTx?.items.map((i: any) => i.entryId)).toEqual(["e1"]); // runTx untouched
  });

  it("fleet frame keeps runSel/runTx and never resurrects a dropped runTx", () => {
    const selected = run([{ event: "run_select", data: { agentKey: "A", runId: "r_AB12CD34" } }], loaded());
    const s = run(
      [
        {
          event: "fleet",
          data: { agentKey: "A", runs: [{ runId: "r_AB12CD34", status: "running", terminal: false }] },
        },
      ],
      selected,
    );
    expect(s.agents.get("A")!.runSel).toBe("r_AB12CD34");
    expect(s.agents.get("A")!.fleet).toHaveLength(1);
    const noTx = run([{ event: "fleet", data: { agentKey: "A", runs: [] } }], selected);
    expect(noTx.agents.get("A")!.runTx).toBeNull(); // no run_subscribing ever ran ⇒ fleet must not invent one
    expect(noTx.agents.get("A")!.runSel).toBe("r_AB12CD34");
  });
});

// ---------------------------------------------------------------------------
// web-hub-delete-session plan v2 §2.3/§5.1/§7.2: `agent_removed` and `removed`'s interaction
// with `agents`/`agent_up` reappearance.
// ---------------------------------------------------------------------------

describe("state.reduce: agent_removed (web-hub-delete-session plan v2 §5.1)", () => {
  it("initialState().removed is an empty set", () => {
    expect(initialState().removed.size).toBe(0);
  });

  it("drops the key from agents/order and records it in removed; clears the selection", () => {
    let s = run([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [card("A"), card("B")] },
      { event: "select", data: { agentKey: "A" } },
    ]);
    expect(s.selected).toBe("A");
    s = reduce(s, { event: "agent_removed", data: { agentKey: "A" } });
    expect(s.agents.has("A")).toBe(false);
    expect(s.order).toEqual(["B"]);
    expect(s.removed.has("A")).toBe(true);
    expect(s.selected).toBe("B"); // withSelection auto-picks the next live agent
  });

  it("is idempotent: a repeat agent_removed for an already-gone key only touches removed once", () => {
    let s = run([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [card("A")] },
    ]);
    s = reduce(s, { event: "agent_removed", data: { agentKey: "A" } });
    const afterFirst = s;
    s = reduce(s, { event: "agent_removed", data: { agentKey: "A" } });
    expect(s).toBe(afterFirst); // no-op ⇒ same-state invariant
  });

  it("a missing/non-string agentKey is a no-op", () => {
    const s0 = run([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [card("A")] },
    ]);
    expect(reduce(s0, { event: "agent_removed", data: {} })).toBe(s0);
    expect(reduce(s0, { event: "agent_removed", data: { agentKey: 5 } })).toBe(s0);
  });

  it("a reappearing agents snapshot clears the key from removed", () => {
    let s = run([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [card("A")] },
    ]);
    s = reduce(s, { event: "agent_removed", data: { agentKey: "A" } });
    expect(s.removed.has("A")).toBe(true);
    s = reduce(s, { event: "agents", data: [card("A")] });
    expect(s.agents.has("A")).toBe(true);
    expect(s.removed.has("A")).toBe(false);
  });

  it("a reappearing agent_up clears the key from removed; the fresh card is newAgent (sub:null, history:none)", () => {
    let s = run([
      { event: "hello", data: { clientId: "c1" } },
      { event: "agents", data: [card("A")] },
    ]);
    s = reduce(s, { event: "agent_removed", data: { agentKey: "A" } });
    s = reduce(s, { event: "agent_up", data: { agent: card("A") } });
    expect(s.removed.has("A")).toBe(false);
    const a = s.agents.get("A")!;
    expect(a.sub).toBeNull();
    expect(a.history).toBe("none");
  });

  it("removed is bounded (FIFO cap 64): the oldest entry drops once the cap is exceeded", () => {
    let s = initialState();
    for (let i = 0; i < 65; i++) {
      s = reduce(s, { event: "agent_removed", data: { agentKey: `k${i}` } });
    }
    expect(s.removed.size).toBe(64);
    expect(s.removed.has("k0")).toBe(false); // oldest evicted
    expect(s.removed.has("k64")).toBe(true); // newest kept
  });
});
