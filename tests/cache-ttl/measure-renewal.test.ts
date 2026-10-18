import { describe, expect, it } from "vitest";
import {
  evaluateBasis,
  documentedCeilingFor,
  finalizeRenewal,
  intervalBetween,
  planRenewal,
  readInfoFromClassification,
  unsentRenewalRecord,
  type RenewalGeometry,
} from "../../src/cache-ttl/measure-renewal.js";
import {
  RENEWAL,
  TTL_GAPS_MS,
  type EffectiveTier,
  type RequestTiming,
  type SlotBaseline,
} from "../../src/cache-ttl/measure-types.js";

const OFFICIAL = "https://api.anthropic.com";
const RELAY = "https://relay.example";
const T0 = 1_000_000_000;

/**
 * Re-creates the run's real timing for slot `a` (hit at r1) and slot `b` (first miss): sequential writes (each takes
 * `L`, then `pause` before the next), the control shift when `b` is slot 5 (control at write5.headers + 30 s, its
 * response takes `L`, probe anchor moves there), probes sent exactly at `anchor.headers + gap`.
 */
function timeline(
  a: number,
  b: number,
  o: { L: number; pause: number },
): Omit<RenewalGeometry, "tier" | "origin" | "rateLimited" | "involvedValid"> & { writes: RequestTiming[] } {
  const { L, pause } = o;
  const writes: RequestTiming[] = [];
  let t = T0;
  for (let i = 0; i < 6; i++) {
    writes.push({ sentAt: t, headersAt: t + L });
    t += L + pause;
  }
  const anchorOf = (i: number): RequestTiming => {
    if (i !== 5) return writes[i]!;
    const sentAt = writes[5]!.headersAt + 30_000;
    return { sentAt, headersAt: sentAt + L };
  };
  const probe = (i: number): RequestTiming => {
    const sentAt = anchorOf(i).headersAt + TTL_GAPS_MS[i]!;
    return { sentAt, headersAt: sentAt + L };
  };
  const r1 = probe(a);
  return {
    lowerMs: r1.sentAt - writes[a]!.headersAt,
    touchedGapMs: TTL_GAPS_MS[a]!,
    untouchedGapMs: TTL_GAPS_MS[b]!,
    wA: writes[a]!,
    r1,
    wB: writes[b]!,
    miss: probe(b),
    writes,
  };
}

const geo = (
  a: number,
  b: number,
  o: { L: number; pause: number },
  extra: Partial<RenewalGeometry> = {},
): RenewalGeometry => {
  const { writes: _w, ...t } = timeline(a, b, o);
  void _w;
  return { tier: "auto", origin: RELAY, rateLimited: false, involvedValid: true, ...t, ...extra };
};

/** Closed-form from the §5.5 definitions, derived independently of the implementation (see derivation in the test). */
function pairedEligibleClosedForm(
  a: number,
  b: number,
  o: { L: number; pause: number },
  lR: number,
  planned: boolean,
): boolean {
  const { L, pause } = o;
  const ga = TTL_GAPS_MS[a]!;
  const gb = TTL_GAPS_MS[b]!;
  const D = (b - a) * (L + pause); // header-to-header spacing of the two writes
  const shift = b === 5 ? 30_000 + L : 0; // control touch moves slot 5's anchor
  // miss.headers = wA.headers + D + shift + gb + L ; R.sent = miss.headers + 10 s ; R.headers = R.sent + lR
  const rHeadersMinusR1Sent = D + shift + gb + L + RENEWAL.delayAfterMissMs + (planned ? 30_000 : lR) - ga;
  const idleOk = rHeadersMinusR1Sent + RENEWAL.idleMarginMs < ga; // survival = lowerMs = ga
  // age: ageR.lo = D + shift + gb + L + 10 s ; K + 10 s = (shift + gb + 2L... ) + 10 s ⇒ ageR.lo − (K+10 s) = D − L_wb ≥ 0
  const ageOk = D - L >= 0;
  return idleOk && ageOk;
}

describe("intervalBetween", () => {
  it("[y.sentAt − x.headersAt, y.headersAt − x.sentAt]", () => {
    expect(intervalBetween({ sentAt: 100, headersAt: 130 }, { sentAt: 1_000, headersAt: 1_020 })).toEqual([870, 920]);
  });
});

