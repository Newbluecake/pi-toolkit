/**
 * The two subprocess script bodies (plan §4.2): a resident **query** subprocess
 * (NDJSON over stdin/stdout, serial) and a short-lived **maintenance** subprocess
 * (one op per invocation via `PI_WEBHUB_DB_OP`, result on stdout). Both are run
 * as `node --disable-warning=ExperimentalWarning -e "<script>"` — plain CommonJS
 * text, never touched by jiti/tsc, never imported by any hub-main-thread module.
 * `node:sqlite` is only ever `require()`d inside these strings, executed in a
 * separate process.
 *
 * Test hooks (`__block`, `__crashAfterCommit`) are only spliced into the script
 * text when `PI_WEBHUB_DB_TEST=1` is set **in the process that builds the
 * script** (i.e. `db-client.ts`'s own env at spawn time) — the flag never has to
 * be read at runtime by the child itself, so a production hub never carries the
 * dead code path at all ("只在 PI_WEBHUB_DB_TEST=1 时编译进脚本").
 */
import {
  CHECKPOINT_PASSIVE_INTERVAL_MS,
  QUERY_PRAGMAS,
  SCHEMA_SQL_V1,
  SCHEMA_V1_COLUMNS,
  SCHEMA_V1_FOREIGN_KEYS,
  SCHEMA_V1_INDEX_COLUMNS,
  SCHEMA_V1_OBJECTS,
  USER_VERSION,
} from "./db.js";

export function dbTestModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["PI_WEBHUB_DB_TEST"] === "1";
}

// ---------------------------------------------------------------------------
// shared helpers embedded in both scripts
// ---------------------------------------------------------------------------

const COMMON_PRELUDE = `
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const crypto = require('node:crypto');
const DB_PATH = process.env.PI_WEBHUB_DB_PATH;
function b64(u8) { return Buffer.from(u8).toString('base64'); }
function unb64(s) { return new Uint8Array(Buffer.from(s, 'base64')); }
function userRow(row) {
  if (!row) return undefined;
  const out = {
    id: row.id, username: row.username, kdf: row.kdf,
    n: row.n, r: row.r, p: row.p,
    salt: b64(row.salt), hash: b64(row.hash), epoch: row.epoch,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
  if (row.initial_password !== null) out.initialPassword = row.initial_password;
  if (row.initial_created_at !== null) out.initialCreatedAt = row.initial_created_at;
  if (row.initial_login_at !== null) out.initialLoginAt = row.initial_login_at;
  if (row.initial_login_ip !== null) out.initialLoginIp = row.initial_login_ip;
  return out;
}
function randomInitialPassword() {
  const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let s = '';
    for (let i = 0; i < 5; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-');
}
function schemaObjectNames(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'").all();
  return new Set(rows.map((r) => r.name));
}
`;

// ---------------------------------------------------------------------------
// resident query subprocess (§4.2 "查询子进程（常驻）")
// ---------------------------------------------------------------------------

