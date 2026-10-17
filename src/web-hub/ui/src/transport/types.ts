/**
 * Transport abstraction (vue-plan.md v2.1 §3.4, §5.2 — P0 frozen). Both `@logic/token-client.js`
 * (`createClient`, extracted in this same P0 package from the legacy `app.js`) and
 * `@logic/password-client.js` (`createPasswordClient`) are adapted to `satisfies HubTransport` /
 * `satisfies PasswordTransport` by P1's `transport/{token,password}.ts` — never re-implemented
 * here. `tests/web-hub/ui/transport-contract.test.ts` (P1) runs the identical suite against both
 * adapters so the two transports can never silently diverge again (the exact regression class
 * 78dd76b was: password client missing `subscribe`/`page`).
 */
import type { PreviewDims, PreviewDirListing, PreviewImageMime, PreviewProbeKind } from "@protocol/preview.js";
import type { PreviewHtmlCapResponseBody } from "@protocol/preview-html.js";
import type { WtDiffFileList, WtDiffFilePayload } from "@protocol/worktree-diff.js";
import type { WtGraphPayload } from "@protocol/worktree-graph.js";
import type { RunTxReason } from "@protocol/run-transcript.js";
import type { AgentRemoveErrorReason } from "@protocol/http-contract.js";
import type { AvatarDeleteOutcome, AvatarFetchOutcome, AvatarWriteOutcome } from "@protocol/avatar.js";
import type { LoadTopWire } from "@protocol/messages.js";
import type { VersionInfoWire } from "@protocol/version-info.js";
import type {
  ForkReason,
  HistoryLiveWire,
  HistoryPage,
  HistoryQueryWire,
  ProofGap,
} from "@protocol/session-history.js";
import type {
  DirEntryWire,
  SpawnAccepted,
  SpawnPolicyWire,
  SpawnPrefsWire,
  SpawnRecordPublic,
  SpawnRequestBody,
  SpawnState,
} from "@protocol/spawn.js";

/** SSE frame or local UI/transport event — same shape `@logic/state.js`'s `reduce(state, msg)` consumes. */
export interface Msg {
  readonly event: string;
  readonly data: unknown;
  readonly id?: number;
}

export type ConnState = "connecting" | "open" | "reconnecting" | "auth";

export type Result<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string };

export interface TransportHooks {
  onMessage(msg: Msg): void;
  onConn(state: ConnState): void;
}

/**
 * `HistoryPayload` is intentionally `unknown`-shaped here (not imported from
 * `@protocol/http-contract.js`) — `page()`'s wire payload is exactly `HistoryPayload`, but this
 * module keeps that one reference structural so its historical "typecheck standalone" property
 * survives for the pre-spawn surface. SP11's spawn types DO import from `@protocol/spawn.js`
 * (type-only — erased at compile time, so still zero runtime/bundle cost): the frozen protocol
 * module is the single source of truth for those wire shapes and a hand mirror could drift.
 */
export interface CmdRequest {
  agentKey: string;
  id: string;
  op: "prompt" | "abort" | "steer_subagent" | "abort_subagent" | "command" | "recall";
  text?: string;
  deliver?: "steer" | "followUp";
  runId?: string;
  name?: string;
  args?: string;
  confirm?: true;
  /** steer-recall plan §2.3 S2 (P-ui): the held/returned row's cmdId to recall — identify-only,
   * never carries `expect` (S5). */
  target?: string;
  expect?: { sessionId?: string };
  queryOnly?: true;
}
export interface DialogRequest {
  agentKey: string;
  id: string;
  dialogId: string;
  epoch: string;
  action: "answer" | "cancel";
  answers?: readonly { selected: readonly string[]; other: string | null }[];
  queryOnly?: true;
}
export type CmdOutcome =
  | { readonly ok: true; readonly data?: unknown; readonly dup?: boolean }
  | {
      readonly ok: false;
      readonly error: string;
      readonly message?: string;
      readonly retryable: boolean;
      readonly retryAfterS?: number;
      readonly effect?: "none" | "unknown";
    };

