/**
 * Regression tests for the fixes that came out of the 2026-09-25 adaptive
 * verification (docs/dev/cache-ttl-adaptive/verification-2026-09-25.md, plan.md §19).
 * Field numbers are the real ones, so a regression names its incident.
 *
 *   F1 keepalive ↔ adaptive arbitration (no double payment)
 *   F2 lineage/drift-aware 1h judgement (no false `1h-ineffective`)
 *   F3 an entry fee needs a strong, quantified horizon (S4 alone is not enough)
 *   F4 cold upgrades are booked at the 5m→1h premium (0.375), not 0.95
 *   F5 a collapsed covered settlement is not judged by the warm probes
 */
import { describe, expect, it } from "vitest";
import {
  ENTRY_FEE_MARGINAL_WRITE_FRACTION,
  MARGINAL_WRITE_FRACTION,
  adaptiveCoversPrefix,
  createInitialAdaptiveState,
  decideAdaptiveTtl,
  ledgerRouteKey,
  noteDecision,
  onLedgerObserved,
  type AdaptiveConfig,
  type AdaptiveDecideInput,
  type AdaptivePending,
  type AdaptiveSignals,
  type AdaptiveState,
} from "../../src/cache-ttl/adaptive.js";
import {
  ASSUMED_TTL_MS,
  createInitialSessionTotals,
  createInitialWindowState,
  evaluateTick,
  keepaliveGapHorizonMs,
  payloadLineageKey,
  type CapturedRequest,
  type CaptureFingerprint,
} from "../../src/cache-ttl/keepalive-state.js";
import type { LedgerUsage } from "../../src/cache-ttl/usage-ledger.js";

const NOW = 1_790_000_000_000;
const MIN = 60_000;
const HORIZON = keepaliveGapHorizonMs({ intervalMs: 240_000, maxPings: 11 });

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
    signals: signals(),
    ledger: ledger(),
    config: CONFIG,
    state: state({ lastRequestStartedAt: NOW - 20_000 }),
    lastProvenCacheReadAt: undefined,
    ...o,
  });
}

function pending(o: Partial<AdaptivePending> = {}): AdaptivePending {
  return {
    requestSeq: 1,
    minEntrySeq: 11,
    at: NOW,
    class: "warm",
    predictedDeltaTokens: 5_000,
    covered1h: false,
    ...o,
  };
}

// ─── F1 ─────────────────────────────────────────────────────────────────────

