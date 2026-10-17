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
import type { AvatarDeleteOutcome, AvatarFetchOutcome, AvatarWriteOutcome } from "@protocol/avatar.js";
import type {
  CmdOutcome,
  HubTransport,
  LoadTopOutcome,
  VersionInfoOutcome,
  PreviewDownloadOutcome,
  PreviewHtmlCapOutcome,
  PreviewOutcome,
  PreviewProbeOutcome,
  PreviewTransport,
  PrivacyOutcome,
  PrivacyTransport,
  ProxyListFetchOutcome,
  ProxyOpenFetchOutcome,
  ProxyStopFetchOutcome,
  ProxyTransport,
  RemoveAgentOutcome,
  RemoveTarget,
  Result,
  RunPageResult,
  RunSubResult,
  SpawnDirsOutcome,
  SpawnListOutcome,
  SpawnMkdirOutcome,
  SpawnRelaunchOutcome,
  SpawnOutcome,
  SpawnPrefsOutcome,
  SpawnStopOutcome,
  SpawnTransport,
  SpawnHistoryOutcome,
  UploadBeginOk,
  UploadChunkOk,
  UploadCommitOk,
  UploadOutcome,
  UploadTransport,
  WorktreeDiffTransport,
  WorktreeGraphTransport,
  WtDiffOutcome,
} from "./types.js";
import type { WtDiffFileList, WtDiffFilePayload } from "@protocol/worktree-diff.js";
import type { WtGraphPayload } from "@protocol/worktree-graph.js";

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

/** The same final-E_AUTH rule `command`/`dialog` apply, for the four upload endpoints: the
 * client's `withRelogin` already replayed once through a silent re-login, so a *final* E_AUTH
 * means the stored token itself is dead — flip to the login view (never a double show:
 * `useHub.ts`'s reducer no-ops a repeated `conn:auth`). */
async function withAuthNotice<T>(deps: TokenTransportDeps, run: () => Promise<T>): Promise<T> {
  const r = await run();
  if (
    typeof r === "object" &&
    r !== null &&
    (r as { ok?: unknown }).ok === false &&
    (r as { error?: unknown }).error === "E_AUTH"
  ) {
    deps.onConn("auth");
  }
  return r;
}

