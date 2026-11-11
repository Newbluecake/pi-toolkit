import { readBeforeAgentStartTrigger, readContextTrailingCustom } from "../adapters/pi-compat.js";
import { systemClock, type Clock, type TimerHandle } from "../core/clock.js";
import { clampSpanMs } from "../core/deadline.js";
import { newRunId } from "../core/ids.js";
import type { XsNoneReason, XsWakeDowngraded } from "../web-hub/protocol/xs.js";
import { classifyHumanInput, type WakeInputEvent } from "./wake-input.js";
import type { CausalLevel } from "./wake-level.js";
import { getXsHostCapability, type XsHostCapability } from "./xs/host-cap.js";
import { getXsWakeLedger, type XsWakeLedger, type XsWakeRecord } from "./xs/wake-ledger.js";
import type { XsBroadcastMark } from "./xs/types-channel.js";

export const XS_WAKE_CUSTOM_TYPE = "subagent:xs";
export const ROOT_WAKE_IDLE_POLL_MS = 2_000;
export const ROOT_WAKE_SLOW_START_MS = 10_000;
export const ROOT_WAKE_ABORT_GRACE_MS = 10_000;
export type RootWakeState = "idle" | "starting" | "deferred" | "bound" | "handedOver" | "aborting" | "stuck";
export type RootWakeAudit =
  | "wake_slow_start"
  | "wake_foreign_start"
  | "wake_lost_after_accept"
  | "wake_end_unobserved"
  | "wake_late_aborted"
  | "wake_orphan_aborted"
  | "wake_optimistic_dispatch"
  | "wake_shape_absent_aborted"
  | "wake_shape_absent_handed"
  | "abortStuck"
  | "wake_abort_error";
export type RootWakeAuditPort = (event: RootWakeAudit, token: string | undefined) => void;
type LevelPort = Pick<CausalLevel, "raise" | "hopAllowed">;
type AbortPort = () => void | Promise<void>;
/**
 * wake-unknown-optimistic §1.4: one abort attempt for a (possibly unknown) trigger. Returns whether
 * THIS call actually issued the abort (false ⇒ already issued this run; do not audit twice).
 */
export type OrphanAbortPort = (token: string | undefined) => boolean;

function note(audit: RootWakeAuditPort | undefined, event: RootWakeAudit, token?: string): void {
  try {
    audit?.(event, token);
  } catch {
    /* diagnostics cannot affect supervision */
  }
}

/** Fire and forget. A never-settling abort promise cannot block hooks, admission or disposal. */
function abortNow(abort: AbortPort, audit: RootWakeAuditPort | undefined, token?: string): void {
  try {
    const pending = abort();
    if (pending) void pending.catch(() => note(audit, "wake_abort_error", token));
  } catch {
    note(audit, "wake_abort_error", token);
  }
}

function commitLevel(ledger: XsWakeLedger, record: XsWakeRecord, level?: LevelPort): void {
  if (record.levelCommitted || (record.level !== undefined && level === undefined)) return;
  // No stack/level port yet: leave the hop uncommitted for recovery, not silently lost.
  // Commit the bit FIRST: reentrant hooks / stack recovery must never re-raise after a human reset.
  ledger.update(record.token, { levelCommitted: true });
  if (record.level !== undefined) level?.raise("root", record.level + (record.levelMode === "return" ? 0 : 1));
}

export interface RootWakeTriggerDeps {
  sessionId: string;
  abort: AbortPort;
  ledger?: XsWakeLedger;
  capability?: XsHostCapability;
  clock?: Clock;
  level?: LevelPort;
  audit?: RootWakeAuditPort;
  /** wake-unknown-optimistic: supervised orphan/late abort (activation-level watch). Default: raw abort + true. */
  orphan?: OrphanAbortPort;
  warn?: (message: string) => void;
}

export type RootWakeTriggerResult =
  { kind: "other" } | { kind: "authorized"; token: string } | { kind: "aborted"; token?: string };

/**
 * B1 process hook. XW MUST call this in before_agent_start even when no stack/controller is
 * available. It reads the dedicated marker before any provider request. No authorization =>
 * abort, including malformed/missing tokens and a different session's token, human present or not.
 * XW calls controller.beforeAgentStart when available, this function otherwise (not both).
 * Ledger-backed abort issuance is idempotent; an unknown orphan is denied on EVERY occurrence.
 */
