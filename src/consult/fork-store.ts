import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, resolve as resolvePath, sep } from "node:path";
import { CURRENT_SESSION_VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ForkExpertSessionResult, Millis } from "../core/types.js";

/**
 * consult fork store (docs/dev/consult/plan.md §5.1/§6 C-9, package B).
 *
 * Everything here is synchronous fs + try/catch silent degradation: this
 * module runs inside the consult tool's synchronous fork step and inside
 * `buildSessionStack`'s sweep, and neither may throw.
 *
 * The fork itself is a **handwritten streaming copy**, not
 * `SessionManager.forkFrom` — P0-α④ measured the forkFrom+open chain at
 * 102–160 ms on a 10 MB session (three full reads: source, instance
 * construction, open), past the 100 ms budget. This implementation keeps the
 * exact on-disk contract forkFrom produces (new id, fresh header with
 * `parentSession` pointing at the resolved source path, `flag:"wx"` so an
 * existing file is never clobbered, header written before any entry) while
 * skipping the instance-construction re-read entirely (§11-2 disposition:
 * 3 reads → 2; `driver.resume`'s `SessionManager.open` remains the second).
 */

/**
 * Sweep window for orphaned fork copies (plan §4.6: internal constant,
 * deliberately NOT a setting — knob-creep guard, review-1 #20).
 * Multi-process safety premise ①: consultDir lives under ~/.pi/agent/cache
 * and is therefore shared across pi processes, but every live consult run is
 * bounded by its 150 s totalMs hard cap (no grace, no extension), so a fork
 * file still in use is at least ~576× younger than this TTL.
 */
export const FORK_TTL_MS: Millis = 24 * 60 * 60 * 1000;

/**
 * Header parsing is capped at the first 8 KB of the file (plan §5.1, §6 C-9):
 * a real pi session always starts with its (small) `type:"session"` header
 * line, so anything longer is not a header we want to reason about — and the
 * cap is what keeps `readHeaderCwd`/sweep from ever reading a large file just
 * to look at its first line.
 */
const HEADER_SCAN_LIMIT_BYTES = 8 * 1024;

/** Copy chunk for the streaming tail. 512 KB keeps the syscall count sane on ~10 MB sessions without a big memory spike. */
const COPY_CHUNK_BYTES = 512 * 1024;

/** The looser header shape we accept from a scanned source (a handcrafted file may omit cwd/timestamp). */
interface ScannedSessionHeader {
  type: "session";
  id: string;
  version?: number;
  timestamp?: string;
  cwd?: string;
  parentSession?: string;
}

interface HeadScan {
  header: ScannedSessionHeader;
  /** File offset where post-header content starts (just past the header line's newline; may equal fileSize). */
  contentStart: number;
  fileSize: number;
}

/** Consult fork copies live here: `~/.pi/agent/cache/consult-sessions` via pi's own accessor (review-1 #15 — never derived by walking up from a session dir). */
export function consultSessionDir(): string {
  return join(getAgentDir(), "cache", "consult-sessions");
}

/** Single-line, 200-char-capped reason payload (§6 C-9). */
function toReason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const oneLine = msg.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine;
}

function tryParseEntryLine(line: Buffer): unknown {
  const text = line.toString("utf8");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined; // malformed line — skipped, same tolerance as pi's loadEntriesFromFile
  }
}

function isSessionHeader(entry: unknown): entry is ScannedSessionHeader {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as { type?: unknown; id?: unknown };
  return e.type === "session" && typeof e.id === "string" && e.id.length > 0;
}

/**
 * Scan the head of a session file inside the 8 KB window. Mirrors the header
 * discovery semantics of pi's `loadEntriesFromFile`: blank/malformed lines are
 * skipped, and the first *parseable* entry must be the session header — pi
 * itself rejects such a file when opening it (`loadEntriesFromFile` returns []
 * when entries[0] is not a session header), so a source we cannot scan could
 * never produce an openable fork either.
 *
 * Never throws; every failure folds into `{ ok: false, reason }` covering the
 * first two forkFrom failure classes (empty/unparsable source, no header).
 */
