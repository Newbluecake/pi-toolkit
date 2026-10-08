/**
 * Hold phase machine (web-hub-steer-recall plan §4.3 A2, §5, v4.3 增补 Y1/Y3/Y6/Y7).
 *
 * Three phases only (`idle`/`armed`/`between`, plan C5): `armed` is the only phase a new prompt
 * can be held in; `onContext` arms (fallback: `onAssistantMessageStart`), every hook that
 * dispatches (or declines to) moves to `between` BEFORE any await (I-SYNC).
 *
 * **B1 / I-SERIAL (v4.3 Y1 — overrides the plan body's E1-or-E2 wording)**: at most one item this
 * driver has handed to `dispatchToPi` may be "in flight" (sent but not yet attributed-consumed) at
 * a time. The ONLY thing that clears `inflight` is `onConsumed(cmdId)` — a positive, attributed
 * consumption signal from `commands.ts`'s `message_start` handling (E2). The bounded confirm phase
 * (`onObserved`/`hasPendingMessages()`/macrotask — E1) NO LONGER clears `inflight`; it is retained
 * purely as a display-advancement window (`commands.ts` independently drives the ledger's
 * `dispatched → observed → queued` transition off the same `input`/`message_start` events, whether
 * or not this driver's confirm() is still "awaiting"). There is structurally no way for `onConsumed`
 * to fire for the item THIS hook just sent before the hook itself returns (pi cannot drain its
 * queue until the awaited `turn_end`/`agent_end` handler resolves) — so confirm() never races its
 * own item's consumption, only the (synchronously-reachable) `input` event.
 *
 * Blocked while a run is ending ⇒ `agent_end` returns ALL remaining held items (R-A, Y7.1) rather
 * than ever auto-sending or duplicating. `agent_settled` never dispatches (I-EMPTY / C3).
 *
 * **Y8.1 stale-B1 liveness degrade (verifier r_KRNMK1YR, v4.3 增补 Y8)**: the driver records which
 * "consumption window" each dispatch was handed into — `runSeq` advances at every `agent_end`
 * entry, and a dispatch made BY an agent_end hook records the post-increment value, because an
 * agent_end dispatch is queued after the run's last queue point and can only be consumed by the
 * NEXT run (one full consumption opportunity before it counts as stale). While B1 is blocked AND
 * the inflight item's window has already ended without E2 (e.g. a third-party input handler
 * swallowed the send), `canHold` REFUSES: new web prompts take commands.ts's existing NATIVE
 * delivery path (ledger `dispatched`, not recallable, never visible in `status.held` — worst case
 * equals feature-off behavior) instead of being held only to be `returned{stale}` at every future
 * `agent_end`. B1 itself is NEVER lifted by this degrade — no timer, never a resend of the stale
 * item; E2 for it, a session boundary, or `dispose()` (Y8.3) restores holding. Same-run blocking
 * (Y1/Y7.1: remaining held items returned at that run's `agent_end`) is untouched.
 *
 * T-REF (v4.3 Y3): `setRefTimer` is used ONLY inside the ≤200 ms confirm phase (a bounded, ref'd
 * wait pi is actually awaiting); everything else here is driven externally (onTick is called by
 * the caller's own unref'd 1 Hz timer) — this module creates no unref timers itself.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CmdOrigin } from "../protocol/messages.js";
import { HOLD_MAX_ITEMS, HOLD_MAX_MS, type HoldBuffer, type HoldItem, type RecallOutcome } from "./hold.js";

export const HANDOFF_CONFIRM_MS = 200; // the ONE bounded await per hook
export const HANDOFF_POLL_MS = 2; // hasPendingMessages() poll granularity inside that await
export const HOLD_CAP_GRACE_MS = 15_000; // cap continuously unavailable this long ⇒ tick hands out / returns

export type HoldPhase = "idle" | "armed" | "between";
export type DispatchOutcome = "sent" | "threw" | "refused";

export interface HoldRequest {
  cmdId: string;
  text: string;
  deliver: "steer" | "followUp";
  origin: CmdOrigin;
}

export interface TurnEndLike {
  message?: { content?: unknown };
  outcome?: string;
}

export interface Cancelable {
  cancel(): void;
}

export interface HoldDriverDeps {
  buffer: HoldBuffer;
  owner: string; // MODULE_INSTANCE of the activate() that owns this driver
  getSessionId(): string;
  /** PURE read of the current link: conn live ∧ hello_ack.caps ∋ hold.v1 (index.ts's isLiveWithCap). */
  holdCap(): boolean;
  /** commands.dispatchHeld — synchronous CALL (the enqueue underneath is async). Never touches the
   * buffer, never calls onReturned (D5: the driver is the single owner of markReturned/onReturned). */
  dispatchToPi(item: HoldItem): DispatchOutcome;
  /** ledger → returned{reason}; called ONCE per hook/tick with the failed set. */
  onReturned(items: readonly HoldItem[]): void;
  publish(): void;
  now(): number;
  /** REF'd timer — used ONLY inside the bounded confirm phase (Y3/T-REF). */
  setRefTimer(ms: number, fn: () => void): Cancelable;
  nextMacrotask(): Promise<void>;
}

