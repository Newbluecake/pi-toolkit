import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "../../src/core/clock.js";
import { wireMeasureCommand, measurePriceFor, renderMeasureResult } from "../../src/cache-ttl/measure-command.js";
import { createMeasureClaim } from "../../src/cache-ttl/measure-claim.js";
import { wireCacheTtl } from "../../src/cache-ttl/cache-ttl.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { accountRequestCost, estimateCost } from "../../src/cache-ttl/measure-plan.js";
import type { MeasureStore } from "../../src/cache-ttl/measure-store.js";
import type {
  PipelinePingInput,
  PipelinePingModel,
  SendPipelinePing,
} from "../../src/cache-ttl/pipeline-ping-types.js";
import { P_BOUND_TOKENS, type MeasureRouteRecord } from "../../src/cache-ttl/measure-types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
const model: PipelinePingModel = {
  id: "CaseModel",
  name: "test",
  api: "anthropic-messages",
  provider: "CaseProvider",
  baseUrl: "https://relay.invalid",
  contextWindow: 200000,
  maxTokens: 4096,
  reasoning: false,
  input: ["text"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};
function memoStore(clock: FakeClock): MeasureStore {
  const records = new Map<string, MeasureRouteRecord>();
  let savedAt: number | undefined;
  return {
    filePath: "/test/cache-ttl-measurements.json",
    persistState: "idle",
    get lastSavedAt() {
      return savedAt;
    },
    persist(route, slot, record) {
      const entry = records.get(route.key) ?? { ...route, latest: null, inProgress: null };
      entry[slot] = record ? structuredClone(record) : null;
      records.set(route.key, entry);
      savedAt = clock.now();
    },
    async flush() {},
    async readRoutes() {
      return [...records.values()];
    },
    async readRoute(key) {
      return records.get(key);
    },
    async lookupLearnedTtl() {
      return undefined;
    },
  };
}
function transportFixture(patch: Record<string, unknown> = {}) {
  const sessions = new Set<string>();
  return vi.fn<SendPipelinePing>(async (input) => {
    const m = input.measurement!;
    const build = m.build;
    const user = build?.context.messages.find((x) => x.role === "user");
    let params: Readonly<Record<string, unknown>> = build
      ? {
          model: input.model.id,
          max_tokens: 1,
          stream: true,
          system: [
            {
              type: "text",
              text: build.context.systemPrompt,
              cache_control: { type: "ephemeral", ...(build.cacheRetention === "long" ? { ttl: "1h" } : {}) },
            },
          ],
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: user?.content,
                  cache_control: { type: "ephemeral", ...(build.cacheRetention === "long" ? { ttl: "1h" } : {}) },
                },
              ],
            },
          ],
        }
      : input.body;
    if (build && m.profile !== "anthropic-messages") {
      const common = {
        model: input.model.id,
        stream: true,
        prompt_cache_key: Array.from(input.sessionId).slice(0, 64).join(""),
      };
      params =
        m.profile === "openai-responses"
          ? {
              ...common,
              store: false,
              max_output_tokens: 16,
              input: [
                { role: "system", content: build.context.systemPrompt },
                { role: "user", content: [{ type: "input_text", text: user?.content }] },
              ],
            }
          : {
              ...common,
              max_tokens: 1,
              stream_options: { include_usage: true },
              messages: [
                { role: "system", content: build.context.systemPrompt },
                { role: "user", content: user?.content },
              ],
            };
    }
    Object.assign(params, patch);
    const rejection = build?.validate(params);
    const diag = {
      baseFetchCalls: 0,
      onPayloadCalls: 1,
      sawMessageStart: false,
      explicitSuccess: false,
      piStopReason: undefined,
      httpStatus: undefined,
      bodyBytes: 0,
      wireHeaderNames: [],
      deadlineHit: false,
      durationMs: 0,
    };
    if (rejection)
      return {
        outcome: { kind: "not-sent", reason: "capability", diag, measured: { rejection } },
        settled: Promise.resolve(),
      };
    if (!input.guard())
      return { outcome: { kind: "not-sent", reason: "guard", diag, measured: {} }, settled: Promise.resolve() };
    const route = m.routeKey(
      `https://relay.invalid${m.profile === "anthropic-messages" ? "/v1/messages" : m.profile === "openai-responses" ? "/responses" : "/chat/completions"}`,
    );
    const hit = sessions.has(input.sessionId);
    sessions.add(input.sessionId);
    return {
      outcome: {
        kind: "usage",
        usage: undefined,
        diag: { ...diag, baseFetchCalls: 1, httpStatus: 200 },
        measured: {
          ...(build ? { builtBody: structuredClone(params) } : {}),
          routeKey: route.key,
          routeLabel: route.label,
          sentAt: input.clock.now(),
          headersAt: input.clock.now(),
          rawUsage:
            m.profile === "anthropic-messages"
              ? {
                  input_tokens: 0,
                  cache_read_input_tokens: hit ? 15000 : 0,
                  cache_creation_input_tokens: hit ? 0 : 15000,
                }
              : m.profile === "openai-responses"
                ? {
                    input_tokens: 15000,
                    input_tokens_details: { cached_tokens: hit ? 15000 : 0, cache_write_tokens: hit ? 0 : 15000 },
                    output_tokens: 1,
                  }
                : {
                    prompt_tokens: 15000,
                    prompt_tokens_details: { cached_tokens: hit ? 15000 : 0, cache_write_tokens: hit ? 0 : 15000 },
                    completion_tokens: 1,
                  },
        },
      },
      settled: Promise.resolve(),
    };
  });
}
function setup(
  opts: {
    claim?: ReturnType<typeof createMeasureClaim>;
    store?: MeasureStore;
    clock?: FakeClock;
    transport?: SendPipelinePing;
    confirm?: () => Promise<boolean>;
  } = {},
) {
  const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const commands = new Map<string, any>();
  const pi = {
    on(name: string, handler: any) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  const clock = opts.clock ?? new FakeClock(1792300000000),
    claim = opts.claim ?? createMeasureClaim();
  const store = opts.store ?? memoStore(clock),
    transport = opts.transport ?? transportFixture();
  const ctx = {
    hasUI: true,
    model,
    sessionManager: { getSessionId: () => "session-1" },
    modelRegistry: {
      find: vi.fn(() => model),
      hasConfiguredAuth: vi.fn(() => true),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "sk-synthetic" })),
      isUsingOAuth: vi.fn(() => false),
      streamSimple: vi.fn(),
    },
    ui: { notify: vi.fn(), setStatus: vi.fn(), confirm: vi.fn(opts.confirm ?? (async () => true)) },
  } as unknown as ExtensionContext;
  const deps = { clock, claim, store, transport };
  const port = wireMeasureCommand(pi, deps);
  const fire = (name: string, event: Record<string, unknown> = {}) => {
    for (const fn of hooks.get(name) ?? []) fn({ type: name, ...event }, ctx);
  };
  fire("session_start");
  return {
    pi,
    hooks,
    commands,
    ctx,
    clock,
    claim,
    store,
    transport,
    port,
    fire,
    deps,
    text: () =>
      vi
        .mocked(ctx.ui.notify)
        .mock.calls.map(([s]) => s)
        .join("\n"),
  };
}

