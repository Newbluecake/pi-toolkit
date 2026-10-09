import { describe, expect, it } from "vitest";
import { ASK_USER_MARKER } from "../../../src/ask-user/channel-handler.js";
import { createEventTap } from "../../../src/web-hub/agent/event-tap.js";
import { LIMITS, type WireEvent } from "../../../src/web-hub/protocol/messages.js";
import { initialState, reduce } from "../../../src/web-hub/ui/src/logic/state.js";

function harness() {
  const out: Array<{ e: WireEvent; droppable: boolean }> = [];
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  let seq = 0;
  let now = 1_000;
  const tap = createEventTap(
    (e, droppable) => {
      seq += 1;
      out.push({ e, droppable });
    },
    {
      now: () => now,
      setTimer: (ms, fn) => {
        const t = { ms, fn, cancelled: false };
        timers.push(t);
        return { cancel: () => (t.cancelled = true) };
      },
      currentSeq: () => seq,
    },
  );
  const fire = (ms: number): void => {
    for (const t of timers.splice(0)) if (!t.cancelled && t.ms === ms) t.fn();
  };
  return { tap, out, timers, fire, setNow: (n: number) => (now = n) };
}

const delta = (type: string, contentIndex: number, d: string, extra: Record<string, unknown> = {}) => ({
  type: "message_update",
  message: {},
  assistantMessageEvent: { type, contentIndex, delta: d, partial: {}, ...extra },
});

describe("event tap — message_update", () => {
  it("text/thinking/toolcall deltas become delta-only events, coalesced per kind+contentIndex over 50ms", () => {
    const { tap, out, timers, fire } = harness();
    tap.handle(delta("text_delta", 0, "a"));
    tap.handle(delta("text_delta", 0, "b"));
    tap.handle(delta("thinking_delta", 1, "t"));
    tap.handle(delta("toolcall_delta", 2, '{"x"'));
    tap.handle(delta("toolcall_delta", 2, ":1}"));
    expect(out).toHaveLength(0);
    expect(timers[0]!.ms).toBe(LIMITS.deltaCoalesceMs);
    fire(LIMITS.deltaCoalesceMs);
    expect(out.map((o) => o.e.assistantMessageEvent)).toEqual([
      { type: "text_delta", contentIndex: 0, delta: "ab" },
      { type: "thinking_delta", contentIndex: 1, delta: "t" },
      { type: "toolcall_delta", contentIndex: 2, delta: '{"x":1}' },
    ]);
    expect(out.every((o) => o.droppable && o.e.type === "message_update")).toBe(true);
  });

  it("a non-delta event flushes pending deltas first (wire order == pi order)", () => {
    const { tap, out } = harness();
    tap.handle(delta("text_delta", 0, "hello"));
    tap.handle({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "hello", partial: {} },
    });
    tap.handle({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
    expect(out.map((o) => (o.e.assistantMessageEvent as { type?: string } | undefined)?.type ?? o.e.type)).toEqual([
      "text_delta",
      "text_end",
      "tool_execution_start",
    ]);
    expect(out[1]!.droppable).toBe(false);
    expect(out[1]!.e.assistantMessageEvent).toEqual({ type: "text_end", contentIndex: 0, content: "hello" });
  });

  it("never reads the accumulated message nor the partial snapshot (Proxy getter count stays 0)", () => {
    const { tap, fire } = harness();
    let gets = 0;
    const trap = { get: () => (gets++, undefined), has: () => (gets++, false), ownKeys: () => (gets++, []) };
    const message = new Proxy({}, trap);
    const partial = new Proxy({}, trap);
    for (let i = 0; i < 100; i++) {
      tap.handle({
        type: "message_update",
        message,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial },
      });
    }
    tap.handle({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "done", reason: "stop", message: partial },
    });
    fire(LIMITS.deltaCoalesceMs);
    expect(gets).toBe(0);
  });
});

