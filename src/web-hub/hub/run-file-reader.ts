/**
 * Run file reader (fleet-drawer plan §5.1, package F3a, issue #8): serve a terminal run's
 * transcript on the hub by walking its persisted session jsonl BACKWARD from the agent-reported
 * `finalLeafId` — without ever parsing the whole file (a ~47MB session must not block the hub's
 * event loop).
 *
 * Mechanics:
 * - Path validation mirrors `readBranchCached` (hub/history.ts): the path always comes from the
 *   agent, must end in `.jsonl`, and must realpath to a regular `.jsonl` file.
 * - Reverse scan: `FileHandle.read` backwards from EOF in `scanChunkBytes` (1 MiB) chunks,
 *   stitching partial lines across chunk boundaries as raw BYTES (a multi-byte UTF-8 char split
 *   at a chunk boundary is never decoded). The file is append-only, so a parent entry always
 *   precedes its child and ONE backward pass suffices: keep `want` (initially the leaf id),
 *   substring-prefilter each line for `"id":"<want>"` (JSON.stringify output has no spaces;
 *   `parentId`/`toolCallId` use a capital `I`; quotes inside string content are escaped — none
 *   of them can false-match), `JSON.parse` only prefilter hits to confirm `id === want`, project
 *   through the shared `projectSessionEntry` (protocol/keys.ts — hub/agent byte-identical), then
 *   continue with `parentId`. `want === null` (root) or the file head ends the scan; reaching the
 *   head with `want` still set ⇒ `leaf_missing`.
 * - Cooperative: after every chunk the scan `await`s one `setImmediate`; a caller whose
 *   `deadlineAt` is reached gets `busy`; cumulative scanned bytes beyond `maxScanBytes`
 *   (256 MiB) ⇒ `too_large`.
 * - Cursor cache: LRU of 16, keyed by `(realpath, size, mtimeMs, leafId)`, holding the projected
 *   chain (newest first) plus resume state (offset/carry/want), so a `before` page continues
 *   where the previous page stopped instead of rescanning from EOF. An append bumps size/mtime,
 *   changing the key and naturally rescanning.
 * - Snapshot semantics: the scan sees the file as stat'ed at read start (`size`, `mtimeMs`):
 *   bytes appended while a scan runs sit beyond the stat'd offset and are invisible to that
 *   read; the next read gets a changed cache key and naturally rescans.
 * - Cycle defense: confirmed entry ids go into a per-cursor `visited` set; hitting the same id
 *   again terminates the walk as `leaf_missing`. A healthy append-only file never triggers this
 *   — it guards against corrupted files / cyclic `parentId` chains (e.g. duplicated ids).
 * - Single-flight: one in-flight scan per cursor; concurrent readers share it and slice their own
 *   page from the chain afterwards. A global gate allows at most 2 concurrent scans; queued
 *   acquirers are bounded by their own `deadlineAt`, timeout ⇒ `busy`.
 */
