import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Clock } from "../core/clock.js";
import type { Millis } from "../core/types.js";
import { isJobId } from "./ids.js";
import { isTerminalJobStatus, parseJobRecord, type JobId, type JobRecord } from "./types.js";

/**
 * bash auto-background §3.4/§3.5: one JSON file per job under a flat
 * directory (`~/.pi/agent/bash-jobs` by default), written atomically with
 * tmp+rename so a crash mid-write can never leave a half-parsed record, and
 * scanned on startup so jobs survive `/reload` and full pi restarts.
 *
 * Everything the store needs is injected (`dir`, `retentionMs`, `clock`,
 * `warn`) — it deliberately does not read the settings module, so the
 * `bashJobs` settings block can evolve independently.
 */

export interface JobStoreOptions {
  /** Directory holding `b_XXXXXXXX.json` + `b_XXXXXXXX.log`. Created on demand. */
  dir: string;
  /** Terminal jobs are pruned this long after they ended. `<= 0` disables pruning. */
  retentionMs: Millis;
  clock: Clock;
  /** Diagnostics sink for unreadable files; defaults to `console.warn`. */
  warn?: (message: string) => void;
  /** Mode for newly-created directories. */
  dirMode?: number;
  /** Optional root under which a persisted alternate logPath may be removed. */
  extraLogRoot?: string;
}

export interface PruneOptions {
  /**
   * "This job id is live in someone's memory table" — such a job's log file is
   * never an orphan, even while its JSON record is momentarily absent.
   * Defaults to "nothing is tracked" (a bare store knows no manager).
   */
  isTracked?: (jobId: JobId) => boolean;
}

export interface PruneResult {
  /** Job ids whose record (and log) were removed. */
  readonly jobs: JobId[];
  /** Bare file names removed that were *not* attributable to a job record. */
  readonly files: string[];
}

export interface JobStore {
  readonly dir: string;
  /** Absolute path of the job's JSON record. */
  recordPath(jobId: JobId): string;
  /** Absolute path of the job's merged stdout+stderr log (§3.4 D3). */
  logPath(jobId: JobId): string;
  /** Atomically persist a record (tmp + rename). Writes are serialized per store. */
  save(record: JobRecord): Promise<void>;
  /** `undefined` when the file is missing or unreadable (a WARN is emitted for the latter). */
  load(jobId: JobId): Promise<JobRecord | undefined>;
  /** Every readable record in `dir`; unreadable files are WARNed and skipped. */
  loadAll(): Promise<JobRecord[]>;
  /**
   * Serialized read-modify-write. `mutate` returning `undefined` means "no
   * change" and skips the write. Resolves to the stored record (or `undefined`
   * when the job is gone).
   */
  update(jobId: JobId, mutate: (record: JobRecord) => JobRecord | undefined): Promise<JobRecord | undefined>;
  /**
   * bash-timeout-grace plan §2.5: serialized read-modify-write that also
   * covers the "record does not exist yet" case — `mutate` receives
   * `undefined` when there is no file on disk, and returning `undefined`
   * from `mutate` (in either case) skips the write. Deadline back-writes
   * (R5/R10), the crash-handoff log relocation (`BashJobManager.relocateLog`)
   * and R12's `failed`/`killed` finalizations all go through this so a CAS
   * ("current.deadline.seq >= next.deadline.seq => don't write") can be
   * expressed by the caller without a separate existence check.
   */
  upsert(
    jobId: JobId,
    mutate: (record: JobRecord | undefined) => JobRecord | undefined,
  ): Promise<JobRecord | undefined>;
  /** Persist the `bash_job output` cursor (§4.3). Monotonic: never moves backwards. */
  setReadCursor(jobId: JobId, cursor: number): Promise<JobRecord | undefined>;
  /** Delete the record and its log file. Idempotent. */
  remove(jobId: JobId): Promise<void>;
  /**
   * Full-directory sweep: expired terminal job records (with their logs),
   * plus the litter that never reaches `records` — unreadable/badly named
   * `.json` files, orphan `.log` files and crashed atomic-write `.tmp` files.
   * Only `.json` / `.log` / `.tmp` names are ever touched (safety boundary).
   */
  pruneExpired(options?: PruneOptions): Promise<PruneResult>;
}

