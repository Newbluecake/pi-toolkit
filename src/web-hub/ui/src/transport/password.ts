/**
 * Password-mode (LAN) `HubTransport`/`PasswordTransport` adapter (vue-plan.md v2.1 §3.4, §5.2 —
 * P1). A thin wrapper around `@logic/password-client.js`'s `createPasswordClient` — never
 * re-implemented here. This is the exact seam 78dd76b broke through (the password client used to
 * lack `subscribe`/`unsubscribe`/`page` entirely, silently wedging LAN history at "loading
 * history…" with zero network activity): `tests/web-hub/ui/transport-contract.test.ts` runs the
 * identical `describe.each` suite against this and `token.ts` so that regression class can never
 * land unnoticed again.
 */
import { API } from "@logic/contract.js";
import { createPasswordClient } from "@logic/password-client.js";
import type { PasswordTransport, Result } from "./types.js";

export type PasswordTransportDeps = Parameters<typeof createPasswordClient>[0];

/**
 * Verifier fix (2026-09-27): `@logic/password-client.js`'s `subscribe`/`unsubscribe`/`page` are
 * one-shot REST calls with *no* relogin dance in password mode (unlike token mode's `withRelogin`
 * — a password-mode 401 means the cookie session is gone, per the client's own header comment).
 * That legacy client only ever surfaces the loss through the returned `E_AUTH` error (subscribe/
 * page) or drops it entirely (`unsubscribe`, best-effort, return type `Promise<void>`) — it never
 * calls `onConn("auth")` for a REST 401 the way the SSE `event: auth` frame / `probeSessionAfterClose`
 * do, so `LoginView` never remounts and the UI is stuck showing a dead dashboard. Fixed here, one
 * layer up, without touching the frozen legacy client: wrap `deps.fetch` so any 401 response from
 * `subscribe`/`unsubscribe`/`page`'s own endpoints (never `/api/login` — an invalid-credentials 401
 * there is a normal login-form error, not a lost session) reports `onConn("auth")` once per
 * occurrence; `useHub.ts`'s `dispatch()` already no-ops a repeated `{event:"conn",data:{state:"auth"}}`
 * (the reducer's own `d.state !== s.conn` guard, `state.js`'s `case "conn"`), so this is never a
 * double show. Regression coverage: `tests/web-hub/ui/transport-contract.test.ts`'s "REST 401 on
 * subscribe/unsubscribe/page reports onConn('auth')" block (one case per method).
 */
const REST_AUTH_PATHS: ReadonlySet<string> = new Set([API.subscribe, API.unsubscribe]);

function isRestAuthEndpoint(url: string): boolean {
  return REST_AUTH_PATHS.has(url) || url.startsWith(API.history);
}

export function createPasswordTransport(deps: PasswordTransportDeps): PasswordTransport {
  const wrappedDeps: PasswordTransportDeps = {
    ...deps,
    fetch: async (url, init) => {
      const r = await deps.fetch(url, init);
      if (r.status === 401 && isRestAuthEndpoint(url)) deps.onConn("auth");
      return r;
    },
  };
  const client = createPasswordClient(wrappedDeps);
  return {
    mode: "password",
    start: () => client.start(),
    close: () => client.close(),
    subscribe: (clientId, agentKey) => client.subscribe(clientId, agentKey),
    unsubscribe: (clientId, agentKey) => client.unsubscribe(clientId, agentKey),
    page: <T = unknown>(agentKey: string, before: string, limit?: number) =>
      client.page(agentKey, before, limit) as Promise<Result<T>>,
    command: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false, effect: "none" }),
    dialog: async () => ({ ok: false, error: "E_UNSUPPORTED", retryable: false, effect: "none" }),
    login: (username, password) => client.login(username, password),
    logout: () => client.logout(),
  } satisfies PasswordTransport;
}
