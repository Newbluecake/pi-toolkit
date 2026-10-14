/**
 * Provider-route cache evidence (cache-ttl optimizations O1/O3/O4, 2026-10-12).
 *
 * pi-free (only `node:fs`/`node:path`/`node:os`): a tiny persisted ledger that
 * records, per `provider + modelId` route, facts we have *proven* about that
 * route's prompt-cache behaviour — as opposed to intents (mode=on, a
 * `ttl:"1h"` field on the wire), which collapsing relays silently downgrade
 * (measured 2026-10-12: cr-anthropic / kimi-coding accept `ttl:"1h"` but their
 * `cacheWrite1h` stays 0 forever — the 1h entry never exists).
 *
 * Three evidence classes live here:
 *   - `write1hLandedAt` — a real `cacheWrite1h > 0` observation (from pi's
 *     usage ledger) or a `/cache-ttl probe` landing. Rolling 30d TTL,
 *     refreshed on each new observation. Drives warmth's 1h horizon (O1) and
 *     the keepalive replay's keep-vs-strip-`ttl` decision (O2).
 *   - `zeroReadSessions` / `noCacheValueSince` — the O3 provider-level
 *     breaker: consecutive sessions where keepalive was active but no cache
 *     read was ever observed ( pings all read 0 AND no real request read
 *     either). At `NO_CACHE_VALUE_STREAK_LIMIT` the route is fused off; any
 *     observed `cacheRead > 0` resets it immediately.
 *   - `probe` / `probedAt` — the last `/cache-ttl probe` verdict (O4).
 *
 * Failure direction (topic-switch I6, same everywhere here): every read
 * failure is treated as "no evidence" (the more conservative COLD judgement),
 * every write failure is swallowed. Nothing in this module ever throws.
 *
 * Clock discipline (AGENTS.md): no implicit clock reads — every method takes
 * `now` explicitly. No timers at all.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { Millis } from "../core/types.js";
import { readLatestAssistantUsage, type LedgerCtxLike } from "./usage-ledger.js";

/** Rolling TTL for the 1h-landing evidence (and for pruning dead route records). */
export const PROVIDER_EVIDENCE_TTL_MS: Millis = 30 * 24 * 3_600_000;
/**
 * `noteWrite1hLanded` refreshes the rolling TTL at most this often — a 1h
 * write landing is binary evidence, not a stopwatch, so a daily refresh keeps
 * the 30d window alive with 29d of margin without a disk write per message.
 */
export const WRITE1H_REFRESH_MIN_INTERVAL_MS: Millis = 24 * 3_600_000;
/** O3: consecutive keepalive-active-but-zero-read sessions before the route is fused off. */
export const NO_CACHE_VALUE_STREAK_LIMIT = 3;
/** Hard cap on tracked routes (FIFO eviction by latest activity) — bounds file size. */
export const PROVIDER_EVIDENCE_MAX_ROUTES = 200;
/** Read cap: a larger file is treated as corrupt (degrade to empty). */
const MAX_FILE_BYTES = 1024 * 1024;

/** Route key separator — NUL cannot appear in a provider/model id on the wire. */
const KEY_SEP = "\u0000";

export function routeKey(provider: string, modelId: string): string {
  return `${provider}${KEY_SEP}${modelId}`;
}

/** O4: the verdict of one `/cache-ttl probe` run. */
export interface ProviderRouteProbe {
  /** Phase B: the immediate re-read hit the entry phase A wrote (cache accounting works at all). */
  cacheAlive: boolean;
  /** Phase B's `cacheRead > 0` (same thing as cacheAlive today; kept separate for future phases). */
  immediateHit: boolean;
  /** Phase C: a `ttl:"1h"` write reported `ephemeral_1h_input_tokens > 0` — the 1h entry really exists. */
  write1hLanded: boolean;
}

export interface ProviderRouteEvidence {
  /** Last time a 1h write was observed landing on this route (ms epoch). */
  write1hLandedAt?: Millis;
  probedAt?: Millis;
  probe?: ProviderRouteProbe;
  /** O3: consecutive sessions with active keepalive but zero observed cache reads. */
  zeroReadSessions: number;
  /** O3: set when the streak reached `NO_CACHE_VALUE_STREAK_LIMIT` (the trip time). Cleared by any cache read. */
  noCacheValueSince?: Millis;
}

