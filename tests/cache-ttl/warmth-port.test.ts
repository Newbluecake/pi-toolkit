import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wireCacheTtl, type CacheTtlWiring } from "../../src/cache-ttl/cache-ttl.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import type { CacheKeepaliveService } from "../../src/service/cache-keepalive.js";
import { MAX_TTL_MS } from "../../src/cache-ttl/warmth.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeKeepalive(overrides: Partial<CacheKeepaliveService> = {}): CacheKeepaliveService {
  return {
    instanceId: "inst-1",
    noteRequest: vi.fn(),
    noteRequestSettled: vi.fn(),
    invalidate: vi.fn(),
    report: vi.fn().mockReturnValue({
      armed: false,
      window: { lastReadStartedAt: undefined, pingStartedAt: undefined, pingInFlight: false, nextPingAt: undefined },
    }),
    provenCacheReadAt: vi.fn().mockReturnValue(undefined),
    setEnabled: vi.fn(),
    syncModeState: vi.fn(),
    noteToolStart: vi.fn(),
    noteToolEnd: vi.fn(),
    noteUiPromptStart: vi.fn(),
    noteUiPromptEnd: vi.fn(),
    noteAgentSettled: vi.fn(),
    ...overrides,
  } as unknown as CacheKeepaliveService;
}

function setup(
  opts: {
    mode?: "auto" | "on" | "off";
    keepalive?: CacheKeepaliveService;
  } = {},
) {
  const hooks = new Map<string, (event: any, ctx: any) => unknown>();
  const pi = {
    on: (name: string, handler: any) => hooks.set(name, handler),
    registerCommand: (_name: string, _value: any) => {},
  } as unknown as ExtensionAPI;
  let keepalive = opts.keepalive;
  const wiring: CacheTtlWiring = wireCacheTtl(
    pi,
    { ...DEFAULT_SETTINGS, cacheTtl: { ...DEFAULT_SETTINGS.cacheTtl, mode: opts.mode ?? "auto" } },
    { keepalive: () => keepalive },
  );
  return {
    hooks,
    pi,
    wiring,
    setKeepalive: (v: CacheKeepaliveService | undefined) => (keepalive = v),
  };
}

function makeCtx(
  opts: {
    sessionId?: string;
    model?: Partial<{ provider: string; api: string; id: string; baseUrl: string }>;
    entries?: unknown[];
  } = {},
): ExtensionContext {
  const sessionId = opts.sessionId ?? "s1";
  const entries = opts.entries ?? [];
  return {
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
    model: {
      provider: "anthropic",
      api: "anthropic-messages",
      id: "claude-x",
      baseUrl: "https://api.anthropic.com",
      ...opts.model,
    },
  } as unknown as ExtensionContext;
}

function assistantEntry(
  usage: Record<string, unknown>,
  opts: { model?: string; provider?: string; timestamp?: number } = {},
) {
  return {
    type: "message",
    message: {
      role: "assistant",
      model: opts.model ?? "claude-x",
      provider: opts.provider ?? "anthropic",
      usage,
      timestamp: opts.timestamp,
    },
  };
}

function ephemeralPayload() {
  return {
    model: "claude-x",
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
    max_tokens: 512,
    stream: true,
  };
}

