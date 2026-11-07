/** #39 session kernel: one append, exact operation-bound authorization, bounded FIFO.
 * Root-approved poison tombstones survive reload via session-poison.ts. P4 must supply a
 * stable identity for in-memory sessions (e.g. host process session UUID retained on reload),
 * never activation incarnation/epoch/leaf. File sessions default to hash(sid + sessionFile).
 * P4 owns recoveryAuthority: issue receipt only AFTER actual runtime resume open completes,
 * inject verify-only recovery port and call verifyRecovery(receipt) against that manager.
 * Reload/tree/off-on MUST NOT issue receipts. No automatic retry/SDK rollback/fsync promise.
 */
import type {
  FoldedSessionItem,
  FoldedSessionMemory,
  MemoryOpCapPort,
  ReservedMemoryOperation,
  MemoryOwner,
  MemorySeedCapture,
  ScopedMemoryWriteResult,
  SessionMemoryPort,
  SessionMemoryView,
  SessionMemoryWrite,
  SessionPersistenceFailure,
  SessionWriteGate,
} from "./types.js";
import { SESSION_MEMORY_ENTRY_TYPE } from "./types.js";
import { foldSessionMemory, foldCacheKey, EMPTY_FOLD } from "./session-fold.js";
import { planSessionOp } from "./session-ops.js";
import { renderSessionSection } from "./render.js";
import { bodyTextDigest, scopedOpDigest, sha256Hex } from "./limits.js";
import {
  freezeSessionOperation,
  sameSessionOperation,
  sameSessionOwner,
  type SessionCommandGrant,
  type SessionCommandGrantPort,
} from "./session-command.js";
import {
  sharedSessionPoisonRegistry,
  type SessionPoisonRegistry,
  type SessionRecoveryPort,
  type SessionRecoveryReceipt,
  type SessionManagerIdentity,
} from "./session-poison.js";

export interface SessionMemoryStoreDeps {
  /** Current owner — compared by reference identity of `incarnation` plus all fields. */
  readonly currentOwner: () => MemoryOwner;
  /** Real-time locked verdict; when true NO branch/disk read happens through this store. */
  readonly isLocked: () => boolean;
  readonly getBranch: () => readonly unknown[];
  /** Leaf id for the fold cache key (arch §6.2 step 2); absent ⇒ no caching. */
  readonly getLeafId?: () => string | undefined;
  readonly getSessionId: () => string | undefined;
  readonly getSessionFile: () => string | undefined;
  /** P4c MUST inject actual ctx.sessionManager, not ctx/object clone/ID. Absent is legacy:
   * writes work but failures have no manager proof and can NEVER recover automatically.
   * Present but missing/throwing/nonobject refuses BEFORE append (no legacy fallback).
   */
  readonly getManager?: () => object | undefined;
  /** The single append seam (SDK appendCustomEntry). THROWS with unknown effect ⇒ E_PERSIST_UNKNOWN + poison. */
  readonly appendCustomEntry: (customType: string, data: unknown) => void;
  readonly sessionWriteGate?: SessionWriteGate;
  /** Capability registry (op-cap.ts); required for user-authority operations. */
  readonly caps?: MemoryOpCapPort;
  readonly now: () => string;
  readonly isChildSession?: boolean;
  /** Disabled stores touch neither global registry nor branch. Prefer absent port when off. */
  readonly enabled?: boolean;
  /** Stable across reload/rebuild/tree; distinct for new/fork. Required for in-memory hosts. */
  readonly stableSessionIdentity?: () => string;
  readonly poisonRegistry?: SessionPoisonRegistry;
  readonly recovery?: SessionRecoveryPort;
  readonly commandGrants?: SessionCommandGrantPort;
  /** Bound for the pending FIFO (default 64 — a bounded queue, never an unbounded backlog). */
  readonly queueLimit?: number;
}

export const SESSION_STORE_QUEUE_LIMIT = 64;
/** Shared host identity codec (no paths/body in the global tombstone). */
export const sessionPoisonIdentity = (stableIdentity: string): string => sha256Hex(stableIdentity);

const sameOwner = sameSessionOwner;

const poisonFailure = (code: "E_PERSIST" | "E_PERSIST_UNKNOWN"): { persistenceFailure: SessionPersistenceFailure } => ({
  persistenceFailure: {
    code,
    poisoned: true,
    recovery: "explicit-reopen-and-verify",
    observedBy: "scoped-writer",
  },
});

