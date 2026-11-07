/**
 * Hold wiring (source-governance batch2 ⑨-H1; web-hub-steer-recall plan §4.7 A6).
 *
 * Pure extraction out of `index.ts`'s `wireWebHub` closure: the `holdOn` gate + buffer + cap
 * probes, the `status.held` projection, the `createHoldDriver` assembly, and the driver's own
 * five event-handler registrations. Every body is verbatim; the closure-captured `conn` /
 * `attached` / `ctx` became explicit call-time getters (plus an `adoptCtx` write-back for the
 * handler guard's `ctx = c` adoption), so reconnect/detach/session-switch semantics are
 * unchanged. No module-scope mutable state (I4); the driver's `setRefTimer` stays REF'd exactly
 * as before (v4.3 Y3 / T-REF — the ≤200 ms bounded confirm phase pi is actually awaiting).
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HeldItemWire } from "../protocol/messages.js";
import { HOLD_CAP } from "../protocol/version.js";
import type { HubConnection } from "./connection.js";
import { createHoldBuffer, holdWired, type HoldBuffer, type HoldItem } from "./hold.js";
import { createHoldDriver, type DispatchOutcome, type HoldDriver, type TurnEndLike } from "./hold-driver.js";
import type { CommandLedger } from "./ledger.js";

export interface HoldGatesDeps {
  /** The two `WebHubSettings` flags `holdWired` reads (structural). */
  settings: { control?: boolean; steerRecall?: boolean };
  /** Late-bound read of the current link (the pre-extraction closure's captured `conn`). */
  conn(): HubConnection | undefined;
  /** `safe(() => ctx?.sessionManager.getSessionId() ?? "", "")` — never throws. */
  getSessionId(): string;
  now(): number;
  /** MODULE_INSTANCE of this activation. */
  epoch: string;
}

export interface HoldGates {
  holdOn: boolean;
  holdBuffer: HoldBuffer;
  holdCap(): boolean;
  capKnownAbsent(): boolean;
  /** §4.7 step 10 (A6): the `status.held` slot getter — `undefined` iff `holdOn` is false. */
  heldStatus: (() => { items: HeldItemWire[]; rev: number; epoch: string }) | undefined;
}

export function createHoldGates(args: HoldGatesDeps): HoldGates {
  const { settings, conn, getSessionId, now, epoch } = args;
  // ── web-hub-steer-recall plan §4.7 (A6): hold wiring ──────────────────────────────────────
  // `holdOn` is the ONE gate (plan §8.1): it decides cap advertisement, handler registration and
  // the `status.held` projection together. `false` (⇐ `steerRecall:false` or `control:false`)
  // ⇒ no driver, no hold handlers, no cap, no held rows — the agent is byte-identical to the
  // pre-feature agent on the wire (W1/W2). The buffer is the process-level `Symbol.for` bag
  // (plain data, survives /reload — P-core's `hold.ts`); creating it here even when off is
  // allocation-only and invisible on the wire.
  const holdOn = holdWired(settings);
  const holdBuffer = createHoldBuffer();
  /** PURE read of the current link (plan C1 / §4.7 step 2): same shape as `isLiveWithCap` — read
   *  at hold-decision time and at every tick, never cached, never bound to a link generation. */
  const holdCap = (): boolean => conn()?.status().state === "live" && (conn()?.caps.includes(HOLD_CAP) ?? false);
  /** `true` ⇔ the link is live AND the hub demonstrably lacks `hold.v1` — the ONLY case where
   *  the ctl projection filters the hold vocabulary (§4.7 step 11): a hub without the cap has a
   *  CLOSED CtlItemSchema that would drop the whole frame on a `state:"held"` row. While
   *  disconnected nothing is filtered — the slot keeps the full projection and replays
   *  correctly to whatever hub comes next (D3). */
  const capKnownAbsent = (): boolean =>
    holdOn && conn()?.status().state === "live" && !(conn()?.caps.includes(HOLD_CAP) ?? false);
  // §4.7 step 10 (A6): held rows ride the OPEN status slot — gated ONLY on holdWired, never
  // on holdCap() (D3): a disconnect keeps the full projection in the slot, and an old hub's
  // open StatusInfoSchema ignores the unknown fields instead of dropping the frame.
  const heldStatus = holdOn
    ? () => {
        const sid = getSessionId();
        return { items: holdBuffer.project(sid, now()), rev: holdBuffer.rev(), epoch };
      }
    : undefined;
  return { holdOn, holdBuffer, holdCap, capKnownAbsent, heldStatus };
}

/** Never-throw wrapper — same isolation as index.ts's local `safe(fn, undefined)` on a void call. */
function swallow(fn: () => void): void {
  try {
    fn();
  } catch {
    /* a stale ctx must never take the publish path down */
  }
}

