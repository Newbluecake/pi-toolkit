import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AVATAR_DELETE_BODY_MAX_BYTES,
  AVATAR_DELETE_PATH,
  AVATAR_GET_INFLIGHT,
  AVATAR_GET_SEND_MS,
  AVATAR_GET_TOTAL_MS,
  AVATAR_MAX_BYTES,
  AVATAR_PATH,
  AVATAR_STORE_MIN_MS,
  AVATAR_TOTAL_MS,
  type AvatarPath,
} from "../../protocol/avatar.js";
import { validateAvatar } from "./validate.js";
import { canonicalOrigin, parseOrigin } from "../../protocol/lan.js";
import { auditAvatar, type AvatarAuditRecord } from "../audit.js";
import { createCmdLimit, type CmdLimit } from "../cmd-limit.js";
import type { HubLog, AvatarRoutes, PreviewRouteIo } from "../ports.js";
import { createReqDeadline, type ReqDeadline } from "../req-deadline.js";
import { createAvatarStore, AvatarStoreError, type AvatarStore, type AvatarStoreSnapshot } from "./store.js";

export interface AvatarBodyIo {
  readBody(req: IncomingMessage, maxBytes: number, maxMs: number): Promise<Buffer>;
}
export interface AvatarRoutesDeps {
  store: AvatarStore;
  log: HubLog;
  hub: () => { pid: number; startedAt: number };
  now?: () => number;
  limit?: CmdLimit;
  readBody?: AvatarBodyIo["readBody"];
  csrfOk?: (req: IncomingMessage, expectedOrigin: string, kind: "read" | "write" | "json") => boolean;
  rateAudit?: Map<string, number>;
  reqTotalMs?: number;
  /** Test seam for the GET send deadline; production uses AVATAR_GET_SEND_MS. */
  getSendMs?: number;
}

export const AVATAR_STATUS: Readonly<Record<string, number>> = {
  E_AUTH: 401,
  E_CSRF: 403,
  E_NOT_FOUND: 404,
  E_AVATAR_TOO_LARGE: 413,
  E_AVATAR_UNSUPPORTED: 415,
  E_RATE: 429,
  E_INTERNAL: 500,
  E_BUSY: 503,
  E_HUB_RESTARTING: 503,
  E_DEADLINE: 504,
};

function defaultCsrf(req: IncomingMessage, expectedOrigin: string, kind: "read" | "write" | "json"): boolean {
  if (req.headers["x-pwh"] !== "1") return false;
  const fetchSite = req.headers["sec-fetch-site"];
  if (typeof fetchSite === "string" && fetchSite.toLowerCase() !== "same-origin") return false;
  const contentType = req.headers["content-type"];
  if (
    kind === "write" &&
    (req.headers.origin === undefined ||
      contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/octet-stream")
  )
    return false;
  if (kind === "json" && contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const parsed = parseOrigin(origin);
  return parsed !== undefined && canonicalOrigin(parsed.scheme, parsed.hostKey) === expectedOrigin;
}
function once<T extends () => void>(fn: T): T {
  let done = false;
  return (() => {
    if (!done) {
      done = true;
      fn();
    }
  }) as T;
}
function contentLength(req: IncomingMessage): number | undefined {
  const v = req.headers["content-length"];
  if (typeof v !== "string" || !/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
}
function reqId(): string {
  return randomBytes(8).toString("hex");
}
function unrefDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref();
  });
}
async function readBody(req: IncomingMessage, max: number, ms: number): Promise<Buffer> {
  if (contentLength(req) !== undefined && contentLength(req)! > max)
    throw Object.assign(new Error("too large"), { status: 413 });
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(
      () => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(Object.assign(new Error("deadline"), { status: 408 }));
        }
      },
      Math.max(0, ms),
    );
    timer.unref();
    const cleanup = (): void => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAbort);
    };
    const onData = (part: Buffer | string): void => {
      const b = Buffer.isBuffer(part) ? part : Buffer.from(part);
      total += b.length;
      if (total > max && !settled) {
        settled = true;
        cleanup();
        reject(Object.assign(new Error("too large"), { status: 413 }));
      } else chunks.push(b);
    };
    const onEnd = (): void => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(Buffer.concat(chunks));
      }
    };
    const onError = (err: unknown): void => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    };
    const onAbort = (): void => onError(Object.assign(new Error("aborted"), { status: 400 }));
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAbort);
    req.resume?.();
  });
}
function closeBody(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Connection", "close");
  res.once("finish", () => req.destroy());
}
function send(
  io: PreviewRouteIo,
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  io.sendJson(res, status, body, headers);
}
function statusFor(err: unknown): { status: number; body: Record<string, unknown>; headers?: Record<string, string> } {
  if (err instanceof AvatarStoreError)
    return {
      status: err.status,
      body: { error: err.code, ...err.extra },
      ...(typeof err.extra.retryAfterS === "number"
        ? { headers: { "Retry-After": String(err.extra.retryAfterS) } }
        : {}),
    };
  return { status: 500, body: { error: "E_INTERNAL" } };
}
function snapshotReason(s: AvatarStoreSnapshot): string {
  return s.state === "disabled" ? "disabled" : s.state;
}

