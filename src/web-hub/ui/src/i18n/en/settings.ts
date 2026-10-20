/**
 * `settings` i18n namespace (overlay panel, revised 2026-10 field report: the standalone
 * `#/settings` page used to unmount the whole session view, so settings is now a floating panel
 * — a desktop popover anchored under the top bar's gear, a bottom sheet on phones — rendered
 * ON TOP of the session shell, which stays mounted underneath. Theme, font size, and the
 * composer's default delivery mode. The three theme labels and the font reset label stay in
 * `shell` (`shell.theme.*` / `shell.fontScale.*`), reused as-is. Deliver mode names stay English
 * tokens in BOTH languages (AGENTS.md UI-text split).
 */
const settings = {
  title: "Settings",
  close: "Close",
  themeSection: "Theme",
  fontSection: "Font size",
  deliverSection: "Default delivery",
  deliverHint:
    "How new messages are delivered while the agent is busy. Alt+Enter in the composer still flips to follow-up per message.",
  deliverSteer: "Steer",
  deliverFollowUp: "Follow-up",
  deliverSteerHint: "Interrupt the current turn",
  deliverFollowUpHint: "Queue until the turn ends",
  // D2 (web-hub-session-switch plan §2.2 step 6) — the 「会话缓存」 card. The numeric token
  // stays an English token in both languages (AGENTS.md UI-text split); prose translates.
  keepAliveSection: "Session cache",
  keepAliveHint: "Recently viewed sessions stay subscribed so switching back is instant; applies on the next switch.",
  keepAliveOff: "Off (reload on every switch)",
  keepAlive3: "3 sessions (default)",
  keepAlive5: "5 sessions",
  // 2026-10 motion switch (pwh_motion) — the 「动态效果」 card. The user's desktop Edge reports
  // prefers-reduced-motion: reduce (Windows animation effects off), which silently disabled
  // every animation; this pref overrides the OS per browser. Labels translate; the stored
  // tokens stay system/on/off.
  motionSection: "Motion",
  motionHint: "Follow system honors the operating system's reduce-animation setting.",
  motionSystem: "Follow system (default)",
  motionOn: "Always animate",
  motionOff: "Always reduce",
  // 2026-10 plaintext-warning opt-out — the 「明文 HTTP 警告」 card. Rendered ONLY on pages
  // actually served as plaintext (password mode over http:, the same predicate every warning
  // component uses — CONTROL_ENV.plaintext); https / loopback-token pages never show the
  // warnings, so the setting would be dead weight there. Hiding is warning-text visibility
  // only — the transport stays unencrypted (the hint says exactly that).
  plainWarnSection: "Plaintext HTTP warnings",
  plainWarnHint:
    "Hiding the warnings changes nothing about the transport — traffic on this network stays unencrypted and readable by others.",
  plainWarnShow: "Show warnings",
  plainWarnHide: "Hide warnings (default)",
  // 2026-10-18 PWA 「Install as app」 card — the beforeinstallprompt capture
  // (composables/useInstallPrompt.ts) + pure derive (logic/pwaInstall.ts) drive which row
  // renders: installed status / install button / per-platform guidance. The chrome://flags
  // URL and the Enabled token stay English in both languages (AGENTS.md UI-text split);
  // prose translates. `installInsecureSteps` mentions the origin chip rendered separately.
  installSection: "Install as app",
  installHint:
    "Add the hub to your home screen / desktop and run it like a native app. There is no service worker on purpose — data is live, so the hub must be reachable when the app starts.",
  installInstalled: "Installed — already running as a standalone app.",
  installBtn: "Install",
  installInstalling: "Installing…",
  installDismissed: "Dismissed — you can install anytime from here.",
  installIosHint: "Open this page in Safari, tap the Share button, then “Add to Home Screen”.",
  installInsecureHint:
    "The full standalone install needs a secure context (HTTPS, or a loopback address such as localhost / 127.0.0.1) — this page arrived over plain HTTP, so the browser hides its install entry. Whitelist the origin below once, or reach the hub through an HTTPS reverse proxy:",
  installInsecureSteps:
    "Open chrome://flags/#unsafely-treat-insecure-origin-as-secure in this browser, add the origin below, set it to Enabled, relaunch — then come back and install.",
  installOriginLabel: "Origin to whitelist",
  installDesktopHint: "Click the install icon at the right end of the address bar, or menu → Install (Chrome / Edge).",
  installAndroidHint: "Browser menu ⋮ → Install app / Add to Home screen.",
  installGenericHint: "Look for “Install” or “Add to Home screen” in your browser's menu (support varies).",
  // default-model plan F1 — the 「新建会话默认模型」 card (2026-10 select-only rework: the
  // free-text input/datalist is gone; a switcher-styled picker chip + listbox selects from
  // the known list, with 「跟随 pi 默认」 as a list row). 2026-10-12: `defaultModelPlaceholder`
  // / `defaultModelInvalid` went away with SpawnModelField (the spawn dialog's per-session
  // field — removed per user 拍板). The model ref (`provider/id`) and the chip's `not in
  // list` marker are English tokens in both languages; prose blocks translate.
  defaultModelSection: "Default model for new sessions",
  defaultModelHint:
    "Used when a session is started from this hub (the web pick-dir/new-session entries). It never touches ~/.pi/agent/settings.json and never changes an already-running session.",
  defaultModelShared: "One value shared by every signed-in device of this hub.",
  defaultModelFollowPi: "Follow pi default",
  defaultModelFollowPiHint: "new sessions use pi's own default",
  defaultModelListAria: "Default model picker",
  defaultModelSaving: "Saving…",
  defaultModelSaved: "Saved.",
  defaultModelUnsupported:
    "This hub is too old for the default-model preference — run /webhub restart after upgrading.",
  defaultModelSaveFailed: "Save failed — the hub rejected or could not persist it; retry.",
  defaultModelNoList: "No model list yet — models appear here once a session is online.",
  defaultModelNotInList: "not in list",
  defaultModelNotInListTitle: "Not in the known model list — pick a model from the list to replace it.",
} satisfies Record<string, string>;

export default settings;