export function observeRootWakeTrigger(event: unknown, deps: RootWakeTriggerDeps): RootWakeTriggerResult {
  const ledger = deps.ledger ?? getXsWakeLedger();
  const capability = deps.capability ?? getXsHostCapability();
  capability.observe(event);
  const trigger = readBeforeAgentStartTrigger(event);
  if (trigger.kind !== "custom" || trigger.customType !== XS_WAKE_CUSTOM_TYPE) return { kind: "other" };
  const details = trigger.details as { xsWake?: unknown; wakeToken?: unknown } | null | undefined;
  if (details?.xsWake !== true) return { kind: "other" };
  const token = typeof details.wakeToken === "string" ? details.wakeToken : undefined;
  const record = token === undefined ? undefined : ledger.get(token);
  const now = (deps.clock ?? systemClock).now();
  const orphan = deps.orphan ?? ((t: string | undefined) => (abortNow(deps.abort, deps.audit, t), true));
  if (record === undefined || record.sessionId !== deps.sessionId) {
    if (orphan(token)) note(deps.audit, "wake_orphan_aborted", token);
    return token === undefined ? { kind: "aborted" } : { kind: "aborted", token };
  }
  if (record.handed && record.state !== "live") {
    // wake-unknown-optimistic §1.2/§6.2 (handedOver row): a handed-over token is NEVER aborted on
    // sight — the run belongs to the human. Recover's idle-revoke can tombstone a handed record;
    // sighting it again only marks the first gate sight (linearization) and stays silent.
    ledger.update(record.token, { gateSightAt: record.gateSightAt ?? now });
    return { kind: "other" };
  }
  if (
    record.state === "tombstone" ||
    record.abortIssuedAt !== undefined ||
    (!record.handed && now >= record.deadlineAt)
  ) {
    ledger.tombstone(record.token);
    // Seeing the trigger proves it is now executing, not that abort has physically completed.
    // gateSightAt (write-once) linearizes which guard saw this trigger first (§1.3).
    ledger.update(record.token, { started: true, executionPending: true, gateSightAt: record.gateSightAt ?? now });
    // An earlier watchdog abort of a PRESUMED foreign run is not proof this delayed action
    // was aborted. Its first actual sight still needs a synchronous abort (B1).
    if (record.abortIssuedAt === undefined || !record.started) {
      ledger.update(record.token, { abortIssuedAt: now });
      note(deps.audit, "wake_late_aborted", token);
      abortNow(deps.abort, deps.audit, token);
    }
    return { kind: "aborted", token: record.token };
  }
  // handed is only set AFTER started, never for deferred human input (r3 B1).
  ledger.update(record.token, {
    started: true,
    executionPending: true,
    boundAt: record.boundAt ?? now,
    authorizedAt: now,
  });
  capability.verify();
  commitLevel(ledger, record, deps.level);
  return { kind: "authorized", token: record.token };
}

/**
 * wake-unknown-optimistic §1.1 observation point 2: the `context` hook — fired before EVERY LLM
 * call on ALL hosts (legacy included). O(1): reads only the trailing message. A marked tail whose
 * token is not authorized for THIS session aborts fail-closed before the provider request;
 * an authorized live token is a no-op. Never returns a payload: messages and the provider cache
 * prefix stay byte-identical. Counting/linearization rules are §1.3, written once via gateSightAt.
 */
export function guardRootWakeContext(event: unknown, deps: RootWakeTriggerDeps): RootWakeTriggerResult {
  const ledger = deps.ledger ?? getXsWakeLedger();
  const capability = deps.capability ?? getXsHostCapability();
  const tail = readContextTrailingCustom(event);
  if (tail?.customType !== XS_WAKE_CUSTOM_TYPE) return { kind: "other" };
  const d = tail.details as { xsWake?: unknown; wakeToken?: unknown; xid?: unknown } | null | undefined;
  if (d === null || typeof d !== "object" || d.xsWake !== true) return { kind: "other" };
  const token = typeof d.wakeToken === "string" ? d.wakeToken : undefined;
  const orphan = deps.orphan ?? ((t: string | undefined) => (abortNow(deps.abort, deps.audit, t), true));
  const record = token === undefined ? undefined : ledger.get(token);
  if (record === undefined || record.sessionId !== deps.sessionId || record.xid !== d.xid) {
    if (orphan(token)) note(deps.audit, "wake_orphan_aborted", token);
    return token === undefined ? { kind: "aborted" } : { kind: "aborted", token };
  }
  if (record.state === "live" && record.authorizedAt !== undefined && record.abortIssuedAt === undefined)
    return { kind: "authorized", token: record.token };
  if (record.gateSightAt !== undefined)
    return record.handed ? { kind: "other" } : { kind: "aborted", token: record.token };
  const now = (deps.clock ?? systemClock).now();
  const basNeverSaw = record.authorizedAt === undefined; // gateSightAt is still undefined here
  if (basNeverSaw) capability.triggerSkipped(deps.warn);
  if (record.handed) {
    // Human already owns this run: the hop is void, never abort (§1.2 row "handedOver").
    ledger.update(record.token, { gateSightAt: now, levelCommitted: true });
    note(deps.audit, "wake_shape_absent_handed", record.token);
    return { kind: "other" };
  }
  const issue = record.abortIssuedAt === undefined || !record.started;
  ledger.tombstone(record.token);
  ledger.update(record.token, {
    started: true,
    executionPending: true,
    levelCommitted: true,
    gateSightAt: now,
    ...(issue ? { abortIssuedAt: now } : {}),
  });
  if (issue) {
    note(deps.audit, basNeverSaw ? "wake_shape_absent_aborted" : "wake_late_aborted", record.token);
    abortNow(deps.abort, deps.audit, record.token);
  }
  return { kind: "aborted", token: record.token };
}

