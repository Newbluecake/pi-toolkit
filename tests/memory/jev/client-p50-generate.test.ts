import { createHash } from "node:crypto";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createJevClient,
  createRegistryRevisionTransport,
  independentCoverageSources,
  prepareRevisionOutbound,
  revisionRequestDigests,
  revisionTransportContext,
} from "../../../src/memory/jev/client.js";
import type {
  CanonicalClassifyRoute,
  ClassifierRegistryLike,
  ControlledClassifyTransport,
  JevConfig,
  RegistryRevisionBinding,
  RevisionBlockInput,
  RevisionCoverageRequest,
  RevisionGenerateRequest,
  RevisionRegistryLike,
  RevisionTransportContext,
  RevisionTransportResult,
} from "../../../src/memory/jev/contracts.js";
import { jevConfigOf } from "../../../src/memory/jev/config.js";
import { clearHealthTable } from "../../../src/memory/jev/health.js";
import { DEFAULT_MEMORY_SETTINGS } from "../../../src/memory/settings.js";
import { redactForJev } from "../../../src/memory/jev/redact.js";
import { validateRevisionOutput } from "../../../src/memory/govern/revision-output.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const canonical = (v: unknown): string =>
  v !== null && typeof v === "object"
    ? Array.isArray(v)
      ? `[${v.map(canonical).join(",")}]`
      : `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
    : JSON.stringify(v);
const body = "Keep existing valid rules; use the shared client for every request.";
const block = (patch: Partial<RevisionBlockInput> = {}): RevisionBlockInput => ({
  id: "rules.001",
  rev: "1-abcdef",
  authority: "agent",
  topic: "rules",
  body: "Use the shared client.",
  private: false,
  secret: false,
  parseErrors: [],
  status: "active",
  ...patch,
});
const response = (
  text = body,
  provider = "actual",
  model = "generator",
  cost: number | undefined = 0.001,
): RevisionTransportResult => ({
  stopReason: "stop",
  content: [{ type: "text", text }],
  provider,
  model,
  ...(cost === undefined ? {} : { usage: { cost: { total: cost } } }),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

/** Executable local registry protocol, not a production capability claim.
 * Its token unit is a UTF-8 byte, including exact prompt + fixed 32 overhead.
 * The real factory adapter calls registry.complete -> onPayload -> enforced
 * local serializer limits -> returned identity/usage. No test dispatch stub
 * bypasses that chain for a successful body. No network or credentials. */
function harness(
  options: {
    enabled?: boolean;
    noAdapter?: boolean;
    models?: string[];
    coverageModels?: string[];
    config?: Partial<JevConfig>;
    respond?: (
      index: number,
      chain: string,
      context: RevisionTransportContext,
      signal: AbortSignal,
    ) => Promise<RevisionTransportResult> | RevisionTransportResult;
    quote?: RegistryRevisionBinding["quoteInput"];
    route?: (chain: string, result: RevisionTransportResult) => CanonicalClassifyRoute | undefined;
    bindingPatch?: Partial<RegistryRevisionBinding>;
  } = {},
) {
  const calls: {
    chain: string;
    context: RevisionTransportContext;
    maxTokens: number;
    maxRetries: number;
    signal: AbortSignal;
    payload: Record<string, unknown>;
  }[] = [];
  const models = options.models ?? ["gen/main"];
  const coverageModels = options.coverageModels ?? ["judge/main"];
  const canonicalRoute = (chain: string): CanonicalClassifyRoute => {
    const model = chain.startsWith("judge/") ? "judge" : "generator";
    return {
      provider: "actual",
      model,
      routeIdentity: hash(`actual/${model}`),
      routeAliases: [chain, `actual/${model}`],
    };
  };
  const registry: RevisionRegistryLike & ClassifierRegistryLike = {
    complete(model, context, opts) {
      const chain = (model as { chain: string }).chain;
      const payload = opts.onPayload({
        messages: context.messages,
        max_tokens: 999999,
        max_completion_tokens: 999999,
      }) as Record<string, unknown>;
      const field = options.bindingPatch?.outputLimitField ?? "max_tokens";
      if (
        payload[field] !== opts.maxTokens ||
        ["max_tokens", "max_completion_tokens", "max_output_tokens"].some((key) => key !== field && key in payload) ||
        opts.maxRetries !== 0
      )
        throw new Error("local serializer requires final enforced cap and no retries");
      calls.push({
        chain,
        context,
        maxTokens: opts.maxTokens,
        maxRetries: opts.maxRetries,
        signal: opts.signal,
        payload,
      });
      const value =
        options.respond?.(calls.length - 1, chain, context, opts.signal) ??
        response(chain.startsWith("judge/") ? '{"verdict":"complete"}' : body, "actual", canonicalRoute(chain).model);
      return Promise.resolve(value).then((r) => {
        const outputTokens = r.content.reduce((n, part) => n + Buffer.byteLength(part.text ?? ""), 0);
        return outputTokens > opts.maxTokens ? { ...r, stopReason: "length" } : r;
      });
    },
    getModelOfType: () => ({}),
    getAvailableOfType: async () => [{ provider: "relation", id: "main" }],
    classify: async () => ({
      stopReason: "stop",
      provider: "actual",
      model: "relation",
      answers: { q: { type: "bool", probability: 0.99 } },
      usage: { input: 1, cost: { total: 0.001 } },
    }),
  };
  const bindings: RegistryRevisionBinding[] = [...new Set([...models, ...coverageModels])].map((chain) => ({
    registry,
    requestChainId: chain,
    model: { chain },
    adapterId: "local-byte-protocol",
    chainVersion: "local-v1",
    maxTokensEnforced: true,
    outputLimitField: "max_tokens",
    maxOutputTokens: 4096,
    // This local byte protocol explicitly reports actual identity and cost;
    // unlike SDK AssistantMessage it has no default-zero usage or alias fill.
    resultEvidence: (r) => ({
      actual: { provider: r.provider, model: r.model },
      ...(r.usage?.cost === undefined ? {} : { costUsd: r.usage.cost.total }),
    }),
    quoteInput:
      options.quote ??
      ((ctx) => ({
        maxInputTokens: Buffer.byteLength(JSON.stringify(ctx)) + 32,
        priceUsdPerMillion: { input: 100, output: 100 },
      })),
    resolveRoute: (r) => (options.route === undefined ? canonicalRoute(chain) : options.route(chain, r)),
    ...options.bindingPatch,
  }));
  const revisionTransport = createRegistryRevisionTransport(bindings);
  const classifyTransport: ControlledClassifyTransport = {
    prepare: (input) => ({
      adapterId: "relation-local",
      chainVersion: "local-v1",
      bounds: { maxInputTokens: 1000, maxOutputTokens: 100, priceUsdPerMillion: { input: 100, output: 100 } },
      dispatch: (opts) => registry.classify!(input.model, input.context, opts),
      resolveRoute: () => ({
        provider: "actual",
        model: "relation",
        routeIdentity: hash("actual/relation"),
        routeAliases: ["relation/main", "actual/relation"],
      }),
    }),
  };
  const client = createJevClient({
    config: {
      ...jevConfigOf(DEFAULT_MEMORY_SETTINGS),
      classifiers: ["relation/main"],
      proxy: "",
      maxCalls: 1000,
      maxCostUsd: 1000,
      ...options.config,
    },
    now: Date.now,
    isChild: false,
    p50: {
      enabled: options.enabled ?? true,
      transport: classifyTransport,
      ...(options.noAdapter ? {} : { revision: { transport: revisionTransport, models, coverageModels } }),
    },
  });
  const request = (patch: Partial<RevisionGenerateRequest> = {}): RevisionGenerateRequest => ({
    registry,
    instruction: "rewrite-single",
    target: block(),
    maxOutputTokens: 2048,
    budgetMs: 2000,
    mode: "sync",
    jobCostCapUsd: 10,
    ...patch,
  });
  const coverageRequest = (patch: Partial<RevisionCoverageRequest> = {}): RevisionCoverageRequest => ({
    registry,
    target: block(),
    candidateBody: body,
    maxOutputTokens: 128,
    budgetMs: 2000,
    mode: "background",
    jobCostCapUsd: 10,
    ...patch,
  });
  return {
    client,
    calls,
    bindings,
    registry,
    revisionTransport,
    request,
    coverageRequest,
    generate: (patch: Partial<RevisionGenerateRequest> = {}) => client.generateRevision(request(patch)),
    coverage: (patch: Partial<RevisionCoverageRequest> = {}) => client.judgeRevisionCoverage(coverageRequest(patch)),
  };
}
afterEach(() => {
  vi.useRealTimers();
  clearHealthTable();
});
const unavailable = { kind: "unavailable", reason: "revision-unavailable" };

describe("P50 B real registry generation chain", () => {
  it("accepts the real SDK registry type without claiming streaming proxy support", async () => {
    expectTypeOf<ModelRegistry>().toMatchTypeOf<RevisionRegistryLike>();
    const h = harness({ config: { proxy: "http://127.0.0.1:1234" } });
    expect(await h.generate()).toEqual(unavailable);
    expect(h.calls).toHaveLength(0);
    expect(h.client.usage().calls).toBe(0);
  });

  it("valid body traverses final redaction, registry adapter, enforced maxTokens, validator and A ledger", async () => {
    const h = harness();
    const req = h.request({
      target: block({
        body: "Contact hello@example.test; use shared client.",
        section: "Maintainers hello@example.test",
      }),
    });
    const result = await h.client.generateRevision(req);
    expect(result).toMatchObject({
      kind: "ok",
      body,
      outputDigest: hash(body),
      costUsd: 0.001,
      inputComplete: false,
      provenance: { provider: "actual", model: "generator", requestChainId: "gen/main", trusted: true },
    });
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.maxTokens).toBe(2048);
    expect(call.maxRetries).toBe(0);
    expect(call.payload["max_tokens"]).toBe(2048);
    const outbound = JSON.parse(call.context.messages[0]!.content);
    expect(outbound).toEqual({
      purpose: "generate",
      instruction: "rewrite-single",
      target: {
        id: "rules.001",
        rev: "1-abcdef",
        authority: "agent",
        topic: "rules",
        section: "Maintainers [EMAIL]",
        body: redactForJev(req.target.body, "entry"),
      },
    });
    expect(JSON.stringify(call)).not.toContain("hello@example.test");
    expect(Object.isFrozen(call.context.messages[0])).toBe(true);
    expect(h.client.usage()).toMatchObject({
      calls: 1,
      costUsd: 0.001,
      budget: { reservedCostUsd: 0, reservedCalls: 0, outstanding: 0, zombies: 0, costSource: "usage" },
    });
    if (result.kind !== "ok") throw new Error("positive generation failed");
    expect(validateRevisionOutput(result.body)).toEqual({ ok: true, body, outputDigest: result.outputDigest });
    const expected = prepareRevisionOutbound(req, "generate")!;
    expect(result.provenance).toMatchObject(revisionRequestDigests(expected.outbound, req.maxOutputTokens));
  });

  it.each(["max_tokens", "max_completion_tokens", "max_output_tokens"] as const)(
    "enforces the verified last-hop serializer field %s and removes competing caps",
    async (field) => {
      const h = harness({ bindingPatch: { outputLimitField: field } });
      expect(await h.generate({ maxOutputTokens: 256 })).toMatchObject({ kind: "ok", body });
      expect(h.calls[0]!.payload[field]).toBe(256);
      expect(Object.keys(h.calls[0]!.payload).filter((key) => key.startsWith("max_"))).toEqual([field]);
    },
  );

  it("merge has exactly two allowlisted blocks, never raw privacy/parse evidence", async () => {
    const h = harness();
    expect(
      await h.generate({
        instruction: "merge-survivor",
        context: block({ id: "other.002", topic: "other", body: "Preserve the second constraint." }),
      }),
    ).toMatchObject({ kind: "ok", inputComplete: true });
    const dto = JSON.parse(h.calls[0]!.context.messages[0]!.content);
    expect(Object.keys(dto).sort()).toEqual(["context", "instruction", "purpose", "target"]);
    expect(Object.keys(dto.context).sort()).toEqual(["authority", "body", "id", "rev", "topic"]);
    expect(dto.context.body).toBe("Preserve the second constraint.");
  });

  it("freezes the redacted exact DTO before a queue await; later caller edits cannot replace it", async () => {
    const wait = deferred<RevisionTransportResult>();
    const h = harness({ respond: () => wait.promise });
    const active = Array.from({ length: 3 }, () => h.generate());
    await flush();
    const target = { ...block() };
    const queued = h.generate({ target });
    target.body = "caller changed body";
    target.private = true;
    await flush();
    expect(h.calls).toHaveLength(3);
    wait.resolve(response());
    expect((await Promise.all([...active, queued])).every((r) => r.kind === "ok")).toBe(true);
    expect(JSON.parse(h.calls[3]!.context.messages[0]!.content).target.body).toBe("Use the shared client.");
  });

  it.each([
    { enabled: false },
    { noAdapter: true },
    { models: [] },
    { quote: () => undefined },
    { bindingPatch: { maxTokensEnforced: false as true } },
    { bindingPatch: { maxOutputTokens: 1 } },
    { bindingPatch: { chainVersion: "" } },
    { bindingPatch: { outputLimitField: "unsupported" as "max_tokens" } },
    { quote: () => ({ maxInputTokens: NaN, priceUsdPerMillion: { input: 1, output: 1 } }) },
    { quote: () => ({ maxInputTokens: 1000, priceUsdPerMillion: { input: 1, output: NaN } }) },
  ])("unknown/disabled bound or quote %j refuses before registry.complete", async (options) => {
    const h = harness(options);
    expect(await h.generate()).toEqual(unavailable);
    expect(h.calls).toHaveLength(0);
    expect(h.client.usage().calls).toBe(0);
  });

  it.each([undefined, 0, -1, NaN, Infinity, 1.2])(
    "maxOutputTokens %s is never inferred from the 1KB body limit",
    async (maxOutputTokens) => {
      const h = harness();
      expect(await h.generate({ maxOutputTokens: maxOutputTokens as number })).toEqual(unavailable);
      expect(h.calls).toHaveLength(0);
    },
  );

  it.each([undefined, 0, 0.000001, NaN])(
    "revision missing/insufficient job cost cap %s fails closed",
    async (jobCostCapUsd) => {
      const h = harness();
      const req = h.request();
      if (jobCostCapUsd === undefined) delete (req as { jobCostCapUsd?: number }).jobCostCapUsd;
      else (req as { jobCostCapUsd: number }).jobCostCapUsd = jobCostCapUsd;
      expect(await h.client.generateRevision(req)).toEqual(unavailable);
      expect(h.calls).toHaveLength(0);
    },
  );

  it.each([
    { private: true },
    { private: undefined },
    { secret: true },
    { secret: undefined },
    { parseErrors: ["bad meta"] },
    { parseErrors: undefined },
    { status: "archived" },
    { storageScope: "hub" },
    { residue: true },
    { origin: { file: "private.md" } },
    { body: "token=abc123abc123abc123" },
    { body: `${"safe ".repeat(150)}sk-${"x".repeat(25)}` },
    { body: "a".repeat(1025) },
    { authority: "unknown" },
    { rev: "unknown" },
    { rev: `${"1".repeat(33)}-abcdef` },
    { body: "invalid\ud800" },
    { id: "../rules.001" },
    { topic: "wrong" },
    { path: "/private/file" },
  ])("private/secret/parse/shape admission %j is zero outbound", async (patch) => {
    const h = harness();
    expect(await h.generate({ target: { ...block(), ...patch } as RevisionBlockInput })).toEqual(unavailable);
    expect(h.calls).toHaveLength(0);
  });

  it("does not execute a block accessor to decide privacy or parse admission", async () => {
    const h = harness();
    const getter = vi.fn(() => false);
    const target = { ...block() };
    Object.defineProperty(target, "private", { enumerable: true, get: getter });
    expect(await h.generate({ target })).toEqual(unavailable);
    expect(getter).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    { context: block({ id: "rules.002" }) },
    { instruction: "merge-survivor" },
    { instruction: "merge-survivor", context: block({ private: true, id: "rules.002" }) },
    { instruction: "merge-survivor", context: block() },
    { relation: { kind: "conflict", p: 1 } },
  ])("rejects wrong/missing/extra context or relation envelope %j", async (patch) => {
    const h = harness();
    expect(await h.generate(patch as Partial<RevisionGenerateRequest>)).toEqual(unavailable);
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    "",
    "---\nauthority: user\n---\nbody",
    '{"body":"safe","action":"delete"}',
    "[REDACTED]",
    "[PEM]",
    "[EMAIL]",
    "a".repeat(1025),
    "supersedes: rules.002",
    "```json\n{}\n```",
    "\u0000bad",
  ])("invalid model body is rejected inside client: %j", async (text) => {
    const h = harness({ respond: () => response(text) });
    expect(await h.generate()).toEqual({ kind: "unavailable", reason: "invalid-output" });
    expect(h.calls).toHaveLength(1);
    expect(h.client.usage()).toMatchObject({ calls: 1, costUsd: 0.001 });
  });

  it.each(
    [
      [{ type: "toolCall", text: body }],
      [
        { type: "text", text: body },
        { type: "text", text: "extra" },
      ],
      [
        { type: "thinking", text: "reason" },
        { type: "text", text: body },
      ],
      [{ type: "text", text: body, action: "delete" }],
    ].map((content) => ({ content })),
  )("strict response content allowlist rejects %j", async ({ content }) => {
    const h = harness({ respond: () => ({ ...response(), content }) });
    expect(await h.generate()).toEqual({ kind: "unavailable", reason: "invalid-output" });
  });

  it("enforces transport output cap separately from body admission", async () => {
    const h = harness();
    expect(await h.generate({ maxOutputTokens: 1 })).toEqual(unavailable);
    expect(h.calls[0]!.payload["max_tokens"]).toBe(1);
    expect(h.client.usage().calls).toBe(1);
  });

  it("registry binding is exact and duplicate/foreign registries cannot borrow a route", async () => {
    const h = harness();
    expect(await h.generate({ registry: { ...h.registry } })).toEqual(unavailable);
    const duplicate = createRegistryRevisionTransport([h.bindings[0]!, h.bindings[0]!]);
    const outbound = prepareRevisionOutbound(h.request(), "generate")!.outbound;
    expect(
      duplicate.prepare({
        registry: h.registry,
        requestChainId: "gen/main",
        outbound,
        maxOutputTokens: 100,
        requestDigest: revisionRequestDigests(outbound, 100).requestDigest,
      }),
    ).toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });
});

describe("P50 B shared A reservation, channels, abort/zombie and usage", () => {
  it("generation and coverage share the actual sync/background channel caps and bounded queues", async () => {
    const wait = deferred<RevisionTransportResult>();
    const h = harness({
      respond: (_i, chain) =>
        wait.promise.then((r) =>
          chain.startsWith("judge/") ? response('{"verdict":"complete"}', "actual", "judge") : r,
        ),
    });
    const sync = Array.from({ length: 7 }, () => h.generate());
    await flush();
    expect(h.calls).toHaveLength(3);
    expect(await h.generate()).toEqual(unavailable);
    const background = Array.from({ length: 8 }, () => h.coverage());
    await flush();
    expect(h.calls).toHaveLength(7);
    expect(await h.coverage()).toEqual(unavailable);
    expect(h.client.usage().budget).toMatchObject({ queued: { sync: 4, background: 4 }, outstanding: 7 });
    wait.resolve(response());
    expect((await Promise.all([...sync, ...background])).every((r) => r.kind === "ok")).toBe(true);
    expect(h.calls).toHaveLength(15);
    expect(h.client.usage()).toMatchObject({ calls: 15, budget: { reservedCalls: 0, outstanding: 0 } });
    expect(h.client.usage().budget!.reservedCostUsd).toBeCloseTo(0, 12);
  });

  it("classify and generate use one maxCalls/reservation ledger", async () => {
    const h = harness({ config: { maxCalls: 1 } });
    expect(await h.generate()).toMatchObject({ kind: "ok" });
    expect(
      await h.client.ask({
        registry: h.registry,
        duty: "review",
        state: {},
        questions: {},
        mode: "sync",
        budgetMs: 1000,
      }),
    ).toMatchObject({ ok: false, reason: "budget" });
    expect(h.client.usage().calls).toBe(1);
  });

  it("timeout leaves zombie, blocks classify/generate/coverage and same-request failover, late usage adjusts once", async () => {
    vi.useFakeTimers();
    const wait = deferred<RevisionTransportResult>();
    const h = harness({ models: ["gen/first", "gen/second"], respond: () => wait.promise });
    const pending = h.generate({ budgetMs: 20 });
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toEqual(unavailable);
    expect(h.calls).toHaveLength(1);
    const estimate = h.client.usage().costUsd;
    expect(estimate).toBeGreaterThan(0.001);
    expect(h.client.usage().budget).toMatchObject({
      zombies: 1,
      outstanding: 1,
      costSource: "reserve",
      reservedCalls: 0,
    });
    expect(await h.generate()).toEqual(unavailable);
    expect(await h.coverage()).toEqual(unavailable);
    expect(
      await h.client.ask({
        registry: h.registry,
        duty: "review",
        state: {},
        questions: {},
        mode: "background",
        budgetMs: 100,
      }),
    ).toMatchObject({ ok: false, reason: "budget" });
    wait.resolve(response());
    await flush();
    expect(h.client.usage()).toMatchObject({ calls: 1, budget: { zombies: 0, outstanding: 0, costSource: "usage" } });
    expect(h.client.usage().costUsd).toBeCloseTo(0.001, 12);
    expect(h.client.usage().budget!.adjustmentUsd).toBeCloseTo(0.001 - estimate);
    await flush();
    expect(h.client.usage().costUsd).toBeCloseTo(0.001);
  });

  it("actual overrun is not clipped; stops subsequent generation and coverage", async () => {
    const h = harness({ respond: () => response(body, "actual", "generator", 50) });
    expect(await h.generate()).toMatchObject({ kind: "ok", costUsd: 50 });
    expect(h.client.usage()).toMatchObject({ costUsd: 50, budget: { exhausted: true, costSource: "usage" } });
    expect(h.client.usage().budget!.overReservedUsd).toBeGreaterThan(49);
    expect(await h.coverage()).toEqual(unavailable);
    expect(await h.generate()).toEqual(unavailable);
    expect(h.calls).toHaveLength(1);
  });

  it("unknown usage conservatively charges the same reserve used for admission", async () => {
    // Unknown usage is not fabricated as zero.
    const raw = response();
    const { usage: _usage, ...noUsage } = raw;
    const unknown = harness({ respond: () => noUsage });
    const result = await unknown.generate();
    expect(result.kind).toBe("ok");
    expect(unknown.client.usage().costUsd).toBeGreaterThan(0);
    if (result.kind === "ok") expect(result.costUsd).toBe(unknown.client.usage().costUsd);
    expect(unknown.client.usage().budget!.costSource).toBe("reserve");
  });

  it("queued caller abort and background abort/dispose revoke return authority while late cost is retained", async () => {
    const wait = deferred<RevisionTransportResult>();
    const h = harness({ respond: () => wait.promise });
    const active = Array.from({ length: 3 }, () => h.generate());
    await flush();
    const abort = new AbortController();
    const queued = h.generate({ signal: abort.signal });
    abort.abort();
    expect(await queued).toEqual(unavailable);
    expect(h.calls).toHaveLength(3);
    const bg = h.generate({ mode: "background" });
    await flush();
    h.client.abortBackground();
    expect(await bg).toEqual(unavailable);
    expect(h.calls[3]!.signal.aborted).toBe(true);
    h.client.dispose();
    expect(await Promise.all(active)).toEqual([unavailable, unavailable, unavailable]);
    wait.resolve(response());
    await flush();
    expect(h.client.usage()).toMatchObject({ calls: 4, budget: { disposed: true, outstanding: 0, zombies: 0 } });
    expect(h.client.usage().costUsd).toBeCloseTo(0.004, 12);
    expect(await h.generate()).toEqual(unavailable);
  });
});

describe("P50 B independent coverage request, actual sources and digest binding", () => {
  it("relation, generation and coverage are distinct dispatches; coverage sees only frozen text and candidate", async () => {
    const h = harness();
    const relationState = { id: "rules.001", rev: "1-abcdef" };
    const questions = {
      q: { type: "bool" as const, instructions: "conflict", criteria: { true: "yes", false: "no" } },
    };
    const relation = await h.client.ask({
      registry: h.registry,
      duty: "review",
      state: relationState,
      questions,
      mode: "sync",
      budgetMs: 2000,
    });
    const genReq = h.request();
    const generation = await h.client.generateRevision(genReq);
    const covReq = h.coverageRequest();
    const coverage = await h.client.judgeRevisionCoverage(covReq);
    expect(relation).toMatchObject({ ok: true, provenance: { model: "relation" } });
    expect(generation).toMatchObject({ kind: "ok", provenance: { model: "generator" } });
    expect(coverage).toMatchObject({
      kind: "ok",
      verdict: "complete",
      targetRev: "1-abcdef",
      beforeDigest: hash(covReq.target.body),
      candidateDigest: hash(body),
      provenance: { model: "judge" },
    });
    expect(h.calls.map((c) => c.chain)).toEqual(["gen/main", "judge/main"]);
    const judged = JSON.parse(h.calls[1]!.context.messages[0]!.content);
    expect(Object.keys(judged).sort()).toEqual(["candidateBody", "purpose", "target"]);
    expect(judged).not.toHaveProperty("relation");
    expect(judged).not.toHaveProperty("p");
    expect(judged).not.toHaveProperty("generation");
    if (!relation.ok || !relation.provenance || generation.kind !== "ok" || coverage.kind !== "ok")
      throw new Error("missing proof");
    const expected = {
      relation: {
        requestDigest: hash(canonical({ state: relationState, questions })),
        inputDigest: hash(canonical(relationState)),
      },
      generation: revisionRequestDigests(prepareRevisionOutbound(genReq, "generate")!.outbound, genReq.maxOutputTokens),
      coverage: revisionRequestDigests(prepareRevisionOutbound(covReq, "coverage")!.outbound, covReq.maxOutputTokens),
    };
    expect(independentCoverageSources(relation.provenance, generation.provenance, coverage.provenance, expected)).toBe(
      true,
    );
    const stale = { ...expected, coverage: { ...expected.coverage, inputDigest: hash("stale") } };
    expect(independentCoverageSources(relation.provenance, generation.provenance, coverage.provenance, stale)).toBe(
      false,
    );
    expect(h.client.usage().calls).toBe(3);
  });

  it.each([
    undefined,
    { provider: "wrong", model: "wrong", routeIdentity: hash("wrong"), routeAliases: ["judge/main", "wrong/wrong"] },
  ])("missing/mismatched actual canonical evidence %j cannot claim complete", async (route) => {
    const h = harness({ route: () => route });
    expect(await h.generate()).toMatchObject({
      kind: "ok",
      provenance: { provider: "actual", model: "generator", trusted: false },
    });
    expect(await h.coverage()).toMatchObject({
      kind: "ok",
      verdict: "unknown",
      provenance: { provider: "actual", model: "judge", trusted: false },
    });
  });

  it("failover records actual success; different preferred chains resolving to generation backend are not independent", async () => {
    const h = harness({
      coverageModels: ["judge/free", "judge/paid"],
      respond: (_i, chain) =>
        chain === "judge/free"
          ? { ...response(), stopReason: "error" }
          : response(chain.startsWith("judge/") ? '{"verdict":"complete"}' : body),
      route: (chain) => ({
        provider: "actual",
        model: "generator",
        routeIdentity: hash(chain),
        routeAliases: [chain, "actual/generator"],
      }),
    });
    const gen = await h.generate();
    const cov = await h.coverage();
    expect(cov).toMatchObject({
      kind: "ok",
      provenance: { requestChainId: "judge/paid", provider: "actual", model: "generator", trusted: true },
    });
    expect(h.calls.map((c) => c.chain)).toEqual(["gen/main", "judge/free", "judge/paid"]);
    if (gen.kind !== "ok" || cov.kind !== "ok") throw new Error("expected success");
    const p = gen.provenance,
      c = cov.provenance;
    const expected = { relation: p, generation: p, coverage: c };
    expect(independentCoverageSources(p, p, c, expected)).toBe(false);
  });

  it("intersecting canonical aliases cannot disguise judge as independent", async () => {
    const h = harness({
      route: (chain) => ({
        provider: "actual",
        model: chain.startsWith("judge/") ? "judge" : "generator",
        routeIdentity: hash(chain),
        routeAliases: [chain, chain.startsWith("judge/") ? "actual/judge" : "actual/generator", "pool/shared"],
      }),
    });
    const gen = await h.generate(),
      cov = await h.coverage();
    if (gen.kind !== "ok" || cov.kind !== "ok") throw new Error("expected proof");
    expect(
      independentCoverageSources(gen.provenance, gen.provenance, cov.provenance, {
        relation: gen.provenance,
        generation: gen.provenance,
        coverage: cov.provenance,
      }),
    ).toBe(false);
  });

  it.each(["partial", "unknown"])("judge verdict %s is never upgraded", async (verdict) => {
    const h = harness({ respond: () => response(`{"verdict":"${verdict}"}`, "actual", "judge") });
    expect(await h.coverage()).toMatchObject({ kind: "ok", verdict });
  });

  it.each([
    '{"verdict":"complete","independent":true}',
    '{"verdict":"complete","p":1}',
    '{"verdict":"complete","verdict":"partial"}',
    "complete",
    "{}",
  ])("coverage strict schema rejects generator-like/self-scored answer %s", async (text) => {
    const h = harness({ respond: () => response(text, "actual", "judge") });
    expect(await h.coverage()).toEqual({ kind: "unavailable", reason: "invalid-output" });
  });

  it.each([
    { target: block({ body: "hello@example.test must be retained" }) },
    { target: block({ body: "valid word ".repeat(60) }) },
    { candidateBody: "valid word ".repeat(60) },
    { context: block({ id: "rules.002", private: true }) },
    { relation: { p: 1, kind: "conflict" } },
    { generation: { selfRatedCoverage: 1 } },
  ])("lossy/invalid/extra evidence %j never becomes full coverage", async (patch) => {
    const h = harness();
    expect(await h.coverage(patch as Partial<RevisionCoverageRequest>)).toEqual(unavailable);
    expect(h.calls).toHaveLength(0);
  });

  it("maxTokens, full exact prompt and candidate all participate in independently reproducible request digest", () => {
    const h = harness();
    const outbound = prepareRevisionOutbound(h.coverageRequest(), "coverage")!.outbound;
    const first = revisionRequestDigests(outbound, 128);
    expect(first.requestDigest).toBe(
      hash(canonical({ context: revisionTransportContext(outbound), maxOutputTokens: 128 })),
    );
    expect(first.requestDigest).not.toBe(revisionRequestDigests(outbound, 129).requestDigest);
    expect(first.inputDigest).not.toBe(
      revisionRequestDigests({ ...outbound, target: { ...outbound.target, rev: "2-abcdef" } }, 128).inputDigest,
    );
  });
});
