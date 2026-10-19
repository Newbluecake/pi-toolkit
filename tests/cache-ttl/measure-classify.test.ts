import { describe, expect, it } from "vitest";
import {
  boundBroken,
  classifyRead,
  computeTtlResult,
  decideControl,
  describeTtl,
  ownPrefixSufficient,
  recordEligible,
  slackOf,
  slotBaselineOf,
} from "../../src/cache-ttl/measure-classify.js";
import {
  OUTPUT_ALLOWANCE_TOKENS,
  P_BOUND_TOKENS,
  TTL_GAPS_MS,
  type SlotBaseline,
  type TtlSampleRecord,
} from "../../src/cache-ttl/measure-types.js";

const base = (P_w: number, B: number): SlotBaseline => ({ P_w, B, S: P_w - B });

describe("slotBaselineOf / slack / own prefix", () => {
  it("B = C_w, S = P_w − B", () => {
    expect(slotBaselineOf({ P: 19_300, C: 4_224 })).toEqual({ P_w: 19_300, B: 4_224, S: 15_076 });
  });
  it("slack(P) = max(512, ⌈0.02·P⌉)", () => {
    expect(slackOf(10_000)).toBe(512);
    expect(slackOf(25_600)).toBe(512);
    expect(slackOf(25_601)).toBe(513);
    expect(slackOf(100_000)).toBe(2_000);
  });
  it("own prefix needs S ≥ 4096 AND S ≥ 0.5·P_w (boundaries)", () => {
    expect(ownPrefixSufficient(base(8_192, 4_096))).toBe(true); // S = 4096 = 0.5·P_w
    expect(ownPrefixSufficient(base(8_191, 4_095))).toBe(true); // S = 4096 ≥ 0.5·8191
    expect(ownPrefixSufficient(base(8_192, 4_097))).toBe(false); // S = 4095 < 4096
    expect(ownPrefixSufficient(base(30_000, 15_001))).toBe(false); // S = 14999 < 0.5·P_w
    expect(ownPrefixSufficient(base(30_000, 15_000))).toBe(true);
  });
});

describe("classifyRead (§5.3)", () => {
  const b = base(15_000, 0);
  it("plain route: hit / miss / partial thresholds are exactly 80% / 20% of S", () => {
    expect(classifyRead(b, { P: 15_000, C: 15_000 })).toEqual({ kind: "hit" });
    expect(classifyRead(b, { P: 15_000, C: 12_000 })).toEqual({ kind: "hit" }); // =0.8·S
    expect(classifyRead(b, { P: 15_000, C: 11_999 })).toEqual({ kind: "inconclusive", reason: "partial" });
    expect(classifyRead(b, { P: 15_000, C: 3_000 })).toEqual({ kind: "miss" }); // =0.2·S
    expect(classifyRead(b, { P: 15_000, C: 3_001 })).toEqual({ kind: "inconclusive", reason: "partial" });
    expect(classifyRead(b, { P: 15_000, C: 0 })).toEqual({ kind: "miss" });
  });

  it("baseline B is subtracted: a relay with a cached 4096 baseline reads as a miss at C = B", () => {
    const relay = base(19_100, 4_096); // S = 15_004
    expect(classifyRead(relay, { P: 19_100, C: 4_096 })).toEqual({ kind: "miss" });
    expect(classifyRead(relay, { P: 19_100, C: 19_100 })).toEqual({ kind: "hit" });
    // without subtracting B this would look like a 21% "hit-ish" read — it must be a miss
    expect(classifyRead(relay, { P: 19_100, C: 4_096 + 3_000 })).toEqual({ kind: "miss" });
    // a read BELOW the baseline is still a miss
    expect(classifyRead(relay, { P: 19_100, C: 100 })).toEqual({ kind: "miss" });
  });

  it("a 4.2k injected baseline stays measurable (cr-response shape)", () => {
    const w = slotBaselineOf({ P: 19_200, C: 4_224 });
    expect(ownPrefixSufficient(w)).toBe(true);
    expect(classifyRead(w, { P: 19_200, C: 19_200 })).toEqual({ kind: "hit" });
    expect(classifyRead(w, { P: 19_200, C: 4_224 })).toEqual({ kind: "miss" });
  });

  it("own-prefix-small wins over everything", () => {
    expect(classifyRead(base(9_000, 6_000), { P: 9_000, C: 9_000 })).toEqual({
      kind: "inconclusive",
      reason: "own-prefix-small",
    });
    expect(classifyRead(base(30_000, 20_000), { P: 30_000, C: 30_000 })).toEqual({
      kind: "inconclusive",
      reason: "own-prefix-small",
    });
  });

  it("backend-mismatch when |P − P_w| > slack(P_w)", () => {
    expect(classifyRead(b, { P: 15_512, C: 15_000 })).toEqual({ kind: "hit" }); // = slack
    expect(classifyRead(b, { P: 15_513, C: 15_000 })).toEqual({ kind: "inconclusive", reason: "backend-mismatch" });
    expect(classifyRead(b, { P: 14_487, C: 0 })).toEqual({ kind: "inconclusive", reason: "backend-mismatch" });
    expect(classifyRead(b, { P: 14_488, C: 0 })).toEqual({ kind: "miss" });
  });
});

