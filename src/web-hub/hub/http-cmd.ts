/**
 * hub HTTP P2 control plane (plan §6.2/§6.3/§3.3, C3): the shared write-endpoint
 * pipeline behind `POST /api/cmd` and `POST /api/dialog` on BOTH listeners —
 * body parsing/validation (`parseCmdBody`/`parseDialogBody`), the per-category
 * rate-limit vocabulary and `dispatchCmdOrDialog` itself. Split out of
 * `http.ts` (source-governance batch-2 ⑨-H2) as a pure extraction: every
 * helper and constant moved here is used exclusively by this pipeline; the
 * shared low-level HTTP helpers (`HttpError`, `sendJson`, `readJson`, …) stay
 * in `http.ts` and are imported back.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CmdArgs,
  CmdErrorCode,
  CmdExpect,
  CmdFrame,
  CmdOrigin,
  CmdResultFrame,
  DialogAnswerWire,
} from "../protocol/messages.js";
import { auditControl, auditUpload } from "./audit.js";
import type { CmdLimit } from "./cmd-limit.js";
import { field, HttpError, MAX_BODY_BYTES, readJson, sendError, sendJson, stringField } from "./http.js";
import type { CommandRouter, HubLog, RegistryView } from "./ports.js";
import {
  BODY_CAP_MS,
  BODY_RESERVE_MS,
  computeAgentBudgets,
  createReqDeadline,
  deriveBudget,
  FORWARD_MIN_REMAINING_MS,
  WRITE_TOTAL_MS,
  type ReqDeadline,
} from "./req-deadline.js";
import { HubError } from "./registry.js";
import type { PinToken, UploadStore } from "./uploads.js";

// ---------------------------------------------------------------------------
// P2 control plane: POST /api/cmd, POST /api/dialog (plan §6.2/§6.3/§3.3, C3)
// ---------------------------------------------------------------------------

const CMD_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const COMMAND_NAME_RE = /^[A-Za-z0-9:_.-]{1,64}$/;
const PROMPT_TEXT_MAX_BYTES = 48 * 1024;
const STEER_TEXT_MAX_BYTES = 16 * 1024;
const OTHER_TEXT_MAX_BYTES = 4 * 1024;
const COMMAND_ARGS_MAX_BYTES = 16 * 1024;
/** §6.5 "hub 在途命令总数 ≤ 32". */
const HUB_INFLIGHT_CAP = 32;

function byteLenOk(s: string, max: number): boolean {
  return Buffer.byteLength(s, "utf8") <= max;
}

interface ParsedCmdRequest {
  agentKey: string;
  id: string;
  queryOnly?: true;
  cmd: CmdArgs;
}
type ParseOutcome = ParsedCmdRequest | { error: string; message: string };

function parseExpect(body: unknown): CmdExpect | undefined {
  const e = field(body, "expect");
  if (e === undefined || e === null) return undefined;
  const sid = field(e, "sessionId");
  return typeof sid === "string" && sid.length > 0 ? { sessionId: sid } : undefined;
}

/** Exported for tests only (2026-10-28 `archive_omitted`): the op switch is the single place
 *  that decides which body fields survive onto the wire frame, so its closed-shape guarantees
 *  are worth pinning directly instead of through a full HTTP round-trip. */
