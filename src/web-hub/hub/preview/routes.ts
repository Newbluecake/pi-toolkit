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
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_IMAGE_MAX_PIXELS,
  PREVIEW_JPEG_SCAN_MAX_BYTES,
  PREVIEW_SAMPLE_BYTES,
  PREVIEW_STREAM_MS,
  PREVIEW_TEXT_MAX_BYTES,
  validatePreviewPath,
  type PreviewProbeResponseBody,
} from "../../protocol/preview.js";
import { auditPreview } from "../audit.js";
import { createCmdLimit, type CmdLimit } from "../cmd-limit.js";
import type { HubLog, PreviewRouteIo, PreviewRoutes, RegistryView } from "../ports.js";
import { createReqDeadline, type ReqDeadline } from "../req-deadline.js";
import type { UploadStore } from "../uploads.js";
import { createFsAdmitter, type FsAdmitter, type PreviewDenyContext, type PreviewHandle } from "./admit.js";
import { createPreviewIoTracker, previewFsStep } from "./fs.js";
import { openAdmittedPath, type Opened } from "./open.js";
import { readProbeBody, runPreviewProbe } from "./probe.js";
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
}

/** §1.3 typed probe sender — `io.sendJson`'s `body: unknown` cannot catch a hub↔UI drift, this
 * thin wrapper routes the answer through `PreviewProbeResponseBody` so typecheck can. */
function sendProbeResults(io: PreviewRouteIo, res: ServerResponse, body: PreviewProbeResponseBody): void {
  io.sendJson(res, 200, body);
}

export function createPreviewRoutes(deps: PreviewRoutesDeps): PreviewRoutes {
  const { mode, uploadsRoot, registry, uploads, log, now } = deps;
  const limit: CmdLimit = deps.limit ?? createCmdLimit(now);
  /** §2.4 instance ownership: ONE tracker per `createPreviewRoutes` instance, handed to the
   * default admitter, both `readSample` loops and probe's `readHead` (dir.ts joins in P1b).
   * Closure-local (never module scope) ⇒ a `/reload`-built sibling starts from 0 zombies. */
  const tracker = createPreviewIoTracker();
  const admitter: FsAdmitter = deps.admitter ?? createFsAdmitter({ denyCtx: deps.denyCtx, tracker, log, now });
  const verifier: UploadVerifier = deps.verifier ?? createUploadVerifier({ log, now });

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
    kind?: "text" | "image" | undefined;
    ok: boolean;
    code?: string | undefined;
    reason?: string | undefined;
    verify?: "hashed" | "cached" | "joined" | undefined;
    shared?: boolean | undefined;
    bytes?: number | undefined;
    total?: number | undefined;
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
      const path = query.get("path") ?? "";
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
        { agentKey, sessionId, path, listener: io.listener, principal },
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

      // ⑧ sniff (§3.1 ⑧ — the two reads stay inside the shared admission deadline)
      const sample = await readSample(opened.fh, opened.size, r, signal);
      if (signal.aborted) {
        abortAnswer();
        return;
      }
      const sniffed = sniff(sample, opened.size);
      acc.kind = sniffed.kind === "image" ? "image" : sniffed.kind === "text" ? "text" : undefined;
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

      // ⑨ write-out (§4.5.2) — from here on readAndStream owns the handle.
      streamed = true;
      const rawAcceptEncoding = req.headers["accept-encoding"];
      const acceptEncoding = Array.isArray(rawAcceptEncoding) ? rawAcceptEncoding[0] : rawAcceptEncoding;
      const outcome: StreamOutcome = await readAndStream(
        {
          fh: opened.fh,
          size: opened.size,
          sniff: sniffed,
          sample,
          ...(opened.verify === undefined ? {} : { verify: opened.verify }),
        },
        resSink(res),
        {
          signal,
          streamAt: PREVIEW_STREAM_MS[io.listener],
          textMax: PREVIEW_TEXT_MAX_BYTES,
          now,
          verifier,
          ...(acceptEncoding === undefined ? {} : { acceptEncoding }),
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
      // ⑩ 收尾: close any handle readAndStream never took ownership of, release the in-flight
      // slot, leave the active set, write the single audit line.
      if (opened !== undefined && !streamed) await opened.fh.close().catch(() => undefined);
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

      const run = await runPreviewProbe(
        { uploadsRoot, registry, uploads, admitter, log, now, tracker },
        { agentKey, sessionId, paths: body.body.paths, listener: io.listener, principal },
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

  const routes: PreviewRoutes = {
    mode,
    handle,
    handleProbe,
    dispose(reason: "close" | "startup-failure", deadline: ReqDeadline): Promise<void> {
      if (disposePromise !== undefined) return disposePromise; // 幂等，两路径共用同一个 promise
      closing = true;
      const waitMs = Math.max(0, Math.min(PREVIEW_DISPOSE_WAIT_MS, deadline.remaining()));
      disposePromise = (async (): Promise<void> => {
        verifier.dispose(); // aborts every single-flight task (§4.5.3)
        for (const e of [...active]) e.ctl.abort("hub-close");
        if (active.size > 0) {
          await Promise.race([Promise.allSettled([...active].map((e) => e.done)), unrefDelay(waitMs)]);
        }
      })();
      disposePromise.catch(() => undefined);
      return disposePromise;
    },
  };
  return routes;
}
