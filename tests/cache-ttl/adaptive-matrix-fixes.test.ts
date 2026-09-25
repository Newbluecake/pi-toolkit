/**
 * Regression tests for the fixes that came out of the 2026-09-26 strategy-matrix
 * verification (docs/dev/cache-ttl-adaptive/verification-2026-09-26.md). Every
 * fix is pinned together with a control that fails if the fix is removed.
 *
 *   F-D F1's "keepalive covers every gap seen" is judged on ARMED gaps only
 *       (gaps the pinger proved reads through) — an unpinged human idle no longer
 *       disables F1 for the rest of the session.
 *   F-C a gap keepalive bridged (proven read ≤ one 5m TTL before the request) is
 *       neither a 1h verdict nor 1h survival evidence.
 *   F-A a covered renewal whose read collapsed teaches an upper bound on the
 *       route's 1h lifetime; covers are capped at ADAPTIVE_COVER_SAFETY × it.
 *       Review round 1 tightened the evidence: confirmed 1h writes only, known and
 *       equal lineage + route, a bound beyond one 5m TTL, range-checked read-back.
 */
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ADAPTIVE_AUDIT_CUSTOM_TYPE,
  ADAPTIVE_COVER_MS,
  ADAPTIVE_COVER_SAFETY,
  adaptiveCoverLengthMs,
  buildAdaptiveSnapshot,
  createInitialAdaptiveState,
  decideAdaptiveTtl,
  invalidateAdaptive,
  noteDecision,
  onLedgerObserved,
  readBackAdaptiveSessionState,
  type AdaptiveConfig,
  type AdaptiveDecideInput,
  type AdaptiveDecision,
  type AdaptivePending,
  type AdaptiveSignals,
  type AdaptiveState,
} from "../../src/cache-ttl/adaptive.js";
import { keepaliveGapHorizonMs, renderAdaptiveReportLines } from "../../src/cache-ttl/keepalive-state.js";
import type { LedgerUsage } from "../../src/cache-ttl/usage-ledger.js";
import { createCacheAdaptiveService } from "../../src/service/cache-adaptive.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import type { Millis } from "../../src/core/types.js";

const NOW = 1_790_000_000_000;
const MIN = 60_000;
const HORIZON = keepaliveGapHorizonMs({ intervalMs: 240_000, maxPings: 11 });
const ROUTE = "anthropic|m";

const CONFIG: AdaptiveConfig = {
  writeBudgetTokens: 200_000,
  writeBudgetUsd: 1,
  feeBudgetTokens: 600_000,
  feeBudgetUsd: 3,
  maxDeltaTokens: 32_000,
  refreshAfterTokens: 16_000,
  coldUpgrades: 1,
  coldCooldownMs: 1_200_000,
  coldMinHorizonMs: 600_000,
  historyGapSignal: true,
  probeWriteFactor: 3,
  probeWriteFloorTokens: 64_000,
  probeWriteFloorFraction: 0.5,
  probeWriteFloorMinTokens: 4_000,
};

function signals(o: Partial<AdaptiveSignals> = {}): AdaptiveSignals {
  return {
    subagentRuns: 0,
    maxSubagentHorizonMs: undefined,
    backgroundBashJobs: 0,
    uiPrompts: 0,
    activeTools: 0,
    ...o,
  };
}

function ledger(o: Partial<LedgerUsage> = {}): LedgerUsage {
  return {
    source: "usage",
    cacheRead: 100_000,
    cacheWrite: 3_000,
    cacheWrite1h: undefined,
    costTotalUsd: undefined,
    cacheWriteUsd: undefined,
    entrySeq: 10,
    entriesLength: 11,
    modelId: "m",
    providerId: "anthropic",
    ...o,
  };
}

function state(o: Partial<AdaptiveState> = {}): AdaptiveState {
  return { ...createInitialAdaptiveState(), ...o };
}

