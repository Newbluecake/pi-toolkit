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
import { userInfo } from "node:os";
import { promisify } from "node:util";
import type { LanOffReason } from "../protocol/lan.js";
import { checkDbFiles, CHECKPOINT_PASSIVE_INTERVAL_MS, MAINT_DEADLINE_MS } from "./db.js";
import { buildMaintScript } from "./db-child.js";
import { computeVerifyTarget, effectiveWriteTarget, type KdfShape } from "./kdf.js";
import { createDbClient, type DbClient, type DbClientDeps } from "./db-client.js";
import type { HubLog, LanSessionRecord, LanStorePort, LanUserRecord, LanUserSummary, PortOptions } from "./ports.js";
import { hashSid as sharedHashSid } from "./sid-hash.js";

import {
  TOTP_CODE_RE,
  RECOVERY_CODE_RE,
  LAN_SESSION_IDLE_MIN,
  LAN_SESSION_IDLE_MAX,
  LAN_SESSION_IDLE_MINUTES,
} from "../protocol/lan-2fa.js";
import { webHubTotpKeyFile } from "../protocol/paths.js";
import { auditLan2fa } from "./audit.js";

const execFileP = promisify(execFile);

/** P1's original literal, kept as the fallback whenever `os.userInfo()` can't produce a usable
 * name (review fix, L8 "用户名默认系统登录名"). */
const FALLBACK_INITIAL_USERNAME = "admin";

/** `LanStatus.warnings` token raised when the WAL TRUNCATE after wiping the initial password failed. */
const INITIAL_RESIDUE_WARNING = "initial-password-residue";

export interface LanStore extends LanStorePort {
  /** §6.7.1 step ④ (rotate token, C8): single-transaction revoke of every LAN session — bumps
   * every user's epoch and deletes every session row. Deliberately NOT on the frozen
   * `LanStorePort` (same widening rule as `touchSessionReserved` above): the rotate-token flow
   * needs the concrete `LanStore`, not the port-narrowed `LanFrontendDeps.store`. Returns the
   * number of session rows removed. */
  revokeAllSessions(opts?: PortOptions): Promise<number>;
  /** §4.2 reserved-channel `touchSession` for the SSE tick — see file header. */
  touchSessionReserved(
    sidHash: string,
    now: number,
    opts?: PortOptions & { ip?: string },
  ): Promise<LanSessionRecord | undefined>;
  /** Fires once when the underlying breaker opens after repeated failures. */
  onUnavailable(cb: (reason: "db-unavailable") => void): () => void;
  /** Fires once after the breaker cooldown; the hub owns the restart decision. */
  onRestartNeeded(cb: () => void): () => void;
  /** Stops the checkpoint-passive tick, runs a final checkpoint-truncate
   * (best effort, bounded), and closes the resident subprocess. Idempotent. */
  close(): Promise<void>;
}

export interface CreateLanStoreDeps {
  dbFile: string;
  /** Explicit key-path test seam; production derives the same home as HubPaths from dbFile. */
  totpKeyPath?: string;
  /** Idle expiry policy (clamped to 5 minutes–7 days; default 12 hours). */
  idleMs?: number;
  log: HubLog;
  now?: () => number;
  /** Test-only: forces script test-hook compilation + smaller timings. Never
   * read from `process.env` implicitly beyond what `db-client.ts` already does. */
  test?: boolean;
  checkpointIntervalMs?: number;
  maintOpenDeadlineMs?: number;
  /** Test seams for the maintenance open check (#66): release phase / fixed clock (ms). */
  maintHardening?: { hardeningPhase?: 1 | 2; now?: number };
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
      | "restartCooldownMs"
      | "reservedQueueSlots"
      | "spawnFn"
    >
  >;
}

/**
 * #66 hardening verdict of the open check (plan §4.0/§5). `writerActive` is decided ONCE by the
 * maintenance subprocess; `verifyTarget` is `max(write target, strongest stored record)`.
 * TOTP key state is independent of schema consistency: missing keys never close LAN.
 */
export interface LanHardening {
  readerSince: number;
  writerActive: boolean;
  verifyTarget: KdfShape;
  totpKey: "none" | "ok" | "missing" | "mismatch";
  totpMigrated: number;
  truncateFailed: boolean;
}

export type CreateLanStoreResult =
  | { ok: true; store: LanStore; loginIpsRebuilt: boolean; hardening: LanHardening }
  | { ok: false; reason: LanOffReason; detail?: string };

