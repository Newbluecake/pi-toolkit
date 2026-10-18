/**
 * Ping retry (user requirement, 2026-09-26, r2 2026-10-14 — docs/dev/cache-ttl-keepalive/plan.md's
 * appended "ping 重试" sections): `sendKeepalivePing` outcomes that prove the server
 * never processed the request (`network`, and a fixed set of transient HTTP statuses)
 * are retried on a 2s/5s/10s/20s/30s… backoff until the window's TTL margin
 * (`aliveUntil − TTL_SAFETY_MARGIN_MS`, 15s margin since 2026-10-16 — 45s before)
 * runs out, via the injected `Clock` — never the real timer. Every other outcome
 * (`accepted-then-lost`, `proven-write`, `no-usage`, `malformed`, non-retryable HTTP)
 * is final on the first attempt. See tests/cache-ttl/keepalive-lifecycle.test.ts for the
 * sibling identity/epoch-guard suite this borrows its harness style from.
 */
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import {
  createCacheKeepaliveService,
  type CacheKeepaliveDeps,
  type CacheKeepaliveService,
} from "../../src/service/cache-keepalive.js";
import type { CacheTtlSettings } from "../../src/config/settings.js";
import { renderKeepaliveReportLines } from "../../src/cache-ttl/keepalive-state.js";
import type { CapturedRequest } from "../../src/cache-ttl/keepalive-state.js";

const encoder = new TextEncoder();

function messageStartChunk(usage: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number }): string {
  return `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10, ...usage } } })}\n\n`;
}

interface FakeReader {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel: () => Promise<void>;
}
function chunkedReader(chunks: string[]): FakeReader {
  let i = 0;
  return {
    cancel: async () => {},
    read: async () => {
      if (i < chunks.length) {
        const value = encoder.encode(chunks[i]);
        i += 1;
        return { done: false, value };
      }
      return { done: true, value: undefined };
    },
  };
}
function fakeOkResponse(chunks: string[]): Response {
  return { ok: true, status: 200, body: { getReader: () => chunkedReader(chunks) } } as unknown as Response;
}
function fakeHttpErrorResponse(status: number): Response {
  // No `body` ⇒ ping-client's error-body reader falls back to `res.text()`.
  return { ok: false, status, text: async () => "" } as unknown as Response;
}

/** Fetch stub whose Nth call is driven by `steps[N-1]` (last step repeats past the array end). */
function sequencedFetch(steps: Array<() => Promise<Response>>): { fetchImpl: typeof fetch; calls: () => number } {
  let i = 0;
  const fn = vi.fn(async () => {
    const step = steps[Math.min(i, steps.length - 1)]!;
    i += 1;
    return step();
  });
  return { fetchImpl: fn as unknown as typeof fetch, calls: () => i };
}

/**
 * Fetch stub each of whose calls stays pending until the test explicitly settles it —
 * lets a test advance the FakeClock an arbitrary amount "while the attempt is in
 * flight" before failing/succeeding it, independent of the 15s tick / grid alignment.
 */
function manualFetch(): {
  fetchImpl: typeof fetch;
  calls: () => number;
  settle: (index: number, action: { reject: Error } | { resolve: Response }) => void;
} {
  const pending: Array<{ resolve: (r: Response) => void; reject: (e: unknown) => void }> = [];
  const fn = vi.fn(
    () =>
      new Promise<Response>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  return {
    fetchImpl: fn as unknown as typeof fetch,
    calls: () => pending.length,
    settle: (index, action) => {
      const p = pending[index];
      if (!p) throw new Error(`no pending fetch call at index ${index}`);
      if ("reject" in action) p.reject(action.reject);
      else p.resolve(action.resolve);
    },
  };
}

const networkErrorStep = () => Promise.reject(new Error("network down"));
/** Network failure carrying a `code` — exercises the sanitized error descriptor (`ECONNRESET`). */
const codedNetworkErrorStep = () => Promise.reject(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }));
const provenHitStep = () =>
  Promise.resolve(
    fakeOkResponse([messageStartChunk({ cache_read_input_tokens: 500, cache_creation_input_tokens: 0 })]),
  );
