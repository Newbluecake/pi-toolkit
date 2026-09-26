/**
 * plan §4.2/§4.3: the built script text itself — test-hook compilation gating
 * (`PI_WEBHUB_DB_TEST`), and running the scripts directly (bypassing
 * `db-client.ts`) to exercise `__block` / `__crashAfterCommit` and the
 * maintenance op's migration/bootstrap/idempotence behavior.
 */
import { describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildMaintScript, buildQueryScript, dbTestModeEnabled } from "../../../src/web-hub/hub/db-child.js";
import { hasNodeSqlite } from "../../../src/web-hub/hub/db.js";

const execFileP = promisify(execFile);
const skipIfNoSqlite = (await hasNodeSqlite()) ? describe : describe.skip;

function tmp(): { dir: string; dbFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "wh-dbchild-"));
  return { dir, dbFile: join(dir, "hub.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("dbTestModeEnabled", () => {
  it("reads PI_WEBHUB_DB_TEST=1 exactly", () => {
    expect(dbTestModeEnabled({ PI_WEBHUB_DB_TEST: "1" })).toBe(true);
    expect(dbTestModeEnabled({ PI_WEBHUB_DB_TEST: "true" })).toBe(false);
    expect(dbTestModeEnabled({})).toBe(false);
  });
});

describe('buildQueryScript test-hook gating (plan §4.3 "只在 PI_WEBHUB_DB_TEST=1 时编译进脚本")', () => {
  it("production build (test:false) never contains the test hooks' source text", () => {
    const script = buildQueryScript({ test: false });
    expect(script).not.toContain("__block");
    expect(script).not.toContain("__crashAfterCommit");
    expect(script).not.toContain("Atomics.wait");
  });

  it("test build (test:true) splices in both hooks", () => {
    const script = buildQueryScript({ test: true });
    expect(script).toContain("__block");
    expect(script).toContain("__crashAfterCommit");
    expect(script).toContain("Atomics.wait");
  });

  it("honors process.env.PI_WEBHUB_DB_TEST when opts.test is omitted", () => {
    const prev = process.env["PI_WEBHUB_DB_TEST"];
    try {
      process.env["PI_WEBHUB_DB_TEST"] = "1";
      expect(buildQueryScript()).toContain("__block");
      delete process.env["PI_WEBHUB_DB_TEST"];
      expect(buildQueryScript()).not.toContain("__block");
    } finally {
      if (prev === undefined) delete process.env["PI_WEBHUB_DB_TEST"];
      else process.env["PI_WEBHUB_DB_TEST"] = prev;
    }
  });
});

skipIfNoSqlite("query script run directly (bypassing db-client.ts)", () => {
  function spawnQuery(dbFile: string, test = true) {
    const script = buildQueryScript({ test });
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", script], {
      env: { ...process.env, PI_WEBHUB_DB_PATH: dbFile },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    const lines: Array<{ id: number; ok: boolean; result?: unknown; code?: string; detail?: string }> = [];
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.length > 0) lines.push(JSON.parse(line));
      }
    });
    return {
      child,
      lines,
      send(id: number, op: string, args: Record<string, unknown>) {
        child.stdin.write(JSON.stringify({ id, op, args }) + "\n");
      },
      waitFor(
        id: number,
        timeoutMs = 5000,
      ): Promise<{ id: number; ok: boolean; result?: unknown; code?: string; detail?: string }> {
        const deadline = Date.now() + timeoutMs;
        return new Promise((resolve, reject) => {
          const tick = () => {
            const found = lines.find((l) => l.id === id);
            if (found !== undefined) {
              resolve(found);
              return;
            }
            if (Date.now() > deadline) {
              reject(new Error(`timed out waiting for id=${id}`));
              return;
            }
            setTimeout(tick, 10);
          };
          tick();
        });
      },
    };
  }

  async function migrate(dbFile: string): Promise<void> {
    const script = buildMaintScript();
    const { stdout } = await execFileP(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", script], {
      env: {
        ...process.env,
        PI_WEBHUB_DB_PATH: dbFile,
        PI_WEBHUB_DB_OP: "open-check-migrate",
        PI_WEBHUB_DB_DEADLINE_MS: "5000",
      },
      timeout: 5000,
    });
    const result = JSON.parse(stdout.trim().split("\n").pop()!);
    if (!result.ok) throw new Error(`migrate failed: ${JSON.stringify(result)}`);
  }

  it("__block blocks the single thread for the requested ms (Atomics.wait), then resumes serving", async () => {
    const t = tmp();
    await migrate(t.dbFile);
    const q = spawnQuery(t.dbFile);
    try {
      const start = Date.now();
      q.send(1, "__block", { ms: 300 });
      q.send(2, "getUser", { username: "admin" });
      const r1 = await q.waitFor(1);
      const elapsed = Date.now() - start;
      expect(r1.ok).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(280); // the block really happened before any reply
      const r2 = await q.waitFor(2);
      expect(r2.ok).toBe(true);
    } finally {
      q.child.kill("SIGKILL");
      t.cleanup();
    }
  });

  it("__crashAfterCommit kills the process after a deleteSession commits (result never sent)", async () => {
    const t = tmp();
    await migrate(t.dbFile);
    const q = spawnQuery(t.dbFile);
    try {
      const exited = new Promise<void>((resolve) => q.child.once("exit", () => resolve()));
      q.send(1, "deleteSession", { sidHash: "AAAA", __crashAfterCommit: true });
      await exited;
      expect(q.lines.find((l) => l.id === 1)).toBeUndefined(); // no reply — the process died first
    } finally {
      t.cleanup();
    }
  });

  it("without the test flag, __crashAfterCommit is an inert arg (op completes normally)", async () => {
    const t = tmp();
    await migrate(t.dbFile);
    const q = spawnQuery(t.dbFile, false);
    try {
      q.send(1, "deleteSession", { sidHash: "AAAA", __crashAfterCommit: true });
      const r = await q.waitFor(1);
      expect(r.ok).toBe(true);
      expect(q.child.killed).toBe(false);
    } finally {
      q.child.kill("SIGKILL");
      t.cleanup();
    }
  });

  it("unknown op ⇒ ok:false E_DB, connection stays alive for the next request", async () => {
    const t = tmp();
    await migrate(t.dbFile);
    const q = spawnQuery(t.dbFile);
    try {
      q.send(1, "notARealOp", {});
      const r1 = await q.waitFor(1);
      expect(r1.ok).toBe(false);
      expect(r1.code).toBe("E_DB");
      q.send(2, "getUser", { username: "admin" });
      const r2 = await q.waitFor(2);
      expect(r2.ok).toBe(true);
    } finally {
      q.child.kill("SIGKILL");
      t.cleanup();
    }
  });
});

