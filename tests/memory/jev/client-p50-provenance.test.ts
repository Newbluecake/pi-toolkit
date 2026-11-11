import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createJevClient, independentCoverageSources } from "../../../src/memory/jev/client.js";
import {
  DEFAULT_JEV_FAST_PATH,
  type CanonicalClassifyRoute,
  type ClassifierRegistryLike,
  type ClassifyContext,
  type ClassifyResult,
  type ClientProvenance,
  type ControlledClassifyTransport,
  type JevConfig,
} from "../../../src/memory/jev/contracts.js";
import { clearHealthTable } from "../../../src/memory/jev/health.js";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const q = { type: "bool" as const, instructions: "whole coverage", criteria: { true: "complete", false: "partial" } };
const cfg = (classifiers: string[]): JevConfig => ({
  classifiers,
  proxy: "",
  childSessions: false,
  recall: { threshold: 0.6, maxEntries: 3, maxBytes: 4096, waitMs: 2000 },
  reviewIntervalDays: 7,
  maxCostUsd: 10,
  maxCalls: 100,
  fastPath: DEFAULT_JEV_FAST_PATH,
  predict: {
    enabled: false,
    childSessions: false,
    maxEntries: 3,
    maxBytes: 4096,
    cooldownMs: 0,
    hintU: false,
    cacheTtlMin: 10,
    model: {
      enabled: false,
      models: [],
      threshold: 0.5,
      waitMs: 0,
      requestBudgetMs: 4000,
      maxCallsPerDay: 1,
      maxUsdPerDay: 0,
    },
  },
});
const route = (
  provider: string,
  model: string,
  aliases: string[],
  identity = `${provider}/${model}`,
): CanonicalClassifyRoute => ({
  provider,
  model,
  routeIdentity: hash(identity),
  routeAliases: aliases,
});
function harness(
  options: {
    chains?: string[];
    response?: (index: number, chain: string, context: ClassifyContext) => ClassifyResult;
    canonical?: (chain: string, result: ClassifyResult) => CanonicalClassifyRoute | undefined;
    adapterId?: string;
    chainVersion?: string;
  } = {},
) {
  const chains = options.chains ?? ["alias/preferred"];
  const calls: { chain: string; context: ClassifyContext; digest: string }[] = [];
  const registry: ClassifierRegistryLike = {
    getModelOfType: (_t, provider, id) => ({ chain: `${provider}/${id}` }),
    getAvailableOfType: async () =>
      chains.map((chain) => {
        const slash = chain.indexOf("/");
        return { provider: chain.slice(0, slash), id: chain.slice(slash + 1) };
      }),
    classify: (model, context) => {
      const chain = (model as { chain: string }).chain;
      return Promise.resolve(
        options.response?.(calls.length - 1, chain, context) ?? {
          stopReason: "stop",
          provider: "backend",
          model: "actual",
          answers: { q: { type: "bool", probability: 0.9 } },
          usage: { input: 10, cost: { total: 0.001 } },
        },
      );
    },
  };
  // Pure canonical lookup is a trusted host port. Tests explicitly script its
  // registry evidence independently from returned identities; no identity is
  // inferred from the requested alias or created by the client itself.
  const transport: ControlledClassifyTransport = {
    prepare: (input) => ({
      adapterId: options.adapterId ?? "bounded-test-adapter",
      chainVersion: options.chainVersion ?? "chain-v1",
      bounds: { maxInputTokens: 1000, maxOutputTokens: 100, priceUsdPerMillion: { input: 10, output: 10 } },
      dispatch: (opts) => {
        calls.push({ chain: input.requestChainId, context: input.context, digest: input.requestDigest });
        return registry.classify!(input.model, input.context, opts);
      },
      resolveRoute: (result) => options.canonical?.(input.requestChainId, result),
    }),
  };
  const client = createJevClient({
    config: cfg(chains),
    now: Date.now,
    isChild: false,
    p50: { enabled: true, transport },
  });
  const ask = (
    context: ClassifyContext = { state: { frozen: "rev-1", beforeDigest: hash("before") }, questions: { q } },
  ) => client.ask({ duty: "review", registry, ...context, mode: "sync", budgetMs: 2000 });
  return { client, ask, calls };
}
afterEach(clearHealthTable);

