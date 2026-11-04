/**
 * fabric-xs-activation plan §3 P3 (arch §4.4/§4.5): idempotent activation of an ALREADY-DELIVERED,
 * not-yet-processed cross-session request — the two halves of `wake_session`:
 *
 *  - **receiver half** {@link createXsActivationReceiver}: judges a hub-relayed `xs_activate`
 *    synchronously (arch §4.5 six steps) and, only on admission, asks the SAME RootWakeController
 *    (B1 / ledger / owner / budget) to send the fixed body-free control marker. No await between
 *    the claim and the Controller call; never re-delivers the body, never issues a reply
 *    credential, never starts a second runner.
 *  - **sender half** {@link createXsActivationPort}: the `XsActivationPort` (arch §4.4) the tool
 *    calls — `activate` (one `xs_req{op:"activate"}`) and the strictly read-only `receipt` query.
 *    A miss/unknown/unsupported query NEVER becomes an activate; unknown outcomes only ever
 *    point the model back at the query.
 *
 * pi-free: every collaborator arrives through a port, so the module is unit-testable with fakes.
 * No timers, no module state (I4/I5).
 */
import type { XsResFrame } from "../../web-hub/protocol/xs.js";
import type {
  XsActivateAckFrame,
  XsActivateFrame,
  XsActivateResWire,
  XsActivateStatus,
  XsEvidence,
  XsProgress,
} from "../../web-hub/protocol/xs-activation.js";
import type { XsProgressFields } from "./progress.js";
import type { XsOriginSnapshot } from "./sender.js";

// ----------------------------------------------------------------- receiver half

/** Reasons for which a later retry cannot help (static capability/policy facts). */
const STATIC_REFUSALS: ReadonlySet<string> = new Set([
  "wake_disabled",
  "controller_disabled",
  "host_unsupported",
  "receiver_policy",
]);

/** The claim/evidence surface of the receiver-side progress bag (a `XsProgressBag` subset). */
export interface XsActivationBagPort {
  snapshot(messageId: string): XsProgress | undefined;
  claimView(messageId: string): { state: string } | undefined;
  claimReserve(messageId: string, key: string): { ok: true } | { ok: false; reason: string; notBefore?: number };
  claimDispatch(messageId: string): { ok: boolean };
  claimMarkUnknown(messageId: string): { ok: boolean };
  claimRelease(messageId: string, notBefore?: number): { ok: boolean };
  claimSettle(messageId: string): { ok: boolean };
}

/** The Controller surface used by activation (`RootWakeController` satisfies it). */
export interface XsActivationControllerPort {
  readonly busy: boolean;
  readonly activeMessageId: string | undefined;
  activateExisting(args: {
    messageId: string;
    from: unknown;
    expiresAt: number;
    level?: number;
    onEnded?: (ended: "settled" | "aborted" | "deadline" | "stuck") => void;
  }):
    | { dispatched: false; wakeDowngraded: string }
    | { dispatched: false; effect: "none"; reason: string; woke: false }
    | { dispatched: true; effect: "applied" | "unknown"; woke: true; token: string };
}

export interface XsActivationReceiverDeps {
  sessionId(): string;
  epoch(): number;
  disposed(): boolean;
  now(): number;
  membership: { readonly receive: string; senderAllowed(sessionId: string): boolean };
  fence: { check(): { ok: true } | { ok: false; reason: string; wakeOnly?: true } };
  bag: XsActivationBagPort;
  /** The hub-stamped source session id recorded when the ORIGINAL body was delivered (never
   *  from the activate frame alone); undefined ⇒ not recorded ⇒ fail closed. */
  originOf(messageId: string): string | undefined;
  /** Bounded (≤2000) branch confirmation that the original body entry exists in the CURRENT branch. */
  confirmed(messageId: string): "present" | "absent" | "over_budget";
  /** One bounded queued→delivered confirmation pass (existing flush point). */
  flushBranch(): void;
  /** True while a live/pending ledger record (body wake or earlier control marker) concerns the message. */
  hasLiveWake(messageId: string): boolean;
  controller(): XsActivationControllerPort | undefined;
  /** Evidence write (monotone bag + subscriber push). */
  observe(messageId: string, fields: XsProgressFields): void;
}

