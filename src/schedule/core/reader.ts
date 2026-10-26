/**
 * Scheduled tasks — PURE READ-ONLY reader (plan r3 §7.6, S1). Used by the hub coordinator (H1)
 * and by the agent writer for its own reads.
 *
 * Zero writes, by construction and by test: no backup, no repair, no cleanup, no lock — a broken
 * file only yields `{kind:"degraded"}` and the panel says 「需在终端 /schedule repair」. Repairs
 * (`.bak` quarantine) belong to the agent writer.
 *
 * Every read walks `storeDir → session dir → file` through fd-anchored `O_NOFOLLOW` opens with
 * fstat type/owner/mode checks (paths.ts), re-checks the vault predicate on the literal AND
 * canonical store path, and refuses a store whose dev/ino moved since it was pinned. Sizes are
 * capped (state ≤ 256 KiB, report ≤ 256 KiB, listing ≤ 64 sessions) — IO per call is bounded;
 * the hub adds its own single-flight / deadline / IO-ledger budget around these sync calls.
 *
 * `validateStateFile` is the single structural validator of untrusted `state.json` content
 * (S0 deliberately shipped no schema — S0-report §5).
 */
import { opendirSync } from "node:fs";
import {
  closeQuiet,
  fdPath,
  isSessionDirName,
  openDirAt,
  openSessionDirAt,
  openStoreRoot,
  readFileAt,
  SchedFsError,
  sessionDirName,
  type FsCheckOpts,
  type SchedFsReason,
  type StoreRoot,
  type StoreRootOpts,
} from "./paths.js";
import {
  SCHED_HASH_RE,
  SCHED_MANUAL_REQS_MAX,
  SCHED_MAX_SESSION_DIRS,
  SCHED_MAX_TASKS_PER_SESSION,
  SCHED_MISSED_LOG_MAX,
  SCHED_NAME_MAX_CHARS,
  SCHED_PENDING_REPORTS_MAX,
  SCHED_PROMPT_MAX_BYTES,
  SCHED_REPORT_FILE_RE,
  SCHED_REPORT_MAX_BYTES,
  SCHED_REPORTS_DIR,
  SCHED_RUN_KEY_RE,
  SCHED_RUNS_PER_TASK,
  SCHED_STATE_FILE,
  SCHED_STATE_MAX_BYTES,
  SCHED_STATE_VERSION,
  SCHED_TASK_ID_RE,
  SCHED_BG_TIMEOUT_MAX_S,
  SCHED_BG_TIMEOUT_MIN_S,
  SCHEDULE_RUN_STATES,
  SCHEDULE_THINKING_LEVELS,
  type ScheduleStateFile,
} from "./spec.js";

// ----------------------------------------------------------------- validation

/** Upper bound on `runs.length` accepted from disk (20 terminal/task + non-terminal + orphans). */
export const SCHED_RUNS_HARD_MAX = SCHED_MAX_TASKS_PER_SESSION * SCHED_RUNS_PER_TASK * 2 + 64;

type V = string | undefined;
type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const isNat = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const RUN_STATES: ReadonlySet<string> = new Set(SCHEDULE_RUN_STATES);
const THINKING: ReadonlySet<string> = new Set(SCHEDULE_THINKING_LEVELS);

function vHolder(h: unknown, at: string): V {
  if (!isRec(h)) return `${at}: not an object`;
  if (!isNat(h.pid) || !isNat(h.start) || !isStr(h.host, 256) || !isStr(h.boot, 128) || !isStr(h.epoch, 128)) {
    return `${at}: bad holder`;
  }
  return undefined;
}

