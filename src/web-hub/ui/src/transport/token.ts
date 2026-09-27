/**
 * Token-mode `HubTransport` adapter (vue-plan.md v2.1 §3.4, §5.2 — P1). A thin wrapper around
 * `@logic/token-client.js`'s `createClient` (extracted from `app.js` in P0) — never
 * re-implemented here, so the two transports can never silently diverge again (78dd76b: the
 * password client was missing `subscribe`/`unsubscribe`/`page`). `tests/web-hub/ui/
 * transport-contract.test.ts` runs the identical suite against this and `password.ts`.
 *
 * `TokenTransportDeps` is derived structurally from `createClient`'s own parameter type (via
 * `Parameters<typeof createClient>[0]`) instead of being redeclared field-by-field — the two
 * can never drift, and this module never has to name the browser global that ultimately backs
 * the `storage` field (a real caller wires `deps.storage = window.localStorage`; that literal
 * property access belongs to whichever later package assembles the running app from real
 * browser globals, not to this transport-only adapter — see `tests/web-hub/ui/source-scan.
 * test.ts`'s "localStorage is only used by the theme bootstrap / token transport" rule, which
 * this file deliberately stays clear of by construction).
 */
import { API } from "@logic/contract.js";
import { createClient } from "@logic/token-client.js";
import type { HubTransport, Result } from "./types.js";

export type TokenTransportDeps = Parameters<typeof createClient>[0];

/** Re-exported so a caller can clear a stored token without importing `@logic` directly. */
export { TOKEN_KEY, readHashToken } from "@logic/token-client.js";

/**
 * Verifier fix (2026-09-27), audited for parity with the password-mode fix in `password.ts`:
 * `@logic/token-client.js`'s `subscribe`/`page` already retry once through `withRelogin` on a 401
 * (silent re-login with the stored token — token mode's own auth-recovery story, deliberately
 * different from password mode's "show the login form"), but if that retry doesn't happen (no
 * stored token) or the retry itself still comes back 401, the *final* result is exactly the same
 * `{ ok: false, error: "E_AUTH" }` gap password mode had: no `onConn("auth")`, so a session that's
 * truly gone never flips the UI to `LoginView` until the SSE stream itself eventually notices.
 * `unsubscribe` has the same class of gap but doesn't even go through `withRelogin` — it's fire-
 * and-forget (`Promise<void>`, swallowing the response entirely) — so unlike subscribe/page there
 * is no return value to inspect; only a `deps.fetch` wrap can see its status at all.
 */
function isFinalAuthFailure(r: { readonly ok: boolean; readonly error?: string }): boolean {
  return !r.ok && r.error === "E_AUTH";
}

export function createTokenTransport(deps: TokenTransportDeps): HubTransport {
  const wrappedDeps: TokenTransportDeps = {
    ...deps,
    fetch: async (url, init) => {
      const r = await deps.fetch(url, init);
      if (r.status === 401 && url === API.unsubscribe) deps.onConn("auth");
      return r;
    },
  };
  const client = createClient(wrappedDeps);
  return {
    mode: "token",
    start: () => client.start(),
    close: () => client.close(),
    subscribe: async (clientId, agentKey) => {
      const r = await client.subscribe(clientId, agentKey);
      if (isFinalAuthFailure(r)) deps.onConn("auth");
      return r;
    },
    unsubscribe: (clientId, agentKey) => client.unsubscribe(clientId, agentKey),
    page: async <T = unknown>(agentKey: string, before: string, limit?: number) => {
      const r = (await client.page(agentKey, before, limit)) as Result<T>;
      if (isFinalAuthFailure(r)) deps.onConn("auth");
      return r;
    },
  } satisfies HubTransport;
}
