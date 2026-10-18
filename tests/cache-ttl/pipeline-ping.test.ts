import { describe, expect, it, vi } from "vitest";
import { FakeClock, systemClock } from "../../src/core/clock.js";
import { sendPipelinePing } from "../../src/cache-ttl/pipeline-ping.js";
import type {
  PipelinePingInput,
  PipelinePingModel,
  PipelinePingRegistry,
} from "../../src/cache-ttl/pipeline-ping-types.js";

type Options = NonNullable<Parameters<PipelinePingRegistry["streamSimple"]>[2]>;
const model: PipelinePingModel = {
  id: "claude-test",
  name: "Claude test",
  api: "anthropic-messages",
  provider: "test-anthropic",
  baseUrl: "https://relay.invalid/anthropic",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
  contextWindow: 200_000,
  maxTokens: 4096,
};
const body = Object.freeze({ model: model.id, messages: [], max_tokens: 1, stream: true });
const usage = {
  input_tokens: 12,
  output_tokens: 1,
  cache_read_input_tokens: 1234,
  cache_creation_input_tokens: 20,
  cache_creation: { ephemeral_1h_input_tokens: 15 },
};
const encoder = new TextEncoder();
function messageStart(value: unknown = usage): string {
  return `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: value } })}\n\n`;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
interface FakeOptions {
  beforeHeaders?: () => Promise<void> | void;
  afterHeaders?: () => void;
  afterPayload?: () => void;
  strictFallback?: boolean;
  secondFetch?: boolean;
  skipPayload?: boolean;
  skipFetch?: boolean;
  skipRawEvents?: boolean;
  wire?: { method?: string; url?: string; body?: string };
  stopReason?: string;
  finally?: () => Promise<void>;
}
/**
 * Minimal pi-shaped fake: auth → transformHeaders → onPayload → fetch → raw stream observer → result.
 * The scanner below is just the provider side of the fake; byte/deadline/cancel enforcement MUST come
 * from the production fetch wrapper. Real SDK/order facts are pinned separately by WP0a conformance.
 */
function harness(fake: FakeOptions = {}, fetchImpl: typeof fetch = vi.fn(async () => new Response(messageStart()))) {
  const clock = new FakeClock(1000);
  const payloads: unknown[] = [];
  let options!: Options;
  const streamSimple = vi.fn<PipelinePingRegistry["streamSimple"]>((selected, _context, opts) => {
    options = opts!;
    const run = async () => {
      try {
        await fake.beforeHeaders?.();
        const headers = { "X-API-Key": "secret-never-in-diag", "Content-Type": "application/json" };
        const transformed = await options.transformHeaders?.(headers);
        expect(transformed).toBe(headers);
        fake.afterHeaders?.();
        const payload = fake.skipPayload ? body : await options.onPayload?.({ model: "stub" }, selected);
        payloads.push(payload);
        fake.afterPayload?.();
        if (fake.skipFetch) return { stopReason: fake.stopReason ?? "stop" };
        const post = () =>
          options.fetch!(fake.wire?.url ?? `${selected.baseUrl}/v1/messages?beta=true`, {
            method: fake.wire?.method ?? "POST",
            body: fake.wire?.body ?? JSON.stringify(payload),
            headers,
            signal: options.signal!,
          });
        const response = await post();
        if (fake.secondFetch) await post();
        if (!response.ok) {
          await response.text();
          if (fake.strictFallback) {
            await options.onPayload?.({ model: "strict-fallback" }, selected);
            await post();
          }
          return { stopReason: "error" };
        }
        const reader = response.body?.getReader();
        if (!reader) return { stopReason: "error" };
        const decoder = new TextDecoder();
        let text = "";
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            text += decoder.decode(chunk.value, { stream: true });
            let end: number;
            while ((end = text.indexOf("\n")) >= 0) {
              const line = text.slice(0, end);
              text = text.slice(end + 1);
              if (line.startsWith("data: ") && !fake.skipRawEvents)
                await options.onProviderStreamEvent?.(JSON.parse(line.slice(6)), selected);
            }
            if (options.signal?.aborted) break;
          }
        } finally {
          // Real pi releases its reader lock instead of awaiting upstream cancellation.
          reader.releaseLock();
        }
        return { stopReason: fake.stopReason ?? "stop" };
      } catch {
        return { stopReason: options.signal?.aborted ? "aborted" : "error" };
      } finally {
        await fake.finally?.();
      }
    };
    const pending = run();
    return { result: () => pending } as ReturnType<PipelinePingRegistry["streamSimple"]>;
  });
  const input: PipelinePingInput = {
    model,
    registry: { streamSimple },
    sessionId: "captured-session",
    body,
    clock,
    deadlineAt: 21_000,
    guard: () => true,
    fetchImpl,
  };
  return { input, clock, fetchImpl, streamSimple, payloads, options: () => options };
}
function watch(promise: Promise<void>) {
  const done = vi.fn();
  void promise.then(done);
  return done;
}

