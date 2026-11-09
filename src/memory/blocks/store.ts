import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import {
  createExclusive,
  ensurePrivateDir,
  fsyncDir,
  inspectDirNoFollow,
  listDirNames,
  listRegular,
  readRegular,
  renameNoClobber,
  replaceAtomic,
  statRegularIfExists,
  writeTempRegular,
} from "../safe-fs.js";
import { MemoryError } from "../paths.js";
import { recordSoftMeta, softLegacyMetadata } from "../soft-meta.js";
import { listTrashEntries, newTidyId } from "../tidy/manifest.js";
import { withMemoryDirLock } from "../lock.js";
import type { MemoryWriteGate } from "../contracts.js";
import type { JevIndexV1 } from "../jev/contracts.js";
import { entryHash } from "../jev/entries.js";
import { parseBlockFile, serializeBlock, type BlockMeta, type ParsedBlock } from "./format.js";
import { dirFormat, nextSeq, canonicalTopic, parseBlockName } from "./naming.js";
import { readMarker, type BlocksMarkerV1 } from "./marker.js";
export interface LegacyFingerprint {
  files: readonly { name: string; sha256: string }[];
}
export interface BlockCorpus {
  blocks: readonly ParsedBlock[];
  strays: readonly string[];
  archivedByTopic: ReadonlyMap<string, number>;
  marker: BlocksMarkerV1 | undefined;
  legacy: LegacyFingerprint;
  fingerprint: string;
}
export interface CorpusReaderState {
  previous?: BlockCorpus;
  warned: boolean;
  warn?: (message: string) => void;
}
export interface StoreWriteOptions {
  gate?: MemoryWriteGate;
}
function emptyCorpus(): BlockCorpus {
  return {
    blocks: [],
    strays: [],
    archivedByTopic: new Map(),
    marker: undefined,
    legacy: { files: [] },
    fingerprint: "",
  };
}
function fixedDirectory(realDir: string): { dev: number; ino: number; mtimeMs: number; names: string[] } {
  const st = inspectDirNoFollow(realDir),
    parent = inspectDirNoFollow(dirname(realDir));
  if (st.dev !== parent.dev) throw new MemoryError("E_UNMIGRATED: blocks directory is on another device");
  return st;
}
function verify(realDir: string, before: { dev: number; ino: number }): void {
  const after = inspectDirNoFollow(realDir);
  if (before.dev !== after.dev || before.ino !== after.ino)
    throw new MemoryError("E_UNMIGRATED: blocks directory changed");
}
export function readCorpus(
  realDir: string,
  state?: CorpusReaderState,
  hooks?: { afterRead?: (name: string) => void },
): BlockCorpus {
  try {
    // Resolve the layout exactly once, never substitute the legacy root mid-read.
    if (dirFormat(dirname(realDir)) !== "blocks") throw new MemoryError("E_UNMIGRATED");
    const identity = fixedDirectory(realDir);
    const blocks: ParsedBlock[] = [],
      strays: string[] = [];
    const listing = listRegular(realDir, { names: "legacy" });
    if (listing.files.length + listing.skipped.length !== identity.names.filter((name) => name.endsWith(".md")).length)
      throw new MemoryError("E_UNMIGRATED: directory enumeration changed");
    const stamps: unknown[] = [];
    for (const file of listing.files.sort((a, b) => a.name.localeCompare(b.name))) {
      const stat = statRegularIfExists(realDir, file.name);
      if (!stat) throw new MemoryError("E_UNMIGRATED: file disappeared");
      stamps.push([file.name, stat.size, stat.mtimeMs, stat.ino]);
      const b = parseBlockFile(file.name, readRegular(realDir, file.name).text, {
        softLimits: true,
        onSoftLimit: (field, value) => recordSoftMeta(dirname(realDir), field, value),
      });
      if ("stray" in b || !parseBlockName(file.name)) strays.push(file.name);
      else blocks.push(b);
      hooks?.afterRead?.(file.name);
      verify(realDir, identity);
    }
    for (const file of listing.skipped) strays.push(file.name);
    const archivedByTopic = new Map<string, number>();
    const archive = join(realDir, "archive");
    if (listDirNames(realDir).includes("archive")) {
      const ast = inspectDirNoFollow(archive);
      if (ast.dev !== identity.dev) throw new MemoryError("E_UNMIGRATED: archive device changed");
      for (const file of listRegular(archive, { names: "v2" }).files) {
        const b = parseBlockFile(file.name, readRegular(archive, file.name).text);
        if (!("stray" in b)) archivedByTopic.set(b.topic, (archivedByTopic.get(b.topic) ?? 0) + 1);
      }
      verify(archive, ast);
    }
    const legacy: LegacyFingerprint = {
      files: listRegular(dirname(realDir), { names: "v2" })
        .files.sort((a, b) => a.name.localeCompare(b.name))
        .map((f) => {
          const raw = readRegular(dirname(realDir), f.name).text;
          softLegacyMetadata(raw, dirname(realDir));
          return { name: f.name, sha256: createHash("sha256").update(raw).digest("hex") };
        }),
    };
    const result: BlockCorpus = {
      blocks,
      strays,
      archivedByTopic,
      legacy,
      marker: readMarker(realDir),
      fingerprint: createHash("sha1").update(JSON.stringify(stamps)).digest("hex"),
    };
    verify(realDir, identity);
    if (state) state.previous = result;
    return result;
  } catch (err) {
    if (state && !state.warned) {
      state.warned = true;
      state.warn?.("memory: blocks/ changed during read (rollback or migration in progress) — using previous result");
    }
    return state?.previous ?? emptyCorpus();
  }
}
function checkWrite(realDir: string, opts: StoreWriteOptions): void {
  if (opts.gate && !opts.gate.check(dirname(realDir)).ok) throw new MemoryError("E_WRITE_GATE: memory write refused");
  fixedDirectory(realDir);
}
function parsed(name: string, raw: string): ParsedBlock {
  const block = parseBlockFile(name, raw);
  if ("stray" in block) throw new MemoryError("E_BLOCK: not a block");
  return block;
}
export function createBlockLocked(
  realDir: string,
  topic: string,
  meta: Omit<BlockMeta, "created" | "updated" | "version" | "status" | "kind">,
  body: string,
  now: Date,
  opts: StoreWriteOptions = {},
): ParsedBlock {
  checkWrite(realDir, opts);
  if (canonicalTopic(topic) !== topic) throw new MemoryError("E_TOPIC: invalid topic");
  const used = [
    ...listDirNames(realDir),
    ...listDirNames(join(realDir, "archive")),
    ...listDirNames(join(realDir, ".trash")),
  ];
  const name = `${topic}.${String(nextSeq(topic, used)).padStart(3, "0")}.md`;
  const raw = serializeBlock(
    { ...meta, kind: "block", status: "active", version: 1, created: now.toISOString(), updated: now.toISOString() },
    body,
  );
  checkWrite(realDir, opts);
  const tmp = writeTempRegular(realDir, name, Buffer.from(raw), 0o600);
  checkWrite(realDir, opts);
  createExclusive(realDir, tmp, name);
  checkWrite(realDir, opts);
  fsyncDir(realDir);
  return parsed(name, raw);
}
export function replaceBlockLocked(
  realDir: string,
  id: string,
  expectRev: string,
  next: { meta: BlockMeta; body: string },
  now: Date,
  opts: StoreWriteOptions = {},
): ParsedBlock {
  checkWrite(realDir, opts);
  if (!parseBlockName(`${id}.md`)) throw new MemoryError("E_BLOCK: invalid id");
  if (!expectRev) throw new MemoryError("E_REV_REQUIRED");
  const name = `${id}.md`,
    current = parsed(name, readRegular(realDir, name).text);
  if (current.rev !== expectRev) throw new MemoryError(`E_CONFLICT: current rev ${current.rev}\n${current.body}`);
  // A strict parser drops invalid scalar fields; never silently erase historical metadata on edit.
  const invalidMeta = current.errors.find(
    (error) => /^invalid (until|section|heading|title|when)$/.test(error) || error === "E_SECTION_TOO_LARGE",
  );
  if (invalidMeta)
    throw new MemoryError(
      invalidMeta === "E_SECTION_TOO_LARGE"
        ? "E_SECTION_TOO_LARGE: section exceeds 80 UTF-8 bytes"
        : `E_META: ${invalidMeta}`,
    );
  const meta: BlockMeta = {
    ...next.meta,
    kind: "block",
    created: current.meta.created,
    updated: now.toISOString(),
    version: current.meta.version + 1,
  };
  delete meta.heading;
  delete meta.residue;
  delete meta.origin;
  if (current.meta.heading !== undefined) meta.heading = current.meta.heading;
  const raw = serializeBlock(meta, next.body);
  checkWrite(realDir, opts);
  const tmp = writeTempRegular(realDir, name, Buffer.from(raw), 0o600);
  checkWrite(realDir, opts);
  const latest = parsed(name, readRegular(realDir, name).text);
  if (latest.rev !== expectRev) throw new MemoryError(`E_CONFLICT: current rev ${latest.rev}\n${latest.body}`);
  replaceAtomic(realDir, tmp, name);
  checkWrite(realDir, opts);
  fsyncDir(realDir);
  return parsed(name, raw);
}
export function trashBlockLocked(
  realDir: string,
  name: string,
  expectRev?: string,
  opts: StoreWriteOptions = {},
): { trashName: string } {
  checkWrite(realDir, opts);
  if (!parseBlockName(name)) throw new MemoryError("E_BLOCK: invalid name");
  const current = parsed(name, readRegular(realDir, name).text);
  if (expectRev !== undefined && current.rev !== expectRev)
    throw new MemoryError(`E_CONFLICT: current rev ${current.rev}\n${current.body}`);
  const trashName = `${newTidyId(new Date(), process.pid, randomBytes(3).toString("hex"))}-${name}`;
  checkWrite(realDir, opts);
  ensurePrivateDir(join(realDir, ".trash"));
  const trash = inspectDirNoFollow(join(realDir, ".trash"));
  if (trash.dev !== inspectDirNoFollow(realDir).dev) throw new MemoryError("E_WRITE_GATE: trash device changed");
  checkWrite(realDir, opts);
  const latest = parsed(name, readRegular(realDir, name).text);
  if (expectRev !== undefined && latest.rev !== expectRev)
    throw new MemoryError(`E_CONFLICT: current rev ${latest.rev}\n${latest.body}`);
  renameNoClobber(realDir, name, `.trash/${trashName}`);
  checkWrite(realDir, opts);
  fsyncDir(realDir);
  checkWrite(realDir, opts);
  fsyncDir(join(realDir, ".trash"));
  return { trashName };
}
/** Restore a deleted project block using the same root lock and no-clobber
 * primitives as deletion. The revision is over the original bytes and is not bumped. */
