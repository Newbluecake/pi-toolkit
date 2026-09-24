/**
 * compact-hint 黄金回归驱动器（dynamic-threshold-plan.md §11.3 / §12 D3 · T-D3-OFF-GOLDEN）。
 *
 * 同一份场景脚本同时服务两处：
 * - `scripts/exp/generate-compact-hint-golden.ts`：对**当前实现**录制 fixture；
 * - `tests/integration/compact-dynamic-off-golden.test.ts`：mode="off" 回放并逐字节比对。
 *
 * 纪律：只通过 `createCompactHintHook` 的公开契约（holder/deps/ctx stub）驱动，
 * 不 reach into 钩子内部；`CompactHintState` 不带 `dynamic` 字段（= mode off / 无
 * runtime），改动前后的形状完全一致。时钟全部注入（确定性），断言对象是每次
 * `sendMessage` 的 `customType` + `content` + `details`。
 */

import { createCompactHintHook, type CompactHintState, type Stack } from "../../../src/stack.js";

export interface GoldenSentMessage {
  scenario: string;
  /** 场景内第几次 sendMessage（1 起）。 */
  index: number;
  customType: string;
  content: string;
  details: unknown;
}

export interface GoldenRecording {
  version: 1;
  /** 场景清单 + 每场注入的 turn 数（回放时校验场景覆盖未被裁剪）。 */
  scenarios: { name: string; turns: number }[];
  messages: GoldenSentMessage[];
}

/** mode=off 形状的初始 state（与现存默认一致；缺省字段全部显式写出）。 */
export function goldenState(initial: Partial<CompactHintState> = {}): CompactHintState {
  return {
    thresholdPercent: 75,
    forceAtPercent: 88,
    forceScaling: false,
    thresholdTokens: 0,
    forceAtTokens: 0,
    reserveTokens: 16384,
    lastHintAt: 0,
    hintedAt: undefined,
    tickStepPercent: 0,
    lastTickStep: 0,
    switchTool: false,
    forceDemandTurns: 1,
    demandCount: 0,
    ...initial,
  };
}

interface CtxOverrides {
  percent?: number | null;
  window?: number;
  mode?: string;
  hasUI?: boolean;
  compact?: (options: { onComplete: () => void; onError: (error: Error) => void }) => void;
}

function goldenCtx(overrides: CtxOverrides = {}) {
  const percent = overrides.percent ?? 50;
  return {
    mode: overrides.mode ?? "interactive",
    hasUI: overrides.hasUI ?? false,
    getContextUsage: () =>
      percent === null
        ? { percent: null, contextWindow: overrides.window ?? 200000, tokens: null }
        : {
            percent,
            contextWindow: overrides.window ?? 200000,
            tokens: Math.round((percent / 100) * (overrides.window ?? 200000)),
          },
    ui: { notify: () => undefined },
    ...(overrides.compact !== undefined ? { compact: overrides.compact } : {}),
  } as never;
}

interface Scenario {
  name: string;
  /** 每步：注入的 ctx（percent/window/...）与可选的时钟推进。 */
  steps: { ctx: CtxOverrides; now?: number }[];
  state?: Partial<CompactHintState>;
  handoffPending?: boolean;
  /** compact stub 行为：默认同步 onComplete。 */
  compactBehavior?: "complete" | "error" | "throw";
}

