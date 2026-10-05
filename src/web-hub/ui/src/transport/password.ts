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
import type {
  CmdOutcome,
  PasswordTransport,
  PreviewOutcome,
  PreviewTransport,
  Result,
  SpawnDirsOutcome,
  SpawnListOutcome,
  SpawnOutcome,
  SpawnStopOutcome,
  SpawnTransport,
  UploadBeginOk,
  UploadChunkOk,
  UploadCommitOk,
  UploadOutcome,
  UploadTransport,
} from "./types.js";

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
 *
 * C4 (control-plan §7.2): `/api/cmd` and `/api/dialog` join the same set — the client's
 * `command()`/`dialog()` are one-shot too, so a 401 there is exactly the same "lost cookie
 * session" signal and must remount `LoginView` identically.
 */
const REST_AUTH_PATHS: ReadonlySet<string> = new Set([API.subscribe, API.unsubscribe, API.cmd, API.dialog]);

function isRestAuthEndpoint(url: string): boolean {
  // SP11 (web-hub-spawn plan, arch §8.3): `/api/headless*` joins the 401 ⇒ onConn("auth")
  // set — the password client's spawn namespace deliberately does NOT fire it itself (the
  // way upload's does), so this wrapper is the single reporter and nothing double-fires.
  // `url.startsWith(API.headless)` covers `headless`, `headlessDirs` and `<id>/stop`.
  // PV4 (web-hub-preview plan v3 §4.6): `/api/preview` is the same class — the client's
  // preview namespace never fires onConn itself, this wrapper is the single reporter.
  return (
    REST_AUTH_PATHS.has(url) ||
    url.startsWith(API.history) ||
    url.startsWith(API.headless) ||
    url.startsWith(API.preview)
  );
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
    command: (req) => client.command(req) as Promise<CmdOutcome>,
    dialog: (req) => client.dialog(req) as Promise<CmdOutcome>,
    login: (username, password) => client.login(username, password),
    logout: () => client.logout(),
    upload: {
      // U4b (web-hub-upload plan §1.2): thin casts over the logic client's upload namespace.
      // 401 → onConn("auth") lives INSIDE the client here (password mode has no relogin dance) —
      // REST_AUTH_PATHS above deliberately excludes the upload paths so it never double-fires.
      begin: (p, signal) => client.upload.begin(p, signal) as Promise<UploadOutcome<UploadBeginOk>>,
      chunk: (p, signal) => client.upload.chunk(p, signal) as Promise<UploadOutcome<UploadChunkOk>>,
      commit: (p, signal) => client.upload.commit(p, signal) as Promise<UploadOutcome<UploadCommitOk>>,
      abort: (p) => client.upload.abort(p) as Promise<UploadOutcome<{ ok: boolean }>>,
    } satisfies UploadTransport,
    spawn: {
      // SP11 (web-hub-spawn plan, arch §8.3): thin casts over the logic client's spawn
      // namespace. 401 ⇒ onConn("auth") is reported by the fetch wrapper above
      // (`isRestAuthEndpoint` covers `/api/headless*`) — never inside the client.
      list: () => client.spawn.list() as Promise<SpawnListOutcome>,
      dirs: () => client.spawn.dirs() as Promise<SpawnDirsOutcome>,
      start: (req) => client.spawn.start(req) as Promise<SpawnOutcome>,
      stop: (spawnId, force) => client.spawn.stop(spawnId, force) as Promise<SpawnStopOutcome>,
    } satisfies SpawnTransport,
    preview: {
      // PV4 (web-hub-preview plan v3 §4.6): thin cast over the logic client's preview
      // namespace. 401 ⇒ onConn("auth") is reported by the fetch wrapper above
      // (`isRestAuthEndpoint` covers `/api/preview`) — never inside the client.
      fetch: (req, opts) => client.preview.fetch(req, opts) as Promise<PreviewOutcome>,
    } satisfies PreviewTransport,
  } satisfies PasswordTransport;
}
