import { describe, expect, it } from "vitest";
import { createEventTap } from "../../../src/web-hub/agent/event-tap.js";
import { LIMITS, type WireEvent } from "../../../src/web-hub/protocol/messages.js";

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
    const { tap } = harness();
    tap.resetForSession(Number.NaN);
    expect(Number.isNaN(tap.costUsd())).toBe(true);
    tap.setBaseCost(1);
    const streaming = { role: "assistant", timestamp: 5, content: [{ type: "text", text: "par" }] };
    tap.handle({ type: "message_start", message: streaming });
    tap.handle({
      type: "message_update",
      message: streaming,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "t" },
    });
    expect(tap.inflight()?.message).toMatchObject({ role: "assistant", timestamp: 5 });
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
});
