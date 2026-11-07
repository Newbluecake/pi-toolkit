/**
 * Task59 Stage B (B1) — bounded TODO idle recovery: the PURE kernel. No pi imports, no I/O,
 * no timers, no module-scope mutable state; every fact it uses is an explicit argument, so
 * this module can be table/property tested and replayed from a session entry log verbatim.
 *
 * What lives here: candidate selection, the composite `(fingerprint, progressKey)` identity,
 * the per-window attempt budget, Stop suppression, and the append-only entry format that the
 * store replays (`foldIdleRecoveryEntries`). What does NOT live here: sending, aborting, the
 * B2 runner's 15-minute supervised deadline, and every host busy/goal probe. Nothing in this
 * file can start a turn, and nothing in this file grants authorization.
 *
 * Authorization model (do not weaken, plan §2/§4):
 *  - Candidate eligibility is only a REASON TO ASK: `in_progress`, unarchived, every
 *    `blockedBy` dependency present and completed, no dependency cycle. `metadata.idleRecovery`
 *    may NARROW eligibility (`disabled`, `waiting`); it never grants it. Task metadata is
 *    model-writable data, not an attestation — a model that writes `progressKey` buys no extra
 *    budget, a model that writes nothing buys no permission.
 *  - A budget window opens from a host-injected `user-arrival` proof for the CURRENT
 *    sid+owner (`applyHumanProof`); legacy `strong-consumption` remains compatible, not required.
 *    Raw TUI `interactive` and Web `admission` labels alone are weak proofs: they may hand
 *    the current turn over (B2) but never open a window and never clear a Stop. No function here accepts an epoch or a "human" claim from model input.
 *  - Machine messages, Task* calls, notifications, tree rollback and elapsed time cannot change
 *    any counter: there is deliberately no entry point that takes such a reason.
 *
 * Persistence (plan §4): entries are `subagent:todo-idle-recovery` custom entries (NOT
 * messages). Folding them restores the accounting window, `attemptsInWindow`, `seen` and the
 * Stop latch — but NEVER a live window (`open` is process-local by construction), so a forged
 * or replayed entry cannot manufacture a human proof. The replay is a forward high-water fold:
 * if the entry list shrinks we fail closed instead of refunding budget. There is no side file,
 * no fsync promise and no power-loss transaction claim: the guarantee is normal reload / tree
 * replay only.
 */
import { createHash } from "node:crypto";
import { isArchived, type Task, type TaskStatus, type TodoState } from "./state.js";

/** Fingerprint scheme version — bump only with a NEW entry `v` (a v1 reader must fail closed). */
export const RECOVERY_FINGERPRINT_VERSION = 1;

/** `metadata.idleRecovery.progressKey` cap in UTF-8 bytes. Over-long keys are EXCLUDED, never truncated. */
export const RECOVERY_PROGRESS_KEY_MAX_BYTES = 64;

/** Hard cap on the session-wide `seen` set. Full ⇒ fail closed (no eviction to regain eligibility). */
export const RECOVERY_SEEN_CAP = 256;

/** Attempts allowed inside one trusted human input window, regardless of how the keys change. */
export const RECOVERY_ATTEMPTS_PER_WINDOW = 2;

/** Bound on the diagnostic "reserved but never committed" attempt ids replayed from the log. */
export const RECOVERY_UNRESOLVED_CAP = 32;

/** Bound on how many candidate pairs one reservation may carry (one send lists them all). */
export const RECOVERY_PAIRS_PER_ATTEMPT_CAP = 64;

/** Waiting reasons a task's metadata may declare. Any other string is an unknown wait ⇒ excluded. */
export const RECOVERY_WAITING_REASONS = ["user", "approval", "external", "timer"] as const;
export type RecoveryWaitingReason = (typeof RECOVERY_WAITING_REASONS)[number];

/** Stop evidence accepted by `suppressRecoveryWindow`. None of them grant anything. */
export const RECOVERY_STOP_REASONS = ["aborted", "abort-admission", "owner-lost", "session-boundary"] as const;
export type RecoveryStopReason = (typeof RECOVERY_STOP_REASONS)[number];

/** Host user arrival opens a window immediately; strong consumption is legacy compatibility. */
export const RECOVERY_PROVENANCES = ["user-arrival", "strong-consumption", "admission", "interactive"] as const;
export type RecoveryProvenance = (typeof RECOVERY_PROVENANCES)[number];

