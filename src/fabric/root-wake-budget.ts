/** Pure, activation-local policy only. The host owns provenance, delivery and persistence. */
export type RootBudgetState = "running" | "starting" | "idle" | "closed" | "unknown";

export interface RootWakeBudgetSnapshot {
  sessionId: string;
  window: number;
  used: number;
  dedupCount: number;
}

export interface RootWakeReservation {
  window: number;
  used: number;
}

export type RootWakeBudgetReason =
  | "owner_mismatch"
  | "disposed"
  | "busy"
  | "closed"
  | "unknown"
  | "no_window"
  | "restored_window"
  | "duplicate"
  | "reserved"
  | "limit"
  | "invalid_key"
  | "admitted";

export interface RootWakeBudgetDecision {
  action: "queue" | "requestWake" | "deliverOnly";
  reason: RootWakeBudgetReason;
  state: RootWakeBudgetSnapshot;
  reservation?: RootWakeReservation;
}

const nonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Only call admit for an explicit, already-permitted child report wake request.
 * Neither this module nor an event's role/text proves human origin. Only the trusted
 * TUI/Web arrival callback may call observeAcceptedUserArrival, BEFORE model consumption.
 * Keep one owner object per activation; dispose the previous closure before replacement.
 */
export function createRootWakeBudget(options: {
  owner: object;
  sessionId: string;
  limit?: number;
  snapshot?: unknown;
}) {
  const { owner, sessionId } = options;
  const limit = options.limit === undefined ? 2 : options.limit;
  if (!nonnegativeInteger(limit)) throw new RangeError("limit must be a finite nonnegative safe integer");
  if (sessionId.length === 0) throw new TypeError("sessionId must not be empty");

  let window = 0;
  let used = 0;
  let restoredCount = 0;
  let open = false;
  let restored = false;
  let disposed = false;
  let pending: RootWakeReservation | undefined;
  const arrivals = new WeakSet<object>();
  const attemptedKeys = new Set<string>();
  const raw = options.snapshot;
  if (raw !== null && typeof raw === "object") {
    const snapshot = raw as Partial<RootWakeBudgetSnapshot>;
    if (
      snapshot.sessionId === sessionId &&
      nonnegativeInteger(snapshot.window) &&
      snapshot.window > 0 &&
      nonnegativeInteger(snapshot.used) &&
      snapshot.used <= limit &&
      nonnegativeInteger(snapshot.dedupCount) &&
      snapshot.dedupCount === snapshot.used
    ) {
      window = snapshot.window;
      used = snapshot.used;
      restoredCount = snapshot.dedupCount;
      restored = true;
      // Counts cannot reconstruct exact-key dedup. Never gift a retry on reload.
    }
  }

  const snapshot = (): RootWakeBudgetSnapshot => ({
    sessionId,
    window,
    used,
    dedupCount: restoredCount + attemptedKeys.size,
  });
  const allowed = (candidate: object) => !disposed && candidate === owner;
  const result = (
    action: RootWakeBudgetDecision["action"],
    reason: RootWakeBudgetReason,
    reservation?: RootWakeReservation,
  ): RootWakeBudgetDecision => ({
    action,
    reason,
    state: snapshot(),
    ...(reservation === undefined ? {} : { reservation: { ...reservation } }),
  });

  return {
    snapshot,
    /** Object identity dedup, weakly held: no lifetime window cap or historical text. */
    observeAcceptedUserArrival(candidate: object, event: object): boolean {
      if (!allowed(candidate) || event === null || typeof event !== "object" || arrivals.has(event)) return false;
      arrivals.add(event);
      // Exhaustion must fail closed rather than wrap an epoch and reopen an old window.
      if (window === Number.MAX_SAFE_INTEGER) return false;
      window++;
      used = 0;
      restoredCount = 0;
      restored = false;
      open = true;
      attemptedKeys.clear();
      // A user arrival resets quota, not an outstanding host start reservation.
      return true;
    },
    admit(input: { owner: object; messageKey: string; rootState: RootBudgetState }): RootWakeBudgetDecision {
      if (disposed) return result("deliverOnly", "disposed");
      if (input.owner !== owner) return result("deliverOnly", "owner_mismatch");
      if (input.rootState === "closed") return result("deliverOnly", "closed");
      if (input.rootState === "unknown") return result("deliverOnly", "unknown");
      // Busy delivery must not depend on a wake budget/window, including limit=0.
      if (input.rootState === "running" || input.rootState === "starting") return result("queue", "busy");
      if (input.rootState !== "idle") return result("deliverOnly", "unknown");
      if (pending !== undefined) return result("queue", "reserved");
      if (restored) return result("deliverOnly", "restored_window");
      if (!open) return result("deliverOnly", "no_window");
      // Bound key storage as well as key count; keys are identifiers, never message bodies.
      if (typeof input.messageKey !== "string" || input.messageKey.length === 0 || input.messageKey.length > 512)
        return result("deliverOnly", "invalid_key");
      if (attemptedKeys.has(input.messageKey)) return result("deliverOnly", "duplicate");
      if (used >= limit) return result("deliverOnly", "limit");
      attemptedKeys.add(input.messageKey);
      used++;
      pending = { window, used };
      // Synchronous reserve precedes every possible host send/re-entry.
      return result("requestWake", "admitted", pending);
    },
    /**
     * Host calls on agent_start, known send failure, settled, or matched host delivery confirmation. Unknown send outcomes
     * retain the reservation until a matching host confirmation. No outcome refunds
     * used or removes a key; the host must never blindly resend a message body.
     */
    clearReservation(
      candidate: object,
      reservation: RootWakeReservation,
      event: "agent_start" | "send_failed" | "settled" | "delivered",
    ): boolean {
      if (
        !allowed(candidate) ||
        !["agent_start", "send_failed", "settled", "delivered"].includes(event) ||
        pending === undefined ||
        pending.window !== reservation.window ||
        pending.used !== reservation.used
      )
        return false;
      pending = undefined;
      return true;
    },
    dispose(candidate: object): boolean {
      if (!allowed(candidate)) return false;
      disposed = true;
      open = false;
      pending = undefined;
      attemptedKeys.clear();
      restoredCount = used;
      return true;
    },
  };
}
