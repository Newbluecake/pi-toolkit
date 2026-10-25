/**
 * FROZEN interface between keepalive packages A1 and A2 (capture-pairing-plan.md r7 §6).
 *
 * Owned by the main session. A1 implements `src/cache-ttl/pipeline-ping.ts` against these types; A2
 * (`src/cache-ttl/keepalive-service.ts`, `src/cache-ttl/keepalive-state.ts`, …) imports ONLY these types — never the A1
 * implementation module's internals. Neither package edits this file; a change here is a plan revision.
 *
 * Types only: this module has no runtime code.
 *
 * Revision (measure-plan.md r4 §6, package M0): ADDITIVE measurement-only types — `PipelineWireProfile`,
 * `PipelineMeasurementInput` (optional `PipelinePingInput.measurement`) and `PipelineMeasured` (optional `measured` on
 * every `PipelineOutcome` variant). Absent ⇒ the keepalive contract above is unchanged.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Clock } from "../core/clock.js";
import type { Millis } from "../core/types.js";
import type { RawScannedUsage } from "./ping-client.js";
import type { UsageSource } from "./late-usage.js";

/** The only registry capability the transport uses (pi's `ModelRegistry.streamSimple` facade, plan §3.2). */
export type PipelinePingRegistry = Pick<ExtensionContext["modelRegistry"], "streamSimple">;

/** The chat model handed to `streamSimple` — the current `ctx.model` (already fingerprint-checked by the service). */
export type PipelinePingModel = Parameters<PipelinePingRegistry["streamSimple"]>[0];

/**
 * Measurement-only (measure-plan.md r4 §6): the pi-ai `Context` handed to `streamSimple` in build mode. Keepalive
 * never uses it (its transport keeps the fixed one-message placeholder context).
 */
export type PipelinePingContext = Parameters<PipelinePingRegistry["streamSimple"]>[1];

/**
 * Measurement-only (measure-plan.md r4 §2/§6): the wire protocols `/cache-ttl measure` supports. Selects the api
 * gate, the endpoint path suffix (`/v1/messages` · `/responses` · `/chat/completions`) and the terminal usage frame.
 * Keepalive never sets it; its behaviour stays the implicit `"anthropic-messages"` path.
 */
export type PipelineWireProfile = "anthropic-messages" | "openai-responses" | "openai-completions";

/** Measurement-only route identity computed by the transport for the request URL it is about to send (plan §6). */
export interface PipelineMeasureRouteKey {
  /** `sha256:<hex>` digest over api, normalised origin, path minus suffix, sorted query, wire model, effective tier. */
  key: string;
  /** Redacted, display-only label (host + ≤ 2 path segments; token-like segments and query values ⇒ `…`). */
  label: string;
}

/**
 * Measurement-only input block (measure-plan.md r4 §6). ABSENT for every keepalive ping, in which case the transport
 * behaves byte-for-byte as before (reader, outcome kinds and diag semantics unchanged). When present:
 *   - api gate `model.api === profile`, per-profile path suffix, base fetch with `redirect: "manual"` (3xx ⇒ an `http`
 *     outcome, never followed);
 *   - every request computes the route key of its actual URL via `routeKey` and, when `expectRouteKey` is set,
 *     refuses (`not-sent{capability}`) on a mismatch — likewise when the wire body `model` differs from the expected one;
 *   - the terminal usage frame of `profile` ends the request and its raw `usage` object is cloned into
 *     `measured.rawUsage` (≤ `MEASURE_RAW_USAGE_MAX_BYTES`); OpenAI profiles run to completion;
 *   - `measured.sentAt` is recorded right before the base fetch, `measured.headersAt` at response headers.
 */
export interface PipelineMeasurementInput {
  profile: PipelineWireProfile;
  /**
   * Build mode (writes, plan §3.3/§6): pi builds the params from `context`; the FIRST `onPayload` calls `validate` on
   * the final params. A non-`undefined` result is a rejection code ⇒ `onPayload` throws ⇒ no fetch ⇒
   * `not-sent{capability}` with `measured.rejection`. Accepted ⇒ `measured.builtBody = structuredClone(params)` and
   * `onPayload` returns `undefined` (pi sends its own params). `PipelinePingInput.body` is ignored in build mode.
   * Replays (controls, probes, renewal) omit `build` and send `body` (the earlier `builtBody`) verbatim.
   */
  build?: {
    context: PipelinePingContext;
    maxTokens: number;
    cacheRetention: "short" | "long";
    /** Build-only low-effort measurement (Responses or Anthropic forceAdaptiveThinking); absent for keepalive/replay. */
    reasoning?: "low";
    validate: (params: Record<string, unknown>) => string | undefined;
  };
  /**
   * Route key of the request URL. Supplied by the measurement runner (it binds api + effective tier, the latter known
   * from the validated build). A throw is treated as a capability failure (`not-sent{capability}`).
   */
  routeKey: (requestUrl: string) => PipelineMeasureRouteKey;
  /** Run-wide route key fixed by the first valid write (plan §5.1); absent only for that first write. */
  expectRouteKey?: string;
  /** Expected wire `model` of the request body (plan §6); mismatch ⇒ `not-sent{capability}`. */
  expectWireModel: string;
}

