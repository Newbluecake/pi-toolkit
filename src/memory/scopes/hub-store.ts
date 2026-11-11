/**
 * #39 P3a hub store: persistent hub-memory over the EXISTING blocks/lock/safe-fs
 * primitives (arch.md §3.4 file table, §6.4 API, §5.2 commit chain; plan S3/P3a).
 *
 * Layout under `<stateDir>/hub-memory/` (created ONLY at the first authorized write,
 * inside the directory lock; never proactively):
 *   namespace.json  — slot identity stamp (uid/realpath/dev/ino/host), 0600 (hub-slot.ts)
 *   blocks/         — one block per item via blocks/store.ts (text/topic/created/updated +
 *                     `storageScope: "hub"` marker; CAS via create/replace/trash)
 *   items.json      — hub-owned provenance (grant/src/from + `rev` + `updated` staleness guard);
 *                     NOT in BlockMeta: the Root-approved format.ts delta is storageScope
 *                     ONLY, so provenance lives in this hub-private sidecar
 *   audit.jsonl     — op history, ≤256 lines, NO bodies, cap-derived fields only
 *   .trash/         — soft deletes (blocks/store.ts trash)
 *
 * Commit chain (§5.2 steps 5–7): admission (pure validation + cap reserve) → dequeue
 * recheck (owner/signal/cap) → directory lock (≤2000ms, E_BUSY) → in-lock recheck
 * (slot identity, gate, op/text digests, expectRev CAS, capacity) → block write →
 * provenance + audit → consume. Any in-lock failure revokes the cap with ZERO visible
 * state change except a fully-trashed/detected half-state (multi-file writes are not a
 * transaction and this module does NOT claim fsync/crash atomicity — torn states are
 * DETECTED: namespace half ⇒ inert; provenance `rev`/`updated` mismatch ⇒ inert).
 *
 * Authority: hub items are ALWAYS `authority:"user"`; the agent path writes ONLY with a
 * P1 PrivateOpCap minted after an exact-content human affirmation (a string
 * `authority:"user"`, a tool argument or an old `allowWrite:true` setting grants nothing);
 * the user-command path is the future `/mem hub add|rm` (P3b) kernel. Child sessions are
 * refused outright (E_CHILD_READONLY). There is no auto-promotion path anywhere.
 *
 * Pi-free; no module-scope mutable state (I4); no new timers (I5 — withMemoryDirLock's
 * retry sleeps are unref'd); every computed deadline is a fixed clamped constant.
 */
import { hostname } from "node:os";
import { join } from "node:path";
import { withMemoryDirLock } from "../lock.js";
import { createBlockLocked, readCorpus, replaceBlockLocked } from "../blocks/store.js";
import { isExpired, type BlockMeta, type ParsedBlock } from "../blocks/format.js";
import {
  createExclusive,
  ensurePrivateDir,
  fsyncDir,
  readRegular,
  replaceAtomic,
  writeTempRegular,
} from "../safe-fs.js";
import { MemoryError } from "../paths.js";
import {
  checkHubSlot,
  captureHubSlotIdentity,
  defaultIo,
  hubMemoryRoot,
  dirSecurityMatches,
  type HubDirIdentity,
  type HubNamespaceV1,
  type HubSlotIo,
} from "./hub-slot.js";
import type { MemoryOpCapRegistry } from "./op-cap.js";
import type {
  FrozenScopedOp,
  HubItem,
  HubMemoryGrant,
  HubMemorySource,
  HubMemoryView,
  MemoryOwner,
  PrivateOpCap,
  ReservedMemoryOperation,
  SessionWriteGate,
  ScopedMemoryErrorCode,
  ScopedMemoryWriteResult,
} from "./types.js";
import {
  HUB_MEMORY_DTO_MAX_BYTES,
  HUB_MEMORY_MAX_BODY_BYTES,
  HUB_MEMORY_MAX_ITEMS,
  MEMORY_ITEM_MAX_BYTES,
  MEMORY_META_MAX_BYTES,
} from "./types.js";
import {
  bodyTextDigest,
  isFromRef,
  isHubMemoryId,
  isHubTopic,
  isMemoryTimestamp,
  jsonUtf8Bytes,
  readUntrustedValue,
  scopedOpDigest,
  sha256Hex,
  utf8Bytes,
  type RawRecord,
  type RawValue,
} from "./limits.js";
import {
  createHubManagement,
  archiveHubDeleteLocked,
  validateHubArchive,
  completeHubCorpus,
  type HubManagementPort,
} from "./hub-management.js";
import { renderHubItems, crossLayerDupMarkers } from "./render.js";
import type { FoldedSessionItem } from "./types.js";

export const HUB_LOCK_TIMEOUT_MS = 2_000;
export const HUB_AUDIT_MAX_LINES = 256;
export const HUB_PROVENANCE_MAX_ENTRIES = 256;

// ───────────────────────── host fingerprint / namespace stamp ─────────────────────────

export interface HubHostDeps {
  readonly readMachineId?: () => string;
  readonly hostname?: () => string;
}

/** sha256(/etc/machine-id ‖ os.hostname())[:16]; unreadable machine-id degrades to "". */
export function hubHostFingerprint(deps: HubHostDeps = {}): string {
  const machineId =
    deps.readMachineId ??
    (() => {
      try {
        return readRegular("/etc", "machine-id").text.trim(); // safe-fs primitive, no node:fs here
      } catch {
        return "";
      }
    })();
  const host = deps.hostname ?? hostname;
  return sha256Hex(`${machineId}${host()}`).slice(0, 16);
}

// ───────────────────────── provenance sidecar (items.json) ─────────────────────────

export interface HubProvenanceEntry {
  readonly grant: HubMemoryGrant;
  readonly src: HubMemorySource;
  readonly from?: string;
  /** Both timestamp AND content-bearing block revision must match; missing rev is inert. */
  readonly updated: string;
  readonly rev: string;
}

export interface HubItemsFileV1 {
  readonly v: 1;
  readonly items: ReadonlyMap<string, HubProvenanceEntry>;
}

const GRANT_VIA = new Set(["dialog", "command"]);
const GRANT_BY = new Set(["agent", "user"]);

