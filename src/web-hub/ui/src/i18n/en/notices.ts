/**
 * `notices` i18n namespace (vue-plan.md v2.1 §3.8, §7, §10, §5.2 — P3). Global (topbar-level)
 * notice bodies — safety reminder (initial password), connection health, session expiry, and
 * the "stale page, can't tell auth mode" fallback — plus their action-button labels.
 * Sentences containing a literal command/flag are split into a lead/tail pair (§3.8's rule)
 * so the command itself renders as an untranslated `<code>` fragment, never embedded markup.
 */
const notices = {
  retryNow: "Retry Now",
  signIn: "Sign In",
  reload: "Reload",
  initialPasswordLead: "Change the initial password soon.",
  initialPasswordRun: "Run",
  initialPasswordHost: "on the host.",
  initialPasswordMore:
    "The hub still accepts the password generated at setup, so anyone who saw it can sign in. This notice goes away once the password is changed.",
  connectionLostTitle: "Connection lost.",
  connectionLostBody: "Retrying in {s}s — showing data from {t}.",
  sessionExpiredTitle: "Session expired.",
  sessionExpiredBody: "Sign in again to keep watching.",
  authUnknown: "Cannot determine the sign-in mode — this page is probably stale.",
} satisfies Record<string, string>;

export default notices;
