/**
 * Feishu bot F5 / plan §5.7: transport-neutral, non-session managed creation.
 * HTTP owns CSRF, auth #1, policy and body/schema parsing; this entry owns dedup → rate →
 * bounded directory admission → realpath-bound confirmation → auth #2 → synchronous start,
 * first-prompt handoff and idempotency commit. No assembly, HTTP objects or module state.
 */
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname } from "node:path";
import type { CmdOrigin } from "../../protocol/messages.js";
import {
  FIRST_PROMPT_GRACE_MS,
  SPAWN_GONE_REASON,
  type SpawnAccepted,
  type SpawnPolicyWire,
  type SpawnState,
} from "../../protocol/spawn.js";
import type { CmdLimit } from "../cmd-limit.js";
import { createReqDeadline, deriveBudget, type ReqDeadline } from "../req-deadline.js";
import type { DirService } from "./dirs.js";
import type { FirstPromptForwarder } from "./first-prompt.js";
import type { SpawnPrefs } from "./prefs.js";
import type { StoredOwner } from "./store.js";
import type { AdmittedRequest, SpawnAuditRecord, SpawnSupervisor, StartResult } from "./supervisor.js";

/** Caller-lifecycle LRU, never per request. HTTP shares it with the session branch. */
export const SPAWN_IDEMPOTENCY_MAX = 256;
export const SPAWN_IDEMPOTENCY_TTL_MS = 600_000;
const ADMIT_CAP_MS = 2_000;
const ADMIT_RESERVE_MS = 3_000;

interface IdemEntry {
  spawnId: string;
  digest: string;
  at: number;
}
export interface SpawnIdempotency {
  get(key: string): IdemEntry | undefined;
  put(key: string, spawnId: string, digest: string): void;
}

