/** #39 P3c host-only management. No tool/wire DTO, no repair/import, no timers.
 * Every mutation is scheduled by the provider's SAME bounded FIFO + directory lock.
 * prepare only reads; opaque tokens bind owner, slot, directory metadata and exact file
 * bytes/inodes. commit removes the token BEFORE any await (including failures/abort).
 *
 * trash-provenance.json indexes unique blocks/.trash filenames, never logical ids.
 * 512 lifetime records / 1 MiB: saturation refuses deletes, never evicts a live or
 * unfinished record. Old provenance is audit HISTORY only; restore grants are fresh.
 * Multi-file failures are UNKNOWN, not retried/repaired. Pending archives and stale
 * live sidecars make ordinary reads inert. File uid is NOT exposed by safe-fs: this
 * package proves directory uid and file nofollow/mode/devino/bytes, not file uid.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { MemoryError } from "../paths.js";
import { readCorpus } from "../blocks/store.js";
import { parseBlockFile, type ParsedBlock } from "../blocks/format.js";
import { listDirNames, renameNoClobber, fsyncDir } from "../safe-fs.js";
import { newTidyId } from "../tidy/manifest.js";
import {
  checkHubSlot,
  dirSecurityMatches,
  hubMemoryRoot,
  parseHubNamespace,
  type HubSlotRef,
  type HubNamespaceV1,
  type HubDirIdentity,
} from "./hub-slot.js";
import {
  asCode,
  blockToItem,
  capacityCheck,
  commitHubUserCommandLocked,
  hubHostFingerprint,
  parseHubItemsFile,
  parseProvenanceEntry,
  readHubCorpus,
  sameHubOwner,
  writeProvenanceAndAuditLocked,
  type HubCommitContext,
  type HubProvenanceEntry,
  type HubStoreIo,
} from "./hub-store.js";
import {
  bodyTextDigest,
  canonicalJson,
  isHubMemoryId,
  readUntrustedValue,
  utf8Bytes,
  type RawValue,
} from "./limits.js";
import type {
  FrozenScopedOp,
  HubItem,
  HubMemorySource,
  HubMemoryView,
  MemoryOwner,
  ScopedMemoryErrorCode,
  ScopedMemoryWriteResult,
} from "./types.js";

export const HUB_ARCHIVE_MAX_ENTRIES = 512;
export const HUB_ARCHIVE_MAX_BYTES = 1024 * 1024;
export const HUB_ARCHIVE_FILE = "trash-provenance.json";
const TRASH = /^(\d{8}T\d{9}Z-\d+-[0-9a-f]{6})-([a-z0-9-]{1,48}\.\d{3})\.md$/;
interface ArchiveEntry {
  readonly id: string;
  readonly digest: string;
  readonly provenance: HubProvenanceEntry;
  readonly state: "trashed" | "restored";
}
type Archive = Record<string, ArchiveEntry>;
const fail = (code: ScopedMemoryErrorCode): ScopedMemoryWriteResult => ({ ok: false, code });
const error = (code: ScopedMemoryErrorCode, detail = ""): never => {
  throw new MemoryError(`${code}: ${detail}`);
};

function readPrivate(io: HubStoreIo, path: string): string {
  const st = io.statFile(path);
  if (!st || st === "not-file" || (st.mode & 0o777) !== 0o600) return error("E_NAMESPACE", "unsafe file");
  const bytes = io.readUtf8File(path);
  const after = io.statFile(path);
  if (!after || after === "not-file" || after.dev !== st.dev || after.ino !== st.ino || after.mode !== st.mode)
    return error("E_NAMESPACE", "file changed");
  return bytes;
}

function readArchive(ctx: HubCommitContext): Archive {
  const path = join(hubMemoryRoot(ctx.slot), HUB_ARCHIVE_FILE);
  if (ctx.io.statFile(path) === undefined) return {};
  const text = readPrivate(ctx.io, path);
  if (utf8Bytes(text) > HUB_ARCHIVE_MAX_BYTES) return error("E_NAMESPACE", "archive bytes");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return error("E_NAMESPACE", "archive corrupt");
  }
  const shape = readUntrustedValue(data);
  if (!shape.ok || !shape.value || typeof shape.value !== "object" || Array.isArray(shape.value))
    return error("E_NAMESPACE", "archive shape");
  const record = shape.value as Record<string, RawValue>;
  if (
    record.v !== 1 ||
    Object.keys(record).length !== 2 ||
    !record.entries ||
    typeof record.entries !== "object" ||
    Array.isArray(record.entries)
  )
    return error("E_NAMESPACE", "archive schema");
  const entries = record.entries as Record<string, RawValue>;
  if (Object.keys(entries).length > HUB_ARCHIVE_MAX_ENTRIES) return error("E_NAMESPACE", "archive full");
  const out: Archive = {};
  for (const [name, value] of Object.entries(entries)) {
    const match = TRASH.exec(name);
    if (!match || !value || typeof value !== "object" || Array.isArray(value))
      return error("E_NAMESPACE", "archive key");
    const entry = value as Record<string, RawValue>;
    const provenance = parseProvenanceEntry(entry.provenance ?? null);
    if (
      Object.keys(entry).length !== 4 ||
      entry.id !== match[2] ||
      !provenance ||
      typeof entry.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.digest) ||
      (entry.state !== "trashed" && entry.state !== "restored")
    )
      return error("E_NAMESPACE", "archive entry");
    out[name] = { id: match[2]!, digest: entry.digest, provenance, state: entry.state };
  }
  return out;
}
function writeArchive(ctx: HubCommitContext, entries: Archive): void {
  const bytes = `${JSON.stringify({ v: 1, entries })}\n`;
  if (Object.keys(entries).length > HUB_ARCHIVE_MAX_ENTRIES || utf8Bytes(bytes) > HUB_ARCHIVE_MAX_BYTES)
    return error("E_FULL", "archive bound (no eviction)");
  ctx.io.writePrivateFile(hubMemoryRoot(ctx.slot), HUB_ARCHIVE_FILE, bytes);
}
function trashDir(ctx: HubCommitContext, allowAbsent = false): void {
  const blocks = ctx.io.inspectDir(join(hubMemoryRoot(ctx.slot), "blocks"));
  const st = ctx.io.inspectDir(join(hubMemoryRoot(ctx.slot), "blocks", ".trash"));
  if (allowAbsent && st === undefined) return;
  if (
    !st ||
    st === "not-dir" ||
    !blocks ||
    blocks === "not-dir" ||
    !dirSecurityMatches(st, ctx.slot.uid) ||
    st.dev !== blocks.dev
  )
    error("E_NAMESPACE", "trash security");
}
function blockAt(ctx: HubCommitContext, dir: string, name: string, id: string): ParsedBlock {
  const raw = readPrivate(ctx.io, join(dir, name));
  const b = parseBlockFile(`${id}.md`, raw);
  if (
    "stray" in b ||
    b.errors.length ||
    b.meta.storageScope !== "hub" ||
    b.meta.authority !== "user" ||
    b.meta.status !== "active" ||
    !isHubMemoryId(b.id)
  )
    return error("E_NAMESPACE", "invalid hub block");
  return b;
}
/** Validate archived history even on ordinary reads. Missing legacy provenance is UNKNOWN,
 * not an invented grant; unindexed legacy trash can be listed but cannot be restored. */