describe("F1 — adaptive does not buy what keepalive already covers", () => {
  it("horizon = 11 pings × 4 min + one 5-min TTL", () => {
    expect(HORIZON).toBe(49 * MIN);
    expect(keepaliveGapHorizonMs({ intervalMs: 240_000, maxPings: 0 })).toBe(ASSUMED_TTL_MS);
  });

  it("warm uncovered upgrade is refused while every seen gap fits the ping horizon", () => {
    const d = decide({
      signals: signals({ subagentRuns: 1, maxSubagentHorizonMs: 30 * MIN }),
      keepaliveHorizonMs: HORIZON,
    });
    expect(d).toMatchObject({ upgrade: false, reason: "keepalive-covers" });
  });

  it("control: the same request upgrades without keepalive (horizon undefined ⇒ pre-fix behaviour)", () => {
    const d = decide({
      signals: signals({ subagentRuns: 1, maxSubagentHorizonMs: 30 * MIN }),
      keepaliveHorizonMs: undefined,
    });
    expect(d).toMatchObject({ upgrade: true, class: "warm" });
  });

  it("a session that has SHOWN a gap beyond the horizon earns the entry fee", () => {
    const d = decide({
      signals: signals({ subagentRuns: 1, maxSubagentHorizonMs: 30 * MIN }),
      keepaliveHorizonMs: HORIZON,
      state: state({ lastRequestStartedAt: NOW - 20_000, gaps: [20 * MIN, 55 * MIN] }),
    });
    expect(d).toMatchObject({ upgrade: true, class: "warm" });
  });

  it("cold opening is refused the same way", () => {
    const d = decide({
      signals: signals({ backgroundBashJobs: 1 }),
      keepaliveHorizonMs: HORIZON,
      state: state({ lastRequestStartedAt: NOW - 20 * MIN, gaps: [20 * MIN] }),
    });
    expect(d).toMatchObject({ upgrade: false, reason: "keepalive-covers" });
  });

  it("a covered refresh is unaffected (the fee is already paid)", () => {
    const d = decide({
      signals: signals({ subagentRuns: 1, maxSubagentHorizonMs: 30 * MIN }),
      keepaliveHorizonMs: HORIZON,
      state: state({
        lastRequestStartedAt: NOW - 20_000,
        oneHourCoverUntil: NOW + 30 * MIN,
        confirmed1hWrites: 1,
        lastUpgradeAt: NOW - 10 * MIN,
        tokensSinceLast1hWrite: 18_000,
      }),
    });
    expect(d).toMatchObject({ upgrade: true, class: "warm" });
  });

  describe("adaptiveCoversPrefix (keepalive stands down — only on evidence, review R2)", () => {
    const covered = state({
      oneHourCoverUntil: NOW + 55 * MIN,
      confirmed1hWrites: 1,
      tokensSinceLast1hWrite: 3_000,
      max1hSurvivalMs: 52 * MIN, // a covered request already read the 1h entry after a 52-min gap
      survivalRouteKey: "anthropic|m",
      lastRouteKey: "anthropic|m",
      coverLineageKey: "A",
      lastLineageKey: "A",
    });
    it("true for a settled, confirmed 1h entry with a small tail, proven to outlive the horizon", () => {
      expect(adaptiveCoversPrefix(covered, CONFIG, NOW, HORIZON)).toBe(true);
    });
    it.each([
      ["breaker tripped", { breaker: { reason: "write-budget" as const, at: NOW } }],
      ["upgrade still unsettled", { pending: pending() }],
      ["1h never confirmed by the split", { confirmed1hWrites: 0, unconfirmed1hWrites: 1 }],
      ["cover window expired", { oneHourCoverUntil: NOW - 1 }],
      ["5m tail too large", { tokensSinceLast1hWrite: 16_001 }],
      // R2: the optimistic 1h cover is not evidence — the measured route lost 1h entries past ~27 min.
      ["no survival evidence yet", { max1hSurvivalMs: 0 }],
      ["survival proven only below the horizon (23 min)", { max1hSurvivalMs: 23 * MIN }],
      ["remaining cover shorter than the horizon", { oneHourCoverUntil: NOW + 30 * MIN }],
      // R4: the last request (the one keepalive would replay) is of another lineage.
      ["last request of another lineage", { lastLineageKey: "B" }],
      // R9: survival is a property of the upstream route — evidence never transfers.
      ["evidence measured on another route", { lastRouteKey: "copilot|m" }],
      ["evidence without a route", { survivalRouteKey: undefined }],
    ])("false when %s", (_name, o) => {
      expect(adaptiveCoversPrefix({ ...covered, ...o }, CONFIG, NOW, HORIZON)).toBe(false);
    });
  });

  describe("evaluateTick gate #11.5", () => {
    const fp: CaptureFingerprint = {
      sessionId: "s1",
      provider: "anthropic",
      api: "anthropic-messages",
      modelId: "claude",
      ctxModelId: "claude",
      baseUrl: "https://api.anthropic.com",
      authHeaderKeys: "x-api-key",
      breakpointPath: "system.0",
      thinkingDigest: "",
      systemDigest: "10:abc:abc",
      toolsDigest: "0:",
      messageCount: 3,
    };
    const capture: CapturedRequest = {
      sessionId: "s1",
      instance: "i",
      payload: { messages: [], stream: true },
      headers: {},
      fingerprint: fp,
      shape: { ephemeralBreakpoints: 1, ttl1h: false, hasThinking: false, maxTokens: 4096 },
      prefix: { tokens: 100_000, source: "usage" },
      capturedAt: 0,
    };
    const tick = (adaptiveCovered: boolean | undefined) =>
      evaluateTick({
        now: 240_000,
        mode: "tui",
        armed: true,
        config: { enabled: true, intervalMs: 240_000, maxPings: 11, minPrefixTokens: 20_000, upgradeAfterBudget: true },
        session: createInitialSessionTotals(),
        window: {
          ...createInitialWindowState(),
          capture,
          windowStartAt: 0,
          lastReadStartedAt: 0,
          aliveUntil: ASSUMED_TTL_MS,
          nextPingAt: 240_000,
        },
        currentFingerprint: fp,
        ...(adaptiveCovered === undefined ? {} : { adaptiveCovered }),
      }).decision;
    it("skips terminally while adaptive covers the prefix", () => {
      expect(tick(true)).toEqual({ kind: "skip", reason: "adaptive-1h", terminal: true });
    });
    it("pings as before when not covered / not reported", () => {
      expect(tick(false)).toEqual({ kind: "ping" });
      expect(tick(undefined)).toEqual({ kind: "ping" });
    });
  });
});