describe("renewal eligibility from ACTUAL send intervals (G-b)", () => {
  const grid = [
    { L: 500, pause: 0 },
    { L: 1_000, pause: 0 },
    { L: 2_000, pause: 0 },
    { L: 2_000, pause: 5_000 },
    { L: 5_000, pause: 2_000 },
    { L: 8_000, pause: 8_000 },
    { L: 12_000, pause: 0 },
  ];

  for (let a = 0; a < 5; a++) {
    const b = a + 1;
    const name = `${TTL_GAPS_MS[a]! / 60_000}→${TTL_GAPS_MS[b]! / 60_000} min`;
    it(`paired-empirical on a relay, ${name}: the plan's pre-send check and the post-send check equal the closed form for every latency/pause`, () => {
      for (const o of grid) {
        const g = geo(a, b, o);
        // pre-send check (planned R: headersAt bounded by the 30 s deadline)
        expect(planRenewal(g).eligible, `plan ${name} ${JSON.stringify(o)}`).toBe(
          pairedEligibleClosedForm(a, b, o, 30_000, true),
        );
        // post-send check with the real R (sent exactly 10 s after the miss, latency L)
        const rSent = g.miss.headersAt + RENEWAL.delayAfterMissMs;
        const e = evaluateBasis("paired-empirical", g, { sentAt: rSent, headersAt: rSent + o.L })!;
        expect(e.ok, `post ${name} ${JSON.stringify(o)}`).toBe(pairedEligibleClosedForm(a, b, o, o.L, false));
      }
    });
  }

  it("3→6 is NEVER eligible on a relay (idle needs 2·180 s > 360 s + 20 s margins) — for every grid point", () => {
    for (const o of grid) expect(planRenewal(geo(0, 1, o)).eligible).toBe(false);
    // even with zero latency and zero pause it cannot pass
    expect(planRenewal(geo(0, 1, { L: 0, pause: 0 })).eligible).toBe(false);
    expect(
      evaluateBasis("paired-empirical", geo(0, 1, { L: 0, pause: 0 }), {
        sentAt: T0 + 400_000,
        headersAt: T0 + 400_000,
      })!.failed,
    ).toBe("idle");
  });

  it("21→31 is comfortably eligible on a relay at any realistic latency", () => {
    for (const o of grid) expect(planRenewal(geo(3, 4, o)).eligible, JSON.stringify(o)).toBe(true);
  });

  it("6→11 and 11→21 have ~1 min slack (2·g_a − g_b = 60 s): eligible only for fast writes", () => {
    // hand-computed: idleHi = D + g_b + L + 10 s + L_R − g_a, need idleHi + 10 s < g_a
    // 6→11 with L = 1 s, pause 0 ⇒ D = 1 s: 1 + 660 + 1 + 10 + 1 − 360 = 313 s; +10 = 323 s < 360 s ✓ (actual)
    const fast = geo(1, 2, { L: 1_000, pause: 0 });
    const rSent = fast.miss.headersAt + 10_000;
    const e = evaluateBasis("paired-empirical", fast, { sentAt: rSent, headersAt: rSent + 1_000 })!;
    expect(e.idleRMs).toEqual([311_000, 313_000]);
    expect(e.ok).toBe(true);
    expect(e.ageRMs[0]).toBe(672_000);
    expect(e.ceilingMs).toBe(662_000); // missAge.hi = miss.headers − w_b.sent
    // the planned (worst-case 30 s) check leaves 8 s margin here
    expect(planRenewal(fast).eligible).toBe(true);
    // slow responses (L = 12 s): the planned worst case (30 s response) no longer fits, so no request is sent
    expect(planRenewal(geo(1, 2, { L: 12_000, pause: 0 })).eligible).toBe(false);
    // 11→21 same arithmetic (2·660 − 1260 = 60 s)
    expect(planRenewal(geo(2, 3, { L: 1_000, pause: 0 })).eligible).toBe(true);
    expect(planRenewal(geo(2, 3, { L: 12_000, pause: 5_000 })).eligible).toBe(false);
  });

  it("31→61 on a relay depends on slot 5's control shift: flips between L = 1 s and L = 3 s", () => {
    // L = 1 s: shift 31 s + D 1 s + 3660 + 1 + 10 + 1 − 1860 = 1843 s; +10 = 1853 s < 1860 s ⇒ actual eligible
    const fast = geo(4, 5, { L: 1_000, pause: 0 });
    const rSent = fast.miss.headersAt + 10_000;
    expect(evaluateBasis("paired-empirical", fast, { sentAt: rSent, headersAt: rSent + 1_000 })!.ok).toBe(true);
    // …but the planned worst case (30 s response) is not: the run would send nothing
    expect(planRenewal(fast).eligible).toBe(false);
    // L = 3 s: 33 + 3 + 3660 + 3 + 10 + 3 − 1860 = 1852 s; +10 = 1862 s ≥ 1860 s ⇒ ineligible even after the fact
    const slow = geo(4, 5, { L: 3_000, pause: 0 });
    const rs = slow.miss.headersAt + 10_000;
    const e = evaluateBasis("paired-empirical", slow, { sentAt: rs, headersAt: rs + 3_000 })!;
    expect(e.ok).toBe(false);
    expect(e.failed).toBe("idle");
  });

  it("missAge for K is measured from slot b's WRITE (conservative for slot 5's control-shifted probe anchor)", () => {
    const g = geo(4, 5, { L: 1_000, pause: 0 });
    const e = evaluateBasis("paired-empirical", g, {
      sentAt: g.miss.headersAt + 10_000,
      headersAt: g.miss.headersAt + 11_000,
    })!;
    expect(e.missAgeMs).toEqual([g.miss.sentAt - g.wB.headersAt, g.miss.headersAt - g.wB.sentAt]);
    // the write-anchored age is larger than the control-anchored idle the sample shows (30 s + latency more)
    const controlAnchored = g.miss.sentAt - (g.wB.headersAt + 30_000 + 1_000);
    expect(e.missAgeMs[0]).toBeGreaterThan(controlAnchored);
  });

  it("documented ceiling: 3→6 short and 31→61 long qualify on api.anthropic.com only", () => {
    // 3→6 short (K = 300 s, m = 30 s, survival = max(lowerMs, 300 s)); hand-computed for L = 1 s, pause 0
    const g = geo(0, 1, { L: 1_000, pause: 0 }, { tier: "ephemeral", origin: OFFICIAL });
    const p = planRenewal(g);
    expect(p).toMatchObject({ eligible: true, basis: "documented-ceiling", ceilingMs: 300_000 });
    const rSent = g.miss.headersAt + 10_000;
    const e = evaluateBasis("documented-ceiling", g, { sentAt: rSent, headersAt: rSent + 1_000 })!;
    expect(e.ageRMs[0]).toBe(372_000); // ≥ 300 s + 30 s
    expect(e.idleRMs).toEqual([191_000, 193_000]); // 193 s + 10 s < 300 s
    expect(e.ok).toBe(true);
    // the very same timings on a relay: paired-empirical is ineligible
    expect(planRenewal(geo(0, 1, { L: 1_000, pause: 0 }, { tier: "ephemeral", origin: RELAY })).eligible).toBe(false);

    // 31→61 long (K = 3600 s): official qualifies even with slow control/latency
    const long = geo(4, 5, { L: 3_000, pause: 0 }, { tier: "ephemeral-1h", origin: OFFICIAL });
    expect(planRenewal(long)).toMatchObject({ eligible: true, basis: "documented-ceiling", ceilingMs: 3_600_000 });
    expect(planRenewal(geo(4, 5, { L: 3_000, pause: 0 }, { tier: "ephemeral-1h", origin: RELAY })).eligible).toBe(
      false,
    );
  });

  it("documented basis needs the official origin AND an Anthropic ephemeral tier", () => {
    expect(documentedCeilingFor("ephemeral", OFFICIAL)).toBe(300_000);
    expect(documentedCeilingFor("ephemeral-1h", "HTTPS://API.ANTHROPIC.COM")).toBe(3_600_000);
    for (const tier of ["auto", "retention-24h", "explicit-30m"] as EffectiveTier[])
      expect(documentedCeilingFor(tier, OFFICIAL)).toBeUndefined();
    for (const origin of [
      undefined,
      RELAY,
      "https://api.anthropic.com:443",
      "https://api.anthropic.com.evil.test",
      "http://api.anthropic.com",
    ]) {
      expect(documentedCeilingFor("ephemeral", origin)).toBeUndefined();
    }
    expect(
      evaluateBasis("documented-ceiling", geo(0, 1, { L: 1_000, pause: 0 }, { origin: RELAY }), {
        sentAt: T0,
        headersAt: T0,
      }),
    ).toBeUndefined();
  });

  it("documented survival is max(lowerMs, K): a hit longer than the documented ceiling widens it", () => {
    // slot 1 (6 min) hit on an ephemeral tier ⇒ lowerMs 360 s > K 300 s ⇒ survival 360 s
    const g = geo(1, 2, { L: 1_000, pause: 0 }, { tier: "ephemeral", origin: OFFICIAL });
    const rSent = g.miss.headersAt + 10_000;
    const e = evaluateBasis("documented-ceiling", g, { sentAt: rSent, headersAt: rSent + 1_000 })!;
    expect(e.idleRMs[1] + RENEWAL.idleMarginMs).toBe(323_000); // < survival 360 s
    expect(e.ok).toBe(true);
    const tight = evaluateBasis("documented-ceiling", g, { sentAt: rSent, headersAt: rSent + 40_000 })!;
    expect(tight.ok).toBe(false); // 352 s + 10 s ≥ 360 s
  });
});

