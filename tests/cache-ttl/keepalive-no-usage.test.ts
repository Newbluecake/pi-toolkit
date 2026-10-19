/**
 * 2026-10-20 ruling: the keepalive `no-usage` breaker is LINE-level (same line key as an HTTP 4xx
 * breaker), never `session.disabled`, and a same-line real success that reports cache usage clears it
 * immediately (no cooldown). `proven-write` stays a permanent session-level disable.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import {
  KEEPALIVE_AUDIT_CUSTOM_TYPE,
  LINE_KEY_WILDCARD,
  UNPROVEN_STREAK_LIMIT,
  UNPROVEN_TOTAL_LIMIT,
  createInitialSessionTotals,
  createInitialWindowState,
  evaluateTick,
  lineKeyOf,
  onProvenHit,
  onSuccessfulRealRequest,
  onUnproven,
  pingSegmentParts,
  readBackKeepaliveSessionState,
  realRequestReportedCacheUsage,
  renderCacheStatus,
  renderKeepaliveReportLines,
  resetAllBreakers,
  type CaptureFingerprint,
  type CapturedRequest,
  type KeepaliveReport,
  type SessionTotals,
  type WindowState,
} from "../../src/cache-ttl/keepalive-state.js";
import { createProviderEvidenceStore } from "../../src/cache-ttl/provider-evidence.js";
import type { CacheTtlSettings } from "../../src/config/settings.js";
import { createCacheKeepaliveService } from "./fake-pipeline.js";

const fp = (o: Partial<CaptureFingerprint> = {}): CaptureFingerprint => ({
  sessionId: "s1",
  provider: "kimi-coding",
  api: "anthropic-messages",
  modelId: "k3",
  ctxModelId: "k3",
  baseUrl: "https://api.kimi.com/coding",
  authHeaderKeys: "",
  breakpointPath: "messages.0",
  thinkingDigest: "",
  systemDigest: "",
  toolsDigest: "",
  messageCount: 1,
  ...o,
});
const OTHER = {
  provider: "anthropic",
  ctxModelId: "claude",
  modelId: "claude",
  baseUrl: "https://api.anthropic.com",
};
const cap = (f: Partial<CaptureFingerprint> = {}): CapturedRequest => ({
  sessionId: "s1",
  instance: "i",
  payload: { model: "k3", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true },
  fingerprint: fp(f),
  shape: { ephemeralBreakpoints: 1, ttl1h: false, hasThinking: false, maxTokens: 10 },
  prefix: { tokens: 30_000, source: "usage" },
  capturedAt: 0,
});
const win = (f: Partial<CaptureFingerprint> = {}): WindowState => ({
  ...createInitialWindowState(),
  capture: cap(f),
  windowEpoch: 1,
  windowStartAt: 0,
  lastReadStartedAt: 0,
  aliveUntil: 300_000,
  nextPingAt: 240_000,
});
const noUsage = (s: SessionTotals, now: number, f: Partial<CaptureFingerprint> = {}) =>
  onUnproven(win(f), s, 1, "no-usage", now as never).session;
const trip = (s: SessionTotals, now: number, f: Partial<CaptureFingerprint> = {}) => {
  let out = s;
  for (let i = 0; i < UNPROVEN_STREAK_LIMIT; i += 1) out = noUsage(out, now + i, f);
  return out;
};
const lineKey = (f: Partial<CaptureFingerprint> = {}) => lineKeyOf(fp(f))!;
const OTHER_KEY = lineKeyOf(fp(OTHER))!;

describe("no-usage is a line-level breaker", () => {
  it("trips per line on the consecutive threshold; never touches session.disabled / nonTransient*", () => {
    let s = noUsage(createInitialSessionTotals(), 1);
    expect(s.noUsageStates[lineKey().key]).toMatchObject({ open: false, consecutive: 1, total: 1 });
    s = noUsage(s, 2);
    expect(s.noUsageStates[lineKey().key]).toMatchObject({ open: true, trips: 1, openedAt: 2, resetEligibleAt: 2 });
    expect(s.disabled).toBeUndefined();
    expect(s.nonTransientConsecutiveUnproven).toBe(0);
    expect(s.nonTransientUnprovenTotal).toBe(0);
    expect(s.lastUnproven).toEqual({ kind: "no-usage", at: 2 });
    // HTTP line breaker map untouched.
    expect(s.lineStates).toEqual({});
  });

  it("trips on the total threshold when a transient failure interrupts the streak", () => {
    let s = createInitialSessionTotals();
    for (let i = 0; i < UNPROVEN_TOTAL_LIMIT; i += 1) {
      s = noUsage(s, 10 * i);
      if (i < UNPROVEN_TOTAL_LIMIT - 1) {
        s = onUnproven(win(), s, 1, "network", (10 * i + 1) as never).session; // consecutive := 0, total kept
        expect(s.noUsageStates[lineKey().key]?.open).toBe(false);
      }
    }
    expect(s.noUsageStates[lineKey().key]).toMatchObject({ open: true, total: UNPROVEN_TOTAL_LIMIT });
    expect(s.disabled).toBeUndefined();
  });

  it("a proven hit on the line deletes a closed record (counters restart)", () => {
    const s = noUsage(createInitialSessionTotals(), 1);
    const hit = onProvenHit(win(), s, 1, { kind: "proven-hit", cacheReadTokens: 5 } as never, 240_000 as never);
    expect(hit.session.noUsageStates[lineKey().key]).toBeUndefined();
  });

  it("is independent of an HTTP breaker on the same line (separate maps/counters)", () => {
    let s = trip(createInitialSessionTotals(), 1);
    s = onUnproven(win(), s, 1, "http", 20 as never, 403).session;
    expect(s.lineStates[lineKey().key]).toMatchObject({ open: false, consecutive: 1, status: 403 });
    expect(s.noUsageStates[lineKey().key]?.open).toBe(true);
  });

  it("unresolvable line falls to the wildcard", () => {
    const s = trip(createInitialSessionTotals(), 5, { provider: "", ctxModelId: "" });
    expect(s.noUsageStates[LINE_KEY_WILDCARD]).toMatchObject({ open: true, trips: 1 });
    expect(s.disabled).toBeUndefined();
  });

  it("evaluateTick: only the tripped line is skipped (line-no-usage); another line keeps pinging", () => {
    const s = trip(createInitialSessionTotals(), 1);
    const base = {
      config: { enabled: true, intervalMs: 240_000, maxPings: 11, minPrefixTokens: 20_000 },
      armed: true,
      mode: "tui",
      now: 3 as never,
    };
    expect(evaluateTick({ ...base, session: s, window: win(), currentFingerprint: fp() }).decision).toMatchObject({
      kind: "skip",
      reason: "line-no-usage",
      terminal: true,
    });
    const other = evaluateTick({ ...base, session: s, window: win(OTHER), currentFingerprint: fp(OTHER) });
    expect(other.decision).not.toMatchObject({ kind: "skip", reason: "line-no-usage" });
    expect(other.decision).not.toMatchObject({ kind: "skip", reason: "line-disabled" });
    expect(other.decision).not.toMatchObject({ kind: "skip", reason: "session-disabled" });
  });

  it("proven-write stays a permanent session-level disable that no success lifts", () => {
    const w = onUnproven(win(), createInitialSessionTotals(), 1, "proven-write", 1 as never).session;
    expect(w.disabled?.reason).toBe("proven-write");
    expect(w.noUsageStates).toEqual({});
    const after = onSuccessfulRealRequest(w, true, { line: lineKey(), now: 999 as never, cacheUsage: true });
    expect(after.disabled?.reason).toBe("proven-write");
  });
});

describe("no-usage recovery (no cooldown)", () => {
  const tripped = () => trip(createInitialSessionTotals(), 100);

  it("a same-line real success that reported cache usage clears immediately, at any `now`", () => {
    const s = tripped();
    const out = onSuccessfulRealRequest(s, true, { line: lineKey(), now: 101 as never, cacheUsage: true });
    expect(out.noUsageStates[lineKey().key]).toBeUndefined();
    expect(out.disabled).toBeUndefined();
  });

  it("a real success WITHOUT cache usage (or unflagged) leaves it tripped, returning the same reference", () => {
    const s = tripped();
    expect(onSuccessfulRealRequest(s, true, { line: lineKey(), now: 101 as never, cacheUsage: false })).toBe(s);
    expect(onSuccessfulRealRequest(s, true, { line: lineKey(), now: 101 as never })).toBe(s);
    expect(onSuccessfulRealRequest(s, false, { line: lineKey(), now: 101 as never, cacheUsage: true })).toBe(s);
  });

  it("a success on ANOTHER line does not clear it; switching back stays tripped until usage is reported there", () => {
    const s = tripped();
    const other = onSuccessfulRealRequest(s, true, { line: OTHER_KEY, now: 101 as never, cacheUsage: true });
    expect(other.noUsageStates[lineKey().key]?.open).toBe(true);
    expect(onSuccessfulRealRequest(other, true, { line: lineKey(), now: 102 as never, cacheUsage: false })).toBe(other);
    expect(
      onSuccessfulRealRequest(other, true, { line: lineKey(), now: 103 as never, cacheUsage: true }).noUsageStates,
    ).toEqual({});
  });

  it("a wildcard breaker is cleared by any usage-reporting success", () => {
    const s = trip(createInitialSessionTotals(), 5, { provider: "", ctxModelId: "" });
    const out = onSuccessfulRealRequest(s, true, { line: undefined, now: 9 as never, cacheUsage: true });
    expect(out.noUsageStates).toEqual({});
  });

  it("realRequestReportedCacheUsage: read>0 or write>0 of a successful response only", () => {
    const m = (usage: unknown, stopReason = "stop") => ({ role: "assistant", stopReason, usage });
    expect(realRequestReportedCacheUsage(m({ input: 1, cacheRead: 5, cacheWrite: 0 }))).toBe(true);
    expect(realRequestReportedCacheUsage(m({ input: 1, cacheRead: 0, cacheWrite: 7 }))).toBe(true);
    expect(realRequestReportedCacheUsage(m({ input: 1, cacheRead: 0, cacheWrite: 0 }))).toBe(false);
    expect(realRequestReportedCacheUsage(m({ input: 1 }))).toBe(false);
    expect(realRequestReportedCacheUsage(m({ cacheRead: 9 }, "error"))).toBe(false);
    expect(realRequestReportedCacheUsage(undefined)).toBe(false);
  });
});

describe("no-usage persistence / migration / reset", () => {
  const entry = (session: Record<string, unknown>) => ({
    type: "custom",
    customType: KEEPALIVE_AUDIT_CUSTOM_TYPE,
    data: { session },
  });

  it("round-trips noUsageStates through a snapshot", () => {
    const s = trip(createInitialSessionTotals(), 5);
    const back = readBackKeepaliveSessionState([entry({ ...s })])!;
    expect(back.noUsageStates).toEqual(s.noUsageStates);
    expect(back.disabled).toBeUndefined();
  });

  it("migrates a legacy permanent disabled{no-usage} to a wildcard breaker, idempotently, and the next usage success clears it", () => {
    const migrated = readBackKeepaliveSessionState([
      entry({
        disabled: { reason: "no-usage", at: 3 },
        nonTransientConsecutiveUnproven: 2,
        nonTransientUnprovenTotal: 2,
      }),
    ])!;
    expect(migrated.disabled).toBeUndefined();
    expect(migrated.nonTransientConsecutiveUnproven).toBe(0);
    expect(migrated.nonTransientUnprovenTotal).toBe(0);
    expect(migrated.noUsageStates[LINE_KEY_WILDCARD]).toMatchObject({ open: true, openedAt: 3, trips: 1 });
    const again = readBackKeepaliveSessionState([
      entry({ ...migrated, disabled: migrated.disabled ?? null, lastUnproven: null }),
    ])!;
    expect(again.noUsageStates).toEqual(migrated.noUsageStates);
    expect(again.disabled).toBeUndefined();
    expect(onSuccessfulRealRequest(migrated, true, { line: lineKey(), now: 50 as never, cacheUsage: false })).toBe(
      migrated,
    );
    expect(
      onSuccessfulRealRequest(migrated, true, { line: lineKey(), now: 50 as never, cacheUsage: true }).noUsageStates,
    ).toEqual({});
  });

  it("does not migrate proven-write; sanitizes dirty noUsageStates without throwing", () => {
    const pw = readBackKeepaliveSessionState([entry({ disabled: { reason: "proven-write", at: 1 } })])!;
    expect(pw.disabled?.reason).toBe("proven-write");
    expect(pw.noUsageStates).toEqual({});
    for (const bad of [[], "x", 7, { "bad key": { label: "x", updatedAt: 1 } }]) {
      expect(readBackKeepaliveSessionState([entry({ noUsageStates: bad })])!.noUsageStates).toEqual({});
    }
  });

  it("resetAllBreakers clears no-usage breakers and counts them as open lines", () => {
    const s = trip(createInitialSessionTotals(), 1);
    const { session, summary } = resetAllBreakers(s);
    expect(session.noUsageStates).toEqual({});
    expect(summary.openLines).toBe(1);
  });
});

describe("no-usage HUD / status text", () => {
  const mkReport = (session: SessionTotals, extra: Partial<KeepaliveReport> = {}): KeepaliveReport => ({
    enabled: true,
    armed: true,
    window: win(),
    session,
    config: { enabled: true, intervalMs: 240_000, maxPings: 11, minPrefixTokens: 20_000 },
    costUsd: undefined,
    dropped: { sessionMismatch: 0, instanceMismatch: 0, epochMismatch: 0 },
    lastSkip: undefined,
    prefixSource: undefined,
    supportsLongCacheRetention: true,
    lastPingDiagnostics: undefined,
    ...extra,
  });

  it("shows `ping off:no-usage` only while the CURRENT line's breaker is open (and for the wildcard)", () => {
    const s = trip(createInitialSessionTotals(), 1);
    const cur = pingSegmentParts(mkReport(s, { currentLineKey: lineKey().key }))!;
    expect(cur).toEqual({ text: "ping off:no-usage", state: "line-off" });
    expect(
      renderCacheStatus({
        mode: "auto",
        dirty: false,
        report: mkReport(s, { currentLineKey: lineKey().key }),
      } as never),
    ).toContain("ping off:no-usage");
    expect(pingSegmentParts(mkReport(s, { currentLineKey: OTHER_KEY.key }))?.text ?? "").not.toContain("no-usage");
    const wild = trip(createInitialSessionTotals(), 1, { provider: "", ctxModelId: "" });
    expect(pingSegmentParts(mkReport(wild, { currentLineKey: lineKey().key }))?.text).toBe("ping off:no-usage");
  });

  it("an HTTP line breaker keeps its own `ping off:http` text and wins over no-usage", () => {
    let s = trip(createInitialSessionTotals(), 1);
    for (let i = 0; i < 2; i += 1) s = onUnproven(win(), s, 1, "http", (10 + i) as never, 403).session;
    expect(pingSegmentParts(mkReport(s, { currentLineKey: lineKey().key }))?.text).toBe("ping off:http 403");
  });

  it("/cache-ttl status explains per-line scope and the lift condition", () => {
    const s = trip(createInitialSessionTotals(), 1);
    const lines = renderKeepaliveReportLines(mkReport(s, { currentLineKey: lineKey().key }));
    const line = lines.find((l) => l.startsWith("line off:") && l.includes("no-usage"));
    expect(line).toBeDefined();
    expect(line).toContain("kimi-coding/k3@api.kimi.com");
    expect(line).toContain("per-line");
    expect(line).toContain("next real response that reports cache usage");
    expect(lines).toContain("not disabled");
  });
});

// ---------------------------------------------------------------------------
// service integration (FakeClock + scripted fetch)
// ---------------------------------------------------------------------------
const enc = new TextEncoder();
const sse = (cacheRead: number, cacheWrite: number): Response => {
  let done = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        cancel: async () => {},
        read: async () => {
          if (done) return { done: true, value: undefined };
          done = true;
          return {
            done: false,
            value: enc.encode(
              `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite } } })}\n\n`,
            ),
          };
        },
      }),
    },
  } as unknown as Response;
};
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};
const SETTINGS: CacheTtlSettings = {
  mode: "auto",
  keepalive: true,
  keepaliveIntervalMs: 240_000,
  keepaliveMinPrefixTokens: 20_000,
};

function svc() {
  const clock = new FakeClock(0);
  const ctx = {
    ui: { setStatus: vi.fn() },
    mode: "tui",
    model: {
      provider: "kimi-coding",
      api: "anthropic-messages",
      id: "k3",
      baseUrl: "https://api.kimi.com/coding",
      cost: { cacheRead: 0.3, tiers: [] },
    },
    modelRegistry: { getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "k", headers: {} }) },
    sessionManager: { getSessionId: () => "s1" },
  };
  let self: unknown;
  const appendEntry = vi.fn();
  let usage: [number, number] = [0, 0];
  const fetchImpl = vi.fn(async () => sse(usage[0], usage[1])) as unknown as typeof fetch;
  const evidence = createProviderEvidenceStore(join(mkdtempSync(join(tmpdir(), "ka-nu-")), "ev.json"));
  const service = createCacheKeepaliveService({
    clock,
    ctx: ctx as never,
    sessionId: "s1",
    settings: { ...SETTINGS },
    backgroundBusy: () => true,
    isCurrent: (s) => self === s,
    fetchImpl,
    appendEntry,
    recoverTransientFailures: true,
    persistSessionState: true,
    evidence,
  });
  self = service;
  const request = (f: Partial<CaptureFingerprint> = {}) =>
    service.noteRequest({ ...cap(f), instance: service.instanceId });
  const calls = () => (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length;
  const switchTo = (to: "kimi" | "other") => {
    ctx.model =
      to === "kimi"
        ? { ...ctx.model, provider: "kimi-coding", id: "k3", baseUrl: "https://api.kimi.com/coding" }
        : { ...ctx.model, provider: "anthropic", id: "claude", baseUrl: "https://api.anthropic.com" };
    service.invalidate("model-select", "s1", service.instanceId);
  };
  const window = async () => {
    service.noteRequestSettled("s1", service.instanceId);
    service.report(); // no-op read
    clock.advance(240_000);
    await flush();
  };
  return {
    clock,
    service,
    request,
    calls,
    switchTo,
    window,
    appendEntry,
    setUsage: (u: [number, number]) => (usage = u),
  };
}

describe("no-usage service lifecycle", () => {
  it("trips per line, other line keeps pinging, model switch resumes, switching back stays tripped", async () => {
    const h = svc();
    // line A (kimi): two no-usage pings (one per window) ⇒ line breaker, session NOT disabled.
    for (let i = 0; i < 2; i += 1) {
      h.request();
      await h.window();
    }
    const r1 = h.service.report();
    expect(r1.session.disabled).toBeUndefined();
    expect(Object.values(r1.session.noUsageStates).filter((r) => r.open)).toHaveLength(1);
    const afterTrip = h.calls();

    // A next window: terminal line-no-usage skip, no more pings.
    h.request();
    await h.window();
    expect(h.service.report().lastSkip).toBe("line-no-usage");
    expect(h.calls()).toBe(afterTrip);

    // switch to line B: resumes pinging (hit).
    h.setUsage([500, 0]);
    h.switchTo("other");
    h.request(OTHER);
    await h.window();
    expect(h.calls()).toBeGreaterThan(afterTrip);
    expect(h.service.report().session.pings).toBe(1);
    expect(h.service.report().session.disabled).toBeUndefined();

    // switch back to A: still tripped.
    const beforeBack = h.calls();
    h.switchTo("kimi");
    h.request();
    await h.window();
    expect(h.calls()).toBe(beforeBack);
    expect(h.service.report().lastSkip).toBe("line-no-usage");
    const parts = pingSegmentParts(h.service.report());
    expect(parts?.text).toBe("ping off:no-usage");
    h.service.dispose();
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("same-line real success without cache usage keeps it off; with usage clears at once (no cooldown) and pings resume", async () => {
    const h = svc();
    for (let i = 0; i < 2; i += 1) {
      h.request();
      await h.window();
    }
    h.request();
    await h.window();
    expect(h.service.report().lastSkip).toBe("line-no-usage");
    const base = h.calls();
    const route = { provider: "kimi-coding", modelId: "k3" };

    // no cache usage ⇒ still tripped
    h.service.noteRequestSettled("s1", h.service.instanceId, true, route, 100, false);
    expect(Object.values(h.service.report().session.noUsageStates).some((r) => r.open)).toBe(true);

    // usage reported ⇒ cleared immediately (clock has not advanced), re-armed in the current window
    h.setUsage([500, 0]);
    h.service.noteRequestSettled("s1", h.service.instanceId, true, route, 100, true);
    expect(h.service.report().session.noUsageStates).toEqual({});
    expect(h.appendEntry.mock.calls.some((c) => (c[1] as { kind: string }).kind === "line-reset")).toBe(true);
    h.clock.advance(240_000);
    await flush();
    expect(h.calls()).toBeGreaterThan(base);
    expect(h.service.report().session.pings).toBe(1);
    h.service.dispose();
  });

  it("manual reset clears a fresh no-usage breaker and persists it empty", async () => {
    const h = svc();
    for (let i = 0; i < 2; i += 1) {
      h.request();
      await h.window();
    }
    expect(h.service.resetBreakers()).toMatchObject({ openLines: 1 });
    expect(h.service.report().session.noUsageStates).toEqual({});
    const last = h.appendEntry.mock.calls.at(-1)![1] as { kind: string; session: unknown };
    expect(last.kind).toBe("breaker-reset-manual");
    const back = readBackKeepaliveSessionState([
      { type: "custom", customType: KEEPALIVE_AUDIT_CUSTOM_TYPE, data: last },
    ])!;
    expect(back.noUsageStates).toEqual({});
    h.service.dispose();
  });
});
