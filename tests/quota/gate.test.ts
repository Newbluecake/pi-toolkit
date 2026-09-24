// quota-plan §9.2 gate.test.ts — pass-through semantics (no snapshot / stale /
// below line), fast-fail copy (pct + reset time + alternatives), gateLevel=2
// aggressiveness, pickAlternatives ordering & exclusions, quotaAnnotation
// marks, and the formatModelCandidates backward-compat lock.

import { describe, expect, it } from "vitest";
import { formatModelCandidates, type ModelCandidate } from "../../src/config/model-hint.js";
import {
  evaluateQuotaGate,
  parseSubscriptionProviders,
  pickAlternatives,
  quotaAnnotation,
  toLadderLevel,
  type QuotaGateDeps,
} from "../../src/quota/gate.js";
import type { ProviderVerdict, WindowVerdict } from "../../src/quota/ladder.js";
import type { LadderLevel, QuotaProviderId, WindowScope } from "../../src/quota/types.js";

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
    // kimi (fresh L3) is excluded; stale zai counts as healthy (R5) and, being a
    // subscription, keeps pay-per-use cloudrouter out of the list.
    expect(pickAlternatives("zai-coding-cn", deps)).toEqual({ providers: ["zai"], subscription: true });
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
