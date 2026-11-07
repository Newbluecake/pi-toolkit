/**
 * #61 decision-wake ledger (plan.md §2.2/§4, r2): a small BOUNDED request ledger — explicitly
 * NOT a work queue. Pure kernel: every side effect (persistence, host sends, timers) is an
 * injected port; P1 wires delivery, P2 wires the host/tool surface and the proof producer.
 * "Default on" (`fabric.wake.decisionRequests`) only means this kernel may be constructed with
 * `enabled:true`; it never mints budget without a host-proven human input (decision-input.ts).
 *
 * Causal isolation (plan §2.2, Root ruling a): this module has NO reference to
 * `wake-level.ts`/CausalLevel, never calls `onDelivered`, and its send ports are a DEDICATED
 * primitive (never the normal sendRootContext completion path). A decision request never raises
 * or lowers Root/child levels: Root 0 stays 0, an L4 child stays L4, unrelated spawns inherit
 * the old root level. The body record's persisted base wake is always `false`.
 *
 * At-most-once + conservative consumption (plan §4.1/§4.2):
 *  - persist BEFORE send: the first legal request atomically checkpoints proof/epoch +
 *    reservation; a wake attempt (window budget) is persisted before the host call.
 *  - unknown / post-dispatch none consume the attempt; no auto refund, retry or duplicate send;
 *    `effect none` vs `unknown` stay distinct in every receipt and never claim Root "processed".
 *  - a queued request with a recorded send attempt but no outcome restores as `unknown`
 *    (uncertain evidence forbids re-sending).
 *
 * Lazy + zero-hang: with no request there are 0 ledger writes, 0 timers, 0 budget consumption.
 * The only timer is ONE nearest-deadline timer (TTL), armed through the optional injected port,
 * its span clamped by `clampSpanMs`, disarmed/cancelled on dispose (idempotent).
 */
import { createHash } from "node:crypto";
import { clampSpanMs } from "../core/deadline.js";
import type { DecisionInputCheckpoint, DecisionInputObserver } from "./decision-input.js";
import type { RunId } from "../core/types.js";

/** Request TTL (plan §4.3): 15 min; expiry only closes, never starts a model turn. */
export const DECISION_TTL_MS = 900_000;
/** At most 32 pending requests (plan §4.3). */
export const DECISION_MAX_PENDING = 32;
/** At most 256 request entries (incl. tombstones) per Root owner; full ⇒ reject new IDs. */
export const DECISION_MAX_ENTRIES = 256;
/** Per human-input window: at most 2 decision activations, across ALL children. */
export const DECISION_WINDOW_BUDGET = 2;
/** Per human-input window: at most 1 decision activation attempt per child. */
export const DECISION_CHILD_ATTEMPTS_PER_WINDOW = 1;
/** Stable request id: 1–64 ASCII letters/digits/`_`/`-` (plan §2.1; not a credential). */
export const DECISION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Custom-entry type persisted by the P1 host adapter (append-only, `subagent:decision-wake`). */
export const DECISION_WAKE_CUSTOM_TYPE = "subagent:decision-wake";

export type DecisionRequestState = "pending" | "resolved" | "canceled" | "expired" | "closed";
/** queued = not provably dispatched · delivered · failed = post-dispatch effect none · unknown. */
export type DecisionDelivery = "queued" | "delivered" | "failed" | "unknown";
/** none = never attempted · requested = wake attempted · downgraded = deliver-only · unknown. */
export type DecisionActivation = "none" | "requested" | "downgraded" | "unknown";

export type DecisionRejectCode =
  | "disabled"
  | "id_invalid"
  | "id_conflict"
  | "pending_exists"
  | "capacity_pending"
  | "capacity_owner"
  | "not_direct_child"
  | "child_excluded"
  | "child_not_running"
  | "child_terminal"
  | "child_aborted"
  | "generation_stale"
  | "root_closing"
  | "ledger_closed"
  | "unknown_id"
  | "state"
  | "persist_failed";

