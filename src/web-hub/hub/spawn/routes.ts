/**
 * web-hub-spawn plan §SP9 / arch v2 §8.2 (#13): the `/api/headless*` route surface —
 * `createSpawnRoutes` implements SP1's frozen `SpawnFrontendPort` for ONE hub and serves BOTH
 * listeners through the injected `SpawnRouteIo` (http.ts builds one io per request per listener,
 * mirroring `dispatchCmdOrDialog`'s opts — same helpers, same semantics; this module never
 * imports `http.ts`).
 *
 * Endpoints (arch §8.2 table):
 *
 *   GET  /api/headless          → 200 {policy, items} — per-principal projection (§6.4, project.ts)
 *   GET  /api/headless/dirs     → 200 {recent: DirEntryWire[], partial?} — `?path=` ⇒ 400
 *                                 `E_DIR{reason:"browse-unavailable"}` (S1 has no browse)
 *   POST /api/headless          → 202 SpawnAccepted | 409 E_CONFIRM_REQUIRED{resolvedCwd, reason}
 *                                 | 409 E_LIMIT | 503 E_LAUNCHER | 403 E_SPAWN_DENIED | 400 E_DIR
 *   POST /api/headless/:id/stop → 202 {state} — idempotent; any authenticated LAN principal may
 *                                 stop any managed session (arch §6.0 user ruling #8)
 *
 * "202 ⇔ 有记录" (arch §3.1 note): the record is built by `supervisor.start()`'s synchronous
 * ① intent persist, so once 202 goes out a record always exists — even a fork that throws
 * afterwards keeps the 202 (the failure rides the `spawns` SSE). A dup replay of the same
 * `principal|id` with the same intent digest replays the SAME record (`dup:true`).
 *
 * POST gate order — arch §8.2's ladder with ONE deliberate, plan-mandated repositioning: the
 * creation token is spent AFTER the schema parse and idempotency peek, because plan §SP9 pins
 * "幂等命中不扣令牌" (a retried duplicate must never burn `ratePerMinute` budget — same
 * optimization as `dispatchCmdOrDialog`'s `peekIdempotent` skip). Everything else keeps the
 * arch order: Host (caller) → strictCsrf → authorize → policy → [body → schema → idempotency
 * peek] → rate → admit (bounded) → confirm → second authorize → supervisor.start (limits,
 * intent persist and fork all synchronous inside) → 202. No await between the second
 * authorize and the 202.
 *
 * Idempotency LRU: key `principal|id`, 256 entries / 10 min, digest sha256(canonical
 * {cwd, firstPrompt}) — `confirm`/`expectCwd` deliberately NOT in the digest (plan §SP9: "只多
 * confirm 视为同一意图"), and a 409 confirm reply never writes an entry.
 *
 * Audit (arch §6.6): reject lines are written HERE (CSRF/auth/rate/policy/deadline/body/schema/
 * admit/confirm — everything the supervisor never sees); a 202 writes one request-phase line
 * (`cwd` carries the realpath, the sanctioned forensics exception); state transitions stay the
 * supervisor's lines (SP7). The first-prompt BODY never reaches an audit line (U7).
 *
 * LAN policy: `http.ts` only dispatches here when `publicPayload("lan") !== undefined`
 * (i.e. `cfg.lan !== "off"`); `handle` re-guards anyway (404 pre-auth — byte-identical to the
 * not-enabled fall-through, arch §8.2 matrix row "启用，LAN off"). The admit scope and the
 * confirm mode are read off `supervisor.policy()` — the supervisor owns the
 * scheme/viaTrustedProxy decision (arch §6.4), routes only thread it through.
 *
 * Zero-`as` module (`hub/spawn/**` contract, `tests/web-hub/hub/spawn/source-scan.test.ts`).
 */
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { auditSpawn } from "../audit.js";
import type { CmdLimit } from "../cmd-limit.js";
import type { HubLog } from "../ports.js";
import {
  BODY_CAP_MS,
  BODY_RESERVE_MS,
  createReqDeadline,
  deriveBudget,
  WRITE_TOTAL_MS,
  type ReqDeadline,
} from "../req-deadline.js";
import {
  FIRST_PROMPT_GRACE_MS,
  SPAWN_BODY_MAX,
  SPAWN_GONE_REASON,
  SPAWN_ID_RE,
  parseSpawnRequestBody,
  type HubSpawnConfig,
} from "../../protocol/spawn.js";
import type { DirService } from "./dirs.js";
import type { FirstPromptForwarder } from "./first-prompt.js";
import type { SpawnFrontendPort, SpawnRouteIo } from "./ports.js";
import { toPublicPayload, toViewer } from "./project.js";
import { spawnPrincipal, type AdmittedRequest, type SpawnSupervisor, type StartResult } from "./supervisor.js";

