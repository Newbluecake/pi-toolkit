/**
 * O4: `/cache-ttl probe` — runCacheProbe (mock fetch layer) and the command wiring.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProbePrefix, runCacheProbe, PROBE_TOTAL_TIMEOUT_MS } from "../../src/cache-ttl/probe.js";
import { createProviderEvidenceStore, type ProviderEvidenceStore } from "../../src/cache-ttl/provider-evidence.js";
import { wireCacheTtl, type CacheTtlDeps } from "../../src/cache-ttl/cache-ttl.js";
import type { AgentSettings } from "../../src/config/settings.js";

const encoder = new TextEncoder();

interface FakeCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Build a fetch double that answers each call with a message_start SSE frame carrying `usage`. */
function scriptFetch(usages: Array<Record<string, unknown>>): { fetchImpl: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: unknown, init?: { headers?: Record<string, string>; body?: unknown }) => {
    const usage = usages[Math.min(i, usages.length - 1)]!;
    i += 1;
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const frame = `data: ${JSON.stringify({ type: "message_start", message: { usage } })}\n\n`;
    let pending: Uint8Array | undefined = encoder.encode(frame);
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          cancel: async () => {},
          read: async () => {
            if (pending) {
              const value = pending;
              pending = undefined;
              return { done: false, value };
            }
            return { done: true, value: undefined };
          },
        }),
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const WRITE_USAGE = { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 3100 };
const HIT_USAGE = { input_tokens: 1, cache_read_input_tokens: 3100, cache_creation_input_tokens: 0 };
const WRITE_1H_USAGE = {
  input_tokens: 1,
  cache_read_input_tokens: 3100,
  cache_creation_input_tokens: 3100,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3100 },
};
const WRITE_1H_COLLAPSED = {
  input_tokens: 1,
  cache_read_input_tokens: 3100,
  cache_creation_input_tokens: 3100,
  cache_creation: { ephemeral_5m_input_tokens: 3100, ephemeral_1h_input_tokens: 0 },
};

const INPUT = { baseUrl: "https://api.example.com/", model: "claude-x", apiKey: "sk-test" };

