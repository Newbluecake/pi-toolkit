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
} satisfies Record<string, string>;

export default login;
