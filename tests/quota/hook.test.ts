// quota-plan §9.2 hook.test.ts — createQuotaHintHook（§3.10/§5.1，harness 照抄
// tests/integration/compact-hint-wiring.test.ts 的骨架）：模式门、三闸
// shouldAnnounce、M1 stale 跳过、minInterval/send-fail 闩锁回滚（Minor 1/2）、
// L3 绕过、每轮一条合并消息、消息契约、先读后刷。

import { describe, expect, it, vi } from "vitest";
import {
  QUOTA_CUSTOM_TYPE,
  createQuotaHintHook,
  shouldAnnounce,
  type QuotaAnnounceLatch,
  type QuotaHintState,
} from "../../src/quota/hook.js";
import type { ProviderVerdict, QuotaRecoveryEvent, WindowVerdict } from "../../src/quota/ladder.js";
import type { LadderLevel, WindowScope } from "../../src/quota/types.js";
import type { AlternativeSelection } from "../../src/quota/render.js";

const FETCHED_AT = 1_000;
const RESET_AT = 50_000;

function w(
  scope: WindowScope,
  usedPct: number,
  level: LadderLevel,
  reason: WindowVerdict["reason"] = level > 0 ? "pct" : "none",
  extra?: Partial<WindowVerdict>,
): WindowVerdict {
  return { scope, usedPct, level, reason, resetAt: RESET_AT, ...extra };
}

function verdict(over: Partial<ProviderVerdict> = {}): ProviderVerdict {
  return {
    provider: "zai-coding-cn",
    level: 1,
    windows: [w("5h", 62, 1)],
    demoted: false,
    fetchedAt: FETCHED_AT,
    stale: false,
    ...over,
  };
}

function makeState(over: Partial<QuotaHintState> = {}): QuotaHintState {
  return {
    enabled: true,
    tickStepPercent: 10,
    repeatMs: 1_800_000,
    minIntervalMs: 300_000,
    display: true,
    latches: new Map<string, QuotaAnnounceLatch>(),
    lastSentAt: 0,
    recoveries: [],
    ...over,
  };
}

function ctx(mode = "interactive") {
  return { mode, hasUI: false, ui: { notify: vi.fn() }, getContextUsage: () => null } as never;
}

interface SentEntry {
  message: { customType: string; content: string; display: boolean; details: unknown };
  options: { triggerTurn: false };
}

function harness(
  options: {
    state?: Partial<QuotaHintState>;
    verdicts?: readonly ProviderVerdict[];
    alternatives?: (provider: string) => AlternativeSelection;
  } = {},
) {
  const state = makeState(options.state);
  let clock = 1_000;
  let current: readonly ProviderVerdict[] = options.verdicts ?? [];
  const sent: SentEntry[] = [];
  const verdictsSpy = vi.fn(() => current);
  const refreshSpy = vi.fn();
  let failSend = false;
  const sendMessage = vi.fn((message: SentEntry["message"], options: SentEntry["options"]) => {
    if (failSend) throw new Error("offline");
    sent.push({ message, options });
  });
  const hook = createQuotaHintHook({
    state: () => state,
    verdicts: verdictsSpy,
    refresh: refreshSpy,
    sendMessage,
    now: () => clock,
    ...(options.alternatives === undefined ? {} : { alternatives: options.alternatives }),
  });
  return {
    state,
    sent,
    hook,
    sendMessage,
    verdictsSpy,
    refreshSpy,
    set clock(value: number) {
      clock = value;
    },
    get clock(): number {
      return clock;
    },
    setVerdicts(next: readonly ProviderVerdict[]): void {
      current = next;
    },
    failSend(value: boolean): void {
      failSend = value;
    },
  };
}