// ------------------------------------------------- exactly-once streaming content
// pi-agent-core emits assistant `message_start` as a shallow copy of the live partial
// (agent-loop.js "start" case: `emit({ type: "message_start", message: { ...partialMessage } })`)
// whose `content` array pi-ai keeps mutating ahead of pi's awaited dispatch; the browser seeds
// its streaming clone from the wire message_start and then applies every delta again. These
// tests pin the fix: assistant message_start carries `content: []`, and the snapshot's
// inflight message is accumulated from emitted payloads only.

/** Minimal UI-reducer harness (same shape as tests/web-hub/ui/logic-state.test.ts). */
function uiLoaded(historyExtra: Record<string, unknown> = {}) {
  const card = {
    agentKey: "A",
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
  };
  const frames: Array<{ event: string; data: any }> = [
    { event: "hello", data: { clientId: "c1" } },
    { event: "agents", data: [card] },
    { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
    { event: "subscribed", data: { agentKey: "A" } },
    {
      event: "history",
      data: {
        agentKey: "A",
        entries: [],
        tailMessages: [],
        fromSeq: 0, // wire evs below start at seq 1
        hasMore: false,
        source: "file",
        ...historyExtra,
      },
    },
  ];
  return frames.reduce((acc: any, m: any) => reduce(acc, m), initialState());
}

const uiAgent = (s: any): any => s.agents.get("A");

/** Replay captured wire events (in order, seq 1..n) through the real UI reducer. */
function replayWire(wire: Array<{ e: WireEvent }>, s = uiLoaded()): any {
  return wire.reduce(
    (acc: any, o: any, i: number) => reduce(acc, { event: "ev", data: { agentKey: "A", seq: i + 1, e: o.e } }),
    s,
  );
}

describe("event tap — exactly-once streaming (agent-loop shared-array race)", () => {
  it("(a) content mutated into message_start is stripped on the wire; UI replay shows the delta once", () => {
    const { tap, out, fire } = harness();
    const live: { role: string; timestamp: number; content: Array<unknown> } = {
      role: "assistant",
      timestamp: 5,
      content: [],
    };
    tap.handle({ type: "message_start", message: live });
    // pi-ai's push stream already appended the first thinking chunk to the shared
    // array by the time pi's awaited dispatch reaches our message_start observer.
    live.content.push({ type: "thinking", thinking: "All" });
    tap.handle({
      type: "message_update",
      message: live,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "All" },
    });
    tap.handle({
      type: "message_update",
      message: live,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: " nil-safe." },
    });
    fire(LIMITS.deltaCoalesceMs);
    expect(out[0]!.e.type).toBe("message_start");
    expect(out[0]!.e.message).toMatchObject({ role: "assistant", timestamp: 5 });
    expect((out[0]!.e.message as { content: unknown[] }).content).toEqual([]);
    // Replay the wire through the real reducer: "All" appears exactly once.
    const streaming = uiAgent(replayWire(out)).streaming;
    expect(streaming.content).toEqual([{ type: "thinking", thinking: "All nil-safe." }]);
  });

  it("(b) post-message_start mutations of the shared content array never reach the snapshot", () => {
    const { tap, fire } = harness();
    const live: { role: string; timestamp: number; content: Array<unknown> } = {
      role: "assistant",
      timestamp: 1,
      content: [],
    };
    tap.handle({ type: "message_start", message: live });
    tap.handle(delta("text_delta", 0, "Hel"));
    fire(LIMITS.deltaCoalesceMs); // emitted
    // pi mutates the shared array ahead of emission (deltas still in pi's queue)
    live.content.push({ type: "text", text: "Hello world" });
    tap.flush();
    expect(tap.inflight()?.message?.content).toEqual([{ type: "text", text: "Hel" }]);
  });

  it("(b) snapshot mid-stream + later deltas reconstruct the text exactly once (UI reducer)", () => {
    const { tap, out, fire } = harness();
    tap.handle({ type: "message_start", message: { role: "assistant", timestamp: 1, content: [] } });
    tap.handle(delta("text_delta", 0, "Hel"));
    fire(LIMITS.deltaCoalesceMs); // snapshot point: flush → inflight (what snapshot_reply carries)
    const snap = uiLoaded({ inflight: { tools: [], message: tap.inflight()!.message! } });
    const consumed = out.length;
    tap.handle(delta("text_delta", 0, "lo world"));
    fire(LIMITS.deltaCoalesceMs);
    tap.handle({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello world" },
    });
    const streaming = uiAgent(replayWire(out.slice(consumed), snap)).streaming;
    expect(streaming.content).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("(c) end events replace the accumulated blocks (text_end content, toolcall_end toolCall)", () => {
    const { tap, fire } = harness();
    tap.handle({ type: "message_start", message: { role: "assistant", timestamp: 1, content: [] } });
    tap.handle(delta("text_delta", 0, "draf"));
    tap.handle(delta("toolcall_delta", 1, '{"a"'));
    fire(LIMITS.deltaCoalesceMs);
    tap.handle({
      type: "message_update",
      message: {},
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: { id: "c1", name: "bash", arguments: { a: 1 } },
      },
    });
    tap.handle({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "final text" },
    });
    expect(tap.inflight()?.message?.content).toEqual([
      { type: "text", text: "final text" },
      { type: "toolCall", id: "c1", name: "bash", arguments: { a: 1 } },
    ]);
    // agent_end drops the half-accumulated message entirely
    tap.handle({ type: "agent_end" });
    expect(tap.inflight()).toBeUndefined();
  });

  it("(d) non-assistant message_start keeps its content and never seeds the accumulator", () => {
    const { tap, out } = harness();
    tap.handle({ type: "message_start", message: { role: "user", timestamp: 3, content: "hi" } });
    expect(out[0]!.e.message).toEqual({ role: "user", timestamp: 3, content: "hi" });
    expect(tap.inflight()).toBeUndefined();
    tap.handle({ type: "message_start", message: { role: "toolResult", timestamp: 4, toolCallId: "c" } });
    expect((out[1]!.e.message as { role: string }).role).toBe("toolResult");
    expect(tap.inflight()).toBeUndefined();
  });

  it("(e) accumulated blocks are capped at textTruncateBytes and flagged truncated", () => {
    const { tap, fire } = harness();
    tap.handle({ type: "message_start", message: { role: "assistant", timestamp: 1, content: [] } });
    const chunk = "y".repeat(1024);
    for (let i = 0; i < 40; i++) tap.handle(delta("text_delta", 0, chunk)); // 40 KiB
    fire(LIMITS.deltaCoalesceMs);
    for (let i = 0; i < 40; i++) tap.handle(delta("text_delta", 0, chunk)); // +40 KiB > 64 KiB
    fire(LIMITS.deltaCoalesceMs);
    const block = tap.inflight()?.message?.content?.[0] as { text: string; truncated?: boolean };
    expect(Buffer.byteLength(block.text)).toBe(LIMITS.textTruncateBytes);
    expect(block.truncated).toBe(true);
  });
});

