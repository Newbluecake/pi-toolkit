/**
 * sysload plan (docs/dev/sysload/plan.md) §7.4/§10 (package P4): pure, DOM-free logic behind
 * the top-bar `LoadPill`/`LoadCard`, the `FleetDrawer` crit banner, and the `GET /api/load/top`
 * client parser. Mirrors `logic/quota.js`'s split (pure helpers here, components only render).
 *
 * Receive-time anchoring (§10 包注 P0·M9, "browser anchors `sinceAgoMs` at frame-receive time"):
 * `LoadWire`/`LoadGateWire` never carry a raw `since` — only `sinceAgoMs` (elapsed AS OF the
 * wire's own `at`) + `at` itself. Trusting `at` directly would assume the agent/hub and browser
 * clocks agree (they don't, verifier 2026-10 precedent on `cache-ttl`/`quota`). Instead
 * `elapsedSinceMs(receivedAt, sinceAgoMs, now)` anchors on the BROWSER's own clock at the
 * instant it received the frame (`receivedAt`, stamped by `@logic/state.js`'s `reduce()` — the
 * same `at` parameter `tool_execution_end`'s `seenAt` already uses) and accumulates purely from
 * browser-clock deltas thereafter: `elapsed(now) = (now - receivedAt) + sinceAgoMs`. Staleness
 * is judged the same way (§7.4: "stale 以客户端收帧时刻计") — never from `load.at`.
 */

/** @typedef {import("@protocol/messages.js").LoadWire} LoadWire */
/** @typedef {import("@protocol/messages.js").LoadGateWire} LoadGateWire */
/** @typedef {import("@protocol/messages.js").LoadLevelWire} LoadLevelWire */
/** @typedef {import("@protocol/messages.js").LoadTopWire} LoadTopWire */
/** @typedef {import("@protocol/messages.js").LoadTopRowWire} LoadTopRowWire */
/** @typedef {import("@protocol/messages.js").LoadTopPidWire} LoadTopPidWire */

/** §7.3: `GET /api/load/top`'s client-side budget — above the hub's own 1.5s overall deadline
 *  (§7.3), same "pad above the server wall-clock" convention as `PREVIEW_PROBE_CLIENT_TIMEOUT_MS`
 *  (5s for a similarly small, bounded endpoint). */
export const LOAD_TOP_CLIENT_TIMEOUT_MS = 5_000;
/** The response is ≤5+5 small rows (§5.5) — generous cap, same order of magnitude as the
 *  smallest existing capped-JSON endpoints. */
export const LOAD_TOP_BODY_MAX_BYTES = 32 * 1024;

/** `level` → the 0..3 ordinal used for comparisons/CSS `data-level` (unknown sorts lowest —
 *  same "never worse than it looks" fail-open posture as everywhere else in this package).
 *  @param {LoadLevelWire | undefined} level @returns {0|1|2|3} */
export function levelRank(level) {
  switch (level) {
    case "warn":
      return 1;
    case "crit":
      return 3;
    case "ok":
    case "unknown":
    default:
      return 0;
  }
}

/** Receive-time-anchored elapsed ms (§10 包注 P0·M9). Any non-finite input ⇒ `undefined` (the
 *  caller omits the duration rather than showing garbage).
 * @param {number | undefined} receivedAt @param {number | undefined} sinceAgoMs @param {number} now
 * @returns {number | undefined} */
export function elapsedSinceMs(receivedAt, sinceAgoMs, now) {
  if (typeof receivedAt !== "number" || !Number.isFinite(receivedAt)) return undefined;
  if (typeof sinceAgoMs !== "number" || !Number.isFinite(sinceAgoMs) || sinceAgoMs < 0) return undefined;
  const elapsed = now - receivedAt + sinceAgoMs;
  return elapsed < 0 ? 0 : elapsed;
}

/** §7.4: a `LoadWire` frame is stale once the browser hasn't received a fresher one within
 *  `4 × intervalMs` of ITS OWN receipt (never `load.at`). `undefined` load/receivedAt ⇒ stale
 *  (nothing to show is the same as "too old to show").
 * @param {LoadWire | undefined} load @param {number | undefined} receivedAt @param {number} now
 * @returns {boolean} */
export function isLoadStale(load, receivedAt, now) {
  if (load === undefined || typeof receivedAt !== "number" || !Number.isFinite(receivedAt)) return true;
  const interval = typeof load.intervalMs === "number" && Number.isFinite(load.intervalMs) ? load.intervalMs : 5_000;
  return now - receivedAt > 4 * interval;
}

