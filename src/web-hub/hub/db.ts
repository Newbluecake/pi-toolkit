/**
 * SQLite file layout, schema and PRAGMA policy (plan §4.1; S1-W2 LS 包).
 *
 * Pure domain: **no `node:sqlite` import** here — that only ever loads inside
 * the child-process scripts built by `db-child.ts` (plan §4's "主线程完全不导入
 * `node:sqlite`，也不打开 `DatabaseSync`"). No subprocess spawning either (that
 * is `db-client.ts`'s job). This module owns:
 *  - the on-disk schema (v1 DDL, verbatim from §4.1)
 *  - the PRAGMA statements each subprocess kind applies
 *  - size ceilings (`db-too-large`) and the main-thread file check, which is
 *    the only thing the main thread ever does with the db files directly —
 *    `fs.promises.lstat`/`chmod`, nothing more.
 */
import { chmod, lstat } from "node:fs/promises";
import type { HubLog } from "./ports.js";

// ---------------------------------------------------------------------------
// §4.1 file / size / mode constants
// ---------------------------------------------------------------------------

export const DB_FILE_MODE = 0o600;
export const DB_MAX_BYTES = 64 * 1024 * 1024;
export const WAL_MAX_BYTES = 16 * 1024 * 1024;
export const USER_VERSION = 1;

/** `<stateDir>/hub.db` (mirrors `protocol/paths.ts`'s `HubPaths.dbFile`, kept here too so
 * `db.ts` has no dependency on that module for the two derived filenames). */
export function walPath(dbFile: string): string {
  return `${dbFile}-wal`;
}
export function shmPath(dbFile: string): string {
  return `${dbFile}-shm`;
}

// ---------------------------------------------------------------------------
// §4.1 schema (v1, verbatim)
// ---------------------------------------------------------------------------

