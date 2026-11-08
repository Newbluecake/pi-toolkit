import { createHash } from "node:crypto";
import type { BudgetRenderStats } from "../blocks/render.js";
import type { JevGovernanceBudgetSignal } from "../jev/contracts.js";

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

/** Identity must be captured and gated by the host for this epoch, not guessed here. */
export interface BudgetDirectoryIdentity {
  readonly realpath: string;
  readonly dev: number;
  readonly ino: number;
  readonly migration?: { readonly gen: number; readonly runId: string };
}
export interface BudgetObservation {
  readonly identity: BudgetDirectoryIdentity;
  readonly stats: BudgetRenderStats;
}
export interface BudgetCandidate {
  readonly kind: JevGovernanceBudgetSignal;
  readonly key: string;
  readonly observation: BudgetObservation;
}
interface BudgetState extends BudgetCandidate {
  pending: boolean;
  attempted: boolean;
}
function directoryKey(identity: BudgetDirectoryIdentity): string {
  return JSON.stringify([identity.realpath, identity.dev, identity.ino]);
}
export function budgetObservationKey(observation: BudgetObservation, kind: JevGovernanceBudgetSignal): string {
  const { identity, stats } = observation;
  const extra =
    kind === "resident-over-budget"
      ? [stats.resident.inputFingerprint, stats.resident.usedBytes, stats.resident.budgetBytes]
      : [stats.index.inputFingerprint, stats.index.limitBytes, stats.index.omittedCount];
  return createHash("sha256")
    .update(
      JSON.stringify([
        identity.realpath,
        identity.dev,
        identity.ino,
        identity.migration?.gen ?? null,
        identity.migration?.runId ?? null,
        kind,
        stats.corpusFingerprint,
        stats.localToday,
        stats.policyVersion,
        ...extra,
      ]),
    )
    .digest("hex");
}

/** Create exactly one instance per session; never share one across sessions. */
export function createGovernanceSignals() {
  const pending = new Set<GovernanceSignal>();
  const budgets = new Map<string, Map<JevGovernanceBudgetSignal, BudgetState>>();
  let closed = false;

  return {
    /** Undefined means unknown: leave prior states untouched. Admission/gate is the host's responsibility. */
    observeBudget(observation: BudgetObservation | undefined, origin: "external" | "sweep" = "external"): void {
      if (closed || observation === undefined) return;
      const dir = directoryKey(observation.identity);
      let entries = budgets.get(dir);
      if (entries === undefined) {
        entries = new Map();
        budgets.set(dir, entries);
      }
      for (const kind of ["resident-over-budget", "index-overflow"] as const) {
        const over = kind === "resident-over-budget" ? observation.stats.resident.over : observation.stats.index.over;
        if (!over) {
          entries.delete(kind);
          continue;
        }
        const key = budgetObservationKey(observation, kind);
        const previous = entries.get(kind);
        if (previous?.key === key) continue;
        entries.set(kind, { kind, key, observation, pending: origin !== "sweep", attempted: false });
      }
      if (entries.size === 0) budgets.delete(dir);
    },

    /** Atomic detach. External opportunities may re-admit dormant failed/sweep-origin keys;
     * a plain turn_end/render must pass external=false. Host merges with event signals. */
    consumeBudgets(
      identity: BudgetDirectoryIdentity,
      options: { external: boolean; signal?: AbortSignal },
    ): readonly BudgetCandidate[] {
      if (closed || options.signal?.aborted) return [];
      const entries = budgets.get(directoryKey(identity));
      if (entries === undefined) return [];
      const result: BudgetCandidate[] = [];
      for (const state of entries.values()) {
        if (!state.pending && !options.external) continue;
        state.pending = false;
        state.attempted = true;
        result.push({ kind: state.kind, key: state.key, observation: state.observation });
      }
      return result;
    },

    /** The caller supplies the success/read-only verdict, not raw tool input. */
    markSignal(kind: GovernanceSignal, admission: SignalAdmission): void {
      if (!closed && canMark(admission)) pending.add(kind);
    },

    /** One snapshot for one turn_end; clear synchronously before returning it. */
    consumeSignals(context: TurnEndContext): readonly GovernanceSignal[] | undefined {
      if (closed || context.signal?.aborted) {
        pending.clear();
        if (context.signal?.aborted) budgets.clear();
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
      budgets.clear();
    },

    /** Host calls on session end or reload; the old instance stays inert. */
    dispose(): void {
      pending.clear();
      budgets.clear();
      closed = true;
    },
  };
}