export interface XsActivationReceiver {
  /** Synchronous; exactly one ack per frame; never throws. */
  handle(frame: XsActivateFrame): XsActivateAckFrame;
}

type AckExtra = Partial<Omit<XsActivateAckFrame, "t" | "rid" | "messageId" | "activationKey" | "status" | "effect">>;

export function createXsActivationReceiver(deps: XsActivationReceiverDeps): XsActivationReceiver {
  return {
    handle(frame) {
      const ack = (status: XsActivateStatus, effect: XsEvidence, extra: AckExtra = {}): XsActivateAckFrame => {
        let progress: XsProgress | undefined;
        try {
          progress = deps.bag.snapshot(frame.messageId);
        } catch {
          progress = undefined;
        }
        return {
          t: "xs_activate_ack",
          rid: frame.rid,
          messageId: frame.messageId,
          activationKey: frame.activationKey,
          status,
          effect,
          retryable: false,
          ...extra,
          ...(progress !== undefined && extra.progress === undefined ? { progress } : {}),
        };
      };
      const refused = (reason: string, retryable = false, extra: AckExtra = {}): XsActivateAckFrame =>
        ack("refused", "none", { reason, retryable, ...extra });

      let claimed = false;
      try {
        // ---- 1. expiry / target identity ----
        const now = deps.now();
        if (deps.disposed()) return refused("session_changed");
        if (!Number.isFinite(frame.expiresAt) || now >= frame.expiresAt) return refused("expired");
        if (frame.to.sessionId !== deps.sessionId() || frame.to.epoch !== deps.epoch())
          return refused("session_changed");
        // ---- 2. current policy re-validation (receive / allowFrom+block / fence) + source authenticity ----
        if (deps.membership.receive === "off" || !deps.membership.senderAllowed(frame.from.sessionId))
          return refused("receiver_policy");
        const fence = deps.fence.check();
        if (!fence.ok && fence.wakeOnly !== true) return refused(fence.reason);
        const origin = deps.originOf(frame.messageId);
        if (origin === undefined || origin !== frame.from.sessionId) return refused("not_tracked");

        // ---- 3. the original message must exist, be confirmed delivered and be unprocessed ----
        let snap = deps.bag.snapshot(frame.messageId);
        if (snap === undefined) return refused("not_tracked");
        if (snap.phase === "queued") {
          deps.flushBranch();
          snap = deps.bag.snapshot(frame.messageId) ?? snap;
        }
        if (snap.phase === "replied") return ack("already_replied", "none");
        if (snap.phase === "started") return ack("already_started", "none");
        // Fail closed on an observation gap: "not seen started" is not proof of "not processed".
        if (snap.observation !== "live") return refused(snap.observation);
        if (snap.deliveryEffect === "none") return refused("not_delivered");
        if (snap.phase !== "delivered") return refused("not_delivered", snap.phase === "queued");
        const present = deps.confirmed(frame.messageId);
        if (present === "over_budget") return refused("scan_over_budget");
        if (present === "absent") return refused("not_delivered");

        // ---- 4. in-flight / settled control state (no second trigger, ever) ----
        const claim = deps.bag.claimView(frame.messageId);
        if (claim !== undefined && claim.state !== "available") return ack("already_active", "none", { dup: true });
        if (deps.hasLiveWake(frame.messageId)) return ack("already_active", "none");
        const controller = deps.controller();
        if (controller === undefined) return refused("wake_disabled");
        if (controller.busy && controller.activeMessageId === frame.messageId) return ack("already_active", "none");

        // ---- 5. message-level claim BEFORE the Controller/host call; no await below ----
        const reserved = deps.bag.claimReserve(frame.messageId, frame.activationKey);
        if (!reserved.ok) {
          if (reserved.reason === "already_active" || reserved.reason === "already_consumed")
            return ack("already_active", "none", { dup: true });
          if (reserved.reason === "key_mismatch") return refused("stale_key");
          if (reserved.reason === "not_before")
            return refused(
              "not_before",
              true,
              reserved.notBefore !== undefined ? { retryAfterAt: reserved.notBefore } : {},
            );
          return refused(reserved.reason === "expired" ? "expired" : "not_tracked");
        }
        claimed = true;
        const result = controller.activateExisting({
          messageId: frame.messageId,
          from: frame.from,
          expiresAt: frame.expiresAt,
          ...(frame.level !== undefined ? { level: frame.level } : {}),
          onEnded: (ended) => {
            try {
              deps.observe(frame.messageId, { wake: { requested: true, ended } });
            } catch {
              /* observation only */
            }
          },
        });
        if (!result.dispatched) {
          // The Controller proved it had NO effect: release the claim (key stays bound) and say why.
          deps.bag.claimRelease(frame.messageId);
          claimed = false;
          if ("wakeDowngraded" in result) {
            return ack("refused", "none", {
              wakeDowngraded: result.wakeDowngraded,
              retryable: !STATIC_REFUSALS.has(result.wakeDowngraded),
            });
          }
          return refused(result.reason, false);
        }
        // Dispatched: the control action is submitted. The claim is consumed for good (at-most-once).
        deps.bag.claimDispatch(frame.messageId);
        deps.bag.claimSettle(frame.messageId);
        claimed = false;
        try {
          deps.observe(frame.messageId, { wake: { requested: true, decision: "dispatch_accepted" } });
        } catch {
          /* observation only */
        }
        return ack("accepted", result.effect);
      } catch {
        if (claimed) {
          // After the claim an exception may follow a host send: unknown, query-only, consumed.
          try {
            deps.bag.claimMarkUnknown(frame.messageId);
            deps.bag.claimSettle(frame.messageId);
          } catch {
            /* tombstone best effort */
          }
          return ack("unknown", "unknown", { reason: "receiver_error" });
        }
        return refused("receiver_error");
      }
    },
  };
}

