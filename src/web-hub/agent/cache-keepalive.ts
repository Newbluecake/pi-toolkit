/**
 * cache-keepalive-web plan §3.2 (P-A): pure projection of the prompt-cache keepalive state onto the
 * `StatusInfo.cacheKeepalive` wire slot. No pi imports. The wire deliberately carries no `armed`
 * (D11) and the fingerprint excludes `at`, so only real state changes (and the one-shot
 * `retryAt`-existence flip at cooldown expiry) cause a status frame.
 */
import {
  LINE_KEY_WILDCARD,
  MAX_LINE_STATES,
  buildCacheStatusSnapshot,
  isTransientUnproven,
  isKeepaliveWindowEnded,
  pingSegmentParts,
  type CacheDisplayMode,
  type KeepaliveReport,
  type LineState,
  type UnprovenKind,
} from "../../cache-ttl/keepalive-state.js";
import { truncateText } from "../protocol/keys.js";
import type { CacheKeepaliveLineWire, CacheKeepaliveWire } from "../protocol/messages.js";

export interface CacheKeepaliveInput {
  report: KeepaliveReport;
  mode: CacheDisplayMode;
  dirty: boolean;
}

export const CACHE_KEEPALIVE_WIRE_BUDGET_BYTES = 8 << 10;
export const CACHE_KEEPALIVE_LABEL_MAX_BYTES = 128;
export const CACHE_KEEPALIVE_LABEL_SHRUNK_BYTES = 48;
export const CACHE_KEEPALIVE_MAX_ROWS = MAX_LINE_STATES;
const REASON_MAX_BYTES = 64;
const KIND_MAX_BYTES = 32;
const TEXT_MAX_BYTES = 200;

const fin = (n: number): number => (Number.isFinite(n) ? n : 0);
const clip = (s: string, max: number): string => truncateText(s, max).text;
const httpCode = (n: unknown): number | undefined =>
  typeof n === "number" && Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;

interface Row {
  key: string;
  rec: LineState;
}

function lineRows(report: KeepaliveReport, now: number, labelMax: number): CacheKeepaliveLineWire[] {
  const t = report.now ?? now;
  const rows: Row[] = Object.entries(report.session.lineStates)
    .filter(([, rec]) => rec.open || rec.trips > 0 || rec.consecutive > 0)
    .map(([key, rec]) => ({ key, rec }));
  rows.sort((a, b) => {
    if (a.rec.open !== b.rec.open) return a.rec.open ? -1 : 1;
    const ac = a.key === report.currentLineKey;
    const bc = b.key === report.currentLineKey;
    if (ac !== bc) return ac ? -1 : 1;
    return b.rec.updatedAt - a.rec.updatedAt;
  });
  return rows.map(({ key, rec }) => {
    const row: CacheKeepaliveLineWire = {
      label: clip(rec.label, labelMax),
      open: rec.open,
      trips: fin(rec.trips),
    };
    const status = httpCode(rec.status);
    if (status !== undefined) row.status = status;
    if (rec.open && key !== LINE_KEY_WILDCARD && rec.resetEligibleAt !== undefined && rec.resetEligibleAt > t)
      row.retryAt = rec.resetEligibleAt;
    if (key === report.currentLineKey) row.current = true;
    if (key === LINE_KEY_WILDCARD) row.wildcard = true;
    return row;
  });
}

export function cacheKeepaliveWireBytes(wire: CacheKeepaliveWire): number {
  return Buffer.byteLength(JSON.stringify(wire), "utf8");
}