describe("measure command admission and lifecycle", () => {
  it("estimate preserves model case, prints one plan and both prices, never sends or asks", async () => {
    const h = setup();
    await h.port.handle("MeAsUrE CaseProvider/CaseModel --EsTiMaTe --LONG", h.ctx);
    expect(h.ctx.modelRegistry.find).toHaveBeenCalledWith("CaseProvider", "CaseModel");
    expect(h.text()).toContain("hard request cap 17");
    expect(h.text()).toMatch(/typical.*worst case/);
    expect(h.text()).toContain("C1");
    expect(h.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.claim.state).toBe("free");
    expect(h.clock.pendingTimers).toBe(0);
  });
  it.each(["measure --oops", "measure --yes --YES", "measure status --long", "measure A/B C/D"])(
    "parse error sends nothing: %s",
    async (args) => {
      const h = setup();
      await h.port.handle(args, h.ctx);
      expect(h.text()).toContain("usage:");
      expect(h.transport).not.toHaveBeenCalled();
    },
  );
  it.each(["headless", "unsupported-api", "copilot", "no-stream", "no-auth", "small-window", "unknown-model"])(
    "admission %s is zero POSTs",
    async (reason) => {
      const h = setup();
      if (reason === "headless") (h.ctx as any).hasUI = false;
      if (reason === "unsupported-api") (h.ctx as any).model = { ...model, api: "openai-codex-responses" };
      if (reason === "copilot") (h.ctx as any).model = { ...model, provider: "github-copilot" };
      if (reason === "no-stream") (h.ctx.modelRegistry as any).streamSimple = undefined;
      if (reason === "no-auth") vi.mocked(h.ctx.modelRegistry.hasConfiguredAuth).mockReturnValue(false);
      if (reason === "small-window") (h.ctx as any).model = { ...model, contextWindow: P_BOUND_TOKENS + 2047 };
      if (reason === "unknown-model") vi.mocked(h.ctx.modelRegistry.find).mockReturnValue(undefined);
      await h.port.handle(reason === "unknown-model" ? "measure Unknown/Model --yes" : "measure --yes", h.ctx);
      expect(h.transport).not.toHaveBeenCalled();
      expect(h.claim.state).toBe("free");
      expect(h.clock.pendingTimers).toBe(0);
      expect(h.text()).toContain("nothing sent");
    },
  );
  it.each([{ max_tokens: 4096 }, { tools: [] }, { thinking: { type: "enabled", budget_tokens: 4096 } }])(
    "actual protected params from a fake build refuse before any POST (%j)",
    async (patch) => {
      const transport = transportFixture(patch);
      const h = setup({ transport });
      await h.port.handle("measure --yes", h.ctx);
      await flush();
      expect(h.text()).toContain("failed(payload:");
      expect(transport).toHaveBeenCalledTimes(1);
      expect((await transport.mock.results[0]!.value).outcome.diag.baseFetchCalls).toBe(0);
      expect(h.claim.state).toBe("free");
    },
  );
  it.each(["openai-responses", "openai-completions"] as const)(
    "P4 binds %s build caps, raw usage and actual prefix cache key",
    async (api) => {
      const h = setup();
      (h.ctx as any).model = { ...model, api };
      await h.port.handle("measure --yes", h.ctx);
      await flush();
      expect(h.claim.current()?.sent).toBe(6);
      const input = vi.mocked(h.transport).mock.calls[0]![0];
      expect(input.measurement?.build?.maxTokens).toBe(api === "openai-responses" ? 16 : 1);
      expect(input.measurement?.expectWireModel).toBe(model.id);
      expect(
        vi
          .mocked(h.transport)
          .mock.calls.slice(1)
          .every(([call]) => !!call.measurement?.expectRouteKey),
      ).toBe(true);
      await h.port.handle("measure cancel", h.ctx);
      await flush();
    },
  );
  it("P4 rejects a sampled Completions cache key that differs from this prefix", async () => {
    const h = setup({ transport: transportFixture({ prompt_cache_key: "wrong-prefix" }) });
    (h.ctx as any).model = { ...model, api: "openai-completions" };
    await h.port.handle("measure --yes", h.ctx);
    await flush();
    expect(h.text()).toContain("failed(payload:prompt-cache-key)");
    expect((await vi.mocked(h.transport).mock.results[0]!.value).outcome.diag.baseFetchCalls).toBe(0);
  });
  it("P4 enriches actual-params validation with the configured opaque budget name", async () => {
    const h = setup({ transport: transportFixture({ opaque_limit: 4096 }) });
    (h.ctx as any).model = {
      ...model,
      api: "openai-completions",
      compat: { thinkingTokenBudgetField: "opaque_limit" },
    };
    await h.port.handle("measure --yes", h.ctx);
    await flush();
    expect(h.text()).toContain("failed(payload:thinking)");
    expect((await vi.mocked(h.transport).mock.results[0]!.value).outcome.diag.baseFetchCalls).toBe(0);
  });
  it("claims preparing before the dialog; a concurrent start is busy; cancel rejects a late affirmative", async () => {
    const answer = deferred<boolean>();
    const h = setup({
      confirm: () => {
        expect(h.claim.state).toBe("preparing");
        return answer.promise;
      },
    });
    const first = h.port.handle("measure", h.ctx);
    await flush();
    const dialog = vi.mocked(h.ctx.ui.confirm).mock.calls[0]!;
    expect(dialog[1]).toContain("/reload, /new, /resume, fork or exit cancel the run");
    expect(dialog[1]).toContain("in the extreme, the whole run");
    expect(dialog[2]?.timeout).toBe(60000);
    await h.port.handle("measure --yes", h.ctx);
    expect(h.text()).toContain("busy");
    await h.port.handle("measure cancel", h.ctx);
    answer.resolve(true);
    await first;
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.claim.state).toBe("free");
    expect(h.clock.pendingTimers).toBe(0);
  });
  it("confirm times out at 60s and aborts the UI dialog without a send", async () => {
    const answer = deferred<boolean>();
    const h = setup({ confirm: () => answer.promise });
    const pending = h.port.handle("measure", h.ctx);
    await flush();
    h.clock.advance(60000);
    await pending;
    expect(h.text()).toContain("re-run with --yes");
    expect(vi.mocked(h.ctx.ui.confirm).mock.calls[0]![2]?.signal?.aborted).toBe(true);
    expect(h.transport).not.toHaveBeenCalled();
    expect(h.clock.pendingTimers).toBe(0);
  });
  it.each(["quit", "reload", "new", "resume", "fork"])(
    "shutdown %s revokes a pending confirm and suppresses late callbacks",
    async (reason) => {
      const answer = deferred<boolean>();
      const h = setup({ confirm: () => answer.promise });
      const pending = h.port.handle("measure", h.ctx);
      await flush();
      h.fire("session_shutdown", { reason });
      const count = vi.mocked(h.ctx.ui.notify).mock.calls.length;
      answer.resolve(true);
      await pending;
      expect(h.claim.state).toBe("free");
      expect(h.transport).not.toHaveBeenCalled();
      expect(h.ctx.ui.notify).toHaveBeenCalledTimes(count);
      expect(h.clock.pendingTimers).toBe(0);
    },
  );
  it("running status has next/save information but never spending; cancel stops timers", async () => {
    const h = setup();
    await h.port.handle("measure --yes", h.ctx);
    await flush();
    expect(h.claim.current()?.sent).toBe(6);
    expect(await h.port.statusLine(h.ctx)).toContain("ttl-measure running");
    vi.mocked(h.ctx.ui.notify).mockClear();
    await h.port.handle("measure status", h.ctx);
    expect(h.text()).toContain("hard request cap 17");
    expect(h.text()).toContain("last successful save");
    expect(h.text()).not.toContain("known ≈");
    await h.port.handle("measure cancel", h.ctx);
    await flush();
    expect(h.claim.state).toBe("free");
    expect(h.clock.pendingTimers).toBe(0);
  });
  it("stalled physical IO survives shutdown/re-activation as busy(io-pending), without old UI callbacks", async () => {
    const physical = deferred<void>();
    const normal = transportFixture();
    const transport = vi.fn<SendPipelinePing>(async (input) => ({
      ...(await normal(input)),
      settled: physical.promise,
    }));
    const old = setup({ transport });
    await old.port.handle("measure --yes", old.ctx);
    await flush();
    expect(old.claim.physicalPending).toBe(1);
    old.fire("session_shutdown", { reason: "reload" });
    expect(old.claim.state).toBe("draining");
    const oldCount = vi.mocked(old.ctx.ui.notify).mock.calls.length;
    const fresh = setup({ claim: old.claim, store: old.store, clock: old.clock });
    await fresh.port.handle("measure --yes", fresh.ctx);
    expect(fresh.text()).toContain("busy(io-pending)");
    expect(await fresh.port.statusLine(fresh.ctx)).toContain("io-pending");
    physical.resolve();
    await flush();
    expect(old.claim.state).toBe("free");
    expect(old.ctx.ui.notify).toHaveBeenCalledTimes(oldCount);
    expect(old.clock.pendingTimers).toBe(0);
  });
  it("raw cache-ttl branch and measure flag completion integrate without lowercasing refs", async () => {
    const h = setup();
    wireCacheTtl(h.pi, DEFAULT_SETTINGS, { measurement: h.deps });
    const command = h.commands.get("cache-ttl");
    await command.handler("measure CaseProvider/CaseModel --estimate", h.ctx);
    expect(h.ctx.modelRegistry.find).toHaveBeenCalledWith("CaseProvider", "CaseModel");
    expect(command.getArgumentCompletions("measure --").map((x: any) => x.value)).toContain("measure --yes");
    await command.handler("status", h.ctx);
    expect(h.text()).toContain("ttl-measure idle");
  });
  it("cache-ttl status suppresses a late store read after session shutdown", async () => {
    const h = setup();
    const read = deferred<readonly MeasureRouteRecord[]>();
    vi.spyOn(h.store, "readRoutes").mockReturnValue(read.promise);
    wireCacheTtl(h.pi, DEFAULT_SETTINGS, { measurement: h.deps });
    const pending = h.commands.get("cache-ttl").handler("status", h.ctx);
    await flush();
    h.fire("session_shutdown", { reason: "new" });
    const count = vi.mocked(h.ctx.ui.notify).mock.calls.length;
    read.resolve([]);
    await pending;
    expect(h.ctx.ui.notify).toHaveBeenCalledTimes(count);
  });
  it("child sessions cannot reach cache-ttl wiring (post HOST_KEY guard)", () => {
    const source = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
    expect(source.indexOf("if (g[HOST_KEY]) return;")).toBeGreaterThan(0);
    expect(source.indexOf("wireCacheTtl(pi")).toBeGreaterThan(source.indexOf("if (g[HOST_KEY]) return;"));
  });
  it("headless invocation naturally exits a real Node process without timers", () => {
    const script = `import { wireMeasureCommand } from './src/cache-ttl/measure-command.ts'; const port=wireMeasureCommand({on(){}}); await port.handle('measure --yes',{hasUI:false, sessionManager:{getSessionId(){return 'print'}},ui:{notify(){},setStatus(){}}}); console.log('EXIT-OK');`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      timeout: 6000,
      encoding: "utf8",
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("EXIT-OK");
  });
});