/**
 * §4.1 "前置条件（按顺序）": file check → maintenance open-check-migrate →
 * (only then) spawn the resident query subprocess. Any failure returns a
 * `LanOffReason` instead of throwing — the caller (LD's `lan-controller.ts`,
 * a later package) maps this straight onto `LanStatus`.
 */
export async function createLanStore(deps: CreateLanStoreDeps): Promise<CreateLanStoreResult> {
  const log = deps.log;
  // Assembly's frozen input supplies only dbFile. It embeds the exact HubPaths home prefix;
  // never consult process.env/HOME/XDG here (custom DB paths require an explicit test key path).
  const suffix = "/.pi/agent/web-hub/hub.db";
  const totpKeyPath =
    deps.totpKeyPath ?? (deps.dbFile.endsWith(suffix) ? webHubTotpKeyFile(deps.dbFile.slice(0, -suffix.length)) : "");
  const now = deps.now ?? Date.now;
  const idleMs = Number.isFinite(deps.idleMs)
    ? Math.min(LAN_SESSION_IDLE_MAX * 60_000, Math.max(LAN_SESSION_IDLE_MIN * 60_000, Math.trunc(deps.idleMs!)))
    : LAN_SESSION_IDLE_MINUTES * 60_000;

  const fileCheck = await checkDbFiles(deps.dbFile, { log });
  if (!fileCheck.ok) return { ok: false, reason: fileCheck.reason, detail: fileCheck.detail };

  const maintDeadline = deps.maintOpenDeadlineMs ?? MAINT_DEADLINE_MS["open-check-migrate"];
  const maintResult = await runMaint(
    deps.dbFile,
    "open-check-migrate",
    maintDeadline,
    resolveInitialUsername(log),
    undefined,
    { ...deps.maintHardening, totpKeyPath },
  );
  if (!maintResult.ok) return maintResult;
  if (maintResult.loginIpsRebuilt) log.warn("web-hub lan-store: login_ips migrated or rebuilt");
  // The open check's final TRUNCATE failing used to be dropped silently; surface it (stays bounded:
  // the next open / the close-time truncate retries it).
  const truncateFailed = maintResult.warning !== undefined && maintResult.warning.startsWith("checkpoint-truncate-");
  if (maintResult.warning !== undefined)
    log.warn("web-hub lan-store: open check warning", { warning: maintResult.warning });
  const writerActive = maintResult.hardening?.writerActive === true;
  const hardening: LanHardening = {
    readerSince: maintResult.hardening?.readerSince ?? now(),
    writerActive,
    verifyTarget: computeVerifyTarget(effectiveWriteTarget(writerActive), maintResult.hardening?.maxKdf ?? undefined),
    totpKey: maintResult.hardening?.totpKey ?? "none",
    totpMigrated: maintResult.hardening?.totpMigrated ?? 0,
    truncateFailed: maintResult.hardening?.truncateFailed ?? truncateFailed,
  };

  const dbClient = createDbClient({
    dbFile: deps.dbFile,
    log,
    now,
    ...(deps.test === undefined ? {} : { test: deps.test }),
    ...deps.dbClient,
    childEnv: { PI_WEBHUB_TOTP_KEY: totpKeyPath, PI_WEBHUB_TOTP_WRITE: writerActive ? "1" : "0" },
  });

  const checkpointIntervalMs = deps.checkpointIntervalMs ?? CHECKPOINT_PASSIVE_INTERVAL_MS;
  const checkpointTimer = setInterval(() => {
    runMaint(deps.dbFile, "checkpoint-passive", MAINT_DEADLINE_MS["checkpoint-passive"]).catch(() => undefined);
  }, checkpointIntervalMs);
  checkpointTimer.unref?.();

  let closed = false;

  // #66 D4: status warnings raised by the store itself (hub never reads them from the db).
  const warningTokens = new Set<string>();
  if (hardening.totpKey === "missing") warningTokens.add("totp-key-missing");
  if (hardening.totpKey === "mismatch") warningTokens.add("totp-key-mismatch");
  if (hardening.totpMigrated > 0 && hardening.truncateFailed) warningTokens.add("totp-plaintext-residue");
  for (const code of maintResult.hardening?.totpWarnings ?? []) {
    if (/^[a-z-]{1,32}$/.test(code)) log.warn("web-hub lan-store: TOTP key warning", { code });
  }
  const warningListeners = new Set<() => void>();
  function setWarning(token: string, on: boolean): void {
    if (warningTokens.has(token) === on) return;
    if (on) warningTokens.add(token);
    else warningTokens.delete(token);
    for (const cb of [...warningListeners]) {
      try {
        cb();
      } catch {
        /* a listener must never break the store */
      }
    }
  }
  // Coalesced: concurrent requests share one in-flight TRUNCATE; one more run is queued if a wipe
  // landed while it was running (its pages may postdate the checkpoint already in progress).
  let truncating = false;
  let truncateAgain = false;
  function requestCheckpointTruncate(): void {
    if (closed) return;
    if (truncating) {
      truncateAgain = true;
      return;
    }
    truncating = true;
    void (async () => {
      let failed = false;
      try {
        const res = await runMaint(deps.dbFile, "checkpoint-truncate", MAINT_DEADLINE_MS["checkpoint-truncate"]);
        failed = !res.ok || res.warning !== undefined;
      } catch {
        failed = true;
      }
      truncating = false;
      if (failed) {
        log.warn("web-hub lan-store: checkpoint-truncate after initial-password wipe failed");
        setWarning(INITIAL_RESIDUE_WARNING, true);
      } else if (!truncateAgain) {
        setWarning(INITIAL_RESIDUE_WARNING, false);
        setWarning("totp-plaintext-residue", false);
      }
      if (truncateAgain && !closed) {
        truncateAgain = false;
        requestCheckpointTruncate();
      }
    })();
  }

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
    hardening: Object.freeze({ writerActive }),
    async createSessionChecked(input, opts) {
      const sid = randomBytes(32).toString("base64url");
      const result = await dbClient.call<{ ok: true; evicted: string[] } | { ok: false; reason: "stale" }>(
        "createSessionChecked",
        { ...input, ua: input.ua?.slice(0, 512), sidHash: sharedHashSid(sid), idleMs },
        opts,
      );
      return result.ok ? { ...result, sid } : result;
    },
    async listSessions(userId, at, opts) {
      return await dbClient.call("listSessions", { userId, now: at, idleMs }, opts);
    },
    async deleteSessionsExcept(userId, keepSidHash, opts) {
      return await dbClient.call("deleteSessionsExcept", { userId, keepSidHash, keepIp: opts?.keepIp }, opts);
    },
    async noteLoginIp(userId, ip, at, opts) {
      return await dbClient.call("noteLoginIp", { userId, ip, now: at, sidHash: opts?.sidHash }, opts);
    },
    async isKnownIp(userId, ip, at, windowMs, opts) {
      return await dbClient.call("isKnownIp", { userId, ip, now: at, windowMs }, opts);
    },
    async knownIpCount(userId, at, windowMs, opts) {
      return await dbClient.call("knownIpCount", { userId, now: at, windowMs }, opts);
    },
    async get2faState(userId, opts) {
      return await dbClient.call("get2faState", { userId }, opts);
    },
    async verifyTotp(input, opts) {
      assertFactorCode(input.code, false);
      return await dbClient.call("verifyTotp", { ...input }, opts);
    },
    async consumeRecovery(input, opts) {
      assertFactorCode(input.code, true);
      return await dbClient.call("consumeRecovery", { ...input }, opts);
    },
    async beginTotp(input, opts) {
      return await dbClient.call("beginTotp", { ...input }, opts);
    },
    async commitTotp(input, opts) {
      assertFactorCode(input.code, false);
      return await dbClient.call("commitTotp", { ...input }, opts);
    },
    async setFeishu2fa(input, opts) {
      return await dbClient.call("setFeishu2fa", { ...input }, opts);
    },
    async regenRecovery(userId, at, opts) {
      return await dbClient.call("regenRecovery", { userId, now: at }, opts);
    },
    async reset2fa(userId, at, opts) {
      await dbClient.call("reset2fa", { userId, now: at }, opts);
    },
    async forgetLoginIps(opts) {
      await dbClient.call("forgetLoginIps", {}, opts);
    },
    async listUsers(at, opts) {
      return await dbClient.call("listUsers", { now: at, idleMs }, opts);
    },
    async deleteUser(username, opts) {
      return await dbClient.call("deleteUser", { username }, opts);
    },
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
      const sid = randomBytes(32).toString("base64url");
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
          idleMs,
        },
        opts,
      );
      return { sid };
    },

    async touchSession(sidHash, now2, opts) {
      // §4.2 "同 sid 去重与配额": fold concurrent touches for the same sidHash into one
      // in-flight IPC (db-client.ts's dedup, keyed here so it never collides with any
      // other op's dedupKey); the 9th distinct rider on the same key gets E_RATE.
      const raw = await dbClient.call<RawSession | undefined>(
        "touchSession",
        { sidHash, now: now2, idleMs, ...(opts?.ip === undefined ? {} : { ip: opts.ip }) },
        { ...opts, dedupKey: `touchSession:${sidHash}` },
      );
      return decodeSession(raw);
    },

    async touchSessionReserved(sidHash, now2, opts) {
      const raw = await dbClient.call<RawSession | undefined>(
        "touchSession",
        { sidHash, now: now2, idleMs, ...(opts?.ip === undefined ? {} : { ip: opts.ip }) },
        { ...opts, reserved: true, dedupKey: `touchSession:${sidHash}` },
      );
      return decodeSession(raw);
    },

    async deleteSession(sidHash, opts) {
      await dbClient.call("deleteSession", { sidHash }, opts);
    },

    async revokeSession(userId, sidHash, keepIp, opts) {
      return await dbClient.call("revokeSession", { userId, sidHash, keepIp }, opts);
    },
    async untrustLoginIps(userId, ips, keepIp, opts) {
      await dbClient.call("untrustLoginIps", { userId, ips, keepIp }, opts);
    },
    async deleteAllSessions(userId, opts) {
      await dbClient.call("deleteAllSessions", { userId }, opts);
    },

    async revokeAllSessions(opts) {
      return await dbClient.call<number>("revokeAllSessions", {}, opts);
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

    async rehashPassword(input, opts) {
      // Defense in depth: even direct callers cannot write upgrades before the open-time gate.
      if (!writerActive) return { ok: false, reason: "stale" };
      const encode = (row: typeof input.old) => ({
        n: row.n,
        r: row.r,
        p: row.p,
        salt: base64(row.salt),
        hash: base64(row.hash),
      });
      return await dbClient.call(
        "rehashPassword",
        {
          userId: input.userId,
          old: encode(input.old),
          next: encode(input.next),
          now: now(),
        },
        opts,
      );
    },

    async markInitialLogin(username, ip, at, opts) {
      const out = await dbClient.call<{ cleared?: boolean } | null | undefined>(
        "markInitialLogin",
        { username, ip, at },
        opts,
      );
      return { cleared: out?.cleared === true };
    },

    requestCheckpointTruncate,

    warnings: () => [...warningTokens],

    onWarningsChanged(cb) {
      warningListeners.add(cb);
      return () => {
        warningListeners.delete(cb);
      };
    },

    async purgeExpired(now2, opts) {
      return await dbClient.call<number>("purgeExpired", { now: now2 }, { ...opts, reserved: true });
    },

    onUnavailable(cb) {
      return dbClient.onUnavailable(cb);
    },

    onRestartNeeded(cb) {
      return dbClient.onRestartNeeded(cb);
    },

    close,
  };

  return { ok: true, store, loginIpsRebuilt: maintResult.loginIpsRebuilt === true, hardening };
}

