import type { Clock, TimerHandle } from "../core/clock.js";
import type { FabricRecord, MessageChannel, NodeRef } from "../core/message.js";
import { effectiveChannel } from "../core/message.js";
import { newRunId } from "../core/ids.js";
import type { Millis, RunId } from "../core/types.js";
import type { DeliveryEngine } from "../delivery/engine.js";
import type { FabricRouter } from "./router.js";
import type { FabricThrottle } from "./throttle.js";
import type { ReviveVerdict, WakeService } from "./wake.js";

/**
 * What a failed send is KNOWN to have done to the target (fabric-cross-session plan §3.4c). `none`: the steer's promise
 * was rejected, nothing landed. `unknown`: the bounded wait timed out — the steer may still land afterwards. Legacy
 * judgement never reads it; only a redirect steer (finished run → its successor) does.
 */
export type VerdictEffect = "none" | "unknown";
export type Verdict =
  | { ok: true }
  | { ok: false; retryable: true; reason: string; effect?: VerdictEffect }
  | { ok: false; retryable: false; reason: "target_gone" | "policy"; effect?: VerdictEffect };
export interface FabricPorts {
  /** `opts.target` (W4 redirect): steer this run instead of `record.to` (the resumed successor of a finished run). */
  inject(record: FabricRecord, opts?: { target: RunId }): Promise<Verdict>;
  sendRootContext(record: FabricRecord): Promise<Verdict>;
  sendRootDisplay(record: FabricRecord): Promise<Verdict>;
  /**
   * W5: revive a finished target for a `wake:true` finding/directive. Absent (wake off) ⇒ legacy `target_gone` handling.
   * The returned promise's synchronous part has already decided reservation ownership (`claimToken` is the mailbox
   * claim the trigger rides on) — see {@link WakeService.revive}.
   */
  revive?(record: FabricRecord, claimToken: string): Promise<ReviveVerdict>;
}
/**
 * The single TTL predicate shared by expiry and scheduling (fabric-cross-session
 * plan §8 F0): a record whose deadline has been REACHED counts as expired.
 * Expiry and the wake scheduler must agree at the exact boundary — if expiry
 * used `>` while the scheduler armed for `createdAt + ttlMs` and re-armed only
 * when that instant was strictly in the future, a record checked at exactly the
 * deadline would be neither expired nor rescheduled and could stay pending
 * forever with no further traffic.
 */
const ttlExpired = (createdAt: Millis, ttlMs: number, now: Millis): boolean => now >= createdAt + ttlMs;

const PARK_RETRY_MS = 1_000;

export interface MailboxOptions {
  engine: DeliveryEngine<FabricRecord, FabricRecord["state"]>;
  router: FabricRouter;
  throttle: FabricThrottle;
  ports: FabricPorts;
  clock: Clock;
  fabricSteerTimeoutMs: number;
  progressChannel?: MessageChannel;
  canRenderEntries?: boolean;
  maxAttempts: number;
  /**
   * fabric-cross-session plan §3.3 seam A (W1): called once per successful delivery (`claimed → delivered`) so the
   * causal level can propagate. Absent (wake off) ⇒ nothing changes. Must not throw; failures are swallowed here.
   */
  level?: { onDelivered(record: FabricRecord, channel: MessageChannel): void };
  inbox?: Pick<
    WakeService,
    "sweep" | "nextSweepAt" | "dispose" | "successor" | "steerHeld" | "auditUnverified" | "subscribe"
  >;
  onDegraded?: (error: unknown) => void;
}

export class FabricMailbox {
  readonly mailboxInstanceId = newRunId();
  private wake: TimerHandle | undefined;
  private readonly raceTimers = new Set<TimerHandle>();
  private readonly inFlight = new Map<NodeRef, string>();
  private readonly settled = new Set<NodeRef>();
  /** W4: in-memory successor-wait markers (key → the starting successor). Never persisted, never a delivery attempt. */
  private readonly waitingFor = new Map<string, { runId: RunId; sessionFile: string | undefined }>();
  /** Records whose park could not be persisted: retried at this time (bounded by their TTL). */
  private readonly parkRetryAt = new Map<string, number>();
  private frozen = false;
  constructor(private readonly options: MailboxOptions) {}