export function parseProvenanceEntry(unknown: RawValue): HubProvenanceEntry | undefined {
  if (typeof unknown !== "object" || unknown === null || Array.isArray(unknown)) return undefined;
  const record = unknown as RawRecord;
  const keys = Object.keys(record);
  if (!keys.every((key) => ["grant", "src", "from", "updated", "rev"].includes(key))) return undefined;
  if (typeof record.updated !== "string" || !isMemoryTimestamp(record.updated)) return undefined;
  if (typeof record.rev !== "string" || !/^[1-9][0-9]*-[a-f0-9]{6}$/.test(record.rev)) return undefined;
  if (record.from !== undefined && !isFromRef(record.from)) return undefined;
  const grant = record.grant;
  if (typeof grant !== "object" || grant === null || Array.isArray(grant)) return undefined;
  const g = grant as RawRecord;
  if (typeof g.via !== "string" || !GRANT_VIA.has(g.via)) return undefined;
  if (typeof g.by !== "string" || !GRANT_BY.has(g.by)) return undefined;
  const gKeys = Object.keys(g);
  for (const field of ["channel", "turn", "cap", "who"] as const)
    if (g[field] !== undefined && typeof g[field] !== "string") return undefined;
  if (g.via === "command" && g.by !== "user") return undefined;
  if (!gKeys.every((key) => ["via", "by", "channel", "turn", "cap", "who"].includes(key))) return undefined;
  const channel = typeof g.channel === "string" ? g.channel : undefined;
  const turn = typeof g.turn === "string" ? g.turn : undefined;
  const capId = typeof g.cap === "string" ? g.cap : undefined;
  const who = typeof g.who === "string" ? g.who : undefined;
  const src = record.src;
  if (typeof src !== "object" || src === null || Array.isArray(src)) return undefined;
  const s = src as RawRecord;
  if (Object.keys(s).length !== 3) return undefined;
  if (typeof s.project !== "string" || !/^[a-f0-9]{0,16}$/.test(s.project)) return undefined;
  if (typeof s.sid8 !== "string" || !/^[A-Za-z0-9_-]{1,8}$/.test(s.sid8)) return undefined;
  if (typeof s.label !== "string" || utf8Bytes(s.label) > 40 || /[\u0000-\u001f\u007f]/.test(s.label)) return undefined;
  if (channel !== undefined && channel !== "tui" && channel !== "web") return undefined;
  if (turn !== undefined && !/^[a-f0-9]{8}$/.test(turn)) return undefined;
  if (capId !== undefined && !/^[a-f0-9]{8}$/.test(capId)) return undefined;
  if (who !== undefined && !/^[a-f0-9]{8}$/.test(who)) return undefined;
  const from = record.from;
  if (from !== undefined && !isFromRef(from)) return undefined;
  return {
    grant: {
      via: g.via as "dialog" | "command",
      by: g.by as "agent" | "user",
      ...(channel !== undefined ? { channel: channel as "tui" | "web" } : {}),
      ...(turn !== undefined ? { turn } : {}),
      ...(capId !== undefined ? { cap: capId } : {}),
      ...(who !== undefined ? { who } : {}),
    },
    src: { project: s.project, label: s.label, sid8: s.sid8 },
    ...(from !== undefined ? { from } : {}),
    updated: record.updated,
    rev: record.rev,
  };
}

/** Untrusted parse of items.json; corrupt ⇒ undefined (slot fails closed as inert). */
export function parseHubItemsFile(text: string): HubItemsFileV1 | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const shape = readUntrustedValue(parsed);
  if (!shape.ok || shape.value === null || typeof shape.value !== "object" || Array.isArray(shape.value))
    return undefined;
  const record = shape.value as RawRecord;
  if (record.v !== 1) return undefined;
  if (typeof record.items !== "object" || record.items === null || Array.isArray(record.items)) return undefined;
  const items = record.items as RawRecord;
  const out = new Map<string, HubProvenanceEntry>();
  for (const [id, raw] of Object.entries(items)) {
    if (!isHubMemoryId(id)) return undefined;
    const entry = parseProvenanceEntry(raw);
    if (entry === undefined) return undefined;
    out.set(id, entry);
  }
  return { v: 1, items: out };
}

export const serializeHubItemsFile = (items: ReadonlyMap<string, HubProvenanceEntry>): string => {
  const record: Record<string, unknown> = {};
  const ids = [...items.keys()].sort();
  for (const id of ids) {
    const entry = items.get(id)!;
    record[id] = {
      grant: entry.grant,
      src: entry.src,
      ...(entry.from !== undefined ? { from: entry.from } : {}),
      updated: entry.updated,
      rev: entry.rev,
    };
  }
  return `${JSON.stringify({ v: 1, items: record }, null, 0)}\n`;
};

// ───────────────────────── audit.jsonl ─────────────────────────

export interface HubAuditLine {
  readonly at: string;
  readonly op: string;
  readonly id: string;
  readonly rev: string;
  readonly via: "dialog" | "command";
  readonly channel?: "tui" | "web";
  readonly who?: string;
  readonly by: "agent" | "user";
  readonly turn: string;
  readonly cap: string;
  readonly project: string;
  readonly sid8: string;
}

const AUDIT_KEYS = ["at", "op", "id", "rev", "via", "channel", "who", "by", "turn", "cap", "project", "sid8"] as const;

const serializeAuditLine = (line: HubAuditLine): string => JSON.stringify(line, AUDIT_KEYS as unknown as string[]);

// ───────────────────────── fs seam (fault injection) ─────────────────────────

export interface HubFaultPoints {
  beforeInit?: () => void;
  /** After blocks/+items.json but BEFORE the namespace seal — the classic torn half-state. */
  beforeNamespaceSeal?: () => void;
  afterNamespace?: () => void;
  beforeBlockWrite?: () => void;
  afterBlockWrite?: () => void;
  beforeProvenanceWrite?: () => void;
  afterProvenanceWrite?: () => void;
  beforeAuditWrite?: () => void;
}

export interface HubStoreIo extends HubSlotIo {
  writePrivateFile(dir: string, name: string, text: string): void; // temp+replace, 0600
  createPrivateFile(dir: string, name: string, text: string): void; // temp+exclusive, 0600
  ensureDir(path: string): void;
  fsync(path: string): void;
}

/** The real-fs default seam (tests wrap it to COUNT touches, not to fake them).
 * Read-side defaults come from hub-slot's safe-fs-only io; write-side from safe-fs too. */
