/**
 * plan §4.3: full `LanStorePort` contract against a real resident query
 * subprocess (spawned via `db-client.ts`) and a real maintenance subprocess
 * (via `lan-store.ts`'s `createLanStore`), talking to an actual on-disk
 * SQLite file. `skipIf(!hasNodeSqlite)`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLanStore, type LanStore } from "../../../src/web-hub/hub/lan-store.js";
import { hasNodeSqlite } from "../../../src/web-hub/hub/db.js";
import { memLog } from "./helpers.js";

const skipIfNoSqlite = (await hasNodeSqlite()) ? describe : describe.skip;

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
    expect(info?.username).toBe("admin");
    expect(typeof info?.initialPassword).toBe("string");
    expect(info?.initialPassword?.length).toBeGreaterThan(0);
    expect(info?.initialLogin).toBeUndefined();

    const user = await store.getUser("admin");
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
    await store.setPassword({ username: "admin", kdf: "scrypt", n: 32768, r: 8, p: 1, salt, hash });

    expect(await store.touchSession(sidHash, now + 2)).toBeUndefined(); // session deleted
    const user = await store.getUser("admin");
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
    await store.markInitialLogin("admin", "10.0.0.5", 42);
    let info = await store.initialInfo();
    expect(info?.initialLogin).toEqual({ ip: "10.0.0.5", at: 42 });
    await store.markInitialLogin("admin", "10.0.0.9", 99);
    info = await store.initialInfo();
    expect(info?.initialLogin).toEqual({ ip: "10.0.0.5", at: 42 }); // unchanged
  });

  it("getUserSummary reports initialPasswordInUse by userId, flips false after setPassword", async () => {
    const { scryptSync, randomBytes } = await import("node:crypto");
    let summary = await store.getUserSummary(1);
    expect(summary).toEqual({ username: "admin", initialPasswordInUse: true });
    const salt = randomBytes(16);
    const hash = scryptSync("anotherpass1", salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 32768 * 8 + 1024 * 1024 });
    await store.setPassword({ username: "admin", kdf: "scrypt", n: 32768, r: 8, p: 1, salt, hash });
    summary = await store.getUserSummary(1);
    expect(summary).toEqual({ username: "admin", initialPasswordInUse: false });
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
    await expect(store.getUser("admin", { signal: ac.signal })).rejects.toBeInstanceOf(Error);
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
