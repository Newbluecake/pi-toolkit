/**
 * Late-usage lines (plan.md 2026-10-20): pure units — payload clamp, seed list, scanner state machine,
 * delta-usage merge, and the provider-evidence `lateUsageAt` flag.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LATE_USAGE_PING_MAX_TOKENS,
  LATE_USAGE_SCAN_LIMIT_BYTES,
  LATE_USAGE_SEED_HOSTS,
  createLateUsageScanner,
  isSeededLateUsageBaseUrl,
  mergeDeltaUsage,
  prepareLatePingPayload,
} from "../../src/cache-ttl/late-usage.js";
import { classifyUsage, preparePingPayload, PING_SCAN_LIMIT_BYTES } from "../../src/cache-ttl/ping-client.js";
import {
  createProviderEvidenceStore,
  PROVIDER_EVIDENCE_TTL_MS,
  WRITE1H_REFRESH_MIN_INTERVAL_MS,
  type ProviderEvidenceStore,
} from "../../src/cache-ttl/provider-evidence.js";
import { outputCostUsd } from "../../src/cache-ttl/keepalive-state.js";

const start = (usage: Record<string, unknown> | undefined) => ({
  type: "message_start",
  message: usage === undefined ? {} : { usage },
});
const delta = (usage: Record<string, unknown> | undefined) => ({
  type: "message_delta",
  delta: { stop_reason: "max_tokens" },
  ...(usage === undefined ? {} : { usage }),
});

describe("late-usage constants and seed", () => {
  it("pins the measured constants and a small host seed list", () => {
    expect(LATE_USAGE_PING_MAX_TOKENS).toBe(4);
    expect(LATE_USAGE_SCAN_LIMIT_BYTES).toBeGreaterThan(PING_SCAN_LIMIT_BYTES);
    expect(LATE_USAGE_SCAN_LIMIT_BYTES).toBeLessThanOrEqual(1024 * 1024);
    expect(LATE_USAGE_SEED_HOSTS).toEqual(["api.kimi.com"]);
  });
  it("seeds on the exact baseUrl host only", () => {
    expect(isSeededLateUsageBaseUrl("https://api.kimi.com/coding")).toBe(true);
    expect(isSeededLateUsageBaseUrl("https://API.KIMI.COM/coding/")).toBe(true);
    expect(isSeededLateUsageBaseUrl("https://api.anthropic.com")).toBe(false);
    expect(isSeededLateUsageBaseUrl("https://evil.example/api.kimi.com")).toBe(false);
    expect(isSeededLateUsageBaseUrl("https://api.kimi.com.evil.example")).toBe(false);
    expect(isSeededLateUsageBaseUrl("not a url")).toBe(false);
    expect(isSeededLateUsageBaseUrl("")).toBe(false);
  });
});

describe("prepareLatePingPayload — max_tokens clamp", () => {
  const base = {
    model: "k3",
    stream: true,
    thinking: { type: "enabled", budget_tokens: 1024 },
    system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
  };
  it("clamps a larger captured max_tokens to 4 and replays everything else verbatim (thinking untouched)", () => {
    const captured = { ...base, max_tokens: 4096 };
    const body = prepareLatePingPayload(captured);
    expect(body.max_tokens).toBe(4);
    const { max_tokens: _a, ...restBody } = body;
    const { max_tokens: _b, ...restCaptured } = captured;
    expect(restBody).toEqual(restCaptured);
    expect(JSON.stringify(restBody)).toBe(JSON.stringify(restCaptured)); // key order / bytes identical
    expect(body.thinking).toBe(captured.thinking); // same reference: never rebuilt
    expect(captured.max_tokens).toBe(4096); // capture never mutated
  });
  it("keeps a smaller captured value (3 → 3, 4 → 4) and never sends 1", () => {
    expect(prepareLatePingPayload({ ...base, max_tokens: 3 }).max_tokens).toBe(3);
    expect(prepareLatePingPayload({ ...base, max_tokens: 4 }).max_tokens).toBe(4);
    expect(prepareLatePingPayload({ ...base, max_tokens: 1 }).max_tokens).toBe(2);
    expect(prepareLatePingPayload({ ...base, max_tokens: 0 }).max_tokens).toBe(2);
  });
  it("leaves a missing / non-numeric max_tokens untouched", () => {
    expect("max_tokens" in prepareLatePingPayload(base)).toBe(false);
    expect(prepareLatePingPayload({ ...base, max_tokens: "big" }).max_tokens).toBe("big");
  });
  it("differs from the ordinary path, which still forces max_tokens:1 without thinking (non-late unchanged)", () => {
    const plain = { model: "m", stream: true, max_tokens: 4096, messages: [] };
    expect(preparePingPayload(plain).max_tokens).toBe(1);
    expect(prepareLatePingPayload(plain).max_tokens).toBe(4);
    // with active thinking the ordinary path leaves max_tokens as captured
    expect(preparePingPayload({ ...base, max_tokens: 4096 }).max_tokens).toBe(4096);
  });
});

describe("mergeDeltaUsage", () => {
  const s = {
    inputTokens: 9300,
    outputTokens: 1,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: undefined as number | undefined,
  };
  it("present delta counters override the start's (Anthropic cumulative semantics)", () => {
    expect(mergeDeltaUsage(s, delta({ input_tokens: 0, output_tokens: 4, cache_read_input_tokens: 9386 }))).toEqual({
      inputTokens: 0,
      outputTokens: 4,
      cacheRead: 9386,
      cacheWrite: 0,
      cacheWrite1h: undefined,
    });
  });
  it("absent / null counters keep the start's value; the 1h split is taken from the delta when present", () => {
    expect(
      mergeDeltaUsage(
        { ...s, cacheWrite: 5 },
        delta({ output_tokens: 2, cache_read_input_tokens: null, cache_creation: { ephemeral_1h_input_tokens: 5 } }),
      ),
    ).toEqual({ inputTokens: 9300, outputTokens: 2, cacheRead: 0, cacheWrite: 5, cacheWrite1h: 5 });
  });
  it("has no usage ⇒ undefined; a start-less merge starts from zeros", () => {
    expect(mergeDeltaUsage(s, delta(undefined))).toBeUndefined();
    expect(mergeDeltaUsage(undefined, delta({ cache_read_input_tokens: 7 }))).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 7,
      cacheWrite: 0,
      cacheWrite1h: undefined,
    });
  });
});

describe("createLateUsageScanner", () => {
  it("start 0/0 then delta read>0 ⇒ proven-hit from message_delta", () => {
    const sc = createLateUsageScanner();
    expect(sc.feed(start({ input_tokens: 9300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }))).toBe(
      undefined,
    );
    expect(sc.feed({ type: "content_block_start" })).toBeUndefined();
    const done = sc.feed(delta({ input_tokens: 0, output_tokens: 4, cache_read_input_tokens: 9386 }));
    expect(done?.source).toBe("message_delta");
    expect(classifyUsage(done?.usage)).toEqual({ kind: "proven-hit", cacheReadTokens: 9386, inputTokens: 0 });
  });
  it("a start that already proves a hit/write ends immediately from message_start", () => {
    const hit = createLateUsageScanner().feed(start({ input_tokens: 3, cache_read_input_tokens: 500 }));
    expect(hit?.source).toBe("message_start");
    expect(classifyUsage(hit?.usage).kind).toBe("proven-hit");
    const write = createLateUsageScanner().feed(start({ input_tokens: 3, cache_creation_input_tokens: 500 }));
    expect(write?.source).toBe("message_start");
    expect(classifyUsage(write?.usage).kind).toBe("proven-write");
  });
  it("delta missing before message_stop ⇒ no-usage from the start numbers", () => {
    const sc = createLateUsageScanner();
    sc.feed(start({ input_tokens: 9300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
    expect(sc.feed(delta(undefined))).toBeUndefined(); // a delta WITHOUT usage keeps reading
    const done = sc.feed({ type: "message_stop" });
    expect(done?.source).toBe("message_start");
    expect(classifyUsage(done?.usage)).toEqual({ kind: "no-usage" });
  });
  it("start without a usage object ⇒ no-usage at message_stop; a delta may still prove it", () => {
    const a = createLateUsageScanner();
    a.feed(start(undefined));
    expect(classifyUsage(a.feed({ type: "message_stop" })?.usage).kind).toBe("no-usage");
    const b = createLateUsageScanner();
    b.feed(start(undefined));
    expect(classifyUsage(b.feed(delta({ cache_read_input_tokens: 10 }))?.usage).kind).toBe("proven-hit");
  });
  it("delta 0/0 is the final word (no-usage, source message_delta)", () => {
    const sc = createLateUsageScanner();
    sc.feed(start({ input_tokens: 9, cache_read_input_tokens: 0 }));
    const done = sc.feed(delta({ output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
    expect(done?.source).toBe("message_delta");
    expect(classifyUsage(done?.usage).kind).toBe("no-usage");
  });
  it("ignores delta/stop before any message_start and non-object events", () => {
    const sc = createLateUsageScanner();
    expect(sc.feed(delta({ cache_read_input_tokens: 5 }))).toBeUndefined();
    expect(sc.feed({ type: "message_stop" })).toBeUndefined();
    expect(sc.feed(null)).toBeUndefined();
    expect(sc.feed("x")).toBeUndefined();
    expect(sc.sawStart).toBe(false);
  });
});

describe("outputCostUsd", () => {
  it("prices output tokens at the tier chosen by the request size; unknown/zero rate ⇒ undefined", () => {
    const cost = { output: 10, tiers: [{ inputTokensAbove: 200_000, output: 20 }] };
    expect(outputCostUsd(cost, 4, 30_000)).toBeCloseTo((10 / 1e6) * 4, 12);
    expect(outputCostUsd(cost, 4, 300_000)).toBeCloseTo((20 / 1e6) * 4, 12);
    expect(outputCostUsd({}, 4, 1)).toBeUndefined();
    expect(outputCostUsd({ output: 0 }, 4, 1)).toBeUndefined();
    expect(outputCostUsd(undefined, 4, 1)).toBeUndefined();
    expect(outputCostUsd(cost, 0, 1)).toBeUndefined();
  });
});

describe("provider-evidence lateUsageAt (learned late-usage flag)", () => {
  let dir: string;
  let file: string;
  let store: ProviderEvidenceStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-late-"));
    file = join(dir, "evidence.json");
    store = createProviderEvidenceStore(file);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("starts absent, persists across store instances, and is per route", () => {
    expect(store.hasLateUsageEvidence("p", "m", 1_000)).toBe(false);
    store.noteLateUsage("p", "m", 1_000);
    expect(store.hasLateUsageEvidence("p", "m", 2_000)).toBe(true);
    expect(store.hasLateUsageEvidence("p", "other", 2_000)).toBe(false);
    expect(createProviderEvidenceStore(file).hasLateUsageEvidence("p", "m", 2_000)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).routes["p\u0000m"].lateUsageAt).toBe(1_000);
  });
  it("expires after the rolling 30d TTL and a read-only view reports no record afterwards", () => {
    store.noteLateUsage("p", "m", 1_000);
    expect(store.hasLateUsageEvidence("p", "m", 1_000 + PROVIDER_EVIDENCE_TTL_MS - 1)).toBe(true);
    expect(store.hasLateUsageEvidence("p", "m", 1_000 + PROVIDER_EVIDENCE_TTL_MS)).toBe(false);
    expect(store.readRoute("p", "m", 1_000 + PROVIDER_EVIDENCE_TTL_MS)).toBeUndefined();
  });
  it("rate-limits refreshes (daily) and refreshes after the interval", () => {
    store.noteLateUsage("p", "m", 1_000);
    store.noteLateUsage("p", "m", 5_000); // inside the refresh interval ⇒ unchanged
    expect(store.readRoute("p", "m", 6_000)?.lateUsageAt).toBe(1_000);
    store.noteLateUsage("p", "m", 1_000 + WRITE1H_REFRESH_MIN_INTERVAL_MS);
    expect(store.readRoute("p", "m", 1_000 + WRITE1H_REFRESH_MIN_INTERVAL_MS)?.lateUsageAt).toBe(
      1_000 + WRITE1H_REFRESH_MIN_INTERVAL_MS,
    );
  });
  it("ignores empty ids, tolerates a corrupt flag value, and never throws on a corrupt file", () => {
    store.noteLateUsage("", "m", 1);
    store.noteLateUsage("p", "", 1);
    expect(store.hasLateUsageEvidence("", "m", 2)).toBe(false);
    writeFileSync(file, JSON.stringify({ version: 1, routes: { "p\u0000m": { lateUsageAt: "yesterday" } } }));
    expect(createProviderEvidenceStore(file).hasLateUsageEvidence("p", "m", 2)).toBe(false);
    writeFileSync(file, "{not json");
    const fresh = createProviderEvidenceStore(file);
    expect(fresh.hasLateUsageEvidence("p", "m", 2)).toBe(false);
    fresh.noteLateUsage("p", "m", 3);
    expect(fresh.hasLateUsageEvidence("p", "m", 4)).toBe(true);
  });
});