export function parseCmdBody(body: unknown): ParseOutcome {
  const agentKey = stringField(body, "agentKey");
  const id = stringField(body, "id");
  if (agentKey === undefined) return { error: "E_BAD_REQUEST", message: "agentKey required" };
  if (id === undefined || !CMD_ID_RE.test(id)) return { error: "E_BAD_REQUEST", message: "bad id" };
  const queryOnlyFlag = field(body, "queryOnly") === true;
  const op = field(body, "op");
  const expect = parseExpect(body);
  if (typeof op !== "string") return { error: "E_BAD_REQUEST", message: "op required" };
  switch (op) {
    case "prompt": {
      const text = field(body, "text");
      const deliver = field(body, "deliver");
      if (typeof text !== "string" || text.trim().length === 0 || !byteLenOk(text, PROMPT_TEXT_MAX_BYTES)) {
        return { error: "E_BAD_REQUEST", message: "text required" };
      }
      if (deliver !== "steer" && deliver !== "followUp") return { error: "E_BAD_REQUEST", message: "deliver required" };
      return {
        agentKey,
        id,
        ...(queryOnlyFlag ? { queryOnly: true as const } : {}),
        cmd: { op: "prompt", text, deliver, ...(expect === undefined ? {} : { expect }) },
      };
    }
    case "abort":
      return {
        agentKey,
        id,
        ...(queryOnlyFlag ? { queryOnly: true as const } : {}),
        cmd: { op: "abort", ...(expect === undefined ? {} : { expect }) },
      };
    case "steer_subagent": {
      const runId = field(body, "runId");
      const text = field(body, "text");
      if (typeof runId !== "string" || runId.length === 0) return { error: "E_BAD_REQUEST", message: "runId required" };
      if (typeof text !== "string" || !byteLenOk(text, STEER_TEXT_MAX_BYTES)) {
        return { error: "E_BAD_REQUEST", message: "text required" };
      }
      return {
        agentKey,
        id,
        ...(queryOnlyFlag ? { queryOnly: true as const } : {}),
        cmd: { op: "steer_subagent", runId, text },
      };
    }
    case "abort_subagent": {
      const runId = field(body, "runId");
      if (typeof runId !== "string" || runId.length === 0) return { error: "E_BAD_REQUEST", message: "runId required" };
      return {
        agentKey,
        id,
        ...(queryOnlyFlag ? { queryOnly: true as const } : {}),
        cmd: { op: "abort_subagent", runId },
      };
    }
    case "command": {
      const name = field(body, "name");
      const argsRaw = field(body, "args");
      if (typeof name !== "string" || !COMMAND_NAME_RE.test(name))
        return { error: "E_BAD_REQUEST", message: "bad name" };
      const args = typeof argsRaw === "string" ? argsRaw : "";
      if (!byteLenOk(args, COMMAND_ARGS_MAX_BYTES)) return { error: "E_BAD_REQUEST", message: "args too large" };
      const confirm = field(body, "confirm") === true;
      const deliverRaw = field(body, "deliver");
      const deliver = deliverRaw === "steer" || deliverRaw === "followUp" ? deliverRaw : undefined;
      return {
        agentKey,
        id,
        ...(queryOnlyFlag ? { queryOnly: true as const } : {}),
        cmd: {
          op: "command",
          name,
          args,
          ...(confirm ? { confirm: true as const } : {}),
          ...(deliver === undefined ? {} : { deliver }),
          ...(expect === undefined ? {} : { expect }),
        },
      };
    }
    case "archive": {
      // web-hub archive plan (docs/dev/web-hub/archive-report.md): the fleet drawer's manual
      // archive/unarchive. The TARGET id rides `target` (the body's `id` is the cmdId, the
      // recall precedent); identify-only — exactly {kind, target, set}. LAN rides the SAME
      // /api/cmd authorization as every other op.
      const kind = field(body, "kind");
      const target = field(body, "target");
      const set = field(body, "set");
      if (kind !== "run" && kind !== "bash") return { error: "E_BAD_REQUEST", message: "bad kind" };
      if (typeof target !== "string" || target.length === 0 || target.length > 128)
        return { error: "E_BAD_REQUEST", message: "bad target" };
      if (set !== "archive" && set !== "unarchive") return { error: "E_BAD_REQUEST", message: "bad set" };
      return {
        agentKey,
        id,
        ...(queryOnlyFlag ? { queryOnly: true as const } : {}),
        cmd: { op: "archive", kind, id: target, set },
      };
    }
    case "archive_omitted": {
      // 2026-10-28 user request (fleet bash 「(+N more)」 either shows or archives): the bulk
      // archive of the OMITTED tail. Kind-only — the agent derives the id set from its own live
      // bash-jobs snapshot, so nothing id-shaped rides the wire and a stale browser view cannot
      // over-reach. Same /api/cmd authorization as every other op.
      const kind = field(body, "kind");
      if (kind !== "bash") return { error: "E_BAD_REQUEST", message: "bad kind" };
      return {
        agentKey,
        id,
        ...(queryOnlyFlag ? { queryOnly: true as const } : {}),
        cmd: { op: "archive_omitted", kind: "bash" },
      };
    }
    case "recall": {
      // steer-recall plan §2.3 S4: recall identifies by cmdId only — `target` must pass CMD_ID_RE
      // (400 "target required" otherwise) and the forwarded frame carries EXACTLY
      // {op:"recall", target}: every other body field (expect, junk, …) is dropped here.
      const target = field(body, "target");
      if (typeof target !== "string" || !CMD_ID_RE.test(target)) {
        return { error: "E_BAD_REQUEST", message: "target required" };
      }
      return {
        agentKey,
        id,
        ...(queryOnlyFlag ? { queryOnly: true as const } : {}),
        cmd: { op: "recall", target },
      };
    }
    default:
      return { error: "E_BAD_REQUEST", message: "unknown op" };
  }
}