describe("registry calculateCost adapter and tier integration fixes", () => {
  it("uses the request total prompt tier for prompt, known output and unknown output", () => {
    const tiered = {
      ...model,
      cost: {
        ...model.cost,
        tiers: [{ inputTokensAbove: 18000, input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 }],
      },
    };
    const price = measurePriceFor(tiered);
    expect(price({ input: 1000, cacheRead: 18000, cacheWrite: 0, output: 1 })).toBeCloseTo(
      (6000 + 10800 + 30) / 1e6,
      12,
    );
    const estimate = estimateCost(price, "anthropic-messages", "short");
    expect(estimate.conditionalWorstUsd).toBeCloseTo((17 * (P_BOUND_TOKENS * 7.5 + 30)) / 1e6, 10);
    const cost = accountRequestCost({
      api: "anthropic-messages",
      requestedRetention: "short",
      outputCap: 1,
      sent: true,
      price,
      pBound: P_BOUND_TOKENS,
      reading: {
        usage: { P: 19000, C: 18000, W: 0 },
        cacheEvidence: { kind: "valid" },
        billing: { kind: "unknown", items: ["output"] },
      },
    });
    expect(cost.unknownUsd?.[1]).toBeCloseTo(30 / 1e6, 12);
    const writePremium = accountRequestCost({
      api: "openai-responses",
      requestedRetention: "short",
      outputCap: 16,
      sent: true,
      price,
      pBound: P_BOUND_TOKENS,
      reading: {
        usage: { P: 19000, C: 18000, output: 1 },
        cacheEvidence: { kind: "valid" },
        billing: { kind: "unknown", items: ["write"] },
      },
    });
    expect(writePremium.unknownUsd?.[1]).toBeCloseTo((1000 * (7.5 - 6)) / 1e6, 12);
  });
  it("1h writes use 2× the selected tier's input rate; 0/missing rates are unknown, not free", () => {
    const price = measurePriceFor(model);
    expect(price({ input: 0, cacheRead: 0, cacheWrite: 15000, cacheWrite1h: 15000, output: 0 })).toBeCloseTo(0.09, 12);
    const unpriced = measurePriceFor({ ...model, cost: { ...model.cost, output: 0 } });
    expect(unpriced({ input: 0, cacheRead: 0, cacheWrite: 0, output: 1 })).toBeUndefined();
    expect(estimateCost(unpriced, "anthropic-messages", "short").conditionalWorstUsd).toBeNull();
  });
});
