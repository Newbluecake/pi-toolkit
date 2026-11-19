/** Real oversized auth fixture writer; not used by production. */
import { execFileSync } from "node:child_process";
// Acquire the write lock BEFORE reading the template, then seed all rows in one
// transaction. SQLite waits at most 5s; non-busy failures are never swallowed.
const script = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
try {
  db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
  const keep = Buffer.from(process.argv[2], 'base64url');
  const add = db.prepare('INSERT INTO sessions(sid_hash,user_id,epoch,bound_origin,created_at,last_seen_at,expires_at,absolute_expires_at,created_ip) SELECT ?,user_id,epoch,bound_origin,created_at,last_seen_at,expires_at,absolute_expires_at,created_ip FROM sessions WHERE sid_hash=?');
  for (const hash of JSON.parse(process.argv[3])) {
    if (add.run(Buffer.from(hash, 'base64url'), keep).changes !== 1)
      throw new Error('owned oversized original fixture failed');
  }
  db.exec('COMMIT');
} finally { db.close(); }
`;
export function seedOversizedSessions(dbFile: string, keep: string, hashes: string[]): void {
  execFileSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "-e", script, dbFile, keep, JSON.stringify(hashes)],
    { stdio: "pipe", timeout: 8000 },
  );
}
