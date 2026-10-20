/** I2: identical port assertions against the P0 fake AND B's real SQLite child. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeLanStore } from "./fakes.js";
import { createLanStore } from "../../../src/web-hub/hub/lan-store.js";
import type { LanStorePort } from "../../../src/web-hub/hub/ports.js";
import { hashSid } from "../../../src/web-hub/hub/sid-hash.js";
import { totpCode, verifyTotpCandidates } from "../../../src/web-hub/hub/totp.js";
import { NEW_IP_WINDOW_MS } from "../../../src/web-hub/protocol/lan-2fa.js";
import { memLog } from "../hub/helpers.js";

function decode(secret: string): Uint8Array {
  let bits = "";
  for (const c of secret) bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0");
  return Uint8Array.from(bits.match(/.{8}/g) ?? [], (b) => parseInt(b, 2));
}
const crypto = {
  hmacSha1: (key: Uint8Array, msg: Uint8Array) => createHmac("sha1", key).update(msg).digest(),
  timingSafeEqual,
};
const at = 1_800_000_000_000;
for (const kind of ["fake", "sqlite"] as const)
  describe(`LAN security shared contract: ${kind}`, () => {
    let store: LanStorePort, userId: number, epoch: number;
    let cleanup: () => Promise<void>;
    beforeEach(async () => {
      if (kind === "fake") {
        store = fakeLanStore({
          idleMs: 300000,
          totpStep: (secret, code, now) => verifyTotpCandidates(decode(secret), code, now, crypto),
        });
        cleanup = async () => {};
      } else {
        const dir = mkdtempSync(join(tmpdir(), "lan-I-contract-"));
        const opened = await createLanStore({ dbFile: join(dir, "hub.db"), log: memLog(), idleMs: 300000 });
        if (!opened.ok) {
          rmSync(dir, { recursive: true, force: true });
          throw Error(JSON.stringify(opened));
        }
        store = opened.store;
        cleanup = async () => {
          await opened.store.close();
          rmSync(dir, { recursive: true, force: true });
        };
      }
      await store.setPassword({
        username: "contract",
        kdf: "scrypt",
        n: 32768,
        r: 8,
        p: 1,
        salt: new Uint8Array(16),
        hash: new Uint8Array(32),
      });
      const user = await store.getUser("contract");
      if (!user) throw Error("missing fixture user");
      userId = user.id;
      epoch = user.epoch;
    });
    afterEach(async () => {
      await cleanup?.();
    });
    const input = (now = at) => ({
      userId,
      expectedEpoch: epoch,
      expectedFactorGen: 0,
      boundOrigin: "https://hub.example",
      createdIp: "192.0.2.1",
      now,
    });

    it("checked insertion CAS, exact cap evictions and idle expiry", async () => {
      expect(await store.createSessionChecked({ ...input(), expectedEpoch: epoch + 1 })).toEqual({
        ok: false,
        reason: "stale",
      });
      expect(await store.createSessionChecked({ ...input(), expectedFactorGen: 1 })).toEqual({
        ok: false,
        reason: "stale",
      });
      const hashes: string[] = [];
      for (let i = 0; i < 33; i++) {
        const made = await store.createSessionChecked(input(at + i));
        expect(made.ok).toBe(true);
        if (!made.ok) throw Error("checked insertion failed");
        expect(made.evicted).toEqual(i === 32 ? [hashes[0]] : []);
        hashes.push(hashSid(made.sid));
      }
      expect(await store.listSessions(userId, at + 33)).toHaveLength(32);
      expect(await store.touchSession(hashes[32]!, at + 300032)).toBeUndefined();
    });

    it.each(["password", "totp", "feishu", "recovery"] as const)(
      "persists the satisfied login method: %s",
      async (method) => {
        const made = await store.createSessionChecked({ ...input(), method, ua: "test-browser" });
        expect(made.ok).toBe(true);
        expect(await store.listSessions(userId, at)).toMatchObject([{ method, ua: "test-browser" }]);
      },
    );

    it("first enrollment clears history; recovery is single use; generation survives reset", async () => {
      await store.noteLoginIp(userId, "192.0.2.1", at);
      expect(await store.isKnownIp(userId, "192.0.2.1", at, NEW_IP_WINDOW_MS)).toBe(true);
      const enrolled = await store.setFeishu2fa({ userId, on: true, now: at });
      expect(enrolled.recoveryCodes).toHaveLength(10);
      expect(await store.knownIpCount(userId, at, NEW_IP_WINDOW_MS)).toBe(0);
      const gen = (await store.get2faState(userId)).factorGen;
      const req = { userId, code: enrolled.recoveryCodes![0]!, expectedGen: gen, now: at + 1 };
      const results = await Promise.all([store.consumeRecovery(req), store.consumeRecovery(req)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results).toContainEqual({ ok: false, reason: "replay" });
      await store.reset2fa(userId, at + 2);
      expect(await store.get2faState(userId)).toMatchObject({ state: "none", factorGen: gen + 1, recoveryLeft: 0 });
      expect(await store.createSessionChecked(input())).toEqual({ ok: false, reason: "stale" });
    });

    it("TOTP replacement preserves the existing recovery set even when exhausted (addendum #4)", async () => {
      const enrolled = await store.setFeishu2fa({ userId, on: true, now: at });
      const gen = (await store.get2faState(userId)).factorGen;
      for (const code of enrolled.recoveryCodes!)
        expect(await store.consumeRecovery({ userId, code, expectedGen: gen, now: at })).toMatchObject({ ok: true });
      const pending = await store.beginTotp({ userId, now: at });
      const code = totpCode(decode(pending.secretB32), Math.floor(at / 30000), crypto);
      expect(await store.commitTotp({ userId, code, expectedGen: gen, now: at })).toEqual({
        ok: true,
        recoveryCodes: [],
      });
      expect(await store.get2faState(userId)).toMatchObject({
        totp: true,
        feishu: true,
        recoveryLeft: 0,
        factorGen: gen + 1,
      });
      expect(
        await store.consumeRecovery({ userId, code: enrolled.recoveryCodes![0]!, expectedGen: gen + 1, now: at }),
      ).toEqual({ ok: false, reason: "replay" });
    });

    async function extraUser() {
      await store.setPassword({
        username: "other",
        kdf: "scrypt",
        n: 32768,
        r: 8,
        p: 1,
        salt: new Uint8Array(16),
        hash: new Uint8Array(32),
      });
      return (await store.getUser("other"))!;
    }

    it.each(["feishu", "totp"] as const)(
      "trust, per-user cap and first %s enrollment are account-isolated",
      async (method) => {
        const other = await extraUser();
        await store.noteLoginIp(other.id, "shared", at);
        expect(await store.isKnownIp(userId, "shared", at, NEW_IP_WINDOW_MS)).toBe(false);
        await store.noteLoginIp(userId, "shared", at);
        for (let i = 0; i < 257; i++) await store.noteLoginIp(userId, `ip${i}`, at + i);
        expect(await store.knownIpCount(userId, at + 300, NEW_IP_WINDOW_MS)).toBe(256);
        expect(await store.isKnownIp(other.id, "shared", at + 300, NEW_IP_WINDOW_MS)).toBe(true);
        if (method === "feishu") await store.setFeishu2fa({ userId, on: true, now: at });
        else {
          const pending = await store.beginTotp({ userId, now: at });
          const code = totpCode(decode(pending.secretB32), Math.floor(at / 30000), crypto);
          expect(await store.commitTotp({ userId, code, expectedGen: 0, now: at })).toMatchObject({ ok: true });
        }
        expect(await store.knownIpCount(userId, at + 300, NEW_IP_WINDOW_MS)).toBe(0);
        expect(await store.isKnownIp(other.id, "shared", at, NEW_IP_WINDOW_MS)).toBe(true);
        await store.forgetLoginIps();
        expect(await store.knownIpCount(other.id, at, NEW_IP_WINDOW_MS)).toBe(0);
      },
    );

    it("lists account-scoped factors/live sessions; refuses primary/last and deletes only the extra account", async () => {
      const primary = (await store.listUsers(at))[0]!;
      const other = await extraUser();
      await store.setFeishu2fa({ userId: other.id, on: true, now: at });
      await store.noteLoginIp(other.id, "other-ip", at);
      const made = await store.createSessionChecked({
        ...input(),
        userId: other.id,
        expectedEpoch: other.epoch,
        expectedFactorGen: 1,
      });
      expect(made.ok).toBe(true);
      expect(await store.listUsers(at)).toContainEqual({
        username: "other",
        primary: false,
        twofa: true,
        liveSessions: 1,
      });
      expect(await store.deleteUser(primary.username)).toEqual({ ok: false, reason: "primary" });
      expect(await store.deleteUser("missing")).toEqual({ ok: false, reason: "not-found" });
      expect(await store.deleteUser("other")).toEqual({ ok: true, userId: other.id });
      expect(await store.getUser("other")).toBeUndefined();
      expect(await store.listSessions(other.id, at)).toEqual([]);
      expect(await store.knownIpCount(other.id, at, NEW_IP_WINDOW_MS)).toBe(0);
      expect(await store.get2faState(other.id)).toMatchObject({ state: "none", recoveryLeft: 0 });
      if (primary.username !== "contract") expect(await store.deleteUser("contract")).toEqual({ ok: true, userId });
      expect(await store.deleteUser(primary.username)).toEqual({ ok: false, reason: "last-user" });
      // Primary identity remains stable even after changing its password (fake parity).
      expect((await store.initialInfo())?.username).toBe(primary.username);
    });

    it.each(["single", "others"] as const)(
      "%s kick atomically untrusts created+last IP, keeps the revoker IP and other accounts",
      async (mode) => {
        const other = await extraUser();
        const keepIp = "revoker",
          victimIp = "created",
          lastIp = "last";
        for (const ip of [keepIp, victimIp, lastIp]) {
          await store.noteLoginIp(userId, ip, at);
          await store.noteLoginIp(other.id, ip, at);
        }
        const current = await store.createSessionChecked({ ...input(), createdIp: keepIp });
        const victim = await store.createSessionChecked({ ...input(), createdIp: victimIp });
        const shared = await store.createSessionChecked({ ...input(), createdIp: keepIp });
        if (!current.ok || !victim.ok || !shared.ok) throw Error("fixture insertion");
        await store.touchSession(hashSid(victim.sid), at + 60000, { ip: lastIp });
        if (mode === "single") {
          expect(await store.revokeSession(userId, hashSid(shared.sid), keepIp)).toEqual({ sharedIpKept: true });
          expect(await store.revokeSession(userId, hashSid(victim.sid), keepIp)).toEqual({ sharedIpKept: false });
        } else {
          const result = await store.deleteSessionsExcept(userId, hashSid(current.sid), { keepIp });
          expect(result).toMatchObject({ more: false, sharedIpKept: true });
          expect(new Set(result.deleted)).toEqual(new Set([hashSid(victim.sid), hashSid(shared.sid)]));
        }
        expect(await store.isKnownIp(userId, keepIp, at + 60000, NEW_IP_WINDOW_MS)).toBe(true);
        for (const ip of [victimIp, lastIp]) {
          expect(await store.isKnownIp(userId, ip, at + 60000, NEW_IP_WINDOW_MS)).toBe(false);
          expect(await store.isKnownIp(other.id, ip, at + 60000, NEW_IP_WINDOW_MS)).toBe(true);
        }
        expect(await store.listSessions(userId, at + 60000)).toMatchObject([{ sidHash: hashSid(current.sid) }]);
        // A delayed response-finish hook cannot re-trust the session that was just kicked.
        await store.noteLoginIp(userId, victimIp, at + 60000, { sidHash: hashSid(victim.sid) });
        expect(await store.isKnownIp(userId, victimIp, at + 60000, NEW_IP_WINDOW_MS)).toBe(false);
        await store.deleteSession(hashSid(current.sid)); // /api/logout uses this exact op
        expect(await store.isKnownIp(userId, keepIp, at + 60000, NEW_IP_WINDOW_MS)).toBe(true);
      },
    );
  });