export interface HubTransport {
  readonly mode: "token" | "password";
  start(): Promise<void>;
  close(): void;
  subscribe(clientId: string, agentKey: string): Promise<{ ok: boolean; error?: string }>;
  unsubscribe(clientId: string, agentKey: string): Promise<void>;
  page<T = unknown>(agentKey: string, before: string, limit?: number): Promise<Result<T>>;
  /** fleet-drawer plan §3.4/§6.5 (F5): POST /api/run/subscribe. Optional per the frozen-transport
   * convention (test fakes / future transports may omit it) — `useHub` degrades a missing
   * method to an `E_UNSUPPORTED` error state in `runTx`. Both real adapters always provide it. */
  runSubscribe?(clientId: string, agentKey: string, runId: string): Promise<RunSubResult>;
  /** fleet-drawer §3.4/§6.5 (F5): POST /api/run/unsubscribe — idempotent, fire-and-forget. */
  runUnsubscribe?(clientId: string, agentKey: string, runId: string): Promise<void>;
  /** fleet-drawer §3.4/§6.5 (F5): GET /api/run/history — one older page (§3.6's `message` denial
   * reason rides `reason` so the UI can disable "load older" for the deny classes). */
  runPage?<T = unknown>(agentKey: string, runId: string, before: string, limit?: number): Promise<RunPageResult<T>>;
  command(req: CmdRequest): Promise<CmdOutcome>;
  dialog(req: DialogRequest): Promise<CmdOutcome>;
  /** web-hub-upload plan §1.2/§4.3 (package U4b): the chunked-upload endpoints. Optional so
   * test fakes / future transports can omit it — `useControl` only mounts the tray driver
   * (`ControlHandle.uploads`) when a transport provides one; both real adapters always do. */
  readonly upload?: UploadTransport;
  /** web-hub-spawn plan SP11 / arch §8.3: the `/api/headless*` endpoints. Optional for exactly
   * the same reason `upload` is — test fakes / future transports may omit it; `useSpawn`
   * degrades to `E_UNSUPPORTED` then. Both real adapters always provide it. */
  readonly spawn?: SpawnTransport;
  /** web-hub-delete-session plan v2 §4.1/§5.3: `POST /api/agents/remove`. Optional per the
   * frozen-transport convention — a transport without it (test fakes) degrades to
   * `E_UNSUPPORTED` in `useHub.ts`'s `removeAgent`. Both real adapters always provide it. */
  removeAgent?(target: RemoveTarget): Promise<RemoveAgentOutcome>;
  /** web-hub-preview plan v3 §4.6 (PV4): `GET /api/preview`. Optional for the same reason as
   * `upload`/`spawn` — `usePreview`'s scope derivation (`previewScopeOf`) yields `null`
   * without it and every path renders as plain text. Both real adapters always provide it. */
  readonly preview?: PreviewTransport;
  /** web-hub-avatar plan v2.1 §5: the single fixed hub-side avatar surface. */
  readonly avatar?: AvatarTransport;
  /** web-hub-privacy plan v2.1 (P1): the privacy-lock surface. Optional per the
   * frozen-transport convention (test fakes may omit it); both real adapters always provide
   * it. P2's UI additionally gates every affordance on the hub's `privacy.v1` cap. */
  readonly privacy?: PrivacyTransport;
  /** worktree-diff plan v3.1 §4.6 (package D4): the two `GET /api/worktree-diff/*` endpoints.
   * Optional per the frozen-transport convention (test fakes / future transports may omit it) —
   * `useWorktreeDiff`'s scope derivation (D5) yields `null` without it and the panel stays
   * byte-identical to today (I8). Both real adapters always provide it. */
  readonly worktreeDiff?: WorktreeDiffTransport;
  /** worktree-graph plan v2 §4.4 (package P4): `GET /api/worktree-graph`. Optional per the
   * frozen-transport convention (test fakes / future transports may omit it) — P5's scope
   * derivation (`wtgraphScopeOf`) yields `null` without it and the panel's graph section
   * never renders (I8: without the cap the panel DOM stays byte-identical to today). Both
   * real adapters always provide it. */
  readonly worktreeGraph?: WorktreeGraphTransport;
  /** sysload plan §7.1/§7.3/§10 (package P4): `GET /api/load/top`. Optional per the
   * frozen-transport convention (test fakes / future transports may omit it) — `LoadCard`'s
   * top-process section degrades to its "不可用" copy without it, same posture as `preview`/
   * `worktreeDiff`/`worktreeGraph` above. Both real adapters always provide it (implemented by
   * P4's `transport/{token,password}.ts`, not this P0 declaration). */
  loadTop?(signal?: AbortSignal): Promise<LoadTopOutcome>;
  /** web-hub-version plan §5.1 (V2): `GET /api/version` — the version/compat snapshot for the
   * version chip + panel. Optional per the frozen-transport convention (test fakes / future
   * transports may omit it); `useVersionInfo` treats a missing method exactly like a missing
   * `version.v1` cap (phase `unsupported`, never any request — I8: old-hub DOM stays
   * byte-identical). Both real adapters always provide it. */
  versionInfo?(signal?: AbortSignal): Promise<VersionInfoOutcome>;
}

/**
 * sysload plan §7.1/§10 (package P0 → P4): `GET /api/load/top`'s outcome — same two-half shape
 * as `SpawnDirsOutcome`/`PreviewProbeOutcome` above (`status` 0 for client-local codes:
 * `E_NETWORK`/`E_DEADLINE`/`E_UNSUPPORTED`).
 */
export type LoadTopOutcome =
  | { readonly ok: true; readonly data: LoadTopWire }
  | { readonly ok: false; readonly error: string; readonly status?: number };

/** web-hub-version plan §5.1 (V2): `GET /api/version`'s outcome — same two-half shape as
 * `LoadTopOutcome` above (`status` 0 for client-local codes: `E_NETWORK`/`E_DEADLINE`/
 * `E_ABORT`; the hub's 503 `E_BUSY` / 504 `E_DEADLINE` ride verbatim as HTTP-status errors).
 * NOTE: deliberately NOT V0's hub-port `VersionInfoOutcome` (`{ok:false; code:"E_BUSY"|…}`)
 * — this is the browser-side transport convention, same as every other endpoint here. */
export type VersionInfoOutcome =
  | { readonly ok: true; readonly data: VersionInfoWire }
  | { readonly ok: false; readonly error: string; readonly status?: number };

/** `@logic/password-client.js`'s `login()` return shape (JSDoc-documented there; mirrored here). */
export type LoginResult =
  | { readonly ok: true; readonly initialPassword: boolean }
  | { readonly ok: false; readonly kind: "invalid" | "not-allowed" | "network" | "busy-exhausted" }
  | { readonly ok: false; readonly kind: "saturated" | "throttled"; readonly retryAfterS: number }
  | { readonly ok: false; readonly kind: "unknown"; readonly status: number };

