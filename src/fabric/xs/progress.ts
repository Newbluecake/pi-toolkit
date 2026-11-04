import { systemClock, type Clock } from "../../core/clock.js";
import {
  XS_REQUESTS_MAX_ROWS,
  XS_TRACK_DEFAULT_MS,
  type XsEvidence,
  type XsObservation,
  type XsPhase,
  type XsProgress,
  type XsReplyState,
  type XsWakeView,
} from "../../web-hub/protocol/xs-activation.js";

/**
 * fabric-xs-activation P1a — the PURE cross-session progress state machine (plan §3 P1
 * "纯状态" sub-package; arch §4.1 progress data, §4.2 state table, §4.5 relation windows,
 * §4.6 activation claims). The bag that P1b wiring (`xs/receiver.ts`, `xs/stack.ts`,
 * `hub/xs/activation.ts`, source-side mirrors) will drive — this module only owns the state
 * transitions, no frame routing, no body text, no automatic wake, no Controller access.
 *
 * Merge rules (arch §4.1/§4.2, pinned by `tests/fabric/xs-progress.property.test.ts`):
 *
 * - `messageId` (the original body's hub xid) is the index; `revision` is monotone per
 *   process × messageId. A snapshot whose revision is BELOW the stored one is dropped
 *   whole ("旧 ack 不改、不添turn" — it may not even add timestamps); equal or greater
 *   revisions merge field-monotonically.
 * - The phase keeps the FURTHEST proven fact (`queued < delivered < started < replied`):
 *   `offline` observations, receipt misses and stale revisions never regress it; a body
 *   observed as `delivered` directly (no `queued`) is legal; a confirmed reply may jump to
 *   `replied` and the merge never fabricates the skipped `startedAt`.
 * - The delivery-evidence axis is monotone `none < unknown < applied`: `unknown` may rise
 *   to `applied`; nothing ever rewrites an `unknown`/`applied` verdict down to `none` (a
 *   transport timeout records `unknown` — timeouts never manufacture `none`).
 * - Timestamps (`queuedAt`/`deliveredAt`/`startedAt`/`repliedAt`), `requestId`,
 *   `activationKey`, `activationUntil` and `entryId` are adopt-if-absent: once set they are
 *   immutable facts (first writer wins, duplicates and late acks cannot move them).
 * - `observation` is the reporter's CONTINUITY, not a fact lattice: the latest non-stale
 *   statement wins (live → offline → recovered live …), while every phase/evidence fact
 *   survives underneath. `reason` is overwrite-if-present/keep-if-absent — a recorded reason
 *   is never silently dropped (arch §2.2 "部分出口丢原因" gap direction), a newer statement
 *   replaces it. `replyState` never re-pends: once `timed_out`/`late`/`invalidated`, a
 *   later `pending` cannot overwrite (late → written stays possible).
 * - Wake views (arch §4.8): `requested` is monotone-OR; the FIRST real stopper
 *   (`stage`+`decision`+`reason` triple) is sticky once it carries a `reason` or the dispatch
 *   was accepted — a later downgrade of another attempt never rewrites it; `defaulted` is
 *   SOURCE-PRIVATE: only a LOCAL observation may set it, a remote merge can neither set nor
 *   clear it; `authorizedAt`/`ended` are adopt-if-absent (one wake run ends once);
 *   `retryAfterAt` is overwrite-if-present (only an authoritative quota source fills it).
 *
 * Activation claims (arch §4.5 step 5/§4.6): per messageId `available → reserved →
 * dispatched | unknown → consumed`. `reserve` is the only entry and refuses, in order:
 * `not_tracked` (no entry), `expired` (deadline reached — refuse FIRST, the entry is only
 * lazily pruned by later writes), `already_active` (a reserved/dispatched/unknown attempt is
 * pending), `already_consumed` (terminal tombstone — a settled message never reopens),
 * `key_mismatch` (a different key cannot bypass the message-level claim) and `not_before`
 * (the retry floor a proven-`none` release left behind). A proven-`none` release returns to
 * `available` KEEPING the key binding and raising `notBefore` (same-key manual retry only);
 * an after-send exception records `unknown` (query-only, never a second relay) and settles
 * into the `consumed` tombstone exactly once — duplicate/late settles are no-ops.
 *
 * Capacity/expiry (plan §1/§3, arch §4.5): cap `XS_PROGRESS_CAP` (256 = the StatusInfo row
 * cap) — full refuses NEW messageIds and NEVER evicts a live entry; entry deadline =
 * one-shot-adopted `activationUntil` (the relation's trackUntil) else first-seen +
 * `XS_TRACK_DEFAULT_MS` (30 min). Expiry is lazy — no timers (I5: nothing here is
 * time-driven); `claimReserve` refuses expired entries before any cleanup, writes prune.
 * After the deadline the tracking epoch ends: later writes for the same id open a FRESH
 * epoch (old facts/claims do not resurrect — the hub relation is the activation authority).
 *
 * I4 (no module-scope mutable state): everything lives in instance closures; where the bag
 * survives `/reload` is the wiring's decision (P1b may park it on a
 * `Symbol.for("pi-subagent:*")` global — deliberately NOT done here). Pi-free by
 * construction (source-scan gate: `src/fabric/xs/**` must not import pi).
 */