export interface HoldDriver {
  canHold(req: HoldRequest, ctx: ExtensionContext): boolean;
  hold(req: HoldRequest): boolean;
  recall(target: string): RecallOutcome;
  onContext(ctx: ExtensionContext): void; // → armed (unless signal aborted / abortLatched)
  onAssistantMessageStart(ctx: ExtensionContext): void; // fallback arm from idle/between
  onTurnStart(ctx: ExtensionContext): void; // phase still armed ⇒ turn_end was skipped ⇒ sync pass (steers)
  onTurnEnd(ev: TurnEndLike, ctx: ExtensionContext): Promise<void> | undefined;
  onAgentEnd(ctx: ExtensionContext): Promise<void> | undefined;
  onAgentSettled(ctx: ExtensionContext): void; // NEVER dispatches
  /** commands.onInputEvent matched this cmdId (input layer, E1) — DISPLAY ONLY since Y1; never
   * lifts B1. Safe to call for a cmdId that is not (or no longer) the current inflight item. */
  onObserved(cmdId: string): void;
  /** commands.onMessageStart consumed OUR cmdId via attributed dequeue (E2) — the ONLY lift of B1
   * (Y1). A call for a cmdId that is not the current inflight item is a no-op. */
  onConsumed(cmdId: string): void;
  onWebAbort(): void;
  onSessionStart(ctx: ExtensionContext): void;
  onSessionShutdown(reason: string): void;
  onTick(ctx: ExtensionContext | undefined): void; // HOLD_MAX_MS, cap grace, sweep — never touches phase
  heldCount(): number;
  phase(): HoldPhase;
  /** test/diagnostic surface: the cmdId this driver is currently blocked on, if any (Y6 timer /
   * blocking assertions read this instead of reaching into closures). */
  inflightCmdId(): string | undefined;
  dispose(): void;
}

function firstNonWhitespace(text: string): string | undefined {
  const m = /\S/.exec(text);
  return m === null ? undefined : m[0];
}