describe("runCacheProbe (O4)", () => {
  it("healthy route: 3 requests, alive + hit + 1h landed", async () => {
    const { fetchImpl, calls } = scriptFetch([WRITE_USAGE, HIT_USAGE, WRITE_1H_USAGE]);
    const result = await runCacheProbe({ ...INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.requests).toBe(3);
    expect(result.cacheAlive).toBe(true);
    expect(result.immediateHit).toBe(true);
    expect(result.write1hLanded).toBe(true);
    expect(result.tokens).toEqual({ write5m: 3100, read: 3100, write1h: 3100 });
    expect(result.error).toBeUndefined();

    // URL de-slashed, auth filled, baseline headers present
    expect(calls[0]!.url).toBe("https://api.example.com/v1/messages");
    expect(calls[0]!.headers["x-api-key"]).toBe("sk-test");
    expect(calls[0]!.headers["anthropic-version"]).toBe("2023-06-01");

    // Phases A and B are byte-identical 5m writes; phase C carries ttl:"1h".
    expect(JSON.stringify(calls[0]!.body)).toBe(JSON.stringify(calls[1]!.body));
    const msgA = (calls[0]!.body.messages as never[])[0] as { content: [{ cache_control?: unknown }] };
    const msgC = (calls[2]!.body.messages as never[])[0] as { content: [{ cache_control?: unknown }] };
    expect(msgA.content[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(msgC.content[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // unique nonce prefix, ~3000 tokens, streamed with max_tokens:1
    const text = (calls[0]!.body.messages as never[])[0] as { content: [{ text: string }] };
    expect(text.content[0]!.text.length).toBeGreaterThanOrEqual(10_000);
    expect(calls[0]!.body.max_tokens).toBe(1);
    expect(calls[0]!.body.stream).toBe(true);
    expect(calls[0]!.body.model).toBe("claude-x");
  });

  it("collapsing relay: write + hit work, but the 1h split stays 0 ⇒ write1hLanded false", async () => {
    const { fetchImpl } = scriptFetch([WRITE_USAGE, HIT_USAGE, WRITE_1H_COLLAPSED]);
    const result = await runCacheProbe({ ...INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.cacheAlive).toBe(true);
    expect(result.immediateHit).toBe(true);
    expect(result.write1hLanded).toBe(false);
  });

  it("collapsed route that omits the split entirely ⇒ write1hLanded false (absent ≠ landed)", async () => {
    const { fetchImpl } = scriptFetch([WRITE_USAGE, HIT_USAGE, { ...WRITE_1H_COLLAPSED, cache_creation: undefined }]);
    const result = await runCacheProbe({ ...INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.write1hLanded).toBe(false);
  });

  it("dead-cache route: write registers nothing, re-read misses", async () => {
    const dead = { input_tokens: 3200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const { fetchImpl } = scriptFetch([dead, dead, dead]);
    const result = await runCacheProbe({ ...INPUT, fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.cacheAlive).toBe(false);
    expect(result.immediateHit).toBe(false);
    expect(result.write1hLanded).toBe(false);
  });

  it("a failed phase A stops the probe (later phases skipped, ≤3 request bound held)", async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: false, status: 401, body: undefined, text: async () => "no" }) as unknown as Response,
    ) as unknown as typeof fetch;
    const result = await runCacheProbe({ ...INPUT, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.requests).toBe(1);
    expect(result.error).toBe("write phase: http 401");
    expect(result.phases.reread.outcome).toBe("skipped");
    expect(result.phases.write1h.outcome).toBe("skipped");
  });

  it("an exhausted total budget skips the remaining phases", async () => {
    let tick = 1_000;
    const { fetchImpl } = scriptFetch([WRITE_USAGE, HIT_USAGE, WRITE_1H_USAGE]);
    const result = await runCacheProbe({
      ...INPUT,
      fetchImpl,
      timeoutMs: 5,
      now: () => (tick += 10), // every clock read advances past the budget
    });
    expect(result.ok).toBe(false);
    expect(result.requests).toBeLessThan(3);
  });

  it("never throws when fetch itself rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("conn refused");
    }) as unknown as typeof fetch;
    const result = await runCacheProbe({ ...INPUT, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("network");
  });

  it("buildProbePrefix is nonce-unique and ~3000 tokens", () => {
    const a = buildProbePrefix("nonce-A");
    const b = buildProbePrefix("nonce-B");
    expect(a).not.toBe(b);
    expect(a).toContain("nonce-A");
    expect(a.length).toBeGreaterThanOrEqual(10_000); // ≥1024-token Anthropic minimum, ~3000 target
  });
});

// ---------------------------------------------------------------------------
// Command-level wiring: /cache-ttl probe through wireCacheTtl
// ---------------------------------------------------------------------------

function makePi() {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
  return {
    pi: {
      on: (event: string, handler: never) => handlers.set(event, handler),
      registerCommand: (name: string, spec: never) => commands.set(name, spec),
    },
    handlers,
    commands,
  };
}

function settingsWith(mode: "auto" | "on" | "off"): AgentSettings {
  return {
    cacheTtl: {
      mode,
      keepalive: true,
      keepaliveIntervalMs: 240_000,
      keepaliveMaxPings: 11,
      keepaliveMinPrefixTokens: 20_000,
    },
  } as unknown as AgentSettings;
}

function probeCtx(overrides: Record<string, unknown> = {}) {
  return {
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    model: {
      api: "anthropic-messages",
      provider: "cr-anthropic",
      id: "claude-x",
      baseUrl: "https://cr.example.com",
      cost: { cacheRead: 0.3, cacheWrite: 3.75, tiers: [] },
    },
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "sk-probe", headers: {} }),
    },
    sessionManager: { getSessionId: () => "s1", getEntries: () => [] },
    ...overrides,
  };
}

describe("/cache-ttl probe command (O4)", () => {
  let dir: string;
  let store: ProviderEvidenceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-probe-cmd-"));
    store = createProviderEvidenceStore(join(dir, "evidence.json"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function wire(deps: CacheTtlDeps) {
    const { pi, commands } = makePi();
    wireCacheTtl(pi as never, settingsWith("auto"), deps);
    return commands.get("cache-ttl")!;
  }

  it("runs the probe, reports the verdict, and writes evidence back (collapsed 1h)", async () => {
    const { fetchImpl } = scriptFetch([WRITE_USAGE, HIT_USAGE, WRITE_1H_COLLAPSED]);
    const command = wire({ evidence: store, probeFetch: fetchImpl });
    const ctx = probeCtx();
    await command.handler("probe", ctx as never);

    const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
    const report = notify.mock.calls.map(([msg]) => String(msg)).join("\n");
    expect(report).toContain("cache write (5m): alive");
    expect(report).toContain("immediate re-read: hit");
    expect(report).toContain("1h landing: NO");
    expect(report).toContain("cost: ≈$");
    expect(report).not.toContain("cost: unknown");

    const route = store.readRoute("cr-anthropic", "claude-x", Date.now());
    expect(route?.probe).toEqual({ cacheAlive: true, immediateHit: true, write1hLanded: false });
    expect(store.hasWrite1hEvidence("cr-anthropic", "claude-x", Date.now())).toBe(false);
  });

  it("M5: a model without cache rates reports cost: unknown (never a misleading $0)", async () => {
    const { fetchImpl } = scriptFetch([WRITE_USAGE, HIT_USAGE, WRITE_1H_COLLAPSED]);
    const command = wire({ evidence: store, probeFetch: fetchImpl });
    const ctx = probeCtx();
    (ctx.model as { cost?: unknown }).cost = {}; // no cacheRead/cacheWrite rates
    await command.handler("probe", ctx as never);
    const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
    const report = notify.mock.calls.map(([msg]) => String(msg)).join("\n");
    expect(report).toContain("cost: unknown");
    expect(report).not.toContain("≈$0");
  });

  it("a landed 1h probe feeds hasWrite1hEvidence (O1/O2's evidence source)", async () => {
    const { fetchImpl } = scriptFetch([WRITE_USAGE, HIT_USAGE, WRITE_1H_USAGE]);
    const command = wire({ evidence: store, probeFetch: fetchImpl });
    await command.handler("probe", probeCtx() as never);
    expect(store.hasWrite1hEvidence("cr-anthropic", "claude-x", Date.now())).toBe(true);
  });

  it("refuses non-anthropic routes without sending anything", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const command = wire({ evidence: store, probeFetch: fetchImpl });
    const ctx = probeCtx({ model: { api: "openai-completions", provider: "cr", id: "gpt-x" } });
    await command.handler("probe", ctx as never);
    expect(fetchImpl).not.toHaveBeenCalled();
    const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
    expect(String(notify.mock.calls[0]![0])).toContain("only anthropic-messages");
    expect(store.readRoute("cr", "gpt-x", Date.now())).toBeUndefined();
  });

  it("auth failure ⇒ error notice, zero requests", async () => {
    const { fetchImpl } = scriptFetch([WRITE_USAGE]);
    const command = wire({ evidence: store, probeFetch: fetchImpl });
    const ctx = probeCtx();
    (ctx.modelRegistry.getApiKeyAndHeaders as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });
    await command.handler("probe", ctx as never);
    expect(fetchImpl).not.toHaveBeenCalled();
    const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
    expect(String(notify.mock.calls.at(-1)![0])).toContain("auth resolution failed");
  });

  it("help/completions advertise probe with the billing warning", () => {
    const { pi, commands } = makePi();
    wireCacheTtl(pi as never, settingsWith("auto"), {});
    const spec = commands.get("cache-ttl")! as unknown as {
      description: string;
      getArgumentCompletions: (prefix: string) => { value: string; description?: string }[];
    };
    expect(spec.description).toContain("probe");
    const probe = spec.getArgumentCompletions("pr").find((c) => c.value === "probe");
    expect(probe?.description).toContain("计费");
  });

  it("PROBE_TOTAL_TIMEOUT_MS is the documented 30s budget", () => {
    expect(PROBE_TOTAL_TIMEOUT_MS).toBe(30_000);
  });
});