/**
 * wake-unknown-optimistic §1.4: activation-level supervision for every abort issued where no
 * RootWakeController is reachable — the pre-stack window, after session_shutdown, and ALL orphan
 * aborts (controller-path ones too, injected via `StackXsInput.abortOrphan`). Mirrors the
 * controller's aborting/stuck pair: `issue` dedups per run (latch), arms the ROOT_WAKE_ABORT_GRACE_MS
 * grace timer plus the 2s two-idle observation; grace expiry only audits `abortStuck` + warns once
 * (NEVER a second abort); `settled`/`runStarted` (a new run's BAS hook entry) or two consecutive
 * idle observations release the latch; `dispose` (session_shutdown) clears the timers. Held in the
 * activation closure, never module state (I4). All timers through Clock (systemClock: segmented +
 * unref), durations clamped via clampSpanMs (I1, I5).
 */
export interface RootWakeOrphanWatchDeps {
  clock?: Clock;
  audit?: RootWakeAuditPort;
  warn?: (message: string) => void;
}

export class RootWakeOrphanWatch {
  private readonly clock: Clock;
  private latched = false;
  private idleObservations = 0;
  private graceTimer: TimerHandle | undefined;
  private idleTimer: TimerHandle | undefined;
  private idlePort: { isIdle: () => boolean } | undefined;

  constructor(private readonly deps: RootWakeOrphanWatchDeps = {}) {
    this.clock = deps.clock ?? systemClock;
  }

  get pending(): boolean {
    return this.latched;
  }

  /** Returns false when an abort was already issued for this run (per-run dedup, §1.3). */
  issue(port: { abort: AbortPort; isIdle: () => boolean }, token?: string): boolean {
    if (this.latched) return false;
    this.latched = true;
    this.idleObservations = 0;
    abortNow(port.abort, this.deps.audit, token);
    this.idlePort = port;
    const grace = clampSpanMs(ROOT_WAKE_ABORT_GRACE_MS);
    if (grace !== undefined)
      this.graceTimer = this.clock.setTimer(grace, () => {
        this.graceTimer = undefined;
        if (!this.latched) return;
        note(this.deps.audit, "abortStuck", token);
        try {
          (this.deps.warn ?? console.warn)("[pi-subagent] xs wake orphan abort stuck; further wakes are deliver-only");
        } catch {
          /* diagnostic only */
        }
        // No second abort: keep only the idle observation.
      });
    this.pollIdle();
    return true;
  }

  /** A new run started (BAS hook entry): release the latch so its orphans abort again. */
  runStarted(): void {
    this.release();
  }

  settled(): void {
    this.release();
  }

  dispose(): void {
    this.release();
  }

  private pollIdle(): void {
    const poll = clampSpanMs(ROOT_WAKE_IDLE_POLL_MS);
    const port = this.idlePort;
    if (poll === undefined || port === undefined) return;
    const tick = (): void => {
      this.idleTimer = undefined;
      if (!this.latched) return;
      let idle = false;
      try {
        idle = port.isIdle();
      } catch {
        idle = false; // a throwing port must not wedge the watch
      }
      this.idleObservations = idle ? this.idleObservations + 1 : 0;
      if (this.idleObservations >= 2) this.release();
      else this.idleTimer = this.clock.setTimer(poll, tick);
    };
    this.idleTimer = this.clock.setTimer(poll, tick);
  }

  private release(): void {
    this.clearTimers();
    this.latched = false;
    this.idleObservations = 0;
    this.idlePort = undefined;
  }

  private clearTimers(): void {
    for (const timer of [this.graceTimer, this.idleTimer]) {
      if (timer !== undefined) this.clock.clearTimer(timer);
    }
    this.graceTimer = this.idleTimer = undefined;
  }
}

export interface RootWakeMessage {
  customType: typeof XS_WAKE_CUSTOM_TYPE;
  content: string;
  display: true;
  details: {
    xsWake: true;
    xid: string;
    from: unknown;
    wakeToken: string;
    level?: number;
    reply?: { requestId: string; dueAt: number };
    inReplyTo?: string;
    /** Channel-plan §5.3 (评审 #14): broadcast marker — details only, never the provider payload (C-X9). */
    bc?: XsBroadcastMark;
    /** fabric-xs-activation P3: set ONLY on a host control marker — the original messageId it activates. */
    activateFor?: string;
  };
}

