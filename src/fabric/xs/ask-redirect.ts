import type { Clock, TimerHandle } from "../../core/clock.js";
import { systemClock } from "../../core/clock.js";
import { clampSpanMs } from "../../core/deadline.js";
import type { XsSendOutcome } from "./sender.js";
import type { XsWakeLedger } from "./wake-ledger.js";
import { XS_REPLY_REQUEST_ID_RE } from "../../web-hub/protocol/xs.js";

/**
 * #21 xs 委派中途提问 — fabric half of the ask_user host redirect (plan `docs/dev/xs-ask-redirect/`
 * §1 D2–D8). One instance per xs stack (`buildStackXs`), created only while controller ∧ reply
 * ledger ∧ `fabric.crossSession.askRedirect.enabled` ∧ the activation-level wiring all hold;
 * absent ⇒ the ask_user tool keeps its local-dialog path byte for byte (I9).
 *
 *  - **Origin trust (D3/M4)**: `observeWrite` is an observation-only tap on the stack's ONE host
 *    write exit, shared by the receiver and the RootWakeController. A wake dispatch
 *    (`customType:"subagent:xs" ∧ xsWake ∧ wakeToken ∧ !activateFor ∧ reply`) is matched against
 *    the ledger record, the record's session/xid and the controller's `activeToken` IN the same
 *    synchronous dispatch call, and only then does it write `askOrigin` ONCE. No branch scan —
 *    pi custom messages carry no writer authentication, so anything not seen on this exit is
 *    untrusted. An answer frame carries `inReplyTo` and never `reply`, so a reply-revived run can
 *    never masquerade as a fresh delegation (reply-to-wake runs stay the O class).
 *  - **Admission (D4)**: `askUsed` on the wake-ledger record IS "billed + in-flight" — reserved
 *    synchronously before the first await, effective cap `min(maxPerRun, 2)` regardless of the
 *    injected value (parse already clamps to 1..2; garbage fails closed). Refund only for a
 *    provably-unsent result (D7 `none`, or a queue-window refusal that never sent); `unknown`
 *    always bills. Calls are serialised per token (FIFO + `pairMinIntervalMs` between sends);
 *    queueing time counts against the call's own absolute deadline.
 *  - **Deadlines (D5)**: `waitUntil = min(t0+timeoutS·1e3, record.deadlineAt−60s, askOrigin.dueAt−60s)`
 *    covers queueing + resolve + send + waiting; the host re-arms at `min(waitUntil, q2DueAt)`
 *    once the sender reports the real ticket due time via `onIssued`. Timers go through the
 *    injected `Clock` (segmented + unref'd in production) with `clampSpanMs` spans (I1/I5).
 *  - **State machine (D6/M5/M6)**: one terminal claim per call
 *    (`answered|timeout|not_woken|unavailable|aborted|disposed`); claim clears the timer, drops
 *    the abort listener and aborts `ctl`. The send rides `AbortSignal.any([tool, ctl])` +
 *    `invocationLive` so a terminal reached before the sender's post-resolve guard prevents the
 *    frame outright. Anything arriving after the terminal is conservative bookkeeping: no refund,
 *    no revival, no resend.
 *  - **Classification (D7/M8)**: `classifyAskSend` over the real `XsSendOutcome` — `none` ⇒
 *    unavailable+refund, missing ticket ⇒ `no_ticket` (billed), `unknown` ⇒ bounded wait,
 *    `applied ∧ woke` ⇒ wait, `applied ∧ wakeDowngraded` ⇒ `not_woken` (proven downgrade ⇒
 *    return immediately, per the user ruling; the ticket stays, late answers still deliver).
 *
 * Pi-free by construction (source-scan gate in `tests/fabric/xs-reply-ledger.test.ts`). The
 * §2.0 types below are a LOCAL structural copy of B2's `src/ask-user/redirect.ts` contract —
 * fabric must not import B2's file; B3 wires the two together.
 */

