// §7.3 step 7 apply (backup + atomic write + manifest) — todo #22 P4. Runs
// entirely inside `withMemoryDirLock` (the lock body MUST stay synchronous,
// `../lock.js`'s contract) and only ever touches files through
// `../safe-fs.js` primitives, same as every other memory write path.

import { randomBytes } from "node:crypto";
import {
  canonicalDir,
  createExclusive,
  readRegular,
  statRegularIfExists,
  writeTempRegular,
  type RegularRead,
} from "../safe-fs.js";
import { memoryDirFor, MemoryError, type MemoryPaths } from "../paths.js";
import { withMemoryDirLock } from "../lock.js";
import { upsertFrontmatterFields } from "../frontmatter.js";
import type { TidyFileAction, TidyManifest, TidyManifestEntry, TidyProposal, TidyProposalFile } from "../contracts.js";
import { sha256Hex } from "./snapshot.js";
import { backupLiveFile, newTidyId, pruneBackups, recreateFromBackup, writeManifest } from "./manifest.js";

export interface ApplyTidyInput {
  cwd: string;
  proposal: TidyProposal;
  /** Per-file user decision; only "apply" entries with a non-"keep" action
   *  are actually applied — everything else (skip / not present / "keep"
   *  action) is left untouched. */
  decisions: ReadonlyMap<string, "apply" | "skip">;
  /** name -> sha256 recorded at snapshot time (§7.3 step 1) — the pre-apply
   *  freshness recheck (step 7's "逐文件复查 sha256"). Required for every
   *  rewrite/delete/rename target; a missing entry is treated as a
   *  conflict (fail closed) rather than skipping the check. */
  originalSha: ReadonlyMap<string, string>;
  paths?: MemoryPaths;
  kind: "tidy" | "frontmatter";
  /** Test determinism hooks; default to the real clock/pid/random. */
  nowIso?: string;
  pid?: number;
  rand6?: string;
}

export interface AppliedFileResult {
  name: string;
  op: TidyManifestEntry["op"];
}
export interface SkippedFileResult {
  name: string;
  reason: string;
}

export interface ApplyTidyResult {
  manifest: TidyManifest;
  applied: readonly AppliedFileResult[];
  skipped: readonly SkippedFileResult[];
  /** Canonical (realpath'd) directory the operation ran in — for the
   *  caller's report / backup-path display. */
  dir: string;
}

function opOf(action: TidyFileAction): TidyManifestEntry["op"] {
  if (action === "keep") throw new MemoryError("unreachable: keep actions are filtered out before applyOne");
  return action;
}

