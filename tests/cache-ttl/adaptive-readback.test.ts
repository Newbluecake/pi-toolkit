import { describe, expect, it, vi } from "vitest";
import {
  ADAPTIVE_AUDIT_CUSTOM_TYPE,
  createInitialAdaptiveState,
  readBackAdaptiveSessionState,
} from "../../src/cache-ttl/adaptive.js";
import { createCacheAdaptiveService, type AdaptiveExternalSignals } from "../../src/service/cache-adaptive.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import type { AdaptiveState } from "../../src/cache-ttl/adaptive.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * field-2026-09-24 §3.1: budgets and the breaker are session-permanent, but the
 * service is rebuilt on every session_start (`/reload` included). These tests
 * pin the read-back that rehydrates them from the branch's own audit entries.
 */

const entry = (data: unknown) => ({ type: "custom", customType: ADAPTIVE_AUDIT_CUSTOM_TYPE, data });

const decisionEntry = (budget: Record<string, unknown>) => entry({ kind: "decision", at: 1, budget });

const reconcileEntry = (fields: Record<string, unknown>) => entry({ kind: "reconcile", at: 5_000, ...fields });

describe("readBackAdaptiveSessionState", () => {
  it("review R5/R9: restores drift telemetry and route-bound 1h survival evidence", () => {
    const state = readBackAdaptiveSessionState([
      reconcileEntry({ driftCoverClears: 1, max1hSurvivalMs: 3_120_000, survivalRouteKey: "anthropic|opus" }),
      reconcileEntry({ driftCoverClears: 2, max1hSurvivalMs: 600_000, survivalRouteKey: "anthropic|opus" }),
      reconcileEntry({ upgradeWriteTokens: 5 }), // pre-R5 entry without the fields
    ]);
    expect(state?.driftCoverClears).toBe(2);
    expect(state?.max1hSurvivalMs).toBe(3_120_000); // same route: evidence never shrinks
    expect(state?.survivalRouteKey).toBe("anthropic|opus");

    // a later entry on ANOTHER route replaces the evidence (never transfers)
    const switched = readBackAdaptiveSessionState([
      reconcileEntry({ max1hSurvivalMs: 3_120_000, survivalRouteKey: "anthropic|opus" }),
      reconcileEntry({ max1hSurvivalMs: 600_000, survivalRouteKey: "copilot|opus" }),
    ]);
    expect(switched?.max1hSurvivalMs).toBe(600_000);
    expect(switched?.survivalRouteKey).toBe("copilot|opus");

    // unbound (pre-R9) evidence restores nothing
    const unbound = readBackAdaptiveSessionState([reconcileEntry({ max1hSurvivalMs: 3_120_000 })]);
    expect(unbound?.max1hSurvivalMs).toBe(0);
    // prefix-bound lineage/cover transients are still never restored
    expect(state?.coverLineageKey).toBeUndefined();
    expect(state?.oneHourCoverUntil).toBeUndefined();
  });

  it("restores a tripped breaker with its first trip time", () => {
    const state = readBackAdaptiveSessionState([
      reconcileEntry({ upgradeWriteTokens: 10, feeWriteTokens: 0, feeWriteUsd: 0 }),
      entry({ kind: "reconcile", at: 7_000, breaker: "warm-miss" }),
      entry({ kind: "reconcile", at: 9_000, breaker: "warm-miss" }),
    ]);
    expect(state?.breaker).toEqual({ reason: "warm-miss", at: 7_000 });
  });

  it("never un-trips: a later reconcile without a breaker keeps it", () => {
    const state = readBackAdaptiveSessionState([
      entry({ kind: "reconcile", at: 7_000, breaker: "1h-ineffective" }),
      reconcileEntry({ upgradeWriteTokens: 20 }),
    ]);
    expect(state?.breaker?.reason).toBe("1h-ineffective");
  });

  it("restores budget counters, the last entry winning", () => {
    const state = readBackAdaptiveSessionState([
      decisionEntry({
        upgradeWriteTokens: 1_000,
        upgradeWriteUsd: 0.1,
        feeWriteTokens: 2_000,
        feeWriteUsd: 0.2,
        coldUpgrades: 1,
      }),
      reconcileEntry({ upgradeWriteTokens: 150_000, upgradeWriteUsd: 0.9, feeWriteTokens: 500_000, feeWriteUsd: 2.5 }),
    ]);
    expect(state).toMatchObject({
      upgradeWriteTokens: 150_000,
      upgradeWriteUsd: 0.9,
      feeWriteTokens: 500_000,
      feeWriteUsd: 2.5,
      coldUpgradesUsed: 1,
      breaker: undefined,
    });
  });

  it("no usable entries ⇒ undefined (caller starts fully initial)", () => {
    expect(readBackAdaptiveSessionState([])).toBeUndefined();
    expect(
      readBackAdaptiveSessionState([
        { type: "custom", customType: "other", data: { kind: "reconcile", breaker: "warm-miss", at: 1 } },
        { type: "message", message: { role: "user" } },
      ]),
    ).toBeUndefined();
  });

  it("corrupt entries never throw and fall back field-by-field", () => {
    const hostile = {
      type: "custom",
      customType: ADAPTIVE_AUDIT_CUSTOM_TYPE,
      get data(): unknown {
        throw new Error("boom");
      },
    };
    expect(readBackAdaptiveSessionState([hostile])).toBeUndefined();
    const state = readBackAdaptiveSessionState([
      null,
      42,
      entry(null),
      entry({ kind: "decision", budget: "nope" }),
      decisionEntry({ upgradeWriteTokens: "lots", feeWriteTokens: Number.NaN, feeWriteUsd: 0.4 }),
      entry({ kind: "reconcile", breaker: "warm-miss" }), // no `at` ⇒ no breaker
    ]);
    expect(state).toMatchObject({ upgradeWriteTokens: 0, feeWriteTokens: 0, feeWriteUsd: 0.4, breaker: undefined });
  });

  it("does not restore prefix-bound transients", () => {
    const state = readBackAdaptiveSessionState([
      entry({
        kind: "reconcile",
        at: 5_000,
        upgradeWriteTokens: 10,
        lastPrefixTokens: 300_000,
        tokensSinceLast1hWrite: 40_000,
        oneHourCoverUntil: 99_999,
        lastRequestStartedAt: 4_000,
        gaps: [400_000],
      }),
    ]);
    const initial = createInitialAdaptiveState();
    expect(state).toMatchObject({
      lastPrefixTokens: initial.lastPrefixTokens,
      tokensSinceLast1hWrite: initial.tokensSinceLast1hWrite,
      oneHourCoverUntil: initial.oneHourCoverUntil,
      lastRequestStartedAt: initial.lastRequestStartedAt,
      gaps: [],
      pending: undefined,
    });
  });
});