export interface SessionMemoryStore extends SessionMemoryPort {
  /** Poison verdict of this store instance (visible via view() too). */
  poisonedNow(): boolean;
  /**
   * Explicit-reopen recovery: consumes a host-private receipt issued AFTER actual reopen,
   * then checks a fresh real branch. A boolean, ordinary reload, or stale receipt cannot clear.
   */
  verifyRecovery(receipt: SessionRecoveryReceipt): boolean;
  enqueueCommand(request: SessionMemoryWrite, grant: SessionCommandGrant): Promise<ScopedMemoryWriteResult>;
}

export function createSessionMemoryStore(deps: SessionMemoryStoreDeps): SessionMemoryStore {
  const queueLimit = deps.queueLimit ?? SESSION_STORE_QUEUE_LIMIT;
  const hasManagerGetter = (): boolean => "getManager" in deps;
  const readManager = (): object | undefined => {
    if (!hasManagerGetter()) return undefined;
    const manager = deps.getManager?.();
    if (typeof manager !== "object" || manager === null) throw new Error("actual session manager unavailable");
    return manager;
  };
  let cache: { key: string; value: FoldedSessionMemory } | undefined;
  const registry = (): SessionPoisonRegistry => deps.poisonRegistry ?? sharedSessionPoisonRegistry();
  const identity = (): string =>
    sessionPoisonIdentity(
      deps.stableSessionIdentity?.() ?? JSON.stringify([deps.getSessionId(), deps.getSessionFile()]),
    );
  const poisonCode = () => {
    if (deps.enabled === false) return undefined;
    const key = identity();
    return localFailure?.identity === key ? localFailure.code : registry().code(key);
  };
  let localFailure: { identity: string; code: "E_PERSIST_UNKNOWN" } | undefined;
  let disposed = false;
  let pending = 0;
  let chain: Promise<unknown> = Promise.resolve();

  const foldUncached = (): FoldedSessionMemory => {
    const branch = deps.getBranch(); // a locked host must never reach here (see fold())
    return foldSessionMemory(branch, deps.getSessionId());
  };

  const fold = (): FoldedSessionMemory => {
    if (deps.enabled === false || deps.isLocked()) return EMPTY_FOLD; // zero branch/disk reads while locked (A10)
    const branch = deps.getBranch();
    const key = foldCacheKey(deps.getLeafId?.(), branch);
    if (cache !== undefined && cache.key === key) return cache.value;
    const value = foldSessionMemory(branch, deps.getSessionId());
    cache = { key, value };
    return value;
  };

  const view = (): SessionMemoryView => ({
    ...fold(),
    persistence: deps.getSessionFile() !== undefined ? "appended" : "memory-only",
    poisoned: poisonCode() !== undefined,
  });

  const snapshot = (): MemorySeedCapture => {
    const state = fold();
    if (state.items.length === 0) return { v: 1, state: "empty" };
    const sid = deps.getSessionId();
    if (sid === undefined) throw new Error("session id required for seed capture");
    const seed = deepFreeze({
      v: 1 as const,
      fromSid: sid,
      frozenAt: deps.now(),
      items: state.items.map((folded) => ({
        ...folded.item,
        ...(folded.item.grant !== undefined ? { grant: { ...folded.item.grant } } : {}),
      })),
      nextN: state.nextN,
    });
    return Object.freeze({ v: 1, state: "captured", seed });
  };

  const enqueue = (
    request: SessionMemoryWrite,
    commandGrant?: SessionCommandGrant,
  ): Promise<ScopedMemoryWriteResult> => {
    const revoke = (): void => {
      try {
        if (cap !== undefined) deps.caps?.revoke(cap);
      } catch {
        /* fail closed */
      }
      try {
        if (commandGrant !== undefined) deps.commandGrants?.revoke(commandGrant);
      } catch {
        /* fail closed */
      }
    };
    const reject = (code: import("./types.js").ScopedMemoryErrorCode): ScopedMemoryWriteResult => {
      revoke();
      return { ok: false, code };
    };
    let cap: SessionMemoryWrite["cap"];
    let signal: AbortSignal | undefined;
    let operation: SessionMemoryWrite["operation"];
    let owner: MemoryOwner;
    try {
      cap = request.cap;
      signal = request.signal;
      if (deps.enabled === false) return Promise.resolve(reject("E_SCOPE_DISABLED"));
      if (disposed) return Promise.resolve(reject("E_STALE_SESSION"));
      const frozen = freezeSessionOperation(request.operation);
      if (frozen === undefined) return Promise.resolve(reject("E_META_INVALID"));
      operation = frozen;
      owner = { ...request.owner };
      if (pending >= queueLimit) return Promise.resolve(reject("E_BUSY"));
    } catch {
      return Promise.resolve(reject("E_META_INVALID"));
    }
    pending++;
    const run = (): ScopedMemoryWriteResult => {
      let attempted = false;
      let writeIdentity: string | undefined;
      let writeManager: object | undefined;
      let writeManagerId: SessionManagerIdentity | undefined;
      let writeRegistry: SessionPoisonRegistry | undefined;
      const unknown = (): ScopedMemoryWriteResult => {
        // Identity was captured before append. Owner changes cannot poison a different session.
        if (writeIdentity !== undefined) {
          try {
            writeRegistry?.mark(writeIdentity, "E_PERSIST_UNKNOWN", writeManagerId);
          } catch {
            localFailure = { identity: writeIdentity, code: "E_PERSIST_UNKNOWN" };
          }
        }
        revoke();
        return { ok: false, code: "E_PERSIST_UNKNOWN", ...poisonFailure("E_PERSIST_UNKNOWN") };
      };
      try {
        if (disposed || !sameOwner(deps.currentOwner(), owner) || signal?.aborted) return reject("E_STALE_SESSION");
        if (deps.isLocked()) return reject("E_WRITE_GATE");
        writeIdentity = identity();
        writeRegistry = registry();
        writeManager = readManager();
        const poisoned =
          localFailure?.identity === writeIdentity ? localFailure.code : writeRegistry.code(writeIdentity);
        if (poisoned !== undefined) {
          revoke();
          return { ok: false, code: poisoned, ...poisonFailure(poisoned) };
        }
        if (hasManagerGetter()) {
          writeManagerId = writeRegistry.captureManager(writeManager!);
          if (writeManagerId === undefined) return reject("E_WRITE_GATE");
        }
        const fresh0 = foldUncached();
        const op = operation;
        const target = op.targetId !== undefined ? findItem(fresh0, op.targetId) : undefined;
        const targetIsUser = target?.item.authority === "user";
        if (deps.isChildSession === true) {
          if (op.authority === "user" || commandGrant !== undefined) return reject("E_CHILD_AUTHORITY");
          if (targetIsUser) return reject("E_AUTHORITY");
        }
        let reserved: ReservedMemoryOperation | undefined;
        const matches = (r: ReservedMemoryOperation | undefined): r is ReservedMemoryOperation => {
          if (r === undefined || !sameOwner(r.binding.owner, owner)) return false;
          const frozen = freezeSessionOperation(r.operation);
          return (
            frozen !== undefined &&
            sameSessionOperation(frozen, op) &&
            r.binding.opDigest === scopedOpDigest(op as unknown as Record<string, unknown>) &&
            r.binding.textDigest === bodyTextDigest(op.text ?? "")
          );
        };
        if (cap !== undefined) {
          reserved = deps.caps?.reserve(cap, owner);
          if (!matches(reserved)) return reject("E_HUB_CAP_STALE");
        }
        if (commandGrant !== undefined && (cap !== undefined || !deps.commandGrants?.check(commandGrant, op, owner)))
          return reject("E_AUTHORITY");
        if ((op.authority === "user" || targetIsUser) && reserved === undefined && commandGrant === undefined)
          return reject("E_AUTHORITY");
        const planned = planSessionOp(
          fresh0,
          owner.sid,
          {
            op: op.op === "delete" ? "del" : "put",
            ...(op.text !== undefined ? { text: op.text } : {}),
            ...(op.targetId !== undefined ? { id: op.targetId } : {}),
            ...(op.expectRev !== undefined ? { expectRev: op.expectRev } : {}),
            authority: op.authority,
            ...(commandGrant !== undefined
              ? { grant: { via: "command" as const } }
              : reserved !== undefined
                ? {
                    grant: {
                      via: "dialog" as const,
                      turn: reserved.binding.humanTurn.id.slice(0, 8),
                      cap: reserved.capId.slice(0, 8),
                      channel: reserved.channel,
                    },
                  }
                : {}),
            ...(op.from !== undefined ? { from: op.from } : {}),
          },
          deps.now,
        );
        if (!planned.ok) return reject(planned.code);
        const sessionFile = deps.getSessionFile();
        // All injected callbacks run BEFORE the final owner/cap check. Exceptions here are
        // provably zero-write; after attempted=true every exception is UNKNOWN + poison.
        const gate = deps.sessionWriteGate?.check({ ...(sessionFile !== undefined ? { sessionFile } : {}) });
        if ((gate !== undefined && !gate.ok) || deps.isLocked()) return reject("E_WRITE_GATE");
        if (
          !sameOwner(deps.currentOwner(), owner) ||
          deps.getSessionId() !== owner.sid ||
          deps.getSessionFile() !== owner.sessionFile ||
          signal?.aborted ||
          disposed ||
          identity() !== writeIdentity
        )
          return reject("E_STALE_SESSION");
        const currentOperation = freezeSessionOperation(request.operation);
        if (currentOperation === undefined || !sameSessionOperation(operation, currentOperation))
          return reject("E_HUB_CAP_STALE");
        if (cap !== undefined) {
          const checked = deps.caps?.check(cap, owner);
          if (
            !matches(checked) ||
            checked.capId !== reserved?.capId ||
            checked.binding.nonce !== reserved.binding.nonce ||
            !deps.caps?.consume(cap)
          )
            return reject("E_HUB_CAP_STALE");
        }
        if (
          commandGrant !== undefined &&
          (!deps.commandGrants?.check(commandGrant, op, owner) || !deps.commandGrants.consume(commandGrant))
        )
          return reject("E_AUTHORITY");
        // Registry callbacks must not make a just-consumed authorization write into a new
        // session/locked owner. Failure here still has a proof of zero append.
        if (
          disposed ||
          signal?.aborted ||
          deps.isLocked() ||
          !sameOwner(deps.currentOwner(), owner) ||
          deps.getSessionId() !== owner.sid ||
          deps.getSessionFile() !== owner.sessionFile
        )
          return reject("E_STALE_SESSION");
        // Final actual-manager gate. The failure handler uses ONLY captured metadata;
        // a switching/throwing getter in append must never poison the new manager instead.
        if (readManager() !== writeManager) return reject("E_WRITE_GATE");
        if (!sameOwner(deps.currentOwner(), owner) || identity() !== writeIdentity) return reject("E_STALE_SESSION");
        // Exactly one real pi.appendEntry (void); never synthesize an entry id.
        attempted = true;
        deps.appendCustomEntry(SESSION_MEMORY_ENTRY_TYPE, planned.entry);
        cache = undefined;
        const branch = deps.getBranch();
        const after = foldSessionMemory(branch, deps.getSessionId());
        const afterTarget = findItem(after, planned.id);
        const deleted =
          planned.entry.op === "del" || (planned.entry.op === "snap" && planned.entry.cause?.op === "del");
        const visible = deleted ? afterTarget === undefined : afterTarget?.rev === planned.rev;
        if (
          !visible ||
          !sameOwner(deps.currentOwner(), owner) ||
          readManager() !== writeManager ||
          identity() !== writeIdentity
        )
          return unknown();
        cache = { key: foldCacheKey(deps.getLeafId?.(), branch), value: after };
        return {
          ok: true,
          id: planned.id,
          ...(planned.rev !== undefined ? { rev: planned.rev } : {}),
          persistence: sessionFile !== undefined ? "appended" : "memory-only",
        };
      } catch {
        return attempted ? unknown() : reject("E_WRITE_GATE");
      } finally {
        pending--;
      }
    };
    const next = chain.then(run, run);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    fold,
    view,
    render: () => {
      const current = view();
      return current.items.length === 0 && current.dropped.length === 0 ? "" : renderSessionSection(current);
    },
    snapshot,
    enqueue,
    dispose(): void {
      disposed = true;
    },
    enqueueCommand: (request, grant) => enqueue(request, grant),
    poisonedNow: () => poisonCode() !== undefined,
    verifyRecovery(receipt): boolean {
      try {
        if (deps.enabled === false || disposed || deps.isLocked() || deps.recovery === undefined || !hasManagerGetter())
          return false;
        const key = identity();
        const actualManager = readManager();
        if (actualManager === undefined) return false;
        const owner = { ...deps.currentOwner() };
        return deps.recovery.verify(receipt, key, actualManager, () => {
          if (disposed || deps.isLocked() || readManager() !== actualManager || !sameOwner(owner, deps.currentOwner()))
            return false;
          const state = foldUncached();
          cache = undefined;
          return (
            !disposed &&
            !deps.isLocked() &&
            state.dropped.length === 0 &&
            identity() === key &&
            readManager() === actualManager &&
            sameOwner(owner, deps.currentOwner()) &&
            deps.getSessionId() === owner.sid &&
            deps.getSessionFile() === owner.sessionFile
          );
        });
      } catch {
        return false;
      }
    },
  };
}

const findItem = (state: FoldedSessionMemory, id: string): FoldedSessionItem | undefined => {
  for (const folded of state.items) if (folded.item.id === id) return folded;
  return undefined;
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>))
      deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}
