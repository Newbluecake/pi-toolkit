import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import type { XsDirectoryRow } from "../fabric/xs/directory.js";
import type { XsEffect } from "../web-hub/protocol/xs.js";

/**
 * fabric reply-plan §9 (package M): @mention addressing a cross-session — the syntax/parser
 * (§9.1), the routing port (§9.3), the notice texts (§9.6) and the completion insert-value rule
 * (§9.5). Priority is fixed: a subagent label always wins (parseMention runs first in
 * `mention.ts` and is untouched); this module only sees what it did not consume.
 *
 * Off path (§9.7): xs off ⇒ MW never injects the port; xs on but not joined, or after `leave`,
 * ⇒ `parse` returns `undefined` and completion yields no entries — every `@` input (including
 * `@session:`) then passes through to pi untouched and completion output is byte-identical.
 *
 * The real sender is RX4's fabric sender (assembled by MW); this package develops and tests
 * against the injected `send` port below. The directory data source is equally injected.
 */

// ----------------------------------------------------------------- syntax (§9.1)

/** §9.1 explicit form: `@session:<name|ref> message` — always intercepted, handed to hub resolve. */
const EXPLICIT_SESSION_MENTION_RE = /^@session:(\S+)[ \t]+(\S[\s\S]*)$/;

/** §9.1 ①: the bare form's name shape — path-looking names (`.`, `/`, `~`, `\`, spaces, …) never match. */
export const BARE_SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * §9.1 ③ (r2 #12): provable non-existence of a same-name file. ONE `lstatSync` with
 * `throwIfNoEntry:false`: ONLY an `undefined` (ENOENT) result counts as "no conflict"; a stat
 * result (the file/dir exists, DANGLING SYMLINKS included — lstat stats the link itself) or ANY
 * throw (EACCES/ENOTDIR/ELOOP/…) is a conflict ⇒ the input is released to pi. Never
 * `existsSync` — its boolean folds every error into `false`, which cannot fail closed.
 */
export function bareNameFileConflict(cwd: string, name: string): boolean {
  try {
    const stat = lstatSync(resolve(cwd, name), { throwIfNoEntry: false });
    return stat !== undefined;
  } catch {
    return true;
  }
}

/** What `parseSessionMention` needs — the same three static facts routing and completion share. */
export interface SessionMentionParseDeps {
  /** §9.1 ②: is `name` a registered subagent label? (Belt-and-braces — routing already tried
   *  parseMention first; the check keeps direct callers and completion honest.) */
  isLabel(name: string): boolean;
  /** §9.1 ③: the cwd anchoring the file-conflict check (live — read at parse time). */
  cwd(): string;
  /** §9.1 ④: the directory cache's unique exact name/ref lookup (already freshness-gated:
   *  stale/empty ⇒ `undefined` ⇒ the bare form passes through, RR8). */
  lookupExact(name: string): XsDirectoryRow | undefined;
}

export interface ParsedSessionMention {
  readonly form: "explicit" | "bare";
  /** The address handed to `send`: the explicit operand verbatim; the bare form's matched row REF
   *  (the cache already proved which session the name means — ref addressing avoids a name-rebind
   *  race between parse and send). */
  readonly target: string;
  readonly message: string;
  /** Display label: the explicit operand / the bare name as typed. */
  readonly label: string;
}

/**
 * §9.1: parse one `@session:`/bare `@name` mention. `undefined` ⇒ not a session mention —
 * release the input to pi untouched. The bare form must satisfy ALL of ①②③④; anything else
 * (path shape, subagent label, same-name file, 0/2+ cache hits) passes through.
 */
export function parseSessionMention(text: string, deps: SessionMentionParseDeps): ParsedSessionMention | undefined {
  const explicit = EXPLICIT_SESSION_MENTION_RE.exec(text);
  if (explicit) {
    const target = explicit[1] ?? "";
    const message = explicit[2] ?? "";
    return { form: "explicit", target, message, label: target };
  }
  const bare = /^@([^\s]+)[ \t]+(\S[\s\S]*)$/.exec(text);
  if (!bare) return undefined;
  const name = bare[1] ?? "";
  const message = bare[2] ?? "";
  if (!BARE_SESSION_NAME_RE.test(name)) return undefined; // ① path shapes excluded
  if (deps.isLabel(name)) return undefined; // ② a subagent label never addresses a session
  if (bareNameFileConflict(deps.cwd(), name)) return undefined; // ③ real files win
  const row = deps.lookupExact(name); // ④ unique exact name/ref hit, fresh cache
  if (row === undefined) return undefined;
  return { form: "bare", target: row.ref, message, label: name };
}

// ----------------------------------------------------------------- send port (§9.3)

/** The outcome statuses the notice texts (§9.6) and the reply_unsupported fallback distinguish. */
export type MentionSessionSendStatus =
  | "sent" // hub answered the send — effect/reason as answered
  | "no_target" // resolve found no member (XI5: unknown ≡ not joined)
  | "ambiguous" // resolve matched multiple members
  | "reply_unsupported" // §4.2 pre-send refusal (hub/target lacks xs.reply.v1) — provably nothing sent
  | "reply_quota" // §3.4/§6.4 issuance quota — provably nothing sent
  | "error"; // transport/unmapped — effect decides none vs unknown

/**
 * The slice of the fabric sender's `XsSendOutcome` (+ RX4's reply fields) that the mention
 * layer consumes. MW adapts; this package's tests fake it.
 */
export interface MentionSessionSendOutcome {
  status: MentionSessionSendStatus;
  effect: XsEffect;
  reason?: string;
  /** §4.2: present iff an expectReply request was registered for this send. */
  requestId?: string;
  /** Epoch-ms reply deadline (the "等待回复 ≤Nm" in the sent notice). */
  replyDueAt?: number;
  /** §6.4: replies accepted but not yet in the conversation (the reply_quota notice text). */
  pendingReplies?: number;
  /** The resolved target (display). */
  to?: { ref: string; name?: string };
}

export interface MentionSessionSendOptions {
  /**
   * §9.3: default `true` — `sender.message({to, text, wake:true, expectReply:{},
   * origin:"human", levelOverride:0})`. The reply_unsupported fallback retries ONCE with
   * `false` (a plain human wake — no reply association).
   */
  expectReply?: boolean;
}

/**
 * §9.3: the @session routing port. MW assembles the real one over the directory cache + fabric
 * sender; `parse` is SYNC and returns `undefined` unless joined AND the xs surface is connected
 * (both are LIVE facts, checked at call time — never decided at assembly time).
 */
export interface MentionSessionPort {
  parse(text: string): ParsedSessionMention | undefined;
  send(target: string, message: string, options?: MentionSessionSendOptions): Promise<MentionSessionSendOutcome>;
}

/** The pieces `createMentionSessionPort` assembles the port from (MW provides; tests fake). */
export interface MentionSessionPortDeps extends SessionMentionParseDeps {
  /** Live membership/connection view — `false` ⇒ `parse` returns `undefined` (§9.3/§9.7). */
  joined(): boolean;
  /** §9.3's send: wake:true + expectReply + origin "human" + levelOverride 0 (RX4/MW own the real one). */
  send(target: string, message: string, options?: MentionSessionSendOptions): Promise<MentionSessionSendOutcome>;
}

/** Build the port MW injects as `MentionRouteDeps.sessions`. A throwing dep never breaks input. */
export function createMentionSessionPort(deps: MentionSessionPortDeps): MentionSessionPort {
  return {
    parse(text) {
      try {
        if (!deps.joined()) return undefined;
        return parseSessionMention(text, {
          isLabel: deps.isLabel,
          cwd: () => deps.cwd(),
          lookupExact: deps.lookupExact,
        });
      } catch {
        return undefined;
      }
    },
    send: (target, message, options) => deps.send(target, message, options),
  };
}

/** `port.parse` guarded: an absent port or a throwing one is a pass-through (§9.3/§9.7). */
export function safeParseSessionMention(
  port: MentionSessionPort | undefined,
  text: string,
): ParsedSessionMention | undefined {
  if (port === undefined) return undefined;
  try {
    return port.parse(text);
  } catch {
    return undefined;
  }
}

// ----------------------------------------------------------------- notices (§9.6)

/** §9.4 (R4): human-origin results are DISPLAY-ONLY — these notices never wake the requester. */
export type SessionMentionNotice = { kind: "error"; message: string } | { kind: "sent"; message: string };

/** §9.6: errors reuse `subagent:mention-error` with `details.source` set to this value. */
export const SESSION_MENTION_ERROR_SOURCE = "mention-session";
/** §9.6: the success confirmation rides its own display-only custom type. */
export const SESSION_MENTION_SENT_CUSTOM_TYPE = "subagent:mention-session";

/**
 * §9.6 notice texts. English-free zone: these are prose blocks aimed at the user (the repo's
 * UI-text language split), mirroring the plan's table verbatim in meaning:
 *   no_target/ambiguous ⇒ 找不到会话 / 有多个匹配 · none{rejected} ⇒ 对方拒收 ·
 *   none{other} ⇒ 未送达（reason），可稍后重试 · reply_quota ⇒ 已有 N 条回复尚未进入对话 ·
 *   unknown ⇒ 可能已送达，不要重发 · success ⇒ → 已发给 …（q…，等待回复 ≤Nm）
 */
export function sessionMentionNotice(
  parsed: ParsedSessionMention,
  outcome: MentionSessionSendOutcome,
  opts: { plainFallback: boolean; now: number },
): SessionMentionNotice {
  switch (outcome.status) {
    case "no_target":
      return { kind: "error", message: `找不到会话 ${parsed.label}` };
    case "ambiguous":
      return { kind: "error", message: `有多个匹配 ${parsed.label} 的会话，请用 @session:<ref> 指定` };
    case "reply_quota":
      return { kind: "error", message: `已有 ${outcome.pendingReplies ?? "?"} 条回复尚未进入对话，请先查看后再发` };
    default:
      break;
  }
  const display = outcome.to?.name ?? outcome.to?.ref ?? parsed.label;
  if (outcome.effect === "none") {
    if (outcome.reason === "rejected") return { kind: "error", message: `对方拒收（${parsed.label}）` };
    return { kind: "error", message: `未送达（${outcome.reason ?? outcome.status}），可稍后重试` };
  }
  if (outcome.effect === "unknown") {
    return { kind: "error", message: `可能已送达（${parsed.label}），不要重发` };
  }
  if (opts.plainFallback) {
    return { kind: "sent", message: `→ 已发给 ${display}（对方不支持回复关联，已按普通消息发送）` };
  }
  if (outcome.requestId !== undefined) {
    const waitMs = outcome.replyDueAt !== undefined ? Math.max(1, outcome.replyDueAt - opts.now) : undefined;
    const wait = waitMs !== undefined ? `，等待回复 ≤${Math.ceil(waitMs / 60_000)}m` : "";
    return { kind: "sent", message: `→ 已发给 ${display}（${outcome.requestId}${wait}）` };
  }
  return { kind: "sent", message: `→ 已发给 ${display}` };
}

// ----------------------------------------------------------------- completion rule (§9.5)

/**
 * §9.5 insert-value rule: a session may be inserted as the bare `@name` iff §9.1's ①②③ static
 * conditions hold AND the name is unique in the cache (`lookupExact`) — anything conflicting
 * with a label, a real file, a path shape or a duplicate name inserts the explicit
 * `@session:<ref>` instead (always unambiguous). MW wires this as the source's
 * `sessionBareName`.
 */
export function sessionCompletionBare(deps: SessionMentionParseDeps, name: string): boolean {
  if (!BARE_SESSION_NAME_RE.test(name)) return false;
  if (deps.isLabel(name)) return false;
  if (bareNameFileConflict(deps.cwd(), name)) return false;
  return deps.lookupExact(name) !== undefined;
}

// ----------------------------------------------------------------- routing (§9.3)

/** The session branch of `MentionRouteResult` — an INDEPENDENT branch (never reuses runId). */
export type SessionMentionRouteResult =
  | { handled: false }
  | {
      handled: true;
      action: "session";
      target: string;
      requestId?: string;
      effect: XsEffect;
    };

export interface SessionMentionRouteDeps {
  sessions: MentionSessionPort | undefined;
  notifySession: ((notice: SessionMentionNotice) => void) | undefined;
  now?(): number;
}

/**
 * §9.3 routing: parse (sync, live join state) → send (wake + expectReply, human origin, level
 * 0). A `reply_unsupported` outcome — a §4.2 PRE-send refusal, nothing was sent — retries ONCE
 * without the reply association and tells the user. Every outcome maps to §9.6's notice texts;
 * the returned effect/requestId feed the web `MentionResultData` (`action:"session"` variant).
 * Never throws: a throwing send port degrades to a none-effect result plus an error notice.
 */
export async function routeSessionMention(
  text: string,
  deps: SessionMentionRouteDeps,
): Promise<SessionMentionRouteResult> {
  const parsed = safeParseSessionMention(deps.sessions, text);
  if (deps.sessions === undefined || parsed === undefined) return { handled: false };
  const now = (): number => {
    try {
      return deps.now?.() ?? Date.now();
    } catch {
      return Date.now();
    }
  };

  let outcome: MentionSessionSendOutcome;
  try {
    outcome = await deps.sessions.send(parsed.target, parsed.message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.notifySession?.({ kind: "error", message: `未送达（${message}），可稍后重试` });
    return { handled: true, action: "session", target: parsed.target, effect: "none" };
  }
  let plainFallback = false;
  if (outcome.status === "reply_unsupported" && outcome.effect === "none") {
    plainFallback = true;
    try {
      outcome = await deps.sessions.send(parsed.target, parsed.message, { expectReply: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.notifySession?.({ kind: "error", message: `未送达（${message}），可稍后重试` });
      return { handled: true, action: "session", target: parsed.target, effect: "none" };
    }
  }
  deps.notifySession?.(sessionMentionNotice(parsed, outcome, { plainFallback, now: now() }));
  return {
    handled: true,
    action: "session",
    target: parsed.target,
    ...(outcome.requestId !== undefined ? { requestId: outcome.requestId } : {}),
    effect: outcome.effect,
  };
}
