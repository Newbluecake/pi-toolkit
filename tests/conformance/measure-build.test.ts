/** P4 — real pi ModelRegistry + real Anthropic SDK + local HTTP stub, over the production command/runner. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime, ModelRegistry, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FakeClock, type TimerHandle } from "../../src/core/clock.js";
import { wireMeasureCommand } from "../../src/cache-ttl/measure-command.js";
import { createMeasureClaim } from "../../src/cache-ttl/measure-claim.js";
import { createMeasureStore } from "../../src/cache-ttl/measure-store.js";
import { sendPipelinePing } from "../../src/cache-ttl/pipeline-ping.js";
import { P_BOUND_TOKENS } from "../../src/cache-ttl/measure-types.js";
import type { PipelinePingResult, SendPipelinePing } from "../../src/cache-ttl/pipeline-ping-types.js";
import { AnthropicStub, type AnthropicStubOptions, type StubRequest } from "./fixtures/anthropic-stub.js";

const cleanups: Array<() => void | Promise<void>> = [];

/**
 * pi-ai ≥1.3 (anthropic-messages buildParams `thinkingDisabled` branch) builds
 * `thinking:{type:"disabled"}` for a supportsMidConvoEffort reasoning model when the
 * request runs with thinking off (streamSimple without `reasoning`); pi ≤1.2 built the
 * adaptive + output_config + trailing-effort-message shape for the same call. Both are
 * stock — the exact expectation below follows the INSTALLED pi-ai, never a version
 * branch in product code (I14 is about src/; this file pins the installed dependency).
 */
