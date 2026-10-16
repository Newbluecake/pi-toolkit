/**
 * web-resume plan §2.1/§2.2 (P1, frozen API): the dir-wide subagent provenance index.
 *
 * A session file is a subagent child iff some MAIN session's `subagent:run` entry (its
 * `diag.sessionFile`) names it. The index is the union of every such mark ever scanned in the
 * WHOLE session dir (not just the 48 h window), so an old parent + a recently-reused pre-v0.4.0
 * child pair is hidden too. Sources: cache v2 (all entries, any age — pi jsonl is append-only,
 * so a cached mark is a valid lower bound without any re-stat) ∪ fresh scans.
 *
 * Backfill (plan r2 #4): each `advanceProvenance` call works under a budget {ms, bytes}.
 * Lane ① scans pending files whose mtime is inside the 48 h window (active files), capped at
 * half the byte budget; lane ② then walks a persisted round-robin cursor over the dir (files
 * ordered by path, starting after the cursor, wrapping once). Each file reads at most one
 * 8 MiB chunk per call — a huge file never starves the others and resumes from `scannedTo`
 * on its next turn. Per-entry resume rule: same dev/ino and size ≥ scannedTo ⇒ continue at
 * scannedTo; identity change or shrink ⇒ marks dropped, restart at 0.
 *
 * Capacity semantics (§2.1 table): 20 000 tracked files (newest by mtime), 2 048 marks /
 * 512 KiB serialized per entry (`over:true` + status "capacity"), 16 MiB cache file (oversized
 * ⇒ treated as absent and rebuilt on read; evict oldest-mtime entries until it fits on write).
 * Guarantee: a self-marked child (v0.4.0+) is always hidden regardless of the index (the head
 * reader checks it per displayed row); a pre-v0.4.0 child is hidden iff its parent is tracked
 * and not truncated. Disclosed residuals live in AGENTS.md / the plan.
 *
 * Cache v2 = one JSON file per session dir:
 * `<agent>/cache/session-nav/provenance-v2/<sha256(resolve(sessionDir))[0:16]>.json` (the v1
 * `subagent-marks.json` is shared across cwds and simply ignored). Atomic tmp+rename, 0600,
 * last writer wins — the cache is an optimisation and a lower bound, a lost write only costs a
 * rescan. Every file open (scan + cache read) goes through `openSessionNoFollowAsync`
 * (O_NOFOLLOW|O_NONBLOCK|O_NOCTTY, fstat regular-or-reject); no `readFile(path)` /
 * `createReadStream(path)` (source-scan test). No module-scope mutable state; no timers.
 */
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { mkdir, open as openAsync, readdir, rename, unlink, lstat, type FileHandle } from "node:fs/promises";
import { openSessionNoFollowAsync } from "./session-head.js";

// ---------------------------------------------------------------------------
// frozen API + capacity constants (§2.1 table)
// ---------------------------------------------------------------------------

/** Frozen (§2.2). `has(absPath)` resolves internally; `complete` per §2.1's definition. */
export interface ProvenanceIndex {
  has(absPath: string): boolean;
  readonly complete: boolean;
}

/** §2.4's wire field source — additive, NOT part of the frozen interface (see provenanceStatus). */
export type ProvenanceStatus = "complete" | "partial" | "capacity";

/** The object `advanceProvenance` actually returns (structurally a `ProvenanceIndex`). */
export interface ProvenanceIndexWithStatus extends ProvenanceIndex {
  readonly status: ProvenanceStatus;
  /** Which capacity limit fired ("files" | "marks" | "bytes"), when status is "capacity". */
  readonly capacity?: "files" | "marks" | "bytes";
}

/** Read §2.4's wire value off an index (any `ProvenanceIndex`; defaults to complete/partial). */
export function provenanceStatus(index: ProvenanceIndex): ProvenanceStatus {
  const status = (index as Partial<ProvenanceIndexWithStatus>).status;
  return status ?? (index.complete ? "complete" : "partial");
}

/** Per-file chunk cap per call (§2.1 backfill fairness). */
export const PROVENANCE_SCAN_CHUNK_BYTES = 8 * 1024 * 1024;
/** Tracked files per dir: 20 000 newest by mtime; older never scanned (`capacity:"files"`). */
export const PROVENANCE_TRACKED_FILES_MAX = 20_000;
export const PROVENANCE_MARKS_PER_ENTRY_MAX = 2_048;
/** A stored mark is a basename when the child is in the same dir, else a path ≤ this many bytes. */
export const PROVENANCE_MARK_PATH_MAX_BYTES = 4 * 1024;
export const PROVENANCE_ENTRY_MAX_BYTES = 512 * 1024;
export const PROVENANCE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
/** Lane ① window: files with mtime inside the last 48 h go first (§2.1). */
export const PROVENANCE_RECENT_WINDOW_MS = 48 * 60 * 60 * 1000;
/** §2.1/§2.4 budget: ≤2 s, ≤64 MiB read per call (≤4 fds — the scan is sequential, so ≤1). */
export const DEFAULT_PROVENANCE_BUDGET = { ms: 2_000, bytes: 64 * 1024 * 1024 };

