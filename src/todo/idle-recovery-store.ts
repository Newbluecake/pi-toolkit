/**
 * Task59 Stage B (B1) — bounded TODO idle recovery: the persistence/effect seam.
 *
 * B1 delivers the stable API that the B2 runner consumes, and NOTHING else: no send, no abort,
 * no timer, no hook registration, no settings read, no host busy probe. `prepare` → `reserve`
 * → `commit` mirror the plan's attempt-before-send protocol:
 *
 *  1. `prepare({todo})` — re-read the log, select candidates, gate the window budget. Pure
 *     evaluation: nothing is written and no turn is started.
 *  2. `reserve(plan)` — re-read the log, re-check EVERY gate (a reentrant settle cannot slip a
 *     second send through), then append the attempt entry BEFORE the caller sends. An append
 *     failure denies the send; the budget is still consumed in memory (no refund, no retry).
 *  3. `commit(reservation, outcome)` — append the terminal outcome (`sent` | `failed` |
 *     `unknown`). Accounting is already paid, so a failure/unknown outcome never refunds.
 *
 * Persistence contract (plan §4, and why production cannot activate on B1 alone):
 *  - the only store is the current session's append-only entry log (`getEntries()` full tree +
 *    synchronous `appendCustomEntry`). No side file, no directory scan, no fsync/power-loss
 *    promise — the guarantee is normal reload / tree replay;
 *  - replay is a forward high-water fold: if the entry list ever shrinks or a recovery entry for
 *    this sid is corrupt, the store latches `persist-uncertain` and refuses new attempts
 *    (budget treated as exhausted, never reset);
 *  - `open` is process-local: folding restores the accounting window, the used attempts, the
 *    `seen` pairs and the Stop latch, but never a live window. A forged or copied entry
 *    therefore cannot manufacture a human proof, and only a fresh host-injected
 *    user-arrival proof (`HumanEpochPort`, legacy strong-consumption compatible) may open one.
 *    Same-sid `/reload` keeps the budget; new/fork/switch (another sid) starts empty and must wait for that session's own
 *    trusted input. A reserved-but-uncommitted attempt is replayed as `unresolved`: it stays
 *    charged and is never resent.
 *  - the storage seam is synchronous, and every read of session data/task metadata goes through
 *    own data descriptors (no getters, no `toJSON`); task metadata is model-writable data, not
 *    an attestation.
 *
 * Every piece of state lives in this factory closure (I4); no module-scope mutable state, no
 * pi imports, no timers (I5). Production activation still needs a trusted TUI/Web inbound
 * producer plus the B2 runner and B3 host wiring (not #61 or a consumption receipt).
 * B1 alone can never send, so it cannot activate recovery by itself.
 */
import { randomUUID } from "node:crypto";
import type { TodoState } from "./state.js";
import {
  applyHumanProof,
  decideRecoveryAttempt,
  emptyRecoveryState,
  foldIdleRecoveryEntries,
  IDLE_RECOVERY_ENTRY,
  RECOVERY_PAIRS_PER_ATTEMPT_CAP,
  recordRecoveryAttempt,
  sameRecoveryWindow,
  selectRecoveryCandidates,
  solveRecoveryAttempt,
  suppressRecoveryWindow,
  withRecoveryLatch,
  type HumanEpochPort,
  type PersistedAttemptEntry,
  type PersistedOutcomeEntry,
  type PersistedStopEntry,
  type PersistedWindowEntry,
  type RecoveryCandidate,
  type RecoveryCommitOutcome,
  type RecoveryDenyReason,
  type RecoveryLatch,
  type RecoveryProofResult,
  type RecoveryState,
  type RecoveryStopReason,
  type RecoveryWindowKey,
  type SeenPair,
} from "./idle-recovery.js";

/** Re-exported so B2 has one import site for the port it must implement. */
export type { HumanEpochPort };

/** A single check message's plan: every listed candidate pair, one window attempt. */
export interface RecoveryPlan {
  readonly v: 1;
  readonly sid: string;
  readonly owner: string;
  readonly attemptId: string;
  readonly window: RecoveryWindowKey;
  /** 1-based attempt number within the current window (1 or 2). */
  readonly attemptNumber: number;
  /** Candidates listed in the message (numeric task-id order). */
  readonly tasks: readonly RecoveryCandidate[];
  readonly pairs: readonly SeenPair[];
}

export interface RecoveryReservation {
  readonly v: 1;
  readonly attemptId: string;
  readonly window: RecoveryWindowKey;
  readonly pairs: readonly SeenPair[];
}

export type IdleRecoveryDenyReason = RecoveryDenyReason | "no-candidates" | "disposed" | "stale-plan";

export type RecoveryPrepareResult =
  | { readonly kind: "ready"; readonly plan: RecoveryPlan; readonly state: RecoveryState }
  | { readonly kind: "denied"; readonly reason: IdleRecoveryDenyReason; readonly state: RecoveryState };

