// 2026-10-23 拍板三项修复的测试锚：
// ① 3b（forecast-before-reset）软化文案——仅由 3b 抬 L2、所有窗口用量 < L1 阈值、
//    eta 未知或 > 12h ⇒ 「[quota 提示]」（不再叫「预警」），等级/闸门/displayLevel 不变；
// ② 滞回——预测消失导致的 L0 回落不清闩锁（38→39→40 不重报）、L0 期间不触发
//    「订阅可用」；真实重置（恢复事件 / pct 回落 ≥ 滞回阈值）后才清、才可再报；
// ③ 「订阅可用」跨 /reload 去重——provider + 各窗口 resetAt 指纹键持久化到会话条目，
//    同一窗口周期内 /reload（重建 state + 读回条目）不重发，窗口重置后允许再报一次。

import { describe, expect, it, vi } from "vitest";
import {
  isForecastSoftVerdict,
  QUOTA_FORECAST_SOFT_ETA_MS,
  type ProviderVerdict,
  type WindowVerdict,
} from "../../src/quota/ladder.js";
import { buildQuotaMessage, buildQuotaSoftText } from "../../src/quota/render.js";
import { evaluateQuotaGate } from "../../src/quota/gate.js";
import {
  createQuotaHintHook,
  parseAvailableKeys,
  QUOTA_AVAILABLE_ENTRY_TYPE,
  quotaAvailableKey,
  type QuotaAnnounceLatch,
  type QuotaHintState,
} from "../../src/quota/hook.js";
import type { LadderLevel, WindowScope } from "../../src/quota/types.js";

const FETCHED_AT = 1_000;
const RESET_AT = 50_000;
const HOUR = 3_600_000;
const SOFT_ETA = QUOTA_FORECAST_SOFT_ETA_MS + HOUR; // 13h > 12h ⇒ 软化区间
const WARN_ETA = QUOTA_FORECAST_SOFT_ETA_MS - HOUR; // 11h ≤ 12h ⇒ 仍「预警」

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
    provider: "kimi-coding",
    level: 2,
    windows: [w("5h", 3, 0), w("week", 24, 2, "forecast-before-reset", { etaMs: SOFT_ETA })],
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
    availableAnnounced: new Set<string>(),
    ...over,
  };
}

function ctx(over: Record<string, unknown> = {}) {
  return { mode: "interactive", hasUI: false, ui: { notify: vi.fn() }, getContextUsage: () => null, ...over } as never;
}

interface SentEntry {
  message: { customType: string; content: string; display: boolean; details: unknown };
  options: { triggerTurn: false };
}

interface Harness {
  state: QuotaHintState;
  sent: SentEntry[];
  hook: (event: unknown, ctx: never) => void;
  setVerdicts(next: readonly ProviderVerdict[]): void;
  set clock(value: number);
  failSend(value: boolean): void;
}

function harness(
  options: {
    state?: Partial<QuotaHintState>;
    verdicts?: readonly ProviderVerdict[];
    persist?: (keys: readonly string[]) => void;
  } = {},
): Harness {
  const state = makeState(options.state);
  let clock = 1_000;
  let current: readonly ProviderVerdict[] = options.verdicts ?? [];
  const sent: SentEntry[] = [];
  let failSend = false;
  const persist = options.persist;
  const hook = createQuotaHintHook({
    state: () => state,
    verdicts: () => current,
    refresh: () => undefined,
    sendMessage: (message: SentEntry["message"], options_: SentEntry["options"]) => {
      if (failSend) throw new Error("offline");
      sent.push({ message, options: options_ });
    },
    now: () => clock,
    ...(persist === undefined ? {} : { persistAvailable: persist }),
  });
  return {
    state,
    sent,
    hook,
    setVerdicts: (next) => {
      current = next;
    },
    set clock(value: number) {
      clock = value;
    },
    failSend: (value: boolean) => {
      failSend = value;
    },
  };
}

// ─────────────────────────── ① 3b 软化文案（条件矩阵） ───────────────────────────

