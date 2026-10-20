/**
 * 2026-10-20 ruling (supersedes "proven-write stays session-permanent"): a `proven-write` ping trips a
 * LINE-level breaker (`session.provenWriteStates`, same line key as HTTP/no-usage) IMMEDIATELY, never
 * `session.disabled`, and ANY successful real request on the same line clears it with no cooldown
 * (unlike no-usage there is no cache-usage requirement). Mirrors keepalive-no-usage.test.ts.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import {
  KEEPALIVE_AUDIT_CUSTOM_TYPE,
  LINE_KEY_WILDCARD,
  clearProvenWriteLine,
  createInitialSessionTotals,
  createInitialWindowState,
  evaluateTick,
  lineKeyOf,
  onSuccessfulRealRequest,
  onUnproven,
  pingSegmentParts,
  readBackKeepaliveSessionState,
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
  provider: "cr-anthropic",
  api: "anthropic-messages",
  modelId: "claude-opus-5-5",
  ctxModelId: "claude-opus-5-5",
  baseUrl: "https://cloudrouter.example/anthropic",
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
  payload: { model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true },
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
const write = (s: SessionTotals, now: number, f: Partial<CaptureFingerprint> = {}) =>
  onUnproven(win(f), s, 1, "proven-write", now as never).session;
const lineKey = (f: Partial<CaptureFingerprint> = {}) => lineKeyOf(fp(f))!;
const OTHER_KEY = lineKeyOf(fp(OTHER))!;

describe("proven-write is a line-level breaker that trips on the FIRST occurrence", () => {
  it("opens the line at once; never touches session.disabled / nonTransient* / the http+no-usage maps", () => {
    const s = write(createInitialSessionTotals(), 7);
    expect(s.provenWriteStates[lineKey().key]).toMatchObject({
      open: true,
      trips: 1,
      openedAt: 7,
      resetEligibleAt: 7,
      label: "cr-anthropic/claude-opus-5-5@cloudrouter.example",
    });
    expect(s.disabled).toBeUndefined();
    expect(s.nonTransientConsecutiveUnproven).toBe(0);
    expect(s.nonTransientUnprovenTotal).toBe(0);
    expect(s.lineStates).toEqual({});
    expect(s.noUsageStates).toEqual({});
    expect(s.lastUnproven).toEqual({ kind: "proven-write", at: 7 });
    expect(s.provenWrites).toBe(1); // monotonic stat only
  });

  it("a later non-line unproven kind is NOT made permanent by a past proven write (provenWrites no longer gates anything)", () => {
    let s = write(createInitialSessionTotals(), 1);
    s = onUnproven(win(), s, 1, "accepted-then-lost", 2 as never).session;
    s = onUnproven(win(), s, 1, "malformed", 3 as never).session;
    expect(s.disabled).toMatchObject({ reason: "malformed", transient: true }); // transient pause, not permanent
    // and a real success recovers that pause (isPermanentThresholdMet ignores provenWrites)
    const out = onSuccessfulRealRequest(s, true, { line: lineKey(), now: 9 as never });
    expect(out.disabled).toBeUndefined();
    expect(out.provenWriteStates).toEqual({});
  });

  it("unresolvable line falls to the wildcard", () => {
    const s = write(createInitialSessionTotals(), 5, { provider: "", ctxModelId: "" });
    expect(s.provenWriteStates[LINE_KEY_WILDCARD]).toMatchObject({ open: true, trips: 1 });
    expect(s.disabled).toBeUndefined();
  });

  it("evaluateTick: only the tripped line is skipped (line-proven-write); another line keeps pinging", () => {
    const s = write(createInitialSessionTotals(), 1);
    const base = {
      config: { enabled: true, intervalMs: 240_000, maxPings: 11, minPrefixTokens: 20_000 },
      armed: true,
      mode: "tui",
      now: 3 as never,
    };
    expect(evaluateTick({ ...base, session: s, window: win(), currentFingerprint: fp() }).decision).toMatchObject({
      kind: "skip",
      reason: "line-proven-write",
      terminal: true,
    });
    const other = evaluateTick({ ...base, session: s, window: win(OTHER), currentFingerprint: fp(OTHER) });
    for (const reason of ["line-proven-write", "line-disabled", "line-no-usage", "session-disabled"])
      expect(other.decision).not.toMatchObject({ kind: "skip", reason });
  });

  it("is independent of an HTTP and a no-usage breaker on the same line (separate maps)", () => {
    let s = write(createInitialSessionTotals(), 1);
    s = onUnproven(win(), s, 1, "http", 2 as never, 403).session;
    s = onUnproven(win(), s, 1, "no-usage", 3 as never).session;
    expect(s.lineStates[lineKey().key]).toMatchObject({ open: false, consecutive: 1 });
    expect(s.noUsageStates[lineKey().key]).toMatchObject({ open: false, consecutive: 1 });
    expect(s.provenWriteStates[lineKey().key]?.open).toBe(true);
  });
});

describe("proven-write recovery (no cooldown)", () => {
  const tripped = () => write(createInitialSessionTotals(), 100);

  it("ANY successful same-line real request clears it immediately — no cache-usage flag, any `now`", () => {
    const s = tripped();
    for (const cacheUsage of [undefined, false, true]) {
      const out = onSuccessfulRealRequest(s, true, {
        line: lineKey(),
        now: 101 as never,
        ...(cacheUsage !== undefined ? { cacheUsage } : {}),
      });
      expect(out.provenWriteStates).toEqual({});
      expect(out.disabled).toBeUndefined();
    }
  });

  it("a failed real request or one with no options never clears it (same reference)", () => {
    const s = tripped();
    expect(onSuccessfulRealRequest(s, false, { line: lineKey(), now: 101 as never, cacheUsage: true })).toBe(s);
    expect(onSuccessfulRealRequest(s, true)).toBe(s);
    expect(clearProvenWriteLine(s, undefined)).toBe(s);
  });

  it("a success on ANOTHER line does not clear it; switching back stays tripped until a same-line success", () => {
    const s = tripped();
    const other = onSuccessfulRealRequest(s, true, { line: OTHER_KEY, now: 101 as never });
    expect(other.provenWriteStates[lineKey().key]?.open).toBe(true);
    expect(onSuccessfulRealRequest(other, true, { line: lineKey(), now: 102 as never }).provenWriteStates).toEqual({});
  });

  it("a wildcard breaker is cleared by any successful real request", () => {
    const s = write(createInitialSessionTotals(), 5, { provider: "", ctxModelId: "" });
    expect(onSuccessfulRealRequest(s, true, { line: undefined, now: 9 as never }).provenWriteStates).toEqual({});
    expect(clearProvenWriteLine(s, lineKey()).provenWriteStates).toEqual({});
  });

  it("leaves the no-usage and http breakers of the same line alone", () => {
    let s = write(createInitialSessionTotals(), 1);
    for (let i = 0; i < 2; i += 1) s = onUnproven(win(), s, 1, "no-usage", (2 + i) as never).session;
    const out = onSuccessfulRealRequest(s, true, { line: lineKey(), now: 9 as never, cacheUsage: false });
    expect(out.provenWriteStates).toEqual({});
    expect(out.noUsageStates[lineKey().key]?.open).toBe(true); // no usage reported ⇒ no-usage stays tripped
  });
});

describe("proven-write persistence / migration / reset", () => {
  const entry = (session: Record<string, unknown>) => ({
    type: "custom",
    customType: KEEPALIVE_AUDIT_CUSTOM_TYPE,
    data: { session },
  });

  it("round-trips provenWriteStates through a snapshot", () => {
    const s = write(createInitialSessionTotals(), 5);
    const back = readBackKeepaliveSessionState([entry({ ...s })])!;
    expect(back.provenWriteStates).toEqual(s.provenWriteStates);
    expect(back.disabled).toBeUndefined();
  });

  it("migrates a legacy permanent disabled{proven-write} to a wildcard breaker, idempotently; the next success clears it", () => {
    const migrated = readBackKeepaliveSessionState([
      entry({
        disabled: { reason: "proven-write", at: 3 },
        provenWrites: 1,
        nonTransientConsecutiveUnproven: 1,
        nonTransientUnprovenTotal: 1,
      }),
    ])!;
    expect(migrated.disabled).toBeUndefined();
    expect(migrated.nonTransientConsecutiveUnproven).toBe(0);
    expect(migrated.nonTransientUnprovenTotal).toBe(0);
    expect(migrated.provenWriteStates[LINE_KEY_WILDCARD]).toMatchObject({ open: true, openedAt: 3, trips: 1 });
    expect(migrated.noUsageStates).toEqual({});
    const again = readBackKeepaliveSessionState([
      entry({ ...migrated, disabled: migrated.disabled ?? null, lastUnproven: null }),
    ])!;
    expect(again.provenWriteStates).toEqual(migrated.provenWriteStates);
    expect(again.disabled).toBeUndefined();
    expect(onSuccessfulRealRequest(migrated, true, { line: lineKey(), now: 50 as never }).provenWriteStates).toEqual(
      {},
    );
    // a legacy provenWrites>=1 snapshot no longer turns later unproven kinds permanent
    const next = onUnproven(win(), migrated, 1, "malformed", 60 as never).session;
    expect(next.disabled).toBeUndefined();
  });

  it("sanitizes dirty provenWriteStates without throwing", () => {
    for (const bad of [[], "x", 7, { "bad key": { label: "x", updatedAt: 1 } }]) {
      expect(readBackKeepaliveSessionState([entry({ provenWriteStates: bad })])!.provenWriteStates).toEqual({});
    }
  });

  it("resetAllBreakers clears proven-write breakers, counts them as open lines and as an economic clear", () => {
    const { session, summary } = resetAllBreakers(write(createInitialSessionTotals(), 1));
    expect(session.provenWriteStates).toEqual({});
    expect(session.provenWrites).toBe(0);
    expect(summary).toEqual({ sessionDisabled: undefined, openLines: 1, economicCleared: true });
  });
});

describe("proven-write HUD / status text", () => {
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

  it("shows `ping off:proven-write` only while the CURRENT line's breaker is open (and for the wildcard)", () => {
    const s = write(createInitialSessionTotals(), 1);
    expect(pingSegmentParts(mkReport(s, { currentLineKey: lineKey().key }))).toEqual({
      text: "ping off:proven-write",
      state: "line-off",
    });
    expect(
      renderCacheStatus({
        mode: "auto",
        dirty: false,
        report: mkReport(s, { currentLineKey: lineKey().key }),
      } as never),
    ).toContain("ping off:proven-write");
    expect(pingSegmentParts(mkReport(s, { currentLineKey: OTHER_KEY.key }))?.text ?? "").not.toContain("proven-write");
    const wild = write(createInitialSessionTotals(), 1, { provider: "", ctxModelId: "" });
    expect(pingSegmentParts(mkReport(wild, { currentLineKey: lineKey().key }))?.text).toBe("ping off:proven-write");
  });

  it("an HTTP line breaker keeps its own text and wins over proven-write", () => {
    let s = write(createInitialSessionTotals(), 1);
    for (let i = 0; i < 2; i += 1) s = onUnproven(win(), s, 1, "http", (10 + i) as never, 403).session;
    expect(pingSegmentParts(mkReport(s, { currentLineKey: lineKey().key }))?.text).toBe("ping off:http 403");
  });

  it("/cache-ttl status explains per-line scope and the lift condition (next real success on this line or a model switch)", () => {
    const s = write(createInitialSessionTotals(), 1);
    const lines = renderKeepaliveReportLines(mkReport(s, { currentLineKey: lineKey().key }));
    const line = lines.find((l) => l.startsWith("line off:") && l.includes("proven-write"));
    expect(line).toBeDefined();
    expect(line).toContain("cr-anthropic/claude-opus-5-5@cloudrouter.example");
    expect(line).toContain("per-line");
    expect(line).toContain("next successful real request on this line or a model switch");
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
const MODEL_A = { provider: "cr-anthropic", id: "claude-opus-5-5", baseUrl: "https://cloudrouter.example/anthropic" };
const MODEL_B = { provider: "anthropic", id: "claude", baseUrl: "https://api.anthropic.com" };

function svc(extra: { recoverTransientFailures?: boolean } = { recoverTransientFailures: true }) {
  const clock = new FakeClock(0);
  const ctx = {
    ui: { setStatus: vi.fn() },
    mode: "tui",
    model: { ...MODEL_A, api: "anthropic-messages", cost: { cacheRead: 0.3, cacheWrite: 3.75, tiers: [] } },
    modelRegistry: { getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "k", headers: {} }) },
    sessionManager: { getSessionId: () => "s1" },
  };
  let self: unknown;
  const appendEntry = vi.fn();
  let usage: [number, number] = [0, 186_000];
  const fetchImpl = vi.fn(async () => sse(usage[0], usage[1])) as unknown as typeof fetch;
  const evidence = createProviderEvidenceStore(join(mkdtempSync(join(tmpdir(), "ka-pw-")), "ev.json"));
  const service = createCacheKeepaliveService({
    clock,
    ctx: ctx as never,
    sessionId: "s1",
    settings: { ...SETTINGS },
    backgroundBusy: () => true,
    isCurrent: (s) => self === s,
    fetchImpl,
    appendEntry,
    ...extra,
    persistSessionState: true,
    evidence,
  });
  self = service;
  const request = (f: Partial<CaptureFingerprint> = {}) =>
    service.noteRequest({ ...cap(f), instance: service.instanceId });
  const calls = () => (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length;
  const switchTo = (to: "A" | "B") => {
    ctx.model = { ...ctx.model, ...(to === "A" ? MODEL_A : MODEL_B) };
    service.invalidate("model-select", "s1", service.instanceId);
  };
  const window = async () => {
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();
  };
  const open = () => Object.values(service.report().session.provenWriteStates).filter((r) => r.open).length;
  return {
    clock,
    service,
    request,
    calls,
    switchTo,
    window,
    open,
    appendEntry,
    setUsage: (u: [number, number]) => (usage = u),
  };
}

describe("proven-write service lifecycle", () => {
  it("field case: one paid write trips the line at once; other line pings; model switch resumes; switching back stays tripped", async () => {
    const h = svc();
    // line A: the very first ping pays a write ⇒ trip immediately (session NOT disabled).
    h.request();
    await h.window();
    expect(h.calls()).toBe(1);
    const r1 = h.service.report();
    expect(r1.session.disabled).toBeUndefined();
    expect(h.open()).toBe(1);
    expect(r1.session.provenWrites).toBe(1);

    // A next window: terminal line-proven-write skip, no more (paid) pings.
    h.request();
    await h.window();
    expect(h.service.report().lastSkip).toBe("line-proven-write");
    expect(h.calls()).toBe(1);

    // switch to line B: pinging resumes (hit).
    h.setUsage([500, 0]);
    h.switchTo("B");
    h.request(OTHER);
    await h.window();
    expect(h.calls()).toBe(2);
    expect(h.service.report().session.pings).toBe(1);
    expect(h.service.report().session.disabled).toBeUndefined();

    // switch back to A: still tripped until a same-line real success.
    h.switchTo("A");
    h.request();
    await h.window();
    expect(h.calls()).toBe(2);
    expect(h.service.report().lastSkip).toBe("line-proven-write");
    expect(pingSegmentParts(h.service.report())?.text).toBe("ping off:proven-write");
    h.service.dispose();
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("a successful same-line real request clears it at once (no cooldown, no cache usage needed) and re-arms pinging", async () => {
    const h = svc();
    h.request();
    await h.window();
    h.request();
    await h.window();
    expect(h.service.report().lastSkip).toBe("line-proven-write");
    const base = h.calls();
    const route = { provider: "cr-anthropic", modelId: "claude-opus-5-5" };

    // an unsuccessful settle leaves it tripped
    h.service.noteRequestSettled("s1", h.service.instanceId, false, route, 100, false);
    expect(h.open()).toBe(1);
    // a success on a DIFFERENT route leaves it tripped
    h.service.noteRequestSettled("s1", h.service.instanceId, true, { provider: "x", modelId: "y" }, 100, false);
    expect(h.open()).toBe(1);

    // successful real response WITHOUT cache usage ⇒ still cleared (unlike no-usage), clock not advanced
    h.setUsage([500, 0]);
    h.service.noteRequestSettled("s1", h.service.instanceId, true, route, 100, false);
    expect(h.open()).toBe(0);
    expect(h.appendEntry.mock.calls.some((c) => (c[1] as { kind: string }).kind === "line-reset")).toBe(true);
    h.clock.advance(240_000);
    await flush();
    expect(h.calls()).toBeGreaterThan(base);
    expect(h.service.report().session.pings).toBe(1);
    h.service.dispose();
  });

  it("child keepalive (no full recovery path) lifts ONLY the proven-write breaker on a same-line success", async () => {
    const h = svc({ recoverTransientFailures: false });
    h.request();
    await h.window();
    expect(h.open()).toBe(1);
    h.service.noteRequestSettled("s1", h.service.instanceId, false, {
      provider: "cr-anthropic",
      modelId: "claude-opus-5-5",
    });
    expect(h.open()).toBe(1);
    h.service.noteRequestSettled(
      "s1",
      h.service.instanceId,
      true,
      { provider: "cr-anthropic", modelId: "claude-opus-5-5" },
      100,
    );
    expect(h.open()).toBe(0);
    h.service.dispose();
  });

  it("audit entry for the paid write: disabled=false, lineOpen=true; snapshot persists the open line", async () => {
    const h = svc();
    h.request();
    await h.window();
    const unproven = h.appendEntry.mock.calls
      .map((c) => c[1] as Record<string, any>)
      .find((d) => d.kind === "unproven");
    expect(unproven).toMatchObject({ unprovenKind: "proven-write", disabled: false, lineOpen: true });
    const back = readBackKeepaliveSessionState([
      { type: "custom", customType: KEEPALIVE_AUDIT_CUSTOM_TYPE, data: unproven },
    ])!;
    expect(Object.values(back.provenWriteStates).filter((r) => r.open)).toHaveLength(1);
    expect(back.disabled).toBeUndefined();
    h.service.dispose();
  });

  it("manual reset clears a fresh proven-write breaker and persists it empty", async () => {
    const h = svc();
    h.request();
    await h.window();
    expect(h.service.resetBreakers()).toMatchObject({ openLines: 1, economicCleared: true });
    expect(h.service.report().session.provenWriteStates).toEqual({});
    const last = h.appendEntry.mock.calls.at(-1)![1] as { kind: string };
    expect(last.kind).toBe("breaker-reset-manual");
    const back = readBackKeepaliveSessionState([
      { type: "custom", customType: KEEPALIVE_AUDIT_CUSTOM_TYPE, data: last },
    ])!;
    expect(back.provenWriteStates).toEqual({});
    h.service.dispose();
  });
});
