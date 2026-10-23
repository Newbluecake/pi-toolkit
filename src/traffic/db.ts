/**
 * SQLite 存储层（Node 22 内置 node:sqlite，零外部依赖）。
 * 多 pi 进程共享同一 DB：WAL 允许读写并发。
 *
 * T2a（traffic-merge plan §3.1/§3.3）：
 * - `node:sqlite` 惰性加载：模块顶层不 require，首次显式 DB 访问（`/record on` / `/record status`）
 *   才经 `loadSqlite()` 加载（ExperimentalWarning 只在那一刻出现一次）；不可用时抛
 *   `SqliteUnavailableError`，只让本命令失败。
 * - 路径固定 `homedir()/.pi/agent/records/traffic.db`（调用时计算，不随 PI_CODING_AGENT_DIR）。
 * - 旧 `dumps/` 目录不再自动搬迁：打开前检测，未迁移 / 半迁移状态拒绝打开并给人工步骤。
 * - 无模块级可变状态：连接句柄归 engine（见 engine.ts 的 ensureDb）。
 */
import { SecureSessionError, isSecure } from "./secure.js";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { broadcast } from "./sse.js";
import type { TrafficEngine } from "./engine.js";

export interface SqliteModule {
  DatabaseSync: typeof DatabaseSync;
}

export type SqliteLoader = () => SqliteModule;

export class SqliteUnavailableError extends Error {
  readonly code = "E_SQLITE_UNAVAILABLE" as const;
  constructor(cause: unknown) {
    super(`traffic 录制需要 Node ≥22.13（当前 ${process.version}），node:sqlite 不可用`, { cause });
    this.name = "SqliteUnavailableError";
  }
}

/**
 * 惰性加载 node:sqlite。node:sqlite 不在 Node 22 的 builtinModules 列表中，vite/vitest 不会自动
 * externalize；用 createRequire 动态加载，避免被打包器静态解析（运行时仍是原生 node:sqlite）。
 * 重复调用由 Node 自身的 require 缓存去重，本模块不持有状态。
 */
export function loadSqlite(): SqliteModule {
  try {
    const mod = createRequire(import.meta.url)("node:sqlite") as Partial<SqliteModule>;
    if (typeof mod.DatabaseSync !== "function") throw new Error("DatabaseSync missing");
    return mod as SqliteModule;
  } catch (err) {
    throw new SqliteUnavailableError(err);
  }
}

/** 固定路径（§3.3）：与源实现同算法，调用时计算，不随 PI_CODING_AGENT_DIR。 */
export function defaultRecordPaths(home: string = homedir()): {
  recordDir: string;
  dbPath: string;
  legacyDir: string;
  legacyDbPath: string;
} {
  const agent = join(home, ".pi", "agent");
  return {
    recordDir: join(agent, "records"),
    dbPath: join(agent, "records", "traffic.db"),
    legacyDir: join(agent, "dumps"),
    legacyDbPath: join(agent, "dumps", "traffic.db"),
  };
}

export type LegacyLayoutState = "unmigrated" | "half-migrated";

export class LegacyLayoutError extends Error {
  readonly code: "E_LEGACY_UNMIGRATED" | "E_LEGACY_HALF_MIGRATED";
  constructor(
    readonly layout: LegacyLayoutState,
    message: string,
  ) {
    super(message);
    this.name = "LegacyLayoutError";
    this.code = layout === "unmigrated" ? "E_LEGACY_UNMIGRATED" : "E_LEGACY_HALF_MIGRATED";
  }
}

function nonEmptyFile(path: string): boolean {
  try {
    return statSync(path).size > 0;
  } catch {
    return false;
  }
}

/**
 * 旧目录检测（§3.3，取代自动 rename）。只读 stat，不创建任何文件：
 * - records 库不存在而 dumps 库（或非空 -wal）存在 ⇒ 未迁移：拒绝，给人工步骤，不建空库；
 * - records 库存在且 dumps 下仍有 traffic.db 或非空 -wal ⇒ 半迁移：拒绝，提示人工合并；
 * - 两者皆无 / 只有 records ⇒ 返回 null（正常打开或新建）。
 */
