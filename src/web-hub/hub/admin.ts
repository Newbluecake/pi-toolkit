/**
 * hub-side admin control plane (plan §8, §8.3, §5.2 — S1-W3 LD 包): answers
 * the agent socket's `lan_req` (`info` / `passwd` / `unlock`) frames and
 * runs the `shutdown` side of `hub_ctl` once `agent-server.ts` has already
 * sent the `hub_ctl_ack` (plan requires ack-before-close). Same-uid trust
 * boundary (§1.1): no additional authentication on any op — every op writes
 * exactly one audit line instead (§8.3's `{"audit":"admin", op, agentKey,
 * agentPid, ok, code?, initialPasswordReturned?, username?}` shape).
 *
 * `agent-server.ts` intercepts `lan_req`/`hub_ctl` *before* ever calling
 * `registry.onFrame` — this module is never given a channel back into the
 * registry/bus, and never calls the shared `HubLog` for anything other than
 * the deliberate audit line below plus one defensive redacted line if a port
 * call throws unexpectedly (§5.2 "崩溃路径": fixed-text error replies, no
 * echoed input; a caught exception's own enumerable fields are redacted for
 * any key matching `/pass(word)?|initial/i` before being logged — this is
 * the "HubLog 包一层脱敏" requirement, scoped to this module's own
 * unexpected-error path since `admin.ts` is the one place raw passwords and
 * the initial-password value ever pass through in memory; every *deliberate*
 * audit field below is hand-picked to never carry a secret value, including
 * `initialPasswordReturned`, which §8.3 explicitly requires to show as a
 * literal boolean).
 * LAN security r2 §5.8 (package F): this module additionally answers the agent socket's
 * `tfa_req` frames (`handleTfaReq`) — TUI-only 2FA enrollment/maintenance (`status` /
 * `totp_begin` / `totp_confirm` / `feishu` / `recovery_regen` / `reset` / `forget_ips` /
 * `repair`). Same trust boundary and audit discipline as `lan_req`: the audit line carries
 * `{op, ok}` ONLY (plan §8's `phase:"admin"` whitelist) — never a TOTP/recovery code, never
 * a secret/URI. Secrets (`otpauthUri`/`secretB32`/`recoveryCodes`) exist only inside the
 * `tfa_res` success variants over the local, never-logged agent socket. `passwd` /
 * `2fa-changed` security events go out through the injected `emit` dep (P0 addendum item 6).
 * The `lan.2fa.v1` cap is advertised only when the integrator sets `advertiseTfa: true`
 * (P0: never advertise TFA before the agent-server routing exists).
 */
import type { LanReqFrame, LanResFrame } from "../protocol/messages.js";
import { NEW_IP_WINDOW_MS, type TfaOp, type TfaReqFrame, type TfaResFrame } from "../protocol/lan-2fa.js";
import { LAN_2FA_HUB_CAP } from "../protocol/version.js";
// L8 "密码 ≥10 位": shared with the TUI `/webhub passwd` client-side precheck
// (`agent/passwd-prompt.ts`'s `MIN_LAN_PASSWORD_LENGTH`) so a password the client accepts is
// never turned around and rejected by the hub — review fix, this used to be a locally-defined 8.
import { MIN_LAN_PASSWORD_LENGTH } from "../protocol/lan.js";
import {
  advanceRotateIntentSync,
  cleanupRotateIntentTemps,
  newRotateIntentId,
  readRotateIntentSync,
  removeRotateIntentSync,
  writeRotateIntentSync,
  type RotateIntent,
} from "../protocol/rotate-intent.js";
import { cleanupTokenTemps, generateToken, replaceTokenAtomic } from "../protocol/token-file.js";
import { auditLan2fa } from "./audit.js";
import type { Auth } from "./auth.js";
import { defaultKdfParams } from "./kdf.js";
import type { RepairLan2faResult } from "./lan-store.js";
import type { SecurityEvent } from "./security-events.js";
import type { HubLog, KdfPort, LanFacade, LanStatus, LanStorePort, LanUserRecord, LoginLimiterPort } from "./ports.js";