describe("wireCacheTtl returns a CacheTtlWiring with a never-throwing warmth port", () => {
  it("returns { warmth } (was void pre-topic-switch)", () => {
    const { wiring } = setup();
    expect(wiring).toBeDefined();
    expect(typeof wiring.warmth.assess).toBe("function");
  });

  it("before_provider_request records lastSent (ttl1h/cached) and assess's cold verdict reflects it end to end", () => {
    const sentAt = 100;
    vi.spyOn(Date, "now").mockReturnValue(sentAt);
    const { hooks, wiring } = setup({ mode: "on" });
    const ctx = makeCtx({ entries: [assistantEntry({ cacheRead: 0, cacheWrite: 0 }, { timestamp: 0 })] });

    const payloadBefore = ephemeralPayload();
    const payloadJsonBefore = JSON.stringify(payloadBefore);
    hooks.get("before_provider_request")!({ payload: payloadBefore }, ctx);
    // The hook must not have mutated the caller's original payload object (it works on a clone).
    expect(JSON.stringify(payloadBefore)).toBe(payloadJsonBefore);

    const slackMs = 1_000;
    const now = sentAt + MAX_TTL_MS + slackMs; // exactly at the 1h+slack boundary from lastSent.at
    const result = wiring.warmth.assess(ctx, now, { slackMs });
    // mode:"on" forced this request's payload to 1h ⇒ oneHourPossible, raising the cold bar to 1h;
    // lastSent.at (100) dominates the stale ledger (0) as the latest possible touch, so elapsed time
    // is measured from the recorded send, not the older ledger entry.
    expect(result).toEqual({ state: "cold", reason: "ttl-elapsed", nextWriteTtl: "1h" });
  });

  it("session_start clears lastSent — a recent lastSent keeps a stale ledger from proving cold, but only until reset", async () => {
    const nowAssess = 10 * MAX_TTL_MS;
    const sentAt = nowAssess - 1_000;
    vi.spyOn(Date, "now").mockReturnValue(sentAt);
    const { hooks, wiring } = setup({ mode: "auto" });
    const ctx = makeCtx({ entries: [assistantEntry({ cacheRead: 0, cacheWrite: 0 }, { timestamp: 0 })] });

    hooks.get("before_provider_request")!({ payload: ephemeralPayload() }, ctx);
    const beforeReset = wiring.warmth.assess(ctx, nowAssess, { slackMs: 1_000 });
    expect(beforeReset.state).not.toBe("cold");

    await hooks.get("session_start")!({}, ctx);
    const afterReset = wiring.warmth.assess(ctx, nowAssess, { slackMs: 1_000 });
    expect(afterReset).toEqual({ state: "cold", reason: "ttl-elapsed", nextWriteTtl: "5m" });
  });

  it("lastSent is ignored across sessions (sessionId filter)", () => {
    const nowAssess = 10 * MAX_TTL_MS;
    const sentAt = nowAssess - 1_000;
    vi.spyOn(Date, "now").mockReturnValue(sentAt);
    const { hooks, wiring } = setup({ mode: "auto" });
    const ctxA = makeCtx({
      sessionId: "s1",
      entries: [assistantEntry({ cacheRead: 0, cacheWrite: 0 }, { timestamp: 0 })],
    });
    hooks.get("before_provider_request")!({ payload: ephemeralPayload() }, ctxA);

    const ctxB = makeCtx({
      sessionId: "s2",
      entries: [assistantEntry({ cacheRead: 0, cacheWrite: 0 }, { timestamp: 0 })],
    });
    const result = wiring.warmth.assess(ctxB, nowAssess, { slackMs: 1_000 });
    // Same outcome as a reset lastSent (above): the port never trusts another session's lastSent.
    expect(result).toEqual({ state: "cold", reason: "ttl-elapsed", nextWriteTtl: "5m" });
  });

  it("keepalive instances are re-fetched after a stack rebuild", () => {
    const { wiring, setKeepalive } = setup();
    const ctx = makeCtx({ entries: [assistantEntry({ cacheRead: 0, cacheWrite: 0 }, { timestamp: 1_000 })] });
    setKeepalive(fakeKeepalive({ provenCacheReadAt: vi.fn().mockReturnValue(1_000) }));
    expect(wiring.warmth.assess(ctx, 1_500, { slackMs: 1_000 })).toEqual({ state: "warm", reason: "proven-recent" });
    setKeepalive(fakeKeepalive());
    expect(wiring.warmth.assess(ctx, 1_500, { slackMs: 1_000 })).toEqual({
      state: "unknown",
      reason: "not-provably-cold",
    });
  });

  it("assess never throws when ctx access throws (degrades to unknown/read-error)", () => {
    const { wiring } = setup();
    const poisoned = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    ) as unknown as ExtensionContext;
    expect(() => wiring.warmth.assess(poisoned, Date.now(), { slackMs: 1_000 })).not.toThrow();
    expect(wiring.warmth.assess(poisoned, Date.now(), { slackMs: 1_000 })).toEqual({
      state: "unknown",
      reason: "read-error",
    });
  });

  it("assess never throws when sessionManager itself throws (degrades to unknown via the ledger reader's own inner catch)", () => {
    const { wiring } = setup();
    const ctx = {
      ui: { notify: vi.fn(), setStatus: vi.fn() },
      get sessionManager(): never {
        throw new Error("boom");
      },
      model: { provider: "anthropic", api: "anthropic-messages", id: "claude-x" },
    } as unknown as ExtensionContext;
    // readLatestAssistantUsage/readSessionId/anyLongWriteSince each wrap their own ctx access in
    // try/catch and degrade to "unknown"/"" internally, so this throwing getter never reaches the
    // port's own outer catch — the observable result is still a well-formed `unknown` verdict and
    // the call never throws, which is the contract ("ctx/sessionManager throwing ⇒ unknown, never
    // throws"); the specific reason (`no-ledger`) is an implementation detail of which inner read
    // degrades first.
    expect(() => wiring.warmth.assess(ctx, Date.now(), { slackMs: 1_000 })).not.toThrow();
    expect(wiring.warmth.assess(ctx, Date.now(), { slackMs: 1_000 }).state).toBe("unknown");
  });

  it("no cacheTtl.keepalive deps wired at all ⇒ assess degrades gracefully (never throws, no warm-by-default)", () => {
    const hooks = new Map<string, (event: any, ctx: any) => unknown>();
    const pi = {
      on: (name: string, handler: any) => hooks.set(name, handler),
      registerCommand: () => {},
    } as unknown as ExtensionAPI;
    const wiring = wireCacheTtl(pi, DEFAULT_SETTINGS, {});
    const ctx = makeCtx({ entries: [] });
    expect(wiring.warmth.assess(ctx, Date.now(), { slackMs: 1_000 })).toEqual({
      state: "unknown",
      reason: "no-ledger",
    });
  });
});
