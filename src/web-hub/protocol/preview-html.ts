/**
 * web-hub HTML preview protocol (web-hub-html-preview plan v2 §6 P0 — frozen surface).
 *
 * Pure TypeScript, ZERO imports (`node:*`-free, DOM-free): the browser UI reaches it through
 * the `@protocol` alias exactly like `protocol/preview.ts` (PV_SANDBOX for the iframe
 * attribute, PV_CAP_RE / the limits for prechecks), while the hub's P1a/P1b packages
 * (`hub/preview/{pv-path,pv-io,html-cap,pv-admit,pv-routes}.ts`, `hub/http.ts`) build against
 * the same constants — ONE module so the hub side and the UI side can never drift.
 *
 * What is frozen here: the capability-URL prefixes (`/pv/`, `/pvw/`, §1), the sandbox token
 * string `PV_SANDBOX` (D1 — the single constant the hub's `Content-Security-Policy: sandbox`
 * header AND the UI's `<iframe sandbox>` / `/pvw` wrapper bind to), the cap grammar
 * `PV_CAP_RE` (§2.2), the mint endpoint path + request/response bodies (§2.1), and EVERY
 * numeric limit/TTL of §2 (store occupancy, tombstone ring, rel-path parse caps, rate bucket,
 * bounded queue, admission/stream deadlines, physical-IO quota, size caps, denial-audit
 * throttle). P0 ships them INERT: nothing consumes them at runtime yet — no route, no cap
 * advertisement — they are the compile-time contract P1a/P1b/P2 develop against in parallel.
 *
 * NOT re-declared here: the mint flow's total budget reuses `preview.ts`'s
 * `PREVIEW_ADMIT_TOTAL_MS` (8 s, §2.1 — P1b imports it from the sibling module directly), and
 * the `/pv` response headers / CSP composition (§3) are P1b-owned wire construction — only the
 * sandbox TOKEN string they all embed is protocol-frozen.
 */

/** §2.1: the capability-mint endpoint (`POST` + this exact path, query `agentKey`/`sessionId`;
 * dispatched beside `POST /api/preview/probe` with the identical CSRF gate and listener
 * matrix). */
export const PREVIEW_HTML_CAP_PATH = "/api/preview/html-cap";

/** §1: the sandboxed subresource URL prefix — `/pv/<cap>/<rel>`; the raw remainder after this
 * prefix is what `PreviewRoutes.servePv` receives (`<cap>/<rel>`, percent-encoded). */
export const PV_PREFIX = "/pv/";

/** §3.2: the script-free new-tab wrapper prefix — `/pvw/<cap>`; the raw remainder after this
 * prefix is what `PreviewRoutes.serveWrapper` receives. */
export const PVW_PREFIX = "/pvw/";

/**
 * D1 (§0, fixed): the ONE sandbox token string, embedded verbatim BOTH as the hub's
 * `Content-Security-Policy: sandbox …` value on every `/pv/*` response and as the UI's
 * `<iframe sandbox="…">` attribute (dialog and `/pvw` wrapper alike). Scripts run; forms and
 * popups work (F1/F4); the page NEVER gets `allow-same-origin` (fresh opaque origin — no hub
 * cookie/storage/DOM) and NEVER gets top-navigation / modals / downloads /
 * popups-to-escape-sandbox. The token ORDER is frozen too (hub CSP text and UI attribute are
 * byte-compared in tests).
 */
export const PV_SANDBOX = "allow-scripts allow-forms allow-popups";

/**
 * §2.2: a capability is exactly 43 base64url chars (`randomBytes(32).toString("base64url")` —
 * 256 bits, no padding). Anchored both ends; anything else ⇒ 404 (no oracle, §2.3-①).
 */
export const PV_CAP_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * §2.1-②: the entry-file gate — a path whose final segment ends in `.html`/`.htm`
 * (case-insensitive). `.xhtml` is deliberately OUT (§0 non-goals). Pure suffix test; the mint
 * chain has already run `validatePreviewPath` by the time this runs. Never throws.
 */
const HTML_ENTRY_RE = /\.html?$/i;

export function isHtmlEntryPath(p: string): boolean {
  // typeof-first (same defensive convention as validatePreviewPath): a non-string never
  // reaches the regex — `RegExp.test(0)` would otherwise coerce to a matching "0"-free string.
  return typeof p === "string" && HTML_ENTRY_RE.test(p);
}

// ---------------------------------------------------------------------------
// §2.1 mint — request/response bodies
// ---------------------------------------------------------------------------

/** §2.1-①/③: the mint request body — ONE absolute HTML-entry path (≤ `PV_MINT_MAX_BODY_BYTES`
 * JSON bytes; `expandTildePath`/`normalizePreviewPath`/`validatePreviewPath`/`isHtmlEntryPath`
 * all run hub-side). */
export interface PreviewHtmlCapRequestBody {
  readonly path: string;
}

/**
 * §2.1-⑨: the mint response body. `url` is the framed capability URL
 * (`/pv/<cap>/<encodeURIComponent(entry)>`), `openUrl` the `/pvw/<cap>` wrapper, `idleMs` the
 * sliding idle TTL (D4, = `PV_IDLE_TTL_MS`), and `hardRemainingMs` the absolute cap's
 * remaining wall clock measured at send time (`cap.hardAt − now()`) — the UI's TTL UX (§5
 * T-U1: idle hint / hard-expired banner + re-mint) keys off exactly these two numbers.
 */
