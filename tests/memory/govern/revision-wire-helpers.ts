/** Actual SDK + actual scopes proof + actual wireMemory/scheduler/C/D/E.
 * Only HTTP is offline. Test token contract is a deliberately specified
 * byte-token LOCAL protocol, not a production tokenizer or LIVE attestation. */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ModelRegistry, ModelRuntime, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { vi, expect, afterEach } from "vitest";
import { fakePi, emitAll, resetGlobals, BASELINE } from "../../integration/helpers/schedule-activate.js";
import { resetSecureDomainForTests } from "../../../src/secure/domain.js";
import { createPromptSectionHub } from "../../../src/sysprompt/hub.js";
import { loadSettings } from "../../../src/config/settings.js";
import { memoryDirFor } from "../../../src/memory/paths.js";
import { wireMemory } from "../../../src/memory/index.js";
import { wireMemoryScopes } from "../../../src/memory/scopes/wire.js";
import * as proxyModule from "../../../src/memory/jev/proxy-fetch.js";
import * as jevWire from "../../../src/memory/jev/wire.js";
import type { JevClientHandle } from "../../../src/memory/jev/client.js";
import { clearHealthTable } from "../../../src/memory/jev/health.js";
import { createSdkP50Binding, P50_SDK_BINDING, type P50SdkBinding } from "../../../src/memory/jev/p50-binding.js";
import { readIndex } from "../../../src/memory/jev/index-store.js";
import { classify as sdkClassify } from "@earendil-works/pi-ai/api/typesafe-system-one";
import activate from "../../../src/index.js";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
  clearHealthTable();
  resetGlobals();
  resetSecureDomainForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
const provider = "p50-wire-offline";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const bytes = (s: unknown) => Buffer.byteLength(JSON.stringify(s));
const contentTokens = (messages: readonly { content: unknown }[]) =>
  messages.reduce((n, m) => n + bytes(m.content) + 8, 0);
