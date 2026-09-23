import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import {
  createCacheKeepaliveService,
  type CacheKeepaliveDeps,
  type CacheKeepaliveService,
} from "../../src/service/cache-keepalive.js";
import type { CacheTtlSettings } from "../../src/config/settings.js";
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

function provenHitFetch(): typeof fetch {
  return vi.fn(async () =>
    fakeOkResponse([messageStartChunk({ cache_read_input_tokens: 500, cache_creation_input_tokens: 0 })]),
  ) as unknown as typeof fetch;
}
function noUsageFetch(): typeof fetch {
  return vi.fn(async () =>
    fakeOkResponse([messageStartChunk({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })]),
  ) as unknown as typeof fetch;
}
/** fetch that hangs until manually resolved via the returned `resolve()`. */
function hangingFetch(): { fetchImpl: typeof fetch; resolve: (chunks: string[]) => void } {
  let resolver: ((res: Response) => void) | undefined;
  const fetchImpl = vi.fn(
    () =>
      new Promise<Response>((res) => {
        resolver = res;
      }),
  ) as unknown as typeof fetch;
  return {
    fetchImpl,
    resolve: (chunks: string[]) => resolver?.(fakeOkResponse(chunks)),
  };
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const SETTINGS: CacheTtlSettings = {
  mode: "auto",
  keepalive: true,
  keepaliveIntervalMs: 240_000,
  keepaliveMaxPings: 11,
  keepaliveMinPrefixTokens: 20_000,
  keepaliveUpgradeAfterBudget: true,
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
    backgroundBusy: () => true, // armed by default so tests don't need to fake background jobs
    isCurrent: (s) => self === s,
    fetchImpl: provenHitFetch(),
    appendEntry,
    emit,
    ...overrides,
  });
  self = service;
  return { clock, ctx, service, appendEntry, emit };
}

describe("cache-keepalive service — I-K6/I-K9 identity guards", () => {
  it("accepts a matching sessionId+instance and rejects everything else", () => {
    const { service } = harness();
    service.noteRequest(capture({}, "wrong-instance"));
    expect(service.report().window.capture).toBeUndefined();
    expect(service.report().dropped.instanceMismatch).toBe(1);

    service.noteRequest(capture({ sessionId: "other" }, service.instanceId));
    expect(service.report().dropped.sessionMismatch).toBe(1);

    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    expect(service.report().window.capture).toBeDefined();
  });

  it("rejects even a correct sessionId+instance once isCurrent() says otherwise (/reload rebuild window)", () => {
    let allowCurrent = true;
    const { service } = harness({ isCurrent: () => allowCurrent });
    allowCurrent = false;
    service.noteRequest(capture({}, service.instanceId));
    expect(service.report().dropped.instanceMismatch).toBe(1);
    expect(service.report().window.capture).toBeUndefined();
  });

  it("rejects sessionId === '' outright", () => {
    const { service } = harness();
    service.noteRequest(capture({ sessionId: "" }, service.instanceId));
    expect(service.report().dropped.sessionMismatch).toBe(1);
  });
});

describe("cache-keepalive service — tick self-arm / self-stop", () => {
  it("arms on noteRequest and stops once the window is a terminal skip (disabled)", () => {
    const { service, clock } = harness({ settings: { ...SETTINGS, keepalive: false } });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    // config.enabled is false ⇒ evaluateTick's very first check is a terminal skip.
    clock.advance(15_000);
    expect(clock.pendingTimers).toBe(0);
  });

  it("keeps re-arming (not-due) until the interval elapses, then pings", async () => {
    const { service, clock } = harness();
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    expect(clock.pendingTimers).toBe(1);
    clock.advance(200_000); // still short of the 240s interval
    expect(service.report().window.pings).toBe(0);
    expect(clock.pendingTimers).toBe(1); // kept re-arming (not-due, non-terminal)
    clock.advance(45_000); // crosses the 240s interval
    await flush();
    expect(service.report().window.pings).toBe(1);
    expect(service.report().session.pings).toBe(1); // proven-hit
  });

  it("dispose() clears the timer, aborts in-flight fetch, and is idempotent", async () => {
    const { fetchImpl, resolve } = hangingFetch();
    const { service, clock, ctx } = harness({ fetchImpl });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();
    expect(clock.pendingTimers).toBeGreaterThan(0); // ping in flight, tick re-armed
    service.dispose();
    expect(clock.pendingTimers).toBe(0);
    expect(ctx.ui.setStatus as ReturnType<typeof vi.fn>).toHaveBeenLastCalledWith("cache-ttl", undefined);
    service.dispose(); // idempotent
    resolve(["irrelevant"]);
    await flush();
  });

  it("keeps the adaptive segments when a ping-driven publish re-renders the shared status key", async () => {
    // Both services own the one merged "cache-ttl" key. Before adaptiveSnapshot
    // was injected, any keepalive publish blanked the adaptive segments until
    // the next real request re-rendered them (visible as status-bar flicker).
    const adaptiveSnapshot = vi.fn(() => ({ lastDecision: { ttl: "1h" as const } }) as never);
    const { service, ctx } = harness({ adaptiveSnapshot });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    await flush();
    expect(adaptiveSnapshot).toHaveBeenCalled();
    service.dispose();
  });
});

