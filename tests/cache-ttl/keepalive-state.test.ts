import { describe, expect, it } from "vitest";
import {
  ASSUMED_TTL_MS,
  KEEPALIVE_EXTENSION_HEADER_NOTE,
  isProviderUnsupported,
  KEEPALIVE_AUDIT_CUSTOM_TYPE,
  TTL_SAFETY_MARGIN_MS,
  UNPROVEN_STREAK_LIMIT,
  UNPROVEN_TOTAL_LIMIT,
  buildFingerprint,
  buildCacheStatusSnapshot,
  cacheReadCostUsd,
  cacheWriteCostUsd,
  closeWindowAccounting,
  compareFingerprint,
  createInitialSessionTotals,
  createInitialWindowState,
  evaluateTick,
  isSuccessfulRealRequest,
  inspectPayload,
  invalidate,
  onPingStarted,
  onProvenHit,
  onRealRequest,
  onRequestSettled,
  onSuccessfulRealRequest,
  onUnproven,
  pingSegmentParts,
  readBackKeepaliveSessionState,
  renderCacheStatus,
  renderKeepaliveReportLines,
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

  it.each(["anthropic-messages", "openai-completions"])(
    "#4.7 github-copilot is a terminal provider-unsupported skip regardless of API (%s)",
    (api) => {
      const fp = fingerprint({ provider: "github-copilot", api });
      const window = armedWindow({ capture: captured({ fingerprint: fp }) });
      const result = evaluateTick({
        now: 240_000,
        mode: "tui",
        armed: true,
        config: config(),
        session: baseSession(),
        window,
        currentFingerprint: fp,
      });
      expect(result.decision).toEqual({ kind: "skip", reason: "provider-unsupported", terminal: true });
    },
  );

  it("#4.7 a virtual model (api pi-virtual) is provider-unsupported; a Copilot-billed custom provider id is not", () => {
    const virtual = fingerprint({ provider: "pi-router", api: "pi-virtual" });
    const base = { now: 240_000, mode: "tui", armed: true, config: config(), session: baseSession() };
    expect(
      evaluateTick({
        ...base,
        window: armedWindow({ capture: captured({ fingerprint: virtual }) }),
        currentFingerprint: virtual,
      }).decision,
    ).toEqual({ kind: "skip", reason: "provider-unsupported", terminal: true });
    expect(isProviderUnsupported(fingerprint({ provider: "copilot-anthropic" }))).toBe(false);
    const custom = fingerprint({ provider: "copilot-anthropic" });
    expect(
      evaluateTick({
        ...base,
        window: armedWindow({ capture: captured({ fingerprint: custom }) }),
        currentFingerprint: custom,
      }).decision,
    ).toEqual({ kind: "ping" });
  });

  it("#1.5 activationDisabled is a terminal activation-disabled skip, evaluated before any session breaker, with no persisted trace", () => {
    const window = armedWindow({ capture: captured() });
    const result = evaluateTick({
      now: 240_000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession({ disabled: { reason: "proven-write", at: 1 as never } }),
      window,
      currentFingerprint: fingerprint(),
      activationDisabled: true,
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "activation-disabled", terminal: true });
  });

  it("#10.5 io-busy is a NON-terminal skip, ahead of ping-in-flight; ioBusy false/absent is legacy behaviour", () => {
    const base = {
      now: 240_000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      currentFingerprint: fingerprint(),
    };
    const window = armedWindow({ capture: captured(), pingInFlight: true });
    expect(evaluateTick({ ...base, window, ioBusy: true }).decision).toEqual({
      kind: "skip",
      reason: "io-busy",
      terminal: false,
    });
    expect(evaluateTick({ ...base, window }).decision).toEqual({
      kind: "skip",
      reason: "ping-in-flight",
      terminal: false,
    });
    expect(evaluateTick({ ...base, window: armedWindow({ capture: captured() }), ioBusy: false }).decision).toEqual({
      kind: "ping",
    });
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

  it("#7 分流 (O2 follow-up): ttl1h capture + PROVEN 1h evidence ⇒ legacy ttl-1h skip (现状钉住)", () => {
    const window = armedWindow({
      capture: captured({ shape: { ephemeralBreakpoints: 1, ttl1h: true, hasThinking: false, maxTokens: undefined } }),
    });
    const result = evaluateTick({
      now: 240_000, // due — without the gate this window would ping
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint(),
      write1hEvidence: true,
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "ttl-1h", terminal: true });
  });

  it("#7 分流 (O2 follow-up): ttl1h capture + NO evidence ⇒ falls through to the normal ping path", () => {
    const window = armedWindow({
      capture: captured({ shape: { ephemeralBreakpoints: 1, ttl1h: true, hasThinking: false, maxTokens: undefined } }),
    });
    // Not yet due ⇒ behaves like any ordinary 5m window (not-due, non-terminal).
    const early = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint(),
      write1hEvidence: false,
    });
    expect(early.decision).toEqual({ kind: "skip", reason: "not-due", terminal: false });
    // Due ⇒ ping (the ttl strip itself happens in runPing, service layer).
    const due = evaluateTick({
      now: 240_000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint(),
      write1hEvidence: false,
    });
    expect(due.decision).toEqual({ kind: "ping" });
  });

  it("#7 分流 (O2 follow-up): write1hEvidence absent (no store wired) ⇒ legacy byte-identical skip", () => {
    const window = armedWindow({
      capture: captured({ shape: { ephemeralBreakpoints: 1, ttl1h: true, hasThinking: false, maxTokens: undefined } }),
    });
    const result = evaluateTick({
      now: 240_000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window,
      currentFingerprint: fingerprint(),
      // write1hEvidence deliberately omitted
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

  it("#12 not armed because the UI-prompt budget ran out ⇒ ui-prompt-expired, non-terminal", () => {
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: false,
      uiPromptExpired: true,
      config: config(),
      session: baseSession(),
      window: armedWindow(),
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "ui-prompt-expired", terminal: false });
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

  it("#14 budget exhausted ⇒ terminal skip; #15 not-due before that", () => {
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
    expect(result.window).toBe(window);

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

    let r = onUnproven(w, session, ep, "accepted-then-lost", 1);
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

    r = onUnproven(w, session, ep, "accepted-then-lost", 2);
    session = r.session;
    w = r.window;
    expect(session.unprovenTotal).toBe(2);
    expect(session.disabled).toBeUndefined();

    r = onUnproven(w, session, ep, "malformed", 3);
    session = r.session;
    expect(session.unprovenTotal).toBe(3);
    expect(session.disabled).toEqual({ reason: "malformed", at: 3, transient: true });
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

  it("classifies retryable HTTP statuses as transient but other 4xx as permanent", () => {
    const transient = onUnproven(armedWindow({ windowEpoch: 1 }), baseSession(), 1, "http", 1, 429);
    expect(transient.session.disabled).toBeUndefined();
    const permanent = onUnproven(armedWindow({ windowEpoch: 1 }), baseSession(), 1, "http", 1, 400);
    // 4xx is a line-level rejection: counted in lineStates, never in the session-level counters.
    expect(permanent.session.nonTransientUnprovenTotal).toBe(0);
    expect(permanent.session.transientUnprovenTotal).toBe(0);
    expect(Object.values(permanent.session.lineStates)[0]?.total).toBe(1);
    expect(permanent.session.disabled).toBeUndefined();
  });

  it("records the HTTP status on the disable when an http failure trips the breaker", () => {
    // non-transient 403 tripping the streak limit opens the LINE breaker (not session.disabled).
    let session = baseSession();
    let window = armedWindow({ windowEpoch: 1 });
    for (let i = 0; i < UNPROVEN_STREAK_LIMIT; i += 1) {
      window = armedWindow({ windowEpoch: 1 });
      const result = onUnproven(window, session, 1, "http", 100 + i, 403);
      session = result.session;
    }
    expect(session.disabled).toBeUndefined();
    const rec = Object.values(session.lineStates)[0];
    expect(rec).toMatchObject({ open: true, status: 403, trips: 1, openedAt: 100 + UNPROVEN_STREAK_LIMIT - 1 });

    // transient: 503 (never processed, retried until the window ran out) never trips the session (#29 r2).
    session = baseSession();
    window = armedWindow({ windowEpoch: 1 });
    for (let i = 0; i < UNPROVEN_TOTAL_LIMIT + 2; i += 1) {
      const result = onUnproven(window, session, 1, "http", 200 + i, 503);
      session = result.session;
      window = { ...result.window, windowEpoch: 1 };
    }
    expect(session.disabled).toBeUndefined();
    expect(session.transientUnprovenTotal).toBe(0);
    expect(session.unprovenTotal).toBe(UNPROVEN_TOTAL_LIMIT + 2);
    // the same holds for 408 and network.
    for (const [kind, status] of [
      ["http", 408],
      ["network", undefined],
    ] as const) {
      let s2 = baseSession();
      for (let i = 0; i < 5; i += 1) {
        s2 = onUnproven(armedWindow({ windowEpoch: 1 }), s2, 1, kind, 300 + i, status).session;
      }
      expect(s2.disabled).toBeUndefined();
    }
  });

  it("drops an out-of-range HTTP status instead of recording it on the disable", () => {
    let session = baseSession();
    for (let i = 0; i < UNPROVEN_STREAK_LIMIT; i += 1) {
      const result = onUnproven(armedWindow({ windowEpoch: 1 }), session, 1, "http", 100 + i, 99);
      session = result.session;
    }
    const rec = Object.values(session.lineStates)[0];
    expect(rec?.open).toBe(true);
    expect(rec?.status).toBeUndefined();
  });

  it("recovers a transient disable after a successful real provider response and resets transient counters", () => {
    let session = baseSession();
    let window = armedWindow({ windowEpoch: 1 });
    for (let i = 0; i < 2; i += 1) {
      const result = onUnproven(window, session, 1, "malformed", i + 1);
      session = result.session;
      window = { ...result.window, windowEpoch: 1 };
    }
    expect(session.disabled).toEqual({ reason: "malformed", at: 2, transient: true });
    expect(onSuccessfulRealRequest(session, false)).toBe(session);
    const recovered = onSuccessfulRealRequest(session, true);
    expect(recovered.disabled).toBeUndefined();
    expect(recovered.transientUnprovenTotal).toBe(0);
    expect(recovered.transientConsecutiveUnproven).toBe(0);
    expect(recovered.consecutiveUnproven).toBe(0);
  });

  it("does not recover from an errored/aborted real request, proven-write, or a permanent mixed case", () => {
    const permanent = baseSession({ disabled: { reason: "proven-write", at: 5 }, provenWrites: 1 });
    expect(onSuccessfulRealRequest(permanent, true)).toBe(permanent);

    let session = baseSession();
    let window = armedWindow({ windowEpoch: 1 });
    for (let i = 0; i < 2; i += 1) {
      const result = onUnproven(window, session, 1, "malformed", i + 1);
      session = result.session;
      window = { ...result.window, windowEpoch: 1 };
    }
    const mixed = onUnproven(window, session, 1, "proven-write", 3).session;
    expect(mixed.disabled).toEqual({ reason: "proven-write", at: 3 });
    expect(onSuccessfulRealRequest(mixed, true)).toBe(mixed);
  });

  it("recognizes only a usage-bearing, non-error assistant message as a successful real request", () => {
    expect(isSuccessfulRealRequest({ role: "assistant", usage: { input: 1 }, stopReason: "end_turn" })).toBe(true);
    expect(isSuccessfulRealRequest({ role: "assistant", usage: { input: 1 }, stopReason: "error" })).toBe(false);
    expect(isSuccessfulRealRequest({ role: "assistant", usage: undefined })).toBe(false);
    expect(isSuccessfulRealRequest({ role: "toolResult", usage: { input: 1 } })).toBe(false);
  });

  it("reads transient and permanent breaker snapshots back from the current branch", () => {
    const base = createInitialSessionTotals();
    const snapshot = (disabled: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      type: "custom",
      customType: "subagent:cache-keepalive",
      data: {
        kind: "unproven",
        session: {
          ...base,
          ...extra,
          disabled,
          lastUnproven: { kind: "network", at: 10 },
        },
      },
    });
    const transient = readBackKeepaliveSessionState([
      snapshot({ reason: "network", at: 10, transient: true }, { transientUnprovenTotal: 2 }),
    ]);
    // #29 r2 migration: a legacy transient pause is lifted on read-back (and idempotently so).
    expect(transient?.disabled).toBeUndefined();
    expect(transient?.transientUnprovenTotal).toBe(0);
    const permanent = readBackKeepaliveSessionState([snapshot({ reason: "no-usage", at: 11 })]);
    expect(permanent?.disabled).toEqual({ reason: "no-usage", at: 11 });
  });

  it("preserves a valid httpStatus through snapshot read-back and drops invalid ones", () => {
    const base = createInitialSessionTotals();
    const snapshot = (disabled: Record<string, unknown>) => ({
      type: "custom",
      customType: "subagent:cache-keepalive",
      data: { kind: "unproven", session: { ...base, disabled } },
    });
    // a legacy transient pause is lifted on read-back (#29 r2 migration).
    expect(
      readBackKeepaliveSessionState([snapshot({ reason: "http", at: 10, transient: true, httpStatus: 503 })])?.disabled,
    ).toBeUndefined();
    // legacy record without httpStatus reads back unchanged.
    expect(readBackKeepaliveSessionState([snapshot({ reason: "http", at: 10 })])?.disabled).toEqual({
      reason: "http",
      at: 10,
    });
    // invalid statuses are dropped; the disable itself survives.
    for (const bad of [99, 600, 403.5, "403", Number.NaN]) {
      expect(readBackKeepaliveSessionState([snapshot({ reason: "http", at: 10, httpStatus: bad })])?.disabled).toEqual({
        reason: "http",
        at: 10,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// invalidate()
// ---------------------------------------------------------------------------

describe("invalidate", () => {
  it("clears capture and bumps windowEpoch, nothing else", () => {
    const window = armedWindow({ pings: 4, requestInFlight: true, windowEpoch: 2 });
    const next = invalidate(window, "session-compact");
    expect(next).toEqual({ ...window, capture: undefined, windowEpoch: 3 });
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

  it("shows the capped budget without any 1h-upgrade hint in every mode", () => {
    const capped = report({ window: armedWindow({ pings: 11 }), config: config({ maxPings: 11 }) });
    expect(renderCacheStatus({ mode: "auto", dirty: false, report: capped })).toBe("ping 11/11 capped");
    expect(renderCacheStatus({ mode: "off", dirty: false, report: capped })).toBe("cache 5m · ping 11/11 capped");
    expect(renderCacheStatus({ mode: "on", dirty: false, report: capped })).toBe("cache 1h · ping 11/11 capped");
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
    expect(text).toBe("ping miss:http");
  });

  it("shows the disabled state with reason and lifetime ping count", () => {
    const text = renderCacheStatus({
      mode: "auto",
      dirty: false,
      report: report({ session: baseSession({ disabled: { reason: "proven-write", at: 1 }, pings: 4 }) }),
    });
    expect(text).toBe("ping off:proven-write ×4");
  });

  it("shows the HTTP status code for an http disable, transient or permanent", () => {
    const permanent = renderCacheStatus({
      mode: "auto",
      dirty: false,
      report: report({ session: baseSession({ disabled: { reason: "http", at: 1, httpStatus: 403 } }) }),
    });
    expect(permanent).toBe("ping off:http 403 ×0");
    const transient = renderCacheStatus({
      mode: "auto",
      dirty: false,
      report: report({
        session: baseSession({ disabled: { reason: "http", at: 1, transient: true, httpStatus: 503 }, pings: 2 }),
      }),
    });
    expect(transient).toBe("ping off:http 503 ×2");
  });

  it("keeps the legacy text for an http disable without a recorded status", () => {
    const text = renderCacheStatus({
      mode: "auto",
      dirty: false,
      report: report({ session: baseSession({ disabled: { reason: "http", at: 1 }, pings: 3 }) }),
    });
    expect(text).toBe("ping off:http ×3");
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

// ---------------------------------------------------------------------------
// T-K1 (child-ka-core, docs/dev/child-context-switch/plan.md §2.4/§7 P1):
// `KeepaliveConfig.allowHeadless`/`maxSessionPings`, the two new pure gates
// they drive in `evaluateTick`, `nativeWarmerActive`, and `cacheWriteCostUsd`.
// ---------------------------------------------------------------------------

describe("evaluateTick — child-ka-core: allowHeadless (gate #4/G2)", () => {
  it("main session default (allowHeadless unset): print/json/batch still rejected", () => {
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

  it("allowHeadless: true additionally allows print (a child session's run mode)", () => {
    const result = evaluateTick({
      now: 1000,
      mode: "print",
      armed: true,
      config: config({ allowHeadless: true }),
      session: baseSession(),
      window: armedWindow(),
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).not.toEqual({ kind: "skip", reason: "mode", terminal: true });
  });

  it("allowHeadless: true does not resurrect json/batch — only print", () => {
    for (const mode of ["json", "batch"]) {
      const result = evaluateTick({
        now: 1000,
        mode,
        armed: true,
        config: config({ allowHeadless: true }),
        session: baseSession(),
        window: armedWindow(),
        currentFingerprint: fingerprint(),
      });
      expect(result.decision).toEqual({ kind: "skip", reason: "mode", terminal: true });
    }
  });

  it("tui/rpc are unaffected by allowHeadless either way", () => {
    for (const mode of ["tui", "rpc"]) {
      for (const allowHeadless of [undefined, true, false]) {
        const result = evaluateTick({
          now: 1000,
          mode,
          armed: true,
          config: config({ allowHeadless }),
          session: baseSession(),
          window: armedWindow(),
          currentFingerprint: fingerprint(),
        });
        expect(result.decision).not.toEqual({ kind: "skip", reason: "mode", terminal: true });
      }
    }
  });
});

describe("evaluateTick — child-ka-core: maxSessionPings (per-run proven-hit cap, session-cap)", () => {
  it("undefined (main session default) never triggers session-cap regardless of session.pings", () => {
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession({ pings: 1_000_000 }),
      window: armedWindow(),
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).not.toMatchObject({ reason: "session-cap" });
  });

  it("session.pings >= maxSessionPings ⇒ session-cap, terminal", () => {
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config({ maxSessionPings: 24 }),
      session: baseSession({ pings: 24 }),
      window: armedWindow(),
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "session-cap", terminal: true });
  });

  it("session.pings just below maxSessionPings still pings normally", () => {
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config({ maxSessionPings: 24 }),
      session: baseSession({ pings: 23 }),
      window: armedWindow({ nextPingAt: 0 }),
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).toEqual({ kind: "ping" });
  });

  it("maxSessionPings: 0 ⇒ session-cap immediately (0 = never ping this run)", () => {
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config({ maxSessionPings: 0 }),
      session: baseSession({ pings: 0 }),
      window: armedWindow(),
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "session-cap", terminal: true });
  });

  it("session-cap wins over session-disabled's absence but session-disabled (#2) still wins over it when both apply", () => {
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config({ maxSessionPings: 1 }),
      session: baseSession({ pings: 5, disabled: { reason: "proven-write", at: 1 } }),
      window: armedWindow(),
      currentFingerprint: fingerprint(),
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "session-disabled", terminal: true });
  });
});

describe("evaluateTick — child-ka-core: nativeWarmerActive (avoid double-warming pi's own CacheWarmer)", () => {
  it("absent/false ⇒ today's behavior (unaffected)", () => {
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window: armedWindow({ nextPingAt: 0 }),
      currentFingerprint: fingerprint(),
      nativeWarmerActive: false,
    });
    expect(result.decision).toEqual({ kind: "ping" });
  });

  it("true ⇒ native-warmer, terminal, wins over an otherwise-pingable window", () => {
    const result = evaluateTick({
      now: 1000,
      mode: "tui",
      armed: true,
      config: config(),
      session: baseSession(),
      window: armedWindow(),
      currentFingerprint: fingerprint(),
      nativeWarmerActive: true,
    });
    expect(result.decision).toEqual({ kind: "skip", reason: "native-warmer", terminal: true });
  });
});

describe("cacheWriteCostUsd (child-ka-core, mirrors cacheReadCostUsd's tier selection)", () => {
  it("returns undefined for an unknown/zero rate, tokens<=0, or no cost model", () => {
    expect(cacheWriteCostUsd(undefined, 10_000)).toBeUndefined();
    expect(cacheWriteCostUsd({}, 10_000)).toBeUndefined();
    expect(cacheWriteCostUsd({ cacheWrite: 0 }, 10_000)).toBeUndefined();
    expect(cacheWriteCostUsd({ cacheWrite: 5 }, 0)).toBeUndefined();
    expect(cacheWriteCostUsd({ cacheWrite: 5 }, -1)).toBeUndefined();
  });

  it("prices at the base rate ($/M tokens)", () => {
    expect(cacheWriteCostUsd({ cacheWrite: 5 }, 1_000_000)).toBe(5);
    expect(cacheWriteCostUsd({ cacheWrite: 12.5 }, 500_000)).toBeCloseTo(6.25, 6);
  });

  it("selects the highest matching tier (mirrors pi-ai models.js calculateCost)", () => {
    const cost = { cacheWrite: 12.5, tiers: [{ inputTokensAbove: 272_000, cacheWrite: 25 }] };
    expect(cacheWriteCostUsd(cost, 100_000)).toBeCloseTo(1.25, 6); // base rate, below the tier threshold
    expect(cacheWriteCostUsd(cost, 300_000)).toBeCloseTo(7.5, 6); // tier rate: 300_000 > 272_000
  });

  it("does not confuse the read and write rates — independent of cacheReadCostUsd", () => {
    const cost = { cacheRead: 1, cacheWrite: 12.5 };
    expect(cacheReadCostUsd(cost, 1_000_000)).toBe(1);
    expect(cacheWriteCostUsd(cost, 1_000_000)).toBe(12.5);
  });

  it("a tier missing cacheWrite falls back to the base rate for that tier boundary", () => {
    const cost = { cacheWrite: 12.5, tiers: [{ inputTokensAbove: 272_000, cacheRead: 2 }] }; // no cacheWrite on the tier
    expect(cacheWriteCostUsd(cost, 300_000)).toBeCloseTo(3.75, 6); // still the base 12.5 rate
  });
});

describe("dynamic cap report text and ended windows", () => {
  it.each([
    [{ maxPings: 48, maxPingsSource: "priced" }, "cap: 48/window (priced)"],
    [{ maxPings: 96, maxPingsSource: "clamped", maxPingsRaw: 2000 }, "cap: 96/window (clamped from 2000)"],
    [{ maxPings: 96, maxPingsSource: "clamped", maxPingsRaw: 2 ** 54 }, "cap: 96/window (clamped)"],
    [
      { maxPings: 11, maxPingsSource: "fallback", maxPingsReason: "tier-uncertain" },
      "cap: 11/window (fallback: tier-uncertain)",
    ],
    [{ maxPings: 11 }, "cap: 11/window ·"],
  ])("source display %j", (over, text) => {
    const r = report({ config: config(over as Partial<KeepaliveConfig>) });
    expect(renderKeepaliveReportLines(r)[1]).toContain(text);
  });
  it("invalidated old 20-ping window never reads as 20/11 capped", () => {
    const r = report({
      window: armedWindow({ capture: undefined, pings: 20 }),
      session: baseSession({ pings: 20, cacheReadTokens: 450_000 }),
      costUsd: 0.12,
    });
    expect(renderCacheStatus({ mode: "auto", dirty: false, report: r })).toBe("ping Σ20 · 450k · ≈$0.12");
    expect(renderKeepaliveReportLines(r)).toContain("window: ended (Σ20 pings)");
    expect(renderKeepaliveReportLines(r).join("\n")).not.toContain("20/11");
  });
});

describe("r_FFWC8SBT — report distinguishes fresh and invalidated windows", () => {
  it("a never-opened window keeps the original zero/maximum idle text", () => {
    const r = report({ window: createInitialWindowState(), session: baseSession(), armed: false });
    expect(renderKeepaliveReportLines(r)).toContain("window: 0/11 (idle)");
    expect(renderKeepaliveReportLines(r).join("\n")).not.toContain("ended");
  });
  it.each([
    { windowEpoch: 1, pings: 0 },
    { windowEpoch: 0, pings: 20 },
  ])("an invalidated or previously active window is ended (%j)", (history) => {
    const r = report({
      window: { ...createInitialWindowState(), ...history },
      session: baseSession({ pings: history.pings }),
    });
    expect(renderKeepaliveReportLines(r)).toContain(`window: ended (Σ${history.pings} pings)`);
  });
  it.each([
    "unpriced",
    "no-read",
    "no-write",
    "write-le-read",
    "non-finite",
    "tier-uncertain",
    "tier-incomplete",
    "wire-model-unmapped",
  ])("fallback renders its real reason: %s", (reason) => {
    const r = report({ config: config({ maxPingsSource: "fallback", maxPingsReason: reason }) });
    expect(renderKeepaliveReportLines(r)[1]).toContain(`cap: 11/window (fallback: ${reason})`);
  });
  it("an old config without a fallback reason uses unpriced", () => {
    const r = report({ config: config({ maxPingsSource: "fallback" }) });
    expect(renderKeepaliveReportLines(r)[1]).toContain("cap: 11/window (fallback: unpriced)");
  });
});

describe("r7 §3.4 — ruling-6 residual note, activation-disabled report, never persisted", () => {
  it("renderKeepaliveReportLines carries the observed-only residual note whenever keepalive is enabled (and only then)", () => {
    const on = renderKeepaliveReportLines(report({ enabled: true }));
    expect(on).toContain(KEEPALIVE_EXTENSION_HEADER_NOTE);
    expect(KEEPALIVE_EXTENSION_HEADER_NOTE).toBe(
      "note: headers added by other extensions are not replayed — if they steer routing/cache, pings may write to another backend; keepalive stops for this session once a current-epoch proven-write is observed",
    );
    // wording must NOT claim the unknown cost is bounded to one ping
    expect(KEEPALIVE_EXTENSION_HEADER_NOTE).not.toMatch(/one ping|at most one|single ping/i);
    expect(renderKeepaliveReportLines(report({ enabled: false }))).not.toContain(KEEPALIVE_EXTENSION_HEADER_NOTE);
  });

  it("report lines + status segment surface an activation disable; the pipeline header source renders", () => {
    const r = report({ activationDisabled: { reason: "transport-unsupported", at: 7 as never } });
    expect(renderKeepaliveReportLines(r).join("\n")).toContain("activation disabled: transport-unsupported @ 7");
    expect(pingSegmentParts(r)).toMatchObject({ state: "disabled" });
    expect(pingSegmentParts(r)?.text).toContain("transport-unsupported");
    const d = report({
      lastPingDiagnostics: {
        at: 5 as never,
        outcomeKind: "proven-hit",
        elapsedSinceCaptureMs: 1,
        prefixTokens: 1,
        prefixSource: "usage",
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 0,
        headerSource: "pipeline",
        headerKeyDiff: [],
        model: "m",
        baseUrl: "u",
      },
    });
    expect(renderKeepaliveReportLines(d).join("\n")).toContain("headers: pipeline");
  });

  it("an activation-only disable lives outside SessionTotals: a persisted session snapshot never carries it, readBack ignores it", () => {
    const branch = [
      {
        type: "custom",
        customType: KEEPALIVE_AUDIT_CUSTOM_TYPE,
        data: {
          kind: "x",
          session: {
            ...baseSession({ provenWrites: 1 }),
            disabled: null,
            activationDisabled: { reason: "transport-unsupported", at: 1 },
          },
        },
      },
    ];
    const restored = readBackKeepaliveSessionState(branch);
    expect(restored?.provenWrites).toBe(1);
    expect(restored?.disabled).toBeUndefined();
    expect("activationDisabled" in (restored as object)).toBe(false);
  });
});
