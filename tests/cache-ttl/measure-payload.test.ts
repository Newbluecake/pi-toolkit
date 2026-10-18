import { describe, expect, it, vi } from "vitest";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { validateMeasurePayload } from "../../src/cache-ttl/measure-payload.js";
import {
  OUTPUT_CAP,
  VALIDATOR_LIMITS,
  type PayloadExpectation,
  type PayloadRejectionCode,
} from "../../src/cache-ttl/measure-types.js";
import type { PipelinePingModel } from "../../src/cache-ttl/pipeline-ping-types.js";

const api = "anthropic-messages";
const expectation: PayloadExpectation = {
  api,
  wireModel: "claude-measure",
  expectedSystem: "Nonce abc. Be terse.",
  expectedUser: "Nonce abc. Log excerpt. Reply OK.",
  outputCap: OUTPUT_CAP[api],
  requestedRetention: "short",
  oauth: false,
  managedEffort: false,
};
const cc = { type: "ephemeral" };
function payload(): Record<string, unknown> {
  return {
    model: expectation.wireModel,
    max_tokens: 1,
    stream: true,
    system: [{ type: "text", text: expectation.expectedSystem, cache_control: cc }],
    messages: [{ role: "user", content: [{ type: "text", text: expectation.expectedUser, cache_control: cc }] }],
  };
}
function validate(p: Record<string, unknown>, e: PayloadExpectation = expectation) {
  return validateMeasurePayload(api, p, e);
}
function refused(p: Record<string, unknown>, code: PayloadRejectionCode, e = expectation) {
  expect(validate(p, e)).toEqual({ ok: false, code });
}

/** A real pi-ai build, intercepted at onPayload: no HTTP and no secret credentials. */
async function realBuild(oauth: boolean, managedEffort: boolean, long: boolean): Promise<Record<string, unknown>> {
  const model: PipelinePingModel = {
    id: expectation.wireModel,
    name: "measure fixture",
    api,
    provider: "measure-test",
    baseUrl: "https://stub.invalid",
    reasoning: false,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 4096,
    cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
    compat: { supportsMidConvoEffort: managedEffort },
  };
  const fetch = vi.fn<typeof globalThis.fetch>();
  let built: Record<string, unknown> | undefined;
  await streamSimple(
    model,
    {
      messages: [
        { role: "system", content: expectation.expectedSystem, timestamp: 0 },
        { role: "user", content: expectation.expectedUser, timestamp: 1 },
      ],
    },
    {
      apiKey: oauth ? "sk-ant-oat01-synthetic-fixture" : "synthetic-api-key",
      maxTokens: 1,
      maxRetries: 0,
      cacheRetention: long ? "long" : "short",
      fetch,
      onPayload: (p) => {
        built = structuredClone(p);
        throw new Error("fixture captured before POST");
      },
    },
  ).result();
  expect(fetch).not.toHaveBeenCalled();
  expect(built).toBeDefined();
  return built!;
}