// ----------------------------------------------------------------- sender half

/** Result of the bridge's `xs_req{op:"activate"}` round trip. `not_sent` = provably never left. */
export type XsPortActivateReply =
  | { kind: "res"; res: XsResFrame }
  | { kind: "deadline" }
  | { kind: "link_lost" }
  | { kind: "off" }
  | { kind: "not_sent" };

export interface XsActivationHubPort {
  /** Local effective ∧ local wake on ∧ the LIVE hub declared `xs.activate.v1`. */
  activateCapable?(): boolean;
  activate?(args: {
    origin: XsOriginSnapshot;
    to?: string;
    messageId: string;
    activationKey: string;
    level?: number;
  }): Promise<XsPortActivateReply>;
  receipt?(args: {
    messageId: string;
    activationKey?: string;
  }): Promise<{ status: "known" | "unavailable" | "unsupported"; messageId: string; progress?: XsProgress }>;
}

export interface WakeSessionParams {
  /** Model tool requires original target. Web may omit it: hub uses the pinned relation,
   * never a browser-supplied inferred target. */
  to?: string;
  messageId: string;
  activationKey: string;
  action?: "activate" | "query";
}

export interface XsActivateOutcome {
  status: XsActivateStatus;
  effect: XsEvidence;
  messageId: string;
  activationKey: string;
  reason?: string;
  wakeDowngraded?: string;
  retryable: boolean;
  retryAfterAt?: number;
  dup?: true;
  progress?: XsProgress;
}

export interface XsQueryOutcome {
  status: "known" | "unavailable" | "unsupported";
  messageId: string;
  progress?: XsProgress;
}

export interface XsActivationPort {
  activate(args: WakeSessionParams & { signal?: AbortSignal }): Promise<XsActivateOutcome>;
  query(args: { messageId: string; activationKey?: string }): Promise<XsQueryOutcome>;
}

