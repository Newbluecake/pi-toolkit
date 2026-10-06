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
} satisfies Record<string, string>;

export default settings;