function decide(o: Partial<AdaptiveDecideInput> = {}) {
  return decideAdaptiveTtl({
    now: NOW,
    mode: "adaptive",
    api: "anthropic-messages",
    provider: "cloudrouter-anthropic",
    modelId: "m",
    supportsLongCacheRetention: true,
    shape: { ephemeralBreakpoints: 2, ttl1h: false, hasThinking: false, maxTokens: 32_000 },
    signals: signals({ backgroundBashJobs: 1 }),
    ledger: ledger(),
    config: CONFIG,
    state: state({ lastRequestStartedAt: NOW - 20_000 }),
    lastProvenCacheReadAt: undefined,
    keepaliveHorizonMs: HORIZON,
    ...o,
  });
}

const DECLINED: AdaptiveDecision = {
  upgrade: false,
  class: undefined,
  reason: "no-signal",
  signals: [],
  predictedDeltaTokens: 0,
  at: NOW,
};
const UPGRADE: AdaptiveDecision = {
  upgrade: true,
  class: "warm",
  reason: undefined,
  signals: ["bash-job"],
  predictedDeltaTokens: 5_000,
  at: NOW,
};

function pending(o: Partial<AdaptivePending> = {}): AdaptivePending {
  return {
    requestSeq: 1,
    minEntrySeq: 11,
    at: NOW,
    class: "warm",
    predictedDeltaTokens: 5_000,
    covered1h: true,
    lineageKey: "A",
    routeKey: ROUTE,
    ...o,
  };
}

// ─── F-D ─────────────────────────────────────────────────────────────────────

describe("F-D — F1 judges only armed gaps", () => {
  it("noteDecision puts an armed gap in both rings, an unarmed one only in `gaps`", () => {
    const armed = noteDecision(state(), DECLINED, {
      now: NOW,
      gapMs: 55 * MIN,
      entriesLength: 1,
      strongSignals: 0,
      gapArmed: true,
    });
    expect(armed.gaps).toEqual([55 * MIN]);
    expect(armed.armedGaps).toEqual([55 * MIN]);
    const idle = noteDecision(state(), DECLINED, { now: NOW, gapMs: 55 * MIN, entriesLength: 1, strongSignals: 0 });
    expect(idle.gaps).toEqual([55 * MIN]);
    expect(idle.armedGaps).toEqual([]);
  });

  it("an unpinged 55-min idle no longer earns the entry fee (was: F1 off for the whole session)", () => {
    const d = decide({ state: state({ lastRequestStartedAt: NOW - 20_000, gaps: [55 * MIN], armedGaps: [] }) });
    expect(d).toMatchObject({ upgrade: false, reason: "keepalive-covers" });
  });

  it("control: the same gap, armed, earns it", () => {
    const d = decide({ state: state({ lastRequestStartedAt: NOW - 20_000, gaps: [55 * MIN], armedGaps: [55 * MIN] }) });
    expect(d).toMatchObject({ upgrade: true });
  });

  it("the unarmed gap still feeds the weak history-gap signal (only F1 changed)", () => {
    const d = decide({
      signals: signals(),
      keepaliveHorizonMs: undefined,
      state: state({ lastRequestStartedAt: NOW - 20_000, gaps: [55 * MIN], armedGaps: [] }),
    });
    expect(d.signals).toContain("history-gap");
  });
});

// ─── F-C ─────────────────────────────────────────────────────────────────────

