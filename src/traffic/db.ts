/**
 * SQLite 存储层（Node 22 内置 node:sqlite，零外部依赖）。
 * 多 pi 进程共享同一 DB：WAL 允许读写并发，busy_timeout 避免 SQLITE_BUSY 静默丢记录。
 */
import { SecureSessionError, isSecureSession } from "./secure.js";
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { broadcast } from "./sse.js";
import { DB_PATH, LEGACY_DB_PATH, state } from "./state.js";

// node:sqlite 不在 Node 22 的 builtinModules 列表中，vite/vitest 不会自动 externalize；
// 用 createRequire 动态加载，避免被打包器静态解析（运行时仍是原生 node:sqlite）。
const { DatabaseSync: DatabaseSyncImpl } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSync;
};

export class DbMigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DbMigrationError";
  }
}

function step<T>(label: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new DbMigrationError(`${label}失败: ${String(err)}`, { cause: err });
  }
}

export function ensureColumn(d: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  try {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  } catch (err) {
    if (/duplicate column name/i.test(String(err))) return;
    throw new DbMigrationError(`补列失败 ${table}.${column}: ${String(err)}`, { cause: err });
  }
}

export function verifySchema(d: DatabaseSync): void {
  const requestColumns = d.prepare("PRAGMA table_info(requests)").all() as Array<{ name: string }>;
  for (const column of [
    "orig_payload",
    "orig_request_headers",
    "rewrite_rule_ids",
    "rewrite_status",
    "rewrite_error",
    "payload_encoding",
    "payload_bytes",
  ]) {
    if (!requestColumns.some((c) => c.name === column)) {
      throw new DbMigrationError(`schema 缺少 requests.${column}`);
    }
  }
  const tables = d
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)")
    .all("rewrite_rules", "rewrite_settings") as Array<{ name: string }>;
  const tableNames = new Set(tables.map((row) => row.name));
  for (const table of ["rewrite_rules", "rewrite_settings"]) {
    if (!tableNames.has(table)) throw new DbMigrationError(`schema 缺少表 ${table}`);
  }
}

/**
 * 一次性迁移：dumps/ → records/（命令由 /dump 改名为 /record 时的目录改名）。
 * 只对默认路径生效，测试的临时 dbPath 不受影响。同文件系统内 rename 是原子的；
 * 任何一步失败都静默跳过 —— 迁移不成功最多是重新开一个空库，绝不能阻断扩展启动。
 */
export function migrateLegacyRecordDir(dbPath: string): void {
  if (dbPath !== DB_PATH) return;
  if (existsSync(dbPath) || !existsSync(LEGACY_DB_PATH)) return;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    // -wal / -shm 必须跟着主库一起搬，否则 SQLite 会把未 checkpoint 的写丢掉。
    for (const suffix of ["", "-wal", "-shm"]) {
      const from = `${LEGACY_DB_PATH}${suffix}`;
      if (existsSync(from)) renameSync(from, `${dbPath}${suffix}`);
    }
  } catch {}
}