/** Host send ports (P1): a DEDICATED branch — never the normal mailbox completion path. */
export interface DecisionSendPorts {
  /**
   * Deliver the request body. `wake:false` is the persisted base for EVERY decision record; a
   * wake-authorized send still passes `wake:true` only as the ephemeral turn trigger decided by
   * the ledger — the record body persisted by P1 keeps `wake:false` + decision metadata.
   */
  body(req: { id: string; runId: RunId; key: string; text: string; wake: boolean }): DecisionSendOutcome;
  /** Reference-only wake prompt: id + key reference, NEVER the body again. */
  wakeOnly(req: { id: string; runId: RunId; key: string }): DecisionSendOutcome;
  /** Root's correlated `decisionReplyTo` answer (bounded steer; reply=none, non-empty text). */
  reply(req: { id: string; runId: RunId; text: string }): DecisionSendOutcome;
}

/**
 * `stage:"prepare"` failures happened BEFORE any dispatch — conservative fail-closed: the
 * persisted attempt already counts, a mid-send crash restores as `unknown`, and there is NO
 * same-key retry entry (a repeated id only ever returns the recorded snapshot);
 * `stage:"dispatch"` means the attempt reached the host — `none`/`unknown` both consume.
 */
export interface DecisionSendOutcome {
  stage: "prepare" | "dispatch";
  effect: "sent" | "none" | "unknown";
}

/** Host-owned child facts (plan §2.2 authority checks; never model-asserted). */
export interface DecisionChildFacts {
  relation: "direct-child" | "none";
  /** Current Root owner incarnation of the tree edge. */
  owner: string;
  sessionId: string;
  generation: number;
  running: boolean;
  phase: string;
  aborted: boolean;
  /** readonly/external/no-tool runs never gain decision authority (plan §2.2). */
  excluded?: boolean;
}

export interface DecisionWakeDeps {
  sessionId: string;
  /** Root owner incarnation this ledger is bound to; a change closes everything. */
  owner: string;
  /** Effective switch: fabric.enabled ∧ wake.enabled ∧ decisionRequests (computed by the host). */
  enabled: boolean;
  input: DecisionInputObserver;
  childOf(runId: RunId): DecisionChildFacts | undefined;
  /** "live" only admits; closing/fenced reject and revoke pending wake rights. */
  rootState(): "live" | "closing" | "fenced";
  /** Atomic append; a throw is fail-closed (no send, no budget right). */
  persist(entry: DecisionWakeEntry): void;
  /** Session entries (`getEntries()`), pre-filtered to nothing — the ledger folds by shape. */
  restoreEntries(): ReadonlyArray<{ type: string; customType?: string; data?: unknown }>;
  send: DecisionSendPorts;
  now(): number;
  /** Optional nearest-deadline timer port (unref'd by the P1 host); absent ⇒ none armed. */
  setTimer?(ms: number, fn: () => void): { cancel(): void };
  /** Test knobs (production: plan §4.3 values). */
  ttlMs?: number;
  maxPending?: number;
  maxEntries?: number;
  windowBudget?: number;
}

export type DecisionWakeEntry =
  | {
      kind: "checkpoint";
      v: 1;
      sessionId: string;
      owner: string;
      /** Activated high-watermark — never lowered, never TTL-forgotten (plan §4.3). */
      epoch: number;
      inputId: string;
      /** Window consumption of epoch `epoch`. */
      used: number;
      /** runId → epoch of that child's last activation attempt. */
      childAttempts: Readonly<Record<string, number>>;
      /** Bounded seen-inputId digest restored into the input observer. */
      seen: ReadonlyArray<string>;
    }
  | {
      kind: "request";
      v: 1;
      sessionId: string;
      owner: string;
      id: string;
      runId: RunId;
      /** Ledger-internal stable key (id + content hash anchor); the fabric MessageKey is P1's. */
      key: string;
      contentHash: string;
      state: DecisionRequestState;
      delivery: DecisionDelivery;
      activation: DecisionActivation;
      reason?: string;
      createdAt: number;
      expiresAt: number;
      windowEpoch: number;
      attempts: { body: number; wake: number; reply: number };
      generation: number;
    };