const RECORD_SUFFIX = ".json";
const LOG_SUFFIX = ".log";
const TMP_SUFFIX = ".tmp";

/**
 * bash-timeout-grace plan §2.5 "共享写链": every `JobStore` instance writing to
 * the same directory — across `/reload`, `/new`, `/resume` within one process
 * — must serialize through exactly one chain, or a newer manager's deadline
 * back-write (R10's seq CAS) could be interleaved with an older manager's
 * still-draining writes and either side could silently lose an update. The
 * chain lives on `globalThis` (the same `Symbol.for` pattern as the
 * worktree-origin and child-bash registries) so it survives the extension's
 * in-process re-activation on `/reload` — there is deliberately no `reset()`.
 *
 * No module-scope mutable state: everything mutable lives inside the
 * `JobStoreChainRegistry` object reachable only through the global slot.
 */
const JOB_STORE_CHAIN_REGISTRY_KEY = Symbol.for("pi-subagent:bash-job-store-chains");

interface JobStoreChain {
  /** Tail of the serialization chain; each `enqueue` call chains onto this. */
  queue: Promise<unknown>;
  /** Operations enqueued *and* still in flight against this chain. */
  pending: number;
  /** Recency marker for idle-only LRU eviction (§2.5 "淘汰"). */
  lastUsedAt: Millis;
  /** Enqueue time of the oldest currently-pending operation; `undefined` when idle. */
  oldestEnqueuedAt: Millis | undefined;
  /** Latch: the combined backlog WARN (pending/age) fires at most once per chain. */
  warnedBacklog: boolean;
}

interface JobStoreChainRegistry {
  readonly chains: Map<string, JobStoreChain>;
  /** Latch: the over-capacity WARN fires at most once per process lifetime. */
  warnedOverCapacity: boolean;
}

/** §2.5 "淘汰": chain map capacity before idle (pending === 0) chains are LRU-evicted. */
export const JOB_STORE_CHAIN_CAP = 64;
/** §2.5 "遥测": a chain WARNs once it has this many operations in flight. */
export const JOB_STORE_CHAIN_PENDING_WARN = 256;
/** §2.5 "遥测": a chain WARNs once its oldest in-flight operation has waited this long. */
export const JOB_STORE_CHAIN_OLDEST_WARN_MS: Millis = 60_000;

function getChainRegistry(): JobStoreChainRegistry {
  const g = globalThis as Record<symbol, JobStoreChainRegistry | undefined>;
  const existing = g[JOB_STORE_CHAIN_REGISTRY_KEY];
  if (existing) return existing;
  const created: JobStoreChainRegistry = { chains: new Map(), warnedOverCapacity: false };
  g[JOB_STORE_CHAIN_REGISTRY_KEY] = created;
  return created;
}

/**
 * Get-or-create the chain for `dir` (resolved to an absolute path so two
 * different string spellings of the same directory still share one chain).
 * Creating a *new* chain is the only moment eviction runs — an already-live
 * chain is simply returned (and its recency bumped), so a chain that is busy
 * at the instant another dir needs room is never the one removed out from
 * under an in-flight write (§2.5 "淘汰只淘汰 pending === 0 的链").
 */
function chainFor(dir: string, now: Millis, warn: (message: string) => void): JobStoreChain {
  const registry = getChainRegistry();
  const key = resolve(dir);
  const existing = registry.chains.get(key);
  if (existing) {
    existing.lastUsedAt = now;
    return existing;
  }
  const created: JobStoreChain = {
    queue: Promise.resolve(),
    pending: 0,
    lastUsedAt: now,
    oldestEnqueuedAt: undefined,
    warnedBacklog: false,
  };
  registry.chains.set(key, created);
  if (registry.chains.size > JOB_STORE_CHAIN_CAP) {
    const idle = [...registry.chains.entries()]
      .filter(([k, chain]) => chain.pending === 0 && k !== key)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [k] of idle) {
      if (registry.chains.size <= JOB_STORE_CHAIN_CAP) break;
      registry.chains.delete(k);
    }
    if (registry.chains.size > JOB_STORE_CHAIN_CAP && !registry.warnedOverCapacity) {
      registry.warnedOverCapacity = true;
      const busy = [...registry.chains.values()].filter((chain) => chain.pending > 0).length;
      warn(`bash job store chains over capacity (${busy} busy)`);
    }
  }
  return created;
}

