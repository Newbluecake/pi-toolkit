// §7.5 `/mem restore` (manifest/trash recovery, hash-conflict detection) —
// todo #22 P4. Every mutating step runs inside `withMemoryDirLock`.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { canonicalDir, readRegular, renameNoClobber, statRegularIfExists } from "../safe-fs.js";
import { memoryDirFor, MemoryError, type MemoryPaths } from "../paths.js";
import { withMemoryDirLock } from "../lock.js";
import type { TidyManifest, TidyManifestEntry } from "../contracts.js";
import { sha256Hex } from "./snapshot.js";
import {
  backupLiveFile,
  copyLiveFileToBackup,
  listTrashEntries,
  newTidyId,
  readManifest,
  recreateFromBackup,
  vacateLiveFile,
  writeManifest,
} from "./manifest.js";

export interface RestorePlanEntry {
  name: string;
  op: TidyManifestEntry["op"];
  newName?: string;
  conflict: boolean;
  reason?: string;
}

export interface RestorePlan {
  manifest: TidyManifest;
  entries: readonly RestorePlanEntry[];
}

function touchedLocationOf(e: TidyManifestEntry): string {
  return e.op === "rename" && e.newName ? e.newName : e.name;
}

interface CurrentState {
  exists: boolean;
  sha?: string;
  error?: string;
}

function currentStateOf(dir: string, name: string): CurrentState {
  let st;
  try {
    st = statRegularIfExists(dir, name);
  } catch (err) {
    return { exists: true, error: (err as Error).message };
  }
  if (st === undefined) return { exists: false };
  try {
    const { text } = readRegular(dir, name);
    return { exists: true, sha: sha256Hex(text) };
  } catch (err) {
    return { exists: true, error: (err as Error).message };
  }
}

/** `/mem restore <id>` step 1/2: read the manifest and classify every entry
 *  as safely restorable or conflicting (current content no longer matches
 *  what the manifest recorded). Never mutates anything. */
export function planRestore(cwd: string, id: string, paths?: MemoryPaths): RestorePlan {
  const display = memoryDirFor(cwd, paths);
  const canon = canonicalDir(display);
  if (!canon) throw new MemoryError(`no memory directory for ${cwd}`);
  const dir = canon.real;
  const manifest = readManifest(dir, id);
  if (!manifest) throw new MemoryError(`no backup ${id}`);

  const entries: RestorePlanEntry[] = manifest.entries.map((e) => {
    const loc = touchedLocationOf(e);
    const cur = currentStateOf(dir, loc);
    const base = { name: e.name, op: e.op, ...(e.newName !== undefined ? { newName: e.newName } : {}) };

    if (e.op === "create") {
      if (!cur.exists) return { ...base, conflict: false, reason: "already removed" };
      if (cur.error) return { ...base, conflict: true, reason: cur.error };
      if (cur.sha !== e.afterSha256) return { ...base, conflict: true, reason: "changed since tidy created it" };
      return { ...base, conflict: false };
    }
    if (e.op === "delete") {
      if (cur.exists)
        return { ...base, conflict: true, reason: cur.error ?? "a file now exists where the deleted one was" };
      return { ...base, conflict: false };
    }
    // rewrite / rename
    if (!cur.exists) return { ...base, conflict: true, reason: "file missing" };
    if (cur.error) return { ...base, conflict: true, reason: cur.error };
    if (cur.sha !== e.afterSha256) return { ...base, conflict: true, reason: "changed since tidy applied" };
    return { ...base, conflict: false };
  });
  return { manifest, entries };
}

export type RestoreDecision = "restore" | "overwrite" | "skip";

export interface RestoreResult {
  restored: readonly string[];
  skipped: readonly { name: string; reason: string }[];
  failed: readonly { name: string; reason: string }[];
  /** Set only when at least one currently-live file was captured before
   *  being touched (§7.5 step 3's pre-restore safety backup). */
  preRestoreBackupId?: string;
}

function restoreOne(dir: string, vacateId: string, originalId: string, e: TidyManifestEntry): void {
  const loc = touchedLocationOf(e);
  const current = statRegularIfExists(dir, loc);
  if (current !== undefined) vacateLiveFile(dir, vacateId, loc);
  if (e.op === "create") return; // undoing a create just means the file is gone now
  const backupSrc = e.backupFile ?? e.name;
  recreateFromBackup(dir, originalId, backupSrc, e.name);
}

