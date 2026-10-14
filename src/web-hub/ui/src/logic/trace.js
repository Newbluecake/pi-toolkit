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

/**
 * TEMPORARY (#11, 2026-10-14 — user idea): one-shot state dump printed after app init so the
 * user can right-click → "Copy string contents" and paste it back, instead of running console
 * snippets. FULL localStorage values (never truncated — the freeze trigger lives in there; an
 * earlier truncated export could not be replayed), plus the environment facts the crash depends
 * on. Any key whose name mentions "token" is redacted. Re-print any time with `pwhDiag()`.
 * Never throws; delete with the investigation.
 * @param {Record<string, unknown>} [extra]
 * @returns {string}
 */
export function diagDump(extra) {
  try {
    /** @type {Record<string, string>} */
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k === null) continue;
      ls[k] = /token/i.test(k) ? "[redacted]" : (localStorage.getItem(k) ?? "");
    }
    const mq = (q) => {
      try {
        return window.matchMedia(q).matches;
      } catch {
        return null;
      }
    };
    return JSON.stringify({
      at: new Date().toISOString(),
      href: location.origin + location.pathname,
      hash: location.hash.replace(/([#&?]t=)[^&]*/g, "$1[redacted]"),
      authMode: document.documentElement.dataset["authMode"] ?? null,
      ua: navigator.userAgent,
      reducedMotion: mq("(prefers-reduced-motion: reduce)"),
      dark: mq("(prefers-color-scheme: dark)"),
      dpr: window.devicePixelRatio,
      viewport: [window.innerWidth, window.innerHeight],
      ...(extra ?? {}),
      localStorage: ls,
    });
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
}

/** Print the dump once and expose `pwhDiag()` for a later re-print. @param {Record<string, unknown>} [extra] */
export function installDiagDump(extra) {
  try {
    /** @type {any} */ (window).pwhDiag = () => {
      const s = diagDump(extra);
      console.info("[pwh-diag]", s);
      return s;
    };
    console.info("[pwh-diag]", diagDump(extra));
    console.info("[pwh-diag] 右键上一行 → Copy string contents 粘贴给排查方；随时输入 pwhDiag() 可重新打印。");
  } catch {
    /* a diagnostic never breaks the app */
  }
}