function scanSessionHead(file: string): { ok: true; scan: HeadScan } | { ok: false; reason: string } {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    fd = openSync(file, "r");
    const window = Buffer.alloc(Math.min(size, HEADER_SCAN_LIMIT_BYTES));
    let filled = 0;
    while (filled < window.length) {
      const n = readSync(fd, window, filled, window.length - filled, filled);
      if (n === 0) break;
      filled += n;
    }
    let lineStart = 0;
    for (;;) {
      const nl = window.indexOf(10, lineStart); // "\n"
      if (nl === -1) break;
      const entry = tryParseEntryLine(window.subarray(lineStart, nl));
      if (entry !== undefined) {
        if (!isSessionHeader(entry)) {
          const t = (entry as { type?: unknown }).type;
          return {
            ok: false,
            reason: `source session has no header: first parsed entry in ${file} is type ${JSON.stringify(t)}`,
          };
        }
        // Anything before the header (blank/malformed lines pi skips anyway)
        // is dropped: copy starts strictly after the header line.
        return { ok: true, scan: { header: entry, contentStart: nl + 1, fileSize: size } };
      }
      lineStart = nl + 1;
    }
    // No complete parseable line inside the window.
    const windowExhausted = size > HEADER_SCAN_LIMIT_BYTES;
    if (windowExhausted)
      return {
        ok: false,
        reason: `first line of ${file} exceeds the ${HEADER_SCAN_LIMIT_BYTES}-byte header scan limit`,
      };
    const rest = window.subarray(lineStart); // the file's final line, without a trailing newline
    const entry = tryParseEntryLine(rest);
    if (entry !== undefined) {
      if (!isSessionHeader(entry))
        return {
          ok: false,
          reason: `source session has no header: first parsed entry in ${file} is type ${JSON.stringify(
            (entry as { type?: unknown }).type,
          )}`,
        };
      return { ok: true, scan: { header: entry, contentStart: size, fileSize: size } };
    }
    return { ok: false, reason: `source session file is empty or invalid: ${file}` };
  } catch (e) {
    // Missing file, permission, you name it — same class forkFrom reports for
    // a source `loadEntriesFromFile` cannot read ("empty or invalid").
    return { ok: false, reason: `source session file is empty or invalid: ${file} (${toReason(e)})` };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing more we can do */
      }
    }
  }
}

/**
 * Two-level fork cwd resolution (§5.1, review-2 #12): the expert header's cwd
 * when that directory still exists (covers a *kept* worktree), else the asking
 * run's cwd. The v2 worktree-origin middle level is deliberately gone — the
 * worktree extension unconditionally forgets the mapping in beforeReap's
 * finally, together with deleting the worktree, so it always missed in
 * production. A consulted worktree expert therefore sees the asker's checkout;
 * that semantic is declared in the consult tool description (§5.1).
 */
function pickForkCwd(headerCwd: string | undefined, fallbackCwd: string): string {
  if (typeof headerCwd === "string" && headerCwd.length > 0 && existsSync(headerCwd)) return resolvePath(headerCwd);
  return resolvePath(fallbackCwd);
}

/** Two-level cwd resolution against a source file's header. Never throws. */
export function resolveForkCwd(sourceFile: string, fallbackCwd: string): string {
  const scanned = scanSessionHead(resolvePath(sourceFile));
  return pickForkCwd(scanned.ok ? scanned.scan.header.cwd : undefined, fallbackCwd);
}

/** Read the source header's cwd (bounded to the 8 KB window). `undefined` for any unreadable/headerless file. */
export function readHeaderCwd(file: string): string | undefined {
  const scanned = scanSessionHead(resolvePath(file));
  if (!scanned.ok) return undefined;
  return typeof scanned.scan.header.cwd === "string" ? scanned.scan.header.cwd : undefined;
}