export function validateHubArchive(ctx: HubCommitContext): void {
  trashDir(ctx, true);
  const entries = readArchive(ctx);
  for (const [name, e] of Object.entries(entries)) {
    if (e.state === "restored") continue;
    const b = blockAt(ctx, join(hubMemoryRoot(ctx.slot), "blocks", ".trash"), name, e.id);
    if (b.rev !== e.provenance.rev || b.meta.updated !== e.provenance.updated || bodyTextDigest(b.body) !== e.digest)
      error("E_NAMESPACE", "archive source mismatch");
  }
}
/** Delete's archive is durable BEFORE moving the original. Its name is chosen here,
 * since the generic trashBlockLocked exposes its random name only AFTER destruction. */
export function archiveHubDeleteLocked(
  ctx: HubCommitContext,
  id: string,
  rev: string,
  provenance: HubProvenanceEntry,
  recheck: () => void,
): void {
  const root = hubMemoryRoot(ctx.slot),
    blocks = join(root, "blocks");
  const b = blockAt(ctx, blocks, `${id}.md`, id);
  if (b.rev !== rev || b.rev !== provenance.rev || b.meta.updated !== provenance.updated) error("E_CONFLICT");
  const entries = readArchive(ctx);
  if (Object.keys(entries).length >= HUB_ARCHIVE_MAX_ENTRIES) error("E_FULL", "archive bound (no eviction)");
  const name = `${newTidyId(ctx.now, process.pid, randomBytes(3).toString("hex"))}-${id}.md`;
  entries[name] = { id, digest: bodyTextDigest(b.body), provenance, state: "trashed" };
  // Preflight bounded serialization before even creating .trash.
  if (utf8Bytes(JSON.stringify({ v: 1, entries })) > HUB_ARCHIVE_MAX_BYTES) error("E_FULL");
  recheck();
  ctx.io.ensureDir(join(blocks, ".trash"));
  trashDir(ctx);
  const before = snapshot(ctx, true);
  recheck();
  if (before !== snapshot(ctx, true)) error("E_NAMESPACE");
  let archiveAttempted = false;
  try {
    archiveAttempted = true;
    writeArchive(ctx, entries);
    // Failure here leaves a detectable incomplete archive; never silently use the old slot.
    recheck();
    trashDir(ctx);
    if (before !== snapshot(ctx, true)) error("E_NAMESPACE", "delete CAS changed");
    const current = blockAt(ctx, blocks, `${id}.md`, id);
    if (current.raw !== b.raw || current.rev !== rev) error("E_CONFLICT");
    renameNoClobber(blocks, `${id}.md`, `.trash/${name}`);
    fsyncDir(blocks);
    fsyncDir(join(blocks, ".trash"));
  } catch (err) {
    if (archiveAttempted) error("E_PERSIST_UNKNOWN");
    throw err;
  }
}

