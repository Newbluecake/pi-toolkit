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
      await store.noteLoginIp("192.0.2.1", at);
      expect(await store.isKnownIp("192.0.2.1", at, NEW_IP_WINDOW_MS)).toBe(true);
      const enrolled = await store.setFeishu2fa({ userId, on: true, now: at });
      expect(enrolled.recoveryCodes).toHaveLength(10);
      expect(await store.knownIpCount(at, NEW_IP_WINDOW_MS)).toBe(0);
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
  });