export interface DecisionSnapshot {
  id: string;
  runId: RunId;
  state: DecisionRequestState;
  delivery: DecisionDelivery;
  activation: DecisionActivation;
  reason?: string;
  key?: string;
  windowEpoch: number;
}

export type DecisionReceipt =
  { ok: true; decision: DecisionSnapshot } | { ok: false; code: DecisionRejectCode; reason?: string };

export function isValidDecisionId(id: unknown): id is string {
  return typeof id === "string" && DECISION_ID_RE.test(id);
}

export function decisionContentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface LiveRequest {
  id: string;
  runId: RunId;
  key: string;
  contentHash: string;
  state: DecisionRequestState;
  delivery: DecisionDelivery;
  activation: DecisionActivation;
  reason?: string;
  createdAt: number;
  expiresAt: number;
  windowEpoch: number;
  attempts: { body: number; wake: number; reply: number };
  generation: number;
}

export function createDecisionWakeLedger(deps: DecisionWakeDeps): DecisionWakeLedger {
  const ttlMs = deps.ttlMs ?? DECISION_TTL_MS;
  const maxPending = deps.maxPending ?? DECISION_MAX_PENDING;
  const maxEntries = deps.maxEntries ?? DECISION_MAX_ENTRIES;
  const windowBudget = deps.windowBudget ?? DECISION_WINDOW_BUDGET;

  const requests = new Map<string, LiveRequest>();
  /** runId → set of pending ids (single-pending-per-child check). */
  const pendingByChild = new Map<RunId, Set<string>>();
  let activated = false;
  /** PUBLISHED window epoch (a proven-but-unpublished newer epoch grants nothing yet). */
  let windowEpoch = 0;
  let windowUsed = 0;
  /** runId → the epoch whose window that child already burned its attempt in. */
  const childAttempts = new Map<RunId, number>();
  let closed = false;
  let timer: { cancel(): void } | undefined;

  const snapshotOf = (r: LiveRequest): DecisionSnapshot => ({
    id: r.id,
    runId: r.runId,
    state: r.state,
    delivery: r.delivery,
    activation: r.activation,
    ...(r.reason !== undefined ? { reason: r.reason } : {}),
    ...(r.key !== undefined ? { key: r.key } : {}),
    windowEpoch: r.windowEpoch,
  });

  const persistOrThrow = (entry: DecisionWakeEntry): void => {
    deps.persist(entry);
  };

  const checkpointEntry = (): DecisionWakeEntry => ({
    kind: "checkpoint",
    v: 1,
    sessionId: deps.sessionId,
    owner: deps.owner,
    epoch: windowEpoch,
    inputId: deps.input.current()?.inputId ?? "",
    used: windowUsed,
    childAttempts: Object.fromEntries(childAttempts),
    seen: deps.input.checkpoint().seen,
  });

  const persistRequest = (r: LiveRequest): void => {
    persistOrThrow({ kind: "request", v: 1, sessionId: deps.sessionId, owner: deps.owner, ...r });
  };

  /** Publish a NEWER proven epoch as the current window: persist FIRST, then grant its fresh
   *  budget (plan §3 “已激活后：先持久化新 epoch，再发布新窗额度”); a persist failure keeps
   *  the old published window — the new epoch is retried on the next call, never gifted. */
  const syncWindow = (): void => {
    const proof = deps.input.current();
    if (proof === undefined || !activated || proof.epoch <= windowEpoch) return;
    const prev = { epoch: windowEpoch, used: windowUsed };
    windowEpoch = proof.epoch;
    windowUsed = 0;
    try {
      persistOrThrow(checkpointEntry());
    } catch {
      windowEpoch = prev.epoch;
      windowUsed = prev.used;
    }
  };

  const armTimer = (): void => {
    if (deps.setTimer === undefined) return;
    timer?.cancel();
    timer = undefined;
    let nearest: number | undefined;
    for (const r of requests.values())
      if (r.state === "pending") nearest = nearest === undefined ? r.expiresAt : Math.min(nearest, r.expiresAt);
    if (nearest === undefined) return;
    const span = clampSpanMs(Math.max(1, nearest - deps.now()));
    if (span === undefined) {
      expireDue();
      return;
    }
    timer = deps.setTimer(span, () => {
      timer = undefined;
      expireDue();
    });
  };

  const expireDue = (): void => {
    const now = deps.now();
    let changed = false;
    for (const r of requests.values()) {
      if (r.state !== "pending" || r.expiresAt > now) continue;
      r.state = "expired";
      unpublishPending(r);
      r.reason = "ttl";
      changed = true;
      try {
        persistRequest(r);
      } catch {
        /* the tombstone is best-effort here; the in-memory state is authoritative for reads */
      }
    }
    if (changed) armTimer();
  };

  const unpublishPending = (r: LiveRequest): void => {
    const set = pendingByChild.get(r.runId);
    set?.delete(r.id);
    if (set !== undefined && set.size === 0) pendingByChild.delete(r.runId);
  };

  /** Child authority gate (plan §2.2): current owner, current session, live generation,
   *  direct edge, running, not aborted/terminal, not excluded. */
  const childGate = (
    runId: RunId,
    generation?: number,
  ): { ok: true; facts: DecisionChildFacts } | { ok: false; code: DecisionRejectCode } => {
    const facts = deps.childOf(runId);
    if (facts === undefined || facts.relation !== "direct-child") return { ok: false, code: "not_direct_child" };
    if (facts.owner !== deps.owner || facts.sessionId !== deps.sessionId)
      return { ok: false, code: "not_direct_child" };
    if (facts.excluded === true) return { ok: false, code: "child_excluded" };
    if (facts.aborted) return { ok: false, code: "child_aborted" };
    if (facts.phase === "terminal") return { ok: false, code: "child_terminal" };
    if (!facts.running) return { ok: false, code: "child_not_running" };
    if (generation !== undefined && facts.generation !== generation) return { ok: false, code: "generation_stale" };
    return { ok: true, facts };
  };

  /** Window eligibility: only the CURRENT published epoch, budget left, child not yet attempted. */
  const windowGate = (
    runId: RunId,
  ): { ok: true } | { ok: false; reason: "no_human_proof" | "no_budget" | "child_attempted" | "stale_epoch" } => {
    const proof = deps.input.current();
    if (proof === undefined) return { ok: false, reason: "no_human_proof" };
    if (proof.epoch !== windowEpoch) return { ok: false, reason: "stale_epoch" };
    if (windowUsed >= windowBudget) return { ok: false, reason: "no_budget" };
    if (childAttempts.get(runId) === proof.epoch) return { ok: false, reason: "child_attempted" };
    return { ok: true };
  };

  const consumeAttempt = (runId: RunId): boolean => {
    const proof = deps.input.current();
    const prevAttempt = childAttempts.get(runId);
    windowUsed += 1;
    childAttempts.set(runId, proof?.epoch ?? windowEpoch);
    try {
      persistOrThrow(checkpointEntry());
      return true;
    } catch {
      // Persist failed ⇒ the attempt never linearized: roll the consumption back.
      windowUsed -= 1;
      if (prevAttempt === undefined) childAttempts.delete(runId);
      else childAttempts.set(runId, prevAttempt);
      return false;
    }
  };

  const settleSend = (
    r: LiveRequest,
    outcome: DecisionSendOutcome,
    wakeAuthorized: boolean,
    post: "body" | "wake" | "reply",
  ): DecisionSnapshot => {
    if (outcome.stage === "prepare") {
      // Pre-dispatch failure: conservative fail-closed — the attempt was already persisted
      // before the host call, so a crash in this window restores as `unknown`; nothing claimed
      // as delivered and NO same-key retry entry exists (repeat ids only return the snapshot).
      r.reason = post === "body" ? "prepare_failed" : post === "wake" ? "wake_prepare_failed" : "reply_prepare_failed";
      if (post !== "body") r.activation = wakeAuthorized ? "downgraded" : r.activation;
    } else if (outcome.effect === "sent") {
      if (post === "body") {
        r.delivery = "delivered";
        r.activation = wakeAuthorized ? "requested" : r.activation === "downgraded" ? "downgraded" : "none";
        // keep the downgrade reason (why the wake was NOT attempted) on a delivered record
        if (r.activation !== "downgraded") delete r.reason;
      } else if (post === "wake") {
        delete r.reason;
        r.activation = "requested";
      } else {
        r.state = "resolved";
        delete r.reason;
        unpublishPending(r);
      }
    } else if (outcome.effect === "none") {
      if (post === "body") {
        r.delivery = "failed";
        if (wakeAuthorized) r.activation = "downgraded";
        if (r.reason === undefined) r.reason = "effect_none";
      } else if (post === "wake") {
        r.activation = "downgraded";
        r.reason = "effect_none";
      } else {
        // reply effect none (post-dispatch): the request stays pending but loses wake rights.
        r.reason = "reply_effect_none";
      }
    } else {
      if (post === "body") {
        r.delivery = "unknown";
        if (wakeAuthorized) r.activation = "unknown";
      } else if (post === "wake") {
        r.activation = "unknown";
      } else {
        r.reason = "reply_unknown";
      }
      if (post !== "reply") r.reason = "unknown";
    }
    try {
      persistRequest(r);
    } catch {
      /* audit-only; the in-memory state stays authoritative and conservative */
    }
    return snapshotOf(r);
  };

  const ledger: DecisionWakeLedger = {
    request({ id, runId, text }) {
      if (closed) return { ok: false, code: "ledger_closed" };
      if (!deps.enabled) return { ok: false, code: "disabled" };
      if (!isValidDecisionId(id)) return { ok: false, code: "id_invalid" };
      const existing = requests.get(id);
      const hash = decisionContentHash(text);
      if (existing !== undefined) {
        if (existing.contentHash !== hash) return { ok: false, code: "id_conflict" };
        return { ok: true, decision: snapshotOf(existing) };
      }
      if (deps.rootState() !== "live") return { ok: false, code: "root_closing" };
      const gate = childGate(runId);
      if (!gate.ok) return { ok: false, code: gate.code };
      if (pendingByChild.get(runId)?.size) return { ok: false, code: "pending_exists" };
      let pendingCount = 0;
      for (const r of requests.values()) if (r.state === "pending") pendingCount += 1;
      if (pendingCount >= maxPending) return { ok: false, code: "capacity_pending" };
      if (requests.size >= maxEntries) return { ok: false, code: "capacity_owner" };

      const now = deps.now();
      const proof = deps.input.current();
      // LAZY ACTIVATION: the first legal request publishes the CURRENT proof epoch as the
      // window (before the gate reads it); the checkpoint+reservation persist happens below,
      // BEFORE any send — a persist failure admits nothing and grants no budget right (plan §3).
      if (!activated) {
        windowEpoch = proof?.epoch ?? 0;
        windowUsed = 0;
      }
      syncWindow();
      const win = windowGate(runId);
      const r: LiveRequest = {
        id,
        runId,
        key: `${id}#${hash.slice(0, 12)}`,
        contentHash: hash,
        state: "pending",
        delivery: "queued",
        activation: "none",
        createdAt: now,
        expiresAt: now + (clampSpanMs(ttlMs) ?? ttlMs),
        windowEpoch: proof?.epoch ?? windowEpoch,
        attempts: { body: 0, wake: 0, reply: 0 },
        generation: gate.facts.generation,
      };
      // LAZY ACTIVATION: the first legal request checkpoints proof + reservation BEFORE any
      // send; a persist failure admits nothing and grants no budget right (plan §3).
      if (!activated) {
        try {
          persistOrThrow(checkpointEntry());
          persistRequest(r);
        } catch {
          return { ok: false, code: "persist_failed", reason: "activation_checkpoint" };
        }
        activated = true;
      } else {
        try {
          persistRequest(r);
        } catch {
          return { ok: false, code: "persist_failed", reason: "reserve" };
        }
      }
      requests.set(r.id, r);
      publishPending(r);
      armTimer();

      if (win.ok) {
        if (!consumeAttempt(runId)) {
          // Attempt checkpoint failed ⇒ no wake right; the body still goes deliver-only.
          r.activation = "downgraded";
          r.reason = "persist_failed";
        }
      } else {
        r.activation = "downgraded";
        r.reason = win.reason;
      }
      const wakeAuthorized = win.ok && r.activation !== "downgraded";
      // At-most-once (plan §4.1 “先写 attempt，再调用宿主”): the BODY dispatch attempt is durable
      // BEFORE the host call — a crash between this persist and the outcome leaves
      // queued+attempt>0, which restores as `unknown` (never re-sent). Persist failure ⇒ 0 send.
      r.attempts.body += 1;
      try {
        persistRequest(r);
      } catch {
        r.attempts.body -= 1;
        return { ok: false, code: "persist_failed", reason: "body_attempt" };
      }
      const outcome = deps.send.body({ id, runId, key: r.key, text, wake: wakeAuthorized });
      return { ok: true, decision: settleSend(r, outcome, wakeAuthorized, "body") };
    },

    wake({ id, runId }) {
      if (closed) return { ok: false, code: "ledger_closed" };
      if (!deps.enabled) return { ok: false, code: "disabled" };
      const r = requests.get(id);
      if (r === undefined) return { ok: false, code: "unknown_id" };
      if (r.runId !== runId) return { ok: false, code: "unknown_id" };
      if (r.state !== "pending") return { ok: false, code: "state", reason: r.state };
      // any prior reply attempt (reply_unknown, incl. restored ones) keeps the pending slot and
      // PERMANENTLY blocks further decision wake for this request (plan §4.2) — only TTL/child
      // cancel release it.
      if (r.attempts.reply > 0) return { ok: true, decision: snapshotOf(r) };
      // wake-only requires a KNOWN-delivered body (unknown delivery forbids wake retry).
      if (r.delivery !== "delivered") return { ok: true, decision: snapshotOf(r) };
      const already = childAttempts.get(runId);
      const proof = deps.input.current();
      if (proof !== undefined && already !== undefined && already === proof.epoch)
        return { ok: true, decision: snapshotOf(r) }; // same-window re-attempt: snapshot only
      syncWindow();
      const gate = childGate(runId, r.generation);
      if (!gate.ok) return { ok: false, code: gate.code };
      const win = windowGate(runId);
      if (!win.ok) {
        r.activation = r.activation === "unknown" ? "unknown" : "downgraded";
        r.reason = r.activation === "unknown" ? "unknown" : win.reason;
        return { ok: true, decision: snapshotOf(r) };
      }
      if (!consumeAttempt(runId)) {
        r.activation = r.activation === "unknown" ? "unknown" : "downgraded";
        r.reason = "persist_failed";
        return { ok: true, decision: snapshotOf(r) };
      }
      r.attempts.wake += 1;
      const outcome = deps.send.wakeOnly({ id, runId, key: r.key });
      return { ok: true, decision: settleSend(r, outcome, true, "wake") };
    },

    status({ id }) {
      expireDue();
      const r = requests.get(id);
      if (r === undefined) return { ok: false, code: "unknown_id" };
      return { ok: true, decision: snapshotOf(r) };
    },

    cancel({ id, runId }) {
      if (closed) return { ok: false, code: "ledger_closed" };
      const r = requests.get(id);
      if (r === undefined) return { ok: false, code: "unknown_id" };
      if (r.runId !== runId) return { ok: false, code: "unknown_id" };
      if (r.state !== "pending") return { ok: false, code: "state", reason: r.state };
      const gate = childGate(runId);
      if (!gate.ok) return { ok: false, code: gate.code };
      r.state = "canceled";
      unpublishPending(r);
      r.reason = "canceled";
      try {
        persistRequest(r);
      } catch {
        /* tombstone best-effort */
      }
      armTimer();
      return { ok: true, decision: snapshotOf(r) };
    },

    resolve({ id, runId, owner, text }) {
      if (closed) return { ok: false, code: "ledger_closed" };
      if (owner !== deps.owner) return { ok: false, code: "state", reason: "owner" };
      const r = requests.get(id);
      if (r === undefined) return { ok: false, code: "unknown_id" };
      if (r.runId !== runId) return { ok: false, code: "unknown_id" };
      if (r.state !== "pending") return { ok: false, code: "state", reason: r.state };
      const gate = childGate(runId, r.generation);
      if (!gate.ok) return { ok: false, code: gate.code };
      // A PRIOR correlated reply attempt exists (possibly interrupted mid-dispatch): its outcome
      // is unknown — report it, never steer twice (plan §4.2 reply_unknown: the slot stays
      // pending, no further decision wake, TTL/child cancel release it).
      if (r.attempts.reply > 0) {
        if (r.reason === undefined) r.reason = "reply_unknown";
        return { ok: true, decision: snapshotOf(r) };
      }
      // At-most-once: the reply attempt is durable BEFORE the host steer call.
      r.attempts.reply += 1;
      try {
        persistRequest(r);
      } catch {
        r.attempts.reply -= 1;
        return { ok: false, code: "persist_failed", reason: "reply_attempt" };
      }
      const outcome = deps.send.reply({ id, runId, text });
      return { ok: true, decision: settleSend(r, outcome, false, "reply") };
    },

    onChildTerminal(runId) {
      for (const r of requests.values()) {
        if (r.runId !== runId || r.state !== "pending") continue;
        r.state = "closed";
        unpublishPending(r);
        r.reason = "child_terminal";
        try {
          persistRequest(r);
        } catch {
          /* best-effort */
        }
      }
      armTimer();
    },

    closeAll(reason) {
      for (const r of requests.values()) {
        if (r.state !== "pending") continue;
        r.state = "closed";
        r.reason = reason;
        try {
          persistRequest(r);
        } catch {
          /* best-effort */
        }
      }
      pendingByChild.clear();
      // ANY close reason ends this ledger: the old closure must be unusable (plan §4.2 “旧闭包
      // 不可用”) — the next stack builds a fresh ledger and restores from the entries.
      closed = true;
      timer?.cancel();
      timer = undefined;
    },

    restore() {
      for (const raw of deps.restoreEntries()) {
        if (raw.type !== "custom" || raw.customType !== DECISION_WAKE_CUSTOM_TYPE) continue;
        const data = raw.data as DecisionWakeEntry | undefined;
        if (!data || data.v !== 1 || data.sessionId !== deps.sessionId || data.owner !== deps.owner) continue;
        if (data.kind === "checkpoint") {
          activated = true;
          // Append-only fold: the LAST checkpoint wins (same-epoch consumption updates included).
          windowEpoch = data.epoch;
          windowUsed = data.used;
          for (const [runId, epoch] of Object.entries(data.childAttempts ?? {}))
            childAttempts.set(runId as RunId, epoch);
          // the observer re-learns its high-watermark anchor (inputId + seen) from the same
          // entry — a same-sid reload keeps the PUBLISHED window eligible for its REMAINING
          // budget (never a wash), while a fresh/other-session observer grants nothing.
          try {
            deps.input.restore({
              v: 1,
              sessionId: data.sessionId,
              owner: data.owner,
              epoch: data.epoch,
              inputId: data.inputId,
              seen: [...(data.seen ?? [])],
            });
          } catch {
            /* a throwing observer restore must never break ledger reconciliation */
          }
          continue;
        }
        const r: LiveRequest = { ...data, attempts: { ...data.attempts } };
        // Uncertain send evidence restores as unknown — never re-send (plan §4.1).
        if (r.state === "pending" && r.delivery === "queued" && r.attempts.body > 0) r.delivery = "unknown";
        // A persisted-but-unresolved reply attempt restores as reply_unknown: the slot stays
        // pending, further decision wake is blocked, and a repeated correlated resolve only
        // reports the original unknown — never a second steer.
        if (r.state === "pending" && r.attempts.reply > 0 && r.reason === undefined) r.reason = "reply_unknown";
        requests.set(r.id, r);
        if (r.state === "pending") {
          if (r.expiresAt <= deps.now()) {
            r.state = "expired";
            r.reason = "ttl";
          } else {
            publishPending(r);
          }
        }
      }
      armTimer();
    },

    dispose() {
      if (closed) {
        timer?.cancel();
        timer = undefined;
        return;
      }
      ledger.closeAll("dispose");
      deps.input.freeze();
    },

    get activated() {
      return activated;
    },

    entries(): DecisionWakeEntry[] {
      return [...requests.values()].map((r) => ({
        kind: "request",
        v: 1,
        sessionId: deps.sessionId,
        owner: deps.owner,
        ...r,
      }));
    },

    window(): { epoch: number; used: number } {
      return { epoch: windowEpoch, used: windowUsed };
    },
  };

  function publishPending(r: LiveRequest): void {
    let set = pendingByChild.get(r.runId);
    if (set === undefined) {
      set = new Set();
      pendingByChild.set(r.runId, set);
    }
    set.add(r.id);
  }

  return ledger;
}