describe("shouldAnnounce (pure, plan §5.4)", () => {
  const input = { now: 10_000, tickStepPercent: 10, repeatMs: 1_800_000 };

  it("announces on first entry (no latch)", () => {
    const decision = shouldAnnounce(verdict(), undefined, input);
    expect(decision.announce).toBe(true);
    expect(decision.next).toMatchObject({ level: 1, step: 60, usedPct: 62 });
  });

  it("gate 1 level raise / gate 2 grid advance / gate 3 L3-only repeat", () => {
    const latch: QuotaAnnounceLatch = { level: 1, step: 60, at: 1_000, usedPct: 62 };
    expect(shouldAnnounce(verdict({ level: 2, windows: [w("5h", 62, 2)] }), latch, input).announce).toBe(true); // 闸①
    expect(shouldAnnounce(verdict({ windows: [w("5h", 71, 1)] }), latch, input).announce).toBe(true); // 闸② 60→70
    const l2: QuotaAnnounceLatch = { level: 2, step: 70, at: 1_000, usedPct: 71 };
    expect(
      shouldAnnounce(verdict({ level: 2, windows: [w("5h", 71, 2)] }), l2, { ...input, now: 1_799_999 }).announce,
    ).toBe(false);
    // L2 是纯提示（订阅优先用完）：repeatMs 到期也不复读。
    expect(
      shouldAnnounce(verdict({ level: 2, windows: [w("5h", 71, 2)] }), l2, { ...input, now: 1_801_000 }).announce,
    ).toBe(false);
    const l3: QuotaAnnounceLatch = { level: 3, step: 90, at: 1_000, usedPct: 92 };
    expect(
      shouldAnnounce(verdict({ level: 3, windows: [w("5h", 92, 3)] }), l3, { ...input, now: 1_801_000 }).announce,
    ).toBe(true); // 闸③
    // L1 不复读（闸③ 只对 level >= 3）。
    const l1: QuotaAnnounceLatch = { level: 1, step: 70, at: 1_000, usedPct: 71 };
    expect(shouldAnnounce(verdict(), l1, { ...input, now: 10_000_000 }).announce).toBe(false);
  });

  it("keeps the old latch object when not announcing, and re-arms on a real reset drop", () => {
    const latch: QuotaAnnounceLatch = { level: 2, step: 70, at: 1_000, usedPct: 71 };
    const quiet = shouldAnnounce(verdict({ level: 2, windows: [w("5h", 71, 2)] }), latch, input);
    expect(quiet.announce).toBe(false);
    expect(quiet.next).toBe(latch); // 不推进：next 就是旧闩锁
    // 重新武装：等级下降 + 百分比回落 ≥ 15（QUOTA_HYSTERESIS_PCT）。
    const rearm = shouldAnnounce(verdict({ level: 1, windows: [w("5h", 50, 1)] }), latch, input);
    expect(rearm.announce).toBe(true); // level >= 1 ⇒ 重新播报
    expect(rearm.next).toMatchObject({ level: 1, step: 50 });
    // 抖动回落（< 15）不算重置。
    const wobble = shouldAnnounce(verdict({ level: 1, windows: [w("5h", 60, 1)] }), latch, input);
    expect(wobble.announce).toBe(false);
  });

  it("uses pct 0 for degenerate window-less verdicts, so the grid gate is inert", () => {
    const bare = verdict({ windows: [], level: 3 });
    const first = shouldAnnounce(bare, undefined, input);
    expect(first.next).toMatchObject({ level: 3, step: 0, usedPct: 0 });
    const again = shouldAnnounce(bare, first.next, { ...input, now: 100_000 }); // 90s < repeatMs
    expect(again.announce).toBe(false); // 无网格可走，只剩闸③ 复读
    const repeat = shouldAnnounce(bare, { ...first.next, at: 0 }, { ...input, now: 1_800_000 });
    expect(repeat.announce).toBe(true); // level 3 + repeatMs 到期
  });
});

