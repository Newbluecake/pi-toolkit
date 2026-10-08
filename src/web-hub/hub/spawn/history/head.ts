/**
 * web-hub session-history plan §4.5.1 (`head.ts`): the incremental session-header / kind /
 * title-source parser. Pure, byte-buffer driven (never string-concatenation across chunks —
 * splitting on the newline BYTE is always UTF-8-safe, so a multi-byte character can never be
 * corrupted at a chunk boundary) so callers can feed it 32 KiB blocks as they arrive from disk
 * without ever JSON.parse-ing a line this module doesn't need (an assistant/system "message"
 * line, however large, is skipped on its prefix alone — the plan's "120 KiB 的快照行不会被
 * JSON.parse" test anchor).
 *
 * Also hosts `checkSessionHeader` — the header-shape check pi's restore preflight
 * (`restore-plan.ts`'s `planSessionArgv`, PD7) and the fd-anchored resolver (`pin.ts`'s
 * `pinSession`) both need, extracted so the detail strings have exactly one source of truth
 * (byte-identical to the pre-extraction behaviour, pinned by the unmodified
 * `tests/web-hub/hub/spawn/restore-plan.test.ts`).
 */
import { RESTORE_SESSION_ID_RE } from "../../../protocol/spawn.js";
import { HISTORY_CHILD_MARKER_TYPE, type HistoryKind } from "../../../protocol/session-history.js";
import { HISTORY_HEADER_LINE_MAX } from "./budget.js";

// ---------------------------------------------------------------------------
// customType literals pinned against their real source-of-truth constants by
// `tests/web-hub/hub/spawn/history/head-pins.test.ts` (source import, not re-export — those
// modules live outside the `src/web-hub/{protocol,hub}` boundary this directory is held to).
// ---------------------------------------------------------------------------

/** == `src/prompt-sections/store.ts`'s `PROMPT_SECTIONS_ENTRY_TYPE`. */
export const PROMPT_SECTIONS_CUSTOM_TYPE = "subagent:prompt-sections";
/** == `src/hud/timing.ts`'s `SESSION_START_ENTRY_TYPE`. */
export const SESSION_START_CUSTOM_TYPE = "pi-hud-session-start";
/** == `src/web-hub/agent/origin-entry.ts`'s `WEB_ORIGIN_ENTRY_TYPE`. */
export const WEB_ORIGIN_CUSTOM_TYPE = "subagent:web-origin";
/** The in-line signal searched for inside a `subagent:prompt-sections` entry's raw line. */
const PI_SUBAGENT_TYPES_KEY = '"pi_subagent_types":';

export type HeaderError = "no-header" | "bad-header" | "too-long-header";

export interface HeadResult {
  /** Header line parsed and shape-valid (type/id/cwd/timestamp). */
  ok: boolean;
  error?: HeaderError;
  id?: string;
  cwd?: string;
  idValid?: boolean;
  forked?: true;
  kind: HistoryKind;
  /** Last `session_info.name` seen, if any. */
  name?: string;
  firstMessage?: string;
  /** A full first `role:"user"` message line was found (vs. a loose, truncated extraction). */
  complete: boolean;
}

export interface HeadParser {
  /** Feed the next raw byte chunk (any boundary — lines are found on the 0x0a byte, never on a
   * decoded string offset). Returns `"done"` once nothing further is useful to read. */
  push(chunk: Buffer): "more" | "done";
  /** Finalize after the caller stops reading (EOF, budget, or `push` already returned "done"). */
  finish(): HeadResult;
}

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

/** `{"type":"custom","customType":"<ct>"` prefix — cheap, no JSON.parse. */
const CUSTOM_TYPE_RE = /^\{"type":"custom","customType":"((?:[^"\\]|\\.)*)"/;
function customTypeOf(line: string): string | undefined {
  const m = CUSTOM_TYPE_RE.exec(line);
  return m?.[1];
}

function unescapeJsonFragment(s: string): string {
  try {
    const v: unknown = JSON.parse(`"${s}"`);
    return typeof v === "string" ? v : s;
  } catch {
    return s;
  }
}

/** Best-effort extraction from a line that never reached a terminating `\n` (window truncated
 * mid first-user-message, §4.5.1). Pulls every `"text":"..."` fragment (array content blocks),
 * falling back to a single `"content":"..."` (string content). */
function looseExtractText(buf: string): string | undefined {
  const parts: string[] = [];
  const re = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m = re.exec(buf);
  while (m !== null) {
    const g = m[1];
    if (g !== undefined) parts.push(unescapeJsonFragment(g));
    m = re.exec(buf);
  }
  if (parts.length > 0) return parts.join(" ");
  const cm = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(buf);
  const g = cm?.[1];
  return g === undefined ? undefined : unescapeJsonFragment(g);
}

