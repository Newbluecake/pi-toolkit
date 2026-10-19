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
  QUERY_PRAGMAS,
  SESSION_META_SQL,
  LOGIN_IPS_SQL,
  TWOFA_SQL,
  LAN_SECURITY_COLUMNS,
  LAN_SECURITY_FKS,
  SCHEMA_SQL_V1,
  SCHEMA_V1_COLUMNS,
  SCHEMA_V1_FOREIGN_KEYS,
  SCHEMA_V1_INDEX_COLUMNS,
  SCHEMA_V1_OBJECTS,
  USER_VERSION,
} from "./db.js";
import { totpCode, verifyTotpCandidates } from "./totp.js";

export function dbTestModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["PI_WEBHUB_DB_TEST"] === "1";
}

// ---------------------------------------------------------------------------
// shared helpers embedded in both scripts
// ---------------------------------------------------------------------------

const COMMON_PRELUDE = `
'use strict';
// Kernel comm naming only (hub/comm.ts contract): cmdline is deliberately untouched.
try { require('node:fs').writeFileSync('/proc/self/comm', 'pi-webhub-auth'); } catch (err) {}
let DatabaseSync;
let __sqliteErr;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  __sqliteErr = err;
}
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
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index','view') AND name NOT LIKE 'sqlite_%'").all();
  return new Set(rows.map((r) => r.name));
}
`;

// Embedded in each child process, never in the hub's main-thread runtime.
const SECURITY_PRELUDE = `
const securityColumns = ${JSON.stringify(LAN_SECURITY_COLUMNS)};
const securityFks = ${JSON.stringify(LAN_SECURITY_FKS)};
function dropNamedTable(db, table) {
  const row = db.prepare("SELECT type FROM sqlite_master WHERE name=? AND type IN ('table','view')").get(table);
  if (row) db.exec('DROP ' + (row.type === 'view' ? 'VIEW ' : 'TABLE ') + table);
}
function tableMatches(db, table, specs = securityColumns[table]) {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all();
  if (cols.length !== specs.length) return false;
  for (const [name, type, notnull, pk] of specs) {
    const c = cols.find(c => c.name === name);
    if (!c || c.type.toUpperCase() !== type || c.notnull !== notnull || c.pk !== pk) return false;
  }
  const fks = db.prepare('PRAGMA foreign_key_list(' + table + ')').all();
  const expected = securityFks[table];
  if (fks.length !== expected.length || !expected.every(([from, target, to, onDelete]) =>
    fks.some(fk => fk.from === from && fk.table === target && fk.to === to && fk.on_delete === onDelete && fk.seq === 0))) return false;
  return db.prepare('PRAGMA table_list').all().some(t => t.name === table && t.type === 'table' && t.strict === 1);
}
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (err) { try { db.exec('ROLLBACK'); } catch {} throw err; }
}
function metaGet(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
}
function metaSet(db, key, value) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
function enrolledIds(db) {
  try {
    const ids = JSON.parse(metaGet(db, 'twofa_users'));
    if (!Array.isArray(ids) || !ids.every(id => Number.isSafeInteger(id) && id > 0) || new Set(ids).size !== ids.length) throw 0;
    return ids;
  } catch { throw new Error('2fa-missing-row'); }
}
function hasFactors(row) { return !!row && (row.totp_secret !== null || row.feishu === 1); }
function factorRowValid(row) {
  return !!row && Number.isSafeInteger(row.factor_gen) && row.factor_gen > 0 &&
    (row.feishu === 0 || row.feishu === 1) &&
    (row.totp_secret === null || (row.totp_secret.length === 20 && Number.isSafeInteger(row.totp_last_step) && row.totp_last_step >= 0)) &&
    (!hasFactors(row) || (row.recovery_salt !== null && row.recovery_salt.length === 16));
}
function factorsConsistent(db) {
  const ids = enrolledIds(db);
  for (const id of ids) {
    const row = db.prepare('SELECT * FROM twofa WHERE user_id=?').get(id);
    if (!factorRowValid(row) || !hasFactors(row) || !db.prepare('SELECT id FROM users WHERE id=?').get(id)) return false;
  }
  for (const row of db.prepare('SELECT * FROM twofa').all()) {
    if (!factorRowValid(row) || hasFactors(row) !== ids.includes(row.user_id)) return false;
  }
  return true;
}
function syncEnrolledIds(db) {
  metaSet(db, 'twofa_users', JSON.stringify(db.prepare('SELECT user_id FROM twofa WHERE totp_secret IS NOT NULL OR feishu=1 ORDER BY user_id').all().map(r => r.user_id)));
}
`;

