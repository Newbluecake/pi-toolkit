import { describe, expect, it } from "vitest";
import { readMeasureUsage } from "../../src/cache-ttl/measure-usage.js";
import { validateMeasurePayload } from "../../src/cache-ttl/measure-payload.js";
import { measureRouteKey } from "../../src/cache-ttl/measure-route.js";
import {
  OUTPUT_CAP,
  type MeasureApi,
  type PayloadExpectation,
  type PayloadRejectionCode,
} from "../../src/cache-ttl/measure-types.js";

const profiles = ["openai-responses", "openai-completions"] as const;
function raw(
  profile: (typeof profiles)[number],
  P: unknown = 100,
  C: unknown = 80,
  W: unknown = 20,
  output: unknown = 1,
): Record<string, unknown> {
  return profile === "openai-responses"
    ? { input_tokens: P, input_tokens_details: { cached_tokens: C, cache_write_tokens: W }, output_tokens: output }
    : {
        prompt_tokens: P,
        prompt_tokens_details: { cached_tokens: C, cache_write_tokens: W },
        completion_tokens: output,
      };
}
function expected(api: MeasureApi): PayloadExpectation {
  return {
    api,
    wireModel: "gpt-measure",
    expectedSystem: "Nonce abc. Be terse.",
    expectedUser: "Nonce abc. Reply OK.",
    outputCap: OUTPUT_CAP[api],
    requestedRetention: "short",
    oauth: false,
    managedEffort: false,
    promptCacheKey: "ttl-measure-prefix",
  };
}
function payload(api: (typeof profiles)[number]): Record<string, unknown> {
  const e = expected(api);
  return api === "openai-responses"
    ? {
        model: e.wireModel,
        stream: true,
        store: false,
        max_output_tokens: 16,
        prompt_cache_key: e.promptCacheKey,
        input: [
          { role: "developer", content: e.expectedSystem },
          { role: "user", content: [{ type: "input_text", text: e.expectedUser }] },
        ],
      }
    : {
        model: e.wireModel,
        stream: true,
        max_tokens: 1,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: e.expectedSystem },
          { role: "user", content: e.expectedUser },
        ],
      };
}
function refused(api: (typeof profiles)[number], patch: Record<string, unknown>, code: PayloadRejectionCode) {
  expect(validateMeasurePayload(api, { ...payload(api), ...patch }, expected(api))).toEqual({ ok: false, code });
}

