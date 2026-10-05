/**
 * `shell` i18n namespace (vue-plan.md v2.1 §3.8, §7, §5.2 — P3): the top bar, connection pill
 * and theme toggle.
 */
const shell = {
  skipToConversation: "Skip to conversation",
  dashboardHeading: "pi web-hub dashboard",
  hubVersion: "hub {v}",
  uiBuild: "ui {v}",
  signOut: "Sign out",
  "conn.connecting": "Connecting…",
  "conn.open": "Live",
  "conn.reconnecting": "Reconnecting…",
  "conn.auth": "Signed out",
  "theme.system": "System",
  "theme.light": "Light",
  "theme.dark": "Dark",
  "theme.groupLabel": "Theme",
  "fontScale.label": "Font size",
  "fontScale.aria": "Font size {pct}%",
  "fontScale.reset": "Reset",
} satisfies Record<string, string>;

export default shell;