export function createHeadParser(): HeadParser {
  let buf: Buffer = Buffer.alloc(0);
  let lineNo = 0;
  let headerOk = false;
  let headerError: HeaderError | undefined;
  let id: string | undefined;
  let cwd: string | undefined;
  let idValid: boolean | undefined;
  let forked: true | undefined;
  let name: string | undefined;
  let firstMessage: string | undefined;
  let complete = false;
  let sawSubMarker = false;
  let sawMain = false;
  let sawSubHeuristic = false;
  let done = false;

  function tryHeader(line: string): void {
    const parsed = parseJson(line);
    if (!isPlainObject(parsed)) {
      headerError = "bad-header";
      return;
    }
    if (parsed["type"] !== "session") {
      headerError = "bad-header";
      return;
    }
    const pid = parsed["id"];
    const pcwd = parsed["cwd"];
    const ptimestamp = parsed["timestamp"];
    if (typeof pid !== "string") {
      headerError = "bad-header";
      return;
    }
    if (typeof pcwd !== "string" || !pcwd.startsWith("/") || Buffer.byteLength(pcwd, "utf8") > 4096) {
      headerError = "bad-header";
      return;
    }
    if (typeof ptimestamp !== "string") {
      headerError = "bad-header";
      return;
    }
    id = pid;
    cwd = pcwd;
    idValid = RESTORE_SESSION_ID_RE.test(pid);
    if (parsed["parentSession"] !== undefined) forked = true;
    headerOk = true;
  }

  function processLine(line: string): void {
    if (lineNo === 0) {
      tryHeader(line);
      return;
    }
    const ct = customTypeOf(line);
    if (ct !== undefined) {
      if (ct === HISTORY_CHILD_MARKER_TYPE) sawSubMarker = true;
      else if (ct === PROMPT_SECTIONS_CUSTOM_TYPE) {
        if (line.includes(PI_SUBAGENT_TYPES_KEY)) sawMain = true;
        else sawSubHeuristic = true;
      } else if (ct === SESSION_START_CUSTOM_TYPE || ct === WEB_ORIGIN_CUSTOM_TYPE) sawMain = true;
      return;
    }
    if (line.startsWith('{"type":"session_info"')) {
      const parsed = parseJson(line);
      if (isPlainObject(parsed) && typeof parsed["name"] === "string") name = parsed["name"];
      return;
    }
    if (line.startsWith('{"type":"message"')) {
      if (!line.slice(0, 256).includes('"role":"user"')) return; // system/assistant — never parsed
      const parsed = parseJson(line);
      if (!isPlainObject(parsed)) return;
      const message = parsed["message"];
      if (!isPlainObject(message) || message["role"] !== "user") return;
      firstMessage = extractUserText(message["content"]);
      complete = true;
    }
  }

  function computeKind(): HistoryKind {
    if (sawSubMarker) return "sub";
    if (sawMain) return "main";
    if (sawSubHeuristic) return "sub";
    return "unknown";
  }

  return {
    push(chunk: Buffer): "more" | "done" {
      if (done) return "done";
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      for (;;) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) {
          if (lineNo === 0 && !headerOk && headerError === undefined && buf.length > HISTORY_HEADER_LINE_MAX) {
            headerError = "too-long-header";
            done = true;
            return "done";
          }
          return "more";
        }
        const lineBuf = buf.subarray(0, nl);
        buf = buf.subarray(nl + 1);
        processLine(lineBuf.toString("utf8"));
        lineNo += 1;
        if (complete) {
          done = true;
          return "done";
        }
      }
    },
    finish(): HeadResult {
      if (!headerOk && headerError === undefined) headerError = "no-header";
      if (!complete && firstMessage === undefined && buf.length > 0) {
        const partial = buf.toString("utf8");
        if (partial.startsWith('{"type":"message"') && partial.slice(0, 256).includes('"role":"user"')) {
          firstMessage = looseExtractText(partial);
        }
      }
      const result: HeadResult = {
        ok: headerOk,
        kind: computeKind(),
        complete,
      };
      if (headerError !== undefined) result.error = headerError;
      if (id !== undefined) result.id = id;
      if (cwd !== undefined) result.cwd = cwd;
      if (idValid !== undefined) result.idValid = idValid;
      if (forked !== undefined) result.forked = forked;
      if (name !== undefined) result.name = name;
      if (firstMessage !== undefined) result.firstMessage = firstMessage;
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// checkSessionHeader — shared by restore-plan.ts (planSessionArgv) and pin.ts (pinSession)
// ---------------------------------------------------------------------------

export interface CheckSessionHeaderExpect {
  id: string;
  cwd: string;
}
export type CheckSessionHeaderResult = { ok: true } | { ok: false; detail: string };

/** Byte-identical to the pre-extraction inline checks in `restore-plan.ts`'s `planSessionArgv`. */
export function checkSessionHeader(head: string, expect: CheckSessionHeaderExpect): CheckSessionHeaderResult {
  const nl = head.indexOf("\n");
  const firstLine = nl < 0 ? head : head.slice(0, nl);
  let header: unknown;
  try {
    header = JSON.parse(firstLine);
  } catch {
    return { ok: false, detail: "header is not JSON" };
  }
  if (!isPlainObject(header)) return { ok: false, detail: "header is not an object" };
  if (header["type"] !== "session") return { ok: false, detail: "header type mismatch" };
  if (header["id"] !== expect.id) return { ok: false, detail: "header id mismatch" };
  if (header["cwd"] !== expect.cwd) return { ok: false, detail: "header cwd mismatch" };
  return { ok: true };
}