// ─── F2 ─────────────────────────────────────────────────────────────────────

describe("F2 — prefix drift drops the cover instead of tripping 1h-ineffective", () => {
  it("01a0d2f9 10:49: a SHRUNK prefix after a 9.8-min gap is another lineage, not a dead 1h entry", () => {
    // 1h point 87,393 (10:39:23); the wake-turn lineage sent 83,691 and shared 9,149.
    const s = state({
      lastPrefixTokens: 87_393,
      lastReconciledEntrySeq: 9,
      oneHourCoverUntil: NOW + 50 * MIN,
      confirmed1hWrites: 1,
      lastGapMs: 9.8 * MIN,
    });
    const next = onLedgerObserved(s, ledger({ cacheRead: 9_149, cacheWrite: 74_542, cacheWrite1h: 0 }), NOW, CONFIG);
    expect(next.breaker).toBeUndefined();
    expect(next.ineffective1h).toBe(0);
    expect(next.oneHourCoverUntil).toBeUndefined();
    expect(next.driftCoverClears).toBe(1);
  });

  it("01a0d2e4 10:48:34: a whole-prefix miss 56 s after the last request clears the cover; the later long-gap miss is not judged", () => {
    const s = state({
      lastPrefixTokens: 205_943,
      lastReconciledEntrySeq: 9,
      oneHourCoverUntil: NOW + 50 * MIN,
      confirmed1hWrites: 2,
      lastGapMs: 56_000,
    });
    const drifted = onLedgerObserved(
      s,
      ledger({ cacheRead: 11_846, cacheWrite: 207_109, cacheWrite1h: 0 }),
      NOW,
      CONFIG,
    );
    expect(drifted.oneHourCoverUntil).toBeUndefined();
    expect(drifted.breaker).toBeUndefined();
    // 10:55:57, 6.9-min gap, read 43,088 of 221,838.
    const later = onLedgerObserved(
      { ...drifted, lastPrefixTokens: 221_838, lastGapMs: 6.9 * MIN },
      ledger({ entrySeq: 20, cacheRead: 43_088, cacheWrite: 179_986, cacheWrite1h: 0 }),
      NOW + 7 * MIN,
      CONFIG,
    );
    expect(later.breaker).toBeUndefined();
  });

  it("control: a GROWN prefix that collapses after a long gap inside the cover still trips (route ignores 1h)", () => {
    const s = state({
      lastPrefixTokens: 252_052,
      lastReconciledEntrySeq: 9,
      oneHourCoverUntil: NOW + 50 * MIN,
      confirmed1hWrites: 1,
      lastGapMs: 13.5 * MIN,
    });
    const next = onLedgerObserved(s, ledger({ cacheRead: 11_356, cacheWrite: 243_000, cacheWrite1h: 0 }), NOW, CONFIG);
    expect(next.breaker?.reason).toBe("1h-ineffective");
    expect(next.driftCoverClears).toBe(0);
  });

  it("an upgrade settling as a collapse is the entry-fee shape, not drift (cover kept)", () => {
    const s = state({
      lastPrefixTokens: 86_103,
      lastReconciledEntrySeq: 9,
      oneHourCoverUntil: NOW + 60 * MIN,
      lastGapMs: 20_000,
      pending: pending({ minEntrySeq: 10 }),
    });
    const next = onLedgerObserved(s, ledger({ cacheRead: 0, cacheWrite: 87_391, cacheWrite1h: 87_391 }), NOW, CONFIG);
    expect(next.oneHourCoverUntil).toBe(NOW + 60 * MIN);
    expect(next.driftCoverClears).toBe(0);
    expect(next.feeUpgrades).toBe(1);
  });
});