// ------------------------------------------------- §2.0 frozen shared contract (local copy)

export type AskRedirectReason =
  | "detached"
  | "origin_window"
  | "run_window"
  | "queue_window"
  | "level_limit"
  | "limit"
  | "too_large"
  | "no_ticket"
  | `send_none:${string}`;

export type AskUserRedirectResult =
  | {
      kind: "answered";
      answerText: string;
      /** This question's q2 ticket (root ruling 2026-11-05: every variant's requestId is the q2). */
      requestId: string;
      /** The ORIGINAL delegation's replyTo (ledger `askOrigin.requestId`) — where the final
       *  result must still be delivered; distinct from the q2 this answer consumed. */
      originRequestId: string;
      attempt: number;
      limit: number;
    }
  | { kind: "timeout"; requestId: string; attempt: number; limit: number; waitedS: number }
  | { kind: "not_woken"; requestId: string; downgrade: string; attempt: number; limit: number }
  | { kind: "unavailable"; reason: AskRedirectReason; limit: number; attempt?: number; requestId?: string }
  | { kind: "aborted" }
  | { kind: "disposed" };

/** The ask-user side of the port (B2 owns the canonical type; this copy is structural only). */
export interface AskUserRedirectPort {
  /** 同步：undefined ⇔ O 类（调用方走原路径）。render(budget) 返回 undefined ⇔ too_large。 */
  ask(input: {
    render: (budgetChars: number) => string | undefined;
    signal?: AbortSignal;
  }): Promise<AskUserRedirectResult> | undefined;
}

// ------------------------------------------------- deps & send args

/** What the redirect hands to the real sender (`xsSender.message`); no invocation is ever attached
 *  (origin `model`, no grant, no level reset — D10). */
export interface XsAskRedirectSendArgs {
  to: string;
  text: string;
  wake: true;
  expectReply: { timeoutS: number };
  signal?: AbortSignal;
  invocationLive(): boolean;
  onIssued?(t: { requestId: string; dueAt: number }): void;
}

/** Narrow controller view (pi-free; the stack passes the real RootWakeController). */
export interface XsAskRedirectControllerView {
  readonly state: string;
  readonly activeToken: string | undefined;
}

export interface XsAskRedirectDeps {
  sessionId: string;
  ledger: XsWakeLedger;
  controller(): XsAskRedirectControllerView | undefined;
  /** Live attach probe (activate's `xsAttached`); false ⇒ U(detached). */
  attached(): boolean;
  /** Local `hopAllowed(levelOfRoot())` pre-check; false ⇒ U(level_limit). */
  wakeHopAllowed(): boolean;
  /** `fabric.maxChars` — the redirect owns the whole-question budget (D8). */
  maxChars: number;
  /** `fabric.crossSession.limits.pairMinIntervalMs` — the hub's non-reply pair interval (D4). */
  pairMinIntervalMs: number;
  /** `fabric.crossSession.askRedirect.timeoutS` (parse-clamped 60..3600). */
  timeoutS: number;
  /** `fabric.crossSession.askRedirect.maxPerRun` — effective value is min(·, 2), fail closed. */
  maxPerRun: number;
  /** Clock seam (ms); defaults to the unref'd segmented system clock. */
  clock?: Clock;
  /** The real sender message fn; `undefined` (no sender) is treated as provably unsent. */
  send(args: XsAskRedirectSendArgs): Promise<XsSendOutcome> | undefined;
}

export interface XsAskRedirect extends AskUserRedirectPort {
  /** Observation-only tap on the stack's host write exit (origin capture + answer match). */
  observeWrite(message: unknown): void;
  /** Stack dispose: settle every in-flight call as `disposed` (billed, never refunded). */
  dispose(): void;
}

// ------------------------------------------------- constants (D5/D8)

