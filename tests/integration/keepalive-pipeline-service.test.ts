/** A3 service gates: real capture wiring + ModelRuntime/SDK, local HTTP only (r7 §5/§6). */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import { wireCacheTtl } from "../../src/cache-ttl/cache-ttl.js";
import { sendPipelinePing } from "../../src/cache-ttl/pipeline-ping.js";
import { readBackKeepaliveSessionState } from "../../src/cache-ttl/keepalive-state.js";
import type { PipelinePingInput, PipelinePingResult } from "../../src/cache-ttl/pipeline-ping-types.js";
import { createCacheKeepaliveService, type CacheKeepaliveService } from "../../src/service/cache-keepalive.js";
import { AnthropicStub, type AnthropicStubOptions } from "../conformance/fixtures/anthropic-stub.js";

const ROOT = join(import.meta.dirname, "../..");
const cleanups: Array<() => void | Promise<void>> = [];
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "keepalive-service-a3-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "cwd"),
    agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  return { root, cwd, agentDir };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(check: () => boolean, label: string, ms = 5_000) {
  const end = performance.now() + ms;
  while (!check() && performance.now() < end) await new Promise<void>((resolve) => setTimeout(resolve, 5).unref());
  expect(check(), label).toBe(true);
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
  initTheme("dark", false);
});
afterEach(async () => {
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
function modelConfig(baseUrl: string) {
  return {
    id: "claude-a3-service",
    name: "local A3",
    api: "anthropic-messages" as const,
    provider: "anthropic-a3-service",
    baseUrl,
    reasoning: false,
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 4096,
    cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
  };
}

async function environment(options: { headerOwned?: boolean; fetchImpl?: typeof fetch; probeMissing?: boolean } = {}) {
  const { root, cwd, agentDir } = scratch();
  let directive: AnthropicStubOptions["respond"];
  let reply: AnthropicStubOptions["reply"];
  const stub = await AnthropicStub.start({
    respond: (req, i) => directive?.(req, i),
    reply: (req, i) =>
      reply?.(req, i) ?? { kind: "text", text: "local answer", usage: { cache_read_input_tokens: 30_000 } },
  });
  cleanups.push(() => stub.close());
  const model = { ...modelConfig(stub.baseUrl), ...(options.headerOwned ? { provider: "anthropic" } : {}) };
  if (options.headerOwned) vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "stub-header-owned");
  const provider = {
    baseUrl: stub.baseUrl,
    api: model.api,
    ...(options.headerOwned
      ? { headers: { "x-provider-a3": "provider" } }
      : { apiKey: "stub-api-key", headers: { "x-provider-a3": "provider" } }),
    models: [{ ...model, headers: { "x-model-a3": "model" } }],
  };
  const modelsPath = join(agentDir, "models.json");
  writeFileSync(modelsPath, JSON.stringify({ providers: { [model.provider]: provider } }));
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath });
  const clock = new FakeClock(Date.now());
  const attempts: Array<{ input: PipelinePingInput; result?: PipelinePingResult; physicallySettled: boolean }> = [];
  const hookErrors: unknown[] = [];
  const tool = deferred<void>();
  let toolStarted = false,
    toolFinished = false,
    turns = 0,
    missing = options.probeMissing === true;
  let service: CacheKeepaliveService;
  let context: ExtensionContext;
  const factory = (pi: ExtensionAPI) => {
    pi.on("session_start", (_event, ctx) => {
      context = ctx;
      expect(ctx.modelRegistry).toBeInstanceOf(ModelRegistry);
      // Structural capability disappearance at activation, not a fake sender/provider.
      if (missing) Object.defineProperty(ctx.modelRegistry, "streamSimple", { value: undefined, configurable: true });
      service = createCacheKeepaliveService({
        ctx,
        clock,
        sessionId: ctx.sessionManager.getSessionId(),
        settings: { ...DEFAULT_SETTINGS.cacheTtl, keepalive: true },
        statusBar: false,
        backgroundBusy: () => false,
        isCurrent: (self) => self === service,
        persistSessionState: true,
        recoverTransientFailures: true,
        restoredState: readBackKeepaliveSessionState(ctx.sessionManager.getBranch()),
        appendEntry: (type, data) => pi.appendEntry(type, data),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        sendPipelinePing: async (input) => {
          const attempt: (typeof attempts)[number] = { input, physicallySettled: false };
          attempts.push(attempt);
          const result = await sendPipelinePing(input); // THE production A1 transport, no scripted outcome
          attempt.result = result;
          void result.settled.then(() => {
            attempt.physicallySettled = true;
          });
          return result;
        },
      });
      if (missing) Reflect.deleteProperty(ctx.modelRegistry, "streamSimple");
      cleanups.push(() => service.dispose());
    });
    pi.on("session_shutdown", () => service?.dispose());
    pi.registerTool({
      name: "a3_wait",
      label: "A3 wait",
      description: "abortable unresolved tool",
      parameters: { type: "object", properties: {} } as never,
      execute: async (_id, _args, signal) => {
        toolStarted = true;
        const aborted = deferred<void>();
        const abort = () => aborted.resolve();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        try {
          await Promise.race([tool.promise, aborted.promise]);
        } finally {
          signal?.removeEventListener("abort", abort);
        }
        toolFinished = true;
        return { content: [{ type: "text", text: "released" }], details: {} };
      },
    });
    wireCacheTtl(pi, DEFAULT_SETTINGS, { keepalive: () => service });
    pi.on("turn_end", () => {
      turns++;
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
    tools: ["read", "a3_wait"],
  });
  cleanups.push(async () => {
    tool.resolve();
    await session.abort();
    service?.dispose();
    session.dispose();
  });
  await session.bindExtensions({ mode: "rpc", onError: (e) => hookErrors.push(e) });
  session.setActiveToolsByName(["read", "a3_wait"]);
  cleanups.push(() => {
    expect(hookErrors, "no swallowed extension failures").toEqual([]);
  });
  return {
    root,
    cwd,
    agentDir,
    stub,
    session,
    clock,
    runtime,
    attempts,
    service: () => service,
    ctx: () => context,
    setDirective: (fn: AnthropicStubOptions["respond"]) => {
      directive = fn;
    },
    setReply: (fn: AnthropicStubOptions["reply"]) => {
      reply = fn;
    },
    toolStarted: () => toolStarted,
    toolFinished: () => toolFinished,
    turns: () => turns,
    async reload() {
      missing = false;
      await session.reload();
    },
    async openWindow() {
      // A real prior response supplies the usage lower bound (the first-ever request is unknown).
      await session.prompt("measure prior cache usage");
      await session.prompt("open eligible window");
      expect(service.report().window.capture?.prefix).toEqual({ source: "usage", tokens: 30_000 });
      service.noteUiPromptStart(session.sessionId, service.instanceId);
      clock.advance(240_000);
      await until(() => attempts.length > 0, "transport attempt started");
    },
  };
}

