/**
 * FROZEN interface between keepalive packages A1 and A2 (capture-pairing-plan.md r7 §6).
 *
 * Owned by the main session. A1 implements `src/cache-ttl/pipeline-ping.ts` against these types; A2
 * (`src/service/cache-keepalive.ts`, `src/cache-ttl/keepalive-state.ts`, …) imports ONLY these types — never the A1
 * implementation module's internals. Neither package edits this file; a change here is a plan revision.
 *
 * Types only: this module has no runtime code.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Clock } from "../core/clock.js";
import type { Millis } from "../core/types.js";
import type { RawScannedUsage } from "./ping-client.js";

/** The only registry capability the transport uses (pi's `ModelRegistry.streamSimple` facade, plan §3.2). */
export type PipelinePingRegistry = Pick<ExtensionContext["modelRegistry"], "streamSimple">;

/** The chat model handed to `streamSimple` — the current `ctx.model` (already fingerprint-checked by the service). */
export type PipelinePingModel = Parameters<PipelinePingRegistry["streamSimple"]>[0];

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
 * retry/breaker classification apply unchanged.
 */
export type PipelineOutcome =
  | { kind: "not-sent"; reason: PipelineNotSentReason; diag: PipelineDiag }
  /** `usage === undefined` ⇔ `message_start` carried no usage object. */
  | { kind: "usage"; usage: RawScannedUsage | undefined; diag: PipelineDiag }
  /** Any non-2xx HTTP status. */
  | { kind: "http"; status: number; diag: PipelineDiag }
  /** 2xx received, then end/error/deadline before `message_start`. */
  | { kind: "accepted-then-lost"; diag: PipelineDiag }
  /** Base fetch rejected, or D/abort hit before response headers; `error` = sanitized descriptor (name/code only). */
  | { kind: "network"; error?: string; diag: PipelineDiag }
  /** No body, or the 64 KiB scan cap was hit before `message_start`. */
  | { kind: "malformed"; diag: PipelineDiag };

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
