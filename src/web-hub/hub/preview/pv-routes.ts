/**
 * web-hub HTML preview — the `/pv/<cap>/<rel>` + `/pvw/<cap>` serve routes (web-hub-html-preview
 * plan v2 §2.3/§2.6/§3, P1b). Composition root of the P1a pure layer: the capability store
 * (`html-cap.ts`), the 2-slot physical IO gate (`pv-io.ts`), the fd-anchored admission
 * (`pv-admit.ts`) and the raw-body stream kernel (`stream.ts`'s `pv` mode).
 *
 * Invariants this file owns:
 *
 * - **I1** — nothing here reads `Cookie`, calls an auth port or sets a cookie: `PvIo` carries no
 *   `authorize`, the capability is the only credential.
 * - **Lease for the whole request** — a request takes `store.lease(rec)` when it is dequeued and
 *   holds it across admission AND stream, so `endCap`/`revoke` can neither close the held dir fd
 *   mid-request (the store closes it once refs drain) nor leave the request unaware (the lease's
 *   signal aborts it).
 * - **Bounded FIFO queue** — `PV_ACTIVE_PER_CAP`/`PV_ACTIVE_GLOBAL` requests do FS/stream work,
 *   the rest wait holding ONLY their socket (no fd, no lease); overflow / wait timeout ⇒ 503
 *   `Retry-After: 1`; cap end ⇒ the waiter is cancelled (⇒ constant 404).
 * - **Liveness before head** — `beforeHead()` re-checks the cap synchronously right before
 *   `writeHead`; revoke mid-stream aborts the lease signal ⇒ `res.destroy()`.
 * - **Redaction** — this module logs only `capTag`/codes/ext; never the cap, `rel`, a path or a
 *   query string.
 *
 * `/pvw` is the script-free new-tab wrapper (§3.2): a fixed template around the same sandboxed
 * iframe, zero `<script>`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { PREVIEW_TEXT_MAX_BYTES } from "../../protocol/preview.js";
import {
  PV_ACTIVE_GLOBAL,
  PV_ACTIVE_PER_CAP,
  PV_ADMIT_TOTAL_MS,
  PV_BUCKET_CAPACITY,
  PV_BUCKET_REFILL_MS,
  PV_CAP_TOTAL_MAX_BYTES,
  PV_IDLE_TTL_MS,
  PV_LIFETIME_MAX_REQS,
  PV_MINT_MAX_BODY_BYTES,
  PV_PREFIX,
  PV_QUEUE_GLOBAL,
  PV_QUEUE_PER_CAP,
  PV_QUEUE_WAIT_MS,
  PV_SANDBOX,
  PV_STREAM_MS,
} from "../../protocol/preview-html.js";
import { createCmdLimit, type CmdLimit } from "../cmd-limit.js";
import type { HubLog, PvIo, PvRevokeReason, PvRevokeSelector } from "../ports.js";
import type { PreviewDenyContext, PreviewFs } from "./admit.js";
import { admitPvFile, type PvAdmitDeps, type PvFail } from "./pv-admit.js";
import {
  createHtmlCapStore,
  type HtmlCap,
  type HtmlCapStore,
  type HtmlCapStoreDeps,
  type PvLease,
} from "./html-cap.js";
import { createPvIoGate, type PvIoGate } from "./pv-io.js";
import { pvContentType, pvExtOf } from "./pv-mime.js";
import { errCode, parsePvRelPath, parsePvwRest, splitPvRest } from "./pv-path.js";
import { readAndStream, type PreviewSink } from "./stream.js";
import type { UploadVerifier } from "./verify.js";

// ---------------------------------------------------------------------------
// §3 response headers
// ---------------------------------------------------------------------------

const PV_PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=(), clipboard-read=(), publickey-credentials-get=()";

const PLAIN = "text/plain; charset=utf-8";

/** §3.1 `Content-Security-Policy` (entry document additionally pins `frame-ancestors`). */
export function pvCsp(frameAncestors?: string): string {
  const base = `sandbox ${PV_SANDBOX}; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; object-src 'none'`;
  return frameAncestors === undefined ? base : `${base}; frame-ancestors ${frameAncestors}`;
}

/** §3.2 wrapper CSP (exact). */
export const PVW_CSP =
  "default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function pvHeaders(req: IncomingMessage, contentType: string, frameAncestors?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Security-Policy": pvCsp(frameAncestors),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cache-Control": "no-store",
    "Permissions-Policy": PV_PERMISSIONS_POLICY,
    "Content-Type": contentType,
    Vary: "Origin",
  };
  // an opaque-origin (sandboxed) subresource request carries `Origin: null` — echo exactly that
  // and nothing else; never `*`, never credentials.
  if (req.headers.origin === "null") h["Access-Control-Allow-Origin"] = "null";
  return h;
}

