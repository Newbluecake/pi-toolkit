/** LAN security r2 §5.4–5.6: one checked completion, instance-local challenges and budgets.
 * HTTP/CSRF/cookie parsing and finish-hook registration belong to the integrator. */
import { createHash, randomBytes } from "node:crypto";
import {
  LAN_2FA_COOKIE,
  LAN_2FA_LIMITS as L,
  NEW_IP_WINDOW_MS,
  TOTP_CODE_RE,
  normalizeRecoveryCode,
  type LanFactorBody,
  type LanLoginMethod,
  type LanLoginResponse,
} from "../protocol/lan-2fa.js";
import { auditLan2fa } from "./audit.js";
import type { AuthRevokeEvent } from "./auth-revoke.js";
import { formatLanCookie, hashSid, kdfMatches } from "./lan-auth.js";
import { createReqDeadline, type ReqDeadline } from "./req-deadline.js";
import type {
  LanLoginCore,
  LanLoginCoreDeps,
  LanUserRecord,
  LoginApprovalCloseReason,
  LoginIo,
  LoginReply,
  PortOptions,
  RequestContext,
} from "./ports.js";
export type { LanLoginCore, LanLoginCoreDeps, LoginIo, LoginReply, LoginApprovalPort } from "./ports.js";

type Method = LanFactorBody["method"];
type State = "pending" | "verifying" | "claimed" | "done" | "dead";
type DeadReason = Exclude<LoginApprovalCloseReason, "success">;
interface PasswordRun {
  user?: LanUserRecord;
  revoked: boolean;
}
interface Waiter {
  settled: boolean;
  wake(result: "approved" | "pending" | "denied" | "expired"): void;
}
interface Challenge {
  idHash: string;
  user: LanUserRecord;
  factorGen: number;
  ctx: RequestContext;
  ua: string;
  uaHash: string;
  knownAtGate: boolean;
  expiresAt: number;
  attemptsLeft: number;
  state: State;
  reason?: DeadReason;
  totp: boolean;
  recovery: boolean;
  approval?: { gen: number; state: "sending" | "pending" | "approved" | "expired"; expiresAt: number };
  waiter?: Waiter;
  expiryTimer?: ReturnType<typeof setTimeout>;
  approvalTimer?: ReturnType<typeof setTimeout>;
}
interface Attempt {
  at: number;
}
interface Window {
  entries: Attempt[];
  alerted: boolean;
}
interface UserWindows {
  totp: Window;
  recovery: Window;
}

/** Budget for the best-effort initial-password wipe on the login completion path. */
const INITIAL_CLEAR_BUDGET_MS = 2_000;

/** #66 D4: the generated password is still the account's password iff `initial_created_at` (or a
 * legacy plaintext) is set — `setPassword` NULLs both. */
export function initialPasswordInUse(user: Pick<LanUserRecord, "initialPassword" | "initialCreatedAt">): boolean {
  return user.initialCreatedAt !== undefined || user.initialPassword !== undefined;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
function deviceLabel(ua: string): string {
  // Labels only: never send raw UA (including attacker-supplied suffixes) to alerts.
  const os = /Android/i.test(ua)
    ? "Android"
    : /iPhone|iPad/i.test(ua)
      ? "iOS"
      : /Windows/i.test(ua)
        ? "Windows"
        : /Macintosh|Mac OS/i.test(ua)
          ? "macOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : "Unknown";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  return `${os} · ${browser}`;
}
function factorCookie(token: string, ctx: RequestContext, clear = false): string {
  return `${LAN_2FA_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api/login; Max-Age=${clear ? 0 : 300}${ctx.scheme === "https" ? "; Secure" : ""}`;
}
function reply(status: number, body: LanLoginResponse): LoginReply {
  return { status, body };
}
function error(status: number, code: Extract<LanLoginResponse, { error: string }>["error"]): LoginReply {
  return reply(status, { error: code } as LanLoginResponse);
}
function portCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") return err.code;
  return err instanceof Error ? err.message : "E_DB";
}
function failure(err: unknown): LoginReply {
  const code = portCode(err);
  return error(503, code === "E_DEADLINE" ? "E_DEADLINE" : code === "E_BUSY" || code === "E_RATE" ? "E_RATE" : "E_DB");
}

