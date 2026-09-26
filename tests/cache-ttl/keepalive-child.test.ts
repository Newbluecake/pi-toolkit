/**
 * child-ka-core (docs/dev/child-context-switch/plan.md §2.4/§7 P1) — service-level
 * (`src/service/cache-keepalive.ts`) tests for the parts that need a real ledger,
 * real retry/backoff timing, or real cost accounting: T-K3b (lease/retry/timeout
 * interleaving across two service instances sharing one ledger), T-K4 (audit cost
 * fields, gated by `reportCost`), T-K9 (worst-case budget behavior).
 *
 * Deliberately does NOT re-derive `ping-ledger.ts`'s own budget/concurrency math
 * (covered exhaustively in `tests/cache-ttl/ping-ledger.test.ts`) — these tests
 * prove the WIRING (`childPingGate` → ledger → `report().lastSkip` / audit
 * entries) is correct, using the smallest scenario that exercises each path.
 *
 * Style mirrors `tests/cache-ttl/keepalive-lifecycle.test.ts` /
 * `keepalive-ping-retry.test.ts` (same fetch-stub helpers, same `flush()`
 * convention for draining microtasks under `FakeClock`).
 */
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createCacheKeepaliveService, type CacheKeepaliveDeps } from "../../src/service/cache-keepalive.js";
import { createChildKeepaliveLedger, type ChildKeepaliveLedger } from "../../src/cache-ttl/ping-ledger.js";
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

function provenHitFetch(cacheReadTokens = 500): typeof fetch {
  return vi.fn(async () =>
    fakeOkResponse([messageStartChunk({ cache_read_input_tokens: cacheReadTokens, cache_creation_input_tokens: 0 })]),
  ) as unknown as typeof fetch;
}
function provenWriteFetch(cacheWriteTokens = 300_000): typeof fetch {
  return vi.fn(async () =>
    fakeOkResponse([messageStartChunk({ cache_read_input_tokens: 0, cache_creation_input_tokens: cacheWriteTokens })]),
  ) as unknown as typeof fetch;
}
/** fetch that hangs until manually resolved via the returned `resolve()`/`reject()`. */
function hangingFetch(): { fetchImpl: typeof fetch; resolve: (chunks: string[]) => void; reject: (e: Error) => void } {
  let resolver: ((res: Response) => void) | undefined;
  let rejecter: ((e: unknown) => void) | undefined;
  const fetchImpl = vi.fn(
    () =>
      new Promise<Response>((res, rej) => {
        resolver = res;
        rejecter = rej;
      }),
  ) as unknown as typeof fetch;
  return {
    fetchImpl,
    resolve: (chunks: string[]) => resolver?.(fakeOkResponse(chunks)),
    reject: (e: Error) => rejecter?.(e),
  };
}
/** fetch that always rejects with a bare network error (never reaches the server — `isNeverProcessedOutcome`). */
function networkFailFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
}
/** 200 response whose `usage` is missing entirely — classified `no-usage` (a server-processed request, NOT `isNeverProcessedOutcome`). */
function noUsageFetch(): typeof fetch {
  return vi.fn(async () =>
    fakeOkResponse([`data: ${JSON.stringify({ type: "message_start", message: {} })}\n\n`]),
  ) as unknown as typeof fetch;
}
/** Non-retryable HTTP error (e.g. 400) — final on the first attempt, and NOT `isNeverProcessedOutcome`. */
function httpErrorFetch(status: number): typeof fetch {
  return vi.fn(
    async () => ({ ok: false, status, text: async () => "" }) as unknown as Response,
  ) as unknown as typeof fetch;
}

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const BASE_SETTINGS: CacheTtlSettings = {
  mode: "auto",
  keepalive: true,
  keepaliveIntervalMs: 240_000,
  keepaliveMaxPings: 11,
  keepaliveMinPrefixTokens: 20_000,
  keepaliveUpgradeAfterBudget: true,
  adaptiveEnabled: false,
  adaptiveWriteBudgetTokens: 0,
  adaptiveWriteBudgetUsd: 0,
  adaptiveFeeBudgetTokens: 0,
  adaptiveFeeBudgetUsd: 0,
  adaptiveMaxDeltaTokens: 0,
  adaptiveRefreshAfterTokens: 0,
  adaptiveColdUpgrades: 0,
  adaptiveColdCooldownMs: 60_000,
  adaptiveColdMinHorizonMs: 0,
  adaptiveHistoryGapSignal: false,
  childKeepalive: true,
  childKeepaliveMaxPingsPerRun: 24,
  childKeepaliveMaxConcurrent: 4,
  childKeepaliveRunBudgetUsd: 1.5,
  childKeepaliveProcessBudgetUsd: 10,
};