export interface PasswordTransport extends HubTransport {
  readonly mode: "password";
  login(username: string, password: string): Promise<LoginResult>;
  logout(): Promise<void>;
}

// ---------------------------------------------------------------------------
// web-hub-fleet-drawer plan §3.4/§6.5 (package F5) — the `/api/run/*` transport surface
// ---------------------------------------------------------------------------

/** `runSubscribe`'s outcome — 202 `{ok:true}` (the snapshot rides SSE `run_history`), or the
 * §3.4/§3.6 error body with its `message` denial reason mapped to `reason`. */
export type RunSubResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string; readonly reason?: RunTxReason };

/** `runPage`'s outcome — a `RunHistoryPayload` page (`live` always false per §3.4), or the same
 * error shape as `RunSubResult`. */
export type RunPageResult<T = unknown> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string; readonly reason?: RunTxReason };

// ---------------------------------------------------------------------------
// web-hub-spawn plan SP11 / arch §8.2–§8.3 — the `/api/headless*` transport surface
// ---------------------------------------------------------------------------

/**
 * `start()`'s outcome (arch §8.2's POST row): 202 ⇒ the accepted record handle (`dup:true`
 * when the idempotent replay of the same `id` hit the hub's LRU — the same-id resend after a
 * network error/timeout, plan §3.2). The error half keeps the cmd-style mapping plus the two
 * 409 `E_CONFIRM_REQUIRED` fields the confirm view renders (`resolvedCwd` is the pinned
 * realpath; `reason` says why a confirm is needed).
 */
export type SpawnOutcome =
  | { readonly ok: true; readonly data: SpawnAccepted }
  | {
      readonly ok: false;
      readonly error: string;
      readonly message?: string;
      readonly retryable: boolean;
      readonly retryAfterS?: number;
      /** 409 `E_CONFIRM_REQUIRED` (arch §6.3): the admitted realpath to echo back as `expectCwd`. */
      readonly resolvedCwd?: string;
      readonly reason?: string;
      /** session-history plan §3.6 (409 `E_CONFIRM_REQUIRED{reason:"session-open"}`): why the
       * hub insists on a fork + why it could not establish "no occupancy detected". Riding
       * the outcome (not just the flow) keeps `useNewSession`'s confirming phase lossless. */
      readonly forkReason?: ForkReason;
      readonly proofGap?: ProofGap;
      readonly live?: HistoryLiveWire;
    };

export type SpawnListOutcome =
  | {
      readonly ok: true;
      readonly policy: SpawnPolicyWire;
      readonly items: readonly SpawnRecordPublic[];
      /** default-model plan F1 (D1/D2): the hub-wide 「新建会话默认模型」 preference riding
       * `GET /api/headless` (H2). Absent on a pre-feature hub — every reader treats a missing
       * field as "unknown", never as "cleared". */
      readonly prefs?: SpawnPrefsWire;
    }
  /** 404 rides verbatim (arch §8.3: feature off / LAN `lan:"off"` ⇒ UI treats pick-dir as unavailable). */
  | { readonly ok: false; readonly error: string; readonly status: number };

/**
 * default-model plan F1 (§3 ④): `POST /api/headless/prefs`'s outcome — 200 `{prefs}` rides as
 * the ok half; the error half keeps the wire `reason` (`"model-invalid"` on a 400
 * `E_BAD_REQUEST`) and `status` so the settings card can distinguish a local-validation echo
 * from a persist failure (503 `E_LAUNCHER{reason:"persist"}`). `status` is 0 for client-local
 * codes (`E_NETWORK` / `E_DEADLINE` / `E_UNSUPPORTED`).
 */
export type SpawnPrefsOutcome =
  | { readonly ok: true; readonly prefs: SpawnPrefsWire }
  | {
      readonly ok: false;
      readonly error: string;
      readonly message?: string;
      readonly retryable: boolean;
      readonly reason?: string;
      readonly status?: number;
    };

export type SpawnDirsOutcome =
  | { readonly ok: true; readonly recent: readonly DirEntryWire[]; readonly partial?: true }
  | { readonly ok: false; readonly error: string; readonly status: number };

export type SpawnStopOutcome =
  { readonly ok: true; readonly state: SpawnState } | { readonly ok: false; readonly error: string };

