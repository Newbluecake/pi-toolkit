/**
 * cache-keepalive-web plan §4.1 (P-B): pure view-logic for the detail header's read-only
 * prompt-cache keepalive panel. `cacheKeepaliveOf` narrows `AgentState.status.cacheKeepalive`
 * (a deliberately loose `Record<string, unknown>` in `types.ts`) to the `CacheKeepaliveWire`
 * shape declared in `@protocol/messages.js` — same posture as `bashJobsView.ts`'s `bashJobsOf`
 * (the status reducer replaces `agent.status` wholesale, so the panel reads the slot directly
 * and `state.js`/`types.ts` stay untouched).
 *
 * Render rules the component consumes from here:
 * - the wire must carry `v === 1` AND an array `lines` — anything else (legacy agent, dropped
 *   frame, malformed slot) is `undefined` ⇒ no panel at all;
 * - `ping.state` / `mode` / `lastPing.kind` are OPEN strings on the wire (plan §2: an older UI
 *   must never drop a newer frame over an unknown enum value): `markerTone` maps the known
 *   states and falls back to neutral, `kindToken` passes unknown kinds through verbatim;
 * - the collapsed marker is `[modeText, pingText].filter(Boolean).join(" · ")`, byte-parallel
 *   to the TUI status line (`renderCacheStatus` joins segments with the same separator);
 * - ALL countdown math uses the BROWSER clock (plan §4.2/D3 + review r2 #5): `retryAt − now`
 *   and `Date.now() − lastPing.at` are computed at render time from the `nowMs` the component
 *   feeds in (the 30s ticker only exists while some `retryAt` is still in the future or the
 *   expanded panel shows a lastPing age), NEVER frozen off `wire.at`.
 */
import type { CacheKeepaliveLineWire, CacheKeepaliveWire } from "@protocol/messages.js";
import type { AgentState } from "../../types.js";
import { statusOf } from "./agentViews.js";

/** The wire when it exists and is well-formed (`v === 1` + array `lines`); `undefined` ⇒ render nothing. */
export function cacheKeepaliveOf(agent: Pick<AgentState, "status">): CacheKeepaliveWire | undefined {
  const w = statusOf(agent)?.cacheKeepalive;
  if (w === null || typeof w !== "object" || Array.isArray(w)) return undefined;
  const rec = w as unknown as Record<string, unknown>;
  if (rec["v"] !== 1 || !Array.isArray(rec["lines"])) return undefined;
  return w;
}

/**
 * `formatMsShort`, same 口径 as the agent side (`src/cache-ttl/keepalive-state.ts`): `<1m`
 * below a minute, ceil'd minutes (`60001 → 2m`) up to 120m, then ceil'd hours capped at 24h;
 * non-finite/≤0 ⇒ `0m`. Pinned to the agent implementation by the SHARED vector fixture
 * `tests/fixtures/cache-keepalive-format-vectors.json` (both sides' tests read the same file,
 * so any drift on either side turns both suites red).
 */
export function formatMsShort(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  if (ms < 60_000) return "<1m";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 120) return `${minutes}m`;
  return `${Math.min(24, Math.ceil(minutes / 60))}h`;
}

/** Display tone for the collapsed marker (data-attr → color), from `ping.state` (open string). */
export type KeepaliveTone = "neutral" | "warn" | "bad";

/** Known `ping.state` values (frozen post-#29, plan §0.5); ANY unknown value ⇒ neutral. */
const STATE_TONE: Readonly<Record<string, KeepaliveTone>> = {
  "line-off": "bad",
  disabled: "bad",
  paused: "warn",
  capped: "warn",
  active: "neutral",
};

export function markerTone(wire: CacheKeepaliveWire): KeepaliveTone {
  const state = wire.ping?.state;
  if (typeof state !== "string") return "neutral";
  return STATE_TONE[state] ?? "neutral";
}

/**
 * The collapsed one-line marker: `[modeText, pingText].filter(Boolean).join(" · ")`.
 *
 * `pingText` re-assembles the TUI ping segment head + the locally-computed `·retry Xm` + the
 * `·tN` tail (plan §2: the three parts join in exactly the TUI's order
 * `ping off:http 403 ·retry 25m ·t3`); an already-elapsed `retryAt` renders as nothing here —
 * the expanded view shows `eligible now` on the line rows instead. `enabled:false` appends the
 * `keepalive off` token so a runtime `/cache-ttl keepalive off` stays visible (D6). All tokens
 * are English in BOTH locales (AGENTS.md UI-text rule).
 */
