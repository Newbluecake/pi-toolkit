/**
 * `/cache-ttl probe` — route health probe (O4, 2026-10-12).
 *
 * pi-free: builds and sends three REAL (billed) Anthropic-messages requests against the current
 * route and classifies what actually happened to the cache:
 *
 *   phase A (write5m):  a unique-nonce ~3000-token prefix with a plain `ephemeral` breakpoint
 *                       ⇒ did the provider register a cache WRITE at all? (`cacheAlive`)
 *   phase B (reread):   the byte-identical payload again, immediately
 *                       ⇒ does the entry read back? (`immediateHit` — proves the 5m namespace works)
 *   phase C (write1h):  the same prefix with `cache_control.ttl: "1h"`
 *                       ⇒ does the usage split report `ephemeral_1h_input_tokens > 0`?
 *                       (`write1hLanded` — on collapsing relays this stays 0/absent even though
 *                       the request was accepted, which is exactly what O1/O2 need to know)
 *
 * The nonce makes the prefix globally unique so phase B's hit can only come from phase A's write
 * (field lesson, memory cache-ttl.md: shared system/tools blocks hit across sessions — never
 * judge "alive" from a bare `cacheRead > 0` on a non-unique prefix).
 *
 * Bounds (zero-hang invariants): at most 3 requests, a 30s total budget (each request gets
 * `min(20s, remaining)`), every send goes through `postAndScanUsage`'s early-abort + resource
 * release contract, and the function never throws.
 *
 * The HTTP mechanics deliberately reuse ping-client.ts's send path (`buildPingRequest` +
 * `postAndScanUsage`) — only the payload construction and the verdict logic are new.
 */

import { randomUUID } from "node:crypto";
import {
  buildPingRequest,
  postAndScanUsage,
  type PingAuthFallback,
  type RawScannedUsage,
  type UsageScanOutcome,
} from "./ping-client.js";

/** Total wall-clock budget for the whole probe (all three phases). */
export const PROBE_TOTAL_TIMEOUT_MS = 30_000;
/** Per-request ceiling; the remaining total budget clamps it further. */
const PROBE_REQUEST_TIMEOUT_MS = 20_000;
/** ~3000 tokens ≈ 12k chars — comfortably above Anthropic's 1024-token minimum cacheable prefix. */
const PROBE_PREFIX_CHARS = 12_000;

export interface ProbeInput {
  baseUrl: string;
  /** Wire-level model id (`payload.model`). */
  model: string;
  /** Resolved auth (from `getApiKeyAndHeaders`) — applied via `buildPingRequest`'s fallback-fill rules. */
  apiKey?: string | undefined;
  authHeaders?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch | undefined;
  /** Total probe budget; default `PROBE_TOTAL_TIMEOUT_MS`. */
  timeoutMs?: number | undefined;
  /** Test seam; default `Date.now`. */
  now?: (() => number) | undefined;
}

export interface ProbePhase {
  /** How the phase's request ended (`"usage"` = a scannable 200 with a message_start). */
  outcome: UsageScanOutcome["kind"] | "skipped";
  usage: RawScannedUsage | undefined;
  /** Non-2xx status when `outcome === "http"`. */
  httpStatus?: number | undefined;
}

export interface ProbeResult {
  /** All three phases completed with a scannable response. */
  ok: boolean;
  /** Requests actually sent (≤3 — later phases are skipped after a hard failure). */
  requests: number;
  /** Phase A: the provider registered a cache write (`cache_creation > 0`). */
  cacheAlive: boolean;
  /** Phase B: the phase-A entry read back (`cache_read > 0`). */
  immediateHit: boolean;
  /** Phase C: a `ttl:"1h"` write reported `ephemeral_1h_input_tokens > 0`. */
  write1hLanded: boolean;
  tokens: { write5m: number; read: number; write1h: number };
  phases: { write: ProbePhase; reread: ProbePhase; write1h: ProbePhase };
  /** First failure description (redacted), when `ok === false`. */
  error?: string | undefined;
}

