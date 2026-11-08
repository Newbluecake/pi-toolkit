// #36 C1: session-local, unwired event coalescer. It never schedules work,
// sends messages, starts a turn, or invokes a sweep. The host owns lifecycle
// wiring and decides whether a tool result actually represents an event.

export type GovernanceSignal = "task-done" | "push" | "release";

export interface SignalAdmission {
  readonly success: boolean;
  readonly readOnly: boolean;
}

export interface TurnEndContext {
  /** The current turn's abort signal, when available. */
  readonly signal?: AbortSignal;
}

export function canMark(admission: SignalAdmission): boolean {
  return admission.success === true && admission.readOnly === false;
}

/** Create exactly one instance per session; never share one across sessions. */
export function createGovernanceSignals() {
  const pending = new Set<GovernanceSignal>();
  let closed = false;

  return {
    /** The caller supplies the success/read-only verdict, not raw tool input. */
    markSignal(kind: GovernanceSignal, admission: SignalAdmission): void {
      if (!closed && canMark(admission)) pending.add(kind);
    },

    /** One snapshot for one turn_end; clear synchronously before returning it. */
    consumeSignals(context: TurnEndContext): readonly GovernanceSignal[] | undefined {
      if (closed || context.signal?.aborted) {
        pending.clear();
        return undefined;
      }
      if (pending.size === 0) return undefined;
      const signals = [...pending];
      pending.clear();
      return signals;
    },

    /** Host calls on turn abort; a later turn may mark new events. */
    abort(): void {
      pending.clear();
    },

    /** Host calls on session end or reload; the old instance stays inert. */
    dispose(): void {
      pending.clear();
      closed = true;
    },
  };
}
