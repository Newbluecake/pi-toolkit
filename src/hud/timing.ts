/**
 * pi-hud 移植：LLM / 回合计时状态 + 会话条目回放恢复 + appendEntry 持久化。
 * 持久化 customType 原样保留：`pi-hud-llm-time` / `pi-hud-session-start`
 * （继承用户现有会话数据，fork/resume 旧会话时计时统计无损读回）。
 *
 * restoreTiming 是纯数据进纯数据出（entries → state），可单测；
 * 时钟（performance.now）由调用侧传入 finish* 函数。
 */
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const LLM_TIME_ENTRY_TYPE = "pi-hud-llm-time";
export const SESSION_START_ENTRY_TYPE = "pi-hud-session-start";

export type RoundTiming = {
  llmDurationMs?: number | undefined;
  roundDurationMs: number;
};

export interface TimingState {
  llmStartedAt: number | undefined;
  roundStartedAt: number | undefined;
  lastSpeedTps: number | undefined;
  sessionStartedAt: number | undefined;
  currentRoundLlmDurationMs: number | undefined;
  lastLlmDurationMs: number | undefined;
  totalRoundDurationMs: number;
  pendingRoundTiming: RoundTiming | undefined;
  /** true = roundStartedAt 只因后台 agent 存活而保持打开（主回合已结束或占位段）。 */
  roundHeldForBg: boolean;
}

export function createTimingState(): TimingState {
  return {
    llmStartedAt: undefined,
    roundStartedAt: undefined,
    lastSpeedTps: undefined,
    sessionStartedAt: undefined,
    currentRoundLlmDurationMs: undefined,
    lastLlmDurationMs: undefined,
    totalRoundDurationMs: 0,
    pendingRoundTiming: undefined,
    roundHeldForBg: false,
  };
}

/**
 * 从会话分支条目回放恢复计时统计。会重置 state 的全部字段再回放。
 * 兼容 legacy 条目：旧版只在 `durationMs` 里存 LLM 响应时长。
 */
export function restoreTiming(state: TimingState, entries: readonly SessionEntry[]): void {
  state.llmStartedAt = undefined;
  state.roundStartedAt = undefined;
  state.lastSpeedTps = undefined;
  state.sessionStartedAt = undefined;
  state.currentRoundLlmDurationMs = undefined;
  state.lastLlmDurationMs = undefined;
  state.totalRoundDurationMs = 0;
  state.pendingRoundTiming = undefined;
  state.roundHeldForBg = false;
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === SESSION_START_ENTRY_TYPE) {
      const data = entry.data as { startedAt?: unknown } | undefined;
      if (typeof data?.startedAt === "number" && Number.isFinite(data.startedAt) && data.startedAt > 0) {
        state.sessionStartedAt = data.startedAt;
      }
      continue;
    }
    if (entry.customType !== LLM_TIME_ENTRY_TYPE) continue;
    const data = entry.data as
      | {
          durationMs?: unknown;
          llmDurationMs?: unknown;
          roundDurationMs?: unknown;
        }
      | undefined;
    // Older entries stored only the LLM response duration in `durationMs`.
    const legacyDurationMs = data?.durationMs;
    const llmDurationMs = data?.llmDurationMs ?? legacyDurationMs;
    const roundDurationMs = data?.roundDurationMs ?? legacyDurationMs;
    if (typeof roundDurationMs !== "number" || !Number.isFinite(roundDurationMs) || roundDurationMs < 0) continue;
    if (typeof llmDurationMs === "number" && Number.isFinite(llmDurationMs) && llmDurationMs >= 0) {
      state.lastLlmDurationMs = llmDurationMs;
    }
    state.totalRoundDurationMs += roundDurationMs;
  }
  if (state.lastLlmDurationMs !== undefined && state.lastLlmDurationMs > 0) {
    for (const entry of [...entries].reverse()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const output = entry.message.usage.output;
      if (typeof output === "number" && Number.isFinite(output) && output > 0) {
        state.lastSpeedTps = output / (state.lastLlmDurationMs / 1_000);
      }
      break;
    }
  }
}

/** 结束进行中的 LLM 计时段；返回是否确实有进行中段被收尾。 */
export function finishLlmTiming(state: TimingState, nowMs: number): boolean {
  if (state.llmStartedAt === undefined) return false;
  const durationMs = Math.max(0, nowMs - state.llmStartedAt);
  state.llmStartedAt = undefined;
  state.currentRoundLlmDurationMs = durationMs;
  state.lastLlmDurationMs = durationMs;
  return true;
}

/**
 * 结束当前回合计时段。后台 agent 仍在运行且非强制时：任务尚未结束，本轮计时
 * 挂起（roundStartedAt 保留），Σ 把后台运行时间计入任务总时长；返回 "held"。
 * 收尾时把结果挂到 pendingRoundTiming（由 persistPendingRoundTiming 落盘）。
 */
export function finishRoundTiming(
  state: TimingState,
  nowMs: number,
  bgAgentCount: number,
  force = false,
): "none" | "held" | "finished" {
  if (state.roundStartedAt === undefined) return "none";
  if (!force && bgAgentCount > 0) {
    state.roundHeldForBg = true;
    return "held";
  }
  state.roundHeldForBg = false;
  finishLlmTiming(state, nowMs);
  const roundStartedAt = state.roundStartedAt;
  const roundDurationMs = Math.max(0, nowMs - roundStartedAt);
  state.roundStartedAt = undefined;
  state.totalRoundDurationMs += roundDurationMs;
  state.pendingRoundTiming = {
    llmDurationMs: state.currentRoundLlmDurationMs,
    roundDurationMs,
  };
  state.currentRoundLlmDurationMs = undefined;
  return "finished";
}

/** 把挂起的回合计时写入会话条目（appendEntry 注入，便于测试与门控）。 */
export function persistPendingRoundTiming(
  state: TimingState,
  appendEntry: (customType: string, data?: unknown) => void,
): void {
  if (state.pendingRoundTiming === undefined) return;
  appendEntry(LLM_TIME_ENTRY_TYPE, state.pendingRoundTiming);
  state.pendingRoundTiming = undefined;
}