/** Strict complete corpus: generic readCorpus catches read errors into an empty corpus,
 * so marker + exact physical listing + raw reads are mandatory, never trust fallback. */
export function completeHubCorpus(ctx: HubCommitContext): {
  blocks: readonly ParsedBlock[];
  provenance: Map<string, HubProvenanceEntry>;
  items: HubItem[];
} {
  const root = hubMemoryRoot(ctx.slot),
    dir = join(root, "blocks");
  const corpus = readCorpus(dir);
  const names = listDirNames(dir).filter((n) => n.endsWith(".md"));
  if (
    !corpus.marker ||
    corpus.strays.length ||
    names.length !== corpus.blocks.length ||
    listDirNames(dir).includes("archive")
  )
    return error("E_NAMESPACE", "incomplete corpus");
  readPrivate(ctx.io, join(dir, ".layout.json"));
  const file = parseHubItemsFile(readPrivate(ctx.io, join(root, "items.json")));
  if (!file || file.items.size !== names.length) return error("E_NAMESPACE", "incomplete provenance");
  const items: HubItem[] = [];
  for (const block of corpus.blocks) {
    const b = blockAt(ctx, dir, `${block.id}.md`, block.id);
    const p = file.items.get(b.id);
    const item = p && blockToItem(b, p);
    if (!item) return error("E_NAMESPACE", "stale provenance");
    items.push(item);
  }
  if (
    items.length > 32 ||
    items.reduce((n, i) => n + utf8Bytes(i.text), 0) > 4096 ||
    items.some((i) => utf8Bytes(i.text) > 1024)
  )
    return error("E_NAMESPACE", "corpus capacity");
  validateHubArchive(ctx);
  return { blocks: corpus.blocks, provenance: new Map(file.items), items };
}
/** Exact confirmation CAS: paths, uid/mode/devino of every directory, file
 * nofollow/mode/devino AND all namespace/marker/live/trash/sidecar bytes. */
