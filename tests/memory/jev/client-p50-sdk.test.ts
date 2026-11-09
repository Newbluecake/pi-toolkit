/** Offline SDK regression: no mock complete/runtime/provider, only HTTP fetch
 * is replaced by deterministic SSE. Temp models/auth, no network or real key.
 * No socket/child process/real waits; intentionally tier1. */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createJevClient,
  createRegistryRevisionTransport,
  independentCoverageSources,
  prepareRevisionOutbound,
  revisionRequestDigests,
} from "../../../src/memory/jev/client.js";
import type {
  RegistryRevisionBinding,
  RevisionBlockInput,
  RevisionCoverageRequest,
  RevisionGenerateRequest,
  RevisionRegistryLike,
  RevisionTransportResult,
} from "../../../src/memory/jev/contracts.js";
import { jevConfigOf } from "../../../src/memory/jev/config.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";

const provider = "p50-sdk-offline";
const goodBody = "# Rules\n\n- Keep the shared budget.\n- Preserve all valid constraints.";
const knownUsage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const reserve = 0.008576; // exact host quote: (4096*2 + 128*3)/1e6
const unavailable = { kind: "unavailable", reason: "revision-unavailable" };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function sse(
  options: {
    body?: string;
    actual?: string | null;
    usage?: unknown;
    choiceUsage?: boolean;
    finish?: string | null;
    secondModel?: string;
  } = {},
) {
  const model = options.actual === null ? {} : { model: options.actual ?? "backend-gen" };
  const first = frame({
    id: "offline-completion",
    object: "chat.completion.chunk",
    ...model,
    choices: [
      {
        index: 0,
        delta: { content: options.body ?? goodBody },
        finish_reason: options.finish === undefined ? "stop" : options.finish,
      },
    ],
  });
  const usage =
    options.usage === undefined
      ? ""
      : frame({
          id: "offline-completion",
          object: "chat.completion.chunk",
          ...(options.secondModel === undefined ? model : { model: options.secondModel }),
          ...(options.choiceUsage
            ? { choices: [{ index: 0, delta: {}, usage: options.usage }] }
            : { choices: [], usage: options.usage }),
        });
  return first + usage + "data: [DONE]\n\n";
}
const target: RevisionBlockInput = {
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
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function harness(
  options: {
    frames?: string[];
    models?: string[];
    judges?: string[];
    free?: boolean;
    evidence?: boolean;
    routeActual?: (chain: string) => string;
    beforeResponse?: () => Promise<void>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "p50-b-sdk-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  const ids = ["alias1", "alias2", "fallback", "judge"];
  writeFileSync(
    join(root, "models.json"),
    JSON.stringify({
      providers: {
        [provider]: {
          api: "openai-completions",
          baseUrl: "https://p50-offline.invalid/v1",
          apiKey: "synthetic-offline-not-a-real-key",
          models: ids.map((id) => ({
            id,
            name: id,
            api: "openai-completions",
            reasoning: false,
            input: ["text"],
            contextWindow: 200000,
            maxTokens: 4096,
            cost: { input: options.free ? 0 : 2, output: options.free ? 0 : 3, cacheRead: 0, cacheWrite: 0 },
            compat: { maxTokensField: "max_tokens", supportsUsageInStreaming: true },
            // A maxTokens option alone is insufficient: last-hop must override this.
            samplingParams: { max_tokens: 999999, max_completion_tokens: 888888, max_output_tokens: 777777 },
          })),
        },
      },
    }),
  );
  const calls: { url: string; payload: Record<string, unknown> }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    expect(url).toBe("https://p50-offline.invalid/v1/chat/completions");
    expect(init?.method).toBe("POST");
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    // Actual OpenAI SDK serialized HTTP payload, not an onPayload spy.
    expect(payload["max_tokens"]).toBe(128);
    expect(payload).not.toHaveProperty("max_completion_tokens");
    expect(payload).not.toHaveProperty("max_output_tokens");
    expect(payload["stream"]).toBe(true);
    expect(payload["stream_options"]).toEqual({ include_usage: true });
    calls.push({ url, payload });
    await options.beforeResponse?.(); // controllable HTTP promise may ignore abort
    const wire = options.frames?.[calls.length - 1] ?? sse({ usage: knownUsage });
    return new Response(wire, { headers: { "Content-Type": "text/event-stream" } });
  };
  vi.stubGlobal("fetch", fakeFetch); // the ONLY fake in the SDK transport chain
  const runtime = await ModelRuntime.create({
    modelsPath: join(root, "models.json"),
    authPath: join(root, "auth.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  expect(registry.getError()).toBeUndefined();
  expectTypeOf<ModelRegistry>().toMatchTypeOf<RevisionRegistryLike>();
  const raw: RevisionTransportResult[] = [];
  const bindings: RegistryRevisionBinding[] = ids.map((id) => {
    const model = registry.find(provider, id);
    if (model === undefined) throw new Error("offline SDK model missing");
    return {
      registry,
      model,
      requestChainId: `${provider}/${id}`,
      adapterId: "pi-1.5/openai-completions",
      chainVersion: "offline-conformance-v1",
      maxTokensEnforced: true,
      outputLimitField: "max_tokens",
      maxOutputTokens: 128,
      ...(options.evidence === false ? {} : { resultEvidence: "openai-completions" as const }),
      quoteInput: () => ({ maxInputTokens: 4096, priceUsdPerMillion: { input: 2, output: 3 } }),
      resolveRoute(result) {
        raw.push(result);
        // Trusted local catalog mapping, NOT copied from returned model.
        const actual = options.routeActual?.(id) ?? (id === "judge" ? "backend-judge" : "backend-gen");
        return {
          provider,
          model: actual,
          routeIdentity: hash(`${provider}/${actual}`),
          routeAliases: [`${provider}/${id}`, `${provider}/${actual}`],
        };
      },
    };
  });
  const client = createJevClient({
    config: { ...jevConfigOf(DEFAULT_MEMORY_SETTINGS), proxy: "", maxCalls: 100, maxCostUsd: 10 },
    now: Date.now,
    isChild: false,
    p50: {
      enabled: true,
      revision: {
        transport: createRegistryRevisionTransport(bindings),
        models: (options.models ?? ["alias1"]).map((id) => `${provider}/${id}`),
        coverageModels: (options.judges ?? ["judge"]).map((id) => `${provider}/${id}`),
      },
    },
  });
  cleanups.push(() => client.dispose());
  const request = (patch: Partial<RevisionGenerateRequest> = {}): RevisionGenerateRequest => ({
    registry,
    instruction: "rewrite-single",
    target,
    mode: "sync",
    budgetMs: 2000,
    maxOutputTokens: 128,
    jobCostCapUsd: 1,
    ...patch,
  });
  const coverageRequest = (patch: Partial<RevisionCoverageRequest> = {}): RevisionCoverageRequest => ({
    registry,
    target,
    candidateBody: goodBody,
    mode: "background",
    budgetMs: 2000,
    maxOutputTokens: 128,
    jobCostCapUsd: 1,
    ...patch,
  });
  return { client, registry, raw, calls, request, coverageRequest };
}
function expected(request: RevisionGenerateRequest | RevisionCoverageRequest, purpose: "generate" | "coverage") {
  const frozen = prepareRevisionOutbound(request, purpose);
  if (frozen === undefined) throw new Error("expected admitted frozen input");
  return revisionRequestDigests(frozen.outbound, request.maxOutputTokens);
}
function sourceBindings(generation: ReturnType<typeof expected>, coverage: ReturnType<typeof expected>) {
  return { relation: generation, generation, coverage };
}

describe("P50 B real ModelRegistry.complete → ModelRuntime → openai-completions → fakeFetch SSE", () => {
  it.each([
    ["missing usage", {}],
    ["null usage", { usage: null }],
    [
      "incomplete counters (SDK defaults missing completion to zero)",
      { usage: { prompt_tokens: 10, total_tokens: 10 } },
    ],
    ["negative counters", { usage: { prompt_tokens: -10, completion_tokens: 5, total_tokens: -5 } }],
    ["inconsistent counters", { usage: { ...knownUsage, total_tokens: 99 } }],
    ["errored stop even with full usage", { usage: knownUsage, finish: "content_filter" }],
    ["incomplete stream even with full usage", { usage: knownUsage, finish: null }],
  ] as const)("%s charges A reserve and refuses a second same-job dispatch", async (_name, streamOptions) => {
    const h = await harness({ frames: [sse(streamOptions)] });
    const req = h.request({ jobId: "one-reserve-only", jobCostCapUsd: reserve });
    const first = await h.client.generateRevision(req);
    if (!("finish" in streamOptions)) {
      expect(first).toMatchObject({ kind: "ok", costUsd: reserve });
      if (!first || first.kind !== "ok") throw new Error("expected valid body");
      // Usage evidence and actual identity are independent.
      expect(first.provenance).toMatchObject({ model: "backend-gen", trusted: true });
    } else expect(first).toEqual(unavailable);
    expect(h.client.usage()).toMatchObject({
      calls: 1,
      costUsd: reserve,
      budget: {
        costSource: "reserve",
        outstanding: 0,
        zombies: 0,
        reservedCostUsd: 0,
      },
    });
    expect(await h.client.generateRevision(req)).toEqual(unavailable);
    expect(h.calls).toHaveLength(1);
    if (_name === "missing usage") {
      expect(h.raw[0]).toMatchObject({ model: "alias1", responseModel: "backend-gen", usage: { cost: { total: 0 } } });
    }
  });

  it.each([false, true])("complete observed usage is known, including true free SDK zero (free=%s)", async (free) => {
    const h = await harness({ free, frames: [sse({ usage: knownUsage }), sse({ usage: knownUsage })] });
    const req = h.request({ jobId: "known-cost", jobCostCapUsd: reserve * (free ? 1 : 2) });
    const cost = free ? 0 : (10 * 2 + 5 * 3) / 1e6;
    expect(await h.client.generateRevision(req)).toMatchObject({ kind: "ok", costUsd: cost });
    expect(h.client.usage()).toMatchObject({ costUsd: cost, budget: { costSource: "usage" } });
    expect(await h.client.generateRevision(req)).toMatchObject({ kind: "ok", costUsd: cost });
    expect(h.calls).toHaveLength(2);
    expect(h.client.usage().costUsd).toBeCloseTo(cost * 2, 12);
  });

  it("SDK length stop never publishes a truncated body but still settles known usage", async () => {
    const h = await harness({ frames: [sse({ finish: "length", usage: knownUsage })] });
    expect(await h.client.generateRevision(h.request())).toEqual(unavailable);
    expect(h.client.usage()).toMatchObject({ calls: 1, costUsd: 0.000035, budget: { costSource: "usage" } });
    expect(h.calls).toHaveLength(1);
  });

  it("explicit complete zero-token usage is known zero, unlike SDK initialized zeros", async () => {
    const h = await harness({ frames: [sse({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })] });
    expect(await h.client.generateRevision(h.request())).toMatchObject({ kind: "ok", costUsd: 0 });
    expect(h.client.usage()).toMatchObject({ costUsd: 0, budget: { costSource: "usage" } });
  });

  it("raw response identity equal to requested alias is verified even when SDK omits responseModel", async () => {
    const h = await harness({ routeActual: () => "alias1", frames: [sse({ actual: "alias1", usage: knownUsage })] });
    expect(await h.client.generateRevision(h.request())).toMatchObject({
      kind: "ok",
      provenance: {
        requestedModel: "alias1",
        model: "alias1",
        canonicalModel: "alias1",
        trusted: true,
      },
    });
    expect(h.raw[0]).not.toHaveProperty("responseModel");
  });

  it("choice.usage fallback supplies complete raw evidence too", async () => {
    const h = await harness({ frames: [sse({ usage: knownUsage, choiceUsage: true })] });
    expect(await h.client.generateRevision(h.request())).toMatchObject({ kind: "ok", costUsd: 0.000035 });
    expect(h.client.usage().budget!.costSource).toBe("usage");
  });

  it("absence of verified observer is reserve + untrusted, not inferred from valid result fields", async () => {
    const h = await harness({
      evidence: false,
      frames: [sse({ body: '{"verdict":"complete"}', actual: "backend-judge", usage: knownUsage })],
    });
    expect(await h.client.judgeRevisionCoverage(h.coverageRequest())).toMatchObject({
      kind: "ok",
      verdict: "unknown",
      costUsd: reserve,
      provenance: { trusted: false, provider: "", model: "", requestedModel: "judge", routeIdentity: "unknown" },
    });
    expect(h.client.usage().budget!.costSource).toBe("reserve");
  });

  it("binds requested, actual and canonical separately; legal alias permits positive independent coverage", async () => {
    const h = await harness({
      frames: [
        sse({ usage: knownUsage }),
        sse({ body: '{"verdict":"complete"}', actual: "backend-judge", usage: knownUsage }),
      ],
    });
    const genRequest = h.request();
    const judgeRequest = h.coverageRequest();
    const gen = await h.client.generateRevision(genRequest);
    const judge = await h.client.judgeRevisionCoverage(judgeRequest);
    expect(gen).toMatchObject({
      kind: "ok",
      body: goodBody,
      provenance: {
        requestedProvider: provider,
        requestedModel: "alias1",
        provider,
        model: "backend-gen",
        canonicalProvider: provider,
        canonicalModel: "backend-gen",
        trusted: true,
      },
    });
    expect(judge).toMatchObject({
      kind: "ok",
      verdict: "complete",
      provenance: {
        requestedModel: "judge",
        model: "backend-judge",
        canonicalModel: "backend-judge",
        trusted: true,
      },
    });
    if (gen.kind !== "ok" || judge.kind !== "ok") throw new Error("missing successful evidence");
    const bindings = sourceBindings(expected(genRequest, "generate"), expected(judgeRequest, "coverage"));
    expect(independentCoverageSources(gen.provenance, gen.provenance, judge.provenance, bindings)).toBe(true);
    expect(h.raw[0]).toMatchObject({ model: "alias1", responseModel: "backend-gen" });
    expect(h.calls.map((c) => c.payload["model"])).toEqual(["alias1", "judge"]);
  });

  it("alias1 and alias2 resolving to the SAME backend are trusted but not independent", async () => {
    const h = await harness({
      judges: ["alias2"],
      frames: [sse({ usage: knownUsage }), sse({ body: '{"verdict":"complete"}', usage: knownUsage })],
    });
    const g = h.request();
    const c = h.coverageRequest();
    const gen = await h.client.generateRevision(g);
    const judge = await h.client.judgeRevisionCoverage(c);
    expect(gen).toMatchObject({
      kind: "ok",
      provenance: { requestedModel: "alias1", model: "backend-gen", trusted: true },
    });
    expect(judge).toMatchObject({
      kind: "ok",
      provenance: { requestedModel: "alias2", model: "backend-gen", trusted: true },
    });
    if (gen.kind !== "ok" || judge.kind !== "ok") throw new Error("missing evidence");
    expect(
      independentCoverageSources(
        gen.provenance,
        gen.provenance,
        judge.provenance,
        sourceBindings(expected(g, "generate"), expected(c, "coverage")),
      ),
    ).toBe(false);
  });

  it("failover records successful fallback actual identity and accounts failed SDK attempt", async () => {
    const h = await harness({
      models: ["alias1", "fallback"],
      judges: ["judge", "alias2"],
      frames: [
        sse({ finish: "content_filter" }),
        sse({ usage: knownUsage }),
        sse({ actual: "backend-judge", finish: "content_filter" }),
        sse({ body: '{"verdict":"complete"}', usage: knownUsage }),
      ],
    });
    const g = h.request();
    const c = h.coverageRequest();
    const gen = await h.client.generateRevision(g);
    const judge = await h.client.judgeRevisionCoverage(c);
    expect(gen).toMatchObject({
      kind: "ok",
      costUsd: reserve + 0.000035,
      provenance: {
        requestChainId: `${provider}/fallback`,
        requestedModel: "fallback",
        model: "backend-gen",
        trusted: true,
      },
    });
    expect(judge).toMatchObject({
      kind: "ok",
      provenance: { requestChainId: `${provider}/alias2`, model: "backend-gen", trusted: true },
    });
    if (gen.kind !== "ok" || judge.kind !== "ok") throw new Error("missing fallback evidence");
    expect(
      independentCoverageSources(
        gen.provenance,
        gen.provenance,
        judge.provenance,
        sourceBindings(expected(g, "generate"), expected(c, "coverage")),
      ),
    ).toBe(false);
    expect(h.client.usage()).toMatchObject({ calls: 4, budget: { costSource: "mixed", outstanding: 0 } });
    expect(h.calls.map((v) => v.payload["model"])).toEqual(["alias1", "fallback", "judge", "alias2"]);
  });

  it.each([
    ["no raw response identity", { actual: null }, "backend-judge"],
    ["conflicting response model chunks", { actual: "backend-judge", secondModel: "another" }, "backend-judge"],
    ["canonical mismatch", { actual: "backend-other" }, "backend-judge"],
  ] as const)("%s fails closed even when canonical resolver claims a route", async (_name, patch, canonicalModel) => {
    const h = await harness({
      routeActual: () => canonicalModel,
      frames: [sse({ ...patch, usage: knownUsage, body: '{"verdict":"complete"}' })],
    });
    const result = await h.client.judgeRevisionCoverage(h.coverageRequest());
    expect(result).toMatchObject({
      kind: "ok",
      verdict: "unknown",
      provenance: { trusted: false, routeIdentity: "unknown", routeAliases: [] },
    });
    if (result.kind !== "ok") throw new Error("expected diagnostic result");
    expect(result.provenance).not.toHaveProperty("canonicalModel");
  });

  it.each([
    "delete: rules.001\nreason: obsolete",
    "remove: rules.001\nreason: obsolete",
    "- delete: rules.001\n  reason: obsolete",
    "'delete': 'rules.001'\nreason: obsolete",
    "Keep valid rules.\ndelete: rules.001\nreason: obsolete\nKeep other constraints.",
    'Keep valid rules. {"delete":"rules.001","reason":"obsolete"}',
    "Keep valid rules. {remove: rules.001, reason: obsolete}",
    "rename: rules.001\nto: rules.002",
    "move: blocks/rules.001.md\nreason: relocation",
    "delete: [rules.001]\nreason: obsolete",
    "*** Begin Patch\n*** Delete File: rules.001\n*** End Patch",
    "- action: delete\n  path: rules.001",
    'Keep valid rules.\n{"operations":[{"action":"delete","path":"rules.001"}]}\nMore prose.',
  ])("machine operation %s is invalid-output through the FULL SDK client chain", async (body) => {
    const h = await harness({ frames: [sse({ body, usage: knownUsage })] });
    const result = await h.client.generateRevision(h.request());
    expect(result).toEqual({ kind: "unavailable", reason: "invalid-output" });
    expect(result).not.toHaveProperty("body");
    expect(h.calls).toHaveLength(1);
    expect(h.client.usage()).toMatchObject({ calls: 1, costUsd: 0.000035, budget: { costSource: "usage" } });
    expect(h.raw[0]!.content).toEqual([{ type: "text", text: body }]);
  });

  it.each([
    "Delete: only after explicit confirmation.\nReason: preserve every valid rule.",
    "Do not delete rules.001; reason: it remains valid.",
    "Delete: never.\nKeep every valid constraint.",
  ])("normal Markdown mentioning deletion still passes the FULL SDK client chain: %s", async (body) => {
    const h = await harness({ frames: [sse({ body, usage: knownUsage })] });
    expect(await h.client.generateRevision(h.request())).toMatchObject({
      kind: "ok",
      body,
      outputDigest: hash(body),
      costUsd: 0.000035,
    });
    expect(h.calls).toHaveLength(1);
  });

  it("ignored HTTP abort keeps A zombie until original SDK promise settles, without double charging", async () => {
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetching = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let once = true;
    const h = await harness({
      beforeResponse: async () => {
        if (!once) return;
        once = false;
        entered();
        await barrier;
      },
    });
    const controller = new AbortController();
    const pending = h.client.generateRevision(h.request({ signal: controller.signal }));
    await fetching;
    controller.abort();
    expect(await pending).toEqual(unavailable);
    expect(h.client.usage()).toMatchObject({
      calls: 1,
      costUsd: reserve,
      budget: { outstanding: 1, zombies: 1, costSource: "reserve" },
    });
    expect(await h.client.generateRevision(h.request())).toEqual(unavailable);
    expect(h.calls).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(h.client.usage().budget).toMatchObject({ outstanding: 0, zombies: 0 }));
    // SDK's late aborted/error result is still unknown, not initialized-zero refund.
    expect(h.client.usage()).toMatchObject({
      calls: 1,
      costUsd: reserve,
      budget: { costSource: "reserve", adjustmentUsd: 0 },
    });
    expect(await h.client.generateRevision(h.request())).toMatchObject({ kind: "ok", costUsd: 0.000035 });
    expect(h.calls).toHaveLength(2);
    expect(h.client.usage().costUsd).toBeCloseTo(reserve + 0.000035, 12);
    expect(h.client.usage().budget!.costSource).toBe("mixed");
  });

  it("nonempty Jev proxy still refuses before any SDK HTTP dispatch", async () => {
    const h = await harness();
    const transport = createRegistryRevisionTransport([]);
    const client = createJevClient({
      config: { ...jevConfigOf(DEFAULT_MEMORY_SETTINGS), proxy: "http://unused.invalid", maxCostUsd: 1 },
      now: Date.now,
      isChild: false,
      p50: {
        enabled: true,
        revision: {
          transport,
          models: [`${provider}/alias1`],
          coverageModels: [`${provider}/judge`],
        },
      },
    });
    cleanups.push(() => client.dispose());
    expect(await client.generateRevision(h.request())).toEqual(unavailable);
    expect(h.calls).toHaveLength(0);
    expect(client.usage()).toMatchObject({ calls: 0, costUsd: 0 });
  });
});
