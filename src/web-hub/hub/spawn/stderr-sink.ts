/**
 * web-hub-spawn plan §SP5 (arch v2 §7.8): bounded stderr sink for one managed spawn.
 *
 * Memory: a fixed 64 KiB byte ring (O(1) append, keeps the LAST bytes) feeding `tail()` — the
 * owner-only `stderrTail`/`hintDetail` projections (arch §6.4) — plus a single-writer pending
 * queue capped at 64 KiB that drops OLDEST on overflow and counts every dropped byte. A slow
 * disk can therefore only back the queue up to its cap; it can never grow hub memory nor block
 * stdout reading (two independent streams).
 *
 * Disk: `<logDir>/<spawnId>.stderr.log`, appended through ONE in-flight `write` at a time. The
 * file stops at 256 KiB with a final `[truncated N bytes]` line; a write error (ENOSPC/EIO)
 * closes the handle for good and records the code — the ring keeps working either way.
 * `ensureLogDir()` creates the 0700 dir and evicts oldest-by-mtime `*.stderr.log` files down to
 * ≤19 BEFORE a new file is created (≤20 including the newcomer).
 *
 * `close(deadline)` races the flush against the caller's remaining budget via `raceDeadline`;
 * on timeout the remaining queue is abandoned (counted as dropped) and the handle closes when
 * the in-flight write, if any, eventually lands. All of this is deliberate about the #10 hard
 * gate: nothing here allocates proportionally to stderr volume.
 */
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import {
  STDERR_FILE_MAX,
  STDERR_FILES_MAX,
  STDERR_QUEUE_BYTES,
  STDERR_RING_BYTES,
  STDERR_TAIL_BYTES,
} from "../../protocol/spawn.js";
import type { HubLog } from "../ports.js";
import { raceDeadline, type ReqDeadline } from "../req-deadline.js";

// ---------------------------------------------------------------------------
// injectable fs surface (dir management is sync+bounded; the data path is async)
// ---------------------------------------------------------------------------

/** The async half tests wrap to simulate slow/failed disks (a hanging or ENOSPC `write`). */
export interface SinkFileHandle {
  write(buf: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface StderrFs {
  mkdirSync(dir: string, opts: { recursive: true; mode: number }): void;
  readdirSync(dir: string): string[];
  statSync(path: string): { mtimeMs: number; isFile(): boolean };
  unlinkSync(path: string): void;
  /** Opens for append, creating with `mode` — the default maps to `fs.promises.open(p, "a", 0o600)`. */
  open(path: string, mode: number): Promise<SinkFileHandle>;
}

const REAL_STDERR_FS: StderrFs = {
  mkdirSync: (d, o) => mkdirSync(d, o),
  readdirSync: (d) => readdirSync(d),
  statSync: (p) => statSync(p),
  unlinkSync: (p) => unlinkSync(p),
  open: (p, mode) =>
    open(p, "a", mode).then((h) => ({
      write: (buf: Uint8Array) => h.write(buf).then(() => undefined),
      close: () => h.close(),
    })),
};

/**
 * Create the 0700 log dir and evict oldest-by-mtime `*.stderr.log` files down to
 * `STDERR_FILES_MAX - 1` (=19) so that creating one more file stays within the 20-file cap
 * (arch §7.8). Only hub-named log files are considered — anything else a user drops into the
 * dir is left alone. Best-effort per file; mkdir failures propagate to the caller.
 */
export function ensureLogDir(
  dir: string,
  fs: Pick<StderrFs, "mkdirSync" | "readdirSync" | "statSync" | "unlinkSync">,
): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logs: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".stderr.log")) continue;
    try {
      const st = fs.statSync(`${dir}/${name}`);
      if (st.isFile()) logs.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      /* raced away between readdir and stat */
    }
  }
  const keep = STDERR_FILES_MAX - 1;
  if (logs.length <= keep) return;
  logs.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (let i = 0; i < logs.length - keep; i++) {
    const victim = logs[i];
    if (victim === undefined) continue;
    try {
      fs.unlinkSync(`${dir}/${victim.name}`);
    } catch {
      /* raced away — the next ensure pass re-evaluates */
    }
  }
}

// ---------------------------------------------------------------------------
// fixed byte ring: O(1) append, keeps the LAST STDERR_RING_BYTES bytes
// ---------------------------------------------------------------------------

interface ByteRing {
  readonly buf: Buffer;
  start: number;
  len: number;
}

function ringAlloc(size: number): ByteRing {
  return { buf: Buffer.alloc(size), start: 0, len: 0 };
}

function ringAppend(r: ByteRing, chunk: Uint8Array): void {
  const size = r.buf.length;
  if (size === 0) return;
  if (chunk.length >= size) {
    // Keep only the tail; may split a UTF-8 char at the head — tail() trims that.
    r.buf.set(chunk.subarray(chunk.length - size));
    r.start = 0;
    r.len = size;
    return;
  }
  const overflow = Math.max(0, r.len + chunk.length - size);
  const writeAt = (r.start + r.len) % size;
  if (overflow > 0) r.start = (r.start + overflow) % size;
  r.len = Math.min(size, r.len + chunk.length); // min() — the adjustment above already evicted
  const first = Math.min(chunk.length, size - writeAt);
  r.buf.set(chunk.subarray(0, first), writeAt);
  if (first < chunk.length) r.buf.set(chunk.subarray(first), 0);
}

