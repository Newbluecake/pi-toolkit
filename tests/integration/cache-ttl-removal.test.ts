import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { wireCacheTtl } from "../../src/cache-ttl/cache-ttl.js";
import { readBackKeepaliveSessionState } from "../../src/cache-ttl/keepalive-state.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { FakeClock } from "../../src/core/clock.js";
import { type CacheKeepaliveService } from "../../src/service/cache-keepalive.js";
import { createCacheKeepaliveService } from "../cache-ttl/fake-pipeline.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function session() {
  const dir = mkdtempSync(join(tmpdir(), "cache-ttl-removal-"));
  dirs.push(dir);
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  manager.appendMessage({
    role: "assistant",
    model: "claude-x",
    provider: "anthropic",
    timestamp: 0,
    content: [{ type: "text", text: "prior response" }],
    usage: { cacheRead: 30_000, cacheWrite: 0 },
  } as never);
  return manager;
}

function payload() {
  return {
    model: "claude-x",
    stream: true,
    max_tokens: 512,
    messages: [
      { role: "user", content: [{ type: "text", text: "next request", cache_control: { type: "ephemeral" } }] },
    ],
  };
}

function wiring(ctx: ExtensionContext, keepalive?: CacheKeepaliveService) {
  const hooks = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, any>();
  const pi = {
    on: (name: string, fn: any) => hooks.set(name, fn),
    registerCommand: (name: string, command: any) => commands.set(name, command),
  } as unknown as ExtensionAPI;
  wireCacheTtl(pi, DEFAULT_SETTINGS, { keepalive: () => keepalive });
  return { hooks, commands, fire: (name: string, event: unknown) => hooks.get(name)!(event, ctx) };
}

function context(manager: SessionManager): ExtensionContext {
  const ctx = {
    mode: "tui",
    sessionManager: manager,
    model: {
      provider: "anthropic",
      api: "anthropic-messages",
      id: "claude-x",
      baseUrl: "https://api.anthropic.com",
      cost: { cacheRead: 0.3, cacheWrite: 0.9 },
    },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }) },
    ui: { setStatus: vi.fn(), notify: vi.fn() },
  } as unknown as ExtensionContext;
  ctx.modelRegistry.find = (provider, id) =>
    ctx.model?.provider === provider && ctx.model.id === id ? ctx.model : undefined;
  return ctx;
}

async function flush() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

describe("cache TTL removal integration", () => {
  it("reopens historical adaptive custom entries without interpreting them", async () => {
    const manager = session();
    manager.appendCustomEntry("subagent:cache-adaptive", {
      kind: "reconcile",
      breaker: "warm-miss",
      learned1hLifeMs: 1_200_000,
    });
    const file = manager.getSessionFile();
    expect(file).toBeTruthy();
    const reopened = SessionManager.open(file!);
    expect(
      reopened.getBranch().some((entry) => entry.type === "custom" && entry.customType === "subagent:cache-adaptive"),
    ).toBe(true);
    expect(readBackKeepaliveSessionState(reopened.getBranch())).toBeUndefined();
    const ctx = context(reopened);
    const w = wiring(ctx);
    const request = payload();
    const original = structuredClone(request);
    expect(w.fire("before_provider_request", { payload: request })).toBeUndefined();
    expect(request).toEqual(original);
    expect(
      w.commands
        .get("cache-ttl")
        .getArgumentCompletions("")
        .map((item: any) => item.value),
    ).not.toContain("adaptive");
    await w.commands.get("cache-ttl").handler("adaptive", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('invalid argument "adaptive"'), "warning");
  });

  it("budget exhaustion stops pings but never upgrades the next auto request", async () => {
    const manager = session();
    const ctx = context(manager);
    const clock = new FakeClock(0);
    vi.spyOn(Date, "now").mockImplementation(() => clock.now());
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 0 } } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    let service: CacheKeepaliveService | undefined;
    service = createCacheKeepaliveService({
      clock,
      ctx,
      sessionId: manager.getSessionId(),
      settings: { ...DEFAULT_SETTINGS.cacheTtl },
      backgroundBusy: () => true,
      isCurrent: (self) => self === service,
      fetchImpl,
    });
    try {
      const w = wiring(ctx, service);
      expect(w.fire("before_provider_request", { payload: payload() })).toBeUndefined();
      w.fire("message_end", { message: { role: "assistant", usage: { input: 1 }, stopReason: "stop" } });
      clock.advance(240_000);
      await flush();
      expect(service.report().session.pings).toBe(1);
      clock.advance(240_000);
      await flush();
      expect(service.report().lastSkip).toBe("budget-exhausted");
      expect(clock.pendingTimers).toBe(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      clock.advance(400_000);
      const request = payload();
      expect(w.fire("before_provider_request", { payload: request })).toBeUndefined();
      expect(request.messages[0]?.content[0]?.cache_control).toEqual({ type: "ephemeral" });
      expect(service.report().window.pings).toBe(0);
      expect(service.report().window.capture?.shape.ttl1h).toBe(false);
    } finally {
      service.dispose();
    }
  });
});

describe("dynamic cap main response usage wiring", () => {
  it("uses the actual window response, not the older ledger usage, across tier thresholds", () => {
    const manager = session();
    const ctx = context(manager);
    ctx.model!.cost = {
      input: 1,
      output: 5,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      tiers: [
        { inputTokensAbove: 40_000, cacheRead: 0.025, cacheWrite: 1.25 },
        { inputTokensAbove: 100_000, cacheRead: 1, cacheWrite: 3 },
      ],
    } as never;
    const clock = new FakeClock(0);
    let svc: CacheKeepaliveService | undefined;
    svc = createCacheKeepaliveService({
      clock,
      ctx,
      sessionId: manager.getSessionId(),
      settings: DEFAULT_SETTINGS.cacheTtl,
      backgroundBusy: () => true,
      isCurrent: (s) => s === svc,
    });
    try {
      const w = wiring(ctx, svc);
      for (const [input, expected] of [
        [25_000, 48],
        [150_000, 1],
      ]) {
        w.fire("before_provider_request", { payload: payload() });
        expect(svc.report().config.maxPingsReason).toBe("tier-uncertain");
        w.fire("message_end", {
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-x",
            usage: { input, cacheRead: 30_000, cacheWrite: 0 },
          },
        });
        expect(svc.report().config).toMatchObject({ maxPings: expected, maxPingsSource: "priced" });
      }
    } finally {
      svc.dispose();
    }
  });
});
