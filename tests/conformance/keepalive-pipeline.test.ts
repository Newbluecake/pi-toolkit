/**
 * A3, capture-pairing-plan r7: production capture/transport over the REAL
 * ModelRuntime → Anthropic SDK → local HTTP stub. No provider mocks.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { wireCacheTtl } from "../../src/cache-ttl/cache-ttl.js";
import { sendPipelinePing } from "../../src/cache-ttl/pipeline-ping.js";
import { preparePingPayload } from "../../src/cache-ttl/ping-client.js";
import { createCacheKeepaliveService, type CacheKeepaliveService } from "../../src/service/cache-keepalive.js";
import { PiSessionDriver } from "../../src/runtime/session-driver.js";
import { childActivationAdvanced, childActivationSnapshot } from "../../src/child/activation-signal.js";
import { getChildKeepaliveDisposeRegistry } from "../../src/cache-ttl/child-registry.js";
import { getChildKeepaliveLedger } from "../../src/cache-ttl/ping-ledger.js";
import { AnthropicStub, type AnthropicStubOptions, type StubRequest } from "./fixtures/anthropic-stub.js";

const ROOT = join(import.meta.dirname, "../..");
const cleanups: Array<() => void | Promise<void>> = [];
let sequence = 0;

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "keepalive-a3-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  return { root, cwd, agentDir };
}

beforeEach(() => {
  const { root, agentDir } = scratch();
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_CACHE_RETENTION", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
});

afterEach(async () => {
  vi.useRealTimers();
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (errors.length) throw new AggregateError(errors, "A3 teardown failed");
});

async function until(check: () => boolean, label: string, timeout = 5_000) {
  const end = performance.now() + timeout;
  while (!check() && performance.now() < end) await new Promise<void>((resolve) => setTimeout(resolve, 5).unref());
  expect(check(), label).toBe(true);
}

function modelConfig(baseUrl: string, reasoning = false) {
  return {
    id: `claude-a3-${++sequence}`,
    name: "A3 local stub",
    api: "anthropic-messages" as const,
    provider: "anthropic-a3",
    baseUrl,
    reasoning,
    input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200_000,
    maxTokens: 4096,
    compat: { sendSessionAffinityHeaders: true, supportsStrictTools: true },
  };
}

async function environment(
  options: { reasoning?: boolean; oauth?: boolean; strict?: boolean; laterRewrite?: boolean } = {},
) {
  let directive: AnthropicStubOptions["respond"];
  const stub = await AnthropicStub.start({
    respond: (req, index) => directive?.(req, index),
    reply: () => ({ kind: "text", text: "local answer", usage: { cache_read_input_tokens: 30_000 } }),
  });
  cleanups.push(() => stub.close());
  const { cwd, agentDir } = scratch();
  const model = modelConfig(stub.baseUrl, options.reasoning);
  // This is a synthetic OAuth-shaped credential, never a real credential.
  const credential = options.oauth ? `sk-ant-oat01-${"a3".repeat(20)}` : "stub-api-key";
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [model.provider]: { baseUrl: stub.baseUrl, api: model.api, apiKey: credential, models: [model] },
      },
    }),
  );
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const clock = new FakeClock(Date.now());
  let service: CacheKeepaliveService;
  let context: ExtensionContext;
  const payloads: Record<string, unknown>[] = [];
  const captures: Record<string, unknown>[] = [];
  let hooks = 0;
  const factory = (pi: ExtensionAPI) => {
    pi.on("before_provider_request", (_event, ctx) => {
      context = ctx;
      if (service) return;
      service = createCacheKeepaliveService({
        ctx,
        clock,
        sessionId: ctx.sessionManager.getSessionId(),
        settings: { ...DEFAULT_SETTINGS.cacheTtl, keepalive: true },
        allowHeadless: true,
        statusBar: false,
        backgroundBusy: () => false,
        isCurrent: (self) => self === service,
      });
      cleanups.push(() => service.dispose());
    });
    // Normalize the REAL request's output budget to the ping budget so G3 can compare
    // complete body bytes, not a filtered projection. Thinking keeps its real budget.
    pi.on("before_provider_request", (event) => {
      const payload = event.payload as Record<string, unknown>;
      if (!options.reasoning) payload.max_tokens = 1;
    });
    wireCacheTtl(pi, DEFAULT_SETTINGS, { keepalive: () => service });
    pi.on("before_provider_request", (event) => {
      hooks++;
      payloads.push(structuredClone(event.payload) as Record<string, unknown>);
      captures.push(structuredClone(service.report().window.capture!.payload));
      if (options.laterRewrite) {
        const changed = structuredClone(event.payload) as Record<string, unknown>;
        changed.metadata = { user_id: "later-extension-rewrite" };
        return changed;
      }
      return undefined;
    });
    pi.on("before_provider_headers", () => {
      hooks++;
    });
    pi.on("after_provider_response", () => {
      hooks++;
    });
    pi.on("provider_stream_event", () => {
      hooks++;
    });
  };
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [factory] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    model: runtime.getModel(model.provider, model.id)!,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    tools: options.strict ? ["bash"] : ["read"],
  });
  const hookErrors: unknown[] = [];
  session.extensionRunner?.onError((e) => hookErrors.push(e));
  cleanups.push(() => {
    expect(hookErrors, "extension hooks must not silently fail").toEqual([]);
  });
  cleanups.push(() => session.dispose());
  if (options.reasoning) session.setThinkingLevel("medium");
  return {
    stub,
    session,
    payloads,
    captures,
    clock,
    ctx: () => context,
    service: () => service,
    hooks: () => hooks,
    respond: (fn: AnthropicStubOptions["respond"]) => {
      directive = fn;
    },
    async ping(fetchImpl: typeof fetch = fetch) {
      const ctx = context;
      const capture = service.report().window.capture!;
      const result = await sendPipelinePing({
        registry: ctx.modelRegistry,
        model: ctx.model!,
        sessionId: session.sessionManager.getSessionId(),
        body: preparePingPayload(capture.payload),
        clock,
        deadlineAt: clock.now() + 20_000,
        guard: () => true,
        fetchImpl,
      });
      await result.settled;
      return result;
    },
  };
}

function headers(request: StubRequest) {
  const result = { ...request.headers };
  delete result["x-stainless-timeout"];
  return result;
}

describe("A3 keepalive pipeline conformance", () => {
  it("G2: first P is captured immediately; strict P′ replaces it, without waiting for another H", async () => {
    const env = await environment({ strict: true });
    env.respond((_req, index) =>
      index === 0 ? { kind: "error", status: 400, message: "Too many strict tools (A3)" } : undefined,
    );
    await env.session.prompt("first request needs strict fallback");
    expect(env.stub.requests).toHaveLength(2);
    expect(env.captures).toEqual(env.payloads);
    expect(env.captures).toHaveLength(2);
    const strict = (p: Record<string, unknown>) =>
      (p.tools as Array<{ strict?: boolean }>).some((tool) => tool.strict === true);
    expect(strict(env.captures[0]!)).toBe(true);
    expect(strict(env.captures[1]!)).toBe(false);
    expect(env.service().report().window.capture!.payload).toEqual(env.payloads[1]);
    expect(env.stub.requests.map((r) => r.json)).toEqual(env.captures);
  });

  for (const variant of ["api-key", "OAuth", "thinking", "strict"] as const) {
    it(`G3: ${variant} ping reproduces SDK wire bytes and headers (except x-stainless-timeout)`, async () => {
      const env = await environment({
        oauth: variant === "OAuth",
        reasoning: variant === "thinking",
        strict: variant === "strict",
      });
      if (variant === "strict")
        env.respond((_r, index) =>
          index === 0 ? { kind: "error", status: 400, message: "Too many strict tools (A3)" } : undefined,
        );
      await env.session.prompt("real wire");
      const real = env.stub.requests.at(-1)!;
      const before = env.hooks();
      const result = await env.ping();
      expect(result.outcome.kind).toBe("usage");
      expect(result.outcome.diag.baseFetchCalls).toBe(1);
      expect(env.hooks(), "pipeline replay must not re-enter extension hooks").toBe(before);
      const ping = env.stub.requests.at(-1)!;
      expect(ping).not.toBe(real);
      expect(ping.body).toBe(real.body);
      expect(ping.url).toBe(real.url);
      expect(ping.method).toBe("POST");
      expect(headers(ping)).toEqual(headers(real));
      expect(ping.headers["x-stainless-timeout"]).toBeDefined();
      if (variant === "OAuth" || variant === "thinking") {
        const betas = env.payloads.at(-1)!.betas as string[];
        expect(betas.length).toBeGreaterThan(0);
        expect(ping.json.betas).toBeUndefined();
        for (const beta of betas) expect(ping.headers["anthropic-beta"]).toContain(beta);
      }
      if (variant === "thinking") {
        expect(ping.json.thinking).toEqual(real.json.thinking);
        expect(ping.json.max_tokens).toBe(real.json.max_tokens);
        expect(ping.json.max_tokens).toBeGreaterThan(1);
      }
      if (variant === "OAuth") expect(ping.headers.authorization).toMatch(/^Bearer sk-ant-oat01-/);
    });
  }

  for (const failure of ["strict-400", "503", "fetch-reject"] as const) {
    it(`G4: ${failure} invokes base fetch once, independently of server POST count`, async () => {
      const env = await environment({ strict: true });
      await env.session.prompt("capture strict payload");
      const start = env.stub.requests.length;
      env.respond(() => ({
        kind: "error",
        status: failure === "503" ? 503 : 400,
        message: "Too many strict tools (A3 ping)",
      }));
      const baseFetch = vi.fn<typeof fetch>(
        failure === "fetch-reject"
          ? async () => {
              throw new TypeError("A3 synthetic network failure");
            }
          : fetch,
      );
      const result = await env.ping(baseFetch);
      expect(baseFetch).toHaveBeenCalledTimes(1);
      expect(result.outcome.diag.baseFetchCalls).toBe(1);
      const posts = env.stub.requests.length - start;
      if (failure === "fetch-reject") {
        expect(posts).toBeLessThanOrEqual(1);
        expect(posts).toBe(0);
        expect(result.outcome.kind).toBe("network");
      } else {
        expect(posts).toBe(1);
        expect(result.outcome).toMatchObject({ kind: "http", status: failure === "503" ? 503 : 400 });
        // The replay stub context is toolless; the real provider therefore has no strict
        // fallback candidates. HTTP 400 must NOT turn into a second POST.
        if (failure === "strict-400") expect(result.outcome.diag.onPayloadCalls).toBe(1);
      }
    });
  }

  it("G7: a later payload-rewriting extension really makes captured P differ from wire Q (accepted residual)", async () => {
    const env = await environment({ laterRewrite: true });
    await env.session.prompt("later rewriter");
    const capture = env.service().report().window.capture!.payload;
    expect(capture).toEqual(env.payloads[0]);
    expect(capture.metadata).toBeUndefined();
    expect(env.stub.requests[0]!.json.metadata).toEqual({ user_id: "later-extension-rewrite" });
    expect(env.stub.requests[0]!.json).not.toEqual(capture);
    await env.ping();
    expect(env.stub.requests[1]!.json).toEqual(capture);
    expect(env.stub.requests[1]!.body).not.toBe(env.stub.requests[0]!.body);
  });

  it("G8: driver child discovers its OWN settings-listed package; first capture pings, abort settles one ledger lease", async () => {
    const { root, cwd, agentDir } = scratch();
    vi.stubEnv("HOME", root);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const stub = await AnthropicStub.start({
      respond: (_request, index) => (index > 0 ? { kind: "hang" } : undefined),
      reply: () => ({ kind: "tool", calls: [{ name: "a3_wait" }], usage: { cache_read_input_tokens: 30_000 } }),
    });
    cleanups.push(() => stub.close());
    const model = modelConfig(stub.baseUrl);
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          [model.provider]: { baseUrl: stub.baseUrl, api: model.api, apiKey: "stub-api-key", models: [model] },
        },
      }),
    );
    const extension = join(root, "wait.ts");
    // Loaded from settings by the CHILD, not supplied via a parent factory/resource loader.
    writeFileSync(
      extension,
      `export default (pi) => {
      pi.registerTool({name:"a3_wait", label:"wait", description:"A3 bounded abortable tool",
        parameters:{type:"object",properties:{}},
        execute:async (_id,_args,signal) => {
          await new Promise(resolve => {
            if(signal.aborted) resolve();
            else signal.addEventListener("abort",resolve,{once:true});
          });
          return {content:[{type:"text",text:"aborted"}],details:{}};
        }});
    };`,
    );
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [ROOT], extensions: [extension] }));
    const toolkitDir = join(root, ".pi/agent");
    mkdirSync(toolkitDir, { recursive: true });
    writeFileSync(
      join(toolkitDir, "pi-subagent.json"),
      JSON.stringify({
        cacheTtl: { keepalive: true, childKeepalive: true },
        memory: { enabled: false },
        webSearch: { enabled: false },
        todo: { enabled: false },
        bashJobs: { enabled: false },
      }),
    );
    const hostKey = Symbol.for("pi-subagent:host");
    const globals = globalThis as Record<symbol, unknown>;
    const previous = globals[hostKey];
    globals[hostKey] = { activatedAt: Date.now() };
    cleanups.push(() => {
      if (previous === undefined) delete globals[hostKey];
      else globals[hostKey] = previous;
    });
    const before = childActivationSnapshot();
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const driver = new PiSessionDriver(false, (provider, id) => runtime.getModel(provider, id));
    const handle = await driver.create({ cwd, agentDir, model, persist: false });
    cleanups.push(() => {
      getChildKeepaliveDisposeRegistry().disposeSession(handle.sessionId);
      handle.dispose();
    });
    expect(childActivationAdvanced(before)).toBe(true);
    expect(handle.childExtensionMissing).toBe(false);
    expect(handle.getActiveTools()).toContain("a3_wait");
    const childSession = (handle as unknown as { session: AgentSession }).session;
    // Seed a measured prior-usage fixture, not a request: the FIRST outgoing P is captured.
    // Without a prior ledger the prefix-unproven gate correctly refuses a ping.
    childSession.sessionManager.appendMessage({
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: "text", text: "prior measured cache usage" }],
      usage: {
        input: 100,
        output: 1,
        cacheRead: 30_000,
        cacheWrite: 0,
        totalTokens: 30_101,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    let toolStarted = false;
    childSession.subscribe((event) => {
      if (event.type === "tool_execution_start") toolStarted = true;
    });
    const ledger = getChildKeepaliveLedger();
    const settles: ReturnType<typeof vi.fn>[] = [];
    // Wrap the real ledger, preserving admission/reservation/settle semantics.
    const boundAcquire = ledger.tryAcquire.bind(ledger);
    vi.spyOn(ledger, "tryAcquire").mockImplementation((input) => {
      const result = boundAcquire(input);
      if (result.ok) {
        const settle = vi.fn(result.lease.settle);
        settles.push(settle);
        return { ok: true, lease: { ...result.lease, settle } };
      }
      return result;
    });
    let pingSignal: AbortSignal | undefined;
    const baseFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (typeof init?.body === "string" && JSON.parse(init.body).max_tokens === 1) {
        pingSignal = init.signal ?? undefined;
      }
      return baseFetch(input, init);
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const prompt = handle.prompt("call a3_wait");
    // Use real IO turns while keeping the service's clock stationary.
    const waitReal = async (predicate: () => boolean) => {
      const end = performance.now() + 5_000;
      while (!predicate() && performance.now() < end) await new Promise<void>((r) => setImmediate(r));
      expect(predicate()).toBe(true);
    };
    await waitReal(() => stub.requests.length === 1);
    await waitReal(() => toolStarted);
    await vi.advanceTimersByTimeAsync(240_000);
    await waitReal(() => stub.requests.length === 2);
    expect(stub.requests[1]!.json.messages).toEqual(stub.requests[0]!.json.messages);
    expect(ledger.activeCount()).toBe(1);
    expect(pingSignal?.aborted).toBe(false);
    await handle.requestAbort();
    await prompt;
    handle.dispose();
    await waitReal(() => ledger.activeCount() === 0);
    expect(settles).toHaveLength(1);
    expect(settles[0]).toHaveBeenCalledTimes(1);
    expect(ledger.reserved()).toBe(0);
    await waitReal(() => pingSignal?.aborted === true);
    expect(stub.requests).toHaveLength(2);
    vi.useRealTimers();
    await until(() => ledger.activeCount() === 0, "ledger stays released after disposal");
  }, 30_000);
});