describe("bound guard (G-a: frozen P_bound−1 / = / +1)", () => {
  const cap = OUTPUT_ALLOWANCE_TOKENS["anthropic-messages"];
  it("P_bound−1 and P_bound are within the bound, P_bound+1 breaks C1", () => {
    expect(boundBroken({ P: P_BOUND_TOKENS - 1, C: 0 }, P_BOUND_TOKENS, cap)).toBeUndefined();
    expect(boundBroken({ P: P_BOUND_TOKENS, C: 0 }, P_BOUND_TOKENS, cap)).toBeUndefined();
    expect(boundBroken({ P: P_BOUND_TOKENS + 1, C: 0 }, P_BOUND_TOKENS, cap)).toBe("C1");
  });
  it("output above the allowance breaks C2 (allowance itself is fine, absent output is fine)", () => {
    expect(boundBroken({ P: 100, C: 0, output: cap }, P_BOUND_TOKENS, cap)).toBeUndefined();
    expect(boundBroken({ P: 100, C: 0, output: cap + 1 }, P_BOUND_TOKENS, cap)).toBe("C2");
    expect(boundBroken({ P: 100, C: 0 }, P_BOUND_TOKENS, cap)).toBeUndefined();
    expect(boundBroken(undefined, P_BOUND_TOKENS, cap)).toBeUndefined();
  });
  it.each(["anthropic-messages", "openai-completions", "openai-responses"] as const)(
    "%s C2 uses the per-profile allowance, never the wire cap",
    (api) => {
      const allowance = OUTPUT_ALLOWANCE_TOKENS[api];
      expect(boundBroken({ P: 100, C: 0, output: allowance }, P_BOUND_TOKENS, allowance)).toBeUndefined();
      expect(boundBroken({ P: 100, C: 0, output: allowance + 1 }, P_BOUND_TOKENS, allowance)).toBe("C2");
    },
  );
  it("live Responses output 32 (including reasoning) is well within its 512-token allowance", () => {
    expect(
      boundBroken({ P: 14287, C: 0, output: 32 }, P_BOUND_TOKENS, OUTPUT_ALLOWANCE_TOKENS["openai-responses"]),
    ).toBeUndefined();
  });
  it("a real ~19.2k baseline fixture (cr-response: 15k own + 4.2k injected) is inside the bound with ~1.7k room", () => {
    const P = 15_000 + 4_224;
    expect(P).toBeLessThanOrEqual(P_BOUND_TOKENS);
    expect(boundBroken({ P, C: 4_224 }, P_BOUND_TOKENS, cap)).toBeUndefined();
    // the bound is NOT "+6k ⇒ over": T_hi(16305) + 6000 = 22305 is over, T_mid(15000) + 6000 = 21000 is also over,
    // but T_lo(9375) + 6000 is not — assert each against the frozen number, not against prose
    expect(boundBroken({ P: 15_000 + 6_000, C: 0 }, P_BOUND_TOKENS, cap)).toBe("C1");
    expect(boundBroken({ P: 9_375 + 6_000, C: 0 }, P_BOUND_TOKENS, cap)).toBeUndefined();
  });
});

