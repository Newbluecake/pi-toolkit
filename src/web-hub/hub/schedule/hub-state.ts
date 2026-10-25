/**
 * scheduled-reports plan r3 §7.2 (H1, r2 after review round 1) — the hub's OWN coordination
 * state, `<stateDir>/schedule/schedule-state.json` (0600, atomic tmp+fsync+rename, parent
 * `schedule/` 0700).
 *
 * Per session → per task: the reconcile cursor (`consumedSeq`/`consumedTotal`), the observation
 * dedup set (≤64, NEVER wall-clock-expired — un-reconciled evidence must survive, review r1 #7),
 * the PENDING delivery accumulators (`pendingMissed` counts, `pendingUnknown` runKeys — the E1
 * carry, consumed only on a successful delivery, review r1 #2/#3/#5/#13), the hour gate, and
 * `notifiedUnknown` (delivered-unknown dedup). Per session also `droppedPending`/`droppedShown`
 * (the droppedIndexCap watermark). Everything persists on EVERY state-changing round — a crash
 * window never loses the carry (review r1 #3).
 *
 * `flush()` reports success; the caller MUST NOT deliver when it returns false (review r1 #4).
 * The byte cap is derived from the per-record bounds (96 sessions × 8 tasks × (64+64+64)
 * entries ≈ 8.4 MiB worst case) plus headroom — legal capacity combinations can never trip it
 * (the round-1 256 KiB cap could).
 *
 * Writes serialize on one internal promise chain (privacy-store precedent). A corrupt file
 * degrades to a fresh start (flag + WARN): notices are best-effort, and a one-time replay after
 * coordination-state loss is the disclosed residual — the agent-side digest stays authoritative.
 * The hub NEVER writes into the agent's store.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { EMPTY_HOUR_GATE, NOTIFIED_UNKNOWN_MAX, PENDING_UNKNOWNS_MAX, type HourGate } from "./merge.js";
import type { ObservedMiss } from "./reconcile.js";
import { OBSERVED_MAX } from "./reconcile.js";

export const SCHED_HUB_STATE_FILE = "schedule-state.json";
export const SCHED_HUB_STATE_VERSION = 2;
/**
 * Derived cap: 96 sessions × 8 tasks × (64 observed + 64 pendingUnknown + 64 notifiedUnknown)
 * ≈ 8.4 MiB worst-case JSON + sessions map overhead; 16 MiB keeps generous headroom so the
 * stop-adding bounds above can never make a LEGAL state unwritable (round-1's 256 KiB could).
 */
export const SCHED_HUB_STATE_MAX_BYTES = 16 * 1024 * 1024;
export const SCHED_HUB_SESSIONS_MAX = 96;
export const SCHED_HUB_SESSION_TTL_MS = 7 * 24 * 3_600_000;
/**
 * Defensive BACKSTOP only (review r1 #14): task-record lifecycle is owned by the SERVICE (it
 * deletes a deleted task's record once it carries no pending duty and no run references it), so
 * a legal state holds ≤ 8 live tasks + briefly-duty-carrying orphans + the "" slot. The old
 * trim-to-8-by-id could drop a LIVE task's cursor under historical-task pressure; 32 keeps the
 * backstop far beyond anything the service can legally produce.
 */
export const SCHED_HUB_TASKS_PER_SESSION_MAX = 32;

export interface SchedHubTaskState {
  /** Duty-anchor for orphan eviction ordering (oldest first); bumped when duty grows. */
  lastAt: number;
  consumedSeq: number;
  consumedTotal: number;
  observed: ObservedMiss[];
  /** E1 carry: missed counts awaiting a successful delivery (≥1 per hour at most). */
  pendingMissed: number;
  /** E1 carry: unknown runKeys awaiting delivery (≤ PENDING_UNKNOWNS_MAX, stop-adding). */
  pendingUnknown: string[];
  gate: HourGate;
  /** Delivered-unknown dedup (≤ NOTIFIED_UNKNOWN_MAX, stop-adding). */
  notifiedUnknown: Array<{ runKey: string; at: number }>;
}

export interface SchedHubSessionState {
  tasks: Record<string, SchedHubTaskState>;
  /** droppedIndexCap increments not yet carried by a notice. */
  droppedPending: number;
  /** Last seen reportStats.droppedIndexCap (resets DOWN with the agent's ledger). */
  droppedShown: number;
  lastSeenAt: number;
}