function parseDialogBody(body: unknown): ParseOutcome {
  const agentKey = stringField(body, "agentKey");
  const id = stringField(body, "id");
  const dialogId = stringField(body, "dialogId");
  const epoch = stringField(body, "epoch");
  const action = field(body, "action");
  if (agentKey === undefined) return { error: "E_BAD_REQUEST", message: "agentKey required" };
  if (id === undefined || !CMD_ID_RE.test(id)) return { error: "E_BAD_REQUEST", message: "bad id" };
  if (dialogId === undefined || epoch === undefined)
    return { error: "E_BAD_REQUEST", message: "dialogId/epoch required" };
  const queryOnlyFlag = field(body, "queryOnly") === true;
  if (action === "cancel") {
    return {
      agentKey,
      id,
      ...(queryOnlyFlag ? { queryOnly: true as const } : {}),
      cmd: { op: "dialog_cancel", dialogId, epoch },
    };
  }
  if (action === "answer") {
    const answersRaw = field(body, "answers");
    if (!Array.isArray(answersRaw)) return { error: "E_BAD_REQUEST", message: "answers required" };
    const answers: DialogAnswerWire[] = [];
    for (const a of answersRaw as unknown[]) {
      const selectedRaw = field(a, "selected");
      const otherRaw = field(a, "other");
      if (!Array.isArray(selectedRaw) || !selectedRaw.every((s) => typeof s === "string")) {
        return { error: "E_BAD_REQUEST", message: "bad answer" };
      }
      if (otherRaw !== null && otherRaw !== undefined && typeof otherRaw !== "string") {
        return { error: "E_BAD_REQUEST", message: "bad answer" };
      }
      if (typeof otherRaw === "string" && !byteLenOk(otherRaw, OTHER_TEXT_MAX_BYTES)) {
        return { error: "E_BAD_REQUEST", message: "other too large" };
      }
      // Per-question skip (DialogAnswerWire.skipped, d18bdcdc): must survive the rebuild — the
      // agent's validator (agent/dialogs.ts) owns the skip/answer exclusivity rule.
      const skippedRaw = field(a, "skipped");
      if (skippedRaw !== undefined && typeof skippedRaw !== "boolean") {
        return { error: "E_BAD_REQUEST", message: "bad answer" };
      }
      answers.push({
        selected: selectedRaw as string[],
        other: typeof otherRaw === "string" ? otherRaw : null,
        ...(skippedRaw === true ? { skipped: true } : {}),
      });
    }
    return {
      agentKey,
      id,
      ...(queryOnlyFlag ? { queryOnly: true as const } : {}),
      cmd: { op: "dialog_answer", dialogId, epoch, answers },
    };
  }
  return { error: "E_BAD_REQUEST", message: "action required" };
}

