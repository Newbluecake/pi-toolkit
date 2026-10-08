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
import type {
  CmdOutcome,
  HubTransport,
  PreviewOutcome,
  PreviewProbeOutcome,
  PreviewTransport,
  RemoveAgentOutcome,
  RemoveTarget,
  Result,
  RunPageResult,
  RunSubResult,
  SpawnDirsOutcome,
  SpawnListOutcome,
  SpawnOutcome,
  SpawnPrefsOutcome,
  SpawnStopOutcome,
  SpawnTransport,
  UploadBeginOk,
  UploadChunkOk,
  UploadCommitOk,
  UploadOutcome,
  UploadTransport,
  WorktreeDiffTransport,
  WtDiffOutcome,
} from "./types.js";
import type { WtDiffFileList, WtDiffFilePayload } from "@protocol/worktree-diff.js";

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
  } satisfies HubTransport;
}