/** Measurement-only outcome annex (plan §6). Present only when the input carried `measurement`. */
export interface PipelineMeasured {
  /** Build-mode validator rejection code (`not-sent{capability}` only). */
  rejection?: string;
  /** Route mismatch detected before the base fetch (`not-sent{capability}` only). */
  routeMismatch?: true;
  /** Deep clone of the pi-built params accepted by `validate` (build mode only). */
  builtBody?: Record<string, unknown>;
  /** Bounded clone of the terminal frame's raw `usage` object, uninterpreted (the measurement reader parses it). */
  rawUsage?: unknown;
  /** Route key / label of the URL actually sent (or refused). */
  routeKey?: string;
  routeLabel?: string;
  /** `clock.now()` immediately before the base fetch (the only time a request is "sent"). */
  sentAt?: Millis;
  /** `clock.now()` when the response headers arrived. */
  headersAt?: Millis;
  /** HTTP `Location` header was present on a 3xx (value never recorded). */
  redirected?: true;
  /** Measurement-only, redacted ≤160-character provider message from a bounded HTTP 400 JSON body. */
  httpError?: string;
}

/**
 * Header-source literal for keepalive ping diagnostics when the ping went through pi's provider pipeline. Lives here
 * (not in `ping-client.ts`'s `PingHeaderSource`) so A1 and A2 never edit the same declaration: A2 widens
 * `KeepalivePingDiagnostics.headerSource` to `PingHeaderSource | PipelineHeaderSource`; `PingHeaderSource` stays as is
 * (probe path).
 */
export type PipelineHeaderSource = "pipeline";

/**
 * Input of {@link SendPipelinePing}.
 *
 * Clock basis: every time value is on the SERVICE's injected {@link Clock} (`CacheKeepaliveService.clock`, which is
 * `systemClock`/`Date.now()` in production and a fake clock in tests). The transport must read time only via
 * `clock.now()` and arm its single hard-deadline timer only via `clock.setTimer` (unref'd in production) — never
 * `Date.now()`/`setTimeout` directly. `timeoutMs` passed to pi is `deadlineAt − clock.now()` at call time.
 */
export interface PipelinePingInput {
  registry: PipelinePingRegistry;
  model: PipelinePingModel;
  /** The capture's session id (agent session id) — forwarded as `SimpleStreamOptions.sessionId`. */
  sessionId: string;
  /**
   * Final ping body (already `preparePingPayload` + optional O2 TTL strip). Returned verbatim by the first
   * `onPayload` call; never mutated by the transport.
   */
  body: Readonly<Record<string, unknown>>;
  clock: Clock;
  /** Absolute hard deadline D on `clock`'s timebase: `min(now + 20 s, aliveUntil − TTL_SAFETY_MARGIN_MS)` (§3.3). */
  deadlineAt: Millis;
  /**
   * Service-side liveness check: same window epoch ∧ not disposed. The transport ANDs it with `clock.now() <
   * deadlineAt` and evaluates it in `transformHeaders` (after pipeline auth), in the first `onPayload`, and right
   * before the base fetch. `false` anywhere before the base fetch ⇒ `not-sent{reason:"guard"}` (or `"deadline"`).
   * It does NOT protect against credential identity or dynamic-auth routing changes (plan §4).
   */
  guard: () => boolean;
  /** Service abort (dispose / real request preemption); aborting it aborts the transport. */
  signal?: AbortSignal;
  /** Test seam: replaces the base `fetch` behind the transport's own fetch wrapper. Production: `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Measurement-only block (measure-plan.md r4 §6). Keepalive never sets it. */
  measurement?: PipelineMeasurementInput;
  /**
   * Late-usage line (plan.md 2026-10-20 "late-usage lines"): keep reading past a non-proving `message_start` until the
   * first `message_delta` carrying `usage` (or `message_stop`), under a larger bounded scan cap. Absent/false ⇒ the
   * legacy cancel-at-`message_start` behaviour, byte-identical. Ignored when `measurement` is set.
   */
  lateUsage?: boolean;
}

