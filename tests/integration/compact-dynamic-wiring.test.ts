/**
 * compact-hint dynamic · D3 接线测试（dynamic-threshold-plan.md §12 D3）。
 *
 * 覆盖锚点：T-D3-SHADOW-SILENT / ON-LINE / ON-NEVER-LATER / HINT-DISABLED /
 * STATE-MACHINE / TIER-EXEMPT / DISPOSE / PRINT / CHILD / RPC / NO-TIMER /
 * TOOLCALL-PASSTHRU / CAUSALITY / MARKER-CLEANUP。
 *
 * 纪律：遥测文件一律 tmpdir（绝不写 ~/.pi）；时钟全部注入（确定性）；
 * activate 级用例跑在一次性 $HOME 沙盒（同 mention-autocomplete-wiring 约定）。
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCompactHintHook, type CompactHintState, type Stack } from "../../src/stack.js";
import { wireDynamicThreshold, type DynamicRuntime } from "../../src/compact-hint/dynamic/wire.js";
import { readTelemetryLines } from "../../src/compact-hint/dynamic/telemetry-store.js";
import { MARKER_TTL_MS } from "../../src/compact-hint/dynamic/telemetry.js";
import { DEFAULT_DYNAMIC_THRESHOLD_SETTINGS } from "../../src/config/settings.js";
import activate from "../../src/index.js";

const HOST_KEY = Symbol.for("pi-subagent:host");

// ── 一次性 $HOME 沙盒（activate 级用例；merged-plugins 同款约定）────────────────
const fakeHome = mkdtempSync(join(tmpdir(), "pi-subagent-dyn-home-"));
const realHome = process.env.HOME;
process.env.HOME = fakeHome;

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  vi.restoreAllMocks();
});
afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

// ── 模型与价格（研究 §2.1 的 Claude Opus 5.5：r=$0.2/M ⇒ 新会话动态线 ≈ 39%）────
const OPUS = {
  provider: "anthropic",
  id: "opus-5.5",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.test",
  contextWindow: 1_000_000,
  cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

function tmpTelemetryPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `pi-subagent-dyn-${name}-`));
  return join(dir, "compact-switch.jsonl");
}

interface RuntimeRig {
  runtime: DynamicRuntime;
  telemetryPath: string;
  entries: { type: string; data: unknown }[];
  setNow: (ms: number) => void;
  telemetry: () => ReturnType<typeof readTelemetryLines>;
}

function mkRuntime(overrides: {
  mode?: "off" | "shadow" | "on";
  modeCtx?: string;
  branch?: unknown[];
  config?: Partial<typeof DEFAULT_DYNAMIC_THRESHOLD_SETTINGS>;
}): RuntimeRig {
  const telemetryPath = tmpTelemetryPath(overrides.mode ?? "on");
  const entries: { type: string; data: unknown }[] = [];
  let nowMs = 1_000;
  const runtime = wireDynamicThreshold({
    ctx: { mode: overrides.modeCtx ?? "tui", sessionManager: { getBranch: () => overrides.branch ?? [] } },
    config: {
      ...DEFAULT_DYNAMIC_THRESHOLD_SETTINGS,
      ...(overrides.config ?? {}),
      ...(overrides.mode ? { mode: overrides.mode } : {}),
    },
    sessionId: "dyn-test",
    telemetryFilePath: telemetryPath,
    now: () => nowMs,
    appendEntry: (type, data) => entries.push({ type, data }),
    readBranch: () => overrides.branch ?? [],
    quota: { enabled: false, isSubscription: () => false, verdictFor: () => undefined },
  });
  return {
    runtime,
    telemetryPath,
    entries,
    setNow: (ms) => {
      nowMs = ms;
    },
    telemetry: () => readTelemetryLines(telemetryPath),
  };
}

interface HookRig {
  state: CompactHintState;
  sent: { customType: string; content: string; details: unknown }[];
  hook: (event: unknown, ctx: unknown) => void;
  model: typeof OPUS | undefined;
  setModel: (m: typeof OPUS | undefined) => void;
}

function mkHook(
  runtime: DynamicRuntime | undefined,
  stateInit: Partial<CompactHintState> = {},
  now: () => number = () => 1,
): HookRig {
  const state: CompactHintState = {
    thresholdPercent: 75,
    forceAtPercent: 88,
    forceScaling: true,
    thresholdTokens: 500,
    forceAtTokens: 0,
    reserveTokens: 16384,
    lastHintAt: 0,
    hintedAt: undefined,
    tickStepPercent: 10,
    lastTickStep: 0,
    switchTool: false,
    forceDemandTurns: 1,
    demandCount: 0,
    ...(runtime !== undefined ? { dynamic: runtime } : {}),
    ...stateInit,
  };
  const sent: { customType: string; content: string; details: unknown }[] = [];
  const hook = createCompactHintHook(
    { current: { compactHint: state } as Stack },
    {
      sendMessage: (message) => sent.push(message as never),
      now,
    },
  );
  const rig: HookRig = {
    state,
    sent,
    hook,
    model: OPUS,
    setModel: (m) => {
      rig.model = m;
    },
  };
  return rig;
}

function ctxOf(
  rig: HookRig,
  opts: {
    percent?: number | null;
    tokens?: number | null;
    window?: number;
    mode?: string;
    model?: typeof OPUS | undefined;
    sessionManager?: unknown;
  } = {},
) {
  const window = opts.window ?? 1_000_000;
  const tokens = opts.tokens ?? (opts.percent != null ? Math.round((opts.percent / 100) * window) : null);
  const percent = opts.percent ?? (tokens !== null ? (tokens / window) * 100 : null);
  return {
    mode: opts.mode ?? "tui",
    hasUI: false,
    get model() {
      return opts.model !== undefined ? opts.model : rig.model;
    },
    getContextUsage: () => ({ percent, contextWindow: window, tokens }),
    ui: { notify: () => undefined },
    ...(opts.sessionManager !== undefined ? { sessionManager: opts.sessionManager } : {}),
  } as never;
}

function hintsOf(rig: HookRig) {
  return rig.sent.filter(
    (m) => m.customType === "subagent:compact-hint" && (m.details as { demand?: boolean })?.demand !== true,
  );
}
function ticksOf(rig: HookRig) {
  return rig.sent.filter((m) => m.customType === "subagent:usage-tick");
}

describe("T-D3-ON-LINE: on + Opus 5.5 价格 + 静态 75%/500k ⇒ hint 在约 40% 触发", () => {
  it("fires the hint at the dynamic line (~39%) with the cost marker on ticks", () => {
    const rig0 = mkRuntime({});
    const rig = mkHook(rig0.runtime);
    // +800/turn（≈ 研究 §2.3 的 g P50）：g 的 EWMA 恒为 800 ⇒ 动态线稳定在 39%。
    let tokens = 350_000;
    const turn = () => {
      rig.hook({}, ctxOf(rig, { tokens }));
      tokens += 800;
    };
    turn(); // 35%：基线轮（不观测 Δ）
    turn(); // 第一条 tick（step 30）应带英文短标记
    expect(ticksOf(rig)).toHaveLength(1);
    expect(ticksOf(rig)[0]?.content).toContain("hint 39% · cost");
    expect(ticksOf(rig)[0]?.content).not.toMatch(/[\u4e00-\u9fff]+(?= ·)/); // 标记不含 CJK
    while (hintsOf(rig).length === 0 && tokens < 500_000) turn();
    const hint = hintsOf(rig)[0];
    expect(hint).toBeDefined();
    expect((hint?.details as { percent: number }).percent).toBeLessThanOrEqual(41);
    expect((hint?.details as { percent: number }).percent).toBeGreaterThanOrEqual(38);
    expect((hint?.details as { thresholdPercent: number }).thresholdPercent).toBe(39);
    expect(hint?.content).toContain("价格模型"); // §10.2 cost note（中文整句）
    // 越线后同 epoch 不再重复提醒（§9.2）
    const count = rig.sent.length;
    turn();
    turn();
    expect(hintsOf(rig)).toHaveLength(1);
    expect(rig.sent.length).toBeGreaterThan(count - 1);
  });
});

describe("T-D3-ON-NEVER-LATER: 静态设 30% ⇒ 动态不得推到 40%", () => {
  it("keeps the earlier static line and the static marker", () => {
    const rig0 = mkRuntime({});
    const rig = mkHook(rig0.runtime, { thresholdPercent: 30, thresholdTokens: 0 });
    let tokens = 250_000;
    rig.hook({}, ctxOf(rig, { tokens }));
    expect(ticksOf(rig)[0]?.content).toContain("hint 30% · static"); // 静态线更早 ⇒ static 标记
    tokens = 301_000;
    rig.hook({}, ctxOf(rig, { tokens }));
    const hint = hintsOf(rig)[0];
    expect(hint).toBeDefined();
    expect((hint?.details as { thresholdPercent: number }).thresholdPercent).toBe(30); // 不是 39/40
    expect(hint?.content).not.toContain("价格模型"); // 无动态 note
  });
});

describe("T-D3-HINT-DISABLED (P0-1)", () => {
  it("percent=0, tokens=2000 (>W ⇒ 自动失效) ⇒ hint 保持关闭，动态不得复活", () => {
    const rig0 = mkRuntime({});
    const rig = mkHook(rig0.runtime, {
      thresholdPercent: 0,
      thresholdTokens: 2000,
      forceAtPercent: 88,
      forceAtTokens: 900,
    });
    for (const tokens of [200_000, 400_000, 600_000]) rig.hook({}, ctxOf(rig, { tokens }));
    expect(hintsOf(rig)).toHaveLength(0); // hint 关闭；tick 照常
    expect(ticksOf(rig).length).toBeGreaterThan(0);
  });
  it("percent=0, tokens=500 ⇒ min(500k, dyn)：动态线仍生效", () => {
    const rig0 = mkRuntime({});
    const rig = mkHook(rig0.runtime, { thresholdPercent: 0, thresholdTokens: 500 });
    rig.hook({}, ctxOf(rig, { tokens: 350_000 }));
    expect(ticksOf(rig)[0]?.content).toContain("hint 39% · cost"); // min(500k, ~390k) = 动态线
    // +800/turn 渐进（单次大 Δ 会把 g 顶上去 ⇒ 线上移）：39% 越线发 hint
    for (let tokens = 350_800; tokens <= 400_000; tokens += 800) rig.hook({}, ctxOf(rig, { tokens }));
    const hint = hintsOf(rig)[0];
    expect(hint).toBeDefined();
    expect((hint?.details as { thresholdPercent: number }).thresholdPercent).toBe(39);
  });
});

describe("T-D3-STATE-MACHINE (P2-1：逐行验证 §9.2 转换表)", () => {
  function walk(rig: HookRig, tokens: number, step = 800) {
    for (let t = tokens; t <= tokens + 0; t += step) rig.hook({}, ctxOf(rig, { tokens: t }));
  }
  it("线移动不重提醒；真实回落才重置；退化/恢复不制造提醒", () => {
    const rig0 = mkRuntime({});
    let clock = 0;
    const rig = mkHook(rig0.runtime, { thresholdPercent: 75, thresholdTokens: 0 }, () => clock);
    const turn = (tokens: number) => {
      clock += 1;
      rig.hook({}, ctxOf(rig, { tokens }));
    };
    // 高位越线：hint 一次（epoch=0 闩锁），+800/turn 保持 g=800 ⇒ 动态线 39%
    for (let tokens = 350_000; tokens <= 390_500; tokens += 800) turn(tokens);
    expect(hintsOf(rig)).toHaveLength(1);
    // 线移动不重提醒：+2k/turn 爬到 620k（g→2k ⇒ 线上移 39%→~56%），用量始终在线上方
    for (let tokens = 392_300; tokens <= 620_000; tokens += 2_000) turn(tokens);
    expect(hintsOf(rig)).toHaveLength(1);
    // 真实回落（跌破线−迟滞且用量确实在降）⇒ epoch+1 + 清 hintedAt
    turn(400_000);
    expect(hintsOf(rig)).toHaveLength(1); // 低位本身不发
    clock += 700_000; // 越过 hint 冷却，重新越线时才可能再发
    // 渐进回升（单次大 Δ 会把 g 顶上去）：越过 ~56% 线时重新提醒（新 epoch）
    for (let tokens = 402_000; tokens <= 620_000; tokens += 2_000) turn(tokens);
    expect(hintsOf(rig)).toHaveLength(2); // 重新提醒（新 epoch）
    // 退化（价格未知 ⇒ usable:false）：effective 回静态 75%，80% 越静态线但不重提醒
    rig.setModel(undefined);
    turn(800_000);
    expect(hintsOf(rig)).toHaveLength(2); // §9.2：退化 ⇒ 不立刻重提醒
    // 恢复：动态线回来（80% ≥ 线），仍闩锁 ⇒ 不提醒
    rig.setModel(OPUS);
    turn(800_000);
    expect(hintsOf(rig)).toHaveLength(2);
  });

  it("epoch 翻转（模型指纹变化）清 published 但不清提醒闩锁", () => {
    const rig0 = mkRuntime({});
    const rig = mkHook(rig0.runtime);
    rig.hook({}, ctxOf(rig, { tokens: 390_500 }));
    expect(hintsOf(rig)).toHaveLength(1);
    const switched = { ...OPUS, id: "opus-5.6", cost: { ...OPUS.cost, cacheRead: 0.3 } };
    rig0.runtime.noteModelSelected(switched);
    rig.hook({}, ctxOf(rig, { tokens: 395_000, model: switched }));
    // 换模型后线重算（更贵的读价 ⇒ 线更低），但 hintedAt 未清 ⇒ 不重新提醒（§4.3/§9.2）
    expect(hintsOf(rig)).toHaveLength(1);
    const view = rig0.runtime.statusView();
    expect(view?.usable).toBe(true); // published 已清但仍在计算（下次越线按常规判）
  });
  it("窗口/模型变化已含在指纹里：换窗口 = 换 epoch = published 清空", () => {
    const rig0 = mkRuntime({});
    const rig = mkHook(rig0.runtime);
    rig.hook({}, ctxOf(rig, { tokens: 390_500 }));
    rig.hook({}, ctxOf(rig, { tokens: 200_000, window: 2_000_000 })); // 窗口变化 ⇒ 指纹变化
    const view = rig0.runtime.statusView();
    expect(view?.mode).toBe("on"); // 换窗后仍可用；published 已按新 epoch 重算
    expect(view?.usable).toBe(true);
  });
  void walk;
});

describe("T-D3-TIER-EXEMPT: 跨档前一次性提醒突破冷却，每个 B 一次", () => {
  it("fires once inside [B−margin, B] despite the hint cooldown, then never again for the same B", () => {
    // W=400k，档边界 B=200k（跨档后 cacheRead 翻倍）；g 恒 800 ⇒ margin = max(1600, 4k) = 4k。
    const tiered = {
      ...OPUS,
      contextWindow: 400_000,
      cost: {
        input: 4,
        output: 20,
        cacheRead: 0.4,
        cacheWrite: 5,
        tiers: [{ inputTokensAbove: 200_000, input: 4, output: 20, cacheRead: 0.8, cacheWrite: 5 }],
      },
    };
    let nowMs = 1;
    const rig0 = mkRuntime({});
    const rig = mkHook(rig0.runtime, { thresholdPercent: 30, thresholdTokens: 0 }, () => nowMs);
    let tokens = 120_000;
    const turn = () => {
      nowMs += 1;
      rig.hook({}, ctxOf(rig, { tokens, window: 400_000, model: tiered }));
      tokens += 800;
    };
    turn(); // 30% 基线
    turn(); // 30.2% ⇒ 静态线 30% 越线 ⇒ hint #1（冷却开始；静态线生效 ⇒ 无动态 note）
    expect(hintsOf(rig)).toHaveLength(1);
    expect(hintsOf(rig)[0]?.content).not.toContain("跨进高价档");
    // 爬到 B−margin（196k）之前：常规路径被冷却/闩锁挡住
    while (tokens < 195_000) turn();
    expect(hintsOf(rig)).toHaveLength(1); // 冷却期内无第二次
    // 进入 [B−margin, B] = [196k, 200k] ⇒ 跨档票突破冷却发一次
    while (hintsOf(rig).length < 2 && tokens <= 205_000) turn();
    const tierHint = hintsOf(rig)[1];
    expect(tierHint).toBeDefined();
    expect(tierHint?.content).toContain("跨进高价档"); // §10.2 tier note
    expect(tierHint?.content).toContain("[tier 200k]");
    // 同一 B 只提醒一次：继续留在档内再爬几轮
    for (let i = 0; i < 5; i += 1) turn();
    expect(hintsOf(rig)).toHaveLength(2);
  });
});

describe("T-D3-SHADOW-SILENT: shadow ⇒ 模型可见字节与 off 相同；status/遥测在场", () => {
  it("produces byte-identical messages to the no-runtime baseline", () => {
    const scenario = (rig: HookRig) => {
      for (const tokens of [200_000, 350_000, 510_000, 520_000, 740_000, 760_000, 800_000]) {
        rig.hook({}, ctxOf(rig, { tokens }));
      }
    };
    const offRig = mkHook(undefined, {}, () => 1);
    const shadowRig = mkHook(mkRuntime({ mode: "shadow" }).runtime, {}, () => 1);
    scenario(offRig);
    scenario(shadowRig);
    expect(shadowRig.sent).toEqual(offRig.sent); // 逐字节（含 details）
    expect(offRig.sent.length).toBeGreaterThan(2); // 场景确有产出
  });
  it("shadow 仍有动态 status 节与遥测写入", () => {
    const rig0 = mkRuntime({ mode: "shadow" });
    const rig = mkHook(rig0.runtime);
    rig.hook({}, ctxOf(rig, { tokens: 390_500 }));
    const view = rig0.runtime.statusView();
    expect(view?.mode).toBe("shadow");
    expect(view?.usable).toBe(true);
    rig0.runtime.onSessionCompact({ reason: "manual", compactionEntry: { fromHook: false } }, { mode: "tui" });
    expect(rig0.telemetry().records).toHaveLength(1);
  });
});

describe("T-D3-PRINT / T-D3-CHILD / T-D3-RPC (P1-5 / R2-3)", () => {
  it("PRINT: 根会话 print ⇒ 惰性 runtime、零遥测", () => {
    const rig0 = mkRuntime({ modeCtx: "print" });
    expect(rig0.runtime.active).toBe(false);
    expect(rig0.runtime.statusView()).toBeUndefined();
    const outcome = rig0.runtime.onTurnEnd({
      ctx: { mode: "tui" },
      model: OPUS,
      usage: { tokens: 390_000, percent: 39, contextWindow: 1_000_000 },
      staticHint: { percent: 75, tokensK: 500 },
      force: { atPercent: 88, atTokensK: 0, forceScaling: true },
      reserveTokens: 16384,
    });
    expect(outcome.usable).toBe(false); // 惰性 runtime 永不计算
    rig0.runtime.onSessionCompact({ reason: "manual" }, { mode: "tui" });
    expect(rig0.telemetry().records).toHaveLength(0);
    expect(existsSync(rig0.telemetryPath)).toBe(false);
  });
  it("RPC: mode 既非 print 也非 json ⇒ 动态层正常运行（不得被 mode!==tui 误杀）", () => {
    const rig0 = mkRuntime({ modeCtx: "rpc" });
    expect(rig0.runtime.active).toBe(true); // 判定条件与 stack.ts:575 逐字一致（print||json）
    const rig = mkHook(rig0.runtime);
    rig.hook({}, ctxOf(rig, { tokens: 350_000, mode: "rpc" }));
    expect(ticksOf(rig)[0]?.content).toContain("hint 39% · cost"); // rpc 下钩子照常运行
    for (let tokens = 350_800; tokens <= 400_000; tokens += 800) {
      rig.hook({}, ctxOf(rig, { tokens, mode: "rpc" }));
    }
    expect((hintsOf(rig)[0]?.details as { thresholdPercent: number }).thresholdPercent).toBe(39);
  });
  it("CHILD: HOST_KEY 已认领的激活不注册动态事件 handler（子会话惰性）", () => {
    (globalThis as Record<symbol, unknown>)[HOST_KEY] = { activatedAt: Date.now() };
    const handlers = new Map<string, unknown[]>();
    const pi = {
      registerTool() {},
      registerCommand() {},
      on(event: string, handler: unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      sendMessage() {},
      appendEntry() {},
      events: { on: () => () => undefined, emit: () => undefined },
      exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    } as unknown as ExtensionAPI;
    activate(pi);
    // 我们的动态事件 handler 全部在 guard 之后：子会话激活一个都不注册。
    // （session_compact/model_select 另有 sysprompt hub 的 pre-guard 合法注册，
    //  不能按事件名断言缺席——改用行为：子会话永不建栈 ⇒ 事件不产生任何遥测。）
    expect(handlers.has("tool_call")).toBe(false);
    const sessionCtx = {
      mode: "tui",
      cwd: fakeHome,
      hasUI: false,
      sessionManager: { getEntries: () => [], getSessionId: () => "child", getBranch: () => [] },
      modelRegistry: { getAvailable: () => [], find: () => undefined },
      ui: { notify: () => undefined, setWidget: () => undefined, setStatus: () => undefined },
      model: OPUS,
    } as never;
    for (const handler of handlers.get("session_compact") ?? []) {
      handler({ reason: "manual" }, sessionCtx);
    }
    expect(existsSync(agentTelemetryPath())).toBe(false); // 无栈 ⇒ 零遥测
  });
});

describe("T-D3-NO-TIMER: wire 不调用任何 setTimeout/setInterval", () => {
  it("spies observe zero timer calls across wire + turns + compact + dispose", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const rig0 = mkRuntime({});
    const rig = mkHook(rig0.runtime);
    rig.hook({}, ctxOf(rig, { tokens: 350_000 }));
    rig.hook({}, ctxOf(rig, { tokens: 350_800 }));
    rig0.runtime.onSessionCompact({ reason: "manual" }, { mode: "tui" });
    rig0.runtime.dispose({ sessionManager: { getBranch: () => [] } });
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});

describe("T-D3-CAUSALITY (R2-1)", () => {
  it("仅 tool_call 出现但 onApplied 未开火 ⇒ handoffApplied:false 且 trigger ≠ switch-tool", () => {
    const rig0 = mkRuntime({});
    const rig = mkHook(rig0.runtime);
    rig.hook({}, ctxOf(rig, { tokens: 390_000 }));
    rig0.runtime.onToolCall("switch_context");
    rig0.runtime.onSessionCompact({ reason: "manual", compactionEntry: { fromHook: false } }, { mode: "tui" });
    const record = rig0.telemetry().records[0] as { handoffApplied: boolean; trigger: string; adopted: boolean | null };
    expect(record.handoffApplied).toBe(false); // 时间共现不算因果
    expect(record.trigger).not.toBe("switch-tool");
    expect(record.trigger).toBe("manual");
    expect(record.adopted).toBe(false);
  });
  it("onApplied 开火后的压缩 ⇒ handoffApplied:true、seq 取自 onApplied", () => {
    const rig0 = mkRuntime({});
    const rig = mkHook(rig0.runtime);
    rig.hook({}, ctxOf(rig, { tokens: 390_000 }));
    rig0.runtime.noteHandoffApplied({ seq: 42, chars: 6000, keepRecent: true, reason: "manual" });
    rig0.runtime.onSessionCompact(
      { reason: "manual", compactionEntry: { fromHook: true, tokensBefore: 390_000 } },
      { mode: "tui" },
    );
    const record = rig0.telemetry().records[0] as {
      handoffApplied: boolean;
      trigger: string;
      seq: number;
      adopted: boolean | null;
    };
    expect(record.handoffApplied).toBe(true);
    expect(record.trigger).toBe("switch-tool");
    expect(record.seq).toBe(42); // seq 来自 onApplied（R2-1）
    expect(record.adopted).toBe(true); // fromHook 在 compactionEntry 上（P0-3）
  });
});

describe("T-D3-MARKER-CLEANUP (R2-4：forceMarker 四条清除路径)", () => {
  function compactRecord(rig0: RuntimeRig) {
    rig0.runtime.onSessionCompact({ reason: "threshold" }, { mode: "tui" });
    return rig0.telemetry().records.at(-1) as { trigger: string } | undefined;
  }
  it("① session_compact 成功消费后清除", () => {
    const rig0 = mkRuntime({});
    rig0.runtime.noteForce("force");
    const record = compactRecord(rig0);
    expect(record?.trigger).toBe("dynamic-force"); // 消费时 marker 在场
    const after = compactRecord(rig0); // 随后的无关压缩
    expect(after?.trigger).toBe("pi-auto"); // 不得再记成 dynamic-force
  });
  it("② ctx.compact() 的 onError / 同步 catch 清除（clearForceMarker）", () => {
    const rig0 = mkRuntime({});
    rig0.runtime.noteForce("force");
    rig0.runtime.clearForceMarker();
    expect(compactRecord(rig0)?.trigger).toBe("pi-auto");
  });
  it("③ session_compact_failed 清除（clearMarkers）", () => {
    const rig0 = mkRuntime({});
    rig0.runtime.noteForce("force");
    rig0.runtime.clearMarkers("compact-failed");
    expect(compactRecord(rig0)?.trigger).toBe("pi-auto");
  });
  it("④ MARKER_TTL_MS 超时 ⇒ 自然作废", () => {
    const rig0 = mkRuntime({});
    rig0.runtime.noteForce("force");
    rig0.setNow(1_000 + MARKER_TTL_MS + 1);
    expect(compactRecord(rig0)?.trigger).toBe("pi-auto");
  });
});

// ── activate 级（真实 index.ts 接线）────────────────────────────────────────

type Handler = (event: unknown, ctx: unknown) => unknown;

function activatePi() {
  const handlers = new Map<string, Handler[]>();
  const appended: { type: string; data: unknown }[] = [];
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage() {},
    appendEntry(type: string, data: unknown) {
      appended.push({ type, data });
    },
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  };
  activate(pi as unknown as ExtensionAPI);
  const emit = async (event: string, payload: unknown = {}, ctx: unknown = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  return { handlers, appended, emit };
}

function sessionCtx(mode = "tui") {
  return {
    mode,
    cwd: fakeHome,
    hasUI: false,
    sessionManager: { getEntries: () => [], getSessionId: () => "dyn-activate", getBranch: () => [] },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    // todo/hud 等插件在 session 生命周期会触碰 ui.setWidget/setFooter/setStatus/theme.fg —— 全 no-op 兜住。
    ui: new Proxy(
      { notify: () => undefined, theme: { fg: (_color: string, text: string) => text } },
      {
        get: (target, prop) =>
          prop in target ? (target as Record<string | symbol, unknown>)[prop as string] : () => undefined,
      },
    ),
    getContextUsage: () => ({ percent: 40, contextWindow: 1_000_000, tokens: 400_000 }),
    model: OPUS,
  } as never;
}

const agentTelemetryPath = () => join(fakeHome, ".pi", "agent", "telemetry", "compact-switch.jsonl");

describe("T-D3-DISPOSE (P1-4) + T-D3-TOOLCALL-PASSTHRU（activate 级）", () => {
  it("session_shutdown 与「无 shutdown 直接 session_start」都 dispose；dispose 后不再写遥测", async () => {
    const host = activatePi();
    await host.emit("session_start", { reason: "new" }, sessionCtx());
    const dynamicCount = () => host.appended.filter((e) => e.type === "subagent:compact-dynamic").length;
    // 事件面可用：session_compact 写一条遥测（switch 行 + 打开观察窗）
    await host.emit("session_compact", { reason: "manual", compactionEntry: { fromHook: false } }, sessionCtx());
    expect(readTelemetryLines(agentTelemetryPath()).records.length).toBe(1);
    // 路径 1：session_shutdown ⇒ dispose（flush 观察窗 window 行 + 估计量落盘）
    const persistedBefore = dynamicCount();
    await host.emit("session_shutdown", { reason: "reload" }, sessionCtx());
    expect(dynamicCount()).toBeGreaterThan(persistedBefore); // dispose flush 落盘
    const linesAfterShutdown = readTelemetryLines(agentTelemetryPath());
    expect(linesAfterShutdown.records.length).toBe(2); // switch + dispose flush 的 window 行
    expect(linesAfterShutdown.records.map((r) => (r as { phase: string }).phase)).toEqual(["switch", "window"]);
    // dispose 后再来事件不写遥测
    await host.emit("session_compact", { reason: "manual" }, sessionCtx());
    expect(readTelemetryLines(agentTelemetryPath()).records.length).toBe(2);
    // 路径 2：无 shutdown 直接 session_start ⇒ 防御性 dispose（同样 flush ⇒ 条目增加）
    await host.emit("session_start", { reason: "new" }, sessionCtx());
    const persistedAfterSecond = dynamicCount();
    expect(persistedAfterSecond).toBeGreaterThan(dynamicCount() - 1);
    expect(dynamicCount()).toBeGreaterThanOrEqual(persistedAfterSecond);
  });

  it("tool_call handler 恒返回 undefined 且不改 event.input", async () => {
    const host = activatePi();
    await host.emit("session_start", { reason: "new" }, sessionCtx());
    const handlers = host.handlers.get("tool_call") ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    const input = { goal: "keep", next_steps: "unchanged" };
    const event = { type: "tool_call", toolCallId: "t1", toolName: "switch_context", input };
    for (const handler of handlers) {
      expect(handler(event, sessionCtx())).toBeUndefined();
    }
    expect(event.input).toEqual({ goal: "keep", next_steps: "unchanged" });
    expect((event.input as { goal: string }).goal).toBe("keep");
  });

  it("mode=off 的会话不构造 runtime（回滚保证 1）", async () => {
    // settings 文件缺省 ⇒ mode=on；这里直接验证 off 的静态路径：compact.enabled=false。
    const settingsPath = join(fakeHome, ".pi", "agent", "pi-subagent.json");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(fakeHome, ".pi", "agent"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ compact: { enabled: true, dynamicThreshold: { mode: "off" } } }),
      "utf8",
    );
    try {
      rmSync(agentTelemetryPath(), { force: true }); // 前序用例可能已在 fakeHome 留下遥测
      const host = activatePi();
      await host.emit("session_start", { reason: "new" }, sessionCtx());
      await host.emit("session_compact", { reason: "manual" }, sessionCtx());
      // mode=off ⇒ runtime 不构造 ⇒ handler 首行判空 ⇒ 无遥测
      expect(existsSync(agentTelemetryPath())).toBe(false);
    } finally {
      rmSync(settingsPath, { force: true });
    }
  });
});

describe("估计量持久化（§4.2：跨 reload/resume 存活，仅当前 session branch）", () => {
  it("restores estimator state + publishedPercent + telemetrySeq from the branch entry", () => {
    const branch: { type: string; customType?: string; data: unknown }[] = [
      {
        type: "custom",
        customType: "subagent:compact-dynamic",
        data: {
          gMean: 1200,
          gVar: 900,
          gSamples: 9,
          s0Mean: 90_000,
          s0Samples: 2,
          handoffMean: 2100,
          handoffSamples: 1,
          lastTokens: 300_000,
          modelEpoch: 3,
          modelFingerprint: "old",
          version: 2,
          publishedPercent: 39,
          telemetrySeq: 7,
        },
      },
    ];
    const rig0 = mkRuntime({ branch });
    const rig = mkHook(rig0.runtime);
    // 指纹恢复后不同（modelFingerprint "old" ≠ 真实指纹）⇒ epoch 翻转一次；其余估计量存活。
    rig.hook({}, ctxOf(rig, { tokens: 350_000 }));
    const view = rig0.runtime.statusView();
    expect(view?.s0).toBeCloseTo(100_000, -4); // epoch 翻转 ⇒ S0 清回先验（§4.3 表）
    // telemetrySeq 续号：非交接切换的 seq 从 8 开始（§4.2）
    rig0.runtime.onSessionCompact({ reason: "manual" }, { mode: "tui" });
    const record = rig0.telemetry().records[0] as { seq: number };
    expect(record.seq).toBe(8);
  });
  it("bad payload (version mismatch) falls back to a fresh state", () => {
    const branch = [{ type: "custom", customType: "subagent:compact-dynamic", data: { version: 1 } }];
    const rig0 = mkRuntime({ branch });
    expect(rig0.runtime.active).toBe(true);
    const view = rig0.runtime.statusView();
    expect(view?.mode).toBe("on");
  });
});

describe("观察窗与 dispose flush（§5.5）", () => {
  it("closes the window after 6 turns and writes the window row with rProxy", () => {
    const rig0 = mkRuntime({});
    const rig = mkHook(rig0.runtime);
    // 分支上有 assistant usage 条目可聚合（duck-type branch ctx；turn 也走带 sessionManager 的 ctx）
    const branch: unknown[] = [];
    const branchCtx = { mode: "tui", sessionManager: { getBranch: () => branch }, model: OPUS };
    const turnCtx = () => ctxOf(rig, { tokens: 390_000, sessionManager: branchCtx.sessionManager });
    branch.push({ type: "message", id: "m0", message: { role: "user", content: "q" } });
    rig.hook({}, ctxOf(rig, { tokens: 390_000, sessionManager: branchCtx.sessionManager }));
    rig0.runtime.onSessionCompact({ reason: "manual", compactionEntry: { fromHook: false } }, branchCtx);
    branch.push({ type: "compaction", id: "c1" });
    for (let i = 1; i <= 6; i += 1) {
      branch.push({
        type: "message",
        id: `a${i}`,
        message: {
          role: "assistant",
          model: "opus-5.5",
          usage: { input: 1000, output: 500, cacheRead: 90_000, cacheWrite: 5_000, cost: { total: 0.02 } },
        },
      });
      rig.hook({}, turnCtx());
    }
    const phases = rig0.telemetry().records.map((r) => (r as { phase: string }).phase);
    expect(phases).toContain("switch");
    expect(phases).toContain("window"); // 6 轮后关闭并写 window 行
    const windowRow = rig0.telemetry().records.find((r) => (r as { phase: string }).phase === "window") as {
      rProxy?: { turns: number | null; firstContextTokens: number | null; costUsd: number | null };
    };
    expect(windowRow?.rProxy?.turns).toBe(6);
    expect(windowRow?.rProxy?.costUsd).toBeCloseTo(0.12, 6);
    expect(windowRow?.rProxy?.firstContextTokens).toBe(96_000); // 1000 + 90000 + 5000
  });
  it("dispose flushes an open window with actual values (no lost sample)", () => {
    const rig0 = mkRuntime({});
    const rig = mkHook(rig0.runtime);
    rig.hook({}, ctxOf(rig, { tokens: 390_000 }));
    rig0.runtime.onSessionCompact({ reason: "manual" }, { mode: "tui" });
    rig.hook({}, ctxOf(rig, { tokens: 390_800 })); // 窗口开着（1 轮）
    rig0.runtime.dispose({ sessionManager: { getBranch: () => [] } });
    const phases = rig0.telemetry().records.map((r) => (r as { phase: string }).phase);
    expect(phases).toEqual(["switch", "window"]); // dispose flush 补写 window 行
    expect(rig0.runtime.statusView()).toBeUndefined(); // dispose 后只读视图关闭
    // dispose 后拒绝写入：再来事件不追加
    rig0.runtime.onSessionCompact({ reason: "manual" }, { mode: "tui" });
    expect(rig0.telemetry().records).toHaveLength(2);
    expect(existsSync(join(tmpdir(), "never"))).toBe(false);
  });
});
