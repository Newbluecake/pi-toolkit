/** #59 B2 feature-specific supervisor, not a scheduler or task authorization mechanism.
 * Production Root TUI currently has NO public AgentSession handle: absent subscribeSession
 * is effective-off. Extension on(agent_settled)+one immediate is explicitly unsupported.
 * SDK-owned embedders can supply the actual public session.subscribe method (conformance).
 * Even that does not attest arbitrary third-party hidden input/command queues: those must
 * be unknown in the host's otherRoot gate. No SDK private flags, polling or prototype patch.
 */
import { randomUUID } from "node:crypto";
import { systemClock, type Clock, type TimerHandle } from "../core/clock.js";
import { clampSpanMs } from "../core/deadline.js";
import { readBeforeAgentStartTrigger } from "../adapters/pi-compat.js";
import { sameRecoveryWindow, selectRecoveryCandidates } from "./idle-recovery.js";
import type { IdleRecoveryStore, RecoveryPlan, RecoveryReservation } from "./idle-recovery-store.js";
import { RECOVERY_BUSY_SOURCES, type RecoveryHostSnapshot, type RecoveryIdentity } from "./idle-recovery-host.js";

export const IDLE_RECOVERY_CHECK = "subagent:todo-idle-recovery-check";
export const IDLE_RECOVERY_SUPERVISION = "subagent:todo-idle-recovery-supervision";
export const IDLE_RECOVERY_DEADLINE_MS = 900_000;
export const IDLE_RECOVERY_GRACE_MS = 10_000;
export interface RecoveryCheckMessage {
  readonly customType: typeof IDLE_RECOVERY_CHECK;
  readonly display: true;
  readonly content: string;
  readonly details: { readonly v: 1; readonly sid: string; readonly ownerToken: string; readonly attemptId: string };
}
export interface RecoveryImmediate {
  cancel(): void;
}
export interface IdleRecoveryRunnerDeps extends RecoveryIdentity {
  readonly enabled: boolean;
  readonly store: IdleRecoveryStore;
  readonly readHostSnapshot: () => RecoveryHostSnapshot;
  readonly appendCustomEntry: (type: string, data: unknown) => unknown;
  readonly getEntries: () => readonly unknown[];
  readonly sendMessage: (message: RecoveryCheckMessage, options: { triggerTurn: true }) => void;
  readonly abort: () => void;
  /** REAL AgentSession.subscribe, not ExtensionAPI.on. Root extension cannot currently supply
   * this. Providing only ctx/sessionManager must leave this undefined (effective-off).
   * A subscription is necessary, not sufficient: only audited SDK-owned input/command
   * admission and abort-and-settle-before-replacement routes are supported. Otherwise
   * otherRoot MUST be unknown. Raw reload/dispose during emission is not certified.
   */
  readonly subscribeSession?: (listener: (event: { type: string; aborted?: boolean }) => void) => () => void;
  readonly clock?: Clock;
  readonly immediate?: (callback: () => void) => RecoveryImmediate;
  readonly createOwnerToken?: () => string;
}
export type RecoveryRunnerPhase = "idle" | "unknown" | "bound" | "aborting" | "stuck" | "tombstone" | "disposed";
export interface IdleRecoveryRunner {
  readonly effective: boolean;
  readonly offReason: string | undefined;
  busy(): boolean;
  phase(): RecoveryRunnerPhase;
  /** Extension hook may report Stop/settlement, but cannot schedule recovery. */
  onSettled(event: unknown): void;
  beforeAgentStart(event: unknown): void;
  context(): void;
  handover(): void;
  dispose(): void;
}
interface Attempt {
  readonly plan: RecoveryPlan;
  readonly reservation: RecoveryReservation;
  readonly token: string;
  readonly deadlineAt: number;
  readonly candidateSignature: string;
  phase: "unknown" | "bound" | "aborting";
  serial: number | undefined;
  aborted: boolean;
}
function realImmediate(callback: () => void): RecoveryImmediate {
  const handle = setImmediate(callback);
  handle.unref();
  return { cancel: () => clearImmediate(handle) };
}
function candidates(snapshot: RecoveryHostSnapshot, owner: string): string {
  return JSON.stringify(
    snapshot.todo ? selectRecoveryCandidates(snapshot.todo, { owner }).map((c) => [c.fingerprint, c.progressKey]) : [],
  );
}
function abortedField(event: unknown): boolean | undefined {
  if (!event || typeof event !== "object") return undefined;
  const value = (event as { aborted?: unknown }).aborted;
  return typeof value === "boolean" ? value : undefined;
}
function markerDetails(value: unknown): { sid: string; ownerToken: string; attemptId: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const d = value as Record<string, unknown>;
  return d.v === 1 && typeof d.sid === "string" && typeof d.ownerToken === "string" && typeof d.attemptId === "string"
    ? { sid: d.sid, ownerToken: d.ownerToken, attemptId: d.attemptId }
    : undefined;
}
export function recoveryCheckContent(plan: RecoveryPlan): string {
  const listed = plan.tasks.filter((task) =>
    plan.pairs.some((pair) => pair.fingerprint === task.fingerprint && pair.key === task.progressKey),
  );
  return `自动检查 / 原授权范围 / ${plan.attemptNumber}/2\n\n仅检查以下既有 in_progress 任务：\n${listed.map((task) => `- #${task.taskId} ${task.subject}`).join("\n")}\n\n先核对原对话授权、依赖和人工闸门。只处理已授权且当前可推进的工作；若等待用户、审批、外部条件或定时，说明等待并停止。此检查不是新授权：不得启动 pending/未授权任务，不得自主批准计划、提交或发布。经验证后才更新任务状态。`;
}