export const defaultStoreIo: HubStoreIo = {
  inspectDir: defaultIo.inspectDir,
  statFile: defaultIo.statFile,
  realpath: defaultIo.realpath,
  readUtf8File: defaultIo.readUtf8File,
  writePrivateFile(dir, name, text) {
    const tmp = writeTempRegular(dir, name, Buffer.from(text, "utf8"), 0o600);
    replaceAtomic(dir, tmp, name);
    fsyncDir(dir);
  },
  createPrivateFile(dir, name, text) {
    const tmp = writeTempRegular(dir, name, Buffer.from(text, "utf8"), 0o600);
    createExclusive(dir, tmp, name);
    fsyncDir(dir);
  },
  ensureDir: ensurePrivateDir,
  fsync: fsyncDir,
};

// ───────────────────────── slot state → items ─────────────────────────

export interface HubReadResult {
  readonly state: "ok" | "absent" | "inert";
  readonly reason?: string;
  readonly items: readonly HubItem[];
}

const activeHubBlocks = (blocks: readonly ParsedBlock[], today: string): readonly ParsedBlock[] =>
  blocks.filter(
    (b) =>
      b.errors.length === 0 &&
      b.meta.authority === "user" &&
      b.meta.status === "active" &&
      !isExpired(b.meta, today) &&
      isHubMemoryId(b.id) &&
      isHubTopic(b.topic),
  );

export const blockToItem = (block: ParsedBlock, provenance: HubProvenanceEntry): HubItem | undefined => {
  if (!isMemoryTimestamp(block.meta.created) || !isMemoryTimestamp(block.meta.updated)) return undefined;
  if (provenance.updated !== block.meta.updated || provenance.rev !== block.rev) return undefined;
  const item: HubItem = {
    id: block.id,
    topic: block.topic,
    text: block.body,
    authority: "user",
    created: block.meta.created,
    updated: block.meta.updated,
    grant: provenance.grant,
    src: provenance.src,
    ...(provenance.from !== undefined ? { from: provenance.from } : {}),
  };
  const { text: _text, ...metadata } = item;
  if (jsonUtf8Bytes(metadata) > MEMORY_META_MAX_BYTES) return undefined;
  return item;
};

/** Read the hub store (no lock; every file swap is atomic). Corrupt ⇒ inert, never throws. */
export function readHubCorpus(
  slot: { readonly effectiveStateDir: string; readonly uid: number },
  opts: { expectedHost?: string; io?: HubStoreIo; now?: () => Date } = {},
): HubReadResult {
  const io = opts.io ?? defaultStoreIo;
  const root = hubMemoryRoot(slot);
  try {
    const check = checkHubSlot(slot, {
      io,
      ...(opts.expectedHost !== undefined ? { expectedHost: opts.expectedHost } : {}),
    });
    if (check !== "ok") {
      if (check === "absent") return { state: "absent", items: [] };
      return { state: "inert", reason: check.inert, items: [] };
    }
    completeHubCorpus({ slot, io, now: (opts.now ?? (() => new Date()))() });
    const corpus = readCorpus(join(root, "blocks"));
    if (
      corpus.marker === undefined ||
      corpus.strays.length > 0 ||
      corpus.blocks.some(
        (b) =>
          b.errors.length > 0 ||
          b.meta.storageScope !== "hub" ||
          b.meta.authority !== "user" ||
          b.meta.status !== "active",
      )
    )
      return { state: "inert", reason: "invalid-hub-corpus", items: [] };
    const today = (opts.now ?? (() => new Date()))().toISOString().slice(0, 10);
    const itemsText = io.readUtf8File(join(root, "items.json"));
    const itemsFile = parseHubItemsFile(itemsText);
    if (itemsFile === undefined) return { state: "inert", reason: "provenance-corrupt", items: [] };
    if (itemsFile.items.size !== corpus.blocks.length || corpus.blocks.some((b) => !itemsFile.items.has(b.id)))
      return { state: "inert", reason: "provenance-incomplete", items: [] };
    validateHubArchive({ slot, io, now: (opts.now ?? (() => new Date()))() });
    const items: HubItem[] = [];
    for (const block of activeHubBlocks(corpus.blocks, today)) {
      const entry = itemsFile.items.get(block.id);
      if (entry === undefined) return { state: "inert", reason: "provenance-missing", items: [] };
      const item = blockToItem(block, entry);
      if (item === undefined) return { state: "inert", reason: "provenance-stale", items: [] };
      items.push(item);
    }
    if (jsonUtf8Bytes(items) > HUB_MEMORY_DTO_MAX_BYTES) return { state: "inert", reason: "dto-over", items: [] };
    return { state: "ok", items };
  } catch (err) {
    const reason =
      err instanceof MemoryError && err.message.startsWith("E_NAMESPACE: ")
        ? err.message.slice("E_NAMESPACE: ".length)
        : "read-failed";
    return { state: "inert", reason, items: [] };
  }
}

// ───────────────────────── in-lock commit (§6.4) ─────────────────────────

/** Adapt the #39 SessionWriteGate to the blocks-store MemoryWriteGate (check-only use). */
const blocksGateOf = (
  gate: SessionWriteGate | undefined,
): { gate: import("../contracts.js").MemoryWriteGate } | undefined =>
  gate === undefined
    ? undefined
    : {
        gate: {
          check: (memDir: string) =>
            gate.check({ sessionDir: memDir }) as
              | {
                  ok: true;
                }
              | { ok: false; reason: "locked" | "unmounted" | "path-escaped" | "identity-changed" },
          capture: () => {},
        },
      };

const KNOWN_CODES: readonly ScopedMemoryErrorCode[] = [
  "E_SCOPE_DISABLED",
  "E_CHILD_READONLY",
  "E_CHILD_AUTHORITY",
  "E_AUTHORITY",
  "E_HUB_NEEDS_HUMAN_TURN",
  "E_HUB_CONFIRM_UNAVAILABLE",
  "E_HUB_DECLINED",
  "E_HUB_DECLINED_TURN",
  "E_HUB_RATE",
  "E_HUB_CAP_STALE",
  "E_USER_AUTH_DECLINED",
  "E_REV_REQUIRED",
  "E_CONFLICT",
  "E_FULL",
  "E_TOO_LARGE",
  "E_META_INVALID",
  "E_NOT_FOUND",
  "E_STALE_SESSION",
  "E_PERSIST",
  "E_PERSIST_UNKNOWN",
  "E_BUSY",
  "E_NAMESPACE",
  "E_WRITE_GATE",
  "E_FROM_INVALID",
];