export function buildQueryScript(opts: { test?: boolean } = {}): string {
  const test = opts.test ?? dbTestModeEnabled();
  const pragmaExec = QUERY_PRAGMAS.map((p) => `db.exec(${JSON.stringify(p)});`).join("\n");
  const testHooks = test
    ? `
  if (op === '__block') {
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, Number(args.ms) || 10000);
    return { blocked: true };
  }
`
    : "";
  const crashAfterCommit = test
    ? `
    if (args && args.__crashAfterCommit) {
      try { process.stderr.write('DBG crash-after-commit op=' + op + '\\n'); } catch {}
      process.kill(process.pid, 'SIGKILL');
    }
`
    : "";
  const debugWriteLine = test
    ? `try { process.stderr.write('DBG applied-write op=' + op + ' changes=' + changes + '\\n'); } catch {}`
    : "";

  return `${COMMON_PRELUDE}
if (!DatabaseSync) {
  process.stderr.write('DBG sqlite-unavailable ' + String(__sqliteErr && __sqliteErr.message) + '\\n');
  process.exit(1);
}
let db;
try {
  db = new DatabaseSync(DB_PATH);
} catch (err) {
  process.stderr.write('DBG open-failed ' + String(err && err.message) + '\\n');
  process.exit(1);
}
${pragmaExec}
const stmtGetUser = db.prepare('SELECT * FROM users WHERE username = ?');
const stmtGetUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const stmtInsertSession = db.prepare('INSERT INTO sessions (sid_hash, user_id, epoch, bound_origin, created_at, last_seen_at, expires_at, absolute_expires_at, created_ip) VALUES (?,?,?,?,?,?,?,?,?)');
const stmtTouchSelect = db.prepare('SELECT user_id, epoch, bound_origin, expires_at, absolute_expires_at, last_seen_at FROM sessions WHERE sid_hash = ? AND expires_at > ? AND absolute_expires_at > ?');
const stmtTouchUpdate = db.prepare('UPDATE sessions SET last_seen_at=?, expires_at=? WHERE sid_hash=? AND last_seen_at < ?');
const stmtDeleteSession = db.prepare('DELETE FROM sessions WHERE sid_hash=?');
const stmtDeleteAllSessions = db.prepare('DELETE FROM sessions WHERE user_id=?');
const stmtMarkInitialLogin = db.prepare('UPDATE users SET initial_login_at=?, initial_login_ip=? WHERE username=? AND initial_login_at IS NULL');
const stmtUpdateUser = db.prepare('UPDATE users SET kdf=?, n=?, r=?, p=?, salt=?, hash=?, epoch=epoch+1, initial_password=NULL, initial_created_at=NULL, updated_at=? WHERE username=?');
const stmtInsertUser = db.prepare('INSERT INTO users (username, kdf, n, r, p, salt, hash, epoch, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)');
const stmtInitialInfo = db.prepare('SELECT username, initial_password, initial_login_at, initial_login_ip FROM users LIMIT 1');
const stmtPurge = db.prepare('DELETE FROM sessions WHERE sid_hash IN (SELECT sid_hash FROM sessions WHERE expires_at<=? OR absolute_expires_at<=? LIMIT 256)');

function handle(op, args) {
${testHooks}
  switch (op) {
    case 'getUser':
      return userRow(stmtGetUser.get(args.username));
    case 'getUserSummary': {
      const row = stmtGetUserById.get(args.userId);
      if (!row) return undefined;
      return { username: row.username, initialPasswordInUse: row.initial_password !== null };
    }
    case 'initialInfo': {
      const row = stmtInitialInfo.get();
      if (!row) return undefined;
      const out = { username: row.username };
      if (row.initial_password !== null) out.initialPassword = row.initial_password;
      if (row.initial_login_ip !== null && row.initial_login_at !== null) {
        out.initialLogin = { ip: row.initial_login_ip, at: row.initial_login_at };
      }
      return out;
    }
    case 'createSession': {
      stmtInsertSession.run(unb64(args.sidHash), args.userId, args.epoch, args.boundOrigin, args.now, args.now, args.now + 12 * 3600000, args.now + 7 * 24 * 3600000, args.createdIp);
      return null;
    }
    case 'touchSession': {
      const row = stmtTouchSelect.get(unb64(args.sidHash), args.now, args.now);
      if (!row) return undefined;
      let expiresAt = row.expires_at;
      if (args.now - row.last_seen_at >= 60000) {
        const newExpires = Math.min(args.now + 12 * 3600000, row.absolute_expires_at);
        const changes = stmtTouchUpdate.run(args.now, newExpires, unb64(args.sidHash), args.now - 60000).changes;
        ${debugWriteLine}
        if (changes > 0) expiresAt = newExpires;
      }
      return { userId: row.user_id, epoch: row.epoch, boundOrigin: row.bound_origin, expiresAt, absoluteExpiresAt: row.absolute_expires_at };
    }
    case 'deleteSession': {
      stmtDeleteSession.run(unb64(args.sidHash));
${crashAfterCommit}
      return null;
    }
    case 'deleteAllSessions': {
      stmtDeleteAllSessions.run(args.userId);
      return null;
    }
    case 'setPassword': {
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = stmtGetUser.get(args.username);
        if (existing) {
          stmtUpdateUser.run(args.kdf, args.n, args.r, args.p, unb64(args.salt), unb64(args.hash), args.now, args.username);
          stmtDeleteAllSessions.run(existing.id);
        } else {
          stmtInsertUser.run(args.username, args.kdf, args.n, args.r, args.p, unb64(args.salt), unb64(args.hash), args.now, args.now);
        }
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      }
${crashAfterCommit}
      return null;
    }
    case 'markInitialLogin': {
      stmtMarkInitialLogin.run(args.at, args.ip, args.username);
      return null;
    }
    case 'purgeExpired': {
      return stmtPurge.run(args.now, args.now).changes;
    }
    default:
      throw new Error('unknown op: ' + op);
  }
}

const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch (err) {
    return; // malformed line from a well-behaved parent should never happen; drop it
  }
  let out;
  try {
    const result = handle(req.op, req.args || {});
    out = { id: req.id, ok: true, result: result === undefined ? null : result };
  } catch (err) {
    out = { id: req.id, ok: false, code: 'E_DB', detail: String(err && err.message ? err.message : err) };
  }
  process.stdout.write(JSON.stringify(out) + '\\n');
});
process.stdin.on('error', () => {});
process.stdout.on('error', () => {});
`;
}

