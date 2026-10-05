// pi web-hub theme bootstrap (vue-plan.md v2.1 §3.9, §5.2 — P0 frozen).
//
// Non-module, synchronous, loaded before any CSS: reads the persisted theme
// preference and adds the matching class to <html> before first paint, so
// there is no flash of the wrong theme. `"system"` (the default) adds no
// class — tokens.css's `prefers-color-scheme` media query handles it.
//
// The same early-boot pass also applies the persisted font-scale preference
// (`pwh_fontscale`, one of "1" / "1.15" / "1.3" / "1.5") as the `--fs-scale`
// custom property on <html>, so the user's chosen text size is in effect on
// the very first paint instead of popping in when Vue mounts. "1" (the
// default) and anything unrecognized set nothing — tokens.css's
// `var(--fs-scale, 1)` fallback is already the 100% baseline.
// `composables/useFontScale.ts` is the runtime counterpart (same storage key,
// same property), exactly like `useTheme.ts` is for the theme classes.
//
// Deliberately tiny and wrapped in try/catch: this must never throw and
// never block rendering, even with localStorage disabled/unavailable
// (private browsing, storage quota, etc.).
(function () {
  try {
    var pref = window.localStorage.getItem("pwh_theme");
    if (pref === "light") document.documentElement.classList.add("theme-light");
    else if (pref === "dark") document.documentElement.classList.add("theme-dark");
    var scale = window.localStorage.getItem("pwh_fontscale");
    if (scale === "1.15" || scale === "1.3" || scale === "1.5") {
      document.documentElement.style.setProperty("--fs-scale", scale);
    }
  } catch (e) {
    /* localStorage unavailable — fall back to prefers-color-scheme / 100% font scale only */
  }
})();