export interface ProviderEvidenceStore {
  /** O1/O2: true iff a 1h write has been PROVEN to land on this route within the rolling TTL. */
  hasWrite1hEvidence(provider: string, modelId: string, now: Millis): boolean;
  /** Record a proven 1h-write landing (usage observation or probe). Refreshes the rolling TTL (rate-limited). */
  noteWrite1hLanded(provider: string, modelId: string, now: Millis): void;
  /** O3: true while this route is fused off for "keepalive active but cache never read". */
  isNoCacheValue(provider: string, modelId: string, now: Millis): boolean;
  /** O3: a session ended with keepalive active and zero cache reads — increments the streak, trips at the limit. */
  noteZeroReadSession(provider: string, modelId: string, now: Millis): void;
  /** O3: any observed `cacheRead > 0` (real request usage or a proven-hit ping) resets the breaker immediately. */
  noteCacheRead(provider: string, modelId: string, now: Millis): void;
  /** User manual reset: clear this route's no-cache-value streak + breaker (no fabricated cacheRead evidence; write1h/probe untouched). */
  resetNoCacheValue(provider: string, modelId: string, now: Millis): void;
  /** O4: record a probe verdict (also feeds write1h/noCacheValue evidence per its findings). */
  noteProbe(provider: string, modelId: string, probe: ProviderRouteProbe, now: Millis): void;
  /** Diagnostic read (`/cache-ttl probe` output, status). `undefined` when nothing is known. */
  readRoute(provider: string, modelId: string, now: Millis): ProviderRouteEvidence | undefined;
}

interface RouteRecordRaw {
  write1hLandedAt?: unknown;
  probedAt?: unknown;
  probe?: unknown;
  zeroReadSessions?: unknown;
  noCacheValueSince?: unknown;
}

interface EvidenceFileRaw {
  version?: unknown;
  routes?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteMs(value: unknown): Millis | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sanitizeProbe(value: unknown): ProviderRouteProbe | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.cacheAlive !== "boolean" ||
    typeof value.immediateHit !== "boolean" ||
    typeof value.write1hLanded !== "boolean"
  ) {
    return undefined;
  }
  return { cacheAlive: value.cacheAlive, immediateHit: value.immediateHit, write1hLanded: value.write1hLanded };
}

function sanitizeRoute(value: unknown): ProviderRouteEvidence | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value as RouteRecordRaw;
  const out: ProviderRouteEvidence = { zeroReadSessions: 0 };
  const write1hLandedAt = finiteMs(raw.write1hLandedAt);
  if (write1hLandedAt !== undefined) out.write1hLandedAt = write1hLandedAt;
  const probedAt = finiteMs(raw.probedAt);
  if (probedAt !== undefined) out.probedAt = probedAt;
  const probe = sanitizeProbe(raw.probe);
  if (probe !== undefined) out.probe = probe;
  const streak = finiteMs(raw.zeroReadSessions);
  if (streak !== undefined) out.zeroReadSessions = Math.floor(streak);
  const trippedAt = finiteMs(raw.noCacheValueSince);
  if (trippedAt !== undefined) out.noCacheValueSince = trippedAt;
  return out;
}

/** Latest activity timestamp of a record, or `undefined` when it has none (for TTL pruning and FIFO eviction). */
function latestActivity(route: ProviderRouteEvidence): Millis | undefined {
  let latest: Millis | undefined;
  for (const t of [route.write1hLandedAt, route.probedAt, route.noCacheValueSince] as const) {
    if (t !== undefined && (latest === undefined || t > latest)) latest = t;
  }
  return latest;
}

/** True when every fact on the record is older than the TTL (or empty) and no breaker state is live. */
function isExpired(route: ProviderRouteEvidence, now: Millis): boolean {
  if (route.noCacheValueSince !== undefined && now - route.noCacheValueSince < PROVIDER_EVIDENCE_TTL_MS) return false;
  const latest = latestActivity(route);
  if (latest === undefined) {
    // No timestamps at all: keep an open (un-tripped) streak — it has no clock of its own —
    // but drop a truly empty record.
    return route.zeroReadSessions === 0 && route.probe === undefined;
  }
  return now - latest >= PROVIDER_EVIDENCE_TTL_MS;
}

class ProviderEvidenceStoreImpl implements ProviderEvidenceStore {
  private loaded = false;
  private routes = new Map<string, ProviderRouteEvidence>();

  constructor(private readonly filePath: string) {}