const STATUS_BODY: Readonly<Record<number, string>> = {
  400: "bad request",
  403: "forbidden",
  404: "not found",
  409: "changed",
  413: "too large",
  415: "unsupported",
  429: "too many requests",
  500: "error",
  503: "busy",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// request body (mint) — bounded read + shape
// ---------------------------------------------------------------------------

const MINT_BODY_READ_MS = 4_000;

export type HtmlCapBodyRead =
  { ok: true; path: string } | { ok: false; status: number; code: "E_BAD_REQUEST"; reason: "json" | "shape" | "body" };

/** §2.1-③: body ≤ `PV_MINT_MAX_BODY_BYTES`, JSON `{ "path": string }`. Settle-once, unref'd timer. */
export function readHtmlCapBody(req: IncomingMessage): Promise<HtmlCapBodyRead> {
  return new Promise<HtmlCapBodyRead>((resolve) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > PV_MINT_MAX_BODY_BYTES) {
      resolve({ ok: false, status: 413, code: "E_BAD_REQUEST", reason: "body" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (err: { status: number; reason: "body" | "json" } | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", onData);
      if (err !== undefined) {
        resolve({ ok: false, status: err.status, code: "E_BAD_REQUEST", reason: err.reason });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        resolve({ ok: false, status: 400, code: "E_BAD_REQUEST", reason: "json" });
        return;
      }
      const p =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as { path?: unknown }).path
          : undefined;
      if (typeof p !== "string") {
        resolve({ ok: false, status: 400, code: "E_BAD_REQUEST", reason: "shape" });
        return;
      }
      resolve({ ok: true, path: p });
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > PV_MINT_MAX_BODY_BYTES) finish({ status: 413, reason: "body" });
      else chunks.push(chunk);
    };
    const timer = setTimeout(() => finish({ status: 400, reason: "body" }), MINT_BODY_READ_MS);
    timer.unref?.();
    req.on("data", onData);
    req.once("end", () => finish(undefined));
    req.once("error", () => finish({ status: 400, reason: "body" }));
    req.once("aborted", () => finish({ status: 400, reason: "body" }));
  });
}

// ---------------------------------------------------------------------------
// composition
// ---------------------------------------------------------------------------

/** Seams of the HTML preview wiring (production passes none of them except via `hub.ts`'s
 * defaults; tests inject scripted fs / a fake gate / tiny limits). */
export interface PreviewHtmlDeps {
  /** fs surface of the PV flow (dir pin + serve admission) — defaults to the real adapter. */
  fs?: Partial<PreviewFs> | undefined;
  /** the PV physical IO gate — defaults to `createPvIoGate({ now })`. */
  gate?: PvIoGate | undefined;
  /** the real uploads roots for D2's refused-root check — defaults to `[uploadsRoot]` (literal +
   * canonical forms are both enforced by `routes.ts`). */
  uploadsRoots?: readonly string[] | undefined;
  /** test overrides of the frozen store limits. */
  limits?: HtmlCapStoreDeps["limits"];
  randomBytes?: HtmlCapStoreDeps["randomBytes"];
}

export interface PvRoutesDeps {
  log: HubLog;
  now(): number;
  denyCtx: PreviewDenyContext;
  html: PreviewHtmlDeps;
  /** `routes.ts`'s `resSink` (shared; avoids a circular value import). */
  makeSink(res: ServerResponse): PreviewSink;
  verifier: UploadVerifier;
}

export interface PvRoutes {
  readonly store: HtmlCapStore;
  readonly gate: PvIoGate;
  /** deps the mint's `pinPvDir` shares with serve admission. */
  readonly admitDeps: PvAdmitDeps;
  /** the PV store's own limits (mint reports `idleMs` from here). */
  readonly idleMs: number;
  servePv(req: IncomingMessage, res: ServerResponse, rest: string, io: PvIo): Promise<void>;
  serveWrapper(req: IncomingMessage, res: ServerResponse, rest: string, io: PvIo): Promise<void>;
  revoke(sel: PvRevokeSelector, reason: PvRevokeReason): void;
  isClosing(): boolean;
  /** Synchronously starts teardown (store dispose ⇒ every lease aborted, every waiter
   * cancelled, dir fds closed as refs drain), then waits ≤ `waitMs` for in-flight requests. */
  dispose(waitMs: number): Promise<void>;
}