/** arch §8.3's `SpawnTransport` — the four `/api/headless*` endpoints, same shape on both adapters. */
export interface SpawnTransport {
  list(): Promise<SpawnListOutcome>;
  dirs(): Promise<SpawnDirsOutcome>;
  start(req: SpawnRequestBody): Promise<SpawnOutcome>;
  stop(spawnId: string, force?: boolean): Promise<SpawnStopOutcome>;
  /** session-history plan §4.7.1: `GET /api/headless/history` (X-PWH). The logic clients
   * structurally narrow the 200 body (non-conforming items dropped; a missing `stats.enum`
   * counts as complete); a 409 keeps its `reason` (`"cursor-expired"`). Optional per the
   * frozen-transport convention — `useSpawn` degrades a missing method to `E_UNSUPPORTED`
   * and the 「历史会话…」 entry never renders without the `spawn.history.v1` cap anyway. Both
   * real adapters always provide it. */
  history?(q: HistoryQueryWire): Promise<SpawnHistoryOutcome>;
  /** default-model plan F1 (§3 ④): `POST /api/headless/prefs` — set (`provider/id`) or clear
   * (`""`) the hub-wide default model. Optional per the frozen-transport convention (test
   * fakes / a pre-feature transport may omit it — `createSpawn` degrades a missing method to
   * `E_UNSUPPORTED`, and the settings card never calls it without the `spawn.model.v1` cap).
   * Both real adapters always provide it. */
  setPrefs?(defaultModel: string): Promise<SpawnPrefsOutcome>;
  /** spawn-dirmkdir: `POST /api/headless/mkdir` — create ONE folder inside an admitted parent
   * (the DirPicker browse panel's 「新建文件夹」). Optional per the frozen-transport
   * convention — `createSpawn` degrades a missing method to `E_UNSUPPORTED`, and the panel
   * only offers the button while its browse surface (`preview.dir.v1`) exists anyway. Both
   * real adapters always provide it. */
  mkdir?(path: string, name: string): Promise<SpawnMkdirOutcome>;
  /** spawn-relaunch: `POST /api/headless/relaunch` — re-fork a terminal managed record's
   * session (the offline card's 「点击重新拉起」). Optional per the frozen-transport
   * convention — `createSpawn` degrades a missing method to `E_UNSUPPORTED`, and the
   * affordance never renders without the `spawn.relaunch.v1` cap anyway. Both real adapters
   * always provide it. */
  relaunch?(spawnId: string): Promise<SpawnRelaunchOutcome>;
}

/** session-history plan §4.7.1's frozen outcome: a narrowed `HistoryPage`, or the wire error
 * half (`status` 0 for client-local codes — the same convention as `SpawnPrefsOutcome`; a
 * 409 keeps `reason:"cursor-expired"`, a 503 is the retryable "busy" state). */
export type SpawnHistoryOutcome =
  | { readonly ok: true; readonly page: HistoryPage }
  | {
      readonly ok: false;
      readonly error: string;
      readonly status: number;
      readonly reason?: string;
      /** 429 only: the `Retry-After` header (seconds). */
      readonly retryAfterS?: number;
    };

/** spawn-dirmkdir: `POST /api/headless/mkdir`'s outcome. The 200 `{path}` echo is the created
 * directory's RESOLVED absolute path; the error half keeps `reason` verbatim
 * (`"name-invalid"` / `"path-invalid"` / `"denylist"` / `"virtual-fs"` / `"exists"` /
 * `"not-directory"` / `"permission"` / `"readonly"` / …) for the DirPicker's classified
 * error line, `status` 0 for client-local codes (same convention as the other outcomes). */
export type SpawnMkdirOutcome =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly error: string;
      readonly status: number;
      readonly reason?: string;
      readonly retryAfterS?: number;
    };

/** spawn-relaunch: `POST /api/headless/relaunch`'s outcome — 202 `{spawnId, state, dup?}`
 * (`dup:true` = the record was already non-terminal: a relaunch in flight or the session alive
 * again — idempotent, no second fork). The error half keeps `reason` verbatim
 * (`"exit-unconfirmed"` on 409 `E_AGENT_ONLINE`, `"no-session"`/`"removing"` on 409
 * `E_BAD_REQUEST`, `"session-missing"`/`"session-invalid"` on 410 `E_SPAWN_GONE`) plus
 * `status` (0 for client-local codes, same convention as the other outcomes) so AgentList's
 * `classifyRelaunchError` can bucket it. */
export type SpawnRelaunchOutcome =
  | { readonly ok: true; readonly spawnId: string; readonly state: SpawnState; readonly dup?: boolean }
  | {
      readonly ok: false;
      readonly error: string;
      readonly status: number;
      readonly reason?: string;
      readonly message?: string;
      readonly retryAfterS?: number;
    };

// ---------------------------------------------------------------------------
// web-hub-delete-session plan v2 §4.1/§5.3 — the `POST /api/agents/remove` transport surface
// ---------------------------------------------------------------------------

/** `AgentCard` sends `{agentKey}`, `SpawnRow` sends `{spawnId}` — the same wire union as
 * `protocol/http-contract.ts`'s `AgentRemoveRequest` (not imported: this module's spawn types
 * above already set the precedent of hand-mirroring narrow wire unions rather than reaching
 * into the frozen protocol face for every last shape). */
export type RemoveTarget = { readonly agentKey: string } | { readonly spawnId: string };

/**
 * `removeAgent()`'s outcome (§5.3): 200 ⇒ `{removed:true}` (deletion done, or already absent —
 * idempotent), 202 ⇒ `{removed:false, pending:true, spawnId, state:"stopping"}` (entered, or
 * already in, the stop grace). The error half mirrors `SpawnOutcome`'s without the
 * spawn-specific `resolvedCwd` field: `reason` carries `AgentRemoveErrorReason` ("online" |
 * "exit-unconfirmed" | "lan-off") for `classifyRemoveError` (`@logic/remove.js`) to bucket.
 */
export type RemoveAgentOutcome =
  | { readonly ok: true; readonly removed: boolean; readonly pending?: true; readonly spawnId?: string }
  | {
      readonly ok: false;
      readonly error: string;
      readonly message?: string;
      readonly reason?: string;
      readonly retryAfterS?: number;
    };

/**
 * Anti-drift pin for `AgentRemoveErrorReason` (verifier r1 #2, P2 打回): the protocol type has
 * no runtime export (it is a bare TS union, nothing to `import` at runtime), so this exhaustive
 * record is the enforcement mechanism instead — TypeScript's excess/missing-property check on
 * `{ [K in AgentRemoveErrorReason]: true }` makes it a COMPILE ERROR the moment the protocol
 * union gains or loses a member without this file being updated in lockstep. The three named
 * constants below (not just the derived array) give `@logic/remove.js` typo-safe, individually
 * importable literals — `classifyRemoveError` imports THESE, never re-typing the strings.
 */