// ─── F4 ─────────────────────────────────────────────────────────────────────

describe("F4 — entry-fee USD fraction follows the counterfactual", () => {
  const settle = (cls: "warm" | "cold") =>
    onLedgerObserved(
      state({ lastReconciledEntrySeq: 9, pending: pending({ class: cls, minEntrySeq: 10 }) }),
      ledger({ cacheRead: 0, cacheWrite: 100_000, cacheWrite1h: 100_000, cacheWriteUsd: 1.0 }),
      NOW,
      CONFIG,
    );
  it("cold (prefix presumed dead): only the 5m→1h premium, 0.375", () => {
    expect(settle("cold").feeWriteUsd).toBeCloseTo(MARGINAL_WRITE_FRACTION * 1.0, 10);
  });
  it("warm transition (5m would have hit): 0.95", () => {
    expect(settle("warm").feeWriteUsd).toBeCloseTo(ENTRY_FEE_MARGINAL_WRITE_FRACTION * 1.0, 10);
  });
});

// ─── F5 ─────────────────────────────────────────────────────────────────────

describe("F5 — a collapsed covered settlement is booked as a fee and not probed", () => {
  it("01a0d188 04:04:55: read 44,386 of 133,651 under cover ⇒ fee, no warm-write-too-expensive", () => {
    const s = state({
      lastPrefixTokens: 133_651,
      lastReconciledEntrySeq: 9,
      oneHourCoverUntil: NOW + 40 * MIN,
      confirmed1hWrites: 1,
      lastGapMs: 30_000,
      pending: pending({ covered1h: true, predictedDeltaTokens: 6_000, minEntrySeq: 10 }),
    });
    const next = onLedgerObserved(
      s,
      ledger({ cacheRead: 44_386, cacheWrite: 95_000, cacheWrite1h: 95_000 }),
      NOW,
      CONFIG,
    );
    expect(next.breaker).toBeUndefined();
    expect(next.feeUpgrades).toBe(1);
    expect(next.upgradeWriteTokens).toBe(0);
  });

  it("control: a covered settlement that READ the prefix and still over-wrote trips", () => {
    const s = state({
      lastPrefixTokens: 133_651,
      lastReconciledEntrySeq: 9,
      oneHourCoverUntil: NOW + 40 * MIN,
      confirmed1hWrites: 1,
      lastGapMs: 30_000,
      pending: pending({ covered1h: true, predictedDeltaTokens: 6_000, minEntrySeq: 10 }),
    });
    const next = onLedgerObserved(
      s,
      ledger({ cacheRead: 133_651, cacheWrite: 95_000, cacheWrite1h: 95_000 }),
      NOW,
      CONFIG,
    );
    expect(next.breaker?.reason).toBe("warm-write-too-expensive");
  });
});

// ─── review revisions R2–R4 ─────────────────────────────────────────────────

