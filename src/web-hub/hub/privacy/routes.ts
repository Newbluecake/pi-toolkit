/**
 * web-hub-privacy plan v2.1 (P1): the `/api/privacy/*` route surface — `createPrivacyRoutes`
 * is dispatched by BOTH listeners (`http.ts` builds one `PrivacyRouteIo` per request per
 * listener, the `AgentRemoveIo` precedent; this module never imports `http.ts`):
 *
 * - `POST /api/privacy/verify` — **LAN only** (v2.1 N1: a loopback/token session has no second
 *   credential; the loopback dispatch point never routes here and this module defensively 404s
 *   a non-LAN call). Stateless password re-check of the CURRENT session's user via the
 *   extracted `lan-auth.ts` `verifyPassword` (shared per-IP login limiter, fail-only
 *   accounting). A wrong password answers `200 {ok:false}` — NEVER 401 (v2 评审 #3: 401 is the
 *   session-lost semantic that kicks the UI into `conn:"auth"`); a limiter/admission 429 rides
 *   the login handler's exact `E_LOCKED`/`E_RATE` + `Retry-After` mapping.
 * - `POST /api/privacy/lock` — both listeners. `locked:true` needs no password; `locked:false`
 *   on LAN must carry an inline `password` verified on the spot (v2 评审 #2: this is the
 *   server-side enforcement point), on loopback it must not (v2.1 N1). The body's `sessionId`
 *   must equal the agent's CURRENT `session.sessionId`, else `409 E_SESSION_CHANGED` (v2 评审
 *   #5, the preview ⑤ precedent — an agent without a session takes the same code).
 *
 * The password never reaches the audit line (`PRIVACY_AUDIT_KEYS` whitelists fields; there is
 * no password field at all) and never the store (marks are keyed by sessionId only).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { PRIVACY_BODY_BYTES } from "../../protocol/privacy.js";
import { auditPrivacy, type PrivacyAuditRecord } from "../audit.js";
import type { LanVerifyOutcome } from "../lan-auth.js";
import type { HubLog, PrivacyRouteIo, PrivacyRoutes, RegistryView } from "../ports.js";
import { createReqDeadline, WRITE_TOTAL_MS } from "../req-deadline.js";
import { PrivacyStoreError, type PrivacyStore } from "./store.js";

/** Same admission regex as `hub/agent-remove.ts`'s body parser (kept local — that module is a
 * sibling, not a shared library). */
const AGENT_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** SessionId shape admitted at the route layer (pi session ids are uuid-ish; the store
 * re-guards against separators/NUL defensively). */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** `(userId, password, clientIp)` → verdict — hub.ts builds this from `lan-auth.ts`'s
 * `verifyPassword` + the LAN deps (`LanFrontendDeps.{store,kdf,limiter,admission}`). Absent ⇒
 * no LAN assembly exists: verify 404s and a LAN unlock can never reach the password gate. */
export type PrivacyVerifyPasswordFn = (userId: number, password: string, clientIp: string) => Promise<LanVerifyOutcome>;