describe("service rebuilt with restoredState", () => {
  const SHAPE = { ephemeralBreakpoints: 1, ttl1h: false, hasThinking: false, maxTokens: 512 } as const;
  const LEDGER = {
    source: "usage",
    cacheRead: 300_000,
    cacheWrite: 4_000,
    cacheWrite1h: undefined,
    costTotalUsd: undefined,
    cacheWriteUsd: undefined,
    entrySeq: 0,
    entriesLength: 1,
    modelId: "claude-x",
  } as const;
  const BUSY: AdaptiveExternalSignals = { subagentRuns: 1, maxSubagentHorizonMs: 1_800_000, backgroundBashJobs: 0 };

  function service(restoredState: AdaptiveState | undefined, appendEntry = vi.fn()) {
    const ctx = {
      sessionManager: { getEntries: () => [], getSessionId: () => "s1", getBranch: () => [] },
      model: { provider: "anthropic", api: "anthropic-messages", id: "claude-x" },
    } as unknown as ExtensionContext;
    return createCacheAdaptiveService({
      ctx,
      sessionId: "s1",
      settings: { ...DEFAULT_SETTINGS.cacheTtl, mode: "adaptive", adaptiveEnabled: true },
      signals: () => BUSY,
      isCurrent: () => true,
      appendEntry,
      restoredState,
    });
  }

  const decide = (svc: ReturnType<typeof service>) =>
    svc.decide("s1", svc.instanceId, { shape: SHAPE, ledger: { ...LEDGER } });

  it("control: no restored state ⇒ the busy-fleet request upgrades", () => {
    const svc = service(undefined);
    expect(decide(svc).upgrade).toBe(true);
  });

  it("a restored breaker keeps refusing after the rebuild", () => {
    const svc = service(readBackAdaptiveSessionState([entry({ kind: "reconcile", at: 1, breaker: "warm-miss" })]));
    const decision = decide(svc);
    expect(decision).toMatchObject({ upgrade: false, reason: "breaker" });
    expect(svc.snapshot().breaker).toBeDefined();
  });

  it("a restored exhausted fee budget keeps refusing new entry fees", () => {
    const svc = service(
      readBackAdaptiveSessionState([reconcileEntry({ feeWriteTokens: 10_000_000, feeWriteUsd: 50 })]),
    );
    expect(decide(svc)).toMatchObject({ upgrade: false, reason: "fee-budget" });
  });

  it("contract: entries the service writes are the ones read-back understands", () => {
    const appendEntry = vi.fn();
    const svc = service(undefined, appendEntry);
    decide(svc);
    const written = appendEntry.mock.calls
      .filter(([type]) => type === ADAPTIVE_AUDIT_CUSTOM_TYPE)
      .map(([type, data]) => ({ type: "custom", customType: type, data }));
    expect(written.length).toBeGreaterThan(0);
    const state = readBackAdaptiveSessionState(written);
    const budget = (written.at(-1)?.data as { budget?: Record<string, unknown> }).budget;
    // Every key the read-back consumes must exist in what the writer emits /
    // a rename on either side would silently turn the restore into a no-op.
    for (const key of ["upgradeWriteTokens", "upgradeWriteUsd", "feeWriteTokens", "feeWriteUsd", "coldUpgrades"]) {
      expect(typeof budget?.[key], key).toBe("number");
    }
    expect(state).toMatchObject({
      upgradeWriteTokens: budget?.upgradeWriteTokens,
      upgradeWriteUsd: budget?.upgradeWriteUsd,
      feeWriteTokens: budget?.feeWriteTokens,
      feeWriteUsd: budget?.feeWriteUsd,
      coldUpgradesUsed: budget?.coldUpgrades,
    });
  });
});