describe("cache-keepalive service — I-K8 window-epoch guard (preemption + late results)", () => {
  it("drops a proven-hit that arrives after a real request preempted the window", async () => {
    const { fetchImpl, resolve } = hangingFetch();
    const { service, clock } = harness({ fetchImpl });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000); // fires the ping, which now hangs mid-flight
    await flush();
    const beforePreempt = service.report();
    expect(beforePreempt.window.pingInFlight).toBe(true);

    // A real request comes back — preempts the window (bumps windowEpoch).
    service.noteRequest(capture({}, service.instanceId, 40_000));
    service.noteRequestSettled("s1", service.instanceId);
    const afterRealRequest = service.report();
    expect(afterRealRequest.window.windowEpoch).toBe(beforePreempt.window.windowEpoch + 1);
    const aliveUntilAfterReal = afterRealRequest.window.aliveUntil;
    const consecutiveUnprovenAfterReal = afterRealRequest.session.consecutiveUnproven;

    // The stale ping now resolves as a (would-be) proven hit — must be dropped entirely.
    resolve([messageStartChunk({ cache_read_input_tokens: 999, cache_creation_input_tokens: 0 })]);
    await flush();

    const final = service.report();
    expect(final.dropped.epochMismatch).toBeGreaterThan(0);
    expect(final.session.pings).toBe(0); // never counted as a proven hit
    expect(final.window.aliveUntil).toBe(aliveUntilAfterReal); // not pushed forward by the stale result
    expect(final.session.consecutiveUnproven).toBe(consecutiveUnprovenAfterReal); // not "cleared" by the stale hit
  });

  it("drops a stale unproven result the same way (does not poison the new window's breaker)", async () => {
    const { fetchImpl, resolve } = hangingFetch();
    const { service, clock } = harness({ fetchImpl });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();
    service.noteRequest(capture({}, service.instanceId, 40_000)); // preempts
    service.noteRequestSettled("s1", service.instanceId);
    const before = service.report();
    resolve([]); // stream ends with no message_start ⇒ accepted-then-lost
    await flush();
    const after = service.report();
    expect(after.dropped.epochMismatch).toBeGreaterThan(0);
    expect(after.session.unprovenTotal).toBe(before.session.unprovenTotal);
    expect(after.session.consecutiveUnproven).toBe(before.session.consecutiveUnproven);
    expect(after.session.disabled).toBeUndefined();
  });
});

describe("cache-keepalive service — I-K7 proven-hit-only breaker", () => {
  it("disables the session forever after a proven-write, and a later real request does not revive it", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeOkResponse([messageStartChunk({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200 })]),
    ) as unknown as typeof fetch;
    const { service, clock } = harness({ fetchImpl });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();
    expect(service.report().session.disabled?.reason).toBe("proven-write");

    service.noteRequest(capture({}, service.instanceId, 40_000));
    service.noteRequestSettled("s1", service.instanceId);
    expect(service.report().session.disabled).toBeDefined(); // real request never resets it (I-K7)
    clock.advance(500_000);
    await flush();
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1); // never pings again
  });

  it("disables after two consecutive unproven results, closed by an intervening real request", async () => {
    const fetchImpl = noUsageFetch();
    const { service, clock } = harness({ fetchImpl });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();
    expect(service.report().session.consecutiveUnproven).toBe(1);
    expect(service.report().session.disabled).toBeUndefined();

    service.noteRequest(capture({}, service.instanceId, 40_000)); // window reset; breaker untouched
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();
    expect(service.report().session.consecutiveUnproven).toBe(2);
    expect(service.report().session.disabled?.reason).toBe("no-usage");
  });
});

describe("cache-keepalive service — armed signals", () => {
  it("arms from tool_execution activity and demotes to not-armed once tools/prompts settle", () => {
    const { service, clock } = harness({ backgroundBusy: () => false });
    service.noteToolStart("s1", service.instanceId);
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(200_000);
    expect(service.report().armed).toBe(true);
    service.noteToolEnd("s1", service.instanceId);
    expect(service.report().armed).toBe(false);
  });

  it("agent_settled force-clears leaked tool/ui-prompt counters", () => {
    const { service } = harness({ backgroundBusy: () => false });
    service.noteToolStart("s1", service.instanceId);
    service.noteUiPromptStart("s1", service.instanceId);
    service.noteAgentSettled("s1", service.instanceId);
    expect(service.report().armed).toBe(false);
  });
});

