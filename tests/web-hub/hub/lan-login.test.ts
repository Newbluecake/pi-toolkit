import type { IncomingMessage, ServerResponse } from "node:http";
import { createLanSessionsRoutes } from "../../../src/web-hub/hub/lan-sessions.js";
import { publicSessionId } from "../../../src/web-hub/hub/sid-hash.js";
import { scryptSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKdfUpgrader } from "../../../src/web-hub/hub/kdf-upgrade.js";
import { KDF_PHASE2 } from "../../../src/web-hub/hub/kdf.js";
import { createLanLoginCore } from "../../../src/web-hub/hub/lan-login.js";
import { createAuthRevokeBus } from "../../../src/web-hub/hub/auth-revoke.js";
import { createSecurityEventBus, type SecurityEvent } from "../../../src/web-hub/hub/security-events.js";
import type {
  LanLoginCore,
  LanStorePort,
  LanUserRecord,
  LoginIo,
  RequestContext,
} from "../../../src/web-hub/hub/ports.js";
import { LAN_2FA_LIMITS as L } from "../../../src/web-hub/protocol/lan-2fa.js";
import {
  fakeKdf,
  fakeKdfAdmission,
  fakeLanStore,
  fakeLoginLimiter,
  type FakeLanStoreOptions,
} from "../contract/fakes.js";

function latch<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const UA = "Mozilla/5.0 (Linux) Chrome/130.0 SecretUA";
function context(ip = "192.168.1.10", extra: Partial<RequestContext> = {}): RequestContext {
  return {
    kind: "lan",
    peerIp: ip,
    clientIp: ip,
    viaTrustedProxy: false,
    scheme: "http",
    hostKey: "hub:7788",
    externalOrigin: "http://hub:7788",
    ua: UA,
    ...extra,
  };
}
function io() {
  const abort = new AbortController();
  let open = true;
  const value: LoginIo = { ua: UA, signal: abort.signal, responseOpen: () => open, onAdmitted: vi.fn() };
  return {
    value,
    abort,
    close: () => {
      open = false;
      abort.abort();
    },
    silentClose: () => {
      open = false;
    },
  };
}
async function flush() {
  for (let n = 0; n < 30; n++) await Promise.resolve();
}
const cores: LanLoginCore[] = [];
let wall = 1_800_000_000_000;
function setup(
  options: FakeLanStoreOptions = {},
  initial = false,
  kdfUpgrader?: import("../../../src/web-hub/hub/kdf-upgrade.js").KdfUpgrader,
) {
  const store = fakeLanStore(options);
  const salt = new Uint8Array(16).fill(7);
  const user: LanUserRecord = {
    id: 1,
    username: "owner",
    kdf: "scrypt",
    n: 16384,
    r: 1,
    p: 1,
    salt,
    hash: scryptSync("correct", salt, 32, { N: 16384, r: 1, p: 1 }),
    epoch: 4,
    createdAt: wall,
    updatedAt: wall,
    ...(initial ? { initialPassword: "correct" } : {}),
  };
  store.seedUser(user);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const limiter = fakeLoginLimiter();
  const fail = vi.spyOn(limiter, "fail"),
    succeed = vi.spyOn(limiter, "succeed");
  const events: SecurityEvent[] = [];
  const security = createSecurityEventBus(log);
  security.subscribe((event) => events.push(event));
  const revokes: string[] = [];
  const authRevoke = createAuthRevokeBus(log);
  authRevoke.subscribe((event) => {
    if (event.sel !== "all" && "sidTag" in event.sel) revokes.push(event.sel.sidTag);
  });
  const requests: Array<Parameters<import("../../../src/web-hub/hub/ports.js").LoginApprovalPort["request"]>[0]> = [];
  const approval = {
    request: vi.fn(async (c: (typeof requests)[number]) => {
      requests.push(c);
      return "sent" as "sent" | "unavailable";
    }),
    close: vi.fn(),
  };
  const revokeSse = vi.fn();
  const kdf = fakeKdf();
  const admission = fakeKdfAdmission();
  const core = createLanLoginCore({
    ...(kdfUpgrader === undefined ? {} : { kdfUpgrader }),
    store,
    kdf,
    // #66: the fixture user is seeded at N=2^14 r=1 — time against that shape (no compensation run).
    kdfPolicy: { verifyTarget: { n: 16384, r: 1, p: 1, keyLen: 32, saltBytes: 16 } },
    admission,
    limiter,
    approval,
    security,
    authRevoke,
    revokeSse,
    now: () => wall + Date.now(),
    log,
  });
  cores.push(core);
  const now = () => wall + Date.now();
  async function enroll(totp = false) {
    await store.setFeishu2fa({ userId: 1, on: true, now: now() });
    if (totp) {
      await store.beginTotp({ userId: 1, now: now() });
      const gen = (await store.get2faState(1)).factorGen;
      const result = await store.commitTotp({ userId: 1, code: "111111", expectedGen: gen, now: now() });
      expect(result.ok).toBe(true);
    }
  }
  async function challenge(ctx = context()) {
    const loginIo = io();
    const result = await core.passwordLogin(ctx, { username: "owner", password: "correct" }, UA, loginIo.value);
    expect(result.status).toBe(401);
    expect(result.body).toHaveProperty("error", "E_2FA");
    const cookies = result.headers?.["Set-Cookie"];
    expect(typeof cookies).toBe("string");
    const token = (cookies as string).split(";")[0]!.split("=")[1]!;
    return { token, result, ctx, loginIo };
  }
  async function password(ctx = context(), requestIo = io()) {
    return core.passwordLogin(ctx, { username: "owner", password: "correct" }, UA, requestIo.value);
  }
  return {
    core,
    store,
    user,
    log,
    limiter,
    fail,
    succeed,
    events,
    revokes,
    authRevoke,
    approval,
    requests,
    revokeSse,
    kdf,
    admission,
    now,
    enroll,
    challenge,
    password,
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  wall = 1_800_000_000_000;
});
afterEach(() => {
  for (const core of cores.splice(0)) core.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
});

// Real password KDF and fake store CAS are used; verifier seams accept only specific
// enrollment/login codes and reject malformed/bad/replayed inputs.
const totpStep = (_secret: string, code: string, now: number) =>
  code === "111111" || code === "222222" ? Math.floor(now / 30_000) : undefined;

