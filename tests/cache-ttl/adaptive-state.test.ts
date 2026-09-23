import { describe, expect, it } from "vitest";
import {
  ADAPTIVE_GAP_RING_SIZE,
  ADAPTIVE_PENDING_TTL_MS,
  buildAdaptiveSnapshot,
  createInitialAdaptiveState,
  decideAdaptiveTtl,
  endArmedEpisode,
  invalidateAdaptive,
  noteDecision,
  onLedgerObserved,
  type AdaptiveConfig,
  type AdaptiveDecideInput,
  type AdaptiveDecision,
  type AdaptiveSignals,
  type AdaptiveState,
} from "../../src/cache-ttl/adaptive.js";
import { ASSUMED_TTL_MS } from "../../src/cache-ttl/keepalive-state.js";
import type { LedgerUsage } from "../../src/cache-ttl/usage-ledger.js";

const NOW = 1_000_000;

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

const NO_SIGNALS: AdaptiveSignals = {
  subagentRuns: 0,
  maxSubagentHorizonMs: undefined,
  backgroundBashJobs: 0,
  uiPrompts: 0,
  activeTools: 0,
};

function signals(overrides: Partial<AdaptiveSignals> = {}): AdaptiveSignals {
  return { ...NO_SIGNALS, ...overrides };
}

function ledger(overrides: Partial<LedgerUsage> = {}): LedgerUsage {
  return {
    source: "usage",
    cacheRead: 100_000,
    cacheWrite: 5_000,
    cacheWrite1h: undefined,
    costTotalUsd: undefined,
    cacheWriteUsd: undefined,
    entrySeq: 5,
    entriesLength: 6,
    modelId: "claude-x",
    ...overrides,
  };
}

function state(overrides: Partial<AdaptiveState> = {}): AdaptiveState {
  return { ...createInitialAdaptiveState(), ...overrides };
}

/** Warm-window state: last request 60s ago, fresh matching ledger by default. */
function decideInput(overrides: Partial<AdaptiveDecideInput> = {}): AdaptiveDecideInput {
  return {
    now: NOW,
    mode: "adaptive",
    api: "anthropic-messages",
    provider: "anthropic",
    modelId: "claude-x",
    supportsLongCacheRetention: true,
    shape: { ephemeralBreakpoints: 2, ttl1h: false, hasThinking: false, maxTokens: undefined },
    signals: NO_SIGNALS,
    ledger: ledger(),
    config: CONFIG,
    state: state({ lastRequestStartedAt: NOW - 60_000 }),
    ...overrides,
  };
}

/** Apply a decision through noteDecision (what the service does atomically). */
function applyDecision(
  s: AdaptiveState,
  decision: AdaptiveDecision,
  input: { now: number; gapMs?: number; entriesLength?: number; strongSignals?: number } = { now: NOW },
): AdaptiveState {
  return noteDecision(s, decision, {
    now: input.now,
    gapMs: input.gapMs,
    entriesLength: input.entriesLength ?? 6,
    strongSignals: input.strongSignals ?? 0,
  });
}

// ---------------------------------------------------------------------------
// A. Truth table (plan.md §3.6, 18 rows, table-driven)
// ---------------------------------------------------------------------------

interface TruthRow {
  name: string;
  signals?: Partial<AdaptiveSignals>;
  ledger?: Partial<LedgerUsage>;
  state?: Partial<AdaptiveState>;
  config?: Partial<AdaptiveConfig>;
  gapMs?: number; // now − lastRequestStartedAt (60_000 default ⇒ warm window)
  expect: { upgrade: boolean; class?: "warm" | "cold"; reason?: string; signals?: string[] };
}