  /** Lazy load; any failure degrades to "empty store" and never throws (I6 direction). */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const stat = fs.statSync(this.filePath);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!isRecord(parsed)) return;
      const raw = parsed as EvidenceFileRaw;
      if (raw.version !== 1 || !isRecord(raw.routes)) return;
      for (const [key, value] of Object.entries(raw.routes)) {
        const route = sanitizeRoute(value);
        if (route !== undefined) this.routes.set(key, route);
      }
    } catch {
      // missing file / unreadable / corrupt JSON ⇒ start empty (never clobber-detection needed:
      // a corrupt file being replaced by the next atomic write is the desired recovery).
    }
  }

  /** Write-through persist: tmp file + same-dir rename (atomic), 0700 dir / 0600 file. Never throws. */
  private persist(now: Millis): void {
    try {
      this.prune(now);
      const routes: Record<string, unknown> = {};
      for (const [key, route] of this.routes) routes[key] = route;
      const body = JSON.stringify({ version: 1, routes });
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      // disk full / read-only fs / race on the tmp name ⇒ evidence is best-effort; stay silent.
    }
  }

  /** Drop TTL-expired records and enforce the FIFO route cap. */
  private prune(now: Millis): void {
    for (const [key, route] of this.routes) {
      if (isExpired(route, now)) this.routes.delete(key);
    }
    while (this.routes.size > PROVIDER_EVIDENCE_MAX_ROUTES) {
      let oldestKey: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [key, route] of this.routes) {
        const activity = latestActivity(route) ?? -1; // timeless records evict first
        if (activity < oldest) {
          oldest = activity;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) break;
      this.routes.delete(oldestKey);
    }
  }

  private get(provider: string, modelId: string): ProviderRouteEvidence | undefined {
    this.ensureLoaded();
    return this.routes.get(routeKey(provider, modelId));
  }

  private mutate(provider: string, modelId: string, now: Millis, fn: (route: ProviderRouteEvidence) => boolean): void {
    if (!provider || !modelId) return;
    this.ensureLoaded();
    const key = routeKey(provider, modelId);
    const route = this.routes.get(key) ?? { zeroReadSessions: 0 };
    if (!fn(route)) return; // no change ⇒ no disk write
    this.routes.set(key, route);
    // Map insertion-order refresh so the FIFO cap evicts truly-idle routes first.
    this.routes.delete(key);
    this.routes.set(key, route);
    this.persist(now);
  }

  hasWrite1hEvidence(provider: string, modelId: string, now: Millis): boolean {
    try {
      const route = this.get(provider, modelId);
      if (route?.write1hLandedAt === undefined) return false;
      return now - route.write1hLandedAt < PROVIDER_EVIDENCE_TTL_MS;
    } catch {
      return false;
    }
  }

  noteWrite1hLanded(provider: string, modelId: string, now: Millis): void {
    try {
      this.mutate(provider, modelId, now, (route) => {
        if (route.write1hLandedAt !== undefined && now - route.write1hLandedAt < WRITE1H_REFRESH_MIN_INTERVAL_MS) {
          return false; // daily-refresh rate limit — see WRITE1H_REFRESH_MIN_INTERVAL_MS.
        }
        route.write1hLandedAt = now;
        return true;
      });
    } catch {
      // never throws.
    }
  }

  isNoCacheValue(provider: string, modelId: string, now: Millis): boolean {
    try {
      const route = this.get(provider, modelId);
      if (route?.noCacheValueSince === undefined) return false;
      // The trip itself ages out after the TTL: a route fixed later gets a fresh chance.
      return now - route.noCacheValueSince < PROVIDER_EVIDENCE_TTL_MS;
    } catch {
      return false;
    }
  }

  noteZeroReadSession(provider: string, modelId: string, now: Millis): void {
    try {
      this.mutate(provider, modelId, now, (route) => {
        route.zeroReadSessions += 1;
        if (route.zeroReadSessions >= NO_CACHE_VALUE_STREAK_LIMIT && route.noCacheValueSince === undefined) {
          route.noCacheValueSince = now;
        }
        return true;
      });
    } catch {
      // never throws.
    }
  }

  noteCacheRead(provider: string, modelId: string, now: Millis): void {
    try {
      this.mutate(provider, modelId, now, (route) => {
        if (route.zeroReadSessions === 0 && route.noCacheValueSince === undefined) return false;
        route.zeroReadSessions = 0;
        delete route.noCacheValueSince;
        return true;
      });
    } catch {
      // never throws.
    }
  }

  resetNoCacheValue(provider: string, modelId: string, now: Millis): void {
    try {
      this.mutate(provider, modelId, now, (route) => {
        if (route.zeroReadSessions === 0 && route.noCacheValueSince === undefined) return false;
        route.zeroReadSessions = 0;
        delete route.noCacheValueSince;
        return true;
      });
    } catch {
      // never throws.
    }
  }

  noteProbe(provider: string, modelId: string, probe: ProviderRouteProbe, now: Millis): void {
    try {
      this.mutate(provider, modelId, now, (route) => {
        route.probedAt = now;
        route.probe = probe;
        if (probe.write1hLanded) route.write1hLandedAt = now;
        if (probe.immediateHit) {
          route.zeroReadSessions = 0;
          delete route.noCacheValueSince;
        }
        return true;
      });
    } catch {
      // never throws.
    }
  }

  readRoute(provider: string, modelId: string, now: Millis): ProviderRouteEvidence | undefined {
    try {
      const route = this.get(provider, modelId);
      if (route === undefined || isExpired(route, now)) return undefined;
      return { ...route };
    } catch {
      return undefined;
    }
  }
}