/** Test seams on the fork path (same convention everywhere: production wiring sets none of them). */
export interface ForkExpertSessionOptions {
  /** Deterministic target id (wx-collision tests). */
  newId?: () => string;
  /**
   * Fires between the completed streaming copy and the return — exactly the
   * window in which a concurrent pi `_rewriteFile` would land on the MAIN
   * session's file. Test code mutates the SOURCE here to make the rewrite
   * race deterministic; `forkMainSessionSnapshot`'s post-copy stat then sees
   * the drift. Production never sets it.
   */
  onAfterCopy?: (source: string, target: string) => void;
}

/**
 * Stream-copy an expert's persisted session into a fresh, private fork file.
 *
 * Never throws (§15 #2 — frozen surface): all four failure classes of the old
 * `SessionManager.forkFrom` path (empty/unparsable source, no session header,
 * `wx` collision, mkdir/write failure) come back as `{ ok: false, reason }`,
 * so the consult tool can nack instead of throwing at a caller that did
 * nothing wrong.
 *
 * On-disk contract kept identical to forkFrom: new session id, header first
 * (writeFileSync with `flag:"wx"` — premise ② of the sweep safety argument),
 * `parentSession` = resolved source path, `cwd` = two-level resolution.
 * Divergence (intentional): no SessionManager instance is constructed, so the
 * fork file's bytes are written exactly once and read exactly once.
 */
export function forkExpertSession(
  sourceFile: string,
  fallbackCwd: string,
  dir: string = consultSessionDir(),
  opts: ForkExpertSessionOptions = {},
): ForkExpertSessionResult {
  let target: string | undefined;
  try {
    const sourcePath = resolvePath(sourceFile);
    const scanned = scanSessionHead(sourcePath);
    if (!scanned.ok) return { ok: false, reason: scanned.reason };
    const { header, contentStart, fileSize } = scanned.scan;
    const targetCwd = pickForkCwd(header.cwd, fallbackCwd);
    mkdirSync(dir, { recursive: true });
    const newSessionId = opts.newId ? opts.newId() : randomUUID();
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    target = join(dir, `${fileTimestamp}_${newSessionId}.jsonl`);
    const newHeader = {
      type: "session" as const,
      version: CURRENT_SESSION_VERSION,
      id: newSessionId,
      timestamp,
      cwd: targetCwd,
      parentSession: sourcePath,
    };
    // Header-first write with `wx` (never clobbers). This single call is the
    // whole creation window in which the file could exist without a complete
    // header — the same guarantee forkFrom's sweep argument relies on.
    writeFileSync(target, `${JSON.stringify(newHeader)}\n`, { flag: "wx" });
    try {
      copyTail(sourcePath, contentStart, fileSize, target);
      // Test seam (§16 rule 5 follow-up): see ForkExpertSessionOptions.onAfterCopy.
      opts.onAfterCopy?.(sourcePath, target);
    } catch (e) {
      // Half-written fork: unlike forkFrom, the path IS known here — remove it
      // immediately. If even that fails the file still has a valid header and
      // fresh mtime, so the TTL sweep is the backstop.
      try {
        unlinkSync(target);
      } catch {
        /* TTL sweep's job now */
      }
      return { ok: false, reason: toReason(e) };
    }
    return { ok: true, path: target };
  } catch (e) {
    // wx collision (EEXIST) or mkdir/write failure.
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST" && target !== undefined)
      return { ok: false, reason: `fork target already exists: ${target}` };
    return { ok: false, reason: toReason(e) };
  }
}

/**
 * consult (plan §16 rule 5): cap on the post-fork consistency re-read —
 * beyond this size we trust the copy rather than re-parse a whole session
 * file on every `consult("main", …)` call.
 */
const CONSISTENCY_CHECK_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Tail window the oversized path inspects (bytes). Beyond the per-line cap we
 * skip the full parse but still look at the last few KB: a two-generation
 * splice whose seam lands inside this window still fails, and anything
 * earlier is the stat-drift detector's job (forkMainSessionSnapshot), not
 * the parser's.
 */