const AGENT_REMOVE_REASON_SET: { readonly [K in AgentRemoveErrorReason]: true } = {
  online: true,
  "exit-unconfirmed": true,
  "lan-off": true,
};
/** Derived from the exhaustiveness record above — every `AgentRemoveErrorReason` member, once. */
export const AGENT_REMOVE_ERROR_REASONS = Object.keys(AGENT_REMOVE_REASON_SET) as readonly AgentRemoveErrorReason[];
export const AGENT_REMOVE_REASON_ONLINE: AgentRemoveErrorReason = "online";
export const AGENT_REMOVE_REASON_UNCONFIRMED: AgentRemoveErrorReason = "exit-unconfirmed";
export const AGENT_REMOVE_REASON_LAN_OFF: AgentRemoveErrorReason = "lan-off";

// ---------------------------------------------------------------------------
// web-hub-upload plan §1.2 (package U4b) — the chunked-upload transport surface
// ---------------------------------------------------------------------------

export interface UploadBeginParams {
  readonly agentKey: string;
  /** `newCmdId()` — the hub validates it against its own `CMD_ID_RE` and uses it verbatim as the upload dir name. */
  readonly id: string;
  readonly name: string;
  readonly size: number;
  /** Raw `File.type` (possibly empty/absent — omitted then); the hub's `normalizeMime`d value in the commit reply is the only mime that ever enters an attachment block. */
  readonly mime?: string;
}

/** `begin`'s 200 body — `received > 0` on an idempotent re-`begin` means resume from there (§2.5). */
export interface UploadBeginOk {
  readonly id: string;
  /** Effective tier size for THIS listener (§1.3: loopback 4 MiB / LAN 1 MiB) — the planner's input. */
  readonly chunkBytes: number;
  readonly maxBytes: number;
  readonly received: number;
}

export interface UploadChunkOk {
  readonly received: number;
  /** §2.5 idempotency: `offset + len === received` replays answer `dup:true` instead of rewriting. */
  readonly dup?: boolean;
}

export interface UploadCommitOk {
  readonly id: string;
  /** Absolute on-disk path — the ONLY thing a prompt ever carries for an attachment (§3.1). */
  readonly path: string;
  readonly size: number;
  /** The hub-validated mime (`normalizeMime`), absent when none survived validation. */
  readonly mime?: string | null;
  readonly dedup?: boolean;
}

export interface UploadOutcomeErr {
  readonly ok: false;
  readonly error: string;
  readonly message?: string;
  readonly retryable: boolean;
  readonly retryAfterS?: number;
  /** §1.2: a 409 `E_UPLOAD_OFFSET` body carries the server's authoritative offset for resync. */
  readonly received?: number;
}

export type UploadOutcome<T> = { readonly ok: true; readonly data: T } | UploadOutcomeErr;

export interface UploadChunkParams {
  readonly id: string;
  readonly offset: number;
  /** Raw chunk bytes, sent as `application/octet-stream` (never JSON/base64). */
  readonly bytes: Uint8Array;
}

/**
 * The four `/api/upload/*` endpoints (§1.2), as exposed by both transports. `signal` (where
 * present) is the tray item's abort controller — merged with each call's internal timeout so
 * a remove/retry interrupts an in-flight POST immediately (whichever fires first wins).
 * Upload ops are never "re-executed" the way cmds are (idempotent by id/offset), so — unlike
 * `CmdOutcome` — there is no `effect` field.
 */
export interface UploadTransport {
  begin(p: UploadBeginParams, signal?: AbortSignal): Promise<UploadOutcome<UploadBeginOk>>;
  chunk(p: UploadChunkParams, signal?: AbortSignal): Promise<UploadOutcome<UploadChunkOk>>;
  commit(p: { readonly id: string }, signal?: AbortSignal): Promise<UploadOutcome<UploadCommitOk>>;
  /** Best-effort tray-removal cleanup (§4.2); takes no signal by design. */
  abort(p: { readonly id: string }): Promise<UploadOutcome<{ readonly ok: boolean }>>;
}

// ---------------------------------------------------------------------------
// web-hub-preview plan v3 §4.6 (package PV4) — the `GET /api/preview` transport surface
// ---------------------------------------------------------------------------

/** preview-download (2026-10-12 拍板): the `GET /api/preview?download=1` outcome. `blob`
 *  carries the raw bytes (`application/octet-stream` — no mime sniff, by design); the error
 *  half mirrors `PreviewOutcome`'s (`status` 0 for client-local codes, `reason` rides
 *  through for the classified UI line). */
export type PreviewDownloadOutcome =
  | { readonly ok: true; readonly kind: "download"; readonly blob: Blob; readonly size: number }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly reason?: string;
      readonly retryAfterS?: number;
    };