/** Per-side bag capacity: receiver/source cap 256 (arch §4.5) = the `StatusInfo.xsRequests` row cap. */
export const XS_PROGRESS_CAP = XS_REQUESTS_MAX_ROWS;

// ----------------------------------------------------------------- field lattices (arch §4.1)

const PHASE_RANK: Readonly<Record<XsPhase, number>> = { queued: 1, delivered: 2, started: 3, replied: 4 };
const EVIDENCE_RANK: Readonly<Record<XsEvidence, number>> = { none: 0, unknown: 1, applied: 2 };
const REPLY_TERMINAL: ReadonlySet<XsReplyState> = new Set(["timed_out", "late", "invalidated"]);

/** Rank of a phase for monotone comparisons; absent = 0 (no phase proven yet). */
export function xsPhaseRank(phase: XsPhase | undefined): number {
  return phase === undefined ? 0 : PHASE_RANK[phase];
}

/** Rank of a delivery effect (`none < unknown < applied` — never regress, timeouts never make `none`). */
export function xsEvidenceRank(evidence: XsEvidence): number {
  return EVIDENCE_RANK[evidence];
}

function maxPhase(a: XsPhase | undefined, b: XsPhase | undefined): XsPhase | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return PHASE_RANK[b] > PHASE_RANK[a] ? b : a;
}

function maxEvidence(a: XsEvidence, b: XsEvidence): XsEvidence {
  return EVIDENCE_RANK[b] > EVIDENCE_RANK[a] ? b : a;
}

/** Adopt-if-absent: the stored fact wins; the incoming may only fill a hole. */
function keep<T>(stored: T | undefined, incoming: T | undefined): T | undefined {
  return stored !== undefined ? stored : incoming;
}

/** A patch's wake statement — any subset of {@link XsWakeView}. */
export type XsWakeInput = Partial<XsWakeView>;

/**
 * A progress statement: every PRESENT field is an observation (per-field policy below),
 * every ABSENT field says nothing. This is the shape both the local observer
 * (`XsProgressBag.observe`) and a remote snapshot projection (`merge`) feed the lattice —
 * so local evidence and mirrored `xs_state` frames flow through ONE merge core.
 */
export interface XsProgressFields {
  deliveryEffect?: XsEvidence;
  phase?: XsPhase;
  queuedAt?: number;
  deliveredAt?: number;
  startedAt?: number;
  repliedAt?: number;
  requestId?: string;
  replyState?: XsReplyState;
  observation?: XsObservation;
  /** Body/observation reason — independent of the wake reason. */
  reason?: string;
  wake?: XsWakeInput;
  activationKey?: string;
  activationUntil?: number;
  entryId?: string;
}

/** The wake view a fresh entry starts from when nobody stated anything yet. */
const DEFAULT_WAKE: XsWakeView = { requested: false, decision: "deliver_only" };

