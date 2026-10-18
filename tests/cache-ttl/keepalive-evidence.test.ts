/**
 * O2/O3 tests (provider-evidence optimizations, 2026-10-12):
 *   - O2: `stripCacheControlTtl` pure-function contract (ping ttl 剥离).
 *   - O3: the `no-cache-value` provider breaker — service tick gate, dispose-time session
 *     accounting, immediate reset on an observed cache read, and cross-instance persistence.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { type CacheKeepaliveDeps, type CacheKeepaliveService } from "../../src/service/cache-keepalive.js";
import { createCacheKeepaliveService } from "./fake-pipeline.js";
import type { CacheTtlSettings } from "../../src/config/settings.js";
import { preparePingPayload, stripCacheControlTtl } from "../../src/cache-ttl/ping-client.js";
import { buildFingerprint, inspectPayload, type CapturedRequest } from "../../src/cache-ttl/keepalive-state.js";
import {
  createProviderEvidenceStore,
  NO_CACHE_VALUE_STREAK_LIMIT,
  type ProviderEvidenceStore,
} from "../../src/cache-ttl/provider-evidence.js";

const encoder = new TextEncoder();

function messageStartChunk(usage: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number }): string {
  return `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10, ...usage } } })}\n\n`;
}

function fakeOkResponse(chunks: string[]): Response {
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        cancel: async () => {},
        read: async () => {
          if (i < chunks.length) {
            const value = encoder.encode(chunks[i]);
            i += 1;
            return { done: false, value };
          }
          return { done: true, value: undefined };
        },
      }),
    },
  } as unknown as Response;
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

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/** fetch double that records each request body (parsed) and answers a proven-hit. */
function capturingHitFetch(): { fetchImpl: typeof fetch; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return fakeOkResponse([messageStartChunk({ cache_read_input_tokens: 500, cache_creation_input_tokens: 0 })]);
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

/** A capture carrying a `ttl:"1h"` write intent (mode=on / pi-native 1h payload). */
function ttl1hCapture(instance: string): CapturedRequest {
  return capture(
    {
      payload: {
        model: "claude-x",
        max_tokens: 100,
        stream: true,
        messages: [
          { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } }] },
        ],
      },
      shape: { ephemeralBreakpoints: 1, ttl1h: true, hasThinking: false, maxTokens: 100 },
    },
    instance,
  );
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

/** Drive one full window → ping cycle. */
async function driveOnePing(service: CacheKeepaliveService, clock: FakeClock): Promise<void> {
  service.noteRequest(capture({}, service.instanceId));
  service.noteRequestSettled("s1", service.instanceId);
  clock.advance(240_000);
  await flush();
}

// ---------------------------------------------------------------------------
// O2: stripCacheControlTtl
// ---------------------------------------------------------------------------

describe("stripCacheControlTtl (O2)", () => {
  it("removes only `ttl` from ephemeral cache_control nodes, wherever they nest", () => {
    const payload = {
      model: "claude-x",
      system: [
        { type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "b" },
      ],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "c", cache_control: { type: "ephemeral", ttl: "1h" } }],
        },
      ],
    };
    const stripped = stripCacheControlTtl(payload);
    expect(stripped.system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(stripped.messages[0]!.content[0]!.cache_control).toEqual({ type: "ephemeral" });
    // untouched nodes keep identity (copy-on-write)
    expect(stripped.system[1]).toBe(payload.system[1]);
    expect(stripped.model).toBe("claude-x");
    // input never mutated
    expect(payload.system[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("keeps non-ephemeral cache_control and ttl-less breakpoints untouched (same reference)", () => {
    const payload = {
      messages: [
        { role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: [{ type: "text", text: "y", cache_control: { type: "other", ttl: "1h" } }] },
      ],
    };
    expect(stripCacheControlTtl(payload)).toBe(payload);
  });

  it("is fingerprint- and shape-neutral (ttl was never fingerprinted)", () => {
    const ctx = { sessionId: "s", provider: "p", api: "a", ctxModelId: "m", baseUrl: "u", authHeaderKeys: "" };
    const payload = {
      model: "m",
      stream: true,
      messages: [
        { role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "1h" } }] },
      ],
    };
    const prepared = preparePingPayload(payload);
    const stripped = stripCacheControlTtl(prepared);
    // breakpointPath / digests / counts identical; only shape.ttl1h flips.
    expect(buildFingerprint(stripped, ctx)).toEqual(buildFingerprint(payload, ctx));
    expect(inspectPayload(stripped)).toEqual({ ...inspectPayload(prepared), ttl1h: false });
  });

  it("survives cyclic input without throwing (defensive; captures are acyclic in practice)", () => {
    const node: Record<string, unknown> = { cache_control: { type: "ephemeral", ttl: "1h" } };
    node.self = node;
    const stripped = stripCacheControlTtl(node) as Record<string, unknown>;
    expect(stripped.cache_control).toEqual({ type: "ephemeral" });
    expect(stripped.self).toBe(node); // cycle left as-is, no recursion bomb
  });
});

