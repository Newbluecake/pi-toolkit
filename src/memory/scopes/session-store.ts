/**
 * #39 P1 session-memory store: the closure-state `SessionMemoryPort` over a REAL session
 * manager seam (arch §6.2 write protocol). Production wiring (hub registration, tools,
 * spawn seeds) belongs to P2–P4; this factory is the stable seam they consume.
 *
 * Write protocol per operation (K8 — exactly ONE append):
 *  1. admission: queue bound (FIFO), owner check (reference-identity incarnation + sid +
 *     sessionFile + sessionEpoch + branchGen), child/authority rules, poison check;
 *  2. dequeue: FRESH fold of the real `getBranch()` (never the cache) + strict planning
 *     (rev/CAS, product caps, single entry — 32nd op becomes a cause-bearing full snap);
 *  3. LAST-AWAIT RECHECK (synchronous, immediately before the append): owner unchanged,
 *     signal not aborted, cap still reserved (commit gate), session write gate still ok —
 *     then the cap is consumed (one-shot) and the single entry is appended;
 *  4. verify: re-fold the branch and confirm the operation's effect is visible — otherwise
 *     E_PERSIST_UNKNOWN.
 *
 * Poison policy (Root C0 ruling): an E_PERSIST/E_PERSIST_UNKNOWN observed by THIS writer on
 * its own scoped append poisons the store — every later enqueue fails closed with a
 * SessionPersistenceFailure; no retry, no repair, no private SDK rollback, no tail deletion.
 * A plain /reload (new closure over an unverified manager) is NOT recovery: the poison can
 * only clear when the HOST asserts an explicit new/reopen (`isReopened() === true`) AND a
 * fresh real branch folds cleanly. Append success means `appended` (conversation may still
 * be buffered — never fsync); custom-only writes report `memory-only`.
 *
 * Locked: fold/view/render/snapshot return the EMPTY fold without reading the branch when
 * the host reports locked (zero getBranch calls — A10).
 *
 * Pi-free; every piece of state lives in this factory closure (I4); no timers are created
 * (I5 — deadlines are the caller's signal).
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
  /** The single append seam (SDK appendCustomEntry). THROWS on failure ⇒ E_PERSIST + poison. */
  readonly appendCustomEntry: (customType: string, data: unknown) => string;
  readonly sessionWriteGate?: SessionWriteGate;
  /** Capability registry (op-cap.ts); required for user-authority operations. */
  readonly caps?: MemoryOpCapPort;
  readonly now: () => string;
  readonly isChildSession?: boolean;
  /** Host assertion that the session manager was explicitly reopened/new after a poison. */
  readonly isReopened?: () => boolean;
  /** Bound for the pending FIFO (default 64 — a bounded queue, never an unbounded backlog). */
  readonly queueLimit?: number;
}

export const SESSION_STORE_QUEUE_LIMIT = 64;

const sameOwner = (a: MemoryOwner, b: MemoryOwner): boolean =>
  a.incarnation === b.incarnation &&
  a.sid === b.sid &&
  a.sessionEpoch === b.sessionEpoch &&
  a.branchGen === b.branchGen &&
  a.sessionFile === b.sessionFile;

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
   * Explicit-reopen recovery (C0 ruling): clears the poison ONLY when the host asserts
   * `isReopened()` AND a fresh real branch folds without throwing. Returns the new verdict.
   */
  verifyRecovery(): boolean;
}