const TRUTH_TABLE: TruthRow[] = [
  {
    name: "#1 background subagent just dispatched, warm request",
    signals: { subagentRuns: 1, maxSubagentHorizonMs: 30 * 60_000, activeTools: 3 },
    ledger: { cacheWrite: 8_000 },
    expect: { upgrade: true, class: "warm", signals: ["subagent"] },
  },
  {
    name: "#2 same, but the request comes 40min later",
    signals: { subagentRuns: 1, maxSubagentHorizonMs: 30 * 60_000 },
    gapMs: 40 * 60_000,
    expect: { upgrade: true, class: "cold" },
  },
  {
    name: "#3 same, subagent horizon only 3min",
    signals: { subagentRuns: 1, maxSubagentHorizonMs: 3 * 60_000 },
    gapMs: 40 * 60_000,
    expect: { upgrade: false, reason: "cold-signal-too-weak" },
  },
  {
    name: "#4 background bash jobs running, warm",
    signals: { backgroundBashJobs: 2, activeTools: 1 },
    ledger: { cacheWrite: 5_000 },
    expect: { upgrade: true, class: "warm", signals: ["bash-job"] },
  },
  {
    name: "#5 bash job running, request 20min later (cold)",
    signals: { backgroundBashJobs: 1 },
    gapMs: 20 * 60_000,
    expect: { upgrade: true, class: "cold" },
  },
  {
    name: "#6 UI gate open (ask_user waiting), warm",
    signals: { uiPrompts: 1, activeTools: 1 },
    ledger: { cacheWrite: 2_000 },
    expect: { upgrade: true, class: "warm", signals: ["ui-gate"] },
  },
  {
    name: "#7 only fast tools running — excluded from decisions",
    signals: { activeTools: 4 },
    ledger: { cacheWrite: 6_000 },
    expect: { upgrade: false, reason: "no-signal" },
  },
  { name: "#8 nothing at all", ledger: { cacheWrite: 3_000 }, expect: { upgrade: false, reason: "no-signal" } },
  {
    name: "#9 nothing, but the session has seen a long gap (S4 weak)",
    state: { gaps: [400_000] },
    ledger: { cacheWrite: 3_000 },
    expect: { upgrade: true, class: "warm", signals: ["history-gap"] },
  },
  {
    name: "#10 same as #9 but cold — S4 never feeds the cold path",
    state: { gaps: [400_000] },
    gapMs: 20 * 60_000,
    expect: { upgrade: false, reason: "cold-signal-too-weak", signals: ["history-gap"] },
  },
  {
    name: "#11 just compacted (huge measured write), subagent running",
    signals: { subagentRuns: 1, maxSubagentHorizonMs: 30 * 60_000 },
    ledger: { cacheWrite: 120_000 },
    expect: { upgrade: false, reason: "delta-too-large" },
  },
  {
    name: "#12 subagent running, upgraded recently, only 4k written since",
    signals: { subagentRuns: 1, maxSubagentHorizonMs: 30 * 60_000, activeTools: 2 },
    state: { armedEpisode: true, lastUpgradeAt: NOW - 30_000, tokensSinceLast1hWrite: 4_000 },
    ledger: { cacheWrite: 4_000 },
    expect: { upgrade: false, reason: "refresh-throttled" },
  },
  {
    name: "#13 subagent running, 20k written since the last upgrade — refresh the tail",
    signals: { subagentRuns: 1, maxSubagentHorizonMs: 30 * 60_000, activeTools: 2 },
    state: { armedEpisode: true, lastUpgradeAt: NOW - 30_000, tokensSinceLast1hWrite: 20_000 },
    ledger: { cacheWrite: 6_000 },
    expect: { upgrade: true, class: "warm" },
  },
  {
    name: "#14 supportsLongCacheRetention:false refuses even with every signal on",
    signals: {
      subagentRuns: 1,
      maxSubagentHorizonMs: 30 * 60_000,
      backgroundBashJobs: 3,
      uiPrompts: 1,
      activeTools: 5,
    },
    expect: { upgrade: false, reason: "no-1h-support" },
  },
  {
    name: "#15 pi already wrote 1h (PI_CACHE_RETENTION=long)",
    signals: { subagentRuns: 1, maxSubagentHorizonMs: 30 * 60_000 },
    expect: { upgrade: false, reason: "already-1h" },
  },
  {
    name: "#16 session's first request (no ledger) + subagent",
    signals: { subagentRuns: 1, maxSubagentHorizonMs: 30 * 60_000 },
    ledger: { source: "unknown", cacheRead: 0, cacheWrite: 0, entrySeq: -1, entriesLength: 0, modelId: "" },
    state: { lastRequestStartedAt: undefined },
    expect: { upgrade: true, class: "cold" },
  },
  {
    name: "#17 second cold upgrade within the cap",
    signals: { subagentRuns: 1, maxSubagentHorizonMs: 30 * 60_000 },
    gapMs: 15 * 60_000,
    state: { coldUpgradesUsed: 1, lastColdUpgradeAt: NOW - 15 * 60_000 },
    expect: { upgrade: false, reason: "cold-budget" },
  },
  {
    name: "#18 breaker tripped ⇒ permanent refusal",
    signals: { subagentRuns: 1, maxSubagentHorizonMs: 30 * 60_000 },
    state: { breaker: { reason: "warm-miss", at: NOW - 1000 } },
    expect: { upgrade: false, reason: "breaker" },
  },
];

describe("decideAdaptiveTtl truth table (plan.md §3.6)", () => {
  it.each(TRUTH_TABLE)("$name", (row) => {
    const gapMs = row.gapMs ?? 60_000;
    const input = decideInput({
      signals: signals(row.signals),
      ledger: ledger(row.ledger),
      state: state({ lastRequestStartedAt: NOW - gapMs, ...row.state }),
      config: { ...CONFIG, ...row.config },
      ...(row.name.startsWith("#14") ? { supportsLongCacheRetention: false } : {}),
      ...(row.name.startsWith("#15")
        ? { shape: { ephemeralBreakpoints: 2, ttl1h: true, hasThinking: false, maxTokens: undefined } }
        : {}),
    });
    const decision = decideAdaptiveTtl(input);
    expect(decision.upgrade).toBe(row.expect.upgrade);
    if (row.expect.class !== undefined) expect(decision.class).toBe(row.expect.class);
    if (row.expect.reason !== undefined) expect(decision.reason).toBe(row.expect.reason);
    if (row.expect.signals !== undefined) expect(decision.signals).toEqual(row.expect.signals);
  });
});

// ---------------------------------------------------------------------------
// B. Group-A capability gates
// ---------------------------------------------------------------------------