/** undefined ⇒ the field is absent altogether (byte-equal to the pre-feature status shape). */
export function projectCacheKeepalive(
  input: CacheKeepaliveInput | undefined,
  now: number,
): CacheKeepaliveWire | undefined {
  if (input === undefined) return undefined;
  const { report, mode, dirty } = input;
  const snapshot = buildCacheStatusSnapshot({ mode, dirty, report });
  const s = report.session;
  if (
    report.enabled &&
    snapshot.segments.length === 0 &&
    Object.keys(s.lineStates).length === 0 &&
    Object.keys(s.noUsageStates).length === 0 &&
    s.disabled === undefined &&
    s.lastUnproven === undefined &&
    report.lastPingDiagnostics === undefined &&
    s.pings === 0
  )
    return undefined;

  const wire: CacheKeepaliveWire = {
    v: 1,
    at: now,
    mode,
    enabled: report.enabled,
    window: { pings: fin(report.window.pings), max: fin(report.config.maxPings) },
    session: {
      pings: fin(s.pings),
      cacheReadTokens: fin(s.cacheReadTokens),
      avoidedMissTokens: fin(s.avoidedMissTokens),
      loadBearingWindows: fin(s.loadBearingWindows),
      unnecessaryWindows: fin(s.unnecessaryWindows),
      discardedWindows: fin(s.discardedWindows),
    },
    lines: [],
  };
  if (report.config.maxPingsSource !== undefined) wire.window.maxSource = report.config.maxPingsSource;
  if (isKeepaliveWindowEnded(report.window)) wire.window.ended = true;
  if (dirty) wire.dirty = true;
  const modeSeg = snapshot.segments.find((x) => x.kind === "mode");
  if (modeSeg !== undefined) wire.modeText = clip(modeSeg.text, TEXT_MAX_BYTES);
  if (report.costUsd !== undefined && Number.isFinite(report.costUsd)) wire.session.costUsd = report.costUsd;

  const parts = pingSegmentParts(report);
  if (parts !== undefined) {
    const ping: NonNullable<CacheKeepaliveWire["ping"]> = {
      text: clip(parts.text, TEXT_MAX_BYTES),
      state: clip(parts.state, KIND_MAX_BYTES),
    };
    if (parts.retryAt !== undefined) ping.retryAt = parts.retryAt;
    if (parts.tail !== undefined) ping.tail = clip(parts.tail, KIND_MAX_BYTES);
    wire.ping = ping;
  }

  const diag = report.lastPingDiagnostics;
  if (diag !== undefined) {
    const kind = clip(diag.outcomeKind, KIND_MAX_BYTES);
    const lp: NonNullable<CacheKeepaliveWire["lastPing"]> = { at: diag.at, kind };
    const status = kind === "http" ? httpCode(diag.httpStatus) : undefined;
    if (status !== undefined) lp.status = status;
    if (kind !== "proven-hit") lp.transient = isTransientUnproven(kind as UnprovenKind, status);
    if (typeof diag.attempts === "number" && Number.isFinite(diag.attempts))
      lp.attempts = Math.min(999, Math.max(1, Math.trunc(diag.attempts)));
    wire.lastPing = lp;
  } else if (s.lastUnproven !== undefined) {
    const kind = clip(s.lastUnproven.kind, KIND_MAX_BYTES);
    wire.lastPing = { at: s.lastUnproven.at, kind, transient: isTransientUnproven(kind as UnprovenKind) };
  }

  if (s.disabled !== undefined) {
    const d: NonNullable<CacheKeepaliveWire["disabled"]> = {
      reason: clip(s.disabled.reason, REASON_MAX_BYTES),
      at: s.disabled.at,
    };
    const hs = httpCode(s.disabled.httpStatus);
    if (hs !== undefined) d.httpStatus = hs;
    if (s.disabled.transient === true) d.transient = true;
    wire.disabled = d;
  }

  // Rows + budget ladder: shrink labels → drop history rows → drop open rows (tail first).
  let rows = lineRows(report, now, CACHE_KEEPALIVE_LABEL_MAX_BYTES);
  let omitted = 0;
  if (rows.length > CACHE_KEEPALIVE_MAX_ROWS) {
    omitted += rows.length - CACHE_KEEPALIVE_MAX_ROWS;
    rows = rows.slice(0, CACHE_KEEPALIVE_MAX_ROWS);
  }
  const build = (): number => {
    wire.lines = rows;
    if (omitted > 0) wire.omitted = omitted;
    else delete wire.omitted;
    return cacheKeepaliveWireBytes(wire);
  };
  if (build() > CACHE_KEEPALIVE_WIRE_BUDGET_BYTES) {
    rows = lineRows(report, now, CACHE_KEEPALIVE_LABEL_SHRUNK_BYTES).slice(0, rows.length);
    while (build() > CACHE_KEEPALIVE_WIRE_BUDGET_BYTES && rows.length > 0) {
      let idx = -1;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]!.open === false) {
          idx = i;
          break;
        }
      }
      rows.splice(idx >= 0 ? idx : rows.length - 1, 1);
      omitted++;
    }
    build();
  }
  return wire;
}

/** 1Hz gate: `""` when absent, else the wire JSON with `at` zeroed (key order preserved). */
export function cacheKeepaliveFingerprint(wire: CacheKeepaliveWire | undefined): string {
  if (wire === undefined) return "";
  return JSON.stringify({ ...wire, at: 0 });
}
