/**
 * web-hub 命令历史 plan §4.1/§4.5 (docs/dev/web-hub-cmd-history/plan.md v2 — P0 协议冻结包).
 *
 * The persisted `subagent:cmd` entry: one record per command execution (start/end phases),
 * written only via `pi.appendEntry` (type `custom`, never rendered in the TUI, never injected
 * into LLM context) and projected by `protocol/keys.ts` as a display:false custom tombstone
 * that additionally carries the sanitized `cmd` record (§4.5) — old UIs see neither.
 *
 * Everything in this module is frozen surface (F1/F3): the hub (reading the jsonl), the agent
 * (getBranch fallback) and — hand-mirrored, per the command-args/run-transcript precedent — the
 * browser UI all code against these shapes. Pure TypeScript + `node:buffer` only (same posture
 * as `keys.ts`); the only messages.ts dependency is TYPE-only (no runtime import cycle).
 *
 * sanitizeCmdRecord re-validates untrusted jsonl input (§4.5): structure + size only, content
 * is NEVER modified or redacted (Q1 原文落盘 ruling — the write side sanitizes ANSI/control
 * characters; the read side deliberately does not re-sanitize). Any structural failure ⇒ the
 * whole record degrades to a bare tombstone (no `cmd` field). Unknown fields are dropped.
 */
import { Buffer } from "node:buffer";
import type { CommandOutputEntry, CommandOutputWire } from "./messages.js";

/** customType of the persisted command-history entry (plan §4.1, freeze F1). */
export const CMD_RECORD_ENTRY_TYPE = "subagent:cmd";

/** Record schema version. `v !== 1` ⇒ the projection is a pure tombstone. */
export const CMD_RECORD_VERSION = 1;

/** Where the command came from. `feishu` is reserved (unreachable today, kept for §4.1). */
export type CmdRecordSource = "web" | "feishu" | "tui" | "rpc" | "other";
/** Terminal state of an ended record. Crashed/never-ended records carry no state at all (§4.1). */
export type CmdRecordState = "done" | "failed" | "timeout";
/** Non-output annotations of an ended record (§4.1). */
export type CmdRecordNotice =
  | "terminal-only" // third-party extension command: dispatched, output stays in the terminal (Q4)
  | "sensitive" // /webhub sensitive subcommand: header only, no output persisted (Q5)
  | "no-output" // finished normally with nothing recordable
  | "left-session"; // the command left this session (new/fork/switch/reload) mid-flight

/**
 * The persisted record body (plan §4.1). `end` entries are self-contained (they repeat
 * name/args/source/startedAt) so a fast command writes a single `end` with no `start`.
 * `v:1` is literal-pinned so future revisions must fork the type, not widen it.
 */
export interface CmdRecordData {
  v: 1;
  /** `^[A-Za-z0-9_-]{16,64}$` — web frames reuse the frame id; local ids are "c" + 20 base64url. */
  cmdId: string;
  phase: "start" | "end";
  /** Card command name (same pattern as CommandArgsSchema.name). */
  name: string;
  /** Raw args text, ≤ CMD_RECORD_ARGS_MAX_CHARS (write side truncates with a trailing "…"). */
  args: string;
  source: CmdRecordSource;
  /** Epoch ms the handler actually started executing (G7: recorded at execution time). */
  startedAt: number;
  // --- end-only fields (writer discipline; the reader tolerates them anywhere) ---
  endedAt?: number;
  state?: CmdRecordState;
  /** Verbatim output (Q1), re-budgeted on read (§4.5); absent on header-only records. */
  output?: CommandOutputWire;
  notice?: CmdRecordNotice;
  /** Failure reason text, ≤ CMD_RECORD_ERROR_MAX_CHARS. */
  error?: string;
}

/** Sanitized wire projection of a record (§4.5). Structurally identical to `CmdRecordData`. */
export type CmdRecordWire = CmdRecordData;

/** cmdId pattern — same shape as the recall target / frame ids (`^[A-Za-z0-9_-]{16,64}$`). */
export const CMD_RECORD_CMD_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** Command-name pattern — same as CommandArgsSchema.name (`^[A-Za-z0-9:_.-]{1,64}$`). */
export const CMD_RECORD_NAME_RE = /^[A-Za-z0-9:_.-]{1,64}$/;

