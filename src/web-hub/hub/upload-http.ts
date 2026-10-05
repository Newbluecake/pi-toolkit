/**
 * web-hub `/api/upload/*` HTTP routes (plan `docs/dev/web-hub-upload/plan.md` §1.2/§5.1/§5.2,
 * package U3): `begin`/`chunk`/`commit`/`abort` for both listeners, sharing one pipeline that
 * mirrors `http.ts`'s `dispatchCmdOrDialog` write-endpoint steps (§5.1.1): strict CSRF →
 * `authorize()` → per-principal upload token bucket → (begin only) hub in-flight cap → body
 * budget → parse → capability gate (begin) → **second `authorize()`** → `UploadStore` call with
 * the request's `ReqDeadline` threaded through as the store deadline (#7).
 *
 * Wiring notes / plan-author-approved deviations:
 * - `opts.csrfOk(kind)` is a closure supplied by `http.ts` (`"json"` ⇒ `strictCsrfOk`, `"chunk"`
 *   ⇒ `uploadCsrfOk`), so this module never imports `http.ts` (which imports this module). This
 *   replaces the plan's `expectedOrigin` opt — the origin is folded into the closure.
 * - §5.1.2's "commit 再验 agent 仍在" needs an `agentKey`, but §1.2 freezes the commit body as
 *   `{ id }`. The authoritative binding is the store's own begin-time record
 *   (`UploadStore.agentKeyOf`, U3 review P1-1 fix — an earlier per-frontend FIFO map could lose a
 *   live upload's binding under churn and fail OPEN; the store record cannot). The check stays
 *   hub-side and principal-namespaced; a missing binding means the upload is poisoned/committed/
 *   unknown — commit then 404s or replays idempotently, no recheck needed.
 * - Reject-phase audit lines (CSRF/auth/429/501/caps/deadline — failures the store never sees)
 *   are written here through `auditUpload` and counted into `opts.metrics` (the §5.4 stats row
 *   merges them); the store audits/counts everything it sees itself. A chunk success has no
 *   audit line anywhere (§5.4).
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  UPLOAD_ABORT_PATH,
  UPLOAD_BEGIN_PATH,
  UPLOAD_CHUNK_BODY_MS,
  UPLOAD_CHUNK_BYTES_LAN,
  UPLOAD_CHUNK_BYTES_LOOPBACK,
  UPLOAD_CHUNK_PATH,
  UPLOAD_COMMIT_PATH,
  UPLOAD_INFLIGHT_HUB,
  UPLOAD_RATE_LIMIT_CAPACITY,
  UPLOAD_RATE_LIMIT_REFILL_MS,
  UPLOAD_TOTAL_MS,
} from "../protocol/upload.js";
import { auditUpload, type UploadHttpMetrics } from "./audit.js";
import type { CmdLimit } from "./cmd-limit.js";
import type { HubLog, RegistryView } from "./ports.js";
import {
  BODY_CAP_MS,
  BODY_RESERVE_MS,
  createReqDeadline,
  deriveBudget,
  WRITE_TOTAL_MS,
  type ReqDeadline,
} from "./req-deadline.js";
import { UploadStoreError, type UploadStore } from "./uploads.js";

/** Mirrors `http.ts`'s `MAX_BODY_BYTES` (JSON control bodies); chunk bodies are capped by the
 * per-listener `chunkBytes` instead. Duplicated rather than imported to keep this module
 * `http.ts`-free (http.ts imports this module). */
const JSON_MAX_BYTES = 64 * 1024;
/** Same shape as `http.ts`'s `CMD_ID_RE` — the store re-validates, this is the early 400. */
const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{8,64}$/; // min 8 since 2026-10-05 (UI emits 8-char ids; 22-char legacy ids stay valid)
/** 429-audit throttle window (same semantics as `dispatchCmdOrDialog`'s RATE_AUDIT_WINDOW_MS). */
const RATE_AUDIT_WINDOW_MS = 60_000;

export interface UploadIo {
  readBody(req: IncomingMessage, maxBytes?: number, maxMs?: number): Promise<Buffer>;
  sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void;
}

export type UploadAuthOutcome = { ip: string; user?: string } | { handled: true; code: string };

