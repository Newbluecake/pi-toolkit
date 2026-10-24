/**
 * Scheduled tasks — session-file entry proof (plan r3 §6.3 / §5.5, S1).
 *
 * THE ONLY proof that a scheduler message (result note, digest, handoff) was written: a line in the
 * owning session's jsonl file with `type:"custom_message"`, `customType:"subagent:schedule"` and
 * `details.<key> === <id>` (key `noteId` or `digestId`). Return values of `sendMessage`, pi's
 * in-memory pending queue, `message_start/message_end` and `getBranch()` never count.
 *
 * Bounded read: from `offset` (the file size stat'ed before sending; a file now SHORTER than that
 * was rewritten ⇒ scan from 0) to EOF, ≤ 16 MiB per call (beyond ⇒ `too-large`, the caller records
 * `unverified` and never resends), opened `O_NOFOLLOW|O_NONBLOCK` (symlink / non-regular ⇒
 * `refused`), optional monotonic deadline between chunks (⇒ `inconclusive`, try again later).
 * Only lines containing the literal `"subagent:schedule"` are JSON-parsed.
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { SCHED_CUSTOM_TYPE, SCHED_NOTE_PROOF_MAX_BYTES } from "./spec.js";

const O_NOFOLLOW: number = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
const O_NONBLOCK: number = (fsConstants as Record<string, number | undefined>).O_NONBLOCK ?? 0;
const CHUNK = 256 * 1024;
/** Lines longer than this are skipped unparsed (scheduler entries are a few KiB). */
export const SCHED_PROOF_LINE_MAX = 1024 * 1024;
const LINE_KEEP_MAX = SCHED_PROOF_LINE_MAX;
const NEEDLE = Buffer.from(JSON.stringify(SCHED_CUSTOM_TYPE), "utf8");

export type ProofKey = "noteId" | "digestId";

/**
 * Identity of the session file at send time (review M4): the offset is only trusted while the file
 * is provably the same append sequence — same dev/ino, still ≥ offset bytes, and the first and the
 * last ≤ 4 KiB before `offset` hash identically. Anything else ⇒ rewritten ⇒ full (bounded) rescan.
 * Serializable with `encodeAnchor` (≤ 128 chars) for a persisted field.
 */
export interface FileAnchor {
  offset: number;
  dev: number;
  ino: number;
  /** sha256 (first 16 hex) of bytes [0, min(4096, offset)). */
  head: string;
  /** sha256 (first 16 hex) of bytes [max(0, offset − 4096), offset). */
  tail: string;
}

export const SCHED_ANCHOR_WINDOW = 4096;

/**
 * Kernel file timestamps come from a coarse clock (one jiffy, ≤ 10 ms; multigrain ctime only on
 * newer kernels/filesystems): a write landing in the SAME tick as the change that preceded our
 * start snapshot can leave ctime/mtime unchanged. A file changed within this margin of the scan
 * start therefore never proves absence (inconclusive "unsettled"; the caller retries later).
 */
export const SCHED_PROOF_SETTLE_MS = 50;

/** bigint fstat/lstat snapshot compared before/after a scan (review round 2, M4). */
interface StatSnap {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}
function snapOf(st: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): StatSnap {
  return { dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs };
}
function sameSnap(a: StatSnap, b: StatSnap): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

export type ProofQuery = {
  file: string;
  key: ProofKey;
  id: string;
  maxBytes?: number;
  /** Absolute deadline on `clock()` (default `performance.now`). */
  deadlineAt?: number;
  clock?: () => number;
  /** A file whose ctime is younger than this at scan start cannot prove absence (see
   *  SCHED_PROOF_SETTLE_MS). Default SCHED_PROOF_SETTLE_MS; tests may pass 0. */
  settleMs?: number;
  /** Wall clock in ms (default `Date.now`), only for the settle check. */
  wallNow?: () => number;
} & (
  | { anchor: FileAnchor; offset?: never }
  /** A bare offset cannot prove file identity: offset 0 = full scan; offset > 0 ⇒ an `absent`
   *  outcome is reported as `inconclusive("unanchored")` (never a resend basis). */
  | { offset: number; anchor?: never }
);