describe("createQuotaHintHook", () => {
  it("returns immediately in print/json mode: zero sends, no refresh (child-session inertness)", () => {
    const h = harness({ verdicts: [verdict()] });
    h.hook({}, ctx("print"));
    h.hook({}, ctx("json"));
    expect(h.sent).toHaveLength(0);
    expect(h.refreshSpy).not.toHaveBeenCalled();
  });

  it("injects provider-only alternatives with tier-aware copy", () => {
    const h = harness({
      verdicts: [verdict({ level: 3, windows: [w("5h", 93, 3)] })],
      alternatives: () => ({ providers: ["cloudrouter-response"], subscription: false }),
    });
    h.hook({}, ctx());
    expect(h.sent[0]?.message.content).toContain("无可用订阅；按量计费 provider：cloudrouter-response");
    expect(h.sent[0]?.message.content).not.toContain("订阅优先");
  });
  it("L0: sends nothing, clears the provider latch, still lazy-refreshes", () => {
    const h = harness({ verdicts: [verdict({ level: 0, windows: [w("5h", 5, 0, "none")] })] });
    h.state.latches.set("zai-coding-cn", { level: 1, step: 60, at: 0, usedPct: 62 });
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(0);
    expect(h.state.latches.has("zai-coding-cn")).toBe(false);
    expect(h.refreshSpy).toHaveBeenCalled();
  });

  it("first L1 sends once; the same percentage next turn is silent (level+grid latch)", () => {
    const h = harness({ verdicts: [verdict()] });
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1);
    h.clock += 60_000;
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1);
    expect(h.state.latches.get("zai-coding-cn")).toMatchObject({ level: 1, step: 60, usedPct: 62 });
  });

  it("62% -> 71% crosses the 70 grid and sends again once the interval allows", () => {
    const h = harness({ verdicts: [verdict()] });
    h.hook({}, ctx()); // t=1_000, sends
    h.clock += 400_000; // > minIntervalMs(300_000)
    h.setVerdicts([verdict({ windows: [w("5h", 71, 1)] })]);
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.message.content).toContain("71%");
  });

  it("L1 -> L2 sends on the level-raise gate alone (grid disabled)", () => {
    const h = harness({ state: { tickStepPercent: 0 }, verdicts: [verdict()] });
    h.hook({}, ctx()); // L1 62%, grid off
    expect(h.sent).toHaveLength(1);
    h.clock += 400_000;
    h.setVerdicts([verdict({ level: 2, windows: [w("5h", 62, 2)] })]);
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.message.details).toMatchObject({ level: 2 });
  });

  it("a step swallowed by minInterval is not lost: the latch rolls back and replays later", () => {
    const h = harness({ verdicts: [verdict()] });
    h.hook({}, ctx()); // t=1_000 sends 62%
    expect(h.sent).toHaveLength(1);
    h.clock += 60_000; // 仍在 minIntervalMs 内
    h.setVerdicts([verdict({ windows: [w("5h", 71, 1)] })]);
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1); // 被全局间隔吞掉
    expect(h.state.latches.get("zai-coding-cn")).toMatchObject({ step: 60, usedPct: 62 }); // 回滚到旧值
    h.clock += 340_000; // 间隔已过，同一 usedPct 仍能播报
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.message.content).toContain("71%");
  });

  it("rolls a first-time provider back with delete (Minor 2), not a dirty latch value", () => {
    const h = harness({ verdicts: [verdict()] });
    h.hook({}, ctx()); // t=1_000：zai 首发成功，lastSentAt 推进
    const zaiOverseas = verdict({ provider: "zai", windows: [w("5h", 55, 1)] });
    h.clock += 60_000; // 间隔内
    h.setVerdicts([zaiOverseas]);
    h.hook({}, ctx()); // zai（海外站）首次进入即被吞
    expect(h.sent).toHaveLength(1);
    expect(h.state.latches.has("zai")).toBe(false); // delete 而非 set(undefined)
    expect([...h.state.latches.keys()]).toEqual(["zai-coding-cn"]);
    h.clock += 340_000;
    h.hook({}, ctx()); // 同一 verdict 补播
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.message.content).toContain("zai ");
  });

  it("L3 bypasses the global minInterval", () => {
    const h = harness({ verdicts: [verdict()] });
    h.hook({}, ctx()); // t=1_000 L1
    h.clock += 60_000; // 远在 minIntervalMs 内
    h.setVerdicts([verdict({ level: 3, windows: [w("5h", 93, 3)] })]);
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(2); // L3 直接放行
    expect(h.sent[1]?.message.details).toMatchObject({ level: 3 });
  });

  it("L3 re-announces after repeatMs, not before; L2 announces once and stays quiet", () => {
    const l3 = () => verdict({ level: 3, windows: [w("5h", 92, 3)] });
    const h = harness({ verdicts: [l3()] });
    h.hook({}, ctx()); // t=1_000 首发
    expect(h.sent).toHaveLength(1);
    h.clock += 1_700_000; // 28.3min < 30min
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1);
    h.clock += 200_000; // 累计 31.7min ≥ repeatMs（间隔 5min 也早已过）
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(2);

    const l2 = () => verdict({ level: 2, windows: [w("5h", 80, 2)] });
    const h2 = harness({ verdicts: [l2()] });
    h2.hook({}, ctx());
    expect(h2.sent).toHaveLength(1);
    h2.clock += 3_600_000; // 远超 repeatMs
    h2.hook({}, ctx());
    expect(h2.sent).toHaveLength(1);
  });

  it("merges multiple providers into a single message per turn", () => {
    const zai = verdict();
    const kimi = verdict({ provider: "kimi-coding", windows: [w("week", 100, 3, "exhausted")], level: 3 });
    const h = harness({ verdicts: [zai, kimi] });
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1);
    const details = h.sent[0]?.message.details as { providers: { provider: string; level: number }[] };
    expect(details.providers).toHaveLength(2);
    expect(details.providers.map((p) => p.provider)).toEqual(["zai-coding-cn", "kimi-coding"]);
    expect(h.sent[0]?.message.content).toContain("zai-coding-cn");
    expect(h.sent[0]?.message.content).toContain("kimi-coding");
    expect(h.state.latches.size).toBe(2);
  });

  it("carries the demoted marker in the tick line", () => {
    const h = harness({ verdicts: [verdict({ demoted: true })] });
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message.content).toContain("⤓demoted");
    const details = h.sent[0]?.message.details as { providers: { demoted: boolean }[] };
    expect(details.providers[0]?.demoted).toBe(true);
  });

  it("swallows a sendMessage failure, rolls the latch back, and replays next turn (Minor 1)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = harness({ verdicts: [verdict()] });
    h.failSend(true);
    expect(() => h.hook({}, ctx())).not.toThrow();
    expect(h.sent).toHaveLength(0);
    expect(h.state.latches.has("zai-coding-cn")).toBe(false); // 回滚（首发者 delete）
    expect(h.state.lastSentAt).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("quota hint send failed"));
    h.failSend(false);
    h.hook({}, ctx()); // 同一轮立刻重试也能再发（闩锁已回滚）
    expect(h.sent).toHaveLength(1);
    warn.mockRestore();
  });

  it("swallows a verdicts() failure and still refreshes (turn_end must survive)", () => {
    const h = harness();
    h.verdictsSpy.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => h.hook({}, ctx())).not.toThrow();
    expect(h.refreshSpy).toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
  });

  it("reads verdicts before refreshing (read-then-refresh order)", () => {
    const h = harness({ verdicts: [verdict()] });
    h.hook({}, ctx());
    expect(h.verdictsSpy.mock.invocationCallOrder[0]).toBeLessThan(h.refreshSpy.mock.invocationCallOrder[0]);
  });

  it("sends the exact message contract: customType / display / details / triggerTurn:false", () => {
    const h = harness({ verdicts: [verdict()] });
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message.customType).toBe(QUOTA_CUSTOM_TYPE);
    expect(h.sent[0]?.message.customType).toBe("subagent:quota");
    expect(h.sent[0]?.message.display).toBe(true);
    expect(h.sent[0]?.options).toEqual({ triggerTurn: false });
    expect(h.sent[0]?.message.details).toMatchObject({
      level: 1,
      providers: [
        {
          provider: "zai-coding-cn",
          level: 1,
          demoted: false,
          windows: [{ scope: "5h", usedPct: 62, level: 1 }],
        },
      ],
    });
    expect(h.state.lastSentAt).toBe(1_000);
  });

  it("skips stale verdicts entirely: no send, no latch advance (M1) — fresh providers still announce", () => {
    const stale = verdict({ stale: true, level: 3, windows: [w("5h", 93, 3)] });
    const fresh = verdict({ provider: "kimi-coding", windows: [w("week", 100, 3, "exhausted")], level: 3 });
    const h = harness({ verdicts: [stale, fresh] });
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1);
    const details = h.sent[0]?.message.details as { providers: { provider: string }[] };
    expect(details.providers.map((p) => p.provider)).toEqual(["kimi-coding"]); // stale 完全不进注入流
    expect(h.state.latches.has("zai-coding-cn")).toBe(false); // 闩锁不推进
    // 只有 stale provider 时 ⇒ 零发送（闩锁不推进，只进 HUD）。
    h.state.latches.clear();
    h.state.lastSentAt = 0;
    h.setVerdicts([stale]);
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1); // 仍是上一条，本轮零新增
    expect(h.state.latches.has("zai-coding-cn")).toBe(false);
    expect(h.refreshSpy).toHaveBeenCalled();
  });
});