  get waitingCount(): number {
    return this.waitingFor.size;
  }

  /**
   * W4: a successor of `sessionFile` (or `successor` itself) changed state — it reached running, or ended. Clears the
   * successor-wait markers of that session chain, then re-evaluates EVERYTHING pending: records of the chain whose
   * successor now runs are redirect-steered one verdict at a time (`inFlight` per target ⇒ bounded microtask steps),
   * the rest follow normal handling. Reserved/quarantined records are never touched (W3 owns them).
   */
  drainSession(sessionFile?: string, successor?: RunId): void {
    if (this.frozen) return;
    for (const [key, mark] of this.waitingFor)
      if (
        (successor !== undefined && mark.runId === successor) ||
        (sessionFile !== undefined && mark.sessionFile === sessionFile)
      )
        this.waitingFor.delete(key);
    this.pump();
  }

  /** The successor this finished-target record may be coalesced into (finding/directive with an explicit wake only). */
  private successorRoute(
    record: FabricRecord,
  ): { runId: RunId; sessionFile: string | undefined; running: boolean } | undefined {
    if (!this.options.inbox || record.wake === undefined || record.kind === "progress") return undefined;
    if (this.options.router.targetState(record.to) !== "gone") return undefined;
    const successor = this.options.inbox.successor(record.to);
    if (!successor) return undefined;
    const state = this.options.router.targetState(successor.runId);
    if (state === "gone") return undefined;
    return { ...successor, running: state === "running" };
  }

  pump(hint?: NodeRef): void {
    if (this.frozen) return;
    this.options.inbox?.sweep(this.options.clock.now(), 32);
    const targets =
      hint === undefined
        ? [...new Set(this.options.engine.select((r) => r.state === "pending").map((r) => r.to))]
        : [hint];
    const gone: FabricRecord[] = [];
    for (const target of targets) {
      const candidates = this.options.engine
        .select((r) => r.state === "pending" && r.to === target)
        .sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
      for (const record of candidates) {
        const now = this.options.clock.now();
        // Reservation ownership outranks TTL. Only the disposition sweep may terminate it.
        if (this.options.inbox && (record.reserved || record.quarantined || this.options.inbox.steerHeld(record.key)))
          continue;
        if (ttlExpired(record.createdAt, record.ttlMs, now)) {
          this.waitingFor.delete(record.key);
          if (record.kind === "finding" || record.kind === "directive")
            this.options.router.issueDeadLetter(record, "ttl_expired");
          else this.options.engine.transition(record.key, "pending", "abandoned", { terminalReason: "ttl_expired" });
          continue;
        }
        // W4: a finished target whose session chain has a live/starting successor. Starting ⇒ wait (marker, no attempt,
        // TTL stays the only other wake source); running ⇒ redirect steer into the successor (even for a parked record).
        const route = this.successorRoute(record);
        if (route && !route.running) {
          this.waitingFor.set(record.key, { runId: route.runId, sessionFile: route.sessionFile });
          continue;
        }
        this.waitingFor.delete(record.key);
        if (route) {
          if (this.inFlight.has(target) || now < this.options.throttle.eligibleAt(record)) continue;
          const token = `${this.mailboxInstanceId}:${record.attempts}`;
          const claimed = this.options.engine.claim(record.key, token);
          if (claimed === undefined) continue;
          this.inFlight.set(target, record.key);
          this.dispatch(claimed, token, route.runId);
          break;
        }
        // Parked records are carried only by a later resume admission, never steered by this pump.
        if (this.options.inbox && record.parked) continue;
        const targetState = this.options.router.targetState(record.to);
        if (targetState === "gone") {
          if (this.options.inbox && record.wake === false) {
            const parked = this.options.router.tryPark(record, "wake_false");
            // A transient persist failure must not dead-letter a message that could have been parked: stay pending
            // (TTL bounds the wait; the next pump retries the park).
            if (parked === "persist_failed") this.parkRetryAt.set(record.key, now + PARK_RETRY_MS);
            else this.parkRetryAt.delete(record.key);
            if (parked === "parked" || parked === "persist_failed") continue;
          }
          // W5: an explicit wake:true to a finished run is revived (single entry: WakeService), never dead-lettered.
          if (
            this.options.inbox &&
            this.options.ports.revive &&
            record.wake === true &&
            (record.kind === "finding" || record.kind === "directive")
          ) {
            if (this.inFlight.has(target) || now < this.options.throttle.eligibleAt(record)) continue;
            const token = `${this.mailboxInstanceId}:${record.attempts}`;
            const claimed = this.options.engine.claim(record.key, token);
            if (claimed === undefined) continue;
            this.inFlight.set(target, record.key);
            this.dispatchRevive(claimed, token);
            break;
          }
          if (record.kind === "finding" || record.kind === "directive") gone.push(record);
          else this.options.engine.transition(record.key, "pending", "dropped", { terminalReason: "target_gone" });
          continue;
        }
        if (targetState === "pending_start") continue;
        if (this.inFlight.has(target) || now < this.options.throttle.eligibleAt(record)) continue;
        const token = `${this.mailboxInstanceId}:${record.attempts}`;
        const claimed = this.options.engine.claim(record.key, token);
        if (claimed === undefined) continue;
        this.inFlight.set(target, record.key);
        this.dispatch(claimed, token);
        break;
      }
    }
    const goneBySender = new Map<string, FabricRecord[]>();
    for (const record of gone) {
      const batch = goneBySender.get(record.from) ?? [];
      batch.push(record);
      goneBySender.set(record.from, batch);
    }
    for (const batch of goneBySender.values()) this.options.router.issueDeadLetters(batch, "target_gone");
    this.rescheduleWake();
  }

