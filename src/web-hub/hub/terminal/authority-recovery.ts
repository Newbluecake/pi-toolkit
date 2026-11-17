/** Assembly-only authority retirement. This never releases a physical resource or
 * replays an archive. The existing singleton + bound socket/directory identity is
 * the sole ownership gate (an abstract socket is NOT a cross-netns file lock). */
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  writeSync,
  type Stats,
} from "node:fs";
import { Value } from "@sinclair/typebox/value";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  checkLocalDirectory,
  checkTerminalStore,
  classifyLocalAuthority,
  initializeTerminalStore,
  inspectTerminalResidue,
  localBounded,
  localHash,
  localPlainEnvironment,
  readLocalFile,
  TerminalLocalError,
  localProcess,
  TerminalAuthorityRecordSchema,
  type TerminalAuthorityRecord,
} from "../../protocol/terminal-local.js";
import { TERMINAL_JOURNAL_FILE } from "../../protocol/terminal.js";
import { identityEquals, verifyBoundSocket } from "../../protocol/paths.js";
import type { HubAssembly } from "../assembly.js";
import { auditTerminal } from "../audit.js";

export const TERMINAL_AUTHORITY_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
const ARCHIVE = ".terminal-authority-archive-v1";
const FILE = /^[A-Za-z0-9_-]{32,64}\.json$/;
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;
const PENDING = /^\.pending-[A-Za-z0-9_-]{32,64}$/;
const COMPLETE = Buffer.from(JSON.stringify({ v: 1, kind: "authority-retirement-only" }));
type Fingerprint = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; hash: string };
type RecordSnapshot = { name: string; record: TerminalAuthorityRecord; bytes: Buffer; fingerprint: Fingerprint };
export type RecoveryStage =
  | "snapshot-written-not-durable"
  | "prepared-durable-before-rename"
  | "renamed-before-dir-fsync"
  | "renamed-before-completion-marker";
/** Internal fault port only. No environment/settings/wire/global hooks. Events fire
 * AFTER the named syscall returned; SIGKILL tests do not simulate power failure. */
export interface AuthorityRecoveryTestDeps {
  stage?(event: { stage: RecoveryStage; ordinal: number; completed: readonly string[] }): Promise<void>;
  write?(fd: number, bytes: Buffer): number;
  beforeSyscall?(op: "snapshot-fsync" | "manifest-fsync" | "rename" | "source-dir-fsync" | "target-dir-fsync"): void;
  afterLastRenameBeforeFinalCheck?(): Promise<void>;
  onFinalValidationAttempt?(attempt: number): void;
  onPublicationPending?(): void;
}
export function authorityArchiveBudget(input: {
  transactions: number;
  existingBytes: number;
  snapshotBytes: number;
  candidates: number;
  manifestBytes: number;
  completionBytes: number;
}): number {
  const values = Object.values(input);
  const planned = input.snapshotBytes * 2 + input.manifestBytes + input.completionBytes;
  if (
    values.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    input.transactions >= 64 ||
    input.candidates > 256 ||
    input.snapshotBytes > 2 * 1024 * 1024 ||
    !Number.isSafeInteger(planned) ||
    input.existingBytes + planned > TERMINAL_AUTHORITY_ARCHIVE_MAX_BYTES
  )
    throw new TerminalLocalError("authority-archive-capacity");
  return planned;
}
const fail = (reason: string): never => {
  throw new TerminalLocalError(reason);
};
const fingerprint = (st: Stats, bytes: Buffer): Fingerprint => ({
  dev: st.dev,
  ino: st.ino,
  size: st.size,
  mtimeMs: st.mtimeMs,
  ctimeMs: st.ctimeMs,
  hash: localHash(bytes),
});
function readExact(path: string, max = 131072, links = 1) {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (["ELOOP", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) fail("unsafe-file");
    throw error;
  }
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.uid !== process.getuid?.() ||
      (st.mode & 0o777) !== 0o600 ||
      st.nlink !== links ||
      !Number.isSafeInteger(st.size) ||
      st.size < 0 ||
      st.size > max
    )
      fail("unsafe-file");
    const b = Buffer.alloc(st.size + 1);
    let n = 0,
      got: number;
    while (n < b.length && (got = readSync(fd, b, n, b.length - n, n)) > 0) n += got;
    const end = fstatSync(fd);
    if (
      n !== st.size ||
      JSON.stringify(fingerprint(st, b.subarray(0, n))) !== JSON.stringify(fingerprint(end, b.subarray(0, n)))
    )
      fail("file-changed");
    const bytes = b.subarray(0, n);
    return { bytes, fingerprint: fingerprint(st, bytes), st };
  } finally {
    closeSync(fd);
  }
}
function sameFile(a: Fingerprint, b: Fingerprint, renamed = false) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.hash === b.hash &&
    a.mtimeMs === b.mtimeMs &&
    (renamed || a.ctimeMs === b.ctimeMs)
  );
}
class HeldDirectory {
  readonly fd: number;
  readonly identity: Stats;
  constructor(readonly path: string) {
    checkLocalDirectory(path);
    this.fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    this.identity = fstatSync(this.fd);
    try {
      this.check();
    } catch (error) {
      closeSync(this.fd);
      throw error;
    }
  }
  check() {
    checkLocalDirectory(this.path);
    if (!identityEquals(lstatSync(this.path), this.identity)) fail("authority-recovery-state-changed");
  }
  at(name: string) {
    return `/proc/self/fd/${this.fd}/${name}`;
  }
  sync() {
    fsyncSync(this.fd);
  }
  close() {
    closeSync(this.fd);
  }
}
/** Scan known partial layouts too: snapshots, retired, manifest/temp, completion
 * all count logical stat bytes. No GC, symlink following or manifest authority. */
