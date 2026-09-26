/**
 * `LanStorePort` implementation (plan §4; `hub/lan-store.ts`, S1-W2 LS 包):
 * ties `db.ts` (schema/file checks), `db-child.ts` (subprocess script bodies)
 * and `db-client.ts` (dual-channel IPC) together into the single async facade
 * `LanFrontendDeps.store` expects. Also owns the parts of §4/§5.2 that don't
 * fit any single `LanStorePort` method:
 *  - the main-thread file check + one-shot "open-check-migrate" maintenance
 *    call that must happen *before* the resident query subprocess is ever
 *    spawned (§4.1 "打开前"), surfaced as a `LanOffReason` on failure instead
 *    of a live store;
 *  - bootstrapping the single initial user (Q14: "db 中没有用户时由 hub 生成")
 *    — done inside the maintenance script itself when it creates a fresh v1
 *    schema, since neither `LanStorePort` nor this module's async surface has
 *    (or needs) a dedicated "seed the first user" op;
 *  - raw-vs-hash session id semantics (§6.4 "库中只存 sha256(sid)"): this is
 *    the only place a raw sid ever exists outside a request's own `Cookie`
 *    header — generated here (not in the child), hashed here, and only the
 *    hash crosses the IPC boundary;
 *  - the periodic `checkpoint-passive` maintenance tick (§4.2, every 10
 *    minutes) and a final `checkpoint-truncate` on `close()`.
 *
 * `LanStore` (this module's return type) is a strict superset of the frozen
 * `LanStorePort`: `touchSessionReserved` is deliberately *not* on the frozen
 * interface. §4.2's reserved IPC channel is for the SSE 55s expiry-recheck
 * tick and `purgeExpired`; `purgeExpired` is its own `LanStorePort` method so
 * routing it is unambiguous, but the tick calls `touchSession` on the exact
 * same signature normal per-request validation does — the frozen interface
 * has no field to say "use the reserved channel for this one call" (adding
 * one to the shared `PortOptions` in `hub/ports.ts` would be a W1 signature
 * change, out of scope for this package). Whoever wires the SSE tick (LC/LD,
 * later packages) is expected to hold the concrete `LanStore` returned here
 * — not just the `LanStorePort`-narrowed `LanFrontendDeps.store` field — and
 * call `touchSessionReserved` directly for that one caller. This is a design
 * choice made without a §16-style user sign-off; flagged in the delivery
 * report for review.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { LanOffReason } from "../protocol/lan.js";
import { checkDbFiles, CHECKPOINT_PASSIVE_INTERVAL_MS, MAINT_DEADLINE_MS } from "./db.js";
import { buildMaintScript } from "./db-child.js";
import { createDbClient, type DbClient, type DbClientDeps } from "./db-client.js";
import type { HubLog, LanSessionRecord, LanStorePort, LanUserRecord, LanUserSummary, PortOptions } from "./ports.js";
import { hashSid as sharedHashSid } from "./sid-hash.js";

const execFileP = promisify(execFile);

export interface LanStore extends LanStorePort {
  /** §4.2 reserved-channel `touchSession` for the SSE tick — see file header. */
  touchSessionReserved(sidHash: string, now: number, opts?: PortOptions): Promise<LanSessionRecord | undefined>;
  /** Fires (at most once) when the underlying `db-client` gives up after
   * repeated crashes inside its restart-backoff window. */
  onUnavailable(cb: (reason: "db-unavailable") => void): () => void;
  /** Stops the checkpoint-passive tick, runs a final checkpoint-truncate
   * (best effort, bounded), and closes the resident subprocess. Idempotent. */
  close(): Promise<void>;
}

export interface CreateLanStoreDeps {
  dbFile: string;
  log: HubLog;
  now?: () => number;
  /** Test-only: forces script test-hook compilation + smaller timings. Never
   * read from `process.env` implicitly beyond what `db-client.ts` already does. */
  test?: boolean;
  checkpointIntervalMs?: number;
  maintOpenDeadlineMs?: number;
  dbClient?: Partial<
    Pick<
      DbClientDeps,
      | "interactiveSlots"
      | "queueSlots"
      | "deadlineMs"
      | "dedupMaxWaiters"
      | "backoffMs"
      | "restartWindowMs"
      | "maxRestartsInWindow"
      | "spawnFn"
    >
  >;
}