describe("LAN login completion and post-finish effects", () => {
  it("unknown/incorrect passwords perform KDF but create neither session nor challenge", async () => {
    const h = setup();
    const kdf = vi.spyOn(h.kdf, "run");
    for (const username of ["owner", "missing"]) {
      const result = await h.core.passwordLogin(context(), { username, password: "wrong" }, UA, io().value);
      expect(result).toEqual({ status: 401, body: { error: "E_AUTH" } });
    }
    expect(kdf).toHaveBeenCalledTimes(2);
    expect(h.store.sessionsBySidHash.size).toBe(0);
    expect(h.fail).toHaveBeenCalledTimes(2);
    expect(h.events).toEqual([]);
  });
  it("unenrolled B succeeds from X but enrolled A still needs E_2FA from X", async () => {
    const h = setup();
    await h.enroll();
    h.store.seedUser({ ...h.user, id: 2, username: "other" });
    const result = await h.core.passwordLogin(context(), { username: "other", password: "correct" }, UA, io().value);
    expect(result.status).toBe(200);
    await result.after?.();
    expect(await h.store.isKnownIp(2, context().clientIp, h.now(), 30 * 86400000)).toBe(true);
    expect(await h.store.isKnownIp(1, context().clientIp, h.now(), 30 * 86400000)).toBe(false);
    await h.challenge();
  });

  it.each(["single", "others"] as const)(
    "%s session-route kick makes the victim pass 2FA again but preserves the revoker IP",
    async (mode) => {
      const h = setup();
      await h.enroll();
      const keepIp = "10.8.0.1",
        kickedIp = "10.8.0.3";
      await h.store.noteLoginIp(1, keepIp, h.now());
      await h.store.noteLoginIp(1, kickedIp, h.now());
      for (const ip of [keepIp, kickedIp]) {
        const result = await h.password(context(ip));
        expect(result.status).toBe(200);
        await result.after?.();
      }
      const sessions = await h.store.listSessions(1, h.now());
      const current = sessions.find((s) => s.createdIp === keepIp)!,
        victim = sessions.find((s) => s.createdIp === kickedIp)!;
      const sent: Array<{ status: number; body: unknown }> = [];
      const routes = createLanSessionsRoutes({
        store: h.store,
        idleMs: 720 * 60000,
        now: h.now,
        log: h.log,
        authRevoke: h.authRevoke,
        revokeSse: h.revokeSse,
      });
      const res = { headersSent: false, writableEnded: false, destroy: vi.fn() } as unknown as ServerResponse;
      await routes.handle({} as IncomingMessage, res, "POST", "/api/lan/sessions/revoke", {
        listener: "lan",
        ip: keepIp,
        xPwhOk: () => true,
        csrfOkLan: () => true,
        requireLanSession: async () => ({ userId: 1, sidHash: current.sidHash, user: "owner" }),
        readJson: async () => (mode === "single" ? { id: publicSessionId(victim.sidHash) } : { others: true }),
        sendJson: (_res, status, body) => {
          sent.push({ status, body });
        },
        clearCookie: () => {},
      });
      expect(sent).toEqual([{ status: 200, body: { ok: true, revoked: 1, complete: true } }]);
      await h.challenge(context(kickedIp));
      const survivor = await h.password(context(keepIp));
      expect(survivor.status).toBe(200);
      await survivor.after?.();
      routes.dispose();
    },
  );
  it("a delayed post-finish history hook cannot restore kicked-device trust", async () => {
    const h = setup();
    await h.enroll();
    await h.store.noteLoginIp(1, context().clientIp, h.now());
    const reply = await h.password();
    expect(reply.status).toBe(200);
    const [session] = await h.store.listSessions(1, h.now());
    expect(session).toBeDefined();
    await h.store.revokeSession(1, session!.sidHash, "other-revoker-ip");
    await reply.after?.();
    expect(await h.store.isKnownIp(1, context().clientIp, h.now(), 30 * 86400000)).toBe(false);
    await h.challenge();
  });
  it("known-IP password still uses checked insertion and its after hook is single-use", async () => {
    const h = setup({}, true);
    await h.enroll();
    await h.store.noteLoginIp(1, context().clientIp, h.now());
    const insert = vi.spyOn(h.store, "createSessionChecked"),
      legacy = vi.spyOn(h.store, "createSession"),
      history = vi.spyOn(h.store, "noteLoginIp");
    const mark = vi.spyOn(h.store, "markInitialLogin");
    const result = await h.password();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, initialPassword: true });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
    expect(insert.mock.calls[0]?.[0]).toMatchObject({ expectedEpoch: 4, expectedFactorGen: 1 });
    expect(h.succeed).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledTimes(1);
    expect(history).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
    expect(result.headers?.["Set-Cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("pwh_lan="), expect.stringContaining("pwh_lan2fa=;")]),
    );
    await Promise.all([result.after!(), result.after!(), result.after!()]);
    expect(history).toHaveBeenCalledTimes(1);
    expect(h.events).toEqual([
      { type: "login-success", method: "password", ip: context().clientIp, device: "Linux · Chrome", newIp: false },
    ]);
  });
  it("history failure leaves IP unknown but emits success exactly once", async () => {
    const h = setup();
    vi.spyOn(h.store, "noteLoginIp").mockRejectedValue(new Error("E_DB"));
    const result = await h.password();
    expect(result.status).toBe(200);
    expect(await h.store.isKnownIp(1, context().clientIp, h.now(), 30 * 86400000)).toBe(false);
    await result.after!();
    await result.after!();
    expect(await h.store.isKnownIp(1, context().clientIp, h.now(), 30 * 86400000)).toBe(false);
    expect(h.log.error).toHaveBeenCalledWith("web-hub lan login: noteLoginIp failed");
    expect(h.events.filter((e) => e.type === "login-success")).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ newIp: true });
  });
  it("evicted session hashes propagate to both revocation consumers", async () => {
    const h = setup();
    for (let n = 0; n < 32; n++)
      await h.store.createSession({
        userId: 1,
        epoch: 4,
        boundOrigin: context().externalOrigin,
        createdIp: "x",
        now: h.now(),
      });
    const old = [...h.store.sessionsBySidHash.keys()][0]!;
    const result = await h.password();
    expect(result.status).toBe(200);
    expect(h.store.sessionsBySidHash.size).toBe(32);
    expect(h.revokes).toContain(old);
    expect(h.revokeSse).toHaveBeenCalledWith(old);
    await result.after!();
  });
  it("gate errors and inconsistent enrollment fail closed", async () => {
    const h = setup();
    vi.spyOn(h.store, "isKnownIp").mockRejectedValueOnce(new Error("E_DB"));
    expect(await h.password()).toEqual({ status: 503, body: { error: "E_DB" } });
    vi.spyOn(h.store, "get2faState").mockResolvedValue({
      state: "inconsistent",
      totp: false,
      feishu: false,
      factorGen: 1,
      recoveryLeft: 0,
    });
    expect(await h.password()).toEqual({ status: 503, body: { error: "E_DB" } });
    expect(h.store.sessionsBySidHash.size).toBe(0);
    expect(h.succeed).not.toHaveBeenCalled();
  });
  it.each([undefined, false, true])("trusted proxy requires xffUsable === true (value %s)", async (xffUsable) => {
    const h = setup();
    await h.enroll();
    await h.store.noteLoginIp(1, context().clientIp, h.now());
    const ctx = context(undefined, { viaTrustedProxy: true, ...(xffUsable === undefined ? {} : { xffUsable }) });
    const result = await h.password(ctx);
    expect(result.status).toBe(xffUsable === true ? 200 : 401);
    if (result.after) await result.after();
    else {
      expect(result.body).toHaveProperty("error", "E_2FA");
      expect(h.succeed).not.toHaveBeenCalled();
      expect(h.store.sessionsBySidHash.size).toBe(0);
    }
  });
  it.each([undefined, false, true])("optional limiter.isFresh %s supplies admission freshness", async (fresh) => {
    const h = setup();
    const isFresh = vi.fn(() => fresh);
    if (fresh !== undefined) Object.assign(h.limiter, { isFresh });
    const acquire = vi.spyOn(h.admission, "acquire");
    const result = await h.password();
    expect(result.status).toBe(200);
    expect(acquire.mock.calls[0]?.slice(0, 2)).toEqual([context().clientIp, fresh ?? true]);
    if (fresh === undefined) expect(isFresh).not.toHaveBeenCalled();
    else expect(isFresh).toHaveBeenCalledWith(context().clientIp);
    await result.after!();
  });
});

