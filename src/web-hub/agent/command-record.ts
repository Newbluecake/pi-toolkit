/**
 * web-hub-cmd-history plan §4.3/§4.4/§5.2 (docs/dev/web-hub-cmd-history/plan.md v2 — A1
 * agent-side package): the command recorder.
 *
 * One record per command execution, persisted as `subagent:cmd` custom entries via the injected
 * `appendEntry` dep (type `custom` — never rendered in the TUI, never injected into LLM context;
 * freeze F1 owns the wire shape). The recorder is a BYPASS OBSERVER: nothing it does may ever
 * affect the command itself — every write is guarded and every failure is swallowed and counted
 * (`appended`/`skipped`/`failed`, plan m4).
 *
 * Lifecycle differs from the capture engine's web windows on purpose (plan D5): records live up
 * to RECORD_MAX_MS (30 min), persist to the session file, and observe TUI invocations too —
 * which is why this is a separate module with its own deps, not another window kind.
 *
 * Write guards (§4.3, in order): ① `recheckForWrite?.(ctx)` — the injected secure LOCKED query
 * (M1: extension commands bypass the `input` event, so LOCKED does not stop them; the recorder
 * must not append onto an unmounted vault) ⇒ skip, counted, `appendEntry` NOT called; ② the live
 * `sessionId()` must still equal the begin-time session (a record whose session left mid-flight
 * stays unwritten); ③ `appendEntry` throwing (synchronous `appendFileSync` underneath) ⇒
 * swallowed, `failed++`. A skipped/failed record is silently dropped — the command already ran.
 *
 * Pi-free by construction: every capability is a dep (appendEntry/sessionId/now/setTimer/
 * recheckForWrite/onChange), so the unit tests need no pi. The only sibling import is
 * `sanitizeText` from command-capture.ts — a pure function, and command-capture's own import of
 * THIS module is type-only, so the runtime edge stays one-way.
 */
import { randomBytes } from "node:crypto";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CommandOutputEntry, CommandOutputWire } from "../protocol/messages.js";
import {
  CMD_RECORD_ARGS_MAX_CHARS,
  CMD_RECORD_ERROR_MAX_CHARS,
  CMD_RECORD_ENTRY_TYPE,
  CMD_RECORD_OUTPUT_MAX_ENTRIES,
  CMD_RECORD_OUTPUT_MAX_ENTRY_BYTES,
  CMD_RECORD_OUTPUT_MAX_KEY_CHARS,
  CMD_RECORD_OUTPUT_MAX_TITLE_CHARS,
  CMD_RECORD_OUTPUT_MAX_TOTAL_BYTES,
  type CmdRecordData,
  type CmdRecordNotice,
  type CmdRecordSource,
  type CmdRecordState,
} from "../protocol/cmd-record.js";
import { sanitizeText } from "../../commands/capture.js";

/** §4.3: lazy-start threshold — a handler settling within this window writes ONE end, no start. */
export const START_DELAY_MS = 400;
/** §4.3: hard record lifetime — at the deadline an end{timeout} is written and the record closes. */
export const RECORD_MAX_MS = 30 * 60_000;
/** §4.3: intent-ledger TTL / FIFO cap (D7 — survives arbitrarily long agent_settled deferrals). */
export const INTENT_TTL_MS = 10 * 60_000;
export const INTENT_MAX = 16;
/** §4.6: `StatusInfo.cmdRunning` bound (newest first). */
export const RUNNING_MAX = 16;

const ELLIPSIS = "…";
const ELLIPSIS_BYTES = Buffer.byteLength(ELLIPSIS, "utf8");

export interface CommandRecorderDeps {
  /** `pi.appendEntry` — synchronous fs write underneath, may throw. */
  appendEntry(customType: string, data: unknown): void;
  /** Live session id; a throwing getter ⇒ undefined (treated as "cannot write"). */
  sessionId(): string | undefined;
  now(): number;
  /** MUST unref its timer (zero-hang invariant; production wiring unrefs). */
  setTimer(ms: number, fn: () => void): { cancel(): void };
  /** The injected secure read-only query (§4.3/§5.4, freeze F6): a LOCKED reason ⇒ no write. */
  recheckForWrite?(ctx: ExtensionContext | undefined): string | undefined;
  /** Fired when the running-set membership changes (begin opens, settle/timeout closes). */
  onChange(): void;
}