export type CreateLanStoreResult = { ok: true; store: LanStore } | { ok: false; reason: LanOffReason; detail?: string };

/**
 * §4.1 "前置条件（按顺序）": file check → maintenance open-check-migrate →
 * (only then) spawn the resident query subprocess. Any failure returns a
 * `LanOffReason` instead of throwing — the caller (LD's `lan-controller.ts`,
 * a later package) maps this straight onto `LanStatus`.
 */
export async function createLanStore(deps: CreateLanStoreDeps): Promise<CreateLanStoreResult> {
  const log = deps.log;
  const now = deps.now ?? Date.now;

  const fileCheck = await checkDbFiles(deps.dbFile, { log });
  if (!fileCheck.ok) return { ok: false, reason: fileCheck.reason, detail: fileCheck.detail };

  const maintDeadline = deps.maintOpenDeadlineMs ?? MAINT_DEADLINE_MS["open-check-migrate"];
  const maintResult = await runMaint(deps.dbFile, "open-check-migrate", maintDeadline);
  if (!maintResult.ok) return maintResult;

  const dbClient = createDbClient({
    dbFile: deps.dbFile,
    log,
    now,
    ...(deps.test === undefined ? {} : { test: deps.test }),
    ...deps.dbClient,
  });

  const checkpointIntervalMs = deps.checkpointIntervalMs ?? CHECKPOINT_PASSIVE_INTERVAL_MS;
  const checkpointTimer = setInterval(() => {
    runMaint(deps.dbFile, "checkpoint-passive", MAINT_DEADLINE_MS["checkpoint-passive"]).catch(() => undefined);
  }, checkpointIntervalMs);
  checkpointTimer.unref?.();

  let closed = false;

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    clearInterval(checkpointTimer);
    await dbClient.close();
    try {
      await runMaint(deps.dbFile, "checkpoint-truncate", MAINT_DEADLINE_MS["checkpoint-truncate"]);
    } catch (err) {
      log.warn("web-hub lan-store: final checkpoint-truncate failed", { error: String(err) });
    }
  }

  const store: LanStore = {
    async getUser(username, opts) {
      const raw = await dbClient.call<RawUser | undefined>("getUser", { username }, opts);
      return raw === undefined || raw === null ? undefined : decodeUser(raw);
    },

    async getUserSummary(userId, opts) {
      const raw = await dbClient.call<LanUserSummary | undefined>("getUserSummary", { userId }, opts);
      return raw === undefined || raw === null ? undefined : raw;
    },

    async initialInfo(opts) {
      const raw = await dbClient.call<
        { username: string; initialPassword?: string; initialLogin?: { ip: string; at: number } } | undefined
      >("initialInfo", {}, opts);
      return raw === undefined || raw === null ? undefined : raw;
    },

    async createSession(input, opts) {
      const sid = randomBytes(24).toString("base64url");
      const sidHash = sha256Base64Url(sid);
      await dbClient.call(
        "createSession",
        {
          sidHash,
          userId: input.userId,
          epoch: input.epoch,
          boundOrigin: input.boundOrigin,
          createdIp: input.createdIp,
          now: input.now,
        },
        opts,
      );
      return { sid };
    },

    async touchSession(sidHash, now2, opts) {
      const raw = await dbClient.call<RawSession | undefined>("touchSession", { sidHash, now: now2 }, opts);
      return decodeSession(raw);
    },

    async touchSessionReserved(sidHash, now2, opts) {
      const raw = await dbClient.call<RawSession | undefined>(
        "touchSession",
        { sidHash, now: now2 },
        { ...opts, reserved: true },
      );
      return decodeSession(raw);
    },

    async deleteSession(sidHash, opts) {
      await dbClient.call("deleteSession", { sidHash }, opts);
    },

    async deleteAllSessions(userId, opts) {
      await dbClient.call("deleteAllSessions", { userId }, opts);
    },

    async setPassword(input, opts) {
      await dbClient.call(
        "setPassword",
        {
          username: input.username,
          kdf: input.kdf,
          n: input.n,
          r: input.r,
          p: input.p,
          salt: base64(input.salt),
          hash: base64(input.hash),
          now: now(),
        },
        opts,
      );
    },

    async markInitialLogin(username, ip, at, opts) {
      await dbClient.call("markInitialLogin", { username, ip, at }, opts);
    },

    async purgeExpired(now2, opts) {
      return await dbClient.call<number>("purgeExpired", { now: now2 }, { ...opts, reserved: true });
    },

    onUnavailable(cb) {
      return dbClient.onUnavailable(cb);
    },

    close,
  };

  return { ok: true, store };
}