describe("isForecastSoftVerdict + buildQuotaSoftText (copy downgrade matrix)", () => {
  it("3b-only L2 with all windows < L1 and eta > 12h ⇒ soft: 「[quota 提示]」 copy, never 「预警」", () => {
    const v = verdict();
    expect(isForecastSoftVerdict(v)).toBe(true);
    const text = buildQuotaMessage([{ verdict: v, alternatives: { providers: [], subscription: true } }], 2_000);
    expect(text).toContain("[quota 提示] kimi-coding");
    expect(text).toContain("7d 已用 24%");
    expect(text).toContain("当前用量不高，订阅仍应优先使用；按当前速率可能在窗口重置前用完，留意即可");
    expect(text).not.toContain("预警");
    // 等级/展示级别不变：软化只改文案，不改 verdict 字段本身。
    expect(v.level).toBe(2);
  });

  it("eta unknown on the 3b window still softens (defensive: 3b fired before the forecast vanished)", () => {
    const v = verdict({ windows: [w("5h", 3, 0), w("week", 24, 2, "forecast-before-reset")] });
    expect(isForecastSoftVerdict(v)).toBe(true);
    expect(buildQuotaSoftText(v, 2_000)).toContain("[quota 提示]");
  });

  it("any window usage ≥ its L1 threshold (repo default 50) ⇒ still 「预警」", () => {
    const v = verdict({
      windows: [w("5h", 55, 1, "pct"), w("week", 24, 2, "forecast-before-reset", { etaMs: SOFT_ETA })],
    });
    expect(isForecastSoftVerdict(v)).toBe(false);
    const text = buildQuotaMessage([{ verdict: v, alternatives: { providers: [], subscription: true } }], 2_000);
    expect(text).toContain("[quota 预警]");
    expect(text).not.toContain("[quota 提示]");
  });

  it("eta ≤ 12h ⇒ still 「预警」", () => {
    const v = verdict({ windows: [w("5h", 3, 0), w("week", 24, 2, "forecast-before-reset", { etaMs: WARN_ETA })] });
    expect(isForecastSoftVerdict(v)).toBe(false);
    const text = buildQuotaMessage([{ verdict: v, alternatives: { providers: [], subscription: true } }], 2_000);
    expect(text).toContain("[quota 预警]");
    expect(text).not.toContain("[quota 提示]");
  });

  it("rule 3a (eta < 30min ⇒ L3) keeps the 「严重」 copy", () => {
    const v = verdict({ level: 3, windows: [w("5h", 3, 0), w("week", 24, 3, "forecast-eta", { etaMs: 20 * 60_000 })] });
    expect(isForecastSoftVerdict(v)).toBe(false);
    const text = buildQuotaMessage([{ verdict: v, alternatives: { providers: [], subscription: true } }], 2_000);
    expect(text).toContain("[quota 严重]");
  });

  it("pct-tier L2 and demotion floor keep the 「预警」 copy", () => {
    const pctTier = verdict({
      windows: [w("5h", 3, 0), w("week", 96, 2, "pct", { etaMs: SOFT_ETA })],
    });
    expect(isForecastSoftVerdict(pctTier)).toBe(false);
    const demoted = verdict({
      demoted: true,
      demotedUntil: RESET_AT,
      level: 2,
      windows: [w("5h", 3, 0), w("week", 4, 0)],
    });
    expect(isForecastSoftVerdict(demoted)).toBe(false);
    for (const v of [pctTier, demoted]) {
      const text = buildQuotaMessage([{ verdict: v, alternatives: { providers: [], subscription: true } }], 2_000);
      expect(text).toContain("[quota 预警]");
    }
  });

  it("gate unchanged: soft L2 does not trip the default gateLevel 3, still trips gateLevel 2 (level-only)", () => {
    const v = verdict();
    const deps = (blockAtLevel: LadderLevel) => ({
      verdictFor: (p: string) => (p === "kimi-coding" ? v : undefined),
      available: () => [],
      blockAtLevel,
      now: 2_000,
    });
    // 默认闸门线 3：3b 最高 L2 本就不拦（与软化无关，钉住不回归）。
    expect(evaluateQuotaGate({ provider: "kimi-coding", id: "kimi-k3" }, deps(3))).toBeUndefined();
    // 激进闸门线 2：软化只改文案，闸门照旧只看 level ⇒ 仍拦。
    expect(evaluateQuotaGate({ provider: "kimi-coding", id: "kimi-k3" }, deps(2))).toBeDefined();
  });
});

