/**
 * web-hub content-preview protocol (web-hub-preview plan v3 §4.1 — frozen interface, PV1).
 *
 * Pure TypeScript, `node:*`-free: the browser UI (PV4's `logic/preview.js` / transports) imports
 * the limits, types and `validatePreviewPath` here for its own prechecks, exactly like
 * `protocol/spawn.ts` / `protocol/upload.ts`. Everything on the wire for
 * `GET /api/preview?agentKey=&sessionId=&path=` — response headers, error-body shapes, budget
 * constants — is frozen in this one module so the hub (PV2/PV3) and the UI (PV4+) never drift.
 *
 * The route behavior itself (admission, streaming, content re-verification) is NOT here: PV1
 * only ships the wire constants/types plus the settings plumbing (`webHub.preview`, §4.1). The
 * endpoint is dispatch-only-when-present (`FrontendDeps.preview`), so before PV3 lands nothing
 * consumes these constants at runtime — they are the compile-time contract for later packages.
 */

/** The single preview endpoint (§0/§4.7: dispatched only for `GET` + this exact path). */
export const PREVIEW_PATH = "/api/preview";

/** The batch existence-probe endpoint (2026-10-07 修订「先探测后标记」): `POST` + this exact
 * path. Dispatched by the same listener matrix as `GET /api/preview` (LAN only when the
 * preview mode is `"on"`); every entry walks the SAME admission chain as a real preview. */
export const PREVIEW_PROBE_PATH = "/api/preview/probe";

/** Probe request cap: at most this many paths per request (`paths.length` over ⇒ 400). */
export const PREVIEW_PROBE_MAX_PATHS = 100;

/** Probe request cap: request BODY (JSON incl. every path) capped at 8 KiB (over ⇒ 413). */
export const PREVIEW_PROBE_MAX_BODY_BYTES = 8 * 1024;

/** Probe per-entry wire kinds (2026-10-07): `text`/`image` use the §4.4 sniff on the file's
 * head; `missing` covers not-found, not-admitted (cwd defences / upload store refusal) AND
 * sniffed-binary — every "a preview click could not have succeeded" case collapses to it so
 * the UI keeps the candidate as plain text. */
export type PreviewProbeKind = "text" | "image" | "missing";

/** §3.2 probe client timeout (2026-10-07): a probe is advisory UI metadata, never worth
 * blocking a transcript on — on this deadline (or any transport failure) every entry of the
 * batch degrades to plain text ("failed"), no retry storm. */
export const PREVIEW_PROBE_CLIENT_TIMEOUT_MS = 5_000;

/** `webHub.preview` setting / availability tri-value (§0 LAN 策略). */
export type PreviewMode = "on" | "loopback" | "off";

/** U1 (2026-10-05 user ruling): default `"on"` — LAN available, risk explicitly accepted (§5.1). */
export const PREVIEW_DEFAULT_MODE: PreviewMode = "on";

// ---------------------------------------------------------------------------
// content caps (§0 上限)
// ---------------------------------------------------------------------------

/** Text preview cap; content is truncated at a UTF-8 character boundary (`utf8SafeCut`, PV2a). */
export const PREVIEW_TEXT_MAX_BYTES = 256 * 1024;

/** Image byte caps per listener (§0: loopback 16 MiB, LAN 4 MiB). */
export const PREVIEW_IMAGE_MAX_BYTES = { loopback: 16 * 1024 * 1024, lan: 4 * 1024 * 1024 } as const;

/** Server-side pixel cap; an image whose dims cannot be parsed is REJECTED (`dims-unknown`). */
export const PREVIEW_IMAGE_MAX_PIXELS = 40_000_000;

/** Client-side coarse-pointer (touch) budget — checked BEFORE the body is read (PV4). */
export const PREVIEW_CLIENT_PIXELS_COARSE = 20_000_000;

/** `validatePreviewPath` UTF-8 byte cap (Linux PATH_MAX). */
export const PREVIEW_PATH_MAX_BYTES = 4096;

/** §4.4: bytes of the head used for the text/binary decision. */
export const PREVIEW_SNIFF_TEXT_BYTES = 8 * 1024;

/** §3.1 ⑧: initial sample read (`min(size, 64 KiB)`). */
export const PREVIEW_SAMPLE_BYTES = 64 * 1024;

/** §3.1 ⑧: JPEG may keep reading up to this many bytes total before its SOF must be found. */
export const PREVIEW_JPEG_SCAN_MAX_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// budgets (§0 预算; pinned relation tests in tests/web-hub/protocol/preview.test.ts)
// ---------------------------------------------------------------------------

/** Total admission budget (§3.1 ①–⑧): auth ≤3s + `PREVIEW_AUTH_RESERVE_MS` slack, fs ≤2s/step. */
export const PREVIEW_ADMIT_TOTAL_MS = 8_000;