/**
 * §4.6's frozen `PreviewOutcome`. The success halves are HEADER-driven (§3.2/D2: metadata
 * rides `X-PWH-Preview-*`, the body is raw bytes): `image` carries the sniffed mime/dims plus
 * the body as a `Blob` (never a `blob:` URL — D1: CSP is not relaxed; `usePreview` converts
 * via FileReader to a `data:` URL); `text.size` is the FILE size (≥ body bytes when
 * `truncated`). The error half keeps the wire body's `reason`/`size`/`max`/`dims` so the
 * unsupported/tooLarge phases can render the server's detail; `status` is 0 for client-local
 * codes (`E_ABORT` / `E_DEADLINE` / `E_NETWORK` / `E_BAD_RESPONSE` — the last is a header-
 * contract violation: Kind/Content-Length/Content-Type malformed, checked BEFORE the body is
 * read, plan §4.6 transport paragraph) and for client-mirrored budget refusals
 * (`E_PREVIEW_TOO_LARGE` from `checkPreviewHeaders` keeps the server's 413 code with
 * `status: 0` — the request was aborted before the body ever left the server).
 *
 * dir-plan §5 P2→P3 (the P1 conditional item, closed): `PreviewDirOutcome` is now `fetch`'s
 * DECLARED return — the logic clients have resolved `kind:"dir"` outcomes at runtime since
 * P2, and P3's rewritten consumer (`composables/usePreview.ts`) narrows the union
 * exhaustively (text / image / dir). `PreviewOutcome` keeps its file-only shape as the
 * frozen face the contract test pins (`Extract<PreviewOutcome, {ok:true}>["kind"]` ≡
 * image|text) and as the type every pre-dir-plan fake/outcome literal still satisfies. An
 * un-opt-in-ed fetch never sees the dir variant at all: `Kind: dir` without `req.dir` is
 * `E_BAD_RESPONSE` in `checkPreviewHeaders` (§1.3's fetch path).
 */
export type PreviewOutcome =
  | {
      readonly ok: true;
      readonly kind: "image";
      readonly mime: PreviewImageMime;
      readonly size: number;
      readonly dims: PreviewDims;
      readonly blob: Blob;
    }
  | {
      readonly ok: true;
      readonly kind: "text";
      readonly size: number;
      readonly truncated: boolean;
      readonly text: string;
      /** chunked-plan §4.1 (P2a): this response's decoded body bytes (`X-PWH-Preview-Bytes`
       * / Content-Length) — present on NEW-hub responses and derivable for old ones, so the
       * truncated-copy fix ("仅显示前 {loaded}") works against both. */
      readonly bytes?: number;
      /** chunked-plan §4.1: the accepted offset/ident echo — present only on a `chunk=1`
       * request whose response passed the header gate (its absence on a first chunk means
       * "old hub / stripped headers ⇒ legacy one-shot display", §2.4). */
      readonly chunk?: { readonly offset: number; readonly ident: string };
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly reason?: string;
      readonly size?: number;
      readonly max?: number;
      readonly dims?: PreviewDims;
      readonly retryAfterS?: number;
    };

/**
 * dir-plan §5 P2: the FULL outcome union (`PreviewOutcome` plus the `dir` variant). Since P3
 * this IS `fetch`'s declared return; the alias is kept (rather than inlining the union into
 * `fetch`) because the contract test pins both halves separately — `PreviewOutcome`'s
 * success kinds ≡ image|text (the file-only face) and this union's ≡ image|text|dir.
 */
export type PreviewDirOutcome =
  | PreviewOutcome
  | {
      readonly ok: true;
      readonly kind: "dir";
      readonly listing: PreviewDirListing;
    };

/**
 * §4.6's `PreviewTransport` — one endpoint, same shape on both adapters (the shared suite in
 * `tests/web-hub/ui/transport-contract.test.ts` pins parity, SP11's spawn-namespace precedent).
 * The request carries `X-PWH: 1`; `signal` is `usePreview`'s per-open controller (a new open /
 * close / scope invalidation aborts the in-flight fetch); `maxPixels` is the CLIENT budget
 * (`clientImageBudget` — touch 20MP / desktop 40MP) checked against `X-PWH-Preview-Dims`
 * BEFORE the body is read, aborting locally with `E_PREVIEW_TOO_LARGE` when exceeded.
 */
