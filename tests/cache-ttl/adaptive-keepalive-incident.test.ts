/**
 * Regression suite for the 2026-09-23 "ping worked, cache died anyway" field
 * incident (session 01a0cf02-8569, cloudrouter-anthropic / claude-opus-5).
 *
 * Observed timeline, straight from the session ledger + audit entries:
 *
 *   16:51:08  1h write 7,799 tok      → the 1h chain ends at prefix 248,705
 *   16:51:52  5m write   301 tok      (adaptive declined: refresh-throttled)
 *   16:52:15  5m write 3,046 tok      ← last real request; window opens
 *   16:56:11  ping proven-hit read=249,006
 *   17:00:11  ping proven-hit read=249,006
 *   17:04:12  ping proven-hit read=249,006   ← cache PROVEN alive
 *   17:05:21  subagent completion → turn; adaptive decided upgrade=true class=cold
 *   17:05:30  read=11,356  write=239,709 (all 1h)  $2.40  → write-budget breaker
 *
 * Two independent defects produced that $2.40:
 *
 *   D1 the warm/cold split measured staleness from the last REAL request only
 *      (809s), never from the pinger's proof (69s), so it took the cold branch
 *      whose entire premise is "the prefix is dead anyway, rewriting it at 1h
 *      is nearly free". A `ttl:"1h"` request resumes from the last 1h-written
 *      prefix point and cannot read the 5m entries the pings refreshed
 *      (13/13 exact matches in the same session), so the rewrite was full price.
 *
 *   D3 the `1h-ineffective` probe accepted `cacheRead > 0` as proof that the
 *      upstream honors 1h. The catastrophic request read 11,356 of ~252,052
 *      expected tokens (4.5% — just the cross-session-shared system/tools
 *      block) and was scored as an `indirect1hConfirm`.
 *
 * The numbers below are the real ones on purpose: if the fix regresses, the
 * failure message names the actual incident.
 */
import { describe, expect, it } from "vitest";
import {
  createInitialAdaptiveState,
  decideAdaptiveTtl,
  onLedgerObserved,
  type AdaptiveConfig,
  type AdaptiveDecideInput,
  type AdaptiveSignals,
  type AdaptiveState,
} from "../../src/cache-ttl/adaptive.js";
import {
  closeWindowAccounting,
  createInitialSessionTotals,
  createInitialWindowState,
  onProvenHit,
  onRealRequest,
  type CapturedRequest,
  type WindowState,
} from "../../src/cache-ttl/keepalive-state.js";
import type { LedgerUsage } from "../../src/cache-ttl/usage-ledger.js";

// ── the incident's clock (ms since epoch, anchored at 17:05:21) ────────────
const TURN_AT = 1_790_183_121_578; // 17:05:21.578 — the decision under test
const LAST_REAL_REQUEST_AT = TURN_AT - 809_034; // 16:51:52
const LAST_PROVEN_PING_AT = TURN_AT - 69_000; // 17:04:12

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

/** The live subagent that armed the strong signal (13,541,506ms of horizon left). */
const INCIDENT_SIGNALS: AdaptiveSignals = {
  subagentRuns: 1,
  maxSubagentHorizonMs: 13_541_506,
  backgroundBashJobs: 0,
  uiPrompts: 0,
  activeTools: 0,
};

/** Ledger as of 16:52:15 — what the 17:05:21 decision actually read. */
function incidentLedger(overrides: Partial<LedgerUsage> = {}): LedgerUsage {
  return {
    source: "usage",
    cacheRead: 249_006,
    cacheWrite: 3_046,
    cacheWrite1h: undefined,
    costTotalUsd: 0.1724,
    cacheWriteUsd: 0.019_037_5,
    entrySeq: 120,
    entriesLength: 121,
    modelId: "claude-opus-5",
    ...overrides,
  };
}

