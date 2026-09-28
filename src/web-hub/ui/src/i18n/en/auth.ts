/**
 * `auth` i18n namespace (control-plan.md v2.1 §6.7.1 前端行, §7.7 — C5): auth-flow additions
 * introduced by the control plane (token rotation invalidates every stored link).
 */
const auth = {
  tokenRotated: "Token rotated — run /webhub open in the terminal for a new link.",
} satisfies Record<string, string>;

export default auth;