async function logical(env: Awaited<ReturnType<typeof environment>>) {
  await until(() => env.attempts[0]?.result !== undefined, "logical transport completed");
  return env.attempts[0]!.result!;
}

describe("A3 real keepalive service pipeline", () => {
  for (const headerOwned of [false, true])
    it(`models.json headers / header-owned auth=${headerOwned}: an eligible window actually SENDS`, async () => {
      const env = await environment({ headerOwned });
      await env.openWindow();
      const result = await logical(env);
      expect(result.outcome.kind).toBe("usage");
      await until(() => env.service().report().session.pings === 1, "service records proven hit");
      expect(env.stub.requests).toHaveLength(3);
      const ping = env.stub.requests[2]!;
      expect(ping.headers["x-provider-a3"]).toBe("provider");
      expect(ping.headers["x-model-a3"]).toBe("model");
      if (headerOwned) {
        expect(ping.headers.authorization).toBe("Bearer stub-header-owned");
        expect(ping.headers["x-api-key"]).toBeUndefined();
      } else expect(ping.headers["x-api-key"]).toBe("stub-api-key");
      expect(ping.json.messages).toEqual(env.stub.requests[1]!.json.messages);
      expect(ping.json.max_tokens).toBe(1);
      expect(env.service().report().window.lastStopReason).toBeUndefined();
      expect(env.service().report().lastPingDiagnostics?.headerSource).toBe("pipeline");
    });

  it("long tool call: a real tool promise stays unresolved; ping arrives at 240s BEFORE turn_end", async () => {
    const env = await environment();
    await env.session.prompt("measure usage first");
    env.setReply((_req, i) =>
      i === 1
        ? { kind: "tool", calls: [{ name: "a3_wait" }], usage: { cache_read_input_tokens: 30_000 } }
        : { kind: "text", text: "done", usage: { cache_read_input_tokens: 30_000 } },
    );
    const before = env.turns();
    const prompt = env.session.prompt("call a3_wait");
    await until(env.toolStarted, "tool really entered execute");
    expect(env.toolFinished()).toBe(false);
    expect(env.turns()).toBe(before);
    expect(env.service().report().window.requestInFlight).toBe(false); // message_end, NOT turn_end
    env.clock.advance(240_000);
    await logical(env);
    expect(env.stub.requests).toHaveLength(3);
    expect(env.stub.requests[2]!.json.max_tokens).toBe(1);
    expect(env.turns()).toBe(before);
    expect(env.toolFinished()).toBe(false);
    await env.session.abort();
    await prompt;
  });

  it("real /reload forgets an activation-only disable, while readback preserves a proven-write breaker", async () => {
    const env = await environment({ probeMissing: true });
    const disabled = env.service();
    expect(disabled.report().activationDisabled?.reason).toBe("transport-unsupported");
    await env.session.prompt("first measurement");
    expect(readBackKeepaliveSessionState(env.session.sessionManager.getBranch())?.disabled).toBeUndefined();
    await env.reload();
    expect(env.service()).not.toBe(disabled);
    expect(env.service().report().activationDisabled).toBeUndefined();
    await env.openWindow();
    await logical(env);
    await until(() => env.service().report().session.pings === 1, "post-reload ping sent");
    env.setReply(() => ({
      kind: "text",
      text: "write",
      usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 30_000 },
    }));
    // This response opens the next eligible window; its ping reports the paid rewrite.
    await env.session.prompt("next window");
    env.service().noteUiPromptStart(env.session.sessionId, env.service().instanceId);
    env.clock.advance(240_000);
    await until(() => env.service().report().session.disabled?.reason === "proven-write", "real write trips breaker");
    const persisted = readBackKeepaliveSessionState(env.session.sessionManager.getBranch());
    expect(persisted?.disabled?.reason).toBe("proven-write");
    await env.reload();
    expect(env.service().report().activationDisabled).toBeUndefined();
    expect(env.service().report().session.disabled).toEqual(persisted!.disabled);
  });

  it("pipeline auth failure is not-sent/refunded, never a transport-unsupported latch", async () => {
    const env = await environment();
    await env.session.prompt("prior usage");
    await env.session.prompt("eligible capture");
    // Change ONLY the pipeline's auth resolution; same model/route, no fake provider or transport.
    env.runtime.registerProvider("anthropic-a3-service", { apiKey: "!exit 1" });
    env.service().noteUiPromptStart(env.session.sessionId, env.service().instanceId);
    env.clock.advance(240_000);
    const result = await logical(env);
    expect(result.outcome).toMatchObject({ kind: "not-sent", reason: "auth", diag: { baseFetchCalls: 0 } });
    expect(env.stub.requests).toHaveLength(2);
    expect(env.service().report().activationDisabled).toBeUndefined();
    expect(env.service().report().window.pings).toBe(0);
  });

  it("epoch cancellation of an in-flight ping never latches transport-unsupported", async () => {
    const env = await environment();
    env.setDirective((_req, i) => (i === 2 ? { kind: "hang" } : undefined));
    await env.openWindow();
    await env.stub.waitForRequests(3);
    await env.session.prompt("new real request preempts the ping");
    const result = await logical(env);
    expect(result.outcome.kind).toBe("network");
    expect(env.service().report().activationDisabled).toBeUndefined();
    expect(env.service().report().window.capture?.payload.messages).toEqual(env.stub.requests[3]!.json.messages);
    await until(() => !env.service().report().ioBusy, "aborted IO physically settles");
  });

  for (const failure of ["fetch-reject", "503", "200-then-drop"] as const)
    it(`${failure} never falsely latches transport-unsupported`, async () => {
      const fetchImpl = vi.fn<typeof fetch>(
        failure === "fetch-reject"
          ? async () => {
              throw new TypeError("A3 network failure");
            }
          : fetch,
      );
      const env = await environment({ fetchImpl });
      if (failure === "503")
        env.setDirective((_req, i) => (i >= 2 ? { kind: "error", status: 503, message: "temporary" } : undefined));
      if (failure === "200-then-drop")
        env.setDirective((_req, i) => (i >= 2 ? { kind: "drop-after-headers" } : undefined));
      await env.openWindow();
      const result = await logical(env);
      expect(result.outcome.kind).toBe(
        failure === "fetch-reject" ? "network" : failure === "503" ? "http" : "accepted-then-lost",
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(env.service().report().activationDisabled).toBeUndefined();
      await until(() => !env.service().report().ioBusy, "transient IO settles");
      // Retry policy belongs to the service, not SDK. No implicit retry before 2s.
      env.clock.advance(1_999);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

  for (const stall of ["after-200", "newline-less-flood", "cancel-never-settles", "fetch-never-settles"] as const)
    it(`${stall}: bounded logical result, io-busy until PHYSICAL settle, exactly one base fetch`, async () => {
      const release = deferred<void>(),
        lateFetch = deferred<Response>();
      let headersArrived = false,
        cancelCalled = false;
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        if (stall === "fetch-never-settles") return lateFetch.promise;
        const response = await fetch(input, init);
        headersArrived = true;
        const reader = response.body!.getReader();
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              async pull(sink) {
                try {
                  const step = await reader.read();
                  if (step.done) sink.close();
                  else sink.enqueue(step.value);
                } catch (error) {
                  sink.error(error);
                }
              },
              async cancel() {
                cancelCalled = true;
                try {
                  await reader.cancel();
                } catch {}
                await release.promise;
              },
            },
            { highWaterMark: 0 },
          ),
          { status: response.status, headers: response.headers },
        );
      });
      cleanups.push(() => {
        release.resolve();
        lateFetch.resolve(new Response("late"));
      });
      const env = await environment({ fetchImpl });
      env.setDirective((_req, i) =>
        i >= 2
          ? { kind: "stall-after-headers", ...(stall === "newline-less-flood" ? { chunk: "x".repeat(70_000) } : {}) }
          : undefined,
      );
      await env.openWindow();
      await until(() => fetchImpl.mock.calls.length === 1, "base fetch called");
      if (stall !== "fetch-never-settles") await until(() => headersArrived, "real HTTP 200 arrived");
      const started = env.clock.now();
      if (stall !== "newline-less-flood") {
        env.clock.advance(19_999);
        expect(env.attempts[0]!.result).toBeUndefined();
        env.clock.advance(1);
      }
      const result = await logical(env);
      expect(result.outcome.kind).toBe(
        stall === "newline-less-flood"
          ? "malformed"
          : stall === "fetch-never-settles"
            ? "network"
            : "accepted-then-lost",
      );
      expect(result.outcome.diag.durationMs).toBeLessThanOrEqual(20_000);
      expect(env.clock.now() - started).toBeLessThanOrEqual(20_000);
      expect(result.outcome.diag.baseFetchCalls).toBe(1);
      expect(env.stub.requests).toHaveLength(stall === "fetch-never-settles" ? 2 : 3);
      if (stall === "newline-less-flood") expect(result.outcome.diag.bodyBytes).toBe(65_536);
      else expect(result.outcome.diag.deadlineHit).toBe(true);
      if (stall !== "fetch-never-settles") expect(cancelCalled).toBe(true);
      expect(env.service().report().ioBusy).toBe(true);
      expect(env.attempts[0]!.physicallySettled).toBe(false);
      expect(env.service().report().activationDisabled).toBeUndefined();
      env.clock.advance(2_000); // even the service retry must refuse while physically busy
      await until(() => !env.service().report().window.pingInFlight, "logical service attempt finishes");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // A fresh eligible real window must also remain gated by the old physical IO.
      env.setDirective(undefined);
      await env.session.prompt("new capture while physical IO is still held");
      env.service().noteUiPromptStart(env.session.sessionId, env.service().instanceId);
      env.clock.advance(240_000);
      expect(env.service().report().lastSkip).toBe("io-busy");
      release.resolve();
      lateFetch.resolve(new Response("late"));
      await until(() => !env.service().report().ioBusy, "IO released only after physical settle");
      expect(env.attempts[0]!.physicallySettled).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});