const CONSISTENCY_TAIL_WINDOW_BYTES = 8 * 1024;

type ForkConsistencyCheck = { ok: true } | { ok: false; reason: string };

/** Test seams for `checkForkConsistency` (never set by production wiring). */
export interface ForkConsistencyOptions {
  /** Overrides `CONSISTENCY_CHECK_MAX_BYTES` so tests exercise the oversized path without writing 32 MB. */
  maxBytes?: number;
  /**
   * Bounded reader the oversized path uses for its header/tail windows
   * (default: fd + readSync). Injected in tests to assert the file is never
   * read whole.
   */
  readWindow?: (path: string, start: number, length: number) => Buffer;
}

/**
 * consult (plan §16 rule 5): a plain expert's session is terminal, so the
 * raw byte-range copy `forkExpertSession` performs above is always
 * internally consistent — nothing appends to (or rewrites) the source after
 * the expert settles. The HOST MAIN session is the opposite: pi may be
 * appending to it, or wholesale rewriting it (`_rewriteFile`, e.g. across a
 * `/compact`), at the exact moment a background subagent calls
 * `consult("main", …)`. This re-parses the freshly-written fork copy and
 * rejects it when any line OTHER than the last fails to parse as JSON — a
 * mid-file parse failure can only mean the copied byte range straddled two
 * different generations of the source file (a rewrite landed mid-copy); a
 * genuinely incomplete FINAL line is the ordinary "we caught it mid-append"
 * case pi's own loader already tolerates and is not treated as
 * inconsistency here either.
 */
/**
 * Exported as a test seam (same convention as `ForkExpertSessionOptions`) so
 * the detection logic can be pinned directly against hand-crafted fork files,
 * without needing to engineer a genuine concurrent rewrite race in a unit
 * test.
 *
 * Two regimes, split by the fork copy's size (acceptance follow-up to §16
 * rule 5 — the old "trust anything over 32 MB" branch read the whole file
 * into a string first and then skipped every check):
 *  - small (≤ `maxBytes`): re-read the whole copy; header must parse as a
 *    session header, every line but the last must parse as JSON;
 *  - oversized (> `maxBytes`): never read the file whole — validate the first
 *    line (8 KB window, same shape rules) and the last 8 KB tail window
 *    (every COMPLETE line there must parse; the window's leading fragment —
 *    cut mid-line by the window edge — and the trailing final line — possibly
 *    torn by a concurrent append — are both exempt). The stat-drift detector
 *    in `forkMainSessionSnapshot` still runs for oversized copies and is the
 *    primary rewrite guard there.
 */
export function checkForkConsistency(path: string, opts: ForkConsistencyOptions = {}): ForkConsistencyCheck {
  const maxBytes = opts.maxBytes ?? CONSISTENCY_CHECK_MAX_BYTES;
  let size: number;
  try {
    size = statSync(path).size;
  } catch (e) {
    return { ok: false, reason: `could not re-read the fork copy: ${toReason(e)}` };
  }
  if (size > maxBytes) return checkOversizedFork(path, size, opts);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, reason: `could not re-read the fork copy: ${toReason(e)}` };
  }
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // trailing newline
  if (lines.length === 0) return { ok: false, reason: "fork copy is empty" };
  let header: unknown;
  try {
    header = JSON.parse(lines[0]!);
  } catch {
    return { ok: false, reason: "fork copy's header line is not valid JSON" };
  }
  if (!isSessionHeader(header)) return { ok: false, reason: "fork copy's first line is not a session header" };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    try {
      JSON.parse(line);
    } catch {
      // Only the LAST line may legitimately be incomplete (a real
      // concurrent partial write); any earlier failure is mid-file
      // corruption from a rewrite that landed during the copy.
      if (i !== lines.length - 1)
        return { ok: false, reason: `fork copy line ${i + 1} is not valid JSON (source rewritten mid-fork)` };
    }
  }
  return { ok: true };
}