describe("decideAdaptiveTtl capability gates", () => {
  const warmStrong = signals({ subagentRuns: 1, maxSubagentHorizonMs: 30 * 60_000 });
  it("mode !== adaptive ⇒ mode", () => {
    expect(decideAdaptiveTtl(decideInput({ mode: "auto", signals: warmStrong })).reason).toBe("mode");
  });
  it("non-anthropic api ⇒ not-anthropic", () => {
    expect(decideAdaptiveTtl(decideInput({ api: "openai-completions", signals: warmStrong })).reason).toBe(
      "not-anthropic",
    );
  });
  it("per-request-billed provider (github-copilot) ⇒ not-anthropic", () => {
    expect(decideAdaptiveTtl(decideInput({ provider: "github-copilot", signals: warmStrong })).reason).toBe(
      "not-anthropic",
    );
  });
  it("no ephemeral breakpoints ⇒ no-cache-control", () => {
    const shape = { ephemeralBreakpoints: 0, ttl1h: false, hasThinking: false, maxTokens: undefined };
    expect(decideAdaptiveTtl(decideInput({ shape, signals: warmStrong })).reason).toBe("no-cache-control");
  });
  it("write budget exhausted ⇒ write-budget (W=0 is the rollback switch)", () => {
    expect(
      decideAdaptiveTtl(decideInput({ signals: warmStrong, config: { ...CONFIG, writeBudgetTokens: 0 } })).reason,
    ).toBe("write-budget");
  });
  it("USD budget exhausted alone ⇒ write-budget even with tokens to spare (primary gate)", () => {
    const d = decideAdaptiveTtl(
      decideInput({
        signals: warmStrong,
        config: { ...CONFIG, writeBudgetUsd: 0.5 },
        state: state({ lastRequestStartedAt: NOW - 60_000, upgradeWriteTokens: 10_000, upgradeWriteUsd: 0.5 }),
      }),
    );
    expect(d.reason).toBe("write-budget");
  });
  it("writeBudgetUsd = 0 keeps deciding while upgradeWriteUsd is far beyond any cap (gate off)", () => {
    const d = decideAdaptiveTtl(
      decideInput({
        signals: warmStrong,
        config: { ...CONFIG, writeBudgetUsd: 0 },
        state: state({ lastRequestStartedAt: NOW - 60_000, upgradeWriteUsd: 999 }),
      }),
    );
    expect(d.upgrade).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C. warm/cold boundaries
// ---------------------------------------------------------------------------

describe("decideAdaptiveTtl warm/cold judgement", () => {
  const strong = signals({ subagentRuns: 1, maxSubagentHorizonMs: 30 * 60_000 });
  it("ledger source unknown ⇒ cold", () => {
    const d = decideAdaptiveTtl(
      decideInput({
        signals: strong,
        ledger: ledger({ source: "unknown", cacheRead: 0, cacheWrite: 0, entrySeq: -1, entriesLength: 0, modelId: "" }),
      }),
    );
    expect(d.class).toBe("cold");
  });
  it("cacheRead = 0 ⇒ cold", () => {
    expect(decideAdaptiveTtl(decideInput({ signals: strong, ledger: ledger({ cacheRead: 0 }) })).class).toBe("cold");
  });
  it("260s since the last request (> 300−45=255s) ⇒ cold (boundary)", () => {
    const d = decideAdaptiveTtl(
      decideInput({ signals: strong, state: state({ lastRequestStartedAt: NOW - 260_000 }) }),
    );
    expect(d.class).toBe("cold");
  });
  it("254s ⇒ warm (boundary)", () => {
    const d = decideAdaptiveTtl(
      decideInput({ signals: strong, state: state({ lastRequestStartedAt: NOW - 254_000 }) }),
    );
    expect(d.class).toBe("warm");
  });
});

// ---------------------------------------------------------------------------
// E. cold-path caps / cooldown / horizon
// ---------------------------------------------------------------------------

describe("decideAdaptiveTtl cold path", () => {
  const coldState = state({ lastRequestStartedAt: NOW - 20 * 60_000 });
  it("coldUpgrades=0 ⇒ cold-budget", () => {
    const d = decideAdaptiveTtl(
      decideInput({
        signals: signals({ backgroundBashJobs: 1 }),
        state: coldState,
        config: { ...CONFIG, coldUpgrades: 0 },
      }),
    );
    expect(d.reason).toBe("cold-budget");
  });
  it("within the cooldown ⇒ cold-cooldown", () => {
    const d = decideAdaptiveTtl(
      decideInput({
        signals: signals({ backgroundBashJobs: 1 }),
        state: state({ ...coldState, coldUpgradesUsed: 0, lastColdUpgradeAt: NOW - 5 * 60_000 }),
      }),
    );
    expect(d.reason).toBe("cold-cooldown");
  });
  it("subagent horizon below coldMinHorizonMs and no other strong signal ⇒ cold-signal-too-weak", () => {
    const d = decideAdaptiveTtl(
      decideInput({ signals: signals({ subagentRuns: 1, maxSubagentHorizonMs: 60_000 }), state: coldState }),
    );
    expect(d.reason).toBe("cold-signal-too-weak");
  });
  it("same but a bash job is also running ⇒ cold upgrade (S2 needs no horizon)", () => {
    const d = decideAdaptiveTtl(
      decideInput({
        signals: signals({ subagentRuns: 1, maxSubagentHorizonMs: 60_000, backgroundBashJobs: 1 }),
        state: coldState,
      }),
    );
    expect(d.upgrade).toBe(true);
    expect(d.class).toBe("cold");
  });
});

// ---------------------------------------------------------------------------
// M1. Ledger anchoring (review M1 regression)
// ---------------------------------------------------------------------------

describe("M1: ledger anchoring against compaction / model switch", () => {
  const strong = signals({ subagentRuns: 1, maxSubagentHorizonMs: 30 * 60_000 });

  it("a stale pre-compaction ledger (entrySeq ≤ lastInvalidateSeq) is judged COLD, never warm", () => {
    // Compact appended an entry: invalidateAdaptive raised the high-water mark to 5,
    // but the ledger still points at the pre-compact assistant entry (index 5).
    const s = invalidateAdaptive(state({ lastRequestStartedAt: NOW - 60_000 }), "session-compact", 6);
    const d = decideAdaptiveTtl(
      decideInput({ signals: strong, ledger: ledger({ cacheRead: 100_000, cacheWrite: 500, entrySeq: 5 }), state: s }),
    );
    expect(d.upgrade).toBe(true);
    expect(d.class).toBe("cold"); // strong signal still earns ONE cold upgrade — semantically correct
  });

  it("the reconcile after a stale-judged cold upgrade never runs the warm probes ⇒ no breaker trip", () => {
    let s = invalidateAdaptive(state({ lastRequestStartedAt: NOW - 60_000 }), "session-compact", 6);
    const d = decideAdaptiveTtl(decideInput({ signals: strong, ledger: ledger({ entrySeq: 5 }), state: s }));
    s = applyDecision(s, d, { now: NOW, gapMs: 60_000, entriesLength: 6, strongSignals: 1 });
    // The post-compact request actually rewrote a huge partially-hit prefix (50k+).
    const after = onLedgerObserved(
      s,
      ledger({ entrySeq: 6, entriesLength: 7, cacheRead: 30_000, cacheWrite: 55_000 }),
      NOW + 5_000,
      CONFIG,
    );
    expect(after.breaker).toBeUndefined();
    // Uncovered ⇒ the rewrite is the entry fee, booked to the fee budget (plan.md §16.3).
    expect(after.feeWriteTokens).toBe(55_000);
    expect(after.upgradeWriteTokens).toBe(0);
    expect(after.unconfirmed1hWrites).toBe(1);
  });

  it("a ledger from a different model (post model switch) is judged cold", () => {
    const d = decideAdaptiveTtl(decideInput({ signals: strong, ledger: ledger({ modelId: "claude-other" }) }));
    expect(d.class).toBe("cold");
  });

  it("a fresh ledger (entrySeq > lastInvalidateSeq, model matches) is warm again", () => {
    const s = invalidateAdaptive(state({ lastRequestStartedAt: NOW - 60_000 }), "session-compact", 6);
    const d = decideAdaptiveTtl(
      decideInput({ signals: strong, ledger: ledger({ entrySeq: 7, entriesLength: 8 }), state: s }),
    );
    expect(d.class).toBe("warm");
  });

  it("invalidate clears pending (pre-booked) and cover, keeps budget and breaker", () => {
    let s = state({ lastRequestStartedAt: NOW - 60_000 });
    const d = decideAdaptiveTtl(decideInput({ signals: strong, state: s }));
    s = applyDecision(s, d, { now: NOW, gapMs: 60_000, entriesLength: 6, strongSignals: 1 });
    expect(s.pending).toBeDefined();
    expect(s.oneHourCoverUntil).toBeDefined();
    s = { ...s, breaker: { reason: "warm-miss", at: NOW } };
    const after = invalidateAdaptive(s, "model-select", 9);
    expect(after.pending).toBeUndefined();
    expect(after.oneHourCoverUntil).toBeUndefined();
    expect(after.droppedPending).toBe(1);
    expect(after.feeWriteTokens).toBe(5_000); // m1 pre-book, on the fee side (the dropped upgrade was uncovered)
    expect(after.upgradeWriteTokens).toBe(0);
    expect(after.breaker?.reason).toBe("warm-miss"); // breaker survives
    expect(after.lastInvalidateSeq).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// F. Probes / breaker reducers (incl. M2 composite predicate)
// ---------------------------------------------------------------------------

/** Steady-state (1h→1h) warm pending: the prefix is already 1h-backed, so the probes apply. */
function warmPendingState(predictedDeltaTokens = 5_000): AdaptiveState {
  return state({
    lastRequestStartedAt: NOW,
    pending: { requestSeq: 1, minEntrySeq: 6, at: NOW, class: "warm", predictedDeltaTokens, covered1h: true },
    oneHourCoverUntil: NOW + 3_600_000,
    lastUpgradeAt: NOW,
  });
}

/** Entry-fee (uncovered 5m→1h transition) warm pending — the shape every session starts with. */
function feePendingState(predictedDeltaTokens = 5_000): AdaptiveState {
  return state({
    lastRequestStartedAt: NOW,
    pending: { requestSeq: 1, minEntrySeq: 6, at: NOW, class: "warm", predictedDeltaTokens, covered1h: false },
    oneHourCoverUntil: NOW + 3_600_000,
    lastUpgradeAt: NOW,
  });
}

describe("onLedgerObserved probes and breaker", () => {
  it("write beyond max(3×Δ̂, 64k) on a warm probe ⇒ warm-write-too-expensive", () => {
    const after = onLedgerObserved(
      warmPendingState(5_000),
      ledger({ entrySeq: 6, cacheRead: 100_000, cacheWrite: 80_000 }),
      NOW + 5_000,
      CONFIG,
    );
    expect(after.breaker?.reason).toBe("warm-write-too-expensive");
    expect(after.pending).toBeUndefined();
    expect(after.upgradeWriteTokens).toBe(80_000);
  });

  it("M2 regression: a small-prefix session (A=40k) with a legitimate max-size increment (32k) does NOT trip", () => {
    const after = onLedgerObserved(
      warmPendingState(32_000),
      ledger({ entrySeq: 6, cacheRead: 40_000, cacheWrite: 32_000 }),
      NOW + 5_000,
      CONFIG,
    );
    // The retired ratio predicate (44% > 25%) would have tripped here; the composite one must not.
    expect(after.breaker).toBeUndefined();
  });

  it("M2: the absolute floor catches a structural violation even when Δ̂ was underestimated", () => {
    const after = onLedgerObserved(
      warmPendingState(500), // predicted 500, actual 70k > max(1.5k, 64k)
      ledger({ entrySeq: 6, cacheRead: 400_000, cacheWrite: 70_000 }),
      NOW + 5_000,
      CONFIG,
    );
    expect(after.breaker?.reason).toBe("warm-write-too-expensive");
  });

  it("prefix-scaled floor: P≈43k full-prefix rewrite TRIPS (the fixed 64k floor could never see it)", () => {
    const after = onLedgerObserved(
      warmPendingState(4_000),
      ledger({ entrySeq: 6, cacheRead: 5_000, cacheWrite: 38_000 }), // P = 43k
      NOW + 5_000,
      CONFIG,
    );
    // old predicate: 38k > max(3×4k, 64k) = false ⇒ silent burn until the budget;
    // new floor = min(64k, max(4k, 0.5×43k)) = 21.5k ⇒ 38k > max(12k, 21.5k) trips.
    expect(after.breaker?.reason).toBe("warm-write-too-expensive");
  });

  it("prefix-scaled floor: P=300k normal increment does NOT trip — identical to the fixed floor", () => {
    const after = onLedgerObserved(
      warmPendingState(8_000),
      ledger({ entrySeq: 6, cacheRead: 290_000, cacheWrite: 10_000 }), // P = 300k ⇒ floor 64k
      NOW + 5_000,
      CONFIG,
    );
    expect(after.breaker).toBeUndefined();
  });

  it("prefix-scaled floor: P ≥ 128k keeps the fixed 64k floor byte-identically (0.5P ≥ 64k clamps back)", () => {
    const trips = onLedgerObserved(
      warmPendingState(500),
      ledger({ entrySeq: 6, cacheRead: 100_000, cacheWrite: 65_000 }), // P = 165k ⇒ floor 64k
      NOW + 5_000,
      CONFIG,
    );
    expect(trips.breaker?.reason).toBe("warm-write-too-expensive");
    const noTrip = onLedgerObserved(
      warmPendingState(500),
      ledger({ entrySeq: 6, cacheRead: 100_000, cacheWrite: 63_999 }),
      NOW + 5_000,
      CONFIG,
    );
    expect(noTrip.breaker).toBeUndefined();
  });

  it("prefix-scaled floor: tiny P is protected by the 4k hard minimum", () => {
    const after = onLedgerObserved(
      warmPendingState(500),
      ledger({ entrySeq: 6, cacheRead: 1_000, cacheWrite: 2_500 }), // P = 3.5k ⇒ 0.5P = 1.75k < 4k
      NOW + 5_000,
      CONFIG,
    );
    // without the 4k minimum, 2.5k > max(1.5k, 1.75k) would false-trip an ordinary increment
    expect(after.breaker).toBeUndefined();
  });

  it("warm probe with cacheRead=0 ⇒ warm-miss (steady state only)", () => {
    const after = onLedgerObserved(
      warmPendingState(),
      ledger({ entrySeq: 6, cacheRead: 0, cacheWrite: 30_000 }),
      NOW + 5_000,
      CONFIG,
    );
    expect(after.breaker?.reason).toBe("warm-miss");
  });

  // -------------------------------------------------------------------------
  // Entry fee (plan.md §16.3) — field-evidence regressions. Numbers taken from a
  // real audit trail: warm pending Δ̂=966 settling as read=0 / write=83139 /
  // cacheWrite1h=83139 (the upstream honored ttl:1h and rewrote the prefix).
  // -------------------------------------------------------------------------

  it("entry fee: an UNCOVERED warm settlement with cacheRead=0 and a full rewrite does NOT trip", () => {
    const after = onLedgerObserved(
      feePendingState(966),
      ledger({ entrySeq: 6, cacheRead: 0, cacheWrite: 83_139, cacheWrite1h: 83_139, cacheWriteUsd: 0.83139 }),
      NOW + 5_000,
      CONFIG,
    );
    expect(after.breaker).toBeUndefined();
    expect(after.feeUpgrades).toBe(1);
    expect(after.feeWriteTokens).toBe(83_139);
    expect(after.feeWriteUsd).toBeCloseTo(0.95 * 0.83139, 10);
    // The marginal budget is untouched — that is what keeps `write-budget` from
    // firing on the very first upgrade of a large-prefix session.
    expect(after.upgradeWriteTokens).toBe(0);
    expect(after.upgradeWriteUsd).toBe(0);
    expect(after.confirmed1hWrites).toBe(1);
  });

  it("entry fee: the same shape one upgrade later (COVERED) still trips — the probe is deferred, not removed", () => {
    const after = onLedgerObserved(
      warmPendingState(966),
      ledger({ entrySeq: 6, cacheRead: 0, cacheWrite: 83_139, cacheWrite1h: 83_139 }),
      NOW + 5_000,
      CONFIG,
    );
    expect(after.breaker?.reason).toBe("warm-miss");
  });

  it("entry fee: a 265k transition no longer trips write-budget (W=200k) on its own settlement", () => {
    const after = onLedgerObserved(
      feePendingState(4_712),
      ledger({ entrySeq: 6, cacheRead: 0, cacheWrite: 265_875, cacheWrite1h: 265_875, cacheWriteUsd: 2.65875 }),
      NOW + 5_000,
      CONFIG,
    );
    expect(after.breaker).toBeUndefined();
    expect(after.feeWriteTokens).toBe(265_875);
  });

  it("entry fee: once the fee budget is gone a NEW prefix is refused, steady state still upgrades", () => {
    const spent = state({
      lastRequestStartedAt: NOW - 60_000,
      feeWriteTokens: 700_000,
      feeUpgrades: 2,
    });
    const refused = decideAdaptiveTtl(
      decideInput({ signals: signals({ subagentRuns: 1, maxSubagentHorizonMs: 30 * 60_000 }), state: spent }),
    );
    expect(refused.upgrade).toBe(false);
    expect(refused.reason).toBe("fee-budget");

    const covered = decideAdaptiveTtl(
      decideInput({
        signals: signals({ subagentRuns: 1, maxSubagentHorizonMs: 30 * 60_000 }),
        state: { ...spent, oneHourCoverUntil: NOW + 1_800_000, confirmed1hWrites: 1 },
      }),
    );
    expect(covered.upgrade).toBe(true);
    expect(covered.class).toBe("warm");
  });

  it("entry fee: a short-horizon signal with no long-gap history cannot open a prefix", () => {
    const d = decideAdaptiveTtl(
      decideInput({ signals: signals({ subagentRuns: 1, maxSubagentHorizonMs: 90_000 }) }), // 90s ≪ coldMinHorizon
    );
    expect(d.upgrade).toBe(false);
    expect(d.reason).toBe("fee-horizon-too-short");
    // ...but the same signal upgrades freely once the prefix is already 1h-backed.
    const covered = decideAdaptiveTtl(
      decideInput({
        signals: signals({ subagentRuns: 1, maxSubagentHorizonMs: 90_000 }),
        state: state({
          lastRequestStartedAt: NOW - 60_000,
          oneHourCoverUntil: NOW + 1_800_000,
          confirmed1hWrites: 1,
        }),
      }),
    );
    expect(covered.upgrade).toBe(true);
  });

  it("entry fee: full session arc — pay once, then three cheap steady-state upgrades, no breaker", () => {
    // Reproduces the one audited session that survived (its first upgrade was a
    // cold one, which the old code never probed) — now the warm path behaves the same.
    let s = state({ lastRequestStartedAt: NOW - 60_000 });
    const strong = signals({ subagentRuns: 1, maxSubagentHorizonMs: 4 * 3_600_000 });
    let seq = 6;
    let now = NOW;

    const fee = decideAdaptiveTtl(decideInput({ now, signals: strong, state: s, ledger: ledger({ entrySeq: seq }) }));
    expect(fee.upgrade).toBe(true);
    s = noteDecision(s, fee, { now, gapMs: 60_000, entriesLength: seq, strongSignals: 1 });
    expect(s.pending?.covered1h).toBe(false);
    s = onLedgerObserved(
      s,
      ledger({ entrySeq: seq, cacheRead: 0, cacheWrite: 174_109, cacheWrite1h: 174_109 }),
      now,
      CONFIG,
    );
    expect(s.breaker).toBeUndefined();

    for (const [read, write] of [
      [185_040, 3_334],
      [208_214, 268],
      [225_049, 897],
    ] as const) {
      now += 120_000;
      seq += 1;
      s = { ...s, tokensSinceLast1hWrite: 20_000 }; // past the refresh throttle
      const d = decideAdaptiveTtl(
        decideInput({
          now,
          signals: strong,
          state: { ...s, lastRequestStartedAt: now - 60_000 },
          ledger: ledger({ entrySeq: seq, cacheRead: read, cacheWrite: write }),
        }),
      );
      expect(d.upgrade).toBe(true);
      expect(d.class).toBe("warm");
      s = noteDecision(s, d, { now, gapMs: 60_000, entriesLength: seq, strongSignals: 1 });
      expect(s.pending?.covered1h).toBe(true); // steady state from here on
      s = onLedgerObserved(s, ledger({ entrySeq: seq, cacheRead: read, cacheWrite: write }), now, CONFIG);
      expect(s.breaker).toBeUndefined();
    }
    expect(s.feeUpgrades).toBe(1);
    expect(s.upgradeWriteTokens).toBe(3_334 + 268 + 897); // only increments hit the marginal budget
  });

  it("cold probes never run the warm checks (M1 companion)", () => {
    const s = state({
      pending: {
        requestSeq: 1,
        minEntrySeq: 6,
        at: NOW,
        class: "cold",
        predictedDeltaTokens: 410_000,
        covered1h: true,
      },
    });
    const after = onLedgerObserved(s, ledger({ entrySeq: 6, cacheRead: 0, cacheWrite: 400_000 }), NOW + 5_000, {
      ...CONFIG,
      writeBudgetTokens: 1_000_000,
    });
    expect(after.breaker).toBeUndefined();
  });

  it("1h cover + >5min gap + hit ⇒ indirect1hConfirms (no trip)", () => {
    const s = state({
      lastGapMs: 400_000,
      oneHourCoverUntil: NOW + 3_000_000,
      lastReconciledEntrySeq: 5,
    });
    const after = onLedgerObserved(
      s,
      ledger({ entrySeq: 6, cacheRead: 50_000, cacheWrite: 1_000 }),
      NOW + 10_000,
      CONFIG,
    );
    expect(after.indirect1hConfirms).toBe(1);
    expect(after.breaker).toBeUndefined();
  });

  it("1h cover + >5min gap + miss ⇒ ineffective1h + 1h-ineffective trip", () => {
    const s = state({ lastGapMs: 400_000, oneHourCoverUntil: NOW + 3_000_000 });
    const after = onLedgerObserved(s, ledger({ entrySeq: 6, cacheRead: 0, cacheWrite: 400_000 }), NOW + 10_000, CONFIG);
    expect(after.ineffective1h).toBe(1);
    expect(after.breaker?.reason).toBe("1h-ineffective");
  });

  it("cacheWrite1h>0 ⇒ confirmed; ==0 with cacheWrite>0 ⇒ unconfirmed", () => {
    const confirmed = onLedgerObserved(
      warmPendingState(),
      ledger({ entrySeq: 6, cacheWrite: 5_000, cacheWrite1h: 5_000 }),
      NOW + 5_000,
      CONFIG,
    );
    expect(confirmed.confirmed1hWrites).toBe(1);
    expect(confirmed.unconfirmed1hWrites).toBe(0);
    const unconfirmed = onLedgerObserved(
      warmPendingState(),
      ledger({ entrySeq: 6, cacheWrite: 5_000, cacheWrite1h: 0 }),
      NOW + 5_000,
      CONFIG,
    );
    expect(unconfirmed.unconfirmed1hWrites).toBe(1);
    expect(unconfirmed.confirmed1hWrites).toBe(0);
  });

  it("budget exhaustion trips write-budget and the next decide refuses with write-budget", () => {
    const s = warmPendingState();
    const after = onLedgerObserved(
      { ...s, upgradeWriteTokens: 190_000 },
      ledger({ entrySeq: 6, cacheWrite: 15_000 }),
      NOW + 5_000,
      CONFIG,
    );
    expect(after.breaker?.reason).toBe("write-budget");
    const d = decideAdaptiveTtl(decideInput({ signals: signals({ subagentRuns: 1 }), state: after }));
    expect(d.reason).toBe("breaker"); // breaker gate fires first (session-permanent)
  });

  it("USD gate: the USD budget trips write-budget before the token budget is anywhere near exhausted", () => {
    const after = onLedgerObserved(
      warmPendingState(5_000),
      ledger({ entrySeq: 6, cacheWrite: 5_000, cacheWriteUsd: 1.6 }),
      NOW + 5_000,
      { ...CONFIG, writeBudgetUsd: 0.5 },
    );
    expect(after.breaker?.reason).toBe("write-budget");
    expect(after.upgradeWriteTokens).toBe(5_000); // tokens are at 2.5% — USD fired first
    expect(after.upgradeWriteUsd).toBeCloseTo(0.6, 10); // MARGINAL_WRITE_FRACTION 0.375 × 1.6
  });

  it("USD gate: cacheWriteUsd missing ⇒ pure token judgement, cost is never guessed", () => {
    const after = onLedgerObserved(
      { ...warmPendingState(), upgradeWriteTokens: 190_000 },
      ledger({ entrySeq: 6, cacheWrite: 15_000, cacheWriteUsd: undefined }),
      NOW + 5_000,
      { ...CONFIG, writeBudgetUsd: 0.01 }, // would trip instantly if 0 were guessed as a cost
    );
    expect(after.upgradeWriteUsd).toBe(0);
    expect(after.breaker?.reason).toBe("write-budget"); // still bounded — via the token fallback (205k ≥ 200k)
  });

  it("USD gate: writeBudgetUsd = 0 disables the trip while still tracking the accrual", () => {
    const after = onLedgerObserved(
      warmPendingState(5_000),
      ledger({ entrySeq: 6, cacheWrite: 5_000, cacheWriteUsd: 5 }),
      NOW + 5_000,
      { ...CONFIG, writeBudgetUsd: 0 },
    );
    expect(after.breaker).toBeUndefined();
    expect(after.upgradeWriteUsd).toBeCloseTo(1.875, 10); // observable in /cache-ttl status
  });

  it("m1: a pending dropped after ADAPTIVE_PENDING_TTL_MS pre-books predictedDeltaTokens into the budget", () => {
    const s = warmPendingState(20_000);
    const after = onLedgerObserved(
      s,
      ledger({ source: "unknown", entrySeq: -1, entriesLength: 0, cacheRead: 0, cacheWrite: 0, modelId: "" }),
      NOW + ADAPTIVE_PENDING_TTL_MS + 1,
      CONFIG,
    );
    expect(after.pending).toBeUndefined();
    expect(after.droppedPending).toBe(1);
    expect(after.upgradeWriteTokens).toBe(20_000); // the ≤0.75×(W+P)×R bound covers this path now
  });

  it("a stale ledger (entrySeq < pending.minEntrySeq) never settles the pending", () => {
    const s = warmPendingState();
    const after = onLedgerObserved(s, ledger({ entrySeq: 4, cacheWrite: 999_999 }), NOW + 5_000, CONFIG);
    expect(after.pending).toBeDefined();
    expect(after.upgradeWriteTokens).toBe(0);
  });

  it("m2: the same ledger observed twice (message_end + turn_end) is accounted exactly once", () => {
    const s = warmPendingState(5_000);
    const l = ledger({ entrySeq: 6, cacheWrite: 5_000, cacheWrite1h: 5_000 });
    const once = onLedgerObserved(s, l, NOW + 5_000, CONFIG);
    const twice = onLedgerObserved(once, l, NOW + 6_000, CONFIG);
    expect(twice).toBe(once); // same reference — pure no-op
    expect(twice.upgradeWriteTokens).toBe(5_000);
    expect(twice.confirmed1hWrites).toBe(1);
    expect(twice.tokensSinceLast1hWrite).toBe(5_000);
  });

  it("breaker is permanent: no further upgrades after a trip", () => {
    const s = state({ breaker: { reason: "warm-write-too-expensive", at: NOW }, lastRequestStartedAt: NOW - 60_000 });
    const d = decideAdaptiveTtl(
      decideInput({ signals: signals({ subagentRuns: 1, backgroundBashJobs: 1 }), state: s }),
    );
    expect(d.upgrade).toBe(false);
    expect(d.reason).toBe("breaker");
  });

  it("reducer invariance: a no-op observation returns the same reference", () => {
    const s = state();
    expect(
      onLedgerObserved(
        s,
        ledger({ source: "unknown", entrySeq: -1, entriesLength: 0, cacheRead: 0, cacheWrite: 0, modelId: "" }),
        NOW,
        CONFIG,
      ),
    ).toBe(s);
    expect(endArmedEpisode(s)).toBe(s);
    const changed = endArmedEpisode({ ...s, armedEpisode: true });
    expect(changed).not.toBe(s);
    expect(changed.armedEpisode).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G. gap ring / S4
// ---------------------------------------------------------------------------

describe("gap ring and the S4 weak signal", () => {
  it("keeps only the most recent ADAPTIVE_GAP_RING_SIZE gaps", () => {
    let s = state();
    for (let i = 1; i <= ADAPTIVE_GAP_RING_SIZE + 1; i += 1) {
      s = applyDecision(
        s,
        { upgrade: false, class: undefined, reason: "no-signal", signals: [], predictedDeltaTokens: 0, at: i },
        { now: i, gapMs: 1_000 },
      );
    }
    expect(s.gaps.length).toBe(ADAPTIVE_GAP_RING_SIZE);
  });

  it("longGapCount counts only gaps > ASSUMED_TTL_MS", () => {
    const s = state({ gaps: [1_000, ASSUMED_TTL_MS + 1, ASSUMED_TTL_MS, 500_000] });
    expect(buildAdaptiveSnapshot(s, CONFIG, NOW).longGapCount).toBe(2);
  });

  it("historyGapSignal=false disables S4", () => {
    const d = decideAdaptiveTtl(
      decideInput({
        state: state({ gaps: [400_000], lastRequestStartedAt: NOW - 60_000 }),
        config: { ...CONFIG, historyGapSignal: false },
      }),
    );
    expect(d.reason).toBe("no-signal");
  });

  it("m5: S4-only is throttle-bound once the session has upgraded before", () => {
    const d = decideAdaptiveTtl(
      decideInput({
        state: state({
          gaps: [400_000],
          lastRequestStartedAt: NOW - 60_000,
          lastUpgradeAt: NOW - 30_000,
          tokensSinceLast1hWrite: 4_000,
        }),
      }),
    );
    expect(d.reason).toBe("refresh-throttled");
  });

  it("noteDecision opens an armed episode on strong signals and records the gap ring", () => {
    const d = decideAdaptiveTtl(
      decideInput({ signals: signals({ subagentRuns: 1 }), state: state({ lastRequestStartedAt: NOW - 60_000 }) }),
    );
    expect(d.upgrade).toBe(true);
    const s = applyDecision(state({ lastRequestStartedAt: NOW - 60_000 }), d, {
      now: NOW,
      gapMs: 60_000,
      entriesLength: 6,
      strongSignals: 1,
    });
    expect(s.armedEpisode).toBe(true);
    expect(s.gaps).toEqual([60_000]);
    expect(s.pending).toMatchObject({ class: "warm", predictedDeltaTokens: 5_000, minEntrySeq: 6 });
    expect(s.warmUpgrades).toBe(1);
    expect(s.oneHourCoverUntil).toBe(NOW + 3_600_000);
  });
});

// ---------------------------------------------------------------------------
// H. snapshot
// ---------------------------------------------------------------------------

describe("buildAdaptiveSnapshot", () => {
  it("covers idle / upgraded-cover / budget-warn / breaker shapes", () => {
    const idle = buildAdaptiveSnapshot(state(), CONFIG, NOW);
    expect(idle.coverRemainingMs).toBeUndefined();
    expect(idle.breaker).toBeUndefined();
    expect(idle.budgetFraction).toBe(0);

    const cover = buildAdaptiveSnapshot(state({ oneHourCoverUntil: NOW + 2_220_000 }), CONFIG, NOW);
    expect(cover.coverRemainingMs).toBe(2_220_000);

    const budget = buildAdaptiveSnapshot(state({ upgradeWriteTokens: 180_000, upgradeWriteUsd: 0.9 }), CONFIG, NOW);
    expect(budget.budgetFraction).toBeCloseTo(0.9);
    expect(budget.writeBudgetTokens).toBe(200_000);
    expect(budget.upgradeWriteUsd).toBeCloseTo(0.9);
    expect(budget.writeBudgetUsd).toBe(1);
    expect(budget.usdFraction).toBeCloseTo(0.9);
    // USD gate off ⇒ the fraction is meaningless and reports 0 (the segment logic skips it).
    const usdOff = buildAdaptiveSnapshot(state({ upgradeWriteUsd: 1.875 }), { ...CONFIG, writeBudgetUsd: 0 }, NOW);
    expect(usdOff.usdFraction).toBe(0);
    expect(usdOff.writeBudgetUsd).toBe(0);
    expect(usdOff.upgradeWriteUsd).toBeCloseTo(1.875, 10);

    const tripped = buildAdaptiveSnapshot(state({ breaker: { reason: "1h-ineffective", at: NOW } }), CONFIG, NOW);
    expect(tripped.breaker?.reason).toBe("1h-ineffective");

    const cooldown = buildAdaptiveSnapshot(state({ lastColdUpgradeAt: NOW - 600_000 }), CONFIG, NOW);
    expect(cooldown.coldCooldownRemainingMs).toBe(600_000);
  });
});
