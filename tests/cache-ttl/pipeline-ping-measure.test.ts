import { describe, expect, it, vi } from "vitest";
import { FakeClock, systemClock } from "../../src/core/clock.js";
import { sendPipelinePing } from "../../src/cache-ttl/pipeline-ping.js";
import { measureRouteKey } from "../../src/cache-ttl/measure-route.js";
import { validateMeasurePayload } from "../../src/cache-ttl/measure-payload.js";
import { MEASURE_RAW_USAGE_MAX_BYTES } from "../../src/cache-ttl/measure-types.js";
import type {
  PipelineMeasurementInput,
  PipelinePingInput,
  PipelinePingModel,
  PipelinePingRegistry,
} from "../../src/cache-ttl/pipeline-ping-types.js";

type Options = NonNullable<Parameters<PipelinePingRegistry["streamSimple"]>[2]>;
const model: PipelinePingModel = {
  id: "claude-test",
  name: "test",
  api: "anthropic-messages",
  provider: "test",
  baseUrl: "https://relay.invalid/anthropic",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
  contextWindow: 200000,
  maxTokens: 4096,
};
const raw = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
const context = {
  messages: [
    { role: "system" as const, content: "synthetic system", timestamp: 0 },
    { role: "user" as const, content: "synthetic user", timestamp: 1 },
  ],
};
const expectation = {
  api: "anthropic-messages" as const,
  wireModel: model.id,
  expectedSystem: "synthetic system",
  expectedUser: "synthetic user",
  outputCap: 1,
  requestedRetention: "short" as const,
  oauth: false,
  managedEffort: false,
};
function params(): Record<string, unknown> {
  return {
    model: model.id,
    max_tokens: 1,
    stream: true,
    system: [{ type: "text", text: expectation.expectedSystem, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: expectation.expectedUser, cache_control: { type: "ephemeral" } }],
      },
    ],
  };
}
const routeKey = (url: string) =>
  measureRouteKey({ api: "anthropic-messages", url, wireModel: model.id, effectiveTier: "ephemeral" });
const url = `${model.baseUrl}/v1/messages?beta=true`;
const eventText = (value: unknown = raw) =>
  `data: ${JSON.stringify({ type: "message_start", message: { usage: value } })}\n\n`;
const encoder = new TextEncoder();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
interface HarnessOptions {
  beforePayload?: () => void | Promise<void>;
  afterPayload?: () => void;
  afterResult?: () => Promise<void>;
  secondPayload?: boolean;
  secondFetch?: boolean;
  request?: boolean;
  requestWithInit?: boolean;
  url?: string;
  wireBody?: unknown;
  skipPayload?: boolean;
  method?: string;
}
function harness(fake: HarnessOptions = {}, baseFetch: typeof fetch = vi.fn(async () => new Response(eventText()))) {
  const clock = new FakeClock(1000);
  const built = params();
  const payloadReturns: unknown[] = [];
  const observedEvents: Array<{ message: { usage: Record<string, unknown> } }> = [];
  let options!: Options;
  const streamSimple = vi.fn<PipelinePingRegistry["streamSimple"]>((selected, _context, opts) => {
    options = opts!;
    const run = async () => {
      try {
        await options.transformHeaders?.({ "X-API-Key": "secret", "Content-Type": "application/json" });
        await fake.beforePayload?.();
        const replacement = fake.skipPayload ? built : await options.onPayload?.(built, selected);
        payloadReturns.push(replacement);
        const body = fake.wireBody ?? replacement ?? built;
        fake.afterPayload?.();
        if (fake.secondPayload) await options.onPayload?.(built, selected);
        const init: RequestInit = {
          method: fake.method ?? "POST",
          body: JSON.stringify(body),
          headers: { "X-API-Key": "secret", "Content-Type": "application/json" },
          signal: options.signal!,
        };
        const post = () =>
          fake.request
            ? options.fetch!(
                new Request(fake.url ?? url, { ...init, redirect: "follow" }),
                fake.requestWithInit ? init : undefined,
              )
            : options.fetch!(fake.url ?? url, init);
        const response = await post();
        if (fake.secondFetch) await post();
        if (!response.ok) {
          await response.text();
          return { stopReason: "error" };
        }
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let text = "";
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            text += decoder.decode(part.value, { stream: true });
            let end: number;
            while ((end = text.indexOf("\n")) >= 0) {
              const line = text.slice(0, end);
              text = text.slice(end + 1);
              if (line.startsWith("data: ")) {
                const event = JSON.parse(line.slice(6));
                observedEvents.push(event);
                await options.onProviderStreamEvent?.(event, selected);
              }
            }
            if (options.signal?.aborted) break;
          }
        } finally {
          reader.releaseLock();
        }
        return { stopReason: "stop" };
      } catch {
        return { stopReason: options.signal?.aborted ? "aborted" : "error" };
      } finally {
        await fake.afterResult?.();
      }
    };
    const promise = run();
    return { result: () => promise } as ReturnType<PipelinePingRegistry["streamSimple"]>;
  });
  const measurement: PipelineMeasurementInput = { profile: "anthropic-messages", routeKey, expectWireModel: model.id };
  const input: PipelinePingInput = {
    registry: { streamSimple },
    model,
    sessionId: "ttl-measure-fixture",
    body: params(),
    clock,
    deadlineAt: 31000,
    guard: () => true,
    fetchImpl: baseFetch,
    measurement,
  };
  return {
    input,
    clock,
    built,
    measurement,
    streamSimple,
    baseFetch,
    payloadReturns,
    observedEvents,
    options: () => options,
  };
}
function build(
  h: ReturnType<typeof harness>,
  validate = vi.fn((p: Record<string, unknown>) => {
    const verdict = validateMeasurePayload("anthropic-messages", p, expectation);
    return verdict.ok ? undefined : verdict.code;
  }),
) {
  h.measurement.build = { context, maxTokens: 1, cacheRetention: "short", validate };
  return validate;
}