/** Adaptive state as of 17:05:21: 1h cover open, 3,347 tok written since the last 1h write. */
function incidentState(overrides: Partial<AdaptiveState> = {}): AdaptiveState {
  return {
    ...createInitialAdaptiveState(),
    lastRequestStartedAt: LAST_REAL_REQUEST_AT,
    lastGapMs: 43_938,
    lastUpgradeAt: LAST_REAL_REQUEST_AT - 44_000,
    tokensSinceLast1hWrite: 3_347, // 301 + 3,046
    armedEpisode: true,
    confirmed1hWrites: 12,
    oneHourCoverUntil: TURN_AT + 2_750_000, // armed 16:51:03, still open
    lastInvalidateSeq: -1,
    lastReconciledEntrySeq: 119,
    lastPrefixTokens: 252_052, // 249,006 + 3,046
    ...overrides,
  };
}

function incidentDecideInput(overrides: Partial<AdaptiveDecideInput> = {}): AdaptiveDecideInput {
  return {
    now: TURN_AT,
    mode: "adaptive",
    api: "anthropic-messages",
    provider: "cloudrouter-anthropic",
    modelId: "claude-opus-5",
    supportsLongCacheRetention: true,
    shape: { ephemeralBreakpoints: 4, ttl1h: false, hasThinking: true, maxTokens: 64_000 },
    signals: INCIDENT_SIGNALS,
    ledger: incidentLedger(),
    config: CONFIG,
    state: incidentState(),
    lastProvenCacheReadAt: LAST_PROVEN_PING_AT,
    ...overrides,
  };
}

describe("D1: the warm/cold split must see the keepalive pinger's proof", () => {
  it("replays the incident: a ping-proven-alive prefix is never cold-upgraded", () => {
    const decision = decideAdaptiveTtl(incidentDecideInput());

    // Pre-fix this was `upgrade: true, class: "cold"` with
    // predictedDeltaTokens 252,052 — a full-prefix 1h rewrite ($2.40).
    expect(decision.upgrade).toBe(false);
    expect(decision.class).toBeUndefined();
    // Warm path now, and the refresh throttle declines it: only 3,347 tok were
    // written since the last 1h write, well under the 16,000 refresh budget.
    expect(decision.reason).toBe("refresh-throttled");
  });

  it("without the proof (keepalive off) it still takes the cold branch — the fix is opt-in by evidence", () => {
    const decision = decideAdaptiveTtl(incidentDecideInput({ lastProvenCacheReadAt: undefined }));

    expect(decision.upgrade).toBe(true);
    expect(decision.class).toBe("cold");
    expect(decision.predictedDeltaTokens).toBe(252_052);
  });

  it("a proof older than the warm window does not rescue the decision", () => {
    // 260s > ASSUMED_TTL_MS − TTL_SAFETY_MARGIN_MS (255s): the ping is stale,
    // the prefix may really be dead, the cold branch is legitimate again.
    const decision = decideAdaptiveTtl(incidentDecideInput({ lastProvenCacheReadAt: TURN_AT - 260_000 }));

    expect(decision.upgrade).toBe(true);
    expect(decision.class).toBe("cold");
  });

  it("hard-gates the cold branch even when the ledger is too stale to be warm", () => {
    // `ledgerFresh` fails (model mismatch) ⇒ warm is unreachable ⇒ pre-fix this
    // fell straight through to the cold upgrade. The proof must still stop it.
    const decision = decideAdaptiveTtl(incidentDecideInput({ ledger: incidentLedger({ modelId: "claude-other" }) }));

    expect(decision.upgrade).toBe(false);
    expect(decision.reason).toBe("cold-cache-alive");
  });

  it("a cacheRead === 0 ledger cannot be warm, but the proof still blocks the cold upgrade", () => {
    const decision = decideAdaptiveTtl(incidentDecideInput({ ledger: incidentLedger({ cacheRead: 0 }) }));

    expect(decision.upgrade).toBe(false);
    expect(decision.reason).toBe("cold-cache-alive");
  });
});