/** Default bounded reader for the oversized path's windows (fd + readSync, EOF-short). */
function readWindowDefault(path: string, start: number, length: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    let filled = 0;
    while (filled < buf.length) {
      const n = readSync(fd, buf, filled, buf.length - filled, start + filled);
      if (n === 0) break;
      filled += n;
    }
    return filled === buf.length ? buf : buf.subarray(0, filled);
  } finally {
    closeSync(fd);
  }
}

/** Oversized regime of `checkForkConsistency` — header line + tail window only, never the whole file. */
function checkOversizedFork(path: string, size: number, opts: ForkConsistencyOptions): ForkConsistencyCheck {
  const read = opts.readWindow ?? readWindowDefault;
  let head: Buffer;
  try {
    head = read(path, 0, Math.min(size, HEADER_SCAN_LIMIT_BYTES));
  } catch (e) {
    return { ok: false, reason: `could not re-read the fork copy: ${toReason(e)}` };
  }
  const nl = head.indexOf(10); // "\n"
  const firstLine = (nl === -1 ? head : head.subarray(0, nl)).toString("utf8");
  let header: unknown;
  try {
    header = JSON.parse(firstLine);
  } catch {
    return { ok: false, reason: "fork copy's header line is not valid JSON" };
  }
  if (!isSessionHeader(header)) return { ok: false, reason: "fork copy's first line is not a session header" };

  const tailLen = Math.min(size, CONSISTENCY_TAIL_WINDOW_BYTES);
  const tailStart = size - tailLen;
  let tail: Buffer;
  try {
    tail = read(path, tailStart, tailLen);
  } catch (e) {
    return { ok: false, reason: `could not re-read the fork copy: ${toReason(e)}` };
  }
  // The window may start mid-line: everything before its first newline is a
  // fragment of a line the small path would have parsed whole — skip it.
  let from: number;
  if (tailStart === 0) {
    from = 0; // window covers the file head — its first line IS the header line
  } else {
    const firstNl = tail.indexOf(10);
    if (firstNl === -1) return { ok: true }; // no complete line inside the window
    from = firstNl + 1;
  }
  for (;;) {
    const lineEnd = tail.indexOf(10, from);
    if (lineEnd === -1) break; // trailing final line — possibly torn by a concurrent append; exempt
    const line = tail.subarray(from, lineEnd);
    from = lineEnd + 1;
    if (line.toString("utf8").trim().length === 0) continue;
    try {
      JSON.parse(line.toString("utf8"));
    } catch {
      return {
        ok: false,
        reason: `fork copy tail window has a non-final line that is not valid JSON (source rewritten mid-fork)`,
      };
    }
  }
  return { ok: true };
}

/**
 * The source's stat signature `forkMainSessionSnapshot` compares across the
 * copy (acceptance follow-up to §16 rule 5). A line-level re-parse alone
 * cannot catch every mid-copy rewrite: pi's `_rewriteFile` truncates in place
 * (`openSync(path, "w")`) and rewrites whole lines, so a copy taken while a
 * rewrite is in flight can be "every line individually valid JSON" yet still
 * splice two generations (or capture a self-consistent truncated prefix) —
 * both pass the parser. Two stats around the copy catch what the parser
 * cannot: a rewrite always leaves size/mtimeMs/ino evidence behind.
 */
export interface SourceStatSignature {
  size: number;
  mtimeMs: number;
  /** POSIX only (0/absent elsewhere): a different inode means the path was replaced — never a pure append. */
  ino?: number;
}

/** Test seams for `forkMainSessionSnapshot` (never set by production wiring). */
export interface ForkMainSessionOptions extends ForkExpertSessionOptions {
  /** Replaces `statSync` of the source so drift fixtures are deterministic (mtime granularity is not). */
  statSource?: (path: string) => SourceStatSignature;
  /** Forwarded to `checkForkConsistency` as its size cap (oversized-path tests). */
  consistencyMaxBytes?: number;
  /** Forwarded to `checkForkConsistency` as its bounded reader (oversized-path tests). */
  readWindow?: (path: string, start: number, length: number) => Buffer;
}