const httpStep = (status: number) => () => Promise.resolve(fakeHttpErrorResponse(status));
const acceptedThenLostStep = () => Promise.resolve(fakeOkResponse([])); // stream ends, no message_start

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const SETTINGS: CacheTtlSettings = {
  mode: "auto",
  keepalive: true,
  keepaliveIntervalMs: 240_000,
  keepaliveMinPrefixTokens: 20_000,
};

function fakeCtx(overrides: Record<string, unknown> = {}) {
  return {
    ui: { setStatus: vi.fn() },
    mode: "tui",
    model: {
      provider: "anthropic",
      api: "anthropic-messages",
      id: "claude-x",
      baseUrl: "https://api.anthropic.com",
      headers: {},
      cost: { cacheRead: 0.3, tiers: [] },
    },
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "sk-ant-api-x", headers: {} }),
    },
    sessionManager: { getSessionId: () => "s1" },
    ...overrides,
  };
}

function capture(overrides: Partial<CapturedRequest> = {}, instance: string, tokens = 30_000): CapturedRequest {
  return {
    sessionId: "s1",
    instance,
    payload: { model: "claude-x", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true },
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    fingerprint: {
      sessionId: "s1",
      provider: "anthropic",
      api: "anthropic-messages",
      modelId: "claude-x",
      ctxModelId: "claude-x",
      baseUrl: "https://api.anthropic.com",
      authHeaderKeys: "",
      breakpointPath: "messages.0",
      thinkingDigest: "",
      systemDigest: "",
      toolsDigest: "",
      messageCount: 1,
    },
    shape: { ephemeralBreakpoints: 1, ttl1h: false, hasThinking: false, maxTokens: 100 },
    prefix: { tokens, source: "usage" },
    capturedAt: 0,
    ...overrides,
  };
}

function harness(overrides: Partial<CacheKeepaliveDeps> = {}, ctxOverrides: Record<string, unknown> = {}) {
  const clock = new FakeClock(0);
  const ctx = fakeCtx(ctxOverrides);
  let self: CacheKeepaliveService | undefined;
  const appendEntry = vi.fn();
  const emit = vi.fn();
  const service = createCacheKeepaliveService({
    clock,
    ctx: ctx as never,
    sessionId: "s1",
    settings: { ...SETTINGS },
    backgroundBusy: () => true,
    isCurrent: (s) => self === s,
    fetchImpl: (() => Promise.resolve(fakeOkResponse([]))) as unknown as typeof fetch,
    appendEntry,
    emit,
    ...overrides,
  });
  self = service;
  return { clock, ctx, service, appendEntry, emit };
}

/** Opens a window and advances the clock to the first ping tick; caller then drives retries. */
async function armAndTick(
  service: CacheKeepaliveService,
  clock: FakeClock,
  intervalMs = SETTINGS.keepaliveIntervalMs,
): Promise<void> {
  service.noteRequest(capture({}, service.instanceId));
  service.noteRequestSettled("s1", service.instanceId);
  clock.advance(intervalMs);
  await flush();
}

