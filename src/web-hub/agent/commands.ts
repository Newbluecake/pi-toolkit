/**
 * agent-side command dispatcher (plan §4.1–§4.6, D1/D5–D8/D13/D15–D18/D21/D26).
 *
 * `handle()` is the zero-hang entry point required by `connection.ts`'s
 * `BindingPort.onCmd`: synchronous, never throws, never awaits network I/O.
 * `steer_subagent`/`abort_subagent` do go through a `Promise` (the underlying
 * `QueryControlPort` calls are inherently async and, per D15, may never
 * settle) but `handle()` itself returns immediately either way — the promise
 * chain only ever calls back into `deps.send`.
 *
 * Per-op responsibility split against the rest of package C1:
 *  - `prompt`/`abort` are fully implemented here (ledger + queue-mirror +
 *    compaction-state + origin-entry, all owned by this same package);
 *  - `steer_subagent`/`abort_subagent` call the injected `QueryControlPort`
 *    (owned by the top-level `src/index.ts` wiring, outside this package);
 *  - `command` delegates whole-hog to the injected `BuiltinBridge.execute()`
 *    (§4.6's classify/policy/execute pipeline is package C11's scope —
 *    `slash.ts`/`command-policy.ts`/`builtin-bridge.ts` — still C0 stubs at
 *    this point, so `command` degrades to `E_UNSUPPORTED` until C11 lands,
 *    exactly per plan §12.1's C11 revert row);
 *  - `dialog_answer`/`dialog_cancel` never reach this module at all — the
 *    caller (`index.ts`) routes them straight to the dialog bridge (C2).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BuiltinBridge } from "./builtin-bridge.js";
import type { CommandLedger, LedgerResult } from "./ledger.js";
import type { QueueMirror } from "./queue-mirror.js";
import type { CompactionState } from "./compaction-state.js";
import type { OriginEntryPort } from "./origin-entry.js";
import type { QueryControlPort, StopResult } from "./index.js";
import type { CmdData, CmdErrorCode, CmdFrame, CmdLateFrame, CmdOp, CmdResultFrame } from "../protocol/messages.js";

export interface Timer {
  cancel(): void;
}

export interface CommandHandlerDeps {
  pi: ExtensionAPI;
  getCtx(): ExtensionContext | undefined;
  getSessionId(): string;
  ledger: CommandLedger;
  queueMirror: QueueMirror;
  compactionState: CompactionState;
  originEntry: OriginEntryPort;
  builtinBridge: BuiltinBridge;
  query?: () => QueryControlPort | undefined;
  controlEnabled(): boolean;
  now(): number;
  send(frame: CmdResultFrame | CmdLateFrame): void;
  /** Called after any ledger/queue mutation so the caller can republish the `status`/`ctl` slots. */
  onChanged(): void;
  setTimer(ms: number, fn: () => void): Timer;
}

export interface InputEventLike {
  text: string;
  source: "interactive" | "rpc" | "extension";
  streamingBehavior?: "steer" | "followUp";
}
export interface MessageStartLike {
  message: { role: string; content?: string | Array<{ type: string; text?: string }> };
}

export interface CommandHandler {
  handle(frame: CmdFrame): void;
  /** §4.3 step 2 + §4.4 row 1. */
  onInputEvent(ev: InputEventLike): void;
  /** §4.3 step 3 (idle path) + §4.4 row 2. */
  onMessageStart(ev: MessageStartLike): void;
  /** §4.4 row 3: the 1 Hz `hasPendingMessages()` sample. */
  onPendingSample(hasPending: boolean): void;
  /**
   * todo #32 finding 4 (D15): release any per-run steer busy lock whose run has reached a
   * terminal status, sampled independently of any new request for that run — the lock used to
   * only get released as a side effect of `handleSteer` handling a *new* request for the exact
   * same runId (and by then the "still running?" precheck right above it had already returned
   * `E_NOT_RUNNING`, so it never actually ran). Call this on every status sample (index.ts's 1Hz
   * tick) so a run that finished while its steer hung forever doesn't wedge that runId's lock.
   */
  releaseSettledSteerLocks(): void;
  /** §4.6/D22: the builtin bridge's async completions (`/compact`, `/model`) land after
   * `handleCommand`'s immediate settle — route them through the same late path as a late steer
   * result (ledger upgrade `{late:true}` + `cmd_late` frame), never a bare `conn.send`. */
  handleBridgeLate(frame: CmdFrame, result: LedgerResult): void;
  /** §4.4 row 4: session_start/session_shutdown boundary. */
  onSessionBoundary(): void;
  dispose(): void;
}