interface LimitCategory {
  name: string;
  capacity: number;
  refillMs: number;
}

/** §6.5's per-op-category buckets; `queryOnly` always uses the generous "query" bucket
 * regardless of the wrapped op. */
function limitCategoryFor(cmd: CmdArgs, queryOnly: boolean): LimitCategory {
  if (queryOnly) return { name: "query", capacity: 20, refillMs: 1_000 };
  switch (cmd.op) {
    case "abort":
    case "abort_subagent":
      return { name: "stop", capacity: 10, refillMs: 2_000 };
    case "dialog_answer":
    case "dialog_cancel":
      return { name: "dialog", capacity: 6, refillMs: 3_000 };
    default:
      return { name: "cmd", capacity: 10, refillMs: 3_000 };
  }
}

function cmdErrorStatus(code: CmdErrorCode): number {
  switch (code) {
    case "E_BAD_REQUEST":
    case "E_BAD_ANSWER":
      return 400;
    case "E_NOT_FOUND":
    case "E_UNKNOWN_COMMAND":
    case "E_UNKNOWN_ID":
      return 404;
    case "E_UNSUPPORTED":
    case "E_DIALOG_CLOSED":
    case "E_NOT_RUNNING":
    case "E_SESSION_CHANGED":
    case "E_COMMAND_DENIED":
    case "E_CONFIRM_REQUIRED":
    case "E_STALE_CTX":
    case "E_BUSY_COMPACTING":
    case "E_BUSY_STEER":
      return 409;
    case "E_SUBAGENT_REJECTED":
      return 422;
    case "E_DEADLINE":
      return 504;
    case "E_HUB_RESTARTING":
      return 503;
    default:
      return 500;
  }
}

function sendCmdResult(res: ServerResponse, reply: CmdResultFrame): void {
  if (reply.ok) {
    sendJson(res, 200, { ok: true, id: reply.id, ...(reply.dup === true ? { dup: true } : {}), data: reply.data });
    return;
  }
  const status = cmdErrorStatus(reply.code);
  sendJson(res, status, {
    error: reply.code,
    id: reply.id,
    retryable: reply.retryable,
    effect: reply.effect,
    ...(reply.message === undefined ? {} : { message: reply.message }),
  });
}

interface CmdAuthResult {
  ip: string;
  user?: string;
}

interface CmdAuthHandled {
  handled: true;
  /** C3 P1 fix (plan §6.4): the error code `authorize()` already sent to the client (401
   * `E_AUTH` / 429 `E_RATE` / 503 `E_DB`), mirrored back purely so `dispatchCmdOrDialog` can write
   * its own reject-phase audit line — `authorize()` still owns sending the actual response. */
  code: string;
}

