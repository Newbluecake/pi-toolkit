import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import {
  LINE_COOLDOWN_CAP_MS,
  LINE_KEY_WILDCARD,
  MAX_LINE_STATES,
  KEEPALIVE_AUDIT_CUSTOM_TYPE,
  createInitialSessionTotals,
  createInitialWindowState,
  evaluateTick,
  formatMsShort,
  lineCooldownMs,
  lineKeyOf,
  onProvenHit,
  onSuccessfulRealRequest,
  onUnproven,
  pingSegmentParts,
  isTransientUnproven,
  readBackKeepaliveSessionState,
  renderCacheStatus,
  renderKeepaliveReportLines,
  resetAllBreakers,
  type CaptureFingerprint,
  type CapturedRequest,
  type KeepaliveReport,
  type LineState,
  type SessionTotals,
  type WindowState,
} from "../../src/cache-ttl/keepalive-state.js";
import { createCacheKeepaliveService } from "./fake-pipeline.js";
import { createProviderEvidenceStore } from "../../src/cache-ttl/provider-evidence.js";
import type { CacheTtlSettings } from "../../src/config/settings.js";

type Ms = number & { __brand?: never };
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
const reject = (s: SessionTotals, now: number, status = 403, f: Partial<CaptureFingerprint> = {}) =>
  onUnproven(win(f), s, 1, "http", now as never, status).session;
const lineKey = (f: Partial<CaptureFingerprint> = {}) => lineKeyOf(fp(f))!;
const MIN = 60_000;

describe("lineKeyOf", () => {
  it("normalizes baseUrl and separates provider/model/baseUrl; label has no path", () => {
    const a = lineKey();
    expect(lineKey({ baseUrl: "HTTPS://API.KIMI.COM/coding/?x=1#f" }).key).toBe(a.key);
    expect(lineKey({ baseUrl: "https://other.example/coding" }).key).not.toBe(a.key);
    expect(lineKey({ ctxModelId: "k4" }).key).not.toBe(a.key);
    expect(lineKey({ provider: "x" }).key).not.toBe(a.key);
    expect(a.label).toBe("kimi-coding/k3@api.kimi.com");
    expect(a.label).not.toContain("/coding");
    expect(lineKeyOf(fp({ provider: "", ctxModelId: "" }))).toBeUndefined();
  });
});