/** No process.exit(), no fake clocks: the SDK's 20s ref'd timer must be cleared by disposal. */
for (const mode of ["main", "child"] as const)
  it(`natural process exit: ${mode} wiring clears a pending ping SDK timer after dispose`, async () => {
    const { root, cwd, agentDir } = scratch();
    const stub = await AnthropicStub.start({
      reply: () => ({ kind: "tool", calls: [{ name: "a3_wait" }], usage: { cache_read_input_tokens: 30_000 } }),
    });
    cleanups.push(() => stub.close());
    const model = modelConfig(stub.baseUrl);
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          [model.provider]: { api: model.api, baseUrl: model.baseUrl, apiKey: "stub-api-key", models: [model] },
        },
      }),
    );
    const source = `
    import { ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession, initTheme } from '@earendil-works/pi-coding-agent';
    import { DEFAULT_SETTINGS } from './src/config/settings.ts';
    import { createCacheKeepaliveService } from './src/service/cache-keepalive.ts';
    import { wireCacheTtl } from './src/cache-ttl/cache-ttl.ts';
    import { wireChildKeepalive } from './src/cache-ttl/child.ts';
    import { getChildKeepaliveDisposeRegistry } from './src/cache-ttl/child-registry.ts';
    import { getChildKeepaliveLedger } from './src/cache-ttl/ping-ledger.ts';
    initTheme('dark', false);
    const cwd=${JSON.stringify(cwd)}, agentDir=${JSON.stringify(agentDir)};
    const runtime=await ModelRuntime.create({authPath:agentDir+'/auth.json',modelsPath:agentDir+'/models.json'});
    const settings={...DEFAULT_SETTINGS,cacheTtl:{...DEFAULT_SETTINGS.cacheTtl,keepalive:true,childKeepalive:true,keepaliveIntervalMs:250}};
    let service, session, pingResolve;
    const pingStarted=new Promise(r=>pingResolve=r);
    const baseFetch=globalThis.fetch;
    globalThis.fetch=(input,init)=> {
      if(JSON.parse(init.body).max_tokens===1) { pingResolve(); return new Promise(()=>{}); }
      return baseFetch(input,init);
    };
    const factory=(pi)=>{
      pi.registerTool({name:'a3_wait',label:'wait',description:'abortable wait',parameters:{type:'object',properties:{}},
        execute:async(_id,_args,signal)=>{await new Promise(r=>{if(signal?.aborted)r();else signal?.addEventListener('abort',r,{once:true})});return {content:[{type:'text',text:'aborted'}],details:{}};}});
      ${
        mode === "main"
          ? `
      pi.on('session_start',(_e,ctx)=>{service=createCacheKeepaliveService({ctx,sessionId:ctx.sessionManager.getSessionId(),settings:settings.cacheTtl,allowHeadless:true,statusBar:false,backgroundBusy:()=>false,isCurrent:s=>s===service});});
      wireCacheTtl(pi,settings,{keepalive:()=>service});`
          : "wireChildKeepalive(pi,settings);"
      }
    };
    const settingsManager=SettingsManager.create(cwd,agentDir);
    const resourceLoader=new DefaultResourceLoader({cwd,agentDir,settingsManager,extensionFactories:[factory]});
    await resourceLoader.reload();
    const manager=SessionManager.inMemory(cwd);
    manager.appendMessage({role:'assistant',api:'anthropic-messages',provider:${JSON.stringify(model.provider)},model:${JSON.stringify(model.id)},content:[{type:'text',text:'prior measured usage'}],stopReason:'stop',timestamp:Date.now(),usage:{input:10,output:1,cacheRead:30000,cacheWrite:0,totalTokens:30011,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
    ({session}=await createAgentSession({cwd,agentDir,modelRuntime:runtime,model:runtime.getModel(${JSON.stringify(model.provider)},${JSON.stringify(model.id)}),sessionManager:manager,settingsManager,resourceLoader,tools:['read','a3_wait']}));
    await session.bindExtensions({mode:'print',onError:e=>{console.error(e);process.exitCode=2;}});
    session.setActiveToolsByName(['read','a3_wait']);
    // Only the readiness phase holds the subprocess open; cleared BEFORE disposal.
    const readyGuard=setTimeout(()=>{throw new Error("ping did not start")},23000);
    const prompt=session.prompt('call a3_wait');
    await pingStarted;
    clearTimeout(readyGuard);
    console.log('PING');
    ${mode === "main" ? "service.dispose();" : "getChildKeepaliveDisposeRegistry().disposeSession(session.sessionId);"}
    await session.abort(); await prompt; session.dispose();
    console.log('DISPOSED '+Date.now()+' leases='+getChildKeepaliveLedger().activeCount());
  `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: ROOT,
      env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanups.push(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string; afterDisposeMs: number }>(
      (resolve, reject) => {
        let stdout = "",
          stderr = "",
          disposedAt: number | undefined;
        const guard = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`${mode} child stuck: ${stdout}\n${stderr}`));
        }, 25_000).unref();
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes("DISPOSED") && disposedAt === undefined) disposedAt = Date.now();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.once("error", (error) => {
          clearTimeout(guard);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(guard);
          resolve({
            code,
            stdout,
            stderr,
            afterDisposeMs: disposedAt === undefined ? Infinity : Date.now() - disposedAt,
          });
        });
      },
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("PING");
    expect(result.stdout).toContain("leases=0");
    expect(result.afterDisposeMs).toBeLessThan(1_000); // stronger than D + 1s; no SDK 20s timer leak
    expect(stub.requests).toHaveLength(1); // ping base fetch was replaced, never a second server POST
  }, 30_000);
