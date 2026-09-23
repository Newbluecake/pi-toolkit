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
import type { ProviderVerdict, WindowVerdict } from "../../src/quota/ladder.js";
import type { LadderLevel, WindowScope } from "../../src/quota/types.js";

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

function harness(options: { state?: Partial<QuotaHintState>; verdicts?: readonly ProviderVerdict[] } = {}) {
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

  it("gate 1 level raise / gate 2 grid advance / gate 3 L2+ repeat", () => {
    const latch: QuotaAnnounceLatch = { level: 1, step: 60, at: 1_000, usedPct: 62 };
    expect(shouldAnnounce(verdict({ level: 2, windows: [w("5h", 62, 2)] }), latch, input).announce).toBe(true); // 闸①
    expect(shouldAnnounce(verdict({ windows: [w("5h", 71, 1)] }), latch, input).announce).toBe(true); // 闸② 60→70
    const l2: QuotaAnnounceLatch = { level: 2, step: 70, at: 1_000, usedPct: 71 };
    expect(
      shouldAnnounce(verdict({ level: 2, windows: [w("5h", 71, 2)] }), l2, { ...input, now: 1_799_999 }).announce,
    ).toBe(false);
    expect(
      shouldAnnounce(verdict({ level: 2, windows: [w("5h", 71, 2)] }), l2, { ...input, now: 1_801_000 }).announce,
    ).toBe(true); // 闸③
    // L1 不复读（闸③ 只对 level >= 2）。
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

  it("L2 re-announces after repeatMs, not before", () => {
    const l2 = () => verdict({ level: 2, windows: [w("5h", 80, 2)] });
    const h = harness({ verdicts: [l2()] });
    h.hook({}, ctx()); // t=1_000 首发
    expect(h.sent).toHaveLength(1);
    h.clock += 1_700_000; // 28.3min < 30min
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1);
    h.clock += 200_000; // 累计 31.7min ≥ repeatMs（间隔 5min 也早已过）
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(2);
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
