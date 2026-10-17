/**
 * web-hub port proxy — the hub API route frontend (web-hub-proxy plan v2 §3.8, package X1c).
 *
 *   POST /api/proxy/open   strictCsrfOk → resolveIdentity → bucket → { target } ≤ 2 KiB → service.open
 *   GET  /api/proxy        X-PWH: 1     → resolveIdentity → service.list
 *   POST /api/proxy/stop   as open      → { instanceId } → service.stop
 *
 * One `handle`, like the headless/avatar routes: `false` ⇒ not a proxy route (the original 404
 * matrix still applies), `true` ⇒ answered. Never throws; never logs paths, targets or errors
 * beyond an `E_…` code (the open/end audit lives in the service, `audit.ts`).
 *
 * Invariants (from the X1b hand-off, followed exactly):
 *  - `seq0 = service.currentSeq()` is captured BEFORE `resolveIdentity` (seq0-before-authorize);
 *  - `browserHost` is the HOST part (never an authority with a port) taken from `io`;
 *  - a trusted-reverse-proxy open/stop is refused HERE (409 `E_PROXY_UNAVAILABLE{reverse-proxy}`),
 *    the service never sees it;
 *  - `closing` + `retryable:true` from `open` means "the identity was no longer mintable after an
 *    await" ⇒ the identity is re-resolved, and a stale/revoked one is answered 401 (never a
 *    retryable 503 that a revoked browser would loop on);
 *  - no raw hub credential ever enters a proxy record: this module only forwards the
 *    `AuthIdentity` XA produced (and the `sid`/`lan` extras stay inside the hub process).
 *
 * The request budget is the shared write-endpoint `WRITE_TOTAL_MS` (13 s): LAN auth derives its
 * `LAN_AUTH_CAP_MS` (3 s) from it exactly like `/api/cmd`, which leaves ≥ 10 s for DNS (2 s) +
 * listen (2 s) + the durable port-binding persist (2 s) inside the 15 s UI client deadline
 * (`PROXY_CLIENT_TIMEOUT_MS`) — pinned in `deadline-nesting.test.ts`.
 *
 * `resolveIdentity` is the listener's single identity API (§4.1); on failure it may ALREADY have
 * answered the response itself (the cookie-conflict body + clearing `Set-Cookie`s, the LAN
 * 429/503) — the route only fills in a plain 401/429/503 when nothing was written.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  PROXY_INSTANCE_ID_RE,
  PROXY_LIST_PATH,
  PROXY_OPEN_BUCKET_CAPACITY,
  PROXY_OPEN_BUCKET_REFILL_MS,
  PROXY_OPEN_MAX_BODY_BYTES,
  PROXY_OPEN_PATH,
  PROXY_RETRY_AFTER_S,
  PROXY_STOP_PATH,
} from "../../protocol/proxy.js";
import type { AuthIdentity, HubLog, ProxyOpenFailure, ProxyRouteIo, ProxyRoutes, ProxyService } from "../ports.js";
import { createReqDeadline, WRITE_TOTAL_MS } from "../req-deadline.js";
import { createProxyAudit, proxyErrCode } from "./audit.js";

export interface ProxyRoutesDeps {
  /** Late-bound: the service is constructed AFTER `frontend.listen()` (it needs the real ports),
   * the routes exist from frontend construction. `undefined` ⇒ not (yet / any more) available ⇒
   * 503 `E_PROXY_UNAVAILABLE{closing}` after the CSRF + auth gates. */
  service(): ProxyService | undefined;
  readonly log: Pick<HubLog, "info">;
  readonly now?: () => number;
}

/** Per-principal open/stop bucket entries kept at most (no timers: pruned lazily on insert). */
const BUCKET_MAX_PRINCIPALS = 512;

interface Bucket {
  tokens: number;
  at: number;
}

function isHttpError(err: unknown): err is { status: number; code: string; message?: string } {
  if (err === null || typeof err !== "object") return false;
  const e = err as { status?: unknown; code?: unknown };
  return typeof e.status === "number" && typeof e.code === "string";
}