export function createAvatarRoutes(deps: AvatarRoutesDeps): AvatarRoutes {
  const now = deps.now ?? Date.now;
  const limit = deps.limit ?? createCmdLimit(now);
  const rateAudit = deps.rateAudit ?? new Map<string, number>();
  const read = deps.readBody ?? readBody;
  let writing = false;
  let gets = 0;
  let closing = false;
  const audit = (record: Omit<AvatarAuditRecord, "ms"> & { started: number }): void => {
    if (closing) return;
    auditAvatar(deps.log, { ...record, ms: Math.max(0, now() - record.started) });
  };
  const csrf = deps.csrfOk ?? defaultCsrf;
  const hubIdentity = deps.hub;
  const getSendMs = deps.getSendMs ?? AVATAR_GET_SEND_MS;

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    path: AvatarPath,
    io: PreviewRouteIo,
  ): Promise<void> {
    const started = now();
    const id = reqId();
    const method = (req.method ?? "GET").toUpperCase();
    const op = path === AVATAR_DELETE_PATH ? "delete" : method === "GET" ? "get" : "put";
    let audited = false;
    const finishAudit = (fields: Omit<AvatarAuditRecord, "reqId" | "op" | "ms">): void => {
      if (!audited) {
        audited = true;
        audit({ ...fields, reqId: id, op, started });
      }
    };
    try {
      if (closing) {
        send(io, res, 503, { error: "E_HUB_RESTARTING" });
        finishAudit({ phase: "reject", ok: false, code: "E_HUB_RESTARTING" });
        return;
      }
      const isGet = path === AVATAR_PATH && method === "GET";
      const isPut = path === AVATAR_PATH && method === "POST";
      const isDelete = path === AVATAR_DELETE_PATH && method === "POST";
      if (!isGet && !isPut && !isDelete) {
        send(io, res, 404, { error: "E_NOT_FOUND" });
        finishAudit({ phase: "reject", ok: false, code: "E_NOT_FOUND" });
        return;
      }
      if (!csrf(req, io.expectedOrigin, isGet ? "read" : isDelete ? "json" : "write")) {
        send(io, res, 403, { error: "E_CSRF" });
        finishAudit({ phase: "reject", ok: false, code: "E_CSRF" });
        return;
      }
      const deadline = createReqDeadline(now, isGet ? AVATAR_GET_TOTAL_MS : (deps.reqTotalMs ?? AVATAR_TOTAL_MS));
      const auth = await io.authorize(deadline);
      if ("handled" in auth) {
        finishAudit({ phase: "reject", ok: false, code: auth.code });
        return;
      }
      const principal = `${io.listener}:${auth.user ?? "token"}`;
      const bucket = limit.admit(`${principal}:avatar-${isGet ? "r" : "w"}`, isGet ? 30 : 10, isGet ? 1_000 : 6_000);
      if (!bucket.ok) {
        const retryAfterS = Math.max(1, Math.ceil(bucket.retryAfterMs / 1000));
        res.setHeader("Retry-After", String(retryAfterS));
        send(io, res, 429, { error: "E_RATE" });
        const key = `avatar:${principal}`;
        const last = rateAudit.get(key);
        if (last === undefined || now() - last >= 60_000) {
          rateAudit.set(key, now());
          finishAudit({ phase: "reject", ok: false, code: "E_RATE" });
        }
        return;
      }
      const state = deps.store.snapshot();
      if (state.state === "closing") {
        send(io, res, 503, { error: "E_HUB_RESTARTING" });
        finishAudit({ phase: "reject", ok: false, code: "E_HUB_RESTARTING" });
        return;
      }
      if (isGet) return await handleGet(req, res, io, state, deadline, auth, id, started, finishAudit);
      if (state.state === "loading" || state.state === "disabled" || state.state === "pending") {
        send(io, res, 503, { error: "E_BUSY", reason: snapshotReason(state) });
        finishAudit({ phase: "reject", ok: false, code: "E_BUSY", reason: snapshotReason(state) });
        return;
      }
      if (writing) {
        res.setHeader("Retry-After", "1");
        send(io, res, 503, { error: "E_BUSY", reason: "inflight" });
        finishAudit({ phase: "reject", ok: false, code: "E_BUSY", reason: "inflight" });
        return;
      }
      writing = true;
      try {
        const max = isDelete ? AVATAR_DELETE_BODY_MAX_BYTES : AVATAR_MAX_BYTES;
        const reserve = isDelete ? 750 : AVATAR_STORE_MIN_MS;
        const cl = contentLength(req);
        if (cl !== undefined && cl > max) {
          closeBody(req, res);
          send(io, res, 413, { error: "E_AVATAR_TOO_LARGE", max });
          finishAudit({ phase: "reject", ok: false, code: "E_AVATAR_TOO_LARGE" });
          return;
        }
        if (deadline.remaining() < (isDelete ? 750 : 1_000 + 1_000 + reserve)) {
          closeBody(req, res);
          send(io, res, 504, { error: "E_DEADLINE", effect: "none" });
          finishAudit({ phase: "reject", ok: false, code: "E_DEADLINE", effect: "none" });
          return;
        }
        let body: Buffer;
        try {
          body = await read(
            req,
            max,
            Math.min(isDelete ? 1_000 : 5_000, Math.max(0, deadline.remaining() - reserve - (isDelete ? 0 : 1_000))),
          );
        } catch (err) {
          const status = (err as { status?: unknown }).status;
          closeBody(req, res);
          if (status === 413) {
            send(io, res, 413, { error: "E_AVATAR_TOO_LARGE", max });
            finishAudit({ phase: "reject", ok: false, code: "E_AVATAR_TOO_LARGE" });
          } else if (status === 408) {
            send(io, res, 504, { error: "E_DEADLINE", effect: "none" });
            finishAudit({ phase: "reject", ok: false, code: "E_DEADLINE", effect: "none", io: "deadline" });
          } else {
            send(io, res, 400, { error: "E_BAD_REQUEST" });
            finishAudit({ phase: "reject", ok: false, code: "E_BAD_REQUEST" });
          }
          return;
        }
        if (isDelete) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString("utf8"));
          } catch {
            send(io, res, 400, { error: "E_BAD_REQUEST" });
            finishAudit({ phase: "reject", ok: false, code: "E_BAD_REQUEST" });
            return;
          }
          if (parsed === null || typeof parsed !== "object" || Object.keys(parsed).length !== 0) {
            send(io, res, 400, { error: "E_BAD_REQUEST" });
            finishAudit({ phase: "reject", ok: false, code: "E_BAD_REQUEST" });
            return;
          }
          if (deadline.remaining() < 750) {
            send(io, res, 504, { error: "E_DEADLINE", effect: "none" });
            finishAudit({ phase: "reject", ok: false, code: "E_DEADLINE", effect: "none" });
            return;
          }
          const reauth = await io.authorize(deadline);
          if ("handled" in reauth) {
            finishAudit({ phase: "reject", ok: false, code: reauth.code });
            return;
          }
          const result = await deps.store.remove(deadline);
          send(io, res, 200, { avatar: result.info, hub: hubIdentity() });
          finishAudit({ phase: "request", ok: true, gen: result.info.gen });
          return;
        }
        if (body.length > AVATAR_MAX_BYTES) {
          closeBody(req, res);
          send(io, res, 413, { error: "E_AVATAR_TOO_LARGE", max: AVATAR_MAX_BYTES });
          finishAudit({ phase: "reject", ok: false, code: "E_AVATAR_TOO_LARGE" });
          return;
        }
        const checked = validateAvatar(body);
        if (!checked.ok) {
          send(io, res, 415, { error: "E_AVATAR_UNSUPPORTED", reason: checked.reason });
          finishAudit({ phase: "reject", ok: false, code: "E_AVATAR_UNSUPPORTED", reason: checked.reason });
          return;
        }
        if (deadline.remaining() < AVATAR_STORE_MIN_MS) {
          send(io, res, 504, { error: "E_DEADLINE", effect: "none" });
          finishAudit({ phase: "reject", ok: false, code: "E_DEADLINE", effect: "none" });
          return;
        }
        const reauth = await io.authorize(deadline);
        if ("handled" in reauth) {
          finishAudit({ phase: "reject", ok: false, code: reauth.code });
          return;
        }
        const v = digest(body);
        const result = await deps.store.put(body, v, deadline);
        send(io, res, 200, {
          avatar: { ...result.info, side: result.side, bytes: result.bytes, ...(result.dedup ? { dedup: true } : {}) },
          hub: hubIdentity(),
        });
        finishAudit({
          phase: "request",
          ok: true,
          bytes: result.bytes,
          side: result.side,
          v,
          gen: result.info.gen,
          ...(result.dedup ? { dedup: true } : {}),
        });
      } catch (err) {
        const mapped = statusFor(err);
        send(io, res, mapped.status, mapped.body, mapped.headers);
        const fields: Omit<AvatarAuditRecord, "reqId" | "op" | "ms"> = {
          phase: "reject",
          ok: false,
          code: String(mapped.body.error),
          ...(typeof mapped.body.reason === "string" ? { reason: mapped.body.reason } : {}),
          ...(typeof mapped.body.effect === "string" ? { effect: mapped.body.effect as "none" | "unknown" } : {}),
        };
        finishAudit(fields);
      } finally {
        writing = false;
      }
    } catch {
      if (!audited) {
        send(io, res, 500, { error: "E_INTERNAL" });
        finishAudit({ phase: "reject", ok: false, code: "E_INTERNAL" });
      }
    }
  }

  async function handleGet(
    req: IncomingMessage,
    res: ServerResponse,
    io: PreviewRouteIo,
    state: AvatarStoreSnapshot,
    deadline: ReqDeadline,
    auth: { ip: string; user?: string },
    id: string,
    started: number,
    finish: (fields: Omit<AvatarAuditRecord, "reqId" | "op" | "ms">) => void,
  ): Promise<void> {
    if (state.state === "loading" || state.state === "disabled") {
      send(io, res, 503, { error: "E_BUSY", reason: snapshotReason(state) });
      finish({ phase: "reject", ok: false, code: "E_BUSY", reason: snapshotReason(state) });
      return;
    }
    if (gets >= AVATAR_GET_INFLIGHT) {
      send(io, res, 503, { error: "E_BUSY", reason: "inflight" });
      finish({ phase: "reject", ok: false, code: "E_BUSY", reason: "inflight" });
      return;
    }
    gets += 1;
    let timer: NodeJS.Timeout | undefined;
    let deadlineHit = false;
    let clientAbort = false;
    let auditFields: Omit<AvatarAuditRecord, "reqId" | "op" | "ms"> | undefined;
    const release = once(() => {
      gets -= 1;
      if (timer !== undefined) clearTimeout(timer);
      const fields = auditFields ?? { phase: "request" as const, ok: res.writableFinished };
      finish({
        ...fields,
        ok: res.writableFinished,
        ...(deadlineHit ? { io: "deadline" as const } : clientAbort ? { io: "abort" as const } : {}),
      });
    });
    res.once("finish", release);
    res.once("close", () => {
      if (!res.writableFinished) clientAbort = true;
      release();
    });
    timer = setTimeout(() => {
      deadlineHit = true;
      res.destroy();
      release();
    }, getSendMs);
    timer.unref();
    try {
      const snap = deps.store.snapshot();
      const m = snap.memory;
      if (m === undefined) {
        auditFields = { phase: "request", ok: false, code: "E_NOT_FOUND" };
        send(io, res, 404, { error: "E_NOT_FOUND" });
        return;
      }
      const etag = `"${m.v}"`;
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "private, no-cache");
      if (req.headers["if-none-match"] === etag) {
        auditFields = {
          phase: "request",
          ok: true,
          v: m.v,
          ...(snap.info?.gen === undefined ? {} : { gen: snap.info.gen }),
        };
        res.writeHead(304);
        res.end();
        return;
      }
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Disposition", 'inline; filename="avatar.png"');
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("Content-Length", String(m.bytes.length));
      auditFields = {
        phase: "request",
        ok: true,
        bytes: m.bytes.length,
        side: m.side,
        v: m.v,
        ...(snap.info?.gen === undefined ? {} : { gen: snap.info.gen }),
      };
      res.end(Buffer.from(m.bytes));
    } finally {
      void deadline;
      void auth;
      void id;
      void started;
    }
  }
  async function dispose(reason: "close" | "startup-failure", deadline: ReqDeadline): Promise<void> {
    void reason;
    closing = true;
    await Promise.race([deps.store.close(deadline.at), unrefDelay(Math.max(0, deadline.remaining()))]);
  }
  return { handle, dispose };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export { createAvatarStore };