describe("sendPipelinePing — bounded provider-pipeline replay", () => {
  it("passes the complete replay table, keeps the captured body, records raw usage and aborts early", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(sink) {
              sink.enqueue(encoder.encode(messageStart()));
            },
            cancel,
          }),
        ),
    );
    const h = harness({}, fetchImpl);
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({
      kind: "usage",
      usage: { inputTokens: 12, outputTokens: 1, cacheRead: 1234, cacheWrite: 20, cacheWrite1h: 15 },
      diag: {
        baseFetchCalls: 1,
        onPayloadCalls: 1,
        sawMessageStart: true,
        explicitSuccess: false,
        httpStatus: 200,
        deadlineHit: false,
        durationMs: 0,
        wireHeaderNames: ["content-type", "x-api-key"],
      },
    });
    expect(h.streamSimple).toHaveBeenCalledWith(
      model,
      { messages: [{ role: "user", content: "keepalive", timestamp: 1000 }] },
      expect.any(Object),
    );
    const opts = h.options();
    expect(Object.keys(opts).sort()).toEqual([
      "fetch",
      "maxRetries",
      "onPayload",
      "onProviderStreamEvent",
      "sessionId",
      "signal",
      "timeoutMs",
      "transformHeaders",
    ]);
    expect(opts).toMatchObject({ maxRetries: 0, sessionId: "captured-session", timeoutMs: 20_000 });
    expect(opts.signal?.aborted).toBe(true);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)).toEqual(body);
    expect(body.max_tokens).toBe(1);
    expect(JSON.stringify(result.outcome)).not.toContain("secret-never-in-diag");
    await result.settled;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("returns the exact supplied payload reference on the first onPayload (including thinking max_tokens)", async () => {
    const captured = { ...body, max_tokens: 8192, thinking: { type: "enabled", budget_tokens: 4096 } };
    const h = harness({
      beforeHeaders: async () => {
        h.clock.advance(123);
      },
    });
    const run = sendPipelinePing({ ...h.input, body: captured });
    await flush();
    const result = await run;
    expect(result.outcome.kind).toBe("usage");
    expect(h.options().timeoutMs).toBe(20_000); // computed at streamSimple invocation, before auth
    expect(h.options().signal?.aborted).toBe(true);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(vi.mocked(h.fetchImpl).mock.calls[0]![1]!.body as string)).toEqual(captured);
    expect(h.payloads[0]).toBe(captured);
    await result.settled;
  });

  it.each([400, 401, 403, 408, 429, 500, 503, 529])("maps HTTP %i to http without a second POST", async (status) => {
    const h = harness(
      {},
      vi.fn(async () => new Response("rejected", { status })),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({ kind: "http", status, diag: { httpStatus: status, baseFetchCalls: 1 } });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    await result.settled;
  });

  it("blocks strict fallback at the second onPayload, preserving the first HTTP outcome", async () => {
    const h = harness(
      { strictFallback: true },
      vi.fn(async () => new Response("Too many strict tools (stub)", { status: 400 })),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({ kind: "http", status: 400, diag: { onPayloadCalls: 2, baseFetchCalls: 1 } });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    await result.settled;
  });

  it("also guards fetch itself when a broken provider attempts two fetches without another onPayload", async () => {
    const h = harness({ secondFetch: true });
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({
      kind: "accepted-then-lost",
      diag: { baseFetchCalls: 1, onPayloadCalls: 1 },
    });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    await result.settled;
  });

  it("maps a base-fetch rejection to a sanitized network failure", async () => {
    const h = harness(
      {},
      vi.fn(async () => {
        throw Object.assign(new TypeError("secret url https://password.invalid"), {
          cause: Object.assign(new Error("secret"), { code: "ECONNRESET" }),
        });
      }),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({ kind: "network", error: "ECONNRESET", diag: { baseFetchCalls: 1 } });
    expect(JSON.stringify(result.outcome)).not.toContain("password");
    await result.settled;
  });

  it("maps a synchronous base-fetch throw to network too", async () => {
    const h = harness(
      {},
      vi.fn(() => {
        throw new TypeError("secret");
      }),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({ kind: "network", error: "TypeError", diag: { baseFetchCalls: 1 } });
    await result.settled;
  });

  it("bounds a stalled read after 200 by the single deadline, as accepted-then-lost", async () => {
    const cancel = vi.fn();
    const h = harness(
      {},
      vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    );
    const pending = sendPipelinePing(h.input);
    await flush();
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.clock.pendingTimers).toBe(1);
    h.clock.advance(20_000);
    const result = await pending;
    expect(result.outcome).toMatchObject({
      kind: "accepted-then-lost",
      diag: { deadlineHit: true, durationMs: 20_000, httpStatus: 200 },
    });
    await result.settled;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("caps a newline-less flood at 64 KiB, even when one upstream chunk exceeds the cap", async () => {
    const cancel = vi.fn();
    const h = harness(
      {},
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(sink) {
                sink.enqueue(new Uint8Array(1024 * 1024).fill(120));
              },
              cancel,
            }),
          ),
      ),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({
      kind: "malformed",
      diag: { bodyBytes: 65536, baseFetchCalls: 1, sawMessageStart: false },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    await result.settled;
  });

  it("allows message_start inside the bounded prefix of an oversized chunk", async () => {
    const h = harness(
      {},
      vi.fn(async () => new Response(messageStart() + "x".repeat(100_000))),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({ kind: "usage", diag: { bodyBytes: 65536, sawMessageStart: true } });
    await result.settled;
  });

  it("caps error bodies at 2 KiB and never awaits cancellation to return the logical http outcome", async () => {
    const release = deferred<void>();
    const cancel = vi.fn(() => release.promise);
    const h = harness(
      {},
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(sink) {
                sink.enqueue(new Uint8Array(100_000));
              },
              cancel,
            }),
            { status: 503 },
          ),
      ),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({ kind: "http", status: 503, diag: { bodyBytes: 2048 } });
    const done = watch(result.settled);
    await flush();
    expect(done).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    release.resolve();
    await result.settled;
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("a never-settling cancel leaves settled pending, but usage resolves immediately", async () => {
    const release = deferred<void>();
    const cancel = vi.fn(() => release.promise);
    const h = harness(
      {},
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(sink) {
                sink.enqueue(encoder.encode(messageStart()));
              },
              cancel,
            }),
          ),
      ),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome.kind).toBe("usage");
    const done = watch(result.settled);
    await flush();
    h.clock.advance(50_000);
    expect(done).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    release.resolve();
    await result.settled;
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("a never-settling fetch returns network by D; late fetch/body cancellation gate physical settlement", async () => {
    const fetchRelease = deferred<Response>();
    const cancelRelease = deferred<void>();
    const cancel = vi.fn(() => cancelRelease.promise);
    const h = harness(
      {},
      vi.fn(() => fetchRelease.promise),
    );
    const pending = sendPipelinePing(h.input);
    await flush();
    h.clock.advance(20_000);
    const result = await pending;
    expect(result.outcome).toMatchObject({
      kind: "network",
      diag: { deadlineHit: true, baseFetchCalls: 1, httpStatus: undefined },
    });
    const done = watch(result.settled);
    await flush();
    expect(done).not.toHaveBeenCalled();
    fetchRelease.resolve(new Response(new ReadableStream({ cancel })));
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
    cancelRelease.resolve();
    await result.settled;
    expect(done).toHaveBeenCalledTimes(1);
    // The returned diagnostics never acquire the late response's status.
    expect(result.outcome.diag.httpStatus).toBeUndefined();
  });

  it("waits for pi's physical result even after fetch and cancellation are done", async () => {
    const release = deferred<void>();
    const h = harness({ finally: () => release.promise });
    const result = await sendPipelinePing(h.input);
    expect(result.outcome.kind).toBe("usage");
    const done = watch(result.settled);
    await flush();
    expect(done).not.toHaveBeenCalled();
    release.resolve();
    await result.settled;
    expect(done).toHaveBeenCalledTimes(1);
  });

  it.each(["headers", "payload", "fetch"] as const)("checks epoch/disposal at %s before sending", async (stage) => {
    let live = true;
    const h = harness({
      ...(stage === "headers"
        ? {
            beforeHeaders: () => {
              live = false;
            },
          }
        : {}),
      ...(stage === "payload"
        ? {
            afterHeaders: () => {
              live = false;
            },
          }
        : {}),
      ...(stage === "fetch"
        ? {
            afterPayload: () => {
              live = false;
            },
          }
        : {}),
    });
    const result = await sendPipelinePing({ ...h.input, guard: () => live });
    expect(result.outcome).toMatchObject({ kind: "not-sent", reason: "guard", diag: { baseFetchCalls: 0 } });
    expect(h.fetchImpl).not.toHaveBeenCalled();
    await result.settled;
  });

  it("checks the same deadline after auth and immediately before fetch, even before the timer callback runs", async () => {
    const h = harness({
      afterPayload: () => {
        now = 21_000;
      },
    });
    let now = 1000;
    const clock = { now: () => now, setTimer: vi.fn(() => ({ id: 1 })), clearTimer: vi.fn() };
    const result = await sendPipelinePing({ ...h.input, clock });
    expect(result.outcome).toMatchObject({
      kind: "not-sent",
      reason: "deadline",
      diag: { deadlineHit: true, baseFetchCalls: 0 },
    });
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(clock.setTimer).toHaveBeenCalledTimes(1);
    expect(clock.clearTimer).toHaveBeenCalledWith({ id: 1 });
    await result.settled;
  });

  it("bounds slow auth, and a late auth completion cannot send", async () => {
    const auth = deferred<void>();
    const h = harness({ beforeHeaders: () => auth.promise });
    const pending = sendPipelinePing(h.input);
    await flush();
    h.clock.advance(20_000);
    const result = await pending;
    expect(result.outcome).toMatchObject({
      kind: "not-sent",
      reason: "deadline",
      diag: { baseFetchCalls: 0, deadlineHit: true },
    });
    const done = watch(result.settled);
    await flush();
    expect(done).not.toHaveBeenCalled();
    auth.resolve();
    await result.settled;
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("maps prepareRequest/auth failures to not-sent auth", async () => {
    const h = harness({
      beforeHeaders: () => {
        throw new Error("bad secret credentials");
      },
    });
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({ kind: "not-sent", reason: "auth", diag: { baseFetchCalls: 0 } });
    await result.settled;
  });

  it("does not send when already aborted or when the deadline already elapsed", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const aborted = await sendPipelinePing({ ...h.input, signal: controller.signal });
    expect(aborted.outcome).toMatchObject({ kind: "not-sent", reason: "aborted" });
    await aborted.settled;
    const expired = await sendPipelinePing({ ...h.input, deadlineAt: h.clock.now() });
    expect(expired.outcome).toMatchObject({ kind: "not-sent", reason: "deadline", diag: { deadlineHit: true } });
    await expired.settled;
    expect(h.streamSimple).not.toHaveBeenCalled();
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("dispose mid-flight aborts the wrapper immediately and removes the parent listener", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const h = harness(
      {},
      vi.fn(async () => new Response(new ReadableStream())),
    );
    const pending = sendPipelinePing({ ...h.input, signal: controller.signal });
    await flush();
    controller.abort();
    const result = await pending;
    expect(result.outcome).toMatchObject({ kind: "accepted-then-lost", diag: { deadlineHit: false } });
    expect(h.options().signal?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(h.clock.pendingTimers).toBe(0);
    await result.settled;
  });

  it.each([
    { ...model, provider: "github-copilot" },
    { ...model, api: "pi-virtual" },
    { ...model, api: "openai-responses" },
  ])("refuses an unsupported provider/API before any stream or fetch ($provider / $api)", async (unsupported) => {
    const h = harness();
    const result = await sendPipelinePing({ ...h.input, model: unsupported });
    expect(result.outcome).toMatchObject({ kind: "not-sent", reason: "capability", diag: { baseFetchCalls: 0 } });
    expect(h.streamSimple).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    await result.settled;
  });

  it.each([
    { method: "GET" },
    { url: "https://relay.invalid/v1/completions" },
    { body: JSON.stringify({ model: "wrong-model" }) },
    { body: "not json" },
  ])("refuses a mismatched provider request as not-sent capability (%j)", async (wire) => {
    const h = harness({ wire });
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({ kind: "not-sent", reason: "capability", diag: { baseFetchCalls: 0 } });
    expect(h.fetchImpl).not.toHaveBeenCalled();
    await result.settled;
  });

  it("refuses a provider that reaches fetch without calling onPayload", async () => {
    const h = harness({ skipPayload: true });
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({
      kind: "not-sent",
      reason: "capability",
      diag: { onPayloadCalls: 0, baseFetchCalls: 0 },
    });
    expect(h.fetchImpl).not.toHaveBeenCalled();
    await result.settled;
  });

  it("records explicit pi success only when pi completes before our abort, never treating normalized usage as evidence", async () => {
    const h = harness({ skipFetch: true, skipPayload: true, stopReason: "length" });
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({
      kind: "not-sent",
      reason: "capability",
      diag: { explicitSuccess: true, piStopReason: "length", sawMessageStart: false, baseFetchCalls: 0 },
    });
    await result.settled;
    const noObserver = harness({ skipRawEvents: true });
    const other = await sendPipelinePing(noObserver.input);
    expect(other.outcome).toMatchObject({
      kind: "accepted-then-lost",
      diag: { explicitSuccess: true, sawMessageStart: false },
    });
    await other.settled;
  });

  it.each([undefined, null])(
    "message_start without a usage object is usage(undefined), not a fabricated hit (%s)",
    async (value) => {
      const event = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: value } })}\n\n`;
      const h = harness(
        {},
        vi.fn(async () => new Response(event)),
      );
      const result = await sendPipelinePing(h.input);
      expect(result.outcome).toMatchObject({ kind: "usage", usage: undefined, diag: { sawMessageStart: true } });
      await result.settled;
    },
  );

  it("normalizes non-finite raw Anthropic fields, preserving a missing 1h split", async () => {
    const h = harness(
      {},
      vi.fn(async () => new Response(messageStart({ input_tokens: "12", cache_read_input_tokens: 9 }))),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({
      kind: "usage",
      usage: { inputTokens: 0, outputTokens: 0, cacheRead: 9, cacheWrite: 0, cacheWrite1h: undefined },
    });
    await result.settled;
  });

  it("preserves the HTTP outcome when its error body stalls until D", async () => {
    const h = harness(
      {},
      vi.fn(async () => new Response(new ReadableStream(), { status: 429 })),
    );
    const pending = sendPipelinePing(h.input);
    await flush();
    h.clock.advance(20_000);
    const result = await pending;
    expect(result.outcome).toMatchObject({ kind: "http", status: 429, diag: { deadlineHit: true, bodyBytes: 0 } });
    await result.settled;
  });

  it("a stream read error after 200 is accepted-then-lost, never network", async () => {
    const h = harness(
      {},
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(sink) {
                sink.error(new Error("private upstream error"));
              },
            }),
          ),
      ),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({
      kind: "accepted-then-lost",
      diag: { httpStatus: 200, sawMessageStart: false },
    });
    await result.settled;
  });

  it("does not scan non-Anthropic event usage", async () => {
    const h = harness(
      {},
      vi.fn(async () => new Response(`data: ${JSON.stringify({ type: "response.created", usage })}\n\n`)),
    );
    const result = await sendPipelinePing(h.input);
    expect(result.outcome).toMatchObject({ kind: "accepted-then-lost", diag: { sawMessageStart: false } });
    await result.settled;
  });

  it("maps no body to malformed, and an empty successful stream to accepted-then-lost", async () => {
    const noBody = harness(
      {},
      vi.fn(async () => new Response(null)),
    );
    const missing = await sendPipelinePing(noBody.input);
    expect(missing.outcome.kind).toBe("malformed");
    await missing.settled;
    const empty = harness(
      {},
      vi.fn(async () => new Response("")),
    );
    const ended = await sendPipelinePing(empty.input);
    expect(ended.outcome.kind).toBe("accepted-then-lost");
    await ended.settled;
  });

  it("uses only the injected clock, whose production deadline timer is unref'd", async () => {
    const h = harness(
      {},
      vi.fn(async () => new Response(new ReadableStream())),
    );
    const rawTimer = vi.spyOn(globalThis, "setTimeout");
    const parent = new AbortController();
    try {
      const pending = sendPipelinePing({
        ...h.input,
        clock: systemClock,
        deadlineAt: systemClock.now() + 60_000,
        signal: parent.signal,
      });
      await flush();
      expect(rawTimer).toHaveBeenCalledTimes(1);
      const timer = rawTimer.mock.results[0]!.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
      parent.abort();
      const result = await pending;
      expect(result.outcome.kind).toBe("accepted-then-lost");
      await result.settled;
    } finally {
      parent.abort();
      rawTimer.mockRestore();
    }
  });
});