export interface AdminMeta {
  agentKey: string;
  agentPid?: number;
}

export interface AdminHandler {
  /** `hello_ack.caps` (§8.1): `"ctl.v1"` always, `"lan.v1"` once LAN is configured. */
  caps(): string[];
  handleLanReq(frame: LanReqFrame, meta: AdminMeta): Promise<LanResFrame>;
  /** §5.8 (F): `tfa_req` dispatch. `repair` must work with the LAN store OFF (maintenance op).
   * Never throws: any unexpected error becomes `E_INTERNAL` with a redacted log line. */
  handleTfaReq(frame: TfaReqFrame, meta: AdminMeta): Promise<TfaResFrame>;
  /** Caller (`agent-server.ts`) sends the `hub_ctl_ack` itself *before* calling this — this
   * function only triggers the actual close, fire-and-forget from the caller's perspective. */
  handleShutdown(meta: AdminMeta, reason: "restart" | "stop"): void;
  /**
   * §6.7.1 online `hub_ctl{op:"rotate_token"}` path (`by:"hub"`): write intent → atomic token
   * replace → advance intent phase → invalidate everything (loopback session map + SSE, LAN
   * session rows + SSE, `authGen`/`lanRevokeGen` bump) → delete intent. Unlike `handleShutdown`,
   * the caller sends the `hub_ctl_ack` (with `revoked` counts) only AFTER this resolves — the
   * ack itself carries the outcome.
   *
   * NOTE (delivery report): the real dispatch wiring for this lives in `agent-server.ts`'s
   * `hub_ctl` branch, which today unconditionally sends `hub_ctl_ack` and calls `handleShutdown`
   * for *every* `hub_ctl` frame regardless of `op` — including `rotate_token`. That file is not
   * in this package's exclusive file list (owned by C3, not moved to C8 in W3); the required
   * fix (route on `frame.op`, await this method before acking with `revoked`) is documented
   * verbatim in this package's delivery report for the main session to apply. This method is
   * fully implemented and unit-tested standalone against that eventual call.
   */
  handleRotateToken(meta: AdminMeta): Promise<{ token: string; revoked: { loopback: number; lan: number } }>;
}

export interface AdminDeps {
  log: HubLog;
  hasLan(): boolean;
  store(): LanStorePort | undefined;
  kdf(): KdfPort | undefined;
  limiter(): LoginLimiterPort | undefined;
  lan(): LanFacade | undefined;
  /** Falls back to this when `lan()` isn't constructed yet (e.g. LAN still `"starting"`, or a
   * `bad-config`/db-open-failure off status recorded before any `LanFacade` ever existed). */
  lanStatus(): LanStatus | undefined;
  shutdown(reason: string): void;
  now?: () => number;
  // ---- §6.7.1 rotate-token (C8) ----
  /** The live `Auth` instance (`hub.ts`'s `fe`, duck-typed — not on the frozen `HttpFrontend`). */
  auth(): Auth;
  rotateIntentFile: string;
  /** Revoke every LAN session row in one transaction (the concrete `LanStore`'s extra method,
   * duck-typed off the frozen `LanStorePort` — `undefined` when LAN isn't configured/built yet). */
  revokeLanSessions(): Promise<number> | undefined;
  /** Kill every already-open loopback SSE stream (duck-typed off `HttpFrontend`). */
  revokeLoopbackSse(): number;
  /** Kill every already-open LAN SSE stream (duck-typed off the frozen `LanFacade`, which only
   * exposes a single-target `revoke()`). */
  revokeLanSse(): number;
  /** Bump the in-process `lanRevokeGen` counter `http.ts`'s in-flight-request recheck reads
   * (§6.3 step ⑦, §6.7.1's "authGen / lanRevokeGen 在途复核"). */
  bumpLanRevokeGen(): void;
  // ---- LAN security r2 (F) — all optional so pre-F callers stay byte-identical ----
  /** P0 addendum item 6: `passwd` / `2fa-changed` events; I wires the `security-events` bus. */
  emit?(event: SecurityEvent): void;
  /** §5.2/§5.8: 2FA repair maintenance op, MUST work with the LAN store off. I wires
   * `repairLan2fa({dbFile, log})`; absent ⇒ `repair` answers `E_UNSUPPORTED`. */
  repair2fa?(): Promise<RepairLan2faResult>;
  /** §5.8: `feishu on` requires a confirmed bot owner. Absent ⇒ unchecked (legacy callers). */
  feishuOwner?(): boolean;
  /** §5.8 + P0 "never advertise before routing works": I sets true in the same merge that makes
   * `agent-server.ts` route `tfa_req` frames to `handleTfaReq`. Absent ⇒ cap not advertised. */
  advertiseTfa?: boolean;
}