function applyOne(
  dir: string,
  id: string,
  f: TidyProposalFile,
  originalSha: ReadonlyMap<string, string>,
  nowIso: string,
): TidyManifestEntry {
  if (f.action === "create") {
    const existing = statRegularIfExists(dir, f.name);
    if (existing !== undefined) throw new MemoryError(`${f.name} already exists`);
    const finalContent = upsertFrontmatterFields(f.content ?? "", { source: "agent", updated: nowIso });
    const tmp = writeTempRegular(dir, f.name, Buffer.from(finalContent, "utf8"), 0o600);
    createExclusive(dir, tmp, f.name);
    return { name: f.name, op: "create", afterSha256: sha256Hex(finalContent) };
  }

  // rewrite / delete / rename all touch a file that must still be exactly
  // what the snapshot recorded.
  const expected = originalSha.get(f.name);
  if (expected === undefined) throw new MemoryError(`${f.name} has no recorded snapshot hash — refusing (fail-closed)`);
  let current: RegularRead;
  try {
    current = readRegular(dir, f.name);
  } catch (err) {
    throw new MemoryError(`${f.name} is missing or unreadable: ${(err as Error).message}`);
  }
  const currentSha = sha256Hex(current.text);
  if (currentSha !== expected) {
    throw new MemoryError(`${f.name} changed on disk since the proposal was drafted`);
  }

  backupLiveFile(dir, id, f.name); // f.name is now gone from the live dir; content lives at .backup/<id>/<name>
  try {
    if (f.action === "delete") {
      return { name: f.name, op: "delete", beforeSha256: currentSha, backupFile: f.name };
    }
    if (f.action === "rewrite") {
      const finalContent = upsertFrontmatterFields(f.content ?? "", { source: "agent", updated: nowIso });
      const tmp = writeTempRegular(dir, f.name, Buffer.from(finalContent, "utf8"), 0o600);
      createExclusive(dir, tmp, f.name);
      return {
        name: f.name,
        op: "rewrite",
        beforeSha256: currentSha,
        afterSha256: sha256Hex(finalContent),
        backupFile: f.name,
      };
    }
    // rename
    const newName = f.newName;
    if (!newName) throw new MemoryError(`${f.name}: rename requires newName`);
    if (f.content !== undefined) {
      const finalContent = upsertFrontmatterFields(f.content, { source: "agent", updated: nowIso });
      const tmp = writeTempRegular(dir, newName, Buffer.from(finalContent, "utf8"), 0o600);
      createExclusive(dir, tmp, newName);
      return {
        name: f.name,
        op: "rename",
        newName,
        beforeSha256: currentSha,
        afterSha256: sha256Hex(finalContent),
        backupFile: f.name,
      };
    }
    recreateFromBackup(dir, id, f.name, newName);
    return {
      name: f.name,
      op: "rename",
      newName,
      beforeSha256: currentSha,
      afterSha256: currentSha,
      backupFile: f.name,
    };
  } catch (err) {
    // Best-effort recovery: put the original content back at its original
    // name so a mid-operation failure never leaves the live directory
    // missing a file it started with (the backup copy is the source of
    // truth either way — this is purely to avoid an unnecessary outage).
    try {
      recreateFromBackup(dir, id, f.name, f.name);
    } catch {
      // best effort — the backup copy still exists for manual recovery
    }
    throw err;
  }
}

/**
 * §7.3 step 7: one synchronous pass inside `withMemoryDirLock` — backup
 * every touched file, apply the decided ("apply") entries, write the
 * manifest exactly once. A per-file failure (sha mismatch, missing file,
 * fs error) is recorded in `skipped` and does NOT abort the rest of the
 * batch (§10 K9). `onAfterWrite` (the memory-block re-render hook) is the
 * CALLER's responsibility — this function only touches the filesystem.
 */
export async function applyTidy(input: ApplyTidyInput): Promise<ApplyTidyResult> {
  const display = memoryDirFor(input.cwd, input.paths);
  const canon = canonicalDir(display);
  if (!canon) throw new MemoryError(`memory directory for ${input.cwd} is not accessible`);
  const dir = canon.real;

  return withMemoryDirLock(dir, () => {
    const now = new Date(input.nowIso ?? new Date().toISOString());
    const id = newTidyId(now, input.pid ?? process.pid, input.rand6 ?? randomBytes(3).toString("hex"));
    const nowIso = now.toISOString();
    const entries: TidyManifestEntry[] = [];
    const applied: AppliedFileResult[] = [];
    const skipped: SkippedFileResult[] = [];

    const targets = input.proposal.files.filter((f) => f.action !== "keep" && input.decisions.get(f.name) === "apply");
    for (const f of targets) {
      try {
        const entry = applyOne(dir, id, f, input.originalSha, nowIso);
        entries.push(entry);
        applied.push({ name: f.name, op: opOf(f.action) });
      } catch (err) {
        skipped.push({ name: f.name, reason: (err as Error).message });
      }
    }

    const manifest: TidyManifest = { v: 1, id, kind: input.kind, createdAt: nowIso, entries };
    if (entries.length > 0) {
      writeManifest(dir, manifest);
      try {
        // §7.3 step 7 / §10 K6 — best-effort retention pruning; a failure
        // here (defense in depth on top of pruneBackups's own internal
        // per-id catch) must never invalidate an apply that already
        // succeeded. Retried on the next apply.
        pruneBackups(dir);
      } catch {
        // swallow
      }
    }
    return { manifest, applied, skipped, dir };
  });
}
