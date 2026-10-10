// §7.5 `/mem restore` (manifest/trash recovery, hash-conflict detection) —
// todo #22 P4. Every mutating step runs inside `withMemoryDirLock`.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  canonicalDir,
  createExclusive,
  observeLoc,
  openRunDirs,
  probeHardlinks,
  readRegular,
  renameNoClobber,
  resolveLoc,
  statRegularIfExists,
  writeTempRegular,
  type RunDirs,
} from "../safe-fs.js";
import { memoryDirFor, MemoryError, type MemoryPaths } from "../paths.js";
import { withMemoryDirLock } from "../lock.js";
import type { Ident, Loc, OpSpec, TidyManifest, TidyManifestEntry } from "../contracts.js";
import { sha256Hex } from "./snapshot.js";
import {
  listTrashEntries,
  newTidyId,
  readManifest,
  recreateFromBackup,
  vacateLiveFile,
  readManifestV2,
} from "./manifest.js";
import { runStep, type TxnOperation } from "./txn.js";
import { leaseCreate, leaseRelease, makeLeasePayload } from "./lease.js";

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

function locKey(loc: Loc): string {
  return loc.area === "tmp" ? `tmp:${loc.within}:${loc.name}` : `${loc.area}:${loc.name}`;
}
function restoreBackupName(seq: number, name: string): string {
  return `s${seq}-${seq}-live--${name}`;
}
function restoreTmp(nonce: string, seq: number, kind: "b" | "c"): Loc {
  return { area: "tmp", within: kind === "b" ? "backup" : "live", name: `.pt-${nonce}-${seq}-${kind}.tmp` };
}
function sourceBackupBytes(source: RunDirs, loc: Loc): Buffer {
  const r = resolveLoc(source, loc);
  return Buffer.from(readRegular(r.dir.path, r.name).text, "utf8");
}