export async function wireFixture(
  options: {
    root?: boolean;
    projectCwd?: string;
    cap?: number;
    auto?: boolean;
    off?: boolean;
    noBinding?: boolean;
    domain?: "plain" | "secure" | "locked";
    child?: boolean;
    scopesOff?: boolean;
    proxy?: string;
    noQuote?: boolean;
  } = {},
) {
  resetGlobals();
  resetSecureDomainForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-10T00:00:00.000Z"));
  const root = fs.mkdtempSync(join(tmpdir(), "p50-actual-wire-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = options.projectCwd ?? join(root, "project"),
    agentDir = join(root, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir);
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("PI_OFFLINE", "1");
  vi.stubEnv("ARMORY_MEMORY_ROOT", join(root, "memory"));
  const sourceSettings = {
    ...BASELINE,
    fast: { enabled: false },
    title: { enabled: false },
    quota: { enabled: false },
    load: { enabled: false },
    memory: {
      enabled: true,
      scopes: { session: !options.scopesOff, hub: false },
      migrate: { auto: false },
      doctor: { notifyOnStart: false },
      incremental: {
        ...(options.off ? { enabled: false } : {}),
        changeThreshold: 2,
        quietSec: 1,
        idleSec: 0,
        cooldownSec: 1,
        jobCostCapUsd: options.cap ?? 0.1,
        auto: options.auto ?? false,
      },
      jev: {
        enabled: true,
        proxy: options.proxy ?? "",
        classifiers: [`${provider}/relation`],
        predict: { enabled: false },
        maxCalls: 10000,
        maxCostUsd: 10,
      },
    },
  };
  fs.writeFileSync(join(agentDir, "pi-toolkit.json"), JSON.stringify(sourceSettings));
  const settings = loadSettings(sourceSettings).memory;
  expect(settings.incremental.jobCostCapUsd).toBe(options.cap ?? 0.1);
  fs.writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [provider]: {
          baseUrl: "https://p50-wire.invalid/v1",
          apiKey: "offline-synthetic-key-not-a-secret",
          models: [
            ...["generation", "coverage"].map((id) => ({
              id,
              name: id,
              api: "openai-completions",
              input: ["text"],
              reasoning: false,
              contextWindow: 32000,
              maxTokens: 2048,
              cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              compat: { maxTokensField: "max_tokens", supportsUsageInStreaming: true },
              samplingParams: { max_tokens: 99999, max_output_tokens: 88888, max_completion_tokens: 77777 },
            })),
          ],
        },
      },
    }),
  );
  const calls: { kind: string; payload: Record<string, any>; headers: Headers }[] = [];
  const proxyRequests: string[] = [];
  const state = {
    underquote: false,
    classifierStatus: 200,
    relation: "conflict",
    missingRaw: false,
    missingUsage: false,
    heldKind: "",
    hold: undefined as Promise<void> | undefined,
  };
  const fakeFetch: typeof fetch = async (url, init) => {
    expect(String(url)).toMatch(/^https:\/\/p50-wire.invalid\/v1\/(systemone|chat\/completions)$/);
    const p = JSON.parse(String(init?.body)),
      kind = p.model === "relation" ? "relation" : String(p.model);
    calls.push({ kind, payload: p, headers: new Headers(init?.headers) });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer offline-synthetic-key-not-a-secret");
    if (state.heldKind === kind) await state.hold;
    if (kind === "relation") {
      const bounded = p.max_output_tokens !== undefined;
      if (bounded && state.classifierStatus !== 200)
        return new Response("offline transient", { status: state.classifierStatus });
      if (bounded) {
        expect(p.max_output_tokens).toBe(128);
        expect(p).not.toHaveProperty("max_tokens");
      }
      const answers = Object.fromEntries(
        Object.entries(p.questions as Record<string, any>).map(([id, q]) => [
          id,
          q.type === "noul"
            ? { type: "noul", noul: 0.05 }
            : q.type === "score"
              ? { type: "score", score: 1, confidence: 0.99 }
              : {
                  type: "choice",
                  choice:
                    id === "revisionRelation"
                      ? state.relation
                      : Object.keys(q.criteria).includes("unrelated")
                        ? "unrelated"
                        : Object.keys(q.criteria)[0],
                  probabilities: Object.fromEntries(
                    Object.keys(q.criteria).map((k) => [
                      k,
                      k === (id === "revisionRelation" ? state.relation : "unrelated") ? 0.99 : 0.005,
                    ]),
                  ),
                  confidence: 0.99,
                },
        ]),
      );
      return new Response(
        JSON.stringify({
          answers,
          ...(!state.missingUsage ? { usage: { input_tokens: 10, output_tokens: 5 } } : {}),
          ...(!state.missingRaw ? { p50: { provider, model: "backend-relation" } } : {}),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    expect(p.max_tokens).toBe(2048);
    expect(p).not.toHaveProperty("max_output_tokens");
    expect(p).not.toHaveProperty("max_completion_tokens");
    const body =
      kind === "coverage" ? '{"verdict":"complete"}' : "Keep the budget and directory lock. Preserve both valid rules.";
    const frames = [
      {
        id: "offline",
        object: "chat.completion.chunk",
        ...(!state.missingRaw ? { model: `backend-${kind}` } : {}),
        choices: [{ index: 0, delta: { content: body }, finish_reason: "stop" }],
      },
      ...(!state.missingUsage
        ? [
            {
              id: "offline",
              object: "chat.completion.chunk",
              model: `backend-${kind}`,
              choices: [],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            },
          ]
        : []),
    ];
    return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  vi.stubGlobal("fetch", fakeFetch);
  if (options.proxy)
    vi.spyOn(proxyModule, "createProxyFetch").mockImplementation((proxy) => async (url, init) => {
      expect(proxy).toBe(options.proxy);
      proxyRequests.push(proxy);
      return fakeFetch(url, init);
    });
  const runtime = await ModelRuntime.create({
    modelsPath: join(agentDir, "models.json"),
    authPath: join(agentDir, "auth.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  expect(registry.getError()).toBeUndefined();
  registry.registerProvider(provider, {
    baseUrl: "https://p50-wire.invalid/v1",
    apiKey: "offline-synthetic-key-not-a-secret",
    classifiers: { "typesafe-system-one": { classify: sdkClassify } },
    models: [
      ...JSON.parse(fs.readFileSync(join(agentDir, "models.json"), "utf8")).providers[provider].models,
      {
        id: "relation",
        name: "relation",
        type: "classifier",
        api: "typesafe-system-one",
        input: ["text"],
        contextWindow: 32000,
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  await runtime.refresh({ allowNetwork: false });
  let binding: P50SdkBinding | undefined;
  const native = registry.getProvider(provider)!;
  const extended = { ...native, [P50_SDK_BINDING]: () => binding };
  if (!options.noBinding) registry.registerProvider(extended);
  await runtime.refresh({ allowNetwork: false });
  const route = (id: string) => ({
    provider,
    model: `backend-${id}`,
    routeIdentity: hash(`${provider}/backend-${id}`),
    routeAliases: [`${provider}/${id}`, `${provider}/backend-${id}`],
  });
  const chatRoute = (id: string) => ({
    requestChainId: `${provider}/${id}`,
    model: registry.find(provider, id)!,
    route: route(id),
    tokens: {
      protocolEvidence:
        "offline byte-token chat protocol; 8 tokens/message + UTF8 JSON(content), max_tokens enforced by fixture service",
      tokenizerEvidence: "fixture exact byte-token vocabulary, not a production tokenizer",
      priceUsdPerMillion: { input: 1, output: 1 },
      quoteInput: (ctx: import("../../../src/memory/jev/contracts.js").RevisionTransportContext) =>
        options.noQuote ? undefined : contentTokens([{ content: ctx.systemPrompt }, ...ctx.messages]),
      countPayload: (p: Readonly<Record<string, unknown>>) => contentTokens(p.messages as { content: unknown }[]),
    },
  });
  // The production registryOf structural boundary preserves the EXACT SDK
  // object. No fetch cast or wrapper registry/identity is introduced.
  const registryView = jevWire.registryOf({
    modelRegistry: registry,
  })! as import("../../../src/memory/jev/p50-binding.js").SdkP50BindingSpec["registry"];
  expect(registryView).toBe(registry);
  binding = createSdkP50Binding({
    registry: registryView,
    adapterVersion: "offline-certified-v1",
    budgetMs: 3000,
    maxOutputTokens: 2048,
    classifyMaxOutputTokens: 128,
    classifiers: [
      {
        requestChainId: `${provider}/relation`,
        model: registry.getModelOfType("classifier", provider, "relation")!,
        route: route("relation"),
        tokens: {
          protocolEvidence:
            "offline bounded SystemOne extension v1; max_output_tokens + raw p50 identity, authenticated fixture service",
          tokenizerEvidence: "fixture exact byte-token vocabulary for JSON(state, wire questions)",
          priceUsdPerMillion: { input: 1, output: 1 },
          quoteInput: (ctx) =>
            options.noQuote
              ? undefined
              : state.underquote
                ? 1
                : bytes({
                    state: ctx.state,
                    questions: Object.fromEntries(
                      Object.entries(ctx.questions).map(([id, q]) => [
                        id,
                        q.type === "bool" ? { ...q, type: "noul" } : q,
                      ]),
                    ),
                  }),
          countPayload: (p) => bytes({ state: p.state, questions: p.questions }),
        },
      },
    ],
    generation: [chatRoute("generation")],
    coverage: [chatRoute("coverage")],
  });
  expect(binding?.isCurrent()).toBe(true);
  const f = fakePi();
  const manager = SessionManager.inMemory(cwd);
  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    ui: {},
    sessionManager: manager,
    modelRegistry: registry,
    isIdle: () => true,
    hasPendingMessages: () => false,
  } as unknown as ExtensionContext;
  f.pi.appendEntry = (type, data) => manager.appendCustomEntry(type, data);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const observed: jevWire.WireJevResult[] = [];
  const realWire = jevWire.wireJev;
  vi.spyOn(jevWire, "wireJev").mockImplementation((...args) => {
    const result = realWire(...args);
    observed.push(result);
    return result;
  });
  const dir = memoryDirFor(cwd),
    blocks = join(dir, "blocks");
  fs.mkdirSync(blocks, { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(blocks, ".layout.json"), '{"v":1,"source":"fresh"}');
  let memoryScopes: ReturnType<typeof wireMemoryScopes>;
  if (options.root) activate(f.pi);
  else {
    const scopes = (memoryScopes = wireMemoryScopes(f.pi, {
      settings,
      child: options.child ?? false,
      domain: options.domain ?? "plain",
      gate: { check: () => ({ ok: true }) },
      locked: () => false,
      remote: () => undefined,
      hubPaths: () => undefined,
    }));
    const sections = createPromptSectionHub(f.pi, {
      mode: () => "stable",
      wakeReplay: false,
      adoptForeignForcedPrompt: false,
    });
    wireMemory(f.pi, {
      settings,
      ...(scopes ? { scopes } : {}),
      secureDomainKind: options.domain ?? "plain",
      isChildSession: options.child ?? false,
      sections,
    });
  }
  const emit = (name: string, event: object = {}) => emitAll(f, name, { type: name, ...event }, ctx);
  cleanups.push(async () => {
    await emit("session_shutdown", { reason: "shutdown" });
  });
  await emit("session_start", { reason: "startup" });
  await vi.advanceTimersByTimeAsync(0);
  const client = observed[0]?.client as JevClientHandle | undefined;
  const ask = client ? vi.spyOn(client, "ask") : undefined;
  const generate = client ? vi.spyOn(client, "generateRevision") : undefined;
  const coverage = client ? vi.spyOn(client, "judgeRevisionCoverage") : undefined;
  const create = async (body: string) => {
    const result = await f.tools
      .get("memory")!
      .execute("wire-create", { command: "create", topic: "rules", text: body }, undefined, undefined, ctx as never);
    expect(result.isError).not.toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    return result;
  };
  const writePair = async () => [
    await create("Keep the budget and directory lock."),
    await create("Preserve valid constraints with the directory lock."),
  ];
  const suggestions = () => readIndex(dir).index.review?.suggestions.filter((s) => s.revision) ?? [];
  return {
    ...f,
    cwd,
    dir,
    blocks,
    registry,
    runtime,
    memoryScopes,
    binding: binding!,
    observed,
    client,
    ask,
    generate,
    coverage,
    settings,
    state,
    calls,
    proxyRequests,
    emit,
    create,
    writePair,
    suggestions,
    warning,
    ctx,
    natural: async () => {
      await vi.advanceTimersByTimeAsync(1000);
    },
  };
}
