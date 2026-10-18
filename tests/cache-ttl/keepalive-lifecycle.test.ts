import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import {
  createCacheKeepaliveService,
  type CacheKeepaliveDeps,
  type CacheKeepaliveService,
  UI_PROMPT_KEEPALIVE_MAX_MS,
} from "../../src/service/cache-keepalive.js";
import type { CacheTtlSettings } from "../../src/config/settings.js";
import {
  readBackKeepaliveSessionState,
  renderKeepaliveReportLines,
  type CapturedRequest,
} from "../../src/cache-ttl/keepalive-state.js";

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
function httpFetch(status: number): typeof fetch {
  return vi.fn(
    async () => ({ ok: false, status, body: undefined, text: async () => "" }) as unknown as Response,
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
  keepaliveMinPrefixTokens: 20_000,
};

function fakeCtx(overrides: Record<string, unknown> = {}) {
  const ctx = {
    ui: { setStatus: vi.fn() },
    mode: "tui",
    model: {
      provider: "anthropic",
      api: "anthropic-messages",
      id: "claude-x",
      baseUrl: "https://api.anthropic.com",
      headers: {},
      cost: { cacheRead: 0.3, cacheWrite: 3.75, tiers: [] },
    },
    modelRegistry: {
      find: vi.fn(),
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "sk-ant-api-x", headers: {} }),
    },
    sessionManager: { getSessionId: () => "s1" },
    ...overrides,
  };
  ctx.modelRegistry.find?.mockImplementation((provider: string, id: string) =>
    provider === ctx.model.provider && id === ctx.model.id ? ctx.model : undefined,
  );
  return ctx;
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
  ctx.modelRegistry.find?.mockImplementation((provider: string, id: string) =>
    provider === ctx.model.provider && id === ctx.model.id ? ctx.model : undefined,
  );
  return ctx;
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
    recoverTransientFailures: true,
    persistSessionState: true,
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
    // todo #28: the periodic 15s tick AND the new precise `nextPingAt` one-shot timer are both pending.
    expect(clock.pendingTimers).toBe(2);
    clock.advance(200_000); // still short of the 240s interval
    expect(service.report().window.pings).toBe(0);
    expect(clock.pendingTimers).toBe(2); // kept re-arming (not-due, non-terminal) + the still-pending exact timer
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

  it("recovers a transient disable only after a successful real response, then pings the next idle window", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeOkResponse([]))
      .mockResolvedValueOnce(fakeOkResponse([]))
      .mockResolvedValueOnce(
        fakeOkResponse([messageStartChunk({ cache_read_input_tokens: 500 })]),
      ) as unknown as typeof fetch;
    const { service, clock, appendEntry } = harness({ fetchImpl });
    for (let i = 0; i < 2; i += 1) {
      service.noteRequest(capture({}, service.instanceId, 30_000 + i));
      service.noteRequestSettled("s1", service.instanceId);
      clock.advance(240_000);
      await flush();
    }
    // accepted-then-lost (possibly billed) still uses the transient breaker; network/408 no longer do (#29 r2).
    expect(service.report().session.disabled).toEqual({
      reason: "accepted-then-lost",
      at: 480_000,
      transient: true,
    });

    const branch = appendEntry.mock.calls.map(([customType, data]) => ({ type: "custom", customType, data }));
    const restored = readBackKeepaliveSessionState(branch);
    // read-back lifts a legacy transient pause (#29 r2 migration).
    expect(restored?.disabled).toBeUndefined();

    service.noteRequest(capture({}, service.instanceId, 40_000));
    service.noteRequestSettled("s1", service.instanceId, true);
    expect(service.report().session.disabled).toBeUndefined();
    expect(service.report().session.transientUnprovenTotal).toBe(0);
    clock.advance(240_000);
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(service.report().session.pings).toBe(1);
  });

  it("does not recover a transient disable when the real request settles with an error", async () => {
    const fetchImpl = vi.fn(async () => fakeOkResponse([])) as unknown as typeof fetch;
    const { service, clock } = harness({ fetchImpl });
    for (let i = 0; i < 2; i += 1) {
      service.noteRequest(capture({}, service.instanceId, 30_000 + i));
      service.noteRequestSettled("s1", service.instanceId);
      clock.advance(240_000);
      await flush();
    }
    const disabled = service.report().session.disabled;
    expect(disabled?.transient).toBe(true);
    service.noteRequest(capture({}, service.instanceId, 40_000));
    service.noteRequestSettled("s1", service.instanceId, false);
    expect(service.report().session.disabled).toEqual(disabled);
  });
});