export interface UploadRouteOpts {
  listener: "loopback" | "lan";
  /** Known synchronously before `authorize()` runs (same role as in `dispatchCmdOrDialog`). */
  ip: string;
  /** `"json"` ⇒ strict write-endpoint CSRF for `application/json`; `"chunk"` ⇒ the same checks
   * against `application/octet-stream` (plan §5.2's `uploadCsrfOk`, owned by `http.ts`). */
  csrfOk(kind: "json" | "chunk"): boolean;
  /** Same contract as `dispatchCmdOrDialog`'s: on failure it sends its own response and returns
   * `{ handled: true, code }`. Called twice (before and after the body read) — the caller's
   * closure is responsible for deriving a per-call budget from the passed deadline. */
  authorize(deadline: ReqDeadline): Promise<UploadAuthOutcome>;
  registry: RegistryView;
  /** `undefined` ⇒ 501 `E_NOT_IMPLEMENTED` (deps.uploads not wired / store construction failed). */
  store: UploadStore | undefined;
  /** §5.4 (U3 P2-2): shared HTTP-layer reject counters, merged into the periodic `upload stats`
   * row by `uploadStatsFields`. Optional so route-only tests can omit it. */
  metrics?: UploadHttpMetrics | undefined;
  limit: CmdLimit;
  /** Shared 429-audit throttle map (same instance `dispatchCmdOrDialog` uses). */
  rejectAudit429: Map<string, number>;
  log: HubLog;
  now: () => number;
  io: UploadIo;
}

type UploadOp = "begin" | "chunk" | "commit" | "abort";

interface ReqCtx {
  op: UploadOp;
  reqId: string;
  reqDeadline: ReqDeadline;
  principal: string;
  ip: string;
  user?: string | undefined;
  store: UploadStore;
}

function opOf(path: string): UploadOp | undefined {
  switch (path) {
    case UPLOAD_BEGIN_PATH:
      return "begin";
    case UPLOAD_CHUNK_PATH:
      return "chunk";
    case UPLOAD_COMMIT_PATH:
      return "commit";
    case UPLOAD_ABORT_PATH:
      return "abort";
    default:
      return undefined;
  }
}

function field(body: unknown, name: string): unknown {
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined;
}

function stringField(body: unknown, name: string): string | undefined {
  const v = field(body, name);
  return typeof v === "string" && v.length > 0 && v.length <= 256 ? v : undefined;
}

/** 413/408 replies also close the connection (the unread rest of an oversized/lying body must
 * never be parsed as the next request on a keep-alive socket) — same behavior `http.ts`'s
 * `HttpError` catchers give the other endpoints. */
function sendConnClosing(
  opts: UploadRouteOpts,
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  code: string,
  message?: string,
): void {
  res.setHeader("Connection", "close");
  res.once("finish", () => req.destroy());
  opts.io.sendJson(res, status, message === undefined ? { error: code } : { error: code, message });
}

/** Maps a store failure onto the wire 1:1 (`UploadStoreError.status`/`code`/`extra`); anything
 * else collapses to 500 `E_INTERNAL` with details only in the log (same policy as http.ts). */
function replyStoreError(
  opts: UploadRouteOpts,
  res: ServerResponse,
  err: unknown,
  ctx: Pick<ReqCtx, "op" | "reqId">,
): void {
  if (err instanceof UploadStoreError) {
    const headers: Record<string, string> = {};
    if (typeof err.extra.retryAfterS === "number") headers["Retry-After"] = String(err.extra.retryAfterS);
    opts.io.sendJson(
      res,
      err.status,
      {
        error: err.code,
        ...(typeof err.extra.received === "number" ? { received: err.extra.received } : {}),
        ...(typeof err.extra.retryAfterS === "number" ? { retryAfterS: err.extra.retryAfterS } : {}),
        ...(typeof err.extra.reason === "string" ? { reason: err.extra.reason } : {}),
        ...(typeof err.extra.earliestExpiryAt === "number" ? { earliestExpiryAt: err.extra.earliestExpiryAt } : {}),
      },
      headers,
    );
    return;
  }
  opts.log.error("web-hub upload http: unclassified store error (details suppressed from client)", {
    op: ctx.op,
    reqId: ctx.reqId,
    error: String(err),
  });
  opts.io.sendJson(res, 500, { error: "E_INTERNAL" });
}

interface JsonOutcome {
  replied: boolean;
  body?: unknown;
}