const STEER_LATE_CAP = 8;
const PROMPT_HTTP_WAIT_MS = 3_000;
const PROMPT_UNOBSERVED_FINALIZE_MS = 30_000;
const PROMPT_IDLE_STARTED_MS = 10_000;
const PROMPT_QUEUED_TIMEOUT_MS = 10 * 60_000;
const PROMPT_MAX_BYTES = 48 * 1024;
const STEER_TEXT_MAX_BYTES = 16 * 1024;

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function errResult(code: CmdErrorCode, retryable: boolean, effect: "none" | "unknown", message?: string): LedgerResult {
  return message !== undefined
    ? { ok: false, code, retryable, effect, message }
    : { ok: false, code, retryable, effect };
}
function okResult(data: CmdData, dup?: true): LedgerResult {
  return dup === true ? { ok: true, dup: true, data } : { ok: true, data };
}

function toResultFrame(frame: CmdFrame, result: LedgerResult): CmdResultFrame {
  return { t: "cmd_result", rid: frame.rid, id: frame.id, ...result };
}
function toLateFrame(frame: CmdFrame, result: LedgerResult, at: number): CmdLateFrame {
  return { t: "cmd_late", id: frame.id, op: frame.cmd.op, at, ...result };
}

/** First text block of a `role:"user"` message (§4.3 step 3's exact-match anchor). */
function firstUserText(msg: MessageStartLike["message"]): string | undefined {
  if (msg.role !== "user") return undefined;
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return undefined;
  const first = msg.content.find((c) => c.type === "text");
  return first?.text;
}

function opTotal(frame: CmdFrame): number {
  return Math.max(0, frame.deadlineMs - 300);
}

