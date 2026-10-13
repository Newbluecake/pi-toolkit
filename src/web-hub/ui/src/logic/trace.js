/**
 * TEMPORARY sync tracer for the Aw Snap / freeze investigation (#11, 2026-10-13 — user report:
 * switching to the bunker session wedges the main thread in 30–50s blocks, flat heap, static
 * DOM; offline replay of the real payload is fast, so the block is in browser-side mounting).
 *
 * `tracePoint(name)` appends `{n, t, ...extra}` to the `pwh_diag_trace` localStorage ring
 * (cap 80) SYNCHRONOUSLY — the only channel that still records when the renderer is about to
 * freeze or die. Gated on `pwh_trace=1` read ONCE at module load (default: fully inert, zero
 * writes). Delete this module with the investigation.
 *
 * Localized here (not in each component) so the `localStorage` identifier stays in ONE file
 * (source-scan discipline) — callers just import `tracePoint`.
 */
const KEY = "pwh_diag_trace";
const CAP = 80;

/** @type {boolean | null} */
let enabled = null;

function isEnabled() {
  if (enabled === null) {
    try {
      enabled = localStorage.getItem("pwh_trace") === "1";
    } catch {
      enabled = false;
    }
  }
  return enabled;
}

/** @param {string} name @param {Record<string, unknown>} [extra] */
export function tracePoint(name, extra) {
  if (!isEnabled()) return;
  try {
    const raw = localStorage.getItem(KEY);
    const ring = raw !== null ? JSON.parse(raw) : [];
    ring.push({ n: name, t: Date.now(), ...extra });
    while (ring.length > CAP) ring.shift();
    localStorage.setItem(KEY, JSON.stringify(ring));
  } catch {
    /* a breadcrumb never breaks the app */
  }
}