/** fabric-xs-activation P3 (arch §4.5): the FIXED, body-free content of an activation marker. It
 *  names no caller, header, request id, alias, key or token — only that the host asks the model
 *  to process an already-delivered, still-unprocessed cross-session request. */
export const XS_ACTIVATE_MARKER_CONTENT =
  "Host activation: process the cross-session request that was already delivered to this session and has not been handled yet. Its content is already in the conversation; do not repeat anything that was already handled.";

export type RootWakeEnded = "settled" | "aborted" | "deadline" | "stuck";

export interface RootWakeRequest {
  reply?: { requestId: string; dueAt: number };
  inReplyTo?: string;
  solicited?: true;
  returnLevel?: number;
  xid: string;
  from: unknown;
  content: string;
  expiresAt: number;
  level?: number;
  /** Channel-plan §5.3: threaded verbatim into `details.bc` (absent ⇒ details byte-identical). */
  bc?: XsBroadcastMark;
  /** fabric-xs-activation P3: ledger-bound control marker for this original messageId (`xid` is
   *  then the control action's own id). Absent ⇒ every byte of the body-wake path is unchanged. */
  activateFor?: string;
}

export interface RootWakeDeps {
  sessionId: string;
  rootRunMaxS: number;
  wakeEnabled: boolean;
  receive: () => "off" | "deliver" | "wake" | "replies";
  host: {
    isIdle(): boolean;
    hasPendingMessages(): boolean;
    sendMessage(message: RootWakeMessage, options: { triggerTurn: true }): void;
    abort: AbortPort;
    /** Branch/leaf evidence for a never-bound accepted trigger; diagnostic only. */
    hasXid?: (xid: string) => boolean;
  };
  /** Receiver's final synchronous sessionGen/fence check. No await between this and sendMessage. */
  guard?: () => XsNoneReason | undefined;
  inboundWakeAvailable?: () => boolean;
  /** Charge ONLY after successful send. Admission and this call are in one synchronous block. */
  chargeInboundWake?: () => void;
  level?: LevelPort;
  ledger?: XsWakeLedger;
  capability?: XsHostCapability;
  clock?: Clock;
  newToken?: () => string;
  audit?: RootWakeAuditPort;
  warn?: (message: string) => void;
  /** wake-unknown-optimistic: supervised orphan/late aborts inside the guards (activation watch). */
  abortOrphan?: OrphanAbortPort;
}

export type RootWakeDispatchResult =
  | { dispatched: false; wakeDowngraded: XsWakeDowngraded }
  | { dispatched: false; effect: "none"; reason: XsNoneReason; woke: false }
  | { dispatched: true; effect: "applied"; woke: true; token: string }
  | { dispatched: true; effect: "unknown"; reason: "start_deferred"; woke: true; token: string };

/**
 * One per stack. Owns from BEFORE sendMessage, including pre-start compaction. Never awaits pi.
 * Only xs wakes enter here: legacy tree-root / completion paths are intentionally untouched.
 * All timers go through Clock (systemClock is segmented and unref'd). dispose cancels stack timers
 * and leases, NOT process records. construct + recover after disposing the previous stack.
 */
export class RootWakeController {
  private readonly clock: Clock;
  private readonly ledger: XsWakeLedger;
  private readonly capability: XsHostCapability;
  private readonly owner = Symbol("xs-wake-controller");
  private readonly budgetMs: number | undefined;
  private current: RootWakeState = "idle";
  private token: string | undefined;
  private disposed = false;
  private idleObservations = 0;
  private deadlineTimer: TimerHandle | undefined;
  private slowTimer: TimerHandle | undefined;
  private idleTimer: TimerHandle | undefined;
  private graceTimer: TimerHandle | undefined;
  /** fabric-xs-activation P3: per-token end callbacks of control markers (pure data, pruned on end). */
  private readonly endHooks = new Map<string, (ended: RootWakeEnded) => void>();
  private readonly deadlineHit = new Set<string>();

  constructor(private readonly deps: RootWakeDeps) {
    this.clock = deps.clock ?? systemClock;
    this.ledger = deps.ledger ?? getXsWakeLedger();
    this.capability = deps.capability ?? getXsHostCapability();
    this.budgetMs = clampSpanMs(deps.rootRunMaxS * 1_000);
  }

  get state(): RootWakeState {
    return this.current;
  }
  get activeToken(): string | undefined {
    return this.token;
  }
  get busy(): boolean {
    return this.current !== "idle";
  }
  /** fabric-xs-activation P3: the original messageId the current supervised run concerns — a body
   *  wake's own xid, or a control marker's `activateFor`. Undefined while idle. */
  get activeMessageId(): string | undefined {
    if (this.token === undefined) return undefined;
    const record = this.ledger.get(this.token);
    return record === undefined ? undefined : (record.activateFor ?? record.xid);
  }