// L8 "密码 ≥10 位": shared with the TUI `/webhub passwd` client-side precheck
// (`agent/passwd-prompt.ts`'s `MIN_LAN_PASSWORD_LENGTH`) so a password the client accepts is
// never turned around and rejected by the hub — review fix, this used to be a locally-defined 8.
const REDACT_KEY_RE = /pass(word)?|initial/i;

function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = REDACT_KEY_RE.test(k) ? "[redacted]" : v;
  return out;
}

function sanitizedErrorFields(err: unknown): Record<string, unknown> {
  const message = err instanceof Error ? err.message : String(err);
  const extra: Record<string, unknown> =
    err !== null && typeof err === "object" ? { ...(err as Record<string, unknown>) } : {};
  return redactFields({ ...extra, error: message });
}

export function createAdminHandler(deps: AdminDeps): AdminHandler {
  let announcedInitialLogin = false;

  function audit(op: string, fields: Record<string, unknown>, meta: AdminMeta): void {
    deps.log.info("web-hub admin op", {
      audit: "admin",
      op,
      agentKey: meta.agentKey,
      ...(meta.agentPid === undefined ? {} : { agentPid: meta.agentPid }),
      ...fields,
    });
  }

  function currentLanStatus(): LanStatus {
    return deps.lan()?.status() ?? deps.lanStatus() ?? { state: "starting" };
  }

  // ---- §5.8 tfa_req helpers (F) ----

  const now = (): number => deps.now?.() ?? Date.now();

  /** Plan §8: admin ops log `{op, ok}` only (the `phase:"admin"` whitelist). Never a code/secret. */
  function auditTfa(op: TfaOp, ok: boolean): void {
    auditLan2fa(deps.log, { phase: "admin", op, ok });
  }

  function tfaFail(rid: string, op: TfaOp, code: string, message: string): TfaResFrame {
    auditTfa(op, false);
    return { t: "tfa_res", rid, ok: false, code, message };
  }

  /** P0 addendum item 6: isolated best-effort emit (the bus itself also isolates subscribers). */
  function emitSecurity(event: SecurityEvent): void {
    if (deps.emit === undefined) return;
    try {
      deps.emit(event);
    } catch (err) {
      deps.log.error("web-hub admin: security emit threw", sanitizedErrorFields(err));
    }
  }

  /**
   * P0 decision: tfa requests target the hub's primary LAN account — the same single account
   * `lan_req info` resolves (`initialInfo()`'s first user row), with no username selector.
   * `getUser` then supplies the `userId` every 2FA store op is keyed by.
   */
  async function requireLanUser(
    rid: string,
    op: TfaOp,
  ): Promise<{ ok: true; store: LanStorePort; user: LanUserRecord } | { ok: false; res: TfaResFrame }> {
    const store = deps.store();
    if (!deps.hasLan() || store === undefined) {
      return { ok: false, res: tfaFail(rid, op, "E_NO_LAN", "LAN is not configured or unavailable") };
    }
    const info = await store.initialInfo();
    const user = info === undefined ? undefined : await store.getUser(info.username);
    if (user === undefined) {
      return { ok: false, res: tfaFail(rid, op, "E_NO_USER", "no LAN user exists yet") };
    }
    return { ok: true, store, user };
  }

  async function handleTfaStatus(rid: string): Promise<TfaResFrame> {
    const g = await requireLanUser(rid, "status");
    if (!g.ok) return g.res;
    const st = await g.store.get2faState(g.user.id);
    const knownIps = await g.store.knownIpCount(now(), NEW_IP_WINDOW_MS);
    auditTfa("status", true);
    return {
      t: "tfa_res",
      rid,
      ok: true,
      data: {
        kind: "status",
        state: st.state,
        totp: st.totp,
        feishu: st.feishu,
        recoveryLeft: st.recoveryLeft,
        knownIps,
        ...(st.state === "inconsistent" ? { repairNeeded: "2fa-missing-row" } : {}),
      },
    };
  }

  async function handleTfaBegin(rid: string, replace: boolean): Promise<TfaResFrame> {
    const g = await requireLanUser(rid, "totp_begin");
    if (!g.ok) return g.res;
    let r: { otpauthUri: string; secretB32: string };
    try {
      r = await g.store.beginTotp({ userId: g.user.id, ...(replace ? { replace: true } : {}), now: now() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("E_2FA_ENROLLED")) {
        return tfaFail(rid, "totp_begin", "E_2FA_ENROLLED", "TOTP already enrolled; pass replace to rotate");
      }
      throw err;
    }
    // totp_begin is excluded from the `2fa-changed` op union (P0 freeze): nothing is enrolled yet.
    auditTfa("totp_begin", true);
    return {
      t: "tfa_res",
      rid,
      ok: true,
      data: { kind: "totp_begin", otpauthUri: r.otpauthUri, secretB32: r.secretB32 },
    };
  }

  async function handleTfaConfirm(rid: string, code: string): Promise<TfaResFrame> {
    const g = await requireLanUser(rid, "totp_confirm");
    if (!g.ok) return g.res;
    // The gen fence is re-read right before commit; a concurrent reset/bump makes the child's
    // CAS answer `stale` instead of enrolling against the wrong generation (§5.2).
    const st = await g.store.get2faState(g.user.id);
    const r = await g.store.commitTotp({ userId: g.user.id, code, expectedGen: st.factorGen, now: now() });
    if (!r.ok) {
      const failCode = r.reason === "bad" ? "E_2FA_CODE" : r.reason === "stale" ? "E_2FA_STALE" : "E_2FA_NONE";
      const message =
        r.reason === "bad"
          ? "the code did not match"
          : r.reason === "stale"
            ? "2FA state changed; start over"
            : "no pending TOTP enrollment";
      return tfaFail(rid, "totp_confirm", failCode, message);
    }
    auditTfa("totp_confirm", true);
    emitSecurity({ type: "2fa-changed", op: "totp_confirm" });
    // P0 addendum #4 (B contract): an existing recovery set is NEVER regenerated by commitTotp —
    // it then returns `recoveryCodes: []`, which maps to the frozen `{kind:"ok"}` variant (the
    // `totp_confirm` variant requires exactly 10 codes and would be unfillable).
    return {
      t: "tfa_res",
      rid,
      ok: true,
      data: r.recoveryCodes.length === 0 ? { kind: "ok" } : { kind: "totp_confirm", recoveryCodes: r.recoveryCodes },
    };
  }

  async function handleTfaFeishu(rid: string, on: boolean): Promise<TfaResFrame> {
    const g = await requireLanUser(rid, "feishu");
    if (!g.ok) return g.res;
    if (on && deps.feishuOwner !== undefined && !deps.feishuOwner()) {
      return tfaFail(rid, "feishu", "E_NO_FEISHU", "no confirmed Feishu bot owner");
    }
    const r = await g.store.setFeishu2fa({ userId: g.user.id, on, now: now() });
    auditTfa("feishu", true);
    emitSecurity({ type: "2fa-changed", op: "feishu" });
    // P0 decision: a first Feishu-only enrollment returns the freshly issued recovery codes in
    // the `recovery_regen` variant (secrets stay in the three permitted variants).
    return {
      t: "tfa_res",
      rid,
      ok: true,
      data: r.recoveryCodes === undefined ? { kind: "ok" } : { kind: "recovery_regen", recoveryCodes: r.recoveryCodes },
    };
  }

  async function handleTfaRecoveryRegen(rid: string): Promise<TfaResFrame> {
    const g = await requireLanUser(rid, "recovery_regen");
    if (!g.ok) return g.res;
    let r: { recoveryCodes: string[] };
    try {
      r = await g.store.regenRecovery(g.user.id, now());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("E_2FA_NONE")) return tfaFail(rid, "recovery_regen", "E_2FA_NONE", "2FA is not enrolled");
      throw err;
    }
    auditTfa("recovery_regen", true);
    emitSecurity({ type: "2fa-changed", op: "recovery_regen" });
    return { t: "tfa_res", rid, ok: true, data: { kind: "recovery_regen", recoveryCodes: r.recoveryCodes } };
  }

  async function handleTfaReset(rid: string): Promise<TfaResFrame> {
    const g = await requireLanUser(rid, "reset");
    if (!g.ok) return g.res;
    await g.store.reset2fa(g.user.id, now());
    auditTfa("reset", true);
    emitSecurity({ type: "2fa-changed", op: "reset" });
    return { t: "tfa_res", rid, ok: true, data: { kind: "ok" } };
  }

  async function handleTfaForgetIps(rid: string): Promise<TfaResFrame> {
    const g = await requireLanUser(rid, "forget_ips");
    if (!g.ok) return g.res;
    await g.store.forgetLoginIps();
    auditTfa("forget_ips", true);
    emitSecurity({ type: "2fa-changed", op: "forget_ips" });
    return { t: "tfa_res", rid, ok: true, data: { kind: "ok" } };
  }

  async function handleTfaRepair(rid: string): Promise<TfaResFrame> {
    // §5.2: repair is the maintenance op for exactly the situation where the LAN store is OFF
    // (db-invalid) — it must NOT go through requireLanUser. B's repairLan2fa recreates empty 2FA
    // tables, clears `twofa_users`, keeps user_version=2.
    if (deps.repair2fa === undefined) return tfaFail(rid, "repair", "E_UNSUPPORTED", "2FA repair is not wired");
    const r = await deps.repair2fa();
    // B contract (binding): `repairLan2fa` writes the `phase:"admin"` repair audit ITSELF —
    // admin.ts must not emit a duplicate on either outcome once the op was invoked. The
    // `2fa-changed` security event remains ours (injected emit dep).
    if (!r.ok) {
      return {
        t: "tfa_res",
        rid,
        ok: false,
        code: "E_DB",
        message: `repair failed: ${r.reason}${r.detail === undefined ? "" : ` (${r.detail})`}`,
      };
    }
    emitSecurity({ type: "2fa-changed", op: "repair" });
    return { t: "tfa_res", rid, ok: true, data: { kind: "ok" } };
  }

  function noLan(rid: string, op: string, meta: AdminMeta): LanResFrame {
    audit(op, { ok: false, code: "E_NO_LAN" }, meta);
    return { t: "lan_res", rid, ok: false, code: "E_NO_LAN", message: "LAN is not configured" };
  }

  async function handleInfo(rid: string, meta: AdminMeta): Promise<LanResFrame> {
    const store = deps.store();
    if (!deps.hasLan() || store === undefined) return noLan(rid, "info", meta);
    const info = await store.initialInfo();
    const lan = currentLanStatus();
    if (info === undefined) {
      audit("info", { ok: false, code: "E_NO_USER" }, meta);
      return { t: "lan_res", rid, ok: false, code: "E_NO_USER", message: "no LAN user exists yet" };
    }
    // §5.2 "提醒": the first time anyone signs in with the initial password gets its own audit
    // line (never repeated for this hub process — status.warnings / lan_req info's own
    // `initialLogin` field already carry the persistent reminder on every subsequent call).
    if (info.initialLogin !== undefined && !announcedInitialLogin) {
      announcedInitialLogin = true;
      deps.log.warn("web-hub: the initial password was used to sign in", {
        audit: "admin",
        op: "initial-login",
        ip: info.initialLogin.ip,
        at: info.initialLogin.at,
      });
    }
    audit(
      "info",
      { ok: true, initialPasswordReturned: info.initialPassword !== undefined, username: info.username },
      meta,
    );
    return {
      t: "lan_res",
      rid,
      ok: true,
      info: {
        username: info.username,
        ...(info.initialPassword === undefined ? {} : { initialPassword: info.initialPassword }),
        ...(info.initialLogin === undefined ? {} : { initialLogin: info.initialLogin }),
        lan,
      },
    };
  }

  async function handlePasswd(rid: string, username: string, password: string, meta: AdminMeta): Promise<LanResFrame> {
    const store = deps.store();
    const kdf = deps.kdf();
    if (!deps.hasLan() || store === undefined || kdf === undefined) return noLan(rid, "passwd", meta);
    if (
      username.trim().length === 0 ||
      (username.includes(":") && (await store.getUser(username)) === undefined) ||
      password.length < MIN_LAN_PASSWORD_LENGTH
    ) {
      audit("passwd", { ok: false, code: "E_BAD_REQUEST" }, meta);
      return {
        t: "lan_res",
        rid,
        ok: false,
        code: "E_BAD_REQUEST",
        message: `username must be non-empty and must not contain :; password must be at least ${MIN_LAN_PASSWORD_LENGTH} characters`,
      };
    }
    const params = defaultKdfParams();
    const hash = await kdf.run(password, params);
    // §4.2 "撤销的顺序": `setPassword`'s own transaction already bumps epoch, clears
    // initial_password and deletes every session for that user (db-child.ts) — revoke only
    // needs to happen *after* that commit, before this op's own reply.
    await store.setPassword({
      username,
      kdf: "scrypt",
      n: params.n,
      r: params.r,
      p: params.p,
      salt: params.salt,
      hash,
    });
    const user = await store.getUser(username);
    if (user !== undefined) deps.lan()?.revoke({ userId: user.id });
    audit("passwd", { ok: true, username }, meta);
    // §4.2 emit seam (P0 addendum item 6): after the commit, never before.
    emitSecurity({ type: "passwd" });
    return { t: "lan_res", rid, ok: true };
  }

  async function handleUnlock(rid: string, meta: AdminMeta): Promise<LanResFrame> {
    const limiter = deps.limiter();
    if (!deps.hasLan() || limiter === undefined) return noLan(rid, "unlock", meta);
    limiter.unlock();
    audit("unlock", { ok: true }, meta);
    return { t: "lan_res", rid, ok: true };
  }

  return {
    caps(): string[] {
      const base = deps.hasLan() ? ["ctl.v1", "lan.v1"] : ["ctl.v1"];
      // P0: never advertise TFA before the agent-server tfa_req routing exists (I flips the flag
      // in the same merge that adds the dispatch). Absent flag ⇒ byte-identical cap list.
      return deps.advertiseTfa === true ? [...base, LAN_2FA_HUB_CAP] : base;
    },

    async handleLanReq(frame, meta) {
      try {
        switch (frame.op) {
          case "info":
            return await handleInfo(frame.rid, meta);
          case "passwd":
            return await handlePasswd(frame.rid, frame.username, frame.password, meta);
          case "unlock":
            return await handleUnlock(frame.rid, meta);
        }
      } catch (err) {
        deps.log.error("web-hub admin: lan_req handler threw", sanitizedErrorFields(err));
        audit(frame.op, { ok: false, code: "E_INTERNAL" }, meta);
        return { t: "lan_res", rid: frame.rid, ok: false, code: "E_INTERNAL", message: "internal error" };
      }
    },

    async handleTfaReq(frame, _meta) {
      try {
        switch (frame.op) {
          case "status":
            return await handleTfaStatus(frame.rid);
          case "totp_begin":
            return await handleTfaBegin(frame.rid, frame.replace === true);
          case "totp_confirm":
            return await handleTfaConfirm(frame.rid, frame.code);
          case "feishu":
            return await handleTfaFeishu(frame.rid, frame.on);
          case "recovery_regen":
            return await handleTfaRecoveryRegen(frame.rid);
          case "reset":
            return await handleTfaReset(frame.rid);
          case "forget_ips":
            return await handleTfaForgetIps(frame.rid);
          case "repair":
            return await handleTfaRepair(frame.rid);
        }
      } catch (err) {
        deps.log.error("web-hub admin: tfa_req handler threw", sanitizedErrorFields(err));
        auditTfa(frame.op, false);
        return { t: "tfa_res", rid: frame.rid, ok: false, code: "E_INTERNAL", message: "internal error" };
      }
    },

    handleShutdown(meta, reason) {
      audit(reason === "stop" ? "stop" : "shutdown", { ok: true }, meta);
      deps.shutdown(reason);
    },

    async handleRotateToken(meta) {
      const now = deps.now?.() ?? Date.now();
      const auth = deps.auth();
      let intent: RotateIntent = {
        v: 1,
        id: newRotateIntentId(),
        at: now,
        by: "hub",
        pid: process.pid,
        phase: "intent",
      };
      try {
        writeRotateIntentSync(deps.rotateIntentFile, intent);
      } catch (err) {
        deps.log.error("web-hub admin: rotate_token intent write failed", sanitizedErrorFields(err));
        audit("rotate_token", { ok: false, path: "online", code: "E_INTENT_WRITE" }, meta);
        throw err;
      }
      // ② atomic token replace — also clears the in-memory loopback session map + bumps `authGen`.
      const { token, revoked: loopback } = auth.rotateToken();
      try {
        intent = advanceRotateIntentSync(deps.rotateIntentFile, intent, "token-written");
      } catch (err) {
        // Best effort: the intent stays at phase `"intent"` on disk, which the recovery scan
        // (startup or periodic) treats identically — it will redo the (idempotent) token replace
        // and finish invalidation on our behalf.
        deps.log.warn("web-hub admin: rotate_token intent advance failed; recovery scan will finish it", {
          error: String(err),
        });
      }
      // ④ invalidate everything: loopback SSE, LAN session rows + LAN SSE, lanRevokeGen.
      deps.revokeLoopbackSse();
      let lan = 0;
      if (deps.hasLan()) {
        lan = (await deps.revokeLanSessions()) ?? 0;
        deps.revokeLanSse();
        deps.bumpLanRevokeGen();
      }
      // ⑤ delete intent.
      try {
        removeRotateIntentSync(deps.rotateIntentFile);
      } catch (err) {
        deps.log.warn("web-hub admin: rotate_token intent delete failed; recovery scan will retry", {
          error: String(err),
        });
      }
      audit(
        "rotate_token",
        { ok: true, path: "online", by: "hub", phase: "token-written", revoked: { loopback, lan } },
        meta,
      );
      return { token, revoked: { loopback, lan } };
    },
  };
}