/** 打开（或新建）数据库并建表/补列；openDb 本身不触碰全局 state，便于测试 */
export function openDb(dbPath: string): DatabaseSync {
  migrateLegacyRecordDir(dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db: DatabaseSync = new DatabaseSyncImpl(dbPath);
  try {
    step("PRAGMA 初始化", () => {
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA synchronous = NORMAL;");
    });
    step("建表", () => {
      // SQLite permits root to bypass chmod; reject a mode with no write bit
      // explicitly because this extension must be able to migrate and record.
      try {
        if ((statSync(dbPath).mode & 0o222) === 0) throw new Error("attempt to write a readonly database");
      } catch (err) {
        if (String(err).includes("readonly database")) throw err;
      }
      db.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY,
				started_at TEXT NOT NULL,
				last_seen TEXT NOT NULL,
				cwd TEXT,
				provider TEXT,
				model TEXT
			);
			CREATE TABLE IF NOT EXISTS requests (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				turn INTEGER NOT NULL DEFAULT 0,
				ts TEXT NOT NULL,
				provider TEXT,
				model TEXT,
				payload TEXT NOT NULL,
				request_headers TEXT,
				status INTEGER,
				response_headers TEXT,
				payload_encoding TEXT,
				payload_bytes INTEGER
			);
			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				turn INTEGER NOT NULL DEFAULT 0,
				ts TEXT NOT NULL,
				role TEXT NOT NULL,
				message TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS stream_chunks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				request_id INTEGER NOT NULL,
				session_id TEXT NOT NULL,
				seq INTEGER NOT NULL,
				ts TEXT NOT NULL,
				elapsed_ms INTEGER NOT NULL,
				data TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS rewrite_rules (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL,
				enabled INTEGER NOT NULL DEFAULT 0,
				priority INTEGER NOT NULL DEFAULT 100,
				url_pattern TEXT,
				method TEXT,
				model TEXT,
				body_jq TEXT,
				headers_jq TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS rewrite_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		`);
    });
    // These indexes do not depend on columns added by the migration below.
    step("建索引", () => {
      db.exec("CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);");
      db.exec("CREATE INDEX IF NOT EXISTS idx_stream_request ON stream_chunks(request_id, seq);");
    });
    // 旧库补列（CREATE TABLE IF NOT EXISTS 不会补列）
    step("补列", () => {
      ensureColumn(db, "requests", "request_headers", "request_headers TEXT");
      ensureColumn(db, "requests", "url", "url TEXT");
      ensureColumn(db, "requests", "method", "method TEXT");
      ensureColumn(db, "requests", "origin", "origin TEXT");
      ensureColumn(db, "requests", "replay_of", "replay_of INTEGER");
      ensureColumn(db, "requests", "orig_payload", "orig_payload TEXT");
      ensureColumn(db, "requests", "orig_request_headers", "orig_request_headers TEXT");
      ensureColumn(db, "requests", "rewrite_rule_ids", "rewrite_rule_ids TEXT");
      ensureColumn(db, "requests", "rewrite_status", "rewrite_status TEXT");
      ensureColumn(db, "requests", "rewrite_error", "rewrite_error TEXT");
      ensureColumn(db, "requests", "payload_encoding", "payload_encoding TEXT");
      ensureColumn(db, "requests", "payload_bytes", "payload_bytes INTEGER");
    });
    step("schema 校验", () => verifySchema(db));
    // Dependent indexes are created after schema validation so malformed views
    // report the migration step that actually detected the bad object.
    step("建索引", () => {
      db.exec("CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id, id);");
      db.exec("CREATE INDEX IF NOT EXISTS idx_rewrite_rules_enabled ON rewrite_rules(enabled, priority, id);");
    });
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {}
    throw err;
  }
}

export function ensureDb(): DatabaseSync {
  // 纵深防御：加密会话下任何调用方都不得打开/复用 traffic.db（每次现场判定）。
  if (isSecureSession()) throw new SecureSessionError();
  if (state.db) return state.db;
  try {
    state.db = openDb(state.dbPath);
    state.dbError = null;
    return state.db;
  } catch (err) {
    state.dbError = String(err);
    state.db = null;
    if (!state.dbErrorNotified) {
      state.dbErrorNotified = true;
      broadcast({ type: "record_warn", message: `数据库错误，改写持久化已禁用: ${state.dbError}` });
    }
    throw err;
  }
}

export function upsertSession(ctx: ExtensionContext): string {
  const d = ensureDb();
  const sid = ctx.sessionManager.getSessionId();
  const now = new Date().toISOString();
  d.prepare(
    `INSERT INTO sessions (id, started_at, last_seen, cwd, provider, model)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   last_seen = excluded.last_seen,
		   provider = COALESCE(excluded.provider, sessions.provider),
		   model = COALESCE(excluded.model, sessions.model)`,
  ).run(sid, now, now, ctx.cwd, ctx.model?.provider ?? null, ctx.model?.id ?? null);
  return sid;
}