export async function restoreTrashedBlock(memDir: string, id: string, opts: StoreWriteOptions = {}): Promise<string> {
  if (opts.gate && !opts.gate.check(memDir).ok) throw new MemoryError("E_WRITE_GATE: memory write refused");
  return withMemoryDirLock(memDir, () => {
    const realDir = join(memDir, "blocks");
    const check = () => {
      if (dirFormat(memDir) !== "blocks") throw new MemoryError("E_UNMIGRATED: blocks layout required");
      checkWrite(realDir, opts);
    };
    check();
    const trashDir = join(realDir, ".trash");
    const trash = inspectDirNoFollow(trashDir);
    if (trash.dev !== inspectDirNoFollow(realDir).dev) throw new MemoryError("E_WRITE_GATE: trash device changed");
    const entry = listTrashEntries(realDir).find((candidate) => candidate.id === id);
    if (!entry || !parseBlockName(entry.name)) throw new MemoryError(`no trash entry ${id}`);
    const before = parsed(entry.name, readRegular(trashDir, entry.fileName).text);
    if (before.meta.storageScope === "hub") throw new MemoryError("E_BLOCK: invalid project trash block");
    if (statRegularIfExists(realDir, entry.name))
      throw new MemoryError(`restore conflict: ${entry.name} already exists`);
    check();
    const latest = parsed(entry.name, readRegular(trashDir, entry.fileName).text);
    if (latest.rev !== before.rev) throw new MemoryError("E_CONFLICT: trash block changed");
    renameNoClobber(realDir, `.trash/${entry.fileName}`, entry.name);
    check();
    fsyncDir(realDir);
    check();
    fsyncDir(trashDir);
    return entry.name;
  });
}
export function topicSummary(corpus: BlockCorpus, index: JevIndexV1 | undefined, topic: string): string {
  const blocks = corpus.blocks.filter((b) => b.topic === topic && b.meta.status === "active");
  const counts = new Map<string, number>(),
    sections = new Map<string, number>();
  for (const b of blocks) {
    const tags = new Set([
      ...Object.entries(index?.entries[entryHash(b.body)]?.tags ?? {})
        .filter(([, v]) => v.p >= 0.5)
        .map(([t]) => t),
      ...(b.meta.tags?.add ?? []),
    ]);
    for (const tag of b.meta.tags?.remove ?? []) tags.delete(tag);
    for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    if (b.meta.section) sections.set(b.meta.section, (sections.get(b.meta.section) ?? 0) + 1);
  }
  const top = (map: Map<string, number>): string[] =>
    [...map]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([s]) => s);
  if (counts.size) return `tags: ${top(counts).join(", ")}`;
  if (sections.size)
    return `sections: ${top(sections)
      .map((s) => {
        while (Buffer.byteLength(s) > 24) s = [...s].slice(0, -1).join("");
        return s;
      })
      .join(", ")}`;
  return "";
}