const PI_AI_VERSION = (
  JSON.parse(
    readFileSync(new URL("../../node_modules/@earendil-works/pi-ai/package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;
const MANAGED_THINKING_OFF_DISABLED = (() => {
  const [major, minor] = PI_AI_VERSION.split(".").map((n) => Number.parseInt(n, 10));
  return (major ?? 0) > 1 || ((major ?? 0) === 1 && (minor ?? 0) >= 3);
})();
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
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
    const at = Math.min(...this.due.values());
    if (Number.isFinite(at)) this.advance(Math.max(0, at - this.now()));
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function tick() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
async function until(check: () => boolean, text: string) {
  const end = performance.now() + 5000;
  while (!check() && performance.now() < end) await tick();
  expect(check(), text).toBe(true);
}
function nonce(request: StubRequest) {
  return /Nonce ([a-f0-9]{24})\./.exec(request.body)?.[1] ?? "no-nonce";
}
async function environment(
  options: {
    oauth?: boolean;
    managed?: boolean;
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null>;
    sampling?: Record<string, unknown>;
    compat?: Record<string, unknown>;
    total?: number;
    baseline?: number;
    respond?: AnthropicStubOptions["respond"];
    fetchImpl?: typeof fetch;
    confirm?: () => Promise<boolean>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "measure-build-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  vi.stubEnv("PI_CACHE_RETENTION", "");
  const clock = new StepClock(1792300000000),
    seen = new Set<string>();
  const stub = await AnthropicStub.start({
    respond: options.respond,
    reply: (request) => {
      const key = nonce(request),
        hit = seen.has(key);
      seen.add(key);
      const total = options.total ?? 15000;
      const C = hit ? total : (options.baseline ?? 0);
      return {
        kind: "text",
        text: "OK",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: C,
          cache_creation_input_tokens: total - C,
        },
      };
    },
  });
  cleanups.push(() => stub.close());
  const provider = "measure-anthropic",
    id = "claude-measure";
  writeFileSync(
    join(root, "models.json"),
    JSON.stringify({
      providers: {
        [provider]: {
          api: "anthropic-messages",
          baseUrl: stub.baseUrl,
          apiKey: options.oauth ? "sk-ant-oat01-synthetic-measure-token" : "sk-synthetic",
          models: [
            {
              id,
              name: "measure",
              api: "anthropic-messages",
              input: ["text"],
              reasoning: options.reasoning ?? false,
              ...(options.thinkingLevelMap ? { thinkingLevelMap: options.thinkingLevelMap } : {}),
              contextWindow: 200000,
              maxTokens: 4096,
              cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
              compat: { supportsMidConvoEffort: options.managed ?? false, ...options.compat },
              ...(options.sampling ? { samplingParams: options.sampling } : {}),
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
  const registry = new ModelRegistry(runtime);
  expect(registry.getError()).toBeUndefined();
  const model = registry.find(provider, id)!;
  expect(model).toBeDefined();
  const claim = createMeasureClaim(),
    store = createMeasureStore({ filePath: join(root, "measure.json"), clock, slot: claim.persistSlot });
  const hooks = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const pi = {
    on(name: string, handler: any) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    model,
    modelRegistry: registry,
    sessionManager: { getSessionId: () => "real-measure" },
    ui: { notify: vi.fn(), setStatus: vi.fn(), confirm: vi.fn(options.confirm ?? (async () => true)) },
  } as unknown as ExtensionContext;
  const results: PipelinePingResult[] = [];
  const transport: SendPipelinePing = async (input) => {
    const result = await sendPipelinePing(input);
    results.push(result);
    return result;
  };
  const deps = { claim, store, clock, transport, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) };
  const port = wireMeasureCommand(pi, deps);
  const fire = (name: string, event: Record<string, unknown> = {}) => {
    for (const fn of hooks.get(name) ?? []) fn({ type: name, ...event }, ctx);
  };
  fire("session_start");
  cleanups.push(async () => {
    fire("session_shutdown", { reason: "quit" });
    await store.flush();
  });
  const text = () =>
    vi
      .mocked(ctx.ui.notify)
      .mock.calls.map(([s]) => s)
      .join("\n");
  const done = () =>
    vi
      .mocked(ctx.ui.notify)
      .mock.calls.some(([s]) =>
        /^ttl-measure (?:failed|complete|partial|cancelled|no-cache|control-inconclusive|inconclusive)/.test(s),
      );
  async function drive(stop: () => boolean = done) {
    const end = performance.now() + 6000;
    while (!stop() && performance.now() < end) {
      await tick();
      await store.flush();
      if (!stop() && claim.physicalPending === 0) {
        await tick();
        clock.next();
      }
    }
    expect(stop(), text()).toBe(true);
  }
  return { root, stub, clock, claim, store, port, ctx, deps, fire, results, text, done, drive, registry, model };
}

// No live endpoint is called; G-c still needs explicit user-approved acceptance on the actual relay.
describe("measure P4 real Anthropic build conformance", () => {
  it("OAuth identity is exact and replay bytes are identical on slot 5's control", async () => {
    const h = await environment({ oauth: true });
    await h.port.handle("measure --yes", h.ctx);
    await until(
      () => h.stub.requests.length === 6 && h.claim.physicalPending === 0 && h.claim.current()?.nextKind === "control",
      "six writes complete",
    );
    await h.store.flush();
    h.clock.advance(30000);
    await until(() => h.stub.requests.length === 7 && h.claim.physicalPending === 0, "control complete");
    const first = h.stub.requests[5]!,
      replay = h.stub.requests[6]!;
    expect((first.json.system as Array<{ text: string }>)[0]!.text).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
    expect(replay.body).toBe(first.body);
    expect(first.json.max_tokens).toBe(1);
    expect(h.results[5]!.outcome.measured!.builtBody).toBeDefined();
  });
  it("stock managed-effort adaptive thinking and empty effort system message keep max_tokens=1", async () => {
    const h = await environment({ managed: true });
    await h.port.handle("measure --yes", h.ctx);
    await until(
      () => h.stub.requests.length === 6 && h.claim.physicalPending === 0 && h.claim.current()?.nextKind === "control",
      "managed writes complete",
    );
    const wire = h.stub.requests[0]!.json;
    expect(wire.thinking).toMatchObject({
      type: "adaptive",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    });
    expect(wire.max_tokens).toBe(1);
    expect((wire.messages as unknown[]).at(-1)).toEqual({
      role: "system",
      content: [],
      output_config: { effort: "high" },
    });
  });
  it("pi-ai 1.2 Anthropic IGNORES model samplingParams: actual built/wire params remain safe, byte-for-byte", async () => {
    const h = await environment({
      sampling: { max_tokens: 4096, tools: [{ name: "injected" }], thinking: { type: "enabled", budget_tokens: 4096 } },
    });
    await h.port.handle("measure --yes", h.ctx);
    await until(
      () => h.stub.requests.length === 6 && h.claim.physicalPending === 0 && h.claim.current()?.nextKind === "control",
      "ignored-sampling writes complete",
    );
    for (const [index, request] of h.stub.requests.entries()) {
      const built = h.results[index]!.outcome.measured!.builtBody!;
      const { betas: _betas, ...wire } = built;
      expect(request.body).toBe(JSON.stringify(wire));
      expect(request.json.max_tokens).toBe(1);
      expect(request.json).not.toHaveProperty("tools");
      expect(request.json).not.toHaveProperty("thinking");
    }
    expect(h.text()).not.toContain("failed(payload:");
  });
  it("--long without supportsLongCacheRetention refuses before the first POST", async () => {
    const h = await environment({ compat: { supportsLongCacheRetention: false } });
    await h.port.handle("measure --long --yes", h.ctx);
    await h.drive();
    expect(h.text()).toContain("failed(payload:long-unsupported)");
    expect(h.stub.requests).toHaveLength(0);
    expect(h.results[0]!.outcome.diag.baseFetchCalls).toBe(0);
  });
  it("307 is never followed and fails redirect after exactly one POST", async () => {
    const h = await environment({
      respond: () => ({
        kind: "error",
        status: 307,
        message: "redirect refused",
        headers: { location: "/must-not-follow" },
      }),
    });
    await h.port.handle("measure --yes", h.ctx);
    await h.drive();
    expect(h.stub.requests).toHaveLength(1);
    expect(h.text()).toContain("failed(redirect)");
  });
  it("accepted-then-dropped write burns its nonce; the replacement has a fresh prefix", async () => {
    const h = await environment({
      respond: (_request, index) => (index === 0 ? { kind: "drop-after-headers" } : undefined),
    });
    await h.port.handle("measure --yes", h.ctx);
    await until(() => h.stub.requests.length >= 7 && h.claim.physicalPending === 0, "replacement plus writes finish");
    expect(nonce(h.stub.requests[1]!)).not.toBe(nonce(h.stub.requests[0]!));
    expect(h.stub.requests[1]!.body).not.toBe(h.stub.requests[0]!.body);
  });
  it("an authenticated replay URL change is failed(route), with no second-route POST", async () => {
    const h = await environment();
    // A provider-side route adjustment BEFORE the production wrapped fetch. The real registry,
    // auth, builder and SDK remain in use; changing only a base-fetch test seam would be too late.
    const registry = h.ctx.modelRegistry;
    const original = registry.streamSimple.bind(registry);
    let calls = 0;
    vi.spyOn(registry, "streamSimple").mockImplementation((selected, context, options) => {
      const changed = ++calls > 6;
      return original(selected, context, {
        ...options,
        fetch: (request, init) => {
          const target = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
          return options!.fetch!(changed ? target.replace("/v1/messages", "/changed/v1/messages") : request, init);
        },
      });
    });
    await h.port.handle("measure --yes", h.ctx);
    await until(
      () => h.stub.requests.length === 6 && h.claim.physicalPending === 0 && h.claim.current()?.nextKind === "control",
      "writes done",
    );
    await h.store.flush();
    h.clock.advance(30000);
    await h.drive();
    expect(h.stub.requests).toHaveLength(6);
    expect(h.text()).toContain("failed(route)");
    expect(h.results.at(-1)!.outcome).toMatchObject({ kind: "not-sent", measured: { routeMismatch: true } });
  });
  it("shutdown during confirm frees the claim and a late confirmation sends nothing", async () => {
    const answer = deferred<boolean>();
    const h = await environment({ confirm: () => answer.promise });
    const pending = h.port.handle("measure", h.ctx);
    await until(() => vi.mocked(h.ctx.ui.confirm).mock.calls.length === 1, "confirm opened");
    h.fire("session_shutdown", { reason: "reload" });
    const count = vi.mocked(h.ctx.ui.notify).mock.calls.length;
    answer.resolve(true);
    await pending;
    expect(h.stub.requests).toHaveLength(0);
    expect(h.claim.state).toBe("free");
    expect(h.ctx.ui.notify).toHaveBeenCalledTimes(count);
  });
  it("shutdown with physical fetch pending blocks a new activation; late old callbacks stay silent", async () => {
    const response = deferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>(() => response.promise);
    const h = await environment({ fetchImpl });
    await h.port.handle("measure --yes", h.ctx);
    await until(() => fetchImpl.mock.calls.length === 1, "base fetch called");
    h.fire("session_shutdown", { reason: "reload" });
    const notices = vi.mocked(h.ctx.ui.notify).mock.calls.length;
    await until(() => h.claim.state === "draining", "claim drains");
    const freshHooks: Record<string, any> = {};
    const freshCtx = { ...h.ctx, ui: { ...h.ctx.ui, notify: vi.fn(), setStatus: vi.fn() } };
    const fresh = wireMeasureCommand(
      {
        on(name: string, handler: any) {
          freshHooks[name] = handler;
        },
      } as unknown as ExtensionAPI,
      h.deps,
    );
    freshHooks.session_start({}, freshCtx);
    await fresh.handle("measure --yes", freshCtx);
    expect(
      vi
        .mocked(freshCtx.ui.notify)
        .mock.calls.map(([s]) => s)
        .join(),
    ).toContain("busy(io-pending)");
    response.resolve(new Response("late response"));
    await until(() => h.claim.state === "free", "physical fetch settles");
    expect(h.ctx.ui.notify).toHaveBeenCalledTimes(notices);
    expect(h.stub.requests).toHaveLength(0);
  });
  it.each([P_BOUND_TOKENS - 1, P_BOUND_TOKENS, P_BOUND_TOKENS + 1])(
    "G-a frozen P_bound boundary P=%i",
    async (total) => {
      const h = await environment({ total });
      await h.port.handle("measure --yes", h.ctx);
      if (total > P_BOUND_TOKENS) {
        await h.drive();
        expect(h.stub.requests).toHaveLength(1);
        expect(h.text()).toContain("failed(bound-exceeded)");
        expect(h.text()).toContain(`C1 prompt ${P_BOUND_TOKENS + 1} > ${P_BOUND_TOKENS}`);
        await h.store.flush();
        expect((await h.store.readRoutes())[0]!.latest!.boundExceeded).toEqual({
          condition: "C1",
          observed: P_BOUND_TOKENS + 1,
          limit: P_BOUND_TOKENS,
        });
        await h.port.handle("measure status", h.ctx);
        expect(h.text()).toContain(`C1 prompt ${P_BOUND_TOKENS + 1} > ${P_BOUND_TOKENS}`);
        expect(h.text()).toContain("cost bound did not hold");
      } else {
        await until(
          () =>
            h.stub.requests.length === 6 && h.claim.physicalPending === 0 && h.claim.current()?.nextKind === "control",
          "within-bound writes complete",
        );
        expect(h.text()).not.toContain("bound-exceeded");
      }
    },
  );
  it("G-a real cr-response 19.2k/4k baseline remains measurable; measured total with 6k injection exceeds bound", async () => {
    const h = await environment({ total: 19190, baseline: 4224 });
    await h.port.handle("measure --yes", h.ctx);
    await until(
      () => h.stub.requests.length === 6 && h.claim.physicalPending === 0 && h.claim.current()?.nextKind === "control",
      "19.2k baseline accepted",
    );
    expect(h.results[0]!.outcome.measured!.rawUsage).toMatchObject({
      cache_read_input_tokens: 4224,
      cache_creation_input_tokens: 14966,
    });
    h.fire("session_shutdown", { reason: "new" });
    const over = 15000 + 6000;
    expect(over).toBeGreaterThan(P_BOUND_TOKENS);
    const other = await environment({ total: over, baseline: 6000 });
    await other.port.handle("measure --yes", other.ctx);
    await other.drive();
    expect(other.text()).toContain("failed(bound-exceeded)");
  });
});

describe("live round 3 — exact stock Anthropic adaptive modes", () => {
  it("real pi default on forceAdaptiveThinking emits disabled (not session budget thinking)", async () => {
    const h = await environment({ reasoning: true, compat: { forceAdaptiveThinking: true } });
    const fetchImpl = vi.fn<typeof fetch>();
    let built: Record<string, unknown> | undefined;
    await h.registry
      .streamSimple(
        h.model,
        { systemPrompt: "fixture", messages: [{ role: "user", content: "OK", timestamp: 0 }] },
        {
          maxTokens: 1,
          fetch: fetchImpl,
          onPayload: (params) => {
            built = structuredClone(params) as Record<string, unknown>;
            throw new Error("fixture captured before HTTP");
          },
        },
      )
      .result();
    expect(built!.thinking).toEqual({ type: "disabled" });
    expect(built!.max_tokens).toBe(1);
    expect(built).not.toHaveProperty("output_config");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(h.stub.requests).toHaveLength(0);
  });
  it.each([
    {
      name: "force-adaptive",
      reasoning: true,
      compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
      managed: false,
      effort: "low",
    },
    {
      name: "force-adaptive mapped low",
      reasoning: true,
      compat: { forceAdaptiveThinking: true },
      managed: false,
      effort: "medium",
      thinkingLevelMap: { low: "medium" },
    },
    { name: "managed-effort", reasoning: true, compat: {}, managed: true, effort: "high" },
    {
      name: "both flags (managed precedence)",
      reasoning: true,
      compat: { forceAdaptiveThinking: true },
      managed: true,
      effort: "high",
    },
    { name: "plain reasoning", reasoning: true, compat: {}, managed: false },
    { name: "plain non-reasoning", reasoning: false, compat: {}, managed: false },
  ])(
    "$name: real command/registry/SDK keeps cap 1 and validates stock thinking, then replays exact bytes",
    async ({ name, reasoning, compat, managed, effort, thinkingLevelMap }) => {
      const h = await environment({
        reasoning,
        managed,
        compat,
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        // A relay that rejects disabled/budget thinking on force-adaptive models; the test
        // succeeds only if the real pi builder took its supported adaptive path.
        respond: (request) =>
          name.startsWith("force-adaptive") && (request.json.thinking as { type?: string })?.type !== "adaptive"
            ? { kind: "error", status: 400, message: "requires adaptive thinking; omit disabled/budget mode" }
            : undefined,
      });
      await h.port.handle("measure --yes", h.ctx);
      await until(
        () => h.claim.current()?.nextKind === "control" && h.claim.physicalPending === 0,
        "six safe writes built",
      );
      const wire = h.stub.requests[5]!.json;
      expect(wire.max_tokens).toBe(1);
      if (managed && MANAGED_THINKING_OFF_DISABLED) {
        // pi ≥1.3 stock thinking-off build: no effort markers anywhere (see top of file).
        expect(wire.thinking).toEqual({ type: "disabled" });
        expect(wire).not.toHaveProperty("output_config");
        expect(wire.messages).toHaveLength(1);
      } else if (managed) {
        expect(wire.thinking).toEqual({
          type: "adaptive",
          display: "summarized",
          block_binding: { prefix_mismatch_behavior: "drop_block" },
        });
        expect(wire.output_config).toEqual({ effort: "high" });
        expect(wire.messages).toHaveLength(2);
        expect((wire.messages as unknown[])[1]).toEqual({
          role: "system",
          content: [],
          output_config: { effort: "high" },
        });
      } else if (effort) {
        expect(wire.thinking).toEqual({ type: "adaptive", display: "summarized" });
        expect(wire.output_config).toEqual({ effort });
        expect(wire.messages).toHaveLength(1);
        expect(wire.thinking).not.toHaveProperty("budget_tokens");
        expect(wire.thinking).not.toHaveProperty("block_binding");
      } else {
        if (reasoning) expect(wire.thinking).toEqual({ type: "disabled" });
        else expect(wire).not.toHaveProperty("thinking");
        expect(wire).not.toHaveProperty("output_config");
        expect(wire.messages).toHaveLength(1);
      }
      h.clock.advance(30000);
      await until(() => h.stub.requests.length === 7 && h.claim.physicalPending === 0, "control replay finished");
      expect(h.stub.requests[6]!.body).toBe(h.stub.requests[5]!.body);
      expect(h.text()).not.toContain("failed(payload:");
    },
  );
  it.each([
    { mode: "force-adaptive", managed: false, thinking: { type: "enabled", budget_tokens: 1024 } },
    { mode: "force-adaptive", managed: false, thinking: { type: "disabled" } },
    { mode: "force-adaptive", managed: false, thinking: { type: "between_tools" } },
    {
      mode: "force-adaptive",
      managed: false,
      thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    },
    { mode: "managed", managed: true, thinking: { type: "adaptive", display: "summarized" } },
  ])("$mode rejects actual wrong-mode injection $thinking before POST", async ({ managed, thinking }) => {
    const h = await environment({ reasoning: true, managed, compat: { forceAdaptiveThinking: true } });
    const original = h.registry.streamSimple.bind(h.registry);
    vi.spyOn(h.registry, "streamSimple").mockImplementation((selected, context, options) =>
      original(selected, context, {
        ...options,
        onPayload: (params, model) => {
          (params as Record<string, unknown>).thinking = thinking;
          return options!.onPayload!(params, model);
        },
      }),
    );
    await h.port.handle("measure --yes", h.ctx);
    await h.drive();
    expect(h.text()).toContain("failed(payload:thinking)");
    expect(h.stub.requests).toHaveLength(0);
    expect(h.results[0]!.outcome).toMatchObject({
      kind: "not-sent",
      reason: "capability",
      diag: { baseFetchCalls: 0 },
      measured: { rejection: "thinking" },
    });
  });
});
