/**
 * web-hub-delete-session plan v2 §2.4/§2.9/§4.1: the `POST /api/agents/remove` route surface —
 * `createAgentRemoveService` is dispatched by BOTH listeners (http.ts builds one `AgentRemoveIo`
 * per request per listener, mirroring `hub/spawn/routes.ts`'s `SpawnRouteIo` precedent; this
 * module never imports `http.ts`).
 *
 * Target resolution (§2.4's decision table, verbatim): the request body carries exactly one of
 * `{agentKey}` (an `AgentCard`) or `{spawnId}` (a `SpawnRow`). The managed-record lookup itself
 * is independent of listener/policy — `managedAllowed` (`listener === "loopback" || spawn.lan !==
 * "off"`) only gates whether an ACTION may be taken against a managed process, never whether one
 * is looked up:
 *
 *   1. `spawnId` form, spawn feature off or `!managedAllowed` → 404 `E_NOT_FOUND` (no lookup
 *      needed — the managed face is unavailable regardless of what is on disk).
 *   2. `spawnId` form, no such record → 200 `{removed:true}` (idempotent).
 *   3. A record was found and `managedAllowed` → `supervisor.remove()` owns the outcome
 *      (200/202/409/504).
 *   4. `agentKey` form, a NON-terminal managed record was found but `!managedAllowed` (LAN with
 *      `spawn.lan === "off"`) → 403 `E_SPAWN_DENIED{reason:"lan-off"}` — never silently falls
 *      back to a registry-only card delete (that would leave the process running with no card,
 *      violating B-alive).
 *   5. Same as 4 but the record is terminal → `supervisor.deathOf()` decides: `"confirmed"` ⇒
 *      delete the CARD only (the spawn record is left for the owning listener to clean up) and
 *      200; otherwise 409 `E_AGENT_ONLINE{reason:"exit-unconfirmed"}`.
 *   6. `agentKey` form, no managed record (or spawn feature off entirely) → `registry.remove()`
 *      alone: `"online"` ⇒ 409 `E_AGENT_ONLINE{reason:"online"}`; `"removed"`/`"absent"` ⇒ 200.
 *
 * Every request writes exactly one `audit:"remove"` line (A13) via `hub/audit.ts`'s
 * `auditRemove` — a SEPARATE channel from the supervisor's own `audit:"spawn"` `phase:"remove"`
 * lines (§4.2: those record the state-machine transition, these record the HTTP decision).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentRemoveErrorReason } from "../protocol/http-contract.js";
import { SPAWN_ID_RE } from "../protocol/spawn.js";
import { auditRemove } from "./audit.js";
import { createCmdLimit } from "./cmd-limit.js";
import type { HubLog } from "./ports.js";
import {
  BODY_CAP_MS,
  BODY_RESERVE_MS,
  WRITE_TOTAL_MS,
  createReqDeadline,
  deriveBudget,
  type ReqDeadline,
} from "./req-deadline.js";
import type { Registry } from "./registry.js";
import type { SpawnAuthResult, SpawnRouteIo } from "./spawn/ports.js";
import { isTerminalSpawnState } from "./spawn/store.js";
import type { InternalRecord, SpawnSupervisor } from "./spawn/supervisor.js";

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------

/** §2.9: `SpawnRouteIo` minus the LAN-admission-scope fields the remove endpoint has no use for
 * (it never admits a cwd or decides a spawn scope). */
export type AgentRemoveIo = Omit<SpawnRouteIo, "scheme" | "viaTrustedProxy">;

/** The managed face this service may act against — absent when `webHub.spawn.enabled` is off
 * entirely (the service still works: `agentKey`-form requests fall straight to `registry.remove`,
 * §2.4 row 6). */
export interface AgentRemoveManaged {
  sup: SpawnSupervisor;
  /** `HubSpawnConfig.lan` — the LAN admission gate for TAKING ACTION on a managed record
   * (§2.4's `managedAllowed`); looking the record up never depends on this. */
  lan: "off" | "known" | "roots";
}

