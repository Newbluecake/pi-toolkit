/**
 * `errors` i18n namespace (vue-plan.md v2.1 §3.8, §5.2 — P1): sign-in error copy consumed via
 * `usePasswordAuth`'s `LoginErrorView.key` (`"errors.<leaf>"`) and the token-mode gate's
 * `TokenGateProps.reason`. Mirrors the wording of the legacy `password-client.js`/`app.js` error
 * strings (`tests/web-hub/web/login.test.ts`) so the migration doesn't change what a user reads,
 * modulo `{s}`-style placeholders replacing string concatenation.
 */
const errors = {
  invalid: "Invalid username or password.",
  notAllowed: 'This address is not on the hub\'s allow-list. Use one of the addresses shown by "/webhub open".',
  saturated: 'Sign-in from new addresses is temporarily blocked. Ask the host to run "/webhub unlock".',
  busyExhausted: "Hub database unavailable — retry",
  network: "Cannot reach hub.",
  unknown: "Sign-in failed.",
  throttled: "Too many attempts. Try again in {s}s.",
  retryingRate: "Too many requests, retrying…",
  retryingBusy: "Hub is busy, retrying…",
  revoked: "Signed out on another tab or by the host.",
  expired: "Session expired — please sign in again.",
  tokenInvalid: "Your sign-in link is no longer valid.",
  authModeUnknown: "Cannot determine sign-in mode (stale page?). Reload.",
} satisfies Record<string, string>;

export default errors;
