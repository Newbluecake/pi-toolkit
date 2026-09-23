import { describe, expect, it } from "vitest";
import {
  ASSUMED_TTL_MS,
  TTL_SAFETY_MARGIN_MS,
  UNPROVEN_STREAK_LIMIT,
  UNPROVEN_TOTAL_LIMIT,
  buildFingerprint,
  buildCacheStatusSnapshot,
  cacheReadCostUsd,
  closeWindowAccounting,
  compareFingerprint,
  consumeUpgrade,
  createInitialSessionTotals,
  createInitialWindowState,
  evaluateTick,
  inspectPayload,
  invalidate,
  onPingStarted,
  onProvenHit,
  onRealRequest,
  onRequestSettled,
  onUnproven,
  renderCacheStatus,
  renderKeepaliveReportLines,
  type AdaptiveSnapshot,
  type CaptureFingerprint,
  type CapturedRequest,
  type KeepaliveConfig,
  type KeepaliveReport,
  type SessionTotals,
  type WindowState,
} from "../../src/cache-ttl/keepalive-state.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function fingerprint(overrides: Partial<CaptureFingerprint> = {}): CaptureFingerprint {
  return {
    sessionId: "s1",
    provider: "anthropic",
    api: "anthropic-messages",
    modelId: "claude-opus",
    ctxModelId: "claude-opus",
    baseUrl: "https://api.anthropic.com",
    authHeaderKeys: "x-api-key",
    breakpointPath: "system.0",
    thinkingDigest: "",
    systemDigest: "10:abc:abc",
    toolsDigest: "0:",
    messageCount: 3,
    ...overrides,
  };
}

function captured(overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    sessionId: "s1",
    instance: "inst-1",
    payload: { messages: [], stream: true },
    headers: { "content-type": "application/json" },
    fingerprint: fingerprint(),
    shape: { ephemeralBreakpoints: 1, ttl1h: false, hasThinking: false, maxTokens: 4096 },
    prefix: { tokens: 25_000, source: "usage" },
    capturedAt: 0,
    ...overrides,
  };
}

function config(overrides: Partial<KeepaliveConfig> = {}): KeepaliveConfig {
  return {
    enabled: true,
    intervalMs: 240_000,
    maxPings: 11,
    minPrefixTokens: 20_000,
    upgradeAfterBudget: true,
    ...overrides,
  };
}

function armedWindow(overrides: Partial<WindowState> = {}): WindowState {
  return {
    ...createInitialWindowState(),
    capture: captured(),
    windowStartAt: 0,
    lastReadStartedAt: 0,
    aliveUntil: ASSUMED_TTL_MS,
    nextPingAt: 240_000,
    ...overrides,
  };
}

function baseSession(overrides: Partial<SessionTotals> = {}): SessionTotals {
  return { ...createInitialSessionTotals(), ...overrides };
}

// ---------------------------------------------------------------------------
// evaluateTick: the 15-row short-circuit ladder (plan.md §5.2)
// ---------------------------------------------------------------------------