function ringTailBytes(r: ByteRing, maxBytes: number): Buffer {
  const take = Math.max(0, Math.min(maxBytes, r.len));
  if (take === 0) return Buffer.alloc(0);
  const from = (r.start + r.len - take) % r.buf.length;
  if (from + take <= r.buf.length) return r.buf.subarray(from, from + take);
  const headLen = r.buf.length - from;
  const out = Buffer.alloc(take);
  out.set(r.buf.subarray(from), 0);
  out.set(r.buf.subarray(0, take - headLen), headLen);
  return out;
}

/** Trim leading continuation bytes and a trailing incomplete UTF-8 sequence (≤3 bytes each). */
function trimPartialUtf8(b: Buffer): Buffer {
  let lo = 0;
  while (lo < 3 && lo < b.length && (b[lo]! & 0xc0) === 0x80) lo++;
  let hi = b.length;
  for (let back = 1; back <= 3 && back <= hi - lo; back++) {
    const byte = b[hi - back]!;
    if ((byte & 0xc0) !== 0x80) {
      const expect = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      if (expect > back) hi -= back; // last sequence is truncated mid-char
      break;
    }
  }
  return lo === 0 && hi === b.length ? b : b.subarray(lo, hi);
}

// ---------------------------------------------------------------------------
// the sink
// ---------------------------------------------------------------------------

export interface StderrSinkStats {
  /** Bytes accepted but never written: queue overflow + cap truncation + post-stop pushes. */
  dropped: number;
  /** Bytes successfully handed to the file (including the truncation marker). */
  written: number;
  /** First disk error code (e.g. "ENOSPC"); set ⇒ the file is closed for good. */
  error?: string;
}

export interface StderrSink {
  push(chunk: Uint8Array): void;
  /** Last ≤maxBytes bytes of stderr as UTF-8 (default `STDERR_TAIL_BYTES`), ring-backed. */
  tail(maxBytes?: number): string;
  close(deadline: ReqDeadline): Promise<void>;
  stats(): StderrSinkStats;
}

export interface StderrSinkDeps {
  /** Spawn logDir (`webHubSpawnFiles(stateDir).logDir`). */
  dir: string;
  spawnId: string;
  /** Partial override on top of the real fs (tests hang/fail writes, fake dirs). */
  fs?: Partial<StderrFs>;
  /** Interface parity with plan §SP5 — nothing in the sink itself needs a clock. */
  now(): number;
  log: HubLog;
}

interface QNode {
  data: Buffer;
  next?: QNode;
}