/** $0.50/M read (mirrors plan.md §2.4's real-world `claude-opus-5` figure). */
const OPUS5_COST = { cacheRead: 0.5, cacheWrite: 6.25 };
/** $2/M read above a large tier threshold (mirrors plan.md §2.4's `gpt-6-astra` figure) — flat here for simplicity, no tiers needed at 1M tokens. */
const ASTRA_COST = { cacheRead: 2, cacheWrite: 25 };

function fakeCtx(overrides: Record<string, unknown> = {}) {
  return {
    ui: { setStatus: vi.fn() },
    mode: "print", // child (subagent) sessions run headless
    model: {
      provider: "anthropic",
      api: "anthropic-messages",
      id: "claude-child",
      baseUrl: "https://api.anthropic.com",
      headers: {},
      cost: OPUS5_COST,
    },
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "sk-ant-api-x", headers: {} }),
    },
    sessionManager: { getSessionId: () => "s1" },
    ...overrides,
  };
}

function capture(overrides: Partial<CapturedRequest> = {}, instance: string, tokens = 270_000): CapturedRequest {
  const sessionId = typeof overrides.sessionId === "string" ? overrides.sessionId : "s1";
  return {
    sessionId,
    instance,
    payload: { model: "claude-child", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true },
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    fingerprint: {
      sessionId,
      provider: "anthropic",
      api: "anthropic-messages",
      modelId: "claude-child",
      ctxModelId: "claude-child",
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

interface Harness {
  clock: FakeClock;
  ctx: ReturnType<typeof fakeCtx>;
  service: ReturnType<typeof createCacheKeepaliveService>;
  appendEntry: ReturnType<typeof vi.fn>;
}

function harness(
  clock: FakeClock,
  sessionId: string,
  overrides: Partial<CacheKeepaliveDeps> = {},
  ctxOverrides: Record<string, unknown> = {},
): Harness {
  const ctx = fakeCtx({ sessionManager: { getSessionId: () => sessionId }, ...ctxOverrides });
  let self: ReturnType<typeof createCacheKeepaliveService> | undefined;
  const appendEntry = vi.fn();
  const service = createCacheKeepaliveService({
    clock,
    ctx: ctx as never,
    sessionId,
    settings: { ...BASE_SETTINGS },
    backgroundBusy: () => false, // child armed only via activeTools (§1.5)
    isCurrent: (s) => self === s,
    fetchImpl: provenHitFetch(),
    appendEntry,
    allowHeadless: true,
    reportCost: true,
    statusBar: false,
    authTimeoutMs: 30_000,
    ...overrides,
  });
  self = service;
  return { clock, ctx, service, appendEntry };
}

function arm(h: Harness, tokens = 270_000): void {
  const sid = getSid(h);
  h.service.noteToolStart(sid, h.service.instanceId);
  h.service.noteRequest(capture({ sessionId: sid }, h.service.instanceId, tokens));
  h.service.noteRequestSettled(sid, h.service.instanceId);
}
function getSid(h: Harness): string {
  return (h.ctx.sessionManager as { getSessionId: () => string }).getSessionId();
}

// ---------------------------------------------------------------------------
// T-K3b — lease/retry/timeout interleaving (maxConcurrent=1, two instances)
// ---------------------------------------------------------------------------

describe("child keepalive — T-K3b: lease held across retries denies a concurrent instance", () => {
  it("A holds the slot through 3 network-failure attempts (2s/5s backoff); B is global-cap throughout; B succeeds once A settles", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    // A short interval (still within the production-clamped [60s,280s] range) gives
    // B's post-denial retry (15s later) enough TTL headroom before the 45s safety
    // margin's cutoff — with the plan's own 240s default, a global-cap retry has
    // NO slack at all (nextPingAt=240s, cutoff=255s, first retry is due AT 255s).
    const settings = { ...BASE_SETTINGS, keepaliveIntervalMs: 60_000 };
    const common = { pingLedger: ledger, maxConcurrentPings: 1, runBudgetUsd: 100, processBudgetUsd: 100, settings };

    const a = harness(clock, "sA", { ...common, fetchImpl: networkFailFetch() });
    const b = harness(clock, "sB", { ...common, fetchImpl: provenHitFetch() });

    arm(a); // registers A's round-1 tick timer first (lower id ⇒ fires first at every shared due time)
    arm(b);

    clock.advance(60_000); // both reach the "ping" decision at the same due time; A's fires first
    await flush();

    // A has acquired the one slot; B is denied global-cap and re-armed for a retry.
    expect(ledger.activeCount()).toBe(1);
    expect(b.service.report().lastSkip).toBe("global-cap");
    expect((b.ctx.model as { promptCache?: unknown }).promptCache).toBeUndefined();

    clock.advance(2_000); // A's first backoff (network -> retry)
    await flush();
    expect(ledger.activeCount()).toBe(1); // A still holds it mid-retry
    expect(b.service.report().lastSkip).toBe("global-cap");

    clock.advance(5_000); // A's second backoff -> attempt 3 (final, PING_MAX_ATTEMPTS=3)
    await flush();

    // A's sequence is now finished (3 network failures, all "never processed" ⇒ charge 0)
    // and its lease was released in `runPing`'s `finally`.
    expect(ledger.activeCount()).toBe(0);
    expect(a.service.report().session.unprovenTotal).toBe(1);
    expect(a.service.report().session.disabled).toBeUndefined(); // below both breaker thresholds

    // B's own next re-arm (15s after the global-cap denial) now finds the slot free.
    clock.advance(15_000);
    await flush();
    expect(b.service.report().session.pings).toBe(1); // B's proven-hit succeeded
    expect(ledger.activeCount()).toBe(0); // B's own lease settled synchronously with its proven-hit
  });

  it("disposing A mid-backoff releases its lease immediately; A's late (aborted) fetch result never double-releases", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    const { fetchImpl, reject } = hangingFetch();
    const a = harness(clock, "sA", {
      pingLedger: ledger,
      maxConcurrentPings: 1,
      runBudgetUsd: 100,
      processBudgetUsd: 100,
      fetchImpl,
    });
    arm(a);
    clock.advance(240_000);
    await flush();
    expect(ledger.activeCount()).toBe(1); // A holds the slot, first attempt in flight

    a.service.dispose();
    expect(ledger.activeCount()).toBe(0); // released synchronously by dispose()'s defensive backstop

    // The in-flight fetch finally settles (as an abort-shaped rejection) after dispose.
    reject(new Error("aborted"));
    await flush();
    expect(ledger.activeCount()).toBe(0); // still 0 — no double release, no negative/garbage state

    // A fresh acquire from a totally different holder proves the slot is genuinely free.
    const acquired = ledger.tryAcquire({
      holderId: "other",
      estimateUsd: 0,
      maxConcurrent: 1,
      processBudgetUsd: 100,
      now: clock.now(),
    });
    expect(acquired.ok).toBe(true);
  });

  it("auth hang: authTimeoutMs (30s) refunds the budget and releases the lease — the request never left", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    const a = harness(
      clock,
      "sA",
      { pingLedger: ledger, maxConcurrentPings: 1, runBudgetUsd: 100, processBudgetUsd: 100 },
      { modelRegistry: { getApiKeyAndHeaders: () => new Promise<never>(() => {}) } }, // never resolves
    );
    arm(a);
    clock.advance(240_000);
    await flush();
    expect(ledger.activeCount()).toBe(1); // slot held, waiting on auth
    expect(a.service.report().window.pings).toBe(1); // budget spent up front (onPingStarted)

    clock.advance(30_000); // authTimeoutMs fires
    await flush();

    expect(ledger.activeCount()).toBe(0); // released
    expect(a.service.report().window.pings).toBe(0); // refunded — never counted as unproven
    expect(a.service.report().session.unprovenTotal).toBe(0);
  });

  it("a lease held past CHILD_PING_LEASE_MS without settling is reclaimed by the next tryAcquire (any holder)", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    // Simulate a holder that acquired but crashed before its `finally` ran — never calls settle().
    const leaked = ledger.tryAcquire({
      holderId: "leaked",
      estimateUsd: 1,
      maxConcurrent: 1,
      processBudgetUsd: 100,
      now: 0,
    });
    expect(leaked.ok).toBe(true);

    const a = harness(clock, "sA", {
      pingLedger: ledger,
      maxConcurrentPings: 1,
      runBudgetUsd: 100,
      processBudgetUsd: 100,
    });
    arm(a);
    clock.advance(240_000); // well past CHILD_PING_LEASE_MS (150s) from the leaked lease's acquire time
    await flush();

    expect(a.service.report().session.pings).toBe(1); // A's own ping succeeded — the leaked lease was reclaimed
  });

  it("property: activeCount() never exceeds maxConcurrent across the whole A/B interleaving above", async () => {
    const clock = new FakeClock(0);
    const ledger: ChildKeepaliveLedger = createChildKeepaliveLedger();
    const common = { pingLedger: ledger, maxConcurrentPings: 1, runBudgetUsd: 100, processBudgetUsd: 100 };
    const a = harness(clock, "sA", { ...common, fetchImpl: networkFailFetch() });
    const b = harness(clock, "sB", { ...common, fetchImpl: provenHitFetch() });
    arm(a);
    arm(b);
    const checkpoints = [240_000, 2_000, 5_000, 15_000, 240_000, 15_000];
    for (const step of checkpoints) {
      clock.advance(step);
      await flush();
      expect(ledger.activeCount()).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// T-K4 — audit cost fields, gated by `reportCost`; main-session parity
// ---------------------------------------------------------------------------

describe("child keepalive — T-K4: audit cost fields", () => {
  function findAudit(appendEntry: ReturnType<typeof vi.fn>, kind: string): Record<string, unknown> | undefined {
    const call = appendEntry.mock.calls.find(([, data]: [string, Record<string, unknown>]) => data.kind === kind);
    return call?.[1] as Record<string, unknown> | undefined;
  }

  it("reportCost: true ⇒ proven-hit audit carries costUsd + budgetChargeUsd/runSpentUsd/processSpentUsd24h", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    const a = harness(clock, "s1", {
      pingLedger: ledger,
      maxConcurrentPings: 4,
      runBudgetUsd: 100,
      processBudgetUsd: 100,
    });
    arm(a);
    clock.advance(240_000);
    await flush();

    const entry = findAudit(a.appendEntry, "proven-hit");
    expect(entry).toBeDefined();
    expect(entry?.costUsd).toBeCloseTo((OPUS5_COST.cacheRead / 1_000_000) * 500, 6); // 500 = provenHitFetch's cacheReadTokens
    expect(entry?.budgetChargeUsd).toBeCloseTo((OPUS5_COST.cacheRead / 1_000_000) * 500, 6);
    expect(entry?.runSpentUsd).toBe(entry?.budgetChargeUsd);
    expect(entry?.processSpentUsd24h).toBe(entry?.budgetChargeUsd);
  });

  it("reportCost absent ⇒ no cost fields anywhere, and the entry is byte-identical to the main-session shape", async () => {
    const clock = new FakeClock(0);
    const a = harness(clock, "s1", { reportCost: undefined }); // no pingLedger either — plain main-session-shaped deps
    arm(a);
    clock.advance(240_000);
    await flush();

    const entry = findAudit(a.appendEntry, "proven-hit");
    expect(entry).toBeDefined();
    expect(Object.keys(entry!).sort()).toEqual(
      [
        "kind",
        "at",
        "windowEpoch",
        "sessionPings",
        "elapsedSinceCaptureMs",
        "prefixTokens",
        "prefixSource",
        "headerSource",
        "headerKeyDiff",
        "model",
        "baseUrl",
        "cacheReadTokens",
        "cacheReadInputTokens",
        "cacheCreationInputTokens",
        "attempts",
      ].sort(),
    );
    expect(entry).not.toHaveProperty("costUsd");
    expect(entry).not.toHaveProperty("budgetChargeUsd");
  });

  it("a proven-write outcome is priced with cacheWriteCostUsd (not the read rate)", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    const a = harness(clock, "s1", {
      pingLedger: ledger,
      maxConcurrentPings: 4,
      runBudgetUsd: 100,
      processBudgetUsd: 100,
      fetchImpl: provenWriteFetch(300_000),
    });
    arm(a);
    clock.advance(240_000);
    await flush();

    const entry = findAudit(a.appendEntry, "unproven");
    expect(entry).toBeDefined();
    expect(entry?.unprovenKind).toBe("proven-write");
    expect(entry?.costUsd).toBeCloseTo((OPUS5_COST.cacheWrite / 1_000_000) * 300_000, 6);
    expect(entry?.budgetChargeUsd).toBeCloseTo((OPUS5_COST.cacheWrite / 1_000_000) * 300_000, 6);
  });

  it("a never-processed outcome (network) charges 0 even with reportCost on", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    const a = harness(clock, "s1", {
      pingLedger: ledger,
      maxConcurrentPings: 4,
      runBudgetUsd: 100,
      processBudgetUsd: 100,
      fetchImpl: networkFailFetch(),
    });
    arm(a);
    clock.advance(240_000);
    await flush();
    clock.advance(2_000);
    await flush();
    clock.advance(5_000);
    await flush();

    const entry = findAudit(a.appendEntry, "unproven");
    expect(entry?.budgetChargeUsd).toBe(0);
    expect(entry?.runSpentUsd).toBe(0);
  });

  it("a `no-usage` outcome (200 but usage missing) is NOT `isNeverProcessedOutcome` \u2014 charged the conservative upper bound (write rate \u00d7 prefix), not 0", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    const a = harness(clock, "s1", {
      pingLedger: ledger,
      maxConcurrentPings: 4,
      runBudgetUsd: 100,
      processBudgetUsd: 100,
      fetchImpl: noUsageFetch(),
    });
    arm(a, 270_000);
    clock.advance(240_000);
    await flush();

    const entry = findAudit(a.appendEntry, "unproven");
    expect(entry).toBeDefined();
    expect(entry?.unprovenKind).toBe("no-usage");
    const expected = (OPUS5_COST.cacheWrite / 1_000_000) * 270_000;
    expect(entry?.budgetChargeUsd).toBeCloseTo(expected, 6);
    expect(entry?.runSpentUsd).toBeCloseTo(expected, 6);
    expect(entry?.budgetChargeUsd).not.toBe(0);
  });

  it("a non-retryable HTTP status (400) is NOT `isNeverProcessedOutcome` \u2014 charged the conservative upper bound, not 0", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    const a = harness(clock, "s1", {
      pingLedger: ledger,
      maxConcurrentPings: 4,
      runBudgetUsd: 100,
      processBudgetUsd: 100,
      fetchImpl: httpErrorFetch(400),
    });
    arm(a, 270_000);
    clock.advance(240_000);
    await flush();

    const entry = findAudit(a.appendEntry, "unproven");
    expect(entry).toBeDefined();
    expect(entry?.unprovenKind).toBe("http");
    const expected = (OPUS5_COST.cacheWrite / 1_000_000) * 270_000;
    expect(entry?.budgetChargeUsd).toBeCloseTo(expected, 6);
    expect(entry?.budgetChargeUsd).not.toBe(0);
  });

  it("a retryable HTTP status (429), final after exhausting retries, still charges 0", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    const a = harness(clock, "s1", {
      pingLedger: ledger,
      maxConcurrentPings: 4,
      runBudgetUsd: 100,
      processBudgetUsd: 100,
      fetchImpl: httpErrorFetch(429),
    });
    arm(a, 270_000);
    clock.advance(240_000);
    await flush();
    clock.advance(2_000);
    await flush();
    clock.advance(5_000);
    await flush();

    const entry = findAudit(a.appendEntry, "unproven");
    expect(entry).toBeDefined();
    expect(entry?.unprovenKind).toBe("http");
    expect(entry?.budgetChargeUsd).toBe(0);
  });

  it("budget-stop audit entry carries reason, estimateUsd, and both cumulative fields", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    const a = harness(clock, "s1", {
      pingLedger: ledger,
      maxConcurrentPings: 4,
      runBudgetUsd: 0.01, // far below one ping's estimate ⇒ immediate usd-run
      processBudgetUsd: 100,
    });
    arm(a);
    clock.advance(240_000);
    await flush();

    const entry = findAudit(a.appendEntry, "budget-stop");
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe("usd-run");
    expect(typeof entry?.estimateUsd).toBe("number");
    expect(entry?.runSpentUsd).toBe(0);
    expect(entry?.processSpentUsd24h).toBe(0);
    expect(a.service.report().session.pings).toBe(0); // no ping was ever actually sent
  });
});

