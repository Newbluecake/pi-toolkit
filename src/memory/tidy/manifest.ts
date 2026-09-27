// Shared backup/manifest primitives for `/mem tidy` apply and `/mem
// restore` (§7.3 step 7, §7.5) — todo #22 P4. Every fs touch goes through
// `../safe-fs.js`; this file has zero `node:fs` import itself (enforced by
// `tests/memory/fs-guard.test.ts`).
//
// Physical retention (§7.3 step 7 / §10 K6, "只保留最近 10 份"): P0-c added
// `removeFlatDir` to `safe-fs.ts` specifically for this — `pruneBackups`
// below uses it to actually delete `.backup/<id>` directories beyond the
// newest `MAX_BACKUPS`, not just cap what `listBackups`/`/mem restore`
// (bare) offer.

import { join } from "node:path";
import {
  canonicalDir,
  createExclusive,
  ensurePrivateDir,
  listDirNames,
  readRegular,
  removeFlatDir,
  renameNoClobber,
  replaceAtomic,
  writeTempRegular,
} from "../safe-fs.js";
import type { TidyManifest } from "../contracts.js";

const MANIFEST_NAME = "manifest.json";
export const MAX_BACKUPS = 10;

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

/** `<YYYYMMDDTHHmmssSSSZ>-<pid>-<rand6>` — same shape as the v2 `.trash`
 *  delete id (§3.3 决策 6), so backup/trash entries sort the same way. */
export function newTidyId(now: Date, pid: number, rand6: string): string {
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}${pad(now.getUTCMilliseconds(), 3)}Z`;
  return `${stamp}-${pid}-${rand6}`;
}

function relBackupDir(id: string): string {
  return join(".backup", id);
}

function relBackupPath(id: string, name: string): string {
  return join(".backup", id, name);
}

/** Move the CURRENT live file `name` into `.backup/<id>/<name>` — this both
 *  captures the pre-change bytes AND removes `name` from the live directory
 *  in one step (`renameNoClobber`'s existing hard-link-then-unlink-source
 *  semantics). Callers needing the live name to survive (rewrite, a rename
 *  that doesn't touch content) recreate it afterwards via
 *  `recreateFromBackup`. */
export function backupLiveFile(dir: string, id: string, name: string): void {
  ensurePrivateDir(join(dir, relBackupDir(id)));
  renameNoClobber(dir, name, relBackupPath(id, name));
}

/** Recreate `destName` in the live directory from a backed-up copy, byte for
 *  byte (used by a content-preserving rename, and by `/mem restore`). */
export function recreateFromBackup(dir: string, id: string, srcName: string, destName: string): void {
  const { text } = readRegular(join(dir, relBackupDir(id)), srcName);
  const tmp = writeTempRegular(dir, destName, Buffer.from(text, "utf8"), 0o600);
  createExclusive(dir, tmp, destName);
}

/** Pure COPY (never removes the live original) of the CURRENT live file
 *  `name` into `.backup/<id>/<name>` — `/mem restore`'s pre-restore safety
 *  net (§7.5 step 3): every one of these must succeed BEFORE any live
 *  mutation starts, so a failure here means zero writes, full stop. */
export function copyLiveFileToBackup(dir: string, id: string, name: string): void {
  const backupDir = join(dir, relBackupDir(id));
  ensurePrivateDir(backupDir);
  const { text } = readRegular(dir, name);
  const tmp = writeTempRegular(backupDir, name, Buffer.from(text, "utf8"), 0o600);
  createExclusive(backupDir, tmp, name);
}

/** Read a backed-up file's raw bytes without recreating it live (restore's
 *  hash-conflict pre-check). */
export function readBackupFile(dir: string, id: string, name: string): string {
  return readRegular(join(dir, relBackupDir(id)), name).text;
}

export function writeManifest(dir: string, manifest: TidyManifest): void {
  const backupDir = join(dir, relBackupDir(manifest.id));
  ensurePrivateDir(backupDir); // "create"-only applies never call backupLiveFile, so nothing else created this dir yet
  const data = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  const tmp = writeTempRegular(backupDir, MANIFEST_NAME, data, 0o600);
  replaceAtomic(backupDir, tmp, MANIFEST_NAME);
}

export function readManifest(dir: string, id: string): TidyManifest | undefined {
  try {
    const { text } = readRegular(join(dir, relBackupDir(id)), MANIFEST_NAME);
    return JSON.parse(text) as TidyManifest;
  } catch {
    return undefined;
  }
}

export interface BackupSummary {
  id: string;
  kind: TidyManifest["kind"];
  createdAt: string;
  fileCount: number;
}

/** List `.backup/*` entries newest-first (id is a zero-padded timestamp
 *  prefix, so lexicographic order == chronological order), reading each
 *  manifest. Entries without a readable manifest are skipped (defensive —
 *  should not happen in normal operation). Capped to `keep` (default
 *  `MAX_BACKUPS`) — physical retention beyond that count is `pruneBackups`
 *  below's job, run once per successful apply; this only bounds what is
 *  OFFERED for a given call. */
