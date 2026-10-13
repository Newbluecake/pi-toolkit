/**
 * Cache warmth assessment — pi-free (structural inputs only, no `@earendil-works/*` imports).
 *
 * topic-switch plan.md P2 (#7, #12): a pure, synchronous, never-throwing judgement of whether
 * the NEXT Anthropic request would read a warm prompt cache, built entirely from evidence this
 * package already tracks (the usage ledger, the keepalive service, and
 * the last payload this module itself sent). It never recomputes economics (that's
 * `src/topic-switch/economics.ts`, P1) and it never guesses: every "warm" verdict traces back to
 * a proven touch; `mode`/`lastSent` pick `nextWriteTtl`, and the cold-proof horizon is raised to
 * Anthropic's 1h max TTL ONLY by *proven* 1h landings (O1, 2026-10-12: an observed `cacheWrite1h>0`,
 * a confirmed recent 1h write, or the persisted provider-evidence record — never by the mere
 * INTENT of mode=on / a sent `ttl:"1h"`, which collapsing relays silently downgrade to 5m, see
 * `provider-evidence.ts`). Anything that can't be proven either way is `"unknown"` — the
 * caller (topic-switch's gate, I6) must treat `unknown` as "don't ask".
 */

/** D1: the only route family this module understands cache-control/TTL semantics for. */
export const WARMTH_SUPPORTED_APIS = Object.freeze(["anthropic-messages"] as const);

/** Default assumed TTL when there is no evidence of a 1h write (mirrors keepalive-state.ts's `ASSUMED_TTL_MS`). */
export const NOMINAL_5M_MS = 300_000;
/** Anthropic's maximum prompt-cache TTL — the hard upper bound any write could possibly survive. */
export const MAX_TTL_MS = 3_600_000;

export interface WarmthEvidence {
  now: number;
  route: { api: string; provider: string; modelId: string };
  ledger:
    | {
        at?: number;
        provider?: string;
        modelId: string;
        cacheRead: number;
        cacheWrite: number;
        cacheWrite1h?: number;
      }
    | undefined;
  /** The port has already filtered this to the current session — callers never need to re-check `sessionId` here. */
  lastSent?: { at: number; provider: string; modelId: string; ttl1h: boolean; cached: boolean };
  keepalive?: {
    provenReadAt?: number;
    lastReadStartedAt?: number;
    pingStartedAt?: number;
    pingInFlight: boolean;
    pingScheduled: boolean;
  };
  /** `anyLongWriteSince(ctx, now - MAX_TTL_MS)` — a longer-range 1h-write signal than `ledger.cacheWrite1h` alone (which only reflects the single latest entry). */
  recent1hWrite: boolean | "unknown";
  /**
   * O1 (2026-10-12): true only when this provider+model route has a PROVEN 1h-write landing on
   * record (`provider-evidence.ts`: an observed `cacheWrite1h > 0` within the rolling 30d TTL, or
   * a `/cache-ttl probe` landing). This is the only way the cold-proof horizon may reach the 1h
   * ceiling beyond the two direct observations (`ledger.cacheWrite1h`, `recent1hWrite`) — intent
   * signals (`mode === "on"`, `lastSent.ttl1h`) deliberately no longer qualify: on a collapsing
   * relay the intent is unwritable, so trusting it inflates "possibly still warm" by 55 minutes
   * and misleads topic-switch's gate 3a.
   */
  write1hEvidence: boolean;
  mode: "auto" | "on" | "off";
  slackMs: number;
  ttlOverrideMs?: number;
}

export type CacheWarmth =
  | { state: "warm"; reason: "proven-recent" }
  | { state: "cold"; reason: "ttl-elapsed" | "uncached"; nextWriteTtl: "5m" | "1h" | "none" }
  | {
      state: "unknown";
      reason:
        "unsupported-api" | "no-ledger" | "route-changed" | "keepalive-active" | "not-provably-cold" | "read-error";
    };

function isSupportedApi(api: string): boolean {
  return (WARMTH_SUPPORTED_APIS as readonly string[]).includes(api);
}

function routeChanged(
  ledger: { provider?: string; modelId: string },
  route: { provider: string; modelId: string },
): boolean {
  if (ledger.modelId !== route.modelId) return true;
  return ledger.provider !== undefined && ledger.provider !== route.provider;
}

function sameRoute(
  lastSent: { provider: string; modelId: string },
  route: { provider: string; modelId: string },
): boolean {
  return lastSent.provider === route.provider && lastSent.modelId === route.modelId;
}