describe("cache-keepalive service — budget + upgrade", () => {
  it("stops at maxPings, sets upgradePending, and consumeUpgrade fires only once when the cache is presumed dead", async () => {
    const fetchImpl = provenHitFetch();
    const { service, clock } = harness({
      fetchImpl,
      settings: { ...SETTINGS, keepaliveMaxPings: 1 },
    });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();
    expect(service.report().window.pings).toBe(1);
    clock.advance(240_000);
    await flush();
    expect(service.report().window.pings).toBe(1); // budget exhausted, no 2nd ping
    expect(clock.pendingTimers).toBe(0); // terminal skip — no more re-arming

    clock.advance(400_000); // now way past the assumed TTL since the last read
    const consumed = service.consumeUpgrade("s1", service.instanceId, clock.now());
    expect(consumed).toBe(true);
    expect(service.consumeUpgrade("s1", service.instanceId, clock.now())).toBe(false); // one-shot
  });
});

describe("cache-keepalive service — audit diagnostics (root-cause fix follow-up)", () => {
  it("a proven-hit audit entry carries the elapsed time, prefix info, header source, and raw cache token counts", async () => {
    const fetchImpl = provenHitFetch();
    const { service, clock, appendEntry } = harness({ fetchImpl });
    service.noteRequest(capture({ headers: { "content-type": "application/json" } }, service.instanceId, 30_000));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();

    const entry = (appendEntry as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, data]: [string, any]) => data.kind === "proven-hit",
    );
    expect(entry).toBeDefined();
    const [customType, data] = entry as [string, Record<string, unknown>];
    expect(customType).toBe("subagent:cache-keepalive");
    expect(data.elapsedSinceCaptureMs).toBe(240_000); // capturedAt: 0, ping resolved at clock=240_000
    expect(data.prefixTokens).toBe(30_000);
    expect(data.prefixSource).toBe("usage");
    expect(data.cacheReadInputTokens).toBe(500); // from provenHitFetch's message_start usage
    expect(data.cacheCreationInputTokens).toBe(0);
    expect(data.headerSource).toBe("captured+auth-filled"); // default fakeCtx auth resolves apiKey "sk-ant-api-x", filled into x-api-key
    expect(data.headerKeyDiff).toEqual(["x-api-key"]);
    expect(data.model).toBe("claude-x");
    expect(data.baseUrl).toBe("https://api.anthropic.com");
  });

  it("an unproven (proven-write) audit entry carries the actual cache_creation_input_tokens value", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeOkResponse([messageStartChunk({ cache_read_input_tokens: 0, cache_creation_input_tokens: 777 })]),
    ) as unknown as typeof fetch;
    const { service, clock, appendEntry } = harness({ fetchImpl });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();

    const entry = (appendEntry as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, data]: [string, any]) => data.kind === "unproven",
    );
    expect(entry).toBeDefined();
    const [, data] = entry as [string, Record<string, unknown>];
    expect(data.unprovenKind).toBe("proven-write");
    expect(data.cacheCreationInputTokens).toBe(777);
    expect(data.cacheReadInputTokens).toBe(0);
    expect(data.disabled).toBe(true); // a single proven-write disables the session (I-K7)
  });

  it("headerSource flips to 'captured+auth-filled' and headerKeyDiff lists only the filled key names (never values)", async () => {
    const fetchImpl = provenHitFetch();
    const { service, clock, ctx, appendEntry } = harness({ fetchImpl });
    (ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      apiKey: "sk-ant-api-secret-value",
      headers: {},
    });
    // Capture had no authorization/x-api-key at all — auth fallback must fill x-api-key.
    service.noteRequest(capture({ headers: { "content-type": "application/json" } }, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();

    const entry = (appendEntry as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, data]: [string, any]) => data.kind === "proven-hit",
    );
    const [, data] = entry as [string, Record<string, unknown>];
    expect(data.headerSource).toBe("captured+auth-filled");
    expect(data.headerKeyDiff).toEqual(["x-api-key"]);
    // Never leak the secret value into the audit trail.
    expect(JSON.stringify(data)).not.toContain("sk-ant-api-secret-value");
  });
});

/** fetchImpl that hangs on connect until aborted, then rejects (no response headers ever received). */
function hangingRejectFetch(): typeof fetch {
  return vi.fn((_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }) as unknown as typeof fetch;
}

describe("cache-keepalive service — no-auth and m2 TTL-margin re-check never spend the budget", () => {
  it("no-auth: refunds the budget and never calls fetch", async () => {
    const fetchImpl = vi.fn();
    const { service, clock, ctx } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
    (ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: "no key",
    });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(service.report().window.pings).toBe(0); // refunded
    expect(service.report().session.unprovenTotal).toBe(0); // never counted as unproven
  });
});