function mergeWakeFields(stored: XsWakeView, incoming: XsWakeInput | undefined, local: boolean): XsWakeView {
  if (incoming === undefined) return stored;
  // The FIRST real stopper is sticky (arch §4.8): once the view carries a stop reason, or
  // the dispatch was accepted, later attempts' downgrades never rewrite the story.
  const sticky = stored.reason !== undefined || stored.decision === "dispatch_accepted";
  const decision = sticky ? stored.decision : (incoming.decision ?? stored.decision);
  const stage = sticky ? stored.stage : (incoming.stage ?? stored.stage);
  const reason = sticky ? stored.reason : (incoming.reason ?? stored.reason);
  // `defaulted` is source-private (U2): only a local observation may set it, and once true
  // it is an immutable fact of the send — a remote merge can neither set nor clear it.
  const defaulted = stored.defaulted === true || (local && incoming.defaulted === true) ? true : undefined;
  const out: XsWakeView = {
    requested: stored.requested || incoming.requested === true,
    ...(defaulted !== undefined ? { defaulted } : {}),
    ...(stage !== undefined ? { stage } : {}),
    decision,
    ...(reason !== undefined ? { reason } : {}),
  };
  const authorizedAt = keep(stored.authorizedAt, incoming.authorizedAt);
  if (authorizedAt !== undefined) out.authorizedAt = authorizedAt;
  const ended = keep(stored.ended, incoming.ended);
  if (ended !== undefined) out.ended = ended;
  // `retryAfterAt` is overwrite-if-present / keep-if-absent: only an authoritative quota
  // source fills it, so a non-quota statement that omits it must never clear the floor.
  const retryAfterAt = incoming.retryAfterAt ?? stored.retryAfterAt;
  if (retryAfterAt !== undefined) out.retryAfterAt = retryAfterAt;
  return out;
}

export interface XsProgressMergeOptions {
  /** Local observation: may set the source-private wake fact (`defaulted`); remote merges never can. */
  local?: boolean;
  /** The observation revision to fold in (a remote snapshot's revision / a local observe's next tick). */
  revision?: number;
}

/**
 * The ONE monotone merge core (pure, total). Present fields apply per the header's lattice;
 * the result revision is `max(stored.revision, options.revision ?? 0)`. Callers gate
 * staleness BEFORE calling (the bag drops `revision < stored` whole) — the core itself only
 * ever moves facts forward, so even a mis-gated call cannot regress anything.
 */
export function mergeXsProgress(
  stored: XsProgress,
  incoming: XsProgressFields,
  options: XsProgressMergeOptions = {},
): XsProgress {
  const local = options.local === true;
  const phase = maxPhase(stored.phase, incoming.phase);
  const replyState = mergeReplyState(stored.replyState, incoming.replyState);
  const queuedAt = keep(stored.queuedAt, incoming.queuedAt);
  const deliveredAt = keep(stored.deliveredAt, incoming.deliveredAt);
  const startedAt = keep(stored.startedAt, incoming.startedAt);
  const repliedAt = keep(stored.repliedAt, incoming.repliedAt);
  const requestId = keep(stored.requestId, incoming.requestId);
  const activationKey = keep(stored.activationKey, incoming.activationKey);
  const activationUntil = keep(stored.activationUntil, incoming.activationUntil);
  const entryId = keep(stored.entryId, incoming.entryId);
  return {
    messageId: stored.messageId,
    revision: Math.max(stored.revision, options.revision ?? 0),
    deliveryEffect: maxEvidence(stored.deliveryEffect, incoming.deliveryEffect ?? stored.deliveryEffect),
    ...(phase !== undefined ? { phase } : {}),
    ...(queuedAt !== undefined ? { queuedAt } : {}),
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(repliedAt !== undefined ? { repliedAt } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(replyState !== undefined ? { replyState } : {}),
    // Latest non-stale continuity statement wins; facts survive underneath.
    observation: incoming.observation ?? stored.observation,
    // A recorded reason is never silently dropped; a newer statement replaces it.
    ...(incoming.reason !== undefined
      ? { reason: incoming.reason }
      : stored.reason !== undefined
        ? { reason: stored.reason }
        : {}),
    wake: mergeWakeFields(stored.wake, incoming.wake, local),
    ...(activationKey !== undefined ? { activationKey } : {}),
    ...(activationUntil !== undefined ? { activationUntil } : {}),
    ...(entryId !== undefined ? { entryId } : {}),
  };
}

function mergeReplyState(
  stored: XsReplyState | undefined,
  incoming: XsReplyState | undefined,
): XsReplyState | undefined {
  if (incoming === undefined) return stored;
  if (stored !== undefined && REPLY_TERMINAL.has(stored) && incoming === "pending") return stored;
  return incoming;
}

// ----------------------------------------------------------------- activation claims (arch §4.6)

/** `available → reserved → dispatched | unknown → consumed` (terminal: `consumed` never reopens). */
export type XsActivationClaimState = "available" | "reserved" | "dispatched" | "unknown" | "consumed";

export interface XsActivationClaimView {
  state: XsActivationClaimState;
  /** Bound at the first successful reserve; survives a proven-`none` release (same-key retry only). */
  activationKey: string | undefined;
  /** Retry floor left by a release — reserve before it refuses (`not_before`). */
  notBefore: number;
  /** Reserves that ever left `available` (diagnostic; monotone). */
  attempts: number;
  reservedAt?: number;
  dispatchedAt?: number;
  settledAt?: number;
}

interface XsClaimSlot {
  state: XsActivationClaimState;
  activationKey: string | undefined;
  notBefore: number;
  attempts: number;
  reservedAt: number | undefined;
  dispatchedAt: number | undefined;
  settledAt: number | undefined;
}

function claimViewOf(claim: XsClaimSlot): XsActivationClaimView {
  return {
    state: claim.state,
    activationKey: claim.activationKey,
    notBefore: claim.notBefore,
    attempts: claim.attempts,
    ...(claim.reservedAt !== undefined ? { reservedAt: claim.reservedAt } : {}),
    ...(claim.dispatchedAt !== undefined ? { dispatchedAt: claim.dispatchedAt } : {}),
    ...(claim.settledAt !== undefined ? { settledAt: claim.settledAt } : {}),
  };
}

export type XsClaimReserveResult =
  | { ok: true; view: XsActivationClaimView }
  | { ok: false; reason: "not_tracked" }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "already_active" }
  | { ok: false; reason: "already_consumed" }
  | { ok: false; reason: "key_mismatch" }
  | { ok: false; reason: "not_before"; notBefore: number };

