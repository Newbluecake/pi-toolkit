/**
 * Covers the one piece of real computation in the adaptive TTL assembly:
 * `computeAdaptiveSignals`, which used to be an inline closure in
 * `buildSessionStack` and was therefore untestable. The integration tests drive
 * the adaptive service through UI-gate signals, which bypass this path
 * entirely, so the terminal-status filter and the horizon reduction had no
 * coverage at all.
 */
import { describe, expect, it, vi } from "vitest";
import {
  computeAdaptiveSignals,
  createCacheAdaptiveService,
  type AdaptiveExternalSignals,
} from "../../src/service/cache-adaptive.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Millis, RunStatus } from "../../src/core/types.js";

type SignalRun = Parameters<typeof computeAdaptiveSignals>[0][number];

function run(status: RunStatus, deadlineAt?: Millis, hardDeadlineAt?: Millis): SignalRun {
  return {
    status,
    deadlines: hardDeadlineAt === undefined ? { deadlineAt } : { deadlineAt, hardDeadlineAt },
  };
}

const NOW = 1_000_000 as Millis;

describe("computeAdaptiveSignals", () => {
  it("counts only non-terminal runs", () => {
    const signals = computeAdaptiveSignals(
      [
        run("queued"),
        run("starting"),
        run("running"),
        run("stopping"),
        run("completed"),
        run("failed"),
        run("timed_out"),
        run("aborted"),
      ],
      0,
      NOW,
    );
    // queued/starting/running/stopping are live; the other four are terminal.
    expect(signals.subagentRuns).toBe(4);
  });

  it("reports no horizon when nothing is live", () => {
    const signals = computeAdaptiveSignals([run("completed", (NOW + 600_000) as Millis)], 0, NOW);
    expect(signals).toEqual({ subagentRuns: 0, maxSubagentHorizonMs: undefined, backgroundBashJobs: 0 });
  });

  it("ignores the deadlines of terminal runs when reducing the horizon", () => {
    // A finished run with a far-future deadline must not inflate the horizon,
    // otherwise a settled fleet would keep justifying 1h upgrades.
    const signals = computeAdaptiveSignals(
      [run("completed", (NOW + 3_600_000) as Millis), run("running", (NOW + 60_000) as Millis)],
      0,
      NOW,
    );
    expect(signals.subagentRuns).toBe(1);
    expect(signals.maxSubagentHorizonMs).toBe(60_000);
  });

  it("prefers the hard deadline over the soft one", () => {
    // The reaper enforces the hard deadline, so it is the run's real horizon.
    const signals = computeAdaptiveSignals(
      [run("running", (NOW + 60_000) as Millis, (NOW + 900_000) as Millis)],
      0,
      NOW,
    );
    expect(signals.maxSubagentHorizonMs).toBe(900_000);
  });

  it("takes the maximum horizon across live runs", () => {
    const signals = computeAdaptiveSignals(
      [
        run("running", (NOW + 120_000) as Millis),
        run("queued", (NOW + 1_800_000) as Millis),
        run("running", (NOW + 300_000) as Millis),
      ],
      0,
      NOW,
    );
    expect(signals.subagentRuns).toBe(3);
    expect(signals.maxSubagentHorizonMs).toBe(1_800_000);
  });

  it("counts a deadline-less live run without giving it a horizon", () => {
    // It is busy, but says nothing about how long — so it must not be treated
    // as a long-horizon signal on its own.
    const signals = computeAdaptiveSignals([run("running")], 0, NOW);
    expect(signals.subagentRuns).toBe(1);
    expect(signals.maxSubagentHorizonMs).toBeUndefined();
  });

  it("still finds a horizon when only some live runs carry deadlines", () => {
    const signals = computeAdaptiveSignals([run("running"), run("running", (NOW + 240_000) as Millis)], 0, NOW);
    expect(signals.subagentRuns).toBe(2);
    expect(signals.maxSubagentHorizonMs).toBe(240_000);
  });

  it("yields a negative horizon for an overdue run rather than clamping", () => {
    // Clamping to 0 would look like "about to finish"; the raw negative value
    // lets the predictor see that the reaper is already overdue.
    const signals = computeAdaptiveSignals([run("running", (NOW - 30_000) as Millis)], 0, NOW);
    expect(signals.maxSubagentHorizonMs).toBe(-30_000);
  });

  it("passes the background bash job count through", () => {
    expect(computeAdaptiveSignals([], 3, NOW).backgroundBashJobs).toBe(3);
    expect(computeAdaptiveSignals([], 0, NOW).backgroundBashJobs).toBe(0);
  });

  it("returns all-zero signals for an empty fleet", () => {
    expect(computeAdaptiveSignals([], 0, NOW)).toEqual({
      subagentRuns: 0,
      maxSubagentHorizonMs: undefined,
      backgroundBashJobs: 0,
    });
  });
});

/**
 * plan.md §15 R7: the stack injects `signals()` as a closure over `query` /
 * `bashJobs`. If either is in a degraded state and throws, the service must
 * read all-zero signals and therefore never upgrade — a failure to observe the
 * fleet must never be mistaken for "the fleet is busy".
 */
describe("signals() failure degrades to all-zero", () => {
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

  function serviceWithSignals(signals: () => AdaptiveExternalSignals) {
    const ctx = {
      sessionManager: { getEntries: () => [], getSessionId: () => "s1", getBranch: () => [] },
      model: { provider: "anthropic", api: "anthropic-messages", id: "claude-x" },
    } as unknown as ExtensionContext;
    return createCacheAdaptiveService({
      ctx,
      sessionId: "s1",
      settings: { ...DEFAULT_SETTINGS.cacheTtl, mode: "adaptive", adaptiveEnabled: true },
      signals,
      isCurrent: () => true,
      appendEntry: vi.fn(),
    });
  }

  it("declines with no-signal instead of propagating the throw", () => {
    const service = serviceWithSignals(() => {
      throw new Error("registry unavailable");
    });
    try {
      const decision = service.decide("s1", service.instanceId, { shape: SHAPE, ledger: { ...LEDGER } });
      expect(decision.upgrade).toBe(false);
      expect(decision.reason).toBe("no-signal");
      expect(service.snapshot().breaker).toBeUndefined();
    } finally {
      service.dispose();
    }
  });

  it("control: the very same request DOES upgrade when signals report a busy fleet", () => {
    // Without this control the test above would pass even if the request were
    // being declined for some unrelated reason, making it unfalsifiable.
    const service = serviceWithSignals(() => ({
      subagentRuns: 1,
      maxSubagentHorizonMs: 1_800_000,
      backgroundBashJobs: 0,
    }));
    try {
      const decision = service.decide("s1", service.instanceId, { shape: SHAPE, ledger: { ...LEDGER } });
      expect(decision.upgrade).toBe(true);
    } finally {
      service.dispose();
    }
  });
});