describe("event tap — tools", () => {
  it("tool_execution_update is latest-wins per toolCallId over 250ms; end cancels a pending update", () => {
    const { tap, out, fire } = harness();
    tap.handle({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} });
    tap.handle({ type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: {} });
    for (const p of ["1", "12", "123"]) {
      tap.handle({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", args: {}, partialResult: p });
    }
    tap.handle({ type: "tool_execution_update", toolCallId: "c2", toolName: "read", args: {}, partialResult: "r" });
    expect(tap.inflight()?.tools.find((t) => t.toolCallId === "c1")?.partial).toBe("123");
    tap.handle({ type: "tool_execution_end", toolCallId: "c2", toolName: "read", result: "done", isError: false });
    out.length = 0;
    fire(LIMITS.toolUpdateMs);
    expect(out).toHaveLength(1);
    expect(out[0]!.e).toEqual({
      type: "tool_execution_update",
      toolCallId: "c1",
      toolName: "bash",
      partialResult: "123",
    });
    expect(out[0]!.droppable).toBe(true);
    expect(tap.inflight()?.tools.map((t) => t.toolCallId)).toEqual(["c1"]);
  });

  it("tool-duration plan: start carries startedAt, end carries durationMs (agent clock, ≥0)", () => {
    const { tap, out, setNow } = harness();
    tap.handle({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} });
    expect(out[0]!.e).toMatchObject({ type: "tool_execution_start", toolCallId: "c1", startedAt: 1_000 });
    setNow(2_500);
    tap.handle({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: "ok", isError: false });
    expect(out[1]!.e).toMatchObject({ type: "tool_execution_end", toolCallId: "c1", durationMs: 1_500 });
    // end WITHOUT a seen start (only an update arrived first): no durationMs on the wire
    tap.handle({ type: "tool_execution_update", toolCallId: "c2", toolName: "read", partialResult: "p" });
    tap.handle({ type: "tool_execution_end", toolCallId: "c2", toolName: "read", result: "r", isError: false });
    const end2 = out.find((o) => o.e.type === "tool_execution_end" && o.e.toolCallId === "c2")!;
    expect(end2.e.durationMs).toBeUndefined();
    // a backwards clock clamps to 0, never a negative duration
    tap.handle({ type: "tool_execution_start", toolCallId: "c3", toolName: "edit", args: {} });
    setNow(1_000);
    tap.handle({ type: "tool_execution_end", toolCallId: "c3", toolName: "edit", result: "r", isError: false });
    expect(out.find((o) => o.e.type === "tool_execution_end" && o.e.toolCallId === "c3")!.e.durationMs).toBe(0);
  });

  it("tool-duration plan: drainToolTimings hands over completed durations and resets (drain-twice ⇒ empty)", () => {
    const { tap, setNow } = harness();
    tap.handle({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} });
    setNow(1_400);
    tap.handle({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: "ok", isError: false });
    expect(tap.drainToolTimings()).toEqual(new Map([["c1", 400]]));
    expect(tap.drainToolTimings().size).toBe(0);
    // resetForSession drops anything still pending
    tap.handle({ type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: {} });
    setNow(2_000);
    tap.handle({ type: "tool_execution_end", toolCallId: "c2", toolName: "bash", result: "ok", isError: false });
    tap.resetForSession(0);
    expect(tap.drainToolTimings().size).toBe(0);
  });

  it("> 64 KiB strings are truncated and flagged", () => {
    const { tap, out } = harness();
    const big = "y".repeat(100 * 1024);
    tap.handle({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result: { content: [{ type: "text", text: big }] },
      isError: false,
    });
    const e = out[0]!.e;
    expect(e.truncated).toBe(true);
    const text = (e.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(Buffer.byteLength(text)).toBe(LIMITS.textTruncateBytes);
  });

  it("base64 images are never forwarded", () => {
    const { tap, out } = harness();
    tap.handle({
      type: "message_end",
      message: {
        role: "user",
        timestamp: 1,
        content: [{ type: "image", mimeType: "image/png", data: "A".repeat(1000) }],
      },
    });
    const msg = out[0]!.e.message as { content: Array<{ data: string }> };
    expect(msg.content[0]!.data).toBe("");
    expect(out[0]!.e.truncated).toBe(true);
  });
});