// ---------------------------------------------------------------------------
// T-K9 — worst-case budget behavior
// ---------------------------------------------------------------------------

describe("child keepalive — T-K9: worst-case budget behavior", () => {
  it("astra-priced model ($2/M) + 1M-token prefix ⇒ the FIRST estimate already exceeds the run budget: zero pings, zero fetch calls", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    const fetchImpl = provenHitFetch();
    const a = harness(
      clock,
      "s1",
      { pingLedger: ledger, maxConcurrentPings: 4, runBudgetUsd: 1.5, processBudgetUsd: 100, fetchImpl },
      {
        model: {
          provider: "anthropic",
          api: "anthropic-messages",
          id: "claude-child",
          baseUrl: "https://api.anthropic.com",
          cost: ASTRA_COST,
        },
      },
    );
    arm(a, 1_000_000);
    clock.advance(240_000);
    await flush();

    expect(a.service.report().lastSkip).toBe("usd-run");
    expect(a.service.report().session.pings).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("opus-5-priced model ($0.5/M) + 270k prefix ⇒ ~11 successful pings then usd-run, cumulative charge ≤ $1.50", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    // Actual charge is priced off the OUTCOME's real cache-read tokens, not the
    // pre-check estimate (which is priced off the prefix) — report a read that
    // matches the prefix so "estimate ≈ actual charge" and the ~11-ping arithmetic
    // in plan.md §2.4 holds exactly.
    const fetchImpl = provenHitFetch(270_000);
    const a = harness(clock, "s1", {
      pingLedger: ledger,
      maxConcurrentPings: 4,
      runBudgetUsd: 1.5,
      processBudgetUsd: 100,
      fetchImpl,
      // Raise the WINDOW cap so it never interferes — this test is only about the $ run budget.
      settings: { ...BASE_SETTINGS, keepaliveMaxPings: 1_000 },
    });
    arm(a);

    let pingsBeforeStop = 0;
    for (let i = 0; i < 20; i += 1) {
      clock.advance(240_000);
      await flush();
      const report = a.service.report();
      if (report.lastSkip === "usd-run") break;
      pingsBeforeStop = report.session.pings;
    }

    expect(pingsBeforeStop).toBe(11);
    expect(a.service.report().lastSkip).toBe("usd-run");
    const perPingUsd = (OPUS5_COST.cacheRead / 1_000_000) * 270_000;
    expect(perPingUsd * pingsBeforeStop).toBeLessThanOrEqual(1.5);
    expect(a.service.report().session.pings).toBe(11); // stopped, not stuck retrying forever
  });

  it("two concurrent sub-instances sharing a tiny process budget: the second is denied usd-process once the first exhausts it", async () => {
    // Simplified from the plan's illustrative "4 concurrent instances" — the ledger's own
    // budget/concurrency arithmetic is exhaustively covered in ping-ledger.test.ts; this
    // proves the SERVICE correctly surfaces a shared-ledger denial as `lastSkip`.
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    // Prefix must clear `keepaliveMinPrefixTokens` (20k, gate #8) — use exactly that
    // floor for both the prefix AND the fetch's reported cache-read tokens, so the
    // pre-check estimate equals the actual charge and the arithmetic below is exact.
    const tokens = 20_000;
    const perPingUsd = (OPUS5_COST.cacheRead / 1_000_000) * tokens;
    const common = {
      pingLedger: ledger,
      maxConcurrentPings: 4,
      runBudgetUsd: 100,
      processBudgetUsd: perPingUsd * 1.5,
      fetchImpl: provenHitFetch(tokens),
    };
    const a = harness(clock, "sA", common);
    const b = harness(clock, "sB", common);
    arm(a, tokens);
    arm(b, tokens);
    clock.advance(240_000);
    await flush();

    const results = [a.service.report(), b.service.report()];
    const succeeded = results.filter((r) => r.session.pings === 1);
    const stopped = results.filter((r) => r.lastSkip === "usd-process");
    expect(succeeded.length).toBe(1);
    expect(stopped.length).toBe(1);
    expect(ledger.spent24h(clock.now())).toBeLessThanOrEqual(perPingUsd * 1.5);
  });

  it("four concurrent sub-instances share BOTH the ledger's 4-slot concurrency cap and one process budget (plan.md \u00a72.4's literal worked example), stopping usd-process once it's exhausted", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    // Prefix at exactly the min-prefix floor (gate #8) — estimate == actual charge
    // (proven-hit) so the arithmetic below is exact, not just an upper bound.
    const tokens = 20_000;
    const perPingUsd = (OPUS5_COST.cacheRead / 1_000_000) * tokens; // 0.01
    const processBudgetUsd = perPingUsd * 8; // exactly two full rounds of all 4 instances
    const common = {
      pingLedger: ledger,
      maxConcurrentPings: 4, // plan default — all 4 instances fit in the shared slot cap at once
      runBudgetUsd: 100, // large enough that only the PROCESS budget is ever the limiting factor
      processBudgetUsd,
      fetchImpl: provenHitFetch(tokens),
      settings: { ...BASE_SETTINGS, keepaliveMaxPings: 1_000 }, // window cap out of the way — this test is only about the process ledger
    };
    const instances = ["sA", "sB", "sC", "sD"].map((sid) => harness(clock, sid, common));
    for (const h of instances) arm(h, tokens);

    // Round 1: all FOUR are admitted in the same tick (proves the slot cap really is 4, not
    // serialized down to 1) and settle before the next tick — activeCount() drains back to 0.
    clock.advance(240_000);
    await flush();
    expect(ledger.activeCount()).toBe(0);
    for (const h of instances) expect(h.service.report().session.pings).toBe(1);
    expect(ledger.spent24h(clock.now())).toBeCloseTo(perPingUsd * 4, 6);

    // Round 2: cumulative reserved-during-admission stays within budget for all 4 (the ledger's
    // check is `<=`, so the exact boundary still admits) — the shared budget covers both rounds.
    clock.advance(240_000);
    await flush();
    for (const h of instances) expect(h.service.report().session.pings).toBe(2);
    expect(ledger.spent24h(clock.now())).toBeCloseTo(processBudgetUsd, 6);

    // Round 3: the shared budget is now exhausted — every one of the 4 is denied `usd-process`,
    // none pings again, and the ledger's actual spend never exceeds the budget (proven-hit ⇒
    // estimate == actual charge, so there is no write/read-price overshoot to account for here).
    clock.advance(240_000);
    await flush();
    for (const h of instances) {
      expect(h.service.report().session.pings).toBe(2);
      expect(h.service.report().lastSkip).toBe("usd-process");
    }
    expect(ledger.spent24h(clock.now())).toBeLessThanOrEqual(processBudgetUsd);
  });

  it("resume continuity (seed denies the first attempt outright with a larger prefix)", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    const fetchImpl = provenHitFetch();
    const a = harness(clock, "s1", {
      pingLedger: ledger,
      maxConcurrentPings: 4,
      runBudgetUsd: 1.5,
      processBudgetUsd: 100,
      runSpentSeedUsd: 1.4,
      fetchImpl,
    });
    arm(a, 270_000); // estimate ≈ 0.135 ⇒ 1.4 + 0.135 = 1.535 > 1.5
    clock.advance(240_000);
    await flush();

    expect(a.service.report().lastSkip).toBe("usd-run");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a model with no cost data at all ⇒ usd-unpriced, zero fetch calls", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    const fetchImpl = provenHitFetch();
    const a = harness(
      clock,
      "s1",
      { pingLedger: ledger, maxConcurrentPings: 4, runBudgetUsd: 1.5, processBudgetUsd: 100, fetchImpl },
      {
        model: {
          provider: "anthropic",
          api: "anthropic-messages",
          id: "claude-child",
          baseUrl: "https://api.anthropic.com",
        },
      },
    );
    arm(a);
    clock.advance(240_000);
    await flush();

    expect(a.service.report().lastSkip).toBe("usd-unpriced");
    expect(a.service.report().session.pings).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