// ---------------------------------------------------------------------------
// O3: no-cache-value breaker
// ---------------------------------------------------------------------------

describe("cache-keepalive service — O3 no-cache-value breaker", () => {
  let dir: string;
  let file: string;
  let store: ProviderEvidenceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-o3-"));
    file = join(dir, "evidence.json");
    store = createProviderEvidenceStore(file);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a tripped route is skipped at tick time, latched into session.disabled, and never fetches", async () => {
    for (let i = 0; i < NO_CACHE_VALUE_STREAK_LIMIT; i += 1) {
      store.noteZeroReadSession("anthropic", "claude-x", 1_000 + i);
    }
    expect(store.isNoCacheValue("anthropic", "claude-x", 2_000)).toBe(true);

    const fetchImpl = provenHitFetch();
    const { service, clock } = harness({ evidence: store, fetchImpl });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();

    const report = service.report();
    expect(report.session.disabled?.reason).toBe("no-cache-value");
    // the terminal-skip diagnostic keeps the precise reason even after later ticks overwrite
    // `lastSkip` with the generic "session-disabled" short-circuit (evaluateTick #2).
    expect(report.lastTerminalSkip?.reason).toBe("no-cache-value");
    expect(report.window.pings).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("dispose counts a keepalive-active, zero-read session into the ledger (once)", async () => {
    const { service, clock } = harness({ evidence: store, fetchImpl: noUsageFetch() });
    await driveOnePing(service, clock); // ping resolves as no-usage (cacheRead 0)
    expect(service.report().session.unprovenTotal).toBe(1);
    service.dispose();
    const route = store.readRoute("anthropic", "claude-x", 999_000);
    expect(route?.zeroReadSessions).toBe(1);
  });

  it("trips the breaker after NO_CACHE_VALUE_STREAK_LIMIT consecutive zero-read sessions", async () => {
    for (let i = 0; i < NO_CACHE_VALUE_STREAK_LIMIT; i += 1) {
      const { service, clock } = harness({ evidence: store, fetchImpl: noUsageFetch() });
      await driveOnePing(service, clock);
      service.dispose();
    }
    expect(store.isNoCacheValue("anthropic", "claude-x", 999_000_000)).toBe(true);
  });

  it("a proven-hit ping marks the session as having seen a read — dispose does NOT count it", async () => {
    const { service, clock } = harness({ evidence: store, fetchImpl: provenHitFetch() });
    await driveOnePing(service, clock);
    expect(service.report().session.pings).toBe(1);
    service.dispose();
    expect(store.readRoute("anthropic", "claude-x", 999_000)).toBeUndefined();
    // and the proven hit also reset any pre-existing streak on the route
  });

  it("noteUsageCacheRead (real request observed cacheRead>0) prevents the dispose-time count", async () => {
    const { service, clock } = harness({ evidence: store, fetchImpl: noUsageFetch() });
    await driveOnePing(service, clock);
    service.noteUsageCacheRead("s1", service.instanceId);
    service.dispose();
    expect(store.readRoute("anthropic", "claude-x", 999_000)).toBeUndefined();
  });

  it("noteUsageCacheRead lifts a session-local no-cache-value latch immediately", async () => {
    for (let i = 0; i < NO_CACHE_VALUE_STREAK_LIMIT; i += 1) {
      store.noteZeroReadSession("anthropic", "claude-x", 1_000 + i);
    }
    const { service, clock } = harness({ evidence: store });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();
    expect(service.report().session.disabled?.reason).toBe("no-cache-value");

    service.noteUsageCacheRead("s1", service.instanceId);
    expect(service.report().session.disabled).toBeUndefined();
  });

  it("mode=off sessions are exempt from the zero-read ledger (user ruling 2026-10-12)", async () => {
    const { service, clock } = harness({ evidence: store, fetchImpl: noUsageFetch() });
    service.syncModeState("off", false);
    await driveOnePing(service, clock);
    service.dispose();
    expect(store.readRoute("anthropic", "claude-x", 999_000)).toBeUndefined();
  });

  it("a session that never pinged (no keepalive activity) is not counted", async () => {
    const { service } = harness({ evidence: store });
    service.noteRequest(capture({}, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    service.dispose(); // no tick ever fired a ping
    expect(store.readRoute("anthropic", "claude-x", 999_000)).toBeUndefined();
  });

  it("noCacheValueCounted survives a readback restore — a rebuilt service never double-counts the session", async () => {
    const { service, clock, appendEntry } = harness({ evidence: store, fetchImpl: noUsageFetch() });
    await driveOnePing(service, clock);
    service.dispose();
    expect(store.readRoute("anthropic", "claude-x", 999_000)?.zeroReadSessions).toBe(1);

    // Simulate /reload: rebuild the session totals from the persisted audit snapshot.
    const { readBackKeepaliveSessionState } = await import("../../src/cache-ttl/keepalive-state.js");
    const entries = appendEntry.mock.calls.map(([, data]) => ({
      type: "custom",
      customType: "subagent:cache-keepalive",
      data,
    }));
    const restored = readBackKeepaliveSessionState(entries);
    expect(restored?.noCacheValueCounted).toBe(true);

    const { service: service2 } = harness({ evidence: store, fetchImpl: noUsageFetch(), restoredState: restored });
    await driveOnePing(service2, clock);
    service2.dispose();
    expect(store.readRoute("anthropic", "claude-x", 999_000)?.zeroReadSessions).toBe(1); // NOT 2
  });

  it("without deps.evidence nothing changes (byte-identical legacy behaviour)", async () => {
    const { service, clock } = harness({ fetchImpl: noUsageFetch() });
    await driveOnePing(service, clock);
    service.dispose(); // must not throw, no store to write to
    expect(service.report().session.unprovenTotal).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// O2 follow-up: gate #7 分流 — ttl1h captures ping as stripped 5m on no-evidence routes
// ---------------------------------------------------------------------------

describe("cache-keepalive service — gate #7 分流 (ttl-1h ⇒ stripped 5m ping)", () => {
  let dir: string;
  let store: ProviderEvidenceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-g7-"));
    store = createProviderEvidenceStore(join(dir, "evidence.json"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("no 1h evidence ⇒ ttl1h window pings, replay stripped of ttl, 5m rhythm/budget unchanged", async () => {
    const { fetchImpl, bodies } = capturingHitFetch();
    const { service, clock } = harness({ evidence: store, fetchImpl });
    service.noteRequest(ttl1hCapture(service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);

    // Not due yet — an evidence-less ttl1h window waits exactly like a 5m window.
    clock.advance(200_000);
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();

    clock.advance(45_000); // crosses the 240s interval, still inside the 5m alive margin
    await flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // The wire payload's cache_control lost its ttl field (and nothing else changed:
    // preparePingPayload's max_tokens:1 is the pre-existing, only other permitted mutation).
    const content = (bodies[0]!.messages as never[])[0] as {
      content: [{ text: string; cache_control?: Record<string, unknown> }];
    };
    expect(content.content[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(bodies[0]!.max_tokens).toBe(1);
    expect(bodies[0]!.stream).toBe(true);

    // 5m bookkeeping applied unchanged: proven hit, nextPingAt/aliveUntil on the 5m cadence.
    const report = service.report();
    expect(report.session.pings).toBe(1);
    expect(report.window.pings).toBe(1);
    expect(report.window.aliveUntil).toBe(240_000 + 300_000);
    expect(report.window.nextPingAt).toBe(240_000 + 240_000);
    // distinguishable in diagnostics as a stripped ping (audit marker covered by the
    // fingerprint test below)
    expect(report.lastPingDiagnostics?.ttlStripped).toBe(true);
  });

  it("proven 1h evidence ⇒ legacy ttl-1h terminal skip, no ping, capture untouched", async () => {
    store.noteWrite1hLanded("anthropic", "claude-x", 0);
    const { fetchImpl } = capturingHitFetch();
    const { service, clock } = harness({ evidence: store, fetchImpl });
    service.noteRequest(ttl1hCapture(service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(300_000);
    await flush();

    const report = service.report();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.window.pings).toBe(0);
    expect(report.lastTerminalSkip?.reason).toBe("ttl-1h");
    expect(report.session.disabled).toBeUndefined();
  });

  it("evidence store read failure (corrupt file) ⇒ treated as no evidence ⇒ stripped 5m ping (I6)", async () => {
    const { writeFileSync } = await import("node:fs");
    const corruptPath = join(dir, "corrupt.json");
    writeFileSync(corruptPath, "{not json", "utf8");
    const corruptStore = createProviderEvidenceStore(corruptPath);

    const { fetchImpl, bodies } = capturingHitFetch();
    const { service, clock } = harness({ evidence: corruptStore, fetchImpl });
    service.noteRequest(ttl1hCapture(service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const content = (bodies[0]!.messages as never[])[0] as { content: [{ cache_control?: unknown }] };
    expect(content.content[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(service.report().session.pings).toBe(1);
  });

  it("a stripped ping's fingerprint did not drift (the strip never triggers invalidate)", async () => {
    const { fetchImpl } = capturingHitFetch();
    const { service, clock, appendEntry } = harness({ evidence: store, fetchImpl });
    service.noteRequest(ttl1hCapture(service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();
    expect(service.report().session.pings).toBe(1);
    // no invalidate/fingerprint-drift audit entries on the whole path
    const kinds = appendEntry.mock.calls.map(([, data]) => (data as { kind?: string }).kind);
    expect(kinds).not.toContain("invalidate");
    // and the proven-hit audit carries the stripped marker
    const hit = appendEntry.mock.calls.find(([, data]) => (data as { kind?: string }).kind === "proven-hit");
    expect((hit![1] as { ttlStripped?: boolean }).ttlStripped).toBe(true);
  });

  it("no evidence store wired at all ⇒ legacy skip (byte-identical)", async () => {
    const { fetchImpl } = capturingHitFetch();
    const { service, clock } = harness({ fetchImpl });
    service.noteRequest(ttl1hCapture(service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(300_000);
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(service.report().lastTerminalSkip?.reason).toBe("ttl-1h");
  });
});
