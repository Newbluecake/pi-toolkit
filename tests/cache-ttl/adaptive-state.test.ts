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
  maxDeltaTokens: 32_000,
  refreshAfterTokens: 16_000,
  coldUpgrades: 1,
  coldCooldownMs: 1_200_000,
  coldMinHorizonMs: 600_000,
  historyGapSignal: true,
  probeWriteFactor: 3,
  probeWriteFloorTokens: 64_000,
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
    expect(after.upgradeWriteTokens).toBe(55_000);
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
    expect(after.upgradeWriteTokens).toBe(5_000); // m1 pre-booked predictedDeltaTokens
    expect(after.breaker?.reason).toBe("warm-miss"); // breaker survives
    expect(after.lastInvalidateSeq).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// F. Probes / breaker reducers (incl. M2 composite predicate)
// ---------------------------------------------------------------------------

function warmPendingState(predictedDeltaTokens = 5_000): AdaptiveState {
  return state({
    lastRequestStartedAt: NOW,
    pending: { requestSeq: 1, minEntrySeq: 6, at: NOW, class: "warm", predictedDeltaTokens },
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

  it("warm probe with cacheRead=0 ⇒ warm-miss", () => {
    const after = onLedgerObserved(
      warmPendingState(),
      ledger({ entrySeq: 6, cacheRead: 0, cacheWrite: 30_000 }),
      NOW + 5_000,
      CONFIG,
    );
    expect(after.breaker?.reason).toBe("warm-miss");
  });

  it("cold probes never run the warm checks (M1 companion)", () => {
    const s = state({
      pending: { requestSeq: 1, minEntrySeq: 6, at: NOW, class: "cold", predictedDeltaTokens: 410_000 },
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

    const budget = buildAdaptiveSnapshot(state({ upgradeWriteTokens: 180_000 }), CONFIG, NOW);
    expect(budget.budgetFraction).toBeCloseTo(0.9);
    expect(budget.writeBudgetTokens).toBe(200_000);

    const tripped = buildAdaptiveSnapshot(state({ breaker: { reason: "1h-ineffective", at: NOW } }), CONFIG, NOW);
    expect(tripped.breaker?.reason).toBe("1h-ineffective");

    const cooldown = buildAdaptiveSnapshot(state({ lastColdUpgradeAt: NOW - 600_000 }), CONFIG, NOW);
    expect(cooldown.coldCooldownRemainingMs).toBe(600_000);
  });
});
