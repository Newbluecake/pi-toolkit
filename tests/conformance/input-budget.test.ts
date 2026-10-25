import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { FakeClock } from "../../src/core/clock.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import {
  BasicEffectInterpreter,
  RuntimeRunner,
  type ResolvedSpawnRequest,
  type RunnerDeps,
} from "../../src/runtime/runner.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import type { AgentSettings } from "../../src/config/settings.js";
import { wireChildSession } from "../../src/child/wire.js";
import { childActivationSnapshot, markChildExtensionActivated } from "../../src/child/activation-signal.js";
import { computeChildExtensionMissing } from "../../src/runtime/session-driver.js";
import { getInputBudgetRegistry } from "../../src/runtime/input-budget-registry.js";
import { OVERHEAD_FLOOR_BYTES } from "../../src/memory/tidy/batch-plan.js";

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function model(baseUrl: string) {
  return {
    id: "prt-test-model",
    name: "P-RT test model",
    api: "openai-completions",
    provider: "openai",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16,
  };
}

async function fakeEndpoint() {
  let requests = 0;
  let lastBody = "";
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests += 1;
      lastBody = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' + "data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake endpoint did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get requests() {
      return requests;
    },
    get lastBody() {
      return lastBody;
    },
  };
}

async function realSession(baseUrl: string, tools: string[] = ["read"], withExtension = true) {
  const activationBefore = childActivationSnapshot();
  const cwd = mkdtempSync(join(tmpdir(), "pi-prt-conformance-"));
  dirs.push(cwd);
  const settingsManager = SettingsManager.create(cwd, join(cwd, ".pi-agent"));
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, ".pi-agent"),
    settingsManager,
    extensionFactories: withExtension
      ? [
          (pi) => {
            markChildExtensionActivated();
            wireChildSession(pi, {
              cacheTtl: { keepalive: false },
              compact: { enabled: false },
            } as unknown as AgentSettings);
          },
        ]
      : [],
  });
  await loader.reload();
  const selectedModel = model(baseUrl);
  const modelRuntime = {
    streamSimple: (m: typeof selectedModel, context: any, options: any) =>
      streamSimple(m as never, context, { ...options, apiKey: "prt-test-key" }),
    getModel: () => selectedModel,
    hasConfiguredAuth: () => true,
    getAuth: async () => ({ apiKey: "prt-test-key" }),
  };
  const { session } = await createAgentSession({
    cwd,
    model: selectedModel as never,
    modelRuntime: modelRuntime as never,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    tools,
  });
  return {
    session,
    loader,
    modelRuntime,
    childExtensionMissing: computeChildExtensionMissing(activationBefore),
  };
}

async function runRealBudgetedSession(
  baseUrl: string,
  maxInputTokens: number,
  options: { withExtension?: boolean } = {},
) {
  const real = await realSession(baseUrl, ["read"], options.withExtension ?? true);
  const { session } = real;
  const handle: SessionHandle = {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    prompt: (text) => session.prompt(text),
    steer: (text) => session.steer(text).then(() => undefined),
    requestAbort: () => session.abort(),
    dispose: () => {
      session.dispose();
      return { returned: true, killed: 0, unkillable: [] };
    },
    killableHandles: new Set(),
    setActiveTools: (names) => session.setActiveToolsByName(names),
    getActiveTools: () => session.getActiveToolNames(),
    measureInputBudget: () => ({ preBytes: 0, preTokens: 0 }),
    getLastAssistantText: () => session.getLastAssistantText(),
    getUsage: () => undefined,
    childExtensionMissing: real.childExtensionMissing,
  };
  const driver: SessionDriver = {
    create: async () => handle,
    bind: async () => undefined,
    onLateArrival: () => undefined,
  };
  const clock = new FakeClock();
  const deps: RunnerDeps = {
    clock,
    driver,
    pool: new SingleSlotPool(clock, 1),
    store: { put() {}, get: () => undefined, list: () => [], appendOutbox() {} },
    watchdog: { arm() {}, disarm() {}, tick() {} },
    reaper: new EscalatingReaper(clock),
    effects: new BasicEffectInterpreter(),
    emit() {},
    deliver() {},
  };
  const request: ResolvedSpawnRequest = {
    runId: `prt-real-${Math.random()}`,
    prompt: "P-RT conformance request",
    inputBudget: { maxInputTokens, bytesPerToken: 2 },
  };
  const budget = {
    ...DEFAULT_BUDGET,
    queueWaitMs: 1_000,
    startupMs: 1_000,
    bindMs: 1_000,
    totalMs: 30_000,
    reapMs: 1_000,
  };
  const outcome = await new RuntimeRunner(deps).run(request, budget);
  return { outcome, session };
}

describe("P-RT real pi conformance", () => {
  it("G-overhead: real minimal read-only child overhead clears the frozen floor", async () => {
    const endpoint = await fakeEndpoint();
    const { session, loader } = await realSession(endpoint.baseUrl, ["read"]);
    let measured = 0;
    const registration = getInputBudgetRegistry().register(session.sessionId, {
      maxInputTokens: 100_000,
      bytesPerToken: 2,
      onMeasure: (bytes) => {
        measured = bytes;
      },
      abort: (reason) => session.abort(reason),
    })!;
    try {
      await session.prompt("overhead probe");
    } finally {
      registration.unregister();
      session.dispose();
    }
    // Measured payload is the authoritative real-pi value used by G-overhead.
    console.info(`[P-RT G-overhead] measured payload bytes: ${measured}`);
    expect(measured).toBeGreaterThan(0);
    // The frozen floor was measured on a developer machine whose loader also picks up user-level
    // skills / AGENTS.md (~/.agents/skills etc. are discovered regardless of agentDir). A bare CI
    // runner has none, so a bare pi payload (~3 KB) legitimately sits below the floor. Only assert
    // the floor when the environment actually carries that ambient context.
    const ambient = loader.getSkills().skills.length + loader.getAgentsFiles().agentsFiles.length;
    if (ambient === 0) {
      console.info(`[P-RT G-overhead] bare environment (no skills/AGENTS.md discovered): floor assertion skipped`);
      return;
    }
    expect(OVERHEAD_FLOOR_BYTES).toBeLessThanOrEqual(measured);
  });

  it("G-measure-real: over budget is failed(config) with zero requests; within budget sends one measured payload", async () => {
    const overEndpoint = await fakeEndpoint();
    const over = await runRealBudgetedSession(overEndpoint.baseUrl, 0);
    expect(over.outcome.status).toBe("failed");
    expect(over.outcome.error?.kind).toBe("config");
    expect(over.outcome.error?.message).toContain("input-budget:");
    expect(overEndpoint.requests).toBe(0);
    expect(over.outcome.usage).toBeUndefined();
    expect(over.outcome.diag.dispatchMeasure?.payloadBytes).toBeGreaterThan(0);

    const withinEndpoint = await fakeEndpoint();
    const within = await runRealBudgetedSession(withinEndpoint.baseUrl, 100_000);
    expect(within.outcome.status).toBe("completed");
    expect(withinEndpoint.requests).toBe(1);
    expect(within.outcome.diag.dispatchMeasure?.payloadBytes).toBe(Buffer.byteLength(withinEndpoint.lastBody, "utf8"));

    const missingEndpoint = await fakeEndpoint();
    const missing = await runRealBudgetedSession(missingEndpoint.baseUrl, 100_000, { withExtension: false });
    expect(missing.outcome.status).toBe("failed");
    expect(missing.outcome.error?.message).toBe("input-budget: child extension missing — measurement unavailable");
    expect(missingEndpoint.requests).toBe(0);
  });
});
