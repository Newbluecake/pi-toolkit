/**
 * `settings` i18n namespace (user-decided 2026-10): the standalone settings page (`#/settings`)
 * — theme, font size, and the composer's default delivery mode. The three theme labels and the
 * font reset label stay in `shell` (`shell.theme.*` / `shell.fontScale.*`), reused as-is.
 * Deliver mode names stay English tokens in BOTH languages (AGENTS.md UI-text split).
 */
const settings = {
  title: "Settings",
  back: "Back",
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
