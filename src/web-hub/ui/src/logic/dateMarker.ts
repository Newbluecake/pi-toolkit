/**
 * `[date]` injection marker → structured view (date-marker plan, layout A). Pure, DOM-free.
 * Source of truth is the entry's `details` (`{date, kind, at}` — the hub projects exactly that
 * subset); the content's `[date] YYYY-MM-DD Ddd HH:MM (TZ)` marker supplies weekday/time/zone
 * (details carry only the epoch `at`, whose zone is the agent's, not the browser's). Anything
 * unparseable ⇒ `undefined` and the caller falls back to the generic custom-message card.
 */

export const DATE_CUSTOM_TYPE = "subagent:date";

export type DateMarkerKind = "first" | "cross-day" | "idle" | "unknown";

export interface DateMarker {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** English short weekday exactly as injected (`Mon`…`Sun`); localized by the component. */
  readonly weekday: string;
  /** `HH:MM`. */
  readonly time: string;
  /** IANA id or `UTC±HH:MM`. */
  readonly zone: string;
  readonly kind: DateMarkerKind;
}

const MARKER_RE = /^\[date\] (\d{4}-\d{2}-\d{2}) ([A-Za-z]{3}) (\d{2}:\d{2}) \(([^)]+)\)/;
/** Cross-day content carries this note (src/date/core.ts CROSS_DAY_NOTE) — kind fallback when
 *  `details.kind` is missing. */
const CROSS_DAY_NOTE = "当前日期已变更";

function kindOf(details: unknown, content: string): DateMarkerKind {
  const raw = details !== null && typeof details === "object" ? (details as { kind?: unknown }).kind : undefined;
  if (raw === "first" || raw === "cross-day" || raw === "idle") return raw;
  return content.includes(CROSS_DAY_NOTE) ? "cross-day" : "unknown";
}

export function parseDateMarker(content: string, details?: unknown): DateMarker | undefined {
  const m = MARKER_RE.exec(content);
  if (!m) return undefined;
  const [, date, weekday, time, zone] = m;
  if (date === undefined || weekday === undefined || time === undefined || zone === undefined) return undefined;
  return { date, weekday, time, zone, kind: kindOf(details, content) };
}
