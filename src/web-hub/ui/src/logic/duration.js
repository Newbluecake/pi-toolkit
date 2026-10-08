/**
 * Tool-duration chip text (tool-duration plan, 2026-10) — a pure formatter, no DOM, unit-tested
 * in tests/web-hub/ui/logic-duration.test.ts. Auto-scaled units, compact English tokens only
 * (AGENTS.md UI text split: inline markers never mix Chinese):
 *
 *   <1000ms  ⇒ "340ms"    (floored — never rounds up into the seconds bucket)
 *   <10s     ⇒ "2.4s"     (one decimal; a value rounding to 10.0 falls through to "10s")
 *   <60s     ⇒ "12s"      (rounded seconds; 59.96s carries to "1m 00s", never "60s")
 *   <1h      ⇒ "3m 05s"   (zero-padded seconds)
 *   ≥1h      ⇒ "1h 02m"   (zero-padded minutes; unbounded hours)
 *
 * Rounding is boundary-safe by construction: every carry happens on the already-rounded
 * integer-second total, so no output can ever read "60s"/"60m".
 *
 * @param {unknown} ms
 * @returns {string | null} null for negative / NaN / Infinity / non-numbers (render nothing)
 */
export function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.floor(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 9.95) {
    const d = Math.round(secs * 10) / 10;
    if (d < 10) return `${d.toFixed(1)}s`;
  }
  const t = Math.round(secs);
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`;
  return `${Math.floor(t / 3600)}h ${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}m`;
}