/** Why a ping never reached the base fetch (zero network; the service refunds the budget). */
export type PipelineNotSentReason =
  | "guard" // service guard false (epoch moved / disposed) before the base fetch
  | "deadline" // D elapsed before the base fetch (e.g. slow pipeline auth)
  | "aborted" // `input.signal` aborted before the base fetch
  | "auth" // pi's pipeline auth / prepareRequest failed before onPayload
  | "capability" // pi never called our onPayload / fetch the documented way (structural mismatch)
  | "provider-error"; // pi's provider failed before the base fetch for any other reason

/** Typed transport diagnostics, present on EVERY outcome (names/counters only — never header values or bodies). */
export interface PipelineDiag {
  /** Base-fetch invocations made by the wrapper: 0 for `not-sent`, otherwise exactly 1 (once-guard). */
  baseFetchCalls: number;
  /** `onPayload` invocations observed (≥2 means a strict fallback was attempted and blocked). */
  onPayloadCalls: number;
  /** A raw Anthropic `message_start` was delivered via `onProviderStreamEvent`. */
  sawMessageStart: boolean;
  /**
   * pi's own result settled as an explicit success (`stopReason` ∈ stop/length/toolUse) without being aborted by the
   * transport. The only input the service's runtime capability diagnosis may use (plan §3.4); usage presence is
   * never evidence.
   */
  explicitSuccess: boolean;
  /** pi's final `stopReason` when it settled before the logical outcome, else `undefined`. */
  piStopReason: string | undefined;
  /** HTTP status seen by the fetch wrapper; `undefined` when no response headers arrived. */
  httpStatus: number | undefined;
  /** Response body bytes passed through the bounded stream (≤ 64 KiB scan cap / 2 KiB error cap). */
  bodyBytes: number;
  /** Lower-cased, sorted request header NAMES the base fetch was called with (values never recorded). */
  wireHeaderNames: readonly string[];
  /** The hard deadline D fired before the logical outcome. */
  deadlineHit: boolean;
  /** `clock.now()` delta from call start to the logical outcome. */
  durationMs: Millis;
}

/**
 * Logical outcome of one pipeline ping. Every variant except `not-sent` means the base fetch WAS invoked (the request
 * may have reached the server). The sent kinds mirror `UsageScanOutcome` 1:1 so `classifyUsage` and the existing
 * retry/breaker classification apply unchanged. `measured` is set only for measurement requests (plan §6) — keepalive
 * outcomes never carry it. For the `anthropic-messages` measurement profile the `usage` variant still carries the
 * keepalive projection in `usage`; measurement code must read `measured.rawUsage` instead (strict reader, plan §5.2).
 */
export type PipelineOutcome =
  | { kind: "not-sent"; reason: PipelineNotSentReason; diag: PipelineDiag; measured?: PipelineMeasured }
  /** `usage === undefined` ⇔ `message_start` carried no usage object. */
  | {
      kind: "usage";
      usage: RawScannedUsage | undefined;
      /** Present only on late-usage pings (`PipelinePingInput.lateUsage`); absent ⇒ `message_start`. */
      usageSource?: UsageSource;
      diag: PipelineDiag;
      measured?: PipelineMeasured;
    }
  /** Any non-2xx HTTP status. */
  | { kind: "http"; status: number; diag: PipelineDiag; measured?: PipelineMeasured }
  /** 2xx received, then end/error/deadline before `message_start`. */
  | { kind: "accepted-then-lost"; diag: PipelineDiag; measured?: PipelineMeasured }
  /** Base fetch rejected, or D/abort hit before response headers; `error` = sanitized descriptor (name/code only). */
  | { kind: "network"; error?: string; diag: PipelineDiag; measured?: PipelineMeasured }
  /** No body, or the 64 KiB scan cap was hit before `message_start`. */
  | { kind: "malformed"; diag: PipelineDiag; measured?: PipelineMeasured };

/** The subset of {@link PipelineOutcome} in which the base fetch was invoked. */
export type SentPipelineOutcome = Exclude<PipelineOutcome, { kind: "not-sent" }>;

/**
 * Result of {@link SendPipelinePing}.
 *
 * - `outcome`: the LOGICAL result, available no later than `deadlineAt` (the returned promise resolves by D).
 * - `settled`: resolves only after EVERY physical operation has finished — the base fetch promise, the upstream body
 *   cancel/close, and pi's stream result. It NEVER rejects. It may stay pending indefinitely if one of those never
 *   settles; the service keeps `io-busy` until it resolves (fail closed, plan §3.3).
 */
export interface PipelinePingResult {
  outcome: PipelineOutcome;
  settled: Promise<void>;
}

/**
 * The frozen A1 entry point, implemented by `src/cache-ttl/pipeline-ping.ts` as
 * `export const sendPipelinePing: SendPipelinePing`. The returned promise never rejects and resolves by `deadlineAt`.
 */
export type SendPipelinePing = (input: PipelinePingInput) => Promise<PipelinePingResult>;
