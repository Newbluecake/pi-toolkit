/**
 * web-resume plan §2.2 (P1, frozen API): the bounded session head/tail reader + the open
 * discipline every P1/P2 session-file open goes through.
 *
 * `readSessionHeadFd` reads at most `headBytes + tailBytes` of an ALREADY-OPEN fd and answers
 * everything the resume lists need from a session file without pi's `SessionManager.list`
 * whole-file parse: header identity (id/cwd/fork), the `subagent:child` self-marker, the last
 * `session_info.name`, and the first user message. Line-by-line on the `\n` BYTE (never a
 * decoded string offset) so a multi-byte UTF-8 character can never be corrupted at a window
 * boundary (`hub/spawn/history/head.ts` precedent).
 *
 * Open discipline (plan r2 B1): `SESSION_READ_FLAGS` = `O_RDONLY | O_NOFOLLOW | O_NONBLOCK |
 * O_NOCTTY` (each `?? 0`) — a file swapped for a FIFO with no writer or a device can never
 * block the open (or park a libuv thread), a tty is never adopted, a final-segment symlink is
 * rejected. `fstat` immediately; anything but a regular file is rejected; the fd/handle is
 * closed on every failure path. No `readFile(path)` / `createReadStream(path)` in this module
 * (source-scan test).
 *
 * Pi-free: `node:*` + the `RESTORE_SESSION_ID_RE` wire constant only.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { open as openAsync, type FileHandle } from "node:fs/promises";
import { RESTORE_SESSION_ID_RE } from "../web-hub/protocol/spawn.js";

const fsConstants = constants;

/** Plan §2.2: `O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY` (each `?? 0`), = hub/preview/fs.ts. */
export const SESSION_READ_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOCTTY ?? 0);

export interface HeadLimits {
  /** Head window bytes (default 64 KiB). */
  headBytes: number;
  /** Tail window bytes, read only when `size > headBytes` (default 16 KiB). */
  tailBytes: number;
  /** Maximum acceptable header line length in bytes (default 4 KiB). */
  headerLineBytes: number;
}

/** Plan §2.2 defaults: head 64 KiB / tail 16 KiB / header line 4 KiB. */
export const DEFAULT_HEAD_LIMITS: HeadLimits = {
  headBytes: 64 * 1024,
  tailBytes: 16 * 1024,
  headerLineBytes: 4 * 1024,
};

export interface SessionHead {
  id: string;
  cwd: string;
  /** Header carries `parentSession` (a fork — NOT a subagent signal). */
  forked: boolean;
  /** A `subagent:child` custom entry was seen in the head/tail window (v0.4.0+ self-marker). */
  child: boolean;
  /** Last `session_info.name` seen in the head or tail window. */
  name?: string;
  /** First `role:"user"` message text (loose-extracted when its line overflows the window). */
  firstMessage?: string;
}

export type HeadResult =
  { ok: true; head: SessionHead } | { ok: false; invalid: "no-header" | "bad-header" | "too-long-header" };

export interface FileFact {
  path: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

/**
 * Sync open under the open discipline: `SESSION_READ_FLAGS` → `fstat` → regular-or-reject.
 * Returns `undefined` on any failure (missing, symlink final segment, FIFO/device, race) with
 * the fd CLOSED on every path. The caller owns (and must close) the returned fd.
 */
export function openSessionNoFollow(path: string): { fd: number; fact: FileFact } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, SESSION_READ_FLAGS);
    const st = fstatSync(fd);
    if (!st.isFile()) {
      closeSync(fd);
      return undefined;
    }
    return { fd, fact: { path, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs } };
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    return undefined;
  }
}

/** Async twin of {@link openSessionNoFollow} (`fs/promises` handle; same contract). */
export async function openSessionNoFollowAsync(
  path: string,
): Promise<{ handle: FileHandle; fact: FileFact } | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await openAsync(path, SESSION_READ_FLAGS);
    const st = await handle.stat();
    if (!st.isFile()) {
      await handle.close();
      return undefined;
    }
    return { handle, fact: { path, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs } };
  } catch {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        /* already closed */
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

/**
 * Pinned equal to `src/runtime/session-driver.ts`'s `SUBAGENT_CHILD_CUSTOM_TYPE` by a
 * source-scan test (`tests/session-nav/source-pins.test.ts`) — no runtime import of
 * session-driver.ts (runtime-heavy; this module must stay pi-free).
 */
export const SUBAGENT_CHILD_MARKER_TYPE = "subagent:child";

const CUSTOM_TYPE_RE = /^\{"type":"custom","customType":"((?:[^"\\]|\\.)*)"/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function customTypeOf(line: string): string | undefined {
  return CUSTOM_TYPE_RE.exec(line)?.[1];
}

