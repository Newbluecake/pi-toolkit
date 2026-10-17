/**
 * web-hub content-preview — the hub route layer (web-hub-preview plan v3 §3.1/§4.5/§4.7, PV3).
 *
 * Implements the `PreviewRoutes` surface frozen in `hub/ports.ts` (PV1): `handle()` runs §3.1's
 * single-request pipeline ⓪–⑩ for ONE listener (http.ts dispatches loopback always, LAN only
 * when `mode === "on"`), `dispose()` is §4.5.1's bounded (≤1s), idempotent teardown with the
 * three exit paths (runtime close / startup failure / client disconnect) sharing one promise.
 *
 * Layering: this module reaches the disk ONLY through PV2a's kernels — §2.1's fs admitter
 * (cwd-class admission, §4.3), `previewFsStep` (sniff reads), `readAndStream` (§4.5.2) and the
 * `UploadVerifier` (§4.5.3) — plus PV2b's `UploadStore.openForPreview` for the upload class.
 * The upload handle is adapted to `PreviewHandle` here (`ReadableUploadFileHandle` is a
 * structural superset at runtime; its `FileStat` type slice just lacks ctimeMs/nlink, which the
 * adapter reads back defensively).
 *
 * Discipline (source-scan pinned): no `node:fs*` imports, no whole-file reads — same as the
 * kernels (everything streams bounded windows / 64 KiB chunks).
 * `handle()` never throws: every failure is answered through `io.sendJson` under the
 * `PREVIEW_STATUS` table (or, past the head, by `destroy()` inside `readAndStream`), and the
 * request's one audit line is written in the ⑩ `finally` (§4.5: no raw path, filename or
 * content ever reaches the log — only lengths, tags and the HMAC-12 `pathTag`).
 */

import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { canonicalOrigin, parseOrigin } from "../../protocol/lan.js";
import {
  PREVIEW_ADMIT_TOTAL_MS,
  PREVIEW_CHUNK_QUERY,
  PREVIEW_DIR_QUERY,
  PREVIEW_DOWNLOAD_MAX_BYTES,
  PREVIEW_DOWNLOAD_QUERY,
  PREVIEW_DOWNLOAD_STREAM_MS,
  PREVIEW_HDR,
  PREVIEW_IDENT_QUERY,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_IMAGE_MAX_PIXELS,
  PREVIEW_JPEG_SCAN_MAX_BYTES,
  PREVIEW_OFFSET_QUERY,
  PREVIEW_SAMPLE_BYTES,
  PREVIEW_STREAM_MS,
  PREVIEW_TEXT_MAX_BYTES,
  PREVIEW_TEXT_STREAM_HUB_MAX_BYTES,
  normalizePreviewPath,
  parsePreviewOffset,
  validatePreviewIdent,
  validatePreviewPath,
  type PreviewDirListing,
  type PreviewProbeResponseBody,
} from "../../protocol/preview.js";
import {
  PV_IDLE_TTL_MS,
  PV_PREFIX,
  PVW_PREFIX,
  isHtmlEntryPath,
  type PreviewHtmlCapResponseBody,
} from "../../protocol/preview-html.js";
import { auditPreview } from "../audit.js";
import { createCmdLimit, type CmdLimit } from "../cmd-limit.js";
import type { HubLog, PreviewRouteIo, PreviewRoutes, PvIo, RegistryView } from "../ports.js";
import { createReqDeadline, type ReqDeadline } from "../req-deadline.js";
import type { UploadStore } from "../uploads.js";
import {
  createFsAdmitter,
  denyListHit,
  isVirtualFsPath,
  type FsAdmitter,
  type PreviewDenyContext,
  type PreviewFs,
  type PreviewHandle,
} from "./admit.js";
import { boundedClose, createPreviewIoTracker, defaultPreviewFs, previewFsStep, type PreviewIoTracker } from "./fs.js";
import { listPreviewDir } from "./dir.js";
import { openAdmittedPath, type Opened } from "./open.js";
import { dirTooBroad, pinPvDir, pvFailOf } from "./pv-admit.js";
import { createPvRoutes, readHtmlCapBody, type PreviewHtmlDeps, type PvRoutes } from "./pv-routes.js";
import { errCode } from "./pv-path.js";
import { readProbeBody, runPreviewProbe } from "./probe.js";
import { expandTildePath } from "./tilde.js";
import { needsMoreForDims, sniff, type SniffResult } from "./sniff.js";
import { readAndStream, type PreviewSink, type StreamOutcome } from "./stream.js";
import { createUploadVerifier, type UploadVerifier } from "./verify.js";

// ---------------------------------------------------------------------------
// §3.1/§4.7 route constants
// ---------------------------------------------------------------------------

/** §3.1 ②: LAN `authorize()` races against
 * `deriveBudget(r.remaining(), LAN_AUTH_CAP_MS, PREVIEW_AUTH_RESERVE_MS)` — after auth at least
 * 4s of the 8s admission budget must remain for the fs phases ("认证阶段之后至少还留 4s"). */
export const PREVIEW_AUTH_RESERVE_MS = 4_000;

/** §3.1 ④: preview's own token bucket — capacity 20, +1 token / 250ms. */
const PREVIEW_BUCKET_CAPACITY = 20;
const PREVIEW_BUCKET_REFILL_MS = 250;

/** §3.1 ④: in-flight caps (⇒ 503 E_BUSY, not 429 — these are concurrency, not rate). */
const PREVIEW_INFLIGHT_PER_PRINCIPAL = 2;
const PREVIEW_INFLIGHT_GLOBAL = 8;

/** §4.5.1: dispose waits at most this long for active requests to settle. */
const PREVIEW_DISPOSE_WAIT_MS = 1_000;

/** 429 audit throttling (same discipline as http.ts's `RATE_AUDIT_WINDOW_MS`): the token bucket
 * itself re-rejects far more often than the log needs a line for it. */
const RATE_AUDIT_WINDOW_MS = 60_000;

/** §3.1 ③: `agentKey` must match the registry's key shape. */
const AGENT_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** §3.1 ③: `sessionId` is 1–128 printable ASCII characters. */
const SESSION_ID_RE = /^[\x21-\x7e]{1,128}$/;

/** The single response-status table routes answer from (§4.5: "routes.ts 用自己的
 * PREVIEW_STATUS 表直接 sendJson，从不 throw"). */
export const PREVIEW_STATUS: Readonly<Record<string, number>> = {
  E_BAD_REQUEST: 400,
  E_AUTH: 401,
  E_CSRF: 403,
  E_PREVIEW_DENIED: 403,
  E_NOT_FOUND: 404,
  E_SESSION_CHANGED: 409,
  E_PREVIEW_CHANGED: 409,
  E_PREVIEW_TOO_LARGE: 413,
  E_PREVIEW_UNSUPPORTED: 415,
  E_RATE: 429,
  E_INTERNAL: 500,
  E_BUSY: 503,
  E_HUB_RESTARTING: 503,
  E_DEADLINE: 504,
};

// ---------------------------------------------------------------------------
// small local helpers
// ---------------------------------------------------------------------------

function unrefDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    t.unref();
  });
}

/** §3.1 ① CSRF: `X-PWH: 1` mandatory; `Sec-Fetch-Site` must say `same-origin` when present
 * (a plaintext LAN direct-IP fetch carries Origin but no Sec-Fetch-Site — that combination must
 * pass, K16); `Origin` must equal the listener's expected origin when present. */
function previewCsrfOk(req: IncomingMessage, expectedOrigin: string): boolean {
  if (req.headers["x-pwh"] !== "1") return false;
  const sfs = req.headers["sec-fetch-site"];
  if (typeof sfs === "string" && sfs.toLowerCase() !== "same-origin") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const parsed = parseOrigin(origin);
  if (parsed === undefined) return false;
  return canonicalOrigin(parsed.scheme, parsed.hostKey) === expectedOrigin;
}

/** §4.5 audit `ext`: the sanitized extension of the basename — ≤16 ASCII alphanumerics, never
 * any part of the path beyond that. */