/** Shared write-endpoint pipeline for both listeners (§6.3): request-scoped deadline + reqId →
 * strict CSRF → auth → a coarse per-principal flood guard + the hub-wide in-flight cap → the
 * write-endpoint body-read budget (§3.3 step ④) → body parsing/validation → the §6.5
 * per-category/per-agent/per-IP buckets (skipped, C3 P1 fix, on an idempotent-hit — §6.5 "幂等
 * 命中不扣令牌") → the §3.3 step ⑤ forward-or-refuse threshold → a `stillAuthorized`
 * recheck (§6.3 step ⑥). C8 §6.7.1 note: the plan's §6.3 row 3/7 "记下 authGen" / "转发前复核
 * authGen/lanRevokeGen" is satisfied WITHOUT a separate generation-number compare — the rotate-
 * token flow (`admin.ts`'s `Auth.rotateToken()` clearing the loopback session Map,
 * `LanStore.revokeAllSessions()` deleting every LAN session row) makes this exact second
 * `authorize()` call fail on its own once a rotation has landed: loopback's `auth.check()`
 * re-reads the (now-empty) session Map, LAN's `requireLanSession()` re-touches the (now-deleted)
 * session row. Both listeners' `authorize()` closures are the very same functions used for the
 * first check, so a rotation landing between the two calls is caught with zero extra plumbing —
 * `Auth.authGen()` exists (`auth.ts`) for audit/diagnostics only, not as a load-bearing gate →
 * `commands.request()`.
 *
 * C3 P1 fix (plan §3.3 D16): the `ReqDeadline` is created at the very top, before CSRF/auth, so
 * it covers the *entire* pipeline including LAN auth's own `touchSession` wait (`authorize`'s LAN
 * closure races it against a budget derived from `deadline.remaining()`) — previously it was only
 * created after `authorize()` had already resolved, so a slow/hung auth step silently ate into (or
 * exceeded) the nominal 13s budget with no accounting for it at all.
 *
 * C3 P1 fix (plan §6.4): every reject before a `CmdFrame` is ever built (CSRF/auth/rate-limit)
 * now writes its own `phase:"reject"` audit line (previously only the deadline-derived rejects
 * did) — 401/CSRF omit `user` (not yet authenticated); 429s are throttled to at most one audit
 * line per throttle key per `RATE_AUDIT_WINDOW_MS` (`opts.rejectAudit429`) since the token bucket
 * itself keeps admitting/rejecting far more often than that.
 *
 * `authorize()` mirrors `requireLanSession`'s own contract: on failure it sends its own error
 * response and returns `{ handled: true, code }`; this function returns immediately without doing
 * anything else once that happens (after writing its own audit line). */
const RATE_AUDIT_WINDOW_MS = 60_000;
/** web-hub-upload plan §2.6 (v3 #8): post-forward bounded persistence wait for `referencedAt`
 * — `min(REF_FLUSH_CAP_MS, reqDeadline.remaining() - REF_FLUSH_RESERVE_MS)`, skipped when ≤ 0. */
const REF_FLUSH_CAP_MS = 1_000;
const REF_FLUSH_RESERVE_MS = 300;

