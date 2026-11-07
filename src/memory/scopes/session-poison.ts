/** Root-approved I4 exception: bounded content-free tombstones survive ordinary reload.
 * Actual managers are WEAK keys only. Opaque ID objects never contain a manager backref,
 * body, SDK/UI closure or cap. Fresh object identity is nonreusable (no wrapping counter).
 * No TTL/LRU forgiveness. Off callers must not resolve this lazy global port.
 */
import type { SessionPersistenceFailure } from "./types.js";

type PoisonCode = SessionPersistenceFailure["code"];
declare const managerIdentityBrand: unique symbol;
export interface SessionManagerIdentity {
  readonly [managerIdentityBrand]: true;
}
interface Tombstone {
  readonly code: PoisonCode;
  readonly failedManagerId?: SessionManagerIdentity;
}
interface ManagerRecord {
  readonly id: SessionManagerIdentity;
  firstQualifiedRecoveryAttempted: boolean;
}
export const SESSION_POISON_CAPACITY = 256;
export interface SessionPoisonRegistry {
  readonly version: 2;
  readonly diagnostic?: "legacy-shape-fail-closed";
  code(identity: string): PoisonCode | undefined;
  /** Only ACTUAL manager objects; IDs resolved here, never caller strings or ctx clones. */
  captureManager(manager: object): SessionManagerIdentity | undefined;
  mark(identity: string, code: PoisonCode, capturedManagerId?: SessionManagerIdentity): void;
  recoveryAuthority(): SessionRecoveryAuthority;
}
declare const recoveryBrand: unique symbol;
export interface SessionRecoveryReceipt {
  readonly [recoveryBrand]: true;
}
export interface SessionRecoveryPort {
  verify(
    receipt: SessionRecoveryReceipt,
    identity: string,
    actualManager: object,
    verifyBranch: () => boolean,
  ): boolean;
}
export interface SessionRecoveryAuthority extends SessionRecoveryPort {
  /** HOST ONLY, after actual SDK runtime open successfully completed (reason=resume).
   * P4c qualifies real lifecycle provenance, MUST NOT call for reload/tree/fork/startup/new.
   * Manager first-qualified-attempt bookkeeping lives in the shared weak record, not the
   * activation. An absent receipt means no new attempt/recovery is authorized.
   */
  recordReopen(identity: string, reason: "resume", actualManager: object): SessionRecoveryReceipt | undefined;
  dispose(): void;
}
const actualObject = (value: unknown): value is object => typeof value === "object" && value !== null;
export function createSessionPoisonRegistry(): SessionPoisonRegistry {
  const entries = new Map<string, Tombstone>();
  const managers = new WeakMap<object, ManagerRecord>();
  const ids = new WeakSet<SessionManagerIdentity>();
  let overflowed = false;
  const managerRecord = (manager: object): ManagerRecord | undefined => {
    if (!actualObject(manager)) return undefined;
    let record = managers.get(manager);
    if (record === undefined) {
      const id = Object.freeze({}) as SessionManagerIdentity;
      ids.add(id);
      record = { id, firstQualifiedRecoveryAttempted: false };
      managers.set(manager, record);
    }
    return record;
  };
  return {
    version: 2,
    code: (identity) =>
      entries.get(identity)?.code ??
      (overflowed || entries.size >= SESSION_POISON_CAPACITY ? "E_PERSIST_UNKNOWN" : undefined),
    captureManager: (manager) => managerRecord(manager)?.id,
    mark(identity, code, capturedManagerId) {
      // Captured before append by this registry; legacy/foreign metadata stays UNKNOWN,
      // never invented. Mark is one synchronous CAS replacement with code + captured ID.
      const validId = capturedManagerId !== undefined && ids.has(capturedManagerId) ? capturedManagerId : undefined;
      if (entries.has(identity) || entries.size < SESSION_POISON_CAPACITY)
        entries.set(identity, Object.freeze({ code, ...(validId !== undefined ? { failedManagerId: validId } : {}) }));
      else overflowed = true; // No eviction or later forgiveness of an unrecordable failure.
    },
    recoveryAuthority() {
      let disposed = false;
      const receipts = new WeakMap<
        SessionRecoveryReceipt,
        { identity: string; tombstone: Tombstone; managerId: SessionManagerIdentity }
      >();
      return {
        recordReopen(identity, reason, actualManager) {
          if (disposed || reason !== "resume" || !actualObject(actualManager)) return undefined;
          const manager = managerRecord(actualManager);
          if (manager === undefined || manager.firstQualifiedRecoveryAttempted) return undefined;
          manager.firstQualifiedRecoveryAttempted = true; // FIRST qualified attempt, even if it fails
          const tombstone = entries.get(identity);
          if (overflowed || tombstone?.failedManagerId === undefined || tombstone.failedManagerId === manager.id)
            return undefined;
          const receipt = Object.freeze({}) as SessionRecoveryReceipt;
          receipts.set(receipt, { identity, tombstone, managerId: manager.id });
          return receipt;
        },
        verify(receipt, identity, actualManager, verifyBranch) {
          const claim = receipts.get(receipt);
          receipts.delete(receipt); // one use, even on failed verification or disposed authority
          const manager = actualObject(actualManager) ? managers.get(actualManager) : undefined;
          if (
            disposed ||
            overflowed ||
            claim === undefined ||
            claim.identity !== identity ||
            manager?.id !== claim.managerId ||
            entries.get(identity) !== claim.tombstone
          )
            return false;
          try {
            if (!verifyBranch()) return false;
          } catch {
            return false;
          }
          if (disposed || overflowed || entries.get(identity) !== claim.tombstone) return false;
          entries.delete(identity);
          return true;
        },
        dispose() {
          disposed = true;
        },
      };
    },
  };
}
/** Old v1 maps cannot be enumerated safely or acquire genuine failed-manager metadata.
 * Keep their object alive and delegate their code/mark; deny ALL otherwise unknown keys.
 * Even a late v1 authority clearing its map cannot reopen writes through this adapter.
 * No guessed IDs, automatic clear, global reset, or replacement with an empty registry.
 */
