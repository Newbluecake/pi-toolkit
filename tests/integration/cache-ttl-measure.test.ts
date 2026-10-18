/** Production cache-ttl command + claim + runner + store + real registry/SDK, per-nonce HTTP cache on FakeClock. */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRegistry, ModelRuntime, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FakeClock, type TimerHandle } from "../../src/core/clock.js";
import { wireCacheTtl } from "../../src/cache-ttl/cache-ttl.js";
import { wireMeasureCommand } from "../../src/cache-ttl/measure-command.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { createMeasureClaim } from "../../src/cache-ttl/measure-claim.js";
import { createMeasureStore } from "../../src/cache-ttl/measure-store.js";
import { MEASURE_TIMING, TTL_GAPS_MS, type MeasureRunRecord } from "../../src/cache-ttl/measure-types.js";
import { resolveCommandPolicy } from "../../src/web-hub/agent/command-policy.js";
import { AnthropicStub } from "../conformance/fixtures/anthropic-stub.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.unstubAllEnvs();
});
class StepClock extends FakeClock {
  readonly due = new Map<number, number>();
  override setTimer(ms: number, fn: () => void): TimerHandle {
    let h!: TimerHandle;
    h = super.setTimer(ms, () => {
      this.due.delete(h.id);
      fn();
    });
    this.due.set(h.id, this.now() + ms);
    return h;
  }
  override clearTimer(h: TimerHandle) {
    this.due.delete(h.id);
    super.clearTimer(h);
  }
  next() {
    const next = Math.min(...this.due.values());
    if (Number.isFinite(next)) this.advance(Math.max(0, next - this.now()));
  }
}
async function tick() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
interface CacheOptions {
  ttl?: number;
  renew?: boolean;
  capacity?: number;
  split?: "detectable" | "undetectable";
  rateLimit?: boolean;
  baseline?: number;
}
async function harness(options: CacheOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "cache-ttl-measure-integration-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  vi.stubEnv("PI_CACHE_RETENTION", "");
  const clock = new StepClock(1792300000000),
    claim = createMeasureClaim();
  const store = createMeasureStore({
    filePath: join(root, "cache-ttl-measurements.json"),
    clock,
    slot: claim.persistSlot,
  });
  const entries = new Map<string, { write: number; touched: number }>();
  const touches: Array<{ at: number; key: string; hit: boolean }> = [];
  const ttl = options.ttl ?? 15 * 60000,
    own = 15000,
    baseline = options.baseline ?? 0;
  const stub = await AnthropicStub.start({
    respond: () => (options.rateLimit ? { kind: "error", status: 429, message: "fixture rate limited" } : undefined),
    reply: (request, index) => {
      const key = /Nonce ([a-f0-9]{24})\./.exec(request.body)?.[1];
      if (!key) throw new Error("synthetic nonce missing");
      const previous = entries.get(key),
        anchor = options.renew === false ? previous?.write : previous?.touched;
      let hit = anchor !== undefined && clock.now() - anchor < ttl;
      // Same-size random shard selection is intentionally not detectable from usage. This
      // fixed-seed first-probe split is a disclosed counterexample, not a TTL conclusion.
      if (options.split === "undetectable" && index === 7) hit = false;
      const cached = hit ? own + baseline : baseline;
      const extra = options.split === "detectable" && index >= 7 ? 1024 : 0;
      entries.delete(key);
      entries.set(key, { write: hit ? previous!.write : clock.now(), touched: clock.now() });
      if (entries.size > (options.capacity ?? Infinity)) entries.delete(entries.keys().next().value!);
      touches.push({ at: clock.now(), key, hit });
      return {
        kind: "text",
        text: "OK",
        usage: {
          input_tokens: extra,
          output_tokens: 0,
          cache_read_input_tokens: cached,
          cache_creation_input_tokens: hit ? 0 : own,
        },
      };
    },
  });
  cleanups.push(() => stub.close());
  writeFileSync(
    join(root, "models.json"),
    JSON.stringify({
      providers: {
        "measure-integration": {
          api: "anthropic-messages",
          baseUrl: stub.baseUrl,
          apiKey: "sk-synthetic",
          models: [
            {
              id: "claude-measure",
              name: "measure",
              api: "anthropic-messages",
              input: ["text"],
              reasoning: false,
              contextWindow: 200000,
              maxTokens: 4096,
              cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            },
          ],
        },
      },
    }),
  );
  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
  });
  const registry = new ModelRegistry(runtime),
    model = registry.find("measure-integration", "claude-measure")!;
  expect(model).toBeDefined();
  const commands = new Map<string, any>(),
    hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const pi = {
    on(name: string, fn: any) {
      hooks.set(name, [...(hooks.get(name) ?? []), fn]);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    model,
    modelRegistry: registry,
    sessionManager: { getSessionId: () => "measurement-integration" },
    ui: { notify: vi.fn(), setStatus: vi.fn(), confirm: vi.fn(async () => true) },
  } as unknown as ExtensionContext;
  wireCacheTtl(pi, DEFAULT_SETTINGS, { measurement: { clock, claim, store } });
  const fire = (name: string, event: Record<string, unknown> = {}) => {
    for (const fn of hooks.get(name) ?? []) fn({ type: name, ...event }, ctx);
  };
  fire("session_start");
  cleanups.push(async () => {
    fire("session_shutdown", { reason: "quit" });
    await store.flush();
  });
  const command = (args: string) => commands.get("cache-ttl").handler(args, ctx) as Promise<void>;
  const text = () =>
    vi
      .mocked(ctx.ui.notify)
      .mock.calls.map(([s]) => s)
      .join("\n");
  const done = () =>
    vi
      .mocked(ctx.ui.notify)
      .mock.calls.some(([s]) =>
        /^ttl-measure (?:complete|partial|failed|no-cache|control-inconclusive|inconclusive)/.test(s),
      );
  async function drive() {
    const end = performance.now() + 8000;
    while (!done() && performance.now() < end) {
      await tick();
      await store.flush();
      if (!done() && claim.physicalPending === 0) {
        await tick();
        clock.next();
      }
    }
    expect(done(), text()).toBe(true);
    await store.flush();
    await tick();
  }
  async function record(): Promise<MeasureRunRecord> {
    const latest = (await store.readRoutes()).find((r) => r.latest)?.latest;
    expect(latest).toBeDefined();
    return latest!;
  }
  return { root, store, clock, claim, stub, ctx, commands, touches, command, text, drive, record };
}