describe.each(profiles)("strict %s usage", (api) => {
  it("keeps independent total P, C, W and output; all reported components give complete billing", () => {
    expect(readMeasureUsage(api, raw(api))).toEqual({
      usage: { P: 100, C: 80, W: 20, output: 1 },
      cacheEvidence: { kind: "valid" },
      billing: { kind: "complete" },
    });
    expect(readMeasureUsage(api, raw(api, 0, 0, 0, 0)).usage).toEqual({ P: 0, C: 0, W: 0, output: 0 });
  });
  it("missing cache read is invalid, not a zero-filled miss", () => {
    const r = raw(api);
    delete (r[api === "openai-responses" ? "input_tokens_details" : "prompt_tokens_details"] as Record<string, unknown>)
      .cached_tokens;
    expect(readMeasureUsage(api, r)).toEqual({
      cacheEvidence: { kind: "invalid", reason: "missing-cached" },
      billing: { kind: "unknown", items: ["all"] },
    });
  });
  it("null details means cache counters were not reported, while a null counter remains invalid", () => {
    const detailsKey = api === "openai-responses" ? "input_tokens_details" : "prompt_tokens_details";
    expect(readMeasureUsage(api, { ...raw(api), [detailsKey]: null })).toEqual({
      cacheEvidence: { kind: "invalid", reason: "missing-cached" },
      billing: { kind: "unknown", items: ["all"] },
    });
    expect(readMeasureUsage(api, { ...raw(api), [detailsKey]: { cached_tokens: null } }).cacheEvidence).toEqual({
      kind: "invalid",
      reason: "not-integer",
    });
    if (api === "openai-completions")
      expect(readMeasureUsage(api, { ...raw(api), [detailsKey]: null, prompt_cache_hit_tokens: 80 }).usage).toEqual({
        P: 100,
        C: 80,
        output: 1,
      });
  });
  it("missing prompt is invalid even when cached tokens are reported", () => {
    const r = raw(api);
    delete r[api === "openai-responses" ? "input_tokens" : "prompt_tokens"];
    expect(readMeasureUsage(api, r).cacheEvidence).toEqual({ kind: "invalid", reason: "missing-prompt" });
  });
  it("keeps missing write/output absent while cache evidence stays valid", () => {
    const r = raw(api);
    delete r[api === "openai-responses" ? "output_tokens" : "completion_tokens"];
    delete (r[api === "openai-responses" ? "input_tokens_details" : "prompt_tokens_details"] as Record<string, unknown>)
      .cache_write_tokens;
    expect(readMeasureUsage(api, r)).toEqual({
      usage: { P: 100, C: 80 },
      cacheEvidence: { kind: "valid" },
      billing: { kind: "unknown", items: ["output", "write"] },
    });
  });
  it.each(["0", null, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "invalid reported counters stay invalid (%j)",
    (value) => {
      for (let index = 0; index < 4; index++) {
        const values: [unknown, unknown, unknown, unknown] = [100, 80, 20, 1];
        values[index] = value;
        const result = readMeasureUsage(api, raw(api, ...values));
        expect(result.cacheEvidence).toEqual({ kind: "invalid", reason: "not-integer" });
        expect(result.billing.kind).toBe("unknown");
        expect(result).not.toHaveProperty("usage");
      }
    },
  );
  it("negative counters invalidate both evidence and billing", () => {
    for (const r of [raw(api, -1, 0, 0), raw(api, 100, -1, 0), raw(api, 100, 80, -1), raw(api, 100, 80, 20, -1)])
      expect(readMeasureUsage(api, r)).toEqual({
        cacheEvidence: { kind: "invalid", reason: "negative" },
        billing: { kind: "unknown", items: ["all"] },
      });
  });
  it("enforces C ≤ P and C + W ≤ P against the independent prompt total", () => {
    expect(readMeasureUsage(api, raw(api, 100, 101, 0)).cacheEvidence).toEqual({
      kind: "invalid",
      reason: "cached-exceeds-prompt",
    });
    expect(readMeasureUsage(api, raw(api, 100, 80, 21)).cacheEvidence).toEqual({
      kind: "invalid",
      reason: "cached-plus-write-exceeds-prompt",
    });
    expect(readMeasureUsage(api, raw(api, 100, 80, 20)).cacheEvidence).toEqual({ kind: "valid" });
  });
  it("retains a cr-response-shaped injected relay baseline instead of confusing it with own-prefix hits", () => {
    const r = raw(api, 19028, 4096, 0, 5);
    r.attribution = { items: { injected: { input_tokens: 4096, cached_tokens: 4096 } } };
    expect(readMeasureUsage(api, r).usage).toEqual({ P: 19028, C: 4096, W: 0, output: 5 });
  });
});

describe("Completions usage cache-read aliases", () => {
  const api = "openai-completions";
  it("chooses the first present alias, including an explicit zero", () => {
    expect(
      readMeasureUsage(api, {
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 0 },
        prompt_cache_hit_tokens: 80,
        cached_tokens: 90,
      }).usage?.C,
    ).toBe(0);
    expect(readMeasureUsage(api, { prompt_tokens: 100, prompt_cache_hit_tokens: 80, cached_tokens: 90 }).usage?.C).toBe(
      80,
    );
    expect(readMeasureUsage(api, { prompt_tokens: 100, cached_tokens: 90 }).usage?.C).toBe(90);
  });
  it("cannot hide an invalid alias behind another valid one", () => {
    for (const r of [
      { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: "80" }, cached_tokens: 80 },
      { prompt_tokens: 100, cached_tokens: "80", prompt_cache_hit_tokens: 80 },
    ])
      expect(readMeasureUsage(api, r).cacheEvidence).toEqual({ kind: "invalid", reason: "not-integer" });
  });
});