/** Test seam / non-singleton construction. */
export function createProviderEvidenceStore(filePath: string): ProviderEvidenceStore {
  return new ProviderEvidenceStoreImpl(filePath);
}

/** Process-wide singleton key (same pattern as ping-ledger.ts / child-registry.ts) — survives `/reload`. */
export const PROVIDER_EVIDENCE_KEY = Symbol.for("pi-subagent:cache-provider-evidence");

/**
 * Mirrors pi's `getAgentDir()` (`$PI_CODING_AGENT_DIR` else `~/.pi/agent`) without a runtime pi
 * import — this module stays pi-free so both main and child sessions (and tests) can use it.
 */
function defaultEvidencePath(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = typeof envDir === "string" && envDir !== "" ? envDir : path.join(homedir(), ".pi", "agent");
  return path.join(agentDir, "cache-provider-evidence.json");
}

/** Lazily builds (or reuses, across `/reload`) the single process-wide store instance. */
export function getProviderEvidenceStore(): ProviderEvidenceStore {
  const g = globalThis as Record<symbol, ProviderEvidenceStore | undefined>;
  const existing = g[PROVIDER_EVIDENCE_KEY];
  if (existing) return existing;
  const created = createProviderEvidenceStore(defaultEvidencePath());
  g[PROVIDER_EVIDENCE_KEY] = created;
  return created;
}

/**
 * Shared usage-observation hook (O1/O3): fold the latest assistant usage entry into the evidence
 * store. Called from the `message_end` handlers of BOTH the main session (`cache-ttl.ts`) and
 * child sessions (`child.ts`).
 *
 * Mode-independence (user ruling 2026-10-12): this runs in EVERY cache-ttl mode including `off`.
 * The evidence records facts about the route ("a 1h write really landed", "a cache read really
 * happened") — `mode=off` only means WE stop writing ttl intents, it does not make observations
 * less true. The O2/O3 consumers decide separately whether to act on the evidence (and the
 * mode=off keepalive exemption lives in the O3 accounting site, not here).
 *
 * Returns which observation fired so the caller can forward the O3 reset to the keepalive
 * service (`noteUsageCacheRead`). Never throws.
 */
export function observeUsageIntoEvidence(
  ctx: LedgerCtxLike | undefined,
  route: { provider: string; modelId: string },
  store: ProviderEvidenceStore | undefined,
  now: Millis,
): { cacheReadObserved: boolean; write1hObserved: boolean } {
  const none = { cacheReadObserved: false, write1hObserved: false };
  if (!store) return none;
  try {
    const usage = readLatestAssistantUsage(ctx);
    if (usage.source !== "usage") return none;
    // Key by the route that PRODUCED the usage entry (its own provider/model), falling back to
    // the caller's current route only for fields the entry doesn't carry.
    const provider = usage.providerId ?? route.provider;
    const modelId = usage.modelId !== "" ? usage.modelId : route.modelId;
    if (!provider || !modelId) return none;
    const write1hObserved = (usage.cacheWrite1h ?? 0) > 0;
    if (write1hObserved) store.noteWrite1hLanded(provider, modelId, now);
    const cacheReadObserved = usage.cacheRead > 0;
    if (cacheReadObserved) store.noteCacheRead(provider, modelId, now);
    return { cacheReadObserved, write1hObserved };
  } catch {
    return none;
  }
}
