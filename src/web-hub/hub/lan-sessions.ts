/**
 * LAN security r2 §3.2 (package D): the LAN login-session management routes.
 *
 *   GET  /api/lan/sessions         X-PWH: 1  → requireLanSession → {idleMinutes, absoluteDays, max, sessions}
 *   POST /api/lan/sessions/revoke  csrfOkLan → requireLanSession → 6/min bucket → {id} | {others:true}
 *
 * One `handle`, like the proxy/avatar route frontends: `false` ⇒ not a sessions route (the
 * original 404 matrix applies), `true` ⇒ answered. Never throws. Loopback callers get a plain
 * 404 (the feature is LAN-only, Q6); the cap `lan.sessions.v1` is advertised iff `config.lan`.
 *
 * Invariants (plan §3.2, §7, addendum item 5):
 *  - The public id is `publicSessionId(sidHash)` (`hub/sid-hash.ts`); a raw sidHash never
 *    crosses this wire. A revoke-by-`{id}` looks the id up against the caller's OWN full list
 *    (≤32 rows by the §3.1 per-user cap), so the id is stable but useless to anyone else.
 *  - Revoke follows the logout order (`http.ts`'s `/api/logout`): emit authRevoke BEFORE the
 *    awaited delete, emit again after it, then SSE-revoke the sidHash. A failed/late delete is
 *    still followed by the second emit + SSE revoke (fail-closed, same as logout).
 *  - Every request lives under one absolute `REVOKE_TOTAL_MS` (10 s) `ReqDeadline`; every IPC
 *    carries an unref'd abort signal bounded by the remaining budget and is wrapped in
 *    `raceDeadline`. A timeout AFTER a delete was dispatched re-emits the revocation for every
 *    pre-listed hash anyway and answers `503 {error:"E_DEADLINE", effect:"unknown"}` (#7);
 *    before any delete was dispatched the answer is a plain `503 E_DB`/`E_DEADLINE`.
 *  - `deleteSessionsExcept`'s return is authoritative for the `others` reply: a concurrent
 *    login that lands between the pre-list and the delete is deleted and counted (honest
 *    `revoked`), and a defensive `more` maps to `complete:false` (the UI shows 「部分未完成」).
 *  - Error bodies are the hub-standard `{error: code}` with `E_CSRF` / `E_AUTH` /
 *    `E_BAD_REQUEST` / `E_DB` / `E_RATE` / `E_NOT_FOUND` (addendum item 5); `E_CLIENT` never
 *    appears here (a denied client gets no bytes at all, §2.3).
 *  - Every outcome (including gate refusals) writes one `auditLanSession` line; the audit
 *    never carries a sidHash, public id or UA string (§8).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Value } from "@sinclair/typebox/value";
import {
  LAN_SESSION_ABSOLUTE_DAYS,
  LAN_SESSIONS_PATH,
  LAN_SESSIONS_PER_USER_MAX,
  LAN_SESSIONS_REVOKE_PATH,
  REVOKE_TOTAL_MS,
  LanSessionRevokeBodySchema,
  type LanSessionRevokeResponse,
  type LanSessionWire,
  type LanSessionsResponse,
} from "../protocol/lan-sessions.js";
import { auditLanSession, type LanSessionAuditRecord } from "./audit.js";
import { createCmdLimit, type CmdLimit } from "./cmd-limit.js";
import type {
  LanSessionListRecord,
  LanSessionsAuth,
  LanSessionsDeps,
  LanSessionsIo,
  LanSessionsRoutes,
} from "./ports.js";
import { createReqDeadline, raceDeadline, type ReqDeadline } from "./req-deadline.js";
import { publicSessionId } from "./sid-hash.js";

// Kept from the P0 stub: the module doubles as the canonical import site for these port types.
export type { LanSessionsDeps, LanSessionsRoutes, LanSessionsIo } from "./ports.js";

/** Plan §3.2: the revoke POSTs share a per-principal bucket of 6 per minute (one token per 10 s). */
const REVOKE_BUCKET_CAPACITY = 6;
const REVOKE_BUCKET_REFILL_MS = 10_000;
/** Revoke bodies are a one-field JSON object; anything bigger is a `400` without reading more. */
const REVOKE_BODY_MAX_BYTES = 2_048;

function isDeadlineFailure(err: unknown, deadline: ReqDeadline): boolean {
  if (deadline.expired()) return true;
  return err instanceof Error && (err.message === "E_DEADLINE" || err.message === "E_ABORTED");
}

/** Per-IPC cancellation, bounded by the request's own remaining budget. The timer is unref'd
 * (AbortSignal.timeout is too, but this stays explicit and fake-clock friendly). */