function snapshot(ctx: HubCommitContext, omitArchive = false): string {
  const root = hubMemoryRoot(ctx.slot),
    blocks = join(root, "blocks"),
    trash = join(blocks, ".trash");
  const dirs: unknown[] = [];
  for (const path of [ctx.slot.effectiveStateDir, root, blocks, trash]) {
    const st = ctx.io.inspectDir(path);
    if (path === trash && st === undefined) {
      dirs.push([path, null]);
      continue;
    }
    if (!st || st === "not-dir" || !dirSecurityMatches(st, ctx.slot.uid, path !== ctx.slot.effectiveStateDir))
      return error("E_NAMESPACE", "directory security");
    dirs.push([path, st]);
  }
  const files: unknown[] = [];
  const paths = [
    join(root, "namespace.json"),
    join(root, "items.json"),
    ...(omitArchive ? [] : [join(root, HUB_ARCHIVE_FILE)]),
    join(blocks, ".layout.json"),
    ...listDirNames(blocks)
      .filter((n) => n.endsWith(".md"))
      .sort()
      .map((n) => join(blocks, n)),
    ...(ctx.io.inspectDir(trash) === undefined
      ? []
      : listDirNames(trash)
          .sort()
          .map((n) => join(trash, n))),
  ];
  for (const path of paths) {
    const st = ctx.io.statFile(path);
    if (st === undefined) {
      files.push([path, null]);
      continue;
    }
    files.push([path, st, readPrivate(ctx.io, path)]);
  }
  return canonicalJson({ slot: ctx.slot, real: ctx.io.realpath(ctx.slot.effectiveStateDir), dirs, files });
}

declare const tokenBrand: unique symbol;
export interface HubManagementToken {
  readonly [tokenBrand]: true;
}
type Failure = { readonly ok: false; readonly code: ScopedMemoryErrorCode; readonly reason?: string };
/** Local host presentation DTO, built from the token-bound prepare observation.
 * Full bodies are never truncated. No grant id is minted for presentation. */
export interface HubConfirmationItem {
  readonly id: string;
  readonly text: string;
  readonly rev: string;
  readonly updated: string;
  readonly source: HubMemorySource;
  readonly grant: HubProvenanceEntry["grant"];
  readonly from?: string;
}
interface HubConfirmationBase {
  readonly target: { readonly effectiveStateDir: string; readonly hubRoot: string; readonly uid: number };
  /** Original P3c fields remain available to existing host consumers. */
  readonly id?: string;
  readonly text?: string;
  readonly oldSource?: HubMemorySource;
  readonly oldGrant?: HubProvenanceEntry["grant"];
  readonly warning: string;
}
export type HubConfirmation = HubConfirmationBase &
  (
    | {
        readonly kind: "restore";
        readonly trashFileName: string;
        readonly id: string;
        readonly text: string;
        readonly rev: string;
        readonly updated: string;
        readonly oldSource: HubMemorySource;
        readonly oldGrant: HubProvenanceEntry["grant"];
        readonly oldFrom?: string;
        readonly newSource: HubMemorySource;
        readonly newAuthorization: { readonly via: "command"; readonly by: "user"; readonly issued: "on-commit" };
      }
    | {
        readonly kind: "adopt";
        readonly items: readonly HubConfirmationItem[];
        readonly namespace: {
          readonly current: HubNamespaceV1;
          readonly reseal: HubNamespaceV1;
          readonly changedFields: readonly (keyof HubNamespaceV1)[];
        };
      }
  );
export type HubPrepared =
  | Failure
  | {
      readonly ok: true;
      readonly token: HubManagementToken;
      readonly confirmation: HubConfirmation;
    };

/** Only called on newly constructed, acyclic, host-owned plain presentation data. */
function freezeConfirmation<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeConfirmation(child);
    Object.freeze(value);
  }
  return value;
}