export type RecoveryReserveResult =
  | { readonly kind: "reserved"; readonly reservation: RecoveryReservation; readonly state: RecoveryState }
  | { readonly kind: "denied"; readonly reason: IdleRecoveryDenyReason; readonly state: RecoveryState };

export interface IdleRecoveryStoreDeps {
  /** Current session id (`sessionManager.getSessionId()`). Entries of another sid are ignored. */
  readonly sessionId: string;
  /**
   * Current trusted executor/owner label. Fixed per store instance — a new activation builds a
   * new store, so an owner change can never be smuggled in through a later call.
   */
  readonly owner: string;
  /** Real `sessionManager.getEntries()` — FULL tree, append-ordered (never `getBranch()`). */
  readonly getEntries: () => readonly unknown[];
  /** Real `sessionManager.appendCustomEntry()` — SYNCHRONOUS; throws on failure. */
  readonly appendCustomEntry: (customType: string, data: unknown) => unknown;
  readonly now?: () => number;
  readonly createAttemptId?: () => string;
}

export interface IdleRecoveryStore {
  /** Fold the log forward and return the current accounting state (no writes). */
  view(): RecoveryState;
  /** Host-injected proof (HumanEpochPort): user-arrival opens immediately; strong consumption is compatible. */
  noteHumanProof(proof: unknown): RecoveryProofResult;
  /** Stop the current window. Machine messages, Task* calls and elapsed time have no entry point on purpose. */
  noteStop(reason: RecoveryStopReason): RecoveryState;
  /** Gate evaluation only — no writes, no send. */
  prepare(request: { readonly todo: TodoState }): RecoveryPrepareResult;
  /** Write-ahead reservation: persists the attempt BEFORE any send; failure ⇒ denied, no send. */
  reserve(plan: RecoveryPlan): RecoveryReserveResult;
  /** Terminal outcome. Accounting is already paid: `failed`/`unknown` never refund. */
  commit(reservation: RecoveryReservation, outcome: RecoveryCommitOutcome): RecoveryState;
  /** Synchronous teardown: later calls are refused (`disposed`) and nothing is left scheduled. */
  dispose(): void;
}

const OUTCOMES: readonly RecoveryCommitOutcome[] = ["sent", "failed", "unknown"];