describe("challenge binding, races and completion", () => {
  it("pending challenge has no session/cookie/history/succeed; malformed codes do no IPC", async () => {
    const h = setup({ totpStep });
    await h.enroll(true);
    const { token, result } = await h.challenge();
    expect(result.headers?.["Set-Cookie"]).toContain("HttpOnly; SameSite=Strict; Path=/api/login; Max-Age=300");
    expect(h.store.sessionsBySidHash.size).toBe(0);
    expect(h.succeed).not.toHaveBeenCalled();
    expect(await h.store.isKnownIp(1, context().clientIp, h.now(), 30 * 86400000)).toBe(false);
    const verify = vi.spyOn(h.store, "verifyTotp"),
      recovery = vi.spyOn(h.store, "consumeRecovery");
    for (const code of ["", "12345", "1234567", "秘密"]) {
      expect((await h.core.submitFactor(token, { method: "totp", code }, context(), io().value)).status).toBe(400);
    }
    expect((await h.core.submitFactor(token, { method: "recovery", code: "bad" }, context(), io().value)).status).toBe(
      400,
    );
    expect(verify).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
    expect(h.events).toEqual([
      { type: "login-2fa-challenge", ip: context().clientIp, device: "Linux · Chrome", cardSent: true },
    ]);
  });
  it("IP/origin/UA mismatches cannot submit, cancel or consume budgets", async () => {
    const h = setup();
    await h.enroll();
    const { token } = await h.challenge();
    const consume = vi.spyOn(h.store, "consumeRecovery");
    for (const ctx of [context("192.168.1.11"), context(undefined, { externalOrigin: "http://evil" })]) {
      expect(
        (await h.core.submitFactor(token, { method: "recovery", code: "000000000000" }, ctx, io().value)).body,
      ).toEqual({ error: "E_2FA_EXPIRED" });
      h.core.cancel(token, ctx);
    }
    const mismatch = io();
    mismatch.value.ua = "different";
    expect((await h.core.waitApproval(token, context(), mismatch.value)).status).toBe(409);
    h.core.cancel(token, context(undefined, { ua: "different" }));
    expect(consume).not.toHaveBeenCalled();
    const wait = h.core.waitApproval(token, context(), io().value);
    const request = h.requests[0]!;
    h.core.onApprovalDecision(request.challengeId, true, request.gen);
    const result = await wait;
    expect(result.status).toBe(200);
    expect(result.body).toHaveProperty("ok", true);
    await result.after!();
  });
  it("duplicate wait is synchronous; approval claims before concurrent factor dispatch", async () => {
    const h = setup();
    await h.enroll();
    const { token } = await h.challenge();
    const consume = vi.spyOn(h.store, "consumeRecovery"),
      insert = vi.spyOn(h.store, "createSessionChecked");
    const first = h.core.waitApproval(token, context(), io().value);
    expect((await h.core.waitApproval(token, context(), io().value)).body).toEqual({ error: "E_2FA_BUSY" });
    const request = h.requests[0]!;
    h.core.onApprovalDecision(request.challengeId, true, request.gen);
    expect(
      (await h.core.submitFactor(token, { method: "recovery", code: "000000000000" }, context(), io().value)).body,
    ).toEqual({ error: "E_2FA_BUSY" });
    const result = await first;
    expect(result.status).toBe(200);
    await result.after!();
    expect(insert).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
    expect((await h.core.waitApproval(token, context(), io().value)).body).toEqual({ error: "E_2FA_USED" });
  });
  it("TOTP, recovery and approval in parallel create at most one session", async () => {
    let block = false;
    const verifyLatch = latch();
    const h = setup({
      totpStep,
      beforeOp: (op) => (block && op === "verifyTotp" ? verifyLatch.promise : Promise.resolve()),
    });
    await h.enroll(true);
    await vi.advanceTimersByTimeAsync(30_000);
    const codes = await h.store.regenRecovery(1, h.now());
    const { token } = await h.challenge();
    block = true;
    const insert = vi.spyOn(h.store, "createSessionChecked"),
      consume = vi.spyOn(h.store, "consumeRecovery");
    const totp = h.core.submitFactor(token, { method: "totp", code: "222222" }, context(), io().value);
    const wait = h.core.waitApproval(token, context(), io().value);
    const recovery = h.core.submitFactor(
      token,
      { method: "recovery", code: codes.recoveryCodes[0]! },
      context(),
      io().value,
    );
    const request = h.requests[0]!;
    h.core.onApprovalDecision(request.challengeId, true, request.gen);
    expect((await recovery).body).toEqual({ error: "E_2FA_BUSY" });
    verifyLatch.resolve();
    const result = await totp;
    expect(result.status).toBe(200);
    await result.after!();
    expect(await wait).toEqual({ status: 200, body: { state: "expired" } });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
    expect(h.store.sessionsBySidHash.size).toBe(1);
    expect(h.events.filter((e) => e.type === "login-success")).toEqual([expect.objectContaining({ method: "totp" })]);
  });
  it("recovery normalization, single-use rejection and left count are real", async () => {
    const h = setup();
    await h.enroll();
    const codes = await h.store.regenRecovery(1, h.now());
    const code = codes.recoveryCodes[0]!;
    const one = await h.challenge();
    const result = await h.core.submitFactor(
      one.token,
      { method: "recovery", code: code.slice(0, 6).toLowerCase() + "-" + code.slice(6).toLowerCase() },
      context(),
      io().value,
    );
    expect(result.status).toBe(200);
    await result.after!();
    expect(h.events).toContainEqual({ type: "recovery-used", left: 9 });
    await h.store.forgetLoginIps(); // gen changes: a fresh challenge snapshots it.
    const two = await h.challenge();
    expect((await h.core.submitFactor(two.token, { method: "recovery", code }, context(), io().value)).body).toEqual({
      error: "E_2FA_CODE",
      attemptsLeft: 4,
    });
    expect(h.store.sessionsBySidHash.size).toBe(1);
    expect(JSON.stringify(h.log.info.mock.calls)).not.toContain(code);
    expect(JSON.stringify(h.log.info.mock.calls)).toContain("replay");
  });
  it.each(["cancel", "deny", "expire", "revoked", "dispose"] as const)(
    "late verifier success after %s cannot create session",
    async (reason) => {
      let block = false;
      const verifyLatch = latch();
      const h = setup({
        totpStep,
        beforeOp: (op) => (block && op === "verifyTotp" ? verifyLatch.promise : Promise.resolve()),
      });
      await h.enroll(true);
      await vi.advanceTimersByTimeAsync(30_000);
      const { token } = await h.challenge();
      block = true;
      const pending = h.core.submitFactor(token, { method: "totp", code: "222222" }, context(), io().value);
      await flush();
      if (reason === "cancel") h.core.cancel(token, context());
      if (reason === "deny") {
        const r = h.requests[0]!;
        h.core.onApprovalDecision(r.challengeId, false, r.gen);
      }
      if (reason === "expire") {
        wall += L.challengeMs;
        await h.core.waitApproval(token, context(), io().value);
      }
      if (reason === "revoked") h.core.onRevoke({ sel: { userId: 1 }, reason: "passwd" });
      if (reason === "dispose") h.core.dispose();
      verifyLatch.resolve();
      expect((await pending).status).toBe(409);
      expect(h.store.sessionsBySidHash.size).toBe(0);
      expect(h.succeed).not.toHaveBeenCalled();
      expect(h.approval.close).toHaveBeenCalledWith(h.requests[0]!.challengeId, reason);
    },
  );
  it.each(["deny", "cancel"] as const)("approval then %s cannot resurrect or issue a cookie", async (reason) => {
    const h = setup();
    await h.enroll();
    const { token } = await h.challenge();
    const wait = h.core.waitApproval(token, context(), io().value);
    const r = h.requests[0]!;
    h.core.onApprovalDecision(r.challengeId, true, r.gen);
    if (reason === "deny") h.core.onApprovalDecision(r.challengeId, false, r.gen);
    else h.core.cancel(token, context());
    h.core.onApprovalDecision(r.challengeId, true, r.gen);
    const result = await wait;
    expect(result.status).toBe(409);
    expect(result.headers).toBeUndefined();
    expect(h.store.sessionsBySidHash.size).toBe(0);
  });
  it("approval gen fence, poll hold and card expiry leave recovery usable", async () => {
    const h = setup();
    await h.enroll();
    const codes = await h.store.regenRecovery(1, h.now());
    const { token } = await h.challenge();
    const r = h.requests[0]!;
    const wait = h.core.waitApproval(token, context(), io().value);
    h.core.onApprovalDecision(r.challengeId, true, r.gen + 1);
    await vi.advanceTimersByTimeAsync(L.waitHoldMs);
    expect(await wait).toEqual({ status: 200, body: { state: "pending" } });
    await vi.advanceTimersByTimeAsync(L.approvalMs);
    h.core.onApprovalDecision(r.challengeId, true, r.gen);
    const expiredCardPoll = h.core.waitApproval(token, context(), io().value);
    let settled = false;
    void expiredCardPoll.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(L.waitHoldMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await expiredCardPoll).toEqual({ status: 200, body: { state: "pending" } });
    const result = await h.core.submitFactor(
      token,
      { method: "recovery", code: codes.recoveryCodes[0]! },
      context(),
      io().value,
    );
    expect(result.status).toBe(200);
    await result.after!();
  });
  it("bot unavailable in Feishu-only mode offers recovery, never password bypass", async () => {
    const h = setup();
    await h.enroll();
    h.approval.request.mockResolvedValue("unavailable");
    const { result } = await h.challenge();
    expect(result.body).toMatchObject({ methods: ["recovery"], feishu: "unavailable" });
    expect(h.store.sessionsBySidHash.size).toBe(0);
  });
});