export interface HoldDriverWireDeps {
  holdOn: boolean;
  buffer: HoldBuffer;
  /** MODULE_INSTANCE of this activation (Y4/Y7.3 owner scoping). */
  owner: string;
  getSessionId(): string;
  holdCap(): boolean;
  ledger: CommandLedger;
  /** `commandHandler.dispatchHeld` — looked up lazily at call time (no TDZ cycle). */
  dispatchToPi(item: HoldItem): DispatchOutcome;
  publishStatus(): void;
  publishCtl(): void;
  refreshStatusLine(): void;
  now(): number;
}

/** §4.7 step 4 (A6): the hold driver — `undefined` while `holdWired(settings)` is false (no
 *  handlers registered below, no cap advertised, prompts take the native path unconditionally).
 *  `setRefTimer` is REF'd (v4.3 Y3 / T-REF): the driver uses it exclusively inside its ≤200 ms
 *  bounded confirm phase — a wait pi is actually awaiting — while every other timer this wiring
 *  owns (commands' 30s/3s display timers, the 1Hz tick) stays unref'd so `pi -p` never wedges. */
export function wireHoldDriver(args: HoldDriverWireDeps): HoldDriver | undefined {
  const { holdOn, buffer, owner, getSessionId, holdCap, ledger, dispatchToPi, now } = args;
  return holdOn
    ? createHoldDriver({
        buffer,
        owner,
        getSessionId,
        holdCap,
        dispatchToPi,
        onReturned: (items) => {
          for (const it of items) {
            ledger.updatePrompt(
              it.cmdId,
              { promptState: "returned", ...(it.reason !== undefined ? { reason: it.reason } : {}) },
              now(),
            );
          }
        },
        publish: () => {
          // same never-throw isolation as onChanged (stale ctx after a real session switch)
          swallow(() => args.publishStatus());
          swallow(() => args.publishCtl());
          swallow(() => args.refreshStatusLine());
        },
        now,
        setRefTimer: (ms, fn) => {
          const t = setTimeout(fn, ms);
          return { cancel: () => clearTimeout(t) };
        },
        nextMacrotask: () => new Promise<void>((r) => setImmediate(r)),
      })
    : undefined;
}

export interface HoldHandlerDeps {
  /** pi.on rebound to a string event name (index.ts's local `on`). */
  on(event: string, handler: (event: unknown, ctx: ExtensionContext | undefined) => unknown): void;
  driver: HoldDriver;
  isAttached(): boolean;
  getCtx(): ExtensionContext | undefined;
  /** The guard's `ctx = c` write-back into the wiring closure. */
  adoptCtx(c: ExtensionContext): void;
}

/** web-hub-steer-recall §4.7 step 5 (A6): the hold driver's OWN handlers, registered exactly
 *  once per activate() — the caller (`wireWebHub`) is their single owner (W5: /new・/resume・/fork
 *  re-enter session_start inside the same activation and re-register nothing). They sit AFTER
 *  the FORWARDED loop so the tap/publish bookkeeping for the same event runs first; the
 *  `turn_end`/`agent_end` handlers may return a Promise (pi awaits them — the bounded confirm
 *  phase) and NEVER return `entries`/`continue` (the loop's own turn_end handler owns those
 *  semantics). Every handler detaches on its first line while not attached (child sessions,
 *  print mode). Called ONLY while `holdOn` (W1: zero new handlers with steerRecall off). */
export function registerHoldHandlers(args: HoldHandlerDeps): void {
  const { on, driver: drv, isAttached, getCtx, adoptCtx } = args;
  // Plan §4.7 step 5's handler preamble, verbatim order: detach FIRST, then adopt the event's
  // ctx — an unattached event (child session / post-shutdown) writes nothing at all.
  const guard = (c: ExtensionContext | undefined): ExtensionContext | undefined => {
    if (!isAttached()) return undefined;
    if (c !== undefined) adoptCtx(c);
    return getCtx();
  };
  on("context", (_event, c) => {
    const x = guard(c);
    if (x === undefined) return undefined;
    drv.onContext(x); // ARM (P-core §5.1): the only phase a new prompt can be held in
    return undefined;
  });
  on("turn_start", (_event, c) => {
    const x = guard(c);
    if (x === undefined) return undefined;
    drv.onTurnStart(x); // best-effort skip-detect (C4/A-SKIP): phase still armed ⇒ last turn_end never ran
    return undefined;
  });
  on("turn_end", (event, c) => {
    const x = guard(c);
    if (x === undefined) return undefined;
    return drv.onTurnEnd(event as TurnEndLike, x); // Promise ⇔ exactly one item was handed to pi
  });
  on("agent_end", (_event, c) => {
    const x = guard(c);
    if (x === undefined) return undefined;
    return drv.onAgentEnd(x); // run ending: B1-blocked leftovers return to the browser (R-A)
  });
  on("agent_settled", (_event, c) => {
    const x = guard(c);
    if (x === undefined) return undefined;
    drv.onAgentSettled(x); // NEVER dispatches (I-EMPTY / C3); defensive leftovers ⇒ returned{stale}
    return undefined;
  });
}
