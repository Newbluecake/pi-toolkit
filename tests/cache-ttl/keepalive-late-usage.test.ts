/**
 * Late-usage lines at the service level (plan.md 2026-10-20): seeded vs learned detection, payload clamp on the
 * wire, audit `usageSource`, cost folding, learning from ping 0/0 + next real cache read, `/cache-ttl status`
 * text, and unchanged behaviour on ordinary lines. Uses the REAL pipeline transport over a fake pi stream.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { renderKeepaliveReportLines, type CapturedRequest } from "../../src/cache-ttl/keepalive-state.js";
import { createProviderEvidenceStore, type ProviderEvidenceStore } from "../../src/cache-ttl/provider-evidence.js";
import { createCacheKeepaliveService, type CacheKeepaliveDeps } from "../../src/service/cache-keepalive.js";
import type { CacheTtlSettings } from "../../src/config/settings.js";
import { fakePiStreamSimple } from "./fake-pipeline.js";

const encoder = new TextEncoder();
const frame = (event: Record<string, unknown>) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
const START_00 = frame({
  type: "message_start",
  message: {
    usage: { input_tokens: 9300, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
});
const DELTA_HIT = frame({
  type: "message_delta",
  delta: { stop_reason: "max_tokens" },
  usage: { input_tokens: 0, output_tokens: 3, cache_read_input_tokens: 9386, cache_creation_input_tokens: 0 },
});
const DELTA_00 = frame({
  type: "message_delta",
  delta: { stop_reason: "max_tokens" },
  usage: { input_tokens: 9300, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});
const STOP = frame({ type: "message_stop" });

function sseFetch(text: string): typeof fetch {
  return vi.fn(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(encoder.encode(text));
          },
        }),
      ),
  ) as unknown as typeof fetch;
}

const SETTINGS: CacheTtlSettings = {
  mode: "auto",
  keepalive: true,
  keepaliveIntervalMs: 240_000,
  keepaliveMinPrefixTokens: 20_000,
};

interface Line {
  provider: string;
  modelId: string;
  baseUrl: string;
}
const KIMI: Line = { provider: "kimi-coding", modelId: "k3", baseUrl: "https://api.kimi.com/coding" };
const RELAY: Line = { provider: "relay-anthropic", modelId: "k3", baseUrl: "https://relay.invalid/anthropic" };
const ANTHROPIC: Line = { provider: "anthropic", modelId: "claude-x", baseUrl: "https://api.anthropic.com" };

const THINKING = { type: "enabled", budget_tokens: 1024 } as const;
function payloadFor(line: Line, thinking: boolean) {
  return {
    model: line.modelId,
    max_tokens: 32_000,
    stream: true,
    ...(thinking ? { thinking: THINKING } : {}),
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
  };
}
function captureFor(line: Line, instance: string, thinking = true): CapturedRequest {
  return {
    sessionId: "s1",
    instance,
    payload: payloadFor(line, thinking),
    fingerprint: {
      sessionId: "s1",
      provider: line.provider,
      api: "anthropic-messages",
      modelId: line.modelId,
      ctxModelId: line.modelId,
      baseUrl: line.baseUrl,
      authHeaderKeys: "",
      breakpointPath: "system.0",
      thinkingDigest: "",
      systemDigest: "",
      toolsDigest: "",
      messageCount: 1,
    },
    shape: { ephemeralBreakpoints: 1, ttl1h: false, hasThinking: thinking, maxTokens: 32_000 },
    prefix: { tokens: 30_000, source: "usage" },
    capturedAt: 0,
  } as CapturedRequest;
}

function harness(line: Line, fetchImpl: typeof fetch, overrides: Partial<CacheKeepaliveDeps> = {}) {
  const clock = new FakeClock(0);
  const pi = fakePiStreamSimple();
  const ctx = {
    ui: { setStatus: vi.fn() },
    mode: "tui",
    model: {
      provider: line.provider,
      api: "anthropic-messages",
      id: line.modelId,
      baseUrl: line.baseUrl,
      headers: {},
      cost: { cacheRead: 0.1, cacheWrite: 1.25, output: 10, tiers: [] },
    },
    modelRegistry: { streamSimple: pi.streamSimple },
    sessionManager: { getSessionId: () => "s1" },
  };
  let self: ReturnType<typeof createCacheKeepaliveService> | undefined;
  const entries: Array<{ type: string; data: Record<string, unknown> }> = [];
  const service = createCacheKeepaliveService({
    clock,
    ctx: ctx as never,
    sessionId: "s1",
    settings: { ...SETTINGS },
    backgroundBusy: () => true,
    isCurrent: (s) => self === s,
    fetchImpl,
    appendEntry: (type: string, data: unknown) => entries.push({ type, data: data as Record<string, unknown> }),
    emit: vi.fn(),
    recoverTransientFailures: true,
    ...overrides,
  });
  self = service;
  const audit = (kind: string) => entries.map((e) => e.data).filter((d) => d.kind === kind);
  return { clock, service, pi, entries, audit };
}
async function flush(times = 60): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}
async function ping(h: ReturnType<typeof harness>, line: Line, thinking = true): Promise<void> {
  h.service.noteRequest(captureFor(line, h.service.instanceId, thinking));
  h.service.noteRequestSettled("s1", h.service.instanceId);
  h.clock.advance(240_000);
  await new Promise<void>((r) => setTimeout(r, 5));
  await flush();
}

describe("late-usage lines — seeded (api.kimi.com)", () => {
  it("clamps max_tokens to 4 on the wire (thinking + everything else verbatim), classifies from message_delta", async () => {
    const h = harness(KIMI, sseFetch(START_00 + DELTA_HIT + STOP));
    await ping(h, KIMI);
    const wire = h.pi.wire[0]!.body as Record<string, unknown>;
    const { max_tokens: wireMax, ...wireRest } = wire;
    const { max_tokens: capMax, ...capRest } = payloadFor(KIMI, true);
    expect(wireMax).toBe(4);
    expect(capMax).toBe(32_000);
    expect(JSON.stringify(wireRest)).toBe(JSON.stringify(capRest));
    expect(wire.thinking).toEqual(THINKING);

    const report = h.service.report();
    expect(report.lateUsage).toBe("seeded");
    expect(report.session.pings).toBe(1);
    expect(report.session.cacheReadTokens).toBe(9386);
    expect(report.lastPingDiagnostics).toMatchObject({
      outcomeKind: "proven-hit",
      cacheReadInputTokens: 9386,
      lateUsage: true,
      usageSource: "message_delta",
    });
    expect(h.audit("proven-hit")[0]).toMatchObject({ usageSource: "message_delta", lateUsage: true });
    expect(h.audit("unproven")).toHaveLength(0);
  });

  it("`/cache-ttl status` text shows `late-usage: seeded` and the usage source", async () => {
    const h = harness(KIMI, sseFetch(START_00 + DELTA_HIT + STOP));
    await ping(h, KIMI);
    const text = renderKeepaliveReportLines(h.service.report()).join("\n");
    expect(text).toContain("late-usage: seeded");
    expect(text).toContain("usage=message_delta");
  });

  it("an already-proving message_start is classified immediately from message_start", async () => {
    const start = frame({
      type: "message_start",
      message: { usage: { input_tokens: 5, cache_read_input_tokens: 9386, cache_creation_input_tokens: 0 } },
    });
    const h = harness(KIMI, sseFetch(start));
    await ping(h, KIMI);
    expect(h.audit("proven-hit")[0]).toMatchObject({ usageSource: "message_start", lateUsage: true });
  });

  it("delta 0/0 ⇒ unproven no-usage with usageSource message_delta (still late-usage, nothing learned)", async () => {
    const h = harness(KIMI, sseFetch(START_00 + DELTA_00 + STOP));
    await ping(h, KIMI);
    expect(h.audit("unproven")[0]).toMatchObject({
      unprovenKind: "no-usage",
      usageSource: "message_delta",
      lateUsage: true,
    });
  });

  it("folds the ping's reported output tokens into the audited cost (costUsd = cache read + output)", async () => {
    const h = harness(KIMI, sseFetch(START_00 + DELTA_HIT + STOP), { reportCost: true });
    await ping(h, KIMI);
    const hit = h.audit("proven-hit")[0]!;
    const expected = (0.1 / 1e6) * 9386 + (10 / 1e6) * 3; // delta reported 3 output tokens
    expect(hit.costUsd as number).toBeCloseTo(expected, 12);
    expect(hit.budgetChargeUsd as number).toBeCloseTo(expected, 12);
  });

  it("without delta output count the max_tokens upper bound (4) is billed", async () => {
    const start = frame({
      type: "message_start",
      message: { usage: { input_tokens: 5, cache_read_input_tokens: 9386, cache_creation_input_tokens: 0 } },
    });
    const h = harness(KIMI, sseFetch(start), { reportCost: true });
    await ping(h, KIMI);
    expect(h.audit("proven-hit")[0]!.budgetChargeUsd as number).toBeCloseTo((0.1 / 1e6) * 9386 + (10 / 1e6) * 4, 12);
  });
});

describe("late-usage lines — ordinary lines are unchanged", () => {
  it("ordinary line: max_tokens:1 (no thinking), cancels at message_start (0/0 ⇒ no-usage), audit has no usageSource/lateUsage", async () => {
    const h = harness(ANTHROPIC, sseFetch(START_00 + DELTA_HIT + STOP));
    await ping(h, ANTHROPIC, false);
    expect((h.pi.wire[0]!.body as Record<string, unknown>).max_tokens).toBe(1);
    expect(h.service.report().lateUsage).toBeUndefined();
    const entry = h.audit("unproven")[0]!;
    expect(entry.unprovenKind).toBe("no-usage");
    expect("usageSource" in entry).toBe(false);
    expect("lateUsage" in entry).toBe(false);
    expect(renderKeepaliveReportLines(h.service.report()).join("\n")).not.toContain("late-usage");
  });
  it("ordinary line with thinking keeps the captured max_tokens (legacy path)", async () => {
    const h = harness(ANTHROPIC, sseFetch(START_00));
    await ping(h, ANTHROPIC, true);
    expect((h.pi.wire[0]!.body as Record<string, unknown>).max_tokens).toBe(32_000);
  });
  it("a non-seeded host without evidence store is NOT late-usage even when its ping saw 0/0 (and never throws)", async () => {
    const h = harness(RELAY, sseFetch(START_00 + DELTA_HIT + STOP));
    await ping(h, RELAY, false);
    h.service.noteUsageCacheRead("s1", h.service.instanceId);
    expect(h.service.report().lateUsage).toBeUndefined();
    expect(h.audit("late-usage-learned")).toHaveLength(0);
  });
});

describe("late-usage lines — learned via provider evidence", () => {
  let dir: string;
  let file: string;
  let store: ProviderEvidenceStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-late-svc-"));
    file = join(dir, "evidence.json");
    store = createProviderEvidenceStore(file);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("ping 0/0 at message_start + NEXT real cacheRead>0 ⇒ persisted `learned`; the next ping runs in late mode", async () => {
    const h = harness(RELAY, sseFetch(START_00 + DELTA_HIT + STOP), { evidence: store });
    h.service.noteRequest(captureFor(RELAY, h.service.instanceId, false)); // sets lastRoute
    await ping(h, RELAY, false);
    expect(h.audit("unproven")[0]).toMatchObject({ unprovenKind: "no-usage" });
    expect(store.hasLateUsageEvidence(RELAY.provider, RELAY.modelId, h.clock.now())).toBe(false);

    h.service.noteUsageCacheRead("s1", h.service.instanceId); // the next real request read the cache
    expect(store.hasLateUsageEvidence(RELAY.provider, RELAY.modelId, h.clock.now())).toBe(true);
    expect(h.audit("late-usage-learned")).toHaveLength(1);
    expect(h.service.report().lateUsage).toBe("learned");
    expect(createProviderEvidenceStore(file).hasLateUsageEvidence(RELAY.provider, RELAY.modelId, 1)).toBe(true);

    // A fresh service (same store file) now pings in late mode on that route.
    const h2 = harness(RELAY, sseFetch(START_00 + DELTA_HIT + STOP), { evidence: createProviderEvidenceStore(file) });
    await ping(h2, RELAY, false);
    expect((h2.pi.wire[0]!.body as Record<string, unknown>).max_tokens).toBe(4);
    expect(h2.audit("proven-hit")[0]).toMatchObject({ usageSource: "message_delta", lateUsage: true });
  });

  it("is a one-shot signal: a second cache read does not re-learn, and nothing is learned without a prior 0/0 ping", async () => {
    const h = harness(RELAY, sseFetch(START_00), { evidence: store });
    h.service.noteRequest(captureFor(RELAY, h.service.instanceId, false));
    h.service.noteUsageCacheRead("s1", h.service.instanceId);
    expect(store.hasLateUsageEvidence(RELAY.provider, RELAY.modelId, 1)).toBe(false);
  });

  it("a successful real request WITHOUT cache usage between the ping and the later read clears the suspicion", async () => {
    const h = harness(RELAY, sseFetch(START_00), { evidence: store });
    h.service.noteRequest(captureFor(RELAY, h.service.instanceId, false));
    await ping(h, RELAY, false);
    h.service.noteRequestSettled(
      "s1",
      h.service.instanceId,
      true,
      { provider: RELAY.provider, modelId: RELAY.modelId },
      100,
      false,
    );
    h.service.noteUsageCacheRead("s1", h.service.instanceId);
    expect(store.hasLateUsageEvidence(RELAY.provider, RELAY.modelId, h.clock.now())).toBe(false);
  });

  it("only a usage object at start with 0/0 counts: an unproven ping that failed otherwise (http 400) learns nothing", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 400 })) as unknown as typeof fetch;
    const h = harness(RELAY, fetchImpl, { evidence: store });
    h.service.noteRequest(captureFor(RELAY, h.service.instanceId, false));
    await ping(h, RELAY, false);
    h.service.noteUsageCacheRead("s1", h.service.instanceId);
    expect(store.hasLateUsageEvidence(RELAY.provider, RELAY.modelId, h.clock.now())).toBe(false);
  });

  it("a late-usage ping's own 0/0 never learns anything (already late)", async () => {
    const h = harness(KIMI, sseFetch(START_00 + DELTA_00 + STOP), { evidence: store });
    h.service.noteRequest(captureFor(KIMI, h.service.instanceId));
    await ping(h, KIMI);
    h.service.noteUsageCacheRead("s1", h.service.instanceId);
    expect(h.audit("late-usage-learned")).toHaveLength(0);
    expect(store.hasLateUsageEvidence(KIMI.provider, KIMI.modelId, h.clock.now())).toBe(false);
  });
});