const scenarios: Scenario[] = [
  {
    name: "tick-grid-latch-wobble-rearm",
    state: { tickStepPercent: 10 },
    steps: [
      { ctx: { percent: 5 }, now: 1 },
      { ctx: { percent: 12 }, now: 2 },
      { ctx: { percent: 18 }, now: 3 },
      { ctx: { percent: 21 }, now: 4 },
      { ctx: { percent: 61 }, now: 5 },
      { ctx: { percent: 59.9 }, now: 6 },
      { ctx: { percent: 60.4 }, now: 7 },
      { ctx: { percent: 25 }, now: 8 },
      { ctx: { percent: 31 }, now: 9 },
      { ctx: { percent: 70 }, now: 10 },
      { ctx: { percent: 75 }, now: 11 },
      { ctx: { percent: 80 }, now: 12 },
    ],
  },
  {
    name: "hint-latch-cooldown-rearm",
    steps: [
      { ctx: { percent: 40 }, now: 1 },
      { ctx: { percent: 75 }, now: 2 },
      { ctx: { percent: 80 }, now: 3 },
      { ctx: { percent: 74 }, now: 4 },
      { ctx: { percent: 80 }, now: 599_999 },
      { ctx: { percent: 80 }, now: 600_001 },
      { ctx: { percent: 74 }, now: 600_002 },
      { ctx: { percent: 75 }, now: 1_200_003 },
    ],
  },
  {
    name: "hint-window-switch-and-effective-zero",
    state: { forceAtPercent: 0 },
    steps: [
      { ctx: { percent: 75, window: 200000 }, now: 1 },
      { ctx: { percent: 76, window: 64000 }, now: 600_001 },
      { ctx: { percent: 76, window: 64000 }, now: 600_002 },
      { ctx: { percent: 80, window: 8000 }, now: 600_003 },
      { ctx: { percent: 80, window: 200000 }, now: 1_200_001 },
    ],
  },
  {
    name: "hint-unknown-usage-clears-latch",
    steps: [
      { ctx: { percent: 80 }, now: 1 },
      { ctx: { percent: null }, now: 2 },
      { ctx: { percent: 80 }, now: 3 },
    ],
  },
  {
    name: "force-complete-resume-and-cooldown",
    compactBehavior: "complete",
    steps: [
      { ctx: { percent: 88, hasUI: true }, now: 1 },
      { ctx: { percent: 88, hasUI: true }, now: 2 },
      { ctx: { percent: 74 }, now: 3 },
      { ctx: { percent: 75 }, now: 600_001 },
      { ctx: { percent: 88, hasUI: true }, now: 600_002 },
    ],
  },
  {
    name: "force-onerror-clears-inflight",
    compactBehavior: "error",
    steps: [
      { ctx: { percent: 88 }, now: 1 },
      { ctx: { percent: 88 }, now: 700_001 },
      { ctx: { percent: 88 }, now: 700_002 },
    ],
  },
  {
    name: "force-sync-throw-clears-inflight",
    compactBehavior: "throw",
    steps: [
      { ctx: { percent: 88 }, now: 1 },
      { ctx: { percent: 88 }, now: 700_001 },
      { ctx: { percent: 88 }, now: 700_002 },
    ],
  },
  {
    name: "switch-demand-then-force-fallback",
    state: { switchTool: true, forceDemandTurns: 1 },
    compactBehavior: "complete",
    steps: [
      { ctx: { percent: 90, hasUI: true }, now: 1 },
      { ctx: { percent: 90, hasUI: true }, now: 2 },
      { ctx: { percent: 40 }, now: 3 },
      { ctx: { percent: 90, hasUI: true }, now: 4 },
      { ctx: { percent: 90, hasUI: true }, now: 5 },
    ],
  },
  {
    name: "switch-demand-skipped-while-handoff-pending",
    state: { switchTool: true, forceDemandTurns: 2 },
    handoffPending: true,
    steps: [
      { ctx: { percent: 95 }, now: 1 },
      { ctx: { percent: 95 }, now: 2 },
    ],
  },
  {
    name: "absolute-token-line-1m-window",
    state: { thresholdTokens: 400, tickStepPercent: 10 },
    steps: [
      { ctx: { percent: 39, window: 1_000_000 }, now: 1 },
      { ctx: { percent: 40, window: 1_000_000 }, now: 2 },
      { ctx: { percent: 41, window: 1_000_000 }, now: 3 },
    ],
  },
  {
    name: "absolute-line-auto-disable-small-window",
    state: { thresholdTokens: 400, forceAtTokens: 400, forceAtPercent: 0 },
    steps: [
      { ctx: { percent: 74, window: 256_000 }, now: 1 },
      { ctx: { percent: 75, window: 256_000 }, now: 2 },
      { ctx: { percent: 95, window: 256_000 }, now: 3 },
    ],
  },
  {
    name: "force-tokens-only-percent-off",
    state: { thresholdPercent: 0, forceAtPercent: 0, forceAtTokens: 400, tickStepPercent: 10 },
    compactBehavior: "complete",
    steps: [
      { ctx: { percent: 31, window: 1_000_000 }, now: 1 },
      { ctx: { percent: 39, window: 1_000_000 }, now: 2 },
      { ctx: { percent: 40, window: 1_000_000 }, now: 3 },
    ],
  },
  {
    name: "window-scaled-force-densified-ticks",
    state: { thresholdPercent: 0, forceAtPercent: 88, forceScaling: true, tickStepPercent: 10 },
    steps: [
      { ctx: { percent: 88, window: 200_000 }, now: 1 },
      { ctx: { percent: 90, window: 200_000 }, now: 2 },
      { ctx: { percent: 91, window: 200_000 }, now: 3 },
      { ctx: { percent: 54, window: 37_000 }, now: 1_000_001 },
      { ctx: { percent: 55, window: 37_000 }, now: 1_000_002 },
    ],
  },
  {
    name: "hint-l1-keeps-ticking-to-force-ceiling",
    state: { tickStepPercent: 10 },
    steps: [
      { ctx: { percent: 70 }, now: 1 },
      { ctx: { percent: 75 }, now: 2 },
      { ctx: { percent: 80 }, now: 3 },
      { ctx: { percent: 87 }, now: 4 },
    ],
  },
  {
    name: "switch-tool-l1-hint-text",
    state: { switchTool: true, tickStepPercent: 10 },
    steps: [
      { ctx: { percent: 42 }, now: 1 },
      { ctx: { percent: 80 }, now: 2 },
    ],
  },
  {
    name: "json-mode-inert",
    steps: [
      { ctx: { percent: 80, mode: "json" }, now: 1 },
      { ctx: { percent: 80, mode: "print" }, now: 2 },
    ],
  },
  {
    name: "all-lines-disabled-inert",
    state: { thresholdPercent: 0, forceAtPercent: 0, thresholdTokens: 0, forceAtTokens: 0, tickStepPercent: 0 },
    steps: [
      { ctx: { percent: 95 }, now: 1 },
      { ctx: { percent: 95 }, now: 2 },
    ],
  },
  {
    name: "force-scaling-off-literal-line",
    state: { forceScaling: false, tickStepPercent: 10 },
    steps: [
      { ctx: { percent: 87, window: 37_000 }, now: 1 },
      { ctx: { percent: 88, window: 37_000 }, now: 2 },
    ],
  },
  {
    name: "large-window-1m-default-lines",
    state: { tickStepPercent: 10 },
    steps: [
      { ctx: { percent: 45, window: 1_000_000 }, now: 1 },
      { ctx: { percent: 55, window: 1_000_000 }, now: 2 },
      { ctx: { percent: 75, window: 1_000_000 }, now: 3 },
      { ctx: { percent: 88, window: 1_000_000 }, now: 4 },
    ],
  },
];

