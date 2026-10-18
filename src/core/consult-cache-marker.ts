/**
 * Consult cache warm/cold display marker (cache-thread plan §5.3, package U).
 *
 * Pure formatter, no pi imports (src/core rules): turns the frozen A-package
 * diagnostics (`RunDiagnostics.consultCache` / `.consultThread`, see
 * `src/core/types.ts` and docs/dev/consult/A-report.md) into the compact
 * English display token the user ruling demands — `warm·hit 96%`,
 * `cold·miss 3%`, `?·partial 41%`, thread prefix `t#2`, pending first
 * response `warm·…`, degraded suffix `·degraded`, unusable metric `?·n/a`.
 *
 * English compact tokens only (AGENTS.md UI text split): this string lands in
 * TUI fleet rows, web FleetTree rows, the consult record page and
 * `get_subagent_result` text — all inline-marker surfaces.
 *
 * Every consumer renders `undefined` as "nothing new" (byte-identical output
 * for runs without the fields — old runs, non-consult runs, pre-feature
 * agents). Inputs are display-only projections of persisted JSON, so unknown
 * enum values degrade to `?`/omit instead of throwing.
 */
import type { ConsultCacheDiagnostics, ConsultThreadRef } from "./types.js";

/** Display-only subset the marker needs (keeps tests/journal fixtures cheap). */
export interface ConsultCacheMarkerInput {
  predicted?: { state: unknown };
  first?: { label: unknown; readShare?: unknown; degraded?: unknown };
  thread?: { seq: unknown };
}

/** Max rendered thread id / prediction reason (bounded display surface). */
const MAX_THREAD_ID_CHARS = 24;
const MAX_REASON_CHARS = 32;

function isWarmState(value: unknown): value is "warm" | "cold" {
  return value === "warm" || value === "cold";
}

function isCacheLabel(value: unknown): value is "hit" | "partial" | "miss" | "n/a" {
  return value === "hit" || value === "partial" || value === "miss" || value === "n/a";
}

/** `96%` from a 0..1 share; undefined for null/absent/unusable values. */
function readSharePercent(readShare: unknown): string | undefined {
  if (typeof readShare !== "number" || !Number.isFinite(readShare)) return undefined;
  const percent = Math.round(readShare * 100);
  return `${Math.min(100, Math.max(0, percent))}%`;
}

/**
 * The compact marker (plan §5.3 golden): `[t#n ]<warm|cold|?>·<first>[·degraded]`.
 * - prediction only (first response pending): `warm·…`
 * - measured: `warm·hit 96%` / `cold·miss 3%` / `?·partial 41%`
 * - first response present but unusable metric: `?·n/a`
 * - degraded (OAuth limit / unverified M4): appended `·degraded`
 * - thread association: prefix `t#2 `; a thread without cache facts renders `t#2`
 * Returns undefined when neither consultCache nor consultThread carries
 * anything displayable.
 */
export function consultCacheMarker(input: ConsultCacheMarkerInput): string | undefined {
  const threadSeq = input.thread?.seq;
  const threadPrefix =
    typeof threadSeq === "number" && Number.isInteger(threadSeq) && threadSeq >= 1 ? `t#${threadSeq}` : undefined;
  // Absence rule: nothing displayable at all ⇒ undefined (consumers render
  // nothing new and stay byte-identical for runs without the fields).
  if (input.predicted === undefined && input.first === undefined) return threadPrefix;
  const predicted = isWarmState(input.predicted?.state) ? input.predicted.state : "?";
  let body: string;
  const first = input.first;
  if (first === undefined) {
    body = `${predicted}·…`;
  } else if (!isCacheLabel(first.label)) {
    body = `${predicted}·…`;
  } else if (first.label === "n/a") {
    body = `${predicted}·n/a`;
  } else {
    const percent = readSharePercent(first.readShare);
    body = `${predicted}·${first.label}${percent === undefined ? "" : ` ${percent}`}`;
  }
  if (first?.degraded === true) body = `${body}·degraded`;
  // A bare thread association (no cache facts yet recorded) still displays.
  return threadPrefix === undefined ? body : `${threadPrefix} ${body}`;
}

/**
 * Convenience: project a run's own diagnostics (`diag.consultCache` +
 * `diag.consultThread`) through {@link consultCacheMarker}. Accepts the bare
 * diag object; both fields optional, absent ⇒ undefined (render nothing).
 */
export function consultCacheMarkerOfDiag(
  diag: { consultCache?: ConsultCacheDiagnostics; consultThread?: ConsultThreadRef } | undefined,
): string | undefined {
  if (diag === undefined) return undefined;
  return consultCacheMarker({
    ...(diag.consultCache === undefined
      ? {}
      : {
          predicted: { state: diag.consultCache.predicted?.state },
          ...(diag.consultCache.first === undefined
            ? {}
            : {
                first: {
                  label: diag.consultCache.first.label,
                  readShare: diag.consultCache.first.readShare,
                  ...(diag.consultCache.first.degraded === true ? { degraded: true as const } : {}),
                },
              }),
        }),
    ...(diag.consultThread === undefined ? {} : { thread: { seq: diag.consultThread.seq } }),
  });
}

function clipToken(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The `get_subagent_result` consult section (plan §5.3): one English line
 * carrying prediction, measured first-request result, anchor placement state
 * and thread association — more detail than the compact marker, still a
 * single bounded line appended to the result text. undefined when the run
 * carries none of the fields (byte-identical result text for every other
 * run).
 */
export function formatConsultCacheLine(
  diag: { consultCache?: ConsultCacheDiagnostics; consultThread?: ConsultThreadRef } | undefined,
): string | undefined {
  if (diag === undefined) return undefined;
  const cache = diag.consultCache;
  const thread = diag.consultThread;
  if (cache === undefined && thread === undefined) return undefined;
  const parts: string[] = [];
  if (cache !== undefined) {
    const state = isWarmState(cache.predicted?.state) ? cache.predicted.state : "unknown";
    const reason =
      typeof cache.predicted?.reason === "string" && cache.predicted.reason !== ""
        ? ` (${clipToken(cache.predicted.reason, MAX_REASON_CHARS)})`
        : "";
    parts.push(`predicted ${state}${reason}`);
    const first = cache.first;
    if (first === undefined) {
      parts.push("first response pending");
    } else {
      const label = isCacheLabel(first.label) ? first.label : "n/a";
      const percent = readSharePercent(first.readShare);
      parts.push(`first request ${label}${percent === undefined ? "" : ` ${percent} read share`}`);
      if (typeof first.anchor === "string" && first.anchor && first.anchor !== "n/a") {
        parts.push(`anchor ${clipToken(first.anchor, MAX_REASON_CHARS)}${first.degraded === true ? ", degraded" : ""}`);
      }
    }
  }
  if (thread !== undefined) {
    const seq = typeof thread.seq === "number" && Number.isInteger(thread.seq) && thread.seq >= 1 ? thread.seq : "?";
    const id = typeof thread.threadId === "string" ? clipToken(thread.threadId, MAX_THREAD_ID_CHARS) : "?";
    parts.push(`thread ${id} #${seq}`);
  }
  return parts.length > 0 ? `Consult cache: ${parts.join("; ")}` : undefined;
}
