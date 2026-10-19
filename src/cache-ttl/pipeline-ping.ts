/** Payload replay through pi's authenticated provider pipeline (capture-pairing-plan.md r7 §3.2–3.3). */
import type { TimerHandle } from "../core/clock.js";
import {
  HTTP_ERROR_BODY_CAP_BYTES,
  PING_SCAN_LIMIT_BYTES,
  isMessageStartEvent,
  networkErrorDescriptor,
  rawUsageFrom,
  redactSecrets,
} from "./ping-client.js";
import { MEASURE_RAW_USAGE_MAX_BYTES, VALIDATOR_LIMITS } from "./measure-types.js";
import { measureEndpointSuffix } from "./measure-route.js";
import type {
  PipelineMeasured,
  PipelineWireProfile,
  PipelineDiag,
  PipelineNotSentReason,
  PipelineOutcome,
  PipelinePingResult,
  SendPipelinePing,
} from "./pipeline-ping-types.js";

type Outcome = PipelineOutcome extends infer T ? (T extends PipelineOutcome ? Omit<T, "diag"> : never) : never;

export const sendPipelinePing: SendPipelinePing = async (input) => {
  const { clock, measurement } = input;
  const measured: PipelineMeasured | undefined = measurement ? {} : undefined;
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
  let sawOpenAiUsageFrame = false;
  let authSecrets: string[] = []; // local-only, never included in diagnostics

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
    resolveResult({
      outcome: { ...outcome, diag: { ...diag }, ...(measured ? { measured: { ...measured } } : {}) } as PipelineOutcome,
      settled,
    });
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
      if (measurement && response.status >= 300 && response.status < 400) {
        measured!.redirected = true;
        finish({ kind: "http", status: response.status });
      } else if (response.ok) finish({ kind: "malformed" });
      return response;
    }
    upstream = response.body.getReader();
    if (measurement && response.status >= 300 && response.status < 400) {
      measured!.redirected = true;
      finish({ kind: "http", status: response.status });
      return response;
    }
    const reader = upstream;
    const limit = response.ok ? PING_SCAN_LIMIT_BYTES : HTTP_ERROR_BODY_CAP_BYTES;
    const errorChunks: Uint8Array[] = [];
    const captureError = () => {
      if (measurement && response.status === 400 && !logicalDone) {
        const excerpt = providerErrorExcerpt(Buffer.concat(errorChunks).toString("utf8"), authSecrets);
        if (excerpt) measured!.httpError = excerpt;
      }
    };
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(sink) {
          try {
            if (diag.bodyBytes >= limit) {
              captureError();
              if (response.ok) finish({ kind: "malformed" });
              cancelBody();
              sink.close();
              return;
            }
            const step = await raceAbort(track(reader.read()));
            if (step.done) {
              captureError();
              upstreamClosed = true;
              sink.close();
              return;
            }
            const chunk = step.value.subarray(0, limit - diag.bodyBytes);
            diag.bodyBytes += chunk.byteLength;
            if (measurement && response.status === 400) {
              errorChunks.push(chunk.slice());
              captureError();
            }
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
  async function readRequestBody(request: Request): Promise<unknown> {
    const reader = request.clone().body?.getReader();
    if (!reader) return undefined;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let closed = false;
    try {
      for (;;) {
        const step = await raceAbort(track(reader.read()));
        if (step.done) {
          closed = true;
          break;
        }
        bytes += step.value.byteLength;
        if (bytes > VALIDATOR_LIMITS.maxSerializedBytes) return undefined;
        chunks.push(step.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } finally {
      if (!closed) {
        try {
          track(Promise.resolve(reader.cancel()));
        } catch {
          /* physical cancellation already settled */
        }
      }
      reader.releaseLock();
    }
  }
  const wrappedFetch: typeof fetch = async (request, init) => {
    guard();
    if (diag.baseFetchCalls !== 0) throw new Error("keepalive second fetch blocked");
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
    const method = init?.method ?? (request instanceof Request ? request.method : "GET");
    // Keepalive only accepts the Anthropic SDK's serialized init.body. Measurement additionally
    // accepts Request bodies, read under the same deadline/physical ledger and a byte cap.
    let wireBody: unknown;
    try {
      wireBody =
        typeof init?.body === "string"
          ? JSON.parse(init.body)
          : measurement && request instanceof Request && init?.body === undefined
            ? await track(readRequestBody(request))
            : undefined;
    } catch {
      // An invalid provider request is a capability failure, not a network send.
    }
    if (
      diag.onPayloadCalls !== 1 ||
      method.toUpperCase() !== "POST" ||
      !url.pathname.endsWith(measurement ? measureEndpointSuffix(measurement.profile) : "/v1/messages") ||
      !isRecord(wireBody) ||
      typeof wireBody.model !== "string" ||
      wireBody.model !== (measurement ? measurement.expectWireModel : input.body.model)
    ) {
      notSentReason = "capability";
      if (measurement && isRecord(wireBody) && wireBody.model !== measurement.expectWireModel)
        measured!.routeMismatch = true;
      throw new Error("keepalive provider request mismatch");
    }
    if (measurement) {
      try {
        const route = measurement.routeKey(url.href);
        measured!.routeKey = route.key;
        measured!.routeLabel = route.label;
        if (measurement.expectRouteKey !== undefined && route.key !== measurement.expectRouteKey) {
          measured!.routeMismatch = true;
          throw new Error("measurement route mismatch");
        }
      } catch {
        notSentReason = "capability";
        throw new Error("measurement route unavailable");
      }
    }
    const headers = new Headers(init?.headers ?? (request instanceof Request ? request.headers : undefined));
    diag.wireHeaderNames = [...headers.keys()].map((name) => name.toLowerCase()).sort();
    if (measurement)
      authSecrets = [...headers].flatMap(([name, value]) =>
        /authorization|api[-_]?key|token|cookie|secret/i.test(name)
          ? [value, value.replace(/^(?:Bearer|Basic)\s+/i, "")]
          : [],
      );
    const fetchSignal = init?.signal ?? (request instanceof Request ? request.signal : undefined);
    if (fetchSignal?.aborted) {
      notSentReason = "aborted";
      throw new DOMException("", "AbortError");
    }
    guard(); // immediately before the ONLY base-fetch invocation
    let baseFetch: Promise<Response>;
    try {
      // Re-wrap Request inputs as well: their own redirect mode must not survive measurement.
      const baseRequest =
        measurement && request instanceof Request ? new Request(request, { ...init, redirect: "manual" }) : request;
      const baseInit = measurement ? { ...init, redirect: "manual" as const } : init;
      if (measured) measured.sentAt = clock.now();
      diag.baseFetchCalls += 1;
      baseFetch = Promise.resolve((input.fetchImpl ?? globalThis.fetch)(baseRequest, baseInit));
    } catch (error) {
      finish(fallback(error));
      throw error;
    }
    const physicalFetch = track(
      baseFetch.then((response) => {
        if (measured && !logicalDone) measured.headersAt = clock.now();
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
        input.model.api !== (measurement?.profile ?? "anthropic-messages") ||
        typeof input.registry.streamSimple !== "function"
      ) {
        finish({ kind: "not-sent", reason: "capability" });
      } else {
        const stream = input.registry.streamSimple(
          input.model,
          measurement?.build?.context ?? { messages: [{ role: "user", content: "keepalive", timestamp: clock.now() }] },
          {
            ...(measurement?.build
              ? {
                  maxTokens: measurement.build.maxTokens,
                  cacheRetention: measurement.build.cacheRetention,
                  ...(measurement.build.reasoning ? { reasoning: measurement.build.reasoning } : {}),
                }
              : {}),
            maxRetries: 0,
            sessionId: input.sessionId,
            signal: controller.signal,
            timeoutMs: input.deadlineAt - clock.now(),
            fetch: wrappedFetch,
            transformHeaders: (headers) => {
              guard();
              return headers;
            },
            onPayload: (params) => {
              diag.onPayloadCalls += 1;
              guard();
              if (diag.onPayloadCalls > 1) throw new Error("keepalive second payload blocked");
              if (measurement?.build) {
                notSentReason = "capability";
                if (!isRecord(params)) {
                  measured!.rejection = "extra-input";
                  throw new Error("measurement payload is not an object");
                }
                const rejection = measurement.build.validate(params);
                if (rejection !== undefined) {
                  measured!.rejection = rejection;
                  throw new Error("measurement payload rejected");
                }
                measured!.builtBody = structuredClone(params);
                notSentReason = undefined;
                return undefined;
              }
              return input.body;
            },
            onProviderStreamEvent: (event) => {
              if (!logicalDone && clock.now() >= input.deadlineAt) onDeadline();
              if (measurement && measurement.profile !== "anthropic-messages") {
                if (logicalDone || diag.baseFetchCalls === 0 || !isRecord(event)) return;
                const responses = measurement.profile === "openai-responses";
                const usage = responses
                  ? isRecord(event.response)
                    ? event.response.usage
                    : undefined
                  : completionUsageFrom(event);
                const terminal = responses
                  ? event.type === "response.completed" || event.type === "response.incomplete"
                  : usage !== undefined && usage !== null;
                if (!terminal) return;
                sawOpenAiUsageFrame = true;
                const raw = cloneRawUsage(usage, measurement.profile);
                if (raw !== undefined) measured!.rawUsage = raw;
                else delete measured!.rawUsage;
                // OpenAI usage arrives at completion, not the first event. Let pi consume the
                // terminal frame and finish the stream; never abort on created/delta/finish_reason.
                return;
              }
              if (logicalDone || diag.baseFetchCalls === 0 || !isMessageStartEvent(event)) return;
              diag.sawMessageStart = true;
              if (measured && isRecord(event.message)) {
                const raw = cloneRawUsage(event.message.usage, "anthropic-messages");
                if (raw !== undefined) measured.rawUsage = raw;
              }
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
            finish(sawOpenAiUsageFrame ? { kind: "usage", usage: undefined } : fallback());
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

function providerErrorExcerpt(body: string, secrets: readonly string[]): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) return undefined;
    const message =
      isRecord(parsed.error) && typeof parsed.error.message === "string"
        ? parsed.error.message
        : typeof parsed.message === "string"
          ? parsed.message
          : typeof parsed.detail === "string"
            ? parsed.detail
            : undefined;
    if (!message) return undefined;
    // Pick ONLY the provider's message, never other JSON fields/headers. Redact before
    // truncating so a credential straddling the 160-char cut cannot leak a partial token.
    const clean = redactSecrets(message, secrets)
      .replace(/https?:\/\/[^\s<>"']+/gi, "[URL]")
      .replace(/\b(?:sk-|sess-|gh[pousr]_)[a-z\d_-]+/gi, "[REDACTED]")
      .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, "[REDACTED]")
      .replace(
        /\b(?:authorization|x-api-key|api[_-]?key|key|token|secret|password)\s*["']?\s*[=:]\s*["']?[^\s,;"']+/gi,
        "[REDACTED]",
      )
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return Array.from(clean).slice(0, 160).join("") || undefined;
  } catch {
    return undefined;
  }
}

function completionUsageFrom(event: Record<string, unknown>): unknown {
  const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
  return event.usage ?? (isRecord(choice) ? choice.usage : undefined);
}

function cloneRawUsage(value: unknown, profile: PipelineWireProfile): unknown {
  if (!isRecord(value)) return undefined;
  try {
    // Relays can attach huge attribution blobs to usage. Keep only the counters consumed by
    // the strict reader BEFORE cloning/capping; metadata must not erase otherwise valid evidence.
    const projected =
      profile === "anthropic-messages"
        ? projectCounters(value, [
            "input_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
            "output_tokens",
          ])
        : profile === "openai-responses"
          ? projectCounters(value, ["input_tokens", "output_tokens"])
          : projectCounters(value, ["prompt_tokens", "completion_tokens", "prompt_cache_hit_tokens", "cached_tokens"]);
    const nestedKey =
      profile === "anthropic-messages"
        ? "cache_creation"
        : profile === "openai-responses"
          ? "input_tokens_details"
          : "prompt_tokens_details";
    if (Object.hasOwn(value, nestedKey)) {
      const nested = value[nestedKey];
      projected[nestedKey] = isRecord(nested)
        ? projectCounters(
            nested,
            profile === "anthropic-messages"
              ? ["ephemeral_1h_input_tokens", "ephemeral_5m_input_tokens"]
              : ["cached_tokens", "cache_write_tokens"],
          )
        : Array.isArray(nested)
          ? []
          : projectCounter(nested);
    }
    const clone: unknown = structuredClone(projected);
    const serialized = JSON.stringify(clone);
    return serialized !== undefined && Buffer.byteLength(serialized, "utf8") <= MEASURE_RAW_USAGE_MAX_BYTES
      ? clone
      : undefined;
  } catch {
    return undefined;
  }
}

function projectCounters(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of keys) if (Object.hasOwn(value, key)) projected[key] = projectCounter(value[key]);
  return projected;
}
function projectCounter(value: unknown): unknown {
  // Preserve invalid scalar counters too: the strict reader, not this projection, decides
  // validity. Non-leaf values become null (still invalid), never a missing/zero counter.
  return value === null || ["number", "string", "boolean", "undefined"].includes(typeof value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
