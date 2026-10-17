/**
 * Auth revocation bus (web-hub-proxy plan v2 §4.2, package XA). A tiny synchronous, typed
 * fan-out: every place that used to call `previewRoutes.revokeHtmlCaps(sel, reason)` directly now
 * `emit({ sel, reason })` at the SAME position and in the SAME order; consumers (HTML preview —
 * always; the proxy service — later, only when wired) subscribe.
 *
 * - `emit` is synchronous: subscribers run in subscription order before `emit` returns, so
 *   "revoked before the awaited delete" ordering is preserved exactly (§R1 #6).
 * - Each subscriber runs in its own `try/catch`: a throwing subscriber is logged (never the
 *   selector payload's secrets — only the reason + error text) and the rest still run.
 * - Subscribe/unsubscribe during an `emit` is safe (the subscriber list is snapshotted).
 * - Eventual-revocation semantics (§R2 #6): the bus guarantees ordering + isolation, NOT that no
 *   mint can slip into an await window; the double emit around an awaited session delete (LAN
 *   logout) is what makes anything minted in that window die at the second emit.
 *
 * Pure: no timers, no I/O, no module state (one instance per `createHttpFrontend`).
 */
import type { HubLog } from "./ports.js";

/** Same shape as the preview store's selector (`PvRevokeSelector`): a session tag, a LAN user id,
 * a whole listener, or everything. */
export type AuthRevokeSelector =
  { readonly sidTag: string } | { readonly userId: number } | { readonly listener: "loopback" | "lan" } | "all";

export type AuthRevokeReason = "logout" | "passwd" | "rotate" | "close";

export interface AuthRevokeEvent {
  readonly sel: AuthRevokeSelector;
  readonly reason: AuthRevokeReason;
}

export interface AuthRevokeBus {
  /** Returns an idempotent unsubscribe. */
  subscribe(fn: (ev: AuthRevokeEvent) => void): () => void;
  emit(ev: AuthRevokeEvent): void;
}

export function createAuthRevokeBus(log: Pick<HubLog, "error">): AuthRevokeBus {
  const subs: Array<(ev: AuthRevokeEvent) => void> = [];
  return {
    subscribe(fn) {
      subs.push(fn);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const i = subs.indexOf(fn);
        if (i >= 0) subs.splice(i, 1);
      };
    },
    emit(ev) {
      for (const fn of [...subs]) {
        try {
          fn(ev);
        } catch (err) {
          log.error("web-hub auth-revoke: subscriber threw", { reason: ev.reason, error: String(err) });
        }
      }
    },
  };
}