describe("revocation and client-gone fences", () => {
  it.each(["user", "rotate"] as const)("%s revoke after password epoch read prevents completion", async (kind) => {
    const h = setup();
    const kdfLatch = latch<Uint8Array>();
    const started = latch();
    vi.spyOn(h.kdf, "run").mockImplementation(async () => {
      started.resolve();
      return kdfLatch.promise;
    });
    const password = h.password();
    await started.promise;
    h.core.onRevoke({
      sel: kind === "user" ? { userId: 1 } : { listener: "lan" },
      reason: kind === "user" ? "passwd" : "rotate",
    });
    kdfLatch.resolve(h.user.hash);
    expect((await password).body).toEqual({ error: "E_AUTH" });
    expect(h.store.sessionsBySidHash.size).toBe(0);
  });
  it("epoch change while INSERT is dispatched fails atomic CAS", async () => {
    let block = true;
    const insertLatch = latch(),
      dispatched = latch();
    const h = setup({
      beforeOp: async (op) => {
        if (block && op === "createSessionChecked") {
          dispatched.resolve();
          await insertLatch.promise;
        }
      },
    });
    const pending = h.password();
    await dispatched.promise;
    await h.store.setPassword({
      username: "owner",
      kdf: "scrypt",
      n: h.user.n,
      r: h.user.r,
      p: h.user.p,
      salt: h.user.salt,
      hash: h.user.hash,
    });
    block = false;
    insertLatch.resolve();
    expect(await pending).toEqual({ status: 401, body: { error: "E_AUTH" } });
    expect(h.store.sessionsBySidHash.size).toBe(0);
  });
  it("factor gen change between verify and INSERT fails CAS", async () => {
    let block = false;
    const insertLatch = latch(),
      dispatched = latch();
    const h = setup({
      totpStep,
      beforeOp: async (op) => {
        if (block && op === "createSessionChecked") {
          dispatched.resolve();
          await insertLatch.promise;
        }
      },
    });
    await h.enroll(true);
    await vi.advanceTimersByTimeAsync(30_000);
    const { token } = await h.challenge();
    block = true;
    const pending = h.core.submitFactor(token, { method: "totp", code: "222222" }, context(), io().value);
    await dispatched.promise;
    await h.store.reset2fa(1, h.now());
    insertLatch.resolve();
    expect((await pending).body).toEqual({ error: "E_AUTH" });
    expect(h.store.sessionsBySidHash.size).toBe(0);
  });
  it("silent client close before INSERT dispatch prevents it", async () => {
    const h = setup();
    const requestIo = io();
    const real = h.store.get2faState.bind(h.store);
    vi.spyOn(h.store, "get2faState").mockImplementation(async (...args) => {
      const result = await real(...args);
      requestIo.silentClose();
      return result;
    });
    const insert = vi.spyOn(h.store, "createSessionChecked");
    const result = await h.password(context(), requestIo);
    expect(result.status).toBe(503);
    expect(result.headers).toBeUndefined();
    expect(insert).not.toHaveBeenCalled();
  });
  it("client gone during dispatched INSERT cleans the late sid and propagates revoke", async () => {
    const insertLatch = latch(),
      dispatched = latch();
    const h = setup({
      beforeOp: async (op) => {
        if (op === "createSessionChecked") {
          dispatched.resolve();
          await insertLatch.promise;
        }
      },
    });
    const requestIo = io(),
      pending = h.password(context(), requestIo);
    await dispatched.promise;
    requestIo.close();
    expect((await pending).headers).toBeUndefined();
    insertLatch.resolve();
    await flush();
    expect(h.store.sessionsBySidHash.size).toBe(0);
    expect(h.revokes.length).toBeGreaterThan(0);
    expect(h.revokeSse).toHaveBeenCalled();
  });
  it("client close AFTER INSERT before reply cleans session", async () => {
    const h = setup({}, true);
    const requestIo = io();
    vi.spyOn(h.store, "markInitialLogin").mockImplementation(async () => {
      requestIo.close();
    });
    const result = await h.password(context(), requestIo);
    await flush();
    expect(result.status).toBe(503);
    expect(result.headers).toBeUndefined();
    expect(h.store.sessionsBySidHash.size).toBe(0);
    expect(h.succeed).not.toHaveBeenCalled();
  });
  it("abort between core reply and finish also revokes; no after effects on close", async () => {
    const h = setup();
    const requestIo = io();
    const result = await h.password(context(), requestIo);
    expect(result.status).toBe(200);
    requestIo.close();
    await flush();
    expect(h.store.sessionsBySidHash.size).toBe(0);
    expect(h.events).toEqual([]);
    await result.after!();
    expect(h.events).toEqual([]);
  });
});

