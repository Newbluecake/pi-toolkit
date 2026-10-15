// quota-plan §9.2 gate.test.ts — pass-through semantics (no snapshot / stale /
// below line), fast-fail copy (pct + reset time + alternatives), gateLevel=2
// aggressiveness, pickAlternatives ordering & exclusions, quotaAnnotation
// marks, and the formatModelCandidates backward-compat lock.

import { describe, expect, it, vi } from "vitest";
import { formatModelCandidates, type ModelCandidate } from "../../src/config/model-hint.js";
import {
  evaluateQuotaGate,
  parseSubscriptionProviders,
  pickAlternatives,
  quotaAnnotation,
  toLadderLevel,
  type QuotaGateDeps,
} from "../../src/quota/gate.js";
import {
  DEFAULT_THRESHOLDS,
  providerVerdict,
  type ProviderVerdict,
  type WindowVerdict,
} from "../../src/quota/ladder.js";
import type {
  DroidPoolAdvice,
  DroidPoolListingEntry,
  LadderLevel,
  QuotaProviderId,
  WindowScope,
} from "../../src/quota/types.js";

const NOW = 1_000_000;
/** 02:11 local-time reset anchor — deterministic under any test-runner TZ. */
const RESET_0211 = new Date(2026, 0, 1, 2, 11).getTime();

function win(
  scope: WindowScope,
  usedPct: number,
  level: LadderLevel,
  resetAt?: number,
  reason?: WindowVerdict["reason"],
): WindowVerdict {
  return {
    scope,
    usedPct,
    level,
    reason: reason ?? (level === 0 ? "none" : "pct"),
    ...(resetAt === undefined ? {} : { resetAt }),
  };
}

function makeVerdict(input: {
  provider: QuotaProviderId;
  level: LadderLevel;
  windows?: readonly WindowVerdict[];
  demoted?: boolean;
  demotedUntil?: number;
  stale?: boolean;
}): ProviderVerdict {
  return {
    provider: input.provider,
    level: input.level,
    windows: input.windows ?? [],
    demoted: input.demoted ?? false,
    ...(input.demotedUntil === undefined ? {} : { demotedUntil: input.demotedUntil }),
    fetchedAt: NOW,
    stale: input.stale ?? false,
  };
}

const CANDIDATES: readonly ModelCandidate[] = [
  { provider: "zai-coding-cn", id: "glm-5.3" },
  { provider: "kimi-coding", id: "kimi-k3" },
  { provider: "zai", id: "glm-5.3-air" },
  { provider: "cloudrouter-anthropic", id: "claude-opus-5" },
];

function gateDeps(
  verdictFor: (provider: string) => ProviderVerdict | undefined,
  blockAtLevel: LadderLevel = 3,
): QuotaGateDeps {
  return { verdictFor, available: () => CANDIDATES, blockAtLevel, now: NOW };
}

describe("evaluateQuotaGate", () => {
  it("1. no snapshot (unmanaged provider) → undefined (pass)", () => {
    expect(
      evaluateQuotaGate(
        { provider: "cloudrouter-anthropic", id: "claude-opus-5" },
        gateDeps(() => undefined),
      ),
    ).toBeUndefined();
  });

  it("2. level 3 + fresh snapshot → blocked; message carries pct, reset time and alternatives", () => {
    const verdicts: Record<string, ProviderVerdict> = {
      "zai-coding-cn": makeVerdict({
        provider: "zai-coding-cn",
        level: 3,
        windows: [win("5h", 98, 3, RESET_0211, "exhausted"), win("week", 21, 0)],
      }),
      "kimi-coding": makeVerdict({ provider: "kimi-coding", level: 0, windows: [win("5h", 8, 0), win("week", 12, 0)] }),
    };
    const verdict = evaluateQuotaGate(
      { provider: "zai-coding-cn", id: "glm-5.3" },
      gateDeps((p) => verdicts[p]),
    );
    expect(verdict).toBeDefined();
    expect(verdict?.level).toBe(3);
    expect(verdict?.message).toContain("98%");
    expect(verdict?.message).toContain("02:11");
    expect(verdict?.message).toContain("kimi-coding");
    expect(verdict?.message).toContain("未消耗任何 run");
    // Blocked provider itself never appears among the alternatives.
    expect(verdict?.alternatives).not.toContain("zai-coding-cn/glm-5.3");
  });

  it("3. level 3 but stale → pass (R5: stale snapshots never block)", () => {
    const stale = makeVerdict({
      provider: "zai-coding-cn",
      level: 3,
      stale: true,
      windows: [win("5h", 98, 3, RESET_0211, "exhausted")],
    });
    expect(
      evaluateQuotaGate(
        { provider: "zai-coding-cn", id: "glm-5.3" },
        gateDeps(() => stale),
      ),
    ).toBeUndefined();
  });

  it("4. gateLevel 2 blocks at L2 (and still passes L1 below the line)", () => {
    const l2 = makeVerdict({ provider: "zai-coding-cn", level: 2, windows: [win("5h", 78, 2, RESET_0211)] });
    const l1 = makeVerdict({ provider: "kimi-coding", level: 1, windows: [win("5h", 62, 1)] });
    const deps = gateDeps((p) => (p === "zai-coding-cn" ? l2 : p === "kimi-coding" ? l1 : undefined), 2);
    expect(evaluateQuotaGate({ provider: "zai-coding-cn", id: "glm-5.3" }, deps)).toBeDefined();
    expect(evaluateQuotaGate({ provider: "kimi-coding", id: "kimi-k3" }, deps)).toBeUndefined();
  });

  it("6. no viable alternative → message says 暂无替代候选 + 检查 pi /model", () => {
    // Only blocked-provider candidates in the registry → empty alternatives.
    const exhausted = makeVerdict({
      provider: "zai-coding-cn",
      level: 3,
      windows: [win("5h", 100, 3, RESET_0211, "exhausted")],
    });
    const deps: QuotaGateDeps = {
      verdictFor: () => exhausted,
      available: () => [{ provider: "zai-coding-cn", id: "glm-5.3" }],
      blockAtLevel: 3,
      now: NOW,
    };
    const verdict = evaluateQuotaGate({ provider: "zai-coding-cn", id: "glm-5.3" }, deps);
    expect(verdict?.alternatives).toEqual({ providers: [], subscription: false });
    expect(verdict?.message).toContain("暂无替代候选，按路由表另选合适模型（可检查 pi /model");
  });

  it("copy references 「settings 文件」 without hard-coding the settings path (Minor 6)", () => {
    const exhausted = makeVerdict({
      provider: "zai-coding-cn",
      level: 3,
      windows: [win("5h", 100, 3, RESET_0211, "exhausted")],
    });
    const verdict = evaluateQuotaGate(
      { provider: "zai-coding-cn", id: "glm-5.3" },
      gateDeps(() => exhausted),
    );
    expect(verdict?.message).toContain("settings 文件");
    expect(verdict?.message).not.toContain("~/.pi/agent");
    expect(verdict?.message).not.toContain(".json");
  });
});