// 重置时刻已过的窗口（ladder 规则 0 reset-elapsed）：不再对它发 L3 预警；且由它
// 归零约 L0 不删闩锁——否则恢复事件（service 观测重置后推入 recoveries）的门槛
// （「曾真播报过」）会被提前抹掉，恢复播报漏发。
describe("reset-elapsed windows (no L3 injection, latch kept for the recovery event)", () => {
  const elapsedKimi = () =>
    verdict({
      provider: "kimi-coding",
      level: 0,
      windows: [w("5h", 8, 0, "none"), w("week", 100, 0, "reset-elapsed")],
    });

  it("injects nothing for a window whose reset has elapsed (even past repeatMs) and keeps the latch", () => {
    const h = harness({ verdicts: [elapsedKimi()] });
    h.state.latches.set("kimi-coding", { level: 3, step: 100, at: 0, usedPct: 100 }); // 曾真播报过 L3
    h.clock = 10_000_000; // 远超 repeatMs：旧实现会在这里复读 L3
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(0); // 不再对已重置窗口发 L3 预警
    expect(h.state.latches.has("kimi-coding")).toBe(true); // 闩锁保留（等恢复事件）
    expect(h.refreshSpy).toHaveBeenCalled(); // 懒刷新照常触发（service 侧绕过 TTL）
    // 对照：真实读数的 L0（无 reset-elapsed 窗口）仍删闩锁（旧行为不变）。
    h.setVerdicts([
      verdict({ provider: "kimi-coding", level: 0, windows: [w("5h", 8, 0, "none"), w("week", 2, 0, "none")] }),
    ]);
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(0);
    expect(h.state.latches.has("kimi-coding")).toBe(false);
  });

  it("the kept latch lets the recovery event land exactly once (no missed announcement)", () => {
    const h = harness({ verdicts: [elapsedKimi()] });
    h.state.latches.set("kimi-coding", { level: 3, step: 100, at: 0, usedPct: 100 });
    h.hook({}, ctx()); // 窗口已过重置：静默 + 保留闩锁 + 触发刷新
    expect(h.sent).toHaveLength(0);
    // 刷新落地：service 推入恢复事件；本轮 verdict 已是真实读数 L0。
    const fresh = verdict({
      provider: "kimi-coding",
      level: 0,
      windows: [w("5h", 0, 0, "none"), w("week", 2, 0, "none")],
    });
    h.setVerdicts([fresh]);
    h.state.recoveries.push({
      provider: "kimi-coding",
      resetScopes: new Set<WindowScope>(["week"]),
      verdict: fresh,
      gateBlocked: false,
      at: 1_000,
    });
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message.content).toContain("[quota 恢复] kimi-coding 7d 窗口已重置");
    expect(h.sent[0]?.message.content).toContain("可恢复派单");
    expect(h.state.latches.has("kimi-coding")).toBe(false); // 恢复路径正常清闸
    h.hook({}, ctx()); // 同读数下一轮：零新增（不重复）
    expect(h.sent).toHaveLength(1);
  });

  it("a live L3 window still announces while another window's reset has elapsed (max of live windows)", () => {
    const live = verdict({
      provider: "kimi-coding",
      level: 3,
      windows: [w("5h", 100, 3, "exhausted"), w("week", 100, 0, "reset-elapsed")],
    });
    const h = harness({ verdicts: [live] });
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message.content).toContain("[quota 严重]");
    expect(h.sent[0]?.message.content).toContain("5h 已用 100%");
  });
});