  /** Explicit for XW: recover only AFTER old stack.dispose(), before accepting inbound messages. */
  recover(): void {
    if (this.disposed || this.busy || this.ledger.hasOwner(this.deps.sessionId)) return;
    const idle = this.deps.host.isIdle();
    for (const record of this.ledger.entries()) {
      if (record.sessionId !== this.deps.sessionId) {
        // Session switch revokes, but does not prove a queued callback can never execute again.
        if (record.state === "live") this.ledger.tombstone(record.token);
        continue;
      }
      if (record.state !== "live" && !record.executionPending) continue;
      if (idle) {
        this.ledger.tombstone(record.token);
        this.ledger.update(record.token, { executionPending: false });
        continue;
      }
      if (!this.ledger.claim(record.token, this.owner)) continue;
      this.token = record.token;
      // A deferred record is NOT evidence that the active unrelated run belongs to this token.
      this.current =
        record.abortIssuedAt !== undefined
          ? "aborting"
          : record.handed
            ? "handedOver"
            : record.started || (record.executionPending && record.boundAt !== undefined)
              ? "bound"
              : "deferred";
      if (
        record.started &&
        record.abortIssuedAt === undefined &&
        (!record.optimistic || record.authorizedAt !== undefined)
      )
        commitLevel(this.ledger, record, this.deps.level);
      this.arm();
      break;
    }
  }

  dispatch(request: RootWakeRequest): RootWakeDispatchResult {
    const none = (reason: XsNoneReason): RootWakeDispatchResult => ({
      dispatched: false,
      effect: "none",
      reason,
      woke: false,
    });
    const downgrade = (wakeDowngraded: XsWakeDowngraded): RootWakeDispatchResult => ({
      dispatched: false,
      wakeDowngraded,
    });
    if (this.disposed) return none("session_changed");
    if (!Number.isFinite(request.expiresAt) || this.clock.now() >= request.expiresAt) return none("expired");
    const refusal = this.deps.guard?.();
    if (refusal !== undefined) return none(refusal);
    if (this.deps.receive() === "off") return none("rejected");
    if (!this.deps.wakeEnabled) return downgrade("wake_disabled");
    if (this.budgetMs === undefined) return downgrade("controller_disabled");
    const unsupported = this.capability.wakeDowngraded;
    if (unsupported !== undefined) return downgrade(unsupported);
    if (this.deps.receive() !== "wake" && !(this.deps.receive() === "replies" && request.solicited))
      return downgrade("receiver_policy");
    if (
      this.busy ||
      this.ledger.hasOwner(this.deps.sessionId) ||
      !this.deps.host.isIdle() ||
      this.deps.host.hasPendingMessages()
    )
      return downgrade("busy");
    if (!request.solicited && !this.deps.level?.hopAllowed(request.level ?? 0) && this.deps.level !== undefined)
      return downgrade("level_limit");
    if (this.deps.inboundWakeAvailable?.() === false) return downgrade("inbound_wake_rate");
    const dispatchLevel = request.solicited ? request.returnLevel : request.level;
    // wake-unknown-optimistic: `unknown` dispatches optimistically; the first run is verified
    // (BAS authorizes → bound, +1) or aborted before its first provider request (context guard).
    const optimistic = this.capability.optimistic;
    const token = this.deps.newToken?.() ?? newRunId((id) => this.ledger.get(id) !== undefined);
    const now = this.clock.now();
    if (
      !this.ledger.put({
        token,
        sessionId: this.deps.sessionId,
        xid: request.xid,
        dispatchedAt: now,
        deadlineAt: now + this.budgetMs,
        ...(optimistic ? { optimistic: true as const } : {}),
        ...(dispatchLevel === undefined ? {} : { level: dispatchLevel }),
        ...(request.solicited ? { levelMode: "return" as const } : {}),
        ...(request.activateFor === undefined ? {} : { activateFor: request.activateFor }),
      })
    )
      return downgrade("ledger_full");
    this.ledger.claim(token, this.owner);
    this.token = token;
    // Occupy and arm BEFORE calling the host: even a synchronous reentrant hook sees ownership.
    this.current = "deferred";
    this.arm();
    try {
      this.deps.host.sendMessage(
        {
          customType: XS_WAKE_CUSTOM_TYPE,
          content: request.content,
          display: true,
          details: {
            xsWake: true,
            xid: request.xid,
            from: request.from,
            wakeToken: token,
            ...(request.reply === undefined ? {} : { reply: request.reply }),
            ...(request.inReplyTo === undefined ? {} : { inReplyTo: request.inReplyTo }),
            ...(dispatchLevel === undefined ? {} : { level: dispatchLevel }),
            ...(request.bc === undefined ? {} : { bc: { channel: request.bc.channel } }),
            ...(request.activateFor === undefined ? {} : { activateFor: request.activateFor }),
          },
        },
        { triggerTurn: true },
      );
    } catch {
      this.finish("host_rejected");
      return none("host_rejected");
    }
    const record = this.ledger.get(token);
    if (!this.deps.host.isIdle()) {
      this.ledger.update(token, { started: true, executionPending: true });
      if (this.current === "deferred") this.current = "starting";
      this.arm();
      // Optimistic dispatch only carries the sender's level; the hop commits when BAS
      // authorizes the token (observeRootWakeTrigger → commitLevel), never at dispatch.
      if (record !== undefined && !record.optimistic) commitLevel(this.ledger, record, this.deps.level);
      else if (dispatchLevel !== undefined && !record?.levelCommitted) this.deps.level?.raise("root", dispatchLevel);
      if (optimistic) note(this.deps.audit, "wake_optimistic_dispatch", token);
      this.deps.chargeInboundWake?.();
      return { dispatched: true, effect: "applied", woke: true, token };
    }
    // S1: queued trigger carries the sender's level, but no autonomous hop yet.
    if (dispatchLevel !== undefined && !record?.levelCommitted) this.deps.level?.raise("root", dispatchLevel);
    if (optimistic) note(this.deps.audit, "wake_optimistic_dispatch", token);
    this.deps.chargeInboundWake?.();
    return { dispatched: true, effect: "unknown", reason: "start_deferred", woke: true, token };
  }