// ─────────────────────────── ② 滞回（抖动不重报） ───────────────────────────

describe("forecast-flicker hysteresis (no re-announce on 38→39→40)", () => {
  // kimi 7d 38%：3b 抬 L2（软化「提示」）；预测消失 ⇒ 39% 变 L0；预测回来 ⇒ 40% 又 L2。
  const warn38 = () =>
    verdict({
      provider: "kimi-coding",
      windows: [w("5h", 3, 0), w("week", 38, 2, "forecast-before-reset", { etaMs: SOFT_ETA })],
    });
  const l0At39 = () =>
    verdict({ provider: "kimi-coding", level: 0, windows: [w("5h", 3, 0), w("week", 39, 0, "none")] });
  const warn40 = () =>
    verdict({
      provider: "kimi-coding",
      windows: [w("5h", 3, 0), w("week", 40, 2, "forecast-before-reset", { etaMs: SOFT_ETA })],
    });

  it("38% announces the soft hint once; 39%(L0) keeps the latch + no 订阅可用; 40%(L2) stays silent", () => {
    const h = harness({ verdicts: [warn38()] });
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message.content).toContain("[quota 提示]");
    expect(h.state.availableAnnounced.size).toBe(0);
    // 预测消失回落 L0：闩锁保留（旧实现会在这里删，导致 40% 当作首次进入重报）。
    h.clock += 400_000;
    h.setVerdicts([l0At39()]);
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1); // 无新增：既不重报，也不触发「订阅可用」
    expect(h.sent[0]?.message.content).not.toContain("订阅可用");
    expect(h.state.latches.has("kimi-coding")).toBe(true);
    // 预测回来升回 L2（跨 40 网格步）：不重报。
    h.clock += 400_000;
    h.setVerdicts([warn40()]);
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(1);
    expect(h.state.latches.get("kimi-coding")).toMatchObject({ level: 2 });
  });

  it("genuine escalation after the flicker still speaks (pct-tier L2 is not soft)", () => {
    const h = harness({ verdicts: [warn38()] });
    h.hook({}, ctx());
    h.clock += 400_000;
    h.setVerdicts([l0At39()]);
    h.hook({}, ctx());
    h.clock += 400_000;
    // 用量真到 96%（百分比阈值 L2，非 3b）：照常「预警」。
    h.setVerdicts([
      verdict({
        provider: "kimi-coding",
        windows: [w("5h", 3, 0), w("week", 96, 2, "pct")],
      }),
    ]);
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.message.content).toContain("[quota 预警]");
  });

  it("a real reset (recovery event) clears the latch: available + re-warning become possible again", () => {
    const h = harness({ verdicts: [warn38()] });
    h.hook({}, ctx()); // 38% 提示
    // 真实重置：service 推入恢复事件，读数落地 L0（2%）。
    const fresh = verdict({
      provider: "kimi-coding",
      level: 0,
      windows: [w("5h", 0, 0, "none"), w("week", 2, 0, "none")],
    });
    h.state.recoveries.push({
      provider: "kimi-coding",
      resetScopes: new Set<WindowScope>(["week"]),
      verdict: fresh,
      gateBlocked: false,
      at: 2_000,
    });
    h.clock += 400_000;
    h.setVerdicts([fresh]);
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.message.content).toContain("[quota 恢复] kimi-coding");
    expect(h.state.latches.has("kimi-coding")).toBe(false); // 真实重置清闸
    // 重置后再进 3b L2（同一提示级别） ⇒ 重新播报（恢复事件清了闩锁）。
    h.clock += 400_000;
    h.setVerdicts([warn40()]);
    h.hook({}, ctx());
    expect(h.sent).toHaveLength(3);
    expect(h.sent[2]?.message.content).toContain("[quota 提示]");
  });

  it("a real drop ≥ QUOTA_HYSTERESIS_PCT without a recovery event also clears the latch", () => {
    const h = harness({
      verdicts: [
        verdict({
          provider: "kimi-coding",
          windows: [w("5h", 3, 0), w("week", 55, 2, "pct")],
        }),
      ],
    });
    h.hook({}, ctx()); // 55% 预警，闩锁 usedPct 55
    h.clock += 400_000;
    // 回落 40 个点（≥ 15）⇒ 视同重置：删闩锁；且此时才允许「订阅可用」。
    h.setVerdicts([
      verdict({
        provider: "kimi-coding",
        level: 0,
        windows: [w("5h", 0, 0, "none"), w("week", 15, 0, "none")],
      }),
    ]);
    h.hook({}, ctx());
    expect(h.state.latches.has("kimi-coding")).toBe(false);
    expect(h.sent[h.sent.length - 1]?.message.content).toContain("订阅可用");
  });
});