/** JSON control body read under the write-endpoint body budget; on failure sends the reply
 * (413/408 with connection close) and returns `{ replied: true }`. */
async function readJsonBody(
  opts: UploadRouteOpts,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ReqCtx,
): Promise<JsonOutcome> {
  const bodyMs = deriveBudget(ctx.reqDeadline.remaining(), BODY_CAP_MS, BODY_RESERVE_MS);
  if (bodyMs <= 0) {
    audit(opts, ctx, { code: "E_DEADLINE" });
    sendConnClosing(opts, req, res, 408, "E_DEADLINE", "no budget left to read the request body");
    return { replied: true };
  }
  let buf: Buffer;
  try {
    buf = await opts.io.readBody(req, JSON_MAX_BYTES, bodyMs);
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    if (status === 413) {
      audit(opts, ctx, { code: "E_BAD_REQUEST" });
      sendConnClosing(opts, req, res, 413, "E_BAD_REQUEST", "body too large");
    } else if (status === 408) {
      audit(opts, ctx, { code: "E_DEADLINE" });
      sendConnClosing(opts, req, res, 408, "E_DEADLINE", "body read timeout");
    } else {
      audit(opts, ctx, { code: "E_BAD_REQUEST" });
      opts.io.sendJson(res, 400, { error: "E_BAD_REQUEST", message: "request error" });
    }
    return { replied: true };
  }
  if (buf.length === 0) return { replied: false, body: undefined };
  try {
    return { replied: false, body: JSON.parse(buf.toString("utf8")) as unknown };
  } catch {
    audit(opts, ctx, { code: "E_BAD_REQUEST" });
    opts.io.sendJson(res, 400, { error: "E_BAD_REQUEST", message: "invalid JSON" });
    return { replied: true };
  }
}

function audit(
  opts: UploadRouteOpts,
  ctx: Pick<ReqCtx, "op" | "reqId" | "ip"> & { user?: string | undefined },
  fields: { code: string; agentKey?: string; uploadId?: string; retryAfterS?: number },
): void {
  opts.metrics?.reject(fields.code, fields.retryAfterS);
  auditUpload(opts.log, {
    phase: "reject",
    op: ctx.op,
    ok: false,
    reqId: ctx.reqId,
    listener: opts.listener,
    ip: ctx.ip,
    ...(ctx.user === undefined ? {} : { user: ctx.user }),
    ...(fields.agentKey === undefined ? {} : { agentKey: fields.agentKey }),
    ...(fields.uploadId === undefined ? {} : { uploadId: fields.uploadId }),
    code: fields.code,
  });
}

/** Second-authorize gate shared by all four endpoints (§5.1.1's last step). Sends nothing itself
 * beyond what `authorize()` already sent. */
