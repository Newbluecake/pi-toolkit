/**
 * Start/end time token for fleet + bash rows (2026-10-18 user pick, preview option C).
 *
 * `text` — the visible token, same date convention as the transcript message headers
 * (`formatDateTime(ms, "zh-CN")` → `2026年10月18日 22:41`):
 *   running (no end)      `2026年10月18日 22:41`
 *   finished, same day    `2026年10月18日 22:41 → 22:47`   (end abbreviated to HH:MM)
 *   finished, other day   `2026年10月17日 23:58 → 2026年10月18日 00:12`
 * `title` — tooltip, full local date-time of both ends: `YYYY-MM-DD HH:MM:SS → YYYY-MM-DD HH:MM:SS`
 * (start only while running).
 *
 * Pure: no "now" is involved (same-day compares start with end, never with the clock). The
 * optional `timeZone` (IANA) exists so tests are timezone-safe; the UI passes none ⇒ browser local.
 * Invalid start ⇒ `null` (render nothing); invalid / before-start end ⇒ treated as still running.
 */
import { formatDateTime } from "../format.js";

export interface TimeRangeLabel {
  readonly text: string;
  readonly title: string;
}

const partsFmt = new Map<string, Intl.DateTimeFormat>();
function fmtFor(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let f = partsFmt.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      ...(timeZone !== undefined ? { timeZone } : {}),
    });
    partsFmt.set(key, f);
  }
  return f;
}

interface Stamp {
  readonly day: string; // YYYY-MM-DD
  readonly full: string; // YYYY-MM-DD HH:MM:SS
}

function stamp(ms: number, timeZone: string | undefined): Stamp {
  const p: Record<string, string> = {};
  for (const part of fmtFor(timeZone).formatToParts(new Date(ms))) p[part.type] = part.value;
  const day = `${p.year}-${p.month}-${p.day}`;
  return { day, full: `${day} ${p.hour}:${p.minute}:${p.second}` };
}

/** `HH:MM` (24h) of `ms` in the zone — the abbreviated same-day end. */
function clock(ms: number, timeZone: string | undefined): string {
  const s = stamp(ms, timeZone).full;
  return s.slice(11, 16);
}

export function formatTimeRange(
  startMs: unknown,
  endMs?: unknown,
  opts: { timeZone?: string } = {},
): TimeRangeLabel | null {
  if (typeof startMs !== "number" || !Number.isFinite(startMs)) return null;
  const tz = opts.timeZone;
  const start = stamp(startMs, tz);
  const startText = formatDateTime(startMs, "zh-CN", tz);
  if (typeof endMs !== "number" || !Number.isFinite(endMs) || endMs < startMs) {
    return { text: startText, title: start.full };
  }
  const end = stamp(endMs, tz);
  const endText = end.day === start.day ? clock(endMs, tz) : formatDateTime(endMs, "zh-CN", tz);
  return { text: `${startText} → ${endText}`, title: `${start.full} → ${end.full}` };
}
