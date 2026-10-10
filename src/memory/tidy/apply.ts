// Transactional tidy/frontmatter apply (P2b).  The returned `manifest` is
// still the v1 projection used by the pre-batch command API; the on-disk
// manifest is v2 and is recoverable through `readManifestV2`.
import { randomBytes } from "node:crypto";
import {
  canonicalDir,
  createExclusive,
  observeLoc,
  openRunDirs,
  probeHardlinks,
  readRegular,
  resolveLoc,
  statRegularIfExists,
  writeTempRegular,
  type RunDirs,
} from "../safe-fs.js";
import { memoryDirFor, MemoryError, type MemoryPaths } from "../paths.js";
import { withMemoryDirLock } from "../lock.js";
import { upsertFrontmatterFields } from "../frontmatter.js";
import type {
  Ident,
  Loc,
  TidyFileAction,
  TidyManifest,
  TidyManifestEntry,
  TidyProposal,
  TidyProposalFile,
} from "../contracts.js";
import { sha256Hex } from "./snapshot.js";
import { newTidyId, pruneBackups, readManifestV2 } from "./manifest.js";
import { runStep, type TxnOperation } from "./txn.js";
import { leaseCreate, leaseRelease, makeLeasePayload, type LeasePayload } from "./lease.js";

export interface ApplyTidyInput {
  cwd: string;
  proposal: TidyProposal;
  decisions: ReadonlyMap<string, "apply" | "skip">;
  originalSha: ReadonlyMap<string, string>;
  paths?: MemoryPaths;
  kind: "tidy" | "frontmatter";
  nowIso?: string;
  pid?: number;
  rand6?: string;
  /** Batch orchestration owns the lease for the entire command. */
  lease?: LeasePayload;
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
  dir: string;
}

const locKey = (loc: Loc): string => (loc.area === "tmp" ? `tmp:${loc.within}:${loc.name}` : `${loc.area}:${loc.name}`);
function contentSha(value: string | Buffer): string {
  return sha256Hex(typeof value === "string" ? value : value.toString("utf8"));
}
const ident = (obs: ReturnType<typeof observeLoc>): Ident | undefined =>
  obs.kind === "file" ? { dev: obs.dev, ino: obs.ino, sha: obs.sha, size: obs.size } : undefined;
function backupName(seq: number, name: string): string {
  return `s${seq}-${seq}-live--${name}`;
}
function tmpName(nonce: string, seq: number, kind: "b" | "c"): string {
  return `.pt-${nonce}-${seq}-${kind}.tmp`;
}
function actionOp(action: TidyFileAction): TidyManifestEntry["op"] {
  if (action === "keep") throw new Error("keep is not applied");
  return action;
}