describe("R2 — survival evidence is recorded from covered long-gap hits", () => {
  it("a covered request that reads the 1h entry after a 52-min gap raises max1hSurvivalMs", () => {
    const s = state({
      lastPrefixTokens: 120_000,
      lastReconciledEntrySeq: 9,
      oneHourCoverUntil: NOW + 5 * MIN,
      confirmed1hWrites: 1,
      lastGapMs: 52 * MIN,
      max1hSurvivalMs: 20 * MIN,
    });
    const next = onLedgerObserved(
      s,
      ledger({ providerId: "anthropic", cacheRead: 118_000, cacheWrite: 4_000 }),
      NOW,
      CONFIG,
    );
    expect(next.indirect1hConfirms).toBe(1);
    expect(next.max1hSurvivalMs).toBe(52 * MIN);
  });
});

describe("R3 — a ledger entry of an EARLIER request is accounted but not judged", () => {
  it("no drift clear and no 1h verdict when the ledger predates the latest decision", () => {
    const s = state({
      lastPrefixTokens: 200_000,
      lastReconciledEntrySeq: 9,
      oneHourCoverUntil: NOW + 50 * MIN,
      confirmed1hWrites: 1,
      lastGapMs: 20 * MIN, // describes the LATEST request (entriesLength 14), not entry #10
      lastDecisionEntriesLength: 14,
    });
    const next = onLedgerObserved(s, ledger({ entrySeq: 10, cacheRead: 11_000, cacheWrite: 195_000 }), NOW, CONFIG);
    expect(next.breaker).toBeUndefined();
    expect(next.oneHourCoverUntil).toBe(NOW + 50 * MIN);
    expect(next.tokensSinceLast1hWrite).toBe(195_000); // still accounted
  });
});

describe("R4 — lineage keys", () => {
  const coveredA = {
    lastPrefixTokens: 221_838,
    lastReconciledEntrySeq: 9,
    oneHourCoverUntil: NOW + 50 * MIN,
    confirmed1hWrites: 2,
    coverLineageKey: "A",
  };

  it("a long-gap miss of ANOTHER lineage is not a route verdict, and A's cover is kept", () => {
    // 01a0d2e4 shape: a grown prefix, so the shrink heuristic alone could not save it.
    const next = onLedgerObserved(
      state({ ...coveredA, lastLineageKey: "B", lastGapMs: 6.9 * MIN }),
      ledger({ cacheRead: 43_088, cacheWrite: 179_986, cacheWrite1h: 0 }),
      NOW,
      CONFIG,
    );
    expect(next.breaker).toBeUndefined();
    expect(next.ineffective1h).toBe(0);
    expect(next.oneHourCoverUntil).toBe(NOW + 50 * MIN);
    expect(next.driftCoverClears).toBe(0);
  });

  it("control: the SAME lineage collapsing after a long gap still trips 1h-ineffective", () => {
    const next = onLedgerObserved(
      state({ ...coveredA, lastLineageKey: "A", lastGapMs: 13.5 * MIN }),
      ledger({ cacheRead: 11_356, cacheWrite: 215_000, cacheWrite1h: 0 }),
      NOW,
      CONFIG,
    );
    expect(next.breaker?.reason).toBe("1h-ineffective");
  });

  it("a shrunk prefix that still READ the cache is not drift (e.g. history got shorter)", () => {
    const next = onLedgerObserved(
      state({ ...coveredA, lastLineageKey: "A", lastGapMs: 40_000 }),
      ledger({ cacheRead: 200_000, cacheWrite: 5_000 }),
      NOW,
      CONFIG,
    );
    expect(next.oneHourCoverUntil).toBe(NOW + 50 * MIN);
    expect(next.driftCoverClears).toBe(0);
  });

  it("decide: a request of another lineage is not covered ⇒ entry-fee path, not a covered refresh", () => {
    const covered = state({
      lastRequestStartedAt: NOW - 20_000,
      oneHourCoverUntil: NOW + 30 * MIN,
      confirmed1hWrites: 1,
      lastUpgradeAt: NOW - 10 * MIN,
      tokensSinceLast1hWrite: 18_000,
      gaps: [400_000],
      coverLineageKey: "A",
    });
    // S4-only: allowed as a covered refresh on lineage A, refused as a fee on lineage B.
    expect(decide({ state: covered, lineageKey: "A" })).toMatchObject({ upgrade: true, class: "warm" });
    expect(decide({ state: covered, lineageKey: "B" })).toMatchObject({
      upgrade: false,
      reason: "fee-horizon-too-short",
    });
    // No key supplied ⇒ lineage unchecked (pre-R4 behaviour).
    expect(decide({ state: covered })).toMatchObject({ upgrade: true, class: "warm" });
  });

  it("noteDecision records the lineage of the request and of the cover it arms", () => {
    const d = decide({ signals: signals({ subagentRuns: 1, maxSubagentHorizonMs: 30 * MIN }), lineageKey: "A" });
    const next = noteDecision(state({ lastRequestStartedAt: NOW - 20_000 }), d, {
      now: NOW,
      gapMs: 20_000,
      entriesLength: 12,
      strongSignals: 1,
      lineageKey: "A",
    });
    expect(next.lastLineageKey).toBe("A");
    expect(next.coverLineageKey).toBe("A");
    expect(next.lastDecisionEntriesLength).toBe(12);
  });

  it("payloadLineageKey changes with the system text, tools or thinking config — not with messages", () => {
    const base = {
      system: [{ type: "text", text: "sys" }],
      tools: [{ name: "read" }],
      messages: [{ role: "user", content: "a" }],
    };
    const k = payloadLineageKey(base);
    expect(payloadLineageKey({ ...base, messages: [...base.messages, { role: "user", content: "b" }] })).toBe(k);
    expect(payloadLineageKey({ ...base, system: [{ type: "text", text: "sys + memory" }] })).not.toBe(k);
    expect(payloadLineageKey({ ...base, tools: [{ name: "read" }, { name: "bash" }] })).not.toBe(k);
    expect(payloadLineageKey({ ...base, thinking: { type: "enabled", budget_tokens: 1024 } })).not.toBe(k);
  });
});