/** Unlike the shared clock-only deadline helper, this race clears its timer and abort listener.
 * The REAL promise retains its own accounting. Late results run only the supplied cleanup. */
async function step<T>(
  io: LoginIo,
  ms: number,
  op: (opts: PortOptions) => Promise<T>,
  late?: (value: T) => void,
): Promise<T> {
  if (ms <= 0) throw new Error("E_DEADLINE");
  if (io.signal.aborted || !io.responseOpen()) throw new Error("E_ABORTED");
  const abort = new AbortController();
  let voided = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const stop = new Promise<never>((_, reject) => {
    onAbort = () => {
      voided = true;
      abort.abort();
      reject(new Error("E_ABORTED"));
    };
    io.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      voided = true;
      abort.abort();
      reject(new Error("E_DEADLINE"));
    }, ms);
    timer.unref();
  });
  try {
    const real = Promise.resolve().then(() => {
      if (abort.signal.aborted) throw new Error("E_ABORTED");
      return op({ signal: abort.signal });
    });
    // Installed before racing: a dispatched IPC may ignore cancellation entirely.
    const observed = real.then((value) => {
      if (voided) late?.(value);
      return value;
    });
    return await Promise.race([observed, stop]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    io.signal.removeEventListener("abort", onAbort);
  }
}