/** D5: the two 60 s margins (record deadline, origin dueAt) and the <60 s admission floors. */
export const XS_ASK_MARGIN_MS = 60_000;
/** D4: the hard ceiling on redirects per run — settings can only tighten, never loosen. */
export const XS_ASK_HARD_LIMIT = 2;

/** D8 first line: `[ask_user→requester] attempt n/2 · origin <originRequestId>`. */
export const xsAskRedirectHeader = (attempt: number, limit: number, originRequestId: string): string =>
  `[ask_user→requester] attempt ${attempt}/${limit} · origin ${originRequestId}`;

/** D8 explanation paragraph (verbatim from the plan). */
export const XS_ASK_REDIRECT_INSTRUCTIONS =
  "我在处理你的请求时需要你拍板；请用 message_session 回复**本消息**（replyTo 填本消息头的 reply_to）；原请求仍未完成，不要用它回答；答复格式 `1: a；2: <自定义>`";

// ------------------------------------------------- D7: send-outcome classification

export type AskSendClass = "none" | "no_ticket" | "wait" | "not_woken";

/**
 * D7/M8: ordered classification over the REAL `XsSendOutcome` — pure, no side effects.
 *  1. `effect:"none"` ⇒ none (provably unsent — local refusals, hub admission `rate_*`,
 *     receiver-side `rejected`/`expired`/`fenced:*`/…).
 *  2. ticket not pending ⇒ no_ticket (defensive; expectReply was requested).
 *  3. `effect:"unknown"` ⇒ wait (queued/start_deferred/client_deadline/… — the q2 is registered,
 *     bounded waiting is enough; never resend).
 *  4. `applied ∧ woke` ⇒ wait (dispatch accepted; the answer tap resolves).
 *  5. `applied ∧ wakeDowngraded` ⇒ not_woken (PROVEN downgrade: delivered but no turn — return
 *     immediately per the user ruling; the ticket stays, late answers still deliver).
 *  6. else ⇒ wait (conservative; currently unreachable).
 */
export function classifyAskSend(o: XsSendOutcome): AskSendClass {
  if (o.effect === "none") return "none";
  if (o.reply === undefined || o.reply.state !== "pending") return "no_ticket";
  if (o.effect === "unknown") return "wait";
  if (o.effect === "applied") {
    if (o.woke === true) return "wait";
    if (o.wakeDowngraded !== undefined) return "not_woken";
  }
  return "wait";
}

// ------------------------------------------------- call state machine

type AskCallState = "pending" | "answered" | "timeout" | "not_woken" | "unavailable" | "aborted" | "disposed";

interface AskCall {
  readonly token: string;
  state: AskCallState;
  result?: AskUserRedirectResult;
  readonly attempt: number;
  readonly limit: number;
  readonly startedAt: number;
  readonly waitUntil: number;
  readonly requesterSessionId: string;
  readonly originRequestId: string;
  readonly text: string;
  q2?: string;
  q2DueAt?: number;
  answerText?: string;
  sendStarted: boolean;
  deadlineHit: boolean;
  readonly ctl: AbortController;
  timer?: TimerHandle | undefined;
  queueTimer?: TimerHandle | undefined;
  onToolAbort?: () => void;
  readonly toolSignal?: AbortSignal;
  readonly resolve: (r: AskUserRedirectResult) => void;
}

interface TokenQueue {
  /** FIFO: head is the next (or in-flight) call. */
  calls: AskCall[];
  inFlight?: AskCall | undefined;
}