  onRunSettled(from: NodeRef): void {
    this.settled.add(from);
    this.options.router.onRunSettled(from);
    // W4: a successor that ended releases its waiters (tombstoned above ⇒ normal handling decides their fate).
    let released = false;
    for (const [key, mark] of this.waitingFor)
      if (mark.runId === from) {
        this.waitingFor.delete(key);
        released = true;
      }
    if (released) this.pump();
    else this.pump(from);
  }

  dispose(): void {
    if (this.frozen) return;
    this.frozen = true;
    this.options.inbox?.dispose();
    this.options.engine.freeze();
    if (this.wake) this.options.clock.clearTimer(this.wake);
    this.wake = undefined;
    for (const timer of this.raceTimers) this.options.clock.clearTimer(timer);
    this.raceTimers.clear();
    this.inFlight.clear();
    this.waitingFor.clear();
    this.parkRetryAt.clear();
    this.options.router.freeze();
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }
  get pendingRaceTimers(): number {
    return this.raceTimers.size;
  }

  private dispatch(record: FabricRecord, token: string, redirect?: RunId): void {
    if (redirect !== undefined) {
      // Redirect steer (plan §3.4c): the attempt is made durable BEFORE the send. A steer that times out may still
      // land; with this mark a retry (or a reload) can never duplicate it.
      const marked = this.options.engine.annotateStrict(
        record.key,
        { state: "claimed", claimToken: token },
        { steerAttempt: { runId: redirect, at: this.options.clock.now() } },
      );
      if (!marked.ok) {
        // Nothing was sent: an ordinary retryable verdict (attempts + backoff), never an unmarked steer.
        void Promise.resolve().then(() =>
          this.verdict(record.key, record.to, token, {
            ok: false,
            retryable: true,
            reason: "steer_attempt_unpersisted",
            effect: "none",
          }),
        );
        return;
      }
    }
    void this.boundedSend(record, redirect).then((verdict) =>
      this.verdict(record.key, record.to, token, verdict, redirect),
    );
  }

