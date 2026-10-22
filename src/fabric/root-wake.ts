import { readBeforeAgentStartTrigger } from "../adapters/pi-compat.js";
import { systemClock, type Clock, type TimerHandle } from "../core/clock.js";
import { clampSpanMs } from "../core/deadline.js";
import { newRunId } from "../core/ids.js";
import type { XsNoneReason, XsWakeDowngraded } from "../web-hub/protocol/xs.js";
import { classifyHumanInput, type WakeInputEvent } from "./wake-input.js";
import type { CausalLevel } from "./wake-level.js";
import { getXsHostCapability, type XsHostCapability } from "./xs/host-cap.js";
import { getXsWakeLedger, type XsWakeLedger, type XsWakeRecord } from "./xs/wake-ledger.js";

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
  | "abortStuck"
  | "wake_abort_error";
export type RootWakeAuditPort = (event: RootWakeAudit, token: string | undefined) => void;
type LevelPort = Pick<CausalLevel, "raise" | "hopAllowed">;
type AbortPort = () => void | Promise<void>;

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
  if (record === undefined || record.sessionId !== deps.sessionId) {
    note(deps.audit, "wake_orphan_aborted", token);
    abortNow(deps.abort, deps.audit, token);
    return token === undefined ? { kind: "aborted" } : { kind: "aborted", token };
  }
  if (
    record.state === "tombstone" ||
    record.abortIssuedAt !== undefined ||
    (!record.handed && now >= record.deadlineAt)
  ) {
    ledger.tombstone(record.token);
    // Seeing the trigger proves it is now executing, not that abort has physically completed.
    ledger.update(record.token, { started: true, executionPending: true });
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
  ledger.update(record.token, { started: true, executionPending: true, boundAt: record.boundAt ?? now });
  capability.verify();
  commitLevel(ledger, record, deps.level);
  return { kind: "authorized", token: record.token };
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
  };
}

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
  goalRunning?: () => boolean;
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
}

export type RootWakeDispatchResult =
  | { dispatched: false; wakeDowngraded: XsWakeDowngraded }
  | { dispatched: false; effect: "none"; reason: XsNoneReason; woke: false }
  | { dispatched: true; effect: "applied"; woke: true; token: string }
  | { dispatched: true; effect: "unknown"; reason: "start_deferred"; woke: true; token: string };

/**
 * One per stack. Owns from BEFORE sendMessage, including pre-start compaction. Never awaits pi.
 * Only xs wakes enter here: legacy tree-root / goal / completion paths are intentionally untouched.
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
      if (record.started && record.abortIssuedAt === undefined) commitLevel(this.ledger, record, this.deps.level);
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
    if (this.deps.goalRunning?.()) return downgrade("goal");
    if (!request.solicited && !this.deps.level?.hopAllowed(request.level ?? 0) && this.deps.level !== undefined)
      return downgrade("level_limit");
    if (this.deps.inboundWakeAvailable?.() === false) return downgrade("inbound_wake_rate");
    const dispatchLevel = request.solicited ? request.returnLevel : request.level;
    const token = this.deps.newToken?.() ?? newRunId((id) => this.ledger.get(id) !== undefined);
    const now = this.clock.now();
    if (
      !this.ledger.put({
        token,
        sessionId: this.deps.sessionId,
        xid: request.xid,
        dispatchedAt: now,
        deadlineAt: now + this.budgetMs,
        ...(dispatchLevel === undefined ? {} : { level: dispatchLevel }),
        ...(request.solicited ? { levelMode: "return" as const } : {}),
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
      if (record !== undefined) commitLevel(this.ledger, record, this.deps.level);
      this.deps.chargeInboundWake?.();
      return { dispatched: true, effect: "applied", woke: true, token };
    }
    // S1: queued trigger carries the sender's level, but no autonomous hop yet.
    if (dispatchLevel !== undefined && !record?.levelCommitted) this.deps.level?.raise("root", dispatchLevel);
    this.deps.chargeInboundWake?.();
    return { dispatched: true, effect: "unknown", reason: "start_deferred", woke: true, token };
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
      } else if (result.kind === "authorized" && result.token === this.token) {
        if (this.current === "starting" || this.current === "deferred") this.current = "bound";
        this.arm();
      } else if (result.kind === "aborted" && result.token === this.token) {
        this.current = "aborting";
        this.arm();
      } else if (this.current === "starting") note(this.deps.audit, "wake_foreign_start", this.token);
      return result;
    }
    const trigger = readBeforeAgentStartTrigger(event);
    if (
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

  input(event: WakeInputEvent, attributeInput?: (text: string) => "web_prompt" | undefined): void {
    // B1 supersedes the original table: human input in somebody else's deferred predecessor
    // is NOT handover. Only proven own-run start can surrender the watchdog to the human.
    if (this.disposed || (this.current !== "starting" && this.current !== "bound")) return;
    if (!this.ledger.get(this.token!)?.started || !classifyHumanInput(event, attributeInput)) return;
    this.ledger.update(this.token!, { handed: true });
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
      this.releaseOwnership(); // NOT capacity: the unexecuted action is still possible.
      return;
    }
    if (this.current !== "starting" && this.current !== "bound") return;
    const token = this.token;
    const record = this.ledger.get(token);
    if (record === undefined || record.handed) return;
    this.ledger.update(token, { abortIssuedAt: this.clock.now() });
    this.current = "aborting";
    this.arm(); // arm grace BEFORE invoking abort (settled can be synchronous).
    abortNow(this.deps.host.abort, this.deps.audit, token);
  }

  private stuck(): void {
    if (this.disposed || this.current !== "aborting") return;
    this.graceTimer = undefined;
    this.current = "stuck";
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

  private finish(proof: "settled" | "idle_observed" | "host_rejected"): void {
    if (this.token !== undefined) {
      const record = this.ledger.get(this.token);
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