function vTask(t: unknown, at: string): V {
  if (!isRec(t)) return `${at}: not an object`;
  if (typeof t.id !== "string" || !SCHED_TASK_ID_RE.test(t.id)) return `${at}.id`;
  if (!isStr(t.name, SCHED_NAME_MAX_CHARS)) return `${at}.name`;
  if (t.form !== "background" && t.form !== "message") return `${at}.form`;
  const w = t.when;
  if (!isRec(w) || !isStr(w.tz, 64)) return `${at}.when`;
  if (w.kind === "cron") {
    if (!isStr(w.expr, 128)) return `${at}.when.expr`;
  } else if (w.kind === "once") {
    if (!isStr(w.at, 16)) return `${at}.when.at`;
  } else return `${at}.when.kind`;
  if (typeof t.prompt !== "string" || Buffer.byteLength(t.prompt, "utf8") > SCHED_PROMPT_MAX_BYTES)
    return `${at}.prompt`;
  if (!isBool(t.feishu) || !isBool(t.enabled)) return `${at}.flags`;
  if (t.bg !== undefined) {
    const b = t.bg;
    if (!isRec(b) || !isStr(b.type, 128) || b.type === "") return `${at}.bg.type`;
    if (!isNat(b.timeoutS) || b.timeoutS < SCHED_BG_TIMEOUT_MIN_S || b.timeoutS > SCHED_BG_TIMEOUT_MAX_S) {
      return `${at}.bg.timeoutS`;
    }
    if (!isBool(b.consultMain) || !isBool(b.handoff)) return `${at}.bg.flags`;
    if (b.model !== undefined && (!isRec(b.model) || !isStr(b.model.provider, 128) || !isStr(b.model.id, 256))) {
      return `${at}.bg.model`;
    }
    if (b.thinking !== undefined && !THINKING.has(String(b.thinking))) return `${at}.bg.thinking`;
    if (b.isolation !== undefined && b.isolation !== "worktree") return `${at}.bg.isolation`;
  }
  if ((t.form === "background") !== (t.bg !== undefined)) return `${at}.bg: present iff background`;
  if (t.approval !== undefined) {
    const a = t.approval;
    if (!isRec(a) || typeof a.hash !== "string" || !SCHED_HASH_RE.test(a.hash) || a.by !== "user")
      return `${at}.approval`;
    if ((a.via !== "tui" && a.via !== "web") || !isNat(a.at)) return `${at}.approval`;
  }
  if (t.createdBy !== "user" && t.createdBy !== "agent") return `${at}.createdBy`;
  if (t.createdVia !== "tui" && t.createdVia !== "web" && t.createdVia !== "tool") return `${at}.createdVia`;
  if (!isNat(t.createdAt)) return `${at}.createdAt`;
  if (!isStr(t.ownerCwd, 4096) || !t.ownerCwd.startsWith("/")) return `${at}.ownerCwd`;
  return undefined;
}

function vMissed(e: unknown, at: string): V {
  if (!isRec(e)) return `${at}: not an object`;
  if (!isNat(e.seq) || !isNat(e.from) || !isNat(e.to) || !isNat(e.count) || !isNat(e.totalAfter) || !isNat(e.at)) {
    return `${at}: bad numbers`;
  }
  if (typeof e.defHash !== "string" || !SCHED_HASH_RE.test(e.defHash)) return `${at}.defHash`;
  if (e.cause !== "offline" && e.cause !== "late" && e.cause !== "once-past") return `${at}.cause`;
  if (e.to < e.from) return `${at}: to < from`;
  return undefined;
}

function vOcc(o: unknown, at: string): V {
  if (!isRec(o)) return `${at}: not an object`;
  if (typeof o.defHash !== "string" || !SCHED_HASH_RE.test(o.defHash)) return `${at}.defHash`;
  for (const k of ["decidedThrough", "firedTotal", "missedTotal", "skippedTotal"])
    if (!isNat(o[k])) return `${at}.${k}`;
  if (!Array.isArray(o.missedLog) || o.missedLog.length > SCHED_MISSED_LOG_MAX) return `${at}.missedLog`;
  let prev = -1;
  for (let i = 0; i < o.missedLog.length; i++) {
    const err = vMissed(o.missedLog[i], `${at}.missedLog[${i}]`);
    if (err) return err;
    const seq = (o.missedLog[i] as Rec).seq as number;
    if (seq <= prev) return `${at}.missedLog: seq not ascending`;
    prev = seq;
  }
  return undefined;
}

