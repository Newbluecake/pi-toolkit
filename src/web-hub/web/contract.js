/**
 * Hand-written mirror of `src/web-hub/protocol/http-contract.ts` (plan §包 E).
 *
 * The browser cannot import TypeScript, so the hub↔browser contract is
 * duplicated here; `tests/web-hub/web/contract.test.ts` deep-compares these
 * arrays with the protocol ones to catch drift. Never edit one side alone.
 */

/** SSE `event:` names pushed by the hub (order irrelevant, set must match). */
export const SSE_EVENTS = Object.freeze([
  "hello",
  "hub",
  "agents",
  "agent_up",
  "agent_down",
  "agent_stale",
  "session",
  "history",
  "ev",
  "status",
  "fleet",
  "prompt",
  "gap",
  "resync",
  "append",
  "auth",
  "ping",
]);

/** Error codes returned by `/api/*` as `{ error: code }`. */
export const API_ERRORS = Object.freeze([
  "E_AUTH",
  "E_CSRF",
  "E_HOST",
  "E_RATE",
  "E_NOT_FOUND",
  "E_BAD_REQUEST",
  "E_DEADLINE",
  "E_AGENT_GONE",
  "E_NOT_IMPLEMENTED",
  "E_BUSY",
  "E_DB",
]);

/** Endpoints the P1 (read-only) frontend talks to; `logout`/`session` are LAN-only (S1, package LF). */
export const API = Object.freeze({
  login: "/api/login",
  logout: "/api/logout",
  session: "/api/session",
  events: "/api/events",
  subscribe: "/api/subscribe",
  unsubscribe: "/api/unsubscribe",
  history: "/api/history",
});

/** Client-side SSE silence limit: no frame (hub pings every 15s) for this long ⇒ reconnect. */
export const SILENCE_MS = 45_000;

/** `/api/history` page size cap enforced by the hub. */
export const HISTORY_LIMIT_MAX = 400;