// ---------------------------------------------------------------------------
// §6.7.1 hub-startup / periodic rotate-intent recovery (C8)
// ---------------------------------------------------------------------------

export interface RotateRecoveryDeps {
  paths: { tokenFile: string; rotateIntentFile: string };
  log: HubLog;
  hasLan: boolean;
  /** `undefined` ⇒ LAN isn't configured, or its store isn't built/ready yet — either way this
   * recovery pass cannot complete the LAN half and must fail closed (`lanBlocked: true`). */
  revokeLan?: () => Promise<number>;
  now?: () => number;
  /** §6.7.1 audit row (`{"audit":"admin","op":"rotate_token","path":"recovery",…}`) — the caller
   * (hub.ts) binds the log line; recoveries used to leave no audit trail at all (C8 review). */
  audit?: (fields: Record<string, unknown>) => void;
}

export interface RotateRecoveryOutcome {
  /** An intent was present/unreadable and at least the token half got recovered. `false` ⇒
   * nothing to do (the common case — `absent`). */
  recovered: boolean;
  lanRevoked?: number;
  /** LAN is configured but the revoke couldn't complete (unavailable/threw) — the caller MUST
   * keep the LAN listener off (`rotate-pending`) and leave the intent file in place for the next
   * recovery pass; loopback is unaffected (already fixed) and stays usable. */
  lanBlocked?: boolean;
}