describe("line breaker state machine", () => {
  it("non-transient http opens ONLY the line breaker, never session.disabled / nonTransient*", () => {
    let s = createInitialSessionTotals();
    s = reject(s, 10);
    expect(s.lineStates[lineKey().key]).toMatchObject({ open: false, consecutive: 1, total: 1, status: 403 });
    s = reject(s, 20);
    const rec = s.lineStates[lineKey().key]!;
    expect(rec).toMatchObject({ open: true, trips: 1, openedAt: 20, resetEligibleAt: 20 });
    expect(s.disabled).toBeUndefined();
    expect(s.nonTransientConsecutiveUnproven).toBe(0);
    expect(s.nonTransientUnprovenTotal).toBe(0);
  });

  it("no-usage / proven-write keep the permanent session path", () => {
    let s = createInitialSessionTotals();
    s = onUnproven(win(), s, 1, "no-usage", 1 as never).session;
    s = onUnproven(win(), s, 1, "no-usage", 2 as never).session;
    expect(s.disabled?.reason).toBe("no-usage");
    const w = onUnproven(win(), createInitialSessionTotals(), 1, "proven-write", 1 as never).session;
    expect(w.disabled?.reason).toBe("proven-write");
    expect(Object.keys(w.lineStates)).toEqual([]);
  });

  it("unresolvable line falls to the wildcard; any success deletes it", () => {
    const f = { provider: "", ctxModelId: "" };
    let s = reject(createInitialSessionTotals(), 1, 403, f);
    s = reject(s, 2, 403, f);
    expect(s.lineStates[LINE_KEY_WILDCARD]).toMatchObject({ open: true, trips: 1 });
    expect(s.disabled).toBeUndefined();
    const tick = evaluateTick({
      config: { enabled: true, intervalMs: 240_000, maxPings: 11, minPrefixTokens: 20_000 },
      session: s,
      window: win(f),
      armed: true,
      mode: "tui",
      now: 3 as never,
      currentFingerprint: fp(f),
    });
    expect(tick.decision).toEqual({ kind: "skip", reason: "line-disabled", terminal: true });
    const r = onSuccessfulRealRequest(s, true, { line: undefined, now: 5 as never });
    expect(r.lineStates[LINE_KEY_WILDCARD]).toBeUndefined();
  });

  it("trips=1 resets immediately on a same-line success; other-line success does not", () => {
    let s = reject(reject(createInitialSessionTotals(), 10), 20);
    const same = onSuccessfulRealRequest(s, true, { line: lineKey(), now: 30 as never });
    expect(same.lineStates[lineKey().key]).toMatchObject({
      open: false,
      consecutive: 0,
      total: 0,
      trips: 1,
      lastResetAt: 30,
    });
    expect(same.lineStates[lineKey().key]?.openedAt).toBeUndefined();
    const other = onSuccessfulRealRequest(s, true, { line: lineKey({ provider: "anthropic" }), now: 30 as never });
    expect(other).toBe(s);
    expect(onSuccessfulRealRequest(s, false, { line: lineKey(), now: 30 as never })).toBe(s);
    s = same;
    expect(onSuccessfulRealRequest(s, true, { line: lineKey(), now: 31 as never })).toBe(s);
  });

  it("backoff: same status trips+1 with doubling cooldown; cooled-down gate; status change / >24h forget", () => {
    let s = reject(reject(createInitialSessionTotals(), 0), 1);
    s = onSuccessfulRealRequest(s, true, { line: lineKey(), now: 2 as never });
    s = reject(reject(s, 10), 11);
    let rec = s.lineStates[lineKey().key]!;
    expect(rec.trips).toBe(2);
    expect(rec.resetEligibleAt).toBe(11 + 30 * MIN);
    // inside cooldown: unchanged
    expect(onSuccessfulRealRequest(s, true, { line: lineKey(), now: (10 * MIN) as never })).toBe(s);
    s = onSuccessfulRealRequest(s, true, { line: lineKey(), now: (11 + 30 * MIN) as never });
    expect(s.lineStates[lineKey().key]?.open).toBe(false);
    // 3rd trip, same status
    s = reject(reject(s, 40 * MIN), 41 * MIN);
    expect(s.lineStates[lineKey().key]?.trips).toBe(3);
    // different status ⇒ trips back to 1 (pins "compare old status before writing new")
    let t = reject(reject(createInitialSessionTotals(), 0, 403), 1, 403);
    t = onSuccessfulRealRequest(t, true, { line: lineKey(), now: 2 as never });
    t = reject(reject(t, 3, 401), 4, 401);
    expect(t.lineStates[lineKey().key]?.trips).toBe(1);
    // >24h since reset ⇒ forgotten
    let u = reject(reject(createInitialSessionTotals(), 0), 1);
    u = onSuccessfulRealRequest(u, true, { line: lineKey(), now: 2 as never });
    u = reject(reject(u, 25 * 3_600_000), 25 * 3_600_000 + 1);
    expect(u.lineStates[lineKey().key]?.trips).toBe(1);
    rec = u.lineStates[lineKey().key]!;
    expect(rec.open).toBe(true);
  });

  it("cooldown curve", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => lineCooldownMs(n) / MIN)).toEqual([
      0, 30, 60, 120, 240, 480, 960, 1440, 1440,
    ]);
    expect(lineCooldownMs(99)).toBe(LINE_COOLDOWN_CAP_MS);
    expect(lineCooldownMs(0)).toBe(0);
  });

  it("evaluateTick: line-disabled only for the matching line; session-disabled still wins", () => {
    const s = reject(reject(createInitialSessionTotals(), 1), 2);
    const base = {
      config: { enabled: true, intervalMs: 240_000, maxPings: 11, minPrefixTokens: 20_000 },
      armed: true,
      mode: "tui",
      now: 3 as never,
    };
    const hit = evaluateTick({ ...base, session: s, window: win(), currentFingerprint: fp() });
    expect(hit.decision).toMatchObject({ kind: "skip", reason: "line-disabled", terminal: true });
    const otherFp = {
      provider: "anthropic",
      ctxModelId: "claude",
      modelId: "claude",
      baseUrl: "https://api.anthropic.com",
    };
    const miss = evaluateTick({ ...base, session: s, window: win(otherFp), currentFingerprint: fp(otherFp) });
    expect(miss.decision).not.toMatchObject({ reason: "line-disabled" });
    const both = { ...s, disabled: { reason: "proven-write", at: 1 as never } };
    expect(evaluateTick({ ...base, session: both, window: win(), currentFingerprint: fp() }).decision).toMatchObject({
      reason: "session-disabled",
    });
  });

  it("proven-hit clears a closed record; transient failure interrupts the consecutive count", () => {
    let s = reject(createInitialSessionTotals(), 1);
    const hit = onProvenHit(win(), s, 1, { kind: "proven-hit", cacheReadTokens: 5 } as never, 240_000 as never);
    expect(hit.session.lineStates[lineKey().key]).toBeUndefined();
    s = onUnproven(win(), s, 1, "network", 2 as never).session;
    expect(s.lineStates[lineKey().key]).toMatchObject({ consecutive: 0, total: 1 });
  });

  it("capacity: 17 lines ⇒ 16, closed-oldest evicted, open lines and wildcard kept", () => {
    let s = createInitialSessionTotals();
    s = reject(reject(s, 1, 403, { provider: "", ctxModelId: "" }), 2, 403, { provider: "", ctxModelId: "" });
    s = reject(reject(s, 3, 403, { ctxModelId: "open" }), 4, 403, { ctxModelId: "open" });
    for (let i = 0; i < MAX_LINE_STATES; i += 1) s = reject(s, 100 + i, 403, { ctxModelId: `m${i}` });
    expect(Object.keys(s.lineStates).length).toBe(MAX_LINE_STATES);
    expect(s.lineStates[LINE_KEY_WILDCARD]?.open).toBe(true);
    expect(s.lineStates[lineKey({ ctxModelId: "open" }).key]?.open).toBe(true);
    expect(s.lineStates[lineKey({ ctxModelId: "m0" }).key]).toBeUndefined();
    expect(s.lineStates[lineKey({ ctxModelId: `m${MAX_LINE_STATES - 1}` }).key]).toBeDefined();
  });

  it("property: provenWrites sessions never get disabled cleared by a success; open ⇒ openedAt+resetEligibleAt", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let run = 0; run < 50; run += 1) {
      let s = onUnproven(win(), createInitialSessionTotals(), 1, "proven-write", 0 as never).session;
      let now = 1;
      for (let i = 0; i < 30; i += 1) {
        now += Math.floor(rnd() * 40 * MIN);
        const f = { ctxModelId: `m${Math.floor(rnd() * 3)}` };
        const r = rnd();
        if (r < 0.4) s = reject(s, now, rnd() < 0.5 ? 403 : 401, f);
        else if (r < 0.8) s = onSuccessfulRealRequest(s, true, { line: lineKey(f), now: now as never });
        else s = onSuccessfulRealRequest(s, true);
        expect(s.disabled?.reason).toBe("proven-write");
        for (const rec of Object.values(s.lineStates)) {
          if (rec.open) {
            expect(rec.openedAt).toBeDefined();
            expect(rec.resetEligibleAt).toBeDefined();
          }
        }
      }
    }
  });

  it("resetAllBreakers clears breakers, keeps audit accounting", () => {
    let s = reject(reject(createInitialSessionTotals(), 1), 2);
    s = {
      ...s,
      provenWrites: 1,
      disabled: { reason: "proven-write", at: 1 as never },
      noCacheValueCounted: true,
      pings: 4,
      loadBearingPings: 3,
    };
    const { session, summary } = resetAllBreakers(s);
    expect(summary).toEqual({ sessionDisabled: "proven-write", openLines: 1, economicCleared: true });
    expect(session).toMatchObject({
      disabled: undefined,
      provenWrites: 0,
      lineStates: {},
      noCacheValueCounted: true,
      pings: 4,
      loadBearingPings: 3,
    });
  });
});