export interface XsActivationPortDeps {
  hub: () => XsActivationHubPort | undefined;
  origin: { current(): XsOriginSnapshot | undefined };
  /** The caller's CURRENT causal level (never the original human's old 0). */
  level?: { levelOfRoot(): number };
}

const CODE_REASON: Record<string, { status: XsActivateStatus; reason: string }> = {
  E_XS_NOT_TRACKED: { status: "refused", reason: "not_tracked" },
  E_XS_STALE_KEY: { status: "refused", reason: "stale_key" },
  E_XS_BAD_TARGET: { status: "refused", reason: "bad_target" },
  E_XS_STALE_ORIGIN: { status: "refused", reason: "stale_origin" },
  E_XS_RATE_LIMITED: { status: "refused", reason: "rate_limited" },
  E_XS_OFF: { status: "unsupported", reason: "off" },
};

export function createXsActivationPort(deps: XsActivationPortDeps): XsActivationPort {
  return {
    async activate(args) {
      const base = { messageId: args.messageId, activationKey: args.activationKey };
      const none = (status: XsActivateStatus, reason: string, retryable = false): XsActivateOutcome => ({
        ...base,
        status,
        effect: "none",
        reason,
        retryable,
      });
      const unknown = (reason: string): XsActivateOutcome => ({
        ...base,
        status: "unknown",
        effect: "unknown",
        reason,
        retryable: false,
      });
      if (args.signal?.aborted) return none("refused", "aborted");
      const hub = deps.hub();
      if (hub === undefined || hub.activate === undefined || hub.activateCapable?.() !== true)
        return none("unsupported", "activation_unavailable");
      const origin = deps.origin.current();
      if (origin === undefined) return none("refused", "origin_changed");
      let level: number | undefined;
      try {
        level = deps.level?.levelOfRoot();
      } catch {
        level = undefined;
      }
      let reply: XsPortActivateReply;
      try {
        reply = await hub.activate({
          origin,
          ...(args.to !== undefined ? { to: args.to } : {}),
          messageId: args.messageId,
          activationKey: args.activationKey,
          ...(level !== undefined ? { level } : {}),
        });
      } catch {
        return unknown("link_lost"); // the frame may have left: never claim `none`
      }
      if (reply.kind === "not_sent") return none("refused", "link_lost", true);
      if (reply.kind === "off") return none("unsupported", "off");
      if (reply.kind === "deadline") return unknown("client_deadline");
      if (reply.kind === "link_lost") return unknown("link_lost");
      const res = reply.res;
      if (!res.ok) {
        const mapped = res.code === undefined ? undefined : CODE_REASON[res.code];
        if (mapped !== undefined) return none(mapped.status, mapped.reason, mapped.reason === "rate_limited");
        if (res.effect === "unknown" || res.effect === undefined) return unknown("hub_error");
        return none("refused", "hub_error");
      }
      const body: XsActivateResWire | undefined = res.activation;
      if (body === undefined) return unknown("no_outcome");
      return {
        ...base,
        status: body.status,
        effect: body.effect,
        retryable: body.retryable,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        ...(body.wakeDowngraded !== undefined ? { wakeDowngraded: body.wakeDowngraded } : {}),
        ...(body.retryAfterAt !== undefined ? { retryAfterAt: body.retryAfterAt } : {}),
        ...(body.dup === true ? { dup: true as const } : {}),
        ...(body.progress !== undefined ? { progress: body.progress } : {}),
      };
    },

    async query(args) {
      const hub = deps.hub();
      if (hub?.receipt === undefined) return { status: "unsupported", messageId: args.messageId };
      try {
        const r = await hub.receipt({
          messageId: args.messageId,
          ...(args.activationKey !== undefined ? { activationKey: args.activationKey } : {}),
        });
        return {
          status: r.status,
          messageId: args.messageId,
          ...(r.progress !== undefined ? { progress: r.progress } : {}),
        };
      } catch {
        return { status: "unavailable", messageId: args.messageId };
      }
    },
  };
}