export interface HubManagementPort {
  status(): HubMemoryView;
  inspect(id: string): Failure | { readonly ok: true; readonly item: HubItem; readonly rev: string };
  listTrash(): readonly {
    readonly fileName: string;
    readonly id: string;
    readonly provenance: "known" | "unknown" | "restored";
  }[];
  command(
    operation: FrozenScopedOp & { readonly storageScope: "hub" },
    signal?: AbortSignal,
  ): Promise<ScopedMemoryWriteResult>;
  prepareAdopt(signal?: AbortSignal): HubPrepared;
  prepareRestore(trashFileName: string, signal?: AbortSignal): HubPrepared;
  commit(token: HubManagementToken): Promise<ScopedMemoryWriteResult>;
  cancel(token: HubManagementToken): void;
  dispose(): void;
}
export interface HubManagementHost {
  readonly io: HubStoreIo;
  readonly slot: () => HubSlotRef;
  readonly owner: () => MemoryOwner;
  readonly now: () => Date;
  readonly source?: () => HubMemorySource;
  readonly available: () => boolean;
  readonly trustedCommand: () => boolean;
  readonly schedule: (
    owner: MemoryOwner,
    signal: AbortSignal | undefined,
    allowInert: boolean,
    body: (ctx: HubCommitContext, recheck: () => void) => ScopedMemoryWriteResult,
    validate?: () => void,
  ) => Promise<ScopedMemoryWriteResult>;
}
interface PreparedRecord {
  cancelled?: boolean;
  readonly kind: "adopt" | "restore";
  readonly slot: HubSlotRef;
  readonly owner: MemoryOwner;
  readonly snapshot: string;
  readonly source: HubMemorySource;
  readonly signal?: AbortSignal;
  readonly trashName?: string;
  readonly reseal?: HubNamespaceV1;
}

