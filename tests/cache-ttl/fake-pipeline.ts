/**
 * Test double for package A1's `sendPipelinePing` (capture-pairing-plan r7 §6). A2's service must be tested
 * without the real pi pipeline, so this fake sender implements the FROZEN contract of `pipeline-ping-types.ts`
 * (never rejects, resolves by `deadlineAt`, `settled` after all physical IO) on top of a scripted `fetch`:
 *
 * - `not-sent` when the service guard is already false, the signal is already aborted, or the deadline passed;
 * - otherwise the scripted fetch is the "base fetch" (exactly one call), and the REAL `postAndScanUsage` scans
 *   its stream, so usage classification / http / network / accepted-then-lost / malformed behave as on the wire.
 *
 * Options let a test script a not-sent reason, a stuck `settled`, or a custom outcome without any fetch at all.
 */
import { vi } from "vitest";
import { postAndScanUsage } from "../../src/cache-ttl/ping-client.js";
import type {
  PipelineDiag,
  PipelineNotSentReason,
  PipelineOutcome,
  PipelinePingInput,
  PipelinePingResult,
  SendPipelinePing,
} from "../../src/cache-ttl/pipeline-ping-types.js";
import {
  createCacheKeepaliveService as createRealService,
  type CacheKeepaliveDeps,
  type CacheKeepaliveService,
} from "../../src/service/cache-keepalive.js";

export function diagOf(overrides: Partial<PipelineDiag> = {}): PipelineDiag {
  return {
    baseFetchCalls: 1,
    onPayloadCalls: 1,
    sawMessageStart: false,
    explicitSuccess: false,
    piStopReason: undefined,
    httpStatus: undefined,
    bodyBytes: 0,
    wireHeaderNames: [],
    deadlineHit: false,
    durationMs: 0,
    ...overrides,
  } as PipelineDiag;
}

export interface FakeSenderOptions {
  /** Resolve `settled` only when the test calls the returned `releaseSettled()`. */
  holdSettled?: boolean;
  /** Skip the fetch entirely and return this outcome (kind `not-sent` gets a zero-fetch diag). */
  scripted?: (input: PipelinePingInput, call: number) => PipelineOutcome | undefined;
}

export interface FakeSender {
  send: SendPipelinePing;
  calls: PipelinePingInput[];
  /** Resolves every `settled` held by `holdSettled`. */
  releaseSettled(): void;
}

export function fakeSender(fetchImpl?: typeof fetch, options: FakeSenderOptions = {}): FakeSender {
  const calls: PipelinePingInput[] = [];
  const holds: Array<() => void> = [];
  const send: SendPipelinePing = async (input) => {
    calls.push(input);
    const call = calls.length;
    const settled: Promise<void> = options.holdSettled
      ? new Promise<void>((resolve) => holds.push(resolve))
      : Promise.resolve();
    const notSent = (reason: PipelineNotSentReason): PipelinePingResult => ({
      outcome: { kind: "not-sent", reason, diag: diagOf({ baseFetchCalls: 0, onPayloadCalls: 0 }) },
      settled,
    });
    const scripted = options.scripted?.(input, call);
    if (scripted !== undefined) return { outcome: scripted, settled };
    if (input.signal?.aborted) return notSent("aborted");
    if (input.clock.now() >= input.deadlineAt) return notSent("deadline");
    if (!input.guard()) return notSent("guard");
    const base = fetchImpl ?? input.fetchImpl;
    const scan = await postAndScanUsage(
      { url: "https://pipeline.invalid/v1/messages", headers: {}, body: input.body as Record<string, unknown> },
      { ...(base ? { fetchImpl: base } : {}), ...(input.signal ? { signal: input.signal } : {}) },
    );
    const diag = diagOf();
    const outcome: PipelineOutcome =
      scan.kind === "usage"
        ? { kind: "usage", usage: scan.usage, diag: { ...diag, sawMessageStart: true } }
        : { ...scan, diag };
    return { outcome, settled };
  };
  return { send, calls, releaseSettled: () => holds.splice(0).forEach((r) => r()) };
}

