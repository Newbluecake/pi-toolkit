import { expect, it } from "vitest";
import {
  createDefaultP50BindingResolver,
  createStockEstimateP50Binding,
  P50_SDK_BINDING,
} from "../../../src/memory/jev/p50-binding.js";
import { STOCK_ESTIMATE_PROFILE } from "../../../src/memory/jev/p50-estimate.js";
import { wireFixture } from "../govern/revision-wire-helpers.js";
const r = "p50-wire-offline/relation",
  g = "p50-wire-offline/generation";
it("activation resolver freezes only first configured stock tier and stable references, no SDK requests", async () => {
  const h = await wireFixture({ stock: true, secondClassifier: true });
  const resolver = createDefaultP50BindingResolver(g),
    start = h.calls.length;
  const a = resolver(h.binding.registry, [r, "p50-wire-offline/relation2"]);
  expect(a.kind).toBe("ready");
  if (a.kind !== "ready") throw Error("binding unavailable");
  expect(a.binding.accountingProfile).toBe(STOCK_ESTIMATE_PROFILE);
  expect(a.binding.classifiers).toEqual([r]);
  expect(a.binding.revision.models).toEqual([g]);
  expect(a.binding.revision.coverageModels).toEqual([g]);
  expect(resolver(h.binding.registry, [r, "p50-wire-offline/relation2"])).toMatchObject({
    kind: "ready",
    binding: a.binding,
  });
  expect(h.calls).toHaveLength(start);
  const config = h.registry.getRegisteredProviderConfig("p50-wire-offline")!;
  config.models![0]!.baseUrl = "https://remapped.invalid";
  expect(a.binding.isCurrent()).toBe(false);
  expect(resolver(h.binding.registry, [r])).toEqual({ kind: "unsupported", reason: "binding-invalid" });
});
it("native invalid contract is never silently downgraded to estimate; unavailable first model is not replaced", async () => {
  const h = await wireFixture({ stock: true });
  const resolver = createDefaultP50BindingResolver(g);
  const invalid = { ...h.registry.getProvider("p50-wire-offline")!, [P50_SDK_BINDING]: true };
  h.registry.registerProvider(invalid);
  expect(resolver(h.binding.registry, [r])).toEqual({ kind: "unsupported", reason: "binding-invalid" });
  expect(
    createStockEstimateP50Binding({ registry: h.binding.registry, classifier: "missing/first", revisionModel: g }),
  ).toBeUndefined();
  expect(
    createStockEstimateP50Binding({ registry: h.binding.registry, classifier: r, revisionModel: r }),
  ).toBeUndefined();
});
it("certified resolver still validates full classifier chain rather than stock first-tier narrowing", async () => {
  const h = await wireFixture();
  const resolver = createDefaultP50BindingResolver(g);
  expect(resolver(h.binding.registry, [r])).toMatchObject({ kind: "ready", binding: h.binding });
  expect(resolver(h.binding.registry, [r, "missing/second"])).toEqual({
    kind: "unsupported",
    reason: "binding-invalid",
  });
});
it("runtime assurance rejects missing, false, mixed certified/estimate and nonnumeric allowances", async () => {
  const { createRegistryRevisionTransport, revisionRequestDigests } = await import("../../../src/memory/jev/client.js");
  type Binding = import("../../../src/memory/jev/contracts.js").RegistryRevisionBinding;
  const h = await wireFixture({ stock: true });
  const outbound = {
    purpose: "generate" as const,
    instruction: "rewrite-single" as const,
    target: { id: "rules.001", rev: "1-abcdef", authority: "agent" as const, topic: "rules", body: "Keep the lock." },
  };
  const common = {
    registry: h.binding.registry,
    requestChainId: g,
    model: h.registry.find("p50-wire-offline", "generation")!,
    adapterId: "p50-stock-estimate-v1",
    chainVersion: "stock-estimate-v1",
    outputLimitField: "max_tokens",
    maxOutputTokens: 384,
    quoteInput: () => ({ maxInputTokens: 4096, priceUsdPerMillion: { input: 1, output: 1 } }),
    resolveRoute: () => undefined,
  };
  const valid = createRegistryRevisionTransport(
    [{ ...common, outputLimitField: "max_tokens", accountingProfile: STOCK_ESTIMATE_PROFILE }],
    () => true,
  );
  expect(
    valid.prepare({
      registry: h.binding.registry,
      requestChainId: g,
      outbound,
      maxOutputTokens: 384,
      requestDigest: revisionRequestDigests(outbound, 384).requestDigest,
    }),
  ).toBeDefined();
  for (const assurance of [
    {},
    { maxTokensEnforced: false },
    { accountingProfile: STOCK_ESTIMATE_PROFILE, maxTokensEnforced: true },
    { accountingProfile: STOCK_ESTIMATE_PROFILE, maxOutputTokens: 0 },
    { accountingProfile: STOCK_ESTIMATE_PROFILE, maxOutputTokens: "384" },
  ]) {
    const transport = createRegistryRevisionTransport([{ ...common, ...assurance } as unknown as Binding], () => true);
    expect(
      transport.prepare({
        registry: h.binding.registry,
        requestChainId: g,
        outbound,
        maxOutputTokens: 384,
        requestDigest: revisionRequestDigests(outbound, 384).requestDigest,
      }),
    ).toBeUndefined();
  }
});