export interface PreviewHtmlCapResponseBody {
  readonly url: string;
  readonly openUrl: string;
  readonly idleMs: number;
  readonly hardRemainingMs: number;
}

// ---------------------------------------------------------------------------
// §2.1/§2.2 mint + capability-store limits
// ---------------------------------------------------------------------------

/** §2.1-③: mint request BODY cap (JSON incl. the path), mirroring the probe's 8 KiB. */
export const PV_MINT_MAX_BODY_BYTES = 8 * 1024;

/** D4/§2.2: sliding idle TTL — no request through a cap for this long ⇒ the cap is dead. */
export const PV_IDLE_TTL_MS = 15 * 60_000;

/** D4/§2.2: absolute TTL — `hardAt = mintedAt + PV_HARD_TTL_MS`; activity NEVER extends it. */
export const PV_HARD_TTL_MS = 60 * 60_000;

/** §2.1-⑧: live caps per principal (FIFO eviction beyond, closing the evicted cap's dir fd). */
export const PV_CAPS_PER_PRINCIPAL = 8;

/** §2.1-⑧: live caps globally (≤ this many held directory fds in total, §2.2). */
export const PV_CAPS_GLOBAL = 64;

/** §2.2: revoke-tombstone ring size — retained far enough back that a mint whose `seq0` was
 * captured before `authorize` can always answer `revokedSince` (≥ 2 × the 8 s admit budget of
 * mints in flight, R2 #2); oldest evicted first. */
export const PV_TOMBSTONE_RING = 256;

// ---------------------------------------------------------------------------
// §2.3-② rel-path parse caps (`hub/preview/pv-path.ts`, P1a)
// ---------------------------------------------------------------------------

/** Max path segments after the cap (`a/b/c` ⇒ 3); more ⇒ 400. */
export const PV_REL_MAX_SEGMENTS = 64;

/** Max UTF-8 bytes per (decoded) segment; more ⇒ 400. */
export const PV_SEGMENT_MAX_BYTES = 255;

/** Max UTF-8 bytes of the decoded, joined rel path; more ⇒ 400. */
export const PV_REL_MAX_BYTES = 4096;

// ---------------------------------------------------------------------------
// §2.3-③ per-cap rate limits (a `createCmdLimit` bucket `pv:<capTag>` + a lifetime counter)
// ---------------------------------------------------------------------------

/** Token-bucket capacity per cap (bursts up to this many requests). */
export const PV_BUCKET_CAPACITY = 200;

/** Token refill period (one token per 20 ms ⇒ 50 req/s sustained). */
export const PV_BUCKET_REFILL_MS = 20;

/** Lifetime request cap per cap; over ⇒ 429 for good (mint a new cap). */
export const PV_LIFETIME_MAX_REQS = 10_000;

// ---------------------------------------------------------------------------
// §2.3-④ bounded FIFO queue (a 50-asset page queues instead of failing)
// ---------------------------------------------------------------------------

/** Max concurrently-in-FS/stream requests per cap; others wait FIFO. */
export const PV_ACTIVE_PER_CAP = 6;

/** Max concurrently-in-FS/stream requests across ALL caps. */
export const PV_ACTIVE_GLOBAL = 16;

/** Max FIFO waiters per cap; the 71st concurrent request on one cap ⇒ 503. */
export const PV_QUEUE_PER_CAP = 64;

/** Max FIFO waiters across all caps. */
export const PV_QUEUE_GLOBAL = 256;

/** Max waiter residence (a waiter holds only the socket, never an fd); over ⇒ 503
 * `Retry-After: 1`. */
export const PV_QUEUE_WAIT_MS = 10_000;

// ---------------------------------------------------------------------------
// §2.3-⑤/⑥/⑦ admission + size + stream budgets
// ---------------------------------------------------------------------------

/** Serve admission budget, counted FROM DEQUEUE (a queued request's clock starts when it
 * leaves the queue, not when the socket arrived). */
export const PV_ADMIT_TOTAL_MS = 4_000;

/** §2.3-⑥: single subresource byte cap; over ⇒ 413. */
export const PV_FILE_MAX_BYTES = 32 * 1024 * 1024;

/** §2.3-⑥: total bytes served per cap over its whole lifetime; over ⇒ 413. */
export const PV_CAP_TOTAL_MAX_BYTES = 512 * 1024 * 1024;

/** §2.3-⑦: stream write-out deadline per listener (revoke mid-stream aborts the response). */
export const PV_STREAM_MS = { loopback: 30_000, lan: 60_000 } as const;

// ---------------------------------------------------------------------------
// §2.5 physical-IO quota (`hub/preview/pv-io.ts`, P1a)
// ---------------------------------------------------------------------------

/** Outstanding real fs operations across the whole `/pv` surface (own semaphore, never shared
 * with preview/history — a wedged op degrades `/pv` to busy while the rest of the hub keeps
 * ≥ 2 of libuv's 4 threads). Must stay ≥ 1. */
export const PV_IO_SLOTS = 2;

/** Per-op race deadline (unref'd timer): the CALLER gives up after this, but the slot stays
 * held until the underlying op actually settles (zombie discipline, §2.5). */
export const PV_IO_OP_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// §2.3-⑧ denial accounting
// ---------------------------------------------------------------------------

/** Denial audit throttle — at most one `deny` audit line per cap per this window (`ext` /
 * `reason` / `capTag` only, never `rel`). */
export const PV_DENY_AUDIT_THROTTLE_MS = 100;