/**
 * `/mem restore <id>` steps 2–4: back up every currently-live touched file
 * FIRST (a pure copy per file — §7.5's "该备份失败 ⇒ 整个 restore 中止、零写
 * 入": any failure here throws before a single live mutation has happened),
 * then restore each decided entry independently (a per-file failure does
 * not roll back earlier successes, §7.5 step 3). `onAfterWrite` is the
 * caller's responsibility.
 */
export async function applyRestore(
  cwd: string,
  id: string,
  decisions: ReadonlyMap<string, RestoreDecision>,
  paths?: MemoryPaths,
): Promise<RestoreResult> {
  const display = memoryDirFor(cwd, paths);
  const canon = canonicalDir(display);
  if (!canon) throw new MemoryError(`memory directory for ${cwd} is not accessible`);
  const dir = canon.real;
  const manifest = readManifest(dir, id);
  if (!manifest) throw new MemoryError(`no backup ${id}`);

  return withMemoryDirLock(dir, () => {
    const now = new Date();
    const vacateId = newTidyId(now, process.pid, randomBytes(3).toString("hex"));

    const touched = manifest.entries.filter((e) => {
      const d = decisions.get(e.name);
      return d === "restore" || d === "overwrite";
    });

    // Step A (must fully succeed before ANY live mutation, §7.5 step 3).
    const preRestoreEntries: TidyManifestEntry[] = [];
    for (const e of touched) {
      const loc = touchedLocationOf(e);
      const st = statRegularIfExists(dir, loc);
      if (st === undefined) continue;
      const { text } = readRegular(dir, loc);
      copyLiveFileToBackup(dir, vacateId, loc); // throws -> aborts before any Step B mutation
      preRestoreEntries.push({ name: loc, op: "rewrite", beforeSha256: sha256Hex(text), backupFile: loc });
    }
    if (preRestoreEntries.length > 0) {
      writeManifest(dir, {
        v: 1,
        id: vacateId,
        kind: "restore",
        createdAt: now.toISOString(),
        entries: preRestoreEntries,
      });
    }

    // Step B: independent per-entry restore.
    const restored: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    const failed: { name: string; reason: string }[] = [];
    for (const e of manifest.entries) {
      const d = decisions.get(e.name) ?? "skip";
      if (d === "skip") {
        skipped.push({ name: e.name, reason: "skipped by user" });
        continue;
      }
      try {
        restoreOne(dir, vacateId, id, e);
        restored.push(e.name);
      } catch (err) {
        failed.push({ name: e.name, reason: (err as Error).message });
      }
    }
    return {
      restored,
      skipped,
      failed,
      ...(preRestoreEntries.length > 0 ? { preRestoreBackupId: vacateId } : {}),
    };
  });
}

// ───────────────────────────── --trash ─────────────────────────────

export interface TrashRestoreResult {
  restored: boolean;
  reason?: string;
  /** Set only when the target already existed and had to be backed up
   *  first (Overwrite path). */
  backupId?: string;
}

/** `/mem restore --trash <id>`: move `.trash/<id>-<name>` back to `<name>`.
 *  `decision` only matters when the target already exists — "overwrite"
 *  backs the current file up (kind "restore") before clobbering it,
 *  "skip"/absent leaves everything untouched. */
export async function restoreFromTrash(
  cwd: string,
  id: string,
  decision: "overwrite" | "skip" = "skip",
  paths?: MemoryPaths,
): Promise<TrashRestoreResult> {
  const display = memoryDirFor(cwd, paths);
  const canon = canonicalDir(display);
  if (!canon) throw new MemoryError(`memory directory for ${cwd} is not accessible`);
  const dir = canon.real;

  return withMemoryDirLock(dir, () => {
    const entry = listTrashEntries(dir).find((e) => e.id === id);
    if (!entry) throw new MemoryError(`no trash entry ${id}`);
    const existing = statRegularIfExists(dir, entry.name);
    let backupId: string | undefined;
    if (existing !== undefined) {
      if (decision === "skip") return { restored: false, reason: `${entry.name} already exists` };
      const now = new Date();
      backupId = newTidyId(now, process.pid, randomBytes(3).toString("hex"));
      backupLiveFile(dir, backupId, entry.name);
      writeManifest(dir, {
        v: 1,
        id: backupId,
        kind: "restore",
        createdAt: now.toISOString(),
        entries: [{ name: entry.name, op: "rewrite", backupFile: entry.name }],
      });
    }
    renameNoClobber(dir, join(".trash", entry.fileName), entry.name);
    return { restored: true, ...(backupId !== undefined ? { backupId } : {}) };
  });
}