export const asCode = (err: unknown): ScopedMemoryErrorCode => {
  if (err instanceof MemoryError) {
    const message = err.message;
    if (message.startsWith("memory dir busy")) return "E_BUSY";
    if (message.includes("already exists")) return "E_CONFLICT";
    if (message.startsWith("E_TOPIC")) return "E_META_INVALID";
    const match = /^(E_[A-Z_]+)/.exec(message)?.[1] as ScopedMemoryErrorCode | undefined;
    if (match !== undefined && (KNOWN_CODES as readonly string[]).includes(match)) return match;
  }
  return "E_PERSIST";
};

const ENOENT = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === "ENOENT";

export interface HubCommitContext {
  readonly slot: { readonly effectiveStateDir: string; readonly uid: number };
  readonly io: HubStoreIo;
  readonly faults?: HubFaultPoints;
  readonly expectedHost?: string;
  readonly gate?: SessionWriteGate;
  readonly now: Date;
}

const fullMetaStub = (): BlockMeta => ({
  ...metaFor(),
  kind: "block",
  status: "active",
  created: "",
  updated: "",
  version: 1,
});

interface CommitPlan {
  readonly op: "create" | "update" | "delete";
  readonly topic?: string;
  readonly targetId?: string;
  readonly text?: string;
  readonly expectRev?: string;
  readonly from?: string;
  readonly provenance: HubProvenanceEntry;
  readonly audit: HubAuditLine;
}

const metaFor = (): Omit<BlockMeta, "created" | "updated" | "version" | "status" | "kind"> => ({
  authority: "user",
  scope: "global",
  storageScope: "hub",
});

/** Snapshot only existing dirs; stateDir modes intentionally not restricted. */
export const assertDirectorySnapshot = (
  ctx: HubCommitContext,
  previous?: readonly HubDirIdentity[],
  includeBlocks = true,
): readonly HubDirIdentity[] => {
  const root = hubMemoryRoot(ctx.slot);
  const paths = [ctx.slot.effectiveStateDir, root, ...(includeBlocks ? [join(root, "blocks")] : [])];
  return paths.map((path, i) => {
    const st = ctx.io.inspectDir(path);
    if (st === undefined || st === "not-dir" || !dirSecurityMatches(st, ctx.slot.uid, i !== 0))
      throw new MemoryError("E_NAMESPACE: directory security");
    const old = previous?.[i];
    if (old !== undefined && (old.dev !== st.dev || old.ino !== st.ino))
      throw new MemoryError("E_NAMESPACE: directory identity changed");
    return st;
  });
};

const writeNamespace = (ctx: HubCommitContext): void => {
  const root = hubMemoryRoot(ctx.slot);
  const starting = assertDirectorySnapshot(ctx, undefined, false);
  ctx.faults?.beforeInit?.();
  // WebHub W1 parity: mkdir -p 0700 (umask cannot loosen 0700), then verify the policy.
  ctx.io.ensureDir(ctx.slot.effectiveStateDir);
  const st = ctx.io.inspectDir(ctx.slot.effectiveStateDir);
  if (st === undefined || st === "not-dir" || !dirSecurityMatches(st, ctx.slot.uid, false))
    throw new MemoryError("E_NAMESPACE: state dir");
  const rootSt = ctx.io.inspectDir(root);
  if (rootSt === undefined || rootSt === "not-dir" || !dirSecurityMatches(rootSt, ctx.slot.uid))
    throw new MemoryError("E_NAMESPACE: hub-memory security");
  const real = ctx.io.realpath(ctx.slot.effectiveStateDir);
  if (real === undefined) throw new MemoryError("E_NAMESPACE: state dir realpath");
  const stamp: HubNamespaceV1 = {
    v: 1,
    uid: ctx.slot.uid,
    stateDirReal: real,
    stateDev: st.dev,
    stateIno: st.ino,
    host: ctx.expectedHost ?? hubHostFingerprint(),
    createdAt: ctx.now.toISOString(),
  };
  ctx.io.ensureDir(join(root, "blocks"));
  const initialized = assertDirectorySnapshot(ctx, starting);
  ctx.io.fsync(root);
  ctx.io.createPrivateFile(join(root, "blocks"), ".layout.json", `${JSON.stringify({ v: 1, source: "fresh" })}\n`);
  ctx.io.writePrivateFile(root, "items.json", serializeHubItemsFile(new Map()));
  ctx.io.fsync(root);
  // The namespace is the SEAL: a crash before it leaves the half-state (blocks+items
  // without namespace) that checkHubSlot classifies as inert — never silently usable.
  ctx.faults?.beforeNamespaceSeal?.();
  assertDirectorySnapshot(ctx, initialized);
  ctx.io.createPrivateFile(root, "namespace.json", `${JSON.stringify(stamp)}\n`);
  ctx.io.fsync(root);
  ctx.faults?.afterNamespace?.();
};

const readProvenanceLocked = (ctx: HubCommitContext): Map<string, HubProvenanceEntry> => {
  const root = hubMemoryRoot(ctx.slot);
  const parsed = parseHubItemsFile(ctx.io.readUtf8File(join(root, "items.json")));
  if (parsed === undefined) throw new MemoryError("E_NAMESPACE: provenance corrupt");
  return new Map(parsed.items);
};

export const writeProvenanceAndAuditLocked = (
  ctx: HubCommitContext,
  items: Map<string, HubProvenanceEntry>,
  liveIds: ReadonlySet<string>,
  audit?: HubAuditLine,
): void => {
  const root = hubMemoryRoot(ctx.slot);
  ctx.faults?.beforeProvenanceWrite?.();
  // Keep only live provenance (<=32). Never evict an early live id for churn history.
  for (const id of items.keys()) if (!liveIds.has(id)) items.delete(id);
  if (items.size > HUB_PROVENANCE_MAX_ENTRIES) throw new MemoryError("E_NAMESPACE: provenance over cap");
  ctx.io.writePrivateFile(root, "items.json", serializeHubItemsFile(items));
  ctx.faults?.afterProvenanceWrite?.();
  if (audit === undefined) return;
  ctx.faults?.beforeAuditWrite?.();
  const auditPath = join(root, "audit.jsonl");
  let lines: string[] = [];
  try {
    lines = ctx.io
      .readUtf8File(auditPath)
      .split("\n")
      .filter((line) => line !== "");
  } catch {
    lines = [];
  }
  lines.push(serializeAuditLine(audit));
  if (lines.length > HUB_AUDIT_MAX_LINES) lines = lines.slice(lines.length - HUB_AUDIT_MAX_LINES);
  ctx.io.writePrivateFile(root, "audit.jsonl", `${lines.join("\n")}\n`);
};

