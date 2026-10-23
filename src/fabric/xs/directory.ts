import { XS_LIST_MAX_ROWS, type XsSessionRowWire } from "../../web-hub/protocol/xs.js";

/**
 * fabric reply-plan §9.2 (package M): the @mention session DIRECTORY CACHE — a pi-free,
 * closure-owned view over the hub's cross-session list, shared by @session routing (§9.1's
 * unique-exact-hit condition ④) and @ completion (§9.5). All ASSEMBLY belongs to MW (review
 * r1 #13): the data source and the membership/identity view are injected ports, so this module
 * never imports the sender, the stack or pi.
 *
 * Rules (reply-plan §9.2, frozen):
 *  - `rows()`/`lookupExact()` return nothing when the data is older than `staleMs` (default
 *    10 min — RR8: a stale/empty cache merely passes the bare @name form through to pi; the
 *    explicit `@session:` form is never affected) or when the session is not joined.
 *  - `refresh(reason)` is single-flight, throttled to one attempt per `refreshMinIntervalMs`
 *    (default 30 s), bounded by a `fetchDeadlineMs` (default 3 s, unref'd timer) and NEVER
 *    throws: a failed/timed-out fetch keeps the previous rows. A no-op when not joined.
 *  - the cache is CLEARED whenever the source's identity key changes — epoch bump
 *    (attach/join/leave), `/new` (session replacement) or leaving (view ⇒ undefined).
 *  - `ingest(rows)` installs fresh rows directly (a completed-refresh semantic: stamps data
 *    freshness AND the refresh-interval gate).
 *
 * Timer discipline: the one deadline timer per in-flight fetch is unref'd and self-clears;
 * there are no intervals and no state at module scope (this module can be re-imported on
 * /reload — every createXsDirectoryCache call builds fresh closure state).
 */

/** One directory row — the hub list projection verbatim (`XsSessionRowWire`). */
export type XsDirectoryRow = XsSessionRowWire;

/**
 * The injected data source (MW wires the real one over the fabric sender's hub list; tests
 * fake it). Both members are consulted LIVE on every cache access — join state and identity
 * are call-time facts, never assembly-time decisions (§9.3).
 */
export interface XsDirectorySourcePort {
  /**
   * Live membership/identity view: `undefined` ⇔ not joined (⇒ `rows()` `[]`, `refresh`
   * no-op). The `key` MUST change on every epoch bump (attach/join/leave) and on `/new`
   * (session replacement) — any key change clears the cache (§9.2). Channel-plan §4.3: the
   * optional `channels` (the local link channels) is folded into the identity — a local channel
   * change clears the cache; OTHER sessions changing channels does not (RR8: bare-name
   * uniqueness is only "unique within the last snapshot", ≤10 min; the hub re-resolves the
   * chosen ref authoritatively at send time). A throwing `view()`
   * counts as not-joined (fail closed — lookups find nothing, nothing is fetched).
   */
  view(): { key: string; channels?: readonly string[] } | undefined;
  /**
   * One hub list round trip. Resolves the rows (an empty array is valid fresh data) or
   * `undefined` on ANY failure — transport, off, error — in which case the cache keeps the
   * old rows. May reject; rejection is treated exactly like `undefined`.
   */
  fetch(): Promise<readonly XsDirectoryRow[] | undefined>;
}

export interface XsDirectoryCache {
  /** True when the cached snapshot has exactly `XS_LIST_MAX_ROWS` rows (possibly truncated, §4.3). */
  truncated(): boolean;
  /** Fresh rows; `[]` when stale (>10 min), cleared, disposed, or not joined. */
  rows(): readonly XsDirectoryRow[];
  /**
   * Reply-plan §9.1 condition ④: the UNIQUE row whose `name` OR `ref` equals `name` exactly.
   * `undefined` on zero hits, 2+ hits (name/ref ambiguity included), staleness, or not joined.
   * Channel-plan §4.3: also `undefined` when the snapshot is `truncated` (exactly
   * `XS_LIST_MAX_ROWS` rows — the hub list may have been cut, so uniqueness is unprovable and the
   * bare name is released to pi). Uniqueness is judged over the rows as given — the hub already
   * restricted them to the visible channel union.
   */
  lookupExact(name: string): XsDirectoryRow | undefined;
  /**
   * Alias-plan §5.4 step 4 (AL5b): the UNIQUE fresh row whose canonical `alias` equals `alias`
   * (caller normalizes first). Aliases are hub-globally unique, so a hit is EXEMPT from the
   * 20-row truncation rule (unlike `lookupExact`). `undefined` on 0 / 2+ hits, staleness, not
   * joined. The result only decides WHETHER to intercept — the send resolves authoritatively.
   */
  lookupAlias(alias: string): XsDirectoryRow | undefined;
  /** Single-flight bounded refresh; never throws; no-op when not joined. */
  refresh(reason: string): Promise<void>;
  /** Install fresh rows directly (marks data fresh; arms the refresh-interval gate). */
  ingest(rows: readonly XsDirectoryRow[]): void;
  dispose(): void;
}