/**
 * Aggregate snapshot across every directory's chain (§2.5 "遥测"), for
 * `/agent status` (a later package) to surface as `chains N (busy k, oldest
 * 12s)`. `now` is injectable so tests (and any FakeClock-driven caller) get a
 * deterministic `oldestPendingMs`; real callers can omit it.
 */
export interface ChainStats {
  readonly dirs: number;
  readonly busy: number;
  readonly maxPending: number;
  readonly oldestPendingMs: number | undefined;
}

export function chainStats(now: Millis = Date.now()): ChainStats {
  const registry = getChainRegistry();
  let busy = 0;
  let maxPending = 0;
  let oldestPendingMs: number | undefined;
  for (const chain of registry.chains.values()) {
    if (chain.pending > 0) busy++;
    if (chain.pending > maxPending) maxPending = chain.pending;
    if (chain.oldestEnqueuedAt !== undefined) {
      const age = now - chain.oldestEnqueuedAt;
      if (oldestPendingMs === undefined || age > oldestPendingMs) oldestPendingMs = age;
    }
  }
  return { dirs: registry.chains.size, busy, maxPending, oldestPendingMs };
}

/**
 * `.tmp` files are the debris of an interrupted `writeAtomic`: intrinsically
 * momentary, so they get a short fixed TTL instead of `retentionMs` (a day of
 * half-written records helps nobody). Not configurable on purpose — see
 * plan-fable §15.
 */
export const TMP_RETENTION_MS = 3_600_000;