/** Reverse a v2 journal into a new, independently journaled restore run. */
function applyLegacyRestoreTxn(
  dir: string,
  source: RunDirs,
  manifest: TidyManifest,
  decisions: ReadonlyMap<string, RestoreDecision>,
): RestoreResult {
  const now = new Date();
  const restoreId = newTidyId(now, process.pid, randomBytes(3).toString("hex"));
  const dest = openRunDirs(dir, restoreId, { createArchive: true, createBackup: true });
  const nonce = restoreId.slice(-6).padStart(8, "0").slice(0, 8);
  const contents = new Map<string, Buffer | string>();
  const ops: TxnOperation[] = [];
  const names: string[] = [];
  let seq = 1;
  for (const entry of manifest.entries) {
    const decision = decisions.get(entry.name) ?? "skip";
    if (decision !== "restore" && decision !== "overwrite") continue;
    const targetName = touchedLocationOf(entry);
    const target: Loc = { area: "live", name: targetName };
    const current = observeLoc(dest, target);
    const desiredName = entry.backupFile ?? entry.name;
    let desired: Buffer;
    try {
      desired = Buffer.from(readRegular(source.backup.path, desiredName).text, "utf8");
    } catch {
      continue;
    }
    const tmp: Loc = { area: "tmp", within: "live", name: `.pt-${nonce}-${seq}-c.tmp` };
    contents.set(locKey(tmp), desired);
    const backup: Loc = { area: "backup", name: `s${seq}-${seq}-live--${entry.name}` };
    if (entry.op === "rename" && entry.newName) {
      const restoredTarget: Loc = { area: "live", name: entry.name };
      ops.push({
        op: { prim: "CREATE", target: restoredTarget, afterSha: sha256Hex(desired.toString("utf8")), tmpContent: tmp },
        seq,
        group: seq,
        phase: "restore",
      });
      if (current.kind === "file")
        ops.push({
          op: {
            prim: "MOVE",
            src: target,
            dst: backup,
            obj: { dev: current.dev, ino: current.ino, sha: current.sha, size: current.size },
          },
          seq: seq + 1,
          group: seq,
          phase: "restore",
        });
      names.push(entry.name);
      seq += 2;
      continue;
    }
    if (entry.op === "create") {
      if (current.kind === "file")
        ops.push({
          op: {
            prim: "MOVE",
            src: target,
            dst: backup,
            obj: { dev: current.dev, ino: current.ino, sha: current.sha, size: current.size },
          },
          seq,
          phase: "restore",
        });
      names.push(entry.name);
      seq++;
      continue;
    }
    if (current.kind === "file") {
      const before: Ident = { dev: current.dev, ino: current.ino, sha: current.sha, size: current.size };
      ops.push({
        op: {
          prim: "REPLACE",
          target,
          before,
          afterSha: sha256Hex(desired.toString("utf8")),
          backup,
          tmpBackup: { area: "tmp", within: "backup", name: `.pt-${nonce}-${seq}-b.tmp` },
          tmpContent: tmp,
        },
        seq,
        phase: "restore",
      });
    } else
      ops.push({
        op: { prim: "CREATE", target, afterSha: sha256Hex(desired.toString("utf8")), tmpContent: tmp },
        seq,
        phase: "restore",
      });
    names.push(entry.name);
    seq++;
  }
  if (ops.length === 0)
    return {
      restored: [],
      skipped: [...decisions]
        .filter(([, value]) => value === "skip")
        .map(([name]) => ({ name, reason: "skipped by user" })),
      failed: [],
    };
  probeHardlinks(dest);
  const deadline = Date.now() + 30_000;
  let result = runStep({ dirs: dest, id: restoreId, kind: "restore", phase: "restore", ops, contents, probe: false });
  // Keep the lock across continuation blocks: releasing between journal
  // blocks would let a legacy writer invalidate the next CAS. The lease and
  // epoch model already bound this synchronous critical section.
  while (result.state === "applying" && result.results.length < ops.length && Date.now() < deadline)
    result = runStep({ dirs: dest, id: restoreId, kind: "restore", phase: "restore", ops, contents, probe: false });
  const restored = names.filter((_, index) => result.results[index]?.state === "done");
  const failed = names
    .filter((_, index) => result.results[index]?.state !== "done")
    .map((name) => ({ name, reason: "legacy restore transaction conflict" }));
  return {
    restored,
    skipped: [...decisions]
      .filter(([, value]) => value === "skip")
      .map(([name]) => ({ name, reason: "skipped by user" })),
    failed,
    preRestoreBackupId: restoreId,
  };
}