// ---------------------------------------------------------------------------
// maintenance one-shot invocation
// ---------------------------------------------------------------------------

/**
 * L8 "用户名默认系统登录名": `os.userInfo().username` — main-thread-only, no I/O beyond what
 * `node:os` already does synchronously in memory (never touches the db, never spawns a
 * subprocess). Only consulted once, right before the one-shot "open-check-migrate" maintenance
 * call that seeds the very first user row on a fresh v1 schema — on an existing db this value is
 * computed and then simply unused (`buildMaintScript` only reads `initialUsername` inside the
 * `user_version === 0` branch). An empty/missing username or a thrown `os.userInfo()` (some
 * minimal/containerized environments have no NSS/passwd entry for the running uid) must never
 * abort LAN startup — falls back to `FALLBACK_INITIAL_USERNAME` (P1's original literal) and logs
 * the reason for the fallback.
 */
function resolveInitialUsername(log: HubLog): string {
  try {
    const name = userInfo().username;
    if (typeof name === "string" && name.length > 0) return name;
    log.warn("web-hub lan-store: os.userInfo().username was empty, falling back to the P1 default username", {
      fallback: FALLBACK_INITIAL_USERNAME,
    });
    return FALLBACK_INITIAL_USERNAME;
  } catch (err) {
    log.warn("web-hub lan-store: os.userInfo() threw, falling back to the P1 default username", {
      fallback: FALLBACK_INITIAL_USERNAME,
      error: String(err),
    });
    return FALLBACK_INITIAL_USERNAME;
  }
}

