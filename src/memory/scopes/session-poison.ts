/** Root-approved I4 exception: bounded, content-free tombstones survive ordinary reload.
 * No TTL/LRU forgiveness. Identity is host-stable (NOT activation incarnation). No caps,
 * UI objects or SDK closures enter the global map. Off callers must not resolve this port.
 */
import type { SessionPersistenceFailure } from "./types.js";

type PoisonCode = SessionPersistenceFailure["code"];
interface Tombstone {
  readonly code: PoisonCode;
}
export const SESSION_POISON_CAPACITY = 256;
export interface SessionPoisonRegistry {
  code(identity: string): PoisonCode | undefined;
  mark(identity: string, code: PoisonCode): void;
  recoveryAuthority(): SessionRecoveryAuthority;
}
declare const recoveryBrand: unique symbol;
export interface SessionRecoveryReceipt {
  readonly [recoveryBrand]: true;
}
export interface SessionRecoveryPort {
  verify(receipt: SessionRecoveryReceipt, identity: string, verifyBranch: () => boolean): boolean;
}
export interface SessionRecoveryAuthority extends SessionRecoveryPort {
  /** HOST ONLY: call after an actual SDK reopen/new completion, never on reload/tree.
   * P4 owns this authority; pass only its verify port to the store. Issue AFTER reopen,
   * then immediately verify against that manager's real branch. No model boolean input.
   */
  recordReopen(identity: string, kind: "reopen" | "new"): SessionRecoveryReceipt;
}
export function createSessionPoisonRegistry(): SessionPoisonRegistry {
  const entries = new Map<string, Tombstone>();
  let overflowed = false;
  return {
    code: (identity) =>
      entries.get(identity)?.code ??
      (overflowed || entries.size >= SESSION_POISON_CAPACITY ? "E_PERSIST_UNKNOWN" : undefined),
    mark(identity, code) {
      if (entries.has(identity) || entries.size < SESSION_POISON_CAPACITY)
        entries.set(identity, Object.freeze({ code }));
      else overflowed = true; // Sticky fail-closed: an unrecordable failure cannot be forgiven
      // by freeing another slot. Normal (non-overflowed) full tables allow explicit recovery.
      // An unrecordable failure is covered by saturation: ALL untracked identities deny.
    },
    recoveryAuthority() {
      const receipts = new WeakMap<SessionRecoveryReceipt, { identity: string; tombstone: Tombstone | undefined }>();
      return {
        recordReopen(identity, kind) {
          if (kind !== "reopen" && kind !== "new") throw new Error("explicit session reopen required");
          const receipt = Object.freeze({}) as SessionRecoveryReceipt;
          receipts.set(receipt, { identity, tombstone: entries.get(identity) });
          return receipt;
        },
        verify(receipt, identity, verifyBranch) {
          const claim = receipts.get(receipt);
          receipts.delete(receipt); // one use even on verification failure
          if (
            overflowed ||
            claim === undefined ||
            claim.identity !== identity ||
            claim.tombstone === undefined ||
            entries.get(identity) !== claim.tombstone
          )
            return false;
          try {
            if (!verifyBranch()) return false;
          } catch {
            return false;
          }
          // Verify may reenter and mark a new failure: never clear a newer tombstone.
          if (overflowed || entries.get(identity) !== claim.tombstone) return false;
          entries.delete(identity);
          return true;
        },
      };
    },
  };
}
/** Lazy access: importing this module and constructing a disabled store touch no global. */
export function sharedSessionPoisonRegistry(): SessionPoisonRegistry {
  const key = Symbol.for("pi-subagent:memory-session-poison");
  const host = globalThis as typeof globalThis & { [key: symbol]: SessionPoisonRegistry | undefined };
  return host[key] ?? (host[key] = createSessionPoisonRegistry());
}
