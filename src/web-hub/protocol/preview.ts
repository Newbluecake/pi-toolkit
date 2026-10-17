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
 * the UI keeps the candidate as plain text.
 *
 * dir-plan §1.1 (P0): `"dir"` joins the union — a directory answers it ONLY when the request
 * opted in (`dirs: true` on the probe body, §3.5); a dirs-less request never sees it.
 *
 * preview-download (2026-10-12 拍板): `"file"` joins with the SAME opt-in discipline (`files:
 * true`) — it means "exists, admitted, regular, ≤ the download cap, but binary-sniffed (not
 * previewable)" — i.e. a click opens the dialog's unsupported phase WITH the download offer.
 * A files-less request never sees it (the client folds it per-entry to `"missing"`, exactly
 * mirroring the `"dir"` rule); an over-`PREVIEW_DOWNLOAD_MAX_BYTES` file stays `"missing"`
 * even under `files: true` (a click could not succeed — the old contract's spirit). */
export type PreviewProbeKind = "text" | "image" | "dir" | "file" | "missing";

/** dir-plan §1.3: the single source of the probe-kind enum — the hub's response construction,
 * the UI transport types and the UI parser all import THIS tuple (element type /
 * `.includes()`); no local literal union may compete with it. */
export const PREVIEW_PROBE_KINDS = ["text", "image", "dir", "file", "missing"] as const;

/** dir-plan §1.1: the probe request body. `dirs: true` asks directories to answer `"dir"`
 * instead of `"missing"`; absent keeps the pre-dir behavior byte-identical. `files: true`
 * (preview-download) asks binary regular files to answer `"file"` — the two flags are
 * independent and may ride the same request. */
export interface PreviewProbeRequestBody {
  paths: string[];
  dirs?: true;
  files?: true;
}

/** dir-plan §1.1: the probe response body (the hub constructs it `satisfies` this type, §1.3). */
export interface PreviewProbeResponseBody {
  results: Array<{ kind: PreviewProbeKind }>;
}

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

/** dir-plan §1.1: the complete value set of the `X-PWH-Preview-Kind` response header —
 * `text`/`image` bodies (plan v3) plus `dir` (dir-plan A; opt-in `dir=1` requests only) plus
 * `download` (preview-download; opt-in `download=1` requests only — raw octet-stream bytes). */
export type PreviewResponseKind = "text" | "image" | "dir" | "download";

/** The `X-PWH-Preview-*` response header names. `kind/size/bytes/truncated/dims` are the
 * plan-v3 set; `offset`/`ident` (chunked-plan §2.3) are appended by the hub ONLY on chunked-mode
 * (`chunk=1`) text responses — a non-chunked response carries neither, byte-identical to before. */
export const PREVIEW_HDR = {
  kind: "X-PWH-Preview-Kind",
  size: "X-PWH-Preview-Size",
  /**
   * Uncompressed BODY byte length (`X-PWH-Preview-Bytes`): the exact count of content bytes
   * the response carries BEFORE transport compression. When `Content-Encoding: gzip` is on,
   * `Content-Length` names the compressed length and the browser transparently decompresses,
   * so the client completeness oracle (`buf.byteLength`) must compare against THIS header
   * instead — the gzip container itself rejects a short/corrupt stream, and this header
   * restores the exact-length check the pre-gzip `Content-Length` oracle provided.
   */
  bytes: "X-PWH-Preview-Bytes",
  truncated: "X-PWH-Preview-Truncated",
  dims: "X-PWH-Preview-Dims",
  /** chunked-plan §2.3: this chunk's starting byte offset (chunked-mode responses only; MUST
   * equal the request's `offset`, 0 for the first chunk). */
  offset: "X-PWH-Preview-Offset",
  /** chunked-plan §2.3 (D3): the file identity token `i1.<22 base64url>` (chunked-mode
   * responses only), computed from the stream-start `pre` stat. */
  ident: "X-PWH-Preview-Ident",
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

/**
 * web-hub-html-preview plan v2 §2.1-⑤/§2.3-⑤ (P0): the union gains the two HTML-mint-only
 * refusals — `"upload"` (the entry lives in the upload store, `cls:"upload"` ⇒ 403; v1
 * non-goal「HTML attachments from the upload store」) and `"dir-too-broad"` (D2: the HTML
 * file's bound directory is exactly `/`, `$HOME` literal+canonical, the agent dir or the
 * uploads root ⇒ source view only). Both ride the SAME 403 `E_PREVIEW_DENIED` body shape and
 * are emitted only by the future `handleHtmlCap`/`pv-admit` paths — an ordinary preview never
 * produces them and no consumer switches exhaustively on this union (the UI folds `reason`
 * through verbatim).
 */
export type PreviewDenyReason =
  "outside" | "root-too-broad" | "virtual-fs" | "denylist" | "unreadable" | "upload" | "dir-too-broad";
export type PreviewUnsupportedReason = "binary" | "not-regular" | "dims-unknown";

// ---------------------------------------------------------------------------
// validation (pure; shared by hub admission §3.1 ③ and UI recognition §4.6 rule 4)
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

/**
 * §4.1: the request `path` gate — must start with `/`, be ≤4096 UTF-8 bytes, contain no NUL /
 * `\r` / `\n`, have at least 2 non-empty segments, and no `.`/`..` segment. Returns a boolean
 * (never throws); callers map `false` to their own error (hub: 400 `E_BAD_REQUEST`; UI: no ref).
 *
 * dir-plan §1.1 (P0): `opts.minSegments` loosens ONLY the segment-count rule — `1` admits
 * single-segment paths (`/home`) for the hub request gate, the probe's per-entry check and UI
 * navigation; everything else (empty/`.`/`..` segments, NUL/CR/LF, the 4096-byte cap) is
 * unaffected. The default stays `2` — the recognition layer's frozen behavior (`/help`,
 * `/reload` never become click candidates) is byte-identical to pre-dir-plan.
 */
export function validatePreviewPath(p: string, opts?: { minSegments?: 1 | 2 }): boolean {
  const minSegments = opts?.minSegments ?? 2;
  if (typeof p !== "string" || !p.startsWith("/")) return false;
  if (p.includes("\0") || p.includes("\r") || p.includes("\n")) return false;
  if (textEncoder.encode(p).length > PREVIEW_PATH_MAX_BYTES) return false;
  const segments = p.slice(1).split("/");
  if (segments.length < minSegments) return false;
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

/** Admission canonical form (2026-10-13 用户报告「多一个 / 就不是有效路径」): strip ONE trailing
 *  slash (`/a/b/` → `/a/b` — shells and tab-completion produce it constantly). Hub routes
 *  normalize BEFORE {@link validatePreviewPath}, so the validator's frozen contract (incl. the
 *  recognition layer's) is untouched and every downstream consumer (denylist prefix compares,
 *  child joins, fs, audit) sees the canonical spelling. Pure string op — never throws. */
export function normalizePreviewPath(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

// ---------------------------------------------------------------------------
// directory listing (dir-plan §1.1/§3.2 — opt-in `dir=1`; frozen wire surface)
// ---------------------------------------------------------------------------

/** The opt-in query flag name: only the exact value `"1"` turns a directory path into a
 * listing request (§3.5); absent (or any other value) keeps today's byte-identical behavior. */
export const PREVIEW_DIR_QUERY = "dir";

// ---------------------------------------------------------------------------
// download mode (preview-download, 2026-10-12 user 拍板 — opt-in `download=1`)
// ---------------------------------------------------------------------------

/** The opt-in query flag name: only the exact value `"1"` turns the request into a raw-byte
 * download (`Content-Disposition: attachment`, no sniff/kind gate). MUTUALLY EXCLUSIVE with
 * `dir=1` — both set ⇒ 400 `E_BAD_REQUEST`. A directory with `download=1` alone stays 415
 * `not-regular` (the admission chain never opens it as a listing). */
export const PREVIEW_DOWNLOAD_QUERY = "download";

/** Download body cap (256 MiB — streamed, loopback/LAN 同宽 per U1); over ⇒ 413
 * `E_PREVIEW_TOO_LARGE{reason:"bytes"}` before the head is written. */
export const PREVIEW_DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024;

/** Download write-out budget (ms) — sized for the 256 MiB cap over a slow LAN, a single
 * number for both listeners (U1 同宽), independent of `PREVIEW_STREAM_MS`. */
export const PREVIEW_DOWNLOAD_STREAM_MS = 120_000;

/** Client-side download deadline (ms): the hub's 120s stream budget + 30s of admission /
 * network slack. Shared by BOTH logic clients (anti-drift, same rule as
 * `PREVIEW_CLIENT_TIMEOUT_MS`). */
export const PREVIEW_DOWNLOAD_CLIENT_TIMEOUT_MS = PREVIEW_DOWNLOAD_STREAM_MS + 30_000;

// ---------------------------------------------------------------------------
// chunked text streaming (web-hub-preview chunked-plan §2 — opt-in `chunk=1`; frozen P0 surface)
// ---------------------------------------------------------------------------

/** chunked-plan §2.2: the opt-in query flag name — only the exact value `"1"` turns a text
 * preview into chunked mode (same exact-value rule as `dir`/`download`). Absent (or any other
 * value) keeps today's one-shot truncated response byte-identical. MUTUALLY EXCLUSIVE with
 * `dir=1`/`download=1` — both set ⇒ 400 `E_BAD_REQUEST`. */
export const PREVIEW_CHUNK_QUERY = "chunk";

/** chunked-plan §2.2: the continuation offset query parameter (decimal byte offset, paired
 * with `ident`; absent on the first chunk, which is just `chunk=1`). */
export const PREVIEW_OFFSET_QUERY = "offset";

/** chunked-plan §2.2 (D3): the file-identity query parameter — echoes the first chunk's
 * `X-PWH-Preview-Ident` back; paired with `offset` (either both or neither ⇒ 400). */
export const PREVIEW_IDENT_QUERY = "ident";

/** chunked-plan §2.1: per-chunk body cap = the existing text cap — every chunk's deadline /
 * memory profile is exactly the same shape as today's first-chunk response. */
export const PREVIEW_TEXT_CHUNK_BYTES = PREVIEW_TEXT_MAX_BYTES;

/** chunked-plan §2.1 (D1, 2026-10-14 拍板): the hub HARD ceiling — in chunked mode the hub
 * never serves a byte at offset ≥ this value (loopback/LAN same width, U1). A request whose
 * `offset` reaches it is rejected (400 `E_BAD_REQUEST`) by {@link parsePreviewOffset}. */
export const PREVIEW_TEXT_STREAM_HUB_MAX_BYTES = 16 * 1024 * 1024;

/** chunked-plan §2.1/§2.5 (D1): the UI-side default total caps — `fine` (desktop pointer)
 * 8 MiB, `coarse` (touch) 4 MiB, keyed off `pointer: coarse` like `clientImageBudget`, NOT
 * off the listener. Both must stay ≤ the hub hard ceiling (relation test pinned). */
export const PREVIEW_TEXT_STREAM_CLIENT_MAX_BYTES = {
  fine: 8 * 1024 * 1024,
  coarse: 4 * 1024 * 1024,
} as const;

/** chunked-plan §2.1: the UI's minimum gap between two continuation requests — ≥ the hub
 * token bucket's 250 ms refill period (`hub/preview/routes.ts`'s `PREVIEW_BUCKET_REFILL_MS`),
 * with headroom for parallel ordinary preview clicks. */
export const PREVIEW_CHUNK_MIN_GAP_MS = 300;

/** chunked-plan §2.1 (D3): the identity-token wire format — `"i1."` + the first 22 base64url
 * chars of `sha256("dev:ino:size:ctimeMs")` (128 bits). Keyless and deterministic, so it
 * survives a hub restart; ctime (not mtime) because `utimes` can forge mtime but not ctime. */
export const PREVIEW_IDENT_RE = /^i1\.[A-Za-z0-9_-]{22}$/;

/**
 * chunked-plan §2.1: strict `offset` parse — decimal digits only, no leading zeros (`"0"`
 * excepted), a safe integer, and strictly below the hub hard ceiling. Anything else ⇒ `null`.
 * Never throws. The hub maps `null` to 400 `E_BAD_REQUEST`; the UI uses it as a precheck.
 */
export function parsePreviewOffset(raw: string | null): number | null {
  // typeof-first (same defensive convention as validatePreviewPath): a non-string never
  // reaches the regex — `RegExp.test(0)` would otherwise coerce to the matching "0".
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return null;
  if (n >= PREVIEW_TEXT_STREAM_HUB_MAX_BYTES) return null;
  return n;
}

/** chunked-plan §2.1: identity-token validation — a string matching {@link PREVIEW_IDENT_RE}. */
export function validatePreviewIdent(raw: unknown): raw is string {
  return typeof raw === "string" && PREVIEW_IDENT_RE.test(raw);
}

/** The `X-PWH-Preview-Kind` value a download response carries (the client header contract
 * rejects it for requests that did NOT opt in — same single-response-violation rule as
 * `dir`, dir-plan §1.3). */
export const PREVIEW_DOWNLOAD_KIND = "download";

/** ① Scan cap: at most this many dirents are read from the handle (`limits.scan` flags the cut). */
export const PREVIEW_DIR_SCAN_MAX = 10_000;

/** ② Entries cap: at most this many entries survive into `entries` (after sorting). */
export const PREVIEW_DIR_ENTRIES_MAX = 1_000;

/** ③ Response cap: the serialized listing JSON's UTF-8 byte budget (the UNCOMPRESSED body). */
export const PREVIEW_DIR_BODY_MAX_BYTES = 512 * 1024;

/** Single-name cap: a dirent name longer than this is dropped server-side and counted in
 * `dropped` — the hub never emits it, so the parser must never accept it. */
export const PREVIEW_DIR_NAME_MAX_BYTES = 1_024;

/** Listing-phase wall clock (§3.4) — appended INDEPENDENTLY after the admission budget. */
export const PREVIEW_DIR_LIST_MS = 5_000;

/** lstat fan-out width during the listing phase (§3.2). */
export const PREVIEW_DIR_STAT_CONCURRENCY = 8;

/** Bounded close of a dir handle / directory fd (§3.3) — its OWN deadline, never the request's. */
export const PREVIEW_DIR_CLOSE_MS = 1_000;

/** §3.4 budget relation: the wall clock reserved for LAN transfer after admit + listing.
 * Pinned in tests/web-hub/protocol/preview.test.ts:
 * `PREVIEW_ADMIT_TOTAL_MS + PREVIEW_DIR_LIST_MS + PREVIEW_DIR_LAN_TRANSFER_RESERVE_MS
 * <= PREVIEW_CLIENT_TIMEOUT_MS`. */
export const PREVIEW_DIR_LAN_TRANSFER_RESERVE_MS = 20_000;

/** A dirent's type as reported on the wire (`other` covers FIFO / socket / device files). */
export type PreviewDirEntryType = "dir" | "file" | "symlink" | "other";

/** One directory entry. `lossy` marks a name that survived a lossy decode (contains U+FFFD);
 * such entries render but are never clickable (A3). */
export interface PreviewDirEntry {
  name: string;
  type: PreviewDirEntryType;
  size?: number;
  mtimeMs?: number;
  lossy?: true;
}

/** The `dir=1` response body (§3.2). Truncation priority is fixed: scan → filter → entries →
 * bytes; `truncated` MUST equal `entries.length < total || !complete` (parser-enforced). */
export interface PreviewDirListing {
  /** Sorted: `dir`-type entries first, then name order (case-folded compare + codepoint tiebreak). */
  entries: PreviewDirEntry[];
  /** Filtered entries in the scanned portion (always ≥ `entries.length`). */
  total: number;
  /** Dirents actually read (≤ `PREVIEW_DIR_SCAN_MAX`). */
  scanned: number;
  /** Whether the directory end was reached (scan cap not hit, no readdir error). */
  complete: boolean;
  /** `entries.length < total || !complete`. */
  truncated: boolean;
  /** Which of the three caps actually fired. */
  limits: { scan: boolean; entries: boolean; bytes: boolean };
  /** Entries that vanished between readdir and lstat. */
  vanished: number;
  /** Entries dropped for an over-long name (`> PREVIEW_DIR_NAME_MAX_BYTES`). */
  dropped: number;
  /** lstat budget ran out mid-fan-out — some entries lack size/mtime. */
  statPartial?: true;
}

const PREVIEW_DIR_ENTRY_TYPES: readonly PreviewDirEntryType[] = ["dir", "file", "symlink", "other"];

function isNonNegFinite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function isNonNegSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/**
 * dir-plan §1.1: strict validation + aggregate size check of a `dir=1` response body.
 * `byteLength` is the DECODED body's UTF-8 byte count (the transport may have carried it
 * gzip'd, so the 512 KiB cap is judged on this number, never on Content-Length). Anything
 * off-contract ⇒ `null`; unknown fields are ignored (room for later additive extensions).
 * Never throws.
 */
export function parsePreviewDirListing(raw: unknown, byteLength: number): PreviewDirListing | null {
  if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 0) return null;
  if (byteLength > PREVIEW_DIR_BODY_MAX_BYTES) return null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  // entries: array of well-shaped entries, at most ENTRIES_MAX
  const rawEntries = o.entries;
  if (!Array.isArray(rawEntries) || rawEntries.length > PREVIEW_DIR_ENTRIES_MAX) return null;
  const entries: PreviewDirEntry[] = [];
  for (const rawEntry of rawEntries) {
    if (rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) return null;
    const e = rawEntry as Record<string, unknown>;
    const name = e.name;
    if (typeof name !== "string" || name === "" || name.includes("/") || name.includes("\0")) return null;
    if (textEncoder.encode(name).length > PREVIEW_DIR_NAME_MAX_BYTES) return null;
    const type = e.type;
    if (typeof type !== "string" || !PREVIEW_DIR_ENTRY_TYPES.includes(type as PreviewDirEntryType)) return null;
    const hasSize = e.size !== undefined;
    if (hasSize && !isNonNegFinite(e.size)) return null;
    const hasMtime = e.mtimeMs !== undefined;
    if (hasMtime && !isNonNegFinite(e.mtimeMs)) return null;
    if (e.lossy !== undefined && e.lossy !== true) return null;
    const entry: PreviewDirEntry = { name, type: type as PreviewDirEntryType };
    if (hasSize) entry.size = e.size as number;
    if (hasMtime) entry.mtimeMs = e.mtimeMs as number;
    if (e.lossy === true) entry.lossy = true;
    entries.push(entry);
  }

  // scalar counters / flags
  const total = o.total;
  const scanned = o.scanned;
  const complete = o.complete;
  const truncated = o.truncated;
  const limits = o.limits;
  const vanished = o.vanished;
  const dropped = o.dropped;
  const statPartial = o.statPartial;
  if (!isNonNegSafeInt(total) || !isNonNegSafeInt(scanned)) return null;
  if (typeof complete !== "boolean" || typeof truncated !== "boolean") return null;
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) return null;
  const l = limits as Record<string, unknown>;
  if (typeof l.scan !== "boolean" || typeof l.entries !== "boolean" || typeof l.bytes !== "boolean") return null;
  if (!isNonNegSafeInt(vanished) || !isNonNegSafeInt(dropped)) return null;
  if (statPartial !== undefined && statPartial !== true) return null;

  // aggregate relations (§1.1)
  if (total < entries.length) return null;
  if (scanned > PREVIEW_DIR_SCAN_MAX) return null;
  if (truncated !== (entries.length < total || !complete)) return null;

  const listing: PreviewDirListing = {
    entries,
    total,
    scanned,
    complete,
    truncated,
    limits: { scan: l.scan, entries: l.entries, bytes: l.bytes },
    vanished,
    dropped,
  };
  if (statPartial === true) listing.statPartial = true;
  return listing;
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