describe("cache-keepalive service — #29 r2 retry until the cache expires", () => {
  it("retries a 408 on the 2/5/10/20/30s schedule until the window margin runs out and never pauses the session", async () => {
    const fetchImpl = httpFetch(408);
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const { service, clock } = harness({ fetchImpl, settings: { ...SETTINGS, keepaliveIntervalMs: 60_000 } });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    const times: number[] = [];
    let seen = 0;
    for (let t = 0; t < 400; t += 1) {
      clock.advance(1_000);
      await flush();
      while (seen < calls.length) {
        times.push(clock.now());
        seen += 1;
      }
    }
    // first attempt at the 60s tick, then +2,+5,+10,+20,+30,+30,... gaps.
    const gaps = times.slice(1, 9).map((x, i) => x - times[i]!);
    expect(gaps.slice(0, 5)).toEqual([2_000, 5_000, 10_000, 20_000, 30_000]);
    expect(gaps[5]).toBe(30_000);
    expect(times.length).toBeGreaterThan(6);
    expect(service.report().session.disabled).toBeUndefined();
    expect(service.report().session.transientUnprovenTotal).toBe(0);
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

describe("cache-keepalive service — UI-prompt episode budget", () => {
  const HOUR = UI_PROMPT_KEEPALIVE_MAX_MS;
  it("constant is 60 minutes", () => expect(HOUR).toBe(3_600_000));

  it("prompt-only arming expires at 60 min with skip reason ui-prompt-expired", async () => {
    const { service, clock, ctx } = harness({ backgroundBusy: () => false });
    ctx.model.cost.cacheWrite = 60 * ctx.model.cost.cacheRead; // generous ping budget so the 60 min cap is what ends arming
    service.noteToolStart("s1", service.instanceId); // ask_user is itself a tool
    service.noteUiPromptStart("s1", service.instanceId);
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    // keepalive pings keep the window alive while the prompt is pending
    for (let t = 0; t < HOUR - 60_000; t += 60_000) {
      clock.advance(60_000);
      await flush();
    }
    expect(service.report().armed).toBe(true);
    clock.advance(60_000);
    expect(service.report().armed).toBe(false);
    clock.advance(30_000); // a tick runs
    await flush();
    expect(service.report().lastSkip).toBe("ui-prompt-expired");
  });

  it("background time does not count: prompt 30 min → bg 3 h → bg ends ⇒ another full hour", () => {
    let busy = false;
    const { service, clock } = harness({ backgroundBusy: () => busy });
    service.noteUiPromptStart("s1", service.instanceId); // prompt-only clock starts
    clock.advance(HOUR / 2);
    expect(service.report().armed).toBe(true);
    busy = true; // subagent starts
    expect(service.report().armed).toBe(true); // sample clears the prompt-only clock
    clock.advance(3 * HOUR);
    expect(service.report().armed).toBe(true);
    busy = false; // subagent ends, prompt still unanswered
    expect(service.report().armed).toBe(true); // clock restarts now
    clock.advance(HOUR - 1);
    expect(service.report().armed).toBe(true);
    clock.advance(1);
    expect(service.report().armed).toBe(false);
  });

  it("prompt opened while background busy only starts counting once background ends", () => {
    let busy = true;
    const { service, clock } = harness({ backgroundBusy: () => busy });
    service.noteUiPromptStart("s1", service.instanceId);
    clock.advance(2 * HOUR);
    busy = false;
    expect(service.report().armed).toBe(true);
    clock.advance(HOUR);
    expect(service.report().armed).toBe(false);
  });

  it("after expiry, prompt end + new work resumes pings", async () => {
    const { service, clock, ctx } = harness({ backgroundBusy: () => false });
    ctx.model.cost.cacheWrite = 60 * ctx.model.cost.cacheRead;
    service.noteUiPromptStart("s1", service.instanceId);
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    for (let t = 0; t < HOUR + 120_000; t += 60_000) {
      clock.advance(60_000);
      await flush();
    }
    expect(service.report().lastSkip).toBe("ui-prompt-expired");
    service.noteUiPromptEnd("s1", service.instanceId);
    service.noteToolStart("s1", service.instanceId); // new work
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    for (let t = 0; t < 10 * 60_000; t += 30_000) {
      clock.advance(30_000);
      await flush();
    }
    expect(service.report().armed).toBe(true);
    expect(service.report().lastSkip).not.toBe("ui-prompt-expired");
    expect(service.report().window.pings).toBeGreaterThan(0);
  });

  it("a new prompt episode restarts the 60 min budget; prompt end clears it", () => {
    const { service, clock } = harness({ backgroundBusy: () => false });
    service.noteUiPromptStart("s1", service.instanceId);
    clock.advance(HOUR - 60_000);
    service.noteUiPromptEnd("s1", service.instanceId);
    expect(service.report().armed).toBe(false);
    clock.advance(10 * 60_000);
    service.noteUiPromptStart("s1", service.instanceId);
    clock.advance(HOUR - 1);
    expect(service.report().armed).toBe(true);
    clock.advance(1);
    expect(service.report().armed).toBe(false);
    service.noteUiPromptEnd("s1", service.instanceId);
    service.noteToolStart("s1", service.instanceId); // fresh work re-arms normally
    expect(service.report().armed).toBe(true);
  });

  it("activeTools-only (no prompt) is unaffected by the 60 min budget", () => {
    const { service, clock } = harness({ backgroundBusy: () => false });
    service.noteToolStart("s1", service.instanceId);
    clock.advance(HOUR * 3);
    expect(service.report().armed).toBe(true);
  });

  it("nested prompts keep one episode; agent_settled resets it", () => {
    const { service, clock } = harness({ backgroundBusy: () => false });
    service.noteUiPromptStart("s1", service.instanceId);
    clock.advance(HOUR / 2);
    service.noteUiPromptStart("s1", service.instanceId);
    clock.advance(HOUR / 2);
    expect(service.report().armed).toBe(false);
    service.noteAgentSettled("s1", service.instanceId);
    service.noteUiPromptStart("s1", service.instanceId);
    expect(service.report().armed).toBe(true);
  });
});

describe("cache-keepalive service — budget", () => {
  it("stops at maxPings without scheduling any automatic upgrade", async () => {
    const fetchImpl = provenHitFetch();
    const { service, clock, ctx } = harness({
      fetchImpl,
    });
    ctx.model.cost.cacheWrite = 3 * ctx.model.cost.cacheRead;
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();
    expect(service.report().window.pings).toBe(1);
    clock.advance(240_000);
    await flush();
    expect(service.report().window.pings).toBe(1); // budget exhausted, no 2nd ping
    expect(clock.pendingTimers).toBe(0); // terminal skip — no more re-arming

    expect(service.report().lastSkip).toBe("budget-exhausted");
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
      // Real auth resolution is never synchronous (network/keychain I/O) — the mutation
      // must land AFTER an actual await, not as a side effect of merely CALLING the mock,
      // otherwise it becomes visible to a synchronously-coincident tick (todo #28's exact
      // timer can legitimately fire in the same batch as the periodic one at this interval).
      await Promise.resolve();
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
      await Promise.resolve(); // see the model-drift test's comment above
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

// todo #28: at the default/max `keepaliveIntervalMs` (240s), the gap between
// `nextPingAt` and the cache-expired cutoff can be small enough that the periodic
// tick's coarse phase misses it — see `MAX_SAFE_KEEPALIVE_INTERVAL_MS`'s doc comment
// in keepalive-state.ts. At the time of the fix (2026-09-27, 45s safety margin) the gap
// was exactly one `TICK_INTERVAL_MS` (15s) — one guaranteed in-window opportunity;
// since the margin shrank to 15s (2026-10-16) the gap is 45s (three grid points), so a
// window now needs THREE coincidentally-unfavorable ticks to sink — but the phase-miss
// risk the fix addresses is unchanged (real-machine repro: 3 windows, 1 hit). The fix
// adds a second, independent one-shot timer scheduled EXACTLY at `nextPingAt` (reusing
// `onTick()`/`evaluateTick` verbatim — every existing gate still applies).
describe("cache-keepalive service — todo #28: precise nextPingAt timer", () => {
  it("fires exactly at nextPingAt, catching a window the periodic tick's coarse phase would sink (its one in-window opportunity coincides with a transient not-armed instant)", async () => {
    const { service, clock } = harness({ backgroundBusy: () => false });
    // The periodic tick's phase is anchored to t=0 (this arm() call), NOT to the window's
    // own start — a real, common case (tool activity already ticking before the capture
    // that opens the window it needs to protect).
    service.noteToolStart("s1", service.instanceId);
    clock.advance(1);
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    // nextPingAt = 1 + 240_000 = 240_001; cutoff = 1 + 300_000 - 15_000 = 285_001 (the safety
    // margin shrank 45s→15s on 2026-10-16). The periodic grid (0, 15_000, 30_000, ...) does NOT
    // include 240_001 — its first point inside [240_001, 285_001) is 255_000, not nextPingAt
    // itself (and the grid's in-window opportunities are now 255_000/270_000/285_000 — three,
    // where the old 45s margin left exactly one).
    clock.advance(240_000); // -> t=240_001: only the new precise timer lands here
    await flush();
    expect(service.report().session.pings).toBe(1); // proven-hit via the precise timer
    expect(service.report().window.lastReadStartedAt).toBe(240_001); // reads exactly at nextPingAt

    // Confirms the scenario is genuinely adversarial for periodic-only polling: the tool
    // goes idle before EVERY grid opportunity in the window (255_000, 270_000) and only
    // comes back after the cutoff (285_001) — under periodic-only ticks (pre-fix) this is
    // precisely what sinks the window (not-armed skips, then cache-expired). Post-fix this
    // is moot (the window already succeeded above); the point is that nothing here regresses.
    clock.advance(14_998); // -> t=254_999
    service.noteToolEnd("s1", service.instanceId);
    clock.advance(30_002); // -> t=285_001: crosses 255_000/270_000 (not-armed) AND the cutoff
    service.noteToolStart("s1", service.instanceId); // armed again, too late to matter
    await flush();
    expect(service.report().session.pings).toBe(1); // unchanged — no phantom second ping
    expect(service.report().session.unprovenTotal).toBe(0); // not-armed is silent, never a breaker hit
  });

  it("a periodic tick and the precise timer tied at exactly the same due time still ping only once (existing pingInFlight guard, no double HTTP call)", async () => {
    const fetchImpl = vi.fn(provenHitFetch());
    const { service, clock } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
    // Anchoring both noteRequest and the periodic arm() at the same t=0 makes the periodic
    // grid (multiples of 15_000) include nextPingAt (240_000) exactly — the tie case.
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // not 2
    expect(service.report().window.pings).toBe(1);
    expect(service.report().session.pings).toBe(1);
  });

  it("a new real request cancels and reschedules the precise timer to the NEW window's nextPingAt (never accumulates a leaked one); dispose leaves nothing pending", async () => {
    const { service, clock } = harness();
    service.noteRequest(capture({}, service.instanceId, 30_000));
    service.noteRequestSettled("s1", service.instanceId);
    expect(clock.pendingTimers).toBe(2); // periodic tick + the precise nextPingAt timer

    clock.advance(60_000); // -> t=60_000, well before the first window's nextPingAt (240_000)
    service.noteRequest(capture({}, service.instanceId, 40_000)); // re-opens the window
    service.noteRequestSettled("s1", service.instanceId);
    expect(clock.pendingTimers).toBe(2); // the stale exact timer was replaced, never grows to 3

    clock.advance(240_000); // -> t=300_000 = the SECOND window's nextPingAt (60_000 + 240_000)
    await flush();
    expect(service.report().session.pings).toBe(1); // pinged at the RESCHEDULED deadline

    service.dispose();
    expect(clock.pendingTimers).toBe(0); // both the periodic tick and the precise timer are gone
  });
});

// todo #28 P1 (verifier finding): `setEnabled(false)` used to only flip `enabledOverride`
// and refresh the UI, leaving the precise exact timer armed at the OLD `nextPingAt` — if
// re-enabled the window could ping at that stale instant. A terminal skip reached via the
// PERIODIC tick (not the exact timer's own self-clearing callback) could likewise leave a
// still-pending exact timer behind. Fixed: `setEnabled(false)`/generic terminal-skip paths
// now call `clearExactTimer()`, and `setEnabled(true)` re-syncs against the CURRENT window.
describe("cache-keepalive service — todo #28 P1: setEnabled(false) cancels the stale exact timer", () => {
  it("disabling cancels the pending exact timer — the old nextPingAt never fires a ping", async () => {
    const fetchImpl = vi.fn(provenHitFetch());
    const { service, clock } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    expect(clock.pendingTimers).toBe(2); // periodic tick + the precise nextPingAt timer

    service.setEnabled(false);
    expect(clock.pendingTimers).toBe(1); // exact timer cancelled; periodic tick still pending

    clock.advance(240_000); // -> nextPingAt (240_000) — pre-fix the exact timer would fire here
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(service.report().session.pings).toBe(0);
    expect(clock.pendingTimers).toBe(0); // periodic tick hit the terminal "disabled" skip and stopped re-arming
  });

  it("disabling then re-enabling does not ping at the old, now-stale nextPingAt instant", async () => {
    const fetchImpl = vi.fn(provenHitFetch());
    const { service, clock } = harness({ fetchImpl: fetchImpl as unknown as typeof fetch });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    service.setEnabled(false);

    clock.advance(300_000); // well past the cache-expired cutoff (255_001) while disabled
    service.setEnabled(true); // re-syncs against the CURRENT window — nextPingAt is now in the past
    clock.advance(0); // let the immediately-due re-synced timer (if any) fire
    await flush();

    expect(fetchImpl).not.toHaveBeenCalled(); // no ping at the stale instant — cache-expired by now
    expect(service.report().session.pings).toBe(0);
  });
});

// todo #28: terminal skips used to be entirely silent (no audit/diagnostic), making a
// real-machine "why didn't it ping" question require session-file archaeology. A window
// that ends in a terminal skip now gets exactly one lightweight diagnostic (never per-tick
// spam) — surfaced both through `report().lastTerminalSkip` (the main session's existing
// status-command channel) and a `subagent:cache-keepalive` jsonl audit entry (child
// sessions' only observable trail, since they have no interactive status command).
describe("cache-keepalive service — todo #28: terminal-skip diagnostic (once per window)", () => {
  it("records exactly one audit entry + report field per window even when the terminal skip re-fires across several re-arms", async () => {
    const { service, clock, appendEntry, ctx } = harness();
    ctx.model.cost.cacheWrite = 3 * ctx.model.cost.cacheRead;
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();
    expect(service.report().window.pings).toBe(1); // the one allowed ping

    // Re-arm the loop several times via tool activity — each re-arm re-evaluates the SAME
    // terminal "budget-exhausted" verdict for this window; the diagnostic must not repeat.
    for (let i = 0; i < 3; i += 1) {
      service.noteToolStart("s1", service.instanceId);
      clock.advance(15_000);
      service.noteToolEnd("s1", service.instanceId);
    }

    const terminalAudits = appendEntry.mock.calls.filter(
      ([, data]: [string, { kind?: string }]) => data.kind === "terminal-skip",
    );
    expect(terminalAudits).toHaveLength(1);
    expect((terminalAudits[0]![1] as { reason?: string }).reason).toBe("budget-exhausted");
    expect(service.report().lastTerminalSkip).toMatchObject({ reason: "budget-exhausted" });

    // A brand-new window (real request bumps windowEpoch) gets its OWN diagnostic.
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();
    // budget-exhausted is only DETECTED on the tick after the one that pinged — give it
    // one more re-arm/tick, same as the first window's loop above.
    service.noteToolStart("s1", service.instanceId);
    clock.advance(15_000);
    service.noteToolEnd("s1", service.instanceId);
    const terminalAuditsAfter = appendEntry.mock.calls.filter(
      ([, data]: [string, { kind?: string }]) => data.kind === "terminal-skip",
    );
    expect(terminalAuditsAfter).toHaveLength(2);
  });

  it("a session with no capture yet (nothing has pinged) never gets the diagnostic — only a window that actually held a capture counts as 'died'", () => {
    const { service, clock, appendEntry } = harness();
    service.noteToolStart("s1", service.instanceId); // arms the loop; no noteRequest() ever happened
    clock.advance(15_000);
    expect(service.report().lastSkip).toBe("no-capture");
    const terminalAudits = appendEntry.mock.calls.filter(
      ([, data]: [string, { kind?: string }]) => data.kind === "terminal-skip",
    );
    expect(terminalAudits).toHaveLength(0);
    expect(service.report().lastTerminalSkip).toBeUndefined();
  });
});

describe("dynamic cap — captured model mapping and response usage", () => {
  it("prices wire model B, not ctx model A; memoizes until a new capture", () => {
    const { service, ctx } = harness();
    const b = { ...ctx.model, id: "wire-b", cost: { cacheRead: 0.025, cacheWrite: 1.25 } };
    ctx.modelRegistry.find.mockImplementation((provider, id) =>
      provider === b.provider && id === b.id ? b : undefined,
    );
    const c = capture({ payload: { model: "wire-b", messages: [], stream: true } }, service.instanceId);
    c.fingerprint.modelId = "wire-b";
    service.noteRequest(c);
    expect(service.report().config).toMatchObject({ maxPings: 48, maxPingsSource: "priced" });
    ctx.modelRegistry.find.mockClear();
    ctx.modelRegistry.find.mockReturnValue({ ...b, cost: { cacheRead: 1, cacheWrite: 3 } });
    for (let i = 0; i < 5; i++) expect(service.report().config.maxPings).toBe(48);
    expect(ctx.modelRegistry.find).not.toHaveBeenCalled();
    service.noteRequest({ ...c });
    expect(service.report().config.maxPings).toBe(1);
    service.dispose();
  });

  it.each(["missing", "throws", "unregistered", "baseUrl", "api"])("uncertain mapping (%s) falls back", (kind) => {
    const { service, ctx } = harness();
    const c = capture({}, service.instanceId);
    c.fingerprint.modelId = "wire-b";
    if (kind === "missing") ctx.modelRegistry.find = undefined as never;
    else if (kind === "throws")
      ctx.modelRegistry.find.mockImplementation(() => {
        throw new Error("stale registry");
      });
    else if (kind === "unregistered") ctx.modelRegistry.find.mockReturnValue(undefined);
    else ctx.modelRegistry.find.mockReturnValue({ ...ctx.model, id: "wire-b", [kind]: "different" });
    service.noteRequest(c);
    expect(service.report().config).toMatchObject({
      maxPings: 11,
      maxPingsSource: "fallback",
      maxPingsReason: "wire-model-unmapped",
    });
    service.dispose();
  });

  it("uses only this real response's full input, pins prices, and ignores duplicate settle usage", () => {
    const { service, ctx } = harness();
    ctx.model.cost = {
      cacheRead: 0.3,
      cacheWrite: 3.75,
      tiers: [
        { inputTokensAbove: 40_000, cacheRead: 0.025, cacheWrite: 1.25 },
        { inputTokensAbove: 100_000, cacheRead: 1, cacheWrite: 3 },
      ],
    } as never;
    // No capture: a tiered model cannot promise a base-tier cap before the real response.
    expect(service.report().config).toMatchObject({
      maxPings: 11,
      maxPingsSource: "fallback",
      maxPingsReason: "tier-uncertain",
    });
    expect(renderKeepaliveReportLines(service.report())[1]).toContain("cap: 11/window (fallback: tier-uncertain)");
    service.noteRequest(capture({}, service.instanceId, 30_000));
    expect(service.report().config).toMatchObject({
      maxPings: 11,
      maxPingsSource: "fallback",
      maxPingsReason: "tier-uncertain",
    });
    ctx.modelRegistry.find.mockClear();
    // Even an in-place registry edit after capture must not change this window's prices.
    (ctx.model.cost as any).tiers[0].cacheWrite = 3;
    service.noteRequestSettled("s1", service.instanceId, true, { provider: "anthropic", modelId: "claude-x" }, 55_000);
    expect(service.report().config).toMatchObject({ maxPings: 48, maxPingsSource: "priced" });
    expect(ctx.modelRegistry.find).not.toHaveBeenCalled();
    service.noteRequestSettled("s1", service.instanceId, true, { provider: "anthropic", modelId: "claude-x" }, 180_000);
    expect(service.report().config.maxPings).toBe(48);
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId, true, { provider: "anthropic", modelId: "claude-x" }, 180_000);
    expect(service.report().config.maxPings).toBe(1);
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId, true, { provider: "wrong", modelId: "claude-x" }, 180_000);
    expect(service.report().config.maxPingsReason).toBe("tier-uncertain");
    service.dispose();
  });

  it("drift ends the old window, and a new capture recomputes for the new model", () => {
    const { service, ctx, clock } = harness();
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    ctx.model.id = "new-model";
    ctx.model.cost = { cacheRead: 0.025, cacheWrite: 1.25, tiers: [] };
    clock.advance(240_000);
    expect(service.report().window.capture).toBeUndefined();
    const c = capture({}, service.instanceId);
    c.fingerprint.ctxModelId = c.fingerprint.modelId = "new-model";
    service.noteRequest(c);
    expect(service.report().config).toMatchObject({ maxPings: 48, maxPingsSource: "priced" });
    service.dispose();
  });

  it("cap zero emits no network; terminal audit carries priced cap metadata", async () => {
    const fetchImpl = provenHitFetch();
    const { service, ctx, clock, appendEntry } = harness({ fetchImpl });
    ctx.model.cost = { cacheRead: 1, cacheWrite: 2, tiers: [] };
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(service.report().lastSkip).toBe("budget-exhausted");
    expect(appendEntry).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "terminal-skip", cap: 0, capSource: "priced" }),
    );
    service.dispose();
  });
});

describe("dynamic cap terminal audit metadata", () => {
  it("clamped cap 96 carries raw cap when gate #14 exhausts the window", async () => {
    const fetchImpl = provenHitFetch();
    const { service, ctx, clock, appendEntry } = harness({ fetchImpl });
    ctx.model.cost = { cacheRead: 1, cacheWrite: 2002, tiers: [] };
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    for (let i = 0; i < 97; i++) {
      clock.advance(240_000);
      await flush();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(96);
    expect(service.report().config).toMatchObject({ maxPings: 96, maxPingsSource: "clamped", maxPingsRaw: 2000 });
    expect(appendEntry).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "terminal-skip", cap: 96, capSource: "clamped", capRaw: 2000 }),
    );
    service.dispose();
  });
  it("unknown mapping fallback audit carries its reason at budget exhaustion", async () => {
    const { service, ctx, clock, appendEntry } = harness();
    ctx.modelRegistry.find = undefined as never;
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    for (let i = 0; i < 12; i++) {
      clock.advance(240_000);
      await flush();
    }
    expect(service.report().session.pings).toBe(11);
    expect(appendEntry).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        kind: "terminal-skip",
        cap: 11,
        capSource: "fallback",
        capReason: "wire-model-unmapped",
      }),
    );
    service.dispose();
  });
});