export function detectLegacyLayout(dbPath: string, legacyDbPath: string): LegacyLayoutError | null {
  const current = existsSync(dbPath);
  const legacyDb = existsSync(legacyDbPath);
  const legacyWal = nonEmptyFile(`${legacyDbPath}-wal`);
  if (!legacyDb && !legacyWal) return null;
  if (!current) {
    if (!legacyDb) {
      return new LegacyLayoutError(
        "half-migrated",
        [
          `检测到旧目录残留的非空 WAL（${legacyDbPath}-wal）而主库缺失：数据状态不完整，traffic 拒绝打开。`,
          "请人工检查旧目录，确认无需保留后删除该 WAL，或从备份恢复主库后按迁移步骤处理。",
        ].join("\n"),
      );
    }
    return new LegacyLayoutError(
      "unmigrated",
      [
        `检测到旧版数据目录 ${dirname(legacyDbPath)}（records/ 下尚无库），traffic 不再自动搬迁，已拒绝打开。`,
        "人工迁移步骤：",
        "  1. 关闭所有 pi 进程（含仍在运行旧版 pi-traffic-record 的进程）；",
        `  2. sqlite3 "${legacyDbPath}" "PRAGMA wal_checkpoint(TRUNCATE)"；`,
        `  3. 确认 "${legacyDbPath}-wal" 不存在或为空；`,
        `  4. mkdir -p "${dirname(dbPath)}" && mv "${legacyDbPath}" "${dbPath}"（-shm 可删除）；`,
        "  5. 重新执行 /record on。",
      ].join("\n"),
    );
  }
  return new LegacyLayoutError(
    "half-migrated",
    [
      `检测到半迁移状态：${dbPath} 已存在，但旧目录 ${dirname(legacyDbPath)} 下仍有 ${legacyDb ? "traffic.db" : "非空 traffic.db-wal"}。`,
      "traffic 拒绝打开（不会静默打开可能缺 WAL 的库）。请关闭所有 pi 后人工合并或删除其中一份，再执行 /record on。",
    ].join("\n"),
  );
}

export interface OpenDbOptions {
  loadSqlite?: SqliteLoader;
  /** 旧库路径（null = 不检测）。缺省：dbPath 等于默认路径时检测默认 dumps/，否则不检测。 */
  legacyDbPath?: string | null;
}

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

/** 打开（或新建）数据库并建表/补列；openDb 本身不触碰全局 state，便于测试 */
export function openDb(dbPath: string, opts: OpenDbOptions = {}): DatabaseSync {
  const defaults = defaultRecordPaths();
  const legacy =
    opts.legacyDbPath === undefined ? (dbPath === defaults.dbPath ? defaults.legacyDbPath : null) : opts.legacyDbPath;
  if (legacy !== null) {
    const refusal = detectLegacyLayout(dbPath, legacy);
    if (refusal) throw refusal;
  }
  const { DatabaseSync: DatabaseSyncImpl } = (opts.loadSqlite ?? loadSqlite)();
  mkdirSync(dirname(dbPath), { recursive: true });
  const db: DatabaseSync = new DatabaseSyncImpl(dbPath);
  try {
    step("PRAGMA 初始化", () => {
      db.exec("PRAGMA journal_mode = WAL;");
      // §3.2（r3 R1-9）：主线程绝不等锁——遇锁立即 SQLITE_BUSY，写后账本退避让出。
      db.exec("PRAGMA busy_timeout = 0;");
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

/**
 * 取 engine 的连接（必要时打开）。纵深防御：加密会话下任何调用方都不得打开/复用 traffic.db
 * （每次现场判定）；非 open 的 engine 不再打开库（关闭后的陈旧续体不能重开旧库）。
 */
export function ensureDb(engine: TrafficEngine): DatabaseSync {
  if (isSecure()) throw new SecureSessionError();
  if (engine.state !== "open") throw new Error("traffic engine 已关闭");
  if (engine.db) return engine.db;
  try {
    engine.db = openDb(engine.dbPath, { loadSqlite: engine.loadSqlite, legacyDbPath: engine.legacyDbPath });
    engine.dbError = null;
    return engine.db;
  } catch (err) {
    engine.dbError = String(err);
    engine.db = null;
    if (!engine.dbErrorNotified) {
      engine.dbErrorNotified = true;
      broadcast(engine, { type: "record_warn", message: `数据库错误，改写持久化已禁用: ${engine.dbError}` });
    }
    throw err;
  }
}

/** 写 sessions 行；调用方须已经过 persist 闸口（见 persist.ts）。 */
export const UPSERT_SESSION_SQL = `INSERT INTO sessions (id, started_at, last_seen, cwd, provider, model)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   last_seen = excluded.last_seen,
		   provider = COALESCE(excluded.provider, sessions.provider),
		   model = COALESCE(excluded.model, sessions.model)`;

/** upsertSession 的参数（在钩子时刻取值，交给写后账本执行）。 */
export function sessionUpsertParams(
  ctx: ExtensionContext,
): [string, string, string, string, string | null, string | null] {
  const sid = ctx.sessionManager.getSessionId();
  const now = new Date().toISOString();
  return [sid, now, now, ctx.cwd, ctx.model?.provider ?? null, ctx.model?.id ?? null];
}

export function upsertSession(d: DatabaseSync, ctx: ExtensionContext): string {
  const params = sessionUpsertParams(ctx);
  d.prepare(UPSERT_SESSION_SQL).run(...params);
  return params[0];
}
