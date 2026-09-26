import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wireChildKeepalive } from "../../src/cache-ttl/child.js";
import { getChildKeepaliveDisposeRegistry } from "../../src/cache-ttl/child-registry.js";
import { getChildKeepaliveLedger } from "../../src/cache-ttl/ping-ledger.js";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";

/**
 * child-context-switch plan.md §7 P3 — T-K6/T-K7/T-K8 (integration): `wireChildKeepalive`
 * against a real (fake-timer-driven) ping, mirroring tests/integration/cache-keepalive.test.ts's
 * harness but for the CHILD wiring (no Stack — capture-only, never rewrites the payload).
 */

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
function provenHitFetch() {
  return vi.fn(async () =>
    fakeOkResponse([messageStartChunk({ cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 })]),
  );
}

async function flush(times = 15): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function fakePi() {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const appended: { customType: string; data: unknown }[] = [];
  const pi = {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage: () => undefined,
    appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  };
  const emit = async (event: string, payload: unknown = {}, ctx: unknown = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  return { pi: pi as unknown as ExtensionAPI, emit, handlers, appended };
}

function fakeCtx(sessionId: string, overrides: Record<string, unknown> = {}): ExtensionContext {
  return {
    cwd: process.cwd(),
    mode: "print",
    hasUI: false,
    sessionManager: {
      getEntries: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: { cacheRead: 30_000, cacheWrite: 0, input: 5, output: 5, cost: { total: 0 } },
          },
        },
      ],
      getSessionId: () => sessionId,
      getBranch: () => [],
    },
    modelRegistry: {
      getAvailable: () => [],
      find: () => undefined,
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "sk-ant-api-x", headers: {} }),
    },
    model: {
      provider: "anthropic",
      api: "anthropic-messages",
      id: "claude-x",
      baseUrl: "https://api.anthropic.com",
      headers: {},
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    ...overrides,
  } as unknown as ExtensionContext;
}

function ephemeralPayload() {
  return {
    model: "claude-x",
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
    max_tokens: 512,
    stream: true,
  };
}