// 额度恢复播报：hook 每 turn_end 排空 state.recoveries，仅在 provider 曾真播报过
// （闩锁存在）时注入恢复块（含当前读数与闸门状态）；同轮抑制常规块（每次观测重置
// 至多一条）；绕过 minInterval（与 L3 同理）；send 失败 ⇒ 闩锁回滚 + 事件回队。
describe("createQuotaHintHook recovery announcements", () => {
  function recoveryEvent(over: Partial<QuotaRecoveryEvent> = {}): QuotaRecoveryEvent {
    return {
      provider: "zai-coding-cn",
      resetScopes: new Set<WindowScope>(["5h", "week"]),
      verdict: verdict({ level: 0, windows: [w("5h", 0, 0, "none"), w("week", 2, 0, "none")] }),
      gateBlocked: false,
      at: 1_000,
      ...over,
    };
  }

  const l0Reset = () => verdict({ level: 0, windows: [w("5h", 0, 0, "none"), w("week", 2, 0, "none")] });

  it("an eligible recovery (latch exists) sends exactly one message with current readings", () => {
    const h = harness({ verdicts: [l0Reset()] });
    h.state.latches.set("zai-coding-cn", { level: 3, step: 100, at: 0, usedPct: 100 }); // 曾真播报过
    h.state.recoveries.push(recoveryEvent());
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message.content).toContain("[quota 恢复] zai-coding-cn 窗口已重置");
    expect(h.sent[0]?.message.content).toContain("5h 0% · 7d 2%");
    expect(h.sent[0]?.message.content).toContain("spawn 闸门已放行，可恢复派单");
    expect(h.sent[0]?.message.customType).toBe(QUOTA_CUSTOM_TYPE);
    expect(h.sent[0]?.message.details).toMatchObject({
      recoveries: [{ provider: "zai-coding-cn", scopes: ["5h", "week"], level: 0, gateBlocked: false }],
    });
    expect(h.state.recoveries).toHaveLength(0); // consume-once
    expect(h.state.latches.has("zai-coding-cn")).toBe(false); // L0 删闩锁发生在判定之后
    h.hook({}, ctx()); // 下一轮同读数：零新增（每次观测重置至多一条）
    expect(h.sent).toHaveLength(1);
  });

  it("a provider that never announced gets no recovery message; the event is consumed silently", () => {
    const h = harness({ verdicts: [l0Reset()] });
    h.state.recoveries.push(recoveryEvent());
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(0);
    expect(h.state.recoveries).toHaveLength(0);
    expect(h.state.lastSentAt).toBe(0);
  });

  it("partial reset with the gate still blocked: honest copy, suppressed L3 block, latch advances", () => {
    const stillL3 = verdict({
      level: 3,
      demoted: true,
      demotedUntil: RESET_AT,
      windows: [w("5h", 1, 0, "none"), w("week", 100, 3, "exhausted")],
    });
    const h = harness({ verdicts: [stillL3] });
    h.state.latches.set("zai-coding-cn", { level: 3, step: 100, at: 0, usedPct: 100 });
    h.state.recoveries.push(
      recoveryEvent({ resetScopes: new Set<WindowScope>(["5h"]), verdict: stillL3, gateBlocked: true }),
    );
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1);
    const content = h.sent[0]?.message.content ?? "";
    expect(content).toContain("5h 窗口已重置");
    expect(content).toContain("7d 仍耗尽");
    expect(content).toContain("spawn 闸门仍拦截");
    expect(content).not.toContain("已放行"); // demotion 当场重建 ⇒ 绝不误报放行
    expect(content).not.toContain("[quota 严重]"); // 常规块被抑制：每次观测重置至多一条
    // 闩锁保留当前状态（level/step 不回退到更旧的播报点；announce=false 时 next 即旧闩锁，
    // 复读门维持原有节奏——恢复后的 L3 复读是「仍在耗尽」的常规提醒，不是重置的双播）。
    expect(h.state.latches.get("zai-coding-cn")).toMatchObject({ level: 3, step: 100 });
    h.clock += 60_000; // 下一轮：无恢复、repeatMs 未到 ⇒ 零新增
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1);
  });

  it("recovery bypasses the global minInterval floor and carries the normal tick through", () => {
    // 对照：无恢复事件时，间隔内的 L1 网格前进被地板吞掉。
    const a = harness({ verdicts: [verdict()] });
    a.hook({}, ctx()); // t=1_000 首发
    a.clock += 60_000;
    a.setVerdicts([verdict({ windows: [w("5h", 71, 1)] })]);
    a.hook({}, ctx());
    expect(a.sent).toHaveLength(1);
    // 实验：同样在间隔内，但挂着一条恢复事件 ⇒ 恢复块 + 常规块合并照发（一轮一条）。
    const b = harness({ verdicts: [verdict()] });
    b.hook({}, ctx()); // zai 62% 首发，lastSentAt=1_000
    b.state.latches.set("kimi-coding", { level: 3, step: 100, at: 0, usedPct: 100 }); // kimi 曾播报
    const kimiRecovered = verdict({
      provider: "kimi-coding",
      level: 0,
      windows: [w("5h", 0, 0, "none"), w("week", 2, 0, "none")],
    });
    b.clock += 60_000; // 仍在 minIntervalMs 内
    b.setVerdicts([verdict({ windows: [w("5h", 71, 1)] }), kimiRecovered]);
    b.state.recoveries.push(recoveryEvent({ provider: "kimi-coding", verdict: kimiRecovered }));
    b.hook({}, ctx());
    expect(b.sent).toHaveLength(2);
    const content = b.sent[1]?.message.content ?? "";
    expect(content).toContain("[quota 恢复] kimi-coding");
    expect(content).toContain("71%"); // 被恢复块携带过地板的常规 tick
    expect(content.indexOf("[quota 恢复]")).toBeLessThan(content.indexOf("[quota]")); // 恢复块在前
    expect(b.state.lastSentAt).toBe(61_000); // 发送后照常推进地板锚点
  });

  it("a failed send re-queues the recovery event and restores the latch; the retry sends once in total", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = harness({ verdicts: [l0Reset()] });
    h.state.latches.set("zai-coding-cn", { level: 3, step: 100, at: 0, usedPct: 100 });
    h.state.recoveries.push(recoveryEvent({ verdict: l0Reset() }));
    h.failSend(true);
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(0);
    expect(h.state.recoveries).toHaveLength(1); // 回队
    expect(h.state.latches.get("zai-coding-cn")).toMatchObject({ at: 0, usedPct: 100 }); // L0 删除随失败回滚
    h.failSend(false);
    h.clock += 60_000;
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message.content).toContain("[quota 恢复]");
    expect(h.state.recoveries).toHaveLength(0);
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1); // 重试成功后不再重复
    warn.mockRestore();
  });
});
