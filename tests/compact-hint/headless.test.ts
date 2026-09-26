import { describe, expect, it, vi } from "vitest";
import { createCompactHintHook, type CompactHintState, type Stack } from "../../src/stack.js";

function baseState(initial: Partial<CompactHintState> = {}): CompactHintState {
  return {
    thresholdPercent: 75,
    forceAtPercent: 88,
    forceScaling: false,
    thresholdTokens: 0,
    forceAtTokens: 0,
    reserveTokens: 16384,
    lastHintAt: 0,
    hintedAt: undefined,
    tickStepPercent: 10,
    lastTickStep: 0,
    switchTool: true,
    forceDemandTurns: 1,
    demandCount: 0,
    imminence: undefined,
    ...initial,
  };
}

function headlessHarness(initial: Partial<CompactHintState> = {}) {
  const state = baseState(initial);
  const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
  let clock = 1;
  const hook = createCompactHintHook({ current: undefined as unknown as Stack | undefined } as never, {
    sendMessage: (message, options) => sent.push({ message, options }),
    now: () => clock,
    headless: true,
    getState: () => state,
  });
  return {
    state,
    sent,
    hook,
    setNow: (value: number) => {
      clock = value;
    },
  };
}

function ctx(
  percent: number | null,
  mode: string = "print",
  hasUI = false,
  contextWindow = 200_000,
  compact = vi.fn(),
) {
  return {
    mode,
    hasUI,
    getContextUsage: () => ({ percent, contextWindow, tokens: null }),
    ui: { notify: vi.fn() },
    compact,
  } as never;
}

describe("compact-hint headless (child-context-switch plan §2.2)", () => {
  it("headless bypasses the print/json early-return: ticks and hints still fire in print mode", () => {
    const h = headlessHarness();
    h.hook({}, ctx(80));
    expect(h.sent.length).toBeGreaterThan(0);
    expect(h.sent[0]?.message.customType).toBeDefined();
  });

  it("demand is sent while budget remains, never touching ctx.compact", () => {
    const h = headlessHarness({ forceDemandTurns: 2 });
    const compact = vi.fn();
    h.hook({}, ctx(90, "print", false, 200_000, compact));
    expect(h.state.demandCount).toBe(1);
    expect(compact).not.toHaveBeenCalled();
    const demandMessage = h.sent.at(-1)?.message;
    expect(demandMessage?.details).toMatchObject({ demand: true, attempt: 1 });
  });

  it("demand exhausted in headless mode: never calls ctx.compact (only pi's own auto-compaction backstops)", () => {
    const h = headlessHarness({ forceDemandTurns: 1, demandCount: 1 });
    const compact = vi.fn();
    h.setNow(10_000); // clear any cooldown window from a previous force call
    h.hook({}, ctx(90, "print", false, 200_000, compact));
    expect(compact).not.toHaveBeenCalled();
    // No new demand or force notice was sent either (budget already spent for this episode).
    expect(h.sent.length).toBe(0);
  });

  it("switchesExhausted in the force zone: no demand, no compact — only tick machinery is untouched", () => {
    const h = headlessHarness({ switchesExhausted: () => true, tickStepPercent: 10 });
    const compact = vi.fn();
    h.hook({}, ctx(95, "print", false, 200_000, compact));
    expect(compact).not.toHaveBeenCalled();
    expect(h.state.demandCount).toBe(0); // never incremented — the force branch itself was bypassed
    // A tick may or may not fire depending on the grid, but no demand/force text is ever present.
    for (const entry of h.sent) {
      expect(entry.message.details).not.toMatchObject({ demand: true });
      expect(entry.message.details).not.toMatchObject({ forced: true });
    }
  });

  it("switchesExhausted below the force line: plain hint is suppressed, tick still allowed", () => {
    const h = headlessHarness({ switchesExhausted: () => true, tickStepPercent: 10 });
    h.hook({}, ctx(80)); // above hint (75) but below force (88)
    for (const entry of h.sent) {
      // The plain-hint customType is COMPACT_HINT_CUSTOM_TYPE; a tick uses a distinct type.
      expect(entry.message.details).not.toHaveProperty("thresholdPercent");
    }
  });

  it("a switch (or pi auto-compaction) resetting hintedAt/demandCount/lastTickStep un-latches the next turn", () => {
    const h = headlessHarness();
    h.hook({}, ctx(80));
    const firstSentCount = h.sent.length;
    expect(firstSentCount).toBeGreaterThan(0);
    // Same percent again: latched, no new hint (only a possible no-op tick).
    h.hook({}, ctx(80));
    const beforeReset = h.sent.length;
    // Simulate P3's session_compact / successful switch reset (direct field mutation, no new API).
    h.state.hintedAt = undefined;
    h.state.demandCount = 0;
    h.state.lastTickStep = 0;
    h.hook({}, ctx(80));
    expect(h.sent.length).toBeGreaterThan(beforeReset);
  });

  it("dynamic threshold absent (state.dynamic undefined) never throws and behaves like the static line", () => {
    const h = headlessHarness();
    expect(h.state.dynamic).toBeUndefined();
    expect(() => h.hook({}, ctx(80))).not.toThrow();
  });

  it("non-headless (main session) hooks are unaffected: print/json still early-return", () => {
    const state = baseState();
    const sent: unknown[] = [];
    const hook = createCompactHintHook(
      { current: { compactHint: state } as Stack },
      {
        sendMessage: (message) => sent.push(message),
      },
    );
    hook({}, ctx(95, "print"));
    expect(sent.length).toBe(0);
  });
});