export interface PreviewTransport {
  fetch(
    req: {
      readonly agentKey: string;
      readonly sessionId: string;
      readonly path: string;
      /** dir-plan §5 P2 (request) / P3 (return): appends `&dir=1` (opt-in directory
       * listing, A4) — absent keeps the request byte-identical to pre-dir-plan. The declared
       * return is the full `PreviewDirOutcome` union: a `dir:true` request resolves the
       * `kind:"dir"` variant (`listing`), everything else stays image/text — and P3's
       * `usePreview` narrows all three exhaustively. */
      readonly dir?: true;
      /** chunked-plan §4.1 (P2a): the opt-in continuation protocol (D2 — only ever sent
       * when the hub caps carry `preview.chunk.v1`). `true` appends `&chunk=1` (first
       * chunk); `{offset, ident}` appends `&chunk=1&offset=…&ident=…` (continuation).
       * MUTUALLY EXCLUSIVE with `dir` — combined, the clients refuse LOCALLY with
       * `E_BAD_REQUEST` without sending anything. Absent keeps the request byte-identical
       * to pre-chunk-plan. */
      readonly chunk?: true | { readonly offset: number; readonly ident: string };
    },
    opts: { readonly signal: AbortSignal; readonly maxPixels: number },
  ): Promise<PreviewDirOutcome>;
  /** preview-download (2026-10-12 拍板): `GET /api/preview?download=1` — raw bytes of ANY
   * admitted regular file (no sniff/kind gate), backing the preview dialog's 「下载」 button
   * and the unsupported-phase download offer. Same auth/CSRF/header-contract discipline as
   * `fetch` (`X-PWH: 1`, `checkPreviewHeaders`'s download opt-in branch, the Content-Length
   * body oracle, `previewOutcomeFromResponse`'s error mapping); the client deadline rides
   * `PREVIEW_DOWNLOAD_STREAM_MS` + slack because the hub streams up to 120s. Optional per the
   * frozen-transport convention — the UI gates on the `preview.download.v1` cap anyway. Both
   * real adapters always provide it. */
  download?(
    req: { readonly agentKey: string; readonly sessionId: string; readonly path: string },
    opts: { readonly signal: AbortSignal },
  ): Promise<PreviewDownloadOutcome>;
  /** 2026-10-07 修订「先探测后标记」: `POST /api/preview/probe` — batch existence probe, same
   * auth/CSRF surface as `fetch` (cookie credentials + `X-PWH: 1`), ONE request for a whole
   * message's candidates. Optional per the frozen-types convention — an older/foreign
   * transport without it simply keeps the legacy always-clickable rendering (`usePreview`
   * omits `handle.probe` and `PathText` degrades to pre-probe behavior).
   *
   * dir-plan §1.3/§5 P2: `dirs: true` adds it to the JSON body (directories then answer
   * `"dir"`); a dirs-less request folds a received `"dir"` per-entry to `"missing"`
   * (§1.3's single fold point — the logic clients' `probePost`). preview-download:
   * `files: true` rides the same body with the same fold rule for `"file"`. */
  probe?(
    req: {
      readonly agentKey: string;
      readonly sessionId: string;
      readonly paths: readonly string[];
      readonly dirs?: true;
      readonly files?: true;
    },
    opts?: { readonly signal?: AbortSignal },
  ): Promise<PreviewProbeOutcome>;
  /** web-hub-html-preview plan v2 §2.1/§5 (P0 frozen face, P2's clients implement):
   * `POST /api/preview/html-cap?agentKey=&sessionId=` — mint ONE path-shaped capability for an
   * admitted HTML entry (body `{path}`, answer `PreviewHtmlCapResponseBody` — the protocol's
   * own type, see `PreviewHtmlCapOutcome`). `probePost` skeleton: 8 s deadline, no POST
   * replay. Optional per the frozen-transport convention — the UI gates on the
   * `preview.html.v1` cap anyway; both real adapters provide it from P2 on. */
  htmlCap?(
    req: { readonly agentKey: string; readonly sessionId: string; readonly path: string },
    opts: { readonly signal: AbortSignal },
  ): Promise<PreviewHtmlCapOutcome>;
}

/**
 * 2026-10-07: the probe outcome. Success carries the per-entry sniff kinds in request order
 * (`"missing"` = not found / not admitted / binary); the error half is the same shape as
 * `PreviewOutcome`'s (status 0 for client-local codes) — the composable maps ANY error half
 * to a batch-wide "failed" degrade, so only `status`/`error`/`retryAfterS` are kept.
 *
 * dir-plan §1.3: the results element type IS the protocol's `PreviewProbeKind` — imported
 * from the single source (`protocol/preview.ts` + `PREVIEW_PROBE_KINDS`), never a local
 * literal union here (a hand mirror could drift when the protocol union grows).
 */
export type PreviewProbeOutcome =
  | { readonly ok: true; readonly results: ReadonlyArray<PreviewProbeKind> }
  | { readonly ok: false; readonly status: number; readonly error: string; readonly retryAfterS?: number };

// ---------------------------------------------------------------------------
// web-hub-html-preview plan v2 §5 (P0 frozen face) — the HTML-capability mint outcome
// ---------------------------------------------------------------------------

/**
 * plan v2 §5's frozen mint outcome. The success half IS the protocol's
 * `PreviewHtmlCapResponseBody` (never a hand mirror — the same anti-drift rule as
 * `PreviewProbeKind` above); the error half keeps the wire body's `reason` verbatim so a 403
 * `E_PREVIEW_DENIED{reason:"dir-too-broad"|"upload"}` reaches `PreviewHtml.vue`'s
 * source-switch decision unchanged (§5: mint 403 ⇒ prose note + switch to source).
 * `status` is 0 for client-local codes (`E_ABORT`/`E_DEADLINE`/`E_NETWORK`/`E_BAD_RESPONSE`).
 * Deliberately NO `retryAfterS`: the plan's frozen shape carries none (the UI retries
 * 429/503 on its own cadence, §5).
 */
export type PreviewHtmlCapOutcome =
  | (PreviewHtmlCapResponseBody & { readonly ok: true })
  | { readonly ok: false; readonly status: number; readonly error: string; readonly reason?: string };

// ---------------------------------------------------------------------------
// web-hub-avatar plan v2.1 §5 — the fixed avatar transport surface
// ---------------------------------------------------------------------------

export interface AvatarTransport {
  fetch(opts: { readonly signal: AbortSignal }): Promise<AvatarFetchOutcome>;
  upload(bytes: Uint8Array, opts?: { readonly signal?: AbortSignal }): Promise<AvatarWriteOutcome>;
  remove(): Promise<AvatarDeleteOutcome>;
}

// ---------------------------------------------------------------------------
// web-hub-privacy plan v2.1 (P1, 传输层 only) — the privacy-lock transport surface
// ---------------------------------------------------------------------------

/** `POST /api/privacy/lock` request (both listeners; `password` is REQUIRED on a LAN unlock,
 *  never sent on loopback — the hub enforces that split, not the client). */
export interface PrivacyLockRequest {
  readonly agentKey: string;
  readonly sessionId: string;
  readonly locked: boolean;
  readonly password?: string;
}