describe("reserved sliding-window attempt budgets", () => {
  it.each(["totp", "recovery"] as const)(
    "200 concurrent %s across 20 challenges/10 IPs dispatch ≤10; sliding window then one oldest slot",
    async (method) => {
      const h = setup({ totpStep });
      await h.enroll(true);
      const challenges = [];
      for (let n = 0; n < 20; n++) challenges.push(await h.challenge(context(`192.168.1.${10 + (n % 10)}`)));
      const consume = vi.spyOn(h.store, method === "totp" ? "verifyTotp" : "consumeRecovery");
      const code = method === "totp" ? "333333" : "000000000000";
      const pending = Array.from({ length: 200 }, (_, n) => {
        const ch = challenges[n % 20]!;
        return h.core.submitFactor(ch.token, { method, code }, ch.ctx, io().value);
      });
      const results = await Promise.all(pending);
      expect(consume).toHaveBeenCalledTimes(10);
      expect(results.filter((r) => r.status === 401)).toHaveLength(10);
      expect(h.fail).toHaveBeenCalledTimes(10);
      expect(h.events.filter((e) => e.type === "login-2fa-burst")).toEqual([{ type: "login-2fa-burst", kind: method }]);
      await vi.advanceTimersByTimeAsync(L.methodWindowMs - 1);
      const before = await h.challenge();
      expect((await h.core.submitFactor(before.token, { method, code }, before.ctx, io().value)).body).toEqual({
        error: "E_2FA_METHOD_LOCKED",
      });
      expect(consume).toHaveBeenCalledTimes(10);
      await vi.advanceTimersByTimeAsync(2);
      expect((await h.core.submitFactor(before.token, { method, code }, before.ctx, io().value)).status).toBe(401);
      expect(consume).toHaveBeenCalledTimes(11);
    },
  );
  it("five attempts kill challenge; failed code includes reserved remaining count", async () => {
    const h = setup();
    await h.enroll();
    const { token } = await h.challenge();
    const consume = vi.spyOn(h.store, "consumeRecovery");
    for (let n = 4; n >= 0; n--)
      expect(
        (await h.core.submitFactor(token, { method: "recovery", code: "000000000000" }, context(), io().value)).body,
      ).toEqual({ error: "E_2FA_CODE", attemptsLeft: n });
    expect(
      (await h.core.submitFactor(token, { method: "recovery", code: "000000000000" }, context(), io().value)).body,
    ).toEqual({ error: "E_2FA_EXPIRED" });
    expect(consume).toHaveBeenCalledTimes(5);
    expect(h.approval.close).toHaveBeenCalledWith(h.requests[0]!.challengeId, "attempts");
  });
  it.each(["E_BUSY", "E_RATE"])("pre-dispatch %s refunds both budgets", async (code) => {
    const h = setup();
    await h.enroll();
    const { token } = await h.challenge();
    const consume = vi.spyOn(h.store, "consumeRecovery");
    for (let n = 0; n < 12; n++) {
      consume.mockRejectedValueOnce(Object.assign(new Error("admission refused"), { code }));
      expect(
        (await h.core.submitFactor(token, { method: "recovery", code: "000000000000" }, context(), io().value)).body,
      ).toEqual({ error: "E_RATE" });
    }
    expect(
      (await h.core.submitFactor(token, { method: "recovery", code: "000000000000" }, context(), io().value)).body,
    ).toEqual({ error: "E_2FA_CODE", attemptsLeft: 4 });
    expect(h.fail).toHaveBeenCalledTimes(1);
  });
  it("E_DB after dispatch consumes challenge budget", async () => {
    const h = setup();
    await h.enroll();
    const { token } = await h.challenge();
    vi.spyOn(h.store, "consumeRecovery").mockRejectedValueOnce(new Error("E_DB"));
    expect(
      (await h.core.submitFactor(token, { method: "recovery", code: "000000000000" }, context(), io().value)).body,
    ).toEqual({ error: "E_DB" });
    expect(
      (await h.core.submitFactor(token, { method: "recovery", code: "000000000000" }, context(), io().value)).body,
    ).toEqual({ error: "E_2FA_CODE", attemptsLeft: 3 });
  });
  it("method lock does not lock the other method", async () => {
    const h = setup({ totpStep });
    await h.enroll(true);
    for (let n = 0; n < 10; n++) {
      const c = await h.challenge(context(`192.168.1.${20 + n}`));
      await h.core.submitFactor(c.token, { method: "recovery", code: "000000000000" }, c.ctx, io().value);
    }
    await vi.advanceTimersByTimeAsync(30_000);
    const c = await h.challenge();
    expect(
      (await h.core.submitFactor(c.token, { method: "recovery", code: "000000000000" }, c.ctx, io().value)).body,
    ).toEqual({ error: "E_2FA_METHOD_LOCKED" });
    const result = await h.core.submitFactor(c.token, { method: "totp", code: "222222" }, c.ctx, io().value);
    expect(result.status).toBe(200);
    await result.after!();
  });
});