// ─── review round 2: R2 flow, R3 bounds, R8 collisions, R9 routes ──────────

describe("R2 flow — evidence alone does not stand keepalive down; the next covered refresh does", () => {
  it("upgrade → confirmed settle → 52-min covered hit (evidence) → refresh → stand-down", () => {
    const H = HORIZON;
    const sig = signals({ subagentRuns: 1, maxSubagentHorizonMs: 30 * MIN });
    const led = (o: Partial<LedgerUsage>) => ledger({ providerId: "anthropic", ...o });
    let t = NOW;
    let s = state({ lastRequestStartedAt: t - 20_000, lastReconciledEntrySeq: 9, lastPrefixTokens: 100_000 });

    // 1) open the prefix (no keepalive horizon here: the fee is allowed)
    let d = decide({ now: t, state: s, signals: sig, ledger: led({ entrySeq: 9 }), lineageKey: "A" });
    expect(d.upgrade).toBe(true);
    s = noteDecision(s, d, { now: t, gapMs: 20_000, entriesLength: 10, strongSignals: 1, lineageKey: "A" });
    s = onLedgerObserved(s, led({ entrySeq: 10, cacheRead: 0, cacheWrite: 104_000, cacheWrite1h: 104_000 }), t, CONFIG);
    expect(s.confirmed1hWrites).toBe(1);
    expect(adaptiveCoversPrefix(s, CONFIG, t, H)).toBe(false); // no evidence yet

    // 2) a 52-min gap; the request (5m, no signal) reads the 1h entry ⇒ evidence
    t += 52 * MIN;
    d = decide({ now: t, state: s, signals: signals(), ledger: led({ entrySeq: 10 }), lineageKey: "A" });
    s = noteDecision(s, d, { now: t, gapMs: 52 * MIN, entriesLength: 11, strongSignals: 0, lineageKey: "A" });
    s = onLedgerObserved(s, led({ entrySeq: 11, cacheRead: 104_000, cacheWrite: 17_000, cacheWrite1h: 0 }), t, CONFIG);
    expect(s.max1hSurvivalMs).toBe(52 * MIN);
    expect(s.survivalRouteKey).toBe("anthropic|m");
    // …but the optimistic cover armed 52 min ago has only 8 min left < 49-min horizon (intentionally conservative).
    expect(adaptiveCoversPrefix(s, CONFIG, t, H)).toBe(false);

    // 3) a covered refresh re-arms the cover (tail 17k ≥ 16k refresh threshold) ⇒ now keepalive may stand down
    t += 20_000;
    d = decide({
      now: t,
      state: s,
      signals: sig,
      ledger: led({ entrySeq: 11, cacheRead: 104_000, cacheWrite: 3_000 }),
      lineageKey: "A",
    });
    expect(d).toMatchObject({ upgrade: true, class: "warm" });
    s = noteDecision(s, d, { now: t, gapMs: 20_000, entriesLength: 12, strongSignals: 1, lineageKey: "A" });
    s = onLedgerObserved(
      s,
      led({ entrySeq: 12, cacheRead: 104_000, cacheWrite: 20_000, cacheWrite1h: 20_000 }),
      t,
      CONFIG,
    );
    expect(adaptiveCoversPrefix(s, CONFIG, t, H)).toBe(true);
  });
});