export interface SchedHubFile {
  v: typeof SCHED_HUB_STATE_VERSION;
  sessions: Record<string, SchedHubSessionState>;
}

const freshFile = (): SchedHubFile => ({ v: SCHED_HUB_STATE_VERSION, sessions: {} });

export function freshTaskState(): SchedHubTaskState {
  return {
    lastAt: 0,
    consumedSeq: 0,
    consumedTotal: 0,
    observed: [],
    pendingMissed: 0,
    pendingUnknown: [],
    gate: { ...EMPTY_HOUR_GATE },
    notifiedUnknown: [],
  };
}

/** Get-or-create a task's coordination state (also lazily creates the session record). */
export function taskStateOf(
  file: SchedHubFile,
  sessionId: string,
  taskId: string,
  now = Date.now(),
): SchedHubTaskState {
  let session = file.sessions[sessionId];
  if (session === undefined) {
    session = { tasks: {}, droppedPending: 0, droppedShown: 0, lastSeenAt: now };
    file.sessions[sessionId] = session;
  }
  let ts = session.tasks[taskId];
  if (ts === undefined) {
    ts = freshTaskState();
    session.tasks[taskId] = ts;
  }
  return ts;
}

/** Defensive clamp of one hand-loaded record (untrusted file / test fixtures). */
export function clampTaskState(ts: SchedHubTaskState): SchedHubTaskState {
  return {
    lastAt: finiteOr(ts.lastAt, 0),
    consumedSeq: finiteOr(ts.consumedSeq, 0),
    consumedTotal: finiteOr(ts.consumedTotal, 0),
    observed: (Array.isArray(ts.observed) ? ts.observed : []).filter(isObserved).slice(-OBSERVED_MAX),
    pendingMissed: Math.max(0, finiteOr(ts.pendingMissed, 0)),
    pendingUnknown: (Array.isArray(ts.pendingUnknown) ? ts.pendingUnknown : [])
      .filter(isRunKey)
      .slice(-PENDING_UNKNOWNS_MAX),
    gate:
      ts.gate !== null && typeof ts.gate === "object"
        ? { hour: finiteOr(ts.gate.hour, 0), attempted: ts.gate.attempted === true }
        : { ...EMPTY_HOUR_GATE },
    notifiedUnknown: (Array.isArray(ts.notifiedUnknown) ? ts.notifiedUnknown : [])
      .filter(isNotified)
      .slice(-NOTIFIED_UNKNOWN_MAX),
  };
}

/** Review r2 #14 (main-session ruling): which task ids of `sid` are LIVE (a definition exists in
 *  the agent's ledger). Records of live tasks are NEVER evicted; only orphan (deleted-task)
 *  records trim, oldest first. */
export type LiveTasksProvider = (sid: string) => ReadonlySet<string> | undefined;

export interface PruneReport {
  changed: boolean;
  /** Sessions whose LIVE task records alone exceeded the per-session cap (kept, not deleted). */
  overflowSessions: number;
}

/**
 * Prune dead sessions (7d without scan contact, or beyond the session cap). Per-session task
 * trimming (review r2 #14): live tasks' records are NEVER evicted; only orphans trim, oldest
 * first (by `lastAt`, then id). If the live records alone exceed the cap, everything is kept
 * and the session is reported in `overflowSessions` (the service surfaces a `capOverflow`
 * counter) — capacity pressure never deletes correctness state of a live task.
 */
export function pruneSessions(file: SchedHubFile, now: number, live: LiveTasksProvider = () => undefined): boolean {
  return pruneReport(file, now, live).changed;
}