describe("cache-keepalive service — ping retry (retryable outcomes)", () => {
  it("network failure retried once, second attempt proven-hit ⇒ success, no unproven counted, 2 attempts recorded", async () => {
    const { fetchImpl, calls } = sequencedFetch([networkErrorStep, provenHitStep]);
    const { service, clock, appendEntry } = harness({ fetchImpl });
    await armAndTick(service, clock);

    expect(calls()).toBe(1); // first attempt done, backoff pending
    expect(service.report().session.unprovenTotal).toBe(0);

    clock.advance(2_000); // first backoff (2s)
    await flush();

    expect(calls()).toBe(2);
    const report = service.report();
    expect(report.session.pings).toBe(1); // proven hit counted
    expect(report.session.unprovenTotal).toBe(0); // never counted as unproven
    expect(report.session.consecutiveUnproven).toBe(0);
    expect(report.lastPingDiagnostics?.outcomeKind).toBe("proven-hit");
    expect(report.lastPingDiagnostics?.attempts).toBe(2);

    const attemptAudits = appendEntry.mock.calls.filter(([, data]: [string, any]) => data.kind === "ping-attempt");
    expect(attemptAudits.map(([, data]: [string, any]) => data.outcomeKind)).toEqual(["network", "proven-hit"]);
    expect(attemptAudits.map(([, data]: [string, any]) => data.attempt)).toEqual([1, 2]);
  });

  it("network failures retried across the whole default-config window ⇒ exactly one unproven counted (not five), kind is the last attempt's; audit carries durationMs + sanitized error descriptor", async () => {
    // TTL_SAFETY_MARGIN_MS is 15s since 2026-10-16 (was 45s): with the default 240s
    // interval the retry cutoff is aliveUntil(300_000) − 15_000 = 285_000, so attempts
    // land at 240/242/247/257/277s (the old 45s margin stopped at 247s / 3 attempts).
    const { fetchImpl, calls } = sequencedFetch([
      codedNetworkErrorStep,
      codedNetworkErrorStep,
      codedNetworkErrorStep,
      codedNetworkErrorStep,
      codedNetworkErrorStep,
    ]);
    const { service, clock, appendEntry } = harness({ fetchImpl });
    await armAndTick(service, clock);

    clock.advance(2_000); // -> attempt 2 @242
    await flush();
    clock.advance(5_000); // -> attempt 3 @247
    await flush();
    clock.advance(10_000); // -> attempt 4 @257
    await flush();
    clock.advance(20_000); // -> attempt 5 @277 (last: 285−277 = 8s < the next 30s backoff)
    await flush();

    expect(calls()).toBe(5);
    const report = service.report();
    expect(report.session.unprovenTotal).toBe(1);
    expect(report.session.consecutiveUnproven).toBe(1);
    expect(report.session.lastUnproven?.kind).toBe("network");
    expect(report.lastPingDiagnostics?.attempts).toBe(5);
    expect(report.lastPingDiagnostics?.durationMs).toBe(37_000); // 240_000 (first send) -> 277_000 (final)
    expect(report.lastPingDiagnostics?.error).toBe("ECONNRESET");
    expect(report.session.disabled).toBeUndefined(); // below both breaker thresholds

    // Every ping-attempt audit entry carries the sanitized descriptor (code only — never
    // the "fetch failed" message) and a per-attempt durationMs (0 for instantly-failing stubs).
    const attemptAudits = appendEntry.mock.calls.filter((call: [string, any]) => call[1].kind === "ping-attempt");
    expect(attemptAudits).toHaveLength(5);
    for (const call of attemptAudits) {
      const data = call[1] as Record<string, any>;
      expect(data.outcomeKind).toBe("network");
      expect(data.error).toBe("ECONNRESET");
      expect(typeof data.durationMs).toBe("number");
    }
    expect(attemptAudits.map((call: [string, any]) => call[1].attempt)).toEqual([1, 2, 3, 4, 5]);
    const unprovenAudit = appendEntry.mock.calls.find(([, data]: [string, any]) => data.kind === "unproven");
    expect(unprovenAudit).toBeDefined();
    expect((unprovenAudit![1] as any).durationMs).toBe(37_000);
    expect((unprovenAudit![1] as any).error).toBe("ECONNRESET");
  });

  it("503 then 200 proven-hit ⇒ retried and succeeds", async () => {
    const { fetchImpl, calls } = sequencedFetch([httpStep(503), provenHitStep]);
    const { service, clock } = harness({ fetchImpl });
    await armAndTick(service, clock);
    clock.advance(2_000);
    await flush();

    expect(calls()).toBe(2);
    const report = service.report();
    expect(report.session.pings).toBe(1);
    expect(report.session.unprovenTotal).toBe(0);
  });

  it("429 is retryable too", async () => {
    const { fetchImpl, calls } = sequencedFetch([httpStep(429), provenHitStep]);
    const { service, clock } = harness({ fetchImpl });
    await armAndTick(service, clock);
    clock.advance(2_000);
    await flush();
    expect(calls()).toBe(2);
    expect(service.report().session.pings).toBe(1);
  });
});