describe.each(profiles)("%s final payload validator", (api) => {
  it("accepts exact synthetic content and unknown sampling keys", () => {
    expect(
      validateMeasurePayload(
        api,
        { ...payload(api), temperature: 0.3, top_p: 0.9, arbitrary_sampling: "tolerated" },
        expected(api),
      ),
    ).toEqual({ ok: true, effectiveTier: "auto" });
  });
  it.each([0, -1, 1.5, "1", null, 4096])("protects the exact positive integer output cap (%j)", (cap) => {
    refused(api, { [api === "openai-responses" ? "max_output_tokens" : "max_tokens"]: cap }, "bad-output-cap");
  });
  it("forbiddenKeys catches opaque custom budget fields without banning unrelated sampling keys", () => {
    const e = { ...expected(api), forbiddenKeys: ["opaque_limit"] };
    for (const value of [undefined, 0, 4096]) {
      for (const patch of [
        { opaque_limit: value },
        { thinking: { opaque_limit: value } },
        { reasoning: { opaque_limit: value } },
      ]) {
        expect(validateMeasurePayload(api, { ...payload(api), ...patch }, e)).toEqual({ ok: false, code: "thinking" });
      }
    }
    expect(validateMeasurePayload(api, { ...payload(api), opaque_limit: 4096 }, expected(api)).ok).toBe(true);
    expect(validateMeasurePayload(api, { ...payload(api), arbitrary_sampling: 4096 }, e).ok).toBe(true);
    expect(
      validateMeasurePayload(api, { ...payload(api), opaque_limit: 4096 }, { ...expected(api), forbiddenKeys: [] }).ok,
    ).toBe(true);
  });
  it("requires an output cap", () => {
    const p = payload(api);
    delete p[api === "openai-responses" ? "max_output_tokens" : "max_tokens"];
    expect(validateMeasurePayload(api, p, expected(api))).toEqual({ ok: false, code: "no-output-cap" });
  });
  it("protects service tier and store", () => {
    refused(api, { service_tier: "priority" }, "billing-tier");
    refused(api, { store: true }, "store");
  });
  it.each(["instructions", "prompt"])("rejects sampling-injected %s", (key) => {
    refused(api, { [key]: "extra text" }, "extra-input");
  });
  it("rejects extra messages, non-text input, altered synthetic text and hidden text-bearing fields", () => {
    const key = api === "openai-responses" ? "input" : "messages";
    const messages = payload(api)[key] as Array<Record<string, unknown>>;
    for (const bad of [
      [...messages, { role: "assistant", content: "extra" }],
      [messages[0], { role: "user", content: "altered" }],
      [messages[0], { role: "user", content: [{ type: "input_image", image_url: "https://stub.invalid" }] }],
      [messages[0], { role: "user", content: expected(api).expectedUser, extra: "injected" }],
    ])
      refused(api, { [key]: bad }, "extra-input");
  });
  it("supports only the declared long effective tiers; no silent short→long upgrade", () => {
    const e = { ...expected(api), requestedRetention: "long" as const };
    expect(validateMeasurePayload(api, payload(api), e)).toEqual({ ok: false, code: "long-unsupported" });
    expect(validateMeasurePayload(api, { ...payload(api), prompt_cache_retention: "24h" }, e)).toEqual({
      ok: true,
      effectiveTier: "retention-24h",
    });
    refused(api, { prompt_cache_retention: "24h" }, "no-cache-control");
    if (api === "openai-responses")
      expect(validateMeasurePayload(api, { ...payload(api), prompt_cache_options: { ttl: "30m" } }, e)).toEqual({
        ok: true,
        effectiveTier: "explicit-30m",
      });
  });
});

describe("OpenAI profile-specific protected fields", () => {
  it("Responses requires store:false, the exact cache key and no server-side state", () => {
    for (const patch of [{ store: undefined }, { store: null }]) refused("openai-responses", patch, "store");
    for (const field of ["previous_response_id", "conversation", "background"])
      refused("openai-responses", { [field]: false }, "server-state");
    refused("openai-responses", { prompt_cache_key: "wrong" }, "prompt-cache-key");
    for (const field of ["max_tokens", "max_completion_tokens"])
      refused("openai-responses", { [field]: 16 }, "conflicting-output-caps");
  });
  it("Completions checks both caps, streaming usage, server-billed features and thinking budgets", () => {
    refused("openai-completions", { max_completion_tokens: 4096 }, "conflicting-output-caps");
    expect(
      validateMeasurePayload(
        "openai-completions",
        { ...payload("openai-completions"), max_completion_tokens: 1 },
        expected("openai-completions"),
      ).ok,
    ).toBe(true);
    for (const patch of [{ stream_options: undefined }, { stream_options: { include_usage: false } }])
      refused("openai-completions", patch, "no-stream-usage");
    for (const field of ["audio", "prediction", "web_search_options"])
      refused("openai-completions", { [field]: {} }, "server-billed");
    refused("openai-completions", { modalities: ["text", "audio"] }, "server-billed");
    for (const patch of [
      { thinking_token_budget: 1000 },
      { reasoning_budget: 1000 },
      { thinking: { type: "enabled", budget_tokens: 1000 } },
      { chat_template_kwargs: { thinking_budget: 1000 } },
    ])
      refused("openai-completions", patch, "thinking");
  });
});

describe("P1 verifier regressions", () => {
  it("redacts ≥16-char pure-letter tokens and any path segment outside the short common-word allowlist", () => {
    for (const segment of [
      "abcdefghijklmnop",
      "OpaqueSecretPath",
      "opaque",
      "abc123",
      "tenant-secret",
      "a".repeat(15),
    ]) {
      const route = measureRouteKey({
        api: "openai-responses",
        url: `https://relay.invalid/${segment}/responses`,
        wireModel: "gpt-measure",
        effectiveTier: "auto",
      });
      expect(route.label).toContain("/…");
      expect(route.label).not.toContain(segment);
    }
    expect(
      measureRouteKey({
        api: "openai-responses",
        url: "https://relay.invalid/api/v1/responses",
        wireModel: "gpt-measure",
        effectiveTier: "auto",
      }).label,
    ).toContain("/api/v1");
  });
  it("refuses Anthropic 1h cache markers on a short request", () => {
    const e = expected("anthropic-messages");
    const p = {
      model: e.wireModel,
      max_tokens: 1,
      stream: true,
      system: [{ type: "text", text: e.expectedSystem, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: e.expectedUser, cache_control: { type: "ephemeral", ttl: "1h" } }],
        },
      ],
    };
    expect(validateMeasurePayload("anthropic-messages", p, e)).toEqual({ ok: false, code: "no-cache-control" });
  });
});