interface MaintHardeningReply {
  readerSince: number;
  writerActive: boolean;
  maxKdf: { n: number; r: number; p: number } | null;
  totpKey?: LanHardening["totpKey"];
  totpMigrated?: number;
  truncateFailed?: boolean;
  totpWarnings?: string[];
}
interface MaintOk {
  ok: true;
  loginIpsRebuilt?: boolean;
  warning?: string;
  hardening?: MaintHardeningReply;
}

async function runMaint(
  dbFile: string,
  op: "open-check-migrate" | "checkpoint-passive" | "checkpoint-truncate" | "repair-2fa",
  deadlineMs: number,
  initialUsername: string = FALLBACK_INITIAL_USERNAME,
  signal?: AbortSignal,
  hardeningOpts?: { hardeningPhase?: 1 | 2; now?: number; totpKeyPath?: string },
): Promise<MaintOk | { ok: false; reason: LanOffReason; detail?: string }> {
  const script = buildMaintScript({
    initialUsername,
    ...(hardeningOpts?.hardeningPhase === undefined ? {} : { hardeningPhase: hardeningOpts.hardeningPhase }),
    ...(hardeningOpts?.now === undefined ? {} : { now: hardeningOpts.now }),
  });
  try {
    const { stdout } = await execFileP(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", script], {
      env: {
        ...process.env,
        PI_WEBHUB_DB_PATH: dbFile,
        PI_WEBHUB_TOTP_KEY: hardeningOpts?.totpKeyPath ?? "",
        PI_WEBHUB_DB_OP: op,
        PI_WEBHUB_DB_DEADLINE_MS: String(deadlineMs),
      },
      timeout: deadlineMs,
      ...(signal === undefined ? {} : { signal }),
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    const line = stdout.trim().split("\n").pop() ?? "";
    const parsed =
      line.length > 0
        ? (JSON.parse(line) as {
            ok: boolean;
            code?: string;
            detail?: string;
            loginIpsRebuilt?: boolean;
            warning?: string;
            hardening?: MaintHardeningReply;
          })
        : { ok: false, code: "db-invalid", detail: "maintenance returned no result" };
    if (parsed.ok === true)
      return {
        ok: true,
        ...(parsed.loginIpsRebuilt === undefined ? {} : { loginIpsRebuilt: parsed.loginIpsRebuilt }),
        ...(typeof parsed.warning === "string" ? { warning: parsed.warning } : {}),
        ...(isMaintHardening(parsed.hardening) ? { hardening: parsed.hardening } : {}),
      };
    return parsed.detail === undefined
      ? { ok: false, reason: mapMaintCode(parsed.code) }
      : { ok: false, reason: mapMaintCode(parsed.code), detail: parsed.detail };
  } catch (err) {
    const e = err as { killed?: boolean; signal?: string; code?: number; message?: string };
    if (signal?.aborted || e.killed === true)
      return { ok: false, reason: "db-timeout", detail: `${op} exceeded ${deadlineMs}ms` };
    return { ok: false, reason: "db-invalid", detail: e.message ?? String(err) };
  }
}

function isMaintHardening(h: unknown): h is MaintHardeningReply {
  if (typeof h !== "object" || h === null) return false;
  const o = h as Record<string, unknown>;
  if (typeof o["readerSince"] !== "number" || typeof o["writerActive"] !== "boolean") return false;
  const m = o["maxKdf"];
  if (m === null) return true;
  if (typeof m !== "object") return false;
  const k = m as Record<string, unknown>;
  return typeof k["n"] === "number" && typeof k["r"] === "number" && typeof k["p"] === "number";
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

/** B↔F offline maintenance seam: bounded file-check + explicit destructive 2FA repair.
 * Works without a resident store, preserves v2, and audits only op/ok. */
export type RepairLan2faResult = { ok: true } | { ok: false; reason: LanOffReason; detail?: string };
export async function repairLan2fa(deps: {
  dbFile: string;
  log: HubLog;
  signal?: AbortSignal;
}): Promise<RepairLan2faResult> {
  if (deps.signal?.aborted) {
    auditLan2fa(deps.log, { phase: "admin", op: "repair", ok: false });
    return { ok: false, reason: "db-timeout" };
  }
  const files = await checkDbFiles(deps.dbFile, { log: deps.log });
  const result = files.ok
    ? await runMaint(deps.dbFile, "repair-2fa", MAINT_DEADLINE_MS["repair-2fa"], FALLBACK_INITIAL_USERNAME, deps.signal)
    : files;
  auditLan2fa(deps.log, { phase: "admin", op: "repair", ok: result.ok });
  return result;
}

/** Malformed input is rejected before IPC admission (and before consuming a verifier budget). */
function assertFactorCode(code: string, recovery: boolean): void {
  if (!(recovery ? RECOVERY_CODE_RE : TOTP_CODE_RE).test(code)) {
    throw Object.assign(new Error("Malformed factor code"), { code: "E_BAD_REQUEST" });
  }
}
