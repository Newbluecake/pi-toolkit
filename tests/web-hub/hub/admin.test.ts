/**
 * `admin.ts` unit tests (plan §8, §8.3, §5.2 — S1-W3 LD 包): pure dispatch
 * logic against fake ports (`tests/web-hub/contract/fakes.ts`), no real
 * sqlite/scrypt — that end-to-end coverage lives in `hub-lan.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import { fakeKdf, fakeLanStore, fakeLoginLimiter, type FakeLanStore } from "../contract/fakes.js";
import { createAdminHandler, type AdminDeps } from "../../../src/web-hub/hub/admin.js";
import type { LanFacade, LanStatus } from "../../../src/web-hub/hub/ports.js";
import { memLog, type MemLog } from "./helpers.js";

function seedAdmin(store: FakeLanStore): void {
  store.seedUser({
    id: 1,
    username: "admin",
    kdf: "scrypt",
    n: 32768,
    r: 8,
    p: 1,
    salt: new Uint8Array(16),
    hash: new Uint8Array(32),
    epoch: 1,
    initialPassword: "abc-def-ghi",
    initialCreatedAt: 1000,
    createdAt: 1000,
    updatedAt: 1000,
  });
}

function fakeLanFacade(status: LanStatus, revokeCalls: Array<{ sidHash: string } | { userId: number }>): LanFacade {
  return {
    start: async () => status,
    status: () => status,
    close: async () => {},
    revoke: (target) => {
      revokeCalls.push(target);
      return 1;
    },
  };
}

function baseDeps(over: Partial<AdminDeps> = {}): { deps: AdminDeps; log: MemLog } {
  const log = memLog();
  const deps: AdminDeps = {
    log,
    hasLan: () => true,
    store: () => undefined,
    kdf: () => undefined,
    limiter: () => undefined,
    lan: () => undefined,
    lanStatus: () => undefined,
    shutdown: () => {},
    ...over,
  };
  return { deps, log };
}

describe("createAdminHandler (plan §8)", () => {
  it("caps(): ctl.v1 always; lan.v1 only when hasLan() is true", () => {
    const { deps: d1 } = baseDeps({ hasLan: () => false });
    expect(createAdminHandler(d1).caps()).toEqual(["ctl.v1"]);
    const { deps: d2 } = baseDeps({ hasLan: () => true });
    expect(createAdminHandler(d2).caps()).toEqual(["ctl.v1", "lan.v1"]);
  });

  describe("lan_req info", () => {
    it("returns username/initialPassword/lan status and audits initialPasswordReturned (never the password itself)", async () => {
      const store = fakeLanStore();
      seedAdmin(store);
      const status: LanStatus = {
        state: "on",
        port: 7879,
        hosts: ["192.168.1.5"],
        omitted: [],
        warnings: ["plaintext"],
      };
      const { deps, log } = baseDeps({ store: () => store, lanStatus: () => status });
      const admin = createAdminHandler(deps);
      const res = await admin.handleLanReq({ t: "lan_req", rid: "r1", op: "info" }, { agentKey: "a1", agentPid: 99 });
      expect(res).toEqual({
        t: "lan_res",
        rid: "r1",
        ok: true,
        info: { username: "admin", initialPassword: "abc-def-ghi", lan: status },
      });
      const auditLine = log.lines.find((l) => (l.data as Record<string, unknown> | undefined)?.["op"] === "info");
      expect(auditLine?.data).toMatchObject({
        audit: "admin",
        op: "info",
        agentKey: "a1",
        agentPid: 99,
        ok: true,
        initialPasswordReturned: true,
        username: "admin",
      });
      // The audit line must never carry the plaintext initial password itself.
      expect(JSON.stringify(auditLine)).not.toContain("abc-def-ghi");
    });

    it("prefers lan() (a live LanFacade) over lanStatus() when both are available", async () => {
      const store = fakeLanStore();
      seedAdmin(store);
      const liveStatus: LanStatus = { state: "on", port: 7879, hosts: [], omitted: [], warnings: [] };
      const staleStatus: LanStatus = { state: "starting" };
      const { deps } = baseDeps({
        store: () => store,
        lan: () => fakeLanFacade(liveStatus, []),
        lanStatus: () => staleStatus,
      });
      const res = await createAdminHandler(deps).handleLanReq(
        { t: "lan_req", rid: "r1", op: "info" },
        { agentKey: "a1" },
      );
      expect(res).toMatchObject({ ok: true, info: { lan: liveStatus } });
    });

    it("first observed initial-password login ⇒ one audit warning line; not repeated on a second info call", async () => {
      const store = fakeLanStore();
      seedAdmin(store);
      await store.markInitialLogin("admin", "192.168.1.40", 123456);
      const { deps, log } = baseDeps({ store: () => store });
      const admin = createAdminHandler(deps);
      await admin.handleLanReq({ t: "lan_req", rid: "r1", op: "info" }, { agentKey: "a1" });
      await admin.handleLanReq({ t: "lan_req", rid: "r2", op: "info" }, { agentKey: "a1" });
      const warnings = log.lines.filter(
        (l) => l.level === "warn" && (l.data as Record<string, unknown> | undefined)?.["op"] === "initial-login",
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.data).toMatchObject({ audit: "admin", op: "initial-login", ip: "192.168.1.40", at: 123456 });
    });

    it("no LAN configured ⇒ E_NO_LAN, audited", async () => {
      const { deps, log } = baseDeps({ hasLan: () => false, store: () => undefined });
      const res = await createAdminHandler(deps).handleLanReq(
        { t: "lan_req", rid: "r1", op: "info" },
        { agentKey: "a1" },
      );
      expect(res).toEqual({ t: "lan_res", rid: "r1", ok: false, code: "E_NO_LAN", message: "LAN is not configured" });
      expect(log.lines.some((l) => (l.data as Record<string, unknown> | undefined)?.["code"] === "E_NO_LAN")).toBe(
        true,
      );
    });
  });

  describe("lan_req passwd", () => {
    it.each([false, true])(
      "uses open-time writerActive=%s for password writes, not stored verify cost",
      async (writerActive) => {
        const store = Object.assign(fakeLanStore(), { hardening: Object.freeze({ writerActive }) });
        seedAdmin(store);
        const run = vi.spyOn(fakeKdf(), "run");
        const write = vi.spyOn(store, "setPassword");
        const { deps } = baseDeps({ store: () => store, kdf: () => ({ run }) });
        const result = await createAdminHandler(deps).handleLanReq(
          { t: "lan_req", rid: "r", op: "passwd", username: "admin", password: "correct-horse-battery" },
          { agentKey: "local" },
        );
        expect(result.ok).toBe(true);
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0]![1]).toMatchObject({ n: writerActive ? 131072 : 32768, r: 8, p: 1 });
        expect(write).toHaveBeenCalledWith(expect.objectContaining({ n: writerActive ? 131072 : 32768 }));
      },
    );

    it.each([
      ["password123", "common"],
      ["p@ssw0rd!!", "common"],
      ["9876543210", "pattern"],
      ["abcabcabca", "pattern"],
      ["aaaaaaaaaa", "pattern"],
      ["alice-secret-1", "username"],
      ["my-webhub-pass", "username"],
    ])("rejects %s before KDF/write, with redacted fixed reply/audit", async (password, reason) => {
      const store = fakeLanStore();
      const kdf = fakeKdf();
      const run = vi.spyOn(kdf, "run");
      const write = vi.spyOn(store, "setPassword");
      const { deps, log } = baseDeps({ store: () => store, kdf: () => kdf });
      const res = await createAdminHandler(deps).handleLanReq(
        { t: "lan_req", rid: "weak", op: "passwd", username: "alice", password: password! },
        { agentKey: "a1" },
      );
      expect(res).toEqual({
        t: "lan_res",
        rid: "weak",
        ok: false,
        code: "E_WEAK_PASSWORD",
        message: `password rejected: ${reason}`,
      });
      expect(run).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(log.lines).toHaveLength(1);
      expect(log.lines[0]?.data).toEqual({
        audit: "admin",
        op: "passwd",
        agentKey: "a1",
        ok: false,
        code: "E_WEAK_PASSWORD",
        reason,
      });
      expect(JSON.stringify([res, log.lines])).not.toContain(password!);
    });
    it("rejects 257 UTF-16 units before KDF, write or username lookup", async () => {
      const store = fakeLanStore();
      const kdf = fakeKdf();
      const run = vi.spyOn(kdf, "run");
      const write = vi.spyOn(store, "setPassword");
      const get = vi.spyOn(store, "getUser");
      const { deps } = baseDeps({ store: () => store, kdf: () => kdf });
      const res = await createAdminHandler(deps).handleLanReq(
        { t: "lan_req", rid: "long", op: "passwd", username: "legacy:user", password: "x".repeat(257) },
        { agentKey: "a1" },
      );
      expect(res).toMatchObject({ ok: false, code: "E_BAD_REQUEST" });
      expect(run).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    });
    it.each(["ＶＪ８！ｋＲ２＠ｘＱ", "maple orbit velvet canoe".padEnd(256, "x")])(
      "hashes the original accepted input %s",
      async (password) => {
        const store = fakeLanStore();
        const kdf = fakeKdf();
        const run = vi.spyOn(kdf, "run");
        const write = vi.spyOn(store, "setPassword");
        const { deps } = baseDeps({ store: () => store, kdf: () => kdf });
        expect(
          await createAdminHandler(deps).handleLanReq(
            { t: "lan_req", rid: "ok", op: "passwd", username: "alice", password },
            { agentKey: "a1" },
          ),
        ).toMatchObject({ ok: true });
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0]?.[0]).toBe(password);
        expect(write).toHaveBeenCalledTimes(1);
      },
    );
    it("updates the password, revokes the user's LAN sessions, and audits (never the password)", async () => {
      const store = fakeLanStore();
      seedAdmin(store);
      const revokeCalls: Array<{ sidHash: string } | { userId: number }> = [];
      const { deps, log } = baseDeps({
        store: () => store,
        kdf: () => fakeKdf(),
        lan: () => fakeLanFacade({ state: "on", port: 7879, hosts: [], omitted: [], warnings: [] }, revokeCalls),
      });
      const admin = createAdminHandler(deps);
      const res = await admin.handleLanReq(
        { t: "lan_req", rid: "r1", op: "passwd", username: "admin", password: "correct-horse" },
        { agentKey: "a1" },
      );
      expect(res).toEqual({ t: "lan_res", rid: "r1", ok: true });
      expect(revokeCalls).toEqual([{ userId: 1 }]);
      const updated = await store.getUser("admin");
      expect(updated?.initialPassword).toBeUndefined();
      expect(updated?.epoch).toBe(2);
      expect(JSON.stringify(log.lines)).not.toContain("correct-horse");
      expect(
        log.lines.some(
          (l) =>
            (l.data as Record<string, unknown> | undefined)?.["op"] === "passwd" &&
            (l.data as Record<string, unknown>)["ok"] === true,
        ),
      ).toBe(true);
    });

    it("rejects a too-short password without touching the store", async () => {
      const store = fakeLanStore();
      seedAdmin(store);
      const { deps } = baseDeps({ store: () => store, kdf: () => fakeKdf() });
      const res = await createAdminHandler(deps).handleLanReq(
        { t: "lan_req", rid: "r1", op: "passwd", username: "admin", password: "short" },
        { agentKey: "a1" },
      );
      expect(res).toMatchObject({ ok: false, code: "E_BAD_REQUEST" });
      const stillOriginal = await store.getUser("admin");
      expect(stillOriginal?.initialPassword).toBe("abc-def-ghi");
    });

    it("fixed error text never echoes the submitted username/password", async () => {
      const { deps } = baseDeps({ hasLan: () => false });
      const res = await createAdminHandler(deps).handleLanReq(
        { t: "lan_req", rid: "r1", op: "passwd", username: "attacker' OR 1=1", password: "whatever-input" },
        { agentKey: "a1" },
      );
      expect(JSON.stringify(res)).not.toContain("whatever-input");
      expect(JSON.stringify(res)).not.toContain("attacker");
    });
  });

  describe("lan_req unlock", () => {
    it("calls limiter.unlock() and audits ok:true", async () => {
      const limiter = fakeLoginLimiter();
      let unlocked = false;
      limiter.unlock = () => {
        unlocked = true;
      };
      const { deps, log } = baseDeps({ limiter: () => limiter });
      const res = await createAdminHandler(deps).handleLanReq(
        { t: "lan_req", rid: "r1", op: "unlock" },
        { agentKey: "a1" },
      );
      expect(res).toEqual({ t: "lan_res", rid: "r1", ok: true });
      expect(unlocked).toBe(true);
      expect(
        log.lines.some(
          (l) =>
            (l.data as Record<string, unknown> | undefined)?.["op"] === "unlock" &&
            (l.data as Record<string, unknown>)["ok"] === true,
        ),
      ).toBe(true);
    });

    it("no LAN configured ⇒ E_NO_LAN", async () => {
      const { deps } = baseDeps({ hasLan: () => false });
      const res = await createAdminHandler(deps).handleLanReq(
        { t: "lan_req", rid: "r1", op: "unlock" },
        { agentKey: "a1" },
      );
      expect(res).toMatchObject({ ok: false, code: "E_NO_LAN" });
    });
  });

  describe("hub_ctl shutdown", () => {
    it("handleShutdown invokes deps.shutdown('restart') and audits", () => {
      const calls: string[] = [];
      const { deps, log } = baseDeps({ shutdown: (reason) => calls.push(reason) });
      createAdminHandler(deps).handleShutdown({ agentKey: "a1", agentPid: 42 }, "restart");
      expect(calls).toEqual(["restart"]);
      expect(log.lines.some((l) => (l.data as Record<string, unknown> | undefined)?.["op"] === "shutdown")).toBe(true);
    });

    it("handleShutdown with reason 'stop' shuts down with 'stop' and audits op=stop (C8)", () => {
      const calls: string[] = [];
      const { deps, log } = baseDeps({ shutdown: (reason) => calls.push(reason) });
      createAdminHandler(deps).handleShutdown({ agentKey: "a1" }, "stop");
      expect(calls).toEqual(["stop"]);
      expect(log.lines.some((l) => (l.data as Record<string, unknown> | undefined)?.["op"] === "stop")).toBe(true);
    });
  });

  describe("unexpected exceptions (§5.2 崩溃路径)", () => {
    it("a port throwing ⇒ E_INTERNAL, fixed message, redacted error fields, still audited", async () => {
      const store = fakeLanStore();
      store.initialInfo = async () => {
        const err = new Error("boom") as Error & { password?: string };
        err.password = "leaked-secret";
        throw err;
      };
      const { deps, log } = baseDeps({ store: () => store });
      const res = await createAdminHandler(deps).handleLanReq(
        { t: "lan_req", rid: "r1", op: "info" },
        { agentKey: "a1" },
      );
      expect(res).toEqual({ t: "lan_res", rid: "r1", ok: false, code: "E_INTERNAL", message: "internal error" });
      expect(JSON.stringify(log.lines)).not.toContain("leaked-secret");
      const errLine = log.lines.find((l) => l.level === "error");
      expect(errLine?.data).toMatchObject({ password: "[redacted]" });
    });
  });
});

it("R2-j rejects colon-containing new usernames before KDF/store mutation", async () => {
  const store = fakeLanStore();
  const kdf = fakeKdf();
  const { deps } = baseDeps({ store: () => store, kdf: () => kdf });
  const res = await createAdminHandler(deps).handleLanReq(
    { t: "lan_req", rid: "colon", op: "passwd", username: "feishu:1:ou_x", password: "correct-horse" },
    { agentKey: "local" },
  );
  expect(res).toMatchObject({
    ok: false,
    code: "E_BAD_REQUEST",
    message: expect.stringContaining("must not contain :"),
  });
  expect(await store.getUser("feishu:1:ou_x")).toBeUndefined();
});

it("existing colon-named LAN users can still rotate their password; no forced rename/delete", async () => {
  const store = fakeLanStore();
  seedAdmin(store);
  const original = (await store.getUser("admin"))!;
  store.seedUser({ ...original, id: 2, username: "feishu:1:ou_x" });
  const { deps } = baseDeps({ store: () => store, kdf: () => fakeKdf() });
  const res = await createAdminHandler(deps).handleLanReq(
    { t: "lan_req", rid: "legacy", op: "passwd", username: "feishu:1:ou_x", password: "correct-horse" },
    { agentKey: "local" },
  );
  expect(res).toMatchObject({ ok: true });
  expect((await store.getUser("feishu:1:ou_x"))?.id).toBe(2);
  describe("lan_req users / user_delete", () => {
    it("lists, refuses primary/last, cascades through store and invokes the existing user revoke fan-out after commit", async () => {
      const store = fakeLanStore();
      seedAdmin(store);
      const revokes: Array<{ sidHash: string } | { userId: number }> = [];
      const facade = fakeLanFacade({ state: "starting" }, revokes);
      const revoke = facade.revoke;
      facade.revoke = (target) => {
        // Real commit must precede fan-out.
        expect(store.usersByUsername.has("extra")).toBe(false);
        return revoke(target);
      };
      const { deps, log } = baseDeps({ store: () => store, lan: () => facade });
      const admin = createAdminHandler(deps),
        meta = { agentKey: "a1" };
      const del = (username: string) =>
        admin.handleLanReq({ t: "lan_req", rid: "d", op: "user_delete", username }, meta);
      expect(await del("admin")).toMatchObject({ ok: false, code: "E_LAST_USER" });
      await store.setPassword({
        username: "extra",
        kdf: "scrypt",
        n: 32768,
        r: 8,
        p: 1,
        salt: new Uint8Array(16),
        hash: new Uint8Array(32),
      });
      const extra = (await store.getUser("extra"))!;
      await store.setFeishu2fa({ userId: extra.id, on: true, now: 1000 });
      await store.createSessionChecked({
        userId: extra.id,
        expectedEpoch: extra.epoch,
        expectedFactorGen: 1,
        boundOrigin: "http://lan",
        createdIp: "192.0.2.2",
        now: Date.now(),
      });
      expect(await admin.handleLanReq({ t: "lan_req", rid: "l", op: "users" }, meta)).toMatchObject({
        ok: true,
        users: [
          { username: "admin", primary: true, twofa: false, liveSessions: 0 },
          { username: "extra", primary: false, twofa: true, liveSessions: 1 },
        ],
      });
      expect(await del("admin")).toMatchObject({ ok: false, code: "E_PRIMARY_USER" });
      expect(revokes).toEqual([]);
      expect(await del("extra")).toMatchObject({ ok: true });
      expect(revokes).toEqual([{ userId: extra.id }]);
      expect(await store.listSessions(extra.id, Date.now())).toEqual([]);
      expect(await del("extra")).toMatchObject({ ok: false, code: "E_NO_USER" });
      expect(log.lines.filter((l) => (l.data as Record<string, unknown>)?.op === "user_delete")).toHaveLength(4);
      expect(JSON.stringify(log.lines)).not.toContain("abc-def-ghi");
    });
    it("refuses users/delete when LAN is unavailable", async () => {
      const { deps } = baseDeps();
      const admin = createAdminHandler(deps);
      expect(await admin.handleLanReq({ t: "lan_req", rid: "l", op: "users" }, { agentKey: "a" })).toMatchObject({
        ok: false,
        code: "E_NO_LAN",
      });
      expect(
        await admin.handleLanReq({ t: "lan_req", rid: "d", op: "user_delete", username: "x" }, { agentKey: "a" }),
      ).toMatchObject({ ok: false, code: "E_NO_LAN" });
    });
  });
});