export function pruneReport(file: SchedHubFile, now: number, live: LiveTasksProvider = () => undefined): PruneReport {
  let changed = false;
  for (const [sid, session] of Object.entries(file.sessions)) {
    if (now - session.lastSeenAt > SCHED_HUB_SESSION_TTL_MS) {
      delete file.sessions[sid];
      changed = true;
    }
  }
  let ids = Object.keys(file.sessions);
  if (ids.length > SCHED_HUB_SESSIONS_MAX) {
    ids.sort((a, b) => file.sessions[a]!.lastSeenAt - file.sessions[b]!.lastSeenAt);
    for (const sid of ids.slice(0, ids.length - SCHED_HUB_SESSIONS_MAX)) delete file.sessions[sid];
    changed = true;
  }
  let overflowSessions = 0;
  for (const [sid, session] of Object.entries(file.sessions)) {
    for (const [tid, ts] of Object.entries(session.tasks)) {
      const clamped = clampTaskState(ts);
      if (clamped !== ts) session.tasks[tid] = clamped;
    }
    const taskIds = Object.keys(session.tasks);
    if (taskIds.length <= SCHED_HUB_TASKS_PER_SESSION_MAX) continue;
    const liveSet = live(sid);
    const isLive = (id: string): boolean => id === "" || liveSet?.has(id) === true;
    const orphans = taskIds.filter((id) => !isLive(id));
    const liveCount = taskIds.length - orphans.length;
    if (liveCount > SCHED_HUB_TASKS_PER_SESSION_MAX) {
      // The live records alone exceed the cap: keep EVERYTHING, report the overflow.
      overflowSessions++;
      continue;
    }
    // Trim orphans (oldest first) until the session fits.
    const keepOrphans = SCHED_HUB_TASKS_PER_SESSION_MAX - liveCount;
    orphans.sort((a, b) => session.tasks[a]!.lastAt - session.tasks[b]!.lastAt || (a < b ? -1 : 1));
    for (const id of orphans.slice(0, Math.max(0, orphans.length - keepOrphans))) {
      delete session.tasks[id];
      changed = true;
    }
  }
  return { changed, overflowSessions };
}

export interface SchedHubStoreFs {
  ensureDir(path: string): void;
  read(path: string): string;
  writeAtomic(path: string, bytes: string): void;
  exists(path: string): boolean;
  /** Fault-injection seam; default `fs.fsyncSync` with the tolerance rule below. */
  fsync?(fd: number): void;
  /** Fault-injection seam; default `fs.renameSync`. */
  rename?(oldPath: string, newPath: string): void;
}

/**
 * Review r2 #4: fsync tolerates ONLY "not supported" errnos (EINVAL/ENOTSUP/EOPNOTSUPP/ENOSYS —
 * S1 writer.ts:155 precedent). EIO/ENOSPC/EROFS/… propagate ⇒ flush() reports false ⇒ the
 * caller must not deliver. Swallowing them reported a commit that never reached the disk.
 */
const FSYNC_TOLERATED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

function fsyncStrict(fs: SchedHubStoreFs, fd: number): void {
  const fn = fs.fsync ?? ((f: number) => fsyncSync(f));
  try {
    fn(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === undefined || !FSYNC_TOLERATED.has(code)) throw err;
  }
}

const defaultFs: SchedHubStoreFs = {
  ensureDir(path) {
    try {
      mkdirSync(path, { recursive: false, mode: 0o700 });
    } catch {
      /* already there */
    }
  },
  read(path) {
    return readFileSync(path, "utf8");
  },
  exists(path) {
    return existsSync(path);
  },
  writeAtomic(path, bytes) {
    writeAtomicImpl(this satisfies SchedHubStoreFs as SchedHubStoreFs, path, bytes);
  },
} satisfies SchedHubStoreFs;

/** Any write / fsync / rename / dir-fsync failure propagates (review r2 #4): flush() then
 *  reports false and the caller must not deliver on top of it. */
function writeAtomicImpl(fs: SchedHubStoreFs, path: string, bytes: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncStrict(fs, fd);
  } finally {
    closeSync(fd);
  }
  const rename = fs.rename ?? ((o: string, n: string) => renameSync(o, n));
  rename(tmp, path);
  const dirFd = openSync(dirname(path), "r");
  try {
    fsyncStrict(fs, dirFd);
  } finally {
    closeSync(dirFd);
  }
}

export interface SchedHubStore {
  /** True when the loaded file was corrupt/unreadable (fresh start, flagged). */
  readonly degraded: boolean;
  /** The live working copy (mutate freely; `flush()` persists). */
  readonly data: SchedHubFile;
  /** Sessions whose LIVE task records alone exceeded the per-session cap at the last flush. */
  readonly overflowSessions: number;
  /** Review r2 #14: which task ids are live per session (orphan-only eviction). */
  setLiveTasks(provider: LiveTasksProvider): void;
  load(): Promise<void>;
  /**
   * Serialize, clamp, prune and write. Resolves FALSE when the commit failed (disk error or
   * over-cap) — the caller must then NOT deliver anything built on this state (review r1 #4);
   * the in-memory copy keeps its pre-image only if the caller restores it.
   */
  flush(): Promise<boolean>;
  close(): Promise<void>;
}