export function createStderrSink(deps: StderrSinkDeps): StderrSink {
  const fs: StderrFs = { ...REAL_STDERR_FS, ...deps.fs };
  const log = deps.log;
  const file = `${deps.dir}/${deps.spawnId}.stderr.log`;

  const ring = ringAlloc(STDERR_RING_BYTES);

  let qHead: QNode | undefined;
  let qTail: QNode | undefined;
  let qBytes = 0;

  let fh: SinkFileHandle | undefined;
  let opening = false;
  let writing = false;
  /** Bytes of the currently in-flight write — counted into `dropped` if it never lands. */
  let inFlightBytes = 0;
  let capped = false;
  /** Exact-fit prefix of the cap-flip chunk — flushed to disk BEFORE the truncation marker. */
  let pendingPrefix: Buffer | undefined;
  let pendingMarker: Buffer | undefined;
  let errored: string | undefined;
  let dropped = 0;
  let written = 0;
  /** Set when close() abandoned an in-flight write whose bytes were already counted dropped. */
  let inFlightAbandoned = false;

  let closeStarted = false;
  let closeResolve: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;

  function clearQueue(): void {
    qHead = undefined;
    qTail = undefined;
    qBytes = 0;
  }

  function errCode(err: unknown): string {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      typeof err.code === "string" &&
      err.code.length > 0
    ) {
      return err.code;
    }
    return "E_IO";
  }

  function closeHandle(): void {
    const h = fh;
    fh = undefined;
    if (h !== undefined) h.close().catch(() => {});
  }

  function fail(err: unknown): void {
    writing = false;
    errored = errCode(err);
    // The dequeued-but-unwritten in-flight part is as lost as the queued remainder — unless
    // an abandon already counted it.
    dropped += qBytes + (inFlightAbandoned ? 0 : inFlightBytes);
    inFlightAbandoned = false;
    inFlightBytes = 0;
    clearQueue();
    pendingPrefix = undefined;
    pendingMarker = undefined;
    closeHandle();
    log.warn("spawn stderr: disk writer disabled after error", { file, code: errored });
    maybeFinishClose();
  }

  function maybeFinishClose(): void {
    if (closeResolve === undefined || writing || opening) return;
    closeHandle();
    const resolve = closeResolve;
    closeResolve = undefined;
    resolve();
  }

  function writeNext(part: Buffer): void {
    const h = fh;
    if (h === undefined) {
      // Handle vanished between scheduling and writing (fail path) — nothing to do.
      return;
    }
    writing = true;
    inFlightBytes = part.length;
    h.write(part).then(
      () => {
        writing = false;
        written += part.length;
        inFlightBytes = 0;
        if (inFlightAbandoned) {
          // It landed after all — un-count the bytes the abandon charged to `dropped`.
          dropped -= part.length;
          inFlightAbandoned = false;
        }
        drain();
      },
      (err: unknown) => fail(err),
    );
  }

  function drain(): void {
    if (errored !== undefined) return;
    // Cap flip: exact-fit prefix first, then the truncation marker, then stop for good.
    if (pendingPrefix !== undefined) {
      if (writing || opening || fh === undefined) return;
      const part = pendingPrefix;
      pendingPrefix = undefined;
      writeNext(part);
      return;
    }
    if (pendingMarker !== undefined) {
      if (writing || opening || fh === undefined) return;
      const marker = pendingMarker;
      pendingMarker = undefined;
      writeNext(marker);
      return;
    }
    if (capped) {
      // Marker flushed and queue gone: the fd is never needed again — release it now instead
      // of holding it until close().
      if (!writing && !opening) {
        closeHandle();
        maybeFinishClose();
      }
      return;
    }
    if (writing || opening || fh === undefined) return;
    const node = qHead;
    if (node === undefined) {
      maybeFinishClose();
      return;
    }
    const remaining = STDERR_FILE_MAX - written;
    if (remaining <= 0) {
      capNow(undefined);
      drain();
      return;
    }
    if (node.data.length > remaining) {
      capNow(node.data.subarray(0, remaining));
      drain();
      return;
    }
    qHead = node.next;
    if (qHead === undefined) qTail = undefined;
    qBytes -= node.data.length;
    writeNext(node.data);
  }

  /**
   * Flip the 256 KiB cap: every queued byte except `partial` (an exact-fit prefix of the head
   * chunk) becomes truncation. The marker's N is the cumulative `dropped` at this moment —
   * later pushes still count into `dropped` (stats stay honest) but the file is closed for good.
   */
  function capNow(partial: Buffer | undefined): void {
    dropped += qBytes - (partial?.length ?? 0);
    clearQueue();
    capped = true;
    pendingPrefix = partial;
    pendingMarker = Buffer.from(`\n[truncated ${dropped} bytes]\n`);
  }

  return {
    push(chunk: Uint8Array): void {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      ringAppend(ring, buf);
      if (errored !== undefined || capped || closeStarted) {
        dropped += buf.length; // ring keeps it for tail(), but the disk will never see it
        return;
      }
      if (buf.length > STDERR_QUEUE_BYTES) {
        dropped += buf.length; // a single chunk larger than the whole queue can never fit
        return;
      }
      while (qHead !== undefined && qBytes + buf.length > STDERR_QUEUE_BYTES) {
        dropped += qHead.data.length; // overflow drops the OLDEST pending bytes
        qBytes -= qHead.data.length;
        qHead = qHead.next;
        if (qHead === undefined) qTail = undefined;
      }
      const node: QNode = { data: buf };
      if (qTail === undefined) {
        qHead = node;
        qTail = node;
      } else {
        qTail.next = node;
        qTail = node;
      }
      qBytes += buf.length;
      if (fh === undefined && !opening) {
        // Lazy open on first data: a sink closed without any stderr never touches the disk.
        opening = true;
        try {
          ensureLogDir(deps.dir, fs);
        } catch (err) {
          opening = false;
          fail(err); // queue bytes already counted as dropped inside fail()
          return;
        }
        fs.open(file, 0o600).then(
          (h) => {
            opening = false;
            fh = h;
            drain();
          },
          (err: unknown) => fail(err),
        );
        return;
      }
      drain();
    },

    tail(maxBytes: number = STDERR_TAIL_BYTES): string {
      const clamped = Math.max(0, Math.min(maxBytes, STDERR_RING_BYTES));
      return trimPartialUtf8(ringTailBytes(ring, clamped)).toString("utf8");
    },

    close(deadline: ReqDeadline): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closeStarted = true;
      const settle = new Promise<void>((resolve) => {
        closeResolve = resolve;
      });
      drain(); // kick an idle writer; a never-opened sink finishes immediately
      maybeFinishClose();
      closePromise = raceDeadline(settle, Math.max(0, deadline.remaining())).then(
        () => undefined,
        () => {
          // Budget exhausted: abandon the queue (counted as dropped, in-flight bytes
          // included — refunded if that write lands after all). If a write is still in
          // flight, its completion path closes the handle; nothing else ever will.
          dropped += qBytes;
          clearQueue();
          if (inFlightBytes > 0) {
            dropped += inFlightBytes;
            inFlightAbandoned = true;
          }
          return undefined;
        },
      );
      return closePromise;
    },

    stats(): StderrSinkStats {
      return errored === undefined ? { dropped, written } : { dropped, written, error: errored };
    },
  };
}