describe("formatMsShort", () => {
  it("ceil-based short durations", () => {
    expect(formatMsShort(0)).toBe("0m");
    expect(formatMsShort(-5)).toBe("0m");
    expect(formatMsShort(59_999)).toBe("<1m");
    expect(formatMsShort(60_000)).toBe("1m");
    expect(formatMsShort(25 * MIN)).toBe("25m");
    expect(formatMsShort(120 * MIN)).toBe("120m");
    expect(formatMsShort(121 * MIN)).toBe("3h");
    expect(formatMsShort(24 * 60 * MIN)).toBe("24h");
    expect(formatMsShort(1e15)).toBe("24h");
    expect(formatMsShort(Number.NaN)).toBe("0m");
  });
});

describe("rendering", () => {
  const report = (session: SessionTotals, extra: Partial<KeepaliveReport> = {}): KeepaliveReport => ({
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
  const status = (r: KeepaliveReport) => renderCacheStatus({ mode: "auto", dirty: false, report: r } as never);

  it("line-off segment: status, retry, trips; no ×N; only for the current line", () => {
    let s = reject(reject(createInitialSessionTotals(), 0), 1);
    s = onSuccessfulRealRequest(s, true, { line: lineKey(), now: 2 as never });
    s = { ...reject(reject(s, 10), 11), pings: 9 };
    const key = lineKey().key;
    const out = status(report(s, { currentLineKey: key, now: 11 as never }));
    expect(out).toContain("ping off:http 403 ·retry 30m ·t2");
    expect(out).not.toContain("×");
    expect(status(report(s, { currentLineKey: lineKey({ provider: "x" }).key, now: 11 as never }))).not.toContain(
      "ping off",
    );
    const lines = renderKeepaliveReportLines(report(s, { currentLineKey: key, now: 11 as never }));
    expect(
      lines.some((l) =>
        l.startsWith("line off: kimi-coding/k3@api.kimi.com · http 403 · trips 2 · reset eligible in 30m"),
      ),
    ).toBe(true);
  });

  it("legacy wildcard shows `ping off:http`; session.disabled keeps ×N", () => {
    const s = readBackKeepaliveSessionState([
      {
        type: "custom",
        customType: KEEPALIVE_AUDIT_CUSTOM_TYPE,
        data: { session: { disabled: { reason: "http", at: 5 }, pings: 3 } },
      },
    ])!;
    expect(status(report(s, { now: 10 as never }))).toContain("ping off:http");
    expect(status(report(s, { now: 10 as never }))).not.toContain("×");
    const d = { ...createInitialSessionTotals(), pings: 3, disabled: { reason: "proven-write", at: 1 as never } };
    expect(status(report(d))).toContain("ping off:proven-write ×3");
  });
});

describe("persistence / migration", () => {
  const entry = (session: unknown) => ({ type: "custom", customType: KEEPALIVE_AUDIT_CUSTOM_TYPE, data: { session } });

  it("round-trips lineStates", () => {
    const rec: LineState = {
      label: "a/b@c",
      status: 403,
      consecutive: 0,
      total: 0,
      open: true,
      openedAt: 5 as never,
      trips: 2,
      resetEligibleAt: 9 as never,
      lastResetAt: 1 as never,
      updatedAt: 5 as never,
    };
    const out = readBackKeepaliveSessionState([entry({ lineStates: { L1abc: rec } })])!;
    expect(out.lineStates).toEqual({ L1abc: rec });
  });

  it("migrates the 10/12 legacy permanent http disable to a wildcard breaker (counters zeroed)", () => {
    const out = readBackKeepaliveSessionState([
      entry({
        disabled: { reason: "http", at: 77, httpStatus: 403 },
        nonTransientConsecutiveUnproven: 2,
        nonTransientUnprovenTotal: 2,
      }),
    ])!;
    expect(out.disabled).toBeUndefined();
    expect(out.nonTransientConsecutiveUnproven).toBe(0);
    expect(out.lineStates[LINE_KEY_WILDCARD]).toMatchObject({
      open: true,
      status: 403,
      trips: 1,
      openedAt: 77,
      resetEligibleAt: 77,
    });
    // success clears it
    expect(onSuccessfulRealRequest(out, true, { line: undefined, now: 100 as never }).lineStates).toEqual({});
  });

  it("does not migrate transient / non-http / already-new-format snapshots; migration is idempotent", () => {
    // #29 r2: a legacy transient pause is lifted (not migrated into a line breaker).
    const lifted = readBackKeepaliveSessionState([entry({ disabled: { reason: "http", at: 1, transient: true } })])!;
    expect(lifted.disabled).toBeUndefined();
    expect(lifted.lineStates).toEqual({});
    expect(readBackKeepaliveSessionState([entry({ disabled: { reason: "no-usage", at: 1 } })])!.disabled?.reason).toBe(
      "no-usage",
    );
    const migrated = readBackKeepaliveSessionState([entry({ disabled: { reason: "http", at: 3 } })])!;
    const again = readBackKeepaliveSessionState([
      entry({ ...migrated, disabled: migrated.disabled ?? null, lastUnproven: null }),
    ])!;
    expect(again.lineStates).toEqual(migrated.lineStates);
    expect(again.disabled).toBeUndefined();
  });

  it("sanitizes dirty lineStates without throwing", () => {
    for (const bad of [[], "x", 7, { __proto__: { open: true } }]) {
      expect(readBackKeepaliveSessionState([entry({ lineStates: bad })])!.lineStates).toEqual({});
    }
    const many: Record<string, unknown> = {
      "bad key": { label: "x", updatedAt: 1 },
      L1: { label: "", updatedAt: 1 },
      L2: { label: "ok", updatedAt: -1 },
    };
    for (let i = 0; i < 40; i += 1)
      many[`L${i + 10}`] = {
        label: `l${i}`,
        updatedAt: i,
        open: "yes",
        trips: 999,
        status: 99,
        consecutive: Number.NaN,
      };
    const out = readBackKeepaliveSessionState([entry({ lineStates: many })])!.lineStates;
    expect(Object.keys(out).length).toBe(MAX_LINE_STATES);
    expect(out["bad key"]).toBeUndefined();
    const any = Object.values(out)[0]!;
    expect(any.open).toBe(false);
    expect(any.trips).toBe(64);
    expect(any.status).toBeUndefined();
    expect(any.consecutive).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// service integration
// ---------------------------------------------------------------------------
const enc = new TextEncoder();
const okResp = (): Response => {
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
              `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 } } })}\n\n`,
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

function svc(opts: { status?: () => number } = {}) {
  const clock = new FakeClock(0);
  const model = {
    provider: "kimi-coding",
    api: "anthropic-messages",
    id: "k3",
    baseUrl: "https://api.kimi.com/coding",
    cost: { cacheRead: 0.3, tiers: [] },
  };
  const ctx = {
    ui: { setStatus: vi.fn() },
    mode: "tui",
    model,
    modelRegistry: { getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "k", headers: {} }) },
    sessionManager: { getSessionId: () => "s1" },
  };
  let self: unknown;
  const appendEntry = vi.fn();
  const fetchImpl = vi.fn(async () => {
    const st = opts.status?.() ?? 0;
    return st === 0
      ? okResp()
      : ({ ok: false, status: st, body: undefined, text: async () => "" } as unknown as Response);
  }) as unknown as typeof fetch;
  const evidence = createProviderEvidenceStore(join(mkdtempSync(join(tmpdir(), "ka-ev-")), "ev.json"));
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
  const request = (f: Partial<CaptureFingerprint> = {}) => {
    const c = cap(f);
    service.noteRequest({ ...c, instance: service.instanceId });
  };
  return { clock, ctx, model, service, fetchImpl, appendEntry, request, evidence };
}

describe("service: line isolation, reset and breaker command", () => {
  it("403×2 opens the line; same-line success resets and re-arms; other-line success does not reset", async () => {
    let status = 403;
    const h = svc({ status: () => status });
    for (let i = 0; i < 2; i += 1) {
      h.request();
      h.service.noteRequestSettled("s1", h.service.instanceId);
      h.clock.advance(240_000);
      await flush();
    }
    expect(Object.values(h.service.report().session.lineStates)[0]?.open).toBe(true);
    expect(h.service.report().session.disabled).toBeUndefined();
    h.request();
    h.service.noteRequestSettled("s1", h.service.instanceId);
    h.clock.advance(240_000);
    await flush();
    expect(h.service.report().lastSkip).toBe("line-disabled");
    const calls = (h.fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length;

    // success on ANOTHER line: no reset
    h.service.noteRequestSettled("s1", h.service.instanceId, true, { provider: "anthropic", modelId: "claude" });
    expect(Object.values(h.service.report().session.lineStates)[0]?.open).toBe(true);

    // success on the same line: reset + resume pinging in the current window
    status = 0;
    h.request();
    h.service.noteRequestSettled("s1", h.service.instanceId, true, { provider: "kimi-coding", modelId: "k3" });
    expect(Object.values(h.service.report().session.lineStates)[0]?.open).toBe(false);
    expect(h.appendEntry.mock.calls.some((c) => (c[1] as { kind: string }).kind === "line-reset")).toBe(true);
    h.clock.advance(240_000);
    await flush();
    expect((h.fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(calls);
    expect(h.service.report().session.pings).toBe(1);
  });

  it("resolveSettledLine: inflight mismatch never falls back to ctx.model; unresolved is audited once", async () => {
    const h = svc({ status: () => 403 });
    for (let i = 0; i < 2; i += 1) {
      h.request();
      h.service.noteRequestSettled("s1", h.service.instanceId);
      h.clock.advance(240_000);
      await flush();
    }
    h.request({ baseUrl: "https://old.example/coding" });
    // route matches ctx.model but the inflight capture was another baseUrl ⇒ line differs ⇒ no reset
    h.service.noteRequestSettled("s1", h.service.instanceId, true, { provider: "kimi-coding", modelId: "k3" });
    // (inflight provider+model match ⇒ resolves to the OLD-baseUrl line, not the open one)
    expect(Object.values(h.service.report().session.lineStates).filter((r) => r.open).length).toBe(1);
    h.service.noteRequestSettled("s1", h.service.instanceId, true, { provider: "zzz", modelId: "q" });
    h.service.noteRequestSettled("s1", h.service.instanceId, true, { provider: "zzz", modelId: "q" });
    const skipped = h.appendEntry.mock.calls.filter((c) => (c[1] as { kind: string }).kind === "line-reset-skipped");
    expect(skipped.length).toBe(1);
  });

  it("resetBreakers clears line + economic breakers + current-route evidence, persisted empty, no new timers", async () => {
    const h = svc({ status: () => 403 });
    for (let i = 0; i < 2; i += 1) {
      h.request();
      h.service.noteRequestSettled("s1", h.service.instanceId);
      h.clock.advance(240_000);
      await flush();
    }
    h.evidence.noteZeroReadSession("kimi-coding", "k3", 1 as never);
    h.evidence.noteZeroReadSession("kimi-coding", "k3", 2 as never);
    h.evidence.noteZeroReadSession("kimi-coding", "k3", 3 as never);
    expect(h.evidence.isNoCacheValue("kimi-coding", "k3", 4 as never)).toBe(true);
    const out = h.service.resetBreakers();
    expect(out).toMatchObject({ openLines: 1, evidenceCleared: true, economicCleared: false });
    expect(h.evidence.isNoCacheValue("kimi-coding", "k3", 5 as never)).toBe(false);
    expect(h.service.report().session.lineStates).toEqual({});
    const last = h.appendEntry.mock.calls.at(-1)![1] as { kind: string; session: unknown };
    expect(last.kind).toBe("breaker-reset-manual");
    const back = readBackKeepaliveSessionState([
      { type: "custom", customType: KEEPALIVE_AUDIT_CUSTOM_TYPE, data: last },
    ])!;
    expect(back.lineStates).toEqual({});
    h.service.dispose();
    expect(h.clock.pendingTimers).toBe(0);
    expect(h.service.resetBreakers()).toEqual({
      sessionDisabled: undefined,
      openLines: 0,
      economicCleared: false,
      evidenceCleared: false,
    });
  });
});
void (undefined as unknown as Ms);

// ---------------------------------------------------------------------------
// pingSegmentParts (cache-keepalive-web plan §3.1/§3.6) — baseline 95f7a6f (post-#29)
// ---------------------------------------------------------------------------
describe("pingSegmentParts", () => {
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
  const compose = (r: KeepaliveReport): string | undefined => {
    const p = pingSegmentParts(r);
    if (p === undefined) return undefined;
    let s = p.text;
    if (p.retryAt !== undefined && r.now !== undefined && p.retryAt > r.now)
      s += ` ·retry ${formatMsShort(p.retryAt - r.now)}`;
    if (p.tail !== undefined) s += ` ${p.tail}`;
    return s;
  };
  const render = (r: KeepaliveReport) => renderCacheStatus({ mode: "auto", dirty: false, report: r });

  const lineOpenSession = (): SessionTotals => {
    let s = reject(reject(createInitialSessionTotals(), 0), 1);
    s = onSuccessfulRealRequest(s, true, { line: lineKey(), now: 2 as never });
    return { ...reject(reject(s, 10), 11), pings: 9 };
  };
  const corpus = (): Array<[string, KeepaliveReport, string | undefined, string | undefined]> => {
    const key = lineKey().key;
    const base = createInitialSessionTotals();
    const disabled = { ...base, pings: 7, disabled: { reason: "http", at: 5, httpStatus: 403 } };
    const disabledNoCode = { ...base, pings: 3, disabled: { reason: "no-usage", at: 5 } };
    const win = (w: Partial<WindowState>) => ({ ...createInitialWindowState(), capture: cap(), ...w });
    return [
      ["undefined report", undefined as never, undefined, undefined],
      ["nothing yet", mkReport(base), undefined, undefined],
      ["disabled http", mkReport(disabled), "disabled", "ping off:http 403 ×7"],
      ["disabled no code", mkReport(disabledNoCode), "disabled", "ping off:no-usage ×3"],
      [
        "line-off with retry+trips",
        mkReport(lineOpenSession(), { currentLineKey: key, now: 11 as never }),
        "line-off",
        "ping off:http 403 ·retry 30m ·t2",
      ],
      [
        "line-off other line",
        mkReport(lineOpenSession(), { currentLineKey: lineKey({ provider: "x" }).key, now: 11 as never }),
        "active",
        "ping 0/11 Σ9 · 0 · unknown",
      ],
      ["capped", mkReport({ ...base, pings: 11 }, { window: win({ pings: 11 }) }), "capped", "ping 11/11 capped"],
      [
        "paused",
        mkReport({ ...base, pings: 2 }, { window: win({ pings: 2, lastStopReason: "network" as never }) }),
        "paused",
        "ping miss:network",
      ],
      [
        "active",
        mkReport({ ...base, pings: 4, cacheReadTokens: 450_000 }, { window: win({ pings: 3 }), costUsd: 0.12 }),
        "active",
        "ping 3/11 Σ4 · 450k · ≈$0.12",
      ],
    ];
  };

  it.each(corpus().map((c) => [c[0], c] as const))("%s: state + compose==render (text parity)", (_n, c) => {
    const [, r, state, text] = c;
    const p = pingSegmentParts(r);
    expect(p?.state).toBe(state);
    if (r === undefined) return;
    expect(render(r)).toBe(text);
    expect(compose(r)).toBe(text);
  });

  it("line-off parts: head has no suffix; retryAt absolute only while in the future; tail only for trips>=2", () => {
    const key = lineKey().key;
    const s = lineOpenSession();
    const p = pingSegmentParts(mkReport(s, { currentLineKey: key, now: 11 as never }))!;
    expect(p.text).toBe("ping off:http 403");
    expect(p.retryAt).toBe(s.lineStates[key]!.resetEligibleAt);
    expect(p.tail).toBe("·t2");
    const expired = pingSegmentParts(
      mkReport(s, { currentLineKey: key, now: (s.lineStates[key]!.resetEligibleAt! + 1) as never }),
    )!;
    expect(expired.retryAt).toBeUndefined();
    const first = reject(reject(createInitialSessionTotals(), 0), 1);
    const p1 = pingSegmentParts(mkReport(first, { currentLineKey: key, now: 2 as never }))!;
    expect(p1.state).toBe("line-off");
    expect(p1.tail).toBeUndefined();
  });

  it("isTransientUnproven is exported with the existing classification", () => {
    expect(isTransientUnproven("http", 503)).toBe(true);
    expect(isTransientUnproven("http", 408)).toBe(true);
    expect(isTransientUnproven("http", 403)).toBe(false);
    expect(isTransientUnproven("network")).toBe(true);
    expect(isTransientUnproven("proven-write")).toBe(false);
  });

  it("formatMsShort matches the shared vectors", async () => {
    const v = (await import("../fixtures/cache-keepalive-format-vectors.json", { with: { type: "json" } })) as {
      default: { cases: Array<[number, string]> };
    };
    for (const [ms, want] of v.default.cases) expect(formatMsShort(ms)).toBe(want);
  });
});