export type RecordPolicy = "record" | "header-only" | "skip";

export interface RecordHandle {
  readonly cmdId: string;
  /** Bypass output collection; silently dropped once the record is closed (R10: releases buffer). */
  sink(entry: CommandOutputEntry): void;
  /** §4.4 leave interception: write end{done, left-session} NOW and close the record. */
  commitBeforeLeave(kind: "new" | "fork" | "switch" | "reload"): void;
  /** The leave was cancelled/threw: append a SECOND end{failed} under the same cmdId (last wins). */
  afterLeaveCancelled(error?: string): void;
  /** Handler settle — applies once; a no-op after commitBeforeLeave. */
  settle(outcome: { error?: unknown; failed?: string }): void;
}

export interface CommandRecorder {
  /** §5.2 policy table (freeze F5). */
  policyFor(
    name: string,
    args: string,
    kind: "extension" | "builtin" | "template" | "skill",
    owned: boolean,
  ): RecordPolicy;
  /** Only builtin-bridge calls this (B2: the prompt op never registers intents). */
  noteIntent(i: {
    cmdId: string;
    source: "web" | "feishu";
    sessionId: string;
    at: number;
    match: { name: string; args: string };
    display?: { name: string; args: string };
  }): void;
  /** wrapCommandApi's toolkit-handler entry point. skip policy / disabled ⇒ undefined. */
  begin(i: {
    name: string;
    args: string;
    ctx: ExtensionCommandContext;
    claimed?: { cmdId: string; source: "web" | "feishu" };
  }): RecordHandle | undefined;
  /** Bridge async builtins (/model lazy, /compact never-start). */
  beginExternal(i: {
    cmdId: string;
    name: string;
    args: string;
    source: "web";
    lazyStart: boolean;
  }): RecordHandle | undefined;
  /** Bridge synchronous one-shot records (third-party placeholder, session/name/thinking, new, resume). */
  recordImmediate(r: {
    cmdId: string;
    name: string;
    args: string;
    source: CmdRecordSource;
    startedAt: number;
    state: CmdRecordState;
    output?: CommandOutputWire;
    notice?: CmdRecordNotice;
    error?: string;
  }): boolean;
  /** Open cmdIds, newest first, ≤ RUNNING_MAX (§4.6 cmdRunning). */
  running(): string[];
  counters(): { appended: number; skipped: number; failed: number };
  dispose(): void;
}

// ---------------------------------------------------------------------------
// §5.2 policy table (freeze F5)
// ---------------------------------------------------------------------------

/** `/webhub` subcommands whose FULL output may be recorded; everything else is header-only (Q5). */
const WEBHUB_RECORDED_SUBS: ReadonlySet<string> = new Set(["status", "restart", "stop", "start"]);

function firstToken(args: string): string {
  return args.trim().split(/\s+/)[0] ?? "";
}

/**
 * §5.2. `skip` covers exactly the internal trampolines whose user action is recorded elsewhere;
 * `header-only` is the Q5 sensitive set (`/webhub` credentials + unknown subcommands, fail-closed);
 * everything else records. `owned`/`kind` are part of the frozen signature; today every
 * wrapCommandApi call site passes `("extension", true)` — template/skill never reach a handler.
 */
function policyFor(
  name: string,
  args: string,
  kind: "extension" | "builtin" | "template" | "skill",
  _owned: boolean,
): RecordPolicy {
  void _owned;
  if (kind === "template" || kind === "skill") return "skip";
  const first = firstToken(args);
  if (first.startsWith("__")) return "skip"; // /webhub __exec, /topic-switch __go, resume __list
  // #42: reload is never recorded — the whole `/agent reload` family (now|cancel|fire|bare) and
  // the builtin `/reload` leave no card, no session-history entry and no leave line.
  if (name === "reload" || (name === "agent" && first === "reload")) return "skip";
  if (name === "webhub") {
    return first === "" || WEBHUB_RECORDED_SUBS.has(first) ? "record" : "header-only";
  }
  return "record";
}

// ---------------------------------------------------------------------------
// output collection (budgets mirror the capture engine via the protocol's mirrored constants)
// ---------------------------------------------------------------------------

interface OutputBuffer {
  entries: CommandOutputEntry[];
  totalBytes: number;
  droppedEntries: number;
  droppedBytes: number;
  needsTerminal: boolean;
}

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

