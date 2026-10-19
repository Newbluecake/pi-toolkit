/** P2: real ModelRuntime → ModelRegistry.streamSimple → pi-ai builders → OpenAI SDK, fake SSE fetch only. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { wireMeasureCommand } from "../../src/cache-ttl/measure-command.js";
import { createMeasureClaim } from "../../src/cache-ttl/measure-claim.js";
import { createMeasureStore } from "../../src/cache-ttl/measure-store.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FakeClock } from "../../src/core/clock.js";
import { sendPipelinePing } from "../../src/cache-ttl/pipeline-ping.js";
import { validateMeasurePayload } from "../../src/cache-ttl/measure-payload.js";
import { readMeasureUsage } from "../../src/cache-ttl/measure-usage.js";
import { measureRouteKey } from "../../src/cache-ttl/measure-route.js";
import {
  OUTPUT_CAP,
  type EffectiveTier,
  type PayloadExpectation,
  type PayloadRejectionCode,
} from "../../src/cache-ttl/measure-types.js";
import type { PipelinePingInput } from "../../src/cache-ttl/pipeline-ping-types.js";

const profiles = ["openai-responses", "openai-completions"] as const;
type Profile = (typeof profiles)[number];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllEnvs();
});
const sessionId = `ttl-measure-${"prefix".repeat(12)}`;
const cacheKey = Array.from(sessionId).slice(0, 64).join("");
const system = "Nonce 123. You are a terse log triage assistant.";
const user = "Nonce 123. Log excerpt follows.\nrequest status=200\nTask: reply OK.";
const context = { systemPrompt: system, messages: [{ role: "user" as const, content: user, timestamp: 0 }] };
const responseUsage = {
  input_tokens: 19028,
  input_tokens_details: { cached_tokens: 4096, cache_write_tokens: 0 },
  output_tokens: 1,
  total_tokens: 19029,
};
const completionUsage = {
  prompt_tokens: 13452,
  prompt_tokens_details: { cached_tokens: 13451, cache_write_tokens: 0 },
  completion_tokens: 1,
  total_tokens: 13453,
};
const { total_tokens: _responseTotal, ...responseCounters } = responseUsage;
const { total_tokens: _completionTotal, ...completionCounters } = completionUsage;
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function responseFrame(type = "response.completed", usage: unknown = responseUsage): string {
  return data({
    type,
    response: {
      id: "resp-fixture",
      status: type === "response.incomplete" ? "incomplete" : "completed",
      incomplete_details: type === "response.incomplete" ? { reason: "max_output_tokens" } : null,
      output: [],
      usage,
    },
  });
}
function completionFrame(usage: unknown = completionUsage): string {
  return data({ id: "chat-fixture", object: "chat.completion.chunk", model: "fixture", choices: [], usage });
}
const completionFinish = data({
  id: "chat-fixture",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "length" }],
});
function sse(profile: Profile): string {
  return profile === "openai-responses"
    ? data({ type: "response.created", response: { id: "resp-fixture" } }) + responseFrame()
    : completionFinish + completionFrame() + "data: [DONE]\n\n";
}
const encoder = new TextEncoder();
async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
async function until(check: () => boolean) {
  const end = performance.now() + 1500;
  while (!check() && performance.now() < end) await new Promise<void>((resolve) => setTimeout(resolve, 2).unref());
  expect(check()).toBe(true);
}

async function environment(
  profile: Profile,
  options: {
    reasoning?: boolean;
    compat?: Record<string, unknown>;
    samplingParams?: Record<string, unknown>;
    chatGpt?: boolean;
    long?: boolean;
    session?: string;
    thinkingLevelMap?: Record<string, string | null>;
  } = {},
  fetchImpl?: typeof fetch,
) {
  const root = mkdtempSync(join(tmpdir(), "measure-openai-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  vi.stubEnv("PI_CACHE_RETENTION", "");
  const provider = options.chatGpt ? "openai" : "measure-openai-fixture";
  const baseUrl = options.chatGpt ? "https://api.openai.com/v1" : "https://relay.invalid/v1";
  const id = `measure-${profile}`;
  writeFileSync(
    join(root, "models.json"),
    JSON.stringify({
      providers: {
        [provider]: {
          api: profile,
          baseUrl,
          apiKey: options.chatGpt ? "synthetic-chatgpt-sign-in-token" : "sk-synthetic-fixture",
          models: [
            {
              id,
              name: "measurement fixture",
              api: profile,
              reasoning: options.reasoning ?? false,
              ...(options.thinkingLevelMap ? { thinkingLevelMap: options.thinkingLevelMap } : {}),
              input: ["text"],
              contextWindow: 200000,
              maxTokens: 4096,
              cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
              compat: {
                ...(profile === "openai-completions" ? { maxTokensField: "max_tokens" } : {}),
                ...options.compat,
              },
              ...(options.samplingParams ? { samplingParams: options.samplingParams } : {}),
            },
          ],
        },
      },
    }),
  );
  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
  });
  const registry = new ModelRegistry(runtime);
  expect(registry.getError()).toBeUndefined();
  const model = registry.find(provider, id);
  expect(model).toBeDefined();
  const expectation: PayloadExpectation = {
    api: profile,
    wireModel: id,
    expectedSystem: system,
    expectedUser: user,
    outputCap: OUTPUT_CAP[profile],
    requestedRetention: options.long ? "long" : "short",
    oauth: false,
    managedEffort: false,
    promptCacheKey: Array.from(options.session ?? sessionId)
      .slice(0, 64)
      .join(""),
  };
  const customBudgetKey = model!.compat?.thinkingTokenBudgetField;
  const level = profile === "openai-responses" && model!.reasoning ? clampThinkingLevel(model!, "low") : undefined;
  if (level && level !== "off") expectation.reasoningEffort = model!.thinkingLevelMap?.[level] ?? level;
  if (customBudgetKey) expectation.forbiddenKeys = [customBudgetKey];
  let tier: EffectiveTier = "auto";
  const validate = vi.fn((params: Record<string, unknown>) => {
    const verdict = validateMeasurePayload(profile, params, expectation);
    if (!verdict.ok) return verdict.code;
    tier = verdict.effectiveTier;
    return undefined;
  });
  const baseFetch =
    fetchImpl ?? vi.fn(async () => new Response(sse(profile), { headers: { "Content-Type": "text/event-stream" } }));
  const clock = new FakeClock(1000);
  const input: PipelinePingInput = {
    registry,
    model: model!,
    sessionId: options.session ?? sessionId,
    body: {},
    clock,
    deadlineAt: 31000,
    guard: () => true,
    fetchImpl: baseFetch,
    measurement: {
      profile,
      expectWireModel: id,
      routeKey: (url) => measureRouteKey({ api: profile, url, wireModel: id, effectiveTier: tier }),
      build: {
        context,
        maxTokens: OUTPUT_CAP[profile],
        cacheRetention: options.long ? "long" : "short",
        validate,
        ...(expectation.reasoningEffort ? { reasoning: "low" } : {}),
      },
    },
  };
  return { input, baseFetch, clock, validate, model: model!, registry, expectation, root };
}
async function expectRefusal(profile: Profile, options: Parameters<typeof environment>[1], code: PayloadRejectionCode) {
  const h = await environment(profile, options);
  const result = await sendPipelinePing(h.input);
  expect(result.outcome).toMatchObject({
    kind: "not-sent",
    reason: "capability",
    measured: { rejection: code },
    diag: { baseFetchCalls: 0 },
  });
  expect(h.baseFetch).not.toHaveBeenCalled();
  await result.settled;
}

describe.each(profiles)("real %s builder and complete-stream measurement", (profile) => {
  it.each([false, true])(
    "stock converted content: reasoning=%s; caps unchanged; one manual POST; raw usage at completion",
    async (reasoning) => {
      const h = await environment(profile, { reasoning });
      const result = await sendPipelinePing(h.input);
      expect(result.outcome).toMatchObject({
        kind: "usage",
        usage: undefined,
        diag: { explicitSuccess: true, sawMessageStart: false, baseFetchCalls: 1, onPayloadCalls: 1 },
        measured: { sentAt: 1000, headersAt: 1000 },
      });
      expect(h.validate).toHaveBeenCalledTimes(1);
      expect(h.baseFetch).toHaveBeenCalledTimes(1);
      const p = result.outcome.measured!.builtBody!;
      const messages = p[profile === "openai-responses" ? "input" : "messages"] as Array<Record<string, unknown>>;
      expect(messages[0]!.role).toBe(reasoning ? "developer" : "system");
      expect(messages[0]!.content).toBe(system);
      expect(messages[1]!.content).toEqual(
        profile === "openai-responses" ? [{ type: "input_text", text: user }] : user,
      );
      expect(p[profile === "openai-responses" ? "max_output_tokens" : "max_tokens"]).toBe(OUTPUT_CAP[profile]);
      if (profile === "openai-responses") {
        expect(p.prompt_cache_key).toBe(cacheKey);
        expect(p.store).toBe(false);
      }
      const [, init] = vi.mocked(h.baseFetch).mock.calls[0]!;
      expect(init!.redirect).toBe("manual");
      expect(JSON.parse(init!.body as string)).toEqual(JSON.parse(JSON.stringify(p)));
      expect(result.outcome.measured!.rawUsage).toEqual(
        profile === "openai-responses" ? responseCounters : completionCounters,
      );
      expect(readMeasureUsage(profile, result.outcome.measured!.rawUsage).cacheEvidence).toEqual({ kind: "valid" });
      await result.settled;
      expect(h.clock.pendingTimers).toBe(0);
    },
  );
  it("can replay the accepted body byte-for-byte without rebuilding or dropping the prefix cache key", async () => {
    const h = await environment(profile);
    const first = await sendPipelinePing(h.input);
    await first.settled;
    const measurement = { ...h.input.measurement! };
    delete measurement.build;
    measurement.expectRouteKey = first.outcome.measured!.routeKey!;
    const second = await sendPipelinePing({ ...h.input, body: first.outcome.measured!.builtBody!, measurement });
    expect(second.outcome.kind).toBe("usage");
    expect(h.baseFetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.baseFetch).mock.calls[1]![1]!.body).toBe(vi.mocked(h.baseFetch).mock.calls[0]![1]!.body);
    await second.settled;
  });
  it.each([
    [{ instructions: "injected" }, "extra-input"],
    [{ tools: [] }, "tools"],
    [{ service_tier: "priority" }, "billing-tier"],
    [{ store: true }, "store"],
  ] as const)("sampling override is validated AFTER model defaults (%j)", async (samplingParams, code) => {
    await expectRefusal(profile, { samplingParams }, code);
  });
  it("populates forbiddenKeys from the model's thinkingTokenBudgetField and refuses nested overrides", async () => {
    // pi 1.2's config schema currently limits this field to three conventional names.
    // Truly opaque forbidden keys are covered independently by the pure validator suite.
    for (const samplingParams of [
      { thinking_budget_tokens: 4096 },
      { thinking: { thinking_budget_tokens: 4096 } },
      { reasoning: { thinking_budget_tokens: 4096 } },
    ]) {
      const h = await environment(profile, {
        compat: { thinkingTokenBudgetField: "thinking_budget_tokens" },
        samplingParams,
      });
      expect(h.expectation.forbiddenKeys).toEqual(["thinking_budget_tokens"]);
      const result = await sendPipelinePing(h.input);
      expect(result.outcome).toMatchObject({
        kind: "not-sent",
        reason: "capability",
        measured: { rejection: "thinking" },
      });
      expect(h.baseFetch).not.toHaveBeenCalled();
      await result.settled;
    }
  });
  it("unknown sampling keys remain tolerated", async () => {
    const h = await environment(profile, { samplingParams: { temperature: 0.2, top_p: 0.9, future_sampling: 7 } });
    const result = await sendPipelinePing(h.input);
    expect(result.outcome.kind).toBe("usage");
    expect(result.outcome.measured!.builtBody!.future_sampling).toBe(7);
    await result.settled;
  });
  it("missing cached_tokens is no usable cache evidence, even though pi normalises it to zero", async () => {
    const usage =
      profile === "openai-responses"
        ? { input_tokens: 19028, output_tokens: 1 }
        : { prompt_tokens: 13452, completion_tokens: 1 };
    const h = await environment(
      profile,
      {},
      vi.fn(
        async () =>
          new Response(
            profile === "openai-responses"
              ? responseFrame("response.completed", usage)
              : completionFinish + completionFrame(usage) + "data: [DONE]\n\n",
          ),
      ),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome.kind).toBe("usage");
    expect(readMeasureUsage(profile, result.outcome.measured!.rawUsage).cacheEvidence).toEqual({
      kind: "invalid",
      reason: "missing-cached",
    });
    await result.settled;
  });
  it("does not settle on an initial event, finish_reason or usage callback before stream completion", async () => {
    let sink!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        sink = controller;
      },
    });
    const h = await environment(
      profile,
      {},
      vi.fn(async () => new Response(body)),
    );
    const done = vi.fn();
    const pending = sendPipelinePing(h.input).then((result) => {
      done();
      return result;
    });
    try {
      await until(() => vi.mocked(h.baseFetch).mock.calls.length === 1);
      sink.enqueue(
        encoder.encode(
          profile === "openai-responses"
            ? data({ type: "response.created", response: { id: "resp-fixture" } })
            : completionFinish,
        ),
      );
      await flush();
      expect(done).not.toHaveBeenCalled();
      sink.enqueue(encoder.encode(profile === "openai-responses" ? responseFrame() : completionFrame()));
      await flush();
      expect(done).not.toHaveBeenCalled();
      sink.close();
      const result = await pending;
      expect(result.outcome.kind).toBe("usage");
      await result.settled;
    } finally {
      try {
        sink.close();
      } catch {}
      h.clock.advance(30000);
    }
  });
  it("retains usage counters despite 10KiB attribution blobs at the top level and inside details", async () => {
    const counters = profile === "openai-responses" ? responseCounters : completionCounters;
    const detailsKey = profile === "openai-responses" ? "input_tokens_details" : "prompt_tokens_details";
    const details =
      profile === "openai-responses" ? responseCounters.input_tokens_details : completionCounters.prompt_tokens_details;
    const usage = {
      ...counters,
      attribution: { items: "x".repeat(10240) },
      [detailsKey]: { ...details, attribution: "x".repeat(10240) },
      output_tokens_details: { attribution: "x".repeat(10240) },
    };
    const h = await environment(
      profile,
      {},
      vi.fn(
        async () =>
          new Response(
            profile === "openai-responses"
              ? responseFrame("response.completed", usage)
              : completionFinish + completionFrame(usage) + "data: [DONE]\n\n",
          ),
      ),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome.kind).toBe("usage");
    expect(result.outcome.measured!.rawUsage).toEqual(counters);
    expect(Buffer.byteLength(JSON.stringify(result.outcome.measured!.rawUsage))).toBeLessThanOrEqual(4096);
    expect(readMeasureUsage(profile, result.outcome.measured!.rawUsage).cacheEvidence).toEqual({ kind: "valid" });
    await result.settled;
  });
  it("still caps the retained counter projection at 4KiB", async () => {
    const usage = {
      ...(profile === "openai-responses" ? responseUsage : completionUsage),
      [profile === "openai-responses" ? "input_tokens" : "prompt_tokens"]: "x".repeat(4096),
    };
    const h = await environment(
      profile,
      {},
      vi.fn(
        async () =>
          new Response(
            profile === "openai-responses"
              ? responseFrame("response.completed", usage)
              : completionFinish + completionFrame(usage) + "data: [DONE]\n\n",
          ),
      ),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({ kind: "usage", diag: { explicitSuccess: true } });
    expect(result.outcome.measured).not.toHaveProperty("rawUsage");
    expect(readMeasureUsage(profile, result.outcome.measured?.rawUsage).cacheEvidence).toEqual({
      kind: "invalid",
      reason: "no-terminal-frame",
    });
    await result.settled;
  });
  it("a stalled stream after usage still resolves by deadline and waits for physical settlement", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(sink) {
        sink.enqueue(
          encoder.encode(profile === "openai-responses" ? responseFrame() : completionFinish + completionFrame()),
        );
      },
      cancel,
    });
    const h = await environment(
      profile,
      {},
      vi.fn(async () => new Response(body)),
    );
    const pending = sendPipelinePing(h.input);
    await until(() => vi.mocked(h.baseFetch).mock.calls.length === 1);
    await flush();
    h.clock.advance(30000);
    const result = await pending;
    expect(result.outcome).toMatchObject({
      kind: "accepted-then-lost",
      diag: { deadlineHit: true, baseFetchCalls: 1 },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    await result.settled;
    expect(h.clock.pendingTimers).toBe(0);
  });
  it("retains the 64KiB scan ceiling and one-POST budget", async () => {
    const h = await environment(
      profile,
      {},
      vi.fn(async () => new Response("x".repeat(100000))),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({ kind: "malformed", diag: { bodyBytes: 65536, baseFetchCalls: 1 } });
    expect(h.baseFetch).toHaveBeenCalledTimes(1);
    await result.settled;
  });
  it("no terminal usage is accepted-then-lost, never a fabricated cache miss", async () => {
    const h = await environment(
      profile,
      {},
      vi.fn(
        async () =>
          new Response(
            profile === "openai-responses"
              ? data({ type: "response.created", response: { id: "resp-fixture" } })
              : completionFinish + "data: [DONE]\n\n",
          ),
      ),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome.kind).toBe("accepted-then-lost");
    expect(result.outcome.measured).not.toHaveProperty("rawUsage");
    await result.settled;
  });
});

describe("OpenAI profile-specific real builder conformance", () => {
  it("Responses supportsMaxOutputTokens:false and ChatGPT sign-in omit caps and are refused", async () => {
    await expectRefusal("openai-responses", { compat: { supportsMaxOutputTokens: false } }, "no-output-cap");
    await expectRefusal("openai-responses", { chatGpt: true }, "no-output-cap");
  });
  it("Responses rejects server state, prompt templates and bad cache keys from sampling params", async () => {
    for (const key of ["previous_response_id", "conversation", "background"])
      await expectRefusal("openai-responses", { samplingParams: { [key]: "injected" } }, "server-state");
    await expectRefusal("openai-responses", { samplingParams: { prompt: { id: "injected" } } }, "extra-input");
    await expectRefusal("openai-responses", { samplingParams: { prompt_cache_key: "wrong" } }, "prompt-cache-key");
  });
  it("Responses default long uses 24h, explicit-cache long uses 30m, unsupported long refuses", async () => {
    for (const explicit of [false, true]) {
      const h = await environment("openai-responses", {
        long: true,
        compat: { supportsExplicitPromptCacheMode: explicit },
      });
      const result = await sendPipelinePing(h.input);
      expect(result.outcome.kind).toBe("usage");
      const p = result.outcome.measured!.builtBody!;
      expect(validateMeasurePayload("openai-responses", p, h.expectation)).toEqual({
        ok: true,
        effectiveTier: explicit ? "explicit-30m" : "retention-24h",
      });
      if (explicit) expect(p.prompt_cache_options).toEqual({ ttl: "30m" });
      else expect(p.prompt_cache_retention).toBe("24h");
      await result.settled;
    }
    await expectRefusal(
      "openai-responses",
      { long: true, compat: { supportsLongCacheRetention: false } },
      "long-unsupported",
    );
  });
  it("Responses accepts max-output incomplete terminal usage and preserves the provider length reason", async () => {
    const h = await environment(
      "openai-responses",
      {},
      vi.fn(async () => new Response(responseFrame("response.incomplete"))),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({
      kind: "usage",
      diag: { piStopReason: "length", explicitSuccess: true },
      measured: { rawUsage: responseCounters },
    });
    await result.settled;
  });
  it("prefix sessionId cache key uses pi's Unicode code-point clamp", async () => {
    const session = "a".repeat(63) + "😀tail";
    const h = await environment("openai-responses", { session });
    const result = await sendPipelinePing(h.input);
    expect(result.outcome.measured!.builtBody!.prompt_cache_key).toBe("a".repeat(63) + "😀");
    await result.settled;
  });
  it.each([
    { top: undefined, alias: "prompt_cache_hit_tokens" },
    { top: null, alias: "cached_tokens" },
  ])(
    "Completions accepts Moonshot choices[0].usage when top usage is $top, preserving $alias",
    async ({ top, alias }) => {
      const counters = { prompt_tokens: 100, prompt_tokens_details: null, [alias]: 80, completion_tokens: 1 };
      const chunk = {
        id: "chat-fixture",
        object: "chat.completion.chunk",
        usage: top,
        choices: [{ index: 0, delta: {}, finish_reason: null, usage: { ...counters, attribution: "x".repeat(10240) } }],
      };
      const h = await environment(
        "openai-completions",
        {},
        vi.fn(async () => new Response(completionFinish + data(chunk) + "data: [DONE]\n\n")),
      );
      const result = await sendPipelinePing(h.input);
      expect(result.outcome).toMatchObject({
        kind: "usage",
        diag: { explicitSuccess: true },
        measured: { rawUsage: counters },
      });
      expect(result.outcome.measured!.rawUsage).toEqual(counters);
      expect(readMeasureUsage("openai-completions", result.outcome.measured!.rawUsage)).toEqual({
        usage: { P: 100, C: 80, output: 1 },
        cacheEvidence: { kind: "valid" },
        billing: { kind: "unknown", items: ["write"] },
      });
      await result.settled;
    },
  );
  it("Completions top-level usage takes precedence over a choice fallback", async () => {
    const chunk = {
      id: "chat-fixture",
      object: "chat.completion.chunk",
      usage: completionUsage,
      choices: [{ index: 0, delta: {}, usage: { prompt_tokens: 100, cached_tokens: 101 } }],
    };
    const h = await environment(
      "openai-completions",
      {},
      vi.fn(async () => new Response(completionFinish + data(chunk) + "data: [DONE]\n\n")),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome.measured!.rawUsage).toEqual(completionCounters);
    await result.settled;
  });
  it("Completions accepts compat cache_control text parts and developer role", async () => {
    const h = await environment("openai-completions", { reasoning: true, compat: { cacheControlFormat: "anthropic" } });
    const result = await sendPipelinePing(h.input);
    expect(result.outcome.kind).toBe("usage");
    const messages = result.outcome.measured!.builtBody!.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({
      role: "developer",
      content: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    });
    expect(messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: user, cache_control: { type: "ephemeral" } }],
    });
    await result.settled;
  });
  it("Completions max_completion_tokens is a valid stock cap, but a sampling dual-cap override refuses", async () => {
    const h = await environment("openai-completions", { compat: { maxTokensField: "max_completion_tokens" } });
    const result = await sendPipelinePing(h.input);
    expect(result.outcome.kind).toBe("usage");
    expect(result.outcome.measured!.builtBody!.max_completion_tokens).toBe(1);
    await result.settled;
    await expectRefusal(
      "openai-completions",
      { samplingParams: { max_completion_tokens: 4096 } },
      "conflicting-output-caps",
    );
  });
  it("Completions no streaming usage and forced thinking budget refuse before POST", async () => {
    await expectRefusal("openai-completions", { compat: { supportsUsageInStreaming: false } }, "no-stream-usage");
    await expectRefusal("openai-completions", { samplingParams: { thinking_token_budget: 4096 } }, "thinking");
  });
  it("Completions long requires the emitted 24h tier", async () => {
    await expectRefusal(
      "openai-completions",
      { long: true, compat: { supportsLongCacheRetention: false } },
      "long-unsupported",
    );
    const h = await environment("openai-completions", { long: true, compat: { supportsLongCacheRetention: true } });
    const result = await sendPipelinePing(h.input);
    expect(result.outcome.kind).toBe("usage");
    expect(result.outcome.measured!.builtBody!.prompt_cache_retention).toBe("24h");
    await result.settled;
  });
});

describe("live C2 allowance and lowest Responses effort regression", () => {
  it("real Responses builder accepts exact low reasoning with wire max_output_tokens still 16", async () => {
    const h = await environment("openai-responses", { reasoning: true });
    const result = await sendPipelinePing(h.input);
    expect(result.outcome.kind).toBe("usage");
    const built = result.outcome.measured!.builtBody!;
    expect(built.reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(built.include).toEqual(["reasoning.encrypted_content"]);
    expect(built.max_output_tokens).toBe(16);
    await result.settled;
    const measurement = { ...h.input.measurement! };
    delete measurement.build;
    const replay = await sendPipelinePing({ ...h.input, body: built, measurement });
    expect(replay.outcome.kind).toBe("usage");
    expect(vi.mocked(h.baseFetch).mock.calls[1]![1]!.body).toBe(vi.mocked(h.baseFetch).mock.calls[0]![1]!.body);
    await replay.settled;
  });
  it("low uses the model thinkingLevelMap exactly", async () => {
    const h = await environment("openai-responses", { reasoning: true, thinkingLevelMap: { low: "medium" } });
    const result = await sendPipelinePing(h.input);
    expect(result.outcome.kind).toBe("usage");
    expect(result.outcome.measured!.builtBody!.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(result.outcome.measured!.builtBody!.max_output_tokens).toBe(16);
    await result.settled;
  });
  it("sampling cannot replace the requested low effort with high effort", async () => {
    await expectRefusal(
      "openai-responses",
      { reasoning: true, samplingParams: { reasoning: { effort: "high", summary: "auto" } } },
      "thinking",
    );
  });
  it.each([32, 512, 513])(
    "real registry command usage output=%i respects the allowance, not the wire cap",
    async (output) => {
      const usage = {
        input_tokens: 14287,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 14287 },
        output_tokens: output,
        output_tokens_details: { reasoning_tokens: 25 },
      };
      const h = await environment(
        "openai-responses",
        { reasoning: true },
        vi.fn(async () => new Response(responseFrame("response.completed", usage))),
      );
      const claim = createMeasureClaim();
      const store = createMeasureStore({
        filePath: join(h.root, "measurement-result.json"),
        clock: h.clock,
        slot: claim.persistSlot,
      });
      const hooks = new Map<string, (event: unknown, ctx: unknown) => void>();
      const port = wireMeasureCommand(
        {
          on(name: string, fn: any) {
            hooks.set(name, fn);
          },
        } as unknown as ExtensionAPI,
        { clock: h.clock, claim, store, fetchImpl: h.baseFetch },
      );
      const ctx = {
        model: h.model,
        modelRegistry: h.registry,
        hasUI: true,
        sessionManager: { getSessionId: () => "live-C2" },
        ui: { notify: vi.fn(), setStatus: vi.fn() },
      } as unknown as ExtensionContext;
      await port.handle("measure --yes", ctx);
      try {
        await until(() => (output > 512 ? claim.state === "free" : claim.current()?.sent === 6));
        expect(h.baseFetch).toHaveBeenCalledTimes(output > 512 ? 1 : 6);
        const wire = JSON.parse(vi.mocked(h.baseFetch).mock.calls[0]![1]!.body as string);
        expect(wire.max_output_tokens).toBe(16);
        expect(wire.reasoning).toEqual({ effort: "low", summary: "auto" });
        const notices = () =>
          vi
            .mocked(ctx.ui.notify)
            .mock.calls.map(([text]) => text)
            .join("\n");
        if (output > 512) {
          expect(notices()).toContain("C2 output 513 > 512");
          await store.flush();
          const saved = (await store.readRoutes())[0]!.latest!;
          expect(saved.boundExceeded).toEqual({ condition: "C2", observed: 513, limit: 512 });
          expect(saved.requests.sent).toBe(1);
          vi.mocked(ctx.ui.notify).mockClear();
          await port.handle("measure status", ctx);
          expect(notices()).toContain("C2 output 513 > 512");
        } else {
          expect(notices()).not.toContain("bound-exceeded");
          expect(claim.current()?.sent).toBe(6);
        }
      } finally {
        hooks.get("session_shutdown")?.({ reason: "quit" }, ctx);
        await store.flush();
      }
    },
  );
});

describe("live round 2 — low effort and redacted provider rejection", () => {
  it("a no-map reasoning model uses low, never minimal/none, against a rejecting relay fixture", async () => {
    const baseFetch = vi.fn<typeof fetch>(async (_request, init) => {
      const params = JSON.parse(init!.body as string);
      if (params.reasoning.effort !== "low")
        return new Response(
          JSON.stringify({ error: { message: "Unsupported effort; supported: low, medium, high" } }),
          { status: 400 },
        );
      return new Response(responseFrame());
    });
    const h = await environment("openai-responses", { reasoning: true }, baseFetch);
    expect(h.model.thinkingLevelMap).toBeUndefined();
    const result = await sendPipelinePing(h.input);
    expect(result.outcome.kind).toBe("usage");
    expect(JSON.parse(baseFetch.mock.calls[0]![1]!.body as string).reasoning).toEqual({
      effort: "low",
      summary: "auto",
    });
    await result.settled;
  });
  it("HTTP400 message is bounded/redacted in the notice, saved record and reloaded status", async () => {
    const message =
      `Unsupported parameter: future_flag. sk-synthetic-fixture Bearer made-up-private-token https://user:password@relay.invalid/?api_key=private-query api_key="another-private-key" ` +
      "details ".repeat(40);
    const h = await environment(
      "openai-responses",
      { reasoning: true },
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message }, headers: { authorization: "must-not-be-copied" } }), {
            status: 400,
          }),
      ),
    );
    const claim = createMeasureClaim();
    const store = createMeasureStore({
      filePath: join(h.root, "measurement-errors.json"),
      clock: h.clock,
      slot: claim.persistSlot,
    });
    const hooks = new Map<string, (event: unknown, ctx: unknown) => void>();
    const pi = {
      on(name: string, handler: any) {
        hooks.set(name, handler);
      },
    } as unknown as ExtensionAPI;
    const port = wireMeasureCommand(pi, { clock: h.clock, claim, store, fetchImpl: h.baseFetch });
    const ctx = {
      model: h.model,
      modelRegistry: h.registry,
      hasUI: true,
      sessionManager: { getSessionId: () => "rejected-measure" },
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    } as unknown as ExtensionContext;
    await port.handle("measure --yes", ctx);
    await until(() => claim.state === "free");
    await store.flush();
    const record = (await store.readRoutes())[0]!.latest!;
    const error = record.httpError!;
    expect(record.statusReason).toBe("http-400");
    expect(record.requests.sent).toBe(1);
    expect(error.status).toBe(400);
    expect(error.message).toContain("Unsupported parameter: future_flag.");
    expect(Array.from(error.message).length).toBeLessThanOrEqual(160);
    expect(error.message).toContain("[REDACTED]");
    const text = () =>
      vi
        .mocked(ctx.ui.notify)
        .mock.calls.map(([s]) => s)
        .join("\n");
    expect(text()).toContain(`http-400: ${error.message}`);
    for (const secret of [
      "sk-synthetic-fixture",
      "made-up-private-token",
      "private-query",
      "another-private-key",
      "must-not-be-copied",
      "user:password",
    ])
      expect(JSON.stringify(record)).not.toContain(secret);
    hooks.get("session_shutdown")?.({ reason: "reload" }, ctx);
    vi.mocked(ctx.ui.notify).mockClear();
    const fresh = wireMeasureCommand({ on() {} } as unknown as ExtensionAPI, { clock: h.clock, claim, store });
    await fresh.handle("measure status", ctx);
    expect(text()).toContain(`http-400: ${error.message}`);
    expect(h.baseFetch).toHaveBeenCalledTimes(1);
  });
});
