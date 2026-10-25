/**
 * web-resume plan §2.5 — the resume switch path: a SYNCHRONOUS decision in the bridge
 * (`resume __pick <json>`), a one-shot ticket bound to source session + target file identity,
 * and the `/webhub __exec resume <nonce>` re-entry that performs every authoritative check at
 * the execution point — synchronously, in the same tick as the `ctx.switchSession` call.
 *
 * Invariants (r1 #1/#2/#3):
 *  - a ticket is armed only after all sync checks pass; `armed → validating → switching` is a
 *    CAS chain, so a revoked/expired ticket can NEVER switch;
 *  - the exec claim is a single per-process slot SHARED with `/new` (`createExecGate`) — a
 *    concurrent pick, or a pick racing `/new`, is refused with `E_COMMAND_DENIED exec:in-flight`;
 *  - every late failure is `retryable:false` (no F9 same-id re-execution of a switch); a user
 *    retry is a new cmd id;
 *  - exactly one late result per armed ticket (the `finally` in `runSwitch` is the single exit);
 *  - a `session_shutdown` that is not our own switch revokes ARMED tickets only (our own switch
 *    is already `switching` by then).
 *
 * Disclosed residual windows (§2.5, path-only pi API): W1 — between the execution-point checks
 * and pi's `SessionManager.open` lie the async `session_before_switch` handlers; a swap there is
 * detected afterwards by the post-switch id + path + dev/ino recheck (`resume:mismatch`), except
 * a swap swapped BACK before the check, which is undetectable. W2 — another process holding the
 * target open while idle is not detectable; D5-a's size/mtime activity signals are the bounded
 * positive detection. `switchInFlight` closes the web half of the `session_before_switch` window
 * (web `prompt` ops are refused with `E_STALE_CTX` effect none while set).
 */
import { randomBytes } from "node:crypto";
import { closeSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CmdArgs, CmdErrorCode, CmdFrame, CmdResultBody } from "../protocol/messages.js";
import type { LedgerResult } from "./ledger.js";
import type { CommandRecorder } from "./command-record.js";
import type { FileFact, ProvenanceIndex, ResumeCorePort, ResumeListHandle } from "./resume-list.js";

// ---------------------------------------------------------------------------
// §2.5 step 3 — the single per-process exec claim, shared with `/new`
// ---------------------------------------------------------------------------

export interface ExecGate {
  /** `/new`'s arm: replaces an expired `/new` claim; `undefined` ⇔ the claim is held.
   *  web-hub-cmd-history §5.2 (A1): carries the web frame's cmdId so the execution point
   *  (`internalExec("new")` in agent/index.ts) can write the command card. */
  armNew(cmdId?: string): string | undefined;
  /** `/new`'s take: consumes the armed nonce (releasing the claim); unknown/expired ⇒
   *  `{ok:false}`; success ⇒ `{ok:true, cmdId}` (the threaded cmdId, possibly undefined). */
  consumeNew(nonce: string): { ok: true; cmdId: string | undefined } | { ok: false };
  /** resume pick: acquire for a ticket; `false` ⇔ held by `/new` or another ticket. */
  tryAcquireResume(): boolean;
  /** resume settle/revocation: release the claim iff still held by resume. */
  releaseResume(): void;
  held(): boolean;
}

