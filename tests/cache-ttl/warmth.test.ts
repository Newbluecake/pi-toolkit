import { describe, expect, it } from "vitest";
import {
  assessWarmth,
  MAX_TTL_MS,
  NOMINAL_5M_MS,
  WARMTH_SUPPORTED_APIS,
  type WarmthEvidence,
} from "../../src/cache-ttl/warmth.js";

const NOW = 10_000_000;

function evidence(overrides: Partial<WarmthEvidence> = {}): WarmthEvidence {
  return {
    now: NOW,
    route: { api: "anthropic-messages", provider: "anthropic", modelId: "claude-x" },
    ledger: { at: NOW - 1_000, provider: "anthropic", modelId: "claude-x", cacheRead: 100, cacheWrite: 0 },
    keepalive: { pingInFlight: false, pingScheduled: false },
    recent1hWrite: false,
    mode: "auto",
    slackMs: 1_000,
    ...overrides,
  };
}

describe("WARMTH_SUPPORTED_APIS", () => {
  it("is frozen (AGENTS.md: no mutable exported collections)", () => {
    expect(Object.isFrozen(WARMTH_SUPPORTED_APIS)).toBe(true);
    expect(WARMTH_SUPPORTED_APIS).toEqual(["anthropic-messages"]);
  });
});

describe("assessWarmth — step 1: api/ledger/route gates", () => {
  it("unsupported api ⇒ unknown/unsupported-api, even with otherwise-perfect warm evidence", () => {
    const result = assessWarmth(
      evidence({
        route: { api: "openai-chat", provider: "openai", modelId: "gpt-x" },
      }),
    );
    expect(result).toEqual({ state: "unknown", reason: "unsupported-api" });
  });

  it("no ledger at all ⇒ unknown/no-ledger", () => {
    expect(assessWarmth(evidence({ ledger: undefined }))).toEqual({ state: "unknown", reason: "no-ledger" });
  });

  it("ledger present but missing `at` ⇒ unknown/no-ledger", () => {
    const e = evidence();
    const ledger = { ...e.ledger! };
    delete (ledger as { at?: number }).at;
    expect(assessWarmth({ ...e, ledger })).toEqual({ state: "unknown", reason: "no-ledger" });
  });

  it("ledger modelId differs from route ⇒ unknown/route-changed", () => {
    const result = assessWarmth(
      evidence({
        ledger: { at: NOW - 1_000, provider: "anthropic", modelId: "claude-OTHER", cacheRead: 1, cacheWrite: 0 },
      }),
    );
    expect(result).toEqual({ state: "unknown", reason: "route-changed" });
  });

  it("ledger provider differs from route (same modelId) ⇒ unknown/route-changed", () => {
    const result = assessWarmth(
      evidence({
        ledger: { at: NOW - 1_000, provider: "other-provider", modelId: "claude-x", cacheRead: 1, cacheWrite: 0 },
      }),
    );
    expect(result).toEqual({ state: "unknown", reason: "route-changed" });
  });

  it("ledger with no provider field at all is never treated as route-changed on provider alone", () => {
    const result = assessWarmth(
      evidence({ ledger: { at: NOW - 1_000, modelId: "claude-x", cacheRead: 1, cacheWrite: 0 } }),
    );
    expect(result.state).not.toBe("unknown");
    expect((result as { reason?: string }).reason).not.toBe("route-changed");
  });
});