function statSourceSignature(path: string): SourceStatSignature {
  const st = statSync(path);
  return { size: st.size, mtimeMs: st.mtimeMs, ...(st.ino > 0 ? { ino: st.ino } : {}) };
}

/**
 * Pure drift verdict: `undefined` means "untouched, or pure append" (the
 * snapshot is cut at copy time; growth past the copied prefix is simply not
 * part of it), any string is a single-line inconsistency reason.
 */
function sourceDriftReason(pre: SourceStatSignature, post: SourceStatSignature): string | undefined {
  if (pre.ino !== undefined && post.ino !== undefined && pre.ino !== post.ino)
    return `source rewritten mid-fork: file replaced (inode ${pre.ino} → ${post.ino})`;
  if (post.size < pre.size) return `source rewritten mid-fork: size shrank (${pre.size} → ${post.size} bytes)`;
  if (post.mtimeMs !== pre.mtimeMs && post.size <= pre.size)
    return `source rewritten mid-fork: non-appending write (mtime changed, size ${pre.size} unchanged)`;
  return undefined;
}

/**
 * consult (plan §16 rule 5): `forkExpertSession` + a post-copy consistency
 * check, with ONE immediate retry — no sleep. Everything in this module is
 * synchronous fs and this repo never blocks the event loop for a timer
 * (AGENTS.md zero-hang invariant); by the time the retry's own
 * read+scan+copy runs, a concurrent writer has almost certainly moved past
 * whatever mid-rewrite window caused the first failure. Used only for the
 * host main session — a plain expert fork never needs this (its source is
 * terminal) and keeps using `forkExpertSession` directly.
 *
 * The check is layered (acceptance follow-up): (1) a stat of the source
 * before and after the copy — shrink, non-appending mtime change, or an
 * inode swap is a rewrite no matter what the bytes look like; (2) the
 * line-level re-parse of `checkForkConsistency` (see there for the two
 * size regimes). Both funnel into the same delete → retry → nack path, and
 * neither sleeps or arms a timer.
 */
export function forkMainSessionSnapshot(
  sourceFile: string,
  fallbackCwd: string,
  dir: string = consultSessionDir(),
  opts: ForkMainSessionOptions = {},
): ForkExpertSessionResult {
  const sourcePath = resolvePath(sourceFile);
  const stat = (path: string): SourceStatSignature | undefined => {
    try {
      return opts.statSource ? opts.statSource(path) : statSourceSignature(path);
    } catch {
      return undefined; // unreadable source: the scan inside forkExpertSession reports it properly
    }
  };
  let lastReason = "fork_failed";
  for (let attempt = 0; attempt < 2; attempt++) {
    const pre = stat(sourcePath);
    const result = forkExpertSession(sourcePath, fallbackCwd, dir, opts);
    if (!result.ok) return result; // a hard failure is not a consistency issue — surface it as-is
    let inconsistent: string | undefined;
    if (pre !== undefined) {
      const post = stat(sourcePath);
      if (post !== undefined) inconsistent = sourceDriftReason(pre, post);
    }
    if (inconsistent === undefined) {
      const check = checkForkConsistency(result.path, {
        ...(opts.consistencyMaxBytes !== undefined ? { maxBytes: opts.consistencyMaxBytes } : {}),
        ...(opts.readWindow !== undefined ? { readWindow: opts.readWindow } : {}),
      });
      if (check.ok) return result;
      inconsistent = check.reason;
    }
    removeForkFile(result.path, dir);
    lastReason = inconsistent;
  }
  return { ok: false, reason: `fork_failed: inconsistent after retry (${lastReason})` };
}

