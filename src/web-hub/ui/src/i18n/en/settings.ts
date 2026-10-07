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
  // default-model plan F1 — the 「新建会话默认模型」 card. The model ref itself
  // (`provider/id`) is an English token in both languages; prose blocks translate.
  defaultModelSection: "Default model for new sessions",
  defaultModelHint:
    "Used when a session is started from this hub (the web pick-dir/new-session entries). It never touches ~/.pi/agent/settings.json and never changes an already-running session.",
  defaultModelShared: "One value shared by every signed-in device of this hub.",
  defaultModelPlaceholder: "provider/id — empty means pi's own default",
  defaultModelUsePi: "Use pi default",
  defaultModelSave: "Save",
  defaultModelSaving: "Saving…",
  defaultModelSaved: "Saved.",
  defaultModelInvalid: "Not a valid provider/id — e.g. anthropic/claude-opus-4-5",
  defaultModelUnsupported:
    "This hub is too old for the default-model preference — run /webhub restart after upgrading.",
  defaultModelSaveFailed: "Save failed — the hub rejected or could not persist it; retry.",
  defaultModelNoList: "No online session to take the model list from — you can still type a provider/id.",
  defaultModelNotInList: "Not in the known model list — double-check the spelling before saving.",
} satisfies Record<string, string>;

export default settings;
