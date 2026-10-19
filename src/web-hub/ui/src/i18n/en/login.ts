/**
 * `login` i18n namespace (vue-plan.md v2.1 §3.8, §6.7, §8, §5.2 — P3): the sign-in card
 * (password mode) and the token-mode gate. Sign-in *error* copy (`E_AUTH`, throttled, …) lives
 * in P1's `errors` namespace (`usePasswordAuth`'s `LoginErrorView.key`) — this namespace only
 * covers the form shell and the two empty/gate states `TokenGate.vue` renders.
 */
const login = {
  subtitle: "Sign in to watch your pi sessions and subagents live.",
  plaintextLead: "Plain HTTP.",
  plaintextBody: "Your password travels unencrypted.",
  plaintextMore:
    "This page is served over plain HTTP, so your password and session cookie travel unencrypted on this network. Sign in only on a network you trust, or put the hub behind an HTTPS reverse proxy.",
  usernameLabel: "Username",
  passwordLabel: "Password",
  showPassword: "Show password",
  hidePassword: "Hide password",
  submit: "Sign In",
  tokenInvalidTitle: "This link is no longer valid",
  tokenInvalidLead: "Run",
  tokenInvalidTail: "on the host and open the fresh link it prints.",
  // LAN security r2 §5.9 (package G): the second-factor card (`LoginSecondFactor.vue`).
  // `{min}` = challenge TTL minutes, `{s}` = seconds, `{n}` = attempts left.
  "2fa.heading": "Two-factor verification",
  "2fa.headingTotp": "Enter your code",
  "2fa.headingFeishu": "Waiting for Feishu approval",
  "2fa.headingRecovery": "Use a recovery code",
  "2fa.lead":
    "This sign-in is from a new address and needs a second factor. The verification stays valid for {min} minutes.",
  "2fa.totpLabel": "6-digit code from your authenticator app",
  "2fa.totpHint": "Codes rotate every 30 seconds; you have several attempts.",
  "2fa.recoveryLabel": "12-character recovery code",
  "2fa.recoveryHint": "Each recovery code works exactly once.",
  "2fa.submit": "Verify and sign in",
  "2fa.verifying": "Verifying…",
  "2fa.altTitle": "Other methods",
  "2fa.useTotp": "Use authenticator app instead",
  "2fa.useFeishu": "Use Feishu approval instead",
  "2fa.useRecovery": "Use a recovery code",
  "2fa.cancel": "Cancel sign-in",
  "2fa.backToLogin": "Back to sign-in",
  "2fa.waitLead": "An approval request was sent to Feishu — please confirm it there",
  "2fa.waitCountdown": "{s}s left to approve",
  "2fa.waitExpired": "Approval timed out — the other methods still work",
  "2fa.errorTotp": "Incorrect code, try again ({n} attempts left for this sign-in)",
  "2fa.errorRecovery": "Recovery code incorrect or already used ({n} attempts left for this sign-in)",
  "2fa.invalidTotp": "Enter the 6-digit code.",
  "2fa.invalidRecovery": "A recovery code is 12 characters (spaces and dashes are fine).",
  "2fa.methodLocked": "Too many attempts with this method — retry in {s}s, or use another method.",
  "2fa.attemptsExhausted": "No attempts left for this sign-in. Please sign in again.",
  "2fa.noMethod": "No usable verification method is available for this sign-in. Please go back and sign in again.",
  "2fa.expired": "This verification expired (over {min} minutes). Please sign in again.",
  "2fa.denied": "The sign-in was denied in Feishu.",
  "2fa.failed": "Verification failed — try again or restart sign-in.",
} satisfies Record<string, string>;

export default login;
