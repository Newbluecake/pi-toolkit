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
 */
import type { LanReqFrame, LanResFrame } from "../protocol/messages.js";
// L8 "密码 ≥10 位": shared with the TUI `/webhub passwd` client-side precheck
// (`agent/passwd-prompt.ts`'s `MIN_LAN_PASSWORD_LENGTH`) so a password the client accepts is
// never turned around and rejected by the hub — review fix, this used to be a locally-defined 8.
import { MIN_LAN_PASSWORD_LENGTH } from "../protocol/lan.js";
import { defaultKdfParams } from "./kdf.js";
import type { HubLog, KdfPort, LanFacade, LanStatus, LanStorePort, LoginLimiterPort } from "./ports.js";

export interface AdminMeta {
  agentKey: string;
  agentPid?: number;
}

export interface AdminHandler {
  /** `hello_ack.caps` (§8.1): `"ctl.v1"` always, `"lan.v1"` once LAN is configured. */
  caps(): string[];
  handleLanReq(frame: LanReqFrame, meta: AdminMeta): Promise<LanResFrame>;
  /** Caller (`agent-server.ts`) sends the `hub_ctl_ack` itself *before* calling this — this
   * function only triggers the actual close, fire-and-forget from the caller's perspective. */
  handleShutdown(meta: AdminMeta): void;
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
    if (username.trim().length === 0 || password.length < MIN_LAN_PASSWORD_LENGTH) {
      audit("passwd", { ok: false, code: "E_BAD_REQUEST" }, meta);
      return {
        t: "lan_res",
        rid,
        ok: false,
        code: "E_BAD_REQUEST",
        message: `username must be non-empty and password must be at least ${MIN_LAN_PASSWORD_LENGTH} characters`,
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
      return deps.hasLan() ? ["ctl.v1", "lan.v1"] : ["ctl.v1"];
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

    handleShutdown(meta) {
      audit("shutdown", { ok: true }, meta);
      deps.shutdown("restart");
    },
  };
}