  /**
   * fabric-xs-activation P3 (arch §4.5): activate ONE already-delivered original message by
   * sending the fixed body-free control marker through the SAME dispatch gates (guard / policy /
   * busy / level / inbound quota / ledger / B1 / owner / deadline). It never creates a
   * reply credential, never re-delivers the body and is never a second runner. `onEnded` fires
   * once when the supervised control run ends (pure observation).
   */
  activateExisting(args: {
    messageId: string;
    from: unknown;
    expiresAt: number;
    level?: number;
    onEnded?: (ended: RootWakeEnded) => void;
  }): RootWakeDispatchResult {
    const result = this.dispatch({
      xid: newRunId((id) => this.ledger.get(id) !== undefined),
      from: args.from,
      content: XS_ACTIVATE_MARKER_CONTENT,
      expiresAt: args.expiresAt,
      ...(args.level === undefined ? {} : { level: args.level }),
      activateFor: args.messageId,
    });
    if (result.dispatched && args.onEnded !== undefined) this.endHooks.set(result.token, args.onEnded);
    return result;
  }

  /** The process B1 hook may already have run: authorized / abort bits make this idempotent for ledger tokens. */
  beforeAgentStart(event: unknown): RootWakeTriggerResult {
    const result = observeRootWakeTrigger(event, {
      sessionId: this.deps.sessionId,
      abort: this.deps.host.abort,
      ledger: this.ledger,
      capability: this.capability,
      clock: this.clock,
      ...(this.deps.level === undefined ? {} : { level: this.deps.level }),
      ...(this.deps.audit === undefined ? {} : { audit: this.deps.audit }),
      ...(this.deps.abortOrphan === undefined ? {} : { orphan: this.deps.abortOrphan }),
      ...(this.deps.warn === undefined ? {} : { warn: this.deps.warn }),
    });
    if (this.disposed) return result;
    if (result.kind !== "other") {
      // A late tombstone can start while idle. Supervise its abort through settlement/idle proof.
      if (result.kind === "aborted" && result.token !== undefined && !this.busy) {
        const record = this.ledger.get(result.token);
        if (
          record?.sessionId === this.deps.sessionId &&
          record.abortIssuedAt !== undefined &&
          this.ledger.claim(record.token, this.owner)
        ) {
          this.token = record.token;
          this.current = "aborting";
          this.arm();
        }
      } else if (result.kind === "authorized" && result.token !== undefined && result.token === this.token) {
        if (this.current === "starting" || this.current === "deferred") this.current = "bound";
        this.arm();
      } else if (result.kind === "aborted" && result.token !== undefined && result.token === this.token) {
        // token-guarded: a TOKEN-LESS orphan abort (undefined === undefined) must never move an
        // idle controller into a token-less "aborting" with no timers (property test finding).
        this.current = "aborting";
        this.arm();
      } else if (this.current === "starting") note(this.deps.audit, "wake_foreign_start", this.token);
      return result;
    }
    const trigger = readBeforeAgentStartTrigger(event);
    const shapeLost =
      trigger.kind === "custom" &&
      (trigger.customType === undefined || trigger.details === null || typeof trigger.details !== "object");
    const tokenRecord = this.token !== undefined ? this.ledger.get(this.token) : undefined;
    if (shapeLost && tokenRecord?.optimistic === true && (this.current === "starting" || this.current === "deferred")) {
      // wake-unknown-optimistic: the host cannot have authorized an unreadable trigger — mark
      // absent, abort exactly once (before any provider request) and supervise to settlement.
      this.capability.missingCustomShape(this.deps.warn);
      this.ledger.tombstone(tokenRecord.token);
      const now = this.clock.now();
      this.ledger.update(tokenRecord.token, {
        started: true,
        executionPending: true,
        levelCommitted: true,
        gateSightAt: now,
        abortIssuedAt: now,
      });
      note(this.deps.audit, "wake_shape_absent_aborted", tokenRecord.token);
      this.current = "aborting";
      this.arm(); // arm grace BEFORE invoking abort (settled can be synchronous)
      abortNow(this.deps.host.abort, this.deps.audit, tokenRecord.token);
    } else if (
      this.current === "deferred" &&
      trigger.kind === "custom" &&
      (trigger.customType === undefined || trigger.details === null || typeof trigger.details !== "object")
    ) {
      this.capability.missingCustomShape(this.deps.warn);
      // Shape failure: conservatively own this run; never leave a potentially ours run unbounded.
      const token = this.token!;
      this.ledger.update(token, { executionPending: true, boundAt: this.clock.now() });
      // Presumption bounds this run, but does NOT prove the queued token has executed.
      // No hop commit, no human handover, no capacity release based on this run's ending.
      this.current = "bound";
      this.arm();
    } else if (this.current === "starting") note(this.deps.audit, "wake_foreign_start", this.token);
    return result;
  }