/** The probe's filler block: a unique nonce head + deterministic padding to ~3000 tokens. */
export function buildProbePrefix(nonce: string): string {
  const head = `cache-ttl-probe nonce: ${nonce}\nThis is a throwaway cache-probe prefix. Reply with "ok".\n`;
  const fillerUnit = "probe-filler-0123456789-abcdefghijklmnopqrstuvwxyz ";
  let text = head;
  while (text.length < PROBE_PREFIX_CHARS) text += fillerUnit;
  return text.slice(0, PROBE_PREFIX_CHARS);
}

function probeBody(model: string, text: string, ttl?: "1h"): Record<string, unknown> {
  return {
    model,
    max_tokens: 1,
    stream: true,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text,
            cache_control: ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" },
          },
        ],
      },
    ],
  };
}

function phaseFrom(outcome: UsageScanOutcome): ProbePhase {
  if (outcome.kind === "usage") {
    return { outcome: "usage", usage: outcome.usage };
  }
  return {
    outcome: outcome.kind,
    usage: undefined,
    ...(outcome.kind === "http" ? { httpStatus: outcome.status } : {}),
  };
}

function phaseError(phase: ProbePhase): string {
  return phase.outcome === "http" ? `http ${phase.httpStatus}` : phase.outcome;
}

/**
 * Run the three-phase probe. Never throws; on any phase failure the remaining phases are skipped
 * and `ok:false` + `error` describe the first failure (partial phase results are still reported).
 */
export async function runCacheProbe(input: ProbeInput): Promise<ProbeResult> {
  const now = input.now ?? Date.now;
  const deadline = now() + (input.timeoutMs ?? PROBE_TOTAL_TIMEOUT_MS);
  const nonce = `probe-${now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const prefix = buildProbePrefix(nonce);

  const auth: PingAuthFallback = {
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    ...(input.authHeaders !== undefined ? { headers: input.authHeaders } : {}),
  };
  // Baseline headers every Anthropic-messages request needs; auth keys are filled by
  // `buildPingRequest`'s fallback rules (OAuth bearer vs x-api-key) without overriding them here.
  const baselineHeaders: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "anthropic-version": "2023-06-01",
  };

  const phases: ProbeResult["phases"] = {
    write: { outcome: "skipped", usage: undefined },
    reread: { outcome: "skipped", usage: undefined },
    write1h: { outcome: "skipped", usage: undefined },
  };
  const result: ProbeResult = {
    ok: false,
    requests: 0,
    cacheAlive: false,
    immediateHit: false,
    write1hLanded: false,
    tokens: { write5m: 0, read: 0, write1h: 0 },
    phases,
  };

  const send = async (body: Record<string, unknown>): Promise<ProbePhase> => {
    const remaining = deadline - now();
    if (remaining <= 0) return { outcome: "skipped", usage: undefined };
    const { request } = buildPingRequest(body, input.baseUrl, baselineHeaders, auth);
    const outcome = await postAndScanUsage(request, {
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      timeoutMs: Math.min(PROBE_REQUEST_TIMEOUT_MS, remaining),
    });
    result.requests += 1;
    return phaseFrom(outcome);
  };

  try {
    // Phase A — plain 5m ephemeral write.
    phases.write = await send(probeBody(input.model, prefix));
    if (phases.write.outcome !== "usage") {
      result.error = `write phase: ${phaseError(phases.write)}`;
      return result;
    }
    result.tokens.write5m = phases.write.usage?.cacheWrite ?? 0;
    result.cacheAlive = result.tokens.write5m > 0;

    // Phase B — byte-identical immediate re-read.
    phases.reread = await send(probeBody(input.model, prefix));
    if (phases.reread.outcome !== "usage") {
      result.error = `reread phase: ${phaseError(phases.reread)}`;
      return result;
    }
    result.tokens.read = phases.reread.usage?.cacheRead ?? 0;
    result.immediateHit = result.tokens.read > 0;

    // Phase C — same prefix with the 1h write intent.
    phases.write1h = await send(probeBody(input.model, prefix, "1h"));
    if (phases.write1h.outcome !== "usage") {
      result.error = `write1h phase: ${phaseError(phases.write1h)}`;
      return result;
    }
    result.tokens.write1h = phases.write1h.usage?.cacheWrite1h ?? 0;
    result.write1hLanded = (phases.write1h.usage?.cacheWrite1h ?? 0) > 0;

    result.ok = true;
    return result;
  } catch (error) {
    // postAndScanUsage never throws; this is pure defence around the scaffolding.
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}