export function scanAuthorityArchive(path: string) {
  let transactions = 0,
    bytes = 0;
  try {
    checkLocalDirectory(path);
    const names = readdirSync(path);
    if (names.length > 64) fail("authority-archive-capacity");
    for (const name of names) {
      if (!TOKEN.test(name)) fail("authority-archive-unsafe");
      const dir = join(path, name);
      checkLocalDirectory(dir);
      transactions++;
      const entries = readdirSync(dir);
      if (entries.length > 5) fail("authority-archive-unsafe");
      for (const entry of entries) {
        if (entry === "snapshots" || entry === "retired") {
          const sub = join(dir, entry);
          checkLocalDirectory(sub);
          const files = readdirSync(sub);
          if (files.length > 256) fail("authority-archive-unsafe");
          for (const file of files) {
            if (!FILE.test(file)) fail("authority-archive-unsafe");
            bytes += archiveFileBytes(join(sub, file), 131072);
          }
        } else if (["manifest.json", ".pending-manifest.json", "complete.json"].includes(entry)) {
          bytes += archiveFileBytes(join(dir, entry), 2 * 1024 * 1024);
        } else fail("authority-archive-unsafe");
        if (bytes > TERMINAL_AUTHORITY_ARCHIVE_MAX_BYTES) fail("authority-archive-capacity");
      }
    }
    return { transactions, bytes };
  } catch (error) {
    if (error instanceof TerminalLocalError && error.reason === "authority-archive-capacity") throw error;
    throw new TerminalLocalError("authority-archive-unsafe");
  }
}
function archiveFileBytes(path: string, max: number): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.uid !== process.getuid?.() ||
      (st.mode & 0o777) !== 0o600 ||
      st.nlink !== 1 ||
      !Number.isSafeInteger(st.size) ||
      st.size < 0 ||
      st.size > max
    )
      fail("authority-archive-unsafe");
    return st.size;
  } finally {
    closeSync(fd);
  }
}
type AssemblyOwner = Pick<HubAssembly, "paths" | "socketIdentity" | "singletonOwner" | "startup" | "isClosing" | "log">;
/** Deliberately accepts real assembly ownership, not an abstract lock or boolean.
 * Only production caller is assembleTerminal, after acquireSingleton succeeds. */