/**
 * Shared outcome for `verify`/`lock`: a 200 carries the hub's verdict (`ok:false` = wrong
 * password — NEVER an error, and NEVER a 401, plan v2 评审 #3); the error half keeps the wire
 * code verbatim (`E_SESSION_CHANGED` on a 409, `E_LIMIT`, `E_LOCKED`/`E_RATE` on a 429 — with
 * `retryAfterS` folded from `Retry-After`, so P2 can reuse the login countdown UI verbatim).
 * `status` is absent/0 for client-local codes (`E_NETWORK`/`E_DEADLINE`/`E_BAD_RESPONSE`).
 */
export type PrivacyOutcome =
  | { readonly ok: true; readonly data: { readonly ok: boolean } }
  | { readonly ok: false; readonly error: string; readonly status?: number; readonly retryAfterS?: number };

export interface PrivacyTransport {
  /** `POST /api/privacy/verify` — LAN/password mode only (a token-mode hub 404s it; P2 never
   *  calls it there — the loopback lock screen is a click-to-confirm, plan v2.1 N1). */
  verify(password: string): Promise<PrivacyOutcome>;
  /** `POST /api/privacy/lock` — both listeners. */
  lock(req: PrivacyLockRequest): Promise<PrivacyOutcome>;
}

// ---------------------------------------------------------------------------
// worktree-diff plan v3.1 §4.6 (package D4) — the `GET /api/worktree-diff/*` transport surface
// ---------------------------------------------------------------------------

/** §4.6's frozen request scope — the session identity every wtdiff request carries (the same
 * agentKey/sessionId pair `GET /api/preview` requires; a mismatch answers 409 E_SESSION_CHANGED
 * hub-side). */
export interface WtDiffScope {
  readonly agentKey: string;
  readonly sessionId: string;
}

/**
 * §4.6's frozen outcome union, shared by both endpoints. The success half carries the protocol
 * parser's own product (`WtDiffFileList` / `WtDiffFilePayload` — never a hand mirror); the error
 * half keeps the wire body's `reason` verbatim so a 409 `E_STALE_CTX{reason:"base"|"entry"}` —
 * or a 403 `E_WTDIFF_DENIED{reason}` / 415 `E_WTDIFF_UNSUPPORTED{reason}` — reaches the UI
 * unchanged for its stale-retry (§4.5) / copy-mapping decisions. `status` is 0 for client-local
 * codes (`E_ABORT` / `E_DEADLINE` / `E_NETWORK` / `E_BAD_RESPONSE`); `retryAfterS` folds the
 * 429 `Retry-After` header exactly like every other namespace. */
export type WtDiffOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly reason?: string;
      readonly retryAfterS?: number;
    };

/**
 * §4.6's `WorktreeDiffTransport` — the two §1.2 endpoints, same shape on both adapters (the
 * shared suite in `tests/web-hub/ui/transport-contract.test.ts` pins parity, preview/spawn
 * precedent). Requests carry `X-PWH: 1`; `signal` is `useWorktreeDiff`'s per-call controller
 * (a new pull / row collapse / scope invalidation aborts the in-flight fetch). `untracked:"no"`
 * is the degraded list mode (§3.3) and — per §1.2 — must ride the `file` request too when the
 * entry came from such a list: it participates in the hub's changeset key, so omitting it
 * would answer 409 `E_STALE_CTX{entry}` for a still-present file. The client never retries a
 * 409 on its own; the UI owns the one-shot re-pull (§4.5). */
export interface WorktreeDiffTransport {
  files(
    req: WtDiffScope & { readonly wt: string; readonly untracked?: "no" },
    opts?: { readonly signal?: AbortSignal },
  ): Promise<WtDiffOutcome<WtDiffFileList>>;
  file(
    req: WtDiffScope & {
      readonly wt: string;
      readonly base: string;
      readonly path: string;
      readonly orig?: string;
      readonly untracked?: "no";
    },
    opts?: { readonly signal?: AbortSignal },
  ): Promise<WtDiffOutcome<WtDiffFilePayload>>;
}

// ---------------------------------------------------------------------------
// worktree-graph plan v2 §4.4 (package P4) — the `GET /api/worktree-graph` transport surface
// ---------------------------------------------------------------------------

/**
 * §4.4's `WorktreeGraphTransport` — one endpoint, same shape on both adapters (the shared
 * suite in `tests/web-hub/ui/transport-contract.test.ts` pins parity, the wtdiff
 * precedent). The request carries `X-PWH: 1`; `signal` is P5's per-open controller (a
 * collapse / scope or wt change / unmount aborts the in-flight fetch). The success value is
 * the protocol parser's own product (`WtGraphPayload` — never a hand mirror); the error
 * half reuses `WtDiffOutcome`'s shape so the REUSED error codes' `reason` vocabulary
 * (`WtGraphErrorReason`: "log-timeout" | "missing-object" | "git-too-old" | "git-failed")
 * reaches the UI verbatim. The client cap is `WTGRAPH_BODY_MAX_BYTES` and its deadline
 * `WTGRAPH_CLIENT_TIMEOUT_MS` (both from the frozen P0 protocol module); this layer never
 * retries on its own — the UI owns the retry (§4.3).
 */
export interface WorktreeGraphTransport {
  graph(
    req: WtDiffScope & { readonly wt: string },
    opts?: { readonly signal?: AbortSignal },
  ): Promise<WtDiffOutcome<WtGraphPayload>>;
}