  /**
   * wake-unknown-optimistic §1.1 observation point 2: forward a `context` event (before every
   * LLM call) through the ledger-authorized guard. Our own token aborted at first sight (or a
   * claimable late tombstone while idle) enters `aborting` and stays supervised; `authorized`
   * and `other` change nothing.
   */
  context(event: unknown): RootWakeTriggerResult {
    const result = guardRootWakeContext(event, {
      sessionId: this.deps.sessionId,
      abort: this.deps.host.abort,
      ledger: this.ledger,
      capability: this.capability,
      clock: this.clock,
      ...(this.deps.audit === undefined ? {} : { audit: this.deps.audit }),
      ...(this.deps.abortOrphan === undefined ? {} : { orphan: this.deps.abortOrphan }),
      ...(this.deps.warn === undefined ? {} : { warn: this.deps.warn }),
    });
    if (this.disposed || result.kind !== "aborted" || result.token === undefined) return result;
    if (result.token === this.token) {
      if (this.current === "starting" || this.current === "deferred" || this.current === "bound") {
        this.current = "aborting";
        this.arm();
      }
      return result;
    }
    if (!this.busy) {
      // A late tombstone can start while idle; supervise its abort (same claim as beforeAgentStart).
      const record = this.ledger.get(result.token);
      if (
        record?.sessionId === this.deps.sessionId &&
        record.abortIssuedAt !== undefined &&
        this.ledger.claim(record.token, this.owner)
      ) {
        this.token = record.token;
        this.current = "aborting";
        this.arm();
      }
    }
    return result;
  }

  input(event: WakeInputEvent, attributeInput?: (text: string) => "web_prompt" | undefined): void {
    // B1 supersedes the original table: human input in somebody else's deferred predecessor
    // is NOT handover. Only proven own-run start can surrender the watchdog to the human.
    if (this.disposed || (this.current !== "starting" && this.current !== "bound")) return;
    const record = this.ledger.get(this.token!);
    if (!record?.started || !classifyHumanInput(event, attributeInput)) return;
    this.ledger.update(this.token!, {
      handed: true,
      // Human takeover voids a still-uncommitted optimistic hop in the same write.
      ...(record.optimistic && !record.levelCommitted ? { levelCommitted: true } : {}),
    });
    this.current = "handedOver";
    this.arm();
  }

  settled(): void {
    if (this.disposed || this.current === "idle" || this.current === "deferred") return;
    if (this.current === "starting") {
      const record = this.ledger.get(this.token!);
      let found = false;
      try {
        found = record !== undefined && this.deps.host.hasXid?.(record.xid) === true;
      } catch {
        /* diagnostic only */
      }
      if (!found) note(this.deps.audit, "wake_lost_after_accept", this.token);
    }
    this.finish("settled");
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    this.endHooks.clear();
    this.deadlineHit.clear();
    if (this.token !== undefined) this.ledger.unclaim(this.token, this.owner);
  }