describe("F-C — a ping-bridged gap is no 1h verdict", () => {
  it("noteDecision: bridged = armed AND the last proven touch within one 5m TTL", () => {
    const input = { now: NOW, gapMs: 25 * MIN, entriesLength: 1, strongSignals: 0 };
    expect(noteDecision(state(), DECLINED, { ...input, gapArmed: true, sinceTouchMs: 60_000 }).lastGapPingBridged).toBe(
      true,
    );
    // pings stopped (budget) 14 min before the request: the 5m chain lapsed ⇒ a real gap
    expect(
      noteDecision(state(), DECLINED, { ...input, gapArmed: true, sinceTouchMs: 14 * MIN }).lastGapPingBridged,
    ).toBe(false);
    expect(noteDecision(state(), DECLINED, { ...input, sinceTouchMs: 60_000 }).lastGapPingBridged).toBe(false);
  });

  const covered = {
    lastPrefixTokens: 120_000,
    lastReconciledEntrySeq: 9,
    oneHourCoverUntil: NOW + 30 * MIN,
    confirmed1hWrites: 1,
    lastGapMs: 25 * MIN,
  } satisfies Partial<AdaptiveState>;

  it("a hit after a bridged 25-min gap is not survival evidence", () => {
    const next = onLedgerObserved(
      state({ ...covered, lastGapPingBridged: true }),
      ledger({ cacheRead: 118_000 }),
      NOW,
      CONFIG,
    );
    expect(next.indirect1hConfirms).toBe(0);
    expect(next.max1hSurvivalMs).toBe(0);
  });

  it("control: the same hit after an unbridged gap is (the 5m chain was dead — only 1h explains it)", () => {
    const next = onLedgerObserved(
      state({ ...covered, lastGapPingBridged: false }),
      ledger({ cacheRead: 118_000 }),
      NOW,
      CONFIG,
    );
    expect(next.indirect1hConfirms).toBe(1);
    expect(next.max1hSurvivalMs).toBe(25 * MIN);
  });

  it("a collapse after a bridged gap is drift (cover cleared), not 1h-ineffective", () => {
    const next = onLedgerObserved(
      state({ ...covered, lastGapPingBridged: true }),
      ledger({ cacheRead: 11_000, cacheWrite: 112_000 }),
      NOW,
      CONFIG,
    );
    expect(next.breaker).toBeUndefined();
    expect(next.oneHourCoverUntil).toBeUndefined();
    expect(next.driftCoverClears).toBe(1);
  });

  it("control: the same collapse after an unbridged gap trips 1h-ineffective", () => {
    const next = onLedgerObserved(
      state({ ...covered, lastGapPingBridged: false }),
      ledger({ cacheRead: 11_000, cacheWrite: 112_000 }),
      NOW,
      CONFIG,
    );
    expect(next.breaker?.reason).toBe("1h-ineffective");
  });
});

// ─── F-A ─────────────────────────────────────────────────────────────────────