export interface XsDirectoryDeps {
  source: XsDirectorySourcePort;
  now(): number;
  /** Minimum spacing between refresh ATTEMPTS (default 30 s). */
  refreshMinIntervalMs?: number;
  /** Per-fetch deadline (default 3 s). */
  fetchDeadlineMs?: number;
  /** Data age ceiling (default 10 min). */
  staleMs?: number;
}

export const XS_DIRECTORY_REFRESH_MIN_INTERVAL_MS = 30_000;
export const XS_DIRECTORY_FETCH_DEADLINE_MS = 3_000;
export const XS_DIRECTORY_STALE_MS = 10 * 60_000;

/** One bounded fetch: `undefined` on deadline, rejection or a synchronous throw. */
async function fetchWithDeadline(
  fetch: () => Promise<readonly XsDirectoryRow[] | undefined>,
  ms: number,
): Promise<readonly XsDirectoryRow[] | undefined> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (rows: readonly XsDirectoryRow[] | undefined): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(rows ?? undefined);
    };
    timer = setTimeout(() => finish(undefined), ms);
    timer.unref();
    try {
      Promise.resolve(fetch()).then(
        (rows) => finish(rows),
        () => finish(undefined),
      );
    } catch {
      finish(undefined);
    }
  });
}

export function createXsDirectoryCache(deps: XsDirectoryDeps): XsDirectoryCache {
  const refreshMinIntervalMs = deps.refreshMinIntervalMs ?? XS_DIRECTORY_REFRESH_MIN_INTERVAL_MS;
  const fetchDeadlineMs = deps.fetchDeadlineMs ?? XS_DIRECTORY_FETCH_DEADLINE_MS;
  const staleMs = deps.staleMs ?? XS_DIRECTORY_STALE_MS;

  let rows: XsDirectoryRow[] = [];
  let hasData = false;
  let updatedAt = 0;
  let lastRefreshAt = Number.NEGATIVE_INFINITY;
  let lastKey: string | undefined;
  let sawKey = false;
  let inflight: Promise<void> | undefined;
  let disposed = false;

  const viewKey = (): string | undefined => {
    try {
      const v = deps.source.view();
      if (v === undefined) return undefined;
      return v.channels === undefined ? v.key : `${v.key}\u0000${v.channels.join(",")}`;
    } catch {
      return undefined;
    }
  };

  /** §9.2 clear rule: any identity change (epoch bump / leave / `/new`) empties the cache and
   *  re-arms the refresh throttle — the new identity has not refreshed yet. */
  const syncView = (): string | undefined => {
    const key = viewKey();
    if (!sawKey || key !== lastKey) {
      sawKey = true;
      lastKey = key;
      rows = [];
      hasData = false;
      updatedAt = 0;
      lastRefreshAt = Number.NEGATIVE_INFINITY;
    }
    return key;
  };

  const fresh = (): boolean => hasData && deps.now() - updatedAt <= staleMs;

  return {
    truncated() {
      if (disposed) return false;
      const key = syncView();
      return key !== undefined && fresh() && rows.length >= XS_LIST_MAX_ROWS;
    },
    rows() {
      if (disposed) return [];
      const key = syncView();
      if (key === undefined || !fresh()) return [];
      return [...rows];
    },
    lookupExact(name) {
      if (disposed) return undefined;
      const key = syncView();
      if (key === undefined || !fresh()) return undefined;
      if (rows.length >= XS_LIST_MAX_ROWS) return undefined; // §4.3 truncated ⇒ uniqueness unprovable
      const hits = rows.filter((row) => row.name === name || row.ref === name);
      return hits.length === 1 ? hits[0] : undefined;
    },
    lookupAlias(alias) {
      if (disposed || alias.length === 0) return undefined;
      const key = syncView();
      if (key === undefined || !fresh()) return undefined;
      const hits = rows.filter((row) => row.alias === alias);
      return hits.length === 1 ? hits[0] : undefined;
    },
    refresh(_reason: string) {
      if (disposed) return Promise.resolve();
      const key = syncView();
      if (key === undefined) return Promise.resolve(); // not joined ⇒ refresh does nothing
      if (inflight !== undefined) return inflight; // single-flight
      if (deps.now() - lastRefreshAt < refreshMinIntervalMs) return Promise.resolve();
      lastRefreshAt = deps.now();
      inflight = (async () => {
        const fetched = await fetchWithDeadline(() => deps.source.fetch(), fetchDeadlineMs);
        if (disposed) return;
        if (viewKey() !== key) return; // identity changed mid-flight — keep the cleared state
        if (fetched !== undefined) {
          rows = [...fetched];
          hasData = true;
          updatedAt = deps.now();
        }
      })().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
    ingest(input) {
      if (disposed) return;
      const key = syncView();
      if (key === undefined) return; // not joined — nothing to install for
      rows = [...input];
      hasData = true;
      updatedAt = deps.now();
      lastRefreshAt = deps.now();
    },
    dispose() {
      disposed = true;
      rows = [];
      hasData = false;
      updatedAt = 0;
      inflight = undefined;
    },
  };
}