const checkGate = (ctx: HubCommitContext): void => {
  if (ctx.gate !== undefined && !ctx.gate.check({ sessionDir: hubMemoryRoot(ctx.slot) }).ok)
    throw new MemoryError("E_WRITE_GATE: hub write refused");
};

const ensureSlotOkLocked = (ctx: HubCommitContext): "ok" | "absent" => {
  const check = checkHubSlot(ctx.slot, {
    io: ctx.io,
    ...(ctx.expectedHost !== undefined ? { expectedHost: ctx.expectedHost } : {}),
  });
  if (check === "ok" || check === "absent") return check;
  throw new MemoryError(`E_NAMESPACE: ${check.inert}`);
};

const readItemsForCapacity = (ctx: HubCommitContext): readonly HubItem[] => {
  const read = readHubCorpus(ctx.slot, {
    io: ctx.io,
    now: () => ctx.now,
    ...(ctx.expectedHost !== undefined ? { expectedHost: ctx.expectedHost } : {}),
  });
  if (read.state === "inert") throw new MemoryError(`E_NAMESPACE: ${read.reason}`);
  return read.items;
};

export const capacityCheck = (
  items: readonly HubItem[],
  replacingId: string | undefined,
  nextText: string | undefined,
): void => {
  if (nextText !== undefined && utf8Bytes(nextText) > MEMORY_ITEM_MAX_BYTES)
    throw new MemoryError("E_TOO_LARGE: hub item exceeds 1024 bytes");
  const active = items.filter((item) => item.id !== replacingId);
  if (nextText !== undefined && active.length + 1 > HUB_MEMORY_MAX_ITEMS)
    throw new MemoryError("E_FULL: hub has 32 active items");
  const body =
    active.reduce((sum, item) => sum + utf8Bytes(item.text), 0) + (nextText !== undefined ? utf8Bytes(nextText) : 0);
  if (nextText !== undefined && body > HUB_MEMORY_MAX_BODY_BYTES)
    throw new MemoryError("E_FULL: hub body budget is 4096 bytes");
};

/** §6.4 commitHubOpLocked: cap-only agent path. `reserved` MUST come from registry.reserve/check. */
export function commitHubOpLocked(
  ctx: HubCommitContext,
  reserved: ReservedMemoryOperation,
  verify: {
    readonly cap: PrivateOpCap;
    readonly owner: MemoryOwner;
    readonly registry: MemoryOpCapRegistry;
    readonly recheck?: () => boolean;
  },
): ScopedMemoryWriteResult {
  const reject = (): ScopedMemoryWriteResult => {
    verify.registry.revoke(verify.cap);
    return { ok: false, code: "E_HUB_CAP_STALE" };
  };
  const op = reserved.operation;
  if (op.storageScope !== "hub" || op.authority !== "user") {
    verify.registry.revoke(verify.cap);
    return { ok: false, code: "E_AUTHORITY" };
  } // hub ops are user-scope ONLY and cap-bound
  // Fresh digest re-verification against the RESERVED frozen operation (never the caller's copy).
  if (scopedOpDigest(op as unknown as Record<string, unknown>) !== reserved.binding.opDigest) return reject();
  if (bodyTextDigest(op.text ?? "") !== reserved.binding.textDigest) return reject();
  if (verify.registry.check(verify.cap, verify.owner) === undefined) return reject();
  const auditFromCap = verify.registry.auditOf(verify.cap, ctx.now.toISOString());
  if (auditFromCap === undefined) return reject();
  const who = auditFromCap.who;
  const provenance: HubProvenanceEntry = {
    grant: {
      via: "dialog",
      by: "agent",
      ...(reserved.channel !== undefined ? { channel: reserved.channel } : {}),
      turn: reserved.binding.humanTurn.id.slice(0, 8),
      cap: auditFromCap.cap,
    },
    src: {
      project: projectSlugOf(auditFromCap.project),
      label: auditFromCap.project.slice(0, 40),
      sid8: reserved.binding.owner.sid.slice(0, 8),
    },
    ...(op.from !== undefined ? { from: op.from } : {}),
    updated: ctx.now.toISOString(),
    rev: "1-000000", // pure-plan sentinel; replaced by the written block.rev before persistence
  };
  const audit: HubAuditLine = {
    at: auditFromCap.at,
    op: auditFromCap.op,
    id: auditFromCap.id,
    rev: auditFromCap.rev,
    via: auditFromCap.via,
    ...(auditFromCap.channel !== undefined ? { channel: auditFromCap.channel } : {}),
    ...(who !== undefined ? { who } : {}),
    by: auditFromCap.by,
    turn: auditFromCap.turn,
    cap: auditFromCap.cap,
    project: auditFromCap.project,
    sid8: auditFromCap.sid8,
  };
  return commitPlanLocked(
    ctx,
    {
      op: op.op,
      provenance,
      audit,
      ...(op.topic !== undefined ? { topic: op.topic } : {}),
      ...(op.targetId !== undefined ? { targetId: op.targetId } : {}),
      ...(op.text !== undefined ? { text: op.text } : {}),
      ...(op.expectRev !== undefined ? { expectRev: op.expectRev } : {}),
      ...(op.from !== undefined ? { from: op.from } : {}),
    },
    verify.registry,
    verify.cap,
    () => verify.registry.check(verify.cap, verify.owner) !== undefined && (verify.recheck?.() ?? true),
  );
}