describe("F-A — a collapsed covered renewal teaches the 1h lifetime", () => {
  /** A covered renewal decided at NOW whose previous 1h write happened 27 min earlier. */
  const renewal = (o: Partial<AdaptiveState> = {}) =>
    state({
      lastPrefixTokens: 130_000,
      lastReconciledEntrySeq: 10,
      lastDecisionEntriesLength: 11,
      lastGapMs: 60_000,
      pending: pending(),
      oneHourCoverUntil: NOW + ADAPTIVE_COVER_MS, // re-armed optimistically by this upgrade
      confirmed1hWrites: 1,
      last1hWriteAt: NOW - 27 * MIN,
      last1hWriteLineageKey: "A",
      last1hWriteRouteKey: ROUTE,
      ...o,
    });
  const collapsed = ledger({
    entrySeq: 11,
    entriesLength: 12,
    cacheRead: 11_356,
    cacheWrite: 125_644,
    cacheWrite1h: 125_644,
  });

  it("learns `settle − last 1h write`, counts the collapse, caps the cover it just armed", () => {
    const next = onLedgerObserved(renewal(), collapsed, NOW + 5_000, CONFIG);
    expect(next.coverCollapses).toBe(1);
    expect(next.learned1hLifeMs).toBe(27 * MIN);
    expect(next.learnedLifeRouteKey).toBe(ROUTE);
    expect(next.oneHourCoverUntil).toBe(NOW + ADAPTIVE_COVER_SAFETY * 27 * MIN);
    expect(next.last1hWriteAt).toBe(NOW); // this renewal is the new 1h write point
  });

  it("control: a renewal that READ its prefix learns nothing and keeps the 1h cover", () => {
    const next = onLedgerObserved(
      renewal(),
      ledger({ entrySeq: 11, cacheRead: 128_000, cacheWrite: 8_000, cacheWrite1h: 8_000 }),
      NOW + 5_000,
      CONFIG,
    );
    expect(next.coverCollapses).toBe(0);
    expect(next.learned1hLifeMs).toBeUndefined();
    expect(next.oneHourCoverUntil).toBe(NOW + ADAPTIVE_COVER_MS);
  });

  it("control: an UNCOVERED upgrade (entry fee) collapsing is expected, not a lesson", () => {
    const next = onLedgerObserved(renewal({ pending: pending({ covered1h: false }) }), collapsed, NOW + 5_000, CONFIG);
    expect(next.learned1hLifeMs).toBeUndefined();
  });

  it("a shrunk prefix or an unknown route is not a lifetime lesson", () => {
    const shrunk = ledger({ entrySeq: 11, cacheRead: 11_356, cacheWrite: 80_000, cacheWrite1h: 80_000 });
    expect(onLedgerObserved(renewal(), shrunk, NOW + 5_000, CONFIG).learned1hLifeMs).toBeUndefined();
    const noRoute = { ...collapsed, providerId: undefined };
    expect(onLedgerObserved(renewal(), noRoute, NOW + 5_000, CONFIG).learned1hLifeMs).toBeUndefined();
  });

  it("same route keeps the SMALLER bound (it is an upper bound)", () => {
    const next = onLedgerObserved(
      renewal({ learned1hLifeMs: 20 * MIN, learnedLifeRouteKey: ROUTE }),
      collapsed,
      NOW + 5_000,
      CONFIG,
    );
    expect(next.learned1hLifeMs).toBe(20 * MIN);
    expect(next.coverCollapses).toBe(1);
  });

  it("only a CONFIRMED 1h write moves the write point (0 = went out as 5m, undefined = unproven)", () => {
    const readOk = { entrySeq: 11, cacheRead: 128_000, cacheWrite: 8_000 };
    const landed = onLedgerObserved(renewal(), ledger({ ...readOk, cacheWrite1h: 8_000 }), NOW + 5_000, CONFIG);
    expect(landed).toMatchObject({ last1hWriteAt: NOW, last1hWriteLineageKey: "A", last1hWriteRouteKey: ROUTE });
    for (const cacheWrite1h of [0, undefined]) {
      const next = onLedgerObserved(renewal(), ledger({ ...readOk, cacheWrite1h }), NOW + 5_000, CONFIG);
      expect(next.last1hWriteAt).toBe(NOW - 27 * MIN);
    }
  });

  describe("review round 1: a collapse not PROVEN to be the same 1h entry dying teaches nothing", () => {
    const noLesson = (s: AdaptiveState, l: LedgerUsage = collapsed) => {
      const next = onLedgerObserved(s, l, NOW + 5_000, CONFIG);
      expect(next.learned1hLifeMs).toBeUndefined();
      expect(next.coverCollapses).toBe(0);
    };
    it("#1: this renewal went out as 5m (cacheWrite1h 0) or its split is unreported", () => {
      noLesson(renewal(), { ...collapsed, cacheWrite1h: 0 });
      noLesson(renewal(), { ...collapsed, cacheWrite1h: undefined });
    });
    it("#2: lineage unknown on either side, or different from the write point's", () => {
      noLesson(renewal({ pending: pending({ lineageKey: undefined }) }));
      noLesson(renewal({ last1hWriteLineageKey: undefined }));
      noLesson(renewal({ last1hWriteLineageKey: "B" }));
    });
    it("#4: the write point was on another route", () => {
      noLesson(renewal({ last1hWriteRouteKey: "anthropic|other" }));
    });
    it("#5: a bound within one 5m TTL is drift, not a lifetime (boundary: 5m no, 5m+1ms yes)", () => {
      noLesson(renewal({ last1hWriteAt: NOW - 4 * MIN }));
      noLesson(renewal({ last1hWriteAt: NOW - 5 * MIN }));
      const next = onLedgerObserved(renewal({ last1hWriteAt: NOW - 5 * MIN - 1 }), collapsed, NOW + 5_000, CONFIG);
      expect(next.learned1hLifeMs).toBe(5 * MIN + 1);
    });
    it("round 2: the pending was decided for another route, or the ledger is not exactly its entry", () => {
      noLesson(renewal({ pending: pending({ routeKey: "anthropic|other" }) }));
      noLesson(renewal({ pending: pending({ routeKey: undefined }) }));
      noLesson(renewal(), { ...collapsed, entrySeq: 12, entriesLength: 13 }); // a LATER request's entry
    });
    it("invalidate drops the write point (the old prefix's 1h entry)", () => {
      const s = invalidateAdaptive(renewal(), "compact", 12);
      expect(s).toMatchObject({
        last1hWriteAt: undefined,
        last1hWriteLineageKey: undefined,
        last1hWriteRouteKey: undefined,
      });
    });
  });

  it("covers armed later use the learned bound on the same route only", () => {
    const learned = state({ learned1hLifeMs: 25 * MIN, learnedLifeRouteKey: ROUTE, lastRouteKey: ROUTE });
    expect(adaptiveCoverLengthMs(learned, ROUTE)).toBe(20 * MIN);
    const armed = noteDecision(learned, UPGRADE, {
      now: NOW,
      gapMs: 20_000,
      entriesLength: 12,
      strongSignals: 1,
      routeKey: ROUTE,
    });
    expect(armed.oneHourCoverUntil).toBe(NOW + 20 * MIN);
    // review round 2: an UNKNOWN request route never borrows the last settled route's bound
    const unknown = noteDecision(learned, UPGRADE, { now: NOW, gapMs: 20_000, entriesLength: 12, strongSignals: 1 });
    expect(unknown.oneHourCoverUntil).toBe(NOW + ADAPTIVE_COVER_MS);
    // another route (the model switched): the bound does not transfer
    expect(adaptiveCoverLengthMs(learned, "anthropic|other")).toBe(ADAPTIVE_COVER_MS);
    expect(adaptiveCoverLengthMs(learned, undefined)).toBe(ADAPTIVE_COVER_MS);
    // review #4: the ARMING request's route wins over the stale last-settled route
    const switched = noteDecision(learned, UPGRADE, {
      now: NOW,
      gapMs: 20_000,
      entriesLength: 12,
      strongSignals: 1,
      routeKey: "anthropic|other",
    });
    expect(switched.oneHourCoverUntil).toBe(NOW + ADAPTIVE_COVER_MS);
    expect(adaptiveCoverLengthMs(state(), ROUTE)).toBe(ADAPTIVE_COVER_MS);
  });

  it("status report shows the learned bound", () => {
    const snap = buildAdaptiveSnapshot(state({ learned1hLifeMs: 25 * MIN, coverCollapses: 2 }), CONFIG, NOW);
    expect(renderAdaptiveReportLines(snap).join("\n")).toContain("learned life ≤25m (collapses 2)");
  });

  describe("survives /reload (read-back)", () => {
    const reconcile = (data: Record<string, unknown>) => ({
      type: "custom",
      customType: ADAPTIVE_AUDIT_CUSTOM_TYPE,
      data: { kind: "reconcile", at: NOW, ...data },
    });
    it("restores the bound, the route and the collapse count", () => {
      const s = readBackAdaptiveSessionState([
        reconcile({ learned1hLifeMs: 27 * MIN, learnedLifeRouteKey: ROUTE, coverCollapses: 1 }),
      ]);
      expect(s).toMatchObject({ learned1hLifeMs: 27 * MIN, learnedLifeRouteKey: ROUTE, coverCollapses: 1 });
    });
    it("same route keeps the minimum; another route replaces; no route restores nothing", () => {
      const same = readBackAdaptiveSessionState([
        reconcile({ learned1hLifeMs: 20 * MIN, learnedLifeRouteKey: ROUTE }),
        reconcile({ learned1hLifeMs: 27 * MIN, learnedLifeRouteKey: ROUTE }),
      ]);
      expect(same?.learned1hLifeMs).toBe(20 * MIN);
      const other = readBackAdaptiveSessionState([
        reconcile({ learned1hLifeMs: 20 * MIN, learnedLifeRouteKey: ROUTE }),
        reconcile({ learned1hLifeMs: 27 * MIN, learnedLifeRouteKey: "anthropic|other" }),
      ]);
      expect(other).toMatchObject({ learned1hLifeMs: 27 * MIN, learnedLifeRouteKey: "anthropic|other" });
      const none = readBackAdaptiveSessionState([reconcile({ learned1hLifeMs: 20 * MIN })]);
      expect(none?.learned1hLifeMs).toBeUndefined();
    });
    it("out-of-range values (≤ one 5m TTL, > 1h) are not restored (review #5)", () => {
      for (const ms of [2 * MIN, 5 * MIN, 61 * MIN]) {
        const s = readBackAdaptiveSessionState([reconcile({ learned1hLifeMs: ms, learnedLifeRouteKey: ROUTE })]);
        expect(s?.learned1hLifeMs).toBeUndefined();
      }
    });
  });
});