export interface AgentRemoveDeps {
  registry: Pick<Registry, "remove">;
  managed?: AgentRemoveManaged;
  log: HubLog;
  now: () => number;
}

export interface AgentRemoveFrontendPort {
  handle(req: IncomingMessage, res: ServerResponse, io: AgentRemoveIo): Promise<void>;
}

// ---------------------------------------------------------------------------
// body parsing — strict, exactly-one-of, additionalProperties:false (§4.1)
// ---------------------------------------------------------------------------

const AGENT_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT_REMOVE_BODY_MAX = 4 * 1024;
const REMOVE_CAPACITY = 10;
const REMOVE_REFILL_MS = 2_000;
const RATE_AUDIT_WINDOW_MS = 60_000;

type RemoveTarget = { kind: "agentKey"; agentKey: string } | { kind: "spawnId"; spawnId: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseRemoveBody(raw: unknown): RemoveTarget | undefined {
  if (!isPlainObject(raw)) return undefined;
  const keys = Object.keys(raw);
  if (keys.length !== 1) return undefined;
  const key = keys[0];
  if (key === "agentKey") {
    const v = raw["agentKey"];
    return typeof v === "string" && AGENT_KEY_RE.test(v) ? { kind: "agentKey", agentKey: v } : undefined;
  }
  if (key === "spawnId") {
    const v = raw["spawnId"];
    return typeof v === "string" && SPAWN_ID_RE.test(v) ? { kind: "spawnId", spawnId: v } : undefined;
  }
  return undefined;
}

function statusOf(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "status" in err && typeof err.status === "number") return err.status;
  return undefined;
}

// ---------------------------------------------------------------------------
// the service
// ---------------------------------------------------------------------------

