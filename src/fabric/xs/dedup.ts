import { systemClock, type Clock } from "../../core/clock.js";
import type { XsEffect, XsWakeDowngraded } from "../../web-hub/protocol/xs.js";

/**
 * fabric phase-2 X4 (phase2-plan §9, review #11, r3 S2): the process-level cross-session dedup
 * table — DEFENSE IN DEPTH, not the at-most-once proof (the proof line is "the protocol has no
 * resend path": the sender sends one `xs_req{send}`, the hub calls `registry.request` once, the
 * receiver dispatches in one synchronous block — §3).
 *
 * Promise scope: within ONE process, any xid is dispatched at most once while unexpired,
 * INCLUDING across `/reload` (the table lives on `Symbol.for("pi-subagent:xs-dedup")`, which
 * jiti reloads preserve). Cross-process needs no persistence: a restarted process cannot
 * receive the old socket's frames and the hub never replays.
 *
 * Entry lifetime: `expiresAt + 1s`, lazily purged on the next admit — NO timers (a ref'd timer
 * wedges `pi -p`; an unref'd one is pure overhead for a table this small). Capacity 256; when
 * full with no purgeable entry the table REFUSES (`none{dedup_full}`) — it never evicts a live
 * entry (r3 S2: the old "6s window < 256" sizing argument is deleted; refusing is the safety
 * property). Pi-free by construction (source-scan gate: `src/fabric/xs/**` must not import pi).
 */

/** Dedup table capacity (§9). Full + nothing purgeable ⇒ refuse, never evict. */
export const XS_DEDUP_CAP = 256;
/** Entries survive their `expiresAt` by this grace before becoming purgeable (§9). */
export const XS_DEDUP_GRACE_MS = 1_000;

/**
 * The receiver's settled verdict for one xid — `XsAckFrame` minus `t`/`rid`/`xid` (X2 adds the
 * wire identity when it builds the ack). Kept here (the lowest-level xs module) so dedup and
 * the receiver share one definition without an import cycle.
 */
export interface XsAckVerdict {
  effect: XsEffect;
  reason?: string;
  wakeDowngraded?: XsWakeDowngraded;
  woke: boolean;
}

/**
 * Replayed for a duplicate whose first pipeline never settled (the only way to hit this is a
 * crash INSIDE the one synchronous block — every ordinary path settles). M2 direction: the
 * previous attempt may have dispatched ⇒ never `none`.
 */
export const XS_DEDUP_UNSETTLED: XsAckVerdict = { effect: "unknown", reason: "receiver_error", woke: false };

interface XsDedupSlot {
  expiresAt: number;
  verdict: XsAckVerdict | undefined;
}

export type XsDedupAdmit =
  | { kind: "fresh" } // reserved — the caller OWES one settle()
  | { kind: "replay"; verdict: XsAckVerdict } // duplicate — replay the FIRST ack verbatim
  | { kind: "full" }; // capacity exhausted with nothing purgeable ⇒ refuse (none{dedup_full})

export class XsDedup {
  private readonly entries = new Map<string, XsDedupSlot>();

  constructor(
    readonly capacity: number = XS_DEDUP_CAP,
    private readonly clock: Clock = systemClock,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("invalid xs dedup capacity");
  }

  get size(): number {
    return this.entries.size;
  }

  /** §8.4 stage 2: reserve BEFORE dispatch (at-most-once). Idempotent settle owed on `fresh`. */
  admit(xid: string, expiresAt: number): XsDedupAdmit {
    this.purge();
    const existing = this.entries.get(xid);
    if (existing !== undefined) return { kind: "replay", verdict: existing.verdict ?? XS_DEDUP_UNSETTLED };
    if (this.entries.size >= this.capacity) return { kind: "full" };
    this.entries.set(xid, { expiresAt, verdict: undefined });
    return { kind: "fresh" };
  }

  /** Store the FIRST verdict for a slot this table reserved; unknown xids are a no-op. */
  settle(xid: string, verdict: XsAckVerdict): void {
    const slot = this.entries.get(xid);
    if (slot === undefined || slot.verdict !== undefined) return;
    slot.verdict = { ...verdict };
  }

  /** Test/diagnostic view; never used by the pipeline. */
  snapshot(): ReadonlyArray<{ xid: string; expiresAt: number; settled: boolean }> {
    return [...this.entries.entries()].map(([xid, slot]) => ({
      xid,
      expiresAt: slot.expiresAt,
      settled: slot.verdict !== undefined,
    }));
  }

  private purge(): void {
    const horizon = this.clock.now() - XS_DEDUP_GRACE_MS;
    for (const [xid, slot] of this.entries) {
      if (slot.expiresAt <= horizon) this.entries.delete(xid);
    }
  }
}

const XS_DEDUP_KEY = Symbol.for("pi-subagent:xs-dedup");

/**
 * Process-global table (survives `/reload` — the whole point, D3). Fresh module imports keep
 * the SAME object; there is deliberately no reset in production.
 */
export function getXsDedup(): XsDedup {
  const globals = globalThis as Record<symbol, XsDedup | undefined>;
  return (globals[XS_DEDUP_KEY] ??= new XsDedup());
}