/**
 * Stream the source's post-header tail onto the fork file (chunked; the
 * source is read exactly once). Raw byte copy: pre-header junk lines are
 * already excluded by `contentStart`, and a mid-file `type:"session"` entry
 * (which forkFrom would skip) cannot occur in a real pi session — if one ever
 * did, pi's own loader ignores every header but the first.
 */
function copyTail(sourcePath: string, contentStart: number, fileSize: number, target: string): void {
  if (contentStart >= fileSize) return;
  const readFd = openSync(sourcePath, "r");
  let writeFd: number | undefined;
  try {
    writeFd = openSync(target, "a"); // append after the header line
    const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let pos = contentStart;
    while (pos < fileSize) {
      const n = readSync(readFd, chunk, 0, chunk.length, pos);
      if (n <= 0) break; // source shrank concurrently — copy what we got
      writeSync(writeFd, chunk, 0, n);
      pos += n;
    }
  } finally {
    closeSync(readFd);
    if (writeFd !== undefined) closeSync(writeFd);
  }
}

export interface ForkSweepResult {
  /** Valid-header files removed because their mtime exceeded the TTL. */
  removedExpired: number;
  /** Files removed because their head has no valid session header, regardless of mtime (deletion-aftermath fragments). */
  removedFragments: number;
  /** Valid-header files inside the TTL window. */
  kept: number;
  /** Entries we could not stat/unlink (raced away, permissions); never thrown. */
  errors: number;
}

/**
 * Fork-directory GC. Runs once per `buildSessionStack` (session start /
 * reload) — no timer (R-12).
 *
 * Multi-process safety (§5.1, review-3 #9 — both premises are load-bearing,
 * do not break them):
 * ① TTL: consultDir is shared across pi processes, but any live consult run
 *    dies within its 150 s totalMs hard cap, so a fork file still in use is
 *    orders of magnitude younger than the 24 h TTL;
 * ② fragment rule ("no valid header ⇒ delete regardless of mtime"): a fork
 *    file being created always starts life with a complete header line,
 *    because the very first write is the header (header-first write order —
 *    `writeFileSync(target, header, {flag:"wx"})`), so a headerless file can
 *    only be deletion aftermath (a `_persist` appendFileSync landing after an
 *    unlink), never a fork in progress.
 * Shortening the TTL to minutes, or judging fragments by tail completeness,
 * breaks one of these premises.
 */
export function sweepForkDir(dir: string, ttlMs: number, now: number = Date.now()): ForkSweepResult {
  const result: ForkSweepResult = { removedExpired: 0, removedFragments: 0, kept: 0, errors: 0 };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return result; // missing/unreadable dir — nothing to sweep, not an error
  }
  for (const name of names) {
    const file = join(dir, name);
    try {
      const st = statSync(file);
      if (!st.isFile()) continue; // never touch subdirectories
      if (now - st.mtimeMs > ttlMs) {
        unlinkSync(file);
        result.removedExpired++;
        continue;
      }
      if (!scanSessionHead(file).ok) {
        unlinkSync(file);
        result.removedFragments++;
        continue;
      }
      result.kept++;
    } catch {
      result.errors++;
    }
  }
  return result;
}

/**
 * Delete a fork file, but only inside the consult session dir — the defense
 * line that keeps a forged `forkSessionFrom` (or a future bug) from turning
 * `onReaped` into an arbitrary-file deleter (§7 "forkSessionFrom 不可伪造").
 * ENOENT is silent (idempotent — the runner may call onReaped twice); this
 * function never throws.
 *
 * @returns whether the file was actually removed by this call.
 */
export function removeForkFile(path: string, dir: string = consultSessionDir()): boolean {
  try {
    const resolved = resolvePath(path);
    const root = resolvePath(dir);
    if (resolved !== root && !resolved.startsWith(root + sep)) return false; // outside consultDir — refuse
    unlinkSync(resolved);
    return true;
  } catch {
    return false; // ENOENT (idempotent) or anything else — cleanup never throws
  }
}