describe("renewal verdicts (never `false`)", () => {
  const baselineA: SlotBaseline = { P_w: 15_000, B: 0, S: 15_000 };
  const hitRead = (g: RenewalGeometry, latency = 1_000, P = 15_000) => {
    const sentAt = g.miss.headersAt + RENEWAL.delayAfterMissMs;
    return { verdict: "hit" as const, timing: { sentAt, headersAt: sentAt + latency }, usage: { P, C: P }, baselineA };
  };

  it("true / documented-ceiling (no assumptions) on the official origin", () => {
    const g = geo(0, 1, { L: 1_000, pause: 0 }, { tier: "ephemeral", origin: OFFICIAL });
    const rec = finalizeRenewal(g, hitRead(g));
    expect(rec).toMatchObject({
      renewsOnRead: "true",
      basis: "documented-ceiling",
      ceilingMs: 300_000,
      touchedGapMs: 180_000,
      untouchedGapMs: 360_000,
      read: { verdict: "hit", P: 15_000, C: 15_000, B: 0, S: 15_000 },
    });
    expect(rec.assumptions).toBeUndefined();
    expect(rec.ageRMs![0]).toBeGreaterThanOrEqual(330_000);
    expect(rec.idleRMs).toBeDefined();
    expect(rec.missAgeMs).toEqual(intervalBetween(g.wB, g.miss));
  });

  it("true / paired-empirical on a relay, with the stated assumptions and raw timings", () => {
    const g = geo(3, 4, { L: 1_000, pause: 0 });
    const rec = finalizeRenewal(g, hitRead(g));
    expect(rec.renewsOnRead).toBe("true");
    expect(rec.basis).toBe("paired-empirical");
    expect(rec.assumptions).toEqual([
      "same backend class",
      "same eviction pressure",
      "same cache policy across prefixes",
    ]);
    expect(rec.ceilingMs).toBe(rec.missAgeMs![1]); // K = missAge.hi
    expect(rec.read).toMatchObject({ sentAt: g.miss.headersAt + 10_000, headersAt: g.miss.headersAt + 11_000 });
  });

  it("paired-empirical needs: no 429 in the run and all involved requests valid", () => {
    const g1 = geo(3, 4, { L: 1_000, pause: 0 }, { rateLimited: true });
    expect(finalizeRenewal(g1, hitRead(g1))).toMatchObject({ renewsOnRead: "unknown", reason: "pair-ineligible" });
    const g2 = geo(3, 4, { L: 1_000, pause: 0 }, { involvedValid: false });
    expect(finalizeRenewal(g2, hitRead(g2))).toMatchObject({ renewsOnRead: "unknown", reason: "pair-ineligible" });
    // the documented basis does not need them (official endpoint semantics)
    const g3 = geo(0, 1, { L: 1_000, pause: 0 }, { tier: "ephemeral", origin: OFFICIAL, rateLimited: true });
    expect(finalizeRenewal(g3, hitRead(g3)).renewsOnRead).toBe("true");
  });

  it("a MISS of R is unknown(renewal-miss) — never false", () => {
    const g = geo(3, 4, { L: 1_000, pause: 0 });
    const sentAt = g.miss.headersAt + 10_000;
    const rec = finalizeRenewal(g, {
      verdict: "miss",
      timing: { sentAt, headersAt: sentAt + 1_000 },
      usage: { P: 15_000, C: 0 },
      baselineA,
    });
    expect(rec).toMatchObject({
      renewsOnRead: "unknown",
      reason: "renewal-miss",
      read: { verdict: "miss", P: 15_000, C: 0 },
    });
    expect(rec.renewsOnRead).not.toBe("false");
    expect(rec.basis).toBeUndefined();
  });

  it("a hit whose prompt size differs beyond the slack ⇒ unknown(backend-mismatch)", () => {
    const g = geo(3, 4, { L: 1_000, pause: 0 });
    expect(finalizeRenewal(g, hitRead(g, 1_000, 15_513))).toMatchObject({
      renewsOnRead: "unknown",
      reason: "backend-mismatch",
    });
    expect(finalizeRenewal(g, hitRead(g, 1_000, 15_512)).renewsOnRead).toBe("true");
  });

  it("a hit that fails the post-send pair check (R came late) ⇒ unknown(pair-ineligible), request already spent", () => {
    const g = geo(3, 4, { L: 1_000, pause: 0 });
    const late = hitRead(g);
    // R sent 25 min late: idle far exceeds survival
    const timing = { sentAt: late.timing.sentAt + 25 * 60_000, headersAt: late.timing.headersAt + 25 * 60_000 };
    const rec = finalizeRenewal(g, { ...late, timing });
    expect(rec).toMatchObject({ renewsOnRead: "unknown", reason: "pair-ineligible" });
    expect(rec.read).toMatchObject({ verdict: "hit" });
    expect(rec.idleRMs).toBeDefined();
  });

  it("inconclusive / not-sent reads carry their reason", () => {
    const g = geo(3, 4, { L: 1_000, pause: 0 });
    expect(
      finalizeRenewal(g, { verdict: "inconclusive", reason: "sent-lost", timing: { sentAt: 1, headersAt: 2 } }),
    ).toMatchObject({
      renewsOnRead: "unknown",
      reason: "sent-lost",
      read: { verdict: "inconclusive", sentAt: 1, headersAt: 2 },
    });
    expect(finalizeRenewal(g, { verdict: "not-sent", reason: "budget" })).toMatchObject({
      renewsOnRead: "unknown",
      reason: "budget",
      read: { verdict: "not-sent" },
    });
    expect(finalizeRenewal(g, { verdict: "inconclusive", reason: "rate-limited" }).read).toEqual({
      verdict: "inconclusive",
    });
  });

  it("readInfoFromClassification maps hit/miss and keeps the inconclusive reason", () => {
    const timing = { sentAt: 10, headersAt: 20 };
    const usage = { P: 1, C: 1 };
    expect(readInfoFromClassification({ kind: "hit" }, timing, usage, baselineA).verdict).toBe("hit");
    expect(readInfoFromClassification({ kind: "miss" }, timing, usage, baselineA).verdict).toBe("miss");
    expect(
      readInfoFromClassification({ kind: "inconclusive", reason: "partial" }, timing, usage, baselineA),
    ).toMatchObject({ verdict: "inconclusive", reason: "partial" });
    expect(
      readInfoFromClassification({ kind: "inconclusive", reason: "backend-mismatch" }, timing, usage, baselineA),
    ).toMatchObject({ reason: "backend-mismatch" });
  });

  it("unsentRenewalRecord: unknown(reason) with the geometry when known", () => {
    expect(unsentRenewalRecord("no-expiry-observed")).toEqual({
      renewsOnRead: "unknown",
      reason: "no-expiry-observed",
    });
    const g = geo(0, 1, { L: 1_000, pause: 0 });
    expect(unsentRenewalRecord("pair-ineligible", g)).toMatchObject({
      renewsOnRead: "unknown",
      reason: "pair-ineligible",
      touchedGapMs: 180_000,
      untouchedGapMs: 360_000,
    });
  });

  it("property: no input combination ever yields renewsOnRead = 'false'", () => {
    const outcomes = [
      (g: RenewalGeometry) => hitRead(g),
      (g: RenewalGeometry) => ({ ...hitRead(g), verdict: "miss" as const, usage: { P: 15_000, C: 0 } }),
      () => ({ verdict: "inconclusive" as const, reason: "partial" as const }),
      () => ({ verdict: "not-sent" as const, reason: "not-sent" as const }),
    ];
    for (const o of [
      { L: 500, pause: 0 },
      { L: 5_000, pause: 5_000 },
    ]) {
      for (let a = 0; a < 5; a++) {
        for (const origin of [OFFICIAL, RELAY]) {
          for (const tier of ["ephemeral", "ephemeral-1h", "auto"] as EffectiveTier[]) {
            const g = geo(a, a + 1, o, { origin, tier });
            for (const mk of outcomes) expect(finalizeRenewal(g, mk(g)).renewsOnRead).not.toBe("false");
          }
        }
      }
    }
  });

  it("RENEWAL constants are the plan's (documented 300 s/3600 s, margins 30 s / 10 s, R 10 s after the miss)", () => {
    expect(RENEWAL.documentedCeilingMs).toEqual({ ephemeral: 300_000, "ephemeral-1h": 3_600_000 });
    expect(RENEWAL.ageMarginMs).toEqual({ "documented-ceiling": 30_000, "paired-empirical": 10_000 });
    expect(RENEWAL.delayAfterMissMs).toBe(10_000);
    expect(RENEWAL.idleMarginMs).toBe(10_000);
  });
});