describe("R3 bounds — describesLatest", () => {
  const judged = (lastDecisionEntriesLength: number, entrySeq: number) =>
    onLedgerObserved(
      state({
        lastPrefixTokens: 200_000,
        lastReconciledEntrySeq: 9,
        oneHourCoverUntil: NOW + 50 * MIN,
        confirmed1hWrites: 1,
        lastGapMs: 20 * MIN,
        lastDecisionEntriesLength,
      }),
      ledger({ entrySeq, cacheRead: 11_000, cacheWrite: 195_000 }),
      NOW,
      CONFIG,
    ).breaker?.reason;
  it("equality is the normal case — the new assistant entry lands exactly at entriesLength ⇒ judged", () => {
    expect(judged(12, 12)).toBe("1h-ineffective");
  });
  it("initial -1 (no decision recorded yet) ⇒ judged as before", () => {
    expect(judged(-1, 12)).toBe("1h-ineffective");
  });
  it("one below ⇒ an earlier request ⇒ not judged", () => {
    expect(judged(13, 12)).toBeUndefined();
  });
});

describe("R8 — the lineage key hashes full content", () => {
  const sys = (middle: string) => [{ type: "text", text: `${"H".repeat(80)}${middle}${"T".repeat(80)}` }];
  it("a same-length edit in the MIDDLE of the system prompt changes the key", () => {
    const a = { system: sys("updated: 2026-09-25T04:00"), messages: [] };
    const b = { system: sys("updated: 2026-09-25T05:00"), messages: [] };
    expect(JSON.stringify(a).length).toBe(JSON.stringify(b).length);
    expect(payloadLineageKey(a)).not.toBe(payloadLineageKey(b));
  });
  it("a tool schema / description change under the same name changes the key", () => {
    const t1 = { system: "s", tools: [{ name: "read", input_schema: { type: "object", properties: { path: {} } } }] };
    const t2 = { system: "s", tools: [{ name: "read", input_schema: { type: "object", properties: { file: {} } } }] };
    expect(payloadLineageKey(t1)).not.toBe(payloadLineageKey(t2));
  });
  it("is stable for identical content and never throws on odd input", () => {
    const p = { system: "s", tools: [{ name: "a" }], thinking: { type: "enabled" } };
    expect(payloadLineageKey(p)).toBe(payloadLineageKey(JSON.parse(JSON.stringify(p))));
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    // unserializable content has no reliable identity ⇒ unknown (lineage unchecked), never a lossy stand-in
    expect(payloadLineageKey({ system: "s", tools: [cyclic] })).toBeUndefined();
    expect(payloadLineageKey(null)).toBeUndefined();
  });
});