export function createSpawnIdempotency(now: () => number): SpawnIdempotency {
  const entries = new Map<string, IdemEntry>();
  return {
    get(key) {
      const hit = entries.get(key);
      if (hit === undefined) return undefined;
      if (now() - hit.at > SPAWN_IDEMPOTENCY_TTL_MS) {
        entries.delete(key);
        return undefined;
      }
      return hit;
    },
    put(key, spawnId, digest) {
      entries.delete(key);
      entries.set(key, { spawnId, digest, at: now() });
      while (entries.size > SPAWN_IDEMPOTENCY_MAX) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
  };
}

/** The parsed intent everything downstream (LRU digest, admit, start) is built from. */
export interface SpawnIntent {
  id: string;
  cwd: string;
  confirmed: boolean;
  expectCwd: string | undefined;
  /** default-model plan §3 ①: the request's tri-state, verbatim — `undefined` (absent) vs `""`
   *  (explicit pi default) vs a parsed `provider/id` are THREE different intents. */
  model: string | undefined;
  /** session-history plan §3.3/§4.6.2: present iff the body carried a `session` ref (only ever
   *  parsed when `historyOn`); `mode` is normalized here — absent ⇒ `"resume"` (the hub decides
   *  whether occupancy forces a fork via the 409 `session-open` round-trip, PD10'). */
  session: { key: string; id: string; mode: "resume" | "fork" } | undefined;
  firstPrompt: { text: string; deliver: "steer" | "followUp" } | undefined;
}

/** sha256 over a canonical (fixed-key-order) rendering of the intent. `confirm`/`expectCwd`
 *  are excluded (plan §SP9: "只多 confirm 视为同一意图"); `model` joins ONLY when present
 *  (default-model plan §3 ①) — a request without it hashes byte-identically to pre-feature,
 *  so old digests (and their LRU entries) keep hitting across a hub upgrade. `session` joins
 *  ONLY when present (session-history plan §4.6.6: different key/id/mode ⇒ a different digest
 *  — a request without `session` hashes byte-identically to pre-feature too). */
export function intentDigest(intent: SpawnIntent): string {
  const parts: string[] = [`"cwd":${JSON.stringify(intent.cwd)}`];
  if (intent.model !== undefined) parts.push(`"model":${JSON.stringify(intent.model)}`);
  if (intent.session !== undefined) {
    const s = intent.session;
    parts.push(
      `"session":{"key":${JSON.stringify(s.key)},"id":${JSON.stringify(s.id)},"mode":${JSON.stringify(s.mode)}}`,
    );
  }
  const fp = intent.firstPrompt;
  if (fp !== undefined) {
    parts.push(`"firstPrompt":{"deliver":${JSON.stringify(fp.deliver)},"text":${JSON.stringify(fp.text)}}`);
  }
  return createHash("sha256")
    .update(`{${parts.join(",")}}`)
    .digest("hex");
}

/** Already parsed/validated. A session-backed intent belongs to the history route, never here. */
export type FreshSpawnIntent = Omit<SpawnIntent, "session"> & { session?: never };
type StartFailure = Extract<StartResult, { ok: false }>;
export type FreshSpawnOutcome =
  | {
      kind: "accepted";
      value: Omit<SpawnAccepted, "state"> & { state: SpawnState };
      agentKey?: string;
      sessionId?: string;
    }
  | { kind: "confirm"; resolvedCwd: string; reason: "always" | "unknown-dir" | "changed" }
  | { kind: "refused"; code: "E_BAD_REQUEST"; message?: string; reason?: typeof SPAWN_GONE_REASON }
  | ({ kind: "refused" } & Omit<StartFailure, "ok">)
  | { kind: "rate-limited"; code: "E_RATE"; retryAfterMs: number }
  | { kind: "unauthorized"; code: string; handled?: true };

export type FreshSpawnAuthorization = { ok: true; origin?: CmdOrigin } | { ok: false; code: string; handled?: true };

export interface FreshSpawnContext {
  /** Exact caller identity for dedup. Feishu: `feishu:<installGen>:<openId>`. */
  principal: string;
  /** Supervisor ownership/limits and first-prompt attribution. HTTP passes its original values;
   * Feishu uses listener:lan, user:feishu:<installGen>:<openId> (no real LAN user can collide).
   * This is NOT used to choose scope/confirmation or the caller's rate bucket. */
  owner: StoredOwner;
  origin: CmdOrigin;
  policy: Pick<SpawnPolicyWire, "scope" | "confirm">;
  rate: { bucket: string; capacity: number; refillMs: number; onReject(): void };
  limit: CmdLimit;
  idempotency: SpawnIdempotency;
  dirs: Pick<DirService, "admit">;
  supervisor: Pick<SpawnSupervisor, "start" | "records">;
  firstPrompt: Pick<FirstPromptForwarder, "accept">;
  prefs: Pick<SpawnPrefs, "get">;
  registerTimeoutS: number;
  deadline: ReqDeadline;
  now(): number;
  audit(record: SpawnAuditRecord): void;
  /** Re-check live authorization after the async directory scan. `handled` means the adapter
   * already emitted its denial + audit (HTTP's authorize helper does that). */
  reauthorize(): Promise<FreshSpawnAuthorization>;
  /** Optional synchronous sink: HTTP MUST send here, not after awaiting startFresh, to keep
   * its zero-await auth2 → start → firstPrompt → LRU → audit → 202 stretch intact. */
  onResult?(outcome: FreshSpawnOutcome): void;
  /** LAN security r2 §4.2 (E): called on the accepted fresh-spawn path only (never the dup path).
   * `routes.ts` passes it only for the LAN listener; the Feishu bot origin never sets it. */
  onAccepted?(info: { ip: string; user?: string; dirTail?: string }): void;
}

/** §4.2 (Q9): the last two path segments of a cwd, or `undefined` when there are none. */
export function dirTailOf(cwd: string): string | undefined {
  const tail = basename(cwd);
  if (tail === "" || tail === "/" || tail === ".") return undefined;
  const parent = basename(dirname(cwd));
  if (parent === "" || parent === "/" || parent === ".") return tail;
  return `${parent}/${tail}`;
}

export async function startFresh(intent: FreshSpawnIntent, ctx: FreshSpawnContext): Promise<FreshSpawnOutcome> {
  const { supervisor, dirs, firstPrompt, prefs, deadline, now } = ctx;
  const origin = ctx.origin;
  function finish(outcome: FreshSpawnOutcome): FreshSpawnOutcome {
    ctx.onResult?.(outcome);
    return outcome;
  }
  function reject(fields: Partial<SpawnAuditRecord> & { code: string }, who: CmdOrigin = origin): void {
    ctx.audit({
      audit: "spawn",
      phase: "reject",
      endpoint: "spawn",
      listener: who.listener,
      ip: who.ip,
      ...(who.user === undefined ? {} : { user: who.user }),
      reqId: intent.id,
      ...fields,
    });
  }
  const idemKey = `${ctx.principal}|${intent.id}`;
  const digest = intentDigest({ ...intent, session: undefined });
  const dup = ctx.idempotency.get(idemKey);
  if (dup !== undefined) {
    if (dup.digest !== digest) {
      reject({ code: "E_BAD_REQUEST" });
      return finish({ kind: "refused", code: "E_BAD_REQUEST", message: "id reused with different intent" });
    }
    const rec = supervisor.records().find((r) => r.spawnId === dup.spawnId);
    if (rec !== undefined) {
      ctx.audit({
        audit: "spawn",
        phase: "request",
        endpoint: "spawn",
        reqId: intent.id,
        listener: origin.listener,
        ip: origin.ip,
        ...(origin.user === undefined ? {} : { user: origin.user }),
        spawnId: rec.spawnId,
        cwd: rec.cwd,
        dup: true,
      });
      return finish({
        kind: "accepted",
        value: {
          spawnId: rec.spawnId,
          state: rec.state === "launching" ? "starting" : rec.state,
          cwd: rec.cwd,
          ...(rec.model === undefined ? {} : { model: rec.model }),
          ...(rec.sessionTarget === undefined
            ? {}
            : { session: { mode: rec.from === "fork" ? "fork" : "resume", id: rec.sessionTarget.id } }),
          dup: true,
          ...(rec.firstPrompt === undefined ? {} : { firstPrompt: "accepted" }),
        },
        ...(rec.agentKey === undefined ? {} : { agentKey: rec.agentKey }),
        ...(rec.sessionId === undefined ? {} : { sessionId: rec.sessionId }),
      });
    }
    // B-fork: a removed record is a refusal, never a second fork under the same id.
    reject({ spawnId: dup.spawnId, code: "E_BAD_REQUEST" });
    return finish({ kind: "refused", code: "E_BAD_REQUEST", reason: SPAWN_GONE_REASON });
  }

  const rate = ctx.limit.admit(ctx.rate.bucket, ctx.rate.capacity, ctx.rate.refillMs);
  if (!rate.ok) {
    ctx.rate.onReject();
    return finish({ kind: "rate-limited", code: "E_RATE", retryAfterMs: rate.retryAfterMs });
  }
  const admitMs = deriveBudget(deadline.remaining(), ADMIT_CAP_MS, ADMIT_RESERVE_MS);
  if (admitMs <= 0) {
    reject({ code: "E_DEADLINE" });
    return finish({ kind: "refused", code: "E_DEADLINE" });
  }
  const admitted = await dirs.admit(intent.cwd, ctx.policy.scope, createReqDeadline(now, admitMs));
  if (!admitted.ok) {
    reject({ code: "E_DIR" });
    return finish({ kind: "refused", code: "E_DIR", reason: admitted.reason });
  }
  const needConfirm = ctx.policy.confirm === "always" || (ctx.policy.confirm === "unknown-dir" && !admitted.known);
  const confirmBound = intent.confirmed && intent.expectCwd === admitted.realpath;
  if (needConfirm && !confirmBound) {
    reject({ cwd: admitted.realpath, known: admitted.known, confirmed: false, code: "E_CONFIRM_REQUIRED" });
    return finish({
      kind: "confirm",
      resolvedCwd: admitted.realpath,
      reason: intent.confirmed ? "changed" : ctx.policy.confirm,
    });
  }
  const auth = await ctx.reauthorize();
  if (!auth.ok) {
    if (!auth.handled) reject({ code: auth.code });
    return finish({ kind: "unauthorized", code: auth.code, ...(auth.handled ? { handled: true } : {}) });
  }

  // No await from auth2 through onResult: the original HTTP gate 10–202 contract.
  const effectiveModel = intent.model !== undefined ? intent.model : (prefs.get() ?? "");
  const spawnId = randomBytes(12).toString("base64url");
  const startReq: AdmittedRequest = {
    spawnId,
    admitted: {
      realpath: admitted.realpath,
      dev: admitted.dev,
      ino: admitted.ino,
      known: admitted.known,
      ...(admitted.viaCreated === true ? { viaCreated: true as const } : {}),
    },
    owner: ctx.owner,
    ...(effectiveModel === "" ? {} : { model: effectiveModel }),
    ...(intent.firstPrompt === undefined
      ? {}
      : {
          firstPrompt: {
            textLen: Buffer.byteLength(intent.firstPrompt.text, "utf8"),
            deliver: intent.firstPrompt.deliver,
          },
        }),
  };
  const result = supervisor.start(startReq, deadline);
  if (!result.ok) {
    reject(
      {
        cwd: admitted.realpath,
        known: admitted.known,
        ...(needConfirm ? { confirmed: true } : {}),
        ...(result.code === "E_LIMIT"
          ? { limit: result.limit ?? "global", active: result.active, max: result.max }
          : {}),
        code: result.code,
      },
      auth.origin ?? origin,
    );
    return finish({ kind: "refused", ...result });
  }
  if (intent.firstPrompt !== undefined) {
    firstPrompt.accept(
      spawnId,
      intent.firstPrompt,
      origin,
      now() + ctx.registerTimeoutS * 1000 + FIRST_PROMPT_GRACE_MS,
    );
  }
  ctx.idempotency.put(idemKey, spawnId, digest);
  ctx.audit({
    audit: "spawn",
    phase: "request",
    endpoint: "spawn",
    reqId: intent.id,
    listener: origin.listener,
    ip: origin.ip,
    ...(origin.user === undefined ? {} : { user: origin.user }),
    spawnId,
    cwd: admitted.realpath,
    known: admitted.known,
    confirmed: needConfirm ? true : false,
    ...(intent.firstPrompt === undefined
      ? {}
      : { firstPrompt: "pending", textLen: Buffer.byteLength(intent.firstPrompt.text, "utf8") }),
    ...(effectiveModel === "" ? {} : { model: effectiveModel }),
  });
  // `start` normally returns starting; a synchronous fake/adapter may already know live coords.
  const rec = supervisor.records().find((r) => r.spawnId === spawnId);
  const dirTail = dirTailOf(admitted.realpath);
  ctx.onAccepted?.({
    ip: origin.ip,
    ...(origin.user === undefined ? {} : { user: origin.user }),
    ...(dirTail === undefined ? {} : { dirTail }),
  });
  return finish({
    kind: "accepted",
    value: {
      spawnId,
      state: "starting",
      cwd: admitted.realpath,
      ...(effectiveModel === "" ? {} : { model: effectiveModel }),
      ...(intent.firstPrompt === undefined ? {} : { firstPrompt: "accepted" }),
    },
    ...(rec?.agentKey === undefined ? {} : { agentKey: rec.agentKey }),
    ...(rec?.sessionId === undefined ? {} : { sessionId: rec.sessionId }),
  });
}