function vRun(r: unknown, at: string): V {
  if (!isRec(r)) return `${at}: not an object`;
  if (typeof r.runKey !== "string" || !SCHED_RUN_KEY_RE.test(r.runKey)) return `${at}.runKey`;
  if (typeof r.taskId !== "string" || !r.runKey.startsWith(`${r.taskId}@`)) return `${at}.taskId`;
  if (r.kind !== "auto" && r.kind !== "manual") return `${at}.kind`;
  if (r.form !== "background" && r.form !== "message") return `${at}.form`;
  if (!isNat(r.scheduledAt) || !isNat(r.startedAt)) return `${at}: times`;
  if (r.endedAt !== undefined && !isNat(r.endedAt)) return `${at}.endedAt`;
  if (typeof r.defHash !== "string" || !SCHED_HASH_RE.test(r.defHash)) return `${at}.defHash`;
  if (!RUN_STATES.has(String(r.state))) return `${at}.state`;
  if (r.reason !== undefined && !isStr(r.reason, 256)) return `${at}.reason`;
  const h = vHolder(r.holder, `${at}.holder`);
  if (h) return h;
  if (r.runId !== undefined && !isStr(r.runId, 256)) return `${at}.runId`;
  if (r.reportFile !== undefined && (typeof r.reportFile !== "string" || !SCHED_REPORT_FILE_RE.test(r.reportFile))) {
    return `${at}.reportFile`;
  }
  if (r.note !== "none" && r.note !== "pending" && r.note !== "written" && r.note !== "unverified") return `${at}.note`;
  if (r.noteId !== undefined && !isStr(r.noteId, 128)) return `${at}.noteId`;
  if (r.noteHolder !== undefined) {
    const nh = vHolder(r.noteHolder, `${at}.noteHolder`);
    if (nh) return nh;
  }
  if (r.noteFileOffset !== undefined && !isNat(r.noteFileOffset)) return `${at}.noteFileOffset`;
  if (r.lateOutcome !== undefined && !isStr(r.lateOutcome, 256)) return `${at}.lateOutcome`;
  return undefined;
}

function vPending(p: unknown, at: string): V {
  if (!isRec(p)) return `${at}: not an object`;
  if (typeof p.reportId !== "string" || !SCHED_HASH_RE.test(p.reportId)) return `${at}.reportId`;
  if (typeof p.runKey !== "string" || !SCHED_RUN_KEY_RE.test(p.runKey)) return `${at}.runKey`;
  if (typeof p.taskId !== "string" || !SCHED_TASK_ID_RE.test(p.taskId)) return `${at}.taskId`;
  if (p.form !== "background" && p.form !== "message") return `${at}.form`;
  if (!isNat(p.endedAt) || !isNat(p.expiresAt)) return `${at}: times`;
  if (typeof p.reportFile !== "string" || !SCHED_REPORT_FILE_RE.test(p.reportFile)) return `${at}.reportFile`;
  if (!isStr(p.status, 256)) return `${at}.status`;
  return undefined;
}

export type StateValidation = { ok: true; state: ScheduleStateFile } | { ok: false; error: string };