/** Unauthenticated-failure answer for a `resolveIdentity` that did not write anything itself. */
function authFailureStatus(code: string): number {
  switch (code) {
    case "E_RATE":
      return 429;
    case "E_DB":
      return 503;
    default:
      return 401;
  }
}

export function createProxyRoutes(deps: ProxyRoutesDeps): ProxyRoutes {
  const now = deps.now ?? Date.now;
  const audit = createProxyAudit(deps.log, now);
  const buckets = new Map<string, Bucket>();

  /** Token bucket (capacity 10, +1 per 6 s), per principal. Returns `true` ⇒ admitted. */
  function admit(principal: string): boolean {
    const t = now();
    let b = buckets.get(principal);
    if (b === undefined) {
      if (buckets.size >= BUCKET_MAX_PRINCIPALS) {
        // Drop the oldest-touched entries that have fully refilled first; if everything is hot,
        // evict the least recently touched (a hot principal re-enters with a full bucket only
        // after 512 OTHER principals were active — acceptable, this is a per-principal courtesy
        // limit on a sole-user hub, not a security boundary).
        for (const [k, v] of buckets) {
          if (t - v.at >= PROXY_OPEN_BUCKET_CAPACITY * PROXY_OPEN_BUCKET_REFILL_MS) buckets.delete(k);
        }
        if (buckets.size >= BUCKET_MAX_PRINCIPALS) buckets.delete(buckets.keys().next().value!);
      }
      b = { tokens: PROXY_OPEN_BUCKET_CAPACITY, at: t };
    } else {
      const gained = Math.floor((t - b.at) / PROXY_OPEN_BUCKET_REFILL_MS);
      if (gained > 0) {
        b.tokens = Math.min(PROXY_OPEN_BUCKET_CAPACITY, b.tokens + gained);
        b.at += gained * PROXY_OPEN_BUCKET_REFILL_MS;
      }
    }
    buckets.delete(principal); // re-insert ⇒ Map iteration order = recency
    buckets.set(principal, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  function answered(res: ServerResponse): boolean {
    return res.headersSent || res.writableEnded;
  }

  /** Resolve the identity; on failure make sure SOME response was written. */
  async function identityOf(io: ProxyRouteIo, res: ServerResponse): Promise<AuthIdentity | undefined> {
    const r = await io.resolveIdentity(createReqDeadline(now, WRITE_TOTAL_MS));
    if (r.ok) return r.id;
    if (!answered(res)) io.sendError(res, authFailureStatus(r.code), r.code);
    return undefined;
  }

  function sendFailure(io: ProxyRouteIo, res: ServerResponse, fail: ProxyOpenFailure): void {
    const body = { error: fail.error, reason: fail.reason };
    const headers: Record<string, string> = {};
    if (fail.status === 429 || (fail.status === 503 && fail.error === "E_PROXY_UNAVAILABLE")) {
      headers["Retry-After"] = String(PROXY_RETRY_AFTER_S);
    }
    io.sendJson(res, fail.status, body, headers);
  }

  async function readTarget(req: IncomingMessage, io: ProxyRouteIo, field: string): Promise<string | undefined> {
    const body = await io.readJson(req, PROXY_OPEN_MAX_BODY_BYTES);
    if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
    const v = (body as Record<string, unknown>)[field];
    return typeof v === "string" ? v : undefined;
  }

  async function open(req: IncomingMessage, res: ServerResponse, io: ProxyRouteIo): Promise<void> {
    if (!io.strictCsrfOk()) return io.sendError(res, 403, "E_CSRF");
    const svc = deps.service();
    // seq0 BEFORE identity resolution. An absent service still answers after the auth gate below.
    const seq0 = svc?.currentSeq() ?? 0;
    const identity = await identityOf(io, res);
    if (identity === undefined) return;
    if (io.viaTrustedProxy) {
      audit.open({ ok: false, reason: "reverse-proxy", identity }, "reverse-proxy");
      return io.sendJson(res, 409, { error: "E_PROXY_UNAVAILABLE", reason: "reverse-proxy" });
    }
    if (!admit(identity.principal)) {
      return io.sendJson(res, 429, { error: "E_RATE" }, { "Retry-After": String(PROXY_RETRY_AFTER_S) });
    }
    let target: string | undefined;
    try {
      target = await readTarget(req, io, "target");
    } catch (err) {
      if (isHttpError(err)) return io.sendError(res, err.status, err.code);
      return io.sendError(res, 400, "E_BAD_REQUEST");
    }
    if (target === undefined) return io.sendError(res, 400, "E_BAD_REQUEST");
    if (svc === undefined)
      return sendFailure(io, res, { ok: false, status: 503, error: "E_PROXY_UNAVAILABLE", reason: "closing" });
    const outcome = await svc.open(identity, target, io.browserHost, seq0);
    if (outcome.ok) return io.sendJson(res, 200, outcome.result);
    if (
      outcome.status === 503 &&
      outcome.error === "E_PROXY_UNAVAILABLE" &&
      outcome.reason === "closing" &&
      outcome.retryable === true
    ) {
      // The mint was refused after an await because the identity could no longer authorize
      // (revoked / parent expired) — or the service is really closing. Re-resolve: a stale or
      // revoked identity is a 401 (and any cookie-conflict answer is written by the resolver).
      const again = await identityOf(io, res);
      if (again === undefined) return;
      if (svc.revokedSince(seq0, again) === true) return io.sendError(res, 401, "E_AUTH");
    }
    sendFailure(io, res, outcome);
  }

  async function list(res: ServerResponse, io: ProxyRouteIo): Promise<void> {
    if (!io.xPwhOk()) return io.sendError(res, 403, "E_CSRF");
    const identity = await identityOf(io, res);
    if (identity === undefined) return;
    const svc = deps.service();
    if (svc === undefined)
      return sendFailure(io, res, { ok: false, status: 503, error: "E_PROXY_UNAVAILABLE", reason: "closing" });
    io.sendJson(res, 200, svc.list(identity));
  }

  async function stop(req: IncomingMessage, res: ServerResponse, io: ProxyRouteIo): Promise<void> {
    if (!io.strictCsrfOk()) return io.sendError(res, 403, "E_CSRF");
    const identity = await identityOf(io, res);
    if (identity === undefined) return;
    if (io.viaTrustedProxy) {
      return io.sendJson(res, 409, { error: "E_PROXY_UNAVAILABLE", reason: "reverse-proxy" });
    }
    if (!admit(identity.principal)) {
      return io.sendJson(res, 429, { error: "E_RATE" }, { "Retry-After": String(PROXY_RETRY_AFTER_S) });
    }
    let instanceId: string | undefined;
    try {
      instanceId = await readTarget(req, io, "instanceId");
    } catch (err) {
      if (isHttpError(err)) return io.sendError(res, err.status, err.code);
      return io.sendError(res, 400, "E_BAD_REQUEST");
    }
    if (instanceId === undefined || !PROXY_INSTANCE_ID_RE.test(instanceId)) {
      return io.sendError(res, 400, "E_BAD_REQUEST");
    }
    const svc = deps.service();
    if (svc === undefined)
      return sendFailure(io, res, { ok: false, status: 503, error: "E_PROXY_UNAVAILABLE", reason: "closing" });
    const outcome = await svc.stop(instanceId, identity);
    if (outcome.ok) return io.sendJson(res, 200, { ok: true });
    io.sendError(res, 404, outcome.code);
  }

  return {
    async handle(req, res, method, path, io): Promise<boolean> {
      const route =
        method === "POST" && path === PROXY_OPEN_PATH
          ? "open"
          : method === "GET" && path === PROXY_LIST_PATH
            ? "list"
            : method === "POST" && path === PROXY_STOP_PATH
              ? "stop"
              : undefined;
      if (route === undefined) return false;
      try {
        if (route === "open") await open(req, res, io);
        else if (route === "list") await list(res, io);
        else await stop(req, res, io);
      } catch (err) {
        deps.log.info("proxy-route-failed", { code: proxyErrCode(err) });
        if (!answered(res)) io.sendError(res, 500, "E_INTERNAL");
        else res.destroy();
      }
      return true;
    },
  };
}