describe("pickAlternatives", () => {
  it("5. sorts by (subscription tier asc, level asc, maxUsedPct asc, registry order asc); excludes self, blocked providers, and honors limit", () => {
    const verdicts: Record<string, ProviderVerdict> = {
      "zai-coding-cn": makeVerdict({ provider: "zai-coding-cn", level: 3, windows: [win("5h", 98, 3)] }),
      "kimi-coding": makeVerdict({ provider: "kimi-coding", level: 1, windows: [win("5h", 20, 1)] }),
      zai: makeVerdict({ provider: "zai", level: 1, windows: [win("5h", 50, 1)] }),
      // cloudrouter-anthropic: unmanaged (no verdict) → pay-per-use tier.
    };
    const deps = gateDeps((p) => verdicts[p]);
    // Subscriptions with headroom exist ⇒ ONLY subscriptions are recommended
    // (use them up) — pay-per-use cloudrouter is dropped, even with a spare slot.
    expect(pickAlternatives("zai-coding-cn", deps)).toEqual({
      providers: ["kimi-coding", "zai"],
      subscription: true,
    });
    // Same level (L1) → lower usedPct first (kimi 20% before zai 50%).
    expect(pickAlternatives("zai-coding-cn", deps, 2)).toEqual({
      providers: ["kimi-coding", "zai"],
      subscription: true,
    });
  });

  it("excludes providers at/above the gate line while stale ones stay selectable", () => {
    const verdicts: Record<string, ProviderVerdict> = {
      "kimi-coding": makeVerdict({ provider: "kimi-coding", level: 3, windows: [win("week", 100, 3)] }),
      zai: makeVerdict({ provider: "zai", level: 3, stale: true, windows: [win("5h", 99, 3)] }),
      "zai-coding-cn": makeVerdict({ provider: "zai-coding-cn", level: 1, windows: [win("5h", 30, 1)] }),
    };
    const deps = gateDeps((p) => verdicts[p]);
    // kimi (fresh L3) is excluded; stale zai is still selectable (R5: the gate never
    // blocks on stale) but — 2026-10-15 拍板「no trustworthy data ⇒ the subscription
    // does not exist」— no longer counts as a subscription, so pay-per-use
    // cloudrouter is no longer pushed out of the list and the heading loses 订阅优先.
    expect(pickAlternatives("zai-coding-cn", deps)).toEqual({
      providers: ["zai", "cloudrouter-anthropic"],
      subscription: false,
    });
  });

  it("a stale provider stays subscription-tier ONLY when explicitly declared (quota.subscriptionProviders)", () => {
    const verdicts: Record<string, ProviderVerdict> = {
      zai: makeVerdict({ provider: "zai", level: 3, stale: true, windows: [win("5h", 99, 3)] }),
      // cloudrouter 无快照（非受管 provider ⇒ tier 2）：否则新鲜窗口数据会把它抬回订阅层。
    };
    const deps = {
      verdictFor: (p: string) => verdicts[p],
      available: () => CANDIDATES,
      isSubscription: (p: string) => p === "zai",
    };
    // declared stale zai keeps tier 1 (subscription heading, cloudrouter excluded);
    // without the declaration the same snapshot falls to pay-per-use.
    expect(pickAlternatives("zai-coding-cn", deps)).toEqual({ providers: ["zai"], subscription: true });
    // 未声明 ⇒ 全体落 tier 2（kimi 无快照、zai stale、cloudrouter 非受管），按注册表序全列。
    expect(pickAlternatives("zai-coding-cn", { ...deps, isSubscription: () => false })).toEqual({
      providers: ["kimi-coding", "zai", "cloudrouter-anthropic"],
      subscription: false,
    });
  });

  it("defaults to the level-3 exclusion line when deps carries no blockAtLevel (hook-side Pick)", () => {
    const verdicts: Record<string, ProviderVerdict> = {
      "kimi-coding": makeVerdict({ provider: "kimi-coding", level: 3, windows: [win("week", 100, 3)] }),
      zai: makeVerdict({ provider: "zai", level: 2, windows: [win("5h", 76, 2)] }),
    };
    const hookDeps = { verdictFor: (p: string) => verdicts[p], available: () => CANDIDATES };
    // No blockAtLevel in the deps → exclusion defaults to 3, so an L2 provider
    // stays recommendable even though an aggressive gateLevel=2 gate would block it.
    expect(pickAlternatives("zai-coding-cn", hookDeps)).toEqual({ providers: ["zai"], subscription: true });
  });

  it("respects the exclusion line carried by full QuotaGateDeps (gateLevel 2 excludes L2)", () => {
    const verdicts: Record<string, ProviderVerdict> = {
      "kimi-coding": makeVerdict({ provider: "kimi-coding", level: 2, windows: [win("5h", 76, 2)] }),
      zai: makeVerdict({ provider: "zai", level: 1, windows: [win("5h", 55, 1)] }),
    };
    const full = gateDeps((p) => verdicts[p], 2);
    expect(pickAlternatives("zai-coding-cn", full)).toEqual({ providers: ["zai"], subscription: true });
  });

  it("falls back to pay-per-use only when every subscription is exhausted/excluded", () => {
    const verdicts: Record<string, ProviderVerdict> = {
      "kimi-coding": makeVerdict({ provider: "kimi-coding", level: 3, windows: [win("week", 100, 3)] }),
      zai: makeVerdict({ provider: "zai", level: 3, windows: [win("5h", 95, 3)] }),
    };
    expect(
      pickAlternatives(
        "zai-coding-cn",
        gateDeps((p) => verdicts[p]),
      ),
    ).toEqual({ providers: ["cloudrouter-anthropic"], subscription: false });
  });

  it("quota.subscriptionProviders marks quota-less providers as subscriptions (after managed ones)", () => {
    const candidates: readonly ModelCandidate[] = [
      { provider: "deepseek", id: "deepseek-flash" },
      { provider: "copilot-anthropic", id: "claude-opus-5" },
      { provider: "kimi-coding", id: "kimi-k3" },
      { provider: "zai", id: "glm-5.3-air" },
    ];
    const verdicts: Record<string, ProviderVerdict> = {
      "kimi-coding": makeVerdict({ provider: "kimi-coding", level: 3, windows: [win("week", 100, 3)] }),
      zai: makeVerdict({ provider: "zai", level: 1, windows: [win("5h", 60, 1)] }),
    };
    const isSubscription = parseSubscriptionProviders(" copilot-anthropic , ,");
    const deps = { verdictFor: (p: string) => verdicts[p], available: () => candidates, isSubscription };
    // managed zai (visible headroom) → declared copilot → deepseek dropped.
    expect(pickAlternatives("zai-coding-cn", deps)).toEqual({
      providers: ["zai", "copilot-anthropic"],
      subscription: true,
    });
    // with zai exhausted too, the declared subscription alone still keeps pay-per-use out.
    const allHot = { ...verdicts, zai: makeVerdict({ provider: "zai", level: 3, windows: [win("5h", 99, 3)] }) };
    expect(pickAlternatives("zai-coding-cn", { ...deps, verdictFor: (p: string) => allHot[p] })).toEqual({
      providers: ["copilot-anthropic"],
      subscription: true,
    });
    // empty setting ⇒ nothing declared.
    expect(parseSubscriptionProviders("")("copilot-anthropic")).toBe(false);
  });

  it("returns [] for limit 0 and keeps registry order among equal scores", () => {
    expect(
      pickAlternatives(
        "zai-coding-cn",
        gateDeps(() => undefined),
        0,
      ),
    ).toEqual({ providers: [], subscription: false });
    expect(
      pickAlternatives(
        "zai-coding-cn",
        gateDeps(() => undefined),
      ),
    ).toEqual({
      providers: ["kimi-coding", "zai", "cloudrouter-anthropic"],
      subscription: false,
    });
  });
  it("dedupes multiple models from one provider and reports subscription tier", () => {
    const candidates: readonly ModelCandidate[] = [
      { provider: "cloudrouter-response", id: "gpt-5.6-sol" },
      { provider: "cloudrouter-response", id: "gpt-5.6-terra" },
      { provider: "zai", id: "glm-5.3-air" },
    ];
    const result = pickAlternatives("zai-coding-cn", {
      verdictFor: () => undefined,
      available: () => candidates,
    });
    expect(result).toEqual({ providers: ["cloudrouter-response", "zai"], subscription: false });
  });

  it("does not recommend tier 2 when a subscription candidate remains", () => {
    const result = pickAlternatives("zai-coding-cn", {
      verdictFor: (provider) =>
        provider === "kimi-coding"
          ? makeVerdict({ provider: "kimi-coding", level: 1, windows: [win("5h", 20, 1)] })
          : undefined,
      available: () => [
        { provider: "kimi-coding", id: "kimi-k3" },
        { provider: "cloudrouter-response", id: "gpt-5.6-sol" },
      ],
    });
    expect(result).toEqual({ providers: ["kimi-coding"], subscription: true });
  });

  it("7. L0 → no mark, L2/L3 → ⚠ (highest window wins), unknown provider → undefined", () => {
    const verdicts: Record<string, ProviderVerdict> = {
      "zai-coding-cn": makeVerdict({ provider: "zai-coding-cn", level: 2, windows: [win("5h", 78, 2)] }),
      "kimi-coding": makeVerdict({
        provider: "kimi-coding",
        level: 3,
        windows: [win("5h", 8, 0), win("week", 100, 3)], // #kimi-week-trap: week window wins
      }),
      zai: makeVerdict({ provider: "zai", level: 0, windows: [win("5h", 5, 0)] }),
    };
    const at = (c: ModelCandidate) => quotaAnnotation(c, (p) => verdicts[p]);
    expect(at({ provider: "zai-coding-cn", id: "glm-5.3" })).toBe(" [5h 78% ⚠]");
    expect(at({ provider: "kimi-coding", id: "kimi-k3" })).toBe(" [7d 100% ⚠]");
    expect(at({ provider: "zai", id: "glm-5.3-air" })).toBeUndefined();
    expect(at({ provider: "cloudrouter-anthropic", id: "claude-opus-5" })).toBeUndefined();
  });

  it("L1 carries the pct without a symbol", () => {
    const verdicts: Record<string, ProviderVerdict> = {
      "zai-coding-cn": makeVerdict({ provider: "zai-coding-cn", level: 1, windows: [win("5h", 62, 1)] }),
    };
    const at = (c: ModelCandidate) => quotaAnnotation(c, (p) => verdicts[p]);
    expect(at({ provider: "zai-coding-cn", id: "glm-5.3" })).toBe(" [5h 62%]");
    expect(at({ provider: "cloudrouter-anthropic", id: "claude-opus-5" })).toBeUndefined();
  });
});