describe("assessWarmth — step 2: warm only from evidence", () => {
  it("a proven ledger touch (cacheRead+cacheWrite>0) within the nominal window ⇒ warm/proven-recent", () => {
    const result = assessWarmth(
      evidence({
        ledger: { at: NOW - 1_000, provider: "anthropic", modelId: "claude-x", cacheRead: 50, cacheWrite: 0 },
      }),
    );
    expect(result).toEqual({ state: "warm", reason: "proven-recent" });
  });

  it("a ledger entry with zero cacheRead/cacheWrite does NOT count as a proven touch on its own", () => {
    const result = assessWarmth(
      evidence({
        ledger: { at: NOW - 1_000, provider: "anthropic", modelId: "claude-x", cacheRead: 0, cacheWrite: 0 },
        keepalive: { pingInFlight: false, pingScheduled: false }, // no provenReadAt either
      }),
    );
    // Falls through to step 5 (no proven touch), not warm.
    expect(result.state).not.toBe("warm");
  });

  it("keepalive.provenReadAt within the nominal window ⇒ warm/proven-recent even with an otherwise-cold ledger", () => {
    const result = assessWarmth(
      evidence({
        ledger: { at: NOW - 10 * MAX_TTL_MS, provider: "anthropic", modelId: "claude-x", cacheRead: 0, cacheWrite: 0 },
        keepalive: { provenReadAt: NOW - 1_000, pingInFlight: false, pingScheduled: false },
      }),
    );
    expect(result).toEqual({ state: "warm", reason: "proven-recent" });
  });

  it("proven-recent boundary: now - provenTouch === NOMINAL_5M_MS is NOT warm (strict <)", () => {
    const result = assessWarmth(
      evidence({
        ledger: { at: NOW - NOMINAL_5M_MS, provider: "anthropic", modelId: "claude-x", cacheRead: 1, cacheWrite: 0 },
      }),
    );
    expect(result.state).not.toBe("warm");
  });

  it("proven-recent boundary: one ms inside the window IS warm", () => {
    const result = assessWarmth(
      evidence({
        ledger: {
          at: NOW - NOMINAL_5M_MS + 1,
          provider: "anthropic",
          modelId: "claude-x",
          cacheRead: 1,
          cacheWrite: 0,
        },
      }),
    );
    expect(result).toEqual({ state: "warm", reason: "proven-recent" });
  });

  it("ttlOverrideMs widens the proven-recent window", () => {
    const result = assessWarmth(
      evidence({
        ledger: {
          at: NOW - (NOMINAL_5M_MS + 10_000),
          provider: "anthropic",
          modelId: "claude-x",
          cacheRead: 1,
          cacheWrite: 0,
        },
        ttlOverrideMs: NOMINAL_5M_MS + 20_000,
      }),
    );
    expect(result).toEqual({ state: "warm", reason: "proven-recent" });
  });
});

describe("assessWarmth — step 3: keepalive in flight", () => {
  it("pingInFlight ⇒ unknown/keepalive-active (not warm, not cold)", () => {
    const result = assessWarmth(
      evidence({
        ledger: { at: NOW - 10 * MAX_TTL_MS, provider: "anthropic", modelId: "claude-x", cacheRead: 0, cacheWrite: 0 },
        keepalive: { pingInFlight: true, pingScheduled: false },
      }),
    );
    expect(result).toEqual({ state: "unknown", reason: "keepalive-active" });
  });

  it("pingScheduled ⇒ unknown/keepalive-active", () => {
    const result = assessWarmth(
      evidence({
        ledger: { at: NOW - 10 * MAX_TTL_MS, provider: "anthropic", modelId: "claude-x", cacheRead: 0, cacheWrite: 0 },
        keepalive: { pingInFlight: false, pingScheduled: true },
      }),
    );
    expect(result).toEqual({ state: "unknown", reason: "keepalive-active" });
  });
});

describe("assessWarmth — step 4: uncached by construction", () => {
  it("zero cache bytes + lastSent on the same route with cached:false ⇒ cold/uncached, nextWriteTtl none", () => {
    const result = assessWarmth(
      evidence({
        ledger: { at: NOW - 10 * MAX_TTL_MS, provider: "anthropic", modelId: "claude-x", cacheRead: 0, cacheWrite: 0 },
        lastSent: { at: NOW - 1_000, provider: "anthropic", modelId: "claude-x", ttl1h: false, cached: false },
      }),
    );
    expect(result).toEqual({ state: "cold", reason: "uncached", nextWriteTtl: "none" });
  });

  it("does not fire when lastSent is for a different route", () => {
    const result = assessWarmth(
      evidence({
        ledger: { at: NOW - 10 * MAX_TTL_MS, provider: "anthropic", modelId: "claude-x", cacheRead: 0, cacheWrite: 0 },
        lastSent: { at: NOW - 1_000, provider: "anthropic", modelId: "claude-OTHER", ttl1h: false, cached: false },
      }),
    );
    expect(result).not.toEqual({ state: "cold", reason: "uncached", nextWriteTtl: "none" });
  });

  it("does not fire when lastSent.cached is true", () => {
    const result = assessWarmth(
      evidence({
        ledger: { at: NOW - 10 * MAX_TTL_MS, provider: "anthropic", modelId: "claude-x", cacheRead: 0, cacheWrite: 0 },
        lastSent: { at: NOW - 1_000, provider: "anthropic", modelId: "claude-x", ttl1h: false, cached: true },
      }),
    );
    expect(result).not.toEqual({ state: "cold", reason: "uncached", nextWriteTtl: "none" });
  });
});