export function createAgentRemoveService(deps: AgentRemoveDeps): AgentRemoveFrontendPort {
  const { registry, managed, log, now } = deps;
  const limit = createCmdLimit(now);
  const rejectAudit429 = new Map<string, number>();

  interface AuditFields {
    agentKey?: string;
    spawnId?: string;
    outcome?: string;
    code?: string;
    reason?: string;
  }

  function reject(io: AgentRemoveIo, auth: { ip: string; user?: string | undefined }, fields: AuditFields): void {
    auditRemove(log, {
      phase: "reject",
      listener: io.listener,
      ip: auth.ip,
      ...(auth.user === undefined ? {} : { user: auth.user }),
      ...fields,
    });
  }

  function requestAudit(io: AgentRemoveIo, auth: { ip: string; user?: string | undefined }, fields: AuditFields): void {
    auditRemove(log, {
      phase: "request",
      listener: io.listener,
      ip: auth.ip,
      ...(auth.user === undefined ? {} : { user: auth.user }),
      ...fields,
    });
  }

  function rateReject(
    io: AgentRemoveIo,
    auth: { ip: string; user?: string | undefined },
    throttleKey: string,
    fields: AuditFields,
  ): void {
    const t = now();
    const last = rejectAudit429.get(throttleKey);
    if (last !== undefined && t - last < RATE_AUDIT_WINDOW_MS) return;
    rejectAudit429.set(throttleKey, t);
    reject(io, auth, fields);
  }

  function sendConnClosing(
    io: AgentRemoveIo,
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    code: string,
    message: string,
  ): void {
    res.setHeader("Connection", "close");
    res.once("finish", () => req.destroy());
    io.sendJson(res, status, { error: code, message });
  }

  function sendRateLimited(io: AgentRemoveIo, res: ServerResponse, retryAfterMs: number): void {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    io.sendError(res, 429, "E_RATE");
  }

  function sendOnline(io: AgentRemoveIo, res: ServerResponse, reason: AgentRemoveErrorReason): void {
    io.sendJson(res, 409, { error: "E_AGENT_ONLINE", reason });
  }

  async function authorizeOrReject(io: AgentRemoveIo, deadline: ReqDeadline): Promise<SpawnAuthResult | undefined> {
    const authed = await io.authorize(deadline);
    if ("handled" in authed) {
      reject(io, { ip: io.ip }, { code: authed.code });
      return undefined;
    }
    return authed;
  }

  function findRecord(target: RemoveTarget): InternalRecord | undefined {
    if (managed === undefined) return undefined;
    if (target.kind === "spawnId") {
      return managed.sup.records().find((r) => r.spawnId === target.spawnId);
    }
    const lookup = managed.sup.lookupByAgentKey(target.agentKey);
    if (lookup === undefined) return undefined;
    return managed.sup.records().find((r) => r.spawnId === lookup.spawnId);
  }

  async function handle(req: IncomingMessage, res: ServerResponse, io: AgentRemoveIo): Promise<void> {
    const reqDeadline = createReqDeadline(now, WRITE_TOTAL_MS);

    if (!io.strictCsrfOk()) {
      reject(io, { ip: io.ip }, { code: "E_CSRF" });
      throw new io.HttpError(403, "E_CSRF");
    }

    const auth = await authorizeOrReject(io, reqDeadline);
    if (auth === undefined) return;

    const bodyMs = deriveBudget(reqDeadline.remaining(), BODY_CAP_MS, BODY_RESERVE_MS);
    if (bodyMs <= 0) {
      reject(io, auth, { code: "E_DEADLINE" });
      sendConnClosing(io, req, res, 408, "E_DEADLINE", "no budget left to read the request body");
      return;
    }
    let raw: unknown;
    try {
      raw = await io.readJson(req, AGENT_REMOVE_BODY_MAX, bodyMs);
    } catch (err) {
      const status = statusOf(err);
      if (status === 413) {
        reject(io, auth, { code: "E_BAD_REQUEST" });
        sendConnClosing(io, req, res, 413, "E_BAD_REQUEST", "body too large");
      } else if (status === 408) {
        reject(io, auth, { code: "E_DEADLINE" });
        sendConnClosing(io, req, res, 408, "E_DEADLINE", "body read timeout");
      } else {
        reject(io, auth, { code: "E_BAD_REQUEST" });
        io.sendJson(res, 400, { error: "E_BAD_REQUEST", message: "request error" });
      }
      return;
    }

    const target = parseRemoveBody(raw);
    if (target === undefined) {
      reject(io, auth, { code: "E_BAD_REQUEST" });
      io.sendJson(res, 400, {
        error: "E_BAD_REQUEST",
        message: "body must carry exactly one of agentKey or spawnId",
      });
      return;
    }

    const principal = `${io.listener}:${auth.user ?? "token"}`;
    const bucket = limit.admit(`${principal}:remove`, REMOVE_CAPACITY, REMOVE_REFILL_MS);
    if (!bucket.ok) {
      rateReject(io, auth, `remove:${principal}`, {
        code: "E_RATE",
        ...(target.kind === "agentKey" ? { agentKey: target.agentKey } : { spawnId: target.spawnId }),
      });
      sendRateLimited(io, res, bucket.retryAfterMs);
      return;
    }

    const managedAllowed = io.listener === "loopback" || (managed !== undefined && managed.lan !== "off");

    // §2.4 row 1 — spawnId form, managed face unavailable: no lookup needed.
    if (target.kind === "spawnId" && (managed === undefined || !managedAllowed)) {
      reject(io, auth, { spawnId: target.spawnId, code: "E_NOT_FOUND" });
      io.sendError(res, 404, "E_NOT_FOUND");
      return;
    }

    const rec = findRecord(target);

    // §2.4 row 2 — spawnId form, no such record: idempotent 200.
    if (target.kind === "spawnId" && rec === undefined) {
      requestAudit(io, auth, { spawnId: target.spawnId, outcome: "absent" });
      io.sendJson(res, 200, { removed: true });
      return;
    }

    // §2.4 row 3 — a record was found and the managed face may act on it (either target form).
    if (rec !== undefined && managedAllowed) {
      const r = managed!.sup.remove(rec.spawnId, reqDeadline);
      if (r.ok && r.outcome === "removed") {
        requestAudit(io, auth, {
          spawnId: rec.spawnId,
          ...(rec.agentKey === undefined ? {} : { agentKey: rec.agentKey }),
          outcome: "removed",
        });
        io.sendJson(res, 200, { removed: true });
        return;
      }
      if (r.ok && r.outcome === "pending") {
        requestAudit(io, auth, {
          spawnId: rec.spawnId,
          ...(rec.agentKey === undefined ? {} : { agentKey: rec.agentKey }),
          outcome: "pending",
        });
        io.sendJson(res, 202, { removed: false, pending: true, spawnId: rec.spawnId, state: "stopping" });
        return;
      }
      if (!r.ok && r.code === "E_AGENT_ONLINE") {
        reject(io, auth, { spawnId: rec.spawnId, code: "E_AGENT_ONLINE", reason: r.reason });
        sendOnline(io, res, r.reason);
        return;
      }
      if (!r.ok && r.code === "E_DEADLINE") {
        reject(io, auth, { spawnId: rec.spawnId, code: "E_DEADLINE" });
        io.sendError(res, 504, "E_DEADLINE");
        return;
      }
      // Defensive: a race between `findRecord` and `sup.remove()` within the same synchronous
      // turn is not expected, but never leaves the request unanswered if it somehow happens.
      reject(io, auth, { spawnId: rec.spawnId, code: "E_NOT_FOUND" });
      io.sendError(res, 404, "E_NOT_FOUND");
      return;
    }

    // §2.4 rows 4/5 — agentKey form, a managed record was found but the LAN policy denies
    // ACTING on it (`spawn.lan === "off"`).
    if (rec !== undefined && target.kind === "agentKey" && !managedAllowed) {
      if (isTerminalSpawnState(rec.state)) {
        const d = managed!.sup.deathOf(rec.spawnId);
        if (d === "confirmed") {
          registry.remove(target.agentKey, { allowConnected: true });
          requestAudit(io, auth, { agentKey: target.agentKey, spawnId: rec.spawnId, outcome: "removed" });
          io.sendJson(res, 200, { removed: true });
          return;
        }
        reject(io, auth, {
          agentKey: target.agentKey,
          spawnId: rec.spawnId,
          code: "E_AGENT_ONLINE",
          reason: "exit-unconfirmed",
        });
        sendOnline(io, res, "exit-unconfirmed");
        return;
      }
      reject(io, auth, { agentKey: target.agentKey, spawnId: rec.spawnId, code: "E_SPAWN_DENIED", reason: "lan-off" });
      io.sendJson(res, 403, { error: "E_SPAWN_DENIED", reason: "lan-off" });
      return;
    }

    // §2.4 row 6 — agentKey form, no managed record (or the spawn feature is off entirely).
    // `target.kind` is provably "agentKey" here: the spawnId form is fully handled by rows 1–3
    // above (a defensive guard narrows the type for the compiler without relying on that proof).
    if (target.kind !== "agentKey") {
      reject(io, auth, { spawnId: target.spawnId, code: "E_NOT_FOUND" });
      io.sendError(res, 404, "E_NOT_FOUND");
      return;
    }
    const outcome = registry.remove(target.agentKey, { allowConnected: false });
    if (outcome === "online") {
      reject(io, auth, { agentKey: target.agentKey, code: "E_AGENT_ONLINE", reason: "online" });
      sendOnline(io, res, "online");
      return;
    }
    requestAudit(io, auth, { agentKey: target.agentKey, outcome });
    io.sendJson(res, 200, { removed: true });
  }

  return { handle };
}