export type XsClaimStepResult =
  { ok: true; view: XsActivationClaimView; dup?: true } | { ok: false; reason: "not_tracked" | "state" };

// ----------------------------------------------------------------- the bag

interface XsProgressSlot {
  progress: XsProgress;
  /** First-seen time — the fallback deadline base (`firstSeenAt + defaultTrackMs`). */
  firstSeenAt: number;
  /** One-shot adopted relation deadline (trackUntil); undefined until a statement carries it. */
  trackUntil: number | undefined;
  claim: XsClaimSlot | undefined;
}

export type XsProgressWrite =
  | { kind: "created"; progress: XsProgress }
  | { kind: "merged"; progress: XsProgress }
  | { kind: "stale"; progress: XsProgress }
  | { kind: "full" }
  | { kind: "invalid" };

function copyProgress(progress: XsProgress): XsProgress {
  return { ...progress, wake: { ...progress.wake } };
}

function validId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && id.length <= 64;
}

/**
 * The per-side progress bag (receiver evidence store / source-side mirror). All state is in
 * the instance; no timers, no module globals. Writes prune expired entries first; reads are
 * side-effect-free and overlay `observation:"expired"` past the deadline (facts preserved).
 */
export class XsProgressBag {
  private readonly entries = new Map<string, XsProgressSlot>();