/** Persistence customType for the private recovery entries (non-message, `subagent:*` family). */
export const IDLE_RECOVERY_ENTRY = "subagent:todo-idle-recovery";

const MAX_ID_LENGTH = 200;
const MAX_ATTEMPT_ID_LENGTH = 128;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------------------------
// Own-descriptor reads: entry data comes from the session file and task metadata is
// model-written, so every field is read through an own data descriptor. Getters, proxies and
// `toJSON` hooks are never invoked (nothing here stringifies foreign objects).
// ---------------------------------------------------------------------------------------------

function ownValue(target: unknown, key: string): unknown {
  if (target === null || typeof target !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    return descriptor.value;
  } catch {
    return undefined;
  }
}

function ownRecord(target: unknown, key: string): Record<string, unknown> | undefined {
  const value = ownValue(target, key);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function ownNonEmptyString(target: unknown, key: string, maxLength = MAX_ID_LENGTH): string | undefined {
  const value = ownValue(target, key);
  if (typeof value !== "string" || value === "" || value.length > maxLength) return undefined;
  return value;
}

function ownPositiveInt(target: unknown, key: string): number | undefined {
  const value = ownValue(target, key);
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------------------------

export interface RecoveryCandidate {
  readonly taskId: number;
  readonly subject: string;
  readonly fingerprint: string;
  readonly progressKey: string;
}

export interface RecoveryCandidateOptions {
  /**
   * Current execution owner. A task carrying a different (or unconfirmable) owner is not a
   * candidate: "may be picked up by this executor" is part of the eligibility rule, not a hint.
   */
  readonly owner?: string | undefined;
}

export type RecoveryMetadataHint =
  | { readonly excluded: false }
  | { readonly excluded: true; readonly reason: "disabled" | RecoveryWaitingReason | "unknown-waiting" };

/**
 * Read `metadata.idleRecovery` as an eligibility NARROWING hint only.
 *  - `{disabled: true}` ⇒ excluded.
 *  - `{waiting: "user"|"approval"|"external"|"timer"}` ⇒ excluded.
 *  - `{waiting: "<anything else>"}` ⇒ excluded as `unknown-waiting` (an unknown wait is a wait).
 *  - malformed hints (non-object, wrong types) are IGNORED: they cannot grant anything, and
 *    refusing on garbage would let one bad `TaskUpdate metadata` disable the feature forever.
 */
export function readRecoveryMetadataHint(metadata: unknown): RecoveryMetadataHint {
  const hint = ownRecord(metadata, "idleRecovery");
  if (hint === undefined) return { excluded: false };
  if (ownValue(hint, "disabled") === true) return { excluded: true, reason: "disabled" };
  const waiting = ownValue(hint, "waiting");
  if (typeof waiting === "string") {
    const known = RECOVERY_WAITING_REASONS.find((reason) => reason === waiting);
    return { excluded: true, reason: known ?? "unknown-waiting" };
  }
  return { excluded: false };
}

export type RecoveryProgressKeyResult = { readonly ok: true; readonly key: string } | { readonly ok: false };

/**
 * `metadata.idleRecovery.progressKey`: optional UTF-8 string of at most 64 BYTES (missing ⇒ "").
 * A non-string or over-long key is invalid ⇒ the whole candidate is excluded. Never truncated:
 * truncation would let two different progress keys collide into one seen pair.
 */
export function readProgressKey(task: Task): RecoveryProgressKeyResult {
  const hint = ownRecord(task.metadata, "idleRecovery");
  const raw = hint === undefined ? undefined : ownValue(hint, "progressKey");
  if (raw === undefined) return { ok: true, key: "" };
  if (typeof raw !== "string") return { ok: false };
  if (Buffer.byteLength(raw, "utf8") > RECOVERY_PROGRESS_KEY_MAX_BYTES) return { ok: false };
  return { ok: true, key: raw };
}

export interface RecoveryFingerprintPayload {
  readonly v: number;
  readonly taskId: number;
  readonly createdAt: number;
  readonly status: TaskStatus;
  readonly subject: string;
  readonly description: string;
  readonly owner: string;
  readonly blockedBy: readonly { readonly id: number; readonly status: TaskStatus | "missing" }[];
  readonly hint: string;
}

/**
 * Canonical fingerprint input (v1): identity of the WORK, deliberately excluding `updatedAt`,
 * `activeForm`, unrelated metadata and the progress key. Cosmetic edits (formatting, activeForm,
 * an unrelated metadata field, TaskList/Get, a no-op Update) therefore cannot forge a "new"
 * combination and cannot buy a new attempt.
 *
 * `subject`/`description` are whitespace-normalized for the same reason: a re-indented subject
 * is not progress. Dependency edges are sorted and carry each dependency's completion status,
 * so "a dependency completed" is a real change while edge order is not.
 */
export function recoveryFingerprintPayload(task: Task, tasks: readonly Task[]): RecoveryFingerprintPayload {
  const byId = new Map<number, Task>();
  for (const candidate of tasks) if (candidate && typeof candidate.id === "number") byId.set(candidate.id, candidate);
  const blockedBy: { id: number; status: TaskStatus | "missing" }[] = [];
  const seen = new Set<number>();
  for (const id of task.blockedBy) {
    if (typeof id !== "number" || seen.has(id)) continue;
    seen.add(id);
    const dependency = byId.get(id);
    blockedBy.push({ id, status: dependency?.status ?? "missing" });
  }
  blockedBy.sort((a, b) => a.id - b.id);
  const hint = readRecoveryMetadataHint(task.metadata);
  return {
    v: RECOVERY_FINGERPRINT_VERSION,
    taskId: task.id,
    createdAt: task.createdAt,
    status: task.status,
    subject: normalizeFingerprintText(task.subject),
    description: normalizeFingerprintText(task.description),
    owner: task.owner ?? "",
    blockedBy,
    hint: hint.excluded ? hint.reason : "",
  };
}

export function computeRecoveryFingerprint(task: Task, tasks: readonly Task[]): string {
  const payload = recoveryFingerprintPayload(task, tasks);
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function normalizeFingerprintText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** `blockedBy` as an own-data array, or undefined (accessors/prototypes are never consulted). */
function ownBlockedByList(task: unknown): readonly unknown[] | undefined {
  const value = ownValue(task, "blockedBy");
  return Array.isArray(value) ? value : undefined;
}

function dependenciesCompleted(blockedBy: readonly unknown[], byId: Map<number, Task>): boolean {
  for (const id of blockedBy) {
    const dependency = byId.get(id as number);
    if (dependency === undefined || dependency.status !== "completed") return false;
  }
  return true;
}

/**
 * True when following `blockedBy` from `taskId` can reach `taskId` again (a dependency cycle).
 * A task REACHED on the way whose `blockedBy` is not an own-data array makes acyclicity
 * unprovable ⇒ true (fail closed: the caller excludes the candidate) — never a TypeError.
 */
function dependsOnItself(taskId: number, byId: Map<number, Task>): boolean {
  const visited = new Set<number>();
  const stack: number[] = [];
  const start = byId.get(taskId);
  if (start === undefined) return false;
  const startDeps = ownBlockedByList(start);
  if (startDeps === undefined) return true;
  for (const id of startDeps) stack.push(id as number);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === taskId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    const task = byId.get(id);
    if (task === undefined) continue;
    const deps = ownBlockedByList(task);
    if (deps === undefined) return true; // unreadable edges ⇒ cycle neither provable nor refutable
    for (const dependency of deps) stack.push(dependency as number);
  }
  return false;
}

/**
 * Candidate list: `in_progress`, unarchived, all dependencies completed, no cycle, owner
 * compatible, metadata not narrowing, progress key valid. Sorted by numeric task id (stable) so
 * the message text and the reservation pairs are deterministic. Empty is the normal answer.
 *
 * Malformed `blockedBy` fails CLOSED, per candidate: the list must be an array read through an
 * own DATA descriptor (accessors are never invoked, consistent with the entry/metadata reads).
 * A non-array own value on the candidate itself, or on any task REACHED while probing for a
 * dependency cycle, makes the dependency graph unreadable — the candidate is excluded instead
 * of the old behavior, which threw a TypeError iterating a non-iterable `blockedBy`. Real
 * replayed tasks are sanitized plain objects whose `blockedBy` is always an own array
 * (state.ts), so normal input is unaffected.
 */
export function selectRecoveryCandidates(
  state: TodoState,
  options: RecoveryCandidateOptions = {},
): RecoveryCandidate[] {
  if (!state || !Array.isArray(state.tasks)) return [];
  const tasks = state.tasks;
  const byId = new Map<number, Task>();
  for (const task of tasks) {
    if (task && typeof task === "object" && typeof task.id === "number") byId.set(task.id, task);
  }
  const candidates: RecoveryCandidate[] = [];
  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    if (task.status !== "in_progress") continue;
    if (isArchived(task)) continue;
    if (task.owner !== undefined && (options.owner === undefined || task.owner !== options.owner)) continue;
    if (readRecoveryMetadataHint(task.metadata).excluded) continue;
    const blockedBy = ownBlockedByList(task);
    if (blockedBy === undefined) continue; // unreadable dependency list ⇒ fail closed
    if (!dependenciesCompleted(blockedBy, byId)) continue;
    if (dependsOnItself(task.id, byId)) continue;
    const progress = readProgressKey(task);
    if (!progress.ok) continue;
    candidates.push({
      taskId: task.id,
      subject: task.subject,
      fingerprint: computeRecoveryFingerprint(task, tasks),
      progressKey: progress.key,
    });
  }
  candidates.sort((a, b) => a.taskId - b.taskId);
  return candidates;
}

// ---------------------------------------------------------------------------------------------
// Trusted human proof / window accounting
// ---------------------------------------------------------------------------------------------

/**
 * Host-injected read-only port. The future producer is a trusted TUI/Web new-chat inbound
 * callback, not model consumption or root-level persistence. Each new arrival (including
 * consecutive root-level-0 messages) gets a fresh epoch/inputId; duplicate arrivals reuse the
 * same proof. Producer dedup is bounded/fail-closed (plan §4). This is a host API trust boundary,
 * NOT authentication of arbitrary objects: the model must never supply epoch/owner/inputId.
 * B1 neither constructs a source nor derives proof from metadata, tool args or `role: "user"`.
 */
export interface HumanEpochPort {
  /** Current trusted input proof, or undefined when no producer is wired (⇒ zero budget). */
  current(): RecoveryHumanProof | undefined;
}

export interface RecoveryHumanProof {
  readonly sid: string;
  readonly owner: string;
  readonly epoch: number;
  readonly inputId: string;
  readonly provenance: RecoveryProvenance;
}

/** Strict own-descriptor parse; anything off ⇒ undefined (caller treats it as "no proof"). */
export function parseRecoveryHumanProof(raw: unknown): RecoveryHumanProof | undefined {
  const sid = ownNonEmptyString(raw, "sid");
  const owner = ownNonEmptyString(raw, "owner");
  const inputId = ownNonEmptyString(raw, "inputId");
  const epoch = ownPositiveInt(raw, "epoch");
  const provenance = ownValue(raw, "provenance");
  if (sid === undefined || owner === undefined || inputId === undefined || epoch === undefined) return undefined;
  if (typeof provenance !== "string") return undefined;
  const known = RECOVERY_PROVENANCES.find((candidate) => candidate === provenance);
  if (known === undefined) return undefined;
  return { sid, owner, epoch, inputId, provenance: known };
}

export interface RecoveryWindowKey {
  readonly sid: string;
  readonly inputId: string;
  readonly epoch: number;
}

export interface SeenPair {
  readonly fingerprint: string;
  readonly key: string;
}

/** Fail-closed latches. Once set they never clear within the session. */
export const RECOVERY_LATCHES = ["seen-cap", "window-conflict", "persist-uncertain"] as const;
export type RecoveryLatch = (typeof RECOVERY_LATCHES)[number];

export type RecoveryDenyReason = RecoveryLatch | "no-window" | "stopped" | "window-exhausted" | "seen";

export interface RecoveryState {
  readonly sid: string;
  /** Accounting window restored from the entry log. Persisted; NOT proof of a live window. */
  readonly window: RecoveryWindowKey | undefined;
  /** Process-local: true only after a fresh trusted host proof for this instance. */
  readonly open: boolean;
  readonly attemptsInWindow: number;
  readonly totalAttempts: number;
  readonly seen: readonly SeenPair[];
  /** Current-window Stop; cleared only by a NEW trusted user window. */
  readonly stopped: boolean;
  /** attemptIds reserved (written before any send) without a terminal outcome. Never resent. */
  readonly unresolved: readonly string[];
  readonly latch: RecoveryLatch | undefined;
}

export function emptyRecoveryState(sid: string): RecoveryState {
  return {
    sid,
    window: undefined,
    open: false,
    attemptsInWindow: 0,
    totalAttempts: 0,
    seen: [],
    stopped: false,
    unresolved: [],
    latch: undefined,
  };
}

export function withRecoveryLatch(state: RecoveryState, latch: RecoveryLatch): RecoveryState {
  if (state.latch !== undefined) return state;
  return { ...state, latch };
}

export function sameRecoveryWindow(a: RecoveryWindowKey | undefined, b: RecoveryWindowKey | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.sid === b.sid && a.inputId === b.inputId && a.epoch === b.epoch;
}

export type RecoveryProofResult =
  | { readonly kind: "opened"; readonly fresh: boolean; readonly state: RecoveryState }
  | {
      readonly kind: "ignored";
      readonly reason:
        "invalid" | "sid-mismatch" | "owner-mismatch" | "weak-provenance" | "stale-epoch" | "disposed" | "latched";
      readonly state: RecoveryState;
    }
  | { readonly kind: "conflict"; readonly state: RecoveryState };

/**
 * Apply a host-supplied proof. `user-arrival` for the CURRENT sid+owner opens a window on
 * arrival, without waiting for model consumption. `strong-consumption` remains compatible:
 *  - no window yet / newer epoch ⇒ fresh window (budget 0, Stop cleared);
 *  - same window key ⇒ idempotent reopen with the SAME accounting (a reload cannot refund and
 *    a duplicate proof cannot clear a Stop);
 *  - older epoch ⇒ ignored (stale producer);
 *  - same epoch, different inputId ⇒ conflict ⇒ latch (fail closed, never guess).
 */
export function applyHumanProof(
  state: RecoveryState,
  proof: unknown,
  expected: { readonly sid: string; readonly owner: string },
): RecoveryProofResult {
  const parsed = parseRecoveryHumanProof(proof);
  if (parsed === undefined) return { kind: "ignored", reason: "invalid", state };
  // A latched session cannot prove continuity, so it cannot acquire a fresh window either.
  if (state.latch !== undefined) return { kind: "ignored", reason: "latched", state };
  if (parsed.sid !== expected.sid || parsed.sid !== state.sid)
    return { kind: "ignored", reason: "sid-mismatch", state };
  if (parsed.owner !== expected.owner) return { kind: "ignored", reason: "owner-mismatch", state };
  if (parsed.provenance !== "user-arrival" && parsed.provenance !== "strong-consumption")
    return { kind: "ignored", reason: "weak-provenance", state };
  const window: RecoveryWindowKey = { sid: parsed.sid, inputId: parsed.inputId, epoch: parsed.epoch };
  if (state.window === undefined) {
    return {
      kind: "opened",
      fresh: true,
      state: { ...state, window, open: true, attemptsInWindow: 0, stopped: false },
    };
  }
  if (state.window.epoch < window.epoch) {
    return {
      kind: "opened",
      fresh: true,
      state: { ...state, window, open: true, attemptsInWindow: 0, stopped: false },
    };
  }
  if (state.window.epoch > window.epoch) return { kind: "ignored", reason: "stale-epoch", state };
  if (state.window.inputId !== window.inputId) {
    return { kind: "conflict", state: withRecoveryLatch(state, "window-conflict") };
  }
  return { kind: "opened", fresh: false, state: { ...state, open: true } };
}

/** Stop the current window (settled.aborted, Web abort admission, owner loss, session boundary). */
export function suppressRecoveryWindow(state: RecoveryState): RecoveryState {
  return { ...state, stopped: true };
}

export type RecoveryAttemptDecision =
  | {
      readonly allowed: true;
      readonly pairs: readonly SeenPair[];
      readonly attemptNumber: number;
      readonly state: RecoveryState;
    }
  | { readonly allowed: false; readonly reason: RecoveryDenyReason; readonly state: RecoveryState };

/**
 * Gate a would-be attempt. Pure, no side effects: the caller decides whether to persist.
 * `pairs` is the whole candidate list of ONE send — every pair is charged to `seen`, but only
 * one window attempt is consumed (plan §2 last bullet).
 */
export function decideRecoveryAttempt(state: RecoveryState, pairs: readonly SeenPair[]): RecoveryAttemptDecision {
  if (state.latch !== undefined) return { allowed: false, reason: state.latch, state };
  if (!state.open || state.window === undefined) return { allowed: false, reason: "no-window", state };
  if (state.stopped) return { allowed: false, reason: "stopped", state };
  if (state.attemptsInWindow >= RECOVERY_ATTEMPTS_PER_WINDOW)
    return { allowed: false, reason: "window-exhausted", state };
  const fresh: SeenPair[] = [];
  for (const pair of pairs) {
    if (!isValidPair(pair)) continue;
    if (state.seen.some((entry) => entry.fingerprint === pair.fingerprint && entry.key === pair.key)) continue;
    if (fresh.some((entry) => entry.fingerprint === pair.fingerprint && entry.key === pair.key)) continue;
    fresh.push({ fingerprint: pair.fingerprint, key: pair.key });
  }
  if (fresh.length === 0) return { allowed: false, reason: "seen", state };
  if (state.seen.length + fresh.length > RECOVERY_SEEN_CAP) {
    return { allowed: false, reason: "seen-cap", state: withRecoveryLatch(state, "seen-cap") };
  }
  return { allowed: true, pairs: fresh, attemptNumber: state.attemptsInWindow + 1, state };
}

/**
 * Charge one attempt (attempt-before-send): the budget is consumed and the pairs are marked
 * seen regardless of what happens to the send. There is no refund path — failure and unknown
 * outcomes are indistinguishable from success for accounting purposes.
 *
 * The seen cap is an EXPLICIT fail-closed latch, never a silent truncation: when a charge
 * reaches OR crosses `RECOVERY_SEEN_CAP` the session latches `seen-cap`. Nothing is evicted
 * (a charged pair never regains eligibility), and the budget/Stop bookkeeping above is kept —
 * the latch only closes the session, it does not rewrite history. Because latches never clear
 * (`applyHumanProof` refuses a latched session and the replay fold never resets one), no later
 * consumption window can bypass a full cap. Once latched, further charges skip the pair scan
 * entirely (nothing can become eligible again), which also bounds the fold's work on a hostile
 * log with thousands of forged attempt entries.
 */
export function recordRecoveryAttempt(
  state: RecoveryState,
  pairs: readonly SeenPair[],
  attemptId: string,
): RecoveryState {
  const unresolved = [...state.unresolved.filter((id) => id !== attemptId), attemptId].slice(-RECOVERY_UNRESOLVED_CAP);
  const paid: RecoveryState = {
    ...state,
    attemptsInWindow: state.attemptsInWindow + 1,
    totalAttempts: state.totalAttempts + 1,
    unresolved,
  };
  if (state.latch !== undefined) return paid; // fail-closed forever: only the budget is still paid
  // Defensive: a seen set already at/over its cap without a latch (a pre-fix log or a
  // hand-built state) closes explicitly here instead of charging further.
  if (state.seen.length >= RECOVERY_SEEN_CAP) return withRecoveryLatch(paid, "seen-cap");
  const seen = [...state.seen];
  for (const pair of pairs) {
    if (!isValidPair(pair)) continue;
    if (seen.some((entry) => entry.fingerprint === pair.fingerprint && entry.key === pair.key)) continue;
    seen.push({ fingerprint: pair.fingerprint, key: pair.key });
  }
  const charged: RecoveryState = { ...paid, seen };
  return seen.length >= RECOVERY_SEEN_CAP ? withRecoveryLatch(charged, "seen-cap") : charged;
}

/** Terminal outcome observed for a reserved attempt (diagnostics only; accounting already paid). */
export function solveRecoveryAttempt(state: RecoveryState, attemptId: string): RecoveryState {
  return { ...state, unresolved: state.unresolved.filter((id) => id !== attemptId) };
}

function isValidPair(pair: SeenPair): boolean {
  return (
    typeof pair?.fingerprint === "string" &&
    FINGERPRINT_RE.test(pair.fingerprint) &&
    typeof pair.key === "string" &&
    Buffer.byteLength(pair.key, "utf8") <= RECOVERY_PROGRESS_KEY_MAX_BYTES
  );
}

// ---------------------------------------------------------------------------------------------
// Append-only entry log + replay fold
// ---------------------------------------------------------------------------------------------

export type RecoveryCommitOutcome = "sent" | "failed" | "unknown";

export interface PersistedWindowEntry {
  readonly v: 1;
  readonly kind: "window";
  readonly sid: string;
  readonly inputId: string;
  readonly epoch: number;
  readonly owner: string;
  readonly at: number;
}

export interface PersistedAttemptEntry {
  readonly v: 1;
  readonly kind: "attempt";
  readonly sid: string;
  readonly inputId: string;
  readonly epoch: number;
  readonly attemptId: string;
  readonly pairs: readonly SeenPair[];
  readonly at: number;
}

export interface PersistedOutcomeEntry {
  readonly v: 1;
  readonly kind: "outcome";
  readonly sid: string;
  readonly attemptId: string;
  readonly outcome: RecoveryCommitOutcome;
  readonly at: number;
}

export interface PersistedStopEntry {
  readonly v: 1;
  readonly kind: "stop";
  readonly sid: string;
  readonly inputId: string;
  readonly epoch: number;
  readonly reason: RecoveryStopReason;
  readonly at: number;
}

export type PersistedRecoveryEntry =
  PersistedWindowEntry | PersistedAttemptEntry | PersistedOutcomeEntry | PersistedStopEntry;

export type ParsedIdleRecoveryEntry =
  | { readonly kind: "ignored" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "entry"; readonly entry: PersistedRecoveryEntry };

/**
 * Strict own-descriptor parse of one session entry. Foreign entries (messages, other custom
 * types, another session's recovery entries) are ignored — a forked session carries the OLD
 * sid's entries and must not inherit budget, seen pairs or a Stop. A recovery entry for THIS
 * sid that does not parse is corruption ⇒ the caller fails closed.
 */
export function parseIdleRecoveryEntry(raw: unknown, sid: string): ParsedIdleRecoveryEntry {
  if (ownValue(raw, "customType") !== IDLE_RECOVERY_ENTRY) return { kind: "ignored" };
  const data = ownRecord(raw, "data");
  if (data === undefined) return { kind: "corrupt" };
  if (ownValue(data, "v") !== 1) return { kind: "corrupt" };
  const entrySid = ownNonEmptyString(data, "sid");
  if (entrySid === undefined) return { kind: "corrupt" };
  if (entrySid !== sid) return { kind: "ignored" };
  const kind = ownValue(data, "kind");
  const at = ownValue(data, "at");
  const atValue = typeof at === "number" && Number.isFinite(at) ? at : 0;
  if (kind === "window") {
    const inputId = ownNonEmptyString(data, "inputId");
    const epoch = ownPositiveInt(data, "epoch");
    const owner = ownNonEmptyString(data, "owner");
    if (inputId === undefined || epoch === undefined || owner === undefined) return { kind: "corrupt" };
    return { kind: "entry", entry: { v: 1, kind, sid: entrySid, inputId, epoch, owner, at: atValue } };
  }
  if (kind === "attempt") {
    const inputId = ownNonEmptyString(data, "inputId");
    const epoch = ownPositiveInt(data, "epoch");
    const attemptId = ownNonEmptyString(data, "attemptId", MAX_ATTEMPT_ID_LENGTH);
    const pairs = parsePairs(ownValue(data, "pairs"));
    if (inputId === undefined || epoch === undefined || attemptId === undefined || pairs === undefined)
      return { kind: "corrupt" };
    return {
      kind: "entry",
      entry: { v: 1, kind, sid: entrySid, inputId, epoch, attemptId, pairs, at: atValue },
    };
  }
  if (kind === "outcome") {
    const attemptId = ownNonEmptyString(data, "attemptId", MAX_ATTEMPT_ID_LENGTH);
    const outcome = ownValue(data, "outcome");
    if (attemptId === undefined) return { kind: "corrupt" };
    const known = ["sent", "failed", "unknown"].find((candidate) => candidate === outcome);
    if (known === undefined) return { kind: "corrupt" };
    return {
      kind: "entry",
      entry: { v: 1, kind, sid: entrySid, attemptId, outcome: known as RecoveryCommitOutcome, at: atValue },
    };
  }
  if (kind === "stop") {
    const inputId = ownNonEmptyString(data, "inputId");
    const epoch = ownValue(data, "epoch");
    const reason = ownValue(data, "reason");
    const knownReason = RECOVERY_STOP_REASONS.find((candidate) => candidate === reason);
    if (inputId === undefined || typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0)
      return { kind: "corrupt" };
    if (knownReason === undefined) return { kind: "corrupt" };
    return {
      kind: "entry",
      entry: { v: 1, kind, sid: entrySid, inputId, epoch, reason: knownReason, at: atValue },
    };
  }
  return { kind: "corrupt" };
}

function parsePairs(raw: unknown): SeenPair[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  if (raw.length > RECOVERY_PAIRS_PER_ATTEMPT_CAP) return undefined;
  const pairs: SeenPair[] = [];
  for (const element of raw) {
    const fingerprint = ownValue(element, "fingerprint");
    const key = ownValue(element, "key");
    if (typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint)) return undefined;
    if (typeof key !== "string" || Buffer.byteLength(key, "utf8") > RECOVERY_PROGRESS_KEY_MAX_BYTES) return undefined;
    pairs.push({ fingerprint, key });
  }
  return pairs;
}