/** §6.4 commitHubUserCommandLocked: the future `/mem hub add|rm` kernel (P3b wires the TUI). */
export function commitHubUserCommandLocked(
  ctx: HubCommitContext,
  req: {
    readonly op: "create" | "update" | "delete";
    readonly topic?: string;
    readonly targetId?: string;
    readonly text?: string;
    readonly expectRev?: string;
    readonly src: HubMemorySource;
    readonly from?: string;
  },
  recheck?: () => void,
): ScopedMemoryWriteResult {
  const shape = readUntrustedValue(req);
  if (!shape.ok || shape.value === null || typeof shape.value !== "object" || Array.isArray(shape.value))
    return { ok: false, code: "E_META_INVALID" };
  // Descriptor-safe deep copy: never execute caller getters/toJSON or retain mutable source.
  req = shape.value as unknown as typeof req;
  const provenance: HubProvenanceEntry = {
    grant: { via: "command", by: "user" },
    src: req.src,
    ...(req.from !== undefined ? { from: req.from } : {}),
    updated: ctx.now.toISOString(),
    rev: "1-000000", // pure-plan sentinel; replaced by the written block.rev before persistence
  };
  const validated = parseProvenanceEntry(provenance as unknown as RawValue);
  if (validated === undefined) return { ok: false, code: "E_META_INVALID" };
  const audit: HubAuditLine = {
    at: ctx.now.toISOString(),
    op: req.op,
    id: req.targetId ?? "",
    rev: req.expectRev ?? "",
    via: "command",
    by: "user",
    turn: "-",
    cap: "-",
    project: req.src.project,
    sid8: req.src.sid8,
  };
  return commitPlanLocked(
    ctx,
    {
      op: req.op,
      provenance,
      audit,
      ...(req.topic !== undefined ? { topic: req.topic } : {}),
      ...(req.targetId !== undefined ? { targetId: req.targetId } : {}),
      ...(req.text !== undefined ? { text: req.text } : {}),
      ...(req.expectRev !== undefined ? { expectRev: req.expectRev } : {}),
      ...(req.from !== undefined ? { from: req.from } : {}),
    },
    undefined,
    undefined,
    () => {
      recheck?.();
      return true;
    },
  );
}

function commitPlanLocked(
  ctx: HubCommitContext,
  plan: CommitPlan,
  registry?: MemoryOpCapRegistry,
  cap?: PrivateOpCap,
  recheck?: () => boolean,
): ScopedMemoryWriteResult {
  const root = hubMemoryRoot(ctx.slot);
  const blocksDir = join(root, "blocks");
  let mutationAttempted = false;
  let blockAttempted = false;
  let blockCommitted = false;
  try {
    // Same private-sidecar validator on both paths, before any mutating IO.
    const metadata = readUntrustedValue(plan.provenance);
    if (!metadata.ok || parseProvenanceEntry(metadata.value) === undefined)
      throw new MemoryError("E_META_INVALID: provenance");
    if (!["create", "update", "delete"].includes(plan.op)) throw new MemoryError("E_META_INVALID: op");
    // Pure op-shape validation BEFORE anything touches the disk.
    if (plan.op === "create") {
      if (plan.topic === undefined || !isHubTopic(plan.topic)) throw new MemoryError("E_META_INVALID: topic");
      if (plan.text === undefined) throw new MemoryError("E_META_INVALID: text");
      if (plan.expectRev !== undefined) throw new MemoryError("E_META_INVALID: create carries no rev");
    } else {
      if (plan.targetId === undefined || !isHubMemoryId(plan.targetId)) throw new MemoryError("E_META_INVALID: id");
      if (plan.expectRev === undefined || plan.expectRev === "") throw new MemoryError("E_REV_REQUIRED");
      if (plan.op === "update" && plan.text === undefined) throw new MemoryError("E_META_INVALID: text");
    }
    if (plan.from !== undefined && !isFromRef(plan.from)) throw new MemoryError("E_FROM_INVALID");
    const slotState = ensureSlotOkLocked(ctx);
    checkGate(ctx);
    const current = readItemsForCapacity(ctx);
    capacityCheck(
      current,
      plan.op === "update" || plan.op === "delete" ? plan.targetId : undefined,
      plan.op === "delete" ? undefined : plan.text,
    );
    if (recheck?.() === false) throw new MemoryError("E_HUB_CAP_STALE");
    if (slotState === "absent") {
      mutationAttempted = true;
      writeNamespace(ctx);
    }
    const provenance = readProvenanceLocked(ctx);
    const identity = assertDirectorySnapshot(ctx);
    const namespaceBytes = ctx.io.readUtf8File(join(root, "namespace.json"));
    const namespaceStat = ctx.io.statFile(join(root, "namespace.json"));
    ctx.faults?.beforeBlockWrite?.();
    assertDirectorySnapshot(ctx, identity);
    if (
      namespaceBytes !== ctx.io.readUtf8File(join(root, "namespace.json")) ||
      JSON.stringify(namespaceStat) !== JSON.stringify(ctx.io.statFile(join(root, "namespace.json")))
    )
      throw new MemoryError("E_NAMESPACE: namespace CAS");
    assertDirectorySnapshot(ctx, identity);
    ensureSlotOkLocked(ctx);
    checkGate(ctx);
    if (recheck?.() === false) throw new MemoryError("E_HUB_CAP_STALE");
    mutationAttempted = true;
    blockAttempted = true;
    let id: string;
    let rev: string | undefined;
    if (plan.op === "create") {
      const gate = blocksGateOf(ctx.gate);
      const created = createBlockLocked(blocksDir, plan.topic!, metaFor(), plan.text!, ctx.now, gate);
      id = created.id;
      rev = created.rev;
      provenance.set(id, { ...plan.provenance, rev: created.rev });
    } else if (plan.op === "update") {
      const targetId = plan.targetId!;
      const expectRev = plan.expectRev!;
      const text = plan.text!;
      const existing = provenance.get(targetId);
      if (existing === undefined) throw new MemoryError("E_NOT_FOUND: no provenance");
      const currentMeta = current.find((item) => item.id === targetId);
      if (currentMeta === undefined) throw new MemoryError("E_NOT_FOUND: no active item");
      const updated = replaceBlockLocked(
        blocksDir,
        targetId,
        expectRev,
        { meta: fullMetaStub(), body: text },
        ctx.now,
        blocksGateOf(ctx.gate),
      );
      id = updated.id;
      rev = updated.rev;
      provenance.set(id, { ...plan.provenance, updated: updated.meta.updated, rev: updated.rev });
    } else {
      archiveHubDeleteLocked(ctx, plan.targetId!, plan.expectRev!, provenance.get(plan.targetId!)!, () => {
        assertDirectorySnapshot(ctx, identity);
        ensureSlotOkLocked(ctx);
        checkGate(ctx);
        if (recheck?.() === false) throw new MemoryError("E_HUB_CAP_STALE");
      });
      id = plan.targetId!;
      rev = undefined;
      provenance.delete(id);
    }
    blockCommitted = true;
    ctx.faults?.afterBlockWrite?.();
    const liveIds = new Set(current.map((item) => item.id));
    if (plan.op === "delete") liveIds.delete(id);
    else liveIds.add(id);
    writeProvenanceAndAuditLocked(ctx, provenance, liveIds, plan.audit);
    if (
      readHubCorpus(ctx.slot, {
        io: ctx.io,
        now: () => ctx.now,
        ...(ctx.expectedHost !== undefined ? { expectedHost: ctx.expectedHost } : {}),
      }).state !== "ok"
    )
      throw new MemoryError("E_PERSIST_UNKNOWN: hub post-write verification failed");
    if (registry !== undefined && cap !== undefined) {
      if (!registry.consume(cap)) {
        registry.revoke(cap);
        return { ok: false, code: "E_PERSIST_UNKNOWN" };
      }
    }
    // Hub writes are durable regular files; `appended` here means "written to the persistent
    // hub store" — NOT the SDK conversation append, and no fsync/crash-atomicity is claimed.
    return { ok: true, id, ...(rev !== undefined ? { rev } : {}), persistence: "appended" };
  } catch (err) {
    if (registry !== undefined && cap !== undefined) registry.revoke(cap);
    if (ENOENT(err) && !mutationAttempted) return { ok: false, code: "E_NOT_FOUND" };
    const code = asCode(err);
    if (blockCommitted || (blockAttempted && ["E_NAMESPACE", "E_WRITE_GATE", "E_HUB_CAP_STALE"].includes(code)))
      return { ok: false, code: "E_PERSIST_UNKNOWN" };
    const failureCode = mutationAttempted && (code === "E_PERSIST" || ENOENT(err)) ? "E_PERSIST_UNKNOWN" : code;
    // Only these exact local capacity diagnostics may add detail. Never echo an
    // arbitrary MemoryError (paths/body/secrets), or override unknown effects.
    const capacityMessage =
      failureCode !== "E_PERSIST_UNKNOWN" && err instanceof MemoryError
        ? err.message === "E_FULL: hub has 32 active items"
          ? "Hub capacity is fixed at 32 items / 4096 UTF-8 body bytes; all 32 item slots are occupied. View Hub memory and delete obsolete items using their actual id/rev and the required approval before creating another. There is no capacity setting."
          : err.message === "E_FULL: hub body budget is 4096 bytes"
            ? "Hub capacity is fixed at 32 items / 4096 UTF-8 body bytes; this write would exceed the total body budget. View Hub memory and shorten or delete existing items using their actual id/rev and the required approval. There is no capacity setting."
            : err.message === "E_TOO_LARGE: hub item exceeds 1024 bytes"
              ? "Each Hub item is limited to 1024 UTF-8 body bytes; shorten this content. Hub capacity is fixed at 32 items / 4096 UTF-8 body bytes, with no capacity setting."
              : undefined
        : undefined;
    return { ok: false, code: failureCode, ...(capacityMessage ? { message: capacityMessage } : {}) };
  }
}