export function createJobStore(options: JobStoreOptions): JobStore {
  const { dir, retentionMs, clock } = options;
  const dirMode = options.dirMode ?? 0o700;
  const extraLogRoot = options.extraLogRoot;
  const warn = options.warn ?? ((message: string) => console.warn(`[pi-subagent] ${message}`));
  const recordPath = (jobId: JobId) => join(dir, `${jobId}${RECORD_SUFFIX}`);
  const logPath = (jobId: JobId) => join(dir, `${jobId}${LOG_SUFFIX}`);

  /**
   * Every write/read-modify-write for this store's `dir` goes through the
   * shared per-directory chain (§2.5) instead of a private queue: it both
   * orders atomic writes (as before) *and* now also orders them against any
   * other `JobStore` instance — in this process, past or present — pointed at
   * the same directory (the /reload handoff window, §2.5).
   */
  let tmpSeq = 0;
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const now = clock.now();
    const chain = chainFor(dir, now, warn);
    if (chain.pending === 0) chain.oldestEnqueuedAt = now;
    chain.pending++;
    if (!chain.warnedBacklog) {
      const oldestMs = chain.oldestEnqueuedAt !== undefined ? now - chain.oldestEnqueuedAt : 0;
      if (chain.pending > JOB_STORE_CHAIN_PENDING_WARN || oldestMs > JOB_STORE_CHAIN_OLDEST_WARN_MS) {
        chain.warnedBacklog = true;
        warn(`bash job store chain ${dir} backlog: ${chain.pending} pending, oldest ${Math.round(oldestMs / 1000)}s`);
      }
    }
    const result = chain.queue.then(fn, fn);
    // Keep the chain alive regardless of individual failures.
    chain.queue = result.then(
      () => undefined,
      () => undefined,
    );
    const settle = (): void => {
      chain.pending = Math.max(0, chain.pending - 1);
      if (chain.pending === 0) chain.oldestEnqueuedAt = undefined;
    };
    result.then(settle, settle);
    return result;
  }

  async function writeAtomic(record: JobRecord): Promise<void> {
    await mkdir(dir, { recursive: true, mode: dirMode });
    const target = recordPath(record.jobId);
    const temp = `${target}.${process.pid}.${clock.now()}.${tmpSeq++}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      try {
        await rename(temp, target);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        await mkdir(dir, { recursive: true, mode: dirMode });
        await rename(temp, target);
      }
    } finally {
      // After a successful rename the tmp path is already gone; this only
      // cleans up the failure case.
      await unlink(temp).catch(() => undefined);
    }
  }

  async function readRecord(jobId: JobId): Promise<JobRecord | undefined> {
    let text: string;
    try {
      text = await readFile(recordPath(jobId), "utf8");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") warn(`failed to read bash job ${jobId}: ${String(error)}`);
      return undefined;
    }
    return decode(jobId, text, warn);
  }

  function loadAll(): Promise<JobRecord[]> {
    return enqueue(async () => {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") warn(`failed to scan bash job dir ${dir}: ${String(error)}`);
        return [];
      }
      const records: JobRecord[] = [];
      for (const entry of entries.sort()) {
        if (!entry.endsWith(RECORD_SUFFIX)) continue;
        const jobId = entry.slice(0, -RECORD_SUFFIX.length);
        if (!isJobId(jobId)) {
          warn(`skipping bash job file with an unexpected name: ${entry}`);
          continue;
        }
        const record = await readRecord(jobId);
        if (record) records.push(record);
      }
      return records;
    });
  }

  function update(jobId: JobId, mutate: (record: JobRecord) => JobRecord | undefined): Promise<JobRecord | undefined> {
    return enqueue(async () => {
      const current = await readRecord(jobId);
      if (!current) return undefined;
      const next = mutate(current);
      if (!next) return current;
      await writeAtomic(next);
      return next;
    });
  }

  function upsert(
    jobId: JobId,
    mutate: (record: JobRecord | undefined) => JobRecord | undefined,
  ): Promise<JobRecord | undefined> {
    return enqueue(async () => {
      const current = await readRecord(jobId);
      const next = mutate(current);
      if (!next) return current;
      await writeAtomic(next);
      return next;
    });
  }

  function remove(jobId: JobId): Promise<void> {
    return enqueue(async () => {
      const record = await readRecord(jobId);
      await unlink(recordPath(jobId)).catch(() => undefined);
      await unlink(logPath(jobId)).catch(() => undefined);
      const alternate = record?.logPath;
      if (alternate === undefined || alternate === logPath(jobId)) return;
      const root = extraLogRoot === undefined ? undefined : resolve(extraLogRoot);
      const alternateResolved = resolve(alternate);
      const relativePath = root === undefined ? "" : relative(root, alternateResolved);
      const insideRoot = relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
      if (basename(alternate) !== `${jobId}${LOG_SUFFIX}` || !insideRoot) {
        warn(`refusing to remove unsafe bash job log path for ${jobId}: ${alternate}`);
        return;
      }
      await unlink(alternateResolved).catch((error) => {
        if (errorCode(error) !== "ENOENT") warn(`failed to remove bash job log ${alternate}: ${String(error)}`);
      });
    });
  }

  /**
   * A file's own age, used only for entries whose *content* cannot tell us how
   * old they are (unparseable records, orphan logs, tmp debris).
   *
   * `undefined` means "do not judge this file": either the stat failed, or the
   * mtime lies in `clock`'s future. The latter is the FakeClock / lagging-clock
   * / clock-jump case, and the rule there is deliberately one-sided — an
   * incomparable pair of timestamps must never authorize a delete.
   */
  async function fileAge(name: string, now: Millis): Promise<Millis | undefined> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(join(dir, name))).mtimeMs;
    } catch {
      return undefined;
    }
    if (!Number.isFinite(mtimeMs) || !Number.isFinite(now)) return undefined;
    const age = now - mtimeMs;
    return age >= 0 ? age : undefined;
  }

  /** Delete a bare file name, reporting it (users must know what we removed). */
  async function dropFile(name: string, reason: string, removed: string[]): Promise<void> {
    const deleted = await enqueue(() =>
      unlink(join(dir, name)).then(
        () => true,
        () => false,
      ),
    );
    if (!deleted) return;
    removed.push(name);
    warn(`removed stale bash job file ${name} (${reason})`);
  }

  /**
   * Whole-directory classification sweep (§15). Exactly one `readdir`, a `stat`
   * only for entries whose age cannot be read from a record, and three
   * suffixes of blast radius: `.json`, `.log`, `.tmp`. Anything else in `dir`
   * — whatever the user or another tool put there — is left alone.
   */
  async function prune(pruneOptions: PruneOptions): Promise<PruneResult> {
    const isTracked = pruneOptions.isTracked ?? (() => false);
    const now = clock.now();
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") warn(`failed to scan bash job dir ${dir}: ${String(error)}`);
      return { jobs: [], files: [] };
    }
    entries.sort();
    const present = new Set(entries);
    const jobs: JobId[] = [];
    const files: string[] = [];
    const retentionEnabled = retentionMs > 0;

    for (const entry of entries) {
      // Crash debris from `writeAtomic`; swept even when retention is off,
      // because a tmp file is never a job artefact the user asked us to keep.
      if (entry.endsWith(TMP_SUFFIX)) {
        const age = await fileAge(entry, now);
        if (age !== undefined && age >= TMP_RETENTION_MS) {
          await dropFile(entry, "interrupted atomic write", files);
        }
        continue;
      }
      if (!retentionEnabled) continue;

      if (entry.endsWith(RECORD_SUFFIX)) {
        const jobId = entry.slice(0, -RECORD_SUFFIX.length);
        const record = isJobId(jobId) ? await readRecord(jobId) : undefined;
        if (record) {
          // Readable record: its own status/timestamps decide. A non-terminal
          // job is never pruned, however old it looks.
          if (!isTerminalJobStatus(record.status)) continue;
          if (now - (record.endedAt ?? record.createdAt) < retentionMs) continue;
          await remove(record.jobId);
          jobs.push(record.jobId);
          continue;
        }
        // Illegal name, corrupt JSON or a failed schema check: the state is
        // unreadable, so mtime is the only honest age we have.
        const age = await fileAge(entry, now);
        if (age === undefined || age < retentionMs) continue;
        await dropFile(entry, "unreadable job record past retention", files);
        const log = `${jobId}${LOG_SUFFIX}`;
        if (present.has(log)) await dropFile(log, `log of unreadable record ${entry}`, files);
        continue;
      }

      if (entry.endsWith(LOG_SUFFIX)) {
        const jobId = entry.slice(0, -LOG_SUFFIX.length);
        // We only ever create `<jobId>.log`, so a log whose stem is not a job
        // id cannot be ours — leave it alone even though the suffix matches.
        if (!isJobId(jobId)) continue;
        // A log with a record beside it belongs to that record's fate; a log of
        // a job someone still holds in memory is live output being written.
        if (present.has(`${jobId}${RECORD_SUFFIX}`) || isTracked(jobId)) continue;
        const age = await fileAge(entry, now);
        if (age === undefined || age < retentionMs) continue;
        await dropFile(entry, "orphan log with no job record", files);
      }
      // Any other suffix: not ours. Never touched.
    }
    return { jobs, files };
  }

  return {
    dir,
    recordPath,
    logPath,
    loadAll,
    update,
    upsert,
    remove,

    save(record) {
      return enqueue(() => writeAtomic(record));
    },

    load(jobId) {
      return enqueue(() => readRecord(jobId));
    },

    setReadCursor(jobId, cursor) {
      const wanted = Number.isFinite(cursor) ? Math.max(0, Math.trunc(cursor)) : 0;
      return update(jobId, (record) =>
        // Monotonic: `bash_job output` may be called with an explicit older
        // offset (offset: 0 = replay), which must not rewind the cursor.
        wanted > record.readCursor ? { ...record, readCursor: wanted } : undefined,
      );
    },

    pruneExpired(pruneOptions = {}) {
      return prune(pruneOptions);
    },
  };
}

function decode(jobId: JobId, text: string, warn: (message: string) => void): JobRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    warn(`skipping corrupt bash job record ${jobId}: ${String(error)}`);
    return undefined;
  }
  const result = parseJobRecord(parsed);
  if (!result.ok) {
    warn(`skipping invalid bash job record ${jobId}: ${result.reason}`);
    return undefined;
  }
  if (result.record.jobId !== jobId) {
    warn(`skipping bash job record ${jobId}: file name does not match jobId ${result.record.jobId}`);
    return undefined;
  }
  return result.record;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