type Acquire =
  | { readonly kind: "lease"; readonly lease: PvLease }
  | { readonly kind: "gone" }
  | { readonly kind: "busy" }
  | { readonly kind: "aborted" };

interface Queued {
  readonly rec: HtmlCap;
  readonly waiter: { cancel(reason: string): void };
  settle(r: Acquire): void;
}

interface ActiveServe {
  done: Promise<void>;
}

export function createPvRoutes(deps: PvRoutesDeps): PvRoutes {
  const { log, now } = deps;
  const gate: PvIoGate = deps.html.gate ?? createPvIoGate({ now });
  const limit: CmdLimit = createCmdLimit(now);
  const store = createHtmlCapStore({
    now,
    closeDir: (fh) => gate.close(() => fh.close()),
    onEnd: (s) => {
      log.info("preview html cap end", {
        audit: "preview",
        ev: "pv-end",
        capTag: s.capTag,
        reqs: s.reqs,
        bytes: s.bytes,
        denied: s.denied,
        codes: s.codes,
        end: s.end,
      });
    },
    ...(deps.html.limits === undefined ? {} : { limits: deps.html.limits }),
    ...(deps.html.randomBytes === undefined ? {} : { randomBytes: deps.html.randomBytes }),
  });
  const admitDeps: PvAdmitDeps = {
    denyCtx: deps.denyCtx,
    gate,
    ...(deps.html.fs === undefined ? {} : { fs: deps.html.fs }),
    now,
  };
  const active = new Set<ActiveServe>();
  const waiting: Queued[] = [];
  let closing = false;

  // ---- plain answers --------------------------------------------------------

  const plain = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    extra?: Record<string, string>,
    wrapper = false,
  ): void => {
    if (res.headersSent || res.destroyed) return;
    const body = STATUS_BODY[status] ?? "error";
    const headers = wrapper ? wrapperHeaders(PLAIN) : pvHeaders(req, PLAIN);
    if (!wrapper) res.removeHeader("X-Frame-Options");
    res.writeHead(status, {
      ...headers,
      "Content-Length": String(Buffer.byteLength(body)),
      ...(status === 503 || status === 429 ? { "Retry-After": "1" } : {}),
      ...extra,
    });
    res.end(body);
  };

  // ---- the bounded FIFO queue ----------------------------------------------

  const canStart = (rec: HtmlCap): boolean =>
    rec.active.size < PV_ACTIVE_PER_CAP && store.totals().active < PV_ACTIVE_GLOBAL;

  const dropQueued = (q: Queued): void => {
    const i = waiting.indexOf(q);
    if (i !== -1) waiting.splice(i, 1);
  };

  const pump = (): void => {
    for (let i = 0; i < waiting.length;) {
      if (store.totals().active >= PV_ACTIVE_GLOBAL) return;
      const q = waiting[i] as Queued;
      if (q.rec.active.size >= PV_ACTIVE_PER_CAP) {
        i += 1;
        continue;
      }
      waiting.splice(i, 1);
      const lease = store.lease(q.rec);
      q.settle(lease === undefined ? { kind: "gone" } : { kind: "lease", lease });
    }
  };

  const acquire = (rec: HtmlCap, clientSignal: AbortSignal): Promise<Acquire> => {
    if (clientSignal.aborted) return Promise.resolve({ kind: "aborted" });
    if (canStart(rec) && !waiting.some((q) => q.rec === rec)) {
      const lease = store.lease(rec);
      return Promise.resolve(lease === undefined ? { kind: "gone" } : { kind: "lease", lease });
    }
    if (rec.queue.length >= PV_QUEUE_PER_CAP || waiting.length >= PV_QUEUE_GLOBAL) {
      return Promise.resolve({ kind: "busy" });
    }
    return new Promise<Acquire>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      const q: Queued = {
        rec,
        waiter: {
          // the store cancels us when the cap ends (it already spliced `rec.queue`)
          cancel: () => q.settle({ kind: "gone" }),
        },
        settle: (r) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          if (onAbort !== undefined) clientSignal.removeEventListener("abort", onAbort);
          dropQueued(q);
          store.removeWaiter(rec, q.waiter);
          resolve(r);
        },
      };
      if (!store.addWaiter(rec, q.waiter)) {
        resolve({ kind: "gone" });
        return;
      }
      waiting.push(q);
      timer = setTimeout(() => q.settle({ kind: "busy" }), PV_QUEUE_WAIT_MS);
      timer.unref();
      onAbort = () => q.settle({ kind: "aborted" });
      clientSignal.addEventListener("abort", onAbort, { once: true });
      pump();
    });
  };

  // ---- serve ----------------------------------------------------------------

  const auditDeny = (rec: HtmlCap, rel: string | undefined, reason: string): void => {
    if (!store.noteDenied(rec, reason)) return;
    log.info("preview html deny", {
      audit: "preview",
      ev: "pv-deny",
      capTag: rec.capTag,
      ...(rel === undefined ? {} : { ext: pvExtOf(rel) }),
      reason,
    });
  };

  async function serveOne(req: IncomingMessage, res: ServerResponse, rawRest: string, io: PvIo): Promise<void> {
    const ctl = new AbortController();
    res.once("close", () => {
      if (!res.writableFinished) ctl.abort("client-abort");
    });
    // ⓪ closing
    if (closing) return plain(req, res, 503);
    // non-GET ⇒ constant 404; the query string never reaches the parser (and is never logged)
    if ((req.method ?? "GET").toUpperCase() !== "GET") return plain(req, res, 404);
    const cut = rawRest.search(/[?#]/);
    const rest = cut === -1 ? rawRest : rawRest.slice(0, cut);

    // ① cap grammar + live, listener+origin-bound lookup — one constant 404 (no oracle)
    const sp = splitPvRest(rest);
    if (sp === undefined) return plain(req, res, 404);
    const rec = store.lookup(sp.cap, io.listener, io.origin);
    if (rec === undefined) return plain(req, res, 404);

    // ② rel parse
    const parsed = parsePvRelPath(sp.rawRel);
    if (!parsed.ok) {
      auditDeny(rec, undefined, `path-${parsed.reason}`);
      return plain(req, res, 400);
    }
    const rel = parsed.rel;

    // ③ budgets: per-cap bucket + lifetime request count
    const admitted = limit.admit(`pv:${rec.capTag}`, PV_BUCKET_CAPACITY, PV_BUCKET_REFILL_MS);
    if (!admitted.ok) return plain(req, res, 429);
    if (rec.reqs >= PV_LIFETIME_MAX_REQS) return plain(req, res, 429);
    store.noteRequest(rec);

    // ④ bounded queue → lease (held for the whole admission + stream)
    const got = await acquire(rec, ctl.signal);
    if (got.kind === "aborted") return;
    if (got.kind === "busy") return plain(req, res, 503);
    if (got.kind === "gone") return plain(req, res, closing ? 503 : 404);
    const lease = got.lease;
    try {
      const signal = AbortSignal.any([lease.signal, ctl.signal]);
      // a revoke may land between the lease grant and here: nothing was opened yet
      if (signal.aborted || !store.isLive(rec)) return plain(req, res, 404);

      // ⑤ fd-anchored admission
      const adm = await admitPvFile(admitDeps, {
        dirFd: rec.dirFh.fd,
        dirPath: rec.dirPath,
        rel,
        signal,
        deadlineAt: now() + PV_ADMIT_TOTAL_MS,
      });
      if (!adm.ok) return answerFail(req, res, rec, rel, adm, ctl.signal);

      // ⑥ per-cap total
      if (rec.bytes + adm.size > PV_CAP_TOTAL_MAX_BYTES) {
        await gate.close(() => adm.fh.close());
        auditDeny(rec, rel, "cap-total");
        return plain(req, res, 413);
      }

      // ⑦ stream (readAndStream owns `adm.fh` from here: closed on success/failure/abort)
      const isEntry = rel === rec.entry;
      const headers = pvHeaders(req, pvContentType(rel), isEntry ? rec.origin : undefined);
      res.removeHeader("X-Frame-Options");
      const outcome = await readAndStream(
        {
          fh: adm.fh,
          size: adm.size,
          sniff: { kind: "binary" },
          sample: Buffer.alloc(0), // the pv path consumes `sample` — always empty here
          pv: { headers, beforeHead: () => store.isLive(rec) && !signal.aborted, io: gate },
        },
        deps.makeSink(res),
        {
          signal,
          streamAt: PV_STREAM_MS[io.listener],
          textMax: PREVIEW_TEXT_MAX_BYTES,
          now,
          verifier: deps.verifier,
        },
      );
      if (outcome.ok) {
        store.noteBytes(rec, outcome.bytes);
        return;
      }
      if (outcome.headersSent) return; // already destroyed by the stream layer
      switch (outcome.reason) {
        case "not-live":
          return plain(req, res, 404);
        case "client-abort":
        case "hub-close":
          // a revoke/expiry (lease aborted) while the client is still there ⇒ constant 404
          if (!ctl.signal.aborted && lease.signal.aborted) return plain(req, res, closing ? 503 : 404);
          return;
        case "stream-deadline":
        case "io":
          return plain(req, res, 503);
        default:
          return plain(req, res, 409);
      }
    } finally {
      lease.release();
      pump();
    }
  }

  function answerFail(
    req: IncomingMessage,
    res: ServerResponse,
    rec: HtmlCap,
    rel: string,
    f: PvFail,
    clientSignal: AbortSignal,
  ): void {
    if (f.revokeCap === true) {
      // the bound directory is gone: end exactly this cap, constant 404
      store.endCap(rec);
      return plain(req, res, 404);
    }
    if (f.status === 0) {
      // abort: client gone ⇒ silence; revoked/closing ⇒ constant answer
      if (clientSignal.aborted) return;
      return plain(req, res, closing ? 503 : 404);
    }
    if (f.status >= 400 && f.status < 500 && f.status !== 404) auditDeny(rec, rel, f.reason ?? f.code);
    const status = STATUS_BODY[f.status] === undefined ? 503 : f.status;
    return plain(req, res, status);
  }

  async function servePv(req: IncomingMessage, res: ServerResponse, rest: string, io: PvIo): Promise<void> {
    const act: ActiveServe = { done: Promise.resolve() };
    active.add(act);
    act.done = serveOne(req, res, rest, io).catch((err: unknown) => {
      // code only — an fs error MESSAGE carries paths, and the url carries the cap
      log.error("preview pv: unexpected failure", { code: errCode(err) });
      if (!res.headersSent && !res.destroyed) plain(req, res, 500);
      else res.destroy();
    });
    try {
      await act.done;
    } finally {
      active.delete(act);
    }
  }

  // ---- /pvw wrapper ---------------------------------------------------------

  function wrapperHeaders(contentType: string): Record<string, string> {
    return {
      "Content-Security-Policy": PVW_CSP,
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Content-Type": contentType,
    };
  }

  function wrapperPage(rec: HtmlCap): string {
    const src = `${PV_PREFIX}${rec.cap}/${encodeURIComponent(rec.entry)}`;
    return (
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="referrer" content="no-referrer">` +
      `<title>${escapeHtml(rec.entry)}</title>` +
      `<style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style>` +
      `</head><body>` +
      `<iframe sandbox="${PV_SANDBOX}" referrerpolicy="no-referrer" credentialless allow="" src="${escapeHtml(src)}"></iframe>` +
      `</body></html>`
    );
  }

  async function serveWrapper(req: IncomingMessage, res: ServerResponse, rawRest: string, io: PvIo): Promise<void> {
    try {
      if (closing) return plain(req, res, 503, undefined, true);
      if ((req.method ?? "GET").toUpperCase() !== "GET") return plain(req, res, 404, undefined, true);
      const cut = rawRest.search(/[?#]/);
      const cap = parsePvwRest(cut === -1 ? rawRest : rawRest.slice(0, cut));
      if (cap === undefined) return plain(req, res, 404, undefined, true);
      const rec = store.lookup(cap, io.listener, io.origin);
      if (rec === undefined) return plain(req, res, 404, undefined, true);
      const admitted = limit.admit(`pv:${rec.capTag}`, PV_BUCKET_CAPACITY, PV_BUCKET_REFILL_MS);
      if (!admitted.ok || rec.reqs >= PV_LIFETIME_MAX_REQS) return plain(req, res, 429, undefined, true);
      store.noteRequest(rec);
      const body = wrapperPage(rec);
      res.writeHead(200, {
        ...wrapperHeaders("text/html; charset=utf-8"),
        "Content-Length": String(Buffer.byteLength(body)),
      });
      res.end(body);
    } catch (err) {
      log.error("preview pvw: unexpected failure", { code: errCode(err) });
      if (!res.headersSent && !res.destroyed) plain(req, res, 500, undefined, true);
      else res.destroy();
    }
  }

  // ---- lifecycle ------------------------------------------------------------

  async function dispose(waitMs: number): Promise<void> {
    closing = true;
    // synchronous part: every lease aborted, every queued waiter cancelled, dir fds close as
    // refs drain (the closes ride the gate's priority lane, which dispose() leaves working)
    store.dispose();
    const pending = [...active].map((a) => a.done);
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, Math.max(0, waitMs));
          t.unref();
        }),
      ]);
    }
    gate.dispose();
  }

  return {
    store,
    gate,
    admitDeps,
    idleMs: deps.html.limits?.idleMs ?? PV_IDLE_TTL_MS,
    servePv,
    serveWrapper,
    revoke: (sel, reason) => store.revoke(sel, reason),
    isClosing: () => closing,
    dispose,
  };
}
