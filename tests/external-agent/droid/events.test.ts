import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../../src/core/deadline.js";
import { createInitialState, reduce } from "../../../src/core/state-machine.js";
import type { DriverEvent, RunInput, RunState } from "../../../src/core/types.js";
import { createDroidMapper } from "../../../src/external-agent/droid/events.js";
import { FakeClock, FakeLedger, makeSpec } from "./fakes.js";

const SAMPLES = join(__dirname, "../../../docs/dev/external-agent/samples");
const budget = { ...DEFAULT_BUDGET, totalMs: 600_000, queueWaitMs: 20, totalGraceMs: 0 };

function sampleNotifications(file: string): unknown[] {
  const out: unknown[] = [];
  for (const line of readFileSync(join(SAMPLES, file), "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const frame = JSON.parse(line) as { type?: string; params?: { notification?: unknown } };
    if (frame.type === "notification" && frame.params?.notification !== undefined) out.push(frame.params.notification);
  }
  return out;
}

function makeMapper(resume = false) {
  const events: DriverEvent[] = [];
  const transcript: unknown[] = [];
  const ledger = new FakeLedger(makeSpec({}).external.pricing, {
    thinkingInOutput: true,
    cumulativeIncludesChild: false,
  });
  const completions: { reason: string; turnId?: string }[] = [];
  const toolResults: string[] = [];
  const mapper = createDroidMapper({
    emit: (e) => events.push(e),
    ledger,
    clock: new FakeClock(0),
    resume,
    modelRef: "droid/gpt-6-luna",
    appendTranscript: (e) => transcript.push(e),
    onTurnCompleted: (c) => completions.push(c),
    onToolResult: (id) => toolResults.push(id),
  });
  return { mapper, events, transcript, ledger, completions, toolResults };
}

/** 把 DriverEvent 序列喂真 reducer（acceptance ①）：全程不得出现 illegal。 */
function feedReducer(events: readonly DriverEvent[]): RunState {
  let at = 0;
  let state = reduce(
    createInitialState("r", 1, 0),
    { generation: 1, input: { kind: "enqueued", at: at++, budget } },
    budget,
  ).state;
  const apply = (input: RunInput): void => {
    state = reduce(state, { generation: 1, input: { ...input, at: at++ } as RunInput }, budget).state;
  };
  apply({ kind: "slot_acquired", at: 0 });
  apply({ kind: "phase_entered", at: 0, phase: "session_create" });
  apply({ kind: "session_created", at: 0, sessionId: "s" });
  apply({ kind: "phase_entered", at: 0, phase: "prompt_dispatch" });
  for (const event of events) apply({ kind: "session_event", at: 0, event });
  return state;
}

describe("droid/events 样本回放（acceptance ①：喂真 reducer 无 illegal）", () => {
  for (const file of [
    "27-jsonrpc-success-flow.jsonl",
    "30-jsonrpc-resume-deny.jsonl",
    "31-jsonrpc-deny-off.jsonl",
    "44-perm-approve.jsonl",
    "54-high-effort-thinking.jsonl",
    "10-jsonrpc-full-flow.jsonl",
  ]) {
    it(`S/${file} 回放无 illegal`, () => {
      const { mapper, events } = makeMapper();
      for (const n of sampleNotifications(file)) mapper.notify(n);
      expect(events.length).toBeGreaterThan(0);
      const state = feedReducer(events);
      expect(state.diag.lastWarn).toBeUndefined();
    });
  }

  it("S/27 turn1：turn_start → text_delta×2 → message_end → turn_end → settled；turn4 interrupt 去重", () => {
    const { mapper, events, completions } = makeMapper();
    for (const n of sampleNotifications("27-jsonrpc-success-flow.jsonl")) mapper.notify(n);
    expect(completions.map((c) => c.reason)).toEqual(["completed", "completed", "completed", "cancelled"]);
    const kinds = events.map((e) => e.t);
    expect(kinds[0]).toBe("turn_start");
    // turn1 文本增量
    const deltas = events.filter((e) => e.t === "text_delta").map((e) => (e as { delta: string }).delta);
    expect(deltas.slice(0, 2)).toEqual(["P", "ONG"]);
    expect(deltas).toContain("DONE");
    // interrupt 的重复 tool_result 只产生一个 tool_end
    const sleepToolEnds = events.filter(
      (e) => e.t === "tool_end" && (e as { toolCallId: string }).toolCallId === "call_xXq5nhYWwi7jMuxorAtqQZxb",
    );
    expect(sleepToolEnds).toHaveLength(1);
    expect(sleepToolEnds[0]).toMatchObject({ isError: true });
    // 渐进 input 取最后一次（riskLevel 出现的那帧）
    const starts = events.filter((e) => e.t === "tool_start");
    expect(starts.map((s) => (s as { argsPreview?: string }).argsPreview)).toContain("sleep 20");
    expect(mapper.lastAssistantText()).toBe("DONE");
  });

  it("S/44 turn 切分：工具结果后的下一次模型调用 ⇒ turn_end + turn_start", () => {
    const { mapper, events } = makeMapper();
    for (const n of sampleNotifications("44-perm-approve.jsonl")) mapper.notify(n);
    const kinds = events.map((e) => e.t);
    const turnEndIdx = kinds.indexOf("turn_end", kinds.indexOf("tool_end"));
    expect(turnEndIdx).toBeGreaterThan(-1);
    expect(kinds[turnEndIdx + 1]).toBe("turn_start");
  });

  it("S/31：Batch cancelled 第二条 tool_result 去重", () => {
    const { mapper, events } = makeMapper();
    for (const n of sampleNotifications("31-jsonrpc-deny-off.jsonl")) mapper.notify(n);
    const ends = events.filter(
      (e) => e.t === "tool_end" && (e as { toolCallId: string }).toolCallId === "call_M63mLaBEvzd7idkP32TEtTOt",
    );
    expect(ends).toHaveLength(1);
  });

  it("S/54 thinking：thinking_text_delta ⇒ thinking_delta；create_message thinking 块不重复发", () => {
    const { mapper, events } = makeMapper();
    for (const n of sampleNotifications("54-high-effort-thinking.jsonl")) mapper.notify(n);
    const thinking = events.filter((e) => e.t === "thinking_delta");
    const total = thinking.map((e) => (e as { delta: string }).delta).join("");
    expect(total).toContain("Explaining the trap question");
    // 流式 delta 已覆盖该 messageId ⇒ create_message 的 thinking 块不再补发（无重复全文）
    const occurrences = total.match(/Explaining the trap question/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("thinking 块兜底：无 delta 的 messageId ⇒ create_message 块全文补发一次", () => {
    const { mapper, events } = makeMapper();
    mapper.notify({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    mapper.notify({
      type: "create_message",
      message: {
        id: "m-1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "deep thought" },
          { type: "text", text: "answer" },
        ],
      },
    });
    const thinking = events.filter((e) => e.t === "thinking_delta");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toEqual({ t: "thinking_delta", delta: "deep thought" });
  });

  it("llm_only / context- 前缀 / __internal__ 前缀的 create_message 被过滤（不进事件流也不进 transcript）", () => {
    const { mapper, events, transcript } = makeMapper();
    mapper.notify({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    mapper.notify({
      type: "create_message",
      message: { id: "m-x", role: "user", content: [], visibility: "llm_only" },
    });
    mapper.notify({
      type: "create_message",
      message: { id: "context-m-y", role: "user", content: [{ type: "text", text: "inject" }] },
    });
    mapper.notify({
      type: "create_message",
      message: { id: "__internal__z", role: "user", content: [{ type: "text", text: "inject2" }] },
    });
    mapper.notify({
      type: "create_message",
      message: { id: "m-ok", role: "user", content: [{ type: "text", text: "real" }] },
    });
    expect(events.map((e) => e.t)).toEqual(["turn_start"]);
    expect(transcript).toHaveLength(1);
  });

  it("重复 turnId 的 agent_turn_completed 丢弃", () => {
    const { mapper, completions, events } = makeMapper();
    mapper.notify({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    const done = {
      type: "agent_turn_completed",
      reason: "completed",
      turnId: "t-1",
      tokenUsage: {
        inputTokens: 5,
        outputTokens: 2,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        factoryCredits: 3,
      },
      cumulativeTokenUsage: {
        inputTokens: 5,
        outputTokens: 2,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        factoryCredits: 3,
      },
    };
    mapper.notify(done);
    mapper.notify(done);
    expect(completions).toHaveLength(1);
    expect(events.filter((e) => e.t === "settled")).toHaveLength(1);
  });

  it("完成时补 open tool 的 tool_end（isError:true）", () => {
    const { mapper, events } = makeMapper();
    mapper.notify({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    mapper.notify({
      type: "tool_call",
      toolUse: { type: "tool_use", id: "call_1", name: "Execute", input: { command: "sleep 9" } },
    });
    mapper.notify({
      type: "tool_execution_phase_changed",
      toolUseId: "call_1",
      toolName: "Execute",
      phase: "executing",
    });
    mapper.notify({
      type: "agent_turn_completed",
      reason: "cancelled",
      turnId: "t-9",
      tokenUsage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        factoryCredits: 1,
      },
    });
    const ends = events.filter((e) => e.t === "tool_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ toolCallId: "call_1", toolName: "Execute", isError: true });
  });

  it("tool_result 先于任何 tool_call 到达 ⇒ 补 tool_start", () => {
    const { mapper, events } = makeMapper();
    mapper.notify({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    mapper.notify({ type: "tool_result", toolUseId: "call_z", content: "x", isError: false });
    expect(events.map((e) => e.t)).toEqual(["turn_start", "tool_start", "tool_end"]);
  });

  it("usage：实时增量在下一条 message_end 吐出；完成时对账补差；credits 进 external_meta", () => {
    const { mapper, events, ledger } = makeMapper();
    mapper.notify({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    mapper.notify({
      type: "session_token_usage_changed",
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        factoryCredits: 0,
      },
    });
    mapper.notify({
      type: "session_token_usage_changed",
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 10,
        cacheCreationTokens: 50,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        factoryCredits: 40,
      },
    });
    mapper.notify({
      type: "create_message",
      message: { id: "m-1", role: "assistant", content: [{ type: "text", text: "A" }] },
    });
    mapper.notify({
      type: "agent_turn_completed",
      reason: "completed",
      turnId: "t-1",
      tokenUsage: {
        inputTokens: 130,
        outputTokens: 12,
        cacheCreationTokens: 50,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        factoryCredits: 50,
      },
      cumulativeTokenUsage: {
        inputTokens: 130,
        outputTokens: 12,
        cacheCreationTokens: 50,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        factoryCredits: 50,
      },
    });
    const usageEvents = events.filter((e) => e.t === "message_end" && e.usage !== undefined);
    // message_end（实时增量 100/10/50）+ 对账补差（30/2/0）
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]).toMatchObject({ usage: { input: 100, output: 10, cacheWrite: 50 } });
    expect(usageEvents[1]).toMatchObject({ usage: { input: 30, output: 2 } });
    const meta = events.filter((e) => e.t === "external_meta").at(-1);
    expect(meta).toMatchObject({ meta: { provider: "droid", credits: 50 } });
    expect(ledger.totals().usage.input).toBe(130);
  });

  it("resume 首 turn 无基线：首条累计只记基线不出增量；完成时对账全量补记", () => {
    const { mapper, events } = makeMapper(true);
    mapper.notify({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    mapper.notify({
      type: "session_token_usage_changed",
      tokenUsage: {
        inputTokens: 500,
        outputTokens: 50,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        factoryCredits: 200,
      },
    });
    mapper.notify({
      type: "create_message",
      message: { id: "m-1", role: "assistant", content: [{ type: "text", text: "A" }] },
    });
    mapper.notify({
      type: "agent_turn_completed",
      reason: "completed",
      turnId: "t-1",
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        factoryCredits: 8,
      },
      cumulativeTokenUsage: {
        inputTokens: 510,
        outputTokens: 55,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        factoryCredits: 208,
      },
    });
    const usageEvents = events.filter((e) => e.t === "message_end" && e.usage !== undefined);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({ usage: { input: 10, output: 5 } }); // turn 增量，不含历史 500
  });

  it("error 通知收集；未知通知计数；compaction 状态映射", () => {
    const { mapper, events } = makeMapper();
    mapper.notify({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    mapper.notify({ type: "error", message: "429 slow down" });
    mapper.notify({ type: "droid_working_state_changed", newState: "compacting_conversation" });
    mapper.notify({ type: "droid_working_state_changed", newState: "thinking" });
    mapper.notify({ type: "some_future_notification", x: 1 });
    expect(mapper.errors()).toEqual(["429 slow down"]);
    expect(mapper.unknownNotifications()).toBe(1);
    expect(events.map((e) => e.t)).toContain("compaction_start");
    expect(events.map((e) => e.t)).toContain("compaction_end");
  });
});
