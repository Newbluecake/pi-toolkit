// pi web-hub theme bootstrap (vue-plan.md v2.1 §3.9, §5.2 — P0 frozen).
//
// Non-module, synchronous, loaded before any CSS: reads the persisted theme
// preference and adds the matching class to <html> before first paint, so
// there is no flash of the wrong theme. `"system"` (the default) adds no
// class — tokens.css's `prefers-color-scheme` media query handles it.
//
// The same early-boot pass also applies the persisted font-scale preference
// (`pwh_fontscale`, a decimal in [0.8, 3.0] — the slider composable aligns it to 5%
// steps; here any in-range number is acceptable for pre-paint application) as the
// `--fs-scale` custom property on <html>, so the user's chosen text size is in
// effect on the very first paint instead of popping in when Vue mounts. Missing,
// unparseable, or out-of-range values set nothing — tokens.css's
// `var(--fs-scale, 1)` fallback is already the 100% baseline.
// `composables/useFontScale.ts` is the runtime counterpart (same storage key,
// same property), exactly like `useTheme.ts` is for the theme classes.
//
// Deliberately tiny and wrapped in try/catch: this must never throw and
// never block rendering, even with localStorage disabled/unavailable
// (private browsing, storage quota, etc.).
//
// 2026-10 motion preference (pwh_motion): "on"/"off" set data-motion on <html> before
// first paint so the rewritten reduce rules (vite.config.ts's motion-css.ts PostCSS pass)
// never flash an animated first frame under "off" (or a frozen one under "on").
// "system" — and anything invalid — sets NOTHING: the reduce media queries then follow
// the OS exactly like before the feature existed. composables/useMotionPref.ts is the
// runtime counterpart (same key, same attribute), exactly like useTheme.ts is for themes.
(function () {
  try {
    var pref = window.localStorage.getItem("pwh_theme");
    if (pref === "light") document.documentElement.classList.add("theme-light");
    else if (pref === "dark") document.documentElement.classList.add("theme-dark");
    var raw = window.localStorage.getItem("pwh_fontscale");
    var scale = raw === null ? NaN : window.parseFloat(raw);
    if (window.isFinite(scale) && scale >= 0.8 && scale <= 3.0) {
      document.documentElement.style.setProperty("--fs-scale", String(scale));
    }
    var motion = window.localStorage.getItem("pwh_motion");
    if (motion === "on" || motion === "off") {
      document.documentElement.setAttribute("data-motion", motion);
    }
  } catch (e) {
    /* localStorage unavailable — fall back to prefers-color-scheme / 100% font scale / OS motion only */
  }
})();