export const SCHEMA_SQL_V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE users (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE,
  kdf TEXT NOT NULL CHECK (kdf = 'scrypt'), n INTEGER NOT NULL, r INTEGER NOT NULL, p INTEGER NOT NULL,
  salt BLOB NOT NULL, hash BLOB NOT NULL, epoch INTEGER NOT NULL DEFAULT 1,
  initial_password TEXT, initial_created_at INTEGER, initial_login_at INTEGER, initial_login_ip TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE sessions (
  sid_hash BLOB PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL, bound_origin TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL, created_ip TEXT NOT NULL) STRICT;
CREATE INDEX sessions_expiry ON sessions(expires_at);
`.trim();

/** Tables/index a valid v1 schema must have (used by the maintenance script's
 * structural check when `user_version` is already 1 — plan §4.1 "大于 1 或
 * 结构不符 ⇒ db-invalid"). */
export const SCHEMA_V1_OBJECTS = ["meta", "users", "sessions", "sessions_expiry"] as const;

// ---------------------------------------------------------------------------
// §4.1 PRAGMA policy
// ---------------------------------------------------------------------------

/** Applied once by the resident query subprocess right after opening. */
export const QUERY_PRAGMAS = [
  "PRAGMA journal_mode=WAL",
  "PRAGMA synchronous=NORMAL",
  "PRAGMA foreign_keys=ON",
  "PRAGMA secure_delete=ON",
  "PRAGMA wal_autocheckpoint=0",
  "PRAGMA busy_timeout=200",
] as const;

/** `busy_timeout = deadline − 500ms` for the maintenance subprocess (§4.2). */
export function maintBusyTimeoutMs(deadlineMs: number): number {
  return Math.max(0, deadlineMs - 500);
}

// ---------------------------------------------------------------------------
// §4.2 op catalogs (frozen shape lives in `hub/ports.ts`'s `LanStorePort`;
// these are the wire-level op names `db-child.ts`'s scripts dispatch on)
// ---------------------------------------------------------------------------

export const QUERY_OPS = [
  "getUser",
  "getUserSummary",
  "initialInfo",
  "createSession",
  "touchSession",
  "deleteSession",
  "deleteAllSessions",
  "setPassword",
  "markInitialLogin",
  "purgeExpired",
] as const;
export type QueryOp = (typeof QUERY_OPS)[number];

export const MAINT_OPS = ["open-check-migrate", "checkpoint-passive", "checkpoint-truncate"] as const;
export type MaintOp = (typeof MAINT_OPS)[number];

/** Default per-op deadlines (plan §4.2). Query ops share one 2s deadline enforced by
 * `db-client.ts`, not per-op here; these are the maintenance one-shot deadlines. */
export const MAINT_DEADLINE_MS: Record<MaintOp, number> = {
  "open-check-migrate": 5_000,
  "checkpoint-passive": 3_000,
  "checkpoint-truncate": 3_000,
};

/** How often `checkpoint-passive` runs while the store is open (§4.2). */
export const CHECKPOINT_PASSIVE_INTERVAL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// §4.1 main-thread file check (fs.promises only — no sqlite)
// ---------------------------------------------------------------------------

export type DbFileIssue = { ok: true } | { ok: false; reason: "db-too-large" | "db-invalid"; detail: string };

export type DbFsDeps = Pick<typeof import("node:fs/promises"), "lstat" | "chmod"> & { getuid(): number };

function defaultDbFsDeps(): DbFsDeps {
  return { lstat, chmod, getuid: () => process.getuid?.() ?? 0 };
}

async function checkOneFile(
  path: string,
  maxBytes: number | undefined,
  fs: DbFsDeps,
  log: HubLog,
): Promise<DbFileIssue> {
  let st;
  try {
    st = await fs.lstat(path);
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === "ENOENT") return { ok: true }; // not created yet — fine, the maint op creates it
    return { ok: false, reason: "db-invalid", detail: `${path}: ${String((err as Error).message ?? err)}` };
  }
  if (!st.isFile()) {
    return { ok: false, reason: "db-invalid", detail: `${path}: not a regular file` };
  }
  const uid = fs.getuid();
  if (st.uid !== uid) {
    return { ok: false, reason: "db-invalid", detail: `${path}: owned by uid ${st.uid}, expected ${uid}` };
  }
  if (maxBytes !== undefined && st.size > maxBytes) {
    return { ok: false, reason: "db-too-large", detail: `${path}: ${st.size} bytes > ${maxBytes} byte limit` };
  }
  const mode = st.mode & 0o777;
  if (mode > DB_FILE_MODE) {
    try {
      await fs.chmod(path, DB_FILE_MODE);
      log.warn("web-hub db: widened file mode repaired", { path, mode: mode.toString(8) });
    } catch (err) {
      return { ok: false, reason: "db-invalid", detail: `${path}: chmod repair failed: ${String(err)}` };
    }
  }
  return { ok: true };
}

/**
 * §4.1 "打开前" check: db/-wal/-shm via `fs.promises.lstat` only. Missing files are
 * fine (not created yet, or WAL fully checkpointed) — only an existing, oversized
 * or wrong-owner file fails closed. Widened (but owner-correct) mode is repaired
 * in place with a warning, never rejected.
 */
export async function checkDbFiles(
  dbFile: string,
  deps: { fs?: Partial<DbFsDeps>; log: HubLog },
): Promise<DbFileIssue> {
  const fs = { ...defaultDbFsDeps(), ...deps.fs };
  const targets: Array<{ path: string; maxBytes: number | undefined }> = [
    { path: dbFile, maxBytes: DB_MAX_BYTES },
    { path: walPath(dbFile), maxBytes: WAL_MAX_BYTES },
    { path: shmPath(dbFile), maxBytes: undefined },
  ];
  for (const t of targets) {
    const issue = await checkOneFile(t.path, t.maxBytes, fs, deps.log);
    if (!issue.ok) return issue;
  }
  return { ok: true };
}

/** Runtime detection for whether `node:sqlite` exists in *this* process — used only by
 * tests (`hasNodeSqlite`) to `skipIf` on a Node build without it; never imported by any
 * code that runs in the hub's main thread (§4's own zero-hang argument depends on that).
 * Uses `createRequire` rather than a dynamic `import()` so the check also works inside
 * vite-node's sandboxed module loader (vitest), which doesn't yet externalize the
 * `node:sqlite` specifier for dynamic `import()`. */
export async function hasNodeSqlite(): Promise<boolean> {
  try {
    const { createRequire } = await import("node:module");
    createRequire(import.meta.url)("node:sqlite");
    return true;
  } catch {
    return false;
  }
}