function extractUserText(content: unknown): string {
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (isPlainObject(block) && block["type"] === "text" && typeof block["text"] === "string") {
        parts.push(block["text"]);
      }
    }
    return parts.join(" ");
  }
  if (typeof content === "string") return content;
  return "";
}

/** Loose `"text":"…"` extraction from a window-truncated first-user line (head.ts precedent,
 * plus an unterminated-tail fallback so a value cut mid-string by the window still yields its
 * visible prefix — the plan's "a line larger than the remaining window" case). */
function looseExtractText(buf: string): string | undefined {
  const parts: string[] = [];
  const re = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m = re.exec(buf);
  while (m !== null) {
    const g = m[1];
    if (g !== undefined) parts.push(g);
    m = re.exec(buf);
  }
  if (parts.length > 0) return parts.join(" ");
  // Window cut mid-value: pull the unterminated `"text":"…` (then `"content":"…`) prefix.
  const tailText = /"text"\s*:\s*"((?:[^"\\]|\\.)*)$/.exec(buf);
  const tt = tailText?.[1];
  if (tt !== undefined) return unescapeFragment(tt);
  const cm = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(buf);
  const g = cm?.[1];
  if (g !== undefined) return unescapeFragment(g);
  const tailContent = /"content"\s*:\s*"((?:[^"\\]|\\.)*)$/.exec(buf);
  const tc = tailContent?.[1];
  return tc === undefined ? undefined : unescapeFragment(tc);
}

function unescapeFragment(s: string): string {
  try {
    const v: unknown = JSON.parse(`"${s}"`);
    return typeof v === "string" ? v : s;
  } catch {
    return s;
  }
}

interface HeadState {
  lineNo: number;
  headerOk: boolean;
  invalid: "no-header" | "bad-header" | "too-long-header" | undefined;
  id: string | undefined;
  cwd: string | undefined;
  forked: boolean;
  child: boolean;
  name: string | undefined;
  firstMessage: string | undefined;
}

function isUserMessageLinePrefix(line: string): boolean {
  return line.startsWith('{"type":"message"') && line.slice(0, 256).includes('"role":"user"');
}

/** Process one complete `\n`-terminated line. `tail` marks tail-window lines (name/child only). */
function processLine(state: HeadState, line: string, tail: boolean): void {
  if (state.lineNo === 0) {
    state.lineNo = 1;
    const parsed = parseJson(line);
    if (!isPlainObject(parsed) || parsed["type"] !== "session") {
      state.invalid = "bad-header";
      return;
    }
    const id = parsed["id"];
    const cwd = parsed["cwd"];
    const timestamp = parsed["timestamp"];
    if (
      typeof id !== "string" ||
      !RESTORE_SESSION_ID_RE.test(id) ||
      typeof cwd !== "string" ||
      !cwd.startsWith("/") ||
      typeof timestamp !== "string"
    ) {
      state.invalid = "bad-header";
      return;
    }
    state.id = id;
    state.cwd = cwd;
    state.forked = parsed["parentSession"] !== undefined;
    state.headerOk = true;
    return;
  }
  const ct = customTypeOf(line);
  if (ct !== undefined) {
    if (ct === SUBAGENT_CHILD_MARKER_TYPE) state.child = true;
    return;
  }
  if (line.startsWith('{"type":"session_info"')) {
    const parsed = parseJson(line);
    if (isPlainObject(parsed) && typeof parsed["name"] === "string") state.name = parsed["name"];
    return;
  }
  if (tail) return; // first user message always lives at the head; tail is name/child only
  if (isUserMessageLinePrefix(line)) {
    if (state.firstMessage !== undefined) return; // FIRST user message only
    const parsed = parseJson(line);
    if (!isPlainObject(parsed)) return;
    const message = parsed["message"];
    if (!isPlainObject(message) || message["role"] !== "user") return;
    state.firstMessage = extractUserText(message["content"]);
  }
}