describe("event tap — recent / inflight / prompts / cost", () => {
  it("recent ring keeps the last 64 message_end with the seq the sink assigned", () => {
    const { tap } = harness();
    for (let i = 0; i < 70; i++) tap.handle({ type: "message_end", message: { role: "user", timestamp: i } });
    const recent = tap.recent();
    expect(recent).toHaveLength(LIMITS.recentMessages);
    expect(recent[0]).toEqual({ seq: 7, message: { role: "user", timestamp: 6 } });
    expect(recent.at(-1)).toEqual({ seq: 70, message: { role: "user", timestamp: 69 } });
  });

  it("inflight carries the streaming assistant message and clears on its message_end; cost accrues", () => {
    const { tap, fire } = harness();
    tap.resetForSession(Number.NaN);
    expect(Number.isNaN(tap.costUsd())).toBe(true);
    tap.setBaseCost(1);
    // NOTE: `content` here mimics pi's live partial whose shared array pi-ai already
    // mutated ahead of the dispatch — the tap must NOT count it (see the race suite below).
    const streaming = { role: "assistant", timestamp: 5, content: [{ type: "text", text: "par" }] };
    tap.handle({ type: "message_start", message: streaming });
    tap.handle({
      type: "message_update",
      message: streaming,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "t" },
    });
    fire(LIMITS.deltaCoalesceMs);
    expect(tap.inflight()?.message).toMatchObject({ role: "assistant", timestamp: 5 });
    // only the EMITTED delta — the pre-populated "par" never leaks into the snapshot
    expect(tap.inflight()?.message?.content).toEqual([{ type: "text", text: "t" }]);
    tap.handle({ type: "message_end", message: { ...streaming, usage: { cost: { total: 0.5 } } } });
    expect(tap.inflight()).toBeUndefined();
    expect(tap.costUsd()).toBe(1.5);
  });

  it("ui_prompt start/end pair up LIFO, nested prompts supported", () => {
    const { tap, setNow } = harness();
    setNow(10);
    tap.handle({ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "A" });
    setNow(20);
    tap.handle({ type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" });
    expect(tap.prompts()).toEqual([
      { kind: "select", title: "A", since: 10 },
      { kind: "custom", since: 20 },
    ]);
    tap.handle({ type: "ui_prompt_end", reason: "ui_prompt", kind: "custom" });
    expect(tap.prompts()).toEqual([{ kind: "select", title: "A", since: 10 }]);
    tap.handle({ type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "A" });
    expect(tap.prompts()).toEqual([]);
  });

  it("heavy events are projected to their whitelisted fields only", () => {
    const { tap, out } = harness();
    tap.handle({
      type: "turn_end",
      turnIndex: 2,
      message: { role: "assistant" },
      toolResults: [{}],
      messageEntryId: "m1",
      toolResultEntryIds: ["t1"],
      entries: [{}],
    });
    tap.handle({ type: "agent_end", messages: [{ role: "user" }] });
    tap.handle({
      type: "model_select",
      model: { provider: "p", id: "m", cost: {} },
      previousModel: undefined,
      source: "set",
    });
    tap.handle({ type: "not_whitelisted", x: 1 });
    expect(out.map((o) => o.e)).toEqual([
      { type: "turn_end", turnIndex: 2, messageEntryId: "m1", toolResultEntryIds: ["t1"] },
      { type: "agent_end" },
      { type: "model_select", source: "set", model: { provider: "p", id: "m" } },
    ]);
  });

  it("resetForSession clears recent/inflight/prompts and cancels timers", () => {
    const { tap, timers } = harness();
    tap.handle({ type: "message_end", message: { role: "user", timestamp: 1 } });
    tap.handle({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: {} });
    tap.handle(delta("text_delta", 0, "x"));
    tap.handle({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
    tap.resetForSession(0);
    expect(tap.recent()).toEqual([]);
    expect(tap.inflight()).toBeUndefined();
    expect(tap.prompts()).toEqual([]);
    expect(timers.every((t) => t.cancelled)).toBe(true);
  });

  it("carries dialog attribution into prompt snapshots and sanitizes RPC markers", () => {
    const { tap, out } = harness();
    tap.handle({ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: ASK_USER_MARKER });
    expect(out[0]?.e).toMatchObject({ type: "ui_prompt_start", kind: "select", title: "ask_user" });
    const attributed = createEventTap(() => undefined, {
      now: () => 1,
      setTimer: () => ({ cancel: () => undefined }),
      attributePrompt: (event) => ({ ...event, title: "ask_user", dialogId: "ask:t" }),
    });
    attributed.handle({ type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" });
    expect(attributed.prompts()).toEqual([{ kind: "custom", since: 1, title: "ask_user", dialogId: "ask:t" }]);
    attributed.handle({ type: "ui_prompt_end", reason: "ui_prompt", kind: "custom" });
    expect(attributed.prompts()).toEqual([]);
    expect(out[0]?.e.type).toBe("ui_prompt_start");
  });

  it("does not invent dialog attribution without an open-dialog callback", () => {
    const { tap, out } = harness();
    tap.handle({ type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" });
    expect(out[0]?.e).toEqual({ type: "ui_prompt_start", kind: "custom" });
    expect(tap.prompts()).toEqual([{ kind: "custom", since: 1_000 }]);
  });
});