async function successfulProvenance(requested: string, canonical: CanonicalClassifyRoute): Promise<ClientProvenance> {
  const h = harness({
    chains: [requested],
    canonical: () => canonical,
    response: () => ({
      stopReason: "stop",
      provider: canonical.provider,
      model: canonical.model,
      answers: { q: { type: "bool", probability: 0.9 } },
      usage: { input: 1, cost: { total: 0.001 } },
    }),
  });
  const outcome = await h.ask();
  expect(outcome.ok).toBe(true);
  if (!outcome.ok || outcome.provenance === undefined) throw new Error("missing successful provenance");
  return outcome.provenance;
}
function bindings(relation: ClientProvenance, generation: ClientProvenance, coverage: ClientProvenance) {
  return Object.fromEntries(
    Object.entries({ relation, generation, coverage }).map(([k, p]) => [
      k,
      { inputDigest: p.inputDigest, requestDigest: p.requestDigest },
    ]),
  ) as Record<"relation" | "generation" | "coverage", { inputDigest: string; requestDigest: string }>;
}

describe("P50 provenance at actual classify success boundary", () => {
  it("preserves returned provider/model separately from requested alias with canonical proof", async () => {
    const h = harness({ canonical: () => route("backend", "actual", ["alias/preferred", "backend/actual"]) });
    const outcome = await h.ask();
    expect(outcome).toMatchObject({
      ok: true,
      model: "alias/preferred",
      provenance: {
        provider: "backend",
        model: "actual",
        requestChainId: "alias/preferred",
        trusted: true,
        routeIdentity: hash("backend/actual"),
        routeAliases: ["alias/preferred", "backend/actual"],
      },
    });
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.provenance?.requestDigest).toBe(h.calls[0]?.digest);
    expect(outcome.provenance?.inputDigest).toBe(
      hash(JSON.stringify({ beforeDigest: hash("before"), frozen: "rev-1" })),
    );
    expect(outcome.sources).toEqual([{ questionIds: ["q"], provenance: outcome.provenance }]);
    expect(Object.isFrozen(outcome.provenance?.routeAliases)).toBe(true);
  });

  it("failover evidence names the actual successful chain/backend, not the first requested chain", async () => {
    const h = harness({
      chains: ["alias/free", "alias/paid"],
      response: (i, _chain, ctx) =>
        i === 0
          ? { stopReason: "error", errorMessage: "451 blocked", answers: {}, provider: "free", model: "bad" }
          : {
              stopReason: "stop",
              provider: "paid-backend",
              model: "real",
              answers: Object.fromEntries(
                Object.keys(ctx.questions).map((id) => [id, { type: "bool", probability: 0.9 }]),
              ),
            },
      canonical: (chain) =>
        chain === "alias/paid" ? route("paid-backend", "real", ["alias/paid", "paid-backend/real"]) : undefined,
    });
    expect(await h.ask()).toMatchObject({
      ok: true,
      model: "alias/paid",
      provenance: {
        requestChainId: "alias/paid",
        provider: "paid-backend",
        model: "real",
        trusted: true,
      },
    });
    expect(h.calls.map((c) => c.chain)).toEqual(["alias/free", "alias/paid"]);
    expect(h.client.usage().calls).toBe(2);
  });

  it.each([
    undefined,
    route("backend", "different", ["alias/preferred", "backend/different"]),
    route("different", "actual", ["alias/preferred", "different/actual"]),
    route("backend", "actual", ["backend/actual"]),
    route("backend", "actual", ["alias/preferred"]),
    {
      ...route("backend", "actual", ["alias/preferred", "backend/actual"]),
      routeIdentity: "requested-id-is-not-a-digest",
    },
  ])("missing/inconsistent canonical route %j is untrusted, never substitutes outcome.model", async (canonical) => {
    const h = harness({ canonical: () => canonical });
    const outcome = await h.ask();
    expect(outcome).toMatchObject({
      ok: true,
      provenance: {
        provider: "backend",
        model: "actual",
        requestChainId: "alias/preferred",
        trusted: false,
        routeIdentity: "unknown",
        routeAliases: [],
      },
    });
  });

  it("missing actual backend identity remains explicitly untrusted, never filled from request id", async () => {
    const h = harness({
      response: () =>
        ({ stopReason: "stop", answers: { q: { type: "bool", probability: 0.9 } } }) as unknown as ClassifyResult,
      canonical: () => route("alias", "preferred", ["alias/preferred"]),
    });
    expect(await h.ask()).toMatchObject({
      ok: true,
      model: "alias/preferred",
      provenance: {
        provider: "",
        model: "",
        requestChainId: "alias/preferred",
        trusted: false,
        routeIdentity: "unknown",
      },
    });
  });

  it("canonical resolver exception cannot discard the actual identity or turn it trusted", async () => {
    const h = harness({
      canonical: () => {
        throw new Error("cannot resolve");
      },
    });
    expect(await h.ask()).toMatchObject({
      ok: true,
      provenance: { provider: "backend", model: "actual", trusted: false },
    });
  });

  it.each(["adapterId", "chainVersion"] as const)("missing %s fails provenance closed", async (field) => {
    const h = harness({
      [field]: "",
      canonical: () => route("backend", "actual", ["alias/preferred", "backend/actual"]),
    });
    expect(await h.ask()).toMatchObject({ ok: true, provenance: { trusted: false, routeIdentity: "unknown" } });
  });

  it("split context retains each backend and each half's digest/answer scope; no singular provenance", async () => {
    const h = harness({
      response: (i, _id, ctx) =>
        i === 0
          ? {
              stopReason: "error",
              errorMessage: "maximum context exceeded",
              provider: "backend",
              model: "router",
              answers: {},
            }
          : {
              stopReason: "stop",
              provider: "backend",
              model: i === 1 ? "left" : "right",
              answers: Object.fromEntries(
                Object.keys(ctx.questions).map((id) => [id, { type: "bool", probability: 0.9 }]),
              ),
            },
      canonical: (chain, r) => route(r.provider, r.model, [chain, `${r.provider}/${r.model}`]),
    });
    const outcome = await h.ask({ state: { frozen: "same" }, questions: { q, q2: q } });
    expect(outcome).toMatchObject({
      ok: true,
      missing: [],
      sources: [
        { questionIds: ["q"], provenance: { provider: "backend", model: "left", trusted: true } },
        { questionIds: ["q2"], provenance: { provider: "backend", model: "right", trusted: true } },
      ],
    });
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome).not.toHaveProperty("provenance");
    expect(outcome.sources?.map((s) => s.provenance.requestDigest)).toEqual(h.calls.slice(1).map((c) => c.digest));
    expect(outcome.sources?.[0]?.provenance.requestDigest).not.toBe(outcome.sources?.[1]?.provenance.requestDigest);
  });

  it("even a partially successful split is explicitly split evidence, not single-source full-input proof", async () => {
    const h = harness({
      response: (i, _id, ctx) =>
        i === 1
          ? {
              stopReason: "stop",
              provider: "backend",
              model: "actual",
              answers: Object.fromEntries(
                Object.keys(ctx.questions).map((id) => [id, { type: "bool", probability: 0.9 }]),
              ),
            }
          : {
              stopReason: "error",
              errorMessage: "maximum context exceeded",
              provider: "backend",
              model: "actual",
              answers: {},
            },
      canonical: () => route("backend", "actual", ["alias/preferred", "backend/actual"]),
    });
    const outcome = await h.ask({ state: {}, questions: { q, q2: q } });
    expect(outcome).toMatchObject({ ok: true, missing: ["q2"], sources: [{ questionIds: ["q"] }] });
    expect(outcome).not.toHaveProperty("provenance");
  });

  it("request digest is canonical but binds all actual questions/state and actual outbound DTO", async () => {
    const h = harness();
    const context = { state: { z: 1, a: 2 }, questions: { q } };
    await h.ask(context);
    await h.ask({ state: { a: 2, z: 1 }, questions: { q } });
    await h.ask({ state: { a: 2, z: 1 }, questions: { q: { ...q, instructions: "different" } } });
    await h.ask({ state: { a: 2, z: 2 }, questions: { q } });
    expect(h.calls[0]?.digest).toBe(h.calls[1]?.digest);
    expect(h.calls[0]?.digest).not.toBe(h.calls[2]?.digest);
    expect(h.calls[0]?.digest).not.toBe(h.calls[3]?.digest);
    expect(h.calls[0]?.context).toEqual(context);
  });
});

