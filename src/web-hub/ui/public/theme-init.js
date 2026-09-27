// pi web-hub theme bootstrap (vue-plan.md v2.1 §3.9, §5.2 — P0 frozen).
//
// Non-module, synchronous, loaded before any CSS: reads the persisted theme
// preference and adds the matching class to <html> before first paint, so
// there is no flash of the wrong theme. `"system"` (the default) adds no
// class — tokens.css's `prefers-color-scheme` media query handles it.
// Deliberately tiny and wrapped in try/catch: this must never throw and
// never block rendering, even with localStorage disabled/unavailable
// (private browsing, storage quota, etc.).
(function () {
  try {
    var pref = window.localStorage.getItem("pwh_theme");
    if (pref === "light") document.documentElement.classList.add("theme-light");
    else if (pref === "dark") document.documentElement.classList.add("theme-dark");
  } catch (e) {
    /* localStorage unavailable — fall back to prefers-color-scheme only */
  }
})();