interface Built {
  operations: readonly TxnOperation[];
  entry: TidyManifestEntry;
  content: Map<string, Buffer | string>;
}
function buildOne(
  dirs: RunDirs,
  id: string,
  file: TidyProposalFile,
  seq: number,
  originalSha: ReadonlyMap<string, string>,
  nowIso: string,
): Built {
  const src: Loc = { area: "live", name: file.name };
  const before = observeLoc(dirs, src);
  const beforeIdent = ident(before);
  if (file.action !== "create") {
    if (!beforeIdent || beforeIdent.sha !== originalSha.get(file.name))
      throw new MemoryError(`${file.name} changed on disk since the proposal was drafted`);
  }
  const nonce = id.slice(-6).padStart(8, "0").slice(0, 8);
  if (file.action === "create") {
    if (before.kind !== "absent") throw new MemoryError(`${file.name} already exists`);
    const content = upsertFrontmatterFields(file.content ?? "", { source: "agent", updated: nowIso });
    const tmp: Loc = { area: "tmp", within: "live", name: tmpName(nonce, seq, "c") };
    return {
      operations: [
        {
          op: { prim: "CREATE", target: src, afterSha: sha256Hex(content), tmpContent: tmp },
          seq,
          phase: "frontmatter",
        },
      ],
      entry: { name: file.name, op: "create", afterSha256: sha256Hex(content) },
      content: new Map([[locKey(tmp), content]]),
    };
  }
  if (!beforeIdent) throw new MemoryError(`${file.name} is missing or unreadable`);
  const backup: Loc = { area: "backup", name: backupName(seq, file.name) };
  if (file.action === "delete")
    return {
      operations: [{ op: { prim: "MOVE", src, dst: backup, obj: beforeIdent }, seq, phase: "normalize" }],
      entry: { name: file.name, op: "delete", beforeSha256: beforeIdent.sha, backupFile: backup.name },
      content: new Map(),
    };
  if (file.action === "rewrite" || file.action === "rename") {
    const destinationName = file.action === "rename" ? file.newName : file.name;
    if (!destinationName) throw new MemoryError(`${file.name}: rename requires newName`);
    const destination: Loc = { area: "live", name: destinationName };
    const output =
      file.content === undefined
        ? readBytes(dirs, src)
        : upsertFrontmatterFields(file.content, { source: "agent", updated: nowIso });
    const contentTmp: Loc = { area: "tmp", within: "live", name: tmpName(nonce, seq, "c") };
    const backupTmp: Loc = { area: "tmp", within: "backup", name: tmpName(nonce, seq, "b") };
    const replace: OpSpecLike = {
      prim: "REPLACE",
      target: destination,
      before: beforeIdent,
      afterSha: contentSha(output),
      backup,
      tmpBackup: backupTmp,
      tmpContent: contentTmp,
    };
    // A rename with a distinct destination is represented by the prescribed
    // CREATE+MOVE group, not by a single replacement of the old name.
    if (destinationName !== file.name) {
      const create: TxnOperation = {
        op: { prim: "CREATE", target: destination, afterSha: contentSha(output), tmpContent: contentTmp },
        seq,
        group: seq,
        phase: "normalize",
      };
      const move: TxnOperation = {
        op: { prim: "MOVE", src, dst: backup, obj: beforeIdent },
        seq: seq + 1,
        group: seq,
        phase: "normalize",
      };
      return {
        operations: [create, move],
        entry: {
          name: file.name,
          op: "rename",
          newName: destinationName,
          beforeSha256: beforeIdent.sha,
          afterSha256: contentSha(output),
          backupFile: backup.name,
        },
        content: new Map([
          [locKey(contentTmp), output],
          [locKey(backupTmp), readBytes(dirs, src)],
        ]),
      };
    }
    return {
      operations: [{ op: replace, seq, phase: "normalize" }],
      entry: {
        name: file.name,
        op: "rewrite",
        beforeSha256: beforeIdent.sha,
        afterSha256: contentSha(output),
        backupFile: backup.name,
      },
      content: new Map([[locKey(contentTmp), output]]),
    };
  }
  throw new MemoryError(`unsupported action ${file.action}`);
}
// Structural alias avoids repeating the large discriminated union in the
// builder's local branch above.
type OpSpecLike = Extract<import("../contracts.js").OpSpec, { prim: "REPLACE" }>;
function readBytes(dirs: RunDirs, loc: Loc): Buffer {
  const resolved = resolveLoc(dirs, loc);
  return Buffer.from(readRegular(resolved.dir.path, resolved.name).text, "utf8");
}

/** Apply each selected proposal through one v2 journal.  Failed candidates
 * are isolated before the transaction starts; once an op is journaled, its
 * result is authoritative and recovery can safely finish it. */