export async function prepareTerminalStore(ctx: AssemblyOwner, test: AuthorityRecoveryTestDeps = {}) {
  const started = Date.now(),
    deadlineAt = started + 2000;
  let recovering = false,
    moved = 0,
    publicationPending = false,
    audited = false;
  const audit = (ok: boolean, code: string) => {
    if (audited || !recovering) return;
    audited = true;
    auditTerminal(ctx.log, { op: "authority-recovery", ok, code, n: moved, ms: Date.now() - started });
  };
  const pending = localBounded(
    async (ioSignal) => {
      const signal = AbortSignal.any([ioSignal, ctx.startup.signal]);
      const held: HeldDirectory[] = [];
      const tick = () => {
        if (signal.aborted || Date.now() >= deadlineAt) fail("io-deadline");
        if (
          ctx.isClosing() ||
          !ctx.socketIdentity ||
          ctx.singletonOwner?.kind !== "owner" ||
          !ctx.singletonOwner.server.listening ||
          ctx.singletonOwner.identity !== ctx.socketIdentity
        )
          fail("authority-recovery-not-owner");
        for (const dir of held) dir.check();
      };
      const current = async () => {
        tick();
        const expected = ctx.socketIdentity!;
        try {
          const actual = await verifyBoundSocket(ctx.paths.socketPath, expected.dir);
          if (!identityEquals(actual.socket, expected.socket) || !identityEquals(actual.dir, expected.dir))
            fail("authority-recovery-not-owner");
        } catch {
          fail("authority-recovery-not-owner");
        }
        tick();
      };
      try {
        await current();
        try {
          return await initializeTerminalStore(ctx.paths.stateDir, signal);
        } catch (error) {
          if (!(error instanceof TerminalLocalError) || error.reason !== "stale-authority-prev-boot") throw error;
        }
        recovering = true;
        await current();
        if (!localPlainEnvironment()) fail("secure-domain");
        const store = checkTerminalStore(ctx.paths.stateDir),
          inspection = inspectTerminalResidue(store);
        if (!inspection.stale.length) fail("authority-recovery-state-changed");
        if (inspection.journal.resources.length) fail("stale-authority-prev-boot-journal-not-empty");
        if (inspection.receiptCount) fail("stale-authority-prev-boot-receipts-not-empty");
        const hold = (path: string) => {
          const dir = new HeldDirectory(path);
          held.push(dir);
          return dir;
        };
        const state = hold(ctx.paths.stateDir),
          root = hold(store.root),
          authority = hold(join(store.root, "authority"));
        hold(join(store.root, "receipts"));
        const fixed = [
          { path: state.at(".terminal-initialized-v1"), ...readExact(state.at(".terminal-initialized-v1"), 1024) },
          { path: root.at("initialized"), ...readExact(root.at("initialized"), 1024) },
          { path: root.at(TERMINAL_JOURNAL_FILE), ...readExact(root.at(TERMINAL_JOURNAL_FILE), 2097152) },
        ];
        const snapshot = (item: (typeof inspection.stale)[number]): RecordSnapshot => {
          const fresh = readExact(authority.at(item.name));
          if (!fresh.bytes.equals(item.bytes)) fail("authority-recovery-state-changed");
          return { ...item, fingerprint: fresh.fingerprint };
        };
        const stale = inspection.stale.map(snapshot),
          originals = inspection.current.map(snapshot);
        const remaining = new Set(stale.map((x) => x.name));
        const invariant = () => {
          tick();
          if (checkTerminalStore(ctx.paths.stateDir).storeId !== store.storeId)
            fail("authority-recovery-state-changed");
          for (const file of fixed)
            if (!sameFile(file.fingerprint, readExact(file.path, 2097152).fingerprint))
              fail("authority-recovery-state-changed");
          if (readdirSync(join(store.root, "receipts")).length) fail("authority-recovery-state-changed");
          for (const item of originals) {
            if (!sameFile(item.fingerprint, readExact(authority.at(item.name)).fingerprint))
              fail("authority-recovery-state-changed");
            if (classifyLocalAuthority(item.record) !== "current") fail("authority-recovery-state-changed");
          }
        };
        await current();
        invariant();
        // Before creating any archive, re-inspect every directory entry (no pending exception).
        inspectTerminalResidue(store);
        const archivePath = join(ctx.paths.stateDir, ARCHIVE);
        let existing = { transactions: 0, bytes: 0 };
        try {
          lstatSync(archivePath);
          existing = scanAuthorityArchive(archivePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const transaction = randomBytes(24).toString("base64url");
        const manifest = Buffer.from(
          JSON.stringify({
            v: 1,
            kind: "authority-retirement-only",
            transaction,
            storeId: store.storeId,
            currentBoot: localProcess(process.pid),
            journalRevision: inspection.journal.revision,
            journalHash: fixed[2]!.fingerprint.hash,
            candidates: stale.map((x) => ({ name: x.name, process: x.record.process, fingerprint: x.fingerprint })),
          }),
        );
        const planned = authorityArchiveBudget({
          transactions: existing.transactions,
          existingBytes: existing.bytes,
          snapshotBytes: stale.reduce((n, x) => n + x.bytes.length, 0),
          candidates: stale.length,
          manifestBytes: manifest.length,
          completionBytes: COMPLETE.length,
        });
        await current();
        invariant();
        try {
          mkdirSync(state.at(ARCHIVE), { mode: 0o700 });
          state.sync();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const archive = hold(archivePath);
        mkdirSync(archive.at(transaction), { mode: 0o700 });
        const tx = hold(join(archivePath, transaction));
        mkdirSync(tx.at("snapshots"), { mode: 0o700 });
        mkdirSync(tx.at("retired"), { mode: 0o700 });
        const snapshots = hold(join(tx.path, "snapshots")),
          retired = hold(join(tx.path, "retired"));
        let spent = 0;
        const reserve = (n: number) => {
          if (
            !Number.isSafeInteger(n) ||
            n < 0 ||
            spent + n > planned ||
            existing.bytes + spent + (planned - spent) > TERMINAL_AUTHORITY_ARCHIVE_MAX_BYTES
          )
            fail("authority-archive-capacity");
          spent += n;
        };
        const durable = async (path: string, bytes: Buffer, op?: "snapshot-fsync" | "manifest-fsync", ordinal = 0) => {
          await current();
          invariant();
          reserve(bytes.length);
          const fd = openSync(
            path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
          try {
            if ((test.write ?? writeSync)(fd, bytes) !== bytes.length) fail("authority-archive-io");
            if (op === "snapshot-fsync")
              await test.stage?.({
                stage: "snapshot-written-not-durable",
                ordinal,
                completed: ["snapshot-create", "snapshot-write"],
              });
            tick();
            if (op) test.beforeSyscall?.(op);
            fsyncSync(fd);
            tick();
          } finally {
            closeSync(fd);
          }
        };
        for (const [i, item] of stale.entries())
          await durable(snapshots.at(item.name), item.bytes, "snapshot-fsync", i);
        await durable(tx.at("manifest.json"), manifest, "manifest-fsync");
        snapshots.sync();
        retired.sync();
        tx.sync();
        archive.sync();
        state.sync();
        await test.stage?.({
          stage: "prepared-durable-before-rename",
          ordinal: 0,
          completed: ["snapshot-fsync", "manifest-fsync", "transaction-fsync", "archive-fsync", "state-fsync"],
        });
        for (const [i, item] of stale.entries()) {
          await current();
          invariant();
          const check = inspectTerminalResidue(store);
          if (check.stale.length !== remaining.size || check.stale.some((x) => !remaining.has(x.name)))
            fail("authority-recovery-state-changed");
          const fresh = readExact(authority.at(item.name));
          if (!sameFile(item.fingerprint, fresh.fingerprint) || classifyLocalAuthority(item.record) !== "previous-boot")
            fail("authority-recovery-state-changed");
          // No await between this final exact source check and rename. Destination is
          // exclusive by a fresh random transaction directory, never a reused backup.
          tick();
          test.beforeSyscall?.("rename");
          renameSync(authority.at(item.name), retired.at(item.name));
          if (!sameFile(item.fingerprint, readExact(retired.at(item.name)).fingerprint, true))
            fail("authority-recovery-state-changed");
          moved++;
          remaining.delete(item.name);
          reserve(item.bytes.length);
          await test.stage?.({
            stage: "renamed-before-dir-fsync",
            ordinal: i,
            completed: ["rename", "target-identity-check"],
          });
          await current();
          invariant();
          test.beforeSyscall?.("source-dir-fsync");
          authority.sync();
          test.beforeSyscall?.("target-dir-fsync");
          retired.sync();
          tick();
        }
        await test.stage?.({
          stage: "renamed-before-completion-marker",
          ordinal: stale.length - 1,
          completed: ["all-renames", "source-dir-fsync", "target-dir-fsync"],
        });
        await test.afterLastRenameBeforeFinalCheck?.();
        const observedPending = new Set<string>();
        for (let attempt = 0; ; attempt++) {
          await current();
          invariant();
          test.onFinalValidationAttempt?.(attempt);
          const pending = readdirSync(authority.path).filter((name) => PENDING.test(name));
          if (!pending.length) {
            // Only the DEFAULT strict inspector can conclude usable (nlink1, no pending).
            const final = inspectTerminalResidue(checkTerminalStore(ctx.paths.stateDir));
            if (final.stale.length) fail("authority-recovery-state-changed");
            break;
          }
          // Private transient inspection never returns a usable record. Validate every
          // other entry; only pending + its exact linked final inode may have nlink2.
          const pendingFiles = pending.map((name) => {
            observedPending.add(name);
            const fd = openSync(authority.at(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
              const st = fstatSync(fd);
              if (
                !st.isFile() ||
                st.uid !== process.getuid?.() ||
                (st.mode & 0o777) !== 0o600 ||
                (st.nlink !== 1 && st.nlink !== 2) ||
                st.size > 131072
              )
                fail("unsafe-file");
              return { st };
            } finally {
              closeSync(fd);
            }
          });
          if (observedPending.size > 256) fail("authority-publication-unsettled");
          const names = readdirSync(authority.path);
          if (names.length > 256) fail("local-capacity");
          for (const name of names) {
            if (PENDING.test(name)) continue;
            if (!FILE.test(name)) fail("unresolved-local-state");
            const st = lstatSync(authority.at(name));
            const paired = pendingFiles.filter((p) => identityEquals(p.st, st));
            const file = readExact(authority.at(name), 131072, paired.length === 1 && st.nlink === 2 ? 2 : 1);
            let raw: unknown;
            try {
              raw = JSON.parse(file.bytes.toString()) as TerminalAuthorityRecord;
            } catch {
              fail("authority-corrupt");
            }
            // Use the same closed-schema validation as default inspection, without
            // ever relaxing its reader. A paired final must already be fully durable.
            validatePublishedRecord(raw, name, store.storeId);
          }
          for (const p of pendingFiles)
            if (
              p.st.nlink === 2 &&
              names.filter((n) => FILE.test(n) && identityEquals(lstatSync(authority.at(n)), p.st)).length !== 1
            )
              fail("unsafe-file");
          publicationPending = true;
          test.onPublicationPending?.();
          if (attempt >= 8 || Date.now() >= deadlineAt) fail("authority-publication-unsettled");
          const delay = Math.min(5 * 2 ** attempt, Math.max(0, deadlineAt - Date.now() - 1));
          await pause(delay, signal); // shared absolute deadline; never reset 2s
        }
        await current();
        invariant();
        await durable(tx.at("complete.json"), COMPLETE);
        tx.sync();
        archive.sync();
        tick();
        audit(true, "E_AUTHORITY_RECOVERED");
        return store;
      } catch (error) {
        const typed =
          error instanceof TerminalLocalError
            ? error
            : new TerminalLocalError(recovering ? "authority-archive-io" : "local-store-unavailable");
        audit(false, typed.reason === "io-deadline" ? "E_AUTHORITY_DEADLINE" : "E_AUTHORITY_BLOCKED");
        throw typed;
      } finally {
        for (const dir of held.reverse()) dir.close();
      }
    },
    Math.max(0, deadlineAt - Date.now()),
  );
  return withStartupAbort(pending, ctx.startup.signal).catch((error: unknown) => {
    const reason = error instanceof TerminalLocalError ? error.reason : "local-store-unavailable";
    audit(false, reason === "io-deadline" ? "E_AUTHORITY_DEADLINE" : "E_AUTHORITY_BLOCKED");
    if (reason === "io-deadline" && publicationPending && !ctx.startup.signal.aborted)
      throw new TerminalLocalError("authority-publication-unsettled");
    throw error;
  });
}

function validatePublishedRecord(raw: unknown, name: string, storeId: string) {
  if (
    !Value.Check(TerminalAuthorityRecordSchema, raw) ||
    `${raw.recordId}.json` !== name ||
    raw.storeId !== storeId ||
    !raw.main ||
    !raw.active ||
    raw.domain !== "plain" ||
    raw.process.uid !== process.getuid?.()
  )
    throw new TerminalLocalError("authority-corrupt");
  if (classifyLocalAuthority(raw) !== "current") fail("authority-recovery-state-changed");
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(new TerminalLocalError("io-deadline"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    timer.unref();
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

/** Startup cancellation returns immediately even if a private IO/barrier has not
 * settled. The merged signal fences its late continuation; only the real worker's
 * finally closes held fds. This is cancellation, not cancellation of kernel IO. */
function withStartupAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(new TerminalLocalError("io-deadline"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
    if (signal.aborted) aborted();
  });
}