/** Write-out deadline per listener (§3.1 ⑨ `streamAt`). */
export const PREVIEW_STREAM_MS = { loopback: 15_000, lan: 30_000 } as const;

/** §4.5.3: single-flight whole-file hash budget (text verify only). */
export const PREVIEW_VERIFY_MS = 30_000;

/** §3.2 UI client timeout; must exceed `ADMIT + STREAM.lan` so a streamed 200 is never raced. */
export const PREVIEW_CLIENT_TIMEOUT_MS = 40_000;

// ---------------------------------------------------------------------------
// path recognition (§4.6 rule 5: cwd subtree OR a path containing this marker)
// ---------------------------------------------------------------------------

/** Upload-store root marker inside `$HOME`; a request path containing it is upload-class (§3.1 ⑥). */
export const PREVIEW_UPLOADS_MARKER = "/.pi/agent/web-hub/uploads/";

// ---------------------------------------------------------------------------
// 200 response headers (§4.1: metadata rides `X-PWH-Preview-*`, body is the raw bytes)
// ---------------------------------------------------------------------------

export type PreviewImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** The four `X-PWH-Preview-*` response header names (`PREVIEW_HDR.kind/size/truncated/dims`). */
export const PREVIEW_HDR = {
  kind: "X-PWH-Preview-Kind",
  size: "X-PWH-Preview-Size",
  truncated: "X-PWH-Preview-Truncated",
  dims: "X-PWH-Preview-Dims",
} as const;

/** Image dimensions in pixels (`X-PWH-Preview-Dims` is its `"<w>x<h>"` serialization, PV3). */
export interface PreviewDims {
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// error bodies (§4.1 API_ERRORS tail: the four E_PREVIEW_* codes' JSON shapes)
// ---------------------------------------------------------------------------

/** 403 `E_PREVIEW_DENIED` — admission refusal (cwd-class defences / structural re-check). */
export interface PreviewDeniedBody {
  error: "E_PREVIEW_DENIED";
  reason: PreviewDenyReason;
}

/** 415 `E_PREVIEW_UNSUPPORTED` — sniffed binary / non-regular file / unknown image dims. */
export interface PreviewUnsupportedBody {
  error: "E_PREVIEW_UNSUPPORTED";
  size?: number;
  reason: PreviewUnsupportedReason;
}

/** 413 `E_PREVIEW_TOO_LARGE` — over the byte or pixel cap (`dims` present iff `reason:"pixels"`). */
export interface PreviewTooLargeBody {
  error: "E_PREVIEW_TOO_LARGE";
  size: number;
  max: number;
  reason: "bytes" | "pixels";
  dims?: PreviewDims;
}

/** 409 `E_PREVIEW_CHANGED` — content identity (or sha256) changed during the preview. */
export interface PreviewChangedBody {
  error: "E_PREVIEW_CHANGED";
}

export type PreviewDenyReason = "outside" | "root-too-broad" | "virtual-fs" | "denylist" | "unreadable";
export type PreviewUnsupportedReason = "binary" | "not-regular" | "dims-unknown";

// ---------------------------------------------------------------------------
// validation (pure; shared by hub admission §3.1 ③ and UI recognition §4.6 rule 4)
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

/**
 * §4.1: the request `path` gate — must start with `/`, be ≤4096 UTF-8 bytes, contain no NUL /
 * `\r` / `\n`, have at least 2 non-empty segments, and no `.`/`..` segment. Returns a boolean
 * (never throws); callers map `false` to their own error (hub: 400 `E_BAD_REQUEST`; UI: no ref).
 */
export function validatePreviewPath(p: string): boolean {
  if (typeof p !== "string" || !p.startsWith("/")) return false;
  if (p.includes("\0") || p.includes("\r") || p.includes("\n")) return false;
  if (textEncoder.encode(p).length > PREVIEW_PATH_MAX_BYTES) return false;
  const segments = p.slice(1).split("/");
  if (segments.length < 2) return false;
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// hub-side config re-validation (§4.1: HubConfig.preview carries "on"|"loopback" only)
// ---------------------------------------------------------------------------

/** The wire form of `HubConfig.preview` — `"off"` is the key's ABSENCE (§4.7 matrix). */
export type HubPreviewMode = "on" | "loopback";

/**
 * `hub/main.ts`'s strict re-check of the hand-off `PI_WEBHUB_CONFIG` field: only `"on"` /
 * `"loopback"` are legal on the wire (`"off"` must already be the omitted key, anything else is
 * out-of-contract). Returns `undefined` ⇒ drop the whole `preview` key (feature off, hub keeps
 * running) — the same fail-soft pattern `parseHubSpawnConfig`'s drop takes in `hub/main.ts`.
 */
export function normalizeHubPreviewMode(raw: unknown): HubPreviewMode | undefined {
  return raw === "on" || raw === "loopback" ? raw : undefined;
}