function clampEntryText(text: string): { text: string; clipped?: true } {
  const sanitized = sanitizeText(text);
  if (Buffer.byteLength(sanitized, "utf8") <= CMD_RECORD_OUTPUT_MAX_ENTRY_BYTES) return { text: sanitized };
  const truncated = utf8SafeTruncate(sanitized, CMD_RECORD_OUTPUT_MAX_ENTRY_BYTES - ELLIPSIS_BYTES);
  return { text: truncated + ELLIPSIS, clipped: true };
}

function pushEntry(buf: OutputBuffer, raw: CommandOutputEntry): void {
  const clamped = clampEntryText(raw.text);
  const key = raw.key !== undefined ? raw.key.slice(0, CMD_RECORD_OUTPUT_MAX_KEY_CHARS) : undefined;
  const title = raw.title !== undefined ? raw.title.slice(0, CMD_RECORD_OUTPUT_MAX_TITLE_CHARS) : undefined;
  const entry: CommandOutputEntry = {
    kind: raw.kind,
    text: clamped.text,
    ...(raw.level !== undefined ? { level: raw.level } : {}),
    ...(key !== undefined ? { key } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(clamped.clipped === true ? { clipped: true as const } : {}),
  };
  const entryBytes = Buffer.byteLength(entry.text, "utf8");
  if (
    buf.entries.length >= CMD_RECORD_OUTPUT_MAX_ENTRIES ||
    buf.totalBytes + entryBytes > CMD_RECORD_OUTPUT_MAX_TOTAL_BYTES
  ) {
    buf.droppedEntries += 1;
    buf.droppedBytes += entryBytes;
    return;
  }
  buf.entries.push(entry);
  buf.totalBytes += entryBytes;
}

function bufferToWire(buf: OutputBuffer): CommandOutputWire {
  const out: CommandOutputWire = { entries: buf.entries };
  if (buf.droppedEntries > 0 || buf.droppedBytes > 0) {
    out.truncated = { droppedEntries: buf.droppedEntries, droppedBytes: buf.droppedBytes };
  }
  if (buf.needsTerminal) out.needsTerminal = true;
  return out;
}

/** Cap args/error at the protocol's UTF-16 limits with a trailing "…" (§4.1). */
function capText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}${ELLIPSIS}` : s;
}

// ---------------------------------------------------------------------------
// records & intents
// ---------------------------------------------------------------------------

const LEAVE_LINE: Readonly<Record<"new" | "fork" | "switch", string>> = {
  new: "→ 已离开本会话（新建）",
  fork: "→ 已离开本会话（分叉）",
  switch: "→ 已离开本会话（切换）",
};

interface OpenRecord {
  cmdId: string;
  name: string;
  args: string;
  source: CmdRecordSource;
  startedAt: number;
  sessionId: string | undefined;
  ctx: ExtensionCommandContext | undefined;
  policy: "record" | "header-only";
  display?: { name: string; args: string };
  lazyStart: boolean;
  startWritten: boolean;
  ended: boolean;
  /** commitBeforeLeave ran: sinks/start are closed, but ONE corrective end is still allowed. */
  leftCommitted: boolean;
  /** The corrective afterLeaveCancelled end was written — the record is now fully terminal. */
  cancelWritten: boolean;
  buffer: OutputBuffer;
  startTimer: { cancel(): void } | undefined;
  maxTimer: { cancel(): void } | undefined;
}

interface Intent {
  cmdId: string;
  source: "web" | "feishu";
  sessionId: string;
  at: number;
  match: { name: string; args: string };
  display?: { name: string; args: string };
}

function localCmdId(): string {
  // "c" + 20 base64url chars ⇒ 21 chars, matches ^[A-Za-z0-9_-]{16,64}$
  return `c${randomBytes(15).toString("base64url")}`;
}

function sourceOfMode(mode: string | undefined): CmdRecordSource {
  if (mode === "tui") return "tui";
  if (mode === "rpc") return "rpc";
  return "other";
}

export function createCommandRecorder(deps: CommandRecorderDeps): CommandRecorder {
  const counters = { appended: 0, skipped: 0, failed: 0 };
  const open: OpenRecord[] = [];
  const order: string[] = []; // open-record cmdIds, oldest first (running() reverses)
  const intents: Intent[] = [];
  let disposed = false;

  const pruneIntents = (): void => {
    const now = deps.now();
    for (let i = intents.length - 1; i >= 0; i--) {
      if (now - intents[i]!.at > INTENT_TTL_MS) intents.splice(i, 1);
    }
    while (intents.length > INTENT_MAX) intents.shift();
  };

  const dropForeignIntents = (): void => {
    const sid = safe(deps.sessionId, undefined);
    if (sid === undefined) return;
    for (let i = intents.length - 1; i >= 0; i--) {
      if (intents[i]!.sessionId !== sid) intents.splice(i, 1);
    }
  };

  /** cmdId resolution (§4.3): claimed → intent ledger hit → local (source by ctx.mode). */
  const resolveInvocation = (
    name: string,
    args: string,
    ctx: ExtensionCommandContext,
    claimed: { cmdId: string; source: "web" | "feishu" } | undefined,
  ): { cmdId: string; source: CmdRecordSource; display?: { name: string; args: string } } => {
    pruneIntents();
    dropForeignIntents();
    if (claimed !== undefined) {
      const idx = intents.findIndex((i) => i.cmdId === claimed.cmdId);
      if (idx !== -1) {
        const hit = intents.splice(idx, 1)[0]!;
        return hit.display !== undefined
          ? { cmdId: claimed.cmdId, source: claimed.source, display: hit.display }
          : { cmdId: claimed.cmdId, source: claimed.source };
      }
      return { cmdId: claimed.cmdId, source: claimed.source };
    }
    const sid = safe(deps.sessionId, undefined);
    if (sid !== undefined) {
      // oldest-first, exact (name, args), same session — D7: matches deferred web dispatches
      // however long agent_settled held them (G7), and mirrors pi's ordered deferred actions.
      const idx = intents.findIndex((i) => i.sessionId === sid && i.match.name === name && i.match.args === args);
      if (idx !== -1) {
        const hit = intents.splice(idx, 1)[0]!;
        return hit.display !== undefined
          ? { cmdId: hit.cmdId, source: hit.source, display: hit.display }
          : { cmdId: hit.cmdId, source: hit.source };
      }
    }
    let mode: string | undefined;
    try {
      mode = ctx.mode;
    } catch {
      mode = undefined;
    }
    return { cmdId: localCmdId(), source: sourceOfMode(mode) };
  };

  const removeFromRunning = (rec: OpenRecord): void => {
    const idx = open.indexOf(rec);
    if (idx !== -1) open.splice(idx, 1);
    const oidx = order.indexOf(rec.cmdId);
    if (oidx !== -1) order.splice(oidx, 1);
  };

  const closeRecord = (rec: OpenRecord): void => {
    if (rec.startTimer !== undefined) rec.startTimer.cancel();
    if (rec.maxTimer !== undefined) rec.maxTimer.cancel();
    rec.startTimer = undefined;
    rec.maxTimer = undefined;
    rec.ended = true;
    rec.buffer.entries = []; // R10: release the buffer once nothing more can be written
    removeFromRunning(rec);
  };

  /** §4.3 write guards, in order. Returns true iff the entry landed. */
  const writeEntry = (rec: OpenRecord, data: CmdRecordData): boolean => {
    if (disposed) return false;
    let locked: string | undefined;
    try {
      locked = deps.recheckForWrite?.(rec.ctx as ExtensionContext | undefined);
    } catch {
      locked = undefined; // a throwing query must not take the command down — treat as writable
    }
    if (locked !== undefined) {
      counters.skipped += 1;
      return false;
    }
    const sid = safe(deps.sessionId, undefined);
    if (sid === undefined || sid !== rec.sessionId) {
      counters.skipped += 1;
      return false;
    }
    try {
      deps.appendEntry(CMD_RECORD_ENTRY_TYPE, data);
      counters.appended += 1;
      return true;
    } catch {
      counters.failed += 1;
      return false;
    }
  };

  const writeStart = (rec: OpenRecord): void => {
    if (rec.ended || rec.startWritten || !rec.lazyStart) return;
    rec.startWritten = true;
    writeEntry(rec, {
      v: 1,
      cmdId: rec.cmdId,
      phase: "start",
      name: rec.display?.name ?? rec.name,
      args: capText(rec.display?.args ?? rec.args, CMD_RECORD_ARGS_MAX_CHARS),
      source: rec.source,
      startedAt: rec.startedAt,
    });
  };

  const writeEnd = (
    rec: OpenRecord,
    o: { state: CmdRecordState; notice?: CmdRecordNotice; error?: string; leaveLine?: string },
  ): boolean => {
    const headerOnly = rec.policy === "header-only";
    const hasOutput =
      !headerOnly &&
      (rec.buffer.entries.length > 0 ||
        rec.buffer.droppedEntries > 0 ||
        rec.buffer.droppedBytes > 0 ||
        o.leaveLine !== undefined);
    let output: CommandOutputWire | undefined;
    if (hasOutput) {
      if (o.leaveLine !== undefined) {
        pushEntry(rec.buffer, { kind: "notify", level: "info", text: o.leaveLine });
      }
      output = bufferToWire(rec.buffer);
    }
    const error = o.error !== undefined ? capText(o.error, CMD_RECORD_ERROR_MAX_CHARS) : undefined;
    const written = writeEntry(rec, {
      v: 1,
      cmdId: rec.cmdId,
      phase: "end",
      name: rec.display?.name ?? rec.name,
      args: capText(rec.display?.args ?? rec.args, CMD_RECORD_ARGS_MAX_CHARS),
      source: rec.source,
      startedAt: rec.startedAt,
      endedAt: deps.now(),
      state: o.state,
      ...(output !== undefined ? { output } : {}),
      ...(o.notice !== undefined ? { notice: o.notice } : {}),
      ...(error !== undefined ? { error } : {}),
    });
    return written;
  };

  const makeHandle = (rec: OpenRecord): RecordHandle => {
    const ensureClosed = (): boolean => !disposed && !rec.ended;
    return {
      cmdId: rec.cmdId,
      sink(entry) {
        if (!ensureClosed()) return; // closed ⇒ silently dropped, buffer already released
        if (rec.policy === "header-only") return; // Q5: sensitive commands never collect output
        if (entry.kind === "interactive") rec.buffer.needsTerminal = true;
        pushEntry(rec.buffer, entry);
      },
      commitBeforeLeave(kind) {
        if (!ensureClosed()) return;
        writeEnd(rec, {
          state: "done",
          ...(rec.policy === "header-only"
            ? { notice: "sensitive" as const }
            : kind === "reload"
              ? {} // #42 defensive: unreachable in production (the reload family is skipped in policyFor ⇒ no handle); kept so a reload leave can never write a leave line
              : { notice: "left-session" as const, leaveLine: LEAVE_LINE[kind] }),
        });
        rec.leftCommitted = true;
        closeRecord(rec);
        deps.onChange();
      },
      afterLeaveCancelled(error) {
        if (disposed || rec.cancelWritten) return;
        // §4.4: called AFTER commitBeforeLeave — the leave did not happen (ctx still valid), so
        // a SECOND end under the same cmdId corrects the first (the UI folds on the LAST end).
        // A call without a prior commit is ignored: there is no wrong end to correct.
        if (!rec.leftCommitted) return;
        rec.cancelWritten = true;
        writeEnd(rec, {
          state: "failed",
          error: error ?? "会话离开操作被取消",
          ...(rec.policy === "header-only" ? { notice: "sensitive" as const } : {}),
        });
        deps.onChange();
      },
      settle(outcome) {
        if (!ensureClosed()) return;
        const failedText =
          outcome.failed !== undefined
            ? outcome.failed
            : outcome.error !== undefined
              ? outcome.error instanceof Error
                ? outcome.error.message
                : String(outcome.error)
              : undefined;
        const state: CmdRecordState = failedText !== undefined ? "failed" : "done";
        writeEnd(rec, {
          state,
          ...(rec.policy === "header-only"
            ? { notice: "sensitive" as const }
            : failedText === undefined && rec.buffer.entries.length === 0
              ? { notice: "no-output" as const }
              : {}),
          ...(failedText !== undefined ? { error: failedText } : {}),
        });
        closeRecord(rec);
        deps.onChange();
      },
    };
  };

  const openRecord = (
    resolved: { cmdId: string; source: CmdRecordSource; display?: { name: string; args: string } },
    name: string,
    args: string,
    ctx: ExtensionCommandContext | undefined,
    policy: "record" | "header-only",
    lazyStart: boolean,
  ): RecordHandle => {
    const rec: OpenRecord = {
      cmdId: resolved.cmdId,
      name,
      args,
      source: resolved.source,
      startedAt: deps.now(),
      sessionId: safe(deps.sessionId, undefined),
      ctx,
      policy,
      ...(resolved.display !== undefined ? { display: resolved.display } : {}),
      lazyStart,
      startWritten: false,
      ended: false,
      leftCommitted: false,
      cancelWritten: false,
      buffer: { entries: [], totalBytes: 0, droppedEntries: 0, droppedBytes: 0, needsTerminal: false },
      startTimer: undefined,
      maxTimer: undefined,
    };
    if (lazyStart) {
      rec.startTimer = deps.setTimer(START_DELAY_MS, () => {
        rec.startTimer = undefined;
        if (!rec.ended) writeStart(rec);
      });
    }
    rec.maxTimer = deps.setTimer(RECORD_MAX_MS, () => {
      rec.maxTimer = undefined;
      if (rec.ended) return;
      // §4.1: past the lifetime the record closes as timeout with whatever was collected
      writeEnd(rec, { state: "timeout", ...(rec.policy === "header-only" ? { notice: "sensitive" as const } : {}) });
      closeRecord(rec);
      deps.onChange();
    });
    open.push(rec);
    order.push(rec.cmdId);
    deps.onChange();
    return makeHandle(rec);
  };

  return {
    policyFor,
    noteIntent(i) {
      if (disposed) return;
      pruneIntents();
      dropForeignIntents();
      intents.push(i);
      pruneIntents();
    },
    begin(i) {
      if (disposed) return undefined;
      const policy = policyFor(i.name, i.args, "extension", true);
      const resolved = resolveInvocation(i.name, i.args, i.ctx, i.claimed);
      if (policy === "skip") return undefined; // cmdId/intent already consumed above (m1)
      return openRecord(resolved, i.name, i.args, i.ctx, policy, true);
    },
    beginExternal(i) {
      if (disposed) return undefined;
      return openRecord(
        { cmdId: i.cmdId, source: i.source },
        i.name,
        i.args,
        undefined,
        policyFor(i.name, i.args, "builtin", true) === "header-only" ? "header-only" : "record",
        i.lazyStart,
      );
    },
    recordImmediate(r) {
      if (disposed) return false;
      const headerOnly = policyFor(r.name, r.args, "builtin", true) === "header-only";
      // One-shot end: the session guard compares against the CURRENT session (no begin snapshot).
      const rec: OpenRecord = {
        cmdId: r.cmdId,
        name: r.name,
        args: r.args,
        source: r.source,
        startedAt: r.startedAt,
        sessionId: safe(deps.sessionId, undefined),
        ctx: undefined,
        policy: headerOnly ? "header-only" : "record",
        lazyStart: false,
        startWritten: true,
        ended: false,
        leftCommitted: false,
        cancelWritten: false,
        buffer: { entries: [], totalBytes: 0, droppedEntries: 0, droppedBytes: 0, needsTerminal: false },
        startTimer: undefined,
        maxTimer: undefined,
      };
      if (r.output !== undefined) {
        for (const e of r.output.entries) pushEntry(rec.buffer, e);
        if (r.output.truncated !== undefined) {
          rec.buffer.droppedEntries += r.output.truncated.droppedEntries;
          rec.buffer.droppedBytes += r.output.truncated.droppedBytes;
        }
        if (r.output.needsTerminal === true) rec.buffer.needsTerminal = true;
      }
      const written = writeEnd(rec, {
        state: r.state,
        ...(r.notice !== undefined ? { notice: r.notice } : {}),
        ...(r.error !== undefined ? { error: r.error } : {}),
      });
      return written;
    },
    running() {
      return order.slice(-RUNNING_MAX).reverse();
    },
    counters() {
      return { ...counters };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const rec of open) {
        if (rec.startTimer !== undefined) rec.startTimer.cancel();
        if (rec.maxTimer !== undefined) rec.maxTimer.cancel();
        rec.startTimer = undefined;
        rec.maxTimer = undefined;
        rec.ended = true;
        rec.buffer.entries = [];
      }
      open.length = 0;
      order.length = 0;
      intents.length = 0;
    },
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
