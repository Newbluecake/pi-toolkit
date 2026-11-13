/** Local-only terminal trust channel. Same uid/PID namespace is a trust boundary,
 * NOT isolation against arbitrary same-uid code. No output/cwd/credentials on disk. */
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  TERMINAL_JOURNAL_FILE,
  TerminalJournalSchema,
  TerminalManagedIdentitySchema,
  TerminalProcessIdentitySchema,
  TerminalResourceIdentitySchema,
  terminalIdentityKey,
  type TerminalReapProof,
  type TerminalResourceEntry,
  type TerminalLocalReference,
} from "./terminal.js";
export const TERMINAL_LOCAL_DIR = "terminal-v1";
const TOKEN = Type.String({ pattern: "^[A-Za-z0-9_-]{32,64}$" });
const id = Type.String({ minLength: 1, maxLength: 256 });
const closed = <T extends Record<string, import("@sinclair/typebox").TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const namespaces = closed({ pid: id, mnt: id, user: id });
const StoreMarkerSchema = closed({ v: Type.Literal(1), storeId: TOKEN });
export const TerminalAuthorityRecordSchema = closed({
  v: Type.Literal(1),
  recordId: TOKEN,
  nonce: TOKEN,
  storeId: TOKEN,
  agentNonce: id,
  sessionId: id,
  epoch: id,
  ownerInstance: id,
  process: TerminalProcessIdentitySchema,
  namespaces,
  domain: Type.Union([Type.Literal("plain"), Type.Literal("secure"), Type.Literal("unknown")]),
  main: Type.Boolean(),
  active: Type.Boolean(),
  createdAt: Type.Integer({ minimum: 0 }),
});
export type TerminalAuthorityRecord = Static<typeof TerminalAuthorityRecordSchema>;
export const TerminalPhysicalReceiptSchema = closed({
  v: Type.Literal(1),
  recordId: TOKEN,
  nonce: TOKEN,
  storeId: TOKEN,
  ownerRecordId: TOKEN,
  identity: TerminalResourceIdentitySchema,
  agentProcessIdentity: TerminalProcessIdentitySchema,
  physical: closed({
    outcome: Type.Literal("reaped"),
    spawnSettled: Type.Literal(true),
    ptyClosed: Type.Literal(true),
    helperReaped: Type.Literal(true),
    managedGroupsGone: Type.Literal(true),
    identitiesChecked: Type.Array(TerminalManagedIdentitySchema, { maxItems: 256 }),
    waited: Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 256 }),
  }),
});
export type TerminalPhysicalReceipt = Static<typeof TerminalPhysicalReceiptSchema>;
type Store = { root: string; storeId: string };
const token = () => randomBytes(24).toString("base64url");
export class TerminalLocalError extends Error {
  constructor(readonly reason: string) {
    super(`terminal local: ${reason}`);
  }
}
export const localHash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export function localPlainEnvironment(): boolean {
  return process.env.PI_SECURE_SESSION !== "1" && !process.env.PI_SECURE_VAULT;
}
/** Local mirror of clampSpanMs (protocol must not import core). IO is <=2s, never long timers. */
export async function localBounded<T>(work: (signal: AbortSignal) => Promise<T>, ms = 2000): Promise<T> {
  const span = Number.isFinite(ms) ? Math.max(0, Math.min(2000, Math.trunc(ms))) : 0;
  const controller = new AbortController(),
    deadline = Date.now() + span;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new TerminalLocalError("io-deadline"));
    }, span);
    timer.unref();
    Promise.resolve()
      .then(() => work(controller.signal))
      .then(
        (value) => {
          clearTimeout(timer);
          if (controller.signal.aborted || Date.now() >= deadline) {
            controller.abort();
            reject(new TerminalLocalError("io-deadline"));
          } else resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          controller.abort();
          reject(error);
        },
      );
  });
}
export function checkLocalDirectory(path: string): void {
  const st = lstatSync(path);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid?.() ||
    (st.mode & 0o777) !== 0o700 ||
    realpathSync(path) !== resolve(path)
  )
    throw new TerminalLocalError("unsafe-directory");
}
/** O_NONBLOCK + regular file + bounded exact read, including all synchronous final guards. */
export function readLocalFile(path: string, max = 131072): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.nlink !== 1 || st.size > max)
      throw new TerminalLocalError("unsafe-file");
    const bytes = Buffer.alloc(st.size + 1);
    let n = 0;
    while (n < bytes.length) {
      const got = readSync(fd, bytes, n, bytes.length - n, n);
      if (!got) break;
      n += got;
    }
    if (n !== st.size) throw new TerminalLocalError("file-changed");
    return bytes.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}