function settingsWith(overrides: Partial<AgentSettings["cacheTtl"]> = {}): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    cacheTtl: { ...DEFAULT_SETTINGS.cacheTtl, keepalive: true, childKeepalive: true, ...overrides },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("child keepalive wiring (T-K6/T-K7): real ping, cost folded into the child run", () => {
  it("captures, arms on tool_execution_start, pings once armed, and reports cost fields", async () => {
    const fetchImpl = provenHitFetch();
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
    vi.useFakeTimers();
    const sessionId = "child-session-under-test";
    const ctx = fakeCtx(sessionId);
    const settings = settingsWith();
    const { pi, emit, appended } = fakePi();
    try {
      const handle = wireChildKeepalive(pi, settings);
      expect(handle).toBeDefined();

      await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      await emit("before_provider_headers", { headers: { "content-type": "application/json" } }, ctx);
      await emit("turn_end", {}, ctx); // noteRequestSettled (mirrors cache-keepalive.test.ts's own sequence)
      await emit("tool_execution_start", {}, ctx); // arms (backgroundBusy is always false for child sessions)

      // Interval default 240s; advance well past it.
      await vi.advanceTimersByTimeAsync(245_000);
      await flush();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const provenHit = appended.find((entry) => (entry.data as { kind?: string })?.kind === "proven-hit");
      expect(provenHit).toBeDefined();
      const data = provenHit!.data as Record<string, unknown>;
      // reportCost:true (child-only) — main session's own audit entries never carry these.
      expect(typeof data.costUsd).toBe("number");
      expect(typeof data.budgetChargeUsd).toBe("number");
      expect(typeof data.runSpentUsd).toBe("number");
      expect(typeof data.processSpentUsd24h).toBe("number");
      expect(data.cacheReadTokens).toBe(40_000);

      // T-K7: ping never overlaps an in-flight request — noteRequest (a real request) would
      // otherwise abort the in-flight ping; here there simply is no overlap to begin with, which
      // this test's single-ping-then-dispose flow already demonstrates without a live request.
      // The actual overlap-avoidance mechanism is exercised concretely below.
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it("T-K7: a real request arriving while a ping is in flight aborts the ping's fetch signal (no overlap)", async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolvePing: ((value: Response) => void) | undefined;
    const deferredFetch = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => {
      capturedSignal = init?.signal;
      return new Promise<Response>((resolve) => {
        resolvePing = resolve;
      });
    });
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = deferredFetch as unknown as typeof fetch;
    vi.useFakeTimers();
    const sessionId = "child-session-overlap";
    const ctx = fakeCtx(sessionId);
    const settings = settingsWith();
    const { pi, emit } = fakePi();
    try {
      wireChildKeepalive(pi, settings);
      await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      await emit("before_provider_headers", { headers: { "content-type": "application/json" } }, ctx);
      await emit("turn_end", {}, ctx);
      await emit("tool_execution_start", {}, ctx);

      await vi.advanceTimersByTimeAsync(245_000);
      await flush(30);

      expect(deferredFetch).toHaveBeenCalledTimes(1); // the ping is now in flight, unresolved.
      expect(capturedSignal?.aborted).toBe(false);

      // A REAL request arrives (a new tool call's model round-trip) while that ping is still
      // pending — `noteRequest` (wired via `before_provider_headers` → `consumeHeaders`) must
      // abort it rather than let both race.
      await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      await emit("before_provider_headers", { headers: { "content-type": "application/json" } }, ctx);
      await flush(10);

      expect(capturedSignal?.aborted).toBe(true);

      // The aborted ping's fetch eventually "resolving" late (a real network race) must not
      // throw or double-process — dispose/settle already moved on.
      resolvePing?.({ ok: true, status: 200, body: { getReader: () => chunkedReader([]) } } as unknown as Response);
      await flush(10);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it("T-K8: agent_settled disposes immediately — no further ping fires even if a tick was already armed", async () => {
    const fetchImpl = provenHitFetch();
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
    vi.useFakeTimers();
    const sessionId = "child-session-dispose";
    const ctx = fakeCtx(sessionId);
    const settings = settingsWith();
    const { pi, emit } = fakePi();
    try {
      wireChildKeepalive(pi, settings);
      await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      await emit("before_provider_headers", { headers: { "content-type": "application/json" } }, ctx);
      await emit("tool_execution_start", {}, ctx);
      await emit("agent_settled", {}, ctx); // one prompt == one settle for a child session

      await vi.advanceTimersByTimeAsync(400_000);
      await flush();

      expect(fetchImpl).not.toHaveBeenCalled();
      // The dispose registry entry is gone too (registered once by ensureService, removed by
      // dispose) — a defensive onReaped fan-out after this point is a safe no-op.
      expect(() => getChildKeepaliveDisposeRegistry().disposeSession(sessionId)).not.toThrow();
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it("noteContextSwitch invalidates the current capture window (plan §2.4: a committed switch rewrites the prefix like a compaction)", async () => {
    const fetchImpl = provenHitFetch();
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
    const sessionId = "child-session-switch-invalidate";
    const ctx = fakeCtx(sessionId);
    const settings = settingsWith();
    const { pi, emit } = fakePi();
    try {
      const handle = wireChildKeepalive(pi, settings);
      await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      await emit("before_provider_headers", { headers: { "content-type": "application/json" } }, ctx);
      handle?.noteContextSwitch();
      // No assertion API is exposed on the handle beyond the side effect itself not throwing —
      // the underlying reducer behavior (invalidate clears `window.capture`) is unit-tested
      // exhaustively in tests/cache-ttl/keepalive-state.test.ts; this test only pins the WIRING
      // (the new "context-switch" InvalidateReason reaches the service without throwing).
      expect(() => handle?.noteContextSwitch()).not.toThrow();
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });
  it("tool_execution_end disarms — waiting past the interval afterwards never pings (T-K3)", async () => {
    const fetchImpl = provenHitFetch();
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
    vi.useFakeTimers();
    const sessionId = "child-session-disarm";
    const ctx = fakeCtx(sessionId);
    const settings = settingsWith();
    const { pi, emit } = fakePi();
    try {
      wireChildKeepalive(pi, settings);
      await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      await emit("before_provider_headers", { headers: { "content-type": "application/json" } }, ctx);
      await emit("tool_execution_start", {}, ctx); // arms
      await emit("tool_execution_end", {}, ctx); // immediately disarms again — no tool is running anymore.

      await vi.advanceTimersByTimeAsync(400_000); // well past the 240s default interval
      await flush();

      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it("a stale/invalidated ctx (a throwing `ctx.model` getter) self-destructs on the next tick and never pings (T-K3)", async () => {
    const fetchImpl = provenHitFetch();
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
    vi.useFakeTimers();
    const sessionId = "child-session-stale-ctx";
    const ctx = fakeCtx(sessionId);
    const settings = settingsWith();
    const { pi, emit } = fakePi();
    try {
      wireChildKeepalive(pi, settings);
      await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      await emit("before_provider_headers", { headers: { "content-type": "application/json" } }, ctx);
      await emit("tool_execution_start", {}, ctx);

      // NOW simulate pi invalidating the extension ctx mid-flight (any property read throws
      // from here on) — same shape `src/service/cache-keepalive.ts`'s `safeModel()` defends
      // against (plan §2.4: "每个 tick 先读 ctx.mode，抛错 ⇒ dispose() 并 return，早于其它任何闸门").
      // Set AFTER the initial capture (not before) — a genuinely stale ctx only manifests once
      // the NEXT tick reads it, not retroactively on requests already captured.
      Object.defineProperty(ctx, "model", {
        get() {
          throw new Error("ctx invalidated");
        },
      });

      await vi.advanceTimersByTimeAsync(400_000);
      await flush();

      expect(fetchImpl).not.toHaveBeenCalled();
      // Self-destructed — a later defensive onReaped dispose is a safe no-op.
      expect(() => getChildKeepaliveDisposeRegistry().disposeSession(sessionId)).not.toThrow();
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it("honors the per-window ping cap (default 11, `cacheTtl.keepaliveMaxPings`) within one continuous window (T-K3)", async () => {
    const fetchImpl = provenHitFetch();
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
    vi.useFakeTimers();
    const sessionId = "child-session-window-cap";
    const ctx = fakeCtx(sessionId);
    expect(DEFAULT_SETTINGS.cacheTtl.keepaliveMaxPings).toBe(11);
    // Generous run/process $ budgets — isolates the PER-WINDOW cap from the $ gates T-K9
    // already covers exhaustively with this same fakeCtx()'s (deliberately pricy) cost fields.
    const settings = settingsWith({ childKeepaliveRunBudgetUsd: 1000, childKeepaliveProcessBudgetUsd: 1000 });
    const { pi, emit } = fakePi();
    try {
      wireChildKeepalive(pi, settings);
      await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      await emit("before_provider_headers", { headers: { "content-type": "application/json" } }, ctx);
      await emit("turn_end", {}, ctx); // establishes the baseline the tick measures elapsed time against.
      await emit("tool_execution_start", {}, ctx); // stays armed for the whole run — one continuous window, no request settles.

      // 15 ticks at the default 245s cadence: the window cap must stop it at exactly 11.
      for (let i = 0; i < 15; i++) {
        await vi.advanceTimersByTimeAsync(245_000);
        await flush(30);
      }

      expect(fetchImpl).toHaveBeenCalledTimes(11);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it("the per-RUN cap (default 24, `cacheTtl.childKeepaliveMaxPingsPerRun`) is a separate, higher ceiling than the per-window cap — raising the window cap lets the run cap become the binding one (T-K3)", async () => {
    const fetchImpl = provenHitFetch();
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
    vi.useFakeTimers();
    const sessionId = "child-session-run-cap";
    const ctx = fakeCtx(sessionId);
    const settings = settingsWith({
      childKeepaliveRunBudgetUsd: 1000,
      childKeepaliveProcessBudgetUsd: 1000,
      keepaliveMaxPings: 100, // well above the 24-per-run cap, so it never binds first.
    });
    expect(DEFAULT_SETTINGS.cacheTtl.childKeepaliveMaxPingsPerRun).toBe(24);
    const { pi, emit } = fakePi();
    try {
      wireChildKeepalive(pi, settings);
      await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      await emit("before_provider_headers", { headers: { "content-type": "application/json" } }, ctx);
      await emit("turn_end", {}, ctx);
      await emit("tool_execution_start", {}, ctx);

      for (let i = 0; i < 30; i++) {
        await vi.advanceTimersByTimeAsync(245_000);
        await flush(30);
      }

      expect(fetchImpl).toHaveBeenCalledTimes(24);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });
});

describe("child keepalive wiring (T-Z1): disabled ⇒ zero registration/network", () => {
  it("cacheTtl.childKeepalive=false ⇒ undefined handle, zero pi.on registrations, zero fetch", async () => {
    const fetchImpl = provenHitFetch();
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
    const settings = settingsWith({ childKeepalive: false });
    const { pi, handlers, emit } = fakePi();
    try {
      const handle = wireChildKeepalive(pi, settings);
      expect(handle).toBeUndefined();
      expect(handlers.size).toBe(0);
      await emit("before_provider_request", { payload: ephemeralPayload() }, fakeCtx("x"));
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });
});

describe("child keepalive ledger (T-K9): unpriced model never pings", () => {
  beforeEach(() => {
    // Isolate the process-wide ledger's rolling budget from other tests in this file.
    const ledger = getChildKeepaliveLedger();
    void ledger; // shared singleton; each test uses a distinct sessionId so leases don't collide.
  });

  it("model with no cost info ⇒ usd-unpriced, never pings", async () => {
    const fetchImpl = provenHitFetch();
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
    vi.useFakeTimers();
    const sessionId = "child-session-unpriced";
    const ctx = fakeCtx(sessionId, {
      model: {
        provider: "anthropic",
        api: "anthropic-messages",
        id: "claude-x",
        baseUrl: "https://api.anthropic.com",
        headers: {},
      },
    });
    const settings = settingsWith();
    const { pi, emit } = fakePi();
    try {
      wireChildKeepalive(pi, settings);
      await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      await emit("before_provider_headers", { headers: { "content-type": "application/json" } }, ctx);
      await emit("tool_execution_start", {}, ctx);
      await vi.advanceTimersByTimeAsync(400_000);
      await flush();
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });
});