skipIfNoSqlite("maintenance script (open-check-migrate)", () => {
  async function runMaint(
    dbFile: string,
    op: string,
    deadlineMs = 5000,
  ): Promise<{ ok: boolean; code?: string; detail?: string }> {
    const script = buildMaintScript();
    const { stdout } = await execFileP(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", script], {
      env: {
        ...process.env,
        PI_WEBHUB_DB_PATH: dbFile,
        PI_WEBHUB_DB_OP: op,
        PI_WEBHUB_DB_DEADLINE_MS: String(deadlineMs),
      },
      timeout: deadlineMs,
    });
    return JSON.parse(stdout.trim().split("\n").pop()!);
  }

  it("fresh db: creates schema v1 and seeds exactly one admin user with a plaintext initial password", async () => {
    const t = tmp();
    try {
      const res = await runMaint(t.dbFile, "open-check-migrate");
      expect(res.ok).toBe(true);
      const { createRequire } = await import("node:module");
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(t.dbFile);
      try {
        const users = db.prepare("SELECT username, initial_password FROM users").all() as Array<{
          username: string;
          initial_password: string | null;
        }>;
        expect(users).toHaveLength(1);
        expect(users[0]!.username).toBe("admin");
        expect(typeof users[0]!.initial_password).toBe("string");
        expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      } finally {
        db.close();
      }
    } finally {
      t.cleanup();
    }
  });

  it("re-running open-check-migrate on an already-migrated db is a no-op (idempotent, no second user)", async () => {
    const t = tmp();
    try {
      await runMaint(t.dbFile, "open-check-migrate");
      const res2 = await runMaint(t.dbFile, "open-check-migrate");
      expect(res2.ok).toBe(true);
      const { createRequire } = await import("node:module");
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(t.dbFile);
      try {
        const count = db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
        expect(count.c).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      t.cleanup();
    }
  });

  it("user_version > 1 ⇒ db-invalid", async () => {
    const t = tmp();
    try {
      await runMaint(t.dbFile, "open-check-migrate");
      const { createRequire } = await import("node:module");
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(t.dbFile);
      db.exec("PRAGMA user_version=2");
      db.close();
      const res = await runMaint(t.dbFile, "open-check-migrate");
      expect(res.ok).toBe(false);
      expect(res.code).toBe("db-invalid");
    } finally {
      t.cleanup();
    }
  });

  it("user_version=1 but a table is missing ⇒ db-invalid (structural check)", async () => {
    const t = tmp();
    try {
      await runMaint(t.dbFile, "open-check-migrate");
      const { createRequire } = await import("node:module");
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(t.dbFile);
      db.exec("DROP TABLE sessions");
      db.close();
      const res = await runMaint(t.dbFile, "open-check-migrate");
      expect(res.ok).toBe(false);
      expect(res.code).toBe("db-invalid");
    } finally {
      t.cleanup();
    }
  });

  // Review fix (§4.1/§4.3 "损坏"): the object-name check above passes for a table/index that
  // still exists under the right name but whose *shape* was silently damaged — a dropped
  // column, a widened NOT NULL, an index rebuilt on the wrong column, or a missing FK. These
  // cases previously sailed through as a "valid" db.
  it("a column is dropped from an existing table (name still present) ⇒ db-invalid", async () => {
    const t = tmp();
    try {
      await runMaint(t.dbFile, "open-check-migrate");
      const { createRequire } = await import("node:module");
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(t.dbFile);
      db.exec("ALTER TABLE sessions DROP COLUMN bound_origin");
      db.close();
      const res = await runMaint(t.dbFile, "open-check-migrate");
      expect(res.ok).toBe(false);
      expect(res.code).toBe("db-invalid");
      expect(res.detail).toContain("sessions.bound_origin");
    } finally {
      t.cleanup();
    }
  });

  it("a NOT NULL constraint is widened away on rebuild (column still present) ⇒ db-invalid", async () => {
    const t = tmp();
    try {
      await runMaint(t.dbFile, "open-check-migrate");
      const { createRequire } = await import("node:module");
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(t.dbFile);
      db.exec(`
        PRAGMA foreign_keys=OFF;
        ALTER TABLE sessions RENAME TO sessions_old;
        CREATE TABLE sessions (
          sid_hash BLOB PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          epoch INTEGER NOT NULL, bound_origin TEXT,
          created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL, created_ip TEXT NOT NULL) STRICT;
        INSERT INTO sessions SELECT * FROM sessions_old;
        DROP TABLE sessions_old;
        CREATE INDEX sessions_expiry ON sessions(expires_at);
      `);
      db.close();
      const res = await runMaint(t.dbFile, "open-check-migrate");
      expect(res.ok).toBe(false);
      expect(res.code).toBe("db-invalid");
      expect(res.detail).toContain("sessions.bound_origin");
    } finally {
      t.cleanup();
    }
  });

  it("sessions_expiry index rebuilt on the wrong column (index still exists by name) ⇒ db-invalid", async () => {
    const t = tmp();
    try {
      await runMaint(t.dbFile, "open-check-migrate");
      const { createRequire } = await import("node:module");
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(t.dbFile);
      db.exec("DROP INDEX sessions_expiry");
      db.exec("CREATE INDEX sessions_expiry ON sessions(created_at)");
      db.close();
      const res = await runMaint(t.dbFile, "open-check-migrate");
      expect(res.ok).toBe(false);
      expect(res.code).toBe("db-invalid");
      expect(res.detail).toContain("sessions_expiry");
    } finally {
      t.cleanup();
    }
  });

  it("the sessions→users foreign key is dropped on rebuild (columns otherwise intact) ⇒ db-invalid", async () => {
    const t = tmp();
    try {
      await runMaint(t.dbFile, "open-check-migrate");
      const { createRequire } = await import("node:module");
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(t.dbFile);
      db.exec(`
        PRAGMA foreign_keys=OFF;
        ALTER TABLE sessions RENAME TO sessions_old;
        CREATE TABLE sessions (
          sid_hash BLOB PRIMARY KEY, user_id INTEGER NOT NULL,
          epoch INTEGER NOT NULL, bound_origin TEXT NOT NULL,
          created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL, created_ip TEXT NOT NULL) STRICT;
        INSERT INTO sessions SELECT * FROM sessions_old;
        DROP TABLE sessions_old;
        CREATE INDEX sessions_expiry ON sessions(expires_at);
      `);
      db.close();
      const res = await runMaint(t.dbFile, "open-check-migrate");
      expect(res.ok).toBe(false);
      expect(res.code).toBe("db-invalid");
      expect(res.detail).toContain("sessions.user_id");
    } finally {
      t.cleanup();
    }
  });

  it("checkpoint-passive / checkpoint-truncate on an existing db succeed", async () => {
    const t = tmp();
    try {
      await runMaint(t.dbFile, "open-check-migrate");
      expect((await runMaint(t.dbFile, "checkpoint-passive")).ok).toBe(true);
      expect((await runMaint(t.dbFile, "checkpoint-truncate")).ok).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  it("garbage (non-sqlite) file ⇒ db-invalid", async () => {
    const t = tmp();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(t.dbFile, "not a database", { mode: 0o600 });
    try {
      const res = await runMaint(t.dbFile, "open-check-migrate");
      expect(res.ok).toBe(false);
      expect(res.code).toBe("db-invalid");
    } finally {
      t.cleanup();
    }
  });
});