/**
 * Drop-in for `createCacheKeepaliveService` in suites that script a `fetchImpl`: derives the injected pipeline
 * sender from it (unless the test supplies its own `sendPipelinePing`) and guarantees the fake `ctx.modelRegistry`
 * carries a `streamSimple` facade so the A2 capability probe passes. A test that WANTS the probe to fail passes a
 * `ctx` with `modelRegistry: {}` AND `probeFacade: false`.
 */
export function createCacheKeepaliveService(
  deps: CacheKeepaliveDeps,
  options: { probeFacade?: boolean } = {},
): CacheKeepaliveService {
  const ctx = deps.ctx as unknown as { modelRegistry?: Record<string, unknown> };
  if (options.probeFacade !== false) {
    ctx.modelRegistry ??= {};
    ctx.modelRegistry.streamSimple ??= vi.fn();
  }
  const sendPipelinePing = deps.sendPipelinePing ?? fakeSender(deps.fetchImpl).send;
  return createRealService({ ...deps, sendPipelinePing });
}

/**
 * A faithful-enough fake of pi's `ModelRegistry.streamSimple` for the REAL A1 transport (integration suites that
 * go through `buildSessionStack`, where no sender can be injected): it drives exactly the documented option
 * callbacks in pi's order — `onPayload` (replacement), `transformHeaders`, the injected `fetch`, then one
 * `onProviderStreamEvent` per SSE `data:` event — and resolves `result()` with a `stopReason`. Behaviour knobs:
 *
 * - `ignoreFetchOption`: never calls `options.fetch` (an adapter that doesn't honour the option) and ends `stop`.
 * - `calls`: every `(model, context, options)` triple, plus the wire request the fetch saw.
 */
export interface FakePiStream {
  streamSimple: ReturnType<typeof vi.fn>;
  wire: Array<{ url: string; headers: Record<string, string>; body: unknown }>;
}

export function fakePiStreamSimple(options: { ignoreFetchOption?: boolean } = {}): FakePiStream {
  const wire: FakePiStream["wire"] = [];
  const streamSimple = vi.fn((model: any, _context: unknown, opts: any) => {
    const done = (async (): Promise<{ stopReason: string; errorMessage?: string }> => {
      try {
        let payload: unknown = { model: model.id, messages: [{ role: "user", content: "keepalive" }], stream: true };
        const replaced = await opts?.onPayload?.(payload, model);
        if (replaced !== undefined) payload = replaced;
        let headers: Record<string, string> = { "content-type": "application/json", "x-api-key": "fake-key" };
        const transformed = await opts?.transformHeaders?.(headers, model);
        if (transformed !== undefined) headers = transformed;
        if (options.ignoreFetchOption) return { stopReason: "stop" };
        const url = `${String(model.baseUrl).replace(/\/$/, "")}/v1/messages?beta=true`;
        const res = await opts.fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: opts.signal,
        });
        wire.push({ url, headers, body: payload });
        if (!res.ok) return { stopReason: "error", errorMessage: `http ${res.status}` };
        const reader = res.body?.getReader?.();
        let buffered = "";
        const decoder = new TextDecoder();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffered += decoder.decode(chunk.value, { stream: true });
          let at: number;
          while ((at = buffered.indexOf("\n\n")) >= 0) {
            const frame = buffered.slice(0, at);
            buffered = buffered.slice(at + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              await opts?.onProviderStreamEvent?.(JSON.parse(line.slice(5).trim()), model);
            }
          }
        }
        return { stopReason: "stop" };
      } catch (error) {
        return { stopReason: opts?.signal?.aborted ? "aborted" : "error", errorMessage: String(error) };
      }
    })();
    return { result: () => done };
  });
  return { streamSimple, wire };
}