describe("measurement pipeline mode — additive Anthropic transport", () => {
  it("builds via pi, validates once, returns undefined, clones the accepted params and ignores replay body", async () => {
    const h = harness();
    const validate = build(h);
    const result = await sendPipelinePing({ ...h.input, body: { model: "ignored", tools: ["ignored"] } });
    expect(result.outcome.kind).toBe("usage");
    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledWith(h.built);
    expect(h.payloadReturns).toEqual([undefined]);
    expect(result.outcome.measured).toEqual({
      builtBody: h.built,
      routeKey: routeKey(url).key,
      routeLabel: routeKey(url).label,
      sentAt: 1000,
      headersAt: 1000,
      rawUsage: raw,
    });
    expect(result.outcome.measured!.builtBody).not.toBe(h.built);
    (h.built.system as Array<Record<string, unknown>>)[0]!.text = "changed later";
    expect(result.outcome.measured!.builtBody!.system).toEqual(params().system);
    expect(h.streamSimple).toHaveBeenCalledWith(
      model,
      context,
      expect.objectContaining({
        maxTokens: 1,
        cacheRetention: "short",
        maxRetries: 0,
        sessionId: "ttl-measure-fixture",
        timeoutMs: 30000,
      }),
    );
    expect(h.baseFetch).toHaveBeenCalledTimes(1);
    await result.settled;
  });
  it("replays the body reference verbatim and records actual send/header instants", async () => {
    const h = harness(
      { afterPayload: () => h.clock.advance(17) },
      vi.fn(async () => {
        h.clock.advance(23);
        return new Response(eventText());
      }),
    );
    const result = await sendPipelinePing(h.input);
    expect(h.payloadReturns[0]).toBe(h.input.body);
    expect(result.outcome.measured).toMatchObject({ sentAt: 1017, headersAt: 1040, rawUsage: raw });
    expect(result.outcome.measured).not.toHaveProperty("builtBody");
    await result.settled;
  });
  it.each(["tools", "bad-output-cap", "extra-input", "long-unsupported"])(
    "validator refusal %s means capability, rejection and zero POSTs",
    async (code) => {
      const h = harness();
      build(
        h,
        vi.fn(() => code),
      );
      const result = await sendPipelinePing(h.input);
      expect(result.outcome).toMatchObject({
        kind: "not-sent",
        reason: "capability",
        measured: { rejection: code },
        diag: { baseFetchCalls: 0 },
      });
      expect(h.baseFetch).not.toHaveBeenCalled();
      expect(result.outcome.measured).not.toHaveProperty("builtBody");
      await result.settled;
    },
  );
  it("a throwing validator cannot authorize a send", async () => {
    const h = harness();
    build(
      h,
      vi.fn(() => {
        throw new Error("broken validator");
      }),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({ kind: "not-sent", reason: "capability" });
    expect(h.baseFetch).not.toHaveBeenCalled();
    await result.settled;
  });
  it("blocks a second payload and a second POST; validates only the first payload", async () => {
    const h = harness({ secondPayload: true });
    const validate = build(h);
    const result = await sendPipelinePing(h.input);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(h.baseFetch).not.toHaveBeenCalled();
    expect(result.outcome.diag.onPayloadCalls).toBe(2);
    await result.settled;
    const other = harness({ secondFetch: true });
    const sent = await sendPipelinePing(other.input);
    expect(other.baseFetch).toHaveBeenCalledTimes(1);
    expect(sent.outcome.diag.baseFetchCalls).toBe(1);
    await sent.settled;
  });
  it.each([301, 302, 303, 307, 308, 399])(
    "%i never follows redirects and immediately reports http (including a stalled redirect body)",
    async (status) => {
      const cancel = vi.fn();
      const h = harness(
        {},
        vi.fn(
          async () =>
            new Response(new ReadableStream({ cancel }), {
              status,
              headers: { Location: "https://secret.invalid/never-follow" },
            }),
        ),
      );
      const result = await sendPipelinePing(h.input);
      expect(result.outcome).toMatchObject({
        kind: "http",
        status,
        measured: { redirected: true, sentAt: 1000, headersAt: 1000 },
      });
      expect(vi.mocked(h.baseFetch).mock.calls[0]![1]!.redirect).toBe("manual");
      expect(h.baseFetch).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result.outcome)).not.toContain("secret.invalid");
      await result.settled;
    },
  );
  it.each([false, true])("re-wraps Request inputs in manual mode (init override %s)", async (requestWithInit) => {
    const h = harness({ request: true, requestWithInit });
    const result = await sendPipelinePing(h.input);
    expect(result.outcome.kind).toBe("usage");
    const [request, init] = vi.mocked(h.baseFetch).mock.calls[0]!;
    expect(request).toBeInstanceOf(Request);
    expect((request as Request).redirect).toBe("manual");
    expect(init!.redirect).toBe("manual");
    expect(result.outcome.diag.wireHeaderNames).toEqual(["content-type", "x-api-key"]);
    await result.settled;
  });
  it.each(["replacement-write", "control", "probe", "renewal"])(
    "requires the run-wide URL key for %s (zero POSTs)",
    async (kind) => {
      const h = harness({ url: `${model.baseUrl}/changed/v1/messages?beta=true` });
      if (kind === "replacement-write") build(h);
      h.measurement.expectRouteKey = routeKey(url).key;
      const result = await sendPipelinePing(h.input);
      expect(result.outcome).toMatchObject({
        kind: "not-sent",
        reason: "capability",
        measured: { routeMismatch: true, routeKey: routeKey(`${model.baseUrl}/changed/v1/messages?beta=true`).key },
      });
      expect(h.baseFetch).not.toHaveBeenCalled();
      await result.settled;
    },
  );
  it("a matching run-wide key admits a later write and read; closure failure refuses", async () => {
    for (const isWrite of [false, true]) {
      const h = harness();
      if (isWrite) build(h);
      h.measurement.expectRouteKey = routeKey(url).key;
      const result = await sendPipelinePing(h.input);
      expect(result.outcome.kind).toBe("usage");
      await result.settled;
    }
    const h = harness();
    h.measurement.routeKey = () => {
      throw new Error("private URL");
    };
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({ kind: "not-sent", reason: "capability" });
    expect(h.baseFetch).not.toHaveBeenCalled();
    await result.settled;
  });
  it.each([undefined, "sha256:expected"])(
    "refuses body model mismatch independently of key (%s)",
    async (expectRouteKey) => {
      const h = harness({ wireBody: { model: "another-model" } });
      if (expectRouteKey !== undefined) h.measurement.expectRouteKey = expectRouteKey;
      const result = await sendPipelinePing(h.input);
      expect(result.outcome).toMatchObject({
        kind: "not-sent",
        reason: "capability",
        measured: { routeMismatch: true },
      });
      expect(h.baseFetch).not.toHaveBeenCalled();
      await result.settled;
    },
  );
  it.each([{ method: "GET" }, { url: "https://relay.invalid/responses" }, { skipPayload: true }])(
    "rejects non-admissible provider fetches (%j)",
    async (fake) => {
      const h = harness(fake);
      const result = await sendPipelinePing(h.input);
      expect(result.outcome).toMatchObject({ kind: "not-sent", reason: "capability" });
      expect(h.baseFetch).not.toHaveBeenCalled();
      await result.settled;
    },
  );
  it("gates the model api against the selected profile before stream/auth", async () => {
    const h = harness();
    const result = await sendPipelinePing({ ...h.input, model: { ...model, api: "openai-responses" } });
    expect(result.outcome).toMatchObject({ kind: "not-sent", reason: "capability", measured: {} });
    expect(h.streamSimple).not.toHaveBeenCalled();
    await result.settled;
  });
  it("rechecks the late guard at wrapped fetch, after build validation, for zero POSTs", async () => {
    let live = true;
    const h = harness({
      afterPayload: () => {
        live = false;
      },
    });
    build(h);
    const result = await sendPipelinePing({ ...h.input, guard: () => live });
    expect(result.outcome).toMatchObject({
      kind: "not-sent",
      reason: "guard",
      measured: { builtBody: h.built },
      diag: { baseFetchCalls: 0 },
    });
    expect(result.outcome.measured).not.toHaveProperty("sentAt");
    expect(h.baseFetch).not.toHaveBeenCalled();
    await result.settled;
  });
  it("rechecks lateness after route computation, immediately before base fetch", async () => {
    let live = true;
    const h = harness();
    h.measurement.routeKey = (value) => {
      live = false;
      return routeKey(value);
    };
    const result = await sendPipelinePing({ ...h.input, guard: () => live });
    expect(result.outcome).toMatchObject({ kind: "not-sent", reason: "guard" });
    expect(h.baseFetch).not.toHaveBeenCalled();
    await result.settled;
  });
  it("captures a deep bounded raw usage clone (missing counters stay missing), cancels at message_start", async () => {
    const cancel = vi.fn();
    const h = harness(
      {},
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(sink) {
                sink.enqueue(
                  encoder.encode(
                    eventText({ cache_read_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0 } }),
                  ),
                );
              },
              cancel,
            }),
          ),
      ),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({
      kind: "usage",
      measured: { rawUsage: { cache_read_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0 } } },
    });
    expect(result.outcome.measured!.rawUsage).not.toHaveProperty("input_tokens");
    const observed = h.observedEvents[0]!.message.usage;
    expect(result.outcome.measured!.rawUsage).not.toBe(observed);
    (observed.cache_creation as Record<string, unknown>).ephemeral_1h_input_tokens = 999;
    expect(result.outcome.measured!.rawUsage).toEqual({
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 0 },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    await result.settled;
  });
  it("clones raw usage only within the 4KiB UTF-8 boundary", async () => {
    const overhead = Buffer.byteLength(JSON.stringify({ extra: "" }));
    for (const extraBytes of [MEASURE_RAW_USAGE_MAX_BYTES - overhead, MEASURE_RAW_USAGE_MAX_BYTES - overhead + 1]) {
      const value = { extra: "x".repeat(extraBytes) };
      const h = harness(
        {},
        vi.fn(async () => new Response(eventText(value))),
      );
      const result = await sendPipelinePing(h.input);
      expect(result.outcome.kind).toBe("usage");
      if (extraBytes + overhead <= MEASURE_RAW_USAGE_MAX_BYTES)
        expect(result.outcome.measured!.rawUsage).toEqual(value);
      else expect(result.outcome.measured).not.toHaveProperty("rawUsage");
      await result.settled;
    }
  });
  it("a stalled fetch returns by deadline but settled still waits for fetch, cancel and pi", async () => {
    const response = deferred<Response>();
    const cancelDone = deferred<void>();
    const piDone = deferred<void>();
    const cancel = vi.fn(() => cancelDone.promise);
    const h = harness(
      { afterResult: () => piDone.promise },
      vi.fn(() => response.promise),
    );
    const pending = sendPipelinePing(h.input);
    await flush();
    h.clock.advance(30000);
    const result = await pending;
    const settled = vi.fn();
    void result.settled.then(settled);
    expect(result.outcome).toMatchObject({ kind: "network", measured: { sentAt: 1000 }, diag: { deadlineHit: true } });
    response.resolve(new Response(new ReadableStream({ cancel })));
    await flush();
    expect(settled).not.toHaveBeenCalled();
    expect(result.outcome.measured).not.toHaveProperty("headersAt");
    cancelDone.resolve();
    await flush();
    expect(settled).not.toHaveBeenCalled();
    piDone.resolve();
    await result.settled;
    expect(settled).toHaveBeenCalledTimes(1);
    expect(h.clock.pendingTimers).toBe(0);
  });
  it("measurement also honours abort/deadline before auth, with an annex on every outcome", async () => {
    const h = harness();
    const abort = new AbortController();
    abort.abort();
    const result = await sendPipelinePing({ ...h.input, signal: abort.signal });
    expect(result.outcome).toMatchObject({ kind: "not-sent", reason: "aborted", measured: {} });
    expect(h.streamSimple).not.toHaveBeenCalled();
    await result.settled;
    const expired = await sendPipelinePing({ ...h.input, deadlineAt: 1000 });
    expect(expired.outcome).toMatchObject({ kind: "not-sent", reason: "deadline", measured: {} });
    await expired.settled;
  });
  it.each(["anthropic-messages", "openai-responses", "openai-completions"] as const)(
    "uses the profile-specific endpoint suffix (%s), without widening keepalive",
    async (profile) => {
      const suffix =
        profile === "anthropic-messages"
          ? "/v1/messages"
          : profile === "openai-responses"
            ? "/responses"
            : "/chat/completions";
      for (const validSuffix of [false, true]) {
        const h = harness(
          { url: `https://relay.invalid/base${validSuffix ? suffix : "/wrong-endpoint"}` },
          vi.fn(async () => new Response("rejected", { status: 503 })),
        );
        h.measurement.profile = profile;
        h.measurement.routeKey = (value) =>
          measureRouteKey({
            api: profile,
            url: value,
            wireModel: model.id,
            effectiveTier: profile === "anthropic-messages" ? "ephemeral" : "auto",
          });
        const result = await sendPipelinePing({ ...h.input, model: { ...model, api: profile } });
        if (validSuffix) {
          expect(result.outcome).toMatchObject({ kind: "http", status: 503 });
          expect(h.baseFetch).toHaveBeenCalledTimes(1);
        } else {
          expect(result.outcome).toMatchObject({ kind: "not-sent", reason: "capability" });
          expect(h.baseFetch).not.toHaveBeenCalled();
        }
        await result.settled;
      }
    },
  );
  it("keeps the bounded 64KiB scanner and annexes on malformed and accepted-then-lost outcomes", async () => {
    const cap = harness(
      {},
      vi.fn(async () => new Response("x".repeat(100000))),
    );
    const capped = await sendPipelinePing(cap.input);
    expect(capped.outcome).toMatchObject({
      kind: "malformed",
      diag: { bodyBytes: 65536 },
      measured: { sentAt: 1000, headersAt: 1000 },
    });
    await capped.settled;
    const empty = harness(
      {},
      vi.fn(async () => new Response("")),
    );
    const lost = await sendPipelinePing(empty.input);
    expect(lost.outcome).toMatchObject({ kind: "accepted-then-lost", measured: { sentAt: 1000, headersAt: 1000 } });
    await lost.settled;
  });
  it("uses unref'd production timers in measurement mode", async () => {
    const gate = deferred<void>();
    const h = harness({ beforePayload: () => gate.promise });
    const abort = new AbortController();
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const pending = sendPipelinePing({
        ...h.input,
        clock: systemClock,
        deadlineAt: systemClock.now() + 30000,
        signal: abort.signal,
      });
      expect(timerSpy).toHaveBeenCalledTimes(1);
      expect((timerSpy.mock.results[0]!.value as NodeJS.Timeout).hasRef()).toBe(false);
      abort.abort();
      const result = await pending;
      gate.resolve();
      await result.settled;
      expect(h.baseFetch).not.toHaveBeenCalled();
    } finally {
      abort.abort();
      gate.resolve();
      timerSpy.mockRestore();
    }
  });
});