describe("independentCoverageSources — conservative canonical route separation", () => {
  it("distinct actual backends with disjoint canonical routes pass only with matching frozen digest bindings", async () => {
    const relation = await successfulProvenance("relation/alias", route("r", "real", ["relation/alias", "r/real"]));
    const generation = await successfulProvenance(
      "generation/alias",
      route("g", "real", ["generation/alias", "g/real"]),
    );
    const coverage = await successfulProvenance("coverage/alias", route("c", "real", ["coverage/alias", "c/real"]));
    expect(independentCoverageSources(relation, generation, coverage)).toBe(false);
    expect(independentCoverageSources(relation, generation, coverage, bindings(relation, generation, coverage))).toBe(
      true,
    );
    const stale = bindings(relation, generation, coverage);
    stale.coverage.inputDigest = hash("new rev");
    expect(independentCoverageSources(relation, generation, coverage, stale)).toBe(false);
    const wrongRequest = bindings(relation, generation, coverage);
    wrongRequest.relation.requestDigest = hash("other question");
    expect(independentCoverageSources(relation, generation, coverage, wrongRequest)).toBe(false);
  });

  it("different preferred chains that cross-failover to the same actual model are same-source", async () => {
    const outcomes: ClientProvenance[] = [];
    for (const prefix of ["relation", "generation", "coverage"]) {
      clearHealthTable();
      const h = harness({
        chains: [`${prefix}/preferred`, `${prefix}/fallback`],
        response: (i, _chain, ctx) =>
          i === 0
            ? {
                stopReason: "error",
                errorMessage: "451 blocked",
                provider: prefix,
                model: "preferred",
                answers: {},
              }
            : {
                stopReason: "stop",
                provider: "shared",
                model: "backend",
                answers: Object.fromEntries(
                  Object.keys(ctx.questions).map((id) => [id, { type: "bool", probability: 0.9 }]),
                ),
              },
        // Even differing canonical digests cannot disguise identical actual ids.
        canonical: (chain) => route("shared", "backend", [chain, "shared/backend"], prefix),
      });
      const outcome = await h.ask();
      expect(outcome).toMatchObject({
        ok: true,
        provenance: { trusted: true, provider: "shared", model: "backend", requestChainId: `${prefix}/fallback` },
      });
      if (outcome.ok && outcome.provenance !== undefined) outcomes.push(outcome.provenance);
    }
    expect(outcomes).toHaveLength(3);
    expect(
      independentCoverageSources(
        outcomes[0]!,
        outcomes[1]!,
        outcomes[2]!,
        bindings(outcomes[0]!, outcomes[1]!, outcomes[2]!),
      ),
    ).toBe(false);
  });

  it("canonical aliases intersecting relation OR generation reject coverage even with different actual ids", async () => {
    const relation = await successfulProvenance("r/alias", route("r", "real", ["r/alias", "r/real", "pool/shared"]));
    const generation = await successfulProvenance("g/alias", route("g", "real", ["g/alias", "g/real", "pool/other"]));
    for (const alias of ["pool/shared", "pool/other"]) {
      const coverage = await successfulProvenance("c/alias", route("c", "real", ["c/alias", "c/real", alias]));
      expect(independentCoverageSources(relation, generation, coverage, bindings(relation, generation, coverage))).toBe(
        false,
      );
    }
  });

  it("same canonical route identity rejects even if alias sets and actual models differ", async () => {
    const relation = await successfulProvenance("r/alias", route("r", "real", ["r/alias", "r/real"], "same-route"));
    const generation = await successfulProvenance("g/alias", route("g", "real", ["g/alias", "g/real"]));
    const coverage = await successfulProvenance("c/alias", route("c", "real", ["c/alias", "c/real"], "same-route"));
    expect(independentCoverageSources(relation, generation, coverage, bindings(relation, generation, coverage))).toBe(
      false,
    );
  });

  it("unknown route/missing version/untrusted/digest corruption cannot be used as automatic evidence", async () => {
    const base = await successfulProvenance("c/alias", route("c", "real", ["c/alias", "c/real"]));
    const relation = await successfulProvenance("r/alias", route("r", "real", ["r/alias", "r/real"]));
    const generation = await successfulProvenance("g/alias", route("g", "real", ["g/alias", "g/real"]));
    for (const patch of [
      { trusted: false },
      { routeIdentity: "unknown" },
      { adapterId: "" },
      { chainVersion: "" },
      { requestDigest: "missing" },
      { inputDigest: "bad" },
    ]) {
      const coverage = { ...base, ...patch };
      expect(independentCoverageSources(relation, generation, coverage, bindings(relation, generation, coverage))).toBe(
        false,
      );
    }
  });
});