// ---------------------------------------------------------------------------
// cache v2
// ---------------------------------------------------------------------------

export interface ProvenanceEntry {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  /** Byte offset just after the last complete `\n` already scanned. */
  scannedTo: number;
  /** Child paths (basename when same dir, else ≤4 KiB path). */
  marks: string[];
  /** A mark/entry cap was hit — extra marks were dropped (status "capacity"). */
  over?: true;
}

interface CacheFileV2 {
  version: 2;
  /** Round-robin cursor: last visited path (lane ②), persisted. */
  cursor: string;
  files: Record<string, ProvenanceEntry>;
}

/** `<agent>/cache/session-nav/provenance-v2/<sha256(resolve(sessionDir))[0:16]>.json`. */
export function provenanceCachePath(sessionDir: string): string {
  const dir = resolve(sessionDir);
  // sessionDir = <agent>/sessions/<encoded-cwd> → cache root <agent>/cache/session-nav/
  const hash = createHash("sha256").update(dir).digest("hex").slice(0, 16);
  return join(dirname(dirname(dir)), "cache", "session-nav", "provenance-v2", `${hash}.json`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Approximate serialized size of an entry (the 512 KiB cap is enforced on this estimate). */
function approxEntryBytes(entry: ProvenanceEntry): number {
  let total = 128; // keys + numbers + brackets
  for (const m of entry.marks) total += Buffer.byteLength(m, "utf8") + 6; // quotes + comma + margin
  return total;
}

/** Strict read-back validation; an invalid entry is dropped (forces a cheap rescan). */
function sanitizeEntry(raw: unknown): ProvenanceEntry | undefined {
  if (!isPlainObject(raw)) return undefined;
  const dev = finiteNumber(raw["dev"]);
  const ino = finiteNumber(raw["ino"]);
  const size = finiteNumber(raw["size"]);
  const mtimeMs = finiteNumber(raw["mtimeMs"]);
  const scannedTo = finiteNumber(raw["scannedTo"]);
  if (dev === undefined || ino === undefined || size === undefined || mtimeMs === undefined) return undefined;
  if (scannedTo === undefined || !Number.isInteger(scannedTo) || scannedTo < 0 || scannedTo > size) return undefined;
  const rawMarks = raw["marks"];
  if (!Array.isArray(rawMarks)) return undefined;
  const marks: string[] = [];
  let over = raw["over"] === true;
  let approxBytes = 128;
  for (const m of rawMarks) {
    if (typeof m !== "string") {
      over = true;
      continue;
    }
    const mBytes = Buffer.byteLength(m, "utf8");
    if (
      marks.length >= PROVENANCE_MARKS_PER_ENTRY_MAX ||
      mBytes > PROVENANCE_MARK_PATH_MAX_BYTES ||
      approxBytes + mBytes > PROVENANCE_ENTRY_MAX_BYTES
    ) {
      over = true;
      break;
    }
    if (!marks.includes(m)) {
      marks.push(m);
      approxBytes += mBytes + 6;
    }
  }
  const entry: ProvenanceEntry = { dev, ino, size, mtimeMs, scannedTo, marks };
  if (over) entry.over = true;
  return entry;
}

function emptyCache(): CacheFileV2 {
  return { version: 2, cursor: "", files: {} };
}

async function readAt(handle: FileHandle, buf: Buffer, want: number, position: number): Promise<number> {
  let done = 0;
  while (done < want) {
    const { bytesRead } = await handle.read(buf, done, want - done, position + done);
    if (bytesRead <= 0) break;
    done += bytesRead;
  }
  return done;
}

/** Cache read under the open discipline; a file > 16 MiB is treated as absent (§2.1 table). */
async function loadCache(cacheFile: string): Promise<CacheFileV2> {
  const opened = await openSessionNoFollowAsync(cacheFile);
  if (!opened) return emptyCache();
  const { handle, fact } = opened;
  try {
    if (fact.size <= 0 || fact.size > PROVENANCE_CACHE_MAX_BYTES) return emptyCache();
    const buf = Buffer.alloc(fact.size);
    const n = await readAt(handle, buf, fact.size, 0);
    if (n !== fact.size) return emptyCache();
    const parsed: unknown = JSON.parse(buf.toString("utf8"));
    if (!isPlainObject(parsed) || parsed["version"] !== 2) return emptyCache();
    const filesRaw = parsed["files"];
    const cursorRaw = parsed["cursor"];
    if (!isPlainObject(filesRaw) || typeof cursorRaw !== "string") return emptyCache();
    const files: Record<string, ProvenanceEntry> = {};
    for (const [key, value] of Object.entries(filesRaw)) {
      const entry = sanitizeEntry(value);
      if (entry !== undefined) files[key] = entry;
    }
    return { version: 2, cursor: cursorRaw, files };
  } catch {
    return emptyCache();
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Atomic write (tmp + rename, 0600). Over 16 MiB: evict oldest-mtime entries until it fits
 * (§2.1 "write" row — report `capacity:"bytes"`); the caller learns via the return value.
 */
async function saveCache(cacheFile: string, cache: CacheFileV2): Promise<boolean> {
  let evicted = false;
  let json = JSON.stringify(cache);
  while (Buffer.byteLength(json, "utf8") > PROVENANCE_CACHE_MAX_BYTES) {
    const keys = Object.keys(cache.files);
    if (keys.length === 0) return false;
    let oldest: string | undefined;
    let oldestMtime = Infinity;
    for (const key of keys) {
      const mtime = cache.files[key]?.mtimeMs;
      if (mtime !== undefined && mtime < oldestMtime) {
        oldestMtime = mtime;
        oldest = key;
      }
    }
    if (oldest === undefined) return false;
    delete cache.files[oldest];
    evicted = true;
    json = JSON.stringify(cache);
  }
  try {
    await mkdir(dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
      const handle = await openAsync(tmp, "w", 0o600);
      try {
        await handle.writeFile(json, "utf8");
      } finally {
        await handle.close();
      }
      await rename(tmp, cacheFile);
    } catch {
      await unlink(tmp).catch(() => {});
      return evicted;
    }
    return evicted;
  } catch {
    return evicted; // cache write failure never affects behaviour — next call rescans a bit
  }
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

/**
 * Pinned equal to `src/adapters/pi-run-log.ts`'s `RUN_CUSTOM_TYPE` by a source-scan test —
 * no runtime import (keep this module pi-free and adapter-free).
 */
export const SUBAGENT_RUN_CUSTOM_TYPE = "subagent:run";

interface ScanCtx {
  dir: string;
  entries: Map<string, ProvenanceEntry>;
  scratch: Buffer | undefined;
  dirty: boolean;
  /** Set when any mark/entry cap fired during THIS call's scans. */
  capacityMarks: boolean;
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Store one mark; returns true when the entry just hit a cap (`over` set). */
function storeMark(ctx: ScanCtx, entry: ProvenanceEntry, sessionFile: string): boolean {
  if (entry.over) return false; // already capped — extra marks dropped silently
  if (entry.marks.length >= PROVENANCE_MARKS_PER_ENTRY_MAX) {
    entry.over = true;
    return true;
  }
  const abs = sessionFile.startsWith("/") ? sessionFile : resolve(ctx.dir, sessionFile);
  if (Buffer.byteLength(abs, "utf8") > PROVENANCE_MARK_PATH_MAX_BYTES) {
    entry.over = true;
    return true;
  }
  const stored = dirname(abs) === ctx.dir ? basename(abs) : abs;
  const markBytes = Buffer.byteLength(stored, "utf8");
  if (approxEntryBytes(entry) + markBytes > PROVENANCE_ENTRY_MAX_BYTES) {
    entry.over = true;
    return true;
  }
  if (!entry.marks.includes(stored)) entry.marks.push(stored);
  return false;
}

/**
 * Scan one bounded chunk of a file on an already-disciplined fd. Advances `scannedTo` to just
 * after the last complete `\n` in the chunk; a chunk with no newline consumes budget but makes
 * no progress (bounded churn — pi lines are far below 8 MiB). Returns bytes read (0 = nothing
 * to do / unreadable now — the entry stays a valid lower bound).
 */
async function scanFileChunk(ctx: ScanCtx, path: string, maxBytes: number): Promise<number> {
  const opened = await openSessionNoFollowAsync(path);
  if (!opened) return 0;
  const { handle, fact: fresh } = opened;
  try {
    let entry = ctx.entries.get(path);
    if (entry !== undefined && (entry.dev !== fresh.dev || entry.ino !== fresh.ino || fresh.size < entry.scannedTo)) {
      entry = undefined; // identity changed / shrank → drop marks, restart at 0
      ctx.dirty = true;
    }
    if (entry === undefined) {
      entry = { dev: fresh.dev, ino: fresh.ino, size: fresh.size, mtimeMs: fresh.mtimeMs, scannedTo: 0, marks: [] };
      ctx.entries.set(path, entry);
      ctx.dirty = true;
    } else if (
      entry.dev !== fresh.dev ||
      entry.ino !== fresh.ino ||
      entry.size !== fresh.size ||
      entry.mtimeMs !== fresh.mtimeMs
    ) {
      entry.dev = fresh.dev;
      entry.ino = fresh.ino;
      entry.size = fresh.size;
      entry.mtimeMs = fresh.mtimeMs;
      ctx.dirty = true;
    }
    const startAt = entry.scannedTo;
    if (startAt >= fresh.size || maxBytes <= 0) return 0;
    const want = Math.min(maxBytes, PROVENANCE_SCAN_CHUNK_BYTES, fresh.size - startAt);
    if (want <= 0) return 0;
    if (ctx.scratch === undefined) ctx.scratch = Buffer.allocUnsafeSlow(PROVENANCE_SCAN_CHUNK_BYTES);
    const buf = ctx.scratch;
    const n = await readAt(handle, buf, want, startAt);
    if (n <= 0) return 0;
    const window = buf.subarray(0, n);
    const lastNl = window.lastIndexOf(0x0a);
    if (lastNl < 0) return n; // no complete line in this chunk — reread from scannedTo next call
    let off = 0;
    while (off <= lastNl) {
      const nl = window.indexOf(0x0a, off);
      if (nl < 0 || nl > lastNl) break;
      const line = window.subarray(off, nl).toString("utf8");
      off = nl + 1;
      if (!line.includes('"subagent:run"')) continue; // cheap prefilter before JSON.parse
      const parsed = parseJson(line);
      if (!isPlainObject(parsed) || parsed["type"] !== "custom" || parsed["customType"] !== "subagent:run") continue;
      const data = parsed["data"];
      const diag = isPlainObject(data) ? data["diag"] : undefined;
      const sessionFile = isPlainObject(diag) ? diag["sessionFile"] : undefined;
      if (typeof sessionFile !== "string" || sessionFile === "") continue;
      if (storeMark(ctx, entry, sessionFile)) ctx.capacityMarks = true;
    }
    entry.scannedTo = startAt + lastNl + 1;
    ctx.dirty = true;
    return n;
  } finally {
    await handle.close().catch(() => {});
  }
}

function isPending(
  fact: { path: string; dev: number; ino: number; size: number },
  entries: Map<string, ProvenanceEntry>,
): boolean {
  const entry = entries.get(fact.path);
  if (entry === undefined) return true;
  if (entry.dev !== fact.dev || entry.ino !== fact.ino) return true;
  if (fact.size < entry.scannedTo) return true;
  return entry.scannedTo < fact.size;
}

/** lstat-enumerate the dir's `.jsonl` regular files (symlinks are not session files). */
async function enumerateFacts(
  dir: string,
): Promise<{ path: string; dev: number; ino: number; size: number; mtimeMs: number }[] | undefined> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const facts: { path: string; dev: number; ino: number; size: number; mtimeMs: number }[] = [];
  for (const dirent of dirents) {
    if (!dirent.name.endsWith(".jsonl") || !dirent.isFile()) continue;
    const path = resolve(join(dir, dirent.name));
    try {
      const st = await lstat(path);
      if (st.isFile()) facts.push({ path, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* raced away — not tracked */
    }
  }
  return facts;
}

// ---------------------------------------------------------------------------
// advanceProvenance (frozen §2.2 entry point)
// ---------------------------------------------------------------------------

/**
 * One budgeted incremental backfill pass + index read. Never throws (a dir that cannot be read
 * yields an empty, non-complete index; cache problems degrade to a rescan).
 */
export async function advanceProvenance(
  sessionDir: string,
  budget: { ms: number; bytes: number },
  signal?: AbortSignal,
): Promise<ProvenanceIndex> {
  const dir = resolve(sessionDir);
  const ms = Number.isFinite(budget.ms) ? Math.max(0, Math.floor(budget.ms)) : 0;
  const totalBytes = Number.isFinite(budget.bytes) ? Math.max(0, Math.floor(budget.bytes)) : 0;
  const deadline = Date.now() + ms;
  const bytesLeft = { n: totalBytes };
  const timeUp = () => signal?.aborted === true || Date.now() >= deadline;

  const cache = await loadCache(provenanceCachePath(dir));
  const entries = new Map(Object.entries(cache.files));
  const ctx: ScanCtx = { dir, entries, scratch: undefined, dirty: false, capacityMarks: false };

  const facts = await enumerateFacts(dir);
  let capacityFiles = false;
  let tracked: { path: string; dev: number; ino: number; size: number; mtimeMs: number }[] = [];
  if (facts !== undefined) {
    facts.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
    if (facts.length > PROVENANCE_TRACKED_FILES_MAX) {
      tracked = facts.slice(0, PROVENANCE_TRACKED_FILES_MAX); // oldest never scanned
      capacityFiles = true;
    } else {
      tracked = facts;
    }
  }

  const processed = new Set<string>();

  // Lane ① — pending files inside the 48 h window, newest first, ≤ half the byte budget.
  const lane1Cap = Math.floor(totalBytes / 2);
  let lane1Used = 0;
  if (facts !== undefined) {
    const now = Date.now();
    for (const fact of tracked) {
      if (lane1Used >= lane1Cap || bytesLeft.n <= 0 || timeUp()) break;
      if (fact.mtimeMs < now - PROVENANCE_RECENT_WINDOW_MS) break; // sorted newest-first
      processed.add(fact.path);
      if (!isPending(fact, entries)) continue;
      const allow = Math.min(PROVENANCE_SCAN_CHUNK_BYTES, lane1Cap - lane1Used, bytesLeft.n);
      if (allow <= 0) break;
      const n = await scanFileChunk(ctx, fact.path, allow);
      lane1Used += n;
      bytesLeft.n -= n;
    }
  }

  // Lane ② — round-robin cursor over all tracked files (path order), start after it, wrap once.
  if (facts !== undefined && tracked.length > 0) {
    const sorted = tracked.map((f) => f.path).sort();
    const factByPath = new Map(tracked.map((f) => [f.path, f] as const));
    let start = 0;
    if (cache.cursor !== "") {
      const idx = sorted.findIndex((p) => p > cache.cursor);
      start = idx < 0 ? 0 : idx;
    }
    for (let i = 0; i < sorted.length; i++) {
      if (bytesLeft.n <= 0 || timeUp()) break;
      const path = sorted[(start + i) % sorted.length];
      if (path === undefined) continue;
      cache.cursor = path; // moves past the file even if unfinished — no starvation
      if (processed.has(path)) continue;
      const fact = factByPath.get(path);
      if (fact === undefined || !isPending(fact, entries)) continue;
      const allow = Math.min(PROVENANCE_SCAN_CHUNK_BYTES, bytesLeft.n);
      const n = await scanFileChunk(ctx, path, allow);
      processed.add(path);
      bytesLeft.n -= n;
    }
  }

  // Completion (§2.1): every tracked file current and fully scanned, and no capacity limit hit.
  let perFileComplete = facts !== undefined;
  let anyOver = false;
  if (perFileComplete) {
    for (const fact of tracked) {
      const entry = entries.get(fact.path);
      if (entry === undefined || entry.dev !== fact.dev || entry.ino !== fact.ino || entry.scannedTo !== fact.size) {
        perFileComplete = false;
        break;
      }
      if (entry.over) anyOver = true;
    }
  }
  if (ctx.capacityMarks) anyOver = true;

  let capacityWrite = false;
  if (ctx.dirty && signal?.aborted !== true) {
    // A build finishing under an aborted signal never writes the cache (§2.4 fence discipline).
    const persist: CacheFileV2 = { version: 2, cursor: cache.cursor, files: Object.fromEntries(entries) };
    capacityWrite = await saveCache(provenanceCachePath(dir), persist);
  }

  const capacity = capacityFiles || anyOver || capacityWrite;
  const complete = perFileComplete && !capacity;
  const capacityKind: "files" | "marks" | "bytes" | undefined = capacityFiles
    ? "files"
    : anyOver
      ? "marks"
      : capacityWrite
        ? "bytes"
        : undefined;

  const markSet = new Set<string>();
  for (const entry of entries.values()) {
    for (const m of entry.marks) markSet.add(m.startsWith("/") ? resolve(m) : resolve(dir, m));
  }
  const index: ProvenanceIndexWithStatus = {
    has(absPath: string): boolean {
      return markSet.has(resolve(absPath));
    },
    complete,
    status: capacity ? "capacity" : complete ? "complete" : "partial",
    ...(capacityKind !== undefined ? { capacity: capacityKind } : {}),
  };
  return index;
}