// ---------------------------------------------------------------------------
// tunables (plan §SP9; every number the route gates are built from)
// ---------------------------------------------------------------------------

/** Idempotency LRU: entries per hub / freshness window (plan §SP9: 256 条 / 10 分钟). */
export const SPAWN_IDEMPOTENCY_MAX = 256;
export const SPAWN_IDEMPOTENCY_TTL_MS = 600_000;
/** `GET` endpoints' shared read bucket (arch §6.5: 读端点 10/1s). */
const SPAWN_READ_CAPACITY = 10;
const SPAWN_READ_REFILL_MS = 1_000;
/** Stop bucket — same parameters as the cmd plane's "stop" category (http.ts `limitCategoryFor`). */
const STOP_CAPACITY = 10;
const STOP_REFILL_MS = 2_000;
/** Creation bucket: capacity `ratePerMinute`, one token per `60_000/ratePerMinute` ms (plan §SP9). */
const SPAWN_RATE_WINDOW_MS = 60_000;
/** 429-audit throttle (same semantics as `dispatchCmdOrDialog`'s RATE_AUDIT_WINDOW_MS). */
const RATE_AUDIT_WINDOW_MS = 60_000;
/** arch §8.2: admit's own budget — min(2s, remaining-3s); the reserve keeps the sync stretch fed. */
const ADMIT_CAP_MS = 2_000;
const ADMIT_RESERVE_MS = 3_000;
/** `GET /api/headless/dirs` rides `dirs.known()`'s own 2s scan budget (arch §4.5). */
const DIRS_BUDGET_MS = 2_000;
/** Stop body cap (`{force?:true}` needs nothing near this; keeps parsing bounded). */
const STOP_BODY_MAX = 4 * 1024;

// ---------------------------------------------------------------------------
// deps & shape
// ---------------------------------------------------------------------------

export interface SpawnRoutesDeps {
  supervisor: SpawnSupervisor;
  dirs: DirService;
  firstPrompt: FirstPromptForwarder;
  cfg: HubSpawnConfig;
  limit: CmdLimit;
  /** Shared 429-audit throttle map (same instance `dispatchCmdOrDialog` uses). */
  rejectAudit429: Map<string, number>;
  log: HubLog;
  now: () => number;
}

interface IdemEntry {
  spawnId: string;
  digest: string;
  at: number;
}

/** The parsed intent everything downstream (LRU digest, admit, start) is built from. */
interface SpawnIntent {
  id: string;
  cwd: string;
  confirmed: boolean;
  expectCwd: string | undefined;
  firstPrompt: { text: string; deliver: "steer" | "followUp" } | undefined;
}

const HEADLESS_STOP_PREFIX = "/api/headless/";
const HEADLESS_STOP_SUFFIX = "/stop";

function matchStopPath(path: string): string | undefined {
  if (!path.startsWith(HEADLESS_STOP_PREFIX) || !path.endsWith(HEADLESS_STOP_SUFFIX)) return undefined;
  const id = path.slice(HEADLESS_STOP_PREFIX.length, path.length - HEADLESS_STOP_SUFFIX.length);
  return SPAWN_ID_RE.test(id) ? id : undefined;
}