/** args / error length caps (UTF-16 code units, matching the write side's slice-truncate). */
export const CMD_RECORD_ARGS_MAX_CHARS = 512;
export const CMD_RECORD_ERROR_MAX_CHARS = 512;

// --- output re-budget (§4.5: same numbers as the capture engine, mirrored here because
// protocol must not import commands/capture.ts; the UI hand-mirrors them in turn) ---

/** Single output entry text cap, UTF-8 bytes (clip + "…" + `clipped:true` beyond). */
export const CMD_RECORD_OUTPUT_MAX_ENTRY_BYTES = 8 * 1024;
/** Whole-output text budget, UTF-8 bytes (keep the front, drop the rest, tally `truncated`). */
export const CMD_RECORD_OUTPUT_MAX_TOTAL_BYTES = 32 * 1024;
/** Max output entries kept (front first). */
export const CMD_RECORD_OUTPUT_MAX_ENTRIES = 64;
/** `title` / `key` caps (UTF-16 code units, sliced like the capture engine). */
export const CMD_RECORD_OUTPUT_MAX_TITLE_CHARS = 200;
export const CMD_RECORD_OUTPUT_MAX_KEY_CHARS = 64;

/** `StatusInfo.cmdRunning` bound (§4.6): ≤16 cmdIds, newest first, absent while empty. */
export const CMD_HISTORY_RUNNING_MAX = 16;

const SOURCES: ReadonlySet<string> = new Set(["web", "feishu", "tui", "rpc", "other"]);
const STATES: ReadonlySet<string> = new Set(["done", "failed", "timeout"]);
const NOTICES: ReadonlySet<string> = new Set(["terminal-only", "sensitive", "no-output", "left-session"]);
const ENTRY_KINDS: ReadonlySet<string> = new Set(["notify", "widget", "status", "text", "error", "interactive"]);
const LEVELS: ReadonlySet<string> = new Set(["info", "warning", "error"]);

const ELLIPSIS = "…";
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, "utf8");

/**
 * Deterministic pure re-validation of an untrusted record (§4.5). Returns the bounded wire
 * record, or undefined for any structural/size violation (⇒ the caller projects a pure
 * tombstone). Unknown top-level fields are dropped. Content is never rewritten — the only
 * modifications are the output size budgets (entry clipping / front-kept dropping), mirroring
 * the capture engine's write-side semantics exactly.
 */
export function sanitizeCmdRecord(data: unknown): CmdRecordWire | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const r = data as Record<string, unknown>;
  if (r.v !== CMD_RECORD_VERSION) return undefined;
  if (typeof r.cmdId !== "string" || !CMD_RECORD_CMD_ID_RE.test(r.cmdId)) return undefined;
  if (typeof r.name !== "string" || !CMD_RECORD_NAME_RE.test(r.name)) return undefined;
  if (r.phase !== "start" && r.phase !== "end") return undefined;
  if (typeof r.source !== "string" || !SOURCES.has(r.source)) return undefined;
  if (typeof r.args !== "string" || r.args.length > CMD_RECORD_ARGS_MAX_CHARS) return undefined;
  if (typeof r.startedAt !== "number" || !Number.isFinite(r.startedAt) || r.startedAt < 0) return undefined;

  const out: CmdRecordWire = {
    v: CMD_RECORD_VERSION,
    cmdId: r.cmdId,
    phase: r.phase,
    name: r.name,
    args: r.args,
    source: r.source as CmdRecordSource,
    startedAt: r.startedAt,
  };

  if (r.endedAt !== undefined) {
    if (typeof r.endedAt !== "number" || !Number.isFinite(r.endedAt) || r.endedAt < 0) return undefined;
    out.endedAt = r.endedAt;
  }
  if (r.state !== undefined) {
    if (typeof r.state !== "string" || !STATES.has(r.state)) return undefined;
    out.state = r.state as CmdRecordState;
  }
  if (r.notice !== undefined) {
    if (typeof r.notice !== "string" || !NOTICES.has(r.notice)) return undefined;
    out.notice = r.notice as CmdRecordNotice;
  }
  if (r.error !== undefined) {
    if (typeof r.error !== "string" || r.error.length > CMD_RECORD_ERROR_MAX_CHARS) return undefined;
    out.error = r.error;
  }
  if (r.output !== undefined) {
    const output = sanitizeOutput(r.output);
    if (output === undefined) return undefined;
    out.output = output;
  }
  return out;
}