export function createXsAskRedirect(deps: XsAskRedirectDeps): XsAskRedirect {
  const clock: Clock = deps.clock ?? systemClock;
  // D9: effective cap min(·, 2); fail closed on garbage (never loosen, on any injection path).
  const limit =
    typeof deps.maxPerRun === "number" && Number.isFinite(deps.maxPerRun)
      ? Math.min(Math.floor(deps.maxPerRun), XS_ASK_HARD_LIMIT)
      : 0;
  const queues = new Map<string, TokenQueue>();
  /**
   * token → last time the hub stamped this pair (our q2 send, or the requester's answer: a reply
   * skips the interval CHECK but still stamps `pair.lastAt`). Survives queue deletion — a later
   * ask in the same run must still wait out the interval. Entries are dropped once elapsed.
   */
  // Deliberately NOT wired into the wake-ledger's release hook: residues left behind after a token is
  // released are bounded — 64-entry soft cap (pruned by the interval check in the queue pump), elapsed
  // entries dropped there, and everything cleared on dispose — so no extra release path is worth it.
  const pairStamp = new Map<string, number>();
  /** q2 (ticket requestId) → the pending call awaiting that answer (registered at `onIssued`). */
  const byRequest = new Map<string, AskCall>();
  let disposed = false;

  const armSpan = (delayMs: number, fn: () => void): TimerHandle => clock.setTimer(clampSpanMs(delayMs) ?? 0, fn);

  /** D4: give back this call's synchronous reservation (provably unsent only). */
  const refund = (call: AskCall): void => {
    const rec = deps.ledger.get(call.token);
    if (rec !== undefined && typeof rec.askUsed === "number" && rec.askUsed > 0)
      deps.ledger.update(call.token, { askUsed: rec.askUsed - 1 });
  };

  /** D5: host wait end = min(waitUntil, q2DueAt) — re-arm on the real ticket due time. */
  const armDeadline = (call: AskCall): void => {
    if (call.timer !== undefined) clock.clearTimer(call.timer);
    const end = Math.min(call.waitUntil, call.q2DueAt ?? Number.POSITIVE_INFINITY);
    call.timer = armSpan(end - clock.now(), () => onDeadline(call));
  };

  function onDeadline(call: AskCall): void {
    call.timer = undefined;
    if (call.state !== "pending") return;
    if (call.q2 !== undefined) {
      claim(call, "timeout");
      return;
    }
    if (!call.sendStarted) {
      // still queued when the absolute deadline passed ⇒ never sent ⇒ queue window (refunded)
      refund(call);
      claim(call, "unavailable", { reason: "queue_window" });
      return;
    }
    // resolve round trip in flight, ticket not yet issued: abort so the sender's post-resolve
    // guard answers none(origin_changed) — no frame leaves; the continuation settles unavailable.
    call.deadlineHit = true;
    call.ctl.abort();
  }

  /** D6: single terminal claim — clears timers, drops the listener, aborts ctl, settles the queue. */
  function claim(
    call: AskCall,
    kind: Exclude<AskCallState, "pending">,
    fields: { reason?: AskRedirectReason; downgrade?: string } = {},
  ): AskUserRedirectResult {
    if (call.state !== "pending") return call.result as AskUserRedirectResult;
    if (call.timer !== undefined) {
      clock.clearTimer(call.timer);
      call.timer = undefined;
    }
    if (call.queueTimer !== undefined) {
      clock.clearTimer(call.queueTimer);
      call.queueTimer = undefined;
    }
    if (call.onToolAbort !== undefined && call.toolSignal !== undefined)
      call.toolSignal.removeEventListener("abort", call.onToolAbort);
    call.ctl.abort();
    const common = { attempt: call.attempt, limit: call.limit };
    let result: AskUserRedirectResult;
    switch (kind) {
      case "answered":
        result = {
          kind,
          answerText: call.answerText ?? "",
          requestId: call.q2 ?? "",
          originRequestId: call.originRequestId,
          ...common,
        };
        break;
      case "timeout":
        result = {
          kind,
          requestId: call.q2 ?? "",
          waitedS: Math.max(0, Math.round((clock.now() - call.startedAt) / 1000)),
          ...common,
        };
        break;
      case "not_woken":
        result = { kind, requestId: call.q2 ?? "", downgrade: fields.downgrade ?? "", ...common };
        break;
      case "unavailable":
        result = {
          kind,
          reason: fields.reason ?? "send_none:unspecified",
          limit: call.limit,
          attempt: call.attempt,
          ...(call.q2 !== undefined ? { requestId: call.q2 } : {}),
        };
        break;
      default:
        result = { kind };
    }
    call.state = kind;
    call.result = result;
    if (kind === "answered") pairStamp.set(call.token, clock.now());
    if (call.q2 !== undefined && byRequest.get(call.q2) === call) byRequest.delete(call.q2);
    const q = queues.get(call.token);
    if (q !== undefined) {
      if (q.inFlight === call) q.inFlight = undefined;
      const i = q.calls.indexOf(call);
      if (i >= 0) q.calls.splice(i, 1);
      pump(call.token);
    }
    call.resolve(result);
    return result;
  }

  /** D4/D5: serialise per token — the head waits for the previous terminal AND the pair interval. */
  function pump(token: string): void {
    if (disposed) return;
    const q = queues.get(token);
    if (q === undefined) return;
    while (q.calls.length > 0 && q.calls[0]!.state !== "pending") q.calls.shift();
    if (q.calls.length === 0) {
      if (q.inFlight === undefined) queues.delete(token);
      return;
    }
    if (q.inFlight !== undefined) return; // serial per token: wait for the previous TERMINAL
    const next = q.calls[0]!;
    if (pairStamp.size > 64) {
      const t = clock.now();
      for (const [k, v] of pairStamp) if (t - v >= deps.pairMinIntervalMs) pairStamp.delete(k);
    }
    const stamp = pairStamp.get(token);
    const earliest = stamp === undefined ? 0 : stamp + deps.pairMinIntervalMs;
    const wait = earliest - clock.now();
    if (next.queueTimer !== undefined) {
      clock.clearTimer(next.queueTimer);
      next.queueTimer = undefined;
    }
    if (wait > 0) {
      next.queueTimer = armSpan(wait, () => {
        next.queueTimer = undefined;
        pump(token);
      });
      return;
    }
    startSend(next, q);
  }

  function startSend(call: AskCall, q: TokenQueue): void {
    // D5 queue-head recompute: the q2 needs a ≥60 s remaining window, else refund + refuse.
    const remainingS = Math.ceil((call.waitUntil - clock.now()) / 1000);
    if (remainingS < Math.ceil(XS_ASK_MARGIN_MS / 1000)) {
      refund(call);
      claim(call, "unavailable", { reason: "queue_window" });
      return;
    }
    call.sendStarted = true;
    q.inFlight = call;
    void doSend(call, remainingS);
  }

  async function doSend(call: AskCall, timeoutS: number): Promise<void> {
    let outcome: XsSendOutcome | undefined;
    try {
      outcome = await deps.send({
        to: call.requesterSessionId,
        text: call.text,
        wake: true,
        expectReply: { timeoutS },
        signal: call.toolSignal !== undefined ? AbortSignal.any([call.toolSignal, call.ctl.signal]) : call.ctl.signal,
        invocationLive: () => call.state === "pending" && !disposed,
        onIssued: (t) => {
          // same sync block as the frame (sender contract) — register the precise q2 → call
          pairStamp.set(call.token, clock.now());
          if (call.state === "pending") {
            call.q2 = t.requestId;
            call.q2DueAt = t.dueAt;
            byRequest.set(t.requestId, call);
          }
        },
      });
    } catch {
      outcome = undefined; // adapter throw before any port round trip ⇒ provably no frame
    }
    // D6: anything after a terminal is conservative bookkeeping — no refund, no revival, no resend.
    if (call.state !== "pending") return;
    if (outcome === undefined) {
      refund(call);
      claim(call, "unavailable", { reason: "send_none:send_threw" });
      return;
    }
    switch (classifyAskSend(outcome)) {
      case "none":
        refund(call);
        claim(call, "unavailable", {
          reason: `send_none:${outcome.reason ?? outcome.code ?? outcome.status}`,
        });
        return;
      case "no_ticket":
        claim(call, "unavailable", { reason: "no_ticket" });
        return;
      case "not_woken":
        claim(call, "not_woken", {
          ...(outcome.wakeDowngraded !== undefined ? { downgrade: outcome.wakeDowngraded } : {}),
        });
        return;
      case "wait":
        if (call.deadlineHit) {
          // the deadline fired during the round trip but the frame still left — bounded timeout
          claim(call, "timeout");
          return;
        }
        if (call.q2 === undefined) {
          // unreachable: every wait outcome implies an issued ticket (defensive D7 branch 2)
          claim(call, "unavailable", { reason: "no_ticket" });
          return;
        }
        armDeadline(call); // D5: tighten the host wait to min(waitUntil, q2DueAt)
        return; // stays pending AND in-flight: the token stays serialised until terminal
    }
  }

  const unavailableNow = (reason: AskRedirectReason, attempt: number, q2?: string): Promise<AskUserRedirectResult> =>
    Promise.resolve({
      kind: "unavailable" as const,
      reason,
      limit,
      attempt,
      ...(q2 !== undefined ? { requestId: q2 } : {}),
    });

  // ------------------------------------------------- the ask entry (D2/D4/D5/D6/D8)

  const ask: XsAskRedirect["ask"] = (input) => {
    if (disposed) return undefined;
    // ---- O class (D2): every miss keeps the ordinary local dialog, byte-identical ----
    let controller: XsAskRedirectControllerView | undefined;
    try {
      controller = deps.controller();
    } catch {
      controller = undefined;
    }
    if (controller === undefined || controller.state !== "bound") return undefined;
    const token = controller.activeToken;
    if (typeof token !== "string" || token === "") return undefined;
    let rec;
    try {
      rec = deps.ledger.get(token);
    } catch {
      return undefined;
    }
    if (rec === undefined || rec.sessionId !== deps.sessionId) return undefined;
    if (rec.state !== "live" || rec.abortIssuedAt !== undefined || rec.authorizedAt === undefined) return undefined;
    if (rec.handed) return undefined;
    const origin = rec.askOrigin;
    if (origin === undefined) return undefined;

    // ---- U class (D2): trusted delegation but the redirect is unusable — explicit text, no dialog ----
    const attempt = (rec.askUsed ?? 0) + 1;
    if (!deps.attached()) return unavailableNow("detached", attempt);
    const t0 = clock.now();
    const runEnd = rec.deadlineAt - XS_ASK_MARGIN_MS;
    const originEnd = origin.dueAt - XS_ASK_MARGIN_MS;
    const waitUntil = Math.min(t0 + deps.timeoutS * 1000, runEnd, originEnd);
    if (waitUntil - t0 < XS_ASK_MARGIN_MS)
      return unavailableNow(originEnd < runEnd ? "origin_window" : "run_window", attempt);
    if (!deps.wakeHopAllowed()) return unavailableNow("level_limit", attempt);
    if ((rec.askUsed ?? 0) >= limit) return unavailableNow("limit", attempt);
    // D8: whole-question budget; render undefined ⇔ too_large — neither consumes the quota.
    const header = xsAskRedirectHeader(attempt, limit, origin.requestId);
    const overhead = [...header].length + [...XS_ASK_REDIRECT_INSTRUCTIONS].length + 4;
    const body = input.render(Math.max(0, deps.maxChars - overhead));
    if (body === undefined) return unavailableNow("too_large", attempt);

    // ---- admission (D4): synchronous reservation BEFORE any await ----
    if (deps.ledger.update(token, { askUsed: attempt }) === undefined) return unavailableNow("limit", attempt);

    return new Promise<AskUserRedirectResult>((resolve) => {
      const call: AskCall = {
        token,
        state: "pending",
        attempt,
        limit,
        startedAt: t0,
        waitUntil,
        requesterSessionId: origin.requesterSessionId,
        originRequestId: origin.requestId,
        text: `${header}\n\n${XS_ASK_REDIRECT_INSTRUCTIONS}\n\n${body}`,
        ctl: new AbortController(),
        sendStarted: false,
        deadlineHit: false,
        ...(input.signal !== undefined ? { toolSignal: input.signal } : {}),
        resolve,
      };
      call.timer = armSpan(waitUntil - t0, () => onDeadline(call));
      if (input.signal !== undefined) {
        if (input.signal.aborted) {
          claim(call, "aborted");
          return;
        }
        call.onToolAbort = () => {
          if (call.state === "pending") claim(call, "aborted");
        };
        input.signal.addEventListener("abort", call.onToolAbort, { once: true });
      }
      let q = queues.get(token);
      if (q === undefined) {
        q = { calls: [] };
        queues.set(token, q);
      }
      q.calls.push(call);
      pump(token);
    });
  };

  // ------------------------------------------------- the host write tap (D3 capture + D6 answer)

  const observeWrite: XsAskRedirect["observeWrite"] = (message) => {
    try {
      if (disposed) return;
      const m = message as {
        customType?: unknown;
        content?: unknown;
        details?: {
          xsWake?: unknown;
          xid?: unknown;
          from?: { sessionId?: unknown };
          wakeToken?: unknown;
          reply?: { requestId?: unknown; dueAt?: unknown } | null;
          inReplyTo?: unknown;
          activateFor?: unknown;
        } | null;
      } | null;
      if (m === null || typeof m !== "object" || m.customType !== "subagent:xs") return;
      const details = m.details;
      if (details === null || typeof details !== "object") return;
      if (details.xsWake === true) {
        // ---- D3 origin capture: a wake dispatch carrying a reply correlation ----
        const token = details.wakeToken;
        if (typeof token !== "string" || details.activateFor !== undefined) return;
        const reply = details.reply;
        if (reply === undefined || reply === null || typeof reply !== "object") return;
        let controller: XsAskRedirectControllerView | undefined;
        try {
          controller = deps.controller();
        } catch {
          controller = undefined;
        }
        const rec = deps.ledger.get(token);
        if (
          controller === undefined ||
          controller.activeToken !== token ||
          rec === undefined ||
          rec.sessionId !== deps.sessionId ||
          rec.xid !== details.xid ||
          rec.state !== "live" ||
          rec.askOrigin !== undefined
        )
          return;
        const fromSid = details.from?.sessionId;
        const requestId = reply.requestId;
        const dueAt = reply.dueAt;
        if (
          typeof fromSid !== "string" ||
          fromSid === "" ||
          typeof requestId !== "string" ||
          !XS_REPLY_REQUEST_ID_RE.test(requestId) ||
          typeof dueAt !== "number" ||
          !Number.isFinite(dueAt)
        )
          return;
        deps.ledger.update(token, { askOrigin: { requesterSessionId: fromSid, requestId, dueAt } });
        return;
      }
      // ---- D6 answer match: an inReplyTo hitting a registered, still-pending q2 ----
      const inReplyTo = details.inReplyTo;
      if (typeof inReplyTo !== "string") return;
      const call = byRequest.get(inReplyTo);
      if (call === undefined || call.state !== "pending") return;
      const fromSid = details.from?.sessionId;
      if (fromSid !== call.requesterSessionId) return;
      call.answerText = typeof m.content === "string" ? m.content : "";
      claim(call, "answered");
    } catch {
      /* observation only — never break the host write exit */
    }
  };

  const dispose: XsAskRedirect["dispose"] = () => {
    if (disposed) return;
    disposed = true;
    for (const q of [...queues.values()]) {
      if (q.inFlight !== undefined && q.inFlight.state === "pending") claim(q.inFlight, "disposed");
      for (const call of [...q.calls]) if (call.state === "pending") claim(call, "disposed");
    }
    queues.clear();
    pairStamp.clear();
    byRequest.clear();
  };

  return { ask, observeWrite, dispose };
}
