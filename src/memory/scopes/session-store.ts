/** #39 session kernel: one append, exact operation-bound authorization, bounded FIFO.
 * Root-approved poison tombstones survive reload via session-poison.ts. P4 must supply a
 * stable identity for in-memory sessions (e.g. host process session UUID retained on reload),
 * never activation incarnation/epoch/leaf. File sessions default to hash(sid + sessionFile).
 * P4 owns recoveryAuthority: issue receipt only AFTER actual runtime resume open completes,
 * inject verify-only recovery port and call verifyRecovery(receipt) against that manager.
 * Reload/tree/off-on MUST NOT issue receipts. No automatic retry/SDK rollback/fsync promise.
 */
import { basename } from "node:path";
import type {
  FoldedSessionItem,
  SessionMemoryEntryV1,
  ScopedMemoryErrorCode,
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
import type {
  CommandConfirmKernel,
  CommandErrorCode,
  CommandPlan,
  MemoryCommandApproval,
  MemoryWebCall,
} from "../command-confirm.js";
import { observeSessionWebFile, SessionWebFileError } from "./session-web-file.js";
import { canonicalJson } from "./limits.js";
import { SESSION_MEMORY_ENTRY_TYPE } from "./types.js";
import { foldSessionMemory, foldCacheKey, EMPTY_FOLD } from "./session-fold.js";
import { planSessionOp } from "./session-ops.js";
import { renderSessionSection } from "./render.js";
import { bodyTextDigest, isMemorySid, scopedOpDigest, sha256Hex, validateSeedCapture } from "./limits.js";
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
  readonly webConfirm?: () => CommandConfirmKernel | undefined;
  readonly monotonicNow?: () => number;
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

export interface SessionWebAddRequest {
  readonly kind: "session.add";
  readonly rawArgs: string;
  readonly text: string;
}
export type SessionWebFailure = {
  readonly ok: false;
  readonly effect: "none" | "unknown";
  readonly code: CommandErrorCode | ScopedMemoryErrorCode | "E_MEM_ARGS" | "E_MEM_FILE_TOO_LARGE" | "E_MEM_PLAN_BUDGET";
  readonly message: string;
  readonly retryable: false;
  readonly recovery?: "explicit-reopen-and-verify";
};
export type SessionWebOutcome =
  | SessionWebFailure
  | {
      readonly ok: true;
      readonly effect: "completed";
      readonly id: string;
      readonly rev?: string;
      readonly persistence: "appended" | "memory-only";
      readonly message: string;
    };
declare const frozenPlanBrand: unique symbol;
export interface FrozenPlan {
  readonly [frozenPlanBrand]: never;
  readonly version: 1;
  readonly kind: "session.add";
  readonly target:
    { readonly kind: "session-file"; readonly path: string } | { readonly kind: "memory-only"; readonly sid: string };
  readonly owner: MemoryOwner;
  readonly frozenAt: string;
  readonly hashDomain: "session-memory-fold/v1";
  readonly oldContentHash: string;
  readonly expectedNewContentHash: string;
  readonly entryHash: string;
  readonly entry: SessionMemoryEntryV1;
  readonly affected: readonly {
    readonly id: string;
    readonly beforeRev: string | null;
    readonly afterRev: string;
    readonly change: "create" | "retained-in-snapshot";
  }[];
  readonly commandPlan: CommandPlan;
}
/** The only Web fold hash: omit derived outer inherited, preserve every stored item field. */
function hashSessionMemoryFoldV1(fold: FoldedSessionMemory): string {
  return sha256Hex(
    canonicalJson({
      items: fold.items.map(({ item, rev }) => ({ item, rev })),
      nextN: fold.nextN,
      opsSinceSnap: fold.opsSinceSnap,
      dropped: fold.dropped,
    }),
  );
}
const webFailure = (code: SessionWebFailure["code"], effect: "none" | "unknown" = "none"): SessionWebFailure => ({
  ok: false,
  effect,
  code,
  message:
    code === "E_MEM_FILE_TOO_LARGE"
      ? "会话文件超过 8MiB，此 Web 写入口不可用；未执行，请使用其它受支持入口。"
      : code === "E_MEM_PLAN_BUDGET"
        ? "计划复核超过协作软预算；本步未执行，请重新发起。"
        : code === "E_MEM_PLAN_CHANGED"
          ? "确认后的计划已变化，本步未执行；请重新发起并确认。"
          : code === "E_PERSIST_UNKNOWN"
            ? "会话写入状态不可确认；请显式重新打开并核验，勿自动重试。"
            : code,
  retryable: false,
  ...(effect === "unknown" || code === "E_PERSIST_UNKNOWN" ? { recovery: "explicit-reopen-and-verify" as const } : {}),
});
class WebBudgetError extends Error {}
class WebStaleError extends Error {}
export type MemoryCancelReason = "abort" | "timeout" | "tree" | "session" | "reload" | "dispose";
export interface SessionMemoryStore extends SessionMemoryPort {
  /** Poison verdict of this store instance (visible via view() too). */
  poisonedNow(): boolean;
  /**
   * Explicit-reopen recovery: consumes a host-private receipt issued AFTER actual reopen,
   * then checks a fresh real branch. A boolean, ordinary reload, or stale receipt cannot clear.
   */
  verifyRecovery(receipt: SessionRecoveryReceipt): boolean;
  enqueueCommand(request: SessionMemoryWrite, grant: SessionCommandGrant): Promise<ScopedMemoryWriteResult>;
  prepareWebAdd(
    call: MemoryWebCall,
    request: SessionWebAddRequest,
  ): Promise<{ ok: true; plan: FrozenPlan } | SessionWebFailure>;
  ownsWebPlan(call: MemoryWebCall, plan: FrozenPlan): boolean;
  enqueueConfirmedCommand(
    call: MemoryWebCall,
    plan: FrozenPlan,
    receipt: MemoryCommandApproval,
  ): Promise<SessionWebOutcome>;
  cancelWeb(call: MemoryWebCall, reason: MemoryCancelReason): SessionWebOutcome;
  releaseWeb(call: MemoryWebCall): void;
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

  const enqueueSync = <T>(run: () => T): Promise<T> => {
    pending++;
    const wrapped = (): T => {
      try {
        return run();
      } finally {
        pending--;
      }
    };
    const next = chain.then(wrapped, wrapped);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const foldUncached = (): FoldedSessionMemory => {
    const branch = deps.getBranch(); // a locked host must never reach here (see fold())
    return foldSessionMemory(branch, deps.getSessionId());
  };

  const fold = (): FoldedSessionMemory => {
    if (deps.enabled === false || deps.isLocked()) return EMPTY_FOLD; // zero branch/disk reads while locked (A10)
    const branch = deps.getBranch();
    const leafId = deps.getLeafId?.();
    const key = foldCacheKey(leafId, branch);
    if (leafId !== undefined && cache !== undefined && cache.key === key) return cache.value;
    const value = foldSessionMemory(branch, deps.getSessionId());
    cache = leafId === undefined ? undefined : { key, value };
    return value;
  };

  const view = (): SessionMemoryView => ({
    ...fold(),
    persistence: deps.getSessionFile() !== undefined ? "appended" : "memory-only",
    poisoned: poisonCode() !== undefined,
  });

  const snapshot = (): MemorySeedCapture => {
    if (deps.enabled === false || deps.isLocked()) return { v: 1, state: "empty" };
    if (disposed) throw new Error("memory session disposed");
    const owner = { ...deps.currentOwner() };
    const manager = readManager();
    const sid = deps.getSessionId();
    const file = deps.getSessionFile();
    if (!isMemorySid(sid) || sid !== owner.sid || file !== owner.sessionFile)
      throw new Error("memory session identity changed");
    // Captures are authority-bearing: always read the real branch, not a leaf/length cache.
    const branch = deps.getBranch();
    if (!Array.isArray(branch)) throw new Error("invalid memory session branch");
    const state = foldSessionMemory(branch, sid);
    if (
      disposed ||
      deps.isLocked() ||
      !sameOwner(owner, deps.currentOwner()) ||
      readManager() !== manager ||
      deps.getSessionId() !== sid ||
      deps.getSessionFile() !== file
    )
      throw new Error("memory session changed during capture");
    if (state.dropped.length !== 0) throw new Error("invalid memory session entries");
    if (state.items.length === 0) return { v: 1, state: "empty" };
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
    const capture = { v: 1 as const, state: "captured" as const, seed };
    const checked = validateSeedCapture(capture);
    if (!checked.ok) throw new Error(`memory seed capture failed: ${checked.reason}`);
    return Object.freeze(capture);
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
      }
    };
    return enqueueSync(run);
  };

  interface WebRecord {
    call: MemoryWebCall;
    plan: FrozenPlan;
    text: string;
    file: string | undefined;
    observation: string | undefined;
    manager: object;
    kernel: CommandConfirmKernel;
    phase: "prepared" | "attempted" | "finished";
    outcome?: SessionWebOutcome;
  }
  const webPlans = new Map<MemoryWebCall, WebRecord>();
  const webCurrent = (call: MemoryWebCall, kernel: CommandConfirmKernel): boolean => {
    const binding = kernel.binding(call);
    return (
      binding !== undefined &&
      !disposed &&
      deps.enabled !== false &&
      deps.isChildSession !== true &&
      !deps.isLocked() &&
      deps.webConfirm?.() === kernel &&
      sameOwner(binding.owner, deps.currentOwner()) &&
      binding.manager === readManager() &&
      deps.getSessionId() === binding.owner.sid &&
      deps.getSessionFile() === binding.owner.sessionFile &&
      kernel.lease(call)?.check() === true
    );
  };
  const makeBudget = (call: MemoryWebCall, kernel: CommandConfirmKernel): (() => void) => {
    const now = deps.monotonicNow ?? (() => performance.now());
    const start = now();
    return () => {
      if (now() - start >= 100) throw new WebBudgetError();
      if (!webCurrent(call, kernel)) throw new WebStaleError();
    };
  };
  const fileObservation = (file: string | undefined, check: () => void): string | undefined => {
    if (file === undefined) return undefined;
    return observeSessionWebFile(file, check);
  };
  const webError = (error: unknown): SessionWebFailure =>
    webFailure(
      error instanceof WebBudgetError
        ? "E_MEM_PLAN_BUDGET"
        : error instanceof WebStaleError
          ? "E_MEM_CONFIRM_STALE"
          : error instanceof SessionWebFileError
            ? error.code
            : "E_WRITE_GATE",
    );
  const webGate = (file: string | undefined): boolean => {
    const gate = deps.sessionWriteGate?.check({ ...(file !== undefined ? { sessionFile: file } : {}) });
    return gate === undefined || gate.ok;
  };
  const prepareWebAdd = (
    call: MemoryWebCall,
    request: SessionWebAddRequest,
  ): Promise<{ ok: true; plan: FrozenPlan } | SessionWebFailure> => {
    let kernel: CommandConfirmKernel | undefined;
    const fail = (code: SessionWebFailure["code"]): Promise<SessionWebFailure> => {
      kernel?.close(call);
      return Promise.resolve(webFailure(code));
    };
    let rawArgs: string;
    let text: string;
    try {
      kernel = deps.webConfirm?.();
      if (!kernel || !kernel.binding(call)) return fail("E_MEM_NEEDS_HUMAN_COMMAND");
      if (webPlans.size || pending >= queueLimit) return fail("E_MEM_BUSY");
      const kind = request.kind;
      rawArgs = request.rawArgs;
      text = request.text;
      if (
        kind !== "session.add" ||
        typeof rawArgs !== "string" ||
        typeof text !== "string" ||
        !text.trim() ||
        rawArgs.trim() !== `session add ${text}`
      )
        return fail("E_MEM_ARGS");
    } catch {
      return fail("E_WRITE_GATE");
    }
    const k = kernel;
    // The request is copied before queueing; the caller cannot swap the approved operation.
    return enqueueSync(() => {
      try {
        const check = makeBudget(call, k);
        check();
        if (webPlans.size) return webFailure("E_MEM_BUSY");
        const binding = k.binding(call);
        if (!binding) return webFailure("E_MEM_NEEDS_HUMAN_COMMAND");
        if (poisonCode() !== undefined) return webFailure("E_PERSIST_UNKNOWN");
        const file = deps.getSessionFile();
        if (!webGate(file)) return webFailure("E_WRITE_GATE");
        check();
        const fresh = foldUncached();
        check();
        if (fresh.dropped.length) return webFailure("E_MEM_PLAN_CHANGED");
        const frozenAt = deps.now();
        check();
        const planned = planSessionOp(
          fresh,
          binding.owner.sid,
          { op: "put", authority: "user", text, grant: { via: "command" } },
          () => frozenAt,
        );
        check();
        if (!planned.ok) return webFailure(planned.code);
        const oldContentHash = hashSessionMemoryFoldV1(fresh);
        const expectedNewContentHash = hashSessionMemoryFoldV1(planned.after);
        const entry = deepFreeze(JSON.parse(JSON.stringify(planned.entry)) as SessionMemoryEntryV1);
        const entryHash = sha256Hex(canonicalJson(entry));
        const affected = deepFreeze(
          (entry.op === "snap" ? planned.after.items : planned.after.items.filter((x) => x.item.id === planned.id)).map(
            (x) => ({
              id: x.item.id,
              beforeRev: fresh.items.find((y) => y.item.id === x.item.id)?.rev ?? null,
              afterRev: x.rev,
              change: x.item.id === planned.id ? ("create" as const) : ("retained-in-snapshot" as const),
            }),
          ),
        );
        const target =
          file !== undefined
            ? { kind: "session-file" as const, path: file }
            : { kind: "memory-only" as const, sid: binding.owner.sid };
        const owner = Object.freeze({ ...binding.owner });
        const manifest = canonicalJson({
          version: 1,
          kind: "session.add",
          target,
          owner: {
            sid: owner.sid,
            sessionFile: owner.sessionFile ?? null,
            sessionEpoch: owner.sessionEpoch,
            branchGen: owner.branchGen,
          },
          frozenAt,
          hashDomain: "session-memory-fold/v1",
          oldContentHash,
          expectedNewContentHash,
          entryHash,
          entry,
          affected,
        });
        const commandPlan: CommandPlan = Object.freeze({
          rawArgs,
          step: 0,
          manifest,
          presentation: `新增 1 条 session 记忆\n${entry.op === "snap" ? "追加完整快照，不删已有项；继承标记可能更新。" : "追加 1 条，不改已有项。"}\n\n要写入的正文（全文）：\n${text}\n\n目标：${file !== undefined ? `当前会话（${basename(file)}）` : "memory-only"}\n权威：user\n影响条目：\n${affected.map((item) => `- ${item.id}（${item.change === "create" ? "新增" : "保留在快照中"}）`).join("\n")}\n\n命令截止时间：${new Date(binding.deadline).toISOString()}\n超时未确认则不执行。\n\n写入后不可回滚。\n文件型目标首次 conversation flush 前可能尚未落盘。`,
        });
        const plan = Object.freeze({
          version: 1 as const,
          kind: "session.add" as const,
          target: Object.freeze(target),
          owner,
          frozenAt,
          hashDomain: "session-memory-fold/v1" as const,
          oldContentHash,
          expectedNewContentHash,
          entryHash,
          entry,
          affected,
          commandPlan,
        }) as unknown as FrozenPlan;
        check();
        const observation = fileObservation(file, check);
        check();
        webPlans.set(call, {
          call,
          plan,
          text,
          file,
          observation,
          manager: binding.manager,
          kernel: k,
          phase: "prepared",
        });
        return { ok: true as const, plan };
      } catch (error) {
        return webError(error);
      }
    }).then((result) => {
      if (!result.ok) k.close(call);
      return result;
    });
  };
  const ownsWebPlan = (call: MemoryWebCall, plan: FrozenPlan): boolean => webPlans.get(call)?.plan === plan;
  const enqueueConfirmedCommand = (
    call: MemoryWebCall,
    plan: FrozenPlan,
    receipt: MemoryCommandApproval,
  ): Promise<SessionWebOutcome> => {
    const record = webPlans.get(call);
    if (!record) {
      try {
        deps.webConfirm?.()?.revoke(receipt);
      } catch {
        /* fail closed */
      }
      return Promise.resolve(webFailure("E_MEM_PLAN_CHANGED"));
    }
    if (record.plan !== plan) {
      record.kernel.revoke(receipt);
      return Promise.resolve(webFailure("E_MEM_PLAN_CHANGED"));
    }
    const { kernel: k } = record;
    const rejectBeforeQueue = (code: SessionWebFailure["code"]): Promise<SessionWebOutcome> => {
      k.revoke(receipt);
      if (record.outcome) return Promise.resolve(record.outcome);
      const outcome = webFailure(code);
      record.phase = "finished";
      record.outcome = outcome;
      return Promise.resolve(outcome);
    };
    if (pending >= queueLimit) return rejectBeforeQueue("E_MEM_BUSY");
    try {
      if (!k.binding(call) || !k.check(call, receipt, plan.commandPlan))
        return rejectBeforeQueue("E_MEM_CONFIRM_STALE");
    } catch {
      return rejectBeforeQueue("E_MEM_CONFIRM_STALE");
    }
    return enqueueSync(() => {
      let attempted = false;
      let writeIdentity: string | undefined;
      let writeRegistry: SessionPoisonRegistry | undefined;
      let writeManagerId: SessionManagerIdentity | undefined;
      const finish = (outcome: SessionWebOutcome): SessionWebOutcome => {
        if (record.outcome) return record.outcome;
        record.phase = "finished";
        record.outcome = outcome;
        return outcome;
      };
      const reject = (code: SessionWebFailure["code"]): SessionWebOutcome => {
        k.revoke(receipt);
        return finish(webFailure(code));
      };
      const unknown = (): SessionWebOutcome => {
        if (writeIdentity !== undefined) {
          try {
            writeRegistry?.mark(writeIdentity, "E_PERSIST_UNKNOWN", writeManagerId);
          } catch {
            localFailure = { identity: writeIdentity, code: "E_PERSIST_UNKNOWN" };
          }
        }
        k.revoke(receipt);
        return finish(webFailure("E_PERSIST_UNKNOWN", "unknown"));
      };
      try {
        if (webPlans.get(call) !== record || record.phase !== "prepared") return reject("E_MEM_CONFIRM_STALE");
        const check = makeBudget(call, k);
        check();
        if (readManager() !== record.manager || !sameOwner(deps.currentOwner(), plan.owner))
          return reject("E_STALE_SESSION");
        writeIdentity = identity();
        writeRegistry = registry();
        if (poisonCode() !== undefined) return reject("E_PERSIST_UNKNOWN");
        writeManagerId = writeRegistry.captureManager(record.manager);
        if (!writeManagerId || !webGate(record.file)) return reject("E_WRITE_GATE");
        check();
        const fresh = foldUncached();
        check();
        if (fresh.dropped.length || hashSessionMemoryFoldV1(fresh) !== plan.oldContentHash)
          return reject("E_MEM_PLAN_CHANGED");
        const replanned = planSessionOp(
          fresh,
          plan.owner.sid,
          { op: "put", authority: "user", text: record.text, grant: { via: "command" } },
          () => plan.frozenAt,
        );
        check();
        if (
          !replanned.ok ||
          sha256Hex(canonicalJson(replanned.entry)) !== plan.entryHash ||
          hashSessionMemoryFoldV1(replanned.after) !== plan.expectedNewContentHash
        )
          return reject("E_MEM_PLAN_CHANGED");
        const observation = fileObservation(record.file, check);
        check();
        if (observation !== record.observation) return reject("E_MEM_PLAN_CHANGED");
        if (!webGate(record.file)) return reject("E_WRITE_GATE");
        check();
        if (!k.check(call, receipt, plan.commandPlan) || !k.consume(call, receipt, plan.commandPlan))
          return reject("E_MEM_CONFIRM_STALE");
        // A hostile/reentrant consume callback cannot carry authority across cancellation.
        if (webPlans.get(call) !== record || record.phase !== "prepared" || !webCurrent(call, k))
          return reject("E_MEM_CONFIRM_STALE");
        attempted = true;
        record.phase = "attempted";
        const returned: unknown = deps.appendCustomEntry(SESSION_MEMORY_ENTRY_TYPE, plan.entry);
        if (
          returned !== null &&
          (typeof returned === "object" || typeof returned === "function") &&
          typeof (returned as { then?: unknown }).then === "function"
        ) {
          // Append has already been attempted; observe any late rejection without awaiting
          // it, but never reinterpret this asynchronous effect as a successful write.
          void Promise.resolve(returned).catch(() => {});
          return unknown();
        }
        cache = undefined;
        const after = foldUncached();
        if (
          hashSessionMemoryFoldV1(after) !== plan.expectedNewContentHash ||
          !sameOwner(deps.currentOwner(), plan.owner) ||
          readManager() !== record.manager ||
          identity() !== writeIdentity
        )
          return unknown();
        const item = after.items.find((x) => x.item.id === replanned.id);
        return finish({
          ok: true,
          effect: "completed",
          id: replanned.id,
          ...(item ? { rev: item.rev } : {}),
          persistence: record.file !== undefined ? "appended" : "memory-only",
          message:
            record.file !== undefined
              ? "已追加到会话内存；首次 conversation flush 前可能尚未落盘。"
              : "已追加到会话内存。",
        });
      } catch (error) {
        if (attempted) return unknown();
        k.revoke(receipt);
        if (error instanceof SessionWebFileError && error.changed) return finish(webFailure("E_MEM_PLAN_CHANGED"));
        return finish(webError(error));
      }
    });
  };
  const cancelWeb = (call: MemoryWebCall, _reason: MemoryCancelReason): SessionWebOutcome => {
    const record = webPlans.get(call);
    if (!record) {
      try {
        deps.webConfirm?.()?.close(call);
      } catch {
        /* fail closed */
      }
      return webFailure("E_MEM_CONFIRM_STALE");
    }
    record.kernel.close(call);
    if (record.outcome) return record.outcome;
    if (record.phase === "attempted") return webFailure("E_PERSIST_UNKNOWN", "unknown");
    record.phase = "finished";
    record.outcome = webFailure("E_MEM_CONFIRM_STALE");
    return record.outcome;
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
      for (const call of webPlans.keys()) cancelWeb(call, "dispose");
    },
    enqueueCommand: (request, grant) => enqueue(request, grant),
    prepareWebAdd,
    ownsWebPlan,
    enqueueConfirmedCommand,
    cancelWeb,
    releaseWeb(call) {
      const record = webPlans.get(call);
      record?.kernel.close(call);
      webPlans.delete(call);
    },
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
