// quota-plan §9.2 gate.test.ts — pass-through semantics (no snapshot / stale /
// below line), fast-fail copy (pct + reset time + alternatives), gateLevel=2
// aggressiveness, pickAlternatives ordering & exclusions, quotaAnnotation
// marks, and the formatModelCandidates backward-compat lock.

import { describe, expect, it } from "vitest";
import { formatModelCandidates, type ModelCandidate } from "../../src/config/model-hint.js";
import {
  evaluateQuotaGate,
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
  stale?: boolean;
}): ProviderVerdict {
  return {
    provider: input.provider,
    level: input.level,
    windows: input.windows ?? [],
    demoted: input.demoted ?? false,
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
    expect(verdict?.message).toContain("kimi-coding/kimi-k3");
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

  it("6. no viable alternative → message says 无更优替代，请检查 pi /model", () => {
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
    expect(verdict?.alternatives).toEqual([]);
    expect(verdict?.message).toContain("无更优替代，请检查 pi /model");
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
    // Subscriptions with headroom come first (use them up); unmanaged
    // pay-per-use cloudrouter goes last even though it has no quota pressure.
    expect(pickAlternatives("zai-coding-cn", deps)).toEqual([
      "kimi-coding/kimi-k3",
      "zai/glm-5.3-air",
      "cloudrouter-anthropic/claude-opus-5",
    ]);
    // Same level (L1) → lower usedPct first (kimi 20% before zai 50%).
    expect(pickAlternatives("zai-coding-cn", deps, 2)).toEqual(["kimi-coding/kimi-k3", "zai/glm-5.3-air"]);
  });

  it("excludes providers at/above the gate line while stale ones stay selectable", () => {
    const verdicts: Record<string, ProviderVerdict> = {
      "kimi-coding": makeVerdict({ provider: "kimi-coding", level: 3, windows: [win("week", 100, 3)] }),
      zai: makeVerdict({ provider: "zai", level: 3, stale: true, windows: [win("5h", 99, 3)] }),
      "zai-coding-cn": makeVerdict({ provider: "zai-coding-cn", level: 1, windows: [win("5h", 30, 1)] }),
    };
    const deps = gateDeps((p) => verdicts[p]);
    // kimi (fresh L3) is excluded; stale zai counts as healthy (R5) and
    // the unmanaged cloudrouter keeps its registry position after it.
    expect(pickAlternatives("zai-coding-cn", deps)).toEqual(["zai/glm-5.3-air", "cloudrouter-anthropic/claude-opus-5"]);
  });

  it("defaults to the level-3 exclusion line when deps carries no blockAtLevel (hook-side Pick)", () => {
    const verdicts: Record<string, ProviderVerdict> = {
      "kimi-coding": makeVerdict({ provider: "kimi-coding", level: 3, windows: [win("week", 100, 3)] }),
      zai: makeVerdict({ provider: "zai", level: 2, windows: [win("5h", 76, 2)] }),
    };
    const hookDeps = { verdictFor: (p: string) => verdicts[p], available: () => CANDIDATES };
    // No blockAtLevel in the deps → exclusion defaults to 3, so an L2 provider
    // stays recommendable even though an aggressive gateLevel=2 gate would block it.
    expect(pickAlternatives("zai-coding-cn", hookDeps)).toEqual([
      "zai/glm-5.3-air",
      "cloudrouter-anthropic/claude-opus-5",
    ]);
  });

  it("respects the exclusion line carried by full QuotaGateDeps (gateLevel 2 excludes L2)", () => {
    const verdicts: Record<string, ProviderVerdict> = {
      "kimi-coding": makeVerdict({ provider: "kimi-coding", level: 2, windows: [win("5h", 76, 2)] }),
      zai: makeVerdict({ provider: "zai", level: 1, windows: [win("5h", 55, 1)] }),
    };
    const full = gateDeps((p) => verdicts[p], 2);
    expect(pickAlternatives("zai-coding-cn", full)).toEqual(["zai/glm-5.3-air", "cloudrouter-anthropic/claude-opus-5"]);
  });

  it("returns [] for limit 0 and keeps registry order among equal scores", () => {
    expect(
      pickAlternatives(
        "zai-coding-cn",
        gateDeps(() => undefined),
        0,
      ),
    ).toEqual([]);
    expect(
      pickAlternatives(
        "zai-coding-cn",
        gateDeps(() => undefined),
      ),
    ).toEqual(["kimi-coding/kimi-k3", "zai/glm-5.3-air", "cloudrouter-anthropic/claude-opus-5"]);
  });
});

describe("quotaAnnotation", () => {
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