  private clearTimers(): void {
    for (const timer of [this.deadlineTimer, this.slowTimer, this.idleTimer, this.graceTimer]) {
      if (timer !== undefined) this.clock.clearTimer(timer);
    }
    this.deadlineTimer = this.slowTimer = this.idleTimer = this.graceTimer = undefined;
  }

  /** Re-arm absolute deadlines, never extend them because a hook bound/reloaded late. */
  private arm(): void {
    this.clearTimers();
    if (this.disposed || this.token === undefined) return;
    const token = this.token;
    const record = this.ledger.get(token);
    if (record === undefined || !this.ledger.owns(token, this.owner)) return;
    if (this.current === "starting" || this.current === "deferred" || this.current === "bound") {
      if (this.clock.now() >= record.deadlineAt) {
        this.deadline();
        return;
      }
      this.deadlineTimer = this.clock.setTimer(record.deadlineAt - this.clock.now(), () => this.deadline());
    }
    if (this.current === "starting" && this.clock.now() < record.dispatchedAt + ROOT_WAKE_SLOW_START_MS) {
      this.slowTimer = this.clock.setTimer(record.dispatchedAt + ROOT_WAKE_SLOW_START_MS - this.clock.now(), () => {
        this.slowTimer = undefined;
        if (this.current === "starting") note(this.deps.audit, "wake_slow_start", token);
      });
    }
    if (this.current === "aborting") {
      const remaining = (record.abortIssuedAt ?? this.clock.now()) + ROOT_WAKE_ABORT_GRACE_MS - this.clock.now();
      if (remaining <= 0) this.stuck();
      else this.graceTimer = this.clock.setTimer(remaining, () => this.stuck());
    }
    if (this.current !== "deferred" && this.current !== "idle") this.pollIdle();
  }

  private deadline(): void {
    if (this.disposed || this.token === undefined) return;
    this.deadlineTimer = undefined;
    if (this.current === "deferred") {
      this.ledger.tombstone(this.token);
      this.endNote(this.token, "deadline");
      this.releaseOwnership(); // NOT capacity: the unexecuted action is still possible.
      return;
    }
    if (this.current !== "starting" && this.current !== "bound") return;
    const token = this.token;
    const record = this.ledger.get(token);
    if (record === undefined || record.handed) return;
    this.deadlineHit.add(token);
    this.ledger.update(token, { abortIssuedAt: this.clock.now() });
    this.current = "aborting";
    this.arm(); // arm grace BEFORE invoking abort (settled can be synchronous).
    abortNow(this.deps.host.abort, this.deps.audit, token);
  }

  private stuck(): void {
    if (this.disposed || this.current !== "aborting") return;
    this.graceTimer = undefined;
    this.current = "stuck";
    this.endNote(this.token, "stuck");
    note(this.deps.audit, "abortStuck", this.token);
    try {
      (this.deps.warn ?? console.warn)("[pi-subagent] xs wake abort stuck; further wakes are deliver-only");
    } catch {
      /* diagnostic only */
    }
  }

  private pollIdle(): void {
    this.idleTimer = this.clock.setTimer(ROOT_WAKE_IDLE_POLL_MS, () => {
      this.idleTimer = undefined;
      if (this.disposed || this.token === undefined || !this.ledger.owns(this.token, this.owner)) return;
      this.idleObservations = this.deps.host.isIdle() ? this.idleObservations + 1 : 0;
      if (this.idleObservations >= 2) {
        note(this.deps.audit, "wake_end_unobserved", this.token);
        this.finish("idle_observed");
      } else this.pollIdle();
    });
  }

  private endNote(token: string | undefined, ended: RootWakeEnded): void {
    if (token === undefined) return;
    this.deadlineHit.delete(token);
    const hook = this.endHooks.get(token);
    if (hook === undefined) return;
    this.endHooks.delete(token);
    try {
      hook(ended);
    } catch {
      /* observation only */
    }
  }

  private finish(proof: "settled" | "idle_observed" | "host_rejected"): void {
    if (this.token !== undefined) {
      const record = this.ledger.get(this.token);
      this.endNote(
        this.token,
        this.deadlineHit.has(this.token)
          ? "deadline"
          : record?.abortIssuedAt !== undefined || proof === "host_rejected"
            ? "aborted"
            : "settled",
      );
      if (proof !== "host_rejected" && record !== undefined && !record.started) {
        // The ended run was only presumed ours. The real delayed action is still possible.
        this.ledger.tombstone(this.token);
        this.ledger.update(this.token, { executionPending: false });
      } else this.ledger.release(this.token, proof);
    }
    this.releaseOwnership();
  }

  private releaseOwnership(): void {
    this.clearTimers();
    if (this.token !== undefined) this.ledger.unclaim(this.token, this.owner);
    this.token = undefined;
    this.current = "idle";
    this.idleObservations = 0;
  }
}