/**
 * Plan §6.7.1 "hub 启动"/"hub 运行期" rows, shared by both: read the rotate intent once
 * (never cached), and if present/unreadable, finish whichever steps of ①–⑤ didn't complete
 * before a crash — re-mint the token (idempotent: `phase:"intent"` can't tell whether the token
 * was already swapped, so it always swaps again), advance the intent, revoke every LAN session
 * row, then delete the intent. Loopback sessions need no recovery action here: they are pure
 * in-memory state that starts empty on every fresh hub process regardless of whether a rotation
 * was interrupted (§6.7.1: "内存会话本就为空"). `phase:"token-written"` skips the token swap and only
 * finishes ④→⑤ (“保留 token，只做 ④ → ⑤”).
 */
export async function recoverRotateIntent(deps: RotateRecoveryDeps): Promise<RotateRecoveryOutcome> {
  cleanupTokenTemps(deps.paths.tokenFile);
  cleanupRotateIntentTemps(deps.paths.rotateIntentFile);
  const read = readRotateIntentSync(deps.paths.rotateIntentFile);
  if (read.state === "absent") return { recovered: false };
  const now = deps.now?.() ?? Date.now();
  // §6.7.1: an unreadable intent is treated exactly like `phase:"intent"` (fail-closed) — its
  // original id/at/by can't be recovered, so a fresh record is minted purely for bookkeeping.
  let intent: RotateIntent =
    read.state === "present"
      ? read.intent
      : { v: 1, id: newRotateIntentId(), at: now, by: "hub", pid: process.pid, phase: "intent" };
  if (intent.phase === "intent") {
    try {
      replaceTokenAtomic(deps.paths.tokenFile, generateToken());
      intent = advanceRotateIntentSync(deps.paths.rotateIntentFile, intent, "token-written");
    } catch (err) {
      deps.log.error("web-hub admin: rotate-intent token recovery failed", { error: String(err) });
      deps.audit?.({ ok: false, path: "recovery", phase: "intent", code: "E_TOKEN_RECOVER" });
      return { recovered: true, lanBlocked: deps.hasLan };
    }
  }
  if (deps.hasLan) {
    if (deps.revokeLan === undefined) {
      deps.audit?.({ ok: false, path: "recovery", phase: "token-written", code: "E_LAN_UNAVAILABLE" });
      return { recovered: true, lanBlocked: true };
    }
    let lanRevoked: number;
    try {
      lanRevoked = await deps.revokeLan();
    } catch (err) {
      deps.log.error("web-hub admin: rotate-intent LAN revoke failed during recovery", { error: String(err) });
      deps.audit?.({ ok: false, path: "recovery", phase: "token-written", code: "E_LAN_REVOKE" });
      return { recovered: true, lanBlocked: true };
    }
    try {
      removeRotateIntentSync(deps.paths.rotateIntentFile);
    } catch (err) {
      deps.log.warn("web-hub admin: rotate-intent delete failed after LAN recovery", { error: String(err) });
      deps.audit?.({
        ok: false,
        path: "recovery",
        phase: "token-written",
        code: "E_INTENT_DELETE",
        revoked: { lan: lanRevoked },
      });
      return { recovered: true, lanRevoked, lanBlocked: true };
    }
    deps.audit?.({ ok: true, path: "recovery", by: intent.by, phase: "token-written", revoked: { lan: lanRevoked } });
    return { recovered: true, lanRevoked };
  }
  try {
    removeRotateIntentSync(deps.paths.rotateIntentFile);
  } catch (err) {
    deps.log.warn("web-hub admin: rotate-intent delete failed after recovery (no LAN)", { error: String(err) });
    deps.audit?.({
      ok: false,
      path: "recovery",
      by: intent.by,
      phase: "token-written",
      code: "E_INTENT_DELETE",
      revoked: { lan: 0 },
    });
    return { recovered: true };
  }
  deps.audit?.({ ok: true, path: "recovery", by: intent.by, phase: "token-written", revoked: { lan: 0 } });
  return { recovered: true };
}