describe("toLadderLevel (Minor 8: narrow settings gateLevel instead of `as`)", () => {
  it("narrows and clamps a plain number into 0..3", () => {
    expect(toLadderLevel(1)).toBe(1);
    expect(toLadderLevel(2)).toBe(2);
    expect(toLadderLevel(3)).toBe(3);
    expect(toLadderLevel(0)).toBe(0);
    expect(toLadderLevel(-5)).toBe(0);
    expect(toLadderLevel(99)).toBe(3);
    expect(toLadderLevel(Number.NaN)).toBe(0);
  });
});

describe("formatModelCandidates compat lock (§9 gate case 8)", () => {
  const MANY: readonly ModelCandidate[] = Array.from({ length: 10 }, (_, index) => ({
    provider: "p",
    id: `m-${index}`,
  }));
  it("8. annotate omitted vs explicitly undefined are byte-for-byte identical to the legacy output", () => {
    const expected = "Available: p/m-0, p/m-1, p/m-2, p/m-3, p/m-4, p/m-5, p/m-6, p/m-7, … +2 more";
    expect(formatModelCandidates(MANY, 8, undefined)).toBe(expected);
    expect(formatModelCandidates(MANY)).toBe(expected);
    expect(formatModelCandidates([], 8, undefined)).toBe("");
    expect(formatModelCandidates(CANDIDATES)).toBe(
      "Available: zai-coding-cn/glm-5.3, kimi-coding/kimi-k3, zai/glm-5.3-air, cloudrouter-anthropic/claude-opus-5",
    );
  });
  it("appends the annotate suffix only to marked candidates", () => {
    const annotate = (c: ModelCandidate) => (c.provider === "kimi-coding" ? " [7d 100% ⚠]" : undefined);
    expect(formatModelCandidates(CANDIDATES, 8, annotate)).toBe(
      "Available: zai-coding-cn/glm-5.3, kimi-coding/kimi-k3 [7d 100% ⚠], zai/glm-5.3-air, cloudrouter-anthropic/claude-opus-5",
    );
  });
});