describe("cache-keepalive service — ping retry (non-retryable outcomes are final immediately)", () => {
  it("accepted-then-lost is never retried (may already be billed)", async () => {
    const { fetchImpl, calls } = sequencedFetch([acceptedThenLostStep, provenHitStep]);
    const { service, clock } = harness({ fetchImpl });
    await armAndTick(service, clock);
    // No backoff pending — should already be final.
    expect(calls()).toBe(1);
    const report = service.report();
    expect(report.session.unprovenTotal).toBe(1);
    expect(report.session.lastUnproven?.kind).toBe("accepted-then-lost");
    expect(report.lastPingDiagnostics?.attempts).toBe(1);
  });

  it("httpStatus is recorded in lastPingDiagnostics for http unproven only (in-memory, not rendered)", async () => {
    const http = sequencedFetch([httpStep(403)]);
    const a = harness({ fetchImpl: http.fetchImpl });
    await armAndTick(a.service, a.clock);
    const d = a.service.report().lastPingDiagnostics!;
    expect(d.outcomeKind).toBe("http");
    expect(d.httpStatus).toBe(403);
    // /cache-ttl status output is independent of the in-memory-only field.
    const rep = a.service.report();
    const stripped = { ...rep, lastPingDiagnostics: { ...d, httpStatus: undefined } };
    expect(renderKeepaliveReportLines(rep)).toEqual(renderKeepaliveReportLines(stripped));

    const net = sequencedFetch([acceptedThenLostStep]);
    const b = harness({ fetchImpl: net.fetchImpl });
    await armAndTick(b.service, b.clock);
    const d2 = b.service.report().lastPingDiagnostics!;
    expect("httpStatus" in d2).toBe(false);

    const hit = sequencedFetch([provenHitStep]);
    const c = harness({ fetchImpl: hit.fetchImpl });
    await armAndTick(c.service, c.clock);
    expect("httpStatus" in c.service.report().lastPingDiagnostics!).toBe(false);
  });

  it("400 (a plain 4xx, not in the retryable set) is never retried", async () => {
    const { fetchImpl, calls } = sequencedFetch([httpStep(400), provenHitStep]);
    const { service, clock } = harness({ fetchImpl });
    await armAndTick(service, clock);
    expect(calls()).toBe(1);
    const report = service.report();
    expect(report.session.unprovenTotal).toBe(1);
    expect(report.session.lastUnproven?.kind).toBe("http");
    expect(report.lastPingDiagnostics?.attempts).toBe(1);
  });
});