export function listBackups(dir: string, keep = MAX_BACKUPS): BackupSummary[] {
  const ids = listDirNames(join(dir, ".backup"));
  const out: BackupSummary[] = [];
  for (const id of ids) {
    const m = readManifest(dir, id);
    if (!m) continue;
    out.push({ id, kind: m.kind, createdAt: m.createdAt, fileCount: m.entries.length });
  }
  out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return out.slice(0, keep);
}

const BACKUP_ID_RE = /^\d{8}T\d{9}Z-\d+-[0-9a-f]{6}$/;

export interface PruneBackupsResult {
  removedIds: string[];
  skipped: { id: string; reason: string }[];
}

/** Physically delete `.backup/<id>` directories beyond the newest `keep`
 *  (§7.3 step 7 / §10 K6 — "只保留最近 10 份" means on disk, not just what `listBackups`
 *  offers). Only entries whose name matches the tidy id shape (`newTidyId`'s
 *  format) are ever considered — anything else under `.backup` (including a
 *  quarantine leftover from a previous interrupted `removeFlatDir`) is never
 *  touched. Sort key is the id string itself (same as `listBackups`), which
 *  is chronological because the timestamp prefix is zero-padded. A
 *  `removeFlatDir` refusal (symlink / not-flat / not-directory / …) or any
 *  unexpected fs error just skips that one id — it is retried on the next
 *  apply — and never aborts the loop or throws: this is a best-effort
 *  space-reclamation pass running AFTER the manifest write that must never
 *  affect the outcome of the apply that just succeeded. */
export function pruneBackups(dir: string, keep = MAX_BACKUPS): PruneBackupsResult {
  const removedIds: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const backupDir = join(dir, ".backup");
  const parent = canonicalDir(backupDir);
  if (!parent) return { removedIds, skipped };
  const ids = listDirNames(backupDir)
    .filter((id) => BACKUP_ID_RE.test(id))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // newest first
  for (const id of ids.slice(keep)) {
    try {
      const result = removeFlatDir(parent, id);
      if (result.removed) {
        removedIds.push(id);
      } else {
        skipped.push({ id, reason: result.reason });
      }
    } catch (err) {
      skipped.push({ id, reason: (err as Error).message });
    }
  }
  return { removedIds, skipped };
}

// ───────────────────────────── .trash (read-only from tidy's side) ─────────────────────────────

/** `.trash/<id>-<name>` entries this file's `name` suffix matches (P2's
 *  delete-id convention, §3.3 决策 6) — used by `/mem restore --trash`. */
export function listTrashEntries(dir: string): { id: string; name: string; fileName: string }[] {
  const names = listDirNames(join(dir, ".trash"));
  const out: { id: string; name: string; fileName: string }[] = [];
  const re = /^(\d{8}T\d{9}Z-\d+-[0-9a-f]{6})-(.+)$/;
  for (const fileName of names) {
    const m = re.exec(fileName);
    if (!m) continue;
    const id = m[1];
    const name = m[2];
    if (id === undefined || name === undefined) continue;
    out.push({ id, name, fileName });
  }
  out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return out;
}

/** Physically remove the CURRENT live file `name` from the live directory
 *  by relocating it under `.backup/<id>/__vacated__/<name>` — a throwaway
 *  copy distinct from any real backup snapshot living at `.backup/<id>/<name>`
 *  itself (`/mem restore`'s step-B "clear the target before recreating it"
 *  operation, §7.5 step 2/3). Reuses `renameNoClobber`'s existing
 *  hard-link-then-unlink-source semantics — no raw unlink needed. */
export function vacateLiveFile(dir: string, id: string, name: string): void {
  const vacateDir = join(dir, relBackupDir(id), "__vacated__");
  ensurePrivateDir(vacateDir);
  renameNoClobber(dir, name, join(relBackupDir(id), "__vacated__", name));
}
