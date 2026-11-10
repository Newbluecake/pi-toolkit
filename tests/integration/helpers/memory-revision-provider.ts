/** Synthetic LOCAL byte-token protocol for the I1 isolated SDK/browser harness.
 * Not native registration, not production certification, never a real provider. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { classify } from "@earendil-works/pi-ai/api/typesafe-system-one";
import {
  createSdkP50Binding,
  type P50BindingResolver,
  type P50SdkBinding,
  type SdkP50BindingSpec,
} from "../../../src/memory/jev/p50-binding.js";

export async function revisionLabProvider(agentDir: string) {
  const provider = "i1-offline-byte-protocol";
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    authPath: join(agentDir, "lab-auth.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  registry.registerProvider(provider, {
    baseUrl: "https://memory-i1.invalid/v1",
    apiKey: "synthetic-local-only",
    classifiers: { "typesafe-system-one": { classify } },
    models: [
      ...["generation", "coverage"].map((id) => ({
        id,
        name: id,
        api: "openai-completions" as const,
        input: ["text" as const],
        reasoning: false,
        contextWindow: 64000,
        maxTokens: 2048,
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        compat: { maxTokensField: "max_tokens" as const, supportsUsageInStreaming: true },
      })),
      {
        id: "relation",
        name: "relation",
        type: "classifier",
        api: "typesafe-system-one",
        input: ["text"],
        contextWindow: 64000,
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  await runtime.refresh({ allowNetwork: false });
  const calls: { kind: string; bounded: boolean }[] = [];
  const originalFetch = globalThis.fetch;
  const offlineFetch: typeof fetch = async (url, init) => {
    const target = new URL(typeof url === "string" || url instanceof URL ? url : url.url);
    if (target.hostname === "127.0.0.1" || target.hostname === "localhost") return originalFetch(url, init);
    if (target.origin !== "https://memory-i1.invalid") throw Error("I1 harness forbids external network");
    const p = JSON.parse(String(init?.body)) as Record<string, any>;
    const kind = String(p.model);
    calls.push({ kind, bounded: p.max_output_tokens !== undefined || p.max_tokens !== undefined });
    if (kind === "relation") {
      const answers = Object.fromEntries(
        Object.entries(p.questions as Record<string, any>).map(([id, q]) => [
          id,
          q.type === "noul"
            ? { type: "noul", noul: 0.05 }
            : q.type === "bool"
              ? { type: "bool", bool: false }
              : q.type === "score"
                ? { type: "score", score: 1, confidence: 0.99 }
                : {
                    type: "choice",
                    choice:
                      id === "revisionRelation"
                        ? "conflict"
                        : Object.keys(q.criteria).includes("unrelated")
                          ? "unrelated"
                          : Object.keys(q.criteria)[0],
                    probabilities: Object.fromEntries(
                      Object.keys(q.criteria).map((k) => [
                        k,
                        k === (id === "revisionRelation" ? "conflict" : "unrelated") ? 0.99 : 0.005,
                      ]),
                    ),
                    confidence: 0.99,
                  },
        ]),
      );
      return new Response(
        JSON.stringify({
          answers,
          usage: { input_tokens: 10, output_tokens: 5 },
          p50: { provider, model: "backend-relation" },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    if (p.max_tokens !== 2048) throw Error("actual SDK last payload cap missing");
    const body =
      kind === "coverage"
        ? '{"verdict":"complete"}'
        : "Preserve the complete frozen constraints under the original directory lock.";
    return new Response(
      [
        {
          id: "local",
          object: "chat.completion.chunk",
          model: `backend-${kind}`,
          choices: [{ index: 0, delta: { content: body }, finish_reason: "stop" }],
        },
        {
          id: "local",
          object: "chat.completion.chunk",
          model: `backend-${kind}`,
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ]
        .map((row) => `data: ${JSON.stringify(row)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  globalThis.fetch = offlineFetch;
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  const contentTokens = (messages: readonly { content: unknown }[]) =>
    messages.reduce((n, m) => n + bytes(m.content) + 8, 0);
  let binding: P50SdkBinding | undefined, actualRegistry: object | undefined;
  const resolve: P50BindingResolver = (r) => {
    if (actualRegistry && actualRegistry !== r) return { kind: "unsupported", reason: "binding-invalid" };
    if (!binding) {
      actualRegistry = r;
      const sdk = r as SdkP50BindingSpec["registry"] & ModelRegistry;
      const route = (id: string) => ({
        provider,
        model: `backend-${id}`,
        routeIdentity: hash(`${provider}/backend-${id}`),
        routeAliases: [`${provider}/${id}`, `${provider}/backend-${id}`],
      });
      const chat = (id: string) => ({
        requestChainId: `${provider}/${id}`,
        model: sdk.find(provider, id)!,
        route: route(id),
        tokens: {
          protocolEvidence: "Synthetic lab-only byte-token chat; NOT a certified production transport",
          tokenizerEvidence: "Local test vocabulary: JSON(content) UTF8 plus 8 per message",
          priceUsdPerMillion: { input: 1, output: 1 },
          quoteInput: (ctx: import("../../../src/memory/jev/contracts.js").RevisionTransportContext) =>
            contentTokens([{ content: ctx.systemPrompt }, ...ctx.messages]),
          countPayload: (payload: Readonly<Record<string, unknown>>) =>
            contentTokens(payload.messages as { content: unknown }[]),
        },
      });
      binding = createSdkP50Binding({
        registry: sdk,
        adapterVersion: "i1-lab-only-v1",
        budgetMs: 6000,
        maxOutputTokens: 2048,
        classifyMaxOutputTokens: 128,
        classifiers: [
          {
            requestChainId: `${provider}/relation`,
            model: sdk.getModelOfType("classifier", provider, "relation")!,
            route: route("relation"),
            tokens: {
              protocolEvidence: "Synthetic bounded SystemOne extension; NOT stock support",
              tokenizerEvidence: "Local exact JSON byte vocabulary",
              priceUsdPerMillion: { input: 1, output: 1 },
              quoteInput: (ctx) =>
                bytes({
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
        generation: [chat("generation")],
        coverage: [chat("coverage")],
      });
    }
    return binding ? { kind: "ready", binding } : { kind: "unsupported", reason: "binding-invalid" };
  };
  return {
    runtime,
    provider,
    resolve,
    calls,
    dispose() {
      if (globalThis.fetch === offlineFetch) globalThis.fetch = originalFetch;
    },
  };
}