export function createCommandHandler(deps: CommandHandlerDeps): CommandHandler {
  /** cmdId -> the still-open HTTP-reply wait for a dispatched-but-unobserved prompt (§4.3 step 2). */
  const pendingObservation = new Map<string, { frame: CmdFrame; deliver: "steer" | "followUp"; timer: Timer }>();
  /** cmdId -> exact text an idle prompt is waiting to see in the next `message_start` (§4.3 step 3). */
  const idleWatch = new Map<string, string>();
  /** runId -> cmdId of the in-flight (or late/hung) web steer holding that run's D15 slot. */
  const pendingSteerByRun = new Map<string, string>();
  /** Shared D15 bound: web steer/stop calls whose underlying promise timed out but is still pending. */
  let lateCount = 0;

  function settleAndReply(frame: CmdFrame, result: LedgerResult): void {
    deps.ledger.settle(frame.id, result, deps.now());
    deps.onChanged();
    deps.send(toResultFrame(frame, result));
  }
  function replyOnly(frame: CmdFrame, result: LedgerResult): void {
    deps.send(toResultFrame(frame, result));
  }
  function settleLate(frame: CmdFrame, result: LedgerResult): void {
    const at = deps.now();
    deps.ledger.settle(frame.id, result, at, { late: true });
    deps.onChanged();
    deps.send(toLateFrame(frame, result, at));
  }

  /** §4.5 rule 1 / §4.2 "公共前置": ledger get-or-create, replying (and returning `proceed:false`)
   * for the dup/running/digest-mismatch outcomes so every op handler shares one code path. */
  function beginOrReply(frame: CmdFrame, extra?: { text?: string; runId?: string }): boolean {
    const outcome = deps.ledger.begin(frame.id, frame.cmd.op, frame.cmd, deps.now(), {
      ...extra,
      sessionId: deps.getSessionId(),
    });
    switch (outcome.kind) {
      case "new":
        return true;
      case "dup": {
        const result = outcome.result.ok ? { ...outcome.result, dup: true as const } : outcome.result;
        deps.send(toResultFrame(frame, result));
        deps.onChanged();
        return false;
      }
      case "running":
        deps.send(toResultFrame(frame, errResult("E_DEADLINE", true, "unknown")));
        return false;
      case "digest_mismatch":
        deps.send(toResultFrame(frame, errResult("E_BAD_REQUEST", false, "none", "id reused")));
        return false;
      case "capacity":
        // todo #32 finding 4 / plan §4.5 rule 3: 16 concurrent `running` ledger entries per agent;
        // no entry was created, no side effect happened — retryable once something else settles.
        deps.send(toResultFrame(frame, errResult("E_RATE", true, "none", "too many in-flight commands")));
        return false;
    }
  }

  function handleQueryOnly(frame: CmdFrame): void {
    const snap = deps.ledger.query(frame.id);
    if (snap === undefined) {
      deps.send(toResultFrame(frame, errResult("E_UNKNOWN_ID", false, "none")));
      return;
    }
    const data: CmdData = { op: "query", state: snap.state };
    if (snap.late === true) (data as { late?: true }).late = true;
    if (snap.result !== undefined) (data as { result?: unknown }).result = snap.result;
    deps.send(toResultFrame(frame, okResult(data)));
  }

  function handlePrompt(frame: CmdFrame): void {
    if (frame.cmd.op !== "prompt") return;
    const cmd = frame.cmd;
    if (!beginOrReply(frame, { text: cmd.text })) return;
    const ctx = deps.getCtx();
    if (ctx === undefined) return settleAndReply(frame, errResult("E_STALE_CTX", true, "none"));
    if (cmd.expect?.sessionId !== undefined && cmd.expect.sessionId !== deps.getSessionId()) {
      return settleAndReply(frame, errResult("E_SESSION_CHANGED", false, "none"));
    }
    if (cmd.text.trim() === "" || byteLen(cmd.text) > PROMPT_MAX_BYTES) {
      return settleAndReply(frame, errResult("E_BAD_REQUEST", true, "none"));
    }
    if (deps.compactionState.manualCompacting) {
      return settleAndReply(frame, errResult("E_BUSY_COMPACTING", true, "none"));
    }
    deps.ledger.updatePrompt(frame.id, { promptState: "dispatched" }, deps.now());
    deps.originEntry.appendOrigin("prompt", frame.id, frame.origin, cmd.deliver);
    // todo #32 finding 3: the pending-observation entry MUST exist before `sendUserMessage` is
    // called — on the real path `sendUserMessage` can synchronously fire the `input` event (same
    // tick, same call stack) that observes this very prompt. Registering the entry afterwards means
    // `onInputEvent` finds no `pendingObservation` record to settle, so the HTTP reply falls through
    // to the 3s timeout and wrongly reports `unobserved` even though it *was* observed.
    const pending = registerObservation(frame, cmd.deliver);
    try {
      deps.pi.sendUserMessage(cmd.text, { deliverAs: cmd.deliver, expandPromptTemplates: false });
    } catch {
      if (pendingObservation.delete(frame.id)) pending.timer.cancel();
      return settleAndReply(frame, errResult("E_STALE_CTX", true, "none"));
    }
  }

  function registerObservation(
    frame: CmdFrame,
    deliver: "steer" | "followUp",
  ): { frame: CmdFrame; deliver: "steer" | "followUp"; timer: Timer } {
    const timer = deps.setTimer(PROMPT_HTTP_WAIT_MS, () => {
      if (pendingObservation.delete(frame.id)) {
        settleAndReply(frame, okResult({ op: "prompt", delivery: "unobserved" }));
      }
    });
    const entry = { frame, deliver, timer };
    pendingObservation.set(frame.id, entry);
    deps.setTimer(PROMPT_UNOBSERVED_FINALIZE_MS, () => {
      const e = deps.ledger.get(frame.id);
      if (e !== undefined && e.promptState === "dispatched") {
        deps.ledger.updatePrompt(frame.id, { promptState: "unconfirmed", reason: "unobserved" }, deps.now());
        deps.onChanged();
      }
    });
    return entry;
  }

  function scheduleIdleStartedTimeout(cmdId: string, text: string): void {
    idleWatch.set(cmdId, text);
    deps.setTimer(PROMPT_IDLE_STARTED_MS, () => {
      if (idleWatch.get(cmdId) !== text) return;
      idleWatch.delete(cmdId);
      const e = deps.ledger.get(cmdId);
      if (e !== undefined && e.promptState === "observed") {
        deps.ledger.updatePrompt(cmdId, { promptState: "unconfirmed", reason: "not-started" }, deps.now());
        deps.onChanged();
      }
    });
  }

  function scheduleQueuedTimeout(cmdId: string): void {
    deps.setTimer(PROMPT_QUEUED_TIMEOUT_MS, () => {
      const e = deps.ledger.get(cmdId);
      if (e !== undefined && e.promptState === "queued") {
        deps.ledger.updatePrompt(cmdId, { promptState: "unconfirmed", reason: "timeout" }, deps.now());
        deps.onChanged();
      }
    });
  }

  function handleAbort(frame: CmdFrame): void {
    if (frame.cmd.op !== "abort") return;
    const cmd = frame.cmd;
    if (!beginOrReply(frame)) return;
    const ctx = deps.getCtx();
    if (ctx === undefined) return settleAndReply(frame, errResult("E_STALE_CTX", true, "none"));
    if (cmd.expect?.sessionId !== undefined && cmd.expect.sessionId !== deps.getSessionId()) {
      return settleAndReply(frame, errResult("E_SESSION_CHANGED", false, "none"));
    }
    let wasBusy: boolean;
    try {
      wasBusy = !ctx.isIdle();
      ctx.abort();
    } catch {
      return settleAndReply(frame, errResult("E_STALE_CTX", true, "none"));
    }
    settleAndReply(frame, okResult({ op: "abort", wasBusy }));
    deps.originEntry.notify(ctx, "abort", frame.origin);
  }

  function mapSteerError(r: { ok: false; reason: string; detail?: string }): LedgerResult {
    if (r.reason === "not_running") return errResult("E_NOT_RUNNING", false, "none");
    if (r.reason === "steer_rejected") return errResult("E_SUBAGENT_REJECTED", false, "none", r.detail);
    return errResult("E_DEADLINE", true, "unknown"); // steer_timeout or any other service-side timeout
  }

  function releaseStaleRunLock(runId: string, query: QueryControlPort): void {
    const cmdId = pendingSteerByRun.get(runId);
    if (cmdId === undefined) return;
    const cur = query.get(runId);
    if (cur !== undefined && cur.status !== "running") pendingSteerByRun.delete(runId);
  }

  function handleSteer(frame: CmdFrame): void {
    if (frame.cmd.op !== "steer_subagent") return;
    const cmd = frame.cmd;
    if (!beginOrReply(frame, { runId: cmd.runId })) return;
    const query = deps.query?.();
    if (query === undefined) return settleAndReply(frame, errResult("E_UNSUPPORTED", false, "none"));
    if (byteLen(cmd.text) > STEER_TEXT_MAX_BYTES)
      return settleAndReply(frame, errResult("E_BAD_REQUEST", true, "none"));
    const snap = query.get(cmd.runId);
    if (snap === undefined) return settleAndReply(frame, errResult("E_NOT_FOUND", false, "none"));
    if (snap.status !== "running") return settleAndReply(frame, errResult("E_NOT_RUNNING", false, "none"));
    releaseStaleRunLock(cmd.runId, query);
    if (pendingSteerByRun.has(cmd.runId)) return settleAndReply(frame, errResult("E_BUSY_STEER", true, "none"));
    if (lateCount >= STEER_LATE_CAP) return settleAndReply(frame, errResult("E_BUSY_STEER", true, "none"));
    pendingSteerByRun.set(cmd.runId, frame.id);
    let settled = false;
    const timer = deps.setTimer(Math.min(5_000, opTotal(frame)), () => {
      if (settled) return;
      settled = true;
      lateCount += 1;
      replyOnly(frame, errResult("E_DEADLINE", true, "unknown"));
    });
    let stepPromise: ReturnType<QueryControlPort["steer"]>;
    try {
      stepPromise = query.steer(cmd.runId, cmd.text);
    } catch {
      pendingSteerByRun.delete(cmd.runId);
      timer.cancel();
      return settleAndReply(frame, errResult("E_SUBAGENT_REJECTED", false, "none"));
    }
    stepPromise.then(
      (r) => {
        const result = r.ok ? okResult({ op: "steer_subagent" }) : mapSteerError(r);
        if (settled) {
          lateCount = Math.max(0, lateCount - 1);
          pendingSteerByRun.delete(cmd.runId);
          settleLate(frame, result);
          if (r.ok) {
            const ctx = deps.getCtx();
            if (ctx !== undefined) deps.originEntry.notify(ctx, `steer subagent ${cmd.runId}`, frame.origin);
          }
          return;
        }
        settled = true;
        timer.cancel();
        pendingSteerByRun.delete(cmd.runId);
        settleAndReply(frame, result);
        if (r.ok) {
          const ctx = deps.getCtx();
          if (ctx !== undefined) deps.originEntry.notify(ctx, `steer subagent ${cmd.runId}`, frame.origin);
        }
      },
      () => {
        const result = errResult("E_SUBAGENT_REJECTED", false, "none");
        if (settled) {
          lateCount = Math.max(0, lateCount - 1);
          pendingSteerByRun.delete(cmd.runId);
          settleLate(frame, result);
          return;
        }
        settled = true;
        timer.cancel();
        pendingSteerByRun.delete(cmd.runId);
        settleAndReply(frame, result);
      },
    );
  }

  function mapStopResult(r: StopResult): LedgerResult {
    if (r.ok) return okResult({ op: "abort_subagent", escalatedTo: r.escalatedTo });
    if (r.reason === "unknown_run") return errResult("E_NOT_FOUND", false, "none");
    if (r.reason === "already_terminal") return okResult({ op: "abort_subagent", alreadyTerminal: true });
    return errResult("E_SUBAGENT_REJECTED", false, "none", `stop_failed (escalatedTo:${r.escalatedTo})`);
  }

  function handleStop(frame: CmdFrame): void {
    if (frame.cmd.op !== "abort_subagent") return;
    const cmd = frame.cmd;
    if (!beginOrReply(frame, { runId: cmd.runId })) return;
    const query = deps.query?.();
    if (query === undefined) return settleAndReply(frame, errResult("E_UNSUPPORTED", false, "none"));
    const snap = query.get(cmd.runId);
    if (snap === undefined) return settleAndReply(frame, errResult("E_NOT_FOUND", false, "none"));
    if (lateCount >= STEER_LATE_CAP) return settleAndReply(frame, errResult("E_BUSY_STEER", true, "none"));
    let settled = false;
    const timer = deps.setTimer(Math.min(6_000, opTotal(frame)), () => {
      if (settled) return;
      settled = true;
      lateCount += 1;
      replyOnly(frame, errResult("E_DEADLINE", true, "unknown"));
    });
    let stopPromise: Promise<StopResult>;
    try {
      stopPromise = query.stop(cmd.runId, "user_stop");
    } catch {
      timer.cancel();
      return settleAndReply(frame, errResult("E_SUBAGENT_REJECTED", false, "none"));
    }
    stopPromise.then(
      (r) => {
        const result = mapStopResult(r);
        if (settled) {
          lateCount = Math.max(0, lateCount - 1);
          settleLate(frame, result);
          if (result.ok) {
            const ctx = deps.getCtx();
            if (ctx !== undefined) deps.originEntry.notify(ctx, `stop subagent ${cmd.runId}`, frame.origin);
          }
          return;
        }
        settled = true;
        timer.cancel();
        settleAndReply(frame, result);
        if (result.ok) {
          const ctx = deps.getCtx();
          if (ctx !== undefined) deps.originEntry.notify(ctx, `stop subagent ${cmd.runId}`, frame.origin);
        }
      },
      () => {
        const result = errResult("E_SUBAGENT_REJECTED", false, "none");
        if (settled) {
          lateCount = Math.max(0, lateCount - 1);
          settleLate(frame, result);
          return;
        }
        settled = true;
        timer.cancel();
        settleAndReply(frame, result);
      },
    );
  }

  function handleCommand(frame: CmdFrame): void {
    if (frame.cmd.op !== "command") return;
    const cmd = frame.cmd;
    if (!beginOrReply(frame)) return;
    let result: LedgerResult;
    try {
      result = deps.builtinBridge.execute(frame);
    } catch {
      result = errResult("E_UNSUPPORTED", false, "none");
    }
    settleAndReply(frame, result);
    if (result.ok) {
      // acc32-B5: pi's own `showStatus()` merges consecutive chat-status lines when nothing else
      // was added to the transcript in between ("avoid log spam") — for an UNCAPTURED extension
      // command (a third party's, run synchronously inside `builtinBridge.execute()` above,
      // strictly before this line), the command's OWN `ctx.ui.notify(...)` call already landed
      // in that same slot; firing our own "web ▸ /name …" attribution notify right after would
      // silently OVERWRITE it (dedup, not append) — the only place a third-party command's
      // output was ever visible at all, since `captured:false` means the web side never gets it
      // either. Skip our own notify for exactly that case; pi-toolkit's own (captured) commands
      // keep it — their real output also reaches the web via `capture`, so even a clobbered
      // terminal line loses nothing.
      const uncapturedExtension =
        result.data.op === "command" && result.data.kind === "extension" && result.data.captured !== true;
      if (!uncapturedExtension) {
        const ctx = deps.getCtx();
        if (ctx !== undefined) deps.originEntry.notify(ctx, `/${cmd.name}`, frame.origin);
      }
    }
  }

  return {
    handle(frame) {
      if (!deps.controlEnabled()) {
        deps.send(toResultFrame(frame, errResult("E_UNSUPPORTED", false, "none")));
        return;
      }
      if (frame.queryOnly === true) return handleQueryOnly(frame);
      const op: CmdOp = frame.cmd.op;
      if (op === "prompt") return handlePrompt(frame);
      if (op === "abort") return handleAbort(frame);
      if (op === "steer_subagent") return handleSteer(frame);
      if (op === "abort_subagent") return handleStop(frame);
      if (op === "command") return handleCommand(frame);
      // dialog_answer / dialog_cancel: routed straight to the dialog bridge by the caller.
    },
    onInputEvent(ev) {
      if (ev.source !== "extension") {
        if (ev.streamingBehavior !== undefined) {
          deps.queueMirror.enqueue({
            text: ev.text,
            deliver: ev.streamingBehavior,
            source: ev.source === "interactive" ? "tui" : "extension",
          });
          deps.onChanged();
        }
        return;
      }
      const match = deps.ledger.findDispatchedByText(ev.text);
      if (match === undefined) {
        if (ev.streamingBehavior !== undefined) {
          deps.queueMirror.enqueue({ text: ev.text, deliver: ev.streamingBehavior, source: "extension" });
          deps.onChanged();
        }
        return;
      }
      const behavior = ev.streamingBehavior ?? "idle";
      deps.ledger.updatePrompt(match.id, { promptState: "observed", behavior }, deps.now());
      const pending = pendingObservation.get(match.id);
      if (pending !== undefined) {
        pending.timer.cancel();
        pendingObservation.delete(match.id);
        settleAndReply(pending.frame, okResult({ op: "prompt", delivery: "observed", behavior }));
      }
      if (behavior === "idle") {
        scheduleIdleStartedTimeout(match.id, ev.text);
      } else {
        deps.ledger.updatePrompt(match.id, { promptState: "queued" }, deps.now());
        deps.queueMirror.enqueue({ text: ev.text, deliver: behavior, source: "web", cmdId: match.id });
        scheduleQueuedTimeout(match.id);
      }
      deps.onChanged();
    },
    onMessageStart(ev) {
      const text = firstUserText(ev.message);
      if (text === undefined) return;
      let changed = false;
      for (const [cmdId, watched] of idleWatch) {
        if (watched !== text) continue;
        idleWatch.delete(cmdId);
        const e = deps.ledger.get(cmdId);
        if (e !== undefined && e.promptState === "observed") {
          // §4.3: unlike the queued path (dequeue → consumed), there is no separate "dequeue"
          // event for an idle dispatch — the turn actually starting IS the terminal event, so
          // `started` must transition straight to `consumed` here or it never leaves the
          // ledger's active-looking state (acc32-B2①: the ctl slot kept reporting `started`
          // forever — 30min TTL/capacity aside — and the web UI's queue list showed it as
          // "queued" indefinitely).
          deps.ledger.updatePrompt(cmdId, { promptState: "consumed" }, deps.now());
          changed = true;
        }
        break;
      }
      const dequeued = deps.queueMirror.dequeueByText(text);
      if (dequeued?.cmdId !== undefined) {
        deps.ledger.updatePrompt(dequeued.cmdId, { promptState: "consumed" }, deps.now());
        changed = true;
      }
      if (changed) deps.onChanged();
    },
    onPendingSample(hasPending) {
      const cleared = deps.queueMirror.clearIfEmpty(hasPending);
      let changed = false;
      for (const item of cleared) {
        if (item.cmdId === undefined) continue;
        deps.ledger.updatePrompt(item.cmdId, { promptState: "dropped" }, deps.now());
        changed = true;
      }
      if (changed) deps.onChanged();
    },
    releaseSettledSteerLocks() {
      const query = deps.query?.();
      if (query === undefined || pendingSteerByRun.size === 0) return;
      for (const runId of [...pendingSteerByRun.keys()]) releaseStaleRunLock(runId, query);
    },
    handleBridgeLate(frame, result) {
      settleLate(frame, result);
    },
    onSessionBoundary() {
      const cleared = deps.queueMirror.clearAll();
      let changed = false;
      for (const item of cleared) {
        if (item.cmdId === undefined) continue;
        deps.ledger.updatePrompt(item.cmdId, { promptState: "dropped", reason: "session" }, deps.now());
        changed = true;
      }
      if (changed) deps.onChanged();
    },
    dispose() {
      for (const p of pendingObservation.values()) {
        try {
          p.timer.cancel();
        } catch {
          /* ignore */
        }
      }
      pendingObservation.clear();
      idleWatch.clear();
      pendingSteerByRun.clear();
    },
  };
}