export async function applyTidy(input: ApplyTidyInput): Promise<ApplyTidyResult> {
  const display = memoryDirFor(input.cwd, input.paths);
  const canon = canonicalDir(display);
  if (!canon) throw new MemoryError(`memory directory for ${input.cwd} is not accessible`);
  const dir = canon.real;
  const now = new Date(input.nowIso ?? new Date().toISOString());
  const id = newTidyId(now, input.pid ?? process.pid, input.rand6 ?? randomBytes(3).toString("hex"));
  return withMemoryDirLock(dir, () => {
    const selected = input.proposal.files.filter(
      (file) => file.action !== "keep" && input.decisions.get(file.name) === "apply",
    );
    const skipped: SkippedFileResult[] = [];
    const built: Built[] = [];
    if (selected.length === 0)
      return {
        manifest: { v: 1, id, kind: input.kind, createdAt: now.toISOString(), entries: [] },
        applied: [],
        skipped,
        dir,
      };
    const dirs = openRunDirs(dir, id, { createArchive: true, createBackup: true });
    const lease = input.lease ?? makeLeasePayload(0, [id]);
    const ownsLease = input.lease === undefined;
    if (ownsLease && !leaseCreate(dir, lease)) throw new MemoryError("memory directory already has an active tidy run");
    try {
      let nextSeq = 1;
      for (const file of selected) {
        try {
          const item = buildOne(dirs, id, file, nextSeq, input.originalSha, now.toISOString());
          built.push(item);
          nextSeq += item.operations.length;
        } catch (err) {
          skipped.push({ name: file.name, reason: (err as Error).message });
        }
      }
      if (built.length === 0)
        return {
          manifest: { v: 1, id, kind: input.kind, createdAt: now.toISOString(), entries: [] },
          applied: [],
          skipped,
          dir,
        };
      probeHardlinks(dirs, { epoch: lease.epoch });
      const contents = new Map<string, Buffer | string>();
      for (const b of built) for (const [k, v] of b.content) contents.set(k, v);
      const operations: TxnOperation[] = built.flatMap((b) => b.operations);
      const deadline = Date.now() + 30_000;
      let outcome = runStep({
        dirs,
        id,
        kind: input.kind,
        phase: input.kind === "frontmatter" ? "frontmatter" : "normalize",
        ops: operations,
        contents,
        probe: false,
        epoch: lease.epoch,
        owner: {
          pid: lease.pid,
          host: lease.host,
          token: lease.token,
          at: lease.at,
          ...(lease.startTicks === undefined ? {} : { startTicks: String(lease.startTicks) }),
          ...(lease.bootId === undefined ? {} : { bootId: lease.bootId }),
        },
      });
      // Deliberately keep the directory lock across continuation blocks. The
      // executor's 2s/20-op boundary is a journal boundary, not an async
      // yield: releasing here would let a legacy writer change a location
      // between CAS and the next block. M-T4 epoch checks protect revocation,
      // while the lease prevents another tidy/restore owner from entering.
      while (outcome.state === "applying" && outcome.results.length < operations.length && Date.now() < deadline) {
        outcome = runStep({
          dirs,
          id,
          kind: input.kind,
          phase: input.kind === "frontmatter" ? "frontmatter" : "normalize",
          ops: operations,
          contents,
          probe: false,
          epoch: lease.epoch,
          owner: {
            pid: lease.pid,
            host: lease.host,
            token: lease.token,
            at: lease.at,
            ...(lease.startTicks === undefined ? {} : { startTicks: String(lease.startTicks) }),
            ...(lease.bootId === undefined ? {} : { bootId: lease.bootId }),
          },
        });
      }
      const byId = new Map(outcome.results.map((r) => [r.opId, r]));
      const applied: AppliedFileResult[] = [];
      let opCursor = 0;
      for (const b of built) {
        const groupResults = b.operations.map((operation) => byId.get(`${id}-op-${operation.seq ?? ++opCursor}`));
        opCursor += b.operations.length;
        if (groupResults.length > 0 && groupResults.every((result) => result?.state === "done"))
          applied.push({ name: b.entry.name, op: b.entry.op });
        else
          skipped.push({
            name: b.entry.name,
            reason:
              groupResults.find((result) => result?.reason)?.reason ??
              (outcome.state === "applying" ? "transaction deadline exceeded" : "transaction conflict"),
          });
      }
      // Keep the old flat backup names as compatibility aliases for the
      // pre-batch restore/listing API. The journal's canonical names remain
      // collision-safe `s<step>-<seq>-...` locations.
      for (const b of built) {
        const backupFile = b.entry.backupFile;
        if (!backupFile) continue;
        try {
          const source = readRegular(dirs.backup.path, backupFile).text;
          if (statRegularIfExists(dirs.backup.path, b.entry.name) === undefined) {
            const tmp = writeTempRegular(dirs.backup.path, b.entry.name, Buffer.from(source, "utf8"), 0o600);
            createExclusive(dirs.backup.path, tmp, b.entry.name);
          }
        } catch {
          /* canonical journal backup is still authoritative */
        }
      }
      try {
        pruneBackups(dir);
      } catch {
        /* retention is best effort */
      }
      // Return the compatibility projection. The v2 journal remains on disk.
      const legacy: TidyManifest = {
        v: 1,
        id,
        kind: input.kind,
        createdAt: now.toISOString(),
        entries: applied
          .map((a) => built.find((b) => b.entry.name === a.name)?.entry)
          .filter((e): e is TidyManifestEntry => e !== undefined),
      };
      return { manifest: legacy, applied, skipped, dir };
    } finally {
      if (ownsLease) leaseRelease(dir, lease.token);
    }
  });
}
