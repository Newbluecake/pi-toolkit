/**
 * `resume` i18n namespace (web-resume plan v2 §2.6, package P3) — the ALWAYS-LOADED keys
 * only: the header 「恢复」 button (D7, title + accessible name) and the command-palette description, both rendered
 * BEFORE the dialog's lazy chunk ever loads. The dialog's own strings live in
 * `i18n/resume-extra.ts` (registered into `MESSAGES.*.resume` when the lazy chunk mounts —
 * the first-screen 255 KiB gate has no headroom for an eager ~30-key dictionary; see
 * logic/resume.ts's header). Key/placeholder parity across languages is pinned by
 * `tests/web-hub/ui/i18n-parity.test.ts` (the eager glob picks this file up) and
 * `tests/web-hub/ui/resume-logic.test.ts` (the lazy half).
 */
const resume = {
  // D7 header button, next to 「清空」 — same gating as clear + the resume.v1 feature.
  openTitle: "Resume session",
  /** Visible short label next to the header button icon (collapses to icon-only when narrow). */
  openLabel: "Resume",
  // §2.6 decoratePalette — shown on the /resume + /resume-recent palette rows.
  paletteDesc: "Resume a session (switch in this process)",
} satisfies Record<string, string>;

export default resume;