describe("decideControl", () => {
  it("valid hit ⇒ proceed (first or second attempt)", () => {
    expect(decideControl(["hit"])).toEqual({ kind: "proceed" });
    expect(decideControl(["other", "hit"])).toEqual({ kind: "proceed" });
    expect(decideControl(["miss", "hit"])).toEqual({ kind: "proceed" });
  });
  it("anything but a hit on the first attempt ⇒ the single retry", () => {
    expect(decideControl(["miss"])).toEqual({ kind: "retry" });
    expect(decideControl(["other"])).toEqual({ kind: "retry" });
  });
  it("two valid misses ⇒ no-cache; any mix with an inconclusive ⇒ control-inconclusive", () => {
    expect(decideControl(["miss", "miss"])).toEqual({ kind: "no-cache" });
    expect(decideControl(["miss", "other"])).toEqual({ kind: "control-inconclusive" });
    expect(decideControl(["other", "miss"])).toEqual({ kind: "control-inconclusive" });
    expect(decideControl(["other", "other"])).toEqual({ kind: "control-inconclusive" });
  });
});

describe("computeTtlResult (§5.4)", () => {
  const G = TTL_GAPS_MS;
  const hit = (i: number, lo: number, hi = lo + 2_000): TtlSampleRecord => ({
    gapMs: G[i]!,
    verdict: "hit",
    idleMs: [lo, hi],
    cacheEvidence: "valid",
  });
  const miss = (i: number, lo: number, hi: number): TtlSampleRecord => ({
    gapMs: G[i]!,
    verdict: "miss",
    idleMs: [lo, hi],
    cacheEvidence: "valid",
  });
  const inconclusive = (i: number): TtlSampleRecord => ({ gapMs: G[i]!, verdict: "inconclusive", reason: "late" });

  it("lower = max valid-hit idle.lo; miss = min valid-miss idle.hi; consistent", () => {
    const r = computeTtlResult(
      [
        hit(0, 180_100),
        hit(1, 360_100),
        miss(2, 660_100, 662_000),
        { gapMs: G[3]!, verdict: "skipped", reason: "implied-miss" },
      ],
      "complete",
    );
    expect(r).toMatchObject({
      lowerMs: 360_100,
      missMs: 662_000,
      consistent: true,
      validHits: 2,
      validMisses: 1,
      reachedMaxGap: false,
      eligible: true,
    });
  });

  it("no valid hit ⇒ lower unknown, never eligible (control-only is partial and ineligible)", () => {
    const r = computeTtlResult([miss(0, 180_000, 182_000)], "partial");
    expect(r.lowerMs).toBeUndefined();
    expect(r.eligible).toBe(false);
    expect(computeTtlResult([], "partial")).toMatchObject({ validHits: 0, validMisses: 0, eligible: false });
    expect(computeTtlResult([inconclusive(0), inconclusive(1)], "partial").lowerMs).toBeUndefined();
  });

  it('"reached max gap" (≥ 61 min) only with a valid hit at the 61-min arm', () => {
    const all = [0, 1, 2, 3, 4].map((i) => hit(i, G[i]! + 100));
    expect(computeTtlResult(all, "complete").reachedMaxGap).toBe(false);
    const withMax = computeTtlResult([...all, hit(5, 3_660_100)], "complete");
    expect(withMax.reachedMaxGap).toBe(true);
    expect(withMax.lowerMs).toBe(3_660_100);
    // an inconclusive or invalid-evidence 61-min arm does not count
    expect(computeTtlResult([...all, inconclusive(5)], "partial").reachedMaxGap).toBe(false);
    expect(
      computeTtlResult([...all, { ...hit(5, 3_660_100), cacheEvidence: "invalid" as const }], "partial").reachedMaxGap,
    ).toBe(false);
  });

  it("invalid-evidence samples are not valid samples", () => {
    const r = computeTtlResult([{ ...hit(0, 180_100), cacheEvidence: "invalid" }], "partial");
    expect(r.validHits).toBe(0);
    expect(r.lowerMs).toBeUndefined();
  });

  it("inconsistent (a hit idle.lo ≥ a miss idle.hi) ⇒ consistent=false and ineligible", () => {
    const r = computeTtlResult([hit(2, 660_100), miss(1, 360_100, 362_000)], "complete");
    expect(r.consistent).toBe(false);
    expect(r.eligible).toBe(false);
  });

  it("eligibility: status complete/partial, ≥ 1 hit, lower ≥ 150 s", () => {
    expect(computeTtlResult([hit(0, 149_999)], "complete").eligible).toBe(false);
    expect(computeTtlResult([hit(0, 150_000)], "complete").eligible).toBe(true);
    expect(computeTtlResult([hit(0, 180_100)], "partial").eligible).toBe(true);
    for (const status of [
      "cancelled",
      "failed",
      "no-cache",
      "control-inconclusive",
      "inconclusive",
      "running",
      "interrupted",
    ] as const) {
      expect(computeTtlResult([hit(0, 180_100)], status).eligible).toBe(false);
    }
  });

  it("a miss is never presented as a TTL ceiling", () => {
    const text = describeTtl(computeTtlResult([hit(1, 360_100), miss(2, 660_100, 662_000)], "complete"));
    expect(text).toMatch(/ttl ≥ 6\.\d min/);
    expect(text).toContain("miss observed at ≤");
    expect(text).toContain("expiry or eviction");
    expect(text).not.toMatch(/ttl ≤|ttl <|ceiling/i);
  });

  it("describeTtl: unknown without a hit; ≥ 61 min only with the max-gap hit", () => {
    expect(describeTtl(computeTtlResult([], "partial"))).toBe("ttl unknown (no valid hit)");
    const reached = computeTtlResult([hit(5, 3_660_100)], "complete");
    expect(describeTtl(reached)).toBe("ttl ≥ 61 min");
    expect(describeTtl(computeTtlResult([hit(4, 1_860_100)], "partial"))).toMatch(/^ttl ≥ 31\.\d min$/);
  });
});

