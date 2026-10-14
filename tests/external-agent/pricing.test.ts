import { describe, expect, it } from "vitest";
import type { ExternalPriceTable } from "../../src/core/types.js";
import { priceUsage, resolveExternalPricing } from "../../src/external-agent/pricing.js";
import type { ExternalModelInfo, PriceCandidate } from "../../src/external-agent/types.js";

const t = (input: number, output: number, cacheRead = 0, cacheWrite = 0): ExternalPriceTable => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});
const c = (provider: string, id: string, cost?: ExternalPriceTable): PriceCandidate =>
  cost === undefined ? { provider, id } : { provider, id, cost };
const info = (id: string, over: Partial<ExternalModelInfo> = {}): ExternalModelInfo => ({
  id,
  reasoningEfforts: [],
  deprecated: false,
  ...over,
});

const LUNA_TIERS: ExternalPriceTable = {
  ...t(2.5, 15, 0.25, 0),
  tiers: [{ inputTokensAbove: 272_000, ...t(5, 22.5, 0.5, 0) }],
};
const REGISTRY: PriceCandidate[] = [
  c("anthropic", "claude-sonnet-5", t(2, 10, 0.2, 2.5)),
  c("cr-anthropic", "claude-sonnet-5", t(3, 15, 0.3, 3.75)),
  c("cr-anthropic", "claude-fable-5-1", t(4, 20, 0.4, 5)),
  c("relay2", "claude-fable-5-1", t(4, 20, 0.4, 5)),
  c("openai", "gpt-6-luna", LUNA_TIERS),
  c("moonshotai", "kimi-k3", t(1, 4, 0.1, 0)),
  c("zai", "glm-9-mini", t(0, 0, 0, 0)),
  c("openai", "gpt-6-luna-fast", t(9, 9, 0, 0)),
  c("relayA", "mystery-x", t(1, 1)),
  c("relayB", "mystery-x", t(2, 2)),
  c("anthropic", "claude-haiku-9-20260101", t(1, 5, 0.1, 1.25)),
  c("anthropic", "claude-haiku-9-20260301", t(1.1, 5.5, 0.1, 1.25)),
  c("google", "gemini-7", t(1, 2)),
  c("google-vertex", "gemini-7", t(1.5, 3)),
  c("nocost", "only-free-model"),
];
const r = (
  modelId: string,
  i?: ExternalModelInfo,
  over: { override?: never; registry?: PriceCandidate[] | undefined } = {},
) =>
  resolveExternalPricing({
    modelId,
    ...(i ? { info: i } : {}),
    registry: "registry" in over ? over.registry : REGISTRY,
  });

