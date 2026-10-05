/**
 * Transport abstraction (vue-plan.md v2.1 §3.4, §5.2 — P0 frozen). Both `@logic/token-client.js`
 * (`createClient`, extracted in this same P0 package from the legacy `app.js`) and
 * `@logic/password-client.js` (`createPasswordClient`) are adapted to `satisfies HubTransport` /
 * `satisfies PasswordTransport` by P1's `transport/{token,password}.ts` — never re-implemented
 * here. `tests/web-hub/ui/transport-contract.test.ts` (P1) runs the identical suite against both
 * adapters so the two transports can never silently diverge again (the exact regression class
 * 78dd76b was: password client missing `subscribe`/`page`).
 */
import type { PreviewDims, PreviewImageMime } from "@protocol/preview.js";
import type {
  DirEntryWire,
  SpawnAccepted,
  SpawnPolicyWire,
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
  op: "prompt" | "abort" | "steer_subagent" | "abort_subagent" | "command";
  text?: string;
  deliver?: "steer" | "followUp";
  runId?: string;
  name?: string;
  args?: string;
  confirm?: true;
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
  /** web-hub-preview plan v3 §4.6 (PV4): `GET /api/preview`. Optional for the same reason as
   * `upload`/`spawn` — `usePreview`'s scope derivation (`previewScopeOf`) yields `null`
   * without it and every path renders as plain text. Both real adapters always provide it. */
  readonly preview?: PreviewTransport;
}

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
    };

export type SpawnListOutcome =
  | { readonly ok: true; readonly policy: SpawnPolicyWire; readonly items: readonly SpawnRecordPublic[] }
  /** 404 rides verbatim (arch §8.3: feature off / LAN `lan:"off"` ⇒ UI treats pick-dir as unavailable). */
  | { readonly ok: false; readonly error: string; readonly status: number };

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
}

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
 * §4.6's `PreviewTransport` — one endpoint, same shape on both adapters (the shared suite in
 * `tests/web-hub/ui/transport-contract.test.ts` pins parity, SP11's spawn-namespace precedent).
 * The request carries `X-PWH: 1`; `signal` is `usePreview`'s per-open controller (a new open /
 * close / scope invalidation aborts the in-flight fetch); `maxPixels` is the CLIENT budget
 * (`clientImageBudget` — touch 20MP / desktop 40MP) checked against `X-PWH-Preview-Dims`
 * BEFORE the body is read, aborting locally with `E_PREVIEW_TOO_LARGE` when exceeded.
 */
export interface PreviewTransport {
  fetch(
    req: { readonly agentKey: string; readonly sessionId: string; readonly path: string },
    opts: { readonly signal: AbortSignal; readonly maxPixels: number },
  ): Promise<PreviewOutcome>;
}