describe("absolute deadlines and late-result isolation", () => {
  it.each(["isKnownIp", "get2faState"] as const)("never-settling dispatched gate %s ends by 6s", async (op) => {
    const dispatched = latch();
    const h = setup({
      beforeOp: async (name) => {
        if (name === op) {
          dispatched.resolve();
          await new Promise<void>(() => {});
        }
      },
    });
    const pending = h.password();
    await dispatched.promise;
    await vi.advanceTimersByTimeAsync(L.postKdfMs - L.completionReserveMs);
    expect(await pending).toEqual({ status: 503, body: { error: "E_DEADLINE" } });
    expect(h.store.sessionsBySidHash.size).toBe(0);
    expect(h.succeed).not.toHaveBeenCalled();
  });
  it("sequential gate steps share ONE post-KDF deadline", async () => {
    const h = setup();
    const real = h.store.isKnownIp.bind(h.store);
    vi.spyOn(h.store, "isKnownIp").mockImplementation(async (...args) => {
      await new Promise<void>((r) => setTimeout(r, 5_000));
      return real(...args);
    });
    vi.spyOn(h.store, "get2faState").mockImplementation(async () => {
      await new Promise<void>(() => {});
      throw new Error("unreachable");
    });
    const pending = h.password();
    await flush();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await pending).toEqual({ status: 503, body: { error: "E_DEADLINE" } });
    expect(h.store.sessionsBySidHash.size).toBe(0);
  });
  it("late successful INSERT after 10s timeout is revoked by hash", async () => {
    const insertLatch = latch(),
      dispatched = latch();
    const h = setup({
      beforeOp: async (op) => {
        if (op === "createSessionChecked") {
          dispatched.resolve();
          await insertLatch.promise;
        }
      },
    });
    const pending = h.password();
    await dispatched.promise;
    await vi.advanceTimersByTimeAsync(L.postKdfMs);
    expect(await pending).toEqual({ status: 503, body: { error: "E_DEADLINE" } });
    insertLatch.resolve();
    await flush();
    expect(h.store.sessionsBySidHash.size).toBe(0);
    expect(h.revokes.length).toBeGreaterThan(0);
    expect(h.events).toEqual([]);
    expect(h.succeed).not.toHaveBeenCalled();
  });
  it("dispatched never-settling verifier stops at 8s, late success stays void", async () => {
    let block = false;
    const verifyLatch = latch(),
      dispatched = latch();
    const h = setup({
      totpStep,
      beforeOp: async (op) => {
        if (block && op === "verifyTotp") {
          dispatched.resolve();
          await verifyLatch.promise;
        }
      },
    });
    await h.enroll(true);
    await vi.advanceTimersByTimeAsync(30_000);
    const { token } = await h.challenge();
    block = true;
    const pending = h.core.submitFactor(token, { method: "totp", code: "222222" }, context(), io().value);
    await dispatched.promise;
    await vi.advanceTimersByTimeAsync(L.factorMs - L.completionReserveMs);
    expect(await pending).toEqual({ status: 503, body: { error: "E_DEADLINE" } });
    verifyLatch.resolve();
    await flush();
    expect(h.store.sessionsBySidHash.size).toBe(0);
    expect((await h.core.waitApproval(token, context(), io().value)).body).toEqual({ error: "E_2FA_EXPIRED" });
  });
  it("#66 D4: a hung markInitialLogin is bounded (2s) and the login still succeeds with its session", async () => {
    const h = setup({}, true);
    const dispatched = latch();
    vi.spyOn(h.store, "markInitialLogin").mockImplementation(async () => {
      dispatched.resolve();
      await new Promise<void>(() => {});
    });
    const truncate = vi.fn();
    (h.store as { requestCheckpointTruncate?: () => void }).requestCheckpointTruncate = truncate;
    const pending = h.password();
    await dispatched.promise;
    expect(h.store.sessionsBySidHash.size).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    const reply = await pending;
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true, initialPassword: true });
    expect(h.store.sessionsBySidHash.size).toBe(1);
    expect(h.succeed).toHaveBeenCalledTimes(1);
    expect(truncate).not.toHaveBeenCalled();
    expect(h.log.warn).toHaveBeenCalledWith("web-hub lan login: initial-password-clear-failed", expect.anything());
  });
  it("#66 D4: a rejecting markInitialLogin never fails the login (only a warn; the secret never reaches the log)", async () => {
    const h = setup({}, true);
    vi.spyOn(h.store, "markInitialLogin").mockRejectedValue(new Error("E_DB: boom correct"));
    const reply = await h.password();
    expect(reply.status).toBe(200);
    expect(h.store.sessionsBySidHash.size).toBe(1);
    expect(h.succeed).toHaveBeenCalledTimes(1);
    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.log.warn.mock.calls)).not.toContain("correct");
  });
  it("#66 D4: cleared:true requests exactly one checkpoint truncate; cleared:false / no plaintext does not", async () => {
    const h = setup({}, true);
    const truncate = vi.fn();
    (h.store as { requestCheckpointTruncate?: () => void }).requestCheckpointTruncate = truncate;
    expect((await h.password()).status).toBe(200);
    expect(truncate).toHaveBeenCalledTimes(1);
    // The fake wiped the plaintext: a second login re-reads the user and neither marks nor truncates.
    const mark = vi.spyOn(h.store, "markInitialLogin");
    const again = await h.password();
    expect(again.status).toBe(200);
    // Plaintext gone but `initialCreatedAt` is absent in this fixture ⇒ not "in use" any more.
    expect(mark).not.toHaveBeenCalled();
    expect(truncate).toHaveBeenCalledTimes(1);
    const racing = setup({}, true);
    const truncate2 = vi.fn();
    (racing.store as { requestCheckpointTruncate?: () => void }).requestCheckpointTruncate = truncate2;
    vi.spyOn(racing.store, "markInitialLogin").mockResolvedValue({ cleared: false });
    expect((await racing.password()).status).toBe(200);
    expect(truncate2).not.toHaveBeenCalled();
  });
  it("#66 D4: after the wipe the response still reports initialPassword:true via initialCreatedAt; a changed password reports false", async () => {
    const h = setup({}, true);
    const wiped = (await h.store.getUser("owner"))!;
    const { initialPassword: _plain, ...rest } = wiped;
    h.store.seedUser({ ...rest, initialCreatedAt: wall });
    const mark = vi.spyOn(h.store, "markInitialLogin");
    const reply = await h.password();
    expect(reply.body).toEqual({ ok: true, initialPassword: true });
    expect(mark).not.toHaveBeenCalled();
    const changed = setup({}, false);
    expect((await changed.password()).body).toEqual({ ok: true, initialPassword: false });
  });
  it("approval complete has total ≤23s even with dispatched INSERT ignoring abort", async () => {
    let block = false;
    const insertLatch = latch();
    const h = setup({
      beforeOp: async (op) => {
        if (block && op === "createSessionChecked") await insertLatch.promise;
      },
    });
    await h.enroll();
    const { token } = await h.challenge();
    block = true;
    const wait = h.core.waitApproval(token, context(), io().value);
    await vi.advanceTimersByTimeAsync(14_999);
    const r = h.requests[0]!;
    h.core.onApprovalDecision(r.challengeId, true, r.gen);
    await flush();
    await vi.advanceTimersByTimeAsync(8_001);
    expect(await wait).toEqual({ status: 503, body: { error: "E_DEADLINE" } });
    insertLatch.resolve();
    await flush();
    expect(h.store.sessionsBySidHash.size).toBe(0);
  });
  it("approval send timeout does not bypass second factor; late response is closed", async () => {
    const h = setup();
    await h.enroll();
    const send = latch<"sent">();
    h.approval.request.mockImplementation(async (c) => {
      h.requests.push(c);
      return send.promise;
    });
    const pending = h.challenge();
    await flush();
    await vi.advanceTimersByTimeAsync(L.approvalSendMs);
    const { result } = await pending;
    expect(result.body).toMatchObject({ methods: ["recovery"], feishu: "unavailable" });
    send.resolve("sent");
    await flush();
    expect(h.approval.close).toHaveBeenCalledWith(h.requests[0]!.challengeId, "deadline");
    expect(h.store.sessionsBySidHash.size).toBe(0);
  });
});

describe("bounded storage and teardown", () => {
  it("per-IP cap evicts old challenges, settling their waiter", async () => {
    const h = setup();
    await h.enroll();
    const first = await h.challenge();
    const wait = h.core.waitApproval(first.token, context(), io().value);
    for (let n = 0; n < L.perIp; n++) await h.challenge();
    expect(await wait).toEqual({ status: 200, body: { state: "expired" } });
    expect((await h.core.waitApproval(first.token, context(), io().value)).body).toEqual({ error: "E_2FA_EXPIRED" });
    expect(h.approval.close).toHaveBeenCalledWith(h.requests[0]!.challengeId, "evict");
  });
  it("global cap evicts, dispose settles waiters and clears challenge timers", async () => {
    const h = setup();
    await h.enroll();
    const first = await h.challenge();
    for (let n = 1; n <= L.challenges; n++) await h.challenge(context(`192.168.2.${n}`));
    expect(h.approval.close).toHaveBeenCalledWith(h.requests[0]!.challengeId, "evict");
    const c = await h.challenge();
    const wait = h.core.waitApproval(c.token, context(), io().value);
    h.core.dispose();
    expect(await wait).toEqual({ status: 200, body: { state: "expired" } });
    expect(vi.getTimerCount()).toBe(0);
    expect((await h.password()).body).toEqual({ error: "E_DB" });
  });
});