  /**
   * W5: hand a claimed `wake:true` record to WakeService.revive. Bounded like a steer (`fabricSteerTimeoutMs`): the
   * admission part of a revive is synchronous, so the timer only guards a pathological hang — a timeout is a bounded
   * retry (and a verdict arriving afterwards is dropped here).
   */
  private dispatchRevive(record: FabricRecord, token: string): void {
    let done = false;
    let timer: TimerHandle | undefined;
    const finish = (outcome: ReviveVerdict): void => {
      if (done) return;
      done = true;
      if (timer) {
        this.options.clock.clearTimer(timer);
        this.raceTimers.delete(timer);
      }
      this.reviveVerdict(record.key, record.to, token, outcome);
    };
    timer = this.options.clock.setTimer(Math.max(0, this.options.fabricSteerTimeoutMs), () =>
      finish({ retry: "revive_timeout" }),
    );
    this.raceTimers.add(timer);
    try {
      Promise.resolve(this.options.ports.revive!(record, token)).then(finish, (error) =>
        finish({ retry: error instanceof Error ? error.message : String(error) }),
      );
    } catch (error) {
      finish({ retry: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * W5 admission-reason → mailbox mapping (plan §4.6): spawned ⇒ the trigger was reserved by the resume (ownership left
   * this mailbox); temporary refusal ⇒ park; permanent ⇒ `wake_refused` dead letter with the cause; persist failure ⇒
   * retryable (attempts + backoff, ends in `attempts_exhausted`); stack closed ⇒ keep pending. Never an unbounded queue:
   * a park that cannot be recorded (cap / stack-memory) falls back to the bounded retry or the dead letter.
   */
  private reviveVerdict(key: string, target: NodeRef, token: string, outcome: ReviveVerdict): void {
    if (this.frozen) return;
    const record = this.options.engine.get(key);
    const owned = record?.state === "claimed" && record.claimToken === token;
    const release = (): void => {
      if (this.inFlight.get(target) === key) this.inFlight.delete(target);
    };
    if ("ok" in outcome && owned) {
      // Defensive: a run was admitted but the claim never moved to its reservation — the message is not inside that
      // run, so it must stay deliverable rather than be reported as sent.
      return this.verdict(key, target, token, { ok: false, retryable: true, reason: "revive_unbound", effect: "none" });
    }
    if (!owned) {
      // ok: reservation took ownership; otherwise someone else already terminated/moved the record.
      release();
      this.pump(target);
      return;
    }
    const attempts = record.attempts + 1;
    if ("hold" in outcome) {
      // The stack is closing: keep the record pending, charge nothing, and do not re-pump (no spin).
      this.options.engine.transition(key, "claimed", "pending", {});
      release();
      return;
    }
    if ("retry" in outcome)
      return this.verdict(key, target, token, { ok: false, retryable: true, reason: outcome.retry, effect: "none" });
    if ("refuse" in outcome) {
      this.options.router.issueDeadLetter({ ...record, attempts }, "wake_refused", outcome.refuse);
      release();
      this.pump(target);
      return;
    }
    if ("park" in outcome) {
      const parked = this.options.router.tryPark(record, outcome.park);
      if (parked === "parked") {
        this.options.router.noteParked(record, outcome.park);
        release();
        this.pump(target);
        return;
      }
      // Could not park (cap / stack-memory / persist failure). A hop or rate limit will not heal by retrying ⇒ refuse;
      // the temporary causes retry within the normal attempts bound.
      if (parked === "unavailable" && (outcome.park === "level_limit" || outcome.park === "rate_limited")) {
        this.options.router.issueDeadLetter({ ...record, attempts }, "wake_refused", outcome.park);
        release();
        this.pump(target);
        return;
      }
      return this.verdict(key, target, token, {
        ok: false,
        retryable: true,
        reason: `park_${parked}:${outcome.park}`,
        effect: "none",
      });
    }
  }

  private boundedSend(record: FabricRecord, redirect?: RunId): Promise<Verdict> {
    return new Promise((resolve) => {
      let done = false;
      let sender: Promise<Verdict>;
      try {
        sender =
          record.to === "root"
            ? effectiveChannel(
                record.kind,
                this.options.progressChannel ?? "display",
                this.options.canRenderEntries ?? true,
                record.to,
              ) === "context"
              ? this.options.ports.sendRootContext(record)
              : this.options.ports.sendRootDisplay(record)
            : redirect !== undefined
              ? this.options.ports.inject(record, { target: redirect })
              : this.options.ports.inject(record);
      } catch (error) {
        sender = Promise.reject(error);
      }
      let timer: TimerHandle | undefined;
      const finish = (verdict: Verdict): void => {
        if (done) return;
        done = true;
        if (timer) {
          this.options.clock.clearTimer(timer);
          this.raceTimers.delete(timer);
        }
        resolve(verdict);
      };
      timer = this.options.clock.setTimer(Math.max(0, this.options.fabricSteerTimeoutMs), () =>
        finish({ ok: false, retryable: true, reason: "steer_timeout", effect: "unknown" }),
      );
      this.raceTimers.add(timer);
      Promise.resolve(sender).then(finish, (error) => finish(this.toVerdict(error)));
    });
  }

  private verdict(key: string, target: NodeRef, token: string, verdict: Verdict, redirect?: RunId): void {
    if (this.frozen) return;
    const record = this.options.engine.get(key);
    const owned = record?.state === "claimed" && record.claimToken === token;
    if (!owned) {
      // A synchronous resume admission may already have normalized the claim to pending+reserved.
      // Never clear a different record's in-flight slot (nor spin on the reserved one).
      if (this.inFlight.get(target) === key) {
        this.inFlight.delete(target);
        this.pump(target);
      }
      return;
    }
    const attempts = record.attempts + 1;
    if (redirect !== undefined && !verdict.ok) {
      if ((verdict.effect ?? "unknown") === "unknown") {
        // The steer may still land (or already did): consume with an audit and never retry (NQ2, at most once).
        const patch = { attempts, terminalReason: "steer_unverified" };
        const strict = this.options.engine.transitionStrict(
          key,
          { state: "claimed", claimToken: token },
          "consumed",
          patch,
        );
        // A failed persist leaves disk as `pending + steerAttempt`, which a reload consumes with the same audit.
        if (strict.ok || this.options.engine.transition(key, "claimed", "consumed", patch))
          this.options.inbox?.auditUnverified("steer_unverified", record, redirect);
        if (this.inFlight.get(target) === key) this.inFlight.delete(target);
        this.pump(target);
        return;
      }
      // Rejected before anything landed ⇒ the durable attempt mark is withdrawn and the record returns to ordinary
      // handling (bounded by attempts). If the withdrawal cannot be persisted a reload would consume it unverified —
      // the safe, at-most-once direction.
      this.options.engine.annotateStrict(key, { state: "claimed", claimToken: token }, {
        steerAttempt: undefined,
      } as unknown as Partial<FabricRecord>);
      verdict = { ok: false, retryable: true, reason: verdict.reason };
    }
    if (verdict.ok) {
      const delivered = this.options.engine.transition(key, "claimed", "delivered", {
        attempts,
        deliveredAt: this.options.clock.now(),
      });
      if (delivered) {
        this.options.throttle.noteDelivered(delivered, delivered.deliveredAt ?? this.options.clock.now());
        try {
          this.options.level?.onDelivered(
            // a redirect propagates the level into the successor session that actually received the text
            redirect !== undefined ? { ...delivered, to: redirect } : delivered,
            effectiveChannel(
              delivered.kind,
              this.options.progressChannel ?? "display",
              this.options.canRenderEntries ?? true,
              delivered.to,
            ),
          );
        } catch {
          /* causal propagation is advisory: a failure here must never disturb delivery bookkeeping */
        }
        // W6 (plan §3.4d): a `wake:true` sender whose message was coalesced into a revived/resumed run wants that run's
        // result too — subscribe it (insert-then-sync-check inside WakeService, so a successor that already ended is
        // delivered immediately). Over the cap ⇒ the still-running sender is told via a receipt.
        if (redirect !== undefined && delivered.wake === true) {
          try {
            if (this.options.inbox?.subscribe(redirect, delivered.from) === "cap")
              this.options.router.noteSubscriptionUnavailable(delivered, "subscriber_cap");
          } catch {
            /* result delivery is advisory: never disturb delivery bookkeeping */
          }
        }
      }
    } else if (
      verdict.retryable &&
      attempts < this.options.maxAttempts &&
      record.kind === "progress" &&
      this.settled.has(record.from)
    ) {
      this.options.engine.transition(key, "claimed", "consumed", { attempts, terminalReason: "sender_settled" });
    } else if (verdict.retryable && attempts < this.options.maxAttempts) {
      this.options.engine.transition(key, "claimed", "pending", { attempts });
    } else if (verdict.retryable) {
      if (record.kind === "finding" || record.kind === "directive")
        this.options.router.issueDeadLetter({ ...record, attempts }, "attempts_exhausted");
      else
        this.options.engine.transition(key, "claimed", "dropped", { attempts, terminalReason: "attempts_exhausted" });
    } else if (verdict.reason === "target_gone") {
      if (record.kind === "finding" || record.kind === "directive")
        this.options.router.issueDeadLetter({ ...record, attempts }, "target_gone");
      else this.options.engine.transition(key, "claimed", "dropped", { attempts, terminalReason: "target_gone" });
    } else {
      console.warn(`[pi-subagent] fabric policy rejection for ${key}: ${verdict.reason}`);
      this.options.engine.transition(key, "claimed", "dropped", { attempts, terminalReason: "policy" });
    }
    if (this.inFlight.get(target) === key) this.inFlight.delete(target);
    this.pump(target);
  }

  private rescheduleWake(): void {
    if (this.frozen) return;
    if (this.wake) this.options.clock.clearTimer(this.wake);
    this.wake = undefined;
    const now = this.options.clock.now();
    let due = this.options.inbox?.nextSweepAt(now) ?? Number.POSITIVE_INFINITY;
    for (const key of this.waitingFor.keys())
      if (this.options.engine.get(key)?.state !== "pending") this.waitingFor.delete(key);
    for (const [key, at] of this.parkRetryAt) {
      if (this.options.engine.get(key)?.state === "pending") due = Math.min(due, Math.max(at, now));
      else this.parkRetryAt.delete(key);
    }
    for (const record of this.options.engine.select((r) => r.state === "pending")) {
      if (this.options.inbox && (record.reserved || record.quarantined || this.options.inbox.steerHeld(record.key)))
        continue;
      // W4: a record waiting for a starting successor only has its TTL as a clock wake source (the successor's running
      // snapshot drains it); a parked record has the same unless its successor already runs (then it redirects, and a
      // throttled redirect needs its eligibility timer like any other delivery).
      const route = this.successorRoute(record);
      if (route ? !route.running : this.options.inbox && record.parked) {
        if (!ttlExpired(record.createdAt, record.ttlMs, now)) due = Math.min(due, record.createdAt + record.ttlMs);
        continue;
      }
      const targetState = this.options.router.targetState(record.to);
      // A target with an in-flight send cannot make progress from a timer;
      // its verdict is the wake source for the next record on that target.
      if (this.inFlight.has(record.to)) continue;
      const ttlAt = record.createdAt + record.ttlMs;
      if (targetState === "pending_start") {
        // A pending_start target has no clock-based delivery opportunity. Its
        // only non-TTL wake source is the running snapshot hint.
        if (!ttlExpired(record.createdAt, record.ttlMs, now)) due = Math.min(due, ttlAt);
        continue;
      }
      if (!ttlExpired(record.createdAt, record.ttlMs, now)) due = Math.min(due, ttlAt);
      const eligibleAt = this.options.throttle.eligibleAt(record);
      if (eligibleAt > now) due = Math.min(due, eligibleAt);
    }
    if (Number.isFinite(due))
      this.wake = this.options.clock.setTimer(Math.max(0, due - now), () => {
        this.wake = undefined;
        this.pump();
      });
  }

  private toVerdict(error: unknown): Verdict {
    const message = error instanceof Error ? error.message : String(error);
    // A rejected promise means the steer itself was refused: nothing landed (effect "none").
    if (/no active session/i.test(message))
      return { ok: false, retryable: false, reason: "target_gone", effect: "none" };
    if (/policy/i.test(message)) return { ok: false, retryable: false, reason: "policy", effect: "none" };
    return { ok: false, retryable: true, reason: message, effect: "none" };
  }
}
export const createFabricMailbox = (options: MailboxOptions): FabricMailbox => new FabricMailbox(options);
