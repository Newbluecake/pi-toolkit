// I2 owned SDK laboratory. Contract is explicitly synthetic: byte-token
// accounting plus a local SSE service, NOT certification of any stock provider.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createJevClient, type CreateJevClientDeps } from "../../../src/memory/jev/client.js";
import type { RevisionBlockInput, RevisionGenerateRequest } from "../../../src/memory/jev/contracts.js";
import { jevConfigOf } from "../../../src/memory/jev/config.js";
import { createSdkP50Binding, type SdkP50BindingSpec } from "../../../src/memory/jev/p50-binding.js";
import { registryOf } from "../../../src/memory/jev/wire.js";
import { classify as sdkClassify } from "@earendil-works/pi-ai/api/typesafe-system-one";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import { deferred, streamLab, type streamTestCertificates } from "./memory-proxy-stream.js";

export const provider = "i2-owned-synthetic";
export const body = "Keep the shared budget. Preserve every valid constraint.";
export const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
export const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
export function chunk(content = body, model: string | null = "backend-gen", finish: string | null = "stop") {
  return { ...(model === null ? {} : { model }), choices: [{ index: 0, delta: { content }, finish_reason: finish }] };
}
export function reply(res: ServerResponse, options: { model?: string | null; usage?: unknown; content?: string } = {}) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(frame(chunk(options.content, options.model)));
  if (options.usage !== undefined) res.write(frame({ choices: [], usage: options.usage }));
  res.end("data: [DONE]\n\n");
}
export const target: RevisionBlockInput = {
  id: "rules.001",
  rev: "1-abcdef",
  authority: "agent",
  topic: "rules",
  body: "Keep the shared budget.",
  private: false,
  secret: false,
  parseErrors: [],
  status: "active",
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const contentTokens = (messages: readonly { content: unknown }[]) =>
  messages.reduce((n, m) => n + 8 + bytes(m.content), 0);

export async function sdkProxyLab(
  certificates: ReturnType<typeof streamTestCertificates>,
  handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => reply(res, { usage }),
  connectReply?: string,
  afterPayload?: () => void,
) {
  const lab = await streamLab(certificates, handler, connectReply);
  const root = mkdtempSync(join(tmpdir(), "i2-sdk-proxy-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  const firstParsed = deferred();
  const events: unknown[] = [];
  const attempts: { maxRetries: unknown; hasFetch: boolean; signal: AbortSignal | undefined }[] = [];
  // Observation tap only. Every call delegates to the REAL ModelRegistry.complete
  // and real ModelRuntime/provider/OpenAI SDK; no fabricated result or Promise.
  const complete = ModelRegistry.prototype.complete;
  const tap = vi.spyOn(ModelRegistry.prototype, "complete").mockImplementation(function (
    this: ModelRegistry,
    model,
    context,
    opts,
  ) {
    attempts.push({ maxRetries: opts?.maxRetries, hasFetch: typeof opts?.fetch === "function", signal: opts?.signal });
    return complete.call(this, model, context, {
      ...opts,
      ...(afterPayload === undefined
        ? {}
        : {
            async onPayload(payload: unknown, m: Parameters<NonNullable<NonNullable<typeof opts>["onPayload"]>>[1]) {
              const replacement = await opts?.onPayload?.(payload, m);
              // Test-only transition AFTER the real adapter's last payload
              // verifier, before the real SDK invokes its selected fetch.
              afterPayload();
              return replacement;
            },
          }),
      async onProviderStreamEvent(event, m) {
        events.push(event);
        await opts?.onProviderStreamEvent?.(event, m);
        firstParsed.resolve();
      },
    });
  });
  try {
    writeFileSync(
      join(root, "models.json"),
      JSON.stringify({
        providers: {
          [provider]: {
            api: "openai-completions",
            baseUrl: new URL("/v1", lab.url).href,
            models: ["gen", "judge"].map((id) => ({
              id,
              name: id,
              api: "openai-completions",
              reasoning: false,
              input: ["text"],
              contextWindow: 200000,
              maxTokens: 4096,
              cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
              compat: { maxTokensField: "max_tokens", supportsUsageInStreaming: true },
              samplingParams: { max_tokens: 9999, max_output_tokens: 8888, max_completion_tokens: 7777 },
            })),
          },
        },
      }),
    );
    const auth = new InMemoryCredentialStore();
    await auth.modify(provider, async () => ({ type: "api_key", key: "synthetic-old-runtime-token" }));
    const runtime = await ModelRuntime.create({
      credentials: auth,
      modelsPath: join(root, "models.json"),
      authPath: join(root, "auth.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    registry.registerProvider(provider, {
      classifiers: { "typesafe-system-one": { classify: sdkClassify } },
      baseUrl: new URL("/v1", lab.url).href,
      models: [
        ...JSON.parse(readFileSync(join(root, "models.json"), "utf8")).providers[provider].models,
        {
          id: "relation",
          name: "relation",
          type: "classifier",
          api: "typesafe-system-one",
          input: ["text"],
          contextWindow: 32000,
          cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    await runtime.refresh({ allowNetwork: false });
    const route = (id: string) => ({
      provider,
      model: `backend-${id}`,
      routeIdentity: hash(`${provider}/${id}`),
      routeAliases: [`${provider}/${id}`, `${provider}/backend-${id}`],
    });
    const chatRoute = (id: string) => ({
      requestChainId: `${provider}/${id}`,
      model: registry.find(provider, id)!,
      route: route(id),
      tokens: {
        protocolEvidence: "owned synthetic SSE/max_tokens contract only",
        tokenizerEvidence: "owned byte-token vocabulary plus 8 tokens/message, not stock",
        priceUsdPerMillion: { input: 2, output: 3 },
        quoteInput: (ctx: import("../../../src/memory/jev/contracts.js").RevisionTransportContext) =>
          contentTokens([{ content: ctx.systemPrompt }, ...ctx.messages]),
        countPayload: (p: Readonly<Record<string, unknown>>) => contentTokens(p.messages as { content: unknown }[]),
      },
    });
    const spec: SdkP50BindingSpec = {
      // The existing classifier structural mirror is intentionally buffered.
      // Use the production context boundary (same actual object), not a fetch cast.
      registry: registryOf({ modelRegistry: registry })! as SdkP50BindingSpec["registry"],
      adapterVersion: "i2-synthetic-sdk-1.5-v1",
      budgetMs: 3000,
      maxOutputTokens: 128,
      classifyMaxOutputTokens: 128,
      streamingProxy: { proxy: lab.proxyUrl, options: { ca: certificates.ca, timeoutMs: 3000 } },
      classifiers: [
        {
          requestChainId: `${provider}/relation`,
          model: registry.getModelOfType("classifier", provider, "relation")!,
          route: route("relation"),
          tokens: {
            protocolEvidence: "owned bounded classify protocol only",
            tokenizerEvidence: "owned byte tokens only",
            priceUsdPerMillion: { input: 2, output: 3 },
            quoteInput: (ctx) => bytes(ctx) + 100,
            countPayload: bytes,
          },
        },
      ],
      generation: [chatRoute("gen")],
      coverage: [chatRoute("judge")],
    };
    const binding = createSdkP50Binding(spec);
    if (!binding) throw Error("owned SDK binding missing");
    const config = {
      ...jevConfigOf(DEFAULT_MEMORY_SETTINGS),
      classifiers: binding.classifiers,
      proxy: lab.proxyUrl,
      maxCalls: 100,
      maxCostUsd: 10,
    };
    const clients: ReturnType<typeof createJevClient>[] = [];
    function makeClient(
      p50: CreateJevClientDeps["p50"] = { enabled: true, current: () => binding },
      extra: Partial<CreateJevClientDeps> = {},
    ) {
      const client = createJevClient({
        config,
        now: Date.now,
        isChild: false,
        ...extra,
        ...(p50 === undefined ? {} : { p50 }),
      });
      clients.push(client);
      return client;
    }
    const client = makeClient();
    const request = (patch: Partial<RevisionGenerateRequest> = {}): RevisionGenerateRequest => ({
      registry,
      instruction: "rewrite-single",
      target,
      mode: "sync",
      budgetMs: 2500,
      maxOutputTokens: 128,
      jobCostCapUsd: 1,
      ...patch,
    });
    return {
      lab,
      runtime,
      auth,
      registry,
      spec,
      binding,
      config,
      client,
      makeClient,
      request,
      attempts,
      events,
      firstParsed: firstParsed.promise,
      async close() {
        for (const c of clients) c.dispose();
        tap.mockRestore();
        await lab.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    tap.mockRestore();
    await lab.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