describe("r_FFWC8SBT — unknown no-capture tier and Copilot billing", () => {
  it("no-capture non-tiered models remain priced; tiered models are uncertain again after invalidation", () => {
    const { service, ctx } = harness();
    expect(service.report().config).toMatchObject({ maxPings: 11, maxPingsSource: "priced" });
    ctx.model.cost = {
      cacheRead: 0.3,
      cacheWrite: 3.75,
      tiers: [{ inputTokensAbove: 40_000, cacheRead: 0.025, cacheWrite: 1.25 }],
    } as never;
    expect(service.report().config).toMatchObject({
      maxPings: 11,
      maxPingsSource: "fallback",
      maxPingsReason: "tier-uncertain",
    });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId, true, { provider: "anthropic", modelId: "claude-x" }, 55_000);
    expect(service.report().config).toMatchObject({ maxPings: 48, maxPingsSource: "priced" });
    service.invalidate("model-select");
    expect(service.report().window.capture).toBeUndefined();
    expect(renderKeepaliveReportLines(service.report())[1]).toContain("cap: 11/window (fallback: tier-uncertain)");
    service.dispose();
  });
  it("token-billed Copilot sends an Anthropic ping with the ordinary registry-derived cap", async () => {
    const fetchImpl = provenHitFetch();
    const { service, ctx, clock } = harness({ fetchImpl });
    ctx.model.provider = "github-copilot";
    const c = capture({}, service.instanceId);
    c.fingerprint.provider = "github-copilot";
    service.noteRequest(c);
    service.noteRequestSettled("s1", service.instanceId);
    expect(service.report().config).toMatchObject({ maxPings: 11, maxPingsSource: "priced" });
    clock.advance(240_000);
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(service.report().session.pings).toBe(1);
    expect(service.report().lastSkip).not.toBe("not-anthropic");
    service.dispose();
  });
});