export function createSessionMemoryStore(deps: SessionMemoryStoreDeps): SessionMemoryStore {
  const queueLimit = deps.queueLimit ?? SESSION_STORE_QUEUE_LIMIT;
  let cache: { key: string; value: FoldedSessionMemory } | undefined;
  let poisoned = false;
  let poisonCode: "E_PERSIST" | "E_PERSIST_UNKNOWN" = "E_PERSIST";
  let disposed = false;
  let pending = 0;
  let chain: Promise<unknown> = Promise.resolve();

  const foldUncached = (): FoldedSessionMemory => {
    const branch = deps.getBranch(); // a locked host must never reach here (see fold())
    return foldSessionMemory(branch, deps.getSessionId());
  };

  const fold = (): FoldedSessionMemory => {
    if (deps.isLocked()) return EMPTY_FOLD; // zero branch/disk reads while locked (A10)
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
    poisoned,
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

  const enqueue = (request: SessionMemoryWrite): Promise<ScopedMemoryWriteResult> => {
    if (disposed) return Promise.resolve({ ok: false, code: "E_STALE_SESSION" });
    if (poisoned) return Promise.resolve({ ok: false, code: poisonCode, ...poisonFailure(poisonCode) });
    if (pending >= queueLimit) return Promise.resolve({ ok: false, code: "E_BUSY" });
    pending++;
    const run = (): ScopedMemoryWriteResult => {
      try {
        return perform(request);
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

  const perform = (request: SessionMemoryWrite): ScopedMemoryWriteResult => {
    // — admission (dequeue-time) —
    if (disposed) return { ok: false, code: "E_STALE_SESSION" };
    if (poisoned) return { ok: false, code: poisonCode, ...poisonFailure(poisonCode) };
    const owner = deps.currentOwner();
    if (!sameOwner(owner, request.owner)) return { ok: false, code: "E_STALE_SESSION" };
    if (request.signal?.aborted) return { ok: false, code: "E_STALE_SESSION" };
    const op = request.operation;
    if (op.storageScope !== "session") return { ok: false, code: "E_SCOPE_DISABLED" };
    if (deps.isLocked()) return { ok: false, code: "E_WRITE_GATE" };

    // — authority / child rules (arch §5.3) —
    const fresh0 = foldUncached(); // fresh state, never the cache, for target lookup
    const target = op.targetId !== undefined ? findItem(fresh0, op.targetId) : undefined;
    const targetIsUser = target !== undefined && target.item.authority === "user";
    if (deps.isChildSession === true) {
      if (op.authority === "user") return { ok: false, code: "E_CHILD_AUTHORITY" };
      if (targetIsUser) return { ok: false, code: "E_AUTHORITY" }; // inherited user entries included
    }
    const needsCap = op.authority === "user" || targetIsUser;
    const cap = request.cap;
    let reserved: ReservedMemoryOperation | undefined;
    if (cap !== undefined) {
      const fromRegistry = deps.caps?.reserve(cap, owner);
      if (fromRegistry === undefined) return { ok: false, code: "E_HUB_CAP_STALE" };
      reserved = fromRegistry;
    }
    if (needsCap && reserved === undefined) return { ok: false, code: "E_AUTHORITY" };

    // — strict planning against the FRESH state —
    const planned = planSessionOp(
      fresh0,
      owner.sid,
      {
        op: op.op === "delete" ? "del" : "put",
        ...(op.text !== undefined ? { text: op.text } : {}),
        ...(op.targetId !== undefined ? { id: op.targetId } : {}),
        ...(op.expectRev !== undefined ? { expectRev: op.expectRev } : {}),
        authority: op.authority,
        // The persisted grant is derived from the CAP (never from model arguments).
        ...(reserved !== undefined
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
    if (!planned.ok) {
      if (cap !== undefined) deps.caps?.revoke(cap);
      return { ok: false, code: planned.code };
    }

    // — LAST-AWAIT RECHECK + COMMIT GATE (synchronous, immediately before the append) —
    const ownerNow = deps.currentOwner();
    if (disposed || !sameOwner(ownerNow, owner)) {
      if (cap !== undefined) deps.caps?.revoke(cap);
      return { ok: false, code: "E_STALE_SESSION" };
    }
    if (request.signal?.aborted) {
      if (cap !== undefined) deps.caps?.revoke(cap);
      return { ok: false, code: "E_STALE_SESSION" };
    }
    const sessionFile = deps.getSessionFile();
    const gate = deps.sessionWriteGate?.check({ ...(sessionFile !== undefined ? { sessionFile } : {}) });
    if (gate !== undefined && !gate.ok) {
      if (cap !== undefined) deps.caps?.revoke(cap);
      return { ok: false, code: "E_WRITE_GATE" };
    }
    if (cap !== undefined && reserved !== undefined && deps.caps !== undefined) {
      if (deps.caps.check(cap, ownerNow) === undefined) return { ok: false, code: "E_HUB_CAP_STALE" };
      if (!deps.caps.consume(cap)) return { ok: false, code: "E_HUB_CAP_STALE" };
    }

    // — the ONE append —
    try {
      deps.appendCustomEntry(SESSION_MEMORY_ENTRY_TYPE, planned.entry);
    } catch {
      poison("E_PERSIST");
      if (cap !== undefined) deps.caps?.revoke(cap);
      return { ok: false, code: "E_PERSIST", ...poisonFailure("E_PERSIST") };
    }
    cache = undefined; // the branch grew: the cache key is stale by construction

    // — effect verification —
    const after = foldSessionMemory(deps.getBranch(), deps.getSessionId());
    const afterTarget = findItem(after, planned.id);
    const visible =
      planned.entry.op === "del"
        ? afterTarget === undefined
        : afterTarget !== undefined && afterTarget.rev === planned.rev;
    if (!visible) {
      poison("E_PERSIST_UNKNOWN");
      return { ok: false, code: "E_PERSIST_UNKNOWN", ...poisonFailure("E_PERSIST_UNKNOWN") };
    }
    cache = { key: foldCacheKey(deps.getLeafId?.(), deps.getBranch()), value: after };
    return {
      ok: true,
      id: planned.id,
      ...(planned.rev !== undefined ? { rev: planned.rev } : {}),
      persistence: sessionFile !== undefined ? "appended" : "memory-only",
    };
  };

  const poison = (code: "E_PERSIST" | "E_PERSIST_UNKNOWN"): void => {
    poisoned = true;
    poisonCode = code;
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
    poisonedNow: () => poisoned,
    verifyRecovery(): boolean {
      if (!poisoned) return true;
      if (deps.isReopened?.() !== true) return false; // plain reload is NOT recovery (C0)
      try {
        foldUncached(); // a fresh REAL branch must fold without throwing
      } catch {
        return false;
      }
      poisoned = false;
      return true;
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