/** `index.ts`'s former `pendingExec` slot (5 s one-shot TTL), generalized into the shared claim. */
export function createExecGate(opts: { now(): number }): ExecGate {
  const TTL_MS = 5_000;
  type Holder = { kind: "new"; nonce: string; expiresAt: number } | { kind: "resume" };
  let holder: Holder | undefined;
  /** web-hub-cmd-history A1: the cmdId riding the current /new nonce. */
  let newCmdId: string | undefined;
  const expireStaleNew = (): void => {
    if (holder !== undefined && holder.kind === "new" && opts.now() > holder.expiresAt) {
      holder = undefined; // lazy TTL expiry — a forgotten /new nonce never wedges the claim
    }
  };
  return {
    armNew(cmdId) {
      if (holder !== undefined) {
        expireStaleNew();
        if (holder !== undefined) return undefined;
      }
      const nonce = randomBytes(16).toString("hex");
      newCmdId = cmdId;
      holder = { kind: "new", nonce, expiresAt: opts.now() + TTL_MS };
      return nonce;
    },
    consumeNew(nonce) {
      const h = holder;
      if (h === undefined || h.kind !== "new" || h.nonce !== nonce) return { ok: false as const };
      holder = undefined;
      if (opts.now() > h.expiresAt) return { ok: false as const };
      const cmdId = newCmdId;
      newCmdId = undefined;
      return { ok: true as const, cmdId };
    },
    tryAcquireResume() {
      if (holder !== undefined) {
        expireStaleNew();
        if (holder !== undefined) return false;
      }
      holder = { kind: "resume" };
      return true;
    },
    releaseResume() {
      if (holder?.kind === "resume") holder = undefined;
    },
    held() {
      if (holder !== undefined) expireStaleNew();
      return holder !== undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// tickets
// ---------------------------------------------------------------------------

interface Rejection {
  code: CmdErrorCode;
  retryable: boolean;
  effect: "none" | "unknown";
  message: string;
}

interface ResumeTicket {
  nonce: string;
  frame: CmdFrame;
  source: { sessionId: string; file: string };
  target: { id: string; path: string; fact: FileFact; index: ProvenanceIndex };
  confirm: boolean;
  deadlineAt: number;
  state: "armed" | "validating" | "switching" | "rejected" | "done";
  rejected?: Rejection;
  /** §2.5 step 7: set once the bridge replied `completion:"async"` — later settlements go late. */
  replied: boolean;
  /** web-hub-cmd-history §5.2: when pick() ran — the card's startedAt. */
  armedAt: number;
  /** web-hub-cmd-history §5.2: at least one record entry landed for this ticket (drives the
   *  late `history` field — a check-failure ticket produced no card, so "none"). */
  recorded: boolean;
}

export interface ResumeExecDeps {
  /** web-hub-cmd-history plan §5.2 (A1): optional recorder port — the `/resume __pick` card is
   *  written at the execution point (after EVERY authoritative check, BEFORE switchSession —
   *  R12: writing earlier would change the very session the "source unchanged" check reads).
   *  Unset ⇒ zero recording, byte-identical behavior. */
  recorder?(): CommandRecorder | undefined;
  sendUserMessage(text: string, options: { deliverAs: "followUp"; expandPromptTemplates: boolean }): void;
  getSessionId(): string;
  getSessionFile(): string | undefined;
  now(): number;
  lists: ResumeListHandle;
  gate: ExecGate;
  core: ResumeCorePort;
  setTimer(ms: number, fn: () => void): { cancel(): void };
  sendLate(frame: CmdFrame, result: LedgerResult): void;
}

export interface ResumeExecHandle {
  /** §2.5 steps 1–7 — fully synchronous, no await. Never throws. */
  pick(frame: CmdFrame, cmd: CmdArgs & { op: "command" }, ctx: ExtensionContext): CmdResultBody;
  /** §2.5 a–d — the `__exec resume <nonce>` re-entry; async only from `ctx.switchSession` on.
   *  `true` ⇔ the nonce matched an ARMED ticket (a legit re-entry); `false` ⇔ a no-op. Never
   *  rejects. */
  internalExecResume(nonce: string, ctx: ExtensionCommandContext): Promise<boolean>;
  /** §2.5 session boundary: revoke ARMED tickets (late `E_SESSION_CHANGED` when already replied). */
  onSessionBoundary(): void;
  /** §2.5 step c: true while a switch is between its pre-checks and its post-switch verification. */
  switchInFlight(): boolean;
  /** Test/diagnostic surface. */
  ticketState(): "none" | "armed" | "validating" | "switching" | "rejected" | "done";
}

const PICK_DEADLINE_CAP_MS = 5_000;
/** §7 D5-a: a target written within the last 30 s (or changed since it was listed) needs an
 *  explicit second confirm. Activity signals, not occupancy proof. */
const D5_RECENT_WRITE_MS = 30_000;
/** Structural slice of pi's `ReplacedSessionContext` — the post-switch verification reads only
 *  the new session's id and file. */
interface ReplacementCtx {
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
}

function errResult(
  code: CmdErrorCode,
  retryable: boolean,
  effect: "none" | "unknown",
  message?: string,
): CmdResultBody {
  return message !== undefined
    ? { ok: false, code, retryable, effect, message }
    : { ok: false, code, retryable, effect };
}
function okAsync(): CmdResultBody {
  return { ok: true, data: { op: "command", kind: "builtin", completion: "async" } };
}
function opTotal(frame: CmdFrame): number {
  return Math.max(0, frame.deadlineMs - 300);
}

interface PickArgs {
  id: string;
  gen: string;
  confirm: boolean;
}

function parsePickArgs(
  cmd: CmdArgs & { op: "command" },
): { ok: true; args: PickArgs } | { ok: false; result: CmdResultBody } {
  const trimmed = cmd.args.trim();
  const head = trimmed.split(/\s+/)[0];
  if (head !== "__pick") return { ok: false, result: errResult("E_BAD_REQUEST", true, "none", "expected __pick") };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(head.length).trim() || "{}");
  } catch {
    return { ok: false, result: errResult("E_BAD_REQUEST", true, "none", "bad __pick json") };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, result: errResult("E_BAD_REQUEST", true, "none", "bad __pick json") };
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.length === 0 || o.id.length > 128) {
    return { ok: false, result: errResult("E_BAD_REQUEST", true, "none", "bad id") };
  }
  if (typeof o.gen !== "string" || !/^[0-9a-f]{16}$/.test(o.gen)) {
    return { ok: false, result: errResult("E_BAD_REQUEST", true, "none", "bad gen") };
  }
  return { ok: true, args: { id: o.id, gen: o.gen, confirm: o.confirm === true } };
}