async function syncDir(path: string) {
  const h = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}
async function exclusive(path: string, bytes: string, signal: AbortSignal) {
  if (signal.aborted) throw new TerminalLocalError("io-deadline");
  const h = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await h.writeFile(bytes);
    await h.sync();
  } finally {
    await h.close();
  }
  if (signal.aborted) throw new TerminalLocalError("io-deadline");
}
function marker(root: string): Store {
  checkLocalDirectory(root);
  const value: unknown = JSON.parse(readLocalFile(join(root, "initialized"), 1024).toString());
  if (!Value.Check(StoreMarkerSchema, value)) throw new TerminalLocalError("unknown-store-version");
  return { root, storeId: (value as { storeId: string }).storeId };
}
export function checkTerminalStore(stateDir: string): Store {
  checkLocalDirectory(stateDir);
  const root = join(stateDir, TERMINAL_LOCAL_DIR);
  checkLocalDirectory(root);
  let journal: unknown;
  try {
    journal = JSON.parse(readLocalFile(join(root, TERMINAL_JOURNAL_FILE), 2097152).toString());
  } catch (error) {
    throw new TerminalLocalError(
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "journal-missing" : "journal-unreadable-or-corrupt",
    );
  }
  if (!Value.Check(TerminalJournalSchema, journal)) throw new TerminalLocalError("journal-unknown-version-or-shape");
  const keys = journal.resources.map((row) => terminalIdentityKey(row.entry.identity));
  if (
    new Set(keys).size !== keys.length ||
    new Set(journal.resources.map((row) => row.entry.identity.reservationId)).size !== keys.length ||
    journal.resources.some(
      (row) =>
        row.status === "resolved" &&
        (!row.proof || terminalIdentityKey(row.proof.identity) !== terminalIdentityKey(row.entry.identity)),
    )
  )
    throw new TerminalLocalError("journal-invalid-identities");
  const store = marker(root);
  const witness: unknown = JSON.parse(readLocalFile(join(stateDir, ".terminal-initialized-v1"), 1024).toString());
  if (!Value.Check(StoreMarkerSchema, witness) || witness.storeId !== store.storeId)
    throw new TerminalLocalError("initialization-witness-mismatch");
  checkLocalDirectory(join(store.root, "authority"));
  checkLocalDirectory(join(store.root, "receipts"));
  return store;
}
/** Only absence of BOTH terminal root and durable parent witness permits first use.
 * Existing/partial/unknown stores are NEVER reset. A concurrent initializer fails closed. */