export const withHubStoreLock = <T>(
  slot: { readonly effectiveStateDir: string; readonly uid: number },
  body: () => T,
): Promise<T> => withMemoryDirLock(hubMemoryRoot(slot), body, { timeoutMs: HUB_LOCK_TIMEOUT_MS });

// ───────────────────────── provider (view/render/enqueue) ─────────────────────────

export type HubCapability = "ok" | "disabled" | "secure" | "locked" | "unknown";

export interface HubMemoryWrite {
  readonly operation: FrozenScopedOp & { readonly storageScope: "hub" };
  readonly owner: MemoryOwner;
  readonly cap: PrivateOpCap;
  readonly signal?: AbortSignal;
}

export interface HubProviderDeps {
  /** Real-time capability verdict; anything but "ok" ⇒ the port must be ABSENT (P4 wiring),
   * and this kernel also refuses to read or write while it is not "ok". */
  readonly capability: () => HubCapability;
  readonly registry: MemoryOpCapRegistry;
  readonly owner: () => MemoryOwner;
  readonly slot: () => { readonly effectiveStateDir: string; readonly uid: number };
  readonly gate?: SessionWriteGate;
  readonly isChildSession?: () => boolean;
  /** Slug of the CURRENT project (render marks own items `src=this-project`). */
  readonly currentProjectSlug?: () => string;
  readonly sessionItems?: () => readonly FoldedSessionItem[];
  readonly io?: HubStoreIo;
  readonly faults?: HubFaultPoints;
  readonly now?: () => Date;
  readonly queueLimit?: number;
  readonly lockTimeoutMs?: number;
  /** Host-only native-main-TUI command predicate; never sourced from model/wire fields. */
  readonly trustedCommand?: () => boolean;
  readonly commandSource?: () => HubMemorySource;
}

export interface HubMemoryPort {
  view(): HubMemoryView;
  render(): string;
  enqueue(request: HubMemoryWrite): Promise<ScopedMemoryWriteResult>;
  readonly management: HubManagementPort;
  dispose(): void;
}

const HUB_QUEUE_LIMIT = 16;

