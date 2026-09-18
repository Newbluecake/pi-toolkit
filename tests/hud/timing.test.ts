import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  LLM_TIME_ENTRY_TYPE,
  SESSION_START_ENTRY_TYPE,
  createTimingState,
  finishLlmTiming,
  finishRoundTiming,
  persistPendingRoundTiming,
  restoreTiming,
} from "../../src/hud/timing.js";

let seq = 0;
function customEntry(customType: string, data: unknown): SessionEntry {
  return {
    type: "custom",
    customType,
    data,
    id: `e${++seq}`,
    parentId: null,
    timestamp: new Date(0).toISOString(),
  } as unknown as SessionEntry;
}

function assistantEntry(output: number): SessionEntry {
  return {
    type: "message",
    message: { role: "assistant", usage: { output } },
    id: `e${++seq}`,
    parentId: null,
    timestamp: new Date(0).toISOString(),
  } as unknown as SessionEntry;
}

describe("restoreTiming", () => {
  it("replays llm-time entries: sums round durations, keeps last llm duration", () => {
    const state = createTimingState();
    restoreTiming(state, [
      customEntry(LLM_TIME_ENTRY_TYPE, { llmDurationMs: 1_000, roundDurationMs: 2_000 }),
      customEntry(LLM_TIME_ENTRY_TYPE, { llmDurationMs: 3_000, roundDurationMs: 4_000 }),
    ]);
    expect(state.totalRoundDurationMs).toBe(6_000);
    expect(state.lastLlmDurationMs).toBe(3_000);
  });

  it("accepts legacy entries that only carry durationMs", () => {
    const state = createTimingState();
    restoreTiming(state, [customEntry(LLM_TIME_ENTRY_TYPE, { durationMs: 1_500 })]);
    expect(state.totalRoundDurationMs).toBe(1_500);
    expect(state.lastLlmDurationMs).toBe(1_500);
  });

  it("prefers llmDurationMs over legacy durationMs when both exist", () => {
    const state = createTimingState();
    restoreTiming(state, [
      customEntry(LLM_TIME_ENTRY_TYPE, { durationMs: 9_999, llmDurationMs: 100, roundDurationMs: 200 }),
    ]);
    expect(state.lastLlmDurationMs).toBe(100);
    expect(state.totalRoundDurationMs).toBe(200);
  });

  it("skips malformed entries and foreign customTypes", () => {
    const state = createTimingState();
    restoreTiming(state, [
      customEntry(LLM_TIME_ENTRY_TYPE, { roundDurationMs: -1 }),
      customEntry(LLM_TIME_ENTRY_TYPE, { roundDurationMs: "x" }),
      customEntry(LLM_TIME_ENTRY_TYPE, {}),
      customEntry(LLM_TIME_ENTRY_TYPE, undefined),
      customEntry("other-thing", { roundDurationMs: 5_000 }),
      customEntry(LLM_TIME_ENTRY_TYPE, { roundDurationMs: 500 }),
    ]);
    expect(state.totalRoundDurationMs).toBe(500);
    expect(state.lastLlmDurationMs).toBeUndefined();
  });

  it("restores sessionStartedAt from the session-start entry only when valid", () => {
    const state = createTimingState();
    restoreTiming(state, [
      customEntry(SESSION_START_ENTRY_TYPE, { startedAt: "nope" }),
      customEntry(SESSION_START_ENTRY_TYPE, { startedAt: 0 }),
      customEntry(SESSION_START_ENTRY_TYPE, { startedAt: 1_700_000_000_000 }),
    ]);
    expect(state.sessionStartedAt).toBe(1_700_000_000_000);
  });

  it("derives lastSpeedTps from the last assistant message with valid output", () => {
    const state = createTimingState();
    restoreTiming(state, [
      assistantEntry(50),
      customEntry(LLM_TIME_ENTRY_TYPE, { llmDurationMs: 2_000, roundDurationMs: 2_000 }),
      assistantEntry(120),
    ]);
    // 120 tokens / 2s = 60 t/s（用最后一条 assistant 消息的 output）
    expect(state.lastSpeedTps).toBe(60);
  });

  it("leaves lastSpeedTps undefined when no assistant message or no llm duration", () => {
    const noAssistant = createTimingState();
    restoreTiming(noAssistant, [customEntry(LLM_TIME_ENTRY_TYPE, { llmDurationMs: 2_000, roundDurationMs: 2_000 })]);
    expect(noAssistant.lastSpeedTps).toBeUndefined();

    const noLlm = createTimingState();
    restoreTiming(noLlm, [assistantEntry(120), customEntry(LLM_TIME_ENTRY_TYPE, { roundDurationMs: 2_000 })]);
    expect(noLlm.lastSpeedTps).toBeUndefined();
  });

  it("resets in-flight fields before replaying", () => {
    const state = createTimingState();
    state.llmStartedAt = 123;
    state.roundStartedAt = 456;
    state.roundHeldForBg = true;
    state.pendingRoundTiming = { roundDurationMs: 1 };
    restoreTiming(state, []);
    expect(state.llmStartedAt).toBeUndefined();
    expect(state.roundStartedAt).toBeUndefined();
    expect(state.roundHeldForBg).toBe(false);
    expect(state.pendingRoundTiming).toBeUndefined();
    expect(state.totalRoundDurationMs).toBe(0);
  });
});

describe("finishLlmTiming / finishRoundTiming", () => {
  it("finishLlmTiming closes an active segment", () => {
    const state = createTimingState();
    expect(finishLlmTiming(state, 1_000)).toBe(false);
    state.llmStartedAt = 1_000;
    expect(finishLlmTiming(state, 2_500)).toBe(true);
    expect(state.lastLlmDurationMs).toBe(1_500);
    expect(state.currentRoundLlmDurationMs).toBe(1_500);
    expect(state.llmStartedAt).toBeUndefined();
  });

  it("finishRoundTiming returns none/held/finished correctly", () => {
    const state = createTimingState();
    expect(finishRoundTiming(state, 0, 0)).toBe("none");

    state.roundStartedAt = 0;
    state.llmStartedAt = 100;
    expect(finishRoundTiming(state, 5_000, 2)).toBe("held"); // 后台 agent 存活 → 挂起
    expect(state.roundHeldForBg).toBe(true);
    expect(state.roundStartedAt).toBe(0);

    expect(finishRoundTiming(state, 6_000, 0, true)).toBe("finished"); // 强制收尾
    expect(state.roundHeldForBg).toBe(false);
    expect(state.totalRoundDurationMs).toBe(6_000);
    expect(state.pendingRoundTiming).toEqual({ llmDurationMs: 5_900, roundDurationMs: 6_000 });
    expect(state.roundStartedAt).toBeUndefined();
  });
});

describe("persistPendingRoundTiming", () => {
  it("appends the pending timing once and clears it", () => {
    const state = createTimingState();
    const append = vi.fn();
    persistPendingRoundTiming(state, append);
    expect(append).not.toHaveBeenCalled();

    state.pendingRoundTiming = { llmDurationMs: 10, roundDurationMs: 20 };
    persistPendingRoundTiming(state, append);
    expect(append).toHaveBeenCalledWith(LLM_TIME_ENTRY_TYPE, { llmDurationMs: 10, roundDurationMs: 20 });
    expect(state.pendingRoundTiming).toBeUndefined();
  });
});