export async function dispatchCmdOrDialog(
  req: IncomingMessage,
  res: ServerResponse,
  path: "/api/cmd" | "/api/dialog",
  opts: {
    listener: "loopback" | "lan";
    /** Known synchronously before `authorize()` ever runs (LAN: `ctx.clientIp`; loopback:
     * `normalizePeerIp(req.socket.remoteAddress)`) — needed for the CSRF-reject audit line, which
     * fires before authentication. */
    ip: string;
    strictCsrfOk: () => boolean;
    authorize: (deadline: ReqDeadline) => Promise<CmdAuthResult | CmdAuthHandled>;
    registry: RegistryView;
    commands: CommandRouter | undefined;
    limit: CmdLimit;
    /** C3 P1 fix (plan §6.4): shared across both listeners (same instance as `opts.limit`'s
     * caller passes) so a 429 audit line for a given throttle key is written at most once per
     * `RATE_AUDIT_WINDOW_MS`, independent of how many times the underlying token bucket itself
     * re-rejects in that window. */
    rejectAudit429: Map<string, number>;
    /** web-hub-upload plan §2.6 (v3 #8, U3): the upload store for reference pinning of
     * prompt/steer texts. Undefined ⇒ prompts dispatch exactly as before (no pinning). */
    uploads?: UploadStore | undefined;
    log: HubLog;
    now: () => number;
  },
): Promise<void> {
  const { listener, commands, limit, log, now } = opts;
  res.setHeader("Cache-Control", "no-store");

  const reqDeadline = createReqDeadline(now, WRITE_TOTAL_MS);
  const reqId = randomBytes(8).toString("hex");
  const endpoint: "cmd" | "dialog" = path === "/api/cmd" ? "cmd" : "dialog";

  const auditReject = (fields: { ip?: string; user?: string; code: string; agentKey?: string; op?: string }): void => {
    auditControl(log, {
      phase: "reject",
      reqId,
      endpoint,
      listener,
      ok: false,
      ...fields,
    });
  };
  const auditRateLimited = (throttleKey: string, fields: { ip?: string; user?: string; agentKey?: string }): void => {
    const t = now();
    const last = opts.rejectAudit429.get(throttleKey);
    if (last !== undefined && t - last < RATE_AUDIT_WINDOW_MS) return;
    opts.rejectAudit429.set(throttleKey, t);
    auditReject({ code: "E_RATE", ...fields });
  };

  if (!opts.strictCsrfOk()) {
    auditReject({ ip: opts.ip, code: "E_CSRF" });
    throw new HttpError(403, "E_CSRF");
  }

  const authed = await opts.authorize(reqDeadline);
  if ("handled" in authed) {
    auditReject({ ip: opts.ip, code: authed.code });
    return;
  }
  const { ip, user } = authed;

  if (commands === undefined) throw new HttpError(501, "E_NOT_IMPLEMENTED");

  const principalKey = `${listener}:${user ?? "token"}`;

  const pre = limit.admit(`${principalKey}:pre`, 30, 1_000);
  if (!pre.ok) {
    res.setHeader("Retry-After", String(Math.ceil(pre.retryAfterMs / 1000)));
    auditRateLimited(`pre:${principalKey}`, { ip, ...(user === undefined ? {} : { user }) });
    sendError(res, 429, "E_RATE");
    return;
  }
  if (commands.inflight() >= HUB_INFLIGHT_CAP) {
    auditRateLimited("inflight:hub", { ip, ...(user === undefined ? {} : { user }) });
    sendError(res, 429, "E_RATE");
    return;
  }

  const bodyMs = deriveBudget(reqDeadline.remaining(), BODY_CAP_MS, BODY_RESERVE_MS);
  if (bodyMs <= 0) {
    auditReject({ ip, ...(user === undefined ? {} : { user }), code: "E_DEADLINE" });
    throw new HttpError(408, "E_DEADLINE", "no budget left to read the request body");
  }
  const body = await readJson(req, MAX_BODY_BYTES, bodyMs);

  const parsed = path === "/api/cmd" ? parseCmdBody(body) : parseDialogBody(body);
  if ("error" in parsed) throw new HttpError(400, parsed.error, parsed.message);
  const { agentKey, id, queryOnly, cmd } = parsed;

  // C3 re-review fix (Blocker #1, plan §3.3/§6.3 step ⑥⑦): a cheap, early bail-out on the
  // pre-reauth budget — avoids spending a possibly-slow LAN `touchSession` round trip (step ⑦
  // below) when the request is already doomed. This is *not* the authoritative check: that one
  // runs again below, against the budget actually left once step ⑦ returns.
  if (reqDeadline.remaining() < FORWARD_MIN_REMAINING_MS) {
    auditReject({ ip, ...(user === undefined ? {} : { user }), agentKey, op: cmd.op, code: "E_DEADLINE" });
    throw new HttpError(504, "E_DEADLINE");
  }

  // §6.3 step ⑦ ("stillAuthorized 钩子"): re-run the same authorization right before the frame
  // is ever sent, catching a logout/rotation that raced the body read above. This is the last
  // `await` before the dispatch decision below — everything from here to `commands.request()` is
  // synchronous, on purpose (Blocker #2 fix, see the peek comment below).
  const stillAuthed = await opts.authorize(reqDeadline);
  if ("handled" in stillAuthed) {
    auditReject({ ip, ...(user === undefined ? {} : { user }), agentKey, op: cmd.op, code: stillAuthed.code });
    return;
  }

  // C3 re-review fix (Blocker #1): `remaining` — and everything derived from it below — MUST be
  // read *after* the reauth above returns, not before it. A slow/hung LAN `touchSession` can burn
  // several seconds of the request-level `ReqDeadline` inside `opts.authorize()`; computing
  // `remaining` before that call (the previous bug) fed `computeAgentBudgets()` a budget that no
  // longer reflected reality and could let the agent-facing frame's own deadline (plus the
  // registry wait built on top of it) push the whole request past its 13s `WRITE_TOTAL_MS` cap.
  const remaining = reqDeadline.remaining();
  if (remaining < FORWARD_MIN_REMAINING_MS) {
    auditReject({ ip, ...(user === undefined ? {} : { user }), agentKey, op: cmd.op, code: "E_DEADLINE" });
    throw new HttpError(504, "E_DEADLINE");
  }

  // C3 re-review fix (Blocker #2, plan §3.4/§6.3): the idempotency peek — used only to decide
  // whether the per-category/per-IP/per-agent buckets below get charged a token — is deliberately
  // placed *here*, immediately after the last `await` above and with nothing but synchronous code
  // between it and the `commands.request()` call further down. `peekIdempotent` itself now also
  // compares the cached entry's payload digest (`cmd`) before reporting a hit, so a same-`id`-
  // different-payload replay (which `request()` will reject with `E_BAD_REQUEST` regardless) can
  // never masquerade as a dup and skip rate limiting. Keeping this adjacent to the actual forward
  // call (no intervening `await`) also closes the TOCTOU window a re-reviewer flagged: nothing
  // else in this process gets a chance to mutate/evict the hub's in-memory LRU entry between the
  // peek and the router's own (authoritative) re-check of the exact same key.
  const originForPeek: CmdOrigin = { listener, ip, reqId, ...(user === undefined ? {} : { user }) };
  const dup = commands.peekIdempotent?.(originForPeek, agentKey, id, cmd) !== undefined;

  if (!dup) {
    const cat = limitCategoryFor(cmd, queryOnly === true);
    const fine = limit.admit(`${principalKey}:${cat.name}`, cat.capacity, cat.refillMs);
    if (!fine.ok) {
      res.setHeader("Retry-After", String(Math.ceil(fine.retryAfterMs / 1000)));
      auditRateLimited(`fine:${principalKey}:${cat.name}`, { ip, ...(user === undefined ? {} : { user }), agentKey });
      sendError(res, 429, "E_RATE");
      return;
    }
    if (listener === "lan") {
      const perIp = limit.admit(`lan-ip:${ip}`, 20, 2_000);
      if (!perIp.ok) {
        res.setHeader("Retry-After", String(Math.ceil(perIp.retryAfterMs / 1000)));
        auditRateLimited(`lan-ip:${ip}`, { ip, ...(user === undefined ? {} : { user }), agentKey });
        sendError(res, 429, "E_RATE");
        return;
      }
    }
    const perAgent = limit.admit(`agent:${agentKey}`, 30, 1_000);
    if (!perAgent.ok) {
      res.setHeader("Retry-After", String(Math.ceil(perAgent.retryAfterMs / 1000)));
      auditRateLimited(`agent:${agentKey}`, { ip, ...(user === undefined ? {} : { user }), agentKey });
      sendError(res, 429, "E_RATE");
      return;
    }
  }

  const { agentDeadlineMs } = computeAgentBudgets(remaining);
  const origin: CmdOrigin = { listener, ip, reqId, ...(user === undefined ? {} : { user }) };
  const frame: CmdFrame = {
    t: "cmd",
    rid: "",
    id,
    deadlineMs: agentDeadlineMs,
    origin,
    ...(queryOnly === true ? { queryOnly: true as const } : {}),
    cmd,
  };

  // web-hub-upload plan §2.6 (v3 #8, U3 hard gate): pin the prompt's referenced attachments
  // SYNCHRONOUSLY in this no-await region, before the frame is ever forwarded — so no sweep can
  // evict them out from under an in-flight prompt. Only fresh (non-dup, non-queryOnly)
  // prompt/steer_subagent/command ops carry attachment blocks (command + attachment allowed
  // since the 2026-10-12 ruling: the block rides inside the command ARGS, same as TUI
  // free-text args). A pin failure means a referenced file is
  // already gone/evicting: refuse WITHOUT forwarding (effect "none"), telling the frontend which
  // upload ids died so it can ask for a re-upload. Unknown/other-principals' paths are ignored by
  // the store (no existence leak).
  let pinToken: PinToken | undefined;
  if (
    opts.uploads !== undefined &&
    !dup &&
    queryOnly !== true &&
    (cmd.op === "prompt" || cmd.op === "steer_subagent" || cmd.op === "command")
  ) {
    const pin = opts.uploads.pinForPrompt({
      principal: principalKey,
      text: cmd.op === "command" ? cmd.args : cmd.text,
    });
    if (!pin.ok) {
      auditReject({ ip, ...(user === undefined ? {} : { user }), agentKey, op: cmd.op, code: "E_UPLOAD_GONE" });
      auditUpload(log, {
        phase: "reject",
        op: "reference",
        ok: false,
        code: "E_UPLOAD_GONE",
        reqId,
        listener,
        ip,
        ...(user === undefined ? {} : { user }),
        agentKey,
        uploadId: pin.gone[0],
      });
      sendJson(res, 409, {
        error: "E_UPLOAD_GONE",
        id,
        uploadIds: [...pin.gone],
        retryable: false,
        effect: "none",
      });
      return;
    }
    if (pin.token.ids.length > 0) pinToken = pin.token;
  }

  // §2.6 (v3 #8): settle pins SYNCHRONOUSLY the moment the forward settles (conservative
  // "possibly delivered" classification: any throw — E_AGENT_GONE/E_DEADLINE/E_INTERNAL — or a
  // reply with ok:true / effect:"unknown" counts as referenced; only effect:"none" releases),
  // then a bounded best-effort meta.json flush (≤ min(1s, remaining-300ms)) before the reply goes
  // out. A flush timeout/failure never changes the reply — the prompt is already delivered; the
  // entry stays metaDirty and is retried by the 60s tick / every sweep.
  let outcome: { reply: CmdResultFrame } | { err: unknown };
  try {
    outcome = { reply: await commands.request(frame, agentKey) };
  } catch (err) {
    outcome = { err };
  }
  if (pinToken !== undefined) {
    const uploads = opts.uploads!;
    const referenced = "err" in outcome || outcome.reply.ok === true || outcome.reply.effect === "unknown";
    uploads.settlePins(pinToken, referenced ? "referenced" : "released");
    if (referenced) {
      const flushMs = Math.min(REF_FLUSH_CAP_MS, reqDeadline.remaining() - REF_FLUSH_RESERVE_MS);
      if (flushMs > 0) {
        let flushed: "ok" | "timeout" | "error";
        try {
          flushed = await uploads.flushReferences(pinToken.ids, { at: now() + flushMs });
        } catch {
          flushed = "error";
        }
        if (flushed !== "ok") {
          auditUpload(log, {
            phase: "request",
            op: "reference",
            ok: false,
            code: flushed === "timeout" ? "E_DEADLINE" : "E_INTERNAL",
            reqId,
            listener,
            ip,
            ...(user === undefined ? {} : { user }),
            agentKey,
          });
        }
      }
    }
  }

  if ("err" in outcome) {
    const err = outcome.err;
    if (err instanceof HubError && err.code === "E_AGENT_GONE") {
      const stillKnown = opts.registry.get(agentKey) !== undefined;
      sendJson(res, 503, { error: "E_AGENT_GONE", retryable: stillKnown, effect: "unknown" });
      return;
    }
    if (err instanceof HubError && err.code === "E_DEADLINE") {
      sendJson(res, 504, { error: "E_DEADLINE", retryable: true, effect: "unknown" });
      return;
    }
    log.error("web-hub http: cmd dispatch failed", { error: String(err) });
    sendJson(res, 500, { error: "E_INTERNAL" });
    return;
  }
  sendCmdResult(res, outcome.reply);
}