import { Buffer } from "node:buffer";
import { open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { projectSessionEntry } from "../protocol/keys.js";
import type { WireEntry } from "../protocol/messages.js";

export const RUN_READER_SCAN_CHUNK_BYTES = 1 << 20;
export const RUN_READER_MAX_SCAN_BYTES = 256 << 20;
export const RUN_READER_CURSOR_CACHE_SIZE = 16;
export const RUN_READER_MAX_CONCURRENT_SCANS = 2;

export type RunFileReadFailure = "file_missing" | "leaf_missing" | "too_large" | "parse_error" | "busy";

export type RunFileReadResult =
  { ok: true; entries: WireEntry[]; hasMore: boolean } | { ok: false; reason: RunFileReadFailure };

export interface RunFileReadQuery {
  before?: string;
  limit: number;
  maxBytes: number;
  deadlineAt: number;
}

/** Live counters, handed in via `opts.stats` (tests drive the plan §10 P1–P5 assertions off it). */
export interface RunFileReaderStats {
  /** Scan rounds that acquired the gate (single-flight joiners never increment this). */
  rounds: number;
  /** Chunks read from disk. */
  chunks: number;
  /** Bytes read from disk. */
  bytes: number;
  /** setImmediate yields (one per processed chunk). */
  yields: number;
  /** Scan rounds that had to queue behind the concurrency gate. */
  gateWaits: number;
  /** Currently running scans (live gauge). */
  active: number;
  /** Peak concurrent scans observed. */
  maxConcurrent: number;
}

export function createRunFileReaderStats(): RunFileReaderStats {
  return { rounds: 0, chunks: 0, bytes: 0, yields: 0, gateWaits: 0, active: 0, maxConcurrent: 0 };
}

export interface RunFileReader {
  read(file: string, leafId: string, q: RunFileReadQuery): Promise<RunFileReadResult>;
  dispose(): void;
}

interface ChainItem {
  entry: WireEntry;
  /** Cached `Buffer.byteLength(JSON.stringify(entry))` so per-chunk re-evaluation never re-serializes. */
  bytes: number;
}

interface Cursor {
  real: string;
  /** File bytes `[0, offset)` are not scanned yet. */
  offset: number;
  /** Leftmost fragment of the last chunk read: the tail of a line continuing into the unscanned region. */
  rest: Buffer;
  /** Next id to find; `null` once an entry with `parentId: null` (root) was reached. */
  want: string | null;
  needleFor: string | null;
  needle: Buffer;
  /** Projected branch entries, NEWEST first. */
  chain: ChainItem[];
  done: boolean;
  failed: "leaf_missing" | "too_large" | "parse_error" | undefined;
  /** Cumulative bytes scanned for this cursor (across resumed rounds), bounded by maxScanBytes. */
  scannedBytes: number;
  /** Ids already confirmed on this walk; a re-hit means a cyclic `parentId` (corrupted file). */
  visited: Set<string>;
  /** The next chunk read is the file tail (trailing-partial-line tolerance applies once). */
  firstChunk: boolean;
  inflight: Promise<void> | null;
}

type Collect =
  { status: "ok"; entries: WireEntry[]; hasMore: boolean } | { status: "needmore" } | { status: "missing" };

const NEWLINE = 0x0a;

export function createRunFileReader(opts?: {
  now?: () => number;
  stats?: RunFileReaderStats;
  /** Test seam (plan fixes 1 MiB). */
  scanChunkBytes?: number;
  /** Test seam (plan fixes 256 MiB). */
  maxScanBytes?: number;
}): RunFileReader {
  const now = opts?.now ?? Date.now;
  const stats = opts?.stats ?? createRunFileReaderStats();
  const scanChunkBytes = opts?.scanChunkBytes ?? RUN_READER_SCAN_CHUNK_BYTES;
  const maxScanBytes = opts?.maxScanBytes ?? RUN_READER_MAX_SCAN_BYTES;
  const cursors = new Map<string, Cursor>();
  const waiters: Waiter[] = [];
  let active = 0;
  let disposed = false;

  interface Waiter {
    settled: boolean;
    timer: ReturnType<typeof setTimeout>;
    resolve: (ok: boolean) => void;
  }

  // ------------------------------------------------------------------ gate
  const trackActive = (): void => {
    stats.active = active;
    if (active > stats.maxConcurrent) stats.maxConcurrent = active;
  };

  const acquireGate = (deadlineAt: number): Promise<boolean> => {
    if (disposed) return Promise.resolve(false);
    if (active < RUN_READER_MAX_CONCURRENT_SCANS) {
      active++;
      trackActive();
      return Promise.resolve(true);
    }
    stats.gateWaits++;
    const delay = deadlineAt - now();
    if (delay <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const w: Waiter = {
        settled: false,
        resolve,
        timer: setTimeout(() => {
          if (w.settled) return;
          w.settled = true;
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          resolve(false);
        }, delay),
      };
      w.timer.unref();
      waiters.push(w);
    });
  };

  const releaseGate = (): void => {
    while (waiters.length > 0) {
      const w = waiters.shift();
      if (w === undefined) break;
      if (w.settled) continue;
      w.settled = true;
      clearTimeout(w.timer);
      w.resolve(true); // slot handed over: `active` unchanged
      return;
    }
    active--;
    trackActive();
  };

  // ------------------------------------------------------------------ cursor cache (LRU 16)
  const cacheGet = (key: string): Cursor | undefined => {
    const c = cursors.get(key);
    if (c === undefined) return undefined;
    cursors.delete(key);
    cursors.set(key, c); // LRU touch
    return c;
  };
  const cacheSet = (key: string, c: Cursor): void => {
    cursors.delete(key);
    cursors.set(key, c);
    while (cursors.size > RUN_READER_CURSOR_CACHE_SIZE) {
      const oldest = cursors.keys().next().value;
      if (oldest === undefined) break;
      cursors.delete(oldest);
    }
  };

  // ------------------------------------------------------------------ collect
  /**
   * Slice the request's page out of the cached chain (newest first). `needmore` ⇔ the chain is
   * exhausted before `limit` entries were collected (or `before` was never crossed) AND the scan
   * has not terminated. `missing` ⇔ `before` is not on the fully-scanned branch.
   */
  const collect = (cursor: Cursor, q: RunFileReadQuery): Collect => {
    const chain = cursor.chain;
    let start = 0;
    if (q.before !== undefined) {
      const f = chain.findIndex((item) => item.entry.id === q.before);
      if (f === -1) return cursor.done ? { status: "missing" } : { status: "needmore" };
      start = f + 1;
    }
    const picked: WireEntry[] = [];
    let bytes = 0;
    let j = start;
    for (; j < chain.length; j++) {
      if (picked.length >= q.limit) break;
      const item = chain[j]!;
      if (picked.length > 0 && bytes + item.bytes > q.maxBytes) break; // the newest page entry is always kept
      picked.push(item.entry);
      bytes += item.bytes;
    }
    if (j === chain.length && picked.length < q.limit && !cursor.done) return { status: "needmore" };
    picked.reverse(); // wire order: oldest first
    return { status: "ok", entries: picked, hasMore: j < chain.length || !cursor.done };
  };

  // ------------------------------------------------------------------ scanning
  const needleFor = (cursor: Cursor): Buffer => {
    if (cursor.needleFor !== cursor.want) {
      cursor.needle = Buffer.from(`"id":"${cursor.want ?? ""}"`, "utf8");
      cursor.needleFor = cursor.want;
    }
    return cursor.needle;
  };

  const processLine = (cursor: Cursor, line: Buffer, tolerateBadParse: boolean): void => {
    const want = cursor.want;
    if (want === null) return;
    let blank = true;
    for (const b of line) {
      if (b > 0x20) {
        blank = false;
        break;
      }
    }
    if (blank) return;
    if (line.indexOf(needleFor(cursor)) === -1) return; // substring prefilter: no parse for misses
    let v: unknown;
    try {
      v = JSON.parse(line.toString("utf8"));
    } catch {
      // The very tail of an append-only file may be a half-written line: skip it, never fail.
      if (tolerateBadParse) return;
      cursor.failed = "parse_error";
      return;
    }
    if (v === null || typeof v !== "object" || Array.isArray(v)) return;
    const r = v as Record<string, unknown>;
    if (r["id"] !== want) return; // prefilter false positive (e.g. a nested `{"id":...}` in content)
    if (cursor.visited.has(want)) {
      // Cyclic parentId (corrupted file with duplicated ids): a healthy append-only file never
      // revisits an id along a parent walk. Terminate as leaf_missing instead of walking on.
      cursor.failed = "leaf_missing";
      return;
    }
    cursor.visited.add(want);
    const projected = projectSessionEntry(r);
    if (projected !== undefined) {
      cursor.chain.push({ entry: projected, bytes: Buffer.byteLength(JSON.stringify(projected), "utf8") });
    }
    const parent: unknown = r["parentId"];
    cursor.want = typeof parent === "string" ? parent : null;
    if (cursor.want === null) cursor.done = true;
  };

  /**
   * Split `chunk` (prepended to the carried `rest`) into lines and process them newest-first.
   * `atHead` ⇔ the read reached offset 0, so even the leftmost fragment is a complete line.
   */
  const processChunk = (cursor: Cursor, chunk: Buffer, atHead: boolean): void => {
    const combined =
      chunk.length > 0 ? (cursor.rest.length > 0 ? Buffer.concat([chunk, cursor.rest]) : chunk) : cursor.rest;
    cursor.rest = Buffer.alloc(0);
    // Lines strictly right of `regionStart` are complete; frag0 ([0, regionStart)) carries left.
    let regionStart = -1;
    if (!atHead) {
      const nl = combined.indexOf(NEWLINE);
      if (nl === -1) {
        cursor.rest = combined;
        return;
      }
      regionStart = nl;
      cursor.rest = combined.subarray(0, nl);
    }
    let tolerate = cursor.firstChunk; // only the trailing fragment of the very first chunk
    cursor.firstChunk = false;
    let end = combined.length;
    for (let i = combined.length - 1; i >= regionStart; i--) {
      if (combined[i] !== NEWLINE) continue;
      const line = combined.subarray(i + 1, end);
      end = i;
      processLine(cursor, line, tolerate);
      tolerate = false;
      if (cursor.done || cursor.failed !== undefined) return;
    }
    if (atHead) processLine(cursor, combined.subarray(0, end), tolerate);
  };

  /**
   * One scan round: hold the gate and read chunks until the INITIATOR's page is satisfiable, the
   * scan terminates (root / file head / failure), or the initiator's deadline passes (progress
   * made so far stays in the cursor; a sharing caller with a later deadline may start its own
   * round right where this one stopped).
   */
  const scanRound = async (cursor: Cursor, q: RunFileReadQuery): Promise<void> => {
    const acquired = await acquireGate(q.deadlineAt);
    if (!acquired) return; // queued past deadline: the caller's loop maps this to `busy`
    stats.rounds++;
    let fh: FileHandle | undefined;
    try {
      fh = await open(cursor.real, "r");
      for (;;) {
        if (cursor.done || cursor.failed !== undefined) return;
        if (collect(cursor, q).status !== "needmore") return;
        if (now() >= q.deadlineAt) return;
        const start = Math.max(0, cursor.offset - scanChunkBytes);
        const len = cursor.offset - start;
        let chunk = Buffer.alloc(0);
        if (len > 0) {
          const raw = Buffer.allocUnsafe(len);
          const { bytesRead } = await fh.read(raw, 0, len, start);
          chunk = raw.subarray(0, bytesRead); // shrinks only if the file was truncated mid-scan
        }
        cursor.offset = start;
        cursor.scannedBytes += chunk.length;
        stats.chunks++;
        stats.bytes += chunk.length;
        if (cursor.scannedBytes > maxScanBytes) {
          cursor.failed = "too_large";
          return;
        }
        processChunk(cursor, chunk, start === 0);
        if (start === 0 && !cursor.done && cursor.failed === undefined) {
          // File head reached: the whole file is consumed. A still-pending `want` never
          // appeared ⇒ the leaf (or an ancestor of it) is not in this file.
          if (cursor.want === null || collect(cursor, q).status !== "needmore") cursor.done = true;
          else cursor.failed = "leaf_missing";
        }
        stats.yields++;
        await new Promise(setImmediate); // one event-loop yield per chunk
      }
    } catch {
      // The file validated at stat time; an I/O error mid-scan means its bytes cannot be read
      // as recorded — folded into parse_error (the reasons enum has no I/O slot).
      cursor.failed = "parse_error";
    } finally {
      if (fh !== undefined) await fh.close().catch(() => {});
      releaseGate();
    }
  };

  // ------------------------------------------------------------------ read
  const read = async (file: string, leafId: string, q: RunFileReadQuery): Promise<RunFileReadResult> => {
    if (disposed) return { ok: false, reason: "busy" };
    if (!file.endsWith(".jsonl")) return { ok: false, reason: "file_missing" };
    let real: string;
    let size: number;
    let mtimeMs: number;
    try {
      real = await realpath(file);
      if (!real.endsWith(".jsonl")) return { ok: false, reason: "file_missing" };
      const st = await stat(real);
      if (!st.isFile()) return { ok: false, reason: "file_missing" };
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      return { ok: false, reason: "file_missing" };
    }
    const limit = Math.max(1, Math.floor(q.limit));
    const query: RunFileReadQuery = { limit, maxBytes: q.maxBytes, deadlineAt: q.deadlineAt };
    if (q.before !== undefined) query.before = q.before;

    const key = `${real}\n${size}\n${mtimeMs}\n${leafId}`;
    let cursor = cacheGet(key);
    if (cursor === undefined) {
      cursor = {
        real,
        offset: size,
        rest: Buffer.alloc(0),
        want: leafId,
        needleFor: null,
        needle: Buffer.alloc(0),
        chain: [],
        done: false,
        failed: undefined,
        scannedBytes: 0,
        visited: new Set(),
        firstChunk: true,
        inflight: null,
      };
      cacheSet(key, cursor);
    }

    for (;;) {
      const c = collect(cursor, query);
      if (c.status === "ok") return { ok: true, entries: c.entries, hasMore: c.hasMore };
      if (c.status === "missing") return { ok: false, reason: "leaf_missing" };
      if (cursor.failed !== undefined) return { ok: false, reason: cursor.failed };
      if (disposed || now() >= query.deadlineAt) return { ok: false, reason: "busy" };
      // Single-flight: join the in-flight scan for this cursor, or start one. The check-and-set
      // is atomic (no await between them).
      let p = cursor.inflight;
      if (p === null) {
        p = scanRound(cursor, query);
        cursor.inflight = p;
      }
      await p;
      if (cursor.inflight === p) cursor.inflight = null;
    }
  };

  return {
    read,
    dispose() {
      disposed = true;
      cursors.clear();
      for (const w of waiters.splice(0)) {
        if (w.settled) continue;
        w.settled = true;
        clearTimeout(w.timer);
        w.resolve(false);
      }
    },
  };
}