function extOf(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = base.slice(dot + 1);
  return /^[A-Za-z0-9]{1,16}$/.test(ext) ? ext.toLowerCase() : undefined;
}

/** PV2b hand-off moved to `open.ts` (2026-10-07 修订): `adaptUploadHandle` + the `Opened`
 * shape now live with the shared ⑤–⑦ pipeline so `routes.ts` and `probe.ts` consume the
 * SAME open result — see `./open.ts`. */

/** §3.1 ⑨: the `PreviewSink` over the real `ServerResponse`. `waitDrain` resolves on drain OR
 * close OR the caller's abort signal (the stream layer races it against its own deadline
 * anyway — this just keeps the listener count bounded). */
function resSink(res: ServerResponse): PreviewSink {
  return {
    get headersSent(): boolean {
      return res.headersSent;
    },
    writeHead(status: number, headers: Record<string, string>): void {
      res.writeHead(status, headers);
    },
    write(chunk: Buffer): boolean {
      return res.write(chunk);
    },
    waitDrain(signal: AbortSignal): Promise<void> {
      return new Promise<void>((resolve) => {
        const done = (): void => {
          res.off("drain", onDrain);
          res.off("close", done);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const onDrain = (): void => done();
        res.once("drain", onDrain);
        res.once("close", done);
        signal.addEventListener("abort", done, { once: true });
      });
    },
    end(): void {
      res.end();
    },
    destroy(): void {
      res.destroy();
    },
  };
}

interface ActiveRequest {
  readonly ctl: AbortController;
  done: Promise<void>;
}

export interface PreviewRoutesDeps {
  mode: "on" | "loopback";
  /** §2.1/§2.6: the fs admitter's deny context (homes[]/agentDirs[], literal+canonical) —
   * REQUIRED; replaces the deleted `home` field, whose only use was constructing the default
   * cwd admitter. hub.ts resolves it once at startup; tests use `denyCtxOf`. */
  denyCtx: PreviewDenyContext;
  /** The uploads root (`webHubUploadsDir(home)`); a request path literally under it is
   * upload-class (§3.1 ⑥). */
  uploadsRoot: string;
  registry: Pick<RegistryView, "get">;
  /** PV2b's read-back open; absent ⇒ every upload-class request answers 404 (§4.2). */
  uploads?: Pick<UploadStore, "openForPreview"> | undefined;
  log: HubLog;
  now(): number;
  /** §7-D14: preview's OWN limiter — absent ⇒ a private `createCmdLimit` instance is created
   * here so preview bucket churn can never evict the cmd/upload lines' buckets. */
  limit?: CmdLimit | undefined;
  admitter?: FsAdmitter | undefined;
  verifier?: UploadVerifier | undefined;
  /** dir-plan §3.5 (P1b): the fs the directory listing rides (opendir/lstat through the SAME
   * injectable surface the admitter uses). Defaults to the real adapter; tests inject scripted
   * handles to drive the §3.3 lifecycle cases. */
  fs?: Partial<PreviewFs> | undefined;
  /** chunked-plan §3.2/§6.1: preview's own zombie-IO tracker — defaults to a private
   * `createPreviewIoTracker()` per instance (§2.4 ownership unchanged; the default admitter,
   * both `readSample` loops, probe's `readHead`, dir.ts AND the chunked stream's races all
   * share it). The seam exists so tests can drive the chunked branch's `busy` fast-fail
   * (503 `E_BUSY` + Retry-After) with a scripted tracker; production never passes it. */
  tracker?: PreviewIoTracker | undefined;
  /** web-hub-html-preview plan v2 §4 (P1b): present ⇒ the HTML-preview surface is attached
   * (`handleHtmlCap`/`servePv`/`serveWrapper`/`revokeHtmlCaps`); `hub.ts` passes it only when
   * `/proc/self/fd` is available. Absent ⇒ the four members do not exist and every existing
   * route behaves byte-identically. The fields are test seams (scripted fs/gate/limits). */
  html?: PreviewHtmlDeps | undefined;
}

/** §1.3 typed probe sender — `io.sendJson`'s `body: unknown` cannot catch a hub↔UI drift, this
 * thin wrapper routes the answer through `PreviewProbeResponseBody` so typecheck can. */
function sendProbeResults(io: PreviewRouteIo, res: ServerResponse, body: PreviewProbeResponseBody): void {
  io.sendJson(res, 200, body);
}

/** §1.3/§3.5 (P1b) typed dir-listing sender — same rationale as `sendProbeResults`: the listing
 * body goes through `PreviewDirListing` so a hub-side shape drift is a compile error. The
 * listing itself was already asserted ≤ `PREVIEW_DIR_BODY_MAX_BYTES` by `listPreviewDir`. */
function sendDirListing(io: PreviewRouteIo, res: ServerResponse, listing: PreviewDirListing): void {
  io.sendJson(res, 200, listing, {
    [PREVIEW_HDR.kind]: "dir",
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
}

export function createPreviewRoutes(deps: PreviewRoutesDeps): PreviewRoutes {
  const { mode, uploadsRoot, registry, uploads, log, now } = deps;
  const limit: CmdLimit = deps.limit ?? createCmdLimit(now);
  /** §2.4 instance ownership: ONE tracker per `createPreviewRoutes` instance, handed to the
   * default admitter, both `readSample` loops, probe's `readHead` (dir.ts joins in P1b) AND
   * (chunked-plan §3.2) the chunked stream's races. Closure-local (never module scope) ⇒ a
   * `/reload`-built sibling starts from 0 zombies. */
  const tracker: PreviewIoTracker = deps.tracker ?? createPreviewIoTracker();
  const admitter: FsAdmitter = deps.admitter ?? createFsAdmitter({ denyCtx: deps.denyCtx, tracker, log, now });
  const verifier: UploadVerifier = deps.verifier ?? createUploadVerifier({ log, now });
  const dirFs: PreviewFs = { ...defaultPreviewFs(), ...deps.fs };

  let closing = false;
  let disposePromise: Promise<void> | undefined;
  const active = new Set<ActiveRequest>();
  const inflightByPrincipal = new Map<string, number>();
  let inflightGlobal = 0;
  /** Per-instance HMAC key for `pathTag` — tags correlate a hub process's own audit lines;
   * cross-process correlation is explicitly not a goal (§4.5). */
  const pathKey = randomBytes(16);
  const rateAuditedAt = new Map<string, number>();

  const pathTagOf = (path: string): string => createHmac("sha256", pathKey).update(path).digest("hex").slice(0, 12);

  /** One mutable accumulator per request; written as the single ⑩ audit line. */
  interface AuditAcc {
    listener: "loopback" | "lan";
    ip: string;
    user?: string | undefined;
    agentKey?: string | undefined;
    cls?: "upload" | "cwd" | "abs" | undefined;
    kind?: "text" | "image" | "dir" | "download" | undefined; // "download": preview-download ⑧dl
    ok: boolean;
    code?: string | undefined;
    reason?: string | undefined;
    verify?: "hashed" | "cached" | "joined" | undefined;
    shared?: boolean | undefined;
    bytes?: number | undefined;
    total?: number | undefined;
    /** chunked-plan §3.3: the chunked-mode request's offset (0 for a first chunk) — a
     * statistics-only integer, written only when `chunk=1` was accepted at ③. */
    offset?: number | undefined;
    truncated?: boolean | undefined;
    ms?: number | undefined;
    ext?: string | undefined;
    pathTag?: string | undefined;
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
    io: PreviewRouteIo,
  ): Promise<void> {
    const ctl = new AbortController();
    const signal = ctl.signal;
    const entry: ActiveRequest = { ctl, done: Promise.resolve() };
    active.add(entry);
    res.once("close", () => {
      if (!res.writableFinished) ctl.abort("client-abort");
    });
    const startedAt = now();
    const acc: AuditAcc = { listener: io.listener, ip: io.ip, ok: false };
    let slotTaken = false;
    let principal = "";
    let opened: Opened | undefined;
    let streamed = false; // once true, readAndStream owns `opened.fh`'s close
    let skipAudit = false; // 429 repeats within the throttle window still answer, just don't re-log

    entry.done = (async (): Promise<void> => {
      const send = (code: string, body: unknown, headers?: Record<string, string>): void => {
        const status = PREVIEW_STATUS[code] ?? 500;
        io.sendJson(res, status, body, headers);
      };

      // ⓪ closing (§4.5.1) — a hub that is mid-teardown never starts new fs work.
      if (closing) {
        acc.code = "E_HUB_RESTARTING";
        send("E_HUB_RESTARTING", { error: "E_HUB_RESTARTING" });
        return;
      }

      // ① CSRF (§3.1 ①) — BEFORE auth, so an unauthenticated cross-origin probe learns nothing.
      if (!previewCsrfOk(req, io.expectedOrigin)) {
        acc.code = "E_CSRF";
        send("E_CSRF", { error: "E_CSRF" });
        return;
      }

      // ② auth — the listener's own gate; on failure it has already answered itself.
      const r = createReqDeadline(now, PREVIEW_ADMIT_TOTAL_MS);
      const authed = await io.authorize(r);
      if ("handled" in authed) {
        acc.code = authed.code;
        return;
      }
      acc.user = authed.user;
      principal = `${io.listener}:${authed.user ?? "token"}`;

      // ③ params
      const agentKey = query.get("agentKey") ?? "";
      const sessionId = query.get("sessionId") ?? "";
      // tilde-expansion addendum: a literal `~` / `~/<rest>` is expanded against the HUB's own
      // home BEFORE any gate below runs (`validatePreviewPath` included) — `tilde.ts`'s own
      // doc comment has the full rationale; `~user/...` is left untouched (never expanded).
      const path = normalizePreviewPath(expandTildePath(query.get("path") ?? "", deps.denyCtx.homes[0] ?? ""));
      // dir-plan §3.5 (P1b): the opt-in directory flag — ONLY the exact value "1" turns an
      // admitted directory into a listing request (§1.1); absent/any other value keeps the
      // pre-P1b behavior byte-identical (a directory still answers 415 not-regular).
      const wantDir = query.get(PREVIEW_DIR_QUERY) === "1";
      // preview-download: the opt-in raw-byte download flag — same "1"-only rule, and
      // MUTUALLY EXCLUSIVE with dir=1 (both ⇒ 400; a directory with download=1 alone keeps
      // the admission chain's plain 415 not-regular, pinned by tests).
      const wantDownload = query.get(PREVIEW_DOWNLOAD_QUERY) === "1";
      if (wantDir && wantDownload) {
        acc.code = "E_BAD_REQUEST";
        send("E_BAD_REQUEST", { error: "E_BAD_REQUEST" });
        return;
      }
      // chunked-plan §2.2 (P1): the opt-in continuation flag — only the exact value "1" turns
      // a text preview into chunked mode; `offset`/`ident` ride as a PAIR (absent on the first
      // chunk). Validation matrix, in order, any failure ⇒ 400 E_BAD_REQUEST:
      //   ① chunk ≠ "1" yet offset/ident present (half-protocol reject);
      //   ② chunk=1 together with dir=1 / download=1 (mutually exclusive modes);
      //   ③ chunk=1 with only ONE of offset/ident (both or neither);
      //   ④ malformed offset (`parsePreviewOffset`: decimal, no leading zeros, safe int,
      //      strictly below the 16 MiB hub hard ceiling);
      //   ⑤ malformed ident (`PREVIEW_IDENT_RE`).
      // `offset=0` + ident IS legal (an identity-checked re-read of the first chunk). A
      // request without any chunk parameter skips every check — byte-identical to before.
      const wantChunk = query.get(PREVIEW_CHUNK_QUERY) === "1";
      const chunkOffsetRaw = query.get(PREVIEW_OFFSET_QUERY);
      const chunkIdentRaw = query.get(PREVIEW_IDENT_QUERY);
      const chunkParamsOk =
        (wantChunk || (chunkOffsetRaw === null && chunkIdentRaw === null)) &&
        (!wantChunk || (chunkOffsetRaw === null) === (chunkIdentRaw === null)) &&
        (!wantChunk ||
          ((chunkOffsetRaw === null || parsePreviewOffset(chunkOffsetRaw) !== null) &&
            (chunkIdentRaw === null || validatePreviewIdent(chunkIdentRaw)))) &&
        !(wantChunk && (wantDir || wantDownload));
      if (!chunkParamsOk) {
        acc.code = "E_BAD_REQUEST";
        send("E_BAD_REQUEST", { error: "E_BAD_REQUEST" });
        return;
      }
      const chunkOffset = wantChunk && chunkOffsetRaw !== null ? parsePreviewOffset(chunkOffsetRaw) : undefined;
      const chunkIdent = wantChunk && chunkIdentRaw !== null ? chunkIdentRaw : undefined;
      const isCont = chunkOffset !== undefined;
      if (wantChunk) acc.offset = chunkOffset ?? 0;
      // dir-plan §2.2 (U4/§1.4): single-segment absolute paths (`/home`, `/etc/hostname`) now
      // enter admission — the recognition layer keeps its own ≥2-segment freeze (C4).
      if (
        !AGENT_KEY_RE.test(agentKey) ||
        !SESSION_ID_RE.test(sessionId) ||
        !validatePreviewPath(path, { minSegments: 1 })
      ) {
        acc.code = "E_BAD_REQUEST";
        send("E_BAD_REQUEST", { error: "E_BAD_REQUEST" });
        return;
      }
      acc.agentKey = agentKey;
      acc.pathTag = pathTagOf(path);
      acc.ext = extOf(path);

      // ④ rate limit + in-flight caps (§3.1 ④)
      const admitted = limit.admit(`${principal}:preview`, PREVIEW_BUCKET_CAPACITY, PREVIEW_BUCKET_REFILL_MS);
      if (!admitted.ok) {
        // 审计键 `preview:${principal}`：429 只按 60s 窗口记一行（令牌桶本身的拒绝频率远高于此）。
        const throttleKey = `preview:${principal}`;
        const t = now();
        const last = rateAuditedAt.get(throttleKey);
        if (last !== undefined && t - last < RATE_AUDIT_WINDOW_MS) {
          skipAudit = true; // still answered below — only the audit line is throttled
        } else {
          rateAuditedAt.set(throttleKey, t);
        }
        acc.code = "E_RATE";
        send(
          "E_RATE",
          { error: "E_RATE" },
          { "Retry-After": String(Math.max(1, Math.ceil(admitted.retryAfterMs / 1000))) },
        );
        return;
      }
      const mine = inflightByPrincipal.get(principal) ?? 0;
      if (mine >= PREVIEW_INFLIGHT_PER_PRINCIPAL || inflightGlobal >= PREVIEW_INFLIGHT_GLOBAL) {
        acc.code = "E_BUSY";
        acc.reason = "inflight";
        send("E_BUSY", { error: "E_BUSY" }, { "Retry-After": "1" });
        return;
      }
      slotTaken = true;
      inflightByPrincipal.set(principal, mine + 1);
      inflightGlobal += 1;

      // ⑤ session → ⑥ classify → ⑦ admit+open (SHARED pipeline, open.ts — the ONE copy of
      // the security decision; `probe.ts` runs the very same function per entry, 2026-10-07
      // 修订). `abortAnswer` lives here (not in open.ts) because only this layer knows the
      // signal's reason — client-abort stays silent, hub-close answers 503 pre-head (§4.3 map).
      const abortAnswer = (): boolean => {
        if (signal.aborted) {
          acc.code = "E_ABORT";
          acc.reason = signal.reason === "hub-close" ? "hub-close" : "client-abort";
          if (signal.reason === "hub-close") send("E_HUB_RESTARTING", { error: "E_HUB_RESTARTING" });
          return true;
        }
        return false;
      };

      const op = await openAdmittedPath(
        { uploadsRoot, registry, uploads, admitter, log },
        {
          agentKey,
          sessionId,
          path,
          listener: io.listener,
          principal,
          ...(wantDir ? { allowDir: true } : {}),
        },
        r,
        signal,
      );
      // ⑥ audit mirror: the ORIGINAL inline code classified at step ⑥ (before the open), so a
      // rejected upload-class request still audited cls:"upload" — keep that (the
      // authoritative classification lives in open.ts; this is display-only). §2.2/C1: the
      // class set is now three-valued — `upload` (literal uploads-root prefix) / `cwd`
      // (literal session-cwd prefix) / `abs` (everything else, U4) — computed purely from
      // strings, zero fs, statistics only.
      const sessView = registry.get(agentKey);
      const sessCwd = sessView?.session?.cwd;
      acc.cls = path.startsWith(`${uploadsRoot}/`)
        ? "upload"
        : sessCwd !== undefined && (path === sessCwd || path.startsWith(`${sessCwd}/`))
          ? "cwd"
          : "abs";
      if (!op.ok) {
        if (op.abort === true) {
          abortAnswer();
          return;
        }
        acc.code = op.code;
        acc.reason = op.reason;
        if (op.busy === true) {
          acc.reason = "store";
          send("E_BUSY", { error: "E_BUSY" }, { "Retry-After": "1" });
          return;
        }
        const body = op.reason === undefined ? { error: op.code } : { error: op.code, reason: op.reason };
        io.sendJson(res, PREVIEW_STATUS[op.code] ?? 500, body);
        return;
      }
      // Ownership of the handle transfers to the route layer HERE — registered on `opened`
      // BEFORE anything else can interleave: a `dispose()`/client-abort landing in the
      // microtask window after the open settled is caught by the `abortAnswer()` below, whose
      // ⑩-finally path closes `opened.fh` (§4.5.1 "fd 全部回收" — never dropped unregistered).
      opened = op.opened;
      acc.shared = opened.shared;
      acc.total = opened.size;
      if (abortAnswer()) return;

      // ⑧d dir branch (dir-plan §3.5, P1b): an admitted directory (only possible when the
      // request opted in with dir=1 AND /proc is available, §3.6) skips sniff/stream entirely —
      // the listing kernel owns the 5 s §3.4 budget, the answer is one JSON body, and ⑩'s
      // release order (answer → bounded close → slot → active → audit) is the §3.3 contract.
      if (opened.dir === true) {
        const realpath = opened.realpath ?? path;
        const dirRes = await listPreviewDir(
          { fs: dirFs, now, log, tracker, denyCtx: deps.denyCtx },
          { fh: opened.fh, realpath, requestPath: path },
          signal,
        );
        if (!dirRes.ok) {
          if (dirRes.abort === true) {
            abortAnswer();
            return;
          }
          acc.code = dirRes.code;
          io.sendJson(
            res,
            PREVIEW_STATUS[dirRes.code] ?? 500,
            { error: dirRes.code },
            dirRes.code === "E_BUSY" || dirRes.retryAfterS !== undefined ? { "Retry-After": "1" } : undefined,
          );
          return;
        }
        acc.ok = true;
        acc.kind = "dir";
        acc.total = dirRes.listing.total; // §3.5: total/truncated ride the audit — never names
        acc.truncated = dirRes.listing.truncated;
        sendDirListing(io, res, dirRes.listing);
        return;
      }

      // ⑧dl download branch (preview-download): raw bytes for ANY admitted regular file —
      // no sniff, no kind/dims gate, no image byte cap (the download cap is the 256 MiB
      // protocol constant, loopback/LAN 同宽 U1, checked BEFORE the head). The stream itself
      // rides the same readAndStream kernel (streaming sha256 for the upload class, held-back
      // last chunk, destroy-on-mismatch) with the download flow's octet-stream headers and
      // its own 120s write-out budget (sized for the cap over a slow LAN).
      if (wantDownload) {
        if (opened.size > PREVIEW_DOWNLOAD_MAX_BYTES) {
          acc.code = "E_PREVIEW_TOO_LARGE";
          acc.reason = "bytes";
          io.sendJson(res, PREVIEW_STATUS["E_PREVIEW_TOO_LARGE"]!, {
            error: "E_PREVIEW_TOO_LARGE",
            size: opened.size,
            max: PREVIEW_DOWNLOAD_MAX_BYTES,
            reason: "bytes",
          });
          return;
        }
        // basename for Content-Disposition — the same lossy-name rule as the UI (a name with
        // U+FFFD degrades to "download"); the REQUESTED path's basename, not the realpath's
        // (the user recognises what they clicked).
        const slash = path.lastIndexOf("/");
        const base = slash >= 0 && slash < path.length - 1 ? path.slice(slash + 1) : path;
        const filename = base === "" || base.includes("\uFFFD") ? "download" : base;
        streamed = true;
        const dlOutcome: StreamOutcome = await readAndStream(
          {
            fh: opened.fh,
            size: opened.size,
            sniff: { kind: "binary" }, // unused by the download flow — no sniff ran
            sample: Buffer.alloc(0),
            ...(opened.verify === undefined ? {} : { verify: opened.verify }),
            download: { filename },
          },
          resSink(res),
          {
            signal,
            streamAt: PREVIEW_DOWNLOAD_STREAM_MS,
            textMax: PREVIEW_TEXT_MAX_BYTES,
            now,
            verifier,
          },
        );
        if (dlOutcome.ok) {
          acc.ok = true;
          acc.kind = "download";
          acc.bytes = dlOutcome.bytes;
          acc.verify = dlOutcome.verify;
          return;
        }
        acc.reason = dlOutcome.reason;
        switch (dlOutcome.reason) {
          case "client-abort":
            acc.code = "E_ABORT";
            return; // 不应答 (§4.3 map)
          case "hub-close":
            acc.code = "E_ABORT";
            if (!dlOutcome.headersSent) send("E_HUB_RESTARTING", { error: "E_HUB_RESTARTING" });
            return;
          case "shrunk":
          case "hash-mismatch":
          case "identity-changed":
            acc.code = "E_PREVIEW_CHANGED";
            if (!dlOutcome.headersSent) send("E_PREVIEW_CHANGED", { error: "E_PREVIEW_CHANGED" });
            return;
          case "verify-timeout":
          case "verify-deadline":
          case "stream-deadline":
            acc.code = "E_DEADLINE";
            if (!dlOutcome.headersSent) send("E_DEADLINE", { error: "E_DEADLINE" });
            return;
          default:
            acc.code = "E_INTERNAL";
            if (!dlOutcome.headersSent) send("E_INTERNAL", { error: "E_INTERNAL" });
            return;
        }
      }

      // ⑧ sniff (§3.1 ⑧ — the two reads stay inside the shared admission deadline)
      const sample = await readSample(opened.fh, opened.size, r, signal);
      if (signal.aborted) {
        abortAnswer();
        return;
      }
      const sniffed = sniff(sample, opened.size);
      acc.kind = sniffed.kind === "image" ? "image" : sniffed.kind === "text" ? "text" : undefined;
      // chunked-plan §3.3: a CONTINUATION re-ran the sniff like every request does (D5 — the
      // full ⓪–⑩ chain, no exemption); a file that no longer sniffs as text kills the stream:
      // 409 E_PREVIEW_CHANGED BEFORE the binary-415 / image branches (a continuation never
      // returns 415 or an image body). A FIRST chunk (chunk=1 without offset) that sniffs
      // image still takes the image branch verbatim — chunk is ignored for images.
      if (wantChunk && isCont && sniffed.kind !== "text") {
        acc.code = "E_PREVIEW_CHANGED";
        send("E_PREVIEW_CHANGED", { error: "E_PREVIEW_CHANGED" });
        return;
      }
      if (sniffed.kind === "binary") {
        acc.code = "E_PREVIEW_UNSUPPORTED";
        acc.reason = "binary";
        io.sendJson(res, PREVIEW_STATUS["E_PREVIEW_UNSUPPORTED"]!, {
          error: "E_PREVIEW_UNSUPPORTED",
          size: opened.size,
          reason: "binary",
        });
        return;
      }
      // §0/§4.1: the byte cap is an IMAGE-only hard reject (loopback 16 MiB / LAN 4 MiB ⇒ 413
      // reason:"bytes"). TEXT has no byte rejection — `PREVIEW_TEXT_MAX_BYTES` is the DISPLAY cap:
      // an oversized text is SERVED truncated on a UTF-8 character boundary (§4.5.2, header
      // `X-PWH-Preview-Truncated: 1`), which is also what makes the §6 single-flight acceptance
      // (concurrent reads of one 100 MiB text) reachable at all.
      if (sniffed.kind === "image") {
        const byteCap = PREVIEW_IMAGE_MAX_BYTES[io.listener];
        if (opened.size > byteCap) {
          acc.code = "E_PREVIEW_TOO_LARGE";
          acc.reason = "bytes";
          io.sendJson(res, PREVIEW_STATUS["E_PREVIEW_TOO_LARGE"]!, {
            error: "E_PREVIEW_TOO_LARGE",
            size: opened.size,
            max: byteCap,
            reason: "bytes",
          });
          return;
        }
        const dims = sniffed.dims;
        if (dims === null) {
          acc.code = "E_PREVIEW_UNSUPPORTED";
          acc.reason = "dims-unknown";
          io.sendJson(res, PREVIEW_STATUS["E_PREVIEW_UNSUPPORTED"]!, {
            error: "E_PREVIEW_UNSUPPORTED",
            size: opened.size,
            reason: "dims-unknown",
          });
          return;
        }
        if (dims.w * dims.h > PREVIEW_IMAGE_MAX_PIXELS) {
          acc.code = "E_PREVIEW_TOO_LARGE";
          acc.reason = "pixels";
          io.sendJson(res, PREVIEW_STATUS["E_PREVIEW_TOO_LARGE"]!, {
            error: "E_PREVIEW_TOO_LARGE",
            size: opened.size,
            max: PREVIEW_IMAGE_MAX_PIXELS,
            reason: "pixels",
            dims,
          });
          return;
        }
      }

      // ⑨ write-out (§4.5.2) — from here on readAndStream owns the handle. chunked-plan §3.2/
      // §3.3: a chunked-mode TEXT request additionally carries `chunk` (the validated offset,
      // the optional ident echo and the 16 MiB hub hard ceiling) and the routes instance's
      // tracker — the ONLY flow whose races count as zombies (continuations hit cold/slow fs
      // at arbitrary offsets, so they join the §2.4 circuit breaker). Everything else — first
      // chunk included — rides the exact same src/opts shape as before.
      streamed = true;
      const rawAcceptEncoding = req.headers["accept-encoding"];
      const acceptEncoding = Array.isArray(rawAcceptEncoding) ? rawAcceptEncoding[0] : rawAcceptEncoding;
      const wantChunkText = wantChunk && sniffed.kind === "text";
      const outcome: StreamOutcome = await readAndStream(
        {
          fh: opened.fh,
          size: opened.size,
          sniff: sniffed,
          sample,
          ...(opened.verify === undefined ? {} : { verify: opened.verify }),
          ...(wantChunkText
            ? {
                chunk: {
                  offset: chunkOffset ?? 0,
                  ...(chunkIdent === undefined ? {} : { ident: chunkIdent }),
                  ceiling: PREVIEW_TEXT_STREAM_HUB_MAX_BYTES,
                },
              }
            : {}),
        },
        resSink(res),
        {
          signal,
          streamAt: PREVIEW_STREAM_MS[io.listener],
          textMax: PREVIEW_TEXT_MAX_BYTES,
          now,
          verifier,
          ...(acceptEncoding === undefined ? {} : { acceptEncoding }),
          ...(wantChunkText ? { tracker } : {}),
        },
      );
      if (outcome.ok) {
        acc.ok = true;
        acc.bytes = outcome.bytes;
        acc.truncated = outcome.truncated;
        acc.verify = outcome.verify;
        return;
      }
      acc.reason = outcome.reason;
      switch (outcome.reason) {
        case "client-abort":
          acc.code = "E_ABORT";
          return; // 不应答 (§4.3 map)
        case "hub-close":
          acc.code = "E_ABORT";
          if (!outcome.headersSent) send("E_HUB_RESTARTING", { error: "E_HUB_RESTARTING" });
          return; // head already sent ⇒ readAndStream destroyed the response
        case "shrunk":
        case "hash-mismatch":
        case "identity-changed":
          acc.code = "E_PREVIEW_CHANGED";
          if (!outcome.headersSent) send("E_PREVIEW_CHANGED", { error: "E_PREVIEW_CHANGED" });
          return;
        case "verify-timeout":
        case "verify-deadline":
        case "stream-deadline":
          acc.code = "E_DEADLINE";
          if (!outcome.headersSent) send("E_DEADLINE", { error: "E_DEADLINE" });
          return;
        // chunked-plan §2.3: the two chunked-only pre-head failures. `range` is a client
        // arithmetic error (offset ≥ size); `busy` is the chunked branch's tracker pre-check
        // — both are answered with the retry hint the UI's 429/503 backoff understands.
        case "range":
          acc.code = "E_BAD_REQUEST";
          acc.reason = "offset";
          if (!outcome.headersSent) send("E_BAD_REQUEST", { error: "E_BAD_REQUEST", reason: "offset" });
          return;
        case "busy":
          acc.code = "E_BUSY";
          acc.reason = "stream";
          if (!outcome.headersSent) send("E_BUSY", { error: "E_BUSY" }, { "Retry-After": "1" });
          return;
        default:
          acc.code = "E_INTERNAL";
          if (!outcome.headersSent) send("E_INTERNAL", { error: "E_INTERNAL" });
          return;
      }
    })().catch((err: unknown) => {
      // handle() never throws (§4.5); this belt-and-braces catch still guarantees it.
      acc.code = "E_INTERNAL";
      log.error("preview route: unexpected pipeline failure", { error: String(err) });
      if (!res.headersSent && !res.destroyed) io.sendJson(res, 500, { error: "E_INTERNAL" });
      else res.destroy();
    });

    try {
      await entry.done;
    } finally {
      // ⑩ 收尾 (§3.3 P1b: the release order is FIXED — ①answer [done: entry.done settled after
      // the response was sent] → ②bounded close of a DIRECTORY fd, ≤1 s, even if the request
      // aborted; file requests keep today's plain close → ③in-flight slot → ④active set → ⑤
      // the single audit line).
      const held = opened;
      if (held !== undefined && !streamed) {
        if (held.dir === true) {
          await boundedClose(() => held.fh.close(), { now, tracker, log });
        } else {
          await held.fh.close().catch(() => undefined);
        }
      }
      if (slotTaken) {
        inflightGlobal = Math.max(0, inflightGlobal - 1);
        const left = (inflightByPrincipal.get(principal) ?? 1) - 1;
        if (left <= 0) inflightByPrincipal.delete(principal);
        else inflightByPrincipal.set(principal, left);
      }
      active.delete(entry);
      acc.ms = now() - startedAt;
      if (!skipAudit) auditPreview(log, { phase: "request", ...acc });
    }
  }

  /** §3.1 ⑧: read `min(size, 64 KiB)`, continuing (JPEG only, `needsMoreForDims`) up to
   * `PREVIEW_JPEG_SCAN_MAX_BYTES`. Each read is its own budgeted fs step (§4.3: steps #7/#8 of
   * the cwd-class count; upload-class sniff read). EOF early (file shrank) is NOT an error here
   * — §4.5.2's readAndStream classifies `shrunk` on its own copy. */
  async function readSample(
    fh: PreviewHandle,
    size: number,
    deadline: ReqDeadline,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const first = Math.min(size, PREVIEW_SAMPLE_BYTES);
    let sample = Buffer.alloc(first);
    let got = 0;
    while (got < first) {
      const { bytesRead } = await previewFsStep(() => fh.read(sample, got, first - got, got), deadline, signal, {
        now,
        tracker,
      });
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    sample = sample.subarray(0, got);
    const cap = Math.min(size, PREVIEW_JPEG_SCAN_MAX_BYTES);
    while (got < cap && needsMoreForDims(sample)) {
      const next = Buffer.alloc(Math.min(PREVIEW_SAMPLE_BYTES, cap - got));
      const { bytesRead } = await previewFsStep(() => fh.read(next, 0, next.length, got), deadline, signal, {
        now,
        tracker,
      });
      if (bytesRead === 0) break;
      sample = Buffer.concat([sample, next.subarray(0, bytesRead)]);
      got += bytesRead;
    }
    return sample;
  }

  /**
   * `POST /api/preview/probe` (2026-10-07 修订「先探测后标记」): the batch existence probe.
   * Same request lifecycle as `handle` — ⓪ closing → ① CSRF (BEFORE auth) → ② authorize →
   * ③ params → ④ rate limit (its OWN bucket line `…:probe`, same D14-private limiter) +
   * in-flight slot (one probe request = one slot, same caps) → body read/validate (probe.ts)
   * → `runPreviewProbe` (the SHARED ⑤–⑦ open per entry + head sniff) → one JSON answer —
   * plus the same ⑩ teardown: an abort is answered only for hub-close (503), a client
   * disconnect stays silent, and exactly one `phase:"probe"` audit line is written (no raw
   * path — only the count in `total`, same §4.5 discipline).
   */
  async function handleProbe(
    req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
    io: PreviewRouteIo,
  ): Promise<void> {
    const ctl = new AbortController();
    const signal = ctl.signal;
    const entry: ActiveRequest = { ctl, done: Promise.resolve() };
    active.add(entry);
    res.once("close", () => {
      if (!res.writableFinished) ctl.abort("client-abort");
    });
    const startedAt = now();
    const acc: AuditAcc = { listener: io.listener, ip: io.ip, ok: false };
    let slotTaken = false;
    let principal = "";
    let skipAudit = false;

    entry.done = (async (): Promise<void> => {
      const send = (code: string, body: unknown, headers?: Record<string, string>): void => {
        const status = PREVIEW_STATUS[code] ?? 500;
        io.sendJson(res, status, body, headers);
      };

      if (closing) {
        acc.code = "E_HUB_RESTARTING";
        send("E_HUB_RESTARTING", { error: "E_HUB_RESTARTING" });
        return;
      }
      if (!previewCsrfOk(req, io.expectedOrigin)) {
        acc.code = "E_CSRF";
        send("E_CSRF", { error: "E_CSRF" });
        return;
      }
      const r = createReqDeadline(now, PREVIEW_ADMIT_TOTAL_MS);
      const authed = await io.authorize(r);
      if ("handled" in authed) {
        acc.code = authed.code;
        return;
      }
      acc.user = authed.user;
      principal = `${io.listener}:${authed.user ?? "token"}`;

      const agentKey = query.get("agentKey") ?? "";
      const sessionId = query.get("sessionId") ?? "";
      if (!AGENT_KEY_RE.test(agentKey) || !SESSION_ID_RE.test(sessionId)) {
        acc.code = "E_BAD_REQUEST";
        send("E_BAD_REQUEST", { error: "E_BAD_REQUEST" });
        return;
      }
      acc.agentKey = agentKey;

      const admitted = limit.admit(`${principal}:probe`, PREVIEW_BUCKET_CAPACITY, PREVIEW_BUCKET_REFILL_MS);
      if (!admitted.ok) {
        const throttleKey = `probe:${principal}`;
        const t = now();
        const last = rateAuditedAt.get(throttleKey);
        if (last !== undefined && t - last < RATE_AUDIT_WINDOW_MS) {
          skipAudit = true;
        } else {
          rateAuditedAt.set(throttleKey, t);
        }
        acc.code = "E_RATE";
        send(
          "E_RATE",
          { error: "E_RATE" },
          { "Retry-After": String(Math.max(1, Math.ceil(admitted.retryAfterMs / 1000))) },
        );
        return;
      }
      const mine = inflightByPrincipal.get(principal) ?? 0;
      if (mine >= PREVIEW_INFLIGHT_PER_PRINCIPAL || inflightGlobal >= PREVIEW_INFLIGHT_GLOBAL) {
        acc.code = "E_BUSY";
        acc.reason = "inflight";
        send("E_BUSY", { error: "E_BUSY" }, { "Retry-After": "1" });
        return;
      }
      slotTaken = true;
      inflightByPrincipal.set(principal, mine + 1);
      inflightGlobal += 1;

      // ⑤ session (request-level, mirroring preview's step ⑤ placement): the named session
      // must be currently visible BEFORE any body is read — unknown agent 404, mismatched
      // sessionId 409, byte-identical with `GET /api/preview`. (The shared per-path pipeline
      // re-checks too — a session dying MID-batch degrades those entries to missing, not 409.)
      const view = registry.get(agentKey);
      if (view === undefined) {
        acc.code = "E_NOT_FOUND";
        send("E_NOT_FOUND", { error: "E_NOT_FOUND" });
        return;
      }
      const session = view.session;
      if (session === undefined || session.sessionId !== sessionId) {
        acc.code = "E_SESSION_CHANGED";
        send("E_SESSION_CHANGED", { error: "E_SESSION_CHANGED" });
        return;
      }

      const body = await readProbeBody(req);
      if (!body.ok) {
        acc.code = body.code;
        acc.reason = body.reason;
        io.sendJson(res, body.status, { error: body.code, reason: body.reason });
        return;
      }

      // tilde-expansion addendum: every probe candidate gets the SAME `~`/`~/<rest>` expansion
      // as a real preview request, before it ever reaches `openAdmittedPath` — a probed path
      // and the preview click it predicts must walk the identical admission input.
      const home = deps.denyCtx.homes[0] ?? "";
      const expandedPaths = body.body.paths.map((p) => expandTildePath(p, home));
      const run = await runPreviewProbe(
        { uploadsRoot, registry, uploads, admitter, log, now, tracker },
        {
          agentKey,
          sessionId,
          paths: expandedPaths,
          listener: io.listener,
          principal,
          ...(body.body.dirs === true ? { dirs: true } : {}),
          // preview-download: the files opt-in threads through exactly like dirs above.
          ...(body.body.files === true ? { files: true } : {}),
        },
        r,
        signal,
      );
      if (!run.ok) {
        // §4.3 abort map, exactly like handle(): client-abort stays silent, hub-close 503.
        acc.code = "E_ABORT";
        acc.reason = signal.reason === "hub-close" ? "hub-close" : "client-abort";
        if (signal.reason === "hub-close") send("E_HUB_RESTARTING", { error: "E_HUB_RESTARTING" });
        return;
      }
      acc.ok = true;
      acc.total = body.body.paths.length;
      // Wire contract (2026-10-07): one `{kind}` object per entry, request order — through the
      // §1.3 typed sender so the hub side can never drift from `PreviewProbeResponseBody`.
      const probeBody: PreviewProbeResponseBody = { results: run.results.map((kind) => ({ kind })) };
      sendProbeResults(io, res, probeBody);
    })().catch((err: unknown) => {
      acc.code = "E_INTERNAL";
      log.error("preview probe route: unexpected pipeline failure", { error: String(err) });
      if (!res.headersSent && !res.destroyed) io.sendJson(res, 500, { error: "E_INTERNAL" });
      else res.destroy();
    });

    try {
      await entry.done;
    } finally {
      if (slotTaken) {
        inflightGlobal = Math.max(0, inflightGlobal - 1);
        const left = (inflightByPrincipal.get(principal) ?? 1) - 1;
        if (left <= 0) inflightByPrincipal.delete(principal);
        else inflightByPrincipal.set(principal, left);
      }
      active.delete(entry);
      acc.ms = now() - startedAt;
      if (!skipAudit) auditPreview(log, { phase: "probe", ...acc });
    }
  }

  // -------------------------------------------------------------------------
  // web-hub-html-preview plan v2 §2.1 (P1b): `POST /api/preview/html-cap` — mint one capability.
  // The serve side (`/pv`, `/pvw`, queue, revocation) lives in `pv-routes.ts`; the mint stays
  // here because it shares this closure's limiter / in-flight caps / admitter / audit key.
  // -------------------------------------------------------------------------

  const pv: PvRoutes | undefined =
    deps.html === undefined
      ? undefined
      : createPvRoutes({ log, now, denyCtx: deps.denyCtx, html: deps.html, makeSink: resSink, verifier });

  /** D2's refused uploads roots: the real root(s) in literal AND canonical form (the mint's
   * `boundDir` is a realpath, so a symlinked uploads dir must be matched canonically too).
   * Cached only once every realpath resolved (a not-yet-created dir is retried next mint). */
  let uploadsRootsCache: readonly string[] | undefined;
  const resolveUploadsRoots = async (deadlineAt: number, signal: AbortSignal): Promise<readonly string[]> => {
    if (uploadsRootsCache !== undefined) return uploadsRootsCache;
    const literal = deps.html?.uploadsRoots ?? [uploadsRoot];
    const out = new Set<string>(literal);
    let complete = true;
    const fs: PreviewFs = { ...defaultPreviewFs(), ...deps.html?.fs };
    for (const root of literal) {
      try {
        out.add(await pv!.gate.run(() => fs.realpath(root), { deadlineAt, signal }));
      } catch {
        complete = false;
      }
    }
    const roots = [...out];
    if (complete) uploadsRootsCache = roots;
    return roots;
  };

  const MINT_AUDIT_KEYS = [
    "listener",
    "ip",
    "user",
    "agentKey",
    "cls",
    "ok",
    "code",
    "reason",
    "ms",
    "ext",
    "pathTag",
    "capTag",
  ] as const;

  async function handleHtmlCap(
    req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
    io: PreviewRouteIo,
  ): Promise<void> {
    const pvr = pv as PvRoutes; // attached only when `pv` exists
    const ctl = new AbortController();
    const signal = ctl.signal;
    const entry: ActiveRequest = { ctl, done: Promise.resolve() };
    active.add(entry);
    res.once("close", () => {
      if (!res.writableFinished) ctl.abort("client-abort");
    });
    const startedAt = now();
    const acc: {
      listener: "loopback" | "lan";
      ip: string;
      user?: string | undefined;
      agentKey?: string | undefined;
      cls?: "upload" | "cwd" | "abs" | undefined;
      ok: boolean;
      code?: string | undefined;
      reason?: string | undefined;
      ms?: number | undefined;
      ext?: string | undefined;
      pathTag?: string | undefined;
      capTag?: string | undefined;
    } = { listener: io.listener, ip: io.ip, ok: false };
    let slotTaken = false;
    let principal = "";
    let skipAudit = false;
    let entryFh: PreviewHandle | undefined;
    const closeEntry = async (): Promise<void> => {
      const fh = entryFh;
      if (fh === undefined) return;
      entryFh = undefined;
      await boundedClose(() => fh.close(), { now, tracker, log });
    };

    entry.done = (async (): Promise<void> => {
      const send = (code: string, body: unknown, headers?: Record<string, string>): void => {
        io.sendJson(res, PREVIEW_STATUS[code] ?? 500, body, headers);
      };
      const sendFail = (f: { status: number; code: string; reason?: string | undefined }): void => {
        acc.code = f.code;
        acc.reason = f.reason;
        io.sendJson(
          res,
          f.status,
          f.reason === undefined ? { error: f.code } : { error: f.code, reason: f.reason },
          f.status === 503 ? { "Retry-After": "1" } : undefined,
        );
      };
      const abortAnswer = (): boolean => {
        if (signal.aborted) {
          acc.code = "E_ABORT";
          acc.reason = signal.reason === "hub-close" ? "hub-close" : "client-abort";
          if (signal.reason === "hub-close") send("E_HUB_RESTARTING", { error: "E_HUB_RESTARTING" });
          return true;
        }
        return false;
      };

      // ⓪ closing
      if (closing || pvr.isClosing()) {
        acc.code = "E_HUB_RESTARTING";
        send("E_HUB_RESTARTING", { error: "E_HUB_RESTARTING" });
        return;
      }
      // ① CSRF (X-PWH + same-origin) and a JSON body — BEFORE auth, like probe
      const ct = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (!previewCsrfOk(req, io.expectedOrigin) || ct !== "application/json") {
        acc.code = "E_CSRF";
        send("E_CSRF", { error: "E_CSRF" });
        return;
      }
      // R2 #2: the revoke sequence is captured BEFORE `authorize` is called — authorize is
      // async, so a logout/passwd landing after its session lookup resolved but before this
      // coroutine resumes must still count against this mint.
      const seq0 = pvr.store.revokeSeq();
      const r = createReqDeadline(now, PREVIEW_ADMIT_TOTAL_MS);
      const authed = await io.authorize(r);
      if ("handled" in authed) {
        acc.code = authed.code;
        return;
      }
      acc.user = authed.user;
      principal = `${io.listener}:${authed.user ?? "token"}`;

      // ② params + body + path
      const agentKey = query.get("agentKey") ?? "";
      const sessionId = query.get("sessionId") ?? "";
      if (!AGENT_KEY_RE.test(agentKey) || !SESSION_ID_RE.test(sessionId)) {
        acc.code = "E_BAD_REQUEST";
        send("E_BAD_REQUEST", { error: "E_BAD_REQUEST" });
        return;
      }
      acc.agentKey = agentKey;
      const body = await readHtmlCapBody(req);
      if (!body.ok) {
        acc.code = body.code;
        acc.reason = body.reason;
        io.sendJson(res, body.status, { error: body.code, reason: body.reason });
        return;
      }
      const path = normalizePreviewPath(expandTildePath(body.path, deps.denyCtx.homes[0] ?? ""));
      if (!validatePreviewPath(path, { minSegments: 1 }) || !isHtmlEntryPath(path)) {
        acc.code = "E_BAD_REQUEST";
        acc.reason = "path";
        send("E_BAD_REQUEST", { error: "E_BAD_REQUEST", reason: "path" });
        return;
      }
      acc.pathTag = pathTagOf(path);
      acc.ext = extOf(path);

      // ③ preview bucket (1 token, the SAME `${principal}:preview` line) + in-flight caps
      const admitted = limit.admit(`${principal}:preview`, PREVIEW_BUCKET_CAPACITY, PREVIEW_BUCKET_REFILL_MS);
      if (!admitted.ok) {
        const throttleKey = `preview:${principal}`;
        const t = now();
        const last = rateAuditedAt.get(throttleKey);
        if (last !== undefined && t - last < RATE_AUDIT_WINDOW_MS) skipAudit = true;
        else rateAuditedAt.set(throttleKey, t);
        acc.code = "E_RATE";
        send(
          "E_RATE",
          { error: "E_RATE" },
          { "Retry-After": String(Math.max(1, Math.ceil(admitted.retryAfterMs / 1000))) },
        );
        return;
      }
      const mine = inflightByPrincipal.get(principal) ?? 0;
      if (mine >= PREVIEW_INFLIGHT_PER_PRINCIPAL || inflightGlobal >= PREVIEW_INFLIGHT_GLOBAL) {
        acc.code = "E_BUSY";
        acc.reason = "inflight";
        send("E_BUSY", { error: "E_BUSY" }, { "Retry-After": "1" });
        return;
      }
      slotTaken = true;
      inflightByPrincipal.set(principal, mine + 1);
      inflightGlobal += 1;

      // ④ session visibility; an upload-class path is refused BEFORE any open (v1 non-goal)
      const view = registry.get(agentKey);
      if (view === undefined) {
        acc.code = "E_NOT_FOUND";
        send("E_NOT_FOUND", { error: "E_NOT_FOUND" });
        return;
      }
      const session = view.session;
      if (session === undefined || session.sessionId !== sessionId) {
        acc.code = "E_SESSION_CHANGED";
        send("E_SESSION_CHANGED", { error: "E_SESSION_CHANGED" });
        return;
      }
      acc.cls = path.startsWith(`${uploadsRoot}/`)
        ? "upload"
        : path === session.cwd || path.startsWith(`${session.cwd}/`)
          ? "cwd"
          : "abs";
      if (acc.cls === "upload") {
        sendFail({ status: 403, code: "E_PREVIEW_DENIED", reason: "upload" });
        return;
      }

      // ⑤–⑦ the shared admission chain (the ONE copy of "may this request read this path")
      const op = await openAdmittedPath(
        { uploadsRoot, registry, uploads: undefined, admitter, log },
        { agentKey, sessionId, path, listener: io.listener, principal },
        r,
        signal,
      );
      if (!op.ok) {
        if (op.abort === true) {
          abortAnswer();
          return;
        }
        acc.code = op.code;
        acc.reason = op.reason;
        if (op.busy === true) {
          acc.reason = "store";
          send("E_BUSY", { error: "E_BUSY" }, { "Retry-After": "1" });
          return;
        }
        io.sendJson(
          res,
          PREVIEW_STATUS[op.code] ?? 500,
          op.reason === undefined ? { error: op.code } : { error: op.code, reason: op.reason },
        );
        return;
      }
      entryFh = op.opened.fh; // ownership: closed by `closeEntry` (below / finally)
      if (abortAnswer()) return;
      const entryRp = op.opened.realpath;
      if (op.opened.cls === "upload" || entryRp === undefined) {
        sendFail({ status: 403, code: "E_PREVIEW_DENIED", reason: "upload" });
        return;
      }

      // ⑤ bound dir + entry identity
      const fstat = await pvr.gate
        .run(() => (entryFh as PreviewHandle).stat(), { deadlineAt: r.at, signal })
        .then(
          (st) => ({ ok: true as const, st }),
          (err: unknown) => ({ ok: false as const, fail: pvFailOf(err) }),
        );
      if (!fstat.ok) {
        if (fstat.fail.status === 0) abortAnswer();
        else sendFail(fstat.fail);
        return;
      }
      const slash = entryRp.lastIndexOf("/");
      const boundDir = slash <= 0 ? "/" : entryRp.slice(0, slash);
      const entryName = entryRp.slice(slash + 1);
      // D2 (+ check #1: the REAL uploads roots) and check #2: the denylist on the bound dir itself
      const uploadsRoots = await resolveUploadsRoots(r.at, signal);
      if (abortAnswer()) return;
      if (dirTooBroad(boundDir, deps.denyCtx, uploadsRoots)) {
        sendFail({ status: 403, code: "E_PREVIEW_DENIED", reason: "dir-too-broad" });
        return;
      }
      if (denyListHit(boundDir, deps.denyCtx)) {
        sendFail({ status: 403, code: "E_PREVIEW_DENIED", reason: "denylist" });
        return;
      }
      if (isVirtualFsPath(boundDir)) {
        sendFail({ status: 403, code: "E_PREVIEW_DENIED", reason: "virtual-fs" });
        return;
      }

      // ⑥ dir pin (all through the PV IO gate); then the entry fh is no longer needed
      const pin = await pinPvDir(pvr.admitDeps, {
        boundDir,
        entry: entryName,
        entryDev: fstat.st.dev,
        entryIno: fstat.st.ino,
        deadlineAt: r.at,
        signal,
      });
      await closeEntry();
      if (!pin.ok) {
        if (pin.status === 0) abortAnswer();
        else sendFail(pin);
        return;
      }

      // the pinned directory's own identity (recorded on the cap) — one more gated step; the
      // sync check-then-insert below must come AFTER every await
      const dstat = await pvr.gate
        .run(() => pin.dirFh.stat(), { deadlineAt: r.at, signal })
        .then(
          (st) => ({ ok: true as const, st }),
          (err: unknown) => ({ ok: false as const, fail: pvFailOf(err) }),
        );
      if (!dstat.ok) {
        await pvr.gate.close(() => pin.dirFh.close());
        if (dstat.fail.status === 0) abortAnswer();
        else sendFail(dstat.fail);
        return;
      }

      // ⑦ revocation re-check + insert: ONE synchronous check-then-insert (`mintChecked`,
      // same tick — no await between the `seq0` comparison and the store insert)
      const dead = closing || pvr.isClosing() || signal.aborted;
      const minted = dead
        ? undefined
        : pvr.store.mintChecked(seq0, {
            principal,
            listener: io.listener,
            origin: io.expectedOrigin,
            sidTag: authed.sidTag,
            userId: authed.userId,
            dirFh: pin.dirFh,
            dirPath: boundDir,
            dirDev: dstat.st.dev,
            dirIno: dstat.st.ino,
            entry: entryName,
          });
      if (minted === undefined || !minted.ok) {
        await pvr.gate.close(() => pin.dirFh.close());
        if (minted === undefined) {
          if (!abortAnswer()) {
            acc.code = "E_HUB_RESTARTING";
            send("E_HUB_RESTARTING", { error: "E_HUB_RESTARTING" });
          }
        } else if (minted.reason === "revoked") {
          acc.code = "E_AUTH";
          acc.reason = "revoked";
          send("E_AUTH", { error: "E_AUTH" });
        } else {
          acc.code = "E_BUSY";
          acc.reason = "tombstone-gap";
          send("E_BUSY", { error: "E_BUSY" }, { "Retry-After": "1" });
        }
        return;
      }
      const rec = minted.rec;
      acc.ok = true;
      acc.capTag = rec.capTag;
      const answer: PreviewHtmlCapResponseBody = {
        url: `${PV_PREFIX}${rec.cap}/${encodeURIComponent(rec.entry)}`,
        openUrl: `${PVW_PREFIX}${rec.cap}`,
        idleMs: pvr.idleMs > 0 ? pvr.idleMs : PV_IDLE_TTL_MS,
        hardRemainingMs: Math.max(0, rec.hardAt - now()),
      };
      io.sendJson(res, 200, answer, { "Cache-Control": "no-store" });
    })().catch((err: unknown) => {
      acc.code = "E_INTERNAL";
      log.error("preview html-cap route: unexpected pipeline failure", { code: errCode(err) });
      if (!res.headersSent && !res.destroyed) io.sendJson(res, 500, { error: "E_INTERNAL" });
      else res.destroy();
    });

    try {
      await entry.done;
    } finally {
      await closeEntry();
      if (slotTaken) {
        inflightGlobal = Math.max(0, inflightGlobal - 1);
        const left = (inflightByPrincipal.get(principal) ?? 1) - 1;
        if (left <= 0) inflightByPrincipal.delete(principal);
        else inflightByPrincipal.set(principal, left);
      }
      active.delete(entry);
      acc.ms = now() - startedAt;
      if (!skipAudit) {
        const out: Record<string, unknown> = { audit: "preview", kind: "html-cap" };
        const raw = acc as unknown as Record<string, unknown>;
        for (const k of MINT_AUDIT_KEYS) if (raw[k] !== undefined) out[k] = raw[k];
        log.info("preview html-cap", out);
      }
    }
  }

  const routes: PreviewRoutes = {
    mode,
    handle,
    handleProbe,
    ...(pv === undefined
      ? {}
      : {
          handleHtmlCap,
          servePv: (req: IncomingMessage, res: ServerResponse, rest: string, io: PvIo) =>
            pv.servePv(req, res, rest, io),
          serveWrapper: (req: IncomingMessage, res: ServerResponse, rest: string, io: PvIo) =>
            pv.serveWrapper(req, res, rest, io),
          revokeHtmlCaps: (sel: Parameters<PvRoutes["revoke"]>[0], reason: Parameters<PvRoutes["revoke"]>[1]) =>
            pv.revoke(sel, reason),
        }),
    dispose(reason: "close" | "startup-failure", deadline: ReqDeadline): Promise<void> {
      if (disposePromise !== undefined) return disposePromise; // 幂等，两路径共用同一个 promise
      closing = true;
      const waitMs = Math.max(0, Math.min(PREVIEW_DISPOSE_WAIT_MS, deadline.remaining()));
      disposePromise = (async (): Promise<void> => {
        verifier.dispose(); // aborts every single-flight task (§4.5.3)
        // HTML preview: synchronous revoke-all (leases aborted, waiters cancelled), then the
        // bounded wait for in-flight /pv requests runs concurrently with the mint wait below.
        const pvDone = pv?.dispose(waitMs);
        for (const e of [...active]) e.ctl.abort("hub-close");
        if (active.size > 0) {
          await Promise.race([Promise.allSettled([...active].map((e) => e.done)), unrefDelay(waitMs)]);
        }
        if (pvDone !== undefined) await pvDone;
      })();
      disposePromise.catch(() => undefined);
      return disposePromise;
    },
  };
  return routes;
}