/** Sync bounded read of `want` bytes at `position` into `buf` (loop; short only at EOF). */
function readFull(fd: number, buf: Buffer, want: number, position: number): number {
  let done = 0;
  while (done < want) {
    let n: number;
    try {
      n = readSync(fd, buf, done, want - done, position + done);
    } catch {
      return done;
    }
    if (n <= 0) break;
    done += n;
  }
  return done;
}

/**
 * Bounded head/tail reader over an already-open fd (never closes it). Reads at most
 * `headBytes` from offset 0 plus, when `size > headBytes`, `tailBytes` from the end.
 */
export function readSessionHeadFd(fd: number, size: number, limits?: HeadLimits): HeadResult {
  const lim: HeadLimits = limits ? { ...DEFAULT_HEAD_LIMITS, ...limits } : DEFAULT_HEAD_LIMITS;
  if (size <= 0) return { ok: false, invalid: "no-header" };
  const state: HeadState = {
    lineNo: 0,
    headerOk: false,
    invalid: undefined,
    id: undefined,
    cwd: undefined,
    forked: false,
    child: false,
    name: undefined,
    firstMessage: undefined,
  };

  // ── head window ───────────────────────────────────────────────────────────
  const headWant = Math.min(size, lim.headBytes);
  const headBuf = Buffer.alloc(headWant);
  const headLen = readFull(fd, headBuf, headWant, 0);
  if (headLen <= 0) return { ok: false, invalid: "no-header" };
  let head = headBuf.subarray(0, headLen);
  for (;;) {
    const nl = head.indexOf(0x0a);
    if (nl < 0) break;
    const line = head.subarray(0, nl);
    if (state.lineNo === 0 && line.length > lim.headerLineBytes) {
      return { ok: false, invalid: "too-long-header" };
    }
    processLine(state, line.toString("utf8"), false);
    if (state.invalid !== undefined) return { ok: false, invalid: state.invalid };
    head = head.subarray(nl + 1);
  }
  if (!state.headerOk) {
    // The header line never terminated inside the head window.
    if (head.length > lim.headerLineBytes || headLen === lim.headBytes) {
      return { ok: false, invalid: "too-long-header" };
    }
    return { ok: false, invalid: "no-header" };
  }
  // Trailing partial line of the head window: a first-user line larger than the remaining
  // window is loose-extracted (plan §2.2, head.ts precedent).
  if (state.firstMessage === undefined && head.length > 0) {
    const partial = head.toString("utf8");
    if (isUserMessageLinePrefix(partial)) state.firstMessage = looseExtractText(partial);
  }

  // ── tail window (name / child marker only; only when the file outgrew the head) ──
  if (size > headLen) {
    const tailWant = Math.min(lim.tailBytes, size - headLen);
    const tailStart = size - tailWant;
    const tailBuf = Buffer.alloc(tailWant);
    const tailLen = readFull(fd, tailBuf, tailWant, tailStart);
    if (tailLen > 0) {
      let tail = tailBuf.subarray(0, tailLen);
      // The tail window starts mid-line unless it starts at a line boundary we can prove —
      // only when the head window ended exactly on `\n` AND the windows are adjacent. Dropping
      // the leading partial line is always safe (its start is unknown).
      const firstNl = tail.indexOf(0x0a);
      if (firstNl >= 0) {
        tail = tail.subarray(firstNl + 1);
        for (;;) {
          const nl = tail.indexOf(0x0a);
          if (nl < 0) break;
          processLine(state, tail.subarray(0, nl).toString("utf8"), true);
          tail = tail.subarray(nl + 1);
        }
      }
    }
  }

  const headOut: SessionHead = {
    id: state.id ?? "",
    cwd: state.cwd ?? "",
    forked: state.forked,
    child: state.child,
  };
  if (state.name !== undefined) headOut.name = state.name;
  if (state.firstMessage !== undefined) headOut.firstMessage = state.firstMessage;
  return { ok: true, head: headOut };
}