// ---------------------------------------------------------------------------
// short-lived maintenance subprocess (§4.2 "维护子进程（短命）")
// ---------------------------------------------------------------------------

export function buildMaintScript(): string {
  const pragmaBusy = `db.exec('PRAGMA busy_timeout=' + Math.max(0, Number(process.env.PI_WEBHUB_DB_DEADLINE_MS || '0') - 500) + ';');`;
  return `${COMMON_PRELUDE}
function reply(obj) {
  process.stdout.write(JSON.stringify(obj) + '\\n');
}
function openWxIfMissing() {
  try {
    const fd = fs.openSync(DB_PATH, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.closeSync(fd);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}
function run() {
  const op = process.env.PI_WEBHUB_DB_OP;
  if (!DatabaseSync) {
    reply({ ok: false, code: 'sqlite-unavailable', detail: String(__sqliteErr && __sqliteErr.message ? __sqliteErr.message : __sqliteErr) });
    return;
  }
  let db;
  try {
    if (op === 'open-check-migrate') openWxIfMissing();
    db = new DatabaseSync(DB_PATH);
  } catch (err) {
    reply({ ok: false, code: 'db-invalid', detail: String(err && err.message ? err.message : err) });
    return;
  }
  try {
    ${pragmaBusy}
    if (op === 'open-check-migrate') {
      let version;
      try {
        version = db.prepare('PRAGMA user_version').get().user_version;
      } catch (err) {
        reply({ ok: false, code: 'db-invalid', detail: 'cannot read user_version: ' + String(err && err.message) });
        return;
      }
      if (version === 0) {
        const objects = schemaObjectNames(db);
        if (objects.size > 0) {
          reply({ ok: false, code: 'db-invalid', detail: 'user_version=0 but schema objects already present' });
          return;
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec(${JSON.stringify(SCHEMA_SQL_V1)});
          db.exec('PRAGMA user_version=${USER_VERSION}');
          const now = Date.now();
          const password = randomInitialPassword();
          const salt = crypto.randomBytes(16);
          const hash = crypto.scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 32768 * 8 + 1024 * 1024 });
          db.prepare('INSERT INTO users (username, kdf, n, r, p, salt, hash, epoch, initial_password, initial_created_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,?,?,?,?)')
            .run('admin', 'scrypt', 32768, 8, 1, salt, hash, password, now, now, now);
          db.exec('COMMIT');
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      } else if (version === ${USER_VERSION}) {
        const objects = schemaObjectNames(db);
        const expected = ${JSON.stringify(SCHEMA_V1_OBJECTS)};
        for (const name of expected) {
          if (!objects.has(name)) {
            reply({ ok: false, code: 'db-invalid', detail: 'missing schema object: ' + name });
            return;
          }
        }
        // Review fix (§4.1/§4.3 "损坏"): name-only checks above pass for a table/index rebuilt
        // under the right name but with a dropped column, widened NOT NULL, wrong primary key,
        // an index on the wrong column, or a missing foreign key. Diff the actual structure too.
        const expectedColumns = ${JSON.stringify(SCHEMA_V1_COLUMNS)};
        for (const table of Object.keys(expectedColumns)) {
          const cols = expectedColumns[table];
          const info = db.prepare('PRAGMA table_info(' + table + ')').all();
          const byName = new Map(info.map((c) => [c.name, c]));
          for (const spec of cols) {
            const actual = byName.get(spec.name);
            if (!actual) {
              reply({ ok: false, code: 'db-invalid', detail: 'missing column: ' + table + '.' + spec.name });
              return;
            }
            if (
              String(actual.type).toUpperCase() !== spec.type ||
              Boolean(actual.notnull) !== spec.notnull ||
              Boolean(actual.pk) !== spec.pk
            ) {
              reply({ ok: false, code: 'db-invalid', detail: 'column constraint mismatch: ' + table + '.' + spec.name });
              return;
            }
          }
        }
        const expectedIndexColumns = ${JSON.stringify(SCHEMA_V1_INDEX_COLUMNS)};
        for (const indexName of Object.keys(expectedIndexColumns)) {
          const col = expectedIndexColumns[indexName];
          const indexInfo = db.prepare('PRAGMA index_info(' + indexName + ')').all();
          if (indexInfo.length !== 1 || indexInfo[0].name !== col) {
            reply({ ok: false, code: 'db-invalid', detail: 'index column mismatch: ' + indexName });
            return;
          }
        }
        const expectedForeignKeys = ${JSON.stringify(SCHEMA_V1_FOREIGN_KEYS)};
        for (const table of Object.keys(expectedForeignKeys)) {
          const fks = expectedForeignKeys[table];
          const actualFks = db.prepare('PRAGMA foreign_key_list(' + table + ')').all();
          for (const spec of fks) {
            const match = actualFks.find(
              (fk) => fk.from === spec.from && fk.table === spec.table && fk.to === spec.to && fk.on_delete === spec.onDelete,
            );
            if (!match) {
              reply({ ok: false, code: 'db-invalid', detail: 'foreign key mismatch: ' + table + '.' + spec.from });
              return;
            }
          }
        }
      } else {
        reply({ ok: false, code: 'db-invalid', detail: 'unsupported user_version=' + version });
        return;
      }
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (err) {
        reply({ ok: true, warning: 'checkpoint-truncate-failed: ' + String(err && err.message) });
        return;
      }
      reply({ ok: true });
      return;
    }
    if (op === 'checkpoint-passive') {
      db.exec('PRAGMA wal_checkpoint(PASSIVE)');
      reply({ ok: true });
      return;
    }
    if (op === 'checkpoint-truncate') {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      reply({ ok: true });
      return;
    }
    reply({ ok: false, code: 'db-invalid', detail: 'unknown maint op: ' + op });
  } finally {
    try { db.close(); } catch {}
  }
}
try {
  run();
} catch (err) {
  reply({ ok: false, code: 'db-invalid', detail: String(err && err.message ? err.message : err) });
}
`;
}
