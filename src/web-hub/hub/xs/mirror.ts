/**
 * feishu-xs-mirror P2 (plan §3.2/§4.1): the pi-free observation point on the xs relay for
 * "quiet" deliveries — cross-session messages that landed in a session WITHOUT waking it.
 *
 * The router/broadcast call {@link emitQuiet} only AFTER their own settlement (sender reply,
 * audit, limits) has completed, on a microtask; the observer is advisory (any throw is logged
 * as a bare code and swallowed). Nothing here changes a frame, an audit line or a limit.
 * Absent observer ⇒ the relay code path is byte-identical to before.
 */
import type { HubLog } from "../ports.js";
import { xsToken } from "./members.js";

/** Q2 (user ruling 2026-10-23): a busy session's `unknown{queued}` delivery is mirrored too. */
export const XS_MIRROR_QUEUED = true;

/** Frozen in-process event schema (plan §2.2) — field-for-field the same as P1's `FeishuXsMirrorEvent`. */
export interface XsQuietDelivered {
  sessionId: string;
  agentKey: string;
  xid: string;
  kind: "message" | "broadcast" | "reply";
  from: { ref: string; name?: string; alias?: string };
  channel?: string;
  late?: true;
  queued?: true;
  wakeDowngraded?: string;
  text: string;
}

export type XsQuietObserver = (e: XsQuietDelivered) => void;

/** The slice of an `xs_ack` the verdict reads. */
export interface XsQuietAck {
  effect: string;
  reason?: string | undefined;
  woke?: boolean | undefined;
}

/**
 * §3.2 truth table. `undefined` ⇒ not a quiet delivery (do not mirror); otherwise the labels.
 * `reason` is token-filtered first (a non-token reason is never trusted as a marker).
 */
export function quietVerdict(ack: XsQuietAck): { late: boolean; queued: boolean } | undefined {
  if (ack.woke === true) return undefined; // a turn was opened
  const reason = xsToken(ack.reason);
  if (ack.reason !== undefined && reason === undefined) return undefined;
  if (ack.effect === "applied") {
    if (reason === undefined) return { late: false, queued: false };
    if (reason === "reply_late") return { late: true, queued: false };
    return undefined;
  }
  if (ack.effect === "unknown" && reason === "queued" && XS_MIRROR_QUEUED) return { late: false, queued: true };
  return undefined;
}

/** Defers delivery to the observer by one microtask; never throws; no-op without observer/events. */
export function emitQuiet(
  observer: XsQuietObserver | undefined,
  events: readonly XsQuietDelivered[],
  log: HubLog,
): void {
  if (observer === undefined || events.length === 0) return;
  const batch = events.slice();
  queueMicrotask(() => {
    for (const e of batch) {
      try {
        observer(e);
      } catch {
        try {
          log.warn("xs mirror observer failed", { code: "E_XS_MIRROR" });
        } catch {
          /* logging must never throw out of a microtask */
        }
      }
    }
  });
}