export function createHubMemoryProvider(deps: HubProviderDeps): HubMemoryPort {
  const io = deps.io ?? defaultStoreIo;
  const queueLimit = deps.queueLimit ?? HUB_QUEUE_LIMIT;
  let disposed = false;
  let pending = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const now = () => (deps.now ?? (() => new Date()))();

  const view = (): HubMemoryView => {
    if (disposed) return { items: [], state: "disabled", reason: "disposed" };
    const capability = deps.capability();
    if (capability !== "ok") return { items: [], state: "disabled", reason: capability };
    const read = readHubCorpus(deps.slot(), { expectedHost: hubHostFingerprint(), io, now });
    if (read.state === "absent") return { items: [], state: "absent" };
    if (read.state === "inert")
      return {
        items: [],
        state: "inert",
        ...(read.reason !== undefined ? { reason: read.reason } : {}),
      };
    return { items: read.items, state: "ok" };
  };

  const render = (): string => {
    const current = view();
    if (current.state !== "ok") return "";
    const slug = deps.currentProjectSlug?.() ?? "";
    const items = current.items.map((item) =>
      item.src.project === slug ? { ...item, src: { ...item.src, project: "" } } : item,
    );
    const session = deps.sessionItems?.() ?? [];
    const dup = session.length > 0 ? crossLayerDupMarkers(session, items) : undefined;
    const header = "Hub memory (shared by all projects of this hub)";
    const body = renderHubItems(items, dup?.hub);
    return body === "" ? header : `${header}\n${body}`;
  };

  const fail = (code: ScopedMemoryErrorCode): ScopedMemoryWriteResult => ({ ok: false, code });

  // One bounded FIFO and one lock path for ALL writers, including management. The
  // lock protects the pre-await directory identities, not merely a path string.
  const schedule = (
    owner: MemoryOwner,
    signal: AbortSignal | undefined,
    allowInert: boolean,
    body: (ctx: HubCommitContext, recheck: () => void) => ScopedMemoryWriteResult,
    validate?: () => void,
  ): Promise<ScopedMemoryWriteResult> => {
    if (pending >= queueLimit) return Promise.resolve(fail("E_BUSY"));
    if (disposed) return Promise.resolve(fail("E_STALE_SESSION"));
    const slot = { ...deps.slot() };
    const recheck = () => {
      validate?.();
      if (disposed || !sameHubOwner(owner, deps.owner())) throw new MemoryError("E_STALE_SESSION");
      if (signal?.aborted) throw new MemoryError("E_HUB_CAP_STALE");
      if (deps.capability() !== "ok") throw new MemoryError("E_SCOPE_DISABLED");
      if (deps.isChildSession?.() === true) throw new MemoryError("E_CHILD_READONLY");
      const latest = deps.slot();
      if (latest.uid !== slot.uid || latest.effectiveStateDir !== slot.effectiveStateDir)
        throw new MemoryError("E_NAMESPACE");
      if (deps.gate && !deps.gate.check({ sessionDir: hubMemoryRoot(slot) }).ok) throw new MemoryError("E_WRITE_GATE");
    };
    pending++;
    const run = async () => {
      try {
        recheck();
        const ctx: HubCommitContext = {
          slot,
          io,
          now: now(),
          expectedHost: hubHostFingerprint(),
          ...(deps.gate ? { gate: deps.gate } : {}),
          ...(deps.faults ? { faults: deps.faults } : {}),
        };
        const checked = checkHubSlot(slot, { io, expectedHost: hubHostFingerprint() });
        if (!allowInert && checked !== "ok" && checked !== "absent") throw new MemoryError("E_NAMESPACE");
        if (checked === "absent" && !allowInert) io.ensureDir(hubMemoryRoot(slot));
        const identities = assertDirectorySnapshot(ctx, undefined, false);
        let lockSnapshot: string;
        try {
          lockSnapshot = captureHubSlotIdentity(slot, io);
        } catch {
          throw new MemoryError("E_NAMESPACE");
        }
        return await withMemoryDirLock(
          hubMemoryRoot(slot),
          () => {
            assertDirectorySnapshot(ctx, identities, false);
            try {
              if (lockSnapshot !== captureHubSlotIdentity(slot, io)) throw new Error("changed");
            } catch {
              throw new MemoryError("E_NAMESPACE");
            }
            recheck();
            return body(ctx, recheck);
          },
          { timeoutMs: deps.lockTimeoutMs ?? HUB_LOCK_TIMEOUT_MS },
        );
      } catch (err) {
        return fail(asCode(err));
      } finally {
        pending--;
      }
    };
    const result = tail.then(run, run);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const enqueue = (request: HubMemoryWrite): Promise<ScopedMemoryWriteResult> => {
    const reject = (code: ScopedMemoryErrorCode) => {
      deps.registry.revoke(request.cap);
      return Promise.resolve(fail(code));
    };
    try {
      if (disposed) return reject("E_STALE_SESSION");
      if (deps.capability() !== "ok") return reject("E_SCOPE_DISABLED");
      if (deps.isChildSession?.() === true) return reject("E_CHILD_READONLY");
      const shape = readUntrustedValue(request.operation);
      if (!shape.ok || !shape.value || typeof shape.value !== "object" || Array.isArray(shape.value))
        return reject("E_META_INVALID");
      const op = Object.freeze(shape.value) as unknown as HubMemoryWrite["operation"];
      if (op.storageScope !== "hub" || op.authority !== "user") return reject("E_AUTHORITY");
      const reserved = deps.registry.reserve(request.cap, request.owner);
      if (!reserved) return reject("E_HUB_CAP_STALE");
      const matches = () => {
        const live = deps.registry.check(request.cap, request.owner);
        return (
          live !== undefined &&
          scopedOpDigest(op as unknown as Record<string, unknown>) === live.binding.opDigest &&
          scopedOpDigest(live.operation as unknown as Record<string, unknown>) === live.binding.opDigest &&
          bodyTextDigest(op.text ?? "") === live.binding.textDigest
        );
      };
      if (!matches()) return reject("E_HUB_CAP_STALE");
      return schedule({ ...request.owner }, request.signal, false, (ctx, recheck) => {
        recheck();
        if (!matches()) return fail("E_HUB_CAP_STALE");
        return commitHubOpLocked(ctx, reserved, {
          cap: request.cap,
          owner: request.owner,
          registry: deps.registry,
          recheck: () => {
            try {
              recheck();
              return matches();
            } catch {
              return false;
            }
          },
        });
      }).then((result) => {
        if (!result.ok) deps.registry.revoke(request.cap);
        return result;
      });
    } catch (err) {
      return reject(asCode(err));
    }
  };

  const management = createHubManagement({
    io,
    slot: deps.slot,
    owner: deps.owner,
    now,
    available: () => !disposed && deps.capability() === "ok" && deps.isChildSession?.() !== true,
    trustedCommand: () => deps.trustedCommand?.() === true,
    ...(deps.commandSource ? { source: deps.commandSource } : {}),
    schedule,
  });

  return {
    view,
    render,
    enqueue,
    management,
    dispose(): void {
      management.dispose();
      disposed = true;
    },
  };
}

/** Current-project slug formula shared by render and future P4 assembly (one formula). */
export const projectSlugOf = (label: string): string => sha256Hex(label).slice(0, 12);

/** Full owner equality including session-file identity (registry's historical comparator is narrower). */
export const sameHubOwner = (a: MemoryOwner, b: MemoryOwner): boolean =>
  a.incarnation === b.incarnation &&
  a.sid === b.sid &&
  a.sessionFile === b.sessionFile &&
  a.sessionEpoch === b.sessionEpoch &&
  a.branchGen === b.branchGen;