export function createTokenTransport(deps: TokenTransportDeps): HubTransport {
  const wrappedDeps: TokenTransportDeps = {
    ...deps,
    fetch: async (url, init) => {
      const r = await deps.fetch(url, init);
      // F5 (fleet-drawer §6.5): `/api/run/unsubscribe` joins `/api/unsubscribe` — both are
      // fire-and-forget with no return value to inspect, so the fetch wrapper is the only
      // place a dead-session 401 can surface (same class as the verifier fix above).
      if (r.status === 401 && (url === API.unsubscribe || url === API.runUnsubscribe)) deps.onConn("auth");
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
    // F5 (fleet-drawer §6.5): the three `/api/run/*` endpoints — thin casts over the logic
    // client's methods (which already did the withRelogin replay), plus the same final-E_AUTH
    // rule as subscribe/page (runUnsubscribe is fire-and-forget: only the fetch wrapper above
    // reports its 401). `transport-contract.test.ts`'s shared run suite pins wire parity with
    // the password adapter.
    runSubscribe: async (clientId, agentKey, runId) => {
      const r = (await client.runSubscribe(clientId, agentKey, runId)) as RunSubResult;
      if (isFinalAuthFailure(r)) deps.onConn("auth");
      return r;
    },
    runUnsubscribe: (clientId, agentKey, runId) => client.runUnsubscribe(clientId, agentKey, runId),
    runPage: async <T = unknown>(agentKey: string, runId: string, before: string, limit?: number) => {
      const r = (await client.runPage(agentKey, runId, before, limit)) as RunPageResult<T>;
      if (isFinalAuthFailure(r)) deps.onConn("auth");
      return r;
    },
    page: async <T = unknown>(agentKey: string, before: string, limit?: number) => {
      const r = (await client.page(agentKey, before, limit)) as Result<T>;
      if (isFinalAuthFailure(r)) deps.onConn("auth");
      return r;
    },
    command: async (req) => {
      // §7.2: the client already replays once through withRelogin on a 401; a FINAL E_AUTH
      // means the stored token itself is dead — flip to the login view (same rule as
      // subscribe/page above).
      const r = (await client.command(req)) as CmdOutcome;
      if (isFinalAuthFailure(r)) deps.onConn("auth");
      return r;
    },
    dialog: async (req) => {
      const r = (await client.dialog(req)) as CmdOutcome;
      if (isFinalAuthFailure(r)) deps.onConn("auth");
      return r;
    },
    upload: {
      // U4b (web-hub-upload plan §1.2): thin casts over the logic client's upload namespace —
      // `transport-contract.test.ts`'s shared upload suite pins both adapters' wire behavior.
      begin: (p, signal) =>
        withAuthNotice(deps, () => client.upload.begin(p, signal) as Promise<UploadOutcome<UploadBeginOk>>),
      chunk: (p, signal) =>
        withAuthNotice(deps, () => client.upload.chunk(p, signal) as Promise<UploadOutcome<UploadChunkOk>>),
      commit: (p, signal) =>
        withAuthNotice(deps, () => client.upload.commit(p, signal) as Promise<UploadOutcome<UploadCommitOk>>),
      abort: (p) => withAuthNotice(deps, () => client.upload.abort(p) as Promise<UploadOutcome<{ ok: boolean }>>),
    } satisfies UploadTransport,
    spawn: {
      // SP11 (web-hub-spawn plan, arch §8.3): thin casts over the logic client's spawn
      // namespace — the client already shapes the arch §8.2 outcomes; the same final-E_AUTH
      // rule as upload applies (withRelogin already replayed once inside the client).
      list: () => withAuthNotice(deps, () => client.spawn.list() as Promise<SpawnListOutcome>),
      dirs: () => withAuthNotice(deps, () => client.spawn.dirs() as Promise<SpawnDirsOutcome>),
      start: (req) => withAuthNotice(deps, () => client.spawn.start(req) as Promise<SpawnOutcome>),
      stop: (spawnId, force) =>
        withAuthNotice(deps, () => client.spawn.stop(spawnId, force) as Promise<SpawnStopOutcome>),
      // default-model plan F1 (§3 ④): POST /api/headless/prefs — same thin-cast rule (the
      // client already replayed a 401 through `withRelogin`; the write is idempotent).
      setPrefs: (defaultModel) =>
        withAuthNotice(deps, () => client.spawn.setPrefs(defaultModel) as Promise<SpawnPrefsOutcome>),
      // session-history plan §4.7.1: GET /api/headless/history — same thin-cast rule (a GET,
      // side-effect free; the client's `withRelogin` replay is always safe).
      history: (q) => withAuthNotice(deps, () => client.spawn.history(q) as Promise<SpawnHistoryOutcome>),
      // spawn-dirmkdir: POST /api/headless/mkdir — same thin-cast rule (the client replayed a
      // 401 through `withRelogin`; a replayed create is safe — an existing name answers 409).
      mkdir: (path, name) => withAuthNotice(deps, () => client.spawn.mkdir(path, name) as Promise<SpawnMkdirOutcome>),
      // spawn-relaunch: POST /api/headless/relaunch — same thin-cast rule (the client replayed
      // a 401 through `withRelogin`; a replayed relaunch is safe — the hub's idempotent
      // non-terminal check answers `dup:true` instead of forking twice).
      relaunch: (spawnId) =>
        withAuthNotice(deps, () => client.spawn.relaunch(spawnId) as Promise<SpawnRelaunchOutcome>),
    } satisfies SpawnTransport,
    // web-hub-delete-session plan v2 §4.1/§5.3: thin cast over the logic client's `removeAgent`
    // — the same final-E_AUTH rule as upload/spawn (the client already replayed once through
    // `withRelogin`; the endpoint is idempotent so the replay is always safe).
    removeAgent: (target: RemoveTarget) =>
      withAuthNotice(deps, () => client.removeAgent(target) as Promise<RemoveAgentOutcome>),
    preview: {
      // PV4 (web-hub-preview plan v3 §4.6): thin cast over the logic client's preview
      // namespace. The client already replayed once through `withRelogin` on a 401 (GET ⇒
      // side-effect free), so a final `E_AUTH` means the stored token is dead — same
      // `withAuthNotice` rule as upload/spawn.
      fetch: (req, opts) => withAuthNotice(deps, () => client.preview.fetch(req, opts) as Promise<PreviewOutcome>),
      // 2026-10-07 修订「先探测后标记」: same final-E_AUTH rule for the batch probe — the
      // client already replayed once through `withRelogin` (a probe POST is read-only,
      // replay-safe).
      probe: (req, opts) => withAuthNotice(deps, () => client.preview.probe(req, opts) as Promise<PreviewProbeOutcome>),
      // preview-download: GET /api/preview?download=1 — same final-E_AUTH rule (a GET, the
      // client's `withRelogin` replay is side-effect free).
      download: (req, opts) =>
        withAuthNotice(deps, () => client.preview.download(req, opts) as Promise<PreviewDownloadOutcome>),
      // web-hub-html-preview plan v2 §5 (P2): POST /api/preview/html-cap — same final-E_AUTH
      // rule, but NO replay exists to fold in: the client's htmlCapPost is deliberately
      // one-shot (a mint is not idempotent), so this is the single 401 observation point and
      // `withAuthNotice` (never withRelogin) is exactly the right wrapper.
      htmlCap: (req, opts) =>
        withAuthNotice(deps, () => client.preview.htmlCap(req, opts) as Promise<PreviewHtmlCapOutcome>),
    } satisfies PreviewTransport,
    worktreeDiff: {
      // worktree-diff plan v3.1 §4.6 (D4): thin casts over the logic client's wtdiff
      // namespace. The client already replayed once through `withRelogin` on a 401 (GET ⇒
      // side-effect free), so a final `E_AUTH` means the stored token is dead — same
      // `withAuthNotice` rule as preview/upload/spawn. 409 `E_STALE_CTX` never gets retried
      // at this layer (§4.5: the UI owns the one-shot list re-pull).
      files: (req, opts) =>
        withAuthNotice(deps, () => client.worktreeDiff.files(req, opts) as Promise<WtDiffOutcome<WtDiffFileList>>),
      file: (req, opts) =>
        withAuthNotice(deps, () => client.worktreeDiff.file(req, opts) as Promise<WtDiffOutcome<WtDiffFilePayload>>),
    } satisfies WorktreeDiffTransport,
    worktreeGraph: {
      // worktree-graph plan v2 §4.4 (P4): thin cast over the logic client's wtgraph
      // namespace (`wtgraphGet` reuses `wtdiffGet`'s capped-JSON GET flow with the wtgraph
      // cap/deadline/parser). The client already replayed once through `withRelogin` on a
      // 401 (GET ⇒ side-effect free), so a final `E_AUTH` means the stored token is dead —
      // same `withAuthNotice` rule as preview/worktreeDiff. Error bodies (504
      // `E_DEADLINE{reason:"log-timeout"}` etc.) ride verbatim; this layer never retries on
      // its own (the UI owns the retry, §4.3).
      graph: (req, opts) =>
        withAuthNotice(deps, () => client.worktreeGraph.graph(req, opts) as Promise<WtDiffOutcome<WtGraphPayload>>),
    } satisfies WorktreeGraphTransport,
    // sysload plan §7.1/§7.3/§10 (package P4): thin cast over the logic client's `loadTop` —
    // same final-E_AUTH rule as worktreeGraph/preview above (a GET, replayed once by the
    // client's `withRelogin` on a 401).
    loadTop: (signal) => withAuthNotice(deps, () => client.loadTop(signal) as Promise<LoadTopOutcome>),
    // web-hub-version plan §5.1 (V2): thin cast over the logic client's `versionInfo` — same
    // final-E_AUTH rule as loadTop above (a GET, replayed once by the client's `withRelogin`
    // on a 401; a final E_AUTH means the stored token is dead).
    versionInfo: (signal) => withAuthNotice(deps, () => client.versionInfo(signal) as Promise<VersionInfoOutcome>),
    // web-hub-avatar plan v2.1 §5 (package C): GET is safe to replay through the client's
    // token relogin path; writes are deliberately one-shot and never replayed.
    avatar: {
      fetch: (opts) => withAuthNotice(deps, () => client.avatar.fetch(opts) as Promise<AvatarFetchOutcome>),
      upload: (bytes, opts) =>
        withAuthNotice(deps, () => client.avatar.upload(bytes, opts) as Promise<AvatarWriteOutcome>),
      remove: () => withAuthNotice(deps, () => client.avatar.remove() as Promise<AvatarDeleteOutcome>),
    },
    // web-hub-privacy plan v2.1 (P1): thin casts over the logic client's `privacy` namespace —
    // same final-E_AUTH rule as avatar above (the client replays once through `withRelogin` on a
    // 401; a final E_AUTH means the stored token is dead). A wrong-password 200 verdict
    // (`data.ok:false`) and a limiter 429 (`retryAfterS`) ride through verbatim — this layer
    // never retries on its own.
    privacy: {
      verify: (password) => withAuthNotice(deps, () => client.privacy.verify(password) as Promise<PrivacyOutcome>),
      lock: (req) => withAuthNotice(deps, () => client.privacy.lock(req) as Promise<PrivacyOutcome>),
    } satisfies PrivacyTransport,
    // web-hub-proxy plan v2 §8 (X2): thin casts over the logic client's `proxy` namespace — same
    // final-E_AUTH rule as privacy above (the client replays once through `withRelogin` on a
    // 401). Error bodies (`E_PROXY_DENIED{reason}` etc.) ride verbatim; never retried here.
    proxy: {
      open: (req, opts) => withAuthNotice(deps, () => client.proxy.open(req, opts) as Promise<ProxyOpenFetchOutcome>),
      list: (opts) => withAuthNotice(deps, () => client.proxy.list(opts) as Promise<ProxyListFetchOutcome>),
      stop: (id, opts) => withAuthNotice(deps, () => client.proxy.stop(id, opts) as Promise<ProxyStopFetchOutcome>),
    } satisfies ProxyTransport,
  } satisfies HubTransport;
}