// ─── service wiring (F-D / F-C inputs) ───────────────────────────────────────

describe("CacheAdaptiveService derives gapArmed / sinceTouch from provenCacheReadAt", () => {
  const SHAPE = { ephemeralBreakpoints: 1, ttl1h: false, hasThinking: false, maxTokens: 512 } as const;
  const LEDGER = ledger({ entrySeq: 0, entriesLength: 1, modelId: "claude-x" });

  function setup(proven: () => Millis | undefined) {
    const nowRef = { value: 1_000_000 as Millis };
    const appendEntry = vi.fn();
    const ctx = {
      sessionManager: { getEntries: () => [], getSessionId: () => "s1", getBranch: () => [] },
      model: { provider: "anthropic", api: "anthropic-messages", id: "claude-x" },
    } as unknown as ExtensionContext;
    const service = createCacheAdaptiveService({
      clock: { now: () => nowRef.value, setTimer: () => 0 as never, clearTimer: () => {} },
      ctx,
      sessionId: "s1",
      settings: { ...DEFAULT_SETTINGS.cacheTtl, mode: "adaptive", adaptiveEnabled: true },
      signals: () => ({ subagentRuns: 0, maxSubagentHorizonMs: undefined, backgroundBashJobs: 0 }),
      isCurrent: () => true,
      appendEntry,
      provenCacheReadAt: proven,
    });
    const gapArmedOfLastDecision = () => {
      const calls = appendEntry.mock.calls.filter(([, d]) => (d as { kind: string }).kind === "decision");
      return (calls.at(-1)?.[1] as { gapArmed?: boolean }).gapArmed;
    };
    return { nowRef, service, gapArmedOfLastDecision };
  }

  it("a proven read inside the gap marks it armed", () => {
    const { nowRef, service, gapArmedOfLastDecision } = setup(() => (nowRef.value - 60_000) as Millis);
    try {
      service.decide("s1", service.instanceId, { shape: SHAPE, ledger: LEDGER });
      nowRef.value = (nowRef.value + 25 * MIN) as Millis;
      service.decide("s1", service.instanceId, { shape: SHAPE, ledger: LEDGER });
      expect(gapArmedOfLastDecision()).toBe(true);
    } finally {
      service.dispose();
    }
  });

  it("control: a proven read from BEFORE the gap (or none) does not", () => {
    const start = 1_000_000 as Millis;
    const { nowRef, service, gapArmedOfLastDecision } = setup(() => (start - 1) as Millis);
    try {
      service.decide("s1", service.instanceId, { shape: SHAPE, ledger: LEDGER });
      nowRef.value = (nowRef.value + 25 * MIN) as Millis;
      service.decide("s1", service.instanceId, { shape: SHAPE, ledger: LEDGER });
      expect(gapArmedOfLastDecision()).toBe(false);
    } finally {
      service.dispose();
    }
  });
});