describe("cache TTL measurement end-to-end cache policies", () => {
  it.each([7 * 60000, 15 * 60000])(
    "renewing policy ttl=%i yields true(paired-empirical) with actual interval/deadline eligibility (G-b)",
    async (ttl) => {
      const h = await harness({ ttl, renew: true, baseline: 4096 });
      await h.command("measure --yes");
      await h.drive();
      const record = await h.record(),
        renewal = record.renewal!;
      expect(renewal.renewsOnRead).toBe("true");
      expect(renewal.basis).toBe("paired-empirical");
      expect(renewal.ageRMs![0]).toBeGreaterThanOrEqual(renewal.ceilingMs! + 10000);
      expect(renewal.idleRMs![1] + 10000).toBeLessThan(record.ttl.lowerMs!);
      // The BEFORE-send check budgets a full 30s response uncertainty, not just nominal gap prose.
      expect(renewal.idleRMs![1] + MEASURE_TIMING.perSendDeadlineMs + 10000).toBeLessThan(record.ttl.lowerMs!);
      expect(renewal.touchedGapMs).toBe(ttl === 7 * 60000 ? 360000 : 660000);
      expect(renewal.assumptions).toEqual([
        "same backend class",
        "same eviction pressure",
        "same cache policy across prefixes",
      ]);
      const missIndex = record.samples.findIndex((s) => s.verdict === "miss");
      expect(record.samples.slice(missIndex + 1).every((s) => s.reason === "implied-miss")).toBe(true);
      expect(record.requests.sent).toBe(6 + 1 + missIndex + 1 + 1); // exactly ONE declared post-miss renewal
      expect(record.requests.sent).toBeLessThanOrEqual(17);
      expect(h.stub.requests).toHaveLength(record.requests.sent);
      expect(record.ttl.lowerMs).toBe(renewal.touchedGapMs); // renewal never raises the TTL lower bound
      expect(h.text()).toContain("expiry or eviction");
      expect(h.text()).toContain("known ≈");
      expect(h.text()).toContain("6 prefixes ≈ 90000 cached tokens on one key");
      expect(statSync(h.store.filePath).mode & 0o777).toBe(0o600);
      expect(readFileSync(h.store.filePath, "utf8")).not.toContain("sk-synthetic");
    },
  );
  it("write-anchored policy yields unknown(renewal-miss), never false", async () => {
    const h = await harness({ renew: false });
    await h.command("measure --yes");
    await h.drive();
    const record = await h.record();
    expect(record.renewal?.renewsOnRead).toBe("unknown");
    expect(record.renewal?.reason).toBe("renewal-miss");
    expect(record.renewal?.renewsOnRead).not.toBe("false");
    expect(h.text()).toContain("renewal-miss");
    expect(record.requests.sent).toBeLessThanOrEqual(17);
  });
  it("LRU k=3 misses are labelled expiry-or-eviction, not a proven TTL ceiling", async () => {
    const h = await harness({ ttl: Infinity, capacity: 3 });
    await h.command("measure --yes");
    await h.drive();
    const record = await h.record();
    expect(record.samples[0]!.verdict).toBe("miss");
    expect(record.ttl.lowerMs).toBeUndefined();
    expect(record.ttl.eligible).toBe(false);
    expect(h.text()).toContain("expiry or eviction under this run's load");
    expect(h.text()).toContain("not a TTL ceiling");
    expect(record.renewal?.renewsOnRead).not.toBe("false");
  });
  it("detectable backend split is backend-mismatch and contributes no TTL hit/miss", async () => {
    const h = await harness({ ttl: Infinity, split: "detectable" });
    await h.command("measure --yes");
    await h.drive();
    const record = await h.record();
    expect(record.samples.every((s) => s.verdict === "inconclusive" && s.reason === "backend-mismatch")).toBe(true);
    expect(record.ttl.validHits + record.ttl.validMisses).toBe(0);
    expect(record.status).toBe("partial");
    expect(record.ttl.eligible).toBe(false);
  });
  it("undetectable equal-P shard split produces a wrong-looking miss, explicitly disclosed without false renewal", async () => {
    const h = await harness({ ttl: Infinity, split: "undetectable" });
    await h.command("measure --yes");
    await h.drive();
    const record = await h.record();
    expect(record.samples[0]!.verdict).toBe("miss");
    expect(record.samples[0]!.P).toBe(15000);
    expect(record.samples[0]!.reason).not.toBe("backend-mismatch");
    expect(record.renewal?.renewsOnRead).not.toBe("false");
    expect(h.text()).toContain("same-size backend/key splits can be undetectable");
    expect(h.text()).toContain("No negative renewal conclusion is proven");
  });
  it("429 writes exhaust only the shared two replacements, with ≤17 total POSTs", async () => {
    const h = await harness({ rateLimit: true });
    await h.command("measure --yes");
    await h.drive();
    expect(h.stub.requests).toHaveLength(8);
    expect(h.text()).toContain("failed(unavailable-slots)");
    expect(h.text()).toContain("requests 8/17");
    const nonces = h.stub.requests.map((request) => /Nonce ([a-f0-9]{24})\./.exec(request.body)?.[1]);
    expect(new Set(nonces).size).toBe(8);
    expect(h.claim.state).toBe("free");
  });
  it("61-min slot uses the shifted control anchor; saved status is labelled and has a copyable hint", async () => {
    const h = await harness({ ttl: Infinity });
    await h.command("measure --yes");
    await h.drive();
    const record = await h.record();
    expect(record.samples[5]!.idleMs).toEqual([TTL_GAPS_MS[5], TTL_GAPS_MS[5]]);
    const lastPrefix = h.touches[5]!.key;
    const touches = h.touches.filter((t) => t.key === lastPrefix);
    expect(touches).toHaveLength(3);
    expect(touches[2]!.at - touches[0]!.at).toBe(TTL_GAPS_MS[5] + 30000);
    expect(record.ttl.lowerMs).toBe(TTL_GAPS_MS[5]);
    expect(record.ttl.reachedMaxGap).toBe(true);
    vi.mocked(h.ctx.ui.notify).mockClear();
    await h.command("status");
    expect(h.text()).toContain("learned ttl short ≥61m");
    await h.command("measure status");
    expect(h.text()).toContain("last successful save");
    expect(h.text()).toContain("typical");
    expect(h.text()).toContain("worst case");
    expect(h.text()).not.toContain("known ≈");
    expect(h.text()).toContain("copyable hint: models.json promptCache.short ≈ 3660");
    expect(h.text()).toContain("native CacheWarmer assumes read renewal");
    // Fresh activation reads a persisted labelled result, never guesses the currently authenticated route.
    vi.mocked(h.ctx.ui.notify).mockClear();
    const reloaded = wireMeasureCommand({ on() {} } as unknown as ExtensionAPI, {
      clock: h.clock,
      claim: h.claim,
      store: h.store,
    });
    await reloaded.handle("measure status", h.ctx);
    expect(h.text()).toContain("saved route (not verified as the current authenticated route)");
    expect(h.text()).toContain("copyable hint: models.json promptCache.short ≈ 3660");
    const text = readFileSync(h.store.filePath, "utf8");
    expect(text).not.toContain("measure-integration");
    expect(text).toContain("sha256:");
  });
  it("web rows preserve start/cancel confirmation and permit status/estimate only", () => {
    for (const args of ["measure status", "measure --estimate", "measure CaseProvider/CaseModel --long --estimate"])
      expect(resolveCommandPolicy({ name: "cache-ttl", kind: "extension", args }).policy).toBe("allow");
    for (const args of ["measure --yes", "measure cancel", "measure --bad --estimate"])
      expect(resolveCommandPolicy({ name: "cache-ttl", kind: "extension", args }).policy).toBe("confirm");
  });
});