export interface PrivacyRoutesDeps {
  store: PrivacyStore;
  registry: RegistryView;
  verifyPassword?: PrivacyVerifyPasswordFn;
  log: HubLog;
  now: () => number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The login handler's exact 429 mapping (plan: 429/E_LOCKED 复用登录的 Retry-After 倒计时 UI). */
function sendVerify429(io: PrivacyRouteIo, res: ServerResponse, outcome: LanVerifyOutcome & { status: 429 }): void {
  io.sendJson(
    res,
    429,
    {
      error: outcome.kind === "admission" || outcome.saturated === true ? "E_RATE" : "E_LOCKED",
      ...(outcome.saturated === true ? { saturated: true } : {}),
    },
    { "Retry-After": String(Math.ceil(outcome.retryAfterMs / 1000)) },
  );
}

export function createPrivacyRoutes(deps: PrivacyRoutesDeps): PrivacyRoutes {
  const { store, registry, log, now } = deps;

  function audit(
    io: PrivacyRouteIo,
    auth: { ip: string; user?: string | undefined } | undefined,
    rec: Omit<PrivacyAuditRecord, "listener" | "ip" | "user">,
  ): void {
    auditPrivacy(log, {
      listener: io.listener,
      ip: auth?.ip ?? io.ip,
      ...(auth?.user === undefined ? {} : { user: auth.user }),
      ...rec,
    });
  }

  async function authorize(io: PrivacyRouteIo, deadline: ReturnType<typeof createReqDeadline>, op: "verify" | "lock") {
    const auth = await io.authorize(deadline);
    if ("handled" in auth) {
      audit(io, undefined, { phase: "reject", op, ok: false, code: auth.code });
      return undefined;
    }
    return auth;
  }

  async function handleVerify(req: IncomingMessage, res: ServerResponse, io: PrivacyRouteIo): Promise<void> {
    // v2.1 N1: verify is LAN-only — the loopback dispatch point never routes here; this is the
    // defensive second gate (and covers a hub assembled without LAN deps at all).
    if (io.listener !== "lan" || deps.verifyPassword === undefined) {
      throw new io.HttpError(404, "E_NOT_FOUND");
    }
    const started = now();
    const deadline = createReqDeadline(now, WRITE_TOTAL_MS);
    if (!io.strictCsrfOk()) {
      audit(io, undefined, { phase: "reject", op: "verify", ok: false, code: "E_CSRF" });
      throw new io.HttpError(403, "E_CSRF");
    }
    const auth = await authorize(io, deadline, "verify");
    if (auth === undefined) return;
    const body = await io.readJson(req, PRIVACY_BODY_BYTES);
    const password = isPlainObject(body) ? body["password"] : undefined;
    if (typeof password !== "string" || password.length === 0 || auth.userId === undefined) {
      audit(io, auth, { phase: "reject", op: "verify", ok: false, code: "E_BAD_REQUEST" });
      io.sendJson(res, 400, { error: "E_BAD_REQUEST", message: "password required" });
      return;
    }
    const outcome = await deps.verifyPassword(auth.userId, password, io.ip);
    if (outcome.status === 429) {
      audit(io, auth, { phase: "reject", op: "verify", ok: false, code: "E_RATE", ms: now() - started });
      sendVerify429(io, res, outcome);
      return;
    }
    audit(io, auth, { phase: "request", op: "verify", ok: outcome.ok, ms: now() - started });
    io.sendJson(res, 200, { ok: outcome.ok });
  }

  async function handleLock(req: IncomingMessage, res: ServerResponse, io: PrivacyRouteIo): Promise<void> {
    const started = now();
    const deadline = createReqDeadline(now, WRITE_TOTAL_MS);
    if (!io.strictCsrfOk()) {
      audit(io, undefined, { phase: "reject", op: "lock", ok: false, code: "E_CSRF" });
      throw new io.HttpError(403, "E_CSRF");
    }
    const auth = await authorize(io, deadline, "lock");
    if (auth === undefined) return;
    const body = await io.readJson(req, PRIVACY_BODY_BYTES);
    // Strict shape: exactly {agentKey, sessionId, locked} plus an optional `password` —
    // anything else is a 400 (same additionalProperties:false discipline as the spawn/remove
    // schemas; an old client talking to a newer hub must not silently drop fields).
    if (!isPlainObject(body)) {
      audit(io, auth, { phase: "reject", op: "lock", ok: false, code: "E_BAD_REQUEST" });
      io.sendJson(res, 400, { error: "E_BAD_REQUEST", message: "object body required" });
      return;
    }
    const agentKey = body["agentKey"];
    const sessionId = body["sessionId"];
    const locked = body["locked"];
    const password = body["password"];
    const keysOk = Object.keys(body).every(
      (k) => k === "agentKey" || k === "sessionId" || k === "locked" || k === "password",
    );
    if (
      !keysOk ||
      typeof agentKey !== "string" ||
      !AGENT_KEY_RE.test(agentKey) ||
      typeof sessionId !== "string" ||
      !SESSION_ID_RE.test(sessionId) ||
      typeof locked !== "boolean" ||
      (password !== undefined && typeof password !== "string")
    ) {
      audit(io, auth, { phase: "reject", op: "lock", ok: false, code: "E_BAD_REQUEST" });
      io.sendJson(res, 400, { error: "E_BAD_REQUEST", message: "agentKey/sessionId/locked required" });
      return;
    }

    // v2 评审 #5: the mark must land on the session the user is LOOKING at — refuse when the
    // agent's current session moved on meanwhile (`/new` racing the click). An agent without a
    // session takes the same code (plan「接口」: "agent 无 session 时同码处理").
    const view = registry.get(agentKey);
    if (view === undefined) {
      audit(io, auth, { phase: "reject", op: "lock", agentKey, ok: false, code: "E_NOT_FOUND" });
      io.sendError(res, 404, "E_NOT_FOUND");
      return;
    }
    if (view.session?.sessionId !== sessionId) {
      audit(io, auth, { phase: "reject", op: "lock", agentKey, locked, ok: false, code: "E_SESSION_CHANGED" });
      io.sendJson(res, 409, { error: "E_SESSION_CHANGED" });
      return;
    }

    // v2 评审 #2 + v2.1 N1: unlocking on LAN is the server-side enforcement point — an inline
    // password, verified on the spot. Loopback (token mode) has no second credential and skips
    // this entirely (the UI renders a plain confirm there).
    if (locked === false && io.listener === "lan") {
      if (typeof password !== "string" || password.length === 0) {
        audit(io, auth, { phase: "reject", op: "lock", agentKey, locked, ok: false, code: "E_BAD_REQUEST" });
        io.sendJson(res, 400, { error: "E_BAD_REQUEST", message: "password required" });
        return;
      }
      if (deps.verifyPassword === undefined || auth.userId === undefined) {
        // Defensive: a LAN listener without the verify pipeline assembled — fail closed.
        audit(io, auth, { phase: "reject", op: "lock", agentKey, locked, ok: false, code: "E_INTERNAL" });
        io.sendError(res, 500, "E_INTERNAL");
        return;
      }
      const outcome = await deps.verifyPassword(auth.userId, password, io.ip);
      if (outcome.status === 429) {
        audit(io, auth, {
          phase: "reject",
          op: "lock",
          agentKey,
          locked,
          ok: false,
          code: "E_RATE",
          ms: now() - started,
        });
        sendVerify429(io, res, outcome);
        return;
      }
      if (!outcome.ok) {
        // Same never-401 discipline as verify: a wrong password is a 200 verdict, not an
        // auth-state signal.
        audit(io, auth, { phase: "request", op: "lock", agentKey, locked, ok: false, ms: now() - started });
        io.sendJson(res, 200, { ok: false });
        return;
      }
    }

    try {
      await store.setLocked(sessionId, locked);
    } catch (err) {
      const code = err instanceof PrivacyStoreError ? err.code : "E_INTERNAL";
      const status = err instanceof PrivacyStoreError ? err.status : 500;
      audit(io, auth, { phase: "reject", op: "lock", agentKey, locked, ok: false, code, ms: now() - started });
      io.sendJson(res, status, { error: code });
      return;
    }
    audit(io, auth, { phase: "request", op: "lock", agentKey, locked, ok: true, ms: now() - started });
    io.sendJson(res, 200, { ok: true });
  }

  return { handleVerify, handleLock, locked: () => store.locked() };
}