describe("Anthropic build-mode payload validator", () => {
  it("accepts exact converted content, no thinking and disabled thinking, tolerating unknown sampling keys", () => {
    expect(validate({ ...payload(), temperature: 0.2, top_p: 0.9, future_sampling_key: true })).toEqual({
      ok: true,
      effectiveTier: "ephemeral",
    });
    expect(validate({ ...payload(), thinking: { type: "disabled" } }).ok).toBe(true);
  });
  it.each([false, true])("accepts real pi-ai stock builder output: oauth=%s", async (oauth) => {
    for (const managedEffort of [false, true])
      for (const long of [false, true]) {
        const p = await realBuild(oauth, managedEffort, long);
        expect(
          validate(p, { ...expectation, oauth, managedEffort, requestedRetention: long ? "long" : "short" }),
        ).toEqual({ ok: true, effectiveTier: long ? "ephemeral-1h" : "ephemeral" });
        expect(p.max_tokens).toBe(1); // Never silently raise the measurement cap for adaptive thinking.
      }
  });
  it.each([0, -1, 1.5, "1", null, NaN, 2, 4096])("requires an exact positive integer output cap (%j)", (cap) => {
    refused({ ...payload(), max_tokens: cap }, "bad-output-cap");
  });
  it("requires a cap, protects foreign/dual cap fields and the caller's output cap", () => {
    const p = payload();
    delete p.max_tokens;
    refused(p, "no-output-cap");
    for (const key of ["max_completion_tokens", "max_output_tokens"])
      for (const value of [1, 4096, undefined]) refused({ ...payload(), [key]: value }, "conflicting-output-caps");
    refused(payload(), "bad-output-cap", { ...expectation, outputCap: 4096 });
  });
  it.each([
    [{ model: "wrong" }, "model-mismatch"],
    [{ stream: false }, "not-streaming"],
    [{ tools: [] }, "tools"],
    [{ tool_choice: "none" }, "tools"],
    [{ functions: [] }, "tools"],
    [{ n: 2 }, "n"],
    [{ service_tier: "priority" }, "billing-tier"],
    [{ service_tier: null }, "billing-tier"],
    [{ thinking: { type: "enabled", budget_tokens: 1 } }, "thinking"],
    [{ thinking: { type: "adaptive" } }, "thinking"],
    [{ output_config: { effort: "high" } }, "thinking"],
    [{ thinking: { type: "disabled", budget_tokens: 1 } }, "thinking"],
    [{ mcp_servers: [] }, "server-tools"],
    [{ container: null }, "server-tools"],
    [{ instructions: "inject" }, "extra-input"],
    [{ prompt: "inject" }, "extra-input"],
    [{ system: undefined }, "missing-synthetic-content"],
    [{ messages: [] }, "missing-synthetic-content"],
  ] as const)("protected field: %j ⇒ %s", (patch, code) => {
    refused({ ...payload(), ...patch }, code);
  });
  it.each(["auto", "default", "standard_only"])("accepts standard billing tier %s", (service_tier) => {
    expect(validate({ ...payload(), service_tier }).ok).toBe(true);
  });
  it("refuses injected/changed input, extra roles, non-text blocks and text hidden in unknown content fields", () => {
    const mutations = [
      { system: [{ type: "text", text: `${expectation.expectedSystem}!` }] },
      {
        system: [
          { type: "text", text: expectation.expectedSystem },
          { type: "text", text: "extra" },
        ],
      },
      { messages: [{ role: "user", content: `${expectation.expectedUser}!` }] },
      { messages: [...(payload().messages as unknown[]), { role: "assistant", content: "OK" }] },
      {
        messages: [
          { role: "user", content: [{ type: "image", source: { type: "url", url: "https://stub.invalid" } }] },
        ],
      },
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: expectation.expectedUser, extra: "injection", cache_control: cc }],
          },
        ],
      },
    ];
    for (const patch of mutations) refused({ ...payload(), ...patch }, "extra-input");
  });
  it("OAuth accepts ONLY the exact leading identity, not a ≤200-char arbitrary block or a different position", async () => {
    const p = await realBuild(true, false, false);
    refused(p, "extra-input");
    const system = structuredClone(p.system) as Array<Record<string, unknown>>;
    system[0]!.text = "You are a different CLI.";
    refused({ ...p, system }, "extra-input", { ...expectation, oauth: true });
    system[0]!.text = "You are Claude Code, Anthropic's official CLI for Claude. ";
    refused({ ...p, system }, "extra-input", { ...expectation, oauth: true });
    refused({ ...p, system: (p.system as unknown[]).toReversed() }, "extra-input", { ...expectation, oauth: true });
  });
  it("managed effort permits only the stock adaptive form and empty effort system message", async () => {
    const p = await realBuild(false, true, false);
    refused(p, "thinking");
    const e = { ...expectation, managedEffort: true };
    refused({ ...p, thinking: { ...(p.thinking as object), budget_tokens: 1000 } }, "thinking", e);
    refused({ ...p, messages: (p.messages as unknown[]).slice(0, 1) }, "extra-input", e);
    refused(
      {
        ...p,
        messages: [
          ...(p.messages as unknown[]).slice(0, 1),
          { role: "system", content: "extra", output_config: { effort: "high" } },
        ],
      },
      "extra-input",
      e,
    );
  });
  it("requires the last user cache marker; distinguishes unsupported long and effective TTL", () => {
    for (const control of [undefined, { type: "permanent" }, { type: "ephemeral", ttl: "24h" }]) {
      refused(
        {
          ...payload(),
          messages: [
            { role: "user", content: [{ type: "text", text: expectation.expectedUser, cache_control: control }] },
          ],
        },
        "no-cache-control",
      );
    }
    refused(payload(), "long-unsupported", { ...expectation, requestedRetention: "long" });
    const p = payload();
    (p.system as Array<Record<string, unknown>>)[0]!.cache_control = { type: "ephemeral", ttl: "1h" };
    (p.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content[0]!.cache_control = {
      type: "ephemeral",
      ttl: "1h",
    };
    expect(validate(p, { ...expectation, requestedRetention: "long" })).toEqual({
      ok: true,
      effectiveTier: "ephemeral-1h",
    });
  });
  it("enforces the serialized UTF-8 byte budget (not JS character count) and refuses cycles", () => {
    refused({ ...payload(), unknown_sampling_key: "界".repeat(VALIDATOR_LIMITS.maxSerializedBytes / 2) }, "too-large");
    const p = payload();
    p.circular = p;
    refused(p, "too-large");
  });
});