/** Largest of the defined arguments, or `undefined` when none are defined. Never throws, never NaN. */
function maxDefined(...values: Array<number | undefined>): number | undefined {
  let best: number | undefined;
  for (const value of values) {
    if (value === undefined || !Number.isFinite(value)) continue;
    if (best === undefined || value > best) best = value;
  }
  return best;
}

function nextWriteTtlFor(e: WarmthEvidence): "5m" | "1h" | "none" {
  if (e.mode === "on" || e.lastSent?.ttl1h === true) return "1h";
  if (e.lastSent?.cached === false) return "none";
  return "5m";
}

function computeWarmth(e: WarmthEvidence): CacheWarmth {
  // 1. Unsupported API / missing ledger / route drift — none of the warm/cold evidence below
  //    is meaningful without a ledger anchored to the SAME route as the next request.
  if (!isSupportedApi(e.route.api)) return { state: "unknown", reason: "unsupported-api" };
  const ledger = e.ledger;
  if (!ledger || ledger.at === undefined) return { state: "unknown", reason: "no-ledger" };
  if (routeChanged(ledger, e.route)) return { state: "unknown", reason: "route-changed" };
  const ledgerAt = ledger.at;

  // 2. Warm only from evidence: a proven touch within the (possibly overridden)
  //    nominal TTL. mode/lastSent/1h traces never appear in this branch.
  const provenTouch = maxDefined(
    ledger.cacheRead + ledger.cacheWrite > 0 ? ledgerAt : undefined,
    e.keepalive?.provenReadAt,
  );
  if (provenTouch !== undefined && e.now - provenTouch < (e.ttlOverrideMs ?? NOMINAL_5M_MS)) {
    return { state: "warm", reason: "proven-recent" };
  }

  // 3. A ping in flight or scheduled could land between now and the next request — can't prove
  //    either way.
  if (e.keepalive?.pingInFlight === true || e.keepalive?.pingScheduled === true) {
    return { state: "unknown", reason: "keepalive-active" };
  }

  // 4. Provider told us outright this route wasn't cached (no cache bytes at all, and we're the
  //    ones who sent it without a breakpoint) — that's cold by construction, not by timeout, and
  //    the next write would be exactly as uncached (nextWriteTtl: "none").
  if (
    ledger.cacheRead + ledger.cacheWrite === 0 &&
    e.lastSent !== undefined &&
    sameRoute(e.lastSent, e.route) &&
    e.lastSent.cached === false
  ) {
    return { state: "cold", reason: "uncached", nextWriteTtl: "none" };
  }

  // 5. Prove cold by elapsed time: the latest possible touch (ledger, our own last send, or any
  //    keepalive activity) must be older than the longest TTL that could possibly still be
  //    alive, plus slack. O1: the 1h ceiling requires PROOF of a landed 1h write — the latest
  //    entry's own `cacheWrite1h > 0`, a confirmed recent 1h write (`recent1hWrite === true`;
  //    "unknown" no longer qualifies), or the persisted provider-evidence record. mode/lastSent
  //    intent never raises the bar (and still never flips the verdict to warm — that's step 2).
  const latestPossibleTouch = maxDefined(
    ledgerAt,
    e.lastSent?.at,
    e.keepalive?.lastReadStartedAt,
    e.keepalive?.pingStartedAt,
    e.keepalive?.provenReadAt,
  );
  // ledgerAt is always defined at this point, so latestPossibleTouch is too.
  const touch = latestPossibleTouch as number;
  const oneHourPossible = (ledger.cacheWrite1h ?? 0) > 0 || e.recent1hWrite === true || e.write1hEvidence === true;
  const maxLife = e.ttlOverrideMs ?? (oneHourPossible ? MAX_TTL_MS : NOMINAL_5M_MS);
  if (e.now - touch >= maxLife + e.slackMs) {
    return { state: "cold", reason: "ttl-elapsed", nextWriteTtl: nextWriteTtlFor(e) };
  }

  return { state: "unknown", reason: "not-provably-cold" };
}

/** Never throws — any unexpected failure degrades to `unknown/read-error` (I6: judged-unclear ⇒ don't ask). */
export function assessWarmth(e: WarmthEvidence): CacheWarmth {
  try {
    return computeWarmth(e);
  } catch {
    return { state: "unknown", reason: "read-error" };
  }
}