async function reauthorize(opts: UploadRouteOpts, ctx: ReqCtx, fields: { agentKey?: string; uploadId?: string } = {}) {
  const still = await opts.authorize(ctx.reqDeadline);
  if ("handled" in still) {
    audit(opts, ctx, { code: still.code, ...fields });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

async function handleBegin(
  opts: UploadRouteOpts,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ReqCtx,
): Promise<void> {
  const { store } = ctx;
  // §5.1.1's hub in-flight pre-check (the store enforces it authoritatively too — this mirrors
  // `/api/cmd`'s HUB_INFLIGHT_CAP fast-fail so the body is never read when the hub is saturated).
  if (store.inflight() >= UPLOAD_INFLIGHT_HUB) {
    const retryAfterS = 1; // mirrors the response header below — maxRetryAfterS must agree with it
    res.setHeader("Retry-After", String(retryAfterS));
    audit(opts, ctx, { code: "E_RATE", retryAfterS });
    opts.io.sendJson(res, 429, { error: "E_RATE" });
    return;
  }
  const parsed = await readJsonBody(opts, req, res, ctx);
  if (parsed.replied) return;
  const agentKey = stringField(parsed.body, "agentKey");
  const id = stringField(parsed.body, "id");
  const sizeRaw = field(parsed.body, "size");
  const mimeRaw = field(parsed.body, "mime");
  if (agentKey === undefined || id === undefined || !UPLOAD_ID_RE.test(id)) {
    audit(opts, ctx, { code: "E_BAD_REQUEST", ...(agentKey === undefined ? {} : { agentKey }) });
    opts.io.sendJson(res, 400, { error: "E_BAD_REQUEST", message: "agentKey/id required" });
    return;
  }
  if (typeof sizeRaw !== "number" || !Number.isInteger(sizeRaw) || sizeRaw < 0) {
    audit(opts, ctx, { code: "E_BAD_REQUEST", agentKey, uploadId: id });
    opts.io.sendJson(res, 400, { error: "E_BAD_REQUEST", message: "size must be a non-negative integer" });
    return;
  }
  if (mimeRaw !== undefined && typeof mimeRaw !== "string") {
    audit(opts, ctx, { code: "E_BAD_REQUEST", agentKey, uploadId: id });
    opts.io.sendJson(res, 400, { error: "E_BAD_REQUEST", message: "mime must be a string" });
    return;
  }
  // §5.1.2 capability gate (begin only): the agent must be LIVE and advertise cmd.v1 + upload.v1
  // (+ upload.lan.v1 on the LAN listener). Card fields are derived from hello caps by the
  // registry; a missing/undefined field fails closed.
  const view = opts.registry.get(agentKey);
  const capsOk =
    view !== undefined &&
    view.state === "live" &&
    view.control === true &&
    view.upload === true &&
    (opts.listener === "loopback" || view.uploadLan === true);
  if (!capsOk) {
    audit(opts, ctx, { code: "E_UPLOAD_DISABLED", agentKey, uploadId: id });
    opts.io.sendJson(res, 409, {
      error: "E_UPLOAD_DISABLED",
      message: "agent does not advertise upload capability",
    });
    return;
  }
  if (!(await reauthorize(opts, ctx, { agentKey, uploadId: id }))) return;
  try {
    const result = await store.begin(
      {
        principal: ctx.principal,
        agentKey,
        sessionId: view.session?.sessionId,
        id,
        name: field(parsed.body, "name"),
        size: sizeRaw,
        ...(typeof mimeRaw === "string" ? { mime: mimeRaw } : {}),
      },
      { at: ctx.reqDeadline.at },
    );
    opts.io.sendJson(res, 200, {
      id: result.id,
      chunkBytes: opts.listener === "lan" ? UPLOAD_CHUNK_BYTES_LAN : UPLOAD_CHUNK_BYTES_LOOPBACK,
      maxBytes: result.maxBytes,
      received: result.received,
    });
  } catch (err) {
    replyStoreError(opts, res, err, ctx);
  }
}

async function handleChunk(
  opts: UploadRouteOpts,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
  ctx: ReqCtx,
): Promise<void> {
  const id = query.get("id") ?? "";
  const offsetRaw = query.get("offset") ?? "";
  if (!UPLOAD_ID_RE.test(id) || !/^\d{1,15}$/.test(offsetRaw)) {
    audit(opts, ctx, { code: "E_BAD_REQUEST", ...(UPLOAD_ID_RE.test(id) ? { uploadId: id } : {}) });
    opts.io.sendJson(res, 400, { error: "E_BAD_REQUEST", message: "id/offset required" });
    return;
  }
  const offset = Number(offsetRaw);
  if (!Number.isSafeInteger(offset)) {
    audit(opts, ctx, { code: "E_BAD_REQUEST", uploadId: id });
    opts.io.sendJson(res, 400, { error: "E_BAD_REQUEST", message: "bad offset" });
    return;
  }
  const chunkBytes = opts.listener === "lan" ? UPLOAD_CHUNK_BYTES_LAN : UPLOAD_CHUNK_BYTES_LOOPBACK;
  // §1.3: the body read gets `min(UPLOAD_CHUNK_BODY_MS, remaining - 1s)` so the reauth + disk
  // write afterwards always have at least ~1s left inside UPLOAD_TOTAL_MS.
  const bodyMs = Math.min(UPLOAD_CHUNK_BODY_MS, ctx.reqDeadline.remaining() - 1_000);
  if (bodyMs <= 0) {
    audit(opts, ctx, { code: "E_DEADLINE", uploadId: id });
    sendConnClosing(opts, req, res, 504, "E_DEADLINE", "no budget left to read the chunk body");
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await opts.io.readBody(req, chunkBytes, bodyMs);
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    if (status === 413) {
      // declared Content-Length > chunkBytes, or the accumulated body outgrew it ("撒谎" CL)
      audit(opts, ctx, { code: "E_UPLOAD_TOO_LARGE", uploadId: id });
      sendConnClosing(opts, req, res, 413, "E_UPLOAD_TOO_LARGE", `chunk exceeds ${chunkBytes} bytes`);
    } else if (status === 408) {
      audit(opts, ctx, { code: "E_DEADLINE", uploadId: id });
      sendConnClosing(opts, req, res, 408, "E_DEADLINE", "body read timeout");
    } else {
      // 400 request error / aborted mid-body (plan §2.2.5: zero state change — the store was
      // never called, so nothing was written and `received` is untouched)
      audit(opts, ctx, { code: "E_BAD_REQUEST", uploadId: id });
      opts.io.sendJson(res, 400, { error: "E_BAD_REQUEST", message: "request error" });
    }
    return;
  }
  // §1.3: reauth + write share what is left; under 1s the block is refused BEFORE anything is
  // written ("块未写入").
  if (ctx.reqDeadline.remaining() < 1_000) {
    audit(opts, ctx, { code: "E_DEADLINE", uploadId: id });
    opts.io.sendJson(res, 504, { error: "E_DEADLINE", message: "no budget left to persist the chunk" });
    return;
  }
  // hard gate (U3 #1): a logout/rotation that raced the body read is caught HERE — the store has
  // not been called, so zero bytes landed on disk.
  if (!(await reauthorize(opts, ctx, { uploadId: id }))) return;
  try {
    const result = await ctx.store.chunk({ principal: ctx.principal, id, offset, bytes }, { at: ctx.reqDeadline.at });
    opts.io.sendJson(
      res,
      200,
      result.dup === true ? { received: result.received, dup: true } : { received: result.received },
    );
  } catch (err) {
    replyStoreError(opts, res, err, ctx);
  }
}

async function handleCommit(
  opts: UploadRouteOpts,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ReqCtx,
): Promise<void> {
  const parsed = await readJsonBody(opts, req, res, ctx);
  if (parsed.replied) return;
  const id = stringField(parsed.body, "id");
  if (id === undefined || !UPLOAD_ID_RE.test(id)) {
    audit(opts, ctx, { code: "E_BAD_REQUEST" });
    opts.io.sendJson(res, 400, { error: "E_BAD_REQUEST", message: "id required" });
    return;
  }
  if (!(await reauthorize(opts, ctx, { uploadId: id }))) return;
  // §5.1.2 (U3 review P1-1): re-verify the agent is still registered (stale is fine — reconnect
  // window). The binding comes from the store's own begin-time record — principal-namespaced,
  // authoritative, and impossible to lose under churn (the old per-frontend FIFO map could be
  // evicted by 64 unrelated failed uploads and the check would silently fail OPEN). `undefined`
  // means poisoned/committed/unknown ⇒ the store call below 404s or replays idempotently.
  const boundAgent = ctx.store.agentKeyOf(ctx.principal, id);
  if (boundAgent !== undefined && opts.registry.get(boundAgent) === undefined) {
    // delete the dir best-effort; a failed removal is logged loudly (never swallowed) and the
    // poisoned-on-abort state still makes every later op 404, with the next startup scan
    // reclaiming the litter (§2.2.4)
    try {
      await ctx.store.abort({ principal: ctx.principal, id }, { at: ctx.reqDeadline.at });
    } catch (abortErr) {
      opts.log.error("web-hub upload commit: agent-gone abort failed — dir left for startup scan", {
        uploadId: id,
        error: abortErr instanceof Error ? abortErr.message : String(abortErr),
      });
    }
    audit(opts, ctx, { code: "E_AGENT_GONE", agentKey: boundAgent, uploadId: id });
    opts.io.sendJson(res, 410, { error: "E_AGENT_GONE", message: "agent disconnected" });
    return;
  }
  try {
    const result = await ctx.store.commit({ principal: ctx.principal, id }, { at: ctx.reqDeadline.at });
    opts.io.sendJson(res, 200, {
      id: result.id,
      path: result.path,
      size: result.size,
      ...(result.mime === null ? {} : { mime: result.mime }),
      ...(result.dedup === true ? { dedup: true } : {}),
    });
  } catch (err) {
    replyStoreError(opts, res, err, ctx);
  }
}

async function handleAbort(
  opts: UploadRouteOpts,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ReqCtx,
): Promise<void> {
  const parsed = await readJsonBody(opts, req, res, ctx);
  if (parsed.replied) return;
  const id = stringField(parsed.body, "id");
  if (id === undefined || !UPLOAD_ID_RE.test(id)) {
    audit(opts, ctx, { code: "E_BAD_REQUEST" });
    opts.io.sendJson(res, 400, { error: "E_BAD_REQUEST", message: "id required" });
    return;
  }
  if (!(await reauthorize(opts, ctx, { uploadId: id }))) return;
  // no agent recheck here (plan §5.1 only gates begin/commit): abort must stay usable exactly
  // when the agent is already gone.
  try {
    await ctx.store.abort({ principal: ctx.principal, id }, { at: ctx.reqDeadline.at });
    opts.io.sendJson(res, 200, { ok: true });
  } catch (err) {
    replyStoreError(opts, res, err, ctx);
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export async function handleUploadRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  query: URLSearchParams,
  opts: UploadRouteOpts,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  const op = opOf(path);
  const method = (req.method ?? "GET").toUpperCase();
  if (op === undefined || method !== "POST") {
    opts.io.sendJson(res, 404, { error: "E_NOT_FOUND" });
    return;
  }
  const isChunk = op === "chunk";
  // §1.3: chunk requests get their own 14s request deadline (< the 15s listener requestTimeout);
  // the JSON endpoints reuse the write-endpoint's 13s WRITE_TOTAL_MS.
  const reqDeadline = createReqDeadline(opts.now, isChunk ? UPLOAD_TOTAL_MS : WRITE_TOTAL_MS);
  const reqId = randomBytes(8).toString("hex");
  const base = { op, reqId, ip: opts.ip };

  if (!opts.csrfOk(isChunk ? "chunk" : "json")) {
    audit(opts, base, { code: "E_CSRF" });
    opts.io.sendJson(res, 403, { error: "E_CSRF" });
    return;
  }
  const authed = await opts.authorize(reqDeadline);
  if ("handled" in authed) {
    audit(opts, base, { code: authed.code });
    return;
  }
  const store = opts.store;
  if (store === undefined) {
    audit(opts, { ...base, user: authed.user }, { code: "E_NOT_IMPLEMENTED" });
    opts.io.sendJson(res, 501, { error: "E_NOT_IMPLEMENTED" });
    return;
  }
  const principal = `${opts.listener}:${authed.user ?? "token"}`;
  const ctx: ReqCtx = {
    ...base,
    reqDeadline,
    principal,
    ip: authed.ip,
    ...(authed.user === undefined ? {} : { user: authed.user }),
    store,
  };

  // §2.4: one upload token bucket per principal, shared by all four endpoints (64 + 1/100ms).
  const admit = opts.limit.admit(`${principal}:upload`, UPLOAD_RATE_LIMIT_CAPACITY, UPLOAD_RATE_LIMIT_REFILL_MS);
  if (!admit.ok) {
    const retryAfterS = Math.ceil(admit.retryAfterMs / 1000);
    res.setHeader("Retry-After", String(retryAfterS));
    // every 429 counts toward the §5.4 stats row; the audit LINE is throttled to one per bucket
    // per minute (rejectAudit429 shared with cmd)
    opts.metrics?.reject("E_RATE", retryAfterS);
    const key = `upload:${principal}`;
    const t = opts.now();
    const last = opts.rejectAudit429.get(key);
    if (last === undefined || t - last >= RATE_AUDIT_WINDOW_MS) {
      opts.rejectAudit429.set(key, t);
      // NOT the audit() helper — metrics are already counted above (per 429, unthrottled); the
      // helper would double-count. Only the audit LINE is throttled.
      auditUpload(opts.log, {
        phase: "reject",
        op,
        ok: false,
        reqId,
        listener: opts.listener,
        ip: ctx.ip,
        ...(ctx.user === undefined ? {} : { user: ctx.user }),
        code: "E_RATE",
      });
    }
    opts.io.sendJson(res, 429, { error: "E_RATE" });
    return;
  }

  switch (op) {
    case "begin":
      return handleBegin(opts, req, res, ctx);
    case "chunk":
      return handleChunk(opts, req, res, query, ctx);
    case "commit":
      return handleCommit(opts, req, res, ctx);
    case "abort":
      return handleAbort(opts, req, res, ctx);
  }
}