function preserveLegacyRegistry(legacy: unknown): SessionPoisonRegistry {
  const previous = legacy as {
    code?: (identity: string) => PoisonCode | undefined;
    mark?: (identity: string, code: PoisonCode) => void;
  };
  return {
    version: 2,
    diagnostic: "legacy-shape-fail-closed",
    code(identity) {
      try {
        return previous?.code?.(identity) ?? "E_PERSIST_UNKNOWN";
      } catch {
        return "E_PERSIST_UNKNOWN";
      }
    },
    captureManager: () => undefined,
    mark(identity, code) {
      try {
        previous?.mark?.(identity, code);
      } catch {
        /* deny all remains sticky */
      }
    },
    recoveryAuthority: () => ({ recordReopen: () => undefined, verify: () => false, dispose: () => {} }),
  };
}
/** Lazy access, SAME Symbol only. Ordinary old-shaped globals preserve poison fail-closed. */
export function sharedSessionPoisonRegistry(): SessionPoisonRegistry {
  const key = Symbol.for("pi-subagent:memory-session-poison");
  const host = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const existing = host[key];
  if (existing === undefined) {
    const registry = createSessionPoisonRegistry();
    host[key] = registry;
    return registry;
  }
  const candidate = existing as Partial<SessionPoisonRegistry> | null;
  if (
    candidate?.version === 2 &&
    typeof candidate.captureManager === "function" &&
    typeof candidate.code === "function" &&
    typeof candidate.mark === "function" &&
    typeof candidate.recoveryAuthority === "function"
  )
    return candidate as SessionPoisonRegistry;
  const preserved = preserveLegacyRegistry(existing);
  host[key] = preserved;
  return preserved;
}
