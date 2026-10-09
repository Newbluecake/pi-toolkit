/**
 * `shell` i18n namespace (vue-plan.md v2.1 §3.8, §7, §5.2 — P3): the top bar and connection
 * pill, plus the theme/font labels reused by the settings page (the top-bar theme toggle and
 * font popover are retired 2026-10; `theme.groupLabel` / `fontScale.label` / `fontScale.aria`
 * went with them — acceptance P3).
 */
const shell = {
  skipToConversation: "Skip to conversation",
  dashboardHeading: "pi web-hub dashboard",
  hubVersion: "hub {v}",
  uiBuild: "ui {v}",
  signOut: "Sign out",
  /* 2026-10-10: the two-state `langToggle` became the LangMenu dropdown — the label names the
   * CURRENT language ({lang} is its own-script name), the menu aria is short, and the two
   * language names are identical across dictionaries (never translated). */
  langMenuLabel: "Language: {lang}",
  langMenuAria: "Language",
  langZh: "中文",
  langEn: "English",
  "conn.connecting": "Connecting…",
  "conn.open": "Live",
  "conn.reconnecting": "Reconnecting…",
  "conn.auth": "Signed out",
  booting: "Loading…",
  sidebarResize: "Resize sidebar",
  sidebarResizeHint: "Drag to resize · double-click to reset",
  "theme.system": "System",
  "theme.light": "Light",
  "theme.dark": "Dark",
  "fontScale.reset": "Reset",
} satisfies Record<string, string>;

export default shell;