  constructor(
    readonly capacity: number = XS_PROGRESS_CAP,
    private readonly clock: Clock = systemClock,
    private readonly defaultTrackMs: number = XS_TRACK_DEFAULT_MS,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("invalid xs progress capacity");
    if (!Number.isFinite(defaultTrackMs) || defaultTrackMs < 0)
      throw new RangeError("invalid xs progress track window");
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * LOCAL evidence write (receiver pipeline / source sender): the bag owns the per-message
   * revision counter and bumps it; the patch still flows through the monotone core, so a
   * local bug cannot regress a fact either. May set the source-private `wake.defaulted`.
   */
  observe(messageId: string, input: XsProgressFields, now: number = this.clock.now()): XsProgressWrite {
    this.prune(now);
    if (!validId(messageId)) return { kind: "invalid" };
    const slot = this.entries.get(messageId);
    if (slot === undefined) {
      if (this.entries.size >= this.capacity) return { kind: "full" };
      const created = this.create(messageId, input, 0, true, now);
      this.entries.set(messageId, created);
      return { kind: "created", progress: copyProgress(created.progress) };
    }
    slot.progress = mergeXsProgress(slot.progress, input, { local: true, revision: slot.progress.revision + 1 });
    this.adoptTrackUntil(slot, input.activationUntil);
    return { kind: "merged", progress: copyProgress(slot.progress) };
  }

  /**
   * REMOTE snapshot merge (source mirror of `xs_state`, cross-process replays): dropped
   * whole when stale (`revision < stored`); a fresh messageId creates the entry at the
   * snapshot's own revision. `wake.defaulted` is never adopted (source-private).
   */
  merge(snapshot: XsProgress, now: number = this.clock.now()): XsProgressWrite {
    if (!validId(snapshot.messageId) || !Number.isInteger(snapshot.revision) || snapshot.revision < 0) {
      return { kind: "invalid" };
    }
    this.prune(now);
    const slot = this.entries.get(snapshot.messageId);
    if (slot === undefined) {
      if (this.entries.size >= this.capacity) return { kind: "full" };
      const created = this.create(snapshot.messageId, snapshot, snapshot.revision, false, now);
      this.entries.set(snapshot.messageId, created);
      return { kind: "created", progress: copyProgress(created.progress) };
    }
    if (snapshot.revision < slot.progress.revision) {
      return { kind: "stale", progress: copyProgress(slot.progress) };
    }
    slot.progress = mergeXsProgress(slot.progress, snapshot, { local: false, revision: snapshot.revision });
    this.adoptTrackUntil(slot, snapshot.activationUntil);
    return { kind: "merged", progress: copyProgress(slot.progress) };
  }

  /** Stored snapshot (a miss — no entry — is `undefined` and changes nothing). */
  snapshot(messageId: string, now: number = this.clock.now()): XsProgress | undefined {
    const slot = this.entries.get(messageId);
    if (slot === undefined) return undefined;
    const out = copyProgress(slot.progress);
    if (now >= this.deadlineOf(slot)) out.observation = "expired";
    return out;
  }

  /** All rows in insertion order, with the same read-time expiry overlay. */
  rows(now: number = this.clock.now()): XsProgress[] {
    const out: XsProgress[] = [];
    for (const slot of this.entries.values()) {
      const progress = copyProgress(slot.progress);
      if (now >= this.deadlineOf(slot)) progress.observation = "expired";
      out.push(progress);
    }
    return out;
  }

  /** Lazily drop expired entries (writes already do this); returns how many went. */
  prune(now: number = this.clock.now()): number {
    let removed = 0;
    for (const [id, slot] of this.entries) {
      if (now >= this.deadlineOf(slot)) {
        this.entries.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  // ----------------------------------------------------------------- claims (arch §4.5/§4.6)

  claimView(messageId: string): XsActivationClaimView | undefined {
    const claim = this.entries.get(messageId)?.claim;
    return claim === undefined ? undefined : claimViewOf(claim);
  }

  /**
   * The only claim entry point. Deliberately does NOT prune — an expired-but-present entry
   * refuses `expired` FIRST and is only lazily cleaned by later writes ("过期包先拒绝才
   * lazy清理"). Phase/evidence eligibility (delivered-not-started etc.) is the CALLER's
   * admission (arch §4.5 steps 1–4); this machine owns only the claim transitions.
   */
  claimReserve(messageId: string, activationKey: string, now: number = this.clock.now()): XsClaimReserveResult {
    const slot = this.entries.get(messageId);
    if (slot === undefined) return { ok: false, reason: "not_tracked" };
    if (now >= this.deadlineOf(slot)) return { ok: false, reason: "expired" };
    const claim = slot.claim;
    if (claim !== undefined && claim.state !== "available") {
      return { ok: false, reason: claim.state === "consumed" ? "already_consumed" : "already_active" };
    }
    if (claim?.activationKey !== undefined && claim.activationKey !== activationKey) {
      return { ok: false, reason: "key_mismatch" };
    }
    const notBefore = claim?.notBefore ?? 0;
    if (now < notBefore) return { ok: false, reason: "not_before", notBefore };
    const next: XsClaimSlot = {
      state: "reserved",
      activationKey,
      notBefore,
      attempts: (claim?.attempts ?? 0) + 1,
      reservedAt: now,
      dispatchedAt: undefined,
      settledAt: undefined,
    };
    slot.claim = next;
    return { ok: true, view: claimViewOf(next) };
  }

  /** `reserved → dispatched` — the control marker was relayed (exactly once per attempt). */
  claimDispatch(messageId: string, now: number = this.clock.now()): XsClaimStepResult {
    const claim = this.claim(messageId);
    if (claim === undefined) return { ok: false, reason: "state" };
    if (claim.state !== "reserved") return { ok: false, reason: "state" };
    claim.state = "dispatched";
    claim.dispatchedAt = now;
    return { ok: true, view: claimViewOf(claim) };
  }

  /** `reserved|dispatched → unknown` — after-send exception: query-only, never a second relay. */
  claimMarkUnknown(messageId: string, now: number = this.clock.now()): XsClaimStepResult {
    const claim = this.claim(messageId);
    if (claim === undefined) return { ok: false, reason: "state" };
    if (claim.state !== "reserved" && claim.state !== "dispatched") return { ok: false, reason: "state" };
    claim.state = "unknown";
    return { ok: true, view: claimViewOf(claim) };
  }

  /**
   * Proven-`none` release (pre- or post-dispatch, or a late ack that proved the attempt
   * ineffective): back to `available` KEEPING the key binding and RAISING `notBefore`
   * (default floor = now; the caller may pass the quota's retryAfterAt).
   */
  claimRelease(messageId: string, notBefore?: number, now: number = this.clock.now()): XsClaimStepResult {
    const claim = this.claim(messageId);
    if (claim === undefined) return { ok: false, reason: "state" };
    // Proven-`none` release only: `unknown` (after-send exception) is query-only and must
    // never refund the reservation — releasing it would permit a second relay (at-most-once).
    if (claim.state !== "reserved" && claim.state !== "dispatched") return { ok: false, reason: "state" };
    claim.state = "available";
    claim.notBefore = Math.max(claim.notBefore, notBefore ?? now);
    claim.reservedAt = undefined;
    claim.dispatchedAt = undefined;
    claim.settledAt = undefined;
    return { ok: true, view: claimViewOf(claim) };
  }

  /**
   * `dispatched|unknown → consumed` — the terminal tombstone; a settled message never
   * reopens (a second settle is an idempotent no-op, "重复/迟到ack不重复settle/refund").
   */
  claimSettle(messageId: string, now: number = this.clock.now()): XsClaimStepResult {
    const claim = this.claim(messageId);
    if (claim === undefined) return { ok: false, reason: "state" };
    if (claim.state === "consumed") return { ok: true, view: claimViewOf(claim), dup: true };
    if (claim.state !== "dispatched" && claim.state !== "unknown") return { ok: false, reason: "state" };
    claim.state = "consumed";
    claim.settledAt = now;
    return { ok: true, view: claimViewOf(claim) };
  }

  // ----------------------------------------------------------------- internals

  private claim(messageId: string): XsClaimSlot | undefined {
    return this.entries.get(messageId)?.claim;
  }

  private deadlineOf(slot: XsProgressSlot): number {
    return slot.trackUntil ?? slot.firstSeenAt + this.defaultTrackMs;
  }

  /** One-shot adoption: the relation's trackUntil is a fixed fact; a fresh value never replaces it. */
  private adoptTrackUntil(slot: XsProgressSlot, activationUntil: number | undefined): void {
    if (slot.trackUntil === undefined && activationUntil !== undefined) slot.trackUntil = activationUntil;
  }

  private create(
    messageId: string,
    fields: XsProgressFields,
    revision: number,
    local: boolean,
    now: number,
  ): XsProgressSlot {
    const base: XsProgress = {
      messageId,
      revision: 0,
      // A tracked messageId (a hub xid exists) is at least `unknown`; the writer states
      // `none` explicitly for definitive refusals (fence rejects).
      deliveryEffect: fields.deliveryEffect ?? "unknown",
      observation: fields.observation ?? "live",
      wake: mergeWakeFields(DEFAULT_WAKE, fields.wake, local),
    };
    return {
      progress: mergeXsProgress(base, fields, { local, revision }),
      firstSeenAt: now,
      trackUntil: fields.activationUntil,
      claim: undefined,
    };
  }
}