/** Strict receive-side validation. Direct-send load frames are untrusted JSON; validate every
 * field consumed by a template so malformed nested values can never reach Vue. Unknown fields
 * remain allowed, but bounded arrays and finite, domain-ranged numbers are not optional. */
const MAX_DISKS = 2;
const MAX_PATH = 4096;
const MAX_LOADAVG = 1e6;
const finite = (v, min = -Infinity, max = Infinity) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const percent = (v) => finite(v, 0, 100);
const threshold = (v) => percent(v);

/** @param {unknown} v @returns {v is LoadLevelWire} */
function isLoadLevel(v) {
  return v === "ok" || v === "warn" || v === "crit" || v === "unknown";
}
function isThresholds(v) {
  if (!record(v)) return false;
  const x = /** @type {any} */ (v);
  return (
    record(x.cpu) &&
    record(x.mem) &&
    record(x.disk) &&
    threshold(x.cpu.warnPercent) &&
    threshold(x.cpu.critPercent) &&
    threshold(x.cpu.psiWarnPercent) &&
    threshold(x.cpu.psiCritPercent) &&
    threshold(x.mem.warnAvailPercent) &&
    threshold(x.mem.critAvailPercent) &&
    threshold(x.disk.warnFreePercent) &&
    threshold(x.disk.critFreePercent) &&
    finite(x.disk.critFreeGiB, 0)
  );
}
function isCpu(v) {
  if (!record(v)) return false;
  const x = /** @type {any} */ (v);
  return (
    percent(x.busyPct) &&
    (x.psiPct === undefined || percent(x.psiPct)) &&
    isLoadLevel(x.level) &&
    finite(x.cores, 1, 4096)
  );
}
function isMem(v) {
  if (!record(v)) return false;
  const x = /** @type {any} */ (v);
  return percent(x.usedPct) && percent(x.availPct) && isLoadLevel(x.level);
}
function isIo(v) {
  return record(v) && /** @type {any} */ (v.psiPct === undefined || percent(/** @type {any} */ (v).psiPct));
}
function isDisk(v) {
  if (!record(v)) return false;
  const x = /** @type {any} */ (v);
  return (
    (x.label === "~" || x.label === "/") &&
    typeof x.path === "string" &&
    x.path.length <= MAX_PATH &&
    percent(x.usedPct) &&
    finite(x.freeBytes, 0) &&
    finite(x.totalBytes, 0) &&
    isLoadLevel(x.level) &&
    (x.skipped === undefined || x.skipped === "remote" || x.skipped === "unresolved")
  );
}

/** @param {unknown} d @returns {d is LoadWire} */
export function isLoadWireLike(d) {
  if (!record(d)) return false;
  const w = /** @type {any} */ (d);
  if (
    w.v !== 1 ||
    !finite(w.at) ||
    !finite(w.intervalMs, 1, 86_400_000) ||
    w.scope !== "host" ||
    !isLoadLevel(w.level) ||
    !isThresholds(w.thresholds)
  )
    return false;
  if (w.sinceAgoMs !== undefined && !finite(w.sinceAgoMs, 0)) return false;
  if (w.cpu !== undefined && !isCpu(w.cpu)) return false;
  if (w.mem !== undefined && !isMem(w.mem)) return false;
  if (w.io !== undefined && !isIo(w.io)) return false;
  if (w.disks !== undefined && (!Array.isArray(w.disks) || w.disks.length > MAX_DISKS || !w.disks.every(isDisk)))
    return false;
  if (
    w.loadavg !== undefined &&
    (!Array.isArray(w.loadavg) || w.loadavg.length !== 3 || !w.loadavg.every((n) => finite(n, 0, MAX_LOADAVG)))
  )
    return false;
  return true;
}

/** Mirrors the strict nested validation for the session's StatusInfo.loadGate slot. */
export function isLoadGateWireLike(d) {
  if (!record(d)) return false;
  const g = /** @type {any} */ (d);
  return (
    typeof g.gating === "boolean" &&
    isLoadLevel(g.level) &&
    finite(g.at) &&
    (g.sinceAgoMs === undefined || finite(g.sinceAgoMs, 0))
  );
}

/** `status.loadGate` ⇒ a validated `LoadGateWire`, or `undefined` (absent / malformed — same
 *  "drop, don't guess" rule `todoFromStatus` applies to `status.todo`).
 * @param {unknown} status @returns {LoadGateWire | undefined} */