export function createIdleRecoveryStore(deps: IdleRecoveryStoreDeps): IdleRecoveryStore {
  if (typeof deps.sessionId !== "string" || deps.sessionId === "")
    throw new Error("idle-recovery store requires a non-empty sessionId");
  if (typeof deps.owner !== "string" || deps.owner === "")
    throw new Error("idle-recovery store requires a non-empty owner");
  if (typeof deps.getEntries !== "function")
    throw new Error("idle-recovery store requires getEntries (session read-back capability)");
  if (typeof deps.appendCustomEntry !== "function")
    throw new Error("idle-recovery store requires appendCustomEntry (session append capability)");

  const sid = deps.sessionId;
  const owner = deps.owner;
  const now = deps.now ?? (() => Date.now());
  const createAttemptId = deps.createAttemptId ?? (() => `ir_${randomUUID()}`);

  let state: RecoveryState = emptyRecoveryState(sid);
  /** High-water marker: entries strictly before this index are folded into `state`. */
  let cursor = 0;
  let disposed = false;

  const latch = (value: RecoveryState, reason: RecoveryLatch): RecoveryState => withRecoveryLatch(value, reason);

  /**
   * Fold new entries forward. A shrink means we can no longer prove continuity (the log lost
   * records), and a read failure means we cannot prove anything: both fail closed, keeping the
   * already-accounted budget instead of refunding it.
   */
  const sync = (): RecoveryState => {
    if (disposed) return state;
    let entries: readonly unknown[];
    try {
      entries = deps.getEntries();
    } catch {
      state = latch(state, "persist-uncertain");
      return state;
    }
    if (!Array.isArray(entries)) {
      state = latch(state, "persist-uncertain");
      return state;
    }
    if (entries.length < cursor) {
      state = latch(state, "persist-uncertain");
      return state;
    }
    if (entries.length === cursor) return state;
    const folded = foldIdleRecoveryEntries(entries.slice(cursor), sid, state);
    state = folded.state;
    cursor = entries.length;
    return state;
  };

  /** Append one entry; a throw latches `persist-uncertain` (the caller must not proceed). */
  const append = (data: unknown): boolean => {
    try {
      deps.appendCustomEntry(IDLE_RECOVERY_ENTRY, data);
      return true;
    } catch {
      state = latch(state, "persist-uncertain");
      return false;
    }
  };

  const denied = (reason: IdleRecoveryDenyReason): RecoveryPrepareResult => ({ kind: "denied", reason, state });

  const noteHumanProof = (proof: unknown): RecoveryProofResult => {
    if (disposed) return { kind: "ignored", reason: "disposed", state };
    const current = sync();
    const result = applyHumanProof(current, proof, { sid, owner });
    state = result.state;
    if (result.kind !== "opened" || !result.fresh) return result;
    const window = result.state.window;
    if (window === undefined) return result; // unreachable: "opened" always carries a window
    const entry: PersistedWindowEntry = {
      v: 1,
      kind: "window",
      sid,
      inputId: window.inputId,
      epoch: window.epoch,
      owner,
      at: now(),
    };
    if (append(entry)) cursor += 1;
    return result;
  };

  const noteStop = (reason: RecoveryStopReason): RecoveryState => {
    if (disposed) return state;
    const current = sync();
    state = suppressRecoveryWindow(current);
    const window = state.window;
    if (window === undefined) return state; // nothing to persist: a new window would clear it anyway
    const entry: PersistedStopEntry = {
      v: 1,
      kind: "stop",
      sid,
      inputId: window.inputId,
      epoch: window.epoch,
      reason,
      at: now(),
    };
    if (append(entry)) cursor += 1;
    return state;
  };

  const prepare = (request: { readonly todo: TodoState }): RecoveryPrepareResult => {
    if (disposed) return denied("disposed");
    const current = sync();
    if (current.latch !== undefined) return denied(current.latch);
    const candidates = selectRecoveryCandidates(request.todo, { owner });
    if (candidates.length === 0) return denied("no-candidates");
    const pairs: SeenPair[] = candidates.map((candidate) => ({
      fingerprint: candidate.fingerprint,
      key: candidate.progressKey,
    }));
    const decision = decideRecoveryAttempt(current, pairs);
    if (!decision.allowed) {
      state = decision.state;
      return denied(decision.reason);
    }
    if (decision.state.window === undefined) return denied("no-window");
    const plan: RecoveryPlan = {
      v: 1,
      sid,
      owner,
      attemptId: createAttemptId(),
      window: decision.state.window,
      attemptNumber: decision.attemptNumber,
      tasks: candidates,
      pairs: decision.pairs,
    };
    return { kind: "ready", plan, state: decision.state };
  };

  const reserve = (plan: RecoveryPlan): RecoveryReserveResult => {
    if (disposed) return { kind: "denied", reason: "disposed", state };
    const current = sync();
    if (current.latch !== undefined) return { kind: "denied", reason: current.latch, state };
    if (plan === null || typeof plan !== "object" || plan.v !== 1)
      return { kind: "denied", reason: "stale-plan", state };
    if (plan.sid !== sid || plan.owner !== owner) return { kind: "denied", reason: "stale-plan", state };
    if (typeof plan.attemptId !== "string" || plan.attemptId === "")
      return { kind: "denied", reason: "stale-plan", state };
    if (!state.open || state.window === undefined) return { kind: "denied", reason: "no-window", state };
    if (!sameRecoveryWindow(plan.window, state.window)) return { kind: "denied", reason: "stale-plan", state };
    if (plan.attemptNumber !== state.attemptsInWindow + 1) return { kind: "denied", reason: "stale-plan", state };
    if (state.unresolved.includes(plan.attemptId)) return { kind: "denied", reason: "stale-plan", state };
    if (!Array.isArray(plan.pairs) || plan.pairs.length > RECOVERY_PAIRS_PER_ATTEMPT_CAP)
      return { kind: "denied", reason: "stale-plan", state };
    // Re-entrant settle: every gate is re-evaluated against the freshly folded state.
    const decision = decideRecoveryAttempt(state, plan.pairs);
    if (!decision.allowed) {
      state = decision.state;
      return { kind: "denied", reason: decision.reason, state };
    }
    const window = decision.state.window;
    if (window === undefined) return { kind: "denied", reason: "no-window", state };
    const entry: PersistedAttemptEntry = {
      v: 1,
      kind: "attempt",
      sid,
      inputId: window.inputId,
      epoch: window.epoch,
      attemptId: plan.attemptId,
      pairs: decision.pairs.map((pair) => ({ fingerprint: pair.fingerprint, key: pair.key })),
      at: now(),
    };
    const appended = append(entry);
    state = recordRecoveryAttempt(state, decision.pairs, plan.attemptId);
    if (!appended) return { kind: "denied", reason: "persist-uncertain", state };
    cursor += 1;
    return {
      kind: "reserved",
      reservation: { v: 1, attemptId: plan.attemptId, window, pairs: decision.pairs },
      state,
    };
  };

  const commit = (reservation: RecoveryReservation, outcome: RecoveryCommitOutcome): RecoveryState => {
    if (disposed) return state;
    const current = sync();
    state = solveRecoveryAttempt(current, reservation.attemptId);
    if (!OUTCOMES.includes(outcome)) {
      state = latch(state, "persist-uncertain");
      return state;
    }
    const entry: PersistedOutcomeEntry = {
      v: 1,
      kind: "outcome",
      sid,
      attemptId: reservation.attemptId,
      outcome,
      at: now(),
    };
    if (append(entry)) cursor += 1;
    return state;
  };

  const dispose = (): void => {
    disposed = true;
  };

  return {
    view: sync,
    noteHumanProof,
    noteStop,
    prepare,
    reserve,
    commit,
    dispose,
  };
}