// 等级只来自降位地板（读数与降位矛盾，2026-09-24 kimi 现场）：闸门行为与 L2 预警文案一致。
describe("demotion-floor-only verdicts", () => {
  const floorOnly = makeVerdict({
    provider: "kimi-coding",
    level: 2,
    demoted: true,
    demotedUntil: RESET_0211,
    windows: [win("5h", 0, 0), win("week", 0, 0)],
  });
  const model = { provider: "kimi-coding", id: "kimi-k3" };
  const verdictFor = (p: string): ProviderVerdict | undefined => (p === "kimi-coding" ? floorOnly : undefined);

  it("default gateLevel 3 lets it through (the L2 copy promises no block)", () => {
    expect(evaluateQuotaGate(model, gateDeps(verdictFor))).toBeUndefined();
  });

  it("gateLevel 2 blocks it with the demotion explanation, not '配额已用 0%'", () => {
    const res = evaluateQuotaGate(model, gateDeps(verdictFor, 2));
    expect(res?.level).toBe(2);
    expect(res?.message).toContain("quota gate: kimi-coding 仍在降位期（此前额度告急触发降位，预计");
    expect(res?.message).toContain("最新读数（5h 0% · 7d 0%）与降位矛盾");
    expect(res?.message).not.toContain("配额已用 0%");
  });

  it("quotaAnnotation marks the demotion itself instead of a misleading reading", () => {
    expect(quotaAnnotation({ provider: "kimi-coding", id: "kimi-k3" }, verdictFor)).toBe(" [⤓demoted ⚠]");
  });
});