export function createResumeExec(deps: ResumeExecDeps): ResumeExecHandle {
  const now = (): number => deps.now();
  let cur: ResumeTicket | undefined;
  let switching = false;

  const sendLateFor = (t: ResumeTicket, r: Rejection | { ok: true }): void => {
    const recorderOn = deps.recorder?.() !== undefined;
    const okData = { op: "command" as const, kind: "builtin" as const, completion: "sync" as const };
    if (recorderOn) (okData as { history?: "recorded" | "none" }).history = t.recorded ? "recorded" : "none";
    deps.sendLate(t.frame, "ok" in r ? { ok: true, data: okData } : { ok: false, ...r });
  };

  /** §2.5 b failure: record + release the claim; late ONLY when the bridge already replied —
   *  and every LATE failure is retryable:false (no F9 re-execution; a user retry is a new id). */
  const reject = (t: ResumeTicket, r: Rejection): void => {
    t.state = "rejected";
    t.rejected = r;
    if (cur === t) cur = undefined;
    deps.gate.releaseResume();
    if (t.replied) {
      sendLateFor(t, { ...r, retryable: false });
    }
  };

  function pick(frame: CmdFrame, cmd: CmdArgs & { op: "command" }, ctx: ExtensionContext): CmdResultBody {
    // step 2 — busy/pending ⇒ browse-only (D4). Never touches the claim or sendUserMessage.
    try {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        return errResult("E_COMMAND_DENIED", true, "none", "resume:busy");
      }
    } catch {
      return errResult("E_STALE_CTX", true, "none");
    }
    const parsed = parsePickArgs(cmd);
    if (!parsed.ok) return parsed.result;
    // step 3 — the exec claim (shared with /new, r1 #2).
    if (!deps.gate.tryAcquireResume()) return errResult("E_COMMAND_DENIED", false, "none", "exec:in-flight");
    // step 4 — gen index lookup.
    const target = deps.lists.lookup(parsed.args.gen, parsed.args.id);
    if (target === undefined) {
      deps.gate.releaseResume();
      return errResult("E_NOT_FOUND", false, "none", "resume:stale-list");
    }
    // step 5 — arm the ticket, bound to source AND target.
    const ticket: ResumeTicket = {
      nonce: randomBytes(16).toString("hex"),
      frame,
      source: {
        sessionId: safeGet(deps.getSessionId, "") ?? "",
        file: safeGet(deps.getSessionFile, undefined) ?? "",
      },
      target: { id: parsed.args.id, path: target.path, fact: target.fact, index: target.index },
      confirm: parsed.args.confirm,
      deadlineAt: now() + Math.min(opTotal(frame), PICK_DEADLINE_CAP_MS),
      state: "armed",
      replied: false,
      armedAt: now(),
      recorded: false,
    };
    cur = ticket;
    // step 6 — re-entry into the extension-command surface.
    try {
      deps.sendUserMessage(`/webhub __exec resume ${ticket.nonce}`, {
        deliverAs: "followUp",
        expandPromptTemplates: true,
      });
    } catch {
      cur = undefined;
      deps.gate.releaseResume();
      return errResult("E_STALE_CTX", true, "none");
    }
    // step 7 — inspect the ticket synchronously (F5: the handler's sync prefix already ran).
    if (ticket.state === "rejected") {
      const r = ticket.rejected!;
      return errResult(r.code, r.retryable, r.effect, r.message); // common failure path: plain sync reply
    }
    ticket.replied = true;
    if (ticket.state === "armed") {
      // settle-deferred re-entry: an unref'd revoke timer at the deadline. If it wins the CAS,
      // the ticket can never switch (r1 #1) and the failure goes out as one late result.
      deps.setTimer(Math.max(0, ticket.deadlineAt - now()), () => {
        if (cur !== ticket || ticket.state !== "armed") return;
        reject(ticket, { code: "E_DEADLINE", retryable: false, effect: "none", message: "resume:deadline" });
      });
    }
    return okAsync();
  }

  async function internalExecResume(nonce: string, ctx: ExtensionCommandContext): Promise<boolean> {
    // step a — CAS armed → validating; anything else is a no-op with the terminal warning the
    // `/webhub __exec` handler already emits for a refused exec.
    const ticket = cur;
    if (ticket === undefined || ticket.nonce !== nonce || ticket.state !== "armed") return false;
    ticket.state = "validating";
    // step b — every authoritative check, synchronous, in the same tick as the switch call.
    // `fail` returns `true` (the re-entry WAS legit — its outcome went out sync/late); a `false`
    // return stays reserved for "nonce did not match an armed ticket" (the terminal warning).
    const fail = (code: CmdErrorCode, message: string, retryable = false): true => {
      reject(ticket, { code, retryable, effect: "none", message });
      return true;
    };
    let fd: number | undefined;
    try {
      try {
        if (
          (safeGet(deps.getSessionId, "") ?? "") !== ticket.source.sessionId ||
          (safeGet(deps.getSessionFile, undefined) ?? "") !== ticket.source.file
        ) {
          return fail("E_SESSION_CHANGED", "resume:source-changed");
        }
        if (now() > ticket.deadlineAt) return fail("E_DEADLINE", "resume:deadline");
        try {
          if (!ctx.isIdle() || ctx.hasPendingMessages()) return fail("E_COMMAND_DENIED", "resume:busy", true);
        } catch {
          return fail("E_STALE_CTX", "resume:stale-ctx");
        }
        const opened = deps.core.openSessionNoFollow(ticket.target.path);
        if (opened === undefined) return fail("E_NOT_FOUND", "resume:file-gone");
        fd = opened.fd;
        if (opened.fact.dev !== ticket.target.fact.dev || opened.fact.ino !== ticket.target.fact.ino) {
          return fail("E_STALE_CTX", "resume:file-replaced");
        }
        const head = deps.core.readSessionHeadFd(opened.fd, opened.fact.size);
        if (!head.ok) return fail("E_STALE_CTX", "resume:bad-header");
        if (head.head.id !== ticket.target.id) return fail("E_STALE_CTX", "resume:target-changed");
        if (resolve(head.head.cwd) !== resolve(safeGet(() => ctx.cwd, "") ?? "")) {
          return fail("E_STALE_CTX", "resume:cwd-mismatch");
        }
        if (head.head.child) return fail("E_STALE_CTX", "resume:is-sub");
        if (ticket.target.index.has(ticket.target.path)) return fail("E_STALE_CTX", "resume:is-sub");
        const currentFile = safeGet(deps.getSessionFile, undefined) ?? "";
        if (
          resolve(ticket.target.path) === resolve(currentFile) ||
          ticket.target.id === (safeGet(deps.getSessionId, "") ?? "")
        ) {
          return fail("E_COMMAND_DENIED", "resume:current");
        }
        // §7 D5-a — bounded positive detection, skipped entirely on an explicit confirm.
        if (!ticket.confirm) {
          const changed =
            opened.fact.size !== ticket.target.fact.size || opened.fact.mtimeMs !== ticket.target.fact.mtimeMs;
          const recentWrite = now() - opened.fact.mtimeMs < D5_RECENT_WRITE_MS;
          if (changed || recentWrite) return fail("E_CONFIRM_REQUIRED", "resume:active-elsewhere");
        }
      } catch {
        // never-throw contract: an unexpected throw inside the check set is an honest refusal
        return fail("E_STALE_CTX", "resume:exec-error");
      } finally {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            /* already closed — never throw */
          }
        }
      }
    } catch {
      return true; // unreachable (the inner catch covers every path); keeps the promise un-rejecting
    }
    // web-hub-cmd-history §5.2 — THE execution point: every authoritative check has passed and
    // the session is still the one we armed against, so the card lands HERE (writing earlier
    // would have changed the file identity the checks above read — R12). `left-session` because
    // everything after this line happens in/for the OTHER session.
    try {
      ticket.recorded =
        deps.recorder?.()?.recordImmediate({
          cmdId: ticket.frame.id,
          name: "resume",
          args: "",
          source: "web",
          startedAt: ticket.armedAt,
          state: "done",
          notice: "left-session",
          output: {
            entries: [{ kind: "notify", level: "info", text: `已切换到会话 ${ticket.target.id.slice(0, 8)}` }],
          },
        }) ?? false;
    } catch {
      ticket.recorded = false; // bypass only — the switch must proceed regardless
    }
    // step c — switch. `switchInFlight` refuses web prompt ops for the whole window.
    ticket.state = "switching";
    switching = true;
    try {
      let verified = false;
      const rc = await ctx.switchSession(ticket.target.path, {
        withSession: async (replacementCtx: ReplacementCtx) => {
          try {
            const id = safeGet(() => replacementCtx.sessionManager.getSessionId(), "") ?? "";
            const file = safeGet(() => replacementCtx.sessionManager.getSessionFile(), undefined);
            if (id !== ticket.target.id || file === undefined || resolve(file) !== resolve(ticket.target.path)) {
              return;
            }
            const reopened = deps.core.openSessionNoFollow(file);
            if (reopened === undefined) return;
            try {
              verified = reopened.fact.dev === ticket.target.fact.dev && reopened.fact.ino === ticket.target.fact.ino;
            } finally {
              try {
                closeSync(reopened.fd);
              } catch {
                /* never throw */
              }
            }
          } catch {
            /* verified stays false — the outer check reports resume:mismatch */
          }
        },
      });
      // step d — exactly one late result (the finally below is the single send point).
      if ((rc as { cancelled?: boolean } | undefined)?.cancelled === true) {
        ticket.rejected = { code: "E_COMMAND_DENIED", retryable: false, effect: "none", message: "resume:cancelled" };
        // web-hub-cmd-history §5.2: the switch did NOT happen — correct the left-session end
        // with a second end{failed} under the same cmdId (session still ours, so the write
        // passes the recorder's session guard; a skipped write is silently accepted).
        try {
          deps.recorder?.()?.recordImmediate({
            cmdId: ticket.frame.id,
            name: "resume",
            args: "",
            source: "web",
            startedAt: ticket.armedAt,
            state: "failed",
            error: "resume:cancelled",
          });
        } catch {
          /* bypass only */
        }
      } else if (!verified) {
        ticket.rejected = {
          code: "E_STALE_CTX",
          retryable: false,
          effect: "unknown", // the switch already happened — reported, not undone (r2 #3)
          message: "resume:mismatch",
        };
      }
    } catch {
      ticket.rejected = { code: "E_STALE_CTX", retryable: false, effect: "unknown", message: "resume:switch-failed" };
      // web-hub-cmd-history §5.2: the switch THREW — the session is (very likely) still ours,
      // so correct the left-session end exactly like the cancelled case.
      try {
        deps.recorder?.()?.recordImmediate({
          cmdId: ticket.frame.id,
          name: "resume",
          args: "",
          source: "web",
          startedAt: ticket.armedAt,
          state: "failed",
          error: "resume:switch-failed",
        });
      } catch {
        /* bypass only */
      }
    } finally {
      ticket.state = "done";
      if (cur === ticket) cur = undefined;
      deps.gate.releaseResume();
      switching = false;
      if (ticket.rejected !== undefined) {
        sendLateFor(ticket, ticket.rejected);
      } else {
        sendLateFor(ticket, { ok: true });
      }
    }
    return true;
  }

  return {
    pick,
    internalExecResume,
    onSessionBoundary() {
      const t = cur;
      if (t === undefined || t.state !== "armed") return;
      reject(t, { code: "E_SESSION_CHANGED", retryable: false, effect: "none", message: "resume:session-changed" });
    },
    switchInFlight: () => switching,
    ticketState: () => cur?.state ?? "none",
  };
}

function safeGet<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