export interface FoldIdleRecoveryResult {
  readonly state: RecoveryState;
  /** True when at least one entry for this sid was unparseable (the caller must fail closed). */
  readonly corrupt: boolean;
}

/**
 * Forward fold of the entry log (high-water): window entries restore accounting (never `open`),
 * attempt entries charge budget + seen pairs, outcome entries clear `unresolved`, stop entries
 * suppress their window. `base` lets the store fold incrementally; a full replay from
 * `emptyRecoveryState` is the reference behavior tests compare against.
 */
export function foldIdleRecoveryEntries(
  entries: readonly unknown[],
  sid: string,
  base: RecoveryState = emptyRecoveryState(sid),
): FoldIdleRecoveryResult {
  let state = base;
  let corrupt = false;
  const appliedAttempts = new Set<string>(state.unresolved);
  for (const raw of entries) {
    const parsed = parseIdleRecoveryEntry(raw, sid);
    if (parsed.kind === "ignored") continue;
    if (parsed.kind === "corrupt") {
      corrupt = true;
      continue;
    }
    const entry = parsed.entry;
    if (entry.kind === "window") {
      if (state.window !== undefined && entry.epoch < state.window.epoch) continue;
      const key: RecoveryWindowKey = { sid, inputId: entry.inputId, epoch: entry.epoch };
      if (state.window !== undefined && entry.epoch === state.window.epoch && state.window.inputId !== entry.inputId) {
        state = withRecoveryLatch(state, "window-conflict");
        continue;
      }
      const same = sameRecoveryWindow(state.window, key);
      state = {
        ...state,
        window: key,
        attemptsInWindow: same ? state.attemptsInWindow : 0,
        stopped: same ? state.stopped : false,
        open: same ? state.open : false,
      };
      continue;
    }
    if (entry.kind === "attempt") {
      if (appliedAttempts.has(entry.attemptId)) continue;
      appliedAttempts.add(entry.attemptId);
      const key: RecoveryWindowKey = { sid, inputId: entry.inputId, epoch: entry.epoch };
      if (state.window === undefined) {
        state = { ...state, window: key, attemptsInWindow: 0, stopped: false, open: false };
      } else if (!sameRecoveryWindow(state.window, key)) {
        // Charged against another window: the pairs stay seen, the current budget does not move.
        const charged = recordRecoveryAttempt(state, entry.pairs, entry.attemptId);
        state = {
          ...charged,
          attemptsInWindow: state.attemptsInWindow,
          unresolved: charged.unresolved.filter((id) => id !== entry.attemptId),
        };
        continue;
      }
      state = recordRecoveryAttempt(state, entry.pairs, entry.attemptId);
      continue;
    }
    if (entry.kind === "outcome") {
      state = solveRecoveryAttempt(state, entry.attemptId);
      continue;
    }
    if (entry.kind === "stop") {
      if (state.window !== undefined) {
        if (state.window.epoch > entry.epoch) continue; // stop for an already-superseded window
        if (state.window.epoch === entry.epoch && state.window.inputId !== entry.inputId) continue;
      }
      state = suppressRecoveryWindow(state);
    }
  }
  if (corrupt) state = withRecoveryLatch(state, "persist-uncertain");
  return { state, corrupt };
}