const SECURITY_QUERY = `
const totpCode = ${totpCode.toString()};
const verifyTotpCandidates = ${verifyTotpCandidates.toString()};
const totpCrypto = {
  hmacSha1: (key, message) => crypto.createHmac('sha1', key).update(message).digest(),
  timingSafeEqual: (a, b) => crypto.timingSafeEqual(a, b),
};
// In-process pending secrets: bounded, timer-free, forgotten on child restart.
const pendingTotp = new Map();
function securityVersion() { return db.prepare('PRAGMA user_version').get().user_version; }
function ensureSecurityTables() {
  const version = securityVersion();
  if (version === 1) {
    if (schemaObjectNames(db).has('twofa') || schemaObjectNames(db).has('recovery_codes')) throw new Error('2fa-at-v1');
    db.exec(${JSON.stringify(TWOFA_SQL)});
    metaSet(db, 'twofa_users', '[]');
    db.exec('PRAGMA user_version=2');
  } else if (version !== 2) throw new Error('2fa-schema');
}
function factorState(userId) {
  if (securityVersion() === 1) return {state:'none', totp:false, feishu:false, recoveryLeft:0, factorGen:0};
  const row = db.prepare('SELECT * FROM twofa WHERE user_id=?').get(userId);
  const listed = enrolledIds(db).includes(userId);
  const inconsistent = row ? (!factorRowValid(row) || listed !== hasFactors(row)) : listed;
  return { state: inconsistent ? 'inconsistent' : hasFactors(row) ? 'enrolled' : 'none',
    totp: !!row?.totp_secret, feishu: row?.feishu === 1,
    recoveryLeft: row ? db.prepare('SELECT count(*) AS n FROM recovery_codes WHERE user_id=? AND used_at IS NULL').get(userId).n : 0,
    factorGen: row?.factor_gen ?? 0 };
}
function assertConsistent(userId) {
  if (factorState(userId).state === 'inconsistent') throw new Error('2fa-missing-row');
  if (!stmtGetUserById.get(userId)) throw new Error('unknown user');
}
function newFactorRow(userId, now) {
  db.prepare('INSERT OR IGNORE INTO twofa(user_id,totp_secret,totp_last_step,feishu,recovery_salt,factor_gen,enrolled_at,updated_at) VALUES(?,NULL,NULL,0,NULL,0,?,?)').run(userId, now, now);
}
function clearTrust() {
  db.exec('DELETE FROM login_ips');
  metaSet(db, 'login_ips_seeded', '1');
}
function recoverySet(userId) {
  const salt = crypto.randomBytes(16);
  db.prepare('DELETE FROM recovery_codes WHERE user_id=?').run(userId);
  db.prepare('UPDATE twofa SET recovery_salt=? WHERE user_id=?').run(salt, userId);
  const codes = new Set();
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  while (codes.size < 10) codes.add(Array.from(crypto.randomBytes(12), b => alphabet[b & 31]).join(''));
  for (const code of codes) {
    const hash = crypto.createHash('sha256').update(salt).update(code).digest();
    db.prepare('INSERT INTO recovery_codes(user_id,code_hash,used_at) VALUES(?,?,NULL)').run(userId, hash);
  }
  return Array.from(codes);
}
function base32(bytes) {
  let bits = 0, value = 0, out = '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out += alphabet[(value >>> bits) & 31]; }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function hashWire(bytes) { return Buffer.from(bytes).toString('base64url'); }
// Bound the JSON-encoded UA, not just JS characters (32 rows share a 64 KiB IPC frame).
function safeUa(value) {
  if (value === null || value === undefined) return null;
  let out = '', bytes = 0;
  for (const char of String(value).slice(0,512)) {
    bytes += Buffer.byteLength(JSON.stringify(char)) - 2;
    if (bytes > 512) break;
    out += char;
  }
  return out;
}
function trimUserSessions(userId) {
  const rows = db.prepare('SELECT sid_hash FROM sessions WHERE user_id=? ORDER BY last_seen_at DESC, created_at DESC, rowid DESC LIMIT -1 OFFSET 32').all(userId);
  for (const row of rows) stmtDeleteSession.run(row.sid_hash);
  return rows.map(row => hashWire(row.sid_hash));
}
function insertSession(args, checked) {
  return tx(db, () => {
    let inserted;
    if (checked) {
      if (!stmtGetUserById.get(args.userId)) return {ok:false,reason:'stale'};
      assertConsistent(args.userId);
      const join = securityVersion() === 2 ? 'LEFT JOIN twofa t ON t.user_id=u.id' : '';
      const gen = securityVersion() === 2 ? 'COALESCE(t.factor_gen,0)' : '0';
      inserted = db.prepare('INSERT INTO sessions(sid_hash,user_id,epoch,bound_origin,created_at,last_seen_at,expires_at,absolute_expires_at,created_ip) SELECT ?,u.id,u.epoch,?,?,?,?,?,? FROM users u ' + join + ' WHERE u.id=? AND u.epoch=? AND ' + gen + '=?')
        .run(unb64(args.sidHash), args.boundOrigin, args.now, args.now, Math.min(args.now + args.idleMs, args.now + 7*86400000), args.now + 7*86400000, args.createdIp, args.userId, args.expectedEpoch, args.expectedFactorGen).changes;
    } else {
      inserted = stmtInsertSession.run(unb64(args.sidHash), args.userId, args.epoch, args.boundOrigin, args.now, args.now, Math.min(args.now + args.idleMs, args.now + 7*86400000), args.now + 7*86400000, args.createdIp).changes;
    }
    if (!inserted) return {ok:false, reason:'stale'};
    db.prepare('INSERT INTO session_meta(sid_hash,user_agent,last_ip,method) VALUES(?,?,?,?)').run(unb64(args.sidHash), safeUa(args.ua), args.createdIp, args.method || 'password');
    return {ok:true, evicted:trimUserSessions(args.userId)};
  });
}
function handleSecurity(op, args) {
  switch (op) {
    case 'createSessionChecked': return insertSession(args, true);
    case 'listSessions': {
      return db.prepare('SELECT s.*, m.user_agent, m.last_ip, m.method FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN session_meta m ON m.sid_hash=s.sid_hash WHERE s.user_id=? AND s.epoch=u.epoch AND s.expires_at>? AND s.absolute_expires_at>? AND s.last_seen_at>? ORDER BY s.last_seen_at DESC, s.rowid DESC LIMIT 32')
        .all(args.userId, args.now, args.now, args.now - args.idleMs).map(r => ({sidHash:hashWire(r.sid_hash), userId:r.user_id, epoch:r.epoch, boundOrigin:r.bound_origin, createdAt:r.created_at, lastSeenAt:r.last_seen_at, expiresAt:r.expires_at, absoluteExpiresAt:r.absolute_expires_at, createdIp:r.created_ip, method:r.method || 'password',
          ...(r.last_ip === null ? {} : {lastIp:r.last_ip}), ...(r.user_agent === null ? {} : {ua:safeUa(r.user_agent)})}));
    }
    case 'deleteSessionsExcept': return tx(db, () => {
      const rows = db.prepare('SELECT sid_hash FROM sessions WHERE user_id=? AND sid_hash<>? LIMIT 65').all(args.userId, unb64(args.keepSidHash));
      const deleted = rows.slice(0,64);
      for (const row of deleted) stmtDeleteSession.run(row.sid_hash);
      return {deleted:deleted.map(r => hashWire(r.sid_hash)), more:rows.length > 64};
    });
    case 'isKnownIp': return !!db.prepare('SELECT 1 FROM login_ips WHERE ip=? AND last_at>?').get(args.ip, args.now - args.windowMs);
    case 'knownIpCount': return db.prepare('SELECT count(*) AS n FROM login_ips WHERE last_at>?').get(args.now - args.windowMs).n;
    case 'noteLoginIp': return tx(db, () => {
      const wasKnown = !!db.prepare('SELECT 1 FROM login_ips WHERE ip=? AND last_at>?').get(args.ip, args.now - 30*86400000);
      db.prepare('INSERT INTO login_ips(ip,first_at,last_at) VALUES(?,?,?) ON CONFLICT(ip) DO UPDATE SET last_at=excluded.last_at').run(args.ip, args.now, args.now);
      db.exec('DELETE FROM login_ips WHERE ip IN (SELECT ip FROM login_ips ORDER BY last_at DESC, rowid DESC LIMIT -1 OFFSET 256)');
      return {wasKnown};
    });
    case 'get2faState': return factorState(args.userId);
    case 'beginTotp': {
      assertConsistent(args.userId);
      const state = factorState(args.userId);
      if (state.totp && !args.replace) throw new Error('E_2FA_ENROLLED');
      for (const [id,p] of pendingTotp) if (p.expiresAt <= args.now) pendingTotp.delete(id);
      pendingTotp.delete(args.userId);
      if (pendingTotp.size >= 64) pendingTotp.delete(pendingTotp.keys().next().value);
      const secret = crypto.randomBytes(20), secretB32 = base32(secret);
      pendingTotp.set(args.userId, {secret, gen:state.factorGen, expiresAt:args.now + 300000});
      const label = encodeURIComponent('pi-webhub:' + stmtGetUserById.get(args.userId).username);
      return {secretB32, otpauthUri:'otpauth://totp/' + label + '?secret=' + secretB32 + '&issuer=pi-webhub&algorithm=SHA1&digits=6&period=30'};
    }
    case 'commitTotp': {
      const p = pendingTotp.get(args.userId);
      if (!p || p.expiresAt <= args.now) { pendingTotp.delete(args.userId); return {ok:false,reason:'none'}; }
      assertConsistent(args.userId);
      const state = factorState(args.userId);
      if (p.gen !== args.expectedGen || state.factorGen !== args.expectedGen) return {ok:false,reason:'stale'};
      const step = verifyTotpCandidates(p.secret, args.code, args.now, totpCrypto);
      if (step === undefined) return {ok:false,reason:'bad'};
      const result = tx(db, () => {
        ensureSecurityTables(); newFactorRow(args.userId, args.now);
        const changed = db.prepare('UPDATE twofa SET totp_secret=?,totp_last_step=?,factor_gen=factor_gen+1,updated_at=? WHERE user_id=? AND factor_gen=?').run(p.secret, step, args.now, args.userId, args.expectedGen).changes;
        if (!changed) throw new Error('factor CAS failed');
        const count = db.prepare('SELECT count(*) AS n FROM recovery_codes WHERE user_id=?').get(args.userId).n;
        const recoveryCodes = count === 0 ? recoverySet(args.userId) : [];
        if (state.state === 'none') clearTrust();
        syncEnrolledIds(db);
        return {ok:true, recoveryCodes};
      });
      pendingTotp.delete(args.userId);
      return result;
    }
    case 'verifyTotp': {
      assertConsistent(args.userId);
      const state = factorState(args.userId);
      if (state.factorGen !== args.expectedGen) return {ok:false,reason:'stale'};
      if (!state.totp) return {ok:false,reason:'none'};
      const row = db.prepare('SELECT * FROM twofa WHERE user_id=?').get(args.userId);
      const step = verifyTotpCandidates(row.totp_secret, args.code, args.now, totpCrypto);
      if (step === undefined) return {ok:false,reason:'bad'};
      const changed = db.prepare('UPDATE twofa SET totp_last_step=? WHERE user_id=? AND factor_gen=? AND totp_last_step<?').run(step, args.userId, args.expectedGen, step).changes;
      return changed ? {ok:true} : {ok:false,reason:'replay'};
    }
    case 'consumeRecovery': return tx(db, () => {
      assertConsistent(args.userId);
      const state = factorState(args.userId);
      if (state.factorGen !== args.expectedGen) return {ok:false,reason:'stale'};
      if (state.state !== 'enrolled') return {ok:false,reason:'none'};
      const row = db.prepare('SELECT recovery_salt FROM twofa WHERE user_id=?').get(args.userId);
      const hash = crypto.createHash('sha256').update(row.recovery_salt).update(args.code).digest();
      const code = db.prepare('SELECT used_at FROM recovery_codes WHERE user_id=? AND code_hash=?').get(args.userId, hash);
      if (!code) return {ok:false,reason:'bad'};
      const changed = db.prepare('UPDATE recovery_codes SET used_at=? WHERE user_id=? AND code_hash=? AND used_at IS NULL AND EXISTS(SELECT 1 FROM twofa WHERE user_id=? AND factor_gen=?)').run(args.now,args.userId,hash,args.userId,args.expectedGen).changes;
      return changed ? {ok:true,recoveryLeft:factorState(args.userId).recoveryLeft} : {ok:false,reason:'replay'};
    });
    case 'setFeishu2fa': return tx(db, () => {
      assertConsistent(args.userId);
      const state = factorState(args.userId);
      ensureSecurityTables(); newFactorRow(args.userId, args.now);
      db.prepare('UPDATE twofa SET feishu=?,factor_gen=factor_gen+1,updated_at=? WHERE user_id=?').run(args.on ? 1 : 0, args.now, args.userId);
      let recoveryCodes;
      if (args.on && state.state === 'none') { recoveryCodes = recoverySet(args.userId); clearTrust(); }
      if (!args.on && !state.totp) {
        db.prepare('DELETE FROM recovery_codes WHERE user_id=?').run(args.userId);
        db.prepare('UPDATE twofa SET recovery_salt=NULL WHERE user_id=?').run(args.userId);
      }
      syncEnrolledIds(db); pendingTotp.delete(args.userId);
      return recoveryCodes ? {recoveryCodes} : {};
    });
    case 'regenRecovery': return tx(db, () => {
      assertConsistent(args.userId);
      if (factorState(args.userId).state !== 'enrolled') throw new Error('E_2FA_NONE');
      const recoveryCodes = recoverySet(args.userId);
      db.prepare('UPDATE twofa SET factor_gen=factor_gen+1,updated_at=? WHERE user_id=?').run(args.now,args.userId);
      pendingTotp.delete(args.userId);
      return {recoveryCodes};
    });
    case 'reset2fa': return tx(db, () => {
      assertConsistent(args.userId); ensureSecurityTables(); newFactorRow(args.userId, args.now);
      db.prepare('DELETE FROM recovery_codes WHERE user_id=?').run(args.userId);
      db.prepare('UPDATE twofa SET totp_secret=NULL,totp_last_step=NULL,feishu=0,recovery_salt=NULL,factor_gen=factor_gen+1,updated_at=? WHERE user_id=?').run(args.now,args.userId);
      syncEnrolledIds(db); pendingTotp.delete(args.userId);
      return null;
    });
    case 'forgetLoginIps': return tx(db, () => {
      clearTrust();
      if (securityVersion() === 2) db.exec('UPDATE twofa SET factor_gen=factor_gen+1 WHERE totp_secret IS NOT NULL OR feishu=1');
      pendingTotp.clear(); return null;
    });
    default: throw new Error('unknown op: ' + op);
  }
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
${SECURITY_PRELUDE}
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
const stmtTouchSelect = db.prepare('SELECT s.user_id, s.epoch, s.bound_origin, s.expires_at, s.absolute_expires_at, s.last_seen_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.sid_hash = ? AND s.epoch=u.epoch AND s.expires_at > ? AND s.absolute_expires_at > ? AND s.last_seen_at > ?');
const stmtTouchUpdate = db.prepare('UPDATE sessions SET last_seen_at=?, expires_at=? WHERE sid_hash=? AND last_seen_at <= ?');
const stmtDeleteSession = db.prepare('DELETE FROM sessions WHERE sid_hash=?');
const stmtDeleteAllSessions = db.prepare('DELETE FROM sessions WHERE user_id=?');
const stmtMarkInitialLogin = db.prepare('UPDATE users SET initial_login_at=?, initial_login_ip=? WHERE username=? AND initial_login_at IS NULL');
const stmtUpdateUser = db.prepare('UPDATE users SET kdf=?, n=?, r=?, p=?, salt=?, hash=?, epoch=epoch+1, initial_password=NULL, initial_created_at=NULL, updated_at=? WHERE username=?');
const stmtInsertUser = db.prepare('INSERT INTO users (username, kdf, n, r, p, salt, hash, epoch, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)');
const stmtInitialInfo = db.prepare('SELECT username, initial_password, initial_login_at, initial_login_ip FROM users LIMIT 1');
const stmtPurge = db.prepare('DELETE FROM sessions WHERE sid_hash IN (SELECT sid_hash FROM sessions WHERE expires_at<=? OR absolute_expires_at<=? LIMIT 256)');

${SECURITY_QUERY}
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
    case 'createSession': { insertSession({idleMs:12*3600000,...args}, false); return null; }
    case 'touchSession': {
      const row = stmtTouchSelect.get(unb64(args.sidHash), args.now, args.now, args.now - (args.idleMs ?? 12*3600000));
      if (!row) return undefined;
      let expiresAt = row.expires_at;
      if (args.now - row.last_seen_at >= 60000) {
        const newExpires = Math.min(args.now + (args.idleMs ?? 12*3600000), row.absolute_expires_at);
        const changes = stmtTouchUpdate.run(args.now, newExpires, unb64(args.sidHash), args.now - 60000).changes;
        ${debugWriteLine}
        if (changes > 0) {
          expiresAt = newExpires;
          if (args.ip !== undefined) db.prepare('INSERT INTO session_meta(sid_hash,last_ip) VALUES(?,?) ON CONFLICT(sid_hash) DO UPDATE SET last_ip=excluded.last_ip').run(unb64(args.sidHash), args.ip);
        }
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
    case 'revokeAllSessions': {
      // §6.7.1 step ④: single transaction — bump every user's epoch (belt-and-suspenders in case a
      // session row survives the delete below for any reason) and delete every session row.
      let revoked = 0;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('UPDATE users SET epoch = epoch + 1');
        revoked = db.prepare('DELETE FROM sessions').run().changes;
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      }
${crashAfterCommit}
      return revoked;
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
      return handleSecurity(op, args);
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

export function buildMaintScript(opts: { initialUsername?: string } = {}): string {
  // L8 "用户名默认系统登录名": `lan-store.ts`'s `createLanStore` resolves the real value via
  // `os.userInfo().username` (falling back to the P1 literal `"admin"` on any failure) and
  // passes it in — this module has no `node:os` dependency of its own, so any caller that omits
  // `initialUsername` (e.g. tests exercising the maintenance script directly) keeps the original
  // P1 behavior. `JSON.stringify` embeds it as a safe string literal in the generated script text.
  const initialUsername = JSON.stringify(opts.initialUsername ?? "admin");
  const pragmaBusy = `db.exec('PRAGMA busy_timeout=' + Math.max(0, Number(process.env.PI_WEBHUB_DB_DEADLINE_MS || '0') - 500) + ';');`;
  return `${COMMON_PRELUDE}