/**
 * Re-apply the output budgets to a raw CommandOutputWire-shaped value: kind/level whitelist,
 * text ≤ 8 KiB (clip + "…" + `clipped:true`), key/title sliced, ≤ 64 entries / ≤ 32 KiB total
 * (front kept, the rest dropped and tallied into `truncated`, merged with any pre-existing
 * counters — they only ever accumulate). Invalid entries (bad kind/level/text) are dropped and
 * counted; anything that is not the right SHAPE at all ⇒ undefined (whole record tombstones).
 */
function sanitizeOutput(raw: unknown): CommandOutputWire | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.entries)) return undefined;

  const entries: CommandOutputEntry[] = [];
  let totalBytes = 0;
  let droppedEntries = 0;
  let droppedBytes = 0;

  for (const item of r.entries) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      droppedEntries += 1;
      continue;
    }
    const e = item as Record<string, unknown>;
    if (typeof e.kind !== "string" || !ENTRY_KINDS.has(e.kind) || typeof e.text !== "string") {
      droppedEntries += 1;
      continue;
    }
    if (e.level !== undefined && (typeof e.level !== "string" || !LEVELS.has(e.level))) {
      droppedEntries += 1;
      continue;
    }
    const clamped = clampText(e.text);
    const entry: CommandOutputEntry = {
      kind: e.kind as CommandOutputEntry["kind"],
      text: clamped.text,
      ...(e.level !== undefined ? { level: e.level as "info" | "warning" | "error" } : {}),
      ...(typeof e.key === "string" ? { key: e.key.slice(0, CMD_RECORD_OUTPUT_MAX_KEY_CHARS) } : {}),
      ...(typeof e.title === "string" ? { title: e.title.slice(0, CMD_RECORD_OUTPUT_MAX_TITLE_CHARS) } : {}),
      ...(clamped.clipped === true || e.clipped === true ? { clipped: true as const } : {}),
    };
    const entryBytes = Buffer.byteLength(entry.text, "utf8");
    if (
      entries.length >= CMD_RECORD_OUTPUT_MAX_ENTRIES ||
      totalBytes + entryBytes > CMD_RECORD_OUTPUT_MAX_TOTAL_BYTES
    ) {
      droppedEntries += 1;
      droppedBytes += entryBytes;
      continue;
    }
    entries.push(entry);
    totalBytes += entryBytes;
  }

  if (r.truncated !== undefined) {
    if (r.truncated === null || typeof r.truncated !== "object" || Array.isArray(r.truncated)) return undefined;
    const t = r.truncated as Record<string, unknown>;
    if (
      typeof t.droppedEntries !== "number" ||
      !Number.isFinite(t.droppedEntries) ||
      t.droppedEntries < 0 ||
      typeof t.droppedBytes !== "number" ||
      !Number.isFinite(t.droppedBytes) ||
      t.droppedBytes < 0
    ) {
      return undefined;
    }
    droppedEntries += t.droppedEntries;
    droppedBytes += t.droppedBytes;
  }

  const truncated = droppedEntries > 0 || droppedBytes > 0 ? { droppedEntries, droppedBytes } : undefined;
  return {
    entries,
    ...(truncated !== undefined ? { truncated } : {}),
    ...(r.needsTerminal === true ? { needsTerminal: true as const } : {}),
  };
}

/** Byte-budget clip WITHOUT re-sanitizing (read side keeps content verbatim, §4.5). */
function clampText(text: string): { text: string; clipped?: true } {
  if (Buffer.byteLength(text, "utf8") <= CMD_RECORD_OUTPUT_MAX_ENTRY_BYTES) return { text };
  const truncated = utf8SafeTruncate(text, CMD_RECORD_OUTPUT_MAX_ENTRY_BYTES - ELLIPSIS_BYTES);
  return { text: truncated + ELLIPSIS, clipped: true };
}

/** Truncate to ≤ maxBytes UTF-8 bytes without splitting a code point (capture-engine parity). */
function utf8SafeTruncate(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return s;
  for (let end = maxBytes; end >= 0 && end > maxBytes - 4; end--) {
    const candidate = buf.toString("utf8", 0, end);
    if (Buffer.byteLength(candidate, "utf8") === end) return candidate;
  }
  return buf.toString("utf8", 0, Math.max(0, maxBytes - 4));
}
