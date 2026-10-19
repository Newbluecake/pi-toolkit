/**
 * Late-usage transport (plan.md 2026-10-20): `sendPipelinePing({ lateUsage: true })` keeps reading past a
 * non-proving `message_start` until `message_delta.usage` / `message_stop`, under a larger BOUNDED scan cap,
 * one deadline, one POST. Without `lateUsage` the legacy cancel-at-`message_start` behaviour is unchanged.
 */
import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { LATE_USAGE_SCAN_LIMIT_BYTES } from "../../src/cache-ttl/late-usage.js";
import { classifyUsage, PING_SCAN_LIMIT_BYTES } from "../../src/cache-ttl/ping-client.js";
import { sendPipelinePing } from "../../src/cache-ttl/pipeline-ping.js";
import type { PipelinePingInput, PipelinePingModel } from "../../src/cache-ttl/pipeline-ping-types.js";
import { fakePiStreamSimple } from "./fake-pipeline.js";

const encoder = new TextEncoder();
const model = {
  id: "k3",
  name: "k3",
  api: "anthropic-messages",
  provider: "kimi-coding",
  baseUrl: "https://api.kimi.com/coding",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
  contextWindow: 200_000,
  maxTokens: 4096,
} as unknown as PipelinePingModel;
const body = Object.freeze({ model: "k3", messages: [], max_tokens: 4, stream: true });

const frame = (event: Record<string, unknown>) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
const START_00 = frame({
  type: "message_start",
  message: {
    usage: { input_tokens: 9300, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
});
const START_HIT = frame({
  type: "message_start",
  message: {
    usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 9386, cache_creation_input_tokens: 0 },
  },
});
const BLOCK = frame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
const DELTA_HIT = frame({
  type: "message_delta",
  delta: { stop_reason: "max_tokens" },
  usage: { input_tokens: 0, output_tokens: 4, cache_read_input_tokens: 9386, cache_creation_input_tokens: 0 },
});
const DELTA_NO_USAGE = frame({ type: "message_delta", delta: { stop_reason: "max_tokens" } });
const STOP = frame({ type: "message_stop" });

/** A response whose body is fed by the test (chunks enqueued on demand; never closes unless asked). */
function liveResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel,
    }),
  );
  return {
    response,
    cancel,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

function setup(responseFor: () => Response, overrides: Partial<PipelinePingInput> = {}) {
  const clock = new FakeClock(1000);
  const fake = fakePiStreamSimple();
  const fetchImpl = vi.fn(async () => responseFor());
  const input: PipelinePingInput = {
    model,
    registry: { streamSimple: fake.streamSimple } as unknown as PipelinePingInput["registry"],
    sessionId: "s",
    body,
    clock,
    deadlineAt: 21_000,
    guard: () => true,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...overrides,
  };
  return { clock, fake, fetchImpl, input };
}
async function flush(times = 60): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}
const sleepTick = () => new Promise<void>((r) => setTimeout(r, 5));

