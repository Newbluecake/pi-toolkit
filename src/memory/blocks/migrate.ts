/** Staged migration. Only the directory rename publishes blocks; root files are immutable.
 * All mutable run state belongs to the invocation. No timers, no pi or direct fs imports.
 */
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { clampSpanMs } from "../../core/deadline.js";
import type { MemoryWriteGate } from "../contracts.js";
import { MemoryError } from "../paths.js";
import { withMemoryDirLock } from "../lock.js";
import {
  canonicalDir,
  inspectDirNoFollow,
  isV2Name,
  readRegular,
  statRegularIfExists,
  ensurePrivateDir,
  writeTempRegular,
  replaceAtomic,
  fsyncDir,
  renameDirNoClobber,
  removeTreeNoFollow,
  unlinkRegular,
  readProcIdentity,
  isProcessAlive,
  type ProcIdentity,
} from "../safe-fs.js";
import { newTidyId } from "../tidy/manifest.js";
import { readIndex } from "../jev/index-store.js";
import { planMigration, sourceSha, type MigrationSource, type MigrationPlan } from "./migrate-plan.js";
import { dirFormat } from "./naming.js";
import { readMarker } from "./marker.js";
import { readBlocksState, writeBlocksStateLocked, readHold, writeHoldLocked } from "./state.js";

export const plainMemoryWriteGate: MemoryWriteGate = { check: () => ({ ok: true }), capture: () => {} };
export type MigrationPhase =
  | "staging-created"
  | "owner-written"
  | "building"
  | "built"
  | "gen-bumped"
  | "published"
  | "rollback-gen"
  | "rollback-hold"
  | "rollback-renamed"
  | "cleaning";