describe("assessWarmth — step 5/6: prove cold by elapsed time; mode/lastSent/1h traces never produce warm", () => {
  it("far-elapsed touch with no 1h evidence anywhere ⇒ cold/ttl-elapsed, nextWriteTtl 5m", () => {
    const result = assessWarmth(
      evidence({
        ledger: {
          at: NOW - (NOMINAL_5M_MS + 10_000),
          provider: "anthropic",
          modelId: "claude-x",
          cacheRead: 1,
          cacheWrite: 0,
        },
      }),
    );
    expect(result).toEqual({ state: "cold", reason: "ttl-elapsed", nextWriteTtl: "5m" });
  });

  it("boundary: now - touch === maxLife + slackMs ⇒ cold (>= is inclusive)", () => {
    const touchAge = NOMINAL_5M_MS + 1_000; // slackMs is 1000 in the fixture
    const result = assessWarmth(
      evidence({
        ledger: { at: NOW - touchAge, provider: "anthropic", modelId: "claude-x", cacheRead: 1, cacheWrite: 0 },
      }),
    );
    expect(result).toEqual({ state: "cold", reason: "ttl-elapsed", nextWriteTtl: "5m" });
  });

  it("boundary: one ms short of maxLife + slackMs ⇒ unknown/not-provably-cold", () => {
    const touchAge = NOMINAL_5M_MS + 1_000 - 1;
    const result = assessWarmth(
      evidence({
        ledger: { at: NOW - touchAge, provider: "anthropic", modelId: "claude-x", cacheRead: 1, cacheWrite: 0 },
      }),
    );
    expect(result).toEqual({ state: "unknown", reason: "not-provably-cold" });
  });

  it("mode:'on' with a touch inside the 1h window but outside 5m ⇒ still NOT warm (unknown/not-provably-cold)", () => {
    // This is the r2 ruling under direct test: mode never flips the verdict to warm, it only
    // raises the bar the elapsed-time proof has to clear.
    const result = assessWarmth(
      evidence({
        mode: "on",
        ledger: {
          at: NOW - (NOMINAL_5M_MS + 10_000),
          provider: "anthropic",
          modelId: "claude-x",
          cacheRead: 0,
          cacheWrite: 0,
        },
      }),
    );
    expect(result).toEqual({ state: "unknown", reason: "not-provably-cold" });
  });

  it("lastSent.ttl1h with a touch inside the 1h window but outside 5m ⇒ still NOT warm", () => {
    const result = assessWarmth(
      evidence({
        ledger: {
          at: NOW - (NOMINAL_5M_MS + 10_000),
          provider: "anthropic",
          modelId: "claude-x",
          cacheRead: 0,
          cacheWrite: 0,
        },
        lastSent: {
          at: NOW - (NOMINAL_5M_MS + 10_000),
          provider: "anthropic",
          modelId: "claude-x",
          ttl1h: true,
          cached: true,
        },
      }),
    );
    expect(result.state).not.toBe("warm");
  });

  it("ledger.cacheWrite1h>0 with a touch inside the 1h window but outside 5m ⇒ still NOT warm", () => {
    const result = assessWarmth(
      evidence({
        ledger: {
          at: NOW - (NOMINAL_5M_MS + 10_000),
          provider: "anthropic",
          modelId: "claude-x",
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite1h: 5,
        },
      }),
    );
    expect(result.state).not.toBe("warm");
  });

  it("mode:'on' raises the proof bar to the 1h ceiling: cold only once 1h+slack has elapsed", () => {
    const justUnder = assessWarmth(
      evidence({
        mode: "on",
        ledger: {
          at: NOW - (MAX_TTL_MS + 999),
          provider: "anthropic",
          modelId: "claude-x",
          cacheRead: 0,
          cacheWrite: 0,
        },
      }),
    );
    expect(justUnder).toEqual({ state: "unknown", reason: "not-provably-cold" });

    const atOrPast = assessWarmth(
      evidence({
        mode: "on",
        ledger: {
          at: NOW - (MAX_TTL_MS + 1_000),
          provider: "anthropic",
          modelId: "claude-x",
          cacheRead: 0,
          cacheWrite: 0,
        },
      }),
    );
    expect(atOrPast).toEqual({ state: "cold", reason: "ttl-elapsed", nextWriteTtl: "1h" });
  });

  it("recent1hWrite:'unknown' also raises the bar to 1h (never treated as `false`)", () => {
    const result = assessWarmth(
      evidence({
        recent1hWrite: "unknown",
        ledger: {
          at: NOW - (NOMINAL_5M_MS + 10_000),
          provider: "anthropic",
          modelId: "claude-x",
          cacheRead: 0,
          cacheWrite: 0,
        },
      }),
    );
    expect(result).toEqual({ state: "unknown", reason: "not-provably-cold" });
  });

  it("recent1hWrite:false (no other 1h evidence) keeps the 5m bar", () => {
    const result = assessWarmth(
      evidence({
        recent1hWrite: false,
        ledger: {
          at: NOW - (NOMINAL_5M_MS + 1_000),
          provider: "anthropic",
          modelId: "claude-x",
          cacheRead: 0,
          cacheWrite: 0,
        },
      }),
    );
    expect(result).toEqual({ state: "cold", reason: "ttl-elapsed", nextWriteTtl: "5m" });
  });

  it("lastSent.at feeds the latest-possible-touch max (a recent lastSent keeps a stale ledger from proving cold)", () => {
    const result = assessWarmth(
      evidence({
        ledger: { at: NOW - 10 * MAX_TTL_MS, provider: "anthropic", modelId: "claude-x", cacheRead: 0, cacheWrite: 0 },
        lastSent: { at: NOW - 1_000, provider: "anthropic", modelId: "claude-x", ttl1h: false, cached: true },
      }),
    );
    expect(result).toEqual({ state: "unknown", reason: "not-provably-cold" });
  });

  it("keepalive.lastReadStartedAt/pingStartedAt feed the latest-possible-touch max", () => {
    const result = assessWarmth(
      evidence({
        ledger: { at: NOW - 10 * MAX_TTL_MS, provider: "anthropic", modelId: "claude-x", cacheRead: 0, cacheWrite: 0 },
        keepalive: { lastReadStartedAt: NOW - 1_000, pingInFlight: false, pingScheduled: false },
      }),
    );
    expect(result).toEqual({ state: "unknown", reason: "not-provably-cold" });
  });
});