export type ProofResult =
  | { kind: "found"; entryId?: string; atByte: number }
  /** Scanned the whole relevant range of a stable, identity-proven file without a match. */
  | { kind: "absent"; scannedFrom: number; scannedTo: number; rewritten: boolean }
  | { kind: "too-large"; bytes: number }
  | { kind: "inconclusive"; reason: "deadline" | "short-read" | "changed" | "unsettled" | "unanchored" }
  | { kind: "refused"; reason: "missing" | "symlink" | "not-file" | "io"; detail: string };

function hashRange(fd: number, from: number, to: number): string | undefined {
  const len = to - from;
  if (len < 0) return undefined;
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = readSync(fd, buf, off, len - off, from + off);
    if (n <= 0) return undefined;
    off += n;
  }
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

function anchorAt(fd: number, offset: number, dev: number, ino: number): FileAnchor | undefined {
  const head = hashRange(fd, 0, Math.min(SCHED_ANCHOR_WINDOW, offset));
  const tail = hashRange(fd, Math.max(0, offset - SCHED_ANCHOR_WINDOW), offset);
  if (head === undefined || tail === undefined) return undefined;
  return { offset, dev, ino, head, tail };
}

export function encodeAnchor(a: FileAnchor): string {
  return `a1:${a.offset}:${a.dev}:${a.ino}:${a.head}:${a.tail}`;
}

export function decodeAnchor(text: string): FileAnchor | undefined {
  const m = /^a1:(\d{1,16}):(\d{1,20}):(\d{1,20}):([0-9a-f]{16}):([0-9a-f]{16})$/.exec(text);
  if (m === null) return undefined;
  const [offset, dev, ino] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (![offset, dev, ino].every(Number.isSafeInteger)) return undefined;
  return { offset, dev, ino, head: m[4]!, tail: m[5]! };
}

/** Pre-send anchor (§6.3 step 1). `offset 0` anchor for a missing file; undefined when unreadable. */
export function sessionFileAnchor(file: string): FileAnchor | undefined {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { offset: 0, dev: 0, ino: 0, head: EMPTY16, tail: EMPTY16 }
      : undefined;
  }
  try {
    const st = fstatSync(fd);
    return st.isFile() ? anchorAt(fd, st.size, st.dev, st.ino) : undefined;
  } finally {
    closeSync(fd);
  }
}

const EMPTY16 = createHash("sha256").update(Buffer.alloc(0)).digest("hex").slice(0, 16);

function matches(line: Buffer, key: ProofKey, id: string): { ok: boolean; entryId?: string } {
  if (line.indexOf(NEEDLE) < 0) return { ok: false };
  let v: unknown;
  try {
    v = JSON.parse(line.toString("utf8"));
  } catch {
    return { ok: false };
  }
  if (v === null || typeof v !== "object") return { ok: false };
  const e = v as Record<string, unknown>;
  if (e.type !== "custom_message" || e.customType !== SCHED_CUSTOM_TYPE) return { ok: false };
  const d = e.details;
  if (d === null || typeof d !== "object" || (d as Record<string, unknown>)[key] !== id) return { ok: false };
  return { ok: true, ...(typeof e.id === "string" ? { entryId: e.id } : {}) };
}