export function createHoldDriver(deps: HoldDriverDeps): HoldDriver {
  let phase: HoldPhase = "idle";
  let abortLatched = false;
  let capDownSince: number | undefined;
  let inflight: string | undefined; // cmdId, or undefined ⇔ not blocked (B1 — Y1: ONLY onConsumed clears this)
  /** Y8.1: the consumption window (`runSeq` at dispatch time) the inflight item was handed into. */
  let inflightRun: number | undefined;
  /** Y8.1: advances at every `agent_end` entry — the run whose hooks could still consume a dispatch
   * made during it is over (an agent_end dispatch records the post-increment value: the NEXT run is
   * its first and only consumption opportunity). */
  let runSeq = 0;
  /** cmdId -> resolve, for the confirm phase's `input`-observation race (E1, display-only). */
  const waiters = new Map<string, () => void>();
  let disposed = false;

  function blocked(): boolean {
    return inflight !== undefined;
  }

  /** Y8.1 (verifier r_KRNMK1YR): B1's inflight item belongs to a run whose `agent_end` already
   * passed without E2 — its consumption window is exhausted (e.g. a third-party input handler
   * swallowed the send). Holding a NEW prompt now would only ever end in `returned{stale}` at the
   * next `agent_end` (the liveness bug), so the caller must send it natively instead. This NEVER
   * lifts B1 itself and never resends the stale item. */
  function staleInflight(): boolean {
    return inflight !== undefined && inflightRun !== runSeq;
  }

  function sessionId(): string {
    return deps.getSessionId();
  }

  function resolveWaiter(cmdId: string): void {
    const w = waiters.get(cmdId);
    if (w !== undefined) {
      waiters.delete(cmdId);
      w();
    }
  }

  /** §5.3 P6/P7 fault tolerance: the plan's table marks both callouts as "抓错被吞" — a
   * misbehaving `onReturned`/`publish` (index.ts's own wiring) must never corrupt the buffer state
   * this driver just committed, nor crash the pi event handler calling in. */
  function safeOnReturned(items: readonly HoldItem[]): void {
    if (items.length === 0) return;
    try {
      deps.onReturned(items);
    } catch {
      /* §5.3: "onReturned抓错被吞；台账用30s规则收敛" */
    }
  }
  function safePublish(): void {
    try {
      deps.publish();
    } catch {
      /* fault-tolerance parity with safeOnReturned — a broken republish must never wedge a hook */
    }
  }

  function returnAllHeld(reason: Parameters<HoldBuffer["returnSession"]>[1]): void {
    const items = deps.buffer.returnSession(sessionId(), reason, deps.now());
    safeOnReturned(items);
  }

  /** P1–P7 (§5.3), single synchronous attempt at exactly one item. Sets `inflight` BEFORE calling
   * `dispatchToPi` (Y6.1 — pi's fast path can synchronously fire `input` inside that call). */
  function dispatchOne(item: HoldItem): DispatchOutcome {
    const taken = deps.buffer.takeForHandoff(item.cmdId, deps.now());
    if (taken === undefined) return "refused"; // already recalled concurrently — not an error, just nothing to do
    inflight = taken.cmdId; // registered BEFORE the call (Y6.1)
    inflightRun = runSeq; // Y8.1: the consumption window this dispatch was handed into
    let outcome: DispatchOutcome;
    try {
      outcome = deps.dispatchToPi(taken);
    } catch {
      outcome = "threw";
    }
    if (outcome === "sent") {
      deps.buffer.release(taken.cmdId); // handing → removed (sent); inflight stays set until onConsumed
    } else {
      inflight = undefined; // nothing was actually sent — never blocks on a no-op
      inflightRun = undefined;
      const returned = deps.buffer.markReturned([taken.cmdId], "stale", deps.now());
      if (returned.length > 0) safeOnReturned(returned);
    }
    return outcome;
  }

  function pickCandidate(allowFU: boolean): HoldItem | undefined {
    const held = deps.buffer.held(sessionId());
    const steer = held.find((h) => h.deliver === "steer");
    if (steer !== undefined) return steer;
    if (!allowFU) return undefined;
    return held.find((h) => h.deliver === "followUp");
  }

  /** The bounded ≤200 ms confirm phase (§5.2 `confirm()`). Display-only (Y1): never mutates
   * `inflight`/`blocked()`. Uses `setRefTimer` exclusively (T-REF). */
  /** Defensive wrapper for `ctx.hasPendingMessages()`: once a session is replaced/reloaded pi
   * marks the captured `ExtensionContext` stale and this throws (`ExtensionRunner.assertActive`).
   * The confirm phase only uses this as a best-effort display-timing signal (Y1: it never lifts
   * B1), so a stale ctx is treated exactly like "not pending" — never an unhandled rejection. */
  function hasPendingSafe(ctx: ExtensionContext): boolean {
    try {
      return ctx.hasPendingMessages();
    } catch {
      return false;
    }
  }

  async function confirm(cmdId: string, ctx: ExtensionContext, pendingBefore: boolean): Promise<void> {
    const deadline = deps.now() + HANDOFF_CONFIRM_MS;
    let timedOut = false;
    const observed = new Promise<void>((resolve) => waiters.set(cmdId, resolve));
    let capTimer: Cancelable | undefined;
    const capFired = new Promise<void>((resolve) => {
      capTimer = deps.setRefTimer(HANDOFF_CONFIRM_MS, () => {
        timedOut = true;
        resolve();
      });
    });
    await Promise.race([observed, capFired]);
    waiters.delete(cmdId);
    capTimer?.cancel();
    if (!timedOut && !pendingBefore) {
      while (!hasPendingSafe(ctx) && deps.now() < deadline) {
        await new Promise<void>((r) => deps.setRefTimer(HANDOFF_POLL_MS, r));
      }
      if (!hasPendingSafe(ctx)) timedOut = true;
    }
    if (!timedOut) await deps.nextMacrotask();
  }

  /** §5.2 steps 2-8, shared by turn_end / agent_end. Returns the confirm() promise when (and only
   * when) a send actually happened. */
  function hook(trigger: "turn_end" | "agent_end", ctx: ExtensionContext, allowFU: boolean): Promise<void> | undefined {
    if (blocked()) {
      if (trigger === "agent_end") returnAllHeld("stale"); // R-A / Y7.1: run is ending, never auto-send
      phase = "between";
      safePublish();
      return undefined;
    }
    const pick = pickCandidate(allowFU);
    if (pick === undefined) {
      phase = "between";
      return undefined;
    }
    const pendingBefore = ctx.hasPendingMessages();
    const outcome = dispatchOne(pick);
    phase = "between"; // BEFORE any await (I-SYNC): new arrivals go native
    safePublish();
    if (outcome !== "sent") return undefined;
    return confirm(pick.cmdId, ctx, pendingBefore);
  }

  function tryArm(ctx: ExtensionContext): void {
    if (phase === "armed") return;
    if (ctx.signal?.aborted === true || abortLatched) return;
    phase = "armed";
  }

  return {
    canHold(req, ctx) {
      if (!deps.holdCap()) return false;
      if (phase !== "armed") return false;
      // Y8.1 liveness degrade: B1's inflight item's run already ended without E2 — refuse so the
      // caller delivers this prompt NATIVELY. The stale item is never resent; B1 stays put.
      if (staleInflight()) return false;
      if (ctx.isIdle()) return false;
      if (ctx.signal?.aborted === true) return false;
      if (abortLatched) return false;
      const first = firstNonWhitespace(req.text);
      if (first === "@") return false;
      if (deps.buffer.countHeld(sessionId()) >= HOLD_MAX_ITEMS) return false;
      try {
        if (ctx.sessionManager.getSessionId() !== sessionId()) return false;
      } catch {
        return false;
      }
      return true;
    },
    hold(req) {
      return deps.buffer.hold(
        {
          cmdId: req.cmdId,
          sessionId: sessionId(),
          owner: deps.owner,
          text: req.text,
          deliver: req.deliver,
          origin: req.origin,
          at: deps.now(),
        },
        deps.now(),
      );
    },
    recall(target) {
      return deps.buffer.recall(target, deps.now());
    },
    onContext(ctx) {
      tryArm(ctx);
    },
    onAssistantMessageStart(ctx) {
      tryArm(ctx);
    },
    onTurnStart(ctx) {
      if (phase !== "armed") return;
      // best-effort skip-detect (A-SKIP): the previous request's turn_end never ran.
      if (deps.buffer.countHeld(sessionId()) > 0) {
        // fire-and-forget: onTurnStart returns void by contract; we still run the same dispatch
        // step so a steer isn't stuck an extra turn, but never await its confirm phase here.
        if (!blocked()) {
          const pick = pickCandidate(false);
          if (pick !== undefined) {
            const outcome = dispatchOne(pick);
            if (outcome === "sent") {
              // confirm phase still runs in the background for display purposes; errors are
              // display-only and never surface here.
              void confirm(pick.cmdId, ctx, ctx.hasPendingMessages());
            }
            safePublish();
          }
        }
      }
      phase = "between";
    },
    onTurnEnd(ev, ctx) {
      const aborted = ctx.signal?.aborted === true || ev.outcome === "aborted";
      if (aborted) {
        returnAllHeld("aborted");
        phase = "between";
        return undefined;
      }
      if (deps.buffer.countHeld(sessionId()) === 0) {
        phase = "between";
        return undefined;
      }
      const content = ev.message?.content;
      const hasToolCall = Array.isArray(content) && content.some((c) => (c as { type?: unknown }).type === "toolCall");
      const hasSteerHeld = deps.buffer.held(sessionId()).some((h) => h.deliver === "steer");
      const allowFU = ev.outcome === "completed" && !hasToolCall && !hasSteerHeld && !ctx.hasPendingMessages();
      return hook("turn_end", ctx, allowFU);
    },
    onAgentEnd(ctx) {
      // Y8.1: this run's consumption window is over — dispatches made from here on (by the hook
      // below) record the post-increment value, i.e. the NEXT run, which is their first and only
      // consumption opportunity.
      runSeq += 1;
      const aborted = ctx.signal?.aborted === true;
      if (aborted) {
        returnAllHeld("aborted");
        phase = "between";
        return undefined;
      }
      if (deps.buffer.countHeld(sessionId()) === 0 && !blocked()) {
        phase = "between";
        return undefined;
      }
      return hook("agent_end", ctx, true);
    },
    onAgentSettled(_ctx) {
      // I-EMPTY: by construction the buffer is empty here, except the defensive leftover case
      // (M11/D-LEFTOVER) — never dispatch, only return.
      const held = deps.buffer.held(sessionId());
      if (held.length > 0) {
        const returned = deps.buffer.markReturned(
          held.map((h) => h.cmdId),
          "stale",
          deps.now(),
        );
        if (returned.length > 0) safeOnReturned(returned);
      }
      phase = "idle";
      abortLatched = false;
      // v4.3 Y1 / R-A (verifier r_BHFA552J P0): `inflight` is cleared ONLY by `onConsumed` (E2), a
      // session boundary (`onSessionStart`/`onSessionShutdown`), or `dispose()` — NEVER here and
      // never by a timer. A slow/late `input` chain from THIS run's last send can still resolve
      // (E2) after settle; clearing it unconditionally here would let the NEXT run's first send
      // race ahead of this run's still-unconsumed one (cross-run reorder). If it never resolves,
      // the block carrying into later runs is bounded by Y8.1 (verifier r_KRNMK1YR): once the
      // inflight item's own consumption window has also ended without E2, `canHold` refuses and
      // new prompts take the native path (worst case = feature-off behavior); same-run items keep
      // the Y1/Y7.1 blocking (held → returned at that run's agent_end). No deadlock beyond that.
      safePublish();
    },
    onObserved(cmdId) {
      resolveWaiter(cmdId); // display-only (Y1) — never touches `inflight`.
    },
    onConsumed(cmdId) {
      if (inflight === cmdId) {
        inflight = undefined; // the ONLY lift of B1 (Y1/E2)
        inflightRun = undefined;
      }
      resolveWaiter(cmdId);
    },
    onWebAbort() {
      abortLatched = true;
      returnAllHeld("aborted");
      safePublish();
    },
    onSessionStart(_ctx) {
      const { returned } = deps.buffer.adopt(deps.owner, sessionId(), deps.now());
      if (returned.length > 0) safeOnReturned(returned);
      phase = "idle";
      abortLatched = false;
      capDownSince = undefined;
      inflight = undefined;
      inflightRun = undefined;
      waiters.clear();
      safePublish();
    },
    onSessionShutdown(reason) {
      returnAllHeld(reason === "reload" ? "reload" : "session");
      phase = "idle";
      inflight = undefined;
      inflightRun = undefined;
      waiters.clear();
      safePublish();
    },
    onTick(ctx) {
      // cap-unavailable grace (§5.6 step 1).
      if (!deps.holdCap()) {
        if (capDownSince === undefined) capDownSince = deps.now();
      } else {
        capDownSince = undefined;
      }
      const capGraceExpired =
        capDownSince !== undefined &&
        deps.now() - capDownSince >= HOLD_CAP_GRACE_MS &&
        deps.buffer.countHeld(sessionId()) > 0;

      // max-age (§5.6 step 2).
      const aged = deps.buffer.held(sessionId()).filter((h) => deps.now() - h.at >= HOLD_MAX_MS);

      const toFlush = capGraceExpired ? deps.buffer.held(sessionId()) : aged;

      let sentThisTick = false;
      const returnedSet: HoldItem[] = [];
      for (const item of toFlush) {
        if (ctx === undefined || item.sessionId !== sessionId()) {
          returnedSet.push(...deps.buffer.markReturned([item.cmdId], "stale", deps.now()));
        } else if (ctx.signal?.aborted === true || abortLatched) {
          returnedSet.push(...deps.buffer.markReturned([item.cmdId], "aborted", deps.now()));
        } else if (ctx.isIdle()) {
          returnedSet.push(...deps.buffer.markReturned([item.cmdId], "stale", deps.now()));
        } else if (!blocked() && !sentThisTick) {
          dispatchOne(item); // handles its own return-on-failure bookkeeping
          sentThisTick = true;
        } // else: stays held, retried next tick (I-SERIAL)
      }
      if (returnedSet.length > 0) safeOnReturned(returnedSet);

      // sweep (§5.6 step 3) always runs, independent of flush.
      deps.buffer.sweep(deps.now());

      if (returnedSet.length > 0 || sentThisTick) safePublish();
    },
    heldCount() {
      return deps.buffer.countHeld(sessionId());
    },
    phase() {
      return phase;
    },
    inflightCmdId() {
      return inflight;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Y8.3 (verifier r_KRNMK1YR): dispose clears `inflight` (B1) — a disposed driver must never
      // keep reporting a block (or degrading admission) on an item nobody will ever observe again.
      inflight = undefined;
      inflightRun = undefined;
      waiters.clear();
    },
  };
}