export function loadGateFromStatus(status) {
  const g = status !== null && typeof status === "object" ? /** @type {any} */ (status).loadGate : undefined;
  return isLoadGateWireLike(g) ? g : undefined;
}

const GIB = 2 ** 30;

/** Bytes → a `"112G"` / `"3.1G"` GiB label (mockup tweak ②: disk row shows free space in GiB).
 *  ≥10 GiB rounds to a whole number (matches the mockup's `112G`); <10 GiB keeps one decimal
 *  (matches `3.1G`) so a small-disk crit reading doesn't collapse to a misleadingly round number.
 *  Non-finite/negative ⇒ `undefined` (caller omits the annex). @param {number | undefined} bytes
 *  @returns {string | undefined} */
export function fmtGiB(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return undefined;
  const gib = bytes / GIB;
  const text = gib >= 10 ? Math.round(gib).toString() : (Math.round(gib * 10) / 10).toString();
  return `${text}G`;
}

/** Rounded integer percent; non-finite ⇒ 0 — same defensive wire policy `logic/quota.js` uses
 *  everywhere (never `NaN%`). @param {number | undefined} pct @returns {number} */
export function pct(pct) {
  return typeof pct === "number" && Number.isFinite(pct) ? Math.round(pct) : 0;
}

/**
 * Pill view-model (§7.4/视觉稿: `CPU 72% · MEM 81% · DISK 64%`, mobile shows only the worst
 * segment). `undefined`/stale ⇒ `null` (caller renders no pill — §8 I1/I8: no data, no DOM).
 * @param {LoadWire | undefined} load @param {number | undefined} receivedAt @param {number} now
 * @returns {{
 *   level: 0|1|2|3,
 *   segs: { key: "cpu"|"mem"|"disk", level: 0|1|2|3, text: string }[],
 *   worstKey: "cpu"|"mem"|"disk" | undefined,
 * } | null}
 */
export function pillView(load, receivedAt, now) {
  if (load === undefined || isLoadStale(load, receivedAt, now)) return null;
  /** @type {{ key: "cpu"|"mem"|"disk", level: 0|1|2|3, text: string }[]} */
  const segs = [];
  if (load.cpu !== undefined) {
    segs.push({ key: "cpu", level: levelRank(load.cpu.level), text: `CPU ${pct(load.cpu.busyPct)}%` });
  }
  if (load.mem !== undefined) {
    segs.push({ key: "mem", level: levelRank(load.mem.level), text: `MEM ${pct(load.mem.usedPct)}%` });
  }
  const disks = Array.isArray(load.disks) ? load.disks : [];
  if (disks.length > 0) {
    let worstDisk = disks[0];
    for (const dsk of disks) {
      if (levelRank(dsk.level) > levelRank(worstDisk.level)) worstDisk = dsk;
    }
    segs.push({ key: "disk", level: levelRank(worstDisk.level), text: `DISK ${pct(worstDisk.usedPct)}%` });
  }
  if (segs.length === 0) return null;
  let worst = segs[0];
  for (const seg of segs) {
    if (seg.level > worst.level) worst = seg;
  }
  return { level: levelRank(load.level), segs, worstKey: worst.key };
}

/** One `LoadTopRowWire` → the comm-aggregated display line, pre-split into the headline
 *  (`segText`) and the expandable per-pid breakdown (already capped ≤8 by the wire, §5.5).
 *  `kind` picks the value's unit: `"cpu"` renders `cpuPct` as `NNN%` (can exceed 100, §5.5);
 *  `"rss"` renders `rssBytes` via `fmtGiB`/MiB fallback.
 * @param {LoadTopRowWire} row @param {"cpu"|"rss"} kind
 * @returns {{ comm: string, count: number, valueText: string, avg: boolean, pids: { pid: number, valueText: string }[] }}
 */
export function topRowView(row, kind) {
  const valueText = kind === "cpu" ? `${pct(row.cpuPct)}%` : fmtBytesShort(row.rssBytes);
  return {
    comm: row.comm,
    count: row.count,
    valueText,
    avg: row.avg === true,
    pids: row.pids.map((p) => ({
      pid: p.pid,
      valueText: kind === "cpu" ? `${pct(p.cpuPct)}%` : fmtBytesShort(p.rssBytes),
    })),
  };
}

