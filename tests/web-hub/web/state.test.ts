import { describe, expect, it } from "vitest";
import { initialState, messageKey, needsSubscribe, reduce, selectedAgent } from "../../../src/web-hub/web/state.js";

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

  it("unknown events and malformed ev are ignored (same state object)", () => {
    const s = loaded();
    expect(reduce(s, { event: "nope", data: {} })).toBe(s);
    expect(reduce(s, { event: "ev", data: { agentKey: "A", seq: "x", e: {} } })).toBe(s);
    expect(reduce(s, { event: "ev", data: { agentKey: "Z", seq: 1, e: { type: "turn_start" } } })).toBe(s);
  });
});