// ─────────────────────── ③ 「订阅可用」跨 /reload 去重 ───────────────────────

describe("availability persistence across /reload (session entry round-trip)", () => {
  const l0Fresh = () =>
    verdict({ provider: "kimi-coding", level: 0, windows: [w("5h", 0, 0, "none"), w("week", 2, 0, "none")] });

  it("announces once, persists the fingerprint keys, and a rebuilt stack reading the entry stays silent", () => {
    const branch: unknown[] = [];
    const first = harness({
      verdicts: [l0Fresh()],
      persist: (keys) => {
        branch.push({ type: "custom", customType: QUOTA_AVAILABLE_ENTRY_TYPE, data: { v: 1, keys } });
      },
    });
    first.hook({}, ctx({ sessionManager: { getBranch: () => branch } }));
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]?.message.content).toContain("[quota] kimi-coding 订阅可用");
    // /reload：栈重建（新 state）+ 新 hook 实例（重新 activate），读回会话分支 ⇒ 不重发。
    const second = harness({ verdicts: [l0Fresh()] });
    second.hook({}, ctx({ sessionManager: { getBranch: () => branch } }));
    expect(second.sent).toHaveLength(0);
    expect(second.state.availableAnnounced.has(quotaAvailableKey("kimi-coding", l0Fresh().windows))).toBe(true);
  });

  it("window reset (resetAt change) allows exactly one more availability line", () => {
    const persistedKeys: unknown[][] = [];
    const persist = (keys: readonly string[]): void => {
      persistedKeys.push(keys);
    };
    const branch: unknown[] = [];
    const first = harness({ verdicts: [l0Fresh()], persist });
    first.hook({}, ctx({ sessionManager: { getBranch: () => branch } }));
    expect(first.sent).toHaveLength(1);
    // 窗口重置：resetAt 前移 ⇒ 指纹键变 ⇒ 允许再报一次。
    const reset = () =>
      verdict({
        provider: "kimi-coding",
        level: 0,
        windows: [w("5h", 0, 0, "none"), w("week", 2, 0, "none", { resetAt: RESET_AT + 7 * 24 * HOUR })],
      });
    first.setVerdicts([reset()]);
    first.clock += 400_000;
    first.hook({}, ctx({ sessionManager: { getBranch: () => branch } }));
    expect(first.sent).toHaveLength(2);
    expect(first.sent[1]?.message.content).toContain("订阅可用");
    expect(persistedKeys).toHaveLength(2);
  });

  it("corrupt / unreadable entry falls back to current behavior (re-announce allowed, no throw)", () => {
    const corrupt = [{ type: "custom", customType: QUOTA_AVAILABLE_ENTRY_TYPE, data: { keys: "oops" } }];
    const h = harness({ verdicts: [l0Fresh()] });
    expect(() => h.hook({}, ctx({ sessionManager: { getBranch: () => corrupt } }))).not.toThrow();
    expect(h.sent).toHaveLength(1); // 回落：可重报
    // 无 sessionManager 的 ctx 同样静默回落。
    const bare = harness({ verdicts: [l0Fresh()] });
    expect(() => bare.hook({}, ctx())).not.toThrow();
    expect(bare.sent).toHaveLength(1);
  });

  it("parseAvailableKeys rejects non-arrays and caps the key count", () => {
    expect(parseAvailableKeys(undefined)).toBeUndefined();
    expect(parseAvailableKeys({ keys: "oops" })).toBeUndefined();
    expect(parseAvailableKeys({ keys: [1, null] })).toEqual([]);
    expect(parseAvailableKeys({ keys: ["a@5h:1", 42, "b@week:2"] })).toEqual(["a@5h:1", "b@week:2"]);
    const many = { keys: Array.from({ length: 100 }, (_, i) => `p${i}@x`) };
    expect(parseAvailableKeys(many)).toHaveLength(64);
  });
});
