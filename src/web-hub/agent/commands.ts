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
import type { HoldItem } from "./hold.js";
import type { DispatchOutcome, HoldDriver } from "./hold-driver.js";
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
  /** web-hub-steer-recall plan §4.4 A3: the hold driver, when `webHub.steerRecall` is wired
   * (`undefined` ⇔ disabled — prompts take the native path unconditionally and `recall` degrades
   * to `E_UNSUPPORTED`, D22/S5). Looked up lazily (not captured once) so index.ts can construct
   * the driver after the handler without a temporal-dead-zone cycle. */
  hold?: () => HoldDriver | undefined;
  /** v4.3 Y4/Y7.3: this module instance's identity, threaded into `ledger.begin`'s `owner` extra
   * and `findDispatchedByText`'s scope so a stale (pre-`/reload`) owner's dispatched entry can
   * never be mistaken for a current one even when `sessionId` happens to match. Optional so a
   * caller that hasn't wired hold-recall yet (no `hold` dep either) still compiles unchanged. */
  owner?: string;
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
  /** web-hub-steer-recall plan §4.3 A2 / §5.3: the hold driver's `dispatchToPi` — P2-P5 only
   * (precondition check, ledger write, origin entry, the actual `sendUserMessage` call). Never
   * touches the hold buffer and never calls `onReturned` (D5: the driver owns both). Exposed on
   * the handler (rather than free-standing) because it shares `pendingObservation`'s 30 s CAS
   * timer machinery with the native prompt path. */
  dispatchHeld(item: HoldItem): DispatchOutcome;
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
      ...(deps.owner !== undefined ? { owner: deps.owner } : {}),
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
    // web-hub-steer-recall plan §4.4 A3 point 2: try the hold branch BEFORE the native dispatch—
    // the ledger is written first (`held`), then the buffer; a `hold()` capacity-race failure
    // falls through to the native path below (which re-asserts `text` since "held" doesn't retain
    // it, §5.2 — "臺账先写，hold失败回滚到原生路径").
    const drv = deps.hold?.();
    if (drv !== undefined) {
      const req = { cmdId: frame.id, text: cmd.text, deliver: cmd.deliver, origin: frame.origin };
      if (drv.canHold(req, ctx)) {
        deps.ledger.updatePrompt(frame.id, { promptState: "held", behavior: cmd.deliver }, deps.now());
        if (drv.hold(req)) {
          deps.onChanged();
          return settleAndReply(frame, okResult({ op: "prompt", delivery: "held", behavior: cmd.deliver }));
        }
      }
    }
    deps.ledger.updatePrompt(frame.id, { promptState: "dispatched", text: cmd.text }, deps.now());
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

  /** Extracted so `dispatchHeld` (no HTTP reply pending) can reuse the exact same CAS-guarded 30 s
   * display-timer the native path uses (§5.5: `promptState==="dispatched"` at fire time). */
  function scheduleUnobservedFinalize(cmdId: string): void {
    deps.setTimer(PROMPT_UNOBSERVED_FINALIZE_MS, () => {
      const e = deps.ledger.get(cmdId);
      if (e !== undefined && e.promptState === "dispatched") {
        deps.ledger.updatePrompt(cmdId, { promptState: "unconfirmed", reason: "unobserved" }, deps.now());
        deps.onChanged();
      }
    });
  }

  /** verifier r_BHFA552J P1 (Y7.3): the hold-attributed consumption-time dequeue. Resolves the
   * UNIQUE `queued`-state ledger candidate for `text` (scoped by session/owner, same ambiguity
   * safety as `onInputEvent`'s observe-time lookup), then removes ONLY that exact cmdId from the
   * queue mirror — never a blind FIFO text match. A same-text TUI/other-extension mirror item (no
   * cmdId, or a different cmdId) is NEVER touched. No unique candidate ⇒ dequeue NOTHING. */
  function dequeueHoldAttributed(text: string): ReturnType<QueueMirror["dequeueByText"]> {
    const candidate = deps.ledger.findQueuedByText(text, {
      sessionId: deps.getSessionId(),
      ...(deps.owner !== undefined ? { owner: deps.owner } : {}),
    });
    if (candidate === undefined) return undefined;
    return deps.queueMirror.dequeueByCmdId(candidate.id, text);
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
    scheduleUnobservedFinalize(frame.id);
    return entry;
  }

  /** web-hub-steer-recall plan §5.3 P2-P5, synchronous, no `await`. Precondition check → ledger
   * write (dispatched + text restored) → origin entry (self-swallowing, P4) → the actual
   * `sendUserMessage` call. Never touches the hold buffer, never calls `onReturned` — the driver
   * (caller) owns P1/P6/P7 (D5). */
  function dispatchHeld(item: HoldItem): DispatchOutcome {
    try {
      const ctx = deps.getCtx();
      if (ctx === undefined) return "refused";
      if (deps.getSessionId() !== item.sessionId) return "refused";
      if (deps.compactionState.manualCompacting) return "refused";
    } catch {
      return "refused"; // P2
    }
    try {
      deps.ledger.updatePrompt(item.cmdId, { promptState: "dispatched", text: item.text }, deps.now());
      scheduleUnobservedFinalize(item.cmdId);
    } catch {
      return "refused"; // P3
    }
    try {
      deps.originEntry.appendOrigin("prompt", item.cmdId, item.origin, item.deliver);
    } catch {
      /* P4: self-swallowing — never affects the outcome */
    }
    // v4.3 P5 fix (verifier r_BHFA552J P2): once we are ABOUT to call `sendUserMessage`, we commit
    // to "sent" regardless of what happens inside it. The underlying runtime can synchronously fire
    // real side effects (the `input` event, possibly even an enqueue) before throwing further down
    // its own call chain, so a thrown exception here does NOT prove nothing was delivered. Treating
    // it as "threw"/"refused" (⇒ the driver marks the item `returned{stale}`) would let the browser
    // resend it while pi might already be about to process the first copy — a duplicate delivery.
    // "sent" leaves the ledger entry at `dispatched`, which decays to `unconfirmed` via the existing
    // 30s timer (already armed above) if no observation ever lands — exactly the "possibly-delivered"
    // semantics called for, with no new state needed.
    try {
      deps.pi.sendUserMessage(item.text, { deliverAs: item.deliver, expandPromptTemplates: false });
    } catch {
      /* side-effect-then-throw: still reported as "sent" above/below — see comment. */
    }
    return "sent";
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
      deps.hold?.()?.onWebAbort();
      ctx.abort();
    } catch {
      return settleAndReply(frame, errResult("E_STALE_CTX", true, "none"));
    }
    settleAndReply(frame, okResult({ op: "abort", wasBusy }));
    deps.originEntry.notify(ctx, "abort", frame.origin);
  }

  /** web-hub-steer-recall plan §4.4 A3 point 4 / §5.8. `toRecallResult` lives inline here — it is
   * the single construction point for `RecallResultData`. */
  function handleRecall(frame: CmdFrame): void {
    if (frame.cmd.op !== "recall") return;
    const cmd = frame.cmd;
    if (!beginOrReply(frame)) return;
    const drv = deps.hold?.();
    if (drv === undefined) return settleAndReply(frame, errResult("E_UNSUPPORTED", false, "none"));
    const outcome = drv.recall(cmd.target);
    if (outcome.kind === "recalled") {
      deps.ledger.updatePrompt(cmd.target, { promptState: "recalled" }, deps.now());
      return settleAndReply(
        frame,
        okResult({
          op: "recall",
          outcome: "recalled",
          from: outcome.from,
          deliver: outcome.item.deliver,
          text: outcome.item.text,
        }),
      );
    }
    if (outcome.kind === "too_late") {
      return settleAndReply(frame, okResult({ op: "recall", outcome: "too_late" }));
    }
    // outcome.kind === "unknown": the buffer no longer has it (never held, or already handed off
    // and released). Consult the ledger to tell "too_late" (a real prompt, now past held) from a
    // genuinely unknown/non-prompt target (S5).
    const target = deps.ledger.get(cmd.target);
    if (target !== undefined && target.op === "prompt") {
      return settleAndReply(frame, okResult({ op: "recall", outcome: "too_late" }));
    }
    return settleAndReply(frame, errResult("E_NOT_FOUND", false, "none"));
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
      // acc32-B5 (revised per verifier r_29729WTC): plan §0.2/U6 requires a terminal notify for
      // EVERY successful non-prompt write op, third-party commands included — the earlier fix
      // that skipped our own notify entirely for an UNCAPTURED extension command (a third
      // party's, run synchronously inside `builtinBridge.execute()` above) restored that
      // command's own notify visibility but silently dropped ours, which the plan does not
      // allow. Both notifies now always fire; for the uncaptured-extension case specifically we
      // pass `avoidStatusMerge: true` so ours doesn't silently overwrite the command's own
      // `ctx.ui.notify(...)` call that just landed in the same pi `showStatus()` merge slot (see
      // `OriginEntryPort.notify`'s doc comment for the underlying pi pitfall) — the only place a
      // third-party command's output was ever visible at all, since `captured:false` means the
      // web side never gets it either. Ordinary (own/captured/template) commands keep the plain
      // style: there is no immediately-preceding foreign notify to protect against.
      const uncapturedExtension =
        result.data.op === "command" && result.data.kind === "extension" && result.data.captured !== true;
      const ctx = deps.getCtx();
      if (ctx !== undefined) {
        deps.originEntry.notify(ctx, `/${cmd.name}`, frame.origin, { avoidStatusMerge: uncapturedExtension });
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
      if (op === "recall") return handleRecall(frame);
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
      // v4.3 Y4/Y7.3 (verifier r_BHFA552J P2): the scoped + ambiguity-safe match is used ONLY when
      // the hold feature is actually wired (a HoldDriver is attached) — with hold off this call is
      // byte-identical to the pre-steer-recall native path (no `scope` arg → earliest-candidate,
      // no session/owner filtering, no ambiguity rejection). A `undefined` result with hold on means
      // either "no match" or "more than one candidate" (ambiguous) — both fall through to the same
      // unattributed-enqueue path; no cmdId is ever guessed.
      const holdOn = deps.hold?.() !== undefined;
      const match = holdOn
        ? deps.ledger.findDispatchedByText(ev.text, {
            sessionId: deps.getSessionId(),
            ...(deps.owner !== undefined ? { owner: deps.owner } : {}),
          })
        : deps.ledger.findDispatchedByText(ev.text);
      if (match === undefined) {
        if (ev.streamingBehavior !== undefined) {
          deps.queueMirror.enqueue({ text: ev.text, deliver: ev.streamingBehavior, source: "extension" });
          deps.onChanged();
        }
        return;
      }
      const behavior = ev.streamingBehavior ?? "idle";
      deps.ledger.updatePrompt(match.id, { promptState: "observed", behavior }, deps.now());
      deps.hold?.()?.onObserved(match.id); // E1 — display-only since Y1, never lifts B1.
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
          deps.hold?.()?.onConsumed(cmdId); // E2 — the ONLY lift of B1 (Y1).
          changed = true;
        }
        break;
      }
      const holdOn = deps.hold?.() !== undefined;
      const dequeued = holdOn ? dequeueHoldAttributed(text) : deps.queueMirror.dequeueByText(text);
      if (dequeued?.cmdId !== undefined) {
        deps.ledger.updatePrompt(dequeued.cmdId, { promptState: "consumed" }, deps.now());
        deps.hold?.()?.onConsumed(dequeued.cmdId); // E2 — the ONLY lift of B1 (Y1).
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
    dispatchHeld(item) {
      return dispatchHeld(item);
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