describe("additional dispatch-boundary regressions", () => {
  it("hold timeout and immediate approval cannot strand a claimed challenge", async () => {
    const h = setup();
    await h.enroll();
    const { token } = await h.challenge();
    const wait = h.core.waitApproval(token, context(), io().value);
    const r = h.requests[0]!;
    // Both callbacks execute before the wait continuation; timed-out waiter must not claim.
    setTimeout(() => h.core.onApprovalDecision(r.challengeId, true, r.gen), L.waitHoldMs);
    vi.advanceTimersByTime(L.waitHoldMs);
    expect(await wait).toEqual({ status: 200, body: { state: "pending" } });
    const next = await h.core.waitApproval(token, context(), io().value);
    expect(next.status).toBe(200);
    expect(next.body).toHaveProperty("ok", true);
    await next.after!();
    expect(h.store.sessionsBySidHash.size).toBe(1);
  });
  it("physical KDF slot remains held after logical timeout until real settle", async () => {
    const h = setup();
    const kdf = latch<Uint8Array>(),
      started = latch();
    const release = vi.fn();
    const admission = fakeKdfAdmission();
    admission.acquire = async () => ({ ok: true, release });
    const core = createLanLoginCore({
      store: h.store,
      kdf: {
        run: async () => {
          started.resolve();
          return kdf.promise;
        },
      },
      admission,
      limiter: h.limiter,
      approval: h.approval,
      security: createSecurityEventBus(h.log),
      authRevoke: h.authRevoke,
      revokeSse: h.revokeSse,
      now: h.now,
      log: h.log,
    });
    cores.push(core);
    const pending = core.passwordLogin(context(), { username: "owner", password: "correct" }, UA, io().value);
    await started.promise;
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await pending).body).toEqual({ error: "E_DEADLINE" });
    expect(release).not.toHaveBeenCalled();
    kdf.resolve(h.user.hash);
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
    expect(h.store.sessionsBySidHash.size).toBe(0);
  });
  it("user revoke while getUser reply is unresolved fences later snapshot", async () => {
    const h = setup();
    const read = latch<LanUserRecord>(),
      started = latch();
    vi.spyOn(h.store, "getUser").mockImplementation(async () => {
      started.resolve();
      return read.promise;
    });
    const pending = h.password();
    await started.promise;
    h.core.onRevoke({ sel: { userId: 1 }, reason: "passwd" });
    read.resolve(h.user);
    expect((await pending).body).toEqual({ error: "E_AUTH" });
    expect(h.store.sessionsBySidHash.size).toBe(0);
  });
  it("passwd after factor verify while INSERT in flight cleans any accepted sid", async () => {
    let block = false;
    const insert = latch(),
      started = latch();
    const h = setup({
      totpStep,
      beforeOp: async (op) => {
        if (block && op === "createSessionChecked") {
          started.resolve();
          await insert.promise;
        }
      },
    });
    await h.enroll(true);
    await vi.advanceTimersByTimeAsync(30_000);
    const { token } = await h.challenge();
    block = true;
    const pending = h.core.submitFactor(token, { method: "totp", code: "222222" }, context(), io().value);
    await started.promise;
    h.core.onRevoke({ sel: { userId: 1 }, reason: "passwd" });
    insert.resolve();
    const result = await pending;
    await flush();
    expect(result.status).not.toBe(200);
    expect(result.headers).toBeUndefined();
    expect(h.store.sessionsBySidHash.size).toBe(0);
    expect(h.revokes.length).toBeGreaterThan(0);
  });
  it("cancelled waiter settles once and later decisions cannot mint", async () => {
    const h = setup();
    await h.enroll();
    const { token } = await h.challenge();
    const wait = h.core.waitApproval(token, context(), io().value),
      r = h.requests[0]!;
    h.core.cancel(token, context());
    h.core.onApprovalDecision(r.challengeId, true, r.gen);
    h.core.onApprovalDecision(r.challengeId, false, r.gen);
    expect(await wait).toEqual({ status: 200, body: { state: "expired" } });
    expect(h.store.sessionsBySidHash.size).toBe(0);
    expect(h.fail).not.toHaveBeenCalled();
  });
  it("synchronous limiter failure cannot leave inserted session alive", async () => {
    const h = setup();
    h.succeed.mockImplementation(() => {
      throw new Error("E_DB");
    });
    const result = await h.password();
    await flush();
    expect(result).toEqual({ status: 503, body: { error: "E_DB" } });
    expect(h.store.sessionsBySidHash.size).toBe(0);
  });
});

describe("post-success history timeout ruling", () => {
  it("late landed history after finished login is accepted; wait stays bounded and never-landed remains unknown", async () => {
    const note = latch(),
      started = latch();
    const h = setup({
      beforeOp: async (op) => {
        if (op === "noteLoginIp") {
          started.resolve();
          await note.promise;
        }
      },
    });
    const result = await h.password();
    expect(result.status).toBe(200);
    const after = result.after!();
    await started.promise;
    await vi.advanceTimersByTimeAsync(8_000);
    await after;
    expect(h.log.error).toHaveBeenCalledWith("web-hub lan login: noteLoginIp failed");
    expect(await h.store.isKnownIp(1, context().clientIp, h.now(), 30 * 86400000)).toBe(false);
    expect(h.events.filter((e) => e.type === "login-success")).toHaveLength(1);
    note.resolve();
    await flush();
    expect(await h.store.isKnownIp(1, context().clientIp, h.now(), 30 * 86400000)).toBe(true);
    await result.after!();
    expect(h.events.filter((e) => e.type === "login-success")).toHaveLength(1);
  });
});