${SECURITY_PRELUDE}
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
    db.exec('PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON');
    if (op === 'open-check-migrate' || op === 'repair-2fa') {
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
            .run(${initialUsername}, 'scrypt', 32768, 8, 1, salt, hash, password, now, now, now);
          db.exec('COMMIT');
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch {}
          throw err;
        }
      } else if (version === ${USER_VERSION} || version === 2) {
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
      // Security tables never get automatically rebuilt. Explicit repair is the ONLY exception.
      const objects = schemaObjectNames(db);
      if (op === 'repair-2fa') {
        tx(db, () => {
          dropNamedTable(db, 'recovery_codes'); dropNamedTable(db, 'twofa');
          db.exec(${JSON.stringify(TWOFA_SQL)});
          metaSet(db, 'twofa_users', '[]');
          db.exec('PRAGMA user_version=2');
        });
      } else {
        if (version === 1 && (objects.has('twofa') || objects.has('recovery_codes') || metaGet(db, 'twofa_users') !== undefined)) {
          reply({ok:false,code:'db-invalid',detail:'2fa-at-v1'}); return;
        }
        if (version === 2) {
          if (!tableMatches(db, 'twofa') || !tableMatches(db, 'recovery_codes')) {
            reply({ok:false,code:'db-invalid',detail:'2fa-schema'}); return;
          }
          if (!factorsConsistent(db)) {
            reply({ok:false,code:'db-invalid',detail:'2fa-missing-row'}); return;
          }
        }
      }
      let loginIpsRebuilt = false;
      tx(db, () => {
        // Preserve existing device metadata through this additive migration.
        if (tableMatches(db, 'session_meta', securityColumns.session_meta.filter(c => c[0] !== 'method'))) {
          db.exec('ALTER TABLE session_meta ADD COLUMN method TEXT');
          db.exec("UPDATE session_meta SET method='password'");
        }
        if (!tableMatches(db, 'session_meta')) {
          dropNamedTable(db, 'session_meta');
          db.exec(${JSON.stringify(SESSION_META_SQL)});
        }
        const seeded = metaGet(db, 'login_ips_seeded') !== undefined;
        if (!tableMatches(db, 'login_ips')) {
          loginIpsRebuilt = objects.has('login_ips') || seeded;
          dropNamedTable(db, 'login_ips');
          db.exec(${JSON.stringify(LOGIN_IPS_SQL)});
          // A damaged trust table is rebuilt EMPTY, never reseeded from surviving sessions.
          if (loginIpsRebuilt) metaSet(db, 'login_ips_seeded', '1');
        }
        if (metaGet(db, 'login_ips_seeded') === undefined) {
          db.exec('INSERT OR IGNORE INTO login_ips(ip,first_at,last_at) SELECT created_ip,min(created_at),max(last_seen_at) FROM sessions GROUP BY created_ip ORDER BY max(last_seen_at) DESC LIMIT 256');
          metaSet(db, 'login_ips_seeded', '1');
        }
        db.exec('DELETE FROM login_ips WHERE ip IN (SELECT ip FROM login_ips ORDER BY last_at DESC, rowid DESC LIMIT -1 OFFSET 256)');
        db.exec('DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM (SELECT rowid,row_number() OVER (PARTITION BY user_id ORDER BY last_seen_at DESC,created_at DESC,rowid DESC) AS n FROM sessions) WHERE n>32)');
      });
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (err) {
        reply({ ok: true, loginIpsRebuilt, warning: 'checkpoint-truncate-failed: ' + String(err && err.message) });
        return;
      }
      reply({ ok: true, loginIpsRebuilt });
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