describe("R9 — survival evidence is bound to the route", () => {
  const hitAfter52 = (s: AdaptiveState, providerId: string) =>
    onLedgerObserved(s, ledger({ providerId, cacheRead: 118_000, cacheWrite: 4_000 }), NOW, CONFIG);
  const base = state({
    lastPrefixTokens: 120_000,
    lastReconciledEntrySeq: 9,
    oneHourCoverUntil: NOW + 5 * MIN,
    confirmed1hWrites: 1,
    lastGapMs: 30 * MIN,
  });
  it("records the route with the evidence and tracks the last settled route", () => {
    const next = hitAfter52(base, "cloudrouter-anthropic");
    expect(next.survivalRouteKey).toBe("cloudrouter-anthropic|m");
    expect(next.lastRouteKey).toBe("cloudrouter-anthropic|m");
    expect(ledgerRouteKey(ledger({ providerId: "x", modelId: "y" }))).toBe("x|y");
  });
  it("evidence from another route is REPLACED, not merged (a longer old value cannot leak)", () => {
    const next = hitAfter52(
      { ...base, max1hSurvivalMs: 55 * MIN, survivalRouteKey: "other|m" },
      "cloudrouter-anthropic",
    );
    expect(next.max1hSurvivalMs).toBe(30 * MIN);
    expect(next.survivalRouteKey).toBe("cloudrouter-anthropic|m");
  });
  it("same route keeps the maximum", () => {
    const next = hitAfter52(
      { ...base, max1hSurvivalMs: 55 * MIN, survivalRouteKey: "cloudrouter-anthropic|m" },
      "cloudrouter-anthropic",
    );
    expect(next.max1hSurvivalMs).toBe(55 * MIN);
  });
});

describe("R9 round 3 — an UNKNOWN route is never evidence", () => {
  it("ledgerRouteKey is undefined without a provider or a model", () => {
    expect(ledgerRouteKey(ledger({ modelId: "opus" }))).toBeUndefined();
    expect(ledgerRouteKey(ledger({ providerId: "", modelId: "opus" }))).toBeUndefined();
    expect(ledgerRouteKey(ledger({ providerId: "a", modelId: "" }))).toBeUndefined();
  });

  it("review scenario: two providers serving model 'opus' without provider fields never share evidence", () => {
    // provider A's 1h entry is read after 52 min — but the ledger does not say which provider served it
    const afterA = onLedgerObserved(
      state({
        lastPrefixTokens: 120_000,
        lastReconciledEntrySeq: 9,
        oneHourCoverUntil: NOW + 5 * MIN,
        confirmed1hWrites: 1,
        lastGapMs: 52 * MIN,
      }),
      ledger({ modelId: "opus", cacheRead: 118_000, cacheWrite: 4_000 }),
      NOW,
      CONFIG,
    );
    expect(afterA.indirect1hConfirms).toBe(1); // the hit still counts as a 1h confirmation…
    expect(afterA.max1hSurvivalMs).toBe(0); // …but not as survival evidence
    expect(afterA.survivalRouteKey).toBeUndefined();
    // provider B, fresh cover, same unknown route shape ⇒ keepalive must NOT stand down
    const onB = { ...afterA, oneHourCoverUntil: NOW + 58 * MIN, confirmed1hWrites: 2, tokensSinceLast1hWrite: 0 };
    expect(adaptiveCoversPrefix(onB, CONFIG, NOW, HORIZON)).toBe(false);
  });

  it("a hit on an unknown route also DROPS earlier known-route evidence (it may be another provider now)", () => {
    const next = onLedgerObserved(
      state({
        lastPrefixTokens: 120_000,
        lastReconciledEntrySeq: 9,
        oneHourCoverUntil: NOW + 5 * MIN,
        confirmed1hWrites: 1,
        lastGapMs: 30 * MIN,
        max1hSurvivalMs: 55 * MIN,
        survivalRouteKey: "anthropic|opus",
      }),
      ledger({ modelId: "opus", cacheRead: 118_000, cacheWrite: 4_000 }),
      NOW,
      CONFIG,
    );
    expect(next.max1hSurvivalMs).toBe(0);
    expect(next.lastRouteKey).toBeUndefined();
  });
});
