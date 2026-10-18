/** Payload replay through pi's authenticated provider pipeline (capture-pairing-plan.md r7 §3.2–3.3). */
import type { TimerHandle } from "../core/clock.js";
import {
  HTTP_ERROR_BODY_CAP_BYTES,
  PING_SCAN_LIMIT_BYTES,
  isMessageStartEvent,
  networkErrorDescriptor,
  rawUsageFrom,
} from "./ping-client.js";
import type {
  PipelineDiag,
  PipelineNotSentReason,
  PipelineOutcome,
  PipelinePingResult,
  SendPipelinePing,
} from "./pipeline-ping-types.js";

type Outcome = PipelineOutcome extends infer T ? (T extends PipelineOutcome ? Omit<T, "diag"> : never) : never;

export const sendPipelinePing: SendPipelinePing = async (input) => {
  const { clock } = input;
  const startedAt = clock.now();
  const controller = new AbortController();
  const diag: PipelineDiag = {
    baseFetchCalls: 0,
    onPayloadCalls: 0,
    sawMessageStart: false,
    explicitSuccess: false,
    piStopReason: undefined,
    httpStatus: undefined,
    bodyBytes: 0,
    wireHeaderNames: [],
    deadlineHit: false,
    durationMs: 0,
  };
  let resolveResult!: (result: PipelinePingResult) => void;
  const result = new Promise<PipelinePingResult>((resolve) => (resolveResult = resolve));
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => (resolveSettled = resolve));
  let logicalDone = false;
  let setupDone = false;
  let physicalPending = 0;
  let deadlineTimer: TimerHandle | undefined;
  let notSentReason: PipelineNotSentReason | undefined;
  let upstream: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let upstreamClosed = false;
  let cancelStarted = false;

  // A late fetch can introduce a body cancel AFTER the logical outcome. Its cleanup is registered
  // before the fetch is released from this ledger, so `settled` cannot resolve in the intervening gap.
  function maybeSettled(): void {
    if (setupDone && logicalDone && physicalPending === 0) resolveSettled();
  }
  function track<T>(promise: Promise<T>): Promise<T> {
    physicalPending += 1;
    const done = () => {
      physicalPending -= 1;
      maybeSettled();
    };
    void promise.then(done, done);
    return promise;
  }
  function cancelBody(): void {
    if (!upstream || upstreamClosed || cancelStarted) return;
    cancelStarted = true;
    try {
      // Never await cancellation: some transports never finish it. Only the physical ledger waits.
      track(Promise.resolve(upstream.cancel()));
    } catch {
      // A synchronous cancellation failure is physically settled too.
    }
  }
  function fallback(error?: unknown): Outcome {
    if (diag.baseFetchCalls === 0) {
      return {
        kind: "not-sent",
        reason: notSentReason ?? (diag.onPayloadCalls === 0 ? "auth" : "provider-error"),
      };
    }
    if (diag.httpStatus !== undefined) {
      return diag.httpStatus < 200 || diag.httpStatus >= 300
        ? { kind: "http", status: diag.httpStatus }
        : { kind: "accepted-then-lost" };
    }
    return { kind: "network", error: networkErrorDescriptor(error) };
  }
  function finish(outcome: Outcome): void {
    if (logicalDone) return;
    logicalDone = true;
    diag.durationMs = Math.max(0, clock.now() - startedAt);
    if (deadlineTimer) clock.clearTimer(deadlineTimer);
    input.signal?.removeEventListener("abort", onAbort);
    controller.abort();
    cancelBody();
    // Diagnostics are a logical-time snapshot, never mutated by late physical completion.
    resolveResult({ outcome: { ...outcome, diag: { ...diag } } as PipelineOutcome, settled });
    maybeSettled();
  }
  function onAbort(): void {
    notSentReason = "aborted";
    finish(fallback(new DOMException("", "AbortError")));
  }
  function onDeadline(): void {
    diag.deadlineHit = true;
    notSentReason = "deadline";
    finish(fallback(new Error("keepalive ping timeout")));
  }
  function guard(): void {
    if (!logicalDone) {
      if (clock.now() >= input.deadlineAt) onDeadline();
      else if (input.signal?.aborted) onAbort();
      else {
        let live = false;
        try {
          live = input.guard();
        } catch {
          // A broken liveness port cannot authorize a send.
        }
        if (!live) {
          notSentReason = "guard";
          finish(fallback());
        }
      }
    }
    if (logicalDone) throw new Error("keepalive transport stopped");
  }
  async function raceAbort<T>(promise: Promise<T>, extra?: AbortSignal | null): Promise<T> {
    if (!logicalDone && clock.now() >= input.deadlineAt) onDeadline();
    const signals = extra && extra !== controller.signal ? [controller.signal, extra] : [controller.signal];
    let rejectAbort!: (error: unknown) => void;
    const aborted = new Promise<never>((_, reject) => (rejectAbort = reject));
    const abort = () => rejectAbort(new DOMException("", "AbortError"));
    for (const signal of signals) {
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }
    try {
      return await Promise.race([promise, aborted]);
    } finally {
      for (const signal of signals) signal.removeEventListener("abort", abort);
    }
  }
  function boundResponse(response: Response): Response {
    diag.httpStatus = response.status;
    if (!response.body) {
      if (response.ok) finish({ kind: "malformed" });
      return response;
    }
    upstream = response.body.getReader();
    const reader = upstream;
    const limit = response.ok ? PING_SCAN_LIMIT_BYTES : HTTP_ERROR_BODY_CAP_BYTES;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(sink) {
          try {
            if (diag.bodyBytes >= limit) {
              if (response.ok) finish({ kind: "malformed" });
              cancelBody();
              sink.close();
              return;
            }
            const step = await raceAbort(track(reader.read()));
            if (step.done) {
              upstreamClosed = true;
              sink.close();
              return;
            }
            const chunk = step.value.subarray(0, limit - diag.bodyBytes);
            diag.bodyBytes += chunk.byteLength;
            sink.enqueue(chunk);
          } catch (error) {
            cancelBody();
            sink.error(error);
          }
        },
        cancel() {
          cancelBody();
        },
      },
      // No eager read-ahead: pi must get a chance to observe message_start at the byte limit
      // before another pull declares the stream malformed.
      { highWaterMark: 0 },
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  const wrappedFetch: typeof fetch = async (request, init) => {
    guard();
    if (diag.baseFetchCalls !== 0) throw new Error("keepalive second fetch blocked");
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
    const method = init?.method ?? (request instanceof Request ? request.method : "GET");
    // The Anthropic SDK supplies the serialized JSON in init.body. Refuse unfamiliar shapes
    // rather than reading an arbitrary Request body (which could itself hang before admission).
    let wireBody: unknown;
    try {
      wireBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    } catch {
      // An invalid provider request is a capability failure, not a network send.
    }
    if (
      diag.onPayloadCalls !== 1 ||
      method.toUpperCase() !== "POST" ||
      !url.pathname.endsWith("/v1/messages") ||
      !isRecord(wireBody) ||
      typeof wireBody.model !== "string" ||
      wireBody.model !== input.body.model
    ) {
      notSentReason = "capability";
      throw new Error("keepalive provider request mismatch");
    }
    const headers = new Headers(init?.headers ?? (request instanceof Request ? request.headers : undefined));
    diag.wireHeaderNames = [...headers.keys()].map((name) => name.toLowerCase()).sort();
    const fetchSignal = init?.signal ?? (request instanceof Request ? request.signal : undefined);
    if (fetchSignal?.aborted) {
      notSentReason = "aborted";
      throw new DOMException("", "AbortError");
    }
    guard(); // immediately before the ONLY base-fetch invocation
    let baseFetch: Promise<Response>;
    try {
      diag.baseFetchCalls += 1;
      baseFetch = Promise.resolve((input.fetchImpl ?? globalThis.fetch)(request, init));
    } catch (error) {
      finish(fallback(error));
      throw error;
    }
    const physicalFetch = track(
      baseFetch.then((response) => {
        if (logicalDone) {
          upstream = response.body?.getReader();
          cancelBody();
        }
        return response;
      }),
    );
    try {
      const response = await raceAbort(physicalFetch, fetchSignal);
      if (!logicalDone && clock.now() >= input.deadlineAt) onDeadline();
      if (logicalDone) {
        upstream = response.body?.getReader();
        cancelBody();
        throw new Error("keepalive response after stop");
      }
      return boundResponse(response);
    } catch (error) {
      if (!logicalDone) finish(fallback(error));
      throw error;
    }
  };

  try {
    const remaining = input.deadlineAt - clock.now();
    if (!Number.isFinite(remaining) || remaining <= 0) onDeadline();
    else {
      deadlineTimer = clock.setTimer(remaining, onDeadline); // systemClock's timers are unref'd
      input.signal?.addEventListener("abort", onAbort, { once: true });
      guard();
      if (
        input.model.provider === "github-copilot" ||
        input.model.api !== "anthropic-messages" ||
        typeof input.registry.streamSimple !== "function"
      ) {
        finish({ kind: "not-sent", reason: "capability" });
      } else {
        const stream = input.registry.streamSimple(
          input.model,
          { messages: [{ role: "user", content: "keepalive", timestamp: clock.now() }] },
          {
            maxRetries: 0,
            sessionId: input.sessionId,
            signal: controller.signal,
            timeoutMs: input.deadlineAt - clock.now(),
            fetch: wrappedFetch,
            transformHeaders: (headers) => {
              guard();
              return headers;
            },
            onPayload: () => {
              diag.onPayloadCalls += 1;
              guard();
              if (diag.onPayloadCalls > 1) throw new Error("keepalive second payload blocked");
              return input.body;
            },
            onProviderStreamEvent: (event) => {
              if (!logicalDone && clock.now() >= input.deadlineAt) onDeadline();
              if (logicalDone || diag.baseFetchCalls === 0 || !isMessageStartEvent(event)) return;
              diag.sawMessageStart = true;
              finish({ kind: "usage", usage: rawUsageFrom(event) });
            },
          },
        );
        const piResult = track(Promise.resolve(stream.result()));
        void piResult.then(
          (message) => {
            if (logicalDone) return;
            diag.piStopReason = message.stopReason;
            diag.explicitSuccess =
              !controller.signal.aborted && ["stop", "length", "toolUse"].includes(message.stopReason);
            if (diag.explicitSuccess && diag.baseFetchCalls === 0) notSentReason = "capability";
            finish(fallback());
          },
          (error: unknown) => finish(fallback(error)),
        );
      }
    }
  } catch (error) {
    finish(fallback(error));
  } finally {
    setupDone = true;
    maybeSettled();
  }
  return result;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