export function createSchedHubStore(
  path: string,
  opts: { fs?: SchedHubStoreFs; now?: () => number } = {},
): SchedHubStore {
  // Merge (not replace): an injected seam overrides only the keys it names — injecting
  // `fsync` alone keeps the REAL write/rename chain, exactly what the r2 #4 fault tests need.
  const fs: SchedHubStoreFs = opts.fs === undefined ? defaultFs : { ...defaultFs, ...opts.fs };
  const now = opts.now ?? (() => Date.now());
  let data = freshFile();
  let degraded = false;
  let chain: Promise<void> = Promise.resolve();
  let closed = false;
  let liveProvider: LiveTasksProvider = () => undefined;
  let lastOverflow = 0;

  const doFlush = (): void => {
    lastOverflow = pruneReport(data, now(), liveProvider).overflowSessions;
    const bytes = JSON.stringify(data);
    if (bytes.length > SCHED_HUB_STATE_MAX_BYTES) {
      throw new Error(`schedule hub state exceeds ${SCHED_HUB_STATE_MAX_BYTES} bytes`);
    }
    fs.ensureDir(dirname(path));
    fs.writeAtomic(path, bytes);
    degraded = false;
  };

  return {
    get degraded() {
      return degraded;
    },
    get data() {
      return data;
    },
    get overflowSessions() {
      return lastOverflow;
    },
    setLiveTasks(provider: LiveTasksProvider): void {
      liveProvider = provider;
    },
    async load() {
      if (!fs.exists(path)) {
        data = freshFile();
        degraded = false;
        return;
      }
      try {
        const parsed = JSON.parse(fs.read(path)) as SchedHubFile;
        if (parsed === null || typeof parsed !== "object" || parsed.v !== SCHED_HUB_STATE_VERSION) {
          throw new Error("bad version");
        }
        data = sanitize(parsed);
        degraded = false;
      } catch {
        data = freshFile();
        degraded = true;
      }
    },
    flush(): Promise<boolean> {
      if (closed) return Promise.resolve(false);
      let ok = true;
      const run = chain.then(() => {
        if (closed) {
          ok = false;
          return;
        }
        try {
          doFlush();
        } catch {
          degraded = true;
          ok = false;
        }
      });
      chain = run.catch(() => {});
      return run.then(() => ok);
    },
    async close() {
      closed = true;
      await chain;
    },
  };
}

/** Defensive sanitize of the persisted shape (untrusted file). */
function sanitize(file: SchedHubFile): SchedHubFile {
  const out = freshFile();
  if (file.sessions === null || typeof file.sessions !== "object") return out;
  for (const [sid, rawSession] of Object.entries(file.sessions as Record<string, unknown>)) {
    if (rawSession === null || typeof rawSession !== "object") continue;
    const session = rawSession as SchedHubSessionState;
    const tasks: Record<string, SchedHubTaskState> = {};
    if (session.tasks !== null && typeof session.tasks === "object") {
      for (const [taskId, rawTask] of Object.entries(session.tasks as Record<string, unknown>)) {
        if (rawTask === null || typeof rawTask !== "object") continue;
        tasks[taskId] = clampTaskState(rawTask as SchedHubTaskState);
      }
    }
    out.sessions[sid] = {
      tasks,
      droppedPending: Math.max(0, finiteOr(session.droppedPending, 0)),
      droppedShown: Math.max(0, finiteOr(session.droppedShown, 0)),
      lastSeenAt: finiteOr(session.lastSeenAt, 0),
    };
  }
  return out;
}

function finiteOr(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

function isObserved(v: unknown): v is ObservedMiss {
  if (v === null || typeof v !== "object") return false;
  const o = v as ObservedMiss;
  return typeof o.t === "number" && Number.isFinite(o.t) && typeof o.defHash === "string" && typeof o.at === "number";
}

function isRunKey(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 128;
}

function isNotified(v: unknown): v is { runKey: string; at: number } {
  if (v === null || typeof v !== "object") return false;
  const n = v as { runKey: string; at: number };
  return typeof n.runKey === "string" && typeof n.at === "number" && Number.isFinite(n.at);
}

export const schedHubStatePath = (stateDir: string): string => join(stateDir, "schedule", SCHED_HUB_STATE_FILE);