// ---------------------------------------------------------------------------
// maintenance one-shot invocation
// ---------------------------------------------------------------------------

async function runMaint(
  dbFile: string,
  op: "open-check-migrate" | "checkpoint-passive" | "checkpoint-truncate",
  deadlineMs: number,
): Promise<{ ok: true } | { ok: false; reason: LanOffReason; detail?: string }> {
  const script = buildMaintScript();
  try {
    const { stdout } = await execFileP(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", script], {
      env: {
        ...process.env,
        PI_WEBHUB_DB_PATH: dbFile,
        PI_WEBHUB_DB_OP: op,
        PI_WEBHUB_DB_DEADLINE_MS: String(deadlineMs),
      },
      timeout: deadlineMs,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    const line = stdout.trim().split("\n").pop() ?? "";
    const parsed =
      line.length > 0 ? (JSON.parse(line) as { ok: boolean; code?: string; detail?: string }) : { ok: true };
    if (parsed.ok) return { ok: true };
    return parsed.detail === undefined
      ? { ok: false, reason: mapMaintCode(parsed.code) }
      : { ok: false, reason: mapMaintCode(parsed.code), detail: parsed.detail };
  } catch (err) {
    const e = err as { killed?: boolean; signal?: string; code?: number; message?: string };
    if (e.killed === true) return { ok: false, reason: "db-timeout", detail: `${op} exceeded ${deadlineMs}ms` };
    return { ok: false, reason: "db-invalid", detail: e.message ?? String(err) };
  }
}

function mapMaintCode(code: string | undefined): LanOffReason {
  if (code === "sqlite-unavailable") return "sqlite-unavailable";
  return "db-invalid";
}

// ---------------------------------------------------------------------------
// wire ⇄ port decoding
// ---------------------------------------------------------------------------

interface RawUser {
  id: number;
  username: string;
  kdf: "scrypt";
  n: number;
  r: number;
  p: number;
  salt: string; // base64
  hash: string; // base64
  epoch: number;
  initialPassword?: string;
  initialCreatedAt?: number;
  initialLoginAt?: number;
  initialLoginIp?: string;
  createdAt: number;
  updatedAt: number;
}

interface RawSession {
  userId: number;
  epoch: number;
  boundOrigin: string;
  expiresAt: number;
  absoluteExpiresAt: number;
}

function decodeUser(raw: RawUser): LanUserRecord {
  return {
    id: raw.id,
    username: raw.username,
    kdf: raw.kdf,
    n: raw.n,
    r: raw.r,
    p: raw.p,
    salt: unbase64(raw.salt),
    hash: unbase64(raw.hash),
    epoch: raw.epoch,
    ...(raw.initialPassword !== undefined ? { initialPassword: raw.initialPassword } : {}),
    ...(raw.initialCreatedAt !== undefined ? { initialCreatedAt: raw.initialCreatedAt } : {}),
    ...(raw.initialLoginAt !== undefined ? { initialLoginAt: raw.initialLoginAt } : {}),
    ...(raw.initialLoginIp !== undefined ? { initialLoginIp: raw.initialLoginIp } : {}),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function decodeSession(raw: RawSession | undefined | null): LanSessionRecord | undefined {
  if (raw === undefined || raw === null) return undefined;
  return {
    userId: raw.userId,
    epoch: raw.epoch,
    boundOrigin: raw.boundOrigin,
    expiresAt: raw.expiresAt,
    absoluteExpiresAt: raw.absoluteExpiresAt,
  };
}

function base64(u8: Uint8Array): string {
  return Buffer.from(u8).toString("base64");
}

function unbase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

function sha256Base64Url(sid: string): string {
  return sharedHashSid(sid); // LC review fix, lan-plan.md §15.9 item 5: delegates to the shared helper
}

export type { DbClient };