export function markerText(wire: CacheKeepaliveWire, nowMs: number): string {
  const parts: string[] = [];
  const modeText = typeof wire.modeText === "string" ? wire.modeText : "";
  if (modeText !== "") parts.push(modeText);
  const ping = wire.ping;
  if (ping !== undefined && typeof ping.text === "string" && ping.text !== "") {
    let s = ping.text;
    const retryAt = ping.retryAt;
    if (typeof retryAt === "number" && Number.isFinite(retryAt) && retryAt > nowMs) {
      s += ` ·retry ${formatMsShort(retryAt - nowMs)}`;
    }
    if (typeof ping.tail === "string" && ping.tail !== "") s += ` ${ping.tail}`;
    parts.push(s);
  }
  if (wire.enabled !== true) parts.push("keepalive off");
  return parts.join(" · ");
}

/** One breaker line reduced to its display pieces (all values clamped/兜底 for open frames). */
export interface KeepaliveLineRow {
  readonly label: string;
  readonly open: boolean;
  readonly status: number | undefined;
  readonly trips: number;
  readonly retryAt: number | undefined;
  readonly current: boolean;
  readonly wildcard: boolean;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function lineRows(wire: CacheKeepaliveWire): KeepaliveLineRow[] {
  const out: KeepaliveLineRow[] = [];
  for (const raw of wire.lines) {
    if (raw === null || typeof raw !== "object") continue;
    const r = raw as unknown as Record<string, unknown>;
    const label = typeof r["label"] === "string" ? r["label"] : "";
    out.push({
      label,
      open: r["open"] === true,
      status: num(r["status"]),
      trips: typeof r["trips"] === "number" && Number.isFinite(r["trips"]) ? Math.max(0, Math.floor(r["trips"])) : 0,
      retryAt: num(r["retryAt"]),
      current: r["current"] === true,
      wildcard: r["wildcard"] === true,
    });
  }
  return out;
}

/** `retryAt > now` on the ping segment or ANY line row ⇒ the 30s ticker must exist (plan §4.2:
 * the collapsed marker's `·retry` keeps ticking even while the panel is folded). */
export function hasPendingRetry(wire: CacheKeepaliveWire, nowMs: number): boolean {
  const p = wire.ping?.retryAt;
  if (typeof p === "number" && Number.isFinite(p) && p > nowMs) return true;
  return lineRows(wire).some((row) => row.retryAt !== undefined && row.retryAt > nowMs);
}

/** The last ping reduced to display pieces; `undefined` when the wire carries none. */
export interface KeepaliveLastPingView {
  readonly at: number;
  readonly kind: string;
  readonly status: number | undefined;
  readonly transient: boolean | undefined;
  /** Line-scoped breaker kind (`proven-write`/`no-usage`): shown as a per-line chip, never 「永久」. */
  readonly line: boolean;
  readonly attempts: number | undefined;
}

export function lastPingView(wire: CacheKeepaliveWire): KeepaliveLastPingView | undefined {
  const lp = wire.lastPing;
  if (lp === null || typeof lp !== "object" || typeof lp.at !== "number" || typeof lp.kind !== "string") {
    return undefined;
  }
  const rec = lp as unknown as Record<string, unknown>;
  return {
    at: lp.at,
    kind: lp.kind,
    status: num(rec["status"]),
    transient: typeof rec["transient"] === "boolean" ? rec["transient"] : undefined,
    line: rec["line"] === true,
    attempts: num(rec["attempts"]),
  };
}

/**
 * `lastPing.at` → `{age} ago` age text (minute granularity, BROWSER clock — review r2 #5:
 * a `wire.at`-frozen age would stall for tens of minutes until the next fingerprint change).
 * `undefined` while `at` is in the future of `nowMs` (clock skew guard).
 */
export function lastPingAgeText(at: number, nowMs: number): string | undefined {
  const age = nowMs - at;
  if (!Number.isFinite(age) || age < 0) return undefined;
  return `${formatMsShort(age)} ago`;
}

/** Token count display, same 口径 as the TUI's `formatTokenCount`: `450k` / `1.2m` / `890`. */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

/** Cache-read cost display, same 口径 as the TUI's `formatCost`: `≈$0.12`; `undefined` ⇒ `—`. */
export function formatCacheCost(costUsd: number | undefined): string {
  return typeof costUsd === "number" && Number.isFinite(costUsd) ? `≈$${costUsd.toFixed(2)}` : "—";
}

/** `mode` display: `auto`/`on`/`off` verbatim + `*` when dirty; unknown modes fall through
 * unchanged (open string, plan §2). */
export function modeToken(mode: string, dirty: boolean): string {
  return `${typeof mode === "string" ? mode : "?"}${dirty ? "*" : ""}`;
}
