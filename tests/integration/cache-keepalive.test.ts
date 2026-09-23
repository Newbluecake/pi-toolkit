import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionStack } from "../../src/stack.js";
import { wireCacheTtl } from "../../src/cache-ttl/cache-ttl.js";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

let homeSandbox: ReturnType<typeof sandboxHome> | undefined;
beforeEach(() => {
  homeSandbox = sandboxHome();
});
afterEach(() => {
  homeSandbox?.restore();
  homeSandbox = undefined;
});

/**
 * End-to-end wiring for the prompt-cache keepalive service: a real
 * `buildSessionStack` + `wireCacheTtl`, driven exactly the way `index.ts`
 * assembles them (holder read-through `() => holder.current?.keepalive`),
 * with `vi.useFakeTimers()` standing in for wall-clock time (the service
 * itself uses `systemClock`, which is backed by real `setTimeout`).
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
    fakeOkResponse([messageStartChunk({ cache_read_input_tokens: 500, cache_creation_input_tokens: 0 })]),
  );
}

async function flush(times = 15): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function fakePi() {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
  const pi = {
    registerTool: () => undefined,
    registerCommand: (name: string, value: { handler: (args: string, ctx: unknown) => unknown }) =>
      commands.set(name, value),
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage: () => undefined,
    appendEntry: vi.fn(),
    events: { on: () => () => undefined, emit: vi.fn() },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  };
  const emit = async (event: string, payload: unknown = {}, ctx: unknown = {}) => {
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
    return results;
  };
  return { pi: pi as unknown as ExtensionAPI, emit, commands, handlers };
}

function fakeCtx(overrides: Record<string, unknown> = {}): ExtensionContext {
  return {
    cwd: process.cwd(),
    mode: "tui",
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
      getSessionId: () => "session-under-test",
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

const emptyTypes = {
  get: () => undefined,
  list: () => [],
  reload: async () => ({ types: [], errors: [] }),
} as unknown as AgentTypeRegistry;

function settingsWith(overrides: Partial<AgentSettings["cacheTtl"]> = {}): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    fleetWidget: false,
    cacheTtl: { ...DEFAULT_SETTINGS.cacheTtl, keepalive: true, keepaliveMaxPings: 11, ...overrides },
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

describe("cache keepalive — real buildSessionStack + wireCacheTtl", () => {
  it("captures a real request and pings once armed, replaying the payload byte-for-byte (max_tokens forced to 1)", async () => {
    const fetchImpl = provenHitFetch();
    const { pi, emit } = fakePi();
    const settings = settingsWith();
    const ctx = fakeCtx();
    const stack = buildSessionStack(pi, ctx, settings, emptyTypes, []);
    // Re-wire the service to use our fake fetch (buildSessionStack always uses globalThis.fetch —
    // override via the private field is not possible, so build a second keepalive-carrying stack
    // is unnecessary: instead, drive the real assembly the way index.ts would, but with fetch
    // patched on globalThis for the duration of this test).
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
    vi.useFakeTimers();
    try {
      const holder: { current?: { keepalive?: typeof stack.keepalive } } = { current: stack };
      wireCacheTtl(pi, settings, { keepalive: () => holder.current?.keepalive });

      await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      // Root-cause fix under test: the payload capture alone is NOT enough to
      // ping — it must be paired with the matching `before_provider_headers`
      // snapshot for the SAME request before `noteRequest` ever fires.
      expect(stack.keepalive?.report().window.capture).toBeUndefined();
      await emit(
        "before_provider_headers",
        {
          type: "before_provider_headers",
          headers: {
            "content-type": "application/json",
            "anthropic-beta": "real-gateway-beta",
            "x-router-hint": "route-7",
          },
        },
        ctx,
      );
      expect(stack.keepalive?.report().window.capture).toBeDefined();

      stack.keepalive?.noteRequestSettled("session-under-test", stack.keepalive.instanceId);
      // Force "armed" without going through index.ts's activate-level
      // tool_execution_start forwarder (out of scope for this stack+cache-ttl
      // wiring test) — call the service's own armed-signal method directly,
      // exactly as that forwarder would.
      stack.keepalive?.noteToolStart("session-under-test", stack.keepalive.instanceId);

      // Advance real wall-clock time past the keepalive interval (240s) so the
      // service's `systemClock.setTimer` (backed by `setTimeout`) fires.
      await vi.advanceTimersByTimeAsync(245_000);
      await flush();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [, pingInit] = fetchImpl.mock.calls[0]! as [string, RequestInit];
      const body = JSON.parse(pingInit.body as string);
      expect(body.max_tokens).toBe(1);
      expect(body.messages).toEqual(ephemeralPayload().messages); // byte-for-byte replay
      // Root-cause fix under test: the captured headers are replayed VERBATIM
      // (no hand-assembled baseline, no hardcoded anthropic-beta) — a gateway-
      // specific header set by the real request must survive into the ping.
      const pingHeaders = pingInit.headers as Record<string, string>;
      expect(pingHeaders["anthropic-beta"]).toBe("real-gateway-beta");
      expect(pingHeaders["x-router-hint"]).toBe("route-7");
      expect(pingHeaders["content-type"]).toBe("application/json");
      expect(stack.keepalive?.report().session.pings).toBe(1);
    } finally {
      vi.useRealTimers();
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      stack.keepalive?.dispose();
    }
  });

  it("does not ping when never armed (no background work, no in-flight tool)", async () => {
    const fetchImpl = provenHitFetch();
    const { pi, emit } = fakePi();
    const settings = settingsWith();
    const ctx = fakeCtx();
    const stack = buildSessionStack(pi, ctx, settings, emptyTypes, []);
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchImpl as unknown as typeof fetch;
    vi.useFakeTimers();
    try {
      const holder: { current?: { keepalive?: typeof stack.keepalive } } = { current: stack };
      wireCacheTtl(pi, settings, { keepalive: () => holder.current?.keepalive });
      await emit("before_provider_request", { payload: ephemeralPayload() }, ctx);
      stack.keepalive?.noteRequestSettled("session-under-test", stack.keepalive.instanceId);

      await vi.advanceTimersByTimeAsync(400_000);
      await flush();

      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
      stack.keepalive?.dispose();
    }
  });

  it("stack rebuild disposes the previous keepalive service (no timer/status leak)", async () => {
    const { pi } = fakePi();
    const settings = settingsWith();
    const ctxA = fakeCtx();
    const first = buildSessionStack(pi, ctxA, settings, emptyTypes, []);
    expect(first.keepalive).toBeDefined();
    const setStatusA = ctxA.ui.setStatus as ReturnType<typeof vi.fn>;

    const ctxB = fakeCtx();
    const second = buildSessionStack(pi, ctxB, settings, emptyTypes, []);
    expect(second.keepalive).toBeDefined();
    expect(second.keepalive).not.toBe(first.keepalive);
    // The previous instance was disposed at the top of this build — its own
    // ctx.ui.setStatus(undefined) call already fired (dispose semantics).
    expect(setStatusA).toHaveBeenCalledWith("cache-ttl", undefined);
    second.keepalive?.dispose();
  });

  it("holder-empty (keepalive setting off) leaves before_provider_request behaving exactly as before", async () => {
    const { pi, emit } = fakePi();
    const settings = settingsWith({ keepalive: false });
    const ctx = fakeCtx();
    const stack = buildSessionStack(pi, ctx, settings, emptyTypes, []);
    expect(stack.keepalive).toBeUndefined();
    const holder: { current?: { keepalive?: typeof stack.keepalive } } = { current: stack };
    wireCacheTtl(pi, settings, { keepalive: () => holder.current?.keepalive });
    const [result] = (await emit("before_provider_request", { payload: ephemeralPayload() }, ctx)) as [unknown];
    expect(result).toBeUndefined(); // auto mode: unchanged from today's no-keepalive behavior
  });

  it("cross-session capture is dropped: a stale sessionId never reaches the current instance", async () => {
    const { pi, emit } = fakePi();
    const settings = settingsWith();
    const ctx = fakeCtx();
    const stack = buildSessionStack(pi, ctx, settings, emptyTypes, []);
    const holder: { current?: { keepalive?: typeof stack.keepalive } } = { current: stack };
    wireCacheTtl(pi, settings, { keepalive: () => holder.current?.keepalive });

    const staleCtx = fakeCtx({
      sessionManager: { getEntries: () => [], getSessionId: () => "some-other-session", getBranch: () => [] },
    });
    await emit("before_provider_request", { payload: ephemeralPayload() }, staleCtx);
    await emit(
      "before_provider_headers",
      { type: "before_provider_headers", headers: { "content-type": "application/json" } },
      staleCtx,
    );
    expect(stack.keepalive?.report().window.capture).toBeUndefined();
    expect(stack.keepalive?.report().dropped.sessionMismatch).toBeGreaterThanOrEqual(1);

    stack.keepalive?.dispose();
  });
});