export function createHubManagement(host: HubManagementHost): HubManagementPort {
  const tokens = new Map<HubManagementToken, PreparedRecord>();
  const scheduled = new Map<HubManagementToken, PreparedRecord>();
  let disposed = false;
  const guard = (owner?: MemoryOwner, signal?: AbortSignal) => {
    if (disposed || (owner && !sameHubOwner(owner, host.owner()))) error("E_STALE_SESSION");
    if (signal?.aborted) error("E_HUB_CAP_STALE");
    if (!host.available()) error("E_SCOPE_DISABLED");
    if (!host.trustedCommand()) error("E_AUTHORITY");
  };
  const context = (): HubCommitContext => ({
    slot: { ...host.slot() },
    io: host.io,
    now: host.now(),
    expectedHost: hubHostFingerprint(),
  });
  const source = (): HubMemorySource => {
    const src = host.source?.() ?? { project: "", label: "", sid8: host.owner().sid.slice(0, 8) };
    const shape = readUntrustedValue({
      grant: { via: "command", by: "user" },
      src,
      updated: host.now().toISOString(),
      rev: "1-000000",
    });
    const p = shape.ok ? parseProvenanceEntry(shape.value) : undefined;
    if (!p) return error("E_META_INVALID", "command source");
    return Object.freeze(p.src);
  };
  const restoredProvenance = (b: ParsedBlock, src: HubMemorySource, cap: string): HubProvenanceEntry => ({
    grant: { via: "command", by: "user", cap },
    src,
    updated: b.meta.updated,
    rev: b.rev,
  });
  const restoreCapacity = (b: ParsedBlock, src: HubMemorySource, items: readonly HubItem[]) => {
    capacityCheck(items, undefined, b.body);
    if (!blockToItem(b, restoredProvenance(b, src, "00000000"))) error("E_META_INVALID", "restored metadata budget");
  };
  const prepare = (kind: "adopt" | "restore", name?: string, signal?: AbortSignal): HubPrepared => {
    try {
      guard(undefined, signal);
      if (tokens.size >= 16) return { ok: false, code: "E_BUSY" };
      const ctx = context(),
        owner = { ...host.owner() },
        src = source();
      const frozen = snapshot(ctx);
      // Reuse the exact namespace bytes and directory identities already captured for
      // token CAS, rather than performing a separate presentation read of the target.
      const captured = JSON.parse(frozen) as {
        real: string | undefined;
        dirs: readonly (readonly [string, HubDirIdentity | null])[];
        files: readonly (readonly [string, unknown, string?])[];
      };
      const namespaceBytes = captured.files.find(
        ([path]) => path === join(hubMemoryRoot(ctx.slot), "namespace.json"),
      )?.[2];
      const ns = namespaceBytes === undefined ? undefined : parseHubNamespace(namespaceBytes);
      const stateIdentity = captured.dirs.find(([path]) => path === ctx.slot.effectiveStateDir)?.[1];
      if (!ns || !stateIdentity || !captured.real) return { ok: false, code: "E_NAMESPACE" };
      const corpus = completeHubCorpus(ctx);
      let b: ParsedBlock | undefined, p: HubProvenanceEntry | undefined;
      if (kind === "restore") {
        if (!name || !TRASH.test(name)) return { ok: false, code: "E_META_INVALID" };
        if (checkHubSlot(ctx.slot, { io: ctx.io, expectedHost: hubHostFingerprint() }) !== "ok")
          return { ok: false, code: "E_NAMESPACE" };
        const e = readArchive(ctx)[name];
        if (!e)
          return {
            ok: false,
            code: "E_AUTHORITY",
            reason: "unknown legacy provenance; ordinary restore refused (not imported as new content)",
          };
        if (e.state !== "trashed") return { ok: false, code: "E_CONFLICT" };
        b = blockAt(ctx, join(hubMemoryRoot(ctx.slot), "blocks", ".trash"), name, e.id);
        p = e.provenance;
        if (ctx.io.statFile(join(hubMemoryRoot(ctx.slot), "blocks", `${e.id}.md`)) !== undefined)
          return { ok: false, code: "E_CONFLICT" };
        restoreCapacity(b, src, corpus.items);
      }
      guard(owner, signal);
      if (frozen !== snapshot(ctx)) return { ok: false, code: "E_CONFLICT" };
      const target = {
        effectiveStateDir: ctx.slot.effectiveStateDir,
        hubRoot: hubMemoryRoot(ctx.slot),
        uid: ctx.slot.uid,
      };
      let summary: HubConfirmation;
      if (kind === "restore") {
        if (!b || !p || !name) return { ok: false, code: "E_NAMESPACE" };
        summary = {
          kind,
          target,
          trashFileName: name,
          id: b.id,
          text: b.body,
          rev: b.rev,
          updated: b.meta.updated,
          oldSource: { ...p.src },
          oldGrant: { ...p.grant },
          ...(p.from !== undefined ? { oldFrom: p.from } : {}),
          newSource: { ...src },
          newAuthorization: { via: "command", by: "user", issued: "on-commit" },
          warning: "保留旧来源/旧授权为历史；恢复记新的命令授权与当前来源，不复用旧权限；新的授权仅在 commit 时生成",
        };
      } else {
        const reseal: HubNamespaceV1 = {
          ...ns,
          uid: target.uid,
          stateDirReal: captured.real,
          stateDev: stateIdentity.dev,
          stateIno: stateIdentity.ino,
          host: hubHostFingerprint(),
        };
        const identityKeys = ["uid", "stateDirReal", "stateDev", "stateIno", "host"] as const;
        summary = {
          kind,
          target,
          items: corpus.items
            .map((item) => {
              const block = corpus.blocks.find((block) => block.id === item.id);
              if (!block) return error("E_NAMESPACE", "confirmation corpus mismatch");
              return {
                id: item.id,
                text: item.text,
                rev: block.rev,
                updated: item.updated,
                source: { ...item.src },
                grant: { ...item.grant },
                ...(item.from !== undefined ? { from: item.from } : {}),
              };
            })
            .sort((a, b) => a.id.localeCompare(b.id)),
          namespace: {
            current: { ...ns },
            reseal,
            changedFields: identityKeys.filter((key) => ns[key] !== reseal[key]),
          },
          warning: "仅重封以下完整安全 Hub 库的身份；条目正文与来源/授权不变，不修复、不导入、不更改权限",
        };
      }
      const confirmation = freezeConfirmation(summary);
      const token = Object.freeze({}) as HubManagementToken;
      tokens.set(token, {
        kind,
        slot: ctx.slot,
        owner,
        snapshot: frozen,
        source: src,
        ...(confirmation.kind === "adopt" ? { reseal: confirmation.namespace.reseal } : {}),
        ...(signal ? { signal } : {}),
        ...(name ? { trashName: name } : {}),
      });
      return Object.freeze({ ok: true as const, token, confirmation });
    } catch (err) {
      return { ok: false, code: asCode(err) };
    }
  };
  return {
    status() {
      if (disposed || !host.available()) return { items: [], state: "disabled", reason: "unavailable" };
      return readHubCorpus(host.slot(), { io: host.io, expectedHost: hubHostFingerprint(), now: host.now });
    },
    inspect(id) {
      try {
        if (disposed || !host.available()) return { ok: false, code: "E_SCOPE_DISABLED" };
        if (!isHubMemoryId(id)) return { ok: false, code: "E_META_INVALID" };
        const ctx = context();
        if (checkHubSlot(ctx.slot, { io: ctx.io, expectedHost: hubHostFingerprint() }) !== "ok")
          return { ok: false, code: "E_NAMESPACE" };
        const corpus = completeHubCorpus(ctx),
          item = corpus.items.find((i) => i.id === id),
          b = corpus.blocks.find((i) => i.id === id);
        return item && b ? { ok: true, item, rev: b.rev } : { ok: false, code: "E_NOT_FOUND" };
      } catch (err) {
        return { ok: false, code: asCode(err) };
      }
    },
    listTrash() {
      try {
        if (disposed || !host.available()) return [];
        const ctx = context();
        if (checkHubSlot(ctx.slot, { io: ctx.io, expectedHost: hubHostFingerprint() }) !== "ok") return [];
        trashDir(ctx, true);
        if (ctx.io.inspectDir(join(hubMemoryRoot(ctx.slot), "blocks", ".trash")) === undefined) return [];
        const archive = readArchive(ctx);
        return listDirNames(join(hubMemoryRoot(ctx.slot), "blocks", ".trash")).flatMap((fileName) => {
          const m = TRASH.exec(fileName);
          if (!m) return [];
          const e = archive[fileName];
          return [
            {
              fileName,
              id: m[2]!,
              provenance:
                e?.state === "restored" ? ("restored" as const) : e ? ("known" as const) : ("unknown" as const),
            },
          ];
        });
      } catch {
        return [];
      }
    },
    command(operation, signal) {
      try {
        guard(undefined, signal);
        const shape = readUntrustedValue(operation);
        if (!shape.ok || !shape.value || typeof shape.value !== "object" || Array.isArray(shape.value))
          return Promise.resolve(fail("E_META_INVALID"));
        const op = Object.freeze(shape.value) as unknown as FrozenScopedOp;
        if (op.storageScope !== "hub" || op.authority !== "user") return Promise.resolve(fail("E_AUTHORITY"));
        const owner = { ...host.owner() },
          src = source();
        // A private one-use closure grant, never a model/cap-shaped input.
        let used = false;
        return host.schedule(
          owner,
          signal,
          false,
          (ctx, recheck) => {
            guard(owner, signal);
            recheck();
            if (used) return fail("E_HUB_CAP_STALE");
            used = true;
            return commitHubUserCommandLocked(
              ctx,
              {
                op: op.op,
                src,
                ...(op.topic !== undefined ? { topic: op.topic } : {}),
                ...(op.targetId !== undefined ? { targetId: op.targetId } : {}),
                ...(op.text !== undefined ? { text: op.text } : {}),
                ...(op.expectRev !== undefined ? { expectRev: op.expectRev } : {}),
                ...(op.from !== undefined ? { from: op.from } : {}),
              },
              () => {
                guard(owner, signal);
                recheck();
              },
            );
          },
          () => {
            guard(owner, signal);
            if (canonicalJson(source()) !== canonicalJson(src)) error("E_STALE_SESSION", "command source changed");
          },
        );
      } catch (err) {
        return Promise.resolve(fail(asCode(err)));
      }
    },
    prepareAdopt: (signal) => prepare("adopt", undefined, signal),
    prepareRestore: (name, signal) => prepare("restore", name, signal),
    commit(token) {
      const rec = tokens.get(token);
      tokens.delete(token);
      if (!rec) return Promise.resolve(fail("E_HUB_CAP_STALE"));
      try {
        guard(rec.owner, rec.signal);
      } catch (err) {
        return Promise.resolve(fail(asCode(err)));
      }
      scheduled.set(token, rec);
      const validate = () => {
        if (rec.cancelled) error("E_HUB_CAP_STALE");
        guard(rec.owner, rec.signal);
      };
      return host
        .schedule(
          rec.owner,
          rec.signal,
          rec.kind === "adopt",
          (ctx, recheck) => {
            let mutation = false;
            try {
              const verify = () => {
                validate();
                recheck();
                if (canonicalJson(source()) !== canonicalJson(rec.source))
                  error("E_STALE_SESSION", "command source changed");
                if (ctx.slot.uid !== rec.slot.uid || ctx.slot.effectiveStateDir !== rec.slot.effectiveStateDir)
                  error("E_NAMESPACE");
                if (snapshot(ctx) !== rec.snapshot) error("E_CONFLICT");
                if (rec.reseal && rec.reseal.host !== hubHostFingerprint()) error("E_CONFLICT", "reseal host changed");
              };
              verify();
              const corpus = completeHubCorpus(ctx);
              ctx.faults?.beforeBlockWrite?.();
              verify();
              if (rec.kind === "adopt") {
                if (!rec.reseal) return fail("E_NAMESPACE");
                mutation = true;
                ctx.io.writePrivateFile(hubMemoryRoot(ctx.slot), "namespace.json", `${JSON.stringify(rec.reseal)}\n`);
              } else {
                const entries = readArchive(ctx),
                  name = rec.trashName!,
                  e = entries[name];
                if (!e || e.state !== "trashed") return fail("E_CONFLICT");
                const blocks = join(hubMemoryRoot(ctx.slot), "blocks"),
                  b = blockAt(ctx, join(blocks, ".trash"), name, e.id);
                if (ctx.io.statFile(join(blocks, `${e.id}.md`)) !== undefined) return fail("E_CONFLICT");
                restoreCapacity(b, rec.source, corpus.items);
                verify();
                mutation = true;
                renameNoClobber(blocks, `.trash/${name}`, `${e.id}.md`);
                fsyncDir(blocks);
                fsyncDir(join(blocks, ".trash"));
                ctx.faults?.afterBlockWrite?.();
                const provenance = restoredProvenance(b, rec.source, randomBytes(4).toString("hex"));
                corpus.provenance.set(e.id, provenance);
                writeProvenanceAndAuditLocked(
                  ctx,
                  corpus.provenance,
                  new Set([...corpus.items.map((i) => i.id), e.id]),
                  {
                    at: ctx.now.toISOString(),
                    op: "restore",
                    id: e.id,
                    rev: b.rev,
                    via: "command",
                    by: "user",
                    turn: "-",
                    cap: provenance.grant.cap!,
                    project: rec.source.project,
                    sid8: rec.source.sid8,
                  },
                );
                entries[name] = { ...e, state: "restored" };
                writeArchive(ctx, entries);
              }
              const checked = readHubCorpus(ctx.slot, {
                io: ctx.io,
                expectedHost: hubHostFingerprint(),
                now: () => ctx.now,
              });
              if (checked.state !== "ok") return fail("E_PERSIST_UNKNOWN");
              return {
                ok: true,
                id: rec.kind === "adopt" ? "namespace" : readArchive(ctx)[rec.trashName!]!.id,
                ...(rec.kind === "restore" ? { rev: readArchive(ctx)[rec.trashName!]!.provenance.rev } : {}),
                persistence: "appended",
              };
            } catch (err) {
              return fail(mutation ? "E_PERSIST_UNKNOWN" : asCode(err));
            }
          },
          validate,
        )
        .finally(() => {
          scheduled.delete(token);
        });
    },
    cancel: (token) => {
      tokens.delete(token);
      const rec = scheduled.get(token);
      if (rec) rec.cancelled = true;
    },
    dispose() {
      disposed = true;
      for (const rec of scheduled.values()) rec.cancelled = true;
      tokens.clear();
    },
  };
}