describe("D3/D4: the 1h-effectiveness probe must judge the read, not just its sign", () => {
  /** The 17:05:30 settlement: read 11,356 / write 239,709 (all 1h) / $2.397. */
  const settlement = incidentLedger({
    cacheRead: 11_356,
    cacheWrite: 239_709,
    cacheWrite1h: 239_709,
    costTotalUsd: 2.404_653,
    cacheWriteUsd: 2.397_09,
    entrySeq: 121,
    entriesLength: 122,
  });

  const settling = incidentState({
    lastGapMs: 809_034, // the long gap is what arms the cover probe
    lastReconciledEntrySeq: 120,
    pending: {
      requestSeq: 14,
      minEntrySeq: 121,
      at: TURN_AT,
      class: "cold",
      predictedDeltaTokens: 252_052,
      covered1h: true,
    },
  });

  it("trips 1h-ineffective on a 4.5% read instead of counting it as a confirmation", () => {
    const next = onLedgerObserved(settling, settlement, TURN_AT + 9_000, CONFIG);

    expect(next.ineffective1h).toBe(1);
    expect(next.indirect1hConfirms).toBe(0);
    expect(next.breaker?.reason).toBe("1h-ineffective");
  });

  it("books the full-prefix rewrite against the entry fee, not the marginal budget", () => {
    const next = onLedgerObserved(settling, settlement, TURN_AT + 9_000, CONFIG);

    // Pre-fix: `pending.covered1h === true` sent 239,709 tok / $1.36 into the
    // marginal budget, blowing the $1 cap in one request.
    expect(next.upgradeWriteTokens).toBe(0);
    expect(next.upgradeWriteUsd).toBe(0);
    expect(next.feeWriteTokens).toBe(239_709);
    expect(next.feeUpgrades).toBe(1);
  });

  it("a healthy long-gap hit inside the cover window still counts as a confirmation", () => {
    // The 16:24:44 shape: previous prefix 130,018, read 118,516 (91%), write 13,234.
    const healthy = onLedgerObserved(
      incidentState({ lastGapMs: 420_000, lastPrefixTokens: 130_018, lastReconciledEntrySeq: 120, pending: undefined }),
      incidentLedger({ cacheRead: 118_516, cacheWrite: 13_234, cacheWrite1h: 13_234, entrySeq: 121 }),
      TURN_AT,
      CONFIG,
    );

    expect(healthy.indirect1hConfirms).toBe(1);
    expect(healthy.ineffective1h).toBe(0);
    expect(healthy.breaker).toBeUndefined();
  });

  it("a large legitimate increment is not mistaken for a collapse (anchor is the OLD prefix)", () => {
    // Read the whole old prefix, then append more than the prefix itself.
    const bigDelta = onLedgerObserved(
      incidentState({ lastGapMs: 420_000, lastPrefixTokens: 100_000, lastReconciledEntrySeq: 120, pending: undefined }),
      incidentLedger({ cacheRead: 100_000, cacheWrite: 120_000, cacheWrite1h: 120_000, entrySeq: 121 }),
      TURN_AT,
      CONFIG,
    );

    expect(bigDelta.indirect1hConfirms).toBe(1);
    expect(bigDelta.breaker).toBeUndefined();
  });

  it("falls back to the cacheRead > 0 test before any prefix has been measured", () => {
    const firstEver = onLedgerObserved(
      incidentState({ lastGapMs: 420_000, lastPrefixTokens: 0, lastReconciledEntrySeq: 120, pending: undefined }),
      incidentLedger({ cacheRead: 11_356, cacheWrite: 239_709, entrySeq: 121 }),
      TURN_AT,
      CONFIG,
    );

    expect(firstEver.indirect1hConfirms).toBe(1);
    expect(firstEver.ineffective1h).toBe(0);
  });
});