/** Structural validation of untrusted state.json content. `expectSid` ⇒ sessionId must match. */
export function validateStateFile(raw: unknown, expectSid?: string): StateValidation {
  const fail = (error: string): StateValidation => ({ ok: false, error });
  if (!isRec(raw)) return fail("state: not an object");
  if (raw.v !== SCHED_STATE_VERSION) return fail("state.v: unsupported version");
  if (typeof raw.sessionId !== "string" || raw.sessionId === "" || raw.sessionId.length > 256)
    return fail("state.sessionId");
  if (expectSid !== undefined && raw.sessionId !== expectSid)
    return fail("state.sessionId: does not match the session");
  if (!isNat(raw.rev)) return fail("state.rev");
  if (!Array.isArray(raw.tasks) || raw.tasks.length > SCHED_MAX_TASKS_PER_SESSION) return fail("state.tasks");
  const ids = new Set<string>();
  for (let i = 0; i < raw.tasks.length; i++) {
    const err = vTask(raw.tasks[i], `state.tasks[${i}]`);
    if (err) return fail(err);
    const id = (raw.tasks[i] as Rec).id as string;
    if (ids.has(id)) return fail(`state.tasks[${i}].id: duplicate`);
    ids.add(id);
  }
  if (!isRec(raw.occ)) return fail("state.occ");
  for (const [k, o] of Object.entries(raw.occ)) {
    if (!SCHED_TASK_ID_RE.test(k)) return fail("state.occ: bad key");
    const err = vOcc(o, `state.occ.${k}`);
    if (err) return fail(err);
  }
  if (!isRec(raw.manualTotal)) return fail("state.manualTotal");
  for (const [k, n] of Object.entries(raw.manualTotal)) {
    if (!SCHED_TASK_ID_RE.test(k) || !isNat(n)) return fail("state.manualTotal: bad entry");
  }
  if (!Array.isArray(raw.runs) || raw.runs.length > SCHED_RUNS_HARD_MAX) return fail("state.runs");
  const keys = new Set<string>();
  for (let i = 0; i < raw.runs.length; i++) {
    const err = vRun(raw.runs[i], `state.runs[${i}]`);
    if (err) return fail(err);
    const k = (raw.runs[i] as Rec).runKey as string;
    if (keys.has(k)) return fail(`state.runs[${i}].runKey: duplicate`);
    keys.add(k);
  }
  if (!Array.isArray(raw.pendingReports) || raw.pendingReports.length > SCHED_PENDING_REPORTS_MAX) {
    return fail("state.pendingReports");
  }
  for (let i = 0; i < raw.pendingReports.length; i++) {
    const err = vPending(raw.pendingReports[i], `state.pendingReports[${i}]`);
    if (err) return fail(err);
  }
  const rs = raw.reportStats;
  if (!isRec(rs) || !isNat(rs.droppedIndexCap) || (rs.lastDroppedAt !== undefined && !isNat(rs.lastDroppedAt))) {
    return fail("state.reportStats");
  }
  if (!isRec(raw.manualReqs) || Object.keys(raw.manualReqs).length > SCHED_MANUAL_REQS_MAX * 2) {
    return fail("state.manualReqs");
  }
  for (const [k, q] of Object.entries(raw.manualReqs)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(k) || !isRec(q) || !isNat(q.at)) return fail("state.manualReqs: bad entry");
    if (q.runKey !== undefined && (typeof q.runKey !== "string" || !SCHED_RUN_KEY_RE.test(q.runKey))) {
      return fail("state.manualReqs: bad runKey");
    }
    if (q.refused !== undefined && !isStr(q.refused, 128)) return fail("state.manualReqs: bad refusal");
  }
  const dg = raw.digest;
  if (!isRec(dg) || !isRec(dg.shownMissedTotal) || !isNat(dg.shownRunsThrough)) return fail("state.digest");
  for (const n of Object.values(dg.shownMissedTotal)) if (!isNat(n)) return fail("state.digest.shownMissedTotal");
  if (dg.inflight !== undefined) {
    const err = vHolder(dg.inflight, "state.digest.inflight");
    if (err) return fail(err);
    const inf = dg.inflight as Rec;
    if (!isStr(inf.id, 128) || !isNat(inf.at) || (inf.fileOffset !== undefined && !isNat(inf.fileOffset))) {
      return fail("state.digest.inflight");
    }
  }
  return { ok: true, state: raw as unknown as ScheduleStateFile };
}

// ----------------------------------------------------------------- reads

export type StateReadDegradedReason = SchedFsReason | "json" | "schema" | "sid-mismatch";

export type SessionStateRead =
  | { kind: "ok"; state: ScheduleStateFile; bytes: number; mtimeMs: number }
  | { kind: "absent" }
  | { kind: "degraded"; reason: StateReadDegradedReason; detail: string };

/** Parse + validate a state.json buffer for the session directory `dirName`. */
export function parseStateBytes(bytes: Buffer, dirName: string): SessionStateRead {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { kind: "degraded", reason: "json", detail: "state.json is not valid JSON" };
  }
  const v = validateStateFile(raw);
  if (!v.ok) return { kind: "degraded", reason: "schema", detail: v.error };
  if (sessionDirName(v.state.sessionId) !== dirName) {
    return { kind: "degraded", reason: "sid-mismatch", detail: "state.sessionId does not belong to this directory" };
  }
  return { kind: "ok", state: v.state, bytes: bytes.length, mtimeMs: 0 };
}

/** Read `state.json` from an already-open, checked session directory fd. */
export function readStateAt(sessFd: number, dirName: string, opts: FsCheckOpts = {}): SessionStateRead {
  let read;
  try {
    read = readFileAt(sessFd, SCHED_STATE_FILE, SCHED_STATE_MAX_BYTES, opts);
  } catch (err) {
    if (err instanceof SchedFsError) {
      if (err.reason === "missing") return { kind: "absent" };
      return { kind: "degraded", reason: err.reason, detail: err.message };
    }
    return { kind: "degraded", reason: "io", detail: String(err) };
  }
  const parsed = parseStateBytes(read.bytes, dirName);
  return parsed.kind === "ok" ? { ...parsed, mtimeMs: read.mtimeMs } : parsed;
}

function degradedOf(err: unknown): { kind: "degraded"; reason: SchedFsReason; detail: string } {
  if (err instanceof SchedFsError) return { kind: "degraded", reason: err.reason, detail: err.message };
  return { kind: "degraded", reason: "io", detail: String(err) };
}