function applyRestoreV2(
  dir: string,
  source: RunDirs,
  original: NonNullable<ReturnType<typeof readManifestV2>>,
  decisions: ReadonlyMap<string, RestoreDecision>,
): RestoreResult {
  const now = new Date();
  const restoreId = newTidyId(now, process.pid, randomBytes(3).toString("hex"));
  const dest = openRunDirs(dir, restoreId, { createArchive: true, createBackup: true });
  const nonce = restoreId.slice(-6).padStart(8, "0").slice(0, 8);
  const contents = new Map<string, Buffer | string>();
  const ops: TxnOperation[] = [];
  const names: string[] = [];
  let seq = 1;
  const intents = original.events.filter(
    (e): e is Extract<import("../contracts.js").JournalEvent, { ev: "intent" }> => e.ev === "intent",
  );
  const results = new Set(
    original.events
      .filter(
        (e): e is Extract<import("../contracts.js").JournalEvent, { ev: "result" }> =>
          e.ev === "result" && e.state === "done",
      )
      .map((e) => e.opId),
  );
  const handled = new Set<string>();
  for (const intent of intents) {
    if (!results.has(intent.opId) || handled.has(intent.opId)) continue;
    const op = intent.op;
    if (op.prim === "CREATE" && op.target.area === "live") {
      const mate =
        intent.group === undefined
          ? undefined
          : intents.find(
              (candidate) =>
                candidate.group === intent.group && candidate.op.prim === "MOVE" && candidate.op.src.area === "live",
            );
      const name = mate && mate.op.prim === "MOVE" ? mate.op.src.name : op.target.name;
      const decision = decisions.get(name) ?? "skip";
      if (decision === "restore" || decision === "overwrite") {
        const current = observeLoc(dest, op.target);
        const currentIdent =
          current.kind === "file"
            ? { dev: current.dev, ino: current.ino, sha: current.sha, size: current.size }
            : undefined;
        if (currentIdent) {
          const backup: Loc = { area: "backup", name: restoreBackupName(seq, name) };
          ops.push({ op: { prim: "MOVE", src: op.target, dst: backup, obj: currentIdent }, seq, phase: "restore" });
          names.push(name);
          seq++;
        }
        if (mate && mate.op.prim === "MOVE") {
          const oldTarget: Loc = { area: "live", name: name };
          const tmp = restoreTmp(nonce, seq, "c");
          const bytes = sourceBackupBytes(source, mate.op.dst);
          contents.set(locKey(tmp), bytes);
          ops.push({
            op: { prim: "CREATE", target: oldTarget, afterSha: mate.op.obj.sha, tmpContent: tmp },
            seq,
            phase: "restore",
          });
          seq++;
          handled.add(mate.opId);
        }
      }
      continue;
    }
    if (op.prim === "MOVE" && op.src.area === "live" && op.dst.area === "backup") {
      if (handled.has(intent.opId)) continue;
      const decision = decisions.get(op.src.name) ?? "skip";
      if (decision === "restore" || decision === "overwrite") {
        const target: Loc = { area: "live", name: op.src.name };
        const tmp = restoreTmp(nonce, seq, "c");
        const bytes = sourceBackupBytes(source, op.dst);
        contents.set(locKey(tmp), bytes);
        ops.push({ op: { prim: "CREATE", target, afterSha: op.obj.sha, tmpContent: tmp }, seq, phase: "restore" });
        names.push(op.src.name);
        seq++;
      }
      continue;
    }
    if (op.prim === "REPLACE" && op.target.area === "live") {
      const decision = decisions.get(op.target.name) ?? "skip";
      if (decision !== "restore" && decision !== "overwrite") continue;
      const current = observeLoc(dest, op.target);
      if (current.kind !== "file") continue;
      const before: Ident = { dev: current.dev, ino: current.ino, sha: current.sha, size: current.size };
      const tmp = restoreTmp(nonce, seq, "c");
      const backup: Loc = { area: "backup", name: restoreBackupName(seq, op.target.name) };
      const bytes = sourceBackupBytes(source, op.backup);
      contents.set(locKey(tmp), bytes);
      ops.push({
        op: {
          prim: "REPLACE",
          target: op.target,
          before,
          afterSha: op.before.sha,
          backup,
          tmpBackup: restoreTmp(nonce, seq, "b"),
          tmpContent: tmp,
        },
        seq,
        phase: "restore",
      });
      names.push(op.target.name);
      seq++;
    }
  }
  if (ops.length === 0)
    return {
      restored: [],
      skipped: [...decisions].filter(([, d]) => d === "skip").map(([name]) => ({ name, reason: "skipped by user" })),
      failed: [],
    };
  probeHardlinks(dest);
  const deadline = Date.now() + 30_000;
  let result = runStep({ dirs: dest, id: restoreId, kind: "restore", phase: "restore", ops, contents, probe: false });
  // Same critical-section decision as the legacy restore loop above; the next
  // CAS must not run after an interleaving writer has acquired the lock.
  while (result.state === "applying" && result.results.length < ops.length && Date.now() < deadline)
    result = runStep({ dirs: dest, id: restoreId, kind: "restore", phase: "restore", ops, contents, probe: false });
  const restored = names.filter((name, index) => result.results[index]?.state === "done");
  const failed = names
    .filter((name, index) => result.results[index]?.state !== "done")
    .map((name) => ({
      name,
      reason: result.state === "applying" ? "transaction deadline exceeded" : "restore transaction conflict",
    }));
  return {
    restored,
    skipped: [...decisions].filter(([, d]) => d === "skip").map(([name]) => ({ name, reason: "skipped by user" })),
    failed,
    preRestoreBackupId: restoreId,
  };
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
  options: { legacy?: boolean } = {},
): Promise<RestoreResult> {
  const display = memoryDirFor(cwd, paths);
  const canon = canonicalDir(display);
  if (!canon) throw new MemoryError(`memory directory for ${cwd} is not accessible`);
  const dir = canon.real;
  const manifest = readManifest(dir, id);
  if (!manifest) throw new MemoryError(`no backup ${id}`);

  return withMemoryDirLock(dir, () => {
    const sourceDirs = openRunDirs(dir, id, { createArchive: false, createBackup: false });
    const lease = makeLeasePayload(0, [id]);
    if (!leaseCreate(dir, lease)) throw new MemoryError("memory directory already has an active tidy run");
    try {
      const v2 = readManifestV2(sourceDirs, id);
      if (v2) return applyRestoreV2(dir, sourceDirs, v2, decisions);
      if (!options.legacy && manifest.v === 1)
        throw new MemoryError("legacy v1 manifest is read-only — restore requires --legacy");
      if (manifest.v === 1) return applyLegacyRestoreTxn(dir, sourceDirs, manifest, decisions);
      // `readManifest` projects v2 manifests to the v1 compatibility shape;
      // the only non-legacy branch above is therefore unreachable. Keeping
      // this explicit guard makes a future manifest kind fail closed.
      throw new MemoryError("unsupported restore manifest version");
    } finally {
      leaseRelease(dir, lease.token);
    }
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
    const now = new Date();
    const runId = newTidyId(now, process.pid, randomBytes(3).toString("hex"));
    const lease = makeLeasePayload(0, [runId]);
    if (!leaseCreate(dir, lease)) throw new MemoryError("memory directory already has an active tidy run");
    try {
      const entry = listTrashEntries(dir).find((e) => e.id === id);
      if (!entry) throw new MemoryError(`no trash entry ${id}`);
      const existing = statRegularIfExists(dir, entry.name);
      if (existing !== undefined && decision === "skip")
        return { restored: false, reason: `${entry.name} already exists` };
      const dirs = openRunDirs(dir, runId, { createArchive: true, createBackup: true });
      const source: Loc = { area: "trash", name: entry.fileName };
      const target: Loc = { area: "live", name: entry.name };
      const ops: TxnOperation[] = [];
      if (existing !== undefined) {
        const current = observeLoc(dirs, target);
        if (current.kind !== "file") return { restored: false, reason: `${entry.name} is not a regular file` };
        const before: Ident = { dev: current.dev, ino: current.ino, sha: current.sha, size: current.size };
        ops.push({
          op: { prim: "MOVE", src: target, dst: { area: "backup", name: `s1-1-live--${entry.name}` }, obj: before },
          seq: 1,
          phase: "restore",
        });
      }
      const trashObs = observeLoc(dirs, source);
      if (trashObs.kind !== "file") throw new MemoryError(`trash entry ${entry.fileName} is missing or unreadable`);
      ops.push({
        op: {
          prim: "MOVE",
          src: source,
          dst: target,
          obj: { dev: trashObs.dev, ino: trashObs.ino, sha: trashObs.sha, size: trashObs.size },
        },
        seq: ops.length + 1,
        phase: "restore",
      });
      probeHardlinks(dirs);
      const outcome = runStep({ dirs, id: runId, kind: "restore", phase: "restore", ops, probe: false });
      const ok = outcome.results.length === ops.length && outcome.results.every((result) => result.state === "done");
      if (ok && existing !== undefined) {
        try {
          const canonical = readRegular(dirs.backup.path, `s1-1-live--${entry.name}`).text;
          const tmp = writeTempRegular(dirs.backup.path, entry.name, Buffer.from(canonical, "utf8"), 0o600);
          createExclusive(dirs.backup.path, tmp, entry.name);
        } catch {
          // The canonical journal backup remains authoritative.
        }
      }
      return {
        restored: ok,
        ...(ok && existing !== undefined ? { backupId: runId } : {}),
        ...(ok ? {} : { reason: "restore transaction did not complete" }),
      };
    } finally {
      leaseRelease(dir, lease.token);
    }
  });
}