export function findSessionEntry(q: ProofQuery): ProofResult {
  const max = q.maxBytes ?? SCHED_NOTE_PROOF_MAX_BYTES;
  const clock = q.clock ?? (() => performance.now());
  let fd: number;
  try {
    fd = openSync(q.file, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "refused", reason: "missing", detail: "session file missing" };
    if (code === "ELOOP") return { kind: "refused", reason: "symlink", detail: "session file is a symlink" };
    return { kind: "refused", reason: "io", detail: String(code ?? err) };
  }
  try {
    // Snapshot FIRST (before anything is read): every byte we look at must come from this state.
    const before = snapOf(fstatSync(fd, { bigint: true }));
    const st = fstatSync(fd);
    if (!st.isFile()) return { kind: "refused", reason: "not-file", detail: "session file is not a regular file" };
    const settleNs = BigInt(Math.max(0, Math.floor(q.settleMs ?? SCHED_PROOF_SETTLE_MS))) * 1_000_000n;
    const unsettled = BigInt(Math.floor((q.wallNow ?? Date.now)())) * 1_000_000n - before.ctimeNs < settleNs;
    let start: number;
    let rewritten = false;
    let unanchored = false;
    if (q.anchor !== undefined) {
      const a = q.anchor;
      const same =
        a.offset === 0 ||
        (a.dev === st.dev &&
          a.ino === st.ino &&
          st.size >= a.offset &&
          (() => {
            const now = anchorAt(fd, a.offset, st.dev, st.ino);
            return now !== undefined && now.head === a.head && now.tail === a.tail;
          })());
      start = same ? a.offset : 0;
      rewritten = !same;
    } else {
      const off = q.offset;
      start = Number.isSafeInteger(off) && off >= 0 && off <= st.size ? off : 0;
      unanchored = start > 0;
    }
    const end = st.size;
    if (end - start > max) return { kind: "too-large", bytes: end - start };
    let pos = start;
    let carry = Buffer.alloc(0);
    let carryAt = start;
    /** Inside an over-long line (our entries are a few KiB): discard until its newline. */
    let skipping = false;
    const buf = Buffer.alloc(CHUNK);
    while (pos < end) {
      if (q.deadlineAt !== undefined && clock() > q.deadlineAt) return { kind: "inconclusive", reason: "deadline" };
      const n = readSync(fd, buf, 0, Math.min(CHUNK, end - pos), pos);
      // Premature EOF (truncated while we read): nothing about absence can be concluded.
      if (n <= 0) return { kind: "inconclusive", reason: "short-read" };
      const chunkAt = pos;
      pos += n;
      let data = buf.subarray(0, n);
      let base = chunkAt;
      if (skipping) {
        const nl = data.indexOf(0x0a);
        if (nl < 0) continue;
        skipping = false;
        data = data.subarray(nl + 1);
        base += nl + 1;
        carry = Buffer.alloc(0);
        carryAt = base;
      }
      if (carry.length > 0) {
        data = Buffer.concat([carry, data]);
        base = carryAt;
      }
      let nl: number;
      while ((nl = data.indexOf(0x0a)) >= 0) {
        const m = matches(data.subarray(0, nl), q.key, q.id);
        if (m.ok) return { kind: "found", atByte: base, ...(m.entryId === undefined ? {} : { entryId: m.entryId }) };
        data = data.subarray(nl + 1);
        base += nl + 1;
      }
      if (data.length > LINE_KEEP_MAX) {
        skipping = true;
        carry = Buffer.alloc(0);
      } else {
        carry = Buffer.from(data);
        carryAt = base;
      }
    }
    // A trailing line without newline is still a complete JSON write in pi's append model.
    if (!skipping && carry.length > 0) {
      const m = matches(carry, q.key, q.id);
      if (m.ok) return { kind: "found", atByte: carryAt, ...(m.entryId === undefined ? {} : { entryId: m.entryId }) };
    }
    // "absent" needs proof that NOTHING changed while we read (review round 2, M4): the open object
    // and the path must both still match the start snapshot — dev, ino, size, mtimeNs, ctimeNs. An
    // in-place rewrite that restores the original size still moves ctime. Any difference ⇒
    // inconclusive: the caller does not re-deliver (at-most-once — rather miss than duplicate).
    let byFd: StatSnap;
    let byPath: StatSnap;
    try {
      byFd = snapOf(fstatSync(fd, { bigint: true }));
      byPath = snapOf(lstatSync(q.file, { bigint: true }));
    } catch {
      return { kind: "inconclusive", reason: "changed" };
    }
    if (!sameSnap(before, byFd) || !sameSnap(before, byPath) || BigInt(end) !== before.size) {
      return { kind: "inconclusive", reason: "changed" };
    }
    if (unsettled) return { kind: "inconclusive", reason: "unsettled" };
    if (unanchored) return { kind: "inconclusive", reason: "unanchored" };
    return { kind: "absent", scannedFrom: start, scannedTo: pos, rewritten };
  } catch (err) {
    return { kind: "refused", reason: "io", detail: String((err as NodeJS.ErrnoException).code ?? err) };
  } finally {
    closeSync(fd);
  }
}

/** Pre-send offset (§6.3 step 1): the session file's current size, or 0 when it does not exist yet. */
export function sessionFileOffset(file: string): number | undefined {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? 0 : undefined;
  }
  try {
    const st = fstatSync(fd);
    return st.isFile() ? st.size : undefined;
  } finally {
    closeSync(fd);
  }
}
