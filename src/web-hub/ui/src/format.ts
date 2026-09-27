/**
 * Display formatting (vue-plan.md v2.1 §3.1, §3.6, §5.2 — P1). `formatUsd` / `formatDuration` /
 * `clip` are ports of the legacy `render/dom.js` trio — same rules (§3.1: "保留 formatUsd「<$1
 * 显示 4 位」规则"), `formatUsd` now backed by `Intl.NumberFormat` (currency style) instead of
 * hand-rolled `$`-prefixing; `formatPercent` / `formatDateTime` / `formatNumber` are new,
 * `Intl`-backed helpers for the detail view (context-window percent, session timestamps) the
 * legacy vanilla-JS frontend never needed. `Intl.DurationFormat` is deliberately not used for
 * `formatDuration` — it isn't in this repo's `lib` yet and support is inconsistent — so that one
 * stays the original compact hand-rolled algorithm (`42s` / `3m05s` / `1h02m`).
 */
import type { Lang } from "./composables/useI18n.js";

/** `Lang` (§3.8's `zh`/`en`) → a concrete BCP 47 tag for `Intl.*`. */
export function localeFor(lang: Lang): string {
  return lang === "zh" ? "zh-CN" : "en-US";
}

const usdSmall = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});
const usdLarge = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Human cost: `$0.0123` (< $1 shows 4 decimals) / `$1.23`, `—` when unknown, `$0` for exactly 0. */
export function formatUsd(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  return n < 1 ? usdSmall.format(n) : usdLarge.format(n);
}

/** Compact duration: `42s`, `3m05s`, `1h02m`, `""` when unknown/negative. */
export function formatDuration(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Truncate a display string to `max` chars with an ellipsis. */
export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** `0..100`-scale percent (e.g. `StatusInfo.contextUsage.percent`) → a locale-formatted string; `—` when unknown. */
export function formatPercent(n: number | null | undefined, locale = "en-US"): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(n / 100);
}

/** Epoch-ms → a locale-formatted date+time; `—` when unknown. */
export function formatDateTime(ms: number | null | undefined, locale = "en-US"): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
}

/** Locale-grouped integer/decimal formatting (token counts etc.); `—` when unknown. */
export function formatNumber(n: number | null | undefined, locale = "en-US"): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat(locale).format(n);
}