describe("evaluateTick — short-circuit ladder", () => {
  it("#1 disabled config is terminal and wins over everything else", () => {
    const window = armedWindow();
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config({ enabled: false }),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "disabled", terminal: true });
    expect(result.window).toBe(window);
  });

  it("#2 session-disabled short-circuits regardless of window state", () => {
    const window = armedWindow();
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession({ disabled: { reason: "proven-write", at: 5 } }),
      window,
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "session-disabled", terminal: true });
  });

  it("#3 no capture ⇒ no-capture, terminal", () => {
    const window = createInitialWindowState();
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "no-capture", terminal: true });
  });

  it("#4 non-tui/rpc modes are rejected (print/json can't resume a long-idle session)", () => {
    for (const mode of ["print", "json", "batch"]) {
      const result = evaluateTick({
        now: 1000,
        mode,
        armed: true,
        config: config(),
        session: baseSession(),
        window: armedWindow(),
        currentFingerprint: fingerprint(),
      });
      expect(result.decision).toEqual({ kind: "skip", reason: "mode", terminal: true });
    }
  });

  it("#5 non-anthropic api is rejected", () => {
    const window = armedWindow({ capture: captured({ fingerprint: fingerprint({ api: "openai-chat" }) }) });
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint({ api: "openai-chat" }),
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "not-anthropic", terminal: true });
  });

  it("#5 denylisted provider (github-copilot) is rejected", () => {
    const window = armedWindow({ capture: captured({ fingerprint: fingerprint({ provider: "github-copilot" }) }) });
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint({ provider: "github-copilot" }),
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "not-anthropic", terminal: true });
  });

  it("#6 no cache_control breakpoints ⇒ no-cache-control", () => {
    const window = armedWindow({
      capture: captured({ shape: { ephemeralBreakpoints: 0, ttl1h: false, hasThinking: false, maxTokens: undefined } }),
    });
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "no-cache-control", terminal: true });
  });

  it("#7 already 1h TTL ⇒ ttl-1h", () => {
    const window = armedWindow({
      capture: captured({ shape: { ephemeralBreakpoints: 1, ttl1h: true, hasThinking: false, maxTokens: undefined } }),
    });
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "ttl-1h", terminal: true });
  });

  it("#7.5 B1: a captured payload without stream:true is refused (not-streaming), never rewritten", () => {
    const window = armedWindow({ capture: captured({ payload: { messages: [], stream: false } }) });
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "not-streaming", terminal: true });
  });

  it("#7.5 B1: a captured payload missing stream entirely is also refused", () => {
    const window = armedWindow({ capture: captured({ payload: { messages: [] } }) });
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "not-streaming", terminal: true });
  });

  it("#8 unknown prefix source ⇒ prefix-unproven, even when tokens are large (M3)", () => {
    const window = armedWindow({ capture: captured({ prefix: { tokens: 0, source: "unknown" } }) });
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "prefix-unproven", terminal: true });
  });

  it("#8 measured prefix below the floor ⇒ prefix-too-small", () => {
    const window = armedWindow({ capture: captured({ prefix: { tokens: 19_999, source: "usage" } }) });
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config({ minPrefixTokens: 20_000 }),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "prefix-too-small", terminal: true });
  });

  it("#9 fingerprint drift ⇒ invalidate with the first differing field, and bumps windowEpoch", () => {
    const window = armedWindow();
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint({ baseUrl: "https://other.example.com" }),
    });
    expect(result.decision).toEqual({ kind: "invalidate", reason: "fingerprint-drift:baseUrl" });
    expect(result.window.windowEpoch).toBe(window.windowEpoch + 1);
    expect(result.window.capture).toBeUndefined();
  });

  it("#9 safety fields are checked before effectiveness fields", () => {
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window: armedWindow(),
      currentFingerprint: fingerprint({ baseUrl: "https://other.example.com", toolsDigest: "9:x" }),
    });
    expect(result.decision).toEqual({ kind: "invalidate", reason: "fingerprint-drift:baseUrl" });
  });

  it("#10 real request in flight ⇒ request-in-flight, non-terminal", () => {
    const window = armedWindow({ requestInFlight: true });
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "request-in-flight", terminal: false });
  });

  it("#11 ping already in flight ⇒ ping-in-flight, non-terminal", () => {
    const window = armedWindow({ pingInFlight: true });
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "ping-in-flight", terminal: false });
  });

  it("#12 not armed ⇒ not-armed, non-terminal", () => {
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: false,
      config: config(),
      session: baseSession(),
      window: armedWindow(),
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "not-armed", terminal: false });
  });

  it("#13 cache-expired boundary: margin-1 still pings, exactly at margin is terminal cache-expired", () => {
    const window = armedWindow({ aliveUntil: ASSUMED_TTL_MS, nextPingAt: 0 });
    const justBefore = evaluateTick({
      now: ASSUMED_TTL_MS - TTL_SAFETY_MARGIN_MS - 1,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint(),
    });
    expect(justBefore.decision).toEqual({ kind: "ping" });

    const atMargin = evaluateTick({
      now: ASSUMED_TTL_MS - TTL_SAFETY_MARGIN_MS,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint(),
    });
    expect(atMargin.decision).toEqual({ kind: "skip", reason: "cache-expired", terminal: true });
  });

  it("#14 budget exhausted ⇒ terminal skip + upgradePending armed; #15 not-due before that", () => {
    const window = armedWindow({ pings: 11, nextPingAt: 0 });
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config({ maxPings: 11 }),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "budget-exhausted", terminal: true });
    expect(result.window.upgradePending).toBe(true);

    const notYetExhausted = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config({ maxPings: 11 }),
      session: baseSession(),
      window: armedWindow({ pings: 10, nextPingAt: 500_000 }),
      currentFingerprint: fingerprint(),
    });
    expect(notYetExhausted.decision).toEqual({ kind: "skip", reason: "not-due", terminal: false });
  });

  it("#16 everything clears ⇒ ping", () => {
    const window = armedWindow({ nextPingAt: 999 });
    const result = evaluateTick({
      now: 1000,
      mode: "rpc",
      armed: true,
      config: config(),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).toEqual({ kind: "ping" });
  });
});

// ---------------------------------------------------------------------------
// onRealRequest / onRequestSettled — time anchors and window reset
// ---------------------------------------------------------------------------

describe("onRealRequest", () => {
  it("resets the window, anchors nextPingAt/aliveUntil to the request start time, and bumps windowEpoch", () => {
    const window = createInitialWindowState();
    const session = baseSession();
    const { window: next } = onRealRequest(window, session, captured(), 1_000, 240_000, ASSUMED_TTL_MS);
    expect(next.windowEpoch).toBe(1);
    expect(next.windowStartAt).toBe(1_000);
    expect(next.lastReadStartedAt).toBe(1_000);
    expect(next.aliveUntil).toBe(1_000 + ASSUMED_TTL_MS);
    expect(next.nextPingAt).toBe(1_000 + 240_000);
    expect(next.pings).toBe(0);
    expect(next.requestInFlight).toBe(true);
    expect(next.pingInFlight).toBe(false);
    expect(next.upgradePending).toBe(false);
  });

  it("I-K7: does not reset any session-level breaker counters", () => {
    const disabled = { reason: "proven-write", at: 10 };
    const session = baseSession({
      unprovenTotal: 5,
      consecutiveUnproven: 2,
      provenWrites: 1,
      disabled,
      lastUnproven: { kind: "proven-write", at: 10 },
      pings: 3,
      cacheReadTokens: 999,
    });
    const window = createInitialWindowState();
    const { session: next } = onRealRequest(window, session, captured(), 2_000, 240_000);
    expect(next.unprovenTotal).toBe(5);
    expect(next.consecutiveUnproven).toBe(2);
    expect(next.provenWrites).toBe(1);
    expect(next.disabled).toEqual(disabled);
    expect(next.lastUnproven).toEqual({ kind: "proven-write", at: 10 });
    expect(next.pings).toBe(3);
    expect(next.cacheReadTokens).toBe(999);
  });
});