function makeCompact(behavior: Scenario["compactBehavior"]) {
  if (behavior === undefined) return undefined;
  if (behavior === "error")
    return (options: { onComplete: () => void; onError: (error: Error) => void }) => options.onError(new Error("boom"));
  if (behavior === "throw")
    return (_options: { onComplete: () => void; onError: (error: Error) => void }) => {
      throw new Error("sync boom");
    };
  return (options: { onComplete: () => void; onError: (error: Error) => void }) => options.onComplete();
}

/** 跑全部场景，返回逐条 sendMessage 记录（确定性：时钟全部来自 steps[].now）。 */
export function runGoldenScenarios(): GoldenRecording {
  const messages: GoldenSentMessage[] = [];
  const scenarioSummaries: { name: string; turns: number }[] = [];
  for (const scenario of scenarios) {
    const state = goldenState(scenario.state);
    let clock = 0;
    let index = 0;
    const compact = makeCompact(scenario.compactBehavior);
    const hook = createCompactHintHook(
      { current: { compactHint: state } as Stack },
      {
        sendMessage: (message) => {
          index += 1;
          const record = message as { customType: string; content: string; details?: unknown };
          messages.push({
            scenario: scenario.name,
            index,
            customType: record.customType,
            content: record.content,
            details: record.details ?? null,
          });
        },
        sendUserMessage: () => undefined,
        now: () => clock,
        ...(scenario.handoffPending ? { handoffPending: () => true } : {}),
      },
    );
    for (const step of scenario.steps) {
      clock = step.now ?? clock + 1;
      hook({}, goldenCtx({ ...step.ctx, ...(compact !== undefined ? { compact } : {}) }));
    }
    scenarioSummaries.push({ name: scenario.name, turns: scenario.steps.length });
  }
  return { version: 1, scenarios: scenarioSummaries, messages };
}