describe("sendPipelinePing — lateUsage", () => {
  it("start 0/0 then message_delta read>0 ⇒ usage from message_delta (merged), one POST, body cancelled", async () => {
    const live = liveResponse();
    live.push(START_00 + BLOCK + DELTA_HIT + STOP);
    const t = setup(() => live.response, { lateUsage: true });
    const result = await sendPipelinePing(t.input);
    expect(result.outcome).toMatchObject({
      kind: "usage",
      usageSource: "message_delta",
      usage: { inputTokens: 0, outputTokens: 4, cacheRead: 9386, cacheWrite: 0 },
      diag: { baseFetchCalls: 1, onPayloadCalls: 1, sawMessageStart: true, deadlineHit: false },
    });
    expect(classifyUsage((result.outcome as { usage: never }).usage)).toEqual({
      kind: "proven-hit",
      cacheReadTokens: 9386,
      inputTokens: 0,
    });
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    // the wire body is the supplied body, verbatim
    expect(t.fake.wire[0]!.body).toBe(body);
    await result.settled;
    expect(live.cancel).toHaveBeenCalledTimes(1);
    expect(t.clock.pendingTimers).toBe(0);
  });

  it("a message_start that already proves the hit ends immediately from message_start (no further read needed)", async () => {
    const live = liveResponse();
    live.push(START_HIT); // nothing after it: the stream stalls
    const t = setup(() => live.response, { lateUsage: true });
    const result = await sendPipelinePing(t.input);
    expect(result.outcome).toMatchObject({
      kind: "usage",
      usageSource: "message_start",
      usage: { cacheRead: 9386 },
      diag: { deadlineHit: false },
    });
    await result.settled;
    expect(live.cancel).toHaveBeenCalledTimes(1);
  });

  it("delta without usage then message_stop ⇒ start numbers, source message_start, classified no-usage", async () => {
    const live = liveResponse();
    live.push(START_00 + BLOCK + DELTA_NO_USAGE + STOP);
    const t = setup(() => live.response, { lateUsage: true });
    const result = await sendPipelinePing(t.input);
    expect(result.outcome).toMatchObject({ kind: "usage", usageSource: "message_start" });
    expect(classifyUsage((result.outcome as { usage: never }).usage)).toEqual({ kind: "no-usage" });
    await result.settled;
  });

  it("keeps reading past 64 KiB of thinking deltas (bounded by the larger late cap)", async () => {
    const filler = frame({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "x".repeat(100_000) },
    });
    expect(filler.length).toBeGreaterThan(PING_SCAN_LIMIT_BYTES);
    const live = liveResponse();
    live.push(START_00 + BLOCK + filler + DELTA_HIT);
    const t = setup(() => live.response, { lateUsage: true });
    const result = await sendPipelinePing(t.input);
    expect(result.outcome).toMatchObject({ kind: "usage", usageSource: "message_delta", usage: { cacheRead: 9386 } });
    expect((result.outcome as { diag: { bodyBytes: number } }).diag.bodyBytes).toBeGreaterThan(PING_SCAN_LIMIT_BYTES);
    await result.settled;
  });

  it("caps a newline-less flood at the late scan limit ⇒ malformed (bounded)", async () => {
    const live = liveResponse();
    live.push(START_00);
    live.push("y".repeat(1024 * 1024));
    const t = setup(() => live.response, { lateUsage: true });
    const result = await sendPipelinePing(t.input);
    expect(result.outcome).toMatchObject({ kind: "malformed", diag: { bodyBytes: LATE_USAGE_SCAN_LIMIT_BYTES } });
    await result.settled;
    expect(live.cancel).toHaveBeenCalled();
  });

  it("the single 20 s deadline still bounds the longer read: stall after a 0/0 start ⇒ accepted-then-lost", async () => {
    const live = liveResponse();
    live.push(START_00 + BLOCK); // never completes
    const t = setup(() => live.response, { lateUsage: true });
    const pending = sendPipelinePing(t.input);
    await sleepTick();
    await flush();
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    expect(t.clock.pendingTimers).toBe(1);
    t.clock.advance(20_000);
    const result = await pending;
    expect(result.outcome).toMatchObject({
      kind: "accepted-then-lost",
      diag: { deadlineHit: true, durationMs: 20_000, httpStatus: 200, sawMessageStart: true },
    });
    await result.settled;
    expect(t.clock.pendingTimers).toBe(0);
  });

  it("an HTTP error is unchanged by late mode", async () => {
    const t = setup(() => new Response("nope", { status: 429 }), { lateUsage: true });
    const result = await sendPipelinePing(t.input);
    expect(result.outcome).toMatchObject({ kind: "http", status: 429 });
    await result.settled;
  });
});

describe("sendPipelinePing — non-late behaviour is byte-identical", () => {
  it("without lateUsage the SAME stream resolves at message_start (0/0, no usageSource key), delta never read", async () => {
    const live = liveResponse();
    live.push(START_00 + BLOCK + DELTA_HIT + STOP);
    const t = setup(() => live.response);
    const result = await sendPipelinePing(t.input);
    expect(result.outcome).toEqual({
      kind: "usage",
      usage: { inputTokens: 9300, outputTokens: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: undefined },
      diag: expect.objectContaining({ sawMessageStart: true, httpStatus: 200 }),
    });
    expect("usageSource" in result.outcome).toBe(false);
    await result.settled;
  });
  it("without lateUsage the scan cap stays 64 KiB", async () => {
    const live = liveResponse();
    live.push("z".repeat(1024 * 1024));
    const t = setup(() => live.response);
    const result = await sendPipelinePing(t.input);
    expect(result.outcome).toMatchObject({ kind: "malformed", diag: { bodyBytes: PING_SCAN_LIMIT_BYTES } });
    await result.settled;
  });
  it("lateUsage:false behaves like absent", async () => {
    const live = liveResponse();
    live.push(START_00 + DELTA_HIT);
    const t = setup(() => live.response, { lateUsage: false });
    const result = await sendPipelinePing(t.input);
    expect("usageSource" in result.outcome).toBe(false);
    expect(result.outcome).toMatchObject({ kind: "usage", usage: { cacheRead: 0 } });
    await result.settled;
  });
});
