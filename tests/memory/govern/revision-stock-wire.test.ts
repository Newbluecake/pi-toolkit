import * as fs from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { wireFixture } from "./revision-wire-helpers.js";
import { independentCoverageSources } from "../../../src/memory/jev/client.js";

it("default resolver → stock SDK → original scheduler/client/D/C/review, 2R+G+C, unknown suggest-only even auto=true", async () => {
  const h = await wireFixture({ stock: true, auto: true, secondClassifier: true });
  await h.writePair();
  const before = ["rules.001", "rules.002"].map((id) => fs.readFileSync(join(h.blocks, `${id}.md`)));
  const start = h.calls.length;
  await h.natural();
  expect(h.calls.slice(start).map((c) => c.kind)).toEqual(["relation", "relation", "generation", "coverage"]);
  expect(h.ask!.mock.calls.filter(([r]) => r.jobId)).toHaveLength(2);
  expect(h.generate).toHaveBeenCalledTimes(1);
  expect(h.coverage).toHaveBeenCalledTimes(1);
  expect(h.suggestions()).toHaveLength(1);
  const p = h.suggestions()[0]!.revision!;
  expect(p).toMatchObject({
    action: "merge-survivor",
    autoEligible: false,
    generatedBody: "Keep the budget and directory lock. Preserve both valid rules.",
    generationProvenance: {
      trusted: false,
      provider: "",
      model: "",
      routeIdentity: "unknown",
      routeAliases: [],
      adapterId: "p50-stock-estimate-v1",
      chainVersion: "stock-estimate-v1",
    },
  });
  expect(p.relation!.provenance).toMatchObject({
    trusted: false,
    provider: "",
    model: "",
    routeIdentity: "unknown",
    routeAliases: [],
  });
  expect(p.coverage).toBeUndefined();
  expect(
    independentCoverageSources(
      p.relation!.provenance,
      p.generationProvenance!,
      p.generationProvenance!,
      p.evidenceBindings! as never,
    ),
  ).toBe(false);
  const dir = join(h.blocks, ".jev/revisions", p.batchId, p.actionId);
  expect(JSON.parse(fs.readFileSync(join(dir, "audit.json"), "utf8"))).toMatchObject({ state: "prepared" });
  expect(fs.readFileSync(join(dir, "before.md"))).toEqual(before[0]);
  expect(["rules.001", "rules.002"].map((id) => fs.readFileSync(join(h.blocks, `${id}.md`)))).toEqual(before);
  expect(h.client!.usage()).toMatchObject({
    billingStatus: "UNKNOWN",
    priceBasis: "catalog-list-estimate",
    budget: { reservedCalls: 0, outstanding: 0 },
  });
  for (const c of h.calls.slice(start)) {
    if (c.kind === "relation") expect(c.payload).not.toHaveProperty("max_output_tokens");
    else expect(c.payload.max_tokens).toBe(384);
  }
});
it.each(["http", "json", "validator", "lease", "digest"] as const)(
  "stock terminal %s stops entire job, no save or later pair",
  async (fault) => {
    const h = await wireFixture({ stock: true });
    await h.writePair();
    await h.create("Keep a third directory lock and budget constraint.");
    const start = h.calls.length;
    if (fault === "http") h.state.coverageStatus = 500;
    if (fault === "json") h.state.invalidCoverage = true;
    if (fault === "validator") h.state.invalidGeneration = true;
    if (fault === "lease")
      h.state.onHTTP = (kind) => {
        if (kind === "generation") h.memoryScopes!.activity?.()?.noteToolCall("stock-lease-loss", Date.now());
      };
    if (fault === "digest") {
      const original = h.originalAsk!;
      h.ask!.mockImplementation(async (req) => {
        const out = await original(req);
        return req.jobId && out.ok
          ? {
              ...out,
              sources: out.sources!.map((s) => ({
                ...s,
                provenance: { ...s.provenance, requestDigest: "f".repeat(64) },
              })),
            }
          : out;
      });
    }
    await h.natural();
    const kinds = h.calls.slice(start).map((c) => c.kind);
    expect(h.suggestions()).toEqual([]);
    expect(fs.existsSync(join(h.blocks, ".jev/revisions"))).toBe(false);
    if (fault === "digest") expect(kinds).toEqual(["relation"]);
    else {
      // The whole menu is frozen, but stock executes each pair serially.
      expect(kinds.filter((k) => k === "relation")).toHaveLength(2);
      expect(kinds.filter((k) => k === "generation")).toHaveLength(1);
      expect(kinds.filter((k) => k === "coverage")).toHaveLength(["lease", "validator"].includes(fault) ? 0 : 1);
    }
  },
);
it("legal C verdict unknown may persist a suggestion, unlike C transport/JSON errors", async () => {
  const h = await wireFixture({ stock: true });
  await h.writePair();
  h.state.coverageVerdict = "unknown";
  await h.natural();
  expect(h.coverage).toHaveBeenCalledTimes(1);
  expect(h.suggestions()).toHaveLength(1);
  expect(h.suggestions()[0]!.revision!.autoEligible).toBe(false);
});
it.each([429, 500, 400])("stock R HTTP %s has no retries, splits or second tier", async (status) => {
  const h = await wireFixture({ stock: true, secondClassifier: true });
  await h.writePair();
  const start = h.calls.length,
    calls = h.client!.usage().calls;
  h.state.classifierStatus = status;
  await h.natural();
  expect(h.calls.slice(start).map((c) => c.kind)).toEqual(["relation"]);
  expect(h.client!.usage().calls - calls).toBe(1);
  expect(h.generate).not.toHaveBeenCalled();
  expect(h.suggestions()).toEqual([]);
});
it("default resolver never falls to second tier for P50, while no-job Jev still uses it", async () => {
  const h = await wireFixture({ stock: true, secondClassifier: true, missingFirst: true });
  await h.writePair();
  const start = h.calls.length;
  await h.natural();
  expect(h.calls).toHaveLength(start);
  expect(h.calls.length).toBeGreaterThan(0);
  expect(h.calls.every((c) => c.payload.model === "relation2")).toBe(true);
  expect(h.suggestions()).toEqual([]);
});
it.each([
  { fault: "revoke", proxy: false },
  { fault: "model", proxy: false },
  { fault: "revoke", proxy: true },
  { fault: "model", proxy: true },
] as const)("stock R fetch after payload %j is refused with zero HTTP", async ({ fault, proxy }) => {
  const h = await wireFixture({
    stock: true,
    ...(proxy ? { stockProxy: true, proxy: "http://owned-offline.invalid:3128" } : {}),
  });
  await h.writePair();
  const start = h.calls.length;
  h.state.afterPayload = () => {
    if (fault === "revoke") h.client!.dispose();
    else h.registry.getRegisteredProviderConfig("p50-wire-offline")!.models![0]!.baseUrl = "https://changed.invalid";
  };
  await h.natural();
  expect(h.calls).toHaveLength(start);
  expect(h.suggestions()).toEqual([]);
});
it("failed host with budget left → new host on same client cannot reclaim same job or emit HTTP", async () => {
  const { vi } = await import("vitest");
  const { createRevisionHost } = await import("../../../src/memory/govern/revision-host.js");
  const h = await wireFixture({ stock: true });
  await h.writePair();
  h.state.coverageStatus = 500;
  await h.natural();
  const [batch] = vi.mocked(h.host!.handle).mock.calls[0]!;
  expect(h.suggestions()).toEqual([]);
  expect(h.client!.usage().costUsd).toBeLessThan(0.1);
  expect(h.client!.usage().budget!.exhausted).toBe(false);
  const start = h.calls.length;
  const fresh = createRevisionHost(h.hostDeps!);
  const result = await fresh.handle(batch, {
    signal: new AbortController().signal,
    isCurrent: () => true,
    leaseValid: () => true,
    tryStartGenerate: () => true,
    capReached() {},
  });
  expect(result.reason).toBe("blocked-job");
  expect(h.calls).toHaveLength(start);
  expect(h.suggestions()).toEqual([]);
});
it.each([false, true])(
  "stock revision direct/proxy=%s last fetch catches callback revocation/source edit, no bottom HTTP",
  async (proxy) => {
    for (const fault of ["revoke", "model"] as const) {
      const h = await wireFixture({
        stock: true,
        ...(proxy ? { stockProxy: true, proxy: "http://owned-offline.invalid:3128" } : {}),
      });
      await h.writePair();
      const start = h.calls.length;
      h.state.afterPayload = (kind) => {
        if (kind !== "revision") return;
        if (fault === "revoke") h.client!.dispose();
        else
          h.registry.getRegisteredProviderConfig("p50-wire-offline")!.models![0]!.baseUrl = "https://changed.invalid";
      };
      await h.natural();
      expect(h.calls.slice(start).map((c) => c.kind)).toEqual(["relation", "relation"]);
      expect(h.generate).toHaveBeenCalledTimes(1);
      expect(h.coverage).not.toHaveBeenCalled();
      expect(h.suggestions()).toEqual([]);
    }
  },
);
it.each(["prepare", "payload", "http"] as const)(
  "conservative reserve accounting at %s refusal matches actual SDK attempt calls",
  async (stage) => {
    const { prepareRevisionOutbound, revisionRequestDigests } = await import("../../../src/memory/jev/client.js");
    const h = await wireFixture({ stock: true });
    await h.writePair();
    await h.natural();
    const req = { ...h.generate!.mock.calls[0]![0], jobId: "e".repeat(64), signal: new AbortController().signal };
    const dto = prepareRevisionOutbound(req, "generate")!;
    const prepared = h.binding.revision.transport.prepare({
      registry: h.registry,
      requestChainId: "p50-wire-offline/generation",
      outbound: dto.outbound,
      maxOutputTokens: req.maxOutputTokens,
      requestDigest: revisionRequestDigests(dto.outbound, req.maxOutputTokens).requestDigest,
    })!;
    const reserve = (prepared.bounds.maxInputTokens + prepared.bounds.maxOutputTokens) / 1e6;
    const before = h.client!.usage(),
      http = h.calls.length;
    if (stage === "prepare") req.maxOutputTokens = 0;
    if (stage === "payload") h.state.invalidPayload = true;
    if (stage === "http")
      h.state.onHTTP = (kind) => {
        if (kind === "generation") throw Error("offline HTTP failed");
      };
    expect(await h.client!.generateRevision(req)).toMatchObject({ kind: "unavailable" });
    const after = h.client!.usage();
    expect(after.calls - before.calls).toBe(stage === "prepare" ? 0 : 1);
    expect(after.costUsd - before.costUsd).toBeCloseTo(stage === "prepare" ? 0 : reserve, 12);
    expect(h.calls.length - http).toBe(stage === "http" ? 1 : 0);
    expect(after.budget).toMatchObject({ reservedCalls: 0, reservedCostUsd: 0, outstanding: 0 });
  },
);
it("stock observed over-reserve is fully charged, latches both channels, no R2/G/C despite remaining job cap", async () => {
  const h = await wireFixture({ stock: true });
  await h.writePair();
  const before = h.client!.usage(),
    start = h.calls.length;
  h.state.rawUsage = { input_tokens: 10000, output_tokens: 10000 };
  await h.natural();
  expect(h.calls.slice(start).map((c) => c.kind)).toEqual(["relation"]);
  expect(h.client!.usage().costUsd - before.costUsd).toBeCloseTo(0.02, 12);
  expect(h.client!.usage().budget).toMatchObject({ exhausted: true, outstanding: 0 });
  expect(h.client!.usage().budget!.overReservedUsd).toBeGreaterThan(0);
  expect(h.generate).not.toHaveBeenCalled();
  expect(h.suggestions()).toEqual([]);
  expect(h.client!.usage().billingStatus).toBe("UNKNOWN");
});
it.each(["missing", "zero", "malformed"] as const)(
  "stock raw usage %s never certifies identity or billing; missing/damaged charges reserve",
  async (usage) => {
    const h = await wireFixture({ stock: true });
    await h.writePair();
    h.state.missingUsage = usage === "missing";
    if (usage === "zero") {
      h.state.rawUsage = { input_tokens: 0, output_tokens: 0 };
      h.state.chatUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    }
    if (usage === "malformed") {
      h.state.rawUsage = { input_tokens: -1, output_tokens: "five" };
      h.state.chatUsage = { prompt_tokens: -1, completion_tokens: 5, total_tokens: 4 };
    }
    const before = h.client!.usage().costUsd;
    await h.natural();
    expect(h.suggestions()).toHaveLength(1);
    expect(h.suggestions()[0]!.revision!.generationProvenance).toMatchObject({
      provider: "",
      model: "",
      trusted: false,
    });
    expect(h.client!.usage().billingStatus).toBe("UNKNOWN");
    if (usage === "zero") expect(h.client!.usage().costUsd - before).toBe(0);
    else {
      expect(h.client!.usage().costUsd - before).toBeGreaterThan(0);
      expect(h.client!.usage().budget!.costSource).toBe("reserve");
    }
  },
);
it("stock SDK length stop is terminal rather than a usable candidate", async () => {
  const h = await wireFixture({ stock: true });
  await h.writePair();
  const start = h.calls.length;
  h.state.finishReason = "length";
  await h.natural();
  expect(h.calls.slice(start).map((c) => c.kind)).toEqual(["relation", "relation", "generation"]);
  expect(h.suggestions()).toEqual([]);
  expect(h.coverage).not.toHaveBeenCalled();
});
it("stock context error does not unlock the old pre-reserved split plan or second tier", async () => {
  const h = await wireFixture({ stock: true, secondClassifier: true });
  await h.writePair();
  h.state.classifierStatus = 400;
  h.state.classifierError = "context length exceeded";
  const start = h.calls.length,
    before = h.client!.usage();
  await h.natural();
  expect(h.calls.slice(start).map((c) => c.kind)).toEqual(["relation"]);
  expect(h.client!.usage().calls - before.calls).toBe(1);
  expect(h.client!.usage().budget!.reservedCalls).toBe(0);
  expect(h.suggestions()).toEqual([]);
});