export interface DecisionWakeLedger {
  /** Child → Root: file/admit an explicit blocking decision request (at-most-once body). */
  request(req: { id: string; runId: RunId; text: string }): DecisionReceipt;
  /** Child → Root: reference-only wake retry (needs delivered body + fresh window). */
  wake(req: { id: string; runId: RunId }): DecisionReceipt;
  /** Pure snapshot; never extends TTL, never resets budget. */
  status(req: { id: string }): DecisionReceipt;
  /** Child cancels its own pending request (tombstone keeps the id deduped until TTL). */
  cancel(req: { id: string; runId: RunId }): DecisionReceipt;
  /** Root's correlated reply (decisionReplyTo). Normal steer never reaches here. */
  resolve(req: { id: string; runId: RunId; owner: string; text: string }): DecisionReceipt;
  /** Host hook: a child went terminal/aborted — close its pending requests. */
  onChildTerminal(runId: RunId): void;
  /** Host hook: root abort / session switch/new/fork / reload owner change / dispose. */
  closeAll(
    reason: "root_abort" | "session_switch" | "session_new" | "session_fork" | "reload_owner_change" | "dispose",
  ): void;
  /** Reload reconciliation: fold persisted entries (owner-mismatched entries grant nothing). */
  restore(): void;
  /** Teardown: closeAll(dispose) + freeze proofs + cancel the timer. Idempotent. */
  dispose(): void;
  /** Whether the lazy activation checkpoint has ever been persisted. */
  readonly activated: boolean;
  /** Inspection (tests/audit): the current request entries. */
  entries(): DecisionWakeEntry[];
  /** Inspection: current window high-watermark. */
  window(): { epoch: number; used: number };
}