describe("assessWarmth — nextWriteTtl (cold/ttl-elapsed only)", () => {
  const staleLedger = {
    at: NOW - (MAX_TTL_MS + 10_000),
    provider: "anthropic",
    modelId: "claude-x",
    cacheRead: 0,
    cacheWrite: 0,
  };

  it("mode:'on' ⇒ 1h", () => {
    const result = assessWarmth(evidence({ mode: "on", ledger: staleLedger }));
    expect(result).toEqual({ state: "cold", reason: "ttl-elapsed", nextWriteTtl: "1h" });
  });

  it("lastSent.ttl1h ⇒ 1h (even in auto mode)", () => {
    const result = assessWarmth(
      evidence({
        ledger: staleLedger,
        lastSent: {
          at: NOW - (MAX_TTL_MS + 10_000),
          provider: "anthropic",
          modelId: "claude-x",
          ttl1h: true,
          cached: true,
        },
      }),
    );
    expect(result).toEqual({ state: "cold", reason: "ttl-elapsed", nextWriteTtl: "1h" });
  });

  it("lastSent.cached:false (not ttl1h, not mode:on) ⇒ none", () => {
    // cacheRead:1 (not 0) keeps step 4's "uncached by construction" rule from firing first — this
    // isolates nextWriteTtl's own "none" branch, reached only via step 5's elapsed-time path.
    const staleAt = NOW - (MAX_TTL_MS + 10_000);
    const result = assessWarmth(
      evidence({
        ledger: { at: staleAt, provider: "anthropic", modelId: "claude-x", cacheRead: 1, cacheWrite: 0 },
        lastSent: { at: staleAt, provider: "anthropic", modelId: "claude-x", ttl1h: false, cached: false },
      }),
    );
    expect(result).toEqual({ state: "cold", reason: "ttl-elapsed", nextWriteTtl: "none" });
  });

  it("neither ⇒ 5m default", () => {
    const result = assessWarmth(
      evidence({
        ledger: {
          at: NOW - (NOMINAL_5M_MS + 10_000),
          provider: "anthropic",
          modelId: "claude-x",
          cacheRead: 0,
          cacheWrite: 0,
        },
      }),
    );
    expect(result).toEqual({ state: "cold", reason: "ttl-elapsed", nextWriteTtl: "5m" });
  });
});

describe("assessWarmth — never throws", () => {
  it("degrades to unknown/read-error when evidence access throws", () => {
    const poisoned = new Proxy(evidence(), {
      get(target, prop, receiver) {
        if (prop === "route") throw new Error("boom");
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(assessWarmth(poisoned as WarmthEvidence)).toEqual({ state: "unknown", reason: "read-error" });
  });
});
