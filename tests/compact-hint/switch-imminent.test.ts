import { describe, expect, it } from "vitest";
import { isSwitchImminent, SWITCH_IMMINENT_MARGIN_PERCENT } from "../../src/compact-hint/threshold.js";
import { createCompactHintHook, isSwitchImminentNow, type CompactHintState, type Stack } from "../../src/stack.js";
import {
  createInitialAdaptiveState,
  decideAdaptiveTtl,
  onLedgerObserved,
  type AdaptiveConfig,
  type AdaptiveDecideInput,
  type AdaptiveSignals,
} from "../../src/cache-ttl/adaptive.js";
import { consumeUpgrade, createInitialWindowState, type WindowState } from "../../src/cache-ttl/keepalive-state.js";
import type { LedgerUsage } from "../../src/cache-ttl/usage-ledger.js";

/**
 * task #14: compact-hint tells the cache-ttl layer when the current prefix is about to be
 * discarded by a context switch, so it stops buying 1h cover (an entry fee rewrites the whole
 * prefix at 2x input price) for a prefix switch_context throws away next.
 */

describe("isSwitchImminent", () => {
  it("fires within the margin of the earliest active line", () => {
    expect(SWITCH_IMMINENT_MARGIN_PERCENT).toBe(5);
    expect(isSwitchImminent(44, 50, 88)).toBe(false);
    expect(isSwitchImminent(45, 50, 88)).toBe(true);
    expect(isSwitchImminent(60, 50, 88)).toBe(true);
  });

  it("uses the force line when the hint line is off, and the earlier of the two otherwise", () => {
    expect(isSwitchImminent(82, 0, 88)).toBe(false);
    expect(isSwitchImminent(83, 0, 88)).toBe(true);
    expect(isSwitchImminent(36, 91, 40)).toBe(true);
  });

  it("is false with every line off or a non-finite percent", () => {
    expect(isSwitchImminent(99, 0, 0)).toBe(false);
    expect(isSwitchImminent(Number.NaN, 50, 88)).toBe(false);
  });
});

describe("compact-hint publishes lines at turn_end; imminence is judged against live usage", () => {
  function harness(opts: { thresholdPercent?: number; handoffPending?: () => boolean } = {}) {
    const state = {
      thresholdPercent: opts.thresholdPercent ?? 50,
      forceAtPercent: 88,
      forceScaling: false,
      thresholdTokens: 0,
      forceAtTokens: 0,
      reserveTokens: 16_384,
      lastHintAt: 0,
      hintedAt: undefined,
      tickStepPercent: 0,
      lastTickStep: 0,
      switchTool: false,
      forceDemandTurns: 1,
      demandCount: 0,
      imminence: undefined,
    } as CompactHintState;
    const hook = createCompactHintHook(
      { current: { compactHint: state } as Stack },
      {
        sendMessage: () => undefined,
        now: () => 1,
        ...(opts.handoffPending !== undefined ? { handoffPending: opts.handoffPending } : {}),
      },
    );
    const usageCtx = (percent: number | null) => ({
      mode: "interactive",
      hasUI: false,
      getContextUsage: () => ({ percent, contextWindow: 200_000, tokens: null }),
      ui: { notify: () => undefined },
    });
    const turn = (percent: number | null) => hook({}, usageCtx(percent) as never);
    const now = (percent: number | null) => isSwitchImminentNow(state, usageCtx(percent) as never);
    return { state, turn, now };
  }

  it("is false before any turn_end has published lines (print/json, compact off)", () => {
    const h = harness();
    expect(h.state.imminence).toBeUndefined();
    expect(h.now(99)).toBe(false);
  });

  it("judges the LIVE percent: a tool result that lands after turn_end is seen at request time", () => {
    const h = harness();
    h.turn(30);
    expect(h.state.imminence).toMatchObject({ hintPercent: 50, forcePercent: 88 });
    expect(h.now(30)).toBe(false);
    expect(h.now(46)).toBe(true); // turn_end said 30%, the request itself is at 46%
  });

  it("unknown live usage (pi right after a compaction) ⇒ false even though turn_end saw 60%", () => {
    const h = harness();
    h.turn(60);
    expect(h.now(60)).toBe(true);
    expect(h.now(null)).toBe(false);
  });

  it("a pending handoff counts regardless of usage, and stops counting once consumed", () => {
    let pending = true;
    const h = harness({ handoffPending: () => pending });
    h.turn(10);
    expect(h.now(10)).toBe(true);
    expect(h.now(null)).toBe(true);
    pending = false;
    expect(h.now(10)).toBe(false);
  });

  it("with the hint line off, only the force line decides", () => {
    const h = harness({ thresholdPercent: 0 });
    h.turn(10);
    expect(h.now(60)).toBe(false);
    expect(h.now(84)).toBe(true);
  });

  it("a throwing usage port degrades to false", () => {
    const h = harness();
    h.turn(60);
    expect(
      isSwitchImminentNow(h.state, {
        getContextUsage: () => {
          throw new Error("stale ctx");
        },
      } as never),
    ).toBe(false);
  });
});

