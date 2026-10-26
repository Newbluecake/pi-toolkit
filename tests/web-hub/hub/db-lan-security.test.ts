/** Maintenance safety on real SQLite files. Every refusal is checked through the public open path. */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLanStore, repairLan2fa, type LanStore } from "../../../src/web-hub/hub/lan-store.js";
import { checkDbFiles, hasNodeSqlite, LOGIN_IPS_SQL, TWOFA_SQL } from "../../../src/web-hub/hub/db.js";
import { NEW_IP_WINDOW_MS } from "../../../src/web-hub/protocol/lan-2fa.js";
import { hashSid } from "../../../src/web-hub/hub/sid-hash.js";
import { memLog } from "./helpers.js";

const sqlite = (await hasNodeSqlite())
  ? (createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite"))
  : undefined;
const suite = sqlite ? describe : describe.skip;
const now = 1_800_000_000_000;

suite("LAN security open/check/migrate and explicit repair", () => {
  let dir: string, file: string, store: LanStore;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "lan-B-schema-"));
    file = join(dir, "hub.db");
    const result = await open();
    expect(result.loginIpsRebuilt).toBe(false);
  });
  afterEach(async () => {
    await store?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function open() {
    const result = await createLanStore({ dbFile: file, log: memLog() });
    if (!result.ok) throw new Error(JSON.stringify(result));
    store = result.store;
    await store.getUserSummary(1); // readiness barrier before direct fixture SQL touches the file
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
  async function refuse(detail: string) {
    const result = await createLanStore({ dbFile: file, log: memLog() });
    if (result.ok) {
      await result.store.close();
      throw new Error("Opened an invalid database");
    }
    expect(result).toEqual({ ok: false, reason: "db-invalid", detail });
  }
  async function enroll() {
    await store.setFeishu2fa({ userId: 1, on: true, now });
    await store.close();
  }
  async function session() {
    const result = await store.createSessionChecked({
      userId: 1,
      expectedEpoch: 1,
      expectedFactorGen: 0,
      boundOrigin: "http://lan",
      createdIp: "192.0.2.5",
      ua: "browser",
      now,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("insert failed");
    return hashSid(result.sid);
  }

  it.each(["twofa", "recovery_codes"])(
    "refuses v1 with even one security table (%s), leaving it untouched",
    async (table) => {
      await store.close();
      sql((db) => db.exec(`CREATE TABLE ${table} (evidence TEXT); INSERT INTO ${table} VALUES ('do not erase')`));
      await refuse("2fa-at-v1");
      expect(sql((db) => db.prepare(`SELECT evidence FROM ${table}`).get()?.evidence)).toBe("do not erase");
    },
  );

  it.each(["twofa", "recovery_codes"])("refuses v2 missing %s, without recreating it", async (table) => {
    await enroll();
    sql((db) => db.exec(`DROP TABLE ${table}`));
    await refuse("2fa-schema");
    expect(sql((db) => db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table))).toBeUndefined();
  });

  it.each([
    ["missing column", "ALTER TABLE twofa DROP COLUMN totp_last_step"],
    [
      "wrong type",
      "DROP TABLE recovery_codes; CREATE TABLE recovery_codes(user_id INTEGER NOT NULL REFERENCES twofa(user_id) ON DELETE CASCADE, code_hash TEXT NOT NULL,used_at INTEGER,PRIMARY KEY(user_id,code_hash)) STRICT",
    ],
    [
      "wrong PK order",
      "DROP TABLE recovery_codes; CREATE TABLE recovery_codes(user_id INTEGER NOT NULL REFERENCES twofa(user_id) ON DELETE CASCADE,code_hash BLOB NOT NULL,used_at INTEGER,PRIMARY KEY(code_hash,user_id)) STRICT",
    ],
    [
      "missing FK",
      "DROP TABLE recovery_codes; CREATE TABLE recovery_codes(user_id INTEGER NOT NULL,code_hash BLOB NOT NULL,used_at INTEGER,PRIMARY KEY(user_id,code_hash)) STRICT",
    ],
    [
      "wrong FK action",
      "DROP TABLE recovery_codes; CREATE TABLE recovery_codes(user_id INTEGER NOT NULL REFERENCES twofa(user_id) ON DELETE RESTRICT,code_hash BLOB NOT NULL,used_at INTEGER,PRIMARY KEY(user_id,code_hash)) STRICT",
    ],
    [
      "widened NULL",
      "DROP TABLE recovery_codes; CREATE TABLE recovery_codes(user_id INTEGER REFERENCES twofa(user_id) ON DELETE CASCADE,code_hash BLOB,used_at INTEGER,PRIMARY KEY(user_id,code_hash))",
    ],
    ["extra column", "ALTER TABLE twofa ADD COLUMN unexpected INTEGER"],
  ])("refuses malformed v2 %s", async (_name, mutate) => {
    await enroll();
    sql((db) => db.exec(mutate));
    await refuse("2fa-schema");
  });

  it.each([
    "DELETE FROM twofa WHERE user_id=1",
    "UPDATE twofa SET feishu=0 WHERE user_id=1",
    "DELETE FROM meta WHERE key='twofa_users'",
    "UPDATE meta SET value='not json' WHERE key='twofa_users'",
    "UPDATE meta SET value='[2]' WHERE key='twofa_users'",
    "UPDATE meta SET value='[]' WHERE key='twofa_users'",
  ])("refuses broken enrolled metadata/factor: %s", async (mutate) => {
    await enroll();
    sql((db) => db.exec(mutate));
    await refuse("2fa-missing-row");
  });

  it("repair works while LAN is off, empties both security tables, keeps v2 and audits only op/ok", async () => {
    await enroll();
    sql((db) => db.exec("DROP TABLE twofa"));
    await refuse("2fa-schema");
    const log = memLog();
    expect(await repairLan2fa({ dbFile: file, log })).toMatchObject({ ok: true });
    expect(sql((db) => db.prepare("PRAGMA user_version").get()?.user_version)).toBe(2);
    expect(sql((db) => db.prepare("SELECT count(*) AS n FROM recovery_codes").get()?.n)).toBe(0);
    expect(sql((db) => db.prepare("SELECT value FROM meta WHERE key='twofa_users'").get()?.value)).toBe("[]");
    expect(log.lines.filter((line) => line.msg === "lan-2fa")).toEqual([
      { level: "info", msg: "lan-2fa", data: { audit: "lan-2fa", op: "repair", ok: true } },
    ]);
    expect(JSON.stringify(log.lines)).not.toContain("recoveryCodes");
    await open();
    expect((await store.get2faState(1)).state).toBe("none");
    const fresh = await store.setFeishu2fa({ userId: 1, on: true, now });
    expect(fresh.recoveryCodes).toHaveLength(10);
  });

  it("repair is cancellable before dispatch and does not create security tables", async () => {
    await store.close();
    expect(await repairLan2fa({ dbFile: file, log: memLog(), signal: AbortSignal.abort() })).toEqual({
      ok: false,
      reason: "db-timeout",
    });
    expect(sql((db) => db.prepare("SELECT name FROM sqlite_master WHERE name='twofa'").get())).toBeUndefined();
  });

  it("additively migrates legacy metadata, retaining UA/IP and treating legacy sessions as password", async () => {
    const hash = await session();
    await store.close();
    sql((db) => db.exec("ALTER TABLE session_meta DROP COLUMN method"));
    await open();
    expect(await store.listSessions(1, now)).toMatchObject([
      { sidHash: hash, ua: "browser", lastIp: "192.0.2.5", method: "password" },
    ]);
    expect(sql((db) => db.prepare("SELECT method FROM session_meta").get()?.method)).toBe("password");
    await store.close();
    await open();
    expect(await store.listSessions(1, now)).toMatchObject([{ method: "password", ua: "browser" }]);
  });

  it.each(["missing", "malformed"])("rebuilds %s auxiliary metadata without deleting sessions", async (kind) => {
    const hash = await session();
    await store.close();
    sql((db) => {
      db.exec("DROP TABLE session_meta");
      if (kind === "malformed") db.exec("CREATE TABLE session_meta(sid_hash TEXT PRIMARY KEY, extra TEXT)");
    });
    await open();
    expect((await store.listSessions(1, now)).map((s) => s.sidHash)).toEqual([hash]);
    expect((await store.listSessions(1, now))[0]?.ua).toBeUndefined();
    await store.deleteSession(hash);
    expect(sql((db) => db.prepare("SELECT count(*) AS n FROM session_meta").get()?.n)).toBe(0);
  });

  it.each(["missing", "malformed"])("rebuilds %s login_ips EMPTY, reports it and retains seed marker", async (kind) => {
    await session();
    await store.noteLoginIp(1, "192.0.2.5", now);
    await store.close();
    sql((db) => {
      db.exec("DROP TABLE login_ips");
      if (kind === "malformed") db.exec("CREATE TABLE login_ips(ip TEXT PRIMARY KEY, last_at TEXT)");
    });
    expect((await open()).loginIpsRebuilt).toBe(true);
    expect(await store.knownIpCount(1, now, NEW_IP_WINDOW_MS)).toBe(0);
    expect(await store.isKnownIp(1, "192.0.2.5", now, NEW_IP_WINDOW_MS)).toBe(false);
    expect(sql((db) => db.prepare("SELECT value FROM meta WHERE key='login_ips_seeded'").get()?.value)).toBe("1");
    await store.close();
    expect((await open()).loginIpsRebuilt).toBe(false);
    expect(await store.knownIpCount(1, now, NEW_IP_WINDOW_MS)).toBe(0);
  });

  it("seeds legacy sessions EXACTLY once; forget-ips and later rebuild never re-import old trust", async () => {
    await session();
    await store.close();
    sql((db) => db.exec("DROP TABLE login_ips; DELETE FROM meta WHERE key='login_ips_seeded'"));
    expect((await open()).loginIpsRebuilt).toBe(false);
    expect(await store.isKnownIp(1, "192.0.2.5", now, NEW_IP_WINDOW_MS)).toBe(true);
    await store.forgetLoginIps();
    await store.close();
    await open();
    expect(await store.isKnownIp(1, "192.0.2.5", now, NEW_IP_WINDOW_MS)).toBe(false);
    await store.close();
    sql((db) => db.exec("DROP TABLE login_ips"));
    expect((await open()).loginIpsRebuilt).toBe(true);
    expect(await store.isKnownIp(1, "192.0.2.5", now, NEW_IP_WINDOW_MS)).toBe(false);
  });

  it("does not seed from sessions when a malformed unseeded history table is rebuilt", async () => {
    await session();
    await store.close();
    sql((db) =>
      db.exec("DELETE FROM meta WHERE key='login_ips_seeded'; DROP TABLE login_ips; CREATE TABLE login_ips(ip TEXT)"),
    );
    expect((await open()).loginIpsRebuilt).toBe(true);
    expect(await store.knownIpCount(1, now, NEW_IP_WINDOW_MS)).toBe(0);
  });

  it("first enrollment keeps the seed marker, so rebuilding trust afterwards stays empty", async () => {
    await session();
    await store.noteLoginIp(1, "192.0.2.5", now);
    await enroll();
    sql((db) => db.exec("DROP TABLE login_ips"));
    expect((await open()).loginIpsRebuilt).toBe(true);
    expect(await store.knownIpCount(1, now, NEW_IP_WINDOW_MS)).toBe(0);
    expect(await store.listSessions(1, now)).toHaveLength(1);
  });

  it("trims legacy excess sessions at open, cascades metadata, and keeps the newest 32", async () => {
    await store.close();
    sql((db) => {
      const insert = db.prepare(
        "INSERT INTO sessions(sid_hash,user_id,epoch,bound_origin,created_at,last_seen_at,expires_at,absolute_expires_at,created_ip) VALUES(?,1,1,'http://lan',?,?,?,?, '192.0.2.1')",
      );
      for (let i = 0; i < 40; i++) {
        const hash = Buffer.alloc(32, i);
        insert.run(hash, now + i, now + i, now + 86400000, now + 7 * 86400000);
        db.prepare("INSERT INTO session_meta(sid_hash,user_agent) VALUES(?, 'legacy')").run(hash);
      }
    });
    await open();
    const rows = await store.listSessions(1, now + 41);
    expect(rows).toHaveLength(32);
    expect(Math.min(...rows.map((r) => r.lastSeenAt))).toBe(now + 8);
    expect(sql((db) => db.prepare("SELECT count(*) AS n FROM session_meta").get()?.n)).toBe(32);
  });

  it("bulk delete's defensive 64 cap reports incomplete honestly, then completes on retry", async () => {
    sql((db) => {
      const insert = db.prepare(
        "INSERT INTO sessions(sid_hash,user_id,epoch,bound_origin,created_at,last_seen_at,expires_at,absolute_expires_at,created_ip) VALUES(?,1,1,'http://lan',?,?,?,?, '192.0.2.1')",
      );
      for (let i = 0; i < 70; i++)
        insert.run(Buffer.alloc(32, i), now + i, now + i, now + 86400000, now + 7 * 86400000);
    });
    const first = await store.deleteSessionsExcept(1, Buffer.alloc(32, 69).toString("base64url"));
    expect(first.more).toBe(true);
    expect(first.deleted).toHaveLength(64);
    const second = await store.deleteSessionsExcept(1, Buffer.alloc(32, 69).toString("base64url"));
    expect(second.more).toBe(false);
    expect(second.deleted).toHaveLength(5);
    expect(await store.listSessions(1, now + 71)).toHaveLength(1);
  });

  it("failed enrollment rolls back tables, version, metadata AND history together", async () => {
    await store.noteLoginIp(1, "192.0.2.5", now);
    sql((db) =>
      db.exec(
        "CREATE TRIGGER abort_enroll BEFORE UPDATE ON meta WHEN NEW.key='twofa_users' BEGIN SELECT RAISE(ABORT,'test enrollment rollback'); END",
      ),
    );
    await expect(store.setFeishu2fa({ userId: 1, on: true, now })).rejects.toThrow("test enrollment rollback");
    expect(sql((db) => db.prepare("PRAGMA user_version").get()?.user_version)).toBe(1);
    expect(sql((db) => db.prepare("SELECT name FROM sqlite_master WHERE name='twofa'").get())).toBeUndefined();
    expect(await store.isKnownIp(1, "192.0.2.5", now, NEW_IP_WINDOW_MS)).toBe(true);
  });

  it("refuses security views at v1 and explicitly repairs them without treating them as no enrollment", async () => {
    await store.close();
    sql((db) => db.exec("CREATE VIEW twofa AS SELECT id AS user_id FROM users"));
    await refuse("2fa-at-v1");
    expect(await repairLan2fa({ dbFile: file, log: memLog() })).toMatchObject({ ok: true });
    await open();
    expect((await store.get2faState(1)).state).toBe("none");
  });

  it("rebuilds auxiliary views in the safe direction", async () => {
    await session();
    await store.close();
    sql((db) =>
      db.exec(
        "DROP TABLE login_ips; DROP TABLE session_meta; CREATE VIEW login_ips AS SELECT created_ip AS ip,created_at AS first_at,last_seen_at AS last_at FROM sessions; CREATE VIEW session_meta AS SELECT sid_hash FROM sessions",
      ),
    );
    expect((await open()).loginIpsRebuilt).toBe(true);
    expect(await store.knownIpCount(1, now, NEW_IP_WINDOW_MS)).toBe(0);
    expect(await store.listSessions(1, now)).toHaveLength(1);
  });

  it("DDL constants are strict and recovery codes reference the owning factor row", () => {
    sql((db) => {
      db.exec(TWOFA_SQL);
      db.exec("PRAGMA user_version=2");
    });
    expect(sql((db) => db.prepare("PRAGMA foreign_key_list(recovery_codes)").all())).toMatchObject([
      { table: "twofa", from: "user_id", to: "user_id", on_delete: "CASCADE" },
    ]);
    expect(LOGIN_IPS_SQL).toContain("STRICT");
  });
  it("migrates exact old global trust from sessions per account with a 30d window, never copies global-only IPs", async () => {
    const recent = Date.now();
    await store.setPassword({
      username: "other",
      kdf: "scrypt",
      n: 32768,
      r: 8,
      p: 1,
      salt: new Uint8Array(16),
      hash: new Uint8Array(32),
    });
    const other = (await store.getUser("other"))!;
    await store.close();
    sql((db) => {
      db.exec(
        "PRAGMA foreign_keys=ON; DROP TABLE login_ips; CREATE TABLE login_ips(ip TEXT PRIMARY KEY, first_at INTEGER NOT NULL,last_at INTEGER NOT NULL) STRICT; INSERT INTO login_ips VALUES('global-only',1,1)",
      );
      const insert = db.prepare(
        "INSERT INTO sessions(sid_hash,user_id,epoch,bound_origin,created_at,last_seen_at,expires_at,absolute_expires_at,created_ip) VALUES(?,?,1,'http://lan',?,?,?,?,?)",
      );
      insert.run(Buffer.alloc(32, 1), 1, recent - 100, recent, recent + 100000, recent + 100000, "a-only");
      insert.run(Buffer.alloc(32, 2), other.id, recent - 100, recent, recent + 100000, recent + 100000, "b-only");
      insert.run(
        Buffer.alloc(32, 3),
        1,
        recent - 31 * 86400000,
        recent - 31 * 86400000,
        recent + 100000,
        recent + 100000,
        "stale",
      );
      // Exercise per-user migration cap before legacy session trimming.
      for (let i = 0; i < 257; i++) {
        const hash = Buffer.alloc(32);
        hash.writeUInt32BE(i + 100, 0);
        insert.run(hash, other.id, recent, recent + i + 1, recent + 100000, recent + 100000, `ip-${i}`);
      }
    });
    expect((await open()).loginIpsRebuilt).toBe(true);
    expect(await store.isKnownIp(1, "a-only", recent, NEW_IP_WINDOW_MS)).toBe(true);
    expect(await store.isKnownIp(other.id, "a-only", recent, NEW_IP_WINDOW_MS)).toBe(false);
    expect(await store.isKnownIp(1, "b-only", recent, NEW_IP_WINDOW_MS)).toBe(false);
    expect(await store.isKnownIp(1, "global-only", recent, NEW_IP_WINDOW_MS)).toBe(false);
    expect(await store.isKnownIp(1, "stale", recent, NEW_IP_WINDOW_MS)).toBe(false);
    expect(await store.knownIpCount(1, recent, NEW_IP_WINDOW_MS)).toBe(1);
    expect(await store.knownIpCount(other.id, recent, NEW_IP_WINDOW_MS)).toBe(256);
    expect(sql((db) => db.prepare("PRAGMA foreign_key_list(login_ips)").all())).toMatchObject([
      { from: "user_id", table: "users", to: "id", on_delete: "CASCADE" },
    ]);
    await store.close();
    expect((await open()).loginIpsRebuilt).toBe(false);
  });

  it("deleteUser enforces all CASCADE FKs and updates security metadata so reopen stays valid", async () => {
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
    const factors = await store.setFeishu2fa({ userId: extra.id, on: true, now });
    expect(factors.recoveryCodes).toHaveLength(10);
    const made = await store.createSessionChecked({
      userId: extra.id,
      expectedEpoch: extra.epoch,
      expectedFactorGen: 1,
      boundOrigin: "http://lan",
      createdIp: "extra-ip",
      ua: "extra-browser",
      now,
    });
    if (!made.ok) throw Error("fixture insertion");
    await store.noteLoginIp(extra.id, "extra-ip", now);
    const sidHash = Buffer.from(hashSid(made.sid), "base64url");
    expect(sql((db) => db.prepare("SELECT count(*) AS n FROM session_meta WHERE sid_hash=?").get(sidHash)?.n)).toBe(1);
    expect(await store.deleteUser("extra")).toEqual({ ok: true, userId: extra.id });
    sql((db) => {
      db.exec("PRAGMA foreign_keys=ON");
      expect(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      for (const table of ["sessions", "twofa", "recovery_codes", "login_ips"])
        expect(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE user_id=?`).get(extra.id)?.n, table).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM session_meta WHERE sid_hash=?").get(sidHash)?.n).toBe(0);
      expect(db.prepare("SELECT value FROM meta WHERE key='twofa_users'").get()?.value).toBe("[]");
      expect(db.prepare("SELECT count(*) AS n FROM users").get()?.n).toBe(1);
    });
    await store.close();
    await open();
    expect(await store.getUser("extra")).toBeUndefined();
    expect(await store.get2faState(1)).toMatchObject({ state: "none" });
  });
  it.each([20, 53, 19, 21, 52, 54, 0])(
    "#66 P6 factor envelope length %i is validated without decryption",
    async (length) => {
      await enroll();
      const blob = Buffer.alloc(length);
      if (length === 53) blob[0] = 1;
      sql((db) => db.prepare("UPDATE twofa SET totp_secret=?,totp_last_step=1 WHERE user_id=1").run(blob));
      if (length === 20 || length === 53) {
        const r = await open();
        expect(r.hardening.totpKey).toBe(length === 53 ? "missing" : "none");
        expect((await store.get2faState(1)).state).toBe("enrolled");
      } else await refuse("2fa-missing-row");
    },
  );
  it("#66 P6 unknown 53B envelope version remains fail-closed", async () => {
    await enroll();
    sql((db) => db.prepare("UPDATE twofa SET totp_secret=?,totp_last_step=1 WHERE user_id=1").run(Buffer.alloc(53, 2)));
    await refuse("2fa-missing-row");
  });
});

it("bounds a never-settling main-thread file check instead of hanging LAN startup", async () => {
  vi.useFakeTimers();
  try {
    const lstat = vi.fn(() => new Promise<never>(() => {}));
    const pending = checkDbFiles("/unused/lan-B.db", {
      log: memLog(),
      fs: { lstat: lstat as typeof import("node:fs/promises").lstat },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual({
      ok: false,
      reason: "db-invalid",
      detail: "/unused/lan-B.db: db file check exceeded 1000ms",
    });
    expect(lstat).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