describe("onRequestSettled", () => {
  it("clears requestInFlight and returns a new object", () => {
    const window = { ...createInitialWindowState(), requestInFlight: true };
    const next = onRequestSettled(window);
    expect(next.requestInFlight).toBe(false);
    expect(next).not.toBe(window);
  });

  it("is a no-op (same reference) when nothing was in flight", () => {
    const window = createInitialWindowState();
    expect(onRequestSettled(window)).toBe(window);
  });
});

describe("onPingStarted", () => {
  it("spends one budget unit and records the start time", () => {
    const window = armedWindow({ pings: 2 });
    const next = onPingStarted(window, 5_000);
    expect(next.pingInFlight).toBe(true);
    expect(next.pings).toBe(3);
    expect(next.pingStartedAt).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// I-K8: window-epoch guard on ping result reducers
// ---------------------------------------------------------------------------

describe("I-K8 — epoch mismatch is a silent, total no-op", () => {
  it("onProvenHit dropped: no proven counting, no aliveUntil/nextPingAt movement, no breaker touch", () => {
    const window = armedWindow({ windowEpoch: 3, pingStartedAt: 100 });
    const session = baseSession({ consecutiveUnproven: 1, pings: 4, cacheReadTokens: 1_000 });
    const result = onProvenHit(
      window,
      session,
      /* stale pingEpoch */ 2,
      { cacheReadTokens: 5_000, inputTokens: 10 },
      240_000,
    );
    expect(result.applied).toBe(false);
    expect(result.window).toBe(window);
    expect(result.session).toBe(session);
    // spelled out explicitly per the task's acceptance criteria:
    expect(result.session.consecutiveUnproven).toBe(1); // not cleared
    expect(result.session.pings).toBe(4); // not incremented
    expect(result.window.aliveUntil).toBe(window.aliveUntil); // not advanced
    expect(result.window.nextPingAt).toBe(window.nextPingAt); // not advanced
  });

  it("onUnproven dropped: no unproven/consecutive/provenWrites counting, no breaker trip", () => {
    const window = armedWindow({ windowEpoch: 7 });
    const session = baseSession({ unprovenTotal: 2, consecutiveUnproven: 1 });
    const result = onUnproven(window, session, /* stale pingEpoch */ 6, "proven-write", 9_000);
    expect(result.applied).toBe(false);
    expect(result.window).toBe(window);
    expect(result.session).toBe(session);
    expect(result.session.provenWrites).toBe(0);
    expect(result.session.disabled).toBeUndefined();
  });

  it("applies normally when pingEpoch matches the current windowEpoch", () => {
    const window = armedWindow({ windowEpoch: 4, pingStartedAt: 200 });
    const session = baseSession();
    const result = onProvenHit(window, session, 4, { cacheReadTokens: 1_234 }, 240_000);
    expect(result.applied).toBe(true);
    expect(result.session.cacheReadTokens).toBe(1_234);
    expect(result.window.aliveUntil).toBe(200 + ASSUMED_TTL_MS);
    expect(result.window.nextPingAt).toBe(200 + 240_000);
  });

  it("onProvenHit anchors the clock to pingStartedAt, not the (later) reducer-call time", () => {
    const window = armedWindow({ windowEpoch: 1, pingStartedAt: 50_000 });
    const result = onProvenHit(window, baseSession(), 1, { cacheReadTokens: 1 }, 240_000);
    expect(result.window.lastReadStartedAt).toBe(50_000);
    expect(result.window.aliveUntil).toBe(50_000 + ASSUMED_TTL_MS);
  });
});

// ---------------------------------------------------------------------------
// I-K7: proven-hit-only breaker
// ---------------------------------------------------------------------------

describe("I-K7 — session-level breaker (proven-hit only)", () => {
  it("a single proven-write disables the session immediately", () => {
    const window = armedWindow({ windowEpoch: 1 });
    const result = onUnproven(window, baseSession(), 1, "proven-write", 100);
    expect(result.session.provenWrites).toBe(1);
    expect(result.session.disabled).toEqual({ reason: "proven-write", at: 100 });
  });

  it(`${UNPROVEN_STREAK_LIMIT} consecutive unproven results disable the session`, () => {
    let window = armedWindow({ windowEpoch: 1 });
    let session = baseSession();
    for (let i = 0; i < UNPROVEN_STREAK_LIMIT; i++) {
      const result = onUnproven(window, session, 1, "no-usage", 100 + i);
      session = result.session;
      window = result.window;
      if (i < UNPROVEN_STREAK_LIMIT - 1) expect(session.disabled).toBeUndefined();
    }
    expect(session.consecutiveUnproven).toBe(UNPROVEN_STREAK_LIMIT);
    expect(session.disabled).toEqual({ reason: "no-usage", at: 100 + UNPROVEN_STREAK_LIMIT - 1 });
  });

  it(`${UNPROVEN_TOTAL_LIMIT} cumulative (non-consecutive) unproven results disable the session`, () => {
    const window = armedWindow({ windowEpoch: 1 });
    // hit / miss / hit / miss / miss — never 2 in a row, but 3 total.
    let session = baseSession();
    let ep = 1;
    let w = window;

    let r = onUnproven(w, session, ep, "network", 1);
    session = r.session;
    w = r.window;
    expect(session.disabled).toBeUndefined();

    // a proven hit clears consecutiveUnproven but NOT unprovenTotal.
    w = { ...w, windowEpoch: ep, pingStartedAt: 10 }; // simulate next ping still in same epoch
    let hit = onProvenHit(w, session, ep, { cacheReadTokens: 10 }, 240_000);
    session = hit.session;
    w = hit.window;
    expect(session.consecutiveUnproven).toBe(0);
    expect(session.unprovenTotal).toBe(1);

    r = onUnproven(w, session, ep, "http", 2);
    session = r.session;
    w = r.window;
    expect(session.unprovenTotal).toBe(2);
    expect(session.disabled).toBeUndefined();

    r = onUnproven(w, session, ep, "malformed", 3);
    session = r.session;
    expect(session.unprovenTotal).toBe(3);
    expect(session.disabled).toEqual({ reason: "malformed", at: 3 });
  });

  it("I-K7: onRealRequest never resets or revives a disabled session (window reset doesn't recover)", () => {
    const disabled = { reason: "proven-write", at: 5 };
    const session = baseSession({ disabled, unprovenTotal: 9, consecutiveUnproven: 9, provenWrites: 1 });
    const { session: next } = onRealRequest(createInitialWindowState(), session, captured(), 10_000, 240_000);
    expect(next).toEqual(session);
    // and evaluateTick keeps rejecting on session-disabled even with a fresh window/capture:
    const tickAfterReset = evaluateTick({
      now: 10_001,
      mode: "tui",
      armed: true,
      config: config(),
      session: next,
      window: onRealRequest(createInitialWindowState(), session, captured(), 10_000, 240_000).window,
      currentFingerprint: fingerprint(),
    });
    expect(tickAfterReset.decision).toEqual({ kind: "skip", reason: "session-disabled", terminal: true });
  });
});

// ---------------------------------------------------------------------------
// invalidate()
// ---------------------------------------------------------------------------

describe("invalidate", () => {
  it("clears capture + upgradePending and bumps windowEpoch, nothing else", () => {
    const window = armedWindow({ upgradePending: true, pings: 4, requestInFlight: true, windowEpoch: 2 });
    const next = invalidate(window, "session-compact");
    expect(next).toEqual({ ...window, capture: undefined, upgradePending: false, windowEpoch: 3 });
  });
});

// ---------------------------------------------------------------------------
// consumeUpgrade — one-shot 1h upgrade (§6.3, I-K5)
// ---------------------------------------------------------------------------

describe("consumeUpgrade", () => {
  const eligibleWindow: WindowState = { ...armedWindow(), upgradePending: true, lastReadStartedAt: 0 };

  it("consumes when session matches, mode is auto, setting is on, and the cache is presumed dead", () => {
    const result = consumeUpgrade(eligibleWindow, {
      sessionMatches: true,
      mode: "auto",
      upgradeAfterBudgetEnabled: true,
      now: ASSUMED_TTL_MS + 1,
    });
    expect(result.consumed).toBe(true);
    expect(result.window.upgradePending).toBe(false);
  });

  it("does not consume when upgradePending is false", () => {
    const result = consumeUpgrade(
      { ...eligibleWindow, upgradePending: false },
      {
        sessionMatches: true,
        mode: "auto",
        upgradeAfterBudgetEnabled: true,
        now: ASSUMED_TTL_MS + 1,
      },
    );
    expect(result.consumed).toBe(false);
  });

  it("does not consume for explicit on/off modes (I-K5)", () => {
    for (const mode of ["on", "off"] as const) {
      const result = consumeUpgrade(eligibleWindow, {
        sessionMatches: true,
        mode,
        upgradeAfterBudgetEnabled: true,
        now: ASSUMED_TTL_MS + 1,
      });
      expect(result.consumed).toBe(false);
    }
  });

  it("does not consume when the setting is off", () => {
    const result = consumeUpgrade(eligibleWindow, {
      sessionMatches: true,
      mode: "auto",
      upgradeAfterBudgetEnabled: false,
      now: ASSUMED_TTL_MS + 1,
    });
    expect(result.consumed).toBe(false);
  });

  it("does not consume across a session mismatch", () => {
    const result = consumeUpgrade(eligibleWindow, {
      sessionMatches: false,
      mode: "auto",
      upgradeAfterBudgetEnabled: true,
      now: ASSUMED_TTL_MS + 1,
    });
    expect(result.consumed).toBe(false);
  });

  it("does not consume when the cache would not yet be dead (honesty check)", () => {
    const result = consumeUpgrade(eligibleWindow, {
      sessionMatches: true,
      mode: "auto",
      upgradeAfterBudgetEnabled: true,
      now: 1_000,
    });
    expect(result.consumed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fingerprint building + comparison (M4)
// ---------------------------------------------------------------------------

describe("buildFingerprint / compareFingerprint", () => {
  const context = {
    sessionId: "s1",
    provider: "anthropic",
    api: "anthropic-messages",
    ctxModelId: "claude-opus",
    baseUrl: "https://api.anthropic.com",
    authHeaderKeys: "x-api-key",
  };

  it("derives payload-side fields from the payload and copies context fields verbatim", () => {
    const payload = {
      model: "claude-opus-wire",
      system: [{ text: "hello world", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "bash" }, { name: "read" }],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" },
      ],
      thinking: { type: "enabled", budget_tokens: 1024 },
    };
    const fp = buildFingerprint(payload, context);
    expect(fp.sessionId).toBe("s1");
    expect(fp.modelId).toBe("claude-opus-wire");
    expect(fp.ctxModelId).toBe("claude-opus");
    expect(fp.messageCount).toBe(2);
    expect(fp.toolsDigest).toBe("2:bash,read");
    expect(fp.breakpointPath).toBe("system.0");
    expect(fp.thinkingDigest).toBe(JSON.stringify(payload.thinking));
  });

  it.each([
    "sessionId",
    "provider",
    "api",
    "ctxModelId",
    "baseUrl",
    "authHeaderKeys",
    "breakpointPath",
    "thinkingDigest",
    "systemDigest",
    "toolsDigest",
    "messageCount",
  ] as const)("detects a drift in %s", (field) => {
    const a = fingerprint();
    const b =
      field === "messageCount"
        ? fingerprint({ messageCount: a.messageCount + 1 })
        : fingerprint({ [field]: `${a[field]}-changed` } as Partial<CaptureFingerprint>);
    const diff = compareFingerprint(a, b);
    expect(diff?.field).toBe(field);
  });

  it("returns undefined for identical fingerprints", () => {
    expect(compareFingerprint(fingerprint(), fingerprint())).toBeUndefined();
  });

  it("prioritizes safety fields over effectiveness fields", () => {
    const diff = compareFingerprint(fingerprint(), fingerprint({ provider: "other", toolsDigest: "9:z" }));
    expect(diff).toEqual({ field: "provider", category: "safety" });
  });
});

// ---------------------------------------------------------------------------
// inspectPayload (§3.2)
// ---------------------------------------------------------------------------

describe("inspectPayload", () => {
  it("counts nested ephemeral breakpoints and survives cycles", () => {
    const shared = { cache_control: { type: "ephemeral" } };
    const payload: any = { messages: [{ content: [{ ...shared, system: shared }] }], tools: [{ x: shared }] };
    payload.self = payload; // cycle
    const shape = inspectPayload(payload);
    // `tools[0].x` is the same object reference as `shared` (already visited via
    // `content[0].system`), so the WeakSet cycle guard also dedupes aliases —
    // 2 distinct breakpoint *nodes* (content[0]'s own cache_control, and the
    // one reached through `.system`), not 3 textual occurrences.
    expect(shape.ephemeralBreakpoints).toBe(2);
    expect(shape.ttl1h).toBe(false);
  });

  it("detects ttl:1h", () => {
    const payload = { messages: [{ cache_control: { type: "ephemeral", ttl: "1h" } }] };
    expect(inspectPayload(payload).ttl1h).toBe(true);
  });

  it("hasThinking is false for {type:'disabled'} and true otherwise", () => {
    expect(inspectPayload({ messages: [], thinking: { type: "disabled" } }).hasThinking).toBe(false);
    expect(inspectPayload({ messages: [], thinking: { type: "enabled", budget_tokens: 100 } }).hasThinking).toBe(true);
    expect(inspectPayload({ messages: [] }).hasThinking).toBe(false);
  });

  it("no cache_control anywhere ⇒ zero breakpoints", () => {
    expect(inspectPayload({ messages: [{ role: "user", content: "hi" }] }).ephemeralBreakpoints).toBe(0);
  });

  it("non-object payloads degrade to an empty shape", () => {
    for (const bad of [undefined, null, "x", 1, []]) {
      expect(inspectPayload(bad)).toEqual({
        ephemeralBreakpoints: 0,
        ttl1h: false,
        hasThinking: false,
        maxTokens: undefined,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// M2 window accounting: load-bearing vs. unnecessary
// ---------------------------------------------------------------------------

describe("closeWindowAccounting (M2)", () => {
  it("no-ops when the window never pinged", () => {
    const session = baseSession();
    const window = armedWindow({ pings: 0, windowStartAt: 0 });
    expect(closeWindowAccounting(window, session, 100_000, ASSUMED_TTL_MS)).toBe(session);
  });

  it("classifies as unnecessary when the real request came back before the cache would have expired anyway", () => {
    const session = baseSession();
    const window = armedWindow({ pings: 3, windowStartAt: 0 });
    const next = closeWindowAccounting(window, session, ASSUMED_TTL_MS - 1, ASSUMED_TTL_MS);
    expect(next.unnecessaryWindows).toBe(1);
    expect(next.unnecessaryPings).toBe(3);
    expect(next.loadBearingWindows).toBe(0);
  });

  it("classifies as load-bearing when the real request came back after the cache would have died", () => {
    const session = baseSession();
    const window = armedWindow({
      pings: 2,
      windowStartAt: 0,
      capture: captured({ prefix: { tokens: 42_000, source: "usage" } }),
    });
    const next = closeWindowAccounting(window, session, ASSUMED_TTL_MS + 1, ASSUMED_TTL_MS);
    expect(next.loadBearingWindows).toBe(1);
    expect(next.loadBearingPings).toBe(2);
    expect(next.avoidedMissTokens).toBe(42_000);
  });

  it("onRealRequest wires closeWindowAccounting into the window transition", () => {
    const session = baseSession();
    const window = armedWindow({
      pings: 5,
      windowStartAt: 0,
      capture: captured({ prefix: { tokens: 30_000, source: "usage" } }),
    });
    const { session: next } = onRealRequest(window, session, captured(), ASSUMED_TTL_MS + 500, 240_000);
    expect(next.loadBearingWindows).toBe(1);
    expect(next.loadBearingPings).toBe(5);
    expect(next.avoidedMissTokens).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// cost estimation (M5)
// ---------------------------------------------------------------------------

describe("cacheReadCostUsd", () => {
  it("returns undefined when cost is missing", () => {
    expect(cacheReadCostUsd(undefined, 100_000)).toBeUndefined();
  });

  it("returns undefined when the cache-read rate is zero", () => {
    expect(cacheReadCostUsd({ cacheRead: 0 }, 100_000)).toBeUndefined();
  });

  it("returns undefined for non-positive token counts", () => {
    expect(cacheReadCostUsd({ cacheRead: 0.3 }, 0)).toBeUndefined();
    expect(cacheReadCostUsd({ cacheRead: 0.3 }, -1)).toBeUndefined();
  });

  it("uses the base rate when no tier matches", () => {
    const cost = cacheReadCostUsd({ cacheRead: 0.3, tiers: [{ inputTokensAbove: 200_000, cacheRead: 0.6 }] }, 100_000);
    expect(cost).toBeCloseTo((0.3 / 1_000_000) * 100_000);
  });

  it("selects the highest matching tier strictly below the token count", () => {
    const cost = cacheReadCostUsd(
      {
        cacheRead: 0.3,
        tiers: [
          { inputTokensAbove: 0, cacheRead: 0.3 },
          { inputTokensAbove: 200_000, cacheRead: 0.15 },
        ],
      },
      250_000,
    );
    expect(cost).toBeCloseTo((0.15 / 1_000_000) * 250_000);
  });

  it("skips tiers that don't define a cache-read rate", () => {
    const cost = cacheReadCostUsd(
      {
        cacheRead: 0.3,
        tiers: [{ inputTokensAbove: 0, cacheRead: undefined as unknown as number }],
      },
      50_000,
    );
    expect(cost).toBeCloseTo((0.3 / 1_000_000) * 50_000);
  });
});

// ---------------------------------------------------------------------------
// status bar + report text (§9.1 / §9.4, M5)
// ---------------------------------------------------------------------------

function report(overrides: Partial<KeepaliveReport> = {}): KeepaliveReport {
  return {
    enabled: true,
    armed: true,
    window: armedWindow(),
    session: baseSession(),
    config: config(),
    costUsd: 0.31,
    dropped: { sessionMismatch: 0, instanceMismatch: 0, epochMismatch: 0 },
    lastSkip: undefined,
    prefixSource: "usage",
    supportsLongCacheRetention: true,
    lastPingDiagnostics: undefined,
    ...overrides,
  };
}

describe("renderCacheStatus", () => {
  it("shows nothing when mode is auto, dirty is false, and there is no report", () => {
    expect(renderCacheStatus({ mode: "auto", dirty: false, report: undefined })).toBeUndefined();
  });

  it("shows the bare cache-ttl segment for on/off modes with no ping activity", () => {
    expect(renderCacheStatus({ mode: "on", dirty: false, report: undefined })).toBe("cache 1h");
    expect(renderCacheStatus({ mode: "off", dirty: false, report: undefined })).toBe("cache 5m");
    expect(renderCacheStatus({ mode: "off", dirty: true, report: undefined })).toBe("cache 5m*");
  });

  describe("theme colouring", () => {
    // Tags rather than real ANSI so the assertions stay readable.
    const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };

    it("stays plain text when no theme is supplied (non-TUI / older pi)", () => {
      expect(renderCacheStatus({ mode: "on", dirty: false, report: undefined })).toBe("cache 1h");
    });

    it("dims the mode label and the glyph, colouring only the value", () => {
      // Matches the HUD's own "dim label + bright value" convention (`input 32`).
      expect(renderCacheStatus({ mode: "on", dirty: false, report: undefined }, theme)).toBe(
        "<dim>cache</dim> <text>1h</text>",
      );
    });

    it("keeps the dirty marker attached to the value, not the label", () => {
      expect(renderCacheStatus({ mode: "off", dirty: true, report: undefined }, theme)).toBe(
        "<dim>cache</dim> <text>5m*</text>",
      );
    });

    it("dims the separator between segments", () => {
      const text = renderCacheStatus(
        {
          mode: "off",
          dirty: false,
          report: report({
            window: armedWindow({ pings: 1 }),
            session: baseSession({ pings: 1, cacheReadTokens: 1000 }),
            costUsd: 0.14,
          }),
        },
        theme,
      );
      expect(text).toContain("<dim> · </dim>");
    });
  });

  it("shows nothing when never pinged this session and no active window ping (even non-auto with an idle report)", () => {
    expect(
      renderCacheStatus({
        mode: "auto",
        dirty: false,
        report: report({ armed: false, session: baseSession(), window: armedWindow({ pings: 0 }) }),
      }),
    ).toBeUndefined();
  });

  it("shows window/max, cumulative session count, tokens and cost while armed with pings", () => {
    const text = renderCacheStatus({
      mode: "auto",
      dirty: false,
      report: report({
        window: armedWindow({ pings: 3 }),
        session: baseSession({ pings: 12, cacheReadTokens: 620_000 }),
        costUsd: 0.31,
      }),
    });
    expect(text).toBe("ping 3/11 Σ12 · 620k · ≈$0.31");
  });

  it("prefixes the mode/dirty segment ahead of the ping segment when mode is on/off", () => {
    const text = renderCacheStatus({
      mode: "off",
      dirty: false,
      report: report({
        window: armedWindow({ pings: 1 }),
        session: baseSession({ pings: 1, cacheReadTokens: 1000 }),
        costUsd: 0.14,
      }),
    });
    expect(text).toBe("cache 5m · ping 1/11 · 1k · ≈$0.14");
  });

  it("omits the Σ cumulative marker when session pings equal window pings", () => {
    const text = renderCacheStatus({
      mode: "auto",
      dirty: false,
      report: report({
        window: armedWindow({ pings: 1 }),
        session: baseSession({ pings: 1, cacheReadTokens: 1000 }),
        costUsd: 0.14,
      }),
    });
    expect(text).not.toContain("Σ");
  });

  it("shows 'unknown' instead of $0 when the rate is unknown", () => {
    const text = renderCacheStatus({
      mode: "auto",
      dirty: false,
      report: report({ window: armedWindow({ pings: 1 }), session: baseSession({ pings: 1 }), costUsd: undefined }),
    });
    expect(text).toContain("unknown");
    expect(text).not.toContain("$0");
  });

  it("shows the budget-exhausted message with the 1h-upgrade hint only when mode is auto and upgradeAfterBudget is on", () => {
    const capped = report({ window: armedWindow({ pings: 11 }), config: config({ maxPings: 11 }) });
    expect(renderCacheStatus({ mode: "auto", dirty: false, report: capped })).toBe("ping 11/11 capped →1h");
    // I-K5: off/on suppress the upgrade regardless of upgradeAfterBudget — the
    // hint must not lie about a transition that will never happen.
    expect(renderCacheStatus({ mode: "off", dirty: false, report: capped })).toBe("cache 5m · ping 11/11 capped");
    expect(renderCacheStatus({ mode: "on", dirty: false, report: capped })).toBe("cache 1h · ping 11/11 capped");
    const cappedNoUpgrade = report({
      window: armedWindow({ pings: 11 }),
      config: config({ maxPings: 11, upgradeAfterBudget: false }),
    });
    expect(renderCacheStatus({ mode: "auto", dirty: false, report: cappedNoUpgrade })).toBe("ping 11/11 capped");
  });

  it("suppresses the →1h hint when the model/route doesn't support long cache retention, even in auto mode with budget enabled", () => {
    // Root-cause-adjacent fix: `compat.supportsLongCacheRetention: false` means
    // pi will never write `ttl:"1h"` for this model on this route, so promising
    // a transition that can never happen would be a lie.
    const capped = report({
      window: armedWindow({ pings: 11 }),
      config: config({ maxPings: 11 }),
      supportsLongCacheRetention: false,
    });
    expect(renderCacheStatus({ mode: "auto", dirty: false, report: capped })).toBe("ping 11/11 capped");
  });

  it("shows the per-window stop reason", () => {
    const text = renderCacheStatus({
      mode: "auto",
      dirty: false,
      report: report({ window: armedWindow({ pings: 1, lastStopReason: "http" }) }),
    });
    expect(text).toBe("ping paused:http");
  });

  it("shows the disabled state with reason and lifetime ping count", () => {
    const text = renderCacheStatus({
      mode: "auto",
      dirty: false,
      report: report({ session: baseSession({ disabled: { reason: "proven-write", at: 1 }, pings: 4 }) }),
    });
    expect(text).toBe("ping off:proven-write ×4");
  });
});

// ---------------------------------------------------------------------------
// adaptive segments: the status line is one terminal row shared with every
// other extension's status, so the adaptive segments are kept as short as they
// can be without losing a fact (structured `detail` keeps the exact values).
// ---------------------------------------------------------------------------

function adaptiveSnapshot(overrides: Partial<AdaptiveSnapshot> = {}): AdaptiveSnapshot {
  return {
    lastDecision: undefined,
    coverRemainingMs: undefined,
    upgradeWriteTokens: 0,
    writeBudgetTokens: 200_000,
    budgetFraction: 0,
    warmUpgrades: 0,
    coldUpgradesUsed: 0,
    coldUpgradeCap: 1,
    coldCooldownRemainingMs: undefined,
    longGapCount: 0,
    confirmed1hWrites: 0,
    unconfirmed1hWrites: 0,
    indirect1hConfirms: 0,
    ineffective1h: 0,
    droppedPending: 0,
    breaker: undefined,
    lastReconcile: undefined,
    ...overrides,
  };
}

describe("renderCacheStatus — adaptive segments", () => {
  it("keeps the plain 5m mode segment while adaptive is healthy", () => {
    expect(renderCacheStatus({ mode: "adaptive", dirty: false, report: undefined, adaptive: adaptiveSnapshot() })).toBe(
      "cache adaptive · 5m",
    );
  });

  it("abbreviates the near-cap budget as a percentage and the breaker reason", () => {
    const text = renderCacheStatus({
      mode: "adaptive",
      dirty: false,
      report: undefined,
      adaptive: adaptiveSnapshot({
        upgradeWriteTokens: 198_000,
        budgetFraction: 0.99,
        breaker: { reason: "warm-write-too-expensive", at: 1 },
      }),
    });
    // The `5m` segment is dropped: `off:<reason>` already implies it.
    expect(text).toBe("cache adaptive · budget 99% · off:warm-write-costly");
  });

  it("never rounds the budget percentage up to 100% before the cap is hit", () => {
    const text = renderCacheStatus({
      mode: "adaptive",
      dirty: false,
      report: undefined,
      adaptive: adaptiveSnapshot({ upgradeWriteTokens: 199_600, budgetFraction: 0.998 }),
    });
    expect(text).toContain("budget 99%");
  });

  it("keeps the exact tokens and the raw breaker id in the structured detail", () => {
    const snapshot = buildCacheStatusSnapshot({
      mode: "adaptive",
      dirty: false,
      report: undefined,
      adaptive: adaptiveSnapshot({
        upgradeWriteTokens: 198_000,
        budgetFraction: 0.99,
        breaker: { reason: "warm-write-too-expensive", at: 1 },
      }),
    });
    expect(snapshot.segments.find((s) => s.id === "adaptive:budget")?.detail).toEqual({
      upgradeWriteTokens: 198_000,
      writeBudgetTokens: 200_000,
    });
    expect(snapshot.segments.find((s) => s.id === "adaptive:breaker")?.detail).toMatchObject({
      reason: "warm-write-too-expensive",
      at: 1,
    });
  });

  it("keeps the upgrade / cover segments unchanged", () => {
    const text = renderCacheStatus({
      mode: "adaptive",
      dirty: false,
      report: undefined,
      adaptive: adaptiveSnapshot({
        lastDecision: {
          upgrade: true,
          class: "warm",
          reason: undefined,
          signals: ["subagent"],
          predictedDeltaTokens: 0,
          at: 1,
        },
        coverRemainingMs: 2_220_000,
      }),
    });
    expect(text).toBe("cache adaptive · →1h (subagent) · 1h cover 37m");
  });
});

describe("renderKeepaliveReportLines", () => {
  it("includes all the fields §9.4 requires", () => {
    const lines = renderKeepaliveReportLines(
      report({
        session: baseSession({
          pings: 2,
          cacheReadTokens: 1000,
          unprovenTotal: 1,
          consecutiveUnproven: 1,
          provenWrites: 0,
          loadBearingWindows: 1,
          loadBearingPings: 2,
          unnecessaryWindows: 1,
          unnecessaryPings: 1,
          avoidedMissTokens: 500,
          lastUnproven: { kind: "http", at: 42 },
        }),
        dropped: { sessionMismatch: 2, instanceMismatch: 1, epochMismatch: 3 },
        lastSkip: "not-armed",
      }),
    );
    const text = lines.join("\n");
    expect(text).toContain("session: 2 ping");
    expect(text).toContain("load-bearing 1 window/2 ping");
    expect(text).toContain("unnecessary 1 window/1 ping");
    expect(text).toContain("avoided rewrite 500 tok");
    expect(text).toContain("unprovenTotal=1 consecutiveUnproven=1 provenWrites=0");
    expect(text).toContain("sessionMismatch=2 instanceMismatch=1 epochMismatch=3");
    expect(text).toContain("last skip: not-armed");
    expect(text).toContain("prefix source: usage");
  });

  it("shows the long-cache-retention compat flag", () => {
    expect(renderKeepaliveReportLines(report({ supportsLongCacheRetention: true })).join("\n")).toContain(
      "long cache retention (1h) supported: yes",
    );
    expect(renderKeepaliveReportLines(report({ supportsLongCacheRetention: false })).join("\n")).toContain(
      "long cache retention (1h) supported: no",
    );
  });

  it("omits the last-ping diagnostics line before the first ping resolves this session", () => {
    const text = renderKeepaliveReportLines(report({ lastPingDiagnostics: undefined })).join("\n");
    expect(text).not.toContain("last ping:");
  });

  it("surfaces the full last-ping diagnostic trail (root-cause fix: no more session-file archaeology) without leaking header values", () => {
    const text = renderKeepaliveReportLines(
      report({
        lastPingDiagnostics: {
          at: 12_345,
          outcomeKind: "proven-write",
          elapsedSinceCaptureMs: 207_000,
          prefixTokens: 304_940,
          prefixSource: "usage",
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 310_925,
          headerSource: "captured+auth-filled",
          headerKeyDiff: ["x-api-key"],
          model: "claude-opus-5",
          baseUrl: "https://cloudrouter-anthropic.example.com",
        },
      }),
    ).join("\n");
    expect(text).toContain("last ping: proven-write @ 12345");
    expect(text).toContain("+207000ms since capture");
    expect(text).toContain("prefix 304940tok (usage)");
    expect(text).toContain("cache_read=0 cache_creation=310925");
    expect(text).toContain("headers: captured+auth-filled (filled: x-api-key)");
    expect(text).toContain("model=claude-opus-5");
    expect(text).toContain("baseUrl=https://cloudrouter-anthropic.example.com");
    // Never a header/auth VALUE (secrets) in the rendered text — only key names.
    expect(text).not.toMatch(/sk-ant/);
  });
});