describe("cache-keepalive service — ping retry safety (epoch/abort/dispose/TTL)", () => {
  it("a real request preempting mid-backoff (epoch bump) ⇒ retry never sent, nothing counted", async () => {
    const { fetchImpl, calls } = sequencedFetch([networkErrorStep, provenHitStep]);
    const { service, clock } = harness({ fetchImpl });
    await armAndTick(service, clock);
    expect(calls()).toBe(1);
    const beforePreempt = service.report();
    const consecutiveUnprovenBefore = beforePreempt.session.consecutiveUnproven;
    const unprovenTotalBefore = beforePreempt.session.unprovenTotal;

    // Real request arrives while the ping is waiting out its 2s backoff.
    service.noteRequest(capture({}, service.instanceId, 40_000));
    service.noteRequestSettled("s1", service.instanceId);

    clock.advance(2_000); // fires the (now stale) backoff timer
    await flush();

    expect(calls()).toBe(1); // the retry attempt never actually fired
    const final = service.report();
    expect(final.session.consecutiveUnproven).toBe(consecutiveUnprovenBefore); // untouched
    expect(final.session.unprovenTotal).toBe(unprovenTotalBefore); // untouched
  });

  it("dispose() during backoff wait: no leaked timer, retry never fires", async () => {
    const { fetchImpl, calls } = sequencedFetch([networkErrorStep, provenHitStep]);
    const { service, clock, ctx } = harness({ fetchImpl });
    await armAndTick(service, clock);
    expect(calls()).toBe(1);
    expect(clock.pendingTimers).toBeGreaterThan(0); // self-tick timer + backoff timer

    service.dispose();
    expect(clock.pendingTimers).toBe(0);
    expect(ctx.ui.setStatus as ReturnType<typeof vi.fn>).toHaveBeenLastCalledWith("cache-ttl", undefined);

    clock.advance(10_000); // would have fired the backoff if it had leaked
    await flush();
    expect(calls()).toBe(1); // never retried after dispose
  });

  it("a ~13s network attempt failing at t≈253s is now RETRIED (15s margin, 2026-10-16): the field-evidence case that never retried under the old 45s margin", async () => {
    // Field evidence (session audit `subagent:cache-keepalive`): two `network` failures,
    // each `attempts: 1`, failing ~13s after send at the default 240s interval. Under the
    // old 45s margin the cutoff was 255_000 — a failure at 253_500 leaves 1_500ms, less
    // than the first 2s backoff, so the strict `remainingMs < delayMs` check refuses the
    // retry (this test fails under the old margin). With the 15s margin the cutoff is
    // 285_000: 31_500ms remain, so the 2s backoff fires and the second attempt succeeds.
    const { fetchImpl, calls, settle } = manualFetch();
    const { service, clock, appendEntry } = harness({ fetchImpl });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000); // fires the ping
    await flush();
    expect(calls()).toBe(1);

    clock.advance(13_500); // time passes while attempt #1 is in flight; t=253_500
    settle(0, { reject: Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }) });
    await flush();

    const attemptAudits = appendEntry.mock.calls.filter(([, data]: [string, any]) => data.kind === "ping-attempt");
    expect(attemptAudits).toHaveLength(1); // only attempt 1 so far
    expect((attemptAudits[0]![1] as any).durationMs).toBe(13_500); // attempt wall time
    expect((attemptAudits[0]![1] as any).error).toBe("ECONNRESET");

    clock.advance(2_000); // the 2s backoff now fits (31.5s remain before the 285s cutoff)
    await flush();
    expect(calls()).toBe(2); // THE retry — the whole point of the margin change
    settle(1, {
      resolve: fakeOkResponse([messageStartChunk({ cache_read_input_tokens: 500, cache_creation_input_tokens: 0 })]),
    });
    await flush();

    const report = service.report();
    expect(report.session.pings).toBe(1); // proven hit on attempt 2
    expect(report.session.unprovenTotal).toBe(0);
    expect(report.lastPingDiagnostics?.outcomeKind).toBe("proven-hit");
    expect(report.lastPingDiagnostics?.attempts).toBe(2);
  });

  it("insufficient TTL headroom for another attempt ⇒ no retry, last outcome counted as final", async () => {
    // The first attempt is left "in flight" under the FakeClock long enough that, once
    // it fails, less than the 2s backoff remains before aliveUntil - TTL_SAFETY_MARGIN_MS
    // (ASSUMED_TTL_MS 300_000 - TTL_SAFETY_MARGIN_MS 15_000 = 285_000 absolute).
    const { fetchImpl, calls, settle } = manualFetch();
    const { service, clock } = harness({ fetchImpl });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000); // fires the ping (remaining to margin: 285_000 - 240_000 = 45_000)
    await flush();
    expect(calls()).toBe(1);

    clock.advance(43_500); // time passes while attempt #1 is in flight; remaining now 1_500ms
    settle(0, { reject: new Error("network down") });
    await flush();

    expect(calls()).toBe(1); // 1_500ms remaining < the 2s backoff ⇒ no retry attempted
    const report = service.report();
    expect(report.session.unprovenTotal).toBe(1);
    expect(report.session.lastUnproven?.kind).toBe("network");
    expect(report.lastPingDiagnostics?.attempts).toBe(1);
    // A code-less Error degrades to its name in the descriptor (never the message —
    // "network down" must not leak into the audit trail).
    expect(report.lastPingDiagnostics?.error).toBe("Error");
    expect(report.lastPingDiagnostics?.durationMs).toBe(43_500);
  });
});