describe("recordEligible (consumer side, incl. age)", () => {
  const ttl = computeTtlResult(
    [{ gapMs: 360_000, verdict: "hit", idleMs: [360_100, 362_000], cacheEvidence: "valid" }],
    "complete",
  );
  const now = 100 * 24 * 3_600_000;
  const run = (finishedAt: number, status: "complete" | "cancelled" = "complete") => ({
    status,
    ttl,
    startedAt: finishedAt - 60_000,
    finishedAt,
  });
  it("fresh record is eligible", () => expect(recordEligible(run(now - 1_000), now)).toBe(true));
  it("exactly 30 days old is eligible, older is not", () => {
    const d30 = 30 * 24 * 3_600_000;
    expect(recordEligible(run(now - d30), now)).toBe(true);
    expect(recordEligible(run(now - d30 - 1), now)).toBe(false);
  });
  it("status, consistency and lower bound still gate", () => {
    expect(recordEligible(run(now - 1_000, "cancelled"), now)).toBe(false);
    expect(recordEligible({ ...run(now - 1_000), ttl: { ...ttl, consistent: false } }, now)).toBe(false);
    expect(recordEligible({ ...run(now - 1_000), ttl: { ...ttl, lowerMs: 149_000 } }, now)).toBe(false);
    expect(recordEligible({ ...run(now - 1_000), ttl: { ...ttl, validHits: 0 } }, now)).toBe(false);
  });
  it("a record dated far in the future (clock skew / tampering) is not eligible", () => {
    expect(recordEligible(run(now + 10 * 60_000), now)).toBe(false);
  });
});
