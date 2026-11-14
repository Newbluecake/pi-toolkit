/** Retained default-tree coordinates: adoption provenance is NOT permission to read.
 * No timers, scans or persistent fds. Snapshots consume opaque certificates without IO.
 * Every D7 read uses a new fd-anchored lease and persisted expected inode chain.
 */
import { createHash } from "node:crypto";
import { constants, openSync, fstatSync, lstatSync, readSync, closeSync } from "node:fs";
import { dirname, basename, normalize, isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { isValidRestoreSessionFile, RESTORE_SESSION_ID_RE, RESTORE_MAX_ATTEMPTS } from "../../protocol/spawn.js";
import { defaultSessionDirForCwd, type RestoreSessionFs } from "./restore-plan.js";

export interface InodeRef {
  dev: number;
  ino: number;
}
export interface PathBaseline {
  bindingDigest: string;
  chain: readonly InodeRef[];
  file?: InodeRef;
}
export interface SessionGuard {
  kind: "default-tree-v1";
  baseline?: PathBaseline;
  lazyIntent?: { attempt: number };
}
export interface SessionBinding {
  spawnId: string;
  cwd: string;
  sessionId: string;
  sessionFile: string;
}
export interface RetainedStat extends InodeRef {
  uid: number;
  nlink: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}
export interface RetainedSessionFs {
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): RetainedStat;
  lstatSync(path: string): RetainedStat;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
}
export function defaultRetainedSessionFs(): RetainedSessionFs {
  return { openSync, fstatSync, lstatSync, readSync, closeSync };
}
/** Local mirror: hub boundary forbids importing core (I8). */
export function clampProofSpanMs(span: number): number {
  return Number.isFinite(span) ? Math.max(0, Math.min(20, span)) : 0;
}
export interface ProofWorkBudget {
  deadlineMono: number;
  opsLeft: number;
  segmentsLeft: number;
}
/** Opaque runtime token. Only its issuing factory's WeakMap gives it meaning. */
export type GuardedReadLease = RestoreSessionFs;
export interface CachedAdoptionProof {
  readonly baseline: PathBaseline;
  readonly leafPresent: boolean;
}
export interface LazyBindingPermit {
  attempt: number;
  sourceRevision: number;
  sessionId: string;
  cwd: string;
  parentBaseline: PathBaseline;
  oldSessionFile: string;
  actualForkIdentity: { pid: number; bootId: string; procStartTicks: number; uid: number };
  state: "active" | "consumed";
}
export type GuardResult<T> = { ok: true; value: T } | { ok: false; failure: "session-invalid"; detail: string };
export interface RetainedSessionGuard {
  budget(remainingMs?: number): ProofWorkBudget;
  available(budget: ProofWorkBudget): boolean;
  capture(
    binding: SessionBinding,
    revision: number,
    expected?: PathBaseline,
    budget?: ProofWorkBudget,
  ): GuardResult<CachedAdoptionProof>;
  matches(proof: CachedAdoptionProof | undefined, binding: SessionBinding, revision: number): boolean;
  withRead<T>(
    binding: SessionBinding,
    revision: number,
    expected: PathBaseline | undefined,
    callback: (fs: GuardedReadLease, proof: CachedAdoptionProof) => T,
    budget?: ProofWorkBudget,
  ): GuardResult<T>;
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function inode(v: unknown): v is InodeRef {
  return (
    record(v) &&
    Object.keys(v).every((k) => k === "dev" || k === "ino") &&
    typeof v["dev"] === "number" &&
    Number.isSafeInteger(v["dev"]) &&
    v["dev"] >= 0 &&
    typeof v["ino"] === "number" &&
    Number.isSafeInteger(v["ino"]) &&
    v["ino"] >= 0
  );
}
function same(a: InodeRef, b: InodeRef): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
export function bindingDigest(b: SessionBinding): string {
  return createHash("sha256")
    .update(JSON.stringify([b.spawnId, b.cwd, b.sessionId, b.sessionFile]))
    .digest("hex");
}
export function isSessionGuard(v: unknown, b?: SessionBinding): v is SessionGuard {
  if (
    !record(v) ||
    v["kind"] !== "default-tree-v1" ||
    !Object.keys(v).every((k) => ["kind", "baseline", "lazyIntent"].includes(k))
  )
    return false;
  const base = v["baseline"];
  if (base !== undefined) {
    if (
      !record(base) ||
      !Object.keys(base).every((k) => ["bindingDigest", "chain", "file"].includes(k)) ||
      typeof base["bindingDigest"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(base["bindingDigest"]) ||
      !Array.isArray(base["chain"]) ||
      base["chain"].length === 0 ||
      base["chain"].length > 129 ||
      !base["chain"].every(inode) ||
      (base["file"] !== undefined && !inode(base["file"]))
    )
      return false;
    if (
      b !== undefined &&
      (base["bindingDigest"] !== bindingDigest(b) ||
        base["chain"].length !== dirname(b.sessionFile).split("/").filter(Boolean).length + 1)
    )
      return false;
  }
  const lazy = v["lazyIntent"];
  return (
    lazy === undefined ||
    (record(lazy) &&
      Object.keys(lazy).length === 1 &&
      typeof lazy["attempt"] === "number" &&
      Number.isInteger(lazy["attempt"]) &&
      lazy["attempt"] >= 1 &&
      lazy["attempt"] <= RESTORE_MAX_ATTEMPTS)
  );
}
export function isPiLazyBasename(file: string, id: string): boolean {
  const name = basename(file),
    suffix = `_${id}.jsonl`;
  if (!name.endsWith(suffix)) return false;
  const stamp = name.slice(0, -suffix.length);
  if (!/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/.test(stamp)) return false;
  const iso = `${stamp.slice(0, 13)}:${stamp.slice(14, 16)}:${stamp.slice(17, 19)}.${stamp.slice(20)}`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && new Date(ms).toISOString().replace(/[:.]/g, "-") === stamp;
}
export function createRetainedSessionGuard(opts: {
  agentDir: string;
  uid: number;
  fs?: RetainedSessionFs;
  monoNow?: () => number;
}): RetainedSessionGuard {
  const fs = opts.fs ?? defaultRetainedSessionFs(),
    monoNow = opts.monoNow ?? (() => performance.now());
  const issued = new WeakMap<CachedAdoptionProof, { digest: string; revision: number }>();
  function budget(remainingMs = 20): ProofWorkBudget {
    return { deadlineMono: monoNow() + clampProofSpanMs(remainingMs), opsLeft: 512, segmentsLeft: 128 };
  }
  function available(work: ProofWorkBudget): boolean {
    return monoNow() < work.deadlineMono && work.opsLeft > 0 && work.segmentsLeft >= 0;
  }
  function check(work: ProofWorkBudget): void {
    if (!available(work)) throw new Error("proof-budget");
  }
  function op<T>(work: ProofWorkBudget, fn: () => T): T {
    check(work);
    work.opsLeft--;
    return fn();
  }
  function walk<T>(
    b: SessionBinding,
    revision: number,
    expected: PathBaseline | undefined,
    work: ProofWorkBudget,
    callback: (proof: CachedAdoptionProof, parent: number, leaf: RetainedStat | undefined) => T,
  ): GuardResult<T> {
    const fds: number[] = [];
    try {
      check(work);
      if (
        !RESTORE_SESSION_ID_RE.test(b.sessionId) ||
        !isValidRestoreSessionFile(b.sessionFile) ||
        !isAbsolute(opts.agentDir) ||
        normalize(opts.agentDir) !== opts.agentDir ||
        normalize(b.sessionFile) !== b.sessionFile ||
        dirname(b.sessionFile) !== defaultSessionDirForCwd(b.cwd, opts.agentDir)
      )
        throw new Error("default-tree-required");
      const segments = dirname(b.sessionFile).split("/").filter(Boolean);
      if (
        segments.length > 128 ||
        segments.some((s) => s === "." || s === "..") ||
        (expected !== undefined && !isSessionGuard({ kind: "default-tree-v1", baseline: expected }, b))
      )
        throw new Error("binding-mismatch");
      const chain: InodeRef[] = [];
      const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
      if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY || !constants.O_NONBLOCK)
        throw new Error("nofollow-unavailable");
      let parent = -1;
      for (let i = 0; i <= segments.length; i++) {
        check(work);
        if (i > 0) {
          if (work.segmentsLeft <= 0) throw new Error("proof-budget");
          work.segmentsLeft--;
        }
        const path = i === 0 ? "/" : `/proc/self/fd/${parent}/${segments[i - 1]}`;
        parent = op(work, () => fs.openSync(path, flags));
        fds.push(parent);
        const st = op(work, () => fs.fstatSync(parent));
        if (
          !st.isDirectory() ||
          !Number.isSafeInteger(st.dev) ||
          st.dev < 0 ||
          !Number.isSafeInteger(st.ino) ||
          st.ino < 0
        )
          throw new Error("directory-invalid");
        const exp = expected?.chain[i];
        if (expected !== undefined && (exp === undefined || !same(st, exp))) throw new Error("chain-changed");
        if (i >= segments.length - 1 && st.uid !== opts.uid) throw new Error("directory-owner");
        chain.push({ dev: st.dev, ino: st.ino });
      }
      let leaf: RetainedStat | undefined;
      try {
        leaf = op(work, () => fs.lstatSync(`/proc/self/fd/${parent}/${basename(b.sessionFile)}`));
      } catch (err) {
        if (!record(err) || err["code"] !== "ENOENT") throw err;
      }
      if (
        leaf !== undefined &&
        (!leaf.isFile() ||
          leaf.isSymbolicLink() ||
          leaf.uid !== opts.uid ||
          leaf.nlink !== 1 ||
          !Number.isSafeInteger(leaf.dev) ||
          leaf.dev < 0 ||
          !Number.isSafeInteger(leaf.ino) ||
          leaf.ino < 0)
      )
        throw new Error("leaf-invalid");
      if (leaf !== undefined && expected?.file !== undefined && !same(leaf, expected.file))
        throw new Error("leaf-changed");
      const base: PathBaseline = Object.freeze({
        bindingDigest: bindingDigest(b),
        chain: Object.freeze(chain.map((ref) => Object.freeze(ref))),
        ...(leaf !== undefined
          ? { file: Object.freeze({ dev: leaf.dev, ino: leaf.ino }) }
          : expected?.file !== undefined
            ? { file: Object.freeze({ ...expected.file }) }
            : {}),
      });
      check(work);
      const proof: CachedAdoptionProof = Object.freeze({ baseline: base, leafPresent: leaf !== undefined });
      issued.set(proof, { digest: base.bindingDigest, revision });
      const value = callback(proof, parent, leaf);
      check(work);
      return { ok: true, value };
    } catch {
      return { ok: false, failure: "session-invalid", detail: "default-tree-unproven" };
    } finally {
      for (const fd of fds.reverse()) {
        try {
          fs.closeSync(fd);
        } catch {
          /* best effort; close all owned fds */
        }
      }
    }
  }
  return {
    budget,
    available,
    capture: (b, revision, expected, work = budget()) => walk(b, revision, expected, work, (proof) => proof),
    matches(proof, b, revision) {
      const entry = proof === undefined ? undefined : issued.get(proof);
      return entry?.digest === bindingDigest(b) && entry.revision === revision;
    },
    withRead(b, revision, expected, callback, work = budget()) {
      return walk(b, revision, expected, work, (proof, parent, leaf) => {
        let fd: number | undefined,
          active = true;
        try {
          if (leaf !== undefined) {
            fd = op(work, () =>
              fs.openSync(
                `/proc/self/fd/${parent}/${basename(b.sessionFile)}`,
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
              ),
            );
            const st = op(work, () => fs.fstatSync(fd!));
            if (!st.isFile() || st.uid !== opts.uid || st.nlink !== 1 || !same(st, leaf))
              throw new Error("leaf-changed");
          }
          const reader: RestoreSessionFs = {
            lstatSync(p) {
              if (!active || p !== b.sessionFile) throw new Error("lease-expired");
              if (leaf === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
              return leaf;
            },
            readHeadSync(p, max) {
              if (!active || p !== b.sessionFile || fd === undefined) throw new Error("lease-expired");
              const buf = Buffer.alloc(Math.min(4096, Math.max(0, max)));
              const n = op(work, () => fs.readSync(fd!, buf, 0, buf.length, 0));
              check(work);
              return buf.subarray(0, n).toString("utf8");
            },
          };
          const value = callback(reader, proof);
          if (record(value) && typeof value["then"] === "function") throw new Error("synchronous-lease-required");
          return value;
        } finally {
          active = false;
          if (fd !== undefined) {
            try {
              fs.closeSync(fd);
            } catch {
              /* cleanup */
            }
          }
        }
      });
    },
  };
}
