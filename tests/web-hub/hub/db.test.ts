/**
 * plan §4.1: schema/PRAGMA constants + the main-thread `fs.promises`-only file
 * check (size ceilings, mode repair, owner mismatch). No subprocess spawning
 * here — that's `db-client.test.ts` / `lan-store.test.ts`'s job.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDbFiles,
  DB_MAX_BYTES,
  hasNodeSqlite,
  maintBusyTimeoutMs,
  QUERY_PRAGMAS,
  SCHEMA_SQL_V1,
  SCHEMA_V1_OBJECTS,
  WAL_MAX_BYTES,
} from "../../../src/web-hub/hub/db.js";
import { memLog } from "./helpers.js";

const skipIfNoSqlite = (await hasNodeSqlite()) ? it : it.skip;

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "wh-db-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("db.ts constants (plan §4.1)", () => {
  it("QUERY_PRAGMAS matches the frozen list", () => {
    expect(QUERY_PRAGMAS).toEqual([
      "PRAGMA journal_mode=WAL",
      "PRAGMA synchronous=NORMAL",
      "PRAGMA foreign_keys=ON",
      "PRAGMA secure_delete=ON",
      "PRAGMA wal_autocheckpoint=0",
      "PRAGMA busy_timeout=200",
    ]);
  });

  it("maintBusyTimeoutMs is deadline - 500ms, floored at 0", () => {
    expect(maintBusyTimeoutMs(5000)).toBe(4500);
    expect(maintBusyTimeoutMs(200)).toBe(0);
    expect(maintBusyTimeoutMs(0)).toBe(0);
  });

  skipIfNoSqlite("SCHEMA_SQL_V1 creates exactly the expected tables/index and enforces the kdf CHECK", () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(SCHEMA_SQL_V1);
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
      expect(new Set(rows.map((r) => r.name))).toEqual(new Set(SCHEMA_V1_OBJECTS));
      expect(() =>
        db
          .prepare(
            "INSERT INTO users (username, kdf, n, r, p, salt, hash, created_at, updated_at) VALUES ('a','notscrypt',1,1,1,x'00',x'00',1,1)",
          )
          .run(),
      ).toThrow();
      db.prepare(
        "INSERT INTO users (username, kdf, n, r, p, salt, hash, created_at, updated_at) VALUES ('a','scrypt',1,1,1,x'00',x'00',1,1)",
      ).run();
      // FK cascade delete
      db.prepare(
        "INSERT INTO sessions (sid_hash, user_id, epoch, bound_origin, created_at, last_seen_at, expires_at, absolute_expires_at, created_ip) VALUES (x'01',1,1,'http://x',1,1,2,3,'1.2.3.4')",
      ).run();
      db.prepare("DELETE FROM users WHERE id=1").run();
      const left = db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number };
      expect(left.c).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('checkDbFiles (plan §4.1 "打开前")', () => {
  it("missing db/-wal/-shm is fine (not created yet)", async () => {
    const { dir, cleanup } = tmp();
    try {
      const res = await checkDbFiles(join(dir, "hub.db"), { log: memLog() });
      expect(res).toEqual({ ok: true });
    } finally {
      cleanup();
    }
  });

  it("oversized db file ⇒ db-too-large, fail-closed", async () => {
    const fakeLstat = vi.fn(async (p: string) => {
      if (p.endsWith("hub.db"))
        return { isFile: () => true, uid: process.getuid?.() ?? 0, size: DB_MAX_BYTES + 1, mode: 0o600 } as never;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const res = await checkDbFiles("/x/hub.db", {
      log: memLog(),
      fs: { lstat: fakeLstat as never, getuid: () => process.getuid?.() ?? 0 },
    });
    expect(res).toEqual({ ok: false, reason: "db-too-large", detail: expect.stringContaining("hub.db") });
  });

  it("oversized -wal ⇒ db-too-large even when the db file itself is small", async () => {
    const fakeLstat = vi.fn(async (p: string) => {
      if (p.endsWith("-wal"))
        return { isFile: () => true, uid: process.getuid?.() ?? 0, size: WAL_MAX_BYTES + 1, mode: 0o600 } as never;
      if (p.endsWith("hub.db"))
        return { isFile: () => true, uid: process.getuid?.() ?? 0, size: 100, mode: 0o600 } as never;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const res = await checkDbFiles("/x/hub.db", {
      log: memLog(),
      fs: { lstat: fakeLstat as never, getuid: () => process.getuid?.() ?? 0 },
    });
    expect(res).toEqual({ ok: false, reason: "db-too-large", detail: expect.stringContaining("-wal") });
  });

  it("wrong owner ⇒ db-invalid, file left alone (no chmod attempted)", async () => {
    const chmod = vi.fn();
    const fakeLstat = vi.fn(async (p: string) => {
      if (p.endsWith("hub.db")) return { isFile: () => true, uid: 99999, size: 100, mode: 0o600 } as never;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const res = await checkDbFiles("/x/hub.db", {
      log: memLog(),
      fs: { lstat: fakeLstat as never, chmod: chmod as never, getuid: () => process.getuid?.() ?? 0 },
    });
    expect(res).toEqual({ ok: false, reason: "db-invalid", detail: expect.stringContaining("owned by uid") });
    expect(chmod).not.toHaveBeenCalled();
  });

  it("not a regular file (e.g. a directory) ⇒ db-invalid", async () => {
    const fakeLstat = vi.fn(async (p: string) => {
      if (p.endsWith("hub.db"))
        return { isFile: () => false, uid: process.getuid?.() ?? 0, size: 0, mode: 0o600 } as never;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const res = await checkDbFiles("/x/hub.db", {
      log: memLog(),
      fs: { lstat: fakeLstat as never, getuid: () => process.getuid?.() ?? 0 },
    });
    expect(res).toEqual({ ok: false, reason: "db-invalid", detail: expect.stringContaining("not a regular file") });
  });

  it("widened mode (owner correct) ⇒ repaired via chmod + warn, still ok", async () => {
    const chmod = vi.fn(async () => undefined);
    const log = memLog();
    const fakeLstat = vi.fn(async (p: string) => {
      if (p.endsWith("hub.db"))
        return { isFile: () => true, uid: process.getuid?.() ?? 0, size: 100, mode: 0o644 } as never;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const res = await checkDbFiles("/x/hub.db", {
      log,
      fs: { lstat: fakeLstat as never, chmod: chmod as never, getuid: () => process.getuid?.() ?? 0 },
    });
    expect(res).toEqual({ ok: true });
    expect(chmod).toHaveBeenCalledWith("/x/hub.db", 0o600);
    expect(log.lines.some((l) => l.level === "warn")).toBe(true);
  });

  it("chmod failure while repairing a widened mode ⇒ db-invalid (fail-closed, doesn't silently proceed)", async () => {
    const chmod = vi.fn(async () => {
      throw new Error("EPERM");
    });
    const fakeLstat = vi.fn(async (p: string) => {
      if (p.endsWith("hub.db"))
        return { isFile: () => true, uid: process.getuid?.() ?? 0, size: 100, mode: 0o644 } as never;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const res = await checkDbFiles("/x/hub.db", {
      log: memLog(),
      fs: { lstat: fakeLstat as never, chmod: chmod as never, getuid: () => process.getuid?.() ?? 0 },
    });
    expect(res).toEqual({ ok: false, reason: "db-invalid", detail: expect.stringContaining("chmod repair failed") });
  });
});