describe("cache-keepalive service — M1 fingerprint-drift-after-auth refund (validation report Blocker M1)", () => {
  it("model drift discovered after auth resolves: refunds the budget (pingInFlight cleared, pings not leaked), still invalidates, fetch never called, not counted as unproven", async () => {
    const fetchImpl = vi.fn();
    const { service, clock, ctx } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
    (ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // Simulate the model changing out from under us while the auth await is pending.
      (ctx.model as { id: string }).id = "claude-drifted";
      return { ok: true, apiKey: "sk-ant-api-x", headers: {} };
    });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();

    expect(fetchImpl).not.toHaveBeenCalled(); // HTTP never left this process
    const report = service.report();
    expect(report.window.pingInFlight).toBe(false); // M1: must not leak in-flight forever
    expect(report.window.pings).toBe(0); // M1: the pre-spent budget unit must be refunded
    expect(report.window.capture).toBeUndefined(); // invalidated (drift)
    expect(report.session.unprovenTotal).toBe(0); // never counted against the breaker
    expect(report.session.consecutiveUnproven).toBe(0);
    expect(report.session.disabled).toBeUndefined();
  });

  it("baseUrl drift discovered after auth resolves: same refund + invalidate guarantee", async () => {
    const fetchImpl = vi.fn();
    const { service, clock, ctx } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
    (ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      (ctx.model as { baseUrl: string }).baseUrl = "https://drifted.example.com";
      return { ok: true, apiKey: "sk-ant-api-x", headers: {} };
    });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();

    expect(fetchImpl).not.toHaveBeenCalled();
    const report = service.report();
    expect(report.window.pingInFlight).toBe(false);
    expect(report.window.pings).toBe(0);
    expect(report.window.capture).toBeUndefined();
    expect(report.session.unprovenTotal).toBe(0);
  });

  it("auth header-keys drift discovered right as auth resolves (locked-in value diverges from the captured placeholder): same refund + invalidate guarantee", async () => {
    // `buildFingerprintContext` always captures `authHeaderKeys: ""` (real headers are unknown
    // until auth resolves) — the first successful auth response's header keys get locked in and
    // compared against that captured placeholder. Non-empty headers surface a same-shape drift
    // to `compareFingerprint`'s `authHeaderKeys` field, exercising the M1 refund-then-invalidate
    // order for this field too.
    const fetchImpl = vi.fn();
    const { service, clock, ctx } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
    (ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      apiKey: "sk-ant-api-x",
      headers: { "x-api-key": "abc" },
    });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();

    const report = service.report();
    expect(fetchImpl).not.toHaveBeenCalled(); // never reached sendKeepalivePing
    expect(report.window.pingInFlight).toBe(false); // M1: not leaked
    expect(report.window.pings).toBe(0); // M1: refunded, not leaked at 1
    expect(report.window.capture).toBeUndefined(); // invalidated (authHeaderKeys drift)
    expect(report.session.pings).toBe(0);
    expect(report.session.unprovenTotal).toBe(0); // never counted against the breaker
  });
});

describe("cache-keepalive service — m1 fetch-reject late path (validation report Minor m1)", () => {
  it("a real request preempting an in-flight ping whose fetch then rejects (abort) is dropped entirely: no proven/unproven counting, no aliveUntil/breaker movement", async () => {
    const fetchImpl = hangingRejectFetch();
    const { service, clock } = harness({ fetchImpl });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000); // fires the ping; fetch hangs on connect (no headers yet)
    await flush();
    const beforePreempt = service.report();
    expect(beforePreempt.window.pingInFlight).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A real request preempts the window: `noteRequest` aborts the in-flight controller
    // (since `pingInFlight` is true), which rejects the hanging fetch promise above, and
    // bumps windowEpoch so the eventual rejection lands on a stale epoch.
    service.noteRequest(capture({}, service.instanceId, 40_000));
    service.noteRequestSettled("s1", service.instanceId);
    const afterRealRequest = service.report();
    const aliveUntilAfterReal = afterRealRequest.window.aliveUntil;
    const consecutiveUnprovenAfterReal = afterRealRequest.session.consecutiveUnproven;
    const unprovenTotalAfterReal = afterRealRequest.session.unprovenTotal;

    await flush(); // let the aborted fetch promise reject and runPing's post-await epoch check run

    const final = service.report();
    expect(final.dropped.epochMismatch).toBeGreaterThan(0);
    expect(final.session.pings).toBe(0); // never counted as a proven hit
    expect(final.session.unprovenTotal).toBe(unprovenTotalAfterReal); // untouched by the stale reject
    expect(final.session.consecutiveUnproven).toBe(consecutiveUnprovenAfterReal);
    expect(final.session.disabled).toBeUndefined();
    expect(final.window.aliveUntil).toBe(aliveUntilAfterReal); // not moved by the stale result
  });
});