export interface MigrationOptions {
  gate?: MemoryWriteGate;
  explicit?: boolean;
  signal?: AbortSignal;
  now?: () => number;
  budgetMs?: number;
  maxOps?: number;
  maxFiles?: number;
  maxBytes?: number;
  /** Barrier/fault port, called outside locks only for built/building. Throwing simulates a fault, not a durable continuation. */
  phase?: (phase: MigrationPhase, staging: string) => void | Promise<void>;
  yield?: () => Promise<void>;
  host?: string;
  identity?: (pid: number) => ProcIdentity | undefined;
  alive?: (pid: number) => boolean;
  diag?: (message: string) => void;
}
export interface MigrationResult {
  outcome: "committed" | "already-migrated" | "held" | "absent" | "aborted" | "over-budget";
  reason?: string;
  plan?: MigrationPlan;
  runId?: string;
}
const ID = "\\d{8}T\\d{9}Z-\\d+-[0-9a-f]{6}";
const STAGING = new RegExp(`^\\.blocks-staging-(${ID})$`);
const GARBAGE = new RegExp(`^\\.blocks-staging-(${ID})\\.trash-(${ID})$`);
interface StagingOwner {
  v: 1;
  runId: string;
  pid: number;
  startTicks?: number;
  bootId?: string;
  hostname: string;
  createdAt: string;
}
function ownerAt(dir: string): StagingOwner | undefined {
  try {
    const o = JSON.parse(readRegular(dir, "owner.json").text) as StagingOwner;
    return o.v === 1 &&
      new RegExp(`^${ID}$`).test(o.runId) &&
      Number.isSafeInteger(o.pid) &&
      o.pid > 0 &&
      typeof o.hostname === "string" &&
      Number.isSafeInteger(o.startTicks) &&
      o.startTicks! >= 0
      ? o
      : undefined;
  } catch {
    return undefined;
  }
}
function sameOwner(a: StagingOwner | undefined, b: StagingOwner): boolean {
  return (
    !!a &&
    a.runId === b.runId &&
    a.pid === b.pid &&
    a.startTicks === b.startTicks &&
    a.bootId === b.bootId &&
    a.hostname === b.hostname
  );
}
class Budget {
  ops = 0;
  readonly deadline: number;
  readonly gate: MemoryWriteGate;
  readonly now: () => number;
  constructor(
    readonly dir: string,
    readonly opts: MigrationOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.deadline = this.now() + (clampSpanMs(opts.budgetMs ?? (opts.explicit ? 60000 : 3000)) ?? 1);
    this.gate = opts.gate ?? plainMemoryWriteGate;
  }
  check(cost = 0): void {
    const verdict = this.gate.check(this.dir);
    if (!verdict.ok) throw new MemoryError(`E_GATE: ${verdict.reason}`);
    if (this.opts.signal?.aborted) throw new MemoryError("E_ABORTED");
    this.ops += cost;
    if (this.now() >= this.deadline || this.ops > (this.opts.maxOps ?? (this.opts.explicit ? 120000 : 12000)))
      throw new MemoryError("E_BUDGET");
  }
  async yield(): Promise<void> {
    this.check();
    await (this.opts.yield ?? (() => new Promise<void>((r) => setImmediate(r))))();
    this.check();
  }
  timeout(cap: number): number {
    this.check();
    const wait = Math.max(1, Math.min(cap, this.deadline - this.now()));
    this.check(20 + Math.ceil(wait / 25) * 10);
    return clampSpanMs(wait) ?? 1;
  }
  write(dir: string, name: string, value: string): void {
    this.check(12);
    const tmp = writeTempRegular(dir, name, Buffer.from(value), 0o600);
    this.check(1);
    replaceAtomic(dir, tmp, name);
  }
  sync(dir: string): void {
    this.check(4);
    fsyncDir(dir);
  }
}
/** Strict snapshot: unsafe source names are not silently omitted. */
export function snapshotMigrationSources(
  memDir: string,
  before: (cost: number) => void = () => {},
  limits: { maxFiles?: number; maxBytes?: number } = {},
): MigrationSource[] {
  before(3);
  const dir = inspectDirNoFollow(memDir),
    files: MigrationSource[] = [];
  const names = dir.names.filter(isV2Name).sort();
  if (names.length > (limits.maxFiles ?? 20000)) throw new MemoryError("E_BUDGET: source count");
  let bytes = 0;
  for (const name of names) {
    before(1);
    const stat = statRegularIfExists(memDir, name);
    if (!stat) throw new MemoryError("E_SOURCE: disappeared");
    bytes += stat.size;
    if (bytes > (limits.maxBytes ?? 64 * 1024 * 1024)) throw new MemoryError("E_BUDGET: source bytes");
    before(5);
    const read = readRegular(memDir, name);
    if (Buffer.byteLength(read.text) !== read.stat.size)
      throw new MemoryError("E_SOURCE: non-roundtrippable UTF-8 or racing size");
    files.push({
      name,
      raw: read.text,
      sha256: sourceSha(read.text),
      size: read.stat.size,
      mtimeMs: read.stat.mtimeMs,
    });
  }
  return files;
}
function sameSources(a: readonly MigrationSource[], b: readonly MigrationSource[]): boolean {
  return a.length === b.length && a.every((f, i) => f.name === b[i]?.name && f.sha256 === b[i]?.sha256);
}
function cleanup(memDir: string, runId: string, b: Budget): void {
  b.check(3);
  const parent = canonicalDir(memDir)!;
  const current = (b.opts.identity ?? readProcIdentity)(process.pid),
    host = b.opts.host ?? hostname();
  let allowance = 500;
  for (const name of inspectDirNoFollow(memDir).names.sort()) {
    b.check(3);
    if (!STAGING.test(name) && !GARBAGE.test(name)) continue;
    let target = name;
    try {
      const child = inspectDirNoFollow(join(memDir, name));
      if (child.dev !== inspectDirNoFollow(memDir).dev) continue;
      if (STAGING.test(name)) {
        const owner = ownerAt(join(memDir, name));
        if (!owner || owner.runId === runId) continue;
        const actual = (b.opts.identity ?? readProcIdentity)(owner.pid);
        const own =
          owner.pid === process.pid && owner.startTicks === current?.startTicks && owner.bootId === current?.bootId;
        const dead =
          owner.hostname === host &&
          ((owner.bootId !== undefined && current?.bootId !== undefined && owner.bootId !== current.bootId) ||
            !(b.opts.alive ?? isProcessAlive)(owner.pid) ||
            (actual?.startTicks !== undefined && actual.startTicks !== owner.startTicks));
        if (!own && !dead) continue;
        target = `${name}.trash-${runId}`;
        b.check(5);
        renameDirNoClobber(parent, name, target);
      }
      const removed = removeTreeNoFollow(parent, target, {
        maxOps: allowance,
        beforeOp: () => {
          b.check(10);
          void b.opts.phase?.("cleaning", join(memDir, target));
          return true;
        },
      });
      allowance -= removed.ops;
      if (allowance <= 0) break;
    } catch (err) {
      if (String(err).includes("E_GATE") || String(err).includes("E_BUDGET") || String(err).includes("E_ABORTED"))
        throw err; /* unknown owner / unsafe tree: leave untouched */
    }
  }
}
function manifest(dir: string, b: Budget): { path: string; sha256: string; size: number }[] {
  const parent = inspectDirNoFollow(dir),
    result: { path: string; sha256: string; size: number }[] = [];
  const walk = (path: string, prefix: string): void => {
    b.check(3);
    const st = inspectDirNoFollow(path);
    if (st.dev !== parent.dev) throw new MemoryError("E_MANIFEST: cross-device");
    for (const name of st.names.sort()) {
      b.check(5);
      if (prefix === "" && (name === "owner.json" || name === ".layout.json")) continue;
      const p = prefix + name;
      // Only the three declared subdirectories exist in a staging tree. All other entries must be regular files.
      if (prefix === "" && ["archive", ".trash", ".jev"].includes(name)) {
        walk(join(path, name), `${name}/`);
        continue;
      }
      const r = readRegular(path, name);
      result.push({ path: p, sha256: sourceSha(r.text), size: r.stat.size });
    }
  };
  walk(dir, "");
  return result.sort((a, c) => a.path.localeCompare(c.path, "en"));
}
function verifyManifest(
  dir: string,
  b: Budget,
  expected: readonly { path: string; sha256: string; size: number }[],
): boolean {
  const marker = readMarker(dir);
  if (!marker?.files || JSON.stringify(marker.files) !== JSON.stringify(expected)) return false;
  const names = inspectDirNoFollow(dir).names;
  if (!["archive", ".trash", ".jev"].every((name) => names.includes(name))) return false;
  const files = manifest(dir, b);
  return (
    files.length === marker.files.length &&
    files.every(
      (f, i) =>
        f.path === marker.files![i]?.path && f.sha256 === marker.files![i]?.sha256 && f.size === marker.files![i]?.size,
    )
  );
}
function isolate(
  memDir: string,
  name: string,
  owner: StagingOwner,
  b: Budget,
  identity?: { dev: number; ino: number },
): void {
  const actual = inspectDirNoFollow(join(memDir, name));
  if (
    identity
      ? actual.dev !== identity.dev || actual.ino !== identity.ino
      : !sameOwner(ownerAt(join(memDir, name)), owner)
  )
    return;
  b.check(5);
  renameDirNoClobber(canonicalDir(memDir)!, name, `${name}.trash-${owner.runId}`);
}
function resumeRollbackLocked(memDir: string, b: Budget): void {
  b.check(5);
  const hold = readHold(memDir);
  if (!hold?.rollback || hold.rollback.done) return;
  const names = inspectDirNoFollow(memDir).names;
  if (names.includes("blocks")) {
    b.check(5);
    renameDirNoClobber(canonicalDir(memDir)!, "blocks", hold.rollback.to);
    b.sync(memDir);
  } else if (!names.includes(hold.rollback.to))
    throw new MemoryError("E_ROLLBACK: neither source nor retained target exists");
  b.check(20);
  writeHoldLocked(memDir, { ...hold, rollback: { ...hold.rollback, done: true } });
}
export async function resumeRollback(memDir: string, opts: MigrationOptions = {}): Promise<void> {
  const b = new Budget(memDir, opts);
  b.check();
  if (!canonicalDir(memDir)) return;
  await withMemoryDirLock(memDir, () => resumeRollbackLocked(memDir, b), { timeoutMs: b.timeout(500), log: () => {} });
}
export async function rollbackMigration(
  memDir: string,
  opts: MigrationOptions = {},
): Promise<{ retained?: string; changed: string[] }> {
  const result: { retained?: string; changed: string[] } = { changed: [] };
  const b = new Budget(memDir, { ...opts, explicit: true });
  b.check();
  await withMemoryDirLock(
    memDir,
    () => {
      resumeRollbackLocked(memDir, b);
      const held = readHold(memDir);
      if (held) {
        if (held.rollback) result.retained = held.rollback.to;
        return;
      }
      if (dirFormat(memDir) !== "blocks") throw new MemoryError("E_UNMIGRATED");
      const real = join(memDir, "blocks"),
        baseline = new Map(readMarker(real)?.files?.map((f) => [f.path, f.sha256]));
      for (const name of inspectDirNoFollow(real).names.filter(isV2Name).sort()) {
        b.check(5);
        if (baseline.get(name) !== sourceSha(readRegular(real, name).text)) result.changed.push(name);
      }
      const state = readBlocksState(memDir),
        gen = state.gen + 1;
      b.check(20);
      writeBlocksStateLocked(memDir, { ...state, gen });
      void opts.phase?.("rollback-gen", memDir);
      const hold = {
        v: 1 as const,
        at: new Date(b.now()).toISOString(),
        reason: "rollback" as const,
        gen,
        rollback: {
          from: "blocks" as const,
          to: `.blocks-rolledback-${newTidyId(new Date(b.now()), process.pid, randomBytes(3).toString("hex"))}`,
          done: false,
        },
      };
      result.retained = hold.rollback.to;
      b.check(20);
      writeHoldLocked(memDir, hold);
      void opts.phase?.("rollback-hold", memDir);
      b.check(5);
      renameDirNoClobber(canonicalDir(memDir)!, "blocks", hold.rollback.to);
      b.sync(memDir);
      void opts.phase?.("rollback-renamed", memDir);
      b.check(20);
      writeHoldLocked(memDir, { ...hold, rollback: { ...hold.rollback, done: true } });
    },
    { timeoutMs: b.timeout(5000), log: () => {} },
  );
  return result;
}
export async function runMigration(
  memDir: string,
  opts: MigrationOptions = {},
  allowSourceRetry = true,
): Promise<MigrationResult> {
  const b = new Budget(memDir, opts),
    runId = newTidyId(new Date(b.now()), process.pid, randomBytes(3).toString("hex"));
  const name = `.blocks-staging-${runId}`,
    staging = join(memDir, name);
  const owner: StagingOwner = {
    v: 1,
    runId,
    pid: process.pid,
    hostname: opts.host ?? hostname(),
    createdAt: new Date(b.now()).toISOString(),
  };
  let sources: MigrationSource[] = [],
    gen0 = 0,
    plan: MigrationPlan | undefined;
  let renameFailed = false;
  let stagingIdentity: { dev: number; ino: number } | undefined;
  try {
    b.check();
    if (!canonicalDir(memDir)) return { outcome: "absent" };
    b.check(2);
    const identity = (opts.identity ?? readProcIdentity)(process.pid);
    if (identity?.startTicks === undefined) throw new MemoryError("E_OWNER: process start identity unavailable");
    Object.assign(owner, identity);
    const early = await withMemoryDirLock(
      memDir,
      () => {
        b.check();
        resumeRollbackLocked(memDir, b);
        const hold = readHold(memDir);
        if (hold && !opts.explicit) return "held" as const;
        if (hold) {
          const state = readBlocksState(memDir);
          b.check(20);
          writeBlocksStateLocked(memDir, { ...state, gen: state.gen + 1 });
          b.check(3);
          unlinkRegular(memDir, ".blocks-hold");
          b.sync(memDir);
        }
        if (inspectDirNoFollow(memDir).names.includes("blocks")) {
          cleanup(memDir, runId, b);
          return "already-migrated" as const;
        }
        gen0 = readBlocksState(memDir).gen;
        sources = snapshotMigrationSources(memDir, (c) => b.check(c), {
          maxFiles: opts.maxFiles ?? (opts.explicit ? 20000 : 2000),
          maxBytes: opts.maxBytes ?? (opts.explicit ? 64 * 1024 * 1024 : 4 * 1024 * 1024),
        });
        if (!sources.length) return "absent" as const;
        if (
          sources.length > (opts.maxFiles ?? (opts.explicit ? 20000 : 2000)) ||
          sources.reduce((n, f) => n + f.size, 0) >
            (opts.maxBytes ?? (opts.explicit ? 64 * 1024 * 1024 : 4 * 1024 * 1024))
        )
          throw new MemoryError("E_BUDGET");
        cleanup(memDir, runId, b);
        b.check(3);
        ensurePrivateDir(staging);
        b.check(3);
        stagingIdentity = inspectDirNoFollow(staging);
        void opts.phase?.("staging-created", staging);
        b.write(staging, "owner.json", JSON.stringify(owner));
        void opts.phase?.("owner-written", staging);
        return undefined;
      },
      { timeoutMs: b.timeout(opts.explicit ? 5000 : 500), log: () => {} },
    );
    if (early) return { outcome: early };
    b.check(5);
    plan = planMigration(sources, readIndex(memDir).index, new Date(b.now()).toISOString().slice(0, 10));
    for (const sub of ["archive", ".trash", ".jev"]) {
      b.check(3);
      ensurePrivateDir(join(staging, sub));
    }
    let checkpoint = b.ops;
    for (const block of plan.blocks) {
      b.write(staging, block.name, block.content);
      await opts.phase?.("building", staging);
      if (b.ops - checkpoint >= 32) {
        await b.yield();
        checkpoint = b.ops;
      }
    }
    b.write(join(staging, ".jev"), "index.json", JSON.stringify(plan.sidecar));
    b.write(staging, ".migration-report.json", JSON.stringify(plan.report, null, 2) + "\n");
    const files = [
      ...plan.blocks.map((block) => ({
        path: block.name,
        sha256: sourceSha(block.content),
        size: Buffer.byteLength(block.content),
      })),
      {
        path: ".jev/index.json",
        sha256: sourceSha(JSON.stringify(plan.sidecar)),
        size: Buffer.byteLength(JSON.stringify(plan.sidecar)),
      },
      {
        path: ".migration-report.json",
        sha256: sourceSha(JSON.stringify(plan.report, null, 2) + "\n"),
        size: Buffer.byteLength(JSON.stringify(plan.report, null, 2) + "\n"),
      },
    ].sort((a, c) => a.path.localeCompare(c.path, "en"));
    await b.yield();
    b.write(
      staging,
      ".layout.json",
      JSON.stringify({
        v: 1,
        source: "migrate",
        gen: gen0 + 1,
        runId,
        migratedAt: new Date(b.now()).toISOString(),
        files,
      }) + "\n",
    );
    for (const sub of ["archive", ".trash", ".jev"]) b.sync(join(staging, sub));
    b.sync(staging);
    await opts.phase?.("built", staging);
    await withMemoryDirLock(
      memDir,
      () => {
        b.check();
        const currentStaging = inspectDirNoFollow(staging);
        if (currentStaging.dev !== stagingIdentity?.dev || currentStaging.ino !== stagingIdentity?.ino)
          throw new MemoryError("E_RECHECK: staging identity changed");
        if (readHold(memDir)) throw new MemoryError("E_RECHECK: hold appeared");
        if (readBlocksState(memDir).gen !== gen0) throw new MemoryError("E_RECHECK: generation changed");
        if (inspectDirNoFollow(memDir).names.includes("blocks"))
          throw new MemoryError("E_RECHECK: blocks already exists");
        if (
          !sameSources(
            sources,
            snapshotMigrationSources(memDir, (c) => b.check(c)),
          )
        )
          throw new MemoryError("E_RECHECK: source changed");
        if (
          !sameOwner(ownerAt(staging), owner) ||
          readMarker(staging)?.gen !== gen0 + 1 ||
          readMarker(staging)?.runId !== runId ||
          !verifyManifest(staging, b, files)
        )
          throw new MemoryError("E_RECHECK: owner/manifest changed");
        b.check(20);
        writeBlocksStateLocked(memDir, {
          ...readBlocksState(memDir),
          gen: gen0 + 1,
          lastOutcome: "aborted",
          lastAt: new Date(b.now()).toISOString(),
        });
        void opts.phase?.("gen-bumped", staging);
        b.check(3);
        unlinkRegular(staging, "owner.json");
        b.check(25); // reserve the post-publication state update before crossing the commit point
        try {
          renameDirNoClobber(canonicalDir(memDir)!, name, "blocks");
        } catch (err) {
          renameFailed = true;
          if (b.gate.check(memDir).ok) {
            try {
              b.write(staging, "owner.json", JSON.stringify(owner));
            } catch {
              /* preserve original rename error */
            }
          }
          throw err;
        }
        void opts.phase?.("published", staging);
        try {
          if (b.gate.check(memDir).ok)
            writeBlocksStateLocked(memDir, {
              v: 1,
              gen: gen0 + 1,
              overBudgetStreak: 0,
              lastOutcome: "committed",
              lastAt: new Date(b.now()).toISOString(),
            });
        } catch (error) {
          try {
            opts.diag?.(`memory: blocks published, state update failed: ${String(error)}`);
          } catch {
            /* diagnostic ports cannot undo publication */
          }
        }
        try {
          b.sync(memDir);
        } catch (error) {
          // Publication is irreversible here; warn rather than pretend the old layout remains authoritative.
          try {
            opts.diag?.(`memory: blocks published, parent fsync failed: ${String(error)}`);
          } catch {
            /* diagnostic ports cannot undo publication */
          }
        }
      },
      { timeoutMs: b.timeout(opts.explicit ? 5000 : 500), log: () => {} },
    );
    return { outcome: "committed", plan, runId };
  } catch (err) {
    const reason = String(err),
      over = reason.includes("E_BUDGET");
    // Never perform compensating writes after a mount loss or shutdown. Unknown identity is left untouched.
    if (!opts.signal?.aborted && b.gate.check(memDir).ok && canonicalDir(memDir)) {
      try {
        await withMemoryDirLock(
          memDir,
          () => {
            if (!renameFailed) {
              try {
                isolate(
                  memDir,
                  name,
                  owner,
                  new Budget(memDir, { ...opts, budgetMs: 200, maxOps: 100 }),
                  stagingIdentity,
                );
              } catch {
                /* next lock holder can clean */
              }
            }
            if (b.gate.check(memDir).ok) {
              const state = readBlocksState(memDir);
              writeBlocksStateLocked(memDir, {
                ...state,
                overBudgetStreak: over ? state.overBudgetStreak + 1 : state.overBudgetStreak,
                lastOutcome: over ? "over-budget" : "aborted",
                lastAt: new Date(b.now()).toISOString(),
              });
            }
          },
          { timeoutMs: clampSpanMs(200) ?? 1, log: () => {} },
        );
      } catch {
        /* bounded best effort */
      }
    }
    if (
      opts.explicit &&
      allowSourceRetry &&
      reason.includes("E_RECHECK: source changed") &&
      b.deadline > b.now() &&
      !opts.signal?.aborted &&
      b.gate.check(memDir).ok
    ) {
      // One retry, sharing the original remaining wall-clock and operation budget.
      return runMigration(
        memDir,
        { ...opts, budgetMs: b.deadline - b.now(), maxOps: Math.max(1, (opts.maxOps ?? 120000) - b.ops) },
        false,
      );
    }
    return { outcome: over ? "over-budget" : "aborted", reason, runId };
  }
}
