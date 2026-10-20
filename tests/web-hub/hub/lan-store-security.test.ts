/** Real SQLite + real child IPC. No fake crypto / success stubs. */
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLanStore, type LanStore } from "../../../src/web-hub/hub/lan-store.js";
import { hasNodeSqlite } from "../../../src/web-hub/hub/db.js";
import { hashSid } from "../../../src/web-hub/hub/sid-hash.js";
import { NEW_IP_WINDOW_MS } from "../../../src/web-hub/protocol/lan-2fa.js";
import { memLog } from "./helpers.js";

const sqlite = (await hasNodeSqlite())
  ? (createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite"))
  : undefined;
const suite = sqlite ? describe : describe.skip;
const at = 1_800_000_000_000;

/** Independent RFC algorithm / base32 decoder: does NOT call production totpCode. */
function codeFor(secret: string, now: number): string {
  let value = 0,
    bits = 0;
  const bytes: number[] = [];
  for (const char of secret) {
    value = value * 32 + "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
      value &= (1 << bits) - 1;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest(),
    offset = digest[19]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

suite("LAN security real store", () => {
  let dir: string, file: string, store: LanStore;
  const writes: Array<ReturnType<typeof vi.spyOn>> = [];
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "lan-B-store-"));
    file = join(dir, "hub.db");
    await open();
  });
  afterEach(async () => {
    await store?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function open(idleMs?: number) {
    const result = await createLanStore({
      dbFile: file,
      log: memLog(),
      dbClient: {
        spawnFn: ((...args: Parameters<typeof spawn>) => {
          const child = spawn(...args);
          writes.push(vi.spyOn(child.stdin!, "write"));
          return child;
        }) as typeof spawn,
      },
      ...(idleMs === undefined ? {} : { idleMs }),
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    store = result.store;
    await store.getUserSummary(1);
    return result;
  }
  function sql<T>(fn: (db: import("node:sqlite").DatabaseSync) => T): T {
    const db = new sqlite!.DatabaseSync(file);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }
  function input(now = at, expectedFactorGen = 0, expectedEpoch = 1) {
    return {
      userId: 1,
      expectedEpoch,
      expectedFactorGen,
      boundOrigin: "http://lan",
      createdIp: "192.0.2.1",
      ua: "test browser",
      now,
    };
  }
  async function enrolled() {
    const pending = await store.beginTotp({ userId: 1, now: at });
    const result = await store.commitTotp({ userId: 1, now: at, expectedGen: 0, code: codeFor(pending.secretB32, at) });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.recoveryCodes).toHaveLength(10);
    return { ...pending, codes: result.recoveryCodes };
  }

  it("checked insert rejects epoch/gen races, preserves metadata, caps at 32 and returns exact evictions", async () => {
    expect(await store.createSessionChecked(input(at, 0, 2))).toEqual({ ok: false, reason: "stale" });
    expect(await store.createSessionChecked(input(at, 1))).toEqual({ ok: false, reason: "stale" });
    const hashes: string[] = [],
      evicted: string[] = [];
    for (let i = 0; i < 35; i++) {
      const result = await store.createSessionChecked(input(at + i));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("not inserted");
      hashes.push(hashSid(result.sid));
      evicted.push(...result.evicted);
    }
    expect(evicted).toEqual(hashes.slice(0, 3));
    const sessions = await store.listSessions(1, at + 36);
    expect(sessions).toHaveLength(32);
    expect(new Set(sessions.map((s) => s.sidHash))).toEqual(new Set(hashes.slice(3)));
    expect(sessions[0]).toMatchObject({
      ua: "test browser",
      lastIp: "192.0.2.1",
      createdAt: at + 34,
      lastSeenAt: at + 34,
    });
    expect(sql((db) => db.prepare("SELECT count(*) AS n FROM session_meta").get()?.n)).toBe(32);
    const result = await store.deleteSessionsExcept(1, hashes[34]!);
    expect(result.more).toBe(false);
    expect(result.deleted).toHaveLength(31);
    expect((await store.listSessions(1, at + 36)).map((s) => s.sidHash)).toEqual([hashes[34]]);
  });

  it("checked insert is stale after a real passwd, revoke-all, or factor change", async () => {
    const info = await store.initialInfo();
    await store.setPassword({
      username: info!.username,
      kdf: "scrypt",
      n: 32768,
      r: 8,
      p: 1,
      salt: Buffer.alloc(16),
      hash: Buffer.alloc(32),
    });
    expect(await store.createSessionChecked(input())).toEqual({ ok: false, reason: "stale" });
    expect((await store.createSessionChecked(input(at, 0, 2))).ok).toBe(true);
    await store.revokeAllSessions();
    expect(await store.createSessionChecked(input(at, 0, 2))).toEqual({ ok: false, reason: "stale" });
    await store.setFeishu2fa({ userId: 1, on: true, now: at });
    expect(await store.createSessionChecked(input(at, 0, 3))).toEqual({ ok: false, reason: "stale" });
    expect((await store.createSessionChecked(input(at, 1, 3))).ok).toBe(true);
  });

  it("immediately enforces shortened idle on old sessions and records IP only on the 60s throttle", async () => {
    const s = await store.createSessionChecked(input());
    if (!s.ok) throw 0;
    const hash = hashSid(s.sid);
    await store.touchSession(hash, at + 59000, { ip: "192.0.2.2" });
    expect((await store.listSessions(1, at + 59000))[0]?.lastIp).toBe("192.0.2.1");
    await store.touchSessionReserved(hash, at + 60000, { ip: "192.0.2.3" });
    expect((await store.listSessions(1, at + 60001))[0]).toMatchObject({ lastSeenAt: at + 60000, lastIp: "192.0.2.3" });
    await store.close();
    await open(5 * 60000);
    expect(await store.touchSession(hash, at + 360000)).toBeUndefined();
    expect(await store.listSessions(1, at + 360000)).toEqual([]);
  });

  it("uses configured idle for new sessions, capped at absolute 7d, and refuses an old epoch", async () => {
    await store.close();
    await open(7 * 86400000);
    const s = await store.createSessionChecked(input());
    if (!s.ok) throw 0;
    const hash = hashSid(s.sid);
    expect(await store.touchSession(hash, at + 60000)).toMatchObject({
      expiresAt: at + 7 * 86400000,
      absoluteExpiresAt: at + 7 * 86400000,
    });
    sql((db) => db.exec("UPDATE users SET epoch=2"));
    expect(await store.touchSession(hash, at + 60001)).toBeUndefined();
  });

  it("stores at most 256 IPs, expires trust at exactly 30d, and preserves first_at", async () => {
    expect(await store.noteLoginIp(1, "192.0.2.1", at)).toEqual({ wasKnown: false });
    expect(await store.noteLoginIp(1, "192.0.2.1", at + 1)).toEqual({ wasKnown: true });
    expect(await store.isKnownIp(1, "192.0.2.1", at + NEW_IP_WINDOW_MS, NEW_IP_WINDOW_MS)).toBe(true);
    expect(await store.isKnownIp(1, "192.0.2.1", at + NEW_IP_WINDOW_MS + 1, NEW_IP_WINDOW_MS)).toBe(false);
    expect(sql((db) => db.prepare("SELECT first_at FROM login_ips WHERE ip='192.0.2.1'").get()?.first_at)).toBe(at);
    for (let i = 0; i < 257; i++) await store.noteLoginIp(1, `198.51.100.${i}`, at + 2 + i);
    expect(await store.knownIpCount(1, at + 300, NEW_IP_WINDOW_MS)).toBe(256);
    expect(await store.isKnownIp(1, "192.0.2.1", at + 300, NEW_IP_WINDOW_MS)).toBe(false);
    expect(await store.isKnownIp(1, "198.51.100.0", at + 300, NEW_IP_WINDOW_MS)).toBe(false);
    expect(await store.isKnownIp(1, "198.51.100.256", at + 300, NEW_IP_WINDOW_MS)).toBe(true);
  });

  it("enrollment is atomic, changes schema to v2, clears history but not sessions, and keeps secrets in the child", async () => {
    await store.noteLoginIp(1, "192.0.2.1", at);
    const session = await store.createSessionChecked(input());
    expect(session.ok).toBe(true);
    const pending = await store.beginTotp({ userId: 1, now: at });
    expect(sql((db) => db.prepare("PRAGMA user_version").get()?.user_version)).toBe(1);
    expect(await store.get2faState(1)).toEqual({
      state: "none",
      totp: false,
      feishu: false,
      recoveryLeft: 0,
      factorGen: 0,
    });
    await expect(store.commitTotp({ userId: 1, now: at, expectedGen: 0, code: "bad" })).rejects.toMatchObject({
      code: "E_BAD_REQUEST",
    });
    const result = await store.commitTotp({ userId: 1, now: at, expectedGen: 0, code: codeFor(pending.secretB32, at) });
    expect(result.ok).toBe(true);
    expect(sql((db) => db.prepare("PRAGMA user_version").get()?.user_version)).toBe(2);
    expect(await store.knownIpCount(1, at, NEW_IP_WINDOW_MS)).toBe(0);
    expect(await store.listSessions(1, at)).toHaveLength(1);
    const state = await store.get2faState(1);
    expect(Object.keys(state).sort()).toEqual(["factorGen", "feishu", "recoveryLeft", "state", "totp"]);
    expect(JSON.stringify(state)).not.toContain(pending.secretB32);
    await store.close();
    expect((await open()).ok).toBe(true);
    expect((await store.get2faState(1)).state).toBe("enrolled");
  });

  it("TOTP replay CAS permits exactly one of two concurrent calls and rejects stale generation", async () => {
    const { secretB32 } = await enrolled(),
      next = at + 30000;
    expect(await store.get2faState(1)).toEqual({
      state: "enrolled",
      totp: true,
      feishu: false,
      recoveryLeft: 10,
      factorGen: 1,
    });
    const results = await Promise.all(
      [1, 2].map(() => store.verifyTotp({ userId: 1, expectedGen: 1, now: next, code: codeFor(secretB32, next) })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "replay" }]);
    await store.forgetLoginIps();
    expect(
      await store.verifyTotp({ userId: 1, expectedGen: 1, now: next + 30000, code: codeFor(secretB32, next + 30000) }),
    ).toEqual({ ok: false, reason: "stale" });
  });

  it("recovery is salted, single-use (including concurrent calls), and regeneration invalidates old sets", async () => {
    const { codes } = await enrolled();
    expect(new Set(codes).size).toBe(10);
    expect(codes.every((c) => /^[0-9A-HJKMNP-TV-Z]{12}$/.test(c))).toBe(true);
    const stored = sql((db) =>
      db
        .prepare("SELECT code_hash FROM recovery_codes")
        .all()
        .map((r) => Buffer.from(r.code_hash as Uint8Array).toString("hex")),
    );
    expect(stored).toHaveLength(10);
    expect(stored.every((h) => h.length === 64 && !codes.includes(h))).toBe(true);
    const results = await Promise.all(
      [1, 2].map(() => store.consumeRecovery({ userId: 1, expectedGen: 1, now: at, code: codes[0]! })),
    );
    expect(results).toEqual([
      { ok: true, recoveryLeft: 9 },
      { ok: false, reason: "replay" },
    ]);
    const newer = await store.regenRecovery(1, at + 1);
    expect(newer.recoveryCodes).toHaveLength(10);
    expect(newer.recoveryCodes.some((c) => codes.includes(c))).toBe(false);
    expect(await store.consumeRecovery({ userId: 1, expectedGen: 2, now: at + 1, code: codes[1]! })).toEqual({
      ok: false,
      reason: "bad",
    });
  });

  it("Feishu first enrollment issues codes; adding/replacing TOTP NEVER regenerates an existing set", async () => {
    const first = await store.setFeishu2fa({ userId: 1, on: true, now: at });
    expect(first.recoveryCodes).toHaveLength(10);
    const pending = await store.beginTotp({ userId: 1, now: at });
    expect(
      await store.commitTotp({ userId: 1, expectedGen: 1, now: at, code: codeFor(pending.secretB32, at) }),
    ).toEqual({ ok: true, recoveryCodes: [] });
    await expect(store.beginTotp({ userId: 1, now: at })).rejects.toThrow("E_2FA_ENROLLED");
    const replace = await store.beginTotp({ userId: 1, replace: true, now: at });
    expect(
      await store.commitTotp({ userId: 1, expectedGen: 2, now: at, code: codeFor(replace.secretB32, at) }),
    ).toEqual({ ok: true, recoveryCodes: [] });
    expect(await store.consumeRecovery({ userId: 1, expectedGen: 3, now: at, code: first.recoveryCodes![0]! })).toEqual(
      { ok: true, recoveryLeft: 9 },
    );
  });

  it.each(["reset", "sole-factor-off"])(
    "%s retains tombstone, removes enrolled metadata, reopens and re-enrolls with a larger gen",
    async (op) => {
      await store.setFeishu2fa({ userId: 1, on: true, now: at });
      if (op === "reset") await store.reset2fa(1, at + 1);
      else await store.setFeishu2fa({ userId: 1, on: false, now: at + 1 });
      expect(await store.get2faState(1)).toEqual({
        state: "none",
        totp: false,
        feishu: false,
        recoveryLeft: 0,
        factorGen: 2,
      });
      expect(sql((db) => db.prepare("SELECT value FROM meta WHERE key='twofa_users'").get()?.value)).toBe("[]");
      expect(sql((db) => db.prepare("SELECT factor_gen FROM twofa WHERE user_id=1").get()?.factor_gen)).toBe(2);
      await store.close();
      expect((await open()).ok).toBe(true);
      const p = await store.beginTotp({ userId: 1, now: at + 2 });
      const result = await store.commitTotp({
        userId: 1,
        expectedGen: 2,
        now: at + 2,
        code: codeFor(p.secretB32, at + 2),
      });
      expect(result.ok).toBe(true);
      expect((await store.get2faState(1)).factorGen).toBe(3);
      expect(sql((db) => db.prepare("SELECT value FROM meta WHERE key='twofa_users'").get()?.value)).toBe("[1]");
    },
  );

  it("pending TOTP expires after 5m and generation-changing operations invalidate it", async () => {
    let p = await store.beginTotp({ userId: 1, now: at });
    expect(
      await store.commitTotp({ userId: 1, expectedGen: 0, now: at + 300000, code: codeFor(p.secretB32, at + 300000) }),
    ).toEqual({ ok: false, reason: "none" });
    p = await store.beginTotp({ userId: 1, now: at });
    expect(await store.commitTotp({ userId: 1, expectedGen: 1, now: at, code: codeFor(p.secretB32, at) })).toEqual({
      ok: false,
      reason: "stale",
    });
    await store.reset2fa(1, at);
    expect(await store.commitTotp({ userId: 1, expectedGen: 1, now: at, code: codeFor(p.secretB32, at) })).toEqual({
      ok: false,
      reason: "none",
    });
  });

  it("malformed factor codes reject asynchronously with E_BAD_REQUEST before any IPC write", async () => {
    const write = writes.at(-1)!;
    write.mockClear();
    for (const code of ["12345", "1234567", "12345x", "１２３４５６"]) {
      await expect(store.verifyTotp({ userId: 1, expectedGen: 0, now: at, code })).rejects.toMatchObject({
        code: "E_BAD_REQUEST",
      });
      await expect(store.commitTotp({ userId: 1, expectedGen: 0, now: at, code })).rejects.toMatchObject({
        code: "E_BAD_REQUEST",
      });
    }
    for (const code of ["0123456789A", "0123456789AU", "abcdefghijkl", "0123-4567-89AB"]) {
      await expect(store.consumeRecovery({ userId: 1, expectedGen: 0, now: at, code })).rejects.toMatchObject({
        code: "E_BAD_REQUEST",
      });
    }
    expect(write).not.toHaveBeenCalled();
    expect(await store.verifyTotp({ userId: 1, expectedGen: 0, now: at, code: "123456" })).toEqual({
      ok: false,
      reason: "none",
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("bounds Unicode/escaped UA metadata so all 32 complete rows fit the 64 KiB child frame", async () => {
    for (let i = 0; i < 32; i++) {
      expect((await store.createSessionChecked({ ...input(at + i), ua: '😀"\\'.repeat(256) })).ok).toBe(true);
    }
    const rows = await store.listSessions(1, at + 33);
    expect(rows).toHaveLength(32);
    expect(rows.every((row) => Buffer.byteLength(JSON.stringify(row.ua)) <= 514)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThan(64 * 1024);
  });

  it("metadata failure rolls back guarded session insertion", async () => {
    sql((db) =>
      db.exec(
        "CREATE TRIGGER reject_session_meta BEFORE INSERT ON session_meta BEGIN SELECT RAISE(ABORT,'test session rollback'); END",
      ),
    );
    await expect(store.createSessionChecked(input())).rejects.toThrow("test session rollback");
    expect(await store.listSessions(1, at)).toEqual([]);
    expect(sql((db) => db.prepare("SELECT count(*) AS n FROM sessions").get()?.n)).toBe(0);
  });

  it("runtime missing enrolled row is inconsistent and checked insertion fails closed", async () => {
    await store.setFeishu2fa({ userId: 1, on: true, now: at });
    sql((db) => db.exec("DELETE FROM twofa WHERE user_id=1"));
    expect((await store.get2faState(1)).state).toBe("inconsistent");
    await expect(store.createSessionChecked(input(at, 0))).rejects.toThrow("2fa-missing-row");
    expect(await store.listSessions(1, at)).toEqual([]);
  });
});
