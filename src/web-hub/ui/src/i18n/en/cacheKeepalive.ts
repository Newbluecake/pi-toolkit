/**
 * `cacheKeepalive` i18n namespace (cache-keepalive-web plan §4.1/D10, P-B): the detail header's
 * read-only prompt-cache keepalive panel (`CacheKeepalivePanel.vue`). Per AGENTS.md's UI-text
 * split, every compact inline marker the panel shows — the collapsed line
 * (`cache 1h* · ping off:http 403 ·retry 25m ·t3`), `http 403`, `trips N`, `eligible now`,
 * `proven-hit`, `keepalive off` — is an English token assembled client-side (in
 * `cacheKeepaliveView.ts` / the component) and NEVER looked up here; this namespace carries
 * only what reads as prose (section labels, the mode explanation line, status words like
 * enabled/disabled, transient/permanent tags, aria text, empty-state placeholders, the
 * omitted-rows tail). Deliberately its own file (D10): the shared `detail.ts` is a hot file
 * owned by other in-flight lines.
 */
const cacheKeepalive = {
  title: "Prompt-cache keepalive",
  toggleAria: "Prompt-cache keepalive details",
  summaryAria: "Prompt-cache keepalive: {marker}",
  rowMode: "Mode",
  modeAutoNote: "Follows pi/provider default; `on` pins the 1h write, `off` strips the override",
  rowEnabled: "Keepalive",
  enabledOn: "enabled",
  enabledOff: "disabled",
  rowLastPing: "Last ping",
  lastPingNone: "no ping yet",
  lastPingAgo: "{age} ago",
  transientTag: "transient",
  permanentTag: "permanent",
  lineTag: "per-line",
  rowWindow: "Window",
  rowSession: "This session",
  rowCacheRead: "cache read",
  rowCost: "cache-read cost",
  rowAvoided: "avoided rewrite",
  rowLoadBearing: "load-bearing windows",
  rowUnnecessary: "unnecessary windows",
  rowDiscarded: "discarded windows",
  rowDisabled: "Keepalive disabled",
  disabledSince: "since {ago}",
  linesTitle: "Line breakers",
  linesNone: "No line breakers recorded",
  lineCurrent: "current",
  lineLegacy: "legacy",
  lineHistory: "history",
  lineRetryIn: "retry in {dur}",
  lineEligibleNow: "eligible now",
  linesMore: "(+{n} more)",
};

export default cacheKeepalive;