describe("D5: a window whose pings a 1h upgrade throws away is not load-bearing", () => {
  function captured(ttl1h: boolean): CapturedRequest {
    return {
      sessionId: "s",
      instance: "i",
      payload: { stream: true },
      headers: {},
      fingerprint: {
        sessionId: "s",
        provider: "cloudrouter-anthropic",
        api: "anthropic-messages",
        modelId: "claude-opus-5",
        ctxModelId: "claude-opus-5",
        baseUrl: "https://example.invalid",
        authHeaderKeys: "",
        breakpointPath: "",
        thinkingDigest: "",
        systemDigest: "",
        toolsDigest: "",
        messageCount: 42,
      },
      shape: { ephemeralBreakpoints: 4, ttl1h, hasThinking: true, maxTokens: 64_000 },
      prefix: { tokens: 248_705, source: "usage" },
      capturedAt: TURN_AT,
    };
  }

  /** Window as of 17:04:12: opened 16:52:15, three proven pings. */
  function pingedWindow(): WindowState {
    return {
      ...createInitialWindowState(),
      windowEpoch: 52,
      capture: captured(false),
      windowStartAt: LAST_REAL_REQUEST_AT,
      lastReadStartedAt: LAST_PROVEN_PING_AT,
      aliveUntil: LAST_PROVEN_PING_AT + 300_000,
      lastProvenPingStartedAt: LAST_PROVEN_PING_AT,
      pings: 3,
    };
  }

  it("counts the incident's window as discarded, not as 248k tokens of avoided rewrite", () => {
    const totals = closeWindowAccounting(pingedWindow(), createInitialSessionTotals(), TURN_AT, 300_000, true);

    expect(totals.discardedWindows).toBe(1);
    expect(totals.discardedPings).toBe(3);
    expect(totals.loadBearingWindows).toBe(0);
    expect(totals.avoidedMissTokens).toBe(0);
  });

  it("still credits a genuinely load-bearing window when the next request stays 5m", () => {
    const { session } = onRealRequest(pingedWindow(), createInitialSessionTotals(), captured(false), TURN_AT, 240_000);

    expect(session.loadBearingWindows).toBe(1);
    expect(session.loadBearingPings).toBe(3);
    expect(session.avoidedMissTokens).toBe(248_705);
    expect(session.discardedWindows).toBe(0);
  });

  it("onRealRequest routes a 1h follow-up through the discard bucket", () => {
    const { session, window } = onRealRequest(
      pingedWindow(),
      createInitialSessionTotals(),
      captured(true),
      TURN_AT,
      240_000,
    );

    expect(session.discardedWindows).toBe(1);
    expect(session.loadBearingWindows).toBe(0);
    // The fresh window must not inherit the old proof.
    expect(window.lastProvenPingStartedAt).toBeUndefined();
  });
});

describe("keepalive: only a proven hit records proof of liveness", () => {
  it("onProvenHit stamps the ping's START time (official TTL anchor), not its completion", () => {
    const window: WindowState = {
      ...createInitialWindowState(),
      windowEpoch: 7,
      windowStartAt: LAST_REAL_REQUEST_AT,
      pingStartedAt: LAST_PROVEN_PING_AT,
      pingInFlight: true,
    };

    const outcome = onProvenHit(
      window,
      createInitialSessionTotals(),
      7,
      { kind: "proven-hit", cacheReadTokens: 249_006, inputTokens: 2 },
      240_000,
    );

    expect(outcome.applied).toBe(true);
    expect(outcome.window.lastProvenPingStartedAt).toBe(LAST_PROVEN_PING_AT);
  });

  it("an epoch-mismatched result records nothing", () => {
    const window: WindowState = {
      ...createInitialWindowState(),
      windowEpoch: 8,
      pingStartedAt: LAST_PROVEN_PING_AT,
      pingInFlight: true,
    };

    const outcome = onProvenHit(
      window,
      createInitialSessionTotals(),
      7,
      { kind: "proven-hit", cacheReadTokens: 249_006, inputTokens: 2 },
      240_000,
    );

    expect(outcome.applied).toBe(false);
    expect(outcome.window.lastProvenPingStartedAt).toBeUndefined();
  });
});