export async function initializeTerminalStore(stateDir: string): Promise<Store> {
  if (!localPlainEnvironment()) throw new TerminalLocalError("secure-domain");
  return localBounded(async (signal) => {
    checkLocalDirectory(stateDir);
    const root = join(stateDir, TERMINAL_LOCAL_DIR);
    let exists = true;
    try {
      await lstat(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
    }
    if (exists) {
      const store = checkTerminalStore(stateDir);
      await checkLocalResidue(store);
      return store;
    }
    // A pre-local-authority journal is prior terminal state, not permission to reset.
    try {
      await lstat(join(stateDir, TERMINAL_JOURNAL_FILE));
      throw new TerminalLocalError("legacy-journal-state");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Never infer fresh from a missing journal (or a removed previously initialized root).
    const storeId = token();
    try {
      await exclusive(join(stateDir, ".terminal-initialized-v1"), JSON.stringify({ v: 1, storeId }), signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new TerminalLocalError("initialization-already-claimed");
      throw error;
    }
    await syncDir(stateDir);
    await mkdir(root, { mode: 0o700 });
    await mkdir(join(root, "authority"), { mode: 0o700 });
    await mkdir(join(root, "receipts"), { mode: 0o700 });
    await exclusive(join(root, TERMINAL_JOURNAL_FILE), JSON.stringify({ v: 1, revision: 0, resources: [] }), signal);
    await exclusive(join(root, "initialized"), JSON.stringify({ v: 1, storeId }), signal);
    await syncDir(root);
    await syncDir(stateDir);
    if (signal.aborted) throw new TerminalLocalError("io-deadline");
    return checkTerminalStore(stateDir);
  });
}
export function processNamespaces(pid: number) {
  return {
    pid: readlinkSync(`/proc/${pid}/ns/pid`),
    mnt: readlinkSync(`/proc/${pid}/ns/mnt`),
    user: readlinkSync(`/proc/${pid}/ns/user`),
  };
}
function readProc(path: string, max: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const b = Buffer.alloc(max + 1);
    const n = readSync(fd, b, 0, b.length, 0);
    if (n > max) throw new TerminalLocalError("proc-limit");
    return b.subarray(0, n).toString();
  } finally {
    closeSync(fd);
  }
}
export function localProcess(pid: number) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new TerminalLocalError("process-pid");
  const stat = readProc(`/proc/${pid}/stat`, 8192),
    fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
  const uid = /^Uid:\s+(\d+)/m.exec(readProc(`/proc/${pid}/status`, 16384))?.[1];
  if (!uid || !/^\d+$/.test(fields[19] ?? "")) throw new TerminalLocalError("process-unavailable");
  return {
    bootId: readProc("/proc/sys/kernel/random/boot_id", 128).trim(),
    pid,
    starttime: fields[19]!,
    uid: Number(uid),
  };
}
export const sameLocalProcess = (a: ReturnType<typeof localProcess>, b: ReturnType<typeof localProcess>) =>
  a.bootId === b.bootId && a.pid === b.pid && a.starttime === b.starttime && a.uid === b.uid;
export function localRecordPath(store: Store, kind: "authority" | "receipts", recordId: string): string {
  if (!Value.Check(TOKEN, recordId)) throw new TerminalLocalError("invalid-record-id");
  checkLocalDirectory(store.root);
  checkLocalDirectory(join(store.root, kind));
  return join(store.root, kind, `${recordId}.json`);
}
async function publish(
  store: Store,
  kind: "authority" | "receipts",
  record: { recordId: string; nonce: string },
  signal: AbortSignal,
  valid: () => boolean,
  beforePublish?: () => Promise<void>,
): Promise<TerminalLocalReference> {
  const path = localRecordPath(store, kind, record.recordId),
    bytes = JSON.stringify(record);
  if (!valid() || signal.aborted) throw new TerminalLocalError("producer-revoked");
  const entries = await readdir(join(store.root, kind));
  if (entries.length >= (kind === "receipts" ? 32 : 256)) throw new TerminalLocalError("local-capacity");
  // No replacement of immutable receipts/authority. Temp is never an authority reference.
  const temp = join(store.root, kind, `.pending-${token()}`);
  let linked = false;
  try {
    await exclusive(temp, bytes, signal);
    await beforePublish?.();
    if (!valid() || signal.aborted) throw new TerminalLocalError("producer-revoked");
    await link(temp, path);
    linked = true;
    await unlink(temp);
    await syncDir(join(store.root, kind));
    if (kind === "receipts" && (await readdir(join(store.root, kind))).length > 32)
      throw new TerminalLocalError("receipt-capacity");
    if (!valid() || signal.aborted) throw new TerminalLocalError("producer-revoked");
    return { recordId: record.recordId, nonce: record.nonce, sha256: localHash(bytes) };
  } catch (error) {
    if (linked) await unlink(path).catch(() => {});
    throw error;
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export async function createLocalAuthority(
  stateDir: string,
  input: Omit<TerminalAuthorityRecord, "v" | "recordId" | "nonce" | "storeId" | "createdAt">,
  valid: () => boolean,
) {
  const store = await initializeTerminalStore(stateDir);
  const record: TerminalAuthorityRecord = {
    v: 1,
    ...input,
    storeId: store.storeId,
    recordId: token(),
    nonce: token(),
    createdAt: Date.now(),
  };
  if (
    !Value.Check(TerminalAuthorityRecordSchema, record) ||
    !valid() ||
    record.domain !== "plain" ||
    !record.main ||
    !record.active
  )
    throw new TerminalLocalError("producer-revoked");
  let active = true;
  const reference = await localBounded((signal) =>
    publish(store, "authority", record, signal, () => active && valid()),
  );
  return {
    store,
    reference,
    recordId: record.recordId,
    get active() {
      return active && valid();
    },
    revoke() {
      active = false;
      try {
        unlinkSync(localRecordPath(store, "authority", record.recordId));
      } catch {
        /* absence denies */
      }
    },
  };
}
export function readLocalRecord(
  store: Store,
  kind: "authority" | "receipts",
  reference: TerminalLocalReference,
): unknown {
  const bytes = readLocalFile(localRecordPath(store, kind, reference.recordId));
  if (localHash(bytes) !== reference.sha256) throw new TerminalLocalError("record-hash");
  const record = JSON.parse(bytes.toString()) as { recordId?: string; nonce?: string; storeId?: string };
  if (record.recordId !== reference.recordId || record.nonce !== reference.nonce || record.storeId !== store.storeId)
    throw new TerminalLocalError("record-capability");
  return record;
}
export function verifyLocalAuthority(
  store: Store,
  reference: TerminalLocalReference,
  expected: { pid: number; agentNonce: string; sessionId: string; epoch: string; ownerInstance: string },
): TerminalAuthorityRecord {
  const record = readLocalRecord(store, "authority", reference);
  if (!Value.Check(TerminalAuthorityRecordSchema, record)) throw new TerminalLocalError("authority-shape");
  if (record.domain !== "plain" || !record.main || !record.active) throw new TerminalLocalError("authority-domain");
  if (
    record.process.pid !== expected.pid ||
    record.agentNonce !== expected.agentNonce ||
    record.sessionId !== expected.sessionId ||
    record.epoch !== expected.epoch ||
    record.ownerInstance !== expected.ownerInstance
  )
    throw new TerminalLocalError("authority-scope");
  if (!sameLocalProcess(record.process, localProcess(expected.pid)) || record.process.uid !== process.getuid?.())
    throw new TerminalLocalError("authority-process");
  const peer = processNamespaces(expected.pid),
    self = processNamespaces(process.pid);
  if (JSON.stringify(record.namespaces) !== JSON.stringify(peer) || JSON.stringify(peer) !== JSON.stringify(self))
    throw new TerminalLocalError("authority-namespace");
  return record;
}
export type TerminalReceiptContext = {
  store: Store;
  ownerRecordId: string;
  identity: TerminalPhysicalReceipt["identity"];
  agentProcessIdentity: TerminalPhysicalReceipt["agentProcessIdentity"];
  /** Internal fault-injection seam; never serialized/configured/transmitted. */
  beforePublish?: () => Promise<void>;
};
export async function writePhysicalReceipt(
  context: TerminalReceiptContext,
  physical: TerminalPhysicalReceipt["physical"],
  valid: () => boolean = () => true,
): Promise<TerminalLocalReference> {
  const record: TerminalPhysicalReceipt = {
    v: 1,
    recordId: token(),
    nonce: token(),
    storeId: context.store.storeId,
    ownerRecordId: context.ownerRecordId,
    identity: structuredClone(context.identity),
    agentProcessIdentity: { ...context.agentProcessIdentity },
    physical: structuredClone(physical),
  };
  if (!Value.Check(TerminalPhysicalReceiptSchema, record)) throw new TerminalLocalError("receipt-not-reaped");
  return localBounded((signal) => publish(context.store, "receipts", record, signal, valid, context.beforePublish));
}
const managedKey = (x: TerminalPhysicalReceipt["physical"]["identitiesChecked"][number]) =>
  JSON.stringify([x.bootId, x.pid, x.starttime, x.uid, x.sid, x.pgid, x.role]);
export function verifyLocalReceipt(store: Store, proof: TerminalReapProof, entry: TerminalResourceEntry): boolean {
  if (!proof.receipt) return false;
  try {
    const record = readLocalRecord(store, "receipts", proof.receipt);
    if (!Value.Check(TerminalPhysicalReceiptSchema, record) || record.agentProcessIdentity.uid !== process.getuid?.())
      return false;
    const keys = record.physical.identitiesChecked.map(managedKey).sort();
    return (
      terminalIdentityKey(record.identity) === terminalIdentityKey(entry.identity) &&
      sameLocalProcess(record.agentProcessIdentity, entry.agentProcessIdentity) &&
      JSON.stringify(keys) === JSON.stringify(proof.identitiesChecked.map(managedKey).sort()) &&
      entry.managed.every((x) => keys.includes(managedKey(x)))
    );
  } catch {
    return false;
  }
}
async function checkLocalResidue(store: Store): Promise<void> {
  const journal = JSON.parse(readLocalFile(join(store.root, TERMINAL_JOURNAL_FILE), 2097152).toString()) as Static<
    typeof TerminalJournalSchema
  >;
  for (const kind of ["authority", "receipts"] as const) {
    const names = await readdir(join(store.root, kind));
    if (names.length > (kind === "authority" ? 256 : 32)) throw new TerminalLocalError("local-capacity");
    for (const name of names) {
      if (!/^[A-Za-z0-9_-]{32,64}\.json$/.test(name)) throw new TerminalLocalError("unresolved-local-state");
      const raw: unknown = JSON.parse(readLocalFile(join(store.root, kind, name)).toString());
      if (kind === "authority") {
        if (
          !Value.Check(TerminalAuthorityRecordSchema, raw) ||
          `${raw.recordId}.json` !== name ||
          raw.storeId !== store.storeId ||
          !raw.active ||
          !raw.main ||
          raw.domain !== "plain" ||
          raw.process.uid !== process.getuid?.() ||
          !sameLocalProcess(raw.process, localProcess(raw.process.pid)) ||
          JSON.stringify(raw.namespaces) !== JSON.stringify(processNamespaces(raw.process.pid)) ||
          JSON.stringify(raw.namespaces) !== JSON.stringify(processNamespaces(process.pid))
        )
          throw new TerminalLocalError("residual-authority-state");
      } else if (
        !Value.Check(TerminalPhysicalReceiptSchema, raw) ||
        `${raw.recordId}.json` !== name ||
        raw.storeId !== store.storeId ||
        raw.agentProcessIdentity.uid !== process.getuid?.() ||
        journal.resources.some(
          (row) =>
            row.entry.identity.reservationId === raw.identity.reservationId &&
            (terminalIdentityKey(row.entry.identity) !== terminalIdentityKey(raw.identity) ||
              !sameLocalProcess(row.entry.agentProcessIdentity, raw.agentProcessIdentity)),
        )
      )
        throw new TerminalLocalError("residual-receipt-state");
    }
  }
}
export function deletePhysicalReceipt(store: Store, reference: TerminalLocalReference): void {
  try {
    readLocalRecord(store, "receipts", reference);
    unlinkSync(localRecordPath(store, "receipts", reference.recordId));
  } catch {
    /* retained metadata never authorizes a release */
  }
}

/** Reload-safe receipt handoff comes from the same immutable owned files H verifies.
 * No proof is minted here: each later inventory still binds a new current challenge. */
export async function readPhysicalReceipts(store: Store) {
  const names = await readdir(join(store.root, "receipts"));
  if (names.length > 32) throw new TerminalLocalError("receipt-capacity");
  return names.map((name) => {
    if (!/^[A-Za-z0-9_-]{32,64}\.json$/.test(name)) throw new TerminalLocalError("unresolved-local-state");
    const bytes = readLocalFile(join(store.root, "receipts", name));
    const record: unknown = JSON.parse(bytes.toString());
    if (
      !Value.Check(TerminalPhysicalReceiptSchema, record) ||
      record.storeId !== store.storeId ||
      record.agentProcessIdentity.uid !== process.getuid?.()
    )
      throw new TerminalLocalError("residual-receipt-state");
    return { record, reference: { recordId: record.recordId, nonce: record.nonce, sha256: localHash(bytes) } };
  });
}