export function createLanLoginCore(deps: LanLoginCoreDeps): LanLoginCore {
  const challenges = new Map<string, Challenge>();
  // Never evict an unexpired attempt window: capacity refuses new users fail-closed.
  const windows = new Map<number, UserWindows>();
  const passwordRuns = new Set<PasswordRun>();
  // Bounded send/finish-gap abort subscriptions; finish or dispose tears them down.
  const finishing = new Set<() => void>();
  let completing = 0;
  let disposed = false;

  function revokeHash(sidHash: string): void {
    deps.authRevoke.emit({ sel: { sidTag: sidHash }, reason: "logout" });
    deps.revokeSse(sidHash);
  }
  function cleanupSession(sid: string): void {
    const sidHash = hashSid(sid);
    revokeHash(sidHash);
    // Best effort, bounded logical wait. The store owns physical IPC settlement.
    const io: LoginIo = { ua: "", signal: new AbortController().signal, responseOpen: () => true };
    void step(io, 8_000, (opts) => deps.store.deleteSession(sidHash, opts))
      .catch(() => deps.log.error("web-hub lan login: session cleanup failed"))
      .finally(() => revokeHash(sidHash));
  }
  function closeApproval(ch: Challenge, why: LoginApprovalCloseReason): void {
    if (ch.approvalTimer !== undefined) {
      clearTimeout(ch.approvalTimer);
      delete ch.approvalTimer;
    }
    try {
      deps.approval.close(ch.idHash, why);
    } catch {
      deps.log.error("web-hub lan login: approval close failed");
    }
  }
  function dead(ch: Challenge, reason: DeadReason): void {
    if (ch.state === "dead" || ch.state === "done") return;
    ch.state = "dead";
    ch.reason = reason;
    if (ch.expiryTimer !== undefined) {
      clearTimeout(ch.expiryTimer);
      delete ch.expiryTimer;
    }
    closeApproval(ch, reason);
    ch.waiter?.wake(reason === "deny" ? "denied" : "expired");
    auditLan2fa(deps.log, { phase: "dead", ip: ch.ctx.clientIp, user: ch.user.username, ok: false, reason });
  }
  function wakeApproval(ch: Challenge): void {
    if (ch.waiter && !ch.waiter.settled && ch.state === "pending" && ch.approval?.state === "approved") {
      // Claim synchronously BEFORE resolving the waiter; no factor can win the await gap.
      ch.state = "claimed";
      ch.waiter.wake("approved");
    }
  }
  function prune(): void {
    const now = deps.now();
    for (const [key, ch] of challenges) {
      if (ch.expiresAt <= now) {
        dead(ch, "expire");
        challenges.delete(key);
      }
    }
    for (const [userId, w] of windows) {
      for (const method of ["totp", "recovery"] as const) {
        w[method].entries = w[method].entries.filter((a) => a.at > now - L.methodWindowMs);
        if (w[method].entries.length < L.methodAttempts) w[method].alerted = false;
      }
      if (!w.totp.entries.length && !w.recovery.entries.length) windows.delete(userId);
    }
  }
  function lookup(token: string, ctx: RequestContext, ua: string): Challenge | LoginReply {
    // Binding checks must precede expiry, limiter, method and budget checks.
    const ch = challenges.get(digest(token));
    if (
      !ch ||
      ch.ctx.clientIp !== ctx.clientIp ||
      ch.ctx.externalOrigin !== ctx.externalOrigin ||
      ch.uaHash !== digest(ua)
    )
      return error(409, "E_2FA_EXPIRED");
    if (ch.expiresAt <= deps.now()) {
      dead(ch, "expire");
      return error(409, "E_2FA_EXPIRED");
    }
    const admit = deps.limiter.admit(ctx.clientIp);
    if (!admit.ok) return locked(admit);
    return ch;
  }
  function stateError(ch: Challenge): LoginReply | undefined {
    return ch.state === "done"
      ? error(409, "E_2FA_USED")
      : ch.state === "dead"
        ? error(409, "E_2FA_EXPIRED")
        : ch.state !== "pending"
          ? error(409, "E_2FA_BUSY")
          : undefined;
  }
  function locked(admit: { retryAfterMs: number; saturated?: boolean }): LoginReply {
    return {
      status: 429,
      body: {
        error: admit.saturated ? "E_RATE" : "E_LOCKED",
        retryAfterMs: admit.retryAfterMs,
        ...(admit.saturated ? { saturated: true } : {}),
      },
      headers: { "Retry-After": String(Math.ceil(admit.retryAfterMs / 1000)) },
    };
  }
  function reserve(ch: Challenge, method: Method): { refund(): void } | LoginReply {
    prune();
    let w = windows.get(ch.user.id);
    if (!w) {
      if (windows.size >= 256) return error(503, "E_RATE");
      w = { totp: { entries: [], alerted: false }, recovery: { entries: [], alerted: false } };
      windows.set(ch.user.id, w);
    }
    const window = w[method];
    if (window.entries.length >= L.methodAttempts) {
      if (!window.alerted) {
        window.alerted = true;
        deps.security.emit({ type: "login-2fa-burst", kind: method });
      }
      return error(429, "E_2FA_METHOD_LOCKED");
    }
    const attempt: Attempt = { at: deps.now() };
    window.entries.push(attempt);
    ch.attemptsLeft--;
    return {
      refund() {
        const index = window.entries.indexOf(attempt);
        if (index >= 0) window.entries.splice(index, 1);
        ch.attemptsLeft++;
        window.alerted = false;
      },
    };
  }
  function live(io: LoginIo, run?: PasswordRun, ch?: Challenge): boolean {
    return !disposed && !io.signal.aborted && io.responseOpen() && !run?.revoked && (!ch || ch.state === "claimed");
  }

  /**
   * #66 D4: first successful sign-in with the auto-generated password records the login and
   * wipes the plaintext in ONE store statement. Best-effort by design — a failure here must never
   * turn an authenticated login into a 503 (the next login simply retries). Aborts/disposal are
   * still honoured by the `live()` check that follows the call.
   */
  async function clearInitialPassword(
    io: LoginIo,
    user: LanUserRecord,
    ip: string,
    deadline: ReqDeadline,
  ): Promise<void> {
    try {
      const out = await step(io, Math.min(deadline.remaining(), INITIAL_CLEAR_BUDGET_MS), (opts) =>
        deps.store.markInitialLogin(user.username, ip, deps.now(), opts),
      );
      if (out !== undefined && out !== null && out.cleared === true) {
        try {
          deps.store.requestCheckpointTruncate?.();
        } catch {
          /* checkpoint is a fire-and-forget hardening step */
        }
      }
    } catch (err) {
      try {
        // Only a normalised E_* code: raw store errors must never reach the log.
        const code = /^E_[A-Z0-9_]{1,32}/.exec(portCode(err))?.[0] ?? "E_DB";
        deps.log.warn("web-hub lan login: initial-password-clear-failed", { code });
      } catch {
        /* logging must not affect the login */
      }
    }
  }

  /** The ONLY checked INSERT caller. Every pre-send failure revokes an inserted/late sid. */
  async function complete(
    user: LanUserRecord,
    factorGen: number,
    method: LanLoginMethod,
    ctx: RequestContext,
    ua: string,
    knownAtGate: boolean,
    io: LoginIo,
    deadline: ReqDeadline,
    ch?: Challenge,
    run?: PasswordRun,
    recoveryLeft?: number,
  ): Promise<LoginReply> {
    let sid: string | undefined;
    let reserved = false;
    try {
      if (!live(io, run, ch)) throw new Error("E_ABORTED");
      if (finishing.size + completing >= 64) throw new Error("E_BUSY");
      completing++;
      reserved = true;
      const inserted = await step(
        io,
        deadline.remaining(),
        (opts) => {
          // Repeat immediately at dispatch, not merely before the promise/microtask boundary.
          if (!live(io, run, ch)) throw new Error("E_ABORTED");
          return deps.store.createSessionChecked(
            {
              userId: user.id,
              expectedEpoch: user.epoch,
              expectedFactorGen: factorGen,
              boundOrigin: ctx.externalOrigin,
              createdIp: ctx.clientIp,
              ua: ua.slice(0, 512),
              method,
              now: deps.now(),
            },
            opts,
          );
        },
        (late) => {
          if (late.ok) {
            for (const hash of late.evicted) revokeHash(hash);
            cleanupSession(late.sid);
          }
        },
      );
      if (!inserted.ok) {
        if (ch) dead(ch, "revoked");
        return error(401, "E_AUTH");
      }
      sid = inserted.sid;
      for (const hash of inserted.evicted) revokeHash(hash);
      if (!live(io, run, ch)) throw new Error("E_ABORTED");
      if (user.initialPassword !== undefined) await clearInitialPassword(io, user, ctx.clientIp, deadline);
      if (!live(io, run, ch)) throw new Error("E_ABORTED");
      // Frozen port is synchronous; wrapping also bounds a misbehaving thenable adapter.
      await step(io, deadline.remaining(), async () => {
        deps.limiter.succeed(ctx.clientIp);
      });
      if (deadline.expired()) throw new Error("E_DEADLINE");
      if (!live(io, run, ch)) throw new Error("E_ABORTED");
      if (ch) {
        ch.state = "done";
        if (ch.expiryTimer !== undefined) {
          clearTimeout(ch.expiryTimer);
          delete ch.expiryTimer;
        }
        closeApproval(ch, "success");
        ch.waiter?.wake("expired");
      }
      auditLan2fa(deps.log, { phase: "complete", method, ip: ctx.clientIp, user: user.username, ok: true });
      // Keep the abort cleanup through the send/finish gap. It is independently bounded
      // if the integrator forgets to call after; after must NEVER be called on close.
      const successSid = sid;
      let finished = false;
      let cleaned = false;
      const onAbort = () => {
        if (!finished && !cleaned) {
          cleaned = true;
          cleanupSession(successSid);
        }
      };
      io.signal.addEventListener("abort", onAbort, { once: true });
      const disposeFinish = () => {
        onAbort();
        detachFinish();
      };
      const detachFinish = () => {
        clearTimeout(detach);
        io.signal.removeEventListener("abort", onAbort);
        finishing.delete(disposeFinish);
      };
      const detach = setTimeout(detachFinish, 8_000);
      detach.unref();
      finishing.add(disposeFinish);
      const historySidHash = hashSid(sid);
      let afterCalled = false;
      return {
        status: 200,
        body: { ok: true, initialPassword: initialPasswordInUse(user) },
        headers: {
          "Set-Cookie": [formatLanCookie(sid, { secure: ctx.scheme === "https" }), factorCookie("", ctx, true)],
        },
        after: async () => {
          if (afterCalled) return;
          afterCalled = true;
          finished = true;
          detachFinish();
          if (cleaned) return;
          const afterIo: LoginIo = { ua, signal: new AbortController().signal, responseOpen: () => true };
          try {
            await step(afterIo, 8_000, (opts) =>
              deps.store.noteLoginIp(user.id, ctx.clientIp, deps.now(), { ...opts, sidHash: historySidHash }),
            );
          } catch {
            deps.log.error("web-hub lan login: noteLoginIp failed");
          }
          deps.security.emit({
            type: "login-success",
            ip: ctx.clientIp,
            method,
            device: deviceLabel(ua),
            newIp: !knownAtGate,
          });
          if (method === "recovery") deps.security.emit({ type: "recovery-used", left: recoveryLeft ?? 0 });
        },
      };
    } catch (err) {
      if (sid) cleanupSession(sid);
      if (ch) {
        const code = portCode(err);
        // Frozen enum has no internal-error reason: dispose means failed completion
        // teardown; evict is capacity rejection. revoked is reserved for CAS/revoke.
        const reason: DeadReason =
          code === "E_DEADLINE"
            ? "deadline"
            : io.signal.aborted || !io.responseOpen()
              ? "client-gone"
              : code === "E_BUSY" || code === "E_RATE"
                ? "evict"
                : "dispose";
        auditLan2fa(deps.log, {
          phase: "complete",
          method,
          ip: ctx.clientIp,
          user: user.username,
          ok: false,
          code,
          reason,
        });
        dead(ch, reason);
      }
      return run?.revoked ? error(401, "E_AUTH") : failure(err);
    } finally {
      if (reserved) completing--;
    }
  }

  async function newChallenge(
    user: LanUserRecord,
    factor: { factorGen: number; totp: boolean; totpUsable?: boolean; feishu: boolean; recoveryLeft: number },
    ctx: RequestContext,
    ua: string,
    knownAtGate: boolean,
    io: LoginIo,
    deadline: ReqDeadline,
    run: PasswordRun,
  ): Promise<LoginReply> {
    prune();
    const peers = [...challenges.values()].filter((ch) => ch.ctx.clientIp === ctx.clientIp);
    if (peers.length >= L.perIp) {
      const oldest = peers[0]!;
      dead(oldest, "evict");
      challenges.delete(oldest.idHash);
    }
    if (challenges.size >= L.challenges) {
      const oldest = challenges.values().next().value!;
      dead(oldest, "evict");
      challenges.delete(oldest.idHash);
    }
    const token = randomBytes(32).toString("base64url");
    const ch: Challenge = {
      idHash: digest(token),
      user,
      factorGen: factor.factorGen,
      ctx,
      ua,
      uaHash: digest(ua),
      knownAtGate,
      expiresAt: deps.now() + L.challengeMs,
      attemptsLeft: L.attempts,
      state: "pending",
      totp: factor.totp && factor.totpUsable !== false,
      recovery: factor.recoveryLeft > 0,
    };
    challenges.set(ch.idHash, ch);
    ch.expiryTimer = setTimeout(() => {
      dead(ch, "expire");
      challenges.delete(ch.idHash);
    }, L.challengeMs);
    ch.expiryTimer.unref();
    const abort = () => dead(ch, "client-gone");
    io.signal.addEventListener("abort", abort, { once: true });
    let sent: "sent" | "unavailable" = "unavailable";
    try {
      if (factor.feishu) {
        ch.approval = { gen: 1, state: "sending", expiresAt: deps.now() + L.approvalMs };
        sent = await step(
          io,
          Math.min(L.approvalSendMs, deadline.remaining()),
          async () =>
            deps.approval.request({
              challengeId: ch.idHash,
              gen: 1,
              ip: ctx.clientIp,
              device: deviceLabel(ua),
              user: user.username,
              expiresAt: Math.min(ch.expiresAt, ch.approval!.expiresAt),
            }),
          () => closeApproval(ch, "deadline"),
        );
        if (sent === "sent" && ch.state !== "dead") {
          if (ch.approval.state === "sending") ch.approval.state = "pending";
          ch.approvalTimer = setTimeout(
            () => {
              if (ch.approval) ch.approval.state = "expired";
              closeApproval(ch, "expire");
            },
            Math.max(0, ch.approval.expiresAt - deps.now()),
          );
          ch.approvalTimer.unref();
        } else {
          ch.approval.state = "expired";
          closeApproval(ch, "expire");
        }
      }
    } catch (err) {
      if (io.signal.aborted || !io.responseOpen()) dead(ch, "client-gone");
      // Approval unavailability is not a gate bypass; remaining factors still required.
      if (ch.approval) ch.approval.state = "expired";
      closeApproval(ch, "deadline");
      if (deadline.expired()) {
        dead(ch, "deadline");
        return failure(err);
      }
    } finally {
      io.signal.removeEventListener("abort", abort);
    }
    if (run.revoked) dead(ch, "revoked");
    if (disposed || !io.responseOpen() || io.signal.aborted) dead(ch, "client-gone");
    if (ch.state === "dead") return error(409, "E_2FA_EXPIRED");
    const methods: Array<"totp" | "recovery" | "feishu"> = [];
    if (ch.totp) methods.push("totp");
    if (ch.recovery) methods.push("recovery");
    if (sent === "sent") methods.push("feishu");
    if (!methods.length) {
      dead(ch, "deadline");
      return error(503, "E_DB");
    }
    deps.security.emit({
      type: "login-2fa-challenge",
      ip: ctx.clientIp,
      device: deviceLabel(ua),
      cardSent: sent === "sent",
    });
    auditLan2fa(deps.log, { phase: "challenge", ip: ctx.clientIp, user: user.username, ok: true });
    return {
      status: 401,
      body: { error: "E_2FA", methods, feishu: sent, expiresAt: ch.expiresAt },
      headers: { "Set-Cookie": factorCookie(token, ctx) },
    };
  }

  return {
    async passwordLogin(ctx, body, ua, io) {
      if (disposed) return error(503, "E_DB");
      const admit = deps.limiter.admit(ctx.clientIp);
      if (!admit.ok) return locked(admit);
      if (passwordRuns.size >= 64) return error(503, "E_RATE");
      const run: PasswordRun = { revoked: false };
      passwordRuns.add(run);
      const raw = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      const username = typeof raw.username === "string" && raw.username.length ? raw.username : undefined;
      const password = typeof raw.password === "string" ? raw.password : "";
      try {
        // Rework ruling: preserve old fair scheduling; old limiters may omit isFresh.
        const fresh = deps.limiter.isFresh?.(ctx.clientIp) ?? true;
        const admission = await step(
          io,
          20_000,
          (opts) => deps.admission.acquire(ctx.clientIp, fresh, opts),
          (late) => {
            if (late.ok) late.release();
          },
        );
        if (!admission.ok) return locked({ ...admission, saturated: true });
        let released = false;
        let kdfStarted = false;
        const release = () => {
          if (!released) {
            released = true;
            admission.release();
          }
        };
        try {
          io.onAdmitted?.();
          const user =
            username === undefined ? undefined : await step(io, 8_000, (opts) => deps.store.getUser(username, opts));
          if (user) {
            run.user = { ...user }; // Snapshot epoch at password time, not after verification.
          }
          const matched = await step(io, 20_000, (opts) => {
            kdfStarted = true;
            return kdfMatches(
              run.user,
              password,
              {
                ...deps,
                onCorruptKdfParams:
                  deps.onCorruptKdfParams ?? (() => deps.log.error("web-hub lan login: corrupt kdf params")),
              },
              opts,
            ).finally(release);
          });
          if (!matched || !run.user) {
            deps.limiter.fail(ctx.clientIp);
            return error(401, "E_AUTH");
          }
        } finally {
          // A logical deadline does not free a physically busy KDF/admission slot.
          if (!kdfStarted) release();
        }
        const user = run.user!;
        const deadline = createReqDeadline(deps.now, L.postKdfMs);
        if (run.revoked || disposed) return error(401, "E_AUTH");
        deps.kdfUpgrader?.maybeRehash(user, password); // fire-and-forget, before the second-factor gate
        const known = await step(io, deadline.remaining() - L.completionReserveMs, (opts) =>
          deps.store.isKnownIp(user.id, ctx.clientIp, deps.now(), NEW_IP_WINDOW_MS, opts),
        );
        const knownAtGate = known && (!ctx.viaTrustedProxy || ctx.xffUsable === true);
        const factor = await step(io, deadline.remaining() - L.completionReserveMs, (opts) =>
          deps.store.get2faState(user.id, opts),
        );
        if (factor.state === "inconsistent") return error(503, "E_DB");
        if (run.revoked || disposed) return error(401, "E_AUTH");
        auditLan2fa(deps.log, { phase: "gate", method: "password", ip: ctx.clientIp, user: user.username, ok: true });
        if (deps.secondFactorEnabled !== false && factor.state === "enrolled" && !knownAtGate)
          return await newChallenge(user, factor, ctx, ua, knownAtGate, io, deadline, run);
        return await complete(user, factor.factorGen, "password", ctx, ua, knownAtGate, io, deadline, undefined, run);
      } catch (err) {
        return failure(err);
      } finally {
        passwordRuns.delete(run);
      }
    },
    async submitFactor(token, body, ctx, io) {
      const found = lookup(token, ctx, io.ua);
      if (!("idHash" in found)) return found;
      const ch = found;
      if (body.method !== "totp" && body.method !== "recovery") return error(400, "E_BAD_REQUEST");
      const code =
        typeof body.code !== "string"
          ? undefined
          : body.method === "totp"
            ? TOTP_CODE_RE.test(body.code)
              ? body.code
              : undefined
            : normalizeRecoveryCode(body.code);
      if (code === undefined) return error(400, "E_BAD_REQUEST");
      if (!(body.method === "totp" ? ch.totp : ch.recovery)) return error(429, "E_2FA_METHOD_LOCKED");
      const conflict = stateError(ch);
      if (conflict) return conflict;
      if (io.signal.aborted || !io.responseOpen()) {
        dead(ch, "client-gone");
        return error(409, "E_2FA_EXPIRED");
      }
      const reservation = reserve(ch, body.method);
      if ("status" in reservation) return reservation;
      ch.state = "verifying"; // Lock + both budget reservations before ANY await.
      const deadline = createReqDeadline(deps.now, L.factorMs);
      const abort = () => dead(ch, "client-gone");
      let dispatched = false;
      io.signal.addEventListener("abort", abort, { once: true });
      try {
        const verified = await step(io, deadline.remaining() - L.completionReserveMs, (opts) => {
          if (ch.state !== "verifying") throw new Error("E_ABORTED");
          const input = { userId: ch.user.id, code, expectedGen: ch.factorGen, now: deps.now() };
          dispatched = true;
          return body.method === "totp" ? deps.store.verifyTotp(input, opts) : deps.store.consumeRecovery(input, opts);
        });
        if (ch.state !== "verifying") return error(409, "E_2FA_EXPIRED");
        if (!verified.ok && verified.reason === "unavailable") reservation.refund();
        auditLan2fa(deps.log, {
          phase: "verify",
          method: body.method,
          ip: ctx.clientIp,
          user: ch.user.username,
          ok: verified.ok,
          ...(verified.ok ? {} : { reason: verified.reason }),
          left: ch.attemptsLeft,
        });
        if (!verified.ok) {
          if (verified.reason === "unavailable") {
            ch.state = "pending";
            wakeApproval(ch);
            return error(503, "E_DB");
          }
          deps.limiter.fail(ctx.clientIp);
          ch.state = "pending";
          if (ch.attemptsLeft === 0) dead(ch, "attempts");
          else wakeApproval(ch);
          return reply(401, { error: "E_2FA_CODE", attemptsLeft: ch.attemptsLeft });
        }
        ch.state = "claimed";
        return await complete(
          ch.user,
          ch.factorGen,
          body.method,
          ctx,
          io.ua,
          ch.knownAtGate,
          io,
          deadline,
          ch,
          undefined,
          verified.recoveryLeft,
        );
      } catch (err) {
        const code = portCode(err);
        // These two frozen DB codes mean rejection before verifier dispatch, so refund.
        if (code === "E_BUSY" || code === "E_RATE" || !dispatched) reservation.refund();
        if (ch.state === "verifying") {
          if (code === "E_DEADLINE") dead(ch, "deadline");
          else if (io.signal.aborted || !io.responseOpen()) dead(ch, "client-gone");
          else if (ch.attemptsLeft === 0) dead(ch, "attempts");
          else {
            ch.state = "pending";
            wakeApproval(ch);
          }
        }
        return failure(err);
      } finally {
        io.signal.removeEventListener("abort", abort);
      }
    },
    async waitApproval(token, ctx, io) {
      const found = lookup(token, ctx, io.ua);
      if (!("idHash" in found)) return found;
      const ch = found;
      if (!ch.approval || ch.approval.state === "sending") return error(429, "E_2FA_METHOD_LOCKED");
      if (ch.waiter) return error(409, "E_2FA_BUSY");
      const conflict = stateError(ch);
      if (conflict && ch.state !== "verifying") return conflict;
      if (io.signal.aborted || !io.responseOpen()) return error(409, "E_2FA_EXPIRED");
      const deadline = createReqDeadline(deps.now, L.waitHoldMs + L.waitReserveMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let ownsCompletion = false;
      const abort = () => {
        // A cancelled hold is just a cancelled poll, not a cancelled login.
        if (ownsCompletion) dead(ch, "client-gone");
        else ch.waiter?.wake("expired");
      };
      io.signal.addEventListener("abort", abort, { once: true });
      const waiterResult = new Promise<"approved" | "pending" | "denied" | "expired">((resolve) => {
        const waiter: Waiter = {
          settled: false,
          wake(result) {
            if (waiter.settled) return;
            waiter.settled = true;
            ownsCompletion = result === "approved";
            resolve(result);
          },
        };
        ch.waiter = waiter;
        timer = setTimeout(() => waiter.wake("pending"), L.waitHoldMs);
        timer.unref();
        wakeApproval(ch);
        // Expired cards still use the normal hold: recovery/TOTP may remain usable.
      });
      try {
        const result = await waiterResult;
        if (result !== "approved") return reply(200, { state: result });
        if (ch.state !== "claimed") return error(409, "E_2FA_EXPIRED");
        return await complete(ch.user, ch.factorGen, "feishu", ctx, io.ua, ch.knownAtGate, io, deadline, ch);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        delete ch.waiter;
        io.signal.removeEventListener("abort", abort);
      }
    },
    cancel(token, ctx) {
      const found = lookup(token, ctx, ctx.ua ?? "");
      if ("idHash" in found) dead(found, "cancel");
    },
    onApprovalDecision(idHash, allowed, gen) {
      const ch = challenges.get(idHash);
      if (
        !ch ||
        ch.state === "dead" ||
        ch.state === "done" ||
        !ch.approval ||
        ch.approval.gen !== gen ||
        ch.approval.state === "expired"
      )
        return;
      if (ch.expiresAt <= deps.now()) {
        dead(ch, "expire");
        return;
      }
      if (ch.approval.expiresAt <= deps.now()) {
        ch.approval.state = "expired";
        closeApproval(ch, "expire");
        return;
      }
      if (!allowed) {
        dead(ch, "deny");
        deps.limiter.fail(ch.ctx.clientIp);
        deps.security.emit({ type: "login-2fa-denied", ip: ch.ctx.clientIp });
        return;
      }
      ch.approval.state = "approved";
      wakeApproval(ch);
    },
    onRevoke(ev: AuthRevokeEvent) {
      const sel = ev.sel;
      const matches = (userId: number | undefined) =>
        sel === "all" || ("listener" in sel && sel.listener === "lan") || ("userId" in sel && sel.userId === userId);
      for (const run of passwordRuns) {
        if (matches(run.user?.id)) run.revoked = true;
        else if (!run.user && sel !== "all" && "userId" in sel) {
          // Conservative fence: any user-scoped revoke during an unresolved password
          // read invalidates that request. No unbounded per-user revocation history.
          run.revoked = true;
        }
      }
      for (const ch of challenges.values()) if (matches(ch.user.id)) dead(ch, "revoked");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const ch of challenges.values()) dead(ch, "dispose");
      for (const run of passwordRuns) run.revoked = true;
      for (const disposeFinish of [...finishing]) disposeFinish();
      challenges.clear();
      windows.clear();
    },
  };
}