// 重置时刻已过的窗口不再阻断（ladder 规则 0）：verdict 用 providerVerdict 现算
// （与 service 同源），锁住「闸门只读判定层」的口径一致性。
describe("windows whose reset has elapsed (relaxation)", () => {
  const HOUR = 3_600_000;

  function serviceVerdict(
    windows: readonly { scope: WindowScope; usedPct: number; resetAt?: number }[],
  ): ProviderVerdict {
    return providerVerdict(
      {
        provider: "kimi-coding",
        kind: "windows",
        windows: windows.map((w) => ({
          scope: w.scope,
          usedPct: w.usedPct,
          ...(w.resetAt === undefined ? {} : { resetAt: w.resetAt }),
        })),
        fetchedAt: NOW - 40 * 60_000, // 快照 40min：不 stale（staleAfterMs 默认 1h）
      },
      {
        now: NOW,
        thresholds: DEFAULT_THRESHOLDS,
        staleAfterMs: HOUR,
        etaOf: () => undefined,
        demoted: false,
      },
    );
  }

  it("does not fast-fail when the only blocking window's resetAt has already passed", () => {
    // 任务现场形状：08:30 拉到 kimi 周 100%（resetAt 09:06），09:10 派 kimi——快照
    // 40min 未 stale，但周窗口已过重置 ⇒ 不再阻断。
    const verdict = serviceVerdict([
      { scope: "5h", usedPct: 8, resetAt: NOW + 3 * HOUR },
      { scope: "week", usedPct: 100, resetAt: NOW - 4 * 60_000 },
    ]);
    expect(verdict.level).toBe(0); // 判定层已归零
    expect(
      evaluateQuotaGate(
        { provider: "kimi-coding", id: "kimi-k3" },
        gateDeps(() => verdict),
      ),
    ).toBeUndefined();
  });

  it("still blocks when another live window keeps the provider at the gate line (max of live windows)", () => {
    const verdict = serviceVerdict([
      { scope: "5h", usedPct: 98, resetAt: NOW + 3 * HOUR },
      { scope: "week", usedPct: 100, resetAt: NOW - 4 * 60_000 },
    ]);
    expect(verdict.level).toBe(3);
    const res = evaluateQuotaGate(
      { provider: "kimi-coding", id: "kimi-k3" },
      gateDeps(() => verdict),
    );
    expect(res?.level).toBe(3);
    expect(res?.message).toContain("5h"); // 拦截理由是仍在有效的 5h 窗口
  });

  it("resetAt unknown keeps the legacy behavior: a fresh 100% window still blocks", () => {
    const verdict = serviceVerdict([{ scope: "week", usedPct: 100 }]);
    expect(
      evaluateQuotaGate(
        { provider: "kimi-coding", id: "kimi-k3" },
        gateDeps(() => verdict),
      ),
    ).toBeDefined();
  });

  it("an elapsed-reset provider becomes a recommendable alternative again (level 0)", () => {
    const verdicts: Record<string, ProviderVerdict> = {
      "kimi-coding": serviceVerdict([
        { scope: "5h", usedPct: 8, resetAt: NOW + 3 * HOUR },
        { scope: "week", usedPct: 100, resetAt: NOW - 4 * 60_000 },
      ]),
      zai: makeVerdict({ provider: "zai", level: 1, windows: [win("5h", 60, 1)] }),
    };
    // 已过重置的 kimi 不再被排除线拦下，且 level 0 在排序键里压过 L1 的 zai
    //（pct 只在同层内决胜——旧读数 100 不会把 level 0 打到后面）。
    expect(
      pickAlternatives(
        "zai-coding-cn",
        gateDeps((p) => verdicts[p]),
      ),
    ).toEqual({ providers: ["kimi-coding", "zai"], subscription: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// quota-plan r2 §11 gate.test.ts（P7）：droid 池闸门（§6 evaluatePooledGate）。
// ─────────────────────────────────────────────────────────────────────────────

import type { QuotaModelView } from "../../src/quota/service.js";
import type { QuotaBillingInfo } from "../../src/quota/types.js";

function poolVerdict(
  id: "droid-standard" | "droid-core",
  pct: number,
  level: LadderLevel,
  over: { stale?: boolean; billing?: Partial<QuotaBillingInfo> } = {},
): ProviderVerdict {
  return {
    ...makeVerdict({
      provider: id,
      level,
      windows: [win("5h", pct, level, RESET_0211, pct >= 100 ? "exhausted" : "pct")],
      ...(over.stale === undefined ? {} : { stale: over.stale }),
    }),
    billing: {
      kind: "factory",
      pool: id === "droid-standard" ? "standard" : "core",
      overage: "droidCore",
      extraUsageAllowed: false,
      extraUsageBalanceCents: 0,
      ...over.billing,
    },
  };
}

const PI_VERDICTS: Record<string, ProviderVerdict> = {
  "kimi-coding": makeVerdict({ provider: "kimi-coding", level: 0, windows: [win("5h", 8, 0)] }),
  "zai-coding-cn": makeVerdict({ provider: "zai-coding-cn", level: 0, windows: [win("5h", 20, 0)] }),
};

/** 测试用建议包（stack 接线传的是 QuotaService.poolAlternatives 的真实返回）。 */
function advice(
  pool: "core" | "standard",
  models: readonly string[],
  listing: DroidPoolListingEntry[] = [],
): DroidPoolAdvice[] {
  return [{ pool, models, listing }];
}

function droidDeps(
  view: QuotaModelView | undefined,
  over: { poolAlternatives?: (b: string) => readonly DroidPoolAdvice[]; blockAtLevel?: LadderLevel } = {},
): QuotaGateDeps {
  return {
    verdictFor: (p) => PI_VERDICTS[p],
    available: () => CANDIDATES,
    blockAtLevel: over.blockAtLevel ?? 3,
    now: NOW,
    modelView: () => view,
    ...(over.poolAlternatives === undefined ? {} : { poolAlternatives: over.poolAlternatives }),
  };
}

const DROID_MODEL = { provider: "droid", id: "claude-opus-5-5" };

function stdView(v: ProviderVerdict | undefined): QuotaModelView {
  return { pool: "standard", keys: ["droid-standard"], verdicts: [v] };
}

describe("evaluateQuotaGate — droid pool path", () => {
  it("pool known + standard exhausted ⇒ blocked: head names the pool, core models line precedes the pi-native line", () => {
    const listing: DroidPoolListingEntry[] = [
      { pool: "standard", state: "blocked", total: 2, models: ["droid/claude-opus-5-5", "droid/gpt-6"] },
      { pool: "core", state: "ok", total: 2, models: ["droid/glm-5.3", "droid/kimi-k3"] },
    ];
    const verdict = evaluateQuotaGate(
      DROID_MODEL,
      droidDeps(stdView(poolVerdict("droid-standard", 100, 3)), {
        poolAlternatives: () => advice("core", ["droid/glm-5.3", "droid/kimi-k3"], listing),
      }),
    );
    expect(verdict?.level).toBe(3);
    const msg = verdict?.message ?? "";
    expect(msg).toContain("quota gate: droid/claude-opus-5-5（Standard 池）的 5h 配额已用尽（100%，");
    expect(msg).toContain("02:11 重置），本次 spawn 已快速失败，未消耗任何 run。");
    const coreIdx = msg.indexOf("优先改用 Droid Core 池模型：droid/glm-5.3、droid/kimi-k3");
    const listIdx = msg.indexOf("Droid 模型按池：Standard 池（已拦，勿派）：");
    const piIdx = msg.indexOf("改用 pi 原生子 agent");
    expect(coreIdx).toBeGreaterThan(-1);
    expect(listIdx).toBeGreaterThan(coreIdx); // 清单行取代通用括号，跟在推荐行后
    expect(msg).not.toContain("Factory 托管开源模型");
    expect(piIdx).toBeGreaterThan(listIdx); // core 行 → 清单 → pi 行（评审 #4 顺序保持）
    expect(msg).toContain("或改用 pi 原生子 agent");
    expect(msg).toContain("quota.gate 设为 false");
    expect(verdict?.alternatives).toMatchObject({
      external: true,
      models: ["droid/glm-5.3", "droid/kimi-k3"],
      modelsPool: "core",
      poolListing: listing,
    });
    expect(verdict?.alternatives.providers.length).toBeGreaterThan(0);
  });

  it("no droid-internal alternatives ⇒ only the pi line (retitled), no `models` key", () => {
    const verdict = evaluateQuotaGate(DROID_MODEL, droidDeps(stdView(poolVerdict("droid-standard", 100, 3))));
    expect(verdict?.message).toContain("改用 pi 原生子 agent");
    expect(verdict?.message).not.toContain("或改用");
    expect(verdict?.message).not.toContain("core 池仍有额度");
    expect(verdict?.alternatives.external).toBe(true);
    expect("models" in (verdict?.alternatives ?? {})).toBe(false);
  });

  it("core pool blocked (D7 对称化) ⇒ asks poolAlternatives('droid-core') and recommends Standard models", () => {
    const spy = vi.fn(() => advice("standard", ["droid/claude-opus-5-5", "droid/gpt-6"]));
    const view: QuotaModelView = { pool: "core", keys: ["droid-core"], verdicts: [poolVerdict("droid-core", 100, 3)] };
    const verdict = evaluateQuotaGate({ provider: "droid", id: "glm-5.3" }, droidDeps(view, { poolAlternatives: spy }));
    expect(verdict?.message).toContain("（Core 池）");
    expect(spy).toHaveBeenCalledWith("droid-core");
    expect(verdict?.message).toContain(
      "同一 Factory 账户的 Standard 池仍有额度，可改用 Droid Standard 池模型：droid/claude-opus-5-5、droid/gpt-6（Standard 池模型计入 Standard 池额度，不占 Core 池）。",
    );
    expect(verdict?.alternatives).toMatchObject({ external: true, modelsPool: "standard" });
    expect(verdict?.message).toContain("或改用 pi 原生子 agent");
  });

  it("core pool blocked with NO advice (other pool untrusted/over the line) ⇒ pi-only line, no models key", () => {
    const view: QuotaModelView = { pool: "core", keys: ["droid-core"], verdicts: [poolVerdict("droid-core", 100, 3)] };
    const verdict = evaluateQuotaGate(
      { provider: "droid", id: "glm-5.3" },
      droidDeps(view, { poolAlternatives: () => [] }),
    );
    expect(verdict?.message).toContain("（Core 池）");
    expect("models" in (verdict?.alternatives ?? {})).toBe(false);
    expect("poolListing" in (verdict?.alternatives ?? {})).toBe(false);
    expect(verdict?.alternatives.external).toBe(true);
    expect(verdict?.message).toContain("改用 pi 原生子 agent");
  });

  it("below the gate line ⇒ pass; gateLevel=2 blocks an L2 pool", () => {
    expect(evaluateQuotaGate(DROID_MODEL, droidDeps(stdView(poolVerdict("droid-standard", 80, 2))))).toBeUndefined();
    expect(
      evaluateQuotaGate(DROID_MODEL, droidDeps(stdView(poolVerdict("droid-standard", 80, 2)), { blockAtLevel: 2 })),
    ).toBeDefined();
  });

  it("pool unknown: ONE pool at the line ⇒ pass (D5); BOTH pools at the line ⇒ block with 『计费池未知』 copy", () => {
    const std = poolVerdict("droid-standard", 100, 3);
    const coreOk = poolVerdict("droid-core", 10, 0);
    const coreHot = poolVerdict("droid-core", 100, 3);
    const mk = (a: ProviderVerdict, b: ProviderVerdict): QuotaModelView => ({
      pool: undefined,
      keys: ["droid-standard", "droid-core"],
      verdicts: [a, b],
    });
    expect(evaluateQuotaGate(DROID_MODEL, droidDeps(mk(std, coreOk)))).toBeUndefined();
    expect(evaluateQuotaGate(DROID_MODEL, droidDeps(mk(coreOk, std)))).toBeUndefined();
    const blocked = evaluateQuotaGate(DROID_MODEL, droidDeps(mk(std, coreHot)));
    expect(blocked?.message).toContain("计费池未知，Standard 与 Core 池均已触线");
    expect(blocked?.message).toContain("Standard 池 5h 配额已用尽");
    expect(blocked?.message).toContain("Core 池 5h 配额已用尽");
    // 池未知时不给 droid 内替代（core 同样触线）。
    expect("models" in (blocked?.alternatives ?? {})).toBe(false);
  });

  it("any needed pool stale or without snapshot ⇒ pass (fail-open)", () => {
    expect(
      evaluateQuotaGate(DROID_MODEL, droidDeps(stdView(poolVerdict("droid-standard", 100, 3, { stale: true })))),
    ).toBeUndefined();
    expect(evaluateQuotaGate(DROID_MODEL, droidDeps(stdView(undefined)))).toBeUndefined();
    const unknown: QuotaModelView = {
      pool: undefined,
      keys: ["droid-standard", "droid-core"],
      verdicts: [poolVerdict("droid-standard", 100, 3), undefined],
    };
    expect(evaluateQuotaGate(DROID_MODEL, droidDeps(unknown))).toBeUndefined();
    const staleCore: QuotaModelView = {
      ...unknown,
      verdicts: [poolVerdict("droid-standard", 100, 3), poolVerdict("droid-core", 100, 3, { stale: true })],
    };
    expect(evaluateQuotaGate(DROID_MODEL, droidDeps(staleCore))).toBeUndefined();
  });

  it("pool `none` (BYOK ⇒ no keys) ⇒ pass", () => {
    expect(evaluateQuotaGate(DROID_MODEL, droidDeps({ pool: "none", keys: [], verdicts: [] }))).toBeUndefined();
  });

  it("D6: extraUsage not opened ⇒ blocked with balance + setting name; gateOpen ⇒ pass", () => {
    const extra = { overage: "extraUsage" as const, extraUsageAllowed: true, extraUsageBalanceCents: 1234 };
    const blocked = evaluateQuotaGate(
      DROID_MODEL,
      droidDeps(stdView(poolVerdict("droid-standard", 100, 3, { billing: extra }))),
    );
    expect(blocked?.message).toContain("Factory 超额策略为 extraUsage（额外余额 $12.34）");
    expect(blocked?.message).toContain("quota.droidAllowExtraUsage");
    const opened = evaluateQuotaGate(
      DROID_MODEL,
      droidDeps(stdView(poolVerdict("droid-standard", 100, 3, { billing: { ...extra, gateOpen: true } }))),
    );
    expect(opened).toBeUndefined();
    // droidCore 策略的拦截不带 extraUsage 行。
    const plain = evaluateQuotaGate(DROID_MODEL, droidDeps(stdView(poolVerdict("droid-standard", 100, 3))));
    expect(plain?.message).not.toContain("quota.droidAllowExtraUsage");
  });

  it("message line order: head → [extra] → core models → pi line → close hint", () => {
    const extra = { overage: "extraUsage" as const, extraUsageAllowed: true, extraUsageBalanceCents: 100 };
    const msg =
      evaluateQuotaGate(
        DROID_MODEL,
        droidDeps(stdView(poolVerdict("droid-standard", 100, 3, { billing: extra })), {
          poolAlternatives: () => advice("core", ["droid/glm-5.3"]),
        }),
      )?.message ?? "";
    const marks = [
      "quota gate:",
      "Factory 超额策略",
      "优先改用 Droid Core 池模型",
      "或改用 pi 原生子 agent",
      "按任务需求选",
      "quota.gate 设为 false",
    ];
    const idx = marks.map((m) => msg.indexOf(m));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it("modelView returning undefined falls through to the legacy path (non-droid model blocked ⇒ no external/models)", () => {
    const verdicts: Record<string, ProviderVerdict> = {
      ...PI_VERDICTS,
      "zai-coding-cn": makeVerdict({
        provider: "zai-coding-cn",
        level: 3,
        windows: [win("5h", 98, 3, RESET_0211, "exhausted")],
      }),
    };
    const verdict = evaluateQuotaGate(
      { provider: "zai-coding-cn", id: "glm-5.3" },
      {
        ...droidDeps(undefined, { poolAlternatives: () => advice("core", ["droid/glm-5.3"]) }),
        verdictFor: (p) => verdicts[p],
      },
    );
    expect(verdict).toBeDefined();
    expect("external" in (verdict?.alternatives ?? {})).toBe(false);
    expect("models" in (verdict?.alternatives ?? {})).toBe(false);
    expect(verdict?.message).not.toContain("pi 原生子 agent");
  });
});

describe("pickAlternatives — droid decoration", () => {
  const deps = {
    verdictFor: (p: string) => PI_VERDICTS[p],
    available: () => CANDIDATES,
    poolAlternatives: (b: string) => (b === "droid-standard" ? advice("core", ["droid/glm-5.3"]) : []),
  };

  it("droid-standard blocked ⇒ external + models(+modelsPool); droid-core blocked ⇒ external only when the advice is empty", () => {
    expect(pickAlternatives("droid-standard", deps)).toMatchObject({
      external: true,
      models: ["droid/glm-5.3"],
      modelsPool: "core",
    });
    const core = pickAlternatives("droid-core", deps);
    expect(core.external).toBe(true);
    expect("models" in core).toBe(false);
  });

  it("droid-core blocked with symmetric advice ⇒ standard models ride along (D7 对称化)", () => {
    const sel = pickAlternatives("droid-core", {
      ...deps,
      poolAlternatives: (b) => (b === "droid-core" ? advice("standard", ["droid/gpt-6"]) : []),
    });
    expect(sel).toMatchObject({ external: true, models: ["droid/gpt-6"], modelsPool: "standard" });
  });

  it("non-droid blocked ⇒ exact legacy shape (no external/models keys) even when poolAlternatives is supplied", () => {
    const sel = pickAlternatives("zai-coding-cn", deps);
    expect(Object.keys(sel).sort()).toEqual(["providers", "subscription"]);
  });
});

describe("evaluateQuotaGate / pickAlternatives — pi blocked × droid pool supplement (2026-10-15 拍板)", () => {
  const PI_BLOCKED: Record<string, ProviderVerdict> = {
    "zai-coding-cn": makeVerdict({
      provider: "zai-coding-cn",
      level: 3,
      windows: [win("5h", 98, 3, RESET_0211, "exhausted")],
    }),
    "kimi-coding": makeVerdict({ provider: "kimi-coding", level: 0, windows: [win("5h", 8, 0)] }),
  };
  const POOLS = [
    { pool: "core" as const, models: ["droid/glm-5.3", "droid/kimi-k3"] },
    { pool: "standard" as const, models: ["droid/claude-opus-5-5"] },
  ];

  it("droid available ⇒ the rejection message appends the droid line after the pi candidates", () => {
    const verdict = evaluateQuotaGate(
      { provider: "zai-coding-cn", id: "glm-5.3" },
      { ...gateDeps((p) => PI_BLOCKED[p]), droidAlternatives: () => POOLS },
    );
    expect(verdict?.alternatives.droidPools).toEqual(POOLS);
    const msg = verdict?.message ?? "";
    expect(msg).toContain(
      "有余量的外部 Droid 池也可用：droid/glm-5.3、droid/kimi-k3（Core 池）；droid/claude-opus-5-5（Standard 池）。",
    );
    expect(msg).toContain("不能当 consult/验收");
    const piIdx = msg.indexOf("替代候选（订阅优先）：kimi-coding。");
    expect(piIdx).toBeGreaterThan(-1);
    expect(piIdx).toBeLessThan(msg.indexOf("有余量的外部 Droid 池也可用"));
  });

  it("droid supplement empty ⇒ the message is byte-identical to the no-dep legacy gate copy", () => {
    const noDep = evaluateQuotaGate(
      { provider: "zai-coding-cn", id: "glm-5.3" },
      gateDeps((p) => PI_BLOCKED[p]),
    );
    const empty = evaluateQuotaGate(
      { provider: "zai-coding-cn", id: "glm-5.3" },
      { ...gateDeps((p) => PI_BLOCKED[p]), droidAlternatives: () => [] },
    );
    expect(empty?.message).toBe(noDep?.message);
    expect("droidPools" in (empty?.alternatives ?? {})).toBe(false);
    expect("droidPools" in (noDep?.alternatives ?? {})).toBe(false);
  });

  it("pi alternatives empty but droid available ⇒ droid line still rendered (not 暂无替代候选)", () => {
    const verdict = evaluateQuotaGate(
      { provider: "zai-coding-cn", id: "glm-5.3" },
      {
        verdictFor: (p) => (p === "zai-coding-cn" ? PI_BLOCKED["zai-coding-cn"] : undefined),
        available: () => [{ provider: "zai-coding-cn", id: "glm-5.3" }], // 候选表里只有被拦者
        blockAtLevel: 3,
        now: NOW,
        droidAlternatives: () => POOLS,
      },
    );
    expect(verdict?.message).not.toContain("暂无替代候选");
    expect(verdict?.message).toContain("有余量的外部 Droid 池也可用");
  });

  it("external branch (droid pool blocked) ignores droidAlternatives — D7/D8 copy only", () => {
    const verdict = evaluateQuotaGate(DROID_MODEL, {
      ...droidDeps(stdView(poolVerdict("droid-standard", 100, 3)), {
        poolAlternatives: () => advice("core", ["droid/glm-5.3"]),
      }),
      droidAlternatives: () => POOLS,
    });
    expect(verdict?.message).not.toContain("有余量的外部 droid 池也可用");
    expect(verdict?.alternatives.droidPools).toBeUndefined();
  });
});