describe("cache-ttl adaptive refuses new 1h prefixes while a switch is imminent", () => {
  const NOW = 1_790_000_000_000;
  const MIN = 60_000;
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
  const signals: AdaptiveSignals = {
    subagentRuns: 1,
    maxSubagentHorizonMs: 30 * MIN,
    backgroundBashJobs: 0,
    uiPrompts: 0,
    activeTools: 0,
  };
  const ledger: LedgerUsage = {
    source: "usage",
    cacheRead: 100_000,
    cacheWrite: 3_000,
    cacheWrite1h: undefined,
    costTotalUsd: undefined,
    cacheWriteUsd: undefined,
    entrySeq: 10,
    entriesLength: 11,
    modelId: "m",
  };
  const decide = (o: Partial<AdaptiveDecideInput> = {}) =>
    decideAdaptiveTtl({
      now: NOW,
      mode: "adaptive",
      api: "anthropic-messages",
      provider: "cloudrouter-anthropic",
      modelId: "m",
      supportsLongCacheRetention: true,
      shape: { ephemeralBreakpoints: 2, ttl1h: false, hasThinking: false, maxTokens: 32_000 },
      signals,
      ledger,
      config: CONFIG,
      state: { ...createInitialAdaptiveState(), lastRequestStartedAt: NOW - 20_000 },
      lastProvenCacheReadAt: undefined,
      ...o,
    });

  it("control: the same request upgrades when no switch is imminent (absent or false)", () => {
    expect(decide()).toMatchObject({ upgrade: true, class: "warm" });
    expect(decide({ switchImminent: false })).toMatchObject({ upgrade: true, class: "warm" });
  });

  it("switchImminent ⇒ a NEW 1h prefix (entry fee) is declined with switch-imminent", () => {
    expect(decide({ switchImminent: true })).toMatchObject({ upgrade: false, reason: "switch-imminent" });
  });

  // Review P0: F1 has keepalive stand down while a confirmed 1h cover holds; refusing the
  // renewal too would leave the prefix unprotected once that cover lapses.
  it("switchImminent ⇒ a COVERED renewal still upgrades (only the tail is rewritten)", () => {
    const covered = {
      ...createInitialAdaptiveState(),
      lastRequestStartedAt: NOW - 20_000,
      oneHourCoverUntil: NOW + 30 * MIN,
      confirmed1hWrites: 1,
      lastUpgradeAt: NOW - 10 * MIN,
      tokensSinceLast1hWrite: 18_000,
    };
    expect(decide({ switchImminent: true, state: covered })).toMatchObject({ upgrade: true, class: "warm" });
  });

  // Re-review residual: a covered request whose own payload drifted settles as a full
  // rewrite — unknowable at decision time — but F2 drops the cover on that settlement, so
  // the NEXT imminent request is an uncovered entry fee and is gated.
  it("after a drifted settlement clears the cover, the next imminent request is gated", () => {
    const covered = {
      ...createInitialAdaptiveState(),
      lastRequestStartedAt: NOW - 20_000,
      lastPrefixTokens: 205_943,
      lastReconciledEntrySeq: 9,
      oneHourCoverUntil: NOW + 50 * MIN,
      confirmed1hWrites: 2,
      lastGapMs: 56_000,
    };
    const drifted = onLedgerObserved(
      covered,
      { ...ledger, cacheRead: 11_846, cacheWrite: 207_109, cacheWrite1h: 0 },
      NOW,
      CONFIG,
    );
    expect(drifted.oneHourCoverUntil).toBeUndefined();
    expect(decide({ switchImminent: true, state: { ...drifted, lastRequestStartedAt: NOW - 20_000 } })).toMatchObject({
      upgrade: false,
      reason: "switch-imminent",
    });
  });

  it("session-level reasons (breaker, budgets) are reported before the transient switch-imminent", () => {
    const tripped = {
      ...createInitialAdaptiveState(),
      lastRequestStartedAt: NOW - 20_000,
      breaker: { reason: "warm-miss" as const, at: NOW - MIN },
    };
    expect(decide({ switchImminent: true, state: tripped })).toMatchObject({ upgrade: false, reason: "breaker" });
  });

  it("capability gates still report first (the flag never masks a structural reason)", () => {
    expect(decide({ switchImminent: true, supportsLongCacheRetention: false })).toMatchObject({
      upgrade: false,
      reason: "no-1h-support",
    });
  });
});

describe("keepalive's one-shot 1h upgrade after budget exhaustion skips an imminent switch", () => {
  const NOW = 1_790_000_000_000;
  const window: WindowState = {
    ...createInitialWindowState(),
    upgradePending: true,
    lastReadStartedAt: NOW - 10 * 60_000,
  };
  const input = { sessionMatches: true, mode: "auto" as const, upgradeAfterBudgetEnabled: true, now: NOW };

  it("control: an eligible window consumes the upgrade", () => {
    expect(consumeUpgrade(window, input).consumed).toBe(true);
  });

  it("switchImminent ⇒ not consumed and the pending flag is left for session_compact to clear", () => {
    const result = consumeUpgrade(window, { ...input, switchImminent: true });
    expect(result.consumed).toBe(false);
    expect(result.window).toBe(window);
  });
});
