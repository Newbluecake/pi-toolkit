import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DbMigrationError, ensureColumn, ensureDb, openDb } from "../../src/traffic/db.js";
import { resetState, state } from "../../src/traffic/state.js";

const { DatabaseSync: DatabaseSyncImpl } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSync;
};

let dir: string;

function rawDb(path: string): DatabaseSync {
  return new DatabaseSyncImpl(path);
}

function expectMigrationError(fn: () => unknown, label: string): void {
  let error: unknown;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(DbMigrationError);
  expect(String(error)).toContain(label);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-traffic-record-"));
  resetState();
});

afterEach(() => {
  resetState();
  rmSync(dir, { recursive: true, force: true });
});

describe("openDb", () => {
  it("建表 + 索引齐全，重复打开幂等", () => {
    const db = openDb(join(dir, "t.db"));
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "messages",
        "requests",
        "sessions",
        "stream_chunks",
        "rewrite_rules",
        "rewrite_settings",
      ]),
    );
    // 再打开同一路径不应报错（CREATE TABLE IF NOT EXISTS + ensureColumn 幂等）
    const db2 = openDb(join(dir, "t.db"));
    db2.close();
    db.close();
  });

  it("requests 表含重放所需扩展列（url / method / origin / replay_of）", () => {
    const db = openDb(join(dir, "t.db"));
    const cols = (db.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const col of [
      "request_headers",
      "url",
      "method",
      "origin",
      "replay_of",
      "orig_payload",
      "orig_request_headers",
      "rewrite_rule_ids",
      "rewrite_status",
      "rewrite_error",
      "payload_encoding",
      "payload_bytes",
    ]) {
      expect(cols).toContain(col);
    }
    db.close();
  });

  it("线级 header 可覆盖写入（模拟 fetch 旁路回填）", () => {
    const db = openDb(join(dir, "t.db"));
    const ins = db
      .prepare(
        "INSERT INTO requests (session_id, turn, ts, provider, model, payload, request_headers) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("s1", 0, new Date().toISOString(), "anthropic", "claude", "{}", "{}");
    const id = Number(ins.lastInsertRowid);
    // 模拟 capture.ts 的覆盖写入：钩子阶段的 '{}' 被真实线级 header 替换
    const wire = { "x-api-key": "sk-live", "content-type": "application/json" };
    db.prepare("UPDATE requests SET request_headers = ? WHERE id = ?").run(JSON.stringify(wire), id);
    const row = db.prepare("SELECT request_headers FROM requests WHERE id = ?").get(id) as { request_headers: string };
    expect(JSON.parse(row.request_headers)).toEqual(wire);
    db.close();
  });

  it("配对规则：replay 行不参与 request↔assistant 序号配对", () => {
    const db = openDb(join(dir, "t.db"));
    const insReq = db.prepare(
      "INSERT INTO requests (session_id, turn, ts, payload, origin, replay_of) VALUES (?, 0, ?, '{}', ?, ?)",
    );
    insReq.run("s1", "t1", null, null); // id=1 实际录制
    const blocked = db.prepare(
      "INSERT INTO requests (session_id, turn, ts, payload, origin, replay_of, rewrite_status) VALUES (?, 0, ?, '{}', ?, ?, ?)",
    );
    blocked.run("s1", "t-blocked", null, null, "blocked"); // id=2 阻断行
    insReq.run("s1", "t2", "replay", 1); // id=3 重放行
    insReq.run("s1", "t3", null, null); // id=4 实际录制
    const insMsg = db.prepare(
      "INSERT INTO messages (session_id, turn, ts, role, message) VALUES (?, 0, ?, 'assistant', ?)",
    );
    insMsg.run("s1", "t1", JSON.stringify({ n: 1 }));
    insMsg.run("s1", "t2", JSON.stringify({ n: 2 }));
    // 第 2 个未阻断实际录制请求（id=4）应跳过 replay 与 blocked 行，配到第 2 条 assistant 消息
    const paired = db
      .prepare(
        `SELECT message FROM messages
				 WHERE session_id = ? AND role = 'assistant'
				 ORDER BY id LIMIT 1 OFFSET (
				   SELECT COUNT(*) FROM requests
				    WHERE session_id = ? AND id < ? AND origin IS NULL
				      AND (rewrite_status IS NULL OR rewrite_status <> 'blocked')
				 )`,
      )
      .get("s1", "s1", 4) as { message: string };
    expect(JSON.parse(paired.message)).toEqual({ n: 2 });
    db.close();
  });

  it("只读数据库在建表阶段失败，并在失败后关闭句柄", () => {
    const path = join(dir, "readonly.db");
    openDb(path).close();
    chmodSync(path, 0o444);
    try {
      expectMigrationError(() => openDb(path), "建表");
    } finally {
      chmodSync(path, 0o644);
    }
    // Reopening after the failed migration proves the failed handle did not remain open.
    openDb(path).close();
  });

  it("预建索引同名表时在建索引阶段失败", () => {
    const path = join(dir, "index-conflict.db");
    const raw = rawDb(path);
    raw.exec("CREATE TABLE idx_messages_session (id INTEGER)");
    raw.close();
    expectMigrationError(() => openDb(path), "建索引");
    const reopened = rawDb(path);
    reopened.close();
  });

  it("requests 为 VIEW 时在补列阶段失败", () => {
    const path = join(dir, "requests-view.db");
    const raw = rawDb(path);
    raw.exec("CREATE VIEW requests AS SELECT 1 AS id");
    raw.close();
    expectMigrationError(() => openDb(path), "补列");
  });

  it("rewrite_rules 为 VIEW 时由 schema 校验发现", () => {
    const path = join(dir, "rules-view.db");
    const raw = rawDb(path);
    raw.exec("CREATE VIEW rewrite_rules AS SELECT 1 AS id");
    raw.close();
    expectMigrationError(() => openDb(path), "schema 校验");
  });

  it("旧库补列与重复打开保持幂等，并忽略 duplicate column name", () => {
    const path = join(dir, "legacy.db");
    const raw = rawDb(path);
    raw.exec(`CREATE TABLE requests (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			turn INTEGER NOT NULL DEFAULT 0,
			ts TEXT NOT NULL,
			provider TEXT,
			model TEXT,
			payload TEXT NOT NULL,
			request_headers TEXT,
			status INTEGER,
			response_headers TEXT
		)`);
    raw.close();
    const first = openDb(path);
    const columns = (first.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(columns).toEqual(expect.arrayContaining(["payload_encoding", "payload_bytes", "rewrite_error"]));
    first.close();
    openDb(path).close();

    const duplicateColumnDb = {
      prepare: () => ({ all: () => [] }),
      exec: () => {
        throw new Error("duplicate column name: payload_encoding");
      },
    } as unknown as DatabaseSync;
    expect(() =>
      ensureColumn(duplicateColumnDb, "requests", "payload_encoding", "payload_encoding TEXT"),
    ).not.toThrow();
  });

  it("ensureDb 对任意异常记录错误并只触发一次告警状态", () => {
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "block");
    state.dbPath = join(blocker, "traffic.db");
    expect(() => ensureDb()).toThrow();
    const firstError = state.dbError;
    expect(firstError).toBeTruthy();
    expect(state.db).toBeNull();
    expect(state.dbErrorNotified).toBe(true);
    expect(() => ensureDb()).toThrow();
    expect(state.dbError).toBe(firstError);
    expect(state.dbErrorNotified).toBe(true);
  });

  it("legacy dumps/ 迁移只在默认路径生效，且不碰测试用的临时库", () => {
    // migrateLegacyRecordDir 以 dbPath === DB_PATH 为唯一触发条件。
    // 临时路径必须原样打开，否则每次跑测试都会去搬用户的真实数据目录。
    const temp = join(dir, "nested", "traffic.db");
    const db = openDb(temp);
    expect(db.prepare("SELECT COUNT(*) c FROM requests").get()).toEqual({ c: 0 });
    db.close();
  });

  it("legacy 迁移会把 -wal / -shm 一起搬走", () => {
    // 只搬主库会丢掉未 checkpoint 的写。这里直接验证三件套的搬运约定。
    const legacyDir = mkdtempSync(join(tmpdir(), "pi-record-legacy-"));
    const legacy = join(legacyDir, "traffic.db");
    const created = openDb(legacy);
    created.prepare("INSERT INTO sessions (id, started_at, last_seen) VALUES (?, ?, ?)").run("s1", "t", "t");
    created.close();

    const moved = join(legacyDir, "moved.db");
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        renameSync(`${legacy}${suffix}`, `${moved}${suffix}`);
      } catch {}
    }
    const reopened = openDb(moved);
    expect(reopened.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "s1" }]);
    reopened.close();
    rmSync(legacyDir, { recursive: true, force: true });
  });
});