describe("verification rework regressions", () => {
  it("card expiry during a poll does not shorten the normal hold", async () => {
    const h = setup();
    await h.enroll();
    const { token } = await h.challenge();
    await vi.advanceTimersByTimeAsync(L.approvalMs - 1);
    const poll = h.core.waitApproval(token, context(), io().value);
    let settled = false;
    void poll.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(L.waitHoldMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await poll).toEqual({ status: 200, body: { state: "pending" } });
    expect(h.store.sessionsBySidHash.size).toBe(0);
  });
  it("aborting a mere poll detaches its waiter and leaves challenge usable", async () => {
    const h = setup();
    await h.enroll();
    const codes = await h.store.regenRecovery(1, h.now());
    const { token } = await h.challenge();
    const requestIo = io();
    const poll = h.core.waitApproval(token, context(), requestIo.value);
    requestIo.close();
    expect(await poll).toEqual({ status: 200, body: { state: "expired" } });
    expect(h.approval.close).not.toHaveBeenCalledWith(h.requests[0]!.challengeId, "client-gone");
    const next = h.core.waitApproval(token, context(), io().value);
    await vi.advanceTimersByTimeAsync(L.waitHoldMs);
    expect(await next).toEqual({ status: 200, body: { state: "pending" } });
    const result = await h.core.submitFactor(
      token,
      { method: "recovery", code: codes.recoveryCodes[0]! },
      context(),
      io().value,
    );
    expect(result.status).toBe(200);
    await result.after!();
  });
  it("already-aborted poll leaves challenge and approval live", async () => {
    const h = setup();
    await h.enroll();
    const { token } = await h.challenge();
    const requestIo = io();
    requestIo.close();
    expect((await h.core.waitApproval(token, context(), requestIo.value)).body).toEqual({ error: "E_2FA_EXPIRED" });
    const poll = h.core.waitApproval(token, context(), io().value),
      r = h.requests[0]!;
    h.core.onApprovalDecision(r.challengeId, true, r.gen);
    const result = await poll;
    expect(result.status).toBe(200);
    await result.after!();
  });
  it("poll abort cannot cancel a different factor verifier", async () => {
    let block = false;
    const verify = latch(),
      started = latch();
    const h = setup({
      totpStep,
      beforeOp: async (op) => {
        if (block && op === "verifyTotp") {
          started.resolve();
          await verify.promise;
        }
      },
    });
    await h.enroll(true);
    await vi.advanceTimersByTimeAsync(30_000);
    const { token } = await h.challenge();
    block = true;
    const factor = h.core.submitFactor(token, { method: "totp", code: "222222" }, context(), io().value);
    await started.promise;
    const pollIo = io(),
      poll = h.core.waitApproval(token, context(), pollIo.value);
    pollIo.close();
    await poll;
    verify.resolve();
    const result = await factor;
    expect(result.status).toBe(200);
    await result.after!();
    expect(h.store.sessionsBySidHash.size).toBe(1);
  });
  it("abort after approval claims completion still kills challenge and cleans late INSERT", async () => {
    let block = false;
    const insert = latch(),
      started = latch();
    const h = setup({
      beforeOp: async (op) => {
        if (block && op === "createSessionChecked") {
          started.resolve();
          await insert.promise;
        }
      },
    });
    await h.enroll();
    const { token } = await h.challenge();
    block = true;
    const requestIo = io(),
      poll = h.core.waitApproval(token, context(), requestIo.value),
      r = h.requests[0]!;
    h.core.onApprovalDecision(r.challengeId, true, r.gen);
    await started.promise;
    requestIo.close();
    expect((await poll).headers).toBeUndefined();
    insert.resolve();
    await flush();
    expect(h.store.sessionsBySidHash.size).toBe(0);
    expect(h.approval.close).toHaveBeenCalledWith(r.challengeId, "client-gone");
  });
  it.each(["E_BUSY", "E_DB"])("completion %s uses non-revocation teardown reason", async (code) => {
    const h = setup();
    await h.enroll();
    const codes = await h.store.regenRecovery(1, h.now());
    const { token } = await h.challenge();
    vi.spyOn(h.store, "createSessionChecked").mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    const result = await h.core.submitFactor(
      token,
      { method: "recovery", code: codes.recoveryCodes[0]! },
      context(),
      io().value,
    );
    expect(result.status).toBe(503);
    expect(result.headers).toBeUndefined();
    expect(h.approval.close).toHaveBeenCalledWith(h.requests[0]!.challengeId, code === "E_BUSY" ? "evict" : "dispose");
    expect(h.approval.close).not.toHaveBeenCalledWith(h.requests[0]!.challengeId, "revoked");
    expect(h.store.sessionsBySidHash.size).toBe(0);
  });
  it("actual completion cap E_BUSY closes as evict, not revoked", async () => {
    const h = setup();
    await h.enroll();
    const codes = await h.store.regenRecovery(1, h.now());
    const { token } = await h.challenge();
    const known = context("192.168.1.20");
    await h.store.noteLoginIp(1, known.clientIp, h.now());
    for (let n = 0; n < 64; n++) expect((await h.password(known)).status).toBe(200);
    const insert = vi.spyOn(h.store, "createSessionChecked");
    const result = await h.core.submitFactor(
      token,
      { method: "recovery", code: codes.recoveryCodes[0]! },
      context(),
      io().value,
    );
    expect(result).toEqual({ status: 503, body: { error: "E_RATE" } });
    expect(insert).not.toHaveBeenCalled();
    expect(h.approval.close).toHaveBeenCalledWith(h.requests[0]!.challengeId, "evict");
  });
  it("post-succeed exhausted deadline reports deadline, cleans INSERT and never says revoked", async () => {
    const h = setup();
    await h.enroll();
    const codes = await h.store.regenRecovery(1, h.now());
    const { token } = await h.challenge();
    h.succeed.mockImplementation(() => {
      wall += L.factorMs;
    });
    const result = await h.core.submitFactor(
      token,
      { method: "recovery", code: codes.recoveryCodes[0]! },
      context(),
      io().value,
    );
    expect(result).toEqual({ status: 503, body: { error: "E_DEADLINE" } });
    await flush();
    expect(h.store.sessionsBySidHash.size).toBe(0);
    expect(h.approval.close).toHaveBeenCalledWith(h.requests[0]!.challengeId, "deadline");
    expect(h.approval.close).not.toHaveBeenCalledWith(h.requests[0]!.challengeId, "revoked");
  });
});

describe("#66 P2 login-only trigger", () => {
  it("concurrent verified logins return sessions while the one shared upgrade remains pending", async () => {
    let upgrade!: import("../../../src/web-hub/hub/kdf-upgrade.js").KdfUpgrader;
    const h = setup({}, false, { maybeRehash: (user, pw) => upgrade.maybeRehash(user, pw), dispose() {} });
    const gate = latch<Uint8Array>(),
      run = vi.fn(() => gate.promise),
      rehashPassword = vi.fn(async () => ({ ok: true as const }));
    upgrade = createKdfUpgrader({
      kdf: { run },
      store: { rehashPassword },
      log: h.log,
      now: h.now,
      target: KDF_PHASE2,
    });
    try {
      const replies = await Promise.all([h.password(), h.password(context("192.168.1.11"))]);
      expect(replies.map((r) => r.status)).toEqual([200, 200]);
      await Promise.all(replies.map((r) => r.after?.()));
      expect(h.store.sessionsBySidHash.size).toBe(2);
      expect(run).toHaveBeenCalledTimes(1);
      expect(rehashPassword).not.toHaveBeenCalled();
      gate.resolve(new Uint8Array(32));
      await flush();
      expect(rehashPassword).toHaveBeenCalledTimes(1);
      expect(h.store.sessionsBySidHash.size).toBe(2);
    } finally {
      upgrade.dispose();
    }
  });
  it("triggers after match and before second-factor gate, never waits for background work", async () => {
    const maybeRehash = vi.fn(),
      h = setup({}, false, { maybeRehash, dispose: vi.fn() });
    await h.enroll();
    const gate = vi.spyOn(h.store, "isKnownIp").mockImplementation(async () => {
      expect(maybeRehash).toHaveBeenCalledWith(h.user, "correct");
      return false;
    });
    const r = await h.password();
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: "E_2FA", methods: ["recovery", "feishu"] });
    expect(maybeRehash).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalled();
  });
  it("does not trigger for wrong/missing users, revoked snapshots or disposed core", async () => {
    const maybeRehash = vi.fn(),
      h = setup({}, false, { maybeRehash, dispose: vi.fn() });
    expect((await h.core.passwordLogin(context(), { username: "owner", password: "bad" }, UA, io().value)).status).toBe(
      401,
    );
    expect(
      (await h.core.passwordLogin(context(), { username: "missing", password: "correct" }, UA, io().value)).status,
    ).toBe(401);
    const wait = latch<Uint8Array>();
    vi.spyOn(h.kdf, "run").mockReturnValueOnce(wait.promise);
    const pending = h.password();
    await flush();
    h.core.onRevoke({ sel: { userId: h.user.id }, reason: "passwd" });
    wait.resolve(h.user.hash);
    await flush();
    expect((await pending).status).toBe(401);
    h.core.dispose();
    expect((await h.password()).status).toBe(503);
    expect(maybeRehash).not.toHaveBeenCalled();
  });
});