/** Read one session's ledger by directory name (hub scan unit). */
export function readSessionState(root: StoreRoot, dirName: string, opts: StoreRootOpts = {}): SessionStateRead {
  if (!isSessionDirName(dirName))
    return { kind: "degraded", reason: "bad-name", detail: "not a session directory name" };
  let rootFd: number | undefined;
  let sessFd: number | undefined;
  try {
    rootFd = openStoreRoot(root, opts).fd;
    try {
      sessFd = openSessionDirAt(rootFd, root.real, dirName, opts).fd;
    } catch (err) {
      if (err instanceof SchedFsError && err.reason === "missing") return { kind: "absent" };
      throw err;
    }
    return readStateAt(sessFd, dirName, opts);
  } catch (err) {
    return degradedOf(err);
  } finally {
    closeQuiet(sessFd);
    closeQuiet(rootFd);
  }
}

/** Convenience: read by session id. */
export function readSessionStateById(root: StoreRoot, sessionId: string, opts: StoreRootOpts = {}): SessionStateRead {
  return readSessionState(root, sessionDirName(sessionId), opts);
}

export type StoreListing =
  { kind: "ok"; dirs: string[]; truncated: boolean } | { kind: "degraded"; reason: SchedFsReason; detail: string };

/** Hard bound on directory entries inspected per listing. */
export const SCHED_LIST_SCAN_MAX = 1024;

/**
 * Session directory names under the store (sorted, ≤ `max`, default 64). Non-directories,
 * symlinks and non-session names are skipped (never followed). Bounded scan.
 */
export function listSessionDirs(root: StoreRoot, opts: StoreRootOpts & { max?: number } = {}): StoreListing {
  const max = opts.max ?? SCHED_MAX_SESSION_DIRS;
  let rootFd: number | undefined;
  try {
    rootFd = openStoreRoot(root, opts).fd;
    const dir = opendirSync(fdPath(rootFd));
    const names: string[] = [];
    let scanned = 0;
    let truncated = false;
    try {
      for (;;) {
        const ent = dir.readSync();
        if (ent === null) break;
        if (++scanned > SCHED_LIST_SCAN_MAX) {
          truncated = true;
          break;
        }
        if (!isSessionDirName(ent.name)) continue;
        // Known non-directory types (incl. symlinks) are skipped; DT_UNKNOWN entries are kept and
        // judged by the O_NOFOLLOW|O_DIRECTORY open of the actual read.
        const other =
          ent.isFile() ||
          ent.isSymbolicLink() ||
          ent.isFIFO() ||
          ent.isSocket() ||
          ent.isBlockDevice() ||
          ent.isCharacterDevice();
        if (!ent.isDirectory() && other) continue;
        names.push(ent.name);
      }
    } finally {
      dir.closeSync();
    }
    names.sort();
    if (names.length > max) {
      truncated = true;
      names.length = max;
    }
    return { kind: "ok", dirs: names, truncated };
  } catch (err) {
    return degradedOf(err);
  } finally {
    closeQuiet(rootFd);
  }
}

export type ReportRead =
  | { kind: "ok"; text: string; bytes: number }
  | { kind: "degraded"; reason: SchedFsReason | "bad-path"; detail: string };

/** Read a report file using the bounded short-name or legacy 64hex relative path contract. */
export function readReportFile(
  root: StoreRoot,
  dirName: string,
  reportFile: string,
  opts: StoreRootOpts & { maxBytes?: number } = {},
): ReportRead {
  if (!SCHED_REPORT_FILE_RE.test(reportFile) || !isSessionDirName(dirName)) {
    return { kind: "degraded", reason: "bad-path", detail: "report path shape refused" };
  }
  const name = reportFile.slice(SCHED_REPORTS_DIR.length + 1);
  let rootFd: number | undefined;
  let sessFd: number | undefined;
  let repFd: number | undefined;
  try {
    rootFd = openStoreRoot(root, opts).fd;
    sessFd = openSessionDirAt(rootFd, root.real, dirName, opts).fd;
    repFd = openDirAt(sessFd, SCHED_REPORTS_DIR, opts).fd;
    const r = readFileAt(repFd, name, opts.maxBytes ?? SCHED_REPORT_MAX_BYTES, opts);
    return { kind: "ok", text: r.bytes.toString("utf8"), bytes: r.size };
  } catch (err) {
    return degradedOf(err);
  } finally {
    closeQuiet(repFd);
    closeQuiet(sessFd);
    closeQuiet(rootFd);
  }
}