describe("resolveExternalPricing", () => {
  it("rule 0: overrides", () => {
    const base = { modelId: "whatever", registry: REGISTRY };
    expect(resolveExternalPricing({ ...base, override: "unpriced" })).toEqual({
      status: "unpriced",
      reason: "override_unpriced",
    });
    expect(resolveExternalPricing({ ...base, override: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } })).toEqual(
      {
        status: "priced",
        source: "settings",
        basis: "override",
        approx: false,
        table: t(1, 2, 3, 4),
      },
    );
    expect(resolveExternalPricing({ ...base, override: "anthropic/claude-sonnet-5" })).toMatchObject({
      status: "priced",
      source: "anthropic/claude-sonnet-5",
      basis: "override",
      approx: false,
      table: t(2, 10, 0.2, 2.5),
    });
    for (const bad of ["nope/missing", "zai/glm-9-mini", "no-slash", "nocost/only-free-model"])
      expect(resolveExternalPricing({ ...base, override: bad })).toMatchObject({
        status: "unpriced",
        reason: "invalid_override",
      });
    expect(resolveExternalPricing({ modelId: "x", registry: undefined, override: "a/b" })).toMatchObject({
      reason: "invalid_override",
    });
    // override beats router rule
    expect(
      resolveExternalPricing({
        modelId: "auto",
        registry: REGISTRY,
        override: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      }),
    ).toMatchObject({ status: "priced" });
  });

  it("rule 1: router kind or id=auto", () => {
    expect(r("auto")).toEqual({ status: "unpriced", reason: "router_model" });
    expect(r("some-router", info("some-router", { kind: "router" }))).toEqual({
      status: "unpriced",
      reason: "router_model",
    });
  });

  it("rule 2: registry unavailable or empty", () => {
    expect(r("claude-sonnet-5", undefined, { registry: undefined })).toEqual({
      status: "unpriced",
      reason: "registry_unavailable",
    });
    expect(r("claude-sonnet-5", undefined, { registry: [] })).toEqual({
      status: "unpriced",
      reason: "registry_unavailable",
    });
  });

  it("rule 3: id equivalence (case, dots, 8-digit date) — and NO other suffix stripping", () => {
    expect(r("Claude-Sonnet-5", info("x", { upstreamProvider: "anthropic" }))).toMatchObject({
      source: "anthropic/claude-sonnet-5",
    });
    expect(r("claude-haiku-9", info("x", { upstreamProvider: "anthropic" }))).toMatchObject({
      status: "unpriced",
      reason: "ambiguous",
    }); // base() matches both dated variants
    expect(r("claude-opus-5-5-fast")).toMatchObject({ reason: "no_match" });
    expect(r("gpt-6-luna-mini")).toMatchObject({ reason: "no_match" });
    expect(r("gpt-6-luna-fast", info("x", { upstreamProvider: "openai" }))).toMatchObject({
      source: "openai/gpt-6-luna-fast",
    }); // distinct model, not stripped to luna
  });

  it("rule 4: all-zero / no-cost matches ⇒ zero_price (never free)", () => {
    expect(r("glm-9-mini", info("glm-9-mini", { upstreamProvider: "factory" }))).toMatchObject({
      status: "unpriced",
      reason: "zero_price",
    });
    expect(r("only-free-model")).toMatchObject({ reason: "zero_price" });
  });

  it("rule 5a: canonical upstream provider wins over a relay (real-life: claude-sonnet-5 → 2/10, not 3/15)", () => {
    const p = r("claude-sonnet-5", info("claude-sonnet-5", { upstreamProvider: "anthropic" }));
    expect(p).toEqual({
      status: "priced",
      source: "anthropic/claude-sonnet-5",
      basis: "upstream",
      approx: false,
      table: t(2, 10, 0.2, 2.5),
    });
  });

  it("rule 5a: openai gpt-6-luna keeps its tier table; google prefers google over google-vertex", () => {
    const p = r("gpt-6-luna", info("gpt-6-luna", { upstreamProvider: "openai" }));
    expect(p).toMatchObject({ status: "priced", basis: "upstream", approx: false, source: "openai/gpt-6-luna" });
    expect((p as { table: ExternalPriceTable }).table.tiers).toHaveLength(1);
    expect(r("gemini-7", info("gemini-7", { upstreamProvider: "google" }))).toMatchObject({
      source: "google/gemini-7",
    });
  });

  it("rule 5b: factory-hosted / missing catalog ⇒ family price, approx:true", () => {
    expect(r("kimi-k3", info("kimi-k3", { upstreamProvider: "factory" }))).toEqual({
      status: "priced",
      source: "moonshotai/kimi-k3",
      basis: "family",
      approx: true,
      table: t(1, 4, 0.1, 0),
    });
    // catalog missing: claude-/gpt- also temporarily approx via family
    expect(r("claude-sonnet-5")).toMatchObject({ basis: "family", approx: true, source: "anthropic/claude-sonnet-5" });
    expect(r("gpt-6-luna")).toMatchObject({ basis: "family", approx: true, source: "openai/gpt-6-luna" });
  });

  it("rule 5: same-provider variants with conflicting prices ⇒ ambiguous; norm-exact preferred when it exists", () => {
    expect(r("claude-haiku-9", info("x", { upstreamProvider: "anthropic" }))).toMatchObject({ reason: "ambiguous" });
    // exact dated id picks that entry alone (no ambiguity)
    expect(r("claude-haiku-9-20260101", info("x", { upstreamProvider: "anthropic" }))).toMatchObject({
      status: "priced",
      source: "anthropic/claude-haiku-9-20260101",
      table: t(1, 5, 0.1, 1.25),
    });
  });

  it("rule 6: consensus across relays (claude-fable-5.1 → claude-fable-5-1) is approx; disagreement ⇒ ambiguous with ≤5 listed", () => {
    expect(r("claude-fable-5.1", info("claude-fable-5.1", { upstreamProvider: "anthropic" }))).toEqual({
      status: "priced",
      source: "cr-anthropic/claude-fable-5-1",
      basis: "consensus",
      approx: true,
      table: t(4, 20, 0.4, 5),
    });
    const amb = r("mystery-x");
    expect(amb).toMatchObject({ status: "unpriced", reason: "ambiguous" });
    expect((amb as { detail: string }).detail).toContain("relayA/mystery-x 1/1");
    expect((amb as { detail: string }).detail).toContain("relayB/mystery-x 2/2");
  });

  it("rule 6 consensus compares tiers too (same base rates, different tiers ⇒ ambiguous)", () => {
    const reg = [
      c("a", "m-1", { ...t(1, 1), tiers: [{ inputTokensAbove: 100, ...t(2, 2, 0, 0) }] }),
      c("b", "m-1", { ...t(1, 1), tiers: [{ inputTokensAbove: 100, ...t(3, 3, 0, 0) }] }),
    ];
    expect(resolveExternalPricing({ modelId: "m-1", registry: reg })).toMatchObject({ reason: "ambiguous" });
  });

  it("rule 7: no match", () => {
    expect(r("inkling")).toMatchObject({ status: "unpriced", reason: "no_match" });
    expect(r("deepseek-v4.1-flash")).toMatchObject({ status: "unpriced", reason: "no_match" });
  });
});

describe("priceUsage", () => {
  const table: ExternalPriceTable = { ...t(10, 20, 1, 5), tiers: [{ inputTokensAbove: 1000, ...t(100, 200, 10, 50) }] };
  it("prices per 1M tokens", () => {
    expect(
      priceUsage({ input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 100_000 }, t(10, 20, 1, 5)),
    ).toBeCloseTo(10 + 10 + 2 + 0.5, 9);
  });
  it("tier chosen by requestInputTokens when given, else by input+cacheRead+cacheWrite", () => {
    const tok = { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(priceUsage(tok, table, 500)).toBeCloseTo((100 * 10) / 1e6, 12);
    expect(priceUsage(tok, table, 1001)).toBeCloseTo((100 * 100) / 1e6, 12);
    expect(priceUsage(tok, table, 1000)).toBeCloseTo((100 * 10) / 1e6, 12); // strictly above
    expect(priceUsage({ input: 600, output: 0, cacheRead: 500, cacheWrite: 0 }, table)).toBeCloseTo(
      (600 * 100 + 500 * 10) / 1e6,
      12,
    );
  });
  it("NaN / negative / Infinity ⇒ 0, never NaN", () => {
    expect(priceUsage({ input: Number.NaN, output: -5, cacheRead: Infinity, cacheWrite: 0 }, table)).toBe(0);
    expect(priceUsage({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, t(Number.NaN, 0, 0, 0))).toBe(0);
    expect(Number.isFinite(priceUsage({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, table, Number.NaN))).toBe(
      true,
    );
  });
});