/** sha256 over a canonical (fixed-key-order) rendering of {cwd, firstPrompt} — confirm/expectCwd excluded. */
function intentDigest(intent: SpawnIntent): string {
  const fp = intent.firstPrompt;
  const canonical =
    fp === undefined
      ? `{"cwd":${JSON.stringify(intent.cwd)}}`
      : `{"cwd":${JSON.stringify(intent.cwd)},"firstPrompt":{"deliver":${JSON.stringify(fp.deliver)},"text":${JSON.stringify(fp.text)}}}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/** HttpError-shaped test without `as` (source-scan contract). */
function statusOf(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "status" in err && typeof err.status === "number") return err.status;
  return undefined;
}

export function createSpawnRoutes(deps: SpawnRoutesDeps): SpawnFrontendPort {
  const { supervisor, dirs, firstPrompt, cfg, limit, log, now } = deps;
  const idem = new Map<string, IdemEntry>();

  // ------------------------------------------------------------- idempotency LRU

  function idemGet(key: string): IdemEntry | undefined {
    const hit = idem.get(key);
    if (hit === undefined) return undefined;
    if (now() - hit.at > SPAWN_IDEMPOTENCY_TTL_MS) {
      idem.delete(key);
      return undefined;
    }
    return hit;
  }

  function idemPut(key: string, spawnId: string, digest: string): void {
    idem.delete(key); // refresh insertion order so eviction below always drops the OLDEST
    idem.set(key, { spawnId, digest, at: now() });
    while (idem.size > SPAWN_IDEMPOTENCY_MAX) {
      const oldest = idem.keys().next();
      if (oldest.done === true) break;
      idem.delete(oldest.value);
    }
  }

  // ------------------------------------------------------------- audit (arch §6.6)

  interface RejectFields {
    endpoint: "list" | "dirs" | "spawn" | "stop";
    code: string;
    reqId?: string;
    spawnId?: string;
    cwd?: string;
    known?: boolean;
    confirmed?: boolean;
    limit?: "global" | "principal" | "starting";
    active?: number;
    max?: number;
  }

  function rejectAudit(io: SpawnRouteIo, auth: { ip: string; user?: string | undefined }, fields: RejectFields): void {
    auditSpawn(log, {
      audit: "spawn",
      phase: "reject",
      endpoint: fields.endpoint,
      listener: io.listener,
      ip: auth.ip,
      ...(auth.user === undefined ? {} : { user: auth.user }),
      ...(fields.reqId === undefined ? {} : { reqId: fields.reqId }),
      ...(fields.spawnId === undefined ? {} : { spawnId: fields.spawnId }),
      ...(fields.cwd === undefined ? {} : { cwd: fields.cwd }),
      ...(fields.known === undefined ? {} : { known: fields.known }),
      ...(fields.confirmed === undefined ? {} : { confirmed: fields.confirmed }),
      ...(fields.limit === undefined ? {} : { limit: fields.limit }),
      ...(fields.active === undefined ? {} : { active: fields.active }),
      ...(fields.max === undefined ? {} : { max: fields.max }),
      code: fields.code,
    });
  }

  /** 429 reject lines are throttled to one per throttle key per RATE_AUDIT_WINDOW_MS. */
  function rateAudit(
    io: SpawnRouteIo,
    auth: { ip: string; user?: string | undefined },
    throttleKey: string,
    fields: RejectFields,
  ): void {
    const t = now();
    const last = deps.rejectAudit429.get(throttleKey);
    if (last !== undefined && t - last < RATE_AUDIT_WINDOW_MS) return;
    deps.rejectAudit429.set(throttleKey, t);
    rejectAudit(io, auth, fields);
  }

  // ------------------------------------------------------------- shared senders

  /** 413/408 replies close the connection (an unread oversized body must never be parsed as
   *  the next request) — same behavior `http.ts`'s catchers give the other write endpoints. */
  function sendConnClosing(
    io: SpawnRouteIo,
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

  function sendSpawnDenied(io: SpawnRouteIo, res: ServerResponse, reason: string, detail?: string): void {
    io.sendJson(res, 403, {
      error: "E_SPAWN_DENIED",
      reason,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  function sendLauncher(io: SpawnRouteIo, res: ServerResponse, reason: string, retryAfterS?: number): void {
    const headers: Record<string, string> = {};
    if (retryAfterS !== undefined) headers["Retry-After"] = String(Math.max(1, retryAfterS));
    io.sendJson(
      res,
      503,
      { error: "E_LAUNCHER", reason, ...(retryAfterS === undefined ? {} : { retryAfterS }) },
      headers,
    );
  }

  function sendLimit(io: SpawnRouteIo, res: ServerResponse, r: Extract<StartResult, { ok: false }>): void {
    io.sendJson(res, 409, {
      error: "E_LIMIT",
      limit: r.limit ?? "global",
      active: r.active ?? 0,
      max: r.max ?? cfg.maxProcesses,
    });
  }

  function sendRateLimited(io: SpawnRouteIo, res: ServerResponse, retryAfterMs: number): void {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    io.sendError(res, 429, "E_RATE");
  }

  /** StartResult → reply; returns true when the reply was sent from here (E_DIR included). */
  function sendStartResult(io: SpawnRouteIo, res: ServerResponse, r: StartResult): boolean {
    if (r.ok) return false;
    switch (r.code) {
      case "E_LIMIT":
        sendLimit(io, res, r);
        return true;
      case "E_LAUNCHER":
        sendLauncher(io, res, r.reason ?? "unavailable", r.retryAfterS);
        return true;
      case "E_SPAWN_DENIED":
        sendSpawnDenied(io, res, r.reason ?? "denied");
        return true;
      case "E_DIR":
        io.sendJson(res, 400, { error: "E_DIR", reason: r.reason ?? "not-allowed" });
        return true;
      case "E_DEADLINE":
        io.sendError(res, 504, "E_DEADLINE");
        return true;
    }
    return false;
  }

  // ------------------------------------------------------------- GET helpers

  /** §8.2: GET endpoints require the `X-PWH: 1` header (a custom header forces CORS preflight,
   *  so a cross-origin page cannot even read); missing ⇒ 403 E_CSRF. */
  function pwhHeaderOk(req: IncomingMessage): boolean {
    return req.headers["x-pwh"] === "1";
  }

  async function authorizeOrAudit(
    io: SpawnRouteIo,
    deadline: ReqDeadline,
    endpoint: RejectFields["endpoint"],
    reqId?: string,
  ): Promise<{ ip: string; user?: string | undefined } | undefined> {
    const authed = await io.authorize(deadline);
    if ("handled" in authed) {
      rejectAudit(io, { ip: io.ip }, { endpoint, code: authed.code, ...(reqId === undefined ? {} : { reqId }) });
      return undefined;
    }
    return authed;
  }

  async function handleList(req: IncomingMessage, res: ServerResponse, io: SpawnRouteIo): Promise<void> {
    if (!pwhHeaderOk(req)) {
      rejectAudit(io, { ip: io.ip }, { endpoint: "list", code: "E_CSRF" });
      io.sendError(res, 403, "E_CSRF");
      return;
    }
    const reqDeadline = createReqDeadline(now, WRITE_TOTAL_MS);
    const auth = await authorizeOrAudit(io, reqDeadline, "list");
    if (auth === undefined) return;
    const owner = { listener: io.listener, reqId: "", ...(auth.user === undefined ? {} : { user: auth.user }) };
    const principal = spawnPrincipal(owner);
    const read = limit.admit(`${principal}:spawn-read`, SPAWN_READ_CAPACITY, SPAWN_READ_REFILL_MS);
    if (!read.ok) {
      rateAudit(io, auth, `spawn-read:${principal}`, { endpoint: "list", code: "E_RATE" });
      sendRateLimited(io, res, read.retryAfterMs);
      return;
    }
    const policy = supervisor.policy(principal, io.listener, io.scheme, io.viaTrustedProxy);
    const isLoopback = io.listener === "loopback";
    const items = supervisor
      .records()
      .map((rec) => toViewer(rec, principal, isLoopback, (id) => firstPrompt.state(id)));
    io.sendJson(res, 200, { policy, items });
  }

  async function handleDirs(
    req: IncomingMessage,
    res: ServerResponse,
    query: URLSearchParams,
    io: SpawnRouteIo,
  ): Promise<void> {
    if (!pwhHeaderOk(req)) {
      rejectAudit(io, { ip: io.ip }, { endpoint: "dirs", code: "E_CSRF" });
      io.sendError(res, 403, "E_CSRF");
      return;
    }
    const reqDeadline = createReqDeadline(now, WRITE_TOTAL_MS);
    const auth = await authorizeOrAudit(io, reqDeadline, "dirs");
    if (auth === undefined) return;
    const owner = { listener: io.listener, reqId: "", ...(auth.user === undefined ? {} : { user: auth.user }) };
    const principal = spawnPrincipal(owner);
    const read = limit.admit(`${principal}:spawn-read`, SPAWN_READ_CAPACITY, SPAWN_READ_REFILL_MS);
    if (!read.ok) {
      rateAudit(io, auth, `spawn-read:${principal}`, { endpoint: "dirs", code: "E_RATE" });
      sendRateLimited(io, res, read.retryAfterMs);
      return;
    }
    // S1 has no subdirectory browse (S2's `dirs?path=`): the parameter is a client bug, not a
    // probe we silently ignore — arch §8.2 pins 400 E_DIR{reason:"browse-unavailable"}.
    if (query.get("path") !== null) {
      rejectAudit(io, auth, { endpoint: "dirs", code: "E_DIR" });
      io.sendJson(res, 400, { error: "E_DIR", reason: "browse-unavailable" });
      return;
    }
    let known: { entries: readonly { cwd: string; label: string; at: number }[]; partial: boolean };
    try {
      known = await dirs.known(createReqDeadline(now, DIRS_BUDGET_MS));
    } catch (err) {
      log.error("web-hub spawn routes: dirs.known failed", { error: String(err) });
      io.sendError(res, 500, "E_INTERNAL");
      return;
    }
    io.sendJson(res, 200, { recent: known.entries, ...(known.partial ? { partial: true } : {}) });
  }

  // ------------------------------------------------------------- POST /api/headless

  async function handleSpawn(req: IncomingMessage, res: ServerResponse, io: SpawnRouteIo): Promise<void> {
    const reqDeadline = createReqDeadline(now, WRITE_TOTAL_MS);

    // gate 1 — strict CSRF (same grade as /api/cmd: CT + X-PWH + Origin + Sec-Fetch-Site)
    if (!io.strictCsrfOk()) {
      rejectAudit(io, { ip: io.ip }, { endpoint: "spawn", code: "E_CSRF" });
      throw new io.HttpError(403, "E_CSRF");
    }

    // gate 2 — auth #1
    const auth = await authorizeOrAudit(io, reqDeadline, "spawn");
    if (auth === undefined) return;
    const ownerOf = (reqId: string) => ({
      listener: io.listener,
      reqId,
      ...(auth.user === undefined ? {} : { user: auth.user }),
    });

    // gate 3 — platform/policy (arch §8.2: platform ⇒ 403 E_SPAWN_DENIED, the rest ⇒ 503 E_LAUNCHER)
    const probePrincipal = spawnPrincipal(ownerOf(""));
    const policy = supervisor.policy(probePrincipal, io.listener, io.scheme, io.viaTrustedProxy);
    if (!policy.allowed) {
      const reason = policy.reason ?? "launcher";
      rejectAudit(io, auth, { endpoint: "spawn", code: reason === "platform" ? "E_SPAWN_DENIED" : "E_LAUNCHER" });
      if (reason === "platform") sendSpawnDenied(io, res, "platform", policy.detail);
      else sendLauncher(io, res, reason, policy.retryAfterS);
      return;
    }

    // gate 4 — body read (≤ SPAWN_BODY_MAX, under the write-endpoint body budget)
    const bodyMs = deriveBudget(reqDeadline.remaining(), BODY_CAP_MS, BODY_RESERVE_MS);
    if (bodyMs <= 0) {
      rejectAudit(io, auth, { endpoint: "spawn", code: "E_DEADLINE" });
      sendConnClosing(io, req, res, 408, "E_DEADLINE", "no budget left to read the request body");
      return;
    }
    let raw: unknown;
    try {
      raw = await io.readJson(req, SPAWN_BODY_MAX, bodyMs);
    } catch (err) {
      const status = statusOf(err);
      if (status === 413) {
        rejectAudit(io, auth, { endpoint: "spawn", code: "E_BAD_REQUEST" });
        sendConnClosing(io, req, res, 413, "E_BAD_REQUEST", "body too large");
      } else if (status === 408) {
        rejectAudit(io, auth, { endpoint: "spawn", code: "E_DEADLINE" });
        sendConnClosing(io, req, res, 408, "E_DEADLINE", "body read timeout");
      } else {
        rejectAudit(io, auth, { endpoint: "spawn", code: "E_BAD_REQUEST" });
        io.sendJson(res, 400, { error: "E_BAD_REQUEST", message: "request error" });
      }
      return;
    }

    // gate 5 — schema (parseSpawnRequestBody enforces the exact UTF-8 byte caps)
    const parsed = parseSpawnRequestBody(raw);
    if (!parsed.ok) {
      rejectAudit(io, auth, { endpoint: "spawn", code: "E_BAD_REQUEST" });
      const message =
        parsed.error === "cwd-too-long"
          ? "cwd too long"
          : parsed.error === "first-prompt-too-long"
            ? "first prompt too large"
            : "bad spawn request body";
      io.sendJson(res, 400, { error: "E_BAD_REQUEST", message });
      return;
    }
    const body = parsed.body;
    const intent: SpawnIntent = {
      id: body.id,
      cwd: body.cwd,
      confirmed: body.confirm === true,
      expectCwd: body.expectCwd,
      firstPrompt:
        body.firstPrompt === undefined
          ? undefined
          : {
              text: body.firstPrompt.text,
              // a brand-new session has no in-flight turn to steer — followUp is the default
              deliver: body.firstPrompt.deliver ?? "followUp",
            },
    };
    const principal = spawnPrincipal(ownerOf(intent.id));
    const idemKey = `${principal}|${intent.id}`;
    const digest = intentDigest(intent);

    // gate 6 — idempotency peek BEFORE the rate token (plan §SP9 "幂等命中不扣令牌"; the
    // repositioning vs arch §8.2's ladder is documented in the module comment)
    const dup = idemGet(idemKey);
    if (dup !== undefined) {
      if (dup.digest !== digest) {
        // same id, different intent — never a real dup (same rule as the cmd plane's digest check)
        rejectAudit(io, auth, { endpoint: "spawn", reqId: intent.id, code: "E_BAD_REQUEST" });
        io.sendJson(res, 409, { error: "E_BAD_REQUEST", message: "id reused with different intent" });
        return;
      }
      const rec = supervisor.records().find((r) => r.spawnId === dup.spawnId);
      if (rec !== undefined) {
        auditSpawn(log, {
          audit: "spawn",
          phase: "request",
          endpoint: "spawn",
          reqId: intent.id,
          listener: io.listener,
          ip: auth.ip,
          ...(auth.user === undefined ? {} : { user: auth.user }),
          spawnId: rec.spawnId,
          cwd: rec.cwd,
          dup: true,
        });
        const state = rec.state === "launching" ? "starting" : rec.state;
        io.sendJson(res, 202, {
          spawnId: rec.spawnId,
          state,
          cwd: rec.cwd,
          dup: true,
          ...(rec.firstPrompt === undefined ? {} : { firstPrompt: "accepted" }),
        });
        return;
      }
      // record gone (defensive — the in-memory map outlives every LRU entry): web-hub-delete-
      // session plan v2 §2.5 (r1 #3, B-fork) — a dup replay must NEVER fork fresh under the old
      // intent id once the record has been deleted (the LRU hit is the only thing that used to
      // make this distinguishable from a brand-new id; deletion breaks that assumption, so the
      // reject has to be explicit). Rejected before the creation-rate gate (gate 7): no token
      // spent, matching the dup-hit's own "幂等命中不扣令牌" rule.
      rejectAudit(io, auth, { endpoint: "spawn", reqId: intent.id, spawnId: dup.spawnId, code: "E_BAD_REQUEST" });
      io.sendJson(res, 409, { error: "E_BAD_REQUEST", reason: SPAWN_GONE_REASON });
      return;
    }

    // gate 7 — creation rate bucket (capacity ratePerMinute, refill 60s/ratePerMinute)
    const rateCapacity = Math.max(1, Math.min(60, cfg.ratePerMinute));
    const rate = limit.admit(`${principal}:spawn`, rateCapacity, Math.ceil(SPAWN_RATE_WINDOW_MS / rateCapacity));
    if (!rate.ok) {
      rateAudit(io, auth, `spawn:${principal}`, { endpoint: "spawn", reqId: intent.id, code: "E_RATE" });
      sendRateLimited(io, res, rate.retryAfterMs);
      return;
    }

    // gate 8 — admit (bounded: min(2s, remaining-3s), arch §4.5)
    const admitMs = deriveBudget(reqDeadline.remaining(), ADMIT_CAP_MS, ADMIT_RESERVE_MS);
    if (admitMs <= 0) {
      rejectAudit(io, auth, { endpoint: "spawn", reqId: intent.id, code: "E_DEADLINE" });
      io.sendError(res, 504, "E_DEADLINE");
      return;
    }
    const admitted = await dirs.admit(intent.cwd, policy.scope, createReqDeadline(now, admitMs));
    if (!admitted.ok) {
      rejectAudit(io, auth, { endpoint: "spawn", reqId: intent.id, code: "E_DIR" });
      io.sendJson(res, 400, { error: "E_DIR", reason: admitted.reason });
      return;
    }

    // gate 9 — confirmation (arch §6.3/D8: confirm binds expectCwd=realpath, stateless)
    const needConfirm = policy.confirm === "always" || (policy.confirm === "unknown-dir" && !admitted.known);
    const confirmBound = intent.confirmed && intent.expectCwd === admitted.realpath;
    if (needConfirm && !confirmBound) {
      // plan §SP9: "409 确认不写 LRU" — nothing idempotent happened yet
      rejectAudit(io, auth, {
        endpoint: "spawn",
        reqId: intent.id,
        cwd: admitted.realpath,
        known: admitted.known,
        confirmed: false,
        code: "E_CONFIRM_REQUIRED",
      });
      io.sendJson(res, 409, {
        error: "E_CONFIRM_REQUIRED",
        resolvedCwd: admitted.realpath,
        reason: intent.confirmed ? "changed" : policy.confirm,
      });
      return;
    }

    // gate 10 — second authorize (logout/rotate raced the body read; the sync stretch follows
    // immediately, so nothing can move between this check and the 202)
    const stillAuthed = await authorizeOrAudit(io, reqDeadline, "spawn", intent.id);
    if (stillAuthed === undefined) return;

    // gate 11 — supervisor.start(): limits + intent persist + fork, fully synchronous
    const spawnId = randomBytes(12).toString("base64url");
    const startReq: AdmittedRequest = {
      spawnId,
      admitted: { realpath: admitted.realpath, dev: admitted.dev, ino: admitted.ino, known: admitted.known },
      owner: ownerOf(intent.id),
      ...(intent.firstPrompt === undefined
        ? {}
        : {
            firstPrompt: {
              textLen: Buffer.byteLength(intent.firstPrompt.text, "utf8"),
              deliver: intent.firstPrompt.deliver,
            },
          }),
    };
    const result = supervisor.start(startReq, reqDeadline);
    if (!result.ok) {
      // map every reject to its own audit line (limits carry their own numbers)
      rejectAudit(io, stillAuthed, {
        endpoint: "spawn",
        reqId: intent.id,
        cwd: admitted.realpath,
        known: admitted.known,
        ...(needConfirm ? { confirmed: true } : {}),
        ...(result.code === "E_LIMIT"
          ? { limit: result.limit ?? "global", active: result.active, max: result.max }
          : {}),
        code: result.code,
      });
      sendStartResult(io, res, result);
      return;
    }

    // 202 — the record exists (①); hand the first-prompt BODY to the forwarder (memory only)
    if (intent.firstPrompt !== undefined) {
      firstPrompt.accept(
        spawnId,
        intent.firstPrompt,
        {
          listener: io.listener,
          ip: auth.ip,
          ...(auth.user === undefined ? {} : { user: auth.user }),
          reqId: intent.id,
        },
        now() + cfg.registerTimeoutS * 1000 + FIRST_PROMPT_GRACE_MS,
      );
    }
    idemPut(idemKey, spawnId, digest);
    auditSpawn(log, {
      audit: "spawn",
      phase: "request",
      endpoint: "spawn",
      reqId: intent.id,
      listener: io.listener,
      ip: auth.ip,
      ...(auth.user === undefined ? {} : { user: auth.user }),
      spawnId,
      cwd: admitted.realpath, // arch §6.6's sanctioned realpath exception (取证需要)
      known: admitted.known,
      confirmed: needConfirm ? true : false,
      ...(intent.firstPrompt === undefined
        ? {}
        : { firstPrompt: "pending", textLen: Buffer.byteLength(intent.firstPrompt.text, "utf8") }),
    });
    io.sendJson(res, 202, {
      spawnId,
      state: "starting",
      cwd: admitted.realpath,
      ...(intent.firstPrompt === undefined ? {} : { firstPrompt: "accepted" }),
    });
  }

  // ------------------------------------------------------------- POST /api/headless/:id/stop

  async function handleStop(
    req: IncomingMessage,
    res: ServerResponse,
    spawnId: string,
    io: SpawnRouteIo,
  ): Promise<void> {
    const reqDeadline = createReqDeadline(now, WRITE_TOTAL_MS);
    if (!io.strictCsrfOk()) {
      rejectAudit(io, { ip: io.ip }, { endpoint: "stop", code: "E_CSRF" });
      throw new io.HttpError(403, "E_CSRF");
    }
    const auth = await authorizeOrAudit(io, reqDeadline, "stop", spawnId);
    if (auth === undefined) return;
    const owner = { listener: io.listener, reqId: spawnId, ...(auth.user === undefined ? {} : { user: auth.user }) };
    const principal = spawnPrincipal(owner);
    const bucket = limit.admit(`${principal}:stop`, STOP_CAPACITY, STOP_REFILL_MS);
    if (!bucket.ok) {
      rateAudit(io, auth, `stop:${principal}`, { endpoint: "stop", spawnId, code: "E_RATE" });
      sendRateLimited(io, res, bucket.retryAfterMs);
      return;
    }
    // `{force?: true}` — empty body allowed
    const bodyMs = deriveBudget(reqDeadline.remaining(), BODY_CAP_MS, BODY_RESERVE_MS);
    let raw: unknown;
    if (bodyMs > 0) {
      try {
        raw = await io.readJson(req, STOP_BODY_MAX, bodyMs);
      } catch (err) {
        const status = statusOf(err);
        if (status === 413) {
          sendConnClosing(io, req, res, 413, "E_BAD_REQUEST", "body too large");
        } else if (status === 408) {
          sendConnClosing(io, req, res, 408, "E_DEADLINE", "body read timeout");
        } else {
          io.sendJson(res, 400, { error: "E_BAD_REQUEST", message: "request error" });
        }
        return;
      }
    }
    const force =
      raw !== null && typeof raw === "object" && !Array.isArray(raw) && "force" in raw && raw.force === true;
    // arch §6.0 (#8 user ruling): any authenticated principal may stop any managed session —
    // "同 hub 全信任"; there is deliberately NO owner check here.
    const stopped = supervisor.stop(spawnId, force);
    if (!stopped.ok) {
      rejectAudit(io, auth, { endpoint: "stop", spawnId, code: stopped.code });
      io.sendError(res, 404, "E_NOT_FOUND");
      return;
    }
    auditSpawn(log, {
      audit: "spawn",
      phase: "request",
      endpoint: "stop",
      reqId: spawnId,
      listener: io.listener,
      ip: auth.ip,
      ...(auth.user === undefined ? {} : { user: auth.user }),
      spawnId,
      state: stopped.state,
    });
    io.sendJson(res, 202, { state: stopped.state });
  }

  // ------------------------------------------------------------- surface

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
    query: URLSearchParams,
    io: SpawnRouteIo,
  ): Promise<void> {
    // LAN policy off: http.ts never dispatches here, but this guard keeps the route surface
    // byte-identical to "not enabled" even if wired by mistake (404 pre-auth, arch §8.2).
    if (io.listener === "lan" && cfg.lan === "off") {
      io.sendError(res, 404, "E_NOT_FOUND");
      return;
    }
    if (path === "/api/headless") {
      if (method === "GET") return handleList(req, res, io);
      if (method === "POST") return handleSpawn(req, res, io);
      io.sendError(res, 404, "E_NOT_FOUND"); // DELETE 等遗留方法：保持未启用时的 404 落穿
      return;
    }
    if (path === "/api/headless/dirs") {
      if (method === "GET") return handleDirs(req, res, query, io);
      io.sendError(res, 404, "E_NOT_FOUND");
      return;
    }
    const stopId = method === "POST" ? matchStopPath(path) : undefined;
    if (stopId !== undefined) return handleStop(req, res, stopId, io);
    io.sendError(res, 404, "E_NOT_FOUND");
  }

  function publicPayload(listener: "loopback" | "lan"): ReturnType<SpawnFrontendPort["publicPayload"]> {
    if (listener === "lan" && cfg.lan === "off") return undefined; // SSE face: byte-identical to off
    return toPublicPayload(supervisor.records(), cfg.maxProcesses, (id) => firstPrompt.state(id));
  }

  return { handle, publicPayload };
}