/** Bytes → `"1.8G"` / `"640M"` (mockup's RSS unit convention: GiB once ≥1 GiB, else MiB).
 *  Non-finite/negative ⇒ `"—"`. @param {number | undefined} bytes @returns {string} */
export function fmtBytesShort(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes >= GIB) {
    const gib = bytes / GIB;
    return `${gib >= 10 ? Math.round(gib) : Math.round(gib * 10) / 10}G`;
  }
  const mib = bytes / 2 ** 20;
  return `${mib >= 10 ? Math.round(mib) : Math.round(mib * 10) / 10}M`;
}

/**
 * FleetDrawer crit banner view-model (§6.4/视觉稿 fleet-crit mockup + tweak ③ "duration stays on
 * ONE line"). `undefined`/not-gating ⇒ `null` (no banner — I1/I8: a session whose load feature
 * is off, not sampled yet, or not currently gating renders nothing extra).
 * @param {LoadGateWire | undefined} loadGate @param {number | undefined} receivedAt @param {number} now
 * @returns {{ level: "warn"|"crit", durationText: string | undefined } | null}
 */
export function bannerView(loadGate, receivedAt, now) {
  if (loadGate === undefined || loadGate.gating !== true) return null;
  if (loadGate.level !== "warn" && loadGate.level !== "crit") return null;
  const elapsed = elapsedSinceMs(receivedAt, loadGate.sinceAgoMs, now);
  return { level: loadGate.level, durationText: elapsed === undefined ? undefined : fmtDurationShort(elapsed) };
}

/** `ms` → a compact English duration token (AGENTS.md inline-marker rule: English-only) —
 *  `"45s"` under a minute, `"2m"` / `"1h12m"` beyond. Mirrors the mockup's `(2m)` annex.
 * @param {number} ms @returns {string} */
export function fmtDurationShort(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
}

// ---------------------------------------------------------------------------
// `GET /api/load/top` response parsing (package P4, §7.1/§7.3/§10 包注 P4·M10b: logic clients —
// and by extension their wire parsing — are P4-domain; there is no dedicated protocol-level
// parser for `LoadTopWire` the way `parseWtGraphPayload` exists for worktree-graph, since this
// endpoint's body never rides a typebox-validated envelope upstream).
// ---------------------------------------------------------------------------

/** @param {unknown} v @returns {v is LoadTopPidWire} */
function isTopPid(v) {
  if (!record(v)) return false;
  const p = /** @type {any} */ (v);
  return finite(p.pid, 1, 2 ** 31 - 1) && finite(p.cpuPct, 0) && finite(p.rssBytes, 0);
}

/** @param {unknown} v @returns {v is LoadTopRowWire} */
function isTopRow(v) {
  if (v === null || typeof v !== "object") return false;
  const r = /** @type {Record<string, unknown>} */ (v);
  if (typeof r.comm !== "string" || r.comm.length > 256) return false;
  if (!finite(r.count, 1, 1e6)) return false;
  if (!finite(r.cpuPct, 0) || !finite(r.rssBytes, 0)) return false;
  if (!Array.isArray(r.pids) || r.pids.length > 8 || !r.pids.every(isTopPid)) return false;
  return true;
}

/**
 * `GET /api/load/top`'s JSON body → a validated `LoadTopWire`, or `null` (the contract gate —
 * `token-client.js`/`password-client.js`'s shared `wtdiffGet`-style flow maps `null` to the
 * local `E_BAD_RESPONSE` status-0 outcome, same convention as `parseWtDiffFileList`/
 * `parseWtGraphPayload`). Unknown extra top-level fields pass through (open posture); `byCpu`/
 * `byRss` themselves are structurally gated row-by-row.
 * @param {unknown} raw @returns {LoadTopWire | null}
 */
export function parseLoadTopWire(raw) {
  if (raw === null || typeof raw !== "object") return null;
  const w = /** @type {Record<string, unknown>} */ (raw);
  if (typeof w.at !== "number" || !Number.isFinite(w.at)) return null;
  if (!Array.isArray(w.byCpu) || w.byCpu.length > 5 || !w.byCpu.every(isTopRow)) return null;
  if (!Array.isArray(w.byRss) || w.byRss.length > 5 || !w.byRss.every(isTopRow)) return null;
  /** @type {LoadTopWire} */
  const out = { at: w.at, byCpu: w.byCpu, byRss: w.byRss };
  if (w.partial === true) out.partial = true;
  return out;
}