export function createIdleRecoveryRunner(deps: IdleRecoveryRunnerDeps): IdleRecoveryRunner {
  const clock = deps.clock ?? systemClock;
  const schedule = deps.immediate ?? realImmediate;
  let disposed = false;
  let disabled = false;
  let offReason = !deps.enabled
    ? "disabled"
    : !deps.subscribeSession
      ? "root-session-subscription-unavailable"
      : undefined;
  let active: Attempt | undefined;
  let preparing = false;
  let pending: RecoveryImmediate | undefined;
  let deadline: TimerHandle | undefined;
  let grace: TimerHandle | undefined;
  let serial = 0;
  let generation = 0;
  let terminal: RecoveryRunnerPhase = "idle";
  let unsubscribe: (() => void) | undefined;
  const effective = () => offReason === undefined && !disabled && !disposed;
  const cancelImmediate = () => {
    pending?.cancel();
    pending = undefined;
  };
  const cancelTimers = () => {
    if (deadline) clock.clearTimer(deadline);
    if (grace) clock.clearTimer(grace);
    deadline = undefined;
    grace = undefined;
  };
  const read = (): RecoveryHostSnapshot | undefined => {
    try {
      return deps.readHostSnapshot();
    } catch {
      return undefined;
    }
  };
  const identity = (s: RecoveryHostSnapshot | undefined): s is RecoveryHostSnapshot =>
    s?.identity?.sid === deps.sid && s.identity.owner === deps.owner;
  const gates = (s: RecoveryHostSnapshot | undefined, started = false): s is RecoveryHostSnapshot => {
    try {
      if (
        !identity(s) ||
        !s.todo ||
        !s.state ||
        !s.sources ||
        !s.state.open ||
        s.state.stopped ||
        s.state.latch !== undefined
      )
        return false;
      // Explicit required keys: an empty/partial object is UNKNOWN, not vacuously clear.
      if (!RECOVERY_BUSY_SOURCES.every((key) => s.sources[key] === "clear")) return false;
      // At BAS/context SDK is intentionally busy with this trigger; every OTHER source gates.
      return started || (s.busy === "clear" && s.sources.sdk === "clear");
    } catch {
      return false;
    }
  };
  const log = (a: Attempt, phase: string): boolean => {
    try {
      deps.appendCustomEntry(IDLE_RECOVERY_SUPERVISION, {
        v: 1,
        sid: deps.sid,
        owner: deps.owner,
        ownerToken: a.token,
        attemptId: a.plan.attemptId,
        deadlineAt: a.deadlineAt,
        phase,
        at: clock.now(),
      });
      return true;
    } catch {
      disabled = true;
      offReason = "supervision-persist-uncertain";
      return false;
    }
  };
  const revoke = (phase: "handed" | "settled" | "tombstone") => {
    const old = active;
    active = undefined; // revoke FIRST: append may re-enter or fail
    cancelTimers();
    if (old) log(old, phase);
  };
  const handover = () => {
    generation += 1;
    cancelImmediate();
    revoke("handed");
  };
  const stillOwned = (a: Attempt): boolean =>
    !disposed && active === a && a.phase === "bound" && a.serial === serial && identity(read());
  const abortOnce = (a: Attempt) => {
    if (a.aborted) return;
    a.aborted = true;
    try {
      deps.abort();
    } catch {
      disabled = true;
      terminal = "stuck";
    }
  };
  // #59 B2 acceptance: markers this instance actually put on the wire — the ONLY later proof
  // that a rejected BAS marker is our own stale check rather than another feature's run.
  // Bounded; dropping an old entry only loses the ability to abort our own stale check
  // (conservative direction), never grants permission for anything foreign.
  const issuedMarkers: { token: string; attemptId: string }[] = [];
  const recordIssuedMarker = (token: string, attemptId: string) => {
    issuedMarkers.push({ token, attemptId });
    if (issuedMarkers.length > 8) issuedMarkers.splice(0, issuedMarkers.length - 8);
  };
  const isIssuedMarker = (d: { sid: string; ownerToken: string; attemptId: string }): boolean =>
    d.sid === deps.sid && issuedMarkers.some((i) => i.token === d.ownerToken && i.attemptId === d.attemptId);
  const expire = (a: Attempt) => {
    deadline = undefined;
    if (active !== a || disposed) return;
    if (!stillOwned(a)) {
      disabled = true;
      terminal = "tombstone";
      revoke("tombstone"); // unknown is NEVER permission to abort an unrelated/user run
      return;
    }
    // Fixed attempt deadline, not BAS time. Logging cannot restore ownership after reentry.
    log(a, "deadline");
    if (!stillOwned(a)) return;
    a.phase = "aborting";
    abortOnce(a);
    if (active !== a || disposed) return; // synchronous settled/arrival from abort callback
    grace = clock.setTimer(clampSpanMs(IDLE_RECOVERY_GRACE_MS)!, () => {
      grace = undefined;
      if (active !== a || disposed) return;
      disabled = true;
      terminal = "stuck";
      log(a, "stuck");
    });
  };
  const matches = (a: Attempt, s: RecoveryHostSnapshot | undefined, started = false) =>
    gates(s, started) &&
    sameRecoveryWindow(a.plan.window, s.state.window) &&
    s.state.attemptsInWindow === a.plan.attemptNumber &&
    candidates(s, deps.owner) === a.candidateSignature;
  const attempt = (initial: RecoveryHostSnapshot, initialSignature: string, expectedGeneration: number) => {
    if (!effective() || active || preparing || generation !== expectedGeneration) return;
    const snapshot = read();
    if (
      !gates(snapshot) ||
      !sameRecoveryWindow(initial.state.window, snapshot.state.window) ||
      initial.state.attemptsInWindow !== snapshot.state.attemptsInWindow ||
      initialSignature !== candidates(snapshot, deps.owner)
    )
      return;
    preparing = true; // reserve/log callbacks may synchronously re-enter settled
    try {
      const prepared = deps.store.prepare({ todo: snapshot.todo! });
      if (prepared.kind !== "ready") return;
      const signature = candidates(snapshot, deps.owner);
      const attemptAt = clock.now();
      const reserved = deps.store.reserve(prepared.plan); // write attempt BEFORE claim/timer/send
      if (reserved.kind !== "reserved") return;
      const a: Attempt = {
        plan: prepared.plan,
        reservation: reserved.reservation,
        token: (deps.createOwnerToken ?? randomUUID)(),
        deadlineAt: attemptAt + clampSpanMs(IDLE_RECOVERY_DEADLINE_MS)!,
        candidateSignature: signature,
        phase: "unknown",
        serial: undefined,
        aborted: false,
      };
      // Ownership may have changed inside B1 append. The charged attempt is never refunded/retried.
      if (!effective() || generation !== expectedGeneration || !matches(a, read())) {
        deps.store.commit(a.reservation, "unknown");
        return;
      }
      active = a;
      if (!log(a, "claim")) {
        revoke("tombstone");
        terminal = "tombstone";
        return;
      }
      if (active !== a || !effective() || generation !== expectedGeneration) return;
      deadline = clock.setTimer(clampSpanMs(a.deadlineAt - clock.now()) ?? 1, () => expire(a));
      // No await between this complete synchronous guard and public sendMessage core binding.
      if (!matches(a, read()) || active !== a || generation !== expectedGeneration || clock.now() >= a.deadlineAt) {
        revoke("tombstone");
        deps.store.commit(a.reservation, "unknown");
        return;
      }
      try {
        // #59 B2: record issuance BEFORE the send — a synchronous throw is delivery-UNKNOWN,
        // the marker may still be on the wire and must stay provably ours if it returns late.
        recordIssuedMarker(a.token, a.plan.attemptId);
        deps.sendMessage(
          {
            customType: IDLE_RECOVERY_CHECK,
            display: true,
            content: recoveryCheckContent(a.plan),
            details: { v: 1, sid: deps.sid, ownerToken: a.token, attemptId: a.plan.attemptId },
          },
          { triggerTurn: true },
        );
        // void means delivery UNKNOWN, not failure and not an ownership proof.
        deps.store.commit(a.reservation, "unknown");
      } catch {
        deps.store.commit(a.reservation, "unknown");
      }
    } finally {
      preparing = false;
    }
  };
  const settle = (event: unknown, evaluate: boolean) => {
    if (!effective()) return;
    const aborted = abortedField(event);
    if (aborted === undefined) return;
    if (aborted) {
      generation += 1;
      cancelImmediate();
      deps.store.noteStop("aborted");
    }
    if (active?.serial === serial && (active.phase === "bound" || active.phase === "aborting")) revoke("settled");
    if (!evaluate || aborted || pending || active || preparing) return;
    const snapshot = read();
    if (!gates(snapshot)) return;
    const expectedGeneration = generation;
    const initialSignature = candidates(snapshot, deps.owner);
    pending = schedule(() => {
      pending = undefined;
      attempt(snapshot, initialSignature, expectedGeneration);
    });
  };
  // Never restore execution rights. An unclosed previous claim (including stuck/deadline) is
  // diagnostic evidence of uncertain old work, not a replayable job.
  if (effective()) {
    try {
      const entries = deps.getEntries();
      const phases = new Map<string, string>();
      for (const raw of entries) {
        const e = raw as { type?: string; customType?: string; data?: Record<string, unknown> };
        if (e?.type !== "custom" || e.customType !== IDLE_RECOVERY_SUPERVISION || e.data?.sid !== deps.sid) continue;
        if (e.data.v !== 1 || typeof e.data.attemptId !== "string" || typeof e.data.phase !== "string")
          throw new Error("unknown supervision");
        phases.set(e.data.attemptId, e.data.phase);
      }
      if ([...phases.values()].some((p) => !["settled", "handed"].includes(p)))
        offReason = "old-supervision-unresolved";
    } catch {
      offReason = "supervision-read-unknown";
    }
  }
  if (effective()) {
    try {
      unsubscribe = deps.subscribeSession!((event) => {
        if (event.type === "agent_settled") settle(event, true);
      });
    } catch {
      offReason = "session-subscription-failed";
    }
  }
  return {
    get effective() {
      return effective();
    },
    get offReason() {
      return offReason;
    },
    busy: () => preparing || active !== undefined || disabled,
    phase: () => (disposed ? "disposed" : terminal === "stuck" ? "stuck" : (active?.phase ?? terminal)),
    onSettled: (event) => settle(event, false),
    beforeAgentStart(event) {
      if (disposed || !unsubscribe) return;
      serial += 1;
      const trigger = readBeforeAgentStartTrigger(event);
      if (trigger.kind !== "custom" || trigger.customType !== IDLE_RECOVERY_CHECK) {
        // Foreign/non-check trigger (user prompt or another feature's custom run): hand over
        // THIS runner's rights only; never abort — that run is not ours to abort (#59 B2).
        handover();
        return;
      }
      const d = markerDetails(trigger.details);
      const a = active;
      if (
        !effective() ||
        !a ||
        !d ||
        d.sid !== deps.sid ||
        d.ownerToken !== a.token ||
        d.attemptId !== a.plan.attemptId ||
        a.phase !== "unknown" ||
        clock.now() >= a.deadlineAt ||
        !matches(a, read(), true)
      ) {
        // #59 B2 acceptance: rejection (late/stale/foreign/malformed marker, or no current
        // claim) only forfeits THIS runner's supervision rights (claim/handover/timer/deadline).
        // It is NEVER authorization to abort whatever run the host is starting — with no
        // current claim there is nothing of ours to abort, and a foreign marker's run may be
        // another feature's already-accepted custom run. deps.abort stays reachable ONLY for
        // a marker this instance provably issued (our own late/stale check run).
        handover();
        if (d && isIssuedMarker(d)) {
          try {
            deps.abort();
          } catch {
            disabled = true;
          }
        }
        return;
      }
      a.phase = "bound";
      a.serial = serial;
      if (!log(a, "bound")) {
        if (stillOwned(a)) abortOnce(a);
      }
    },
    context() {
      if (disposed || !unsubscribe) return;
      const a = active;
      // No historical tail lookup: ONLY the current BAS serial can authorize supervision.
      if (!a || a.serial !== serial || a.phase !== "bound") return;
      if (clock.now() >= a.deadlineAt || !matches(a, read(), true)) {
        if (stillOwned(a)) abortOnce(a);
        disabled = true;
        terminal = "tombstone";
        if (active === a) revoke("tombstone");
      }
    },
    handover,
    dispose() {
      if (disposed) return;
      const a = active;
      const owned = a !== undefined && stillOwned(a);
      disposed = true;
      generation += 1;
      cancelImmediate();
      cancelTimers();
      try {
        unsubscribe?.();
      } catch {
        /* already invalidated public host */
      }
      unsubscribe = undefined;
      active = undefined;
      if (a) log(a, "tombstone");
      if (owned && a) abortOnce(a); // synchronous, no await; never abort an unbound claim
    },
  };
}