function ipcSignal(ms: number): AbortSignal {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error("E_DEADLINE")), Math.max(1, ms));
  t.unref();
  return ctl.signal;
}

export function createLanSessionsRoutes(deps: LanSessionsDeps): LanSessionsRoutes {
  const now = deps.now;
  const limit: CmdLimit = createCmdLimit(now);
  // closure-local bookkeeping only (cmd-limit evicts lazily); no timers ⇒ dispose is a no-op.

  function audit(record: LanSessionAuditRecord): void {
    auditLanSession(deps.log, record);
  }

  function answered(res: ServerResponse): boolean {
    return res.headersSent || res.writableEnded;
  }

  function emitRevoke(sidHash: string): void {
    deps.authRevoke.emit({ sel: { sidTag: sidHash }, reason: "logout" });
  }

  /** `requireLanSession` answers failure responses itself (401 E_AUTH / 429 E_RATE / 503 E_DB);
   * the `{handled:true}` marker is the only signal this module gets. */
  async function authenticate(
    res: ServerResponse,
    io: LanSessionsIo,
    deadline: ReqDeadline,
    op: LanSessionAuditRecord["op"],
  ): Promise<LanSessionsAuth | undefined> {
    const auth = await io.requireLanSession(deadline);
    if ("handled" in auth) {
      audit({ op, ip: io.ip, ok: false, code: "E_AUTH" });
      return undefined;
    }
    return auth;
  }

  function toWire(rec: LanSessionListRecord, currentSidHash: string): LanSessionWire {
    return {
      id: publicSessionId(rec.sidHash),
      current: rec.sidHash === currentSidHash,
      createdAt: rec.createdAt,
      lastSeenAt: rec.lastSeenAt,
      expiresAt: rec.expiresAt,
      absoluteExpiresAt: rec.absoluteExpiresAt,
      createdIp: rec.createdIp,
      ...(rec.method === undefined ? {} : { method: rec.method }),
      ...(rec.lastIp === undefined ? {} : { lastIp: rec.lastIp }),
      ...(rec.ua === undefined ? {} : { ua: rec.ua }),
    };
  }

  /** Current device first, then most-recently-active first (the approved 1B card order). */
  function sortSessions(sessions: LanSessionWire[]): LanSessionWire[] {
    return [...sessions].sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      return b.lastSeenAt - a.lastSeenAt;
    });
  }

  /** Store call raced against the request budget; the real IPC slot settles on its own. */
  async function call<T>(op: Promise<T>, deadline: ReqDeadline): Promise<T> {
    return raceDeadline(op, Math.max(1, deadline.remaining()));
  }

  async function list(res: ServerResponse, io: LanSessionsIo, deadline: ReqDeadline): Promise<void> {
    if (!io.xPwhOk()) {
      audit({ op: "list", ip: io.ip, ok: false, code: "E_CSRF" });
      return io.sendJson(res, 403, { error: "E_CSRF" });
    }
    const auth = await authenticate(res, io, deadline, "list");
    if (auth === undefined) return;
    let rows: LanSessionListRecord[];
    try {
      rows = await call(
        deps.store.listSessions(auth.userId, now(), { signal: ipcSignal(deadline.remaining()) }),
        deadline,
      );
    } catch (err) {
      const code = isDeadlineFailure(err, deadline) ? "E_DEADLINE" : "E_DB";
      audit({ op: "list", ip: io.ip, user: auth.user, ok: false, code });
      return io.sendJson(res, 503, { error: code });
    }
    const body: LanSessionsResponse = {
      idleMinutes: Math.round(deps.idleMs / 60_000),
      absoluteDays: LAN_SESSION_ABSOLUTE_DAYS,
      max: LAN_SESSIONS_PER_USER_MAX,
      sessions: sortSessions(rows.map((r) => toWire(r, auth.sidHash))),
    };
    audit({ op: "list", ip: io.ip, user: auth.user, ok: true, n: body.sessions.length });
    io.sendJson(res, 200, body);
  }

  /** Read + validate the revoke body; answers and returns `undefined` on any failure. */
  async function readBody(
    req: IncomingMessage,
    res: ServerResponse,
    io: LanSessionsIo,
    deadline: ReqDeadline,
    auth: LanSessionsAuth,
  ): Promise<{ id: string } | { others: true } | undefined> {
    let raw: unknown;
    try {
      raw = await io.readJson(req, REVOKE_BODY_MAX_BYTES, Math.max(1, deadline.remaining()));
    } catch {
      audit({ op: "revoke", ip: io.ip, user: auth.user, ok: false, code: "E_BAD_REQUEST" });
      io.sendJson(res, 400, { error: "E_BAD_REQUEST" });
      return undefined;
    }
    if (!Value.Check(LanSessionRevokeBodySchema, raw)) {
      audit({ op: "revoke", ip: io.ip, user: auth.user, ok: false, code: "E_BAD_REQUEST" });
      io.sendJson(res, 400, { error: "E_BAD_REQUEST" });
      return undefined;
    }
    return raw;
  }

  /** The fail-closed answer once a delete may already have been dispatched (#7). */
  function deleteUncertain(res: ServerResponse, io: LanSessionsIo, hashes: readonly string[], self: boolean): void {
    for (const h of hashes) {
      emitRevoke(h);
      deps.revokeSse(h);
    }
    if (self) io.clearCookie(res);
  }

  /** No extra response-path wait: fallback gets its own 2s logical/IPC budget. */
  function untrustUncertain(auth: LanSessionsAuth, rows: LanSessionListRecord[], keepIp: string): void {
    const ips = [...new Set(rows.flatMap((r) => [r.createdIp, ...(r.lastIp === undefined ? [] : [r.lastIp])]))];
    void raceDeadline(deps.store.untrustLoginIps(auth.userId, ips, keepIp, { signal: ipcSignal(2000) }), 2000).catch(
      () => {
        deps.log.warn("web-hub lan-sessions: uncertain revoke trust cleanup failed");
      },
    );
  }

  async function revokeOne(
    res: ServerResponse,
    io: LanSessionsIo,
    deadline: ReqDeadline,
    auth: LanSessionsAuth,
    id: string,
  ): Promise<void> {
    let rows: LanSessionListRecord[];
    try {
      rows = await call(
        deps.store.listSessions(auth.userId, now(), { signal: ipcSignal(deadline.remaining()) }),
        deadline,
      );
    } catch (err) {
      const code = isDeadlineFailure(err, deadline) ? "E_DEADLINE" : "E_DB";
      audit({ op: "revoke", ip: io.ip, user: auth.user, ok: false, code });
      return io.sendJson(res, 503, { error: code });
    }
    const target = rows.find((r) => publicSessionId(r.sidHash) === id);
    if (target === undefined) {
      audit({ op: "revoke", ip: io.ip, user: auth.user, ok: false, code: "E_NOT_FOUND" });
      return io.sendJson(res, 404, { error: "E_NOT_FOUND" });
    }
    const self = target.sidHash === auth.sidHash;
    const shared = target.createdIp === io.ip || target.lastIp === io.ip;
    // Logout order (plan §3.2): emit → delete → emit → SSE revoke.
    emitRevoke(target.sidHash);
    let sharedIpKept: boolean;
    try {
      const result = await call(
        deps.store.revokeSession(auth.userId, target.sidHash, io.ip, { signal: ipcSignal(deadline.remaining()) }),
        deadline,
      );
      sharedIpKept = result.sharedIpKept;
    } catch (err) {
      deleteUncertain(res, io, [target.sidHash], self);
      untrustUncertain(auth, [target], io.ip);
      if (isDeadlineFailure(err, deadline)) {
        audit({
          op: "revoke",
          ip: io.ip,
          user: auth.user,
          ok: false,
          code: "E_DEADLINE",
          n: 1,
          self,
          sharedIpKept: shared,
        });
        return io.sendJson(res, 503, { error: "E_DEADLINE", effect: "unknown" });
      }
      audit({ op: "revoke", ip: io.ip, user: auth.user, ok: false, code: "E_DB", n: 1, self, sharedIpKept: shared });
      return io.sendJson(res, 503, { error: "E_DB" });
    }
    emitRevoke(target.sidHash);
    deps.revokeSse(target.sidHash);
    if (self) io.clearCookie(res);
    audit({ op: "revoke", ip: io.ip, user: auth.user, ok: true, n: 1, complete: true, self, sharedIpKept });
    const body: LanSessionRevokeResponse = { ok: true, revoked: 1, complete: true };
    io.sendJson(res, 200, body);
  }

  async function revokeOthers(
    res: ServerResponse,
    io: LanSessionsIo,
    deadline: ReqDeadline,
    auth: LanSessionsAuth,
  ): Promise<void> {
    let rows: LanSessionListRecord[];
    try {
      rows = await call(
        deps.store.listSessions(auth.userId, now(), { signal: ipcSignal(deadline.remaining()) }),
        deadline,
      );
    } catch (err) {
      const code = isDeadlineFailure(err, deadline) ? "E_DEADLINE" : "E_DB";
      audit({ op: "others", ip: io.ip, user: auth.user, ok: false, code });
      return io.sendJson(res, 503, { error: code });
    }
    const preListed = rows.filter((r) => r.sidHash !== auth.sidHash).map((r) => r.sidHash);
    for (const h of preListed) emitRevoke(h);
    let result: { deleted: string[]; more: boolean; sharedIpKept?: boolean };
    try {
      result = await call(
        deps.store.deleteSessionsExcept(auth.userId, auth.sidHash, {
          signal: ipcSignal(deadline.remaining()),
          keepIp: io.ip,
        }),
        deadline,
      );
    } catch (err) {
      // Fail-closed: every pre-listed hash is revoked again even though the delete's effect is
      // unknown. A session created concurrently is NOT in preListed and cannot be named here —
      // the honest `effect:"unknown"` covers it.
      deleteUncertain(res, io, preListed, false);
      untrustUncertain(
        auth,
        rows.filter((r) => r.sidHash !== auth.sidHash),
        io.ip,
      );
      if (isDeadlineFailure(err, deadline)) {
        audit({
          op: "others",
          ip: io.ip,
          user: auth.user,
          ok: false,
          code: "E_DEADLINE",
          n: preListed.length,
          sharedIpKept: rows.some((r) => r.sidHash !== auth.sidHash && (r.createdIp === io.ip || r.lastIp === io.ip)),
        });
        return io.sendJson(res, 503, { error: "E_DEADLINE", effect: "unknown" });
      }
      audit({
        op: "others",
        ip: io.ip,
        user: auth.user,
        ok: false,
        code: "E_DB",
        n: preListed.length,
        sharedIpKept: rows.some((r) => r.sidHash !== auth.sidHash && (r.createdIp === io.ip || r.lastIp === io.ip)),
      });
      return io.sendJson(res, 503, { error: "E_DB" });
    }
    // Concurrent-login honesty: `deleted` is the authoritative list — a login that landed
    // between the pre-list and the delete is included here and revoked like the rest.
    for (const h of result.deleted) {
      emitRevoke(h);
      deps.revokeSse(h);
    }
    const complete = !result.more;
    audit({
      op: "others",
      ip: io.ip,
      user: auth.user,
      ok: true,
      n: result.deleted.length,
      complete,
      sharedIpKept: result.sharedIpKept === true,
    });
    const body: LanSessionRevokeResponse = { ok: true, revoked: result.deleted.length, complete };
    io.sendJson(res, 200, body);
  }

  async function revoke(
    req: IncomingMessage,
    res: ServerResponse,
    io: LanSessionsIo,
    deadline: ReqDeadline,
  ): Promise<void> {
    if (!io.csrfOkLan()) {
      audit({ op: "revoke", ip: io.ip, ok: false, code: "E_CSRF" });
      return io.sendJson(res, 403, { error: "E_CSRF" });
    }
    const auth = await authenticate(res, io, deadline, "revoke");
    if (auth === undefined) return;
    const admit = limit.admit(`lan-sessions:${auth.userId}`, REVOKE_BUCKET_CAPACITY, REVOKE_BUCKET_REFILL_MS);
    if (!admit.ok) {
      audit({ op: "revoke", ip: io.ip, user: auth.user, ok: false, code: "E_RATE" });
      return io.sendJson(
        res,
        429,
        { error: "E_RATE" },
        { "Retry-After": String(Math.ceil(admit.retryAfterMs / 1000)) },
      );
    }
    const body = await readBody(req, res, io, deadline, auth);
    if (body === undefined) return;
    if ("id" in body) return revokeOne(res, io, deadline, auth, body.id);
    return revokeOthers(res, io, deadline, auth);
  }

  return {
    async handle(req, res, method, path, io): Promise<boolean> {
      const route =
        method === "GET" && path === LAN_SESSIONS_PATH
          ? "list"
          : method === "POST" && path === LAN_SESSIONS_REVOKE_PATH
            ? "revoke"
            : undefined;
      if (route === undefined) return false;
      try {
        // LAN-only (Q6): a loopback caller sees the same 404 as if the feature did not exist.
        if (io.listener !== "lan") {
          io.sendJson(res, 404, { error: "E_NOT_FOUND" });
          return true;
        }
        const deadline = createReqDeadline(now, REVOKE_TOTAL_MS);
        if (route === "list") await list(res, io, deadline);
        else await revoke(req, res, io, deadline);
      } catch (err) {
        deps.log.error("web-hub lan-sessions: route failed", { error: String(err) });
        if (!answered(res)) io.sendJson(res, 500, { error: "E_INTERNAL" });
        else res.destroy();
      }
      return true;
    },
    dispose(): void {
      // No timers, no subscriptions: the bucket map is closure-local and dies with the routes.
    },
  };
}
