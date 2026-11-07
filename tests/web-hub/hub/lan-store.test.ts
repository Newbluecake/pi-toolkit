/**
 * plan §4.3: full `LanStorePort` contract against a real resident query
 * subprocess (spawned via `db-client.ts`) and a real maintenance subprocess
 * (via `lan-store.ts`'s `createLanStore`), talking to an actual on-disk
 * SQLite file. `skipIf(!hasNodeSqlite)`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createLanStore, type LanStore } from "../../../src/web-hub/hub/lan-store.js";
import { hasNodeSqlite } from "../../../src/web-hub/hub/db.js";
import { WRITER_SOAK_MS } from "../../../src/web-hub/hub/hardening.js";
import { createKdf, newKdfParams, validateKdfParams, KDF_LEGACY, KDF_PHASE2 } from "../../../src/web-hub/hub/kdf.js";
import { memLog } from "./helpers.js";
import { createKdfUpgrader } from "../../../src/web-hub/hub/kdf-upgrade.js";
import { hashSid } from "../../../src/web-hub/hub/sid-hash.js";
import { vi } from "vitest";
import { createLanLoginCore } from "../../../src/web-hub/hub/lan-login.js";
import { createAuthRevokeBus } from "../../../src/web-hub/hub/auth-revoke.js";
import { createSecurityEventBus } from "../../../src/web-hub/hub/security-events.js";
import { fakeKdfAdmission, fakeLoginLimiter } from "../contract/fakes.js";

const skipIfNoSqlite = (await hasNodeSqlite()) ? describe : describe.skip;
const sqlite = (await hasNodeSqlite())
  ? (createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite"))
  : undefined;
// L8 "用户名默认系统登录名": the real `createLanStore` seeds this OS username, not the P1
// literal `"admin"` — asserted against whatever account this test process actually runs as.
const USERNAME = userInfo().username;

function tmp(): { dir: string; dbFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "wh-lan-store-"));
  return { dir, dbFile: join(dir, "hub.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

skipIfNoSqlite("lan-store.ts (plan §4 LanStorePort contract)", () => {
  let dir: { dir: string; dbFile: string; cleanup: () => void };
  let store: LanStore;

  beforeEach(async () => {
    dir = tmp();
    const res = await createLanStore({ dbFile: dir.dbFile, log: memLog(), test: true });
    if (!res.ok) throw new Error(`createLanStore failed: ${res.reason} ${res.detail ?? ""}`);
    store = res.store;
  });

  afterEach(async () => {
    await store.close();
    dir.cleanup();
  });

  it("bootstraps exactly one initial user with a plaintext initial password (Q14)", async () => {
    const info = await store.initialInfo();
    expect(info?.username).toBe(USERNAME);
    expect(typeof info?.initialPassword).toBe("string");
    expect(info?.initialPassword?.length).toBeGreaterThan(0);
    expect(info?.initialLogin).toBeUndefined();

    const user = await store.getUser(USERNAME);
    expect(user?.kdf).toBe("scrypt");
    expect(user?.salt).toBeInstanceOf(Uint8Array);
    expect(user?.hash.byteLength).toBe(32);
    expect(user?.initialPassword).toBe(info?.initialPassword);
  });

  it("db file and -wal/-shm (once written) are mode 0600", async () => {
    await store.createSession({ userId: 1, epoch: 1, boundOrigin: "http://x", createdIp: "1.2.3.4", now: Date.now() });
    expect(statSync(dir.dbFile).mode & 0o777).toBe(0o600);
  });

  it("createSession returns a raw sid; only sha256(sid) ever reaches the db file", async () => {
    const now = 1_000_000;
    const { sid } = await store.createSession({
      userId: 1,
      epoch: 1,
      boundOrigin: "http://x",
      createdIp: "1.2.3.4",
      now,
    });
    expect(typeof sid).toBe("string");
    // Review fix (§6.4): sid is 32 raw bytes, base64url-encoded (unpadded) — 43 chars.
    expect(sid.length).toBe(43);

    const raw =
      readFileSync(dir.dbFile, "latin1") +
      (() => {
        try {
          return readFileSync(`${dir.dbFile}-wal`, "latin1");
        } catch {
          return "";
        }
      })();
    expect(raw.includes(sid)).toBe(false);

    const { createHash } = await import("node:crypto");
    const sidHash = createHash("sha256").update(sid).digest("base64url");
    const rec = await store.touchSession(sidHash, now + 1);
    expect(rec).toEqual({
      userId: 1,
      epoch: 1,
      boundOrigin: "http://x",
      expiresAt: now + 12 * 3600_000,
      absoluteExpiresAt: now + 7 * 24 * 3600_000,
    });
  });

  it("touchSession: expired / wrong epoch-agnostic lookup returns undefined past expiry", async () => {
    const now = 2_000_000;
    const { sid } = await store.createSession({
      userId: 1,
      epoch: 1,
      boundOrigin: "http://x",
      createdIp: "1.2.3.4",
      now,
    });
    const { createHash } = await import("node:crypto");
    const sidHash = createHash("sha256").update(sid).digest("base64url");
    // absolute cap is 7d out; well past 12h+ε with no intervening touch ⇒ expired.
    const rec = await store.touchSession(sidHash, now + 12 * 3600_000 + 1);
    expect(rec).toBeUndefined();
  });

  it("touchSession throttles writes within 60s but still returns the live record", async () => {
    const now = 3_000_000;
    const { sid } = await store.createSession({
      userId: 1,
      epoch: 1,
      boundOrigin: "http://x",
      createdIp: "1.2.3.4",
      now,
    });
    const { createHash } = await import("node:crypto");
    const sidHash = createHash("sha256").update(sid).digest("base64url");
    const r1 = await store.touchSession(sidHash, now + 1000);
    expect(r1?.expiresAt).toBe(now + 12 * 3600_000); // not yet 60s since createdAt≈lastSeenAt ⇒ no slide
    const r2 = await store.touchSession(sidHash, now + 61_000);
    expect(r2?.expiresAt).toBe(now + 61_000 + 12 * 3600_000); // slid forward
  });

  it("touchSessionReserved behaves identically to touchSession for the same session", async () => {
    const now = 4_000_000;
    const { sid } = await store.createSession({
      userId: 1,
      epoch: 1,
      boundOrigin: "http://x",
      createdIp: "1.2.3.4",
      now,
    });
    const { createHash } = await import("node:crypto");
    const sidHash = createHash("sha256").update(sid).digest("base64url");
    const rec = await store.touchSessionReserved(sidHash, now + 1);
    expect(rec?.userId).toBe(1);
  });

  it("deleteSession removes the session; a later touch is undefined", async () => {
    const now = 5_000_000;
    const { sid } = await store.createSession({
      userId: 1,
      epoch: 1,
      boundOrigin: "http://x",
      createdIp: "1.2.3.4",
      now,
    });
    const { createHash } = await import("node:crypto");
    const sidHash = createHash("sha256").update(sid).digest("base64url");
    await store.deleteSession(sidHash);
    expect(await store.touchSession(sidHash, now + 1)).toBeUndefined();
  });

  it("setPassword: bumps epoch, clears initial_password, deletes all of that user's sessions", async () => {
    const now = 6_000_000;
    const { sid } = await store.createSession({
      userId: 1,
      epoch: 1,
      boundOrigin: "http://x",
      createdIp: "1.2.3.4",
      now,
    });
    const { createHash, scryptSync, randomBytes } = await import("node:crypto");
    const sidHash = createHash("sha256").update(sid).digest("base64url");
    expect(await store.touchSession(sidHash, now + 1)).toBeDefined();

    const salt = randomBytes(16);
    const hash = scryptSync("newpass1234", salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 32768 * 8 + 1024 * 1024 });
    await store.setPassword({ username: USERNAME, kdf: "scrypt", n: 32768, r: 8, p: 1, salt, hash });

    expect(await store.touchSession(sidHash, now + 2)).toBeUndefined(); // session deleted
    const user = await store.getUser(USERNAME);
    expect(user?.epoch).toBe(2);
    expect(user?.initialPassword).toBeUndefined();
    expect(Buffer.from(user!.hash).equals(Buffer.from(hash))).toBe(true);
  });

  it("deleteAllSessions removes every session for that user only", async () => {
    const now = 7_000_000;
    const { createHash } = await import("node:crypto");
    const { sid: sidA } = await store.createSession({
      userId: 1,
      epoch: 1,
      boundOrigin: "http://x",
      createdIp: "1.1.1.1",
      now,
    });
    const { sid: sidB } = await store.createSession({
      userId: 1,
      epoch: 1,
      boundOrigin: "http://x",
      createdIp: "1.1.1.2",
      now,
    });
    const hashA = createHash("sha256").update(sidA).digest("base64url");
    const hashB = createHash("sha256").update(sidB).digest("base64url");
    await store.deleteAllSessions(1);
    expect(await store.touchSession(hashA, now + 1)).toBeUndefined();
    expect(await store.touchSession(hashB, now + 1)).toBeUndefined();
  });

  it("markInitialLogin sets ip/at once; a second call doesn't overwrite it", async () => {
    await store.markInitialLogin(USERNAME, "10.0.0.5", 42);
    let info = await store.initialInfo();
    expect(info?.initialLogin).toEqual({ ip: "10.0.0.5", at: 42 });
    await store.markInitialLogin(USERNAME, "10.0.0.9", 99);
    info = await store.initialInfo();
    expect(info?.initialLogin).toEqual({ ip: "10.0.0.5", at: 42 }); // unchanged
  });

  describe("#66 D4: first login wipes the initial plaintext (one statement)", () => {
    const rawRow = async () => {
      const { DatabaseSync } = sqlite!;
      const db = new DatabaseSync(dir.dbFile, { readOnly: true });
      try {
        return db
          .prepare(
            "SELECT initial_password AS pw, initial_created_at AS created, initial_login_at AS at, initial_login_ip AS ip, epoch FROM users WHERE username=?",
          )
          .get(USERNAME) as {
          pw: string | null;
          created: number | null;
          at: number | null;
          ip: string | null;
          epoch: number;
        };
      } finally {
        db.close();
      }
    };
    const fileHas = (needle: string) =>
      [dir.dbFile, `${dir.dbFile}-wal`].some((f) => {
        try {
          return readFileSync(f).includes(needle);
        } catch {
          return false;
        }
      });

    it("records ip/at and NULLs initial_password in one call; created_at stays; epoch untouched", async () => {
      const before = await rawRow();
      expect(typeof before.pw).toBe("string");
      expect(before.created).not.toBeNull();
      expect(await store.markInitialLogin(USERNAME, "10.0.0.5", 42)).toEqual({ cleared: true });
      const after = await rawRow();
      expect(after).toEqual({ pw: null, created: before.created, at: 42, ip: "10.0.0.5", epoch: before.epoch });
      const user = await store.getUser(USERNAME);
      expect(user?.initialPassword).toBeUndefined();
      expect(user?.initialCreatedAt).toBe(before.created);
      expect(user?.initialLoginAt).toBe(42);
    });

    it("the three old criteria agree on the new one: summary in-use, info has initialLogin but no plaintext", async () => {
      await store.markInitialLogin(USERNAME, "10.0.0.5", 42);
      expect(await store.getUserSummary(1)).toEqual({ username: USERNAME, initialPasswordInUse: true });
      const info = await store.initialInfo();
      expect(info).toEqual({ username: USERNAME, initialLogin: { ip: "10.0.0.5", at: 42 } });
    });

    it("a second call is a no-op ({cleared:false}) and never overwrites the first ip/at", async () => {
      await store.markInitialLogin(USERNAME, "10.0.0.5", 42);
      expect(await store.markInitialLogin(USERNAME, "10.0.0.9", 99)).toEqual({ cleared: false });
      expect((await rawRow()).ip).toBe("10.0.0.5");
      expect((await rawRow()).at).toBe(42);
    });

    it("unknown user ⇒ cleared:false and the real row keeps its plaintext", async () => {
      expect(await store.markInitialLogin("nobody", "10.0.0.5", 42)).toEqual({ cleared: false });
      expect(typeof (await rawRow()).pw).toBe("string");
    });

    it("after setPassword all criteria flip to 'not in use' (initialLogin hidden although initial_login_* remain)", async () => {
      const { scryptSync, randomBytes } = await import("node:crypto");
      await store.markInitialLogin(USERNAME, "10.0.0.5", 42);
      const salt = randomBytes(16);
      const hash = scryptSync("anotherpass1", salt, 32, {
        N: 32768,
        r: 8,
        p: 1,
        maxmem: 128 * 32768 * 8 + 1024 * 1024,
      });
      await store.setPassword({ username: USERNAME, kdf: "scrypt", n: 32768, r: 8, p: 1, salt, hash });
      expect(await store.getUserSummary(1)).toEqual({ username: USERNAME, initialPasswordInUse: false });
      expect(await store.initialInfo()).toEqual({ username: USERNAME });
      expect((await rawRow()).created).toBeNull();
      expect((await rawRow()).ip).toBe("10.0.0.5"); // the record itself is kept; only the reporting is gated
    });

    it("racing setPassword first: the wipe matches nothing (cleared:false), no error, no stray login record", async () => {
      const { scryptSync, randomBytes } = await import("node:crypto");
      const salt = randomBytes(16);
      const hash = scryptSync("anotherpass1", salt, 32, {
        N: 32768,
        r: 8,
        p: 1,
        maxmem: 128 * 32768 * 8 + 1024 * 1024,
      });
      await store.setPassword({ username: USERNAME, kdf: "scrypt", n: 32768, r: 8, p: 1, salt, hash });
      expect(await store.markInitialLogin(USERNAME, "10.0.0.5", 42)).toEqual({ cleared: false });
      const row = await rawRow();
      expect(row.at).toBeNull();
      expect(row.ip).toBeNull();
    });

    it("legacy db (plaintext present, initial_login_* already set by an old hub): wipes, keeps the FIRST record", async () => {
      const { DatabaseSync } = sqlite!;
      const db = new DatabaseSync(dir.dbFile);
      db.prepare("UPDATE users SET initial_login_at=7, initial_login_ip='9.9.9.9' WHERE username=?").run(USERNAME);
      db.close();
      expect(await store.markInitialLogin(USERNAME, "10.0.0.5", 42)).toEqual({ cleared: true });
      const row = await rawRow();
      expect(row).toMatchObject({ pw: null, at: 7, ip: "9.9.9.9" });
    });

    it("legacy db (created_at NULL, plaintext present) still counts as in use and is wiped", async () => {
      const { DatabaseSync } = sqlite!;
      const db = new DatabaseSync(dir.dbFile);
      db.prepare("UPDATE users SET initial_created_at=NULL WHERE username=?").run(USERNAME);
      db.close();
      expect(await store.getUserSummary(1)).toEqual({ username: USERNAME, initialPasswordInUse: true });
      expect(await store.markInitialLogin(USERNAME, "10.0.0.5", 42)).toEqual({ cleared: true });
      // plaintext gone and created_at NULL ⇒ the only remaining evidence is initial_login_*; not "in use".
      expect(await store.getUserSummary(1)).toEqual({ username: USERNAME, initialPasswordInUse: false });
    });

    it("requestCheckpointTruncate: the plaintext is gone from hub.db and -wal afterwards", async () => {
      const plain = (await store.initialInfo())!.initialPassword!;
      expect(fileHas(plain)).toBe(true);
      await store.markInitialLogin(USERNAME, "10.0.0.5", 42);
      store.requestCheckpointTruncate?.();
      await vi.waitFor(() => expect(fileHas(plain)).toBe(false), { timeout: 5_000 });
      expect(store.warnings?.()).toEqual([]);
    });

    it("a blocked TRUNCATE raises initial-password-residue (notified), a later successful one clears it", async () => {
      const { DatabaseSync } = sqlite!;
      const reader = new DatabaseSync(dir.dbFile);
      const events: string[][] = [];
      store.onWarningsChanged?.(() => events.push([...(store.warnings?.() ?? [])]));
      await store.getUserSummary(1); // spawn the resident query child before the reader pins its snapshot
      try {
        reader.exec("BEGIN");
        reader.prepare("SELECT count(*) FROM users").get(); // pins a read snapshot
        await store.markInitialLogin(USERNAME, "10.0.0.5", 42); // new frames the reader cannot see
        store.requestCheckpointTruncate?.();
        await vi.waitFor(() => expect(store.warnings?.()).toEqual(["initial-password-residue"]), { timeout: 6_000 });
      } finally {
        reader.exec("ROLLBACK");
        reader.close();
      }
      store.requestCheckpointTruncate?.();
      await vi.waitFor(() => expect(store.warnings?.()).toEqual([]), { timeout: 6_000 });
      expect(events).toEqual([["initial-password-residue"], []]);
    }, 20_000);

    it("concurrent requestCheckpointTruncate calls are coalesced and never throw", async () => {
      await store.markInitialLogin(USERNAME, "10.0.0.5", 42);
      for (let i = 0; i < 20; i++) store.requestCheckpointTruncate?.();
      await vi.waitFor(() => expect(store.warnings?.()).toEqual([]));
    });
  });

  it("getUserSummary reports initialPasswordInUse by userId, flips false after setPassword", async () => {
    const { scryptSync, randomBytes } = await import("node:crypto");
    let summary = await store.getUserSummary(1);
    expect(summary).toEqual({ username: USERNAME, initialPasswordInUse: true });
    const salt = randomBytes(16);
    const hash = scryptSync("anotherpass1", salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 32768 * 8 + 1024 * 1024 });
    await store.setPassword({ username: USERNAME, kdf: "scrypt", n: 32768, r: 8, p: 1, salt, hash });
    summary = await store.getUserSummary(1);
    expect(summary).toEqual({ username: USERNAME, initialPasswordInUse: false });
  });

  it("initialInfo still finds the user (no initialPassword field) after setPassword clears it (LD review fix: the query used to filter WHERE initial_password IS NOT NULL, so the only row disappeared entirely once the password changed, misreporting E_NO_USER)", async () => {
    const { scryptSync, randomBytes } = await import("node:crypto");
    const salt = randomBytes(16);
    const hash = scryptSync("anotherpass1", salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 32768 * 8 + 1024 * 1024 });
    await store.setPassword({ username: USERNAME, kdf: "scrypt", n: 32768, r: 8, p: 1, salt, hash });
    const info = await store.initialInfo();
    expect(info?.username).toBe(USERNAME);
    expect(info?.initialPassword).toBeUndefined();
  });

  it("purgeExpired deletes only sessions past either expiry and returns the count", async () => {
    const now = 8_000_000;
    await store.createSession({ userId: 1, epoch: 1, boundOrigin: "http://x", createdIp: "1.1.1.1", now });
    const { sid: liveSid } = await store.createSession({
      userId: 1,
      epoch: 1,
      boundOrigin: "http://x",
      createdIp: "1.1.1.2",
      now: now + 20 * 3600_000,
    });
    const n = await store.purgeExpired(now + 13 * 3600_000);
    expect(n).toBe(1);
    const { createHash } = await import("node:crypto");
    const liveHash = createHash("sha256").update(liveSid).digest("base64url");
    expect(await store.touchSession(liveHash, now + 20 * 3600_000 + 1)).toBeDefined();
  });

  it("getUser/getUserSummary for a nonexistent user/id return undefined", async () => {
    expect(await store.getUser("nobody")).toBeUndefined();
    expect(await store.getUserSummary(999)).toBeUndefined();
  });

  it("AbortSignal aborted before the call rejects immediately without touching the subprocess", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(store.getUser(USERNAME, { signal: ac.signal })).rejects.toBeInstanceOf(Error);
  });
});

skipIfNoSqlite(
  "lan-store.ts touchSession dedup (plan \u00a74.2 \u540c sid \u53bb\u91cd\u4e0e\u914d\u989d, review fix)",
  () => {
    it("9 concurrent touchSession calls for the same sidHash fold into exactly 1 IPC; the 9th rider gets E_RATE", async () => {
      const { spawn: realSpawn } = await import("node:child_process");
      const { createHash } = await import("node:crypto");
      let touchOps = 0;
      const dir = tmp();
      const res = await createLanStore({
        dbFile: dir.dbFile,
        log: memLog(),
        test: true,
        dbClient: {
          spawnFn: ((...args: Parameters<typeof realSpawn>) => {
            const child = realSpawn(...args);
            const originalWrite = child.stdin.write.bind(child.stdin);
            child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
              try {
                const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
                for (const line of text.split("\\n")) {
                  if (line.length === 0) continue;
                  const parsed = JSON.parse(line) as { op?: string };
                  if (parsed.op === "touchSession") touchOps++;
                }
              } catch {
                // ignore framing noise — only used to count real touchSession frames
              }
              return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
            }) as typeof child.stdin.write;
            return child;
          }) as typeof realSpawn,
        },
      });
      if (!res.ok) throw new Error(`createLanStore failed: ${res.reason}`);
      const store2 = res.store;
      try {
        const now = 9_000_000;
        const { sid } = await store2.createSession({
          userId: 1,
          epoch: 1,
          boundOrigin: "http://x",
          createdIp: "1.2.3.4",
          now,
        });
        const sidHash = createHash("sha256").update(sid).digest("base64url");
        touchOps = 0; // reset past createSession's own (unrelated) op before counting touchSession frames
        // 8 total riders (1 original admit + 7 dedup waiters, db-client.ts's DEFAULT_DEDUP_MAX_WAITERS)
        // all succeed sharing one IPC; the 9th distinct rider on the same key is rejected E_RATE.
        const eight = Array.from({ length: 8 }, () => store2.touchSession(sidHash, now + 1));
        const ninth = store2.touchSession(sidHash, now + 1).catch((e: unknown) => e);
        const results = await Promise.all([...eight, ninth]);
        for (let i = 0; i < 8; i++) {
          expect((results[i] as { userId: number } | undefined)?.userId).toBe(1);
        }
        expect(results[8]).toBeInstanceOf(Error);
        expect((results[8] as { code?: string }).code).toBe("E_RATE");
        expect(touchOps).toBe(1); // all 9 riders folded into a single physical IPC round trip
      } finally {
        await store2.close();
        dir.cleanup();
      }
    });

    it("touchSessionReserved shares the same dedup key as touchSession for the same sidHash", async () => {
      const { createHash } = await import("node:crypto");
      const dir = tmp();
      const res = await createLanStore({ dbFile: dir.dbFile, log: memLog(), test: true });
      if (!res.ok) throw new Error(`createLanStore failed: ${res.reason}`);
      const dedupStore = res.store;
      try {
        const now = 9_500_000;
        const { sid } = await dedupStore.createSession({
          userId: 1,
          epoch: 1,
          boundOrigin: "http://x",
          createdIp: "1.2.3.4",
          now,
        });
        const sidHash = createHash("sha256").update(sid).digest("base64url");
        const [a, b] = await Promise.all([
          dedupStore.touchSession(sidHash, now + 1),
          dedupStore.touchSessionReserved(sidHash, now + 1),
        ]);
        expect(a).toEqual(b);
      } finally {
        await dedupStore.close();
        dir.cleanup();
      }
    });
  },
);

describe("createLanStore (plan §4.1 前置条件)", () => {
  it("db-too-large: fails closed before ever spawning a subprocess", async () => {
    const { writeFileSync } = await import("node:fs");
    const dir = tmp();
    writeFileSync(dir.dbFile, Buffer.alloc(65 * 1024 * 1024), { mode: 0o600 });
    const res = await createLanStore({ dbFile: dir.dbFile, log: memLog() });
    expect(res).toEqual({ ok: false, reason: "db-too-large", detail: expect.any(String) });
    dir.cleanup();
  });

  it("corrupt (non-sqlite) file with correct owner/size/mode ⇒ db-invalid", async () => {
    const { writeFileSync } = await import("node:fs");
    const dir = tmp();
    writeFileSync(dir.dbFile, "not a sqlite file at all", { mode: 0o600 });
    const res = await createLanStore({ dbFile: dir.dbFile, log: memLog() });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("db-invalid");
    dir.cleanup();
  });
});

skipIfNoSqlite("createLanStore — #66 hardening verdict (plan §4.0/§4.1)", () => {
  const NOW = 1_800_000_000_000;
  const open = async (dbFile: string, extra: Partial<Parameters<typeof createLanStore>[0]> = {}) => {
    const res = await createLanStore({ dbFile, log: memLog(), test: true, ...extra });
    if (!res.ok) throw new Error(`createLanStore failed: ${res.reason} ${res.detail ?? ""}`);
    return res;
  };
  async function seedDb(dbFile: string, fn: (db: import("node:sqlite").DatabaseSync) => void): Promise<void> {
    const { createRequire } = await import("node:module");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(dbFile);
    try {
      fn(db);
    } finally {
      db.close();
    }
  }

  it("first release (phase 1): writer off, verify target = the legacy 2^15 shape, nothing flagged", async () => {
    const t = tmp();
    const res = await open(t.dbFile, { maintHardening: { now: NOW } });
    try {
      expect(res.hardening).toEqual({
        readerSince: NOW,
        writerActive: false,
        verifyTarget: KDF_LEGACY,
        totpKey: "none",
        totpMigrated: 0,
        truncateFailed: false,
      });
    } finally {
      await res.store.close();
      t.cleanup();
    }
  });

  it("phase 2 with a 14-day-old marker: writer on ⇒ verify target = 2^17; a young marker keeps it legacy", async () => {
    const t = tmp();
    const first = await open(t.dbFile, { maintHardening: { hardeningPhase: 2, now: NOW } });
    try {
      expect(first.hardening.writerActive).toBe(false);
      expect(first.hardening.verifyTarget).toBe(KDF_LEGACY);
    } finally {
      await first.store.close();
    }
    const later = await open(t.dbFile, { maintHardening: { hardeningPhase: 2, now: NOW + WRITER_SOAK_MS } });
    try {
      expect(later.hardening.writerActive).toBe(true);
      expect(later.hardening.readerSince).toBe(NOW);
      expect(later.hardening.verifyTarget).toEqual(KDF_PHASE2);
    } finally {
      await later.store.close();
      t.cleanup();
    }
  });

  it("a stored record stronger than the write target lifts the verify target (never faster than an unknown user)", async () => {
    const t = tmp();
    const first = await open(t.dbFile, { maintHardening: { now: NOW } });
    await first.store.close();
    await seedDb(t.dbFile, (db) =>
      db
        .prepare(
          "INSERT INTO users (username,kdf,n,r,p,salt,hash,epoch,created_at,updated_at) VALUES ('strong','scrypt',131072,8,1,?,?,1,1,1)",
        )
        .run(Buffer.alloc(16), Buffer.alloc(32)),
    );
    const res = await open(t.dbFile, { maintHardening: { now: NOW } });
    try {
      expect(res.hardening.writerActive).toBe(false);
      expect(res.hardening.verifyTarget).toMatchObject({ n: 131072, r: 8, p: 1 });
    } finally {
      await res.store.close();
      t.cleanup();
    }
  });

  it("a corrupt stronger row (n out of range) never lifts the verify target", async () => {
    const t = tmp();
    const first = await open(t.dbFile);
    await first.store.close();
    await seedDb(t.dbFile, (db) =>
      db
        .prepare(
          "INSERT INTO users (username,kdf,n,r,p,salt,hash,epoch,created_at,updated_at) VALUES ('bad','scrypt',1048576,8,1,?,?,1,1,1)",
        )
        .run(Buffer.alloc(16), Buffer.alloc(32)),
    );
    const res = await open(t.dbFile);
    try {
      expect(res.hardening.verifyTarget).toEqual(KDF_LEGACY);
    } finally {
      await res.store.close();
      t.cleanup();
    }
  });
});

skipIfNoSqlite("#66 P2 real SQLite CAS / upgrade", () => {
  const NOW = 1_800_000_000_000;
  async function fixture(phase: 1 | 2 = 2) {
    const t = tmp();
    const first = await createLanStore({ dbFile: t.dbFile, log: memLog(), maintHardening: { now: NOW } });
    if (!first.ok) throw new Error(first.reason);
    await first.store.close();
    const next = await createLanStore({
      dbFile: t.dbFile,
      log: memLog(),
      now: () => NOW + WRITER_SOAK_MS,
      maintHardening: { hardeningPhase: phase, now: NOW + WRITER_SOAK_MS },
    });
    if (!next.ok) throw new Error(next.reason);
    const user = (await next.store.getUser(USERNAME))!;
    const params = newKdfParams(KDF_PHASE2);
    const input = {
      userId: user.id,
      old: user,
      next: { ...params, hash: new Uint8Array(32).fill(29) },
    };
    return { ...t, store: next.store, user, input };
  }

  it("CAS changes only KDF/updated_at; epoch/initial_* and checked/live sessions survive", async () => {
    const h = await fixture();
    try {
      const before = await h.store.createSessionChecked({
        userId: h.user.id,
        expectedEpoch: h.user.epoch,
        expectedFactorGen: 0,
        boundOrigin: "http://hub",
        createdIp: "1.2.3.4",
        now: NOW + WRITER_SOAK_MS,
        method: "password",
      });
      expect(before.ok).toBe(true);
      expect(await h.store.rehashPassword!(h.input)).toEqual({ ok: true });
      const after = (await h.store.getUser(USERNAME))!;
      expect(after).toEqual({
        ...h.user,
        n: h.input.next.n,
        r: h.input.next.r,
        p: h.input.next.p,
        salt: new Uint8Array(h.input.next.salt),
        hash: h.input.next.hash,
        updatedAt: NOW + WRITER_SOAK_MS,
      });
      if (!before.ok) throw new Error("checked insert failed");
      expect(await h.store.touchSession(hashSid(before.sid), NOW + WRITER_SOAK_MS + 1)).toMatchObject({
        epoch: h.user.epoch,
      });
      expect(
        (
          await h.store.createSessionChecked({
            userId: h.user.id,
            expectedEpoch: h.user.epoch,
            expectedFactorGen: 0,
            boundOrigin: "http://hub",
            createdIp: "1.2.3.5",
            now: NOW + WRITER_SOAK_MS,
            method: "password",
          })
        ).ok,
      ).toBe(true);
      expect(await h.store.rehashPassword!(h.input)).toEqual({ ok: false, reason: "stale" });
    } finally {
      await h.store.close();
      h.cleanup();
    }
  });

  it.each(["salt", "hash", "n", "r", "p", "deleted"])(
    "CAS rejects %s mismatch without changing the row",
    async (field) => {
      const h = await fixture();
      try {
        const old = { ...h.input.old },
          input = { ...h.input, old };
        if (field === "salt" || field === "hash") old[field] = new Uint8Array(old[field].length).fill(99);
        else if (field === "deleted") input.userId = 9999;
        else old[field as "n" | "r" | "p"]++;
        expect(await h.store.rehashPassword!(input)).toEqual({ ok: false, reason: "stale" });
        expect(await h.store.getUser(USERNAME)).toEqual(h.user);
      } finally {
        await h.store.close();
        h.cleanup();
      }
    },
  );

  it("revokeAllSessions does not invalidate rehash: the pre-revoke credential snapshot still succeeds", async () => {
    const h = await fixture();
    try {
      await h.store.revokeAllSessions();
      const revoked = (await h.store.getUser(USERNAME))!;
      expect(revoked.epoch).toBe(h.user.epoch + 1);
      expect(revoked.salt).toEqual(h.user.salt);
      expect(revoked.hash).toEqual(h.user.hash);
      // No refresh of old: revocation must not discard an otherwise valid password upgrade.
      expect(await h.store.rehashPassword!(h.input)).toEqual({ ok: true });
      const upgraded = (await h.store.getUser(USERNAME))!;
      expect(upgraded.epoch).toBe(revoked.epoch);
      expect(upgraded.n).toBe(KDF_PHASE2.n);
      expect(upgraded.salt).toEqual(new Uint8Array(h.input.next.salt));
      expect(upgraded.hash).toEqual(h.input.next.hash);
    } finally {
      await h.store.close();
      h.cleanup();
    }
  });

  it("password reset wins during a held background computation: old job returns stale and cannot overwrite", async () => {
    const h = await fixture();
    let resolve!: (hash: Uint8Array) => void;
    const held = new Promise<Uint8Array>((yes) => {
      resolve = yes;
    });
    const rehash = vi.spyOn(h.store, "rehashPassword");
    const upgrade = createKdfUpgrader({
      kdf: { run: () => held },
      store: h.store,
      log: memLog(),
      now: () => NOW + WRITER_SOAK_MS,
      target: KDF_PHASE2,
    });
    try {
      upgrade.maybeRehash(h.user, h.user.initialPassword!);
      await Promise.resolve();
      const params = newKdfParams(KDF_LEGACY),
        kdf = createKdf(),
        newPw = "new-long-secret";
      const hash = await kdf.run(newPw, params);
      await h.store.setPassword({ username: USERNAME, kdf: "scrypt", ...params, hash });
      resolve(new Uint8Array(32).fill(53));
      await vi.waitFor(() => expect(rehash).toHaveBeenCalledTimes(1));
      expect(await rehash.mock.results[0]!.value).toEqual({ ok: false, reason: "stale" });
      const current = (await h.store.getUser(USERNAME))!;
      expect(current.n).toBe(KDF_LEGACY.n);
      expect(current.epoch).toBe(h.user.epoch + 1);
      expect(current.salt).not.toEqual(h.user.salt);
      expect(current.hash).not.toEqual(h.user.hash);
      expect(await kdf.run(newPw, params)).toEqual(current.hash);
      expect(await kdf.run(h.user.initialPassword!, params)).not.toEqual(current.hash);
    } finally {
      upgrade.dispose();
      await h.store.close();
      h.cleanup();
    }
  });

  it("phase 1 even with old marker blocks direct upgrades", async () => {
    const h = await fixture(1);
    try {
      expect(h.store.hardening?.writerActive).toBe(false);
      expect(await h.store.rehashPassword!(h.input)).toEqual({ ok: false, reason: "stale" });
      expect(await h.store.getUser(USERNAME)).toEqual(h.user);
    } finally {
      await h.store.close();
      h.cleanup();
    }
  });

  it("two concurrent real logins write one background upgrade; sessions survive and password reset fences old credentials", async () => {
    const h = await fixture(),
      kdf = createKdf();
    const log = memLog();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rehash = vi.spyOn(h.store, "rehashPassword");
    const upgrade = createKdfUpgrader({
      kdf: {
        run: async (password, params, opts) => {
          await held;
          return await kdf.run(password, params, opts);
        },
      },
      store: h.store,
      log,
      now: () => NOW + WRITER_SOAK_MS,
      target: KDF_PHASE2,
    });
    const core = createLanLoginCore({
      store: h.store,
      kdf,
      kdfUpgrader: upgrade,
      limiter: fakeLoginLimiter(),
      admission: fakeKdfAdmission(),
      approval: { request: async () => "unavailable", close() {} },
      security: createSecurityEventBus(log),
      authRevoke: createAuthRevokeBus(log),
      revokeSse() {},
      now: () => NOW + WRITER_SOAK_MS,
      log,
      kdfPolicy: { verifyTarget: KDF_PHASE2 },
    });
    const login = (pw: string) =>
      core.passwordLogin(
        {
          kind: "lan",
          peerIp: "1.2.3.4",
          clientIp: "1.2.3.4",
          viaTrustedProxy: false,
          scheme: "http",
          hostKey: "hub:80",
          externalOrigin: "http://hub",
        },
        { username: USERNAME, password: pw },
        "test",
        { signal: new AbortController().signal, responseOpen: () => true },
      );
    try {
      const pw = h.user.initialPassword!;
      const session = await h.store.createSession({
        userId: h.user.id,
        epoch: h.user.epoch,
        boundOrigin: "http://hub",
        createdIp: "1.2.3.4",
        now: NOW + WRITER_SOAK_MS,
      });
      const responses = await Promise.all([login(pw), login(pw)]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      await Promise.all(responses.map((response) => response.after?.()));
      expect(rehash).not.toHaveBeenCalled();
      release();
      await vi.waitFor(async () => expect((await h.store.getUser(USERNAME))!.n).toBe(131072), { timeout: 5000 });
      expect(rehash).toHaveBeenCalledTimes(1);
      expect(await rehash.mock.results[0]!.value).toEqual({ ok: true });
      expect(await h.store.listSessions(h.user.id, NOW + WRITER_SOAK_MS)).toHaveLength(3);
      const upgraded = (await h.store.getUser(USERNAME))!;
      const params = { n: upgraded.n, r: upgraded.r, p: upgraded.p, salt: upgraded.salt, keyLen: 32 };
      expect(await kdf.run(pw, params)).toEqual(upgraded.hash);
      expect(validateKdfParams(upgraded).ok).toBe(true);
      expect(await h.store.touchSession(hashSid(session.sid), NOW + WRITER_SOAK_MS + 1)).toMatchObject({
        epoch: h.user.epoch,
      });
      rehash.mockClear();
      const repeat = await login(pw);
      expect(repeat.status).toBe(200);
      await repeat.after?.();
      expect(rehash).not.toHaveBeenCalled();
      // Old upgrade result arrives after a real password reset transaction.
      const fresh = newKdfParams(KDF_LEGACY),
        newPw = "new-random-long-secret";
      const hash = await kdf.run(newPw, fresh);
      await h.store.setPassword({ username: USERNAME, kdf: "scrypt", ...fresh, hash });
      expect(await h.store.rehashPassword!({ ...h.input, old: upgraded })).toEqual({ ok: false, reason: "stale" });
      const changed = (await h.store.getUser(USERNAME))!;
      const verifyParams = { ...fresh, salt: changed.salt };
      expect(await kdf.run(newPw, verifyParams)).toEqual(changed.hash);
      expect(await kdf.run(pw, verifyParams)).not.toEqual(changed.hash);
      expect(await h.store.touchSession(hashSid(session.sid), NOW + WRITER_SOAK_MS + 1)).toBeUndefined();
    } finally {
      release();
      core.dispose();
      upgrade.dispose();
      await h.store.close();
      h.cleanup();
    }
  }, 15000);
});
